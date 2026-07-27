// ============================================================================
// Simulation time scale.
//
// Watching a naval engagement play out in real time means staring at a map for
// twenty minutes while two destroyers close at 16 m/s. This lets the commander
// view run the world faster.
//
// IMPLEMENTED AS SUB-STEPPING, NOT A BIGGER dt. The animate loop runs the whole
// sim update N times per rendered frame with the SAME dt it would have used at
// 1x, rather than once with N*dt. That matters: every integrator in the game —
// missile guidance, the swept-segment fuze checks, bullet hit tests, ship
// turn-rate limits — is a fixed-step Euler integrator whose accuracy depends on
// the step staying small. Multiplying dt by 8 would let a Mach-3 SM-6 jump
// ~200 m per step and tunnel straight through its target. Sub-stepping costs
// CPU linearly but keeps every physics result bit-identical to real time.
//
// Cost is real: 8x means eight full NPC/sensor/weapon passes per frame. The
// commander view is the intended home for it precisely because the player
// isn't flying and the frame budget is otherwise idle.
// ============================================================================

// Integers only — a fractional scale can't be expressed as whole sub-steps
// without reintroducing the variable-dt problem this design exists to avoid.
export const TIME_SCALES = [1, 2, 4, 8];

let _scale = 1;

export function getTimeScale() { return _scale; }

export function setTimeScale(n) {
	const v = Math.round(Number(n) || 1);
	_scale = TIME_SCALES.includes(v) ? v : 1;
	return _scale;
}

// Step to the next/previous scale in TIME_SCALES, clamped at the ends (rather
// than wrapping — accidentally cycling 8x → 1x mid-engagement is jarring).
export function stepTimeScale(dir) {
	const i = TIME_SCALES.indexOf(_scale);
	const next = Math.max(0, Math.min(TIME_SCALES.length - 1, i + (dir > 0 ? 1 : -1)));
	_scale = TIME_SCALES[next];
	return _scale;
}

export function resetTimeScale() { _scale = 1; return _scale; }
