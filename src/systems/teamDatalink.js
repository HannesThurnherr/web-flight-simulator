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

// Default memory window for satellite-ISR snapshots when a publisher
// doesn't override it. Each entry can carry its own `memoryS` so a
// scenario author can tune how long imagery stays "fresh" — we just
// need a fallback for callers that don't specify.
const SATELLITE_MEMORY_DEFAULT = 600.0;

// How long (seconds) an engagement registration stays on the books past
// the missile's apparent lifetime, in case the missile object's cleanup
// is delayed a frame. Belt-and-braces — normal flow is explicit clear.
const ENGAGEMENT_LINGER = 1.0;

// After a claimed strike's predicted impact time passes, keep the claim on
// the books this much longer — a battle-damage-assessment window. If the
// target is still alive (still in the contact picture) once the claim
// expires, it becomes eligible for re-attack.
const STRIKE_ASSESS_S = 12.0;

// How long a striker's "I'm prosecuting this target" assignment lasts without
// a refresh. Refreshed every frame while committed, so a striker that dies or
// breaks off drops out of the tally within this window and team-mates rebalance.
const STRIKE_ASSIGN_TTL_S = 4.0;

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
		// Ground-strike coordination ledger. When a team-mate releases an
		// A/G weapon at a target it claims the strike with a predicted
		// time-of-flight; other strikers consult strikeWeight() and pick a
		// DIFFERENT target while a weapon is still inbound. Claims expire
		// ETA + STRIKE_ASSESS_S after release, so a survivor naturally
		// becomes eligible for re-attack after the impact is assessed.
		// target → [{ shooter, weaponType, claimedAt, expiresAt }]
		this.strikeClaims = new Map();
		// Pre-release target ASSIGNMENTS: which strikers are currently committed
		// to which target, so a package divvies the target list up instead of
		// every jet marching the same sequence. Keyed by a STABLE string (tag
		// or rounded coord) because the strike pilots work from coordinate
		// objects that are re-created every frame. key → Map<unit, lastSeen>.
		this.strikeAssignments = new Map();
	}

	// Register / refresh "this unit is going after the target at `key`".
	assignStrike(key, unit, now) {
		if (!key || !unit) return;
		let m = this.strikeAssignments.get(key);
		if (!m) { m = new Map(); this.strikeAssignments.set(key, m); }
		m.set(unit, now);
	}

	// How many OTHER live strikers are committed to `key` right now.
	strikeAssignCount(key, now, excludeUnit = null) {
		const m = this.strikeAssignments.get(key);
		if (!m) return 0;
		let n = 0;
		for (const [u, ts] of m) {
			if (u === excludeUnit) continue;
			if (now - ts > STRIKE_ASSIGN_TTL_S) continue;
			if (!u || u.destroyed || u.active === false) continue;
			n++;
		}
		return n;
	}

	// ---- Ground-strike coordination ------------------------------------------

	// Register an inbound A/G weapon. `etaS` is the shooter's estimated
	// time-of-flight; the claim self-expires after impact + assessment.
	// Pass the live `missile` ref when available: a claim whose weapon
	// DIES early (shot down by point defense, terrain) is released
	// immediately, so the target goes straight back on the menu instead
	// of being "covered" by a dead bomb for minutes.
	claimStrike(target, shooter, weaponType, etaS, now, missile = null) {
		if (!target) return;
		let arr = this.strikeClaims.get(target);
		if (!arr) { arr = []; this.strikeClaims.set(target, arr); }
		const impactAt = now + Math.max(5, etaS || 0);
		arr.push({
			shooter, weaponType, missile,
			claimedAt: now,
			impactAt,
			expiresAt: impactAt + STRIKE_ASSESS_S,
		});
	}

	// How many weapons are currently inbound (or pending assessment) on this
	// target. Strikers treat weight >= 1 as "covered — go service something
	// else" so a strike package fans out across the target set instead of
	// dog-piling the nearest SAM.
	strikeWeight(target, now) {
		const arr = this.strikeClaims.get(target);
		if (!arr) return 0;
		let n = 0;
		for (const c of arr) {
			if (now >= c.expiresAt) continue;
			if (c.shooter && (c.shooter.destroyed || c.shooter.active === false)) continue;
			// Weapon died well before its ETA (intercepted / hit terrain) —
			// the target is NOT covered anymore. Death near/after the ETA is
			// the impact itself; the assess window still applies then.
			if (c.missile && !c.missile.active && now < (c.impactAt ?? 0) - 3) continue;
			n++;
		}
		return n;
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
		// Position jitter for briefed-suspected. The whole point of
		// `level: 'suspected'` is "we think it's here within
		// uncertaintyM but it could be anywhere in this circle."
		// Previously we stored the unit's exact position and only
		// drew a fuzzy disc around it — players who fired at the
		// suspected dot got perfect coords, defeating the abstraction.
		// Frozen-once, Gaussian-ish offset rolled at publish time
		// (one-shot at scenario start) so the marker stays stable
		// across the briefing — same suspected dot at the same place
		// every frame, just not on the unit's true coords. Real
		// units' actual locations are still ground-truth in the
		// world; only the *intel record* carries the bias.
		let lon = target.lon;
		let lat = target.lat;
		if (level === 'suspected') {
			const uncertM = intel.uncertaintyM || 3000;
			// 3-sample uniform → ~Gaussian, scaled to roughly fit
			// inside uncertaintyM (the disc the planner draws).
			// stddev ≈ uncertM / 2.5 means ~95% of fixes land
			// inside the rendered uncertainty disc, ~5% outside —
			// matches a "1.96σ" reading of the disc as a 95%
			// confidence circle.
			const sd = uncertM / 2.5;
			const dE = ((Math.random() + Math.random() + Math.random()) / 3 - 0.5) * 2 * sd;
			const dN = ((Math.random() + Math.random() + Math.random()) / 3 - 0.5) * 2 * sd;
			const cosLat = Math.cos((target.lat || 0) * Math.PI / 180) || 1;
			lon = target.lon + dE / (111320 * cosLat);
			lat = target.lat + dN / 111320;
		}
		this.intelContacts.set(target, {
			kind: level === 'suspected' ? 'briefed-suspected' : 'briefed-known',
			lon,
			lat,
			alt: target.alt,
			uncertaintyM: (level === 'suspected') ? (intel.uncertaintyM || 3000) : 0,
			sourceUnit: null,
			iffStatus: "hostile",
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
			iffStatus: "hostile",
			firstSeen: existing ? existing.firstSeen : now,
			lastSeen:  now,
		});
	}

	// Satellite-ISR snapshot publish. Called periodically by the
	// scenario runner to drop a theater-wide ground-truth picture into
	// the friendly datalink, modeling NRO / commercial-grade space-based
	// imagery passes. Each call captures the unit's CURRENT exact
	// position (not bearing-only like ELINT, not pre-mission like
	// briefed); the entry then ages out after `memoryS` seconds, at
	// which point the player has to wait for the next pass — or rely
	// on other discovery channels — to see the unit again.
	//
	// Briefed entries OVERWRITE — fresher beats older. Live sensor
	// contacts in this.contacts still take priority over intelContacts
	// at planner-render time, so a sensor confirmation auto-promotes
	// the satellite contact to a live track without needing extra code.
	publishSatellite(target, now, memoryS = SATELLITE_MEMORY_DEFAULT) {
		if (!target || target.destroyed) return;
		if (target.team === this.team) return;
		const existing = this.intelContacts.get(target);
		// Don't overwrite ELINT (live emitter, strictly more current)
		// or briefed entries (they're the player's persistent
		// knowledge baseline — if a satellite-overwrite ages out of
		// memory, the briefed marker would vanish too, leaving the
		// planner pretending we never knew about the unit). Skipping
		// the publish here means the satellite ping is redundant for
		// already-known units; for never-seen units it adds a fresh
		// timed entry, which is the actual point of satellite ISR.
		if (existing && (existing.kind === 'elint' ||
		                 existing.kind === 'briefed-known' ||
		                 existing.kind === 'briefed-suspected')) {
			return;
		}
		this.intelContacts.set(target, {
			kind: 'satellite',
			lon: target.lon,
			lat: target.lat,
			alt: target.alt,
			uncertaintyM: 0,
			sourceUnit: null,
			iffStatus: "hostile",
			memoryS,
			firstSeen: existing ? existing.firstSeen : now,
			lastSeen:  now,
		});
	}

	// ---- Contact fusion ----------------------------------------------------

	// Called each frame from a sensor-equipped team-mate. `unit` must have
	// `contacts` populated by the sensor system. 6g — we now fuse all
	// three channels (radar, IR, visual): a teammate with eyes-on a
	// bandit pushes a visual entry; a wingman with IRST gets the same
	// bandit on IR; AWACS lights it up on radar. Each channel carries
	// its own per-channel lastSeen so the source tag can age out
	// independently (radar drops first, IR is stickier, visual is
	// stickiest — same memory windows the sensorSystem uses).
	//
	// Contributors (`sources`) accumulate across teammates so the
	// planner can show "3 reports" or list contributors on hover.
	// Position still comes from `target.lon/lat/alt` (sim ground truth);
	// future tightening would derive a real fix from radar range +
	// triangulated IR/visual bearings, but that's beyond 6g scope.
	publishContacts(unit, now) {
		if (!unit || !unit.contacts) return;
		for (const [target, c] of unit.contacts) {
			if (!c) continue;
			if (!target || target.destroyed || target.active === false) continue;
			// 6d — datalink no longer auto-filters out same-team
			// contacts via target.team. We still skip resolved-friendly
			// contacts (broadcasting "your wingman is at lat/lon" is
			// noise) but unknown / hostile contacts go through.
			if (c.iffStatus === 'friendly') continue;

			const hasR = !!c.radar;
			const hasI = !!c.ir;
			const hasV = !!c.visual;
			if (!hasR && !hasI && !hasV) continue;

			// Best position + velocity available. Radar is preferred
			// (range + Doppler velocity); IR/visual fall back to
			// ground truth for now (see comment above). Velocity:
			// only radar gives a real measurement; without it we
			// publish zeros so consumers know it's not a firing-grade
			// track.
			const vel = (hasR && c.radar.velocity) || { x: 0, y: 0, z: 0 };
			const range = hasR ? c.radar.range : null;

			// Per-channel quality contribution: radar's signal is the
			// most informative; visual is a strong confirmer; IR is
			// the cheapest hint.
			const qR = hasR ? Math.max(0.2, Math.min(1, c.radar.signal || 0.5)) : 0;
			const qV = hasV ? 0.7 : 0;
			const qI = hasI ? 0.5 : 0;
			const quality = Math.max(0.2, Math.min(1, Math.max(qR, qV, qI)));

			const existing = this.contacts.get(target);
			const channels = (existing && existing.channels) || { radar: null, ir: null, visual: null };
			if (hasR) channels.radar  = now;
			if (hasI) channels.ir     = now;
			if (hasV) channels.visual = now;

			const sources = (existing && existing.sources) || new Set();
			sources.add(unit);

			this.contacts.set(target, {
				lastSeen: now,
				source:   unit,            // most-recent publisher (legacy field)
				sources,                   // 6g — full contributor set
				channels,                  // 6g — per-channel lastSeen for source tagging
				lon:      target.lon,
				lat:      target.lat,
				alt:      target.alt,
				vE:       vel.x,
				vN:       vel.y,
				vU:       vel.z,
				range,
				quality,
				// Phase 6d — propagate the publishing source's IFF
				// classification. Consumers (HUD, scope, planner) read
				// this rather than re-deriving from .team. If a
				// teammate later resolves the unknown via visual ID,
				// the next publishContacts pass overwrites with the
				// resolved status.
				iffStatus: c.iffStatus || 'unknown',
			});
		}
	}

	// 6g — single-letter source tag for a fused entry. Returns the
	// string the planner / HUD draws next to a track. Aged channels
	// drop off, so `R` becomes `IR+EO` 4 seconds after the radar
	// contact lapses but the IRST still sees the bandit. Returns
	// empty string if all channels expired (caller should treat as
	// no-contact).
	static sourceTag(entry, now,
		radarMemoryS  = 2.0,
		irMemoryS     = 2.0,
		visualMemoryS = 5.0,
	) {
		if (!entry || !entry.channels) return '';
		const ch  = entry.channels;
		const tags = [];
		if (ch.radar  != null && now - ch.radar  <= radarMemoryS)  tags.push('R');
		if (ch.ir     != null && now - ch.ir     <= irMemoryS)     tags.push('IR');
		if (ch.visual != null && now - ch.visual <= visualMemoryS) tags.push('EO');
		return tags.join('+');
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
			// Satellite snapshots age per-entry: each carries its own
			// memoryS so the scenario author can tune how stale a
			// snapshot is allowed to get. Default 600 s, but a tightly
			// contested scenario might use 120 s to force the player
			// to act on imagery before the next pass.
			if (entry.kind === 'satellite' &&
				(now - entry.lastSeen) > (entry.memoryS || SATELLITE_MEMORY_DEFAULT)) {
				this.intelContacts.delete(target);
			}
		}
		// Engagement ledger: linger a second past missile death so we
		// don't flicker in/out across a frame boundary. Explicit
		// clearByMissile() is still the primary cleanup path.
		for (const [target, rec] of this.engagements) {
			const dropRec = () => {
				this.engagements.delete(target);
				for (const s of rec.shots) this._missileIndex.delete(s.missile);
			};
			if (!target || target.destroyed) { dropRec(); continue; }
			// Retire spent rounds individually, then linger a second on the
			// now-empty record so the ledger doesn't flicker in/out across a
			// frame boundary. Explicit clearByMissile() is still the primary
			// cleanup path.
			rec.shots = rec.shots.filter(s => s.missile && s.missile.active);
			if (rec.shots.length === 0) {
				if (!rec._deathStamp) rec._deathStamp = now;
				else if (now - rec._deathStamp > ENGAGEMENT_LINGER) dropRec();
			} else {
				rec._deathStamp = 0;
			}
		}
		// Strike claims: drop dead targets wholesale, prune expired entries.
		for (const [target, arr] of this.strikeClaims) {
			if (!target || target.destroyed || target.active === false) {
				this.strikeClaims.delete(target);
				continue;
			}
			const live = arr.filter(c => now < c.expiresAt &&
				!(c.missile && !c.missile.active && now < (c.impactAt ?? 0) - 3));
			if (live.length !== arr.length) {
				if (live.length) this.strikeClaims.set(target, live);
				else this.strikeClaims.delete(target);
			}
		}
		// Strike assignments: drop stale / dead committers; empty keys go too.
		for (const [key, m] of this.strikeAssignments) {
			for (const [u, ts] of m) {
				if (now - ts > STRIKE_ASSIGN_TTL_S || !u || u.destroyed || u.active === false) m.delete(u);
			}
			if (m.size === 0) this.strikeAssignments.delete(key);
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

	// One record per target, holding EVERY live shot against it — not just the
	// most recent. The ledger used to keep a single missile per target, so a
	// four-round anti-ship salvo was tracked as whichever round happened to be
	// fired last: kill that one while the other three were still inbound and
	// the target read as unengaged, so the shooter immediately committed a
	// fresh salvo it did not need and burned its magazine twice as fast.
	registerEngagement(launcher, missile, target, now) {
		if (!target || !missile) return;
		let rec = this.engagements.get(target);
		if (!rec) {
			rec = { target, shots: [] };
			this.engagements.set(target, rec);
		}
		rec.shots.push({ missile, shooter: launcher, firedAt: now });
		rec._deathStamp = 0;                 // fresh shot revives a lingering record
		this._missileIndex.set(missile, target);
	}

	// Shots still worth counting. A missile that missed (lostLock after flyby)
	// or went maddog no longer counts — the target is effectively unengaged and
	// teammates should re-commit rather than watch a dead shot coast for
	// minutes.
	_liveShots(rec) {
		if (!rec || !rec.shots) return [];
		return rec.shots.filter(s => s.missile && s.missile.active &&
			!s.missile.lostLock && !s.missile.maddog);
	}

	// True if a team-mate already has a missile tracking this target.
	isEngaged(target) {
		return this._liveShots(this.engagements.get(target)).length > 0;
	}

	// Is there still a shot in the air that might yet KILL this target?
	//
	// `isEngaged` only asks "is an interceptor alive", which is the wrong
	// question for shoot-look-shoot. A SAM that has already flown past its
	// target is alive for many more seconds while it coasts out — during which
	// the shooter believes the target is covered — and conversely the instant
	// it dies the target reads as free, so the next salvo goes before anyone
	// knows whether the first one worked.
	//
	// The right signal is whether the interceptor is still CLOSING. Once the
	// range from missile to target starts opening, the shot is spent: it
	// either killed the target (in which case the target is gone anyway) or it
	// missed, and the shooter should re-engage immediately rather than wait
	// out the coast. That gives a genuine look between shots instead of the
	// SM-6 spam of firing on a timer.
	// Is this individual shot still closing on its target? Stateful by design:
	// it remembers last frame's range so "closing" means what it says.
	_shotClosing(shot, target) {
		const m = shot.missile;
		if (!m || typeof m.lon !== 'number' || typeof target.lon !== 'number') return true;
		const cosLat = Math.cos((m.lat || 0) * Math.PI / 180);
		const dE = (target.lon - m.lon) * 111320 * cosLat;
		const dN = (target.lat - m.lat) * 111320;
		const dU = (target.alt || 0) - (m.alt || 0);
		const d2 = dE * dE + dN * dN + dU * dU;
		const prev = shot._prevD2;
		shot._prevD2 = d2;
		// First frame there's nothing to compare against — call a fresh shot
		// unresolved, the safe direction (don't double up on a round that just
		// left the rail).
		return prev === undefined || d2 <= prev;
	}

	hasUnresolvedShot(target) {
		if (!target || typeof target.lon !== 'number') return false;
		for (const shot of this._liveShots(this.engagements.get(target))) {
			if (this._shotClosing(shot, target)) return true;
		}
		return false;
	}

	// How many live rounds the team currently has running at this target.
	// Lets a shooter size a follow-up salvo against what's already inbound
	// instead of treating "engaged / not engaged" as the only distinction.
	liveShotCount(target) {
		return this._liveShots(this.engagements.get(target)).length;
	}

	// Cooperative air-defence deconfliction. True if a DIFFERENT team-mate
	// already has a live interceptor tracking `target` — and, when a radius is
	// given, only if that shooter is within `maxCoordRangeM` of `me` (a task
	// group / CEC bubble; ships on the far side of the map don't coordinate).
	// A sister ship calls this to leave an already-covered threat alone and
	// pick a fresh one, so a salvo of inbounds gets spread across the group
	// instead of three ships all dumping on the same leaker.
	engagedByOther(target, me, maxCoordRangeM = Infinity) {
		for (const shot of this._liveShots(this.engagements.get(target))) {
			const shooter = shot.shooter;
			if (!shooter || shooter === me) continue;                  // our own shot doesn't count
			// Only a shot that might still WORK reserves the target. A sister
			// ship's round that has already sailed past shouldn't keep the rest
			// of the group standing down on a leaker.
			if (!this._shotClosing(shot, target)) continue;
			if (maxCoordRangeM !== Infinity && me && typeof me.lon === 'number' &&
				typeof shooter.lon === 'number') {
				const cosLat = Math.cos((me.lat || 0) * Math.PI / 180);
				const dE = (shooter.lon - me.lon) * 111320 * cosLat;
				const dN = (shooter.lat - me.lat) * 111320;
				if (Math.hypot(dE, dN) > maxCoordRangeM) continue;     // too far to coordinate
			}
			return true;
		}
		return false;
	}

	// Optional fast-path cleanup — call when a missile's lifecycle ends.
	// Not strictly required (tick() catches it eventually) but nice to
	// have so deconfliction opens up within a frame of the miss/kill.
	clearByMissile(missile) {
		const target = this._missileIndex.get(missile);
		if (!target) return;
		this._missileIndex.delete(missile);
		const rec = this.engagements.get(target);
		if (!rec) return;
		// Retire ONLY this round. Dropping the whole record here was the other
		// half of the lossy-salvo problem: one interceptor killing one missile
		// of a four-round salvo marked the target unengaged while three were
		// still inbound. tick() removes the record once it's genuinely empty.
		rec.shots = rec.shots.filter(s => s.missile !== missile);
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
