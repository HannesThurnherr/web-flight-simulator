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
