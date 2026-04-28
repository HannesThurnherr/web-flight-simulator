// ============================================================================
// Team datalink — shared sensor fusion + engagement deconfliction.
//
// Each team has one TeamDatalink instance. Every frame, radar-equipped
// team-mates (fighters, AWACS, future ground radars) "publish" their own
// contacts into it via publishContacts(unit). Other team-mates read the
// fused picture via getFusedContacts(unit) to see targets their own
// radar hasn't painted but a wingman or AWACS has.
//
// Separately, when a team-mate fires a weapon it registers the engagement
// via registerEngagement(launcher, missile, target); teammates consult
// isEngaged(target) to avoid doubling up on a bogey that already has a
// missile inbound. The ledger is cleared automatically when the missile
// ends (hit, miss, time-out).
//
// Everything in this module is *data-only* — no sensor mechanics live
// here. Detection geometry is still owned by sensorSystem.detectRadar().
// The datalink is a post-detection fusion + coordination layer.
// ============================================================================

// How long (seconds) a datalink contact persists after the last publishing
// source dropped it. Allows a brief loss (notch / terrain blink) without
// the whole team losing the track.
const DATALINK_MEMORY = 4.0;

// How long (seconds) an ELINT entry survives without a refreshing
// emit. Real ELINT loses contact almost immediately when the emitter
// goes EMCON; we keep a brief memory so the planner doesn't flicker
// when an emitter cycles between scan/track modes.
const ELINT_MEMORY = 8.0;

// How long (seconds) an engagement registration stays on the books past
// the missile's apparent lifetime, in case the missile object's cleanup
// is delayed a frame. Belt-and-braces — normal flow is explicit clear.
const ENGAGEMENT_LINGER = 1.0;

export class TeamDatalink {
	constructor(team) {
		this.team = team;
		// target (game object) → { lastSeen, source, lon, lat, alt, vE, vN, vU, range, quality }
		//   lastSeen: sim-time of most recent publish
		//   source:   the unit whose radar produced this track (for UX / debug)
		//   quality:  fusion confidence, 0..1 (radar=1.0, IR-only=0.5, etc.)
		this.contacts = new Map();
		// Pre-mission intel + ELINT-derived contacts. Distinct from
		// the live `contacts` map so the planner can render them
		// differently and so they persist after a sensor track drops
		// (briefed targets stay briefed forever — they're a database
		// entry, not a sensor hit).
		//
		// target → {
		//   kind: 'briefed-known' | 'briefed-suspected' | 'elint-bearing',
		//   lon, lat, alt,
		//   uncertaintyM,        // position uncertainty radius (briefed-suspected)
		//   bearingDeg,          // bearing from sourceUnit (elint-bearing)
		//   bearingErrorDeg,     // ±half-angle of bearing wedge
		//   sourceUnit,          // who reported (null for briefed)
		//   firstSeen, lastSeen, // sim-time
		// }
		// Resolution priority when planner draws: live `contacts`
		// (current sensor) > intelContacts (briefed/elint).
		this.intelContacts = new Map();
		// target → { shooter, missile, firedAt }. One entry per target per
		// time — if a second missile is fired at a target we OVERWRITE with
		// the newer shot, so the most recent engagement is authoritative.
		// This biases deconfliction toward "pick a fresh target" rather
		// than "pile on the same one."
		this.engagements = new Map();
		// Reverse index: missile → target, so clearByMissile() is O(1).
		this._missileIndex = new Map();
	}

	// Pre-mission intel publish. Called once at scenario start by the
	// scenario runner for any spawned platform whose intel.level is
	// 'known' or 'suspected'. Stays in intelContacts forever (or
	// until the unit dies / scenario resets).
	publishBriefed(target, intel, now) {
		if (!target || target.destroyed) return;
		if (target.team === this.team) return;
		const level = intel && intel.level;
		if (level !== 'known' && level !== 'suspected') return;
		this.intelContacts.set(target, {
			kind: level === 'suspected' ? 'briefed-suspected' : 'briefed-known',
			lon: target.lon,
			lat: target.lat,
			alt: target.alt,
			uncertaintyM: (level === 'suspected') ? (intel.uncertaintyM || 3000) : 0,
			sourceUnit: null,
			firstSeen: now,
			lastSeen:  now,
		});
	}

	// ELINT publish — passive emitter detection. Theater-wide: any
	// currently-radiating hostile unit gets published to the friendly
	// team datalink with the emitter's position. Republished each
	// tick for as long as it radiates; entries time out after
	// ELINT_MEMORY_S so a SAM going emcon disappears from the planner
	// shortly after (cleanup in tick()). NOTE: a briefed entry on the
	// same target is OVERWRITTEN by ELINT — sensor-derived intel is
	// fresher than the database. The planner's resolution treats
	// kinds 'briefed-known' / 'briefed-suspected' / 'elint' the same
	// way (intel-only path) but renders different labels.
	publishElint(target, now) {
		if (!target || target.destroyed) return;
		if (target.team === this.team) return;
		const existing = this.intelContacts.get(target);
		// Don't downgrade a briefed-known to ELINT — briefed is the
		// "we know exact coords from imagery" state, ELINT is just
		// "we hear an emitter in this area." Suspected gets upgraded
		// because ELINT confirms the rough position.
		if (existing && existing.kind === 'briefed-known') {
			existing.lastSeen = now;
			return;
		}
		this.intelContacts.set(target, {
			kind: 'elint',
			lon: target.lon,
			lat: target.lat,
			alt: target.alt,
			uncertaintyM: 0,
			sourceUnit: null,
			firstSeen: existing ? existing.firstSeen : now,
			lastSeen:  now,
		});
	}

