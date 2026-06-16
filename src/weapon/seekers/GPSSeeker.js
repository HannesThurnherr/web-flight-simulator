// ============================================================================
// GPSSeeker — JDAM (GBU-31 / GBU-38) and family.
//
// Homes on a fixed lat/lon/alt captured ONCE at construction. Unlike the
// LaserSeeker (which reads the live `playerDesignation` singleton each
// frame), each GPS munition carries its own immutable target coordinate
// — so a salvo of N JDAMs is N independent shots that all end up on the
// same point, even if the player slews the TGP mid-flight.
//
// Behaviour summary:
//   - Constructor copies `target = {lon, lat, alt}` into `this._targetCoord`.
//   - Each frame `_guide` PNs toward that fixed point. No spot-loss timer,
//     no LOS gate: GPS doesn't care about masking, weather, or the
//     designator's state after launch.
//   - `lostLock` stays false unless something external sets it (no
//     in-seeker condition produces it; future GPS-jamming would).
//
// Deliberately NOT modelled (Phase 6 / 5e+):
//   - GPS jamming / spoofing. Real munitions degrade gracefully on INS
//     when GPS is denied; we'll wire that in once EW is a thing.
//   - Multi-waypoint cruise profile. JDAM is a single waypoint shot
//     (release → impact). Cruise missiles will need their own seeker.
//   - Lofted glide profile (SDB / JSOW). Could add as a flight-mode
//     variant later; a vanilla JDAM straight-down PN is fine for now.
// ============================================================================

import { Missile } from '../missile.js';

export class GPSSeeker extends Missile {
	constructor(scene, viewer, startPos, heading, pitch, speed,
		target = null, onKill = null, launcher = null, data = null) {
		super(scene, viewer, startPos, heading, pitch, speed, target, onKill, launcher, data);

		// Caller passes a plain {lon, lat, alt} object. Defensive copy so
		// later mutations to the source object (e.g. the designation
		// singleton being slewed) never bleed into this bomb's frozen
		// coordinate. This is the whole point of GPS guidance.
		if (target && typeof target === 'object' && 'lon' in target && 'lat' in target) {
			this._targetCoord = {
				lon: target.lon,
				lat: target.lat,
				alt: target.alt ?? 0,
			};
		} else {
			// No target supplied — we'd have nothing to home on. Fail
			// closed: declare lost so the parent class doesn't waste
			// cycles calling _guide on a no-op.
			this._targetCoord = null;
			this.lostLock = true;
			console.warn('[GPSSeeker] launched without a target coord; will fly ballistic');
		}
	}

	// PN to the frozen coord. Direct port of LaserSeeker's PN block, with
	// the spot source swapped to this._targetCoord. No LASE / LOS state
	// machine — a JDAM doesn't have one to lose.
	_guide(dt) {
		if (this.lostLock || !this._targetCoord) return;

		const t = this._targetCoord;
		const cosLat = Math.cos(this.lat * Math.PI / 180);
		const dE = (t.lon - this.lon) * 111320 * cosLat;
		const dN = (t.lat - this.lat) * 111320;
		const dU = (t.alt - this.alt);
		const range = Math.sqrt(dE * dE + dN * dN + dU * dU);
		if (range < 1) return;
		const horizRange = Math.sqrt(dE * dE + dN * dN);
		const desiredHeading = (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360;
		const desiredPitch   = Math.atan2(dU, Math.max(1, horizRange)) * 180 / Math.PI;

		let dH = desiredHeading - this.heading;
		while (dH < -180) dH += 360;
		while (dH >  180) dH -= 360;

		// All required fields validated at ctor.
		const f = this.data.flight;
		const maxG = this.data.seeker.maxG;
		const qFactor = Math.min(1, Math.max(f.gAvailFloor, (this.speed * this.speed) / (f.vManeuverRef * f.vManeuverRef)));
		const gAvail = maxG * qFactor;
		const maxTurnRad = (gAvail * 9.81) / Math.max(50, this.speed);
		const capDeg = (maxTurnRad * 180 / Math.PI) * dt;
		const pn = f.pnGain;

		// Lateral guidance is ALWAYS active — line the bomb up with the
		// target's bearing from the moment of release.
		this.heading += Math.max(-capDeg, Math.min(capDeg, dH * pn * dt));

		// ---- Vertical profile -------------------------------------------
		// Loft-glide weapons (GBU-39 SDB) fly a BALLISTIC arc until apogee,
		// then deploy wings and glide onto the target. A climbing/toss
		// release therefore arcs up and over for huge stand-off range,
		// rather than nosing straight down off the rail. Non-loft bombs
		// (vanilla JDAM) keep immediate point-at-target guidance.
		const vVert = this.speed * Math.sin(this.pitch * Math.PI / 180);
		const stillClimbing = f.loftGlide && vVert > 3;   // 3 m/s ≈ "top of arc"
		let mode = 'GPS';

		if (stillClimbing) {
			// Ballistic ascent: hands off the pitch — gravity (applied in
			// the base Missile update) arcs it over. Only steer azimuth.
			mode = 'BALLISTIC';
		} else {
			// Past apogee (or never lofted): home the pitch onto the target
			// point. Loft-glide weapons fly a GLIDE-HIGH profile: hold a
			// shallow descent — preserving altitude and terrain clearance —
			// until the straight dive line to the target steepens to the
			// terminal dive angle, THEN commit to the dive. Following the
			// direct depression line from apogee (the old behaviour) flew a
			// flat 10-15° slope for tens of km and clipped ridgelines short
			// of the target. Non-loft bombs (vanilla JDAM) keep immediate
			// point-at-target guidance.
			let cmdPitch = desiredPitch;
			if (f.loftGlide) {
				const diveDeg = f.terminalDiveDeg ?? 35;
				const termR   = f.terminalRangeM || 4000;
				if (desiredPitch > -diveDeg && range > termR) {
					// Dive line still shallow → stay high. -3° keeps a
					// little downhill energy; an uphill target is tracked
					// gently (unpowered, so the climb self-limits).
					cmdPitch = Math.max(-3, Math.min(desiredPitch, 5));
					mode = 'GLIDE-HI';
				} else {
					mode = range < termR ? 'GLIDE-TERM' : 'GLIDE-DIVE';
				}
			}
			const dP = cmdPitch - this.pitch;
			this.pitch += Math.max(-capDeg, Math.min(capDeg, dP * pn * dt));
			this.pitch  = Math.max(-89, Math.min(89, this.pitch));
		}

		this.debug = {
			rangeToTarget: range,
			headingError: dH,
			mode,
			targetName: 'COORD',
		};
	}
}
