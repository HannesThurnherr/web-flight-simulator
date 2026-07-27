// ============================================================================
// Carrier air operations — the deck cycle.
//
// Turns a carrier from a large boat into an airbase: it launches its air wing,
// the aircraft fly real missions under the normal fighter AI, and when they're
// done (ammo gone, or the mission clock runs out) they come home, fly an
// approach and trap. Recovered airframes return to the roster and can be
// launched again, so a carrier is a RENEWABLE source of air rather than a
// scenery object that happened to spawn some fighters at t=0.
//
// That renewability is the point. It makes the carrier the highest-value unit
// in the fleet — killing it doesn't just remove a hull, it stops the enemy
// generating sorties — which is what gives the ASBM and the SAM ballistic
// reserve something to actually be about.
//
// DECK SEQUENCING. A real deck cannot launch and recover at the same time, and
// can only do one of either at a time. Both constraints are modelled, because
// without them a carrier dumps its entire wing into the air in one frame and
// the whole thing reads as a spawn button. The cycle is:
//
//   LAUNCH   one aircraft every launchIntervalS, while airborne < airborneCap
//            and nobody is in the groove
//   RECOVER  an aircraft in the groove owns the deck; launches hold
//
// Aircraft fly under the ordinary fighter pilot the rest of the time — this
// module only decides WHEN they leave and WHEN they're called home. The flying
// home is RecoverToCarrierBehavior's job (behaviors.js).
// ============================================================================

import { getTeamDatalink } from './teamDatalink.js';

const DEG = Math.PI / 180;

// Registry of live air wings, keyed by their carrier NPC.
const _wings = new Map();

export function createCarrierAirWing(carrier, cfg = {}) {
	if (!carrier) return null;
	const wing = {
		carrier,
		team: carrier.team,
		// Roster entries: { fighterModel, loadout, count, missionS }
		roster: (cfg.squadrons || []).map(s => ({
			fighterModel: s.fighterModel || 'f-18',
			loadout: s.loadout || null,
			ready: s.count ?? 4,          // airframes on deck, available to launch
			total: s.count ?? 4,
			missionS: s.missionS ?? 420,  // how long a sortie lasts before RTB
			name: s.name || null,
		})),
		airborneCap: cfg.airborneCap ?? 4,
		launchIntervalS: cfg.launchIntervalS ?? 22,
		_launchTimer: 0,
		airborne: [],                     // live NPCs this wing put up
		_state: 'ready',                  // ready | launching | recovering
		launched: 0,
		recovered: 0,
		lost: 0,
	};
	_wings.set(carrier, wing);
	return wing;
}

export function getCarrierAirWing(carrier) { return _wings.get(carrier) || null; }

// Every wing whose carrier is still afloat. Used by the HUD/tooltip.
export function allCarrierAirWings() { return _wings; }

export function resetCarrierAirWings() { _wings.clear(); }

// True while the deck is committed to a launch or a recovery — the carrier
// steers into wind for both (see the ship pilot's Flight-ops branch).
export function carrierFlightOpsActive(carrier) {
	const w = _wings.get(carrier);
	if (!w) return false;
	return w._state !== 'ready';
}

function _hasAmmoLeft(npc) {
	const ws = npc.pilot && npc.pilot.subsystems && npc.pilot.subsystems.weapons;
	if (!ws || !Array.isArray(ws.weapons)) return true;
	return ws.weapons.some(w => w && w.type !== 'gun' && w.ammo > 0);
}

// ============================================================================
// Mission tasking — what the wing arms for.
//
// A carrier doesn't fly a fixed rotation of squadrons; it arms each sortie for
// the mission that most needs flying. The wing reads the battle group's shared
// air picture (the team datalink — what the GROUP knows, not ground truth),
// sorts the contacts into the things a strike fighter can be sent to kill, and
// launches whichever mission is furthest behind.
//
// The comparison is demand-vs-coverage rather than a fixed priority order. A
// fixed order either never stops flying CAP or never stops flying strikes; a
// deficit rotates on its own — put two Harpoon shooters up against three
// cruisers and the anti-ship deficit closes, so the next cat shot goes to
// whatever is now furthest behind. It also degrades correctly: no contacts
// known (or nothing the wing stocks ordnance for) falls back to the plain
// proportional rotation, so the deck keeps turning either way.
// ============================================================================

