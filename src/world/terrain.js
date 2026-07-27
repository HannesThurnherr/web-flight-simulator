// ============================================================================
// Ground-height lookup — one place to ask "how high is the terrain here?"
//
// Everything that needs to sit a unit on the ground, or keep a projectile
// from spawning inside it, should read from HERE so they all agree. The
// authoritative source is `globe.getHeight()` (the height of the currently
// loaded tile) — the SAME source the missile/bullet terrain-collision check
// reads — so a unit clamped through this helper can never end up below the
// terrain a missile it launches will collide against.
//
// getHeight() only returns a value for tiles already streamed in; far from
// the camera it returns undefined. Callers that have a more-detailed async
// sample (Cesium.sampleTerrainMostDetailed, fired at spawn) pass it as
// `floor`, and we return the HIGHER of the two — so the unit clears whichever
// terrain a later collision check might see, even mid-LOD-transition.
// ============================================================================

import * as Cesium from 'cesium';

const _carto = new Cesium.Cartographic();

// Best-effort ground elevation (metres) at a geographic point. Returns
// `floor` (default null) when no tile is loaded there yet.
export function groundHeightAt(viewer, lon, lat, floor = null) {
	const globe = viewer && viewer.scene && viewer.scene.globe;
	if (!globe) return floor;
	Cesium.Cartographic.fromDegrees(lon, lat, undefined, _carto);
	const g = globe.getHeight(_carto);
	if (g === undefined || g === null) return floor;
	return (floor != null) ? Math.max(g, floor) : g;
}

// ============================================================================
// Sea / land classification for surface (ship) units.
//
// There is no bathymetry / ocean API in Cesium World Terrain — `getHeight()`
// returns the height of the *rendered surface*, which over open ocean is the
// (geoid-following) sea surface and over land is the terrain. Two consequences
// drive the helpers below:
//
//   1. The ocean surface is NOT a clean 0 m everywhere — geoid undulation
//      means it can read anywhere from ~-100 m to ~+85 m vs the WGS84
//      ellipsoid. So a ship is clamped to `seaSurfaceHeightAt()` (the actual
//      rendered surface) rather than a hardcoded 0, which keeps the hull
//      sitting ON the visible water regardless of geoid.
//
//   2. "Is there land here?" can't use an absolute elevation threshold for the
//      same reason (a +30 m geoid bump over deep ocean would read as "land").
//      Instead we compare a sampled point against the ship's *local sea
//      reference* and call it land only when it rises LAND_RISE_M above it.
//      This is robust to geoid because both numbers come from the same source.
// ============================================================================

// How far a sampled point must rise above the local sea reference before we
// treat it as a coastline / shoal to steer away from. ~20 m clears wave/LOD
// noise and small geoid gradients while still catching real shorelines well
// before a ship reaches them.
export const LAND_RISE_M = 20;

// ---- THE sea reference -----------------------------------------------------
// Every consumer that needs "where is the water here" must call this and only
// this: ship hull clamping, the waterline clip plane, ship-launched munition
// spawn altitude, the sea-skimmer seeker's skim datum, and the sinking
// animation. They used to each keep their own copy with their own fallback,
// and the fallbacks disagreed — most destructively `?? 0`, which is the WGS84
// ellipsoid and therefore ~40 m below the actual water over the Ionian. A ship
// holding one reference while the round it just fired held another is how a
// whole Harpoon salvo ended up spawning underwater and detonating on launch.
//
// Unlike land, the sea is a smooth global field: the geoid moves roughly a
// metre per 10 km. That makes a remembered sample from anywhere nearby an
// excellent stand-in for an unstreamed one — accurate to a couple of metres,
// against the ~40 m error of substituting zero. So this NEVER invents a value:
// it returns a real measurement, a nearby real measurement, or the last real
// measurement seen anywhere. Only before the very first successful sample in a
// session can it return null, and callers must hold their previous state then
// rather than assume a number.
//
// Deliberately NOT used for land / terrain collision: those need the exact
// local height and must keep reading groundHeightAt, where an unstreamed tile
// correctly yields "unknown" instead of a smoothed neighbour.
// CRITICAL: this must be STABLE over time, not merely consistent between
// callers. `globe.getHeight` returns the height of the tile currently rendered,
// and over open ocean that value swings violently as LOD streams in — measured
// in the Ionian: -137 m, then -19 m, then +20 m, settling at ~+25 m for the
// same coordinate over a few seconds. Every one of those jumps teleported the
// ships vertically and stranded in-flight sea-skimmers below the new surface,
// which detonated them ("Harpoons splash on launch"). The rounds were flying a
// perfect 21 m skim the whole time; the sea rose through them.
//
// So the authority is an ASYNC most-detailed sample per cell, which is
// LOD-independent and therefore fixed. getHeight is used only as a provisional
// value until that resolves. Once a cell resolves it is never revised — the
// geoid does not move, and a stable slightly-wrong number is far safer here
// than an accurate one that jumps 100 m under a missile in flight.
const SEA_CELL_DEG = 0.5;              // ~55 km cells; geoid is flat at this scale
const _seaResolved = new Map();        // key -> authoritative height (never revised)
const _seaProvisional = new Map();     // key -> best getHeight seen so far
const _seaPending = new Set();
let _lastSeaSample = null;

