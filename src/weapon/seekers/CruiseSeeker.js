// ============================================================================
// CruiseSeeker — long-range cruise missiles (AGM-86 ALCM, AGM-158 JASSM /
// Storm Shadow class).
//
// Carries a frozen GPS target (same as JDAM) but flies a 4-stage profile
// instead of a straight ballistic arc:
//
//   BOOST    — short motor burn off the rail, speed picks up to cruise.
//              Parent's boost path handles thrust/speed; we just lock
//              attitude to launch heading + a small climb angle so the
//              missile clears the launcher.
//   CLIMB    — pitch up to climbAngleDeg, ascend until current alt
//              reaches cruise altitude (MSL for JASSM, AGL for ALCM).
//   CRUISE   — hold cruise altitude with proportional pitch correction;
//              wide-turn navigate toward the target. Lower G ceiling
//              than the terminal phase so the missile flies a smooth
//              cruise path instead of yanking around mid-flight.
//              ALCM additionally uses globe.getHeight for terrain-
//              following: target alt = terrain + cruiseAltAGL each frame.
//   TERMINAL — when horizontal range to target ≤ terminalRangeM, pop up
//              to popUpAltAGL then dive on the GPS coord at full
//              terminal turn G. Same coordinate-PN math the JDAM uses.
//
// Required munition JSON fields (validated by validateMunitionSpec
// 'cruise' entry):
//   flight.cruiseAltM        — target cruise altitude (m)
//   flight.cruiseAltMode     — 'agl' | 'msl'
//   flight.cruiseTurnG       — max G during cruise (typically 1.5–3)
//   flight.climbAngleDeg     — pitch during CLIMB phase
//   flight.terminalRangeM    — horizontal range to switch CRUISE→TERMINAL
//   flight.popUpAltAGL       — pop-up apex altitude AGL (terminal climb)
//   flight.diveAngleDeg      — pitch (negative) during terminal dive
//
// Inherits all the universal flight + seeker.maxG fields. Uses
// seeker.maxG as the terminal turn cap.
// ============================================================================

import * as Cesium from 'cesium';
import { Missile } from '../missile.js';

const STATE_BOOST    = 'BOOST';
const STATE_CLIMB    = 'CLIMB';
const STATE_CRUISE   = 'CRUISE';
const STATE_POPUP    = 'POPUP';     // ALCM-style climb to popUpAlt before diving
const STATE_DIVE     = 'DIVE';      // hold fixed dive angle toward target
const STATE_TERMINAL = 'TERMINAL';  // close-in PN to coord

export class CruiseSeeker extends Missile {
	constructor(scene, viewer, startPos, heading, pitch, speed,
		target = null, onKill = null, launcher = null, data = null) {
		super(scene, viewer, startPos, heading, pitch, speed, target, onKill, launcher, data);

		if (target && typeof target === 'object' && 'lon' in target && 'lat' in target) {
			this._targetCoord = {
				lon: target.lon,
				lat: target.lat,
				alt: target.alt ?? 0,
			};
		} else {
			this._targetCoord = null;
			this.lostLock = true;
			console.warn('[CruiseSeeker] launched without a target coord; will fly ballistic');
		}

		this._phase = STATE_BOOST;
		// Seeker BOOST phase timer — counts up from launch and gates
		// the BOOST→CLIMB transition. DECOUPLED from the parent's
		// boostRemaining (which now spans the entire flight to model
		// the turbojet sustainer): the seeker BOOST is the short
		// "off the rail, hold launch attitude" leg, ~2 s, after which
		// CLIMB begins regardless of whether the motor is still
		// running.
		this._phaseTimer = 0;
		this._seekerBoostS = 2.0;
		// Terrain altitude beneath the missile, sampled lazily for
		// ALCM-style TFR. Cesium's globe.getHeight is synchronous and
		// cheap; we cache the last valid sample so a frame with a
		// missing tile reuses the previous value instead of dropping
		// to alt=0 and slamming the missile into the dirt.
		this._lastTerrainAlt = startPos.alt - 100;

		// Terminal-phase plan, computed once at CRUISE→POPUP transition
		// (see _planTerminalDive). Holds the apex altitude (MSL) the
		// pop-up climbs to and the minimum dive angle the dive must
		// hold. Using a frozen plan instead of recomputing each frame
		// avoids the apex/range targets drifting as the missile flies
		// the climb (which is what made the previous angle-only
		// trigger so brittle).
		this._diveApexAltMSL = null;
		this._minDiveAngleDeg = null;
	}

