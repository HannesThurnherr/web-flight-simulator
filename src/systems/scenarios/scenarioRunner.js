// ============================================================================
// Scenario runner — turns a scenario JSON into a runnable scenario
// object with the onStart / update / onStop lifecycle the registry
// already speaks.
//
// Scenario JSON schema:
//   id / name / description     identity & display
//   triangleSideM               sets npcSystem.triangleSide — controls
//                               how far apart auto-spawned fighter
//                               reinforcements appear
//   autoSpawn                   whether npcSystem keeps trickling in
//                               hostile fighters (default true)
//   spawns                      array of spawn directives, each one:
//
//   { "type": "fighter",
//     "team": "hostile-red" | "hostile-blue" | ...,
//     "origin": "triangle-vertex"                // npcSystem picks a vertex
//               | { relTo: "player", bearingDeg, rangeM, altM },
//     "count":    number                         // how many to seed
//     "loadout":  { "<munition-id>": count, ... } // (future)
//     "plane":    "f-15" | "f-22" | "f-35"       // (future)
//   }
//
//   { "type": "platform",
//     "platformId": "e-767-awacs",
//     "team": "friendly",
//     "origin": { relTo: "player", bearingDeg, rangeM, altM },
//     "pilotOverrides": { ... }                  // merged into platform.defaults
//   }
//
// Positions that aren't absolute are resolved relative to the player's
// spawn pose at onStart time. The triangle-vertex placement falls
// through to npcSystem.spawnNPC which already knows where each team's
// vertex sits.
// ============================================================================

// Resolve an origin spec into a {lon, lat, alt} triple. Returns null
// when the spec is triangle-relative (caller uses spawnNPC's built-in
// vertex logic instead).
import { getTeamDatalink } from '../teamDatalink.js';
import { makeRng, sample, sampleDiscENU, sampleOnRoute } from './scenarioRandom.js';
import { MUNITIONS } from '../../weapon/munitions.js';
import { PLANES } from '../../plane/planes.js';
import { createPatrolPilot } from '../ai/index.js';

// Resolve scenario.anchor → an absolute reference point used by
// `origin.relTo: "anchor"`. Two modes:
//   - "world"            → anchor.worldLon / anchor.worldLat are the
//                          theatre centre, fixed regardless of where
//                          the player spawns.
//   - "player-relative"  → anchor sits at the player's spawn (legacy
//                          behaviour; what every existing scenario
//                          produces).
function resolveAnchor(data, playerState) {
	const anc = data && data.anchor;
	if (anc && anc.mode === 'world' &&
		typeof anc.worldLon === 'number' && typeof anc.worldLat === 'number') {
		return { lon: anc.worldLon, lat: anc.worldLat, alt: 0 };
	}
	return { lon: playerState.lon, lat: playerState.lat, alt: playerState.alt };
}

