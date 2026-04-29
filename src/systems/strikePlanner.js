// ============================================================================
// Strike Planner ("B" key) — top-down map for picking GPS-bomb targets.
//
// Roadmap §5g.1 — the smallest useful slice of the strike-planner UI:
// open a top-down map, click a point, that lat/lon becomes the
// designation for any GPS-guided weapon (JDAM family today).
//
// Architecture mirrors CommanderView (it also hijacks the main Cesium
// camera and draws unit markers) but the surface is conceptually
// different per the roadmap:
//   - CommanderView is the god-eye debug / replay overlay (every unit
//     in the world, regardless of player knowledge).
//   - Strike planner is a strike-only interface (target selection,
//     queue management, planner-grade UX). For 5g.1 it shares the
//     god-eye unit list — proper player-knowledge filtering arrives
//     in 5g.4.
//
// Mutual exclusion with commander view: only one alternate camera at
// a time. Pressing B while commander view is active closes commander
// first (and vice versa). Both alternate camera modes route through
// the existing `simLoop` skip-cockpit-camera gates.
//
// Currently implemented (5g.1):
//   - Top-down camera (forced tilt = 0, rotation = 0).
//   - Pan with mouse drag, zoom with wheel.
//   - Markers for player + NPCs + in-flight missiles (god-eye for now).
//   - Click on map → designation set via setDesignationFromMap.
//   - Single designated-target marker rendered at the current point.
//
// Deliberately NOT in 5g.1 (later slices):
//   - 5g.2: queue UI, multi-target select, drag-to-reorder.
//   - 5g.3: rectangle / lasso select, auto-prioritize, best-fit weapon.
//   - 5g.4: player-knowledge filtering (own sensors + datalink only),
//           stale contacts, dead-reckoned positions.
//   - In-flight HUD strip with next-3-queued targets.
// ============================================================================

import * as Cesium from 'cesium';
import {
	addDesignation,
	refineDesignationAlt,
	removeDesignationAt,
	designationQueue,
	clearDesignationQueue,
	toggleCycleMode,
	getCycleMode,
	moveDesignation,
} from './designation.js';
import { getTeamDatalink } from './teamDatalink.js';
import { MUNITIONS } from '../weapon/munitions.js';
import { munitionIdForSimType } from '../weapon/munitionFactory.js';
import { isStrikeWeapon } from './strikeEnvelope.js';
import { totalWingmanAmmo, formation, MODE_FORMATION, MODE_PATROL_RTB, MODE_PATROL_CAP, setMemberMode } from './formation.js';

const COLOR_PLAYER       = Cesium.Color.fromCssColorString('#00eaff');
const COLOR_FACTIONS = {
	'hostile-red':  Cesium.Color.fromCssColorString('#ff4040'),
	'hostile-blue': Cesium.Color.fromCssColorString('#ffa040'),
	'friendly':     Cesium.Color.fromCssColorString('#40d8ff'),
};
const COLOR_NPC_FALLBACK = Cesium.Color.fromCssColorString('#ff4040');
const COLOR_MSL_FRIENDLY = Cesium.Color.fromCssColorString('#ffc040');
const COLOR_MSL_HOSTILE  = Cesium.Color.fromCssColorString('#ff40e0');
const COLOR_TARGET       = Cesium.Color.fromCssColorString('#ff4040');

// How long to keep a contact in the planner's memory after detection
// drops. Real strike planning uses indefinite persistence; we cap at
// 10 minutes so destroyed-elsewhere ghosts eventually clear.
const STALE_MEMORY_S = 600;

function _formatAge(seconds) {
	const s = Math.max(0, Math.floor(seconds));
	const m = Math.floor(s / 60);
	const r = s % 60;
	return `${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`;
}

function _colorForUnit(u) {
	return COLOR_FACTIONS[u.team] || COLOR_NPC_FALLBACK;
}

export class StrikePlannerView {
	constructor(viewer) {
		this.viewer = viewer;
		this.active = false;

		// Camera state (mirrors commander view's pattern). The planner
		// is a constrained top-down map, so we drive the camera entirely
		// from these three values via _applyCamera each frame:
		//   centerLon/centerLat: look-at point on the ground.
		//   distance: orbital distance from look-at to camera.
		this.centerLon = 0;
		this.centerLat = 0;
		this.distance  = 25000;

		// Marker entities for units (player, NPCs, missiles), keyed by
		// stable id. Same shape as commanderView's _markers — separate
		// map so the two views don't trample each other's entity refs.
		this._markers = new Map();

		// One entity per queued designation. The head (queue index 0)
		// gets a brighter marker + a numeric "1" label so it's
		// obviously the next-up shot; following points are dimmer with
		// 2, 3, … labels showing fire order.
		this._targetMarkers = []; // index-aligned with designationQueue

		// Uncertainty discs for briefed-suspected intel contacts.
		// Cesium ellipse entities, one per unit currently rendered
		// with a non-zero uncertaintyM. Sized to the radius from the
		// intel record, dashed outline so they read as "we think it's
		// somewhere in this circle."
		this._uncertaintyDiscs = new Map(); // id → entity

		// Used by the planner-toggle key to center on the player at
		// open time. Set every frame's update().
		this._lastPlayerState = null;

		// Pan + click + drag-target detection. Mode is decided on
		// pointerdown based on what's under the cursor:
		//   'pan'    — empty terrain or world: drag pans the camera.
		//   'target' — clicked an existing target dot: drag moves it.
		//   'unit'   — clicked an enemy unit marker: tentative add at
		//              the unit's position; commits on pointerup if
		//              no significant move.
		// Click vs drag is decided by total travel: tiny travel on
		// release of 'pan' or 'unit' = click → designate.
		this._clickBudgetPx = 6;
		this._dragMode      = null; // 'pan' | 'target' | 'unit' | 'lasso' | null
		this._dragTargetIdx = -1;   // index when _dragMode === 'target'
		this._dragUnitRef   = null; // unit when _dragMode === 'unit'
		// 5g.3 — rectangle multi-select. Shift+left-drag on empty
		// terrain draws a screen-space rectangle and, on release,
		// queues every visible hostile inside it as a designation.
		this._lassoEl       = null; // HTMLElement showing the rectangle while dragging
		this._lassoStartX   = 0;
		this._lassoStartY   = 0;
		this._lastX = 0;
		this._lastY = 0;
		this._downX = 0;
		this._downY = 0;
		this._dragDist = 0;

		// Stale-contact memory: target → { lon, lat, alt, lastSeen }.
		// Updated each frame from current contacts ∪ datalink. Entries
		// persist for STALE_MEMORY_S after detection drops, rendering
		// as desaturated/dashed markers per roadmap §5g.4.
		this._lastKnown = new Map();

		this._bindInputs();
	}

