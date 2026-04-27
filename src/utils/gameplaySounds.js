// ============================================================================
// Gameplay sound bootstrap + global helpers.
//
// initSounds() loads every sound the game uses and wires the camera into
// soundManager so 3D-positional playback has a listener. stopAllFlyingSounds()
// is the single-line universal "kill everything flying-related" helper used
// on crash / pause / spawn transitions. setupButtonSounds() wires the hover +
// click chimes for all `.menu-btn` / `.clickable-ui` elements once.
//
// NOTE: pauseGameplaySounds / resumeGameplaySounds remain in main.js for now
// — they mutate the pause-timestamp and GPWS-cooldown state that still lives
// there. They'll move with the crash / pause manager extraction.
// ============================================================================

import { soundManager } from './soundManager';

// Load every sound and hand the listener to soundManager. The caller
// supplies `onLoaded()` so this module doesn't need to know about the
// loadingStatus / updateLoadingUI plumbing in ui/loadingUI.js.
//   camera    — THREE.PerspectiveCamera used as the 3D audio listener
//   onLoaded  — callback invoked after every sound finishes loading
export async function initSounds(camera, onLoaded) {
	soundManager.init(camera);

	await Promise.all([
		soundManager.loadSound('boost', '/assets/sounds/boost.mp3', false, 0.35),
		soundManager.loadSound('throttle', '/assets/sounds/throttle.mp3', false, 0.4),
		soundManager.loadSound('explode', '/assets/sounds/explode.mp3', false, 0.75),
		soundManager.loadSound('explosion-1', '/assets/sounds/explosion-1.mp3', false, 0.8),
		soundManager.loadSound('explosion-2', '/assets/sounds/explosion-2.mp3', false, 0.8),
		soundManager.loadSound('explosion-3', '/assets/sounds/explosion-3.mp3', false, 0.8),
		soundManager.loadSound('ambient-crash', '/assets/sounds/ambient.mp3', true, 0.5),
		soundManager.loadSound('weapon-warning', '/assets/sounds/weapon-warning-1.mp3', false, 1.0),
		soundManager.loadSound('jet-engine', '/assets/sounds/jet-engine.mp3', true, 0.5),
		soundManager.loadSound('spawn', '/assets/sounds/spawn.mp3', false, 0.5),
		soundManager.loadSound('roll', '/assets/sounds/roll.mp3', true, 0.75),
		soundManager.loadSound('pitch', '/assets/sounds/pitch.mp3', true, 0.75),
		soundManager.loadSound('button-click', '/assets/sounds/button-click.mp3', false, 1.0),
		soundManager.loadSound('weapon-switch', '/assets/sounds/weapon-switch.mp3', false, 0.75),
		soundManager.loadSound('button-hover', '/assets/sounds/button-hover.mp3', false, 0.25),
		soundManager.loadSound('zoom-in', '/assets/sounds/zoom-in.mp3', false, 0.5),
		soundManager.loadSound('missile-fire', '/assets/sounds/missile-firing-1.mp3', false, 0.75),
		soundManager.loadSound('m61-firing', '/assets/sounds/m61-firing.mp3', true, 0.75),
		soundManager.loadSound('rwr-tws', '/assets/sounds/rwr-tws.mp3', true, 0.10),
		soundManager.loadSound('rwr-lock', '/assets/sounds/rwr-lock.mp3', false, 0.10),
		// Phase 3c — distinct cues for the *player being painted*. Re-uses
		// the same audio assets as the player's own lock progress, but
		// with separate sound names so the two states can play at the same
		// time without stepping on each other.
		//   rwr-spike      = continuous tone, played while any bandit has
		//                    you in STT (fox-3 commit imminent).
		//   rwr-spike-ping = one-shot tick the moment a new bandit's STT
		//                    spike fires — the "snap" that draws the eye.
		soundManager.loadSound('rwr-spike',      '/assets/sounds/rwr-tws.mp3',  true,  0.18),
		soundManager.loadSound('rwr-spike-ping', '/assets/sounds/rwr-lock.mp3', false, 0.18),
		soundManager.loadSound('wind', '/assets/sounds/wind.mp3', true, 0.25),
		soundManager.loadSound('terrain-pull-up', '/assets/sounds/terrain-pull-up.mp3', false, 0.9),
		soundManager.loadSound('warning', '/assets/sounds/warning.mp3', false, 0.6),
		soundManager.loadSound('glitch-1', '/assets/sounds/glitch-transition-1.mp3', false, 0.25),
		soundManager.loadSound('glitch-2', '/assets/sounds/glitch-transition-2.mp3', false, 0.25),
		soundManager.loadSound('glitch-3', '/assets/sounds/glitch-transition-3.mp3', false, 0.25),
		soundManager.loadSound('glitch-4', '/assets/sounds/glitch-transition-4.mp3', false, 0.25),
	]);

	if (typeof onLoaded === 'function') onLoaded();
	setupButtonSounds();
}

// Fade out every looping / continuous sound. Used on crash / pause /
// transition to silence whatever was playing from the previous mode.
export function stopAllFlyingSounds(fadeOut = 0.5) {
	soundManager.stopAll(fadeOut);
}

// Hover-click chimes for every clickable button in the app. Idempotent:
// attaches `document`-level capture listeners that match via closest(),
// so new buttons added later pick the sounds up automatically.
export function setupButtonSounds() {
	document.addEventListener('mouseover', (e) => {
		const target = e.target.closest('button, .menu-btn, .clickable-ui');
		if (target && !target._hovered) {
			soundManager.play('button-hover');
			target._hovered = true;
			target.addEventListener('mouseleave', () => { target._hovered = false; }, { once: true });
		}
	}, true);

	document.addEventListener('click', (e) => {
		const target = e.target.closest('button, .menu-btn, .clickable-ui, #search-toggle-btn');
		if (target) {
			soundManager.play('button-click');
		}
	}, true);
}
