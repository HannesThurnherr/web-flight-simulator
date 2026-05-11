// ============================================================================
// Takram three-atmosphere integration — opt-in physically-based atmospheric
// scattering for the THREE.js render pass.
//
// What this gives us:
//   - AerialPerspectiveEffect: real Bruneton precomputed scattering applied
//     as a postprocessing pass over the THREE scene, so distant NPCs /
//     missiles / particles inscatter atmospheric colour properly instead
//     of our hand-rolled FogExp2 approximation.
//   - getSunDirectionECEF / getECIToECEFRotationMatrix: accurate sun
//     direction derived from JulianDate via astronomy-engine internally,
//     overriding our Simon1994 path.
//
// What this does NOT do (deferred — see COMBAT_ROADMAP.md):
//   - Sky / Stars rendering. Cesium owns the sky background; layering
//     takram's SkyMaterial on top would clash with skyAtmosphere.
//   - Volumetric clouds.
//   - Replacing AmbientLight / DirectionalLight with SkyLightProbe /
//     SunDirectionalLight. Both work fine in tandem with the existing
//     lights — we leave that swap for a later iteration once the
//     baseline integration is stable.
//
// Coordinate-system trick: our scene is camera-relative (camera at scene
// origin, world rebased every frame). Takram needs ECEF positions for
// its scattering shaders. We bridge by handing the effect a
// `worldToECEFMatrix` derived from Cesium's viewMatrix each frame —
// the effect transforms scene fragments into real ECEF for the LUT
// lookup without us moving Three meshes to literal ECEF coordinates.
//
// Strict opt-in: gameSettings.atmosphericScattering must be true.
// Default off. Falls back gracefully if textures don't load.
// ============================================================================

import * as THREE from 'three';
import * as Cesium from 'cesium';
import {
	AerialPerspectiveEffect,
	PrecomputedTexturesLoader,
	DEFAULT_PRECOMPUTED_TEXTURES_URL,
	getSunDirectionECEF,
} from '@takram/three-atmosphere';
import {
	EffectComposer,
	EffectPass,
	RenderPass,
} from 'postprocessing';

let _enabled = false;
let _composer = null;
let _renderPass = null;
let _aerialPerspective = null;
let _effectPass = null;
let _texturesReady = false;
let _renderer = null;
let _scene = null;
let _camera = null;
let _viewer = null;
// One-time diagnostic logs so the user can verify the pipeline is
// actually active from the browser console without us littering the
// per-frame path with checks.
let _loggedFirstRender = false;
let _loggedReady = false;

// Scratch math objects — reused per-frame.
const _scratchSunECEF     = new THREE.Vector3();
const _scratchWorldToECEF = new THREE.Matrix4();
const _scratchInvView     = new THREE.Matrix4();

// One-time init. Builds the EffectComposer with HalfFloatType (required
// by the atmosphere shader for radiance/luminance) and kicks off the
// async load of the precomputed scattering textures from the takram
// CDN. Until those textures land, `isTakramReady()` returns false and
// the animate loop keeps using the vanilla renderer.render path so the
// game stays playable while the textures are in flight.
export function initTakramAtmosphere(renderer, scene, camera, viewer) {
	if (_composer) return;
	_renderer = renderer;
	_scene    = scene;
	_camera   = camera;
	_viewer   = viewer;

	try {
		_composer = new EffectComposer(renderer, {
			frameBufferType: THREE.HalfFloatType,
			multisampling: 0,
		});
		_renderPass = new RenderPass(scene, camera);
		_composer.addPass(_renderPass);

		_aerialPerspective = new AerialPerspectiveEffect(camera);
		_effectPass = new EffectPass(camera, _aerialPerspective);
		_composer.addPass(_effectPass);
	} catch (e) {
		console.warn('[takramAtmosphere] composer setup failed:', e);
		_composer = null;
		return;
	}

	// Fire-and-forget texture load. ~5 MB total over the wire; until
	// they arrive the effect won't render correctly so we gate
	// isTakramReady() on this promise.
	try {
		const loader = new PrecomputedTexturesLoader();
		loader.loadAsync(DEFAULT_PRECOMPUTED_TEXTURES_URL).then((textures) => {
			if (!_aerialPerspective) return;
			_aerialPerspective.transmittanceTexture = textures.transmittanceTexture;
			_aerialPerspective.scatteringTexture    = textures.scatteringTexture;
			_aerialPerspective.irradianceTexture    = textures.irradianceTexture;
			if (textures.higherOrderScatteringTexture) {
				_aerialPerspective.higherOrderScatteringTexture =
					textures.higherOrderScatteringTexture;
			}
			_texturesReady = true;
			console.log('[takramAtmosphere] precomputed scattering textures loaded');
		}).catch((err) => {
			console.warn('[takramAtmosphere] failed to load precomputed textures:', err);
			_texturesReady = false;
		});
	} catch (e) {
		console.warn('[takramAtmosphere] texture loader threw:', e);
	}
}