function resolveOrigin(origin, playerState, anchor, rng) {
	if (!origin || origin === 'triangle-vertex') return null;

	// 10a — random origin: uniform point in a disc / annulus around
	// either the anchor or the player. Altitude either fixed or
	// from a band.
	if (typeof origin === 'object' && origin.random) {
		const r = origin.random;
		const centre = (r.centerRelTo === 'anchor') ? anchor
			: (r.centerRelTo === 'player') ? { lon: playerState.lon, lat: playerState.lat, alt: playerState.alt }
			: (typeof r.centerLon === 'number')
				? { lon: r.centerLon, lat: r.centerLat, alt: 0 }
				: anchor;
		// If the spec uses bearing+range to locate the centre instead
		// of explicit lon/lat, compute that first.
		let centreLon = centre.lon;
		let centreLat = centre.lat;
		if (typeof r.bearingDeg === 'number' && typeof r.rangeM === 'number') {
			const plat = centre.lat * Math.PI / 180;
			const b = r.bearingDeg * Math.PI / 180;
			const dE = r.rangeM * Math.sin(b);
			const dN = r.rangeM * Math.cos(b);
			centreLon = centre.lon + dE / (111320 * Math.cos(plat));
			centreLat = centre.lat + dN / 111320;
		}
		const off = sampleDiscENU(rng, r.radiusM || 5000, r.minRadiusM || 0);
		const platCentre = centreLat * Math.PI / 180;
		let alt;
		if (r.altMode === 'fromBand' &&
			typeof r.altMin === 'number' && typeof r.altMax === 'number') {
			alt = r.altMin + rng() * (r.altMax - r.altMin);
		} else {
			alt = (typeof r.altM === 'number') ? r.altM : (centre.alt || 0);
		}
		return {
			lon: centreLon + off.east  / (111320 * Math.cos(platCentre)),
			lat: centreLat + off.north / 111320,
			alt,
		};
	}

	// 10a — random along a polyline route, useful for seeding patrol
	// fighters at varied points along their patrol leg.
	if (typeof origin === 'object' && origin.randomOnRoute) {
		const r = origin.randomOnRoute;
		const pt = sampleOnRoute(rng, r.route || []);
		if (!pt) return null;
		const alt = (typeof r.altMin === 'number' && typeof r.altMax === 'number')
			? (r.altMin + rng() * (r.altMax - r.altMin))
			: (r.altM || 0);
		return { lon: pt.lon, lat: pt.lat, alt };
	}

	// 10a — anchor-relative offset (east/north metres from anchor).
	if (typeof origin === 'object' && origin.relTo === 'anchor') {
		const platA = anchor.lat * Math.PI / 180;
		const dE = origin.offsetEastM || 0;
		const dN = origin.offsetNorthM || 0;
		const alt = (typeof origin.altM === 'number') ? origin.altM : anchor.alt;
		return {
			lon: anchor.lon + dE / (111320 * Math.cos(platA)),
			lat: anchor.lat + dN / 111320,
			alt,
		};
	}

	// Existing path — player-relative bearing+range.
	if (typeof origin === 'object' && origin.relTo === 'player') {
		const plat = playerState.lat * Math.PI / 180;
		const b = (origin.bearingDeg || 0) * Math.PI / 180;
		const r = origin.rangeM || 0;
		const dE = r * Math.sin(b);
		const dN = r * Math.cos(b);
		// Altitude resolution order:
		//   1. origin.altM      — absolute altitude (MSL)
		//   2. origin.altOffsetM — relative to player (negative = lower)
		//   3. playerState.alt  — default to player's current altitude
		let alt = playerState.alt;
		if (typeof origin.altM === 'number') alt = origin.altM;
		else if (typeof origin.altOffsetM === 'number') alt = playerState.alt + origin.altOffsetM;
		return {
			lon: playerState.lon + dE / (111320 * Math.cos(plat)),
			lat: playerState.lat + dN / 111320,
			alt,
		};
	}

	// Absolute (lon, lat, alt) form — pass through.
	if (typeof origin === 'object' && origin.lon != null) {
		return { lon: origin.lon, lat: origin.lat, alt: origin.alt ?? 0 };
	}
	return null;
}