	_terrainAtCurrent() {
		try {
			const carto = Cesium.Cartographic.fromDegrees(this.lon, this.lat);
			const h = this.viewer.scene.globe.getHeight(carto);
			if (h != null && Number.isFinite(h)) {
				this._lastTerrainAlt = h;
				return h;
			}
		} catch (_) { /* fall through */ }
		return this._lastTerrainAlt;
	}

	// Forward-look terrain max over a lookahead corridor. Sample
	// terrain at N points spaced along the missile's heading and
	// return the HIGHEST elevation found. TFR uses this so the
	// missile climbs to clear ridges BEFORE it reaches them.
	//
	// At 250 m/s cruise the lookahead distance directly maps to
	// reaction time:  6 km lookahead = 24 s.  At a max climb rate
	// of ~70 m/s (achievable when the emergency-G boost in CRUISE
	// kicks in) that gives ~1700 m of altitude gain potential
	// before reaching whatever terrain feature is at the far end
	// of the lookahead — enough to clear most mountain ridges in
	// the SEAD-scenario terrain.
	//
	// Sample density (15 every 400 m) ensures a sharp ridge near
	// either end of the corridor still gets picked up; the previous
	// 5-sample density could miss a ridge that fell between two
	// samples 400 m apart.
	_forwardTerrainMax(lookAheadM = 6000, samples = 15) {
		const headingRad = this.heading * Math.PI / 180;
		const cosLat = Math.cos(this.lat * Math.PI / 180) || 1;
		let maxH = this._terrainAtCurrent();
		for (let i = 1; i <= samples; i++) {
			const d = (lookAheadM * i) / samples;
			const dN = d * Math.cos(headingRad);
			const dE = d * Math.sin(headingRad);
			const lat = this.lat + (dN / 111320);
			const lon = this.lon + (dE / (111320 * cosLat));
			try {
				const carto = Cesium.Cartographic.fromDegrees(lon, lat);
				const h = this.viewer.scene.globe.getHeight(carto);
				if (h != null && Number.isFinite(h) && h > maxH) maxH = h;
			} catch (_) { /* skip */ }
		}
		return maxH;
	}

