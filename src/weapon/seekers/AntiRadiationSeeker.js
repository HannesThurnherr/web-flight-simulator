// ============================================================================
// AntiRadiationSeeker — AGM-88 HARM and family.
//
// Passive seeker: listens for radar emissions and homes on the strongest
// emitter in its launch FOV. NO transmitter of its own — the target gets
// no RWR spike from the missile itself, which is the whole point of
// anti-radiation guidance. The target's only warning is whatever its own
// search radar sees of the inbound missile (typical defence: shut radar
// off for several seconds and the HARM has nothing to track).
//
// Lifecycle:
//   1. At launch, scan all hostile units that are radiating
//      (`sensors.radar.active === true && mode !== 'off'`) within the
//      seeker's forward cone. Score by emission strength /
//      distance². Lock onto the best.
//   2. Each frame, if the locked emitter is still radiating, PN toward
//      it. Update last-known-position.
//   3. If the emitter shuts down, dead-reckon toward last-known for
//      `emissionLossMemoryS` seconds. Real B/C HARM behaviour — the
//      SAM bets that the missile guesses wrong; the missile bets the
//      SAM is parked at LKP.
//   4. If the emitter comes back inside FOV during the memory window,
//      re-acquire and resume PN.
//   5. After the memory window expires with no re-acquire, go ballistic
//      (lostLock=true).
//
// What it doesn't do (yet):
//   - Manual emitter selection by the player (autonomous "best-in-cone"
//     at launch only — fine for Phase 5a; refinement is a follow-up).
//   - Towed/expendable emitter decoys (ALE-50 etc). Roadmap item once
//     EW (Phase 6) lands.
//   - GPS/INS backup ("AARGM" mode) for moving emitters that have
//     repositioned. The classic HARM coasts to LKP and that's enough
//     for stationary SAM batteries.
// ============================================================================

import * as Cesium from 'cesium';
import { Missile } from '../missile.js';
import { isRadiating } from '../../systems/sensorSystem.js';

export class AntiRadiationSeeker extends Missile {
	constructor(scene, viewer, startPos, heading, pitch, speed,
		target = null, onKill = null, launcher = null, data = null) {
		super(scene, viewer, startPos, heading, pitch, speed, target, onKill, launcher, data);

		const seeker = this.data && this.data.seeker || {};
		this._fovHalfRad = ((seeker.fovHalfAngleDeg ?? 40) * Math.PI) / 180;
		this._emissionLossMemoryS = seeker.emissionLossMemoryS ?? 10;

		// Last known emitter position. Updated every tick the lock is
		// "live" (target still radiating). When the radar shuts down we
		// freeze this and dead-reckon to it. Stays null until first
		// successful detection — pre-launch target hand-off (the unused
		// `target` arg) gets ignored if it isn't actually radiating.
		this._lkp = null;
		this._emissionLostAt = null; // sim-age when emission first dropped

		// At-launch acquisition. Two modes:
		//   1. Player-designated: the firing path passes a specific
		//      emitter as `target`. Trust it unconditionally — the
		//      caller (weaponSystem.fire) has already validated it's
		//      a live radiating hostile. Skip the FOV check on
		//      purpose: real HARMs accept off-boresight launches and
		//      turn to acquire as they fly. If we re-check FOV here a
		//      slightly off-axis designation falls back to auto-scan
		//      and the missile chases the wrong SAM, which is the
		//      whole bug we're trying to avoid.
		//   2. Auto-acquire: no `target` was passed, scan the
		//      launcher's known world and lock the strongest emitter
		//      in our forward cone.
		const npcs = (launcher && launcher.npcs) ? launcher.npcs : [];
		const candidates = [...npcs];
		let acquired = null;
		if (target && !target.destroyed && target.active !== false) {
			acquired = target;
			// Lock the designation: in-flight re-scans must not switch
			// to a different emitter. Player explicitly picked this
			// SAM; if it shuts down we coast to LKP and let the
			// `emissionLossMemoryS` window decide success or failure,
			// rather than swapping onto whatever else is loud.
			this._playerDesignated = true;
		} else {
			acquired = this._scanForEmitter(candidates) || null;
			this._playerDesignated = false;
		}
		this.target = acquired;
		if (this.target) {
			this._refreshLkp(this.target);
		} else {
			// No emitter in cone at launch — go directly to memory mode
			// with no LKP. Will spend `emissionLossMemoryS` searching
			// for an emitter to come on within FOV; if none does, dies
			// ballistic.
			this._emissionLostAt = this._age || 0;
		}

		// HARM doesn't get a tone or RWR cue — passive seeker. Set lostLock
		// false explicitly so the parent's guidance gating works (parent
		// uses `lostLock` to skip _guide). We'll set lostLock=true ourselves
		// only after the memory window expires with no re-acquire.
		this.lostLock = false;
	}

