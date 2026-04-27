import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { initCesium, setCameraToPlane, setCameraBehindUnit, getViewer, setControlsEnabled, setRenderOptimization } from './world/cesiumWorld';
import { PlanePhysics } from './plane/planePhysics';
import { PlaneController } from './plane/planeController';
import { movePosition } from './utils/math';
import { advanceLonLatAlt } from './plane/aeroModel';
import { calculateDistance, reverseGeocode } from './world/regions';
import { HUD } from './ui/hud';
import { CommanderView } from './systems/commanderView';
import { SIGNATURES } from './systems/signatures';
import {
	updateSensors, setSensorScene,
	FIGHTER_RADAR_DEFAULT,
	FIGHTER_IRST_DEFAULT,
	FIGHTER_EYEBALL_DEFAULT,
} from './systems/sensorSystem';
import { JetFlame } from './plane/jetFlame';
import { stripOrdnance } from './plane/stripOrdnance';
import { highlightMeshes } from './plane/highlightMeshes';
import { PLANES, setActivePlane, getActivePlane, getActivePlaneId } from './plane/planes';
import { MUNITIONS, munitionsForHardpoint } from './weapon/munitions';
import {
	getLoadout, setLoadoutSlot, fillAllCompatible, clearAll,
	simTypeCounts, totalWeightKg, isStealthBroken,
	effectiveRcsM2, externalRcsM2,
} from './plane/loadout';
import { PlanePreview } from './ui/planePreview';
import { WeaponSystem } from './systems/weaponSystem';
import { soundManager } from './utils/soundManager';
import { NPCSystem } from './systems/npcSystem';
import { DialogueSystem } from './systems/dialogueSystem';
import { SCENARIOS, setActiveScenario, getActiveScenario } from './systems/scenarios';
import { getTeamDatalink } from './systems/teamDatalink';
import * as Cesium from 'cesium';
import { particles } from './utils/particles';
import {
	gameSettings,
	loadGameSettingsFromStorage,
	loadSettings,
	saveSettings,
	applySettings,
	updateSettingsUI,
} from './ui/settings';
import { loadingStatus, updateLoadingUI } from './ui/loadingUI';
import { initSounds, stopAllFlyingSounds } from './utils/gameplaySounds';
import { setupMeshStripDiagnostic } from './ui/debugMeshStrip';
import { setupLocationSearch } from './ui/locationSearch';
import { setupScenarioPicker } from './ui/scenarioPicker';
import { setupPlanePicker } from './ui/planePicker';
import {
	enterSpawnPicking, exitSpawnPicking, quickRespawn,
	setupSpawnPicker, setupConfirmSpawn,
	getSpawnMarker, setSpawnMarker, hasScenarioSpawnPoint,
} from './systems/spawnFlow';
import {
	setupModalListeners, setupPauseAndRespawnButtons,
	setupGlobalKeybinds, setupWindowLifecycleHandlers,
	closeAllModals,
} from './ui/menus';
import { checkCrash, checkGPWS } from './systems/crashDetection';
import { loadPlayerPlane } from './plane/loadPlayerPlane';
import { initThree } from './systems/threeScene';
import { update } from './systems/simLoop';
import { startAnimateLoop } from './systems/animateLoop';

const States = {
	MENU: 'MENU',
	PICK_SPAWN: 'PICK_SPAWN',
	TRANSITIONING: 'TRANSITIONING',
	FLYING: 'FLYING',
	PAUSED: 'PAUSED',
	CRASHED: 'CRASHED'
};

let currentState = States.MENU;

// Populate gameSettings right now, before anything reads it. The
// pickers down below (scenario cards, airframe modal, spawn picker)
// consult `gameSettings.lastScenarioId` / `lastPlaneId` / `lastSpawn`
// during their own init; that has to happen after this line.
loadGameSettingsFromStorage();

// Commit the persisted plane + scenario to the registries NOW, not
// at picker-IIFE time. initThree() — much further down but before
// those IIFEs — calls `loadPlayerPlane(getActivePlane())` once to
// bring up the player's airframe, and `getActivePlane()` returns the
// module default unless somebody has already called setActivePlane.
// Without this block, the menu would correctly show "F-22" as the
// saved pick, but in-game the player always spawned in the default
// F-15 because the plane model was loaded before the picker's own
// setActivePlane call fired. Same rationale for the scenario.
if (gameSettings.lastPlaneId && PLANES[gameSettings.lastPlaneId]) {
	setActivePlane(gameSettings.lastPlaneId);
}
if (gameSettings.lastScenarioId && SCENARIOS[gameSettings.lastScenarioId]) {
	setActiveScenario(gameSettings.lastScenarioId);
}

