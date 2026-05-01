// ============================================================================
// Scenario editor — Phase 10b.3 (boot + render-only).
//
// Listens for `scenario-edit-request` (dispatched by the picker's
// EDIT / NEW / DUPLICATE buttons), loads the raw scenario JSON from
// the user-scenario store, swaps the game into a new EDITING state,
// opens the commander map onto the scenario's anchor / first spawn,
// and renders one Cesium marker per spawn entry. An overlay panel
// shows scenario name + spawn list + EXIT button.
//
// This is the smallest useful slice: the player can open the editor,
// see what's in the scenario, exit cleanly. Click-to-place,
// drag-to-move, edit-form-tooltip land in subsequent 10b.4 / 10b.5
// commits — they layer on top of this without restructuring.
// ============================================================================

import * as Cesium from 'cesium';
import { getRawScenario, refreshScenarios } from '../systems/scenarios';
import {
	loadUserScenarios, saveUserScenario,
} from '../systems/scenarios/userScenarios.js';
import { getViewer } from '../world/cesiumWorld';
import { CommanderView } from '../systems/commanderView';

let _ctx = null;        // captured at install time so the editor can flip state
let _activeId = null;   // currently-loaded scenario id
let _activeJson = null; // raw scenario record (mutated by future edits)
let _entities = [];     // Cesium entities for spawn markers
let _panel = null;      // bottom-left overlay DOM
let _previousState = null;

// Marker color by team. Cesium colors so the markers look at home in
// the commander view.
const TEAM_COLORS = {
	'friendly':     Cesium.Color.fromCssColorString('#40d0ff'),
	'hostile-red':  Cesium.Color.fromCssColorString('#ff4040'),
	'hostile-blue': Cesium.Color.fromCssColorString('#ff8080'),
	'neutral':      Cesium.Color.fromCssColorString('#ffd040'),
};
const COLOR_FALLBACK = Cesium.Color.fromCssColorString('#cccccc');
const COLOR_RANDOM   = Cesium.Color.fromCssColorString('#a070ff');  // violet

// Entry point — install the listener once at boot.
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
	_activeJson = JSON.parse(JSON.stringify(json));     // deep copy

	// Hide the main menu so the editor view isn't covered.
	const menu = document.getElementById('mainMenu');
	if (menu) menu.classList.add('hidden');

	// Stamp the EDITING state so animateLoop gives us camera-only
	// rendering (no physics, no NPCs ticking).
	if (_ctx) {
		_previousState = _ctx.currentState;
		_ctx.setCurrentState('EDITING');
	}

	// Bring up the commander map on the scenario anchor or the first
	// spawn's location, whichever is more useful. Lazy-create the
	// commander view if we're entering the editor straight from the
	// menu (no flight session has run yet, so simLoop hasn't done
	// the lazy-init).
	if (_ctx && !_ctx.commanderView) {
		const viewer = getViewer();
		if (viewer) {
			const cv = new CommanderView(viewer);
			_ctx.setCommanderView(cv);
			if (_ctx.controller) _ctx.controller.commanderView = cv;
		}
	}
	const view = _ctx && _ctx.commanderView;
	const lookAt = _firstAnchorLikePoint(_activeJson);
	if (view) view.setActive(true, lookAt);

	_renderSpawnMarkers();
	_buildPanel();
}

function _close() {
	for (const e of _entities) {
		try { getViewer().entities.remove(e); } catch (err) { void err; }
	}
	_entities.length = 0;

	if (_panel && _panel.parentNode) _panel.parentNode.removeChild(_panel);
	_panel = null;

	const view = _ctx && _ctx.commanderView;
	if (view) view.setActive(false);

	if (_ctx) _ctx.setCurrentState(_previousState || 'MENU');
	_previousState = null;

	const menu = document.getElementById('mainMenu');
	if (menu) menu.classList.remove('hidden');

	_activeId = null;
	_activeJson = null;
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

// Display position: literal origin coords directly; for random
// origins use the centre as a stand-in (and the marker carries a
// distinguishing colour). For player-relative we fall back to the
// scenario anchor.
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
		// We don't know the player position at edit time. Pin to
		// the anchor (or 0,0 fallback).
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
	// Default — pick a sensible fallback (centre of the player's
	// last-known geocode, otherwise (0,0)). For now just (0,0).
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

// ----- Overlay panel --------------------------------------------------------

function _buildPanel() {
	const panel = document.createElement('div');
	panel.id = 'scenario-editor-panel';
	panel.style.cssText = `
		position: fixed;
		left: 16px;
		top: 16px;
		width: 320px;
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
	panel.innerHTML = `
		<div style="color:#6ff;font-weight:bold;border-bottom:1px solid rgba(0,220,255,0.35);padding-bottom:5px;margin-bottom:8px;display:flex;justify-content:space-between;">
			<span>SCENARIO EDITOR</span>
			<span style="opacity:0.6;font-size:10px;">10b.3</span>
		</div>
		<div style="margin-bottom:6px;">
			<input id="se-name" type="text" value="${escapeAttr(_activeJson.name || '')}"
				style="width:100%;background:rgba(0,0,0,0.4);border:1px solid rgba(0,220,255,0.35);color:#c0eeff;font-family:inherit;font-size:12px;padding:3px 6px;letter-spacing:0.5px;">
		</div>
		<div style="opacity:0.7;margin-bottom:8px;font-size:10px;">id: <span style="color:#fff">${escapeHtml(_activeId)}</span></div>
		<div style="margin-bottom:8px;">
			<div style="opacity:0.7;font-size:10px;">SPAWNS</div>
			<div id="se-spawn-list" style="max-height:240px;overflow-y:auto;margin-top:4px;"></div>
		</div>
		<div style="display:flex;gap:8px;">
			<button id="se-save" type="button" style="flex:1;font-family:inherit;font-size:11px;letter-spacing:1px;background:transparent;border:1px solid #6ff;color:#6ff;padding:5px;cursor:pointer;">SAVE</button>
			<button id="se-exit" type="button" style="flex:1;font-family:inherit;font-size:11px;letter-spacing:1px;background:transparent;border:1px solid #ff8080;color:#ff8080;padding:5px;cursor:pointer;">EXIT</button>
		</div>
		<div style="margin-top:8px;opacity:0.6;font-size:10px;">
			Click-to-place + drag-to-move land in 10b.4. For now this just shows the spawns.
		</div>
	`;
	document.body.appendChild(panel);
	_panel = panel;

	panel.querySelector('#se-name').addEventListener('input', (e) => {
		_activeJson.name = e.target.value;
	});
	panel.querySelector('#se-save').addEventListener('click', () => {
		saveUserScenario(_activeId, _activeJson);
		refreshScenarios();
		// Brief flash on the SAVE button so the user gets visual
		// feedback that something happened.
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

function _renderSpawnList() {
	if (!_panel || !_activeJson) return;
	const list = _panel.querySelector('#se-spawn-list');
	if (!list) return;
	const spawns = _activeJson.spawns || [];
	if (spawns.length === 0) {
		list.innerHTML = '<div style="opacity:0.5;font-size:10px;font-style:italic;">no spawns yet</div>';
		return;
	}
	list.innerHTML = spawns.map((s, i) => {
		const label = _spawnLabel(s);
		return `<div style="padding:2px 0;border-bottom:1px dotted rgba(0,220,255,0.15);">
			<span style="opacity:0.5;display:inline-block;width:18px;">${i + 1}.</span>
			<span>${escapeHtml(label)}</span>
		</div>`;
	}).join('');
}

function escapeHtml(s) {
	return String(s)
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function escapeAttr(s) { return escapeHtml(s); }
