import * as THREE from 'three';
import * as Cesium from 'cesium';
import { PlanePhysics } from '../plane/planePhysics.js';
import { SIGNATURES } from './signatures.js';
import {
	FIGHTER_RADAR_DEFAULT,
	FIGHTER_IRST_DEFAULT,
	FIGHTER_EYEBALL_DEFAULT,
} from './sensorSystem.js';
import { createFighterPilot } from './ai/index.js';
// Flare / particles / soundManager / advanceLonLatAlt / Bullet /
// createMunition / getTeamDatalink / tickAllDatalinks moved with the
// update-loop + spawn-helpers to the sibling modules listed below.
import { resetAllDatalinks as _resetAllDatalinks } from './teamDatalink.js';
import { getPlatform } from './platforms.js';
import { makePilot } from './npcPilots.js';
import { applyNpcMeshMatrix, syncNpcMeshMatrices, spawnNpcBullet, spawnNpcMissile } from './npcRendering.js';
import { npcSystemUpdate } from './npcUpdate.js';

// NPC factions + spawn geometry. Player is always 'friendly'; the two
// hostile factions below fight each other AND the player. Each faction
// spawns at a vertex of an equilateral triangle centered on the player,
// so the three parties are evenly spaced and no one is spawned directly in
// front of anyone else's guns — avoids the "immediate slaughter" we had
// with co-located spawns.
const NPC_TEAMS = ['hostile-red', 'hostile-blue'];
// Equilateral triangle: side = 70 km, player at south vertex, hostile
// factions at the two northern vertices (bearings ±30° from player).
// Default triangle side. Individual scenarios can override by setting
// npcSystem.triangleSide in their onStart (see awacsBvr which uses
// 180 km for the full long-range BVR sequence). The default 70 km is
// fast to test — engagements open immediately instead of requiring a
// multi-minute closure phase.
const TRIANGLE_SIDE_DEFAULT = 70000;
const TRIANGLE_BEARINGS = {
	'hostile-red':  30,  // NNE
	'hostile-blue': -30, // NNW
};
const GROUP_JITTER_M = 2500; // flight formation spread inside a vertex cluster


export class NPCSystem {
	constructor(viewer, scene, loader) {
		this.viewer = viewer;
		this.scene = scene;
		this.loader = loader;
		this.npcs = [];
		// Scenarios flip this off to take over spawning themselves (e.g. the
		// notching test spawns exactly one bogey and no reinforcements).
		// Defaults on, so the original 3-way free-for-all keeps working
		// without any scenario plumbing.
		this.autoSpawn = true;
		// Per-run knob for the triangle spawn geometry. Scenarios override
		// to extend (AWACS BVR = 180 km) or shrink it. Kept mutable so a
		// running scenario can tune without needing a rebuild.
		this.triangleSide = TRIANGLE_SIDE_DEFAULT;
		// Missiles fired by NPCs. Updated in npcSystem.update() the same way
		// weaponSystem manages the player's outgoing projectiles. Exposed so
		// the sensor system and HUD layers can enumerate every live
		// projectile in the world regardless of launcher.
		this.projectiles = [];
		this.npcNames = ['PHOENIX', 'MARVEL', 'VIPER', 'GHOST', 'RAVEN', 'EAGLE', 'FALCON', 'BLADE', 'STRIKER', 'STORM', 'KNIGHT', 'TITAN'];
		this.lastSpawnTime = 0;
		this.modelTemplate = null;
		this.animations = [];
		this.loaded = false;
		// Generic platform-model cache: any GLB path → { template,
		// animations, loaded, failed }. Populated lazily by spawnPlatform
		// the first time it sees a new path. Replaces the old hardcoded
		// E-767 / Patriot keyword lookup, which silently fell back to
		// the F-15 template for any unknown path — that's the bug
		// where every ground unit spawned looked like a SAM-shaped
		// F-15 in spectator view.
		this._platformTemplates = new Map();

		this._scratchMatrix = new Cesium.Matrix4();
		this._scratchHPR = new Cesium.HeadingPitchRoll();
		this._scratchCartesian = new Cesium.Cartesian3();
		this._scratchThreeMatrix = new THREE.Matrix4();
		this._scratchCameraMatrix = new Cesium.Matrix4();

		this.loadModel();
	}

