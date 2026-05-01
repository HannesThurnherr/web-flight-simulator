// ============================================================================
// requestAnimationFrame loop.
//
// Keeps one job: drive the per-frame tick. Wakes up every frame,
// computes dt from the THREE clock, bumps the FPS counter, syncs the
// THREE camera's FOV to Cesium's, runs `update(dt, ctx)`, then does
// the two-pass THREE render (layer 0 for world-space, layer 1 for
// cockpit-space so the plane model draws on top of everything).
//
// Extracted from main.js. Exports `startAnimateLoop(ctx)` which kicks
// off the RAF chain; the function itself is self-recursive via
// `requestAnimationFrame(tick)`.
// ============================================================================

import * as Cesium from 'cesium';
import { getViewer } from '../world/cesiumWorld';
import { particles } from '../utils/particles';
import { update } from './simLoop';

export function startAnimateLoop(ctx) {
	let frameCount = 0;
	let lastFpsUpdate = 0;

	function tick() {
		requestAnimationFrame(tick);

		const clock = ctx.clock;
		const dt = clock ? clock.getDelta() : 0.016;
		const now = performance.now();

		frameCount++;
		if (now - lastFpsUpdate >= 1000) {
			const fps = (frameCount * 1000) / (now - lastFpsUpdate);
			frameCount = 0;
			lastFpsUpdate = now;
			ctx.hud.updateFPS(fps);

			const menuTimeElem = document.getElementById('menu-time');
			if (menuTimeElem) {
				menuTimeElem.textContent = new Date().toISOString().split('.')[0] + 'Z';
			}
		}

		const currentState = ctx.currentState;
		const { state } = ctx;

		if (currentState === 'FLYING' || currentState === 'PAUSED' ||
			currentState === 'TRANSITIONING' || currentState === 'CRASHED') {
			const viewer = getViewer();
			const renderer = ctx.renderer;
			const camera   = ctx.camera;
			const scene    = ctx.scene;

			renderer.autoClear = false;
			renderer.clear();

			if (viewer && viewer.camera && viewer.camera.frustum.fovy) {
				const targetFov = Cesium.Math.toDegrees(viewer.camera.frustum.fovy);
				camera.fov    = targetFov;
				camera.aspect = window.innerWidth / window.innerHeight;
				camera.updateProjectionMatrix();
			}

			camera.layers.set(0);

			// CRASHED keeps ticking so NPCs continue fighting and the
			// player can press M to watch from above. update() gates
			// player-specific work on isFlying internally.
			if (currentState === 'FLYING' || currentState === 'CRASHED') {
				update(dt, ctx);
			} else if (currentState === 'PAUSED') {
				ctx.hud.updatePauseMenu(state, ctx.getCurrentRegionName(),
					ctx.npcSystem ? ctx.npcSystem.npcs : []);
				// Keep the commander-view map interactive during
				// Space-pause (pan / zoom / tilt, marker positions,
				// tooltip content) even though the simulation is
				// frozen. Passing dt=0 freezes the trail-sampling
				// timer, contact ageing, etc. — the map's camera
				// controls still work because they're driven by
				// pointer events and _applyCamera() inside
				// commanderView.update().
				if (ctx.commanderView && ctx.commanderView.active) {
					const projectiles = ((ctx.weaponSystem && ctx.weaponSystem.projectiles) || [])
						.concat((ctx.npcSystem && ctx.npcSystem.projectiles) || []);
					ctx.commanderView.update(0, state,
						ctx.npcSystem ? ctx.npcSystem.npcs : [],
						projectiles);
				}
				// Same paused-update for the strike planner — its panel
				// + designation marker stay live while the sim is frozen.
				if (ctx.strikePlannerView && ctx.strikePlannerView.active) {
					const projectiles = ((ctx.weaponSystem && ctx.weaponSystem.projectiles) || [])
						.concat((ctx.npcSystem && ctx.npcSystem.projectiles) || []);
					ctx.strikePlannerView.update(0, state,
						ctx.npcSystem ? ctx.npcSystem.npcs : [],
						projectiles);
				}
			}

			if (ctx.mixer) ctx.mixer.update(dt);

			// Tick particles in CRASHED too. Each particle bakes
			// its render matrix as `viewMatrix * modelMatrix`, so
			// freezing the update() call leaves matrices locked in
			// the *previous* camera's space — when the player died
			// the wreckage cloud stopped re-baking and got drawn at
			// fixed camera-relative positions, appearing as a gray
			// sphere glued to the spectator chase-cam. Keeping the
			// tick alive keeps the explosion physically anchored to
			// the death site and lets it age out normally while the
			// player watches from spectator view.
			try {
				if (currentState === 'FLYING' || currentState === 'CRASHED') {
					particles.update(dt);
				}
			} catch (e) { }

			// World layer: route through the cloud layer if present so
			// takram's CloudsEffect composites volumetric clouds on
			// top of Cesium's rendered globe. Falls back to a direct
			// render if cloud-layer init failed (e.g. WebGL2 / shader
			// issue). Layer 1 (cockpit overlay) still goes through
			// the bare renderer — clouds don't belong on the HUD.
			if (ctx.cloudLayer) {
				ctx.cloudLayer.render(getViewer());
			} else {
				renderer.render(scene, camera);
			}

			renderer.clearDepth();

			camera.fov = 75;
			camera.updateProjectionMatrix();

			camera.layers.set(1);

			renderer.render(scene, camera);
		} else {
			document.getElementById('threeContainer').classList.add('hidden');
		}
	}

	tick();
}
