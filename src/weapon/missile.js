import * as THREE from 'three';
import * as Cesium from 'cesium';
import { movePosition } from '../utils/math';
import { particles } from '../utils/particles';
import { soundManager } from '../utils/soundManager';
import { SIGNATURES } from '../systems/signatures';

// Shared signature reference (not per-missile copy) — all live AIM-9s have
// the same sensor profile. Subclasses (AIM-120) overwrite this in their ctor.
const MISSILE_IR_SIGNATURE = SIGNATURES.missile_ir;

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

// AIM-9X performance envelope.
const BOOST_DURATION       = 3.5;    // s
const BOOST_ACCEL          = 210;    // m/s² during motor burn
const BOOST_PEAK_SPEED     = 860;    // m/s, Mach 2.5 ceiling
const COAST_DRAG           = 22;     // m/s² nominal coast deceleration
const MIN_SPEED            = 150;    // m/s floor before missile becomes a dart
const MAX_LIFE             = 40;     // s
const MAX_G                = 40;     // airframe G limit
const PN_GAIN              = 4.0;    // proportional navigation N
// Kill envelope.
// KILL_RADIUS is the lethal radius of the continuous-rod warhead — anything
// inside this on the swept path is a guaranteed kill (all NPCs, not just the
// locked target).
// FUZE_SENSE_RADIUS is the proximity fuze's effective sensing range for the
// tracked target specifically. At high crossing speeds the missile can pass
// within this envelope for only a fraction of a frame, so we detect the
// "closest approach" — the moment the range rate turns from closing to
// opening — and detonate then. Without this, any shot that isn't close to a
// pure tail chase ends up flying past the target by 5-15m (the turn-rate
// limit can't match last-second maneuvering) and the strict swept check
// misses. With it, crossing and beam shots behave like real all-aspect
// AIM-9Xs should.
const KILL_RADIUS          = 10;     // m, warhead lethal radius
const KILL_RADIUS_SQ       = KILL_RADIUS * KILL_RADIUS;
const FUZE_SENSE_RADIUS    = 20;     // m, fuze-triggered detonation envelope
const FUZE_SENSE_RADIUS_SQ = FUZE_SENSE_RADIUS * FUZE_SENSE_RADIUS;
const SEEKER_HALF_CONE_DEG = 90;     // ±90° HOBS gimbal
const SEEKER_COS_MIN       = Math.cos(SEEKER_HALF_CONE_DEG * Math.PI / 180);

export class Missile {
	constructor(scene, viewer, startPos, heading, pitch, speed, target = null, onKill = null, launcher = null) {
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
		// Launch-rail ejection bump; motor does the real work during boost.
		this.speed = speed + 40;

		this.maxLife = MAX_LIFE;
		this.life = this.maxLife;
		this.boostRemaining = BOOST_DURATION;
		this.lostLock = false;
		this.active = true;
		// Type tag so HUD labels can distinguish AIM-9 from AIM-120 etc.
		// Subclasses override in their constructor.
		this.type = 'AIM-9';
		// Signature for sensor system (reference, not copy — all AIM-9s
		// share the same signature definition). Subclasses can overwrite.
		this.signature = MISSILE_IR_SIGNATURE;

		this._scratchMatrix = new Cesium.Matrix4();
		this._scratchHPR = new Cesium.HeadingPitchRoll();
		this._scratchCartesian = new Cesium.Cartesian3();
		this._scratchThreeMatrix = new THREE.Matrix4();
		this._scratchCameraMatrix = new Cesium.Matrix4();

		this.trail = [];
		this.distanceSinceLastTrail = 0;

		this.initMesh();
	}

