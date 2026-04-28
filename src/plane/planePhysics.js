import * as THREE from 'three';
import {
	BODY_FORWARD, BODY_RIGHT, BODY_UP,
	GRAVITY, airDensity, thrustAltitudeFactor,
	liftCoefficient, dragCoefficient, sideForceCoefficient,
	quaternionFromHPR, hprFromQuaternion, integrateQuaternion,
} from './aeroModel.js';
import { validatePlaneSpec } from './planeSpec.js';

// ============================================================================
// PlanePhysics — Phase 1: rigid-body 6DOF with aerodynamic moments.
//
// This phase replaces the old kinematic orientation controller (which set
// rotation rates directly from stick inputs) with a proper force+moment
// integrator where angular dynamics emerge from airflow physics.
//
// ---- Rotational model ------------------------------------------------------
// Moments on the airframe all come from air moving over surfaces. Two terms:
//
//   1. Control surface moment (elevator/aileron/rudder)
//      M_control = δ · K_c · q̄          [N·m]
//      where  δ  is pilot stick deflection (−1..+1)
//             q̄ = ½ ρ V²                  is dynamic pressure
//             K_c lumps reference area × reference length × moment coefficient
//                 — a single aerodynamic constant with units of volume (m³).
//      ⇒ Controls feel mushy at low airspeed, crisp at high airspeed.
//
//   2. Aerodynamic rate damping (tail/wings resisting rotation)
//      M_damp = − K_d · ρ V · ω          [N·m]
//      where  ω  is the body-frame angular rate on this axis
//             K_d is a damping coefficient (units m⁴)
//      The linear-in-V (not V²) form falls out of non-dimensionalizing the
//      rotation rate in the usual aero derivation.
//      ⇒ At V=0, damping vanishes — the airframe tumbles freely (realistic).
//
// Steady-state rotation for held stick: M_control + M_damp = 0 gives
//      ω_ss = δ · (K_c / K_d) · V
// — rotation rate scales linearly with airspeed, matching real fighter behavior
// (roll rates are quoted at a reference Mach for a reason).
//
// Time constant when releasing stick: τ = I / (K_d · ρ V). Shrinks with speed;
// the jet feels snappier as airspeed rises. Also real.
//
// ---- Translational model (Phase 1 placeholder) ----------------------------
// Thrust along body-forward, gravity in world -Z, plus a crude quadratic drag
// term. Real lift / induced-drag / AoA-sensitive forces arrive in Phase 2, so
// the aircraft currently sinks when level — expected and will be fixed.
//
// ---- What is NOT yet in ---------------------------------------------------
//   - Lift, induced drag, AoA, sideslip, stall               (Phase 2)
//   - Static stability / weathercock moments                 (Phase 3)
//   - Stick rate limiting / actuator dynamics                (Phase 3)
//   - Afterburner + altitude-dependent thrust model          (Phase 4)
// ============================================================================

const FIXED_DT = 1 / 120; // internal physics tick

