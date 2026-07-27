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

import { WeaponSubsystem, CountermeasureSubsystem } from './ai/subsystems.js';
import { LaserPDSubsystem } from './laserPD.js';
import { airDensity } from '../plane/aeroModel.js';
import { carrierFlightOpsActive } from './carrierOps.js';

// Is `target` (an in-flight missile / PGM) closing on `unit`? Point-defence
// batteries use this to engage the HARM / cruise / SAM-shot diving on THEM,
// without wasting interceptors on every AAM crossing the sky toward some other
// target. True when the threat is within `maxRangeM` AND its velocity vector
// points within ~60° of the bearing from the threat to the unit (i.e. it's
// actually inbound, not transiting past).
function isInboundThreat(unit, target, maxRangeM) {
	const cosLat = Math.cos((unit.lat || 0) * Math.PI / 180);
	const dE = (unit.lon - target.lon) * 111320 * cosLat;  // target → unit
	const dN = (unit.lat - target.lat) * 111320;
	const dU = (unit.alt - target.alt);
	const range = Math.sqrt(dE * dE + dN * dN + dU * dU);
	if (range > maxRangeM) return false;
	const tH = (target.heading || 0) * Math.PI / 180;
	const tP = (target.pitch   || 0) * Math.PI / 180;
	const vE = Math.sin(tH) * Math.cos(tP);
	const vN = Math.cos(tH) * Math.cos(tP);
	const vU = Math.sin(tP);
	const r = Math.max(1, range);
	const cosClose = (vE * dE + vN * dN + vU * dU) / r;
	return cosClose > 0.5; // within ~60° of pointing at us
}

