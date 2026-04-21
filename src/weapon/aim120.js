import * as THREE from 'three';
import * as Cesium from 'cesium';
import { movePosition } from '../utils/math';
import { particles } from '../utils/particles';
import { soundManager } from '../utils/soundManager';
import { Missile } from './missile';
import { SIGNATURES } from '../systems/signatures';
import { detectRadar } from '../systems/sensorSystem';
import { airDensity, GRAVITY } from '../plane/aeroModel.js';
import { getTeamDatalink } from '../systems/teamDatalink.js';

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
// Drag reference point — the prior constant 8 m/s² was roughly the
// deceleration a burnout-speed AMRAAM sees at 10 km altitude. We now
// scale it by atmospheric density (altitude) and v² so the drag profile
// matches real physics: very high at sea level, much lower at apogee.
// That's what makes high-loft coasts actually extend range.
const COAST_DRAG_REF      = 8;       // m/s², reference drag at 10 km / 1000 m/s
const COAST_DRAG_REF_V    = 1000;    // m/s reference speed for v² scaling
const MIN_SPEED           = 60;      // m/s absolute floor — below this treat as ballistic
const MAX_LIFE            = 120;     // s, time of flight before self-destruct
const MAX_TURN_DEG_PER_S  = 40;      // sustained turn rate cap (structural+AoA)
const PN_GAIN             = 4.0;     // proportional navigation N (typ. 3–5)
const SEEKER_ACTIVE_RANGE = 18000;   // m, terminal "pitbull" range
// Loft profile. Real AMRAAMs fly a high-altitude coast: climb hard during
// boost, cruise at 15–25 km (thin air = low drag = more range), then dive
// steeply onto the target in terminal. The loft term adds extra pitch-up
// on top of the direct-to-target pitch, scaled by distance: full at long
// range, zero at TERMINAL_RANGE. Because the loft is *always on* (not
// gated on boost), the missile continues to climb / hold altitude during
// coast as long as it's far from the target — and because it tapers to
// zero inside TERMINAL_RANGE, the descent is dictated by the actual
// geometry (high missile + low target = steep dive naturally, no
// explicit dive-angle command needed).
const TERMINAL_RANGE       = 15000;    // m, below which loft is off
const MAX_LOFT_RANGE       = 70000;    // m, above which loft saturates
const MAX_LOFT_DEG         = 25;       // deg of extra pitch at long range
// Kill envelope — AMRAAM has a bigger warhead than AIM-9X and proportionally
// wider lethal radius + fuze sensing. Miss distance < 15 m is a direct
// warhead kill; up to ~30 m the proximity fuze still detonates when the
// range rate flips from closing to opening (the "we just passed them" cue).
const KILL_RADIUS         = 15;
const KILL_RADIUS_SQ      = KILL_RADIUS * KILL_RADIUS;
const FUZE_SENSE_RADIUS   = 30;
const FUZE_SENSE_RADIUS_SQ = FUZE_SENSE_RADIUS * FUZE_SENSE_RADIUS;
// Seeker parameters for the missile's own onboard radar, active after
// pitbull. Narrower FOV + shorter range than a fighter's APG-class set,
// since the AMRAAM seeker is small and optimized for terminal homing.
// Expressed as a radar-config object so it plugs into the unified
// sensorSystem.detectRadar() function — same FOV / range-equation / notch
// mechanics as a plane's radar, just with seeker-scale numbers. Adding a
// ground SAM, an AWACS, or a helicopter pulse-Doppler later is the same
// pattern: pick range / FOV / referenceRcs and hand it to detectRadar.
const SEEKER_RANGE_M      = 25000;              // m
// Real AMRAAM seekers have ~±30° mechanical/electronic scan, and during
// terminal homing the gimbal is already at the high end of its travel.
// Using 30° instead of the old 25° gives a narrow but not pathological
// terminal window — last-ditch maneuvers can still break lock, but not
// through trivial 15° aspect changes.
const SEEKER_HALF_ANGLE   = 30 * Math.PI / 180; // ±30° forward cone
// Acquisition config — used during the initial pitbull scan. The seeker
// is searching a cone for any Doppler-bright target, so the notch filter
// applies the same way it does on a plane's search radar. The gate is
// tighter (30 m/s) because seeker heads run higher PRF.
const SEEKER_RADAR = {
	enabled: true,
	active: true,
	mode: 'track',
	nominalRange:  SEEKER_RANGE_M,
	referenceRcs:  5,             // reference 5 m² fighter
	fovH:          SEEKER_HALF_ANGLE,
	fovV:          SEEKER_HALF_ANGLE,
	notchThreshold: 30,
};
// Tracking config — used once the seeker has a lock, by the per-frame
// lock-integrity check. Notch is much looser than acquisition (15 m/s
// vs 30) but NOT zero: a deliberate, sustained beam still breaks lock,
// which is what makes notching a real defensive option in terminal.
// The combination of a tight gate plus the 1.5 s LOCK_DROP_TIMEOUT
// means transient geometric nulls (LOS sweeping through perpendicular
// for a frame or two during a crossing intercept) don't drop the
// track, but a pure ±90° beam held for a full second does.
const SEEKER_RADAR_TRACK = {
	...SEEKER_RADAR,
	notchThreshold: 15,
};
// How long the seeker can fail to see its locked target before we flip to
// maddog. Real seekers drop lock in ~0.5–2 s of no return. 1.5 s gives a
// deliberate beam maneuver a chance to work while tolerating the frame or
// two where the LOS swings through a geometrically-unlucky angle.
const LOCK_DROP_TIMEOUT   = 1.5;
// How often (seconds) to retry _scanForLock after the seeker has gone
// maddog. Real AMRAAMs can reacquire after a brief loss; without this,
// every notch that lasts longer than LOCK_DROP_TIMEOUT turns into an
// unrecoverable failure even if the target comes right back out.
const REACQUIRE_INTERVAL  = 0.25;

