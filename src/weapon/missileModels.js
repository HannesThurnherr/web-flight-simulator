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

const _templates = { aim9: null, aim120: null };

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

// Return a fresh clone of the aim-9 template, or null if the GLB hasn't
// landed yet. Callers fall back to a procedural build when null.
export function cloneAim9Template() {
	return _templates.aim9 ? _templates.aim9.clone(true) : null;
}

export function cloneAim120Template() {
	return _templates.aim120 ? _templates.aim120.clone(true) : null;
}
