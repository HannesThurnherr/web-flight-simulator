import * as Cesium from 'cesium';
import {
	rcsAspectFactor, irAspectFactor, visualAspectFactor,
	aspectAngleFromVectors,
} from './signatures.js';

// ============================================================================
// Sensor system — three independent detection channels wired through a shared
// `contacts` store on each observer. Every frame each observer that has a
// sensor suite scans all other units, and each successful detection
// populates (or refreshes) one channel of a contact record. Observers read
// `unit.contacts` for their sensor picture; `unit.rwr` is the separate
// list of who is currently radiating at them (populated as a side effect of
// another observer's radar scan succeeding against them).
//
// Why three channels instead of one "omniscient" sensor:
//   - Radar gives range + velocity but announces you to the target.
//   - IR is passive and stealth-resistant, but has no direct range and is
//     strongly aspect-sensitive (rear hot, head-on cold).
//   - Visual is short-range but neutral to radar cross-section — the only
//     reliable way to see a stealth jet close-in.
//
// Missiles, cruise missiles, AWACS, cargo, stealth fighters all end up with
// characteristic detection profiles just by varying their signature bundle;
// the scan code stays the same.
// ============================================================================

// ---- Sensor defaults -------------------------------------------------------

// A fighter's radar: big BVR search-and-track, ±60° gimbal, detects a
// reference 5 m² fighter out to ~150 km. Detection range scales with the
// fourth root of RCS (radar equation), so AWACS-class targets light up at
// ~350 km and a 0.05 m² stealth fighter at ~50 km.
export const FIGHTER_RADAR_DEFAULT = {
	enabled: true,
	active: true,
	mode: 'search',         // 'search' | 'track' | 'off'
	nominalRange: 150000,   // m, at referenceRcs
	referenceRcs: 5,        // m²
	fovH: Math.PI / 3,      // ±60° azimuth
	fovV: Math.PI / 3,      // ±60° elevation
};

// Passive IR search-and-track. Rear-aspect detection of a reference
// fighter-class heat signature out to ~40 km. Because detection range
// scales with √heat, a missile (IR 500) is still strong close-in and a
// stealth fighter (cooler exhaust) is weaker than a standard fighter.
export const FIGHTER_IRST_DEFAULT = {
	enabled: true,
	nominalRange: 40000,
	referenceIr: 200,
	fov: Math.PI / 2,       // ±45° forward cone
};

// Visual is omnidirectional from a bubble canopy, limited by apparent
// angular size. A 19 m fighter at 12 km subtends ~0.0016 rad — close to
// the "just visible" threshold for the Mk-I eyeball in good conditions.
export const FIGHTER_EYEBALL_DEFAULT = {
	enabled: true,
	nominalRange: 12000,
	referenceVisualSize: 19,
	fov: 2 * Math.PI,       // 360° — pilot can turn head
};

// ---- Contact/RWR lifetimes -------------------------------------------------

// How long (seconds) channel observations persist before being considered
// stale. Radar drops fast because it's an active re-paint; IR persists a
// bit because the seeker tracks continuously; visual fades slowest because
// the pilot naturally keeps eyes on a contact.
const RADAR_CHANNEL_MEMORY  = 2.0;
const IR_CHANNEL_MEMORY     = 2.0;
const VISUAL_CHANNEL_MEMORY = 5.0;
const RWR_MEMORY            = 3.0;

// ---- Terrain occlusion ------------------------------------------------------
//
// Every channel obeys line-of-sight — radar, IR and visual alike are all
// stopped by a ridge in between. We inject the Cesium scene from main.js
// after the viewer is alive (init order is awkward for the ES-module
// import graph otherwise). If the scene hasn't been registered yet every
// check just passes, so tests and headless runs aren't blocked.
let _sensorScene = null;
export function setSensorScene(scene) { _sensorScene = scene; }

const _rayScratch   = { origin: new Cesium.Cartesian3(), direction: new Cesium.Cartesian3() };
const _dirScratch   = new Cesium.Cartesian3();