// Settings (gameSettings + load/save/apply/updateSettingsUI) live in
// src/ui/settings.js. The functions imported at the top of this file
// are the public API; `applySettings` and `loadSettings` take a ctx
// with `{ hud, controller }` so they can push values into objects
// whose lifecycle is owned here in main.js.

let state = {
	lon: 106.8272,
	lat: -6.1754,
	alt: 1000,
	heading: 0,
	pitch: 0,
	roll: 0,
	speed: 0,
	throttle: 0,
	score: 0,
	weaponSystem: null,
	// Combat metadata: the player is a fighter, hostile to NPCs spawned by
	// npcSystem. Sensor/contact data is populated each frame by sensorSystem.
	team: 'friendly',
	signature: { ...SIGNATURES.fighter },
	sensors: {
		radar:   { ...FIGHTER_RADAR_DEFAULT },
		ir:      { ...FIGHTER_IRST_DEFAULT },
		eyeball: { ...FIGHTER_EYEBALL_DEFAULT },
	},
	contacts: new Map(),
	rwr: new Map(),
};

async function initUserLocation() {
	try {
		const data = await (await fetch('https://ipapi.co/json/')).json();
		if (data.latitude && data.longitude) {
			state.lat = data.latitude;
			state.lon = data.longitude;
		}
	} catch (e) { }
}

initUserLocation();

let currentRegionName = null;
let lastGeocodeTime = 0;
let lastGeocodePos = { lon: 0, lat: 0 };
const GEOCODE_INTERVAL = 10000;
const GEOCODE_MIN_DIST = 1000;

let lastGPWSWarningTime = 0;
const GPWS_COOLDOWN = 1800;
let gpwsActive = false;
let pauseStartTime = 0;

let scene, camera, renderer;
let planeModel;
let jetFlames = [];
let mixer, clock;
let physics = new PlanePhysics();
let controller = new PlaneController();
let hud = new HUD();
// TGP panel — created once at boot, hidden by default. updateTgp() in
// simLoop shows/hides based on the current weapon.
import('./ui/tgp.js').then(m => m.setupTgp());
// Commander view is created lazily once the Cesium viewer exists. We instantiate
// it just-in-time in update() the first time we need it — keeping init order
// simple avoids fighting with the existing async Cesium bring-up.
let commanderView = null;

// Monotonic sim-time used for sensor contact ageing. Advances only while
// update(dt) actually ticks, so pauses don't retroactively expire contacts —
// same convention as commanderView's trail timer.
let simTime = 0;

// Diagnostic: remember the last-logged commander-active state while CRASHED
// so we log only on transitions, not every frame.
let _lastLoggedCmdActive = null;
// Spectator camera target. When non-null the main-loop camera branch puts
// the Cesium camera behind this unit instead of at the player, and the
// pilot's stick input is neutralized so the player's aircraft just holds
// its current throttle / heading. Set by the "VIEW" button on a map
// tooltip (commanderView dispatches the `spectator-request` event);
// cleared by Escape, by the unit being destroyed, or by the user picking
// a fresh target from another tooltip.
let spectatorTarget = null;
window.addEventListener('spectator-request', (e) => {
	const unit = e && e.detail && e.detail.unit;
	if (!unit) return;
	spectatorTarget = unit;
	// Pop the user out of the map overlay so they actually see the
	// chase-cam view. The tooltip itself stays open so they can click a
	// different unit to switch targets without reopening the map.
	if (commanderView && commanderView.active) {
		commanderView.setActive(false);
	}
});
let npcSystem;
let weaponSystem;
let dialogueSystem = new DialogueSystem();

// FPS tracking moved inside animateLoop.js (closure over its own counters).

const BASE_PLANE_POS = new THREE.Vector3(0, -0.8, -2.75);
let visualOffset = new THREE.Vector3().copy(BASE_PLANE_POS);
let visualRotation = new THREE.Euler(0, 0, 0);
let boostRoll = 0;
let currentBoostZOffset = 0;
let boostRollDirection = 1;
let lastIsBoosting = false;
let initialCameraView = null;
let lastThrottleLevel = 0;
let flightStartTime = 0;

