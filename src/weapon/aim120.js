import * as THREE from 'three';
import * as Cesium from 'cesium';
import { movePosition } from '../utils/math';
import { particles } from '../utils/particles';
import { soundManager } from '../utils/soundManager';
import { Missile } from './missile';
import { SIGNATURES } from '../systems/signatures';

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

// Physical parameters tuned to published AIM-120D performance.
const BOOST_DURATION      = 8.0;     // s, motor burn time
const BOOST_ACCEL         = 170;     // m/s², net (≈ 17 G axial during boost)
const BOOST_PEAK_SPEED    = 1300;    // m/s, roughly Mach 4 at altitude
const COAST_DRAG_ACCEL    = 8;       // m/s² nominal deceleration after burnout
const MIN_SPEED           = 280;     // m/s, below this the missile is a lawn dart
const MAX_LIFE            = 120;     // s, time of flight before self-destruct
const MAX_TURN_DEG_PER_S  = 40;      // sustained turn rate cap (structural+AoA)
const PN_GAIN             = 4.0;     // proportional navigation N (typ. 3–5)
const SEEKER_ACTIVE_RANGE = 18000;   // m, terminal "pitbull" range
const LOFT_ALTITUDE_BIAS  = 0.25;    // radians (~14°) of extra pitch-up in boost
const LOFT_MAX_RANGE      = 40000;   // m, above which the loft engages
// Kill envelope — AMRAAM has a bigger warhead than AIM-9X and proportionally
// wider lethal radius + fuze sensing. Miss distance < 15 m is a direct
// warhead kill; up to ~30 m the proximity fuze still detonates when the
// range rate flips from closing to opening (the "we just passed them" cue).
const KILL_RADIUS         = 15;
const KILL_RADIUS_SQ      = KILL_RADIUS * KILL_RADIUS;
const FUZE_SENSE_RADIUS   = 30;
const FUZE_SENSE_RADIUS_SQ = FUZE_SENSE_RADIUS * FUZE_SENSE_RADIUS;
// Missed-pass cutoff: once we've been within 2× the fuze envelope and the
// current range exceeds that, the pass is over. Set lostLock so guidance
// stops — real AMRAAMs do not loop around for a second attempt.
const MISS_ABORT_RADIUS_SQ = FUZE_SENSE_RADIUS_SQ * 4;

