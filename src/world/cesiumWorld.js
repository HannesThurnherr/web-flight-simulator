import * as Cesium from 'cesium';

Cesium.Ion.defaultAccessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJmMWM2MmI0OS01MzJkLTQzOTUtYjlkMy01MDg4MjE3OTYzOGMiLCJpZCI6NDIwMzY2LCJpYXQiOjE3NzY2MjkwMDd9.u08r8KvG7jbRMNsyovwEZkdJHFeULV9zNkmaqLEsk5g';

let viewer;
let miniViewer;
let pauseMiniViewer;

export function initCesium() {
	viewer = new Cesium.Viewer("cesiumContainer", {
		terrain: Cesium.Terrain.fromWorldTerrain(),
		timeline: false,
		animation: false,
		baseLayerPicker: false,
		geocoder: false,
		homeButton: false,
		infoBox: false,
		sceneModePicker: false,
		selectionIndicator: false,
		navigationHelpButton: false,
		fullscreenButton: false,
		shouldAnimate: false,
	});

	miniViewer = new Cesium.Viewer("minimapCesium", {
		terrain: null,
		timeline: false,
		animation: false,
		baseLayerPicker: false,
		geocoder: false,
		homeButton: false,
		infoBox: false,
		sceneModePicker: false,
		selectionIndicator: false,
		navigationHelpButton: false,
		fullscreenButton: false,
		shouldAnimate: false,
		skyBox: false,
		skyAtmosphere: false,
		contextOptions: {
			webgl: {
				preserveDrawingBuffer: true
			}
		}
	});

	pauseMiniViewer = new Cesium.Viewer("pauseMinimapCesium", {
		terrain: null,
		timeline: false,
		animation: false,
		baseLayerPicker: false,
		geocoder: false,
		homeButton: false,
		infoBox: false,
		sceneModePicker: false,
		selectionIndicator: false,
		navigationHelpButton: false,
		fullscreenButton: false,
		shouldAnimate: false,
		skyBox: false,
		skyAtmosphere: false,
		contextOptions: {
			webgl: {
				preserveDrawingBuffer: true
			}
		}
	});

	[viewer, miniViewer, pauseMiniViewer].forEach(v => {
		v.scene.requestRenderMode = false;
		v.scene.maximumRenderTimeChange = 0;
		v.scene.globe.maximumScreenSpaceError = 2;
		v.resolutionScale = 0.75;

		v.scene.screenSpaceCameraController.enableRotate = false;
		v.scene.screenSpaceCameraController.enableTranslate = false;
		v.scene.screenSpaceCameraController.enableZoom = false;
		v.scene.screenSpaceCameraController.enableTilt = false;
		v.scene.screenSpaceCameraController.enableLook = false;

		v.scene.screenSpaceCameraController.maximumZoomDistance = 25000000;

		v.scene.globe.tileCacheSize = 2048;
		v.scene.globe.preloadAncestors = true;
		v.scene.globe.preloadSiblings = true;
		v.scene.globe.loadingDescendantLimit = 20;

		v.scene.globe.skipLevelOfDetail = true;
		v.scene.globe.baseScreenSpaceError = 1024;
		v.scene.globe.skipScreenSpaceErrorFactor = 16;
		v.scene.globe.skipLevels = 1;

		v._cesiumWidget._creditContainer.style.display = "none";
	});

	[miniViewer, pauseMiniViewer].forEach(v => {
		v.scene.globe.enableLighting = false;
		v.scene.globe.showGroundAtmosphere = false;
		v.scene.fog.enabled = false;
		v.scene.highDynamicRange = false;
		v.scene.postProcessStages.fxaa.enabled = false;
		v.resolutionScale = 1.0;
		v.scene.globe.maximumScreenSpaceError = 2;
		v.scene.globe.baseColor = Cesium.Color.BLACK;
		if (v.scene.skyAtmosphere) v.scene.skyAtmosphere.show = false;
	});

	viewer.scene.globe.enableLighting = true;
	viewer.scene.highDynamicRange = false;
	viewer.scene.postProcessStages.fxaa.enabled = true;
	viewer.scene.skyAtmosphere = new Cesium.SkyAtmosphere();

	viewer.scene.fog.enabled = true;
	viewer.scene.fog.density = 0.0001;

	setControlsEnabled(false);

	return viewer;
}

export function setRenderOptimization(isMenu) {
	if (!viewer || !miniViewer || !pauseMiniViewer) return;

	[viewer, miniViewer, pauseMiniViewer].forEach(v => {
		v.scene.requestRenderMode = !isMenu;
		v.scene.maximumRenderTimeChange = !isMenu ? Infinity : 0;
	});
}

