import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { initCesium, setCameraToPlane, getViewer, setControlsEnabled, setRenderOptimization } from './world/cesiumWorld';
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
import { WeaponSystem } from './systems/weaponSystem';
import { soundManager } from './utils/soundManager';
import { NPCSystem } from './systems/npcSystem';
import { DialogueSystem } from './systems/dialogueSystem';
import { SCENARIOS, setActiveScenario, getActiveScenario } from './systems/scenarios';
import { getTeamDatalink } from './systems/teamDatalink';
import * as Cesium from 'cesium';
import { particles } from './utils/particles';

const States = {
	MENU: 'MENU',
	PICK_SPAWN: 'PICK_SPAWN',
	TRANSITIONING: 'TRANSITIONING',
	FLYING: 'FLYING',
	PAUSED: 'PAUSED',
	CRASHED: 'CRASHED'
};

let currentState = States.MENU;

let gameSettings = {
	graphicsQuality: 'medium',
	antialiasing: true,
	fogEffects: true,
	mouseSensitivity: 0.2,
	showHud: true,
	showHorizonLines: false,
	soundEnabled: true,
	minimapRange: 10
};

function loadSettings() {
	const saved = localStorage.getItem('flightSimSettings');
	if (saved) {
		try {
			const parsed = JSON.parse(saved);
			gameSettings = { ...gameSettings, ...parsed };
		} catch (e) {
			console.error('Failed to load settings', e);
		}
	}
	applySettings();
	updateSettingsUI();
}

function saveSettings() {
	localStorage.setItem('flightSimSettings', JSON.stringify(gameSettings));
}

function updateSettingsUI() {
	document.getElementById('graphicsQuality').value = gameSettings.graphicsQuality;
	document.getElementById('antialiasing').checked = gameSettings.antialiasing;
	document.getElementById('fogEffects').checked = gameSettings.fogEffects;
	document.getElementById('sensitivitySlider').value = gameSettings.mouseSensitivity;
	document.getElementById('sensitivityValue').textContent = gameSettings.mouseSensitivity;
	document.getElementById('showHud').checked = gameSettings.showHud;
	document.getElementById('showHorizonLines').checked = gameSettings.showHorizonLines;
	document.getElementById('soundEnabled').checked = gameSettings.soundEnabled;
	document.getElementById('minimapRange').value = gameSettings.minimapRange.toString();
}

function applySettings() {


	if (controller) {
		controller.setSensitivity(gameSettings.mouseSensitivity);
	}

	if (hud) {
		hud.setMinimapRange(gameSettings.minimapRange);
		hud.setShowHorizonLines(gameSettings.showHorizonLines);
	}

	if (soundManager && soundManager.listener) {
		soundManager.listener.setMasterVolume(gameSettings.soundEnabled ? 1.0 : 0.0);
	}

	const viewer = getViewer();
	if (viewer) {
		if (gameSettings.graphicsQuality === 'low') {
			viewer.resolutionScale = 0.5;
			viewer.scene.globe.maximumScreenSpaceError = 4;
		} else if (gameSettings.graphicsQuality === 'medium') {
			viewer.resolutionScale = 0.75;
			viewer.scene.globe.maximumScreenSpaceError = 2;
		} else {
			viewer.resolutionScale = 1.0;
			viewer.scene.globe.maximumScreenSpaceError = 1.3;
		}

		viewer.scene.postProcessStages.fxaa.enabled = gameSettings.antialiasing;

		viewer.scene.fog.enabled = gameSettings.fogEffects;
		viewer.scene.atmosphere.show = gameSettings.fogEffects;
	}

	const hudElements = [
		document.getElementById('hud-top-left'),
		document.getElementById('hud-top-right'),
		document.getElementById('hud-speed-box'),
		document.getElementById('hud-alt-box'),
		document.getElementById('coords'),
		document.getElementById('minimap-container')
	];

	hudElements.forEach(el => {
		if (el) {
			el.style.display = gameSettings.showHud ? 'block' : 'none';
		}
	});
}

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

const mainMenu = document.getElementById('mainMenu');
const pauseMenu = document.getElementById('pauseMenu');
const crashMenu = document.getElementById('crashMenu');
const uiContainer = document.getElementById('uiContainer');
const threeContainer = document.getElementById('threeContainer');
const spawnInstruction = document.getElementById('spawnInstruction');
const confirmSpawnBtn = document.getElementById('confirmSpawnBtn');

let spawnMarker = null;

const startBtn = document.getElementById('startBtn');

const loadingIndicator = document.getElementById('loadingIndicator');
const loadingText = document.getElementById('loadingText');

const loadingStatus = {
	audio: false,
	model: false,
	cesium: false,
	globe: false,
	failed: false
};

