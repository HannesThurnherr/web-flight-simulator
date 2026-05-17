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
		case 'static-aaa':
			return makeStaticAaaPilot(params);
		case 'ewr':
			return makeEwrPilot();
		case 'static-target':
			return makeStaticTargetPilot();
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
	// Optional engagement ceiling — max target altitude ABOVE the
	// launcher the battery will commit to. Off by default (Infinity):
	// real ceiling behaviour is better modelled by the missile's own
	// energy/drag running it out before intercept than by a hard
	// doctrine cutoff that makes the battery ignore targets the
	// debug overlay clearly shows it tracking. A scenario / platform
	// can still opt in via `engagementCeilingM` if desired.
	const ceilingAGL  = params.engagementCeilingM ?? Infinity;

	// Emissions discipline. When `emcon` is true, the SAM keeps its
	// own radar OFF until cued by the team datalink (e.g. an EWR has
	// painted an air target inside `cueRangeM`), then briefly powers
	// up to engage. Once the engagement resolves and no other cued
	// threats remain, radar drops back to silent. This is what lets
	// players use the "force them to radiate, then HARM them" tactic
	// — and it's why a real IADS leans on EWRs to do the looking
	// while the SAMs stay quiet.
	const emcon       = !!params.emcon;
	const cueRangeM   = params.cueRangeM ?? (maxRange * 1.4);
	// Hold radar on for a few seconds after the last cue drops, so we
	// don't strobe the antenna on/off every frame as a target sails
	// across the cue boundary.
	const emconHoldS  = params.emconHoldS ?? 3.0;
	// HARM-evade. When the SAM's own radar sees an inbound ANTI-
	// RADIATION missile within `harmEvadeDetectM`, it kills the radar
	// for `harmEvadeDurationS` regardless of cue state. Going dark
	// only defeats a weapon that homes on the emission — a HARM /
	// ALARM. It does nothing against a GPS JDAM, a laser bomb, a
	// cruise missile or an AMRAAM, so the SAM keeps radiating (and
	// keeps engaging) against those rather than blinding itself the
	// instant the strike package releases. The ARM seeker's memory
	// window (~10 s) is shorter than the shutdown wait, so a SAM
	// that drops promptly tends to survive the HARM and still be a
	// threat to subsequent passes.
	const harmEvadeDetectM    = params.harmEvadeDetectM    ?? 35000;
	const harmEvadeDurationS  = params.harmEvadeDurationS  ?? 12;

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
		// Emcon bookkeeping. `emconRadarOnUntil` is the sim-time the
		// hold timer expires; while we're past it AND there's no fresh
		// cue, the radar drops back to silent.
		emconRadarOnUntil: -Infinity,
		// HARM-evade. While `harmEvadeUntil` is in the future, the
		// radar is hard-suppressed regardless of cue state.
		harmEvadeUntil: -Infinity,
		// Throttle bookkeeping for the cue + HARM-detect checks. Both
		// walk contact maps and would otherwise run 60×/s for every
		// SAM in the scenario. 4 Hz is a tactically reasonable cadence
		// (a real SAM antenna doesn't slew or spin up faster than
		// that anyway) and keeps the per-frame cost out of the
		// frame-rate budget.
		lastModeCheckAt: -Infinity,
		cachedWantOn: false,
		cachedHarmEvade: false,
	};

	// Detect any inbound missile-class contact via the unit's own
	// radar (or its team datalink). If one is closing inside the
	// HARM-evade trigger range, returns true — the caller will
	// suppress radar emissions for several seconds.
	function harmEvadeTriggered(unit, ctx, now) {
		// Only trigger if the radar's actually on right now — once
		// it's already off the missile is going to memory mode and
		// re-shutting-down doesn't help.
		if (!unit.sensors?.radar?.active) return false;
		const cosLat = Math.cos((unit.lat || 0) * Math.PI / 180);
		const r2 = harmEvadeDetectM * harmEvadeDetectM;
		// Iterate own-radar contacts (the SAM sees the inbound HARM
		// like any other missile if it's not notched). Ground-launched
		// SAMs aren't air units, so they don't have RWR — pure radar.
		if (unit.contacts) {
			for (const [target, c] of unit.contacts) {
				if (!target || target.destroyed) continue;
				if (target.team && unit.team && target.team === unit.team) continue;
				const sig = target.signature;
				if (!sig) continue;
				// HARM-evade is specifically a response to ANTI-
				// RADIATION weapons homing on the battery's emissions.
				// Going dark only helps against something that needs
				// the radar lit to find you — a HARM / ALARM. Against
				// a GPS JDAM, a laser bomb, a cruise missile, or an
				// AMRAAM the SAM gains nothing by shutting down (those
				// don't track emissions) and would just blind itself
				// while the strike package walks in. The previous
				// "any missile/bomb inbound → go quiet" logic made the
				// whole IADS suicide-silent the moment the player
				// released ordnance, so they could overfly unengaged.
				// Identify ARMs by seeker type (covers future ALARM /
				// Kh-31P), with a simType fallback for safety.
				const seeker = target.data && target.data.seekerType;
				const isAntiRad = seeker === 'anti_radiation' ||
					target.type === 'AGM-88';
				if (!isAntiRad) continue;
				if (!c.radar) continue;
				const dE = (target.lon - unit.lon) * 111320 * cosLat;
				const dN = (target.lat - unit.lat) * 111320;
				const dU = (target.alt - unit.alt);
				const d2 = dE * dE + dN * dN + dU * dU;
				if (d2 < r2) return true;
			}
		}
		return false;
	}

	// Decide whether the radar should be radiating right now. Returns
	// true when:
	//   - we have an in-flight engagement (need our own track for
	//     midcourse / fuze)
	//   - the team datalink has a hostile air contact within cueRangeM
	//   - the hold timer hasn't expired yet (post-cue cooldown)
	function shouldRadarBeOn(unit, ctx, now) {
		if (pilotState.currentEngagement) return true;
		if (now < pilotState.emconRadarOnUntil) return true;
		const dl = ctx && ctx.teamDatalink;
		if (!dl) return false;
		const cosLat = Math.cos((unit.lat || 0) * Math.PI / 180);
		// Air targets only — SAMs don't engage missiles in flight,
		// other SAMs, ground units, or buildings. The set of signatures
		// we cue on:
		//   fighter, stealth_fighter, awacs, cargo
		// (cruise_missile too — small but still fair game for SHORAD.)
		const ENGAGEABLE = new Set([
			'fighter', 'stealth_fighter', 'awacs', 'cargo',
			'cruise_missile', 'bomb',
		]);
		for (const [target] of dl.allContacts()) {
			if (!target || target.destroyed || target.active === false) continue;
			if (target.team && unit.team && target.team === unit.team) continue;
			const sig = target.signature;
			if (!sig || !ENGAGEABLE.has(sig.unitClass)) continue;
			const dE = (target.lon - unit.lon) * 111320 * cosLat;
			const dN = (target.lat - unit.lat) * 111320;
			const dU = (target.alt - unit.alt);
			const range = Math.sqrt(dE * dE + dN * dN + dU * dU);
			if (range <= cueRangeM) return true;
		}
		return false;
	}

	// `now` lets the picker skip targets still inside their per-target
	// re-engage cooldown. Without this the picker would keep returning
	// the single closest contact (often a loitering recon drone over
	// the defended point) every frame; the caller saw it was on
	// cooldown and bailed the whole update — so a SAM that recently
	// shot at the drone would never fall through to engage the player
	// even with the player in-envelope and radar-tracked. Skipping
	// cooled-down targets here makes the picker naturally return the
	// next-best engageable contact instead.
	function pickTarget(unit, weapon, now) {
		if (!unit.contacts) return null;
		let best = null;
		let bestScore = Infinity;   // lower wins (range × class-priority)
		for (const [target, c] of unit.contacts) {
			if (!target || target.destroyed || target.active === false) continue;
			if (target.team && unit.team && target.team === unit.team) continue;
			const lastTime = pilotState.engagementCooldown.get(target);
			if (lastTime != null && now - lastTime < reengageT) continue;
			// Engagement ceiling — don't waste missiles on targets
			// above the battery's practical reach. Altitude is AGL
			// relative to the launcher so a SAM on a 600 m plateau
			// firing at a 14 km MSL target sees ~13.4 km, not 14.
			if (((target.alt || 0) - (unit.alt || 0)) > ceilingAGL) continue;
			const sig = target.signature;
			if (!sig) continue;
			// Air-defence doctrine. SAMs DO engage incoming cruise
			// missiles (Tor / NASAMS / Patriot are explicitly designed
			// for it — point + area defence vs PGMs is the whole
			// point). They do NOT engage:
			//   - live AAMs (`missile` unit class) — too small + too
			//     fast for ground SAMs to bother
			//   - other SAMs (`sam_site`) — friendly fire
			//   - ground / building / EWR class — not in their air
			//     picture
			if (sig.unitClass === 'missile') continue;
			if (sig.unitClass === 'sam_site') continue;
			// Need a radar range for a firing solution. A purely
			// passive (IR / visual) detection isn't enough for an
			// active-radar SAM to hand off midcourse guidance.
			if (!c.radar) continue;
			const range = c.radar.range;
			if (range < weapon.minRange || range > weapon.maxRange) continue;
			// Priority: aircraft > cruise missiles > bombs. Aircraft
			// are higher-value strategic threats; cruise missiles
			// have stand-off range; bombs are seconds-from-impact
			// but small (and a single bomb usually only kills one
			// asset, vs an aircraft that can kill many). The
			// multipliers shift the picker's "closer = better"
			// score so a 30 km cruise missile beats a 50 km fighter
			// but loses to a 25 km bomb terminal-diving on the SAM
			// itself.
			let classMul = 1.0;
			if (sig.unitClass === 'cruise_missile') classMul = 1.6;
			else if (sig.unitClass === 'bomb')      classMul = 0.7;
			const score = range * classMul;
			if (score < bestScore) {
				best = { target, range };
				bestScore = score;
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

			// ---- Mode check (throttled): HARM-evade + emcon cue ------
			// Both checks walk contact maps and previously ran every
			// frame. With N SAMs in a scenario the per-frame walking
			// added up to a measurable FPS cost. The decisions don't
			// need 60 Hz freshness — a real SAM antenna can't slew or
			// spin up at 60 Hz anyway — so cache the result and only
			// recompute every 0.25 s.
			const MODE_CHECK_INTERVAL = 0.25;
			if (unit.sensors && unit.sensors.radar) {
				if (now - pilotState.lastModeCheckAt >= MODE_CHECK_INTERVAL) {
					pilotState.lastModeCheckAt = now;
					pilotState.cachedHarmEvade = harmEvadeTriggered(unit, context, now);
					if (pilotState.cachedHarmEvade) {
						pilotState.harmEvadeUntil = now + harmEvadeDurationS;
					}
					if (emcon) {
						pilotState.cachedWantOn = shouldRadarBeOn(unit, context, now);
					}
				}
				const inHarmEvade = now < pilotState.harmEvadeUntil;
				if (inHarmEvade) {
					unit.sensors.radar.active = false;
				} else if (emcon) {
					if (pilotState.cachedWantOn) {
						unit.sensors.radar.active = true;
						pilotState.emconRadarOnUntil = now + emconHoldS;
					} else {
						unit.sensors.radar.active = false;
					}
				}
			}

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
			// pickTarget now skips targets still inside their
			// per-target reengage cooldown, so a recently-shot recon
			// drone no longer blocks the picker from falling through
			// to the player. `best` is therefore already cooldown-
			// clear; no extra cooldown gate needed here.
			const best = pickTarget(unit, weapon, now);
			if (!best) return;

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

// ============================================================================
// EWR (Early-Warning Radar) pilot.
//
// A fixed long-range radar with no weapons — its only job is to radiate
// and feed the team datalink. Every air contact it picks up gets fused
// into the team picture, which lets emcon-mode SAMs stay silent until
// the EWR cues them onto a target. Killing the EWR is the canonical
// SEAD opening move: it tears the IADS' eyes out without alerting the
// SAMs (which don't radiate while idle).
//
// No subsystems — sensorSystem.scanRadar reads `unit.sensors.radar`
// directly, the contacts populate `unit.contacts`, and teamDatalink.tick
// fuses them into the shared picture.
// ============================================================================
export function makeEwrPilot() {
	const command = {
		targetHeading: 0,
		targetPitch:   0,
		throttle:      0,
		targetSpeed:   0,
		boost:         false,
		fireFlare:     false,
		fireWeapon:    false,
		activeBehaviorName: 'EWR',
	};
	return {
		command,
		subsystems: {},
		update(/* context, dt */) {
			// Static, no weapons, no behaviour. Radar config in the
			// platform JSON is what makes this unit functionally
			// useful — it just needs to BE there with `radar.active`.
		},
	};
}

// ============================================================================
// Static target pilot.
//
// For non-radiating, non-shooting structures (command posts, supply
// depots, fuel tanks). The unit just exists to be hit; everything
// interesting happens in the platform's signature config (RCS,
// IR, visual size — used by attacker sensor pipelines and warhead PK)
// and in scenario objectives that reference it by tag.
// ============================================================================
export function makeStaticTargetPilot() {
	const command = {
		targetHeading: 0,
		targetPitch:   0,
		throttle:      0,
		targetSpeed:   0,
		boost:         false,
		fireFlare:     false,
		fireWeapon:    false,
		activeBehaviorName: 'StaticTarget',
	};
	return {
		command,
		subsystems: {},
		update(/* context, dt */) { /* nothing to do */ },
	};
}

// ============================================================================
// Static AAA pilot — radar-directed gun emplacement (ZSU-23 / Gepard /
// Pantsir gun mount class).
//
// Reuses the player gun mechanics: spawns Bullet entities through
// spawnNpcBullet at the same per-round cadence as the M61 (default
// fireRate 0.05 s). The chassis stays put; the "turret" pivots
// implicitly via cmd.gunHeading / gunPitch which override the bullet
// launch direction in npcUpdate. So the model doesn't twist — only
// the tracers fan out toward the lead solution.
//
// Burst pattern: real ZSU fires 0.5–1.5 s pulses with cooldown gaps.
// Modeled here with `burstS` (active burst length) + `burstGapS`
// (between bursts). During a gap, `cmd.fireWeapon` is suppressed so
// even though a target is in envelope, no rounds spawn — gives the
// AAA a recognizable rat-tat-tat-pause-tat rhythm.
//
// Lead solution borrows the same iterative bullet-flight-time loop
// the fighter EngageBehavior uses for tail-chase guns. Two passes
// converges at this range (effective AAA range ≤ 3 km, bullet
// flight-time < 2 s).
//
// Config (params):
//   magazine        total ammo count (default 2000 — typical Shilka load)
//   fireRate        seconds per round (default 0.05 — ~1200 rd/min sustained
//                   per barrel, 4 barrels)
//   minRangeM       lower envelope (default 200)
//   maxRangeM       upper envelope (default 3500 — combat-effective gun range)
//   burstS          active-fire burst length (default 0.8)
//   burstGapS       cooldown between bursts (default 1.0)
//   muzzleVelMps    bullet muzzle velocity over ground (default 1500;
//                   matches Bullet class default)
//   emcon           if true, radar follows the same on/off cueing as
//                   static-sam — silent until cued, then radiates while
//                   tracking. Defaults FALSE for AAA: the Gun Dish on
//                   a Shilka is short-range and continuously on in
//                   most doctrines.
//   cueRangeM       cue-on range when emcon=true (default = maxRangeM × 2)
//   emconHoldS      seconds after cue drop to keep radiating (default 3)
// ============================================================================
export function makeStaticAaaPilot(params = {}) {
	const magazine    = params.magazine    ?? 2000;
	const fireRate    = params.fireRate    ?? 0.05;
	const minRange    = params.minRangeM   ?? 200;
	const maxRange    = params.maxRangeM   ?? 3500;
	const burstS      = params.burstS      ?? 0.8;
	const burstGapS   = params.burstGapS   ?? 1.0;
	const muzzleVel   = params.muzzleVelMps ?? 1500;
	const emcon       = !!params.emcon;
	const cueRangeM   = params.cueRangeM   ?? (maxRange * 2);
	const emconHoldS  = params.emconHoldS  ?? 3.0;

	// Fire-control noise. Two sources of inaccuracy in real gun-radar
	// laying that an idealized lead solution doesn't model:
	//
	//   dispersionDeg    Per-shot aim spread. Mechanical wobble +
	//                    barrel droop + atmospheric. Rerolled every
	//                    frame so each bullet in a burst gets a fresh
	//                    random offset. Realistic 23 mm gun + radar
	//                    director gives ~0.4–0.8° at typical engagement
	//                    ranges; a 0.6° default produces a ~25 m miss
	//                    circle at 2 km, which dilutes per-shot Pk
	//                    against small cruise-missile cross-sections.
	//
	//   leadJitterMps    Bias added to the target's perceived velocity
	//                    when computing the lead solution. Models radar
	//                    track-quality noise: the AAA "thinks" the
	//                    target is doing 250±N m/s and aims slightly
	//                    behind / ahead of where it actually is.
	//                    Refreshed at each new burst (gap → active
	//                    transition) so a whole burst is committed to
	//                    the same wrong lead, and subsequent bursts
	//                    re-roll. This is the dominant Pk killer in
	//                    practice — without it, bullet dispersion alone
	//                    still hits roughly half the time because the
	//                    aim center is exactly correct.
	const dispersionDeg = params.dispersionDeg ?? 0.6;
	const leadJitterMps = params.leadJitterMps ?? 10;
	// Time between picking a new target and opening fire. Models
	// fire-control radar slew + track-acquire latency. Without it a
	// gun emplacement instantly retasks from a downed missile to the
	// next one in a saturation salvo, which is unrealistic — real
	// Shilka-class radars need a few seconds to settle on a fresh
	// track. Each new pick (target identity changes) restarts the
	// timer; sticking with the same target carries no extra delay.
	const acquisitionDelayS = params.acquisitionDelayS ?? 0;

	const weapons = new WeaponSubsystem({
		weapons: [{
			type: 'gun',
			ammo: magazine, maxAmmo: magazine,
			fireRate,
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
		gunHeading:    null,
		gunPitch:      null,
		activeBehaviorName: 'StaticAAA',
	};

	const pilotState = {
		burstStartedAt: -Infinity,
		burstActive: false,
		emconRadarOnUntil: -Infinity,
		// 4 Hz throttle for the cue check — AAA radars don't need 60 Hz
		// emcon decisions and walking the team-datalink contact map
		// every frame for every gun emplacement adds up.
		lastEmconCheckAt: -Infinity,
		cachedWantOn: false,
		// Lead-jitter bias for the current burst. Refreshed at each
		// new burst (gap → active transition) so the whole burst
		// commits to the same wrong lead and rolls fresh next time.
		leadBiasE: 0,
		leadBiasN: 0,
		leadBiasU: 0,
		// Fire-control acquisition state. `currentTarget` is the
		// target we're locked on (or warming up to fire on);
		// `acquireUntil` is the sim-time at which fire is unblocked.
		currentTarget: null,
		acquireUntil: -Infinity,
	};

	// Approximate Gaussian via average of three uniform samples — close
	// enough for fire-control noise modeling and avoids the visible
	// uniform-distribution edges. Returns ~N(0, 1/3) — multiply by the
	// desired stddev.
	function _g3() {
		return ((Math.random() + Math.random() + Math.random()) / 3) - 0.5;
	}

	function pickTarget(unit) {
		if (!unit.contacts) return null;
		let best = null;
		let bestRange = Infinity;
		for (const [target, c] of unit.contacts) {
			if (!target || target.destroyed || target.active === false) continue;
			if (target.team && unit.team && target.team === unit.team) continue;
			const sig = target.signature;
			if (!sig) continue;
			// AAA doctrine: engage aircraft + low-flying cruise
			// missiles + terminal-diving bombs. Don't shoot AAMs
			// (too small/fast for guns), other ground assets, or
			// SAMs. Real Shilkas + Phalanx-class CIWS engage all
			// these classes when in envelope.
			if (sig.unitClass === 'missile') continue;
			if (sig.unitClass === 'sam_site' || sig.unitClass === 'building' ||
				sig.unitClass === 'ground'   || sig.unitClass === 'ewr') continue;
			if (!c.radar) continue;
			const range = c.radar.range;
			if (range < minRange || range > maxRange) continue;
			if (range < bestRange) { best = target; bestRange = range; }
		}
		return best ? { target: best, range: bestRange } : null;
	}

	// Lead solution for a stationary shooter aiming at a moving target.
	// Returns {heading, pitch} (degrees) — the direction the turret
	// should point so a bullet at muzzleVel + 0 (shooter is static)
	// intersects the target's projected position.
	function computeLead(unit, target) {
		const cosLat = Math.cos(unit.lat * Math.PI / 180);
		const dE0 = (target.lon - unit.lon) * 111320 * cosLat;
		const dN0 = (target.lat - unit.lat) * 111320;
		const dU0 = (target.alt - unit.alt);
		// Target velocity in ENU (target carries heading/pitch/speed),
		// plus per-burst jitter so the lead solution misses by a
		// realistic margin. The jitter is regenerated each new burst
		// in the update loop.
		const tH = (target.heading || 0) * Math.PI / 180;
		const tP = (target.pitch   || 0) * Math.PI / 180;
		const tS = target.speed || 0;
		const tvE = Math.sin(tH) * Math.cos(tP) * tS + pilotState.leadBiasE;
		const tvN = Math.cos(tH) * Math.cos(tP) * tS + pilotState.leadBiasN;
		const tvU = Math.sin(tP) * tS + pilotState.leadBiasU;
		// Bullets exit at muzzleVel (shooter is stationary so no own-speed
		// boost). Iterate flight-time → projected position twice.
		let tof = Math.sqrt(dE0*dE0 + dN0*dN0 + dU0*dU0) / muzzleVel;
		for (let i = 0; i < 2; i++) {
			const lE = dE0 + tvE * tof;
			const lN = dN0 + tvN * tof;
			const lU = dU0 + tvU * tof;
			tof = Math.sqrt(lE*lE + lN*lN + lU*lU) / muzzleVel;
		}
		const leadE = dE0 + tvE * tof;
		const leadN = dN0 + tvN * tof;
		const leadU = dU0 + tvU * tof;
		const horiz = Math.sqrt(leadE * leadE + leadN * leadN);
		const heading = (Math.atan2(leadE, leadN) * 180 / Math.PI + 360) % 360;
		const pitch   = Math.atan2(leadU, horiz) * 180 / Math.PI;
		return { heading, pitch };
	}

	// Optional emcon: same logic as static-sam but with the AAA's own
	// cueRangeM. Inlined rather than extracted so the two pilots stay
	// independently configurable.
	function shouldRadarBeOn(unit, ctx, now) {
		if (now < pilotState.emconRadarOnUntil) return true;
		const dl = ctx && ctx.teamDatalink;
		if (!dl) return false;
		const cosLat = Math.cos((unit.lat || 0) * Math.PI / 180);
		const ENG = new Set(['fighter', 'stealth_fighter', 'awacs', 'cargo', 'cruise_missile']);
		for (const [target] of dl.allContacts()) {
			if (!target || target.destroyed || target.active === false) continue;
			if (target.team && unit.team && target.team === unit.team) continue;
			const sig = target.signature;
			if (!sig || !ENG.has(sig.unitClass)) continue;
			const dE = (target.lon - unit.lon) * 111320 * cosLat;
			const dN = (target.lat - unit.lat) * 111320;
			const dU = (target.alt - unit.alt);
			const range = Math.sqrt(dE * dE + dN * dN + dU * dU);
			if (range <= cueRangeM) return true;
		}
		return false;
	}

	return {
		command,
		subsystems: { weapons },
		update(context /*, dt */) {
			const unit = context.unit;
			const now  = context.now;
			const weapon = weapons.weapons[0];

			command.fireWeapon  = false;
			command.weaponType  = null;
			command.weaponTarget = null;
			command.gunHeading  = null;
			command.gunPitch    = null;

			// Emcon (off by default — most AAA radars stay on).
			// Throttled to 4 Hz; cached `wantOn` reused across frames.
			if (emcon && unit.sensors && unit.sensors.radar) {
				if (now - pilotState.lastEmconCheckAt >= 0.25) {
					pilotState.lastEmconCheckAt = now;
					pilotState.cachedWantOn = shouldRadarBeOn(unit, context, now);
				}
				if (pilotState.cachedWantOn) {
					unit.sensors.radar.active = true;
					pilotState.emconRadarOnUntil = now + emconHoldS;
				} else {
					unit.sensors.radar.active = false;
				}
			}

			if (weapon.ammo <= 0) return;

			const pick = pickTarget(unit);
			if (!pick) {
				// No target — break out of any active burst, and
				// drop the locked target so the next acquisition
				// pays the full delay again.
				pilotState.burstActive = false;
				pilotState.currentTarget = null;
				return;
			}

			// Target re-tasking: a NEW target restarts the radar's
			// acquisition timer. Sticking with the same target (still
			// in envelope) has no penalty.
			if (acquisitionDelayS > 0 && pick.target !== pilotState.currentTarget) {
				pilotState.currentTarget = pick.target;
				pilotState.acquireUntil = now + acquisitionDelayS;
				// Drop any active burst — fresh target means stop
				// firing on the old line of bearing.
				pilotState.burstActive = false;
				pilotState.burstStartedAt = -Infinity;
			}
			if (now < pilotState.acquireUntil) {
				// Still slewing the radar / building track. Aim at
				// the target so the visual gun barrel tracks (handled
				// downstream by gunHeading/gunPitch), but do not fire.
				const slewLead = computeLead(unit, pick.target);
				command.fireWeapon = false;
				command.gunHeading = slewLead.heading;
				command.gunPitch   = slewLead.pitch;
				return;
			}

			// Burst-fire pattern: switch between active and gap states
			// based on burstS / burstGapS. While in gap state, suppress
			// fire even though a target is in envelope.
			if (!pilotState.burstActive) {
				if (now - pilotState.burstStartedAt >= burstS + burstGapS) {
					pilotState.burstActive = true;
					pilotState.burstStartedAt = now;
					// New burst: re-roll the lead-solution velocity
					// bias. Stddev = leadJitterMps in each ENU axis,
					// independently. Whole burst is committed to this
					// wrong lead so a target survives a burst, doesn't
					// just get hit by the lucky bullets in the middle.
					pilotState.leadBiasE = _g3() * leadJitterMps;
					pilotState.leadBiasN = _g3() * leadJitterMps;
					pilotState.leadBiasU = _g3() * leadJitterMps * 0.5;
				} else {
					return;
				}
			} else if (now - pilotState.burstStartedAt > burstS) {
				pilotState.burstActive = false;
				return;
			}

			// Lead solution + per-shot aim dispersion. The jitter is
			// rerolled every frame (≈ every bullet, since fireRate
			// runs at 20 Hz and the game tick is 60 Hz) so each round
			// in a burst spreads across the dispersion cone.
			const lead = computeLead(unit, pick.target);
			const dh = _g3() * dispersionDeg;
			const dp = _g3() * dispersionDeg;
			command.fireWeapon  = true;
			command.weaponType  = 'gun';
			command.weaponTarget = pick.target;
			command.gunHeading  = lead.heading + dh;
			command.gunPitch    = lead.pitch   + dp;
		},
	};
}