	setActive(active) {
		if (active === this.active) return;

		// Mutual exclusion with commander view at the camera level.
		// Set externally via the closeOther reference to avoid a
		// circular import; see main.js bootstrap. Falling through
		// without it just means the keybinds for both modes can be
		// pressed in either order, but the camera state will fight.
		if (active && typeof this.closeOther === 'function') {
			this.closeOther();
		}

		this.active = active;

		const ctrl = this.viewer.scene.screenSpaceCameraController;
		if (active) {
			// Center on the player so the first frame is useful.
			if (this._lastPlayerState) {
				this.centerLon = this._lastPlayerState.lon;
				this.centerLat = this._lastPlayerState.lat;
			}
			// We drive pan + zoom via window-capture pointer events
			// (same pattern as commander view). Disable Cesium's
			// native controller so it doesn't fight our setView calls.
			ctrl.enableInputs = false;
		} else {
			ctrl.enableInputs = true;
		}

		this._setAllMarkersVisible(active);
		for (const m of this._targetMarkers) m.show = active;
		this._showToolbar(active);
		this.viewer.scene.requestRender();
	}

	_ensureToolbar() {
		if (this._toolbar) return this._toolbar;
		const bar = document.createElement('div');
		bar.id = 'strike-planner-toolbar';
		bar.style.cssText = `
			position: absolute;
			top: 16px; left: 16px;
			display: none;
			padding: 8px 12px;
			background: rgba(0, 30, 0, 0.7);
			border: 1px solid rgba(0, 255, 0, 0.5);
			color: #0f0;
			font-family: 'AceCombat', monospace;
			font-size: 12px;
			letter-spacing: 1px;
			text-shadow: 0 0 6px rgba(0, 255, 0, 0.7);
			z-index: 50;
			pointer-events: auto;
			user-select: none;
		`;
		const status = document.createElement('div');
		status.id = 'strike-planner-status';
		status.style.cssText = 'margin-bottom: 6px; opacity: 0.9;';
		bar.appendChild(status);

		const row = document.createElement('div');
		row.style.cssText = 'display: flex; gap: 6px;';

		const mkBtn = (label, key, onClick) => {
			const b = document.createElement('button');
			b.textContent = `${label}  [${key}]`;
			b.style.cssText = `
				padding: 4px 10px;
				background: rgba(0, 40, 0, 0.7);
				border: 1px solid rgba(0, 255, 0, 0.6);
				color: #0f0;
				font: inherit;
				cursor: pointer;
			`;
			b.addEventListener('click', (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				onClick();
			});
			b.addEventListener('pointerdown', (ev) => ev.stopPropagation());
			b.addEventListener('pointerup',   (ev) => ev.stopPropagation());
			return b;
		};

		row.appendChild(mkBtn('AUTO ASSIGN', 'A', () => this.autoAssign()));
		row.appendChild(mkBtn('CLEAR',       'C', () => clearDesignationQueue()));
		const cycleBtn = mkBtn('CYCLE: OFF', 'L', () => {
			toggleCycleMode();
			this._refreshToolbar(this._lastPlayerState);
		});
		row.appendChild(cycleBtn);
		this._cycleBtn = cycleBtn;
		// Phase 5.5 — RTB / CAP toggle for the formation. Updates
		// formation.breakBehavior live and immediately re-modes any
		// wingmen currently in patrol — so a mid-mission decision to
		// recall the flight (RTB → escort base) or hold them on
		// station (CAP → keep watching the player) takes effect
		// without going back to the spawn menu.
		const rtbBtn = mkBtn('FLIGHT: RTB', 'R', () => {
			formation.breakBehavior = 'rtb';
			for (const m of formation.members) {
				if (!m || m.destroyed) continue;
				if (m._wingmanMode === MODE_PATROL_CAP) setMemberMode(m, MODE_PATROL_RTB);
			}
			this._refreshToolbar(this._lastPlayerState);
		});
		row.appendChild(rtbBtn);
		this._rtbBtn = rtbBtn;
		bar.appendChild(row);

		// Transient status — used by autoAssign to surface why it
		// did or didn't queue anything. Cleared on the next frame
		// after a few seconds of display.
		const flash = document.createElement('div');
		flash.style.cssText = 'margin-top:6px; font-size:11px; min-height:14px; opacity:0.85;';
		bar.appendChild(flash);
		this._toolbarFlash = flash;
		this._flashUntil = 0;

		const hint = document.createElement('div');
		hint.style.cssText = 'margin-top:6px; font-size:10px; opacity:0.55;';
		hint.innerHTML = 'L-click empty: add · L-drag dot: move · L-drag dot onto another: reorder · Shift+drag: area select · R-click dot: delete · [L] cycle · [R] flight';
		bar.appendChild(hint);

		document.body.appendChild(bar);
		this._toolbar = bar;
		this._toolbarStatus = status;
		return bar;
	}

	_showToolbar(visible) {
		this._ensureToolbar();
		if (this._toolbar) this._toolbar.style.display = visible ? 'block' : 'none';
	}

