// ============================================================================
// Crash detection + GPWS (Ground Proximity Warning System).
//
// checkGPWS()  — per-frame check that blasts "PULL UP" on the HUD + the
//                terrain-pull-up aural alert when the jet is diving at
//                shallow AGL.
// checkCrash() — transitions FLYING → CRASHED when either (a) something
//                set state.destroyed (missile hit sweep in a projectile
//                update), or (b) altitude drops through terrain + 5 m,
//                with a 100 ms rate-limit and a 3 s grace period after
//                spawn so the initial flight-in doesn't immediately
//                trigger a crash.
// doCrashTransition() — fires the crash-menu UI + kills the flying
//                sounds + queues the explode/ambient audio.
//
// Extracted from main.js — `lastCrashCheck` moves with the module
// since it's just an internal rate-limit. `flightStartTime` stays
// on ctx (main.js still owns it because the spawn-confirm handler
// writes to it too).
// ============================================================================

import * as Cesium from 'cesium';
import { getViewer } from '../world/cesiumWorld';
import { soundManager } from '../utils/soundManager';
import { stopAllFlyingSounds } from '../utils/gameplaySounds';

// Internal rate-limit for the terrain-sample crash check. Kept module-
// private because no other caller needs to see it.
let lastCrashCheck = 0;

// GPWS aural + visual cooldown. `lastGPWSWarningTime` is stored on ctx
// (main.js module scope) because it gets a pause-duration bump in
// resumeGameplaySounds — see the pause handling in main.js.
const GPWS_COOLDOWN = 1800;

// Per-frame ground-proximity check. Writes to:
//   - hud.setPullUpWarning(bool) — visual cue
//   - soundManager (plays / stops 'terrain-pull-up')
//   - ctx.setGpwsActive / setLastGPWSWarningTime — shared state the
//     pause-resume handler reads to offset the cooldown over pauses
export function checkGPWS(ctx) {
	const { state } = ctx;
	if (ctx.currentState !== 'FLYING') {
		ctx.hud.setPullUpWarning(false);
		return;
	}

	const viewer = getViewer();
	if (!viewer) return;

	const cartographic = Cesium.Cartographic.fromDegrees(state.lon, state.lat);
	const terrainHeight = viewer.scene.globe.getHeight(cartographic);

	if (terrainHeight === undefined) return;

	const agl = state.alt - terrainHeight;
	const pitchRad = Cesium.Math.toRadians(state.pitch);
	const verticalSpeed = state.speed * Math.sin(pitchRad);

	let showWarning = false;

	if (state.pitch < -1) {
		if (agl < 450) {
			if (agl < 150) {
				showWarning = true;
			}

			if (verticalSpeed < -20) {
				showWarning = true;
			}
		}
	}

	ctx.hud.setPullUpWarning(showWarning);

	if (showWarning) {
		const now = Date.now();
		if (!ctx.getGpwsActive() ||
			(now - ctx.getLastGPWSWarningTime() > GPWS_COOLDOWN &&
			 !soundManager.isPlaying('terrain-pull-up'))) {
			soundManager.play('terrain-pull-up');
			ctx.setLastGPWSWarningTime(now);
		}
		ctx.setGpwsActive(true);
	} else {
		if (ctx.getGpwsActive()) {
			soundManager.stop('terrain-pull-up', 0.1);
			ctx.setGpwsActive(false);
		}
	}
}

// Fire the FLYING → CRASHED transition. Hides the cockpit HUD, shows
// the crash menu, fades out flying sounds, schedules the explode +
// ambient audio 50 ms later so the sound stack gets a clean reset
// before the explosion plays.
export function doCrashTransition(ctx) {
	ctx.setCurrentState('CRASHED');
	if (ctx.dialogueSystem) ctx.dialogueSystem.stop();
	document.getElementById('uiContainer').classList.add('hidden');
	const weaponsHud = document.getElementById('weapons-hud');
	if (weaponsHud) weaponsHud.classList.add('hidden');
	document.getElementById('threeContainer').classList.add('hidden');
	document.getElementById('crashMenu').classList.remove('hidden');
	ctx.hud.update(ctx.state, []);

	stopAllFlyingSounds(0.1);
	setTimeout(() => {
		soundManager.play('explode');
		soundManager.play('ambient-crash');
	}, 50);
}

// Per-frame crash check. Two paths:
//   1. state.destroyed was set (missile hit sweep on the player) —
//      transition immediately, no rate-limit.
//   2. Terrain collision — sample globe height at the player's lon/lat
//      every 100 ms; if the player is ≤5 m above it, transition. A 3 s
//      grace period after flightStartTime prevents the initial camera
//      flyTo from triggering this.
export function checkCrash(ctx) {
	const { state } = ctx;
	if (ctx.currentState !== 'FLYING') return;

	// Missile kill: projectile sets state.destroyed=true via hitNPC
	// since `state` is passed in the target list the same way NPCs
	// are. Handle this immediately — no 100 ms rate-limit — so the
	// transition is crisp. We DON'T clear state.destroyed here: it
	// must stay true while the player is dead, otherwise the NPC
	// TargetManager will see the player as an available target at
	// the frozen crash coordinates and keep firing at thin air.
	// It's reset to false on respawn.
	if (state.destroyed && ctx.currentState === 'FLYING') {
		doCrashTransition(ctx);
		return;
	}

	const now = Date.now();
	if (now - lastCrashCheck < 100) return;
	lastCrashCheck = now;

	if (now - ctx.getFlightStartTime() < 3000) return;

	const viewer = getViewer();
	if (!viewer) return;

	const cartographic = Cesium.Cartographic.fromDegrees(state.lon, state.lat);
	const terrainHeight = viewer.scene.globe.getHeight(cartographic);

	if (terrainHeight !== undefined && state.alt <= terrainHeight + 5) {
		doCrashTransition(ctx);
	}
}
