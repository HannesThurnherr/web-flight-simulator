// ============================================================================
// formation.js — player-led formation (Phase 5.5).
//
// One singleton per game session: tracks the player as formation lead
// plus up to 3 wingmen, the slot each occupies, the break-formation
// mode (RTB / CAP) chosen at spawn, and the spawn point used as the
// RTB orbit center. Read by:
//
//   - FormationBehavior (src/systems/ai/behaviors.js) to compute each
//     wingman's stationkeeping target relative to the leader.
//   - WeaponSystem.fire (src/systems/weaponSystem.js) to pick the first
//     formation member with ammo of the requested simType — wingmen
//     shoot before the leader so the player burns *their* magazines
//     first, exactly as a strike-package real-world commander would.
//   - HUD / strike planner to display aggregated ammo across the flight.
//
// Mode lifecycle per wingman:
//   formation     — hold slot, do not engage (player calls every shot).
//                   Sticks here while the wingman has any strike-class
//                   ammo.
//   patrol-rtb    — strike ammo exhausted; break formation, go to the
//                   spawn point, orbit at altitude. Engage incoming
//                   hostiles within 10 km using AAMs, otherwise pacifist.
//   patrol-cap    — strike ammo exhausted; orbit the player's CURRENT
//                   position, engage hostiles within 30 km using normal
//                   fighter doctrine.
//
// Default break behavior is configurable per spawn (gameSettings.formation
// .breakBehavior) and applied to every wingman the same. Future: per-
// wingman break override.
//
// "Formation" rather than "flight" because everywhere else the codebase
// uses "flight" to mean "the data block on a missile spec" (boostAccel,
// dragRef, …); reusing the word for the player-and-wingmen group caused
// two distinct concepts to look identical at a glance.
// ============================================================================

// Slot offsets in the leader's body frame at heading=0.
//   right:  positive = wingman is to the leader's right
//   back:   positive = wingman is behind the leader
//   side:   debug label
// Slots are indexed 0..2 → at most 3 wingmen.
export const FORMATION_SLOTS = [
	{ right:  120, back:  60, side: 'right-wedge' },
	{ right: -120, back:  60, side: 'left-wedge'  },
	{ right:    0, back: 200, side: 'trail'       },
];

// Mode constants, exported so callers compare against named values.
export const MODE_FORMATION  = 'formation';
export const MODE_PATROL_RTB = 'patrol-rtb';
export const MODE_PATROL_CAP = 'patrol-cap';

export const formation = {
	leader: null,           // playerState reference (or null while no formation active)
	members: [],            // npc references, ordered by slot index
	spawnPoint: null,       // {lon, lat, alt} — RTB orbit center
	breakBehavior: 'rtb',   // 'rtb' | 'cap' — what mode to switch to on ammo exhaustion
};

// Initialize a formation with a leader + members. Each member is
// tagged with its slot index and starting mode. Caller is responsible
// for having spawned the npcs already and given them a wingman pilot.
export function setFormation({ leader, members = [], spawnPoint, breakBehavior = 'rtb' }) {
	formation.leader        = leader;
	formation.members       = members.slice();
	formation.spawnPoint    = spawnPoint ? { ...spawnPoint } : null;
	formation.breakBehavior = breakBehavior;
	for (let i = 0; i < members.length; i++) {
		const m = members[i];
		if (!m) continue;
		m._wingmanSlot = i;
		m._wingmanMode = MODE_FORMATION;
	}
}

// Wipe formation state. Called on respawn / scenario change so we
// don't hold dangling refs to dead npcs.
export function clearFormation() {
	formation.leader        = null;
	formation.members.length = 0;
	formation.spawnPoint    = null;
}

// True if the npc is a current, live member of the player's formation.
export function isWingman(npc) {
	if (!npc) return false;
	if (npc.destroyed) return false;
	return formation.members.includes(npc);
}

// Per-member mode. Stored on the npc as _wingmanMode so behaviors can
// read it without importing the formation module everywhere.
export function getMemberMode(npc) {
	return (npc && npc._wingmanMode) || MODE_FORMATION;
}
export function setMemberMode(npc, mode) {
	if (npc) npc._wingmanMode = mode;
}

// Sum the ammo of a given simType across the whole formation (wingmen
// only — leader queries their own weaponSystem directly). Used by HUD
// and strike-planner aggregated-ammo readouts.
export function totalWingmanAmmo(simType) {
	let total = 0;
	for (const m of formation.members) {
		if (!m || m.destroyed) continue;
		const ws = m.pilot && m.pilot.subsystems && m.pilot.subsystems.weapons;
		if (!ws || !Array.isArray(ws.weapons)) continue;
		for (const w of ws.weapons) {
			if (w.type !== simType) continue;
			if (w.ammo === Infinity) continue;
			total += Math.max(0, w.ammo);
		}
	}
	return total;
}

// Pick a wingman to fire a round of `simType` on the player's command.
// Walks members in slot order, returns the first one in formation mode
// with >0 ammo of that type. null if no wingman can take the shot
// (caller falls back to leader's own ammo).
//
// Wingmen in patrol mode are skipped — once they break formation they
// run their own AAMs autonomously; the player no longer has remote
// fire authority on them.
export function pickWingmanShooter(simType) {
	for (const m of formation.members) {
		if (!m || m.destroyed) continue;
		if (getMemberMode(m) !== MODE_FORMATION) continue;
		const ws = m.pilot && m.pilot.subsystems && m.pilot.subsystems.weapons;
		if (!ws || !Array.isArray(ws.weapons)) continue;
		const w = ws.weapons.find(w => w.type === simType && w.ammo > 0);
		if (w) return { unit: m, weapon: w };
	}
	return null;
}

// Periodic check: any wingman that's exhausted strike-class ammo and
// has no AAM-only role left in formation should auto-switch into
// patrol mode. Strike-class = anything that takes a designation queue
// point (cruise / GPS / laser); a wingman still carrying AAMs stays in
// formation in case the player wants them held back as escort.
//
// Called once per frame from npcUpdate.
export function tickFormationModes(strikeTypes) {
	if (!formation.leader || formation.members.length === 0) return;
	for (const m of formation.members) {
		if (!m || m.destroyed) continue;
		if (getMemberMode(m) !== MODE_FORMATION) continue;
		const ws = m.pilot && m.pilot.subsystems && m.pilot.subsystems.weapons;
		if (!ws) continue;
		let strikeAmmoLeft = 0;
		for (const w of ws.weapons) {
			if (strikeTypes.includes(w.type) && w.ammo > 0) strikeAmmoLeft += w.ammo;
		}
		if (strikeAmmoLeft === 0) {
			setMemberMode(m, formation.breakBehavior === 'cap'
				? MODE_PATROL_CAP : MODE_PATROL_RTB);
		}
	}
}