	// Forward-simulate the entire pop-up + arc-over + dive maneuver
	// using the same G-limited pitch model the missile will actually
	// fly under, and return the horizontal distance the maneuver will
	// consume. The CRUISE→POPUP trigger fires when horizRange ≤ this
	// number, so the missile begins the maneuver exactly far enough
	// out to finish it directly over the target.
	//
	// This replaces a closed-form geometric estimate that assumed
	// instantaneous pitch changes. The bulk of the wall-clock during
	// the terminal phase is actually spent ROTATING the airframe (at
	// ~G·g/v rad/s), and treating those rotations as instantaneous
	// undersized the trigger by ~50% — the missile reached apex
	// directly over the target instead of well short of it.
	//
	// The simulation uses 50 ms steps and ~3 minutes max, both more
	// than enough margin for any realistic cruise-missile terminal
	// phase. Cost per call is a few hundred trig ops — fine to run
	// every frame in CRUISE; the planning math runs ~1× per second
	// in practice (cruise is typically the longest phase).
	_simulateTerminalDistance(t) {
		const f = this.data.flight;
		const diveAngleDeg = Math.max(45, Math.abs(f.diveAngleDeg));
		const apexAGL      = Math.max(600, f.popUpAltAGL || 0);
		// Apex altitude is referenced to the TARGET, not to terrain
		// under the missile. With a valley target the missile may be
		// cruising over much higher ridges; using missile-local terrain
		// makes apex shift around as the missile flies, and the trigger
		// range collapses to nothing right as the missile crosses into
		// the valley (terrain reading plummets, apex plummets with it,
		// dive-distance estimate plummets, trigger fires far too late).
		// Anchoring apex to target altitude keeps the geometry stable.
		const apexMSL      = t.alt + apexAGL;
		const popupPitchDeg = 30;
		// Use an estimate of the speed the missile will be flying at
		// during the maneuver. At full pop-up the missile loses some
		// energy; using current speed as the proxy is fine — the
		// trigger is range-based, so a ~10% speed estimation error
		// just shifts the trigger by ~10%, well inside the safety
		// multiplier below.
		const v = Math.max(80, this.speed);
		const G = this.data.seeker.maxG;
		// Pitch rate available at this speed/G, rad/s. Same formula as
		// the per-phase guidance below — keeps the sim and the actual
		// guidance consistent.
		const omega = (G * 9.81) / v;
		const popupPitch = popupPitchDeg * Math.PI / 180;
		const divePitch  = -diveAngleDeg * Math.PI / 180;

		const dt = 0.05;
		let alt   = this.alt;
		let pitch = 0;     // assume level cruise at trigger time
		let dist  = 0;     // horizontal distance covered so far
		let elapsed = 0;

		// Phase 1: rotate up to popup pitch and climb to apex.
		// Pitch ramps in at omega; climb continues at popup pitch
		// until alt reaches apex MSL.
		while (alt < apexMSL && elapsed < 120) {
			pitch = Math.min(popupPitch, pitch + omega * dt);
			dist += v * Math.cos(pitch) * dt;
			alt  += v * Math.sin(pitch) * dt;
			elapsed += dt;
		}
		// Phase 2+3: arc over from popup pitch through level to
		// dive pitch, then hold dive pitch (with PN-style steepening
		// near the ground) until impact altitude. Mirrors the actual
		// DIVE-phase guidance below — pitch rate is G-limited at
		// omega rad/s, target pitch is the steeper of the configured
		// dive and the geometric line to target.
		while (alt > t.alt && elapsed < 120) {
			const altAboveTarget = alt - t.alt;
			let desiredPitch;
			if (altAboveTarget > 200) {
				// Bulk of the dive — hold the configured pitch.
				desiredPitch = divePitch;
			} else {
				// Final ~200m: PN steepening. Assume the missile is
				// on a "good" dive line so remaining horizontal
				// range ≈ altAboveTarget / tan(diveAngle), and
				// take the steeper of geomPitch / divePitch.
				const remHoriz = Math.max(20, altAboveTarget / Math.tan(-divePitch));
				const geomPitch = Math.atan2(-altAboveTarget, remHoriz);
				desiredPitch = Math.min(geomPitch, divePitch);
			}
			const dPitch = desiredPitch - pitch;
			pitch += Math.max(-omega * dt, Math.min(omega * dt, dPitch));
			dist += v * Math.cos(pitch) * dt;
			alt  += v * Math.sin(pitch) * dt;
			elapsed += dt;
		}
		// No safety multiplier. The sim already models the
		// dominant effects (G-limited rotation rate, full pop-up
		// climb, full arc-over). Biasing the trigger EARLIER
		// (multiplier > 1.0) causes the missile to consume its
		// altitude budget short of the target and crash into the
		// ground with no recovery option. Slight LATE bias is
		// fine: in-flight PN steepens the dive past the configured
		// minimum to nail the target.
		return dist;
	}

	// Freeze the dive plan at CRUISE→POPUP transition. Everything that
	// follows (the POPUP transition gate, the DIVE pitch clamp) reads
	// these numbers. Frozen-at-transition rather than recomputed each
	// frame because the missile's own climb shifts the apex/angle math
	// otherwise; we want one plan that the missile then flies.
	_planTerminalDive(t) {
		const f = this.data.flight;
		const diveAngle = Math.max(45, Math.abs(f.diveAngleDeg));
		const apexAGL   = Math.max(600, f.popUpAltAGL || 0);
		// Apex anchored to target altitude — see comment in
		// _simulateTerminalDistance for why missile-local terrain is
		// the wrong reference for valley targets in mountainous SEAD
		// scenarios.
		this._diveApexAltMSL  = t.alt + apexAGL;
		this._minDiveAngleDeg = diveAngle;
	}

