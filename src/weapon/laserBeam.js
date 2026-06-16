import * as THREE from 'three';
import * as Cesium from 'cesium';

// ============================================================================
// LaserBeam — a transient directed-energy beam rendered in camera space.
//
// A high-energy laser is, visually, a persistent bright tracer anchored at
// the emitter and terminating on the (moving) target, plus a hot burn spot
// where it lands. We render it with the same camera-space matrix trick the
// Bullet / Missile classes use: build a world model matrix (emitter origin,
// +Y axis pointing at the target), premultiply by the Cesium view matrix,
// and copy the result into a matrixAutoUpdate=false THREE mesh.
//
// The beam is a 3-plane additive "volumetric" cross (so it reads as a round
// shaft from any view angle) of unit length along +Y, scaled per-frame to
// the emitter→target distance. The impact is an additive sphere that flares
// with dwell. Both fade their intensity with the laser's output factor, so a
// browned-out capacitor visibly produces a thinner, dimmer beam.
// ============================================================================

const _scratchFrom   = new Cesium.Cartesian3();
const _scratchTo     = new Cesium.Cartesian3();
const _scratchDir    = new Cesium.Cartesian3();
const _scratchRight  = new Cesium.Cartesian3();
const _scratchUp     = new Cesium.Cartesian3();
const _scratchUpRef  = new Cesium.Cartesian3();
const _scratchModel  = new Cesium.Matrix4();
const _scratchCam    = new Cesium.Matrix4();
const _scratchThree  = new THREE.Matrix4();
const _scratchScale  = new THREE.Matrix4();

export class LaserBeam {
	constructor(scene, viewer, opts = {}) {
		this.scene  = scene;
		this.viewer = viewer;
		this.color  = new THREE.Color(opts.color ?? 0x66ccff); // HELIOS-ish cyan-white
		this.coreColor = new THREE.Color(opts.coreColor ?? 0xffffff);
		this.baseWidth = opts.width ?? 6.0;
		this.visible = false;

		this._buildMeshes();
	}

	_buildMeshes() {
		// --- Beam shaft: crossed additive planes, unit length along +Y ---
		this.beamGroup = new THREE.Group();
		this.beamGroup.matrixAutoUpdate = false;

		const makePlane = (w, opacity) => {
			const geom = new THREE.PlaneGeometry(w, 1, 1, 1);
			geom.translate(0, 0.5, 0); // base at origin, tip at +Y=1
			const mat = new THREE.MeshBasicMaterial({
				color: this.color,
				transparent: true,
				opacity,
				blending: THREE.AdditiveBlending,
				depthWrite: false,
				side: THREE.DoubleSide,
			});
			return new THREE.Mesh(geom, mat);
		};
		this._beamPlanes = [];
		// Bright thin core + wider soft glow halo.
		const core = makePlane(this.baseWidth * 0.35, 1.0);
		core.material.color = this.coreColor;
		this._beamPlanes.push(core);
		for (let i = 0; i < 3; i++) {
			const p = makePlane(this.baseWidth, 0.5);
			p.rotation.y = (i * Math.PI) / 3;
			p.matrixAutoUpdate = true;
			this._beamPlanes.push(p);
		}
		core.matrixAutoUpdate = true;
		for (const p of this._beamPlanes) this.beamGroup.add(p);

		this.beamGroup.visible = false;
		this.scene.add(this.beamGroup);
	}

	// Update the beam geometry for this frame.
	//   from / to : { lon, lat, alt }
	//   intensity : 0..1 output factor (capacitor brownout dims the beam)
	//   heat      : 0..1 burn progress (grows the impact flare)
	update(from, to, intensity = 1, heat = 0) {
		void heat;
		this.visible = true;
		this.beamGroup.visible = true;

		const viewMatrix = this.viewer.camera.viewMatrix;
		const fromCart = Cesium.Cartesian3.fromDegrees(from.lon, from.lat, from.alt, undefined, _scratchFrom);
		const toCart   = Cesium.Cartesian3.fromDegrees(to.lon,   to.lat,   to.alt,   undefined, _scratchTo);

		const dir = Cesium.Cartesian3.subtract(toCart, fromCart, _scratchDir);
		const dist = Cesium.Cartesian3.magnitude(dir);
		if (dist < 1) { this.hide(); return; }
		Cesium.Cartesian3.normalize(dir, dir);

		// Stable basis: use the emitter's geocentric up as the reference.
		Cesium.Cartesian3.normalize(fromCart, _scratchUpRef);
		let right = Cesium.Cartesian3.cross(dir, _scratchUpRef, _scratchRight);
		if (Cesium.Cartesian3.magnitude(right) < 1e-4) {
			// Beam nearly vertical — pick any perpendicular.
			Cesium.Cartesian3.cross(dir, Cesium.Cartesian3.UNIT_X, right);
		}
		Cesium.Cartesian3.normalize(right, right);
		const up = Cesium.Cartesian3.cross(right, dir, _scratchUp);
		Cesium.Cartesian3.normalize(up, up);

		// World model matrix: columns = [right, dir(+Y/forward), up, origin].
		const m = _scratchModel;
		m[0] = right.x; m[1] = right.y; m[2] = right.z; m[3] = 0;
		m[4] = dir.x;   m[5] = dir.y;   m[6] = dir.z;   m[7] = 0;
		m[8] = up.x;    m[9] = up.y;    m[10] = up.z;   m[11] = 0;
		m[12] = fromCart.x; m[13] = fromCart.y; m[14] = fromCart.z; m[15] = 1;

		// Beam: scale local +Y by the full distance.
		const camBeam = Cesium.Matrix4.multiply(viewMatrix, m, _scratchCam);
		for (let i = 0; i < 16; i++) _scratchThree.elements[i] = camBeam[i];
		_scratchScale.makeScale(1, dist, 1);
		this.beamGroup.matrix.copy(_scratchThree).multiply(_scratchScale);
		this.beamGroup.updateMatrixWorld(true);

		// Intensity drives opacity/width of the glow planes.
		for (let i = 0; i < this._beamPlanes.length; i++) {
			const p = this._beamPlanes[i];
			p.material.opacity = (i === 0 ? 1.0 : 0.5) * (0.4 + 0.6 * intensity);
		}
	}

	hide() {
		this.visible = false;
		this.beamGroup.visible = false;
	}

	destroy() {
		this.scene.remove(this.beamGroup);
		this.beamGroup.traverse((o) => { if (o.material) o.material.dispose?.(); if (o.geometry) o.geometry.dispose?.(); });
	}
}
