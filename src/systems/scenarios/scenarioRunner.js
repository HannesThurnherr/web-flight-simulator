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
function resolveOrigin(origin, playerState) {
	if (!origin || origin === 'triangle-vertex') return null;
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
export function buildScenarioFromJson(data) {
	return {
		id: data.id,
		name: data.name,
		description: data.description,

		onStart(ctx) {
			const { npcSystem, playerState, weaponSystem } = ctx;
			npcSystem.autoSpawn    = data.autoSpawn !== false;
			npcSystem.triangleSide = data.triangleSideM || 70000;

			// Optional player loadout override. Same schema as the per-NPC
			// loadout: `{ "<simType>": count }`. Anything not listed drops
			// to 0 (guns are always infinite and are left alone). Lets a
			// scenario say "guns only" without touching the weapon registry.
			if (data.playerLoadout && weaponSystem && Array.isArray(weaponSystem.weapons)) {
				for (const w of weaponSystem.weapons) {
					if (!w || w.ammo === Infinity) continue;
					const key = w.type || w.id;
					const n = data.playerLoadout[key] || 0;
					w.ammo = n;
					w.maxAmmo = n;
				}
			}

			for (const s of (data.spawns || [])) {
				if (s.type === 'fighter') {
					const count = s.count || 1;
					for (let i = 0; i < count; i++) {
						let pos = resolveOrigin(s.origin, playerState);
						let npc;
						if (pos) {
							// Jitter when multiple fighters share a
							// spawn point so they don't stack exactly.
							// Default 400 m jitter radius for tight
							// dogfight groups; the scenario can override
							// via s.jitterM.
							if (count > 1) {
								pos = jitterPos(pos, s.jitterM ?? 400);
							}
							// Absolute-position fighter — createNPCMesh
							// bypasses the triangle logic. Heading faces
							// roughly inward toward player by default.
							const headingDeg = (s.headingDeg != null)
								? s.headingDeg
								: _bearingFromTo(pos, playerState);
							npc = npcSystem.createNPCMesh(
								_fighterName(s), pos.lon, pos.lat, pos.alt,
								headingDeg, s.speed ?? 280,
								s.team,
							);
						} else {
							// Triangle-vertex fallback — npcSystem picks
							// the team's vertex based on its bearing
							// table + current team balance.
							npc = npcSystem.spawnNPC(playerState.lon, playerState.lat, playerState.alt);
						}
						// Apply any per-NPC loadout override (e.g.
						// short-range-only for a WVR dogfight scenario).
						if (npc && s.loadout) applyNpcLoadout(npc, s.loadout);
					}
				} else if (s.type === 'platform') {
					const pos = resolveOrigin(s.origin, playerState);
					if (!pos) continue;
					npcSystem.spawnPlatform(
						s.platformId, pos.lon, pos.lat, pos.alt,
						s.team || 'friendly',
						s.pilotOverrides || {},
					);
				}
			}
		},

		update(/* ctx, dt */) {
			// Pure-data scenarios don't need per-frame logic — the
			// autoSpawn flag + pilot types handle ongoing behaviour.
		},

		onStop(ctx) {
			ctx.npcSystem.autoSpawn    = true;
			ctx.npcSystem.triangleSide = 70000;
		},
	};
}

// Apply a per-NPC loadout after spawn. Loadout is a map of simType →
// ammo count (e.g. `{ "AIM-9": 4, "AIM-120": 0 }`). Any simType not
// listed defaults to 0 — so `{ "AIM-9": 4 }` produces a WVR-only
// wingman carrying 4 Sidewinders and no AMRAAMs. Leaves the gun alone
// (it's always infinite).
function applyNpcLoadout(npc, loadout) {
	if (!npc || !loadout) return;
	const ws = npc.pilot && npc.pilot.subsystems && npc.pilot.subsystems.weapons;
	if (!ws || !Array.isArray(ws.weapons)) return;
	for (const w of ws.weapons) {
		if (!w.type || w.ammo === Infinity) continue;
		const n = loadout[w.type] || 0;
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
