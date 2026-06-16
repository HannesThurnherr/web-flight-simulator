// ============================================================================
// Equipment catalog — non-weapon systems that mount in equipment slots
// (centerline / conformal / chin / internal), distinct from weapon pylons.
//
// Each item declares a `kind` that maps to a runtime subsystem instantiated
// in loadPlayerPlane.js:
//   jammer    → state.jammer (ECM, toggled with J)
//   tgp       → state.hasTgp (gates the targeting-pod UI + laser-guided wpns)
//   laser_pd  → state.equipment.laserPD (self-protect directed-energy)
//   irst      → merges config.ir into state.sensors.ir
//
// Auto-discovered from src/data/equipment/*.json exactly like munitions and
// platforms — dropping a JSON in registers it everywhere (catalog, loadout
// UI, persistence).
// ============================================================================

const _modules = import.meta.glob('../data/equipment/*.json', { eager: true });

export const EQUIPMENT = (() => {
	const out = {};
	const entries = Object.entries(_modules).sort((a, b) => a[0].localeCompare(b[0]));
	for (const [path, mod] of entries) {
		const raw = mod.default || mod;
		const fallbackId = path.match(/\/([^/]+)\.json$/)?.[1];
		const id = raw.id || fallbackId;
		if (!id) continue;
		if (!raw.kind) {
			console.warn('[equipment] item missing "kind":', id);
			continue;
		}
		out[id] = raw;
	}
	return out;
})();

// Items compatible with a given equipment slot (slot.accepts is a list of
// kinds, e.g. ['jammer','laser_pd']).
export function equipmentForSlot(slot) {
	if (!slot || !Array.isArray(slot.accepts)) return [];
	const accepted = new Set(slot.accepts);
	return Object.values(EQUIPMENT).filter((e) => accepted.has(e.kind));
}

export function isEquipmentCompatible(slot, item) {
	if (!slot || !item || !Array.isArray(slot.accepts)) return false;
	return slot.accepts.includes(item.kind);
}
