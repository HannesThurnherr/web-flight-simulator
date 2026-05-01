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
import { soundManager } from '../utils/soundManager';

// Push the volume controls' state into the master gain. Lives next to
// the pause-menu wiring so the pause-screen slider/mute and the main
// settings modal share a single update path. Mute switch × slider:
// either being off silences everything; the slider's value is preserved
// across a mute toggle so re-enabling brings the audio back where it
// was.
function applyVolumeFromSettings() {
	if (!soundManager || !soundManager.listener) return;
	const v = gameSettings.soundEnabled
		? Math.max(0, Math.min(1, gameSettings.volume ?? 1))
		: 0;
	soundManager.listener.setMasterVolume(v);
}

// Sync the pause-menu volume widgets (slider, mute icon, % readout) to
// the live gameSettings. Called every time the pause modal opens so the
// widgets reflect any changes made via the main settings modal in the
// meantime, and after a slider/button event so the readout updates.
function refreshPauseVolumeWidgets() {
	const slider = document.getElementById('pauseVolumeSlider');
	const value  = document.getElementById('pauseVolumeValue');
	const muteBtn = document.getElementById('pauseMuteBtn');
	const muteIcon = document.getElementById('pauseMuteIcon');
	const wrap   = document.getElementById('pauseVolume');
	if (!slider || !value || !muteBtn || !muteIcon) return;
	const pct = Math.round(((gameSettings.volume ?? 1) * 100));
	slider.value = String(pct);
	const muted = !gameSettings.soundEnabled || (gameSettings.volume ?? 1) <= 0;
	value.textContent = muted ? 'MUTE' : `${pct}%`;
	muteIcon.textContent = gameSettings.soundEnabled ? '🔊' : '🔇';
	muteBtn.classList.toggle('muted', !gameSettings.soundEnabled);
	if (wrap) wrap.classList.toggle('muted', muted);
}
import { getEvents } from '../systems/eventLog';

// Render the kill / crash log into the pause-screen panel. Called from
// the pause-open handler so the snapshot always reflects what just
// happened up to the moment the player hit Escape.
//
// Layout: one row per event, time on the left, "X → Y · WEAPON" on the
// right. Player-involved events get a colour cue (cyan when player is
// the shooter, red when player is the victim); crashes use amber.
function renderPauseKillLog() {
	const root = document.getElementById('pause-killlog');
	const count = document.getElementById('pause-killlog-count');
	if (!root) return;

	const events = getEvents();
	if (count) count.textContent = `${events.length} EVENT${events.length === 1 ? '' : 'S'}`;

	if (events.length === 0) {
		root.innerHTML = '<div class="killlog-empty">— no engagements yet —</div>';
		return;
	}

	// Newest first. The mission tape is stored chronological; flip on
	// render so the player sees what just happened without scrolling.
	const now = performance.now() * 0.001;
	const rows = [];
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		const ago = Math.max(0, now - e.at);
		const m = Math.floor(ago / 60);
		const s = Math.floor(ago % 60);
		const time = `T-${m}:${s.toString().padStart(2, '0')}`;

		const cls = ['killlog-row'];
		if (e.reason === 'crash') cls.push('crash');
		if (e.shooter === 'PLAYER') cls.push('player-killer');
		if (e.target  === 'PLAYER') cls.push('player-victim');
		// Faction colour cue for non-player parties.
		if (e.shooterTeam) cls.push('team-' + e.shooterTeam);

		rows.push(`
			<div class="${cls.join(' ')}">
				<span class="killlog-time">${time}</span>
				<span class="killlog-body">
					<span class="killlog-shooter">${escapeHtml(e.shooter)}</span>
					<span class="killlog-arrow">▶</span>
					<span class="killlog-target">${escapeHtml(e.target)}</span>
					<span class="killlog-weapon">[${escapeHtml(e.weapon)}]</span>
				</span>
			</div>
		`);
	}
	root.innerHTML = rows.join('');
}

