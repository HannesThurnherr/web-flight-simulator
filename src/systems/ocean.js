// ============================================================================
// 3D ocean — localized FFT (Tessendorf) wave patch composited in the Three.js
// layer over the Cesium globe.
//
// The wave field is synthesized on the GPU by oceanFFT.js (inverse-FFT of a
// Phillips spectrum → height / choppiness / slope / jacobian textures). We run
// TWO cascades at non-commensurate tile sizes (e.g. 491 m + 109 m) and sum them
// in the display shader: a single FFT tile visibly repeats, but two tiles whose
// sizes share no small common multiple don't line up again for kilometres, so
// the obvious "rubber-mat" tiling is gone — this is the standard cascade trick.
//
// THIS module owns the Cesium integration: it lays a grid on the sea surface,
// baked into camera-space the way missiles/ships are (viewMatrix ×
// eastNorthUpToFixedFrame(centre)), recenters it on the camera, gates it to
// low-altitude-over-water (so it — and the FFT passes — cost nothing at
// altitude), and fades it into Cesium's flat water at the patch edge.
//
// It also owns the SHADING, which is where most of what you actually see comes
// from. Water is close to a mirror, so the sea's colour is mostly the sky's
// colour: the display shader reflects an analytic sky (zenith / horizon / sun,
// handed in per frame from the real solar elevation — see SKY_KEYS) through a
// Fresnel term, adds a distance-widening sun glitter lobe, a shallow body
// colour with subsurface glow, jacobian-driven whitecaps, and finally the same
// aerial-perspective haze the rest of the scene fades into. Wave detail is
// rolled off with view distance so far water settles into the near-mirror it
// reads as from kilometres away rather than aliasing into crawling glitter.
// ============================================================================

import * as THREE from 'three';
import * as Cesium from 'cesium';
import {
	_sunDirectionENU as sunDirectionENU,
	_moonDirectionENU as moonDirectionENU,
} from './dynamicLighting.js';
import { OceanFFT } from './oceanFFT.js';
import { isTakramReady } from './takramAtmosphere.js';
import { seaSurfaceHeightAt } from '../world/terrain.js';

// ---- Display patch (the visible mesh) --------------------------------------
const PATCH_RADIUS_M = 4200;   // half-size (→ 8.4 km square) — covers far more sea
const SEGMENTS       = 840;    // grid resolution (cells ≈ 10 m)
const EARTH_R        = 6371000;
const CELL_M         = (PATCH_RADIUS_M * 2) / SEGMENTS;

// ---- FFT cascades (see oceanFFT.js) ----------------------------------------
// Two tiles at sizes with no small common multiple → the sum doesn't visibly
// repeat. N=128 is plenty given the ~6 m display cells.
const CASCADES = [
	{ resolution: 128, patchSize: 491, windSpeed: 17, amplitude: 2.2, windDir: [1.0, 0.65] },
	{ resolution: 128, patchSize: 109, windSpeed: 11, amplitude: 1.6, windDir: [0.7, 1.0] },
];

// Display scaling — the raw IFFT field has RMS ~ tens of units, so this maps it
// down to a ~1 m sea. (Calibrated against a height-field readback.)
// metres per raw unit (overall wave height). 0.007 → RMS ~0.43 m → significant
// wave height ~1.7 m (a moderate sea). This is the main sea-state knob: raise
// for rougher water, lower for a glassy calm.
const WAVE_SCALE      = 0.007;
const CHOPPY_SCALE    = 1.1;    // horizontal choppiness (sharper crests as it grows)
const NORMAL_STRENGTH = 1.4;    // wave-normal bumpiness (artistic emphasis)
// RMS of the displayed height field in METRES (WAVE_SCALE × the raw field's
// RMS). The shader needs this to put its trough→crest colour ramp on the same
// scale as the water it is shading — see uWaveRms.
const WAVE_RMS_M      = 0.45;

// Aerial perspective: how fast the sea washes out into haze with distance.
// 1/14 km — ~26% haze at the patch rim, which is what lets the far edge sit
// down onto Cesium's flat water instead of ending at a visible line.
const HAZE_SCALE      = 1 / 14000;

