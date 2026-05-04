// ============================================================================
// Spawn-picker + flight-start + respawn flow.
//
// The full lifecycle around "player isn't flying yet" and "player just
// got back into the air after crashing":
//   - enterSpawnPicking()     Tear down NPCs, fade the HUD, show the map.
//   - setupSpawnPicker()      Cesium LEFT_CLICK handler that drops a spawn
//                             marker and terrain-clamps state.alt.
//   - setupConfirmSpawn()     Wires the CONFIRM button: resets physics,
//                             applies loadout, remembers the pose, fades
//                             back into FLYING via a 2s camera flyTo.
//   - exitSpawnPicking()      Cancel path — ESC out of the picker back to
//                             the main menu.
//   - quickRespawn()          Post-crash fast path: reuse the stored pose
//                             without going back through the map picker.
//
// Extracted from main.js — every branch preserves the exact original
// order of side effects (sound stops, vignette fade, setControlsEnabled,
// camera flyTo timing, state-flag writes). Module-private: `spawnMarker`
// (the Cesium entity currently pinned on the map) and `_scenarioSpawnPoint`
// (the pose to replay on quickRespawn).
//
// The caller supplies a `ctx` object because main.js still owns the
// player state, physics instance, and a bag of cockpit-visual `let`
// bindings (BASE_PLANE_POS, visualOffset, visualRotation, boostRoll,
// currentBoostZOffset, lastIsBoosting). Getters / setters on ctx keep
// those reassignments observable from inside this module.
// ============================================================================

import * as Cesium from 'cesium';
import { PlanePhysics } from '../plane/planePhysics';
import { getActivePlane, getActivePlaneId, PLANES } from '../plane/planes';
import { simTypeCounts, effectiveRcsM2, buildHardpointPlan } from '../plane/loadout';
import { SIGNATURES } from './signatures';
import { getActiveScenario, getActiveScenarioId, getRawScenario } from './scenarios';
import { getViewer, setControlsEnabled, setRenderOptimization } from '../world/cesiumWorld';
import { reverseGeocode } from '../world/regions';
import { soundManager } from '../utils/soundManager';
import { stopAllFlyingSounds } from '../utils/gameplaySounds';
import { clearEvents } from './eventLog';
import { gameSettings, saveSettings } from '../ui/settings';
import { setFormation, clearFormation } from './formation.js';
import { createWingmanPilot } from './ai/index.js';
import { applyNpcLoadout } from './scenarios/scenarioRunner.js';

// Module-private state — only this file reads or writes either.
// `spawnMarker` is the Cesium point-entity dropped on the map while the
// user is choosing a spawn. `_scenarioSpawnPoint` is the pose remembered
// from the last confirm-spawn so quickRespawn() can snap straight back
// into the fight without tearing the scenario down.
let spawnMarker = null;
let _scenarioSpawnPoint = null;
// True between enterRespawnAsNewPlane → setupConfirmSpawn's CONFIRM
// click. Tells the confirm path to skip scenario.onStart (the
// scenario is already running) and skip clearing/re-seeding existing
// NPCs. The flag clears at the end of the confirm flow.
let _continuingScenario = false;

// Accessors exposed for modules that also touch the spawn marker
// (currently the Nominatim location-search dropdown). Keeps ownership
// here while letting outsiders swap the entity in/out.
export function getSpawnMarker() { return spawnMarker; }
export function setSpawnMarker(entity) { spawnMarker = entity; }

// True once the user has confirmed at least one spawn in the current
// session — the crash-menu RESPAWN button uses this to decide whether
// to quick-respawn or fall through to the full map picker.
export function hasScenarioSpawnPoint() { return _scenarioSpawnPoint != null; }