// Dispatcher. `type` comes from the platform JSON's pilot.type field.
// Returns the pilot object the npcSystem caller attaches to the NPC.
export function makePilot(type, lon, lat, alt, params) {
	switch (type) {
		case 'orbit':
			return makeOrbitPilot(lon, lat, params.altitudeM ?? alt, params.radiusM ?? 40000,
				params.speedMps);
		case 'static-sam':
			return makeStaticSamPilot(params);
		case 'static-aaa':
			return makeStaticAaaPilot(params);
		case 'static-laser':
			return makeStaticLaserPilot(params);
		case 'ewr':
			return makeEwrPilot();
		case 'static-target':
			return makeStaticTargetPilot();
		case 'ship-combatant':
		case 'ship':
			return makeShipPilot(lon, lat, alt, params);
		case 'coastal-battery':
			return makeCoastalBatteryPilot(params);
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
// `speedMps` matters more than it looks: this pilot is no longer only for
// AWACS. A shipborne helo picket flies the same orbit-a-point pattern at a
// fifth of the speed, and at the hardcoded 180 m/s it would circle its parent
// ship like a jet, which reads wrong and makes its 9 km orbit meaningless.
export function makeOrbitPilot(centerLon, centerLat, altitude, radiusM, speedMps) {
	const command = {
		targetHeading: 0,
		targetPitch:   0,
		throttle:      0.6,
		targetSpeed:   (typeof speedMps === 'number') ? speedMps : 180,   // default: AWACS cruise
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
	// Point-defence vs incoming missiles. When true, the battery will also
	// engage `missile`-class threats (HARMs, other SAMs' shots, AAMs) that
	// are inbound on IT — modern NASAMS / Tor do exactly this. Gated by
	// isInboundThreat so it shoots the weapon diving on the battery, not
	// every AAM transiting the envelope toward a fighter. Default off so
	// legacy area-SAMs keep their old aircraft-only behaviour unless the
	// platform opts in.
	const engageMissiles = !!params.engageMissiles;

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
	// HARM-evade trigger range. Kept TERMINAL (≈18 km) rather than the old
	// 35 km: a 35 km trigger meant any HARM lobbed from standoff kept the
	// battery's radar perpetually dark (it could never engage anything,
	// including the cruise missiles leaking past), which read as "the SAM
	// does nothing". At ~18 km the battery stays up and fights — engaging
	// aircraft, cruise missiles, and (if engageMissiles) the HARM itself —
	// and only ducks in the final seconds as a last-ditch defeat attempt.
	const harmEvadeDetectM    = params.harmEvadeDetectM    ?? 18000;
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
		// Opt-in point defence: also power up when an inbound missile
		// (HARM etc.) is cued, so the battery can fight it instead of
		// sitting dark.
		if (engageMissiles) ENGAGEABLE.add('missile');
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
			if (sig.unitClass === 'missile') {
				// Engage incoming missiles only when this battery opts into
				// point-defence AND the threat is actually inbound on us.
				if (!engageMissiles || !isInboundThreat(unit, target, weapon.maxRange)) continue;
			}
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
			if (sig.unitClass === 'missile')        classMul = 0.5; // inbound HARM/ARM — top priority
			else if (sig.unitClass === 'cruise_missile') classMul = 1.6;
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
				} else {
					// Non-emcon battery: radar is always on EXCEPT during the
					// brief HARM-evade shutdown handled above. This `else` is the
					// re-enable — without it the evade set active=false and NOTHING
					// ever turned it back on, so a single HARM permanently blinded
					// the battery (radar off → no contacts → never fires again).
					// That's the exact "SAM does nothing after one HARM" failure
					// the evade logic claims to avoid; it was only avoided for
					// emcon SAMs, which re-enable via the branch above.
					unit.sensors.radar.active = true;
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

			// Dry magazine = nothing to do. Clear any lingering engagement so
			// an emcon battery that ran dry mid-salvo doesn't keep
			// `currentEngagement` set forever (which would pin its radar ON via
			// shouldRadarBeOn — a dead battery radiating as a free HARM magnet).
			// No reload plumbing exists yet.
			if (weapon.ammo <= 0) { pilotState.currentEngagement = null; return; }

			// In-flight ceiling. The generic fire-gate in npcUpdate calls
			// WeaponSubsystem.consume(), which only checks ammo + fireRate — NOT
			// maxInFlight (that gate lives in pickWeaponFor, which this hand-
			// rolled SAM doctrine never calls). So enforce the cap here, mirroring
			// pickWeaponFor: count this battery's own live missiles of this type
			// and hold fire while at the ceiling. Without it the salvo + per-
			// target-cooldown logic still lets a battery ripple its whole magazine
			// into the air across targets in a saturation raid — defeating the
			// documented serial-engagement doctrine.
			let liveInFlight = 0;
			const projPool = context.projectiles || [];
			for (const p of projPool) {
				if (!p || !p.active) continue;
				if (p.launcher !== unit || p.type !== weapon.type) continue;
				if (p.lostLock || p.maddog) continue;
				if (++liveInFlight >= maxInFlight) break;
			}
			const atInFlightCap = liveInFlight >= maxInFlight;

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
					// right cadence. Hold fire (but keep the engagement
					// alive) while at the in-flight ceiling; the salvo
					// resumes as soon as a missile clears.
					if (!atInFlightCap) {
						command.fireWeapon   = true;
						command.weaponType   = weapon.type;
						command.weaponTarget = t;
					}
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

			// At the in-flight ceiling — don't open a NEW engagement this frame.
			// (An in-progress salvo above is allowed to wait out the cap; a fresh
			// one just defers until a slot frees, re-picking next frame.)
			if (atInFlightCap) return;

			// Magazine-conservation policy. When the launcher is
			// down to its last N missiles, switch to single-shot so
			// the battery doesn't empty itself on one engagement.
			// Single-shot against inbound missiles (HARM/ARM) — a 2-missile
			// salvo on every leaker would empty an 8-round battery in one
			// SEAD pass. Salvo only against aircraft.
			const bestIsMissile = best.target && best.target.signature &&
				best.target.signature.unitClass === 'missile';
			const plannedShots = Math.min(
				(bestIsMissile || weapon.ammo <= conserveN) ? 1 : salvoSize,
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
// Static directed-energy point-defense pilot (NFAC.4).
//
// The chassis never moves; all the behavior lives in a LaserPDSubsystem that
// scans the in-flight munition list each frame, picks the most imminent
// subsonic threat with line-of-sight, and burns it down over a short dwell
// from a brownout-limited capacitor. No projectile is spawned — the laser
// applies its kill directly — so unlike the AAA/SAM pilots this one writes no
// fireWeapon command; it just ticks the subsystem.
// ============================================================================
export function makeStaticLaserPilot(params = {}) {
	const command = {
		targetHeading: 0,
		targetPitch:   0,
		throttle:      0,
		targetSpeed:   0,
		boost:         false,
		fireFlare:     false,
		fireWeapon:    false,
		activeBehaviorName: 'StaticLaser',
	};
	const laser = new LaserPDSubsystem(params);
	return {
		command,
		subsystems: { laser },
		update(context, dt) {
			laser.update(context.unit, context.projectiles, dt);
		},
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
	// Guns engage inbound missiles by default — a Shilka / CIWS-class mount
	// IS a last-ditch hard-kill against HARMs, cruise missiles and terminal-
	// diving PGMs. Gated by isInboundThreat so it only fires at what's
	// actually coming at it. Set engageMissiles:false for aircraft-only.
	const engageMissiles = params.engageMissiles !== false;

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
			if (sig.unitClass === 'missile') {
				if (!engageMissiles || !isInboundThreat(unit, target, maxRange)) continue;
			}
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
		// Cue set must match what pickTarget actually engages, or an emcon AAA
		// stays dark against the very threats it exists to swat. pickTarget
		// engages terminal-diving bombs and (when engageMissiles, the default)
		// inbound missiles — so cue on them too, otherwise a lone HARM/bomb with
		// no aircraft nearby never powers the radar up and the gun sits silent.
		const ENG = new Set(['fighter', 'stealth_fighter', 'awacs', 'cargo', 'cruise_missile', 'bomb']);
		if (engageMissiles) ENG.add('missile');
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

// ============================================================================
// Ship pilot — surface combatant (Arleigh Burke-class destroyer).
//
// A ship is a mobile SAM site + strike platform + point-defence emplacement
// rolled into one moving hull, so this pilot composes the patterns proven by
// the static pilots above:
//   - MOVEMENT: writes targetHeading/targetSpeed (NOT pitch) for the surface
//     kinematic integrator (see surfaceMovement.js). Follows a waypoint
//     route, orbits a patrol station, or holds a slow box near its spawn;
//     the coastline lookahead (npc._landAhead/_landAheadBearing, filled by
//     npcUpdate) hard-overrides the course to keep the hull off the rocks.
//   - LAYERED AIR DEFENCE: one WeaponSubsystem entry per layer (SM-6 area
//     SAM, RAM point SAM, CIWS gun), each with its own envelope + cooldown.
//     The scheduler fires the single most-urgent ready shot each frame;
//     per-weapon fireRate serialises the layers across frames so a
//     saturation raid gets engaged outer-to-inner. Reuses isInboundThreat()
//     (the "is this Harpoon actually coming at us" gate) from this file.
//   - OFFENCE: Harpoon (anti-ship, homes the moving ship), Tomahawk (land-
//     attack cruise), Mk 45 gun (ballistic shell with a solved lead+loft).
//     Fired opportunistically when no higher-priority defensive shot is due.
//   - EVASION: an inbound missile inside the evade ring turns the hull to
//     beam the threat at flank speed and pumps flares.
//
// The command object it writes is the SAME shape an AI fighter or a future
// player ShipController produces, so nothing downstream cares who filled it.
// ============================================================================
export function makeShipPilot(lon, lat, alt, params = {}) {
	const DEG = Math.PI / 180;

	// ---- Movement config -------------------------------------------------
	const cruiseSpeed = params.cruiseSpeedMps ?? 9;    // ~17 kt economical
	const maxSpeed    = params.maxSpeedMps    ?? 16;   // ~31 kt flank
	const turnRate    = params.turnRateMaxDegPerS ?? 2.5;
	const accelTau    = params.accelTauS ?? 30;
	const waypoints   = Array.isArray(params.waypoints) && params.waypoints.length ? params.waypoints : null;
	const patrolRadius = params.patrolRadiusM ?? 0;
	const homeLon = (params.stationLon ?? lon), homeLat = (params.stationLat ?? lat);

	// ---- Weapon layers ---------------------------------------------------
	// Each weapon JSON entry: { type(simType), role, ammo, fireRate,
	// maxInFlight, minRange, maxRange, salvoSize?, reengageS?, muzzleVelMps? }
	const layerCfg = (params.weapons || []).map(w => ({
		type: w.type,
		role: w.role || 'sam',
		ammo: w.ammo ?? 8, maxAmmo: w.ammo ?? 8,
		fireRate: w.fireRate ?? 2.0,
		maxInFlight: w.maxInFlight ?? 4,
		lastFire: -Infinity,
		minRange: w.minRange ?? 0,
		maxRange: w.maxRange ?? 20000,
		reengageS: w.reengageS ?? 6,
		salvoSize: w.salvoSize ?? 1,    // missiles committed per engagement (sam / antiship)
		// Cells held back for threats only this layer can stop (see the SAM
		// branch of scheduleShot). 0 = spend the magazine freely.
		reserveForBallisticN: w.reserveForBallisticN ?? 0,
		dispersionDeg: w.dispersionDeg,   // gun cone; undefined → gunLead default
		muzzleVelMps: w.muzzleVelMps ?? 1000,
	}));
	const weapons = new WeaponSubsystem({ weapons: layerCfg });
	const weaponByRole = (role) => layerCfg.find(w => w.role === role);
	const countermeasures = new CountermeasureSubsystem({
		flares: params.flares ?? 80, chaff: params.chaff ?? 80, minFlareInterval: 0.5,
	});

	// ---- Engageable-class sets per layer ---------------------------------
	// THREAT vs INTERCEPTOR discrimination. The whole "missile soup" problem is
	// telling an incoming threat apart from a friendly/transiting interceptor.
	// Two signals do it cleanly:
	//   1. CLASS. Anti-ship/cruise missiles and bombs/shells are their own
	//      classes ('cruise_missile', 'bomb'). Air-to-air & surface-to-air
	//      INTERCEPTORS (AAMs, SAMs, ARMs) are all unitClass 'missile'. So we
	//      simply NEVER engage 'missile' — that alone stops two ships trading
	//      SAMs at each other's SAMs.
	//   2. INBOUND. A munition is only worth an interceptor if it's actually
	//      closing on us (isInboundThreat, applied in pickAirTarget). A shell
	//      arcing toward a different ship, or our own outbound store, is
	//      ignored even though it's the "right" class.
	//
	// Long-range area SAM (SM-6): aircraft anywhere in envelope + INBOUND
	// anti-ship/cruise missiles (it's a real ASM-defence weapon). Not bombs —
	// a 5" shell is too small/fast for an area SAM to bother with.
	const SAM_AIR = new Set([
		'fighter', 'stealth_fighter', 'stealth_bomber', 'awacs', 'cargo', 'drone_isr',
		'cruise_missile',
	]);
	// Inner point-defence (RAM / CIWS): the close-in hard-kill layer — INBOUND
	// anti-ship/cruise missiles AND inbound gun shells (yes, CIWS swats Mk45
	// rounds), plus a last-ditch shot at a close aircraft. Never 'missile'.
	const POINT_DEFENCE = new Set(['cruise_missile', 'bomb', 'fighter', 'drone_isr']);
	// Classes still engageable once the SAM magazine is down to its ballistic
	// reserve. A ballistic round is `cruise_missile` class like everything else
	// (it's the SPEED that makes it a different problem), so the class set is
	// only half the gate — isBallisticThreat below does the rest.
	const BALLISTIC_ONLY = new Set(['cruise_missile']);
	const SHIP_ONLY = new Set(['ship']);
	const SHORE_AND_SHIP = new Set(['ship', 'building', 'sam_site', 'ewr', 'ground']);
	const LAND_TARGETS = new Set(['building', 'sam_site', 'ewr', 'ground']);

	const EVADE_RANGE_M = params.evadeRangeM ?? 16000;  // inbound ring → maneuver
	const FLARE_RANGE_M = params.flareRangeM ?? 7000;   // inbound ring → CM dump
	// Surface pursuit: how far out we're willing to run a hostile hull down
	// once we can no longer reach it from here. Set 0 to disable pursuit for a
	// ship that must hold its station / route regardless.
	const PURSUE_RANGE_M = params.pursueRangeM ?? 150000;
	// Close to this fraction of the weapon's max range before switching from
	// "run him down" to "hold contact". The margin keeps the target comfortably
	// inside the envelope instead of parked on its edge, where a few minutes of
	// relative drift would break the engagement.
	const PURSUE_CLOSE_FRAC = params.pursueCloseFrac ?? 0.75;
	// Cooperative air-defence: ships within this radius of each other share a
	// fire-control picture (CEC-style) and won't double-engage the same track.
	const COORD_RADIUS_M = params.coordRangeM ?? 150000;

	const command = {
		targetHeading: 0, targetPitch: 0, throttle: 1, targetSpeed: cruiseSpeed,
		boost: false, fireFlare: false, fireWeapon: false,
		weaponType: null, weaponTarget: null, gunHeading: null, gunPitch: null,
		// Muzzle speed the ballistic solution was computed with, so the round is
		// actually launched at it (see spawnNpcMissile).
		gunLaunchSpeedMps: null,
		// kinematic limits read by the surface integrator
		turnRateMaxDegPerS: turnRate, accelTauS: accelTau,
		activeBehaviorName: 'Transit',
	};

	const pilotState = {
		wpIndex: 0,
		engageCooldown: new Map(),   // target → sim-time of last engagement (navalgun/landattack)
		salvos: {},                  // role → { target, remaining } committed salvo in progress
		boxAngle: (params.initialHeading ?? 0),
		boxTurnDir: 1,
	};

	// ---- Geo helpers -----------------------------------------------------
	function enu(from, to) {
		const cosLat = Math.cos((from.lat || 0) * DEG);
		return {
			e: (to.lon - from.lon) * 111320 * cosLat,
			n: (to.lat - from.lat) * 111320,
			u: (to.alt || 0) - (from.alt || 0),
		};
	}
	function bearing(from, to) { const d = enu(from, to); return (Math.atan2(d.e, d.n) / DEG + 360) % 360; }
	function horizRange(from, to) { const d = enu(from, to); return Math.hypot(d.e, d.n); }

	// ---- Inbound-missile scan (evade + defend cueing) --------------------
	function nearestInbound(unit) {
		if (!unit.contacts) return null;
		let best = null, bestR = Infinity;
		for (const [target, c] of unit.contacts) {
			if (!target || target.destroyed || target.active === false) continue;
			if (target.team && unit.team && target.team === unit.team) continue;
			const cls = target.signature && target.signature.unitClass;
			// Evade/flare only for the threats that home on the ship — sea-
			// skimming anti-ship/cruise missiles and bombs. (Don't react to
			// passing 'missile'-class interceptors; that caused ships to flee
			// their own outbound SAMs.)
			if (cls !== 'cruise_missile' && cls !== 'bomb') continue;
			if (!isInboundThreat(unit, target, EVADE_RANGE_M)) continue;
			const r = c.radar ? c.radar.range : horizRange(unit, target);
			if (r < bestR) { bestR = r; best = { target, range: r }; }
		}
		return best;
	}

	// ---- Air / PGM target picker (SAM, RAM, CIWS layers) -----------------
	// allowed: Set of engageable unitClass. useCooldown gates re-engagement
	// (area SAM); point-defence layers pass false so they hammer the leaker.
	// opts.skipEngaged  hold fire while the team already has a shot on this
	//                   track (area SAM salvo doctrine).
	// opts.coordinate   consult the task group's engagement picture at all.
	//                   FALSE for the inner layers — see below.
	// A ballistic threat is one the inner layers realistically cannot stop:
	// it arrives fast and steep. Identified from the munition's own tags where
	// they exist, with a closure-speed fallback so any future fast mover is
	// covered without touching this list.
	function isBallisticThreat(t) {
		const tags = t && t.data && t.data.tags;
		if (Array.isArray(tags) && tags.includes('ballistic')) return true;
		return (t && t.speed || 0) > 900;
	}

	function pickAirTarget(unit, weapon, now, allowed, useCooldown, dl, opts = {}) {
		const skipEngaged = !!opts.skipEngaged;
		const coordinate  = opts.coordinate !== false;
		const requireBallistic = !!opts.requireBallistic;
		if (!unit.contacts) return null;
		let best = null, bestScore = Infinity;
		for (const [target, c] of unit.contacts) {
			if (!target || target.destroyed || target.active === false) continue;
			if (target.team && unit.team && target.team === unit.team) continue;
			// Salvo doctrine (area SAM): leave a threat alone while ANYONE on the
			// team still has a shot that might yet kill it — so a fresh salvo
			// only goes once the previous one has demonstrably failed, and ships
			// divide the raid instead of all dumping on the same bandit.
			//
			// hasUnresolvedShot, not isEngaged: "an interceptor is alive" is not
			// the same question as "the shot might still work". A SAM that has
			// already flown past coasts for many seconds looking engaged, while
			// a fresh miss frees the target instantly. Gating on whether the
			// round is still CLOSING is what turns SM-6 fire from a timer into
			// shoot-look-shoot.
			if (coordinate && skipEngaged && dl && dl.hasUnresolvedShot(target)) continue;
			// Cooperative deconfliction: a sister ship in the task group already
			// has a live interceptor on this track → leave it to them and look
			// for an unengaged threat, so a saturation raid gets spread across
			// the group instead of three ships all shooting the same leaker.
			//
			// This is an AREA-SAM doctrine only. The inner layers (RAM, CIWS)
			// pass coordinate:false: a sea-skimmer that has leaked to inside
			// 9 km of THIS hull gets engaged no matter who else has a missile
			// chasing it. Deconflicting the last-ditch layers meant one
			// teammate's in-flight SM-6 anywhere within 150 km silenced this
			// ship's own RAM and CIWS against the round about to hit her.
			if (coordinate && dl && dl.engagedByOther(target, unit, COORD_RADIUS_M)) continue;
			const sig = target.signature; if (!sig) continue;
			const cls = sig.unitClass;
			// Never engage 'missile'-class targets (AAMs / SAMs / ARMs). Those
			// are interceptors themselves — shooting them spawns a missile-vs-
			// missile cascade where two ships endlessly trade SAMs at each
			// other's SAMs. A ship defends against the threats that actually
			// hurt it: sea-skimming anti-ship / cruise missiles ('cruise_
			// missile') and bombs — plus aircraft for the area-SAM layer.
			if (!allowed.has(cls)) continue;
			// Cruise missiles / bombs only warrant an interceptor when they're
			// genuinely closing on us; aircraft are fair game anywhere in range.
			if ((cls === 'cruise_missile' || cls === 'bomb') &&
				!isInboundThreat(unit, target, weapon.maxRange)) continue;
			if (requireBallistic && !isBallisticThreat(target)) continue;
			if (!c.radar) continue;             // need a radar firing solution
			const range = c.radar.range;
			if (range < weapon.minRange || range > weapon.maxRange) continue;
			if (useCooldown) {
				const last = pilotState.engageCooldown.get(target);
				if (last != null && now - last < weapon.reengageS) continue;
			}
			let classMul = 1.0;
			if (cls === 'cruise_missile') classMul = 0.4;     // inbound ASM = top priority
			else if (cls === 'bomb') classMul = 0.7;
			const score = range * classMul;
			if (score < bestScore) { bestScore = score; best = { target, range }; }
		}
		return best;
	}

	// ---- Surface / shore target picker (Harpoon, Mk45, Tomahawk) ---------
	function pickSurfaceTarget(unit, weapon, now, allowed, dl, skipEngaged = false) {
		let best = null, bestR = Infinity;
		const seen = new Set();
		const consider = (target) => {
			if (!target || target.destroyed || target.active === false || seen.has(target)) return;
			seen.add(target);
			if (target.team && unit.team && target.team === unit.team) return;
			const sig = target.signature; if (!sig || !allowed.has(sig.unitClass)) return;
			// Saturation-salvo doctrine: don't open a NEW salvo on a hull that
			// already has anti-ship missiles inbound (team-wide). The committed
			// salvo runs to completion via the salvo state; this only gates the
			// pick of a fresh target, so the team spreads across enemy ships and
			// re-attacks a survivor only after its salvo has played out.
			if (skipEngaged && dl && dl.isEngaged(target)) return;
			// Geometric range to the cued position. A ship can't see another
			// ship past the radar horizon (~30 km), but an anti-ship missile
			// reaches 100 km+ — so we target from the OTH-T cue, not just our own
			// radar return.
			const range = horizRange(unit, target);
			if (range < weapon.minRange || range > weapon.maxRange) return;
			const last = pilotState.engageCooldown.get(target);
			if (last != null && now - last < weapon.reengageS) return;
			if (range < bestR) { bestR = range; best = { target, range }; }
		};
		// Own sensors first, then the shared team datalink picture: a scout
		// aircraft / helo / sister ship beyond our horizon can cue the target
		// (cooperative engagement), which is the whole point of a 100 km AShM.
		if (unit.contacts) for (const [t] of unit.contacts) consider(t);
		if (dl) for (const [t] of dl.allContacts()) consider(t);
		return best;
	}

	// ---- Fire-control solvers --------------------------------------------
	function gunLead(unit, target, muzzleVel, dispersionDeg) {
		const d = enu(unit, target);
		const tH = (target.heading || 0) * DEG, tP = (target.pitch || 0) * DEG, tS = target.speed || 0;
		const tvE = Math.sin(tH) * Math.cos(tP) * tS, tvN = Math.cos(tH) * Math.cos(tP) * tS, tvU = Math.sin(tP) * tS;
		let tof = Math.hypot(d.e, d.n, d.u) / muzzleVel;
		for (let i = 0; i < 2; i++) {
			const le = d.e + tvE * tof, ln = d.n + tvN * tof, lu = d.u + tvU * tof;
			tof = Math.hypot(le, ln, lu) / muzzleVel;
		}
		const le = d.e + tvE * tof, ln = d.n + tvN * tof, lu = d.u + tvU * tof;
		// Barrel dispersion — the reason a CIWS misses. Every round was
		// previously laid on the PERFECT lead solution, so once bullets got a
		// swept-segment hit test the gun connected with essentially everything
		// it fired at and no inbound round survived. Real gun fire is a cone.
		//
		// The cone is what produces the hit rate, and it produces the right
		// SHAPE of hit rate for free: spread grows with range, so the burst is
		// scattered at 2.5 km and tightening fast as the target closes, which
		// is exactly how a close-in weapon behaves. Tuned so a subsonic
		// sea-skimmer crossing the envelope eats a couple of rounds — a kill
		// about half the time — while a Mach-3 round crossing it in a fifth of
		// the time gets a fifth of the exposure.
		// 3.0° solved numerically for a ~55% kill on a subsonic sea-skimmer
		// crossing the envelope, which is about where a real Phalanx sits. It
		// reads wide (~52 m of spread at 1 km) because the target is modelled
		// as a 3 m sphere and the burst gets ~190 rounds on a slow crosser —
		// a tight cone killed 100% of everything, including a Mach-3 ballistic
		// round, which is the behaviour that made ships untouchable.
		const sigma = (dispersionDeg == null ? 3.0 : dispersionDeg);
		const g1 = Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
		const g2 = Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.sin(2 * Math.PI * Math.random());
		return {
			valid: true,
			heading: (Math.atan2(le, ln) / DEG + g1 * sigma + 360) % 360,
			pitch: Math.atan2(lu, Math.max(1, Math.hypot(le, ln))) / DEG + g2 * sigma,
		};
	}

	// Ballistic fire solution for the naval gun. A drag-free closed form sailed
	// the round overhead because it ignored both the real drag and the TRUE
	// muzzle speed (launchSpeedOffset + ship speed, not the bare value). So we
	// instead SIMULATE the actual shell trajectory — same coast drag + gravity
	// the Missile integrator uses — and bisect launch elevation until the arc
	// lands on the target's range+height.
	// Drag constants mirror mk45-shell.json (the only ballistic gun round).
	//
	// The density term matters and used to be dropped on the assumption that
	// ρ≈ρref for a low-flying round. Measured, that assumption cost 300-440 m
	// of overshoot at 8-20 km: even a 10° arc peaks high enough for thinner air
	// to stretch the trajectory. That was invisible while shells couldn't hit
	// ships at all; now that they can, it's the difference between a hit and a
	// splash 300 m past the target with a 22 m kill radius. Step is also
	// tightened to the integrator's own frame time — at dt=0.1 the coarse
	// Euler step was worth tens of metres on its own.
	const SHELL_DRAG_REF = 4, SHELL_DRAG_REF_SPEED = 800, SHELL_DRAG_REF_ALT = 100;
	function _simShellRange(v0, thetaDeg, dy, launchAltM = 0) {
		const g = 9.81, dt = 1 / 60;
		const rhoRef = airDensity(SHELL_DRAG_REF_ALT);
		let speed = v0, pitch = thetaDeg * DEG, x = 0, y = 0;
		for (let t = 0; t < 120; t += dt) {
			const rho = airDensity(launchAltM + y);
			const dragAcc = SHELL_DRAG_REF * (rho / Math.max(1e-6, rhoRef)) *
				(speed * speed) / (SHELL_DRAG_REF_SPEED * SHELL_DRAG_REF_SPEED);
			speed = Math.max(20, speed - dragAcc * dt);
			const vH = speed * Math.cos(pitch);
			const vV = speed * Math.sin(pitch) - g * dt;
			speed = Math.hypot(vH, vV);
			pitch = Math.atan2(vV, vH);
			const px = x, py = y;
			x += vH * dt; y += vV * dt;
			if (vV < 0 && y <= dy) {                 // descending through target height
				const denom = py - y;
				const fr = denom > 1e-6 ? (py - dy) / denom : 0;
				return px + (x - px) * Math.max(0, Math.min(1, fr));
			}
		}
		return x;
	}
	function ballisticSolve(unit, target, muzzleVel) {
		// True muzzle speed = the round's launchSpeedOffset (≈ muzzleVel) plus
		// the firing ship's own speed.
		const v0 = muzzleVel + (unit.speed || 0);
		// Lead the (slow) target over a rough time-of-flight.
		const d0 = enu(unit, target);
		const tH = (target.heading || 0) * DEG, tP = (target.pitch || 0) * DEG, tS = target.speed || 0;
		const tvE = Math.sin(tH) * Math.cos(tP) * tS, tvN = Math.cos(tH) * Math.cos(tP) * tS;
		// Lead over time of flight. `v0 * 0.75` as an average ground speed is a
		// ~20% overestimate of the flight time (measured: 33 s assumed vs 27 s
		// real at 20 km), which leads the aim point too far along the target's
		// track. 0.92 matches the simulated arc closely across the envelope.
		const launchAlt = unit.alt || 0;
		let le = d0.e, ln = d0.n;
		for (let i = 0; i < 2; i++) {
			const tof = Math.hypot(le, ln) / Math.max(50, v0 * 0.92);
			le = d0.e + tvE * tof; ln = d0.n + tvN * tof;
		}
		const R = Math.hypot(le, ln), dy = d0.u;
		// Bisect launch elevation on the LOW (increasing-range) arc. 35° brackets
		// every range inside the gun's envelope; if even that falls short the
		// target is genuinely out of reach.
		if (_simShellRange(v0, 35, dy, launchAlt) < R) return { valid: false };
		let lo = 0.5, hi = 35;
		for (let it = 0; it < 20; it++) {
			const mid = (lo + hi) / 2;
			if (_simShellRange(v0, mid, dy, launchAlt) < R) lo = mid; else hi = mid;
		}
		const theta = (lo + hi) / 2;
		// Per-shot dispersion (~0.3°): realistic scatter, and it desynchronises
		// two ships lobbing shells on mirrored trajectories so the rounds don't
		// meet at the exact midpoint.
		const disp = 0.3;
		const jh = (Math.random() - 0.5) * disp;
		const jp = (Math.random() - 0.5) * disp;
		// Hand the muzzle speed we SOLVED WITH to the spawner, so the round is
		// actually launched at it. Without this the two diverge silently: the
		// Zumwalt's 155 mm AGS is configured at 900 m/s, but every shell is a
		// mk45-shell whose launchSpeedOffset is 800, so fire control aimed for
		// a 910 m/s round and fired an 810 m/s one — landing 19% short at every
		// range, which is precisely the reported symptom. Every other ship
		// happened to be configured at 800 and so looked fine.
		return {
			valid: true,
			heading: (Math.atan2(le, ln) / DEG + jh + 360) % 360,
			pitch: theta + jp,
			launchSpeedMps: v0,
		};
	}

	function liveInFlight(ctx, unit, type) {
		let n = 0; const pool = ctx.projectiles || [];
		for (const p of pool) {
			if (!p || !p.active || p.launcher !== unit || p.type !== type) continue;
			if (p.lostLock || p.maddog) continue;
			n++;
		}
		return n;
	}

	// ---- Per-frame weapon scheduler: ONE shot, highest priority first ----
	// Defensive layers (ciws→ram→sam) preempt offensive (antiship→navalgun→
	// landattack); per-weapon fireRate cooldowns let the lower layers fire on
	// the frames the higher ones are reloading, so everything gets serviced.
	const LAYER_ORDER = ['ciws', 'ram', 'sam', 'antiship', 'navalgun', 'landattack'];

	// Salvo doctrine for the area-SAM and anti-ship layers. Continues an
	// in-progress salvo on a still-valid target; otherwise commits a FRESH salvo
	// (salvoSize rounds) on the best target `pickFresh` returns. `pickFresh`
	// already skips targets the team has a live interceptor on, so threats get
	// divided and a target is only re-attacked once its previous salvo has
	// resolved without killing it.
	function pickSalvo(role, w, pickFresh, stillValid) {
		const sv = pilotState.salvos[role];
		if (sv && sv.remaining > 0 && sv.target &&
			!sv.target.destroyed && sv.target.active !== false && stillValid(sv.target)) {
			return { target: sv.target, salvo: sv };
		}
		pilotState.salvos[role] = null;
		const fresh = pickFresh();
		if (fresh && fresh.target) {
			const nsv = { target: fresh.target, remaining: Math.max(1, w.salvoSize || 1) };
			pilotState.salvos[role] = nsv;
			return { target: fresh.target, salvo: nsv };
		}
		return null;
	}

	function scheduleShot(unit, now, ctx) {
		const dl = ctx && ctx.teamDatalink;
		for (const role of LAYER_ORDER) {
			const w = weaponByRole(role);
			if (!w || w.ammo <= 0) continue;
			if (unit._disabledWeapons && unit._disabledWeapons.has(w.type)) continue; // mount knocked out
			if (now - w.lastFire < w.fireRate) continue;
			if (w.maxInFlight && liveInFlight(ctx, unit, w.type) >= w.maxInFlight) continue;

			let pick = null, aim = null;
			if (role === 'ciws') {
				pick = pickAirTarget(unit, w, now, POINT_DEFENCE, false, dl, { coordinate: false });
				if (pick) aim = gunLead(unit, pick.target, w.muzzleVelMps, w.dispersionDeg);
			} else if (role === 'ram') {
				pick = pickAirTarget(unit, w, now, POINT_DEFENCE, false, dl, { coordinate: false });
			} else if (role === 'sam') {
				// Magazine reserve. The area SAM is the ONLY thing aboard that can
				// touch a ballistic round — RAM and CIWS get a handful of chances
				// against something arriving at Mach 3 in a terminal dive and take
				// essentially none of them. So the last few cells are held back for
				// that threat rather than spent on the aircraft and sea-skimmers the
				// inner layers can also handle. Without this a ship burns its whole
				// SM-6 load on the cruise-missile raid that PRECEDES the ballistic
				// shot, which is exactly the sequencing an attacker wants.
				const ballisticOnly = w.ammo <= (w.reserveForBallisticN ?? 0);
				const sres = pickSalvo('sam', w,
					() => pickAirTarget(unit, w, now,
						ballisticOnly ? BALLISTIC_ONLY : SAM_AIR, false, dl,
						{ skipEngaged: true, requireBallistic: ballisticOnly }),
					(t) => {
						const c = unit.contacts && unit.contacts.get(t);
						const range = c && c.radar ? c.radar.range : horizRange(unit, t);
						if (range < w.minRange || range > w.maxRange) return false;
						// Mirror pickAirTarget's rule: the inbound gate applies to
						// MUNITIONS only (an ASM that stopped closing is somebody
						// else's problem). Applying it to aircraft as well tore up a
						// committed salvo the moment the bandit crossed the beam, and
						// since a fresh pick then skips him for being engaged, the
						// second round of a salvoSize:2 engagement was simply never
						// fired.
						const cls = t.signature && t.signature.unitClass;
						if (cls === 'cruise_missile' || cls === 'bomb') {
							return isInboundThreat(unit, t, w.maxRange);
						}
						return true;
					});
				if (sres) pick = { target: sres.target, _salvo: sres.salvo };
			} else if (role === 'antiship') {
				const sres = pickSalvo('antiship', w,
					() => pickSurfaceTarget(unit, w, now, SHIP_ONLY, dl, true),
					(t) => { const r = horizRange(unit, t); return r >= w.minRange && r <= w.maxRange; });
				if (sres) pick = { target: sres.target, _salvo: sres.salvo };
			} else if (role === 'navalgun') {
				pick = pickSurfaceTarget(unit, w, now, SHORE_AND_SHIP, dl);
				if (pick) { aim = ballisticSolve(unit, pick.target, w.muzzleVelMps); if (!aim.valid) pick = null; }
			} else if (role === 'landattack') {
				pick = pickSurfaceTarget(unit, w, now, LAND_TARGETS, dl);
			}
			if (pick) {
				// Salvo layers (sam/antiship) burn down their committed round
				// count; naval gun / land attack keep the simple per-target
				// re-engage cooldown; point defence (ciws/ram) gates on neither —
				// it hammers every leaker.
				if (pick._salvo) pick._salvo.remaining -= 1;
				else if (role === 'navalgun' || role === 'landattack') pilotState.engageCooldown.set(pick.target, now);
				return { weapon: w, target: pick.target, aim, role };
			}
		}
		return null;
	}

	// ---- Surface pursuit -------------------------------------------------
	// "I can still hurt him, but only if I get closer."
	//
	// The movement layer used to be completely decoupled from the weapon
	// layer: a ship steered by waypoints / patrol / station-keeping and
	// nothing else. So once two destroyers traded anti-ship salvos and shot
	// each other's down, both sat outside the other's remaining envelope
	// forever — Harpoons dry at 8 rounds, the 20 km Mk 45 unable to reach,
	// and no code path anywhere that closed the range. The naval gun was
	// effectively never used ship-to-ship.
	//
	// Returns { target, range, bearing, closeTo } when a hostile hull is
	// known, is outside the reach of EVERY surface-capable weapon we still
	// have rounds for, and is close enough to be worth running down. Null
	// otherwise — including when we can already shoot, so the ship reverts to
	// its normal station/route behaviour the moment it's in envelope.
	function pickPursuit(unit, ctx) {
		if (PURSUE_RANGE_M <= 0 || unit._mobilityHit) return null;
		// Longest-reaching surface weapon still loaded and not shot away.
		let bestReach = 0;
		for (const w of layerCfg) {
			if (w.role !== 'antiship' && w.role !== 'navalgun') continue;
			if (w.ammo <= 0) continue;
			if (unit._disabledWeapons && unit._disabledWeapons.has(w.type)) continue;
			if (w.maxRange > bestReach) bestReach = w.maxRange;
		}
		if (bestReach <= 0) return null;             // nothing left that hits ships
		// Only take the helm when the target is genuinely OUT of reach, and then
		// close past max range to holdAt so the ship commits instead of stopping
		// on the envelope edge. Deliberately silent while the target is already
		// engageable — otherwise a ship with Harpoons loaded (110 km reach) would
		// abandon its patrol station for any hull within 80 km, which is a far
		// bigger behaviour change than the stalemate this exists to fix.
		const holdAt = bestReach * PURSUE_CLOSE_FRAC;
		const dl = ctx && ctx.teamDatalink;
		let best = null, bestR = Infinity;
		const consider = (t) => {
			if (!t || t.destroyed || t.active === false) return;
			if (t.team && unit.team && t.team === unit.team) return;
			const sig = t.signature;
			if (!sig || !SHIP_ONLY.has(sig.unitClass)) return;
			const r = horizRange(unit, t);
			if (r <= holdAt || r > PURSUE_RANGE_M) return;      // in reach already, or too far
			if (r < bestR) { bestR = r; best = t; }
		};
		if (unit.contacts) for (const [t] of unit.contacts) consider(t);
		if (dl) for (const [t] of dl.allContacts()) consider(t);
		if (!best) return null;
		return { target: best, range: bestR, heading: bearing(unit, best), speed: maxSpeed };
	}

	function shotStateName(role, target) {
		const cls = target && target.signature && target.signature.unitClass;
		if (role === 'ciws' || role === 'ram') return 'Point defence';
		if (role === 'sam') return (cls === 'missile' || cls === 'cruise_missile') ? 'Air defence' : 'Engaging air';
		if (role === 'antiship') return 'Anti-ship';
		if (role === 'navalgun') return 'Naval gunfire';
		if (role === 'landattack') return 'Land strike';
		return 'Engage';
	}

	return {
		command,
		subsystems: { weapons, countermeasures },
		update(ctx, dt) {
			const unit = ctx.unit;
			const now  = ctx.now;

			// Reset per-frame intent.
			command.fireWeapon = false;
			command.weaponType = null;
			command.weaponTarget = null;
			command.gunHeading = null;
			command.gunPitch = null;
			command.gunLaunchSpeedMps = null;
			command.fireFlare = false;

			// ---- MOVEMENT ----------------------------------------------------
			const inbound = nearestInbound(unit);
			const pursuit = pickPursuit(unit, ctx);
			let stateName;
			if (unit._landAhead) {
				// Coastline in the corridor — hard override onto the clear bearing.
				command.targetHeading = unit._landAheadBearing ?? unit.heading;
				command.targetSpeed = Math.min(cruiseSpeed, maxSpeed * 0.55);
				stateName = 'Coastal';
			} else if (inbound && inbound.range < EVADE_RANGE_M) {
				// Beam the threat (turn perpendicular to its bearing, the gentler
				// way) and run flank to open the geometry.
				const b = bearing(unit, inbound.target);
				const optA = (b + 90) % 360, optB = (b + 270) % 360;
				let dA = Math.abs(((optA - unit.heading + 540) % 360) - 180);
				let dB = Math.abs(((optB - unit.heading + 540) % 360) - 180);
				command.targetHeading = (dA <= dB) ? optA : optB;
				command.targetSpeed = maxSpeed;
				stateName = 'Evade';
				if (inbound.range < FLARE_RANGE_M) command.fireFlare = true;  // CM dump
			} else if (waypoints) {
				const wp = waypoints[pilotState.wpIndex % waypoints.length];
				if (horizRange(unit, { lon: wp.lon, lat: wp.lat }) < (wp.captureM || 2500)) {
					pilotState.wpIndex++;
				}
				command.targetHeading = bearing(unit, { lon: wp.lon, lat: wp.lat });
				command.targetSpeed = wp.speedMps ?? cruiseSpeed;
				stateName = 'Transit';
			} else if (carrierFlightOpsActive(unit)) {
				// FLIGHT QUARTERS. A carrier conducting air operations turns
				// into the wind and works up to launch/recovery speed — the
				// wind over the deck is what lets a loaded jet get airborne and
				// gives a recovering one a slower closure onto the ramp. It
				// takes priority over station-keeping and patrol (the deck is
				// the mission) but yields to the coastline override and to
				// evading an inbound, because neither is optional.
				//
				// There's no wind field in the sim, so "into wind" is taken as
				// the ship's base recovery course — held steady so the aircraft
				// in the groove has a stable centreline to fly rather than a
				// deck that wanders under them.
				command.targetHeading = pilotState.recoveryCourse ??
					(pilotState.recoveryCourse = unit.heading || 0);
				command.targetSpeed = Math.max(cruiseSpeed, maxSpeed * 0.8);
				stateName = 'Flight quarters';
			} else if (pursuit) {
				// Surface engagement: close on the hostile hull until our
				// longest remaining ship-killer can reach it, then hold contact.
				// Deliberately ranked BELOW an explicit waypoint route — a
				// scripted transit is a tasking and shouldn't be abandoned to
				// chase a contact — but above patrol and station-keeping, which
				// are just "nothing better to do".
				command.targetHeading = pursuit.heading;
				command.targetSpeed = pursuit.speed;
				stateName = 'Pursuit';
			} else if (patrolRadius > 0) {
				// Orbit the patrol station: tangential heading + radial correction
				// (same idea as the AWACS orbit pilot).
				const d = enu({ lon: homeLon, lat: homeLat, alt: unit.alt }, unit);
				const radius = Math.hypot(d.e, d.n);
				const radialBearing = (Math.atan2(d.e, d.n) / DEG + 360) % 360;
				let h = (radialBearing + 90) % 360;
				h += Math.max(-25, Math.min(25, (radius - patrolRadius) * 0.002));
				command.targetHeading = (h + 360) % 360;
				command.targetSpeed = cruiseSpeed;
				stateName = 'Patrol';
			} else {
				// Station-keep: slow box around the spawn point. Drift back if we
				// wander too far, otherwise sweep the heading slowly.
				const drift = horizRange({ lon: homeLon, lat: homeLat }, unit);
				if (drift > 6000) {
					command.targetHeading = bearing(unit, { lon: homeLon, lat: homeLat });
				} else {
					pilotState.boxAngle = (pilotState.boxAngle + turnRate * 0.5 * dt + 360) % 360;
					command.targetHeading = pilotState.boxAngle;
				}
				command.targetSpeed = cruiseSpeed * 0.6;
				stateName = 'Station';
			}

			// Propulsion knocked out → dead in the water (still fights with
			// whatever mounts survive). The integrator coasts the hull to a stop.
			if (unit._mobilityHit) {
				command.targetSpeed = 0;
				stateName = 'Crippled';
			}

			// ---- WEAPONS -----------------------------------------------------
			const shot = scheduleShot(unit, now, ctx);
			if (shot) {
				command.fireWeapon = true;
				command.weaponType = shot.weapon.type;
				command.weaponTarget = shot.target;
				if (shot.aim) {
					command.gunHeading = shot.aim.heading;
					command.gunPitch = shot.aim.pitch;
					command.gunLaunchSpeedMps = (shot.aim.launchSpeedMps != null)
						? shot.aim.launchSpeedMps : null;
				}
				// Weapon activity is more informative in the tooltip than the
				// movement state, except while actively dodging.
				if (stateName !== 'Evade' && stateName !== 'Coastal') {
					stateName = shotStateName(shot.role, shot.target);
				}
			}

			command.activeBehaviorName = stateName;
		},
	};
}

// ============================================================================
// Coastal anti-ship battery — a static shore launcher whose only job is
// killing ships.
//
// makeShipPilot already knows how to run an anti-ship salvo, but it is built
// around a moving hull: it writes course and speed for the surface integrator
// and splits its attention across the air-defence layers it also owns. A shore
// battery has neither concern, so this is the small static counterpart rather
// than another special case bolted into the ship pilot.
//
// The defining behaviour is OVER-THE-HORIZON fire. A battery's own radar sees
// maybe 40 km; the missile reaches several hundred. So targets come from the
// team datalink as readily as from organic sensors — a scout aircraft or a
// picket ship supplies the track and the battery shoots at something it cannot
// itself see. That asymmetry is the whole point of a coastal missile regiment,
// and it's what makes standing off a defended shore expensive.
// ============================================================================
export function makeCoastalBatteryPilot(params = {}) {
	const DEG = Math.PI / 180;

	const layerCfg = (params.weapons || []).map(w => ({
		type: w.type,
		role: w.role || 'antiship',
		ammo: w.ammo ?? 8, maxAmmo: w.ammo ?? 8,
		fireRate: w.fireRate ?? 6.0,
		maxInFlight: w.maxInFlight ?? 4,
		lastFire: -Infinity,
		minRange: w.minRange ?? 0,
		maxRange: w.maxRange ?? 300000,
		reengageS: w.reengageS ?? 25,
		salvoSize: w.salvoSize ?? 2,
	}));
	const weapons = new WeaponSubsystem({ weapons: layerCfg });

	const SHIP_ONLY = new Set(['ship']);
	const LAND_TARGETS = new Set(['building', 'sam_site', 'ewr', 'ground']);
	const LAYER_ORDER = ['antiship', 'landattack'];

	const command = {
		targetHeading: params.initialHeading ?? 0, targetPitch: 0, throttle: 0,
		targetSpeed: 0, boost: false, fireFlare: false, fireWeapon: false,
		weaponType: null, weaponTarget: null, gunHeading: null, gunPitch: null,
		activeBehaviorName: 'Coastal watch',
	};

	const pilotState = { salvos: {}, engageCooldown: new Map() };

	function horizRange(from, to) {
		const cosLat = Math.cos((from.lat || 0) * DEG);
		const e = (to.lon - from.lon) * 111320 * cosLat;
		const n = (to.lat - from.lat) * 111320;
		return Math.hypot(e, n);
	}

	function liveInFlight(ctx, unit, type) {
		let n = 0;
		for (const p of (ctx.projectiles || [])) {
			if (!p || !p.active || p.launcher !== unit || p.type !== type) continue;
			if (p.lostLock || p.maddog) continue;
			n++;
		}
		return n;
	}

	// Organic contacts first, then the shared team picture — the OTH cue.
	function pickTarget(unit, w, now, allowed, dl, skipEngaged) {
		let best = null, bestR = Infinity;
		const seen = new Set();
		const consider = (t) => {
			if (!t || t.destroyed || t.active === false || seen.has(t)) return;
			seen.add(t);
			if (t.team && unit.team && t.team === unit.team) return;
			const sig = t.signature;
			if (!sig || !allowed.has(sig.unitClass)) return;
			if (skipEngaged && dl && dl.isEngaged(t)) return;
			const r = horizRange(unit, t);
			if (r < w.minRange || r > w.maxRange) return;
			const last = pilotState.engageCooldown.get(t);
			if (last != null && now - last < w.reengageS) return;
			if (r < bestR) { bestR = r; best = { target: t, range: r }; }
		};
		if (unit.contacts) for (const [t] of unit.contacts) consider(t);
		if (dl) for (const [t] of dl.allContacts()) consider(t);
		return best;
	}

	// Same committed-salvo doctrine the ship pilot uses: a hull that has
	// already been shot at is left alone until that salvo resolves, so the
	// battery spreads its magazine across the group instead of dumping
	// everything on the nearest contact.
	function pickSalvo(role, w, pickFresh, stillValid) {
		const sv = pilotState.salvos[role];
		if (sv && sv.remaining > 0 && sv.target &&
			!sv.target.destroyed && sv.target.active !== false && stillValid(sv.target)) {
			return { target: sv.target, salvo: sv };
		}
		pilotState.salvos[role] = null;
		const fresh = pickFresh();
		if (fresh && fresh.target) {
			const nsv = { target: fresh.target, remaining: Math.max(1, w.salvoSize || 1) };
			pilotState.salvos[role] = nsv;
			return { target: fresh.target, salvo: nsv };
		}
		return null;
	}

	function scheduleShot(unit, now, ctx) {
		const dl = ctx && ctx.teamDatalink;
		for (const role of LAYER_ORDER) {
			const w = layerCfg.find(x => x.role === role);
			if (!w || w.ammo <= 0) continue;
			if (unit._disabledWeapons && unit._disabledWeapons.has(w.type)) continue;
			if (now - w.lastFire < w.fireRate) continue;
			if (w.maxInFlight && liveInFlight(ctx, unit, w.type) >= w.maxInFlight) continue;

			if (role === 'antiship') {
				const sres = pickSalvo('antiship', w,
					() => pickTarget(unit, w, now, SHIP_ONLY, dl, true),
					(t) => { const r = horizRange(unit, t); return r >= w.minRange && r <= w.maxRange; });
				if (sres) { sres.salvo.remaining -= 1; return { weapon: w, target: sres.target, role }; }
			} else {
				const pick = pickTarget(unit, w, now, LAND_TARGETS, dl, false);
				if (pick) {
					pilotState.engageCooldown.set(pick.target, now);
					return { weapon: w, target: pick.target, role };
				}
			}
		}
		return null;
	}

	return {
		command,
		subsystems: { weapons },
		update(ctx /*, dt */) {
			const unit = ctx.unit;
			command.fireWeapon = false;
			command.weaponType = null;
			command.weaponTarget = null;

			const shot = scheduleShot(unit, ctx.now, ctx);
			if (shot) {
				command.fireWeapon = true;
				command.weaponType = shot.weapon.type;
				command.weaponTarget = shot.target;
				command.activeBehaviorName = (shot.role === 'antiship')
					? 'Anti-ship salvo' : 'Land strike';
			} else {
				const dry = layerCfg.every(w => w.ammo <= 0);
				command.activeBehaviorName = dry ? 'Magazine dry' : 'Coastal watch';
			}
		},
	};
}
