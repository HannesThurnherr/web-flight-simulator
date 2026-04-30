// ============================================================================
// IFF — Identification Friend or Foe (Phase 6d).
//
// Single source of truth for "what does observer see this target as?".
// Returns one of:
//   'friendly'  — observer's IFF interrogation got a valid friendly squawk
//   'hostile'   — known hostile (NCTR succeeded, briefed, observed firing,
//                 visual ID at close range as a hostile-painted unit, etc.)
//   'unknown'   — IFF unresolved. Player has to use visual ID, NCTR, or
//                 cross-reference with the briefed picture before shooting.
//
// Every contact-producing channel (radar, IR, visual, datalink fusion,
// briefed intel) calls `identifyContact()` to stamp `iffStatus` onto the
// contact record at production time. Downstream consumers (HUD diamonds,
// scope colors, RWR, strike planner) read the stamped value rather than
// re-deriving from `target.team`. This keeps the friendly-fire risk
// consistent: if AWACS paints something as 'unknown', the whole team's
// datalink picture reads 'unknown' until someone (NCTR or visual) resolves.
//
// Omniscient mode (gameSettings.iff.omniscient) bypasses the pipeline
// entirely: identifyContact returns the true team-derived classification.
// Default is false (realistic IFF on); the toggle lives in settings as
// an arcade-mode opt-in.
//
// Resolution thresholds:
//   visual ID — within ~5 km in observer's eyeball cone, contact resolves
//               to its true team (friendly or hostile)
//   NCTR      — radar contact with signal ≥ NCTR_SIGNAL_THRESHOLD AND no
//               friendly IFF squawk → hostile. (No ranging penalty for
//               friendly squawks; those resolve as 'friendly' as soon as
//               the IFF interrogator reaches them.)
// ============================================================================

import { gameSettings } from '../ui/settings.js';

// Probabilities + thresholds. Tuneable.
const FRIENDLY_IFF_FAILURE_RATE = 0.02;   // 2 % of "should be friendly" rolls
                                          // come back unknown — IFF crypto
                                          // mismatch / misconfigured Mode 5 /
                                          // jammed.  Keeps the picture
                                          // mostly clean but introduces
                                          // occasional ambiguous friendlies.
const NCTR_SIGNAL_THRESHOLD     = 0.30;   // signal in [0..1]; above this we
                                          // can do non-cooperative target
                                          // recognition on the radar return.
const VISUAL_ID_RANGE_M         = 5000;   // any contact within this
                                          // distance, in eyeball cone,
                                          // auto-resolves to truth.

// Seeded "good guy" predicate: belongs to the same broad coalition as the
// observer? (Two NATO teams interrogate each other's IFF correctly; a
// neutral airliner squawking civilian doesn't get a friendly response.)
// Right now we model the simple case — same `team` string = friendly side.
// Future expansion: coalition strings on the team JSON.
function _isSameCoalition(observer, target) {
	if (!observer || !target) return false;
	if (!observer.team || !target.team) return false;
	return observer.team === target.team;
}

// Strict random PRNG seedable per (observer, target) pair so a friendly
// that flickered to 'unknown' last frame stays 'unknown' this frame —
// wouldn't want IFF to constantly thrash. Cached on the observer's
// contact entry by the caller.
function _stableHash(a, b) {
	// Cheap, deterministic. Returns a stable [0..1) for any string pair.
	const s = (a || '') + '|' + (b || '');
	let h = 2166136261 >>> 0;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619) >>> 0;
	}
	return (h >>> 0) / 0xffffffff;
}

// Public API. Caller passes the observer + target unit references plus
// optional `signal` (0..1, from radar contact) and `range` (m) so we
// can apply NCTR and visual-ID logic.
//
// Returns 'friendly' | 'hostile' | 'unknown'.
export function identifyContact(observer, target, opts = {}) {
	if (!target) return 'unknown';
	if (target.destroyed) return 'unknown';

	// Omniscient override — used when the player explicitly opts into
	// arcade-mode SA. Returns the true team-derived classification, no
	// uncertainty injected. Equivalent to the old `team === team`
	// filter the rest of the codebase used to do inline.
	if (gameSettings && gameSettings.iff && gameSettings.iff.omniscient) {
		return _isSameCoalition(observer, target) ? 'friendly' : 'hostile';
	}

	const signal = (typeof opts.signal === 'number') ? opts.signal : 0;
	const range  = (typeof opts.range  === 'number') ? opts.range  : Infinity;
	const inEyeball = !!opts.inEyeball;

	// Visual ID — close + in eyeball cone resolves regardless of channel.
	if (range <= VISUAL_ID_RANGE_M && inEyeball) {
		return _isSameCoalition(observer, target) ? 'friendly' : 'hostile';
	}

	// NCTR — radar contact at high signal strength resolves to hostile
	// (an enemy isn't going to squawk friendly Mode 5, even if his
	// transponder is jamming back random crap). For coalition members
	// the IFF interrogator above does the work.
	if (signal >= NCTR_SIGNAL_THRESHOLD && !_isSameCoalition(observer, target)) {
		return 'hostile';
	}

	// IFF interrogation. Same coalition: usually friendly, occasionally
	// flakes to unknown (crypto mismatch / wrong Mode-5 day code / EW
	// jamming the transponder return). Different coalition: returns
	// no friendly squawk → unknown unless something else (NCTR, visual)
	// already promoted it to hostile.
	if (_isSameCoalition(observer, target)) {
		const r = _stableHash(observer.id || observer.name || 'obs',
			target.id || target.name || 'tgt');
		if (r < FRIENDLY_IFF_FAILURE_RATE) return 'unknown';
		return 'friendly';
	}

	// Hostile coalition with no NCTR/visual confirmation: unknown.
	return 'unknown';
}

// Helper: should the observer treat this target as a hostile for purposes
// of "is this a fire-eligible target?" Used by AESA-lock filtering and AI
// engage gates. With omniscient mode on, this is the old `team !== team`
// check exactly. With realistic IFF, only resolved 'hostile' are eligible
// — 'unknown' contacts are fire-restricted, modeling ROE.
export function isFireEligible(observer, target, opts = {}) {
	const id = identifyContact(observer, target, opts);
	return id === 'hostile';
}