const ROLE_A2A = 'a2a', ROLE_ANTISHIP = 'antiship',
      ROLE_SEAD = 'sead', ROLE_STRIKE = 'strike';

// What a contact of each class needs sent at it. Anything absent here — most
// importantly the missile / cruise_missile / bomb classes — is not a tasking:
// you don't launch a sortie at an inbound round, that's the SAMs' job.
const ROLE_FOR_CLASS = {
	fighter: ROLE_A2A, stealth_fighter: ROLE_A2A, stealth_bomber: ROLE_A2A,
	awacs: ROLE_A2A, drone_isr: ROLE_A2A, cargo: ROLE_A2A,
	ship: ROLE_ANTISHIP,
	sam_site: ROLE_SEAD, ewr: ROLE_SEAD,
	building: ROLE_STRIKE, ground: ROLE_STRIKE,
};

// Sorties one contact is worth. Fractional and deliberately not equal: a
// two-ship CAP covers a handful of bandits and one SEAD pair works several
// launchers, but a cruiser genuinely wants a dedicated section — a lone
// Hornet's four Harpoons will not get through a Kara's air defences.
const SORTIES_PER_CONTACT = {
	[ROLE_A2A]: 0.5, [ROLE_ANTISHIP]: 0.75, [ROLE_SEAD]: 0.5, [ROLE_STRIKE]: 0.25,
};

// Ordnance → the mission it exists to fly. Lets a squadron's role be INFERRED
// from what it's carrying, so air wings written before roles existed keep
// working with no edit.
const ROLE_FOR_WEAPON = {
	HARPOON: ROLE_ANTISHIP, 'AGM-84': ROLE_ANTISHIP, 'P-800': ROLE_ANTISHIP,
	'AGM-88': ROLE_SEAD,
	'GBU-39': ROLE_STRIKE, 'GBU-38': ROLE_STRIKE, 'GBU-31': ROLE_STRIKE,
	'GBU-12': ROLE_STRIKE, 'AGM-86': ROLE_STRIKE, 'STORM-SHADOW': ROLE_STRIKE,
};

// Most specific first. A2A is last because EVERY loadout carries AAMs for
// self-defence — a Harpoon shooter with two Sidewinders is not a fighter
// sweep, so air-to-air only wins when there's nothing else aboard.
const ROLE_RANK = [ROLE_ANTISHIP, ROLE_SEAD, ROLE_STRIKE, ROLE_A2A];

// How far out the wing will accept a tasking. Past this it's someone else's
// war: the jet would spend its whole sortie clock in transit.
const TASKING_RADIUS_M = 300000;

// Roles a squadron can fly. Explicit `roles: [...]` / `role: "..."` in the
// platform JSON wins; otherwise read it off the ordnance.
function _rolesOf(sq) {
	if (sq._roles) return sq._roles;
	let roles = null;
	if (Array.isArray(sq.roles) && sq.roles.length) roles = sq.roles.slice();
	else if (sq.role) roles = [sq.role];
	else {
		const found = new Set();
		for (const key of Object.keys(sq.loadout || {})) {
			const r = ROLE_FOR_WEAPON[String(key).toUpperCase()];
			if (r) found.add(r);
		}
		roles = ROLE_RANK.filter(r => found.has(r));
		if (!roles.length) roles = [ROLE_A2A];
	}
	return (sq._roles = roles);
}
function _primaryRole(sq) { return _rolesOf(sq)[0]; }

// role → the loadout the wing arms that mission with. First squadron listing a
// role owns the profile for it, so one squadron can supply two missions (a
// HARM + SDB jet is both the SEAD and the strike profile).
function _profiles(wing) {
	if (wing._profiles) return wing._profiles;
	const p = {};
	for (const sq of wing.roster) {
		for (const r of _rolesOf(sq)) {
			if (!p[r]) p[r] = { role: r, loadout: sq.loadout, missionS: sq.missionS };
		}
	}
	return (wing._profiles = p);
}

