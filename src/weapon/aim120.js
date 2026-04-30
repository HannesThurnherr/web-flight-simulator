import * as THREE from 'three';
import * as Cesium from 'cesium';
import { movePosition } from '../utils/math';
import { particles } from '../utils/particles';
import { soundManager } from '../utils/soundManager';
import { Missile } from './missile';
import { SIGNATURES } from '../systems/signatures';
import { detectRadar } from '../systems/sensorSystem';
import { rollJamBreakLock } from '../systems/ew/jammerSubsystem.js';
import { pushKill } from '../systems/eventLog.js';
import { airDensity, GRAVITY } from '../plane/aeroModel.js';
import { getTeamDatalink } from '../systems/teamDatalink.js';
import { cloneAim120Template, cloneMissileTemplate } from './missileModels.js';

const AIM120_SIGNATURE = SIGNATURES.missile_radar;

// ============================================================================
// AIM-120D AMRAAM — active-radar-homing BVR missile.
//
// Design goals vs the existing AIM-9 Missile class:
//   - Long range: ~100 km effective vs ~10 km
//   - Much higher speed: Mach ~4 peak at burnout (vs ~Mach 2.3)
//   - Boost/coast profile with realistic energy loss after motor burnout
//   - Proportional-navigation guidance using line-of-sight rate, producing
//     the efficient curved trajectories real BVR missiles fly, vs the
//     point-at-target pursuit of the AIM-9
//   - Lead-pursuit lofted climb early for range extension
//   - Proximity fuze (~10 m lethal radius) instead of contact detonation
//   - "Pitbull" notification when seeker activates near terminal phase
//
// Inherits the Missile class for mesh, trail, terrain collision, and Cesium
// transform glue; overrides update() and the guidance logic.
// ============================================================================

// Fallback defaults — used when AIM120 is constructed without a data
// object. Normal flow: munitionFactory pulls the full config from
// src/data/munitions/*.json and passes it as the ctor's last arg.
// These constants are kept here as the "stock AIM-120D" parameter
// set, equivalent to what aim-120d.json ships with.
const DEFAULT_AIM120_DATA = {
	simType: 'AIM-120',
	signature: 'missile_radar',
	flight: {
		launchSpeedOffset: 50,
		boostDurationS: 8.0,
		boostAccel: 170,
		peakSpeed: 1300,
		minSpeed: 60,
		maxLifeS: 120,
		maxTurnDegPerSec: 40,
		pnGain: 4.0,
		dragRef: 8,
		dragRefSpeed: 1000,
		dragRefAltitude: 10000,
		vManeuverRef: 600,
		gAvailFloor: 0.05,
	},
	warhead: {
		killRadiusM: 15,
		fuzeSenseRadiusM: 30,
		missAbortRadiusMul: 2,
	},
	loft: {
		terminalRangeM: 15000,
		maxLoftRangeM: 70000,
		maxLoftDeg: 25,
	},
	seeker: {
		activeRangeM: 18000,
		fovHalfAngleDeg: 30,
		nominalDetectRangeM: 25000,
		referenceRcs: 5,
		notchThresholdAcquire: 30,
		notchThresholdTrack: 25,
		lockDropTimeoutS: 2.5,
		reacquireIntervalS: 0.25,
		reacquireBackoffMul: 2.0,
		reacquireMaxIntervalS: 4.0,
		reacquireMaxAttempts: 5,
		datalink: true,
	},
};

// Build the two radar configs (acquisition + tracking) from a
// munition data object. Factored out so the two per-frame guidance
// blocks that consult detectRadar() don't embed their own config.
function buildSeekerRadar(d) {
	const halfRad = (d.seeker.fovHalfAngleDeg * Math.PI) / 180;
	return {
		enabled: true, active: true, mode: 'track',
		nominalRange: d.seeker.nominalDetectRangeM,
		referenceRcs: d.seeker.referenceRcs,
		fovH: halfRad, fovV: halfRad,
		notchThreshold: d.seeker.notchThresholdAcquire,
	};
}
function buildSeekerRadarTrack(d) {
	return {
		...buildSeekerRadar(d),
		notchThreshold: d.seeker.notchThresholdTrack,
	};
}

export class AIM120 extends Missile {
	// Exposed so debug overlays (e.g. commander view's radar-debug mode)
	// can draw the seeker's FOV cone without reaching into module-private
	// constants. Default config is the stock AIM-120D; per-instance
	// this is replaced by the live seeker radar built from `this.data`.
	static SEEKER_RADAR_DEBUG = buildSeekerRadar(DEFAULT_AIM120_DATA);