// Altitude fade (m above local sea): full below FADE_BOTTOM, gone above FADE_TOP.
const FADE_BOTTOM_M = 1200;
const FADE_TOP_M    = 5000;
const SEA_LEVEL_MAX_M = 85;     // over-water gate (geoid sea is tens of m MSL)

// ---- Module state ----------------------------------------------------------
let _viewer = null;
let _renderer = null;
let _scene = null;              // for scene.fog.color (shared aerial perspective)
let _ffts = [];                 // one OceanFFT per cascade
let _mesh = null;
let _mat = null;
let _enabledSetting = true;

let _originLon = null, _originLat = null, _cosOrigin = 1;
let _lastSeaH = 20;

const _scratchCarto    = new Cesium.Cartographic();
const _scratchCenter   = new Cesium.Cartesian3();
const _scratchModel    = new Cesium.Matrix4();
const _scratchInv      = new Cesium.Matrix4();
const _scratchCamL     = new Cesium.Cartesian3();
const _scratchCamSpace = new Cesium.Matrix4();
const _sunOut  = { e: 0, n: 0, u: 1, elevDeg: 90 };
const _moonOut = { e: 0, n: 0, u: -1, elevDeg: -90, illum: 0, level: 0 };

// Display vertex shader (GLSL1, WebGL2 vertex texture fetch). Samples both
// cascades by world XY, sums them, and displaces the local-ENU grid; the
// curvature term keeps the flat tangent patch hugging the sea sphere.
//
// Detail LOD: a display cell is ~10 m, so past a few hundred metres one cell
// spans several wavelengths of the fine cascade. Sampling it anyway doesn't
// add detail, it aliases — the classic crawling-glitter shimmer on distant
// water. So choppiness and normal relief are rolled off with view distance and
// the surface is allowed to settle toward the near-mirror it actually reads as
// from far away. `vLod` carries that same 0→1 ramp to the fragment stage, which
// widens the specular lobe to match (sub-pixel waves = rougher surface).
const VERT = /* glsl */`
	uniform sampler2D uDispY0, uDispX0, uDispZ0;
	uniform sampler2D uDispY1, uDispX1, uDispZ1;
	uniform float uPatch0, uPatch1;
	uniform vec2  uCenterOffset;
	uniform float uWaveScale, uChoppyScale, uNormalStrength;
	uniform float uEarthR, uPatchR;
	uniform vec3  uCamLocal;

	varying vec3  vNormalL;
	varying vec3  vPosL;
	varying float vHeight;
	varying float vJacobian;
	varying float vEdge;
	varying vec2  vWorldXY;
	varying float vLod;

	void main() {
		vec2 base = position.xy;                 // local east/north metres
		vec2 worldXY = uCenterOffset + base;

		vec2 uv0 = worldXY / uPatch0;
		vec2 uv1 = worldXY / uPatch1;
		vec4 y0 = texture2D(uDispY0, uv0), x0 = texture2D(uDispX0, uv0), z0 = texture2D(uDispZ0, uv0);
		vec4 y1 = texture2D(uDispY1, uv1), x1 = texture2D(uDispX1, uv1), z1 = texture2D(uDispZ1, uv1);

		float height  = y0.r + y1.r;
		float choppyX = x0.r + x1.r;
		float choppyZ = z0.r + z1.r;
		float slopeX  = x0.b + x1.b;
		float slopeZ  = z0.b + z1.b;
		float jac     = max(y0.b, y1.b);

		float lod = smoothstep(250.0, 2600.0, distance(uCamLocal, vec3(base, 0.0)));

		float curve = dot(base, base) / (2.0 * uEarthR);
		float chop  = uWaveScale * uChoppyScale * (1.0 - 0.85 * lod);

		vec3 displaced;
		displaced.x = base.x - choppyX * chop;                        // east
		displaced.y = base.y - choppyZ * chop;                        // north
		displaced.z = height * uWaveScale - curve;                    // up

		float relief = uWaveScale * uNormalStrength * (1.0 - 0.90 * lod);
		vNormalL = normalize(vec3(-slopeX * relief, -slopeZ * relief, 1.0));
		vPosL     = displaced;
		vHeight   = height * uWaveScale;
		vJacobian = jac;
		vEdge     = length(base) / uPatchR;
		vWorldXY  = worldXY;
		vLod      = lod;

		gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
	}
`;