function updateLoadingUI() {
	if (!loadingIndicator || !loadingText || !startBtn) return;

	if (currentState === States.FLYING || currentState === States.TRANSITIONING) {
		loadingIndicator.classList.add('hidden');
		return;
	}

	let msg = "";
	const isAllLoaded = loadingStatus.audio && loadingStatus.model && loadingStatus.cesium && loadingStatus.globe;

	if (loadingStatus.failed) {
		msg = "Loading Failed. Please Refresh.";
	} else if (!isAllLoaded) {
		if (!loadingStatus.audio) msg = "Loading Audio...";
		else if (!loadingStatus.model) msg = "Loading Aircraft Model...";
		else if (!loadingStatus.cesium) msg = "Loading Satellite Imagery...";
		else if (!loadingStatus.globe) msg = "Loading Globe Surface...";
	}

	if (msg) {
		loadingText.textContent = msg;
		startBtn.disabled = true;
		startBtn.style.pointerEvents = "none";
		loadingIndicator.classList.remove('hidden');

		if (loadingStatus.failed) {
			loadingText.style.color = "#f00";
			const spinner = loadingIndicator.querySelector('.spinner');
			if (spinner) {
				spinner.style.borderColor = "rgba(255, 0, 0, 0.3)";
				spinner.style.borderTopColor = "#f00";
			}
		}
	} else {
		loadingIndicator.classList.add('hidden');
		startBtn.disabled = false;
		startBtn.style.pointerEvents = "auto";
	}
}

async function initSounds() {
	soundManager.init(camera);

	await Promise.all([
		soundManager.loadSound('boost', '/assets/sounds/boost.mp3', false, 0.35),
		soundManager.loadSound('throttle', '/assets/sounds/throttle.mp3', false, 0.4),
		soundManager.loadSound('explode', '/assets/sounds/explode.mp3', false, 0.75),
		soundManager.loadSound('explosion-1', '/assets/sounds/explosion-1.mp3', false, 0.8),
		soundManager.loadSound('explosion-2', '/assets/sounds/explosion-2.mp3', false, 0.8),
		soundManager.loadSound('explosion-3', '/assets/sounds/explosion-3.mp3', false, 0.8),
		soundManager.loadSound('ambient-crash', '/assets/sounds/ambient.mp3', true, 0.5),
		soundManager.loadSound('weapon-warning', '/assets/sounds/weapon-warning-1.mp3', false, 1.0),
		soundManager.loadSound('jet-engine', '/assets/sounds/jet-engine.mp3', true, 0.5),
		soundManager.loadSound('spawn', '/assets/sounds/spawn.mp3', false, 0.5),
		soundManager.loadSound('roll', '/assets/sounds/roll.mp3', true, 0.75),
		soundManager.loadSound('pitch', '/assets/sounds/pitch.mp3', true, 0.75),
		soundManager.loadSound('button-click', '/assets/sounds/button-click.mp3', false, 1.0),
		soundManager.loadSound('weapon-switch', '/assets/sounds/weapon-switch.mp3', false, 0.75),
		soundManager.loadSound('button-hover', '/assets/sounds/button-hover.mp3', false, 0.25),
		soundManager.loadSound('zoom-in', '/assets/sounds/zoom-in.mp3', false, 0.5),
		soundManager.loadSound('missile-fire', '/assets/sounds/missile-firing-1.mp3', false, 0.75),
		soundManager.loadSound('m61-firing', '/assets/sounds/m61-firing.mp3', true, 0.75),
		soundManager.loadSound('rwr-tws', '/assets/sounds/rwr-tws.mp3', true, 0.2),
		soundManager.loadSound('rwr-lock', '/assets/sounds/rwr-lock.mp3', false, 0.2),
		soundManager.loadSound('wind', '/assets/sounds/wind.mp3', true, 0.25),
		soundManager.loadSound('terrain-pull-up', '/assets/sounds/terrain-pull-up.mp3', false, 0.9),
		soundManager.loadSound('warning', '/assets/sounds/warning.mp3', false, 0.6),
		soundManager.loadSound('glitch-1', '/assets/sounds/glitch-transition-1.mp3', false, 0.25),
		soundManager.loadSound('glitch-2', '/assets/sounds/glitch-transition-2.mp3', false, 0.25),
		soundManager.loadSound('glitch-3', '/assets/sounds/glitch-transition-3.mp3', false, 0.25),
		soundManager.loadSound('glitch-4', '/assets/sounds/glitch-transition-4.mp3', false, 0.25)
	]);

	loadingStatus.audio = true;
	updateLoadingUI();
	setupButtonSounds();
}

function stopAllFlyingSounds(fadeOut = 0.5) {
	soundManager.stopAll(fadeOut);
}

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

function setupButtonSounds() {
	document.addEventListener('mouseover', (e) => {
		const target = e.target.closest('button, .menu-btn, .clickable-ui');
		if (target && !target._hovered) {
			soundManager.play('button-hover');
			target._hovered = true;
			target.addEventListener('mouseleave', () => { target._hovered = false; }, { once: true });
		}
	}, true);

	document.addEventListener('click', (e) => {
		const target = e.target.closest('button, .menu-btn, .clickable-ui, #search-toggle-btn');
		if (target) {
			soundManager.play('button-click');
		}
	}, true);
}

