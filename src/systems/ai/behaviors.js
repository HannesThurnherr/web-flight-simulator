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

import { forwardLookTerrain, isRadiating } from '../sensorSystem.js';
import { AIR_TARGET_CLASSES } from './subsystems.js';

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
// WaypointFollowBehavior — Phase 10d (NPC missions, "patrol" pilot).
//
// Drives the NPC along an ordered list of waypoints when no higher-
// priority behavior (engage / evade / terrain) wants control. Sits
// just above CruiseBehavior so an aimless fighter follows its route
// instead of drifting in random circles, but yields to engage the
// instant a hostile is spotted.
//
// Each waypoint: { lon, lat, altM, speedMps?, captureRadiusM? }.
// Default capture radius 1500 m (the NPC turns to the next leg once
// it's that close). `loop: true` cycles back to the first waypoint
// after the last; otherwise the NPC orbits the final waypoint as a
// station. `engageOnSight: true` (the default) keeps EngageBehavior
// active over this one — see priority order in createPatrolPilot.
// Setting it false would mean "fly the route regardless of contacts"
// (useful for non-combatant patrols once we model that), but
// implementing the toggle isn't in 10d's scope.
export class WaypointFollowBehavior extends Behavior {
	constructor(opts = {}) {
		super('WaypointFollow');
		this.waypoints = Array.isArray(opts.waypoints) ? opts.waypoints : [];
		this.loop = opts.loop !== false;
		this.captureRadiusM = opts.captureRadiusM ?? 1500;
		this._idx = 0;
	}
	isActive() { return this.waypoints.length > 0; }
	apply(ctx, cmd) {
		const u = ctx.unit;
		const wp = this.waypoints[this._idx];
		if (!wp) return;

		// Capture-and-advance. Use a flat-Earth metre distance — at
		// the leg-length scales we care about (km), the great-circle
		// correction is in the noise, and we need the cheap version
		// running every frame on every patrolling NPC.
		const plat = u.lat * Math.PI / 180;
		const dE = (wp.lon - u.lon) * 111320 * Math.cos(plat);
		const dN = (wp.lat - u.lat) * 111320;
		const dist = Math.hypot(dE, dN);
		if (dist < this.captureRadiusM) {
			if (this._idx + 1 < this.waypoints.length) {
				this._idx++;
			} else if (this.loop) {
				this._idx = 0;
			}
			// If not looping and we're past the last waypoint, the
			// NPC just keeps orbiting the final point — same heading
			// math below (dist→0, heading degenerates) drifts into a
			// station-keeping circle. Acceptable for a patrol.
		}

		const target = this.waypoints[this._idx];
		const tdE = (target.lon - u.lon) * 111320 * Math.cos(plat);
		const tdN = (target.lat - u.lat) * 111320;
		cmd.targetHeading = (Math.atan2(tdE, tdN) * 180 / Math.PI + 360) % 360;

		// Gentle climb/descent toward the leg's nominal altitude.
		// Cap pitch at ±8° so the NPC doesn't yo-yo on long climbs.
		const altErr = (target.altM ?? u.alt) - u.alt;
		cmd.targetPitch = Math.max(-8, Math.min(8, altErr / 400));
		cmd.targetSpeed = target.speedMps ?? 280;
		cmd.throttle    = 0.7;
		cmd.boost       = false;
	}
}

// ----------------------------------------------------------------------------
// StrikeBehavior — Phase 10d (NPC missions, "strike" pilot).
//
// Mission profile: ingress → (release at each target) → egress. The
// striker prosecutes an ORDERED LIST of targets — one weapon per target,
// flying the ingress route once, then running each target down in turn:
//   ingress  Follow ingressWaypoints toward the FIRST target. The last
//            waypoint is implicitly "the target itself" if no explicit
//            waypoints remain. Follow-on targets are flown direct (the
//            ingress route is only flown once).
//   release  Within terminalRangeM of the current target, fire one
//            weaponType shot at its coords, then advance to the next
//            target. A target that's already dead (resolved to null by
//            the runtime) is skipped.
//   egress   Once every target is serviced (or the weapon cap is hit),
//            follow egressWaypoints back to base; then the home-anchor /
//            Cruise behavior below takes over the station-keep tail.
//
// Targets come from `getTargets()` (an array of {lon,lat,alt}, with null
// entries for dead/unresolved targets so indices stay stable). A single
// `getTarget` closure is still accepted for back-compat.
//
// Engage still wins above this in the priority chain — if a hostile
// fighter shows up mid-ingress, the strike pilot defends, then resumes
// ingress when the threat clears. Same applies to evasion + terrain avoid.
//
// Cross-striker deconfliction: every striker announces the target it's
// committed to on the team datalink, and picks the LEAST-covered target from
// its list (with a per-target cap, higher for SAM sites so the package can
// still mass to overwhelm a defended one). A per-striker "seat" offset breaks
// the startup tie so they don't all grab target #0. The net effect is a
// package that divvies the target list up instead of marching it in lockstep,
// while still ganging up where the defences demand it.
let _strikeSeatCounter = 0;

export class StrikeBehavior extends Behavior {
	constructor(opts = {}) {
		super('Strike');
		// Stable per-striker index, used to spread the package across targets
		// when coverage is otherwise equal (e.g. at the start, before anyone
		// has committed). Just a monotonically increasing counter.
		this._seat = _strikeSeatCounter++;
		// Targets this striker has already dumped its salvo on — it won't
		// re-service them, so it flows on to the next uncovered one.
		this._servicedKeys = new Set();
		// How many strikers may gang up on one target. SAMs get mass; soft
		// targets get a single jet (one saturating salvo is plenty).
		this.massPerSam = opts.massPerSam ?? 2;
		this._currentIdx = null;          // committed target index (dynamic)
		this._recheckTargetAt = -Infinity;
		this.ingressWaypoints = Array.isArray(opts.ingressWaypoints) ? opts.ingressWaypoints : [];
		this.egressWaypoints  = Array.isArray(opts.egressWaypoints)  ? opts.egressWaypoints  : [];
		// Weapon policy. 'AUTO' (the default) lets the pilot pick the best
		// coordinate A/G weapon from its own loadout for each target's range
		// — longest standoff that's feasible and in envelope — instead of
		// being pinned to one munition type. An explicit simType still forces
		// that weapon (the seeker/cooldown gate decides if it actually fires).
		this.weaponType = opts.weaponType || 'AUTO';
		this.auto = this.weaponType === 'AUTO';
		this._releaseWeapon = null; // the simType chosen for the current release
		this.terminalRangeM = opts.terminalRangeM ?? 60000;
		this.captureRadiusM = opts.captureRadiusM ?? 1500;
		// Altitude to fly the run-in and RELEASE at. A strike jet stays high
		// and lets the weapon do the descending — flying the jet down toward
		// the target's own (ground) altitude is what made glide bombs release
		// low and skip flat into the hills short of the target.
		this.releaseAltM = opts.releaseAltM ?? 9000;
		// Multi-target: prefer a getTargets() list; fall back to wrapping a
		// single getTarget() closure so legacy callers keep working.
		if (typeof opts.getTargets === 'function') {
			this._getTargets = opts.getTargets;
		} else if (typeof opts.getTarget === 'function') {
			this._getTargets = () => { const t = opts.getTarget(); return t ? [t] : []; };
		} else {
			this._getTargets = () => [];
		}
		// Total weapon cap across the whole strike. Default Infinity → bounded
		// only by ammo / target count.
		this.maxWeapons = opts.weaponCount ?? Infinity;
		// How many weapons to dump on EACH target before moving on. A single
		// PGM against a defended site just gets shot down — saturating with a
		// salvo is what gets one through. The WeaponSubsystem's per-weapon
		// fireRate + maxInFlight pace the actual launches (so cheap, high-
		// in-flight weapons like SDB salvo fast; a lone cruise just fires
		// once), and ammo caps the rest. Set lower for surgical single drops.
		this.salvoPerTarget = opts.salvoPerTarget ?? 6;
		this._fired = 0;
		this._salvoFired = 0;    // launches at the CURRENT target this pass
		this._phase = 'ingress';
		this._idx = 0;           // waypoint index within the current route
		this._releaseTimer = 0;
	}
	isActive() { return this._phase !== 'done'; }

	// Stable deconfliction key for a resolved target (set by the runtime;
	// falls back to a rounded coord for hand-built / coordinate targets).
	_keyOf(t) {
		if (!t) return '?';
		return t.key || `c:${(t.lon ?? 0).toFixed(4)},${(t.lat ?? 0).toFixed(4)}`;
	}
	// How many strikers should gang up on this target. SAM sites soak a salvo
	// or two of incoming PGMs, so massing helps; everything else gets one jet.
	_desiredStrikers(t) {
		return (t && t.cls === 'sam_site') ? this.massPerSam : 1;
	}
	// Choose which target in the list to prosecute: the least-covered one this
	// striker hasn't already serviced, preferring under-cap targets and using
	// the seat offset to spread the package. Returns -1 when there's nothing
	// left for THIS striker (→ egress).
	_pickTargetIdx(ctx, targets) {
		const dl = ctx.teamDatalink, now = ctx.now ?? 0, self = ctx.unit;
		const cands = [];
		for (let i = 0; i < targets.length; i++) {
			const t = targets[i];
			if (!t) continue;
			if (this._servicedKeys.has(this._keyOf(t))) continue;
			const assigned = (dl && dl.strikeAssignCount)
				? dl.strikeAssignCount(this._keyOf(t), now, self) : 0;
			cands.push({ i, assigned, open: assigned < this._desiredStrikers(t) });
		}
		if (!cands.length) return -1;
		const open = cands.filter(c => c.open);
		const pool = open.length ? open : cands;
		// Among the least-assigned, spread by seat (and keep list order as the
		// final tiebreak so an author's priority ordering still shows through).
		let minA = Infinity;
		for (const c of pool) if (c.assigned < minA) minA = c.assigned;
		const front = pool.filter(c => c.assigned === minA).sort((a, b) => a.i - b.i);
		return front[this._seat % front.length].i;
	}

