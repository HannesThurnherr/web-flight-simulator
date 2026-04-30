// ============================================================================
// Jammer subsystem — Phase 6e.1.
//
// One JammerSubsystem instance lives on each unit whose platform JSON
// declares a `jammer` block. The subsystem holds:
//
//   config       static spec from JSON (power, beamCount, coneHalfDeg,
//                burnThroughRangeM, type)
//   defensiveOn  toggleable wide-area self-protective broadcast
//   offensiveTargets  Set of victim units the jammer is beam-pointing at
//                (populated in 6e.2 — empty for now)
//
// The host of a jammer is its protected aircraft. A jammer with
// `defensiveOn === true` continuously emits an omnidirectional noise
// floor that drops hostile radar range against the host. Each entry in
// `offensiveTargets` consumes one "beam" of capacity (max beamCount);
// the beam broadcasts a narrower cone toward that victim and degrades
// any radar return from anything inside that cone segment from the
// victim's POV (6e.2).
//
// 6e.1 ships only the defensive bubble — that's enough to feel "I'm
// being jammed" from the receive side. Offensive engagement, comms
// jamming, HARM-attraction logic land in 6e.2 / 6e.4.
//
// Module-level pattern: sensorSystem.detectRadar() is called from many
// places (sensor scan, missile seekers, AI), so threading a units-list
// through every call signature is messy. Instead, updateSensors() calls
// setJammerRegistry(units) once per frame, and detectRadar reads from
// that snapshot. The registry is a small filtered array so the inner
// loop is cheap.
// ============================================================================
import * as Cesium from 'cesium';

// Per-tick snapshot of (alive, active) jammer-bearing units, set by
// updateSensors. Read by accumulateJamAttenuation. Cleared between
// frames so a stopped sim doesn't keep stale references alive.
let _registry = null;

export function setJammerRegistry(units) {
	if (!units || !units.length) { _registry = null; return; }
	_registry = [];
	for (const u of units) {
		if (!u || !u.jammer) continue;
		if (u.destroyed || u.active === false) continue;
		// Prune dead/inactive entries from offensiveTargets so the
		// registry doesn't keep emitting at corpses. WeaponSystem
		// already drops the *designation* when the victim dies, but
		// the persisted beam list lives on the jammer itself and
		// would otherwise stay populated until the player toggles it
		// off manually.
		if (u.jammer.offensiveTargets && u.jammer.offensiveTargets.size > 0) {
			for (const v of [...u.jammer.offensiveTargets]) {
				if (!v || v.destroyed || v.active === false) {
					u.jammer.offensiveTargets.delete(v);
				}
			}
		}
		// A jammer is on the registry if it's broadcasting EITHER a
		// defensive bubble OR one or more offensive beams. Both modes
		// can run simultaneously on multi-beam pods (Growler); a
		// single-beam pod's UI enforces mutual exclusion at toggle
		// time, so the registry only sees what's actually radiating.
		const offensive = u.jammer.offensiveTargets && u.jammer.offensiveTargets.size > 0;
		if (!u.jammer.defensiveOn && !offensive) continue;
		_registry.push(u);
	}
}

// Factory called from spawnPlatform / spawnFighter when a JSON block is
// present. Frozen-shape: defensiveOn defaults to true so AI jammer
// platforms broadcast as soon as they spawn.
export function createJammer(config) {
	return {
		type:          config.type || 'radar',
		power:         config.power || 10000,
		beamCount:     config.beamCount || 1,
		coneHalfDeg:   config.coneHalfDeg || 45,
		burnThroughRangeM: config.burnThroughRangeM || 8000,
		// Per-jammer override of how much the jam cuts a victim's
		// detection range. 0.4 ≈ "60% range cut" from the design
		// doc; scenario configs can tune this when calibrating
		// (the test scenario uses ~0.15 to make the on/off
		// behaviour unambiguous, which would otherwise be borderline
		// for a target sitting at the radar's nominal limit).
		attFloor:      (config.attFloor != null) ? config.attFloor : 0.4,
		// Visualisation hint — how far out the noise cone is drawn
		// in the commander debug view. The math has no hard cutoff
		// (jam noise is just a 60% range-multiplier at any distance),
		// so this is purely for the overlay.
		maxEffectRangeM: config.maxEffectRangeM || 150000,
		// Runtime state.
		defensiveOn:   config.defensiveOn !== false,
		offensiveTargets: new Set(),
	};
}

