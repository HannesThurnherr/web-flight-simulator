// ============================================================================
// tgp.js — Targeting Pod (TGP) UI panel.
//
// A small inset on the left edge of the HUD. Auto-shows when a
// laser-guided weapon (GBU-12 etc.) becomes the active weapon, hides
// otherwise. Drives the player-laser-designation state machine (see
// systems/designation.js).
//
// MVP scope (Phase 5b first cut):
//   - Status row: mode (SLEW/TRACK/LASE), spot lat/lon, slant range,
//     altitude under spot, target name if locked to a unit.
//   - Crosshair + a top-down Cesium view chasing the spot, reusing the
//     same Cesium-viewer pattern as the minimap. Cheap, recognizable,
//     not yet a real gimballed pod feed (that's a follow-up — needs a
//     full extra Cesium viewer with terrain).
//   - Three click buttons:
//       MODE       — cycle SLEW → TRACK → LASE → TRACK → SLEW
//       LASE       — momentary toggle of LASE state (only when in
//                    TRACK or LASE)
//       MOUSE      — click to engage in-panel mouse drag for slewing.
//                    While engaged, mouse motion inside the panel
//                    moves the slew point on the ground; outside, the
//                    cursor is freed back to normal flight controls.
//   - In SLEW mode the crosshair lat/lon is recomputed each frame from
//     a ray cast through the player's nose (default) or from the
//     accumulated mouse-drag offset (when MOUSE is engaged).
//
// Deliberately out of scope for this cut (follow-up commits):
//   - Real gimballed pod camera with telescopic FOV (4° / 1° zooms).
//     The MVP shows a top-down satellite-style view at the spot, which
//     is enough to verify GBU-12 deliveries land where you expect.
//   - LOS-MASKED indicator (terrain-blocked spot). chordTerrainHit is
//     already exported; wiring this is a one-liner once the pod camera
//     has a real position to test from.
// ============================================================================

import * as Cesium from 'cesium';
import {
	playerDesignation,
	setSlewSpot,
	snapTrack,
	startLase,
	stopLase,
	returnToSlew,
	tickTrack,
} from '../systems/designation.js';

let _container = null;
let _statusEl  = null;
let _modeBtn   = null;
let _laseBtn   = null;
let _mouseBtn  = null;
let _viewport  = null;     // div that hosts the Cesium feed canvas
let _crosshair = null;
let _tgpViewer = null;     // lazily-constructed Cesium viewer for the feed

// Mouse-slew state. While `_mouseEngaged` is true, mouse motion inside
// the panel moves the slew spot. Click MOUSE again to release.
let _mouseEngaged = false;
// Player-relative bearing/range offset accumulated by mouse drags. In
// SLEW we project a ray from the player's position out at this bearing
// at a fixed slant range, then chord-intersect terrain. The result is
// the lat/lon of the slew spot. Re-derived from the player's position
// every frame so the spot doesn't slide as the aircraft turns.
let _slewBearingDeg = 0;
let _slewRangeM     = 8000;

// Cached visibility — hide TGP when no laser-guided weapon is selected.
let _visible = false;

