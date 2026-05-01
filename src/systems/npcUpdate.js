// ============================================================================
// NPC per-frame update loop.
//
// Runs every frame from main.js via npcSystem.update(dt, playerState, simTime).
// Owns everything that happens to an NPC during a tick:
//   - Drains the deferred-spawn queue (platforms whose GLB wasn't ready
//     at scenario onStart).
//   - Publishes every live unit's radar contacts to its team datalink,
//     then ages the shared fused picture.
//   - Ticks in-flight flares and projectiles (both NPC and SAM).
//   - Per-NPC: terrain AGL sample, one-shot ground-clamp (static
//     units), pilot tick + weapon/flare fire gating, autopilot +
//     PlanePhysics integration, terrain-collision destruction, mesh
//     matrix bake.
//   - Auto-reinforcement spawn (capped count + min interval).
//
// Extracted from npcSystem.js so the class file stays focused on
// spawning / teardown. Exported as a free function taking the
// NPCSystem instance as first arg.
// ============================================================================

import * as Cesium from 'cesium';
import { advanceLonLatAlt } from '../plane/aeroModel.js';
import { Flare } from '../weapon/flare.js';
import { pushKill } from './eventLog.js';
import { particles } from '../utils/particles.js';
import { soundManager } from '../utils/soundManager.js';
import { getTeamDatalink, tickAllDatalinks } from './teamDatalink.js';
import { isRadiating } from './sensorSystem.js';
import { applyNpcMeshMatrix } from './npcRendering.js';
import { tickFormationModes } from './formation.js';
import { Contrail } from '../plane/contrail.js';

// Strike-class simTypes: any munition that takes a designation queue
// point. When a wingman's combined ammo across these types hits zero,
// they auto-break formation into the configured patrol mode (RTB/CAP).
// AAMs (AIM-9, AIM-120, METEOR) are NOT strike-class — a wingman with
// AAMs left is still useful as a dedicated escort and stays in slot.
const STRIKE_SIMTYPES = [
	'GBU-12', 'GBU-31', 'GBU-38', 'GBU-39',
	'AGM-86', 'STORM-SHADOW', 'AGM-88',
];

