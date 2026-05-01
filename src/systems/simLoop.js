// ============================================================================
// Sim loop — the per-frame orchestration that was `update(dt)` in main.js.
//
// Runs everything the game needs to advance one step:
//   - Early-out for MENU / PICK_SPAWN / PAUSED (frozen world).
//   - Pilot input + physics for the player (FLYING only).
//   - Weapon system updates + cycle-target + fire triggers.
//   - Sensor scan across player + NPCs + all live projectiles.
//   - Player position integration from velocity, reverse-geocode tick.
//   - Crash detection + GPWS warning (crashDetection.js).
//   - Sound cues (engine / throttle / pitch / roll / boost).
//   - Commander view lazy-init.
//   - Spectator-target auto-clear.
//   - NPC system tick (must run BEFORE the camera block — see comment
//     inside — so spectatorTarget has frame-N coords when the chase cam
//     reads them).
//   - Camera placement (commander > spectator > pilot).
//   - Mesh rebake against the just-set camera (both player and NPC
//     projectile meshes bake with whichever camera was live when their
//     own update ran; a final rebake aligns them with what Cesium is
//     about to render).
//   - Scenario tick, HUD tick, commander tick, crash-menu visibility
//     gating, cockpit-plane visual animation.
//
// Every access goes through the `ctx` built in main.js; this module
// holds no state of its own.
// ============================================================================

import * as Cesium from 'cesium';
import * as THREE from 'three';
import { movePosition } from '../utils/math';
import { advanceLonLatAlt } from '../plane/aeroModel';
import { calculateDistance, reverseGeocode } from '../world/regions';
import {
	setCameraToPlane, setCameraBehindUnit, getViewer,
} from '../world/cesiumWorld';
import { updateSensors, setSensorScene } from './sensorSystem';
import { collectJamStrobes } from './ew/jammerSubsystem.js';
import { Contrail } from '../plane/contrail.js';
import { getTeamDatalink } from './teamDatalink';
import { getActiveScenario } from './scenarios';
import { CommanderView } from './commanderView';
import { StrikePlannerView } from './strikePlanner';
import { soundManager } from '../utils/soundManager';
import { checkCrash, checkGPWS } from './crashDetection';
import { updateTgp } from '../ui/tgp.js';

const GEOCODE_INTERVAL = 10000;
const GEOCODE_MIN_DIST = 1000;