// Burn-through factor: at >= burnThroughRangeM × 3 the jam is at full
// strength (returns ATT_FLOOR). At burnThroughRangeM the radar starts
// to break through. Inside burnThroughRangeM the attenuation rolls off
// linearly to 1.0 (no effect). This gives a smooth visual transition
// rather than a binary cliff.
function _attFromRange(rangeM, jammer) {
	const floor = (jammer.attFloor != null) ? jammer.attFloor : 0.4;
	const burn  = jammer.burnThroughRangeM;
	if (rangeM <= burn) {
		// Inside burn-through radius: jamming breaks down. Linear
		// roll-off from att = floor @ burn → att = 1.0 @ 0.5×burn.
		const t = Math.max(0, Math.min(1, (rangeM - 0.5 * burn) / (0.5 * burn)));
		return 1.0 - (1.0 - floor) * t;
	}
	return floor;
}

// Vector from observer to target, in ECEF metres. Used to test whether
// a third-party jammer's noise corridor falls along the observer's LOS
// to a target it's trying to detect.
const _v1 = new Cesium.Cartesian3();
const _v2 = new Cesium.Cartesian3();

function _ecefVec(from, to, out) {
	const a = Cesium.Cartesian3.fromDegrees(from.lon, from.lat, from.alt, undefined, _v1);
	const b = Cesium.Cartesian3.fromDegrees(to.lon,   to.lat,   to.alt,   undefined, _v2);
	return Cesium.Cartesian3.subtract(b, a, out);
}

function _angleBetween(a, b) {
	const da = Cesium.Cartesian3.magnitude(a);
	const db = Cesium.Cartesian3.magnitude(b);
	if (da < 1e-3 || db < 1e-3) return 0;
	const dot = Cesium.Cartesian3.dot(a, b) / (da * db);
	return Math.acos(Math.max(-1, Math.min(1, dot)));
}

