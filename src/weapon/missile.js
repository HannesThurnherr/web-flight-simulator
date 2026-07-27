import * as THREE from 'three';
import * as Cesium from 'cesium';
import { movePosition } from '../utils/math';
import { particles } from '../utils/particles';
import { soundManager } from '../utils/soundManager';
import { SIGNATURES, irAspectFactor, aspectAngleFromVectors } from '../systems/signatures';
import { getActiveFlares } from './flare.js';
import { airDensity, GRAVITY } from '../plane/aeroModel.js';
import { cloneAim9Template, cloneMissileTemplate } from './missileModels.js';
import { pushKill, targetLabel } from '../systems/eventLog.js';
import { navalLog, isAntiShipRound } from '../systems/navalDebug.js';
import { interceptSucceeds } from '../systems/interceptPk.js';
import { seaSurfaceHeightAt } from '../world/terrain.js';
import { mortallyWound } from '../systems/deathSequence.js';
import { applyShipDamage } from '../systems/shipDamage.js';
import { recordAdHit } from '../systems/adStats.js';
import { JetFlame } from '../plane/jetFlame.js';
import { validateMunitionSpec } from './munitionSpec.js';
import { getDayFactor } from '../systems/dynamicLighting.js';

// Shared signature reference (not per-missile copy) — all live AIM-9s have
// the same sensor profile. Subclasses (AIM-120) overwrite this in their ctor.
const MISSILE_IR_SIGNATURE = SIGNATURES.missile_ir;

// ---- Launch-rack ejection --------------------------------------------------
// Real air-launched stores are EJECTED off the rack — an ejector cartridge
// pushes them a few m/s along the aircraft's belly-down axis — then the motor
// lights. So a store separates by dropping away from the jet (and away
// "upward" if the jet is inverted), NOT by a forward kick. We model this as a
// short belly-relative push applied as a position delta that bleeds off over
// the first ~second, leaving the scalar-speed flight model otherwise intact.
const EJECT_DEFAULT_SPEED_MPS = 6;   // ejector-cartridge separation velocity
const EJECT_TAU = 0.35;              // s — exponential bleed-off of the push
const EJECT_DURATION = 0.9;          // s — stop applying after this

// Terrain-collision grace at launch. A missile leaving the rail is, for a
// moment, at launcher altitude — and if a ground launcher is clamped a few
// metres under a coarse-LOD terrain tile, its missile is born below the
// terrain the collision check reads and self-detonates on the rail. SAM
// interceptors fire steeply up, so a brief immunity lets them climb clear
// before terrain kill arms. Harmless for air-launched stores (nowhere near
// the ground) and for cruise missiles (own terrain-following takes over).
const LAUNCH_TERRAIN_GRACE_S = 0.7;

// Seekers that are anti-AIR and must never strike a surface hull. Everything
// NOT in this set — naval gun shells, bombs, cruise and anti-ship weapons —
// is a surface-attack weapon and may.
const AIR_TO_AIR_SEEKERS = new Set(['ir', 'iir', 'active_radar']);

// ============================================================================
// AIM-9X Block II–ish short-range IR missile.
//
// Replaces the earlier arcade model (constant speed, pure pursuit, fixed
// 90 °/s turn rate, 100 m kill radius) with a physically-motivated one:
//
//   - Boost/coast speed profile (real motor burns ~3-5s, then coasts)
//   - Proportional navigation with lead pursuit — efficient curved trajectories
//     against crossing or maneuvering targets
//   - G-limited turn rate ω_max = (G_max · g) / V. Slower missile can turn
//     tighter than a fast one, so head-on shots are punishing and tail chases
//     fall off — which matches reality.
//   - Proximity fuze ~5 m with segment-swept collision (avoids tunneling at
//     peak speed where single-frame travel is >fuze radius).
//   - Seeker gimbal cone ±90° (HOBS). Target leaves cone → ballistic.
//
// AIM120 extends this class; the constants below are overridden there for a
// BVR flight profile. All helper methods (_guide, _shouldEmitTrail,
// _estimateTargetVelocityENU, _segmentMissDistSq) are usable from both.
// ============================================================================

export class Missile {
	constructor(scene, viewer, startPos, heading, pitch, speed, target = null, onKill = null, launcher = null, data = null) {
		// Data-driven configuration. Every tunable parameter lives on
		// the `data` object (loaded from src/data/munitions/*.json via
		// munitionFactory). The previous fallback to a hardcoded
		// DEFAULT_AIM9_DATA masked callers that forgot to pass a JSON
		// — they got an AIM-9-class fighter missile no matter what
		// they meant to fire. Now: data is required, validated by
		// validateMunitionSpec, and missing fields throw with the
		// munition id named.
		if (!data) {
			throw new Error('[Missile] constructor requires a `data` object (munition JSON)');
		}
		validateMunitionSpec(data.id || data.simType || '<unknown>', data);
		this.data = data;
		const d = this.data;

		this.scene = scene;
		this.viewer = viewer;
		this.target = target;
		this.onKill = onKill;
		this.launcher = launcher;
		// Team inherited from the launcher so friendly-fire filtering works
		// both ways (player missiles can't kill the player; NPC missiles
		// can't kill other NPCs on the same team). Falls back to 'friendly'
		// only so legacy call sites don't explode.
		this.team = (launcher && launcher.team) || 'friendly';

		this.lon = startPos.lon;
		this.lat = startPos.lat;
		this.alt = startPos.alt;
		this.heading = heading;
		this.pitch = pitch;
		this.roll = 0;
		// Start at the launch aircraft's velocity (carried as `speed` along
		// heading/pitch) with NO forward kick — real stores are ejected DOWN
		// off the rack, not thrown forward. The downward separation is applied
		// by applyLaunchEjection() right after construction (it needs the
		// launcher's roll). `launchSpeedOffset` (per-munition JSON) is kept for
		// schema compatibility but no longer added to forward speed —
		// EXCEPT for `flight.muzzleLaunch` rounds (naval gun shells), which
		// have no rocket motor and get ALL their velocity from the gun: their
		// launchSpeedOffset IS the muzzle velocity and must be the initial
		// speed, or the round leaves at the (slow) launcher speed and plunges
		// straight into the sea off the bow.
		this.speed = speed + (d.flight.muzzleLaunch ? (d.flight.launchSpeedOffset || 0) : 0);
		// Belly-relative ejection velocity (ENU m/s) + remaining time. Set by
		// applyLaunchEjection; decays over EJECT_TAU during the first moments.
		this._ejectE = 0; this._ejectN = 0; this._ejectU = 0;
		this._ejectTimeLeft = 0;

		this.maxLife = d.flight.maxLifeS;
		this.life = this.maxLife;
		this.boostRemaining = d.flight.boostDurationS;
		this.lostLock = false;
		this.active = true;
		// Unique id per projectile. Commander view trails key on
		// `m-${m.id}` — must be unique to avoid samples interleaving.
		this.id = (Missile._nextId = (Missile._nextId || 0) + 1);
		// Type tag used by HUD / weaponSystem ammo tracking — comes from
		// the JSON `simType` field so future AIM-9 variants land on the
		// same weapon slot.
		this.type = d.simType || 'AIM-9';
		// Signature for sensor system. Per-instance clone (not a
		// shared reference into SIGNATURES) so realistic-IR mode can
		// decay this missile's irEmission post-boost without mutating
		// the global signature table that every other missile reads
		// from.
		this.signature = { ...(SIGNATURES[d.signature] || MISSILE_IR_SIGNATURE) };
		// Baseline IR emission captured at construction so the
		// post-boost decay in scanIR can lerp `signature.irEmission`
		// down from this value as the motor cools, without
		// compounding across frames.
		this._baseIrEmission = this.signature.irEmission;
		// Seconds since the boost motor cut out. 0 while burning;
		// counts up monotonically after, used by realistic-IR scanIR
		// to compute the cooling-exhaust factor.
		this._postBoostTime = 0;

		this._scratchMatrix = new Cesium.Matrix4();
		this._scratchHPR = new Cesium.HeadingPitchRoll();
		this._scratchCartesian = new Cesium.Cartesian3();
		this._scratchThreeMatrix = new THREE.Matrix4();
		this._scratchCameraMatrix = new Cesium.Matrix4();

		this.trail = [];
		this.distanceSinceLastTrail = 0;

		this.initMesh();
	}