// Quick respawn at the stored spawn pose. Skips the whole map-picker
// flow — the scenario stays running, NPCs keep engaging each other,
// the player just pops back into the air.
export function quickRespawn(ctx) {
	const sp = _scenarioSpawnPoint;
	const { state } = ctx;
	state.lon = sp.lon;
	state.lat = sp.lat;
	state.alt = sp.alt;
	state.heading = sp.heading;
	state.pitch = 0;
	state.roll  = 0;
	state.speed = 100;
	state.destroyed = false;

	// Wipe the kill log so each fresh sortie starts with a clean
	// recap. Carrying it across deaths would be defensible too;
	// we go with the same fresh-slate semantics the rest of spawn uses.
	clearEvents();

	// Fresh physics constructed from the active plane's complete spec.
	const plane = getActivePlane();
	const physics = new PlanePhysics({
		...plane.physicsOverrides,
		__id: plane.id,
	});
	physics.reset(state.lon, state.lat, state.alt, state.heading, 0, 0);
	ctx.setPhysics(physics);

	ctx.controller.reset();
	ctx.visualOffset.copy(ctx.BASE_PLANE_POS);
	ctx.visualRotation.set(0, 0, 0);
	ctx.setBoostRoll(0);
	ctx.setCurrentBoostZOffset(0);
	ctx.setLastIsBoosting(false);

	// Re-apply loadout ammo counts.
	const weaponSystem = ctx.weaponSystem;
	if (weaponSystem && typeof weaponSystem.applyLoadout === 'function') {
		weaponSystem.applyLoadout(simTypeCounts(getActivePlaneId()));
		if (typeof weaponSystem.resetAmmo === 'function') weaponSystem.resetAmmo();
	}

	// UI flip: hide crash screen, show HUD, go back to FLYING.
	document.getElementById('crashMenu').classList.add('hidden');
	document.getElementById('uiContainer').classList.remove('hidden');
	const weaponsHud = document.getElementById('weapons-hud');
	if (weaponsHud) weaponsHud.classList.remove('hidden');
	const threeContainer = document.getElementById('threeContainer');
	if (threeContainer) threeContainer.classList.remove('hidden');
	ctx.setCurrentState('FLYING');
	ctx.setFlightStartTime(Date.now());

	try { soundManager.play('spawn'); } catch (e) {}
	try {
		soundManager.stop('ambient-crash', 0.3);
		soundManager.play('jet-engine', 1.0);
	} catch (e) {}
}