// Display fragment shader.
//
// Water is almost entirely a mirror: nearly everything you see looking at the
// sea is the sky it reflects, gated by Fresnel, plus the sun's own reflection.
// So the shading here is built around a small analytic sky (zenith / horizon /
// sun colour, handed in per frame from the real solar elevation) rather than a
// fixed blue — that one change is what makes the sea turn copper at sunset and
// go gunmetal under a low sun instead of staying the same flat daylight blue at
// every hour.
const FRAG = /* glsl */`
	uniform vec3  uSunDirLocal;
	uniform vec3  uMoonDirLocal;
	uniform vec3  uCamLocal;
	uniform vec3  uSunColor;
	uniform vec3  uMoonColor;
	uniform vec3  uSkyZenith;
	uniform vec3  uSkyHorizon;
	uniform vec3  uHazeColor;
	uniform float uSunLevel;
	uniform float uMoonLevel;
	uniform float uHazeScale;
	uniform float uAlpha;
	uniform float uWaveScale;
	uniform float uWaveRms;
	uniform float uTime;
	uniform float uEncode;

	varying vec3  vNormalL;
	varying vec3  vPosL;
	varying float vHeight;
	varying float vJacobian;
	varying float vEdge;
	varying vec2  vWorldXY;
	varying float vLod;

	const float PI = 3.14159265;

	float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
	float vnoise(vec2 p) {
		vec2 i = floor(p), f = fract(p);
		f = f * f * (3.0 - 2.0 * f);
		return mix(mix(hash21(i),               hash21(i + vec2(1.0, 0.0)), f.x),
		           mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
	}

	// Normalised Blinn-Phong lobe for a distant source (sun or moon). Gloss is
	// passed in and falls with distance at the call site, so the highlight
	// spreads into the long glitter path a real sea shows toward the horizon
	// instead of the razor-thin sparkles a fixed exponent aliases into.
	//
	// Real glitter is thousands of individual capillary-ripple facets flashing
	// on and off. The FFT cascades stop well short of that scale, so the
	// highlight is chopped up with drifting noise instead — near the camera
	// only, where the alternative is one continuous chrome smear. That noise is
	// metre-scale and goes sub-pixel fast, so it fades with view distance
	// rather than with the geometry LOD; past a few hundred metres it would
	// only add crawling grain. Most of the sea is nowhere near the lobe, so the
	// noise is only paid for inside it.
	float glitterLobe(vec3 N, vec3 V, vec3 S, float gloss, float dist) {
		vec3  H = normalize(S + V);
		float s = pow(max(dot(N, H), 0.0), gloss) * (gloss + 8.0) / (8.0 * PI);
		if (s <= 0.002) return 0.0;
		float spark = mix(1.0, 0.35 + 1.5 * vnoise(vWorldXY * 3.1 + uTime * 0.5),
		                  1.0 - smoothstep(80.0, 600.0, dist));
		return s * spark;
	}

	void main() {
		vec3  N     = normalize(vNormalL);
		vec3  toCam = uCamLocal - vPosL;
		float dist  = length(toCam);
		vec3  V     = toCam / max(dist, 1e-4);
		vec3  L     = normalize(uSunDirLocal);
		vec3  M     = normalize(uMoonDirLocal);

		float NdV  = max(dot(N, V), 0.0);
		float fres = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);

		// ---- reflected sky ---------------------------------------------------
		// Sample the analytic sky along the mirror direction: looking down at
		// steep angles reflects the dark zenith, grazing angles reflect the pale
		// horizon. That gradient IS the shape of open water.
		vec3  R   = reflect(-V, N);
		vec3  sky = mix(uSkyHorizon, uSkyZenith, pow(clamp(R.z, 0.0, 1.0), 0.6));
		sky += uSunColor * pow(max(dot(R, L), 0.0), 8.0) * 0.30 * uSunLevel;
		// The moon is up half the time in daylight too, and physically it does
		// lay a second specular path on the water — one so far below the sun's
		// that you will never see it. Gating every moon term on how far the sun
		// has gone keeps that path out of daytime frames, where it would read as
		// a rendering error, and hands it the whole night, where it is the only
		// thing keeping the sea off pure black.
		float night    = 1.0 - uSunLevel;
		float moonPow  = uMoonLevel * night;
		// Moonlit skyglow + the moon's own halo in the reflection.
		sky += uMoonColor * moonPow * (0.022 + 0.28 * pow(max(dot(R, M), 0.0), 12.0));

		// ---- water body ------------------------------------------------------
		// Trough → crest ramp, on the metre scale of the actual displayed waves.
		float hMask = smoothstep(-1.1 * uWaveRms, 1.5 * uWaveRms, vHeight);
		vec3  body  = mix(vec3(0.005, 0.052, 0.098), vec3(0.020, 0.170, 0.215), hMask);
		// Sunlight through the thin back of a wave — the green-teal glow you get
		// looking toward the sun across a swell.
		float sss = pow(clamp(dot(V, -L), 0.0, 1.0), 3.0)
		          * smoothstep(-0.3 * uWaveRms, 1.6 * uWaveRms, vHeight);
		body += vec3(0.045, 0.230, 0.185) * sss * 0.55 * uSunLevel;
		// Irradiance reaching the surface: skylight from above, direct sun, and
		// at night the moon — small, but it is what stops the troughs going flat
		// black once the sun term is gone.
		body *= uSkyHorizon * 0.70
		      + uSunColor  * (0.85 * max(L.z, 0.0))
		      + uMoonColor * (0.16 * moonPow * max(M.z, 0.0))
		      + 0.03;
		// Purkinje shift: below daylight levels colour vision drops out, so the
		// body colour drifts toward its own luminance. Without this the sea keeps
		// a tropical teal cast under moonlight, which is the one thing that reads
		// as "daytime water turned down" rather than as night.
		body = mix(vec3(dot(body, vec3(0.299, 0.587, 0.114))), body,
		           mix(0.35, 1.0, uSunLevel));

		vec3 col = mix(body, sky, fres);

		// ---- sun / moon glitter (Fresnel-weighted) ---------------------------
		col += min(uSunColor * (glitterLobe(N, V, L, mix(360.0, 45.0, vLod), dist)
		                        * fres * 0.55 * uSunLevel), vec3(8.0));
		if (moonPow > 0.002) {
			// Same lobe, softer and far dimmer: a moon path is a shimmer, not a
			// blaze, and it is the single strongest cue that the dark surface
			// under the ships is water at all.
			col += min(uMoonColor * (glitterLobe(N, V, M, mix(260.0, 40.0, vLod), dist)
			                         * fres * 0.30 * moonPow), vec3(1.5));
		}

		// ---- foam ------------------------------------------------------------
		// The jacobian marks where the choppy displacement folds the surface
		// over itself — i.e. breaking crests. Flat white there looks like
		// plastic, so it's broken up by drifting noise and lit like everything
		// else, then held back at distance where it would just be white speckle.
		float turb  = max(0.0, vJacobian) * uWaveScale * 8.0;
		float crest = smoothstep(0.16, 0.70, turb);
		if (crest > 0.001) {
			// Fine octave settles to its mean with distance instead of aliasing.
			float fine    = mix(0.5, vnoise(vWorldXY * 5.3 - uTime * 0.26),
			                    1.0 - smoothstep(150.0, 900.0, dist));
			float bubbles = vnoise(vWorldXY * 1.7 + uTime * 0.12) * 0.55 + fine * 0.45;
			float foam    = smoothstep(0.34, 0.92, crest * (0.5 + 0.9 * bubbles))
			              * (1.0 - 0.6 * vLod);
			vec3  foamCol = uSkyHorizon * 0.55
			              + uSunColor  * (0.60 * max(L.z, 0.0))
			              + uMoonColor * (0.30 * moonPow * max(M.z, 0.0))
			              + 0.06;
			col = mix(col, foamCol, clamp(foam, 0.0, 1.0) * 0.85);
		}

		// ---- aerial perspective ---------------------------------------------
		// Distant sea washes toward the same haze colour the rest of the scene
		// fades into. This is also what makes the patch rim disappear: by the
		// time the alpha ramp hands over to Cesium's flat water, our colour has
		// already converged on the horizon haze.
		col = mix(col, uHazeColor, (1.0 - exp(-dist * uHazeScale)) * 0.72);

		// Everything above is linear radiance, and the sun glint deliberately
		// runs well over 1. Roll the highlights off rather than clipping them,
		// so a glint reads as a bright core with a falloff instead of a flat
		// white blob.
		col = 1.0 - exp(-max(col, 0.0));
		// Then linear → sRGB, because three does no output encoding for a raw
		// ShaderMaterial. EXCEPT when the takram composer is doing the final
		// pass — it encodes the whole frame itself, and encoding twice washes
		// the sea out. uEncode is flipped per frame to match the active path.
		if (uEncode > 0.5) {
			col = mix(col * 12.92,
			          1.055 * pow(col, vec3(1.0 / 2.4)) - 0.055,
			          step(vec3(0.0031308), col));
		}

		// Edge fade into Cesium's flat water + global altitude fade. Fade starts
		// at 55% of the radius and runs to the rim — a long, gentle blend
		// (~1.9 km here) so there's no visible seam into the flat water.
		float a = uAlpha * (1.0 - smoothstep(0.55, 1.0, vEdge));
		gl_FragColor = vec4(col, a);
	}
`;

