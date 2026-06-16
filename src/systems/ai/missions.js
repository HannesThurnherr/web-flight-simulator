// ============================================================================
// NPC mission assignment — the layer that turns "this jet has a job" into a
// reconfigured pilot. A mission is a small plain object stored on the unit as
// `npc.assignedMission`; applyMission() hot-swaps `npc.pilot` to the pilot
// factory that implements that job. Designed to be driven either by a scenario
// (at spawn) or by the mouse-driven mission-assign UI (at runtime) — both just
// build a mission object and call applyMission().
//
// Mission shapes:
//   { type: 'protect',         getProtected: () => unit }      // escort/CAP an asset
//   { type: 'protect',         protectedUnit: unit }           // (ref form)
//   { type: 'air-superiority', zone: { lon, lat, altM?, radiusM } }
//   { type: 'attack',          zone: { lon, lat, radiusM } }   // (increment 2)
//
// `opts` on the mission is forwarded to the pilot factory (loadout, altitudes,
// engagement range, etc.) so scenarios/UI can tune without new mission types.
// ============================================================================

import {
	createFighterPilot,
	createAirSuperiorityPilot,
	createProtectPilot,
} from './index.js';

// Apply a mission to an NPC: stash it and rebuild the pilot. Returns true if
// the mission type is implemented, false otherwise (caller can fall back).
// Behaviors are stateful, so a fresh pilot = a clean start on the new job.
export function applyMission(npc, mission) {
	if (!npc || !mission || !mission.type) return false;
	const opts = mission.opts || {};

	switch (mission.type) {
		case 'protect': {
			// Accept either a live closure or a direct unit ref.
			const getProtected = mission.getProtected
				|| (() => mission.protectedUnit || null);
			npc.assignedMission = mission;
			npc.pilot = createProtectPilot(npc, { getProtected, ...opts });
			return true;
		}
		case 'air-superiority': {
			if (!mission.zone) return false;
			npc.assignedMission = mission;
			npc.pilot = createAirSuperiorityPilot(npc, { zone: mission.zone, ...opts });
			return true;
		}
		case 'attack': {
			// Ground-attack employment lands in increment 2.
			return false;
		}
		default:
			return false;
	}
}

// Drop a mission and revert to the default engage-on-sight fighter pilot.
export function clearMission(npc) {
	if (!npc) return;
	npc.assignedMission = null;
	npc.pilot = createFighterPilot(npc);
}

// Human-readable one-liner for HUD / commander tooltip.
export function describeMission(mission) {
	if (!mission || !mission.type) return 'Engage on sight';
	switch (mission.type) {
		case 'protect': {
			const e = mission.getProtected ? mission.getProtected() : mission.protectedUnit;
			const name = (e && (e.name || e.id)) || 'asset';
			return `Protect ${name}`;
		}
		case 'air-superiority': return 'Air superiority (area)';
		case 'attack':          return 'Attack (area)';
		default:                return mission.type;
	}
}
