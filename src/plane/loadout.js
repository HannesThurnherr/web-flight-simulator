// ============================================================================
// Loadout state — per-plane hardpoint-to-munition map.
//
// For each plane id we keep a record of `{hardpointId: munitionId|null}`.
// The loadout is mutated by the loadout-editor UI and read by:
//   - the airframe modal (to render current state + compute weight)
//   - main.js spawn commit (to derive weaponSystem ammo counts + signature)
//   - future: NPC loadouts, AI bomber wing config, etc.
//
// Persisted in localStorage so a chosen loadout survives a reload (but
// not across scenarios / sessions intentionally — loadout is part of
// the "select your jet" decision, not runtime state).
// ============================================================================
import { PLANES } from './planes.js';
import { MUNITIONS, isCompatible } from '../weapon/munitions.js';
import { SIGNATURES } from '../systems/signatures.js';

const STORAGE_KEY = 'flightsim.loadouts';

// In-memory cache: { [planeId]: { [hardpointId]: munitionId | null } }
let _loadouts = {};

function _load() {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) _loadouts = JSON.parse(raw) || {};
	} catch (e) {
		_loadouts = {};
	}
}
function _save() {
	try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_loadouts)); }
	catch (e) { /* quota / disabled storage — not fatal */ }
}
_load();

// Return the loadout for a plane, creating a default one if this is
// the first time we see this plane. Default = fill every AAM-accepting
// hardpoint with AIM-120 (or AIM-9 for short-range-only slots), leaving
// non-AAM hardpoints empty. Tuned to mimic a typical air-to-air
// default config.
export function getLoadout(planeId) {
	if (_loadouts[planeId]) return _loadouts[planeId];
	const plane = PLANES[planeId];
	if (!plane || !Array.isArray(plane.hardpoints)) {
		_loadouts[planeId] = {};
		return _loadouts[planeId];
	}
	const lo = {};
	for (const hp of plane.hardpoints) {
		lo[hp.id] = _defaultMunitionFor(hp);
	}
	_loadouts[planeId] = lo;
	_save();
	return lo;
}

function _defaultMunitionFor(hp) {
	// Prefer AIM-120 for multi-purpose AAM hardpoints; fall back to
	// AIM-9 where that's all the accepts list allows; leave non-AAM
	// hardpoints empty (user can load AGMs etc. deliberately).
	if (!hp.accepts) return null;
	const aim120 = MUNITIONS['aim-120d'];
	const aim9   = MUNITIONS['aim-9x'];
	if (aim120 && isCompatible(hp, aim120)) return aim120.id;
	if (aim9   && isCompatible(hp, aim9))   return aim9.id;
	return null;
}

export function setLoadoutSlot(planeId, hardpointId, munitionId) {
	const lo = getLoadout(planeId);
	if (munitionId == null || munitionId === '') {
		lo[hardpointId] = null;
	} else {
		lo[hardpointId] = munitionId;
	}
	_save();
}

// Bulk op: fill every compatible hardpoint with a munition id; null
// clears. Used by the "Fill AAM" and "Clear" quick-action buttons.
export function fillAllCompatible(planeId, munitionId) {
	const plane = PLANES[planeId];
	if (!plane || !Array.isArray(plane.hardpoints)) return;
	const lo = getLoadout(planeId);
	const mun = munitionId ? MUNITIONS[munitionId] : null;
	for (const hp of plane.hardpoints) {
		if (mun == null) { lo[hp.id] = null; continue; }
		lo[hp.id] = isCompatible(hp, mun) ? munitionId : lo[hp.id];
	}
	_save();
}

export function clearAll(planeId) {
	const lo = getLoadout(planeId);
	for (const key of Object.keys(lo)) lo[key] = null;
	_save();
}

// Aggregate counts by simType for the weaponSystem. E.g.
// { 'AIM-120': 4, 'AIM-9': 2 }.
export function simTypeCounts(planeId) {
	const lo = getLoadout(planeId);
	const counts = {};
	for (const munId of Object.values(lo)) {
		if (!munId) continue;
		const m = MUNITIONS[munId];
		if (!m || !m.simType) continue;
		counts[m.simType] = (counts[m.simType] || 0) + 1;
	}
	return counts;
}

export function totalWeightKg(planeId) {
	const lo = getLoadout(planeId);
	let w = 0;
	for (const munId of Object.values(lo)) {
		if (!munId) continue;
		const m = MUNITIONS[munId];
		if (m && typeof m.massKg === 'number') w += m.massKg;
	}
	return w;
}

// Sum of RCS contributions from externally-carried munitions.
// Internal-bay carriage contributes zero (stores are inside a shaped
// bay so they don't reflect). Non-internal hardpoints DO contribute
// — including `fuselage`, `centerline`, and `external` types. On a
// stealth jet this number dominates the airframe's tiny baseline RCS
// as soon as anything external is loaded.
export function externalRcsM2(planeId) {
	const plane = PLANES[planeId];
	if (!plane || !Array.isArray(plane.hardpoints)) return 0;
	const lo = getLoadout(planeId);
	let sum = 0;
	for (const hp of plane.hardpoints) {
		if (hp.type === 'internal') continue;      // inside a bay → no contribution
		const munId = lo[hp.id];
		if (!munId) continue;
		const m = MUNITIONS[munId];
		if (m && typeof m.rcsContributionM2 === 'number') sum += m.rcsContributionM2;
	}
	return sum;
}

// Effective RCS = airframe baseline (from SIGNATURES) + sum of
// external store contributions. Used at spawn to set the player's
// state.signature.rcs and displayed in the loadout UI.
//
// This is why stealth "degrades gracefully" instead of flipping to
// a full non-stealth RCS: a clean F-22 is 0.008 m², a loaded F-22
// with 4 external AMRAAMs is 0.008 + 4×0.03 = 0.128 m². Still
// ~100× smaller than an F-15's 12 m² — enemies still can't see you
// as far, just further than when clean.
export function effectiveRcsM2(planeId) {
	const plane = PLANES[planeId];
	if (!plane) return 0;
	const sig = SIGNATURES[plane.signature];
	const base = (sig && typeof sig.rcs === 'number') ? sig.rcs : 0;
	return base + externalRcsM2(planeId);
}

// Backward-compatible helper: true when externals contribute more to
// RCS than the airframe baseline (i.e. the stealth advantage is
// substantially degraded). Useful for a UI badge.
export function isStealthBroken(planeId) {
	const plane = PLANES[planeId];
	if (!plane) return false;
	const sig = SIGNATURES[plane.signature];
	const base = (sig && typeof sig.rcs === 'number') ? sig.rcs : 0;
	if (base >= 1) return false; // non-stealth planes can't "break" stealth they never had
	return externalRcsM2(planeId) > base;
}