export function initOcean(scene, viewer, renderer) {
	if (_mesh || !scene) return;
	_viewer = viewer;
	_renderer = renderer;
	_scene = scene;

	try {
		if (!_renderer) throw new Error('no renderer');
		_ffts = CASCADES.map(c => new OceanFFT(_renderer, {
			resolution: c.resolution,
			patchSize: c.patchSize,
			windSpeed: c.windSpeed,
			amplitude: c.amplitude,
			windDirection: new THREE.Vector2(c.windDir[0], c.windDir[1]).normalize(),
		}));
	} catch (e) {
		console.warn('[ocean] FFT engine init failed — ocean disabled:', e);
		_ffts = [];
		return;
	}

	const geo = new THREE.PlaneGeometry(PATCH_RADIUS_M * 2, PATCH_RADIUS_M * 2, SEGMENTS, SEGMENTS);
	_mat = new THREE.ShaderMaterial({
		vertexShader: VERT,
		fragmentShader: FRAG,
		transparent: true,
		depthWrite: true,
		depthTest: true,
		uniforms: {
			uDispY0: { value: null }, uDispX0: { value: null }, uDispZ0: { value: null },
			uDispY1: { value: null }, uDispX1: { value: null }, uDispZ1: { value: null },
			uPatch0: { value: CASCADES[0].patchSize },
			uPatch1: { value: CASCADES[1].patchSize },
			uCenterOffset: { value: new THREE.Vector2(0, 0) },
			uWaveScale: { value: WAVE_SCALE },
			uChoppyScale: { value: CHOPPY_SCALE },
			uNormalStrength: { value: NORMAL_STRENGTH },
			uEarthR: { value: EARTH_R },
			uPatchR: { value: PATCH_RADIUS_M },
			uSunDirLocal: { value: new THREE.Vector3(0, 0, 1) },
			uMoonDirLocal: { value: new THREE.Vector3(0, 0, -1) },
			uCamLocal: { value: new THREE.Vector3(0, 0, 1000) },
			uSunColor: { value: new THREE.Vector3(1, 0.97, 0.92) },
			uMoonColor: { value: new THREE.Vector3(0.68, 0.76, 1.0) },
			uMoonLevel: { value: 0 },
			uSkyZenith: { value: new THREE.Vector3(0.09, 0.20, 0.45) },
			uSkyHorizon: { value: new THREE.Vector3(0.50, 0.61, 0.73) },
			uHazeColor: { value: new THREE.Vector3(0.62, 0.72, 0.86) },
			uSunLevel: { value: 1 },
			uHazeScale: { value: HAZE_SCALE },
			uWaveRms: { value: WAVE_RMS_M },
			uTime: { value: 0 },
			uEncode: { value: 1 },
			uAlpha: { value: 1 },
		},
	});

	_mesh = new THREE.Mesh(geo, _mat);
	_mesh.matrixAutoUpdate = false;
	_mesh.frustumCulled = false;
	_mesh.renderOrder = -1;
	_mesh.visible = false;
	scene.add(_mesh);
}

