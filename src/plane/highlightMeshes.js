// Diagnostic: replace every mesh's material with a distinct flat color so
// the user can visually see which triangles belong to the same material
// group. If ordnance shares a mesh-group with the fuselage, they'll all
// be the same color — proving the per-mesh strip heuristic can't work
// on this model. If ordnance is its own mesh-group, it'll be its own
// color and we can strip by name/ratio.
//
// Each mesh also gets a console.log entry tagging the color to the mesh
// name, so the user can cross-reference in dev tools.
import * as THREE from 'three';

export function highlightMeshes(root, opts = {}) {
	const alpha  = opts.alpha  ?? 0.9;
	const label  = opts.label  ?? '';

	let idx = 0;
	const palette = [];
	root.traverse((child) => {
		if (!child.isMesh) return;
		// HSL walk around the wheel, fully saturated + bright — maximises
		// distinguishability at the mesh count we have (≤30 typical).
		const hue = (idx * 137.508) % 360; // golden angle for uniform coverage
		const color = new THREE.Color(`hsl(${hue.toFixed(0)}, 90%, 55%)`);
		child.material = new THREE.MeshBasicMaterial({
			color,
			transparent: alpha < 1,
			opacity: alpha,
			side: THREE.DoubleSide, // so we can see the interior if needed
		});
		palette.push({ name: child.name || `(unnamed-${idx})`, hue: hue.toFixed(0) });
		idx++;
	});

	if (palette.length > 0) {
		console.group(`[highlightMeshes] ${label} — ${palette.length} mesh groups`);
		for (const p of palette) {
			console.log(`  %c████%c  hue=${p.hue}  "${p.name}"`,
				`color:hsl(${p.hue},90%,55%);background:hsl(${p.hue},90%,55%);`, 'color:inherit;background:inherit;');
		}
		console.groupEnd();
	}
}