	// Does the loadout still hold ANY coordinate A/G weapon with ammo?
	_hasAnyCoordWeapon() {
		const ws = this.pilot.subsystems.weapons;
		return !!(ws && ws.weapons.some(w => w.ammo > 0 && A2G_COORD_SIMTYPES.has(w.type)));
	}
	// Pick the best coordinate A/G weapon for a target at `range` (metres):
	// loaded, in static envelope, and release-feasible (estimateA2GShot
	// accounts for glide reach / altitude). Readiness (cooldown / in-flight
	// cap) is deliberately NOT checked here — that's WeaponSubsystem.consume's
	// job at trigger-pull. Gating on it here would make a salvo bail to the
	// next target during each between-shot cooldown. Prefers the longest
	// standoff so the striker stays as far as it can from the target's
	// defences. HARM is excluded (strike targets are coordinates; the
	// autonomous GroundAttack / reactive-SEAD paths handle emitters). Returns
	// the simType, or null if nothing fits the geometry yet.
	_selectWeapon(ctx, targetPos, range) {
		const ws = this.pilot.subsystems.weapons;
		if (!ws) return null;
		const unit = ctx.unit;
		const agl = unit.alt - (targetPos.alt || 0);
		const cl = Math.cos((unit.lat || 0) * Math.PI / 180) || 1;
		const dE = (targetPos.lon - unit.lon) * 111320 * cl;
		const dN = (targetPos.lat - unit.lat) * 111320;
		const horiz = Math.sqrt(dE * dE + dN * dN);
		let best = null, bestScore = -Infinity;
		for (const w of ws.weapons) {
			if (w.ammo <= 0 || !A2G_COORD_SIMTYPES.has(w.type)) continue;
			if (range < w.minRange || range > w.maxRange) continue;
			const est = estimateA2GShot(w.type, agl, horiz, unit.speed);
			if (!est.feasible) continue;
			const score = (w.maxRange || 0) + est.impactAngleDeg; // longest standoff, steeper tiebreak
			if (score > bestScore) { bestScore = score; best = w.type; }
		}
		return best;
	}
	apply(ctx, cmd, dt) {
		const u = ctx.unit;
		const targets = this._getTargets() || [];
		const plat = u.lat * Math.PI / 180;
		const cosLat = Math.cos(plat) || 1;

		const distTo = (p) => {
			if (!p) return Infinity;
			const dE = (p.lon - u.lon) * 111320 * cosLat;
			const dN = (p.lat - u.lat) * 111320;
			return Math.hypot(dE, dN);
		};
		const flyTo = (p) => {
			if (!p) return;
			const dE = (p.lon - u.lon) * 111320 * cosLat;
			const dN = (p.lat - u.lat) * 111320;
			cmd.targetHeading = (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360;
			const altErr = (p.altM ?? p.alt ?? u.alt) - u.alt;
			cmd.targetPitch = Math.max(-8, Math.min(8, altErr / 400));
			cmd.targetSpeed = p.speedMps ?? 260;
			cmd.throttle    = 0.7;
			cmd.boost       = false;
		};

		// ---- Distributed target selection -----------------------------------
		// Pick the least-covered, not-yet-serviced target from the list (sticky
		// during a run-in; re-evaluated at 1 Hz in ingress and forced whenever
		// the current pick goes invalid). Don't switch mid-salvo. Then announce
		// the commitment so team-mates fan out off it.
		const now = ctx.now ?? 0;
		const dl = ctx.teamDatalink;
		const curKey = (this._currentIdx != null && this._currentIdx >= 0 && targets[this._currentIdx])
			? this._keyOf(targets[this._currentIdx]) : null;
		const curValid = curKey != null && !this._servicedKeys.has(curKey);
		if (!curValid || (this._phase === 'ingress' && now >= this._recheckTargetAt)) {
			this._recheckTargetAt = now + 1.0;
			this._currentIdx = this._pickTargetIdx(ctx, targets);
		}
		const tgt = (this._currentIdx != null && this._currentIdx >= 0) ? (targets[this._currentIdx] || null) : null;
		const haveTarget = !!tgt && this._fired < this.maxWeapons;
		if (tgt && dl && dl.assignStrike) dl.assignStrike(this._keyOf(tgt), u, now);

		// Fly toward the strike target at RELEASE ALTITUDE (not its ground
		// level), so the jet stays high and the weapon glides/dives onto it.
		const tgtAtAlt = tgt ? { lon: tgt.lon, lat: tgt.lat, altM: this.releaseAltM } : null;

		if (this._phase === 'ingress') {
			const wp = this.ingressWaypoints[this._idx] || tgtAtAlt;
			if (wp) {
				flyTo(wp);
				if (distTo(wp) < this.captureRadiusM
					&& this._idx + 1 < this.ingressWaypoints.length) {
					this._idx++;
				}
			}
			// Nothing left to hit (all targets serviced/dead, or weapons
			// exhausted) → head home.
			if (!haveTarget) {
				this._phase = 'egress';
				this._idx = 0;
				if (this.egressWaypoints.length === 0) this._phase = 'done';
				return;
			}
			// Decide weapon + whether we're positioned to release.
			const range = distTo(tgt);
			if (this.auto) {
				// No coordinate ordnance left at all → nothing to drop, go home.
				if (!this._hasAnyCoordWeapon()) {
					this._phase = 'egress';
					this._idx = 0;
					if (this.egressWaypoints.length === 0) this._phase = 'done';
					return;
				}
				// Release as soon as a feasible weapon exists at this range;
				// otherwise keep closing/climbing until one does.
				const pick = this._selectWeapon(ctx, tgt, range);
				if (pick) {
					this._releaseWeapon = pick;
					this._phase = 'release';
					this._releaseTimer = 0;
					this._salvoFired = 0;
				}
			} else if (range <= this.terminalRangeM) {
				this._releaseWeapon = this.weaponType;
				this._phase = 'release';
				this._releaseTimer = 0;
				this._salvoFired = 0;
			}
			return;
		}

		if (this._phase === 'release') {
			const ws = this.pilot.subsystems.weapons;
			const range = distTo(tgt);
			// Re-select each frame so AUTO can switch weapon as a type depletes.
			// `_selectWeapon` ignores cooldown/in-flight, so it stays non-null
			// across the between-shot cooldowns of a salvo.
			const pick = this.auto ? this._selectWeapon(ctx, tgt, range) : this.weaponType;
			const wtype = pick || this._releaseWeapon;
			if (pick) this._releaseWeapon = pick;
			const w = ws && wtype && ws.weapons.find(x => x.type === wtype);
			const feasible = this.auto ? !!pick : !!(w && w.ammo > 0);
			// Keep dumping on this target until the salvo count is met, the
			// total cap is hit, or there's no feasible ordnance left.
			const salvoDone = !tgt
				|| this._salvoFired >= this.salvoPerTarget
				|| this._fired >= this.maxWeapons
				|| !feasible;
			if (!salvoDone) {
				flyTo(tgtAtAlt); // hold release altitude; the weapon does the descending
				cmd.fireWeapon   = true;
				cmd.weaponType   = wtype;
				cmd.weaponTarget = tgt;
				// Count one launch per fireRate cycle (consume() paces the real
				// launches to the same cadence; maxInFlight/ammo cap the rest).
				const cycleS = (w ? Math.max(0.5, w.fireRate) : 0.5) + 0.2;
				this._releaseTimer += dt;
				if (this._releaseTimer >= cycleS) {
					this._releaseTimer = 0;
					this._fired++;
					this._salvoFired++;
				}
				return;
			}
			// Salvo complete (or winchester) → this target is serviced; flow on
			// to the next uncovered one. Mark it so we don't re-pick it, skip
			// the ingress route on follow-ons, and force a fresh pick.
			if (tgt) this._servicedKeys.add(this._keyOf(tgt));
			this._currentIdx = null;
			this._idx = this.ingressWaypoints.length;
			this._phase = 'ingress';
			this._salvoFired = 0;
			return;
		}

		if (this._phase === 'egress') {
			const wp = this.egressWaypoints[this._idx];
			if (!wp) { this._phase = 'done'; return; }
			flyTo(wp);
			if (distTo(wp) < this.captureRadiusM) {
				if (this._idx + 1 < this.egressWaypoints.length) {
					this._idx++;
				} else {
					this._phase = 'done';
				}
			}
		}
	}
}

// ----------------------------------------------------------------------------
// EscortBehavior — Phase 10d (NPC missions, "escort" pilot).
//
// Hold a slot ~3 km behind the protected unit. EngageBehavior sits
// above this in priority so any hostile inside the engagement range
// pulls the escort off station to intercept; once the threat is
// dealt with, the escort drifts back to its slot. We don't model a
// "hard tether" yet (escort doesn't refuse to chase a bandit far
// from the protectee) — a single engageRangeM cap on the
// TargetManager subsystem is enough for now.
//
// `getEscort` returns the protected unit each frame (looked up from
// the scenario's _taggedUnits map). When the protectee dies, this
// behavior goes inactive and Cruise takes over for the rest of the
// sortie.
export class EscortBehavior extends Behavior {
	constructor(opts = {}) {
		super('Escort');
		this._getEscort = opts.getEscort || (() => null);
		this.standoffM = opts.standoffM ?? 3000;
		this.standoffAltOffset = opts.standoffAltOffset ?? 0;
	}
	isActive() {
		const e = this._getEscort();
		return !!(e && !e.destroyed && e.active !== false);
	}
	apply(ctx, cmd) {
		const u = ctx.unit;
		const e = this._getEscort();
		if (!e) return;
		const plat = e.lat * Math.PI / 180;
		const cosLat = Math.cos(plat) || 1;
		// Slot 3 km behind the escortee along its current heading.
		const hRad = (e.heading || 0) * Math.PI / 180;
		const slotE = -Math.sin(hRad) * this.standoffM;
		const slotN = -Math.cos(hRad) * this.standoffM;
		const tgtLon = e.lon + slotE / (111320 * cosLat);
		const tgtLat = e.lat + slotN / 111320;
		const tgtAlt = e.alt + this.standoffAltOffset;

		const myCosLat = Math.cos(u.lat * Math.PI / 180) || 1;
		const dE = (tgtLon - u.lon) * 111320 * myCosLat;
		const dN = (tgtLat - u.lat) * 111320;
		const dist = Math.hypot(dE, dN);
		// Far from slot → pursuit course. Close in → match the
		// escortee's heading so we don't oscillate at the slot.
		cmd.targetHeading = dist > 400
			? (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360
			: (e.heading || 0);
		const altErr = tgtAlt - u.alt;
		cmd.targetPitch = Math.max(-5, Math.min(5, altErr / 400));
		// Match escortee speed with a small catch-up margin when off-slot.
		cmd.targetSpeed = (e.speed || 220) * (dist > 1000 ? 1.1 : 1.0);
		cmd.throttle = 0.7;
		cmd.boost = false;
	}
}

// ----------------------------------------------------------------------------
// GroundAttackBehavior — autonomous air-to-ground strike, STRICTLY below
// air-to-air engagement in the priority stack. It only takes the wheel when no
// air threat is active (Engage/MissileEvasion/etc. have all yielded) AND the
// jet actually carries deliverable A/G ordnance AND it knows of a hostile
// ground target. So a clean air-to-air fighter never touches it (no A/G ammo →
// inactive), but an ex-player clone that switched out of a strike/SEAD jet
// will prosecute ground targets with the GBUs/Storm Shadows/HARMs it kept.
//
// Target knowledge comes from the unit's own contacts + the TEAM datalink
// (live tracks + ELINT/satellite/briefed intel) — the same picture the player
// sees — filtered to ground classes. Coordinate weapons (JDAM/SDB/cruise) are
// released at the target's lat/lon; HARM is only used against a currently-
// radiating emitter (it home-on-jams). GBU-12 (laser) is excluded — an NPC has
// no one to lase for it.
// ----------------------------------------------------------------------------
const GROUND_TARGET_CLASSES = new Set(['sam_site', 'ewr', 'building', 'ground']);
const A2G_COORD_SIMTYPES = new Set(['GBU-39', 'GBU-38', 'GBU-31', 'STORM-SHADOW', 'AGM-86']);
const A2G_ARM_SIMTYPES   = new Set(['AGM-88']);

// Active-radar AAM types — shared by Engage's WEZ gate, the loft logic and
// the STT pre-fire flash.
const RADAR_AAM_TYPES = new Set(['AIM-120', 'METEOR', 'NASAMS-MSL', 'TOR-MSL', 'R-77', 'R-37M']);

// Coarse pre-release ballistics for A/G weapons: given release geometry,
// estimate whether the shot will actually arrive (an SDB tossed from low
// altitude at its paper max range just falls short), how long it will take
// (drives the datalink strike claim so wingmen don't re-attack a target
// with a weapon already inbound), and how steep it hits (JDAM plunges,
// a max-range SDB arrives shallow — matters against hardened targets).
// `aglM` = release height above the TARGET, `horizM` = horizontal range,
// `spdMps` = release true airspeed.
export function estimateA2GShot(simType, aglM, horizM, spdMps) {
	const g = 9.81;
	const agl = Math.max(0, aglM || 0);
	const spd = Math.max(120, spdMps || 250);
	if (simType === 'GBU-39') {
		// SDB lofts then glides ~8:1 from release height. Past that reach it
		// arrives out of energy. The seeker flies glide-high and commits to
		// a ≥35° terminal dive, so impact is never shallower than that.
		const reach = agl * 8 + 6000;
		const frac = Math.min(1, horizM / Math.max(1, reach));
		return {
			feasible: horizM <= reach,
			tofS: horizM / 190 + 10,
			impactAngleDeg: Math.max(35, 60 - 48 * frac),
		};
	}
	if (simType === 'GBU-38' || simType === 'GBU-31') {
		// JDAM is near-ballistic: forward carry ≈ release speed × fall time,
		// stretched a little by the PN glide. Impact is steep.
		const tFall = Math.sqrt(2 * Math.max(50, agl) / g);
		const carry = spd * tFall * 1.25;
		return {
			feasible: horizM <= carry + 2000,
			tofS: tFall + horizM / Math.max(150, spd),
			impactAngleDeg: Math.atan2(g * tFall, spd) * 180 / Math.PI,
		};
	}
	if (simType === 'STORM-SHADOW' || simType === 'AGM-86') {
		// Powered cruise: subsonic transit + terminal popup/dive maneuver.
		return { feasible: true, tofS: horizM / 230 + 35, impactAngleDeg: 50 };
	}
	if (simType === 'AGM-88') {
		return { feasible: true, tofS: horizM / 550 + 8, impactAngleDeg: 30 };
	}
	return { feasible: true, tofS: horizM / 250, impactAngleDeg: 30 };
}

export class GroundAttackBehavior extends Behavior {
	constructor(opts = {}) {
		super('GroundAttack');
		this.maxSearchRangeM = opts.maxSearchRangeM ?? 160000; // how far it'll prosecute
		this.releaseConeDeg  = opts.releaseConeDeg  ?? 30;     // nose-on tolerance to drop
		this.cruiseAltMin    = opts.cruiseAltMin    ?? 6000;
		this.cruiseAltMax    = opts.cruiseAltMax    ?? 11000;
		this._target    = null;        // sticky current ground target
		this._recheckAt = -Infinity;
	}
	_ws() { return this.pilot.subsystems.weapons; }
	_hasAnyAG() {
		const ws = this._ws();
		return !!(ws && ws.weapons.some(w => w.ammo > 0 &&
			(A2G_COORD_SIMTYPES.has(w.type) || A2G_ARM_SIMTYPES.has(w.type))));
	}
	// True when the weapon is off cooldown and under its in-flight cap —
	// mirrors WeaponSubsystem.pickWeaponFor's gates so we never "commit" to
	// a release (and claim the strike) that consume() would then reject.
	_readyToFire(w, now, projectiles, unit) {
		if (now - w.lastFire < w.fireRate) return false;
		if (w.maxInFlight && projectiles) {
			let live = 0;
			for (const p of projectiles) {
				if (!p || !p.active) continue;
				if (p.launcher !== unit || p.type !== w.type) continue;
				if (++live >= w.maxInFlight) return false;
			}
		}
		return true;
	}
	// Best A/G weapon for a target at `range`. Gates: ammo, static envelope,
	// release-geometry feasibility (estimateA2GShot — an SDB from low altitude
	// can't reach its paper max range), cooldown/in-flight. Preference:
	// HARM on a live emitter; against hardened targets (buildings) the
	// steepest-impact weapon; otherwise the longest standoff. Returns
	// { weapon, est } so the caller gets the time-of-flight for the claim.
	_weaponFor(ctx, t, range, radiating) {
		const ws = this._ws();
		if (!ws) return null;
		const unit = ctx.unit, now = ctx.now ?? 0;
		const agl = unit.alt - (t.alt || 0);
		const cl = Math.cos((unit.lat || 0) * Math.PI / 180) || 1;
		const dE = (t.lon - unit.lon) * 111320 * cl;
		const dN = (t.lat - unit.lat) * 111320;
		const horiz = Math.sqrt(dE * dE + dN * dN);
		const wantSteep = !!(t.signature && t.signature.unitClass === 'building');
		let best = null, bestScore = -Infinity;
		for (const w of ws.weapons) {
			if (w.ammo <= 0) continue;
			const isCoord = A2G_COORD_SIMTYPES.has(w.type);
			const isArm = A2G_ARM_SIMTYPES.has(w.type);
			if (!isCoord && !(isArm && radiating)) continue;
			if (range < w.minRange || range > w.maxRange) continue;
			if (!this._readyToFire(w, now, ctx.projectiles, unit)) continue;
			const est = estimateA2GShot(w.type, agl, horiz, unit.speed);
			if (!est.feasible) continue;
			if (isArm && radiating) return { weapon: w, est }; // HARM trumps on emitters
			const score = wantSteep
				? est.impactAngleDeg * 1000 + (w.maxRange || 0) / 1000
				: (w.maxRange || 0) + est.impactAngleDeg;
			if (score > bestScore) { bestScore = score; best = { weapon: w, est }; }
		}
		return best;
	}
	_rangeTo(unit, t) {
		const cl = Math.cos((unit.lat || 0) * Math.PI / 180) || 1;
		const dE = (t.lon - unit.lon) * 111320 * cl;
		const dN = (t.lat - unit.lat) * 111320;
		const dU = (t.alt || 0) - unit.alt;
		return Math.sqrt(dE * dE + dN * dN + dU * dU);
	}
	// How many weapons this target should soak before it counts as
	// "covered". Air-defense targets shoot incoming munitions down, so a
	// single bomb rarely arrives — commit a heavy salvo to saturate them.
	// EWRs and installations get a double-tap; everything else a pair.
	_salvoFor(t) {
		const cls = t && t.signature && t.signature.unitClass;
		if (cls === 'sam_site') return 4;
		if (cls === 'ewr' || cls === 'building') return 2;
		return 2;
	}
	// Enumerate known hostile ground units (own contacts + team datalink + intel).
	_enumGround(ctx) {
		const unit = ctx.unit, dl = ctx.teamDatalink, seen = new Set(), out = [];
		const consider = (t) => {
			if (!t || seen.has(t) || t.destroyed || t.active === false) return;
			if (t.team && unit.team && t.team === unit.team) return;
			const sig = t.signature;
			if (!sig || !GROUND_TARGET_CLASSES.has(sig.unitClass)) return;
			seen.add(t); out.push(t);
		};
		if (unit.contacts) for (const [t] of unit.contacts) consider(t);
		if (dl) {
			for (const [t] of dl.allContacts()) consider(t);
			if (dl.intelContacts) for (const [t] of dl.intelContacts) consider(t);
		}
		return out;
	}
	_pickTarget(ctx) {
		const unit = ctx.unit, ws = this._ws();
		const dl = ctx.teamDatalink, now = ctx.now ?? 0;
		const canCoord = !!(ws && ws.weapons.some(w => w.ammo > 0 && A2G_COORD_SIMTYPES.has(w.type)));
		const hasArm   = !!(ws && ws.weapons.some(w => w.ammo > 0 && A2G_ARM_SIMTYPES.has(w.type)));
		let best = null, bestR = Infinity;
		for (const t of this._enumGround(ctx)) {
			const r = this._rangeTo(unit, t);
			if (r > this.maxSearchRangeM) continue;
			// Serviceable if we have a coordinate weapon (hits any ground point)
			// or a HARM and the target is currently radiating.
			if (!canCoord && !(hasArm && isRadiating(t))) continue;
			// Strike coordination: a target with enough team weapons already
			// inbound (claimed on the datalink) is covered — fan out to the
			// next one. Defended targets need a salvo, not a single bomb.
			// Claims release when their munition dies or the assess window
			// closes, so survivors come back on the menu automatically.
			if (dl && typeof dl.strikeWeight === 'function' &&
				dl.strikeWeight(t, now) >= this._salvoFor(t)) continue;
			if (r < bestR) { best = t; bestR = r; }
		}
		return best;
	}
	isActive(ctx) {
		if (!this._hasAnyAG()) return false;
		const now = ctx.now ?? 0, dl = ctx.teamDatalink;
		if (this._target && (this._target.destroyed || this._target.active === false)) this._target = null;
		// Drop the sticky target once its salvo is inbound — ours or a
		// wingman's. The 1 Hz re-pick then fans out to the next uncovered
		// target, or goes inactive (back to CAP/cruise) until claims expire.
		if (this._target && dl && typeof dl.strikeWeight === 'function' &&
			dl.strikeWeight(this._target, now) >= this._salvoFor(this._target)) this._target = null;
		if (!this._target || now >= this._recheckAt) {
			this._recheckAt = now + 1.0; // re-pick at 1 Hz; sticky otherwise
			const t = this._pickTarget(ctx);
			if (t) this._target = t;
		}
		return !!this._target;
	}
	apply(ctx, cmd) {
		const unit = ctx.unit, t = this._target;
		if (!t) return;
		const cl = Math.cos((unit.lat || 0) * Math.PI / 180) || 1;
		const dE = (t.lon - unit.lon) * 111320 * cl;
		const dN = (t.lat - unit.lat) * 111320;
		const desiredHeading = (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360;
		cmd.targetHeading = desiredHeading;
		// Hold a sensible strike altitude band; ingress at cruise power.
		const alt = unit.alt;
		cmd.targetPitch = alt < this.cruiseAltMin ? 5 : (alt > this.cruiseAltMax ? -3 : 0);
		cmd.targetSpeed = 300;
		cmd.throttle    = 0.85;
		cmd.boost       = false;

		const range = this._rangeTo(unit, t);
		const radiating = isRadiating(t);
		const pick = this._weaponFor(ctx, t, range, radiating);
		const dbg = this.debug || (this.debug = {});
		dbg.targetName = t.name || (t.signature && t.signature.unitClass) || 'GND';
		dbg.range = range;
		dbg.radiating = radiating;
		dbg.weapon = pick ? pick.weapon.type : null;
		dbg.etaS = pick ? pick.est.tofS : null;
		dbg.impactDeg = pick ? pick.est.impactAngleDeg : null;
		dbg.salvo = this._salvoFor(t);
		dbg.claims = (ctx.teamDatalink && typeof ctx.teamDatalink.strikeWeight === 'function')
			? ctx.teamDatalink.strikeWeight(t, ctx.now ?? 0) : 0;
		dbg.released = false;
		dbg.blocked = null;
		if (!pick) {
			// Nothing feasible yet. If a glide weapon is only blocked by
			// release ALTITUDE (in static envelope but short on glide reach),
			// trade speed for height — climbing extends SDB reach ~8 m per m.
			const ws = this._ws();
			const sdb = ws && ws.weapons.find(w => w.ammo > 0 && w.type === 'GBU-39' &&
				range >= w.minRange && range <= w.maxRange);
			if (sdb && alt < this.cruiseAltMax) {
				cmd.targetPitch = 8;
				cmd.throttle = 1.0;
				dbg.blocked = 'climbing — need altitude for SDB glide reach';
			} else {
				dbg.blocked = 'closing — no weapon feasible at this range/altitude';
			}
			return; // keep closing / climbing
		}
		// Release only when roughly nose-on (so the toss/loft geometry is sane).
		const offNose = Math.abs(angleDiffDeg(unit.heading, desiredHeading));
		if (offNose > this.releaseConeDeg) {
			dbg.blocked = `turning in — ${offNose.toFixed(0)}° off release cone (${this.releaseConeDeg}°)`;
			return;
		}
		cmd.fireWeapon   = true;
		cmd.weaponType   = pick.weapon.type;
		cmd.weaponTarget = { lon: t.lon, lat: t.lat, alt: t.alt || 0 };
		// Hand the claim intent to npcUpdate, which registers it on the
		// datalink WITH the spawned munition ref once the release actually
		// happens — so the claim is released the moment the weapon dies
		// (intercepted) instead of blocking re-attack until a phantom ETA.
		cmd.strikeClaim = { target: t, etaS: pick.est.tofS };
		dbg.released = true;
	}
}

// ----------------------------------------------------------------------------
// SamAvoidBehavior — stay out of known surface-to-air missile engagement
// bubbles. Threat knowledge comes from the same picture everything else
// uses: own contacts + team datalink (live tracks + ELINT/briefed intel),
// filtered to sam_site. The WEZ radius is read from the SAM's own weapon
// loadout when visible (intel: pilots know an SA-15's reach), with a
// mid-range default otherwise — and a dry battery projects NO bubble.
//
// Activation is deliberately tight: only when we're inside the bubble or
// our current course actually intersects it within a short approach pad.
// That leaves standoff weapon releases (which point AT the SAM from well
// outside) untouched, and only intervenes when the jet is genuinely about
// to fly into the WEZ. Inside the bubble: run straight out and get low
// (terrain-mask). Approaching: turn onto the nearer tangent and skirt it.
// ----------------------------------------------------------------------------
export class SamAvoidBehavior extends Behavior {
	constructor(opts = {}) {
		super('SamAvoid');
		this.marginM   = opts.marginM   ?? 4000;  // keep this far outside the WEZ
		this.approachPadM = opts.approachPadM ?? 6000; // start reacting this far out
		this.defaultWezM  = opts.defaultWezM  ?? 15000; // unknown SAM type
		this._threat = null;
		this._recheckAt = -Infinity;
	}
	_wezOf(t) {
		const ws = t.pilot && t.pilot.subsystems && t.pilot.subsystems.weapons;
		if (ws && ws.weapons) {
			let r = 0;
			for (const w of ws.weapons) {
				if (w.ammo > 0 && (w.maxRange || 0) > r) r = w.maxRange;
			}
			return r; // 0 when winchester — a dry SAM is just scenery
		}
		return this.defaultWezM;
	}
	_horizRange(unit, t) {
		const cl = Math.cos((unit.lat || 0) * Math.PI / 180) || 1;
		const dE = (t.lon - unit.lon) * 111320 * cl;
		const dN = (t.lat - unit.lat) * 111320;
		return Math.sqrt(dE * dE + dN * dN);
	}
	_findThreat(ctx) {
		const unit = ctx.unit, dl = ctx.teamDatalink, seen = new Set();
		let worst = null, worstScore = -Infinity;
		const consider = (t) => {
			if (!t || seen.has(t) || t.destroyed || t.active === false) return;
			seen.add(t);
			if (t.team && unit.team && t.team === unit.team) return;
			const sig = t.signature;
			if (!sig || sig.unitClass !== 'sam_site') return;
			const wez = this._wezOf(t);
			if (wez <= 0) return;
			const bubble = wez + this.marginM;
			const d = this._horizRange(unit, t);
			if (d > bubble + this.approachPadM) return;
			const inside = d < bubble;
			// Course-intersects test: heading within the tangent half-angle
			// of the bubble means flying straight would penetrate it.
			const bearing = bearingFromTo(unit, t);
			const halfAngle = Math.asin(Math.min(1, bubble / Math.max(1, d))) * 180 / Math.PI;
			const intersects = Math.abs(angleDiffDeg(unit.heading, bearing)) < halfAngle;
			if (!inside && !intersects) return;
			const score = bubble - d; // deepest penetration / nearest first
			if (score > worstScore) { worstScore = score; worst = { sam: t, bubble, d, inside }; }
		};
		if (unit.contacts) for (const [t] of unit.contacts) consider(t);
		if (dl) {
			for (const [t] of dl.allContacts()) consider(t);
			if (dl.intelContacts) for (const [t] of dl.intelContacts) consider(t);
		}
		return worst;
	}
	// A SEAD-capable jet (carrying HARMs) should ATTACK radiating SAMs, not
	// flee them — so it doesn't avoid. Without this the strike pilot's
	// SamAvoid would pull it out of the very WEZ it needs to penetrate to
	// suppress, and the reactive-SEAD HARM shot would never trigger.
	_isSeadCapable() {
		const ws = this.pilot && this.pilot.subsystems && this.pilot.subsystems.weapons;
		return !!(ws && ws.weapons && ws.weapons.some(w => w.type === 'AGM-88' && w.ammo > 0));
	}
	isActive(ctx) {
		if (this._isSeadCapable()) return false;
		const now = ctx.now ?? 0;
		if (now >= this._recheckAt) {
			this._recheckAt = now + 0.5; // 2 Hz is plenty for geometry this slow
			this._threat = this._findThreat(ctx);
		}
		return !!this._threat;
	}
	apply(ctx, cmd) {
		const unit = ctx.unit, th = this._threat;
		if (!th) return;
		const bearing = bearingFromTo(unit, th.sam);
		const d = this._horizRange(unit, th.sam);
		if (d < th.bubble * 0.9) {
			// Inside the WEZ: run straight out, low and fast — terrain
			// masking breaks the SAM's track faster than altitude does.
			const agl = unit.alt - (ctx.terrainHeight ?? 0);
			cmd.targetHeading = (bearing + 180) % 360;
			cmd.targetPitch   = agl > 1200 ? -12 : (agl < 500 ? 5 : 0);
			cmd.targetSpeed   = 600;
			cmd.throttle      = 1.0;
			cmd.boost         = true;
			this.debug = { phase: 'INSIDE SAM WEZ — egress low', samName: th.sam.name || 'SAM',
				distM: d, bubbleM: th.bubble };
		} else {
			// Skirting: fly the tangent that deviates least from where we
			// were already going.
			const halfAngle = Math.asin(Math.min(1, th.bubble / Math.max(1, d))) * 180 / Math.PI;
			const left  = (bearing - halfAngle + 360) % 360;
			const right = (bearing + halfAngle) % 360;
			cmd.targetHeading =
				Math.abs(angleDiffDeg(unit.heading, left)) <= Math.abs(angleDiffDeg(unit.heading, right))
					? left : right;
			cmd.targetPitch = 0;
			cmd.targetSpeed = 380;
			cmd.throttle    = 0.9;
			cmd.boost       = false;
			this.debug = { phase: 'skirting SAM bubble', samName: th.sam.name || 'SAM',
				distM: d, bubbleM: th.bubble };
		}
	}
}

// ----------------------------------------------------------------------------
// InvestigateBehavior — actively run down KNOWN but not-currently-engageable
// air contacts. EngageBehavior only sees targets inside the TargetManager's
// engagement range; anything the team knows about beyond that (an EWR track,
// an AWACS datalink contact, a stale memory of a bandit that broke contact)
// was previously just ignored — the fighter sat on its CAP looking busy.
// This behavior picks the nearest known hostile air contact inside
// `maxRangeM` and commits energy toward it; once the range closes inside
// the engagement leash, Engage (above it in the stack) takes over.
// ----------------------------------------------------------------------------
export class InvestigateBehavior extends Behavior {
	constructor(opts = {}) {
		super('Investigate');
		// null → resolved per-tick as 1.5× the TargetManager's leash.
		this.maxRangeM = opts.maxRangeM ?? null;
		this.cruiseAltMin = opts.cruiseAltMin ?? 5000;
		this.cruiseAltMax = opts.cruiseAltMax ?? 10000;
		this._target = null;
		this._recheckAt = -Infinity;
	}
	_limit() {
		if (this.maxRangeM != null) return this.maxRangeM;
		const tm = this.pilot.subsystems.targetManager;
		return ((tm && tm.maxEngagementRange) || 70000) * 1.5;
	}
	_estPosOf(t, ctx) {
		// Prefer the TargetManager's dead-reckoned memory (it includes
		// stale LKP projection); fall back to truth coords of a datalink
		// contact (the publisher had live sensors on it this frame).
		const tm = this.pilot.subsystems.targetManager;
		const snap = tm && tm.memory && tm.memory.get(t);
		if (snap) {
			const age = (ctx.now ?? 0) - snap.timeSeen;
			const hRad = snap.heading * Math.PI / 180;
			const pRad = snap.pitch * Math.PI / 180;
			const cosLat = Math.cos(snap.lat * Math.PI / 180) || 1;
			return {
				lon: snap.lon + (Math.sin(hRad) * Math.cos(pRad) * snap.speed * age) / (111320 * cosLat),
				lat: snap.lat + (Math.cos(hRad) * Math.cos(pRad) * snap.speed * age) / 111320,
				alt: snap.alt + Math.sin(pRad) * snap.speed * age,
			};
		}
		return { lon: t.lon, lat: t.lat, alt: t.alt || 0 };
	}
	_pick(ctx) {
		const unit = ctx.unit, dl = ctx.teamDatalink, seen = new Set();
		const tm = this.pilot.subsystems.targetManager;
		const limit = this._limit();
		let best = null, bestR = Infinity;
		const consider = (t) => {
			if (!t || seen.has(t) || t.destroyed || t.active === false) return;
			seen.add(t);
			if (t === unit) return;
			if (t.team && unit.team && t.team === unit.team) return;
			const sig = t.signature;
			if (!sig || !AIR_TARGET_CLASSES.has(sig.unitClass)) return;
			const p = this._estPosOf(t, ctx);
			const cl = Math.cos((unit.lat || 0) * Math.PI / 180) || 1;
			const dE = (p.lon - unit.lon) * 111320 * cl;
			const dN = (p.lat - unit.lat) * 111320;
			const dU = (p.alt || 0) - unit.alt;
			const r = Math.sqrt(dE * dE + dN * dN + dU * dU);
			if (r > limit) return;
			if (r < bestR) { best = t; bestR = r; }
		};
		// Own memory holds everything we ever tracked (incl. beyond-leash
		// and stale LKPs); the datalink adds what the rest of the team
		// sees right now.
		if (tm && tm.memory) for (const [t] of tm.memory) consider(t);
		if (unit.contacts) for (const [t] of unit.contacts) consider(t);
		if (dl) for (const [t] of dl.allContacts()) consider(t);
		return best;
	}
	isActive(ctx) {
		const tm = this.pilot.subsystems.targetManager;
		if (tm && tm.getBest()) return false; // Engage owns anything in leash
		const now = ctx.now ?? 0;
		if (this._target && (this._target.destroyed || this._target.active === false)) this._target = null;
		if (!this._target || now >= this._recheckAt) {
			this._recheckAt = now + 1.0;
			this._target = this._pick(ctx);
		}
		return !!this._target;
	}
	apply(ctx, cmd) {
		const unit = ctx.unit, t = this._target;
		if (!t) return;
		const p = this._estPosOf(t, ctx);
		cmd.targetHeading = bearingFromTo(unit, p);
		const alt = unit.alt;
		cmd.targetPitch = alt < this.cruiseAltMin ? 6 : (alt > this.cruiseAltMax ? -3 : 0);
		// Commit energy — an intercept flown at cruise power never closes.
		cmd.targetSpeed = 450;
		cmd.throttle    = 1.0;
		cmd.boost       = false;
		const tm = this.pilot.subsystems.targetManager;
		const snap = tm && tm.memory && tm.memory.get(t);
		this.debug = {
			targetName: t.name || (t.signature && t.signature.unitClass) || 'contact',
			trackAge: snap ? (ctx.now ?? 0) - snap.timeSeen : null,
			detail: 'running down a known contact outside engage leash',
		};
	}
}

// ----------------------------------------------------------------------------
// CapAreaBehavior — orbit a station and hold it. The station-keeping half of
// an air-superiority CAP or a point-defense (protect-an-installation) mission:
// it flies a racetrack-ish orbit around a center point and, if dragged far
// off station (e.g. after an intercept), flies straight back before resuming
// the orbit. The actual fighting is EngageBehavior's job — it sits ABOVE this
// in the stack, so any bandit inside the pilot's (leashed) engagement range
// pulls the fighter off the orbit to intercept; once the threat is dealt with,
// Engage goes inactive and CapArea brings it home.
//
// The center is resolved through a `getCenter()` closure so it can be a fixed
// zone {lon, lat, altM, radiusM} (air superiority over an area) OR a live unit
// reference (defend this installation — the orbit tracks it if it ever moves).
// Returning null from getCenter makes the behavior inactive, which is how the
// protect pilot switches between escort (airborne asset) and CAP (ground asset).
// ----------------------------------------------------------------------------
export class CapAreaBehavior extends Behavior {
	constructor(opts = {}) {
		super('CapArea');
		this._getCenter = opts.getCenter || (() => null);
		this.orbitAltM  = opts.altM     ?? 7000;
		this.orbitRadM  = opts.radiusM  ?? 12000;
		this.speedMps   = opts.speedMps ?? 280;
	}
	isActive() {
		const c = this._getCenter();
		return !!(c && typeof c.lon === 'number' && typeof c.lat === 'number');
	}
	apply(ctx, cmd) {
		const u = ctx.unit;
		const c = this._getCenter();
		if (!c) return;
		const cosLat = Math.cos((u.lat || 0) * Math.PI / 180) || 1;
		const dE = (u.lon - c.lon) * 111320 * cosLat;
		const dN = (u.lat - c.lat) * 111320;
		const radius = Math.hypot(dE, dN);

		if (radius > this.orbitRadM * 1.6) {
			// Well outside the wheel — egress straight back to the station.
			cmd.targetHeading = (Math.atan2((c.lon - u.lon) * cosLat, (c.lat - u.lat)) * 180 / Math.PI + 360) % 360;
		} else {
			// On station — fly a left-hand orbit, nudging the heading in/out to
			// hold the desired radius.
			const radialBearing = Math.atan2(dE, dN) * 180 / Math.PI;
			let headingCmd = (radialBearing + 90 + 360) % 360;
			const radialErr = radius - this.orbitRadM;
			headingCmd += Math.max(-30, Math.min(30, radialErr * 0.0015));
			cmd.targetHeading = (headingCmd + 360) % 360;
		}
		// A zone carries its own orbit altitude (altM); a unit center doesn't,
		// so we orbit at the configured station altitude above it.
		const aimAlt = (typeof c.altM === 'number') ? c.altM : this.orbitAltM;
		const altErr = aimAlt - u.alt;
		cmd.targetPitch = Math.max(-8, Math.min(8, altErr * 0.01));
		cmd.targetSpeed = this.speedMps;
		cmd.throttle    = 0.7;
		cmd.boost       = false;
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
		// Multiplier on the aircraft's own pull-up radius for the look-ahead
		// distance. A sluggish jet (low usable-G) needs to start the recovery
		// far earlier than an agile one — sizing the look-ahead to the actual
		// pull-up radius is what stops a B-2 (≈2 G) from augering in during an
		// evasion dive that an F-16 (≈9 G) would shrug off.
		this.pullRadiusMul = opts.pullRadiusMul ?? 2.5;
		// Internal cadence + cached result so isActive() can be queried
		// 60 Hz cheaply.
		this._lastCheckAt = -Infinity;
		this._cachedHit   = null;
		this._cachedLookAhead = 1;
	}

