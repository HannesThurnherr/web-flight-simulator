// ============================================================================
// Ship damage model.
//
// A warship is not a fighter — one hit shouldn't delete it. Instead each hit:
//   1. subtracts hit points (scaled by the warhead);
//   2. rolls to knock a SUBSYSTEM offline (propulsion / radar / a weapon
//      mount), each of which degrades the ship in a specific way;
//   3. rolls for a CATASTROPHIC kill (magazine / fuel detonation) that sinks
//      her outright — more likely the bigger the hit and the more hurt she
//      already is;
//   4. pours smoke + fire off the impact point.
// When HP runs out or a catastrophic roll lands, she SINKS: dead in the water,
// listing, settling under (the waterline clip plane swallows the hull as she
// goes down), then gone.
//
// Damage state lives on the NPC:
//   npc.hp / npc.maxHp        hit points
//   npc._mobilityHit          propulsion dead → can't make way
//   npc._sensorsHit           radar dead → can't detect / guide
//   npc._disabledWeapons      Set<weaponType> knocked-out mounts
//   npc.sinking               { ...animation state } once she's going down
//
// Consumers: hitNPC (missile) / bullet route surface hits here; npcUpdate
// drives the sinking animation + ongoing damage smoke; the ship pilot reads
// the subsystem flags to stop moving / firing dead mounts; sensorSystem stops
// painting once radar is dead (we flip sensors.radar.enabled); and target
// pickers drop her once she's sinking (we flip npc.active = false).
// ============================================================================

import { particles } from '../utils/particles.js';
import { pushKill } from './eventLog.js';

// Set up HP + damage bookkeeping on a freshly-spawned surface unit.
export function initShipHealth(npc, platform) {
	const hp = platform.hp ?? platform.armor ?? 100;
	npc.hp = hp;
	npc.maxHp = hp;
	npc._mobilityHit = false;
	npc._sensorsHit = false;
	npc._disabledWeapons = new Set();
	npc.sinking = null;
	npc._dmgSmokeT = 0;
}

// Apply one hit. `dmg` = damage points (callers pass the warhead's kill radius
// as a proxy — bigger warhead, bigger number). `pos` = {lon,lat,alt} impact.
export function applyShipDamage(npc, dmg, pos, weaponType, shooter) {
	if (!npc || npc.destroyed || npc.sinking) return;
	if (npc.hp == null) { npc.destroyed = true; return; } // untracked → fall back to old behaviour
	npc.hp -= dmg;

	// Impact effects — a flash plus a gout of fire and dark smoke at the hit.
	try {
		particles.spawnExplosion(pos.lon, pos.lat, pos.alt, { count: 22, smokeCount: 10, big: false });
		particles.spawnFire(pos.lon, pos.lat, pos.alt, { count: 6, size: 1.5 });
		particles.spawnSmoke(pos.lon, pos.lat, pos.alt, { dark: true, count: 8, size: 2.6 });
	} catch (e) { /* particles optional */ }

	const dmgFrac = dmg / Math.max(1, npc.maxHp);
	const hpFrac  = Math.max(0, npc.hp) / npc.maxHp;

	// Catastrophic kill: a magazine / fuel-bunker hit that sinks her outright.
	// PROPORTIONAL to hit size (no flat base) so a missile warhead is a real
	// threat while a stray gun round barely registers, plus a rising bonus as
	// she's already crippled. A Harpoon-class hit lands ~25%, a 20 mm round ~1%.
	const catastrophic = Math.min(0.6, dmgFrac * 0.7 + (1 - hpFrac) * 0.12);
	if (npc.hp <= 0 || Math.random() < catastrophic) {
		startSinking(npc, shooter, weaponType);
		return;
	}

	// Otherwise roll to knock a subsystem offline — also proportional to hit
	// size, so a missile commonly takes a mount/engine/radar out and bullets
	// almost never do.
	if (Math.random() < Math.min(0.85, dmgFrac * 2.0)) knockOutRandomSubsystem(npc);
}

function knockOutRandomSubsystem(npc) {
	const candidates = [];
	if (!npc._mobilityHit) candidates.push('mobility');
	if (!npc._sensorsHit && npc.sensors && npc.sensors.radar) candidates.push('sensors');
	const ws = npc.pilot && npc.pilot.subsystems && npc.pilot.subsystems.weapons;
	if (ws) for (const w of ws.weapons) {
		if (w.ammo > 0 && !npc._disabledWeapons.has(w.type)) candidates.push('weapon:' + w.type);
	}
	if (!candidates.length) return;
	const pick = candidates[Math.floor(Math.random() * candidates.length)];
	if (pick === 'mobility') {
		npc._mobilityHit = true;
	} else if (pick === 'sensors') {
		npc._sensorsHit = true;
		if (npc.sensors.radar) npc.sensors.radar.enabled = false;   // sensorSystem stops painting
	} else {
		npc._disabledWeapons.add(pick.slice(7));
	}
}

