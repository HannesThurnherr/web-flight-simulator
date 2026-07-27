import * as Cesium from 'cesium';
import { pushKill } from './eventLog.js';
import { particles } from '../utils/particles.js';
import { getViewer } from '../world/cesiumWorld';

// ============================================================================
// Aircraft death sequence (burning spiral).
//
// Instead of a shot-down aircraft vanishing in an instant fireball, it goes
// through a short death throe: engine out, controls dead, tumbling and
// trailing oily black smoke for a couple of seconds before the airframe
// finally breaks up in a ground/air explosion.
//
// mortallyWound() is the single entry point every lethal-hit path calls. It
// returns:
//   true  → this unit is a dying-eligible aircraft; the death sequence has
//           been started (kill already logged, hit effect spawned). The
//           caller must NOT also destroy it or spawn the big explosion.
//   false → not an aircraft (ground unit, projectile, player). The caller
//           should fall through to its existing instant-kill path.
//
// The per-frame tumble + smoke + terminal explosion is driven in npcUpdate.js
// (it owns the NPC physics integration); this module only arms the state.
// ============================================================================

// A dying-eligible aircraft is an NPC with a flight model and a pilot that
// isn't a static ground emplacement. That excludes the player (no pilot),
// cruise missiles / projectiles (no physics), and SAM/AAA sites (isStatic).
function isAircraftNpc(unit) {
	return !!(unit && unit.physics && unit.pilot && !unit.isStatic);
}

// A ground vehicle / emplacement (SAM launcher, radar, gun, truck). Leaves a
// persistent burning wreck rather than just a one-shot blast.
function isGroundVehicle(unit) {
	return !!(unit && (unit.isStatic || unit.kind === 'ground'));
}

// ----------------------------------------------------------------------------
// Burning ground wrecks — a tall smoke column + base fire that linger at the
// spot a destroyed vehicle died. The vehicle mesh is removed on death (as
// before); these emitters keep the kill site visible from a distance.
// ----------------------------------------------------------------------------
const M_PER_DEG = 111320;
const _wrecks = [];
// With 20-minute lifetimes, a long strike could leave dozens of columns
// burning at once. Cap the live count (drop the oldest) so the steady-state
// particle load stays bounded on a big SEAD mission.
const MAX_WRECKS = 14;

export function spawnGroundWreck(lon, lat, alt, opts = {}) {
	if (_wrecks.length >= MAX_WRECKS) _wrecks.shift();
	_wrecks.push({
		lon, lat, alt,
		age: 0,
		// Smoke column lingers a long time — 20–25 minutes. (The alive
		// particle count is bounded by emission-rate × puff-life, so a long
		// ttl costs no more per-frame than a short one; it just persists.)
		ttl: opts.ttl ?? (1200 + Math.random() * 300),
		// Open flame only for the first couple of minutes; after that the
		// wreck smoulders — fire gone, smoke column carries on.
		fireDuration: opts.fireDuration ?? (90 + Math.random() * 90),
		smokeT: 0,
		fireT: 0,
		maxColumnH: opts.columnHeight ?? 320,    // metres — visible from afar
		// Gentle constant wind so the column leans and drifts with height.
		windE: (Math.random() - 0.5) * 7,
		windN: (Math.random() - 0.5) * 7,
	});
}

