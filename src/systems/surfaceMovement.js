// ============================================================================
// Surface (ship) kinematics + navigation sampling.
//
// Ships are NOT aircraft: no aerodynamics, no bank, no pitch, no stall, no
// terrain-impact death. They are a slow first-order kinematic body — a course
// (heading) that changes at a bounded rate (the turning circle), a speed that
// lags toward a commanded value (engine spool / hull inertia), and a hull
// pinned to the sea surface. This module owns that integration so it can be
// driven IDENTICALLY by the AI pilot (via npcUpdate) and, later, by a
// player ShipController (via simLoop) — write the physics once, reuse it for
// both. The ONLY inputs are the same `command`-shaped intent fields an AI
// pilot writes: targetHeading, targetSpeed, throttle. That is the seam that
// keeps player control a drop-in.
//
// Land avoidance mirrors the aircraft forward-look-terrain idea but in the
// horizontal plane: sample the rendered surface ahead and, when a coastline
// rises into the corridor, hand the pilot a clear bearing to steer onto.
// Sea/land classification uses RELATIVE rise above the ship's local sea
// reference (see terrain.js) so geoid undulation never reads open ocean as
// land.
// ============================================================================

import { advanceLonLatAlt } from '../plane/aeroModel.js';
import { seaSurfaceHeightAt, isLandAt } from '../world/terrain.js';

const DEG = Math.PI / 180;

// Flat-earth offset: the point `distM` metres from (lon,lat) on compass
// bearing `bearingDeg`. Cheap and accurate at the few-km scales ship nav
// cares about.
function destAt(lon, lat, bearingDeg, distM) {
	const b = bearingDeg * DEG;
	const dE = Math.sin(b) * distM;
	const dN = Math.cos(b) * distM;
	const cosLat = Math.max(1e-6, Math.cos(lat * DEG));
	return {
		lon: lon + (dE / (111320 * cosLat)),
		lat: lat + (dN / 111320),
	};
}

// Is the corridor on `bearing` clear out to `dist` (sampled at a couple of
// ranges so a thin spit of land isn't stepped over)?
function corridorClear(viewer, npc, bearing, dist, seaRef) {
	for (const frac of [0.45, 0.75, 1.0]) {
		const p = destAt(npc.lon, npc.lat, bearing, dist * frac);
		if (isLandAt(viewer, p.lon, p.lat, seaRef)) return false;
	}
	return true;
}

// Look ahead along the ship's course and, if land is in the way, find the
// nearest clear bearing to steer onto. Returns the nav picture the pilot
// reads from ctx.unit each tick:
//   { seaSurfaceH, landAhead, landAheadBearing }
// Sampling is the caller's responsibility to throttle (it walks getHeight
// several times); npcUpdate calls this on the existing 2 Hz terrain cadence.
export function computeShipNav(viewer, npc) {
	// Sample with NO floor so an unstreamed tile returns null (rather than 0).
	// The caller then keeps the prior sea reference / async spawn sample
	// instead of yanking a far ship's clamp down to 0 — which would otherwise
	// stick forever for a ship whose tile never streams (it's distance-culled
	// anyway, but the clamp must stay correct for when the player closes in).
	const sampled = seaSurfaceHeightAt(viewer, npc.lon, npc.lat);
	const seaRef = (sampled != null) ? sampled : npc._seaRefH;          // ref for land compare
	// Look a generous distance ahead — a destroyer needs hundreds of metres
	// to come about, so give it minutes of warning, floored so a near-stopped
	// ship still scans a useful corridor.
	const dist = Math.max(2200, (npc.speed || 0) * 90);
	const heading = npc.heading || 0;

	if (corridorClear(viewer, npc, heading, dist, seaRef)) {
		return { seaSurfaceH: sampled, landAhead: false, landAheadBearing: heading };
	}

	// Blocked. Fan out from the current heading, smallest deflection first,
	// and steer onto the first clear corridor. Bias is symmetric; the
	// alternating +/- search naturally prefers the gentler turn.
	for (let off = 20; off <= 160; off += 20) {
		for (const sign of [1, -1]) {
			const cand = (heading + sign * off + 360) % 360;
			if (corridorClear(viewer, npc, cand, dist, seaRef)) {
				return { seaSurfaceH: sampled, landAhead: true, landAheadBearing: cand };
			}
		}
	}
	// Boxed in (cove / fjord) — reverse course and crawl back out.
	return { seaSurfaceH: sampled, landAhead: true, landAheadBearing: (heading + 180) % 360 };
}

// Advance a surface unit one tick. Mutates npc.{heading,speed,lon,lat,alt,
// pitch,roll,isBoosting} in place. Reads the intent fields (targetHeading,
// targetSpeed, throttle) already resolved onto the npc by the caller.
//
// opts:
//   turnRateMaxDegPerS  hull turn-rate limit → the turning circle
//                       (radius = speed / turnRate); 2–3 for a destroyer.
//   accelTauS           first-order speed-lag time constant (engine/hull
//                       inertia). ~30 s = ponderous warship spool.
//   seaSurfaceH         rendered sea-surface height to clamp the hull to
//                       (caller samples it; falls back to npc._seaRefH).
export function integrateSurfaceKinematics(npc, dt, opts = {}) {
	const turnRate = opts.turnRateMaxDegPerS ?? 3;
	const accelTau = opts.accelTauS ?? 30;

	// 1. Course: rotate heading toward targetHeading, bounded by turn rate.
	let hErr = (npc.targetHeading ?? npc.heading) - npc.heading;
	while (hErr > 180) hErr -= 360;
	while (hErr < -180) hErr += 360;
	const maxStep = turnRate * dt;
	npc.heading = (npc.heading + Math.max(-maxStep, Math.min(maxStep, hErr)) + 360) % 360;

	// 2. Speed: first-order lag toward the commanded speed (targetSpeed scaled
	//    by throttle). Ships don't snap to a new speed — they spool.
	const cmdSpeed = Math.max(0, (npc.targetSpeed ?? 0) * (npc.throttle ?? 1));
	const k = Math.min(1, dt / Math.max(0.001, accelTau));
	npc.speed += (cmdSpeed - npc.speed) * k;
	if (npc.speed < 0) npc.speed = 0;

	// 3. Position: integrate the horizontal velocity along the (sea-level)
	//    course. Same geodetic integrator the aircraft use; z velocity is 0.
	const hRad = npc.heading * DEG;
	const velENU = { x: Math.sin(hRad) * npc.speed, y: Math.cos(hRad) * npc.speed, z: 0 };
	const p = advanceLonLatAlt(npc.lon, npc.lat, npc.alt, velENU, dt);
	npc.lon = p.lon;
	npc.lat = p.lat;

	// 4. Pin to the sea surface (keeps the hull on the visible water through
	//    geoid changes) and zero the attitude — ships never bank or pitch.
	// Only re-clamp when we have a REAL sea reference. Defaulting to 0 put the
	// hull at ellipsoid height, which over the Ionian (geoid ≈ +40 m) is ~40 m
	// underwater — invisible under the waterline clip, and every munition it
	// launched was born below the surface its own collision check reads.
	// Holding the previous altitude until a sample arrives is always closer to
	// the truth than snapping to the ellipsoid.
	const seaH = (opts.seaSurfaceH != null) ? opts.seaSurfaceH : npc._seaRefH;
	if (seaH != null) npc.alt = seaH + (npc._groundOffsetM || 0);
	npc.pitch = 0;
	npc.roll = 0;
	npc.isBoosting = false;
}