export class PlanePhysics {
	// REQUIRED constructor argument: a complete physics spec (the
	// plane JSON's `physicsOverrides` block, validated by
	// validatePlaneSpec). Every tunable below is read from the spec —
	// there are NO silent fallbacks. Pass an incomplete spec and the
	// validator throws with the exact missing field name.
	constructor(spec) {
		validatePlaneSpec((spec && spec.__id) || '<unknown>', spec);

		// ----- Physical parameters (read directly from spec) ------------------
		this.mass = spec.mass;

		// Diagonal inertia tensor in body frame (kg·m²).
		// Body +X = right wing → rotation about +X is pitch (nose+tail swing)
		// Body +Y = nose       → rotation about +Y is roll  (wingtips, smaller)
		// Body +Z = up         → rotation about +Z is yaw   (nose+tail, largest)
		this.inertia = new THREE.Vector3(
			spec.inertia.pitch,
			spec.inertia.roll,
			spec.inertia.yaw,
		);

		// Aerodynamic moment coefficients.
		//
		//   K_c (controlCoef) — control surface authority. Moment at full
		//     stick is M = δ · K_c · q̄. Units: m³ (area × length × Cm_δ).
		//
		//   K_d (dampingCoef) — aerodynamic rate damping. Moment opposing
		//     rotation is M = − K_d · ρV · ω. Units: m⁴ (area × length² ×
		//     Cm_q / 2).
		//
		// Steady-state rate for held stick: ω_ss = δ · (K_c/K_d) · V.
		// Release-stick time constant:       τ   = I / (K_d · ρV).
		this.controlCoef = new THREE.Vector3(
			spec.controlCoef.pitch,
			spec.controlCoef.roll,
			spec.controlCoef.yaw,
		);
		this.dampingCoef = new THREE.Vector3(
			spec.dampingCoef.pitch,
			spec.dampingCoef.roll,
			spec.dampingCoef.yaw,
		);

		// Sign mapping from pilot stick (+1, −1) to moment on body axis.
		// Pitch: +stick (nose up)    → +Mx (body +Y rotates toward +Z)  ✓
		// Roll:  +stick (rt wing dn) → +My (body +X rotates toward -Z)  ✓
		// Yaw:   +stick (nose right) → −Mz (positive rot about +Z takes
		//                                     nose toward body −X, i.e. left)
		this.inputSign = new THREE.Vector3(+1, +1, -1);

		// ---- Flight envelope protection (Phase 6) ----------------------------
		// Fly-by-wire-style G-limiter. Below softLimit the pilot has full
		// pitch authority; between softLimit and hardLimit the commanded
		// pull is attenuated toward zero; at and above hardLimit the
		// pull input is fully suppressed and G decays back into the
		// envelope on its own. Only pull-up input is limited.
		this.gSoftLimit = spec.gSoftLimit;
		this.gHardLimit = spec.gHardLimit;
		this.gLimiterActive = false;

		// ---- Static stability (Phase 3) --------------------------------------
		// Restoring moments from AoA and sideslip — these are what make the
		// aircraft want to fly nose-into-wind rather than trimming wherever it
		// is pointed. Both coefficients lump the dimensionless moment
		// derivative with a reference length (c_ref for pitch, b for yaw):
		//
		//   M_pitch_stab = − K_pα · q̄ · S · (α − α_trim)
		//   M_yaw_stab   = − K_nβ · q̄ · S · β
		//
		// α_trim models a horizontal tail with slight negative incidence (real
		// aircraft use this + pilot trim wheel so zero stick = trimmed cruise).
		// Without this the pitch-stability moment would drive α → 0, but level
		// flight needs α ≈ 2° to generate lift, so the aircraft would
		// perpetually trim nose-down and sink.
		//
		// No dihedral (roll-from-sideslip) coupling yet — can be added later
		// if aerobatic feel needs it.
		this.pitchStabilityCoef = 0.3;         // effective |C_mα| · c_ref (m)
		this.yawStabilityCoef   = 0.5;         // effective |C_nβ| · b     (m)
		// Auto-trim α target — recomputed each frame from the current
		// flight condition (mass / dynamic pressure / lift-curve
		// slope) so the airframe naturally settles at whatever α
		// gives lift = weight at the current speed and altitude.
		// Initial value is a fighter-cruise placeholder; the first
		// integrator tick replaces it.
		this.alphaTrim = 2.0 * Math.PI / 180;
		// Lift-curve slope used by the auto-trim solver. Standard
		// finite-wing value (~5.7 / rad ≈ 0.10 / deg). All our planes
		// share this — varying it per-airframe is overkill for the
		// trim path; it doesn't break the rest of the aero model
		// because actual lift uses liftCoefficient() with full
		// stall behaviour.
		this._cLAlpha = 5.7;

		// Thrust parameters (N). Absolute values from spec — no
		// multiplier path. F-15: dry 158 kN, AB 258 kN. F-22: dry
		// 232 kN, AB 312 kN. B-2: dry 308 kN, AB 308 kN (no AB).
		this.thrustDryMax = spec.thrustDryMax;
		this.thrustABMax  = spec.thrustABMax;

		// Wing reference area for all aerodynamic force calculations.
		// Lift, drag, and sideforce scale with q̄ · S_ref · coefficient.
		this.wingArea = spec.wingArea;

		// Parasitic drag coefficient at zero AoA / zero sideslip.
		this.cdZero = spec.cdZero;

		// ---- High-alpha aero parameters (Phase 7b) ---------------------------
		// Per-airframe lift-curve shape — passed into liftCoefficient(). See
		// aeroModel.js for the full model. F-22 / Su-class raise clMaxStall
		// + postStallPlateau and stallBlendDeg to recover lift deep into
		// post-stall.
		this.alphaStallDeg     = spec.alphaStallDeg;
		this.clMaxStall        = spec.clMaxStall;
		this.postStallPlateau  = spec.postStallPlateau;
		this.stallBlendDeg     = spec.stallBlendDeg;

		// Departure susceptibility — how violently the airframe yaws when
		// driven past critical α at low V. TV airframes (F-22) damp this
		// through nozzle authority; clean-wing classics (F-15) depart hard.
		this.departureSusceptibility = spec.departureSusceptibility;
		this._departurePhase = Math.random() * Math.PI * 2;

		// Control authority floor — small constant moment-per-stick term
		// that does NOT scale with q̄. Real elevator/aileron retain a sliver
		// of authority at near-zero airspeed via prop/jet wash and (in fly-
		// by-wire jets) the FCS reflexively going to large deflections.
		this.controlAuthorityFloor = {
			pitch: spec.controlAuthorityFloor.pitch,
			roll:  spec.controlAuthorityFloor.roll,
			yaw:   spec.controlAuthorityFloor.yaw,
		};

		// ---- Thrust vectoring (Phase 7a, optional) ---------------------------
		// Adds a thrust-based moment that does NOT depend on dynamic pressure
		// — survives at low V where aero controls have died. Off unless
		// the spec includes a `tv` block.
		//
		//   axes      'pitch' | 'pitchYaw'   which axes get TV
		//   authority effective moment arm × Cm_δ in metres. Moment is
		//             M_tv = thrust · authority · stick.
		//             Sample: F-22 ≈ 2.0 m (±20° nozzle, ~6 m moment arm).
		//   vMax      airspeed (m/s) at which TV authority has fully faded.
		//   fadeBand  m/s window over which fade goes from 1 → 0.
		this.tv = spec.tv ? {
			axes:      spec.tv.axes,
			authority: spec.tv.authority,
			vMax:      spec.tv.vMax,
			fadeBand:  spec.tv.fadeBand,
		} : null;

		// ----- Runtime state
		this.position = null; // managed by main.js via lon/lat/alt; kept null here
		this.velocity = new THREE.Vector3(0, 0, 0); // world-frame ENU, m/s
		this.quaternion = new THREE.Quaternion();   // body → world
		this.angularVelocity = new THREE.Vector3(); // body-frame rad/s

		// Throttle & afterburner. AB is a proper second-stage thrust regime:
		// hold the boost key to light it, release to cut. No arcade duration
		// timer. The idle floor is 5% of mil thrust — turbojets never go to
		// zero at idle, and leaving zero-thrust in the model makes the
		// aircraft fall out of the sky whenever the pilot pulls throttle
		// all the way back, which is unlike anything a real jet does.
		this.throttle = 0.5;
		this.idleThrottle = 0.05;
		this.isBoosting = false;
		// Kept for main.js compatibility (HUD / jet-flame). Setting rotations
		// to 0 suppresses the old barrel-roll-on-boost arcade animation,
		// which doesn't fit a sim.
		this.boostTimeRemaining = 1;
		this.boostDuration = 1;
		this.boostMultiplier = 1.0;
		this.boostRotations = 0;
		this.boostPressed = false;

		// Speed (|velocity|) exposed for HUD/sound code that expects a scalar.
		this.speed = 250;

		// Euler snapshot updated each tick for HUD compatibility.
		this.pitch = 0;
		this.roll = 0;
		this.heading = 0;

		// Aerodynamic state (exposed for HUD / stall warning — Phase 5).
		this.alpha = 0;      // angle of attack (rad)
		this.beta  = 0;      // sideslip (rad)
		this.loadFactor = 1; // current vertical G (lift/weight)

		// Thrust-vectoring nozzle deflection (rad), as actually commanded
		// after the airspeed fade. Exposed so the flame renderer can rotate
		// the exhaust plume in sync. Pitch up (nose-up command) is positive.
		this.tvDeflection = { pitch: 0, yaw: 0 };

		// Scratch vectors to avoid per-frame allocation.
		this._scratch = {
			thrustWorld: new THREE.Vector3(),
			forceWorld:  new THREE.Vector3(),
			gravity:     new THREE.Vector3(),
			aeroBody:    new THREE.Vector3(),
			aeroWorld:   new THREE.Vector3(),
			vBody:       new THREE.Vector3(),
			vHatBody:    new THREE.Vector3(),
			liftDir:     new THREE.Vector3(),
			sideDir:     new THREE.Vector3(),
			moment:      new THREE.Vector3(),
			damp:        new THREE.Vector3(),
			angAccel:    new THREE.Vector3(),
			linAccel:    new THREE.Vector3(),
			noseWorld:   new THREE.Vector3(),
			qConj:       new THREE.Quaternion(),
		};
	}