export function updateGroundWrecks(dt) {
	for (let i = _wrecks.length - 1; i >= 0; i--) {
		const w = _wrecks[i];
		w.age += dt;
		if (w.age >= w.ttl) { _wrecks.splice(i, 1); continue; }

		// Base fire — bright open flame for the first couple of minutes,
		// then the wreck smoulders (fire off, smoke continues).
		if (w.age < w.fireDuration) {
			w.fireT += dt;
			if (w.fireT >= 0.06) {
				w.fireT = 0;
				// Flame dwindles toward the end of the burn.
				const intensity = Math.max(0.3, 1 - w.age / w.fireDuration);
				try { particles.spawnFire(w.lon, w.lat, w.alt + 1.5, { count: Math.max(1, Math.round(3 * intensity)), size: 1.5 }); } catch (e) { /* optional */ }
			}
		}

		// Smoke column — puffs distributed up the height each tick (smoke's
		// own buoyancy won't climb hundreds of metres), widening and drifting
		// downwind with altitude. Long-lived puffs keep the tall column full
		// without a high spawn rate. Column ramps up over the first seconds.
		w.smokeT += dt;
		if (w.smokeT >= 0.07) {
			w.smokeT = 0;
			const colH = Math.min(w.maxColumnH, 50 + w.age * 80);
			const mLon = M_PER_DEG * Math.cos(w.lat * Math.PI / 180);
			for (let k = 0; k < 2; k++) {
				const f = Math.pow(Math.random(), 0.7);  // slight base bias
				const h = f * colH;
				const driftE = w.windE * f * 5;           // metres, grows with height
				const driftN = w.windN * f * 5;
				const lon = w.lon + driftE / mLon;
				const lat = w.lat + driftN / M_PER_DEG;
				try {
					particles.spawnSmoke(lon, lat, w.alt + h, {
						dark: true, count: 1,
						size: 2.5 + f * 8.0,   // widens going up
						life: 7.0 + f * 8.0,   // long-lived → fuller column, fewer spawns
					});
				} catch (e) { /* optional */ }
			}
		}
	}
}

export function mortallyWound(unit, info) {
	if (!unit) return false;
	if (unit.dying) return true;          // already going down — suppress re-kill / extra fireball
	if (unit.destroyed) return false;
	// The player isn't an NPC — there's no pilot/physics object ON the unit
	// (those live on ctx), so isAircraftNpc() rejects it. Give the human the
	// SAME burning-tumble death the AI flies: the sim loop drives the player's
	// wreck (chaotic stick into the same PlanePhysics) and raises the crash
	// menu when the airframe finally breaks up. Returning true tells the
	// caller NOT to also spawn the instant fireball — it comes at break-up.
	if (unit.isPlayer) {
		startPlayerDeath(unit, info);
		return true;
	}
	if (!isAircraftNpc(unit)) {
		// Ground vehicles leave a burning wreck (smoke column + fire), but
		// still take the caller's instant-kill + explosion path (return
		// false). Guard against double-registering on splash/chain hits.
		if (isGroundVehicle(unit) && !unit._wreckSpawned) {
			unit._wreckSpawned = true;
			spawnGroundWreck(unit.lon, unit.lat, unit.alt);
		}
		return false;
	}

	pushKill({
		shooter: info.shooter ?? null,
		target: unit,
		weapon: info.weapon ?? 'KILL',
		at: info.at ?? (performance.now() * 0.001),
		reason: info.reason ?? 'kill',
	});

	unit.dying = {
		elapsed: 0,
		// Time from hit to break-up varies a LOT — some snap apart almost
		// at once, others tumble for the better part of ten seconds. (A
		// ground impact ends it early regardless.)
		duration: 1.0 + Math.random() * 8.0,
		smokeT: 0,
		fireT: 0,
		// Chaotic over-driven tumble: stick commands at ~3× full deflection
		// that re-randomize every fraction of a second (driven in
		// npcUpdate). Seed an initial set so the first frame already flails.
		steerT: 0,
		pitchCmd: (Math.random() * 2 - 1) * 3,
		rollCmd: (Math.random() * 2 - 1) * 3,
		yawCmd: (Math.random() * 2 - 1) * 3,
	};
	unit.throttle = 0;
	unit.isBoosting = false;

	// Immediate hit feedback: a flash + sparks where the round struck, but
	// NOT the full fireball — that comes when the airframe finally fails.
	try {
		particles.spawnExplosion(unit.lon, unit.lat, unit.alt, { count: 14, smokeCount: 3, big: false });
		particles.spawnSpark(unit.lon, unit.lat, unit.alt, { count: 12 });
	} catch (e) { /* particles optional */ }

	return true;
}

// ============================================================================
// Player death — the human's version of the burning spiral.
//
// The AI tumble lives in npcUpdate.js because that module owns NPC physics.
// The player's physics integration lives in simLoop.js, so the per-frame
// tumble is driven THERE (it feeds tickPlayerDeath()'s chaotic stick into the
// same PlanePhysics). These two functions are the shared state machine:
//   startPlayerDeath() — arm the tumble (called from mortallyWound on a kill).
//   tickPlayerDeath()  — advance it one frame; returns the stick command and a
//                        `done` flag the sim loop watches to raise the crash menu.
// ============================================================================

