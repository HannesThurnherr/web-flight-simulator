// ============================================================================
// NPC pilot factories — one function per pilot strategy in the npcSystem.
//
// Called from npcSystem.spawnPlatform() via `makePilot(type, ...)`; the
// dispatcher picks the right factory per strategy name (orbit / static-
// sam / etc.). Each factory returns a plain object with:
//   .command     — PilotCommand the main NPC update loop reads
//   .subsystems  — optional map of AI subsystems (weapons, flares, …)
//   .update(ctx) — per-frame tick
//
// Extracted from npcSystem.js — closures + pure logic, no `this`
// dependency, so moving out of the class is a straight function move.
// ============================================================================

import { WeaponSubsystem } from './ai/subsystems.js';

// Dispatcher. `type` comes from the platform JSON's pilot.type field.
// Returns the pilot object the npcSystem caller attaches to the NPC.
export function makePilot(type, lon, lat, alt, params) {
	switch (type) {
		case 'orbit':
			return makeOrbitPilot(lon, lat, params.altitudeM ?? alt, params.radiusM ?? 40000);
		case 'static-sam':
			return makeStaticSamPilot(params);
		// Future:
		//   case 'patrol':   return makePatrolPilot(params.waypoints);
		//   case 'fighter':  return createFighterPilot(/* unit filled by caller */);
		default:
			console.warn('[npcSystem] unknown pilot type:', type);
			return makeOrbitPilot(lon, lat, alt, 40000);
	}
}

// Orbit pilot — holds a circle at a given altitude + radius around a
// centre point. Used by AWACS / tanker platforms. No weapons.
export function makeOrbitPilot(centerLon, centerLat, altitude, radiusM) {
	const command = {
		targetHeading: 0,
		targetPitch:   0,
		throttle:      0.6,
		targetSpeed:   180,   // AWACS cruise
		boost:         false,
		fireFlare:     false,
		fireWeapon:    false,
	};
	return {
		command,
		subsystems: {},
		update(context /*, dt */) {
			const npc = context.unit;
			const plat = centerLat * Math.PI / 180;
			const dE = (npc.lon - centerLon) * 111320 * Math.cos(plat);
			const dN = (npc.lat - centerLat) * 111320;
			const radius = Math.hypot(dE, dN);

			// Tangential heading to hold the orbit, with a gentle
			// radial correction so we don't drift inward/outward.
			const radialBearing = Math.atan2(dE, dN) * 180 / Math.PI;
			let headingCmd = (radialBearing + 90 + 360) % 360;
			const radialErr = radius - radiusM;
			// Small crab angle: up to 20° inward/outward nudge.
			headingCmd += Math.max(-20, Math.min(20, radialErr * 0.001));
			command.targetHeading = headingCmd;

			// Altitude hold (proportional, saturated).
			const altErr = altitude - npc.alt;
			command.targetPitch = Math.max(-5, Math.min(5, altErr * 0.01));
		},
	};
}

