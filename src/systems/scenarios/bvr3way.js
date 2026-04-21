// 3-Way BVR Fight — the original free-for-all scenario.
//
// Three factions (player=friendly, hostile-red, hostile-blue) spawn on a
// 70 km equilateral triangle centered on the player's pick. The NPC system
// auto-spawns reinforcements on a fixed cadence until a cap is reached.
// Every faction treats the other two as hostile, so you get emergent
// three-way engagements — pick a side, pick off loners, or try to out-live
// everyone.
//
// This scenario is intentionally thin: the npcSystem's built-in triangle
// spawn logic already does all the work. We just flip its `autoSpawn` flag
// on and seed the first NPC.

export const bvr3wayScenario = {
	id: 'bvr3way',
	name: '3-Way BVR Fight',
	description: 'Three factions on a 70 km triangle. Player + two hostile teams. Auto-reinforced.',

	onStart(ctx) {
		ctx.npcSystem.autoSpawn = true;
		// Default close-range triangle (70 km). Fast iteration — closure
		// time is a few tens of seconds, so test turnaround stays short.
		// The AWACS scenario uses 180 km for the full long-range BVR
		// sequence; setting the value explicitly here keeps scenario
		// switching clean.
		ctx.npcSystem.triangleSide = 70000;
		ctx.npcSystem.spawnNPC(ctx.playerState.lon, ctx.playerState.lat, ctx.playerState.alt);
	},

	update(/* ctx, dt */) {
		// Nothing scripted — npcSystem keeps the battlefield populated.
	},

	onStop(ctx) {
		// Clearing happens in main.js via enterSpawnPicking -> npcSystem.clear()
		// already; nothing scenario-specific to tear down.
		ctx.npcSystem.autoSpawn = true;
	},
};