	loadModel() {
		// Player-fighter template — used by createNPCMesh (air-to-air
		// fighter spawns, no per-spawn model path). Kept as its own slot
		// because `loaded` gates the whole NPCSystem.
		this.loader.load('/assets/models/f-15-strike-eagle.glb', (gltf) => {
			this.modelTemplate = gltf.scene;
			this.animations = gltf.animations;
			this.modelTemplate.traverse((child) => {
				if (child.isMesh) {
					child.castShadow = true;
					child.receiveShadow = true;
				}
			});
			this.loaded = true;
		});
		// Warm-preload the AWACS so a scenario starting with awacs-bvr
		// doesn't have a one-frame queue-and-retry on the very first
		// spawnPlatform call. Every other platform GLB loads lazily on
		// its first spawn — see _preloadPlatformModel + spawnPlatform.
		this._preloadPlatformModel('/assets/models/e-767-awacs.glb');
	}

	// Lazy GLB loader for any platform's model. Called by spawnPlatform
	// the first time it encounters a new path. Subsequent spawns of
	// the same platform reuse the cached `template`, so 5× SA-15 in a
	// scenario costs one HTTP fetch.
	_preloadPlatformModel(path) {
		if (!path) return;
		if (this._platformTemplates.has(path)) return;
		const slot = { template: null, animations: null, loaded: false, failed: false };
		this._platformTemplates.set(path, slot);
		this.loader.load(path, (gltf) => {
			slot.template   = gltf.scene;
			slot.animations = gltf.animations;
			slot.template.traverse((child) => {
				if (child.isMesh) {
					child.castShadow = true;
					child.receiveShadow = true;
				}
			});
			slot.loaded = true;
			try {
				const box  = new THREE.Box3().setFromObject(slot.template);
				const size = new THREE.Vector3();
				box.getSize(size);
				console.log('[NPCSystem] platform model loaded:', path,
					'size(m):', size.x.toFixed(1), size.y.toFixed(1), size.z.toFixed(1));
			} catch (e) { /* size query is best-effort */ }
		}, undefined, (err) => {
			console.warn('[NPCSystem] platform model failed to load:', path, err);
			slot.failed = true;
		});
	}

	spawnNPC(playerLon, playerLat, playerAlt) {
		if (!this.loaded) return null;

		// Balance team sizes so the three-way dynamic stays interesting.
		const redCount  = this.npcs.filter(n => n.team === 'hostile-red').length;
		const blueCount = this.npcs.filter(n => n.team === 'hostile-blue').length;
		const team = redCount <= blueCount ? 'hostile-red' : 'hostile-blue';

		// Spawn center: if this team already has living NPCs, reinforce at
		// their group centroid (keeps the faction together). Otherwise,
		// first spawn of the team goes to that team's triangle vertex.
		const alive = this.npcs.filter(n => n.team === team);
		let centerLon, centerLat;
		if (alive.length > 0) {
			centerLon = alive.reduce((s, n) => s + n.lon, 0) / alive.length;
			centerLat = alive.reduce((s, n) => s + n.lat, 0) / alive.length;
		} else {
			const bearingDeg = TRIANGLE_BEARINGS[team];
			const bearingRad = bearingDeg * Math.PI / 180;
			const plat = playerLat * Math.PI / 180;
			const dE = this.triangleSide * Math.sin(bearingRad);
			const dN = this.triangleSide * Math.cos(bearingRad);
			centerLon = playerLon + dE / (111320 * Math.cos(plat));
			centerLat = playerLat + dN / 111320;
		}

		// Jitter inside the group so NPCs don't stack on top of each other.
		const jAng  = Math.random() * Math.PI * 2;
		const jDist = Math.random() * GROUP_JITTER_M;
		const jlat = centerLat * Math.PI / 180;
		const lon = centerLon + (jDist * Math.sin(jAng)) / (111320 * Math.cos(jlat));
		const lat = centerLat + (jDist * Math.cos(jAng)) / 111320;
		const alt = Math.max(playerAlt + (Math.random() - 0.5) * 1500, 3000);

		const name = this.npcNames[Math.floor(Math.random() * this.npcNames.length)] + ' ' + (100 + Math.floor(Math.random() * 900));
		// Face roughly toward the centroid of other parties — the centroid
		// of the triangle minus this team's vertex is approximately the
		// direction of the remaining two vertices.
		const heading = this._initialHeadingFor(team, playerLon, playerLat, centerLon, centerLat);

		return this.createNPCMesh(name, lon, lat, alt, heading, 250 + Math.random() * 80, team);
	}

