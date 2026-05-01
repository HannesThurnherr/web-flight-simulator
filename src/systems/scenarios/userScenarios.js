// ============================================================================
// User-authored scenarios — Phase 10b.
//
// Storage layer for scenarios the player creates / edits in the
// editor. Lives in localStorage under a single key holding a `{ id:
// json }` map. The registry (scenarios/index.js) merges these on top
// of the bundled JSONs so they appear in the scenario picker the same
// way; the only differences are:
//   - User scenarios are EDITABLE (an EDIT button on the picker card).
//   - Bundled scenarios are read-only (DUPLICATE creates a user copy).
//
// We don't try to validate the schema here — the runner already
// gracefully handles malformed entries (warns + skips). What this
// module owns is the CRUD surface: load all, save one, delete one,
// duplicate from bundled, generate an unused id.
// ============================================================================

const LS_KEY = 'web-flight-sim:user-scenarios';

function _readAll() {
	try {
		const raw = localStorage.getItem(LS_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === 'object') return parsed;
	} catch (e) {
		console.warn('[userScenarios] failed to parse localStorage:', e);
	}
	return {};
}

function _writeAll(obj) {
	try {
		localStorage.setItem(LS_KEY, JSON.stringify(obj));
		return true;
	} catch (e) {
		console.warn('[userScenarios] failed to write to localStorage:', e);
		return false;
	}
}

// Return every user-authored scenario as a plain `{ id: json }` map.
// Always reflects current localStorage — no in-memory cache, since
// user-scenarios are tiny and this gets called rarely (once per
// picker open).
export function loadUserScenarios() {
	return _readAll();
}

// Persist one user scenario by id. `json` is the raw scenario record
// (same shape buildScenarioFromJson takes). Returns true on success.
export function saveUserScenario(id, json) {
	if (!id) return false;
	const all = _readAll();
	all[id] = { ...json, id, modifiedAt: new Date().toISOString() };
	return _writeAll(all);
}

export function deleteUserScenario(id) {
	const all = _readAll();
	if (!(id in all)) return false;
	delete all[id];
	return _writeAll(all);
}

// Build a fresh empty scenario record for the "+ NEW SCENARIO"
// button. Caller picks an `id` (via `nextUserId`) and a name; the
// rest defaults to a player-relative anchor with an empty spawn
// list — author-friendly clean slate.
export function emptyScenario(id, name) {
	return {
		schemaVersion: 2,
		id,
		name: name || 'New Scenario',
		description: '',
		anchor: { mode: 'player-relative' },
		autoSpawn: false,
		spawns: [],
		objectives: [],
		triggers: [],
		createdAt: new Date().toISOString(),
		modifiedAt: new Date().toISOString(),
	};
}

// Generate an id that doesn't collide with bundled or user scenarios.
// `usedIds` is a Set/array supplied by the caller (so we don't have to
// pull in the bundled-scenarios module here and create an import cycle).
export function nextUserId(usedIds, base = 'untitled') {
	const used = new Set(usedIds);
	let candidate = base;
	let n = 0;
	while (used.has(candidate)) candidate = `${base}-${++n}`;
	return candidate;
}

// Duplicate a bundled scenario into the user pool. Strips the
// `BUNDLED` flag (added by index.js when surfacing bundled scenarios)
// and gives the copy a new id like `"<orig>-copy"`.
export function duplicateScenario(sourceJson, usedIds) {
	const id = nextUserId(usedIds, `${sourceJson.id || 'scenario'}-copy`);
	const copy = JSON.parse(JSON.stringify(sourceJson));
	copy.id = id;
	copy.name = `${sourceJson.name || 'Scenario'} (copy)`;
	copy.createdAt = new Date().toISOString();
	copy.modifiedAt = copy.createdAt;
	delete copy.__bundled;
	saveUserScenario(id, copy);
	return id;
}

// Export-as-JSON-text for the eventual "DOWNLOAD" button in the
// editor (Phase 10e). Pretty-printed so editors and diff tools
// handle it nicely.
export function exportAsJsonText(json) {
	return JSON.stringify(json, null, '\t');
}

// Import-from-JSON-text counterpart. Returns the new scenario id
// on success or null on parse failure. `usedIds` enforces non-
// collision with both bundled and user scenarios.
export function importFromJsonText(text, usedIds) {
	let json;
	try { json = JSON.parse(text); } catch (e) {
		console.warn('[userScenarios] import parse failed:', e);
		return null;
	}
	if (!json || typeof json !== 'object') return null;
	const id = json.id && !usedIds.includes(json.id)
		? json.id
		: nextUserId(usedIds, json.id || 'imported');
	const stamped = { ...json, id, importedAt: new Date().toISOString() };
	saveUserScenario(id, stamped);
	return id;
}
