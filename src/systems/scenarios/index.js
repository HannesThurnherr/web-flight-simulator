// Scenario registry + active-scenario plumbing.
//
// Scenarios come in two flavours:
//   1. Pure-data scenarios — one JSON in src/data/scenarios/. The
//      registry picks them up via glob-import and wraps each through
//      scenarioRunner.buildScenarioFromJson() to produce the
//      {onStart, update, onStop} object the lifecycle expects. Adding
//      a new scripted mission is a single JSON drop.
//   2. JS scenarios — for missions that need bespoke per-frame logic
//      (e.g. notching test with its live telemetry panel, or a
//      rendezvous that spawns reinforcements on a trigger). They're
//      imported directly below and merged into the registry alongside
//      the data-driven ones.
//
// The main-menu picker treats both kinds identically.

import { notchingTestScenario } from './notchingTest.js';
import { buildScenarioFromJson } from './scenarioRunner.js';

// Auto-discover every JSON scenario.
const _scenarioModules = import.meta.glob('../../data/scenarios/*.json', { eager: true });

const _jsonScenarios = {};
for (const [path, mod] of Object.entries(_scenarioModules)) {
	const raw = mod.default || mod;
	const fallbackId = path.match(/\/([^/]+)\.json$/)?.[1];
	const id = raw.id || fallbackId;
	if (!id) continue;
	_jsonScenarios[id] = buildScenarioFromJson(raw);
}

export const SCENARIOS = {
	..._jsonScenarios,
	// JS scenarios go last so they can override a JSON of the same id
	// if someone's iterating on a data scenario with JS-side hooks.
	notching: notchingTestScenario,
};

// Default on first load. User's pick from the main-menu dropdown
// overrides this before onStart ever fires.
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
