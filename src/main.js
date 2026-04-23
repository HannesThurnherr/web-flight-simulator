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

let fps = 0;
let frameCount = 0;
let lastFpsUpdate = 0;

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


function update(dt) {
	// Menu-like states and paused state freeze the world entirely.
	if (currentState === States.MENU || currentState === States.PICK_SPAWN) return;
	if (currentState === States.PAUSED) return;

	// CRASHED keeps the world ticking (NPCs, missiles, sensors, commander
	// view) so the player can press M and watch the rest of the battle
	// play out from above. Only player-specific updates are gated.
	const isFlying = currentState === States.FLYING;

	const input = isFlying ? controller.update() : null;

	// Commander view suspends pilot control: stick goes neutral, weapons
	// safed, AB cut. Throttle stays at its last value so the aircraft keeps
	// flying on trim instead of slowing or stalling. Mouse-steering overlay
	// is suppressed for the same reason.
	// Player-controlled physics / inputs / firing — only while FLYING.
	// Live projectiles and NPCs still tick below (the world keeps running
	// after you're shot down so you can watch the engagement play out).
	let physicsResult = null;
	let prevSpeed = 0;
	if (isFlying) {
		prevSpeed = state.speed;
		// Both the commander view (god-eye map) and the spectator mode
		// (chase-cam on another unit) suspend pilot control. The plane
		// holds current throttle and flies on trim — neutral stick,
		// weapons safed, AB cut, mouse-steering off. The user can look
		// around (mouse drag) while the aircraft tracks straight.
		if ((commanderView && commanderView.active) || spectatorTarget) {
			input.pitch = 0;
			input.roll  = 0;
			input.yaw   = 0;
			input.boost = false;
			input.fire  = false;
			input.fireFlare    = false;
			input.toggleWeapon = false;
			input.weaponIndex  = -1;
			input.cycleTargetFwd  = false;
			input.cycleTargetBack = false;
			input.mouseSteering = false;
		}

		// Hand the physics module the current altitude so its density model is
		// accurate. Altitude is owned by main.js (lon/lat/alt state), not physics.
		physics.currentAltitude = state.alt;
		physicsResult = physics.update(input, dt);

		state.speed = physicsResult.speed;
		state.pitch = physicsResult.pitch;
		state.roll = physicsResult.roll;
		state.heading = physicsResult.heading;
		state.throttle = input.throttle;
		state.yaw = input.yaw;
		state.isBoosting = physicsResult.isBoosting;

		state.verticalSpeed = physicsResult.velocityENU ? physicsResult.velocityENU.z : 0;
		// Full ENU velocity so the HUD can compute the world-referenced
		// flight-path marker (direction the jet is actually going, in
		// world axes — independent of bank).
		state.velocityE = physicsResult.velocityENU ? physicsResult.velocityENU.x : 0;
		state.velocityN = physicsResult.velocityENU ? physicsResult.velocityENU.y : 0;
		state.alpha      = physicsResult.alpha      || 0;
		state.sideslip   = physicsResult.beta       || 0;
		state.loadFactor = physicsResult.loadFactor || 0;
		state.gLimiterActive = !!physicsResult.gLimiterActive;

		state.mouseSteering = !!input.mouseSteering;
		state.cursorX = input.cursorX;
		state.cursorY = input.cursorY;
	}

	// Fields that the HUD / sensor / commander code reads every frame
	// regardless of state.
	state.weaponSystem = weaponSystem;
	state.npcs = npcSystem ? npcSystem.npcs : [];
	state.npcProjectiles = npcSystem ? npcSystem.projectiles : [];

	// Weapons: only trigger new fires while FLYING, but always call
	// update() so existing player missiles keep flying even after death.
	if (weaponSystem) {
		if (isFlying) {
			if (input.weaponIndex !== -1) weaponSystem.selectWeapon(input.weaponIndex);
			if (input.toggleWeapon)       weaponSystem.toggleWeapon();
			if (input.cycleTargetFwd)     weaponSystem.cycleDesignatedTarget( 1);
			if (input.cycleTargetBack)    weaponSystem.cycleDesignatedTarget(-1);
			if (input.fire)               weaponSystem.fire(state);
			if (input.fireFlare)          weaponSystem.fireFlare(state);
		}
		weaponSystem.update(dt, state, isFlying ? input : null);
	}

	// ---- Sensor system -----------------------------------------------------
	// Build the list of all sensable objects (player + NPCs + live missiles)
	// and scan bidirectionally. Each unit ends up with contacts/rwr populated
	// in-place. NPCs already carry team='hostile' and a fighter signature
	// from npcSystem; the player carries team='friendly' and matching data.
	simTime += dt;
	const npcList = npcSystem ? npcSystem.npcs : [];
	// Every projectile carries team + signature now (set at construction
	// from the launcher), so we just sweep both pools into the sensor
	// pass without per-item fixup.
	const playerProjectiles = (weaponSystem && weaponSystem.projectiles) || [];
	const npcProjectiles    = (npcSystem && npcSystem.projectiles)    || [];
	const allProjectiles = playerProjectiles.concat(npcProjectiles).filter(p => p && p.active);
	updateSensors([state, ...npcList, ...allProjectiles], simTime, dt);

	// Mirror the friendly team datalink into state.datalinkContacts so
	// the HUD / cockpit targeting can show team-fused tracks alongside
	// the player's own radar contacts. When the player toggles their
	// radar off (silent running), this is the ONLY source of air-picture
	// data — makes the AWACS datalink observable in-game rather than
	// just being a behind-the-scenes missile-guidance helper.
	{
		const dl = state.team ? getTeamDatalink(state.team) : null;
		if (dl) {
			// Map of target→{lon,lat,alt,range,...}; HUD checks membership
			// and reads fields the same way it reads radar channel data.
			state.datalinkContacts = dl.allContacts();
		} else {
			state.datalinkContacts = null;
		}
	}

	// Position integration from player's velocity — FLYING only. When
	// the player is destroyed, their position freezes on the ground where
	// the kill happened.
	if (isFlying && physicsResult) {
		if (physicsResult.velocityENU) {
			const newPos = advanceLonLatAlt(state.lon, state.lat, state.alt, physicsResult.velocityENU, dt);
			state.lon = newPos.lon;
			state.lat = newPos.lat;
			state.alt = newPos.alt;
		} else {
			const fallback = movePosition(state.lon, state.lat, state.alt, state.heading, state.pitch, state.speed * dt);
			state.lon = fallback.lon;
			state.lat = fallback.lat;
			state.alt = fallback.alt;
		}

		const nowTime = Date.now();
		const distFromLast = calculateDistance(state.lon, state.lat, lastGeocodePos.lon, lastGeocodePos.lat);

		if (nowTime - lastGeocodeTime > GEOCODE_INTERVAL || distFromLast > GEOCODE_MIN_DIST) {
			lastGeocodeTime = nowTime;
			lastGeocodePos = { lon: state.lon, lat: state.lat };

			reverseGeocode(state.lon, state.lat).then(name => {
				if (name && name !== currentRegionName) {
					currentRegionName = name;
					hud.showRegion(name);
				}
			});
		}

		checkCrash(ctx);
		checkGPWS(ctx);
	}

	if (isFlying) {
		if (soundManager.isPlaying('jet-engine')) {
			const minSpeed = 100;
			const maxSpeed = 1000;
			const minVol = 0.5;
			const maxVol = 0.6;
			const speedFactor = Math.max(0, Math.min(1.0, (state.speed - minSpeed) / (maxSpeed - minSpeed)));
			const engineVol = minVol + speedFactor * (maxVol - minVol);
			soundManager.setVolume('jet-engine', engineVol);
		}

		if (state.isBoosting && !lastIsBoosting) {
			soundManager.play('boost');
		}

		if (state.throttle > lastThrottleLevel + 0.01) {
			if (!soundManager.isPlaying('throttle')) {
				soundManager.play('throttle');
			}
		}
		lastThrottleLevel = state.throttle;

		if (Math.abs(input.pitch) > 0.5) {
			if (!soundManager.isPlaying('pitch')) {
				soundManager.play('pitch', 0.1);
			}
		} else {
			if (soundManager.isPlaying('pitch')) {
				soundManager.stop('pitch', 0.1);
			}
		}

		if (Math.abs(input.roll) > 0.5 || Math.abs(input.yaw) > 0.5) {
			if (!soundManager.isPlaying('roll')) {
				soundManager.play('roll', 0.1);
			}
		} else {
			if (soundManager.isPlaying('roll')) {
				soundManager.stop('roll', 0.1);
			}
		}
	}

	// Lazy-create the commander view once Cesium is ready. Share the ref
	// with the pilot controller so its mouse-drag logic can back off while
	// the commander's pan-drag is active. Also register the scene with the
	// sensor module so terrain raycasts can run.
	if (!commanderView) {
		const viewer = getViewer();
		if (viewer) {
			commanderView = new CommanderView(viewer);
			controller.commanderView = commanderView;
			setSensorScene(viewer.scene);
		}
	}

	// Spectator auto-clear: if the unit we're following dies between
	// frames, fall back to the normal pilot camera rather than freezing
	// on the death pose. Also clears if the unit is an NPC that's been
	// spliced out of the world (active === false or detached).
	if (spectatorTarget) {
		const gone = spectatorTarget.destroyed ||
			spectatorTarget.active === false ||
			(typeof spectatorTarget.lon !== 'number');
		if (gone) spectatorTarget = null;
	}

	// NPCs, HUD, commander: always tick so the world keeps running even
	// while the player is crashed. Key to the "press M after you die and
	// watch the rest of the battle" UX.
	//
	// IMPORTANT: npcSystem.update runs BEFORE the camera is set this
	// frame. That way `spectatorTarget.lon/lat/alt` is already advanced
	// to frame-N before setCameraBehindUnit reads it — mirroring the
	// pilot camera, which already worked this way because state.lon/lat
	// /alt integrates ahead of the camera block. The inline mesh bakes
	// inside update() use a stale viewMatrix (the camera hasn't moved
	// yet), but we rebake every mesh via `syncMeshMatrices()` below
	// AFTER the camera is set, so the final render uses a consistent V
	// for both the earth and every THREE mesh on top of it.
	if (npcSystem) {
		npcSystem.update(dt, state, simTime);
	}

	// Camera priority each frame:
	//   1. Commander view — god-eye map. Owns the camera when active.
	//   2. Spectator — chase cam behind a clicked unit.
	//   3. Pilot — default first-person + mouse-orbit.
	// CRASHED freezes the camera on last-known pose (no branch fires).
	if (commanderView && commanderView.active) {
		// Commander owns the camera.
	} else if (spectatorTarget) {
		// Chase cam behind the clicked unit. Uses the same mouse orbit
		// values the pilot camera reads, so dragging the mouse while
		// spectating rotates the view around the target.
		const orbitYaw   = input ? (input.cameraYaw   || 0) : 0;
		const orbitPitch = input ? -(input.cameraPitch || 0) : 0;
		const zoom       = input ? (input.cameraZoom  || 1) : 1;
		setCameraBehindUnit(spectatorTarget, orbitYaw, orbitPitch, zoom);
	} else if (isFlying) {
		const planeHPR = new Cesium.HeadingPitchRoll(
			Cesium.Math.toRadians(state.heading),
			Cesium.Math.toRadians(state.pitch),
			Cesium.Math.toRadians(state.roll)
		);
		const planeQuat = Cesium.Quaternion.fromHeadingPitchRoll(planeHPR);

		const orbitHPR = new Cesium.HeadingPitchRoll(
			Cesium.Math.toRadians(input.cameraYaw),
			Cesium.Math.toRadians(-input.cameraPitch),
			0
		);
		const orbitQuat = Cesium.Quaternion.fromHeadingPitchRoll(orbitHPR);

		const finalQuat = Cesium.Quaternion.multiply(planeQuat, orbitQuat, new Cesium.Quaternion());
		const finalHPR = Cesium.HeadingPitchRoll.fromQuaternion(finalQuat);

		setCameraToPlane(
			state.lon, state.lat, state.alt,
			Cesium.Math.toDegrees(finalHPR.heading),
			Cesium.Math.toDegrees(finalHPR.pitch),
			Cesium.Math.toDegrees(finalHPR.roll)
		);
	}

	// Re-bake every world-space THREE mesh against the just-set camera.
	// Both NPC planes + NPC-fired projectiles (via npcSystem) and
	// player-fired projectiles (via weaponSystem) had their initial bake
	// happen earlier in the frame with the PREVIOUS camera. Rebaking
	// now aligns them with the camera Cesium is about to render the
	// earth with — without this the units visibly shake in the chase
	// cam as frame-time jitter turns a constant v·dt misalignment into
	// a direction-of-travel oscillation.
	if (weaponSystem && weaponSystem.syncMeshMatrices) weaponSystem.syncMeshMatrices();
	if (npcSystem && npcSystem.syncMeshMatrices)       npcSystem.syncMeshMatrices();

	// Scenario tick: scripted movement / telemetry readouts. Runs for both
	// FLYING and CRASHED so lab-style scenarios (e.g. notching test) keep
	// updating their readout panels even after the player dies.
	{
		const scn = getActiveScenario();
		if (scn && scn.update) {
			scn.update({ npcSystem, playerState: state, viewer: getViewer() }, dt);
		}
	}

	hud.update(state, isFlying ? (npcSystem ? npcSystem.npcs : []) : []);

	if (commanderView) {
		const projectiles = (weaponSystem && weaponSystem.projectiles) || [];
		const npcProjs    = (npcSystem && npcSystem.projectiles)    || [];
		const allProjs    = projectiles.concat(npcProjs);
		const units = npcSystem ? npcSystem.npcs : [];
		commanderView.update(dt, state, units, allProjs);

		// Pilot overlays follow commander state. The cockpit plane model
		// is drawn in camera space — hide it when the god-eye view owns
		// the camera. UI likewise fades out.
		const cmdActive = commanderView.active;
		// Cockpit model + pilot UI are only visible while the pilot
		// camera is driving. Both the commander god-eye view AND the
		// spectator chase-cam take over the camera, so both hide them.
		const pilotCamOwns = !cmdActive && !spectatorTarget;
		if (planeModel) planeModel.visible = pilotCamOwns && isFlying;
		const uiContainer = document.getElementById('uiContainer');
		if (uiContainer) uiContainer.style.opacity = pilotCamOwns ? '' : '0';

		// NPC screen markers (diamonds + labels, the `npc-markers-layer`
		// div) live OUTSIDE uiContainer so we can show them in spectator
		// mode — the whole point of a chase cam is seeing the
		// surrounding units. Commander view has its own ground-plane
		// markers though, so hide the HUD markers there to avoid double
		// rendering. Visible otherwise (pilot OR spectator).
		const npcLayer = document.getElementById('npc-markers-layer');
		if (npcLayer) npcLayer.style.display = cmdActive ? 'none' : '';

		// While the player is dead, toggling into the map hides the crash
		// screen so the whole view is the battlefield. Three.js stays
		// hidden — the commander view uses Cesium entity markers and
		// polyline trails for everything. Force display:none inline as
		// well as the class, belt-and-braces: if any other CSS ended up
		// leaving the overlay with display:flex + pointer-events:auto, it
		// would intercept mousedown and break the map drag/tilt even
		// while the user can't see it.
		if (currentState === States.CRASHED && crashMenu) {
			crashMenu.classList.toggle('hidden', cmdActive);
			if (cmdActive) {
				crashMenu.style.display = 'none';
				crashMenu.style.pointerEvents = 'none';
			} else {
				crashMenu.style.display = '';
				crashMenu.style.pointerEvents = '';
			}
			_lastLoggedCmdActive = cmdActive;
		}
	}

	// Cockpit-space plane model tilt/shake visual block — FLYING-only
	// because it reads physicsResult + input + prevSpeed (all captured
	// under the isFlying gate above).
	if (isFlying && planeModel) {
		const accel = (state.speed - prevSpeed) / dt;
		const accelInertia = input.isDragging ? 0 : Math.max(-0.5, Math.min(1.5, accel * 0.001));
		let targetZ = BASE_PLANE_POS.z - accelInertia;

		// Afterburner cockpit-shake / barrel-roll animation removed per
		// user preference. The plane used to punch backwards in chase-
		// space and do a couple of full-rotation barrel rolls when the
		// afterburner engaged — cinematic, but disorienting and nothing
		// a real aircraft actually does. Keep `boostRoll` and
		// `lastIsBoosting` at zero/false so any downstream reader sees
		// a consistent no-boost-animation state.
		const boostZOffset = 0;
		boostRoll = 0;
		lastIsBoosting = physicsResult.isBoosting;

		const zLerp = physicsResult.isBoosting ? 10.0 * dt : 2.0 * dt;
		currentBoostZOffset += (boostZOffset - currentBoostZOffset) * zLerp;
		targetZ += currentBoostZOffset;


		const time = performance.now() * 0.001;
		const idleX = Math.sin(time * 0.8) * 0.035;
		const idleY = Math.cos(time * 0.6) * 0.025;
		const idleRotX = Math.sin(time * 0.5) * 0.015;
		const idleRotY = Math.cos(time * 0.4) * 0.015;
		const idleRotZ = Math.sin(time * 0.7) * 0.025;

		const targetX = input.isDragging ? BASE_PLANE_POS.x : BASE_PLANE_POS.x - (input.roll * 0.6) - (input.yaw * 0.12) + idleX;
		const targetY = input.isDragging ? BASE_PLANE_POS.y : BASE_PLANE_POS.y - (input.pitch * 0.1) + idleY;

		let targetRotZ = input.isDragging ? 0 : THREE.MathUtils.degToRad(-input.roll * 15) + idleRotZ;
		const targetRotX = input.isDragging ? 0 : THREE.MathUtils.degToRad(input.pitch * 10) + idleRotX;
		const targetRotY = input.isDragging ? 0 : THREE.MathUtils.degToRad(-input.yaw * 4) + idleRotY;

		const lerpFactor = physicsResult.isBoosting ? 3.0 * dt : 5.0 * dt;
		visualOffset.x += (targetX - visualOffset.x) * lerpFactor;
		visualOffset.y += (targetY - visualOffset.y) * lerpFactor;
		visualOffset.z += (targetZ - visualOffset.z) * lerpFactor;

		visualRotation.z += (targetRotZ - visualRotation.z) * lerpFactor;
		visualRotation.x += (targetRotX - visualRotation.x) * lerpFactor;
		visualRotation.y += (targetRotY - visualRotation.y) * lerpFactor;

		const orbitQ = new THREE.Quaternion().setFromEuler(
			new THREE.Euler(
				THREE.MathUtils.degToRad(-input.cameraPitch),
				THREE.MathUtils.degToRad(-input.cameraYaw),
				0,
				'YXZ'
			)
		);

		// Apply chase-camera zoom. The plane sits in front of the camera
		// in camera space; scaling the offset scales apparent size (and
		// the corresponding chase distance). Clamped in the controller
		// so it can't pass through the airframe or fly off to infinity.
		const zoom = (input && input.cameraZoom) || 1;
		planeModel.position.copy(visualOffset).multiplyScalar(zoom);

		const flightLagQ = new THREE.Quaternion().setFromEuler(
			new THREE.Euler(visualRotation.x, visualRotation.y, visualRotation.z + boostRoll)
		);

		const combinedQ = orbitQ.clone().invert().multiply(flightLagQ);
		planeModel.quaternion.copy(combinedQ);

		if (jetFlames.length > 0) {
			jetFlames.forEach(flame => {
				flame.update(state.throttle, state.isBoosting, clock.getElapsedTime(), dt);
			});
		}
	}
}

