// ============================================================================
// AntiShipSeeker — sea-skimming anti-ship cruise missile (Harpoon / NSM class).
//
// Built on the same robust altitude-hold techniques the CruiseSeeker uses for
// terrain following, but tuned for the sea and homing on a MOVING ship rather
// than a frozen GPS coord:
//
//   * SEA REFERENCE is cached. globe.getHeight() returns null over not-yet-
//     streamed ocean tiles (the long leg between two ships); we keep the last
//     good sample and seed it from the launching ship's waterline, so the skim
//     reference never collapses to 0 and flies the round into the water.
//   * ALTITUDE HOLD is ASYMMETRIC. Below the skim line it climbs HARD (so the
//     round can never settle into the sea); above it, it eases down gently.
//     This is what makes it robust where a symmetric proportional hold mushed
//     in.
//   * NO terminal pop-up/dive. A ship is a sea-level target — the classic
//     anti-ship terminal is a straight-in sea-skim. As it closes it lifts
//     toward the hull, but the aim altitude is CLAMPED above the sea surface
//     so a bad/low ship-altitude report (common for a distant, unstreamed
//     ship) can never pull the round down into the water. The proximity fuze
//     finishes the job.
//
// Required munition JSON seeker fields (see munitionSpec 'anti_ship'):
//   seeker.maxG            cruise/terminal turn-G ceiling
//   seeker.terminalRangeM  horizontal range to switch SKIM→TERMINAL lift
//   seeker.skimAltM        sea-skim altitude above the sea surface (m)
//   seeker.acquireRangeM   reserved for future re-acquisition (unused v1)
// ============================================================================

import * as Cesium from 'cesium';
import { Missile } from '../missile.js';
import { seaSurfaceHeightAt } from '../../world/terrain.js';
import { navalLog, navalTrace } from '../../systems/navalDebug.js';

export class AntiShipSeeker extends Missile {
	constructor(scene, viewer, startPos, heading, pitch, speed,
		target = null, onKill = null, launcher = null, data = null) {
		super(scene, viewer, startPos, heading, pitch, speed, target, onKill, launcher, data);
		this._carto = new Cesium.Cartographic();
		// Robust sea-surface reference (CruiseSeeker-style TFR cache). Seed from
		// the launching ship's known waterline so it's sane from the first frame.
		// Ship launcher → use its known waterline. Aircraft launcher (air-
		// launched Harpoon) → it's high up, so 0 is the right sea-level fallback;
		// the live getHeight samples correct it within a frame over the ocean.
		// Seed from THE sea reference (terrain.js) — the same field the launching
		// hull floats on and the launch-altitude clamp uses. Anything else and
		// the round skims confidently at a height something else calls
		// underwater. Only if no sample exists anywhere yet do we fall back to
		// the launcher's own bookkeeping.
		let seed = seaSurfaceHeightAt(viewer, startPos.lon, startPos.lat);
		if (seed == null) {
			seed = (launcher && typeof launcher._seaRefH === 'number') ? launcher._seaRefH
				: (launcher && launcher.kind === 'surface' && typeof launcher.alt === 'number')
					? (launcher.alt - (launcher._groundOffsetM || 0))
					: 0;
		}
		this._lastSeaH = seed;
		if (!target || typeof target.lon !== 'number') {
			this.lostLock = true;
			// This matters more than it looks: lostLock gates _guide() out
			// entirely in Missile.update, so the round gets NO altitude hold and
			// simply arcs into the sea under gravity a few seconds after launch
			// — visually identical to a spawn-altitude bug.
			navalLog('NO-TARGET', { type: this.type, note: 'lostLock=true, no guidance, will arc into the sea' });
			console.warn('[AntiShipSeeker] launched without a ship target; flying dumb');
		}
	}

	// Sea-surface height under the missile, cached so a missing (unstreamed)
	// tile reuses the last good value instead of dropping to 0.
	_seaH() {
		const h = seaSurfaceHeightAt(this.viewer, this.lon, this.lat);
		if (h == null) return this._lastSeaH;

		// A sea-skimmer's real state is its height ABOVE THE WATER; absolute
		// altitude is derived from it. So when our knowledge of where the water
		// is gets revised — which happens by 100+ m as ocean tile LOD streams in
		// — the round must be carried with it, not left stranded at an absolute
		// altitude that is suddenly underwater. Without this the missile flies a
		// textbook 20 m skim and gets detonated anyway because the sea rose
		// through it: the exact failure in the logs.
		//
		// Gated on a LARGE step so genuine geoid gradient still flows through
		// the normal altitude-hold loop. At 250 m/s the round covers ~4 m per
		// frame and the geoid changes millimetres over that, so any single-frame
		// delta this big is a data revision, never physical.
		if (this._lastSeaH != null) {
			const delta = h - this._lastSeaH;
			if (Math.abs(delta) > 5) {
				this.alt += delta;
				navalLog('SEA-REVISED', {
					type: this.type, was: this._lastSeaH, now: h, delta,
					altCarriedTo: this.alt, aboveSea: this.alt - h,
				});
			}
		}
		this._lastSeaH = h;
		return h;
	}

