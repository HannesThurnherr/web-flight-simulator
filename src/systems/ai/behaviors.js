// ============================================================================
// Behaviors — priority-ordered decision makers. A pilot runs the first one
// whose isActive(ctx) returns true, passes it the pilot's PilotCommand to
// write into, and stops. That guarantees a single controller of the
// aircraft each tick (no command fighting).
//
// Priority convention (lower index wins):
//   0  ForwardTerrainAvoid  — predicted ridge ahead → pull up early
//   1  MissileEvasion       — break active threats or die
//   2  Crank                — post-AAM-launch off-axis support
//   3  TerrainAvoid         — pull up; GPWS safety net (immediate AGL)
//   4  Engage               — target in envelope → steer & fire (stub)
//   5  Patrol               — waypoint / sector hold               (stub)
//   6  Cruise               — default; hold altitude + heading
//
// Add a new behavior: subclass Behavior, implement isActive + apply,
// register it in the priority list (see ai/index.js).
// ============================================================================

import { forwardLookTerrain } from '../sensorSystem.js';

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
// ForwardTerrainAvoidBehavior — predictive look-ahead pull-up.
//
// The plain TerrainAvoidBehavior below only reads AGL straight under
// the aircraft. By the time AGL gets dangerous on a fast jet diving
// for the deck during evasion, there's no pull-up room left — the NPC
// commits and dies. This behaviour is the predictive counterpart: it
// casts a chord forward along the unit's heading + pitch (sized by
// airspeed: 8 s of flight, with a 2.5 km floor) and checks if terrain
// rises into the path via `sensorSystem.forwardLookTerrain` (which
// uses the same multi-sample + curvature-corrected check Phase 3d
// landed for sensor masking).
//
// Priority is *above* MissileEvasion. A beaming NPC about to fly
// into a ridge will briefly hand control here, climb to clear, then
// MissileEvasion takes back over. We don't try to soft-blend pitch
// and heading authority — that would need a behaviour-arch change;
// instead the override is short-lived (a second or two) and rare,
// so the loss of beam continuity is acceptable. Heading is held at
// current heading (we don't rotate), only pitch is overridden, so
// the missile's geometry-prediction stays roughly valid.
//
// Throttled to 5 Hz so we don't pile globe.getHeight calls on every
// 60 Hz frame; the chord doesn't change meaningfully in 200 ms.
// ----------------------------------------------------------------------------
export class ForwardTerrainAvoidBehavior extends Behavior {
	constructor(opts = {}) {
		super('ForwardTerrainAvoid');
		this.lookAheadSeconds = opts.lookAheadSeconds ?? 8;
		this.minLookAheadM    = opts.minLookAheadM    ?? 2500;
		this.clearanceM       = opts.clearanceM       ?? 50;
		// Time-to-impact thresholds. Below `panicTtiS` we go full pull;
		// between panic and warn we ramp the climb command.
		this.warnTtiS  = opts.warnTtiS  ?? 7;
		this.panicTtiS = opts.panicTtiS ?? 2.5;
		// Internal cadence + cached result so isActive() can be queried
		// 60 Hz cheaply.
		this._lastCheckAt = -Infinity;
		this._cachedHit   = null;
		this._cachedTti   = Infinity;
	}

	_recheck(unit, now) {
		if (now - this._lastCheckAt < 0.2) return;
		this._lastCheckAt = now;
		const speed = Math.max(60, unit.speed || 0);
		const lookAhead = Math.max(this.minLookAheadM, speed * this.lookAheadSeconds);
		const hit = forwardLookTerrain(unit, lookAhead, 6, this.clearanceM);
		this._cachedHit = hit;
		this._cachedTti = hit ? (hit.distance / speed) : Infinity;
	}

	isActive(ctx) {
		const unit = ctx.unit;
		if (!unit) return false;
		// Don't fight the static-clamp on parked SAMs and similar.
		if (unit.isStatic) return false;
		this._recheck(unit, ctx.now ?? 0);
		// Active when an obstruction lies within the warning window.
		// Clearing happens automatically: once the NPC pitches up and
		// the chord is clear, the next recheck returns null and
		// isActive flips off, handing control back to the next
		// behaviour in the priority list (usually MissileEvasion or
		// Engage).
		return this._cachedHit !== null && this._cachedTti < this.warnTtiS;
	}

