// Scenario registry + active-scenario plumbing.
//
// Scenarios come in three flavours:
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
//   3. User-authored scenarios — Phase 10b. Stored in localStorage,
//      loaded at boot, merged on top of bundled ones so the picker
//      shows everything together. User scenarios are editable; the
//      bundled + JS ones are read-only (DUPLICATE creates a user copy).
//
// The main-menu picker treats all three kinds identically for play.
// The editor (Phase 10b+) uses `getRawScenario(id)` and `isUserScenario(id)`
// to know whether to allow editing.

import { notchingTestScenario } from './notchingTest.js';
import { jammingTestScenario } from './jammingTest.js';
import { buildScenarioFromJson } from './scenarioRunner.js';
import { loadUserScenarios } from './userScenarios.js';

// Auto-discover every JSON scenario.
const _scenarioModules = import.meta.glob('../../data/scenarios/*.json', { eager: true });

// Keep the raw JSONs around — the editor (and the picker, for the
// description / name fields) needs to read them after the runner
// has wrapped them into {onStart, update, onStop} objects. JS
// scenarios don't have raw JSON; getRawScenario returns null for
// those.
const _rawJsons = {};
const _bundledIds = new Set();

const _jsonScenarios = {};
for (const [path, mod] of Object.entries(_scenarioModules)) {
	const raw = mod.default || mod;
	const fallbackId = path.match(/\/([^/]+)\.json$/)?.[1];
	const id = raw.id || fallbackId;
	if (!id) continue;
	_rawJsons[id] = raw;
	_bundledIds.add(id);
	_jsonScenarios[id] = buildScenarioFromJson(raw);
}

// JS-side scenarios — also bundled.
_bundledIds.add('notching');
_bundledIds.add('jamming');

// Build the merged registry. User scenarios layered on top so a
// user-edited copy with the same id (rare — we usually pick a fresh
// id on duplicate) wins. Both kinds run through buildScenarioFromJson
// so the runtime path is identical.
function _buildRegistry() {
	const out = {
		..._jsonScenarios,
		// JS scenarios next so they can override a JSON of the same
		// id if someone's iterating on a data scenario with JS hooks.
		notching: notchingTestScenario,
		jamming:  jammingTestScenario,
	};
	const userScenarios = loadUserScenarios();
	for (const [id, raw] of Object.entries(userScenarios)) {
		_rawJsons[id] = raw;
		out[id] = buildScenarioFromJson(raw);
	}
	return out;
}

export let SCENARIOS = _buildRegistry();

// Re-read user scenarios from localStorage and rebuild the registry.
// Called by the editor after a save so the picker reflects the
// freshly-saved scenario without a page reload.
export function refreshScenarios() {
	SCENARIOS = _buildRegistry();
	return SCENARIOS;
}

// Raw JSON access for the editor + picker UI.
export function getRawScenario(id) {
	return _rawJsons[id] || null;
}

export function isBundled(id) {
	return _bundledIds.has(id);
}

export function isUserScenario(id) {
	return !_bundledIds.has(id) && id in (loadUserScenarios());
}

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