function isTerrainBlocked(fromCart, toCart) {
	if (!_sensorScene || !_sensorScene.globe) return false;
	Cesium.Cartesian3.subtract(toCart, fromCart, _dirScratch);
	const len = Cesium.Cartesian3.magnitude(_dirScratch);
	if (len < 1) return false;
	Cesium.Cartesian3.divideByScalar(_dirScratch, len, _dirScratch);
	Cesium.Cartesian3.clone(fromCart, _rayScratch.origin);
	Cesium.Cartesian3.clone(_dirScratch, _rayScratch.direction);
	const hit = _sensorScene.globe.pick(_rayScratch, _sensorScene);
	if (!hit) return false;
	const hitDist = Cesium.Cartesian3.distance(fromCart, hit);
	// Small epsilon so targets sitting right on the deck don't flag.
	return hitDist < len - 5;
}

// ---- Helpers ---------------------------------------------------------------

// Build a unit's forward-pointing velocity direction from its heading/pitch.
// Returns a plain {x,y,z} unit vector in local ENU (east, north, up).
// NPCs and missiles don't keep a full velocity vector; they carry heading +
// speed, so we derive the direction here on demand.
export function unitForwardENU(unit) {
	const h = Cesium.Math.toRadians(unit.heading || 0);
	const p = Cesium.Math.toRadians(unit.pitch   || 0);
	return {
		x: Math.sin(h) * Math.cos(p),
		y: Math.cos(h) * Math.cos(p),
		z: Math.sin(p),
	};
}

// Convert ECEF LOS to the observer's local ENU frame and also the
// observer's body frame (so we can check FOV cones and compute bearing
// relative to the observer's nose). Returns { losENU, losLenMeters, losLen,
// bearingBody, elevationBody }.
//
// bearingBody    radians, positive = right of nose
// elevationBody  radians, positive = above horizon
function losObserverToTarget(observer, target) {
	const obsECEF = Cesium.Cartesian3.fromDegrees(observer.lon, observer.lat, observer.alt);
	const tgtECEF = Cesium.Cartesian3.fromDegrees(target.lon,   target.lat,   target.alt);
	const losECEF = Cesium.Cartesian3.subtract(tgtECEF, obsECEF, new Cesium.Cartesian3());
	const enu = Cesium.Transforms.eastNorthUpToFixedFrame(obsECEF);
	const invEnu = Cesium.Matrix4.inverse(enu, new Cesium.Matrix4());
	const losENU = Cesium.Matrix4.multiplyByPointAsVector(invEnu, losECEF, new Cesium.Cartesian3());
	const len = Cesium.Cartesian3.magnitude(losENU);

	// Build the observer's body frame axes from its heading/pitch. Body
	// forward = unitForwardENU; body up is world-up rotated by pitch; body
	// right is forward × up. That's enough to express LOS in body-relative
	// azimuth/elevation.
	const fwd = unitForwardENU(observer);
	// Simple right-vector: perpendicular to forward in the horizontal plane.
	// At zero pitch this is exact; at non-zero pitch we lose the tiny body
	// roll component, which doesn't matter for detection logic.
	const rightLen = Math.hypot(fwd.x, fwd.y) || 1;
	const right = { x: fwd.y / rightLen, y: -fwd.x / rightLen, z: 0 };
	// Up = right × forward.
	const up = {
		x: right.y * fwd.z - right.z * fwd.y,
		y: right.z * fwd.x - right.x * fwd.z,
		z: right.x * fwd.y - right.y * fwd.x,
	};

	// Normalized LOS for dot products.
	const inv = len > 1e-6 ? 1 / len : 0;
	const losHat = { x: losENU.x * inv, y: losENU.y * inv, z: losENU.z * inv };

	const dotForward = losHat.x * fwd.x + losHat.y * fwd.y + losHat.z * fwd.z;
	const dotRight   = losHat.x * right.x + losHat.y * right.y + losHat.z * right.z;
	const dotUp      = losHat.x * up.x + losHat.y * up.y + losHat.z * up.z;

	// Azimuth/elevation relative to the nose, using the +forward/+right/+up
	// body frame.
	const bearingBody   = Math.atan2(dotRight, dotForward);
	const elevationBody = Math.atan2(dotUp, Math.hypot(dotForward, dotRight));

	return {
		losENU, losHat,
		losLenMeters: len,
		bearingBody,
		elevationBody,
		// Forward dot — negative means target is behind observer.
		dotForward,
		// Expose body-axis directions (used later for FOV checks in custom frames).
		forward: fwd,
		// ECEF positions so the caller can run the terrain raycast without
		// recomputing them.
		obsECEF,
		tgtECEF,
	};
}