	// Apply the launch-rack ejection: a brief push along the launch
	// aircraft's belly-down (−body-up) axis so the store drops away from the
	// jet before its motor dominates — and pushes UP if the jet was inverted.
	// `rollDeg` is the launcher's roll at release; `speedMps` overrides the
	// per-munition (or default) ejection speed. Call once, right after
	// construction, from whichever fire path spawned the store.
	applyLaunchEjection(rollDeg = 0, speedMps = null) {
		const spd = (speedMps != null)
			? speedMps
			: (this.data.flight.ejectionSpeedMps != null
				? this.data.flight.ejectionSpeedMps
				: EJECT_DEFAULT_SPEED_MPS);
		if (!(spd > 0)) return;
		const H = this.heading * Math.PI / 180;
		const P = this.pitch   * Math.PI / 180;
		const R = (rollDeg || 0) * Math.PI / 180;
		const sH = Math.sin(H), cH = Math.cos(H);
		const sP = Math.sin(P), cP = Math.cos(P);
		const sR = Math.sin(R), cR = Math.cos(R);
		// Zero-roll body axes in ENU:
		//   right0 = (cosH, −sinH, 0)
		//   up0    = right0 × forward = (−sinH·sinP, −cosH·sinP, cosP)
		// Roll about the forward axis: bodyUp = up0·cosR + right0·sinR.
		const up0E = -sH * sP, up0N = -cH * sP, up0U = cP;
		const r0E = cH, r0N = -sH, r0U = 0;
		const buE = up0E * cR + r0E * sR;
		const buN = up0N * cR + r0N * sR;
		const buU = up0U * cR + r0U * sR;
		// Eject down the belly (−bodyUp).
		this._ejectE = -buE * spd;
		this._ejectN = -buN * spd;
		this._ejectU = -buU * spd;
		this._ejectTimeLeft = EJECT_DURATION;
	}

	initMesh() {
		this.mesh = new THREE.Group();

		// Pick the GLB template: data.modelTemplate (e.g. 'agm-88',
		// 'meteor') wins, AIM-9 fallback otherwise. The procedural body
		// is the second-fall fallback for first-frame-after-boot shots
		// before the GLB has downloaded.
		const d = this.data;
		const templated = d.modelTemplate
			? cloneMissileTemplate(d.modelTemplate)
			: cloneAim9Template();
		// realLengthM is optional in the JSON — used to scale the GLB
		// to its true world size. Procedural fallback uses 2.6 m.
		const bodyLen = templated ? (d.realLengthM || 3.02) : 2.6;
		// Stash so updateTrail can offset puff spawns to the actual
		// tail of the missile body — without this the smoke spawns
		// at the missile's centre and looks like it's coming out of
		// the nose-to-mid section.
		this.bodyLengthM = bodyLen;
		if (templated) {
			this.mesh.add(templated);
		} else {
			this._buildProceduralMissileBody(2.6, 0.07);
		}

		// Flame and exhaust glow stay procedural in both paths — they're
		// dynamic effects driven from update() (scale/opacity flicker
		// during boost, fade during coast), and they need a live handle
		// for those tweaks. Parameterized on bodyLen so the offsets line
		// up with either the GLB (3.02 m long) or the fallback (2.6 m).
		//
		// Skip entirely for unpowered munitions — gravity bombs (GBU-12
		// and any future LGB / JDAM) have no rocket motor, so a glowing
		// orb on their tail looks ridiculous. The cleanest signal is
		// boostDurationS === 0 (those entries have a zero burn time and
		// zero boostAccel; everything else has a nonzero motor).
		// Validated at construction → d.flight.boostDurationS exists.
		const hasMotor = d.flight.boostDurationS > 0;
		if (hasMotor) {
			this._buildFlameEffects(bodyLen, 0.07, 1.0, 2.2);
		}

		this.mesh.layers.enable(0);
		this.mesh.layers.enable(1);

		this.mesh.matrixAutoUpdate = false;
		this.scene.add(this.mesh);
	}