// What the battle group currently knows it's up against, in sortie-equivalents.
function _threatCensus(wing) {
	const out = { [ROLE_A2A]: 0, [ROLE_ANTISHIP]: 0, [ROLE_SEAD]: 0, [ROLE_STRIKE]: 0 };
	let dl = null;
	try { dl = getTeamDatalink(wing.team); } catch (e) { return out; }
	if (!dl || typeof dl.allContacts !== 'function') return out;
	const c = wing.carrier;
	const cosLat = Math.cos((c.lat || 0) * DEG) || 1;
	const r2 = TASKING_RADIUS_M * TASKING_RADIUS_M;
	for (const [target] of dl.allContacts()) {
		if (!target || target.destroyed || target.active === false) continue;
		if (target.team === wing.team) continue;
		const role = ROLE_FOR_CLASS[target.signature && target.signature.unitClass];
		if (!role) continue;
		const dE = ((target.lon || 0) - (c.lon || 0)) * 111320 * cosLat;
		const dN = ((target.lat || 0) - (c.lat || 0)) * 111320;
		if (dE * dE + dN * dN > r2) continue;
		out[role]++;
	}
	return out;
}

// Sorties already covering each mission. A jet on its way home stops counting
// the moment it's recalled — it has nothing left to prosecute with.
function _coverage(wing) {
	const out = { [ROLE_A2A]: 0, [ROLE_ANTISHIP]: 0, [ROLE_SEAD]: 0, [ROLE_STRIKE]: 0 };
	for (const npc of wing.airborne) {
		if (!npc || npc.destroyed || npc.active === false) continue;
		if (npc._recoverTo) continue;
		const r = npc._sortieRole || ROLE_A2A;
		out[r] = (out[r] || 0) + 1;
	}
	return out;
}

// Fallback rotation: the squadron with the largest fraction of itself still on
// deck. Interleaves squadrons in proportion to their size (a 6-jet squadron
// gets twice the sorties of a 3-jet one) and self-corrects after losses. This
// is what runs when there's no threat picture to task against — without it the
// wing launched its fighter squadron, recovered it, launched it again, and
// never once put the anti-ship or SEAD jets up.
function _proportionalSlot(ready) {
	let best = null, bestFrac = -1;
	for (const r of ready) {
		const frac = r.ready / Math.max(1, r.total);
		if (frac > bestFrac) { bestFrac = frac; best = r; }
	}
	return best;
}

// Decide the next cat shot: which airframe, flying what, armed how.
function _nextSortie(wing) {
	const ready = wing.roster.filter(r => r.ready > 0);
	if (!ready.length) return null;

	const profiles = _profiles(wing);
	const threat = _threatCensus(wing);
	const cover  = _coverage(wing);

	// Only roles with something actually out there are candidates, and among
	// those the one furthest behind wins. Restricting to real demand matters
	// as much as the deficit does: an earlier cut fell back to the blind
	// rotation once demand was met, so a wing whose only known threat was
	// enemy fighters put its third jet up carrying Harpoons — ordnance for a
	// surface group that wasn't there. A role nobody has seen is never armed
	// for. The deficit can go negative and still win, which is right: with
	// three cruisers and nothing else known, every jet should be a Harpoon
	// shooter, and the moment a bandit shows up the CAP deficit outranks it.
	let bestRole = null, bestDeficit = -Infinity, anyDemand = false;
	for (const role of ROLE_RANK) {
		if (!profiles[role]) continue;            // wing carries nothing for it
		const demand = threat[role] * SORTIES_PER_CONTACT[role];
		if (demand <= 0) continue;
		anyDemand = true;
		const deficit = demand - cover[role];
		if (deficit > bestDeficit) { bestDeficit = deficit; bestRole = role; }
	}
	if (!anyDemand) bestRole = null;
	wing._lastThreat = threat;
	wing._lastTasking = bestRole;

	// Nothing known out there at all — keep the deck turning on the plain
	// rotation rather than sitting on its hands.
	if (!bestRole) return { slot: _proportionalSlot(ready), role: null, profile: null };

	// Prefer an airframe from the squadron that already owns the mission.
	// Failing that, take whichever squadron has airframes to spare and ARM IT
	// FOR THE JOB — that second half is the whole point. A Hornet is a Hornet;
	// a full fighter squadron sitting on the deck is no reason to leave three
	// cruisers unengaged because the anti-ship squadron happens to be flying.
	const own = ready.find(r => _primaryRole(r) === bestRole);
	return { slot: own || _proportionalSlot(ready), role: bestRole, profile: profiles[bestRole] };
}