	_refreshToolbar(playerState) {
		if (!this._toolbarStatus) return;
		const ws = playerState && playerState.weaponSystem;
		const cur = ws && ws.getCurrentWeapon && ws.getCurrentWeapon();
		const ammo = cur && typeof cur.ammo === 'number' && cur.ammo !== Infinity
			? cur.ammo : '—';
		const name = cur ? (cur.name || cur.type || cur.id) : 'NO WEAPON';
		const cycle = getCycleMode() ? '  · CYCLE' : '';
		// Aggregate ammo across the formation for strike weapons (the
		// planner's whole reason to exist). Wingmen ammo isn't visible
		// otherwise, and seeing "TARGETS: 4 / 12  STORM" tells the
		// player at a glance that they have plenty of munitions across
		// the flight even when their own rack is empty.
		let ammoDisp = ammo === '—' ? '' : ' / ' + ammo;
		if (cur && (cur.id === 'agm' || cur.id === 'gbu') && typeof cur.ammo === 'number' && cur.ammo !== Infinity) {
			const extra = totalWingmanAmmo(cur.type) || 0;
			if (extra > 0) ammoDisp = ` / ${cur.ammo + extra}  (${cur.ammo} you, ${extra} flight)`;
		}
		this._toolbarStatus.textContent =
			`TARGETS: ${designationQueue.length}${ammoDisp}   ${name}${cycle}`;
		if (this._cycleBtn) {
			this._cycleBtn.textContent = `CYCLE: ${getCycleMode() ? 'ON ' : 'OFF'}  [L]`;
		}
		if (this._rtbBtn) {
			const brk = (formation.breakBehavior === 'cap') ? 'CAP' : 'RTB';
			this._rtbBtn.textContent = `FLIGHT: ${brk}  [R]`;
		}
		if (this._toolbarFlash) {
			const t = performance.now() * 0.001;
			if (t > this._flashUntil) this._toolbarFlash.textContent = '';
		}
	}

	_flash(msg, color = '#0f0', durationS = 4) {
		if (!this._toolbarFlash) return;
		this._toolbarFlash.textContent = msg;
		this._toolbarFlash.style.color = color;
		this._flashUntil = performance.now() * 0.001 + durationS;
	}

	// Auto-assign: queue one target per detected/stale enemy ground
	// contact, in range-from-player order, capped at the current
	// strike weapon's ammo. If the player's loaded weapon isn't a
	// GBU-class, no-op (auto-assign would pick targets nothing can
	// hit). Wipes the existing queue first so repeated A presses
	// don't keep stacking.
	autoAssign() {
		const ps = this._lastPlayerState;
		if (!ps) {
			this._flash('AUTO: no player state yet', '#ff8', 3);
			return;
		}
		const ws = ps.weaponSystem;
		const cur = ws && ws.getCurrentWeapon && ws.getCurrentWeapon();
		if (!cur || !cur.type) {
			this._flash('AUTO: no weapon selected', '#ff8', 3);
			return;
		}
		// Gate on the munition's seeker class, not the weapon-system
		// slot id. GBU-* and AGM-* live in different slots (id 'gbu'
		// vs 'agm') but the strike planner queue is the right
		// concept for any seeker that takes a frozen GPS coord at
		// release — JDAM, SDB, GBU-12, ALCM, Storm Shadow — and the
		// wrong concept for HARM (which needs a live emitter, not a
		// queue point). isStrikeWeapon centralizes that decision.
		const munId = munitionIdForSimType(cur.type);
		const munData = munId ? MUNITIONS[munId] : null;
		if (!isStrikeWeapon(munData)) {
			this._flash(`AUTO: ${cur.name || cur.type} is not a strike weapon — switch to JDAM/SDB/ALCM/STORM`, '#f88', 5);
			return;
		}
		const ammo = (typeof cur.ammo === 'number' && cur.ammo !== Infinity) ? cur.ammo : 99;
		if (ammo <= 0) {
			this._flash('AUTO: no ammo loaded', '#f88', 3);
			return;
		}

		const playerTeam = ps.team || 'friendly';
		const teamDl = getTeamDatalink(playerTeam);
		const ownContacts = ps.contacts || null;
		const dlContacts  = teamDl ? teamDl.contacts : null;
		const dlIntel     = teamDl ? teamDl.intelContacts : null;

		const candidates = [];
		// Diagnostic counters — surfaced both to the toolbar flash
		// and to the console, so when auto-assign comes up empty
		// the player (and we) can see why instead of staring at
		// nothing happening.
		let nUnits = 0;
		let nFriendly = 0;
		let nDestroyed = 0;
		let nNoKnowledge = 0;
		let nDetected = 0;
		let nStale = 0;
		let nIntel = 0;
		// Walk every unit we have ANY knowledge of (live sensor /
		// stale memory / briefed / ELINT) and pick out the position
		// the planner is currently showing for it. Sourcing the
		// position from the underlying knowledge record (not from
		// the Cesium entity's wrapped position property) avoids
		// Cesium-property quirks that previously caused
		// briefed-suspected markers to silently slip through the
		// auto-assign net.
		const units = (ps.npcs || []);
		for (const u of units) {
			nUnits++;
			if (!u || u.destroyed) { nDestroyed++; continue; }
			if (u.team === playerTeam) { nFriendly++; continue; }

			let lon, lat, alt;
			const detected = (ownContacts && ownContacts.has(u))
				|| (dlContacts && dlContacts.has(u));
			const stale = !detected && this._lastKnown.has(u);
			const intel = (!detected && !stale && dlIntel) ? dlIntel.get(u) : null;

			if (detected) {
				lon = u.lon; lat = u.lat; alt = u.alt || 0;
				nDetected++;
			} else if (stale) {
				const m = this._lastKnown.get(u);
				lon = m.lon; lat = m.lat; alt = m.alt;
				nStale++;
			} else if (intel) {
				lon = intel.lon; lat = intel.lat; alt = intel.alt || 0;
				nIntel++;
			} else {
				nNoKnowledge++;
				continue;   // no knowledge at all → skip
			}

			const cosLat = Math.cos(ps.lat * Math.PI / 180) || 1;
			const dE = (lon - ps.lon) * 111320 * cosLat;
			const dN = (lat - ps.lat) * 111320;
			const range = Math.sqrt(dE * dE + dN * dN);
			candidates.push({ lon, lat, alt, range });
		}
		candidates.sort((a, b) => a.range - b.range);

		console.log('[autoAssign]',
			`units=${nUnits} friendly=${nFriendly} destroyed=${nDestroyed}`,
			`detected=${nDetected} stale=${nStale} intel=${nIntel} noKnowledge=${nNoKnowledge}`,
			`candidates=${candidates.length} ammo=${ammo}`,
			`dlIntelSize=${dlIntel ? dlIntel.size : 'no-dl'}`);

		clearDesignationQueue();
		const take = Math.min(ammo, candidates.length);
		for (let i = 0; i < take; i++) {
			const c = candidates[i];
			addDesignation(c.lon, c.lat, c.alt);
		}

		// Refine altitudes against actual terrain. Two reasons the
		// unit's stored alt is not trustworthy for a GPS designation:
		//   - Briefed intel records freeze the unit's alt at publish
		//     time, which often runs BEFORE the static-SAM ground
		//     clamp lands (terrain tile not loaded yet). The intel
		//     record then permanently holds a near-zero altitude
		//     even after the unit clamps to its real terrain height.
		//   - Even live ground contacts may have transient mismatches
		//     between unit alt and the terrain mesh under the bomb's
		//     final approach (different LOD, etc).
		// One async terrain sample per queued target, then promote
		// the designation alt to max(unit_alt, terrain_alt). Same
		// pattern manual click-to-add uses (_addAtScreen). Without
		// this, GBU-/SDB-class bombs aimed at briefed SAMs in
		// mountainous terrain crash short of the target.
		if (take > 0) {
			const cartos = candidates.slice(0, take).map(c =>
				Cesium.Cartographic.fromDegrees(c.lon, c.lat));
			Cesium.sampleTerrainMostDetailed(this.viewer.terrainProvider, cartos)
				.then((sampled) => {
					for (let i = 0; i < take; i++) {
						const c = candidates[i];
						const tH = sampled[i] && sampled[i].height;
						if (tH != null && Number.isFinite(tH)) {
							const alt = Math.max(c.alt, tH);
							refineDesignationAlt(c.lon, c.lat, alt);
						}
					}
				})
				.catch(() => {});
		}

		if (take === 0) {
			this._flash(
				`AUTO: 0 candidates (det=${nDetected} stale=${nStale} intel=${nIntel}, ` +
				`dlIntel=${dlIntel ? dlIntel.size : 0})`, '#f88', 5);
		} else {
			this._flash(`AUTO: queued ${take} target${take === 1 ? '' : 's'} ` +
				`(det=${nDetected} stale=${nStale} intel=${nIntel})`, '#0f8', 3);
		}
	}

