// ============================================================================
// Unit signatures: what a thing emits and reflects. Used by the three
// detection channels (radar / IR / visual) to decide whether an observer
// notices a target.
//
// Each signature has three numbers and a class tag. The numbers are tuned
// so that fighters-vs-fighter radar detection at F-15 APG-63 numbers
// (~150 km nominal) falls out of the simple inverse-power laws used in
// sensorSystem.js.
//
//   rcs          m²     — radar cross section, aspect-modulated
//   irEmission   unitless heat scale, strongly aspect-modulated (rear hot)
//   visualSize   m      — longest visible dimension, for apparent angular size
//   unitClass    str    — class hint revealed to detectors (helps ID)
//
// Defaults below correspond to the published ballpark for each platform.
// They're deliberately coarse — gameplay rarely cares about 10% precision.
// ============================================================================

export const SIGNATURES = {
	// Clean, non-stealth fighter at cruise. F-15C, Su-27 class.
	fighter: {
		rcs: 12,
		irEmission: 200,
		visualSize: 19,
		unitClass: 'fighter',
	},
	// Low-observable fighter (F-35 class). Two orders of magnitude lower
	// RCS than a clean fighter plus cooler tailpipe treatment.
	stealth_fighter: {
		rcs: 0.05,
		irEmission: 100,
		visualSize: 18,
		unitClass: 'stealth_fighter',
	},
	// Higher-end stealth (F-22 class). ~10× lower RCS than the F-35
	// bin thanks to more aggressive airframe shaping + serpentine
	// inlets; IR trimmed further through thrust-vectoring-assisted
	// low-power cruise (supercruise means less afterburner time, so
	// less average IR as well).
	stealth_fighter_hi: {
		rcs: 0.008,
		irEmission: 80,
		visualSize: 19,
		unitClass: 'stealth_fighter',
	},
	// Strategic stealth bomber (B-2 Spirit class). RCS ~0.001 from
	// flying-wing planform + RAM coatings. IR is moderate despite
	// four engines because the exhausts are deeply embedded in the
	// upper wing surface and cooled before exit (no visible plume
	// from below). Visual size is very large though — 52 m wingspan
	// is about twice an F-15's. So a B-2 is essentially invisible to
	// radar at any reasonable range, IR-detectable only at fairly
	// short range (and not at all from below where it counts), but
	// trivial to spot visually if you know where to look.
	stealth_bomber: {
		rcs: 0.001,
		irEmission: 200,
		visualSize: 50,
		unitClass: 'stealth_bomber',
	},
	// Big radar return, big heat plume, big visual — AWACS / tanker / cargo.
	awacs: {
		rcs: 150,
		irEmission: 500,
		visualSize: 46,
		unitClass: 'awacs',
	},
	cargo: {
		rcs: 100,
		irEmission: 400,
		visualSize: 42,
		unitClass: 'cargo',
	},
	// High-altitude long-endurance ISR drone (RQ-4 / RQ-170 class).
	// Modest RCS — not stealth but not a fighter either; quiet IR
	// signature from a small turbofan; small visual at 18 km cruise.
	// Kept distinct from fighter / awacs so SAMs can be tuned to
	// engage drones via class filters when we get there.
	drone_isr: {
		rcs: 3,
		irEmission: 60,
		visualSize: 14,
		unitClass: 'drone_isr',
	},
	// Small, slow, low-flying. Easy IR when close; poor radar contrast.
	cruise_missile: {
		rcs: 0.1,
		irEmission: 80,
		visualSize: 6,
		unitClass: 'cruise_missile',
	},
	// Free-fall + glide PGMs (JDAM, GBU-12, GBU-39 SDB). Tiny RCS, no
	// thrust → effectively no IR signature, fairly small visual. Real
	// radar-based SAMs (Patriot, S-300/400, Tor) CAN engage them
	// terminal-phase, but it's hard. Distinct unitClass so the SAM
	// pickTarget logic can engage them while still excluding live
	// AAMs (which are too small + fast to bother with).
	bomb: {
		rcs: 0.05,
		irEmission: 0,
		visualSize: 4,
		unitClass: 'bomb',
	},
	// Live AAMs in flight. Tiny radar return, hot exhaust while the motor
	// burns, very small silhouette.
	missile_ir: {
		rcs: 0.05,
		irEmission: 500,
		visualSize: 3,
		unitClass: 'missile',
	},
	missile_radar: {
		rcs: 0.08,
		irEmission: 700,
		visualSize: 4,
		unitClass: 'missile',
	},
	// Ground SAM battery (NASAMS-class). Radar trailer + launcher trucks
	// present a fair RCS but not a huge one — ground clutter masks them
	// against terrain return. Low IR (cool diesel APUs) and small visual
	// footprint; the doctrine assumption is "you know roughly where the
	// battery is, but you still need to acquire it to SEAD it".
	sam_site: {
		rcs: 8,
		irEmission: 50,
		visualSize: 9,
		unitClass: 'sam_site',
	},
	// Surface-launched active-radar SAM (AMRAAM-ER / SL-AMRAAM). A bit
	// hotter than an air-launched AIM-120 because the ground booster
	// burns longer; RCS and visual size comparable.
	missile_sam: {
		rcs: 0.1,
		irEmission: 900,
		visualSize: 5,
		unitClass: 'missile',
	},
	// Early-warning radar — large rotating dish on a fixed mount, big
	// radar return because of the antenna structure itself. Modest IR
	// (electronics + diesel generator), large visual signature. The
	// big number that matters is `rcs`: HARM seekers and ARH AAMs both
	// see it from a long way out.
	ewr: {
		rcs: 25,
		irEmission: 80,
		visualSize: 15,
		unitClass: 'ewr',
	},
	// SHORAD launcher — tracked vehicle with a pop-out radar mast and
	// short-range vertically-launched SAMs (SA-15 Tor class). RCS is
	// modest when the radar mast is stowed; we don't model that here
	// (the radar config drives whether it's emitting), so the value is
	// the "mast-up" signature that SEAD aircraft would actually engage.
	shorad: {
		rcs: 4,
		irEmission: 30,
		visualSize: 7,
		unitClass: 'sam_site',
	},
	// Command post — tents, antennas, parked vehicles. No radar, no
	// weapons; bombable high-value target. Smaller RCS than a SAM site
	// because there's no big antenna structure, but the visual size is
	// substantial (~tent + comms vehicles cluster).
	command_post: {
		rcs: 6,
		irEmission: 40,
		visualSize: 12,
		unitClass: 'building',
	},
};

