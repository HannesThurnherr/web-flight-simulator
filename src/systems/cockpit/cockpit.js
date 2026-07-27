// ============================================================================
// Cockpit orchestrator — public API for the first-person cockpit view.
//
//   initCockpit(scene)                  build once at THREE bring-up
//   updateCockpit(dt, state, input, on) per-frame from simLoop
//   toggleCockpitView()                 C keybind (menus.js)
//   isCockpitEnabled()                  simLoop uses it to hide the chase
//                                       plane model while in the pit
//
// The cockpit lives entirely in CAMERA SPACE (pilot eye = origin). The
// pilot camera is already slaved to the airframe (plane HPR × mouse
// orbit), so bolting the cockpit to the airframe just means counter-
// rotating the whole group by the mouse-orbit quaternion each frame —
// drag right and the pit swings left past your view, exactly like
// turning your head.
//
// Also owns the small cosmetic models that make the pit feel alive:
//   - engine spool (RPM lags throttle), fuel burn from fuel flow,
//     nozzle/FTIT — feeds the EED strip + RPM/FUEL dials.
//   - G-heave + high-AOA buffet + afterburner rumble on the eyepoint.
//   - stick / throttle / rudder-pedal animation from live input.
// ============================================================================

import * as THREE from 'three';
import { getViewer } from '../../world/cesiumWorld';
import { buildCockpitGeometry } from './cockpitGeometry.js';
import { buildInstruments } from './cockpitInstruments.js';
import { buildMFDs } from './cockpitMFD.js';
import { buildCockpitHUD } from './cockpitHUD.js';

let root = null;
let parts = null;
let instruments = null;
let mfds = null;
let hud = null;

// Default OFF — the classic chase cam stays the default view; the pit is
// engaged explicitly with the C keybind each session.
let enabled = false;

// Cosmetic engine/fuel model shared by the dials + EED strip.
const engine = {
	rpm: 66, fuelKg: 6400, ffKgh: 900, nozPct: 14, ftit: 650, oilPsi: 44, t: 0,
};

// Eyepoint motion state.
let heave = 0;
let shakeT = 0;

const _orbitEuler = new THREE.Euler();
const _orbitQ = new THREE.Quaternion();

export function initCockpit(scene) {
	if (root || !scene) return;
	root = new THREE.Group();
	root.name = 'cockpit';
	root.visible = false;
	parts = buildCockpitGeometry();
	root.add(parts.group);
	instruments = buildInstruments(parts.panelGroup, parts.mats);
	mfds = buildMFDs(parts.panelGroup, parts.mats);
	hud = buildCockpitHUD(parts.group, parts.mats);
	scene.add(root);
	// Cockpit floodlight — lives on layer 1 only, so it lights the pit
	// without touching the world pass. Keeps the tub/consoles readable at
	// night (the scene's dynamic ambient drops to ~0 after dark), like
	// real console flood lighting. Warm, dim, short throw.
	const flood = new THREE.PointLight(0xffe4bc, 0.5, 2.6, 2);
	flood.position.set(0, 0.15, -0.15);
	root.add(flood);
	// LAYER 1 — critical. The animate loop renders layer 0 (world-space
	// meshes) with the THREE camera synced to Cesium's fovy (≈36–45°
	// vertical on a landscape window), then clears depth and renders
	// layer 1 (cockpit-space) at a fixed 75° FOV. The pit is sized for
	// the 75° pass; leaving it on layer 0 renders it hugely magnified
	// AND lets world geometry z-fight it.
	root.traverse((o) => { o.layers.set(1); });
}

export function isCockpitEnabled() {
	return enabled;
}

export function toggleCockpitView() {
	enabled = !enabled;
	return enabled;
}

// `active` = FLYING and the pilot camera owns the view (not commander /
// strike planner / spectator). Death (state.dying) keeps the pit visible:
// tumbling horizon + fire lights from the inside IS the death cam.
let _domMode = false;

