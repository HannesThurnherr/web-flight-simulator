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
	// Low-observable fighter. Roughly two orders of magnitude lower RCS than
	// a clean fighter, plus cooler tailpipe treatment.
	stealth_fighter: {
		rcs: 0.05,
		irEmission: 100,
		visualSize: 18,
		unitClass: 'stealth_fighter',
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
	// Small, slow, low-flying. Easy IR when close; poor radar contrast.
	cruise_missile: {
		rcs: 0.1,
		irEmission: 80,
		visualSize: 6,
		unitClass: 'cruise_missile',
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
