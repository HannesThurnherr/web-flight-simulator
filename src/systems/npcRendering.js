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
import { MUNITIONS } from '../weapon/munitions.js';
import { groundHeightAt } from '../world/terrain.js';

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

	// NOTE: pitch and roll are deliberately swapped here to match the
	// model's local-axis convention after the +X-then-+Y rotation in
	// npcSystem (the GLB is authored with +Y=up and we pre-rotate so
	// the body axes match Cesium's ENU+HPR expectations). The roll
	// sign is negated because, after the swap, positive npc.roll
	// (right wing down per physics) was producing left-wing-down
	// visually — the bogeys orbiting the jamming-test scenario were
	// banked outward (head pointing AWAY from the orbit center)
	// instead of inward, the opposite of a real coordinated turn.
	npcSys._scratchHPR.heading = Cesium.Math.toRadians(npc.heading);
	npcSys._scratchHPR.pitch   = Cesium.Math.toRadians(-npc.roll);
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
	let launchAlt = npc.alt + downOffsetM;
	// Ground launchers: make sure the round is born ABOVE the terrain the
	// missile collision check reads, so it doesn't self-detonate on the rail
	// if the battery is clamped a hair underground. (The missile's own launch
	// grace is the backstop; this keeps the very first frame clean too.)
	if (isStatic) {
		const gh = groundHeightAt(npcSys.viewer, npc.lon, npc.lat, npc._cachedTerrainH ?? null);
		if (gh != null) launchAlt = Math.max(launchAlt, gh + 5);
	}
	const launch = {
		lon: npc.lon,
		lat: npc.lat,
		alt: launchAlt,
	};

	// Resolve the munition up front so we know whether it's a rail-launched
	// missile or a released store — they leave the aircraft very differently.
	const munitionId = munitionIdForSimType(weaponType);
	const munData = munitionId ? MUNITIONS[munitionId] : null;
	const seeker = munData && munData.seekerType;
	// Rail-launched powered missiles: AAMs, HARM, surface SAMs. These get the
	// off-boresight azimuth aim below. Released / programmed stores — glide
	// bombs (gps/laser), cruise missiles (cruise), decoys (MALD) — leave the
	// rack along the aircraft's flight path and let their own guidance fly
	// them onto the target, exactly like the player's release.
	const isRailMissile =
		seeker === 'active_radar' || seeker === 'ir' ||
		seeker === 'iir' || seeker === 'anti_radiation';

	// Initial attitude. The default is the launcher's own heading + pitch (the
	// store leaves going where the jet was pointed). For a rail missile whose
	// jet nose is OFF the target — most notably a defending fighter cranked
	// ~60° away while shooting back — launching along the nose sends the
	// missile wide and makes it claw back onto the target (the "missiles
	// don't track who they were meant for" artefact). So for rail missiles we
	// aim the launch AZIMUTH at the target, clamped to ±90° off the nose (you
	// can't rail-launch sideways/backward), keeping the launcher's PITCH so a
	// BVR loft is preserved. A released bomb / cruise missile is NOT aimed
	// this way — pointing an SDB or Storm Shadow 90° off the jet's flight
	// path is exactly the "munition launches perpendicular to flight" bug;
	// they ride the flight path out and steer in afterward.
	let launchHeading = npc.heading;
	let launchPitch   = npc.pitch;
	if (isRailMissile && target && typeof target.lon === 'number' && typeof target.lat === 'number') {
		const plat = npc.lat * Math.PI / 180;
		const dE = (target.lon - npc.lon) * 111320 * Math.cos(plat);
		const dN = (target.lat - npc.lat) * 111320;
		const dU = ((target.alt || 0) - npc.alt);
		const bearingToTgt = (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360;
		const horiz = Math.hypot(dE, dN);
		const directElev = Math.atan2(dU, Math.max(1, horiz)) * 180 / Math.PI;
		if (isStatic) {
			// SAM: free to point straight at the bearing and nose-over ~15°.
			launchHeading = bearingToTgt;
			launchPitch = Math.max(15, Math.min(80, directElev + 15));
		} else {
			// Air-launched: aim azimuth at the target, but never more than
			// 90° off the jet's nose (beyond that it's not a real rail shot;
			// the fire gates already keep this ≤60°). Pitch stays = jet pitch.
			let off = bearingToTgt - npc.heading;
			while (off < -180) off += 360;
			while (off >  180) off -= 360;
			off = Math.max(-90, Math.min(90, off));
			launchHeading = (npc.heading + off + 360) % 360;
		}
	}

	const onKill = null; // NPC kills don't score for the player

	const projectile = createMunition(
		munitionId,
		npcSys.scene, npcSys.viewer, launch,
		launchHeading, launchPitch, npc.speed || 0,
		target, onKill, npc,
	);
	if (!projectile) return null;
	// Eject the store off the rack along the firing NPC's belly-down axis.
	if (typeof projectile.applyLaunchEjection === 'function') {
		projectile.applyLaunchEjection(npc.roll || 0);
	}
	npcSys.projectiles.push(projectile);
	return projectile;
}
