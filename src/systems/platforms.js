// ============================================================================
// Platforms registry — AI-only entities in the world that aren't
// player-selectable airframes: AWACS, tankers, ground SAMs, ground
// radars, ships, airbases-as-targets, etc.
//
// Parallel structure to src/plane/planes.js. Drop a JSON in
// src/data/platforms/ and it appears in the registry.
//
// Common fields:
//   id / name                     identity
//   kind                          "airborne" | "ground" | "surface" | "subsurface"
//   model / modelRotation         visuals (rotation in DEGREES in JSON)
//   signature                     SIGNATURES key for sensor detection
//   sensors                       { radar, ir, eyeball } configs
//                                  - angles authored in DEGREES (fovHalf*),
//                                    auto-converted to radians on load
//   pilot                         { type, defaultParams } — dispatched by
//                                 npcSystem when spawning. Strategy types:
//                                   "orbit"    — circular pattern (AWACS)
//                                   "patrol"   — waypoint list (future)
//                                   "static"   — stationary (SAM, radar)
//                                   "fighter"  — full combat AI
//   physicsOverrides              same patch shape as PlanePhysics.applyOverrides
// ============================================================================

const _modules = import.meta.glob('../data/platforms/*.json', { eager: true });

function degToRad(d) { return (d == null ? 0 : d) * Math.PI / 180; }

function postProcess(raw) {
	const p = JSON.parse(JSON.stringify(raw)); // deep copy so mutations don't leak into the module cache
	if (p.modelRotation) {
		p.modelRotation = {
			x: degToRad(p.modelRotation.x),
			y: degToRad(p.modelRotation.y),
			z: degToRad(p.modelRotation.z),
		};
	}
	// Radar FOV authored in degrees (more human-readable); convert to
	// radians to match the runtime shape sensorSystem.detectRadar expects.
	if (p.sensors?.radar) {
		const r = p.sensors.radar;
		if (r.fovHalfHDeg != null) r.fovH = degToRad(r.fovHalfHDeg);
		if (r.fovHalfVDeg != null) r.fovV = degToRad(r.fovHalfVDeg);
	}
	return p;
}

export const PLATFORMS = (() => {
	const out = {};
	const entries = Object.entries(_modules).sort((a, b) => a[0].localeCompare(b[0]));
	for (const [path, mod] of entries) {
		const raw = mod.default || mod;
		const id = raw.id || path.match(/\/([^/]+)\.json$/)?.[1];
		if (!id) continue;
		out[id] = postProcess(raw);
	}
	return out;
})();

export function getPlatform(id) {
	return PLATFORMS[id] || null;
}