function _seaKey(lon, lat) {
	return `${Math.round(lon / SEA_CELL_DEG)},${Math.round(lat / SEA_CELL_DEG)}`;
}

// Fire the one-time authoritative sample for a cell. Sampled at the cell
// CENTRE so every caller inside the cell converges on the identical number.
function _resolveSeaCell(viewer, key, lon, lat) {
	if (_seaPending.has(key) || _seaResolved.has(key)) return;
	if (!Cesium.sampleTerrainMostDetailed || !viewer || !viewer.terrainProvider) return;
	_seaPending.add(key);
	const cLon = Math.round(lon / SEA_CELL_DEG) * SEA_CELL_DEG;
	const cLat = Math.round(lat / SEA_CELL_DEG) * SEA_CELL_DEG;
	try {
		Cesium.sampleTerrainMostDetailed(viewer.terrainProvider,
			[Cesium.Cartographic.fromDegrees(cLon, cLat)])
			.then((res) => {
				const h = res && res[0] && res[0].height;
				if (h != null && Number.isFinite(h)) {
					_seaResolved.set(key, h);
					_lastSeaSample = h;
				}
			})
			.catch(() => { /* leave provisional in place */ })
			.finally(() => { _seaPending.delete(key); });
	} catch (e) { _seaPending.delete(key); }
}

export function seaSurfaceHeightAt(viewer, lon, lat) {
	const key = _seaKey(lon, lat);
	const resolved = _seaResolved.get(key);
	if (resolved != null) return resolved;          // fixed for the rest of the session

	_resolveSeaCell(viewer, key, lon, lat);

	// Provisional: track getHeight, but keep the HIGHEST reading seen for this
	// cell. The LOD progression observed is garbage-low → true value, so the
	// running max converges upward on the truth and, crucially, never drops —
	// a falling reference is what kills rounds already in the air.
	const globe = viewer && viewer.scene && viewer.scene.globe;
	if (globe) {
		Cesium.Cartographic.fromDegrees(lon, lat, undefined, _carto);
		const g = globe.getHeight(_carto);
		if (g != null && Number.isFinite(g)) {
			const prev = _seaProvisional.get(key);
			const best = (prev == null) ? g : Math.max(prev, g);
			_seaProvisional.set(key, best);
			_lastSeaSample = best;
			return best;
		}
	}
	const prov = _seaProvisional.get(key);
	if (prov != null) return prov;
	return _lastSeaSample;               // null only before the first sample ever
}

// True when (lon,lat) reads as land relative to `seaRefH` (the ship's current
// sea-surface height). Unstreamed tiles return `undefined` from getHeight →
// we treat them as open water (false) so a ship over not-yet-loaded ocean
// doesn't hallucinate a coast and veer. Pass the ship's cached sea reference
// as `seaRefH`; if omitted we fall back to an absolute >LAND_RISE_M test.
export function isLandAt(viewer, lon, lat, seaRefH = null) {
	const globe = viewer && viewer.scene && viewer.scene.globe;
	if (!globe) return false;
	Cesium.Cartographic.fromDegrees(lon, lat, undefined, _carto);
	const h = globe.getHeight(_carto);
	if (h === undefined || h === null) return false; // unstreamed → assume sea
	const ref = (seaRefH != null) ? seaRefH : 0;
	return h > ref + LAND_RISE_M;
}