export function setTakramEnabled(on) {
	_enabled = !!on;
}

export function isTakramReady() {
	const ready = _enabled && _composer && _texturesReady;
	if (ready && !_loggedReady) {
		_loggedReady = true;
		console.log('[takramAtmosphere] pipeline active: composer + aerial-perspective + LUTs ready');
	}
	return ready;
}

// Status getter for a tiny on-screen indicator so the user can SEE
// at a glance whether the pipeline is running (vs. having to dig
// through the console). The HUD reads this and paints an "ATMOS"
// tag in the top-right corner when active.
export function getTakramStatus() {
	if (!_enabled) return 'off';
	if (!_composer) return 'init-failed';
	if (!_texturesReady) return 'loading';
	return 'active';
}

// Per-frame update: feed the effect the current sun direction (ECEF)
// and the world→ECEF transform derived from Cesium's camera viewMatrix.
// Cheap — a handful of vector ops and a matrix invert.
export function updateTakramPerFrame(playerState) {
	if (!isTakramReady() || !_viewer || !playerState) return;

	// Sun direction in ECEF via the takram utilities — uses
	// astronomy-engine internally and is more accurate than the
	// Simon1994 path we use in dynamicLighting.
	const jdate = _viewer.clock.currentTime;
	const jsDate = Cesium.JulianDate.toDate(jdate);
	getSunDirectionECEF(jsDate, _scratchSunECEF);
	_aerialPerspective.sunDirection.copy(_scratchSunECEF);

	// World→ECEF matrix: inverse of Cesium's viewMatrix takes camera-
	// space (which IS our Three scene's coordinate system, since the
	// renderer trick puts everything at camera-relative positions
	// each frame) back into ECEF. The atmosphere shader uses this to
	// look up "where am I above the ellipsoid" per fragment.
	const viewMatArr = _viewer.camera.viewMatrix;
	// Cesium Matrix4 is a column-major 16-element array. THREE's
	// Matrix4 .fromArray expects the same column-major layout, so
	// we can copy straight across.
	_scratchInvView.fromArray(viewMatArr);
	_scratchWorldToECEF.copy(_scratchInvView).invert();
	if (_aerialPerspective.worldToECEFMatrix) {
		_aerialPerspective.worldToECEFMatrix.copy(_scratchWorldToECEF);
	}
}

// Replacement for renderer.render() on the layer-0 pass. The animate
// loop's layer-1 second pass (player plane at FOV 75) keeps using
// the vanilla path — we don't want aerial perspective on the
// chase-view plane mesh, only on the world.
export function renderTakramComposer() {
	if (!isTakramReady()) return false;
	try {
		_composer.render();
		if (!_loggedFirstRender) {
			_loggedFirstRender = true;
			console.log('[takramAtmosphere] first composer render OK');
		}
		return true;
	} catch (e) {
		console.warn('[takramAtmosphere] composer render threw:', e);
		return false;
	}
}

export function resizeTakramComposer(width, height) {
	if (_composer) _composer.setSize(width, height);
}