	_guide(dt) {
		if (this.lostLock || !this._targetCoord) return;

		this._phaseTimer += dt;

		const t = this._targetCoord;
		const f = this.data.flight;
		const cosLat = Math.cos(this.lat * Math.PI / 180);
		const dE = (t.lon - this.lon) * 111320 * cosLat;
		const dN = (t.lat - this.lat) * 111320;
		const dU = (t.alt - this.alt);
		const horizRange = Math.sqrt(dE * dE + dN * dN);
		const slantRange = Math.sqrt(dE * dE + dN * dN + dU * dU);
		const desiredHeadingToTgt = (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360;

		// ---- Phase advance ---------------------------------------------------
		// BOOST → CLIMB once the seeker boost timer elapses. NOT
		// tied to the parent's boostRemaining anymore: the parent's
		// boost duration covers the entire flight to model a
		// turbojet sustainer, but the seeker's "BOOST" is just the
		// short period where the missile holds launch attitude
		// before starting to climb to cruise alt.
		if (this._phase === STATE_BOOST && this._phaseTimer >= this._seekerBoostS) {
			this._phase = STATE_CLIMB;
		}
		// CLIMB → CRUISE once we've reached the cruise altitude target
		// (taking AGL/MSL mode into account). Use the forward-look
		// terrain so we don't transition prematurely just because
		// we're currently above a valley.
		if (this._phase === STATE_CLIMB) {
			const cruiseTargetAlt = (f.cruiseAltMode === 'agl')
				? this._forwardTerrainMax() + f.cruiseAltM
				: f.cruiseAltM;
			if (this.alt >= cruiseTargetAlt - 50) this._phase = STATE_CRUISE;
		}
		// CRUISE → POPUP: range-triggered using a geometric plan.
		// At low TFR cruise altitudes (50–150 m AGL) the look-down
		// angle to a ground target is essentially zero until the
		// missile is on top of it — by then there's no horizontal
		// distance left to pitch over, and the missile overshoots.
		// Solution: pop UP to an apex high enough that a steep
		// (≥45°) dive from apex covers a usable terminal distance,
		// AND start that pop-up far enough out that the climb +
		// dive geometry actually fits before overflight.
		// _planTerminalDive sizes both numbers from the configured
		// popUpAltAGL + diveAngleDeg + climb performance so a single
		// "pop now" range threshold gets us into the right place.
		if (this._phase === STATE_CRUISE) {
			const popRange = this._simulateTerminalDistance(t);
			if (horizRange <= popRange) {
				this._planTerminalDive(t);
				console.log('[CruiseSeeker] POPUP at',
					`horiz=${horizRange.toFixed(0)}m`,
					`(plan needed ${popRange.toFixed(0)}m)`,
					`apex=${(this._diveApexAltMSL - this.alt).toFixed(0)}m above current`,
					`dive=${this._minDiveAngleDeg}°`,
					`speed=${this.speed.toFixed(0)}m/s`,
					`G=${this.data.seeker.maxG}`);
				this._phase = STATE_POPUP;
			}
		}
		// POPUP → DIVE: leave the climb as soon as EITHER we've reached
		// the planned apex altitude OR the geometric look-down angle to
		// the target meets the planned minimum dive angle (whichever
		// comes first — if the climb gets us above the dive line early,
		// no point continuing to climb past it).
		if (this._phase === STATE_POPUP) {
			const lookDownDeg = Math.atan2(-dU, Math.max(1, horizRange)) * 180 / Math.PI;
			const apexReached = (this._diveApexAltMSL != null) &&
				(this.alt >= this._diveApexAltMSL - 30);
			const angleReached = (this._minDiveAngleDeg != null) &&
				(lookDownDeg >= this._minDiveAngleDeg);
			if (apexReached || angleReached) this._phase = STATE_DIVE;
		}
		// DIVE → TERMINAL within close-in PN range so the seeker
		// makes its final corrections directly at the spot.
		if (this._phase === STATE_DIVE && slantRange < 800) {
			this._phase = STATE_TERMINAL;
		}

		// ---- Per-phase guidance --------------------------------------------
		let desiredHeading;
		let desiredPitch;
		let turnGCap;
		switch (this._phase) {
			case STATE_BOOST: {
				// Hold launch attitude with a small climb. Don't try to
				// turn yet — we're still on the launch rail's energy.
				desiredHeading = this.heading;
				desiredPitch   = Math.max(this.pitch, 5);
				turnGCap       = 1.5;
				break;
			}
			case STATE_CLIMB: {
				// Climb at the configured angle, while turning toward
				// the target heading at the cruise G ceiling.
				desiredHeading = desiredHeadingToTgt;
				desiredPitch   = f.climbAngleDeg;
				turnGCap       = f.cruiseTurnG;
				break;
			}
			case STATE_CRUISE: {
				// Hold the cruise altitude target via proportional
				// pitch. AGL mode uses the FORWARD terrain max so
				// the missile climbs to clear a ridge BEFORE it
				// hits one.
				//
				// SAFETY_BUFFER_M added on top of cruiseAltM so the
				// missile starts climbing while there's still margin
				// — without the buffer, a step in the lookahead-max
				// terrain reads as "exactly at cruise alt" and the
				// missile holds level instead of climbing, then
				// arrives at the ridge with no margin.
				//
				// Asymmetric gains: climb aggressively (5°/m of
				// positive error, capped at 50°), descend gently.
				// Emergency-G boost on positive error so the pitch
				// can swing up fast — the configured cruiseTurnG is
				// for navigation, not survival.
				const SAFETY_BUFFER_M = 60;
				const cruiseTargetAlt = (f.cruiseAltMode === 'agl')
					? this._forwardTerrainMax() + f.cruiseAltM + SAFETY_BUFFER_M
					: f.cruiseAltM;
				const altErr = cruiseTargetAlt - this.alt;
				if (altErr > 0) {
					desiredPitch = Math.min(50, altErr * 5.0);
					turnGCap     = this.data.seeker.maxG;
				} else {
					desiredPitch = Math.max(-10, altErr / 200 * 5);
					turnGCap     = f.cruiseTurnG;
				}
				desiredHeading = desiredHeadingToTgt;
				break;
			}
			case STATE_POPUP: {
				// Pull up at a fixed 30° pitch using the missile's
				// full G allowance — we need to gain altitude FAST
				// so the geometric dive line opens up before
				// overflight. _popUpTriggerRange sized the entry
				// range using this same 30° figure, so don't change
				// it here without updating both.
				desiredHeading = desiredHeadingToTgt;
				desiredPitch   = 30;
				turnGCap       = this.data.seeker.maxG;
				break;
			}
			case STATE_DIVE: {
				// Hold a dive pitched at LEAST as steep as the
				// planned minimum angle (≥45°), but go steeper if
				// the actual look-down geometry to the target is
				// steeper (because we're high enough). Negative-
				// pitch convention: -55° is steeper than -45°, so
				// the steeper of two options is `min(geometricPitch,
				// -minDiveAngle)`.
				const geometricPitch = Math.atan2(dU, Math.max(1, horizRange)) * 180 / Math.PI;
				const minDive = -(this._minDiveAngleDeg || Math.max(45, Math.abs(f.diveAngleDeg)));
				desiredHeading = desiredHeadingToTgt;
				desiredPitch   = Math.min(geometricPitch, minDive);
				turnGCap       = this.data.seeker.maxG;
				break;
			}
			case STATE_TERMINAL: {
				// Close-in PN-to-coord — direct line at the spot for
				// the last few hundred metres. This is what fixes any
				// residual offset from the fixed dive angle.
				desiredHeading = desiredHeadingToTgt;
				desiredPitch   = Math.atan2(dU, Math.max(1, horizRange)) * 180 / Math.PI;
				turnGCap       = this.data.seeker.maxG;
				break;
			}
		}

		let dH = desiredHeading - this.heading;
		while (dH < -180) dH += 360;
		while (dH >  180) dH -= 360;
		const dP = desiredPitch - this.pitch;

		// G-limited turn cap, scaled by speed-vs-vRef as elsewhere.
		const qFactor = Math.min(1, Math.max(f.gAvailFloor,
			(this.speed * this.speed) / (f.vManeuverRef * f.vManeuverRef)));
		const gAvail = turnGCap * qFactor;
		const maxTurnRad = (gAvail * 9.81) / Math.max(50, this.speed);
		const capDeg = (maxTurnRad * 180 / Math.PI) * dt;

		const pn = f.pnGain;
		this.heading += Math.max(-capDeg, Math.min(capDeg, dH * pn * dt));
		this.pitch   += Math.max(-capDeg, Math.min(capDeg, dP * pn * dt));
		this.pitch   = Math.max(-89, Math.min(89, this.pitch));

		this.debug = {
			rangeToTarget: slantRange,
			headingError:  dH,
			pitchError:    dP,
			mode:          this._phase,
			targetName:    'COORD',
		};
	}
}