export function npcSystemUpdate(sys, dt, playerState, simTime = 0) {
	if (!sys.loaded) return;

	// Retry any platform spawns that were deferred because their
	// model template hadn't finished loading yet. Template loads are
	// async and independent; a scenario's onStart can fire before the
	// GLB response lands, especially for the larger ground-vehicle
	// assets. Re-queue any that still fail so the retry is idempotent.
	if (sys._pendingPlatformSpawns && sys._pendingPlatformSpawns.length > 0) {
		const retry = sys._pendingPlatformSpawns;
		sys._pendingPlatformSpawns = [];
		for (const p of retry) {
			sys.spawnPlatform(p.platformId, p.lon, p.lat, p.alt, p.team, p.pilotOverrides, p.onSpawn);
		}
	}

	const viewMatrix = sys.viewer.camera.viewMatrix;

	// Team datalink — publish every radar-equipped team-mate's
	// contacts into the shared store so the AI can see bogeys that
	// only wingmen / AWACS have painted, and can deconflict
	// engagements. Player publishes too (for symmetry; a future
	// friendly-wingman would benefit). Ticked once here to age out
	// stale entries. Dead player doesn't publish.
	if (playerState && playerState.team && !playerState.destroyed) {
		const dl = getTeamDatalink(playerState.team);
		if (dl) dl.publishContacts(playerState, simTime);
	}
	for (const npc of sys.npcs) {
		if (!npc || npc.destroyed || !npc.team) continue;
		const dl = getTeamDatalink(npc.team);
		if (dl) dl.publishContacts(npc, simTime);
	}

	// ELINT pass: passive theater-wide emitter detection. Any
	// hostile unit currently radiating gets published to the friendly
	// team's intelContacts. Republished each tick — when the emitter
	// goes EMCON the entry expires after ELINT_MEMORY seconds and
	// disappears from the planner. Range-unlimited because real
	// strategic ELINT (Cobra Ball, EP-3, MASINT sats) sees emitters
	// across continents; the realism here is "you only see what's
	// actively emitting," not a distance gate.
	const friendlyDl = getTeamDatalink('friendly');
	if (friendlyDl) {
		for (const npc of sys.npcs) {
			if (!npc || npc.destroyed) continue;
			if (npc.team === 'friendly') continue;
			if (!isRadiating(npc)) continue;
			friendlyDl.publishElint(npc, simTime);
		}
	}

	tickAllDatalinks(simTime);

	// Phase 5.5 — formation mode upkeep. Auto-switches any wingman
	// whose strike-class ammo has exhausted into the configured
	// break behavior (RTB / CAP). Cheap (~3 npcs * a few weapons),
	// fine to run every frame.
	tickFormationModes(STRIKE_SIMTYPES);

	// Age any in-flight flares spawned by NPC evasion (reuses the
	// same Flare class the player uses).
	if (sys.flares) {
		for (let i = sys.flares.length - 1; i >= 0; i--) {
			const f = sys.flares[i];
			f.update(dt);
			if (!f.active) sys.flares.splice(i, 1);
		}
	}

	// Update NPC-fired missiles. Target list = player + all NPCs; each
	// missile filters out its own team and launcher internally. The
	// player gets a `destroyed` flag when an incoming missile hits
	// it, which main.js acts on to trigger the crash/respawn
	// transition.
	//
	// Include the player's OWN projectiles in the target list too —
	// without this, NPC SAM missiles can't actually hit inbound
	// player cruise missiles (the swept-segment hit-check inside
	// each missile iterates `targets`, which previously only had
	// player + NPCs). The team filter inside missile.update keeps
	// SAMs from accidentally killing other friendly missiles.
	const playerProjs = (playerState && playerState.weaponSystem && playerState.weaponSystem.projectiles)
		|| [];
	const targetList = [playerState, ...sys.npcs, ...playerProjs];
	for (let i = sys.projectiles.length - 1; i >= 0; i--) {
		const p = sys.projectiles[i];
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
		if (!p.active && !hasTrail) sys.projectiles.splice(i, 1);
	}

	for (let i = sys.npcs.length - 1; i >= 0; i--) {
		const npc = sys.npcs[i];
		if (npc.destroyed) {
			sys.scene.remove(npc.mesh);
			// Dispose the contrail's puff meshes / materials so we
			// don't leak GPU buffers when many NPCs are spawned
			// over a long session. Existing trail behind the dead
			// NPC vanishes immediately — slightly less realistic
			// than letting it linger, but cheaper and the airframe
			// blowing up is its own visual cue.
			if (npc._contrail) { npc._contrail.dispose(); npc._contrail = null; }
			sys.npcs.splice(i, 1);
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
			const terrainHeight = sys.viewer.scene.globe.getHeight(cartographic);
			if (terrainHeight !== undefined) npc._cachedTerrainH = terrainHeight;
		}

		// One-shot ground clamp for static ground units. Runs BEFORE
		// the pilot tick so the first-frame decision uses the
		// correct altitude. Tries two height sources in order:
		//   1. the async sampleTerrainMostDetailed result stashed at
		//      spawn time (authoritative, forces tile load)
		//   2. globe.getHeight() against the currently-loaded tile
		//      (cheap, returns undefined if the tile isn't loaded)
		// Whichever resolves first wins; subsequent frames retry
		// until one does.
		if (npc.isStatic && npc._needsGroundClamp) {
			let h;
			if (sys._pendingGroundHeight && sys._pendingGroundHeight.has(npc.name)) {
				h = sys._pendingGroundHeight.get(npc.name);
				sys._pendingGroundHeight.delete(npc.name);
			}
			if (h == null) {
				const carto = Cesium.Cartographic.fromDegrees(npc.lon, npc.lat);
				const g = sys.viewer.scene.globe.getHeight(carto);
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
			// maxInFlight, which produces shoot-look-shoot rather
			// than magazine-dump-in-one-burst behaviour.
			const playerProjs = (playerState && playerState.weaponSystem &&
				playerState.weaponSystem.projectiles) || [];
			const ctxProjectiles = playerProjs.concat(sys.projectiles);

			npc.pilot.update({
				unit: npc,
				now:  simTime,
				dt,
				terrainHeight: npc._cachedTerrainH,
				projectiles: ctxProjectiles,
				teamDatalink: getTeamDatalink(npc.team),
			}, dt);
			const cmd = npc.pilot.command;
			npc.targetHeading = cmd.targetHeading;
			npc.targetPitch   = cmd.targetPitch;
			npc.throttle      = cmd.throttle;
			npc.isBoosting    = cmd.boost;

			// Phase 3c — radar mode management. NPC radar sits in 'search'
			// (= TWS in our naming) most of the time, briefly flashes to
			// 'track' (= STT) when the EngageBehavior commits to a Fox-3
			// shot, and stays in track while any of its own active-radar
			// missiles is in flight (datalink support phase). Once both
			// commit and missile-in-flight are gone, drops back to TWS.
			// Player RWR sees the difference via `lockType` on the
			// contact's RWR entry.
			if (npc.sensors && npc.sensors.radar) {
				const commitAt = npc.pilot._sttCommitAt;
				const inCommit = (commitAt != null) && (simTime - commitAt) < 5;
				let hasLiveRadarMsl = false;
				for (const p of ctxProjectiles) {
					if (!p || !p.active) continue;
					if (p.launcher !== npc) continue;
					if (p.type === 'AIM-120' || p.type === 'METEOR' || p.type === 'NASAMS-MSL' || p.type === 'TOR-MSL' || p.type === 'R-77' || p.type === 'R-37M') {
						hasLiveRadarMsl = true;
						break;
					}
				}
				npc.sensors.radar.mode = (inCommit || hasLiveRadarMsl) ? 'track' : 'search';
			}

			// Flare release is gated by the countermeasure subsystem
			// (inventory + burst cooldown). Real CMDS dispense in
			// programmed bursts — one trigger pull fires a 4-round
			// salvo. Behaviors set fireFlare on the standard ~1.5 s
			// cadence; each one consumes up to 4 cartridges, magazines
			// drain accordingly. F-15 ALE-45 loadouts are 60 cartridges,
			// so a sustained engagement can easily run a jet dry.
			if (cmd.fireFlare) {
				const cm = npc.pilot.subsystems.countermeasures;
				if (cm) {
					const n = cm.consumeFlareBurst(simTime, 4);
					if (n > 0) {
						if (!sys.flares) sys.flares = [];
						for (let i = 0; i < n; i++) {
							sys.flares.push(new Flare(
								sys.scene, sys.viewer,
								{ lon: npc.lon, lat: npc.lat, alt: npc.alt },
								npc.heading, npc.pitch, npc.speed,
							));
						}
					}
				}
			}

			// Weapon release is also gated by the WeaponSubsystem,
			// which owns ammo + fire cooldown. The EngageBehavior
			// only declares intent (fireWeapon + weaponType +
			// weaponTarget); the subsystem decides whether this
			// click counts.
			if (cmd.fireWeapon && cmd.weaponType && cmd.weaponTarget) {
				const ws = npc.pilot.subsystems.weapons;
				const picked = ws && ws.weapons.find(w => w.type === cmd.weaponType);
				if (ws && ws.consume(picked, simTime)) {
					if (cmd.weaponType === 'gun') {
						// Gun fire takes a different path: no
						// seeker, no datalink registration — it's
						// ballistic and unguided. Each "consume"
						// slot produces a single tracer round; the
						// pilot's high fireRate turns this into a
						// steady stream while the EngageBehavior (or
						// AAA pilot) keeps the aim on the pipper.
						//
						// Static AAA pilots (ZSU-23, etc.) write
						// cmd.gunHeading / cmd.gunPitch each tick
						// with their lead solution — the chassis
						// doesn't rotate, only the turret does, so
						// the bullet exits along the lead vector
						// rather than the unit's body forward. For
						// fighter pilots these fields are absent and
						// the bullet defaults to body-forward.
						const aim = (cmd.gunHeading != null || cmd.gunPitch != null)
							? { heading: cmd.gunHeading, pitch: cmd.gunPitch }
							: null;
						sys._spawnNpcBullet(npc, aim);
					} else {
						const projectile = sys._spawnNpcMissile(npc, cmd.weaponType, cmd.weaponTarget);
						// Register with the team datalink so
						// wingmen don't immediately double-up on
						// the same bogey. Cleared when the
						// missile's active flag flips (above).
						if (projectile && npc.team) {
							const dl = getTeamDatalink(npc.team);
							if (dl) dl.registerEngagement(npc, projectile, cmd.weaponTarget, simTime);
						}
					}
				}
			}
		}

		// ---- Static ground platforms (SAM sites, ground radars):
		// skip the whole flight-physics + terrain-collision block.
		// They don't move and they don't fall. The one-shot terrain
		// clamp happened earlier in the loop; here we just pin the
		// kinematic fields the downstream renderer / sensor code
		// expects.
		if (npc.isStatic) {
			// Speed 0 means sensorSystem's Doppler-notch filter
			// would reject anyone trying to detect us — not a
			// problem for a ground unit. Heading/pitch stay at
			// whatever the platform was placed with (default 0).
			npc.speed   = 0;
			npc.roll    = 0;
			npc.isBoosting = false;
		} else {
			// ---- Autopilot: AI "I want heading X / pitch Y" →
			// stick input. PlanePhysics takes the same input shape
			// the player's stick produces: { pitch, roll, yaw,
			// throttle, boost }, each of pitch/roll/yaw in [-1, 1].
			// We synthesize those from the pilot's desired-heading
			// /desired-pitch targets:
			//
			//   - Heading error → desired bank angle
			//     (proportional, saturated at ±70°). Bank error →
			//     roll stick.
			//   - Pitch error → pitch stick directly (saturated).
			//   - Yaw left at 0; the aero model handles
			//     coordination through sideslip + lateral stability.
			//
			// Everything else (turn rate, roll rate, stall,
			// G-limit, drag penalty on hard turns, throttle spool-
			// up) is the same aero code the player aircraft runs,
			// so the NPC can never out-maneuver what the player can
			// physically do.
			let headingErr = npc.targetHeading - npc.heading;
			while (headingErr < -180) headingErr += 360;
			while (headingErr > 180) headingErr -= 360;

			const MAX_BANK = 70;                    // degrees
			const BANK_GAIN = MAX_BANK / 40;        // sat at ±40° heading err
			const desiredBank = Math.max(-MAX_BANK, Math.min(MAX_BANK, headingErr * BANK_GAIN));
			// Shortest-path roll: an inverted NPC at +160° asked to bank
			// to +30° should roll the short way (-50° via 0°) rather
			// than the long way (+230° around through inverted again).
			// Without the wrap, NPCs that fell into negative-roll
			// territory would corkscrew on their backs forever instead
			// of rolling upright.
			const curRoll = npc.roll || 0;
			let bankErr = desiredBank - curRoll;
			while (bankErr < -180) bankErr += 360;
			while (bankErr >  180) bankErr -= 360;
			const rollStickRaw = Math.max(-1, Math.min(1, bankErr * 0.04));
			// Stick-rate limiter. Without this the AI can slam the
			// stick from +1 to -1 in a single frame whenever a
			// behavior changes the heading target — an unnatural
			// "instant reversal" that real pilots can't physically
			// produce. Cap stick rate at ~3.0 per second (full
			// deflection in ~0.3 s, faster than a human but
			// physically feasible) so even a 180° heading flip
			// produces a smooth bank reversal instead of a snap.
			const prevRoll  = (npc._prevRollStick  != null) ? npc._prevRollStick  : 0;
			const prevPitch = (npc._prevPitchStick != null) ? npc._prevPitchStick : 0;
			const STICK_RATE = 3.0; // 1/s
			const maxStep = STICK_RATE * dt;
			const rollStick = Math.max(prevRoll - maxStep,
				Math.min(prevRoll + maxStep, rollStickRaw));
			npc._prevRollStick = rollStick;

			// Coordinated-turn pitch — the "pull G into the turn"
			// model. Real pilots NEVER push negative G to descend in
			// a turn; they roll into the bank, pull positive stick,
			// and the lift vector (now angled by the bank) curves the
			// flight path both laterally and slightly downward. The
			// autopilot was directly comparing world-frame pitch
			// targets to current pitch and pushing forward stick when
			// it wanted to lose altitude — exactly the "roll wrong-
			// way, then pitch down" pathology the player observes.
			//
			// New scheme: stick = pitchErr correction + a baseline
			// "coordinated-turn pull" that grows with bank angle.
			// In any bank, the load factor needed for level flight is
			// 1/cos(bank); we add (1/cos(bank) − 1) × 0.4 as a stick
			// bias, so a 60° bank baselines at +0.4 stick (≈ 2 G turn).
			// Negative stick is hard-capped at −0.3 universally — a
			// small forward push is allowed for shallow descent on
			// straight-and-level, but the AI never produces an
			// uncomfortable / unrealistic negative-G pushover.
			const rollAbs = Math.abs(curRoll);
			const bankRad = Math.max(-Math.PI / 2.2,
				Math.min(Math.PI / 2.2, curRoll * Math.PI / 180));
			const cosBank = Math.max(0.2, Math.cos(bankRad));
			const coordPull = Math.max(0, (1 / cosBank) - 1) * 0.4;
			const pitchErrDeg = (npc.targetPitch || 0) - (npc.pitch || 0);
			let pitchStickRaw = pitchErrDeg * 0.15 + coordPull;
			pitchStickRaw = Math.max(-0.3, Math.min(1, pitchStickRaw));
			// Inverted / heavily rolled → don't pull positive G; the
			// lift vector points at the ground. Cap upward stick so
			// the airplane rolls upright before it resumes loading.
			if (rollAbs > 100) pitchStickRaw = Math.min(0.2, pitchStickRaw);
			// Same rate-limit story as roll. A clean pull-up shouldn't
			// be a single-frame stick slam.
			const pitchStick = Math.max(prevPitch - maxStep,
				Math.min(prevPitch + maxStep, pitchStickRaw));
			npc._prevPitchStick = pitchStick;

			// AB discipline: behaviours like to firewall the throttle
			// + boost during evasion, gun chases, and terrain pull-ups.
			// Cap AB by speed — once you're past Mach 1.4-ish there's
			// no aerodynamic benefit to staying lit, and continuously
			// burning AB at top speed is what the player perceives as
			// "they always have AB on." This trims the high-speed tail
			// without affecting the transient bursts where AB matters.
			let useBoost = !!npc.isBoosting;
			if (useBoost && (npc.speed || 0) > 480) useBoost = false;

			const input = {
				pitch:    pitchStick,
				roll:     rollStick,
				yaw:      0,
				throttle: (npc.throttle != null) ? npc.throttle : 0.75,
				boost:    useBoost,
			};

			// Feed PlanePhysics the current altitude so its density
			// / thrust model is accurate at the NPC's flight level.
			npc.physics.currentAltitude = npc.alt;
			const pr = npc.physics.update(input, dt);

			// Mirror the physics state back onto the NPC fields the
			// rest of the system reads (sensors, AI, HUD, cesium
			// transform).
			npc.heading = pr.heading;
			npc.pitch   = pr.pitch;
			npc.roll    = pr.roll;
			npc.speed   = pr.speed;
			npc.isBoosting = pr.isBoosting;

			// Position integration uses the physics velocity vector
			// directly (same path as the player in main.js). This
			// lets sideslip / G-induced drift actually show up in
			// world position, instead of forcing motion to track
			// the body's forward axis the way the old movePosition
			// () call did.
			const velENU = npc.physics.velocity; // THREE.Vector3 in m/s ENU
			const newPos = advanceLonLatAlt(npc.lon, npc.lat, npc.alt, velENU, dt);
			npc.lon = newPos.lon;
			npc.lat = newPos.lat;
			npc.alt = newPos.alt;

			// Terrain collision — previously the kinematic
			// integrator happily drove NPCs straight through ridges
			// because nothing enforced ground contact. Sample
			// terrain height at the just-integrated position and,
			// if the NPC is at or below it, detonate the aircraft
			// (same effect as a missile hit). The 2 Hz cached
			// height is used as a fast fallback so we don't spam
			// getHeight(), and a fresh direct sample runs only when
			// we're close enough to the cached surface to possibly
			// be in trouble — CPU-cheap in the common "high-
			// altitude cruise" case and authoritative when it
			// matters. Static ground units skip this entirely —
			// they're SUPPOSED to sit on the ground and would blow
			// up instantly otherwise.
			if (!npc.destroyed) {
				let terrainH = npc._cachedTerrainH;
				const maybeCloseToGround = terrainH === undefined ||
					npc.alt < terrainH + 300;
				if (maybeCloseToGround) {
					const carto = Cesium.Cartographic.fromDegrees(npc.lon, npc.lat);
					const h = sys.viewer.scene.globe.getHeight(carto);
					if (h !== undefined) {
						terrainH = h;
						npc._cachedTerrainH = h;
					}
				}
				if (terrainH !== undefined && npc.alt <= terrainH + 3) {
					// Mark destroyed; the top-of-loop cleanup
					// block will remove the mesh next iteration.
					// Emit wreckage + explosion effects so the
					// kill reads visually the same as an air-to-
					// air kill.
					pushKill({
						shooter: 'TERRAIN',
						target:  npc,
						weapon:  'TERRAIN',
						at:      performance.now() * 0.001,
						reason:  'crash',
					});
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

		applyNpcMeshMatrix(sys, npc, viewMatrix);

		if (npc.mixer) {
			npc.mixer.update(dt);
		}

		// Phase 8 — contrails for airborne NPCs. Lazy-allocated per
		// NPC; the Contrail itself gates emission on alt + speed, so
		// low-flying CAS / strikers don't trail. Skip static ground
		// platforms and missiles entirely (ground SAMs aren't going
		// to hit the contrail ceiling, and missile trails come from
		// the missile's own updateTrail path).
		if (!npc.isStatic && (npc.kind || 'airborne') === 'airborne') {
			if (!npc._contrail) npc._contrail = new Contrail(sys.scene, sys.viewer);
			npc._contrail.update(dt, npc);
		}
	}

	// Spawn logic: while the live NPC count is below maxNpcs, queue
	// a fresh one every spawnInterval ms. Doubled from the defaults
	// (max 3, every 5s) to produce a denser battlefield — more
	// faction-on-faction engagements to watch, more opportunities
	// for the player to pick sides.
	if (sys.autoSpawn && sys.npcs.length < 6 && Date.now() - sys.lastSpawnTime > 2500) {
		sys.spawnNPC(playerState.lon, playerState.lat, playerState.alt);
		sys.lastSpawnTime = Date.now();
	}
}
