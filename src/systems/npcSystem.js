import * as THREE from 'three';
import * as Cesium from 'cesium';
import { advanceLonLatAlt } from '../plane/aeroModel.js';
import { PlanePhysics } from '../plane/planePhysics.js';
import { stripOrdnance } from '../plane/stripOrdnance.js';
import { highlightMeshes } from '../plane/highlightMeshes.js';
import { SIGNATURES } from './signatures.js';
import {
	FIGHTER_RADAR_DEFAULT,
	FIGHTER_IRST_DEFAULT,
	FIGHTER_EYEBALL_DEFAULT,
} from './sensorSystem.js';
import { createFighterPilot } from './ai/index.js';
import { Flare } from '../weapon/flare.js';
import { createMunition, munitionIdForSimType } from '../weapon/munitionFactory.js';
import { Bullet } from '../weapon/bullet.js';
import { particles } from '../utils/particles.js';
import { soundManager } from '../utils/soundManager.js';
import { getTeamDatalink, tickAllDatalinks, resetAllDatalinks as _resetAllDatalinks } from './teamDatalink.js';
import { getPlatform } from './platforms.js';
import { WeaponSubsystem } from './ai/subsystems.js';

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

		this._scratchMatrix = new Cesium.Matrix4();
		this._scratchHPR = new Cesium.HeadingPitchRoll();
		this._scratchCartesian = new Cesium.Cartesian3();
		this._scratchThreeMatrix = new THREE.Matrix4();
		this._scratchCameraMatrix = new Cesium.Matrix4();

		this.loadModel();
	}

	loadModel() {
		this.loader.load('/assets/models/f-15-strike-eagle.glb', (gltf) => {
			this.modelTemplate = gltf.scene;
			this.animations = gltf.animations;
			this.modelTemplate.traverse((child) => {
				if (child.isMesh) {
					child.castShadow = true;
					child.receiveShadow = true;
				}
			});
			// highlightMeshes / stripOrdnance helpers available for
			// iteration on model cleanup; not used in the normal load
			// path.
			this.loaded = true;
		});
		// AWACS model (Boeing E-767) — loaded lazily alongside the
		// fighter so spawnAwacs() has it available. Kept as a separate
		// template because its scale and animations are different.
		this.loader.load('/assets/models/e-767-awacs.glb', (gltf) => {
			this.awacsTemplate = gltf.scene;
			this.awacsAnimations = gltf.animations;
			this.awacsTemplate.traverse((child) => {
				if (child.isMesh) {
					child.castShadow = true;
					child.receiveShadow = true;
				}
			});
		}, undefined, (err) => {
			console.warn('[NPCSystem] e-767 model failed to load', err);
		});
		// MIM-104 Patriot GLB — used visually for the NASAMS SAM site
		// platform (despite NASAMS being the performance reference, the
		// user explicitly picked the Patriot visual). Preloaded next to
		// the fighter so spawnPlatform() has it ready.
		this.loader.load('/assets/models/mim-104-patriot.glb', (gltf) => {
			this.patriotTemplate   = gltf.scene;
			this.patriotAnimations = gltf.animations;
			this.patriotTemplate.traverse((child) => {
				if (child.isMesh) {
					child.castShadow = true;
					child.receiveShadow = true;
				}
			});
			// Log so we can see in console whether this template is
			// available before the user clicks Start on the scenario.
			try {
				const box = new THREE.Box3().setFromObject(this.patriotTemplate);
				const size = new THREE.Vector3();
				box.getSize(size);
				console.log('[NPCSystem] patriot template loaded, size(m):',
					size.x.toFixed(1), size.y.toFixed(1), size.z.toFixed(1));
			} catch (e) {
				console.log('[NPCSystem] patriot template loaded (size query failed)');
			}
		}, undefined, (err) => {
			console.warn('[NPCSystem] patriot model failed to load', err);
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

		// Resolve the mesh template. Preloaded templates are selected by
		// path keyword — fast and keeps this generic so further platforms
		// just need their GLB dropped next to the existing ones in
		// public/assets/models/ + a JSON registered under src/data/
		// platforms/. If the required template hasn't finished loading
		// yet (GLB fetch is async; a user who clicks Start the moment
		// the app boots can beat it), queue the spawn and retry in the
		// next update tick. Previously we fell back to the fighter
		// template silently, which produced an "invisible / wrong
		// model" bug where the SAM site rendered as a sideways F-15.
		let template = null;
		let animations = null;
		let required = null;
		if (platform.model && platform.model.includes('e-767')) {
			required   = 'e-767';
			template   = this.awacsTemplate;
			animations = this.awacsAnimations;
		} else if (platform.model && platform.model.includes('patriot')) {
			required   = 'patriot';
			template   = this.patriotTemplate;
			animations = this.patriotAnimations;
		} else {
			// Unknown model path — fall back to the fighter template so
			// the platform still spawns (useful during authoring).
			required   = 'fighter';
			template   = this.modelTemplate;
			animations = this.animations;
		}
		if (!template) {
			console.warn('[spawnPlatform] template', required, 'not loaded yet; queuing', platformId);
			if (!this._pendingPlatformSpawns) this._pendingPlatformSpawns = [];
			this._pendingPlatformSpawns.push({ platformId, lon, lat, alt, team, pilotOverrides });
			return null;
		}

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

		// Debug beacon for ground platforms. Tall, bright, always visible
		// even if the GLB orientation is off or the model is buried. A
		// 300 m pillar above the unit is small enough not to wreck the
		// scene and large enough to spot from 30 km. Remove `debugBeacon`
		// once the model render is verified to work for real. The beacon
		// is added to the group so it inherits the same world matrix as
		// the model.
		if (platform.kind === 'ground') {
			const beaconGeom = new THREE.CylinderGeometry(3, 3, 300, 8);
			beaconGeom.translate(0, 0, 150);
			const beaconMat = new THREE.MeshBasicMaterial({
				color: 0xff4020, transparent: true, opacity: 0.55,
				depthWrite: false,
			});
			const beacon = new THREE.Mesh(beaconGeom, beaconMat);
			beacon.rotation.x = Math.PI / 2; // lay along +Z (world-up)
			group.add(beacon);
		}
		group.matrixAutoUpdate = false;
		this.scene.add(group);

		const mixer = new THREE.AnimationMixer(model);
		if (animations && animations.length > 0) {
			const action = mixer.clipAction(animations[0]);
			action.setLoop(THREE.LoopRepeat);
			action.play();
		}

		// Sensors — merge defaults with the platform's per-sensor overrides.
		const sensors = {
			radar:   { ...FIGHTER_RADAR_DEFAULT, ...(platform.sensors?.radar   || {}) },
			ir:      { ...FIGHTER_IRST_DEFAULT,  ...(platform.sensors?.ir      || {}) },
			eyeball: { ...FIGHTER_EYEBALL_DEFAULT,...(platform.sensors?.eyeball|| {}) },
		};
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
			_groundOffsetM: platform.groundOffsetM ?? 0,
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
			`kind=${platform.kind} template=${required}`);
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
	_makePilot(type, lon, lat, alt, params) {
		switch (type) {
			case 'orbit':
				return this._makeOrbitPilot(lon, lat, params.altitudeM ?? alt, params.radiusM ?? 40000);
			case 'static-sam':
				return this._makeStaticSamPilot(params);
			// Future:
			//   case 'patrol':   return this._makePatrolPilot(params.waypoints);
			//   case 'fighter':  return createFighterPilot(/* unit filled by caller */);
			default:
				console.warn('[npcSystem] unknown pilot type:', type);
				return this._makeOrbitPilot(lon, lat, alt, 40000);
		}
	}

	_makeOrbitPilot(centerLon, centerLat, altitude, radiusM) {
		const command = {
			targetHeading: 0,
			targetPitch:   0,
			throttle:      0.6,
			targetSpeed:   180,   // AWACS cruise
			boost:         false,
			fireFlare:     false,
			fireWeapon:    false,
		};
		return {
			command,
			subsystems: {},
			update(context /*, dt */) {
				const npc = context.unit;
				const plat = centerLat * Math.PI / 180;
				const dE = (npc.lon - centerLon) * 111320 * Math.cos(plat);
				const dN = (npc.lat - centerLat) * 111320;
				const radius = Math.hypot(dE, dN);

				// Tangential heading to hold the orbit, with a gentle
				// radial correction so we don't drift inward/outward.
				const radialBearing = Math.atan2(dE, dN) * 180 / Math.PI;
				let headingCmd = (radialBearing + 90 + 360) % 360;
				const radialErr = radius - radiusM;
				// Small crab angle: up to 20° inward/outward nudge.
				headingCmd += Math.max(-20, Math.min(20, radialErr * 0.001));
				command.targetHeading = headingCmd;

				// Altitude hold (proportional, saturated).
				const altErr = altitude - npc.alt;
				command.targetPitch = Math.max(-5, Math.min(5, altErr * 0.01));
			},
		};
	}

	// ========================================================================
	// Static SAM pilot — decides when to launch surface-to-air missiles.
	//
	// Runs on a ground-kind platform with:
	//   - a long-range search radar (handled by sensorSystem via the
	//     platform's own sensors.radar config); the radar populates
	//     unit.contacts like any other observer
	//   - a WeaponSubsystem containing exactly one surface-launch missile
	//     entry (e.g. NASAMS-MSL) with a fixed magazine
	//
	// Real-world doctrine this tries to approximate (NASAMS / Patriot
	// pattern): for each validated hostile track in envelope, fire a
	// 2-missile salvo (ripple fire) to improve single-target Pk. When
	// the magazine draws down below a conservation threshold, drop to
	// single shots so the battery isn't left empty after one engagement.
	// Track a per-target reengage cooldown so we don't dump the magazine
	// pinging the same bandit; and cap simultaneous missiles-in-flight
	// so a long track of targets is engaged serially, not all at once.
	//
	// Config (params):
	//   missileType         weapon type string, e.g. "NASAMS-MSL"
	//   magazine            initial + max ammo count
	//   salvoSize           missiles per ripple-fire engagement (default 2)
	//   conserveLastN       drop to single-shot when ammo ≤ this (default 2)
	//   intraSalvoGapS      seconds between ripple-fire shots (default 1.2)
	//   perTargetReengageS  seconds before re-engaging the same target
	//   maxInFlight         hard cap on simultaneous live missiles
	//   minRangeM / maxRangeM  engagement envelope (default NASAMS-ish)
	// ========================================================================
	_makeStaticSamPilot(params) {
		const missileType = params.missileType || 'NASAMS-MSL';
		const magazine    = params.magazine    ?? 8;
		const salvoSize   = params.salvoSize   ?? 2;
		const conserveN   = params.conserveLastN ?? 2;
		const intraGap    = params.intraSalvoGapS ?? 1.2;
		const reengageT   = params.perTargetReengageS ?? 20;
		const maxInFlight = params.maxInFlight ?? 4;
		const minRange    = params.minRangeM ?? 1500;
		const maxRange    = params.maxRangeM ?? 25000;

		const weapons = new WeaponSubsystem({
			weapons: [{
				type: missileType,
				ammo: magazine, maxAmmo: magazine,
				// fireRate = intra-salvo gap. WeaponSubsystem.consume gates
				// on `now - lastFire >= fireRate`, so this doubles as the
				// "seconds between ripple-fired shots" constant.
				fireRate: intraGap,
				maxInFlight,
				lastFire: -Infinity,
				minRange, maxRange,
			}],
		});

		const command = {
			targetHeading: 0,
			targetPitch:   0,
			throttle:      0,
			targetSpeed:   0,
			boost:         false,
			fireFlare:     false,
			fireWeapon:    false,
			weaponType:    null,
			weaponTarget:  null,
			activeBehaviorName: 'StaticSAM',
		};

		// Closure state — carried across ticks. `_currentEngagement`
		// encodes "we committed to a salvo on this target; keep firing
		// until it's dead, out of envelope, or we've fired enough"; the
		// cooldown map prevents us from re-engaging the same target
		// moments after a salvo miss, which would otherwise let the
		// battery empty itself onto one lucky jinker.
		const state = {
			lastAmmoSeen: magazine,
			currentEngagement: null,       // { target, plannedShots, shotsFired }
			engagementCooldown: new Map(), // target → sim-time of last engagement
		};

		function pickTarget(unit, weapon) {
			if (!unit.contacts) return null;
			let best = null;
			let bestRange = Infinity;
			for (const [target, c] of unit.contacts) {
				if (!target || target.destroyed || target.active === false) continue;
				if (target.team && unit.team && target.team === unit.team) continue;
				const sig = target.signature;
				if (!sig) continue;
				// Air-defence doctrine: SAMs don't shoot other SAMs, don't
				// engage live missiles, and don't engage ground targets.
				if (sig.unitClass === 'missile' || sig.unitClass === 'cruise_missile') continue;
				if (sig.unitClass === 'sam_site') continue;
				// Need a radar range for a firing solution. A purely passive
				// (IR / visual) detection isn't enough for an active-radar
				// SAM to hand off midcourse guidance.
				if (!c.radar) continue;
				const range = c.radar.range;
				if (range < weapon.minRange || range > weapon.maxRange) continue;
				if (range < bestRange) {
					best = { target, range };
					bestRange = range;
				}
			}
			return best;
		}

		return {
			command,
			subsystems: { weapons },
			update(context /*, dt */) {
				const unit = context.unit;
				const now  = context.now;
				const weapon = weapons.weapons[0];

				// Reset per-frame command intent; we'll only set fire flags
				// below when the doctrine machine says so.
				command.fireWeapon   = false;
				command.weaponType   = null;
				command.weaponTarget = null;

				// Detect shots fired since last tick by watching the ammo
				// delta. The actual spawn happens in npcSystem.update()'s
				// fire-gate block, which calls weapons.consume() — so the
				// pilot itself can't tell a shot succeeded except via ammo
				// change. This keeps the shot-counter consistent with the
				// real subsystem gate (cooldown, maxInFlight) rather than
				// incrementing optimistically.
				const fired = state.lastAmmoSeen - weapon.ammo;
				if (fired > 0 && state.currentEngagement) {
					state.currentEngagement.shotsFired += fired;
				}
				state.lastAmmoSeen = weapon.ammo;

				// Dry magazine = nothing to do. The battery will silently
				// sit and radiate; no reload plumbing exists yet.
				if (weapon.ammo <= 0) return;

				// ------------------------------------------------------
				// Continue an in-progress salvo, if any.
				// ------------------------------------------------------
				const eng = state.currentEngagement;
				if (eng) {
					const t = eng.target;
					const stillAlive = t && !t.destroyed && t.active !== false;
					let keep = stillAlive && eng.shotsFired < eng.plannedShots;
					if (keep) {
						// Target must still be in our radar envelope — if
						// the bandit notches out, beams us, drops behind a
						// ridge, or flies out of max range, we abort the
						// salvo. Real batteries break engagement the same
						// way when illumination is lost.
						const c = unit.contacts && unit.contacts.get(t);
						const inEnv = c && c.radar &&
							c.radar.range >= weapon.minRange &&
							c.radar.range <= weapon.maxRange;
						if (!inEnv) keep = false;
					}
					if (keep) {
						// Request another shot — WeaponSubsystem.consume
						// enforces the intra-salvo gap via fireRate, so we
						// can set fireWeapon every tick and the subsystem
						// will only actually consume at the right cadence.
						command.fireWeapon   = true;
						command.weaponType   = weapon.type;
						command.weaponTarget = t;
						return;
					}
					// Salvo done (kill, envelope break, or plannedShots met).
					state.currentEngagement = null;
				}

				// ------------------------------------------------------
				// No active engagement — look for a fresh target.
				// ------------------------------------------------------
				const best = pickTarget(unit, weapon);
				if (!best) return;

				// Per-target reengage cooldown. If we just fired at this
				// bandit and didn't kill them, give the outcome of the
				// salvo time to play out before committing more missiles.
				const lastTime = state.engagementCooldown.get(best.target);
				if (lastTime != null && now - lastTime < reengageT) return;

				// Magazine-conservation policy. When the launcher is down
				// to its last N missiles, switch to single-shot so the
				// battery doesn't empty itself on one engagement.
				const plannedShots = Math.min(
					(weapon.ammo <= conserveN) ? 1 : salvoSize,
					weapon.ammo,
				);

				state.currentEngagement = {
					target: best.target,
					plannedShots,
					shotsFired: 0,
				};
				state.engagementCooldown.set(best.target, now);

				command.fireWeapon   = true;
				command.weaponType   = weapon.type;
				command.weaponTarget = best.target;
			},
		};
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
	_applyNpcMeshMatrix(npc, viewMatrix) {
		if (!npc || !npc.mesh) return;
		const pos = Cesium.Cartesian3.fromDegrees(npc.lon, npc.lat, npc.alt, undefined, this._scratchCartesian);

		this._scratchHPR.heading = Cesium.Math.toRadians(npc.heading);
		this._scratchHPR.pitch = Cesium.Math.toRadians(npc.roll);
		this._scratchHPR.roll = Cesium.Math.toRadians(npc.pitch);

		const modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(
			pos, this._scratchHPR, Cesium.Ellipsoid.WGS84,
			Cesium.Transforms.eastNorthUpToFixedFrame, this._scratchMatrix,
		);

		const cameraSpaceMatrix = Cesium.Matrix4.multiply(viewMatrix, modelMatrix, this._scratchCameraMatrix);
		for (let i = 0; i < 16; i++) {
			this._scratchThreeMatrix.elements[i] = cameraSpaceMatrix[i];
		}
		npc.mesh.matrix.copy(this._scratchThreeMatrix);
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
	syncMeshMatrices() {
		if (!this.loaded || !this.viewer) return;
		const viewMatrix = this.viewer.camera.viewMatrix;
		for (const npc of this.npcs) {
			if (!npc || npc.destroyed) continue;
			this._applyNpcMeshMatrix(npc, viewMatrix);
		}
		for (const p of this.projectiles) {
			if (!p || !p.active) continue;
			if (typeof p.updateThreeMatrix === 'function') p.updateThreeMatrix();
		}
	}

	update(dt, playerState, simTime = 0) {
		if (!this.loaded) return;

		// Retry any platform spawns that were deferred because their
		// model template hadn't finished loading yet. Template loads
		// are async and independent; a scenario's onStart can fire
		// before the GLB response lands, especially for the larger
		// ground-vehicle assets. Re-queue any that still fail so the
		// retry is idempotent.
		if (this._pendingPlatformSpawns && this._pendingPlatformSpawns.length > 0) {
			const retry = this._pendingPlatformSpawns;
			this._pendingPlatformSpawns = [];
			for (const p of retry) {
				this.spawnPlatform(p.platformId, p.lon, p.lat, p.alt, p.team, p.pilotOverrides);
			}
		}

		const viewMatrix = this.viewer.camera.viewMatrix;

		// Team datalink — publish every radar-equipped team-mate's
		// contacts into the shared store so the AI can see bogeys that
		// only wingmen / AWACS have painted, and can deconflict
		// engagements. Player publishes too (for symmetry; a future
		// friendly-wingman would benefit). Ticked once here to age out
		// stale entries.
		// Dead player doesn't publish. Their radar stopped (above), so
		// their contacts map is stale anyway — but guard here belt-and-
		// braces so the datalink doesn't pick up any pre-death residue.
		if (playerState && playerState.team && !playerState.destroyed) {
			const dl = getTeamDatalink(playerState.team);
			if (dl) dl.publishContacts(playerState, simTime);
		}
		for (const npc of this.npcs) {
			if (!npc || npc.destroyed || !npc.team) continue;
			const dl = getTeamDatalink(npc.team);
			if (dl) dl.publishContacts(npc, simTime);
		}
		tickAllDatalinks(simTime);

		// Age any in-flight flares spawned by NPC evasion (reuses the same
		// Flare class the player uses).
		if (this.flares) {
			for (let i = this.flares.length - 1; i >= 0; i--) {
				const f = this.flares[i];
				f.update(dt);
				if (!f.active) this.flares.splice(i, 1);
			}
		}

		// Update NPC-fired missiles. Target list = player + all NPCs; each
		// missile filters out its own team and launcher internally. The
		// player gets a `destroyed` flag when an incoming missile hits it,
		// which main.js acts on to trigger the crash/respawn transition.
		const targetList = [playerState, ...this.npcs];
		for (let i = this.projectiles.length - 1; i >= 0; i--) {
			const p = this.projectiles[i];
			const wasActive = p.active;
			p.update(dt, targetList);
			// Clear the team datalink engagement registration the first
			// frame the missile becomes inactive. Deconfliction opens up
			// for teammates within a frame of miss/kill rather than
			// waiting on the tick()-based linger.
			if (wasActive && !p.active && p.launcher && p.launcher.team) {
				const dl = getTeamDatalink(p.launcher.team);
				if (dl) dl.clearByMissile(p);
			}
			const hasTrail = p.trail && p.trail.length > 0;
			if (!p.active && !hasTrail) this.projectiles.splice(i, 1);
		}

		for (let i = this.npcs.length - 1; i >= 0; i--) {
			const npc = this.npcs[i];
			if (npc.destroyed) {
				this.scene.remove(npc.mesh);
				this.npcs.splice(i, 1);
				continue;
			}
			npc.time += dt;
			npc.terrainCheckTimer -= dt;

			// Terrain AGL is sampled at 2 Hz and handed into the pilot
			// context so the TerrainAvoid behavior has current-ish data
			// without re-raycasting every tick.
			if (npc.terrainCheckTimer <= 0) {
				npc.terrainCheckTimer = 0.5;
				const cartographic = Cesium.Cartographic.fromDegrees(npc.lon, npc.lat);
				const terrainHeight = this.viewer.scene.globe.getHeight(cartographic);
				if (terrainHeight !== undefined) npc._cachedTerrainH = terrainHeight;
			}

			// One-shot ground clamp for static ground units. Runs BEFORE
			// the pilot tick so the first-frame decision uses the correct
			// altitude. Tries two height sources in order:
			//   1. the async sampleTerrainMostDetailed result stashed at
			//      spawn time (authoritative, forces tile load)
			//   2. globe.getHeight() against the currently-loaded tile
			//      (cheap, returns undefined if the tile isn't loaded)
			// Whichever resolves first wins; subsequent frames retry
			// until one does.
			if (npc.isStatic && npc._needsGroundClamp) {
				let h;
				if (this._pendingGroundHeight && this._pendingGroundHeight.has(npc.name)) {
					h = this._pendingGroundHeight.get(npc.name);
					this._pendingGroundHeight.delete(npc.name);
				}
				if (h == null) {
					const carto = Cesium.Cartographic.fromDegrees(npc.lon, npc.lat);
					const g = this.viewer.scene.globe.getHeight(carto);
					if (g !== undefined) h = g;
				}
				if (h != null) {
					npc.alt = h + (npc._groundOffsetM || 0);
					npc._cachedTerrainH = h;
					npc._needsGroundClamp = false;
				}
			}

			// Run the AI: pilot reads sensors/state, writes its command.
			if (npc.pilot) {
				// Combined world projectile pool — lets WeaponSubsystem
				// count in-flight missiles from this NPC and enforce
				// maxInFlight, which produces shoot-look-shoot rather than
				// magazine-dump-in-one-burst behaviour.
				const playerProjs = (playerState && playerState.weaponSystem &&
					playerState.weaponSystem.projectiles) || [];
				const ctxProjectiles = playerProjs.concat(this.projectiles);

				npc.pilot.update({
					unit: npc,
					now:  simTime,
					terrainHeight: npc._cachedTerrainH,
					projectiles: ctxProjectiles,
					teamDatalink: getTeamDatalink(npc.team),
				}, dt);
				const cmd = npc.pilot.command;
				npc.targetHeading = cmd.targetHeading;
				npc.targetPitch   = cmd.targetPitch;
				npc.throttle      = cmd.throttle;
				npc.isBoosting    = cmd.boost;

				// Flare release is gated by the countermeasure subsystem
				// (inventory + cooldown); behaviors only express intent.
				if (cmd.fireFlare) {
					const cm = npc.pilot.subsystems.countermeasures;
					if (cm && cm.consumeFlare(simTime)) {
						if (!this.flares) this.flares = [];
						this.flares.push(new Flare(
							this.scene, this.viewer,
							{ lon: npc.lon, lat: npc.lat, alt: npc.alt },
							npc.heading, npc.pitch, npc.speed,
						));
					}
				}

				// Weapon release is also gated by the WeaponSubsystem, which
				// owns ammo + fire cooldown. The EngageBehavior only declares
				// intent (fireWeapon + weaponType + weaponTarget); the
				// subsystem decides whether this click counts.
				if (cmd.fireWeapon && cmd.weaponType && cmd.weaponTarget) {
					const ws = npc.pilot.subsystems.weapons;
					const picked = ws && ws.weapons.find(w => w.type === cmd.weaponType);
					if (ws && ws.consume(picked, simTime)) {
						if (cmd.weaponType === 'gun') {
							// Gun fire takes a different path: no seeker,
							// no datalink registration — it's ballistic and
							// unguided. Each "consume" slot produces a single
							// tracer round; the pilot's high fireRate (0.08s)
							// turns this into a steady stream while the
							// EngageBehavior keeps the nose on the pipper.
							this._spawnNpcBullet(npc);
						} else {
							const projectile = this._spawnNpcMissile(npc, cmd.weaponType, cmd.weaponTarget);
							// Register with the team datalink so wingmen don't
							// immediately double-up on the same bogey. Cleared
							// when the missile's active flag flips (above).
							if (projectile && npc.team) {
								const dl = getTeamDatalink(npc.team);
								if (dl) dl.registerEngagement(npc, projectile, cmd.weaponTarget, simTime);
							}
						}
					}
				}
			}

			// ---- Static ground platforms (SAM sites, ground radars): skip
			// the whole flight-physics + terrain-collision block. They
			// don't move and they don't fall. The one-shot terrain clamp
			// happened earlier in the loop; here we just pin the kinematic
			// fields the downstream renderer / sensor code expects.
			if (npc.isStatic) {
				// Speed 0 means sensorSystem's Doppler-notch filter would
				// reject anyone trying to detect us — not a problem for
				// a ground unit. Heading/pitch stay at whatever the
				// platform was placed with (default 0).
				npc.speed   = 0;
				npc.roll    = 0;
				npc.isBoosting = false;
			} else {
				// ---- Autopilot: AI "I want heading X / pitch Y" → stick input.
				// PlanePhysics takes the same input shape the player's stick
				// produces: { pitch, roll, yaw, throttle, boost }, each of
				// pitch/roll/yaw in [-1, 1]. We synthesize those from the
				// pilot's desired-heading/desired-pitch targets:
				//
				//   - Heading error → desired bank angle (proportional,
				//     saturated at ±70°). Bank error → roll stick.
				//   - Pitch error → pitch stick directly (saturated).
				//   - Yaw left at 0; the aero model handles coordination
				//     through sideslip + lateral stability.
				//
				// Everything else (turn rate, roll rate, stall, G-limit,
				// drag penalty on hard turns, throttle spool-up) is the
				// same aero code the player aircraft runs, so the NPC can
				// never out-maneuver what the player can physically do.
				let headingErr = npc.targetHeading - npc.heading;
				while (headingErr < -180) headingErr += 360;
				while (headingErr > 180) headingErr -= 360;

				const MAX_BANK = 70;                    // degrees
				const BANK_GAIN = MAX_BANK / 40;        // sat at ±40° heading err
				const desiredBank = Math.max(-MAX_BANK, Math.min(MAX_BANK, headingErr * BANK_GAIN));
				const bankErr = desiredBank - npc.roll; // npc.roll kept in sync below
				const rollStick  = Math.max(-1, Math.min(1,  bankErr   * 0.04));
				const pitchStick = Math.max(-1, Math.min(1, (npc.targetPitch - npc.pitch) * 0.15));

				const input = {
					pitch:    pitchStick,
					roll:     rollStick,
					yaw:      0,
					throttle: (npc.throttle != null) ? npc.throttle : 0.75,
					boost:    !!npc.isBoosting,
				};

				// Feed PlanePhysics the current altitude so its density /
				// thrust model is accurate at the NPC's flight level.
				npc.physics.currentAltitude = npc.alt;
				const pr = npc.physics.update(input, dt);

				// Mirror the physics state back onto the NPC fields the rest
				// of the system reads (sensors, AI, HUD, cesium transform).
				npc.heading = pr.heading;
				npc.pitch   = pr.pitch;
				npc.roll    = pr.roll;
				npc.speed   = pr.speed;
				npc.isBoosting = pr.isBoosting;

				// Position integration uses the physics velocity vector
				// directly (same path as the player in main.js). This lets
				// sideslip / G-induced drift actually show up in world
				// position, instead of forcing motion to track the body's
				// forward axis the way the old movePosition() call did.
				const velENU = npc.physics.velocity; // THREE.Vector3 in m/s ENU
				const newPos = advanceLonLatAlt(npc.lon, npc.lat, npc.alt, velENU, dt);
				npc.lon = newPos.lon;
				npc.lat = newPos.lat;
				npc.alt = newPos.alt;

				// Terrain collision — previously the kinematic integrator
				// happily drove NPCs straight through ridges because nothing
				// enforced ground contact. Sample terrain height at the
				// just-integrated position and, if the NPC is at or below it,
				// detonate the aircraft (same effect as a missile hit). The
				// 2 Hz cached height is used as a fast fallback so we don't
				// spam getHeight(), and a fresh direct sample runs only when
				// we're close enough to the cached surface to possibly be in
				// trouble — CPU-cheap in the common "high-altitude cruise"
				// case and authoritative when it matters. Static ground
				// units skip this entirely — they're SUPPOSED to sit on
				// the ground and would blow up instantly otherwise.
				if (!npc.destroyed) {
					let terrainH = npc._cachedTerrainH;
					const maybeCloseToGround = terrainH === undefined ||
						npc.alt < terrainH + 300;
					if (maybeCloseToGround) {
						const carto = Cesium.Cartographic.fromDegrees(npc.lon, npc.lat);
						const h = this.viewer.scene.globe.getHeight(carto);
						if (h !== undefined) {
							terrainH = h;
							npc._cachedTerrainH = h;
						}
					}
					if (terrainH !== undefined && npc.alt <= terrainH + 3) {
						// Mark destroyed; the top-of-loop cleanup block will
						// remove the mesh next iteration. Emit wreckage +
						// explosion effects so the kill reads visually the
						// same as an air-to-air kill.
						npc.destroyed = true;
						try {
							particles.spawnExplosion(npc.lon, npc.lat, terrainH + 2,
								{ count: 80, smokeCount: 18, big: true });
							particles.spawnWreckage(npc.lon, npc.lat, terrainH + 2,
								npc.heading, npc.pitch, { count: 48 });
						} catch (e) { /* particles optional */ }
						try { soundManager.play('explode'); } catch (e) {}
						continue;
					}
				}
			}

			this._applyNpcMeshMatrix(npc, viewMatrix);

			if (npc.mixer) {
				npc.mixer.update(dt);
			}
		}

		// Spawn logic: while the live NPC count is below maxNpcs, queue a
		// fresh one every spawnInterval ms. Doubled from the defaults
		// (max 3, every 5s) to produce a denser battlefield — more
		// faction-on-faction engagements to watch, more opportunities
		// for the player to pick sides.
		if (this.autoSpawn && this.npcs.length < 6 && Date.now() - this.lastSpawnTime > 2500) {
			this.spawnNPC(playerState.lon, playerState.lat, playerState.alt);
			this.lastSpawnTime = Date.now();
		}
	}

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
	_spawnNpcBullet(npc) {
		const nosePos = { lon: npc.lon, lat: npc.lat, alt: npc.alt };
		const bullet = new Bullet(
			this.scene, this.viewer, nosePos,
			npc.heading, npc.pitch, npc.speed,
			null, // onKill — NPC-on-NPC / NPC-on-player gun kills don't score
			npc,
		);
		this.projectiles.push(bullet);
		return bullet;
	}

	_spawnNpcMissile(npc, weaponType, target) {
		// Small offset "under wing" so missiles don't spawn inside the
		// fuselage. Uses the NPC's heading+pitch to place it ahead+below.
		// For static ground SAMs: launch from +3 m ABOVE the launcher
		// (rough top of the canister) instead of below it, so the
		// missile doesn't appear to come out of the ground.
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

		// Factory dispatch on simType. NPC weapons carry `type` strings
		// like "AIM-120" / "AIM-9" / "NASAMS-MSL"; the factory picks the
		// right seeker class and JSON parameters.
		const munitionId = munitionIdForSimType(weaponType);
		const projectile = createMunition(
			munitionId,
			this.scene, this.viewer, launch,
			launchHeading, launchPitch, npc.speed || 0,
			target, onKill, npc,
		);
		if (!projectile) return null;
		this.projectiles.push(projectile);
		return projectile;
	}

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