	// Score a radiating unit. Higher = better target.
	// Cheap inverse-square emission proxy: `radar.nominalRange / dist²`.
	// Stronger emitters and closer ones win. Doesn't do RX-power-budget
	// math because the actual physics is already implicit in nominalRange.
	_emitterScore(u) {
		if (!u || u.destroyed || u.active === false) return 0;
		if (u === this.launcher) return 0;
		if (u.team && this.team && u.team === this.team) return 0;
		if (!isRadiating(u)) return 0;
		const r = u.sensors.radar;
		// FOV check (simple cosine — narrower than the wide ±90° an
		// active-radar AAM uses).
		const cosLat = Math.cos((this.lat || 0) * Math.PI / 180);
		const dE = (u.lon - this.lon) * 111320 * cosLat;
		const dN = (u.lat - this.lat) * 111320;
		const dU = (u.alt - this.alt);
		const range = Math.sqrt(dE * dE + dN * dN + dU * dU);
		if (range < 1) return 0;
		const hRad = this.heading * Math.PI / 180;
		const pRad = this.pitch   * Math.PI / 180;
		const fwdE = Math.sin(hRad) * Math.cos(pRad);
		const fwdN = Math.cos(hRad) * Math.cos(pRad);
		const fwdU = Math.sin(pRad);
		const losE = dE / range;
		const losN = dN / range;
		const losU = dU / range;
		const cosA = fwdE * losE + fwdN * losN + fwdU * losU;
		if (cosA < Math.cos(this._fovHalfRad)) return 0;
		const txStrength = r.nominalRange || 50000;
		return txStrength / Math.max(1, range * range);
	}

	_scanForEmitter(units) {
		let best = null;
		let bestScore = 0;
		for (const u of units) {
			const s = this._emitterScore(u);
			if (s > bestScore) { bestScore = s; best = u; }
		}
		return best;
	}

	_refreshLkp(target) {
		if (!target) return;
		this._lkp = { lon: target.lon, lat: target.lat, alt: target.alt };
		this._emissionLostAt = null;
	}

