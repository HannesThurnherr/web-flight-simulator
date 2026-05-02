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
// Index into _activeJson.spawns of the spawn whose next terrain
// click should MOVE it (set by clicking MOVE on a spawn-list row).
// null = next click drops a new unit instead.
let _pendingMoveIdx = null;
// When non-null, the next terrain-click ADDS a waypoint to the
// selected spawn's pilot.params.<route>. Format: { spawnIdx, route }
// where route is 'waypoints' (patrol) or 'ingressWaypoints' /
// 'egressWaypoints' (strike).
let _pendingAddWaypoint = null;
// Active drag state. While set, pointermove updates the dragged
// thing's coords. Cleared on pointerup.
//   { kind: 'spawn'    , spawnIdx }
//   { kind: 'waypoint' , spawnIdx, route, wpIdx }
let _drag = null;
// Direct DOM listener handles, captured at install so we can
// removeEventListener on close.
let _editorPointerDown = null;
let _editorPointerMove = null;
let _editorPointerUp   = null;
let _editorContextMenu = null;
// Currently-selected spawn index (set by clicking a marker on the
// map or a row in the spawn list). The edit form in the panel
// targets this spawn; null = no selection, panel shows the
// general placement palette.
let _selectedIdx = null;

// What the next click drops. Mutable; set by the palette in the side
// panel.
let _armedKind = 'fighter';        // 'fighter' | 'platform'
let _armedSubId = 'f-15';          // plane id (when fighter) OR platform id
let _armedTeam = 'hostile-red';
let _armedAltM = 8000;             // air-unit altitude for the next click

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
const COLOR_ANCHOR   = Cesium.Color.fromCssColorString('#ffd700'); // gold
const COLOR_PSPAWN   = Cesium.Color.fromCssColorString('#00ffaa'); // bright green-cyan

const TEAMS = ['friendly', 'hostile-red', 'hostile-blue', 'neutral'];

const DEFAULT_AIR_ALT_M    = 8000;
const DEFAULT_FIGHTER_SPD  = 250;

export function setupScenarioEditor(ctx) {
	_ctx = ctx;
	window.addEventListener('scenario-edit-request', (e) => {
		const detail = e && e.detail;
		if (!detail || !detail.id) return;
		open(detail.id, detail.json || null);
	});
}

function open(id, providedJson = null) {
	let json = providedJson;
	if (!json) {
		const userScenarios = loadUserScenarios();
		json = userScenarios[id] || getRawScenario(id);
	}
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
		const lookAt = _firstAnchorLikePoint(_activeJson);
		view.setActive(true, lookAt);
		// If we have a sensible center (anchor / first spawn / saved
		// player position), zoom in to a regional level. If we DON'T
		// (empty scenario, geolocation hasn't completed, etc.), open
		// at near-planet zoom so the user can pan around to find
		// where they want to work instead of being stranded over
		// Jakarta — main.js's default state.lon/lat — until they
		// figure out how to fly the camera.
		if (lookAt) {
			view.centerLon = lookAt.lon;
			view.centerLat = lookAt.lat;
			view.distance  = 800000;     // 800 km regional
			view.tilt      = 12;
		} else {
			view.distance  = 20000000;   // 20 000 km — full-globe
			view.tilt      = 5;
		}
		_applyPlayerMarkerSuppression(view);
	}

	_installClickHandler();
	_renderSpawnMarkers();
	_buildPanel();
}

// World-anchored scenarios show their own ANCHOR + PLAYER START
// markers; the live commander-view PLAYER marker is irrelevant and
// confusing. Player-relative scenarios DO use the player position
// as their reference, so the live marker stays.
function _applyPlayerMarkerSuppression(view) {
	if (!view || !_activeJson) return;
	const isWorldAnchored = _activeJson.anchor && _activeJson.anchor.mode === 'world';
	view.suppressPlayerMarker = isWorldAnchored;
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
	_pendingMoveIdx = null;
	_selectedIdx = null;
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
		// Click landed on a tagged editor entity → select that spawn
		// instead of dropping / moving. Each spawn marker carries
		// __editorSpawnIdx (see _renderSpawnMarkers).
		if (d.entity && Number.isFinite(d.entity.__editorSpawnIdx)) {
			_selectSpawn(d.entity.__editorSpawnIdx);
			return;
		}
		// Empty-terrain click. If a MOVE is armed, _dropUnitAt
		// relocates that spawn; otherwise it drops a new unit using
		// the palette settings.
		_dropUnitAt(d.lon, d.lat, d.alt || 0);
	};
	window.addEventListener('commander-terrain-click', _clickHandler);

	// Capture-phase pointer handlers run BEFORE commander view's
	// pan/tilt logic, so we can intercept marker drags without the
	// camera also panning. If the pointerdown isn't on one of our
	// markers we don't preventDefault — commander view's bubble-
	// phase listener gets the event and handles pan as usual.
	_editorPointerDown = (e) => _onEditorPointerDown(e);
	_editorPointerMove = (e) => _onEditorPointerMove(e);
	_editorPointerUp   = (e) => _onEditorPointerUp(e);
	_editorContextMenu = (e) => _onEditorContextMenu(e);
	window.addEventListener('pointerdown', _editorPointerDown, true);
	window.addEventListener('pointermove', _editorPointerMove, true);
	window.addEventListener('pointerup',   _editorPointerUp,   true);
	window.addEventListener('contextmenu', _editorContextMenu, true);
}

function _selectSpawn(idx) {
	if (!_activeJson || !Array.isArray(_activeJson.spawns)) return;
	if (idx < 0 || idx >= _activeJson.spawns.length) return;
	_selectedIdx = idx;
	_pendingMoveIdx = null;
	_renderSpawnMarkers();
	_buildPanel();
}

function _deselect() {
	_selectedIdx = null;
	_renderSpawnMarkers();
	_buildPanel();
}

function _uninstallClickHandler() {
	if (_clickHandler) {
		window.removeEventListener('commander-terrain-click', _clickHandler);
		_clickHandler = null;
	}
	if (_editorPointerDown) {
		window.removeEventListener('pointerdown', _editorPointerDown, true);
		window.removeEventListener('pointermove', _editorPointerMove, true);
		window.removeEventListener('pointerup',   _editorPointerUp,   true);
		window.removeEventListener('contextmenu', _editorContextMenu, true);
		_editorPointerDown = _editorPointerMove = _editorPointerUp = _editorContextMenu = null;
	}
	_drag = null;
}

// ----- Direct manipulation: drag-to-move + right-click delete ------------

// Pick whatever editor entity is under the screen cursor. Returns
// the entity (with our __editor* tags) or null.
function _pickEditorEntity(x, y) {
	const viewer = getViewer();
	if (!viewer) return null;
	const picked = viewer.scene.pick(new Cesium.Cartesian2(x, y));
	if (!picked || !picked.id) return null;
	const id = picked.id;
	if (Number.isFinite(id.__editorSpawnIdx)) return id;
	if (id.__editorWaypointRoute && Number.isFinite(id.__editorWaypointIdx)) return id;
	return null;
}

