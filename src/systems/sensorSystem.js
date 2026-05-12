import * as Cesium from 'cesium';
import {
	rcsAspectFactor, irAspectFactor, visualAspectFactor,
	aspectAngleFromVectors,
} from './signatures.js';
import { identifyContact } from './iff.js';
import { setJammerRegistry, accumulateJamAttenuation } from './ew/jammerSubsystem.js';
import { gameSettings } from '../ui/settings.js';

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
	// Internal radar mode used by sensorSystem + RWR — written by the
	// per-frame mode-manager in simLoop. 'search' produces a TWS-class
	// RWR cue on victims; 'track' produces an STT-class spike. 'off'
	// suppresses emissions entirely (R-key emcon).
	mode: 'search',         // 'search' | 'track' | 'off'
	// 6b — player-facing radar mode. Independent from the internal
	// `mode` field above; this is what the player chooses via the T
	// keybind, and the simLoop mode-manager translates it into the
	// internal `mode` flag plus RWS-specific behavior (lock-progression
	// suppression).
	//   rws — Range While Scan. No firing-grade locks; AAMs can't fire.
	//   tws — Track While Scan. Locks progress; victim RWR sees TWS.
	//   stt — Single Target Track. Locks fast on designated only;
	//         victim RWR sees STT spike.
	playerMode: 'tws',
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

// ---- Multi-sample line-of-sight ---------------------------------------------
//
// The original implementation cast a single `globe.pick` ray. That works
// for short, near-vertical LOS but fails on the long, slanted geometry
// typical of BVR engagements: picks miss tile boundaries and return
// false-clear when an actual ridge is occluding. The result was that
// "go low" gave almost no defensive value — radars (and IR, and the
// eyeball) routinely punched through mountains.
//
// Replacement: walk the chord between observer and target in N samples,
// at each one compare the LOS altitude (linearly interpolated, with an
// earth-curvature correction) against `globe.getHeight()` at that
// lon/lat. Any sample where terrain rises above the LOS by more than
// CLEARANCE_M flags the whole chord as masked.
//
// Why getHeight is faster than pick: pick does a per-frame ray vs the
// terrain mesh (many triangle tests at the current LOD). getHeight is
// a 2D height-map lookup against the cached tile pyramid — at typical
// frame depth it's an order of magnitude cheaper. So 6-8 getHeights
// is comfortably less work than one pick on slanted geometry, AND
// produces a more reliable answer.

// Length-adaptive sample count. The right variable for "do we catch a
// ridge between samples?" is samples-per-kilometre, not samples-per-
// chord. Aim for ~1.5 km spacing so typical Alpine ridges (1-3 km
// crests) can't slip between samples on a BVR-length LOS, with floor
// + ceiling so short chords stay cheap and 100 km+ chords don't
// explode the per-frame cost.
const TERRAIN_LOS_TARGET_SPACING_M = 1500;
const TERRAIN_LOS_MIN_SAMPLES = 8;
const TERRAIN_LOS_MAX_SAMPLES = 64;
const TERRAIN_LOS_CLEARANCE_M = 30;
function _samplesForChord(L) {
	const n = Math.ceil(L / TERRAIN_LOS_TARGET_SPACING_M);
	if (n < TERRAIN_LOS_MIN_SAMPLES) return TERRAIN_LOS_MIN_SAMPLES;
	if (n > TERRAIN_LOS_MAX_SAMPLES) return TERRAIN_LOS_MAX_SAMPLES;
	return n;
}
// 4/3·R_earth — the standard radar-refraction effective earth radius.
// Atmospheric refraction bends radio waves slightly down so they reach
// past the geometric horizon; this is the conventional first-order
// correction. Visual / IR get a tiny bit *less* curvature benefit but
// the difference at our ranges is small enough that we use the same
// constant for all three channels.
const R_EFF = 6371000 * (4 / 3);

const _cartoEnd0 = new Cesium.Cartographic();
const _cartoEnd1 = new Cesium.Cartographic();
const _cartoSamp = new Cesium.Cartographic();

