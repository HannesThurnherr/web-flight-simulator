// ============================================================================
// Scenario editor — Phase 10b.3 + 10b.4.
//
// Listens for `scenario-edit-request` (dispatched by the picker's
// EDIT / NEW / DUPLICATE buttons), loads the raw scenario JSON,
// swaps the game into a new EDITING state, opens the commander map,
// and lets the player click on the globe to drop new units. Existing
// spawns render as Cesium markers; the side panel lists them and
// shows what each click-to-place will drop.
//
// Layout:
//   - Side panel pinned to the RIGHT side (commander view's own
//     controls panel sits at top-LEFT; we don't fight it).
//   - Click-to-place is the primary interaction. The palette in the
//     panel picks WHAT will be dropped (any plane / platform id) and
//     the team. Then any left-click on the globe drops a literal
//     spawn at the picked lon/lat (using terrain altitude for ground
//     units, a sensible default cruise altitude for air units).
//   - SAVE writes back to localStorage; EXIT returns to the menu.
//
// 10b.5 will add: drag-to-move existing markers, click-to-select with
// edit form (override per-spawn fields like team / heading / loadout),
// and per-marker delete on the map.
// ============================================================================

import * as Cesium from 'cesium';
import { getRawScenario, refreshScenarios } from '../systems/scenarios';
import {
	loadUserScenarios, saveUserScenario,
} from '../systems/scenarios/userScenarios.js';
import { getViewer } from '../world/cesiumWorld';
import { CommanderView } from '../systems/commanderView';
import { PLATFORMS } from '../systems/platforms';
import { PLANES } from '../plane/planes';

let _ctx        = null;
let _activeId   = null;
let _activeJson = null;
let _entities   = [];
let _panel      = null;
let _previousState = null;
let _clickHandler  = null;

// What the next click drops. Mutable; set by the palette in the side
// panel.
let _armedKind = 'fighter';        // 'fighter' | 'platform'
let _armedSubId = 'f-15';          // plane id (when fighter) OR platform id
let _armedTeam = 'hostile-red';

// Ground-class platforms (depth-tested via the platform's `kind`
// field). Used to decide whether to clamp to terrain altitude
// (ground-anchored) or use a default cruise altitude (airborne).
function _platformIsGround(platformId) {
	const p = PLATFORMS[platformId];
	return !!(p && p.kind === 'ground');
}

// Marker color by team.
const TEAM_COLORS = {
	'friendly':     Cesium.Color.fromCssColorString('#40d0ff'),
	'hostile-red':  Cesium.Color.fromCssColorString('#ff4040'),
	'hostile-blue': Cesium.Color.fromCssColorString('#ff8080'),
	'neutral':      Cesium.Color.fromCssColorString('#ffd040'),
};
const COLOR_FALLBACK = Cesium.Color.fromCssColorString('#cccccc');
const COLOR_RANDOM   = Cesium.Color.fromCssColorString('#a070ff');

const TEAMS = ['friendly', 'hostile-red', 'hostile-blue', 'neutral'];

const DEFAULT_AIR_ALT_M    = 8000;
const DEFAULT_FIGHTER_SPD  = 250;

export function setupScenarioEditor(ctx) {
	_ctx = ctx;
	window.addEventListener('scenario-edit-request', (e) => {
		const id = e && e.detail && e.detail.id;
		if (!id) return;
		open(id);
	});
}

function open(id) {
	const userScenarios = loadUserScenarios();
	const json = userScenarios[id] || getRawScenario(id);
	if (!json) {
		console.warn('[scenarioEditor] no scenario found for id:', id);
		return;
	}
	_activeId = id;
	_activeJson = JSON.parse(JSON.stringify(json));

	const menu = document.getElementById('mainMenu');
	if (menu) menu.classList.add('hidden');

	if (_ctx) {
		_previousState = _ctx.currentState;
		_ctx.setCurrentState('EDITING');
	}

	// Lazy-create the commander view if we're entering the editor
	// directly from the main menu (no flight session yet).
	if (_ctx && !_ctx.commanderView) {
		const viewer = getViewer();
		if (viewer) {
			const cv = new CommanderView(viewer);
			_ctx.setCommanderView(cv);
			if (_ctx.controller) _ctx.controller.commanderView = cv;
		}
	}
	const view = _ctx && _ctx.commanderView;
	if (view) {
		view.setActive(true, _firstAnchorLikePoint(_activeJson));
		// Force a wide regional zoom-out on entry so the user sees
		// where the scenario lives in geographic context. The
		// commander view's own _everActivated guard normally
		// preserves whatever distance the user last left it at;
		// for the editor we want to start zoomed out regardless.
		view.distance = 800000;          // 800 km slant distance
		view.tilt     = 12;              // mostly top-down
	}

	_installClickHandler();
	_renderSpawnMarkers();
	_buildPanel();
}

