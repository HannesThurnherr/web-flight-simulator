// ============================================================================
// Plane preview widget.
//
// A small 3D viewport in the main menu showing the currently-selected
// airframe, slowly spinning. Uses its own WebGLRenderer + Scene so it
// doesn't interfere with the main flight scene.
//
// Lifecycle:
//   const p = new PlanePreview(canvasEl);
//   p.load(planeConfig);     // pulled from PLANES registry
//   // (animation runs autonomously via requestAnimationFrame)
//   p.dispose();             // stop the loop, free WebGL resources
//
// Pulls apart plane config the same way main.js does — modelRotation,
// hideNodes — so what you see in the preview is what you fly in-sim.
// Materials stay as-loaded (no highlighting or ordnance stripping
// beyond hideNodes), giving a faithful "what you're buying" view.
// ============================================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const ROTATION_RATE_RAD_S = 0.35;   // slow orbit speed for readability
const CAMERA_FIT_RADIUS   = 4.0;    // target world-space radius the plane fills

export class PlanePreview {
	constructor(canvas) {
		this.canvas = canvas;

		this.scene  = new THREE.Scene();
		this.camera = new THREE.PerspectiveCamera(
			40,
			canvas.clientWidth / Math.max(1, canvas.clientHeight),
			0.1, 1000,
		);
		// Gentle three-quarter view, slightly above horizontal.
		this.camera.position.set(5.0, 2.2, 5.0);
		this.camera.lookAt(0, 0, 0);

		this.renderer = new THREE.WebGLRenderer({
			canvas,
			antialias: true,
			alpha: true,
		});
		this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
		this.renderer.setPixelRatio(window.devicePixelRatio);
		this.renderer.setClearColor(0x000000, 0);

		// Light rig: one soft ambient + one directional key. Enough to
		// read the airframe silhouette without over-sculpting flat
		// materials that some GLBs ship with.
		this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
		const key = new THREE.DirectionalLight(0xffffff, 0.9);
		key.position.set(5, 6, 4);
		this.scene.add(key);
		const fill = new THREE.DirectionalLight(0x88aaff, 0.25);
		fill.position.set(-5, 2, -4);
		this.scene.add(fill);

		this.loader      = new GLTFLoader();
		this.currentRoot = null;       // THREE.Group wrapping the current model
		this._running    = true;
		this._lastTime   = performance.now();
		// Visibility gating. Two PlanePreview instances live for the
		// entire session (compact + detail in the airframe picker).
		// Without this gate they kept ticking renderer.render() 60×/s
		// long after the picker closed and the player was flying — a
		// silent ~5% main-thread cost (top hot spot in the BVR perf
		// trace) just for two off-screen canvases. IntersectionObserver
		// flips _visible based on actual visibility; the rAF loop
		// only re-schedules itself while visible.
		this._visible = true;

		// Bound for requestAnimationFrame.
		this._animate = this._animate.bind(this);
		this._io = new IntersectionObserver((entries) => {
			for (const e of entries) {
				if (e.target === canvas) {
					const wasVisible = this._visible;
					this._visible = e.isIntersecting;
					// Resume the loop on re-show (kicks off a single
					// rAF; subsequent ones self-schedule from _animate).
					if (!wasVisible && this._visible && this._running) {
						this._lastTime = performance.now();
						requestAnimationFrame(this._animate);
					}
				}
			}
		});
		this._io.observe(canvas);
		requestAnimationFrame(this._animate);

		// Respond to size changes (menu may re-layout on window resize).
		this._resizeObserver = new ResizeObserver(() => this.resize());
		this._resizeObserver.observe(canvas);
	}

	// Swap the displayed airframe. Disposes the previous mesh's
	// geometry / materials to keep GPU memory bounded when the user
	// clicks around between planes.
	load(planeConfig) {
		if (!planeConfig) return;
		this._disposeCurrent();

		this.loader.load(planeConfig.model, (gltf) => {
			const mesh = gltf.scene;

			mesh.rotation.set(
				(planeConfig.modelRotation && planeConfig.modelRotation.x) || 0,
				(planeConfig.modelRotation && planeConfig.modelRotation.y) || 0,
				(planeConfig.modelRotation && planeConfig.modelRotation.z) || 0,
			);

			// Apply the same hideNodes rules as the in-sim load pipeline
			// so preview faithfully represents what the player will fly.
			if (planeConfig.hideNodes && planeConfig.hideNodes.length) {
				mesh.traverse((child) => {
					if (!child.name) return;
					for (const pat of planeConfig.hideNodes) {
						const match = (pat instanceof RegExp)
							? pat.test(child.name)
							: child.name === pat;
						if (match) { child.visible = false; break; }
					}
				});
			}

			// Center on origin. Ordering matters: scale FIRST, recompute
			// bbox AFTER scale, then center on the post-scale center.
			// Doing center-then-scale leaves the origin offset by
			// (scale - 1) × rawCenter, which is why the F-35 and F-22
			// previews were visibly orbiting off-center even though the
			// F-15 looked right (its raw bbox happened to be nearly
			// symmetric around 0,0,0).
			const sizeBox = new THREE.Box3().setFromObject(mesh);
			const size    = sizeBox.getSize(new THREE.Vector3());
			const maxDim  = Math.max(size.x, size.y, size.z, 1e-3);
			mesh.scale.setScalar(CAMERA_FIT_RADIUS / maxDim);
			const centerBox = new THREE.Box3().setFromObject(mesh);
			const center = centerBox.getCenter(new THREE.Vector3());
			mesh.position.sub(center);

			// Wrap so our rotation animation touches a single group
			// instead of the imported scene node (avoids compounding
			// with mesh.rotation.y above when we spin).
			const root = new THREE.Group();
			root.add(mesh);
			this.scene.add(root);
			this.currentRoot = root;
		}, undefined, (err) => {
			console.warn('[planePreview] model load failed', err);
		});
	}

	_disposeCurrent() {
		if (!this.currentRoot) return;
		this.scene.remove(this.currentRoot);
		this.currentRoot.traverse((child) => {
			if (child.geometry) child.geometry.dispose();
			if (child.material) {
				const mats = Array.isArray(child.material) ? child.material : [child.material];
				for (const m of mats) if (m && m.dispose) m.dispose();
			}
		});
		this.currentRoot = null;
	}

	resize() {
		const w = this.canvas.clientWidth;
		const h = this.canvas.clientHeight;
		if (w <= 0 || h <= 0) return;
		this.camera.aspect = w / h;
		this.camera.updateProjectionMatrix();
		this.renderer.setSize(w, h, false);
	}

	_animate(now) {
		if (!this._running) return;
		// Skip render + don't reschedule while off-screen. The
		// IntersectionObserver re-kicks the loop when the canvas
		// becomes visible again.
		if (!this._visible) return;
		const dt = Math.min(0.1, Math.max(0, (now - this._lastTime) / 1000));
		this._lastTime = now;
		if (this.currentRoot) {
			this.currentRoot.rotation.y += ROTATION_RATE_RAD_S * dt;
		}
		this.renderer.render(this.scene, this.camera);
		requestAnimationFrame(this._animate);
	}

	dispose() {
		this._running = false;
		this._disposeCurrent();
		if (this._resizeObserver) this._resizeObserver.disconnect();
		if (this._io) this._io.disconnect();
		this.renderer.dispose();
	}
}