	constructor(scene, viewer, startPos, heading, pitch, speed, target = null, onKill = null, launcher = null, data = null) {
		// Data is REQUIRED — no default fallback. The Missile parent
		// ctor calls validateMunitionSpec on whatever we pass, so
		// missing fields throw with the munition id named.
		if (!data) {
			throw new Error('[AIM120] constructor requires a `data` object (munition JSON)');
		}
		super(scene, viewer, startPos, heading, pitch, speed, target, onKill, launcher, data);
		const d = data;

		// Override launch speed offset using THIS munition's value (the
		// base class already applied its OWN offset; we've passed our d
		// above so it uses the right one — but keep the speed-set here
		// explicit in case a subclass variant needs a different
		// behaviour).
		this.speed = speed + d.flight.launchSpeedOffset;

		this.maxLife = d.flight.maxLifeS;
		this.life    = this.maxLife;

		this.type = d.simType || 'AIM-120';
		this.signature = SIGNATURES[d.signature] || AIM120_SIGNATURE;
		this.boostRemaining = d.flight.boostDurationS;

		// Live radar configs — computed from this munition's JSON.
		// Expose the debug variant on the instance so commander view can
		// pick it up via `m.constructor.SEEKER_RADAR_DEBUG` (static) OR
		// `m._seekerRadar` (per-instance).
		this._seekerRadar      = buildSeekerRadar(d);
		this._seekerRadarTrack = buildSeekerRadarTrack(d);

		this.seekerActive   = false;
		this.pitbullFired   = false;
		this.maddog         = false; // post-pitbull with no target found

		// Datalink track — the launcher's latest radar estimate of the
		// target's state, plus velocity for dead-reckoning extrapolation
		// between updates. Initialized from the target's ground-truth at
		// launch (assume launcher had radar lock at the moment of fire).
		// Refreshed each frame while (a) the launcher is still alive and
		// (b) the launcher's radar still has this target in contacts.
		// When those conditions lapse the track just gets older; we
		// extrapolate until pitbull or MAX_LIFE.
		this._dlTrack = null;
		this._dlTrackTime = 0;
		if (target) {
			const h = Cesium.Math.toRadians(target.heading || 0);
			const p = Cesium.Math.toRadians(target.pitch || 0);
			const spd = target.speed || 0;
			this._dlTrack = {
				lon: target.lon,
				lat: target.lat,
				alt: target.alt,
				vE: spd * Math.sin(h) * Math.cos(p),
				vN: spd * Math.cos(h) * Math.cos(p),
				vU: spd * Math.sin(p),
				updatedAt: 0, // will be set on first update frame
			};
		}

		// For proportional navigation we need the previous line-of-sight
		// vector so we can measure its rotation rate between frames.
		this._prevLOS = null;

		// Build a slightly larger, AMRAAM-styled mesh (tail fins + strakes, no
		// mid-body canards like the AIM-9). Replace the parent-built mesh.
		if (this.mesh) this.scene.remove(this.mesh);
		this.initAMRAAMMesh();
	}

	initAMRAAMMesh() {
		this.mesh = new THREE.Group();

		// Read the live munition data via `this.data` — the destructured
		// `d` from the constructor isn't in scope inside this method.
		// (Earlier version referenced `d.modelTemplate` here and threw
		// on every fire of an AMRAAM-class missile, with the side-effect
		// of having already decremented ammo: classic "fired one and
		// the count went to zero" bug.)
		const d = this.data;

		// Prefer the real GLB model. Munition JSONs specifying a non-
		// default shape (e.g. Meteor with its ramjet intakes) use
		// `modelTemplate: "meteor"` and dispatch through the generic
		// helper; everything else uses the AIM-120 template. Fall back
		// to the procedural AMRAAM shape (cylinder + long mid-body
		// strakes + rear fins) if no GLB is loaded yet so first-frame-
		// after-boot shots still render.
		const templated = d.modelTemplate
			? cloneMissileTemplate(d.modelTemplate)
			: cloneAim120Template();
		const bodyLen = templated ? (d.realLengthM ?? 3.66) : 3.65;
		const radius  = 0.09; // 178 mm diameter → 89 mm radius (for fallback fins/flame scaling)
		if (templated) {
			this.mesh.add(templated);
		} else {
			this._buildProceduralAmraamBody(3.65, radius);
		}

		// Flame + glow overlays (dynamic — pulse during boost, fade on
		// coast). Slightly larger flame cone + glow than the AIM-9 to
		// match the AMRAAM's 8-second boost phase and higher exhaust
		// signature. Shared with the base Missile class via the
		// parameterized flame builder.
		this._buildFlameEffects(bodyLen, radius, 1.3, 2.5);

		this.mesh.layers.enable(0);
		this.mesh.layers.enable(1);
		this.mesh.matrixAutoUpdate = false;
		this.scene.add(this.mesh);
	}

