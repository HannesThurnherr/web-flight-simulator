// ============================================================================
// Three.js scene / camera / renderer bring-up.
//
// Creates the THREE objects and seats them into the #threeContainer
// DOM element, kicks off the async sound loader, then kicks off the
// async plane-model loader. Returns an object with the four created
// refs — main.js assigns them into its module-scope `let`s so the sim
// loop can use them.
//
// Extracted from main.js because the bootstrap section is big enough
// to read better as "call these setup functions" than as "here's the
// inline body of each". The caller supplies ctx so `loadPlayerPlane`
// (which needs scene / planeModel / weaponSystem / etc.) can be
// invoked without a separate parameter list.
// ============================================================================

import * as THREE from 'three';
import { getViewer } from '../world/cesiumWorld';
import { particles } from '../utils/particles';
import { initSounds } from '../utils/gameplaySounds';
import { loadingStatus, updateLoadingUI } from '../ui/loadingUI';
import { loadPlayerPlane } from '../plane/loadPlayerPlane';
import { getActivePlane } from '../plane/planes';
import { setLights as setDynamicLights, setFog as setDynamicFog } from './dynamicLighting.js';

// Build the scene, camera, renderer, and clock. Returns them so main.js
// can assign to its module-level bindings; everything else (ambient
// lights, particles, sounds, plane model) is kicked off internally.
export function initThree(ctx) {
	const clock    = new THREE.Clock();
	const scene    = new THREE.Scene();
	const camera   = new THREE.PerspectiveCamera(
		75, window.innerWidth / window.innerHeight, 0.1, 100000,
	);
	const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });

	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.setPixelRatio(window.devicePixelRatio);
	renderer.setClearColor(0x000000, 0);

	const threeContainer = document.getElementById('threeContainer');
	threeContainer.appendChild(renderer.domElement);
	threeContainer.classList.add('hidden');

	const ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
	scene.add(ambientLight);
	const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
	directionalLight.position.set(5, 10, 5);
	scene.add(directionalLight);

	ambientLight.layers.enable(1);
	directionalLight.layers.enable(1);

	// Hand the light refs to the dynamic-lighting module so it can
	// drive intensity off the sun's position when `lightingMode` is
	// 'realistic'. In 'arcade' mode it just keeps both at 1.0.
	setDynamicLights(ambientLight, directionalLight);

	// Exponential distance fog approximating aerial perspective:
	// distant Three.js objects (NPCs, missiles, particles) fade
	// into the atmosphere just like terrain fades behind Cesium's
	// own fog. dynamicLighting drives color + density each frame
	// from sun elevation, player altitude, and the
	// camera-look-vs-sun-direction dot product so looking toward a
	// sunset tints the haze warm-orange while looking away tints
	// it cool blue. Density attenuated by altitude so high-altitude
	// flying clears up the way real atmospheric thickness does.
	const fog = new THREE.FogExp2(0xb0c0d0, 0.00002);
	scene.fog = fog;
	setDynamicFog(fog);

	// Particles system uses the current Cesium viewer if one is up.
	// Wrapped in try/catch because particles is optional — missing
	// shouldn't block the rest of bring-up.
	try { particles.init(scene, getViewer()); } catch (e) { }

	// Hand the refs back to main.js so it can populate its own module-
	// scope bindings before we call the sound + plane loaders — those
	// loaders consult ctx getters that are backed by those bindings.
	// Return value is assigned at the call site.
	ctx.setScene(scene);
	ctx.setCamera(camera);

	initSounds(camera, () => {
		loadingStatus.audio = true;
		updateLoadingUI(ctx.currentState);
	}).catch(err => console.error('Failed to init sounds', err));

	loadPlayerPlane(getActivePlane(), ctx);

	return { scene, camera, renderer, clock };
}
