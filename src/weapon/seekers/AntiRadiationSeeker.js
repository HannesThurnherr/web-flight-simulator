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

// ----------------------------------------------------------------------------
// Salvo deconfliction registry. Every live, auto-targeting HARM registers
// here so siblings can see which emitters are already claimed and spread the
// shots across the threat ring instead of dog-piling the single loudest SAM.
// Player-designated shots register too (so an auto shot won't pile onto a
// hand-picked emitter) but never re-pick a target themselves.
// ----------------------------------------------------------------------------
const _activeHarms = new Set();

// Home-on-jam: scale a jammer's raw power into the same "transmit strength"
// units as a radar's nominalRange so the two are rankable. ~2× makes a
// broadcasting Krasukha (80 kW → 160k) a high-priority target — above a SAM
// battery's fire-control radar, below a long-range EWR — matching doctrine.
const JAM_TX_FACTOR = 2;

export class AntiRadiationSeeker extends Missile {
	constructor(scene, viewer, startPos, heading, pitch, speed,
		target = null, onKill = null, launcher = null, data = null) {
		super(scene, viewer, startPos, heading, pitch, speed, target, onKill, launcher, data);

		// anti_radiation seeker fields validated by validateMunitionSpec.
		const seeker = this.data.seeker;
		this._fovHalfRad = (seeker.fovHalfAngleDeg * Math.PI) / 180;
		this._emissionLossMemoryS = seeker.emissionLossMemoryS;

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

		// Join the deconfliction registry now that our target is set, so the
		// next HARM constructed in this salvo already sees our claim.
		_activeHarms.add(this);
	}

	// How many OTHER live, still-guiding HARMs are homing on `emitter`.
	_claimCount(emitter) {
		if (!emitter) return 0;
		let n = 0;
		for (const h of _activeHarms) {
			if (h === this || h.lostLock || h.destroyed || h.active === false) continue;
			if (h.target === emitter) n++;
		}
		return n;
	}

	_rangeTo(u) {
		const cosLat = Math.cos((this.lat || 0) * Math.PI / 180);
		const dE = (u.lon - this.lon) * 111320 * cosLat;
		const dN = (u.lat - this.lat) * 111320;
		const dU = (u.alt - this.alt);
		return Math.sqrt(dE * dE + dN * dN + dU * dU);
	}

	// Among all live HARMs sharing `emitter`, am I the farthest? Only the
	// farthest claimer is allowed to peel off to a free emitter — deterministic
	// so the redistribution converges instead of two missiles swapping forever.
	_amFarthestClaimerOf(emitter) {
		const myRange = this._rangeTo(emitter);
		for (const h of _activeHarms) {
			if (h === this || h.lostLock || h.destroyed || h.active === false) continue;
			if (h.target !== emitter) continue;
			if (h._rangeTo(emitter) > myRange) return false;
		}
		return true;
	}

	// Effective transmit strength of a unit as seen by a passive RF seeker:
	// the louder of its search-radar emission and any active jammer (home-on-
	// jam — a broadcasting jammer is the loudest source on the battlefield and
	// a prime ARM target). 0 if it's emitting nothing trackable right now.
	_txStrength(u) {
		let tx = 0;
		if (isRadiating(u) && u.sensors && u.sensors.radar) {
			tx = u.sensors.radar.nominalRange || 50000;
		}
		const j = u.jammer;
		if (j && (j.defensiveOn || (j.offensiveTargets && j.offensiveTargets.size > 0))) {
			const jamTx = (j.power || 40000) * JAM_TX_FACTOR;
			if (jamTx > tx) tx = jamTx;
		}
		return tx;
	}

	// Is this unit currently a trackable emitter (radar OR jammer)?
	_isEmitterLive(u) {
		return !!u && !u.destroyed && u.active !== false && this._txStrength(u) > 0;
	}

	// Score a radiating/jamming unit. Higher = better target.
	// Cheap inverse-square emission proxy: `txStrength / dist²`.
	_emitterScore(u) {
		if (!u || u.destroyed || u.active === false) return 0;
		if (u === this.launcher) return 0;
		if (u.team && this.team && u.team === this.team) return 0;
		const tx = this._txStrength(u);
		if (tx <= 0) return 0;
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
		return tx / Math.max(1, range * range);
	}

