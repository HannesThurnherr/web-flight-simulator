// ============================================================================
// tgp.js — Targeting Pod (TGP) UI panel.
//
// A small inset on the left edge of the HUD. Auto-shows when a
// laser-guided weapon (GBU-12) is the active weapon, hides otherwise.
// Drives the player-laser-designation state machine (designation.js).
//
// What this is, mentally: a forward-looking gimballed camera bolted
// to the player's airframe. The camera position is the plane's
// position; the camera orientation is the plane's heading + a
// gimbal (az relative to nose, el absolute pitch). The crosshair
// in the centre always points at the camera's forward axis. Where
// that axis hits the ground is the designation spot.
//
// Interactions:
//   - Drag inside the panel  → pan the gimbal (az from x, el from y).
//                               Sensitivity scales with current FOV
//                               so narrow zoom = slow pan, like a
//                               real telescope.
//   - Scroll wheel inside    → change FOV (zoom). Smooth between
//                               1° (max telescope) and 30° (wide).
//   - MODE button            → cycle SLEW → TRACK → LASE → SLEW.
//                               TRACK freezes the world point under
//                               the crosshair; the gimbal then
//                               auto-tracks it as the plane moves.
//                               LASE flips on the laser flag GBU-12
//                               seekers read.
//
// Cesium's own input handlers (drag-to-pan-globe, wheel-to-zoom-globe)
// are explicitly disabled on this viewer so they don't fight ours.
//
// Out of scope this iteration:
//   - Terrain in the feed (flat globe + imagery only, to keep cost
//     down — gives a recognizable forward-look without paying the
//     duplicate-terrain bandwidth).
//   - Monochrome / CRT / grain CSS for that "real TGP feed" look.
//   - LOS-MASKED indicator on the symbology.
// ============================================================================

import * as Cesium from 'cesium';
import {
	playerDesignation,
	setSlewSpot,
	snapTrack,
	startLase,
	stopLase,
	returnToSlew,
} from '../systems/designation.js';

// ---- Module state ----------------------------------------------------------
let _container = null;
let _viewport  = null;
let _statusEl  = null;
let _modeBtn   = null;
let _tgpViewer = null;
let _crosshair = null;

// Gimbal: az is relative to the player's heading (so 0 = straight
// off the nose, +90 = right wing, -90 = left wing). El is absolute
// pitch (-90 = straight down, +20 = slightly above horizon). The
// gimbal limits roughly mimic a real TGP's mechanical envelope.
let _gimbalAz = 0;
let _gimbalEl = -10;
let _tgpFovDeg = 10;
const GIMBAL_AZ_LIMIT = 150;
const GIMBAL_EL_MIN = -85;
const GIMBAL_EL_MAX = 20;
const FOV_MIN = 1, FOV_MAX = 30;

let _dragging = false;
let _dragLastX = 0;
let _dragLastY = 0;
let _visible  = false;

// ---- Public API ------------------------------------------------------------

