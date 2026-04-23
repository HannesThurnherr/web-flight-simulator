// ============================================================================
// AntiRadiationSeeker — PLACEHOLDER
//
// Passive seeker: listens for radar emissions and flies toward the
// strongest source in its forward cone. Has NO transmitter of its own,
// which is the whole point — the target can't detect an incoming HARM
// via RWR in the way an active-radar missile gives itself away with a
// spike. All it sees is its own radar being painted, briefly, and then
// the HARM arrives.
//
// Behaviour (fully implemented when written for real):
//   - At launch the pilot selects a specific emitter from the RWR
//     picture (or the missile goes autonomous "target of opportunity"
//     mode and grabs whatever's brightest in the cone).
//   - Each frame: check if `this.target` still has `sensors.radar.active
//     === true`. If yes, PN toward it (lead pursuit is cheap — a SAM
//     site doesn't move; an emitting airborne radar is slow and can
//     be lead-compensated easily).
//   - If target shuts down (emission control / "the RIGHT response")
//     the missile enters last-known-position mode:
//       Classic HARM (B/C): dead-reckon to LKP, impact where it was.
//       AARGM (E/F): GPS/INS backup that follows coordinates with
//           millimetre-wave terminal backup for moving emitters.
//   - Decoys: real SEAD defence uses emitter decoys (ALE-50, towed)
//     that out-emit the aircraft, drawing the HARM off-axis. Tagged
//     `flareBrightness`-style in data when decoys are modelled.
//
// Key difference from active radar: no range equation. Detection
// strength depends on the TARGET's emission strength, not the seeker's
// TX power. An emitting AWACS is a beacon visible from 200+ km away;
// a fighter in silent EMCON is invisible to HARM entirely.
//
// Real examples:
//   AGM-88 HARM       — family: B, C, D, E (AARGM), F (AARGM-ER)
//   Kh-31P            — Russian anti-radiation, Mach 3+
//   Kh-58              — older Soviet SEAD
//   AGM-122 Sidearm   — WVR-range AIM-9-derived anti-radiation
//   ALARM              — UK (retired); had a unique loiter-and-wait
//                         mode where it parachuted down waiting for
//                         re-activation of the target radar
//
// Implementation TODO when real:
//   - Seeker config:
//       fovHalfAngleDeg    — typical ±40° (wider than AR seeker)
//       emissionLossMemoryS — how long LKP dead-reckoning lasts
//       minDetectableSignalLevel — below this, target is invisible
//       inertialBackup: bool — AARGM-class fallback on emission loss
//   - At launch, capture `this.target` reference.
//   - Each frame:
//       If target?.sensors?.radar?.active → PN to target.
//       Else: record {lon, lat, alt, t=now} on first loss, then
//             dead-reckon toward that point for emissionLossMemoryS,
//             then go dumb (or terminal GPS if inertialBackup).
//   - Signature: same as missile_radar (active-radar missiles also
//     reflect radar), OR a new "missile_arm" if we want HARMs to be
//     slightly easier to spot visually (they have larger seeker domes).
// ============================================================================

import { Missile } from '../missile.js';

export class AntiRadiationSeeker extends Missile {
	constructor(scene, viewer, startPos, heading, pitch, speed,
		target = null, onKill = null, launcher = null, data = null) {
		super(scene, viewer, startPos, heading, pitch, speed, target, onKill, launcher, data);
		this._placeholder = true;
		this.lostLock = true; // no emission-tracking yet → ballistic
		console.warn('[AntiRadiationSeeker] placeholder — needs RWR-source-selection + emission-tracking before this can actually guide');
	}

	_guide() { /* stub — real impl reads target.sensors.radar.active each frame and PNs */ }
}
