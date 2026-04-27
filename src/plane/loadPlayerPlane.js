// ============================================================================
// Load (or reload) the player's plane model.
//
// Called once during initThree() with the default plane, and again from
// the plane selector when the user picks a different airframe before
// spawn. Wrapped as a function so the main-menu plane picker can swap
// the model without reinitialising the rest of the Three.js scene.
//
// Extracted from main.js. The caller supplies ctx with read/write
// access to: state, scene, planeModel, jetFlames (array mutated in
// place), physics, weaponSystem, mixer, BASE_PLANE_POS, visualOffset,
// hud, currentState. The loading-progress checkbox `loadingStatus.model`
// is flipped by this module so the main menu's START button enables
// once the airframe finishes loading.
// ============================================================================

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PlanePhysics } from './planePhysics';
import { JetFlame } from './jetFlame';
import { SIGNATURES } from '../systems/signatures';
import { FIGHTER_RADAR_DEFAULT, FIGHTER_IRST_DEFAULT } from '../systems/sensorSystem';
import { WeaponSystem } from '../systems/weaponSystem';
import { getViewer } from '../world/cesiumWorld';
import { soundManager } from '../utils/soundManager';
import { loadingStatus, updateLoadingUI } from '../ui/loadingUI';

export function loadPlayerPlane(plane, ctx) {
	const { state, scene, jetFlames, BASE_PLANE_POS, visualOffset } = ctx;

	// Tear down any existing model + flames + weapon system so we can
	// rebuild against the new airframe. The weapon system holds the
	// live ammo counts, but during the menu phase (the only time this
	// reload can happen) ammo is reset on spawn commit anyway.
	const oldPlaneModel = ctx.planeModel;
	if (oldPlaneModel) {
		scene.remove(oldPlaneModel);
		oldPlaneModel.traverse((child) => {
			if (child.geometry) child.geometry.dispose();
			if (child.material) {
				const mats = Array.isArray(child.material) ? child.material : [child.material];
				for (const m of mats) if (m && m.dispose) m.dispose();
			}
		});
		ctx.setPlaneModel(null);
	}
	jetFlames.length = 0;

	loadingStatus.model = false;
	updateLoadingUI(ctx.currentState);

	const loader = new GLTFLoader();
	loader.load(plane.model, (gltf) => {
		const mesh = gltf.scene;

		// Per-plane orientation from the registry — different GLBs
		// ship with different native-forward axes and each one's
		// rotation is set in src/plane/planes.js so this loader stays
		// airframe-agnostic.
		mesh.rotation.set(
			plane.modelRotation.x || 0,
			plane.modelRotation.y || 0,
			plane.modelRotation.z || 0,
		);
		// Hide any model-specific nodes the registry flags (landing
		// gear, alt-loadout weapons, etc). Each entry is either:
		//   - a plain string   → exact match on child.name
		//   - a RegExp         → tested against child.name
		// Regex form is useful for models where the ordnance / gear is
		// split across many numbered siblings.
		if (plane.hideNodes && plane.hideNodes.length) {
			let hidden = 0;
			mesh.traverse((child) => {
				if (!child.name) return;
				for (const pat of plane.hideNodes) {
					const match = (pat instanceof RegExp)
						? pat.test(child.name)
						: child.name === pat;
					if (match) { child.visible = false; hidden++; break; }
				}
			});
			console.log(`[plane ${plane.id}] hid ${hidden} node(s) via hideNodes`);
		}
		// Push signature into player state (drives RCS / IR detection).
		state.signature = { ...SIGNATURES[plane.signature] };
		// Apply per-plane radar override onto the default fighter radar
		// so F-22's APG-77 reaches further than F-15's APG-70.
		if (plane.radarOverride) {
			Object.assign(state.sensors.radar, plane.radarOverride);
		} else {
			// Reset to default (in case we came from a plane that had
			// overrides).
			Object.assign(state.sensors.radar, FIGHTER_RADAR_DEFAULT);
		}
		// IR sensor suite varies by airframe:
		//   - F-15 / generic fighter: forward IRST cone (default).
		//   - F-22: no air-to-air IRST in real life — only MAWS for
		//     missile threats (modeled by fov=0; the FOV check rejects
		//     fighter targets, while missile-class targets bypass FOV
		//     in scanIR() and are still caught).
		//   - F-35: DAS gives genuine all-aspect IR coverage for both
		//     fighters and missiles.
		Object.assign(state.sensors.ir, FIGHTER_IRST_DEFAULT);
		if (plane.irOverride) {
			Object.assign(state.sensors.ir, plane.irOverride);
		}
		// Apply physics overrides (thrust / agility / G-limits) onto
		// the shared physics instance.
		const physics = ctx.physics;
		if (typeof physics.applyOverrides === 'function') {
			// First reset to baseline by reinstantiating, then apply
			// overrides — simpler than tracking deltas.
			const fresh = new PlanePhysics();
			fresh.applyOverrides(plane.physicsOverrides || {});
			ctx.setPhysics(fresh);
		}

		const planeModel = new THREE.Group();
		planeModel.add(mesh);
		scene.add(planeModel);

		planeModel.layers.set(1);
		planeModel.traverse(child => {
			child.layers.set(1);
		});

		// stripOrdnance(mesh) / highlightMeshes(mesh) available; left
		// out of the normal load path. See those modules when iterating
		// on model cleanup.

		// Centre the mesh on origin. Box3 is evaluated AFTER rotation
		// so axes are in the planeModel's own frame — simplifies
		// flame / nozzle placement below.
		const box = new THREE.Box3().setFromObject(mesh);
		const center = box.getCenter(new THREE.Vector3());
		mesh.position.sub(center);
		const box2 = new THREE.Box3().setFromObject(mesh);
		const size  = box2.getSize(new THREE.Vector3());
		console.log(`[Player ${plane.id} size]`, size, 'tailZ=', box2.max.z);

		// Scale the cockpit visual plane to a consistent apparent
		// size regardless of which airframe GLB we load. The old
		// model displayed at 25.6 × 0.2 ≈ 5.1 m; we preserve that so
		// chase-camera framing doesn't need retuning per model. For
		// a real-scale plane in the player's camera, the camera
		// origin would need to move back several metres — deferred
		// until we have a proper plane-config table.
		const COCKPIT_APPARENT_LENGTH_M = 5.12;
		const maxDim = Math.max(size.x, size.y, size.z);
		const cockpitScale = COCKPIT_APPARENT_LENGTH_M / maxDim;

		// Camera framing auto-derived from the plane's apparent size.
		// The old hard-coded (0, -0.8, -2.75) was tuned for the
		// oversized stock F-15; any differently-sized airframe had to
		// be zoomed manually to look right. Now we place the plane at
		// a distance proportional to its apparent length so the chase
		// view frames the airframe consistently regardless of which
		// GLB is loaded.
		//
		//   z = -1.3 × apparent_length →  plane sits 1.3 lengths
		//       forward of the camera. At 75° FOV that fills ~45° of
		//       the screen height, which reads as "clearly the plane
		//       but with context around it".
		//   y = -0.4 × apparent_height → the camera sits 40% of the
		//       plane's height above the airframe centerline, giving
		//       the usual slightly-above chase angle.
		const apparentLength = size.z * cockpitScale; // nose-tail along rotated Z
		const apparentHeight = size.y * cockpitScale;
		BASE_PLANE_POS.set(
			0,
			-apparentHeight * 0.40,
			-apparentLength * 1.30,
		);
		visualOffset.copy(BASE_PLANE_POS);

		planeModel.position.copy(BASE_PLANE_POS);
		planeModel.scale.setScalar(cockpitScale);

		// Flame origins at the engine nozzle plane, computed from the
		// bbox + published F-15 nozzle geometry so the same
		// coefficients work for any 19.43 m × 13.05 m × 5.64 m F-15
		// airframe mesh. Origin factors:
		//   - tailZ = box.max.z * 0.80  →  nozzle exit is at ~95% of
		//     nose-to-tail length in absolute terms, but bbox.max.z
		//     is pushed further back by the horizontal stabilizers +
		//     tail cone. Measuring against the stabilizer-extended
		//     bbox, the nozzle sits at ~80% of that half-length.
		//     Empirically matches the model's own nozzle.
		//   - nozzleX = size.x * 0.055 →  half-spacing of 0.71 m vs
		//     13.05 m wingspan = 5.4%.
		//   - nozzleY = -size.y * 0.18 →  engines are in lower
		//     fuselage; bbox y-center sits above fuselage centerline
		//     because of the tall vertical stabilizers, so nozzles
		//     end up ~18% of total height below mesh center.
		// Per-plane nozzle ratio overrides — defaults tuned for the
		// F-15 Strike Eagle, F-22 has its own values in the registry.
		const nz = plane.nozzle || {};
		const zRatio = (nz.zRatio != null) ? nz.zRatio :  0.80;
		const xRatio = (nz.xRatio != null) ? nz.xRatio :  0.055;
		const yRatio = (nz.yRatio != null) ? nz.yRatio : -0.18;
		const tailZ   = box2.max.z * zRatio;
		const nozzleX = size.x * xRatio;
		const nozzleY = size.y * yRatio;

		// Engine count varies per airframe (F-15 twin, F-35 single,
		// B-2 four, etc). For single-engine planes the one nozzle
		// sits on the centerline; for twins they're offset
		// symmetrically by nozzleX. Anything above two falls through
		// to a uniform horizontal spread of nozzleX*2 spanning the
		// group.
		const engineCount = plane.engineCount || 2;
		const flamePositions = [];
		if (engineCount === 1) {
			flamePositions.push({ x: 0, y: nozzleY, z: tailZ });
		} else if (engineCount === 2) {
			flamePositions.push({ x: -nozzleX, y: nozzleY, z: tailZ });
			flamePositions.push({ x:  nozzleX, y: nozzleY, z: tailZ });
		} else {
			for (let i = 0; i < engineCount; i++) {
				const t = (i + 0.5) / engineCount - 0.5;    // -0.5..+0.5
				flamePositions.push({ x: t * nozzleX * 2, y: nozzleY, z: tailZ });
			}
		}
		// Flame-scale compensation. Jet flames are fixed-size Three.js
		// geometry (2-unit cylinder). When planeModel is scaled by
		// cockpitScale (0.2 for F-15, 0.17 for F-35, 0.0017 for the
		// huge-native F-22 mesh), the flame shrinks with it and
		// effectively disappears on larger-native models. Counter by
		// scaling the flame group UP by 1/cockpitScale × a calibration
		// constant chosen so the F-15 stays at its current size (i.e.
		// matches the pre-rescale flame). Target world-size ≈ 0.4 m.
		const FLAME_WORLD_TARGET = 0.4;
		const flameGroupScale = FLAME_WORLD_TARGET / (2 * cockpitScale);
		for (const p of flamePositions) {
			const f = new JetFlame();
			f.group.position.set(p.x, p.y, p.z);
			f.group.scale.setScalar(flameGroupScale);
			planeModel.add(f.group);
			jetFlames.push(f);
		}

		ctx.setPlaneModel(planeModel);

		const weaponSystem = new WeaponSystem(getViewer(), scene, planeModel);
		weaponSystem.onKill = (npc) => {
			state.score += 1000;
			try { soundManager.play('glitch-random'); } catch (e) { }
			if (ctx.hud) {
				ctx.hud.showKillNotification(npc.name, 1000);
			}
		};
		ctx.setWeaponSystem(weaponSystem);

		planeModel.traverse(child => {
			child.layers.set(1);
		});

		const mixer = new THREE.AnimationMixer(mesh);
		const clip = THREE.AnimationClip.findByName(gltf.animations, 'flight_mode');
		if (clip) {
			const action = mixer.clipAction(clip);
			action.setLoop(THREE.LoopOnce);
			action.clampWhenFinished = true;
			action.play();
		}
		ctx.setMixer(mixer);

		loadingStatus.model = true;
		updateLoadingUI(ctx.currentState);
	}, undefined, (error) => {
		console.error('Error loading model:', error);
	});
}
