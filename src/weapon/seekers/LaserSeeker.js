// ============================================================================
// LaserSeeker — GBU-12 Paveway II and family.
//
// Homes on the laser spot the player's TGP is currently designating.
// Reads `playerDesignation` directly each frame (single global source
// of truth — see systems/designation.js). The bomb itself is dumb;
// it just steers toward whatever lat/lon/alt the spot currently sits
// at. Move the spot, the bomb follows. Stop lasing, the bomb coasts.
//
// Loss-of-spot rules (classic LGB, no INS backup):
//   - Spot lasing → PN to spot.
//   - Spot present but not LASE (player only TRACKing) → coast
//     ballistic. Real LGBs need active illumination during terminal;
//     a tracked-but-not-lased spot doesn't reflect IR energy back at
//     the seeker, so it has nothing to home on.
//   - LASE absent for `losBreakTimeoutS` seconds → give up
//     permanently (`lostLock = true`); falls forward unguided.
//
// Deliberately NOT modelled here (Phase 9 / 6 follow-ups):
//   - Cloud attenuation breaking the laser path.
//   - Dual-mode GPS/INS fallback (GBU-54 LJDAM family).
//   - Buddy-lasing from a separate aircraft's TGP (would need a
//     `designatorTeam` filter; for now only player can lase).
// ============================================================================

import { Missile } from '../missile.js';
import { playerDesignation } from '../../systems/designation.js';
import { chordTerrainHit } from '../../systems/sensorSystem.js';
import * as Cesium from 'cesium';

export class LaserSeeker extends Missile {
	constructor(scene, viewer, startPos, heading, pitch, speed,
		target = null, onKill = null, launcher = null, data = null) {
		super(scene, viewer, startPos, heading, pitch, speed, target, onKill, launcher, data);

		const seeker = (data && data.seeker) || {};
		// How long the bomb tolerates the spot being absent before
		// declaring the shot a lost cause and going dumb. Real LGBs
		// have a few seconds of "memory" — the optics see the last
		// reflection for a moment after lase stops — but not much.
		this._losBreakTimeoutS = seeker.losBreakTimeoutS ?? 3.0;
		this._lostSpotAt = null;       // sim-age the spot first went away
		this.lostLock = false;
	}

	// Override the parent's guidance with PN-to-spot.
	_guide(dt) {
		if (this.lostLock) return;

		// Treat any locked spot (TRACK or LASE) as a homing target. Real
		// LGBs need active illumination during terminal, but the
		// UX cost of forcing the player into a LASE-or-miss state
		// machine outweighs the realism. The TGP still has the LASE
		// state for show; the bomb just needs *some* designated spot.
		// Only a degenerate (no-spot) SLEW kicks the loss timer.
		const hasSpot = playerDesignation && playerDesignation.mode !== 'SLEW' &&
			(playerDesignation.lat !== 0 || playerDesignation.lon !== 0);
		if (!hasSpot) {
			if (this._lostSpotAt == null) this._lostSpotAt = this._age || 0;
			const lostFor = (this._age || 0) - this._lostSpotAt;
			if (lostFor > this._losBreakTimeoutS) {
				this.lostLock = true;
			}
			this.debug = { mode: 'COAST', targetName: 'NO-SPOT' };
			return;
		}
		// Spot is live. Reset loss bookkeeping.
		this._lostSpotAt = null;

		// Optional LOS check: bomb → spot. If a terrain feature is
		// between the bomb and the lased point, the seeker can't see
		// the reflection. Same `chordTerrainHit` everything else uses.
		const fromCart = Cesium.Cartesian3.fromDegrees(this.lon, this.lat, this.alt);
		const toCart   = Cesium.Cartesian3.fromDegrees(
			playerDesignation.lon, playerDesignation.lat, playerDesignation.alt,
		);
		const blocked = chordTerrainHit(fromCart, toCart) !== null;
		if (blocked) {
			// Terrain in the way — coast like a missed-lase frame.
			// Don't expire the timer; this is usually transient as the
			// bomb arcs over the obstruction. The bomb will re-acquire
			// once the chord clears.
			this.debug = { mode: 'MASKED', targetName: 'TERR' };
			return;
		}

		// PN to spot. Lead-pursuit isn't meaningful — the spot is on
		// the ground, almost stationary. Steer at it directly.
		const cosLat = Math.cos(this.lat * Math.PI / 180);
		const dE = (playerDesignation.lon - this.lon) * 111320 * cosLat;
		const dN = (playerDesignation.lat - this.lat) * 111320;
		const dU = (playerDesignation.alt - this.alt);
		const range = Math.sqrt(dE * dE + dN * dN + dU * dU);
		if (range < 1) return;
		const horizRange = Math.sqrt(dE * dE + dN * dN);
		const desiredHeading = (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360;
		const desiredPitch   = Math.atan2(dU, Math.max(1, horizRange)) * 180 / Math.PI;

		let dH = desiredHeading - this.heading;
		while (dH < -180) dH += 360;
		while (dH >  180) dH -= 360;
		const dP = desiredPitch - this.pitch;

		// Speed-dependent G availability — same shape as HARM/AAM.
		const f = this.data && this.data.flight ? this.data.flight : {};
		const maxG    = (this.data.seeker && this.data.seeker.maxG) || 9;
		const vRef    = f.vManeuverRef ?? 250;
		const gFloor  = f.gAvailFloor   ?? 0.05;
		const qFactor = Math.min(1, Math.max(gFloor, (this.speed * this.speed) / (vRef * vRef)));
		const gAvail  = maxG * qFactor;
		const maxTurnRad = (gAvail * 9.81) / Math.max(50, this.speed);
		const capDeg     = (maxTurnRad * 180 / Math.PI) * dt;

		const pn = f.pnGain ?? 4.0;
		this.heading += Math.max(-capDeg, Math.min(capDeg, dH * pn * dt));
		this.pitch   += Math.max(-capDeg, Math.min(capDeg, dP * pn * dt));
		this.pitch   = Math.max(-89, Math.min(89, this.pitch));

		this.debug = {
			rangeToTarget: range,
			headingError: dH,
			pitchError:   dP,
			mode: 'LASE',
			targetName: 'SPOT',
		};
	}
}