	_recheck(unit, now) {
		if (now - this._lastCheckAt < 0.2) return;
		this._lastCheckAt = now;
		const speed = Math.max(60, unit.speed || 0);
		// Pull-up capability from the airframe's usable load factor. Net
		// upward accel = (n−1)·g; vertical recovery radius = v²/that. The
		// look-ahead must cover the distance flown while rotating the flight
		// path up, so it scales with this radius — automatically ~10× longer
		// for a 1.8 G bomber than for a 9 G fighter.
		const gUsable = Math.max(1.25, (unit.physics && unit.physics.gSoftLimit) || 6);
		const pullAccel = Math.max(2, (gUsable - 1) * 9.81);
		const pullRadiusM = (speed * speed) / pullAccel;
		const lookAhead = Math.max(
			this.minLookAheadM,
			speed * this.lookAheadSeconds,
			this.pullRadiusMul * pullRadiusM,
		);
		// More samples for a longer chord so a thin ridge isn't stepped over.
		const samples = Math.max(6, Math.min(24, Math.round(lookAhead / 800)));
		const hit = forwardLookTerrain(unit, lookAhead, samples, this.clearanceM);
		this._cachedHit = hit;
		this._cachedLookAhead = lookAhead;
		this._cachedHitDist = hit ? hit.distance : Infinity;
	}

