// ============================================================================
// Plane registry — data-driven. Each airframe lives in its own JSON file
// under src/data/planes/; adding a new one is a single-file drop-in
// (plus the GLB mesh in public/assets/models/). Vite's import.meta.glob
// resolves the directory at build time so the registry stays current
// automatically.
//
// The runtime objects the rest of the sim consumes are POST-PROCESSED
// from the JSON to turn editor-friendly forms into the types the engine
// wants. Specifically:
//   - modelRotation is written in DEGREES in JSON; the engine needs
//     RADIANS. We convert once on load.
//   - hideNodes entries can be {type:"exact", name:"..."} or
//     {type:"regex", pattern:"...", flags:"i"}. Converted to strings
//     and RegExp objects respectively, matching the shape main.js
//     already expects.
// Any other fields are copied through verbatim — thrust multipliers,
// mass, wingArea, controlCoef, specs, etc. Keep them numeric and JSON
// expressible in the source files.
//
// Same pattern will host src/data/munitions/ later, via a parallel
// glob-import. Identical shape: one JSON per item, auto-discovery.
// ============================================================================

// Import every JSON in the planes data directory. `eager: true` makes
// Vite bundle them directly (not async) so we can read them synchronously
// here. The map key is the path, value is the parsed module.
const _planeModules = import.meta.glob('../data/planes/*.json', { eager: true });

function degToRad(deg) {
	return (deg == null ? 0 : deg) * Math.PI / 180;
}

function postProcess(raw) {
	const plane = { ...raw };
	// Rotation: degrees → radians. Authoring in degrees is easier to
	// reason about and keeps JSON files free of math.
	if (plane.modelRotation) {
		const r = plane.modelRotation;
		plane.modelRotation = {
			x: degToRad(r.x),
			y: degToRad(r.y),
			z: degToRad(r.z),
		};
	}
	// hideNodes: accept either a plain string (exact match), or an
	// object descriptor. Convert to the runtime form main.js expects
	// (string | RegExp).
	if (Array.isArray(plane.hideNodes)) {
		plane.hideNodes = plane.hideNodes.map((h) => {
			if (typeof h === 'string') return h;
			if (h && h.type === 'regex') return new RegExp(h.pattern, h.flags || '');
			if (h && h.type === 'exact') return h.name;
			return h;
		});
	}
	return plane;
}

// Build the registry keyed by the `id` field of each JSON (falling
// back to the filename stem). Sorting by filename gives deterministic
// iteration order — planes appear in the menu in the order "f-15,
// f-22, f-35" naturally.
export const PLANES = (() => {
	const out = {};
	const entries = Object.entries(_planeModules).sort(
		(a, b) => a[0].localeCompare(b[0]),
	);
	for (const [path, mod] of entries) {
		const raw = mod.default || mod;
		const fallbackId = path.match(/\/([^/]+)\.json$/)?.[1];
		const processed = postProcess(raw);
		const id = processed.id || fallbackId;
		if (!id) continue;
		out[id] = processed;
	}
	return out;
})();

// Selected plane id. Same pattern as scenarios: a module-level slot
// with getter / setter. Default on first load is whichever plane
// Object.entries yields first (deterministic per above sort).
let _activeId = Object.keys(PLANES)[0] || null;

export function setActivePlane(id) {
	if (PLANES[id]) _activeId = id;
}
export function getActivePlane() {
	return PLANES[_activeId];
}
export function getActivePlaneId() {
	return _activeId;
}
