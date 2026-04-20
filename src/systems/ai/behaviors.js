// ============================================================================
// Behaviors — priority-ordered decision makers. A pilot runs the first one
// whose isActive(ctx) returns true, passes it the pilot's PilotCommand to
// write into, and stops. That guarantees a single controller of the
// aircraft each tick (no command fighting).
//
// Priority convention (lower index wins):
//   0  MissileEvasion       — break active threats or die
//   1  TerrainAvoid         — pull up; GPWS safety net
//   2  Engage               — target in envelope → steer & fire (stub)
//   3  Patrol               — waypoint / sector hold               (stub)
//   4  Cruise               — default; hold altitude + heading
//
// Add a new behavior: subclass Behavior, implement isActive + apply,
// register it in the priority list (see ai/index.js).
// ============================================================================

export class Behavior {
	constructor(name) {
		this.name  = name;
		this.pilot = null; // assigned by Pilot.addBehavior
	}
	// Return true if this behavior wants to drive the aircraft this frame.
	isActive(_ctx) { return false; }
	// Write into `command` to express the desired flight state.
	apply(_ctx, _command, _dt) {}
}

// Small helpers shared by several behaviors.

function angleDiffDeg(from, to) {
	let d = to - from;
	while (d < -180) d += 360;
	while (d >  180) d -= 360;
	return d;
}

