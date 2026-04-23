// ============================================================================
// Menus, modal lifecycle, pause/resume/respawn buttons, and the top-level
// global keybinds (Escape/P/Space/R/Z).
//
// All of this was sitting at module top-level in main.js, spread between the
// modal setup block, the crash-menu wiring, and a handful of window.addEvent
// Listener calls. Extracted here so main.js just orchestrates bootstrap
// order — see the ctx shape at the top of main.js for the read/write
// surface this module uses.
// ============================================================================

import { enterSpawnPicking, exitSpawnPicking, quickRespawn, hasScenarioSpawnPoint } from '../systems/spawnFlow';
import { setRenderOptimization } from '../world/cesiumWorld';
import { gameSettings, saveSettings, applySettings, updateSettingsUI } from './settings';

// Hide every modal in the document. Shared helper used by almost every
// button handler below.
export function closeAllModals() {
	document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
}

// Main-menu + in-flight modal dialog plumbing — help/options/credits/
// about buttons, the save-settings handler, generic close-modal ×
// buttons, and "click outside modal = close" window listener.
export function setupModalListeners(ctx) {
	document.getElementById('helpBtn').onclick = () => {
		closeAllModals();
		document.getElementById('helpModal').classList.remove('hidden');
	};

	document.getElementById('optionsBtn').onclick = () => {
		closeAllModals();
		updateSettingsUI();
		document.getElementById('optionsModal').classList.remove('hidden');
	};

	document.getElementById('pauseOptionsBtn').onclick = () => {
		closeAllModals();
		updateSettingsUI();
		document.getElementById('optionsModal').classList.remove('hidden');
	};

	document.getElementById('pauseHelpBtn').onclick = () => {
		closeAllModals();
		document.getElementById('helpModal').classList.remove('hidden');
	};

	document.getElementById('creditsBtn').onclick = () => {
		closeAllModals();
		document.getElementById('creditsModal').classList.remove('hidden');
	};

	document.getElementById('aboutBtn').onclick = () => {
		closeAllModals();
		document.getElementById('aboutBtnModal').classList.remove('hidden');
	};

	document.getElementById('sensitivitySlider').oninput = (e) => {
		document.getElementById('sensitivityValue').textContent = e.target.value;
	};

	document.getElementById('saveOptionsBtn').onclick = () => {
		gameSettings.graphicsQuality  = document.getElementById('graphicsQuality').value;
		gameSettings.antialiasing     = document.getElementById('antialiasing').checked;
		gameSettings.fogEffects       = document.getElementById('fogEffects').checked;
		gameSettings.mouseSensitivity = parseFloat(document.getElementById('sensitivitySlider').value);
		gameSettings.showHud          = document.getElementById('showHud').checked;
		gameSettings.showHorizonLines = document.getElementById('showHorizonLines').checked;
		gameSettings.soundEnabled     = document.getElementById('soundEnabled').checked;
		gameSettings.minimapRange     = parseInt(document.getElementById('minimapRange').value);

		saveSettings();
		applySettings({ hud: ctx.hud, controller: ctx.controller });
		closeAllModals();
	};

	document.querySelectorAll('.close-modal').forEach(btn => {
		btn.onclick = (e) => {
			e.stopPropagation();
			btn.closest('.modal').classList.add('hidden');
		};
	});

	window.addEventListener('click', (event) => {
		if (event.target.classList.contains('modal')) {
			event.target.classList.add('hidden');
		}
	});
}

