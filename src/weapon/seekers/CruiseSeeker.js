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
		// Terrain altitude beneath the missile, sampled lazily for
		// ALCM-style TFR. Cesium's globe.getHeight is synchronous and
		// cheap; we cache the last valid sample so a frame with a
		// missing tile reuses the previous value instead of dropping
		// to alt=0 and slamming the missile into the dirt.
		this._lastTerrainAlt = startPos.alt - 100;
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

	_guide(dt) {
		if (this.lostLock || !this._targetCoord) return;

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
		// BOOST → CLIMB once the motor is out (parent advances
		// boostRemaining each frame).
		if (this._phase === STATE_BOOST && this.boostRemaining <= 0) {
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
		// CRUISE → DIVE: angle-triggered. Hold cruise altitude until
		// the look-down angle to target meets the configured dive
		// angle, THEN dive. Fallback geometric trigger at horizRange
		// ≤ terminalRangeM for the rare case where geometry never
		// gets steep enough (target above cruise alt). Skips the
		// pop-up phase entirely — TFR-class cruise weapons (ALCM,
		// Storm Shadow at 50–120 m AGL) basically slam into the
		// target from cruise altitude; the prior elaborate pop-up
		// was both unrealistic ("ALCM launches really high" feel)
		// and produced a flat pre-impact path that hit terrain.
		if (this._phase === STATE_CRUISE) {
			const lookDownDeg = Math.atan2(-dU, Math.max(1, horizRange)) * 180 / Math.PI;
			const trigger = lookDownDeg >= Math.abs(f.diveAngleDeg) ||
				horizRange <= f.terminalRangeM;
			if (trigger) this._phase = STATE_DIVE;
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
			case STATE_DIVE: {
				// Hold a dive pitched at LEAST as steep as the
				// configured diveAngleDeg, but use the geometric
				// required pitch if the actual look-down to target
				// is steeper (because the missile is high or close).
				// Without this clamp the missile would hold a flat
				// -45° all the way down and overshoot whenever the
				// real geometry calls for -60° — which is exactly
				// what happens after the pop-up phase, when the
				// missile is briefly above its dive line.
				const geometricPitch = Math.atan2(dU, Math.max(1, horizRange)) * 180 / Math.PI;
				desiredHeading = desiredHeadingToTgt;
				desiredPitch   = Math.min(geometricPitch, f.diveAngleDeg);
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
