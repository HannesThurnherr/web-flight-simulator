// ============================================================================
// Volumetric clouds (takram/three-clouds) — Phase 9 attempt #1.
//
// This module wraps the existing Three.js renderer in a postprocessing
// EffectComposer and inserts takram's `CloudsEffect`. Each frame we
// sync an ECEF camera position from Cesium's camera into the effect
// so the raymarcher knows where in the atmosphere we are.
//
// Architectural caveat:
//   We render Cesium and Three.js to TWO separate stacked canvases —
//   Cesium owns the globe + atmosphere on its canvas, Three.js renders
//   units / contrails / particles transparently on top. The clouds
//   draw via a postprocessing pass on the THREE canvas, so they
//   visually overlay onto Cesium's view rather than depth-blending
//   with terrain. At cumulus altitudes (~3 km+) this looks mostly
//   correct — clouds sit between sky and close-up objects. Low
//   broken stratus over a mountain would float ON TOP of the mountain
//   silhouette rather than wrapping around it. Acceptable for now;
//   would need a single-canvas Cesium-Three pipeline to fully fix.
//
// Cost:
//   ~3-10 ms per frame at Medium preset on a desktop GPU. We expose a
//   quality dial so the player can dial it down if FPS suffers.
// ============================================================================
import * as THREE from 'three';
import * as Cesium from 'cesium';
import { EffectComposer, EffectPass, RenderPass } from 'postprocessing';
import { CloudsEffect } from '@takram/three-clouds';

export class CloudLayer {
	constructor(renderer, scene, camera) {
		this.renderer = renderer;
		this.scene    = scene;
		this.camera   = camera;
		this._enabled = true;

		// Build the composer chain: render the scene first, then the
		// clouds effect, then the chain implicitly outputs to the
		// canvas. RenderPass renderToScreen=false; EffectPass writes
		// the composited result to the canvas.
		this.composer = new EffectComposer(renderer);
		this.renderPass = new RenderPass(scene, camera);
		this.composer.addPass(this.renderPass);

		// Default coverage / preset values. `coverage` is roughly the
		// fraction of sky covered by clouds (0 = clear, 1 = overcast);
		// 0.3 is a mostly-clear sky with scattered cumulus.
		this.cloudsEffect = new CloudsEffect(camera);
		this.cloudsEffect.coverage = 0.3;
		this.effectPass = new EffectPass(camera, this.cloudsEffect);
		this.composer.addPass(this.effectPass);

		// Match composer size to renderer.
		this.composer.setSize(window.innerWidth, window.innerHeight);
		window.addEventListener('resize', () => {
			this.composer.setSize(window.innerWidth, window.innerHeight);
		});

		// Scratch math objects.
		this._ecefPos    = new Cesium.Cartesian3();
		this._three  = new THREE.Vector3();
	}

	setEnabled(v) { this._enabled = !!v; }

	// Quality preset: 'low' / 'medium' / 'high'. Maps to render-target
	// resolution scaling; the takram defaults are a reasonable Medium.
	setQuality(q) {
		const scale = (q === 'low')   ? 0.5
		            : (q === 'high')  ? 1.0
		            : /* medium */     0.75;
		// Postprocessing's resolutionScale is on the EffectPass /
		// composer; setting render-target dimensions directly is
		// the broadly-supported route across versions.
		this.composer.setSize(
			Math.floor(window.innerWidth  * scale),
			Math.floor(window.innerHeight * scale),
		);
	}

	// Sync the cloud effect's notion of "where am I in the atmosphere"
	// from Cesium's camera. The Three.js camera in this codebase sits
	// at origin with world objects baked into camera-relative matrices
	// each frame, so we can't read camera.getWorldPosition() and get
	// anything useful — Cesium's camera is the only thing that knows
	// our real ECEF position.
	syncFromCesium(viewer) {
		if (!viewer || !viewer.camera) return;
		// Cesium camera position is already in ECEF (Cartesian3 in
		// fixed-frame coordinates). takram expects an ECEF position
		// in metres, which is exactly what positionWC delivers.
		const pos = viewer.camera.positionWC;
		// We need to make the THREE camera report this as its world
		// position, so CloudsEffect.getWorldPosition picks it up.
		// Mutating camera.position directly is safe — none of our
		// downstream rendering reads camera.position (it uses the
		// camera-space-baked matrices instead).
		this.camera.position.set(pos.x, pos.y, pos.z);
		this.camera.updateMatrixWorld(true);
	}

	render(viewer) {
		if (!this._enabled) {
			this.renderer.render(this.scene, this.camera);
			return;
		}
		this.syncFromCesium(viewer);
		this.composer.render();
	}
}
