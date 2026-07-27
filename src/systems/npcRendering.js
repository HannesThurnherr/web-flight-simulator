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
import * as THREE from 'three';
import { Bullet } from '../weapon/bullet.js';
import { createMunition, munitionIdForSimType } from '../weapon/munitionFactory.js';
import { MUNITIONS } from '../weapon/munitions.js';
import { groundHeightAt, seaSurfaceHeightAt } from '../world/terrain.js';
import { navalLog } from './navalDebug.js';

// ---- Surface-ship waterline clipping ---------------------------------------
// Slices ship hulls at the sea surface so the Cesium ocean appears to swallow
// the submerged part (the Three layer draws OVER Cesium with no shared depth,
// so this is how below-water geometry gets hidden). Recomputed in camera-space
// each frame because the render world IS camera-space (identity THREE camera).
//
// ONE PLANE PER SHIP. This used to be a single shared plane keyed to whichever
// ship was baked last, on the assumption that ships in view sit on the same
// local sea surface. They don't: a plane is TANGENT to the ellipsoid at the
// ship it was keyed to, and the earth curves away from it as d²/2R, so a
// plane keyed to a consort 26 km up-threat sits 55 m above OUR waterline and
// eats everything below the masthead. That's the "only the antenna renders"
// bug, and it looked transient because it depended on bake order:
//
//   keyed ship 10 km away -> plane sits  7.8 m above this ship's waterline
//   keyed ship 20 km away -> plane sits 31.4 m  (flight deck gone)
//   keyed ship 30 km away -> plane sits 70.6 m  (whole carrier gone)
//
// Each ship now owns a plane tangent at its OWN position, so the error is
// zero by construction regardless of how far apart the task force spreads.
const _clipSeaPos = new Cesium.Cartesian3();
const _clipUp     = new Cesium.Cartesian3();
const _clipCamPos = new Cesium.Cartesian3();
const _clipCamUp  = new Cesium.Cartesian3();
const _clipN = new THREE.Vector3();
const _clipP = new THREE.Vector3();

// Point THIS ship's clip plane at THIS ship's sea surface, in camera-space.
function _updateWaterClip(npc, viewMatrix) {
	const seaH = npc._seaRefH;
	if (seaH == null || !npc._clipPlane) return;
	Cesium.Cartesian3.fromDegrees(npc.lon, npc.lat, seaH, undefined, _clipSeaPos);
	Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(_clipSeaPos, _clipUp);
	Cesium.Matrix4.multiplyByPoint(viewMatrix, _clipSeaPos, _clipCamPos);
	Cesium.Matrix4.multiplyByPointAsVector(viewMatrix, _clipUp, _clipCamUp);
	Cesium.Cartesian3.normalize(_clipCamUp, _clipCamUp);
	_clipN.set(_clipCamUp.x, _clipCamUp.y, _clipCamUp.z);
	_clipP.set(_clipCamPos.x, _clipCamPos.y, _clipCamPos.z);
	// Normal points "up" out of the water → fragments below the surface
	// (negative side) are clipped, leaving the Cesium ocean visible there.
	npc._clipPlane.setFromNormalAndCoplanarPoint(_clipN, _clipP);
}