	// AB is hold-to-engage via the input flag now; kept as a no-op so any
	// external callers don't break.
	boost() {}

	// applyOverrides removed — the entire spec is now consumed by the
	// constructor. Anything that needs a different airframe's physics
	// constructs a fresh PlanePhysics(spec).

	// Called by main.js when entering FLYING. Seeds the integrator with a
	// sensible initial velocity (along nose) so the aircraft is already
	// trimmed for cruise instead of falling from rest.
	reset(lon, lat, alt, heading = 0, pitch = 0, roll = 0) {
		this.heading = THREE.MathUtils.degToRad(heading);
		this.pitch   = THREE.MathUtils.degToRad(pitch);
		this.roll    = THREE.MathUtils.degToRad(roll);

		quaternionFromHPR(this.heading, this.pitch, this.roll, this.quaternion);

		// Start at a cruise airspeed along the nose.
		const initialSpeed = 250; // m/s ≈ 485 kts
		this._scratch.noseWorld.copy(BODY_FORWARD).applyQuaternion(this.quaternion);
		this.velocity.copy(this._scratch.noseWorld).multiplyScalar(initialSpeed);
		this.speed = initialSpeed;

		this.angularVelocity.set(0, 0, 0);
		this.throttle = 0.5;
		this.isBoosting = false;
	}

