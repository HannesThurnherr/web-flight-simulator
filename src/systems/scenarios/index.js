// Scenario registry + active-scenario plumbing.
//
// A scenario is a small object with lifecycle hooks:
//   onStart(ctx)   — called once on player spawn. Typical work: configure the
//                    NPC system (auto-spawn on/off, spawn mode), drop the
//                    initial entities into the world, install any scenario-
//                    specific DOM overlay.
//   update(ctx,dt) — called every frame while FLYING or CRASHED. For
//                    scenarios that need per-tick behaviour (scripted
//                    movement, telemetry readouts, win/lose conditions).
//   onStop(ctx)    — called when the player respawns / quits / switches
//                    scenarios. Tear down anything onStart installed.
//
// ctx is { npcSystem, playerState, viewer, scene, weaponSystem, hud }.
//
// Adding a new scenario = drop a file in this directory and register it below.
// The HTML menu's <select id="scenarioSelect"> is populated from SCENARIOS at
// boot, so no other plumbing is needed to make a scenario pickable.

import { bvr3wayScenario } from './bvr3way.js';
import { notchingTestScenario } from './notchingTest.js';
import { awacsBvrScenario } from './awacsBvr.js';

export const SCENARIOS = {
	bvr3way:   bvr3wayScenario,
	'awacs-bvr': awacsBvrScenario,
	notching:  notchingTestScenario,
};

// Default on first load. User's pick from the main-menu dropdown overrides
// this before onStart ever fires.
let _activeId = 'bvr3way';

export function setActiveScenario(id) {
	if (SCENARIOS[id]) _activeId = id;
}
export function getActiveScenario() {
	return SCENARIOS[_activeId];
}
export function getActiveScenarioId() {
	return _activeId;
}
