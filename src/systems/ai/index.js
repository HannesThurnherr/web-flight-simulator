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
