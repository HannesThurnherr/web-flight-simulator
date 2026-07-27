// ============================================================================
// Interceptor endgame success rate.
//
// This is a HIT-rate model, not a lethality model. The number it produces
// decides whether an interceptor's guidance solves the endgame at all — it is
// consumed by Missile._aimPoint, which biases a doomed shot's aim point so the
// round physically sails past its target. It is NOT applied at the warhead:
// a RIM-116 that reaches a Harpoon destroys it, and "detonates on the target
// but the target flies on" is not a thing that happens.
//
// (An earlier version of this file did exactly that, and it was wrong. The
// probability is the same; where it's applied is the whole difference.)
//
// Guns don't use this at all. A CIWS misses because its rounds go past, which
// is modelled where it belongs — as barrel dispersion in the fire solution,
// see gunLead in npcPilots.js.
//
// WHY any of this exists: interception used to be deterministic, so a defended
// ship was effectively invulnerable — dozens of anti-ship missiles fired, zero
// leakers. It also produced two symptoms that looked like unrelated bugs:
//
//   - Mk 45 shells "falling massively short". They weren't falling short; the
//     target's CIWS was swatting every one of them over the water. (The
//     fire-control solution is fine — measured, the round actually flies
//     slightly FARTHER than the solver predicts.)
//   - A "magic bubble" around SAM batteries popping SDBs ~500 m out, in the
//     dive. That's a Tor/NASAMS point-defence intercept working perfectly
//     every single time.
//
// Real point defence is nothing like perfect, and it degrades sharply with
// closure speed: against a supersonic P-800 the engagement window is a third
// as long as against a Harpoon, and against a Mach 3.4 ballistic round in a
// terminal dive it's marginal. That speed dependence is the whole reason those
// weapons exist, so it's the axis this model is built on.
//
// Scope is deliberately narrow: interceptor-vs-MUNITION only. A SAM engaging
// an aircraft, or an anti-ship missile striking a hull, is untouched.
// ============================================================================

// Single-shot Pk for an interceptor MISSILE against a munition, by target
// class, before the speed penalty. A cruise missile is the design case for
// every one of these systems and is the most reliably killed; a ballistic
// round arrives from a much worse angle.
// Tuned against measured end-to-end leakage through a FULL stack (SM-6 salvo
// → RAM salvo → CIWS pass), not picked for plausibility in isolation: the
// layers compound, so per-shot numbers that each look reasonable multiply out
// to zero leakage. Target was ~10% for a subsonic sea-skimmer, rising steeply
// with speed — see the table in speedFactor.
const MISSILE_PK_BY_CLASS = {
	cruise_missile: 0.30,
	bomb: 0.26,
	missile: 0.22,
};

// Closure-speed penalty. The engagement window shrinks with speed and the
// intercept geometry gets worse, so the fast movers are much harder.
function speedFactor(speedMps) {
	if (speedMps > 900) return 0.30;   // ballistic / hypersonic terminal
	if (speedMps > 600) return 0.50;   // supersonic sea-skimmer (P-800)
	if (speedMps > 400) return 0.75;
	return 1.0;                        // subsonic (Harpoon, Tomahawk, shells)
}

// Per-interceptor quality multiplier. Everything defaults to 1; the SM-6 is
// singled out because it is the fleet's only round with a genuine shot at a
// ballistic target, and a purpose-built ABM-capable interceptor with a large
// frag warhead and a wide-gimbal active seeker should not be graded the same
// as a short-range point-defence missile. Without this the reserve doctrine
// is hollow: holding cells back for a threat you can't hit anyway is just a
// slower way to lose the ship.
const INTERCEPTOR_QUALITY = {
	'SM-6': 1.8,
};

// Probability that this interceptor kills this target outright.
// Returns 1 for anything that isn't a munition, so non-munition engagements
// keep their existing deterministic behaviour.
export function interceptKillProbability(weaponType, target) {
	const cls = target && target.signature && target.signature.unitClass;
	if (!cls || !(cls in MISSILE_PK_BY_CLASS)) return 1;

	const base = MISSILE_PK_BY_CLASS[cls];

	// Quality softens the SPEED penalty rather than multiplying the base. That
	// distinction matters: a better interceptor's advantage is that it copes
	// with a fast, steeply-diving target, not that it is better at killing a
	// subsonic one — everything kills those. Scaling the base instead made the
	// SM-6 a 0.54 round against a Harpoon and collapsed sea-skimmer leakage
	// back to ~4%, undoing the balance it was meant to leave alone.
	const quality = INTERCEPTOR_QUALITY[weaponType] || 1;
	const sf = Math.pow(speedFactor(target.speed || 0), 1 / quality);
	return Math.max(0, Math.min(1, base * sf));
}

// Roll it. Split from the probability so the number stays testable without
// consuming randomness.
export function interceptSucceeds(weaponType, target) {
	const pk = interceptKillProbability(weaponType, target);
	return pk >= 1 || Math.random() < pk;
}
