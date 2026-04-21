// ============================================================================
// Subsystems — shared capability/state that behaviors query.
//
// Behaviors are stateless decision makers; subsystems are where persistent
// state lives (inventory, cooldowns, derived target data). Adding a new
// subsystem never touches existing behaviors — just attach via
// pilot.addSubsystem(name, subsystem) and read via pilot.subsystems[name].
//
// Current roster:
//   CountermeasureSubsystem — flare + chaff counts and cooldowns
//   TargetManagerSubsystem  — score contacts, pick best target to engage
//   WeaponSubsystem         — inventory + envelope checks + fire cooldown
//
// Planned (later passes):
//   FuelManager       — track fuel, force RTB when low
//   RWRClassifier     — map raw RWR pings to threat categories
// ============================================================================

class Subsystem {
	constructor(name) {
		this.name  = name;
		this.pilot = null; // attached by Pilot.addSubsystem
	}
	update(_ctx, _dt) {}
}

// ----------------------------------------------------------------------------
// CountermeasureSubsystem — flare + chaff inventory and rate limiting.
//
// A behavior asks `cm.canFlare()` / `cm.consumeFlare()` to actually drop
// one; this isolates the "do I have any left?" and "is my dispenser
// cooling?" logic from the tactical decision. The pilot writes the intent
// (command.fireFlare) and the NPC code (npcSystem) asks the subsystem
// whether to actually spawn the flare effect.
// ----------------------------------------------------------------------------
export class CountermeasureSubsystem extends Subsystem {
	constructor(opts = {}) {
		super('CountermeasureSubsystem');
		this.flareCount = opts.flares ?? 30;
		this.chaffCount = opts.chaff  ?? 30;
		this.minFlareInterval = opts.minFlareInterval ?? 0.25;
		this.minChaffInterval = opts.minChaffInterval ?? 0.25;
		this._lastFlare = -Infinity;
		this._lastChaff = -Infinity;
	}

	update(_ctx, _dt) {} // stateless tick

	canFlare(now) {
		return this.flareCount > 0 && (now - this._lastFlare) >= this.minFlareInterval;
	}
	canChaff(now) {
		return this.chaffCount > 0 && (now - this._lastChaff) >= this.minChaffInterval;
	}

	// Returns true if a flare was actually dispensed (inventory + cooldown ok).
	consumeFlare(now) {
		if (!this.canFlare(now)) return false;
		this.flareCount--;
		this._lastFlare = now;
		return true;
	}
	consumeChaff(now) {
		if (!this.canChaff(now)) return false;
		this.chaffCount--;
		this._lastChaff = now;
		return true;
	}
}

// ----------------------------------------------------------------------------
// TargetManagerSubsystem — pick the best hostile contact to shoot at.
//
// Runs each frame, walks the unit's sensor contacts, scores them, and
// caches the top pick for behaviors to read. Keeping this as a subsystem
// (rather than re-scoring inside EngageBehavior) lets the pilot tell
// "no valid target" from "no engage behavior" cleanly, and makes the
// scoring swappable for future difficulty levels / AWACS-guided AI.
//
// Scoring today:
//   - Exclude own team, missiles, and destroyed units.
//   - Require at least a radar range (no engaging passive contacts —
//     real AAMs need a firing solution).
//   - Closer is better. Tied-range falls back to insertion order.
// Future upgrades: threat weighting (who's shooting at us), aspect
// (avoid bore-on head-on shots), priority target assignment.
// ----------------------------------------------------------------------------
export class TargetManagerSubsystem extends Subsystem {
	constructor(opts = {}) {
		super('TargetManagerSubsystem');
		this.maxEngagementRange = opts.maxEngagementRange ?? 70000;
		this._best = null;
	}

	// Score a candidate target. Heavy positive score = prefer. Closer is
	// better; being already engaged by a teammate is a big penalty so the
	// pilot naturally picks unengaged bogeys. Not an absolute exclusion
	// because if ALL targets are engaged we still want to shoot something
	// (better a second missile than no missile).
	_scoreCandidate(target, range, ctx) {
		let score = -range;
		const dl = ctx.teamDatalink;
		if (dl && dl.isEngaged(target)) score -= 50000; // 50 km penalty
		return score;
	}