	// Per-frame update. Caller passes the same args commanderView gets.
	update(dt, playerState, units, missiles) {
		this._lastPlayerState = playerState;
		if (!this.active) return;

		this._applyCamera();
		this._syncMarkers(playerState, units, missiles);
		this._syncTargetMarkers();
		this._refreshToolbar(playerState);
		this.viewer.scene.requestRender();
	}

	// ---- Camera --------------------------------------------------------------

	_applyCamera() {
		// Pure top-down. North-up. Camera sits directly above the
		// look-at point at `distance` metres of altitude.
		this.viewer.camera.setView({
			destination: Cesium.Cartesian3.fromDegrees(this.centerLon, this.centerLat, this.distance),
			orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
		});
	}

	// ---- Markers -------------------------------------------------------------

	_ensureMarker(id, color, labelText) {
		let e = this._markers.get(id);
		if (e) return e;
		e = this.viewer.entities.add({
			position: Cesium.Cartesian3.fromDegrees(0, 0, 0),
			point: {
				pixelSize: 9,
				color: color,
				outlineColor: Cesium.Color.WHITE,
				outlineWidth: 1.2,
				disableDepthTestDistance: Number.POSITIVE_INFINITY,
			},
			label: {
				text: labelText,
				font: '12px sans-serif',
				fillColor: Cesium.Color.WHITE,
				outlineColor: Cesium.Color.BLACK,
				outlineWidth: 2,
				style: Cesium.LabelStyle.FILL_AND_OUTLINE,
				pixelOffset: new Cesium.Cartesian2(10, 0),
				verticalOrigin: Cesium.VerticalOrigin.CENTER,
				horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
				disableDepthTestDistance: Number.POSITIVE_INFINITY,
			},
			show: this.active,
		});
		this._markers.set(id, e);
		return e;
	}