// Range-multiplier the radar equation is scaled by. 1.0 = no jamming.
// Examines every active jammer in the registry; only jammers on a
// different team than the observer count, since friendly jammers
// don't degrade your own radar.
//
// Two distinct effects, both apply:
//
//   (a) Self-protect: when the jammer's host IS the target, the
//       observer's detection range against that target is cut.
//       Burn-through: closing inside burnThroughRangeM restores it.
//
//   (b) Corridor: when a (third-party) jammer happens to lie close to
//       the observer's LOS bearing toward a target, the jam noise
//       enters the observer's radar through the same antenna pointing
//       and degrades that target too. Cone width = jammer's coneHalfDeg.
//
// The return is the minimum (most attenuating) factor across all
// applicable jammers — the most-degraded path wins.
export function accumulateJamAttenuation(observer, target) {
	if (!_registry) return 1.0;
	let att = 1.0;

	const losOT = _ecefVec(observer, target, new Cesium.Cartesian3());
	const losOTLen = Cesium.Cartesian3.magnitude(losOT);
	if (losOTLen < 1) return 1.0;

	for (const jammer of _registry) {
		const sameTeam = jammer.team === observer.team;
		// 6e.2 — offensive focus. If this jammer has the observer in
		// its offensiveTargets set, it's pouring focused energy at
		// the observer's radar. Stronger than the wide-area defensive
		// bubble: we tighten the floor by 0.4× (so a defensive 0.5
		// becomes an offensive 0.2 ≈ 80% range cut) for any target
		// inside the corridor at the observer. Even works against the
		// jammer's own teammates' radars if a teammate is somehow
		// jammed — but we keep the team check for sanity.
		const isFocusedOnObserver = !sameTeam &&
			jammer.jammer.offensiveTargets &&
			jammer.jammer.offensiveTargets.has(observer);

		if (jammer === observer || jammer === target) {
			// Self-protect / self-attack-shield. Two ways this can fire:
			//   (a) defensiveOn — the wide bubble covers the jammer
			//       itself (jammer === target).
			//   (b) the observer is in offensiveTargets and the
			//       observer is shooting at us — when the player
			//       offensively jams a hostile that's launched on
			//       the player, the hostile's seeker radar tries to
			//       paint the player; we should attenuate that
			//       paint with the focused-beam effect even though
			//       defensiveOn might be off.
			if (jammer === target && jammer.team !== observer.team) {
				const focused = jammer.jammer.offensiveTargets
					&& jammer.jammer.offensiveTargets.has(observer);
				if (jammer.jammer.defensiveOn || focused) {
					let a = _attFromRange(losOTLen, jammer.jammer);
					if (focused) a = Math.max(0.05, a * 0.4);
					if (a < att) att = a;
				}
			}
			continue;
		}
		// Corridor: jammer is a third party. Only jammers on a
		// different team to the observer apply.
		if (sameTeam && !isFocusedOnObserver) continue;
		const losOJ = _ecefVec(observer, jammer, new Cesium.Cartesian3());
		const losOJLen = Cesium.Cartesian3.magnitude(losOJ);
		if (losOJLen < 1) continue;
		// Corridor model: noise from the jammer enters the observer's
		// radar through whatever antenna pointing reaches the jammer.
		// Real radars have a main-lobe of a few degrees; outside it the
		// sidelobe rejection kills jam contribution. So we test the
		// angle at the OBSERVER between (LOS to jammer) and (LOS to
		// the target the radar's currently looking at) — close angles
		// = jam falls in the same antenna pointing as the target's
		// reflection. The jammer's own coneHalfDeg describes which
		// directions IT broadcasts and is irrelevant for an omni
		// defensive bubble; offensive targeting (6e.2) gates on it
		// separately when picking which victims to corridor-jam.
		// Width: real fighter APGs have a main lobe ~3° full width
		// (1.5° half-angle), sidelobes 25–30 dB down. The blind arc
		// punched through the victim's scope is therefore narrow —
		// wide enough that strikers can hide directly behind a jammer,
		// narrow enough that a target a few km off-axis at the same
		// range is still detectable. Hard 1.5° cutoff (sidelobe
		// contribution rolls off fast enough to skip for v1).
		const mainLobeRad = 1.5 * Math.PI / 180;
		const sep = _angleBetween(losOT, losOJ);
		if (sep > mainLobeRad) continue;
		let a = _attFromRange(losOJLen, jammer.jammer);
		// Focused jamming hits ~2.5× harder. Floor still respects the
		// pod's burn-through curve, so closing the geometry still
		// frees the radar.
		if (isFocusedOnObserver) a = Math.max(0.05, a * 0.4);
		if (a < att) att = a;
	}
	return att;
}

