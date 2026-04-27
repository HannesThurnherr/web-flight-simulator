// ============================================================================
// designation.js — player laser-designation registry.
//
// One global object that the TGP UI writes to and laser-guided munitions
// (GBU-12 etc.) read from. Single source of truth for "where is the
// player's laser spot right now?" — analogous to weaponSystem.designatedEmitter
// but for ground-attack instead of SEAD.
//
// State machine (TGP UI drives transitions):
//
//   SLEW → TRACK → LASE → TRACK → SLEW
//
// SLEW: pilot moves the crosshair over the ground freely. No spot is
//   established yet; `lasing` is false. Designation lat/lon/alt is
//   computed each frame from the crosshair → ground intersection.
//
// TRACK: pilot has snapped on a point. The TGP camera holds the world
//   point in centre frame (the crosshair stays on the snapped location
//   even as the aircraft moves). `point` and `target` (if a unit was
//   under the crosshair at snap) are frozen. `lasing` still false.
//
// LASE: same as TRACK plus the laser is firing. `lasing` is true. This
//   is the state a GBU-12 needs to see active during its terminal phase.
//   Switching off LASE returns to TRACK; bombs in flight then coast
//   ballistic until LASE comes back, or until losBreakTimeoutS expires.
//
// Why a global rather than ownership by the player unit: at this stage
// only the player has a TGP. Future buddy-lasing (a wingman designates
// while you drop) will need a per-unit designation map; for now the
// simpler shape is fine and lets every laser-seeker import directly.
// ============================================================================

// Mutable singleton. Mutate in place rather than reassigning so existing
// references (held by GBU-12 seekers in flight) keep seeing live data.
export const playerDesignation = {
	mode: 'SLEW',          // 'SLEW' | 'TRACK' | 'LASE'
	lasing: false,         // convenience: mode === 'LASE'
	// Spot location. In SLEW this updates every frame; in TRACK / LASE
	// it's frozen to the moment of snap (or follows `target` if set).
	lon: 0,
	lat: 0,
	alt: 0,
	// If the snap was on a ground unit (not just bare terrain), this
	// holds the unit reference and the spot follows it (vehicles can
	// roll; the laser tracks them).
	target: null,
	// Sim-time bookkeeping. `lastLaseAt` lets bombs implement a
	// `losBreakTimeoutS` "spot lost" countdown — coast ballistic until
	// the spot returns, give up if it stays gone too long.
	lastLaseAt: -Infinity,
};

export function setSlewSpot(lon, lat, alt) {
	if (playerDesignation.mode === 'SLEW') {
		playerDesignation.lon = lon;
		playerDesignation.lat = lat;
		playerDesignation.alt = alt;
	}
}

export function snapTrack(lon, lat, alt, target = null) {
	playerDesignation.mode = 'TRACK';
	playerDesignation.lasing = false;
	playerDesignation.lon = lon;
	playerDesignation.lat = lat;
	playerDesignation.alt = alt;
	playerDesignation.target = target;
}

export function startLase(now) {
	if (playerDesignation.mode !== 'TRACK' && playerDesignation.mode !== 'LASE') return;
	playerDesignation.mode = 'LASE';
	playerDesignation.lasing = true;
	playerDesignation.lastLaseAt = now;
}

export function stopLase() {
	if (playerDesignation.mode === 'LASE') {
		playerDesignation.mode = 'TRACK';
		playerDesignation.lasing = false;
	}
}

export function returnToSlew() {
	playerDesignation.mode = 'SLEW';
	playerDesignation.lasing = false;
	playerDesignation.target = null;
}

// Map-mode designator: a click on the strike-planner map sets the
// designated point directly, bypassing the TGP-state machine. Forces
// mode to TRACK (so JDAM fire-checks pass and the bomb has something
// to home on) but leaves lasing off (a map click can't lase). Clears
// any unit-snap — map clicks designate ground points, not vehicles.
//
// If the player later opens the TGP, it will show this point as a
// TRACK-locked spot, which is the natural read: "the strike planner
// committed a target; the TGP is now holding it." Cycling MODE on
// the TGP from there continues the normal SLEW/TRACK/LASE flow.
export function setDesignationFromMap(lon, lat, alt) {
	playerDesignation.mode = 'TRACK';
	playerDesignation.lasing = false;
	playerDesignation.lon = lon;
	playerDesignation.lat = lat;
	playerDesignation.alt = alt;
	playerDesignation.target = null;
}

// Each tick: if we're tracking a unit, slide the spot to follow it.
// Called from the TGP system update.
export function tickTrack(now) {
	const t = playerDesignation.target;
	if (t && !t.destroyed && t.active !== false &&
		(playerDesignation.mode === 'TRACK' || playerDesignation.mode === 'LASE')) {
		playerDesignation.lon = t.lon;
		playerDesignation.lat = t.lat;
		playerDesignation.alt = t.alt;
	}
	if (playerDesignation.mode === 'LASE') {
		playerDesignation.lastLaseAt = now;
	}
}