	_syncMarkers(playerState, units, missiles) {
		const seen = new Set();

		const seenDiscs = new Set();
		const updateOne = (id, u, color, opts = {}) => {
			const e = this._markers.get(id);
			if (!e) return;
			e.position = Cesium.Cartesian3.fromDegrees(u.lon, u.lat, u.alt || 0);
			e.point.color = color;
			e.show = true;
			e.__strikeUnit  = opts.unitForClick || null;
			e.__strikeStale = !!opts.stale;
			seen.add(id);

			// Uncertainty disc — created on demand when a marker is
			// rendered with non-zero uncertaintyM. The disc auto-
			// disappears when the unit upgrades to live/stale (because
			// updateOne for that frame passes uncertaintyM=0, so the
			// disc id won't be in seenDiscs and the cleanup loop
			// removes it). This is the auto-promotion path: as soon
			// as a sensor confirms the suspected position, the fuzzy
			// circle vanishes and the bright marker takes over.
			if (opts.uncertaintyM && opts.uncertaintyM > 0) {
				let disc = this._uncertaintyDiscs.get(id);
				if (!disc) {
					disc = this.viewer.entities.add({
						position: Cesium.Cartesian3.fromDegrees(u.lon, u.lat, 100),
						ellipse: {
							semiMajorAxis: opts.uncertaintyM,
							semiMinorAxis: opts.uncertaintyM,
							material: color.withAlpha(0.08),
							outline: true,
							outlineColor: color.withAlpha(0.6),
							height: 100,
						},
					});
					this._uncertaintyDiscs.set(id, disc);
				}
				disc.position = Cesium.Cartesian3.fromDegrees(u.lon, u.lat, 100);
				disc.ellipse.semiMajorAxis = opts.uncertaintyM;
				disc.ellipse.semiMinorAxis = opts.uncertaintyM;
				disc.ellipse.material      = color.withAlpha(0.08);
				disc.ellipse.outlineColor  = color.withAlpha(0.6);
				disc.show = true;
				seenDiscs.add(id);
			}
		};

		if (playerState) {
			this._ensureMarker('__player', COLOR_PLAYER, 'PLAYER');
			updateOne('__player', playerState, COLOR_PLAYER);
		}

		// Player-knowledge filter: only show units the player's team
		// knows about. Sources are the union of:
		//   1. Own sensor contacts (state.contacts) — anything radar/IR/
		//      visual has painted in the last few seconds.
		//   2. Friendly team datalink — wingman / AWACS / future ISR
		//      tracks fused into the shared picture.
		//   3. Friendlies — always shown (they're on our side and the
		//      planner needs to see who's where to avoid blue-on-blue).
		// Anything outside this set stays hidden, matching what the
		// player sees on the cockpit HUD. Future 5g.4: stale-contact
		// dead-reckoning + last-seen timestamp tooltips.
		const ownContacts = (playerState && playerState.contacts) || null;
		const playerTeam = (playerState && playerState.team) || 'friendly';
		const teamDl = getTeamDatalink(playerTeam);
		const dlContacts = teamDl ? teamDl.contacts : null;
		const dlIntel    = teamDl ? teamDl.intelContacts : null;
		const isCurrentlyDetected = (u) => {
			if (!u) return false;
			if (ownContacts && ownContacts.has(u)) return true;
			if (dlContacts  && dlContacts.has(u))  return true;
			return false;
		};
		// Knowledge resolution per unit (highest first):
		//   live   — current sensor or datalink contact
		//   stale  — recently sensor-painted, now memory-only
		//   intel  — never sensor-painted, only briefed (or ELINT later)
		// Marker for any given unit picks the highest-quality source
		// available this frame, so as soon as a sensor confirms a
		// briefed contact the marker auto-promotes from dim → bright.
		const intelFor = (u) => (dlIntel ? dlIntel.get(u) : null);

		// Update the stale-contact memory: any currently-detected unit
		// gets its position cached now, with a timestamp. Cached
		// entries persist for STALE_MEMORY_S so the planner can show
		// "I last saw this here" markers even after detection drops.
		const now = performance.now() * 0.001;
		if (units) {
			for (const u of units) {
				if (!u || u.destroyed) continue;
				if (u.team === playerTeam) continue;
				if (isCurrentlyDetected(u)) {
					this._lastKnown.set(u, {
						lon: u.lon, lat: u.lat, alt: u.alt || 0,
						lastSeen: now,
					});
				}
			}
		}
		// Drop entries past the memory window or whose unit died.
		for (const [u, mem] of this._lastKnown) {
			if (!u || u.destroyed || u.active === false) {
				this._lastKnown.delete(u);
				continue;
			}
			if (now - mem.lastSeen > STALE_MEMORY_S) {
				this._lastKnown.delete(u);
			}
		}

		if (units) {
			for (const u of units) {
				if (!u || u.destroyed) continue;
				const isFriendly = u.team === playerTeam;
				const detected = isCurrentlyDetected(u);
				const stale = !detected && this._lastKnown.has(u);
				const intel = !detected && !stale ? intelFor(u) : null;
				if (!isFriendly && !detected && !stale && !intel) continue;

				const id = `npc-${u.id || u.name}`;
				const baseColor = _colorForUnit(u);
				const labelBase = u.name || 'BOGEY';

				// Pick render position + color + label from highest-
				// quality source available this frame. Live sensor wins,
				// then memory-stale, then intel.
				let renderColor;
				let renderUnit;
				let labelText;
				let uncertaintyM = 0;
				if (detected || isFriendly) {
					renderColor = baseColor;
					renderUnit = u;
					labelText = labelBase;
				} else if (stale) {
					renderColor = baseColor.withAlpha(0.4);
					renderUnit = this._lastKnown.get(u);
					labelText = `${labelBase}  LAST ${_formatAge(now - this._lastKnown.get(u).lastSeen)}`;
				} else {
					// Intel-only (briefed or ELINT, never sensor-painted
					// in this session). Dimmer than stale + a tag
					// describing the intel source. Suspected entries
					// also draw an uncertainty disc.
					renderColor = baseColor.withAlpha(0.35);
					renderUnit = { lon: intel.lon, lat: intel.lat, alt: intel.alt };
					if (intel.kind === 'briefed-suspected') {
						labelText = `${labelBase}  ?`;
						uncertaintyM = intel.uncertaintyM || 0;
					} else if (intel.kind === 'elint') {
						// ELINT contacts get a slight orange tint so
						// they stand out from briefed (which uses team
						// color) — the player should immediately read
						// "this is something actively emitting RIGHT
						// NOW" vs "this is something the briefing
						// said exists."
						renderColor = Cesium.Color.fromCssColorString('#ffaa44').withAlpha(0.55);
						labelText = `${labelBase}  ELINT`;
					} else if (intel.kind === 'satellite') {
						// Satellite snapshots tinted blue/cyan to match
						// the "imagery from above" mental model. Label
						// includes a freshness countdown so the player
						// knows the snapshot is going stale and will
						// vanish at the configured memory window. The
						// marker auto-promotes to a bright live track
						// the moment a sensor confirms it.
						renderColor = Cesium.Color.fromCssColorString('#66ddff').withAlpha(0.65);
						const ageS    = Math.max(0, now - intel.lastSeen);
						const memS    = intel.memoryS || 600;
						const remS    = Math.max(0, memS - ageS);
						const remM    = Math.floor(remS / 60);
						const remR    = Math.floor(remS) % 60;
						const remStr  = `${remM.toString().padStart(2,'0')}:${remR.toString().padStart(2,'0')}`;
						labelText = `${labelBase}  SAT ${remStr}`;
					} else {
						labelText = `${labelBase}  BRIEFED`;
					}
				}
				this._ensureMarker(id, baseColor, labelText);
				const m = this._markers.get(id);
				if (m && m.label) m.label.text = labelText;
				updateOne(id, renderUnit, renderColor, {
					unitForClick: isFriendly ? null : u,
					stale,
					uncertaintyM,
				});
			}
		}
		if (missiles) {
			const playerTeam = (playerState && playerState.team) || 'friendly';
			for (const m of missiles) {
				if (!m || !m.active) continue;
				const id = `m-${m.id || 'msl'}`;
				const isHostile = (m.team || 'friendly') !== playerTeam;
				const color = isHostile ? COLOR_MSL_HOSTILE : COLOR_MSL_FRIENDLY;
				const ent = this._ensureMarker(id, color, m.type || 'MSL');
				if (ent && ent.point) ent.point.color = color;
				updateOne(id, m, color);
			}
		}

		// Hide any marker whose unit is gone this frame.
		for (const [id, ent] of this._markers) {
			if (!seen.has(id)) ent.show = false;
		}
		// Same for uncertainty discs — auto-vanish when the unit
		// upgrades from intel-suspected to live/stale (sensor
		// confirmation auto-promotion path).
		for (const [id, disc] of this._uncertaintyDiscs) {
			if (!seenDiscs.has(id)) disc.show = false;
		}
	}