export function setOceanEnabled(on) { _enabledSetting = !!on; if (_mesh && !on) _mesh.visible = false; }
export function isOceanEnabled() { return _enabledSetting; }

// ---- Sky / sun palette ------------------------------------------------------
// The sea is mostly a mirror, so its colour is the sky's colour. These keys are
// linear radiances for the zenith, the horizon band, and the direct sun, at a
// handful of solar elevations; `_skyPalette` interpolates between the bracketing
// pair. Deliberately the same story dynamicLighting tells the rest of the scene
// (neutral high sun → gold → deep orange at the horizon → cold blue below it) so
// the water agrees with the sky it is reflecting.
//
//        elevDeg   zenith                 horizon                sun                  level
const SKY_KEYS = [
	[ -14, [0.009, 0.015, 0.036], [0.026, 0.038, 0.072], [0.20, 0.26, 0.42], 0.00 ],
	[  -5, [0.020, 0.035, 0.082], [0.090, 0.088, 0.140], [0.50, 0.40, 0.44], 0.04 ],
	[   0, [0.050, 0.078, 0.175], [0.520, 0.290, 0.185], [1.00, 0.46, 0.22], 0.35 ],
	[   7, [0.072, 0.145, 0.330], [0.760, 0.560, 0.410], [1.00, 0.74, 0.50], 0.80 ],
	[  22, [0.055, 0.145, 0.420], [0.400, 0.540, 0.720], [1.00, 0.94, 0.86], 1.00 ],
	[  70, [0.048, 0.135, 0.440], [0.330, 0.480, 0.690], [1.00, 0.99, 0.96], 1.00 ],
];