// Static SAM pilot — decides when to launch surface-to-air missiles.
//
// Runs on a ground-kind platform with:
//   - a long-range search radar (handled by sensorSystem via the
//     platform's own sensors.radar config); the radar populates
//     unit.contacts like any other observer
//   - a WeaponSubsystem containing exactly one surface-launch missile
//     entry (e.g. NASAMS-MSL) with a fixed magazine
//
// Real-world doctrine this tries to approximate (NASAMS / Patriot
// pattern): for each validated hostile track in envelope, fire a
// 2-missile salvo (ripple fire) to improve single-target Pk. When the
// magazine draws down below a conservation threshold, drop to single
// shots so the battery isn't left empty after one engagement. Track a
// per-target reengage cooldown so we don't dump the magazine pinging
// the same bandit; and cap simultaneous missiles-in-flight so a long
// track of targets is engaged serially, not all at once.
//
// Config (params):
//   missileType         weapon type string, e.g. "NASAMS-MSL"
//   magazine            initial + max ammo count
//   salvoSize           missiles per ripple-fire engagement (default 2)
//   conserveLastN       drop to single-shot when ammo ≤ this (default 2)
//   intraSalvoGapS      seconds between ripple-fire shots (default 1.2)
//   perTargetReengageS  seconds before re-engaging the same target
//   maxInFlight         hard cap on simultaneous live missiles
//   minRangeM / maxRangeM  engagement envelope (default NASAMS-ish)
export function makeStaticSamPilot(params) {
	const missileType = params.missileType || 'NASAMS-MSL';
	const magazine    = params.magazine    ?? 8;
	const salvoSize   = params.salvoSize   ?? 2;
	const conserveN   = params.conserveLastN ?? 2;
	const intraGap    = params.intraSalvoGapS ?? 1.2;
	const reengageT   = params.perTargetReengageS ?? 20;
	const maxInFlight = params.maxInFlight ?? 4;
	const minRange    = params.minRangeM ?? 1500;
	const maxRange    = params.maxRangeM ?? 25000;

	const weapons = new WeaponSubsystem({
		weapons: [{
			type: missileType,
			ammo: magazine, maxAmmo: magazine,
			// fireRate = intra-salvo gap. WeaponSubsystem.consume gates
			// on `now - lastFire >= fireRate`, so this doubles as the
			// "seconds between ripple-fired shots" constant.
			fireRate: intraGap,
			maxInFlight,
			lastFire: -Infinity,
			minRange, maxRange,
		}],
	});

	const command = {
		targetHeading: 0,
		targetPitch:   0,
		throttle:      0,
		targetSpeed:   0,
		boost:         false,
		fireFlare:     false,
		fireWeapon:    false,
		weaponType:    null,
		weaponTarget:  null,
		activeBehaviorName: 'StaticSAM',
	};

	// Closure state — carried across ticks. `_currentEngagement`
	// encodes "we committed to a salvo on this target; keep firing
	// until it's dead, out of envelope, or we've fired enough"; the
	// cooldown map prevents us from re-engaging the same target
	// moments after a salvo miss, which would otherwise let the
	// battery empty itself onto one lucky jinker.
	const pilotState = {
		lastAmmoSeen: magazine,
		currentEngagement: null,       // { target, plannedShots, shotsFired }
		engagementCooldown: new Map(), // target → sim-time of last engagement
	};

	function pickTarget(unit, weapon) {
		if (!unit.contacts) return null;
		let best = null;
		let bestRange = Infinity;
		for (const [target, c] of unit.contacts) {
			if (!target || target.destroyed || target.active === false) continue;
			if (target.team && unit.team && target.team === unit.team) continue;
			const sig = target.signature;
			if (!sig) continue;
			// Air-defence doctrine: SAMs don't shoot other SAMs, don't
			// engage live missiles, and don't engage ground targets.
			if (sig.unitClass === 'missile' || sig.unitClass === 'cruise_missile') continue;
			if (sig.unitClass === 'sam_site') continue;
			// Need a radar range for a firing solution. A purely
			// passive (IR / visual) detection isn't enough for an
			// active-radar SAM to hand off midcourse guidance.
			if (!c.radar) continue;
			const range = c.radar.range;
			if (range < weapon.minRange || range > weapon.maxRange) continue;
			if (range < bestRange) {
				best = { target, range };
				bestRange = range;
			}
		}
		return best;
	}

	return {
		command,
		subsystems: { weapons },
		update(context /*, dt */) {
			const unit = context.unit;
			const now  = context.now;
			const weapon = weapons.weapons[0];

			// Reset per-frame command intent; we'll only set fire
			// flags below when the doctrine machine says so.
			command.fireWeapon   = false;
			command.weaponType   = null;
			command.weaponTarget = null;

			// Detect shots fired since last tick by watching the ammo
			// delta. The actual spawn happens in npcSystem.update()'s
			// fire-gate block, which calls weapons.consume() — so the
			// pilot itself can't tell a shot succeeded except via ammo
			// change. This keeps the shot-counter consistent with the
			// real subsystem gate (cooldown, maxInFlight) rather than
			// incrementing optimistically.
			const fired = pilotState.lastAmmoSeen - weapon.ammo;
			if (fired > 0 && pilotState.currentEngagement) {
				pilotState.currentEngagement.shotsFired += fired;
			}
			pilotState.lastAmmoSeen = weapon.ammo;

			// Dry magazine = nothing to do. The battery will silently
			// sit and radiate; no reload plumbing exists yet.
			if (weapon.ammo <= 0) return;

			// ------------------------------------------------------
			// Continue an in-progress salvo, if any.
			// ------------------------------------------------------
			const eng = pilotState.currentEngagement;
			if (eng) {
				const t = eng.target;
				const stillAlive = t && !t.destroyed && t.active !== false;
				let keep = stillAlive && eng.shotsFired < eng.plannedShots;
				if (keep) {
					// Target must still be in our radar envelope —
					// if the bandit notches out, beams us, drops
					// behind a ridge, or flies out of max range, we
					// abort the salvo. Real batteries break
					// engagement the same way when illumination is
					// lost.
					const c = unit.contacts && unit.contacts.get(t);
					const inEnv = c && c.radar &&
						c.radar.range >= weapon.minRange &&
						c.radar.range <= weapon.maxRange;
					if (!inEnv) keep = false;
				}
				if (keep) {
					// Request another shot — WeaponSubsystem.consume
					// enforces the intra-salvo gap via fireRate, so
					// we can set fireWeapon every tick and the
					// subsystem will only actually consume at the
					// right cadence.
					command.fireWeapon   = true;
					command.weaponType   = weapon.type;
					command.weaponTarget = t;
					return;
				}
				// Salvo done (kill, envelope break, or plannedShots
				// met).
				pilotState.currentEngagement = null;
			}

			// ------------------------------------------------------
			// No active engagement — look for a fresh target.
			// ------------------------------------------------------
			const best = pickTarget(unit, weapon);
			if (!best) return;

			// Per-target reengage cooldown. If we just fired at this
			// bandit and didn't kill them, give the outcome of the
			// salvo time to play out before committing more missiles.
			const lastTime = pilotState.engagementCooldown.get(best.target);
			if (lastTime != null && now - lastTime < reengageT) return;

			// Magazine-conservation policy. When the launcher is
			// down to its last N missiles, switch to single-shot so
			// the battery doesn't empty itself on one engagement.
			const plannedShots = Math.min(
				(weapon.ammo <= conserveN) ? 1 : salvoSize,
				weapon.ammo,
			);

			pilotState.currentEngagement = {
				target: best.target,
				plannedShots,
				shotsFired: 0,
			};
			pilotState.engagementCooldown.set(best.target, now);

			command.fireWeapon   = true;
			command.weaponType   = weapon.type;
			command.weaponTarget = best.target;
		},
	};
}