// Start / resume / restart / quit / respawn / change-spawn buttons.
// Every one of these touches the state machine or the spawn flow, so
// they all route through ctx rather than importing main.js directly.
export function setupPauseAndRespawnButtons(ctx) {
	const mainMenu  = document.getElementById('mainMenu');
	const pauseMenu = document.getElementById('pauseMenu');
	const crashMenu = document.getElementById('crashMenu');
	const uiContainer = document.getElementById('uiContainer');

	document.getElementById('startBtn').onclick = () => {
		closeAllModals();
		mainMenu.classList.add('hidden');
		enterSpawnPicking(ctx, false);
	};

	document.getElementById('resumeBtn').onclick = () => {
		closeAllModals();
		pauseMenu.classList.add('hidden');
		uiContainer.classList.remove('hidden');
		const weaponsHud = document.getElementById('weapons-hud');
		if (weaponsHud) weaponsHud.classList.remove('hidden');
		ctx.setCurrentState('FLYING');
		if (ctx.dialogueSystem) ctx.dialogueSystem.resume();
		ctx.resumeGameplaySounds();
	};

	document.getElementById('restartBtn').onclick = () => {
		closeAllModals();
		pauseMenu.classList.add('hidden');
		if (ctx.dialogueSystem) ctx.dialogueSystem.stop();
		enterSpawnPicking(ctx, true);
	};

	document.getElementById('quitBtn').onclick = () => {
		closeAllModals();
		if (ctx.dialogueSystem) ctx.dialogueSystem.stop();
		setRenderOptimization(true);
		location.reload();
	};

	// Crash-menu RESPAWN: put the player back into the ongoing scenario
	// at the spawn pose captured on initial confirm-spawn, without
	// tearing down NPCs, clearing the datalink, or re-running
	// scenario.onStart. Scenario keeps running in the background during
	// the crash screen (NPCs / sensors / missiles already tick in
	// CRASHED state), so all we do is reset the player's own physics /
	// ammo and flip the state back to FLYING.
	document.getElementById('respawnBtn').onclick = () => {
		closeAllModals();
		if (!hasScenarioSpawnPoint()) {
			// No spawn pose stored — first run or the scenario was
			// never confirmed. Fall back to full re-pick so we don't
			// spawn at undefined coords.
			crashMenu.classList.add('hidden');
			if (ctx.dialogueSystem) ctx.dialogueSystem.stop();
			enterSpawnPicking(ctx, true);
			return;
		}
		quickRespawn(ctx);
	};

	// "CHANGE SPAWN" — send the user back to the map to pick a new
	// spawn point instead of quick-respawning at the original coords.
	// Useful for repositioning after a bad choice, or to move to a
	// different part of the battlefield without reloading the whole
	// scenario.
	const respawnElsewhereBtn = document.getElementById('respawnElsewhereBtn');
	if (respawnElsewhereBtn) {
		respawnElsewhereBtn.onclick = () => {
			closeAllModals();
			crashMenu.classList.add('hidden');
			if (ctx.dialogueSystem) ctx.dialogueSystem.stop();
			// Clear scenario state + NPCs; enterSpawnPicking's
			// onStop handles this. The spawn picker will reuse
			// gameSettings.lastSpawn to pre-populate, which the user
			// can override by clicking anywhere else on the map.
			enterSpawnPicking(ctx, true);
		};
	}
}