	// Pick the best emitter, deconflicted across the salvo: prefer emitters
	// the FEWEST sibling HARMs are already homing on, and among the
	// least-claimed take the strongest (loudest/closest). So the first shot
	// takes the top SAM, the second sees it's claimed and takes the next, and
	// only once every emitter has one inbound do they start doubling up.
	_scanForEmitter(units) {
		let best = null;
		let bestClaims = Infinity;
		let bestScore = 0;
		for (const u of units) {
			// Auto-acquire ignores fast airborne emitters (enemy fighters
			// painting with their own radar). A classic HARM is a SEAD weapon
			// tuned for ground emitters and large slow airborne ones (AWACS);
			// a maneuvering fighter is an AMRAAM problem, not a HARM one, and
			// the seeker/flight profile can't realistically run one down. We
			// still allow ground SAM/EWR/jammers and AWACS-class radars. A
			// player can override by manually designating a target (that path
			// bypasses this scan entirely).
			const cls = u && u.signature && u.signature.unitClass;
			if (cls === 'fighter' || cls === 'stealth_fighter') continue;
			const s = this._emitterScore(u);
			if (s <= 0) continue;
			const claims = this._claimCount(u);
			if (claims < bestClaims || (claims === bestClaims && s > bestScore)) {
				best = u; bestClaims = claims; bestScore = s;
			}
		}
		return best;
	}

	destroy() {
		_activeHarms.delete(this);
		super.destroy();
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

		const radarLive = this._isEmitterLive(this.target);

		if (radarLive) {
			this._refreshLkp(this.target);
			// Live redistribution (auto shots only): if my SAM already has
			// another HARM inbound AND a different emitter is currently
			// un-engaged, the FARTHEST of the doubled-up shots peels off to
			// cover the free target. Only the farthest moves, and only onto a
			// 0-claim emitter, so it converges without target thrashing —
			// handles "a SAM that was in emcon comes back on, spread out".
			if (!this._playerDesignated) {
				this._redistTimer = (this._redistTimer || 0) + dt;
				if (this._redistTimer >= 1.0) {
					this._redistTimer = 0;
					if (this._claimCount(this.target) >= 1 && this._amFarthestClaimerOf(this.target)) {
						const npcs = (this.launcher && this.launcher.npcs) ? this.launcher.npcs : [];
						const alt = this._scanForEmitter(npcs);
						if (alt && alt !== this.target && this._claimCount(alt) === 0) {
							this.target = alt;
							this._refreshLkp(alt);
						}
					}
				}
			}
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
		// Loft. A real HARM fired at a distant emitter climbs into thin air
		// (less drag → more range AND a faster terminal dive) instead of
		// dragging along flat just above the target. Cruise altitude scales
		// with horizontal range to the target — far shots arc high, close
		// shots stay low — clamped to [min,max] from the munition data. The
		// missile holds (target.alt + thisAGL) until terminal range, then
		// bunts over into the steep geometric dive below.
		const f0 = this.data.flight;
		const loftPerM = (typeof f0.loftAglPerM === 'number') ? f0.loftAglPerM : 0.18;
		const loftMax  = (typeof f0.loftAglMaxM === 'number') ? f0.loftAglMaxM : 14000;
		const loftMin  = (typeof f0.loftAglMinM === 'number') ? f0.loftAglMinM : 1500;
		const CRUISE_AGL_M = Math.max(loftMin, Math.min(loftMax, horizRange * loftPerM));

		// Target pitch in cruise mode: aim at (target.alt + cruiseAGL).
		// Target pitch in terminal mode: aim straight at target alt —
		// but enforce a minimum 45° dive so the missile doesn't take a
		// flat path that snags on the last terrain feature short of
		// the SAM. The minimum kicks in whenever the geometric pitch
		// is shallower than -45° (i.e. we're not high enough above
		// the target for a steep direct line). This produces a brief
		// over-the-top arc — apex past the LKP, then steep dive —
		// which is also how real HARM terminal trajectories look.
		const cruiseAimAlt = lkp.alt + CRUISE_AGL_M;
		const cruiseDU = cruiseAimAlt - this.alt;
		const cruisePitch = Math.atan2(cruiseDU, Math.max(1, horizRange)) * 180 / Math.PI;
		const geomTerminalPitch = Math.atan2(dU, Math.max(1, horizRange)) * 180 / Math.PI;
		// Aim at the GEOMETRIC line to the target — the same direct-to-coord
		// terminal aim the working CruiseSeeker uses — with only a gentle -10°
		// floor to guarantee descent. The old code forced a 45° minimum dive
		// here, which when cruising ~1.5 km above the SAM and diving from
		// ~2.5 km out is STEEPER than the line to the target: the missile
		// descended faster than it closed and augered in ~1 km short. The -10°
		// floor never binds at real terminal geometry (target is well below).
		const terminalPitch = Math.min(geomTerminalPitch, -10);
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
		// All fields validated at ctor.
		const f = this.data.flight;
		const maxG    = this.data.seeker.maxG;
		const qFactor = Math.min(1, Math.max(f.gAvailFloor, (this.speed * this.speed) / (f.vManeuverRef * f.vManeuverRef)));
		const gAvail  = maxG * qFactor;
		const maxTurnRad = (gAvail * 9.81) / Math.max(50, this.speed);
		const capDeg     = (maxTurnRad * 180 / Math.PI) * dt;

		const pn = f.pnGain;
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