// Context object shared with the extracted lifecycle modules
// (spawnFlow, crashDetection, simLoop, menus, …). Constructed once so
// extractions stop growing parameter lists; getters/setters keep
// bindings observable even though some (physics, weaponSystem,
// npcSystem, commanderView, spectatorTarget, planeModel, mixer,
// currentState, flightStartTime, initialCameraView) are `let`s that
// get reassigned after this object is built. Never reassign `ctx`
// itself; always mutate fields on it.
const ctx = {
	state,
	BASE_PLANE_POS, visualOffset, visualRotation,
	get scene()             { return scene; },
	setScene: s =>          { scene = s; },
	setCamera: c =>         { camera = c; },
	get camera()            { return camera; },
	get renderer()          { return renderer; },
	get clock()             { return clock; },
	get currentState()      { return currentState; },
	setCurrentState: s =>   { currentState = s; },
	get physics()           { return physics; },
	setPhysics: p =>        { physics = p; },
	get controller()        { return controller; },
	get hud()               { return hud; },
	get weaponSystem()      { return weaponSystem; },
	setWeaponSystem: ws =>  { weaponSystem = ws; },
	get npcSystem()         { return npcSystem; },
	get dialogueSystem()    { return dialogueSystem; },
	get planeModel()        { return planeModel; },
	setPlaneModel: m =>     { planeModel = m; },
	get mixer()             { return mixer; },
	setMixer: m =>          { mixer = m; },
	jetFlames,
	get commanderView()     { return commanderView; },
	get spectatorTarget()   { return spectatorTarget; },
	setSpectatorTarget: t => { spectatorTarget = t; },
	setBoostRoll:            v => { boostRoll = v; },
	getBoostRoll:            () => boostRoll,
	setCurrentBoostZOffset:  v => { currentBoostZOffset = v; },
	getCurrentBoostZOffset:  () => currentBoostZOffset,
	setLastIsBoosting:       v => { lastIsBoosting = v; },
	getLastIsBoosting:       () => lastIsBoosting,
	setBoostRollDirection:   v => { boostRollDirection = v; },
	getBoostRollDirection:   () => boostRollDirection,
	setLastThrottleLevel:    v => { lastThrottleLevel = v; },
	getLastThrottleLevel:    () => lastThrottleLevel,
	setCommanderView:        v => { commanderView = v; },
	getCurrentRegionName:    () => currentRegionName,
	setCurrentRegionName:    v => { currentRegionName = v; },
	getLastGeocodeTime:      () => lastGeocodeTime,
	setLastGeocodeTime:      v => { lastGeocodeTime = v; },
	getLastGeocodePos:       () => lastGeocodePos,
	setLastGeocodePos:       v => { lastGeocodePos = v; },
	addSimTime:              d => { simTime += d; },
	getSimTime:              () => simTime,
	setFlightStartTime:      v => { flightStartTime = v; },
	getFlightStartTime:      () => flightStartTime,
	getGpwsActive:           () => gpwsActive,
	setGpwsActive:           v => { gpwsActive = v; },
	getLastGPWSWarningTime:  () => lastGPWSWarningTime,
	setLastGPWSWarningTime:  v => { lastGPWSWarningTime = v; },
	resetGeocodeState: () => {
		currentRegionName = null;
		lastGeocodeTime = 0;
		lastGeocodePos = { lon: 0, lat: 0 };
	},
	getInitialCameraView: () => initialCameraView,
	// Function injections (wrapped as thunks so the extracted
	// modules don't have to import main.js reciprocally).
	pauseGameplaySounds:  () => pauseGameplaySounds(),
	resumeGameplaySounds: () => resumeGameplaySounds(),
};

const mainMenu = document.getElementById('mainMenu');
const pauseMenu = document.getElementById('pauseMenu');
const crashMenu = document.getElementById('crashMenu');
const uiContainer = document.getElementById('uiContainer');
const threeContainer = document.getElementById('threeContainer');
const spawnInstruction = document.getElementById('spawnInstruction');
const confirmSpawnBtn = document.getElementById('confirmSpawnBtn');

// spawnMarker + _scenarioSpawnPoint now live in systems/spawnFlow.js.

const startBtn = document.getElementById('startBtn');

const loadingIndicator = document.getElementById('loadingIndicator');
const loadingText = document.getElementById('loadingText');

// `loadingStatus` and `updateLoadingUI` live in src/ui/loadingUI.js.
// Call sites mutate fields on `loadingStatus` then call
// `updateLoadingUI(currentState)` to repaint the indicator + start
// button.

// initSounds / stopAllFlyingSounds / setupButtonSounds live in
// src/utils/gameplaySounds.js. The local pauseGameplaySounds and
// resumeGameplaySounds helpers stay here because they mutate the
// pause-timestamp + GPWS-cooldown state that's still owned in main.js;
// they'll move with the crash/pause extraction.

function pauseGameplaySounds() {
	pauseStartTime = Date.now();
	soundManager.pauseAll();
}

