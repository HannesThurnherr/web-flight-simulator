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
	RecoverToCarrierBehavior,
	PatrolCapBehavior,
	WaypointFollowBehavior,
	StrikeBehavior,
	EscortBehavior,
	CapAreaBehavior,
	GroundAttackBehavior,
	SamAvoidBehavior,
	InvestigateBehavior,
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
	// Stay out of known SAM engagement bubbles — below missile evasion (a
	// missile already in the air trumps a WEZ boundary) but above everything
	// tactical, because flying into an SA-15 ring to chase a bandit is how
	// the whole CAP dies one by one.
	p.addBehavior(new SamAvoidBehavior());
	// An aircraft ordered home by its carrier is out of the fight — recovery
	// outranks Engage so it doesn't get pulled back in on the way to the ramp,
	// but stays below missile evasion and terrain avoidance.
	p.addBehavior(new RecoverToCarrierBehavior());
	p.addBehavior(new CrankBehavior());
	p.addBehavior(new TerrainAvoidBehavior());
	p.addBehavior(new EngageBehavior());
	// Air-to-ground sits BELOW air-to-air: only prosecutes ground targets when
	// no air threat is active, and only if the jet actually carries A/G
	// ordnance (a clean A2A fighter leaves this inactive). This is what lets an
	// ex-player clone that switched out of a strike/SEAD jet keep working its
	// bombs/HARMs while still dropping everything to defend against fighters.
	p.addBehavior(new GroundAttackBehavior());
	// Below strike work: run down KNOWN air contacts beyond the engagement
	// leash (EWR/AWACS datalink tracks, stale LKPs) instead of idling.
	p.addBehavior(new InvestigateBehavior());
	// Home anchor: with nothing to do, orbit the spawn point instead of
	// flying the Cruise fallback's straight line to the edge of the map.
	// Every chase/evasion eventually ends, and this is what brings the
	// fighter BACK afterward.
	const home = { lon: unit.lon, lat: unit.lat, altM: opts.cruiseAlt ?? 8000 };
	p.addBehavior(new CapAreaBehavior({
		getCenter: () => home,
		altM:     home.altM,
		radiusM:  opts.homeOrbitRadiusM ?? 15000,
		speedMps: opts.cruiseSpeed ?? 300,
	}));
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
	p.addBehavior(new SamAvoidBehavior());
	// Inert unless a carrier has ordered this jet home (see carrierOps.js).
	p.addBehavior(new RecoverToCarrierBehavior());
	p.addBehavior(new CrankBehavior());
	p.addBehavior(new TerrainAvoidBehavior());
	p.addBehavior(new EngageBehavior());
	// Intercept known-but-out-of-leash contacts before falling back to the
	// patrol route — a patrol that ignores an EWR track isn't patrolling.
	p.addBehavior(new InvestigateBehavior());
	p.addBehavior(new WaypointFollowBehavior({
		waypoints: opts.waypoints || [],
		loop:      opts.loop !== false,
		captureRadiusM: opts.captureRadiusM,
	}));
	// Home anchor: orbit the spawn point if the route is empty/consumed
	// rather than flying off in a straight line forever.
	const home = { lon: unit.lon, lat: unit.lat, altM: opts.cruiseAlt ?? 8000 };
	p.addBehavior(new CapAreaBehavior({
		getCenter: () => home,
		altM:     home.altM,
		radiusM:  opts.homeOrbitRadiusM ?? 15000,
		speedMps: opts.cruiseSpeed ?? 300,
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
	p.addBehavior(new SamAvoidBehavior());
	// Inert unless a carrier has ordered this jet home (see carrierOps.js).
	p.addBehavior(new RecoverToCarrierBehavior());
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
		salvoPerTarget:   opts.salvoPerTarget,
		getTargets:       opts.getTargets, // ordered multi-target list
		getTarget:        opts.getTarget,  // legacy single-target fallback
	}));
	// Autonomous ground attack below the scripted strike: once the designated
	// targets are serviced (or between them), use leftover ordnance — notably
	// HARMs on radiating SAMs — to keep suppressing the defences.
	p.addBehavior(new GroundAttackBehavior());
	// Home anchor for the post-egress phase — orbit the spawn point
	// instead of cruising off the map.
	const home = { lon: unit.lon, lat: unit.lat, altM: opts.cruiseAlt ?? 8000 };
	p.addBehavior(new CapAreaBehavior({
		getCenter: () => home,
		altM:     home.altM,
		radiusM:  opts.homeOrbitRadiusM ?? 15000,
		speedMps: opts.cruiseSpeed ?? 280,
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
	p.addBehavior(new SamAvoidBehavior());
	// Inert unless a carrier has ordered this jet home (see carrierOps.js).
	p.addBehavior(new RecoverToCarrierBehavior());
	p.addBehavior(new CrankBehavior());
	p.addBehavior(new TerrainAvoidBehavior());
	p.addBehavior(new EngageBehavior());
	p.addBehavior(new EscortBehavior({
		getEscort:         opts.getEscort,
		standoffM:         opts.standoffM,
		standoffAltOffset: opts.standoffAltOffset,
	}));
	// Home anchor for when the escortee is gone — orbit the spawn point
	// instead of cruising off the map.
	const home = { lon: unit.lon, lat: unit.lat, altM: opts.cruiseAlt ?? 8000 };
	p.addBehavior(new CapAreaBehavior({
		getCenter: () => home,
		altM:     home.altM,
		radiusM:  opts.homeOrbitRadiusM ?? 15000,
		speedMps: opts.cruiseSpeed ?? 240,
	}));
	p.addBehavior(new CruiseBehavior({
		alt:   opts.cruiseAlt   ?? 8000,
		speed: opts.cruiseSpeed ?? 240,
	}));
	return p;
}

// Air-superiority pilot: CAP a station over an AREA and clear the sky in it.
// Orbits the zone center (CapAreaBehavior) and engages any hostile that comes
// inside its engagement reach, then returns to station. The engagement reach
// is LEASHED to the zone (radius + buffer) so the CAP doesn't bird-dog a
// single bandit across the whole theater and abandon the area it's holding.
export function createAirSuperiorityPilot(unit, opts = {}) {
	const zone = opts.zone || {};
	const p = new Pilot(unit);
	p.addSubsystem('countermeasures', new CountermeasureSubsystem({
		flares: opts.flares ?? 30, chaff: opts.chaff ?? 30,
	}));
	// Leash: only commit to bandits within the zone + a buffer.
	const leash = (zone.radiusM ?? 40000) + (opts.engageBufferM ?? 30000);
	p.addSubsystem('targetManager', new TargetManagerSubsystem({
		maxEngagementRange: opts.maxEngagementRange ?? leash,
	}));
	p.addSubsystem('weapons', new WeaponSubsystem({ weapons: opts.weapons }));
	p.addBehavior(new ForwardTerrainAvoidBehavior());
	p.addBehavior(new MissileEvasionBehavior());
	p.addBehavior(new SamAvoidBehavior());
	// Inert unless a carrier has ordered this jet home (see carrierOps.js).
	p.addBehavior(new RecoverToCarrierBehavior());
	p.addBehavior(new CrankBehavior());
	p.addBehavior(new TerrainAvoidBehavior());
	p.addBehavior(new EngageBehavior());
	// Hunt inside (and slightly past) the leash on datalink knowledge —
	// an air-superiority CAP that orbits while the EWR tracks a bandit
	// crossing its zone isn't establishing superiority over anything.
	p.addBehavior(new InvestigateBehavior({ maxRangeM: leash * 1.15 }));
	p.addBehavior(new CapAreaBehavior({
		getCenter: () => zone,
		altM:    zone.altM    ?? opts.cruiseAlt   ?? 8000,
		radiusM: zone.radiusM ?? 12000,
		speedMps: opts.cruiseSpeed ?? 280,
	}));
	p.addBehavior(new CruiseBehavior({ alt: opts.cruiseAlt ?? 8000, speed: opts.cruiseSpeed ?? 280 }));
	return p;
}

// Protect pilot: defend a specific asset — works for BOTH a flying unit (fly
// an escort slot on it) and a ground installation (CAP-orbit over it). Which
// one is active is decided live by the asset's nature, so a single pilot
// adapts if the protected thing takes off / lands. EngageBehavior sits above
// both, so any threat that comes into reach gets intercepted, then the pilot
// drifts back to its escort slot / orbit.
export function createProtectPilot(unit, opts = {}) {
	const getProtected = opts.getProtected || (() => null);
	const isAirborne = (e) => !!(e && (e.kind === 'airborne' ||
		(typeof e.alt === 'number' && e.alt > 300 && (e.speed || 0) > 20)));
	const p = new Pilot(unit);
	p.addSubsystem('countermeasures', new CountermeasureSubsystem({
		flares: opts.flares ?? 30, chaff: opts.chaff ?? 30,
	}));
	p.addSubsystem('targetManager', new TargetManagerSubsystem({
		maxEngagementRange: opts.maxEngagementRange ?? 55000,
	}));
	p.addSubsystem('weapons', new WeaponSubsystem({ weapons: opts.weapons }));
	p.addBehavior(new ForwardTerrainAvoidBehavior());
	p.addBehavior(new MissileEvasionBehavior());
	p.addBehavior(new SamAvoidBehavior());
	// Inert unless a carrier has ordered this jet home (see carrierOps.js).
	p.addBehavior(new RecoverToCarrierBehavior());
	p.addBehavior(new CrankBehavior());
	p.addBehavior(new TerrainAvoidBehavior());
	p.addBehavior(new EngageBehavior());
	// Airborne asset → fly a standoff slot on it.
	p.addBehavior(new EscortBehavior({
		getEscort: () => { const e = getProtected(); return isAirborne(e) ? e : null; },
		standoffM: opts.standoffM ?? 2500,
		standoffAltOffset: opts.standoffAltOffset ?? 300,
	}));
	// Ground asset → CAP-orbit over it.
	p.addBehavior(new CapAreaBehavior({
		getCenter: () => { const e = getProtected(); return (e && !isAirborne(e)) ? e : null; },
		altM:    opts.capAltM    ?? 6000,
		radiusM: opts.capRadiusM ?? 9000,
		speedMps: opts.cruiseSpeed ?? 260,
	}));
	// Asset gone → orbit the spawn point rather than cruising off the map.
	const home = { lon: unit.lon, lat: unit.lat, altM: opts.cruiseAlt ?? 7000 };
	p.addBehavior(new CapAreaBehavior({
		getCenter: () => home,
		altM:     home.altM,
		radiusM:  opts.homeOrbitRadiusM ?? 15000,
		speedMps: opts.cruiseSpeed ?? 280,
	}));
	p.addBehavior(new CruiseBehavior({ alt: opts.cruiseAlt ?? 7000, speed: opts.cruiseSpeed ?? 280 }));
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
	// Inert unless a carrier has ordered this jet home (see carrierOps.js).
	p.addBehavior(new RecoverToCarrierBehavior());
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