	initMesh() {

		this.mesh = new THREE.Group();


		const bodyLen = 2.6;
		const radius = 0.07;
		const bodyGeom = new THREE.CylinderGeometry(radius, radius, bodyLen, 16);
		const bodyMat = new THREE.MeshStandardMaterial({
			color: 0xcccccc,
			metalness: 0.4,
			roughness: 0.5
		});
		const body = new THREE.Mesh(bodyGeom, bodyMat);
		this.mesh.add(body);

		const noseLen = 0.35;
		const noseGeom = new THREE.ConeGeometry(radius, noseLen, 16);
		noseGeom.translate(0, bodyLen / 2 + noseLen / 2, 0);
		const noseMat = new THREE.MeshStandardMaterial({
			color: 0x333333,
			metalness: 0.8,
			roughness: 0.3
		});
		const nose = new THREE.Mesh(noseGeom, noseMat);
		this.mesh.add(nose);

		const bandGeom = new THREE.CylinderGeometry(radius + 0.001, radius + 0.001, 0.15, 16);
		bandGeom.translate(0, bodyLen / 2 - 0.4, 0);
		const bandMat = new THREE.MeshBasicMaterial({ color: 0xffcc00 });
		const band = new THREE.Mesh(bandGeom, bandMat);
		this.mesh.add(band);

		const finMat = new THREE.MeshStandardMaterial({ color: 0x444444, metalness: 0.3, roughness: 0.6 });

		const tailFinShape = new THREE.Shape();
		tailFinShape.moveTo(0, 0);
		tailFinShape.lineTo(0.4, -0.2);
		tailFinShape.lineTo(0.4, -0.5);
		tailFinShape.lineTo(0, -0.5);
		tailFinShape.lineTo(0, 0);

		const tailFinGeom = new THREE.ExtrudeGeometry(tailFinShape, { depth: 0.02, bevelEnabled: false });
		tailFinGeom.center();
		tailFinGeom.translate(0.2, -0.25, 0);

		const rearFinGeom = new THREE.BoxGeometry(0.35, 0.4, 0.02);
		rearFinGeom.translate(radius + 0.175, 0, 0);

		for (let i = 0; i < 4; i++) {
			const finGroup = new THREE.Group();
			const finMesh = new THREE.Mesh(rearFinGeom, finMat);
			finGroup.add(finMesh);

			finGroup.position.y = -bodyLen / 2 + 0.3;
			finGroup.rotation.y = i * (Math.PI / 2);


			this.mesh.add(finGroup);
		}

		const frontFinGeom = new THREE.BoxGeometry(0.2, 0.15, 0.015);
		frontFinGeom.translate(radius + 0.1, 0, 0);

		for (let i = 0; i < 4; i++) {
			const finGroup = new THREE.Group();
			const finMesh = new THREE.Mesh(frontFinGeom, finMat);
			finGroup.add(finMesh);
			finGroup.position.y = bodyLen / 2 - 0.6;
			finGroup.rotation.y = i * (Math.PI / 2);
			this.mesh.add(finGroup);
		}

		const flameColor = new THREE.Color(1.0, 0.6, 0.2);

		const flameGeom = new THREE.ConeGeometry(radius * 0.9, 1.0, 16, 1, true);
		flameGeom.rotateX(Math.PI);
		flameGeom.translate(0, -0.5, 0);

		const flameMat = new THREE.MeshBasicMaterial({
			color: flameColor,
			transparent: true,
			opacity: 0.8,
			side: THREE.DoubleSide,
			depthWrite: false,
			blending: THREE.AdditiveBlending
		});
		this.flameMesh = new THREE.Mesh(flameGeom, flameMat);
		this.flameMesh.position.y = -bodyLen / 2;
		this.mesh.add(this.flameMesh);

		const coreGeom = new THREE.ConeGeometry(radius * 0.5, 0.6, 16, 1, true);
		coreGeom.rotateX(Math.PI);
		coreGeom.translate(0, -0.3, 0);
		const coreMat = new THREE.MeshBasicMaterial({
			color: 0xffffff,
			transparent: true,
			opacity: 0.9,
			side: THREE.DoubleSide,
			depthWrite: false,
			blending: THREE.AdditiveBlending
		});
		this.flameCore = new THREE.Mesh(coreGeom, coreMat);
		this.flameMesh.add(this.flameCore);

		const canvSize = 128;
		const canv = (typeof document !== 'undefined') ? document.createElement('canvas') : null;
		let glowTexture = null;
		if (canv) {
			canv.width = canv.height = canvSize;
			const ctx = canv.getContext('2d');
			const cx = canvSize / 2;
			const cy = canvSize / 2;
			const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, cx);
			grad.addColorStop(0.0, 'rgba(255,255,255,1)');
			grad.addColorStop(0.18, 'rgba(255,245,200,1)');
			grad.addColorStop(0.38, 'rgba(255,160,30,0.95)');
			grad.addColorStop(0.62, 'rgba(220,60,10,0.6)');
			grad.addColorStop(1.0, 'rgba(0,0,0,0)');
			ctx.fillStyle = grad;
			ctx.fillRect(0, 0, canvSize, canvSize);
			glowTexture = new THREE.CanvasTexture(canv);
			glowTexture.minFilter = THREE.LinearFilter;
			glowTexture.magFilter = THREE.LinearFilter;
		}

