import { pushKill } from './eventLog.js';
import { particles } from '../utils/particles.js';

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
	if (!unit || unit.destroyed) return false;
	if (unit.dying) return true;          // already going down — suppress re-kill
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
