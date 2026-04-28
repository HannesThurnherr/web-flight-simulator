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

		// Initial camera placement when the panel opens. After that
		// Cesium's native controller owns pan/zoom — we just lock the
		// orientation to top-down each frame so the user can't tilt.
		this._initialDistance = 25000;

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

		// Click vs drag detection. Pointerdown stamps a position;
		// pointerup compares — small Δ = click → designate, large = drag
		// (which Cesium's controller will have already handled).
		this._clickBudgetPx = 4;
		this._downX = 0;
		this._downY = 0;

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
			// Snap once to a top-down view centered on the player.
			// After this, Cesium's native controller owns pan + zoom
			// (which gives grab-feel drag and zoom-to-cursor for
			// free); we just clamp the orientation back to top-down
			// each frame so the user can't tilt or rotate the view.
			const ps = this._lastPlayerState;
			if (ps) {
				this.viewer.camera.setView({
					destination: Cesium.Cartesian3.fromDegrees(ps.lon, ps.lat, this._initialDistance),
					orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
				});
			}
			// Lock out tilt + look so the planner stays purely top-down.
			// Pan/zoom remain native: feel matches commander view's
			// drag-to-pan + wheel-to-zoom-toward-cursor exactly.
			this._savedTilt = ctrl.enableTilt;
			this._savedLook = ctrl.enableLook;
			ctrl.enableTilt = false;
			ctrl.enableLook = false;
			// Defensive: an earlier iteration of this code disabled
			// inputs entirely, and a stale session may have left the
			// flag false. Force-enable so pan + zoom land regardless.
			ctrl.enableInputs = true;
			// Cesium's native pan/zoom controller binds DOM events to
			// its own canvas at z=1. The THREE container at z=5 sits
			// on top and was absorbing every drag + wheel before they
			// could reach Cesium. pointer-events:none alone wasn't
			// enough in practice, so just hide threeContainer entirely
			// while the planner owns the screen — the cockpit isn't
			// visible anyway and Three.js keeps rendering off-screen.
			const threeContainer = document.getElementById('threeContainer');
			if (threeContainer) {
				this._savedThreeDisplay = threeContainer.style.display;
				threeContainer.style.display = 'none';
			}
		} else {
			if (this._savedTilt !== undefined) ctrl.enableTilt = this._savedTilt;
			if (this._savedLook !== undefined) ctrl.enableLook = this._savedLook;
			const threeContainer = document.getElementById('threeContainer');
			if (threeContainer) {
				threeContainer.style.display = this._savedThreeDisplay || '';
			}
		}

		this._setAllMarkersVisible(active);
		for (const m of this._targetMarkers) m.show = active;
		this.viewer.scene.requestRender();
	}

	// Per-frame update. Caller passes the same args commanderView gets.
	update(dt, playerState, units, missiles) {
		this._lastPlayerState = playerState;
		if (!this.active) return;

		this._syncMarkers(playerState, units, missiles);
		this._syncTargetMarkers();
		this.viewer.scene.requestRender();
	}

	// ---- Camera --------------------------------------------------------------

	_lockOrientation() {
		// Cesium's native controller can drift heading slightly during
		// drag-pan in 3D mode. Re-orient back to north-up + top-down
		// each frame, preserving the camera's current position. Cheap
		// — just a setView with the existing position.
		const cam = this.viewer.camera;
		const carto = Cesium.Cartographic.fromCartesian(cam.position);
		cam.setView({
			destination: cam.position,
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
		// TODO 5g.4: filter `units` by player-team-knowledge (own
		// sensors + datalink) instead of showing the god-eye list.
		if (units) {
			for (const u of units) {
				if (!u || u.destroyed) continue;
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

		// Pan + zoom are handled by Cesium's native screenSpaceCamera
		// controller (left them enabled in setActive) — that gives
		// grab-feel drag, zoom-toward-cursor, and inertia for free.
		// We only need to detect a true click (pointerdown + pointerup
		// at roughly the same position, no drag in between) to call
		// _handleClickAt for designation.
		//
		// Window + capture so we beat #threeContainer (z=5), which
		// overlays the Cesium canvas and would otherwise eat every
		// pointer event before it could reach a canvas-level handler.
		window.addEventListener('pointerdown', (e) => {
			if (!this.active) return;
			if (e.button !== 0) return;
			this._downX = e.clientX;
			this._downY = e.clientY;
		}, true);

		window.addEventListener('pointerup', (e) => {
			if (!this.active) return;
			if (e.button !== 0) return;
			const dx = e.clientX - this._downX;
			const dy = e.clientY - this._downY;
			if (Math.hypot(dx, dy) < this._clickBudgetPx) {
				this._handleClickAt(e.clientX, e.clientY);
			}
		}, true);
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