// Walk the chord between two ECEF points and return the closest sample
// at which terrain rises above the LOS (with curvature correction +
// clearance margin). Returns null when the chord is clear, otherwise
// `{ t, distance, terrainH, losAlt }` describing the obstruction:
//   t          [0,1] fraction along the chord
//   distance   metres along the chord from `fromCart` to the hit
//   terrainH   terrain altitude at the sample
//   losAlt     LOS altitude at the sample (terrainH > losAlt − margin)
// Used directly by both the sensor occlusion check (just needs boolean)
// and by Phase 3a's NPC forward-look terrain avoid (needs distance to
// scale pull-up urgency).
export function chordTerrainHit(fromCart, toCart, samples = null, clearanceM = TERRAIN_LOS_CLEARANCE_M) {
	if (!_sensorScene || !_sensorScene.globe) return null;

	const L = Cesium.Cartesian3.distance(fromCart, toCart);
	if (L < 100) return null;
	// Default sample count derives from chord length so the spacing
	// stays roughly constant. Callers that want a fixed budget (e.g.
	// the NPC forward-look path with a known short range) can still
	// pin the count explicitly.
	if (samples == null) samples = _samplesForChord(L);

	const fromC = Cesium.Cartographic.fromCartesian(fromCart, undefined, _cartoEnd0);
	const toC   = Cesium.Cartographic.fromCartesian(toCart,   undefined, _cartoEnd1);
	if (!fromC || !toC) return null;

	const h0 = fromC.height;
	const h1 = toC.height;
	const dLon = toC.longitude - fromC.longitude;
	const dLat = toC.latitude  - fromC.latitude;
	const bulgeRef = (L * L) / (2 * R_EFF);

	for (let i = 1; i < samples; i++) {
		const t = i / samples;
		_cartoSamp.longitude = fromC.longitude + t * dLon;
		_cartoSamp.latitude  = fromC.latitude  + t * dLat;
		_cartoSamp.height    = 0;

		const terrainH = _sensorScene.globe.getHeight(_cartoSamp);
		if (terrainH == null) continue;

		const losAlt = h0 + t * (h1 - h0) - t * (1 - t) * bulgeRef;
		if (terrainH > losAlt - clearanceM) {
			return { t, distance: t * L, terrainH, losAlt };
		}
	}
	return null;
}

export function isTerrainBlocked(fromCart, toCart) {
	return chordTerrainHit(fromCart, toCart) !== null;
}

// Per-(observer, target) cache for the terrain-LOS result. The
// uncached check costs 6 globe.getHeight calls per pair per frame,
// running across N×M sensor scans; in dense scenarios this added up
// to a clear FPS regression. With a 250 ms TTL the cache cuts the
// underlying call rate by ~15× while keeping the staleness below
// 140 m of relative motion at Mach 2 — well below the scale at
// which ridge-vs-altitude decisions actually flip.
//
// WeakMap-keyed on the unit references so destroyed units auto-evict
// from the cache when the rest of the sim drops them.
const _terrainCache = new WeakMap();
const TERRAIN_CACHE_TTL_MS = 250;
function isTerrainBlockedCachedPair(observer, target, fromCart, toCart) {
	if (!observer || !target) return isTerrainBlocked(fromCart, toCart);
	let perObs = _terrainCache.get(observer);
	if (!perObs) {
		perObs = new WeakMap();
		_terrainCache.set(observer, perObs);
	}
	const nowMs = performance.now();
	const hit = perObs.get(target);
	if (hit && hit.validUntilMs > nowMs) return hit.blocked;
	const blocked = isTerrainBlocked(fromCart, toCart);
	perObs.set(target, { blocked, validUntilMs: nowMs + TERRAIN_CACHE_TTL_MS });
	return blocked;
}

