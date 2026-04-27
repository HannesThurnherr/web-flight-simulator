// ============================================================================
// Munition factory.
//
// Central dispatch point for spawning an in-flight projectile from a
// munition id (e.g. "aim-120d", "aim-9x"). Decouples callers from
// knowing which concrete class implements which seeker — they just
// say "give me a live one of this munition" and the factory picks
// the right implementation based on the JSON's `seekerType` field.
//
// Adding a new munition variant (AIM-120B, PL-15, R-77) with an
// existing seeker type = drop a JSON in src/data/munitions/, done.
// Adding a genuinely new seeker (HARM, LGB, JDAM, cruise) = write
// one new strategy class and register it below.
//
// Current mapping:
//   "active_radar" → AIM120 class (active radar seeker + datalink + pitbull)
//   "ir"           → Missile class (legacy reticle / rosette IR seeker)
//   "iir"          → Missile class (focal-plane-array imaging IR seeker —
//                     same guidance pipeline as 'ir'; the per-munition
//                     `seeker.flareResistance` is what makes the IIR
//                     variant flare-resistant in Missile._irRecheck)
//
// Future:
//   "anti_radiation" → HARMSeeker class (passive emitter homing)
//   "laser"          → LGBSeeker class (laser spot rider)
//   "gps"            → GPSSeeker class (waypoint-based)
//   "null"           → DumbProjectile class (no guidance)
// ============================================================================

import { MUNITIONS } from './munitions.js';
import { Missile } from './missile.js';
import { AIM120 } from './aim120.js';
import { NullSeeker }         from './seekers/NullSeeker.js';
import { GPSSeeker }          from './seekers/GPSSeeker.js';
import { LaserSeeker }        from './seekers/LaserSeeker.js';
import { AntiRadiationSeeker } from './seekers/AntiRadiationSeeker.js';

export function createMunition(
	munitionId,
	scene, viewer, launchPos, heading, pitch, speed,
	target = null, onKill = null, launcher = null,
) {
	const data = MUNITIONS[munitionId];
	if (!data) {
		console.warn(`[munitionFactory] unknown munition id: ${munitionId}`);
		return null;
	}
	const seeker = data.seekerType || 'ir';
	const args = [scene, viewer, launchPos, heading, pitch, speed, target, onKill, launcher, data];
	switch (seeker) {
		// Production seekers — fully-implemented, driven by data.
		case 'active_radar':   return new AIM120(...args);
		case 'ir':             return new Missile(...args);
		case 'iir':            return new Missile(...args);
		// Placeholder seekers — stub classes in src/weapon/seekers/*.
		// They fly ballistic for now and log a warning on construction.
		// Replace with real guidance logic per each file's TODO block.
		case 'null':            return new NullSeeker(...args);
		case 'gps':             return new GPSSeeker(...args);
		case 'laser':           return new LaserSeeker(...args);
		case 'anti_radiation':  return new AntiRadiationSeeker(...args);
		default:
			console.warn(`[munitionFactory] unknown seeker type "${seeker}" for munition ${munitionId}`);
			return null;
	}
}

// Convenience: given a weaponSystem-style simType ("AIM-120" / "AIM-9"),
// return the first munition id that claims that simType. Lets the weapon
// system stay in the simType abstraction without tracking which specific
// variant is loaded (the loadout system provides that granularity when
// the user cares).
export function munitionIdForSimType(simType) {
	for (const [id, m] of Object.entries(MUNITIONS)) {
		if (m.simType === simType) return id;
	}
	return null;
}
