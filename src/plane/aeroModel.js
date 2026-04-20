import * as THREE from 'three';

// ============================================================================
// Aerodynamic / physical helpers for the flight model.
//
// Coordinate conventions (see planePhysics.js for full notes):
//   World frame  (local ENU): +X = East,       +Y = North,       +Z = Up
//   Body  frame  (at identity): +X = right wing, +Y = forward nose, +Z = up
//
// Rotation order (intrinsic): heading (about body +Z, sign-flipped) → pitch
// (about body +X) → roll (about body +Y). Equivalent THREE Euler order 'ZXY'
// with the Z component negated to give the aeronautical heading convention.
// ============================================================================

export const BODY_FORWARD = new THREE.Vector3(0, 1, 0);
export const BODY_RIGHT   = new THREE.Vector3(1, 0, 0);
export const BODY_UP      = new THREE.Vector3(0, 0, 1);

export const WORLD_UP = new THREE.Vector3(0, 0, 1);

export const EARTH_RADIUS = 6371000; // meters
export const GRAVITY = 9.80665;      // m/s²

// Standard-atmosphere-ish air density (very simple exponential model).
// Good enough for physics feel; we do not need ISA precision.
const SEA_LEVEL_DENSITY = 1.225; // kg/m³
export function airDensity(altitudeMeters) {
	// Sea-level 1.225 kg/m³, scale-height ~8500 m.
	return SEA_LEVEL_DENSITY * Math.exp(-Math.max(0, altitudeMeters) / 8500);
}

// Jet engine thrust falloff with altitude. Real engines vary between
// near-linear-with-density (pure turbojet) and more complex curves (high-
// bypass turbofans). Exponent 0.7 is a reasonable compromise for a low-bypass
// afterburning turbofan like the F100. At 10 km altitude this gives ~47% of
// sea-level thrust, matching published F-15 performance envelopes.
export function thrustAltitudeFactor(altitudeMeters) {
	const ratio = airDensity(altitudeMeters) / SEA_LEVEL_DENSITY;
	return Math.pow(ratio, 0.7);
}

// ============================================================================
// Aerodynamic coefficients as functions of flow angles.
//
// α (angle of attack):  angle between velocity and body-forward, measured
//                        about the body-right axis. α > 0 when the nose is
//                        pitched above the flight path.
// β (sideslip):          angle between velocity and body-forward, measured
//                        about body-up. β > 0 when velocity has a component
//                        toward body-right (i.e. wind "coming from the left").
//
// All coefficients are dimensionless and multiplied by q̄·S_ref in the
// physics integrator to produce forces in newtons.
// ============================================================================

// Lift coefficient vs angle of attack.
// Linear regime up to stall, then a linear drop to a post-stall floor.
// Rough F-15-ish values: dCL/dα = 5.0 rad⁻¹, α_stall = 18°, CL_max ≈ 1.57.
const CL_ALPHA = 5.0;            // per radian
const ALPHA_STALL = 18 * Math.PI / 180;
const POSTSTALL_FLOOR = 0.30;    // CL drops to 30% of peak well past stall
const POSTSTALL_DROP_WINDOW = 15 * Math.PI / 180; // reach floor ~15° past stall
export function liftCoefficient(alpha) {
	const absA = Math.abs(alpha);
	if (absA <= ALPHA_STALL) {
		return CL_ALPHA * alpha;
	}
	const sign = Math.sign(alpha);
	const peak = CL_ALPHA * ALPHA_STALL;
	const past = absA - ALPHA_STALL;
	const t = Math.min(1, past / POSTSTALL_DROP_WINDOW);
	const factor = 1 - (1 - POSTSTALL_FLOOR) * t;
	return sign * peak * factor;
}

// Drag coefficient. Parabolic polar CD = CD0 + k·CL², plus a crude
// misalignment term that ramps up drag when velocity is far from
// body-forward (flat-plate-ish behavior at extreme AoA/sideslip). This is
// not a real transonic/hypersonic model — just enough to keep the energy
// bookkeeping reasonable at any attitude.
const CD_ZERO = 0.022;
const INDUCED_K = 0.12;  // ≈ 1/(π·AR·e) with AR≈3, e≈0.85
// Extra drag when velocity is far from body-forward (flat-plate-ish at extreme
// attitudes). Kept small so that moderate AoA / sideslip in normal maneuvers
// doesn't double-count the induced-drag penalty — real fighters don't bleed
// energy this fast in a hard turn.
const MISALIGN_DRAG = 0.3;
export function dragCoefficient(CL, alpha, beta) {
	const misalign = Math.sin(alpha) ** 2 + Math.sin(beta) ** 2;
	return CD_ZERO + INDUCED_K * CL * CL + MISALIGN_DRAG * misalign;
}

// Side force coefficient from sideslip. Negative sign convention: β > 0
// (wind from the left) pushes the airframe toward body-left, giving a
// force in the -body_X direction via the body-frame sideforce vector.
const CY_BETA = -1.0; // per radian
export function sideForceCoefficient(beta) {
	return CY_BETA * beta;
}

// Build a body→world quaternion from (heading, pitch, roll) in radians.
// Matches the HPR extraction below so round-tripping is clean.
export function quaternionFromHPR(heading, pitch, roll, out = new THREE.Quaternion()) {
	const qH = new THREE.Quaternion().setFromAxisAngle(BODY_UP,      -heading);
	const qP = new THREE.Quaternion().setFromAxisAngle(BODY_RIGHT,    pitch);
	const qR = new THREE.Quaternion().setFromAxisAngle(BODY_FORWARD,  roll);
	out.copy(qH).multiply(qP).multiply(qR);
	return out;
}

// Extract (heading, pitch, roll) in radians from a body→world quaternion.
// Uses THREE's 'ZXY' Euler order to match the intrinsic order in
// quaternionFromHPR; the Z component is negated back into the aeronautical
// clockwise-from-north heading convention.
const _euler = new THREE.Euler();
export function hprFromQuaternion(q) {
	_euler.setFromQuaternion(q, 'ZXY');
	return {
		heading: -_euler.z,
		pitch:    _euler.x,
		roll:     _euler.y,
	};
}

// Integrate a body→world quaternion by a body-frame angular velocity ω (rad/s)
// over dt seconds. Uses exact exponential-map form so large step sizes stay
// stable (important for substep integration).
const _qDelta = new THREE.Quaternion();
const _axis   = new THREE.Vector3();
export function integrateQuaternion(q, omegaBody, dt) {
	const angle = omegaBody.length() * dt;
	if (angle < 1e-9) return q;
	_axis.copy(omegaBody).normalize();
	_qDelta.setFromAxisAngle(_axis, angle);
	// omega is in body frame, so right-multiply.
	q.multiply(_qDelta).normalize();
	return q;
}

// Convert a world-frame velocity vector (ENU, m/s) into a lon/lat/alt delta
// over dt. Flat-Earth approximation — accurate enough at BVR scales; avoids
// the geodetic gimbal issues of movePosition() at steep pitch angles.
export function advanceLonLatAlt(lon, lat, alt, velENU, dt) {
	const latRad = THREE.MathUtils.degToRad(lat);
	const dNorth = velENU.y * dt;
	const dEast  = velENU.x * dt;
	const dUp    = velENU.z * dt;
	const dLat = THREE.MathUtils.radToDeg(dNorth / EARTH_RADIUS);
	const dLon = THREE.MathUtils.radToDeg(dEast  / (EARTH_RADIUS * Math.max(1e-6, Math.cos(latRad))));
	return {
		lon: lon + dLon,
		lat: lat + dLat,
		alt: alt + dUp,
	};
}