// Get or create the contacts map on an observer, keyed on target reference.
function ensureContacts(observer) {
	if (!observer.contacts) observer.contacts = new Map();
	return observer.contacts;
}
function ensureRwr(observer) {
	if (!observer.rwr) observer.rwr = new Map();
	return observer.rwr;
}

function touchContact(contacts, target) {
	let c = contacts.get(target);
	if (!c) {
		c = { target, radar: null, ir: null, visual: null, fused: null };
		contacts.set(target, c);
	}
	return c;
}

// ---- Debug toggles ---------------------------------------------------------
//
// Global kill switch for the pulse-Doppler notch filter across every radar
// in the sim (plane sets, missile seekers, future SAMs). Flip to `false`
// to A/B test whether notch is the cause of a tracking bug without having
// to remove it from every config independently. All three stages of the
// missile engagement (launcher acquisition, seeker acquisition, seeker
// tracking) read from the same detectRadar() path, so this flag catches
// them all at once. Leave `true` for normal play — notching is a core
// sensor mechanic, not a cosmetic one.
export const NOTCH_ENABLED = true;

// ---- Unified radar detection -----------------------------------------------
//
// Single source of truth for "does radar X on observer O detect target T?".
// Every radar — fighter APG, AMRAAM seeker, future SAM/AWACS — calls this.
// Only the radar *configuration* varies (range, FOV, reference RCS, notch
// threshold); the mechanics (FOV cone, radar equation, aspect-modulated
// RCS, terrain LOS, pulse-Doppler notch) are the same everywhere.
//
// radar shape:
//   { enabled, active, mode,            // on/off + 'search'|'track'|'off'
//     nominalRange, referenceRcs,       // radar equation params
//     fovH, fovV,                       // half-angles in radians
//     notchThreshold }                  // m/s, defaults to 90 if absent
//
// Returns a detection descriptor, or null if any stage rejects the target.
// The descriptor carries all the intermediate geometry so callers can
// populate contact/RWR records without redoing the LOS math.
export function detectRadar(observer, target, radar) {
	if (!radar || !radar.enabled || !radar.active) return null;
	const sig = target && target.signature;
	if (!sig) return null;

	const los = losObserverToTarget(observer, target);
	if (los.losLenMeters < 1) return null;

	// 1) FOV (rectangular cone — separate az/el like a real mech-scan set).
	if (Math.abs(los.bearingBody)   > radar.fovH) return null;
	if (Math.abs(los.elevationBody) > radar.fovV) return null;

	// 2) Aspect-modulated RCS. Nose-on/tail-on different from beam.
	const tgtFwd = unitForwardENU(target);
	const aspect = aspectAngleFromVectors(los.losHat, tgtFwd);
	const effRcs = sig.rcs * rcsAspectFactor(aspect);

	// 3) 4th-root radar equation: detection range scales with RCS^0.25.
	const ratio = effRcs / radar.referenceRcs;
	const rangeLimit = radar.nominalRange * Math.pow(Math.max(1e-6, ratio), 0.25);
	if (los.losLenMeters > rangeLimit) return null;

	// 4) Terrain LOS — a ridge in the way kills the return.
	if (isTerrainBlocked(los.obsECEF, los.tgtECEF)) return null;

	// 5) Pulse-Doppler main-lobe clutter notch.
	//
	// After the radar compensates for its own motion ("main-lobe clutter
	// cancellation"), ground clutter sits at ~0 Doppler. The target's
	// residual Doppler reduces to −v_tgt·losHat — *only the target's own
	// velocity along the LOS matters*, the observer's velocity drops out.
	// A target flying perpendicular to the LOS (beaming) has v_tgt·losHat
	// ≈ 0, matches ground clutter, and gets filtered. This is why
	// "beam the radar" is the BVR defensive move.
	const tgtSpeed = target.speed || 0;
	const tgtLosCos =
		tgtFwd.x * los.losHat.x + tgtFwd.y * los.losHat.y + tgtFwd.z * los.losHat.z;
	const tgtLosSpeed = Math.abs(tgtLosCos) * tgtSpeed;
	const notchThreshold = (radar.notchThreshold != null) ? radar.notchThreshold : 90;
	if (NOTCH_ENABLED && tgtLosSpeed < notchThreshold) return null;

	// Signal strength 0..1, cheap proxy for return-power margin. Used for
	// RWR strength and for the lock-integrity hysteresis in seekers.
	const signal = Math.min(1, Math.pow(rangeLimit / los.losLenMeters, 4) * 0.01);

	return {
		bearingBody: los.bearingBody,
		elevationBody: los.elevationBody,
		range: los.losLenMeters,
		losHat: los.losHat,
		obsECEF: los.obsECEF,
		tgtECEF: los.tgtECEF,
		aspect,
		effRcs,
		rangeLimit,
		tgtLosSpeed,
		signal,
	};
}