// Arm the player's burning-tumble death. The player is flagged destroyed
// immediately (so enemy sensors drop the track and stop firing at the falling
// wreck), but the fall itself keeps running because the sim loop's player
// integration is gated on the FLYING game-state, not on `destroyed`.
export function startPlayerDeath(unit, info = {}) {
	if (unit.dying) return;
	pushKill({
		shooter: info.shooter ?? null,
		target:  unit,
		weapon:  info.weapon ?? 'KILL',
		at:      info.at ?? (performance.now() * 0.001),
		reason:  info.reason ?? 'kill',
	});
	unit.dying = {
		elapsed: 0,
		// Same widely-varied break-up timer the AI uses — some snap apart
		// quickly, others tumble most of the way down. A ground impact ends
		// it early regardless (checked in tickPlayerDeath).
		duration: 2.5 + Math.random() * 5.0,
		smokeT: 0, fireT: 0, steerT: 0,
		pitchCmd: (Math.random() * 2 - 1) * 3,
		rollCmd:  (Math.random() * 2 - 1) * 3,
		yawCmd:   (Math.random() * 2 - 1) * 3,
	};
	unit.destroyed = true;     // dead for sensors / NPC targeting (fall is FLYING-gated)
	unit.throttle = 0;
	unit.isBoosting = false;
	try {
		particles.spawnExplosion(unit.lon, unit.lat, unit.alt, { count: 14, smokeCount: 3, big: false });
		particles.spawnSpark(unit.lon, unit.lat, unit.alt, { count: 12 });
	} catch (e) { /* particles optional */ }
}

// Advance the player tumble one frame. Returns { pitch, roll, yaw, done }:
//   pitch/roll/yaw — over-driven (~3×) chaotic stick to feed PlanePhysics.
//   done           — true on the frame the airframe breaks up (the sim loop
//                    spawns nothing more; it just calls doCrashTransition).
// On break-up this spawns the big fireball + wreckage and flips the unit fully
// dead. The terminal 'explode' sound is left to doCrashTransition so it isn't
// played twice.
export function tickPlayerDeath(unit, dt) {
	const d = unit.dying;
	if (!d) return { pitch: 0, roll: 0, yaw: 0, done: true };
	d.elapsed += dt;

	// Dense oily smoke + trailing fire from the falling wreck.
	d.smokeT += dt;
	if (d.smokeT >= 0.03) {
		d.smokeT = 0;
		try { particles.spawnSmoke(unit.lon, unit.lat, unit.alt, { dark: true, count: 5, size: 2.2 }); } catch (e) { /* optional */ }
	}
	d.fireT += dt;
	if (d.fireT >= 0.03) {
		d.fireT = 0;
		try { particles.spawnFire(unit.lon, unit.lat, unit.alt, { count: 4, size: 1.0 }); } catch (e) { /* optional */ }
	}

	// Ground impact ends it early (auger-in), same as the AI wreck.
	let hitGround = false;
	const viewer = getViewer();
	if (viewer) {
		const th = viewer.scene.globe.getHeight(Cesium.Cartographic.fromDegrees(unit.lon, unit.lat));
		if (th != null && unit.alt <= th + 3) hitGround = true;
	}

	if (d.elapsed >= d.duration || hitGround) {
		try {
			particles.spawnExplosion(unit.lon, unit.lat, unit.alt, { count: 90, smokeCount: 22, big: true });
			particles.spawnWreckage(unit.lon, unit.lat, unit.alt, unit.heading, unit.pitch, { count: 48 });
		} catch (e) { /* optional */ }
		unit.dying = null;
		unit.destroyed = true;
		return { pitch: 0, roll: 0, yaw: 0, done: true };
	}

	// Re-randomize the over-driven tumble a few times a second so it flails
	// rather than settling into one clean spin.
	d.steerT += dt;
	if (d.steerT >= 0.22) {
		d.steerT = 0;
		d.pitchCmd = (Math.random() * 2 - 1) * 3;
		d.rollCmd  = (Math.random() * 2 - 1) * 3;
		d.yawCmd   = (Math.random() * 2 - 1) * 3;
	}
	return { pitch: d.pitchCmd, roll: d.rollCmd, yaw: d.yawCmd, done: false };
}