// Mid-mission airframe switch. Called from the pause menu's "SWITCH
// AIRFRAME" button. Snapshots the player's current jet into a friendly
// NPC (so they keep flying as a wingman to whoever is left), opens the
// spawn picker just like enterSpawnPicking — but does NOT clear the
// scenario or its NPCs. The follow-up CONFIRM click rebuilds physics
// + signature + loadout for the newly-picked plane and snaps the
// player into the air without re-running scenario.onStart.
export function enterRespawnAsNewPlane(ctx) {
	const { state } = ctx;
	// Snapshot the player → autonomous friendly fighter NPC at the
	// same pose, plane, and loadout. Best-effort: if the NPC system
	// can't make a fighter (model not loaded yet, etc.) we still
	// proceed with the airframe switch.
	_clonePlayerToNpc(ctx);

	_continuingScenario = true;

	// The pause menu was open before the click. Hide it and the
	// flight HUD so the spawn picker has the screen to itself.
	const pauseMenu = document.getElementById('pauseMenu');
	if (pauseMenu) pauseMenu.classList.add('hidden');
	const uiContainer = document.getElementById('uiContainer');
	if (uiContainer) uiContainer.classList.add('hidden');
	const weaponsHud = document.getElementById('weapons-hud');
	if (weaponsHud) weaponsHud.classList.add('hidden');
	const threeContainer = document.getElementById('threeContainer');
	if (threeContainer) threeContainer.classList.add('hidden');

	if (ctx.dialogueSystem) ctx.dialogueSystem.stop();
	stopAllFlyingSounds(0.3);

	// Spawn-picker UI setup — mirrors enterSpawnPicking's tail end
	// but skips npcSystem.clear / clearFormation / scenario.onStop.
	const spawnInstruction = document.getElementById('spawnInstruction');
	const confirmSpawnBtn  = document.getElementById('confirmSpawnBtn');
	if (spawnInstruction) spawnInstruction.classList.remove('hidden');
	const changeAfBtn = document.getElementById('changeAirframeFromSpawnBtn');
	if (changeAfBtn) {
		changeAfBtn.classList.remove('hidden');
		changeAfBtn.onclick = () => {
			const trigger = document.getElementById('changeAirframeBtn');
			if (trigger) trigger.click();
		};
	}
	// Auto-open the airframe modal so the user lands directly on
	// plane / loadout selection. They can pick their plane, confirm
	// in the modal, and then click the map for the new spawn.
	setTimeout(() => {
		const trigger = document.getElementById('changeAirframeBtn');
		if (trigger) trigger.click();
	}, 50);
	const formationPanel = document.getElementById('formation-config');
	if (formationPanel) {
		formationPanel.classList.remove('hidden');
		_refreshFormationPanel();
	}
	ctx.setCurrentState('PICK_SPAWN');
	if (confirmSpawnBtn) confirmSpawnBtn.classList.add('hidden');

	const searchInput = document.getElementById('locationSearch');
	const instructionText = document.getElementById('instruction-text');
	const resultsContainer = document.getElementById('search-results');
	if (searchInput) {
		searchInput.value = '';
		searchInput.style.display = 'none';
	}
	if (instructionText) {
		instructionText.style.display = 'block';
		instructionText.textContent = 'CLICK ANYWHERE ON THE MAP TO CHOOSE A NEW SPAWN POINT — your old jet keeps flying';
	}
	if (resultsContainer) resultsContainer.style.display = 'none';
	setControlsEnabled(true);

	if (spawnMarker) {
		const viewer = getViewer();
		viewer.entities.remove(spawnMarker);
		spawnMarker = null;
	}
	const viewer = getViewer();
	if (viewer) {
		viewer.camera.flyTo({
			destination: Cesium.Cartesian3.fromDegrees(state.lon, state.lat, 15000),
			duration: 1.5,
		});
	}
}

// Internal: snapshot the player's current pose/plane/loadout into a
// friendly NPC fighter so the old jet keeps flying after the user
// switches airframes. The new NPC is on the player's team with a
// stock fighter pilot (engage-on-sight CAP behaviour).
function _clonePlayerToNpc(ctx) {
	const { state, npcSystem } = ctx;
	if (!npcSystem || typeof npcSystem.createNPCMesh !== 'function') return null;
	const planeId = getActivePlaneId();
	const team    = state.team || 'friendly';
	const npc = npcSystem.createNPCMesh(
		`EX-PLAYER ${100 + Math.floor(Math.random() * 900)}`,
		state.lon, state.lat, state.alt,
		state.heading || 0,
		Math.max(120, state.speed || 200),
		team,
		planeId,
	);
	if (!npc) return null;
	// Carry over the player's current signature (so externals still
	// count) and apply their hardpoint loadout to the NPC's weapon
	// subsystem. Best-effort — if anything's missing we leave the
	// NPC's defaults in place and move on.
	if (state.signature) npc.signature = { ...state.signature };
	try {
		const counts = simTypeCounts(planeId);
		if (counts) applyNpcLoadout(npc, counts);
	} catch (e) {}
	return npc;
}