	isActive(ctx) {
		const unit = ctx.unit;
		if (!unit) return false;
		// Don't fight the static-clamp on parked SAMs and similar.
		if (unit.isStatic) return false;
		this._recheck(unit, ctx.now ?? 0);
		// Active on ANY obstruction inside the (agility-sized) look-ahead —
		// the look-ahead distance IS "how far out this airframe must start
		// pulling," so a hit within it means react now. Clears automatically
		// once the climb opens the chord.
		return this._cachedHit !== null;
	}

	apply(ctx, cmd) {
		// Pull-up urgency ramps with how deep into the look-ahead the
		// obstacle sits: gentle (18°) when it's first detected at the edge,
		// hard (45°) when it's right on top of us. (For a sluggish jet the
		// physics G-limiter caps the actual pitch rate regardless — this just
		// commands the strongest legal pull as early as possible.)
		const frac = Math.max(0, Math.min(1, 1 - (this._cachedHitDist / Math.max(1, this._cachedLookAhead))));
		const targetPitch = 18 + 27 * frac; // 18° → 45°
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
		// Per-engagement state: which missile we committed to and which
		// direction (left/right) we chose to beam. Re-evaluating either
		// every frame causes the "frantic roll back-and-forth"
		// pathology — the closing missile's bearing drifts, the
		// equidistant-beam-pick flips, and the AI commands a 180°
		// heading reversal. Once we've picked, we hold until the
		// missile dies or leaves the trigger envelope.
		this._committedThreat   = null;
		this._committedBeamSide = 0;          // -1 = left, +1 = right, 0 = uncommitted
		this._committedAt       = -Infinity;
		this._dropOutTimer      = 0;          // brief loss-of-contact grace
		// Post-defeat defensive hold. When the threat missile finally goes
		// dumb / dies, we do NOT snap the nose straight back onto the bandit
		// ("turn hot the nanosecond the missile is defeated" is DCS's single
		// most-criticized immersion break). Instead we keep extending /
		// staying defensive for a few seconds, regaining energy and lateral
		// separation, before yielding control back to Engage.
		this.defensiveHoldS = opts.defensiveHoldS ?? 4.0;
		this._holdUntil     = -Infinity;
		this._holdHeading   = undefined;
		// Staged response. A missile that's still far out does NOT justify
		// dropping everything and turning tail — that's how a whole CAP gets
		// suppressed by one long-range lob and held down forever. Beyond
		// `farThreatM` the pilot flies a defensive CRANK (threat held
		// ~`returnFireConeDeg` off the nose: cuts closure, keeps own radar
		// coverage) and RETURNS FIRE if a target solution exists. Only
		// inside farThreatM does it commit to the full beam-and-dive.
		this.farThreatM        = opts.farThreatM        ?? 14000;
		this.returnFireConeDeg = opts.returnFireConeDeg ?? 60;
	}

