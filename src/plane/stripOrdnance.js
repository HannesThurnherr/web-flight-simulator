// ============================================================================
// Ordnance stripper.
//
// Many off-the-shelf fighter GLBs come with missiles, bombs, and drop
// tanks baked into the mesh hierarchy. Because our sim spawns actual
// AIM-9 / AIM-120 projectile meshes from the pylons, the baked weapons
// look wrong (decorative, don't launch, clutter the silhouette). We
// don't always have named nodes to strip by name — some exports are
// all anonymous "Object_N" — so this module uses geometric heuristics
// to detect ordnance-shaped meshes and hide them.
//
// A mesh is flagged as ordnance if ALL of:
//   - Cross-section is roughly round (dMid/dMin < 1.8). Pure wings
//     fail this because wings are thin airfoils.
//   - Shape is elongated (dMax/dMid > 3). Squat parts fail this.
//   - Small relative to the overall model (dMax < 30% of model's
//     longest axis). This excludes the fuselage, which is also
//     round-and-elongated.
//   - Sits below the model's vertical centerline. This excludes dorsal
//     antennas and the vertical stabilizer tips that might otherwise
//     pass the other filters.
//
// The function logs what it hid and returns the count so callers can
// sanity-check. Hiding vs removing: we set `visible = false` so the
// geometry is still there if something else references it, and the
// cost of hidden meshes is ~0 in Three.js's render path.
// ============================================================================
import * as THREE from 'three';

export function stripOrdnance(root, opts = {}) {
	const radialMax  = opts.radialMax  ?? 1.8;   // dMid/dMin threshold
	const elongation = opts.elongation ?? 3.0;   // dMax/dMid threshold
	const relLimit   = opts.relLimit   ?? 0.30;  // fraction of model length
	const verticalY  = opts.verticalY  ?? -0.05; // must be below this fraction of model height
	const verbose    = opts.verbose    ?? true;

	// Phase 1: collect geometry metadata for every mesh.
	const items = [];
	root.traverse((child) => {
		if (!child.isMesh || !child.geometry) return;
		if (!child.geometry.boundingBox) child.geometry.computeBoundingBox();
		const bb = child.geometry.boundingBox;
		if (!bb) return;
		const size   = bb.getSize(new THREE.Vector3());
		const center = bb.getCenter(new THREE.Vector3());
		items.push({ mesh: child, name: child.name || '(unnamed)', bb, size, center });
	});

	if (items.length === 0) return 0;

	// Phase 2: compute the union bbox so we can compare per-mesh sizes
	// to the overall model. We can't use root.boundingBox directly
	// because geometries each have their own local frames — taking the
	// union of per-mesh bboxes gives a reasonable proxy.
	const totalMin = new THREE.Vector3( Infinity,  Infinity,  Infinity);
	const totalMax = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
	for (const it of items) {
		totalMin.min(it.bb.min);
		totalMax.max(it.bb.max);
	}
	const modelSize   = new THREE.Vector3().subVectors(totalMax, totalMin);
	const modelCenter = new THREE.Vector3().addVectors(totalMin, totalMax).multiplyScalar(0.5);
	const modelMaxDim = Math.max(modelSize.x, modelSize.y, modelSize.z);

	// Phase 3: evaluate each mesh against the heuristic.
	const stripped = [];
	for (const it of items) {
		const dims = [it.size.x, it.size.y, it.size.z].slice().sort((a, b) => a - b);
		const [dMin, dMid, dMax] = dims;
		if (dMin < 1e-6) continue; // degenerate (flat decal, UV-only mesh, etc.)

		const radialRatio = dMid / dMin;
		const elongRatio  = dMax / dMid;
		const relSize     = dMax / modelMaxDim;
		const relY        = (it.center.y - modelCenter.y) / Math.max(1e-6, modelSize.y);

		const isCylindrical = radialRatio < radialMax;
		const isLong        = elongRatio  > elongation;
		const isSmall       = relSize     < relLimit;
		const isLow         = relY        < verticalY;

		if (isCylindrical && isLong && isSmall && isLow) {
			it.mesh.visible = false;
			stripped.push({ ...it, radialRatio, elongRatio, relSize, relY });
		}
	}

	if (verbose) {
		// Dump EVERY mesh with its ratios + pass/fail flags so we can
		// see why a candidate ordnance mesh didn't get flagged. Remove
		// once the heuristic is dialed in and the bake step has run.
		console.group(`[stripOrdnance] evaluated ${items.length} meshes, hid ${stripped.length}`);
		for (const it of items) {
			const dims = [it.size.x, it.size.y, it.size.z].slice().sort((a, b) => a - b);
			const [dMin, dMid, dMax] = dims;
			if (dMin < 1e-6) {
				console.log(`  "${it.name}"  DEGENERATE`);
				continue;
			}
			const radialRatio = dMid / dMin;
			const elongRatio  = dMax / dMid;
			const relSize     = dMax / modelMaxDim;
			const relY        = (it.center.y - modelCenter.y) / Math.max(1e-6, modelSize.y);
			const flag = (ok) => ok ? '✓' : '✗';
			const stripped = (radialRatio < radialMax && elongRatio > elongation &&
				relSize < relLimit && relY < verticalY);
			console.log(
				`  ${stripped ? '🔴' : '  '} "${it.name}"  ` +
				`size=[${it.size.toArray().map(v => v.toFixed(2)).join(', ')}]  ` +
				`radial=${radialRatio.toFixed(2)}${flag(radialRatio < radialMax)} ` +
				`elong=${elongRatio.toFixed(2)}${flag(elongRatio > elongation)} ` +
				`rel=${relSize.toFixed(2)}${flag(relSize < relLimit)} ` +
				`y=${relY.toFixed(2)}${flag(relY < verticalY)}`,
			);
		}
		console.groupEnd();
	}

	return stripped.length;
}