function initThree() {
	clock = new THREE.Clock();
	scene = new THREE.Scene();
	camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100000);

	renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.setPixelRatio(window.devicePixelRatio);
	renderer.setClearColor(0x000000, 0);
	threeContainer.appendChild(renderer.domElement);

	threeContainer.classList.add('hidden');

	const ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
	scene.add(ambientLight);
	const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
	directionalLight.position.set(5, 10, 5);
	scene.add(directionalLight);

	ambientLight.layers.enable(1);
	directionalLight.layers.enable(1);

	try { particles.init(scene, getViewer()); } catch (e) { }

	initSounds().catch(err => console.error('Failed to init sounds', err));

	const loader = new GLTFLoader();
	loader.load('/assets/models/f-15.glb', (gltf) => {
		const mesh = gltf.scene;

		planeModel = new THREE.Group();
		planeModel.add(mesh);
		scene.add(planeModel);

		planeModel.layers.set(1);
		planeModel.traverse(child => {
			child.layers.set(1);
		});

		const box = new THREE.Box3().setFromObject(mesh);
		const center = box.getCenter(new THREE.Vector3());
		mesh.position.sub(center);

		planeModel.position.copy(BASE_PLANE_POS);
		planeModel.scale.set(0.2, 0.2, 0.2);

		const flameL = new JetFlame();
		const flameR = new JetFlame();

		flameL.group.position.set(-0.4, -0.065, 5);
		flameR.group.position.set(0.4, -0.065, 5);


		planeModel.add(flameL.group);
		planeModel.add(flameR.group);
		jetFlames.push(flameL, flameR);

		weaponSystem = new WeaponSystem(getViewer(), scene, planeModel);
		weaponSystem.onKill = (npc) => {
			state.score += 1000;
			try { soundManager.play('glitch-random'); } catch (e) { }
			if (hud) {
				hud.showKillNotification(npc.name, 1000);
			}
		};

		planeModel.traverse(child => {
			child.layers.set(1);
		});

		mixer = new THREE.AnimationMixer(mesh);
		const clip = THREE.AnimationClip.findByName(gltf.animations, 'flight_mode');
		if (clip) {
			const action = mixer.clipAction(clip);
			action.setLoop(THREE.LoopOnce);
			action.clampWhenFinished = true;
			action.play();
		}

		loadingStatus.model = true;
		updateLoadingUI();
	}, undefined, (error) => {
		console.error('Error loading model:', error);
	});
}

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
		if (commanderView && commanderView.active) {
			input.pitch = 0;
			input.roll  = 0;
			input.yaw   = 0;
			input.boost = false;
			input.fire  = false;
			input.fireFlare    = false;
			input.toggleWeapon = false;
			input.weaponIndex  = -1;
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

		checkCrash();
		checkGPWS();
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

	// Cockpit camera math + Cesium camera-set: FLYING only. When CRASHED
	// the camera freezes on the last-known position (or the commander
	// view takes over if the player toggles it on).
	if (isFlying) {
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

		// When commander is active, it owns the Cesium camera. Otherwise
		// the pilot chase-camera drives it.
		if (!commanderView || !commanderView.active) {
			setCameraToPlane(
				state.lon, state.lat, state.alt,
				Cesium.Math.toDegrees(finalHPR.heading),
				Cesium.Math.toDegrees(finalHPR.pitch),
				Cesium.Math.toDegrees(finalHPR.roll)
			);
		}
	}

	// NPCs, HUD, commander: always tick so the world keeps running even
	// while the player is crashed. Key to the "press M after you die and
	// watch the rest of the battle" UX.
	if (npcSystem) {
		npcSystem.update(dt, state, simTime);
	}

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
		if (planeModel) planeModel.visible = !cmdActive && isFlying;
		const uiContainer = document.getElementById('uiContainer');
		if (uiContainer) uiContainer.style.opacity = cmdActive ? '0' : '';

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

		let boostZOffset = 0;
		if (physicsResult.isBoosting) {
			if (!lastIsBoosting) {
				boostRollDirection = Math.random() > 0.5 ? 1 : -1;
			}

			const T = physicsResult.boostDuration;
			const p = Math.max(0, Math.min(1.0, 1.0 - (physicsResult.boostTimeRemaining / T)));

			const totalRotationRad = Math.PI * 2 * physicsResult.boostRotations * boostRollDirection;

			if (p < 0.2) {
				const localP = p / 0.2;
				boostZOffset = -(localP * localP) * 1.5;
				boostRoll = 0;
			}
			else if (p < 0.8) {
				const localP = (p - 0.2) / 0.6;
				boostZOffset = -1.5;
				const easedP = localP < 0.5
					? 4 * localP * localP * localP
					: 1 - Math.pow(-2 * localP + 2, 3) / 2;
				boostRoll = easedP * (Math.PI * 2 * physicsResult.boostRotations) * boostRollDirection;
			}
			else {
				const localP = (p - 0.8) / 0.2;
				const easedReturn = localP * localP * (3 - 2 * localP);
				boostZOffset = -1.5 + (easedReturn * 0.7);
				boostRoll = (Math.PI * 2 * physicsResult.boostRotations) * boostRollDirection;
			}
		} else {
			boostRoll = 0;
			boostZOffset = 0;
		}
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

function checkGPWS() {
	if (currentState !== States.FLYING) {
		hud.setPullUpWarning(false);
		return;
	}

	const viewer = getViewer();
	if (!viewer) return;

	const cartographic = Cesium.Cartographic.fromDegrees(state.lon, state.lat);
	const terrainHeight = viewer.scene.globe.getHeight(cartographic);

	if (terrainHeight === undefined) return;

	const agl = state.alt - terrainHeight;
	const pitchRad = Cesium.Math.toRadians(state.pitch);
	const verticalSpeed = state.speed * Math.sin(pitchRad);

	let showWarning = false;

	if (state.pitch < -1) {
		if (agl < 450) {
			if (agl < 150) {
				showWarning = true;
			}

			if (verticalSpeed < -20) {
				showWarning = true;
			}
		}
	}

	hud.setPullUpWarning(showWarning);

	if (showWarning) {
		const now = Date.now();
		if (!gpwsActive || (now - lastGPWSWarningTime > GPWS_COOLDOWN && !soundManager.isPlaying('terrain-pull-up'))) {
			soundManager.play('terrain-pull-up');
			lastGPWSWarningTime = now;
		}
		gpwsActive = true;
	} else {
		if (gpwsActive) {
			soundManager.stop('terrain-pull-up', 0.1);
			gpwsActive = false;
		}
	}
}

let lastCrashCheck = 0;
let flightStartTime = 0;

function _doCrashTransition() {
	currentState = States.CRASHED;
	if (dialogueSystem) dialogueSystem.stop();
	uiContainer.classList.add('hidden');
	const weaponsHud = document.getElementById('weapons-hud');
	if (weaponsHud) weaponsHud.classList.add('hidden');
	threeContainer.classList.add('hidden');
	crashMenu.classList.remove('hidden');
	hud.update(state, []);

	stopAllFlyingSounds(0.1);
	setTimeout(() => {
		soundManager.play('explode');
		soundManager.play('ambient-crash');
	}, 50);
}

function checkCrash() {
	if (currentState !== States.FLYING) return;

	// Missile kill: projectile sets state.destroyed=true via hitNPC since
	// `state` is passed in the target list the same way NPCs are. Handle
	// this immediately — no 100 ms rate-limit — so the transition is crisp.
	// We DON'T clear state.destroyed here: it must stay true while the
	// player is dead, otherwise the NPC TargetManager will see the player
	// as an available target at the frozen crash coordinates and keep
	// firing at thin air. It's reset to false on respawn.
	if (state.destroyed && currentState === States.FLYING) {
		_doCrashTransition();
		return;
	}

	const now = Date.now();
	if (now - lastCrashCheck < 100) return;
	lastCrashCheck = now;

	if (now - flightStartTime < 3000) return;

	const viewer = getViewer();
	if (!viewer) return;

	const cartographic = Cesium.Cartographic.fromDegrees(state.lon, state.lat);
	const terrainHeight = viewer.scene.globe.getHeight(cartographic);

	if (terrainHeight !== undefined && state.alt <= terrainHeight + 5) {
		_doCrashTransition();
	}
}

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

function closeAllModals() {
	document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
}

function setupModalListeners() {
	document.getElementById('helpBtn').onclick = () => {
		closeAllModals();
		document.getElementById('helpModal').classList.remove('hidden');
	};

	document.getElementById('optionsBtn').onclick = () => {
		closeAllModals();
		updateSettingsUI();
		document.getElementById('optionsModal').classList.remove('hidden');
	};

	document.getElementById('pauseOptionsBtn').onclick = () => {
		closeAllModals();
		updateSettingsUI();
		document.getElementById('optionsModal').classList.remove('hidden');
	};

	document.getElementById('pauseHelpBtn').onclick = () => {
		closeAllModals();
		document.getElementById('helpModal').classList.remove('hidden');
	};

	document.getElementById('creditsBtn').onclick = () => {
		closeAllModals();
		document.getElementById('creditsModal').classList.remove('hidden');
	};

	document.getElementById('aboutBtn').onclick = () => {
		closeAllModals();
		document.getElementById('aboutBtnModal').classList.remove('hidden');
	};



	document.getElementById('sensitivitySlider').oninput = (e) => {
		document.getElementById('sensitivityValue').textContent = e.target.value;
	};

	document.getElementById('saveOptionsBtn').onclick = () => {
		gameSettings.graphicsQuality = document.getElementById('graphicsQuality').value;
		gameSettings.antialiasing = document.getElementById('antialiasing').checked;
		gameSettings.fogEffects = document.getElementById('fogEffects').checked;
		gameSettings.mouseSensitivity = parseFloat(document.getElementById('sensitivitySlider').value);
		gameSettings.showHud = document.getElementById('showHud').checked;
		gameSettings.showHorizonLines = document.getElementById('showHorizonLines').checked;
		gameSettings.soundEnabled = document.getElementById('soundEnabled').checked;
		gameSettings.minimapRange = parseInt(document.getElementById('minimapRange').value);

		saveSettings();
		applySettings();
		closeAllModals();
	};

	document.querySelectorAll('.close-modal').forEach(btn => {
		btn.onclick = (e) => {
			e.stopPropagation();
			btn.closest('.modal').classList.add('hidden');
		};
	});

	window.addEventListener('click', (event) => {
		if (event.target.classList.contains('modal')) {
			event.target.classList.add('hidden');
		}
	});
}

document.getElementById('startBtn').onclick = () => {
	closeAllModals();
	mainMenu.classList.add('hidden');
	enterSpawnPicking(false);
};

setupModalListeners();

document.getElementById('resumeBtn').onclick = () => {
	closeAllModals();
	pauseMenu.classList.add('hidden');
	uiContainer.classList.remove('hidden');
	const weaponsHud = document.getElementById('weapons-hud');
	if (weaponsHud) weaponsHud.classList.remove('hidden');
	currentState = States.FLYING;
	if (dialogueSystem) dialogueSystem.resume();
	resumeGameplaySounds();
};

document.getElementById('restartBtn').onclick = () => {
	closeAllModals();
	pauseMenu.classList.add('hidden');
	if (dialogueSystem) dialogueSystem.stop();
	enterSpawnPicking(true);
};

document.getElementById('quitBtn').onclick = () => {
	closeAllModals();
	if (dialogueSystem) dialogueSystem.stop();
	setRenderOptimization(true);
	location.reload();
};

document.getElementById('respawnBtn').onclick = () => {
	closeAllModals();
	crashMenu.classList.add('hidden');
	if (dialogueSystem) dialogueSystem.stop();
	enterSpawnPicking(true);
};

function enterSpawnPicking(useVignette = true) {
	state.score = 0;
	// Let the scenario tear down its overlays / reset state before we
	// wipe NPCs and rebuild. Safe to call even on first spawn (onStop is
	// idempotent for all scenarios).
	{
		const scn = getActiveScenario();
		if (scn && scn.onStop) {
			scn.onStop({ npcSystem, playerState: state, viewer: getViewer(), scene, weaponSystem, hud });
		}
	}
	if (npcSystem) npcSystem.clear();
	stopAllFlyingSounds(0.3);
	soundManager.play('zoom-in');
	soundManager.play('wind', 1.0);
	const vignette = document.getElementById('transition-vignette');
	if (useVignette && vignette) vignette.style.opacity = '1';

	const delay = useVignette ? 500 : 0;

	setTimeout(() => {
		spawnInstruction.classList.remove('hidden');
		threeContainer.classList.add('hidden');
		uiContainer.classList.add('hidden');
		const weaponsHud = document.getElementById('weapons-hud');
		if (weaponsHud) weaponsHud.classList.add('hidden');
		currentState = States.PICK_SPAWN;
		confirmSpawnBtn.classList.add('hidden');

		const searchInput = document.getElementById('locationSearch');
		const instructionText = document.getElementById('instruction-text');
		const resultsContainer = document.getElementById('search-results');

		if (searchInput) {
			searchInput.value = '';
			searchInput.style.display = 'none';
		}
		if (instructionText) {
			instructionText.style.display = 'block';
			instructionText.textContent = 'CLICK ANYWHERE ON THE MAP TO CHOOSE SPAWN POINT';
		}
		if (resultsContainer) {
			resultsContainer.style.display = 'none';
		}

		setControlsEnabled(true);

		if (spawnMarker) {
			const viewer = getViewer();
			viewer.entities.remove(spawnMarker);
			spawnMarker = null;
		}

		const viewer = getViewer();
		viewer.camera.flyTo({
			destination: Cesium.Cartesian3.fromDegrees(state.lon, state.lat, 15000),
			duration: 2.0,
			complete: () => {
				if (vignette) vignette.style.opacity = '0';
			}
		});
	}, delay);
}

function exitSpawnPicking() {
	soundManager.play('zoom-in');
	soundManager.stop('wind', 1.0);
	stopAllFlyingSounds(0.3);
	spawnInstruction.classList.add('hidden');
	confirmSpawnBtn.classList.add('hidden');
	mainMenu.classList.remove('hidden');
	currentState = States.MENU;
	loadingIndicator.classList.add('hidden');
	setRenderOptimization(true);

	setControlsEnabled(false);

	if (spawnMarker) {
		const viewer = getViewer();
		viewer.entities.remove(spawnMarker);
		spawnMarker = null;
	}

	const viewer = getViewer();
	viewer.camera.flyTo({
		...initialCameraView,
		duration: 2.5
	});
}

function setupSpawnPicker() {
	const viewer = getViewer();
	const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
	const instructionText = document.getElementById('instruction-text');

	handler.setInputAction((click) => {
		if (currentState !== States.PICK_SPAWN) return;

		const ray = viewer.camera.getPickRay(click.position);
		const cartesian = viewer.scene.globe.pick(ray, viewer.scene);

		if (cartesian) {
			const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
			const lon = Cesium.Math.toDegrees(cartographic.longitude);
			const lat = Cesium.Math.toDegrees(cartographic.latitude);

			state.lon = lon;
			state.lat = lat;
			state.alt = Math.max(0, cartographic.height) + 1500;

			instructionText.textContent = 'FETCHING LOCATION INFO...';

			reverseGeocode(lon, lat).then(regionName => {
				if (regionName && currentState === States.PICK_SPAWN) {
					instructionText.textContent = regionName;
					if (spawnMarker) {
						spawnMarker.label.text = regionName;
					}
				}
			}).catch(() => { });

			Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [cartographic])
				.then(([p]) => state.alt = Math.max(0, p.height || 0) + 1500)
				.catch(() => { });

			if (spawnMarker) {
				viewer.entities.remove(spawnMarker);
			}
			spawnMarker = viewer.entities.add({
				position: cartesian,
				point: {
					pixelSize: 15,
					color: Cesium.Color.RED,
					outlineColor: Cesium.Color.WHITE,
					outlineWidth: 2,
					disableDepthTestDistance: Number.POSITIVE_INFINITY
				},
				label: {
					text: "Target Spawn Location",
					font: `14pt ${getComputedStyle(document.body).fontFamily}`,
					style: Cesium.LabelStyle.FILL_AND_OUTLINE,
					outlineWidth: 2,
					verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
					pixelOffset: new Cesium.Cartesian2(0, -20),
					disableDepthTestDistance: Number.POSITIVE_INFINITY
				}
			});

			confirmSpawnBtn.classList.remove('hidden');
		}
	}, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

function setupLocationSearch() {
	const searchInput = document.getElementById('locationSearch');
	const resultsContainer = document.getElementById('search-results');
	const instructionText = document.getElementById('instruction-text');
	const searchToggleBtn = document.getElementById('search-toggle-btn');
	const originalSearchIcon = searchToggleBtn ? searchToggleBtn.innerHTML : '';
	let debounceTimer;

	if (searchToggleBtn) {
		searchToggleBtn.onclick = (e) => {
			e.stopPropagation();
			const isSearching = searchInput.style.display === 'block';

			if (isSearching) {
				searchInput.style.display = 'none';
				instructionText.style.display = 'block';
				resultsContainer.style.display = 'none';
			} else {
				searchInput.style.display = 'block';
				instructionText.style.display = 'none';
				searchInput.focus();
			}
		};
	}

	searchInput.addEventListener('input', (e) => {
		clearTimeout(debounceTimer);
		const query = e.target.value.trim();

		if (query.length < 3) {
			resultsContainer.style.display = 'none';
			return;
		}

		debounceTimer = setTimeout(async () => {
			if (searchToggleBtn) {
				searchToggleBtn.innerHTML = '<div class="loader-spinner"></div>';
			}

			try {
				const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5`);
				const data = await response.json();

				resultsContainer.innerHTML = '';
				if (data.length > 0) {
					data.forEach(item => {
						const div = document.createElement('div');
						div.textContent = item.display_name;
						div.style.padding = '10px';
						div.style.cursor = 'pointer';
						div.onclick = () => {
							const lon = parseFloat(item.lon);
							const lat = parseFloat(item.lat);

							const viewer = getViewer();
							const position = Cesium.Cartesian3.fromDegrees(lon, lat);

							state.lon = lon;
							state.lat = lat;
							state.alt = 1500;

							const cartographic = Cesium.Cartographic.fromDegrees(lon, lat);
							Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [cartographic])
								.then(([p]) => {
									state.alt = Math.max(0, p.height || 0) + 1500;
								})
								.catch(() => { });

							viewer.camera.flyTo({
								destination: Cesium.Cartesian3.fromDegrees(lon, lat, 15000),
								duration: 1.5
							});

							if (spawnMarker) {
								viewer.entities.remove(spawnMarker);
							}
							spawnMarker = viewer.entities.add({
								position: position,
								point: {
									pixelSize: 15,
									color: Cesium.Color.RED,
									outlineColor: Cesium.Color.WHITE,
									outlineWidth: 2,
									disableDepthTestDistance: Number.POSITIVE_INFINITY
								},
								label: {
									text: item.display_name.split(',')[0],
									font: `14pt ${getComputedStyle(document.body).fontFamily}`,
									style: Cesium.LabelStyle.FILL_AND_OUTLINE,
									outlineWidth: 2,
									verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
									pixelOffset: new Cesium.Cartesian2(0, -20),
									disableDepthTestDistance: Number.POSITIVE_INFINITY
								}
							});

							confirmSpawnBtn.classList.remove('hidden');
							resultsContainer.style.display = 'none';

							searchInput.style.display = 'none';
							instructionText.style.display = 'block';
							instructionText.textContent = item.display_name.split(',')[0].toUpperCase();
							searchInput.value = item.display_name;
						};
						resultsContainer.appendChild(div);
					});
					resultsContainer.style.display = 'block';
				} else {
					resultsContainer.style.display = 'none';
				}
			} catch (error) {
				console.error('Search error:', error);
			} finally {
				if (searchToggleBtn) {
					searchToggleBtn.innerHTML = originalSearchIcon;
				}
			}
		}, 500);
	});

	document.addEventListener('click', (e) => {
		if (!searchInput.contains(e.target) && !resultsContainer.contains(e.target) && !searchToggleBtn.contains(e.target)) {
			resultsContainer.style.display = 'none';
			if (searchInput.style.display === 'block') {
				searchInput.style.display = 'none';
				instructionText.style.display = 'block';
			}
		}
	});
}

document.getElementById('confirmSpawnBtn').onclick = () => {
	const vignette = document.getElementById('transition-vignette');
	if (vignette) vignette.style.opacity = '1';

	soundManager.play('spawn');

	setTimeout(() => {
		const viewer = getViewer();
		if (spawnMarker) {
			viewer.entities.remove(spawnMarker);
			spawnMarker = null;
		}

		setControlsEnabled(false);

		state.speed = 100;
		state.pitch = 0;
		state.roll = 0;

		try {
			const cam = viewer && viewer.camera;
			if (cam && typeof cam.heading === 'number') {
				state.heading = Cesium.Math.toDegrees(cam.heading);
			} else {
				state.heading = 0;
			}
		} catch (e) {
			state.heading = 0;
		}

		currentRegionName = null;
		lastGeocodeTime = 0;
		lastGeocodePos = { lon: 0, lat: 0 };

		visualOffset.copy(BASE_PLANE_POS);
		visualRotation.set(0, 0, 0);
		boostRoll = 0;
		currentBoostZOffset = 0;
		lastIsBoosting = false;

		controller.reset();
		physics = new PlanePhysics();
		physics.reset(state.lon, state.lat, state.alt, state.heading, state.pitch, state.roll);

		hud.resetTime();
		hud.resizeMinimap();

		if (weaponSystem && typeof weaponSystem.resetAmmo === 'function') {
			weaponSystem.resetAmmo();
		}

		// Respawn clears the dead flag so TargetManager can re-acquire us.
		state.destroyed = false;

		// Hand off initial world population to the active scenario. For the
		// default 3-way BVR fight this just seeds one NPC and flips
		// autoSpawn back on; for lab scenarios like the notching test the
		// scenario is in charge of placement and disables auto-spawn.
		if (npcSystem) {
			const scn = getActiveScenario();
			const ctx = { npcSystem, playerState: state, viewer: getViewer(), scene, weaponSystem, hud };
			if (scn && scn.onStart) scn.onStart(ctx);
			else npcSystem.spawnNPC(state.lon, state.lat, state.alt);
		}

		spawnInstruction.classList.add('hidden');
		confirmSpawnBtn.classList.add('hidden');
		loadingIndicator.classList.add('hidden');

		currentState = States.TRANSITIONING;
		setRenderOptimization(false);

		viewer.camera.flyTo({
			destination: Cesium.Cartesian3.fromDegrees(state.lon, state.lat, state.alt),
			orientation: {
				heading: Cesium.Math.toRadians(state.heading),
				pitch: Cesium.Math.toRadians(state.pitch),
				roll: Cesium.Math.toRadians(state.roll)
			},
			duration: 2.0,
			easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
			complete: () => {
				flightStartTime = Date.now();
				uiContainer.classList.remove('hidden');
				const weaponsHud = document.getElementById('weapons-hud');
				if (weaponsHud) weaponsHud.classList.remove('hidden');
				threeContainer.classList.remove('hidden');
				hud.resizeMinimap();
				currentState = States.FLYING;
				soundManager.play('jet-engine', 1.0);
				if (vignette) vignette.style.opacity = '0';

				if (dialogueSystem) {
					dialogueSystem.start();
				}
			}
		});
	}, 500);
};

window.addEventListener('keydown', (e) => {
	const key = e.key.toLowerCase();
	if (key === 'escape') {
		const openModals = document.querySelectorAll('.modal:not(.hidden)');
		if (openModals.length > 0) {
			openModals.forEach(m => m.classList.add('hidden'));
			return;
		}
	}

	// Space toggles pause while the commander view is open. Lighter-weight
	// than Escape/P: no pause menu overlay, just freezes the world so you
	// can survey the battlefield without it evolving under you. The map's
	// own pan/zoom/tilt still works because we keep ticking commanderView
	// while paused (see update()). Outside the map, Space falls through so
	// other systems can use it.
	// Radar emitter toggle (silent-running test). Bound to 'r' in
	// cockpit flight only. Commander view also binds 'r' (debug overlay)
	// but gates on commanderView.active, so the two don't collide. Flips
	// state.sensors.radar.active, which the unified detectRadar() reads
	// as the emitter-on check.
	if (key === 'r' && currentState === States.FLYING &&
		!(commanderView && commanderView.active)) {
		if (state.sensors && state.sensors.radar) {
			state.sensors.radar.active = !state.sensors.radar.active;
		}
		e.preventDefault();
		return;
	}

	if (key === ' ' && commanderView && commanderView.active) {
		if (currentState === States.FLYING) {
			currentState = States.PAUSED;
			if (dialogueSystem) dialogueSystem.pause();
			pauseGameplaySounds();
		} else if (currentState === States.PAUSED) {
			currentState = States.FLYING;
			if (dialogueSystem) dialogueSystem.resume();
			// Defensive: if the user paused with ESC/P first (which shows
			// the full pause menu), hide it on Space-unpause so the map
			// isn't left with a lingering overlay.
			pauseMenu.classList.add('hidden');
			resumeGameplaySounds();
		}
		if (commanderView.setPausedBadge) {
			commanderView.setPausedBadge(currentState === States.PAUSED);
		}
		e.preventDefault();
		return;
	}

	if (key === 'escape' || key === 'p') {
		if (currentState === States.FLYING) {
			currentState = States.PAUSED;
			if (dialogueSystem) dialogueSystem.pause();
			uiContainer.classList.add('hidden');
			const weaponsHud = document.getElementById('weapons-hud');
			if (weaponsHud) weaponsHud.classList.add('hidden');
			pauseMenu.classList.remove('hidden');
			hud.resizeMinimap();
			pauseGameplaySounds();
			hud.update(state, []);
		} else if (currentState === States.PAUSED) {
			currentState = States.FLYING;
			if (dialogueSystem) dialogueSystem.resume();
			pauseMenu.classList.add('hidden');
			uiContainer.classList.remove('hidden');
			const weaponsHud = document.getElementById('weapons-hud');
			if (weaponsHud) weaponsHud.classList.remove('hidden');
			resumeGameplaySounds();
		} else if (currentState === States.PICK_SPAWN && key === 'escape') {
			exitSpawnPicking();
		}
	}

	if (key === 'z' && currentState === States.FLYING) {
		if (dialogueSystem) dialogueSystem.skip();
	}
});

document.addEventListener('visibilitychange', () => {
	if (document.hidden && currentState === States.FLYING) {
		currentState = States.PAUSED;
		if (dialogueSystem) dialogueSystem.pause();
		uiContainer.classList.add('hidden');
		pauseMenu.classList.remove('hidden');
		hud.resizeMinimap();
		pauseGameplaySounds();
		hud.update(state, []);
	}
});

window.addEventListener('blur', () => {
	if (currentState === States.FLYING) {
		currentState = States.PAUSED;
		if (dialogueSystem) dialogueSystem.pause();
		uiContainer.classList.add('hidden');
		pauseMenu.classList.remove('hidden');
		hud.resizeMinimap();
		pauseGameplaySounds();
		hud.update(state, []);
	}
});

const viewer = initCesium();

loadingStatus.cesium = true;
updateLoadingUI();

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
			updateLoadingUI();
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

initThree();
npcSystem = new NPCSystem(viewer, scene, new GLTFLoader());
setupSpawnPicker();

// Build the main-menu scenario picker from the registry. Dropping a new
// file in src/systems/scenarios/ and registering it in scenarios/index.js
// is enough — one card per entry appears automatically, styled to match
// the tactical-green menu aesthetic.
(function setupScenarioPicker() {
	const container = document.getElementById('scenarioCards');
	if (!container) return;

	const cards = new Map(); // id → DOM element

	const select = (id) => {
		setActiveScenario(id);
		for (const [cid, el] of cards) {
			el.classList.toggle('selected', cid === id);
			el.setAttribute('aria-pressed', cid === id ? 'true' : 'false');
		}
	};

	const firstId = Object.keys(SCENARIOS)[0];
	for (const [id, scn] of Object.entries(SCENARIOS)) {
		const card = document.createElement('button');
		card.type = 'button';
		card.className = 'scenario-card clickable-ui';
		card.setAttribute('role', 'radio');
		card.setAttribute('aria-pressed', 'false');
		card.innerHTML = `
			<span class="card-name">${scn.name || id}</span>
			<span class="card-desc">${scn.description || ''}</span>
		`;
		card.addEventListener('click', () => select(id));
		container.appendChild(card);
		cards.set(id, card);
	}

	if (firstId) select(firstId);
})();

setupLocationSearch();
loadSettings();

uiContainer.classList.add('hidden');
threeContainer.classList.add('hidden');

updateLoadingUI();
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
