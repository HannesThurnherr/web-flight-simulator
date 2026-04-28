// ============================================================================
// Missile GLB loader + orientation/scale normalizer.
//
// Both the IR Missile (AIM-9X) and the AIM120 subclass (AIM-120D) used to
// build their bodies from procedural THREE geometry — cylinder + cone +
// fins. This module swaps that out for real GLB scans.
//
// Problem the normalizer solves: GLBs are authored with arbitrary scale
// and axis convention. One model is 2 m long along +Z, another is 0.3
// units long along +X, etc. The simulation, by convention, wants the
// missile's nose-forward axis along +Y (that's what the missile's mesh-
// transform bake in missile.js expects — see finalModelMatrix[4]).
//
// So on load we:
//   1. Measure the model's bounding box.
//   2. Rotate so the longest axis aligns with +Y.
//   3. Uniformly scale so the longest axis equals the real-world missile
//      length (AIM-9X = 3.02 m, AIM-120D = 3.66 m).
//   4. Centre the model on its midpoint so the missile body-frame origin
//      matches the procedural mesh's origin (roughly the centre of mass).
//
// The normalized wrapper is cloned per-missile. If the GLB is still in
// flight when the missile is constructed, the missile builds its old
// procedural mesh instead and carries on — first few shots at boot-time
// fall back gracefully rather than failing or stalling.
// ============================================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const _templates = {
	aim9: null, aim120: null, meteor: null,
	'agm-88': null,
	'gbu-12': null,
	'jdam-31': null, 'jdam-38': null,
	'agm-86': null, 'storm-shadow': null,
};

// Some Sketchfab GLBs ship with junk meshes far from the body
// (warning-decal placards baked at 10+ m offsets, debug bounding
// envelopes, etc.). The default Box3.setFromObject unions ALL of
// them and reports a wildly oversized envelope, which then makes
// the scale + centring pass fit phantom space and leave the
// actual body off to the side of the wrapper origin (and the
// flame consequently nowhere near the tail).
//
// Outlier-rejecting bbox: collect each leaf mesh's bbox center +
// radius, drop any mesh whose center is further than 4× the
// median radius from the median center. The body cluster
// dominates because there are several body meshes near origin
// and a handful of decals far away — the median lives in the
// body cluster, and the decals get filtered. Hides the rejected
// meshes (sets visible=false) so they don't render either.
function _bboxIgnoringOutliers(gltfScene) {
	gltfScene.updateMatrixWorld(true);
	const meshes = [];
	gltfScene.traverse((obj) => {
		if (obj.isMesh && obj.geometry) {
			const b = new THREE.Box3().setFromObject(obj);
			if (b.isEmpty()) return;
			const c = b.getCenter(new THREE.Vector3());
			const s = b.getSize(new THREE.Vector3());
			meshes.push({ obj, bbox: b, center: c, radius: s.length() / 2 });
		}
	});
	if (meshes.length === 0) {
		// Fallback: nothing to filter, return naive bbox.
		return new THREE.Box3().setFromObject(gltfScene);
	}
	if (meshes.length <= 2) {
		// Too few meshes to have a meaningful "median" — trust them
		// all and return the union.
		const b = new THREE.Box3();
		for (const m of meshes) b.union(m.bbox);
		return b;
	}
	// Median center along each axis (more robust than mean against
	// the very outliers we're trying to reject).
	const sortAxis = (axis) => meshes.map(m => m.center[axis]).sort((a, b) => a - b);
	const median = (arr) => arr[Math.floor(arr.length / 2)];
	const medCenter = new THREE.Vector3(
		median(sortAxis('x')),
		median(sortAxis('y')),
		median(sortAxis('z')),
	);
	const radii = meshes.map(m => m.radius).sort((a, b) => a - b);
	const medRadius = Math.max(0.01, median(radii));
	const cutoff = 4 * medRadius;

	const keep = new THREE.Box3();
	let kept = 0;
	let rejected = 0;
	for (const m of meshes) {
		const d = m.center.distanceTo(medCenter);
		if (d > cutoff) {
			m.obj.visible = false;
			rejected++;
		} else {
			keep.union(m.bbox);
			kept++;
		}
	}
	if (rejected > 0) {
		console.log(`[missileModels] outlier filter kept ${kept}, rejected ${rejected} meshes`);
	}
	return keep.isEmpty() ? new THREE.Box3().setFromObject(gltfScene) : keep;
}