// Drop into the map-picker state: tear down the running scenario + NPCs,
// fade the HUD out via the transition vignette, and fly the Cesium
// camera to the user's last-known or persisted spawn coords. The
// `useVignette=false` path is used when we're already in a transition
// overlay and a second fade would double-flash.
export function enterSpawnPicking(ctx, useVignette = true) {
	const { state } = ctx;
	state.score = 0;
	// If the user has a persisted spawn from a previous session, seed
	// the state with it so the Cesium camera flies toward it. The user
	// can still click somewhere else to pick a new one; we just avoid
	// starting from wherever their IP-geolocation defaulted to every
	// time.
	if (gameSettings.lastSpawn &&
		typeof gameSettings.lastSpawn.lon === 'number' &&
		typeof gameSettings.lastSpawn.lat === 'number') {
		state.lon = gameSettings.lastSpawn.lon;
		state.lat = gameSettings.lastSpawn.lat;
		state.alt = gameSettings.lastSpawn.alt ?? state.alt;
	}

	// Let the scenario tear down its overlays / reset state before we
	// wipe NPCs and rebuild. Safe to call even on first spawn (onStop
	// is idempotent for all scenarios).
	{
		const scn = getActiveScenario();
		if (scn && scn.onStop) {
			scn.onStop({
				npcSystem: ctx.npcSystem, playerState: state, viewer: getViewer(),
				scene: ctx.scene, weaponSystem: ctx.weaponSystem, hud: ctx.hud,
			});
		}
	}
	if (ctx.npcSystem) ctx.npcSystem.clear();
	// Wingmen got destroyed by npcSystem.clear(); drop the dangling
	// references so we don't try to read from freed npcs in the
	// frame between spawn-pick and the new formation being built.
	clearFormation();
	stopAllFlyingSounds(0.3);
	soundManager.play('zoom-in');
	soundManager.play('wind', 1.0);
	const vignette = document.getElementById('transition-vignette');
	if (useVignette && vignette) vignette.style.opacity = '1';

	const delay = useVignette ? 500 : 0;

	setTimeout(() => {
		const spawnInstruction = document.getElementById('spawnInstruction');
		const threeContainer   = document.getElementById('threeContainer');
		const uiContainer      = document.getElementById('uiContainer');
		const confirmSpawnBtn  = document.getElementById('confirmSpawnBtn');
		spawnInstruction.classList.remove('hidden');
		// Formation config panel only meaningful while picking a spawn —
		// the user can adjust wingmen count + break behavior right
		// before committing. Show it here, hide it back in
		// setupConfirmSpawn after the user clicks CONFIRM.
		const formationPanel = document.getElementById('formation-config');
		if (formationPanel) {
			formationPanel.classList.remove('hidden');
			_refreshFormationPanel();
		}
		threeContainer.classList.add('hidden');
		uiContainer.classList.add('hidden');
		const weaponsHud = document.getElementById('weapons-hud');
		if (weaponsHud) weaponsHud.classList.add('hidden');
		ctx.setCurrentState('PICK_SPAWN');
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
			},
		});
	}, delay);
}

// Cancel the spawn picker and go back to the main menu. Used by the
// Escape/P keybinding in the map state.
export function exitSpawnPicking(ctx) {
	soundManager.play('zoom-in');
	soundManager.stop('wind', 1.0);
	stopAllFlyingSounds(0.3);
	document.getElementById('spawnInstruction').classList.add('hidden');
	document.getElementById('confirmSpawnBtn').classList.add('hidden');
	const changeAfBtnExit = document.getElementById('changeAirframeFromSpawnBtn');
	if (changeAfBtnExit) changeAfBtnExit.classList.add('hidden');
	document.getElementById('mainMenu').classList.remove('hidden');
	ctx.setCurrentState('MENU');
	document.getElementById('loadingIndicator').classList.add('hidden');
	setRenderOptimization(true);

	setControlsEnabled(false);

	if (spawnMarker) {
		const viewer = getViewer();
		viewer.entities.remove(spawnMarker);
		spawnMarker = null;
	}

	const viewer = getViewer();
	const initialCameraView = ctx.getInitialCameraView();
	viewer.camera.flyTo({
		...initialCameraView,
		duration: 2.5,
	});
}