export class AIM120 extends Missile {
	constructor(scene, viewer, startPos, heading, pitch, speed, target = null, onKill = null, launcher = null) {
		// Call Missile's constructor but then override the flight parameters —
		// we want a different speed profile and lifetime.
		super(scene, viewer, startPos, heading, pitch, speed, target, onKill, launcher);

		// Replace the base-class speed (which was launch + 800) with just the
		// launch-rail speed; the motor will accelerate us during boost.
		this.speed = speed + 50;

		this.maxLife = MAX_LIFE;
		this.life    = MAX_LIFE;

		this.type = 'AIM-120';
		// AMRAAM has a different signature profile from the IR AIM-9.
		this.signature = AIM120_SIGNATURE;
		this.boostRemaining = BOOST_DURATION;
		this.seekerActive   = false;
		this.pitbullFired   = false;

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

		const bodyLen = 3.65; // real AMRAAM body ~3.66 m
		const radius  = 0.09; // 178 mm diameter → 89 mm radius
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

		// Exhaust — reuse the parent flame/glow sprite setup for visual parity.
		const flameColor = new THREE.Color(1.0, 0.7, 0.25);
		const flameGeom  = new THREE.ConeGeometry(radius * 0.95, 1.3, 16, 1, true);
		flameGeom.rotateX(Math.PI);
		flameGeom.translate(0, -0.65, 0);
		const flameMat = new THREE.MeshBasicMaterial({
			color: flameColor, transparent: true, opacity: 0.8, side: THREE.DoubleSide,
			depthWrite: false, blending: THREE.AdditiveBlending,
		});
		this.flameMesh = new THREE.Mesh(flameGeom, flameMat);
		this.flameMesh.position.y = -bodyLen / 2;
		this.mesh.add(this.flameMesh);

		const coreGeom = new THREE.ConeGeometry(radius * 0.55, 0.8, 16, 1, true);
		coreGeom.rotateX(Math.PI);
		coreGeom.translate(0, -0.4, 0);
		const coreMat = new THREE.MeshBasicMaterial({
			color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
			depthWrite: false, blending: THREE.AdditiveBlending,
		});
		this.flameCore = new THREE.Mesh(coreGeom, coreMat);
		this.flameMesh.add(this.flameCore);

		// Glow sprite — same radial gradient trick the parent class uses.
		const canvSize = 128;
		const canv = (typeof document !== 'undefined') ? document.createElement('canvas') : null;
		let glowTexture = null;
		if (canv) {
			canv.width = canv.height = canvSize;
			const ctx = canv.getContext('2d');
			const cx = canvSize / 2;
			const grad = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
			grad.addColorStop(0.00, 'rgba(255,255,255,1)');
			grad.addColorStop(0.18, 'rgba(255,245,200,1)');
			grad.addColorStop(0.38, 'rgba(255,160,30,0.95)');
			grad.addColorStop(0.62, 'rgba(220,60,10,0.6)');
			grad.addColorStop(1.00, 'rgba(0,0,0,0)');
			ctx.fillStyle = grad;
			ctx.fillRect(0, 0, canvSize, canvSize);
			glowTexture = new THREE.CanvasTexture(canv);
			glowTexture.minFilter = THREE.LinearFilter;
			glowTexture.magFilter = THREE.LinearFilter;
		}
		const spriteMat = new THREE.SpriteMaterial({
			map: glowTexture, color: new THREE.Color(1.0, 0.95, 0.9),
			transparent: true, opacity: 0.98, blending: THREE.AdditiveBlending,
			depthTest: false, depthWrite: false,
		});
		this.flameGlow = new THREE.Sprite(spriteMat);
		this.flameGlow.scale.set(2.5, 2.5, 1.0);
		this.flameGlow.position.y = -bodyLen / 2 - 0.08;
		this.mesh.add(this.flameGlow);

		this.mesh.layers.enable(0);
		this.mesh.layers.enable(1);
		this.mesh.matrixAutoUpdate = false;
		this.scene.add(this.mesh);
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
				// Burned out — ghost exhaust for a couple seconds, then off.
				const k = Math.max(0, 1 - (BOOST_DURATION - this.boostRemaining + dt) / 2.0);
				this.flameMesh.scale.set(0.4, 0.4, 0.4);
				this.flameMesh.material.opacity = 0.2 * k;
				if (this.flameCore) this.flameCore.material.opacity = 0.3 * k;
			}
		}

		this.life -= dt;
		if (this.life <= 0) { this.destroy(); return; }

		// ---- Speed profile: boost → coast ---------------------------------
		if (this.boostRemaining > 0) {
			this.speed = Math.min(BOOST_PEAK_SPEED, this.speed + BOOST_ACCEL * dt);
			this.boostRemaining -= dt;
		} else {
			// Simple drag deceleration in coast. Real AMRAAMs retain energy
			// at altitude far better than this, but sea-level coast is in
			// this ballpark — good enough for the feel without a full aero
			// model on the missile.
			this.speed = Math.max(MIN_SPEED, this.speed - COAST_DRAG_ACCEL * dt);
		}

		// ---- Guidance -----------------------------------------------------
		if (this.target && !this.target.destroyed && !this.lostLock) {
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
		if (npcs) {
			for (const npc of npcs) {
				if (!npc || npc === this.launcher) continue;
				if (npc.destroyed) continue;
				if (npc.team && this.team && npc.team === this.team) continue;
				const missSq = this._segmentMissDistSq(prevLon, prevLat, prevAlt, this.lon, this.lat, this.alt, npc);
				if (missSq < KILL_RADIUS_SQ) {
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
			if (dSq < FUZE_SENSE_RADIUS_SQ &&
				this._prevTargetDistSq !== undefined &&
				dSq > this._prevTargetDistSq) {
				this.hitNPC(this.target);
				return;
			}
			this._prevTargetDistSq = dSq < FUZE_SENSE_RADIUS_SQ ? dSq : undefined;

			// Miss-abort: track the closest we ever got to the tracked
			// target. Once the range exceeds the miss-abort radius *and*
			// we've been close enough to matter, the pass is over. Drop
			// guidance — real AMRAAMs do not loop around for a retry.
			this._minRangeSq = Math.min(this._minRangeSq ?? Infinity, dSq);
			if (this._minRangeSq < MISS_ABORT_RADIUS_SQ && dSq > MISS_ABORT_RADIUS_SQ) {
				this.lostLock = true;
			}
		}

		this.checkTerrainCollision();
	}

	// Lead-pursuit + proportional navigation, with an optional loft for long
	// range shots during motor burn. Follows the same frame-transform pattern
	// as Missile.trackTarget() so we don't diverge from a working baseline.
	_guide(dt) {
		const myPos     = Cesium.Cartesian3.fromDegrees(this.lon,       this.lat,       this.alt);
		const targetPos = Cesium.Cartesian3.fromDegrees(this.target.lon, this.target.lat, this.target.alt);

		// LOS in ECEF, length = range. Keep it in METERS — when we add the
		// target's velocity × time-to-go offset we want the two terms to be
		// in the same units, otherwise the prediction dominates and guidance
		// points roughly along the target's velocity instead of at the
		// predicted intercept.
		const losECEF = Cesium.Cartesian3.subtract(targetPos, myPos, new Cesium.Cartesian3());
		const rangeToTarget = Cesium.Cartesian3.magnitude(losECEF);

		// Transform the LOS (still in meters) into the missile's local ENU
		// frame so we can add the target velocity (also ENU, m/s × s = m).
		const enu      = Cesium.Transforms.eastNorthUpToFixedFrame(myPos);
		const invEnu   = Cesium.Matrix4.inverse(enu, new Cesium.Matrix4());
		const losLocal = Cesium.Matrix4.multiplyByPointAsVector(invEnu, losECEF, new Cesium.Cartesian3());

		// "Pitbull": terminal seeker activation.
		if (!this.pitbullFired && rangeToTarget < SEEKER_ACTIVE_RANGE) {
			this.pitbullFired = true;
			this.seekerActive = true;
			try { soundManager.play('rwr-lock'); } catch (e) {}
		}

		// Predicted intercept point (in ENU, relative to missile):
		//   P = (target − missile) + v_target · t_go
		// t_go uses real closing rate (missile velocity minus target velocity
		// projected onto the LOS), not just missile speed. The old
		// `range / missile_speed` approximation underestimates head-on t_go
		// (~25%) and overestimates tail-chase t_go (~30%); the resulting
		// lead-point error reliably shows up as small-distance miss on
		// long-range shots.
		const tgtVel = this._estimateTargetVelocityENU();
		const hRad   = Cesium.Math.toRadians(this.heading);
		const pRad   = Cesium.Math.toRadians(this.pitch);
		const mVelX  = this.speed * Math.sin(hRad) * Math.cos(pRad);
		const mVelY  = this.speed * Math.cos(hRad) * Math.cos(pRad);
		const mVelZ  = this.speed * Math.sin(pRad);
		const losLen = Math.max(1, rangeToTarget);
		const closingRate =
			((mVelX - tgtVel.x) * losLocal.x +
			 (mVelY - tgtVel.y) * losLocal.y +
			 (mVelZ - tgtVel.z) * losLocal.z) / losLen;
		const tgo = rangeToTarget / Math.max(100, closingRate);
		const lead = new Cesium.Cartesian3(
			losLocal.x + tgtVel.x * tgo,
			losLocal.y + tgtVel.y * tgo,
			losLocal.z + tgtVel.z * tgo,
		);

		const desiredHeading = Cesium.Math.toDegrees(Math.atan2(lead.x, lead.y));
		let   desiredPitch   = Cesium.Math.toDegrees(Math.atan2(
			lead.z,
			Math.sqrt(lead.x * lead.x + lead.y * lead.y),
		));

		// Long-range loft: during boost, bias aim point up by a few degrees
		// so the missile climbs instead of flying low. Real AMRAAMs fly a
		// lofted profile for max range, trading initial altitude for cheaper
		// drag in the thin upper atmosphere.
		if (this.boostRemaining > 0 && rangeToTarget > LOFT_MAX_RANGE) {
			const loftRatio = Math.min(1, (rangeToTarget - LOFT_MAX_RANGE) / 40000);
			desiredPitch += loftRatio * Cesium.Math.toDegrees(LOFT_ALTITUDE_BIAS);
		}
		desiredPitch = THREE.MathUtils.clamp(desiredPitch, -85, 85);

		// Proportional navigation: command a turn toward the lead point at
		// rate N × (heading error / dt), clamped to the airframe's max turn
		// rate. For small errors this reduces to N × LOS rate, which is the
		// classic PN guidance law; for large errors the clamp keeps it from
		// over-commanding and losing energy in a tight turn.
		let dH = desiredHeading - this.heading;
		while (dH < -180) dH += 360;
		while (dH >  180) dH -= 360;
		const dP = desiredPitch - this.pitch;

		const cap = MAX_TURN_DEG_PER_S * dt;
		this.heading += THREE.MathUtils.clamp(dH * PN_GAIN * dt, -cap, cap);
		this.pitch   += THREE.MathUtils.clamp(dP * PN_GAIN * dt, -cap, cap);
		this.pitch   = THREE.MathUtils.clamp(this.pitch, -85, 85);

		// Cache debug data so the HUD can show what the missile is doing.
		this.debug = {
			rangeToTarget,
			desiredHeading,
			desiredPitch,
			headingError: dH,
			pitchError:   dP,
			tgo,
			targetName:   this.target.name || 'TGT',
		};
	}

	// _estimateTargetVelocityENU lives on the base Missile class; we inherit.

	// For BVR shots missile speed dominates the closing rate; using it keeps
	// the lead computation stable even against outbound targets.
	_estimateTimeToGo(rangeToTarget) {
		return rangeToTarget / Math.max(100, this.speed);
	}

	hitNPC(npc) {
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
