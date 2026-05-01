// ============================================================================
// Particle-cluster cloud field — Phase 9c first attempt.
//
// Spawns N sphere puffs at fixed lon/lat/alt positions across a wide
// area, batched into a few altitude bands. Each puff renders the same
// way contrails / explosion smoke does: anchored in ECEF, baked into
// camera-space via Cesium's viewMatrix every frame, billboarded by
// composing with the THREE camera's identity transform. Fits the
// existing renderer like a glove — no postprocessing, no shaders, no
// EffectComposer — just THREE meshes that update through the same
// path everything else uses.
//
// Look: from cruise altitude (8 km) the field is below you, broken
// patches of cumulus drifting past. From low altitude they're above
// you. From WVR ranges (a few km) they read as sparse not dense (we
// can't afford 10k puffs), but at BVR scale where most of the action
// happens this looks plausibly cloud-shaped against blue sky.
//
// Knobs at the top — tune until it feels right.
// ============================================================================
import * as THREE from 'three';
import * as Cesium from 'cesium';

// ---- Tuneables -------------------------------------------------------------
// Field is centred on the player at scenario start and laid out in a
// regular grid with random per-cell jitter. Total puff count =
// CELLS × CELLS × PUFFS_PER_CELL; keep it bounded.
const CELLS              = 24;       // grid resolution per side
const FIELD_HALF_SIZE_M  = 80000;    // half-extent of the field (m)
const PUFFS_PER_CELL     = 3;        // smaller = more performant, sparser
const CELL_JITTER_M      = 1500;     // random offset per cell, in metres
// Altitude bands. Cumulus is typically 1.5–2 km base, towers up to
// 5-6 km. Cirrus is 8-12 km but visually different — punted for now.
const BANDS = [
	{ altMin: 1500, altMax: 2200, radiusMin: 60, radiusMax: 140, density: 1.0 },
	{ altMin: 3000, altMax: 4200, radiusMin: 80, radiusMax: 200, density: 0.6 },
];
// Visual.
const COLOR_BASE   = 0xfafcff;
const COLOR_SHADOW = 0xb6c4d0;
const OPACITY_PEAK = 0.85;

// Cell index → 0/1 hash so the same lon/lat band placement reroll
// gives the same look. Bonus: lets us reseed the field with a
// scenario seed later.
function _hash(i, j, k) {
	let h = i * 374761393 + j * 668265263 + k * 1013904223;
	h = (h ^ (h >>> 13)) * 1274126177;
	return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export class CloudField {
	constructor(scene, viewer, centerLon, centerLat) {
		this.scene  = scene;
		this.viewer = viewer;
		this.puffs  = [];
		this._scratchCart   = new Cesium.Cartesian3();
		this._scratchMatrix = new Cesium.Matrix4();
		this._scratchCam    = new Cesium.Matrix4();
		this._scratchThree  = new THREE.Matrix4();
		this._scaleVec      = new THREE.Vector3();
		this._build(centerLon, centerLat);
	}

	_build(centerLon, centerLat) {
		const latRad = centerLat * Math.PI / 180;
		const cellSize = (2 * FIELD_HALF_SIZE_M) / CELLS;
		// One MeshBasicMaterial shared per band so we get instancing-
		// friendly batching when THREE sorts the scene. opacity is
		// per-material; per-puff variance is via per-puff scale.
		// Material reuse trades a small amount of per-puff variety
		// for a lot of GPU state-change savings.
		const matBase = new THREE.MeshBasicMaterial({
			color:       COLOR_BASE,
			transparent: true,
			opacity:     OPACITY_PEAK,
			depthWrite:  false,
		});
		// Each band gets a slightly different tint — bottoms a touch
		// shadowed, tops bright.
		const matsPerBand = BANDS.map((b, idx) => {
			const m = matBase.clone();
			const tint = idx === 0 ? 0xddd8d4 : 0xfafcff;
			m.color = new THREE.Color(tint);
			return m;
		});

		for (let bi = 0; bi < BANDS.length; bi++) {
			const band = BANDS[bi];
			const mat  = matsPerBand[bi];
			for (let cy = 0; cy < CELLS; cy++) {
				for (let cx = 0; cx < CELLS; cx++) {
					const r0 = _hash(cx, cy, bi * 7);
					if (r0 > band.density) continue;
					for (let p = 0; p < PUFFS_PER_CELL; p++) {
						const r1 = _hash(cx, cy, bi * 7 + p * 11 + 1);
						const r2 = _hash(cx, cy, bi * 7 + p * 11 + 2);
						const r3 = _hash(cx, cy, bi * 7 + p * 11 + 3);
						const r4 = _hash(cx, cy, bi * 7 + p * 11 + 4);
						const dE = (cx + 0.5 - CELLS / 2) * cellSize
							+ (r1 - 0.5) * 2 * CELL_JITTER_M;
						const dN = (cy + 0.5 - CELLS / 2) * cellSize
							+ (r2 - 0.5) * 2 * CELL_JITTER_M;
						const alt = band.altMin + r3 * (band.altMax - band.altMin);
						const radius = band.radiusMin + r4 * (band.radiusMax - band.radiusMin);
						const lon = centerLon + dE / (111320 * Math.cos(latRad));
						const lat = centerLat + dN / 111320;
						this._spawnPuff(lon, lat, alt, radius, mat);
					}
				}
			}
		}
		// eslint-disable-next-line no-console
		console.log('[CloudField] spawned puffs:', this.puffs.length);
		void COLOR_SHADOW;     // kept for future band tinting
	}

	_spawnPuff(lon, lat, alt, radius, sharedMaterial) {
		// Low-poly sphere — clouds are blobs, no one's measuring
		// triangles. 8×6 = 36 tris, fine for a few thousand puffs.
		const geom = new THREE.SphereGeometry(radius, 8, 6);
		const puff = new THREE.Mesh(geom, sharedMaterial);
		puff.lon = lon;
		puff.lat = lat;
		puff.alt = alt;
		puff.matrixAutoUpdate = false;
		this.scene.add(puff);
		this.puffs.push(puff);
	}

	// Re-bake matrices against the current Cesium camera. Call once
	// per frame from animateLoop, before renderer.render(scene). Same
	// pattern as particles.update / contrail._ageExisting.
	update() {
		if (!this.viewer || !this.viewer.camera) return;
		const viewMatrix = this.viewer.camera.viewMatrix;
		for (const t of this.puffs) {
			const pos = Cesium.Cartesian3.fromDegrees(t.lon, t.lat, t.alt, undefined, this._scratchCart);
			const enuMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(pos, undefined, this._scratchMatrix);
			const camSpace  = Cesium.Matrix4.multiply(viewMatrix, enuMatrix, this._scratchCam);
			for (let j = 0; j < 16; j++) this._scratchThree.elements[j] = camSpace[j];
			t.matrix.copy(this._scratchThree);
			t.updateMatrixWorld(true);
		}
	}

	dispose() {
		for (const t of this.puffs) {
			this.scene.remove(t);
			if (t.geometry) t.geometry.dispose();
			// Materials are shared per band — disposing them per puff
			// would dispose the band material multiple times. Skip;
			// disposing the field is rare anyway.
		}
		this.puffs.length = 0;
	}
}
