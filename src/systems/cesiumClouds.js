// ============================================================================
// Cesium-native cloud field — Phase 9c attempt #2.
//
// Uses Cesium's built-in CloudCollection + CumulusCloud primitives.
// Pros vs the THREE-side particle-cluster attempt:
//   - Properly depth-tested against the globe — terrain occludes
//     clouds, you can fly behind a ridge and they're hidden.
//   - Billboarded soft-edged sprites (Cesium ships with a cumulus
//     texture), not flat spheres. Reads as cloud-shaped at any
//     distance.
//   - Lit by Cesium's atmosphere model (sun direction, scattering),
//     so dawn / dusk colours come for free.
//   - ~0 main-thread cost — Cesium uploads once, GPU draws as
//     billboards.
//
// We just place ~N cumulus blobs across a wide area at altitude
// bands; Cesium handles the rest. CloudCollection takes
// CumulusCloud entries with `position` (Cartesian3), `scale`,
// `maximumSize`, `slice`. Defaults give a passable cumulus look;
// random per-cloud variance gives a natural distribution.
// ============================================================================
import * as Cesium from 'cesium';

const FIELD_HALF_SIZE_M = 80000;        // half-extent of the spawn area
const COUNT_BAND_LOW    = 220;          // cumulus base population
const COUNT_BAND_MID    = 80;           // smaller mid-altitude population
const ALT_BAND_LOW_MIN  = 1400;
const ALT_BAND_LOW_MAX  = 2100;
const ALT_BAND_MID_MIN  = 3200;
const ALT_BAND_MID_MAX  = 4200;
const SCALE_MIN         = 600;          // metres — Cesium scales billboard accordingly
const SCALE_MAX         = 2400;
const MAXSIZE_MIN       = 600;
const MAXSIZE_MAX       = 1500;
const SLICE_MIN         = 0.3;
const SLICE_MAX         = 0.7;

// Hash to a [0,1) — same trick as cloudField.js, deterministic per
// (i, salt). Lets us seed off scenario start coords later.
function _hash(i, salt) {
	let h = (i + 1) * 374761393 + salt * 668265263;
	h = (h ^ (h >>> 13)) * 1274126177;
	return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export class CesiumCloudField {
	constructor(viewer, centerLon, centerLat) {
		this.viewer = viewer;
		this.collection = viewer.scene.primitives.add(new Cesium.CloudCollection({
			noiseDetail: 8.0,
			noiseOffset: new Cesium.Cartesian3(0, 0, 0),
		}));
		this._build(centerLon, centerLat);
	}

	_addBand(centerLon, centerLat, count, altMin, altMax, salt) {
		const latRad = centerLat * Math.PI / 180;
		const cosLat = Math.cos(latRad) || 1;
		for (let i = 0; i < count; i++) {
			// Two random rolls per axis so clouds clump rather than
			// distribute uniformly — gives a more natural broken-
			// scattered pattern than pure white-noise placement.
			const r1 = _hash(i, salt + 1);
			const r2 = _hash(i, salt + 2);
			const r3 = _hash(i, salt + 3);
			const r4 = _hash(i, salt + 4);
			const r5 = _hash(i, salt + 5);
			const r6 = _hash(i, salt + 6);
			const dE = ((r1 + r2) - 1.0) * FIELD_HALF_SIZE_M;
			const dN = ((r3 + r4) - 1.0) * FIELD_HALF_SIZE_M;
			const alt = altMin + r5 * (altMax - altMin);
			const lon = centerLon + dE / (111320 * cosLat);
			const lat = centerLat + dN / 111320;
			const scale = SCALE_MIN + r6 * (SCALE_MAX - SCALE_MIN);
			const maxSize = MAXSIZE_MIN + r6 * (MAXSIZE_MAX - MAXSIZE_MIN);
			const slice = SLICE_MIN + _hash(i, salt + 7) * (SLICE_MAX - SLICE_MIN);
			this.collection.add({
				position: Cesium.Cartesian3.fromDegrees(lon, lat, alt),
				scale: new Cesium.Cartesian2(scale, scale * 0.6),
				maximumSize: new Cesium.Cartesian3(maxSize, maxSize * 0.7, maxSize * 0.5),
				slice,
			});
		}
	}

	_build(centerLon, centerLat) {
		this._addBand(centerLon, centerLat, COUNT_BAND_LOW, ALT_BAND_LOW_MIN, ALT_BAND_LOW_MAX, 100);
		this._addBand(centerLon, centerLat, COUNT_BAND_MID, ALT_BAND_MID_MIN, ALT_BAND_MID_MAX, 200);
		// eslint-disable-next-line no-console
		console.log('[CesiumClouds] spawned', this.collection.length, 'cumulus billboards');
	}

	dispose() {
		if (this.collection && this.viewer && this.viewer.scene) {
			this.viewer.scene.primitives.remove(this.collection);
		}
		this.collection = null;
	}
}
