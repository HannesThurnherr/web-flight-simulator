// Factory helpers for assembling pilots from the AI building blocks.
// Keeps the standard "fighter-pilot" wiring in one place so npcSystem (and,
// later, wingman support for the player's team) don't have to duplicate it.

import { Pilot } from './pilot.js';
import {
	CruiseBehavior,
	TerrainAvoidBehavior,
	ForwardTerrainAvoidBehavior,
	MissileEvasionBehavior,
	CrankBehavior,
	EngageBehavior,
	FormationBehavior,
	PatrolRtbBehavior,
	PatrolCapBehavior,
	WaypointFollowBehavior,
	StrikeBehavior,
	EscortBehavior,
} from './behaviors.js';
import {
	CountermeasureSubsystem,
	TargetManagerSubsystem,
	WeaponSubsystem,
} from './subsystems.js';

// Standard fighter pilot: flare/chaff + weapons + target manager, and a
// priority stack of evade → terrain → engage → cruise. Terrain avoid is
// priority 1 as a "safety net" above every tactical behavior.
export function createFighterPilot(unit, opts = {}) {
	const p = new Pilot(unit);
	p.addSubsystem('countermeasures', new CountermeasureSubsystem({
		flares: opts.flares ?? 30,
		chaff:  opts.chaff  ?? 30,
	}));
	p.addSubsystem('targetManager', new TargetManagerSubsystem({
		maxEngagementRange: opts.maxEngagementRange ?? 70000,
	}));
	p.addSubsystem('weapons', new WeaponSubsystem({
		weapons: opts.weapons, // undefined → subsystem default loadout
	}));
	// Priority order: first isActive wins.
	// ForwardTerrainAvoid sits at the top — predicted ridge ahead
	// trumps even the missile-evasion beam, briefly, until the path
	// is clear again. Crank slots between MissileEvasion and Engage so
	// post-launch BVR support overrides re-engagement attempts (we don't
	// want to keep nose-on after firing a Fox-3) but yields to actual
	// inbound-missile defence.
	p.addBehavior(new ForwardTerrainAvoidBehavior());
	p.addBehavior(new MissileEvasionBehavior());
	p.addBehavior(new CrankBehavior());
	p.addBehavior(new TerrainAvoidBehavior());
	p.addBehavior(new EngageBehavior());
	p.addBehavior(new CruiseBehavior({
		alt:   opts.cruiseAlt   ?? 8000,
		speed: opts.cruiseSpeed ?? 300,
	}));
	return p;
}

// Patrol pilot: a fighter pilot that follows a waypoint route when
// no enemy is in sight, and engages-on-sight the moment one is.
// Same priority chain as createFighterPilot, with WaypointFollow
// inserted between Engage and Cruise — Engage still wins when a
// bandit is in range, so the pilot intercepts; once the engagement
// is over (target dead, defended, or out of range) the pilot
// resumes the route. Cruise stays at the bottom as a fallback for
// edge cases (waypoints all consumed in non-loop mode).
export function createPatrolPilot(unit, opts = {}) {
	const p = new Pilot(unit);
	p.addSubsystem('countermeasures', new CountermeasureSubsystem({
		flares: opts.flares ?? 30,
		chaff:  opts.chaff  ?? 30,
	}));
	p.addSubsystem('targetManager', new TargetManagerSubsystem({
		maxEngagementRange: opts.maxEngagementRange ?? 70000,
	}));
	p.addSubsystem('weapons', new WeaponSubsystem({
		weapons: opts.weapons,
	}));
	p.addBehavior(new ForwardTerrainAvoidBehavior());
	p.addBehavior(new MissileEvasionBehavior());
	p.addBehavior(new CrankBehavior());
	p.addBehavior(new TerrainAvoidBehavior());
	p.addBehavior(new EngageBehavior());
	p.addBehavior(new WaypointFollowBehavior({
		waypoints: opts.waypoints || [],
		loop:      opts.loop !== false,
		captureRadiusM: opts.captureRadiusM,
	}));
	p.addBehavior(new CruiseBehavior({
		alt:   opts.cruiseAlt   ?? 8000,
		speed: opts.cruiseSpeed ?? 300,
	}));
	return p;
}

