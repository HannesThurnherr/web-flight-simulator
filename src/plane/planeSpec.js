// ============================================================================
// planeSpec — required-fields contract for PlanePhysics.
//
// Why this exists: the previous shape (constructor with F-15 defaults +
// applyOverrides that silently skipped missing fields) let a B-2 JSON
// inherit fighter-class G limits, fighter inertia, fighter damping, and
// fighter roll authority — none of which made it into the override
// block, so the bomber flew like a Raptor with extra mass. That class
// of bug is exactly what silent fallbacks produce: every new airframe
// quietly inherits whatever the constructor's defaults happen to be.
//
// Fix: each plane JSON must declare a COMPLETE physicsOverrides block.
// validatePlaneSpec throws if any required field is missing, naming
// both the field and the JSON id so the failure is actionable.
//
// Optional fields (currently only `tv`) are explicitly listed here so
// the contract stays in one place — adding a field means updating
// REQUIRED or OPTIONAL, never just relying on a constructor default.
// ============================================================================

// All physicsOverrides leaf fields a plane JSON MUST declare. Nested
// objects are listed as path strings ('controlCoef.pitch'); the
// validator walks the path. Adding a tunable to PlanePhysics? Add it
// here and every JSON has to declare it — no silent fallback path.
const REQUIRED_PLANE_PHYSICS_FIELDS = [
	// Mass + reference geometry.
	'mass',
	'wingArea',
	'cdZero',

	// Engine (absolute values; per-plane multipliers are gone — use the
	// absolute number you measured / picked).
	'thrustDryMax',
	'thrustABMax',

	// Control authority (per-axis stick → moment scale).
	'controlCoef.pitch', 'controlCoef.roll', 'controlCoef.yaw',

	// Aerodynamic damping (per-axis ω → restoring moment scale).
	'dampingCoef.pitch', 'dampingCoef.roll', 'dampingCoef.yaw',

	// Moment of inertia (kg·m²; per-axis).
	'inertia.pitch', 'inertia.roll', 'inertia.yaw',

	// Low-airspeed control floor (q̄-independent stick → moment).
	'controlAuthorityFloor.pitch',
	'controlAuthorityFloor.roll',
	'controlAuthorityFloor.yaw',

	// FBW G-limiter envelope.
	'gSoftLimit',
	'gHardLimit',

	// Static stability: per-axis restoring moment vs (α − α_trim) and β.
	// Pitch lever-arm scales with q̄·S, so a big wing has more torque
	// per unit α deviation. Conventional fighters: ~0.3. Flying wings
	// (B-2): much lower (~0.05 — near-neutral static margin is the
	// whole point of the elevon planform).
	'pitchStabilityCoef',
	'yawStabilityCoef',

	// High-α lift curve shape (post-stall plateau, blend, departure).
	'alphaStallDeg',
	'clMaxStall',
	'postStallPlateau',
	'stallBlendDeg',
	'departureSusceptibility',
];

// Optional fields — not validated as missing. Constructor checks
// presence before applying.
const OPTIONAL_PLANE_PHYSICS_FIELDS = [
	'tv', // thrust-vectoring; only some airframes have it
];

function _readPath(obj, path) {
	const parts = path.split('.');
	let cur = obj;
	for (const p of parts) {
		if (cur == null) return undefined;
		cur = cur[p];
	}
	return cur;
}

export function validatePlaneSpec(planeId, overrides) {
	if (!overrides || typeof overrides !== 'object') {
		throw new Error(`[planeSpec] plane "${planeId}" is missing its physicsOverrides block`);
	}
	const missing = [];
	for (const field of REQUIRED_PLANE_PHYSICS_FIELDS) {
		const v = _readPath(overrides, field);
		if (typeof v !== 'number' || !Number.isFinite(v)) {
			missing.push(field);
		}
	}
	if (missing.length) {
		throw new Error(
			`[planeSpec] plane "${planeId}" physicsOverrides is missing required ` +
			`numeric fields: ${missing.join(', ')}`,
		);
	}
}

export { REQUIRED_PLANE_PHYSICS_FIELDS, OPTIONAL_PLANE_PHYSICS_FIELDS };
