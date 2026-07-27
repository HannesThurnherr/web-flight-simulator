import * as Cesium from 'cesium';
import { allDatalinks } from './teamDatalink.js';
import { targetLabel } from './eventLog.js';
import { describeAirWing } from './carrierOps.js';
import { TIME_SCALES, getTimeScale, setTimeScale, stepTimeScale, resetTimeScale } from './timeScale.js';
import { isRadiating, explainRadarRejection } from './sensorSystem.js';
import {
	MAP_COLORS, teamColor, categoryForUnit, categoryForMissile,
	categoryRotates, isGroundUnit, iconUri, iconSvgMarkup,
} from './mapIcons.js';

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
// Cesium.Color objects are derived from the single shared hex palette in
// mapIcons.js so the billboards, trails, labels and DOM legend can never
// drift out of sync.
const COLOR_PLAYER           = Cesium.Color.fromCssColorString(MAP_COLORS.player);
const COLOR_FACTIONS = {
	'hostile-red':  Cesium.Color.fromCssColorString(MAP_COLORS['hostile-red']),
	'hostile-blue': Cesium.Color.fromCssColorString(MAP_COLORS['hostile-blue']),
	// Friendly non-player units (wingman, AWACS, tanker, future
	// ground forces). Cyan family but distinct from the player's
	// marker so the eye can still pick the player out at a glance.
	'friendly':     Cesium.Color.fromCssColorString(MAP_COLORS.friendly),
};
const COLOR_NPC_FALLBACK     = Cesium.Color.fromCssColorString(MAP_COLORS['hostile-red']);
const COLOR_TRAIL_PLAYER             = COLOR_PLAYER.withAlpha(0.6);

// Helper: colour + trail colour for an NPC unit, from its team tag.
function colorsForNpc(unit) {
	const base = COLOR_FACTIONS[unit.team] || COLOR_NPC_FALLBACK;
	return { marker: base, trail: base.withAlpha(0.55) };
}

