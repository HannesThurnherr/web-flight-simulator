// ============================================================================
// GPSSeeker — PLACEHOLDER
//
// Guidance to a fixed geographic coordinate (or sequence of them). The
// target is a point on the Earth, not a unit — so there's no "lose lock"
// concept in the sensor sense. Missile knows where to go from the moment
// it leaves the rail.
//
// Behaviour (fully implemented when written for real):
//   - Single-waypoint variants (JDAM, SDB): fly PN toward the target
//     (lon, lat, alt). Contact fuze on impact. Lofted glide profile
//     for SDB / JSOW (high lift coef + low drag), flat-to-target for
//     JDAM (low lift, shorter range).
//   - Multi-waypoint variants (Tomahawk, JASSM, KH-101): walk through
//     an ordered waypoint list with sustainer thrust throughout the
//     flight. Altitude profile switches to terrain-following-radar
//     (TFR) mode at ~50 m AGL for the cruise portion; climbs + dives
//     at the terminal.
//   - Kinematic flexibility is entirely driven by munition data:
//     `thrustProfile: "none" / "sustainer"`, `liftCoef: 0.2..0.9`,
//     `waypoints: [[lon, lat, alt], ...]` or single `targetCoord`.
//
// GPS jamming / spoofing is a whole separate topic (real modern GPS
// munitions have INS backup that degrades accuracy gracefully if the
// GPS is denied). Not modeled in the stub.
//
// Real examples:
//   GBU-31 JDAM           — 2000 lb GPS bomb (straight-in)
//   GBU-39 SDB            — 250 lb GPS glide bomb (long stand-off)
//   AGM-154 JSOW          — stand-off glide (can also dispense subs)
//   AGM-158 JASSM / -ER   — stealth cruise missile (waypoint-based)
//   BGM-109 Tomahawk      — long-range sub-sonic cruise
//   ATACMS MGM-168         — tactical ballistic (short-range ballistic)
//
// Implementation TODO when real:
//   - Accept `target` as either a unit reference (treated as stationary
//     at its current pos — useful for hitting a SAM site that's locked
//     by coords at launch) or `{lon, lat, alt}` coord or an array of
//     waypoints.
//   - Compute PN against the NEXT waypoint; advance when within
//     ~100 m of it (except the last, which is the impact point).
//   - For cruise variants, run a TFR altitude controller during
//     cruise (hold AGL constant via proportional pitch) and disable
//     it during terminal.
//   - Contact fuze on ground impact for bombs; proximity fuze for
//     cruise vs. target.
// ============================================================================

import { Missile } from '../missile.js';

export class GPSSeeker extends Missile {
	constructor(scene, viewer, startPos, heading, pitch, speed,
		target = null, onKill = null, launcher = null, data = null) {
		super(scene, viewer, startPos, heading, pitch, speed, target, onKill, launcher, data);
		this._placeholder = true;

		// Until the real impl lands, declare immediate lost-lock so the
		// Missile base doesn't try to IR-PN the target. Projectile will
		// coast ballistic and impact wherever gravity + drag take it.
		this.lostLock = true;

		console.warn('[GPSSeeker] placeholder — munition will fly ballistic until real seeker is implemented');
	}

	_guide() { /* stub — real impl will PN toward waypoint / target coord */ }
}