	_guide(dt) {
		const tgt = this.target;
		if (!tgt || tgt.destroyed || typeof tgt.lon !== 'number') { this.lostLock = true; return; }
		const f = this.data.flight;
		const s = this.data.seeker;
		const skim  = s.skimAltM ?? 15;
		const termR = s.terminalRangeM ?? 4000;

		const cosLat = Math.cos(this.lat * Math.PI / 180);
		const dE = (tgt.lon - this.lon) * 111320 * cosLat;
		const dN = (tgt.lat - this.lat) * 111320;
		const horiz = Math.hypot(dE, dN);
		const desiredHeading = (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360;

		const seaH = this._seaH();

		// Altitude target. CRUISE: wave-top skim above the LOCAL sea. TERMINAL:
		// lift toward the ship's superstructure to strike the hull — but never
		// below the sea surface, so a wrong/low ship-alt report (a distant,
		// unstreamed ship reads its altitude badly) cannot pull the round into
		// the water on the run-in. That was the "crash near the target" bug.
		let aimAlt;
		if (horiz > termR) {
			aimAlt = seaH + skim;
		} else {
			aimAlt = Math.max(seaH + Math.min(skim, 8), tgt.alt);
		}

		// Asymmetric altitude hold: climb HARD below the line (never settle into
		// the sea), ease down gently above it. Same idea as the CruiseSeeker's
		// terrain-following pitch logic.
		//
		// The descent limits are per-munition so this one seeker covers both
		// profiles. A sea-skimmer wants the defaults — it is already ON the
		// deck and a shallow, damped descent keeps it from porpoising into the
		// water. An anti-ship BALLISTIC missile cruises tens of km up and has
		// to convert that into a steep terminal dive, which the 8° default
		// could never do: from 16 km up it would still be at altitude when it
		// flew past the target.
		const maxDive = s.maxDiveDeg ?? 8;
		const descentGain = s.descentGain ?? 0.04;
		const altErr = aimAlt - this.alt;
		let desiredPitch;
		// `altErr <= 0` — i.e. only when DESCENDING onto the aim point. Below
		// the line the hard climb below always wins, which is the asymmetry
		// this seeker is built around: a sea-skimmer must never settle into the
		// water. Flying the line of sight in that case would command a ~0.2°
		// climb from 5 km out (the geometry is nearly flat) instead of the 35°
		// the recovery needs, and the round mushes into the sea a few km short
		// — measured at 5.3 km short before this guard was added.
		if (horiz <= termR && altErr <= 0) {
			// TERMINAL — point the nose AT the aim point rather than holding an
			// altitude. For a sea-skimmer this is a no-op: it is already at hull
			// height, so the line of sight is ~0° and it flies in flat exactly
			// as before. For a diving ballistic round it is the whole ball game.
			// An altitude-hold dive commits to a FIXED angle, so whether it
			// arrives depends entirely on where the terminal phase happened to
			// begin: too shallow and it sails over the top still 10 km up, too
			// steep and it pitches into the sea short of the target (measured:
			// 17 km short from 30 km up). Flying the line of sight self-corrects
			// — the angle steepens or eases as the geometry demands, and the
			// round arrives from whatever range the dive started.
			const losDeg = Math.atan2(aimAlt - this.alt, Math.max(1, horiz)) * 180 / Math.PI;
			desiredPitch = Math.max(-maxDive, Math.min(35, losDeg));
		} else {
			desiredPitch = (altErr > 0)
				? Math.min(35, altErr * 3.0)
				: Math.max(-maxDive, altErr * descentGain);
		}

		// G-limited turn cap, scaled by dynamic pressure (same shape as coordPN).
		const qFactor = Math.min(1, Math.max(f.gAvailFloor,
			(this.speed * this.speed) / (f.vManeuverRef * f.vManeuverRef)));
		const gAvail = s.maxG * qFactor;
		const capDeg = ((gAvail * 9.81) / Math.max(50, this.speed)) * 180 / Math.PI * dt;
		const pn = f.pnGain;

		let dH = desiredHeading - this.heading;
		while (dH < -180) dH += 360;
		while (dH >  180) dH -= 360;
		this.heading += Math.max(-capDeg, Math.min(capDeg, dH * pn * dt));
		const dP = desiredPitch - this.pitch;
		this.pitch += Math.max(-capDeg, Math.min(capDeg, dP * pn * dt));
		// Hard attitude clamp. The floor tracks maxDiveDeg for the same reason
		// the pitch COMMAND does: leaving it at the sea-skimmer's -20° silently
		// overrode a -60° dive command, so a ballistic round pitched over,
		// hit the clamp, and flew across the target still 10 km up.
		this.pitch = Math.max(-maxDive, Math.min(40, this.pitch));

		// Trace the first seconds at 5 Hz — the window where these rounds die.
		// Shows whether the round is holding its skim, whether the sea datum it
		// is skimming against matches where the water actually is, and whether
		// guidance is running at all.
		this._traceT = (this._traceT || 0) + dt;
		const age = this.maxLife - this.life;
		if (age < 8 && this._traceT >= 0.2) {
			this._traceT = 0;
			navalTrace('GUIDE', {
				type: this.type, ageS: age,
				alt: this.alt, seaH, aboveSea: this.alt - seaH,
				aimAlt, altErr: aimAlt - this.alt,
				wantPitch: desiredPitch, pitch: this.pitch,
				speed: this.speed, rangeKm: horiz / 1000,
				mode: horiz > termR ? 'SKIM' : 'TERMINAL',
			});
		}

		this.debug = {
			rangeToTarget: horiz,
			mode: horiz > termR ? 'ASM-SKIM' : 'ASM-TERMINAL',
			targetName: tgt.name || 'SHIP',
		};
	}
}