	update(ctx, _dt) {
		const unit = ctx.unit;
		this._best = null;

		// Build candidate set from two sources:
		//   1. Unit's own contacts (highest fidelity, preferred).
		//   2. Team datalink fused contacts (wingman / AWACS picture).
		// A target appears once, with the unit's own range used when
		// available and the fused range as a fallback.
		const candidates = new Map(); // target → { range, contact, source }
		if (unit.contacts) {
			for (const [target, c] of unit.contacts) {
				const range = (c.radar && c.radar.range) || null;
				if (range == null) continue;
				candidates.set(target, { range, contact: c, source: 'own' });
			}
		}
		if (ctx.teamDatalink) {
			for (const [target, fused] of ctx.teamDatalink.allContacts()) {
				if (candidates.has(target)) continue; // own radar wins
				if (fused.range == null) continue;
				candidates.set(target, { range: fused.range, contact: null, source: 'datalink' });
			}
		}

		let best = null;
		let bestScore = -Infinity;
		for (const [target, cand] of candidates) {
			if (!target || target === unit) continue;
			if (target.destroyed || target.active === false) continue;
			if (target.team === unit.team) continue;
			const sig = target.signature;
			if (!sig) continue;
			if (sig.unitClass === 'missile' || sig.unitClass === 'cruise_missile') continue;
			if (cand.range > this.maxEngagementRange) continue;

			const score = this._scoreCandidate(target, cand.range, ctx);
			if (score > bestScore) {
				bestScore = score;
				best = { target, contact: cand.contact, range: cand.range, source: cand.source };
			}
		}
		this._best = best;
	}

	getBest() { return this._best; }
}

// ----------------------------------------------------------------------------
// WeaponSubsystem — ammo, cooldowns, envelope.
//
// The pilot (via EngageBehavior) calls pickWeaponFor(target, range) to
// select a weapon that is (a) loaded, (b) off cooldown, (c) in its firing
// envelope. If the call site then commits to firing, it invokes
// consume(weapon) to deduct ammo and reset the cooldown.
//
// The envelope model is deliberately coarse — each weapon has a flat
// [minRange, maxRange] window. Future: per-missile PK models, Rmax/Rmin
// dynamic envelopes based on aspect/altitude, "no escape zone" flag.
// ----------------------------------------------------------------------------
export class WeaponSubsystem extends Subsystem {
	constructor(opts = {}) {
		super('WeaponSubsystem');
		// Default NPC fighter loadout. AIM-120 is preferred because of range
		// (BVR opportunities before IR merge). Both weapons have:
		//   fireRate      — minimum seconds between successive launches of
		//                    the same weapon type. Set to approximately one
		//                    "commit interval" (see discussion below).
		//   maxInFlight   — hard cap on live projectiles of this weapon
		//                    currently in the air from this launcher.
		// Combined these force real "shoot-look-shoot" BVR behaviour rather
		// than emptying the magazine in one trigger pull. With AIM-120
		// fireRate=12 and maxInFlight=1, the NPC fires one, waits until it
		// either hits or goes inactive, and only then re-engages — matching
		// how an actual fighter pilot uses AMRAAMs.
		this.weapons = opts.weapons || [
			{ type: 'AIM-120', ammo: 4, maxAmmo: 4, fireRate: 12.0, maxInFlight: 1,
			  lastFire: -Infinity, minRange: 3000,  maxRange: 70000 },
			{ type: 'AIM-9',   ammo: 2, maxAmmo: 2, fireRate: 3.0,  maxInFlight: 2,
			  lastFire: -Infinity, minRange: 500,   maxRange: 9000  },
		];
	}

	update(_ctx, _dt) {}

	// Walk the inventory in preference order (longest-range first) and
	// return the first weapon that is (a) loaded, (b) off cooldown,
	// (c) within its firing envelope, and (d) under its in-flight cap.
	// `projectiles` is the world-wide combined projectile pool; we count
	// the ones that reference the given launcher to enforce maxInFlight.
	pickWeaponFor(range, now, projectiles = [], launcher = null) {
		for (const w of this.weapons) {
			if (w.ammo <= 0) continue;
			if (range < w.minRange || range > w.maxRange) continue;
			if (now - w.lastFire < w.fireRate) continue;
			if (w.maxInFlight && launcher) {
				let live = 0;
				for (const p of projectiles) {
					if (!p || !p.active) continue;
					if (p.launcher !== launcher) continue;
					if (p.type !== w.type) continue;
					live++;
					if (live >= w.maxInFlight) break;
				}
				if (live >= w.maxInFlight) continue;
			}
			return w;
		}
		return null;
	}

	// Deduct ammo and stamp the cooldown. Returns the weapon that fired
	// (null if the ammo/cooldown state slipped between pick and consume,
	// which shouldn't happen in normal flow but is guarded against).
	consume(weapon, now) {
		if (!weapon || weapon.ammo <= 0) return null;
		if (now - weapon.lastFire < weapon.fireRate) return null;
		weapon.ammo--;
		weapon.lastFire = now;
		return weapon;
	}
}