// checkGPWS / checkCrash / doCrashTransition live in
// src/systems/crashDetection.js. They're called from the update loop
// with the shared ctx; no local state remains here apart from the
// GPWS timers, which belong to main.js because resumeGameplaySounds
// bumps lastGPWSWarningTime on pause resume.

function animate() {
	requestAnimationFrame(animate);

	const dt = clock ? clock.getDelta() : 0.016;
	const now = performance.now();

	frameCount++;
	if (now - lastFpsUpdate >= 1000) {
		fps = (frameCount * 1000) / (now - lastFpsUpdate);
		frameCount = 0;
		lastFpsUpdate = now;
		hud.updateFPS(fps);

		const menuTimeElem = document.getElementById('menu-time');
		if (menuTimeElem) {
			menuTimeElem.textContent = new Date().toISOString().split('.')[0] + 'Z';
		}
	}

	if (currentState === States.FLYING || currentState === States.PAUSED || currentState === States.TRANSITIONING || currentState === States.CRASHED) {
		const viewer = getViewer();

		renderer.autoClear = false;
		renderer.clear();

		if (viewer && viewer.camera && viewer.camera.frustum.fovy) {
			const targetFov = Cesium.Math.toDegrees(viewer.camera.frustum.fovy);
			camera.fov = targetFov;
			camera.aspect = window.innerWidth / window.innerHeight;
			camera.updateProjectionMatrix();
		}

		camera.layers.set(0);

		// CRASHED keeps ticking so NPCs continue fighting and the player
		// can press M to watch from above. update() gates player-specific
		// work on isFlying internally.
		if (currentState === States.FLYING || currentState === States.CRASHED) {
			update(dt);
		} else if (currentState === States.PAUSED) {
			hud.updatePauseMenu(state, currentRegionName, npcSystem ? npcSystem.npcs : []);
			// Keep the commander-view map interactive during Space-pause
			// (pan / zoom / tilt, marker positions, tooltip content) even
			// though the simulation is frozen. Passing dt=0 freezes the
			// trail-sampling timer, contact ageing, etc. — the map's
			// camera controls still work because they're driven by pointer
			// events and _applyCamera() inside commanderView.update().
			if (commanderView && commanderView.active) {
				const projectiles = ((weaponSystem && weaponSystem.projectiles) || [])
					.concat((npcSystem && npcSystem.projectiles) || []);
				commanderView.update(0, state, npcSystem ? npcSystem.npcs : [], projectiles);
			}
		}

		if (mixer) mixer.update(dt);

		try { if (currentState === States.FLYING) particles.update(dt); } catch (e) { }

		renderer.render(scene, camera);

		renderer.clearDepth();

		camera.fov = 75;
		camera.updateProjectionMatrix();

		camera.layers.set(1);

		renderer.render(scene, camera);

	} else {
		threeContainer.classList.add('hidden');
	}
}

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
animate();

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