// The "broad daylight" key — what arcade lighting is lifted toward after dark.
const DAY_KEY = SKY_KEYS[4];

const _pal = { zen: [0, 0, 0], hor: [0, 0, 0], sun: [0, 0, 0], level: 1 };

function _skyPalette(elevDeg, out) {
	let i = 0;
	while (i < SKY_KEYS.length - 2 && elevDeg > SKY_KEYS[i + 1][0]) i++;
	const a = SKY_KEYS[i], b = SKY_KEYS[i + 1];
	const t = Math.max(0, Math.min(1, (elevDeg - a[0]) / (b[0] - a[0])));
	for (let c = 0; c < 3; c++) {
		out.zen[c] = a[1][c] + (b[1][c] - a[1][c]) * t;
		out.hor[c] = a[2][c] + (b[2][c] - a[2][c]) * t;
		out.sun[c] = a[3][c] + (b[3][c] - a[3][c]) * t;
	}
	out.level = a[4] + (b[4] - a[4]) * t;
	return out;
}

// How lit the world "should" look at this solar elevation if we were being
// realistic — mirrors dynamicLighting's own ramp. Compared against the
// dayFactor we're handed, the gap tells us the player is in arcade lighting
// (which holds the whole scene bright after dark); we lift the sea's palette by
// that gap so it doesn't end up the one pitch-black surface in a bright night.
// Kept numerically identical to dynamicLighting's _intensityForElevation: the
// comparison below only means anything if both sides ramp the same way.
function _realisticDayFactor(elevDeg) {
	if (elevDeg >= 5)   return 1.0;
	if (elevDeg <= -10) return 0.05;
	return 0.05 + 0.95 * ((elevDeg + 10) / 15);
}