// ============================================================================
// Aspect modulation
//
// aspectAngle in radians: 0 = target's nose pointed straight at observer
// (head-on), π = target's tail pointed at observer (stern chase).
// ============================================================================

// RCS is highest from broadside (large projected area), lowest head-on or
// tail-on where only the narrow forward/rear aspect is visible. Simple model
// with a floor of 20% and peak of 1.0×:
//
//   factor = 0.2 + 0.8 · sin²(aspect)
//
// This is coarse but captures the main gameplay effect — crossing targets
// stand out; notch-aspect (near head-on or tail-on) returns are suppressed.
export function rcsAspectFactor(aspectAngle) {
	const s = Math.sin(aspectAngle);
	return 0.2 + 0.8 * s * s;
}

// IR is biased rearward — exhaust plume is the dominant signature. Roughly
// 10% of peak from head-on (intake heat, leading edge friction) up to 100%
// from directly behind. Linear-in-cos interpolation keeps it simple.
//
//   factor = 0.1 + 0.9 · (1 − cos(aspect)) / 2
//          = 0.1 + 0.45 · (1 − cos(aspect))
export function irAspectFactor(aspectAngle) {
	return 0.1 + 0.45 * (1 - Math.cos(aspectAngle));
}

// Visual is mildly aspect-sensitive (planform at beam shows more area than
// front or rear) but the dominant factor is distance. Keep it cheap.
//
//   factor = 0.6 + 0.4 · sin²(aspect)
export function visualAspectFactor(aspectAngle) {
	const s = Math.sin(aspectAngle);
	return 0.6 + 0.4 * s * s;
}

// Utility: aspect angle between a vector from observer to target, and the
// target's forward-pointing (velocity or heading) vector. All inputs are
// plain {x,y,z} in the same frame.
//
//   returns rad in [0, π]
export function aspectAngleFromVectors(toTargetUnit, targetForwardUnit) {
	const dot =
		toTargetUnit.x * targetForwardUnit.x +
		toTargetUnit.y * targetForwardUnit.y +
		toTargetUnit.z * targetForwardUnit.z;
	// toTargetUnit points FROM observer TO target. The target is head-on
	// when its forward vector points roughly opposite this → dot ≈ −1.
	// Tail-on when forward ≈ toTargetUnit → dot ≈ +1.
	// So aspectAngle = acos(−dot): 0 head-on, π tail-on.
	return Math.acos(Math.max(-1, Math.min(1, -dot)));
}