// ----------------------------------------------------------------------------
// Per-frame tick for one wing.
// ----------------------------------------------------------------------------
function _updateWing(wing, dt, ctx) {
	const carrier = wing.carrier;
	// Carrier sunk or sinking — the wing stops generating sorties. Anything
	// already airborne keeps flying (and will orbit once it can't recover),
	// which is the right outcome: losing the deck strands the air wing.
	if (carrier.destroyed || carrier.sinking || carrier.active === false) {
		wing._state = 'ready';
		return;
	}

	// ---- Reap and reassess what's airborne ---------------------------------
	let inGroove = false;
	for (let i = wing.airborne.length - 1; i >= 0; i--) {
		const npc = wing.airborne[i];
		if (!npc || npc.destroyed || npc.active === false) {
			wing.airborne.splice(i, 1);
			wing.lost++;
			continue;
		}
		// Trapped — RecoverToCarrierBehavior got it to the ramp. Return the
		// airframe to the roster and take it out of the world.
		if (npc._recoverState === 'trap') {
			const slot = wing.roster.find(r => r._key === npc._wingSlotKey) || wing.roster[0];
			if (slot) slot.ready = Math.min(slot.total, slot.ready + 1);
			npc.destroyed = true;        // top-of-loop cleanup removes the mesh
			npc._trapped = true;         // so the kill log can tell this from a shootdown
			wing.airborne.splice(i, 1);
			wing.recovered++;
			continue;
		}
		if (npc._recoverTo) { inGroove = inGroove || npc._recoverState === 'approach'; continue; }

		// ---- RTB triggers ---------------------------------------------------
		// Out of everything but the gun, or the sortie clock expired. Either
		// way the jet has no further reason to be up there.
		npc._sortieLeft = (npc._sortieLeft ?? npc._sortieS ?? 420) - dt;
		if (npc._sortieLeft <= 0 || !_hasAmmoLeft(npc)) {
			npc._recoverTo = carrier;
			npc._recoverState = 'marshal';
		}
	}

	// ---- Deck state ---------------------------------------------------------
	// A jet in the groove owns the deck; launches hold until it's aboard.
	if (inGroove) {
		wing._state = 'recovering';
		return;
	}

	// ---- Launch cycle -------------------------------------------------------
	wing._launchTimer -= dt;
	// Re-tasked every cycle, not once at spawn: the threat picture the wing is
	// arming against is the one that exists at the catapult, so a fleet that
	// comes over the horizon mid-battle gets Harpoons sent at it.
	const sortie = _nextSortie(wing);
	const slot = sortie && sortie.slot;
	const canLaunch = slot && wing.airborne.length < wing.airborneCap;
	if (!canLaunch) {
		wing._state = wing.airborne.length ? 'ready' : 'ready';
		return;
	}
	wing._state = 'launching';
	if (wing._launchTimer > 0) return;
	wing._launchTimer = wing.launchIntervalS;

	const npc = _catapultLaunch(wing, slot, ctx, sortie);
	if (npc) {
		slot.ready--;
		wing.launched++;
		wing.airborne.push(npc);
	}
}

