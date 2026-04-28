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
} from './designation.js';
import { getTeamDatalink } from './teamDatalink.js';

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

		// Used by the planner-toggle key to center on the player at
		// open time. Set every frame's update().
		this._lastPlayerState = null;

		// Pan + click detection bookkeeping. We drive pan ourselves
		// (Cesium's native controller wasn't reliably receiving events
		// even with threeContainer hidden), so window-capture pointer
		// events update centerLon/centerLat directly. A small drag
		// distance is treated as a click (designation); larger as a
		// drag (pan). Same approach commander view uses.
		this._clickBudgetPx = 6;
		this._dragging = false;
		this._lastX = 0;
		this._lastY = 0;
		this._downX = 0;
		this._downY = 0;
		this._dragDist = 0;

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
		this.viewer.scene.requestRender();
	}

	// Per-frame update. Caller passes the same args commanderView gets.
	update(dt, playerState, units, missiles) {
		this._lastPlayerState = playerState;
		if (!this.active) return;

		this._applyCamera();
		this._syncMarkers(playerState, units, missiles);
		this._syncTargetMarkers();
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

		const updateOne = (id, u, color) => {
			const e = this._markers.get(id);
			if (!e) return;
			e.position = Cesium.Cartesian3.fromDegrees(u.lon, u.lat, u.alt);
			e.point.color = color;
			e.show = true;
			seen.add(id);
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
		const knownToPlayer = (u) => {
			if (!u) return false;
			if (u.team === playerTeam) return true; // friendlies
			if (ownContacts && ownContacts.has(u)) return true;
			if (dlContacts  && dlContacts.has(u))  return true;
			return false;
		};

		if (units) {
			for (const u of units) {
				if (!u || u.destroyed) continue;
				if (!knownToPlayer(u)) continue;
				const id = `npc-${u.id || u.name}`;
				const c  = _colorForUnit(u);
				this._ensureMarker(id, c, u.name || 'BOGEY');
				updateOne(id, u, c);
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
	}

	_setAllMarkersVisible(visible) {
		for (const ent of this._markers.values()) ent.show = visible;
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
		// the current queue. Head (index 0) gets a brighter marker so
		// the player sees which shot is next up.
		for (let i = 0; i < designationQueue.length; i++) {
			const d = designationQueue[i];
			const ent = this._targetMarkers[i];
			ent.position = Cesium.Cartesian3.fromDegrees(d.lon, d.lat, (d.alt || 0) + 50);
			if (ent.label) ent.label.text = String(i + 1);
			if (ent.point) {
				ent.point.pixelSize = i === 0 ? 16 : 12;
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
			} else if (k === 'escape' && this.active) {
				this.setActive(false);
			}
		});

		// Manual pan + zoom via window-capture pointer events. Cesium's
		// native controller wasn't reliably receiving events under
		// our overlay stack; commander view uses this same pattern
		// and it's known to work. Window + capture beats element
		// hit-testing — the events fire regardless of what's on top.
		window.addEventListener('pointerdown', (e) => {
			if (!this.active) return;
			if (e.button !== 0) return;
			this._dragging = true;
			this._lastX = e.clientX;
			this._lastY = e.clientY;
			this._downX = e.clientX;
			this._downY = e.clientY;
			this._dragDist = 0;
			e.preventDefault();
			e.stopPropagation();
		}, true);

		window.addEventListener('pointermove', (e) => {
			if (!this.active || !this._dragging) return;
			const dx = e.clientX - this._lastX;
			const dy = e.clientY - this._lastY;
			this._lastX = e.clientX;
			this._lastY = e.clientY;
			this._dragDist += Math.abs(dx) + Math.abs(dy);
			e.stopPropagation();

			// Grab-and-drag pan: move the look-at point opposite to
			// the cursor so the world visually follows the cursor
			// (drag right → world moves right). Sensitivity scales
			// with `distance` (a metres-per-pixel factor) so panning
			// feels the same at any zoom level.
			//
			// At top-down + north-up: screen +x is east, screen +y is
			// south. Cursor moves +dx → look-at moves -dx in east
			// terms (i.e. west). Same for north (with sign flip
			// because screen-y increases downward).
			const mpp = this.distance * 0.0006;
			const eastMeters  = -dx * mpp;
			const northMeters =  dy * mpp;
			const cosLat = Math.cos(this.centerLat * Math.PI / 180) || 1;
			this.centerLat += northMeters / 111320;
			this.centerLon += eastMeters  / (111320 * Math.max(0.1, cosLat));
		}, true);

		window.addEventListener('pointerup', (e) => {
			if (!this.active || !this._dragging) return;
			this._dragging = false;
			// Click vs drag classification using TOTAL travel since
			// pointerdown — small wiggle counts as a click.
			if (this._dragDist < this._clickBudgetPx && e.button === 0) {
				this._handleClickAt(e.clientX, e.clientY);
			}
			e.stopPropagation();
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

	_handleClickAt(x, y) {
		// First check if the click landed on an existing target marker
		// — Cesium scene.pick returns the entity under the cursor.
		// Clicking an existing TGT removes it from the queue. (Lets
		// the player un-queue without keyboard.)
		const picked = this.viewer.scene.pick(new Cesium.Cartesian2(x, y));
		if (picked && picked.id && typeof picked.id.__strikeIndex === 'number') {
			removeDesignationAt(picked.id.__strikeIndex);
			return;
		}

		// Otherwise treat as "add a new target". Globe-pick → terrain
		// sample → addDesignation. Two-stage: rough alt immediately so
		// the marker pops without latency, then a precise sample comes
		// back asynchronously and refines the alt in place.
		const ray = this.viewer.camera.getPickRay(new Cesium.Cartesian2(x, y));
		if (!ray) return;
		const cart = this.viewer.scene.globe.pick(ray, this.viewer.scene);
		if (!cart) return;

		const carto = Cesium.Cartographic.fromCartesian(cart);
		const lon = Cesium.Math.toDegrees(carto.longitude);
		const lat = Cesium.Math.toDegrees(carto.latitude);
		const roughAlt = Math.max(0, carto.height || 0);
		addDesignation(lon, lat, roughAlt);

		Cesium.sampleTerrainMostDetailed(this.viewer.terrainProvider, [carto])
			.then(([p]) => {
				refineDesignationAlt(lon, lat, Math.max(0, p.height || 0));
			})
			.catch(() => {});
	}
}
