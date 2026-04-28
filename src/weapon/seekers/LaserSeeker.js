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
import { steerTowardCoord } from './coordPN.js';
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

		const { range, headingError, pitchError } = steerTowardCoord(this, playerDesignation, dt);
		this.debug = {
			rangeToTarget: range,
			headingError,
			pitchError,
			mode: 'LASE',
			targetName: 'SPOT',
		};
	}
}