// Begin the sinking sequence. Logs the kill, makes her untargetable, and
// detonates a big secondary.
export function startSinking(npc, shooter, weaponType) {
	if (npc.sinking) return;
	try {
		pushKill({ shooter, target: npc, weapon: weaponType || 'WEAPON',
			at: performance.now() * 0.001, reason: 'sunk' });
	} catch (e) { /* optional */ }
	npc.sinking = {
		elapsed: 0,
		duration: 16,                                  // seconds to go fully under
		listDir:  Math.random() < 0.5 ? 1 : -1,
		listMax:  26 + Math.random() * 16,             // degrees of list
		pitchDir: Math.random() < 0.5 ? 1 : -1,
		pitchMax: 9 + Math.random() * 8,               // degrees of bow/stern settle
		maxDepth: 55,                                  // metres she settles under
		smokeT:   0,
	};
	npc.active = false;   // drop out of every target picker (they skip active===false)
	try {
		particles.spawnExplosion(npc.lon, npc.lat, (npc.alt || 0) + 6,
			{ count: 70, smokeCount: 24, big: true });
	} catch (e) { /* optional */ }
}

// Drive the sinking animation. Called from npcUpdate each frame while
// npc.sinking is set; flips npc.destroyed when she's gone under.
export function updateShipSinking(npc, dt) {
	const s = npc.sinking;
	s.elapsed += dt;
	const t = Math.min(1, s.elapsed / s.duration);
	const e = t * t * (3 - 2 * t);                     // smoothstep ease

	npc.speed = Math.max(0, npc.speed - 4 * dt);       // drift to a stop
	npc.roll  = s.listDir  * s.listMax  * e;           // heel over
	npc.pitch = s.pitchDir * s.pitchMax * e;           // settle by bow/stern
	// Accelerating descent under the waterline; the clip plane hides the hull
	// progressively as alt drops below the sea surface.
	const depth = s.maxDepth * (t * t);
	// Settle from wherever the hull actually floats. `?? 0` here used to
	// teleport a sinking ship to ellipsoid height mid-animation.
	const seaRef = (npc._seaRefH != null) ? npc._seaRefH : (npc.alt - (npc._groundOffsetM || 0));
	npc.alt = seaRef + (npc._groundOffsetM || 0) - depth;

	s.smokeT += dt;
	if (s.smokeT >= 0.06) {
		s.smokeT = 0;
		try {
			particles.spawnSmoke(npc.lon, npc.lat, (npc.alt || 0) + 8, { dark: true, count: 6, size: 4 });
			if (t < 0.8) particles.spawnFire(npc.lon, npc.lat, (npc.alt || 0) + 5, { count: 4, size: 2 });
		} catch (e) { /* optional */ }
	}

	if (s.elapsed >= s.duration) {
		npc.destroyed = true;                          // top-of-loop cleanup removes her
		try {
			particles.spawnSmoke(npc.lon, npc.lat, seaRef, { dark: true, count: 14, size: 5 });
		} catch (e) { /* optional */ }
	}
}

// Ongoing smoke/fire for a damaged-but-afloat ship — denser the more hurt she
// is. Called from npcUpdate for surface units that aren't sinking.
export function updateShipDamageSmoke(npc, dt) {
	if (npc.hp == null || npc.sinking) return;
	const hpFrac = Math.max(0, npc.hp) / npc.maxHp;
	if (hpFrac >= 0.7) return;                          // only smoke when meaningfully hurt
	npc._dmgSmokeT = (npc._dmgSmokeT || 0) + dt;
	const interval = 0.15 + hpFrac * 0.5;               // more damage → more smoke
	if (npc._dmgSmokeT >= interval) {
		npc._dmgSmokeT = 0;
		try {
			particles.spawnSmoke(npc.lon, npc.lat, (npc.alt || 0) + 10, { dark: true, count: 3, size: 3 });
			if (hpFrac < 0.35) particles.spawnFire(npc.lon, npc.lat, (npc.alt || 0) + 6, { count: 2, size: 1.4 });
		} catch (e) { /* optional */ }
	}
}