export function setControlsEnabled(enabled) {
	if (!viewer) return;
	const ctrl = viewer.scene.screenSpaceCameraController;
	ctrl.enableRotate = enabled;
	ctrl.enableTranslate = enabled;
	ctrl.enableZoom = enabled;
	ctrl.enableTilt = enabled;
	ctrl.enableLook = enabled;
}

export function setCameraToPlane(lon, lat, alt, heading, pitch, roll) {
	if (!viewer) return;

	viewer.camera.setView({
		destination: Cesium.Cartesian3.fromDegrees(lon, lat, alt),
		orientation: {
			heading: Cesium.Math.toRadians(heading),
			pitch: Cesium.Math.toRadians(pitch),
			roll: Cesium.Math.toRadians(roll)
		}
	});

	viewer.scene.requestRender();
}

// Third-person chase cam: place the Cesium camera BEHIND the given unit,
// looking at it. Used by the spectator feature — clicking "view from this
// unit" on a map tooltip flips the global camera into this mode with the
// clicked unit as the target. Works uniformly for any world-space unit
// because every one of them (player, NPC, missile, SAM) carries the same
// { lon, lat, alt, heading, pitch } shape.
//
// orbitYaw / orbitPitch (degrees): mouse-drag offsets. The caller passes
// the same controller-derived values the player chase cam uses, so
// dragging the mouse while spectating orbits the camera around the
// target the way the pilot cam orbits around the player.
// zoom: 0.5 .. 3 → scales the trailing distance.
export function setCameraBehindUnit(unit, orbitYaw = 0, orbitPitch = 0, zoom = 1) {
	if (!viewer || !unit) return;

	// Baseline trailing offset: 40 m behind, 12 m above. Scaled by zoom so
	// the mouse-wheel zoom control keeps working while spectating.
	const BASE_DIST = 40;
	const BASE_UP   = 12;
	const dist = BASE_DIST * Math.max(0.25, zoom);

	// Effective look direction: unit's current heading/pitch plus the
	// player's mouse-drag orbit offsets.
	const h = Cesium.Math.toRadians((unit.heading || 0) + orbitYaw);
	const p = Cesium.Math.toRadians((unit.pitch   || 0) + orbitPitch);

	// Forward unit vector in ENU (east-north-up).
	const fE = Math.sin(h) * Math.cos(p);
	const fN = Math.cos(h) * Math.cos(p);
	const fU = Math.sin(p);

	// Offset from the unit to the camera = -forward·dist + up·BASE_UP.
	const offE = -fE * dist;
	const offN = -fN * dist;
	const offU = -fU * dist + BASE_UP;

	const plat = (unit.lat || 0) * Math.PI / 180;
	const camLon = unit.lon + offE / (111320 * Math.cos(plat));
	const camLat = unit.lat + offN / 111320;
	const camAlt = unit.alt + offU;

	// Orient the camera to look back at the unit: look vector = -offset.
	const lookLen = Math.hypot(offE, offN, offU);
	const lE = -offE / lookLen;
	const lN = -offN / lookLen;
	const lU = -offU / lookLen;
	const lookHeading = Math.atan2(lE, lN);
	const lookPitch   = Math.asin(Math.max(-1, Math.min(1, lU)));

	viewer.camera.setView({
		destination: Cesium.Cartesian3.fromDegrees(camLon, camLat, camAlt),
		orientation: { heading: lookHeading, pitch: lookPitch, roll: 0 },
	});
	viewer.scene.requestRender();
}

export function setMinimapCamera(lon, lat, altitude, heading) {
	if (!miniViewer) return;

	if (miniViewer.canvas.width === 0 || miniViewer.canvas.height === 0) {
		return;
	}

	miniViewer.camera.setView({
		destination: Cesium.Cartesian3.fromDegrees(lon, lat, altitude),
		orientation: {
			heading: Cesium.Math.toRadians(heading),
			pitch: Cesium.Math.toRadians(-90),
			roll: 0
		}
	});

	miniViewer.scene.requestRender();
}

export function setPauseMinimapCamera(lon, lat, altitude, heading) {
	if (!pauseMiniViewer) return;

	if (pauseMiniViewer.canvas.width === 0 || pauseMiniViewer.canvas.height === 0) {
		return;
	}

	pauseMiniViewer.camera.setView({
		destination: Cesium.Cartesian3.fromDegrees(lon, lat, altitude),
		orientation: {
			heading: Cesium.Math.toRadians(heading),
			pitch: Cesium.Math.toRadians(-90),
			roll: 0
		}
	});

	pauseMiniViewer.scene.requestRender();
}

export function getViewer() {
	return viewer;
}

export function getMiniViewer() {
	return miniViewer;
}

export function getPauseMiniViewer() {
	return pauseMiniViewer;
}
