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
import { setDesignationFromMap, playerDesignation } from './designation.js';

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

		// Camera state. Top-down only — no tilt/rotation in 5g.1, the
		// planner is a 2D-feeling map even though it's technically a
		// constrained 3D camera.
		this.centerLon = 0;
		this.centerLat = 0;
		this.distance  = 25000;

		// Marker entities for units (player, NPCs, missiles), keyed by
		// stable id. Same shape as commanderView's _markers — separate
		// map so the two views don't trample each other's entity refs.
		this._markers = new Map();

		// One entity for the current designated target. Reused across
		// clicks (position rewritten in place), shown only while there
		// is an active designation.
		this._targetMarker = null;

		// Used by the planner-toggle key to center on the player at
		// open time. Set every frame's update().
		this._lastPlayerState = null;

		// Drag-to-pan bookkeeping. Pointer events on the canvas in
		// capture phase so we beat Cesium's own controller (we leave
		// Cesium's controller enabled so wheel-zoom still works; we
		// intercept pan and click ourselves).
		this._panning   = false;
		this._panLastX  = 0;
		this._panLastY  = 0;
		// Click vs drag detection — pointerdown sets a small budget,
		// pointermove eats it, pointerup with budget remaining counts
		// as a click. Avoids clicks-being-eaten-by-tiny-drags.
		this._clickBudgetPx = 4;
		this._clickBudget   = 0;

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

		if (active) {
			// Center on the latest known player position so the first
			// frame is useful.
			if (this._lastPlayerState) {
				this.centerLon = this._lastPlayerState.lon;
				this.centerLat = this._lastPlayerState.lat;
			}
			// Disable Cesium's own input controller — we do all the
			// drag/click handling ourselves and don't want the camera
			// stuttering between our writes and Cesium's.
			this.viewer.scene.screenSpaceCameraController.enableInputs = false;
		} else {
			this.viewer.scene.screenSpaceCameraController.enableInputs = true;
		}

		this._setAllMarkersVisible(active);
		if (this._targetMarker) {
			this._targetMarker.show = active && _hasDesignation();
		}
		this.viewer.scene.requestRender();
	}

	// Per-frame update. Caller passes the same args commanderView gets.
	update(dt, playerState, units, missiles) {
		this._lastPlayerState = playerState;
		if (!this.active) return;

		this._applyCamera();
		this._syncMarkers(playerState, units, missiles);
		this._syncTargetMarker();
		this.viewer.scene.requestRender();
	}

	// ---- Camera --------------------------------------------------------------

	_applyCamera() {
		// Pure top-down. No tilt control in 5g.1 — the whole point of
		// this surface is "look straight down so the geometry of the
		// strike plan reads cleanly."
		const lookAt = Cesium.Cartesian3.fromDegrees(this.centerLon, this.centerLat, 0);
		this.viewer.camera.setView({
			destination: Cesium.Cartesian3.fromDegrees(this.centerLon, this.centerLat, this.distance),
			orientation: {
				heading: 0,
				pitch:   -Math.PI / 2,
				roll:    0,
			},
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

	_syncTargetMarker() {
		const has = _hasDesignation();
		if (!this._targetMarker) {
			this._targetMarker = this.viewer.entities.add({
				position: Cesium.Cartesian3.fromDegrees(0, 0, 0),
				point: {
					pixelSize: 14,
					color: COLOR_TARGET,
					outlineColor: Cesium.Color.WHITE,
					outlineWidth: 2,
					disableDepthTestDistance: Number.POSITIVE_INFINITY,
				},
				label: {
					text: 'TGT',
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
				show: false,
			});
		}
		if (has) {
			this._targetMarker.position = Cesium.Cartesian3.fromDegrees(
				playerDesignation.lon, playerDesignation.lat,
				(playerDesignation.alt || 0) + 50,   // tiny lift so the marker isn't terrain-occluded
			);
			this._targetMarker.show = this.active;
		} else {
			this._targetMarker.show = false;
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

		// Pointer events on the Cesium canvas. Capture phase so we
		// beat any other handler the page may have installed.
		const canvas = this.viewer.scene.canvas;
		if (!canvas) return;

		canvas.addEventListener('pointerdown', (e) => {
			if (!this.active) return;
			if (e.button !== 0) return;
			this._panning  = true;
			this._panLastX = e.clientX;
			this._panLastY = e.clientY;
			this._clickBudget = this._clickBudgetPx;
			canvas.style.cursor = 'grabbing';
			try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
		});

		canvas.addEventListener('pointermove', (e) => {
			if (!this.active || !this._panning) return;
			const dx = e.clientX - this._panLastX;
			const dy = e.clientY - this._panLastY;
			this._panLastX = e.clientX;
			this._panLastY = e.clientY;
			// Track travelled distance for click vs drag classification.
			this._clickBudget -= Math.abs(dx) + Math.abs(dy);
			// Pan magnitude scales with view distance so the world feels
			// roughly stationary under the cursor regardless of zoom.
			const k = this.distance / 800;
			// Rough lat-correction so panning east at high latitudes
			// doesn't smear the map.
			const cosLat = Math.cos(this.centerLat * Math.PI / 180) || 1;
			this.centerLon -= dx * 0.0001 * k / cosLat;
			this.centerLat += dy * 0.0001 * k;
		});

		canvas.addEventListener('pointerup', (e) => {
			if (!this.active) return;
			const wasPanning = this._panning;
			this._panning = false;
			canvas.style.cursor = '';
			try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
			// Treat a small-or-no-drag pointerup as a click → designate.
			if (wasPanning && this._clickBudget > 0 && e.button === 0) {
				this._handleClickAt(e.clientX, e.clientY);
			}
		});

		canvas.addEventListener('wheel', (e) => {
			if (!this.active) return;
			e.preventDefault();
			// Multiplicative zoom feels right; bound so we don't get
			// stuck at ground level or out at orbit.
			const factor = Math.exp(e.deltaY * 0.0015);
			this.distance = Math.max(2000, Math.min(2_000_000, this.distance * factor));
		}, { passive: false });
	}

	_handleClickAt(x, y) {
		const ray = this.viewer.camera.getPickRay(new Cesium.Cartesian2(x, y));
		if (!ray) return;
		const cart = this.viewer.scene.globe.pick(ray, this.viewer.scene);
		if (!cart) return;

		const carto = Cesium.Cartographic.fromCartesian(cart);
		const lon = Cesium.Math.toDegrees(carto.longitude);
		const lat = Cesium.Math.toDegrees(carto.latitude);
		// Set immediately with the rough height; refine asynchronously.
		// Same pattern setupSpawnPicker already uses — the player
		// shouldn't see "designating..." latency on the click.
		const roughAlt = Math.max(0, carto.height || 0);
		setDesignationFromMap(lon, lat, roughAlt);

		Cesium.sampleTerrainMostDetailed(this.viewer.terrainProvider, [carto])
			.then(([p]) => {
				const preciseAlt = Math.max(0, p.height || 0);
				// Only refine if the player hasn't picked a different
				// point in the meantime — otherwise we'd stomp the
				// newer designation with stale terrain data.
				if (Math.abs(playerDesignation.lon - lon) < 1e-6 &&
				    Math.abs(playerDesignation.lat - lat) < 1e-6) {
					setDesignationFromMap(lon, lat, preciseAlt);
				}
			})
			.catch(() => {});
	}
}

function _hasDesignation() {
	return playerDesignation.mode !== 'SLEW' &&
		(playerDesignation.lat !== 0 || playerDesignation.lon !== 0);
}