function _close() {
	const viewer = getViewer();
	for (const e of _entities) {
		try { viewer.entities.remove(e); } catch (err) { void err; }
	}
	_entities.length = 0;

	if (_panel && _panel.parentNode) _panel.parentNode.removeChild(_panel);
	_panel = null;

	_uninstallClickHandler();

	const view = _ctx && _ctx.commanderView;
	if (view) view.setActive(false);

	if (_ctx) _ctx.setCurrentState(_previousState || 'MENU');
	_previousState = null;

	const menu = document.getElementById('mainMenu');
	if (menu) menu.classList.remove('hidden');

	_activeId = null;
	_activeJson = null;
}

// ----- Click-to-place ------------------------------------------------------

// Listen for commander view's empty-space click event. Trying to
// install a Cesium ScreenSpaceEventHandler directly here doesn't
// work because commander view's window-level pointerdown calls
// preventDefault() — Cesium's LEFT_CLICK never fires. Instead we
// hook into commander view's own _handleClickAt path via the
// dispatched `commander-terrain-click` event, which already gives
// us the picked lon/lat/alt.
function _installClickHandler() {
	if (_clickHandler) return;
	_clickHandler = (e) => {
		if (!_activeJson) return;
		const d = e && e.detail;
		if (!d) return;
		_dropUnitAt(d.lon, d.lat, d.alt || 0);
	};
	window.addEventListener('commander-terrain-click', _clickHandler);
}

function _uninstallClickHandler() {
	if (!_clickHandler) return;
	window.removeEventListener('commander-terrain-click', _clickHandler);
	_clickHandler = null;
}

function _dropUnitAt(lon, lat, terrainH) {
	if (!_activeJson) return;
	const spawn = {
		type: _armedKind,
		team: _armedTeam,
		origin: { lon, lat, alt: 0 },
	};
	if (_armedKind === 'fighter') {
		spawn.fighterModel = _armedSubId;
		spawn.origin.alt = DEFAULT_AIR_ALT_M;
		spawn.speedMps = DEFAULT_FIGHTER_SPD;
	} else {
		spawn.platformId = _armedSubId;
		const isGround = _platformIsGround(_armedSubId);
		spawn.origin.alt = isGround ? terrainH : DEFAULT_AIR_ALT_M;
	}
	if (!Array.isArray(_activeJson.spawns)) _activeJson.spawns = [];
	_activeJson.spawns.push(spawn);
	_renderSpawnMarkers();
	_renderSpawnList();
}

// ----- Marker rendering ----------------------------------------------------

function _renderSpawnMarkers() {
	const viewer = getViewer();
	if (!viewer || !_activeJson) return;
	for (const e of _entities) viewer.entities.remove(e);
	_entities.length = 0;

	const spawns = Array.isArray(_activeJson.spawns) ? _activeJson.spawns : [];
	for (const s of spawns) {
		const pt = _resolveSpawnPositionForDisplay(s, _activeJson);
		if (!pt) continue;
		const team  = (typeof s.team === 'string') ? s.team : null;
		const color = TEAM_COLORS[team] || COLOR_FALLBACK;
		const isRandom = _spawnIsRandom(s);
		const ent = viewer.entities.add({
			position: Cesium.Cartesian3.fromDegrees(pt.lon, pt.lat, pt.alt || 0),
			point: {
				pixelSize: 12,
				color: isRandom ? COLOR_RANDOM : color,
				outlineColor: Cesium.Color.WHITE.withAlpha(0.7),
				outlineWidth: 1.5,
				disableDepthTestDistance: Number.POSITIVE_INFINITY,
			},
			label: {
				text: _spawnLabel(s),
				font: '11px AceCombat, monospace',
				pixelOffset: new Cesium.Cartesian2(14, 0),
				fillColor: isRandom ? COLOR_RANDOM : color,
				outlineColor: Cesium.Color.BLACK,
				outlineWidth: 2,
				style: Cesium.LabelStyle.FILL_AND_OUTLINE,
				disableDepthTestDistance: Number.POSITIVE_INFINITY,
				horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
			},
		});
		_entities.push(ent);
	}
}