// Rotate + scale + centre the glTF scene so the missile's long axis lies
// along +Y and the model measures exactly `realLengthM` along that axis.
function _normalizeMissileModel(gltfScene, realLengthM) {
	const wrapper = new THREE.Group();
	wrapper.add(gltfScene);

	// Pass 1: orient. Detect which axis is currently the long axis and
	// rotate so it becomes +Y. (+Y is the convention missile.updateThreeMatrix
	// bakes as world-forward.) Use the outlier-filtered bbox so phantom
	// decal meshes don't decide our long axis.
	gltfScene.updateMatrixWorld(true);
	const box = _bboxIgnoringOutliers(gltfScene);
	const size = new THREE.Vector3();
	box.getSize(size);
	if (size.z >= size.x && size.z >= size.y) {
		// +Z is long → rotate around X so +Z maps to +Y.
		gltfScene.rotation.x = -Math.PI / 2;
	} else if (size.x >= size.y && size.x >= size.z) {
		// +X is long → rotate around Z so +X maps to +Y.
		gltfScene.rotation.z = Math.PI / 2;
	}
	// else +Y is already long — no rotation needed.

	// Pass 2: scale. Remeasure (filtered) after rotation, then
	// uniformly scale so the long axis equals the real missile length.
	gltfScene.updateMatrixWorld(true);
	const box2 = _bboxIgnoringOutliers(gltfScene);
	const size2 = new THREE.Vector3();
	box2.getSize(size2);
	const longest = Math.max(size2.x, size2.y, size2.z, 0.01);
	const s = realLengthM / longest;
	wrapper.scale.setScalar(s);

	// Pass 3: centre using the filtered bbox so the wrapper origin
	// sits on the BODY's centroid, not on the union of body + phantom
	// decals. Flame offsets (`-bodyLen/2`) reference this origin.
	gltfScene.updateMatrixWorld(true);
	const box3 = _bboxIgnoringOutliers(gltfScene);
	const centre = new THREE.Vector3();
	box3.getCenter(centre);
	gltfScene.position.sub(centre.divideScalar(s));

	return wrapper;
}

// Kick off both loads at module import. They're independent so we fire
// them in parallel. Missiles constructed before the templates land just
// build their procedural fallback; once loaded, every subsequent missile
// uses the GLB.
const _loader = new GLTFLoader();
_loader.load('/assets/models/aim-9-missile.glb', (gltf) => {
	_templates.aim9 = _normalizeMissileModel(gltf.scene, 3.02);
	_templates.aim9.traverse((child) => {
		if (child.isMesh) {
			child.castShadow = true;
			child.receiveShadow = true;
		}
	});
}, undefined, (err) => {
	console.warn('[missileModels] aim-9 model failed to load', err);
});
_loader.load('/assets/models/aim-120-amraam.glb', (gltf) => {
	_templates.aim120 = _normalizeMissileModel(gltf.scene, 3.66);
	// AIM-120C GLB is authored tail-forward along its long axis, so
	// after normalization the nose ends up at -Y. Flip 180° around X
	// to point the nose in the sim's +Y forward direction.
	_templates.aim120.rotation.x = Math.PI;
	_templates.aim120.traverse((child) => {
		if (child.isMesh) {
			child.castShadow = true;
			child.receiveShadow = true;
		}
	});
}, undefined, (err) => {
	console.warn('[missileModels] aim-120 model failed to load', err);
});

// MBDA Meteor — same length class as AIM-120 (3.65 m), but distinctive
// silhouette: square-ish ramjet intakes mid-body. Visual identity matters
// for the player: a salvo with mixed AMRAAM + Meteor should be obviously
// mixed in the trail/spawn camera.
_loader.load('/assets/models/mbda-meteor.glb', (gltf) => {
	_templates.meteor = _normalizeMissileModel(gltf.scene, 3.65);
	_templates.meteor.traverse((child) => {
		if (child.isMesh) {
			child.castShadow = true;
			child.receiveShadow = true;
		}
	});
}, undefined, (err) => {
	console.warn('[missileModels] meteor model failed to load', err);
});

// AGM-88 HARM. Long body (4.17 m), prominent seeker dome — distinctive
// from AAMs in flight, helps the player visually track that an
// anti-radiation shot is in the air.
_loader.load('/assets/models/agm-88-harm.glb', (gltf) => {
	_templates['agm-88'] = _normalizeMissileModel(gltf.scene, 4.17);
	_templates['agm-88'].traverse((child) => {
		if (child.isMesh) {
			child.castShadow = true;
			child.receiveShadow = true;
		}
	});
}, undefined, (err) => {
	console.warn('[missileModels] agm-88 model failed to load', err);
});

