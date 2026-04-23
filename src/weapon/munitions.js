// ============================================================================
// Munitions registry — auto-discovered from src/data/munitions/*.json.
// Parallel to src/plane/planes.js in every way: drop a new JSON in the
// directory and the registry picks it up on next build.
//
// Each munition describes:
//   id          — kebab-case unique key (primary lookup)
//   name        — display name in UI
//   shortName   — compact label used on hardpoints
//   category    — "AAM" | "AGM" | "GBU" | "TANK" | ... Used by
//                 hardpoint `accepts` arrays for gross compatibility.
//   tags        — finer-grained descriptors (bvr / wvr / ir / fox-3 ...).
//                 Lets a hardpoint restrict further (e.g. accept AAMs
//                 only if they carry the "wvr" tag).
//   massKg      — per-unit mass, rolls into the plane's loadout weight
//   simType     — maps to the weapon type string the player's
//                 weaponSystem already understands ("AIM-120" / "AIM-9"
//                 / future "GUN" / "GBU" / etc). Lets us introduce new
//                 munition records without the combat code having to
//                 know about every variant — a new AIM-120 variant
//                 just uses simType: "AIM-120".
// ============================================================================

const _munitionModules = import.meta.glob('../data/munitions/*.json', { eager: true });

export const MUNITIONS = (() => {
	const out = {};
	const entries = Object.entries(_munitionModules).sort((a, b) => a[0].localeCompare(b[0]));
	for (const [path, mod] of entries) {
		const raw = mod.default || mod;
		const fallbackId = path.match(/\/([^/]+)\.json$/)?.[1];
		const id = raw.id || fallbackId;
		if (!id) continue;
		out[id] = raw;
	}
	return out;
})();

// Return all munitions a given hardpoint accepts. Used by the loadout
// UI when populating the dropdown for one slot.
export function munitionsForHardpoint(hardpoint) {
	if (!hardpoint || !Array.isArray(hardpoint.accepts)) return [];
	const accepted = new Set(hardpoint.accepts);
	return Object.values(MUNITIONS).filter(m => accepted.has(m.category));
}

export function isCompatible(hardpoint, munition) {
	if (!hardpoint || !munition) return false;
	if (!Array.isArray(hardpoint.accepts)) return false;
	return hardpoint.accepts.includes(munition.category);
}
