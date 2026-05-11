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
let _fog = null;       // THREE.FogExp2 ref — color + density driven per frame
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

// Register the THREE.FogExp2 instance so we can drive its color and
// density each frame from sun state + altitude. Pure visual — fog
// only affects in-world objects (NPCs, missiles, particles) and not
// the airframe at chase distance.
export function setFog(fog) {
	_fog = fog;
}

// Compute sun direction in the player's local ENU frame at `lat, lon`
// for the given Cesium JulianDate. Returns components into `out` plus
// the elevation angle (degrees above horizon). Uses Simon1994 sun-
// position + ICRF-to-fixed matrix; if EOP data isn't loaded yet we
// fall back to the TEME→pseudo-fixed approximation, which is accurate
// to a few arcmin — well within the ramp band's tolerance.
function _sunDirectionENU(time, lon, lat, alt, out) {
	Cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(time, _scratchSunICRF);
	const ok = Cesium.Transforms.computeIcrfToFixedMatrix(time, _scratchIcrfFix)
		|| Cesium.Transforms.computeTemeToPseudoFixedMatrix(time, _scratchIcrfFix);
	if (!ok) {
		// No transform available — bail to "noon overhead" so we
		// don't suddenly black out the world while the EOP data
		// is loading.
		out.e = 0; out.n = 0; out.u = 1; out.elevDeg = 90;
		return out;
	}
	Cesium.Matrix3.multiplyByVector(_scratchIcrfFix, _scratchSunICRF, _scratchSunICRF);

	Cesium.Cartesian3.fromDegrees(lon, lat, alt || 0, undefined, _scratchPlayerECEF);
	Cesium.Cartesian3.subtract(_scratchSunICRF, _scratchPlayerECEF, _scratchSunDir);
	Cesium.Cartesian3.normalize(_scratchSunDir, _scratchSunDir);

	Cesium.Transforms.eastNorthUpToFixedFrame(_scratchPlayerECEF, undefined, _scratchEnuMat);
	// Columns of the 4×4 ENU→Fixed matrix are the ENU axes in ECEF:
	//   E = (m[0], m[1], m[2])
	//   N = (m[4], m[5], m[6])
	//   U = (m[8], m[9], m[10])
	// Project the ECEF sun direction onto each axis to get its
	// components in the local ENU frame.
	const sd = _scratchSunDir;
	const m = _scratchEnuMat;
	out.e = sd.x * m[0] + sd.y * m[1] + sd.z * m[2];
	out.n = sd.x * m[4] + sd.y * m[5] + sd.z * m[6];
	out.u = sd.x * m[8] + sd.y * m[9] + sd.z * m[10];
	out.elevDeg = Math.asin(Math.max(-1, Math.min(1, out.u))) * 180 / Math.PI;
	return out;
}
const _sunOut = { e: 0, n: 0, u: 1, elevDeg: 90 };

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

// ---- Colour-temperature ramps ----------------------------------------------
//
// The directional light models the SUN — colour ramps from neutral white
// at zenith → golden in the afternoon → deep red-orange at the horizon →
// cool blue moonlight when below. Approximates blackbody radiation:
//
//   ~6500 K  high sun        (1.00, 1.00, 1.00)
//   ~5200 K  late afternoon  (1.00, 0.92, 0.80)
//   ~3500 K  golden hour     (1.00, 0.78, 0.55)
//   ~2200 K  sunset peak     (1.00, 0.55, 0.30)
//   moon     below horizon   (0.55, 0.65, 0.85)
//
// The ambient light models the SKY — complementary cool blue while the
// sun is warm so highlights / shadows on the player plane have proper
// dual-source colour, then deep blue at night. At noon both sources are
// near-white because direct sun + diffuse sky are both broadly neutral.
function _smoothstep(a, b, x) {
	const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
}
function _lerp3(out, a, b, t) {
	out.r = a[0] + (b[0] - a[0]) * t;
	out.g = a[1] + (b[1] - a[1]) * t;
	out.b = a[2] + (b[2] - a[2]) * t;
	return out;
}