export function updateCockpit(dt, state, input, active) {
	if (!root) return;
	const show = enabled && !!active && !!state;
	root.visible = show;
	// Sync the DOM overlay mode: hides the 2D HUD's center flight
	// symbology (speed/alt boxes, horizon ladder, 2D FPM, compass tape)
	// while the glass HUD is drawing the same data — see style.css.
	if (show !== _domMode) {
		_domMode = show;
		try { document.body.classList.toggle('cockpit-mode', show); } catch (e) { /* ssr */ }
	}
	if (!show) return;

	// ---- Cosmetic engine model -------------------------------------------
	const thr = state.dying ? 0 : (state.throttle || 0);
	const boost = !!state.isBoosting && !state.dying;
	engine.t += dt;
	const targetRpm = state.dying ? 12 : 65 + thr * 37 + (boost ? 4 : 0);
	engine.rpm += (targetRpm - engine.rpm) * Math.min(1, dt * 1.6);
	engine.ffKgh = Math.pow(Math.max(0, engine.rpm) / 100, 2.6) * 3800 + (boost ? 9000 : 0);
	const targetNoz = boost ? 98 : (thr > 0.92 ? 55 : 14 + thr * 28);
	engine.nozPct += (targetNoz - engine.nozPct) * Math.min(1, dt * 3);
	engine.ftit = 350 + engine.rpm * 4.6 + (boost ? 170 : 0);
	engine.fuelKg = Math.max(0, engine.fuelKg - (engine.ffKgh / 3600) * dt);
	engine.oilPsi = 44 + Math.sin(engine.t * 0.4) * 1.5;

	// ---- Airframe-fixed orientation (counter-rotate the mouse orbit) ------
	const camYaw = input ? (input.cameraYaw || 0) : 0;
	const camPitch = input ? (input.cameraPitch || 0) : 0;
	_orbitEuler.set(
		THREE.MathUtils.degToRad(-camPitch),
		THREE.MathUtils.degToRad(-camYaw),
		0, 'YXZ',
	);
	_orbitQ.setFromEuler(_orbitEuler).invert();
	root.quaternion.copy(_orbitQ);

	// ---- Eyepoint motion: G-heave + buffet ---------------------------------
	// Positive G presses the pilot down → cockpit appears to rise slightly.
	const g = state.loadFactor || 1;
	const heaveTarget = THREE.MathUtils.clamp((g - 1) * 0.006, -0.014, 0.022);
	heave += (heaveTarget - heave) * Math.min(1, dt * 5);
	shakeT += dt;
	const alpha = Math.abs(state.alpha || 0);
	let buffet = Math.max(0, (alpha - 14) / 12) * 0.9;
	if (boost) buffet += 0.28;
	if (state.dying) buffet += 1.2;
	buffet = Math.min(buffet, 1.6);
	const jx = (Math.sin(shakeT * 61.0) + 0.6 * Math.sin(shakeT * 47.3)) * 0.0011 * buffet;
	const jy = (Math.cos(shakeT * 53.7) + 0.5 * Math.sin(shakeT * 71.1)) * 0.0010 * buffet;
	root.position.set(jx, heave + jy, 0);

	// ---- Controls animation --------------------------------------------------
	if (parts.stick) {
		const ip = input ? (input.pitch || 0) : 0;
		const ir = input ? (input.roll || 0) : 0;
		parts.stick.rotation.x = ip * 0.20;
		parts.stick.rotation.z = -ir * 0.16;
	}
	if (parts.throttle) {
		parts.throttle.rotation.x = 0.42 - thr * 0.95 - (boost ? 0.07 : 0);
	}
	if (parts.pedals) {
		const iy = input ? (input.yaw || 0) : 0;
		// Base z must match the pedal groups' build position in
		// cockpitGeometry.js.
		parts.pedals.right.position.z = -0.92 - iy * 0.05;
		parts.pedals.left.position.z  = -0.92 + iy * 0.05;
	}

	// ---- Avionics -------------------------------------------------------------
	// The HUD needs the WORLD pass's vertical FOV (Cesium's fovy) to keep
	// its pitch ladder / FPM angularly locked to the outside scene — the
	// pit itself renders in the separate fixed-75° layer-1 pass.
	let worldFovDeg = 75;
	try {
		const v = getViewer();
		if (v && v.camera && v.camera.frustum && v.camera.frustum.fovy) {
			worldFovDeg = THREE.MathUtils.radToDeg(v.camera.frustum.fovy);
		}
	} catch (e) { /* viewer not up yet */ }
	instruments.update(state, dt, engine);
	mfds.update(state, dt, engine);
	hud.update(state, dt, worldFovDeg);
}
