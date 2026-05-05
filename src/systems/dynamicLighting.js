// ============================================================================
// Dynamic lighting — drive the THREE.js scene lights from the real sun
// position computed at the player's lat/lon for the current Cesium clock.
//
// Two modes (gameSettings.lightingMode):
//
//   'arcade'    — full bright always (ambient 1.0, directional 1.0).
//                 The historical default; everything's clearly visible at
//                 night so gameplay clarity isn't sacrificed for vibes.
//   'realistic' — intensity ramps with sun elevation:
//                   > +5°            full daylight (1.0)
//                   +5° → -10°       linear ramp 1.0 → 0.05 (twilight)
//                   < -10°           floor at 0.05 (deep night)
//                 At night the in-world objects become silhouettes;
//                 engine flames + tracers + missile motors + explosions
//                 still pop because they use unlit MeshBasicMaterial and
//                 are their own light sources.
//
// The Cesium globe already has `enableLighting = true` so terrain dims at
// night on its own — this module brings the THREE-rendered objects
// (planes, missiles, particles using lit materials) in line with that.
// ============================================================================

import * as Cesium from 'cesium';
import { gameSettings } from '../ui/settings.js';
import { getViewer } from '../world/cesiumWorld.js';
import { isNvgActive } from '../ui/nvg.js';

let _ambient = null;
let _directional = null;
// Latest computed daylight factor (0.05 .. 1.0). Exported via
// getDayFactor() so MeshBasicMaterial-using effects (smoke trails,
// contrails, particle puffs) can dim themselves — they're unlit and
// don't respond to AmbientLight / DirectionalLight intensity.
let _dayFactor = 1.0;
// Track the last applied lighting mode so we don't fight Cesium's
// internal change-detection on every frame: only push globe property
// updates when the mode actually flips.
let _lastModeApplied = null;

// Scratch math objects — re-used every frame.
const _scratchSunICRF  = new Cesium.Cartesian3();
const _scratchPlayerECEF = new Cesium.Cartesian3();
const _scratchSunDir   = new Cesium.Cartesian3();
const _scratchEnuMat   = new Cesium.Matrix4();
const _scratchUpVec    = new Cesium.Cartesian3();
const _scratchIcrfFix  = new Cesium.Matrix3();

// Register the lights once at scene bring-up. The scene module owns the
// Light instances; this module just holds references and mutates their
// .intensity each frame. We also stash the AmbientLight's base color
// so realistic mode can tint cool at night without permanent drift.
export function setLights(ambient, directional) {
	_ambient = ambient;
	_directional = directional;
}

// Compute sun elevation angle (degrees above horizon) at `lat, lon` for
// the given Cesium JulianDate. Uses Simon1994 sun-position + ICRF-to-
// fixed matrix; if the EOP data isn't loaded yet we fall back to the
// TEME→pseudo-fixed approximation, which is accurate to a few arcmin
// — well within the ramp band's tolerance.
function _sunElevationDeg(time, lon, lat, alt) {
	Cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(time, _scratchSunICRF);
	const ok = Cesium.Transforms.computeIcrfToFixedMatrix(time, _scratchIcrfFix)
		|| Cesium.Transforms.computeTemeToPseudoFixedMatrix(time, _scratchIcrfFix);
	if (!ok) {
		// No transform available — bail to "noon" so we don't suddenly
		// black out the world while the EOP data is loading.
		return 90;
	}
	Cesium.Matrix3.multiplyByVector(_scratchIcrfFix, _scratchSunICRF, _scratchSunICRF);

	Cesium.Cartesian3.fromDegrees(lon, lat, alt || 0, undefined, _scratchPlayerECEF);
	Cesium.Cartesian3.subtract(_scratchSunICRF, _scratchPlayerECEF, _scratchSunDir);
	Cesium.Cartesian3.normalize(_scratchSunDir, _scratchSunDir);

	Cesium.Transforms.eastNorthUpToFixedFrame(_scratchPlayerECEF, undefined, _scratchEnuMat);
	// ENU "up" is the third column of the eastNorthUpToFixedFrame matrix.
	_scratchUpVec.x = _scratchEnuMat[ 8];
	_scratchUpVec.y = _scratchEnuMat[ 9];
	_scratchUpVec.z = _scratchEnuMat[10];
	// (Already unit-length because eastNorthUpToFixedFrame builds an
	// orthonormal basis.)

	const sinElev = Math.max(-1, Math.min(1, Cesium.Cartesian3.dot(_scratchSunDir, _scratchUpVec)));
	return Math.asin(sinElev) * 180 / Math.PI;
}

// Map sun elevation (degrees) to a 0..1 daylight factor.
//   ≥ +5°            : 1.0  (full day)
//   +5° → -10°       : linear ramp down to 0.05
//   ≤ -10°           : 0.05 (deep night floor — moonlight + atmosphere)
function _intensityForElevation(elevDeg) {
	const NIGHT_FLOOR = 0.05;
	if (elevDeg >= 5)   return 1.0;
	if (elevDeg <= -10) return NIGHT_FLOOR;
	const t = (elevDeg + 10) / 15;   // -10..+5  ->  0..1
	return NIGHT_FLOOR + (1.0 - NIGHT_FLOOR) * t;
}

