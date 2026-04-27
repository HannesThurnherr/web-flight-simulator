// ============================================================================
// NPC mesh-matrix bake + projectile spawn helpers.
//
// Two clusters pulled out of npcSystem.js to keep the main class file
// under its line budget:
//   1. applyNpcMeshMatrix / syncNpcMeshMatrices — turn world-frame
//      lon/lat/alt + HPR into the camera-space THREE matrix the
//      renderer consumes. syncNpcMeshMatrices re-runs the bake across
//      every live NPC + NPC-fired projectile after the camera moves
//      (called from main's sim loop so the mesh and globe stay in
//      lock-step — see the anti-shake commentary in simLoop.js).
//   2. spawnNpcBullet / spawnNpcMissile — create new projectiles and
//      push them into npcSys.projectiles. Factored out because the
//      static-SAM launcher needs slightly different launch geometry
//      than an air-launched fighter shot, and that if/else belongs
//      next to the projectile-spawn path, not in the main update loop.
//
// Every function takes the NPCSystem instance as its first arg, so
// the class-level shims in npcSystem.js stay one-liners and `this`
// context works through the extracted implementations.
// ============================================================================

import * as Cesium from 'cesium';
import { Bullet } from '../weapon/bullet.js';
import { createMunition, munitionIdForSimType } from '../weapon/munitionFactory.js';

// Bake a single NPC's world position + HPR into its THREE mesh matrix,
// expressed in the supplied Cesium viewMatrix (world → camera-space)
// frame. The THREE side of the renderer uses an identity camera at
// origin, so mesh.matrix IS the camera-space transform — which means
// the viewMatrix used here MUST match the one Cesium renders the
// earth with this frame, or the mesh and globe will drift apart
// visually (the shake symptom when following a moving unit).
// Hide NPC meshes beyond this distance from the camera. Trace-driven
// number: at 30 km a fighter sprite is ~1-2 px, so the visual cost of
// hiding it is near zero, but the GPU savings from skipping a 3-30 MB
// glTF's draw calls are large. Commander view + map markers are not
// affected — they live on Cesium entities, not Three.js meshes.
const DISTANCE_CULL_M = 30000;

export function applyNpcMeshMatrix(npcSys, npc, viewMatrix) {
	if (!npc || !npc.mesh) return;
	const pos = Cesium.Cartesian3.fromDegrees(
		npc.lon, npc.lat, npc.alt, undefined, npcSys._scratchCartesian,
	);

	// Distance cull. The camera world position is what matters for
	// rendering (works correctly in pilot, spectator, and commander
	// views). Setting `mesh.visible = false` on a Group propagates to
	// every descendant, so the renderer skips the entire NPC sub-tree
	// without us having to traverse it.
	const camPos = npcSys.viewer && npcSys.viewer.camera && npcSys.viewer.camera.positionWC;
	if (camPos) {
		const distSq = Cesium.Cartesian3.distanceSquared(pos, camPos);
		if (distSq > DISTANCE_CULL_M * DISTANCE_CULL_M) {
			npc.mesh.visible = false;
			return;
		}
		// Else fall through; mesh stays visible and we re-bake the
		// matrix below.
		if (!npc.mesh.visible) npc.mesh.visible = true;
	}

	npcSys._scratchHPR.heading = Cesium.Math.toRadians(npc.heading);
	npcSys._scratchHPR.pitch   = Cesium.Math.toRadians(npc.roll);
	npcSys._scratchHPR.roll    = Cesium.Math.toRadians(npc.pitch);

	const modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(
		pos, npcSys._scratchHPR, Cesium.Ellipsoid.WGS84,
		Cesium.Transforms.eastNorthUpToFixedFrame, npcSys._scratchMatrix,
	);

	const cameraSpaceMatrix = Cesium.Matrix4.multiply(
		viewMatrix, modelMatrix, npcSys._scratchCameraMatrix,
	);
	for (let i = 0; i < 16; i++) {
		npcSys._scratchThreeMatrix.elements[i] = cameraSpaceMatrix[i];
	}
	npc.mesh.matrix.copy(npcSys._scratchThreeMatrix);
	npc.mesh.updateMatrixWorld(true);
}