	_setAllMarkersVisible(visible) {
		for (const ent of this._markers.values()) ent.show = visible;
		for (const ent of this._uncertaintyDiscs.values()) ent.show = false;
	}

	// ---- Designation marker --------------------------------------------------

	_syncTargetMarkers() {
		// Bring marker count in sync with the queue. Add for new
		// queue slots, remove for vanished ones (after a fire or a
		// click-to-remove). Cesium entities support cheap reuse.
		while (this._targetMarkers.length < designationQueue.length) {
			const idx = this._targetMarkers.length;
			const ent = this.viewer.entities.add({
				position: Cesium.Cartesian3.fromDegrees(0, 0, 0),
				point: {
					pixelSize: 14,
					color: COLOR_TARGET,
					outlineColor: Cesium.Color.WHITE,
					outlineWidth: 2,
					disableDepthTestDistance: Number.POSITIVE_INFINITY,
				},
				label: {
					text: String(idx + 1),
					font: 'bold 13px sans-serif',
					fillColor: Cesium.Color.WHITE,
					outlineColor: Cesium.Color.BLACK,
					outlineWidth: 2,
					style: Cesium.LabelStyle.FILL_AND_OUTLINE,
					pixelOffset: new Cesium.Cartesian2(12, 0),
					verticalOrigin: Cesium.VerticalOrigin.CENTER,
					horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
					disableDepthTestDistance: Number.POSITIVE_INFINITY,
				},
				show: this.active,
			});
			// Tag with the marker's queue index so click-pick knows
			// which entry to remove. The index gets refreshed each
			// frame to handle queue compaction after a consume.
			ent.__strikeIndex = idx;
			this._targetMarkers.push(ent);
		}
		while (this._targetMarkers.length > designationQueue.length) {
			const ent = this._targetMarkers.pop();
			this.viewer.entities.remove(ent);
		}
		// Update each marker's position + label + visibility based on
		// the current queue. Head (index 0) gets a brighter marker
		// AND a slow pulse on its pixel size so the player sees which
		// shot is next up at a glance even on a busy battlefield.
		const t = performance.now() * 0.001;
		const headPulse = 16 + Math.sin(t * 3) * 2;   // 14..18px @ ~2 Hz
		for (let i = 0; i < designationQueue.length; i++) {
			const d = designationQueue[i];
			const ent = this._targetMarkers[i];
			ent.position = Cesium.Cartesian3.fromDegrees(d.lon, d.lat, (d.alt || 0) + 50);
			if (ent.label) ent.label.text = String(i + 1);
			if (ent.point) {
				ent.point.pixelSize = i === 0 ? headPulse : 12;
				ent.point.color = i === 0
					? COLOR_TARGET
					: COLOR_TARGET.withAlpha(0.7);
			}
			ent.__strikeIndex = i;
			ent.show = this.active;
		}
	}

	// ---- Input ---------------------------------------------------------------