// Forward-look terrain check from a unit's current pose. Casts a chord
// of length `lookAheadM` along the unit's heading + pitch; returns the
// same {t, distance, terrainH, losAlt} shape as `chordTerrainHit`, or
// null if the path is clear.
//
// Used by `ForwardTerrainAvoidBehavior`: if the chord hits terrain
// within ~5-10 s of flight time, the NPC commands a pull-up scaled by
// how close the impact is. This is what stops NPCs from flying into
// ridges during evasion dives — the bare AGL check (in
// `TerrainAvoidBehavior`) only fires once they're already committed.
const _scratchFromCart = new Cesium.Cartesian3();
const _scratchToCart   = new Cesium.Cartesian3();
export function forwardLookTerrain(unit, lookAheadM = 5000, samples = 6, clearanceM = 50) {
	if (!unit || lookAheadM <= 0) return null;
	const headingDeg = unit.heading || 0;
	const pitchDeg   = unit.pitch   || 0;
	const headingRad = headingDeg * Math.PI / 180;
	const pitchRad   = pitchDeg   * Math.PI / 180;

	const R = 6371000;
	const dLat = (lookAheadM * Math.cos(headingRad) * Math.cos(pitchRad)) / R;
	const dLon = (lookAheadM * Math.sin(headingRad) * Math.cos(pitchRad))
	           / (R * Math.cos(unit.lat * Math.PI / 180));
	const dAlt = lookAheadM * Math.sin(pitchRad);

	const toLon = unit.lon + (dLon * 180 / Math.PI);
	const toLat = unit.lat + (dLat * 180 / Math.PI);
	const toAlt = unit.alt + dAlt;

	Cesium.Cartesian3.fromDegrees(unit.lon, unit.lat, unit.alt, undefined, _scratchFromCart);
	Cesium.Cartesian3.fromDegrees(toLon,    toLat,    toAlt,    undefined, _scratchToCart);
	return chordTerrainHit(_scratchFromCart, _scratchToCart, samples, clearanceM);
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
		c = { target, radar: null, ir: null, visual: null, fused: null,
			iffStatus: 'unknown' };
		contacts.set(target, c);
	}
	return c;
}