	// Fallback procedural AMRAAM body — used while the GLB is still in
	// flight from the server. Same geometry the sim shipped with before
	// the real model was added.
	_buildProceduralAmraamBody(bodyLen, radius) {
		const bodyGeom = new THREE.CylinderGeometry(radius, radius, bodyLen, 16);
		const bodyMat  = new THREE.MeshStandardMaterial({ color: 0xd0d0d0, metalness: 0.4, roughness: 0.5 });
		this.mesh.add(new THREE.Mesh(bodyGeom, bodyMat));

		const noseLen  = 0.42;
		const noseGeom = new THREE.ConeGeometry(radius, noseLen, 16);
		noseGeom.translate(0, bodyLen / 2 + noseLen / 2, 0);
		const noseMat  = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.8, roughness: 0.3 });
		this.mesh.add(new THREE.Mesh(noseGeom, noseMat));

		// Yellow live-missile band near the warhead section.
		const bandGeom = new THREE.CylinderGeometry(radius + 0.002, radius + 0.002, 0.12, 16);
		bandGeom.translate(0, bodyLen / 2 - 0.55, 0);
		this.mesh.add(new THREE.Mesh(bandGeom, new THREE.MeshBasicMaterial({ color: 0xffcc00 })));

		const finMat = new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.3, roughness: 0.6 });

		// Rear control fins — four, short-chord, swept.
		const rearFinGeom = new THREE.BoxGeometry(0.38, 0.45, 0.025);
		rearFinGeom.translate(radius + 0.19, 0, 0);
		for (let i = 0; i < 4; i++) {
			const g = new THREE.Group();
			g.add(new THREE.Mesh(rearFinGeom, finMat));
			g.position.y = -bodyLen / 2 + 0.3;
			g.rotation.y = i * (Math.PI / 2);
			this.mesh.add(g);
		}

		// Long mid-body strakes (the AMRAAM trademark vs AIM-9's small canards).
		const strakeGeom = new THREE.BoxGeometry(0.015, 1.6, 0.08);
		strakeGeom.translate(radius + 0.04, 0, 0);
		for (let i = 0; i < 4; i++) {
			const g = new THREE.Group();
			g.add(new THREE.Mesh(strakeGeom, finMat));
			g.position.y = 0.2;
			g.rotation.y = i * (Math.PI / 2);
			this.mesh.add(g);
		}
	}

	update(dt, npcs) {
		if (!this.active) {
			if (this.trail.length > 0) this.updateTrail(dt);
			return;
		}

		// Flame flicker — shrink to a faint coast flame once the motor cuts.
		if (this.flameMesh) {
			if (this.boostRemaining > 0) {
				const f = 0.8 + Math.random() * 0.4;
				this.flameMesh.scale.set(f, 0.9 + Math.random() * 0.2, f);
				this.flameMesh.material.opacity = 0.7 + Math.random() * 0.3;
				if (this.flameCore) this.flameCore.scale.set(f, 0.9 + Math.random() * 0.2, f);
			} else {
				const k = Math.max(0, 1 - (this.data.flight.boostDurationS - this.boostRemaining + dt) / 2.0);
				this.flameMesh.scale.set(0.4, 0.4, 0.4);
				this.flameMesh.material.opacity = 0.2 * k;
				if (this.flameCore) this.flameCore.material.opacity = 0.3 * k;
			}
		}

		this.life -= dt;
		if (this.life <= 0) { this.destroy(); return; }

		// Advance the missile's internal clock. Used for datalink ageing —
		// we stash missile-age in `updatedAt` rather than wall-clock so the
		// ageing is consistent across pauses / frame-time jitter.
		this._age = (this._age || 0) + dt;

		// ---- Speed profile: boost → coast ---------------------------------
		// Drag now scales with ρ·v² (real missile physics), using the old
		// constant as the 10 km / 1000 m/s reference point. Effect: at
		// sea level a coasted missile bleeds ~30 m/s², at 20 km ~2 m/s².
		// Combined with the loft profile in _guide() this makes high-
		// altitude coast a real energy win instead of just a cosmetic
		// arc.
		const f = this.data.flight;
		if (this.boostRemaining > 0) {
			this.speed = Math.min(f.peakSpeed, this.speed + f.boostAccel * dt);
			this.boostRemaining -= dt;
		} else {
			const rhoRef   = airDensity(f.dragRefAltitude);
			const rho      = airDensity(this.alt);
			const v2Ratio  = (this.speed * this.speed) / (f.dragRefSpeed * f.dragRefSpeed);
			const dragAcc  = f.dragRef * (rho / Math.max(1e-6, rhoRef)) * v2Ratio;
			this.speed = Math.max(f.minSpeed, this.speed - dragAcc * dt);
		}

		// ---- Gravity --------------------------------------------------------
		// Decompose velocity into horizontal / vertical components, apply
		// gravity to the vertical component, then reconstruct (speed,
		// pitch). This does two things at once: a level-flight missile
		// slowly droops, and a coasting one actually arcs. The scalar-
		// along-nose representation is preserved — we're not switching to
		// a full velocity vector here, just letting gravity act on the
		// vertical channel before recomposing. Heading is unchanged.
		{
			const pRad = this.pitch * Math.PI / 180;
			let vHoriz = this.speed * Math.cos(pRad);
			let vVert  = this.speed * Math.sin(pRad) - GRAVITY * dt;
			this.speed = Math.max(this.data.flight.minSpeed, Math.hypot(vHoriz, vVert));
			this.pitch = Math.atan2(vVert, vHoriz) * 180 / Math.PI;
			this.pitch = Math.max(-85, Math.min(85, this.pitch));
		}

		// ---- Datalink refresh ---------------------------------------------
		// Read the launcher's current radar contact (if any) and copy that
		// into the missile's track estimate. Silently lapses if the
		// launcher's radar has dropped the target — by notching, by turning
		// off-bore, by terrain masking, by being destroyed — and the
		// missile then flies on dead-reckoning until pitbull.
		if (!this.pitbullFired) this._updateDatalink(npcs);

		// ---- Pitbull / maddog transition ----------------------------------
		// At SEEKER_ACTIVE_RANGE we're close enough for the missile's own
		// small radar to light up. Scan for targets in our forward cone;
		// whichever non-friendly non-missile we find closest wins. If
		// nothing's in the cone (target slipped off during midcourse), we
		// go MADDOG — no active lock, extrapolate dead-reckoning until life
		// expires.
		if (!this.pitbullFired) {
			const predicted = this._bestTargetState();
			if (predicted) {
				const rng = this._predictedRangeM(predicted);
				if (rng < this.data.seeker.activeRangeM) this._firePitbull(npcs);
			}
		} else {
			// Active seeker phase: make sure we can still see our target
			// under the same radar mechanics as a fighter (notch, terrain,
			// RCS aspect). If not, timer-based drop to MAD.
			this._checkLockIntegrity(npcs, dt);
		}

		// ---- Guidance -----------------------------------------------------
		if (!this.lostLock && !this.maddog) {
			this._guide(dt);
		}

		// Integrate position from heading/pitch/speed (same as parent class).
		// Cache pre-move position so collision checks can sweep the segment
		// between the two — important because at peak speed the missile
		// moves ~20 m/frame, way more than the fuze radius.
		const prevLon = this.lon;
		const prevLat = this.lat;
		const prevAlt = this.alt;
		const newPos = movePosition(this.lon, this.lat, this.alt, this.heading, this.pitch, this.speed * dt);
		this.lon = newPos.lon;
		this.lat = newPos.lat;
		this.alt = newPos.alt;

		this.updateTrail(dt);
		this.updateThreeMatrix();

		// Swept-segment kill check against all NPCs (not just the tracked
		// target) — catches any airframe in the fragmentation envelope.
		// Self-skip and friendly-fire filter are the same as the base
		// Missile class: don't detonate on the launcher or anyone sharing
		// its team (fixed "AIM-120 blows up on the rail" bug).
		const killR   = this.data.warhead.killRadiusM;
		const killRSq = killR * killR;
		const fuzeR   = this.data.warhead.fuzeSenseRadiusM;
		const fuzeRSq = fuzeR * fuzeR;
		const missAbortRSq = fuzeRSq * (this.data.warhead.missAbortRadiusMul ?? 4);

		if (npcs) {
			for (const npc of npcs) {
				if (!npc || npc === this.launcher) continue;
				if (npc.destroyed) continue;
				if (npc.team && this.team && npc.team === this.team) continue;
				const missSq = this._segmentMissDistSq(prevLon, prevLat, prevAlt, this.lon, this.lat, this.alt, npc);
				if (missSq < killRSq) {
					this.hitNPC(npc);
					return;
				}
			}
		}

		// Closest-approach proximity fuze against the tracked target.
		// Fires when we're inside the fuze sensing envelope and range turns
		// from decreasing to increasing (the sensor's cue that the target
		// just flew past). Without this a slightly-offset intercept at
		// high speed misses entirely.
		if (this.target && !this.target.destroyed) {
			const dSq = this.calculateDistSqToNPC(this.target);
			if (dSq < fuzeRSq &&
				this._prevTargetDistSq !== undefined &&
				dSq > this._prevTargetDistSq) {
				this.hitNPC(this.target);
				return;
			}
			this._prevTargetDistSq = dSq < fuzeRSq ? dSq : undefined;

			// Miss-abort: track the closest we ever got to the tracked
			// target. Once the range exceeds the miss-abort radius *and*
			// we've been close enough to matter, the pass is over. Drop
			// guidance — real AMRAAMs do not loop around for a retry.
			this._minRangeSq = Math.min(this._minRangeSq ?? Infinity, dSq);
			if (this._minRangeSq < missAbortRSq && dSq > missAbortRSq) {
				this.lostLock = true;
			}
		}

		this.checkTerrainCollision();
	}

	// ============================================================================
	// Datalink / dead-reckoning / pitbull machinery
	// ============================================================================

	// Refresh the datalink track from the launcher's latest radar contact.
	// If the launcher's radar isn't seeing the target right now — because
	// the target has notched, gone over a ridge, left the gimbal cone, or
	// the launcher is dead — we silently don't update, and the track ages
	// into dead reckoning. Matches the real Fox-3 midcourse picture: the
	// missile only gets fresh target data as long as its shooter's radar
	// is still painting the target.
	_updateDatalink() {
		if (!this.target) return;

		// Prefer the launcher's own radar contact if it still has one —
		// lowest latency, most authoritative. Fall back to the team
		// datalink's fused picture (AWACS, wingman, ground radar) when
		// the launcher isn't painting this target anymore. The missile
		// keeps guiding as long as *anyone* on the team has the track.
		let src = null;
		const launcher = this.launcher;
		if (launcher && !launcher.destroyed && launcher.contacts) {
			const c = launcher.contacts.get(this.target);
			if (c && c.radar) {
				const v = c.radar.velocity;
				src = {
					lon: this.target.lon, lat: this.target.lat, alt: this.target.alt,
					vE: v ? v.x : 0, vN: v ? v.y : 0, vU: v ? v.z : 0,
				};
			}
		}
		if (!src && launcher && launcher.team) {
			const dl = getTeamDatalink(launcher.team);
			const fused = dl && dl.getFusedContact(this.target);
			if (fused) {
				src = {
					lon: fused.lon, lat: fused.lat, alt: fused.alt,
					vE:  fused.vE,  vN:  fused.vN,  vU:  fused.vU,
				};
			}
		}
		if (!src) return;
		this._dlTrack = { ...src, updatedAt: this._age };
	}

	// Best-available estimate of the target's current state:
	//   - post-pitbull with a live active lock → the actual target's pose,
	//     because the missile's own radar is tracking it directly
	//   - pre-pitbull or maddog → extrapolate the datalink track forward
	//     from `updatedAt` to now using last known velocity
	//   - no track at all → null; guidance skips this frame
	_bestTargetState() {
		if (this.pitbullFired && !this.maddog && this.target && !this.target.destroyed) {
			const h = Cesium.Math.toRadians(this.target.heading || 0);
			const p = Cesium.Math.toRadians(this.target.pitch || 0);
			const spd = this.target.speed || 0;
			return {
				lon: this.target.lon,
				lat: this.target.lat,
				alt: this.target.alt,
				vE: spd * Math.sin(h) * Math.cos(p),
				vN: spd * Math.cos(h) * Math.cos(p),
				vU: spd * Math.sin(p),
				fresh: true,
			};
		}
		const dl = this._dlTrack;
		if (!dl) return null;
		const age = Math.max(0, this._age - dl.updatedAt);
		const latRad = Cesium.Math.toRadians(dl.lat);
		return {
			lon: dl.lon + (dl.vE * age) / (111320 * Math.max(0.1, Math.cos(latRad))),
			lat: dl.lat + (dl.vN * age) / 111320,
			alt: dl.alt + (dl.vU * age),
			vE: dl.vE, vN: dl.vN, vU: dl.vU,
			fresh: age < 0.5,
		};
	}

	// 3-D range from the missile to a {lon, lat, alt} state (flat-earth
	// approximation, fine at these distances).
	_predictedRangeM(state) {
		const mLat = Cesium.Math.toRadians(this.lat);
		const dE = (state.lon - this.lon) * 111320 * Math.cos(mLat);
		const dN = (state.lat - this.lat) * 111320;
		const dU = (state.alt - this.alt);
		return Math.sqrt(dE * dE + dN * dN + dU * dU);
	}

	// Pitbull: the missile's own seeker goes live. Scan all eligible
	// targets for one in the forward cone at seeker range; prefer the one
	// closest to the current datalink track (usually the original target,
	// but could be a different bogey if the target slipped and someone
	// else is nearby). If nothing is in the cone → MADDOG: active seeker
	// failed to lock, missile goes ballistic on dead reckoning.
	_firePitbull(allTargets) {
		this.pitbullFired = true;
		this.seekerActive = true;
		try { soundManager.play('rwr-lock'); } catch (e) {}

		const picked = this._scanForLock(allTargets);
		if (picked) {
			this.target = picked;
			this.maddog = false;
		} else {
			this.maddog = true;
		}
	}

	// Pseudo-observer for the unified radar check. The missile already
	// carries lon/lat/alt/heading/pitch/speed, which is exactly what
	// detectRadar() needs — no body-frame transforms to repeat here.
	_seekerObserver() {
		return {
			lon: this.lon, lat: this.lat, alt: this.alt,
			heading: this.heading, pitch: this.pitch,
			speed: this.speed,
		};
	}

	_scanForLock(allTargets) {
		if (!allTargets || allTargets.length === 0) return null;
		const mLat  = Cesium.Math.toRadians(this.lat);
		const observer = this._seekerObserver();

		// DL track gives a sanity reference so the seeker prefers the
		// thing closest to where it expected the target to be, rather
		// than the geometrically-closest bogey.
		const dlRef = this._bestTargetState();

		let best = null;
		let bestScore = -Infinity;
		for (const t of allTargets) {
			if (!t || t === this.launcher) continue;
			if (t.destroyed || t.active === false) continue;
			if (t.team && this.team && t.team === this.team) continue;
			const sig = t.signature;
			if (!sig) continue;
			// The seeker is trained to reject missile-class returns; we do
			// it here at the filter layer rather than in detectRadar so
			// the unified radar function stays target-agnostic.
			if (sig.unitClass === 'missile' || sig.unitClass === 'cruise_missile') continue;

			// Run the same radar pipeline a fighter would — FOV, RCS
			// aspect, range-equation with RCS^0.25 scaling, terrain LOS,
			// and the pulse-Doppler notch. Stealth, beaming, and terrain
			// masking all break seeker lock now, not just plane radar.
			const det = detectRadar(observer, t, this._seekerRadar);
			if (!det) continue;

			let dlDist = 0;
			if (dlRef) {
				const dxE = (t.lon - dlRef.lon) * 111320 * Math.cos(mLat);
				const dxN = (t.lat - dlRef.lat) * 111320;
				const dxU = (t.alt - dlRef.alt);
				dlDist = Math.sqrt(dxE * dxE + dxN * dxN + dxU * dxU);
			}
			// Smaller range + closer-to-DL-track = better; large dlDist
			// strongly penalised so we prefer the original target over
			// drop-ins that just happen to be in the cone.
			const score = -det.range - dlDist * 0.5;
			if (score > bestScore) {
				bestScore = score;
				best = t;
			}
		}
		return best;
	}

	// Post-pitbull: every frame, check the seeker can still see its locked
	// target (same mechanics as the plane radar — FOV, RCS aspect, range,
	// terrain LOS, pulse-Doppler notch). If detection fails for more than
	// LOCK_DROP_TIMEOUT, flip to maddog. Maddog is NOT permanent: every
	// REACQUIRE_INTERVAL seconds we re-scan for any eligible target in the
	// cone, and if we find one we re-acquire lock. Real AMRAAMs routinely
	// reacquire after a brief notch / terrain blink, and making maddog
	// permanent was the main reason the refactor broke kills entirely.
	_checkLockIntegrity(allTargets, dt) {
		if (!this.pitbullFired) return;

		// 6e.3 — defensive jam break-lock. Before doing the geometric
		// lock check, give the target's defensive jammer a per-second
		// probability to scramble our seeker. Realistic numbers are
		// modest (5-12%/s for modern AESA seekers, 30%/s for older
		// pulse-Doppler), so jamming is a delaying tactic against
		// modern AAMs, not an immunity. On a successful break we slam
		// the lock-lost timer past the drop threshold so the missile
		// goes maddog this frame instead of getting reacquired by the
		// geometric check below.
		if (rollJamBreakLock(this, dt)) {
			this._lockLostTimer = (this.data.seeker.lockDropTimeoutS || 0) + 1;
			this._reacqAttempt  = (this.data.seeker.reacquireMaxAttempts || 0) + 1;
			this.maddog = true;
			this.target = null;
			return;
		}

		const observer = this._seekerObserver();

		// Case A: we have a target — can we still see it?
		// Use the *tracking* radar config (wider notch). Once we have
		// lock, inertial integration carries the seeker through brief
		// Doppler nulls; only hard-physical losses (out of FOV, out of
		// range, terrain-masked, deep notch) should break track here.
		if (this.target && !this.target.destroyed && this.target.active !== false) {
			const det = detectRadar(observer, this.target, this._seekerRadarTrack);
			if (det) {
				this._lockLostTimer = 0;
				this._reacqAttempt = 0;
				this._reacqTimer = 0;
				this.maddog = false;
				return;
			}
		}

		// Case B: target gone, destroyed, or undetected this frame.
		// Accumulate the lock-lost timer and run the reacquire scan on
		// an exponentially backed-off cadence — first retry comes fast
		// (0.25 s) so a brief notch blip recovers cleanly, but a target
		// that holds beam through 4 attempts is genuinely lost.
		this._lockLostTimer = (this._lockLostTimer || 0) + dt;
		this._reacqTimer    = (this._reacqTimer    || 0) + dt;
		this._reacqAttempt  = this._reacqAttempt   ?? 0;

		// active_radar seeker fields validated at ctor.
		const seeker     = this.data.seeker;
		const baseIv     = seeker.reacquireIntervalS;
		const backoffMul = seeker.reacquireBackoffMul;
		const maxIv      = seeker.reacquireMaxIntervalS;
		const maxAttempts= seeker.reacquireMaxAttempts;

		const nextIv = Math.min(maxIv, baseIv * Math.pow(backoffMul, this._reacqAttempt));

		if (this._reacqAttempt < maxAttempts && this._reacqTimer >= nextIv) {
			this._reacqTimer = 0;
			this._reacqAttempt++;
			const picked = this._scanForLock(allTargets);
			if (picked) {
				this.target = picked;
				this._lockLostTimer = 0;
				this._reacqAttempt = 0;
				this.maddog = false;
				return;
			}
		}

		// Still no detection and the drop timer has elapsed → maddog.
		// Guidance falls through to dead-reckoning on the last DL track.
		// Once we're past maxAttempts the reacquire scan no longer
		// fires, so a target that beat the back-off window stays beaten.
		if (this._lockLostTimer >= seeker.lockDropTimeoutS && !this.maddog) {
			this.maddog = true;
		}
	}

	// ============================================================================
	// Guidance
	// ============================================================================

	// Lead-pursuit + proportional navigation, with an optional loft for long
	// range shots during motor burn. Now reads its target state from the
	// datalink track (pre-pitbull, with dead-reckoning when the track is
	// stale) or from the active lock (post-pitbull). If no track exists,
	// the missile simply coasts — maddog fallback.
	_guide(dt) {
		const tgt = this._bestTargetState();
		if (!tgt) return;

		const myPos     = Cesium.Cartesian3.fromDegrees(this.lon, this.lat, this.alt);
		const targetPos = Cesium.Cartesian3.fromDegrees(tgt.lon, tgt.lat, tgt.alt);

		const losECEF = Cesium.Cartesian3.subtract(targetPos, myPos, new Cesium.Cartesian3());
		const rangeToTarget = Cesium.Cartesian3.magnitude(losECEF);

		const enu      = Cesium.Transforms.eastNorthUpToFixedFrame(myPos);
		const invEnu   = Cesium.Matrix4.inverse(enu, new Cesium.Matrix4());
		const losLocal = Cesium.Matrix4.multiplyByPointAsVector(invEnu, losECEF, new Cesium.Cartesian3());

		// Target velocity comes straight from the track (ENU); we trust
		// whichever source produced it (active seeker for pitbull, radar
		// contact for midcourse).
		const tgtVelX = tgt.vE, tgtVelY = tgt.vN, tgtVelZ = tgt.vU;
		const hRad = Cesium.Math.toRadians(this.heading);
		const pRad = Cesium.Math.toRadians(this.pitch);
		const mVelX = this.speed * Math.sin(hRad) * Math.cos(pRad);
		const mVelY = this.speed * Math.cos(hRad) * Math.cos(pRad);
		const mVelZ = this.speed * Math.sin(pRad);
		const losLen = Math.max(1, rangeToTarget);
		const closingRate =
			((mVelX - tgtVelX) * losLocal.x +
			 (mVelY - tgtVelY) * losLocal.y +
			 (mVelZ - tgtVelZ) * losLocal.z) / losLen;
		const tgo = rangeToTarget / Math.max(100, closingRate);
		const lead = new Cesium.Cartesian3(
			losLocal.x + tgtVelX * tgo,
			losLocal.y + tgtVelY * tgo,
			losLocal.z + tgtVelZ * tgo,
		);

		const desiredHeading = Cesium.Math.toDegrees(Math.atan2(lead.x, lead.y));
		let   desiredPitch   = Cesium.Math.toDegrees(Math.atan2(
			lead.z,
			Math.sqrt(lead.x * lead.x + lead.y * lead.y),
		));

		// Range-based loft. Ramp from full loft at MAX_LOFT_RANGE down to
		// zero at TERMINAL_RANGE. Applied continuously (boost + coast),
		// so the missile climbs during boost and holds altitude during
		// coast rather than porpoising toward the target at low level.
		// Inside TERMINAL_RANGE the term drops out entirely, letting the
		// raw lead-pursuit geometry produce the steep terminal dive.
		const loft = this.data.loft || {};
		const termRange  = loft.terminalRangeM ?? 15000;
		const maxLoftR   = loft.maxLoftRangeM  ?? 70000;
		const maxLoftDeg = loft.maxLoftDeg     ?? 25;
		if (rangeToTarget > termRange) {
			const denom = Math.max(1, maxLoftR - termRange);
			const loftRatio = Math.min(1, (rangeToTarget - termRange) / denom);
			desiredPitch += maxLoftDeg * loftRatio;
		}
		desiredPitch = THREE.MathUtils.clamp(desiredPitch, -85, 85);

		let dH = desiredHeading - this.heading;
		while (dH < -180) dH += 360;
		while (dH >  180) dH -= 360;
		const dP = desiredPitch - this.pitch;

		// Speed-dependent turn cap — see missile.js for the rationale.
		// G_avail scales with (V/V_ref)² so a coasting AMRAAM in the
		// terminal phase pulls a small fraction of its rated 40 G and is
		// trivially out-turned by a 25°/s fighter pull. The design-Mach
		// for AMRAAM-class missiles is ~Mach 2 (≈ 600 m/s); at and above
		// that we cap at the rated maxTurnDegPerSec.
		const maxG    = 40;
		const vRef    = this.data.flight.vManeuverRef;
		const gFloor  = this.data.flight.gAvailFloor;
		const qFactor = Math.min(1, Math.max(gFloor, (this.speed * this.speed) / (vRef * vRef)));
		const gAvail  = maxG * qFactor;
		const turnRadPerS = (gAvail * 9.81) / Math.max(50, this.speed);
		const turnDegPerS = Cesium.Math.toDegrees(turnRadPerS);
		const ratedCap    = this.data.flight.maxTurnDegPerSec;
		const cap = Math.min(ratedCap, turnDegPerS) * dt;
		const pn  = this.data.flight.pnGain;
		this.heading += THREE.MathUtils.clamp(dH * pn * dt, -cap, cap);
		this.pitch   += THREE.MathUtils.clamp(dP * pn * dt, -cap, cap);
		this.pitch   = THREE.MathUtils.clamp(this.pitch, -85, 85);

		// Debug data: include mode so the HUD and map tooltip can show
		// the current guidance state. "DL" = datalink midcourse,
		// "DR"  = dead reckoning (track stale), "ACT" = post-pitbull
		// active lock, "MAD" = maddog after failed pitbull.
		let mode;
		if (this.maddog)                    mode = 'MAD';
		else if (this.pitbullFired)         mode = 'ACT';
		else if (tgt.fresh)                 mode = 'DL';
		else                                mode = 'DR';

		this.debug = {
			rangeToTarget,
			desiredHeading,
			desiredPitch,
			headingError: dH,
			pitchError:   dP,
			tgo,
			mode,
			targetName: (this.target && this.target.name) || 'TGT',
		};
	}

	// _estimateTargetVelocityENU lives on the base Missile class; we inherit.

	// For BVR shots missile speed dominates the closing rate; using it keeps
	// the lead computation stable even against outbound targets.
	_estimateTimeToGo(rangeToTarget) {
		return rangeToTarget / Math.max(100, this.speed);
	}

	hitNPC(npc) {
		pushKill({
			shooter: this.launcher,
			target:  npc,
			weapon:  this.type || 'AIM-120',
			at:      performance.now() * 0.001,
			reason:  'kill',
		});
		npc.destroyed = true;
		if (this.onKill) this.onKill(npc);
		try {
			// Bigger bang than an AIM-9 — proximity fuze goes off with its
			// continuous-rod warhead at close range.
			particles.spawnExplosion(this.lon, this.lat, this.alt, { count: 120, smokeCount: 30, big: true });
			particles.spawnWreckage(this.lon, this.lat, this.alt, this.heading, this.pitch, { count: 64 });
			soundManager.play('explosion-random');
		} catch (e) {}
		this.destroy();
	}
}