const _scratchColor = { r: 1, g: 1, b: 1 };

// Directional (sun) colour at a given elevation.
function _sunColor(elevDeg, out) {
	const NOON     = [1.00, 1.00, 1.00];
	const LATE_PM  = [1.00, 0.92, 0.80];
	const GOLDEN   = [1.00, 0.78, 0.55];
	const SUNSET   = [1.00, 0.55, 0.30];
	const MOON     = [0.55, 0.65, 0.85];
	if (elevDeg >= 30) return _lerp3(out, NOON,   NOON,    0);
	if (elevDeg >= 15) return _lerp3(out, LATE_PM, NOON,    _smoothstep(15, 30, elevDeg));
	if (elevDeg >= 5)  return _lerp3(out, GOLDEN,  LATE_PM, _smoothstep(5,  15, elevDeg));
	if (elevDeg >= -3) return _lerp3(out, SUNSET,  GOLDEN,  _smoothstep(-3, 5,  elevDeg));
	if (elevDeg >= -8) return _lerp3(out, MOON,    SUNSET,  _smoothstep(-8, -3, elevDeg));
	return _lerp3(out, MOON, MOON, 0);
}

// Ambient (sky) colour at a given elevation. Cooler than sun in the
// afternoon (sky is blue while sun is warm); deep blue at night.
function _skyColor(elevDeg, out) {
	const NOON     = [0.95, 0.97, 1.00];   // very faint blue tint at noon
	const PM       = [0.80, 0.88, 1.00];   // afternoon — visible cool sky
	const TWILIGHT = [0.55, 0.62, 0.95];   // dusk / civil twilight blue
	const NIGHT    = [0.45, 0.55, 0.85];   // deep cold-blue moonlight
	if (elevDeg >= 30)  return _lerp3(out, NOON,     NOON,     0);
	if (elevDeg >= 10)  return _lerp3(out, PM,       NOON,     _smoothstep(10, 30, elevDeg));
	if (elevDeg >= 0)   return _lerp3(out, TWILIGHT, PM,       _smoothstep(0,  10, elevDeg));
	if (elevDeg >= -10) return _lerp3(out, NIGHT,    TWILIGHT, _smoothstep(-10, 0, elevDeg));
	return _lerp3(out, NIGHT, NIGHT, 0);
}

// Aerial-perspective fog colour. Two interpolated palettes blended
// by sun elevation, then a *forward-vs-back* warm/cool blend keyed
// on whether the player is looking toward or away from the sun.
//
// Looking TOWARD the sun at sunset → fog inscatters warm orange
// (real "atmosphere catches the sunlight then bounces it at you").
// Looking AWAY → cool blue/purple (Earth's shadow side of the
// atmosphere is what you see when the sun is behind you).
//
// `sunForward` is the body-frame forward component of the sun
// direction: +1 = sun directly ahead, -1 = directly behind.
function _fogColor(elevDeg, sunForward, out) {
	// Day palette
	const DAY_TOWARD = [1.00, 0.95, 0.85];   // hazy white-warm
	const DAY_AWAY   = [0.65, 0.78, 0.95];   // pale sky blue
	// Sunset / golden hour
	const SUNSET_TOWARD = [1.00, 0.55, 0.35]; // deep orange near horizon
	const SUNSET_AWAY   = [0.45, 0.50, 0.75]; // purple-blue (anti-sun arch)
	// Night
	const NIGHT         = [0.10, 0.13, 0.22];

	// Per-aspect day vs sunset palettes, picked by elevation.
	let towardR, towardG, towardB, awayR, awayG, awayB;
	if (elevDeg >= 15) {
		towardR = DAY_TOWARD[0]; towardG = DAY_TOWARD[1]; towardB = DAY_TOWARD[2];
		awayR   = DAY_AWAY[0];   awayG   = DAY_AWAY[1];   awayB   = DAY_AWAY[2];
	} else if (elevDeg >= -2) {
		const t = _smoothstep(-2, 15, elevDeg);
		towardR = SUNSET_TOWARD[0] + (DAY_TOWARD[0] - SUNSET_TOWARD[0]) * t;
		towardG = SUNSET_TOWARD[1] + (DAY_TOWARD[1] - SUNSET_TOWARD[1]) * t;
		towardB = SUNSET_TOWARD[2] + (DAY_TOWARD[2] - SUNSET_TOWARD[2]) * t;
		awayR   = SUNSET_AWAY[0]   + (DAY_AWAY[0]   - SUNSET_AWAY[0])   * t;
		awayG   = SUNSET_AWAY[1]   + (DAY_AWAY[1]   - SUNSET_AWAY[1])   * t;
		awayB   = SUNSET_AWAY[2]   + (DAY_AWAY[2]   - SUNSET_AWAY[2])   * t;
	} else {
		const t = _smoothstep(-10, -2, elevDeg);
		towardR = NIGHT[0] + (SUNSET_TOWARD[0] - NIGHT[0]) * t;
		towardG = NIGHT[1] + (SUNSET_TOWARD[1] - NIGHT[1]) * t;
		towardB = NIGHT[2] + (SUNSET_TOWARD[2] - NIGHT[2]) * t;
		awayR   = NIGHT[0] + (SUNSET_AWAY[0]   - NIGHT[0]) * t;
		awayG   = NIGHT[1] + (SUNSET_AWAY[1]   - NIGHT[1]) * t;
		awayB   = NIGHT[2] + (SUNSET_AWAY[2]   - NIGHT[2]) * t;
	}
	// Blend toward / away by sunForward ∈ [-1, +1]. Remap to [0, 1].
	const f = Math.max(0, Math.min(1, (sunForward + 1) * 0.5));
	out.r = awayR + (towardR - awayR) * f;
	out.g = awayG + (towardG - awayG) * f;
	out.b = awayB + (towardB - awayB) * f;
	return out;
}

