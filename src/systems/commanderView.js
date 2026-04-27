import * as Cesium from 'cesium';
import { allDatalinks } from './teamDatalink.js';
import { isRadiating } from './sensorSystem.js';

// ============================================================================
// Commander ("god's eye") view.
//
// Detaches the Cesium camera from the player aircraft and lifts it above the
// battlefield for an RTS-style overview. Units (player, NPCs, in-flight
// missiles) get icon+label entities; if trails are enabled, each unit's
// recent position history is drawn as a polyline. Trails keep recording even
// while the view is inactive so switching in mid-engagement shows meaningful
// history — this is the hook for evaluating AI behavior later.
//
// Camera conventions here (own):
//   tilt = 0  ⇒ straight top-down     (Cesium pitch = −90°)
//   tilt = 89 ⇒ nearly horizontal     (Cesium pitch ≈  −1°)
//   rotation (deg) = compass heading of the viewer — 0 = north up
// ============================================================================

const TRAIL_INTERVAL    = 0.25;  // seconds between samples per unit
const TRAIL_DURATION    = 120;   // seconds of history kept
const TRAIL_MAX_POINTS  = Math.ceil(TRAIL_DURATION / TRAIL_INTERVAL) + 2;
// Age-based alpha fade: split each trail into this many contiguous chunks
// along the sample timeline and give each chunk its own alpha. Cesium's
// entity polyline only supports a single material color per line, so we
// fake a continuous fade with a handful of stepped segments. 6 chunks is
// enough that the "steps" don't read as banding at normal zoom levels and
// the entity count stays modest (≈ 6× units + missiles).
const TRAIL_FADE_CHUNKS = 6;

// Color table. NPCs belong to one of a few hostile factions that fight each
// other as well as the player, and each faction gets its own color on the
// map so the engagement is visually readable when there are multiple
// aircraft and missiles in the air.
//   Player           → cyan                  (friendly airframe)
//   Hostile-red      → red                   (faction 1 airframe)
//   Hostile-blue     → orange                (faction 2 airframe — "orange"
//                                              rather than literal blue so
//                                              it doesn't clash with player
//                                              cyan)
//   Friendly msl     → amber                 (our outgoing AMRAAMs/AIM-9s)
//   Hostile msl      → magenta               (bright, distinct from both
//                                              faction colors; draws the eye
//                                              to an inbound threat)
const COLOR_PLAYER           = Cesium.Color.fromCssColorString('#00eaff');
const COLOR_FACTIONS = {
	'hostile-red':  Cesium.Color.fromCssColorString('#ff4040'),
	'hostile-blue': Cesium.Color.fromCssColorString('#ffa040'),
	// Friendly non-player units (wingman, AWACS, tanker, future
	// ground forces). Cyan family but distinct from the player's
	// marker so the eye can still pick the player out at a glance.
	'friendly':     Cesium.Color.fromCssColorString('#40d8ff'),
};
const COLOR_NPC_FALLBACK     = Cesium.Color.fromCssColorString('#ff4040');
const COLOR_MISSILE_FRIENDLY = Cesium.Color.fromCssColorString('#ffc040');
const COLOR_MISSILE_HOSTILE  = Cesium.Color.fromCssColorString('#ff40e0');
const COLOR_TRAIL_PLAYER             = COLOR_PLAYER.withAlpha(0.6);
const COLOR_TRAIL_MISSILE_FRIENDLY   = COLOR_MISSILE_FRIENDLY.withAlpha(0.75);
const COLOR_TRAIL_MISSILE_HOSTILE    = COLOR_MISSILE_HOSTILE.withAlpha(0.85);

// Helper: colour + trail colour for an NPC unit, from its team tag.
function colorsForNpc(unit) {
	const base = COLOR_FACTIONS[unit.team] || COLOR_NPC_FALLBACK;
	return { marker: base, trail: base.withAlpha(0.55) };
}

// Helper: was this pointer event aimed at a DOM overlay that sits on top
// of the Cesium canvas (tooltip, tooltip button, legend panel, etc.) —
// as opposed to the map itself?
//
// The commander's pointerdown / pointerup listeners live on `window` in
// capture phase so they can beat Cesium's own canvas handlers. That
// positioning also means they see every pointer event in the page,
// including clicks on our DOM tooltips. If they treat those as map
// clicks they'd either start a pan-drag on the tooltip or, worse, call
// _handleClickAt which picks the canvas underneath the button and
// closes the tooltip — leaving the button's own click handler with no
// DOM element to fire on. So when the original target is inside a
// tooltip we bail out of the map-input path entirely.
function _isOverlayTarget(target) {
	if (!target || !target.closest) return false;
	return !!target.closest('.commander-tooltip');
}
// Colors used when a unit (or a trail segment) is behind terrain. Polylines
// use depthFailMaterial for this natively; points/labels need a manual
// per-frame occlusion test because Cesium's point graphic has no
// depth-fail color.
const COLOR_OCCLUDED_MARKER = Cesium.Color.fromCssColorString('#707070').withAlpha(0.55);
const COLOR_OCCLUDED_LABEL  = Cesium.Color.fromCssColorString('#a0a0a0');
const COLOR_TRAIL_OCCLUDED  = Cesium.Color.fromCssColorString('#707070').withAlpha(0.22);

export class CommanderView {
	constructor(viewer) {
		this.viewer = viewer;
		this.active = false;
		this.trailsEnabled = true;

		// Cesium polylines need this flag on for depth-fail materials to
		// apply against terrain. Without it, primitives skip depth-testing
		// the globe and trails just render over every mountain as if
		// unobstructed. No visible downside for us (marker points still
		// override depth via disableDepthTestDistance).
		if (viewer && viewer.scene && viewer.scene.globe) {
			viewer.scene.globe.depthTestAgainstTerrain = true;
		}

		// View state — updated by pan/zoom/tilt inputs and written to the
		// Cesium camera each frame while active.
		//
		//   centerLon/centerLat: the look-at point on the ground (alt 0).
		//   distance:            slant distance from camera to look-at point.
		//   tilt:                camera elevation above the look-at point.
		//                        0 = straight overhead, 89 = nearly horizontal.
		//   rotation:            map bearing (0 = north-up).
		//
		// Camera position is computed as look-at + distance · back_vector(tilt,
		// rotation). This means tilting orbits the camera around the look-at
		// point instead of tipping the camera in place; and zooming moves the
		// camera along its view direction, so zoom works the same whether the
		// view is top-down or tilted.
		this.centerLon = 0;
		this.centerLat = 0;
		this.distance  = 25000;
		this.tilt      = 25;
		this.rotation  = 0;

		// Unit tracking — one entity per unit for its marker+label, one
		// separate entity per unit for its trail polyline. Keyed on a stable
		// id so NPCs and missiles don't reuse slots across spawns.
		this._markers   = new Map(); // id → Cesium.Entity (point + label)
		this._trails    = new Map(); // id → { samples: [{lon,lat,alt,t}], entity }
		// Radar debug overlay — FOV wedges, track lines, lock lines. Off by
		// default, toggled with R while the map is open. Entities here are
		// rebuilt from scratch each frame (cheap at the unit counts we have)
		// rather than diffed, which keeps the logic readable.
		this.debugRadarEnabled    = false;
		this.debugDatalinkEnabled = false;
		// Show every team's mesh by default when datalink debug is on
		// (hostile teams in their own colors, friendly in cyan). Flip
		// to false to see only the player's team.
		this.datalinkShowAllTeams = true;
		this._debugEntities       = [];
		this._trailTick = 0;
		// Accumulated simulation time (sum of dt from update()). Used for
		// trail ageing instead of wall-clock time so pausing the game
		// doesn't retroactively expire samples once update() resumes.
		this._gameTime  = 0;

		// Input drag state. _dragDist accumulates pointer movement while a
		// button is held; a small value at mouseup means we treat it as a
		// click (for unit selection) instead of a drag (pan/tilt).
		this._dragMode  = null;  // 'pan' | 'tilt' | null
		this._dragDist  = 0;
		this._lastX     = 0;
		this._lastY     = 0;
		this._downX     = 0;
		this._downY     = 0;

		// Click-to-inspect tooltips. Map from marker id to { element, meta }.
		// Multiple tooltips may be open simultaneously (e.g. to compare two
		// aircraft's speed), hence a map rather than a single selection.
		this._tooltips = new Map();

		this._bindInputs();
		this._createLegend();
		this._createControlsPanel();
		this._createPausedBadge();
	}