// Install the Cesium LEFT_CLICK handler that places the spawn marker
// on the globe during PICK_SPAWN. Only listens while currentState is
// PICK_SPAWN so it doesn't hijack clicks in other modes. Runs reverse-
// geocoding + terrain-clamp + marker swap on every click.
export function setupSpawnPicker(ctx) {
	const viewer = getViewer();
	const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
	const instructionText = document.getElementById('instruction-text');
	const confirmSpawnBtn = document.getElementById('confirmSpawnBtn');
	const { state } = ctx;

	handler.setInputAction((click) => {
		if (ctx.currentState !== 'PICK_SPAWN') return;

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
				if (regionName && ctx.currentState === 'PICK_SPAWN') {
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
					disableDepthTestDistance: Number.POSITIVE_INFINITY,
				},
				label: {
					text: 'Target Spawn Location',
					font: `14pt ${getComputedStyle(document.body).fontFamily}`,
					style: Cesium.LabelStyle.FILL_AND_OUTLINE,
					outlineWidth: 2,
					verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
					pixelOffset: new Cesium.Cartesian2(0, -20),
					disableDepthTestDistance: Number.POSITIVE_INFINITY,
				},
			});

			confirmSpawnBtn.classList.remove('hidden');
		}
	}, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

// Wire the CONFIRM button inside the map picker. The click handler is
// the single most behaviour-sensitive bit of the spawn flow — a
// 500 ms fade-to-white setTimeout wraps a ~100-line physics/HUD/
// loadout/scenario reset sequence that ends with a 2 s camera flyTo,
// whose completion callback flips currentState to FLYING. Every step
// is byte-equivalent to the original inline onclick.
export function setupConfirmSpawn(ctx) {
	const { state } = ctx;
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

			ctx.resetGeocodeState();

			ctx.visualOffset.copy(ctx.BASE_PLANE_POS);
			ctx.visualRotation.set(0, 0, 0);
			ctx.setBoostRoll(0);
			ctx.setCurrentBoostZOffset(0);
			ctx.setLastIsBoosting(false);

			ctx.controller.reset();

			// 10b — world-anchored scenario override. If the active
			// scenario JSON has anchor.mode === 'world' and a
			// playerSpawn block, that's the authored-in player start.
			// Override whatever the user picked / inherited from
			// last-spawn so the editor's PLAYER START marker is
			// authoritative when flying the scenario.
			//
			// SWITCH-AIRFRAME path skips this — the user just clicked
			// a fresh point on the map, that's what they want.
			if (!_continuingScenario) {
				const raw = getRawScenario(getActiveScenarioId());
				const ps = raw && raw.anchor && raw.anchor.mode === 'world'
					? raw.anchor.playerSpawn : null;
				if (ps && typeof ps.lon === 'number' && typeof ps.lat === 'number') {
					state.lon = ps.lon;
					state.lat = ps.lat;
					if (typeof ps.alt === 'number')      state.alt = ps.alt;
					if (typeof ps.heading === 'number')  state.heading = ps.heading;
					if (typeof ps.speed === 'number')    state.speed = ps.speed;
				}
			}

			// Rebuild physics from the active plane's spec — strict-spec
			// PlanePhysics requires a complete physicsOverrides block.
			const activePlane = getActivePlane();
			const physics = new PlanePhysics({
				...activePlane.physicsOverrides,
				__id: activePlane.id,
			});
			physics.reset(state.lon, state.lat, state.alt, state.heading, state.pitch, state.roll);
			ctx.setPhysics(physics);

			// Remember this spawn pose so quickRespawn() (crash-menu
			// RESPAWN) can restore it without tearing down the scenario.
			_scenarioSpawnPoint = {
				lon: state.lon, lat: state.lat, alt: state.alt,
				heading: state.heading,
			};
			// Persist across page reloads so reopening the sim jumps
			// back to the last spawn instead of asking the user to
			// re-pick.
			gameSettings.lastSpawn = { ..._scenarioSpawnPoint };
			saveSettings();

			ctx.hud.resetTime();
			ctx.hud.resizeMinimap();

			// Apply per-spawn loadout → weapon ammo counts. Pulls the
			// user's picks from the loadout module (keyed on active
			// plane), maps to simType counts, and configures the
			// weaponSystem. Any simType not in the loadout ends up at
			// 0 ammo.
			const weaponSystem = ctx.weaponSystem;
			if (weaponSystem && typeof weaponSystem.applyLoadout === 'function') {
				const planeId = getActivePlaneId();
				weaponSystem.applyLoadout(simTypeCounts(planeId));
			}
			if (weaponSystem && typeof weaponSystem.resetAmmo === 'function') {
				weaponSystem.resetAmmo();
			}

			// External-store RCS. Previously this was a binary "swap
			// to non-stealth 12 m² if any external is loaded" — way
			// too punishing. The real model is additive: effective
			// RCS = airframe baseline + sum of external-store
			// contributions. A clean F-22 at 0.008 m² carrying 4
			// external AIM-120s becomes 0.008 + 4×0.03 = 0.128 m² —
			// 16× worse than clean stealth but still ~100× better
			// than a 4th-gen target. IR / visual signatures stay as
			// the airframe default; only RCS is modulated by loadout.
			{
				const planeId = getActivePlaneId();
				const plane   = PLANES[planeId];
				if (plane && SIGNATURES[plane.signature]) {
					const baseline = SIGNATURES[plane.signature].rcs || 0;
					state.signature = {
						...SIGNATURES[plane.signature],
						rcs: effectiveRcsM2(planeId),
					};
					// Per-shot RCS bookkeeping: store the airframe
					// baseline so consumeHardpointShot() can clamp,
					// and the ordered hardpoint plan so each fire
					// pops exactly one entry. Externals leaving the
					// rails subtract their rcsContributionM2;
					// internal-bay shots are no-ops. The clean RCS is
					// what's left once every external is gone.
					state._airframeBaselineRcs = baseline;
					state._loadoutHardpoints   = buildHardpointPlan(planeId);
				}
			}

			// Respawn clears the dead flag so TargetManager can re-
			// acquire us.
			state.destroyed = false;
			clearEvents();

			// Hand off initial world population to the active scenario.
			// For the default 3-way BVR fight this just seeds one NPC
			// and flips autoSpawn back on; for lab scenarios like the
			// notching test the scenario is in charge of placement and
			// disables auto-spawn.
			//
			// SWITCH-AIRFRAME path: the scenario is already running
			// (NPCs alive, objectives in progress). Skip onStart so we
			// don't double-spawn enemies, and skip wingman seeding —
			// the existing wingmen keep flying behind the cloned
			// ex-player NPC.
			if (ctx.npcSystem && !_continuingScenario) {
				const scn = getActiveScenario();
				const scnCtx = {
					npcSystem: ctx.npcSystem, playerState: state,
					viewer: getViewer(), scene: ctx.scene,
					weaponSystem: ctx.weaponSystem, hud: ctx.hud,
				};
				if (scn && scn.onStart) scn.onStart(scnCtx);
				else ctx.npcSystem.spawnNPC(state.lon, state.lat, state.alt);

				// Player formation (Phase 5.5). After scenario.onStart has
				// seeded its own NPCs, spawn 0–3 wingmen on the player's
				// team. Each gets the player's currently-active airframe,
				// the player's loadout (one ammo set per wingman), and a
				// wingman pilot with FormationBehavior at high priority.
				// Spawns are nudged into formation slots so they don't
				// pile up on top of the leader.
				_spawnPlayerFormation(ctx, state);
			}
			_continuingScenario = false;

			document.getElementById('spawnInstruction').classList.add('hidden');
			document.getElementById('confirmSpawnBtn').classList.add('hidden');
			const changeAfBtnDone = document.getElementById('changeAirframeFromSpawnBtn');
			if (changeAfBtnDone) changeAfBtnDone.classList.add('hidden');
			document.getElementById('loadingIndicator').classList.add('hidden');
			const formationPanelDone = document.getElementById('formation-config');
			if (formationPanelDone) formationPanelDone.classList.add('hidden');

			ctx.setCurrentState('TRANSITIONING');
			setRenderOptimization(false);

			viewer.camera.flyTo({
				destination: Cesium.Cartesian3.fromDegrees(state.lon, state.lat, state.alt),
				orientation: {
					heading: Cesium.Math.toRadians(state.heading),
					pitch: Cesium.Math.toRadians(state.pitch),
					roll: Cesium.Math.toRadians(state.roll),
				},
				duration: 2.0,
				easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
				complete: () => {
					ctx.setFlightStartTime(Date.now());
					document.getElementById('uiContainer').classList.remove('hidden');
					const weaponsHud = document.getElementById('weapons-hud');
					if (weaponsHud) weaponsHud.classList.remove('hidden');
					document.getElementById('threeContainer').classList.remove('hidden');
					ctx.hud.resizeMinimap();
					ctx.setCurrentState('FLYING');
					soundManager.play('jet-engine', 1.0);
					if (vignette) vignette.style.opacity = '0';

					if (ctx.dialogueSystem) {
						ctx.dialogueSystem.start();
					}
				},
			});
		}, 500);
	};
}