// Re-bake every live NPC's and NPC-fired projectile's mesh matrix
// against the CURRENT Cesium view matrix. Called by main.js right
// after a camera move (spectator / pilot / commander) so the meshes
// are in lock-step with whatever view Cesium will render with this
// frame. Without this, any camera motion that happens between
// `update()` (which does the first bake) and the render — e.g. the
// spectator camera latching on to a unit whose position was advanced
// a v·dt step AFTER its mesh was baked — produces the "direction-of-
// travel" shake because V and M are from different sub-frames.
export function syncNpcMeshMatrices(npcSys) {
	if (!npcSys.loaded || !npcSys.viewer) return;
	const viewMatrix = npcSys.viewer.camera.viewMatrix;
	for (const npc of npcSys.npcs) {
		if (!npc || npc.destroyed) continue;
		applyNpcMeshMatrix(npcSys, npc, viewMatrix);
	}
	for (const p of npcSys.projectiles) {
		if (!p || !p.active) continue;
		if (typeof p.updateThreeMatrix === 'function') p.updateThreeMatrix();
	}
}

// Fire one round from an NPC's gun. Reuses the player's Bullet class
// — same visual tracer, same terrain collision, same 20 m hit box.
// Team-aware hit check inside Bullet keeps wingmen from clipping each
// other. Pushed onto the shared `projectiles` pool so the sensor /
// HUD layers see NPC gun fire via the same channel as NPC missile
// fire.
// `aim` (optional) overrides the launch heading + pitch — for ground
// AAA platforms whose chassis stays put while the turret traverses to
// a lead solution. When omitted, the bullet exits along the unit's
// own heading/pitch (correct for fighters, where the nose IS the gun
// pointing direction).
export function spawnNpcBullet(npcSys, npc, aim = null) {
	const nosePos = { lon: npc.lon, lat: npc.lat, alt: npc.alt };
	const heading = (aim && typeof aim.heading === 'number') ? aim.heading : npc.heading;
	const pitch   = (aim && typeof aim.pitch   === 'number') ? aim.pitch   : npc.pitch;
	const bullet = new Bullet(
		npcSys.scene, npcSys.viewer, nosePos,
		heading, pitch, npc.speed,
		null, // onKill — NPC-on-NPC / NPC-on-player gun kills don't score
		npc,
	);
	npcSys.projectiles.push(bullet);
	return bullet;
}

// Spawn one NPC-launched missile. Factory-dispatches on simType so
// AIM-120 / AIM-9 / NASAMS-MSL each pick up the right seeker class
// and JSON parameters. The SAM launcher (npc.isStatic === true) gets
// special-case launch geometry: +3 m over the launcher, pointed at
// the target's bearing, pitched up 15° from the geometric line-of-
// sight so the missile arcs out of the canister instead of flying
// straight along LOS.
export function spawnNpcMissile(npcSys, npc, weaponType, target) {
	const isStatic = !!npc.isStatic;
	const downOffsetM = isStatic ? 3 : -3;
	const launch = {
		lon: npc.lon,
		lat: npc.lat,
		alt: npc.alt + downOffsetM,
	};

	// Initial attitude of the missile. For an air-launched shot, the
	// launcher's own heading + pitch is right — the missile is
	// momentarily going where the firing jet was going. For a SAM,
	// the launcher is static and its heading is 0; we point the
	// missile at the target's bearing and pitch it up ~15° above
	// the direct geometric elevation, roughly mimicking a canister
	// that elevates before firing. The missile's own PN guidance
	// takes over the moment it leaves the rail, so this is really
	// just a cosmetic / initial-condition choice.
	let launchHeading = npc.heading;
	let launchPitch   = npc.pitch;
	if (isStatic && target) {
		const plat = npc.lat * Math.PI / 180;
		const dE = (target.lon - npc.lon) * 111320 * Math.cos(plat);
		const dN = (target.lat - npc.lat) * 111320;
		const dU = (target.alt - npc.alt);
		launchHeading = (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360;
		const horiz = Math.hypot(dE, dN);
		const directElev = Math.atan2(dU, Math.max(1, horiz)) * 180 / Math.PI;
		// Lead the climb: real SAMs nose-over, they don't fly the
		// pure line-of-sight. +15° over direct-to-target, capped.
		launchPitch = Math.max(15, Math.min(80, directElev + 15));
	}

	const onKill = null; // NPC kills don't score for the player

	const munitionId = munitionIdForSimType(weaponType);
	const projectile = createMunition(
		munitionId,
		npcSys.scene, npcSys.viewer, launch,
		launchHeading, launchPitch, npc.speed || 0,
		target, onKill, npc,
	);
	if (!projectile) return null;
	npcSys.projectiles.push(projectile);
	return projectile;
}
