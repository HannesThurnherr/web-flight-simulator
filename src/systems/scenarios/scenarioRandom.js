// ============================================================================
// Random spec resolver — Phase 10a.
//
// Anywhere a literal value appears in a scenario JSON (counts,
// bearings, ranges, altitudes, headings, speeds, munition picks),
// the v2 schema lets the author swap in a small "random spec"
// object instead. This module is the central place that interprets
// those specs and rolls them once per scenario start.
//
// Spec forms:
//   { "from": 100,  "to": 500 }           — uniform real in [from, to]
//   { "min": 2,     "max": 5 }            — uniform integer in [min, max] inclusive
//   { "any": true }                        — uniform real in [0, 360) (headings)
//   { "oneOf": ["a","b","c"] }             — uniform pick from list
//   { "weighted": [["a",3],["b",1]] }      — weighted pick
//   <primitive>                            — passed through unchanged
//
// Anything else returns the input unchanged so callers can lazily
// route everything through `sample(rng, value)` and let literals
// fall through.
//
// All randomness flows through a single seedable PRNG so the same
// scenario + seed produces identical spawns every time. The seed
// comes from `scenario.randomSeed`; if missing, we use Date.now()
// at the moment scenarioRunner.onStart() fires (different each
// playthrough — the standard "fresh roll" feel).
// ============================================================================

// Mulberry32 — small, fast, well-distributed enough for scenario use.
// Single 32-bit state, seedable, no external deps. Don't use this for
// crypto; for "should this fighter carry an R-77 or an R-37" it's
// perfect.
export function makeRng(seed) {
	let s = (seed >>> 0) || 1;
	return function rng() {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// Detect random-spec shape. Anything that isn't a recognised spec is
// treated as a literal pass-through.
function isRandomSpec(v) {
	if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
	return ('from' in v) || ('min' in v) || ('any' in v)
		|| ('oneOf' in v) || ('weighted' in v);
}

// Roll a random spec to a concrete value. Literals are passed
// through unchanged. Unknown shapes fall through too — caller can
// rely on `sample` being safe to apply to anything.
export function sample(rng, spec) {
	if (!isRandomSpec(spec)) return spec;
	if ('from' in spec && 'to' in spec) {
		return spec.from + rng() * (spec.to - spec.from);
	}
	if ('min' in spec && 'max' in spec) {
		// Inclusive integer range. Add 1 because rng() never reaches 1.0,
		// so floor(rng() * (max - min + 1)) lands evenly on every int.
		const lo = Math.floor(spec.min);
		const hi = Math.floor(spec.max);
		return lo + Math.floor(rng() * (hi - lo + 1));
	}
	if (spec.any === true) return rng() * 360;
	if (Array.isArray(spec.oneOf) && spec.oneOf.length > 0) {
		return spec.oneOf[Math.floor(rng() * spec.oneOf.length)];
	}
	if (Array.isArray(spec.weighted) && spec.weighted.length > 0) {
		// Each entry is [value, weight]. Sum weights, pick.
		let total = 0;
		for (const [, w] of spec.weighted) total += Math.max(0, w);
		if (total <= 0) return spec.weighted[0][0];
		let r = rng() * total;
		for (const [value, w] of spec.weighted) {
			r -= Math.max(0, w);
			if (r <= 0) return value;
		}
		return spec.weighted[spec.weighted.length - 1][0];
	}
	return spec;
}

// Convenience: sample N independent rolls of the same spec. Used when
// a spawn has `count` random and we re-roll position / heading /
// loadout per fighter.
export function sampleN(rng, spec, n) {
	const out = [];
	for (let i = 0; i < n; i++) out.push(sample(rng, spec));
	return out;
}

// Pick a uniform random point in a disc (or annulus) of radius
// `radiusM` (with optional inner `minRadiusM`) around the origin.
// Returns ENU east/north metres. Used by origin.random in
// scenarioRunner.
export function sampleDiscENU(rng, radiusM, minRadiusM = 0) {
	const r0sq = minRadiusM * minRadiusM;
	const r1sq = radiusM * radiusM;
	const r = Math.sqrt(r0sq + rng() * (r1sq - r0sq));
	const a = rng() * Math.PI * 2;
	return { east: r * Math.sin(a), north: r * Math.cos(a) };
}

// Pick a random point along a polyline, uniformly weighted by
// segment length. Polyline is [{lon, lat}, ...]. Returns the same
// shape (no altitude — caller layers that on top).
export function sampleOnRoute(rng, polyline) {
	if (!Array.isArray(polyline) || polyline.length < 2) return polyline?.[0] || null;
	// Compute cumulative lengths.
	const lens = [];
	let total = 0;
	for (let i = 1; i < polyline.length; i++) {
		const a = polyline[i - 1], b = polyline[i];
		const dLon = b.lon - a.lon;
		const dLat = b.lat - a.lat;
		const l = Math.hypot(dLon, dLat);
		lens.push(l);
		total += l;
	}
	if (total <= 0) return polyline[0];
	let r = rng() * total;
	for (let i = 0; i < lens.length; i++) {
		if (r <= lens[i]) {
			const t = lens[i] > 0 ? r / lens[i] : 0;
			const a = polyline[i], b = polyline[i + 1];
			return {
				lon: a.lon + (b.lon - a.lon) * t,
				lat: a.lat + (b.lat - a.lat) * t,
			};
		}
		r -= lens[i];
	}
	return polyline[polyline.length - 1];
}
