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

// ---- Strike-planner queue --------------------------------------------------
//
// The strike-planner map (5g.1+) lets the player queue multiple GPS
// targets. The "current" designation (`playerDesignation.lon/lat/alt`)
// is always the head of the queue — that's what the next JDAM fired
// will home on. When the player drops a bomb the head is consumed
// and the next queued point promotes to head. This lets a salvo of N
// JDAMs hit N different targets in one pass.
//
// The queue contains all designated points INCLUDING the current
// head. Index 0 is the head (mirrored into playerDesignation for the
// existing seekers and HUD readouts that consume the singleton). The
// strike-planner map iterates the full list to render markers.
//
// The TGP (laser path) doesn't use the queue — its lone designation
// continues to flow through `playerDesignation` directly via
// snapTrack / setSlewSpot. The two designators don't share state
// beyond the head: opening the TGP after queueing JDAM points takes
// the queue head as the active TGP spot, which is consistent with
// "the planner committed a target; the TGP now holds it."
export const designationQueue = [];

// Cycle mode. Off (default): consuming the head shifts it off the
// queue, so a salvo of N bombs against M queued points stops when
// M is exhausted. On: consuming rotates the head to the back of the
// queue instead — useful for cruise-missile training where the
// player wants to shoot every munition they have at the same handful
// of targets, cycling through repeatedly.
export const designationState = { cycle: false };

export function setCycleMode(on) {
	designationState.cycle = !!on;
}
export function toggleCycleMode() {
	designationState.cycle = !designationState.cycle;
	return designationState.cycle;
}
export function getCycleMode() {
	return designationState.cycle;
}

function _syncHead() {
	if (designationQueue.length === 0) {
		// No queued targets — fall back to the SLEW state so the
		// rest of the system (release-envelope, fire-gate) treats
		// this as "no designation."
		playerDesignation.mode = 'SLEW';
		playerDesignation.lasing = false;
		playerDesignation.lon = 0;
		playerDesignation.lat = 0;
		playerDesignation.alt = 0;
		playerDesignation.target = null;
		return;
	}
	const head = designationQueue[0];
	playerDesignation.mode = 'TRACK';
	playerDesignation.lasing = false;
	playerDesignation.lon = head.lon;
	playerDesignation.lat = head.lat;
	playerDesignation.alt = head.alt;
	playerDesignation.target = null;
}

// Add a new target to the back of the queue. The strike-planner map
// calls this on click. If the queue was empty, the new point also
// becomes the current designation (head sync).
export function addDesignation(lon, lat, alt) {
	designationQueue.push({ lon, lat, alt });
	_syncHead();
}

// Remove a target by index (for "click on existing dot to remove").
// If the head is removed the next target promotes.
export function removeDesignationAt(index) {
	if (index < 0 || index >= designationQueue.length) return;
	designationQueue.splice(index, 1);
	_syncHead();
}

// Move a queued designation from one index to another, shifting the
// rest. Used by the strike planner's drag-to-reorder UX. No-op if
// either index is out of range or they're equal. _syncHead() runs at
// the end so playerDesignation always reflects index 0.
export function moveDesignation(fromIndex, toIndex) {
	if (fromIndex < 0 || fromIndex >= designationQueue.length) return;
	if (toIndex   < 0 || toIndex   >= designationQueue.length) return;
	if (fromIndex === toIndex) return;
	const [item] = designationQueue.splice(fromIndex, 1);
	designationQueue.splice(toIndex, 0, item);
	_syncHead();
}

// Pop the head of the queue. Called by the JDAM fire path after a
// successful release so the next bomb targets the next queued point.
export function consumeDesignationHead() {
	if (designationQueue.length === 0) return;
	if (designationState.cycle) {
		// Rotate head to the back so the queue cycles indefinitely.
		// This lets the player drop every munition they have onto a
		// fixed set of N targets, looping past the end. Useful for
		// volume-fire training (cruise-missile saturation, JDAM rake
		// of a SAM site) where you don't want the queue to drain.
		const head = designationQueue.shift();
		designationQueue.push(head);
	} else {
		designationQueue.shift();
	}
	_syncHead();
}

export function clearDesignationQueue() {
	designationQueue.length = 0;
	_syncHead();
}

// Refine the alt of an already-queued point (used after async terrain
// sample lands; see strike planner click handler). Identifies the
// point by exact lon/lat match.
export function refineDesignationAlt(lon, lat, alt) {
	for (const d of designationQueue) {
		if (Math.abs(d.lon - lon) < 1e-6 && Math.abs(d.lat - lat) < 1e-6) {
			d.alt = alt;
			break;
		}
	}
	_syncHead();
}

// Legacy single-point setter — keep for callers that want the
// "replace whatever is there" semantic (none today, but kept as a
// stable API). Equivalent to clear + add.
export function setDesignationFromMap(lon, lat, alt) {
	designationQueue.length = 0;
	designationQueue.push({ lon, lat, alt });
	_syncHead();
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