// Spawn the player's wingmen and register them in the flight singleton.
// Reads gameSettings.formation.{count, breakBehavior} (set by the spawn
// menu); count defaults to 0 (no wingmen) so existing scenarios with
// no flight UI configured behave as before.
//
// Each wingman is instantiated via npcSystem.createNPCMesh (same path
// fighter NPCs use), then has its pilot replaced by a wingmanPilot,
// and its loadout cloned from the player's currently-loaded weapon
// system. Spawns are placed in formation slots offset from the leader
// so they don't telefrag each other.
function _spawnPlayerFormation(ctx, state) {
	clearFormation();
	const cfg = (gameSettings && gameSettings.formation) || {};
	const count = Math.max(0, Math.min(3, cfg.count || 0));
	if (count === 0) return;

	const npcSystem = ctx.npcSystem;
	if (!npcSystem) return;

	// Match the slot offsets defined in flight.js so wingmen spawn
	// already roughly in their formation slots — saves them having
	// to chase the leader from far behind on game start.
	const slots = [
		{ right:  120, back:  60 },
		{ right: -120, back:  60 },
		{ right:    0, back: 200 },
	];

	const team = state.team || 'friendly';
	const cosLat = Math.cos((state.lat || 0) * Math.PI / 180) || 1;
	const hRad   = (state.heading || 0) * Math.PI / 180;
	const members = [];

	// Get the player's loadout (simType → ammo count) so each wingman
	// carries the same set. Each wingman gets a FULL set — that's the
	// whole point of bringing them.
	let playerLoadout = null;
	try {
		const planeId = getActivePlaneId();
		playerLoadout = simTypeCounts(planeId);
	} catch (e) {
		playerLoadout = null;
	}

	for (let i = 0; i < count; i++) {
		const slot   = slots[i] || slots[slots.length - 1];
		const bodyE  =  slot.right;
		const bodyN  = -slot.back;
		const east   =  bodyE * Math.cos(hRad) + bodyN * Math.sin(hRad);
		const north  = -bodyE * Math.sin(hRad) + bodyN * Math.cos(hRad);
		const lon    = state.lon + east  / (111320 * cosLat);
		const lat    = state.lat + north / 111320;
		const alt    = state.alt;

		const npc = npcSystem.createNPCMesh(
			`WINGMAN ${i + 1}`,
			lon, lat, alt,
			state.heading,
			Math.max(120, state.speed || 200),
			team,
		);
		if (!npc) continue;

		// Replace the default fighter pilot with a wingman pilot.
		// createNPCMesh assigns createFighterPilot by default.
		npc.pilot = createWingmanPilot(npc);

		// Apply the player's loadout to the wingman's WeaponSubsystem.
		// Each entry in the subsystem's weapons[] gets matched by `type`
		// and its ammo set to the requested count (or 0 if not in the
		// loadout). This mirrors the npcLoadout helper used elsewhere
		// for one-off scenario customization.
		if (playerLoadout) {
			const ws = npc.pilot.subsystems.weapons;
			if (ws && Array.isArray(ws.weapons)) {
				for (const w of ws.weapons) {
					if (w.ammo === Infinity) continue;
					const n = playerLoadout[w.type];
					if (typeof n === 'number') {
						w.ammo    = n;
						w.maxAmmo = n;
					}
				}
				// Add weapon entries for any simTypes the wingman's
				// default loadout doesn't include but the player has
				// (e.g. STORM-SHADOW, GBU-39 — strike weapons NPCs
				// don't normally carry). Without this, a flight
				// can't actually share strike-class munitions with
				// the player.
				for (const [simType, n] of Object.entries(playerLoadout)) {
					if (!ws.weapons.some(w => w.type === simType)) {
						ws.weapons.push({
							type: simType,
							ammo: n,
							maxAmmo: n,
							fireRate: 4.0,
							maxInFlight: 4,
							lastFire: 0,
						});
					}
				}
			}
		}

		members.push(npc);
	}

	setFormation({
		leader: state,
		members,
		spawnPoint: { lon: state.lon, lat: state.lat, alt: state.alt },
		breakBehavior: cfg.breakBehavior || 'rtb',
	});
	console.log('[formation] spawned', count, 'wingmen, breakBehavior=', cfg.breakBehavior || 'rtb');
}

