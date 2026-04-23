// ============================================================================
// Dev-only mesh strip diagnostic.
//
// Shift+Left-click on any mesh belonging to the player's plane or an NPC
// toggles its visibility AND every mesh sharing the same name across all
// aircraft instances (so you can see the effect on every NPC at once).
// Names accumulate in `window.__strippedMeshes` so they can be copied out
// and compared between clicks. Also toggles on the NPC model template so
// future-spawned NPCs inherit the state.
//
// Moved out of main.js so the game-bootstrap file isn't cluttered with
// debug tooling. Remove or gate behind a build flag when the strip list
// is finalised.
// ============================================================================

import * as THREE from 'three';

// ctx.scene        — THREE.Scene
// ctx.camera       — THREE.Camera used for raycasting
// ctx.getPlaneModel — () => planeModel (late-bound; may be null early)
// ctx.getNpcSystem  — () => npcSystem  (late-bound)
export function setupMeshStripDiagnostic(ctx) {
	const raycaster = new THREE.Raycaster();
	raycaster.layers.enableAll(); // planeModel sits on layer 1
	const ndc = new THREE.Vector2();
	if (!window.__strippedMeshes) window.__strippedMeshes = new Set();

	window.addEventListener('mousedown', (e) => {
		if (!e.shiftKey || e.button !== 0) return;
		const scene  = ctx.scene;
		const camera = ctx.camera;
		if (!scene || !camera) return;
		e.preventDefault();
		e.stopPropagation();

		ndc.x =  (e.clientX / window.innerWidth)  * 2 - 1;
		ndc.y = -(e.clientY / window.innerHeight) * 2 + 1;
		raycaster.setFromCamera(ndc, camera);

		// Build the list of roots to test: player's plane (if loaded)
		// plus every NPC mesh (via npcSystem.npcs[i].mesh). The NPC
		// template is a shared clone, so each NPC has its own mesh.
		const roots = [];
		const planeModel = ctx.getPlaneModel ? ctx.getPlaneModel() : null;
		const npcSystem  = ctx.getNpcSystem  ? ctx.getNpcSystem()  : null;
		if (planeModel) roots.push(planeModel);
		if (npcSystem && npcSystem.npcs) {
			for (const n of npcSystem.npcs) if (n && n.mesh) roots.push(n.mesh);
		}

		const hits = raycaster.intersectObjects(roots, true);
		if (hits.length === 0) {
			console.log('[mesh-strip] no hit');
			return;
		}
		// Skip any hits that aren't a Mesh with a geometry — e.g. the
		// point-light entities on the player's jet flames.
		const hit = hits.find(h => h.object && h.object.isMesh);
		if (!hit) return;

		const m = hit.object;
		const key = m.name || `(unnamed-${m.id})`;
		// Toggle visibility on the picked mesh. Also hide/show every
		// mesh with the same name across all planes so you can see the
		// effect on every NPC at once, not just the one you clicked.
		const nowHidden = m.visible; // about to flip
		for (const root of roots) {
			root.traverse((child) => {
				if (child.isMesh && (child.name || '') === (m.name || '') && child === m) {
					child.visible = !nowHidden;
				} else if (child.isMesh && m.name && child.name === m.name) {
					child.visible = !nowHidden;
				}
			});
		}
		// Also toggle on the NPC template so future-spawned NPCs
		// inherit the state.
		if (npcSystem && npcSystem.modelTemplate) {
			npcSystem.modelTemplate.traverse((child) => {
				if (child.isMesh && m.name && child.name === m.name) {
					child.visible = !nowHidden;
				}
			});
		}

		if (nowHidden) window.__strippedMeshes.add(key);
		else           window.__strippedMeshes.delete(key);
		console.log(`[mesh-strip] ${nowHidden ? 'HID' : 'SHOW'}  "${key}"   total stripped: ${window.__strippedMeshes.size}`);
		console.log('  current strip list:', Array.from(window.__strippedMeshes));
	}, true); // capture: beat the other mousedown handlers
}