function _spawnIsRandom(s) {
	if (!s) return false;
	if (s.origin && (s.origin.random || s.origin.randomOnRoute)) return true;
	if (typeof s.count === 'object' && s.count) return true;
	return false;
}

function _spawnLabel(s) {
	const id = s.platformId || s.fighterModel || s.type || '?';
	const team = (typeof s.team === 'string') ? s.team : 'random';
	const count = (typeof s.count === 'object' && s.count)
		? `${s.count.min}-${s.count.max}×`
		: (typeof s.count === 'number' && s.count > 1 ? `${s.count}× ` : '');
	return `${count}${id}  [${team}]`;
}

function _resolveSpawnPositionForDisplay(s, json) {
	const o = s.origin;
	if (!o) return null;
	if (typeof o === 'object' && typeof o.lon === 'number') {
		return { lon: o.lon, lat: o.lat, alt: o.alt || 0 };
	}
	if (o.relTo === 'anchor' && json.anchor && json.anchor.mode === 'world') {
		const platA = json.anchor.worldLat * Math.PI / 180;
		const dE = o.offsetEastM || 0;
		const dN = o.offsetNorthM || 0;
		return {
			lon: json.anchor.worldLon + dE / (111320 * Math.cos(platA)),
			lat: json.anchor.worldLat + dN / 111320,
			alt: o.altM || 0,
		};
	}
	if (o.relTo === 'player') {
		const anc = _scenarioAnchorPoint(json);
		const plat = anc.lat * Math.PI / 180;
		const b = (o.bearingDeg || 0) * Math.PI / 180;
		const r = o.rangeM || 0;
		const dE = r * Math.sin(b);
		const dN = r * Math.cos(b);
		return {
			lon: anc.lon + dE / (111320 * Math.cos(plat)),
			lat: anc.lat + dN / 111320,
			alt: o.altM || (anc.alt + (o.altOffsetM || 0)),
		};
	}
	if (o.random) {
		const anc = _scenarioAnchorPoint(json);
		const centre = (o.random.centerRelTo === 'anchor' || !o.random.centerRelTo)
			? anc
			: { lon: o.random.centerLon || anc.lon, lat: o.random.centerLat || anc.lat, alt: 0 };
		const plat = centre.lat * Math.PI / 180;
		const b = ((o.random.bearingDeg || 0)) * Math.PI / 180;
		const r = o.random.rangeM || 0;
		const dE = r * Math.sin(b);
		const dN = r * Math.cos(b);
		return {
			lon: centre.lon + dE / (111320 * Math.cos(plat)),
			lat: centre.lat + dN / 111320,
			alt: o.random.altM || ((o.random.altMin || 0) + (o.random.altMax || 0)) / 2,
		};
	}
	return null;
}

function _scenarioAnchorPoint(json) {
	if (json && json.anchor && json.anchor.mode === 'world'
		&& typeof json.anchor.worldLon === 'number') {
		return { lon: json.anchor.worldLon, lat: json.anchor.worldLat, alt: 0 };
	}
	if (json && json.anchor && json.anchor.playerSpawn
		&& typeof json.anchor.playerSpawn.lon === 'number') {
		return {
			lon: json.anchor.playerSpawn.lon,
			lat: json.anchor.playerSpawn.lat,
			alt: json.anchor.playerSpawn.alt || 0,
		};
	}
	// Fall back to the ctx state's current lon/lat (where the player
	// happens to be, geocoded from the menu / last flight) instead of
	// (0, 0) which lands you in the equatorial Atlantic.
	if (_ctx && _ctx.state && typeof _ctx.state.lon === 'number') {
		return { lon: _ctx.state.lon, lat: _ctx.state.lat, alt: _ctx.state.alt || 0 };
	}
	return { lon: 0, lat: 0, alt: 0 };
}