	update(input, dt) {
		// Afterburner is now a throttle regime, not a timed arcade boost.
		// isBoosting just tracks the input so HUD/sound/flame effects can
		// read a single flag.
		this.isBoosting = !!input.boost;

		// Smooth-track commanded throttle (stick is already rate-limited in
		// controller; we just copy it here).
		this.throttle = THREE.MathUtils.clamp(input.throttle, 0, 1);

		// Substep the integrator for stability at low fps.
		let remaining = Math.max(0, Math.min(dt, 0.1));
		while (remaining > 1e-6) {
			const step = Math.min(FIXED_DT, remaining);
			this._integrate(input, step);
			remaining -= step;
		}

		// Refresh Euler snapshot for HUD/Cesium.
		const hpr = hprFromQuaternion(this.quaternion);
		this.heading = hpr.heading;
		this.pitch   = hpr.pitch;
		this.roll    = hpr.roll;
		this.speed   = this.velocity.length();

		return {
			// Legacy shape (degrees, compatible with old main.js)
			speed:    this.speed,
			pitch:    THREE.MathUtils.radToDeg(this.pitch),
			roll:     THREE.MathUtils.radToDeg(this.roll),
			heading:  THREE.MathUtils.radToDeg(this.heading),
			isBoosting: this.isBoosting,
			boostTimeRemaining: this.boostTimeRemaining,
			boostDuration: this.boostDuration,
			boostRotations: this.boostRotations,

			// New fields (used by updated main.js for position integration)
			velocityENU: this.velocity,          // world-frame velocity (m/s, ENU)
			angularVelocity: this.angularVelocity, // body-frame rad/s
			throttle: this.throttle,
			quaternion: this.quaternion,

			// Aerodynamic state (for HUD / AI / stall logic)
			alpha: this.alpha,        // rad, angle of attack
			beta:  this.beta,         // rad, sideslip
			loadFactor: this.loadFactor, // G (lift / weight), ≈1 in level flight
			gLimiterActive: this.gLimiterActive,
			tvDeflection: this.tvDeflection, // {pitch, yaw} radians, 0 if no TV
		};
	}