	// Floating "PAUSED" badge shown when sim-time is frozen while the map
	// is open (Space keybind). Kept minimal — the map itself signals state
	// via frozen trails / markers; the badge is just a confirm cue.
	_createPausedBadge() {
		if (document.getElementById('commander-paused-badge')) return;
		const el = document.createElement('div');
		el.id = 'commander-paused-badge';
		el.textContent = 'PAUSED';
		el.style.cssText = `
			position: fixed;
			top: 16px; left: 50%; transform: translateX(-50%);
			padding: 6px 18px;
			border: 1px solid rgba(255, 200, 0, 0.75);
			background: rgba(40, 25, 0, 0.75);
			color: #ffd040;
			font-family: 'AceCombat', monospace;
			font-size: 14px; letter-spacing: 3px;
			text-shadow: 0 0 6px rgba(255, 200, 0, 0.8);
			z-index: 27;
			display: none;
			pointer-events: none;
		`;
		document.body.appendChild(el);
		this._pausedBadge = el;
	}

	setPausedBadge(on) {
		if (this._pausedBadge) this._pausedBadge.style.display = on ? 'block' : 'none';
	}

	// Small color-key panel so the player can tell what the map colours
	// mean at a glance. Shown only while commander view is active.
	_createLegend() {
		if (document.getElementById('commander-legend')) return;
		const p = document.createElement('div');
		p.id = 'commander-legend';
		p.style.cssText = `
			position: fixed;
			left: 16px; bottom: 16px;
			padding: 8px 12px;
			border: 1px solid rgba(0, 255, 0, 0.4);
			background: rgba(0, 15, 0, 0.7);
			color: #0f0;
			font-family: 'AceCombat', monospace;
			font-size: 11px;
			line-height: 1.5;
			letter-spacing: 1px;
			text-shadow: 0 0 5px rgba(0, 255, 0, 0.6);
			z-index: 25;
			pointer-events: none;
			display: none;
		`;
		const row = (color, label) =>
			`<div style="display:flex; align-items:center; gap:8px;">
				<span style="
					display:inline-block; width:10px; height:10px; border-radius:50%;
					background:${color}; box-shadow:0 0 6px ${color};
				"></span>${label}
			</div>`;
		p.innerHTML =
			`<div style="font-weight:bold; margin-bottom:4px;">MAP LEGEND</div>` +
			row('#00eaff', 'Player')          +
			row('#ff4040', 'Hostile — Red')   +
			row('#ffa040', 'Hostile — Blue')  +
			row('#ffc040', 'Friendly missile') +
			row('#ff40e0', 'Hostile missile') +
			`<div style="margin-top:6px; opacity:0.65; font-size:10px;">
				drag pan • right-drag tilt • wheel zoom
			</div>`;
		document.body.appendChild(p);
		this._legendPanel = p;
	}

	// Clickable overlay toggles + hotkey reference. Shown only while
	// commander view is active; hidden otherwise. Separate from the legend
	// so colour-key and controls don't fight for the same corner.
	_createControlsPanel() {
		if (document.getElementById('commander-controls')) return;
		const p = document.createElement('div');
		p.id = 'commander-controls';
		p.style.cssText = `
			position: fixed;
			left: 16px; top: 16px;
			padding: 10px 12px;
			border: 1px solid rgba(0, 255, 0, 0.4);
			background: rgba(0, 15, 0, 0.75);
			color: #0f0;
			font-family: 'AceCombat', monospace;
			font-size: 11px;
			line-height: 1.4;
			letter-spacing: 1px;
			text-shadow: 0 0 5px rgba(0, 255, 0, 0.6);
			z-index: 26;
			display: none;
			min-width: 180px;
		`;
		p.innerHTML = `
			<div style="font-weight:bold; margin-bottom:6px;">MAP CONTROLS</div>
			<div id="cmdr-ctrl-toggles" style="display:flex; flex-direction:column; gap:4px;"></div>
			<div style="margin-top:8px; padding-top:6px; border-top:1px solid rgba(0,255,0,0.2); opacity:0.6; font-size:10px;">
				HOTKEYS<br>
				<span style="opacity:0.85">M</span> toggle map<br>
				<span style="opacity:0.85">SPACE</span> pause / resume<br>
				<span style="opacity:0.85">T</span> trails<br>
				<span style="opacity:0.85">R</span> radar debug<br>
				<span style="opacity:0.85">D</span> datalink debug
			</div>
		`;
		document.body.appendChild(p);
		this._controlsPanel = p;

		// Build one toggle row per overlay. Each row is a clickable pill
		// that reflects the current state; clicking mirrors the keybind.
		// New toggles: add a definition below, no other plumbing needed.
		this._controlDefs = [
			{
				id: 'trails', label: 'Trails', hotkey: 'T',
				get: () => this.trailsEnabled,
				set: (v) => {
					this.trailsEnabled = v;
					this._setAllTrailsVisible(v && this.active);
					this.viewer.scene.requestRender();
				},
			},
			{
				id: 'radar', label: 'Radar Debug', hotkey: 'R',
				get: () => this.debugRadarEnabled,
				set: (v) => {
					this.debugRadarEnabled = v;
					if (!v) this._clearDebugEntities();
					this.viewer.scene.requestRender();
				},
			},
			{
				id: 'datalink', label: 'Datalink Debug', hotkey: 'D',
				get: () => this.debugDatalinkEnabled,
				set: (v) => {
					this.debugDatalinkEnabled = v;
					if (!v) this._clearDebugEntities();
					this.viewer.scene.requestRender();
					console.log('[CMDR] datalink debug', v ? 'ON' : 'OFF');
				},
			},
		];

		const host = p.querySelector('#cmdr-ctrl-toggles');
		this._controlRows = new Map();
		for (const def of this._controlDefs) {
			const row = document.createElement('button');
			row.type = 'button';
			row.className = 'clickable-ui';
			row.style.cssText = `
				display: flex; align-items: center; justify-content: space-between;
				padding: 4px 8px;
				background: transparent;
				border: 1px solid rgba(0, 255, 0, 0.25);
				color: #0f0;
				font-family: inherit; font-size: 11px; letter-spacing: 1px;
				cursor: pointer;
				transition: background 0.15s, border-color 0.15s;
			`;
			row.onmouseenter = () => { row.style.background = 'rgba(0,255,0,0.08)'; };
			row.onmouseleave = () => { row.style.background = 'transparent'; };
			row.onclick = () => def.set(!def.get());
			host.appendChild(row);
			this._controlRows.set(def.id, row);
		}
		this._refreshControlRows();
	}

	// Update the visual state of each toggle pill to match the underlying
	// flag. Called on every frame (cheap — just DOM text + classList) so
	// keybind-driven changes stay in sync with the UI without extra
	// event plumbing.
	_refreshControlRows() {
		if (!this._controlRows || !this._controlDefs) return;
		for (const def of this._controlDefs) {
			const row = this._controlRows.get(def.id);
			if (!row) continue;
			const on = !!def.get();
			row.innerHTML =
				`<span>${def.label}</span>` +
				`<span style="
					padding:1px 6px;
					border:1px solid ${on ? '#0f0' : 'rgba(0,255,0,0.3)'};
					color:${on ? '#0f0' : 'rgba(0,255,0,0.5)'};
					background:${on ? 'rgba(0,255,0,0.15)' : 'transparent'};
					min-width: 26px; text-align:center;
				">${on ? 'ON' : 'OFF'}</span>`;
			row.style.borderColor = on ? 'rgba(0,255,0,0.6)' : 'rgba(0,255,0,0.25)';
		}
	}

	// ---- Public API ---------------------------------------------------------

	setActive(active, initialCenter = null) {
		if (active === this.active) return;
		this.active = active;

		if (active) {
			if (initialCenter) {
				this.centerLon = initialCenter.lon;
				this.centerLat = initialCenter.lat;
				// Start far enough that the aircraft and any nearby units
				// are visible at default tilt. Clamped so we don't snap
				// absurdly close at high altitudes.
				this.distance = Math.max(15000, (initialCenter.alt || 0) + 10000);
			}
		}
		// Toggle visibility on all pre-existing entities.
		this._setAllMarkersVisible(active);
		this._setAllTrailsVisible(active && this.trailsEnabled);
		if (!active) this._clearAllTooltips();
		if (!active) this._clearDebugEntities();
		if (!active) this.setPausedBadge(false);
		if (this._legendPanel) this._legendPanel.style.display = active ? 'block' : 'none';
		if (this._controlsPanel) this._controlsPanel.style.display = active ? 'block' : 'none';
		if (active) this._refreshControlRows();
		this.viewer.scene.requestRender();
	}