// Put one airframe off the bow. Spawned just ahead of the ship on the deck
// centreline at catapult end-speed, so it flies away rather than materialising
// at altitude somewhere.
function _catapultLaunch(wing, slot, ctx, sortie = null) {
	const npcSystem = ctx && ctx.npcSystem;
	if (!npcSystem || typeof npcSystem.createNPCMesh !== 'function') return null;
	const c = wing.carrier;
	const hdg = c.heading || 0;
	const cosLat = Math.cos((c.lat || 0) * DEG) || 1;

	// A short way ahead of the bow so the jet isn't inside the ship's own mesh.
	const ahead = 180;
	const lon = c.lon + Math.sin(hdg * DEG) * ahead / (111320 * cosLat);
	const lat = c.lat + Math.cos(hdg * DEG) * ahead / 111320;
	const alt = (c.alt || 0) + 25;

	const name = slot.name || null;
	const npc = npcSystem.createNPCMesh(
		name, lon, lat, alt, hdg,
		78,                    // catapult end speed — flying, but only just
		wing.team,
		slot.fighterModel,
	);
	if (!npc) return null;

	// Arm for the MISSION, not for the squadron. When the tasking picked a role
	// this squadron doesn't normally fly, the jet goes up with the wing's
	// profile for that role instead of its own — the ordnance follows the
	// threat. `_wingSlotKey` still points at the parent squadron so the
	// airframe returns to the right pool on trap.
	const profile = (sortie && sortie.profile) || null;
	const loadout = (profile && profile.loadout) || slot.loadout;
	const missionS = (profile && profile.missionS) ?? slot.missionS;

	npc._wingSlotKey = slot._key || (slot._key = slot.fighterModel + ':' + slot.total);
	npc._carrier = c;
	npc._sortieRole = (sortie && sortie.role) || _primaryRole(slot);
	npc._sortieS = missionS;
	npc._sortieLeft = missionS;
	if (loadout && typeof ctx.applyNpcLoadout === 'function') {
		try { ctx.applyNpcLoadout(npc, loadout); } catch (e) { /* optional */ }
	}
	return npc;
}

// ----------------------------------------------------------------------------
// Tick every wing. Called once per frame from the sim loop.
// ----------------------------------------------------------------------------
export function updateCarrierOps(dt, ctx) {
	if (_wings.size === 0) return;
	for (const [carrier, wing] of _wings) {
		if (!carrier || carrier.destroyed) {
			// Keep the wing around one more pass so the tooltip can show the
			// final tally, then drop it.
			if (carrier && carrier._wingReaped) { _wings.delete(carrier); continue; }
			if (carrier) carrier._wingReaped = true;
		}
		try { _updateWing(wing, dt, ctx); } catch (e) { /* never break the frame */ }
	}
}

// One-line status for the map tooltip.
export function describeAirWing(carrier) {
	const w = _wings.get(carrier);
	if (!w) return null;
	const ready = w.roster.reduce((s, r) => s + r.ready, 0);
	const total = w.roster.reduce((s, r) => s + r.total, 0);
	return {
		state: w._state,
		readyOnDeck: ready,
		total,
		airborne: w.airborne.length,
		cap: w.airborneCap,
		launched: w.launched,
		recovered: w.recovered,
		lost: w.lost,
		// What the wing is arming against, so the tooltip can say WHY the deck
		// is spotting Harpoons instead of Sidewinders.
		tasking: w._lastTasking || null,
		threat: w._lastThreat || null,
		flying: _coverage(w),
	};
}

// Adopt an ALREADY-AIRBORNE aircraft into a carrier's wing.
//
// A scenario that opens with a CAP already on station still wants those jets
// to belong to the ship: to count against its airborne cap, to be called home
// when they run dry, and to trap on its deck rather than orbit forever with an
// empty magazine. Without this they're orphans — the deck cycle can't see them
// and they never recover.
//
// Note the airframe is NOT deducted from the roster: it's already off the deck,
// so the roster count reflects what's still spotted. When it traps it will add
// itself back, which is the right accounting for "launched before the scenario
// opened".
export function adoptIntoAirWing(carrier, npc, opts = {}) {
	const wing = _wings.get(carrier);
	if (!wing || !npc) return false;
	// Credit it to the squadron flying its type, so it comes back to the right
	// one on trap. Falls through to the first squadron for an airframe the
	// wing doesn't otherwise operate.
	const slot = (opts.fighterModel &&
		wing.roster.find(r => r.fighterModel === opts.fighterModel)) || wing.roster[0];
	npc._carrier = carrier;
	npc._wingSlotKey = slot && (slot._key || (slot._key = slot.fighterModel + ':' + slot.total));
	npc._sortieS = opts.missionS ?? (slot ? slot.missionS : 420);
	npc._sortieLeft = npc._sortieS;
	// A standing CAP is air-to-air coverage unless told otherwise, so the
	// tasking model doesn't launch a redundant sweep on top of it.
	npc._sortieRole = opts.role || (slot ? _primaryRole(slot) : ROLE_A2A);
	wing.airborne.push(npc);
	wing.launched++;
	return true;
}