// Fog density attenuated by altitude — real atmospheric optical
// depth drops roughly exponentially with altitude (scale height
// ~8.5 km). Sea-level FogExp2 density ~2e-5 gives noticeable haze
// at 30-50 km of horizontal distance; at 12 km altitude that
// drops by e^(-12/8.5) ≈ 0.24× so the air clears up the way it
// really does.
function _fogDensity(altMeters, sceneMode) {
	const baseSea = 0.00002;
	const scaleH  = 8500;
	const density = baseSea * Math.exp(-(altMeters || 0) / scaleH);
	// Arcade mode keeps a very gentle haze — enough to give a
	// volumetric feel but not so much that BVR targets disappear
	// before you've earned the radar contact.
	if (sceneMode === 'arcade') return density * 0.35;
	return density;
}

// Golden-hour intensity boost on the directional light. Real low-angle
// sun looks visibly more "punchy" than mid-day because the air column
// scatters out the cool wavelengths and what remains is a focused
// warm beam. Smoothly bell around elev=2°, peaking at ~1.4× the
// base factor.
function _goldenHourBoost(elevDeg) {
	if (elevDeg <= -5 || elevDeg >= 15) return 1.0;
	const center = 2;
	const span   = 8;
	const t = 1 - Math.min(1, Math.abs(elevDeg - center) / span);
	return 1.0 + 0.4 * t * t;
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

// Apply a CSS filter to the Cesium canvas so the GLOBE's terrain
// tracks the same sunset / cool-twilight palette as the directional
// light hitting the airplane. Without this the plane goes warm-gold
// while the satellite imagery underneath stays daytime-neutral and
// the disconnect breaks the vibe.
//
// `warmth` peaks around the horizon (sepia + slight warm hue shift),
// `coolness` peaks at twilight / night (slight blue cast). Both
// are layered into a single `filter` string updated once per frame
// — Cesium's canvas reflows the filter natively, no shader work.
let _cesiumCanvasEl = null;
function _findCesiumCanvas(viewer) {
	if (_cesiumCanvasEl && _cesiumCanvasEl.isConnected) return _cesiumCanvasEl;
	// scene.canvas is the WebGL canvas Cesium owns.
	_cesiumCanvasEl = (viewer && viewer.scene && viewer.scene.canvas) || null;
	return _cesiumCanvasEl;
}
function _applyTerrainTint(viewer, elevDeg, mode) {
	const canvas = _findCesiumCanvas(viewer);
	if (!canvas) return;
	// Warmth bell: 0 above +20°, peak around 0°, decays past -5°.
	let warmth = 0;
	if (elevDeg < 20 && elevDeg > -5) {
		const span = 12;
		warmth = Math.max(0, 1 - Math.abs(elevDeg - 2) / span);
	}
	// Coolness bell: 0 above 0°, ramps up through twilight, plateaus
	// past -10°.
	let coolness = 0;
	if (elevDeg < 0) {
		coolness = Math.min(1, (-elevDeg) / 10);
	}
	// Build the filter. sepia → warm wash, hue-rotate(-deg) → push
	// toward red. Saturation bumped during golden hour to enrich the
	// terrain palette without going cartoony.
	const sepia = (0.45 * warmth).toFixed(3);
	const hueShift = (-8 * warmth).toFixed(2);
	const sat = (1 + 0.15 * warmth).toFixed(3);
	// Cool tint at twilight: sepia(small) + hue-rotate(positive deg)
	// shifts the tone toward blue. Keeps it subtle so we don't out-
	// blue the sky.
	const coolSat = (1 - 0.20 * coolness).toFixed(3);
	const coolHue = (10 * coolness).toFixed(2);
	canvas.style.filter = (warmth > 0 || coolness > 0)
		? `sepia(${sepia}) hue-rotate(${hueShift}deg) saturate(${sat}) saturate(${coolSat}) hue-rotate(${coolHue}deg)`
		: '';
}

// Current day factor, 0.05 (deep night) .. 1.0 (full day). Read by
// trail / contrail / particle code that uses unlit materials so they
// can dim with the environment instead of staying full-bright.
export function getDayFactor() {
	return _dayFactor;
}

// Per-frame entry point. Sun direction tracking, colour-temperature
// ramps, and the golden-hour directional boost run in BOTH lighting
// modes — beautiful sunsets are a cinematic feature, not a realism
// feature, and arcade-mode players should get the warm low-angle
// wash and dual-source shading just as much as realistic-mode does.
//
// What differs between the two modes:
//
//                              arcade        realistic
//   light intensity            1.0 always    ramps with sun elev
//   golden-hour boost          applied       applied
//   imagery brightness         1.0 always    ramps with sun elev
//   Cesium atmosphere fill     default       cranked down at night
//   sun direction tracking     applied       applied
//   sun + sky colour ramp      applied       applied
//
// I.e. arcade keeps the world fully visible at all times but still
// gets golden-hour warmth, sunset palettes, and properly-directed
// shadows on the airframe.
//
// NVG override (third state): forces effective mode to 'arcade'
// regardless of user setting, because we need a bright underlying
// scene for the green-phosphor filter on top to amplify.
export function updateLighting(playerState) {
	if (!_ambient || !_directional) return;
	const requestedMode = gameSettings.lightingMode || 'arcade';
	const mode = isNvgActive() ? 'arcade' : requestedMode;
	const viewer = getViewer();
	_applyCesiumLightingMode(viewer, mode);

	if (!viewer || !playerState) {
		// No clock / position yet — fall back to flat arcade-bright
		// so the menu screen / bring-up frames aren't pitch black.
		_dayFactor = 1.0;
		_ambient.intensity = 1.0;
		_directional.intensity = 1.0;
		_ambient.color.setRGB(1, 1, 1);
		_directional.color.setRGB(1, 1, 1);
		return;
	}

	_sunDirectionENU(viewer.clock.currentTime,
		playerState.lon || 0, playerState.lat || 0, playerState.alt || 0,
		_sunOut);
	const elev = _sunOut.elevDeg;
	const realisticDayFactor = _intensityForElevation(elev);

	// Intensity behaviour is the only mode-dependent piece. Arcade
	// holds 1.0 so night flights stay readable; realistic ramps down
	// to the night floor.
	_dayFactor = (mode === 'realistic') ? realisticDayFactor : 1.0;

	// Rotate the directional light to the actual sun position in the
	// player's body frame. Camera-space convention used everywhere
	// else in the THREE rendering: +X = right, +Y = up, -Z = forward.
	// The plane's body frame is rotated from ENU by the player's
	// heading (compass deg, +CW from north). Pitch + roll are
	// ignored — the chase cam pitches with the plane so the sun's
	// apparent angle from the cockpit POV is dominated by heading,
	// and including pitch made the sun "swim" during loops.
	const h = (playerState.heading || 0) * Math.PI / 180;
	const cosH = Math.cos(h), sinH = Math.sin(h);
	const sunRight   = _sunOut.e * cosH - _sunOut.n * sinH;
	const sunForward = _sunOut.e * sinH + _sunOut.n * cosH;
	const sunUp      = _sunOut.u;
	// Light position is the direction the light comes FROM relative
	// to scene origin. In camera-space: right→+X, up→+Y, forward→-Z.
	// Magnitudes are arbitrary for a directional light; we scale by
	// 100 so position-to-target lerp math stays well-conditioned.
	_directional.position.set(sunRight * 100, sunUp * 100, -sunForward * 100);
	_directional.target.position.set(0, 0, 0);
	_directional.target.updateMatrixWorld();

	// Golden-hour intensity bump on the directional light only —
	// the sun visibly punches through at low angles (focused warm
	// beam) while the diffuse sky ambient does the opposite. Applied
	// in both modes, because beautiful low-sun light is the whole
	// point of this code path.
	const goldenBoost = _goldenHourBoost(elev);
	_ambient.intensity     = _dayFactor;
	_directional.intensity = _dayFactor * goldenBoost;
	_applyImageryBrightness(viewer, mode === 'realistic'
		? Math.min(1.0, _dayFactor) : 1.0);
	// NVG owns the canvas filter while it's active — clear our
	// inline tint so the stylesheet's phosphor-green NVG rule wins,
	// and skip recomputing until NVG flips off again.
	if (isNvgActive()) {
		const c = _findCesiumCanvas(viewer);
		if (c && c.style.filter) c.style.filter = '';
	} else {
		_applyTerrainTint(viewer, elev, mode);
	}

	// Colour temperature ramps. Sun goes warm at low angles + cool
	// blue when below; sky stays cool blue, deepening at night, so
	// shadowed faces of the airframe pick up complementary colour
	// instead of a uniform dim white. In arcade mode we'd ideally
	// apply the colours straight, but that would tint a fully-bright
	// night scene blue. Lerp the colour ramp toward neutral white
	// based on (1 - dayFactor) so arcade nights stay cleanly lit
	// while sunset still gets its warm wash.
	_sunColor(elev, _scratchColor);
	const arcadeWeight = (mode === 'realistic') ? 0 :
		Math.max(0, 1 - realisticDayFactor);
	const sr = _scratchColor.r + (1.0 - _scratchColor.r) * arcadeWeight;
	const sg = _scratchColor.g + (1.0 - _scratchColor.g) * arcadeWeight;
	const sb = _scratchColor.b + (1.0 - _scratchColor.b) * arcadeWeight;
	_directional.color.setRGB(sr, sg, sb);

	_skyColor(elev, _scratchColor);
	const ar = _scratchColor.r + (1.0 - _scratchColor.r) * arcadeWeight;
	const ag = _scratchColor.g + (1.0 - _scratchColor.g) * arcadeWeight;
	const ab = _scratchColor.b + (1.0 - _scratchColor.b) * arcadeWeight;
	_ambient.color.setRGB(ar, ag, ab);

	// Aerial-perspective fog. The body-frame sunForward we computed
	// earlier doubles as the "looking toward sun" factor (camera
	// looks down body-forward in chase view), so we feed it straight
	// into the warm/cool fog blend.
	if (_fog) {
		_fogColor(elev, sunForward, _scratchColor);
		_fog.color.setRGB(_scratchColor.r, _scratchColor.g, _scratchColor.b);
		_fog.density = _fogDensity(playerState.alt || 0, mode);
	}
}