function escapeHtml(s) {
	if (s == null) return '';
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

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
		// Phase 6d — sensor-fidelity panel.
		const iffOm = document.getElementById('iffOmniscient');
		if (iffOm) {
			gameSettings.iff = gameSettings.iff || {};
			gameSettings.iff.omniscient = !!iffOm.checked;
		}

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

	// ---- Pause-menu volume widgets ------------------------------------------
	const slider  = document.getElementById('pauseVolumeSlider');
	const muteBtn = document.getElementById('pauseMuteBtn');
	if (slider) {
		slider.addEventListener('input', () => {
			gameSettings.volume = Math.max(0, Math.min(1, slider.value / 100));
			applyVolumeFromSettings();
			refreshPauseVolumeWidgets();
			saveSettings();
		});
	}
	if (muteBtn) {
		muteBtn.addEventListener('click', () => {
			gameSettings.soundEnabled = !gameSettings.soundEnabled;
			applyVolumeFromSettings();
			refreshPauseVolumeWidgets();
			saveSettings();
		});
	}
	// Initial sync so the widgets reflect persisted state on first
	// pause-modal open.
	refreshPauseVolumeWidgets();

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
				// If we entered spectator mode while dead, the crash
				// menu was hidden + the THREE canvas was unhidden on
				// the way in (main.js spectator-request handler).
				// Restore the CRASHED-only state on the way out so
				// the player still has access to RESPAWN / RESPAWN
				// ELSEWHERE from where they left off.
				if (ctx.currentState === 'CRASHED') {
					const crashMenu = document.getElementById('crashMenu');
					if (crashMenu) crashMenu.classList.remove('hidden');
					const threeContainer = document.getElementById('threeContainer');
					if (threeContainer) threeContainer.classList.add('hidden');
				}
				e.preventDefault();
				return;
			}
		}

		// Radar emitter toggle (silent-running / emcon). Bound to 'r'
		// in cockpit flight only. Commander view also binds 'r'
		// (debug overlay) but gates on commanderView.active, so the
		// two don't collide. Flips state.sensors.radar.active, which
		// the unified detectRadar() reads as the emitter-on check;
		// going SILENT means bandits' RWRs no longer see your search
		// or track emissions, but you also stop painting them and
		// have to fly the air picture from datalink + IRST + RWR.
		if (key === 'r' && ctx.currentState === 'FLYING' &&
			!(ctx.commanderView && ctx.commanderView.active) &&
			!(ctx.strikePlannerView && ctx.strikePlannerView.active)) {
			if (state.sensors && state.sensors.radar) {
				state.sensors.radar.active = !state.sensors.radar.active;
				if (ctx.hud && ctx.hud.showRadarToast) {
					if (state.sensors.radar.active) {
						const pm = (state.sensors.radar.playerMode || 'tws').toUpperCase();
						ctx.hud.showRadarToast(`RADAR ACTIVE — ${pm}`, 'rgba(96, 255, 144, 0.95)');
					} else {
						ctx.hud.showRadarToast('RADAR SILENT — DATALINK / RWR ONLY',
							'rgba(180, 180, 180, 0.95)');
					}
				}
			}
			e.preventDefault();
			return;
		}

		// 6b — radar mode cycle. T cycles RWS → TWS → STT → RWS for
		// the player. RWS = no firing-grade locks (passive scan); TWS
		// = locks progress, victim RWR shows TWS class (no STT spike);
		// STT = locks fast on the designated target, victim RWR shows
		// STT spike. The mode-manager in simLoop.js translates the
		// player choice into the internal radar.mode flag the rest
		// of the system already speaks. See KEYBINDS.md.
		if (key === 't' && ctx.currentState === 'FLYING' &&
			!(ctx.commanderView && ctx.commanderView.active) &&
			!(ctx.strikePlannerView && ctx.strikePlannerView.active)) {
			if (state.sensors && state.sensors.radar) {
				const order = ['rws', 'tws', 'stt'];
				const cur   = state.sensors.radar.playerMode || 'tws';
				const next  = order[(order.indexOf(cur) + 1) % order.length];
				state.sensors.radar.playerMode = next;
				if (ctx.hud && ctx.hud._flashScopeMode) {
					ctx.hud._flashScopeMode(next);
				}
				// Toast only when committing to STT — that's the
				// "I'm shooting" mode the player needs to consciously
				// notice. RWS/TWS swaps are routine, scope flash alone
				// is enough.
				if (next === 'stt' && ctx.hud && ctx.hud.showRadarToast) {
					ctx.hud.showRadarToast('STT — COMMIT', 'rgba(255, 96, 96, 0.95)', 1.5);
				}
			}
			e.preventDefault();
			return;
		}

		// 6e.3 — defensive EW jammer toggle. Press once = start
		// broadcasting protective noise around your aircraft;
		// press again = stop. Each frame, every active-radar
		// missile inbound on the player rolls a per-second
		// break-lock probability. No charges, no cooldown — runs
		// as long as toggled. Only fires if the airframe has a
		// jammer pod attached (state.jammer set in loadPlayerPlane).
		if (key === 'j' && ctx.currentState === 'FLYING' &&
			!(ctx.commanderView && ctx.commanderView.active) &&
			!(ctx.strikePlannerView && ctx.strikePlannerView.active)) {
			if (state.jammer) {
				state.jammer.defensiveOn = !state.jammer.defensiveOn;
				if (ctx.hud && ctx.hud.showRadarToast) {
					if (state.jammer.defensiveOn) {
						ctx.hud.showRadarToast('EW: DEFENSIVE',
							'rgba(255, 140, 80, 0.95)', 1.6);
					} else {
						ctx.hud.showRadarToast('EW: STANDBY',
							'rgba(180, 180, 180, 0.95)', 1.2);
					}
				}
			} else if (ctx.hud && ctx.hud.showRadarToast) {
				// Tell the player they're flying an airframe without
				// a jammer pod, rather than silently swallowing the J
				// press. Common confusion source.
				ctx.hud.showRadarToast('NO JAMMER POD ON THIS AIRFRAME',
					'rgba(180, 180, 180, 0.85)', 1.2);
			}
			e.preventDefault();
			return;
		}

		// 6a — radar / SA scope mode toggles, cockpit-only.
		//   '  (apostrophe) → toggle Cesium terrain background under the
		//                     scope (map mode ON ↔ pure tactical scope)
		//   ;  (semicolon)   → toggle compact ↔ expanded size
		// Two independent toggles so the player can have any combo of
		// {map, no-map} × {compact, expanded}. M is reserved by the
		// commander view; ` is awkward on Swiss layouts. Strike
		// planner has its own A/C/L/R bindings — these only fire when
		// the planner is INACTIVE so the two don't collide. See
		// KEYBINDS.md for the canonical bind list.
		if (ctx.currentState === 'FLYING' && ctx.hud &&
			!(ctx.commanderView && ctx.commanderView.active) &&
			!(ctx.strikePlannerView && ctx.strikePlannerView.active)) {
			if (key === "'") {
				ctx.hud.toggleRadarBackground();
				e.preventDefault();
				return;
			}
			if (key === ';') {
				ctx.hud.toggleRadarExpanded();
				e.preventDefault();
				return;
			}
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
				renderPauseKillLog();
				refreshPauseVolumeWidgets();
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