export function setupTgp() {
	if (_container) return;
	const c = document.createElement('div');
	c.id = 'tgp-panel';
	c.style.cssText = `
		position: absolute;
		top: 50%;
		left: 16px;
		transform: translateY(-50%);
		width: 280px;
		padding: 8px;
		border: 1px solid rgba(0, 255, 0, 0.5);
		background: rgba(0, 20, 0, 0.55);
		color: #0f0;
		font-family: 'AceCombat', monospace;
		font-size: 11px;
		letter-spacing: 1px;
		text-shadow: 0 0 6px rgba(0, 255, 0, 0.7);
		z-index: 10;
		display: none;
	`;
	_container = c;

	// Title row
	const title = document.createElement('div');
	title.textContent = 'TGP — TARGETING POD';
	title.style.cssText = 'opacity:0.85; margin-bottom:4px; font-weight:bold;';
	c.appendChild(title);

	// Viewport — a div that will hold the Cesium feed canvas. Square
	// aspect, sized to the panel width minus padding.
	const vp = document.createElement('div');
	vp.id = 'tgp-viewport';
	vp.style.cssText = `
		position: relative;
		width: 100%;
		height: 200px;
		background: #000;
		border: 1px solid rgba(0,255,0,0.4);
		overflow: hidden;
		cursor: default;
	`;
	_viewport = vp;
	c.appendChild(vp);

	// Cesium feed mount point (the viewer is constructed lazily on
	// first show so we don't pay its cost when no GBU is loaded).
	const feedMount = document.createElement('div');
	feedMount.id = 'tgp-feed';
	feedMount.style.cssText = `
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
	`;
	vp.appendChild(feedMount);

	// Crosshair overlay
	const ch = document.createElement('div');
	ch.style.cssText = `
		position: absolute;
		left: 50%;
		top: 50%;
		width: 30px;
		height: 30px;
		transform: translate(-50%, -50%);
		pointer-events: none;
		border: 1px solid rgba(0, 255, 0, 0.8);
		box-shadow: 0 0 4px rgba(0, 255, 0, 0.6);
	`;
	const tick = (style) => {
		const e = document.createElement('div');
		e.style.cssText = `position:absolute; background:rgba(0,255,0,0.85); ${style}`;
		ch.appendChild(e);
	};
	tick('left:50%; top:-6px; width:1px; height:6px;');
	tick('left:50%; bottom:-6px; width:1px; height:6px;');
	tick('left:-6px; top:50%; height:1px; width:6px;');
	tick('right:-6px; top:50%; height:1px; width:6px;');
	_crosshair = ch;
	vp.appendChild(ch);

	// Status block
	const status = document.createElement('div');
	status.style.cssText = 'margin-top:6px; line-height:1.4; min-height:60px;';
	_statusEl = status;
	c.appendChild(status);

	// Button row
	const row = document.createElement('div');
	row.style.cssText = 'display:flex; gap:4px; margin-top:6px;';
	_modeBtn  = _makeButton('MODE',  () => _cycleMode());
	_laseBtn  = _makeButton('LASE',  () => _toggleLase());
	_mouseBtn = _makeButton('MOUSE', () => _toggleMouseEngage());
	row.appendChild(_modeBtn);
	row.appendChild(_laseBtn);
	row.appendChild(_mouseBtn);
	c.appendChild(row);

	document.body.appendChild(c);

	// Panel-level mouse handlers. We attach to the viewport rather than
	// the whole panel so clicks on the buttons don't slew the spot.
	vp.addEventListener('mousemove', _onViewportMouseMove);
	vp.addEventListener('mouseleave', () => { /* keep engaged state; player drags back in */ });
}

function _makeButton(label, onClick) {
	const b = document.createElement('button');
	b.textContent = label;
	b.style.cssText = `
		flex: 1;
		padding: 4px 0;
		background: rgba(0, 30, 0, 0.7);
		border: 1px solid rgba(0, 255, 0, 0.6);
		color: #0f0;
		font-family: 'AceCombat', monospace;
		font-size: 10px;
		letter-spacing: 1px;
		cursor: pointer;
	`;
	// Swallow mousedown / mouseup as well as click — planeController
	// wires the LMB fire trigger to mousedown at window level, and
	// mousedown fires before click. Even though the controller now
	// gates LMB-fire on mouseSteering, swallowing here means the
	// button never relies on that gate. Same pattern as the minimap
	// zoom buttons.
	const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
	b.addEventListener('mousedown', swallow);
	b.addEventListener('mouseup',   swallow);
	b.addEventListener('click', (ev) => { swallow(ev); onClick(); });
	return b;
}

function _cycleMode() {
	if (playerDesignation.mode === 'SLEW') {
		// Snap to whatever's currently under the crosshair. Already
		// updated by setSlewSpot in update(); just freeze it.
		snapTrack(playerDesignation.lon, playerDesignation.lat, playerDesignation.alt, null);
	} else if (playerDesignation.mode === 'TRACK') {
		startLase(performance.now() * 0.001);
	} else if (playerDesignation.mode === 'LASE') {
		returnToSlew();
	}
	_repaintButtonStates();
}

function _toggleLase() {
	if (playerDesignation.mode === 'LASE') stopLase();
	else if (playerDesignation.mode === 'TRACK') startLase(performance.now() * 0.001);
	// In SLEW, LASE button is a no-op (you have to TRACK first).
	_repaintButtonStates();
}

