import * as THREE from 'three';
import * as Cesium from 'cesium';
import { advanceLonLatAlt } from '../plane/aeroModel.js';
import { PlanePhysics } from '../plane/planePhysics.js';
import { SIGNATURES } from './signatures.js';
import {
	FIGHTER_RADAR_DEFAULT,
	FIGHTER_IRST_DEFAULT,
	FIGHTER_EYEBALL_DEFAULT,
} from './sensorSystem.js';
import { createFighterPilot } from './ai/index.js';
import { Flare } from '../weapon/flare.js';
import { Missile } from '../weapon/missile.js';
import { AIM120 } from '../weapon/aim120.js';
import { particles } from '../utils/particles.js';
import { soundManager } from '../utils/soundManager.js';
import { getTeamDatalink, tickAllDatalinks, resetAllDatalinks as _resetAllDatalinks } from './teamDatalink.js';

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
		this.loader.load('/assets/models/f-15.glb', (gltf) => {
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

		model.rotation.x = Math.PI / 2;
		model.scale.set(1.0, 1.0, 1.0);

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
	spawnAwacs(centerLon, centerLat, altitude, team = 'friendly') {
		if (!this.loaded) return null;

		// AWACS sensors: big radar with a wide scan, matching real E-3
		// AN/APY-1 range against fighter-class targets (~500 km). IR /
		// visual kept at fighter level — AWACS doesn't normally use IR
		// for the air picture.
		// Real rotodome AWACS radars (E-3 APY-1, E-767 APY-2) mechanically
		// rotate 360° every ~10 s and electronically steer in elevation.
		// We don't model scan time — from the sim's perspective the radar
		// picks up any target anywhere on the hemisphere each frame.
		// fovH = π / fovV = π/2 makes the FOV test always pass (it's
		// the radar equation + notch that gate detection, not pointing).
		const AWACS_RADAR = {
			enabled: true, active: true, mode: 'search',
			nominalRange: 500000,
			referenceRcs: 5,
			fovH: Math.PI,        // ±180°  (omnidirectional horizontally)
			fovV: Math.PI / 2,    // ±90°   (full vertical hemisphere)
			notchThreshold: 60,
		};

		// Build the mesh using the E-767 template if it's loaded,
		// otherwise fall back to the fighter template scaled up so
		// AWACS still spawns during model-loading races.
		const template = this.awacsTemplate || this.modelTemplate;
		const animations = this.awacsTemplate ? this.awacsAnimations : this.animations;
		if (!template) return null;

		const name = 'SENTRY ' + (100 + Math.floor(Math.random() * 900));
		const group = new THREE.Group();
		const model = template.clone();
		model.rotation.x = Math.PI / 2;
		// Scale: f-15 is loaded at scale 1.0 in createNPCMesh, but the
		// raw AWACS mesh is large — leave at 1.0 unless we need to
		// tune after visual inspection. If the E-767 template came out
		// oversized we can drop to 0.5 here.
		model.scale.set(1.0, 1.0, 1.0);
		group.add(model);
		group.matrixAutoUpdate = false;
		this.scene.add(group);

		const mixer = new THREE.AnimationMixer(model);
		if (animations && animations.length > 0) {
			const clip = animations[0]; // play the first available clip
			const action = mixer.clipAction(clip);
			action.setLoop(THREE.LoopRepeat);
			action.play();
		}

		const npc = {
			id: name + '_' + Math.random().toString(36).substr(2, 9),
			mesh: group, mixer,
			name,
			lon: centerLon, lat: centerLat, alt: altitude,
			heading: 0, pitch: 0, roll: 0,
			speed: 180, throttle: 0.6, isBoosting: false,
			targetHeading: 0, targetPitch: 0,
			physics: (() => {
				const p = new PlanePhysics();
				p.reset(centerLon, centerLat, altitude, 0, 0, 0);
				return p;
			})(),
			behaviorTimer: 0, terrainCheckTimer: 0, time: 0,
			team,
			signature: { ...SIGNATURES.awacs },
			sensors: {
				radar:   AWACS_RADAR,
				ir:      { ...FIGHTER_IRST_DEFAULT },
				eyeball: { ...FIGHTER_EYEBALL_DEFAULT },
			},
			contacts: new Map(),
			rwr: new Map(),
		};

		// Orbit-only pilot — no targeting, no weapons. Its contribution
		// to the team comes entirely through datalink publishes of the
		// AWACS's own radar contacts (handled in update()).
		npc.pilot = this._makeOrbitPilot(centerLon, centerLat, altitude, 40000);
		this.npcs.push(npc);
		return npc;
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

	update(dt, playerState, simTime = 0) {
		if (!this.loaded) return;

		const viewMatrix = this.viewer.camera.viewMatrix;

		// Team datalink — publish every radar-equipped team-mate's
		// contacts into the shared store so the AI can see bogeys that
		// only wingmen / AWACS have painted, and can deconflict
		// engagements. Player publishes too (for symmetry; a future
		// friendly-wingman would benefit). Ticked once here to age out
		// stale entries.
		if (playerState && playerState.team) {
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
			// case and authoritative when it matters.
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

			const pos = Cesium.Cartesian3.fromDegrees(npc.lon, npc.lat, npc.alt, undefined, this._scratchCartesian);

			this._scratchHPR.heading = Cesium.Math.toRadians(npc.heading);
			this._scratchHPR.pitch = Cesium.Math.toRadians(npc.roll);
			this._scratchHPR.roll = Cesium.Math.toRadians(npc.pitch);

			const modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(
				pos,
				this._scratchHPR,
				Cesium.Ellipsoid.WGS84,
				Cesium.Transforms.eastNorthUpToFixedFrame,
				this._scratchMatrix
			);

			const cameraSpaceMatrix = Cesium.Matrix4.multiply(viewMatrix, modelMatrix, this._scratchCameraMatrix);

			for (let i = 0; i < 16; i++) {
				this._scratchThreeMatrix.elements[i] = cameraSpaceMatrix[i];
			}

			npc.mesh.matrix.copy(this._scratchThreeMatrix);
			npc.mesh.updateMatrixWorld(true);

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
	_spawnNpcMissile(npc, weaponType, target) {
		// Small offset "under wing" so missiles don't spawn inside the
		// fuselage. Uses the NPC's heading+pitch to place it ahead+below.
		const forwardOffsetM = -5;   // metres behind, so it trails momentarily
		const downOffsetM    = -3;
		const launch = {
			lon: npc.lon,
			lat: npc.lat,
			alt: npc.alt + downOffsetM,
		};
		const onKill = null; // NPC kills don't score for the player

		let projectile;
		if (weaponType === 'AIM-120') {
			projectile = new AIM120(
				this.scene, this.viewer, launch,
				npc.heading, npc.pitch, npc.speed,
				target, onKill, npc,
			);
		} else {
			projectile = new Missile(
				this.scene, this.viewer, launch,
				npc.heading, npc.pitch, npc.speed,
				target, onKill, npc,
			);
		}
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