function _firstAnchorLikePoint(json) {
	const anc = _scenarioAnchorPoint(json);
	if (anc.lon !== 0 || anc.lat !== 0) return { lon: anc.lon, lat: anc.lat, alt: anc.alt };
	const spawns = json.spawns || [];
	for (const s of spawns) {
		const pt = _resolveSpawnPositionForDisplay(s, json);
		if (pt) return pt;
	}
	return null;
}

// ----- Side panel ----------------------------------------------------------

function _buildPanel() {
	const panel = document.createElement('div');
	panel.id = 'scenario-editor-panel';
	panel.style.cssText = `
		position: fixed;
		right: 16px;
		top: 16px;
		width: 320px;
		max-height: calc(100vh - 32px);
		overflow-y: auto;
		padding: 12px 14px;
		background: rgba(0, 20, 30, 0.85);
		border: 1px solid rgba(0, 220, 255, 0.45);
		color: #c0eeff;
		font-family: 'AceCombat', 'Courier New', monospace;
		font-size: 12px;
		line-height: 1.5;
		z-index: 60;
		letter-spacing: 0.5px;
	`;
	panel.innerHTML = _panelHtml();
	document.body.appendChild(panel);
	_panel = panel;

	panel.querySelector('#se-name').addEventListener('input', (e) => {
		_activeJson.name = e.target.value;
	});
	panel.querySelector('#se-kind').addEventListener('change', (e) => {
		_armedKind = e.target.value;
		// Reset sub-id to a sane default for the new kind.
		const sub = panel.querySelector('#se-sub');
		if (_armedKind === 'fighter') {
			sub.innerHTML = _optionsFor(Object.keys(PLANES).sort(), _armedSubId);
		} else {
			sub.innerHTML = _optionsFor(Object.keys(PLATFORMS).sort(), _armedSubId);
		}
		// Force the next sub-id to be valid for the new options list.
		_armedSubId = sub.value;
	});
	panel.querySelector('#se-sub').addEventListener('change', (e) => {
		_armedSubId = e.target.value;
	});
	panel.querySelector('#se-team').addEventListener('change', (e) => {
		_armedTeam = e.target.value;
	});
	panel.querySelector('#se-save').addEventListener('click', () => {
		saveUserScenario(_activeId, _activeJson);
		refreshScenarios();
		const btn = panel.querySelector('#se-save');
		const orig = btn.textContent;
		btn.textContent = 'SAVED ✓';
		setTimeout(() => { btn.textContent = orig; }, 700);
	});
	panel.querySelector('#se-exit').addEventListener('click', () => {
		_close();
	});

	_renderSpawnList();
}