// Per-frame break-lock probability roll for an inbound active-radar
// missile that's tracking a defensively-jamming target. Returns true
// when the lock should drop this frame.
//
// Probability is keyed off the missile generation: older seekers (R-27
// / Sparrow class) struggle against jam; modern AESA seekers (Meteor,
// AIM-120D, AIM-260) are far stiffer. The doc-spec values are
// per-second; we convert to per-frame via dt so the chance is
// frame-rate independent. The target's jammer can scale via a
// `breakLockBonus` knob (1.0 by default; SPECTRA-class pods can go
// higher).
//
// IR-guided missiles return false unconditionally — defensive RF jam
// doesn't touch heat-seeking optics.
const _BREAK_LOCK_PER_SEC = {
	'AIM-120':  0.10,
	'METEOR':   0.05,
	'R-77':     0.12,
	'R-37M':    0.06,
	'AIM-7':    0.30,
	'R-27':     0.30,
};
export function rollJamBreakLock(missile, dt) {
	if (!missile || !missile.target) return false;
	const tgt = missile.target;
	const jam = tgt.jammer;
	if (!jam || !jam.defensiveOn) return false;
	const base = _BREAK_LOCK_PER_SEC[missile.type];
	if (base == null) return false;
	const bonus = (jam.breakLockBonus != null) ? jam.breakLockBonus : 1.0;
	const perSec = Math.max(0, Math.min(0.95, base * bonus));
	// 1 - (1-perSec)^dt → exact per-second compounding into per-frame.
	const perFrame = 1 - Math.pow(1 - perSec, Math.max(0, dt));
	return Math.random() < perFrame;
}

// Receive-side "I am being jammed" snapshot for the player's HUD.
// Returns a Map keyed on jammer unit reference, value:
//   { source, bearing, elevation, range, att, burnThrough, lockType }
//
// Only opposing-team jammers appear. Bearing is in the observer's
// body frame (matching RWR conventions). att is the same factor that
// detectRadar applies; burnThrough is true while inside the burn-
// through radius (so the strobe collapses and a one-shot toast can
// fire).
export function collectJamStrobes(observer) {
	const out = new Map();
	if (!_registry || !observer) return out;
	for (const jammer of _registry) {
		if (jammer === observer) continue;
		if (jammer.team === observer.team) continue;
		// Bearing in observer body frame.
		const obsECEF = Cesium.Cartesian3.fromDegrees(observer.lon, observer.lat, observer.alt);
		const jamECEF = Cesium.Cartesian3.fromDegrees(jammer.lon,   jammer.lat,   jammer.alt);
		const losECEF = Cesium.Cartesian3.subtract(jamECEF, obsECEF, new Cesium.Cartesian3());
		const enu     = Cesium.Transforms.eastNorthUpToFixedFrame(obsECEF);
		const invEnu  = Cesium.Matrix4.inverse(enu, new Cesium.Matrix4());
		const losENU  = Cesium.Matrix4.multiplyByPointAsVector(invEnu, losECEF, new Cesium.Cartesian3());
		const range   = Cesium.Cartesian3.magnitude(losENU);
		if (range < 1) continue;
		const h  = Cesium.Math.toRadians(observer.heading || 0);
		const p  = Cesium.Math.toRadians(observer.pitch   || 0);
		const fwd = {
			x: Math.sin(h) * Math.cos(p),
			y: Math.cos(h) * Math.cos(p),
			z: Math.sin(p),
		};
		const rightLen = Math.hypot(fwd.x, fwd.y) || 1;
		const right = { x: fwd.y / rightLen, y: -fwd.x / rightLen, z: 0 };
		const up = {
			x: right.y * fwd.z - right.z * fwd.y,
			y: right.z * fwd.x - right.x * fwd.z,
			z: right.x * fwd.y - right.y * fwd.x,
		};
		const inv = 1 / range;
		const lh = { x: losENU.x * inv, y: losENU.y * inv, z: losENU.z * inv };
		const dotF = lh.x * fwd.x + lh.y * fwd.y + lh.z * fwd.z;
		const dotR = lh.x * right.x + lh.y * right.y + lh.z * right.z;
		const dotU = lh.x * up.x + lh.y * up.y + lh.z * up.z;
		const bearing   = Math.atan2(dotR, dotF);
		const elevation = Math.atan2(dotU, Math.hypot(dotF, dotR));

		const att = _attFromRange(range, jammer.jammer);
		const burnThrough = range <= jammer.jammer.burnThroughRangeM;
		out.set(jammer, {
			source: jammer,
			bearing,
			elevation,
			range,
			att,
			burnThrough,
			lockType: 'jam',
		});
	}
	return out;
}