// ---- Channel scans ---------------------------------------------------------

// Observer-level radar scan. Thin wrapper around detectRadar that also
// writes the contact record and the target's RWR entry. Returns true on
// detection (matches the previous API so the updateSensors loop is
// unchanged).
function scanRadar(observer, target, now) {
	const s = observer.sensors && observer.sensors.radar;
	const det = detectRadar(observer, target, s);
	if (!det) return false;

	// Velocity estimate: radar gives closing rate via Doppler; we expose
	// the full 3D velocity because we have ground truth and downstream
	// consumers (datalink, HUD) want it.
	const vel = unitForwardENU(target);
	const spd = target.speed || 0;

	const contact = touchContact(observer.contacts, target);
	contact.radar = {
		bearing: det.bearingBody,
		elevation: det.elevationBody,
		range: det.range,
		rangeRate: null, // filled in by fuse step (needs previous frame)
		velocity: { x: vel.x * spd, y: vel.y * spd, z: vel.z * spd },
		rcs: det.effRcs,
		signal: det.signal,
		lastSeen: now,
	};

	// RWR on the target: "observer is painting me". Bearing is relative to
	// the target's own body, not the observer's.
	const reverseLos = losObserverToTarget(target, observer);
	const rwr = ensureRwr(target);
	rwr.set(observer, {
		source: observer,
		bearing: reverseLos.bearingBody,
		elevation: reverseLos.elevationBody,
		strength: det.signal,
		lockType: s.mode === 'track' ? 'track' : 'search',
		lastSeen: now,
	});

	return true;
}

function scanIR(observer, target, now) {
	const s = observer.sensors && observer.sensors.ir;
	if (!s || !s.enabled) return false;
	const sig = target.signature;
	if (!sig) return false;

	const los = losObserverToTarget(observer, target);
	if (los.losLenMeters < 1) return false;

	// Modern fighters combine an IRST (narrow forward cone, used for
	// general air-to-air scan) with an all-aspect MAWS that specifically
	// looks for missile exhaust signatures regardless of aspect. We model
	// both with one sensor: the FOV limit only applies to non-missile
	// targets. That way an NPC detects an incoming missile even from the
	// 6 o'clock, but doesn't cheat by seeing fighters all around it.
	const isMissileClass = sig.unitClass === 'missile' || sig.unitClass === 'cruise_missile';
	if (!isMissileClass) {
		const angleFromNose = Math.hypot(los.bearingBody, los.elevationBody);
		if (angleFromNose > s.fov) return false;
	}

	const tgtFwd = unitForwardENU(target);
	const aspect = aspectAngleFromVectors(los.losHat, tgtFwd);
	const effIr = sig.irEmission * irAspectFactor(aspect);

	// Square-root law: IR falls with the square of distance (emission on a
	// sphere), so detection range scales with √emission.
	const ratio = effIr / s.referenceIr;
	const rangeLimit = s.nominalRange * Math.sqrt(Math.max(1e-6, ratio));
	if (los.losLenMeters > rangeLimit) return false;

	if (isTerrainBlocked(los.obsECEF, los.tgtECEF)) return false;

	const signal = Math.min(1, Math.pow(rangeLimit / los.losLenMeters, 2) * 0.01);

	const contact = touchContact(observer.contacts, target);
	contact.ir = {
		bearing: los.bearingBody,
		elevation: los.elevationBody,
		heatSig: effIr,
		signal,
		// No range directly — IR is a passive bearing-only channel.
		lastSeen: now,
	};
	return true;
}