// Strike pilot: ingress route → release weapon on target → egress
// route. EngageBehavior still wins above this; if a fighter
// intercepts mid-ingress, we defend, then resume. Cruise stays as
// the post-egress fallback.
export function createStrikePilot(unit, opts = {}) {
	const p = new Pilot(unit);
	p.addSubsystem('countermeasures', new CountermeasureSubsystem({
		flares: opts.flares ?? 30,
		chaff:  opts.chaff  ?? 30,
	}));
	p.addSubsystem('targetManager', new TargetManagerSubsystem({
		maxEngagementRange: opts.maxEngagementRange ?? 70000,
	}));
	p.addSubsystem('weapons', new WeaponSubsystem({
		weapons: opts.weapons,
	}));
	p.addBehavior(new ForwardTerrainAvoidBehavior());
	p.addBehavior(new MissileEvasionBehavior());
	p.addBehavior(new CrankBehavior());
	p.addBehavior(new TerrainAvoidBehavior());
	p.addBehavior(new EngageBehavior());
	p.addBehavior(new StrikeBehavior({
		ingressWaypoints: opts.ingressWaypoints,
		egressWaypoints:  opts.egressWaypoints,
		weaponType:       opts.weaponType,
		terminalRangeM:   opts.terminalRangeM,
		captureRadiusM:   opts.captureRadiusM,
		weaponCount:      opts.weaponCount,
		getTarget:        opts.getTarget,
	}));
	p.addBehavior(new CruiseBehavior({
		alt:   opts.cruiseAlt   ?? 8000,
		speed: opts.cruiseSpeed ?? 280,
	}));
	return p;
}

// Escort pilot: hold a slot near a designated unit (the AWACS we're
// shielding, the strike package we're shepherding). Engage runs
// above this, so any hostile that comes into the TargetManager's
// engagement range pulls us off station to intercept; once dealt
// with, we drift back to slot.
export function createEscortPilot(unit, opts = {}) {
	const p = new Pilot(unit);
	p.addSubsystem('countermeasures', new CountermeasureSubsystem({
		flares: opts.flares ?? 30,
		chaff:  opts.chaff  ?? 30,
	}));
	p.addSubsystem('targetManager', new TargetManagerSubsystem({
		// Default engage range tighter than a free CAP fighter — an
		// escort that races 70 km off station for every bandit
		// abandons the asset it's supposed to be shielding.
		maxEngagementRange: opts.maxEngagementRange ?? 35000,
	}));
	p.addSubsystem('weapons', new WeaponSubsystem({
		weapons: opts.weapons,
	}));
	p.addBehavior(new ForwardTerrainAvoidBehavior());
	p.addBehavior(new MissileEvasionBehavior());
	p.addBehavior(new CrankBehavior());
	p.addBehavior(new TerrainAvoidBehavior());
	p.addBehavior(new EngageBehavior());
	p.addBehavior(new EscortBehavior({
		getEscort:         opts.getEscort,
		standoffM:         opts.standoffM,
		standoffAltOffset: opts.standoffAltOffset,
	}));
	p.addBehavior(new CruiseBehavior({
		alt:   opts.cruiseAlt   ?? 8000,
		speed: opts.cruiseSpeed ?? 240,
	}));
	return p;
}

// Wingman pilot: same subsystems as a fighter (it IS a fighter; just
// flying for the player's flight) but the behavior priority stack
// inserts FormationBehavior + PatrolRtb/Cap so the wingman does what
// the player wants instead of running its own combat AI:
//
//   0  ForwardTerrainAvoid   — terrain safety (unchanged)
//   1  MissileEvasion        — break for incoming missiles (unchanged)
//   2  Crank                 — post-shot off-axis support (unchanged)
//   3  TerrainAvoid          — AGL safety net (unchanged)
//   4  Formation             — hold slot under leader  ← new
//   5  Engage                — fight back (only meaningful in patrol modes;
//                              in formation mode FormationBehavior wins)
//   6  PatrolRtb             — break-formation orbit at spawn point
//   7  PatrolCap             — break-formation orbit near leader
//   8  Cruise                — last resort default
//
// FormationBehavior sits ABOVE Engage so a wingman in formation never
// goes after a bandit on its own initiative — the player calls every
// shot. Once formation breaks (mode flips to patrol-*), FormationBehavior
// goes inactive and Engage gets a turn at the wheel ahead of Patrol*.
export function createWingmanPilot(unit, opts = {}) {
	const p = new Pilot(unit);
	p.addSubsystem('countermeasures', new CountermeasureSubsystem({
		flares: opts.flares ?? 30,
		chaff:  opts.chaff  ?? 30,
	}));
	p.addSubsystem('targetManager', new TargetManagerSubsystem({
		maxEngagementRange: opts.maxEngagementRange ?? 70000,
	}));
	p.addSubsystem('weapons', new WeaponSubsystem({
		weapons: opts.weapons,
	}));
	p.addBehavior(new ForwardTerrainAvoidBehavior());
	p.addBehavior(new MissileEvasionBehavior());
	p.addBehavior(new CrankBehavior());
	p.addBehavior(new TerrainAvoidBehavior());
	p.addBehavior(new FormationBehavior());
	p.addBehavior(new EngageBehavior());
	p.addBehavior(new PatrolRtbBehavior());
	p.addBehavior(new PatrolCapBehavior());
	p.addBehavior(new CruiseBehavior({
		alt:   opts.cruiseAlt   ?? 8000,
		speed: opts.cruiseSpeed ?? 300,
	}));
	return p;
}
