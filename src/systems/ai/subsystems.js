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
		// Dead-reckoning memory: how long to keep projecting a target
		// forward after the last sensor contact expired. 20 s covers a
		// full reversal turn at 400 m/s (≈4 km radius, ~15 s for 360°).
		this.memoryTTL = opts.memoryTTL ?? 20;
		this.memory = new Map(); // target → snapshot { lon, lat, alt, heading, pitch, speed, timeSeen }
		this._best = null;
	}

	// Score a candidate target. Heavy positive score = prefer. Closer is
	// better; being already engaged by a teammate is a big penalty so the
	// pilot naturally picks unengaged bogeys. Not an absolute exclusion
	// because if ALL targets are engaged we still want to shoot something
	// (better a second missile than no missile).
	_scoreCandidate(cand, ctx) {
		let score = -cand.range;
		const dl = ctx.teamDatalink;
		if (dl && dl.isEngaged(cand.target)) score -= 50000; // 50 km penalty
		// Memory (stale) contacts are still engageable but mildly
		// deprioritized so a fresh sensor contact wins a tie. Penalty
		// grows linearly with staleness, so a 10 s-old projection loses
		// to a 2 s-old one but can still beat a 40-km live contact.
		if (cand.isMemory) score -= 500 * cand.age;
		return score;
	}

	// Refresh memory snapshot for a target we can currently see. Stores
	// the truth state — it's fair because the sensor DID detect the
	// target this frame; we're just recording what the pilot observed.
	_refreshMemory(target, now) {
		this.memory.set(target, {
			lon: target.lon,
			lat: target.lat,
			alt: target.alt,
			heading: target.heading || 0,
			pitch:   target.pitch   || 0,
			speed:   target.speed   || 0,
			timeSeen: now,
		});
	}

	// Turn a memory snapshot into a dead-reckoned candidate: project
	// position forward from timeSeen using the last-known velocity
	// vector. This is what lets an NPC keep chasing a target that's
	// briefly masked behind its own fuselage during a post-merge
	// reversal — "he was here heading east at 300 m/s 3 s ago, so
	// right now he's probably ~900 m east of here".
	_projectMemory(target, snap, unit, now) {
		const age = now - snap.timeSeen;
		const hRad = snap.heading * Math.PI / 180;
		const pRad = snap.pitch   * Math.PI / 180;
		const vE = Math.sin(hRad) * Math.cos(pRad) * snap.speed;
		const vN = Math.cos(hRad) * Math.cos(pRad) * snap.speed;
		const vU = Math.sin(pRad) * snap.speed;
		const cosLat = Math.cos(snap.lat * Math.PI / 180);
		const estLon = snap.lon + (vE * age) / (111320 * cosLat);
		const estLat = snap.lat + (vN * age) / 111320;
		const estAlt = snap.alt + vU * age;

		const uCosLat = Math.cos(unit.lat * Math.PI / 180);
		const dE = (estLon - unit.lon) * 111320 * uCosLat;
		const dN = (estLat - unit.lat) * 111320;
		const dU = estAlt - unit.alt;
		const range = Math.sqrt(dE*dE + dN*dN + dU*dU);

		return {
			target, range, age,
			estPos: { lon: estLon, lat: estLat, alt: estAlt },
			estVel: { E: vE, N: vN, U: vU },
			estHeading: snap.heading,
			estPitch:   snap.pitch,
			estSpeed:   snap.speed,
			isMemory:   age > 0.1,
		};
	}

	update(ctx, _dt) {
		const unit = ctx.unit;
		const now  = ctx.now ?? 0;
		this._best = null;

		// Step 1: refresh memory for any target currently on a live
		// sensor channel (own contacts) or fused via team datalink.
		// This is the ONLY place we touch target truth state — from
		// here on, downstream code uses the memory snapshot.
		if (unit.contacts) {
			for (const [target, c] of unit.contacts) {
				if (!target || target.destroyed) continue;
				if (c.radar || c.ir || c.visual) this._refreshMemory(target, now);
			}
		}
		if (ctx.teamDatalink) {
			for (const [target] of ctx.teamDatalink.allContacts()) {
				if (!target || target.destroyed) continue;
				if (!this.memory.has(target) || (now - this.memory.get(target).timeSeen) > 0.5) {
					this._refreshMemory(target, now);
				}
			}
		}

		// Step 2: expire stale memory. Targets we haven't seen in
		// memoryTTL seconds fall off the engageable list entirely.
		for (const [target, snap] of this.memory) {
			if (!target || target.destroyed || (now - snap.timeSeen) > this.memoryTTL) {
				this.memory.delete(target);
			}
		}

		// Step 3: project every remaining memory entry forward to
		// "where is the target estimated to be right now". For fresh
		// contacts age ≈ 0 so the projection equals the truth; for
		// stale contacts the projection holds the ghost of the bandit
		// in the spot the pilot expects based on what they last saw.
		const candidates = [];
		for (const [target, snap] of this.memory) {
			if (target === unit) continue;
			if (target.team === unit.team) continue;
			const sig = target.signature;
			if (!sig) continue;
			if (sig.unitClass === 'missile' || sig.unitClass === 'cruise_missile') continue;
			const cand = this._projectMemory(target, snap, unit, now);
			if (cand.range > this.maxEngagementRange) continue;
			candidates.push(cand);
		}

		let best = null;
		let bestScore = -Infinity;
		for (const cand of candidates) {
			const score = this._scoreCandidate(cand, ctx);
			if (score > bestScore) { bestScore = score; best = cand; }
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
			// Gun. Sits last so pickWeaponFor prefers missiles when both
			// are in envelope, but falls through cleanly once missile
			// magazines are dry (or zeroed out by a guns-only scenario).
			// fireRate is the per-burst cooldown — 0.08 s lets the NPC
			// squeeze off a steady stream while tracking, same cadence
			// as the player's M61A1 tick (0.05 s). Envelope capped at
			// 3.5 km: the player's sniper bullets reach 7 km but NPCs
			// spraying from that far is just wasted ammo against a
			// maneuvering target, and reads as "bad AI".
			{ type: 'gun',     ammo: Infinity, maxAmmo: Infinity, fireRate: 0.08, maxInFlight: 0,
			  lastFire: -Infinity, minRange: 0,     maxRange: 3500  },
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