export function setupTgp() {
	if (_container) return;
	const c = document.createElement('div');
	c.id = 'tgp-panel';
	c.style.cssText = `
		position: absolute;
		top: 50%;
		left: 16px;
		transform: translateY(-50%);
		width: 300px;
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

	const title = document.createElement('div');
	title.textContent = 'TGP — TARGETING POD';
	title.style.cssText = 'opacity:0.85; margin-bottom:4px; font-weight:bold;';
	c.appendChild(title);

	// Viewport hosts the Cesium feed. Square-ish for that real-pod
	// aspect. Cursor cue for drag.
	const vp = document.createElement('div');
	vp.id = 'tgp-viewport';
	vp.style.cssText = `
		position: relative;
		width: 100%;
		height: 220px;
		background: #000;
		border: 1px solid rgba(0,255,0,0.4);
		overflow: hidden;
		cursor: grab;
	`;
	_viewport = vp;
	c.appendChild(vp);

	// Cesium feed mount.
	const feedMount = document.createElement('div');
	feedMount.id = 'tgp-feed';
	feedMount.style.cssText = 'position:absolute; inset:0;';
	vp.appendChild(feedMount);

	// Crosshair overlay — same green TGP look.
	const ch = document.createElement('div');
	ch.style.cssText = `
		position: absolute;
		left: 50%;
		top: 50%;
		width: 36px;
		height: 36px;
		transform: translate(-50%, -50%);
		pointer-events: none;
		border: 1px solid rgba(0, 255, 0, 0.85);
		box-shadow: 0 0 4px rgba(0, 255, 0, 0.6);
	`;
	const tick = (style) => {
		const e = document.createElement('div');
		e.style.cssText = `position:absolute; background:rgba(0,255,0,0.9); ${style}`;
		ch.appendChild(e);
	};
	tick('left:50%; top:-8px;    width:1px; height:8px;');
	tick('left:50%; bottom:-8px; width:1px; height:8px;');
	tick('left:-8px;  top:50%; height:1px; width:8px;');
	tick('right:-8px; top:50%; height:1px; width:8px;');
	_crosshair = ch;
	vp.appendChild(ch);

	// Status block (mode, FOV, spot, range, target).
	const status = document.createElement('div');
	status.style.cssText = 'margin-top:6px; line-height:1.4; min-height:80px;';
	_statusEl = status;
	c.appendChild(status);

	// Mode button only — drag pans, scroll zooms. One button to cycle
	// the state machine.
	const row = document.createElement('div');
	row.style.cssText = 'display:flex; gap:4px; margin-top:6px;';
	_modeBtn = _makeButton('MODE', () => _cycleMode());
	row.appendChild(_modeBtn);
	const hintBtn = document.createElement('div');
	hintBtn.textContent = 'DRAG = PAN · SCROLL = ZOOM';
	hintBtn.style.cssText = `
		flex: 2; padding:4px 0; font-size:9px; opacity:0.7;
		text-align:center; align-self:center;
	`;
	row.appendChild(hintBtn);
	c.appendChild(row);

	document.body.appendChild(c);

	// ---- Mouse handlers on the viewport --------------------------
	// Use addEventListener so we can stopPropagation cleanly. We
	// also swallow the events from reaching the window-level fire
	// listener (planeController already gates that on mouseSteering,
	// but defense-in-depth doesn't hurt).
	// Use pointer events with setPointerCapture so we keep getting
	// pointermove even if the cursor leaves the viewport mid-drag, and
	// we don't depend on `movementX` (which is 0 across some Cesium
	// canvas configurations). Tracking lastX/lastY ourselves is
	// bulletproof.
	vp.addEventListener('pointerdown', (e) => {
		if (e.button !== 0) return;
		e.stopPropagation();
		e.preventDefault();
		_dragging = true;
		_dragLastX = e.clientX;
		_dragLastY = e.clientY;
		vp.style.cursor = 'grabbing';
		try { vp.setPointerCapture(e.pointerId); } catch (_) {}
	});
	const _endDrag = (e) => {
		if (!_dragging) return;
		_dragging = false;
		vp.style.cursor = 'grab';
		try { vp.releasePointerCapture(e.pointerId); } catch (_) {}
	};
	vp.addEventListener('pointerup',     _endDrag);
	vp.addEventListener('pointercancel', _endDrag);
	vp.addEventListener('pointermove', (e) => {
		if (!_dragging) return;
		const dx = e.clientX - _dragLastX;
		const dy = e.clientY - _dragLastY;
		_dragLastX = e.clientX;
		_dragLastY = e.clientY;
		// Sensitivity scales with FOV — narrower zoom moves the
		// gimbal more slowly per pixel, matching how a real
		// telescope feels.
		const k = _tgpFovDeg / 30;
		_gimbalAz += dx * 0.4 * k;
		_gimbalEl -= dy * 0.4 * k;
		_gimbalAz = Math.max(-GIMBAL_AZ_LIMIT, Math.min(GIMBAL_AZ_LIMIT, _gimbalAz));
		_gimbalEl = Math.max(GIMBAL_EL_MIN,    Math.min(GIMBAL_EL_MAX,    _gimbalEl));
	});
	vp.addEventListener('wheel', (e) => {
		e.stopPropagation();
		e.preventDefault();
		// deltaY > 0 = scroll down = zoom out (wider FOV).
		const factor = Math.exp(e.deltaY * 0.001);
		_tgpFovDeg = Math.max(FOV_MIN, Math.min(FOV_MAX, _tgpFovDeg * factor));
	}, { passive: false });
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
	const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
	b.addEventListener('mousedown', swallow);
	b.addEventListener('mouseup',   swallow);
	b.addEventListener('click', (ev) => { swallow(ev); onClick(); });
	return b;
}

function _cycleMode() {
	const now = performance.now() * 0.001;
	if (playerDesignation.mode === 'SLEW') {
		// Don't snap on a degenerate spot. If the SLEW raycast never
		// produced a real ground hit (lat/lon still 0/0 = null
		// island), the player obviously didn't mean to track that —
		// stay in SLEW so they get another chance instead of
		// pointing the gimbal at the equator.
		const haveSpot = playerDesignation.lat !== 0 || playerDesignation.lon !== 0;
		if (!haveSpot) return;
		snapTrack(playerDesignation.lon, playerDesignation.lat, playerDesignation.alt, null);
	} else if (playerDesignation.mode === 'TRACK') {
		startLase(now);
	} else if (playerDesignation.mode === 'LASE') {
		returnToSlew();
		// Reset the gimbal to the default forward-down attitude when
		// returning to SLEW. Without this, if TRACK had clamped the
		// gimbal at the limits to chase a far-away point, the player
		// is stuck looking at that direction with no way to recover
		// short of dragging back to forward.
		_gimbalAz = 0;
		_gimbalEl = -10;
	}
}

function _modeColor() {
	const m = playerDesignation.mode;
	if (m === 'LASE')  return '#ff4040';
	if (m === 'TRACK') return '#ffcc00';
	return '#0f0';
}

// Lazily build the second Cesium viewer — only when GBU-12 is first
// selected. Cesium's own mouse handlers are turned off; ours own the
// canvas inside the panel.
function _ensureFeedViewer() {
	if (_tgpViewer) return _tgpViewer;
	const mount = document.getElementById('tgp-feed');
	if (!mount) return null;
	try {
		_tgpViewer = new Cesium.Viewer(mount, {
			terrain: null, // imagery-only flat globe — see header comment
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
		// CRITICAL: Cesium's default input controller would hijack
		// drag-to-pan-globe and wheel-to-zoom-globe. We do our own
		// gimbal control on top.
		_tgpViewer.scene.screenSpaceCameraController.enableInputs = false;
		try { _tgpViewer.cesiumWidget.creditContainer.style.display = 'none'; } catch (e) {}

		// Wheel handler on the canvas itself — Cesium's canvas swallows
		// wheel events even with screenSpaceCameraController disabled,
		// so a viewport-level listener doesn't see them. (Drag uses
		// pointer events on vp, which DO bubble up cleanly.)
		const cv = _tgpViewer.canvas;
		if (cv) {
			cv.addEventListener('wheel', (e) => {
				e.stopPropagation();
				e.preventDefault();
				const factor = Math.exp(e.deltaY * 0.001);
				_tgpFovDeg = Math.max(FOV_MIN, Math.min(FOV_MAX, _tgpFovDeg * factor));
			}, { passive: false });
		}
	} catch (e) {
		console.warn('[tgp] failed to create feed viewer:', e);
		_tgpViewer = null;
	}
	return _tgpViewer;
}

// Build a forward unit vector in ECEF for a given (heading, pitch) at
// a position. Heading is degrees CW from north; pitch is degrees up
// from horizontal.
function _forwardEcef(originCart, headingDeg, pitchDeg) {
	const enu = Cesium.Transforms.eastNorthUpToFixedFrame(originCart);
	const rotOnly = Cesium.Matrix4.getMatrix3(enu, new Cesium.Matrix3());
	const hRad = headingDeg * Math.PI / 180;
	const pRad = pitchDeg   * Math.PI / 180;
	const local = new Cesium.Cartesian3(
		Math.sin(hRad) * Math.cos(pRad),  // east
		Math.cos(hRad) * Math.cos(pRad),  // north
		Math.sin(pRad),                   // up (negative pitch = below horizon)
	);
	const ecef = Cesium.Matrix3.multiplyByVector(rotOnly, local, new Cesium.Cartesian3());
	return Cesium.Cartesian3.normalize(ecef, ecef);
}

// Compute the (gimbalAz, gimbalEl) needed to point at a world
// point given the player's current state. Az is relative to the
// player heading; el is absolute. Used in TRACK / LASE so the
// gimbal auto-follows the snapped point as the aircraft moves.
function _gimbalToward(playerState, targetLLH) {
	const cosLat = Math.cos(playerState.lat * Math.PI / 180);
	const dE = (targetLLH.lon - playerState.lon) * 111320 * cosLat;
	const dN = (targetLLH.lat - playerState.lat) * 111320;
	const dU = (targetLLH.alt - playerState.alt);
	const horiz = Math.sqrt(dE * dE + dN * dN);
	const bearing = (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360;
	const elevation = Math.atan2(dU, Math.max(1, horiz)) * 180 / Math.PI;
	let az = bearing - playerState.heading;
	while (az >  180) az -= 360;
	while (az < -180) az += 360;
	return { az, el: elevation };
}

// Per-frame update from simLoop.
export function updateTgp(playerState, weaponSystem, mainViewer) {
	const cur = weaponSystem && weaponSystem.getCurrentWeapon && weaponSystem.getCurrentWeapon();
	const want = !!(cur && cur.id === 'gbu');
	if (want !== _visible) {
		_visible = want;
		if (_container) _container.style.display = want ? 'block' : 'none';
		if (want) _ensureFeedViewer();
	}
	if (!_visible) return;
	const fv = _ensureFeedViewer();
	if (!fv) return;

	// In TRACK / LASE: auto-aim the gimbal at the snapped world
	// point so the spot stays centered as the plane moves. Drag
	// is suppressed in those modes (gimbal authority belongs to
	// the tracking logic).
	if (playerDesignation.mode === 'TRACK' || playerDesignation.mode === 'LASE') {
		// Follow ground-unit targets if the snap was on one.
		const t = playerDesignation.target;
		if (t && !t.destroyed && t.active !== false) {
			playerDesignation.lon = t.lon;
			playerDesignation.lat = t.lat;
			playerDesignation.alt = t.alt;
		}
		const aim = _gimbalToward(playerState, playerDesignation);
		_gimbalAz = Math.max(-GIMBAL_AZ_LIMIT, Math.min(GIMBAL_AZ_LIMIT, aim.az));
		_gimbalEl = Math.max(GIMBAL_EL_MIN,    Math.min(GIMBAL_EL_MAX,    aim.el));
		if (playerDesignation.mode === 'LASE') {
			playerDesignation.lastLaseAt = performance.now() * 0.001;
		}
	}

	// Place the TGP camera at the player, oriented at heading +
	// gimbal. Heading wrap is handled by setView's own normalisation.
	const cameraHeading = playerState.heading + _gimbalAz;
	const cameraPitch   = _gimbalEl;
	const camPos = Cesium.Cartesian3.fromDegrees(playerState.lon, playerState.lat, playerState.alt);
	fv.camera.setView({
		destination: camPos,
		orientation: {
			heading: Cesium.Math.toRadians(cameraHeading),
			pitch:   Cesium.Math.toRadians(cameraPitch),
			roll:    0,
		},
	});
	// FOV. Cesium's PerspectiveFrustum exposes `fov` as the settable
	// horizontal FOV (in radians); `fovy` is a getter-only computed
	// vertical value — writing it throws and aborts the rest of this
	// function (camera spot raycast, status update, button repaint).
	if (fv.camera.frustum && 'fov' in fv.camera.frustum) {
		fv.camera.frustum.fov = _tgpFovDeg * Math.PI / 180;
	}
	fv.scene.requestRender();

	// Designation spot: cast forward ray from camera, hit the globe.
	const fwd = _forwardEcef(camPos, cameraHeading, cameraPitch);
	const ray = new Cesium.Ray(camPos, fwd);
	const hit = fv.scene.globe.pick(ray, fv.scene);
	if (hit) {
		const carto = Cesium.Cartographic.fromCartesian(hit);
		const spot = {
			lon: Cesium.Math.toDegrees(carto.longitude),
			lat: Cesium.Math.toDegrees(carto.latitude),
			alt: carto.height,
		};
		if (playerDesignation.mode === 'SLEW') {
			setSlewSpot(spot.lon, spot.lat, spot.alt);
		}
		// TRACK / LASE don't update from the ray — they hold the
		// snapped point. Reverse-aim is done above.
	}

	// Status text.
	const slantRange = _haversine(playerState, playerDesignation);
	const targetTxt = playerDesignation.target && playerDesignation.target.name
		? `<div>TGT  <span style="opacity:0.9">${playerDesignation.target.name}</span></div>` : '';
	_statusEl.innerHTML =
		`<div>MODE <span style="font-weight:bold;color:${_modeColor()}">${playerDesignation.mode}</span>` +
		`<span style="float:right; opacity:0.8">FOV ${_tgpFovDeg.toFixed(1)}°</span></div>` +
		`<div>AZ   ${_gimbalAz.toFixed(0)}°   <span style="margin-left:8px">EL ${_gimbalEl.toFixed(0)}°</span></div>` +
		`<div>SPOT ${playerDesignation.lat.toFixed(4)}°, ${playerDesignation.lon.toFixed(4)}°</div>` +
		`<div>RNG  ${(slantRange / 1000).toFixed(1)} km</div>` +
		targetTxt;

	// Repaint mode button colour.
	const m = playerDesignation.mode;
	_modeBtn.style.background =
		m === 'LASE'  ? 'rgba(120,0,0,0.85)' :
		m === 'TRACK' ? 'rgba(80,60,0,0.7)' :
		                'rgba(0,30,0,0.7)';
}

function _haversine(a, b) {
	const cosLat = Math.cos((a.lat || 0) * Math.PI / 180);
	const dE = (b.lon - a.lon) * 111320 * cosLat;
	const dN = (b.lat - a.lat) * 111320;
	const dU = (b.alt - a.alt);
	return Math.sqrt(dE * dE + dN * dN + dU * dU);
}
