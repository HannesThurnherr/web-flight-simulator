// ============================================================================
// NullSeeker — PLACEHOLDER
//
// Projectile with NO guidance at all. Used by unguided munitions: dumb
// bombs, rockets, kamikaze drones without terminal seekers, cluster
// dispensers before their submunitions deploy.
//
// Behaviour (fully implemented when this is written for real):
//   - Inherits launch velocity from the aircraft
//   - Follows pure ballistic arc: gravity + density-scaled drag
//   - No target tracking, no lock, no PN
//   - Detonates on proximity/contact against whatever it hits
//   - Fuze types (config-driven, not implemented yet):
//       contact     — explodes on first surface hit
//       proximity   — explodes inside radius of any hostile
//       altitude    — airburst at preset AGL (flak-style)
//       timed       — airburst at preset TOF
//       penetrator  — contact fuze with delay (bunker busters)
//       cluster     — altitude fuze that spawns N submunitions (each
//                     itself a small NullSeeker with contact fuze)
//
// Real examples:
//   Mk 82 / Mk 83 / Mk 84       — 500/1000/2000 lb dumb bombs
//   CBU-87                       — cluster bomb (cluster fuze + submunitions)
//   Hydra 70                     — unguided 2.75" rocket
//   S-8                          — Russian equivalent
//
// The base Missile class already handles the integrator, collision,
// and trail. For the stub we just suppress the seeker-related branches
// by nulling the target. Real implementation should:
//   - Subclass (or share base with) a future Projectile class to drop
//     the IR-specific visual assets (AIM-9-shaped mesh / flame cone)
//     in favour of plain bomb/rocket geometry.
//   - Add the fuze model described above.
// ============================================================================

import { Missile } from '../missile.js';

export class NullSeeker extends Missile {
	constructor(scene, viewer, startPos, heading, pitch, speed,
		target = null, onKill = null, launcher = null, data = null) {
		// Pass null target regardless — even if a caller supplied one
		// we're explicitly unguided.
		super(scene, viewer, startPos, heading, pitch, speed, null, onKill, launcher, data);
		this.target = null;
		this.lostLock = true;   // ensures Missile.update() never calls _guide
		this._placeholder = true;
	}

	_guide() { /* no-op — unguided by definition */ }
}