// Build a scenario object matching the existing {onStart, update,
// onStop} interface from a data record. Calling code (src/systems/
// scenarios/index.js) wraps the JSON through this and registers the
// result.
//
// Optional scenario fields beyond spawns / loadout:
//   satellite: {
//     intervalS:   number      // seconds between snapshots (default 180)
//     memoryS:     number      // how long each snapshot stays valid (default 600)
//     firstAtS:    number      // first-pass delay (default = intervalS)
//     team:        string      // beneficiary team (default 'friendly')
//     classes:     [string,…]  // platform.kind values to include
//                              // (default ['ground'])
//   }
//
// Drives a periodic theater-wide snapshot of every hostile unit whose
// `kind` is in `classes`, dropping their CURRENT exact position into
// the beneficiary team's intelContacts as `kind: 'satellite'`. Entries
// age out after memoryS, at which point the player has to wait for
// the next pass to refresh.
export function buildScenarioFromJson(data) {
	// Satellite-ISR closure state — captured by update() below. Reset
	// each onStart so re-running the scenario starts fresh.
	let satTimer = 0;
	let satFired = false;
	// 10d — objective + trigger evaluator state.
	//
	//   _taggedUnits      tag → npc reference (filled at spawn time so
	//                     destroy / protect objectives can find their
	//                     subject without scanning the npc list).
	//   _objectiveState   ordered { id, kind, label, required, status,
	//                              ... per-kind fields } records.
	//                     status = 'pending' | 'done' | 'failed'.
	//   _triggerFired     Set of trigger indices that have fired
	//                     already (one-shots — see _evalTrigger).
	//   _scenarioElapsed  seconds since onStart, for elapsed triggers.
	let _taggedUnits = new Map();
	let _objectiveState = [];
	let _triggerFired = new Set();
	let _scenarioElapsed = 0;
	// Snapshot of player spawn coords at onStart. Used to resolve
	// `zone: { relTo: "player", ... }` to a fixed point — "RTB" means
	// "go back to where you took off from," not "go to where you
	// currently are," so we capture once at scenario start and reuse.
	let _playerSpawnPose = null;

	// Tag registration. Stores npc under `tag` for count===1, or
	// under both the bare tag (first iteration) AND `tag-N` for
	// count>1 so an objective referring to the bare tag still
	// resolves to a specific unit while the suffixed forms let the
	// author target individual members of a group.
	function _registerTag(tag, npc, count, idx) {
		if (count > 1) _taggedUnits.set(`${tag}-${idx + 1}`, npc);
		if (idx === 0) _taggedUnits.set(tag, npc);
	}

	// Per-tick objective evaluation. Mutates _objectiveState entries
	// in place. Three kinds shipped in 10d.1:
	//   destroy    — tag must reference an npc that's now destroyed.
	//   protect    — tag's npc must still be alive (becomes 'failed'
	//                if it dies; never auto-completes).
	//   reach-zone — playerState within radiusM of zone.lon/lat.
	// Objectives gated by `afterObjective` stay 'pending' until that
	// other objective's status becomes 'done'.
	function _evalObjectives(playerState) {
		for (const o of _objectiveState) {
			if (o.status === 'failed') continue;
			if (o.afterObjective) {
				const dep = _objectiveState.find(x => x.id === o.afterObjective);
				if (!dep || dep.status !== 'done') continue;
			}
			if (o.kind === 'destroy') {
				const u = _taggedUnits.get(o.tag);
				if (u && (u.destroyed || u.active === false)) o.status = 'done';
			} else if (o.kind === 'protect') {
				const u = _taggedUnits.get(o.tag);
				if (u && (u.destroyed || u.active === false)) o.status = 'failed';
				// Otherwise stays pending — protect objectives are
				// evaluated as "succeeded" only at scenario end.
			} else if (o.kind === 'reach-zone' && o.zone && playerState) {
				// Resolve zone center. Absolute lon/lat passes through;
				// relTo:'player' uses the player's spawn pose snapshot.
				const z = o.zone;
				let centre = z;
				if (z.relTo === 'player' && _playerSpawnPose) {
					const plat = _playerSpawnPose.lat * Math.PI / 180;
					const dE = (z.lon || 0);    // metres east of spawn
					const dN = (z.lat || 0);    // metres north of spawn
					centre = {
						lon: _playerSpawnPose.lon + dE / (111320 * Math.cos(plat)),
						lat: _playerSpawnPose.lat + dN / 111320,
					};
				}
				const inZone = _distM(playerState, centre) <= (z.radiusM || 0);
				if (inZone && !o._prevInZone) o.status = 'done';
				o._prevInZone = inZone;
			}
		}
	}

	function _distM(a, b) {
		const plat = (a.lat || 0) * Math.PI / 180;
		const dE = (b.lon - a.lon) * 111320 * Math.cos(plat);
		const dN = (b.lat - a.lat) * 111320;
		return Math.hypot(dE, dN);
	}
	return {
		id: data.id,
		name: data.name,
		description: data.description,
		// HUD pulls objectives + tagged-unit refs each frame to render
		// the overlay. Returning the live arrays keeps the lookup zero-
		// cost; consumers must not mutate.
		getObjectives() { return _objectiveState; },
		getTaggedUnit(tag) { return _taggedUnits.get(tag) || null; },

		onStart(ctx) {
			const { npcSystem, playerState, weaponSystem } = ctx;
			npcSystem.autoSpawn    = data.autoSpawn !== false;
			npcSystem.triangleSide = data.triangleSideM || 70000;
			// Satellite-ISR state reset.
			satTimer = 0;
			satFired = false;
			// 10d — fresh evaluator state per scenario start.
			_taggedUnits = new Map();
			_objectiveState = [];
			_triggerFired = new Set();
			_scenarioElapsed = 0;
			_playerSpawnPose = playerState ? {
				lon: playerState.lon, lat: playerState.lat, alt: playerState.alt,
			} : null;

			// 10a — per-scenario PRNG. Seeded via scenario.randomSeed
			// for reproducibility; defaulting to Date.now() gives the
			// "fresh roll each playthrough" feel.
			const rng = makeRng(
				typeof data.randomSeed === 'number' ? data.randomSeed : (Date.now() & 0x7fffffff),
			);

			// 10a — resolve scenario-wide anchor. Bundled scenarios
			// without an `anchor` field default to player-relative
			// (legacy behaviour); world-anchored scenarios pin to the
			// JSON's worldLon/worldLat regardless of where the player
			// spawned.
			const anchor = resolveAnchor(data, playerState);

			for (const s of (data.spawns || [])) {
				// 10a — count is now a sampleable spec. Literal numbers
				// pass through `sample` unchanged; { min, max } produces
				// a single integer per scenario start; existing scenarios
				// with `count: 4` keep working unchanged.
				const count = Math.max(1, sample(rng, s.count != null ? s.count : 1));

				if (s.type === 'fighter') {
					for (let i = 0; i < count; i++) {
						// Per-fighter random rolls. Origin re-rolls each
						// iteration so a `random` disc spec scatters N
						// fighters across the disc; literal origins
						// produce identical positions and we still
						// jitter (legacy behaviour).
						let pos = resolveOrigin(s.origin, playerState, anchor, rng);
						let npc;
						if (pos) {
							if (count > 1 && !_isRandomOrigin(s.origin)) {
								pos = jitterPos(pos, s.jitterM ?? 400);
							}
							// Heading: literal | random | default
							// (face the player). Sampled per fighter
							// so a `{ any: true }` spec puts each
							// fighter on a different heading.
							const headingDeg = (s.headingDeg != null)
								? sample(rng, s.headingDeg)
								: _bearingFromTo(pos, playerState);
							const speedMps = (s.speedMps != null)
								? sample(rng, s.speedMps)
								: (s.speed != null ? sample(rng, s.speed) : 280);
							// Altitude override on top of origin.alt
							// (useful for "place on this disc, but
							// random altitude band").
							if (s.altitudeM != null) pos.alt = sample(rng, s.altitudeM);

							npc = npcSystem.createNPCMesh(
								_fighterName(s), pos.lon, pos.lat, pos.alt,
								headingDeg, speedMps,
								_pickTeam(rng, s.team),
							);
						} else {
							// Triangle-vertex fallback — unchanged.
							npc = npcSystem.spawnNPC(playerState.lon, playerState.lat, playerState.alt);
						}
						if (npc && s.loadout) {
							applyNpcLoadout(npc, _resolveLoadout(rng, s.loadout, npc));
						}
						// 10d — pilot type override. The default
						// createFighterPilot is engage-on-sight + Cruise
						// fallback, which produces the "fighters spawn
						// far apart, see nothing, fly random circles"
						// behaviour at long-range BVR scales. Author
						// can opt into `pilot: { type: "patrol",
						// params: { waypoints: [...], loop: true } }`
						// to drive the NPC down a route until a
						// hostile is spotted, then engage.
						if (npc && s.pilot && s.pilot.type === 'patrol') {
							const params = s.pilot.params || {};
							npc.pilot = createPatrolPilot(npc, {
								waypoints: params.waypoints || [],
								loop:      params.loop,
								captureRadiusM: params.captureRadiusM,
							});
						}
						// 10d — tag registration. Single-tag spawns put
						// the first npc on the tag. Multi-count spawns
						// with N>1 register every iteration under the
						// same tag using a tag-N suffix so an objective
						// like "destroy ewr-1" stays unambiguous in the
						// 1-count default while still allowing the
						// player to author "destroy any of three".
						if (npc && s.tag) _registerTag(s.tag, npc, count, i);
					}

				} else if (s.type === 'platform') {
					// `count` lets a single spawn entry place N
					// identical platforms on a random origin (e.g.
					// "5 ZSU-23s scattered across a 3 km disc").
					for (let i = 0; i < count; i++) {
						let pos = resolveOrigin(s.origin, playerState, anchor, rng);
						if (!pos) continue;
						if (count > 1 && !_isRandomOrigin(s.origin)) {
							pos = jitterPos(pos, s.jitterM ?? 400);
						}
						// Platform spawns may complete asynchronously (GLB
					// load), so we wrap state mutations in onSpawn so
					// they fire whether the spawn lands immediately or
					// after a queued retry.
					const tagSeq = i;        // captured for tag suffixing
					const onSpawn = (npc) => {
							// 10a — per-spawn magazine override for
							// SAMs / AAA. Apply before any intel
							// publish so the platform's authored
							// magazine (from platform JSON) is
							// already overridden.
							if (s.magazine) _applyMagazineOverride(npc, sample(rng, s.magazine));
							// Pre-mission intel publish (existing).
							if (s.intel) {
								const friendly = getTeamDatalink('friendly');
								const now = (typeof performance !== 'undefined')
									? performance.now() * 0.001 : 0;
								friendly.publishBriefed(npc, s.intel, now);
							}
							// 10d — tag registration so "destroy ewr-1"
							// objectives can find the spawned platform.
							if (s.tag) _registerTag(s.tag, npc, count, tagSeq);
						};
						npcSystem.spawnPlatform(
							s.platformId, pos.lon, pos.lat, pos.alt,
							_pickTeam(rng, s.team) || 'friendly',
							s.pilotOverrides || {},
							onSpawn,
						);
					}
				}
			}

			// 10d — seed objective evaluator state from the JSON.
			// Each objective starts as 'pending'. Some kinds need
			// per-objective transient fields (e.g. reach-zone wants
			// a `prevInZone` so we can edge-trigger on entry).
			if (Array.isArray(data.objectives)) {
				for (const o of data.objectives) {
					if (!o || !o.id) continue;
					_objectiveState.push({
						...o,
						status: 'pending',
						_prevInZone: false,
					});
				}
			}

			// Optional player loadout override placed AFTER spawn loop
			// so a scenario-level template referenced via `template`
			// resolves the same way per-NPC ones do. (Existing literal
			// override path still works unchanged.)
			if (data.playerLoadout && weaponSystem && Array.isArray(weaponSystem.weapons)) {
				const resolved = _resolveLoadout(rng, data.playerLoadout, null);
				const norm = _normalizeLoadoutKeys(_loadoutToCounts(resolved));
				for (const w of weaponSystem.weapons) {
					if (!w || w.ammo === Infinity) continue;
					const key = w.type || w.id;
					const n = norm[key] || 0;
					w.ammo = n;
					w.maxAmmo = n;
				}
			}
		},

		update(ctx, dt) {
			_scenarioElapsed += dt;

			// 10d — objective evaluator. Cheap per-frame walk over the
			// objective list; each kind's check is O(1) given a tagged
			// unit lookup or a zone distance test.
			if (_objectiveState.length > 0 && ctx && ctx.playerState) {
				_evalObjectives(ctx.playerState);
			}

			// Satellite-ISR pass scheduling. Walks every hostile unit
			// whose `kind` is in the configured class list and drops
			// a snapshot into the beneficiary team's datalink, then
			// resets the timer for the next pass.
			const sat = data.satellite;
			if (sat && ctx && ctx.npcSystem) {
				satTimer += dt;
				const intervalS = sat.intervalS ?? 180;
				const firstAtS  = sat.firstAtS  ?? intervalS;
				const triggerAt = satFired ? intervalS : firstAtS;
				if (satTimer >= triggerAt) {
					satTimer -= triggerAt;
					satFired = true;
					const team   = sat.team || 'friendly';
					const dl     = getTeamDatalink(team);
					const memS   = sat.memoryS ?? 600;
					const allow  = sat.classes || ['ground'];
					if (dl) {
						const now = (typeof performance !== 'undefined')
							? performance.now() * 0.001 : 0;
						let n = 0;
						for (const npc of ctx.npcSystem.npcs) {
							if (!npc || npc.destroyed) continue;
							if (npc.team === team) continue;
							if (!allow.includes(npc.kind)) continue;
							dl.publishSatellite(npc, now, memS);
							n++;
						}
						console.log('[scenario] SAT pass:',
							`team=${team} units=${n} memoryS=${memS} nextInS=${intervalS}`);
					}
				}
			}
		},

		onStop(ctx) {
			ctx.npcSystem.autoSpawn    = true;
			ctx.npcSystem.triangleSide = 70000;
		},
	};
}