// Apply Cesium-globe lighting properties for the current mode. The
// globe's `enableLighting` shading dims terrain by sun angle, but
// alone it's not enough — the night-side imagery still reads bright
// because the underlying imagery layer has full default brightness.
// We layer THREE knobs:
//
//   1. globe.atmosphereLightIntensity (default 10 → 1.5 in realistic):
//      kills atmospheric fill that would otherwise glow the night side.
//   2. globe.dynamicAtmosphereLightingFromSun = true: track the sun
//      explicitly rather than scene.light direction.
//   3. imageryLayers[*].brightness = dayFactor (per frame in realistic
//      mode): the heavy hitter — multiplies the rendered terrain
//      imagery uniformly. dayFactor=1 at noon ⇒ no change; dayFactor
//      =0.05 at deep night ⇒ terrain at 5% brightness.
//
// (1) + (2) only need to change on mode flip; (3) updates per frame.
function _applyCesiumLightingMode(viewer, mode) {
	if (!viewer || !viewer.scene || !viewer.scene.globe) return;
	if (_lastModeApplied === mode) return;
	const globe = viewer.scene.globe;
	if (mode === 'realistic') {
		globe.dynamicAtmosphereLightingFromSun = true;
		globe.atmosphereLightIntensity = 1.5;
	} else {
		globe.dynamicAtmosphereLightingFromSun = false;
		globe.atmosphereLightIntensity = 10.0;
		// Restore imagery brightness when flipping back to arcade —
		// otherwise the previous frame's dimmed value sticks.
		const layers = viewer.scene.imageryLayers;
		if (layers) {
			for (let i = 0; i < layers.length; i++) {
				const L = layers.get(i);
				if (L) L.brightness = 1.0;
			}
		}
	}
	_lastModeApplied = mode;
}

// Per-frame imagery-layer brightness pass for realistic mode. Cheap
// — walking ~1-2 layers and assigning a number. Cesium internally
// dirty-flags the layer so unchanged values cost nothing.
function _applyImageryBrightness(viewer, dayFactor) {
	if (!viewer || !viewer.scene) return;
	const layers = viewer.scene.imageryLayers;
	if (!layers) return;
	for (let i = 0; i < layers.length; i++) {
		const L = layers.get(i);
		if (L) L.brightness = dayFactor;
	}
}

// Current day factor, 0.05 (deep night) .. 1.0 (full day). Read by
// trail / contrail / particle code that uses unlit materials so they
// can dim with the environment instead of staying full-bright.
export function getDayFactor() {
	return _dayFactor;
}

// Per-frame entry point. Cheap when the mode is 'arcade' — we still set
// the intensities to 1.0 so a mid-game toggle off → on takes effect on
// the very next frame instead of needing a relight.
export function updateLighting(playerState) {
	if (!_ambient || !_directional) return;
	// NVG amplifies dim light to readable levels. We model that by
	// forcing the underlying scene to arcade-bright while NVG is on
	// — the green-phosphor wash + grain in nvg.js then turns that
	// bright scene into the stylised tube look. Without this the
	// realistic-mode terrain is so dark that brightness(4) on top
	// only barely lifts it.
	const requestedMode = gameSettings.lightingMode || 'arcade';
	const mode = isNvgActive() ? 'arcade' : requestedMode;
	const viewer = getViewer();
	_applyCesiumLightingMode(viewer, mode);

	if (mode !== 'realistic') {
		_dayFactor = 1.0;
		_ambient.intensity = 1.0;
		_directional.intensity = 1.0;
		// Reset to the original neutral white in case a previous
		// realistic-mode frame had tinted them blue.
		_ambient.color.setRGB(1, 1, 1);
		return;
	}

	if (!viewer || !playerState) {
		// No clock / position yet — fall back to arcade-bright so the
		// menu screen isn't pitch black.
		_dayFactor = 1.0;
		_ambient.intensity = 1.0;
		_directional.intensity = 1.0;
		return;
	}

	const elev = _sunElevationDeg(viewer.clock.currentTime,
		playerState.lon || 0, playerState.lat || 0, playerState.alt || 0);
	_dayFactor = _intensityForElevation(elev);

	_ambient.intensity     = _dayFactor;
	_directional.intensity = _dayFactor;
	_applyImageryBrightness(viewer, _dayFactor);

	// Cool-blue tint at night, warm at sunrise/sunset, neutral at noon.
	// Compute on the (1.0 - dayFactor) axis so the colour shift is most
	// pronounced when intensity is lowest.
	const nightWeight = 1 - _dayFactor;
	const r = 1.0 - 0.4 * nightWeight;
	const g = 1.0 - 0.25 * nightWeight;
	const b = 1.0;
	_ambient.color.setRGB(r, g, b);
}