function resumeGameplaySounds() {
	const pauseDuration = Date.now() - pauseStartTime;
	if (lastGPWSWarningTime > 0) {
		lastGPWSWarningTime += pauseDuration;
	}
	soundManager.resumeAll();
}

// initThree lives in src/systems/threeScene.js. It returns the
// scene/camera/renderer/clock tuple; we destructure into our local
// `let`s so later call sites (animate loop, HUD update, simLoop)
// keep reading direct module bindings rather than going through ctx
// in the hot path.


// checkGPWS / checkCrash / doCrashTransition live in
// src/systems/crashDetection.js. They're called from the update loop
// with the shared ctx; no local state remains here apart from the
// GPWS timers, which belong to main.js because resumeGameplaySounds
// bumps lastGPWSWarningTime on pause resume.

// animate() lives in src/systems/animateLoop.js. Main.js kicks it off
// via startAnimateLoop(ctx) near the bottom of this file.

// Menus, modal lifecycle, pause/respawn buttons, global keybinds, and
// visibilitychange/blur auto-pause — see src/ui/menus.js.
setupModalListeners(ctx);
setupPauseAndRespawnButtons(ctx);
setupGlobalKeybinds(ctx);
setupWindowLifecycleHandlers(ctx);

const viewer = initCesium();

loadingStatus.cesium = true;
updateLoadingUI(currentState);

let globeLoadingStarted = false;
const unregisterGlobeTracker = viewer.scene.postRender.addEventListener(() => {
	const tilesLoaded = viewer.scene.globe.tilesLoaded;

	if (!tilesLoaded) {
		globeLoadingStarted = true;
	}

	if (tilesLoaded) {
		const surface = viewer.scene.globe._surface;
		const hasTiles = surface && surface._tilesToRender && surface._tilesToRender.length > 0;

		if (hasTiles) {
			loadingStatus.globe = true;
			updateLoadingUI(currentState);
			unregisterGlobeTracker();
		}
	}
});

viewer.scene.globe.tileLoadProgressEvent.addEventListener((queueLength) => {
	if (loadingIndicator && loadingText) {
		if (currentState === States.PICK_SPAWN) {
			if (queueLength > 0) {
				loadingText.textContent = "Loading Terrain...";
				loadingIndicator.classList.remove('hidden');
			} else {
				loadingIndicator.classList.add('hidden');
			}
		} else {
			const isAllLoaded = loadingStatus.audio && loadingStatus.model && loadingStatus.cesium && loadingStatus.globe;
			if (isAllLoaded) {
				loadingIndicator.classList.add('hidden');
			}
		}
	}
});

const resumeAudio = () => {
	if (soundManager.listener.context.state === 'suspended') {
		soundManager.listener.context.resume();
	}
	window.removeEventListener('mousedown', resumeAudio);
	window.removeEventListener('keydown', resumeAudio);
};
window.addEventListener('mousedown', resumeAudio);
window.addEventListener('keydown', resumeAudio);

initialCameraView = {
	destination: viewer.camera.position.clone(),
	orientation: {
		heading: viewer.camera.heading,
		pitch: viewer.camera.pitch,
		roll: viewer.camera.roll
	}
};

({ scene, camera, renderer, clock } = initThree(ctx));

// Mesh-strip debug (Shift+Click) lives in src/ui/debugMeshStrip.js.
// Late-binding getters keep working even though planeModel / npcSystem
// are reassigned after this setup call.
setupMeshStripDiagnostic({
	scene, camera,
	getPlaneModel: () => planeModel,
	getNpcSystem:  () => npcSystem,
});

npcSystem = new NPCSystem(viewer, scene, new GLTFLoader());
setupSpawnPicker(ctx);
setupConfirmSpawn(ctx);

// Main-menu scenario picker — see src/ui/scenarioPicker.js.
setupScenarioPicker();

// Plane picker (compact badge + modal detail) — src/ui/planePicker.js.
// loadPlayerPlane is still owned by main.js so we pass it through.
setupPlanePicker({ loadPlayerPlane: (plane) => loadPlayerPlane(plane, ctx) });

setupLocationSearch({
	state,
	getSpawnMarker,
	setSpawnMarker,
});
loadSettings({ hud, controller });

uiContainer.classList.add('hidden');
threeContainer.classList.add('hidden');

updateLoadingUI(currentState);
startAnimateLoop(ctx);

window.addEventListener('resize', () => {
	camera.aspect = window.innerWidth / window.innerHeight;
	camera.updateProjectionMatrix();
	renderer.setSize(window.innerWidth, window.innerHeight);

	const viewer = getViewer();
	if (viewer) viewer.resize();
});

window.addEventListener('contextmenu', (e) => {
	e.preventDefault();
}, false);