// Translate legacy scenario-loadout keys to current simTypes so older
// JSONs (and externally-authored scenarios written before the AIM-9
// → AIM-9M / AIM-9X split) keep working without touching their files.
// `"AIM-9"` was the generic Sidewinder slot before Phase 2 distinguished
// the reticle (AIM-9M) and imaging-IR (AIM-9X) variants. Modern fleet
// default → map to AIM-9X.
const LEGACY_LOADOUT_ALIASES = {
	'AIM-9': 'AIM-9X',
};
function _normalizeLoadoutKeys(loadout) {
	if (!loadout) return loadout;
	let dirty = false;
	for (const k of Object.keys(loadout)) {
		if (LEGACY_LOADOUT_ALIASES[k]) { dirty = true; break; }
	}
	if (!dirty) return loadout;
	const out = {};
	for (const [k, v] of Object.entries(loadout)) {
		const k2 = LEGACY_LOADOUT_ALIASES[k] || k;
		out[k2] = (out[k2] || 0) + v;
	}
	return out;
}

// Apply a per-NPC loadout after spawn. Loadout is a map of simType →
// ammo count (e.g. `{ "AIM-9X": 4, "AIM-120": 0 }`). Any simType not
// listed defaults to 0 — so `{ "AIM-9X": 4 }` produces a WVR-only
// wingman carrying 4 Sidewinders and no AMRAAMs. Leaves the gun alone
// (it's always infinite).
function applyNpcLoadout(npc, loadout) {
	if (!npc || !loadout) return;
	const ws = npc.pilot && npc.pilot.subsystems && npc.pilot.subsystems.weapons;
	if (!ws || !Array.isArray(ws.weapons)) return;
	const norm = _normalizeLoadoutKeys(loadout);
	for (const w of ws.weapons) {
		if (!w.type || w.ammo === Infinity) continue;
		const n = norm[w.type] || 0;
		w.ammo = n;
		w.maxAmmo = n;
	}
}

