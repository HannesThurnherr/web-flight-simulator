// AWACS-supported BVR scenario.
//
// Same triangular three-way as bvr3way, but with a friendly E-767 AWACS
// orbiting 80 km behind the player. The AWACS publishes its radar
// contacts into the friendly team datalink — the player (who's also on
// team 'friendly') gets a shared picture that extends well beyond their
// own radar, and any friendly AIM-120 in flight can coast on the AWACS
// midcourse track when the launcher's own radar drops the target.
//
// Gameplay feel:
//   - You see the red-team / blue-team spawn from first contact
//     (~180 km) on your sensor picture, not just your own radar.
//   - Your AMRAAMs don't go dark if you crank or break radar — AWACS
//     keeps the datalink alive.
//   - Hostile teams don't have AWACS, so they're blind past their own
//     radar horizon, giving a realistic "we see more than they do"
//     asymmetry.

export const awacsBvrScenario = {
	id: 'awacs-bvr',
	name: 'AWACS BVR',
	description: 'Three-way 180 km BVR fight with a friendly E-767 AWACS feeding the datalink.',

	onStart(ctx) {
		const { npcSystem, playerState } = ctx;
		npcSystem.autoSpawn = true;
		// Full long-range BVR — 180 km triangle, ~1–2 min closure time,
		// full engagement sequence (detection → shot → crank → midcourse
		// → pitbull → terminal) has room to play out.
		npcSystem.triangleSide = 180000;

		// Park the AWACS ~80 km behind the player (south, if the player
		// is facing north into the triangle) at 11 km altitude. It
		// orbits a 40 km radius loop and carries a 500 km radar.
		const plat = playerState.lat * Math.PI / 180;
		const AWACS_BEARING = 180; // due south of player
		const AWACS_RANGE   = 80000;
		const b = AWACS_BEARING * Math.PI / 180;
		const dE = AWACS_RANGE * Math.sin(b);
		const dN = AWACS_RANGE * Math.cos(b);
		const awacsLon = playerState.lon + dE / (111320 * Math.cos(plat));
		const awacsLat = playerState.lat + dN / 111320;
		const awacsAlt = 11000;

		this._awacs = npcSystem.spawnAwacs(awacsLon, awacsLat, awacsAlt, 'friendly');

		// Seed one fighter NPC on each of the two hostile triangle
		// vertices so the engagement starts populated — same effect
		// as bvr3way.
		npcSystem.spawnNPC(playerState.lon, playerState.lat, playerState.alt);
	},

	update(/* ctx, dt */) {
		// Nothing scripted — the AWACS flies its orbit via its own pilot,
		// the datalink handles itself, the NPC system keeps the fight
		// populated.
	},

	onStop(ctx) {
		ctx.npcSystem.autoSpawn = true;
		this._awacs = null;
	},
};