// Convert screen coords to lon/lat/alt by ray-casting the globe.
function _pickTerrain(x, y) {
	const viewer = getViewer();
	if (!viewer) return null;
	const ray = viewer.camera.getPickRay(new Cesium.Cartesian2(x, y));
	if (!ray) return null;
	const cart = viewer.scene.globe.pick(ray, viewer.scene);
	if (!cart) return null;
	const carto = Cesium.Cartographic.fromCartesian(cart);
	return {
		lon: Cesium.Math.toDegrees(carto.longitude),
		lat: Cesium.Math.toDegrees(carto.latitude),
		alt: carto.height || 0,
	};
}

function _onEditorPointerDown(e) {
	if (!_activeJson || e.button !== 0) return;
	if (_isPanelTarget(e.target)) return;
	const ent = _pickEditorEntity(e.clientX, e.clientY);
	if (!ent) return;
	if (Number.isFinite(ent.__editorSpawnIdx)) {
		_drag = { kind: 'spawn', spawnIdx: ent.__editorSpawnIdx };
		_selectSpawn(ent.__editorSpawnIdx);
	} else {
		_drag = {
			kind: 'waypoint',
			spawnIdx: _selectedIdx,
			route: ent.__editorWaypointRoute,
			wpIdx: ent.__editorWaypointIdx,
		};
	}
	// Capture-phase + stopPropagation prevents commander view's
	// bubble-phase pointerdown from also starting a pan drag.
	e.stopPropagation();
	e.preventDefault();
}

function _onEditorPointerMove(e) {
	if (!_drag) return;
	const pt = _pickTerrain(e.clientX, e.clientY);
	if (!pt) return;
	if (_drag.kind === 'spawn') {
		const s = _activeJson.spawns && _activeJson.spawns[_drag.spawnIdx];
		if (!s) return;
		if (!s.origin || typeof s.origin.lon !== 'number') s.origin = { lon: 0, lat: 0, alt: 0 };
		s.origin.lon = pt.lon;
		s.origin.lat = pt.lat;
		// Ground platforms re-clamp altitude to terrain on drag so
		// they don't end up underground when moved across hills.
		if (s.platformId && _platformIsGround(s.platformId)) s.origin.alt = pt.alt;
	} else if (_drag.kind === 'waypoint') {
		const s = _activeJson.spawns && _activeJson.spawns[_drag.spawnIdx];
		if (!s || !s.pilot || !s.pilot.params) return;
		const list = s.pilot.params[_drag.route];
		if (!Array.isArray(list) || !list[_drag.wpIdx]) return;
		list[_drag.wpIdx].lon = pt.lon;
		list[_drag.wpIdx].lat = pt.lat;
	}
	_renderSpawnMarkers();
	e.stopPropagation();
	e.preventDefault();
}

function _onEditorPointerUp(e) {
	if (!_drag) return;
	_drag = null;
	_renderSpawnList();
	_renderWaypointPanel();
	e.stopPropagation();
	e.preventDefault();
}

function _onEditorContextMenu(e) {
	if (!_activeJson) return;
	if (_isPanelTarget(e.target)) return;
	const ent = _pickEditorEntity(e.clientX, e.clientY);
	if (!ent) {
		// Suppress browser context menu while in editor mode —
		// right-drag tilts the camera and a stray menu would
		// interrupt.
		e.preventDefault();
		return;
	}
	if (Number.isFinite(ent.__editorSpawnIdx)) {
		const idx = ent.__editorSpawnIdx;
		_activeJson.spawns.splice(idx, 1);
		if (_pendingMoveIdx === idx) _pendingMoveIdx = null;
		else if (_pendingMoveIdx != null && _pendingMoveIdx > idx) _pendingMoveIdx--;
		if (_selectedIdx === idx) _selectedIdx = null;
		else if (_selectedIdx != null && _selectedIdx > idx) _selectedIdx--;
		_renderSpawnMarkers();
		_buildPanel();
	} else if (ent.__editorWaypointRoute && Number.isFinite(ent.__editorWaypointIdx)) {
		const s = _activeJson.spawns && _activeJson.spawns[_selectedIdx];
		if (s && s.pilot && s.pilot.params) {
			const list = s.pilot.params[ent.__editorWaypointRoute];
			if (Array.isArray(list)) list.splice(ent.__editorWaypointIdx, 1);
			_renderSpawnMarkers();
			_renderWaypointPanel();
		}
	}
	e.stopPropagation();
	e.preventDefault();
}

function _isPanelTarget(target) {
	if (!target || !target.closest) return false;
	return !!target.closest('#scenario-editor-panel');
}

