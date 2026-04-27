import * as THREE from 'three';
import * as Cesium from 'cesium';
import { movePosition } from '../utils/math';
import { particles } from '../utils/particles';
import { soundManager } from '../utils/soundManager';
import { SIGNATURES, irAspectFactor, aspectAngleFromVectors } from '../systems/signatures';
import { getActiveFlares } from './flare.js';
import { airDensity, GRAVITY } from '../plane/aeroModel.js';
import { cloneAim9Template, cloneMissileTemplate } from './missileModels.js';
import { pushKill } from '../systems/eventLog.js';

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

// Hard-coded fallback defaults — used ONLY when the ctor is called
// without a data object (legacy callers). All of these are now driven
// per-munition from src/data/munitions/*.json via the data object.
// Keeping the defaults here so this file stays functional standalone
// (tests, experiments) without needing to scaffold the JSON loader.
const DEFAULT_AIM9_DATA = {
	flight: {
		launchSpeedOffset: 40,
		boostDurationS: 3.5,
		boostAccel: 210,
		peakSpeed: 860,
		minSpeed: 60,
		maxLifeS: 40,
		maxTurnDegPerSec: 60,
		pnGain: 4.0,
		dragRef: 22,
		dragRefSpeed: 700,
		dragRefAltitude: 5000,
	},
	warhead: {
		killRadiusM: 10,
		fuzeSenseRadiusM: 20,
	},
	seeker: {
		coneHalfAngleDeg: 90,
		maxG: 40,
	},
	signature: 'missile_ir',
	simType: 'AIM-9',
};

export class Missile {
	constructor(scene, viewer, startPos, heading, pitch, speed, target = null, onKill = null, launcher = null, data = null) {
		// Data-driven configuration. Every tunable parameter lives on
		// the `data` object (loaded from src/data/munitions/*.json via
		// munitionFactory). Default falls back to hardcoded AIM-9X so
		// callers that don't pass data stay functional.
		this.data = data || DEFAULT_AIM9_DATA;
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
		// Launch-rail ejection bump; motor does the real work during boost.
		this.speed = speed + (d.flight.launchSpeedOffset ?? 40);

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
		// Signature for sensor system. Pull from SIGNATURES by name
		// stored in JSON.
		this.signature = SIGNATURES[d.signature] || MISSILE_IR_SIGNATURE;

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

		// Pick the GLB template: data.modelTemplate (e.g. 'agm-88',
		// 'meteor') wins, AIM-9 fallback otherwise. The procedural body
		// is the second-fall fallback for first-frame-after-boot shots
		// before the GLB has downloaded.
		const d = this.data || {};
		const templated = d.modelTemplate
			? cloneMissileTemplate(d.modelTemplate)
			: cloneAim9Template();
		const bodyLen = templated ? (d.realLengthM ?? 3.02) : 2.6;
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
		const hasMotor = !d.flight || (d.flight.boostDurationS ?? 0) > 0;
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
		const flameColor = new THREE.Color(1.0, 0.6, 0.2);
		const flameGeom = new THREE.ConeGeometry(radius * 0.9, flameLen, 16, 1, true);
		flameGeom.rotateX(Math.PI);
		flameGeom.translate(0, -flameLen / 2, 0);
		const flameMat = new THREE.MeshBasicMaterial({
			color: flameColor, transparent: true, opacity: 0.8, side: THREE.DoubleSide,
			depthWrite: false, blending: THREE.AdditiveBlending,
		});
		this.flameMesh = new THREE.Mesh(flameGeom, flameMat);
		this.flameMesh.position.y = -bodyLen / 2;
		this.mesh.add(this.flameMesh);

		const coreLen = flameLen * 0.6;
		const coreGeom = new THREE.ConeGeometry(radius * 0.5, coreLen, 16, 1, true);
		coreGeom.rotateX(Math.PI);
		coreGeom.translate(0, -coreLen / 2, 0);
		const coreMat = new THREE.MeshBasicMaterial({
			color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
			depthWrite: false, blending: THREE.AdditiveBlending,
		});
		this.flameCore = new THREE.Mesh(coreGeom, coreMat);
		this.flameMesh.add(this.flameCore);

		// Exhaust glow sprite — radial-gradient canvas texture, additive-
		// blended. Always-on-top (depthTest: false) so it punches through
		// fog / cloud without weird sorting artefacts.
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
		this.flameGlow.scale.set(glowScale, glowScale, 1.0);
		this.flameGlow.position.y = -bodyLen / 2 - 0.08;
		this.mesh.add(this.flameGlow);
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
		// Laser-guided seekers (GBU-12 etc.) intentionally have no
		// `target` — they home on the player's lased ground spot, which
		// the seeker reads from playerDesignation each frame. Skipping
		// _guide for them would leave the bomb falling ballistic.
		const isLaser = this.data && this.data.seekerType === 'laser';
		if (!this.lostLock && (isLaser || (this.target && !this.target.destroyed))) {
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
		const killRadiusSq = this.data.warhead.killRadiusM * this.data.warhead.killRadiusM;
		const fuzeRadiusSq = this.data.warhead.fuzeSenseRadiusM * this.data.warhead.fuzeSenseRadiusM;

		if (npcs) {
			for (const npc of npcs) {
				if (!npc || npc === this.launcher) continue;
				if (npc.destroyed) continue;
				if (npc.team && this.team && npc.team === this.team) continue;
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
		const coneDeg = this.data.seeker?.coneHalfAngleDeg ?? 90;
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
		const maxG    = this.data.seeker?.maxG  ?? 40;
		const pnGain  = this.data.flight?.pnGain ?? 4.0;
		const vRef    = this.data.flight?.vManeuverRef ?? 500;
		const gFloor  = this.data.flight?.gAvailFloor ?? 0.05;
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

		const seeker = this.data.seeker || {};
		const coneHalfRad   = (seeker.coneHalfAngleDeg ?? 30) * Math.PI / 180;
		const trackRange    =  seeker.trackRangeM       ?? 12000;
		const aspectEnabled =  seeker.aspectIrEnabled   !== false;
		const flareResist   =  seeker.flareResistance   ?? 0.3;

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