	// Defensive snap shot while cranking away from an inbound missile.
	// Relaxed gates vs EngageBehavior: no STT pre-fire courtesy flash (we're
	// the one being shot at), no aspect-scaled WEZ — if the bandit is in the
	// weapon's envelope and inside the launch gimbal cone, send it. The
	// WeaponSubsystem still enforces ammo / cooldown / in-flight caps.
	_tryReturnFire(ctx, cmd) {
		const tm = this.pilot.subsystems.targetManager;
		const ws = this.pilot.subsystems.weapons;
		const best = tm && tm.getBest();
		if (!best || !ws) return;
		if (best.isMemory && best.age > 2.5) return; // no launching on ghosts
		const unit = ctx.unit;
		const weapon = ws.pickWeaponFor(best.range, ctx.now, ctx.projectiles || [], unit);
		if (!weapon || weapon.type === 'gun') return;
		const aimHeading = bearingFromTo(unit, { lon: best.estPos.lon, lat: best.estPos.lat });
		if (Math.abs(angleDiffDeg(unit.heading, aimHeading)) > this.returnFireConeDeg) return;
		cmd.fireWeapon   = true;
		cmd.weaponType   = weapon.type;
		cmd.weaponTarget = best.target;
	}

	// Nearest RADIATING enemy SAM/EWR within `maxRangeM` (own contacts + team
	// datalink + intel). The thing lighting us up is the thing to kill.
	_findRadiatingSam(ctx, maxRangeM) {
		const unit = ctx.unit, dl = ctx.teamDatalink, seen = new Set();
		const cl = Math.cos((unit.lat || 0) * Math.PI / 180) || 1;
		let best = null, bestR = Infinity;
		const consider = (t) => {
			if (!t || seen.has(t) || t.destroyed || t.active === false) return;
			seen.add(t);
			if (t.team && unit.team && t.team === unit.team) return;
			const sig = t.signature;
			if (!sig || (sig.unitClass !== 'sam_site' && sig.unitClass !== 'ewr')) return;
			if (!isRadiating(t)) return;
			const dE = (t.lon - unit.lon) * 111320 * cl;
			const dN = (t.lat - unit.lat) * 111320;
			const dU = (t.alt || 0) - unit.alt;
			const r = Math.sqrt(dE * dE + dN * dN + dU * dU);
			if (r > maxRangeM || r >= bestR) return;
			bestR = r; best = t;
		};
		if (unit.contacts) for (const [t] of unit.contacts) consider(t);
		if (dl) {
			for (const [t] of dl.allContacts()) consider(t);
			if (dl.intelContacts) for (const [t] of dl.intelContacts) consider(t);
		}
		return best;
	}

