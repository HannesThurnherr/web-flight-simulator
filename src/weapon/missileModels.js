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

// Rotate + scale + centre the glTF scene so the missile's long axis lies
// along +Y and the model measures exactly `realLengthM` along that axis.
function _normalizeMissileModel(gltfScene, realLengthM) {
	const wrapper = new THREE.Group();
	wrapper.add(gltfScene);

	// Pass 1: orient. Detect which axis is currently the long axis and
	// rotate so it becomes +Y. (+Y is the convention missile.updateThreeMatrix
	// bakes as world-forward.)
	gltfScene.updateMatrixWorld(true);
	const box = new THREE.Box3().setFromObject(gltfScene);
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

	// Pass 2: scale. Remeasure after rotation, then uniformly scale so
	// the new +Y extent equals the real missile length.
	gltfScene.updateMatrixWorld(true);
	const box2 = new THREE.Box3().setFromObject(gltfScene);
	const size2 = new THREE.Vector3();
	box2.getSize(size2);
	const longest = Math.max(size2.x, size2.y, size2.z, 0.01);
	const s = realLengthM / longest;
	wrapper.scale.setScalar(s);

	// Pass 3: centre along all three axes so the model sits around the
	// missile's body origin. The procedural meshes were centred on the
	// body centreline, so the flame/glow offsets (`-bodyLen/2`) are
	// referenced from there. Centring keeps those offsets correct.
	gltfScene.updateMatrixWorld(true);
	const box3 = new THREE.Box3().setFromObject(gltfScene);
	const centre = new THREE.Vector3();
	box3.getCenter(centre);
	// centre is in wrapper-local space (post-scale), divide by scale to
	// push the correction into the gltfScene's own coordinate frame.
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
// ~5.1 m long. Source bbox is symmetric on the long axis so we
// can't tell nose-end from bbox alone; default normalize first
// and revisit the rotation if it flies tail-first in-game.
_loader.load('/assets/models/storm-shadow.glb', (gltf) => {
	_templates['storm-shadow'] = _normalizeMissileModel(gltf.scene, 5.10);
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
