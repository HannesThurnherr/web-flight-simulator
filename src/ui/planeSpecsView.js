// ============================================================================
// Spec-sheet derivation for the airframe picker modal.
//
// Every number shown on the card traces back to an actual simulation
// parameter. That way when someone asks "why does the F-22 supercruise?"
// the card answers "because its thrustDryMul is 1.78, giving 231 kN mil
// thrust vs the F-15's 130 kN." Values that are NOT currently
// differentiated between airframes get surfaced in a "Shared / not yet
// modeled" block so the gap between editorial flavor and sim truth is
// visible.
// ============================================================================

import { SIGNATURES } from '../systems/signatures';
import { FIGHTER_RADAR_DEFAULT } from '../systems/sensorSystem';

// PlanePhysics reference values (the F-15 constructor defaults).
// Keep in sync with src/plane/planePhysics.js.
const PHYS_BASE = {
	mass_kg:      20000,
	dryThrust_N:  158_000,
	abThrust_N:   258_000,
	wingArea_m2:  56,
	cdZero:       0.022,
	pitchCoef:    8.0,
	rollCoef:     9.0,
	yawCoef:      2.5,
	pitchDamping: 2600,
	rollDamping:  600,
	yawDamping:   2800,
	gSoftLimit:   8,
	gHardLimit:   10,
};

export const UNMODELED_FIELDS = [
	'Fuel capacity / combat radius (value above is editorial)',
	'Transonic / supersonic wave-drag spike (Mach 1 barrier)',
	'Dedicated IRST per airframe (F-35 DAS, F-22 MAWS)',
	'Weapons loadout capacity + internal vs external carriage',
	'EW / jamming suite differences',
	'Fly-by-wire departure protection specifics',
];

// Derive the full spec sheet from a plane's physicsOverrides + signature +
// radar config. Returns a flat object of pre-formatted strings the UI can
// slot directly into spec rows without additional math.
export function computeSpecs(plane) {
	const pov = plane.physicsOverrides || {};

	// Thrust ceilings (mul relative to base).
	const dryThrust = PHYS_BASE.dryThrust_N * (pov.thrustDryMul ?? 1);
	const abThrust  = PHYS_BASE.abThrust_N  * (pov.thrustABMul  ?? 1);

	// Airframe / drag — absolute overrides fall back to base.
	const mass     = pov.mass     ?? PHYS_BASE.mass_kg;
	const wingArea = pov.wingArea ?? PHYS_BASE.wingArea_m2;
	const cdZero   = pov.cdZero   ?? PHYS_BASE.cdZero;

	const weight_N = mass * 9.81;
	const wingLoading = mass / wingArea;

	// Control coefficients (absolute). agilityMul applies on top
	// for the few entries still using it.
	const pitchCoef = (pov.controlCoef && pov.controlCoef.pitch) ?? PHYS_BASE.pitchCoef;
	const rollCoef  = (pov.controlCoef && pov.controlCoef.roll)  ?? PHYS_BASE.rollCoef;
	const yawCoef   = (pov.controlCoef && pov.controlCoef.yaw)   ?? PHYS_BASE.yawCoef;
	const mul       = pov.agilityMul ?? 1;

	// Steady-state rotation rate for full stick at V: ω = δ·(K_c/K_d)·V
	// Reference: V = 250 m/s, ρ ≈ 1 (cruise conditions).
	const V_REF = 250;
	const pitchRateRef = (pitchCoef * mul / PHYS_BASE.pitchDamping) * V_REF * 180 / Math.PI;
	const rollRateRef  = (rollCoef  * mul / PHYS_BASE.rollDamping)  * V_REF * 180 / Math.PI;
	const yawRateRef   = (yawCoef   * mul / PHYS_BASE.yawDamping)   * V_REF * 180 / Math.PI;

	// Crude top-speed prediction (sea level, level flight):
	//   T = D → T = ½ρV²S·CD  →  V = √(2T/(ρS·CD))
	const rho_0 = 1.225;
	const topSpeedDry = Math.sqrt(2 * dryThrust / (rho_0 * wingArea * cdZero));
	const topSpeedAB  = Math.sqrt(2 * abThrust  / (rho_0 * wingArea * cdZero));

	const sig = SIGNATURES[plane.signature] || {};
	const radar = { ...FIGHTER_RADAR_DEFAULT, ...(plane.radarOverride || {}) };

	return {
		// ---- Engines / thrust ----
		dryThrust_kN: (dryThrust / 1000).toFixed(0),
		abThrust_kN:  (abThrust  / 1000).toFixed(0),
		twDry:        (dryThrust / weight_N).toFixed(2),
		twAB:         (abThrust  / weight_N).toFixed(2),
		supercruise:  !!(plane.specs && plane.specs.supercruise),
		topSpeedDry_ms: topSpeedDry.toFixed(0),
		topSpeedAB_ms:  topSpeedAB.toFixed(0),
		topSpeedDry_M:  (topSpeedDry / 340).toFixed(2),
		topSpeedAB_M:   (topSpeedAB  / 340).toFixed(2),

		// ---- Airframe ----
		mass_kg:          mass.toLocaleString(),
		wingArea_m2:      wingArea.toFixed(1),
		wingLoading_kgm2: wingLoading.toFixed(0),
		cdZero:           cdZero.toFixed(3),

		// ---- Control authority ----
		pitchRateRef: pitchRateRef.toFixed(1),
		rollRateRef:  rollRateRef.toFixed(0),
		yawRateRef:   yawRateRef.toFixed(1),
		pitchCoef:    (pitchCoef * mul).toFixed(1),
		rollCoef:     (rollCoef  * mul).toFixed(1),
		yawCoef:      (yawCoef   * mul).toFixed(1),
		gSoft:        pov.gSoftLimit ?? PHYS_BASE.gSoftLimit,
		gHard:        pov.gHardLimit ?? PHYS_BASE.gHardLimit,

		// ---- Signature ----
		rcs_m2:         sig.rcs != null ? sig.rcs : null,
		irEmission:     sig.irEmission,
		visualSize_m:   sig.visualSize,

		// ---- Radar ----
		radarRange_km:  (radar.nominalRange / 1000).toFixed(0),
		radarFovH_deg:  (radar.fovH * 180 / Math.PI).toFixed(0),
		radarNotch_ms:  radar.notchThreshold ?? 90,

		// ---- Claimed / cosmetic ----
		role:              plane.specs && plane.specs.role,
		topSpeedClaim:     plane.specs && plane.specs.topSpeed,
		combatRadiusClaim: plane.specs && plane.specs.combatRadius,
	};
}
