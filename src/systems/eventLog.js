// ============================================================================
// Event log — append-only kill/crash record for the pause-screen recap.
//
// Every air-to-air kill, gun kill, and crash funnels through here so the
// player can review what just happened during pause. Storage is a simple
// in-memory array with a hard cap (oldest events evicted) so a long
// session can't grow it without bound.
//
// Sources that push events:
//   - Missile.hitNPC / AIM120.hitNPC  → 'kill' from a missile launch
//   - Bullet.hitNPC                   → 'kill' from gun fire
//   - npcUpdate (terrain collision)   → 'crash' for an NPC into terrain
//   - crashDetection.doCrashTransition → 'crash' for the player into terrain
//
// The pause UI reads via `getEvents()` and renders the latest N.
// ============================================================================

const MAX_EVENTS = 64;
const _events = [];

// Push a kill event. Fields:
//   shooter — the unit that fired the round, or null/`'TERRAIN'` for a
//             crash. The unit object is passed live, not copied; we
//             extract the display name *now* (before the unit gets
//             cleaned up) to avoid stale-reference dangling state.
//   target  — the unit that just got destroyed (player state object or
//             an NPC). Same name-extraction discipline.
//   weapon  — short string. 'AIM-120', 'AIM-9', 'METEOR', 'GUN',
//             'TERRAIN'. Used as the "with X" label.
//   at      — sim-time seconds. Caller passes ctx.getSimTime() (or
//             whatever monotonic clock they have); we store it raw and
//             format on render.
//   reason  — 'kill' | 'crash'. Drives a colour cue in the pause UI.
export function pushKill({ shooter, target, weapon, at, reason = 'kill' }) {
	const ev = {
		shooter: nameOf(shooter),
		shooterTeam: teamOf(shooter),
		target:  nameOf(target),
		targetTeam: teamOf(target),
		weapon:  weapon || 'UNKNOWN',
		at:      typeof at === 'number' ? at : 0,
		reason,
	};
	_events.push(ev);
	while (_events.length > MAX_EVENTS) _events.shift();
}

export function getEvents() { return _events; }

// Wipe the log. Called on respawn / scenario change so each run starts
// clean. (Keeping the log across deaths would also be a defensible
// choice; pick one. Wipe is simpler and matches the way the rest of
// the sim treats respawn as a fresh slate.)
export function clearEvents() { _events.length = 0; }

// ----------------------------------------------------------------------------
// Helpers — name + team extraction. Robust to:
//   - player state objects (no `.name`, may have `.callsign`)
//   - NPCs (have `.name`)
//   - terrain / null (string sentinel passed by callers)
//   - destroyed unit refs (still have name/team — captured at push time)
// ----------------------------------------------------------------------------

export function nameOf(u) {
	if (u == null) return 'UNKNOWN';
	if (typeof u === 'string') return u;
	if (u.name) return u.name;
	if (u.callsign) return u.callsign;
	// The player state object doesn't carry a name; identify by the
	// fact that it has both a weaponSystem and a `team` of 'friendly'.
	if (u.weaponSystem) return 'PLAYER';
	// Projectiles / missiles carry their munition data — fall back to
	// the munition's display name (or simType) so a SAM-vs-cruise
	// kill reads "NASAMS-1 shot down STORM-SHADOW" instead of
	// "...UNKNOWN".
	if (u.data) {
		const d = u.data;
		const munLabel = d.shortName || d.name || d.simType;
		if (munLabel) return munLabel;
	}
	if (u.type) return u.type;
	return 'UNKNOWN';
}

export function teamOf(u) {
	if (u == null || typeof u === 'string') return null;
	return u.team || null;
}