	// Called every frame from main.js. `units` is the NPC array; `missiles`
	// is the weaponSystem.projectiles array. Player state is a plain
	// {lon, lat, alt, heading, speed} object.
	update(dt, playerState, units, missiles) {
		// Cache so the 'C' key handler can center on the aircraft at the
		// moment the mode is toggled on.
		this._lastPlayerState = playerState;

		// Advance sim-time. Pauses don't tick update(), so this stays frozen
		// across pause/unpause — exactly what we want for trail ageing.
		this._gameTime += dt;

		// Sample trails even when inactive — so entering the mode shows real
		// pre-switch history. Costs a handful of floats per unit per tick.
		this._sampleTrails(dt, playerState, units, missiles);

		if (!this.active) return;

		this._applyCamera();
		this._syncMarkers(playerState, units, missiles);
		this._syncTrails();
		this._syncDebugOverlays(playerState, units, missiles);
		this._refreshControlRows();
		this._updateTooltips();
		this.viewer.scene.requestRender();
	}

	// ---- Input --------------------------------------------------------------

	_bindInputs() {
		window.addEventListener('keydown', (e) => {
			if (e.repeat) return;
			const k = e.key.toLowerCase();
			if (k === 'm') {
				// M for Map / commander view. Toggle, centering on the latest
				// known player position so the first frame is useful.
				this.setActive(!this.active, this._lastPlayerState || null);
			} else if (k === 't' && this.active) {
				this.trailsEnabled = !this.trailsEnabled;
				this._setAllTrailsVisible(this.trailsEnabled);
				this.viewer.scene.requestRender();
			} else if (k === 'r' && this.active) {
				// R toggles the radar debug overlay: FOV wedges, track
				// lines, and lock lines. Map-only for now; a future pass
				// could add a HUD version for the cockpit.
				this.debugRadarEnabled = !this.debugRadarEnabled;
				if (!this.debugRadarEnabled) this._clearDebugEntities();
				this.viewer.scene.requestRender();
			} else if (k === 'd' && this.active) {
				// D toggles the datalink overlay: thin lines from each
				// team member that's publishing a radar track to the
				// position of the tracked target, colored per team.
				// Reveals the fused picture each side has.
				this.debugDatalinkEnabled = !this.debugDatalinkEnabled;
				if (!this.debugDatalinkEnabled) this._clearDebugEntities();
				this.viewer.scene.requestRender();
			}
		});

		// Pointer events (not mouse events). Cesium's own input handler also
		// listens on pointer events and `preventDefault`s them, which — via
		// the browser's "pointer events cancel mouse compat" rule — kills
		// the equivalent mousedown before our listener would ever see it.
		// Using pointerdown/pointermove/pointerup at window-capture puts us
		// at the same tier Cesium is at, ahead of its canvas handlers.
		window.addEventListener('pointerdown', (e) => {
			if (!this.active) return;
			// Let pointer events on DOM overlays (tooltip buttons like the
			// "VIEW" spectator button) pass straight through to the DOM.
			// If we preventDefault on pointerdown here, the browser cancels
			// the synthetic click that would otherwise fire on mouse-up,
			// and our button listener never runs.
			if (_isOverlayTarget(e.target)) return;
			if (e.button === 0)      this._dragMode = 'pan';
			else if (e.button === 2) this._dragMode = 'tilt';
			else return;
			this._lastX = e.clientX;
			this._lastY = e.clientY;
			this._downX = e.clientX;
			this._downY = e.clientY;
			this._dragDist = 0;
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

			if (this._dragMode === 'pan') {
				// Grab-and-drag: the look-at point moves opposite to the cursor
				// in world space so the ground visually follows the cursor.
				//
				// Derivation: at bearing h, screen_right → ground direction
				// (cos h, -sin h) in (east, north); screen_up → (sin h, cos h).
				// A drag (dx, dy) in screen pixels therefore moves the cursor
				// across the ground by:
				//     east_cursor  =  dx·cos(h) - dy·sin(h)
				//     north_cursor = -dx·sin(h) - dy·cos(h)
				// Look-at moves the negation of that.
				const mpp = this.distance * 0.0015;
				const rotRad = Cesium.Math.toRadians(this.rotation);
				const cos = Math.cos(rotRad), sin = Math.sin(rotRad);
				const eastMeters  = (-dx * cos + dy * sin) * mpp;
				const northMeters = ( dx * sin + dy * cos) * mpp;
				const latRad = Cesium.Math.toRadians(this.centerLat);
				this.centerLat += northMeters / 111320;
				this.centerLon += eastMeters  / (111320 * Math.max(0.1, Math.cos(latRad)));
			} else if (this._dragMode === 'tilt') {
				this.rotation = (this.rotation + dx * 0.3) % 360;
				this.tilt     = Math.max(0, Math.min(89, this.tilt - dy * 0.3));
			}
			this.viewer.scene.requestRender();
		}, true);

		window.addEventListener('pointerup', (e) => {
			if (!this._dragMode) return;
			// Short travel ⇒ treat the press as a click, not a drag.
			// But skip the Cesium hit-test entirely if the click landed
			// on a DOM overlay (tooltip button) — otherwise scene.pick()
			// at the button's pixel coordinates usually hits empty
			// canvas next to the marker and _clearAllTooltips() would
			// yank the button out of the DOM before its own click
			// listener can fire.
			if (this._dragDist < 6 && e.button === 0 && this.active &&
				!_isOverlayTarget(e.target)) {
				this._handleClickAt(e.clientX, e.clientY);
			}
			this._dragMode = null;
			if (this.active) e.stopPropagation();
		}, true);

		window.addEventListener('wheel', (e) => {
			if (!this.active) return;
			// Exponential zoom on the orbital distance. Because the camera
			// orbits the look-at point (rather than sitting directly above
			// it), this scales the visible ground area equally at any tilt,
			// not only top-down.
			const factor = e.deltaY > 0 ? 1.25 : 1 / 1.25;
			this.distance = Math.max(500, Math.min(2000000, this.distance * factor));
			e.preventDefault();
			this.viewer.scene.requestRender();
		}, { passive: false, capture: true });

		// Right-click normally shows a context menu; while commander is active
		// we use right-drag for tilt, so swallow it.
		window.addEventListener('contextmenu', (e) => {
			if (this.active) e.preventDefault();
		});
	}

	// ---- Camera -------------------------------------------------------------

	_applyCamera() {
		// Camera is placed on an orbital sphere around the look-at point on
		// the ground. The "back" direction (from look-at to camera) in the
		// local ENU tangent frame is built from (tilt, rotation):
		//
		//   tilt=0  (top-down):    back = ( 0, 0, 1)     straight up
		//   tilt=90 (horizon):     back = ( 0,-1, 0)     due south (rot 0)
		//   any rotation r spins the horizontal component around the vertical
		//
		// The camera's orientation then just points from camera back toward
		// the look-at: heading = rotation, pitch = tilt - 90 (so pitch=-90 at
		// top-down, horizon-ish at tilt=89).
		const tiltRad = Cesium.Math.toRadians(this.tilt);
		const rotRad  = Cesium.Math.toRadians(this.rotation);
		const backENU = new Cesium.Cartesian3(
			-Math.sin(rotRad) * Math.sin(tiltRad),
			-Math.cos(rotRad) * Math.sin(tiltRad),
			 Math.cos(tiltRad),
		);

		const lookAt   = Cesium.Cartesian3.fromDegrees(this.centerLon, this.centerLat, 0);
		const enu      = Cesium.Transforms.eastNorthUpToFixedFrame(lookAt);
		const backECEF = Cesium.Matrix4.multiplyByPointAsVector(enu, backENU, new Cesium.Cartesian3());
		const camPos   = Cesium.Cartesian3.add(
			lookAt,
			Cesium.Cartesian3.multiplyByScalar(backECEF, this.distance, new Cesium.Cartesian3()),
			new Cesium.Cartesian3(),
		);

		this.viewer.camera.setView({
			destination: camPos,
			orientation: {
				heading: Cesium.Math.toRadians(this.rotation),
				pitch:   Cesium.Math.toRadians(this.tilt - 90),
				roll:    0,
			},
		});
	}

	// ---- Marker entities ---------------------------------------------------

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