export function update(dt, ctx) {
	const { state } = ctx;
	const currentState = ctx.currentState;

	// Menu-like states and paused state freeze the world entirely.
	if (currentState === 'MENU' || currentState === 'PICK_SPAWN') return;
	if (currentState === 'PAUSED') return;

	// CRASHED keeps the world ticking (NPCs, missiles, sensors,
	// commander view) so the player can press M and watch the rest of
	// the battle play out from above. Only player-specific updates
	// are gated.
	const isFlying = currentState === 'FLYING';
	// Tick the controller while spectating too — we need its
	// cameraYaw / cameraPitch (right-click drag) for the chase-cam
	// orbit. Weapon and number-key input from the controller stays
	// gated downstream on isFlying, so a dead spectator can't fire
	// or change loadout slots even though the controller is awake.
	const isSpectating = !isFlying && !!ctx.spectatorTarget;

	const controller = ctx.controller;
	const input = (isFlying || isSpectating) ? controller.update() : null;

	// Commander view suspends pilot control: stick goes neutral,
	// weapons safed, AB cut. Throttle stays at its last value so the
	// aircraft keeps flying on trim instead of slowing or stalling.
	// Mouse-steering overlay is suppressed for the same reason.
	let physicsResult = null;
	let prevSpeed = 0;
	if (isFlying) {
		prevSpeed = state.speed;
		// Both the commander view (god-eye map) and the spectator
		// mode (chase-cam on another unit) suspend pilot control. The
		// plane holds current throttle and flies on trim — neutral
		// stick, weapons safed, AB cut, mouse-steering off. The user
		// can look around (mouse drag) while the aircraft tracks
		// straight.
		const altCamActive = (ctx.commanderView && ctx.commanderView.active)
			|| (ctx.strikePlannerView && ctx.strikePlannerView.active);
		if (altCamActive || ctx.spectatorTarget) {
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

		// Hand the physics module the current altitude so its density
		// model is accurate. Altitude is owned by main.js (lon/lat
		// /alt state), not physics.
		const physics = ctx.physics;
		physics.currentAltitude = state.alt;
		physicsResult = physics.update(input, dt);

		state.speed    = physicsResult.speed;
		state.pitch    = physicsResult.pitch;
		state.roll     = physicsResult.roll;
		state.heading  = physicsResult.heading;
		state.throttle = input.throttle;
		state.yaw      = input.yaw;
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
		state.tvDeflection = physicsResult.tvDeflection || { pitch: 0, yaw: 0 };

		state.mouseSteering = !!input.mouseSteering;
		state.cursorX = input.cursorX;
		state.cursorY = input.cursorY;
	}

	const weaponSystem = ctx.weaponSystem;
	const npcSystem    = ctx.npcSystem;

	// Fields that the HUD / sensor / commander code reads every frame
	// regardless of state.
	state.weaponSystem   = weaponSystem;
	state.npcs           = npcSystem ? npcSystem.npcs : [];
	state.npcProjectiles = npcSystem ? npcSystem.projectiles : [];

	// Weapons: only trigger new fires while FLYING, but always call
	// update() so existing player missiles keep flying even after death.
	if (weaponSystem) {
		if (isFlying) {
			if (input.weaponIndex !== -1) weaponSystem.selectWeapon(input.weaponIndex);
			if (input.toggleWeapon)       weaponSystem.toggleWeapon();
			// Tab is contextual: with a HARM active it cycles the RWR's
			// designated emitter (so the player picks which SAM to hit),
			// otherwise it cycles the AESA designated target as before.
			if (input.cycleTargetFwd || input.cycleTargetBack) {
				const dir = input.cycleTargetFwd ? 1 : -1;
				const cur = weaponSystem.getCurrentWeapon && weaponSystem.getCurrentWeapon();
				if (cur && cur.id === 'agm') {
					weaponSystem.cycleDesignatedEmitter(state, dir);
				} else if (cur && cur.id === 'jammer') {
					const prev = weaponSystem.designatedJamTarget;
					weaponSystem.cycleDesignatedJamTarget(state, dir);
					const now = weaponSystem.designatedJamTarget;
					if (!now && ctx.hud && ctx.hud.showRadarToast) {
						ctx.hud.showRadarToast('NO JAMMABLE TARGETS',
							'rgba(255, 200, 96, 0.85)', 1.2);
					} else if (now && now !== prev && ctx.hud && ctx.hud.showRadarToast) {
						ctx.hud.showRadarToast(`EW: TGT → ${now.name || 'BOGEY'}`,
							'rgba(255, 200, 96, 0.95)', 1.0);
					}
				} else {
					weaponSystem.cycleDesignatedTarget(dir);
				}
			}
			// EW jammer fire path: edge-triggered toggle of the
			// designated victim into state.jammer.offensiveTargets.
			// Trigger only on the first frame the fire key is pressed
			// so a held key doesn't oscillate the beam on/off every
			// frame. ctx tracks the previous fire state for this
			// edge-detection. Other weapons keep the held-fire model.
			const fireEdge = !!input.fire && !ctx._jamFirePrev;
			ctx._jamFirePrev = !!input.fire;
			const cur = weaponSystem.getCurrentWeapon && weaponSystem.getCurrentWeapon();
			if (cur && cur.id === 'jammer') {
				if (fireEdge) {
					const action = weaponSystem.toggleOffensiveJam(state);
					if (ctx.hud && ctx.hud.showRadarToast) {
						if (action === 'on') {
							const tgt = weaponSystem.designatedJamTarget;
							ctx.hud.showRadarToast(`EW: OFFENSIVE → ${(tgt && tgt.name) || 'TGT'}`,
								'rgba(255, 140, 80, 0.95)', 1.6);
						} else if (action === 'off') {
							ctx.hud.showRadarToast('EW: BEAM OFF', 'rgba(180, 180, 180, 0.95)', 1.0);
						} else if (action === 'no-target') {
							ctx.hud.showRadarToast('EW: NO TARGET DESIGNATED',
								'rgba(255, 200, 96, 0.85)', 1.2);
						}
					}
				}
				weaponSystem.releaseFireHold();
			} else if (input.fire) {
				weaponSystem.fire(state);
			} else {
				weaponSystem.releaseFireHold();
			}
			if (input.fireFlare)          weaponSystem.fireFlare(state);
		}
		weaponSystem.update(dt, state, isFlying ? input : null);
	}

	// ---- Sensor system ----------------------------------------------
	// Build the list of all sensable objects (player + NPCs + live
	// missiles) and scan bidirectionally. Each unit ends up with
	// contacts/rwr populated in-place. NPCs already carry team=
	// 'hostile' and a fighter signature from npcSystem; the player
	// carries team='friendly' and matching data.
	ctx.addSimTime(dt);
	const simTime = ctx.getSimTime();
	const npcList = npcSystem ? npcSystem.npcs : [];
	// Every projectile carries team + signature now (set at
	// construction from the launcher), so we just sweep both pools
	// into the sensor pass without per-item fixup.
	const playerProjectiles = (weaponSystem && weaponSystem.projectiles) || [];
	const npcProjectiles    = (npcSystem && npcSystem.projectiles)       || [];
	const allProjectiles = playerProjectiles.concat(npcProjectiles).filter(p => p && p.active);

	// 6b — player radar mode is now explicitly chosen by the player
	// via the T keybind (rws / tws / stt). This block translates the
	// player-facing playerMode into the internal `radar.mode` field
	// the rest of the system already speaks ('search' / 'track' /
	// 'off'):
	//   rws / tws → 'search' — no STT spike on victim RWR
	//   stt       → 'track'  — STT-class RWR spike, midcourse path
	// 'off' is preserved if the radar's own active flag is false
	// (R-key emcon). Older auto-mode-on-lock logic removed —
	// commits are explicit now.
	if (state.sensors && state.sensors.radar) {
		const r = state.sensors.radar;
		if (!r.active) {
			r.mode = 'off';
		} else {
			const pm = r.playerMode || 'tws';
			r.mode = (pm === 'stt') ? 'track' : 'search';
		}
	}

	updateSensors([state, ...npcList, ...allProjectiles], simTime, dt);

	// Phase 3c — player RWR audio for being painted. After updateSensors,
	// state.rwr carries one entry per emitter painting us, each tagged
	// with `lockType` ('search' = TWS scan, 'track' = STT spike). We
	// surface STT only — TWS is visual-on-scope only, since it's the
	// ambient-threat condition during BVR. Edge-trigger a one-shot ping
	// the moment a new spike fires; loop the steady spike tone while
	// any STT lock persists.
	{
		let anyStt = false;
		if (state.rwr) {
			for (const [, c] of state.rwr) {
				if (c && c.lockType === 'track') { anyStt = true; break; }
			}
		}
		const wasStt = !!ctx._wasStt;
		try {
			if (anyStt && !soundManager.isPlaying('rwr-spike')) {
				soundManager.play('rwr-spike');
			} else if (!anyStt && soundManager.isPlaying('rwr-spike')) {
				soundManager.stop('rwr-spike');
			}
			if (anyStt && !wasStt) soundManager.play('rwr-spike-ping');
		} catch (e) { /* sound stack timing-of-init quirks — non-fatal */ }
		ctx._wasStt = anyStt;
	}

	// 6e.1 — receive-side jam-strobe pickup. Snapshot every hostile
	// active jammer's bearing on us, plus current attenuation and
	// burn-through state. Drives the HUD strobe overlay and one-shot
	// `JAM ACQUIRED` / `BURNTHROUGH` toasts.
	{
		const strobes = collectJamStrobes(state);
		state.jamStrobes = strobes;
		if (!ctx._jamStrobeState) ctx._jamStrobeState = new WeakMap();
		const seen = ctx._jamStrobeState;
		for (const [src, str] of strobes) {
			const prev = seen.get(src);
			const bearingDeg = ((str.bearing * 180 / Math.PI) % 360 + 360) % 360;
			const fivedeg = Math.round(bearingDeg / 5) * 5;
			if (!prev) {
				if (ctx.hud && ctx.hud.showRadarToast) {
					ctx.hud.showRadarToast(`JAM ACQUIRED → ${String(fivedeg).padStart(3, '0')}°`,
						'rgba(255, 140, 80, 0.95)', 2.0);
				}
			} else if (!prev.burnThrough && str.burnThrough) {
				const km = Math.max(1, Math.round(str.range / 1000));
				if (ctx.hud && ctx.hud.showRadarToast) {
					ctx.hud.showRadarToast(`BURNTHROUGH @ ${km} km`,
						'rgba(96, 255, 144, 0.95)', 2.0);
				}
			}
			seen.set(src, { burnThrough: str.burnThrough, range: str.range });
		}
		// Drop entries for jammers no longer strobing so a re-acquire
		// fires the toast again.
		// (WeakMap auto-cleans destroyed jammer references; we only
		// need to drop entries for jammers that went off-cone or
		// out-of-range. Track via a side Set of currently-seen units.)
		if (!ctx._jamStrobeKeys) ctx._jamStrobeKeys = new Set();
		const nowKeys = ctx._jamStrobeKeys;
		const fresh = new Set();
		for (const src of strobes.keys()) fresh.add(src);
		for (const old of nowKeys) if (!fresh.has(old)) seen.delete(old);
		ctx._jamStrobeKeys = fresh;
	}

	// Mirror the friendly team datalink into state.datalinkContacts so
	// the HUD / cockpit targeting can show team-fused tracks alongside
	// the player's own radar contacts. When the player toggles their
	// radar off (silent running), this is the ONLY source of air-
	// picture data — makes the AWACS datalink observable in-game
	// rather than just being a behind-the-scenes missile-guidance
	// helper.
	{
		const dl = state.team ? getTeamDatalink(state.team) : null;
		state.datalinkContacts = dl ? dl.allContacts() : null;
	}

	// Position integration from player's velocity — FLYING only. When
	// the player is destroyed, their position freezes on the ground
	// where the kill happened.
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
		const lastGeocodePos = ctx.getLastGeocodePos();
		const lastGeocodeTime = ctx.getLastGeocodeTime();
		const distFromLast = calculateDistance(state.lon, state.lat, lastGeocodePos.lon, lastGeocodePos.lat);

		if (nowTime - lastGeocodeTime > GEOCODE_INTERVAL || distFromLast > GEOCODE_MIN_DIST) {
			ctx.setLastGeocodeTime(nowTime);
			ctx.setLastGeocodePos({ lon: state.lon, lat: state.lat });

			reverseGeocode(state.lon, state.lat).then(name => {
				if (name && name !== ctx.getCurrentRegionName()) {
					ctx.setCurrentRegionName(name);
					ctx.hud.showRegion(name);
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

		if (state.isBoosting && !ctx.getLastIsBoosting()) {
			soundManager.play('boost');
		}

		if (state.throttle > ctx.getLastThrottleLevel() + 0.01) {
			if (!soundManager.isPlaying('throttle')) {
				soundManager.play('throttle');
			}
		}
		ctx.setLastThrottleLevel(state.throttle);

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

	// Lazy-create the commander view once Cesium is ready. Share the
	// ref with the pilot controller so its mouse-drag logic can back
	// off while the commander's pan-drag is active. Also register the
	// scene with the sensor module so terrain raycasts can run.
	if (!ctx.commanderView) {
		const viewer = getViewer();
		if (viewer) {
			const cv = new CommanderView(viewer);
			ctx.setCommanderView(cv);
			controller.commanderView = cv;
			setSensorScene(viewer.scene);
		}
	}
	// Lazy-create the strike planner the same way. Mutually exclusive
	// with commanderView at the camera level — only one alternate
	// camera mode is active at a time (handled in their key bindings).
	if (!ctx.strikePlannerView) {
		const viewer = getViewer();
		if (viewer) {
			const sp = new StrikePlannerView(viewer);
			// Wire mutual exclusion with commander view. Either side
			// closes the other on activation. Functions are set after
			// both views exist so neither needs to import the other.
			if (ctx.commanderView) {
				sp.closeOther = () => ctx.commanderView.setActive(false);
				ctx.commanderView._closeStrikePlanner = () => sp.setActive(false);
			}
			ctx.setStrikePlannerView(sp);
		}
	}

	// Spectator auto-clear: if the unit we're following dies between
	// frames, fall back to the normal pilot camera rather than
	// freezing on the death pose. Also clears if the unit is an NPC
	// that's been spliced out of the world (active === false or
	// detached).
	if (ctx.spectatorTarget) {
		const gone = ctx.spectatorTarget.destroyed ||
			ctx.spectatorTarget.active === false ||
			(typeof ctx.spectatorTarget.lon !== 'number');
		if (gone) {
			ctx.setSpectatorTarget(null);
			// If we were spectating while dead, both the crash menu
			// (hidden on entry) and the THREE canvas (unhidden on
			// entry) need to flip back to the CRASHED-only state so
			// the player gets the RESPAWN overlay back.
			if (ctx.currentState === 'CRASHED') {
				const crashMenu = document.getElementById('crashMenu');
				if (crashMenu) crashMenu.classList.remove('hidden');
				const threeContainer = document.getElementById('threeContainer');
				if (threeContainer) threeContainer.classList.add('hidden');
			}
		}
	}

	// NPCs, HUD, commander: always tick so the world keeps running
	// even while the player is crashed. Key to the "press M after you
	// die and watch the rest of the battle" UX.
	//
	// IMPORTANT: npcSystem.update runs BEFORE the camera is set this
	// frame. That way `spectatorTarget.lon/lat/alt` is already
	// advanced to frame-N before setCameraBehindUnit reads it —
	// mirroring the pilot camera, which already worked this way
	// because state.lon/lat/alt integrates ahead of the camera
	// block. The inline mesh bakes inside update() use a stale
	// viewMatrix (the camera hasn't moved yet), but we rebake every
	// mesh via `syncMeshMatrices()` below AFTER the camera is set, so
	// the final render uses a consistent V for both the earth and
	// every THREE mesh on top of it.
	if (npcSystem) {
		npcSystem.update(dt, state, simTime);
	}

	// Camera priority each frame:
	//   1. Commander view — god-eye map. Owns the camera when active.
	//   2. Spectator — chase cam behind a clicked unit.
	//   3. Pilot — default first-person + mouse-orbit.
	// CRASHED freezes the camera on last-known pose (no branch fires).
	if (ctx.commanderView && ctx.commanderView.active) {
		// Commander owns the camera.
	} else if (ctx.strikePlannerView && ctx.strikePlannerView.active) {
		// Strike planner owns the camera.
	} else if (ctx.spectatorTarget) {
		// Chase cam behind the clicked unit. Uses the same mouse
		// orbit values the pilot camera reads, so dragging the mouse
		// while spectating rotates the view around the target.
		const orbitYaw   = input ? (input.cameraYaw   || 0) : 0;
		const orbitPitch = input ? -(input.cameraPitch || 0) : 0;
		const zoom       = input ? (input.cameraZoom  || 1) : 1;
		setCameraBehindUnit(ctx.spectatorTarget, orbitYaw, orbitPitch, zoom);
	} else if (isFlying) {
		const planeHPR = new Cesium.HeadingPitchRoll(
			Cesium.Math.toRadians(state.heading),
			Cesium.Math.toRadians(state.pitch),
			Cesium.Math.toRadians(state.roll),
		);
		const planeQuat = Cesium.Quaternion.fromHeadingPitchRoll(planeHPR);

		const orbitHPR = new Cesium.HeadingPitchRoll(
			Cesium.Math.toRadians(input.cameraYaw),
			Cesium.Math.toRadians(-input.cameraPitch),
			0,
		);
		const orbitQuat = Cesium.Quaternion.fromHeadingPitchRoll(orbitHPR);

		const finalQuat = Cesium.Quaternion.multiply(planeQuat, orbitQuat, new Cesium.Quaternion());
		const finalHPR = Cesium.HeadingPitchRoll.fromQuaternion(finalQuat);

		setCameraToPlane(
			state.lon, state.lat, state.alt,
			Cesium.Math.toDegrees(finalHPR.heading),
			Cesium.Math.toDegrees(finalHPR.pitch),
			Cesium.Math.toDegrees(finalHPR.roll),
		);
	}

	// Re-bake every world-space THREE mesh against the just-set
	// camera. Both NPC planes + NPC-fired projectiles (via npcSystem)
	// and player-fired projectiles (via weaponSystem) had their
	// initial bake happen earlier in the frame with the PREVIOUS
	// camera. Rebaking now aligns them with the camera Cesium is
	// about to render the earth with — without this the units
	// visibly shake in the chase cam as frame-time jitter turns a
	// constant v·dt misalignment into a direction-of-travel
	// oscillation.
	if (weaponSystem && weaponSystem.syncMeshMatrices) weaponSystem.syncMeshMatrices();
	if (npcSystem    && npcSystem.syncMeshMatrices)    npcSystem.syncMeshMatrices();

	// Scenario tick: scripted movement / telemetry readouts. Runs for
	// both FLYING and CRASHED so lab-style scenarios (e.g. notching
	// test) keep updating their readout panels even after the player
	// dies.
	{
		const scn = getActiveScenario();
		if (scn && scn.update) {
			scn.update({ npcSystem, playerState: state, viewer: getViewer() }, dt);
		}
	}

	ctx.hud.update(state, isFlying ? (npcSystem ? npcSystem.npcs : []) : []);
	if (isFlying) updateTgp(state, weaponSystem, getViewer());

	if (ctx.commanderView) {
		const cv = ctx.commanderView;
		const projectiles = (weaponSystem && weaponSystem.projectiles) || [];
		const npcProjs    = (npcSystem && npcSystem.projectiles)       || [];
		const allProjs    = projectiles.concat(npcProjs);
		const units = npcSystem ? npcSystem.npcs : [];
		cv.update(dt, state, units, allProjs);
		// Strike planner runs in lockstep with commander view — same
		// inputs, sibling surface. Update unconditionally so its
		// _lastPlayerState stays fresh (used to recenter the camera
		// when the panel opens). Update body early-returns when
		// inactive, so this is essentially free off-screen.
		if (ctx.strikePlannerView) {
			ctx.strikePlannerView.update(dt, state, units, allProjs);
		}

		// Pilot overlays follow commander state. The cockpit plane
		// model is drawn in camera space — hide it when the god-eye
		// view owns the camera. UI likewise fades out.
		const cmdActive = cv.active;
		const planActive = !!(ctx.strikePlannerView && ctx.strikePlannerView.active);
		// Cockpit model + pilot UI are only visible while the pilot
		// camera is driving. Commander god-eye, strike planner, and
		// spectator chase-cam each take over the camera and hide them.
		const pilotCamOwns = !cmdActive && !planActive && !ctx.spectatorTarget;
		const planeModel = ctx.planeModel;
		if (planeModel) planeModel.visible = pilotCamOwns && isFlying;
		const uiContainer = document.getElementById('uiContainer');
		if (uiContainer) {
			uiContainer.style.opacity = pilotCamOwns ? '' : '0';
		}
		// (Strike planner toggles threeContainer.style.display in its
		// own setActive — no per-frame overlay management needed.)

		// NPC screen markers (diamonds + labels, the
		// `npc-markers-layer` div) live OUTSIDE uiContainer so we can
		// show them in spectator mode — the whole point of a chase
		// cam is seeing the surrounding units. Commander view has
		// its own ground-plane markers though, so hide the HUD
		// markers there to avoid double rendering. Visible otherwise
		// (pilot OR spectator).
		const npcLayer = document.getElementById('npc-markers-layer');
		if (npcLayer) npcLayer.style.display = (cmdActive || planActive) ? 'none' : '';
		// Designation diamonds also hide in alt-camera modes — the
		// strike planner draws its own world-space markers and the
		// commander view doesn't care about player designations.
		const desigLayer = document.getElementById('designation-markers-layer');
		if (desigLayer) desigLayer.style.display = (cmdActive || planActive) ? 'none' : '';

		// While the player is dead, toggling into the map hides the
		// crash screen so the whole view is the battlefield.
		// Three.js stays hidden — the commander view uses Cesium
		// entity markers and polyline trails for everything. Force
		// display:none inline as well as the class, belt-and-braces:
		// if any other CSS ended up leaving the overlay with display:
		// flex + pointer-events:auto, it would intercept mousedown
		// and break the map drag/tilt even while the user can't see
		// it.
		const crashMenu = document.getElementById('crashMenu');
		if (currentState === 'CRASHED' && crashMenu) {
			// Hide crash menu while EITHER the commander map is open OR
			// the player is spectating someone (chase-cam on an NPC /
			// missile). Without the spectator clause this block re-
			// asserted display:'' every frame and undid the one-shot
			// hide we do on spectator-request.
			const hideCrash = cmdActive || !!ctx.spectatorTarget;
			crashMenu.classList.toggle('hidden', hideCrash);
			if (hideCrash) {
				crashMenu.style.display = 'none';
				crashMenu.style.pointerEvents = 'none';
			} else {
				crashMenu.style.display = '';
				crashMenu.style.pointerEvents = '';
			}
		}
	}

	// Cockpit-space plane model tilt/shake visual block — FLYING-only
	// because it reads physicsResult + input + prevSpeed (all captured
	// under the isFlying gate above).
	const planeModel = ctx.planeModel;
	if (isFlying && planeModel) {
		const { BASE_PLANE_POS, visualOffset, visualRotation, jetFlames } = ctx;
		const accel = (state.speed - prevSpeed) / dt;
		const accelInertia = input.isDragging ? 0 : Math.max(-0.5, Math.min(1.5, accel * 0.001));
		let targetZ = BASE_PLANE_POS.z - accelInertia;

		// Afterburner cockpit-shake / barrel-roll animation removed
		// per user preference. The plane used to punch backwards in
		// chase-space and do a couple of full-rotation barrel rolls
		// when the afterburner engaged — cinematic, but disorienting
		// and nothing a real aircraft actually does. Keep `boostRoll`
		// and `lastIsBoosting` at zero/false so any downstream
		// reader sees a consistent no-boost-animation state.
		const boostZOffset = 0;
		ctx.setBoostRoll(0);
		ctx.setLastIsBoosting(physicsResult.isBoosting);

		const zLerp = physicsResult.isBoosting ? 10.0 * dt : 2.0 * dt;
		const newBoostZ = ctx.getCurrentBoostZOffset() + (boostZOffset - ctx.getCurrentBoostZOffset()) * zLerp;
		ctx.setCurrentBoostZOffset(newBoostZ);
		targetZ += newBoostZ;

		const time = performance.now() * 0.001;
		const idleX = Math.sin(time * 0.8) * 0.035;
		const idleY = Math.cos(time * 0.6) * 0.025;
		const idleRotX = Math.sin(time * 0.5) * 0.015;
		const idleRotY = Math.cos(time * 0.4) * 0.015;
		const idleRotZ = Math.sin(time * 0.7) * 0.025;

		const targetX = input.isDragging ? BASE_PLANE_POS.x : BASE_PLANE_POS.x - (input.roll * 0.6) - (input.yaw * 0.12) + idleX;
		const targetY = input.isDragging ? BASE_PLANE_POS.y : BASE_PLANE_POS.y - (input.pitch * 0.1) + idleY;

		const targetRotZ = input.isDragging ? 0 : THREE.MathUtils.degToRad(-input.roll * 15) + idleRotZ;
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
				'YXZ',
			),
		);

		// Apply chase-camera zoom. The plane sits in front of the
		// camera in camera space; scaling the offset scales apparent
		// size (and the corresponding chase distance). Clamped in the
		// controller so it can't pass through the airframe or fly off
		// to infinity.
		const zoom = (input && input.cameraZoom) || 1;
		planeModel.position.copy(visualOffset).multiplyScalar(zoom);

		const flightLagQ = new THREE.Quaternion().setFromEuler(
			new THREE.Euler(visualRotation.x, visualRotation.y, visualRotation.z + ctx.getBoostRoll()),
		);

		const combinedQ = orbitQ.clone().invert().multiply(flightLagQ);
		planeModel.quaternion.copy(combinedQ);

		const clock = ctx.clock;
		// Phase 8 — player contrails. One Contrail instance per
		// session, lazy-initialized so we don't pay the import cost
		// before the player has actually loaded a plane. Runs every
		// frame regardless of state (it gates internally on alt +
		// speed); pauses naturally when dt = 0.
		if (!ctx._playerContrail && ctx.scene) {
			ctx._playerContrail = new Contrail(ctx.scene, getViewer());
		}
		if (ctx._playerContrail) ctx._playerContrail.update(dt, state);
		if (jetFlames.length > 0) {
			// TV nozzle deflection: rotate the flame group so the plume
			// visibly tilts when the F-22's nozzles vector. Smoothed so the
			// flame doesn't snap on stick reversals — real nozzles have
			// ~5 Hz actuator bandwidth.
			const tv = state.tvDeflection || { pitch: 0, yaw: 0 };
			jetFlames.forEach(flame => {
				flame.update(state.throttle, state.isBoosting, clock.getElapsedTime(), dt);
				// Sign convention: pitch-up command should tilt the plume
				// downward at the exit (reaction force pitches nose up).
				// Body axes here match the planeModel: +X right, +Y forward,
				// +Z up. Flame extends rearward along -Y. Rotation about
				// +X tilts the rearward end up/down. Negative-X rotation =
				// exit moves down = pitches nose up.
				const targetPitch = -tv.pitch;
				const targetYaw   =  tv.yaw;
				const k = Math.min(1, dt * 12); // ~5 Hz first-order lag
				flame.group.rotation.x += (targetPitch - flame.group.rotation.x) * k;
				flame.group.rotation.z += (targetYaw   - flame.group.rotation.z) * k;
			});
		}
	}
}