function scanVisual(observer, target, now) {
	const s = observer.sensors && observer.sensors.eyeball;
	if (!s || !s.enabled) return false;
	const sig = target.signature;
	if (!sig) return false;

	const los = losObserverToTarget(observer, target);
	if (los.losLenMeters < 1) return false;

	// Visual is omnidirectional for a bubble canopy — angle check is just
	// a sanity filter.
	const angleFromNose = Math.hypot(los.bearingBody, los.elevationBody);
	if (angleFromNose > s.fov) return false;

	const tgtFwd = unitForwardENU(target);
	const aspect = aspectAngleFromVectors(los.losHat, tgtFwd);
	const effSize = sig.visualSize * visualAspectFactor(aspect);

	// Detection range scales linearly with visual size (apparent angular
	// size is size / range). referenceVisualSize is the default fighter.
	const ratio = effSize / s.referenceVisualSize;
	const rangeLimit = s.nominalRange * Math.max(0, ratio);
	if (los.losLenMeters > rangeLimit) return false;

	if (isTerrainBlocked(los.obsECEF, los.tgtECEF)) return false;

	const contact = touchContact(observer.contacts, target);
	contact.visual = {
		bearing: los.bearingBody,
		elevation: los.elevationBody,
		apparentSize: sig.visualSize / los.losLenMeters, // radians
		classHint: sig.unitClass,
		lastSeen: now,
	};
	return true;
}

// ---- Public entry point ----------------------------------------------------

// Runs one frame of sensing across every (observer, candidate) pair where
// observer has a sensor suite. Bidirectional: each unit scans every other
// unit (O(N²), fine for N = a few dozen).
//
// Call once per game tick, after physics. `units` is the array of every
// sensable thing (player, NPCs, missiles). `now` is a monotonic sim-time
// scalar — same convention as commanderView uses.
export function updateSensors(units, now, dt) {
	// Scan step.
	for (const observer of units) {
		if (!observer || !observer.sensors) continue;
		for (const target of units) {
			if (!target || target === observer) continue;
			if (target.destroyed || target.active === false) continue;
			scanRadar (observer, target, now);
			scanIR    (observer, target, now);
			scanVisual(observer, target, now);
		}
	}

	// Age / prune step. Stale channel entries expire on their own memory
	// interval; a contact with no live channel left is dropped entirely.
	for (const observer of units) {
		if (!observer) continue;
		if (observer.contacts) {
			for (const [target, c] of observer.contacts) {
				if (c.radar  && now - c.radar.lastSeen  > RADAR_CHANNEL_MEMORY)  c.radar  = null;
				if (c.ir     && now - c.ir.lastSeen     > IR_CHANNEL_MEMORY)     c.ir     = null;
				if (c.visual && now - c.visual.lastSeen > VISUAL_CHANNEL_MEMORY) c.visual = null;
				const dead = !c.radar && !c.ir && !c.visual;
				const gone = target.destroyed || target.active === false;
				if (dead || gone) observer.contacts.delete(target);
				else _fuseContact(c);
			}
		}
		if (observer.rwr) {
			for (const [src, r] of observer.rwr) {
				if (now - r.lastSeen > RWR_MEMORY || src.destroyed || src.active === false) {
					observer.rwr.delete(src);
				}
			}
		}
	}
}

// Fuse the three channels into a single best-guess summary: best bearing,
// best range estimate, and the strongest class hint. Missile AI and HUD
// code should prefer `fused` over raw channels, falling back only when a
// channel-specific field is needed.
function _fuseContact(c) {
	const channels = [c.radar, c.ir, c.visual].filter(Boolean);
	if (channels.length === 0) { c.fused = null; return; }

	// Bearing: radar > IR > visual (radar is most accurate).
	const best = c.radar || c.ir || c.visual;
	const range = c.radar ? c.radar.range : null;
	const classHint = (c.visual && c.visual.classHint) ||
		(c.target.signature && c.target.signature.unitClass) || null;
	const confidence =
		(c.radar  ? 0.6 : 0) +
		(c.ir     ? 0.2 : 0) +
		(c.visual ? 0.2 : 0);
	c.fused = {
		bearing:   best.bearing,
		elevation: best.elevation,
		range,                  // null when only passive channels have painted this
		classHint,
		confidence,
	};
}