		const spriteMat = new THREE.SpriteMaterial({
			map: glowTexture,
			color: new THREE.Color(1.0, 0.95, 0.9),
			transparent: true,
			opacity: 0.98,
			blending: THREE.AdditiveBlending,
			depthTest: false,
			depthWrite: false
		});
		this.flameGlow = new THREE.Sprite(spriteMat);
		this.flameGlow.scale.set(2.2, 2.2, 1.0);
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

		// Flame flicker during motor burn, decays after burnout.
		if (this.flameMesh) {
			if (this.boostRemaining > 0) {
				const f  = 0.8 + Math.random() * 0.4;
				const fl = 0.9 + Math.random() * 0.2;
				this.flameMesh.scale.set(f, fl, f);
				this.flameMesh.material.opacity = 0.7 + Math.random() * 0.3;
				if (this.flameCore) this.flameCore.scale.set(f, fl, f);
			} else {
				// Post-burnout: fade the glow away over a couple seconds.
				this.flameMesh.material.opacity *= Math.pow(0.5, dt / 0.8);
				if (this.flameCore) this.flameCore.material.opacity *= Math.pow(0.5, dt / 0.8);
			}
		}

		this.life -= dt;
		if (this.life <= 0) { this.destroy(); return; }

		// ---- Speed profile: boost → coast ---------------------------------
		if (this.boostRemaining > 0) {
			this.speed = Math.min(BOOST_PEAK_SPEED, this.speed + BOOST_ACCEL * dt);
			this.boostRemaining -= dt;
		} else {
			this.speed = Math.max(MIN_SPEED, this.speed - COAST_DRAG * dt);
		}