// Missed-pass cutoff: once we've been within 2× the fuze envelope and the
// current range exceeds that, the pass is over. Set lostLock so guidance
// stops — real AMRAAMs do not loop around for a second attempt.
const MISS_ABORT_RADIUS_SQ = FUZE_SENSE_RADIUS_SQ * 4;

export class AIM120 extends Missile {
	// Exposed so debug overlays (e.g. commander view's radar-debug mode)
	// can draw the seeker's FOV cone without reaching into module-private
	// constants. Same config object the runtime detectRadar() calls use.
	static SEEKER_RADAR_DEBUG = SEEKER_RADAR;

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
				const k = Math.max(0, 1 - (BOOST_DURATION - this.boostRemaining + dt) / 2.0);
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
		if (this.boostRemaining > 0) {
			this.speed = Math.min(BOOST_PEAK_SPEED, this.speed + BOOST_ACCEL * dt);
			this.boostRemaining -= dt;
		} else {
			const rhoRef   = airDensity(10000);
			const rho      = airDensity(this.alt);
			const v2Ratio  = (this.speed * this.speed) / (COAST_DRAG_REF_V * COAST_DRAG_REF_V);
			const dragAcc  = COAST_DRAG_REF * (rho / Math.max(1e-6, rhoRef)) * v2Ratio;
			this.speed = Math.max(MIN_SPEED, this.speed - dragAcc * dt);
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
			this.speed = Math.max(MIN_SPEED, Math.hypot(vHoriz, vVert));
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
				if (rng < SEEKER_ACTIVE_RANGE) this._firePitbull(npcs);
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
			const det = detectRadar(observer, t, SEEKER_RADAR);
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

		const observer = this._seekerObserver();

		// Case A: we have a target — can we still see it?
		// Use the *tracking* radar config (notch off), not the acquisition
		// one. Once we have lock, inertial integration carries the seeker
		// through brief Doppler nulls; only hard-physical losses (out of
		// FOV, out of range, terrain-masked) should break track here.
		if (this.target && !this.target.destroyed && this.target.active !== false) {
			const det = detectRadar(observer, this.target, SEEKER_RADAR_TRACK);
			if (det) {
				this._lockLostTimer = 0;
				// Clear maddog if the target popped back into view.
				this.maddog = false;
				return;
			}
		}

		// Case B: target gone or undetected this frame. Accumulate timer.
		this._lockLostTimer = (this._lockLostTimer || 0) + dt;

		// Always try to reacquire periodically — both while the timer is
		// below LOCK_DROP_TIMEOUT (to snap back immediately if the
		// original comes out of the notch) and after we've gone maddog
		// (to recover from a sustained loss). The seeker preferring the
		// DL-track-closest candidate means we usually pick the original
		// bogey again.
		this._reacqTimer = (this._reacqTimer || 0) + dt;
		if (this._reacqTimer >= REACQUIRE_INTERVAL) {
			this._reacqTimer = 0;
			const picked = this._scanForLock(allTargets);
			if (picked) {
				this.target = picked;
				this._lockLostTimer = 0;
				this.maddog = false;
				return;
			}
		}

		// Still no detection and the drop timer has elapsed → maddog.
		// Guidance will fall through to DR on the last DL track; the
		// reacquire loop above keeps trying to climb back out.
		if (this._lockLostTimer >= LOCK_DROP_TIMEOUT && !this.maddog) {
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
		if (rangeToTarget > TERMINAL_RANGE) {
			const denom = Math.max(1, MAX_LOFT_RANGE - TERMINAL_RANGE);
			const loftRatio = Math.min(1, (rangeToTarget - TERMINAL_RANGE) / denom);
			desiredPitch += MAX_LOFT_DEG * loftRatio;
		}
		desiredPitch = THREE.MathUtils.clamp(desiredPitch, -85, 85);

		let dH = desiredHeading - this.heading;
		while (dH < -180) dH += 360;
		while (dH >  180) dH -= 360;
		const dP = desiredPitch - this.pitch;

		const cap = MAX_TURN_DEG_PER_S * dt;
		this.heading += THREE.MathUtils.clamp(dH * PN_GAIN * dt, -cap, cap);
		this.pitch   += THREE.MathUtils.clamp(dP * PN_GAIN * dt, -cap, cap);
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