	// One fixed-step integrator tick.
	_integrate(input, dt) {
		const S = this._scratch;

		// Airflow state used by both the force and moment calculations.
		const V   = this.velocity.length();               // airspeed (m/s)
		const rho = airDensity(this._approxAltitude());   // air density (kg/m³)
		const q   = 0.5 * rho * V * V;                    // dynamic pressure (Pa)

		// ---- Auto-trim: compute the α that gives lift = weight at the
		// current dynamic pressure, then low-pass it into alphaTrim.
		// Without this, the airframe's static-stability moment pulls
		// toward a fixed 2° α regardless of mass / speed / altitude,
		// which means a heavy bomber at low speed sinks (needs ~8°
		// for level lift but the trim fights it) and a light fighter
		// at high speed climbs (needs ~0.5° but trim wants 2°).
		// The pilot can override via stick input — this is just the
		// neutral-stick equilibrium target.
		//
		//   CL_required = (m·g) / (q·S)
		//   α_trim      = CL_required / CL_α
		//
		// CL_α is the lift-curve slope (~5.7/rad for typical wings).
		// Smoothed with a ~1 s time constant so airspeed transients
		// don't visibly oscillate the trim target.
		if (V > 50 && q > 100) {
			const cLRequired = (this.mass * GRAVITY) / (q * this.wingArea);
			const alphaTarget = Math.max(-0.17, Math.min(0.30, cLRequired / this._cLAlpha));
			const tau = 1.0;  // seconds; 1-pole LPF
			const k   = Math.min(1, dt / tau);
			this.alphaTrim += (alphaTarget - this.alphaTrim) * k;
		}

		// ---- 1. Forces (world frame) -------------------------------------
		// Thrust along body +Y → world.
		const thrustMag = this._thrustMagnitude();
		S.thrustWorld.copy(BODY_FORWARD).applyQuaternion(this.quaternion).multiplyScalar(thrustMag);

		// Aerodynamic forces: compute velocity in body frame, extract α and β,
		// then build lift / drag / sideforce vectors.
		//
		//   v_body = q⁻¹ · v_world
		//   α = atan2(-v_body.z, v_body.y)    (nose above flight path ⇒ α>0)
		//   β = asin(v_body.x / |v_body|)     (velocity right of nose ⇒ β>0)
		//
		//   drag direction   = -v̂_body
		//   lift direction   =  body_up projected perpendicular to v̂_body
		//   side direction   =  v̂_body × lift direction
		S.aeroWorld.set(0, 0, 0);
		if (V > 1.0) {
			S.qConj.copy(this.quaternion).conjugate();
			S.vBody.copy(this.velocity).applyQuaternion(S.qConj);
			S.vHatBody.copy(S.vBody).multiplyScalar(1 / V);

			this.alpha = Math.atan2(-S.vBody.z, S.vBody.y);
			this.beta  = Math.asin(THREE.MathUtils.clamp(S.vBody.x / V, -1, 1));

			const CL = liftCoefficient(this.alpha, {
				alphaStallRad:    this.alphaStallDeg * Math.PI / 180,
				clMaxStall:       this.clMaxStall,
				postStallPlateau: this.postStallPlateau,
				stallBlendRad:    this.stallBlendDeg * Math.PI / 180,
			});
			const CD = dragCoefficient(CL, this.alpha, this.beta, this.cdZero);
			const CY = sideForceCoefficient(this.beta);

			const qS = q * this.wingArea;
			const L = qS * CL;
			const D = qS * CD;
			const Y = qS * CY;

			// Lift direction: body_up minus its component along the velocity,
			// then renormalized. Falls back to body_up when velocity is
			// parallel to body_up (degenerate, rare).
			const upDotV = BODY_UP.dot(S.vHatBody);
			S.liftDir.copy(BODY_UP).addScaledVector(S.vHatBody, -upDotV);
			if (S.liftDir.lengthSq() > 1e-6) {
				S.liftDir.normalize();
			} else {
				S.liftDir.copy(BODY_UP);
			}
			// Side direction: complete the right-handed wind-axis triad.
			S.sideDir.crossVectors(S.vHatBody, S.liftDir);

			// Body-frame aerodynamic force.
			S.aeroBody
				.copy(S.vHatBody).multiplyScalar(-D)
				.addScaledVector(S.liftDir, L)
				.addScaledVector(S.sideDir, Y);

			// Rotate to world frame.
			S.aeroWorld.copy(S.aeroBody).applyQuaternion(this.quaternion);

			// Track load factor for HUD: vertical lift component / weight.
			this.loadFactor = L / (this.mass * GRAVITY);
		} else {
			this.alpha = 0;
			this.beta = 0;
			this.loadFactor = 0;
		}

		// Gravity in world ENU (-Z is down).
		S.gravity.set(0, 0, -GRAVITY * this.mass);

		// Sum → linear acceleration. Semi-implicit: update velocity first.
		S.forceWorld.copy(S.thrustWorld).add(S.aeroWorld).add(S.gravity);
		S.linAccel.copy(S.forceWorld).divideScalar(this.mass);
		this.velocity.addScaledVector(S.linAccel, dt);

		// ---- 2. Moments (body frame) -------------------------------------
		// Fly-by-wire G-limiter: attenuate pull-up stick when approaching the
		// structural envelope. Mimics the behavior of a real flight control
		// computer — the pilot can't command more G than the airframe can
		// handle, but has full authority everywhere else.
		let pitchInput = input.pitch;
		this.gLimiterActive = false;
		if (pitchInput > 0 && this.loadFactor > this.gSoftLimit) {
			const t = (this.loadFactor - this.gSoftLimit) / (this.gHardLimit - this.gSoftLimit);
			const attenuation = Math.max(0, 1 - t);
			pitchInput *= attenuation;
			this.gLimiterActive = (attenuation < 1);
		}

		// Control surface moments scale with dynamic pressure q̄.
		S.moment.set(
			this.inputSign.x * pitchInput  * this.controlCoef.x * q,
			this.inputSign.y * input.roll  * this.controlCoef.y * q,
			this.inputSign.z * input.yaw   * this.controlCoef.z * q,
		);

		// ---- Control-authority floor (Phase 7b) --------------------------
		// Small q̄-independent moment so elevator/aileron/rudder do
		// *something* at near-zero airspeed (jet wash, FCS authority).
		// Lets the pilot recover attitude after a botched cobra instead
		// of helplessly tumbling to the ground.
		const floor = this.controlAuthorityFloor;
		S.moment.x += this.inputSign.x * pitchInput  * floor.pitch;
		S.moment.y += this.inputSign.y * input.roll  * floor.roll;
		S.moment.z += this.inputSign.z * input.yaw   * floor.yaw;

		// ---- Thrust vectoring (Phase 7a) ---------------------------------
		// Thrust-based pitch (and optionally yaw) moment, faded by airspeed
		// so it dominates only at low V where aero authority has died.
		// At V > vMax + fadeBand the nozzles are neutral and the airframe
		// flies on aero surfaces alone.
		if (this.tv) {
			const tvFade = THREE.MathUtils.clamp(
				1 - (V - this.tv.vMax) / Math.max(1e-3, this.tv.fadeBand),
				0, 1,
			);
			if (tvFade > 0) {
				const tvMoment = thrustMag * this.tv.authority * tvFade;
				S.moment.x += this.inputSign.x * pitchInput * tvMoment;
				if (this.tv.axes === 'pitchYaw') {
					S.moment.z += this.inputSign.z * input.yaw * tvMoment;
				}
				// Effective nozzle deflection for the flame renderer.
				// MAX_NOZZLE = 20° matches F-119 thrust-vectoring spec.
				const MAX_NOZZLE = 20 * Math.PI / 180;
				this.tvDeflection.pitch = pitchInput * tvFade * MAX_NOZZLE;
				this.tvDeflection.yaw = (this.tv.axes === 'pitchYaw')
					? input.yaw * tvFade * MAX_NOZZLE
					: 0;
			} else {
				this.tvDeflection.pitch = 0;
				this.tvDeflection.yaw = 0;
			}
		} else {
			this.tvDeflection.pitch = 0;
			this.tvDeflection.yaw = 0;
		}

		// ---- Departure / wing-rock at high alpha (Phase 7b) --------------
		// Past critical α at non-trivial airspeed, asymmetric vortex
		// shedding gives the airframe a yaw kick (and a smaller roll
		// kick — wing rock). Cheaper than a real CFD model: a smoothly
		// varying pseudo-noise sourced from the integrator's accumulated
		// "phase". Magnitude scales with how far past stall we are and
		// dies above ~250 m/s where stable aero takes over.
		const alphaStallRad = this.alphaStallDeg * Math.PI / 180;
		const alphaExcess = Math.abs(this.alpha) - alphaStallRad;
		if (alphaExcess > 0 && this.departureSusceptibility > 0) {
			this._departurePhase += dt * 6.0; // ~1 Hz wing-rock-ish
			const excessFactor = Math.min(1, alphaExcess / (15 * Math.PI / 180));
			const speedFactor  = Math.max(0, 1 - V / 250);
			// Treat departureSusceptibility as a dimensionless yaw-moment
			// coefficient and scale by q̄·S to land in N·m.
			const kick = this.departureSusceptibility * excessFactor * speedFactor
			           * q * this.wingArea * 0.5;
			S.moment.z += kick * Math.sin(this._departurePhase);
			S.moment.y += kick * 0.4 * Math.sin(this._departurePhase * 1.7 + 1.3);
		}

		// Aerodynamic rate damping scales with ρV (linear in airspeed).
		// At V=0 this is zero — airframe tumbles freely, which is physically
		// correct. Controls also vanish, so an out-of-control tumble at
		// stall speed cannot be recovered with stick alone — also correct.
		const rhoV = rho * V;
		S.damp.set(
			-this.dampingCoef.x * rhoV * this.angularVelocity.x,
			-this.dampingCoef.y * rhoV * this.angularVelocity.y,
			-this.dampingCoef.z * rhoV * this.angularVelocity.z,
		);
		S.moment.add(S.damp);

		// Static stability: restoring moments from flow-axis deviations.
		// Both scale with q̄·S like real aero moments — at low airspeed the
		// aircraft loses stability along with control authority, which is
		// why stalled jets spin and tumble.
		if (V > 1.0) {
			const qS = q * this.wingArea;
			S.moment.x -= this.pitchStabilityCoef * qS * (this.alpha - this.alphaTrim);
			S.moment.z -= this.yawStabilityCoef   * qS *  this.beta;
		}

		// Angular acceleration: α = I⁻¹ · M  (diagonal inertia, elementwise).
		S.angAccel.set(
			S.moment.x / this.inertia.x,
			S.moment.y / this.inertia.y,
			S.moment.z / this.inertia.z,
		);
		this.angularVelocity.addScaledVector(S.angAccel, dt);

		// Integrate the body→world quaternion by body-frame ω.
		integrateQuaternion(this.quaternion, this.angularVelocity, dt);
	}

	// Altitude is owned by main.js (lon/lat/alt state); the physics module
	// does not track it. For the density model we accept a small lag: main.js
	// pokes the last known altitude into this.currentAltitude each frame.
	_approxAltitude() {
		return this.currentAltitude ?? 5000;
	}

	_thrustMagnitude() {
		// Thrust = (mil regime, scaled by throttle) + (AB bonus if lit),
		// both reduced by the altitude density factor. The idle floor keeps
		// a small amount of thrust at throttle = 0 like a real jet engine.
		//
		//   T_sea  = T_mil · (idle + (1 − idle) · throttle)
		//            + (AB ? (T_max − T_mil) : 0)
		//   T(alt) = T_sea · (ρ(alt)/ρ_0)^0.7
		const alt = this._approxAltitude();
		const altFactor = thrustAltitudeFactor(alt);

		const milFraction = this.idleThrottle + (1 - this.idleThrottle) * this.throttle;
		const milThrust = this.thrustDryMax * milFraction;
		const abBonus = this.isBoosting ? (this.thrustABMax - this.thrustDryMax) : 0;

		return (milThrust + abBonus) * altFactor;
	}
}
