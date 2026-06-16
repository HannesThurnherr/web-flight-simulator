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

// User-authored scenarios persisted to disk under <project>/scenarios/ by the
// editor (mirrored there from localStorage — see userScenarios._mirrorToDisk
// and vite.config.js). Loaded here so they survive a localStorage wipe, are
// version-controllable, and can be shared as plain files. Unlike the bundled
// set these stay EDITABLE. Empty/absent dir → {} (no-op). New files written
// during a session appear after a dev-server restart; live edits go through
// localStorage and override the file copy below.
const _userFileModules = import.meta.glob('../../../scenarios/*.json', { eager: true });

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

// Disk-backed user scenarios (editable, NOT bundled). Keyed by id so a
// localStorage copy of the same id wins in _buildRegistry.
const _fileScenarios = {};
const _fileIds = new Set();
for (const [path, mod] of Object.entries(_userFileModules)) {
	const raw = mod.default || mod;
	const fallbackId = path.match(/\/([^/]+)\.json$/)?.[1];
	const id = (raw && raw.id) || fallbackId;
	if (!id) continue;
	_fileScenarios[id] = raw;
	_fileIds.add(id);
}

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
	// Disk-backed user scenarios first, then the localStorage copies on top —
	// a live edit (localStorage) wins over the last-mirrored file of the same
	// id, while a file with no localStorage copy (fresh browser / shared
	// scenario) still shows up and stays editable.
	for (const [id, raw] of Object.entries(_fileScenarios)) {
		_rawJsons[id] = raw;
		out[id] = buildScenarioFromJson(raw);
	}
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
	if (_bundledIds.has(id)) return false;
	return (id in loadUserScenarios()) || _fileIds.has(id);
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