// GBU-12 PAVEWAY II — dedicated GLB. 500 lb laser-guided iron bomb,
// distinct silhouette: round nose seeker dome, mid-body strakes,
// boxfin tail group.
_loader.load('/assets/models/gbu-12.glb', (gltf) => {
	_templates['gbu-12'] = _normalizeMissileModel(gltf.scene, 3.27);
	_templates['gbu-12'].traverse((child) => {
		if (child.isMesh) {
			child.castShadow = true;
			child.receiveShadow = true;
		}
	});
}, undefined, (err) => {
	console.warn('[missileModels] gbu-12 model failed to load', err);
});

// GBU-38 JDAM — dedicated GLB (500 lb War Thunder asset). Long
// axis is X in the source; bbox is asymmetric (-1.4 to +0.95 m)
// with the body+nose extending toward -X and the tail fins at +X.
// _normalizeMissileModel rotates X→Y, putting the nose at -Y;
// flip 180° around Z afterwards so the nose ends up at +Y (the
// engine's forward convention). If the rendered bomb ever flies
// tail-first, this is the line to revisit.
_loader.load('/assets/models/gbu-38-jdam.glb', (gltf) => {
	_templates['jdam-38'] = _normalizeMissileModel(gltf.scene, 2.36);
	_templates['jdam-38'].rotation.z = Math.PI;
	_templates['jdam-38'].traverse((child) => {
		if (child.isMesh) {
			child.castShadow = true;
			child.receiveShadow = true;
		}
	});
}, undefined, (err) => {
	console.warn('[missileModels] gbu-38-jdam model failed to load', err);
});

// GBU-31 JDAM (2000 lb) — no dedicated GLB yet, reuse the
// 500 lb GBU-38 mesh scaled up to the 2000 lb body length
// (3.84 m). Same orientation handling as the 38.
_loader.load('/assets/models/gbu-38-jdam.glb', (gltf) => {
	_templates['jdam-31'] = _normalizeMissileModel(gltf.scene, 3.84);
	_templates['jdam-31'].rotation.z = Math.PI;
	_templates['jdam-31'].traverse((child) => {
		if (child.isMesh) {
			child.castShadow = true;
			child.receiveShadow = true;
		}
	});
}, undefined, (err) => {
	console.warn('[missileModels] gbu-31-jdam (reuse) failed to load', err);
});

// AGM-86 ALCM — Boeing air-launched cruise missile, ~6.3 m long,
// turbofan-cruise + small wings. Source GLB has its long axis on
// X with the asymmetric body extending toward -X; same nose-end
// flip pattern as the JDAM.
_loader.load('/assets/models/agm-86.glb', (gltf) => {
	_templates['agm-86'] = _normalizeMissileModel(gltf.scene, 6.32);
	_templates['agm-86'].rotation.z = Math.PI;
	_templates['agm-86'].traverse((child) => {
		if (child.isMesh) {
			child.castShadow = true;
			child.receiveShadow = true;
		}
	});
}, undefined, (err) => {
	console.warn('[missileModels] agm-86 model failed to load', err);
});

// Storm Shadow / SCALP-EG — JASSM-class stealth cruise missile,
// ~5.1 m long. The source GLB lands belly-up after normalize;
// roll +90° about the long axis (+Y after normalize) to right
// the airframe.
_loader.load('/assets/models/storm-shadow.glb', (gltf) => {
	_templates['storm-shadow'] = _normalizeMissileModel(gltf.scene, 5.10);
	_templates['storm-shadow'].rotation.y = Math.PI / 2;
	_templates['storm-shadow'].traverse((child) => {
		if (child.isMesh) {
			child.castShadow = true;
			child.receiveShadow = true;
		}
	});
}, undefined, (err) => {
	console.warn('[missileModels] storm-shadow model failed to load', err);
});

// Return a fresh clone of the aim-9 template, or null if the GLB hasn't
// landed yet. Callers fall back to a procedural build when null.
export function cloneAim9Template() {
	return _templates.aim9 ? _templates.aim9.clone(true) : null;
}

export function cloneAim120Template() {
	return _templates.aim120 ? _templates.aim120.clone(true) : null;
}

// Generic dispatch keyed on the munition JSON's `modelTemplate` field.
// Used by AIM120-class missiles whose data points at a non-default
// shape ("meteor"). Falls back to the AIM-120 template when the named
// template isn't loaded yet so first-frame-after-boot shots still
// render *something* recognisable.
export function cloneMissileTemplate(name) {
	const t = _templates[name];
	if (t) return t.clone(true);
	if (_templates.aim120) return _templates.aim120.clone(true);
	return null;
}
