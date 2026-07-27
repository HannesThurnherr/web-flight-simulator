// ============================================================================
// Naval / sea-skimmer debug tracing.
//
// Anti-ship rounds have a failure mode that is hard to diagnose from the
// outside: they detonate seconds after launch and all you see is a splash. The
// cause could be spawn altitude, a disagreeing sea reference, guidance never
// running (no target → lostLock → ballistic arc into the water), or an enemy
// point-defence intercept — and every one of those looks identical from the
// cockpit.
//
// This traces the whole life of an anti-ship round: launch geometry, the first
// seconds of guidance, and whatever finally kills it, with the numbers needed
// to tell those cases apart.
//
// The bug it was built for (ocean tile LOD moving the sea under in-flight
// rounds) is closed, so it now defaults OFF. Re-arm at runtime, no rebuild:
//   window.__navalDebug = true        launch / death / sea-revision events
//   window.__navalDebug = 'verbose'   the above plus the 5 Hz guidance trace
// The event lines are rare and high-signal; the guidance trace is a few
// hundred lines per engagement, which is why it's behind the second level.
// ============================================================================

function _enabled() {
	if (typeof window === 'undefined') return false;
	return window.__navalDebug === true || window.__navalDebug === 'verbose';
}

function _verbose() {
	return typeof window !== 'undefined' && window.__navalDebug === 'verbose';
}

export function navalLog(tag, fields) {
	if (!_enabled()) return;
	try {
		const parts = [];
		for (const k in fields) {
			const v = fields[k];
			parts.push(`${k}=${typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(1)) : v}`);
		}
		// Plain text, no %c styling — these lines get copied out of the console
		// and pasted into a bug report, and the style directive shows up as
		// literal noise when they are.
		console.log(`[NAVAL:${tag}] ${parts.join('  ')}`);
	} catch (e) { /* never let logging break the sim */ }
}

// High-frequency per-frame trace. Same output, second verbosity level.
export function navalTrace(tag, fields) {
	if (!_verbose()) return;
	navalLog(tag, fields);
}

// True for the munitions this tracing is about, so the hot paths can bail
// early without formatting anything.
export function isAntiShipRound(missile) {
	return !!(missile && missile.data && missile.data.seekerType === 'anti_ship');
}