	// Original cylinder + cone + fins mesh, kept as a fallback for when
	// the GLB hasn't loaded yet. Produces a recognizable missile shape
	// so the first-frame-after-boot shot isn't invisible.
	_buildProceduralMissileBody(bodyLen, radius) {
		const bodyGeom = new THREE.CylinderGeometry(radius, radius, bodyLen, 16);
		const bodyMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.4, roughness: 0.5 });
		this.mesh.add(new THREE.Mesh(bodyGeom, bodyMat));

		const noseLen = 0.35;
		const noseGeom = new THREE.ConeGeometry(radius, noseLen, 16);
		noseGeom.translate(0, bodyLen / 2 + noseLen / 2, 0);
		const noseMat = new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.8, roughness: 0.3 });
		this.mesh.add(new THREE.Mesh(noseGeom, noseMat));

		const bandGeom = new THREE.CylinderGeometry(radius + 0.001, radius + 0.001, 0.15, 16);
		bandGeom.translate(0, bodyLen / 2 - 0.4, 0);
		this.mesh.add(new THREE.Mesh(bandGeom, new THREE.MeshBasicMaterial({ color: 0xffcc00 })));

		const finMat = new THREE.MeshStandardMaterial({ color: 0x444444, metalness: 0.3, roughness: 0.6 });
		const rearFinGeom = new THREE.BoxGeometry(0.35, 0.4, 0.02);
		rearFinGeom.translate(radius + 0.175, 0, 0);
		for (let i = 0; i < 4; i++) {
			const g = new THREE.Group();
			g.add(new THREE.Mesh(rearFinGeom, finMat));
			g.position.y = -bodyLen / 2 + 0.3;
			g.rotation.y = i * (Math.PI / 2);
			this.mesh.add(g);
		}
		const frontFinGeom = new THREE.BoxGeometry(0.2, 0.15, 0.015);
		frontFinGeom.translate(radius + 0.1, 0, 0);
		for (let i = 0; i < 4; i++) {
			const g = new THREE.Group();
			g.add(new THREE.Mesh(frontFinGeom, finMat));
			g.position.y = bodyLen / 2 - 0.6;
			g.rotation.y = i * (Math.PI / 2);
			this.mesh.add(g);
		}
	}

	// Shared flame + glow builder — used by both Missile.initMesh and
	// AIM120.initAMRAAMMesh (via super access). Dynamic effects live on
	// this.flameMesh / this.flameCore / this.flameGlow so update() can
	// pulse and fade them.
	_buildFlameEffects(bodyLen, radius, flameLen = 1.0, glowScale = 2.2) {
		void flameLen; void glowScale;
		// Rocket-motor exhaust is a small version of the aircraft jet plume
		// (shader-based shock diamonds + hot core + blue-fringed glow),
		// instead of the old cone + glowing-orb sprite. No PointLight — a
		// dynamic light per in-flight missile would blow the light budget.
		this.jetFlame = new JetFlame({ withLight: false });
		// JetFlame emits along +Z; rotate so the plume trails the missile's
		// −Y tail. Scale the whole group down to missile proportions.
		this.jetFlame.group.rotation.x = Math.PI / 2;
		const scale = Math.max(0.12, radius * 4.0);
		this.jetFlame.group.scale.setScalar(scale);
		this.jetFlame.group.position.y = -bodyLen / 2;
		this.mesh.add(this.jetFlame.group);
		this._flameTime = 0;
	}

	update(dt, npcs) {
		if (!this.active) {
			// An interceptor / CIWS round kills a munition by flipping `active`
			// from the outside — destroy() never runs, so this is the only place
			// that death is observable. Distinguishes "shot down" from "flew
			// into the sea", which look identical from the cockpit.
			if (!this._deathLogged && isAntiShipRound(this)) {
				this._deathLogged = true;
				navalLog('DEATH', {
					type: this.type, reason: this._deathReason || 'killed-as-target (intercepted)',
					ageS: this.maxLife - this.life, alt: this.alt, pitch: this.pitch,
				});
			}
			if (this.trail.length > 0) this.updateTrail(dt);
			return;
		}

		// Rocket plume burns during motor burn, then cuts out at burnout
		// (solid motors don't trail flame while coasting).
		if (this.jetFlame) {
			this._flameTime += dt;
			if (this.boostRemaining > 0) {
				this.jetFlame.group.visible = true;
				this.jetFlame.update(1.0, 0, this._flameTime, dt);
			} else {
				this.jetFlame.group.visible = false;
			}
		}

		this.life -= dt;
		if (this.life <= 0) { this._deathReason = 'life-expired'; this.destroy(); return; }

		// ---- Speed profile: boost → coast ---------------------------------
		// Drag scales with ρ·v² using the data's reference operating
		// point. Each munition JSON sets its own dragRef / dragRefSpeed
		// / dragRefAltitude so AIM-9 (short burn, mostly coast) and
		// AIM-120 (long boost + long coast) can have different tuning.
		const f = this.data.flight;
		if (this.boostRemaining > 0) {
			this.speed = Math.min(f.peakSpeed, this.speed + f.boostAccel * dt);
			this.boostRemaining -= dt;
		} else {
			const rhoRef  = airDensity(f.dragRefAltitude);
			const rho     = airDensity(this.alt);
			const v2Ratio = (this.speed * this.speed) / (f.dragRefSpeed * f.dragRefSpeed);
			const dragAcc = f.dragRef * (rho / Math.max(1e-6, rhoRef)) * v2Ratio;
			this.speed = Math.max(f.minSpeed, this.speed - dragAcc * dt);
			// Accumulate post-boost coast time so realistic-IR scanIR
			// can decay the exhaust signature as the motor cools.
			this._postBoostTime += dt;
		}

		// ---- Gravity --------------------------------------------------------
		// Pull vertical velocity downward and recompose speed / pitch.
		// Scalar-along-nose representation preserved. Effect: a coasting
		// AIM-9 that misses its pass actually arcs into the ground
		// instead of flying level forever.
		{
			const pRad = this.pitch * Math.PI / 180;
			let vHoriz = this.speed * Math.cos(pRad);
			let vVert  = this.speed * Math.sin(pRad) - GRAVITY * dt;
			this.speed = Math.max(this.data.flight.minSpeed, Math.hypot(vHoriz, vVert));
			this.pitch = Math.atan2(vVert, vHoriz) * 180 / Math.PI;
			this.pitch = Math.max(-85, Math.min(85, this.pitch));
		}

		// ---- IR seeker re-evaluation ---------------------------------------
		// Real IR missiles continuously evaluate the brightest hot source
		// in their cone. Flares can outshine an aircraft tailpipe by
		// 10× — a reticle seeker (AIM-9M) usually breaks lock onto the
		// flare; an imaging-IR seeker (AIM-9X) discriminates the
		// aircraft silhouette and rides through. seekerType + the
		// per-missile flareResistance drive that distinction.
		this._irRecheck(npcs, dt);

		// ---- Guidance -----------------------------------------------------
		// Coord-homing seekers (LaserSeeker → GBU-12, GPSSeeker → JDAMs)
		// guide off a geographic point rather than a unit reference, so
		// `this.target` is intentionally null/non-NPC. Skipping _guide
		// for them would leave the bomb falling ballistic.
		const seekerType = this.data && this.data.seekerType;
		const isCoordHomer = seekerType === 'laser' || seekerType === 'gps' || seekerType === 'cruise';
		if (!this.lostLock && (isCoordHomer || (this.target && !this.target.destroyed))) {
			this._guide(dt);
		}

		// ---- Movement + segment-swept proximity check --------------------
		// Cache pre-move position so we can test the swept line segment
		// against the target — crucial when the missile moves further per
		// frame (≈14 m at peak speed) than the fuze radius (5 m).
		const prevLon = this.lon;
		const prevLat = this.lat;
		const prevAlt = this.alt;

		const newPos = movePosition(this.lon, this.lat, this.alt, this.heading, this.pitch, this.speed * dt);
		this.lon = newPos.lon;
		this.lat = newPos.lat;
		this.alt = newPos.alt;

		// Launch-rack ejection: belly-relative separation push that bleeds
		// off over the first moments (see applyLaunchEjection). Applied as a
		// position delta so the scalar-along-nose speed model is untouched.
		if (this._ejectTimeLeft > 0) {
			const cosLat = Math.cos(this.lat * Math.PI / 180) || 1e-6;
			this.alt += this._ejectU * dt;
			this.lat += (this._ejectN * dt) / 111320;
			this.lon += (this._ejectE * dt) / (111320 * cosLat);
			const decay = Math.exp(-dt / EJECT_TAU);
			this._ejectE *= decay; this._ejectN *= decay; this._ejectU *= decay;
			this._ejectTimeLeft -= dt;
		}

		this.updateTrail(dt);
		this.updateThreeMatrix();

		// Swept-segment hit check against every possible target (player +
		// NPCs). Self-skip and friendly-fire are explicit so this works
		// for both player-fired and NPC-fired missiles.
		const killRadiusSq = this.data.warhead.killRadiusM * this.data.warhead.killRadiusM;
		const fuzeRadiusSq = this.data.warhead.fuzeSenseRadiusM * this.data.warhead.fuzeSenseRadiusM;

		if (npcs) {
			for (const npc of npcs) {
				if (!npc || npc === this.launcher || npc === this) continue;
				if (npc.destroyed) continue;
				if (npc.team && this.team && npc.team === this.team) continue;
				// Don't detonate just from flying PAST another in-flight munition.
				// A sea-skimming Harpoon shouldn't blow up on an enemy interceptor
				// crossing its path, and two opposing missile streams shouldn't
				// annihilate each other mid-ocean. We only "hit" a munition if
				// it's specifically OUR target — i.e. we're an interceptor sent
				// to kill it (that's how RAM/SM-6/CIWS still down cruise missiles).
				const ncls = npc.signature && npc.signature.unitClass;
				if ((ncls === 'missile' || ncls === 'cruise_missile' || ncls === 'bomb') &&
					npc !== this.target) continue;
				// An anti-AIR missile must never detonate on a SHIP — an AMRAAM
				// or a RAM flying over a hull is not attacking it.
				//
				// This used to be spelled "anything that isn't an anti_ship
				// seeker", which quietly excluded every SURFACE-ATTACK weapon
				// too. The Mk 45 naval gun shell is seekerType 'null', so a
				// round whose entire purpose is hitting ships could not hit a
				// ship: it flew through the target and splashed beyond, which
				// is what "the guns fire into the sea" actually was. NullSeeker
				// also nulls its target, so the proximity fuze never ran either
				// — the shell had no way at all to hurt a hull.
				//
				// Correct rule: only the AIR-TO-AIR seekers refuse a surface
				// target. Guns, bombs and cruise weapons may all strike one.
				if (npc.kind === 'surface' && AIR_TO_AIR_SEEKERS.has(this.data.seekerType)) continue;
				const missSq = this._segmentMissDistSq(prevLon, prevLat, prevAlt, this.lon, this.lat, this.alt, npc);
				if (missSq < killRadiusSq) {
					this.hitNPC(npc);
					return;
				}
			}
		}

		// Proximity-fuze closest-approach detection against the tracked
		// target. Fires when range has stopped decreasing and we're inside
		// the fuze envelope — catches the high-speed fly-by misses that the
		// strict swept-segment check above rejects by a few metres.
		//
		// Don't trigger on a flare lock: a contact fuze doesn't fire on
		// a magnesium ember, and an active fuze isn't expecting a
		// pinpoint-hot point source. The missile flies through the
		// flare bloom and either reacquires (handled in _irRecheck) or
		// goes ballistic.
		const isFlareLock = this.target?.signature?.unitClass === 'flare';
		if (this.target && !this.target.destroyed && !isFlareLock) {
			const dSq = this.calculateDistSqToNPC(this.target);
			if (dSq < fuzeRadiusSq &&
				this._prevTargetDistSq !== undefined &&
				dSq > this._prevTargetDistSq) {
				this.hitNPC(this.target);
				return;
			}
			this._prevTargetDistSq = dSq < fuzeRadiusSq ? dSq : undefined;
		} else {
			this._prevTargetDistSq = undefined;
		}

		this.checkTerrainCollision(npcs);
	}

	// Closest-approach distance² between the line segment from frame start
	// to frame end and the (stationary-in-this-frame) target position.
	// All math in a local flat-Earth metric frame — sufficient at these
	// scales; the segment is <100 m long.
	_segmentMissDistSq(lon0, lat0, alt0, lon1, lat1, alt1, target) {
		const metersPerDegLon = 111320 * Math.cos(Cesium.Math.toRadians(lat0));
		const ax = (target.lon - lon0) * metersPerDegLon;
		const ay = (target.lat - lat0) * 111320;
		const az = (target.alt - alt0);
		const bx = (lon1 - lon0) * metersPerDegLon;
		const by = (lat1 - lat0) * 111320;
		const bz = (alt1 - alt0);
		const segLenSq = bx * bx + by * by + bz * bz;
		if (segLenSq < 1e-6) return ax * ax + ay * ay + az * az;
		let t = (ax * bx + ay * by + az * bz) / segLenSq;
		t = Math.max(0, Math.min(1, t));
		const cx = ax - bx * t;
		const cy = ay - by * t;
		const cz = az - bz * t;
		return cx * cx + cy * cy + cz * cz;
	}

	// Per-shot endgame outcome for an interceptor engaging a MUNITION,
	// expressed as an AIM-POINT BIAS rather than a damage roll.
	//
	// This distinction is the whole point. A RIM-116 that reaches a Harpoon
	// destroys it — warheads are not probabilistic at these scales. What
	// actually varies is whether the endgame works at all: whether the seeker
	// resolves a small, fast target against clutter, whether the fire-control
	// solution is good enough, whether the round can pull the lead it needs.
	// Modelling that as "detonates on the target but the target flies on" is
	// nonsense; modelling it as "guides to a point beside the target and sails
	// past" is what a real miss looks like, and the existing swept-segment and
	// proximity-fuze checks then correctly decline to trigger.
	//
	// Decided ONCE per shot, on first guidance, so a round that is going to
	// miss diverges early and visibly instead of snapping aside at the merge.
	// Returns the true target for anything that isn't a munition — see
	// interceptPk, which yields probability 1 there.
	_aimPoint() {
		const t = this.target;
		if (!t || typeof t.lon !== 'number') return t;
		if (this._aimBias === undefined) {
			this._aimBias = null;
			if (!interceptSucceeds(this.type, t)) {
				// Offset comfortably outside the fuze envelope, so the round
				// passes without detonating rather than scoring a dud hit.
				const fuze = (this.data && this.data.warhead && this.data.warhead.fuzeSenseRadiusM) || 30;
				const r = fuze * (1.8 + Math.random() * 1.6);
				const a = Math.random() * Math.PI * 2;
				this._aimBias = {
					e: Math.cos(a) * r,
					n: Math.sin(a) * r,
					u: (Math.random() - 0.5) * r,
				};
			}
		}
		if (!this._aimBias) return t;
		const cosLat = Math.cos((t.lat || 0) * Math.PI / 180) || 1e-6;
		return {
			lon: t.lon + this._aimBias.e / (111320 * cosLat),
			lat: t.lat + this._aimBias.n / 111320,
			alt: (t.alt || 0) + this._aimBias.u,
			speed: t.speed, heading: t.heading, pitch: t.pitch,
		};
	}

	// Proportional navigation with lead pursuit and G-limited turn cap.
	// Mirrors the AIM-120's guidance with tighter terminal behavior.
	_guide(dt) {
		const aim       = this._aimPoint() || this.target;
		const myPos     = Cesium.Cartesian3.fromDegrees(this.lon, this.lat, this.alt);
		const targetPos = Cesium.Cartesian3.fromDegrees(aim.lon, aim.lat, aim.alt);

		// LOS in ECEF → local ENU (in meters, so we can add target velocity
		// × time-to-go in the same units).
		const losECEF  = Cesium.Cartesian3.subtract(targetPos, myPos, new Cesium.Cartesian3());
		const range    = Cesium.Cartesian3.magnitude(losECEF);
		const enu      = Cesium.Transforms.eastNorthUpToFixedFrame(myPos);
		const invEnu   = Cesium.Matrix4.inverse(enu, new Cesium.Matrix4());
		const losLocal = Cesium.Matrix4.multiplyByPointAsVector(invEnu, losECEF, new Cesium.Cartesian3());

		// Seeker gimbal cone check: angle between nose and LOS. Target outside
		// the cone ⇒ lost lock, missile coasts ballistic.
		const hRad = Cesium.Math.toRadians(this.heading);
		const pRad = Cesium.Math.toRadians(this.pitch);
		const noseX = Math.sin(hRad) * Math.cos(pRad);
		const noseY = Math.cos(hRad) * Math.cos(pRad);
		const noseZ = Math.sin(pRad);
		const losLen = Math.max(1e-6, Cesium.Cartesian3.magnitude(losLocal));
		const cosAng = (noseX * losLocal.x + noseY * losLocal.y + noseZ * losLocal.z) / losLen;
		// Validated at ctor: IR / IIR seekers have coneHalfAngleDeg.
		const coneDeg = this.data.seeker.coneHalfAngleDeg;
		const cosMin  = Math.cos(coneDeg * Math.PI / 180);
		if (cosAng < cosMin) {
			this.lostLock = true;
			return;
		}

		// Lead pursuit: aim at predicted target position in t_go seconds.
		// t_go uses real closing rate (missile velocity minus target velocity,
		// projected onto the LOS), not just missile speed. The simpler
		// approximation underestimates head-on t_go and overestimates tail
		// chases, which shows up as a reliable small-distance miss on
		// longer shots.
		const tgtVel = this._estimateTargetVelocityENU();
		const mVelX  = this.speed * Math.sin(hRad) * Math.cos(pRad);
		const mVelY  = this.speed * Math.cos(hRad) * Math.cos(pRad);
		const mVelZ  = this.speed * Math.sin(pRad);
		const closingRate =
			((mVelX - tgtVel.x) * losLocal.x +
			 (mVelY - tgtVel.y) * losLocal.y +
			 (mVelZ - tgtVel.z) * losLocal.z) / Math.max(1, range);
		const tgo   = range / Math.max(100, closingRate);
		const leadX = losLocal.x + tgtVel.x * tgo;
		const leadY = losLocal.y + tgtVel.y * tgo;
		const leadZ = losLocal.z + tgtVel.z * tgo;

		const desiredHeading = Cesium.Math.toDegrees(Math.atan2(leadX, leadY));
		const desiredPitch   = Cesium.Math.toDegrees(Math.atan2(
			leadZ, Math.sqrt(leadX * leadX + leadY * leadY),
		));

		let dH = desiredHeading - this.heading;
		while (dH < -180) dH += 360;
		while (dH >  180) dH -= 360;
		const dP = desiredPitch - this.pitch;

		// G-limited turn cap with realistic dynamic-pressure scaling.
		//
		// Real lateral force: F_lat = ½·ρ·V²·S·CN_max → so the missile's
		// *available* G scales with V². A bled-out missile can't pull its
		// rated maxG; below ~Mach 1 the body simply can't generate enough
		// lift. Above the design speed (V_ref) the airframe is structure-
		// limited at maxG (anything over peaks the wings).
		//
		//   G_avail = maxG · clamp((V/V_ref)², gFloor, 1)
		//   ω_max   = G_avail · g / max(V, 50)
		//
		// At V=600 (≈ Mach 2): G=40, ω≈37°/s. At V=200: G≈4.4, ω≈12°/s —
		// trivially out-turned by a fighter pulling 25°/s. The "bled-out
		// missile passes harmlessly" effect is now kinematic, not
		// warhead-dependent.
		// All required and validated at construction time.
		const maxG    = this.data.seeker.maxG;
		const pnGain  = this.data.flight.pnGain;
		const vRef    = this.data.flight.vManeuverRef;
		const gFloor  = this.data.flight.gAvailFloor;
		const qFactor = Math.min(1, Math.max(gFloor, (this.speed * this.speed) / (vRef * vRef)));
		const gAvail  = maxG * qFactor;
		const maxTurnRadPerS = (gAvail * 9.81) / Math.max(50, this.speed);
		const capDeg         = Cesium.Math.toDegrees(maxTurnRadPerS) * dt;

		this.heading += Math.max(-capDeg, Math.min(capDeg, dH * pnGain * dt));
		this.pitch   += Math.max(-capDeg, Math.min(capDeg, dP * pnGain * dt));
		this.pitch   = Math.max(-85, Math.min(85, this.pitch));

		this.debug = {
			rangeToTarget: range,
			desiredHeading, desiredPitch,
			headingError: dH, pitchError: dP,
			tgo, cosAngleToNose: cosAng,
			turnCapDegPerS: Cesium.Math.toDegrees(maxTurnRadPerS),
			targetName: targetLabel(this.target),
		};
	}

	// Target velocity in the local ENU frame. Uses heading/pitch/speed fields
	// populated by npcSystem; missing data reduces gracefully to lag pursuit.
	_estimateTargetVelocityENU() {
		const t = this.target;
		if (!t || typeof t.speed !== 'number') return { x: 0, y: 0, z: 0 };
		const h = Cesium.Math.toRadians(t.heading || 0);
		const p = Cesium.Math.toRadians(t.pitch   || 0);
		return {
			x: t.speed * Math.sin(h) * Math.cos(p),
			y: t.speed * Math.cos(h) * Math.cos(p),
			z: t.speed * Math.sin(p),
		};
	}

	// Both AIM-9 and AIM-120 should stop emitting smoke when the motor is
	// out — real missiles coast silently. Subclasses can override if needed.
	_shouldEmitTrail() {
		return this.active && this.boostRemaining > 0;
	}

	updateTrail(dt) {
		if (this._shouldEmitTrail()) {
			this.distanceSinceLastTrail += this.speed * dt;
			const spawnInterval = 20.0;
			while (this.distanceSinceLastTrail >= spawnInterval) {
				const backDist = this.distanceSinceLastTrail - spawnInterval;
				// Clear the tail by a margin larger than a fresh puff's
				// radius — otherwise the newest puff overlaps the airframe
				// and (from a front view) appears to sit on / ahead of the
				// nose. Half the body to reach the tail, +2 m of clearance.
				const tailOffset = (this.bodyLengthM || 3.0) * 0.5 + 2.0;
				const spawnPos = movePosition(this.lon, this.lat, this.alt, this.heading, this.pitch, -(backDist + tailOffset));

				this.distanceSinceLastTrail -= spawnInterval;

				const smokeGeom = new THREE.SphereGeometry(1.0, 16, 16);
				const gray = 0.5 + Math.random() * 0.75;
				const smokeMat = new THREE.MeshBasicMaterial({
					color: new THREE.Color(gray, gray, gray),
					transparent: true,
					opacity: 0.6 + Math.random() * 0.25
				});
				const smoke = new THREE.Mesh(smokeGeom, smokeMat);
				// Stash baseline so per-frame realistic-lighting dimming
				// can scale color = baseColor × dayFactor without
				// compounding each frame.
				smoke._baseColor = smokeMat.color.clone();
				smoke.lon = spawnPos.lon;
				smoke.lat = spawnPos.lat;
				smoke.alt = spawnPos.alt;
				smoke.life = 4.0;
				smoke.maxLife = 4.0;

				const age = this.maxLife - this.life;
				smoke.launchScale = Math.min(1.0, 0.25 + (age / 1.5) * 0.75);

				smoke.matrixAutoUpdate = false;

				this.scene.add(smoke);
				this.trail.push(smoke);
			}
		}

		const viewMatrix = this.viewer.camera.viewMatrix;
		const dayFactor = getDayFactor();
		for (let i = this.trail.length - 1; i >= 0; i--) {
			const t = this.trail[i];
			t.life -= dt;
			if (t.life <= 0) {
				this.scene.remove(t);
				this.trail.splice(i, 1);
				continue;
			}

			if (!t.randomScale) t.randomScale = 0.8 + Math.random() * 0.5;
			const launchScale = t.launchScale || 1.0;
			// Start small at emission (0.45) and billow downstream — a fresh
			// puff stays well inside its tail-clearance instead of bulging
			// over the airframe.
			const scale = launchScale * t.randomScale * (0.45 + (1.0 - t.life / t.maxLife) * 15.0);
			t.scale.set(scale, scale, scale);

			const opacity = (t.life / t.maxLife) * 0.5;
			t.material.opacity = opacity;
			// Smoke is unlit (MeshBasicMaterial) so the scene lights
			// can't dim it. In realistic mode dayFactor < 1 — scale
			// the colour off the stashed baseline so old puffs at
			// noon don't keep shining when the player flies into night.
			if (t._baseColor) {
				t.material.color.copy(t._baseColor).multiplyScalar(dayFactor);
			}

			const pos = Cesium.Cartesian3.fromDegrees(t.lon, t.lat, t.alt, undefined, this._scratchCartesian);
			const modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(pos, undefined, this._scratchMatrix);
			const cameraSpaceMatrix = Cesium.Matrix4.multiply(viewMatrix, modelMatrix, this._scratchCameraMatrix);

			for (let j = 0; j < 16; j++) {
				this._scratchThreeMatrix.elements[j] = cameraSpaceMatrix[j];
			}

			t.matrix.copy(this._scratchThreeMatrix);
			t.matrix.scale(new THREE.Vector3(scale, scale, scale));
			t.updateMatrixWorld(true);
		}
	}

	updateThreeMatrix() {
		const viewMatrix = this.viewer.camera.viewMatrix;
		const pos = Cesium.Cartesian3.fromDegrees(this.lon, this.lat, this.alt, undefined, this._scratchCartesian);

		const enuMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(pos, undefined, this._scratchMatrix);

		const hRad = Cesium.Math.toRadians(this.heading);
		const pRad = Cesium.Math.toRadians(this.pitch);

		const localForward = new Cesium.Cartesian3(
			Math.sin(hRad) * Math.cos(pRad),
			Math.cos(hRad) * Math.cos(pRad),
			Math.sin(pRad)
		);

		const worldForward = Cesium.Matrix4.multiplyByPointAsVector(enuMatrix, localForward, new Cesium.Cartesian3());
		Cesium.Cartesian3.normalize(worldForward, worldForward);

		const enuUp = new Cesium.Cartesian3(enuMatrix[8], enuMatrix[9], enuMatrix[10]);

		let worldRight = new Cesium.Cartesian3();
		if (Math.abs(Cesium.Cartesian3.dot(worldForward, enuUp)) > 0.999) {
			const enuNorth = new Cesium.Cartesian3(enuMatrix[4], enuMatrix[5], enuMatrix[6]);
			Cesium.Cartesian3.cross(worldForward, enuNorth, worldRight);
		} else {
			Cesium.Cartesian3.cross(worldForward, enuUp, worldRight);
		}
		Cesium.Cartesian3.normalize(worldRight, worldRight);

		const worldUp = new Cesium.Cartesian3();
		Cesium.Cartesian3.cross(worldRight, worldForward, worldUp);

		const finalModelMatrix = this._scratchMatrix;
		finalModelMatrix[0] = worldRight.x; finalModelMatrix[1] = worldRight.y; finalModelMatrix[2] = worldRight.z; finalModelMatrix[3] = 0;
		finalModelMatrix[4] = worldForward.x; finalModelMatrix[5] = worldForward.y; finalModelMatrix[6] = worldForward.z; finalModelMatrix[7] = 0;
		finalModelMatrix[8] = worldUp.x; finalModelMatrix[9] = worldUp.y; finalModelMatrix[10] = worldUp.z; finalModelMatrix[11] = 0;
		finalModelMatrix[12] = pos.x; finalModelMatrix[13] = pos.y; finalModelMatrix[14] = pos.z; finalModelMatrix[15] = 1;

		const cameraSpaceMatrix = Cesium.Matrix4.multiply(viewMatrix, finalModelMatrix, this._scratchCameraMatrix);

		for (let i = 0; i < 16; i++) {
			this._scratchThreeMatrix.elements[i] = cameraSpaceMatrix[i];
		}

		this.mesh.matrix.copy(this._scratchThreeMatrix);
		this.mesh.updateMatrixWorld(true);
	}

	calculateDistSqToNPC(npc) {
		const dLon = (npc.lon - this.lon) * 111320 * Math.cos(Cesium.Math.toRadians(this.lat));
		const dLat = (npc.lat - this.lat) * 111320;
		const dAlt = npc.alt - this.alt;
		return dLon * dLon + dLat * dLat + dAlt * dAlt;
	}

	// Score an IR emitter (aircraft or flare) from this missile's frame.
	// Returns 0 if the source is outside cone or range. Otherwise returns
	// inverse-square-scaled signal: brighter / closer / better-aspect →
	// higher score. Aspect coupling is on for aircraft (tailpipe much
	// stronger than head-on) and off for flares (isotropic emitters).
	_irScore(u, coneHalfRad, trackRange, aspectEnabled) {
		if (!u) return 0;
		const cosLat = Math.cos(this.lat * Math.PI / 180);
		const dE = (u.lon - this.lon) * 111320 * cosLat;
		const dN = (u.lat - this.lat) * 111320;
		const dU = (u.alt - this.alt);
		const range = Math.sqrt(dE * dE + dN * dN + dU * dU);
		if (range < 1) return 0;
		if (range > trackRange) return 0;

		// Missile body-forward in ENU — same construction the rest of
		// the guidance code uses.
		const hRad = this.heading * Math.PI / 180;
		const pRad = this.pitch   * Math.PI / 180;
		const fwdE = Math.sin(hRad) * Math.cos(pRad);
		const fwdN = Math.cos(hRad) * Math.cos(pRad);
		const fwdU = Math.sin(pRad);
		const losE = dE / range;
		const losN = dN / range;
		const losU = dU / range;
		const cosAngle = fwdE * losE + fwdN * losN + fwdU * losU;
		if (cosAngle < Math.cos(coneHalfRad)) return 0; // outside cone

		// Raw IR signal. Flares update theirs each frame via getEffectiveIr.
		let ir = 0;
		if (typeof u.getEffectiveIr === 'function') ir = u.getEffectiveIr();
		else if (u.signature) ir = u.signature.irEmission || 0;
		if (ir <= 0) return 0;

		// Aspect coupling: aircraft tailpipe is ~10× stronger than the
		// head-on signature — rear-quarter shots are why an AIM-9 is
		// such a deadly chase weapon. Flares emit isotropically so
		// we skip aspect for them.
		let aspectMul = 1.0;
		if (aspectEnabled && u.signature && u.signature.unitClass !== 'flare') {
			const tH = (u.heading || 0) * Math.PI / 180;
			const tP = (u.pitch   || 0) * Math.PI / 180;
			const tFwd = {
				x: Math.sin(tH) * Math.cos(tP),
				y: Math.cos(tH) * Math.cos(tP),
				z: Math.sin(tP),
			};
			const aspect = aspectAngleFromVectors({ x: losE, y: losN, z: losU }, tFwd);
			aspectMul = irAspectFactor(aspect);
		}

		return (ir * aspectMul) / (range * range);
	}

	// IR seeker re-evaluation tick. Throttled to 10 Hz so the per-tick
	// transfer probability is well-defined. Compares the current target
	// against the brightest live flare in cone+range; if a flare wins,
	// dice-roll on `1 - flareResistance` to actually transfer lock.
	//
	// Per-tick transfer probability is `(1 - flareResistance) * 0.1`.
	// Worked example for a 1-second flare burn (10 ticks):
	//   AIM-9M (flareResistance 0.10) → P(no break) = 0.91^10 ≈ 0.39
	//                                  → ~61% chance the flare decoys it
	//   AIM-9X (flareResistance 0.92) → P(no break) = 0.992^10 ≈ 0.92
	//                                  → ~8% chance, near-immune as advertised
	//
	// Also handles graceful fallback: if the current lock is a dead
	// flare or a destroyed aircraft, re-scan the targets list for any
	// hostile in cone+range and re-acquire to that.
	_irRecheck(targets, dt) {
		const seekerType = this.data.seekerType;
		if (seekerType !== 'ir' && seekerType !== 'iir') return;
		if (!this.active || this.lostLock) return;

		this._irCheckTimer = (this._irCheckTimer || 0) + dt;
		if (this._irCheckTimer < 0.1) return;
		this._irCheckTimer = 0;

		// IR/IIR seekers — all required fields validated at construction.
		// `aspectIrEnabled` is the only optional knob; defaults to true.
		const seeker = this.data.seeker;
		const coneHalfRad   = seeker.coneHalfAngleDeg * Math.PI / 180;
		const trackRange    = seeker.trackRangeM;
		const aspectEnabled = seeker.aspectIrEnabled !== false;
		const flareResist   = seeker.flareResistance;

		// Score current target if it's still alive and an aircraft.
		// A dead-flare lock or destroyed aircraft scores 0 → we'll fall
		// back to re-acquisition below.
		const tgtAlive = this.target && !this.target.destroyed && this.target.active !== false;
		const tgtIsFlare = this.target?.signature?.unitClass === 'flare';
		let tgtScore = 0;
		if (tgtAlive && !tgtIsFlare) {
			tgtScore = this._irScore(this.target, coneHalfRad, trackRange, aspectEnabled);
		} else if (tgtAlive && tgtIsFlare) {
			// Already locked on a flare — keep tracking until it dies,
			// then the fallback below will try to re-acquire.
			return;
		}

		// Brightest flare in cone+range.
		const flares = getActiveFlares();
		let bestFlare = null;
		let bestFlareScore = 0;
		for (let i = 0; i < flares.length; i++) {
			const f = flares[i];
			if (!f || !f.active) continue;
			const s = this._irScore(f, coneHalfRad, trackRange, false);
			if (s > bestFlareScore) {
				bestFlareScore = s;
				bestFlare = f;
			}
		}

		// Flare-vs-target showdown. Only roll the transfer if a flare
		// actually outshines the current target — otherwise the seeker
		// stays put.
		if (bestFlare && bestFlareScore > tgtScore) {
			const transferProb = (1 - flareResist) * 0.1;
			if (Math.random() < transferProb) {
				this.target = bestFlare;
				this._prevTargetDistSq = undefined;
				return;
			}
		}

		// Fallback re-acquisition: current target is gone (player died
		// of a previous flare-induced fly-by, or the previous flare lock
		// has now expired). Scan targets for the brightest hostile in
		// cone+range and snap to it.
		if (!tgtAlive && targets) {
			let bestU = null;
			let bestUScore = 0;
			for (const u of targets) {
				if (!u || u === this.launcher) continue;
				if (u.destroyed || u.active === false) continue;
				if (u.team && this.team && u.team === this.team) continue;
				if (!u.signature) continue;
				if (u.signature.unitClass === 'missile') continue;
				if (u.signature.unitClass === 'flare') continue;
				if (u.kind === 'surface') continue;   // IR AAM never re-acquires a ship
				const s = this._irScore(u, coneHalfRad, trackRange, aspectEnabled);
				if (s > bestUScore) {
					bestUScore = s;
					bestU = u;
				}
			}
			if (bestU) {
				this.target = bestU;
				this.lostLock = false;
				this._prevTargetDistSq = undefined;
			} else {
				this.lostLock = true;
			}
		}
	}

	hitNPC(npc) {
		// AD hit-rate diagnostic: this interceptor was stamped at launch if it
		// came from a SAM/AAA battery. Credit the hit against the intended
		// target column it was fired at.
		if (this._adStats) { try { recordAdHit(this._adStats.type, this._adStats.column); } catch (e) {} }
		// Surface ships absorb hits through the layered damage model (HP +
		// subsystem knockouts + sinking) rather than a one-shot kill. The
		// warhead's kill radius doubles as the damage magnitude (bigger
		// warhead → more damage). onKill (player scoring) only fires on the
		// blow that actually starts her sinking.
		if (npc && npc.kind === 'surface') {
			this._deathReason = 'HIT SHIP ' + (npc.name || '?');
			const dmg = (this.data && this.data.warhead && this.data.warhead.killRadiusM) || 12;
			applyShipDamage(npc, dmg, { lon: this.lon, lat: this.lat, alt: this.alt }, this.type, this.launcher);
			if (npc.sinking && this.onKill) this.onKill(npc);
			this.destroy();
			return;
		}
		// Aircraft go through the burning-spiral death sequence instead of an
		// instant fireball: mortallyWound logs the kill, spawns a hit flash,
		// and arms the tumble. The missile still detonates (below) but the
		// airframe trails smoke and breaks up a couple seconds later.
		if (mortallyWound(npc, { shooter: this.launcher, weapon: this.type || 'AIM-9', reason: 'kill' })) {
			if (this.onKill) this.onKill(npc);
			try { soundManager.play('explosion-random'); } catch (e) { /* no-op */ }
			this.destroy();
			return;
		}
		// NOTE: there is deliberately no lethality roll here. If an interceptor's
		// warhead resolves onto a munition, the munition dies — that is what
		// warheads do. Whether the intercept works at all is decided upstream,
		// in _aimPoint, as a guidance miss.
		//
		// Non-aircraft (cruise missiles, decoys, ground units): instant kill.
		// Log the kill before mutating state — captures shooter / target
		// names while they're still well-formed. The post-merge
		// `npc.destroyed = true` is what flips the unit out of every
		// downstream loop.
		pushKill({
			shooter: this.launcher,
			target:  npc,
			weapon:  this.type || 'AIM-9',
			at:      performance.now() * 0.001,
			reason:  'kill',
		});
		npc.destroyed = true;
		// Projectile-type targets (cruise missiles, MALD decoys, other
		// AAMs) gate their own update on `.active`, not `.destroyed`.
		// Without this flip a hit AIM-9-vs-MALD or AIM-9-vs-cruise
		// engagement sets the destroyed flag but the target keeps
		// flying. NPC airframes don't define `.active` so they're
		// unaffected.
		if ('active' in npc) npc.active = false;
		if (this.onKill) this.onKill(npc);
		try {
			particles.spawnExplosion(this.lon, this.lat, this.alt, { count: 80, smokeCount: 18, big: true });
			particles.spawnWreckage(this.lon, this.lat, this.alt, this.heading, this.pitch, { count: 48 });
			soundManager.play('explosion-random');
		} catch (e) { }
		this.destroy();
	}

	checkTerrainCollision(npcs) {
		const cartographic = Cesium.Cartographic.fromDegrees(this.lon, this.lat);
		const rawHeight = this.viewer.scene.globe.getHeight(cartographic);
		if (rawHeight === undefined || rawHeight === null) return;

		// Floor the collision surface at the STABLE sea reference. Raw
		// getHeight over open ocean swings by 100+ m as tile LOD streams in
		// (measured: -137 → -19 → +25 for one spot over a few seconds), and a
		// sea-skimmer holding a perfect 20 m skim gets detonated the instant
		// that value steps up past it. Nothing in this world sits below sea
		// level, so taking the higher of the two discards the garbage-low ocean
		// readings while land — which is above sea level by definition — still
		// collides exactly as before.
		const seaRef = seaSurfaceHeightAt(this.viewer, this.lon, this.lat);
		const terrainHeight = (seaRef != null) ? Math.max(rawHeight, seaRef) : rawHeight;

		// Launch grace. A round that is BELOW the surface in its first moments
		// isn't flying into anything — it was BORN there, because its launcher's
		// idea of the surface disagreed with the globe's. Lift it clear instead
		// of detonating it. Skipping the check (the old behaviour) wasn't
		// enough: the round stayed underwater, the grace expired, and the whole
		// salvo went up together — the "Harpoons splash on launch" failure, and
		// the screen white-out from a dozen simultaneous explosions.
		//
		// This makes the failure mode structurally impossible rather than
		// merely unlikely, which matters because the disagreement can come from
		// tile LOD flips that no amount of reference-unification fully removes.
		// Terrain stays lethal the moment the grace ends, so a round that
		// genuinely flies into a hillside still dies.
		if ((this.maxLife - this.life) < LAUNCH_TERRAIN_GRACE_S) {
			if (this.alt < terrainHeight + 2) {
				if (isAntiShipRound(this)) {
					navalLog('GRACE-LIFT', {
						type: this.type, ageS: this.maxLife - this.life,
						wasAlt: this.alt, surface: terrainHeight, under: terrainHeight - this.alt,
						pitch: this.pitch,
					});
				}
				this.alt = terrainHeight + 2;
				if (this.pitch < 0) this.pitch = 0;   // stop it driving straight back under
			}
			return;
		}
		if (this.alt < terrainHeight) {
			this._deathReason = 'terrain/sea impact';
			// Splash damage: every NPC within the warhead's kill radius
			// dies. Without this, a near-miss where the bomb plows
			// into terrain a few metres from the target leaves the
			// target unharmed — frustrating for gravity bombs
			// (GBU-12 / JDAM) where the seeker may put the round
			// 10–30 m off due to terrain or guidance noise. Each call
			// to hitNPC logs the kill + spawns particles + calls
			// destroy(); we want all the kills logged but only one
			// missile-destroy, so guard with `splashOnly` after the
			// first one to skip duplicate fx and self-destroy.
			const killR = this.data && this.data.warhead && this.data.warhead.killRadiusM;
			if (killR && npcs) {
				const killR2 = killR * killR;
				let anyKill = false;
				for (const npc of npcs) {
					if (!npc || npc === this.launcher) continue;
					if (npc.destroyed) continue;
					if (npc.team && this.team && npc.team === this.team) continue;
					// Splash damage doesn't kill other in-flight
					// munitions. A falling cruise missile's frag
					// shouldn't take out an interceptor or wingman's
					// AAM that happened to be nearby — and crediting
					// the launcher with that "kill" produced the
					// "PLAYER killed UNKNOWN with STORM-SHADOW" log
					// noise after every successful intercept.
					const tClass = npc.signature && npc.signature.unitClass;
					if (tClass === 'missile' || tClass === 'cruise_missile' || tClass === 'bomb') continue;
					const dSq = this.calculateDistSqToNPC(npc);
					if (dSq <= killR2) {
						if (!anyKill) {
							this.hitNPC(npc);
							anyKill = true;
						} else if (mortallyWound(npc, { shooter: this.launcher, weapon: this.type || (this.data && this.data.simType) || 'BOMB', reason: 'splash' })) {
							// Aircraft chain-kill → burning spiral.
							if (this.onKill) this.onKill(npc);
						} else {
							// Non-aircraft chain kill: log + instant, skip the
							// duplicate explosion + self-destroy.
							pushKill({
								shooter: this.launcher,
								target:  npc,
								weapon:  this.type || (this.data && this.data.simType) || 'BOMB',
								at:      performance.now() * 0.001,
								reason:  'splash',
							});
							npc.destroyed = true;
							if (this.onKill) this.onKill(npc);
						}
					}
				}
				if (anyKill) return;
			}
			try {
				particles.spawnExplosion(this.lon, this.lat, this.alt, { count: 80, smokeCount: 18, big: true });
				particles.spawnWreckage(this.lon, this.lat, this.alt, this.heading, this.pitch, { count: 48 });
				soundManager.play('explosion-random');
			} catch (e) { }
			this.destroy();
		}
	}

	destroy() {
		// Trace what actually ends an anti-ship round. Callers stamp
		// `_deathReason` before destroying; anything unstamped is a path we
		// haven't accounted for, which is itself the useful signal.
		if (this.active && isAntiShipRound(this)) {
			const sea = seaSurfaceHeightAt(this.viewer, this.lon, this.lat);
			navalLog('DEATH', {
				type: this.type,
				reason: this._deathReason || 'UNSTAMPED',
				ageS: this.maxLife - this.life,
				alt: this.alt,
				sea: sea == null ? 'null' : sea,
				aboveSea: sea == null ? '?' : (this.alt - sea),
				pitch: this.pitch,
				speed: this.speed,
				lostLock: !!this.lostLock,
				tgt: (this.target && this.target.name) || (this.target ? 'unnamed' : 'none'),
			});
		}
		this.active = false;
		if (this.mesh) {
			this.scene.remove(this.mesh);
		}
	}
}
