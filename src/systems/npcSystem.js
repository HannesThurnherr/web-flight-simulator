import * as THREE from 'three';
import * as Cesium from 'cesium';
import { movePosition } from '../utils/math';
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

export class NPCSystem {
	constructor(viewer, scene, loader) {
		this.viewer = viewer;
		this.scene = scene;
		this.loader = loader;
		this.npcs = [];
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
	}

	spawnNPC(playerLon, playerLat, playerAlt) {
		if (!this.loaded) return null;

		const angle = Math.random() * Math.PI * 2;
		const dist = 5000 + Math.random() * 15000;

		const lonOffset = (dist * Math.cos(angle)) / (111320 * Math.cos(Cesium.Math.toRadians(playerLat)));
		const latOffset = (dist * Math.sin(angle)) / 111320;

		const name = this.npcNames[Math.floor(Math.random() * this.npcNames.length)] + ' ' + (100 + Math.floor(Math.random() * 900));

		const lon = playerLon + lonOffset;
		const lat = playerLat + latOffset;
		const alt = Math.max(playerAlt + (Math.random() - 0.5) * 1000, 1500);

		return this.createNPCMesh(name, lon, lat, alt, Math.random() * 360, 250 + Math.random() * 100);
	}

	createNPCMesh(name, lon, lat, alt, heading, speed) {
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
			behaviorTimer: 5 + Math.random() * 10,
			terrainCheckTimer: Math.random() * 2,
			time: Math.random() * 100,
			// Combat metadata. Team lets the sensor system pick out hostile
			// vs friendly returns; signature controls how detectable this
			// NPC is; sensors are its own perception suite (used by the
			// AI in a later pass).
			team: 'hostile',
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

	update(dt, playerState, simTime = 0) {
		if (!this.loaded) return;

		const viewMatrix = this.viewer.camera.viewMatrix;

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
			p.update(dt, targetList);
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
				npc.pilot.update({
					unit: npc,
					now:  simTime,
					terrainHeight: npc._cachedTerrainH,
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
						this._spawnNpcMissile(npc, cmd.weaponType, cmd.weaponTarget);
					}
				}
			}

			let headingDiff = npc.targetHeading - npc.heading;
			while (headingDiff < -180) headingDiff += 360;
			while (headingDiff > 180) headingDiff -= 360;

			// Turn rate: cruise 30°/s, boost 120°/s. 120 approximates a 9-G
			// break at corner speed — the kind of rate needed for a
			// last-ditch defensive turn to look dramatic.
			const baseTurnRate  = 30;
			const boostTurnRate = 120;
			const maxTurnRate = npc.isBoosting ? boostTurnRate : baseTurnRate;
			const maxTurnThisStep = maxTurnRate * dt;
			const headingChange = Math.max(-maxTurnThisStep, Math.min(maxTurnThisStep, headingDiff));
			npc.heading = (npc.heading + headingChange + 360) % 360;

			// Pitch: rate-limited instead of proportional, so a commanded
			// −30° dive actually arrives in ~0.7s at boost rate rather than
			// taking 5s to converge via a 0.6/s lerp.
			const pitchDiff = npc.targetPitch - npc.pitch;
			const maxPitchRate = npc.isBoosting ? 45 : 20; // deg/s
			const maxPitchStep = maxPitchRate * dt;
			npc.pitch += Math.max(-maxPitchStep, Math.min(maxPitchStep, pitchDiff));

			// Speed actually responds to throttle/AB now. Turbofans take
			// seconds to spool; first-order lerp with a ~7s time constant
			// feels about right. This is what makes "firewall AB to evade"
			// kinematically meaningful instead of cosmetic.
			const cmdSpeed = (npc.pilot && npc.pilot.command && npc.pilot.command.targetSpeed) ||
				(npc.isBoosting ? 500 : 300);
			const speedRate = npc.isBoosting ? 0.25 : 0.12;
			npc.speed += (cmdSpeed - npc.speed) * dt * speedRate;
			if (npc.speed < 80) npc.speed = 80;

			let desiredRoll = 0;
			if (Math.abs(headingDiff) > 0.5) {
				const turnDir = Math.sign(headingDiff);
				const intensity = Math.min(1, Math.abs(headingDiff) / 45);
				desiredRoll = -turnDir * 90 * intensity;
			}
			const rollLerpSpeed = 3.0;
			npc.roll += (desiredRoll - npc.roll) * Math.min(1, dt * rollLerpSpeed);
			npc.roll = Math.max(-90, Math.min(90, npc.roll));

			const newPos = movePosition(npc.lon, npc.lat, npc.alt, npc.heading, npc.pitch, npc.speed * dt);
			npc.lon = newPos.lon;
			npc.lat = newPos.lat;
			npc.alt = newPos.alt;

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

		if (this.npcs.length < 3 && Date.now() - this.lastSpawnTime > 5000) {
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
	}

	clear() {
		this.npcs.forEach(npc => {
			this.scene.remove(npc.mesh);
		});
		this.npcs = [];
		this.projectiles = [];
	}
}
