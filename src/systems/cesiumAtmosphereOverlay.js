// ============================================================================
// Cesium atmospheric-haze overlay — sun-direction-aware aerial perspective
// applied to the GLOBE render via a custom PostProcessStage.
//
// Solves the "takram only affects Three.js objects" problem from the
// other direction: while we can't reach Cesium's pixels from the
// takram EffectComposer (different canvas, different GL context), we
// CAN add our own fragment shader to Cesium's own postprocess pipeline
// using `viewer.scene.postProcessStages.add(...)`. That shader gets
// the rendered scene texture + depth texture as inputs, plus all the
// `czm_*` automatic uniforms (inverseViewProjection, viewerPositionWC,
// etc.) and produces the final pixel.
//
// The shader does a simple sun-direction-aware aerial-perspective
// approximation:
//
//   - Reconstruct world-space position per fragment from depth.
//   - Distance from camera → exponential fog factor.
//   - View-direction · sun-direction → "looking toward sun" weight.
//   - Lerp between warm (sunset) and cool (anti-sun) haze colors
//     based on that weight; lerp scene color toward fog color by
//     the fog factor.
//
// Per-frame uniform updates come from dynamicLighting so the haze
// palette matches what the takram effect paints on Three.js objects
// — one coherent atmosphere across both renderers.
// ============================================================================

import * as Cesium from 'cesium';

const FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform vec3 u_sunDirECEF;
uniform vec3 u_warmColor;
uniform vec3 u_coolColor;
uniform float u_density;
uniform float u_warmthBias;
uniform float u_intensity;
in vec2 v_textureCoordinates;

void main() {
	vec4 sceneColor = texture(colorTexture, v_textureCoordinates);
	float rawDepth = czm_readDepth(depthTexture, v_textureCoordinates);

	// Sky / no-geometry pixels: skip (depth = 1 = far plane).
	// We don't want to fog the sky tile itself because Cesium's
	// skyAtmosphere already does sunset colours on the dome.
	if (rawDepth >= 1.0 - 1e-6) {
		out_FragColor = sceneColor;
		return;
	}

	// Reconstruct ECEF world position from screen-space depth.
	// Cesium's coordinate system is column-major; czm_inverseViewProjection
	// is the matrix that undoes the camera transform.
	vec4 clip = vec4(
		v_textureCoordinates * 2.0 - 1.0,
		rawDepth * 2.0 - 1.0,
		1.0
	);
	vec4 worldH = czm_inverseViewProjection * clip;
	vec3 worldPos = worldH.xyz / worldH.w;

	vec3 cameraToFrag = worldPos - czm_viewerPositionWC;
	float dist = length(cameraToFrag);
	vec3 viewDir = cameraToFrag / max(dist, 1.0);

	// Exponential aerial-perspective fog factor (FogExp2-like).
	// Scales with distance — typical effective range is set by
	// u_density on the JS side, altitude-attenuated.
	float fog = 1.0 - exp(-u_density * dist);
	fog = clamp(fog * u_intensity, 0.0, 1.0);

	// Warmth weight: 1 when the view ray is aligned with the sun,
	// 0 when looking away. Biased toward neutral by u_warmthBias
	// so we never wash the entire scene one color even at noon.
	float towardSun = max(0.0, dot(viewDir, u_sunDirECEF));
	towardSun = mix(0.5, towardSun, u_warmthBias);

	vec3 fogColor = mix(u_coolColor, u_warmColor, towardSun);

	vec3 result = mix(sceneColor.rgb, fogColor, fog);
	out_FragColor = vec4(result, sceneColor.a);
}
`;

let _stage = null;
let _viewer = null;
let _enabled = true;

// Public — call once at boot. Builds the PostProcessStage and adds
// it to Cesium's pipeline so every frame after this gets the haze
// pass applied to the globe render.
export function initCesiumAtmosphereOverlay(viewer) {
	if (_stage) return;
	_viewer = viewer;
	if (!viewer || !viewer.scene || !viewer.scene.postProcessStages) return;
	try {
		_stage = new Cesium.PostProcessStage({
			fragmentShader: FRAGMENT_SHADER,
			uniforms: {
				u_sunDirECEF: new Cesium.Cartesian3(0, 0, 1),
				u_warmColor:  new Cesium.Cartesian3(1.0, 0.55, 0.35),
				u_coolColor:  new Cesium.Cartesian3(0.55, 0.62, 0.95),
				u_density:    0.00002,
				u_warmthBias: 0.7,
				u_intensity:  1.0,
			},
			name: 'flightsim_atmosphere_overlay',
		});
		viewer.scene.postProcessStages.add(_stage);
		_stage.enabled = _enabled;
	} catch (e) {
		console.warn('[cesiumAtmosphereOverlay] init failed:', e);
		_stage = null;
	}
}

export function setCesiumAtmosphereOverlayEnabled(on) {
	_enabled = !!on;
	if (_stage) _stage.enabled = _enabled;
}

export function isCesiumAtmosphereOverlayActive() {
	return !!(_stage && _stage.enabled);
}

// Per-frame uniform update. Called from dynamicLighting so the haze
// palette + density tracks the same sun-elevation curves as the
// takram aerial perspective on Three.js objects + the directional
// light on the airframe.
//
//   sunECEF      Cesium.Cartesian3 in ECEF (unit vector)
//   warm         { r, g, b } 0..1 — warm haze color (sunset)
//   cool         { r, g, b } 0..1 — cool haze color (anti-sun)
//   density      scalar fog density coefficient
//   warmthBias   0..1, how much sun-direction tints the haze
//                (0 = neutral mid-grey, 1 = full directional)
//   intensity    overall multiplier, 0 disables visually
export function updateCesiumAtmosphereOverlay(sunECEF, warm, cool, density, warmthBias, intensity) {
	if (!_stage) return;
	const u = _stage.uniforms;
	if (sunECEF) {
		u.u_sunDirECEF.x = sunECEF.x;
		u.u_sunDirECEF.y = sunECEF.y;
		u.u_sunDirECEF.z = sunECEF.z;
	}
	if (warm) {
		u.u_warmColor.x = warm.r;
		u.u_warmColor.y = warm.g;
		u.u_warmColor.z = warm.b;
	}
	if (cool) {
		u.u_coolColor.x = cool.r;
		u.u_coolColor.y = cool.g;
		u.u_coolColor.z = cool.b;
	}
	if (typeof density === 'number')    u.u_density    = density;
	if (typeof warmthBias === 'number') u.u_warmthBias = warmthBias;
	if (typeof intensity === 'number')  u.u_intensity  = intensity;
}