// The RENDERED water surface reads THE sea reference, same as the hulls
// floating on it and the munitions skimming over it. This used to be a
// fourth private copy of the lookup, seeded with a hardcoded 20 m — so
// before the first sample resolved, the visible ocean, the ships and their
// missiles could each be drawn against a different sea level.
function _seaHeightAt(lon, lat) {
	const h = seaSurfaceHeightAt(_viewer, lon, lat);
	if (h != null) { _lastSeaH = h; return h; }
	return _lastSeaH;
}

// Per-frame update. MUST run after the frame's camera is placed (same viewMatrix
// Cesium renders with). When enabled it also advances both FFT cascades.
export function updateOcean(simTime, dayFactor) {
	if (!_mesh || _ffts.length < 2) return;
	if (!_enabledSetting) { _mesh.visible = false; return; }
	const viewer = _viewer;
	if (!viewer || !viewer.camera) { _mesh.visible = false; return; }

	const camCarto = viewer.camera.positionCartographic;
	if (!camCarto) { _mesh.visible = false; return; }
	const camLon = Cesium.Math.toDegrees(camCarto.longitude);
	const camLat = Cesium.Math.toDegrees(camCarto.latitude);
	const camAlt = camCarto.height;

	if (_originLon == null) {
		_originLon = camLon; _originLat = camLat;
		_cosOrigin = Math.cos(camLat * Math.PI / 180);
	}

	// Patch centre = camera nadir, snapped to the grid (world-stable tessellation).
	let dE = (camLon - _originLon) * 111320 * _cosOrigin;
	let dN = (camLat - _originLat) * 111320;
	dE = Math.round(dE / CELL_M) * CELL_M;
	dN = Math.round(dN / CELL_M) * CELL_M;
	const centerLon = _originLon + dE / (111320 * _cosOrigin);
	const centerLat = _originLat + dN / 111320;

	const seaH = _seaHeightAt(centerLon, centerLat);
	const camAGL = camAlt - seaH;
	const overWater = seaH < SEA_LEVEL_MAX_M;
	if (!overWater || camAGL > FADE_TOP_M) { _mesh.visible = false; return; }

	const alpha = 1.0 - smoothstep01(FADE_BOTTOM_M, FADE_TOP_M, camAGL);
	if (alpha <= 0.001) { _mesh.visible = false; return; }

	// Advance both FFT cascades and bind their textures (only while visible).
	const f0 = _ffts[0].update(simTime);
	const f1 = _ffts[1].update(simTime);
	_mat.uniforms.uDispY0.value = f0.displacementY; _mat.uniforms.uDispX0.value = f0.displacementX; _mat.uniforms.uDispZ0.value = f0.displacementZ;
	_mat.uniforms.uDispY1.value = f1.displacementY; _mat.uniforms.uDispX1.value = f1.displacementX; _mat.uniforms.uDispZ1.value = f1.displacementZ;

	// Model matrix: ENU→ECEF at the snapped sea-level centre.
	Cesium.Cartesian3.fromDegrees(centerLon, centerLat, seaH, undefined, _scratchCenter);
	Cesium.Transforms.eastNorthUpToFixedFrame(_scratchCenter, undefined, _scratchModel);

	// Camera position in the patch's local ENU frame (for the view vector).
	Cesium.Matrix4.inverseTransformation(_scratchModel, _scratchInv);
	Cesium.Matrix4.multiplyByPoint(_scratchInv, viewer.camera.positionWC, _scratchCamL);
	_mat.uniforms.uCamLocal.value.set(_scratchCamL.x, _scratchCamL.y, _scratchCamL.z);

	// Sun direction in the same local ENU frame, and the sky it implies.
	sunDirectionENU(viewer.clock.currentTime, centerLon, centerLat, seaH, _sunOut);
	_mat.uniforms.uSunDirLocal.value.set(_sunOut.e, _sunOut.n, _sunOut.u);

	const df = (dayFactor == null ? 1 : dayFactor);
	_skyPalette(_sunOut.elevDeg, _pal);
	// Arcade lighting keeps the whole scene bright after dark; follow it rather
	// than leaving the sea as the one black hole in a lit night scene.
	const lift = Math.max(0, Math.min(1, df - _realisticDayFactor(_sunOut.elevDeg))) * 0.75;
	const u = _mat.uniforms;
	u.uSkyZenith.value.set(
		_pal.zen[0] + (DAY_KEY[1][0] - _pal.zen[0]) * lift,
		_pal.zen[1] + (DAY_KEY[1][1] - _pal.zen[1]) * lift,
		_pal.zen[2] + (DAY_KEY[1][2] - _pal.zen[2]) * lift);
	u.uSkyHorizon.value.set(
		_pal.hor[0] + (DAY_KEY[2][0] - _pal.hor[0]) * lift,
		_pal.hor[1] + (DAY_KEY[2][1] - _pal.hor[1]) * lift,
		_pal.hor[2] + (DAY_KEY[2][2] - _pal.hor[2]) * lift);
	u.uSunColor.value.set(
		_pal.sun[0] + (DAY_KEY[3][0] - _pal.sun[0]) * lift,
		_pal.sun[1] + (DAY_KEY[3][1] - _pal.sun[1]) * lift,
		_pal.sun[2] + (DAY_KEY[3][2] - _pal.sun[2]) * lift);
	u.uSunLevel.value = _pal.level + (1 - _pal.level) * lift;

	// Moon: direction + how hard it's shining (phase × horizon fade). At night
	// this is the whole difference between "the ships are floating on a black
	// void" and "the ships are on water".
	moonDirectionENU(viewer.clock.currentTime, centerLon, centerLat, seaH, _moonOut);
	u.uMoonDirLocal.value.set(_moonOut.e, _moonOut.n, _moonOut.u);
	u.uMoonLevel.value = _moonOut.level;
	// A low moon reddens for exactly the reason a low sun does — more air to
	// get through — and it's a big part of why a moonrise over water reads.
	const mWarm = 1 - smoothstep01(0, 22, _moonOut.elevDeg);
	u.uMoonColor.value.set(
		0.68 + (1.00 - 0.68) * mWarm,
		0.76 + (0.70 - 0.76) * mWarm,
		1.00 + (0.52 - 1.00) * mWarm);

	// Aerial-perspective target = the scene's own fog colour, which
	// dynamicLighting already drives off sun elevation and look-vs-sun. Sharing
	// it is what lets the far edge of the patch sit down onto Cesium's water
	// instead of ending on a line of a different blue.
	if (_scene && _scene.fog && _scene.fog.color) {
		const fc = _scene.fog.color;
		u.uHazeColor.value.set(fc.r, fc.g, fc.b);
	}
	u.uTime.value = simTime;
	u.uEncode.value = isTakramReady() ? 0 : 1;

	// Bake camera-space matrix = cesiumViewMatrix × modelMatrix (identity Three cam).
	Cesium.Matrix4.multiply(viewer.camera.viewMatrix, _scratchModel, _scratchCamSpace);
	for (let i = 0; i < 16; i++) _mesh.matrix.elements[i] = _scratchCamSpace[i];
	_mesh.updateMatrixWorld(true);

	_mat.uniforms.uCenterOffset.value.set(dE, dN);
	_mat.uniforms.uAlpha.value = alpha;
	_mesh.visible = true;
}

// TEMP: dev-only handle for ocean-lab.html
export const __oceanShaders = {
	VERT, FRAG, CASCADES, WAVE_SCALE, CHOPPY_SCALE, NORMAL_STRENGTH,
	WAVE_RMS_M, HAZE_SCALE, PATCH_RADIUS_M, SEGMENTS, EARTH_R, DAY_KEY,
	get mat() { return _mat; }, get mesh() { return _mesh; },
	realisticDayFactor: _realisticDayFactor,
	skyPalette: (elev) => _skyPalette(elev, { zen: [0, 0, 0], hor: [0, 0, 0], sun: [0, 0, 0], level: 1 }),
};

function smoothstep01(edge0, edge1, x) {
	const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
	return t * t * (3 - 2 * t);
}