function _toggleMouseEngage() {
	_mouseEngaged = !_mouseEngaged;
	_viewport.style.cursor = _mouseEngaged ? 'crosshair' : 'default';
	_repaintButtonStates();
}

function _onViewportMouseMove(ev) {
	if (!_mouseEngaged) return;
	if (playerDesignation.mode !== 'SLEW') return;
	// Mouse motion → bearing/range delta. movementX/Y are pixel deltas
	// since the last frame. Tune sensitivity so a moderate drag walks
	// the spot a few hundred metres. Range delta from vertical, bearing
	// from horizontal.
	_slewBearingDeg += ev.movementX * 0.4;
	_slewRangeM = Math.max(500, Math.min(40000, _slewRangeM + ev.movementY * 30));
	// Wrap bearing into [-180, 180] for cleaner display.
	while (_slewBearingDeg >  180) _slewBearingDeg -= 360;
	while (_slewBearingDeg < -180) _slewBearingDeg += 360;
}

function _repaintButtonStates() {
	const m = playerDesignation.mode;
	_modeBtn.style.background = m === 'SLEW' ? 'rgba(0,30,0,0.7)'
		: m === 'TRACK' ? 'rgba(80,60,0,0.7)' : 'rgba(80,0,0,0.7)';
	_laseBtn.style.background = m === 'LASE' ? 'rgba(120,0,0,0.85)' : 'rgba(0,30,0,0.7)';
	_mouseBtn.style.background = _mouseEngaged ? 'rgba(0,80,80,0.7)' : 'rgba(0,30,0,0.7)';
}

// Construct the Cesium viewer that renders the TGP feed. Reuses the
// terrain provider from the main viewer (sharing terrain tiles between
// viewers is officially supported and avoids paying twice for the same
// download). Camera is set per-frame to look straight down at the spot.
function _ensureFeedViewer(mainViewer) {
	if (_tgpViewer) return _tgpViewer;
	const mount = document.getElementById('tgp-feed');
	if (!mount) return null;
	try {
		_tgpViewer = new Cesium.Viewer(mount, {
			terrain: null, // top-down view + low altitude → flat globe is fine, saves GPU
			timeline: false,
			animation: false,
			baseLayerPicker: false,
			geocoder: false,
			homeButton: false,
			infoBox: false,
			sceneModePicker: false,
			selectionIndicator: false,
			navigationHelpButton: false,
			fullscreenButton: false,
			shouldAnimate: false,
			skyBox: false,
			skyAtmosphere: false,
			contextOptions: { webgl: { preserveDrawingBuffer: true } },
		});
		_tgpViewer.scene.requestRenderMode = false;
		_tgpViewer.scene.maximumRenderTimeChange = 0;
		_tgpViewer.scene.globe.maximumScreenSpaceError = 4;
		_tgpViewer.resolutionScale = 0.6;
		// Hide the credits container — the panel is too small for it
		// and it overlaps the crosshair.
		try { _tgpViewer.cesiumWidget.creditContainer.style.display = 'none'; } catch (e) {}
	} catch (e) {
		console.warn('[tgp] failed to create feed viewer:', e);
		_tgpViewer = null;
	}
	return _tgpViewer;
}