	_bindInputs() {
		window.addEventListener('keydown', (e) => {
			if (e.repeat) return;
			const k = e.key.toLowerCase();
			if (k === 'b') {
				this.setActive(!this.active);
				return;
			}
			if (!this.active) return;
			if (k === 'escape') {
				this.setActive(false);
			} else if (k === 'a') {
				e.preventDefault();
				this.autoAssign();
			} else if (k === 'c') {
				e.preventDefault();
				clearDesignationQueue();
			} else if (k === 'l') {
				e.preventDefault();
				const on = toggleCycleMode();
				this._flash(`CYCLE ${on ? 'ON — queue rotates after each shot' : 'OFF — queue drains'}`,
					on ? '#0f8' : '#ff8', 3);
				this._refreshToolbar(this._lastPlayerState);
			} else if (k === 'r') {
				e.preventDefault();
				const next = (formation.breakBehavior === 'cap') ? 'rtb' : 'cap';
				formation.breakBehavior = next;
				// Re-mode any wingmen already on patrol so the change
				// applies immediately, not on next ammo-exhaustion event.
				for (const m of formation.members) {
					if (!m || m.destroyed) continue;
					if (m._wingmanMode === MODE_PATROL_CAP || m._wingmanMode === MODE_PATROL_RTB) {
						setMemberMode(m, next === 'cap' ? MODE_PATROL_CAP : MODE_PATROL_RTB);
					}
				}
				this._flash(`FLIGHT: ${next.toUpperCase()} ${next === 'cap'
					? '— wingmen orbit your position' : '— wingmen orbit spawn'}`,
					'#0f8', 3);
				this._refreshToolbar(this._lastPlayerState);
			}
		});

		// Pointer events on window+capture (commander-view pattern,
		// see ../commanderView.js for why this beats canvas-bound).
		// Mode dispatched on pointerdown:
		//   right-click anywhere → context-style action (delete dot
		//                          if one is under cursor; otherwise
		//                          consumed silently to keep the
		//                          browser context menu away).
		//   left on target dot   → drag-to-move the target.
		//   left on enemy unit   → 'unit' tentative; commits on pointerup.
		//   left on empty world  → 'pan' tentative; commits on pointerup
		//                          if barely moved (= click → add target).
		window.addEventListener('pointerdown', (e) => {
			if (!this.active) return;
			if (e.target && e.target.closest && e.target.closest('#strike-planner-toolbar')) {
				return; // let toolbar buttons do their own thing
			}
			this._lastX = e.clientX;
			this._lastY = e.clientY;
			this._downX = e.clientX;
			this._downY = e.clientY;
			this._dragDist = 0;

			if (e.button === 2) {
				// Right-click: delete target under cursor if any.
				const idx = this._pickTargetIndexAt(e.clientX, e.clientY);
				if (idx >= 0) removeDesignationAt(idx);
				e.preventDefault();
				e.stopPropagation();
				return;
			}
			if (e.button !== 0) return;

			const idx = this._pickTargetIndexAt(e.clientX, e.clientY);
			if (idx >= 0) {
				this._dragMode = 'target';
				this._dragTargetIdx = idx;
				// Snapshot the original lat/lon/alt so we can restore
				// it if the gesture turns out to be a reorder (drop
				// onto another target dot) rather than a reposition.
				const d = designationQueue[idx];
				this._dragOriginalPos = d ? { lon: d.lon, lat: d.lat, alt: d.alt } : null;
			} else if (e.shiftKey) {
				// Shift+left-drag = rectangle multi-select (5g.3).
				this._dragMode = 'lasso';
				this._lassoStartX = e.clientX;
				this._lassoStartY = e.clientY;
				this._showLasso(e.clientX, e.clientY, e.clientX, e.clientY);
			} else {
				const unit = this._pickUnitAt(e.clientX, e.clientY);
				if (unit) {
					this._dragMode = 'unit';
					this._dragUnitRef = unit;
				} else {
					this._dragMode = 'pan';
				}
			}
			e.preventDefault();
			e.stopPropagation();
		}, true);

		window.addEventListener('pointermove', (e) => {
			if (!this.active || !this._dragMode) return;
			const dx = e.clientX - this._lastX;
			const dy = e.clientY - this._lastY;
			this._lastX = e.clientX;
			this._lastY = e.clientY;
			this._dragDist += Math.abs(dx) + Math.abs(dy);
			e.stopPropagation();

			if (this._dragMode === 'target') {
				// Live drag: rewrite the queued target's lat/lon to
				// the cursor's world position. Alt re-samples async
				// on pointerup (one terrain query per click is enough).
				const ll = this._screenToLatLon(e.clientX, e.clientY);
				if (ll) {
					const d = designationQueue[this._dragTargetIdx];
					if (d) {
						d.lon = ll.lon;
						d.lat = ll.lat;
					}
				}
				return;
			}
			if (this._dragMode === 'lasso') {
				this._showLasso(this._lassoStartX, this._lassoStartY, e.clientX, e.clientY);
				return;
			}
			if (this._dragMode === 'pan') {
				// Grab-and-drag pan (drag right → world follows
				// right). Sensitivity scales with `distance`.
				const mpp = this.distance * 0.0006;
				const eastMeters  = -dx * mpp;
				const northMeters =  dy * mpp;
				const cosLat = Math.cos(this.centerLat * Math.PI / 180) || 1;
				this.centerLat += northMeters / 111320;
				this.centerLon += eastMeters  / (111320 * Math.max(0.1, cosLat));
			}
			// 'unit' mode: a wiggle past clickBudget is treated as a
			// pan starting from the unit. Convert mode and continue.
			if (this._dragMode === 'unit' && this._dragDist > this._clickBudgetPx) {
				this._dragMode = 'pan';
				this._dragUnitRef = null;
			}
		}, true);

		window.addEventListener('pointerup', (e) => {
			if (!this.active || !this._dragMode) return;
			const mode = this._dragMode;
			const idx  = this._dragTargetIdx;
			const unit = this._dragUnitRef;
			this._dragMode = null;
			this._dragTargetIdx = -1;
			this._dragUnitRef = null;
			e.stopPropagation();

			if (mode === 'lasso') {
				this._hideLasso();
				this._commitLasso(this._lassoStartX, this._lassoStartY, e.clientX, e.clientY);
				return;
			}

			if (mode === 'target') {
				// Drag-to-reorder: if the user dropped onto another
				// queued target dot, splice the dragged one to that
				// dot's position. Otherwise the gesture committed a
				// move-by-position (existing behavior) — refine the
				// terrain alt at the new spot.
				const dropIdx = this._pickTargetIndexAt(e.clientX, e.clientY);
				if (dropIdx >= 0 && dropIdx !== idx) {
					// Reorder. The dot was visually following the
					// cursor; restore its original lat/lon since
					// we're using the gesture as "intent to reorder"
					// not "intent to move." Then splice in the new
					// position.
					const moved = designationQueue[idx];
					if (moved && this._dragOriginalPos) {
						moved.lon = this._dragOriginalPos.lon;
						moved.lat = this._dragOriginalPos.lat;
						moved.alt = this._dragOriginalPos.alt;
					}
					this._dragOriginalPos = null;
					moveDesignation(idx, dropIdx);
					this._flash(`reordered: target ${idx + 1} → slot ${dropIdx + 1}`,
						'#0f8', 2);
					return;
				}
				this._dragOriginalPos = null;
				// Refine alt on the dragged target (cheap one-shot
				// terrain sample at the dropped lat/lon).
				const d = designationQueue[idx];
				if (d) {
					const carto = Cesium.Cartographic.fromDegrees(d.lon, d.lat);
					Cesium.sampleTerrainMostDetailed(this.viewer.terrainProvider, [carto])
						.then(([p]) => refineDesignationAlt(d.lon, d.lat, Math.max(0, p.height || 0)))
						.catch(() => {});
				}
				return;
			}
			if (this._dragDist >= this._clickBudgetPx) return; // was a real drag

			// Click commits. 'unit' mode → add at unit's current pos
			// (snapshotted at pointerup since GPS bombs freeze on
			// release anyway). 'pan' mode → add at cursor terrain.
			if (mode === 'unit' && unit) {
				addDesignation(unit.lon, unit.lat, unit.alt || 0);
				return;
			}
			if (mode === 'pan') {
				this._addAtScreen(e.clientX, e.clientY);
			}
		}, true);

		// Right-click context menu: swallow while the planner is
		// active so the browser doesn't pop a menu over the map.
		window.addEventListener('contextmenu', (e) => {
			if (!this.active) return;
			e.preventDefault();
		}, true);

		window.addEventListener('wheel', (e) => {
			if (!this.active) return;
			e.preventDefault();
			e.stopPropagation();
			// Zoom toward the cursor: compute the world point under
			// the cursor before the zoom, change distance, then shift
			// centerLon/centerLat so that same world point ends up at
			// the cursor again. Same trick Google Maps / Cesium use.
			const before = this._screenToLatLon(e.clientX, e.clientY);
			const factor = e.deltaY > 0 ? 1.25 : 1 / 1.25;
			this.distance = Math.max(500, Math.min(2_000_000, this.distance * factor));
			// Re-pose the camera at the new distance BEFORE the after-
			// pick so the projection math uses the new view.
			this._applyCamera();
			const after = this._screenToLatLon(e.clientX, e.clientY);
			if (before && after) {
				this.centerLon += before.lon - after.lon;
				this.centerLat += before.lat - after.lat;
			}
		}, { passive: false, capture: true });
	}

