// ============================================================================
// Air-defence hit-rate tracker (diagnostic).
//
// Counts, per AD platform type × target column, how many weapons it FIRED and
// how many SCORED A HIT. The target column is 'aircraft' for air-breathers, or
// the munition's simType (AGM-88, STORM-SHADOW, GBU-39, AIM-120, …) so you can
// see exactly what a battery can and can't intercept — e.g. whether an SA-15
// Tor is whiffing on AGM-88s and Storm Shadows specifically.
//
// A "shot" is one launched weapon (each SAM interceptor, each AAA round),
// stamped with the intended target's column at launch. A "hit" is that weapon
// detonating on a target. The full matrix is printed to the console on every
// hit so you can copy the last one once a scenario is done.
//
// Console helpers: window.__adStats.print() / .reset().
// ============================================================================

const MUNITION_CLASSES = new Set(['missile', 'cruise_missile', 'bomb']);
const AIR_CLASSES = new Set([
	'fighter', 'stealth_fighter', 'stealth_bomber', 'awacs', 'cargo', 'drone_isr',
]);

// platformType (e.g. 'sa-15-tor') → Map<column, { shots, hits }>
const _stats = new Map();

// Which matrix column a target belongs to, or null if it isn't an AD target
// (air defence doesn't shoot ground units).
export function adTargetColumn(target) {
	if (!target) return null;
	const cls = target.signature && target.signature.unitClass;
	if (cls && MUNITION_CLASSES.has(cls)) return target.type || cls; // simType when we have it
	if (cls && AIR_CLASSES.has(cls)) return 'aircraft';
	return null;
}

function _cell(type, col) {
	let m = _stats.get(type);
	if (!m) { m = new Map(); _stats.set(type, m); }
	let c = m.get(col);
	if (!c) { c = { shots: 0, hits: 0 }; m.set(col, c); }
	return c;
}

export function recordAdShot(platformType, column) {
	if (!platformType || !column) return;
	_cell(platformType, column).shots++;
}

export function recordAdHit(platformType, column) {
	if (!platformType || !column) return;
	_cell(platformType, column).hits++;
	printAdMatrix();
}

export function resetAdStats() { _stats.clear(); }

// Plain-text matrix (copy-paste friendly).
export function printAdMatrix() {
	if (_stats.size === 0) { console.log('[AD hit-rate] no shots recorded yet'); return; }
	const cols = new Set();
	for (const m of _stats.values()) for (const k of m.keys()) cols.add(k);
	// aircraft first, then munition simTypes alphabetically.
	const colList = [...cols].sort((a, b) =>
		a === 'aircraft' ? -1 : b === 'aircraft' ? 1 : a.localeCompare(b));
	const W = 16, SYS = 18;
	const pad = (s, n) => String(s).padEnd(n);
	const lines = [
		'',
		'[AD hit-rate matrix]  cell = hits/shots (rate)',
		pad('SYSTEM', SYS) + colList.map(c => pad(c, W)).join(''),
	];
	for (const [type, m] of _stats) {
		const row = colList.map(c => {
			const cell = m.get(c);
			if (!cell || !cell.shots) return pad('·', W);
			return pad(`${cell.hits}/${cell.shots} (${Math.round(100 * cell.hits / cell.shots)}%)`, W);
		});
		lines.push(pad(type, SYS) + row.join(''));
	}
	console.log(lines.join('\n'));
}

if (typeof window !== 'undefined') {
	window.__adStats = { print: printAdMatrix, reset: resetAdStats, stats: _stats };
}
