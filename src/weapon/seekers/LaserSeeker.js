// ============================================================================
// LaserSeeker — PLACEHOLDER
//
// Homes on laser energy reflected off a target illuminated by a ground /
// air designator. The seeker itself is passive — the "target" from the
// missile's perspective is wherever the laser spot currently is. Move
// the spot, the missile follows.
//
// Behaviour (fully implemented when written for real):
//   - Needs a `LaserDesignator` concept in the sim: a sensor attached
//     to a unit (targeting pod on an aircraft, JTAC ground designator,
//     or buddy aircraft lasing for a wingman) that has:
//         pos           — where the spot is on the ground / on a unit
//         active        — whether it's currently lasing
//         ownerTeam     — so the seeker can confirm team alignment
//         pulseCode     — legacy feature, not usually modelled
//   - Each frame the seeker asks its bound designator for `spot`. If
//     active → PN to spot. If inactive → coast ballistic; if inactive
//     longer than `laseLossTimeoutS` → give up and go dumb.
//   - Spot can walk during flight: the pilot / JTAC adjusts and the
//     missile follows. That's the whole point of an LGB — walk the
//     laser onto the right window of a target building.
//
// Important nuance: classic LGBs (GBU-12/10/16) have NO INS backup.
// Lose the laser and they hit dirt. Modern dual-mode LGBs (GBU-54 LJDAM,
// Paveway IV) fall back to GPS/INS on laser loss. Config flag:
// `inertialBackup: true/false` gates that.
//
// Real examples:
//   GBU-10 / GBU-12 / GBU-16  — classic Paveway II family
//   GBU-54 LJDAM              — laser + GPS dual-mode
//   AGM-65E Maverick (laser)  — air-to-surface
//   AGM-114 Hellfire          — laser-guided anti-armour / anti-personnel
//   Brimstone (legacy LGB)    — dual-mode with radar
//
// Implementation TODO when real:
//   - Add LaserDesignator sensor (parallel to radar/IR in sensorSystem),
//     with pod attachment on player aircraft (Sniper ATP for F-15,
//     EOTS for F-35 builds).
//   - Target-under-crosshair UI: player paints a spot on the commander
//     view / HUD, the pod holds designation.
//   - Missile is constructed with `designator` reference + optional
//     fallback coord for `inertialBackup: true` variants.
//   - Each frame: spot = designator.currentSpot(). If present, PN to
//     it using standard lead pursuit (spot is usually stationary).
// ============================================================================

import { Missile } from '../missile.js';

export class LaserSeeker extends Missile {
	constructor(scene, viewer, startPos, heading, pitch, speed,
		target = null, onKill = null, launcher = null, data = null) {
		super(scene, viewer, startPos, heading, pitch, speed, target, onKill, launcher, data);
		this._placeholder = true;
		this.lostLock = true; // no designator infrastructure yet → ballistic
		console.warn('[LaserSeeker] placeholder — needs LaserDesignator + targeting pod before this can actually guide');
	}

	_guide() { /* stub — real impl reads designator.spot each frame and PNs there */ }
}