	_initialHeadingFor(team, playerLon, playerLat, spawnLon, spawnLat) {
		// Aim heading at the mean position of the other two parties
		// (the other hostile faction's vertex + the player). Puts the NPC
		// initially flying "toward the action" so engagements start
		// developing without extra wander time.
		const otherTeam = team === 'hostile-red' ? 'hostile-blue' : 'hostile-red';
		const otherBearingRad = TRIANGLE_BEARINGS[otherTeam] * Math.PI / 180;
		const plat = playerLat * Math.PI / 180;
		const otherE = this.triangleSide * Math.sin(otherBearingRad);
		const otherN = this.triangleSide * Math.cos(otherBearingRad);
		const otherLon = playerLon + otherE / (111320 * Math.cos(plat));
		const otherLat = playerLat + otherN / 111320;

		const tgtLon = (otherLon + playerLon) * 0.5;
		const tgtLat = (otherLat + playerLat) * 0.5;
		const dE = (tgtLon - spawnLon) * 111320 * Math.cos(plat);
		const dN = (tgtLat - spawnLat) * 111320;
		return (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360;
	}

	createNPCMesh(name, lon, lat, alt, heading, speed, team) {
		if (!this.modelTemplate) return null;

		const group = new THREE.Group();
		const model = this.modelTemplate.clone();

		// Model-space → body-frame orientation. The Strike Eagle GLB
		// exports with +X forward and +Z up, so we yaw 90° (rotation.y)
		// after the pitch-up (rotation.x) to put the nose along the
		// body-frame forward axis.
		model.rotation.x = Math.PI / 2;
		model.rotation.y = Math.PI / 2;
		// Real-world scale: Strike Eagle GLB is 14.6 units long on its
		// longest axis; real F-15 is 19.43 m. Scale factor ≈ 1.33 puts
		// the in-world NPCs at true size so missile engagement
		// envelopes, proximity fuze radii, and visual acquisition
		// distances all read correctly against the airframe. Old model
		// was 25.6 units at scale 1.0 (i.e. an oversized 25 m F-15),
		// which was mildly wrong — now corrected.
		const SCALE = 19.43 / 14.6;
		model.scale.set(SCALE, SCALE, SCALE);

		group.add(model);
		group.matrixAutoUpdate = false;
		this.scene.add(group);

		const mixer = new THREE.AnimationMixer(model);
		const clip = THREE.AnimationClip.findByName(this.animations, 'flight_mode');
		if (clip) {
			const action = mixer.clipAction(clip);
			action.setLoop(THREE.LoopOnce);
			action.clampWhenFinished = true;
			action.play();
		}

		const npc = {
			id: name + '_' + Math.random().toString(36).substr(2, 9),
			mesh: group,
			mixer: mixer,
			name: name,
			lon: lon, lat: lat, alt: alt,
			heading: heading,
			pitch: 0, roll: 0,
			speed: speed,
			throttle: 0.7,
			isBoosting: false,
			targetHeading: heading,
			targetPitch: 0,
			// Full 6DOF aero physics — same model the player flies. NPCs
			// used to run on a rate-limited kinematic model with their
			// own fantasy turn/pitch rates, which let them out-maneuver
			// missiles and the player both. The AI still outputs
			// "desired heading / pitch" from its behaviors; the
			// autopilot in update() turns those into stick inputs, and
			// PlanePhysics enforces the same aero limits (stall,
			// G-limiter, q̄-scaled control authority, throttle response,
			// drag penalty for hard turns) that the player's aircraft
			// obeys.
			physics: (() => {
				const p = new PlanePhysics();
				p.reset(lon, lat, alt, heading, 0, 0);
				return p;
			})(),
			behaviorTimer: 5 + Math.random() * 10,
			terrainCheckTimer: Math.random() * 2,
			time: Math.random() * 100,
			// Combat metadata. Team is assigned by spawnNPC so the
			// three-way engagement has balanced faction sizes and each
			// faction starts at a triangle vertex. TargetManager treats
			// any team mismatch as hostile, so NPCs engage each other as
			// well as the player.
			team: team || NPC_TEAMS[Math.floor(Math.random() * NPC_TEAMS.length)],
			signature: { ...SIGNATURES.fighter },
			sensors: {
				radar:   { ...FIGHTER_RADAR_DEFAULT },
				ir:      { ...FIGHTER_IRST_DEFAULT },
				eyeball: { ...FIGHTER_EYEBALL_DEFAULT },
			},
			contacts: new Map(),
			rwr: new Map(),
		};

		// AI pilot: reads npc.contacts/rwr, writes npc.targetHeading/
		// targetPitch/throttle and fire* commands. See src/systems/ai/.
		npc.pilot = createFighterPilot(npc);

		this.npcs.push(npc);
		return npc;
	}

	// Spawn an AWACS-class aircraft. Orbits at high altitude, carries a
	// huge radar (500 km nominal, wide scan), no weapons. Its sole job
	// is to populate the team datalink with contacts that its radar
	// paints — teammates then see bogeys well beyond their own radar
	// horizon, and the AIM-120 midcourse datalink has a much more
	// reliable track source than a lone fighter's radar.
	// Data-driven platform spawn. Reads the platform's JSON (src/data/
	// platforms/*.json) for model, signature, sensor config, pilot
	// strategy, and physics overrides. Caller supplies position / team
	// / any pilot parameter overrides. Used by scenarios for AWACS,
	// tankers, future ground SAMs, etc.
	spawnPlatform(platformId, lon, lat, alt, team = 'friendly', pilotOverrides = {}) {
		if (!this.loaded) return null;
		const platform = getPlatform(platformId);
		if (!platform) {
			console.warn('[spawnPlatform] unknown platform id:', platformId);
			return null;
		}

		// Resolve the mesh template via the generic per-path cache.
		// First time we see a platform's GLB path, kick off the load
		// and queue the spawn for retry once the GLB lands. Cached
		// hits return instantly. No more keyword sniffing — drop a
		// new GLB into public/assets/models/, point a platform JSON
		// at it, and the platform renders correctly without any code
		// change. (The previous "fall back to F-15" behaviour was the
		// reason every ground unit looked like a sideways F-15 in
		// spectator view.)
		const path = platform.model;
		if (!path) {
			console.warn('[spawnPlatform] platform has no model path:', platformId);
			return null;
		}
		let slot = this._platformTemplates.get(path);
		if (!slot) {
			this._preloadPlatformModel(path);
			slot = this._platformTemplates.get(path);
		}
		if (slot.failed) {
			console.warn('[spawnPlatform] model failed to load, skipping spawn:',
				platformId, path);
			return null;
		}
		if (!slot.loaded) {
			console.warn('[spawnPlatform] model not loaded yet; queuing:',
				platformId, path);
			if (!this._pendingPlatformSpawns) this._pendingPlatformSpawns = [];
			this._pendingPlatformSpawns.push({ platformId, lon, lat, alt, team, pilotOverrides });
			return null;
		}
		const template   = slot.template;
		const animations = slot.animations;

		const namePrefix = platform.kind === 'airborne' ? 'SENTRY' : platformId.toUpperCase();
		const name = `${namePrefix} ${100 + Math.floor(Math.random() * 900)}`;

		const group = new THREE.Group();
		const model = template.clone();
		// NPC system convention: model.rotation.x = π/2 bridges GLB
		// Y-up model space into the Cesium HPR body frame (Z-up). Both
		// airborne fighters and ground platforms need this to stand
		// upright. The platform's own modelRotation (loaded in radians
		// from JSON) stacks on top — use it to tweak specific GLBs
		// whose authored orientation doesn't match the assumed
		// +X-forward / +Y-up convention.
		model.rotation.x = Math.PI / 2 + (platform.modelRotation?.x || 0);
		model.rotation.y = (platform.modelRotation?.y || 0);
		model.rotation.z = (platform.modelRotation?.z || 0);
		const s = platform.modelScale ?? 1.0;
		model.scale.set(s, s, s);
		group.add(model);

		// Ground anchor. Two related problems to solve:
		//
		//   1. THREE.js scales models around their local origin, which
		//      the artist may have placed at the model's centre, top,
		//      or anywhere but its base. Without correction the model
		//      hovers (or sinks) by some authored offset × the scale
		//      factor.
		//
		//   2. `npc.alt` is the single point everything game-state
		//      reads as "where is this unit": targeting reticles,
		//      missile fuze proximity, commander markers. If we anchor
		//      the visible model at its base AND set npc.alt to terrain
		//      altitude, every probe returns the wheels — the body
		//      above the ground is invisible to the hit detection.
		//
		// Universal fix: anchor the model at its CENTRE in group-local
		// coords, and lift the spawn altitude by half the model height
		// so the body's centre ends up at terrain + halfHeight. Visual
		// base touches terrain, npc.alt sits at the body's centre of
		// mass — both correct.
		//
		// Only applied to ground platforms — airborne fighters use a
		// physics-driven altitude and don't terrain-clamp at all.
		let centerAltOffsetM = 0;
		if (platform.kind === 'ground') {
			model.updateMatrixWorld(true);
			const bbox = new THREE.Box3().setFromObject(model);
			if (isFinite(bbox.min.z)) {
				// Translate so model's z-centre lies at the group origin.
				model.position.z -= (bbox.min.z + bbox.max.z) * 0.5;
				centerAltOffsetM = (bbox.max.z - bbox.min.z) * 0.5;
			}
		}

		// (Removed: 300 m red debug beacon that used to be added to
		// every ground platform during the placeholder-model era.
		// With proper GLBs rendering, the beacons were just a fill-
		// rate sink — additive-blended transparent cylinders smear
		// across the screen at oblique angles. Now that the actual
		// units are visible the beacons aren't needed.)
		group.matrixAutoUpdate = false;
		this.scene.add(group);

		const mixer = new THREE.AnimationMixer(model);
		if (animations && animations.length > 0) {
			const action = mixer.clipAction(animations[0]);
			action.setLoop(THREE.LoopRepeat);
			action.play();
		}

		// Sensors — start with defaults only for the channels the platform
		// JSON actually declares. A building (`sensors: {}` / empty) ends
		// up with NO radar, NO IR, NO eyeball — which is correct, because
		// nothing about a barracks scans the sky. Previously this merged
		// FIGHTER_RADAR_DEFAULT into every ground unit unconditionally,
		// so the command post wound up with a 150 km-range fighter radar
		// happily painting bandits and showing up as a north-facing
		// debug emitter on the commander-view overlay.
		const sensors = {};
		if (platform.sensors?.radar) {
			sensors.radar = { ...FIGHTER_RADAR_DEFAULT, ...platform.sensors.radar };
		}
		if (platform.sensors?.ir) {
			sensors.ir = { ...FIGHTER_IRST_DEFAULT, ...platform.sensors.ir };
		}
		if (platform.sensors?.eyeball) {
			sensors.eyeball = { ...FIGHTER_EYEBALL_DEFAULT, ...platform.sensors.eyeball };
		}
		const sigKey = platform.signature || 'fighter';
		const signature = { ...(SIGNATURES[sigKey] || SIGNATURES.fighter) };

		const physics = new PlanePhysics();
		physics.reset(lon, lat, alt, 0, 0, 0);
		if (platform.physicsOverrides && typeof physics.applyOverrides === 'function') {
			physics.applyOverrides(platform.physicsOverrides);
		}

		// Ground platforms don't fly — flag `isStatic` so the main update
		// loop skips physics integration and terrain-collision for them.
		// Sensors, pilot ticks, and mesh transform updates still run, so
		// the unit still detects targets, decides whether to fire, and
		// appears in the world; it just stays put.
		const isStatic = (platform.kind === 'ground');

		// Fire an async authoritative terrain sample for ground platforms.
		// globe.getHeight() only returns a value for already-loaded tiles,
		// so a SAM spawned 30 km from the player's current camera target
		// would never clamp (tile never loaded) and would stay at the
		// scenario-provided altM, potentially buried under a plateau.
		// sampleTerrainMostDetailed loads the tile on demand and resolves
		// with the true surface height; we stash it on the NPC so the
		// update loop picks it up the first tick after the promise
		// resolves.
		if (isStatic && Cesium.sampleTerrainMostDetailed && this.viewer.terrainProvider) {
			const carto = Cesium.Cartographic.fromDegrees(lon, lat);
			Cesium.sampleTerrainMostDetailed(this.viewer.terrainProvider, [carto])
				.then(([p]) => {
					const h = (p && typeof p.height === 'number') ? p.height : null;
					if (h != null && this._pendingGroundHeight) {
						this._pendingGroundHeight.set(name, h);
					}
				})
				.catch(() => {});
			if (!this._pendingGroundHeight) this._pendingGroundHeight = new Map();
		}
		const npc = {
			id: name + '_' + Math.random().toString(36).substr(2, 9),
			mesh: group, mixer, name,
			lon, lat, alt,
			heading: 0, pitch: 0, roll: 0,
			speed: isStatic ? 0 : 180,
			throttle: isStatic ? 0 : 0.6,
			isBoosting: false,
			targetHeading: 0, targetPitch: 0,
			physics,
			behaviorTimer: 0, terrainCheckTimer: 0, time: 0,
			team,
			platformId,
			kind: platform.kind || 'airborne',
			isStatic,
			// Ground-clamp metadata — the alt we resolve from the scenario
			// is relative to the player; we actually want the unit to sit
			// on terrain. Defer the terrain lookup to the update loop
			// because the tile may not be loaded the frame we spawn.
			_needsGroundClamp: isStatic,
			// Ground clamp lifts npc.alt to terrain + the model's body half-
			// height, so the targeting point sits at the body's centre rather
			// than at the wheels. The platform JSON's own groundOffsetM is
			// added on top — useful for tents / structures that should be
			// pushed slightly up out of terrain noise.
			_groundOffsetM: (platform.groundOffsetM ?? 0) + centerAltOffsetM,
			signature,
			sensors,
			contacts: new Map(),
			rwr: new Map(),
		};

		// Dispatch pilot by strategy type. Merges platform defaults
		// with per-spawn overrides so a scenario can tune orbit radius /
		// altitude / speed without duplicating the whole platform JSON.
		const pilotCfg = platform.pilot || { type: 'orbit' };
		const params   = { ...(pilotCfg.defaultParams || {}), ...pilotOverrides };
		npc.pilot = this._makePilot(pilotCfg.type, lon, lat, alt, params);

		this.npcs.push(npc);
		console.log('[spawnPlatform]', platformId, 'spawned at',
			`lon=${lon.toFixed(4)} lat=${lat.toFixed(4)} alt=${alt.toFixed(0)}m`,
			`kind=${platform.kind} model=${path}`);
		return npc;
	}

	// Back-compat shim. Existing scenario code may still call spawnAwacs;
	// route it through the platform registry so behaviour stays identical.
	spawnAwacs(centerLon, centerLat, altitude, team = 'friendly') {
		return this.spawnPlatform('e-767-awacs', centerLon, centerLat, altitude, team,
			{ altitudeM: altitude });
	}

	// Pilot factory — dispatches on the platform JSON's pilot.type.
	// Adding a new pilot strategy (patrol-waypoint, static-sam, ...) =
	// a new case here plus a builder function (kept as private methods).
	// Pilot factory — delegates to src/systems/npcPilots.js. See that
	// file for the orbit / static-sam / (future) patrol implementations.
	_makePilot(type, lon, lat, alt, params) {
		return makePilot(type, lon, lat, alt, params);
	}


	// Bake a single NPC's world position + HPR into its THREE mesh matrix,
	// expressed in the supplied Cesium viewMatrix (world → camera-space)
	// frame. Pulled out of update() so `syncMeshMatrices()` can re-run
	// the bake AFTER a camera move without recomputing AI / physics.
	// The THREE side of the renderer uses an identity camera at origin,
	// so mesh.matrix IS the camera-space transform — which means the
	// viewMatrix used here MUST match the one Cesium renders the earth
	// with this frame, or the mesh and globe will drift apart visually
	// (the shake symptom when following a moving unit).
	_applyNpcMeshMatrix(npc, viewMatrix) { applyNpcMeshMatrix(this, npc, viewMatrix); }
	syncMeshMatrices()                    { syncNpcMeshMatrices(this); }

	// Per-frame NPC tick — the ~330-line loop lives in
	// src/systems/npcUpdate.js to keep this class file under its size
	// budget. The shim here keeps the public call site (main.js's sim
	// loop) unchanged.
	update(dt, playerState, simTime = 0) { npcSystemUpdate(this, dt, playerState, simTime); }

	// Called by the update loop when an NPC's EngageBehavior commits to a
	// shot. Mirrors the player's WeaponSystem.fire path: offset launch
	// point slightly off the NPC, instantiate the appropriate missile
	// class with the NPC as launcher (team/signature flow from there),
	// and push it into the NPC projectile pool.
	// Fire one round from an NPC's gun. Reuses the player's Bullet class
	// — same visual tracer, same terrain collision, same 20 m hit box.
	// Team-aware hit check inside Bullet keeps wingmen from clipping
	// each other. Pushed onto the shared `projectiles` pool so the
	// sensor/HUD layers see NPC gun fire via the same channel as
	// NPC missile fire.
	// Bullet + missile spawn delegates to src/systems/npcRendering.js.
	_spawnNpcBullet(npc, aim = null)       { return spawnNpcBullet(this, npc, aim); }
	_spawnNpcMissile(npc, weaponType, tgt) { return spawnNpcMissile(this, npc, weaponType, tgt); }

	clear() {
		this.npcs.forEach(npc => {
			this.scene.remove(npc.mesh);
		});
		this.npcs = [];
		this.projectiles = [];
		// Wipe datalinks so stale tracks from a prior run don't leak
		// into the new scenario's first frame.
		_resetAllDatalinks();
	}
}