// Give a ship its own clip plane and its own materials (idempotent).
//
// The materials have to be cloned: ship models come from `template.clone()`,
// which SHARES material instances across every hull built from the same GLB,
// so a per-ship plane written onto a shared material would immediately be
// overwritten by her sisters. Cloning is per-ship but keeps intra-ship
// sharing via `seen`, so a 30-mesh hull still ends up with its handful of
// distinct materials, not 30 copies. Textures are shared by reference.
//
// The plane starts at constant 1e6 — distance = n·p + 1e6 is positive for
// anything on screen — so a ship whose sea reference hasn't resolved yet
// renders whole rather than being clipped away by a garbage plane.
function _ensureShipClip(npc) {
	if (npc._clipApplied || !npc.mesh) return;
	npc._clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e6);
	const seen = new Map();
	const own = (m) => {
		let c = seen.get(m);
		if (!c) {
			c = m.clone();
			c.clippingPlanes = [npc._clipPlane];
			c.needsUpdate = true;
			seen.set(m, c);
		}
		return c;
	};
	npc.mesh.traverse((o) => {
		if (!o.isMesh || !o.material) return;
		o.material = Array.isArray(o.material) ? o.material.map(own) : own(o.material);
	});
	npc._clipApplied = true;
}

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

	// Surface ships: keep the shared waterline clip plane aimed at this ship's
	// sea surface (camera-space) and ensure its materials honour it, so the
	// hull below the waterline is sliced away and the ocean reads through.
	if (npc.kind === 'surface') {
		_ensureShipClip(npc);           // must come first — it creates the plane
		_updateWaterClip(npc, viewMatrix);
	}
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
export function spawnNpcMissile(npcSys, npc, weaponType, target, aim = null) {
	const isStatic  = !!npc.isStatic;
	const isSurface = npc.kind === 'surface';
	// Ships and ground launchers fire UP off the deck/rail (+3); aircraft
	// drop the store off the belly (-3).
	const downOffsetM = (isStatic || isSurface) ? 3 : -3;
	let launchAlt = npc.alt + downOffsetM;
	// Ground AND ship launchers: make sure the round is born ABOVE the surface
	// the missile collision check reads. Ships float ~8 m BELOW the rendered
	// (geoid) sea surface (their negative groundOffsetM), so without this a
	// sea-skimmer (harpoon) spawns UNDERWATER and — climbing out slowly at the
	// ship's crawl-speed launch — augers straight back into the sea before its
	// 0.7 s launch grace ends, dumping the whole salvo into the water. Born at
	// surface + 5 m it gets cleanly onto its sea-skim. (The launch grace is the
	// backstop; this keeps the very first frame clean too.)
	if (isStatic || isSurface) {
		// Ships read THE sea reference (terrain.js seaSurfaceHeightAt) — the
		// same one the hull floats on and the sea-skimmer's seeker skims
		// against — so a round can never be born below the water its launcher
		// is sitting on. Ground launchers keep the exact terrain lookup, since
		// land height is local and must not be smoothed across neighbours.
		const surfaceH = isSurface
			? seaSurfaceHeightAt(npcSys.viewer, npc.lon, npc.lat)
			: groundHeightAt(npcSys.viewer, npc.lon, npc.lat, npc._cachedTerrainH ?? null);
		if (surfaceH != null) launchAlt = Math.max(launchAlt, surfaceH + 5);
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

	// Geometric firing solution to the target (shared by the static, surface
	// and air rail-aim paths below).
	let bearingToTgt = npc.heading;
	let directElev = 0;
	let haveSolution = false;
	if (target && typeof target.lon === 'number' && typeof target.lat === 'number') {
		const plat = npc.lat * Math.PI / 180;
		const dE = (target.lon - npc.lon) * 111320 * Math.cos(plat);
		const dN = (target.lat - npc.lat) * 111320;
		const dU = ((target.alt || 0) - npc.alt);
		bearingToTgt = (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360;
		const horiz = Math.hypot(dE, dN);
		directElev = Math.atan2(dU, Math.max(1, horiz)) * 180 / Math.PI;
		haveSolution = true;
	}

	if (aim && (typeof aim.heading === 'number' || typeof aim.pitch === 'number')) {
		// Explicit pre-computed launch attitude — naval gun shell / ballistic
		// round. The pilot solved the lead + loft offline (no terminal seeker)
		// and hands it in; gravity does the rest. Wins over every default.
		if (typeof aim.heading === 'number') launchHeading = aim.heading;
		if (typeof aim.pitch   === 'number') launchPitch   = aim.pitch;
	} else if (isSurface) {
		// Ship launchers are trainable/canister-angled, so — unlike an aircraft
		// — pointing AT the threat bearing is correct, not a "broadside". Per-
		// seeker launch pitch sets the profile; the seeker flies it from there.
		if (haveSolution) launchHeading = bearingToTgt;
		if (seeker === 'active_radar') {
			// SM-6/SM-2: true vertical VLS launch. The heading is already set to
			// the target bearing above, so the round climbs straight up aligned
			// in azimuth, then the AIM120's VLS-turnover phase pitches it over
			// toward the target once it clears ~70 m (see aim120.js). Guidance
			// is suppressed during the climb so it doesn't try (and fail) to
			// tip over at zero airspeed off the deck.
			launchPitch = 90;
		} else if (seeker === 'ir') {
			launchPitch = Math.max(20, Math.min(70, directElev + 22)); // RAM — steep angled rail
		} else if (seeker === 'anti_ship') {
			launchPitch = 2;                                    // Harpoon/NSM — sea-skim out
		} else if (seeker === 'cruise') {
			launchPitch = 8;                                    // Tomahawk — low climb to course
		} else {
			launchPitch = Math.max(5, Math.min(45, directElev + 10)); // dumb store fallback
		}
	} else if (isRailMissile && haveSolution) {
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

	// Launch speed. Normally just the platform's own speed — the Missile ctor
	// adds the munition's launchSpeedOffset on top.
	//
	// A GUN is different: the barrel, not the shell, sets the muzzle velocity,
	// and the mount's configured muzzleVelMps is what fire control solved the
	// arc with. Pre-compensate the offset so the round actually leaves at that
	// speed. Without this the two silently disagreed whenever a platform's gun
	// differed from the munition's nominal figure — the Zumwalt's 155 mm AGS is
	// 900 m/s against the mk45-shell's 800, so it aimed for a 910 m/s round,
	// fired an 810 m/s one, and landed 19% short at every range.
	// (launchSpeedMps already includes the firing ship's own speed — it's the
	// v0 the arc was solved with — so it REPLACES the platform speed here
	// rather than adding to it.)
	let launchSpeed = npc.speed || 0;
	if (aim && typeof aim.launchSpeedMps === 'number' && munData &&
		munData.flight && munData.flight.muzzleLaunch) {
		launchSpeed = aim.launchSpeedMps - (munData.flight.launchSpeedOffset || 0);
	}

	const projectile = createMunition(
		munitionId,
		npcSys.scene, npcSys.viewer, launch,
		launchHeading, launchPitch, launchSpeed,
		target, onKill, npc,
	);
	if (!projectile) return null;
	if (seeker === 'anti_ship') {
		const seaNow = seaSurfaceHeightAt(npcSys.viewer, npc.lon, npc.lat);
		navalLog('LAUNCH', {
			type: weaponType,
			from: npc.name || '?',
			tgt: (target && target.name) || (target ? 'unnamed' : 'NO TARGET'),
			shipAlt: npc.alt,
			shipOffset: npc._groundOffsetM || 0,
			shipSeaRef: npc._seaRefH == null ? 'null' : npc._seaRefH,
			seaNow: seaNow == null ? 'null' : seaNow,
			launchAlt,
			aboveSea: seaNow == null ? '?' : (launchAlt - seaNow),
			pitch: launchPitch,
			hdg: launchHeading,
			lostLock: !!projectile.lostLock,
		});
	}
	// Eject the store off the rack along the firing NPC's belly-down axis.
	if (typeof projectile.applyLaunchEjection === 'function') {
		projectile.applyLaunchEjection(npc.roll || 0);
	}
	npcSys.projectiles.push(projectile);
	return projectile;
}