// Compute the ground intersection of a ray cast from the player
// position at the given bearing, descending to terrain. We use
// Cesium's globe.pick (which honours terrain height) to find the
// actual ground point. Falls back to a flat-globe extrapolation if
// pick returns null (e.g. ray off-globe).
function _pickGroundFromPlayer(viewer, playerState, bearingDeg, slantRangeM) {
	const scene = viewer && viewer.scene;
	const globe = scene && scene.globe;
	if (!globe) return null;
	// Build a forward direction with a slight downward pitch sized so a
	// `slantRangeM` ray reaches roughly ground level given the player's
	// altitude. Tan-based pitch keeps it consistent at any altitude.
	const groundDrop = Math.max(50, playerState.alt - 0); // assume sea-level baseline; pick refines
	const pitchRad = Math.atan2(groundDrop, slantRangeM);
	const hRad = bearingDeg * Math.PI / 180;
	// Cartesian for ray origin
	const origin = Cesium.Cartesian3.fromDegrees(playerState.lon, playerState.lat, playerState.alt);
	// East-North-Up basis at the origin.
	const enu = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
	const dirLocal = new Cesium.Cartesian3(
		Math.sin(hRad) * Math.cos(pitchRad),  // east
		Math.cos(hRad) * Math.cos(pitchRad),  // north
		-Math.sin(pitchRad),                  // up (negative = down)
	);
	// Strip translation from enu to get a rotation-only matrix, then
	// rotate the local direction into ECEF.
	const rotOnly = Cesium.Matrix4.getMatrix3(enu, new Cesium.Matrix3());
	const dirEcef = Cesium.Matrix3.multiplyByVector(rotOnly, dirLocal, new Cesium.Cartesian3());
	Cesium.Cartesian3.normalize(dirEcef, dirEcef);
	const ray = new Cesium.Ray(origin, dirEcef);
	const hit = globe.pick(ray, scene);
	if (!hit) return null;
	const carto = Cesium.Cartographic.fromCartesian(hit);
	return {
		lon: Cesium.Math.toDegrees(carto.longitude),
		lat: Cesium.Math.toDegrees(carto.latitude),
		alt: carto.height,
	};
}

// Per-frame update. Called from simLoop.
export function updateTgp(playerState, weaponSystem, mainViewer) {
	const cur = weaponSystem && weaponSystem.getCurrentWeapon && weaponSystem.getCurrentWeapon();
	const want = !!(cur && cur.id === 'gbu');
	if (want !== _visible) {
		_visible = want;
		if (_container) _container.style.display = want ? 'block' : 'none';
		if (want) _ensureFeedViewer(mainViewer);
	}
	if (!_visible) return;

	// In SLEW, recompute the spot from the player's nose + mouse offset.
	// (Mouse-engage adds to the bearing/range; otherwise it's nose-on.)
	if (playerDesignation.mode === 'SLEW') {
		const baseBearing = (playerState.heading || 0) + _slewBearingDeg;
		const hit = _pickGroundFromPlayer(mainViewer, playerState, baseBearing, _slewRangeM);
		if (hit) setSlewSpot(hit.lon, hit.lat, hit.alt);
	} else {
		// Track mode: if locked to a unit, follow it. Pure-point tracks
		// stay frozen.
		tickTrack(performance.now() * 0.001);
	}

	// Drive the TGP feed camera: top-down at the spot from a comfortable
	// altitude. Adjust per slant range so closer-zoom feels tighter.
	const fv = _ensureFeedViewer(mainViewer);
	if (fv) {
		const camAlt = Math.max(800, _slewRangeM * 0.4);
		fv.camera.setView({
			destination: Cesium.Cartesian3.fromDegrees(
				playerDesignation.lon, playerDesignation.lat,
				playerDesignation.alt + camAlt,
			),
			orientation: {
				heading: 0,
				pitch:   Cesium.Math.toRadians(-90),
				roll:    0,
			},
		});
		fv.scene.requestRender();
	}

	// Status text
	const slantRange = _haversine(playerState, playerDesignation);
	const targetTxt = playerDesignation.target && playerDesignation.target.name
		? `<div>TGT  <span style="opacity:0.9">${playerDesignation.target.name}</span></div>` : '';
	_statusEl.innerHTML =
		`<div>MODE <span style="font-weight:bold;color:${_modeColor()}">${playerDesignation.mode}</span></div>` +
		`<div>SPOT ${playerDesignation.lat.toFixed(4)}°, ${playerDesignation.lon.toFixed(4)}°</div>` +
		`<div>ALT  ${Math.round(playerDesignation.alt)} m</div>` +
		`<div>RNG  ${(slantRange / 1000).toFixed(1)} km</div>` +
		targetTxt;
	_repaintButtonStates();
}

function _modeColor() {
	const m = playerDesignation.mode;
	if (m === 'LASE')  return '#ff4040';
	if (m === 'TRACK') return '#ffcc00';
	return '#0f0';
}

function _haversine(a, b) {
	const cosLat = Math.cos((a.lat || 0) * Math.PI / 180);
	const dE = (b.lon - a.lon) * 111320 * cosLat;
	const dN = (b.lat - a.lat) * 111320;
	const dU = (b.alt - a.alt);
	return Math.sqrt(dE * dE + dN * dN + dU * dU);
}
