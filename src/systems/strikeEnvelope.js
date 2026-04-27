// ============================================================================
// strikeEnvelope.js — release-zone math for unguided / glide-guided bombs.
//
// Single source of truth for "is the player's currently-designated point
// within drop range of the currently-selected strike weapon?" Used by:
//
//   - tgp.js: colors the RNG line and shows X.X / Y.Y km on the status
//     block.
//   - hud.js: appends an IN ZONE / NEAR / OUT tag to the strike-weapon
//     row.
//   - (future) the §5g strike planner: filters auto-assignment by the
//     same envelope, so the planner and the cockpit cue agree on what
//     "in range" means.
//
// Pure function, no DOM, no side effects. Returns null when there's
// nothing meaningful to display (no designation, designation above the
// launch altitude, weapon isn't a strike weapon).
// ============================================================================

const G = 9.81;

// True for the seeker types this helper handles. Future strike-class
// seekers (GPS-with-INS-fallback, EO, etc.) get added here.
export function isStrikeWeapon(munitionData) {
	if (!munitionData) return false;
	const s = munitionData.seekerType;
	return s === 'laser' || s === 'gps';
}

// Great-circle horizontal slant range, slightly off (uses a flat-Earth
// approximation per-degree); within tens-of-km this is well under the
// kill-radius noise of any of these munitions, so it's not worth the
// extra trig.
function _slantRangeMeters(a, b) {
	const cosLat = Math.cos((a.lat || 0) * Math.PI / 180);
	const dE = (b.lon - a.lon) * 111320 * cosLat;
	const dN = (b.lat - a.lat) * 111320;
	const dU = (b.alt - a.alt);
	return Math.sqrt(dE * dE + dN * dN + dU * dU);
}

// Compute Rmin / Rmax / status for the given (player, designation,
// munition). Returns null if the inputs aren't actionable — callers
// hide the indicator on null.
//
// Rmax model:
//   altAGL = max(50, playerAlt - designationAlt)
//   vH = speed * cos(pitch)
//   vV = speed * sin(pitch)            // signed: dive < 0, climb > 0
//   t  = (vV + sqrt(vV² + 2g·altAGL)) / g    // ballistic with initial vV
//   R  = min(vH * t * glideFactor, peakSpeed * maxLifeS)
//
// Rmin: max(300, 1.5 · speed) — fuze-arm + safe-separation. Doesn't
// scale with altitude (Rmin is a frag-stand-off concern, not aero).
//
// Status thresholds: IN if rMin < r < 0.9·rMax, NEAR if r ≤ rMax,
// OUT otherwise.
export function releaseEnvelope(playerState, designation, munitionData) {
	if (!isStrikeWeapon(munitionData)) return null;
	if (!playerState || !designation) return null;
	if (designation.mode === 'SLEW') return null;
	// A coordinate-less designation (lat/lon both zero from a pristine
	// boot) isn't a real point — bail rather than render numbers that
	// look authoritative.
	if (designation.lat === 0 && designation.lon === 0) return null;

	const speed = Math.max(0, playerState.speed || 0);
	const altAGL = Math.max(50, (playerState.alt || 0) - (designation.alt || 0));
	if ((playerState.alt || 0) - (designation.alt || 0) < 0) {
		// Designation is above the player — no unpowered bomb reaches it.
		return { rMin: 0, rMax: 0, currentRange: _slantRangeMeters(playerState, designation), status: 'OUT' };
	}

	// Pitch is stored on playerState in degrees per the existing
	// convention used elsewhere in this codebase (see physics.js +
	// LaserSeeker). Convert here.
	const pitchRad = (playerState.pitch || 0) * Math.PI / 180;
	const vH = speed * Math.cos(pitchRad);
	const vV = speed * Math.sin(pitchRad);
	const t  = (vV + Math.sqrt(vV * vV + 2 * G * altAGL)) / G;

	const flight = (munitionData && munitionData.flight) || {};
	const glide = flight.glideFactor ?? 1.0;
	const lifeBound = (flight.peakSpeed ?? 350) * (flight.maxLifeS ?? 60);
	const rMax = Math.max(0, Math.min(vH * t * glide, lifeBound));
	const rMin = Math.max(300, 1.5 * speed);

	const currentRange = _slantRangeMeters(playerState, designation);
	let status;
	if (currentRange > rMax)              status = 'OUT';
	else if (currentRange < rMin)         status = 'OUT';
	else if (currentRange > 0.9 * rMax)   status = 'NEAR';
	else                                  status = 'IN';

	return { rMin, rMax, currentRange, status };
}