function bearingFromTo(from, to) {
	const latRad = (from.lat || 0) * Math.PI / 180;
	const dE = (to.lon - from.lon) * 111320 * Math.cos(latRad);
	const dN = (to.lat - from.lat) * 111320;
	return (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360;
}

function flatDistance(a, b) {
	const latRad = (a.lat || 0) * Math.PI / 180;
	const dE = (b.lon - a.lon) * 111320 * Math.cos(latRad);
	const dN = (b.lat - a.lat) * 111320;
	const dU = (b.alt - a.alt);
	return Math.sqrt(dE * dE + dN * dN + dU * dU);
}

// ----------------------------------------------------------------------------
// CruiseBehavior — always active; last-resort default.
//
// Holds altitude ~8 km, speed ~300 m/s, and a semi-random patrol heading
// that changes every 10-20 seconds. Replaces the hardcoded "random wander"
// that used to live in npcSystem.update.
// ----------------------------------------------------------------------------
export class CruiseBehavior extends Behavior {
	constructor(opts = {}) {
		super('Cruise');
		this.targetAlt    = opts.alt   ?? 8000;
		this.targetSpeed  = opts.speed ?? 300;
		this._headingTimer = 0;
		this._wanderHeading = null;
	}
	isActive() { return true; } // fallback

	apply(ctx, cmd, dt) {
		const u = ctx.unit;
		this._headingTimer -= dt;
		if (this._wanderHeading === null || this._headingTimer <= 0) {
			// Drift heading a little, settle on a new direction for 10-20s.
			this._wanderHeading = ((u.heading || 0) + (Math.random() - 0.5) * 120 + 360) % 360;
			this._headingTimer  = 10 + Math.random() * 10;
		}
		cmd.targetHeading = this._wanderHeading;

		// Gentle climb/descent toward the nominal altitude band.
		const altErr = this.targetAlt - u.alt;
		cmd.targetPitch = Math.max(-8, Math.min(8, altErr / 400));
		cmd.targetSpeed = this.targetSpeed;
		cmd.throttle    = 0.65;
	}
}

// ----------------------------------------------------------------------------
// TerrainAvoidBehavior — GPWS-style safety net.
//
// If the ground is too close below the nose, pull up hard and firewall
// throttle. Overrides any tactical behavior because "don't hit the dirt"
// is always priority 1.
// ----------------------------------------------------------------------------
export class TerrainAvoidBehavior extends Behavior {
	constructor(opts = {}) {
		super('TerrainAvoid');
		this.warnAgl   = opts.warnAgl   ?? 500; // ft-style threshold in m
		this.criticalAgl = opts.criticalAgl ?? 150;
	}
	isActive(ctx) {
		// ctx.terrainHeight is filled in by npcSystem once per unit per frame.
		const agl = (ctx.unit.alt) - (ctx.terrainHeight ?? -Infinity);
		return agl < this.warnAgl;
	}
	apply(ctx, cmd) {
		const agl = (ctx.unit.alt) - (ctx.terrainHeight ?? 0);
		cmd.targetPitch = agl < this.criticalAgl ? 45 : 25;
		cmd.throttle    = 1.0;
		cmd.boost       = true;
	}
}

// ----------------------------------------------------------------------------
// MissileEvasionBehavior — the heart of this pass.
//
// Triggers when any sensor channel shows a hostile projectile of class
// "missile" within a threshold range. Response:
//   - Turn to put the missile on the beam (perpendicular to its LOS to us)
//     → Doppler-notches radar guidance, extends time of flight so the
//       missile burns more energy chasing.
//   - Descend moderately to make terrain masking easier.
//   - Firewall throttle / AB: a missile catches you by kinematic advantage,
//     not speed-matching; more energy means more turn room.
//   - Drop flares on a cooldown — cheap universal cue regardless of
//     missile guidance type (chaff preferred for radar-guided will come
//     when the countermeasure subsystem differentiates).
// ----------------------------------------------------------------------------
export class MissileEvasionBehavior extends Behavior {
	constructor(opts = {}) {
		super('MissileEvasion');
		this.triggerRange  = opts.triggerRange  ?? 30000; // m
		this.flareInterval = opts.flareInterval ?? 1.5;   // s
		this._lastFlareAt  = -Infinity;
	}

	// Any hostile missile with at least one live sensor channel counts.
	// Range is a nice-to-have (for picking the closest) but not required —
	// an IR/MAWS ping gives bearing only, which is still enough to beam.
	// Preferring known-range contacts keeps the nearest threat in focus
	// when multiple missiles are inbound.
	_findThreat(ctx) {
		const unit = ctx.unit;
		const contacts = unit.contacts;
		if (!contacts || contacts.size === 0) return null;

		let best = null;
		let bestScore = -Infinity;
		for (const [target, c] of contacts) {
			const sig = target.signature;
			if (!sig || sig.unitClass !== 'missile') continue;
			if (target.team === unit.team) continue;
			if (target.destroyed || target.active === false) continue;
			if (!c.radar && !c.ir && !c.visual) continue;

			// Known range gates behind triggerRange; unknown range still
			// scores, just below any ranged contact, so a ranged-closer
			// missile always wins but a passive-only detection still
			// triggers evasion if no ranged one exists.
			const range = (c.radar && c.radar.range) || null;
			if (range !== null && range > this.triggerRange) continue;
			const score = range !== null ? (1 / range) : 1e-9;
			if (score > bestScore) {
				bestScore = score;
				best = { target, contact: c, range };
			}
		}
		return best;
	}

	isActive(ctx) { return !!this._findThreat(ctx); }

	apply(ctx, cmd, dt) {
		const threat = this._findThreat(ctx);
		if (!threat) return;
		const unit  = ctx.unit;
		const msl   = threat.target;
		const range = threat.range; // may be null when only passive sensors have it

		const bearingToMsl = bearingFromTo(unit, msl);
		const leftBeam  = (bearingToMsl + 90) % 360;
		const rightBeam = (bearingToMsl - 90 + 360) % 360;
		const dL = angleDiffDeg(unit.heading, leftBeam);
		const dR = angleDiffDeg(unit.heading, rightBeam);
		const beamHeading = Math.abs(dL) < Math.abs(dR) ? leftBeam : rightBeam;

		// Altitude-above-terrain, poked in by npcSystem at ~2 Hz. Used to
		// pull out of the terrain-masking dive as the ground gets close —
		// avoids needing TerrainAvoid to take over (which would fight with
		// the evasion commands).
		const agl = unit.alt - (ctx.terrainHeight ?? 0);

		// Power & flare rate. Both evasion phases run AB; only the flare
		// cadence differs — last-ditch spams, early beam conserves.
		cmd.targetSpeed = 600;
		cmd.throttle    = 1.0;
		cmd.boost       = true;

		const LAST_DITCH_RANGE = 2500; // m
		const isLastDitch = range !== null && range < LAST_DITCH_RANGE;

		if (isLastDitch) {
			// ---- Last-ditch: HARD break into the beam, pull up into the
			// missile's turn. Making the missile pull maximum G bleeds its
			// energy fastest, which is the classic defeat at short range.
			// Pitch UP rather than down: keeps the airframe energetic, and
			// the high-G pull is the most dramatic visual cue.
			cmd.targetHeading = beamHeading;
			cmd.targetPitch   = 30; // hard nose-up
			if (ctx.now - this._lastFlareAt > 0.3) {
				cmd.fireFlare = true;
				this._lastFlareAt = ctx.now;
			}
		} else {
			// ---- Early/mid: beam the missile and dive for the deck to
			// use terrain masking. Pitch ramps back toward level as AGL
			// drops so we don't fly into the ground; at extreme low level
			// we briefly pitch up to climb clear. This is a soft handover
			// to (and from) TerrainAvoid's domain, without fighting it.
			cmd.targetHeading = beamHeading;
			let divePitch;
			if      (agl > 1500) divePitch = -30; // heavy descent from altitude
			else if (agl > 800)  divePitch = -18;
			else if (agl > 400)  divePitch =  -5; // level off
			else                 divePitch =  15; // climb away from deck
			cmd.targetPitch = divePitch;

			if (ctx.now - this._lastFlareAt > this.flareInterval) {
				cmd.fireFlare = true;
				this._lastFlareAt = ctx.now;
			}
		}
	}
}

// ----------------------------------------------------------------------------
// EngageBehavior — offensive counterpart to MissileEvasion.
//
// Active when the pilot's TargetManager has a valid target (hostile
// contact with a radar-confirmed range). Points the nose at the target
// and, once within the chosen weapon's envelope and angle-off is small,
// writes fireWeapon + weaponType + weaponTarget to the command.
//
// Altitude policy is mild: try to stay in the 4-10 km band (good radar
// horizon, missile range). Speed stays at cruise — going AB to close on
// a BVR target wastes energy that will be wanted for evasion later.
//
// NOT yet modeled (left for follow-up passes):
//   - Crank / notch behaviour after firing an AIM-120
//   - Turn-cold / extend when launching outside optimal envelope
//   - Gun tracking in a dogfight (aim prediction, pull lead)
//   - Weapons employment zone (WEZ) modulation by altitude / co-alt
// ----------------------------------------------------------------------------
export class EngageBehavior extends Behavior {
	constructor(opts = {}) {
		super('Engage');
		// Only shoot when the target is within this angle-off from our nose.
		// 20° is forgiving for a BVR radar-guided shot; narrower angles
		// (~5-10°) feel more realistic but make NPCs look indecisive.
		this.fireConeDeg   = opts.fireConeDeg   ?? 20;
		this.cruiseAltMin  = opts.cruiseAltMin  ?? 4000;
		this.cruiseAltMax  = opts.cruiseAltMax  ?? 10000;
		this.cruiseSpeed   = opts.cruiseSpeed   ?? 300;
	}

	isActive(ctx) {
		const tm = this.pilot.subsystems.targetManager;
		return !!(tm && tm.getBest());
	}

	apply(ctx, cmd, dt) {
		const tm  = this.pilot.subsystems.targetManager;
		const ws  = this.pilot.subsystems.weapons;
		const best = tm && tm.getBest();
		if (!best) return;
		const { target, range } = best;
		const unit = ctx.unit;

		// Point at the target. The NPC motion code turns at boost rates
		// when cmd.boost is true, but the approach phase should be
		// measured — only firewall AB during evasion or final commit.
		cmd.targetHeading = bearingFromTo(unit, target);

		// Altitude band. If outside the band, trim pitch toward re-entry.
		const alt = unit.alt;
		if      (alt < this.cruiseAltMin) cmd.targetPitch =  5;
		else if (alt > this.cruiseAltMax) cmd.targetPitch = -3;
		else                              cmd.targetPitch =  0;

		cmd.targetSpeed = this.cruiseSpeed;
		cmd.throttle    = 0.85;
		cmd.boost       = false;

		// Committing to a shot: inside weapon envelope AND within a small
		// angle off the nose. The AIM-120's datalink guidance tolerates
		// some off-nose, but a roughly-aligned shot keeps things sane.
		if (!ws) return;
		const now = ctx.now;
		const weapon = ws.pickWeaponFor(range, now);
		if (!weapon) return;

		const angleOff = Math.abs(angleDiffDeg(unit.heading, cmd.targetHeading));
		if (angleOff > this.fireConeDeg) return;

		cmd.fireWeapon   = true;
		cmd.weaponType   = weapon.type;
		cmd.weaponTarget = target;
	}
}