	// Override guidance. Each frame:
	//   - If target still radiating → refresh LKP + PN toward it.
	//   - Else → set _emissionLostAt timestamp on first loss; PN to LKP.
	//     If the loss has lasted longer than emissionLossMemoryS, go
	//     ballistic (lostLock=true). Periodically re-scan for any new
	//     emitter that's come up in the FOV — if found, lock onto it
	//     and resume.
	_guide(dt) {
		if (this.lostLock) return;

		const radarLive = isRadiating(this.target);

		if (radarLive) {
			this._refreshLkp(this.target);
		} else {
			// Emission gone. Mark first-loss instant. Re-scan
			// occasionally for a replacement emitter (handles the
			// "EWR died, but a Tor came on" case mid-flight).
			if (this._emissionLostAt == null) this._emissionLostAt = this._age;
			const lostFor = this._age - this._emissionLostAt;

			// Re-scan every 0.5 s during memory window.
			//   - Auto-acquired shots: any radiating hostile is fair
			//     game (handles "EWR died but a Tor came on").
			//   - Player-designated shots: only re-acquire if the
			//     ORIGINAL target comes back on (e.g. SA-15 finishes
			//     its emcon cycle). Never switch to a different unit
			//     — the player picked that specific SAM.
			this._reacqTimer = (this._reacqTimer || 0) + dt;
			if (this._reacqTimer >= 0.5) {
				this._reacqTimer = 0;
				if (this._playerDesignated) {
					if (this._emitterScore(this.target) > 0) {
						// Original target is radiating again and in
						// cone — resume tracking it.
						this._refreshLkp(this.target);
					}
				} else {
					const npcs = (this.launcher && this.launcher.npcs) ? this.launcher.npcs : [];
					const newTarget = this._scanForEmitter(npcs);
					if (newTarget) {
						this.target = newTarget;
						this._refreshLkp(newTarget);
					}
				}
			}

			if (lostFor > this._emissionLossMemoryS) {
				this.lostLock = true;
				return;
			}
		}

		// PN guidance toward the best-known position. If we have a fresh
		// emitter, that's its current position (already refreshed into
		// LKP above). If we're in memory mode, that's the freeze.
		if (!this._lkp) return;
		const lkp = this._lkp;

		// Lead-pursuit isn't meaningful for stationary SAMs (the LKP
		// doesn't move); skip the velocity-extrapolation step the AAMs
		// do, just steer at the LKP.
		const cosLat = Math.cos(this.lat * Math.PI / 180);
		const dE = (lkp.lon - this.lon) * 111320 * cosLat;
		const dN = (lkp.lat - this.lat) * 111320;
		const dU = (lkp.alt - this.alt);
		const range = Math.sqrt(dE * dE + dN * dN + dU * dU);
		if (range < 1) return;
		const horizRange = Math.sqrt(dE * dE + dN * dN);
		const desiredHeading = (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360;

		// ---- Cruise + terminal-dive profile -------------------------
		// Real HARMs fly a high-altitude cruise and pop down on the
		// target only at terminal range. A pure direct LOS path digs
		// into terrain whenever the launch was less than well above
		// the SAM — exactly the geometry where SEAD shots actually
		// happen (you launch from contested airspace, not from FL400
		// over flat ground).
		//
		// Profile:
		//   - Beyond TERMINAL_RANGE_M from target: cruise. Hold a
		//     pitch that targets CRUISE_AGL_M above the target's
		//     altitude. The horizontal LOS bearing is unchanged
		//     (PN below); only the *vertical* aim differs.
		//   - Within TERMINAL_RANGE_M: dive on the target. Aim the
		//     pitch so we're tracking the target lat/lon/alt
		//     directly.
		//   - Smooth blend across BLEND_RANGE_M so the missile rolls
		//     into the dive instead of bunting.
		// Velocity-scaled lookahead: a fast HARM covers ground so quickly
		// that a fixed slant-range threshold leaves no time to arc down
		// from cruise altitude before overflight. Scale the dive trigger
		// with current speed (≈ k seconds of flight time before impact)
		// while keeping a floor for low-speed end-game corrections.
		const TERMINAL_DIVE_LEAD_S = 2.5;
		const TERMINAL_RANGE_FLOOR = 700;
		const TERMINAL_RANGE_M = Math.max(TERMINAL_RANGE_FLOOR, TERMINAL_DIVE_LEAD_S * this.speed);
		const BLEND_RANGE_M    = TERMINAL_RANGE_M;        // dive ramps in over [TERMINAL, 2*TERMINAL]
		const CRUISE_AGL_M     = 1500; // sit ~1.5 km above target's alt while transiting

		// Target pitch in cruise mode: aim at (target.alt + cruiseAGL).
		// Target pitch in terminal mode: aim straight at target alt.
		const cruiseAimAlt = lkp.alt + CRUISE_AGL_M;
		const cruiseDU = cruiseAimAlt - this.alt;
		const cruisePitch = Math.atan2(cruiseDU, Math.max(1, horizRange)) * 180 / Math.PI;
		const terminalPitch = Math.atan2(dU, Math.max(1, horizRange)) * 180 / Math.PI;
		// Blend factor: 0 at >TERMINAL+BLEND (full cruise), 1 at <TERMINAL (full dive).
		let blend = 1;
		if (horizRange > TERMINAL_RANGE_M + BLEND_RANGE_M) blend = 0;
		else if (horizRange > TERMINAL_RANGE_M) {
			blend = 1 - (horizRange - TERMINAL_RANGE_M) / BLEND_RANGE_M;
		}
		const desiredPitch = cruisePitch * (1 - blend) + terminalPitch * blend;

		let dH = desiredHeading - this.heading;
		while (dH < -180) dH += 360;
		while (dH >  180) dH -= 360;
		const dP = desiredPitch - this.pitch;

		// Speed-dependent G availability — same formula the parent
		// Missile uses, copied here because we override the whole guide.
		const f = this.data.flight;
		const maxG    = this.data.seeker?.maxG ?? 25;
		const vRef    = f.vManeuverRef ?? 600;
		const gFloor  = f.gAvailFloor   ?? 0.05;
		const qFactor = Math.min(1, Math.max(gFloor, (this.speed * this.speed) / (vRef * vRef)));
		const gAvail  = maxG * qFactor;
		const maxTurnRad = (gAvail * 9.81) / Math.max(50, this.speed);
		const capDeg     = (maxTurnRad * 180 / Math.PI) * dt;

		const pn = f.pnGain ?? 4.0;
		this.heading += Math.max(-capDeg, Math.min(capDeg, dH * pn * dt));
		this.pitch   += Math.max(-capDeg, Math.min(capDeg, dP * pn * dt));
		this.pitch   = Math.max(-85, Math.min(85, this.pitch));

		// Debug data for HUD missile panel + commander tooltip. HARM
		// modes are not the AAM modes:
		//   EMIT = tracking a live emitter
		//   LKP  = emitter shut down, dead-reckoning to last-known
		//   SRCH = launched without acquiring an emitter, scanning
		this.debug = {
			rangeToTarget: range,
			headingError: dH,
			pitchError:   dP,
			mode: radarLive ? 'EMIT' : (this._lkp ? 'LKP' : 'SRCH'),
			targetName: (this.target && this.target.name) || 'EMITTER',
		};
	}
}