function _dropUnitAt(lon, lat, terrainH) {
	if (!_activeJson) return;

	// Pending ADD WAYPOINT — append to the spawn's pilot route.
	if (_pendingAddWaypoint) {
		const { spawnIdx, route } = _pendingAddWaypoint;
		const s = _activeJson.spawns && _activeJson.spawns[spawnIdx];
		if (!s || !s.pilot) { _pendingAddWaypoint = null; }
		else {
			s.pilot.params = s.pilot.params || {};
			s.pilot.params[route] = s.pilot.params[route] || [];
			s.pilot.params[route].push({
				lon, lat,
				altM: _armedAltM,
				speedMps: 250,
			});
			// Stay armed so the user can keep clicking to add a chain
			// of waypoints. Click "DONE" in the panel (re-clicking the
			// ADD button) to disarm.
			_renderSpawnMarkers();
			_renderWaypointPanel();
		}
		return;
	}

	// Pending MOVE? Relocate the spawn we previously armed for move
	// instead of dropping a new one.
	if (_pendingMoveIdx != null
		&& Array.isArray(_activeJson.spawns)
		&& _activeJson.spawns[_pendingMoveIdx]) {
		const s = _activeJson.spawns[_pendingMoveIdx];
		const wasGround = _platformIsGround(s.platformId);
		// Only mutate origin to a literal lon/lat/alt — drop random
		// origin specs, since "click here" doesn't make sense for a
		// random-disc spawn.
		const newAlt = wasGround
			? terrainH
			: ((s.origin && typeof s.origin.alt === 'number')
				? s.origin.alt
				: _armedAltM);
		s.origin = { lon, lat, alt: newAlt };
		_pendingMoveIdx = null;
		_renderSpawnMarkers();
		_renderSpawnList();
		return;
	}

	const spawn = {
		type: _armedKind,
		team: _armedTeam,
		origin: { lon, lat, alt: 0 },
	};
	if (_armedKind === 'fighter') {
		spawn.fighterModel = _armedSubId;
		spawn.origin.alt = _armedAltM;
		spawn.speedMps = DEFAULT_FIGHTER_SPD;
	} else {
		spawn.platformId = _armedSubId;
		const isGround = _platformIsGround(_armedSubId);
		spawn.origin.alt = isGround ? terrainH : _armedAltM;
		// Orbit-pilot platforms (AWACS, tankers, ISR drones) default
		// to a 40 km orbit radius around the spawn point — way too
		// big when the user clicks "place AWACS HERE." Override to
		// a tighter 8 km circle so the platform stays visible at
		// the dropped location. Author can hand-edit pilotOverrides
		// in the JSON for a wider patrol orbit.
		const plat = PLATFORMS[_armedSubId];
		if (plat && plat.pilot && plat.pilot.type === 'orbit') {
			spawn.pilotOverrides = {
				radiusM:    8000,
				altitudeM:  _armedAltM,
				targetSpeed: (plat.pilot.defaultParams && plat.pilot.defaultParams.targetSpeed) || 180,
			};
		}
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

	// World-anchored mode: draw ANCHOR + PLAYER START markers so the
	// user can see where the scenario "lives" geographically and
	// where they themselves spawn. Player-relative mode skips both —
	// the commander view's live PLAYER marker handles it.
	if (_activeJson.anchor && _activeJson.anchor.mode === 'world'
		&& typeof _activeJson.anchor.worldLon === 'number') {
		const a = _activeJson.anchor;
		_entities.push(viewer.entities.add({
			position: Cesium.Cartesian3.fromDegrees(a.worldLon, a.worldLat, 0),
			point: {
				pixelSize: 14,
				color: COLOR_ANCHOR,
				outlineColor: Cesium.Color.BLACK,
				outlineWidth: 2,
				disableDepthTestDistance: Number.POSITIVE_INFINITY,
			},
			label: {
				text: 'ANCHOR',
				font: '11px AceCombat, monospace',
				pixelOffset: new Cesium.Cartesian2(16, 0),
				fillColor: COLOR_ANCHOR,
				outlineColor: Cesium.Color.BLACK,
				outlineWidth: 2,
				style: Cesium.LabelStyle.FILL_AND_OUTLINE,
				disableDepthTestDistance: Number.POSITIVE_INFINITY,
				horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
			},
		}));
		const ps = a.playerSpawn;
		if (ps && typeof ps.lon === 'number') {
			_entities.push(viewer.entities.add({
				position: Cesium.Cartesian3.fromDegrees(ps.lon, ps.lat, ps.alt || 0),
				point: {
					pixelSize: 14,
					color: COLOR_PSPAWN,
					outlineColor: Cesium.Color.BLACK,
					outlineWidth: 2,
					disableDepthTestDistance: Number.POSITIVE_INFINITY,
				},
				label: {
					text: `PLAYER START${ps.alt ? ` ${Math.round(ps.alt)} m` : ''}`,
					font: '11px AceCombat, monospace',
					pixelOffset: new Cesium.Cartesian2(16, 0),
					fillColor: COLOR_PSPAWN,
					outlineColor: Cesium.Color.BLACK,
					outlineWidth: 2,
					style: Cesium.LabelStyle.FILL_AND_OUTLINE,
					disableDepthTestDistance: Number.POSITIVE_INFINITY,
					horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
				},
			}));
		}
	}

	const spawns = Array.isArray(_activeJson.spawns) ? _activeJson.spawns : [];
	for (let i = 0; i < spawns.length; i++) {
		const s = spawns[i];
		const pt = _resolveSpawnPositionForDisplay(s, _activeJson);
		if (!pt) continue;
		const team  = (typeof s.team === 'string') ? s.team : null;
		const color = TEAM_COLORS[team] || COLOR_FALLBACK;
		const isRandom = _spawnIsRandom(s);
		const isSelected = (i === _selectedIdx);
		const ent = viewer.entities.add({
			position: Cesium.Cartesian3.fromDegrees(pt.lon, pt.lat, pt.alt || 0),
			point: {
				pixelSize: isSelected ? 16 : 12,
				color: isRandom ? COLOR_RANDOM : color,
				outlineColor: isSelected
					? Cesium.Color.YELLOW
					: Cesium.Color.WHITE.withAlpha(0.7),
				outlineWidth: isSelected ? 3 : 1.5,
				disableDepthTestDistance: Number.POSITIVE_INFINITY,
			},
			label: {
				text: _spawnLabel(s),
				font: '11px AceCombat, monospace',
				pixelOffset: new Cesium.Cartesian2(14, 0),
				fillColor: isSelected
					? Cesium.Color.YELLOW
					: (isRandom ? COLOR_RANDOM : color),
				outlineColor: Cesium.Color.BLACK,
				outlineWidth: 2,
				style: Cesium.LabelStyle.FILL_AND_OUTLINE,
				disableDepthTestDistance: Number.POSITIVE_INFINITY,
				horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
			},
		});
		// Tag the entity so the click handler can identify it as an
		// editor marker and route to _selectSpawn instead of dropping
		// a new unit on top.
		ent.__editorSpawnIdx = i;
		_entities.push(ent);
	}

	// Waypoint visualisation — only for the currently-selected
	// spawn. Rendering every spawn's waypoints on the map at once
	// gets cluttered fast, and the selected-spawn case is when the
	// user actually cares.
	if (_selectedIdx != null && _activeJson.spawns) {
		const sel = _activeJson.spawns[_selectedIdx];
		if (sel && sel.pilot && sel.pilot.params) {
			const params = sel.pilot.params;
			const ptype = sel.pilot.type;
			if (ptype === 'patrol') {
				_drawRoute(viewer, params.waypoints, '#00ffaa', 'WP', !!params.loop, 'waypoints');
			} else if (ptype === 'strike') {
				_drawRoute(viewer, params.ingressWaypoints, '#ffaa44', 'IN', false, 'ingressWaypoints');
				_drawRoute(viewer, params.egressWaypoints,  '#aa88ff', 'EG', false, 'egressWaypoints');
			}
		}
	}
}

// Draw a polyline between waypoints + a numbered marker at each
// vertex. Polyline closes the loop when `loop` is true (patrol). The
// markers are pushed to _entities so they get cleaned up on the
// next render or on close.
function _drawRoute(viewer, list, hex, prefix, loop, routeKey) {
	if (!Array.isArray(list) || list.length === 0) return;
	const colour = Cesium.Color.fromCssColorString(hex);
	const positions = [];
	for (let i = 0; i < list.length; i++) {
		const wp = list[i];
		positions.push(Cesium.Cartesian3.fromDegrees(wp.lon, wp.lat, wp.altM || 0));
		const ent = viewer.entities.add({
			position: Cesium.Cartesian3.fromDegrees(wp.lon, wp.lat, wp.altM || 0),
			point: {
				pixelSize: 11,
				color: colour,
				outlineColor: Cesium.Color.BLACK,
				outlineWidth: 1.5,
				disableDepthTestDistance: Number.POSITIVE_INFINITY,
			},
			label: {
				text: `${prefix}${i + 1}`,
				font: '10px AceCombat, monospace',
				pixelOffset: new Cesium.Cartesian2(11, 0),
				fillColor: colour,
				outlineColor: Cesium.Color.BLACK,
				outlineWidth: 2,
				style: Cesium.LabelStyle.FILL_AND_OUTLINE,
				disableDepthTestDistance: Number.POSITIVE_INFINITY,
				horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
			},
		});
		// Tags so the drag + right-click handlers can resolve which
		// waypoint was picked. Stored on the entity itself; we look
		// them up in _pickEditorEntity.
		ent.__editorWaypointRoute = routeKey;
		ent.__editorWaypointIdx   = i;
		_entities.push(ent);
	}
	if (positions.length < 2) return;
	if (loop) positions.push(positions[0]);
	_entities.push(viewer.entities.add({
		polyline: {
			positions,
			width: 2,
			material: new Cesium.PolylineDashMaterialProperty({
				color: colour.withAlpha(0.8),
				dashLength: 16.0,
			}),
			arcType: Cesium.ArcType.NONE,
			clampToGround: false,
		},
	}));
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
	// Only return a location if the scenario itself supplies one — a
	// world anchor or an existing spawn. We deliberately don't fall
	// back to ctx.state.lon/lat here: state defaults to Jakarta in
	// main.js and is only later overwritten by an async ipapi.co
	// geolocation. New scenarios opened before geolocation completes
	// would otherwise center on Jakarta and force the user to pan
	// across the planet to find where they actually want to work.
	// Returning null lets the editor open at a near-planet zoom so
	// the user can pan to anywhere visible.
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
	const spawns = (json && json.spawns) || [];
	for (const s of spawns) {
		const pt = _resolveSpawnPositionForDisplay(s, json);
		if (pt && (pt.lon !== 0 || pt.lat !== 0)) return pt;
	}
	return null;
}

// ----- Side panel ----------------------------------------------------------

// Ensure anchor.playerSpawn exists with sensible defaults so the
// later chain of edits doesn't have to null-check.
function _ensurePlayerSpawn() {
	if (!_activeJson.anchor) _activeJson.anchor = { mode: 'world' };
	if (!_activeJson.anchor.playerSpawn) {
		const view = _ctx && _ctx.commanderView;
		_activeJson.anchor.playerSpawn = {
			lon: (view && view.centerLon) || _activeJson.anchor.worldLon || 0,
			lat: (view && view.centerLat) || _activeJson.anchor.worldLat || 0,
			alt: 6000,
			heading: 0,
			speed: 250,
		};
	}
}

// Switch anchor mode. WORLD prefills worldLon/Lat from the current
// view centre + a player spawn at the same location at a sensible
// cruise altitude. Switching back to player-relative drops the
// world fields entirely (clean JSON).
function _setAnchorMode(mode) {
	if (!_activeJson.anchor) _activeJson.anchor = {};
	if (mode === 'world') {
		const view = _ctx && _ctx.commanderView;
		_activeJson.anchor = {
			mode: 'world',
			worldLon: (view && view.centerLon) || 0,
			worldLat: (view && view.centerLat) || 0,
		};
		_ensurePlayerSpawn();
	} else {
		_activeJson.anchor = { mode: 'player-relative' };
	}
	const view = _ctx && _ctx.commanderView;
	_applyPlayerMarkerSuppression(view);
	_buildPanel();
	_renderSpawnMarkers();
}

function _buildPanel() {
	// Tear down any existing panel before re-rendering so the
	// listeners don't accumulate on each rebuild.
	if (_panel && _panel.parentNode) _panel.parentNode.removeChild(_panel);
	_panel = null;
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

	// Palette listeners (only present when NOT editing a spawn).
	const seKind = panel.querySelector('#se-kind');
	const seSub  = panel.querySelector('#se-sub');
	const seTeam = panel.querySelector('#se-team');
	const seAlt  = panel.querySelector('#se-alt');
	if (seKind) seKind.addEventListener('change', (e) => {
		_armedKind = e.target.value;
		const sub = panel.querySelector('#se-sub');
		if (_armedKind === 'fighter') {
			sub.innerHTML = _optionsFor(Object.keys(PLANES).sort(), _armedSubId);
		} else {
			sub.innerHTML = _optionsFor(Object.keys(PLATFORMS).sort(), _armedSubId);
		}
		_armedSubId = sub.value;
	});
	if (seSub) seSub.addEventListener('change', (e) => {
		_armedSubId = e.target.value;
	});
	if (seTeam) seTeam.addEventListener('change', (e) => {
		_armedTeam = e.target.value;
	});
	if (seAlt) seAlt.addEventListener('change', (e) => {
		const v = parseFloat(e.target.value);
		if (Number.isFinite(v)) _armedAltM = v;
	});

	// Edit-form listeners (only present when a spawn IS selected).
	_wireEditForm(panel);

	// Anchor mode tabs.
	panel.querySelector('#se-anc-rel').addEventListener('click', () => {
		_setAnchorMode('player-relative');
	});
	panel.querySelector('#se-anc-abs').addEventListener('click', () => {
		_setAnchorMode('world');
	});

	// Anchor + player-spawn inputs (only present in world-anchored).
	const ancLon = panel.querySelector('#se-anc-lon');
	const ancLat = panel.querySelector('#se-anc-lat');
	const ancHere = panel.querySelector('#se-anc-here');
	const psLon = panel.querySelector('#se-ps-lon');
	const psLat = panel.querySelector('#se-ps-lat');
	const psAlt = panel.querySelector('#se-ps-alt');
	const psHere = panel.querySelector('#se-ps-here');
	if (ancLon) ancLon.addEventListener('change', (e) => {
		_activeJson.anchor.worldLon = parseFloat(e.target.value);
		_renderSpawnMarkers();
	});
	if (ancLat) ancLat.addEventListener('change', (e) => {
		_activeJson.anchor.worldLat = parseFloat(e.target.value);
		_renderSpawnMarkers();
	});
	if (ancHere) ancHere.addEventListener('click', () => {
		const view = _ctx && _ctx.commanderView;
		if (!view) return;
		_activeJson.anchor.worldLon = view.centerLon;
		_activeJson.anchor.worldLat = view.centerLat;
		_buildPanel();   // refresh inputs
		_renderSpawnMarkers();
	});
	if (psLon) psLon.addEventListener('change', (e) => {
		_ensurePlayerSpawn();
		_activeJson.anchor.playerSpawn.lon = parseFloat(e.target.value);
		_renderSpawnMarkers();
	});
	if (psLat) psLat.addEventListener('change', (e) => {
		_ensurePlayerSpawn();
		_activeJson.anchor.playerSpawn.lat = parseFloat(e.target.value);
		_renderSpawnMarkers();
	});
	if (psAlt) psAlt.addEventListener('change', (e) => {
		_ensurePlayerSpawn();
		const v = parseFloat(e.target.value);
		if (Number.isFinite(v)) _activeJson.anchor.playerSpawn.alt = v;
		_renderSpawnMarkers();
	});
	if (psHere) psHere.addEventListener('click', () => {
		const view = _ctx && _ctx.commanderView;
		if (!view) return;
		_ensurePlayerSpawn();
		_activeJson.anchor.playerSpawn.lon = view.centerLon;
		_activeJson.anchor.playerSpawn.lat = view.centerLat;
		_buildPanel();
		_renderSpawnMarkers();
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

	const isWorldAnchored = _activeJson.anchor && _activeJson.anchor.mode === 'world';
	const anchor = _activeJson.anchor || {};
	const ps = anchor.playerSpawn || {};
	const selected = (_selectedIdx != null && _activeJson.spawns)
		? _activeJson.spawns[_selectedIdx] : null;

	const anchorSection = isWorldAnchored
		? `
		<div style="font-size:10px;opacity:0.7;margin-bottom:3px;">WORLD ANCHOR (lon, lat) — units placed here are absolute</div>
		<div style="display:flex;gap:4px;font-size:10px;margin-bottom:5px;">
			<input id="se-anc-lon" type="number" step="0.0001" value="${anchor.worldLon ?? ''}" style="${_selectCss()}flex:1;" placeholder="lon">
			<input id="se-anc-lat" type="number" step="0.0001" value="${anchor.worldLat ?? ''}" style="${_selectCss()}flex:1;" placeholder="lat">
			<button id="se-anc-here" type="button" style="${_btnCss()}">HERE</button>
		</div>
		<div style="font-size:10px;opacity:0.7;margin-bottom:3px;">PLAYER START (lon, lat, alt m)</div>
		<div style="display:flex;gap:4px;font-size:10px;margin-bottom:5px;">
			<input id="se-ps-lon" type="number" step="0.0001" value="${ps.lon ?? ''}" style="${_selectCss()}flex:1;" placeholder="lon">
			<input id="se-ps-lat" type="number" step="0.0001" value="${ps.lat ?? ''}" style="${_selectCss()}flex:1;" placeholder="lat">
		</div>
		<div style="display:flex;gap:4px;font-size:10px;">
			<input id="se-ps-alt" type="number" step="100" value="${ps.alt ?? 6000}" style="${_selectCss()}flex:1;" placeholder="alt m">
			<button id="se-ps-here" type="button" style="${_btnCss()}">HERE</button>
		</div>
		`
		: `<div style="font-size:10px;opacity:0.7;">Spawns are placed RELATIVE TO THE PLAYER. The player marker on the map shows where the player will spawn.</div>`;

	return `
	<div style="color:#6ff;font-weight:bold;border-bottom:1px solid rgba(0,220,255,0.35);padding-bottom:5px;margin-bottom:8px;display:flex;justify-content:space-between;">
		<span>SCENARIO EDITOR</span>
		<span style="opacity:0.6;font-size:10px;">10b.5</span>
	</div>

	<div style="margin-bottom:6px;">
		<input id="se-name" type="text" value="${escapeAttr(_activeJson.name || '')}"
			style="width:100%;background:rgba(0,0,0,0.4);border:1px solid rgba(0,220,255,0.35);color:#c0eeff;font-family:inherit;font-size:12px;padding:3px 6px;letter-spacing:0.5px;">
	</div>
	<div style="opacity:0.7;margin-bottom:8px;font-size:10px;">id: <span style="color:#fff">${escapeHtml(_activeId)}</span></div>

	<div style="margin-top:8px;border-top:1px solid rgba(0,220,255,0.2);padding-top:6px;">
		<div style="opacity:0.7;font-size:10px;margin-bottom:4px;">ANCHOR MODE</div>
		<div style="display:flex;gap:0;margin-bottom:5px;">
			<button id="se-anc-rel" type="button" style="${_tabBtnCss(!isWorldAnchored)}flex:1;">PLAYER-RELATIVE</button>
			<button id="se-anc-abs" type="button" style="${_tabBtnCss(isWorldAnchored)}flex:1;">WORLD-ANCHORED</button>
		</div>
		${anchorSection}
	</div>

	${selected ? _editFormHtml(selected) : `
	<div style="margin-top:8px;border-top:1px solid rgba(0,220,255,0.2);padding-top:6px;">
		<div style="opacity:0.7;font-size:10px;margin-bottom:4px;">PALETTE — armed for next click</div>
		<div style="display:flex;gap:6px;margin-bottom:5px;">
			<select id="se-kind" style="${_selectCss()}flex:0 0 90px;">
				<option value="fighter"${_armedKind === 'fighter' ? ' selected' : ''}>fighter</option>
				<option value="platform"${_armedKind === 'platform' ? ' selected' : ''}>platform</option>
			</select>
			<select id="se-sub" style="${_selectCss()}flex:1;">${subOpts}</select>
		</div>
		<select id="se-team" style="${_selectCss()}width:100%;margin-bottom:5px;">${teamOpts}</select>
		<div style="display:flex;gap:6px;align-items:center;font-size:10px;">
			<span style="opacity:0.7;flex:0 0 auto;">altitude m:</span>
			<input id="se-alt" type="number" step="500" value="${_armedAltM}" style="${_selectCss()}flex:1;">
		</div>
	</div>`}

	<div style="margin-top:8px;border-top:1px solid rgba(0,220,255,0.2);padding-top:6px;">
		<div style="opacity:0.7;font-size:10px;">SPAWNS</div>
		<div id="se-spawn-list" style="max-height:200px;overflow-y:auto;margin-top:4px;"></div>
	</div>

	<div style="margin-top:8px;border-top:1px solid rgba(0,220,255,0.2);padding-top:6px;font-size:10px;opacity:0.75;">
		<div style="opacity:0.7;margin-bottom:4px;">CONTROLS</div>
		<div>· LEFT-CLICK terrain — drop armed unit (when nothing selected)</div>
		<div>· LEFT-CLICK marker — select</div>
		<div>· DRAG marker — move</div>
		<div>· RIGHT-CLICK marker — delete</div>
		<div>· LEFT-DRAG empty space — pan map</div>
		<div>· RIGHT-DRAG empty space — tilt map</div>
		<div>· WHEEL — zoom</div>
	</div>

	<div style="display:flex;gap:8px;margin-top:10px;">
		<button id="se-save" type="button" style="flex:1;font-family:inherit;font-size:11px;letter-spacing:1px;background:transparent;border:1px solid #6ff;color:#6ff;padding:5px;cursor:pointer;">SAVE</button>
		<button id="se-exit" type="button" style="flex:1;font-family:inherit;font-size:11px;letter-spacing:1px;background:transparent;border:1px solid #ff8080;color:#ff8080;padding:5px;cursor:pointer;">EXIT</button>
	</div>
	`;
}

function _wireEditForm(panel) {
	if (_selectedIdx == null || !_activeJson || !_activeJson.spawns) return;
	const s = _activeJson.spawns[_selectedIdx];
	if (!s) return;

	const deselect = panel.querySelector('#se-deselect');
	if (deselect) deselect.addEventListener('click', () => _deselect());

	const team = panel.querySelector('#ed-team');
	if (team) team.addEventListener('change', (e) => {
		s.team = e.target.value;
		_renderSpawnMarkers();
		_renderSpawnList();
	});

	const hdg = panel.querySelector('#ed-hdg');
	const hdgRand = panel.querySelector('#ed-hdg-rand');
	if (hdg) hdg.addEventListener('change', (e) => {
		const v = parseFloat(e.target.value);
		s.headingDeg = Number.isFinite(v) ? v : 0;
	});
	if (hdgRand) hdgRand.addEventListener('change', (e) => {
		if (e.target.checked) s.headingDeg = { any: true };
		else s.headingDeg = 0;
		_buildPanel();    // re-render to flip the input enabled state
	});

	const spd = panel.querySelector('#ed-spd');
	if (spd) spd.addEventListener('change', (e) => {
		const v = parseFloat(e.target.value);
		if (Number.isFinite(v)) s.speedMps = v;
		else delete s.speedMps;
	});

	const alt = panel.querySelector('#ed-alt');
	if (alt) alt.addEventListener('change', (e) => {
		const v = parseFloat(e.target.value);
		if (!s.origin) s.origin = {};
		if (Number.isFinite(v)) s.origin.alt = v;
		_renderSpawnMarkers();
		_renderSpawnList();
	});

	const cnt = panel.querySelector('#ed-cnt');
	const cntMin = panel.querySelector('#ed-cnt-min');
	const cntMax = panel.querySelector('#ed-cnt-max');
	const cntRand = panel.querySelector('#ed-cnt-rand');
	if (cnt) cnt.addEventListener('change', (e) => {
		const v = parseInt(e.target.value, 10);
		s.count = Number.isFinite(v) ? v : 1;
		_renderSpawnMarkers();
		_renderSpawnList();
	});
	if (cntMin) cntMin.addEventListener('change', (e) => {
		const v = parseInt(e.target.value, 10);
		if (typeof s.count !== 'object') s.count = { min: 1, max: 1 };
		if (Number.isFinite(v)) s.count.min = v;
		_renderSpawnList();
	});
	if (cntMax) cntMax.addEventListener('change', (e) => {
		const v = parseInt(e.target.value, 10);
		if (typeof s.count !== 'object') s.count = { min: 1, max: 1 };
		if (Number.isFinite(v)) s.count.max = v;
		_renderSpawnList();
	});
	if (cntRand) cntRand.addEventListener('change', (e) => {
		if (e.target.checked) {
			const cur = (typeof s.count === 'number') ? s.count : 1;
			s.count = { min: cur, max: Math.max(cur, cur + 2) };
		} else {
			s.count = (typeof s.count === 'object' && s.count) ? s.count.min : 1;
		}
		_buildPanel();
		_renderSpawnMarkers();
	});

	const intelEl = panel.querySelector('#ed-intel');
	if (intelEl) intelEl.addEventListener('change', (e) => {
		const v = e.target.value;
		if (v === 'none') delete s.intel;
		else {
			s.intel = s.intel || {};
			s.intel.level = v;
			if (v === 'suspected' && typeof s.intel.uncertaintyM !== 'number') {
				s.intel.uncertaintyM = 4000;
			}
		}
		_buildPanel();
		_renderSpawnMarkers();
	});
	const intelUncert = panel.querySelector('#ed-intel-uncert');
	if (intelUncert) intelUncert.addEventListener('change', (e) => {
		const v = parseFloat(e.target.value);
		if (!s.intel) s.intel = { level: 'suspected' };
		if (Number.isFinite(v)) s.intel.uncertaintyM = v;
	});

	const magEl = panel.querySelector('#ed-mag');
	if (magEl) magEl.addEventListener('change', (e) => {
		const v = parseInt(e.target.value, 10);
		if (!s.magazine) s.magazine = {};
		if (Number.isFinite(v)) s.magazine.missile = v;
		else delete s.magazine.missile;
	});

	// Pilot type — switching kinds rebuilds the whole edit form so
	// the relevant sub-section (waypoint editor / target tag inputs)
	// shows up.
	const pilotEl = panel.querySelector('#ed-pilot');
	if (pilotEl) pilotEl.addEventListener('change', (e) => {
		const v = e.target.value;
		if (v === 'default') {
			delete s.pilot;
		} else {
			s.pilot = s.pilot || {};
			s.pilot.type = v;
			s.pilot.params = s.pilot.params || {};
			if (v === 'patrol' && !Array.isArray(s.pilot.params.waypoints)) {
				s.pilot.params.waypoints = [];
				s.pilot.params.loop = true;
			}
			if (v === 'strike') {
				s.pilot.params.ingressWaypoints = s.pilot.params.ingressWaypoints || [];
				s.pilot.params.egressWaypoints  = s.pilot.params.egressWaypoints  || [];
				s.pilot.params.weaponType = s.pilot.params.weaponType || 'STORM-SHADOW';
				s.pilot.params.target = s.pilot.params.target || {};
			}
		}
		_pendingAddWaypoint = null;
		_buildPanel();
	});

	// Strike target tag + weapon dropdown.
	const strikeTag = panel.querySelector('#ed-strike-tag');
	if (strikeTag) strikeTag.addEventListener('change', (e) => {
		s.pilot.params.target = { tag: e.target.value || undefined };
	});
	const strikeWpn = panel.querySelector('#ed-strike-wpn');
	if (strikeWpn) strikeWpn.addEventListener('change', (e) => {
		s.pilot.params.weaponType = e.target.value;
	});

	// Escort tag.
	const escortTag = panel.querySelector('#ed-escort-tag');
	if (escortTag) escortTag.addEventListener('change', (e) => {
		s.pilot.params.escortTag = e.target.value || undefined;
	});

	// ADD WAYPOINT toggles. Each ADD button arms / disarms
	// click-to-add for its specific route key; clicking a different
	// route while one is already armed re-points the click target.
	for (const btn of panel.querySelectorAll('.ed-wp-add')) {
		btn.addEventListener('click', () => {
			const route = btn.getAttribute('data-route');
			const samePending = _pendingAddWaypoint
				&& _pendingAddWaypoint.spawnIdx === _selectedIdx
				&& _pendingAddWaypoint.route === route;
			_pendingAddWaypoint = samePending
				? null
				: { spawnIdx: _selectedIdx, route };
			_renderWaypointPanel();
		});
	}
	// DEL on individual waypoint rows.
	for (const btn of panel.querySelectorAll('.ed-wp-del')) {
		btn.addEventListener('click', () => {
			const route = btn.getAttribute('data-route');
			const idx = parseInt(btn.getAttribute('data-idx'), 10);
			if (s.pilot && s.pilot.params && Array.isArray(s.pilot.params[route])) {
				s.pilot.params[route].splice(idx, 1);
				_renderSpawnMarkers();
				_renderWaypointPanel();
			}
		});
	}
}

// Repaint just the pilot/route sub-section after a waypoint
// add / delete or arm-toggle, without rebuilding the entire panel
// (which would lose focus on any active input).
function _renderWaypointPanel() {
	if (!_panel || _selectedIdx == null) return;
	const s = _activeJson && _activeJson.spawns && _activeJson.spawns[_selectedIdx];
	if (!s) return;
	// Cheapest route: rebuild the whole edit-form section. It only
	// holds dropdowns + small inputs; rebuilding doesn't lose
	// information unlike rebuilding the whole panel.
	_buildPanel();
}

function _editFormHtml(s) {
	const teamOpts = TEAMS.map(t =>
		`<option value="${t}"${t === s.team ? ' selected' : ''}>${t}</option>`).join('');
	const isFighter = (s.type === 'fighter');
	const isPlatform = (s.type === 'platform');
	const isGround = isPlatform && _platformIsGround(s.platformId);
	const o = s.origin || {};
	const headingDeg = (typeof s.headingDeg === 'number') ? s.headingDeg : '';
	const headingRandom = !!(s.headingDeg && s.headingDeg.any === true);
	const speed = (typeof s.speedMps === 'number') ? s.speedMps : '';
	const countLit = (typeof s.count === 'number') ? s.count : (s.count == null ? 1 : '');
	const countRand = (typeof s.count === 'object' && s.count);
	const intel = s.intel || {};
	const intelLevel = intel.level || 'none';
	const uncert = (typeof intel.uncertaintyM === 'number') ? intel.uncertaintyM : 4000;
	const mag = s.magazine || {};
	const subId = s.platformId || s.fighterModel || '?';

	return `
	<div style="margin-top:8px;border-top:1px solid rgba(0,220,255,0.2);padding-top:6px;">
		<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
			<span style="color:#ffd700;font-weight:bold;font-size:11px;">EDITING #${_selectedIdx + 1}: ${escapeHtml(subId)}</span>
			<button id="se-deselect" type="button" style="${_btnCss()}">DESELECT</button>
		</div>

		<div style="display:flex;gap:4px;align-items:center;font-size:10px;margin-bottom:4px;">
			<span style="opacity:0.7;flex:0 0 50px;">team</span>
			<select id="ed-team" style="${_selectCss()}flex:1;">${teamOpts}</select>
		</div>

		<div style="display:flex;gap:4px;align-items:center;font-size:10px;margin-bottom:4px;">
			<span style="opacity:0.7;flex:0 0 50px;">heading</span>
			<input id="ed-hdg" type="number" step="5" value="${headingDeg}" placeholder="deg" style="${_selectCss()}flex:1;" ${headingRandom ? 'disabled' : ''}>
			<label style="font-size:9px;display:flex;align-items:center;gap:3px;opacity:0.8;">
				<input id="ed-hdg-rand" type="checkbox" ${headingRandom ? 'checked' : ''}> rnd
			</label>
		</div>

		${isFighter ? `
		<div style="display:flex;gap:4px;align-items:center;font-size:10px;margin-bottom:4px;">
			<span style="opacity:0.7;flex:0 0 50px;">speed</span>
			<input id="ed-spd" type="number" step="20" value="${speed}" placeholder="m/s" style="${_selectCss()}flex:1;">
		</div>` : ''}

		<div style="display:flex;gap:4px;align-items:center;font-size:10px;margin-bottom:4px;">
			<span style="opacity:0.7;flex:0 0 50px;">altitude</span>
			<input id="ed-alt" type="number" step="500" value="${o.alt ?? 0}" placeholder="m" style="${_selectCss()}flex:1;">
		</div>

		<div style="display:flex;gap:4px;align-items:center;font-size:10px;margin-bottom:4px;">
			<span style="opacity:0.7;flex:0 0 50px;">count</span>
			${countRand
				? `<input id="ed-cnt-min" type="number" step="1" value="${s.count.min}" style="${_selectCss()}flex:1;">
				   <input id="ed-cnt-max" type="number" step="1" value="${s.count.max}" style="${_selectCss()}flex:1;">`
				: `<input id="ed-cnt" type="number" step="1" value="${countLit}" style="${_selectCss()}flex:1;">`
			}
			<label style="font-size:9px;display:flex;align-items:center;gap:3px;opacity:0.8;">
				<input id="ed-cnt-rand" type="checkbox" ${countRand ? 'checked' : ''}> rnd
			</label>
		</div>

		<div style="display:flex;gap:4px;align-items:center;font-size:10px;margin-bottom:4px;">
			<span style="opacity:0.7;flex:0 0 50px;">intel</span>
			<select id="ed-intel" style="${_selectCss()}flex:1;">
				<option value="none"${intelLevel === 'none' ? ' selected' : ''}>none</option>
				<option value="known"${intelLevel === 'known' ? ' selected' : ''}>known</option>
				<option value="suspected"${intelLevel === 'suspected' ? ' selected' : ''}>suspected</option>
			</select>
			${intelLevel === 'suspected'
				? `<input id="ed-intel-uncert" type="number" step="500" value="${uncert}" placeholder="±m" style="${_selectCss()}flex:0 0 70px;">`
				: ''
			}
		</div>

		${isGround ? `
		<div style="display:flex;gap:4px;align-items:center;font-size:10px;margin-bottom:4px;">
			<span style="opacity:0.7;flex:0 0 50px;">magazine</span>
			<input id="ed-mag" type="number" step="1" value="${mag.missile ?? ''}" placeholder="missile count" style="${_selectCss()}flex:1;">
		</div>` : ''}

		${isFighter ? _pilotSectionHtml(s) : ''}

		<div style="margin-top:6px;font-size:10px;opacity:0.7;">click another marker / row to switch · click empty terrain to drop a new unit · DESELECT to return to placement mode</div>
	</div>`;
}

// Pilot-type sub-section (fighter spawns only). Default = no
// pilot (engage-on-sight CAP). Selecting patrol exposes a waypoint
// editor; strike adds an additional target-tag + weapon-type input
// pair (one waypoint editor per route — ingress and egress);
// escort adds an escortTag input.
function _pilotSectionHtml(s) {
	const ptype = (s.pilot && s.pilot.type) || 'default';
	const params = (s.pilot && s.pilot.params) || {};
	const isAddingHere = (route) =>
		_pendingAddWaypoint && _pendingAddWaypoint.spawnIdx === _selectedIdx
		&& _pendingAddWaypoint.route === route;

	const wpListHtml = (route) => {
		const list = Array.isArray(params[route]) ? params[route] : [];
		if (list.length === 0) {
			return '<div style="opacity:0.5;font-size:10px;font-style:italic;padding:2px 0;">no waypoints — click ADD then click on the map</div>';
		}
		return list.map((wp, i) =>
			`<div style="display:flex;gap:4px;font-size:10px;padding:1px 0;align-items:center;">
				<span style="opacity:0.6;width:18px;">${i + 1}.</span>
				<span style="flex:1;font-family:monospace;opacity:0.8;">${wp.lon.toFixed(3)}, ${wp.lat.toFixed(3)} · ${Math.round(wp.altM || 0)} m</span>
				<button type="button" class="ed-wp-del" data-route="${route}" data-idx="${i}" style="background:transparent;border:1px solid rgba(255,128,128,0.4);color:#f88;font-size:9px;padding:1px 4px;cursor:pointer;letter-spacing:0.5px;">DEL</button>
			</div>`,
		).join('');
	};

	const wpSection = (route, label) => {
		const adding = isAddingHere(route);
		const btnStyle = adding
			? 'background:rgba(255,210,80,0.2);border:1px solid #fd0;color:#fd0;'
			: 'background:transparent;border:1px solid rgba(0,220,255,0.4);color:#6ff;';
		return `
		<div style="margin-top:4px;font-size:10px;opacity:0.85;">
			<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">
				<span>${label} ROUTE</span>
				<button type="button" class="ed-wp-add" data-route="${route}" style="${btnStyle}font-size:9px;padding:1px 6px;cursor:pointer;letter-spacing:0.5px;">${adding ? 'CLICK MAP · DONE TO STOP' : 'ADD'}</button>
			</div>
			<div data-wp-list="${route}">${wpListHtml(route)}</div>
		</div>`;
	};

	let routeUI = '';
	if (ptype === 'patrol') {
		routeUI = wpSection('waypoints', 'PATROL');
	} else if (ptype === 'strike') {
		const targetTag = (params.target && params.target.tag) || '';
		const weapon = params.weaponType || 'STORM-SHADOW';
		routeUI = `
		<div style="display:flex;gap:4px;align-items:center;font-size:10px;margin-top:4px;">
			<span style="opacity:0.7;flex:0 0 60px;">target tag</span>
			<input id="ed-strike-tag" type="text" value="${escapeAttr(targetTag)}" placeholder="ewr-A" style="${_selectCss()}flex:1;">
		</div>
		<div style="display:flex;gap:4px;align-items:center;font-size:10px;margin-top:3px;">
			<span style="opacity:0.7;flex:0 0 60px;">weapon</span>
			<select id="ed-strike-wpn" style="${_selectCss()}flex:1;">
				${['STORM-SHADOW', 'AGM-86', 'GBU-31', 'GBU-38', 'GBU-39'].map(w =>
					`<option value="${w}"${w === weapon ? ' selected' : ''}>${w}</option>`).join('')}
			</select>
		</div>
		${wpSection('ingressWaypoints', 'INGRESS')}
		${wpSection('egressWaypoints',  'EGRESS')}`;
	} else if (ptype === 'escort') {
		const tag = params.escortTag || '';
		routeUI = `
		<div style="display:flex;gap:4px;align-items:center;font-size:10px;margin-top:4px;">
			<span style="opacity:0.7;flex:0 0 70px;">escort tag</span>
			<input id="ed-escort-tag" type="text" value="${escapeAttr(tag)}" placeholder="awacs-1" style="${_selectCss()}flex:1;">
		</div>`;
	}

	return `
	<div style="margin-top:6px;border-top:1px dotted rgba(0,220,255,0.2);padding-top:4px;">
		<div style="display:flex;gap:4px;align-items:center;font-size:10px;margin-bottom:3px;">
			<span style="opacity:0.7;flex:0 0 50px;">pilot</span>
			<select id="ed-pilot" style="${_selectCss()}flex:1;">
				<option value="default"${ptype === 'default' ? ' selected' : ''}>default (engage-on-sight)</option>
				<option value="patrol"${ptype === 'patrol'   ? ' selected' : ''}>patrol</option>
				<option value="strike"${ptype === 'strike'   ? ' selected' : ''}>strike</option>
				<option value="escort"${ptype === 'escort'   ? ' selected' : ''}>escort</option>
			</select>
		</div>
		${routeUI}
	</div>`;
}

function _selectCss() {
	return `background:rgba(0,0,0,0.4);border:1px solid rgba(0,220,255,0.35);color:#c0eeff;font-family:inherit;font-size:11px;padding:2px 4px;letter-spacing:0.5px;`;
}
function _btnCss() {
	return `background:rgba(0,0,0,0.4);border:1px solid rgba(0,220,255,0.45);color:#6ff;font-family:inherit;font-size:10px;padding:2px 6px;letter-spacing:0.5px;cursor:pointer;`;
}
function _tabBtnCss(isActive) {
	const c = isActive
		? 'background:rgba(0,220,255,0.18);color:#6ff;border:1px solid #6ff;'
		: 'background:rgba(0,0,0,0.3);color:rgba(192,238,255,0.6);border:1px solid rgba(0,220,255,0.25);';
	return `${c}font-family:inherit;font-size:10px;letter-spacing:1px;padding:4px;cursor:pointer;`;
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
		const isSelected = _selectedIdx === i;
		const rowStyle = isSelected
			? 'background:rgba(255,215,0,0.12);border-left:2px solid #ffd700;'
			: 'border-left:2px solid transparent;';
		const altText = (s.origin && typeof s.origin.alt === 'number')
			? `  ${Math.round(s.origin.alt)} m`
			: '';
		// Drag-on-the-map handles repositioning + right-click on the
		// marker handles deletion. Spawn-list rows therefore only
		// need a select gesture (click the row) — we kept a small
		// DEL button as a keyboard-accessible fallback for users
		// who don't have right-click handy.
		return `<div class="se-spawn-row" data-idx="${i}" style="${rowStyle}padding:2px 4px;border-bottom:1px dotted rgba(0,220,255,0.15);display:flex;justify-content:space-between;align-items:center;gap:4px;cursor:pointer;">
			<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"><span style="opacity:0.5;display:inline-block;width:18px;">${i + 1}.</span>${escapeHtml(label + altText)}</span>
			<button type="button" class="se-del" data-idx="${i}" style="background:transparent;border:1px solid rgba(255,128,128,0.4);color:#f88;font-size:9px;padding:1px 5px;cursor:pointer;letter-spacing:0.5px;">×</button>
		</div>`;
	}).join('');
	for (const row of list.querySelectorAll('.se-spawn-row')) {
		row.addEventListener('click', (e) => {
			// Skip if the click landed on a button — those have their
			// own handlers + stopPropagation.
			if (e.target.tagName === 'BUTTON') return;
			const idx = parseInt(row.getAttribute('data-idx'), 10);
			if (Number.isFinite(idx)) _selectSpawn(idx);
		});
	}
	for (const btn of list.querySelectorAll('.se-del')) {
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			const idx = parseInt(btn.getAttribute('data-idx'), 10);
			if (Number.isFinite(idx)) {
				_activeJson.spawns.splice(idx, 1);
				if (_pendingMoveIdx === idx) _pendingMoveIdx = null;
				else if (_pendingMoveIdx != null && _pendingMoveIdx > idx) _pendingMoveIdx--;
				if (_selectedIdx === idx) _selectedIdx = null;
				else if (_selectedIdx != null && _selectedIdx > idx) _selectedIdx--;
				_renderSpawnMarkers();
				_buildPanel();
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