// 6d — upgrade-only IFF merge. Each channel (radar, IR, visual) calls
// identifyContact() and proposes a status. Multiple channels touching
// the same contact each frame should NOT let a weaker channel
// (e.g. IR with no range → 'unknown') downgrade a resolved one
// (e.g. visual ID at 3 km → 'hostile'). So we only allow:
//   unknown → friendly | hostile  (any resolution counts as upgrade)
//   hostile → friendly  (visual ID overrules NCTR; rare)
//   friendly → hostile  (visual ID can re-resolve too)
//   {anything} → unknown    NOT allowed (no downgrades)
function _mergeIff(contact, proposed) {
	if (!proposed) return;
	if (proposed === 'unknown') return;     // no downgrades
	contact.iffStatus = proposed;
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
// Single source of truth for "is this unit's radar emitting right now?".
// All callers — the sensor scan, the commander's debug overlay, the HARM
// seeker's emitter scoring, and the player's HARM-designation cycle —
// must agree on this answer. Otherwise the player sees a Tor's cone in
// the debug view but their HARM can't lock it (or vice versa), which is
// exactly the kind of bug that makes SEAD feel broken.
//
// Conditions:
//   - radar object exists
//   - radar.enabled !== false (absent = enabled, matches existing data)
//   - radar.active === true (emcon flips this; static SAMs default false)
//   - radar.mode !== 'off' (player TWS/STT toggle uses 'off' to silence)
//
// Pass the unit (preferred) or just the radar block; caller-friendly.
export function isRadiating(unitOrRadar) {
	if (!unitOrRadar) return false;
	// If passed a unit, dead units can't radiate regardless of what
	// their radar block says. Sensor unit-active check is on `active`
	// (the alive/destroyed flag), distinct from `radar.active` (the
	// emissions on/off flag).
	if (unitOrRadar.sensors !== undefined) {
		if (unitOrRadar.destroyed) return false;
		if (unitOrRadar.active === false) return false;
	}
	const r = unitOrRadar.sensors && unitOrRadar.sensors.radar
		? unitOrRadar.sensors.radar
		: unitOrRadar; // caller passed the radar block directly
	if (!r) return false;
	if (r.enabled === false) return false;
	if (!r.active) return false;
	if (r.mode === 'off') return false;
	return true;
}

export function detectRadar(observer, target, radar) {
	if (!isRadiating(radar)) return null;
	const sig = target && target.signature;
	if (!sig) return null;

	// 0) Optional target-class filter. A ground-mapping radar (RQ-4
	//    SAR, future fighter SAR/GMTI mode) shouldn't double as an
	//    air-search radar — even if its FOV cone happens to cover a
	//    fighter at low altitude, the signal-processing chain is
	//    fundamentally different. `targetKinds` whitelists by
	//    npc.kind ('ground' | 'airborne' | …); absent = no filter,
	//    detect anything in cone (the existing behavior for fighter
	//    APGs, SAM seekers, AWACS).
	if (radar.targetKinds && radar.targetKinds.length) {
		if (!radar.targetKinds.includes(target.kind)) return null;
	}

	const los = losObserverToTarget(observer, target);
	if (los.losLenMeters < 1) return null;

	// 1) FOV (rectangular cone — separate az/el like a real mech-scan set).
	//
	// Optional boresight offset: a radar can be physically mounted at
	// an angle to the airframe's nose-forward axis. Most radars are
	// 0°/0° (forward-pointing), but down-looking ground-mapping
	// radars (e.g. RQ-4 SAR, future fighter SAR/GMTI mode) sit at
	// boresightPitch ≈ -90° (straight down) so they cover the lower
	// hemisphere regardless of the airframe's heading. The offset
	// shifts the cone's apex direction; the FOV half-angles then
	// describe the cone around that shifted boresight.
	const boresightPitch = (radar.boresightPitchDeg != null)
		? radar.boresightPitchDeg * Math.PI / 180 : 0;
	const boresightYaw = (radar.boresightYawDeg != null)
		? radar.boresightYawDeg * Math.PI / 180 : 0;
	let azRel = los.bearingBody - boresightYaw;
	while (azRel >  Math.PI) azRel -= 2 * Math.PI;
	while (azRel < -Math.PI) azRel += 2 * Math.PI;
	const elRel = los.elevationBody - boresightPitch;
	if (Math.abs(azRel) > radar.fovH) return null;
	if (Math.abs(elRel) > radar.fovV) return null;

	// 2) Aspect-modulated RCS. Nose-on/tail-on different from beam.
	const tgtFwd = unitForwardENU(target);
	const aspect = aspectAngleFromVectors(los.losHat, tgtFwd);
	const effRcs = sig.rcs * rcsAspectFactor(aspect);

	// 3) 4th-root radar equation: detection range scales with RCS^0.25.
	const ratio = effRcs / radar.referenceRcs;
	const rangeLimit = radar.nominalRange * Math.pow(Math.max(1e-6, ratio), 0.25);

	// 3a) Jamming attenuation. Hostile EW pods cut the effective
	//     detection range against their host (self-protect) and along
	//     their broadcast cone (corridor noise). Burn-through restores
	//     full range when the observer closes inside the jammer's
	//     burnThroughRangeM. See systems/ew/jammerSubsystem.js.
	const jamAtt = accumulateJamAttenuation(observer, target);
	const effectiveRange = rangeLimit * jamAtt;

	// Detection gate. Two modes:
	//
	//   arcade (default): hard binary cutoff at effectiveRange — at
	//     0.99× you have a continuous reliable track, at 1.01× you
	//     have nothing. Predictable for gameplay, infallible inside
	//     range — the same behaviour the game has always had.
	//
	//   realistic: probabilistic gate keyed on distance / effectiveRange.
	//     Below 0.5× → always detect (firm track).
	//     0.5× to 1.3× → per-frame probability falling off as (1 - t)²,
	//       so the marginal zone produces flickering / "blip in and
	//       out" contacts. Combined with the 2 s channel memory in
	//       RADAR_CHANNEL_MEMORY this gives the SA picture
	//       "you have a soft contact about there".
	//     Above 1.3× → never detect (hard ceiling so we don't keep
	//       rolling dice on contacts a hundred km past where any
	//       reasonable signal could exist).
	//
	//   The signal strength field on the resulting contact (computed
	//   below) is already 1/r⁴-shaped so consumers that care about
	//   strength (RWR spike intensity, AAM lock-integrity hysteresis)
	//   keep behaving correctly in either mode.
	if (gameSettings.radarFidelity === 'realistic') {
		const denom = Math.max(1e-3, effectiveRange);
		const distRatio = los.losLenMeters / denom;
		let pDetect;
		if (distRatio <= 0.5)      pDetect = 1.0;
		else if (distRatio >= 1.3) pDetect = 0.0;
		else {
			const t = (distRatio - 0.5) / 0.8;   // 0..1 across the marginal band
			pDetect = (1 - t) * (1 - t);          // quadratic falloff
		}
		if (pDetect <= 0 || Math.random() > pDetect) return null;
	} else {
		if (los.losLenMeters > effectiveRange) return null;
	}

	// 4) Terrain LOS — a ridge in the way kills the return. Cached
	//    per (observer, target) pair with a 250 ms TTL so dense
	//    scenarios don't pay 6 getHeight calls per pair per frame.
	if (isTerrainBlockedCachedPair(observer, target, los.obsECEF, los.tgtECEF)) return null;

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
	// Phase 6d — IFF stamping at the source. NCTR + IFF interrogation
	// run as part of the radar scan; the result is sticky on the
	// contact record so downstream readers (datalink, HUD, scope, RWR,
	// strike planner) all see the same classification without
	// re-deriving it from target.team.
	_mergeIff(contact, identifyContact(observer, target, {
		signal: det.signal,
		range:  det.range,
		inEyeball: false,
	}));

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

	// Realistic-IR mode (gameSettings.irFidelity === 'realistic')
	// stacks three changes onto the IR scan:
	//
	//   (B) Per-missile post-boost decay. A burning motor emits ~5×
	//       what a cool coasting missile body does. Real-world AAMs
	//       go from very bright to nearly cold over ~3-8 s after
	//       motor burnout. We model with an exponential decay from
	//       full emission down to 0.2× over a 3 s time constant,
	//       keyed on `target._postBoostTime` set by Missile.update.
	//   (C) Constant scale on missile irEmission (×0.5) plus the
	//       fighter IRST `nominalRange` (×0.625 → 25 km baseline
	//       instead of 40 km), bringing MAWS detection ranges
	//       closer to real-world AAR-47 / MILDS / DAS figures
	//       (single-digit km against post-boost AAMs, 10–20 km
	//       against burning ones).
	//   (A) Probabilistic detection gate at the range edge with
	//       the same (1-t)² falloff used in realistic-radar mode,
	//       so MAWS contacts flicker as they cross the threshold
	//       instead of binary-snapping.
	//
	// Arcade IR is exactly the old behaviour — binary cutoff at the
	// full IRST range, no decay, full emission for all missiles.
	const realisticIR = gameSettings.irFidelity === 'realistic';

	let emission = sig.irEmission;
	let irNominalRange = s.nominalRange;
	if (realisticIR && isMissileClass) {
		// B — post-boost decay. _baseIrEmission + _postBoostTime are
		// stamped on the missile in its constructor / update; fall
		// back to the static signature value when missing (defensive
		// — e.g., a non-Missile class with a missile signature, or
		// older save state).
		const base = (typeof target._baseIrEmission === 'number')
			? target._baseIrEmission : sig.irEmission;
		const postBoost = (typeof target._postBoostTime === 'number')
			? target._postBoostTime : 0;
		const burning = (typeof target.boostRemaining === 'number')
			? target.boostRemaining > 0 : false;
		const decayFactor = burning
			? 1.0
			: 0.2 + 0.8 * Math.exp(-postBoost / 3);
		// C (part 1) — halve emission for missile-class targets.
		emission = base * decayFactor * 0.5;
	}
	if (realisticIR) {
		// C (part 2) — tighter baseline IRST envelope.
		irNominalRange = s.nominalRange * 0.625;
	}

	const effIr = emission * irAspectFactor(aspect);

	// Square-root law: IR falls with the square of distance (emission on a
	// sphere), so detection range scales with √emission.
	const ratio = effIr / s.referenceIr;
	const rangeLimit = irNominalRange * Math.sqrt(Math.max(1e-6, ratio));
	if (realisticIR) {
		const denom = Math.max(1e-3, rangeLimit);
		const distRatio = los.losLenMeters / denom;
		let pDetect;
		if (distRatio <= 0.5)      pDetect = 1.0;
		else if (distRatio >= 1.3) pDetect = 0.0;
		else {
			const t = (distRatio - 0.5) / 0.8;
			pDetect = (1 - t) * (1 - t);
		}
		if (pDetect <= 0 || Math.random() > pDetect) return false;
	} else {
		if (los.losLenMeters > rangeLimit) return false;
	}

	if (isTerrainBlockedCachedPair(observer, target, los.obsECEF, los.tgtECEF)) return false;

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
	// 6d — IR alone can't run NCTR (no Doppler / size resolution
	// like radar) so the strongest signal here is "something hot
	// in the cone" — fall through identifyContact's IFF
	// interrogation, which still works coalition-wise. Range is
	// unknown so visual ID can't trigger from IR alone.
	_mergeIff(contact, identifyContact(observer, target, { signal }));
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
	let effSize = sig.visualSize * visualAspectFactor(aspect);

	// Phase 8 — contrails are by far the most reliable visual ID cue
	// at altitude. A jet that would otherwise be a 19 m speck against
	// blue sky becomes a kilometre-long white streak the moment it
	// crosses the formation ceiling. We model this as an effective
	// visual-size multiplier when the target is currently emitting a
	// contrail (Contrail.update sets unit.contrailing).
	//
	// Multiplier originally ×6, giving ~72 km range on a contrailing
	// fighter — realistic for SPOTTING the contrail itself, but
	// unrealistic for converting that into a tracked bearing on the
	// aircraft producing it. Dropped to ×3.5 so a contrailing fighter
	// is detectable around ~40 km and an AWACS around ~100 km, which
	// still rewards radar-off NPCs for spotting contrails passively
	// without giving them an effective passive-radar substitute.
	if (target.contrailing) effSize *= 3.5;

	// Detection range scales linearly with visual size (apparent angular
	// size is size / range). referenceVisualSize is the default fighter.
	const ratio = effSize / s.referenceVisualSize;
	const rangeLimit = s.nominalRange * Math.max(0, ratio);
	if (los.losLenMeters > rangeLimit) return false;

	if (isTerrainBlockedCachedPair(observer, target, los.obsECEF, los.tgtECEF)) return false;

	const contact = touchContact(observer.contacts, target);
	contact.visual = {
		bearing: los.bearingBody,
		elevation: los.elevationBody,
		apparentSize: sig.visualSize / los.losLenMeters, // radians
		classHint: sig.unitClass,
		lastSeen: now,
	};
	// 6d — visual is the most reliable IFF resolver. Anything close
	// enough + in the eyeball cone gets visual-ID'd to truth.
	_mergeIff(contact, identifyContact(observer, target, {
		range: los.losLenMeters,
		inEyeball: true,
	}));
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
	// Snapshot the current set of active jammers so detectRadar can
	// apply attenuation without threading the full units array
	// through every call signature (seekers, AI, sensor scan all hit
	// detectRadar).
	setJammerRegistry(units);

	// Scan step. A destroyed / inactive observer doesn't scan — its
	// radar is off, its eyes are closed. Previously we only filtered
	// out destroyed TARGETS, so a dead player's radar kept populating
	// contacts, which in turn kept refreshing team-datalink fused
	// tracks — resulting in in-flight friendly missiles staying in DL
	// mode after the player died even with no other platform around.
	for (const observer of units) {
		if (!observer || !observer.sensors) continue;
		if (observer.destroyed || observer.active === false) continue;
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