	// ---- Contact fusion ----------------------------------------------------

	// Called each frame from a radar-equipped team-mate. `unit` must have
	// `contacts` populated by the sensor system. We ONLY fuse radar
	// contacts here — IR-only/visual contacts don't produce a range and
	// aren't useful for firing solutions. Expand later if needed.
	publishContacts(unit, now) {
		if (!unit || !unit.contacts) return;
		for (const [target, c] of unit.contacts) {
			if (!c || !c.radar) continue;
			if (!target || target.destroyed || target.active === false) continue;
			if (target.team === this.team) continue; // don't broadcast friendlies

			// Keep the freshest-published copy. If two team-mates publish
			// the same target the same frame, the second overwrites the
			// first — doesn't matter which "wins," they're within a few
			// metres of each other.
			const vel = c.radar.velocity || { x: 0, y: 0, z: 0 };
			this.contacts.set(target, {
				lastSeen: now,
				source:   unit,
				lon:      target.lon,
				lat:      target.lat,
				alt:      target.alt,
				vE:       vel.x,
				vN:       vel.y,
				vU:       vel.z,
				range:    c.radar.range,
				quality:  Math.max(0.2, Math.min(1, c.radar.signal || 0.5)),
			});
		}
	}

	// Age out stale contacts. Called once per tick from the owner.
	tick(now) {
		for (const [target, entry] of this.contacts) {
			if (!target || target.destroyed || target.active === false) {
				this.contacts.delete(target);
				continue;
			}
			if (now - entry.lastSeen > DATALINK_MEMORY) {
				this.contacts.delete(target);
			}
		}
		// Intel contacts: briefed entries persist forever (they're
		// database entries from the briefing room). ELINT entries
		// expire after ELINT_MEMORY_S without a refresh — modeling
		// the loss of an emitter going EMCON. Both kinds drop when
		// the unit dies.
		for (const [target, entry] of this.intelContacts) {
			if (!target || target.destroyed || target.active === false) {
				this.intelContacts.delete(target);
				continue;
			}
			if (entry.kind === 'elint' && (now - entry.lastSeen) > ELINT_MEMORY) {
				this.intelContacts.delete(target);
			}
		}
		// Engagement ledger: linger a second past missile death so we
		// don't flicker in/out across a frame boundary. Explicit
		// clearByMissile() is still the primary cleanup path.
		for (const [target, rec] of this.engagements) {
			if (!rec.missile || !rec.missile.active) {
				if (!rec._deathStamp) rec._deathStamp = now;
				else if (now - rec._deathStamp > ENGAGEMENT_LINGER) {
					this.engagements.delete(target);
					if (rec.missile) this._missileIndex.delete(rec.missile);
				}
			}
			if (!target || target.destroyed) {
				this.engagements.delete(target);
				if (rec.missile) this._missileIndex.delete(rec.missile);
			}
		}
	}

	// Lookup API. Returns a fused contact entry if we have one, or null.
	// The unit-owned contacts map is still the primary picture; this is
	// the "else if" fallback when the unit's own radar doesn't see it.
	getFusedContact(target) {
		return this.contacts.get(target) || null;
	}

	// Iterate everything the team currently knows about. Used by the AI
	// to consider targets its own radar hasn't painted.
	allContacts() {
		return this.contacts;
	}

	// ---- Engagement deconfliction ------------------------------------------

	registerEngagement(launcher, missile, target, now) {
		if (!target || !missile) return;
		this.engagements.set(target, { shooter: launcher, missile, target, firedAt: now });
		this._missileIndex.set(missile, target);
	}

	// True if a team-mate already has a missile tracking this target.
	isEngaged(target) {
		const rec = this.engagements.get(target);
		if (!rec) return false;
		if (!rec.missile || !rec.missile.active) return false;
		return true;
	}

	// Optional fast-path cleanup — call when a missile's lifecycle ends.
	// Not strictly required (tick() catches it eventually) but nice to
	// have so deconfliction opens up within a frame of the miss/kill.
	clearByMissile(missile) {
		const target = this._missileIndex.get(missile);
		if (!target) return;
		this.engagements.delete(target);
		this._missileIndex.delete(missile);
	}
}

// ---- Registry: one datalink per team ---------------------------------------
//
// Lazily-created map from team id → TeamDatalink. Units call
// getTeamDatalink('friendly') to publish/read. Using a module-level
// singleton is appropriate here: teams are identified by a string tag
// that's stable across the whole session and there's no reason to have
// more than one instance per team.

const _datalinks = new Map();

export function getTeamDatalink(team) {
	if (!team) return null;
	let dl = _datalinks.get(team);
	if (!dl) {
		dl = new TeamDatalink(team);
		_datalinks.set(team, dl);
	}
	return dl;
}

// Convenience for main.js: tick every team each frame.
export function tickAllDatalinks(now) {
	for (const [, dl] of _datalinks) dl.tick(now);
}

// Iterate every team's datalink. Used by the commander-view debug
// overlay to draw who's sharing tracks with whom. Returns
// [teamId, TeamDatalink] pairs.
export function allDatalinks() {
	return _datalinks;
}

// Called on scenario reset so stale entries don't leak between runs.
export function resetAllDatalinks() {
	for (const [, dl] of _datalinks) {
		dl.contacts.clear();
		dl.intelContacts.clear();
		dl.engagements.clear();
		dl._missileIndex.clear();
	}
}