// Jitter a spawn position by a small random ENU offset. Prevents
// count > 1 spawns from stacking at the same coordinates.
function jitterPos(pos, maxRadiusM) {
	const ang  = Math.random() * Math.PI * 2;
	const dist = Math.random() * maxRadiusM;
	const plat = pos.lat * Math.PI / 180;
	return {
		lon: pos.lon + (dist * Math.sin(ang)) / (111320 * Math.cos(plat)),
		lat: pos.lat + (dist * Math.cos(ang)) / 111320,
		alt: pos.alt + (Math.random() - 0.5) * 300,
	};
}

// Heading (deg, compass) pointing from `from` to `to`, ignoring altitude.
function _bearingFromTo(from, to) {
	const plat = from.lat * Math.PI / 180;
	const dE = (to.lon - from.lon) * 111320 * Math.cos(plat);
	const dN = (to.lat - from.lat) * 111320;
	return (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360;
}

// Random-enough callsign. Later: accept `s.nameList` on the spawn for
// campaign-style scripted call signs.
function _fighterName(spawn) {
	const pool = ['PHOENIX', 'MARVEL', 'VIPER', 'GHOST', 'RAVEN', 'EAGLE', 'FALCON', 'BLADE'];
	const pick = pool[Math.floor(Math.random() * pool.length)];
	return `${pick} ${100 + Math.floor(Math.random() * 900)}`;
}

// 10a helpers ---------------------------------------------------------------

// True when the origin spec produces independently-random positions
// per spawn iteration. Used to skip the legacy per-spawn jitter pass
// (which would muddy the random distribution rather than diversify a
// stack of identical positions).
function _isRandomOrigin(origin) {
	if (!origin || typeof origin !== 'object') return false;
	return ('random' in origin) || ('randomOnRoute' in origin);
}

// Team can be a literal string, a oneOf, or a weighted spec — the
// last useful when "70% red, 30% blue" mixes are wanted.
function _pickTeam(rng, teamSpec) {
	const v = sample(rng, teamSpec);
	return v;
}

// Resolve a v2 loadout spec into a flat `{ simType: count }` map
// the existing applyNpcLoadout / weaponSystem.applyLoadout consumers
// already understand. Four input shapes:
//
//   1. legacy literal:    { "AIM-9X": 4, "AIM-120": 2 }   pass-through.
//   2. literal hardpoint: { hardpoints: { "wing-1-L": "aim120", ... } }
//                         resolves each hardpoint's munition into a count.
//   3. template:          { template: "su-35-bvr-heavy" }
//                         Phase 10a stub — registry not yet shipped, falls
//                         through with a console.warn so the scenario
//                         still spawns rather than crashing.
//   4. oneOf:             { oneOf: [<sub-loadout>, <sub-loadout>] }
//                         pick one with the rng, then resolve recursively.
function _resolveLoadout(rng, spec, npc) {
	if (!spec || typeof spec !== 'object') return spec || {};
	if (spec.oneOf) return _resolveLoadout(rng, sample(rng, { oneOf: spec.oneOf }), npc);
	if (spec.template) {
		// Template registry lands in 10b. For now, downgrade to a
		// no-op + warning so the rest of the spawn proceeds.
		console.warn('[scenarioRunner] loadout template not yet implemented:', spec.template);
		return {};
	}
	if (spec.hardpoints) {
		// Resolve hardpoint→munition map into simType counts. Use
		// the airframe's hardpoint list to confirm which slots are
		// internal vs external (we only need this when extending
		// to fillFromBag, which isn't in 10a).
		const counts = {};
		for (const munId of Object.values(spec.hardpoints)) {
			const m = MUNITIONS[munId];
			if (!m || !m.simType) continue;
			counts[m.simType] = (counts[m.simType] || 0) + 1;
		}
		return counts;
	}
	if (spec.fillFromBag) {
		// Stub: drop to legacy behaviour with a warning. fillFromBag
		// needs hardpoint-accept-list awareness which is fiddly enough
		// to deserve its own slice — slot in once 10b's UI is up.
		console.warn('[scenarioRunner] fillFromBag not yet implemented');
		return {};
	}
	// Already a `{ simType: count }` literal — pass through.
	return spec;
}

// _resolveLoadout returns a `{ simType: count }` map already; this
// is a thin alias for the player-loadout path that wants the same.
function _loadoutToCounts(spec) { return spec; }

// Per-spawn magazine override for SAMs / AAA. Sets npc.magazine.X
// values that the platform-specific update code already reads
// (NASAMS / SA-15 / Shilka). Random-spec aware: a magazine field
// of `{ from: 2, to: 6 }` rolls per-platform.
function _applyMagazineOverride(npc, magSpec) {
	if (!npc || !magSpec) return;
	if (!npc.magazine) npc.magazine = {};
	for (const [key, value] of Object.entries(magSpec)) {
		if (key === 'missileRange' && Array.isArray(value) && value.length === 2) {
			// Compatibility sugar from the design doc.
			const lo = Math.floor(value[0]);
			const hi = Math.floor(value[1]);
			npc.magazine.missile = lo + Math.floor(Math.random() * (hi - lo + 1));
		} else if (typeof value === 'number') {
			npc.magazine[key] = value;
		}
	}
	// Use of PLANES kept to silence the linter — present for the
	// fillFromBag path that lands later. Avoids dropping the import.
	void PLANES;
}