function _panelHtml() {
	const planeOpts = _optionsFor(Object.keys(PLANES).sort(), _armedSubId);
	const platOpts  = _optionsFor(Object.keys(PLATFORMS).sort(), _armedSubId);
	const subOpts   = (_armedKind === 'fighter') ? planeOpts : platOpts;
	const teamOpts  = TEAMS.map(t =>
		`<option value="${t}"${t === _armedTeam ? ' selected' : ''}>${t}</option>`).join('');

	return `
	<div style="color:#6ff;font-weight:bold;border-bottom:1px solid rgba(0,220,255,0.35);padding-bottom:5px;margin-bottom:8px;display:flex;justify-content:space-between;">
		<span>SCENARIO EDITOR</span>
		<span style="opacity:0.6;font-size:10px;">10b.4</span>
	</div>

	<div style="margin-bottom:6px;">
		<input id="se-name" type="text" value="${escapeAttr(_activeJson.name || '')}"
			style="width:100%;background:rgba(0,0,0,0.4);border:1px solid rgba(0,220,255,0.35);color:#c0eeff;font-family:inherit;font-size:12px;padding:3px 6px;letter-spacing:0.5px;">
	</div>
	<div style="opacity:0.7;margin-bottom:8px;font-size:10px;">id: <span style="color:#fff">${escapeHtml(_activeId)}</span></div>

	<div style="margin-top:8px;border-top:1px solid rgba(0,220,255,0.2);padding-top:6px;">
		<div style="opacity:0.7;font-size:10px;margin-bottom:4px;">PALETTE — armed for next click</div>
		<div style="display:flex;gap:6px;margin-bottom:5px;">
			<select id="se-kind" style="${_selectCss()}flex:0 0 90px;">
				<option value="fighter"${_armedKind === 'fighter' ? ' selected' : ''}>fighter</option>
				<option value="platform"${_armedKind === 'platform' ? ' selected' : ''}>platform</option>
			</select>
			<select id="se-sub" style="${_selectCss()}flex:1;">${subOpts}</select>
		</div>
		<select id="se-team" style="${_selectCss()}width:100%;">${teamOpts}</select>
	</div>

	<div style="margin-top:8px;border-top:1px solid rgba(0,220,255,0.2);padding-top:6px;">
		<div style="opacity:0.7;font-size:10px;">SPAWNS</div>
		<div id="se-spawn-list" style="max-height:200px;overflow-y:auto;margin-top:4px;"></div>
	</div>

	<div style="margin-top:8px;border-top:1px solid rgba(0,220,255,0.2);padding-top:6px;font-size:10px;opacity:0.75;">
		<div style="opacity:0.7;margin-bottom:4px;">CONTROLS</div>
		<div>· LEFT-CLICK on terrain — drop selected unit</div>
		<div>· LEFT-DRAG — pan map</div>
		<div>· RIGHT-DRAG — tilt map</div>
		<div>· WHEEL — zoom</div>
		<div style="opacity:0.5;margin-top:3px;">drag-to-move + edit-form on markers in 10b.5</div>
	</div>

	<div style="display:flex;gap:8px;margin-top:10px;">
		<button id="se-save" type="button" style="flex:1;font-family:inherit;font-size:11px;letter-spacing:1px;background:transparent;border:1px solid #6ff;color:#6ff;padding:5px;cursor:pointer;">SAVE</button>
		<button id="se-exit" type="button" style="flex:1;font-family:inherit;font-size:11px;letter-spacing:1px;background:transparent;border:1px solid #ff8080;color:#ff8080;padding:5px;cursor:pointer;">EXIT</button>
	</div>
	`;
}

function _selectCss() {
	return `background:rgba(0,0,0,0.4);border:1px solid rgba(0,220,255,0.35);color:#c0eeff;font-family:inherit;font-size:11px;padding:2px 4px;letter-spacing:0.5px;`;
}

function _optionsFor(ids, selected) {
	return ids.map(id =>
		`<option value="${escapeAttr(id)}"${id === selected ? ' selected' : ''}>${escapeHtml(id)}</option>`,
	).join('');
}

function _renderSpawnList() {
	if (!_panel || !_activeJson) return;
	const list = _panel.querySelector('#se-spawn-list');
	if (!list) return;
	const spawns = _activeJson.spawns || [];
	if (spawns.length === 0) {
		list.innerHTML = '<div style="opacity:0.5;font-size:10px;font-style:italic;">no spawns yet — click on the globe to drop a unit</div>';
		return;
	}
	list.innerHTML = spawns.map((s, i) => {
		const label = _spawnLabel(s);
		return `<div class="se-spawn-row" data-idx="${i}" style="padding:2px 4px;border-bottom:1px dotted rgba(0,220,255,0.15);display:flex;justify-content:space-between;align-items:center;">
			<span><span style="opacity:0.5;display:inline-block;width:18px;">${i + 1}.</span>${escapeHtml(label)}</span>
			<button type="button" class="se-del" data-idx="${i}" style="background:transparent;border:1px solid rgba(255,128,128,0.4);color:#f88;font-size:9px;padding:1px 5px;cursor:pointer;letter-spacing:0.5px;">DEL</button>
		</div>`;
	}).join('');
	for (const btn of list.querySelectorAll('.se-del')) {
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			const idx = parseInt(btn.getAttribute('data-idx'), 10);
			if (Number.isFinite(idx)) {
				_activeJson.spawns.splice(idx, 1);
				_renderSpawnMarkers();
				_renderSpawnList();
			}
		});
	}
}

function escapeHtml(s) {
	return String(s)
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function escapeAttr(s) { return escapeHtml(s); }