// Global keyboard shortcuts — Escape/P pause, Space pause inside
// commander view, R toggle radar emitter, Z skip dialogue. Each branch
// preserves the exact priority + side-effect order that was in main.js.
export function setupGlobalKeybinds(ctx) {
	const pauseMenu = document.getElementById('pauseMenu');
	const uiContainer = document.getElementById('uiContainer');
	const { state } = ctx;

	window.addEventListener('keydown', (e) => {
		const key = e.key.toLowerCase();
		if (key === 'escape') {
			const openModals = document.querySelectorAll('.modal:not(.hidden)');
			if (openModals.length > 0) {
				openModals.forEach(m => m.classList.add('hidden'));
				return;
			}
			// Spectator exit — return control to the pilot camera.
			// Runs before the pause-menu branch below so Escape
			// "backs out" of spectator view first instead of jumping
			// straight to pause.
			if (ctx.spectatorTarget) {
				ctx.setSpectatorTarget(null);
				e.preventDefault();
				return;
			}
		}

		// Radar emitter toggle (silent-running test). Bound to 'r' in
		// cockpit flight only. Commander view also binds 'r' (debug
		// overlay) but gates on commanderView.active, so the two
		// don't collide. Flips state.sensors.radar.active, which the
		// unified detectRadar() reads as the emitter-on check.
		if (key === 'r' && ctx.currentState === 'FLYING' &&
			!(ctx.commanderView && ctx.commanderView.active)) {
			if (state.sensors && state.sensors.radar) {
				state.sensors.radar.active = !state.sensors.radar.active;
			}
			e.preventDefault();
			return;
		}

		// Space toggles pause while the commander view is open.
		// Lighter-weight than Escape/P: no pause menu overlay, just
		// freezes the world so you can survey the battlefield without
		// it evolving under you. The map's own pan/zoom/tilt still
		// works because we keep ticking commanderView while paused.
		// Outside the map, Space falls through so other systems can
		// use it.
		if (key === ' ' && ctx.commanderView && ctx.commanderView.active) {
			if (ctx.currentState === 'FLYING') {
				ctx.setCurrentState('PAUSED');
				if (ctx.dialogueSystem) ctx.dialogueSystem.pause();
				ctx.pauseGameplaySounds();
			} else if (ctx.currentState === 'PAUSED') {
				ctx.setCurrentState('FLYING');
				if (ctx.dialogueSystem) ctx.dialogueSystem.resume();
				// Defensive: if the user paused with ESC/P first
				// (which shows the full pause menu), hide it on
				// Space-unpause so the map isn't left with a
				// lingering overlay.
				pauseMenu.classList.add('hidden');
				ctx.resumeGameplaySounds();
			}
			if (ctx.commanderView.setPausedBadge) {
				ctx.commanderView.setPausedBadge(ctx.currentState === 'PAUSED');
			}
			e.preventDefault();
			return;
		}

		if (key === 'escape' || key === 'p') {
			if (ctx.currentState === 'FLYING') {
				ctx.setCurrentState('PAUSED');
				if (ctx.dialogueSystem) ctx.dialogueSystem.pause();
				uiContainer.classList.add('hidden');
				const weaponsHud = document.getElementById('weapons-hud');
				if (weaponsHud) weaponsHud.classList.add('hidden');
				pauseMenu.classList.remove('hidden');
				ctx.hud.resizeMinimap();
				ctx.pauseGameplaySounds();
				ctx.hud.update(state, []);
			} else if (ctx.currentState === 'PAUSED') {
				ctx.setCurrentState('FLYING');
				if (ctx.dialogueSystem) ctx.dialogueSystem.resume();
				pauseMenu.classList.add('hidden');
				uiContainer.classList.remove('hidden');
				const weaponsHud = document.getElementById('weapons-hud');
				if (weaponsHud) weaponsHud.classList.remove('hidden');
				ctx.resumeGameplaySounds();
			} else if (ctx.currentState === 'PICK_SPAWN' && key === 'escape') {
				exitSpawnPicking(ctx);
			}
		}

		if (key === 'z' && ctx.currentState === 'FLYING') {
			if (ctx.dialogueSystem) ctx.dialogueSystem.skip();
		}
	});
}

// Auto-pause when the tab loses focus (visibilitychange) OR when the
// window loses keyboard focus (blur). Both branches duplicate the
// "paused" UI flip that ESC/P runs so the game can't keep running
// invisibly while the user is in another app.
export function setupWindowLifecycleHandlers(ctx) {
	const pauseMenu = document.getElementById('pauseMenu');
	const uiContainer = document.getElementById('uiContainer');
	const { state } = ctx;

	document.addEventListener('visibilitychange', () => {
		if (document.hidden && ctx.currentState === 'FLYING') {
			ctx.setCurrentState('PAUSED');
			if (ctx.dialogueSystem) ctx.dialogueSystem.pause();
			uiContainer.classList.add('hidden');
			pauseMenu.classList.remove('hidden');
			ctx.hud.resizeMinimap();
			ctx.pauseGameplaySounds();
			ctx.hud.update(state, []);
		}
	});

	window.addEventListener('blur', () => {
		if (ctx.currentState === 'FLYING') {
			ctx.setCurrentState('PAUSED');
			if (ctx.dialogueSystem) ctx.dialogueSystem.pause();
			uiContainer.classList.add('hidden');
			pauseMenu.classList.remove('hidden');
			ctx.hud.resizeMinimap();
			ctx.pauseGameplaySounds();
			ctx.hud.update(state, []);
		}
	});
}