// One-time setup for the formation-config panel that appears in the
// spawn-picker overlay. Wires the count and break-behavior buttons
// to gameSettings.formation, persists on click, and re-styles the
// active button so the user sees the current selection. Called once
// from main.js bootstrap, same as setupSpawnPicker / setupConfirmSpawn.
export function setupFormationPanel() {
	const panel = document.getElementById('formation-config');
	if (!panel) return;

	const countBtns = panel.querySelectorAll('.formation-count-btn');
	for (const b of countBtns) {
		b.addEventListener('click', () => {
			const n = parseInt(b.dataset.count, 10) || 0;
			gameSettings.formation = gameSettings.formation || {};
			gameSettings.formation.count = n;
			saveSettings();
			_refreshFormationPanel();
		});
	}

	const breakBtns = panel.querySelectorAll('.formation-break-btn');
	for (const b of breakBtns) {
		b.addEventListener('click', () => {
			const m = b.dataset.break || 'rtb';
			gameSettings.formation = gameSettings.formation || {};
			gameSettings.formation.breakBehavior = m;
			saveSettings();
			_refreshFormationPanel();
		});
	}
}

// Update the visual active-state of the formation panel buttons to
// match gameSettings.formation. Called after each click and when the
// panel becomes visible (so reload-time persisted values show up
// pre-selected).
function _refreshFormationPanel() {
	const panel = document.getElementById('formation-config');
	if (!panel) return;
	const cfg = (gameSettings && gameSettings.formation) || {};
	const count = cfg.count || 0;
	const brk   = cfg.breakBehavior || 'rtb';
	for (const b of panel.querySelectorAll('.formation-count-btn')) {
		const n = parseInt(b.dataset.count, 10) || 0;
		b.classList.toggle('active', n === count);
	}
	for (const b of panel.querySelectorAll('.formation-break-btn')) {
		b.classList.toggle('active', b.dataset.break === brk);
	}
}
