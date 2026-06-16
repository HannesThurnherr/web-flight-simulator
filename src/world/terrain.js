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