	apply(ctx, cmd) {
		const tti = this._cachedTti;
		// Pull-up urgency: smooth ramp from a gentle 18° at warnTti
		// down to a hard 45° at panicTti and below. Keeps the climb
		// proportional to the threat — gentle pulls preserve more
		// energy and don't fight the missile-evasion command quite as
		// hard when the ridge is still 6+ seconds away.
		const t = Math.max(0, Math.min(1,
			(this.warnTtiS - tti) / Math.max(0.1, this.warnTtiS - this.panicTtiS)));
		const targetPitch = 18 + 27 * t; // 18° → 45°
		cmd.targetPitch = targetPitch;
		// Hold current heading — we want to clear the obstacle without
		// abandoning whatever maneuver was in progress. Heading is the
		// missile-evasion behaviour's authority; we yield it back as
		// soon as we're clear.
		cmd.targetHeading = ctx.unit.heading;
		// Roll wings level so the climb is efficient (full lift vector
		// vertical). Behaviours don't address roll directly — they
		// command heading + pitch and the autopilot handles bank — but
		// the autopilot already keeps wings level when there's no
		// heading-change demand, so this falls out for free.
		cmd.throttle = 1.0;
		cmd.boost    = true;
		cmd.targetSpeed = 600;
		// Suppress weapons / countermeasures during the override —
		// we're 100% focused on not dying to terrain right now.
		cmd.fireWeapon = false;
		cmd.fireFlare  = false;
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
		if (!threat) {
			// No threat → reset the last-ditch jitter so the next
			// engagement picks a fresh random offset.
			this._jitterDeg = undefined;
			return;
		}
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
			// ---- Last-ditch: hard break into the beam. Used to pitch 30°
			// up, which guaranteed the target slipped out of the missile
			// seeker's ±25° vertical FOV — NPC evasion was 100% effective
			// and essentially broken. Now we use 15° (still a dramatic
			// pull) and add a small per-NPC heading jitter so not every
			// break is a textbook-perfect beam. Keeps the maneuver a
			// credible defense without making it automatic.
			if (this._jitterDeg === undefined) {
				this._jitterDeg = (Math.random() - 0.5) * 30; // ±15° bias
			}
			cmd.targetHeading = (beamHeading + this._jitterDeg + 360) % 360;
			cmd.targetPitch   = 15;
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
// CrankBehavior — BVR post-launch off-axis support.
//
// Real-world doctrine: after firing an active-radar missile (AIM-120,
// METEOR), you don't keep the nose on the bandit. You "crank" 35-50°
// off-axis. Two reasons:
//   1) Missile defense — putting the bandit on your beam reduces your
//      closure rate, makes their return shot harder to solve, and gives
//      you more lateral separation to evade if they shoot you back.
//   2) Datalink support — modern AESA radars can hold the target on
//      the gimbal edge well past 50° off-axis, so the missile keeps
//      getting midcourse updates even though our nose is dragged.
//
// We activate as soon as the pilot has an in-flight active-radar
// missile from this launcher, AND a valid target. We deactivate when
// every such missile has gone inactive (hit / dud / out of fuel) — at
// which point either Engage retakes (range still in envelope) or the
// pilot drifts back to cruise.
//
// `crankAngleDeg` is the off-axis bearing relative to the bandit. We
// alternate left/right per trigger so successive shooters don't crank
// into each other on a multi-ship engagement.
// ----------------------------------------------------------------------------
export class CrankBehavior extends Behavior {
	constructor(opts = {}) {
		super('Crank');
		this.crankAngleDeg = opts.crankAngleDeg ?? 40;
		// Switch which side we crank toward each time we re-trigger,
		// so a four-ship doesn't all crank into the same airspace and
		// pile up.
		this._side = (Math.random() < 0.5) ? +1 : -1;
		// Cache the side once we've started cranking and only flip
		// after the engagement resolves, so a single crank doesn't
		// oscillate side every frame.
		this._activeSide = null;
	}

	// Find any in-flight active-radar missile we launched that's still
	// supporting on a target. Reads ctx.projectiles (the world-wide
	// projectile pool). The launcher comparison is reference-equality
	// against the unit, so this Just Works for both NPC and player
	// pilots if they ever get one.
	_supportingMissile(ctx) {
		const proj = ctx.projectiles;
		if (!Array.isArray(proj) || proj.length === 0) return null;
		const me = ctx.unit;
		for (const p of proj) {
			if (!p || !p.active) continue;
			if (p.launcher !== me) continue;
			// Only crank for active-radar missiles (the ones that need
			// midcourse datalink). IR Sidewinders are fire-and-forget
			// — no support needed, keep the nose on the bandit.
			const t = p.type;
			if (t !== 'AIM-120' && t !== 'METEOR' && t !== 'NASAMS-MSL' && t !== 'TOR-MSL' && t !== 'R-77' && t !== 'R-37M') continue;
			return p;
		}
		return null;
	}

	isActive(ctx) {
		const tm = this.pilot.subsystems.targetManager;
		if (!tm || !tm.getBest()) return false;
		const m = this._supportingMissile(ctx);
		if (!m) {
			// Nothing in flight from us → reset side bias for the
			// next shot.
			this._activeSide = null;
			return false;
		}
		return true;
	}

	apply(ctx, cmd) {
		const tm   = this.pilot.subsystems.targetManager;
		const best = tm.getBest();
		const unit = ctx.unit;

		// Bearing FROM our nose TO the bandit's projected position.
		const bearingToTgt = bearingFromTo(unit, { lon: best.estPos.lon, lat: best.estPos.lat });

		// Lock in a crank side at the moment we start supporting; keep
		// it until the missile resolves. Without this lock the side
		// would flip every time `isActive` re-evaluates and the NPC
		// would porpoise across the bandit's nose.
		if (this._activeSide === null) {
			this._activeSide = this._side;
			// Flip the next-shooter bias so a follow-up wingman shot
			// cranks the other way.
			this._side = -this._side;
		}

		// Crank heading = bandit bearing ± crankAngle. Sign depends on
		// which side we picked.
		const cranked = (bearingToTgt + this._activeSide * this.crankAngleDeg + 360) % 360;
		cmd.targetHeading = cranked;

		// Hold a sensible BVR support altitude/speed. Stay AB-warm so
		// we have energy if the bandit tries to crank back into us
		// after launch. Don't fire — Engage handles that and we're
		// already supporting an in-flight missile.
		const alt = unit.alt;
		if      (alt < 6000)  cmd.targetPitch =  3;
		else if (alt > 11000) cmd.targetPitch = -2;
		else                  cmd.targetPitch =  0;
		cmd.targetSpeed = 380;
		cmd.throttle    = 0.95;
		cmd.boost       = false;
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
		const { target, range, estPos, estVel, estSpeed } = best;
		const unit = ctx.unit;

		// Pre-pick the weapon so steering knows whether we need a lead
		// solution (gun) or just point-at-target (missiles, which do
		// their own guidance post-launch).
		const now = ctx.now;
		const weapon = ws && ws.pickWeaponFor(range, now, ctx.projectiles || [], unit);
		const isGun = weapon && weapon.type === 'gun';

		// ---- Pursuit geometry ------------------------------------------------
		// Aspect: vector from target to self, dotted with target's fwd.
		//   aspectCos = -1  → we're at bandit's 6 o'clock  (rear hemisphere)
		//   aspectCos =  0  → beam
		//   aspectCos = +1  → dead ahead of bandit (head-on merge)
		// Rear hemisphere is where guns work. Front/beam means we need
		// to fly a LAG-pursuit curve — aim at a point 800 m behind the
		// bandit along their reverse velocity, which pulls us inside
		// their turn circle and bleeds aspect until we're in the rear.
		const cosLat = Math.cos(unit.lat * Math.PI / 180);
		const selfFromTgtE = (unit.lon - estPos.lon) * 111320 * cosLat;
		const selfFromTgtN = (unit.lat - estPos.lat) * 111320;
		const selfFromTgtU = (unit.alt - estPos.alt);
		const selfLen = Math.sqrt(selfFromTgtE*selfFromTgtE + selfFromTgtN*selfFromTgtN + selfFromTgtU*selfFromTgtU) || 1;
		const spd = Math.max(1, estSpeed);
		const aspectCos = (selfFromTgtE*estVel.E + selfFromTgtN*estVel.N + selfFromTgtU*estVel.U) / (selfLen * spd);
		// In bandit's rear hemisphere: aspectCos < 0. A threshold of
		// -0.2 (≈100° off their nose) is the "acceptable gun shot"
		// window — tighter than this produces chattering between lead
		// and lag as we cross beam aspect.
		const inRearHemisphere = aspectCos < -0.2;

		let aimHeading, aimPitch;
		// Always compute the gun lead solution when the chosen weapon is
		// a gun — we need it for snapshot fire decisions even when our
		// steering is using lag pursuit. `leadHeading/Pitch` is the
		// "where bullets arrive" direction; `aimHeading/Pitch` is what
		// we tell the autopilot to fly.
		let leadHeading = null;
		let leadPitch   = null;
		if (isGun) {
			const lead = this._computeGunLead(unit, {
				lon: estPos.lon, lat: estPos.lat, alt: estPos.alt,
				heading: best.estHeading, pitch: best.estPitch, speed: estSpeed,
			});
			leadHeading = lead.heading;
			leadPitch   = lead.pitch;
		}

		if (isGun && inRearHemisphere) {
			// Standard tracking shot from bandit's rear hemisphere.
			// Steer to the lead solution and fire when the pipper
			// settles.
			aimHeading = leadHeading;
			aimPitch   = leadPitch;
		} else if (isGun) {
			// Outside the rear hemisphere we lag-pursue toward the
			// bandit's tail to bleed aspect. Lag point: 800 m behind
			// the bandit's projected position along their reverse
			// velocity. As they turn, the lag point tracks with them,
			// so we're always flying at "chase their tail" — cuts
			// inside their turn circle.
			const invSpd = 1 / spd;
			const aimLon = estPos.lon - (estVel.E * invSpd * 800) / (111320 * cosLat);
			const aimLat = estPos.lat - (estVel.N * invSpd * 800) / 111320;
			const aimAlt = estPos.alt - (estVel.U * invSpd * 800);
			const dE = (aimLon - unit.lon) * 111320 * cosLat;
			const dN = (aimLat - unit.lat) * 111320;
			const dU = aimAlt - unit.alt;
			const horiz = Math.sqrt(dE*dE + dN*dN);
			aimHeading = (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360;
			aimPitch   = Math.atan2(dU, horiz) * 180 / Math.PI;
		} else {
			// Missile engagement: point at the projected target. The
			// missile does its own guidance after launch.
			aimHeading = bearingFromTo(unit, { lon: estPos.lon, lat: estPos.lat });
			aimPitch   = null;
		}
		cmd.targetHeading = aimHeading;

		// Altitude policy: for missile BVR, hold the 4-10 km band. For
		// a gun tracking shot we need to actually point the nose UP/DOWN
		// at the target — a co-altitude band policy would miss every
		// vertical merge. Gun pitch = lead-solution pitch, clipped wide
		// enough to follow a vertically maneuvering bandit.
		const angleOff = Math.abs(angleDiffDeg(unit.heading, cmd.targetHeading));
		if (isGun && aimPitch !== null) {
			cmd.targetPitch = Math.max(-45, Math.min(45, aimPitch));
			// Reattack vs. tracking. When the nose is far off the pipper
			// (post-merge crossing, or chasing a hard-turning bandit),
			// we're in an energy-fight — firewall AB and commit to the
			// turn. When we're close to the pipper we want SMOOTH
			// tracking — no AB, steady throttle, so the gun solution
			// doesn't wobble off the target.
			if (angleOff > 20) {
				cmd.throttle    = 1.0;
				cmd.boost       = true;
				cmd.targetSpeed = 600;
			} else {
				cmd.throttle    = 0.9;
				cmd.boost       = false;
				cmd.targetSpeed = 380;
			}
		} else {
			const alt = unit.alt;
			if      (alt < this.cruiseAltMin) cmd.targetPitch =  5;
			else if (alt > this.cruiseAltMax) cmd.targetPitch = -3;
			else                              cmd.targetPitch =  0;
			cmd.targetSpeed = this.cruiseSpeed;
			cmd.throttle    = 0.85;
			cmd.boost       = false;
		}

		if (!weapon) return;

		// ---- WEZ (Weapons Employment Zone) gate for active-radar AAMs -------
		//
		// `WeaponSubsystem.maxRange` is the kinematic Rmax — the
		// theoretical edge of the missile's envelope. Real PK falls off
		// fast inside that limit because a bled-out AMRAAM can't pull G
		// at terminal phase (Phase 1.4 already enforces this in the
		// missile's own kinematics — the AI just needs to not fire
		// pointless shots from the absolute edge). Effective range
		// scales with target aspect:
		//   - bandit closing on us (aspectCos > 0) → full envelope
		//   - bandit beaming (aspectCos ≈ 0)       → ~65% of envelope
		//   - bandit running cold (aspectCos < 0)  → ~30% of envelope
		// Below those thresholds we hold fire and either keep cranking
		// in (Engage steers nose-on) or, if pre-launch, just close.
		const isRadarAam = weapon.type === 'AIM-120'
			|| weapon.type === 'METEOR'
			|| weapon.type === 'NASAMS-MSL'
			|| weapon.type === 'TOR-MSL'
			|| weapon.type === 'R-77'
			|| weapon.type === 'R-37M';
		if (isRadarAam) {
			// aspectCos was computed above for the gun-aspect check.
			// +1 = bandit pointing at us (head-on); -1 = bandit cold.
			const wezScale = 0.3 + 0.7 * Math.max(0, (1 + aspectCos) / 2);
			const effectiveMax = weapon.maxRange * wezScale;
			if (range > effectiveMax) return;
		}

		// ---- Firing gate ----------------------------------------------------
		//
		// Gun and missile decisions are different. For missiles we just
		// check the steering aim is within `fireConeDeg` and let the
		// seeker handle the rest. For guns we evaluate the LEAD
		// solution: a head-on or beam merge can produce a perfectly
		// good snapshot if our nose happens to cross the bullet-impact
		// direction, even though we're flying lag pursuit overall.
		// That's why real fighters get high-aspect M61 kills on the
		// merge — the gun cares where bullets arrive, not where the
		// pursuit-pursuit aim point is.
		if (isGun) {
			// Tight fire cone — M61 dispersion is tiny (~5 mils) so
			// realistic hit probability requires the pipper actually
			// on the target. 4° is roughly 70 m at 1 km.
			const FIRE_CONE_TRACKING = 4;  // sustained tracking shot
			const FIRE_CONE_SNAP     = 3;  // snapshot cone (tighter, since
			                                // we only get one or two frames)

			const headingErrToLead = Math.abs(angleDiffDeg(unit.heading, leadHeading));
			const pitchErrToLead   = Math.abs(unit.pitch - leadPitch);

			// Range check: even with lead-on-pipper, beyond ~3.2 km
			// the bullet flight time exceeds 2 s and the target moves
			// out of the kill volume before bullets arrive. Real
			// combat-effective gun range ≈ that distance.
			if (range > 3200) return;

			const inFireCone = inRearHemisphere
				? (headingErrToLead < FIRE_CONE_TRACKING && pitchErrToLead < FIRE_CONE_TRACKING)
				: (headingErrToLead < FIRE_CONE_SNAP    && pitchErrToLead < FIRE_CONE_SNAP);
			if (!inFireCone) return;
		} else {
			// Missile fire: just check steering aim aligns with target
			// projection. Seeker / datalink takes it from there.
			const fireCone = this.fireConeDeg;
			const pitchErr = aimPitch !== null ? Math.abs(unit.pitch - aimPitch) : 0;
			if (angleOff > fireCone) return;
			if (pitchErr > fireCone) return;
		}

		// ---- Phase 3c: STT pre-fire flash (radar AAMs only) -----------------
		//
		// All firing gates have passed. For an active-radar shot we
		// don't pull the trigger immediately — we briefly "snap" the
		// radar to STT so the bandit's RWR has a chance to scream
		// before the missile is on the rail. ~1.5 s of advertised
		// lock matches modern AESA doctrine: TWS-cruise, flash to STT
		// for the launch, back to TWS for the support phase. The
		// commit timestamp lives on the pilot so the radar-mode
		// manager in npcUpdate can read it.
		if (isRadarAam) {
			const FLASH_S = 1.5;
			if (this.pilot._sttCommitTarget !== target) {
				// First frame of commit — record the timestamp + target
				// and let this frame end with no fire. The radar will
				// flip to STT on the next mode-management tick.
				this.pilot._sttCommitAt = ctx.now;
				this.pilot._sttCommitTarget = target;
				return;
			}
			if ((ctx.now - this.pilot._sttCommitAt) < FLASH_S) {
				return; // still flashing — bandit is being warned
			}
			// Flash window has elapsed. Fire and clear the commit
			// state. (The live-missile check in npcUpdate will keep
			// the radar in track for datalink support.)
			this.pilot._sttCommitAt = null;
			this.pilot._sttCommitTarget = null;
		}

		cmd.fireWeapon   = true;
		cmd.weaponType   = weapon.type;
		cmd.weaponTarget = target;
	}

	// Iterative lead solution for gun fire. Bullet ground speed equals
	// shooter speed + 1500 m/s (see Bullet.js muzzle vel). Two passes
	// converge because bullet flight time at gun range is ~1-4 s and
	// target velocity is bounded. Output: heading/pitch (degrees) the
	// shooter's nose needs to point at to hit a moving target NOW.
	_computeGunLead(shooter, target) {
		const latRad = shooter.lat * Math.PI / 180;
		const cosLat = Math.cos(latRad);

		let dE = (target.lon - shooter.lon) * 111320 * cosLat;
		let dN = (target.lat - shooter.lat) * 111320;
		let dU = (target.alt - shooter.alt);

		const tHdg = (target.heading || 0) * Math.PI / 180;
		const tPit = (target.pitch   || 0) * Math.PI / 180;
		const tSpd = target.speed || 0;
		const tvE = Math.sin(tHdg) * Math.cos(tPit) * tSpd;
		const tvN = Math.cos(tHdg) * Math.cos(tPit) * tSpd;
		const tvU = Math.sin(tPit) * tSpd;

		const bulletSpd = (shooter.speed || 0) + 1500;

		let tof = Math.sqrt(dE*dE + dN*dN + dU*dU) / bulletSpd;
		for (let i = 0; i < 2; i++) {
			const lE = dE + tvE * tof;
			const lN = dN + tvN * tof;
			const lU = dU + tvU * tof;
			tof = Math.sqrt(lE*lE + lN*lN + lU*lU) / bulletSpd;
		}
		const leadE = dE + tvE * tof;
		const leadN = dN + tvN * tof;
		const leadU = dU + tvU * tof;

		const horiz = Math.sqrt(leadE*leadE + leadN*leadN);
		const heading = (Math.atan2(leadE, leadN) * 180 / Math.PI + 360) % 360;
		const pitch   = Math.atan2(leadU, horiz) * 180 / Math.PI;
		return { heading, pitch };
	}
}

// ----------------------------------------------------------------------------
// FormationBehavior — wingman stationkeeping under a leader.
//
// Active for any unit listed in `formation.members` while its mode is
// formation. The wingman computes its slot offset in the leader's
// body frame, projects that to a world-space target lat/lon/alt, and
// flies a heading + pitch + throttle command toward that target.
//
// Priority is HIGH (above Engage / Cruise) so a wingman in formation
// never wanders off chasing bandits — the player picks targets.
// Below MissileEvasion + ForwardTerrainAvoid: a wingman with a
// missile up its tail breaks formation to defend, and pulls up for
// terrain. Reforms automatically when the threat clears (mode is
// still formation, isActive returns true again).
// ----------------------------------------------------------------------------
import { formation, getMemberMode, FORMATION_SLOTS, MODE_FORMATION } from '../formation.js';

export class FormationBehavior extends Behavior {
	constructor() { super('Formation'); }
	isActive(ctx) {
		const u = ctx.unit;
		if (!u || !formation.leader) return false;
		if (!formation.members.includes(u)) return false;
		if (getMemberMode(u) !== MODE_FORMATION) return false;
		// If leader is dead, hand control to next behavior (Cruise →
		// the wingman just keeps flying straight).
		if (formation.leader.destroyed) return false;
		return true;
	}

	apply(ctx, cmd, _dt) {
		const u      = ctx.unit;
		const leader = formation.leader;
		const slot   = FORMATION_SLOTS[u._wingmanSlot] || FORMATION_SLOTS[0];

		// Body-frame slot offset rotated by the leader's heading. Body
		// +X = right, +Y = forward. Slot.right is body +X, slot.back
		// is body -Y. After rotation by leader heading, project to
		// ENU (east, north).
		const hRad = (leader.heading || 0) * Math.PI / 180;
		const bodyE =  slot.right;
		const bodyN = -slot.back;
		const east  = bodyE * Math.cos(hRad) + bodyN * Math.sin(hRad);
		const north = -bodyE * Math.sin(hRad) + bodyN * Math.cos(hRad);

		const cosLat = Math.cos((leader.lat || 0) * Math.PI / 180) || 1;
		const tgtLon = leader.lon + east  / (111320 * cosLat);
		const tgtLat = leader.lat + north / 111320;
		const tgtAlt = leader.alt;

		// Heading: aim at the target slot, with a small lead so we
		// don't lag behind during turns. When far from the slot, pure
		// pursuit works fine; close in, blend in the leader's heading
		// to avoid swinging through the slot.
		const dE = (tgtLon - u.lon) * 111320 * cosLat;
		const dN = (tgtLat - u.lat) * 111320;
		const dist = Math.hypot(dE, dN);
		const pursuitHeading = (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360;
		const blend = Math.min(1, dist / 200);  // <200 m: hold leader heading
		// Smallest-arc blend between leader and pursuit heading.
		const dh = angleDiffDeg(leader.heading || 0, pursuitHeading);
		cmd.targetHeading = (((leader.heading || 0) + dh * blend) + 360) % 360;

		// Pitch: aim at the slot altitude. Soft so we don't oscillate.
		const altErr = tgtAlt - u.alt;
		cmd.targetPitch = Math.max(-15, Math.min(15, altErr * 0.05));

		// Throttle: match the leader's velocity along the leader-to-
		// slot axis. When ahead/short of slot, throttle up/down to
		// catch up. Use leader speed as the baseline + a position-
		// error correction in m/s.
		const leaderSpd = Math.max(80, leader.speed || 250);
		// Project the slot-relative position onto the heading axis to
		// see if we're trailing or overshooting.
		const headRad = (leader.heading || 0) * Math.PI / 180;
		const fE =  Math.sin(headRad);
		const fN =  Math.cos(headRad);
		const along = dE * fE + dN * fN;   // + = slot is ahead, - = behind
		// Catch up faster when far behind; ease off when close.
		const correction = Math.max(-30, Math.min(60, along * 0.4));
		cmd.targetSpeed = leaderSpd + correction;
		cmd.throttle    = Math.max(0.4, Math.min(1.0, 0.7 + correction / 100));
		cmd.boost       = (cmd.throttle >= 0.99 && correction > 30);

		// Suppress weapons / countermeasures while in formation. The
		// player's WeaponSystem.fire path commands the wingman to
		// shoot directly; we never want the wingman's own engage AI
		// to launch on its initiative while flying lead's wing.
		cmd.fireWeapon = false;
		cmd.fireFlare  = false;
		cmd.fireChaff  = false;
	}
}

// ----------------------------------------------------------------------------
// PatrolRtbBehavior — break-formation "go home and orbit" mode.
//
// Used when a wingman has expended all strike-class ammo and the
// flight's break behavior is set to RTB. Wingman heads back to the
// formation spawn point (`formation.spawnPoint`) and orbits there at 9 km
// altitude with a 5 km radius. Will engage a hostile inside 10 km
// with whatever AAMs it has left, but doesn't go looking for trouble.
// Priority sits between Engage and Cruise — gets to drive cruise-style
// patrol when nothing tactical is happening.
// ----------------------------------------------------------------------------
export class PatrolRtbBehavior extends Behavior {
	constructor() { super('PatrolRTB'); }
	isActive(ctx) {
		return getMemberMode(ctx.unit) === 'patrol-rtb' &&
			formation.members.includes(ctx.unit) &&
			formation.spawnPoint != null;
	}
	apply(ctx, cmd, _dt) {
		const u  = ctx.unit;
		const sp = formation.spawnPoint;
		const orbitAlt = 9000;
		const orbitRad = 5000;

		const cosLat = Math.cos((u.lat || 0) * Math.PI / 180) || 1;
		const dE = (u.lon - sp.lon) * 111320 * cosLat;
		const dN = (u.lat - sp.lat) * 111320;
		const radius = Math.hypot(dE, dN);

		// Tangential heading to maintain orbit (CCW), with radial
		// correction so we don't drift inward/outward.
		const radialBearing = Math.atan2(dE, dN) * 180 / Math.PI;
		let headingCmd = (radialBearing + 90 + 360) % 360;
		const radialErr = radius - orbitRad;
		headingCmd += Math.max(-25, Math.min(25, radialErr * 0.001));
		cmd.targetHeading = (headingCmd + 360) % 360;

		const altErr = orbitAlt - u.alt;
		cmd.targetPitch = Math.max(-8, Math.min(8, altErr * 0.01));
		cmd.targetSpeed = 220;
		cmd.throttle    = 0.55;
	}
}

// ----------------------------------------------------------------------------
// PatrolCapBehavior — break-formation "stay near the player" mode.
//
// Used when a wingman has expended all strike-class ammo and the
// flight's break behavior is CAP. Orbits at 6 km altitude with a 4 km
// radius around the leader's CURRENT position (not the spawn point —
// the lead is presumably still ingressing). Yields to Engage above
// (regular fighter doctrine) so the wingman uses any AAMs it has on
// nearby hostiles.
// ----------------------------------------------------------------------------
export class PatrolCapBehavior extends Behavior {
	constructor() { super('PatrolCAP'); }
	isActive(ctx) {
		return getMemberMode(ctx.unit) === 'patrol-cap' &&
			formation.members.includes(ctx.unit) &&
			formation.leader && !formation.leader.destroyed;
	}
	apply(ctx, cmd, _dt) {
		const u = ctx.unit;
		const center = formation.leader;
		const orbitAlt = 6000;
		const orbitRad = 4000;

		const cosLat = Math.cos((u.lat || 0) * Math.PI / 180) || 1;
		const dE = (u.lon - center.lon) * 111320 * cosLat;
		const dN = (u.lat - center.lat) * 111320;
		const radius = Math.hypot(dE, dN);

		const radialBearing = Math.atan2(dE, dN) * 180 / Math.PI;
		let headingCmd = (radialBearing + 90 + 360) % 360;
		const radialErr = radius - orbitRad;
		headingCmd += Math.max(-25, Math.min(25, radialErr * 0.001));
		cmd.targetHeading = (headingCmd + 360) % 360;

		const altErr = orbitAlt - u.alt;
		cmd.targetPitch = Math.max(-8, Math.min(8, altErr * 0.01));
		cmd.targetSpeed = 260;
		cmd.throttle    = 0.65;
	}
}
