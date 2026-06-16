// ============================================================================
// Equipment loadout state — per-plane equipment-slot → equipment-item map.
//
// Parallel to loadout.js (weapons), but for equipment slots: jammer pods,
// targeting pods, defensive lasers, IRST pods, etc. Shape per plane:
//   { [slotId]: equipmentId | null }
//
// Persisted in localStorage under its own key so it survives reload but is
// part of the "configure your jet" decision, same lifecycle as weapons.
// ============================================================================
import { PLANES } from './planes.js';
import { EQUIPMENT, isEquipmentCompatible } from '../systems/equipment.js';

const STORAGE_KEY = 'flightsim.equipment';

let _equip = {};

function _load() {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) _equip = JSON.parse(raw) || {};
	} catch (e) { _equip = {}; }
}
function _save() {
	try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_equip)); }
	catch (e) { /* quota / disabled storage — not fatal */ }
}
_load();

// Return the equipment loadout for a plane. Default = empty slots (the
// player opts into equipment deliberately; no auto-fill).
export function getEquipmentLoadout(planeId) {
	if (_equip[planeId]) return _equip[planeId];
	const plane = PLANES[planeId];
	const lo = {};
	if (plane && Array.isArray(plane.equipmentSlots)) {
		for (const slot of plane.equipmentSlots) lo[slot.id] = _defaultEquipmentFor(slot);
	}
	_equip[planeId] = lo;
	_save();
	return lo;
}

// Default a TGP into the first slot that accepts one, so laser-guided
// weapons keep working out of the box (the old "every plane has a pod"
// behavior). Everything else (jammer, laser, IRST) is opt-in.
function _defaultEquipmentFor(slot) {
	if (slot.accepts && slot.accepts.includes('tgp') && EQUIPMENT['litening-tgp']) {
		return 'litening-tgp';
	}
	return null;
}

export function setEquipmentSlot(planeId, slotId, equipmentId) {
	const lo = getEquipmentLoadout(planeId);
	lo[slotId] = (equipmentId == null || equipmentId === '') ? null : equipmentId;
	_save();
}

// True if any slot holds an item of the given kind.
export function hasEquipmentKind(planeId, kind) {
	const plane = PLANES[planeId];
	if (!plane || !Array.isArray(plane.equipmentSlots)) return false;
	const lo = getEquipmentLoadout(planeId);
	for (const slot of plane.equipmentSlots) {
		const item = EQUIPMENT[lo[slot.id]];
		if (item && item.kind === kind) return true;
	}
	return false;
}

// Ordered list of the equipped items (skips empty slots, dedup not applied —
// two of the same pod is allowed and additive where it makes sense).
export function equippedItems(planeId) {
	const plane = PLANES[planeId];
	if (!plane || !Array.isArray(plane.equipmentSlots)) return [];
	const lo = getEquipmentLoadout(planeId);
	const out = [];
	for (const slot of plane.equipmentSlots) {
		const item = EQUIPMENT[lo[slot.id]];
		if (item && isEquipmentCompatible(slot, item)) out.push({ slot, item });
	}
	return out;
}

export function equipmentMassKg(planeId) {
	let w = 0;
	for (const { item } of equippedItems(planeId)) {
		if (typeof item.massKg === 'number') w += item.massKg;
	}
	return w;
}

export function equipmentRcsM2(planeId) {
	let sum = 0;
	for (const { item } of equippedItems(planeId)) {
		if (typeof item.rcsContributionM2 === 'number') sum += item.rcsContributionM2;
	}
	return sum;
}