		// ---- Guidance -----------------------------------------------------
		if (this.target && !this.target.destroyed && !this.lostLock) {
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

		this.updateTrail(dt);
		this.updateThreeMatrix();

		// Swept-segment hit check against every possible target (player +
		// NPCs). Self-skip and friendly-fire are explicit so this works
		// for both player-fired and NPC-fired missiles.
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

		// Proximity-fuze closest-approach detection against the tracked
		// target. Fires when range has stopped decreasing and we're inside
		// the fuze envelope — catches the high-speed fly-by misses that the
		// strict swept-segment check above rejects by a few metres. Without
		// this an all-aspect AIM-9X effectively degrades to a tail chaser,
		// which isn't right.
		if (this.target && !this.target.destroyed) {
			const dSq = this.calculateDistSqToNPC(this.target);
			if (dSq < FUZE_SENSE_RADIUS_SQ &&
				this._prevTargetDistSq !== undefined &&
				dSq > this._prevTargetDistSq) {
				this.hitNPC(this.target);
				return;
			}
			this._prevTargetDistSq = dSq < FUZE_SENSE_RADIUS_SQ ? dSq : undefined;
		} else {
			this._prevTargetDistSq = undefined;
		}

		this.checkTerrainCollision();
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

	// Proportional navigation with lead pursuit and G-limited turn cap.
	// Mirrors the AIM-120's guidance with tighter terminal behavior.
	_guide(dt) {
		const myPos     = Cesium.Cartesian3.fromDegrees(this.lon, this.lat, this.alt);
		const targetPos = Cesium.Cartesian3.fromDegrees(this.target.lon, this.target.lat, this.target.alt);

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
		if (cosAng < SEEKER_COS_MIN) {
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

		// G-limited turn cap: ω_max = (G · g) / V. At 860 m/s this is ~27°/s
		// (40 G head-on is hard!), dropping to ~75°/s at 300 m/s coast. This
		// is what makes high-speed crossing shots difficult and tail-chase
		// shots cheap — same asymmetry real BVR/WVR gunners feel.
		const maxTurnRadPerS = (MAX_G * 9.81) / Math.max(50, this.speed);
		const capDeg         = Cesium.Math.toDegrees(maxTurnRadPerS) * dt;

		this.heading += Math.max(-capDeg, Math.min(capDeg, dH * PN_GAIN * dt));
		this.pitch   += Math.max(-capDeg, Math.min(capDeg, dP * PN_GAIN * dt));
		this.pitch   = Math.max(-85, Math.min(85, this.pitch));

		this.debug = {
			rangeToTarget: range,
			desiredHeading, desiredPitch,
			headingError: dH, pitchError: dP,
			tgo, cosAngleToNose: cosAng,
			turnCapDegPerS: Cesium.Math.toDegrees(maxTurnRadPerS),
			targetName: this.target.name || 'TGT',
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
				const spawnPos = movePosition(this.lon, this.lat, this.alt, this.heading, this.pitch, -backDist);

				this.distanceSinceLastTrail -= spawnInterval;

				const smokeGeom = new THREE.SphereGeometry(1.0, 16, 16);
				const gray = 0.5 + Math.random() * 0.75;
				const smokeMat = new THREE.MeshBasicMaterial({
					color: new THREE.Color(gray, gray, gray),
					transparent: true,
					opacity: 0.6 + Math.random() * 0.25
				});
				const smoke = new THREE.Mesh(smokeGeom, smokeMat);
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
			const scale = launchScale * t.randomScale * (1.0 + (1.0 - t.life / t.maxLife) * 15.0);
			t.scale.set(scale, scale, scale);

			const opacity = (t.life / t.maxLife) * 0.5;
			t.material.opacity = opacity;

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

		if (this.flameGlow && this.viewer && this.viewer.camera && this.viewer.camera.position) {
			try {
				const camPos = this.viewer.camera.position;
				const dist = Cesium.Cartesian3.distance(pos, camPos) || 1.0;
				const s = THREE.MathUtils.clamp(dist * 0.0016, 1.0, 80.0);
				this.flameGlow.scale.set(s, s, 1.0);
				this.flameGlow.renderOrder = 9999;
				if (this.flameGlow.material) this.flameGlow.material.opacity = Math.max(0.25, Math.min(1.0, 80.0 / s));
			} catch (e) { }
		}
	}

	calculateDistSqToNPC(npc) {
		const dLon = (npc.lon - this.lon) * 111320 * Math.cos(Cesium.Math.toRadians(this.lat));
		const dLat = (npc.lat - this.lat) * 111320;
		const dAlt = npc.alt - this.alt;
		return dLon * dLon + dLat * dLat + dAlt * dAlt;
	}

	hitNPC(npc) {
		npc.destroyed = true;
		if (this.onKill) this.onKill(npc);
		try {
			particles.spawnExplosion(this.lon, this.lat, this.alt, { count: 80, smokeCount: 18, big: true });
			particles.spawnWreckage(this.lon, this.lat, this.alt, this.heading, this.pitch, { count: 48 });
			soundManager.play('explosion-random');
		} catch (e) { }
		this.destroy();
	}

	checkTerrainCollision() {
		const cartographic = Cesium.Cartographic.fromDegrees(this.lon, this.lat);
		const terrainHeight = this.viewer.scene.globe.getHeight(cartographic);
		if (terrainHeight !== undefined && this.alt < terrainHeight) {
			try {
				particles.spawnExplosion(this.lon, this.lat, this.alt, { count: 80, smokeCount: 18, big: true });
				particles.spawnWreckage(this.lon, this.lat, this.alt, this.heading, this.pitch, { count: 48 });
				soundManager.play('explosion-random');
			} catch (e) { }
			this.destroy();
		}
	}

	destroy() {
		this.active = false;
		if (this.mesh) {
			this.scene.remove(this.mesh);
		}
	}
}