		// Update one marker: position it, color based on terrain occlusion,
		// and tag the entity with a meta pointer so scene.pick can look up
		// the underlying game unit on click.
		const updateOne = (id, u, color, meta) => {
			const e = this._markers.get(id);
			if (!e) return;
			const pos = Cesium.Cartesian3.fromDegrees(u.lon, u.lat, u.alt);
			e.position = pos;
			const occluded = this._isPositionOccluded(pos);
			e.point.color      = occluded ? COLOR_OCCLUDED_MARKER : color;
			e.label.fillColor  = occluded ? COLOR_OCCLUDED_LABEL  : Cesium.Color.WHITE;
			e.show = true;
			// Include the marker id so the click handler can key tooltips on
			// it. Without this every tooltip keys on `undefined`, which is
			// why clicks appeared to toggle the same slot no matter what
			// you clicked on.
			e.__commanderMeta = { id, ...meta };
			seen.add(id);
		};

		if (playerState) {
			this._ensureMarker('__player', COLOR_PLAYER, 'PLAYER');
			updateOne('__player', playerState, COLOR_PLAYER,
				{ kind: 'player', ref: playerState });
		}
		if (units) {
			for (const u of units) {
				if (!u || u.destroyed) continue;
				const id = `npc-${u.id || u.name}`;
				const { marker: color } = colorsForNpc(u);
				this._ensureMarker(id, color, u.name || 'BOGEY');
				updateOne(id, u, color, { kind: 'npc', ref: u });
			}
		}
		if (missiles) {
			// Color-coded by team: the player's own outgoing missiles stay
			// amber, hostile inbound-threat missiles show in red. Easy to
			// tell at a glance who fired what when the map has a dozen
			// tracks on it.
			const playerTeam = (playerState && playerState.team) || 'friendly';
			for (const m of missiles) {
				if (!m || !m.active) continue;
				const id = `m-${m.id || (m.id = `m${seen.size}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)}`;
				const typeTag = m.type || 'MSL';
				const phaseTag = (typeof m.boostRemaining === 'number' && m.boostRemaining > 0) ? ' BOOST' : '';
				const isHostile = (m.team || 'friendly') !== playerTeam;
				const color = isHostile ? COLOR_MISSILE_HOSTILE : COLOR_MISSILE_FRIENDLY;
				const entity = this._ensureMarker(id, color, typeTag + phaseTag);
				if (entity && entity.label) entity.label.text = typeTag + phaseTag;
				if (entity && entity.point)  entity.point.color = color;
				updateOne(id, m, color, { kind: 'missile', ref: m });
			}
		}

		// Hide any marker whose unit is gone this frame.
		for (const [id, ent] of this._markers) {
			if (!seen.has(id)) ent.show = false;
		}
	}

	// ---- Click-to-inspect tooltips ----------------------------------------

	// Pick the entity under the pointer. Left-click on a marker toggles its
	// tooltip. Left-click on empty space closes every open tooltip.
	_handleClickAt(x, y) {
		const picked = this.viewer.scene.pick(new Cesium.Cartesian2(x, y));
		if (picked && picked.id && picked.id.__commanderMeta) {
			const meta = picked.id.__commanderMeta;
			if (this._tooltips.has(meta.id)) {
				this._tooltips.get(meta.id).element.remove();
				this._tooltips.delete(meta.id);
			} else {
				const el = this._createTooltipElement(meta.kind);

				// Structure of a tooltip element:
				//   root (pointer-events: none)
				//   ├── contentEl (innerHTML rewritten every frame by
				//   │              _updateTooltips — holds the telemetry
				//   │              rows that update as the unit moves)
				//   └── buttonEl  (persistent; kept across frames so the
				//                  browser can actually synthesize a
				//                  click on it. If the button were
				//                  recreated between pointerdown and
				//                  pointerup — which was happening when
				//                  the whole tooltip innerHTML got
				//                  rewritten every frame — the browser
				//                  would fail to synthesize the click.)
				const contentEl = document.createElement('div');
				el.appendChild(contentEl);

				let buttonEl = null;
				if (meta.kind !== 'player') {
					buttonEl = document.createElement('button');
					buttonEl.setAttribute('data-action', 'spectate');
					buttonEl.textContent = 'VIEW';
					buttonEl.style.cssText = `
						pointer-events: auto;
						cursor: pointer;
						margin-top: 4px;
						background: rgba(0,0,0,0.6);
						border: 1px solid currentColor;
						color: inherit;
						font: inherit;
						padding: 1px 8px;
						letter-spacing: 1px;
						text-shadow: inherit;
					`;
					// Per-button click listener — now that the button is
					// persistent it survives across frames and can own
					// its own handler instead of needing delegation.
					buttonEl.addEventListener('click', (e) => {
						e.preventDefault();
						e.stopPropagation();
						window.dispatchEvent(new CustomEvent('spectator-request', {
							detail: { unit: meta.ref, kind: meta.kind },
						}));
					});
					el.appendChild(buttonEl);
				}

				this._tooltips.set(meta.id, { element: el, contentEl, buttonEl, meta });
			}
		} else {
			this._clearAllTooltips();
		}
	}

	_clearAllTooltips() {
		for (const [, tt] of this._tooltips) tt.element.remove();
		this._tooltips.clear();
	}

	// One small floating panel per pinned unit. Border/text colored by kind
	// so three open tooltips stay visually distinct at a glance.
	_createTooltipElement(kind) {
		let border = 'rgba(0, 255, 0, 0.55)';
		let color  = '#0f0';
		if (kind === 'player')  { border = 'rgba(0, 234, 255, 0.65)'; color = '#00eaff'; }
		else if (kind === 'npc') { border = 'rgba(255, 64, 64, 0.65)'; color = '#ff4040'; }
		else if (kind === 'missile') { border = 'rgba(255, 192, 64, 0.7)'; color = '#ffc040'; }
		const el = document.createElement('div');
		el.className = 'commander-tooltip';
		el.style.cssText = `
			position: fixed;
			padding: 5px 9px;
			border: 1px solid ${border};
			background: rgba(0, 12, 0, 0.82);
			color: ${color};
			font-family: 'AceCombat', monospace;
			font-size: 11px;
			line-height: 1.45;
			letter-spacing: 1px;
			text-shadow: 0 0 5px ${border};
			z-index: 30;
			pointer-events: none;
			white-space: nowrap;
		`;
		document.body.appendChild(el);
		return el;
	}

	// Per-frame: move each tooltip next to its marker's screen position,
	// refresh its contents from the unit's current state, and clean up any
	// whose unit is gone.
	_updateTooltips() {
		if (this._tooltips.size === 0) return;
		const scene = this.viewer.scene;
		const camera = scene.camera;
		const transformFunc = Cesium.SceneTransforms.worldToWindowCoordinates ||
			Cesium.SceneTransforms.wgs84ToWindowCoordinates;

		for (const [id, tt] of this._tooltips) {
			const ent = this._markers.get(id);
			const ref = tt.meta.ref;
			const alive = ref && (tt.meta.kind === 'missile' ? ref.active : !ref.destroyed);
			if (!ent || !alive) {
				tt.element.remove();
				this._tooltips.delete(id);
				continue;
			}
			const pos = Cesium.Cartesian3.fromDegrees(ref.lon, ref.lat, ref.alt);
			// Reject when the marker is behind the camera (depth < 0); the
			// Cesium projection is undefined for those, and tooltips would
			// otherwise jump to the opposite side of the screen.
			const toPos = Cesium.Cartesian3.subtract(pos, camera.positionWC, new Cesium.Cartesian3());
			if (Cesium.Cartesian3.dot(toPos, camera.direction) <= 0) {
				tt.element.style.display = 'none';
				continue;
			}
			const win = transformFunc ? transformFunc(scene, pos) : null;
			if (!win) { tt.element.style.display = 'none'; continue; }

			tt.element.style.display = 'block';
			tt.element.style.left = `${Math.round(win.x) + 14}px`;
			tt.element.style.top  = `${Math.round(win.y) - 8}px`;
			// Only rewrite the content div, not the entire tooltip —
			// otherwise the persistent VIEW button would get recreated
			// every frame and the browser would fail to synthesize a
			// click event on it (pointerdown target ≠ pointerup target
			// when the element has been replaced in between).
			if (tt.contentEl) {
				tt.contentEl.innerHTML = this._buildTooltipHtml(tt.meta);
			} else {
				tt.element.innerHTML = this._buildTooltipHtml(tt.meta);
			}
		}
	}

	_buildTooltipHtml(meta) {
		const { kind, ref } = meta;
		const altFt = Math.max(0, Math.round(ref.alt * 3.28084)).toLocaleString();
		const row = (lbl, val) =>
			`<div><span style="display:inline-block; width:36px; opacity:0.65">${lbl}</span>${val}</div>`;
		const dir = (d) => `${Math.round(((d % 360) + 360) % 360).toString().padStart(3, '0')}°`;
		// NOTE: the "VIEW" spectator button is NOT injected here — it's
		// a persistent DOM element appended once in _handleClickAt. This
		// HTML is replaced every frame by _updateTooltips; rebuilding
		// the button inline each frame broke click synthesis because
		// pointerdown / pointerup ended up on different element
		// instances.

		if (kind === 'missile') {
			const typeTag = ref.type || 'MSL';
			const phase   = ref.boostRemaining > 0 ? `BOOST ${ref.boostRemaining.toFixed(1)}s` : 'COAST';
			// Guidance mode set by the AIM-120 each frame:
			//   DL  = midcourse on fresh datalink from the launcher
			//   DR  = dead reckoning (datalink stale / launcher lost track)
			//   ACT = pitbull, missile's own radar has the target
			//   MAD = maddog, pitbull failed to find a target
			// Fall back to the older 'LOST' / 'ACTIVE' labels for any legacy
			// missile (Missile base class, IR AIM-9) that doesn't emit mode.
			const dbg     = ref.debug || {};
			// Prefer the missile's self-reported mode (set per-frame
			// by AIM-120 and HARM). Fall back to the legacy AAM-only
			// flags for any seeker class that doesn't emit one — but
			// only if it actually has those flags, else show '—' so
			// HARMs and other non-AAM munitions don't get mislabeled
			// as 'DL' midcourse.
			let mode;
			if (dbg.mode) mode = dbg.mode;
			else if (ref.lostLock) mode = 'LOST';
			else if (ref.pitbullFired || ref.seekerActive) mode = 'ACT';
			else if (ref.type === 'AIM-120') mode = 'DL';
			else mode = '—';
			const rng     = typeof dbg.rangeToTarget === 'number'
				? `${(dbg.rangeToTarget / 1000).toFixed(2)} km` : '—';
			const tgt     = dbg.targetName || (ref.target && ref.target.name) || '—';
			return (
				`<div style="font-weight:bold; margin-bottom:3px;">${typeTag} ${phase}</div>` +
				row('TGT',  tgt) + row('RNG', rng) +
				row('SPD',  `${Math.round(ref.speed)} m/s`) +
				row('ALT',  `${altFt} ft`) +
				row('MODE', mode) +
				row('TTL',  `${ref.life.toFixed(1)} s`)
			);
		}
		const name = kind === 'player' ? 'PLAYER' : (ref.name || 'BOGEY');
		const spd  = typeof ref.speed   === 'number' ? `${Math.round(ref.speed)} m/s` : '—';
		const hdg  = typeof ref.heading === 'number' ? dir(ref.heading) : '—';
		const pit  = typeof ref.pitch   === 'number' ? `${ref.pitch.toFixed(1)}°` : '—';
		let html =
			`<div style="font-weight:bold; margin-bottom:3px;">${name}</div>` +
			row('ALT', `${altFt} ft`) +
			row('SPD', spd) +
			row('HDG', hdg) +
			row('PIT', pit);
		if (kind === 'player') {
			const alphaDeg = (ref.alpha || 0) * 180 / Math.PI;
			html += row('AOA', `${alphaDeg.toFixed(1)}°`);
			html += row('G',   `${(ref.loadFactor || 0).toFixed(1)}`);
			html += row('THR', `${Math.round((ref.throttle || 0) * 100)}%${ref.isBoosting ? ' AB' : ''}`);
		} else if (kind === 'npc' && ref.pilot && ref.pilot.command) {
			// Debugging cue: which AI behavior currently owns this NPC?
			// "MissileEvasion" tells you evasion actually fired, not just that
			// it *should*. Flare/chaff counts tick down as defenses expire.
			const beh = ref.pilot.command.activeBehaviorName || '—';
			html += row('AI',  beh);
			const cm = ref.pilot.subsystems && ref.pilot.subsystems.countermeasures;
			if (cm) html += row('CM',  `${cm.flareCount}F / ${cm.chaffCount}C`);
		}
		return html;
	}

	// Cheap terrain-occlusion test for a world-space point: cast a ray from
	// the camera toward the point, ask the globe for its intersection, and
	// compare distances. Cesium's scene.globe.pick uses the current LOD
	// terrain tile — good enough for visual correctness and much faster
	// than sampleTerrainMostDetailed.
	_isPositionOccluded(pos) {
		const cam = this.viewer.camera;
		if (!this._scratchDir) this._scratchDir = new Cesium.Cartesian3();
		const dir = Cesium.Cartesian3.subtract(pos, cam.positionWC, this._scratchDir);
		const distUnit = Cesium.Cartesian3.magnitude(dir);
		if (distUnit < 1) return false;
		Cesium.Cartesian3.divideByScalar(dir, distUnit, dir);
		if (!this._scratchRay) this._scratchRay = new Cesium.Ray();
		Cesium.Cartesian3.clone(cam.positionWC, this._scratchRay.origin);
		Cesium.Cartesian3.clone(dir, this._scratchRay.direction);
		const hit = this.viewer.scene.globe.pick(this._scratchRay, this.viewer.scene);
		if (!hit) return false;
		const distTerrain = Cesium.Cartesian3.distance(cam.positionWC, hit);
		// 5 m fudge so a unit sitting exactly on terrain isn't flagged.
		return distTerrain < distUnit - 5;
	}

	_setAllMarkersVisible(show) {
		for (const [, e] of this._markers) e.show = show;
	}

	// ---- Trail entities -----------------------------------------------------

	_sampleTrails(dt, playerState, units, missiles) {
		this._trailTick += dt;
		if (this._trailTick < TRAIL_INTERVAL) return;
		this._trailTick = 0;

		// Sim-time, not wall-clock: a real-time pause must not age trails.
		const now = this._gameTime;

		const sample = (id, u, color) => {
			if (!u) return;
			let rec = this._trails.get(id);
			if (!rec) {
				rec = { samples: [], entity: null, color, dirty: true };
				this._trails.set(id, rec);
			}
			// Cache the Cartesian3 once at sample time. Hot loop in
			// _syncTrails used to call Cesium.Cartesian3.fromDegrees for
			// every sample × every fade chunk × every trail × every
			// frame — measurable stutter source after complex fights.
			rec.samples.push({
				lon: u.lon, lat: u.lat, alt: u.alt, t: now,
				cart: Cesium.Cartesian3.fromDegrees(u.lon, u.lat, u.alt),
			});
			rec.dirty = true;
			while (rec.samples.length > TRAIL_MAX_POINTS) rec.samples.shift();
			while (rec.samples.length > 0 && (now - rec.samples[0].t) > TRAIL_DURATION) {
				rec.samples.shift();
			}
		};

		if (playerState) sample('__player', playerState, COLOR_TRAIL_PLAYER);
		if (units) for (const u of units) {
			if (!u || u.destroyed) continue;
			const { trail } = colorsForNpc(u);
			sample(`npc-${u.id || u.name}`, u, trail);
		}
		if (missiles) {
			const playerTeam = (playerState && playerState.team) || 'friendly';
			for (const m of missiles) {
				if (!m || !m.active) continue;
				const isHostile = (m.team || 'friendly') !== playerTeam;
				const trailColor = isHostile ? COLOR_TRAIL_MISSILE_HOSTILE : COLOR_TRAIL_MISSILE_FRIENDLY;
				sample(`m-${m.id}`, m, trailColor);
			}
		}

		// Age out dead trails. A unit (NPC or missile) that's no longer
		// in the live list won't get new samples, so the existing
		// samples drift past TRAIL_DURATION. Once the rec is empty,
		// drop the whole record + its 6 polyline entities — otherwise
		// every BVR session leaves dozens of stale recs being walked
		// every frame in _syncTrails.
		for (const [id, rec] of this._trails) {
			while (rec.samples.length > 0 && (now - rec.samples[0].t) > TRAIL_DURATION) {
				rec.samples.shift();
				rec.dirty = true;
			}
			if (rec.samples.length === 0) {
				if (rec.entities) {
					for (const e of rec.entities) this.viewer.entities.remove(e);
				}
				this._trails.delete(id);
			}
		}
	}

	_syncTrails() {
		for (const [id, rec] of this._trails) {
			if (!rec.entities) rec.entities = [];

			if (rec.samples.length < 2) {
				for (const e of rec.entities) e.show = false;
				continue;
			}

			// Skip the bucket rebuild when nothing has changed since the
			// last sync. Trails sample at 4 Hz but render at 60 Hz —
			// without this short-circuit we'd rebuild ~15× more often
			// than needed. The CallbackProperty below still hands the
			// same array reference to Cesium each frame, which keeps
			// the polyline tessellation cached.
			if (rec.dirty) {
				// Partition the (oldest → newest) sample list into
				// TRAIL_FADE_CHUNKS contiguous slices. Each slice renders
				// as its own polyline entity with a different alpha;
				// chunk 0 is oldest (most faded), chunk N-1 is newest
				// (fully opaque). Adjacent slices share a boundary
				// vertex so the visible line stays continuous at the
				// step boundaries.
				//
				// We pull the pre-computed Cartesian3 directly from each
				// sample (cached in _sampleTrails) — no fromDegrees in
				// the hot path.
				const n = rec.samples.length;
				const bucketCaches = new Array(TRAIL_FADE_CHUNKS);
				for (let b = 0; b < TRAIL_FADE_CHUNKS; b++) {
					const startIdx = Math.floor((b * n) / TRAIL_FADE_CHUNKS);
					const endIdx   = Math.floor(((b + 1) * n) / TRAIL_FADE_CHUNKS);
					const stop = Math.min(n, endIdx + 1);
					const out = new Array(stop - startIdx);
					for (let i = startIdx, k = 0; i < stop; i++, k++) {
						out[k] = rec.samples[i].cart;
					}
					bucketCaches[b] = out;
				}
				rec.positionsCache = bucketCaches;
				rec.dirty = false;
			}

			// Build the per-chunk entities once, then just show them.
			// Cesium's CallbackProperty re-reads positions every frame so
			// incremental sample appends appear without touching the entity.
			if (rec.entities.length === 0) {
				const baseAlpha = (rec.color && typeof rec.color.alpha === 'number') ? rec.color.alpha : 1;
				const occAlpha  = (COLOR_TRAIL_OCCLUDED.alpha || 0.22);
				for (let b = 0; b < TRAIL_FADE_CHUNKS; b++) {
					// Newest chunk gets the full color alpha; oldest fades
					// toward ~15% of that. Linear ramp in chunk-index space
					// is close enough to linear-in-age for this many chunks.
					const ageFrac = (b + 0.5) / TRAIL_FADE_CHUNKS; // 0 → oldest, 1 → newest
					const alphaScale = 0.15 + 0.85 * ageFrac;
					const chunkIdx = b; // capture for closures
					const chunkColor = rec.color.withAlpha(baseAlpha * alphaScale);
					const chunkOccl  = COLOR_TRAIL_OCCLUDED.withAlpha(occAlpha * alphaScale);
					const ent = this.viewer.entities.add({
						polyline: {
							positions: new Cesium.CallbackProperty(
								() => rec.positionsCache && rec.positionsCache[chunkIdx] || [],
								false,
							),
							width: 1.8,
							material: chunkColor,
							depthFailMaterial: new Cesium.ColorMaterialProperty(chunkOccl),
							arcType: Cesium.ArcType.NONE,
						},
						show: this.active && this.trailsEnabled,
					});
					rec.entities.push(ent);
				}
			} else {
				for (const e of rec.entities) e.show = this.active && this.trailsEnabled;
			}
		}
	}

	_setAllTrailsVisible(show) {
		for (const [, rec] of this._trails) {
			if (rec.entities) for (const e of rec.entities) e.show = show;
		}
	}

	// ---- Radar debug overlay -----------------------------------------------
	//
	// Rebuild every frame: (1) a FOV wedge per radar-equipped unit drawn at
	// the unit's altitude, (2) a thin amber line for every active radar
	// contact, (3) a thick red line for every active AIM-120 seeker lock.
	// Diffing would be possible but would add bookkeeping for ~few dozen
	// short-lived entities; the rebuild is cheap enough.

	_clearDebugEntities() {
		if (!this._debugEntities) return;
		for (const e of this._debugEntities) this.viewer.entities.remove(e);
		this._debugEntities.length = 0;
		// Debug filled surfaces use the scene.primitives layer (Primitive
		// API with CoplanarPolygonGeometry for arbitrary 3D triangles),
		// because the entity API only offers ellipsoid-clamped polygons.
		// Rebuilt alongside the wireframe each frame.
		if (this._debugPrimitives) {
			for (const p of this._debugPrimitives) this.viewer.scene.primitives.remove(p);
			this._debugPrimitives.length = 0;
		} else {
			this._debugPrimitives = [];
		}
		// Reset the one-shot log gate so toggling off and on again re-logs.
		if (!this.debugRadarEnabled)    this._debugLoggedOnce       = false;
		if (!this.debugDatalinkEnabled) this._datalinkLoggedOnce    = false;
	}

	// Add a filled triangle in free 3D space, colored translucent. Used
	// to give the radar wireframes a visible volume (four triangles per
	// pyramid face, sharing the apex). CoplanarPolygonGeometry is the
	// right primitive here — regular PolygonGeometry would extrude or
	// clamp to the globe.
	_addDebugTriangle(a, b, c, color) {
		const positions = [
			Cesium.Cartesian3.fromDegrees(a.lon, a.lat, a.alt),
			Cesium.Cartesian3.fromDegrees(b.lon, b.lat, b.alt),
			Cesium.Cartesian3.fromDegrees(c.lon, c.lat, c.alt),
		];
		const geom = Cesium.CoplanarPolygonGeometry.fromPositions({ positions });
		const prim = this.viewer.scene.primitives.add(new Cesium.Primitive({
			geometryInstances: new Cesium.GeometryInstance({
				geometry: geom,
				attributes: {
					color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
				},
			}),
			appearance: new Cesium.PerInstanceColorAppearance({
				flat: true,
				translucent: true,
				closed: false,
			}),
			asynchronous: false,
		}));
		this._debugPrimitives.push(prim);
		return prim;
	}

	// Add an arbitrary triangulated mesh in free 3D space as a single
	// Primitive. `positions` is an array of {lon, lat, alt} (converted
	// to ECEF here), `indices` is a flat Uint16/number array of
	// triangle indices into that position list. Used by _drawRadarCone
	// to batch 32+ cone-wall triangles into one primitive instead of
	// creating one Primitive per triangle (which is expensive to
	// compile each frame).
	_addDebugMesh(positions, indices, color) {
		const flat = new Float64Array(positions.length * 3);
		for (let i = 0; i < positions.length; i++) {
			const p = positions[i];
			const c = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.alt);
			flat[i * 3 + 0] = c.x;
			flat[i * 3 + 1] = c.y;
			flat[i * 3 + 2] = c.z;
		}
		const geom = new Cesium.Geometry({
			attributes: {
				position: new Cesium.GeometryAttribute({
					componentDatatype: Cesium.ComponentDatatype.DOUBLE,
					componentsPerAttribute: 3,
					values: flat,
				}),
			},
			indices: new Uint32Array(indices),
			primitiveType: Cesium.PrimitiveType.TRIANGLES,
			boundingSphere: Cesium.BoundingSphere.fromVertices(flat),
		});
		const prim = this.viewer.scene.primitives.add(new Cesium.Primitive({
			geometryInstances: new Cesium.GeometryInstance({
				geometry: geom,
				attributes: {
					color: Cesium.ColorGeometryInstanceAttribute.fromColor(color),
				},
			}),
			appearance: new Cesium.PerInstanceColorAppearance({
				flat: true,
				translucent: true,
				closed: false,
			}),
			asynchronous: false,
		}));
		this._debugPrimitives.push(prim);
		return prim;
	}

	// Offset a position by (headingDeg, rangeM) in a local ENU frame anchored
	// at obs. Good enough over the scales we care about (<150 km).
	_offsetByBearing(obs, headingDeg, rangeM) {
		const latRad = obs.lat * Math.PI / 180;
		const h = headingDeg * Math.PI / 180;
		const dE = rangeM * Math.sin(h);
		const dN = rangeM * Math.cos(h);
		return {
			lon: obs.lon + dE / (111320 * Math.cos(latRad)),
			lat: obs.lat + dN / 111320,
			alt: obs.alt,
		};
	}

	// Project a unit ray in the observer's body frame (forward/right/up in
	// radians off nose) out to `range` metres, and return the endpoint as
	// a geodetic lon/lat/alt triple. Uses the observer's heading+pitch to
	// orient the body frame; roll is ignored (radar gimbals don't care
	// about aircraft roll for FOV geometry).
	//
	// Body convention here:
	//   +y = nose forward
	//   +x = right wing
	//   +z = up out of canopy
	_offsetBodyFrame(obs, azOff, elOff, rangeM) {
		const h = (obs.heading || 0) * Math.PI / 180;
		const p = (obs.pitch   || 0) * Math.PI / 180;

		// Body frame expressed in ENU axes.
		const fwd   = { x: Math.sin(h) * Math.cos(p), y: Math.cos(h) * Math.cos(p), z: Math.sin(p) };
		const right = { x: Math.cos(h),               y: -Math.sin(h),              z: 0 };
		const up    = {
			x: right.y * fwd.z - right.z * fwd.y,
			y: right.z * fwd.x - right.x * fwd.z,
			z: right.x * fwd.y - right.y * fwd.x,
		};

		// Ray direction in body frame as tan offsets off the forward axis.
		const tx = Math.tan(azOff);
		const tz = Math.tan(elOff);
		// Combine: fwd + tx*right + tz*up, then normalise and scale.
		const dx = fwd.x + tx * right.x + tz * up.x;
		const dy = fwd.y + tx * right.y + tz * up.y;
		const dz = fwd.z + tx * right.z + tz * up.z;
		const len = Math.hypot(dx, dy, dz) || 1;
		const k = rangeM / len;
		const dE = dx * k, dN = dy * k, dU = dz * k;

		const latRad = obs.lat * Math.PI / 180;
		return {
			lon: obs.lon + dE / (111320 * Math.cos(latRad)),
			lat: obs.lat + dN / 111320,
			alt: obs.alt + dU,
		};
	}

	_addDebugPolyline(positions, color, width) {
		// Match the trail polyline recipe byte-for-byte, since that one
		// is known to render: CallbackProperty positions + arcType NONE
		// + depthFailMaterial matching the front material. Going via
		// CallbackProperty forces Cesium to re-sample the position
		// source each frame, which also sidesteps a batch-builder
		// quirk where short-lived entities with ConstantProperty
		// positions sometimes fail to land on the GPU.
		const cartPositions = positions.map(p =>
			Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.alt),
		);
		const ent = this.viewer.entities.add({
			polyline: {
				positions: new Cesium.CallbackProperty(() => cartPositions, false),
				width,
				material: new Cesium.ColorMaterialProperty(color),
				depthFailMaterial: new Cesium.ColorMaterialProperty(color),
				arcType: Cesium.ArcType.NONE,
				show: true,
			},
		});
		this._debugEntities.push(ent);
		return ent;
	}

	// Debug fallback: if polyline rendering turns out to be broken in
	// some scene states, sprinkle pixel-space points along a line
	// instead. They're billboarded by Cesium and bypass depth testing
	// via `disableDepthTestDistance`, so they're guaranteed to render
	// the way the red sanity-check dots do.
	_addDebugDottedLine(positions, color, size = 6) {
		for (let i = 0; i < positions.length; i++) {
			const p = positions[i];
			this._debugEntities.push(this.viewer.entities.add({
				position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.alt),
				point: {
					pixelSize: size,
					color,
					disableDepthTestDistance: Number.POSITIVE_INFINITY,
				},
			}));
		}
	}

	_drawRadarCone(obs, radar, color) {
		const rawH = radar.fovH || 0;
		const rawV = radar.fovV || rawH;
		const range = radar.nominalRange || 0;
		if (rawH <= 0 || range <= 0) return;

		// If the FOV is effectively omnidirectional (rotodome / 360° radar
		// like AWACS), the wireframe pyramid math degenerates — tan(π/2)
		// blows up and the "far face" collapses. Render as a horizontal
		// ring at `range` distance instead, which matches the mental
		// model of "detected anything inside this radius."
		const OMNI_THRESHOLD = Math.PI * 0.6; // ~108°
		if (rawH >= OMNI_THRESHOLD) {
			const apex = { lon: obs.lon, lat: obs.lat, alt: obs.alt };
			const RING_SAMPLES = 36;
			const ring = [];
			for (let i = 0; i <= RING_SAMPLES; i++) {
				const h = (i / RING_SAMPLES) * 360;
				ring.push(this._offsetByBearing(obs, h, range));
			}
			this._addDebugPolyline(ring, color, 1.2);
			// Draw four spokes to anchor the ring to the aircraft.
			for (const hdg of [0, 90, 180, 270]) {
				this._addDebugPolyline(
					[apex, this._offsetByBearing(obs, hdg, range)],
					color, 0.8,
				);
			}
			return;
		}

		// Clamp to 80° for render sanity when a radar has a very wide
		// but not-quite-omni cone (HPA missile seekers, future SAMs).
		const fovH = Math.min(rawH, Math.PI * 80 / 180);
		const fovV = Math.min(rawV, Math.PI * 80 / 180);

		// Tessellated SPHERICAL SECTOR — the correct geometry for a
		// radar detection volume. Every point is within some range R
		// of the observer, within the FOV cone. That's an ice-cream
		// scoop, not a flat-ended cone:
		//
		//    apex (observer)
		//      │╲     ╱│
		//      │ ╲   ╱ │    straight cone walls
		//      │  ╲ ╱  │
		//      │   X   │
		//      │  ╱ ╲  │
		//      │ ╱   ╲ │
		//      │╱     ╲│    spherical cap (all at range R)
		//       ╰─────╯
		//
		// Mesh composition (all one Primitive):
		//   1. Apex vertex.
		//   2. Cap center vertex (nose-forward at range R).
		//   3. CAP_RINGS concentric rings inside the cap, each with
		//      SEGMENTS longitude samples. Ring n lives at normalized
		//      radius φ = n/CAP_RINGS from the center; angular offset
		//      (az, el) = φ · (fovH·cos θ, fovV·sin θ). All cap points
		//      sit at distance R from apex (not at fixed XY offset),
		//      so the cap curves away exactly like a sphere segment.
		//   4. Triangulation:
		//        - Inner fan: center → ring1[i] → ring1[i+1]
		//        - Between rings: two triangles per quad
		//        - Side walls: apex → rim[i] → rim[i+1]
		const apex    = { lon: obs.lon, lat: obs.lat, alt: obs.alt };
		const center  = this._offsetBodyFrame(obs, 0, 0, range);
		const SEGMENTS  = 32;   // longitude samples around the axis
		const CAP_RINGS = 4;    // latitude rings inside the cap

		const meshPositions = [apex, center];
		const APEX_IDX   = 0;
		const CENTER_IDX = 1;
		const RING_BASE  = 2;   // first ring vertex index

		// Generate rings 1..CAP_RINGS. Each ring's point k is placed
		// at range R along the ray (az = φ·fovH·cos θ, el = φ·fovV·sin θ)
		// — same length from apex for every cap point, so the whole
		// surface sits on a sphere of radius R.
		for (let r = 1; r <= CAP_RINGS; r++) {
			const phi = r / CAP_RINGS;
			for (let s = 0; s < SEGMENTS; s++) {
				const theta = (s / SEGMENTS) * 2 * Math.PI;
				const az = phi * fovH * Math.cos(theta);
				const el = phi * fovV * Math.sin(theta);
				meshPositions.push(this._offsetBodyFrame(obs, az, el, range));
			}
		}
		const ringIdx = (r, s) => RING_BASE + (r - 1) * SEGMENTS + (s % SEGMENTS);

		const meshIndices = [];
		// Inner fan: center to first ring.
		for (let s = 0; s < SEGMENTS; s++) {
			meshIndices.push(CENTER_IDX, ringIdx(1, s), ringIdx(1, s + 1));
		}
		// Stitch between adjacent rings.
		for (let r = 1; r < CAP_RINGS; r++) {
			for (let s = 0; s < SEGMENTS; s++) {
				const a = ringIdx(r,     s);
				const b = ringIdx(r,     s + 1);
				const c = ringIdx(r + 1, s);
				const d = ringIdx(r + 1, s + 1);
				meshIndices.push(a, c, d);
				meshIndices.push(a, d, b);
			}
		}
		// Side walls: apex to outermost ring (the rim).
		for (let s = 0; s < SEGMENTS; s++) {
			meshIndices.push(APEX_IDX, ringIdx(CAP_RINGS, s + 1), ringIdx(CAP_RINGS, s));
		}

		const fillAlpha = color.alpha != null ? color.alpha * 0.15 : 0.12;
		const fill = color.withAlpha(fillAlpha);
		this._addDebugMesh(meshPositions, meshIndices, fill);

		// Wireframe: closed rim loop + 4 spokes from apex through the
		// cardinal rim points so the cone's 3D orientation is legible
		// even when the fill alpha is faint. Also add one meridian
		// arc (apex → center via an arbitrary ring chain) to emphasise
		// that the cap curves — you see the belly of the scoop.
		const rim = [];
		for (let s = 0; s < SEGMENTS; s++) {
			rim.push(meshPositions[ringIdx(CAP_RINGS, s)]);
		}
		this._addDebugPolyline([...rim, rim[0]], color, 1);
		const spokePick = [0, SEGMENTS / 4, SEGMENTS / 2, (3 * SEGMENTS) / 4];
		for (const idx of spokePick) {
			this._addDebugPolyline([apex, rim[idx]], color, 1);
		}
	}

	_drawLine(a, b, color, width) {
		// Sample 10 intermediate points between the endpoints so the
		// dotted-line fallback is dense enough to read as a line, not
		// just two isolated dots.
		const SAMPLES = 10;
		const pts = [];
		for (let i = 0; i <= SAMPLES; i++) {
			const t = i / SAMPLES;
			pts.push({
				lon: a.lon + (b.lon - a.lon) * t,
				lat: a.lat + (b.lat - a.lat) * t,
				alt: a.alt + (b.alt - a.alt) * t,
			});
		}
		this._addDebugPolyline(pts, color, width);
	}

	// Orchestrates all debug overlays in one place — clears the shared
	// entity pool once, then lets each individual overlay sync method
	// append to it. Previously each overlay cleared independently, so
	// whichever ran second wiped the first's work.
	_syncDebugOverlays(playerState, units, missiles) {
		this._clearDebugEntities();
		if (this.debugRadarEnabled)    this._syncRadarDebug(playerState, units, missiles);
		if (this.debugDatalinkEnabled) this._syncDatalinkDebug(playerState, units);
	}

	_syncRadarDebug(playerState, units, missiles) {
		// Clear is handled by _syncDebugOverlays; this method only adds.

		// Scope filter from pinned tooltips. If any unit is selected
		// (tooltip open), we only draw its radar artifacts — so the
		// overlay isn't a wall of overlapping cones every time it's on.
		// With nothing selected, show everything (back to the global
		// view). Selection key is the game-object reference stored on
		// the marker meta; missiles and planes both flow through it.
		const selected = new Set();
		for (const [, tt] of (this._tooltips || new Map())) {
			const ref = tt.meta && tt.meta.ref;
			if (ref) selected.add(ref);
		}
		const hasFilter = selected.size > 0;

		const diag = { cones: 0, tracks: 0, locks: 0 };
		const _shouldLog = !this._debugLoggedOnce;
		if (_shouldLog) this._debugLoggedOnce = true;

		// Unit-scoped color so you can tell whose cone is whose when
		// multiple overlap. Use the same team-driven palette as markers.
		const coneColorFor = (u) => {
			if (u === playerState) return COLOR_PLAYER.withAlpha(0.7);
			const base = (u && COLOR_FACTIONS[u.team]) || COLOR_NPC_FALLBACK;
			return base.withAlpha(0.6);
		};
		const trackColor = Cesium.Color.fromCssColorString('#ffd040').withAlpha(0.95);
		const lockColor  = Cesium.Color.fromCssColorString('#ff3060').withAlpha(1.0);

		// Plane radars: cones + per-contact track lines. Only drawn for
		// selected units when a filter is active.
		const observers = [playerState, ...(units || [])];
		for (const obs of observers) {
			if (!obs || obs.destroyed || obs.active === false) continue;
			if (hasFilter && !selected.has(obs)) continue;
			const r = obs.sensors && obs.sensors.radar;
			if (!isRadiating(obs)) continue;

			this._drawRadarCone(obs, r, coneColorFor(obs));
			diag.cones++;

			if (obs.contacts) {
				for (const [, c] of obs.contacts) {
					if (!c || !c.radar || !c.target) continue;
					const t = c.target;
					if (t.destroyed || t.active === false) continue;
					this._drawLine(obs, t, trackColor, 1.0);
					diag.tracks++;
				}
			}
		}

		// Missile seeker locks. A missile's visuals are shown if the
		// missile itself, its launcher, or its target is selected — that
		// way clicking either endpoint of an engagement pulls in the
		// relevant lock line and seeker cone.
		if (missiles) {
			for (const m of missiles) {
				if (!m || !m.active) continue;
				if (m.type !== 'AIM-120') continue;
				if (!m.pitbullFired || m.maddog) continue;
				const t = m.target;
				if (!t || t.destroyed || t.active === false) continue;
				if (hasFilter &&
					!selected.has(m) &&
					!selected.has(m.launcher) &&
					!selected.has(t)) continue;

				this._drawLine(m, t, lockColor, 1.8);
				diag.locks++;
				if (m.constructor && m.constructor.SEEKER_RADAR_DEBUG) {
					this._drawRadarCone(m, m.constructor.SEEKER_RADAR_DEBUG, lockColor.withAlpha(0.55));
					diag.cones++;
				}
			}
		}

		if (_shouldLog) {
			console.log('[CMDR debug] drew',
				'cones=' + diag.cones,
				'tracks=' + diag.tracks,
				'locks=' + diag.locks,
				'filter=' + (hasFilter ? `${selected.size} selected` : 'all'),
				'entities=' + this._debugEntities.length);
		}
	}

	// ---- Datalink debug overlay -------------------------------------------
	//
	// For each team, walks the team's shared datalink.contacts map and
	// draws a thin line from the publishing unit (who painted the track
	// on its own radar) to the track's target position. Lines are
	// colored by team, so at a glance you can see:
	//
	//   - How far the datalink picture reaches for each side (AWACS-
	//     supported teams reach much further than others).
	//   - Who on a team is actually *contributing* tracks versus just
	//     consuming the fused picture.
	//   - How many teammates have independent radar paints on a given
	//     target (multiple lines converging on the same endpoint).
	//
	// Contact selection: we draw every entry in `datalink.allContacts()`
	// that has a live source whose position we can resolve. Contacts
	// without a source reference (e.g. stale after the source died)
	// are skipped rather than anchoring lines at the source's death
	// coordinates.

	_syncDatalinkDebug(playerState, units) {
		// Draws the COMMUNICATION MESH on the player's team datalink:
		// edges between every pair of live team-mates who are on the
		// net. This is the "who is sharing with whom" view — NOT the
		// publisher → target view (radar debug already shows that).
		// Real Link 16 is a mesh, every participant can receive from
		// every other, so we draw all pairwise edges within a team.
		//
		// Inclusion rule: any alive unit with a `team` tag is treated
		// as a datalink participant. In the future when we differentiate
		// "comms-equipped vs comms-silent" platforms, this filter
		// becomes a `unit.datalink === true` check.
		const teamColor = (team) => {
			if (team === 'friendly') return COLOR_PLAYER;
			return COLOR_FACTIONS[team] || COLOR_NPC_FALLBACK;
		};

		// By default the overlay shows only the player's own team's
		// mesh. Set `commanderView.datalinkShowAllTeams = true` from
		// the console to reveal hostile-team meshes too.
		const showAll = !!this.datalinkShowAllTeams;
		const playerTeam = playerState && playerState.team;

		// Bucket live units by team. Player is added explicitly so a
		// solo human + AWACS still produces an edge.
		const byTeam = new Map();
		const push = (u) => {
			if (!u || u.destroyed || u.active === false) return;
			if (!u.team) return;
			if (!byTeam.has(u.team)) byTeam.set(u.team, []);
			byTeam.get(u.team).push(u);
		};
		push(playerState);
		if (units) for (const u of units) push(u);

		let drew = 0;
		for (const [teamId, members] of byTeam) {
			if (!showAll && teamId !== playerTeam) continue;
			if (members.length < 2) continue;
			const color = teamColor(teamId).withAlpha(0.6);
			// Pairwise edges. For N members the graph is N·(N−1)/2
			// edges — small for the team sizes we have (3–5 members).
			for (let i = 0; i < members.length; i++) {
				for (let j = i + 1; j < members.length; j++) {
					const a = members[i], b = members[j];
					this._addDebugPolyline(
						[
							{ lon: a.lon, lat: a.lat, alt: a.alt ?? 0 },
							{ lon: b.lon, lat: b.lat, alt: b.alt ?? 0 },
						],
						color, 1.0,
					);
					drew++;
				}
			}
		}

		if (drew > 0 && !this._datalinkLoggedOnce) {
			this._datalinkLoggedOnce = true;
			console.log('[CMDR datalink debug] drew', drew, 'mesh edge(s) for',
				showAll ? 'all teams' : `team ${playerTeam}`);
		}
	}
}
