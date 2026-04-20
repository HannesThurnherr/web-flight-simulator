// ============================================================================
// Pilot — the top-level AI controller attached to any AI-driven unit.
//
// Architecture:
//
//   unit.pilot = new Pilot(unit)
//       ├── subsystems          — shared state/capability (flare inventory,
//       │                         target picker, weapon selector, …)
//       └── behaviors           — priority-ordered decision makers.
//                                 First isActive(ctx) wins and calls
//                                 apply(ctx, command, dt).
//
// Each frame the unit owner (e.g. npcSystem) builds a context, calls
// pilot.update(ctx, dt), and then reads pilot.command to drive physics and
// effects. The pilot never directly moves the unit — it just writes its
// desires into a PilotCommand. This keeps the AI decoupled from the
// simulation: swap physics, or run the same pilot on a different kind of
// airframe, and nothing inside the behaviors needs to change.
//
// Extensibility notes:
//   - Adding a new behavior = new class + insert into the priority list.
//   - Adding a new subsystem = new class + attach via addSubsystem.
//   - Both can read pilot.unit / pilot.subsystems / ctx.
//   - Behaviors do NOT share direct mutable state; everything flows through
//     the PilotCommand and subsystem queries.
// ============================================================================

export class PilotCommand {
	constructor() {
		this.reset();
	}

	// Called at the start of each frame to establish safe defaults. If no
	// behavior applies, the command object ends up roughly "hold current
	// heading / pitch / speed" which is the sanest fallback.
	reset(unit = null) {
		this.targetHeading = unit ? (unit.heading || 0) : 0;
		this.targetPitch   = unit ? (unit.pitch   || 0) : 0;
		this.targetSpeed   = 300;     // m/s — rough fighter cruise
		this.throttle      = 0.7;     // 0..1
		this.boost         = false;
		this.fireWeapon    = false;   // primary: gun or selected missile
		this.weaponType    = null;    // 'AIM-120' | 'AIM-9' | 'gun'
		this.weaponTarget  = null;    // ref to target unit
		this.fireFlare     = false;
		this.fireChaff     = false;
		this.activeBehaviorName = null;
	}
}

export class Pilot {
	constructor(unit) {
		this.unit = unit;
		this.behaviors  = [];  // priority-ordered; first isActive wins
		this.subsystems = {};
		this.command    = new PilotCommand();
	}

	// Returns `this` for chaining during pilot construction.
	addBehavior(behavior) {
		this.behaviors.push(behavior);
		behavior.pilot = this;
		return this;
	}

	addSubsystem(key, subsystem) {
		this.subsystems[key] = subsystem;
		subsystem.pilot = this;
		return this;
	}

	// Advance the pilot one tick.
	//   ctx = { unit, now, dt, world? } — shared context object the caller
	//   builds each frame. Passing a dedicated object instead of mutating
	//   Pilot state keeps the pilot side-effect-free w.r.t. the world.
	update(ctx, dt) {
		this.command.reset(this.unit);

		// Subsystems tick first — they read context, update their internal
		// state (cooldowns, inventory, cached "best target"), and are then
		// queried by behaviors.
		for (const key in this.subsystems) {
			const s = this.subsystems[key];
			if (s.update) s.update(ctx, dt);
		}

		// First behavior whose isActive returns true gets to write the
		// command. No two behaviors run in the same frame — this is the
		// subsumption-architecture guarantee: one clear owner of control.
		for (const b of this.behaviors) {
			if (b.isActive(ctx)) {
				b.apply(ctx, this.command, dt);
				this.command.activeBehaviorName = b.name;
				return;
			}
		}
	}
}
