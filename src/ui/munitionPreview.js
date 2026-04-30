// ============================================================================
// Munition preview widget.
//
// A compact 3D viewport for the loadout editor: shows the missile/bomb whose
// row the user is hovering or has currently focused in the dropdown. Same
// pattern as PlanePreview — own scene + WebGLRenderer + rAF loop, gated by
// IntersectionObserver so it doesn't burn CPU when the loadout tab is hidden.
//
// Lifecycle:
//   const p = new MunitionPreview(canvasEl);
//   p.show(munitionData);    // pulled from MUNITIONS registry
//   p.show(null);            // explicitly empty preview
//   p.dispose();
//
// Munitions don't have a `model` field — they have a `modelTemplate` string
// that maps to a GLB path inside missileModels.js. We mirror that mapping
// here (TEMPLATE_TO_PATH) rather than importing the runtime templates,
// because those are normalized + axis-flipped for in-flight use, and the
// preview wants the raw asset for its own framing pass.
// ============================================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const TEMPLATE_TO_PATH = {
	'aim9':         '/assets/models/aim-9-missile.glb',
	'aim120':       '/assets/models/aim-120-amraam.glb',
	'meteor':       '/assets/models/mbda-meteor.glb',
	'agm-88':       '/assets/models/agm-88-harm.glb',
	'gbu-12':       '/assets/models/gbu-12.glb',
	'jdam-38':      '/assets/models/gbu-38-jdam.glb',
	'jdam-31':      '/assets/models/gbu-38-jdam.glb',
	'agm-86':       '/assets/models/agm-86.glb',
	'gbu-39':       '/assets/models/gbu-39-sdb.glb',
	'storm-shadow': '/assets/models/storm-shadow.glb',
	'tamir':        '/assets/models/tamir-irondome.glb',
	'r-37m':        '/assets/models/r-37m.glb',
	'r-77':         '/assets/models/r-77.glb',
	'r-73':         '/assets/models/r-73.glb',
};

export function munitionGLBPath(m) {
	if (!m) return null;
	if (m.modelTemplate && TEMPLATE_TO_PATH[m.modelTemplate]) {
		return TEMPLATE_TO_PATH[m.modelTemplate];
	}
	// Fallback by seeker class for the AIM-9 / AIM-120 default templates.
	const s = m.seekerType;
	if (s === 'ir' || s === 'iir')   return TEMPLATE_TO_PATH.aim9;
	if (s === 'active_radar')        return TEMPLATE_TO_PATH.aim120;
	return null;
}

const ROTATION_RATE_RAD_S = 0.55;
const FIT_RADIUS = 1.6;

export class MunitionPreview {
	constructor(canvas) {
		this.canvas = canvas;

		this.scene  = new THREE.Scene();
		this.camera = new THREE.PerspectiveCamera(
			32,
			canvas.clientWidth / Math.max(1, canvas.clientHeight),
			0.05, 100,
		);
		// Side-on three-quarter view. Missiles are long thin bodies so we
		// give the camera distance proportional to length and tilt down
		// slightly so the cruciform / fin pattern reads.
		this.camera.position.set(4.0, 1.4, 4.0);
		this.camera.lookAt(0, 0, 0);

		this.renderer = new THREE.WebGLRenderer({
			canvas, antialias: true, alpha: true,
		});
		this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
		this.renderer.setPixelRatio(window.devicePixelRatio);
		this.renderer.setClearColor(0x000000, 0);

		this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
		const key = new THREE.DirectionalLight(0xffffff, 0.85);
		key.position.set(4, 6, 3);
		this.scene.add(key);
		const fill = new THREE.DirectionalLight(0x88aaff, 0.30);
		fill.position.set(-4, 2, -3);
		this.scene.add(fill);

		this.loader = new GLTFLoader();
		this.currentRoot = null;
		this._currentPath = null;       // dedup re-loads of same model
		this._running = true;
		this._lastTime = performance.now();
		this._visible = true;

		this._animate = this._animate.bind(this);
		this._io = new IntersectionObserver((entries) => {
			for (const e of entries) {
				if (e.target === canvas) {
					const wasVisible = this._visible;
					this._visible = e.isIntersecting;
					if (!wasVisible && this._visible && this._running) {
						this._lastTime = performance.now();
						requestAnimationFrame(this._animate);
					}
				}
			}
		});
		this._io.observe(canvas);
		requestAnimationFrame(this._animate);

		this._resizeObserver = new ResizeObserver(() => this.resize());
		this._resizeObserver.observe(canvas);
	}

	// `m` is a munition data object (from MUNITIONS) or null to clear.
	show(m) {
		const path = munitionGLBPath(m);
		if (path === this._currentPath) return;   // already showing this one
		this._currentPath = path;
		this._disposeCurrent();
		if (!path) return;

		this.loader.load(path, (gltf) => {
			// Race-guard: another show() may have superseded this load
			// while the GLB was in flight. Drop the result if so.
			if (this._currentPath !== path) return;
			const mesh = gltf.scene;

			// Center + scale to fit. Munitions GLBs vary wildly in scale
			// (some are 0.5 m wide, some are 50 m). We just normalize the
			// max bbox dim to FIT_RADIUS so every weapon takes up the
			// same screen real estate.
			const sizeBox = new THREE.Box3().setFromObject(mesh);
			const size = sizeBox.getSize(new THREE.Vector3());
			const maxDim = Math.max(size.x, size.y, size.z, 1e-3);
			mesh.scale.setScalar(FIT_RADIUS * 2 / maxDim);
			const centerBox = new THREE.Box3().setFromObject(mesh);
			const center = centerBox.getCenter(new THREE.Vector3());
			mesh.position.sub(center);

			// Wrap so animation rotates a single root, not the imported
			// scene node (which may already carry an orientation we want
			// to preserve as the spin axis).
			const root = new THREE.Group();
			root.add(mesh);
			this.scene.add(root);
			this.currentRoot = root;
		}, undefined, (err) => {
			console.warn('[munitionPreview] model load failed', path, err);
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