	// Reactive SEAD: if we carry a HARM and a radiating SAM is in range, fire
	// one at it — even mid-evasion. The HARM is fire-and-forget / home-on-jam,
	// so it costs no maneuvering: we keep beaming the inbound missile while the
	// HARM flies out at the battery that launched it. This is what lets a SEAD
	// package actually suppress the site instead of just running away from it.
	_trySeadShot(ctx, cmd) {
		if (cmd.fireWeapon) return false; // one weapon per frame already taken
		const ws = this.pilot.subsystems.weapons;
		if (!ws) return false;
		const harm = ws.weapons.find(w => w.type === 'AGM-88' && w.ammo > 0);
		if (!harm) return false;
		const unit = ctx.unit, now = ctx.now ?? 0;
		if (now - harm.lastFire < harm.fireRate) return false;
		if (harm.maxInFlight) {
			let live = 0;
			for (const p of (ctx.projectiles || [])) {
				if (p && p.active && p.launcher === unit && p.type === 'AGM-88' && ++live >= harm.maxInFlight) return false;
			}
		}
		const sam = this._findRadiatingSam(ctx, harm.maxRange);
		if (!sam) return false;
		cmd.fireWeapon   = true;
		cmd.weaponType   = 'AGM-88';
		cmd.weaponTarget = { lon: sam.lon, lat: sam.lat, alt: sam.alt || 0 };
		return true;
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

	isActive(ctx) {
		// Hold-then-drop semantics. Once committed to a threat, we
		// stay active so long as the missile is alive and any sensor
		// channel can find it within the next 1.5 s. A brief contact
		// flicker (notch / IR cone edge) doesn't drop us — that's
		// the source of the original frantic-roll oscillation when
		// the AI rapidly toggled between Evasion and Engage.
		if (this._committedThreat) {
			const t = this._committedThreat;
			const stillAlive = t && !t.destroyed && t.active !== false;
			const stillNear  = stillAlive && this._findThreatById(ctx, t);
			if (stillNear) {
				this._dropOutTimer = 0;
				return true;
			}
			this._dropOutTimer += (ctx.dt || 0);
			if (stillAlive && this._dropOutTimer < 1.5) return true;
			// Threat defeated / gone — begin the post-defeat defensive hold
			// instead of releasing straight to Engage. Capture the current
			// (evasion) heading as the extension vector.
			this._committedThreat   = null;
			this._committedBeamSide = 0;
			this._dropOutTimer      = 0;
			this._holdUntil         = ctx.now + this.defensiveHoldS;
			this._holdHeading       = ctx.unit.heading;
		}
		// A fresh missile always overrides — re-commit to active evasion and
		// cancel any lingering hold.
		const fresh = this._findThreat(ctx);
		if (fresh) {
			this._committedThreat = fresh.target;
			this._committedAt     = ctx.now;
			this._committedBeamSide = 0;       // chosen lazily on first apply()
			this._holdUntil       = -Infinity;
			return true;
		}
		// No live threat, but stay defensive through the hold window so we
		// don't instantly turn hot the frame the missile dies.
		if (ctx.now < this._holdUntil) return true;
		return false;
	}

	// Lookup helper: is a specific missile still detectable + in range?
	// Used by isActive to keep evasion locked on the chosen threat
	// instead of letting _findThreat pick a different one each frame.
	_findThreatById(ctx, missile) {
		const contacts = ctx.unit.contacts;
		if (!contacts) return null;
		const c = contacts.get(missile);
		if (!c) return null;
		if (!c.radar && !c.ir && !c.visual) return null;
		const range = (c.radar && c.radar.range) || null;
		if (range !== null && range > this.triggerRange) return null;
		return { target: missile, contact: c, range };
	}

	apply(ctx, cmd, dt) {
		const threat = (this._committedThreat
			&& this._findThreatById(ctx, this._committedThreat))
			|| this._findThreat(ctx);
		if (!threat) {
			// Post-defeat defensive hold: the missile is gone but we're
			// deliberately not turning hot yet. Extend on the held heading at
			// AB, level, to open separation and rebuild energy before Engage
			// retakes control when the hold expires.
			if (ctx.now < this._holdUntil) {
				cmd.targetHeading = (this._holdHeading != null) ? this._holdHeading : ctx.unit.heading;
				cmd.targetPitch   = 0;
				cmd.targetSpeed   = 600;
				cmd.throttle      = 1.0;
				cmd.boost         = true;
				this.debug = { phase: 'defensive hold', detail: `extending ${(this._holdUntil - ctx.now).toFixed(1)}s before re-engaging` };
				return;
			}
			// No threat and no hold → reset the last-ditch jitter so the next
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
		// Pick a beam direction once and stick with it. Re-evaluating
		// the closer-beam choice each frame is the second source of
		// the rolling-back-and-forth pathology: as the missile closes,
		// its bearing drifts a few degrees, the equidistant midpoint
		// between leftBeam and rightBeam flips, and the AI commands a
		// 180° heading reversal. Lock on first apply().
		if (this._committedBeamSide === 0) {
			const dL = angleDiffDeg(unit.heading, leftBeam);
			const dR = angleDiffDeg(unit.heading, rightBeam);
			this._committedBeamSide = Math.abs(dL) < Math.abs(dR) ? -1 : +1;
		}
		const beamHeading = (this._committedBeamSide < 0) ? leftBeam : rightBeam;

		// Countermeasure choice is guidance-aware: flares only spoof IR
		// seekers. Against a radar shot they're dead weight — the defense
		// there is geometry (beam/notch) and terrain masking. Unknown
		// seeker type (we can't always tell) errs toward flaring.
		const seekerType  = msl.data && msl.data.seekerType;
		const flareUseful = !seekerType || seekerType === 'ir' || seekerType === 'iir';

		// Altitude-above-terrain, poked in by npcSystem at ~2 Hz. Used to
		// pull out of the terrain-masking dive as the ground gets close —
		// avoids needing TerrainAvoid to take over (which would fight with
		// the evasion commands).
		const agl = unit.alt - (ctx.terrainHeight ?? 0);

		// Reactive SEAD before anything else — a HARM at the radiating battery
		// is the highest-value shot we can take, and it doesn't interrupt the
		// beam/dive maneuvering. Takes the frame's single weapon slot if it
		// fires, so we skip the air-to-air return shot below.
		const seadFired = this._trySeadShot(ctx, cmd);

		// ---- Far threat: defensive crank + return fire -----------------------
		// The missile is still tens of seconds out. Going full beam-and-dive
		// here means one long-range lob suppresses the fighter for the whole
		// missile flight — it never shoots back and gets run down for free.
		// Instead: hold the threat ~60° off the nose (cuts closure, keeps the
		// bandit inside our own radar/launch gimbal) at full power, and put a
		// missile back at the shooter if we have any solution.
		if (range !== null && range > this.farThreatM) {
			cmd.targetHeading = (bearingToMsl + this._committedBeamSide * this.returnFireConeDeg + 360) % 360;
			cmd.targetPitch   = 0;     // keep the energy, don't dump altitude yet
			cmd.targetSpeed   = 480;
			cmd.throttle      = 1.0;
			cmd.boost         = true;
			if (!seadFired) this._tryReturnFire(ctx, cmd);
			this.debug = {
				phase: 'defensive crank + return fire',
				threat: msl.type || 'missile', seeker: seekerType || '?', rangeM: range,
				detail: cmd.fireWeapon ? `${seadFired ? 'SEAD HARM' : 'RETURN FIRE'} ${cmd.weaponType}` : 'holding threat 60° off nose, looking for a return shot',
			};
			return;
		}

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
			if (flareUseful && ctx.now - this._lastFlareAt > 0.3) {
				cmd.fireFlare = true;
				this._lastFlareAt = ctx.now;
			}
			this.debug = {
				phase: 'LAST DITCH break', threat: msl.type || 'missile', seeker: seekerType || '?',
				rangeM: range, detail: flareUseful ? 'hard beam break + flares' : 'hard beam break (radar shot — no flares)',
			};
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

			if (flareUseful && ctx.now - this._lastFlareAt > this.flareInterval) {
				cmd.fireFlare = true;
				this._lastFlareAt = ctx.now;
			}
			this.debug = {
				phase: 'beam + terrain mask', threat: msl.type || 'missile', seeker: seekerType || '?',
				rangeM: range,
				detail: `beaming ${this._committedBeamSide < 0 ? 'left' : 'right'}, diving (AGL ${Math.round(agl)} m)`
					+ (flareUseful ? ' + flares' : ', no flares vs radar shot'),
			};
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
			// A trashed shot (missed flyby / maddog) needs no support —
			// stop cranking and get back in the fight.
			if (p.lostLock || p.maddog) continue;
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
		const isRadarAam = !!(weapon && RADAR_AAM_TYPES.has(weapon.type));

		// Track quality. A "stale" track means NOBODY on the team has live
		// sensors on this target — we're flying at a dead-reckoned ghost.
		// Principled handling: pursue the projection to reacquire, but never
		// LAUNCH on it (a missile fired at a guess is a missile wasted), and
		// expect the position error to grow with age.
		const staleTrack = !!(best.isMemory && best.age > 2.5);

		// Spectator-HUD debug record — one reused object, updated at every
		// decision point below so the HUD can show exactly why this pilot
		// is or isn't firing right now.
		const dbg = this.debug || (this.debug = {});
		dbg.targetName = (target && (target.name || (target.signature && target.signature.unitClass))) || 'TGT';
		dbg.range      = range;
		dbg.trackAge   = best.age;
		dbg.stale      = staleTrack;
		dbg.weapon     = weapon ? weapon.type : null;
		dbg.wezMax     = null;
		dbg.angleOff   = null;
		dbg.sttRemainS = null;
		dbg.fired      = false;
		dbg.blocked    = weapon ? null : 'no weapon ready (envelope / cooldown / in-flight cap)';

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
			// Missile engagement: fly a COLLISION course (lead intercept) on
			// the projected target rather than pure pursuit — cuts the corner
			// on a crossing or fleeing bandit and keeps closure up. The
			// missile does its own guidance after launch.
			const icp = this._interceptPoint(unit, estPos, estVel);
			aimHeading = bearingFromTo(unit, { lon: icp.lon, lat: icp.lat });
			aimPitch   = null;
			// Stale-track search: once we're inside the bubble where the
			// bandit could plausibly be (position uncertainty grows with
			// track age), weave the nose so the radar sweeps the volume
			// instead of boring straight through the ghost point.
			if (staleTrack) {
				const uncertM = best.age * (estSpeed * 0.5 + 30);
				if (range < Math.max(6000, uncertM)) {
					aimHeading = (aimHeading + Math.sin(now * 1.3) * 35 + 360) % 360;
				}
			}
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
				// In a close turning fight, fight at corner speed — ~340 m/s
				// is where turn RATE peaks; 600 m/s just widens the circle.
				// Far away with the nose off, it's a chase: build speed.
				cmd.targetSpeed = range < 5000 ? 340 : 600;
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
			// Loft a long radar shot: pitch up before release so the missile
			// starts high and fast where the air is thin — real BVR doctrine
			// and worth tens of percent of kinematic range on an AMRAAM.
			if (isRadarAam && !staleTrack && range > 25000 && alt < 11000) {
				cmd.targetPitch = 14;
				aimPitch = 14; // fire gate below waits for the nose-high attitude
			}
			// Pursuit energy: a cold (fleeing) bandit or a stale ghost won't
			// be run down at cruise power. Commit energy to close.
			if ((aspectCos < -0.2 && range > 10000) || staleTrack) {
				cmd.throttle    = 1.0;
				cmd.boost       = range > 15000;
				cmd.targetSpeed = 500;
			}
		}

		// ---- Tally-and-commit override --------------------------------------
		// A fresh CLOSE visual/IR merge (flagged by the TargetManager — e.g.
		// a low-RCS bomber that slid into the visual bubble unseen by radar)
		// turns this from a casual BVR cruise into a knife-fight commit:
		// firewall the throttle, light the burner, and run the intercept
		// down. The steering above already points us at the bandit (or its
		// lag point for guns); this just supplies the ENERGY to convert the
		// merge instead of sailing past and forgetting about it. Overrides
		// the cruise energy policy for both the gun and missile branches.
		if (tm && tm.isCommitting(now)) {
			cmd.throttle    = 1.0;
			cmd.boost       = true;
			cmd.targetSpeed = Math.max(cmd.targetSpeed || 0, 600);
		}

		dbg.angleOff = angleOff;
		dbg.aspectCos = aspectCos;

		// ---- Stale-track fire discipline ------------------------------------
		// Never launch on a dead-reckoned ghost. The steering above is already
		// running the intercept/search; weapons wait for someone — us or the
		// datalink — to put live sensors back on the target.
		if (staleTrack) { dbg.blocked = `stale track (${best.age.toFixed(1)}s) — pursuing to reacquire`; return; }

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
		if (isRadarAam) {
			// aspectCos was computed above for the gun-aspect check.
			// +1 = bandit pointing at us (head-on); -1 = bandit cold.
			const wezScale = 0.3 + 0.7 * Math.max(0, (1 + aspectCos) / 2);
			const effectiveMax = weapon.maxRange * wezScale;
			dbg.wezMax = effectiveMax;
			if (range > effectiveMax) {
				dbg.blocked = `closing to WEZ: fire ${weapon.type} at ${Math.round(effectiveMax / 100) * 100} m`;
				return;
			}
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
			if (range > 3200) { dbg.blocked = 'gun: outside 3.2 km'; return; }

			const inFireCone = inRearHemisphere
				? (headingErrToLead < FIRE_CONE_TRACKING && pitchErrToLead < FIRE_CONE_TRACKING)
				: (headingErrToLead < FIRE_CONE_SNAP    && pitchErrToLead < FIRE_CONE_SNAP);
			if (!inFireCone) { dbg.blocked = `gun: pipper off by ${headingErrToLead.toFixed(1)}°`; return; }
		} else {
			// Missile fire: just check steering aim aligns with target
			// projection. Seeker / datalink takes it from there.
			const fireCone = this.fireConeDeg;
			const pitchErr = aimPitch !== null ? Math.abs(unit.pitch - aimPitch) : 0;
			if (angleOff > fireCone) { dbg.blocked = `turning to launch axis (${angleOff.toFixed(0)}° off, need <${fireCone}°)`; return; }
			if (pitchErr > fireCone) { dbg.blocked = `pitching to launch axis (${pitchErr.toFixed(0)}° off)`; return; }
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
			// (Re)start the flash on a new target OR when a prior commit has gone
			// stale — Engage was interrupted (evasion/terrain break) for longer
			// than the flash window and is only now retaking control on the SAME
			// target. The commit state lives on the pilot and was previously
			// cleared only on the firing frame, so without this staleness check
			// the pilot skipped the courtesy STT flash and fired with no fresh
			// RWR launch warning to the defender.
			if (this.pilot._sttCommitTarget !== target ||
				(ctx.now - this.pilot._sttCommitAt) > FLASH_S + 0.5) {
				// First frame of commit — record the timestamp + target
				// and let this frame end with no fire. The radar will
				// flip to STT on the next mode-management tick.
				this.pilot._sttCommitAt = ctx.now;
				this.pilot._sttCommitTarget = target;
				dbg.sttRemainS = FLASH_S;
				dbg.blocked = 'STT flash — firing imminently';
				return;
			}
			if ((ctx.now - this.pilot._sttCommitAt) < FLASH_S) {
				dbg.sttRemainS = FLASH_S - (ctx.now - this.pilot._sttCommitAt);
				dbg.blocked = `STT flash — firing in ${dbg.sttRemainS.toFixed(1)}s`;
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
		dbg.fired   = true;
		dbg.blocked = null;
	}

	// Iterative collision-course point for the intercept: where to point the
	// nose so that flying straight at our current speed meets the target's
	// projected track. Same fixed-point iteration as the gun lead but with
	// OWN speed instead of bullet speed, and a generous time cap so a slow
	// tail-chase doesn't lead to a point in the next county.
	_interceptPoint(unit, estPos, estVel) {
		const cosLat = Math.cos(unit.lat * Math.PI / 180);
		const dE = (estPos.lon - unit.lon) * 111320 * cosLat;
		const dN = (estPos.lat - unit.lat) * 111320;
		const dU = (estPos.alt - unit.alt);
		const ownSpd = Math.max(150, unit.speed || 0);
		let t = Math.min(90, Math.sqrt(dE*dE + dN*dN + dU*dU) / ownSpd);
		for (let i = 0; i < 2; i++) {
			const lE = dE + estVel.E * t;
			const lN = dN + estVel.N * t;
			const lU = dU + estVel.U * t;
			t = Math.min(90, Math.sqrt(lE*lE + lN*lN + lU*lU) / ownSpd);
		}
		return {
			lon: estPos.lon + (estVel.E * t) / (111320 * cosLat),
			lat: estPos.lat + (estVel.N * t) / 111320,
			alt: estPos.alt + estVel.U * t,
		};
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
