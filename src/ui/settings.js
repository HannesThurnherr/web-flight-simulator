// ============================================================================
// Game settings — persistent user preferences plus last-played picks.
//
// Extracted from main.js to keep the bootstrap file focused on state-ownership
// and the sim loop. This module owns the `gameSettings` object, the localStorage
// read/write layer, and the DOM-checkbox sync for the Options modal.
//
// The object itself is exported as a mutable reference so callers that read
// individual fields (e.g. the scenario picker reading `gameSettings
// .lastScenarioId`) always see the current value. We never REASSIGN
// gameSettings — new values always land via `Object.assign` so the reference
// importers hold stays live.
// ============================================================================

import { getViewer } from '../world/cesiumWorld';
import { soundManager } from '../utils/soundManager';

export const gameSettings = {
	graphicsQuality: 'medium',
	antialiasing: true,
	fogEffects: true,
	// 'arcade' (default): everything is full-bright at all times so
	// you can see clearly during night flights — primarily a
	// gameplay-clarity choice. 'realistic': THREE.js scene lights
	// ramp with sun elevation at the player's lat/lon, so flying
	// over the dark side of the planet actually goes dark.
	lightingMode: 'arcade',
	mouseSensitivity: 0.2,
	showHud: true,
	showHorizonLines: true,
	soundEnabled: true,
	volume: 0.7,
	minimapRange: 10,
	// Persisted pre-flight selections. These mean the user doesn't have
	// to re-pick a scenario, airframe and spawn every time the page
	// reloads — the last values come back pre-selected. Each can be
	// overridden from its own menu UI before committing.
	lastScenarioId: null,
	lastPlaneId:    null,
	lastSpawn:      null, // { lon, lat, alt, heading }
	// Phase 5.5 — player-led formation. count is 0–3 wingmen spawned
	// in formation with the player; breakBehavior decides what they
	// do when out of strike-class ammo: 'rtb' (orbit spawn point) or
	// 'cap' (orbit player). Persisted so the choice survives a reload.
	formation: { count: 0, breakBehavior: 'rtb' },
	// Phase 6d — IFF realism, currently DEFAULT-ON (omniscient: true).
	// Reasoning: real Link-16 broadcasts every coalition member's exact
	// position continuously, so friend ID is trivial under normal
	// conditions — radar paint position correlates with the friendly
	// broadcast. The realistic identifyContact() pipeline (NCTR +
	// visual ID + per-pair IFF flake) only earns its keep when jamming
	// can knock out Link-16 reception, at which point you really are
	// down to sensor-only ID with ambiguity.
	//
	// 6e (jamming) is what creates that condition. Until then, the
	// scaffolding stays in place but defaults to omniscient so we
	// don't add fake uncertainty for things that wouldn't logically be
	// uncertain IRL. Power users can flip the toggle to test the
	// realistic pipeline standalone.
	iff: { omniscient: true },
};

// Read the stored settings blob into `gameSettings` WITHOUT touching any
// game state (no hud / controller / sound wiring yet). Split out from
// loadSettings so it can run at module-load time — specifically before
// the scenario / plane picker IIFEs read their persisted selection.
// Without this split the pickers always saw the hard-coded defaults on
// first render and the "last-played" values only took effect after the
// later applySettings() call, i.e. never for the initial menu state.
export function loadGameSettingsFromStorage() {
	const saved = localStorage.getItem('flightSimSettings');
	if (!saved) return;
	try {
		const parsed = JSON.parse(saved);
		// Migration: earlier builds shipped with showHorizonLines=false
		// as the default, so every long-time user has that value saved
		// without ever having chosen it. Now that the pitch ladder is
		// the primary attitude reference, force-upgrade stored `false`
		// to `true`. Users who actively want to hide the ladder can
		// still uncheck the box in the settings menu after load.
		if (parsed.showHorizonLines === false) parsed.showHorizonLines = true;
		Object.assign(gameSettings, parsed);
	} catch (e) {
		console.error('Failed to load settings', e);
	}
}

export function saveSettings() {
	localStorage.setItem('flightSimSettings', JSON.stringify(gameSettings));
}

export function updateSettingsUI() {
	document.getElementById('graphicsQuality').value = gameSettings.graphicsQuality;
	document.getElementById('antialiasing').checked = gameSettings.antialiasing;
	document.getElementById('fogEffects').checked = gameSettings.fogEffects;
	const lightSel = document.getElementById('lightingMode');
	if (lightSel) lightSel.value = gameSettings.lightingMode || 'arcade';
	document.getElementById('sensitivitySlider').value = gameSettings.mouseSensitivity;
	document.getElementById('sensitivityValue').textContent = gameSettings.mouseSensitivity;
	document.getElementById('showHud').checked = gameSettings.showHud;
	document.getElementById('showHorizonLines').checked = gameSettings.showHorizonLines;
	document.getElementById('soundEnabled').checked = gameSettings.soundEnabled;
	document.getElementById('minimapRange').value = gameSettings.minimapRange.toString();
	const iffOm = document.getElementById('iffOmniscient');
	if (iffOm) iffOm.checked = !!(gameSettings.iff && gameSettings.iff.omniscient);
}

// Apply the current settings to the live game systems. Safe to call
// before `hud` / `controller` exist — each target is guarded. The
// caller passes a `ctx` with live references to both because main.js
// creates those as module-scope `let`s that aren't exported.
//   ctx.hud         — HUD instance (may be null early at boot)
//   ctx.controller  — PlaneController instance (may be null early)
export function applySettings(ctx = {}) {
	const { hud, controller } = ctx;

	if (controller) {
		controller.setSensitivity(gameSettings.mouseSensitivity);
	}

	if (hud) {
		hud.setMinimapRange(gameSettings.minimapRange);
		hud.setShowHorizonLines(gameSettings.showHorizonLines);
	}

	if (soundManager && soundManager.listener) {
		// Final master = mute switch × volume slider. Either being off
		// silences everything; both come back together after toggle.
		const v = gameSettings.soundEnabled
			? Math.max(0, Math.min(1, gameSettings.volume ?? 1.0))
			: 0;
		soundManager.listener.setMasterVolume(v);
	}

	const viewer = getViewer();
	if (viewer) {
		if (gameSettings.graphicsQuality === 'low') {
			viewer.resolutionScale = 0.5;
			viewer.scene.globe.maximumScreenSpaceError = 4;
		} else if (gameSettings.graphicsQuality === 'medium') {
			viewer.resolutionScale = 0.75;
			viewer.scene.globe.maximumScreenSpaceError = 2;
		} else {
			viewer.resolutionScale = 1.0;
			viewer.scene.globe.maximumScreenSpaceError = 1.3;
		}

		viewer.scene.postProcessStages.fxaa.enabled = gameSettings.antialiasing;

		viewer.scene.fog.enabled = gameSettings.fogEffects;
		viewer.scene.atmosphere.show = gameSettings.fogEffects;
	}

	const hudElements = [
		document.getElementById('hud-top-left'),
		document.getElementById('hud-top-right'),
		document.getElementById('hud-speed-box'),
		document.getElementById('hud-alt-box'),
		document.getElementById('coords'),
		document.getElementById('minimap-container'),
	];

	hudElements.forEach(el => {
		if (el) {
			el.style.display = gameSettings.showHud ? 'block' : 'none';
		}
	});
}

// Full boot-time settings load: read from storage, apply to the live
// systems, and sync the Options modal's DOM checkboxes.
export function loadSettings(ctx = {}) {
	loadGameSettingsFromStorage();
	applySettings(ctx);
	updateSettingsUI();
}