// Missile trail colour by the LAUNCHING team — not by friend/foe relative to
// the player. In an NPC-vs-NPC fight that's the difference between two
// readable sides and an indistinguishable magenta/amber mush. Cached as
// Cesium.Color objects so the 4 Hz sampler never re-parses a CSS string.
// Slightly brighter alpha than aircraft trails (0.7 vs 0.55) so live weapons
// still pop against the airframe tracks that share their colour.
const _missileTrailCache = new Map();
function missileTrailColor(team) {
	const key = team || 'friendly';
	let c = _missileTrailCache.get(key);
	if (!c) {
		c = Cesium.Color.fromCssColorString(teamColor(key)).withAlpha(0.7);
		_missileTrailCache.set(key, c);
	}
	return c;
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
	// Existing tooltip + the scenario editor's right-side panel.
	// Without the editor selector here, the editor's dropdowns and
	// SAVE/EXIT buttons get their pointerdown swallowed by the
	// commander view's pan/tilt handler — which calls preventDefault
	// and kills the synthetic click that would otherwise reach the
	// <select> / <button>. Treating the editor panel as an overlay
	// lets the DOM see those events.
	return !!(target.closest('.commander-tooltip')
		|| target.closest('#scenario-editor-panel'));
}
// Colors used when a unit (or a trail segment) is behind terrain. Polylines
// use depthFailMaterial for this natively; points/labels need a manual
// per-frame occlusion test because Cesium's point graphic has no
// depth-fail color.
const COLOR_OCCLUDED_MARKER = Cesium.Color.fromCssColorString('#707070').withAlpha(0.55);
const COLOR_OCCLUDED_LABEL  = Cesium.Color.fromCssColorString('#a0a0a0');
const COLOR_TRAIL_OCCLUDED  = Cesium.Color.fromCssColorString('#707070').withAlpha(0.22);
// Billboard tint applied when an icon is behind terrain — a muted grey
// multiply that reads as "occluded" without losing the silhouette.
const TINT_VISIBLE  = Cesium.Color.WHITE;
const TINT_OCCLUDED = Cesium.Color.fromCssColorString(MAP_COLORS.occluded).withAlpha(0.85);
// Label chip background (translucent dark glass).
const LABEL_BG = new Cesium.Color(0.02, 0.05, 0.09, 0.6);
// On-screen pixel size per glyph category. Big-wing platforms read larger;
// munitions stay small so a saturated strike doesn't bury the airframes.
const ICON_SIZE = {
	player: 34, fighter: 30, stealth: 30, ew_jet: 30, awacs: 36, bomber: 36,
	drone: 31, sam: 29, aaa: 29, radar: 29, jammer: 29, laser: 29, command: 29,
	aam: 21, arm: 23, cruise: 25, bomb: 21, sam_msl: 21, dot: 23,
};

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
		this.debugJammerEnabled   = false;
		// Phase 10b — when set, the per-frame _syncMarkers skips
		// the `__player` marker. The editor flips this true while a
		// world-anchored scenario is loaded (player position is
		// irrelevant to a geographically-pinned scenario; showing
		// it makes the user think the spawns are placed relative
		// to it).
		this.suppressPlayerMarker = false;
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
		el.style.cssText = `
			position: fixed;
			top: 16px; left: 50%; transform: translateX(-50%);
			padding: 7px 20px;
			border: 1px solid rgba(255, 190, 60, 0.6);
			border-radius: 7px;
			background: linear-gradient(180deg, rgba(40,28,4,0.86), rgba(26,18,2,0.84));
			box-shadow: 0 6px 22px rgba(0,0,0,0.45), 0 0 16px rgba(255,180,40,0.18);
			backdrop-filter: blur(6px);
			-webkit-backdrop-filter: blur(6px);
			color: #ffce5c;
			font-family: 'AceCombat', monospace;
			font-size: 14px; letter-spacing: 4px;
			text-shadow: 0 0 8px rgba(255, 200, 0, 0.7);
			z-index: 27;
			display: none;
			pointer-events: none;
		`;
		el.textContent = '⏸  PAUSED';
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
			padding: 12px 14px 10px;
			border: 1px solid rgba(120, 170, 210, 0.22);
			border-radius: 9px;
			background: linear-gradient(180deg, rgba(10,18,26,0.9), rgba(6,11,16,0.88));
			box-shadow: 0 8px 28px rgba(0,0,0,0.5);
			backdrop-filter: blur(9px);
			-webkit-backdrop-filter: blur(9px);
			color: #c8d6e2;
			font-family: 'AceCombat', monospace;
			font-size: 10.5px;
			line-height: 1.3;
			letter-spacing: 0.6px;
			z-index: 25;
			pointer-events: none;
			display: none;
			max-width: 330px;
		`;
		const C = MAP_COLORS;
		const item = (cat, hex, label) =>
			`<div style="display:flex; align-items:center; gap:7px; min-width:0;">
				<span style="display:inline-flex; width:19px; height:19px; flex:0 0 19px; align-items:center; justify-content:center;">${iconSvgMarkup(cat, hex, 17)}</span>
				<span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${label}</span>
			</div>`;
		const section = (title, items) =>
			`<div style="margin-top:9px;">
				<div style="font-size:9px; letter-spacing:1.8px; color:#7fa8c4; margin-bottom:5px; border-bottom:1px solid rgba(120,170,210,0.16); padding-bottom:3px;">${title}</div>
				<div style="display:grid; grid-template-columns:1fr 1fr; gap:4px 14px;">${items.join('')}</div>
			</div>`;
		p.innerHTML =
			`<div style="display:flex; align-items:center; gap:8px; font-size:11px; letter-spacing:2px; color:#e3edf4;">
				<span style="width:8px; height:8px; border-radius:50%; background:${C.player}; box-shadow:0 0 9px ${C.player};"></span>TACTICAL DISPLAY
			</div>` +
			section('AFFILIATION', [
				item('fighter', C.player,          'Player / friendly'),
				item('fighter', C['hostile-red'],  'Hostile · Red'),
				item('fighter', C['hostile-blue'], 'Hostile · Blue'),
			]) +
			section('PLATFORMS', [
				item('awacs',  C.friendly,        'AEW&amp;C / tanker'),
				item('bomber', C['hostile-red'],  'Stealth bomber'),
				item('drone',  C.friendly,        'ISR drone'),
				item('ew_jet', C['hostile-blue'], 'EW jet'),
			]) +
			section('SURFACE', [
				item('sam',     C['hostile-red'],  'SAM battery'),
				item('radar',   C['hostile-red'],  'EW radar'),
				item('aaa',     C['hostile-red'],  'AAA / SHORAD'),
				item('jammer',  C['hostile-red'],  'Jammer'),
				item('command', C['hostile-blue'], 'Command post'),
				item('laser',   C.friendly,        'DEW / laser'),
			]) +
			section('WEAPONS', [
				item('aam',     C.neutral, 'A-A missile'),
				item('arm',     C.neutral, 'Anti-radiation'),
				item('cruise',  C.neutral, 'Cruise missile'),
				item('bomb',    C.neutral, 'Guided bomb'),
				item('sam_msl', C.neutral, 'SAM interceptor'),
			]) +
			`<div style="margin-top:6px; opacity:0.55; font-size:9px; letter-spacing:0.4px; color:#7f97aa;">
				weapons take the launching team's colour
			</div>` +
			`<div style="margin-top:8px; opacity:0.5; font-size:9px; letter-spacing:0.8px;">
				drag pan · right-drag tilt · wheel zoom
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
			right: 16px; top: 38px;
			padding: 11px 13px;
			border: 1px solid rgba(120, 170, 210, 0.22);
			border-radius: 9px;
			background: linear-gradient(180deg, rgba(10,18,26,0.9), rgba(6,11,16,0.88));
			box-shadow: 0 8px 28px rgba(0,0,0,0.5);
			backdrop-filter: blur(9px);
			-webkit-backdrop-filter: blur(9px);
			color: #c8d6e2;
			font-family: 'AceCombat', monospace;
			font-size: 11px;
			line-height: 1.4;
			letter-spacing: 0.6px;
			z-index: 26;
			display: none;
			min-width: 196px;
		`;
		const kbd = (k) =>
			`<span style="display:inline-block; min-width:14px; text-align:center; padding:0 4px; margin-right:6px; border:1px solid rgba(120,170,210,0.3); border-radius:3px; color:#9fc4dd; font-size:9px; line-height:14px;">${k}</span>`;
		p.innerHTML = `
			<div style="display:flex; align-items:center; gap:8px; font-size:11px; letter-spacing:2px; color:#e3edf4; margin-bottom:8px;">
				<span style="width:8px; height:8px; border-radius:2px; background:${MAP_COLORS.player}; box-shadow:0 0 8px ${MAP_COLORS.player};"></span>MAP CONTROLS
			</div>
			<div id="cmdr-ctrl-toggles" style="display:flex; flex-direction:column; gap:5px;"></div>
				<div style="margin-top:10px; padding-top:7px; border-top:1px solid rgba(120,170,210,0.16);">
					<div style="letter-spacing:1.6px; color:#7fa8c4; font-size:9.5px; margin-bottom:5px;">TIME SCALE</div>
					<div id="cmdr-timescale" style="display:flex; gap:4px;"></div>
				</div>
			<div style="margin-top:10px; padding-top:7px; border-top:1px solid rgba(120,170,210,0.16); font-size:9.5px; color:#90a8bc;">
				<div style="letter-spacing:1.6px; color:#7fa8c4; margin-bottom:5px;">HOTKEYS</div>
				<div style="display:flex; flex-direction:column; gap:3px;">
					<div>${kbd('M')}toggle map</div>
					<div>${kbd('␣')}pause / resume</div>
					<div>${kbd(',')}${kbd('.')}time scale</div>
					<div>${kbd('T')}trails</div>
					<div>${kbd('R')}radar debug</div>
					<div>${kbd('D')}datalink debug</div>
					<div>${kbd('J')}jammer debug</div>
				</div>
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
			{
				id: 'jammer', label: 'Jammer Debug', hotkey: 'J',
				get: () => this.debugJammerEnabled,
				set: (v) => {
					this.debugJammerEnabled = v;
					if (!v) this._clearDebugEntities();
					this.viewer.scene.requestRender();
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
				padding: 5px 9px;
				background: rgba(255,255,255,0.02);
				border: 1px solid rgba(120, 170, 210, 0.18);
				border-radius: 5px;
				color: #c8d6e2;
				font-family: inherit; font-size: 10.5px; letter-spacing: 0.8px;
				cursor: pointer;
				transition: background 0.15s, border-color 0.15s;
			`;
			row.onmouseenter = () => { row.style.background = 'rgba(80,150,200,0.12)'; };
			row.onmouseleave = () => { row.style.background = 'rgba(255,255,255,0.02)'; };
			row.onclick = () => def.set(!def.get());
			host.appendChild(row);
			this._controlRows.set(def.id, row);
		}

		// Time-scale selector. Sub-stepped in the animate loop, so 8x is eight
		// full sim passes per frame with an unchanged dt — see timeScale.js.
		const tsHost = p.querySelector('#cmdr-timescale');
		this._timeScaleBtns = new Map();
		for (const n of TIME_SCALES) {
			const b = document.createElement('button');
			b.type = 'button';
			b.className = 'clickable-ui';
			b.textContent = `${n}x`;
			b.style.cssText = `
				flex: 1; padding: 4px 0;
				background: rgba(255,255,255,0.02);
				border: 1px solid rgba(120, 170, 210, 0.18);
				border-radius: 5px;
				color: #c8d6e2;
				font-family: inherit; font-size: 10.5px; letter-spacing: 0.8px;
				cursor: pointer;
				transition: background 0.15s, border-color 0.15s, color 0.15s;
			`;
			b.onclick = () => { setTimeScale(n); this._refreshControlRows(); };
			tsHost.appendChild(b);
			this._timeScaleBtns.set(n, b);
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
			const accent = MAP_COLORS.player;
			row.innerHTML =
				`<span>${def.label}</span>` +
				`<span style="
					padding:1px 7px;
					border:1px solid ${on ? accent : 'rgba(120,170,210,0.3)'};
					border-radius:3px;
					color:${on ? '#04121a' : '#8aa6ba'};
					background:${on ? accent : 'transparent'};
					box-shadow:${on ? `0 0 8px ${accent}66` : 'none'};
					font-weight:${on ? '700' : '400'};
					min-width: 28px; text-align:center;
				">${on ? 'ON' : 'OFF'}</span>`;
			row.style.borderColor = on ? 'rgba(39,227,255,0.45)' : 'rgba(120,170,210,0.18)';
		}
		if (this._timeScaleBtns) {
			const cur = getTimeScale();
			const accent = MAP_COLORS.player;
			for (const [n, b] of this._timeScaleBtns) {
				const on = (n === cur);
				b.style.background  = on ? accent : 'rgba(255,255,255,0.02)';
				b.style.color       = on ? '#04121a' : '#8aa6ba';
				b.style.borderColor = on ? 'rgba(39,227,255,0.45)' : 'rgba(120,170,210,0.18)';
				b.style.fontWeight  = on ? '700' : '400';
				b.style.boxShadow   = on ? `0 0 8px ${accent}66` : 'none';
			}
		}
	}

	// ---- Public API ---------------------------------------------------------

	// Let the keybind handler push a hotkey-driven change back into the panel
	// without importing the internals.
	refreshControls() { this._refreshControlRows(); }

	setActive(active, initialCenter = null) {
		if (active === this.active) return;
		// Mutual exclusion with the strike planner — only one alternate
		// camera mode runs at a time. The hook is set externally by
		// simLoop's lazy-init so neither view imports the other.
		if (active && typeof this._closeStrikePlanner === 'function') {
			this._closeStrikePlanner();
		}
		this.active = active;

		// Time acceleration is a map-mode tool. Closing the map always drops
		// back to real time — handing the player back a jet that's flying 8x
		// faster than they left it would be an unpleasant surprise.
		if (!active) resetTimeScale();

		if (active) {
			// Only re-center on the supplied initialCenter (typically the
			// player) on the FIRST open of the session. Subsequent toggles
			// restore wherever the user last left the map — re-centering
			// on the player every time was jarring when the user was
			// inspecting a unit far from their plane.
			if (initialCenter && !this._everActivated) {
				this.centerLon = initialCenter.lon;
				this.centerLat = initialCenter.lat;
				// Start far enough that the aircraft and any nearby units
				// are visible at default tilt. Clamped so we don't snap
				// absurdly close at high altitudes.
				this.distance = Math.max(15000, (initialCenter.alt || 0) + 10000);
			}
			this._everActivated = true;
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
			} else if (k === 'j' && this.active) {
				// J toggles the jammer overlay: translucent cones from
				// each active jammer toward every opposing-team observer
				// it's degrading, plus a burn-through circle showing
				// the radius inside which the radar punches through.
				this.debugJammerEnabled = !this.debugJammerEnabled;
				if (!this.debugJammerEnabled) this._clearDebugEntities();
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
			// Editor mode: if the click landed on a marker that the
			// scenario editor owns (spawn pin or waypoint), let the
			// editor's drag handler take it — don't pan the camera.
			if (e.button === 0 && this._isEditorMarkerAt(e.clientX, e.clientY)) return;
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
				// Pan sensitivity: metres-per-pixel scales linearly with
				// camera distance so close-in panning is precise and
				// zoomed-out panning covers ground fast. 0.00075
				// halved from a previous 0.0015 — that older value
				// felt right with mouse-acceleration off but was 2×
				// too sensitive on a Mac trackpad with the default
				// system pointer-acceleration curve. Tilt rate (below)
				// stays where it was; degrees-per-pixel doesn't have
				// the same trackpad mismatch.
				const mpp = this.distance * 0.00075;
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
			// Exponential zoom on the orbital distance. The factor is
			// derived from deltaY magnitude so a trackpad's tiny per-
			// event deltas (~±4 px) zoom gently while a mouse wheel
			// notch (~±100 px) still gives a snappy step. Coefficient
			// 0.00223 ≈ ln(1.25) / 100 keeps the notch behaviour at
			// ~1.25× per click, matching the prior fixed-factor feel.
			let dy = e.deltaY;
			if (e.deltaMode === 1)      dy *= 33;   // lines → px
			else if (e.deltaMode === 2) dy *= 400;  // pages → px
			const raw = Math.exp(dy * 0.00223);
			const factor = Math.max(0.5, Math.min(2.0, raw));
			// Allow zooming out far enough to see the whole planet —
			// 30 000 km slant distance gets the camera comfortably
			// outside the globe, useful when authoring a scenario in
			// the editor and you need to fly the camera between
			// continents. Lower bound stays at 500 m so you can get
			// in close to a single SAM site.
			this.distance = Math.max(500, Math.min(30000000, this.distance * factor));
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

	// Create a marker entity for `id` if absent. Markers are a type-specific
	// SVG billboard (silhouette = what, colour = whose, screen rotation =
	// heading) plus a compact label chip beneath it. `hex` is the team colour;
	// `category` selects the glyph.
	_ensureMarker(id, hex, category, labelText) {
		let e = this._markers.get(id);
		if (e) return e;
		const size = ICON_SIZE[category] || 28;
		e = this.viewer.entities.add({
			position: Cesium.Cartesian3.fromDegrees(0, 0, 0),
			billboard: {
				image: iconUri(category, hex),
				width: size,
				height: size,
				color: TINT_VISIBLE,
				verticalOrigin: Cesium.VerticalOrigin.CENTER,
				horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
				disableDepthTestDistance: Number.POSITIVE_INFINITY,
				// alignedAxis defaults to ZERO → pure screen-space rotation,
				// exactly right for a top-down symbol pointing down its heading.
			},
			label: {
				text: labelText,
				font: "600 11px ui-monospace, 'SFMono-Regular', Menlo, monospace",
				fillColor: Cesium.Color.fromCssColorString(hex),
				style: Cesium.LabelStyle.FILL,
				showBackground: true,
				backgroundColor: LABEL_BG,
				backgroundPadding: new Cesium.Cartesian2(6, 3),
				pixelOffset: new Cesium.Cartesian2(0, Math.round(size * 0.62) + 4),
				verticalOrigin: Cesium.VerticalOrigin.TOP,
				horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
				disableDepthTestDistance: Number.POSITIVE_INFINITY,
			},
			show: this.active,
		});
		e.__iconCategory = category;
		e.__iconHex = hex;
		e.__iconSize = size;
		this._markers.set(id, e);
		return e;
	}

	_syncMarkers(playerState, units, missiles) {
		const seen = new Set();

		// Units with an open tooltip get a highlight (scaled-up icon + bright
		// label) so the inspected track stands out from the herd.
		const selectedRefs = new Set();
		for (const [, tt] of this._tooltips) {
			if (tt.meta && tt.meta.ref) selectedRefs.add(tt.meta.ref);
		}

		// Screen-space billboard rotation (radians, CCW-positive) that aims an
		// up-pointing glyph down the unit's heading. Heading is clockwise from
		// north; the map's "up" is the camera bearing (this.rotation), also
		// clockwise from north — so the on-screen bearing is (heading −
		// rotation) clockwise, i.e. (rotation − heading) counter-clockwise.
		const headingRot = (u) =>
			Cesium.Math.toRadians(this.rotation - (u.heading || 0));

		// Update one marker: position it, set its glyph/rotation, tint for
		// terrain occlusion + selection, and tag the entity with a meta
		// pointer so scene.pick can recover the game unit on click.
		const updateOne = (id, u, hex, category, rotates, meta) => {
			const e = this._markers.get(id);
			if (!e) return;
			const pos = Cesium.Cartesian3.fromDegrees(u.lon, u.lat, u.alt);
			e.position = pos;
			const occluded = this._isPositionOccluded(pos);
			const selected = selectedRefs.has(u);
			if (e.billboard) {
				e.billboard.image = iconUri(category, hex);
				e.billboard.rotation = rotates ? headingRot(u) : 0;
				e.billboard.color = occluded ? TINT_OCCLUDED : TINT_VISIBLE;
				e.billboard.scale = selected ? 1.32 : 1.0;
			}
			if (e.label) {
				e.label.fillColor = occluded
					? COLOR_OCCLUDED_LABEL
					: Cesium.Color.fromCssColorString(hex);
				e.label.backgroundColor = selected
					? new Cesium.Color(0.08, 0.12, 0.16, 0.78)
					: LABEL_BG;
			}
			e.show = true;
			// Include the marker id so the click handler can key tooltips on
			// it. Without this every tooltip keys on `undefined`, which is
			// why clicks appeared to toggle the same slot no matter what
			// you clicked on.
			e.__commanderMeta = { id, ...meta };
			seen.add(id);
		};

		if (playerState && !this.suppressPlayerMarker) {
			const cat = categoryForUnit(playerState);
			this._ensureMarker('__player', MAP_COLORS.player, cat, 'PLAYER');
			updateOne('__player', playerState, MAP_COLORS.player, cat, true,
				{ kind: 'player', ref: playerState });
		} else {
			// Hide an existing __player marker if it was created
			// before the suppression flag flipped (e.g. user came
			// from a flight session where the map was already up).
			const m = this._markers.get('__player');
			if (m) m.show = false;
		}
		if (units) {
			for (const u of units) {
				if (!u || u.destroyed) continue;
				const id = `npc-${u.id || u.name}`;
				const hex = teamColor(u.team);
				const cat = categoryForUnit(u);
				const rotates = categoryRotates(cat) && !isGroundUnit(u);
				this._ensureMarker(id, hex, cat, u.name || 'BOGEY');
				updateOne(id, u, hex, cat, rotates, { kind: 'npc', ref: u });
			}
		}
		if (missiles) {
			// Coloured by the LAUNCHING team (same as airframes + trails), so an
			// NPC-vs-NPC salvo reads as two sides rather than a friend/foe blur.
			// Bullets share the projectile pool but shouldn't clutter the
			// strategic map — a CIWS draining an autocannon belt would paint
			// hundreds of markers. Skip anything without a `type` label (Bullet
			// doesn't set one; every real missile does).
			for (const m of missiles) {
				if (!m || !m.active) continue;
				if (!m.type) continue;
				const id = `m-${m.id || (m.id = `m${seen.size}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)}`;
				const typeTag = m.type || 'MSL';
				const phaseTag = (typeof m.boostRemaining === 'number' && m.boostRemaining > 0) ? ' ▲' : '';
				// Colour by the launching team (matches the trail) so NPC-vs-NPC
				// salvoes stay readable instead of collapsing to friend/foe.
				const hex = teamColor(m.team);
				const cat = categoryForMissile(m);
				const entity = this._ensureMarker(id, hex, cat, typeTag + phaseTag);
				if (entity && entity.label) entity.label.text = typeTag + phaseTag;
				updateOne(id, m, hex, cat, true, { kind: 'missile', ref: m });
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
	// Returns true if the canvas pixel (x, y) is over a Cesium entity
	// the scenario editor tagged as one of its draggable markers
	// (spawn pin or waypoint). Lets the editor's window-capture
	// pointerdown win the drag without us also panning the camera.
	_isEditorMarkerAt(x, y) {
		if (!this.viewer || !this.viewer.scene) return false;
		const picked = this.viewer.scene.pick(new Cesium.Cartesian2(x, y));
		const id = picked && picked.id;
		if (!id) return false;
		return Number.isFinite(id.__editorSpawnIdx)
			|| (id.__editorWaypointRoute && Number.isFinite(id.__editorWaypointIdx));
	}

	_handleClickAt(x, y) {
		const picked = this.viewer.scene.pick(new Cesium.Cartesian2(x, y));
		if (picked && picked.id && picked.id.__commanderMeta) {
			const meta = picked.id.__commanderMeta;
			if (this._tooltips.has(meta.id)) {
				this._tooltips.get(meta.id).element.remove();
				this._tooltips.delete(meta.id);
			} else {
				const accent = this._accentForMeta(meta);
				const el = this._createTooltipElement(meta.kind, accent);

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
					buttonEl.textContent = '▶ SPECTATE';
					buttonEl.style.cssText = `
						pointer-events: auto;
						cursor: pointer;
						display: block;
						width: 100%;
						margin-top: 7px;
						background: ${accent}1f;
						border: 1px solid ${accent}99;
						border-radius: 4px;
						color: ${accent};
						font: inherit;
						font-size: 10px;
						padding: 3px 8px;
						letter-spacing: 1.5px;
						transition: background 0.15s;
					`;
					buttonEl.onmouseenter = () => { buttonEl.style.background = `${accent}38`; };
					buttonEl.onmouseleave = () => { buttonEl.style.background = `${accent}1f`; };
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
			// 10b — let the scenario editor (or any other consumer)
			// react to clicks on the globe. We dispatch a single
			// `commander-terrain-click` event carrying lon/lat/alt
			// AND the picked entity (when one was hit). Consumers
			// that don't care about the entity ignore it; the
			// editor uses it to distinguish "click on a spawn
			// marker → select" vs "click on empty terrain → drop /
			// move."
			const ray = this.viewer.camera.getPickRay(new Cesium.Cartesian2(x, y));
			const cart = ray && this.viewer.scene.globe.pick(ray, this.viewer.scene);
			if (cart) {
				const carto = Cesium.Cartographic.fromCartesian(cart);
				window.dispatchEvent(new CustomEvent('commander-terrain-click', {
					detail: {
						lon: Cesium.Math.toDegrees(carto.longitude),
						lat: Cesium.Math.toDegrees(carto.latitude),
						alt: carto.height || 0,
						entity: (picked && picked.id) ? picked.id : null,
					},
				}));
			}
		}
	}

	_clearAllTooltips() {
		for (const [, tt] of this._tooltips) tt.element.remove();
		this._tooltips.clear();
	}

	// One small floating panel per pinned unit. Border/text colored by kind
	// so three open tooltips stay visually distinct at a glance.
	_createTooltipElement(kind, accentHex) {
		// Accent comes from the unit's team colour where available so the
		// pinned card matches its marker; fall back to a per-kind default.
		let color = accentHex || '#27e3ff';
		if (!accentHex) {
			if (kind === 'player')  color = MAP_COLORS.player;
			else if (kind === 'npc') color = MAP_COLORS['hostile-red'];
			else if (kind === 'missile') color = MAP_COLORS.missileFriendly;
		}
		const el = document.createElement('div');
		el.className = 'commander-tooltip';
		el.style.cssText = `
			position: fixed;
			padding: 7px 10px 8px;
			border: 1px solid ${color}66;
			border-left: 3px solid ${color};
			border-radius: 7px;
			background: linear-gradient(180deg, rgba(10,16,22,0.92), rgba(6,10,14,0.9));
			box-shadow: 0 8px 26px rgba(0,0,0,0.55), 0 0 14px ${color}22;
			backdrop-filter: blur(8px);
			-webkit-backdrop-filter: blur(8px);
			color: #d7e2ec;
			font-family: 'AceCombat', monospace;
			font-size: 11px;
			line-height: 1.5;
			letter-spacing: 0.6px;
			z-index: 30;
			pointer-events: none;
			white-space: nowrap;
			min-width: 132px;
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

	// Accent (team / threat) colour for a pinned unit — matches its marker so
	// the card and the symbol read as the same track.
	_accentForMeta(meta) {
		const { kind, ref } = meta;
		if (kind === 'player') return MAP_COLORS.player;
		// Missiles match their marker/trail: coloured by the launching team.
		return teamColor(ref.team);
	}

	_buildTooltipHtml(meta) {
		const { kind, ref } = meta;
		const accent = this._accentForMeta(meta);
		const cat = kind === 'missile' ? categoryForMissile(ref) : categoryForUnit(ref);
		const headerIcon =
			`<span style="display:inline-flex; width:19px; height:19px; flex:0 0 19px; align-items:center; justify-content:center;">${iconSvgMarkup(cat, accent, 18)}</span>`;
		const header = (title, sub) =>
			`<div style="display:flex; align-items:center; gap:7px; margin-bottom:5px; padding-bottom:5px; border-bottom:1px solid ${accent}33;">
				${headerIcon}
				<div style="min-width:0;">
					<div style="font-weight:bold; color:${accent}; letter-spacing:1px;">${title}</div>
					${sub ? `<div style="font-size:8.5px; letter-spacing:1.4px; color:#7f97aa;">${sub}</div>` : ''}
				</div>
			</div>`;
		const altM = Math.max(0, Math.round(ref.alt)).toLocaleString();
		const row = (lbl, val) =>
			`<div style="display:flex; gap:8px;"><span style="display:inline-block; width:34px; color:#7f97aa;">${lbl}</span><span style="color:#dbe6ef;">${val}</span></div>`;
		const dir = (d) => `${Math.round(((d % 360) + 360) % 360).toString().padStart(3, '0')}°`;
		const classLabel = (c) => ({
			fighter: 'FIGHTER', stealth: 'STEALTH FIGHTER', bomber: 'STEALTH BOMBER',
			awacs: 'AEW&C / TANKER', drone: 'ISR DRONE', ew_jet: 'EW AIRCRAFT',
			sam: 'SAM BATTERY', aaa: 'AAA / SHORAD', radar: 'EW RADAR',
			jammer: 'JAMMER', laser: 'DEW / LASER', command: 'COMMAND POST',
		}[c] || '');
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
			else if (ref.type === 'AIM-120' || ref.type === 'METEOR' || ref.type === 'R-77' || ref.type === 'R-37M' || ref.type === 'NASAMS-MSL' || ref.type === 'TOR-MSL') mode = 'DL';
			else mode = '—';
			const rng     = typeof dbg.rangeToTarget === 'number'
				? `${(dbg.rangeToTarget / 1000).toFixed(2)} km` : '—';
			// Read the LIVE target, not the debug snapshot. `debug` is only
			// refreshed while guidance is actually running, so a round that went
			// maddog or lost lock kept displaying whatever it USED to chase —
			// and an unnamed target (any munition) collapsed to the literal
			// string 'TGT', which was indistinguishable from "no data" in
			// exactly the case worth watching: an interceptor homing on another
			// interceptor.
			const tgt     = ref.target ? targetLabel(ref.target) : (dbg.targetName || '—');
			return (
				header(typeTag, phase) +
				row('TGT',  tgt) + row('RNG', rng) +
				row('SPD',  `${Math.round(ref.speed * 3.6)} km/h`) +
				row('ALT',  `${altM} m`) +
				row('MODE', mode) +
				row('TTL',  `${ref.life.toFixed(1)} s`)
			);
		}
		const name = kind === 'player' ? 'PLAYER' : (ref.name || 'BOGEY');
		const spd  = typeof ref.speed   === 'number' ? `${Math.round(ref.speed * 3.6)} km/h` : '—';
		const hdg  = typeof ref.heading === 'number' ? dir(ref.heading) : '—';
		const pit  = typeof ref.pitch   === 'number' ? `${ref.pitch.toFixed(1)}°` : '—';
		let html =
			header(name, kind === 'player' ? 'OWNSHIP' : classLabel(cat)) +
			row('ALT', `${altM} m`) +
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
		if (kind === 'npc') html += this._damageAndMagazineHtml(ref);
		return html;
	}

	// Condition + magazine block for a clicked unit.
	//
	// Without this the map could tell you what a ship was DOING but nothing
	// about whether it was winning: no hull state, no idea whether a quiet
	// destroyer was holding fire or simply out of missiles. Both are the
	// questions you actually have while watching a surface action, and both are
	// already tracked — the HP/subsystem model in shipDamage and the per-weapon
	// ammo in the WeaponSubsystem — they just weren't surfaced anywhere.
	_damageAndMagazineHtml(ref) {
		let html = '';

		// ---- Air wing (carriers) ---------------------------------------------
		// A carrier's readiness IS its deck state, not its magazine — how many
		// airframes are spotted, how many are up, and whether the deck is
		// currently committed to a launch or a recovery.
		const wing = describeAirWing(ref);
		if (wing) {
			html += this._row('DECK', wing.state.toUpperCase());
			html += this._row('READY', `${wing.readyOnDeck}/${wing.total} on deck`);
			html += this._row('AIRBORNE', `${wing.airborne}/${wing.cap}`);
			html += this._row('SORTIES', `${wing.launched} flown, ${wing.recovered} trapped, ${wing.lost} lost`);
		}

		// ---- Hull / condition ------------------------------------------------
		if (typeof ref.hp === 'number' && typeof ref.maxHp === 'number' && ref.maxHp > 0) {
			const frac = Math.max(0, ref.hp) / ref.maxHp;
			const col = frac > 0.6 ? '#5fe08a' : frac > 0.3 ? '#ffcc00' : '#ff5a5a';
			html +=
				`<div style="display:flex; align-items:center; gap:6px; margin-top:3px;">` +
					`<span style="opacity:0.7; min-width:34px;">HULL</span>` +
					`<span style="flex:1; height:6px; background:rgba(255,255,255,0.08); border-radius:3px; overflow:hidden;">` +
						`<span style="display:block; height:100%; width:${(frac * 100).toFixed(0)}%; background:${col};"></span>` +
					`</span>` +
					`<span style="color:${col}; min-width:52px; text-align:right;">${Math.max(0, Math.round(ref.hp))}/${ref.maxHp}</span>` +
				`</div>`;
			if (ref.sinking) html += this._row('STATE', 'SINKING');
		}

		// Knocked-out subsystems — the reason a ship stops moving or shooting.
		const dead = [];
		if (ref._mobilityHit) dead.push('PROPULSION');
		if (ref._sensorsHit)  dead.push('RADAR');
		if (ref._disabledWeapons && ref._disabledWeapons.size) {
			for (const t of ref._disabledWeapons) dead.push(t);
		}
		if (dead.length) html += this._row('DAMAGE', dead.join(', '));

		// ---- Magazine --------------------------------------------------------
		const ws = ref.pilot && ref.pilot.subsystems && ref.pilot.subsystems.weapons;
		if (ws && Array.isArray(ws.weapons)) {
			const rows = [];
			for (const w of ws.weapons) {
				if (!w || !w.type || w.ammo === Infinity) continue;
				const max = w.maxAmmo || w.ammo || 0;
				if (!max) continue;
				const f = Math.max(0, w.ammo) / max;
				const col = w.ammo <= 0 ? '#ff5a5a' : f < 0.34 ? '#ffcc00' : '#c8d6e2';
				rows.push(
					`<div style="display:flex; justify-content:space-between; gap:10px;">` +
						`<span style="opacity:0.8">${w.type}${w.role ? ` <span style="opacity:0.5">${w.role}</span>` : ''}</span>` +
						`<span style="color:${col}">${Math.max(0, w.ammo)}/${max}</span>` +
					`</div>`);
			}
			if (rows.length) {
				html += `<div style="margin-top:6px; padding-top:5px; border-top:1px solid rgba(120,170,210,0.16);">` +
					`<div style="letter-spacing:1.4px; font-size:9px; color:#7fa8c4; margin-bottom:3px;">MAGAZINE</div>` +
					rows.join('') + `</div>`;
			}
		}
		return html;
	}

	_row(k, v) {
		return `<div style="display:flex; justify-content:space-between; gap:10px;">` +
			`<span style="opacity:0.7">${k}</span><span>${v}</span></div>`;
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
			for (const m of missiles) {
				if (!m || !m.active) continue;
				// Skip bullets — same filter the marker loop uses. Bullets
				// share the projectile pool but carry no `type` (only real
				// missiles do); without this an AAA/CIWS belt paints hundreds
				// of trail polylines across the strategic map in seconds.
				if (!m.type) continue;
				// Colour by the LAUNCHING team so two NPC sides stay readable.
				sample(`m-${m.id}`, m, missileTrailColor(m.team));
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
					// Comet-tail taper: freshest segment widest, history thins
					// to a hairline — the head of each track reads at a glance.
					const chunkWidth = 1.0 + 2.4 * ageFrac;
					const ent = this.viewer.entities.add({
						polyline: {
							positions: new Cesium.CallbackProperty(
								() => rec.positionsCache && rec.positionsCache[chunkIdx] || [],
								false,
							),
							width: chunkWidth,
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
		if (this.debugJammerEnabled)   this._syncJammerDebug(playerState, units);
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
				if (m.type !== 'AIM-120' && m.type !== 'METEOR' && m.type !== 'R-77' && m.type !== 'R-37M') continue;
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

		// Live "why isn't this radar seeing the player" readout.
		// Throttled to ~1.5 s so the console stays readable while
		// still updating as the player flies through / over a SAM.
		// Only logs radiating hostile observers that do NOT currently
		// hold a radar contact on the player — i.e. the ones the
		// player would expect to be shot at by but isn't.
		const nowMs = (typeof performance !== 'undefined') ? performance.now() : Date.now();
		if (playerState && nowMs - (this._radarWhyLogAt || 0) > 1500) {
			this._radarWhyLogAt = nowMs;
			const lines = [];
			for (const obs of observers) {
				if (!obs || obs === playerState) continue;
				if (obs.destroyed || obs.active === false) continue;
				if (obs.team && obs.team === playerState.team) continue;
				const r = obs.sensors && obs.sensors.radar;
				if (!r) continue;
				const held = obs.contacts && obs.contacts.get(playerState);
				if (held && held.radar) continue;   // already tracking us
				let why;
				try { why = explainRadarRejection(obs, playerState, r); }
				catch (e) { why = 'probe-threw'; }
				if (why === 'DETECTED') continue;    // would detect; flicker/memory
				const name = obs.name || obs.platformId || obs.id || 'radar';
				lines.push(`  ${name}: ${why}`);
			}
			if (lines.length > 0) {
				console.log('[CMDR debug] radars NOT seeing player:\n' + lines.join('\n'));
			} else {
				console.log('[CMDR debug] every radiating hostile radar can see the player');
			}
		}
	}

	// ---- Jammer debug overlay ---------------------------------------------
	//
	// For each unit carrying an active jammer subsystem, draws:
	//   - A burn-through ring at ground level around the jammer (radius
	//     = jammer.burnThroughRangeM). Inside this radius the jam loses
	//     to the radar; outside it the jam wins.
	//   - A translucent triangular wedge from the jammer toward each
	//     opposing-team observer it's degrading. Wedge half-angle = the
	//     same 10° main-lobe used by accumulateJamAttenuation, so the
	//     overlay matches the actual physics rather than the (wider)
	//     coneHalfDeg broadcast pattern. Wedge length = LOS distance
	//     to the victim, so it always terminates exactly on the
	//     receiving radar.
	//
	// Color = the same orange family as the receive-side scope strobes,
	// so the player can correlate "this is the cone they're getting"
	// (commander view) with "this is what I see on my scope" (cockpit).

	_syncJammerDebug(playerState, units) {
		const all = [playerState, ...(units || [])];
		const jammers = [];
		for (const u of all) {
			if (!u || u.destroyed || u.active === false) continue;
			if (!u.jammer || u.jammer.defensiveOn === false) continue;
			jammers.push(u);
		}
		if (jammers.length === 0) return;

		// Potential victims: anything alive on a different team with a
		// radar suite. The cone gets directed at each one — visualises
		// "this corridor of noise reaches that radar."
		const victims = [];
		for (const u of all) {
			if (!u || u.destroyed || u.active === false) continue;
			if (!u.sensors || !u.sensors.radar) continue;
			victims.push(u);
		}

		const jamColor  = Cesium.Color.fromCssColorString('#ff7030').withAlpha(0.16);
		const edgeColor = Cesium.Color.fromCssColorString('#ff7030').withAlpha(0.55);
		const ringColor = Cesium.Color.fromCssColorString('#ff7030').withAlpha(0.85);
		// Match the corridor main-lobe used by accumulateJamAttenuation
		// (1.5° half-angle at the victim). The cone visualises the
		// "blind corridor" punched through the victim's scope —
		// narrow because a real fighter APG main lobe is only ~3°
		// wide; outside that the radar still works. Geometrically:
		// at 50 km range the cone is only ±1.3 km cross-range wide,
		// which is why a striker hugging the jammer survives but a
		// jet a few km off-axis still gets seen.
		const HALF_RAD = 1.5 * Math.PI / 180;

		for (const jam of jammers) {
			const burn = jam.jammer.burnThroughRangeM || 8000;
			this._drawJammerRing(jam, burn, ringColor);

			for (const v of victims) {
				if (v === jam) continue;
				if (v.team === jam.team) continue;
				// Jam noise doesn't politely stop at the victim — it
				// keeps going until it falls off the radar's noise
				// floor at much greater range. Draw out to the
				// jammer's configured maxEffectRangeM so the cone
				// actually represents the volume of jam-soaked sky.
				const maxLen = jam.jammer.maxEffectRangeM || 150000;
				this._drawJammerCone(jam, v, HALF_RAD, maxLen, jamColor, edgeColor);
			}
		}
	}

	// Tessellated translucent 3D cone, apex at `from`, axis pointing
	// from `from` toward `to`, opening to `halfRad`, length `lenM`.
	// Built from `SEGMENTS` triangle "petals" (apex + two adjacent
	// rim points) on the lateral surface, plus matching rim wireframe
	// for an outline. The cone runs past the victim — `to` only
	// supplies the axis direction.
	_drawJammerCone(from, to, halfRad, lenM, fillColor, edgeColor) {
		const SEGMENTS = 18;

		// Build the cone-axis direction in a local ENU frame at `from`.
		// Then construct two perpendicular basis vectors on the rim
		// plane via Gram-Schmidt against world-up. This works for any
		// axis orientation including straight up/down.
		const latRad = from.lat * Math.PI / 180;
		const axisE = (to.lon - from.lon) * 111320 * Math.cos(latRad);
		const axisN = (to.lat - from.lat) * 111320;
		const axisU = (to.alt - from.alt);
		const axisLen = Math.hypot(axisE, axisN, axisU);
		if (axisLen < 1) return;
		const ax = axisE / axisLen, ay = axisN / axisLen, az = axisU / axisLen;

		// Pick a seed not parallel to the axis.
		let sx = 0, sy = 0, sz = 1;
		if (Math.abs(az) > 0.95) { sx = 1; sy = 0; sz = 0; }
		// u = axis × seed, v = axis × u — orthonormal basis on rim plane.
		let ux = ay * sz - az * sy;
		let uy = az * sx - ax * sz;
		let uz = ax * sy - ay * sx;
		const ulen = Math.hypot(ux, uy, uz) || 1;
		ux /= ulen; uy /= ulen; uz /= ulen;
		const vx = ay * uz - az * uy;
		const vy = az * ux - ax * uz;
		const vz = ax * uy - ay * ux;

		// Cone geometry: rim sits at distance lenM along the axis,
		// radius = lenM * tan(halfRad).
		const tipE = ax * lenM;
		const tipN = ay * lenM;
		const tipU = az * lenM;
		const r = lenM * Math.tan(halfRad);

		// Gather rim points in world ENU offsets from `from`.
		const rim = [];
		for (let i = 0; i < SEGMENTS; i++) {
			const a = (i / SEGMENTS) * Math.PI * 2;
			const ca = Math.cos(a), sa = Math.sin(a);
			rim.push({
				dE: tipE + r * (ca * ux + sa * vx),
				dN: tipN + r * (ca * uy + sa * vy),
				dU: tipU + r * (ca * uz + sa * vz),
			});
		}

		// Convert offsets to lon/lat/alt around `from`.
		const enuToGeo = (dE, dN, dU) => ({
			lon: from.lon + dE / (111320 * Math.cos(latRad)),
			lat: from.lat + dN / 111320,
			alt: from.alt + dU,
		});
		const apexGeo = { lon: from.lon, lat: from.lat, alt: from.alt };
		const rimGeo = rim.map(p => enuToGeo(p.dE, p.dN, p.dU));

		// Lateral surface as a single tessellated mesh (apex + rim).
		// Index 0 is the apex; rim points are 1..SEGMENTS. Triangles:
		// (0, i, i+1).
		const positions = [apexGeo, ...rimGeo];
		const indices = [];
		for (let i = 0; i < SEGMENTS; i++) {
			const a = i + 1;
			const b = ((i + 1) % SEGMENTS) + 1;
			indices.push(0, a, b);
		}
		this._addDebugMesh(positions, indices, fillColor);

		// Rim outline so the cone reads as a volume even from above.
		const ringPts = [...rimGeo, rimGeo[0]];
		this._addDebugPolyline(ringPts, edgeColor, 1.5);
		// A few axis-to-rim spokes (every ~45°) to suggest 3D shape.
		for (let i = 0; i < SEGMENTS; i += Math.max(1, Math.floor(SEGMENTS / 4))) {
			this._addDebugPolyline([apexGeo, rimGeo[i]], edgeColor.withAlpha(0.35), 1);
		}
	}

	// Burn-through ring at jammer position. Drawn as a flat circle on
	// the ground (alt + 5 m so it isn't z-fighting with terrain).
	_drawJammerRing(jam, radiusM, color) {
		const SAMPLES = 36;
		const latRad = jam.lat * Math.PI / 180;
		const pts = [];
		for (let i = 0; i <= SAMPLES; i++) {
			const a = (i / SAMPLES) * Math.PI * 2;
			const dE = radiusM * Math.sin(a);
			const dN = radiusM * Math.cos(a);
			pts.push({
				lon: jam.lon + dE / (111320 * Math.cos(latRad)),
				lat: jam.lat + dN / 111320,
				alt: jam.alt + 5,
			});
		}
		this._addDebugPolyline(pts, color, 2);
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