	// Project a screen-pixel position to a {lon, lat} on the globe,
	// using the current camera. Returns null if the ray misses the
	// globe (e.g. pointing at sky off the horizon).
	_screenToLatLon(x, y) {
		const ray = this.viewer.camera.getPickRay(new Cesium.Cartesian2(x, y));
		if (!ray) return null;
		const cart = this.viewer.scene.globe.pick(ray, this.viewer.scene);
		if (!cart) return null;
		const c = Cesium.Cartographic.fromCartesian(cart);
		return {
			lon: Cesium.Math.toDegrees(c.longitude),
			lat: Cesium.Math.toDegrees(c.latitude),
		};
	}

	// What's under the cursor: target dot index (if any), -1 otherwise.
	_pickTargetIndexAt(x, y) {
		const picked = this.viewer.scene.pick(new Cesium.Cartesian2(x, y));
		if (picked && picked.id && typeof picked.id.__strikeIndex === 'number') {
			return picked.id.__strikeIndex;
		}
		return -1;
	}

	// What's under the cursor: an enemy/known unit, or null. Reads the
	// __strikeUnit field we stamp on unit markers in _syncMarkers.
	_pickUnitAt(x, y) {
		const picked = this.viewer.scene.pick(new Cesium.Cartesian2(x, y));
		if (picked && picked.id && picked.id.__strikeUnit) {
			return picked.id.__strikeUnit;
		}
		return null;
	}

	// Add a target at the screen-pixel position. Uses a two-stage alt
	// resolve (rough cartographic immediately, refined async).
	_addAtScreen(x, y) {
		const ray = this.viewer.camera.getPickRay(new Cesium.Cartesian2(x, y));
		if (!ray) return;
		const cart = this.viewer.scene.globe.pick(ray, this.viewer.scene);
		if (!cart) return;
		const carto = Cesium.Cartographic.fromCartesian(cart);
		const lon = Cesium.Math.toDegrees(carto.longitude);
		const lat = Cesium.Math.toDegrees(carto.latitude);
		addDesignation(lon, lat, Math.max(0, carto.height || 0));
		Cesium.sampleTerrainMostDetailed(this.viewer.terrainProvider, [carto])
			.then(([p]) => refineDesignationAlt(lon, lat, Math.max(0, p.height || 0)))
			.catch(() => {});
	}

	// ---- Rectangle multi-select (5g.3) ---------------------------------------
	//
	// Shift+drag draws a screen-space rectangle. On release, every
	// hostile unit currently rendered as a planner marker (live, stale,
	// or intel) whose screen-projected position falls inside the
	// rectangle gets queued as a designation. Friendlies and the player
	// are excluded. Useful for "blanket-target this whole SAM cluster"
	// without 8 individual unit-clicks.

	_showLasso(x0, y0, x1, y1) {
		if (!this._lassoEl) {
			const el = document.createElement('div');
			el.style.cssText = `
				position: absolute;
				background: rgba(0, 255, 0, 0.08);
				border: 1px dashed rgba(0, 255, 0, 0.7);
				pointer-events: none;
				z-index: 60;
			`;
			document.body.appendChild(el);
			this._lassoEl = el;
		}
		const left = Math.min(x0, x1);
		const top  = Math.min(y0, y1);
		const w    = Math.abs(x1 - x0);
		const h    = Math.abs(y1 - y0);
		this._lassoEl.style.left   = `${left}px`;
		this._lassoEl.style.top    = `${top}px`;
		this._lassoEl.style.width  = `${w}px`;
		this._lassoEl.style.height = `${h}px`;
		this._lassoEl.style.display = 'block';
	}

	_hideLasso() {
		if (this._lassoEl) this._lassoEl.style.display = 'none';
	}

	// Walk every visible hostile-unit marker, project its world
	// position to screen, and queue any whose screen point falls inside
	// the rectangle. Skip friendlies and missiles (the latter already
	// have their own marker class but aren't useful as designations).
	_commitLasso(x0, y0, x1, y1) {
		const left = Math.min(x0, x1);
		const right = Math.max(x0, x1);
		const top    = Math.min(y0, y1);
		const bottom = Math.max(y0, y1);
		// Reject zero-size / tiny rectangles — those are probably
		// shift-clicks that didn't actually drag, and committing 0
		// targets would be confusing.
		if (right - left < 4 || bottom - top < 4) {
			this._flash('AREA SELECT: rectangle too small', '#ff8', 2);
			return;
		}
		const ps = this._lastPlayerState;
		const playerTeam = (ps && ps.team) || 'friendly';
		const scene = this.viewer.scene;
		let added = 0;
		for (const [id, ent] of this._markers) {
			if (!ent || !ent.show) continue;
			if (id === '__player') continue;
			if (id.startsWith('m-')) continue;          // missiles
			const u = ent.__strikeUnit;
			if (!u) continue;                            // friendlies are stamped null
			if (u.destroyed) continue;
			if (u.team === playerTeam) continue;
			// Marker's CURRENT position (Cesium ConstantPositionProperty).
			const pos = ent.position && ent.position.getValue
				? ent.position.getValue(this.viewer.clock.currentTime)
				: ent.position;
			if (!pos) continue;
			const screen = scene.cartesianToCanvasCoordinates(pos);
			if (!screen) continue;
			if (screen.x < left || screen.x > right) continue;
			if (screen.y < top  || screen.y > bottom) continue;
			// Project the marker's lat/lon back from the world position
			// (more accurate than reading u.lon/lat for intel-displayed
			// suspected dots, where the marker sits on the jittered
			// briefed coord, not the unit's true position).
			const carto = Cesium.Cartographic.fromCartesian(pos);
			const lon = Cesium.Math.toDegrees(carto.longitude);
			const lat = Cesium.Math.toDegrees(carto.latitude);
			const alt = u.alt || carto.height || 0;
			addDesignation(lon, lat, alt);
			added++;
		}
		this._flash(`AREA SELECT: queued ${added} target${added === 1 ? '' : 's'}`,
			added > 0 ? '#0f8' : '#ff8', 3);
	}
}
