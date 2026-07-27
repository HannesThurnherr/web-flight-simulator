import * as THREE from 'three';
import * as Cesium from 'cesium';

const particles = {
	scene: null,
	viewer: null,
	list: [],
	// Hard cap on live particle meshes. Each particle is its own THREE.Mesh
	// (a draw call); without a ceiling, many impacts in quick succession
	// (a B-2 SDB stick, a SAM-vs-cruise furball) spawn tens of thousands of
	// meshes in a couple of seconds, exhausting the GPU and dropping the
	// WebGL context — which is what turned the whole globe grey. Oldest
	// particles are evicted first.
	maxParticles: 1400,

	// Per-FRAME spawn budget, on top of the global cap above. A Harpoon salvo
	// killed by point defence fires a dozen spawnExplosion calls in a single
	// frame; at full count each one contributes its whole cloud, so the result
	// is a dozen explosions' worth of near-black smoke stacked in one place —
	// far denser than any single blast, and dense enough to curtain the view.
	// It also blows straight through the global cap, which then evicts the
	// oldest particles mid-animation and makes earlier blasts pop out.
	//
	// So: the first explosion in a frame is untouched, and simultaneous ones
	// share a budget. A mass detonation reads as one big explosion instead of
	// N overlapping ones, which is what it should look like anyway.
	_frameSpawns: 0,
	_burstFull: 220,
	_burstScale() {
		const spent = this._frameSpawns;
		if (spent <= this._burstFull) return 1;
		return Math.max(0.15, this._burstFull / spent);
	},

	_scratchMatrix: new Cesium.Matrix4(),
	_scratchCameraMatrix: new Cesium.Matrix4(),
	_scratchThreeMatrix: new THREE.Matrix4(),
	_scratchCart: new Cesium.Cartesian3(),

	// Bake a particle's camera-space render matrix.
	//
	// THIS MUST RUN BEFORE A PARTICLE IS FIRST RENDERED. These meshes are
	// matrixAutoUpdate = false, so their matrix starts as IDENTITY — and in
	// this renderer's camera-space convention (matrices baked as
	// viewMatrix × modelMatrix against an identity THREE camera) identity
	// means "exactly at the eye", not "at the origin of the world".
	//
	// That is the screen blackout. A wreckage chunk is MeshPhong at
	// colour 0.0-0.06 (near black), side: DoubleSide, and metres across —
	// one sitting unbaked on the eyeball fills the entire view regardless of
	// where the camera is or which way it looks. Every other particle is a
	// FrontSide sphere, invisible from the inside, which is exactly why they
	// never showed the bug and wreckage always did.
	//
	// The window was real and repeating, not a one-frame race:
	// updateGroundWrecks() spawns fire/smoke and runs AFTER particles.update()
	// in animateLoop, so everything it spawned was drawn unbaked EVERY frame.
	// Baking at spawn closes it for every caller and any future call ordering.
	_bake(p) {
		const viewer = this.viewer;
		if (!viewer || !viewer.camera || !viewer.camera.viewMatrix) return false;
		const pos = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.alt, undefined, this._scratchCart);
		const modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(pos, undefined, this._scratchMatrix);
		const cam = Cesium.Matrix4.multiply(viewer.camera.viewMatrix, modelMatrix, this._scratchCameraMatrix);
		for (let j = 0; j < 16; j++) this._scratchThreeMatrix.elements[j] = cam[j];
		p.matrix.copy(this._scratchThreeMatrix);
		if (p._rotEuler) {
			const q = new THREE.Quaternion().setFromEuler(p._rotEuler);
			const s = p.scale ? p.scale.clone() : new THREE.Vector3(1, 1, 1);
			p.matrix.multiply(new THREE.Matrix4().compose(new THREE.Vector3(0, 0, 0), q, s));
		} else if (p.scale && (p.scale.x !== 1 || p.scale.y !== 1 || p.scale.z !== 1)) {
			p.matrix.scale(p.scale);
		}
		p.updateMatrixWorld(true);
		return cam;
	},

	// The ONLY way a particle should enter the scene: positioned first, added
	// second. If the viewer isn't up yet we can't position it, so it stays
	// invisible until update() bakes it rather than being drawn at the eye.
	_addParticle(m) {
		m.matrixAutoUpdate = false;
		m.visible = !!this._bake(m);
		this.scene.add(m);
		this.list.push(m);
	},

	init(scene, viewer) {
		this.scene = scene;
		this.viewer = viewer;
	},

	// Evict oldest particles down to the cap. Called after the big impact
	// spawners and once per frame, so a single-frame burst can't blow past
	// the ceiling.
	_enforceCap() {
		const over = this.list.length - this.maxParticles;
		if (over <= 0) return;
		const removed = this.list.splice(0, over);
		for (const m of removed) {
			if (this.scene) this.scene.remove(m);
			if (m.geometry && m.geometry.dispose) m.geometry.dispose();
			if (m.material && m.material.dispose) m.material.dispose();
		}
	},

	spawnExplosion(lon, lat, alt, opts = {}) {
		const isBig = !!opts.big;
		const burst = this._burstScale();
		const fireCount = Math.max(4, Math.round((opts.count || (isBig ? 64 : 36)) * burst));

		const flashSize = isBig ? 6.0 : 3.0;
		const flashGeom = new THREE.SphereGeometry(flashSize, 12, 10);
		const flashMat = new THREE.MeshBasicMaterial({ color: 0xffffff, blending: THREE.AdditiveBlending, transparent: true, opacity: 1.0 });
		const flash = new THREE.Mesh(flashGeom, flashMat);
		flash.life = 0.18 + Math.random() * 0.12;
		flash.maxLife = flash.life;
		flash.lon = lon; flash.lat = lat; flash.alt = alt;
		flash.isSmoke = false;
		flash._expand = true; flash._expandAmount = isBig ? 5.0 : 3.0;
		this._addParticle(flash);

		for (let i = 0; i < fireCount; i++) {
			const size = (isBig ? 0.6 : 0.35) + Math.random() * (isBig ? 2.4 : 0.9);
			const geom = new THREE.SphereGeometry(size, 8, 6);
			const color = new THREE.Color().setHSL(0.08 - Math.random() * 0.05, 1.0, 0.5 + Math.random() * 0.2);
			const mat = new THREE.MeshBasicMaterial({ color: color, blending: THREE.AdditiveBlending, transparent: true, opacity: 1.0 });
			const m = new THREE.Mesh(geom, mat);
			m.life = (isBig ? 0.9 : 0.6) + Math.random() * (isBig ? 1.4 : 0.8);
			m.maxLife = m.life;
			m.lon = lon; m.lat = lat; m.alt = alt;
			const h = Math.random() * Math.PI * 2;
			const p = (Math.random() * 120 - 60) * (Math.PI / 180);
			const speed = (isBig ? 18 : 10) + Math.random() * (isBig ? 60 : 36);
			m._localVel = {
				east: Math.sin(h) * Math.cos(p) * speed,
				north: Math.cos(h) * Math.cos(p) * speed,
				up: Math.sin(p) * speed
			};
			m.isSmoke = false;
			m._expand = true; m._expandAmount = isBig ? 2.8 : 1.8;
			this._addParticle(m);
		}

		const sparkCount = Math.max(3, Math.round((isBig ? 32 : 18) * burst));
		for (let i = 0; i < sparkCount; i++) {
			const geom = new THREE.SphereGeometry(0.06 + Math.random() * 0.14, 6, 6);
			const mat = new THREE.MeshBasicMaterial({ color: 0xffffcc, blending: THREE.AdditiveBlending, transparent: true });
			const m = new THREE.Mesh(geom, mat);
			m.life = 0.18 + Math.random() * 0.36;
			m.maxLife = m.life;
			m.lon = lon; m.lat = lat; m.alt = alt;
			const h = Math.random() * Math.PI * 2;
			const p = (Math.random() * 120 - 60) * (Math.PI / 180);
			const speed = (isBig ? 36 : 18) + Math.random() * (isBig ? 120 : 60);
			m._localVel = {
				east: Math.sin(h) * Math.cos(p) * speed,
				north: Math.cos(h) * Math.cos(p) * speed,
				up: Math.sin(p) * speed
			};
			m.isSmoke = false;
			m._expand = true; m._expandAmount = 0.6;
			this._addParticle(m);
		}

		const smokeCount = Math.max(1, Math.round(
			(typeof opts.smokeCount !== 'undefined' ? opts.smokeCount : (isBig ? 8 : 5)) * burst));
		this._frameSpawns += 1 + fireCount + sparkCount + smokeCount;
		for (let i = 0; i < smokeCount; i++) {
			const size = (isBig ? 3.0 : 1.8) + Math.random() * (isBig ? 4.0 : 1.6);
			const geom = new THREE.SphereGeometry(size, 12, 10);
			const gray = 0.08 + Math.random() * 0.3;
			const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(gray, gray, gray), transparent: true, opacity: 0.75 });
			const m = new THREE.Mesh(geom, mat);
			m.life = (isBig ? 1.0 : 0.6) + Math.random() * (isBig ? 1.2 : 0.6);
			m.maxLife = m.life;
			m.lon = lon + (Math.random() - 0.5) * 0.00018;
			m.lat = lat + (Math.random() - 0.5) * 0.00018;
			m.alt = alt - 0.6 + (Math.random() - 0.5) * 0.8;
			m._localVel = {
				east: (Math.random() - 0.5) * 2.2,
				north: (Math.random() - 0.5) * 2.2,
				up: 0.6 + Math.random() * 2.6
			};
			m.isSmoke = true;
			this._addParticle(m);
		}

		this._enforceCap();
		try { if (this.viewer) this.viewer.scene && this.viewer.scene.requestRender(); } catch (e) { }
	},

	spawnWreckage(lon, lat, alt, heading = 0, pitch = 0, opts = {}) {
		const count = opts.count || 30;
		const hRad = Cesium.Math.toRadians(heading);
		const pRad = Cesium.Math.toRadians(pitch);
		const forward = {
			east: Math.sin(hRad) * Math.cos(pRad),
			north: Math.cos(hRad) * Math.cos(pRad),
			up: Math.sin(pRad)
		};
		for (let i = 0; i < count; i++) {
			const shapeType = Math.random();
			let geom;
			const size = 0.4 + Math.random() * 2.4;
			if (shapeType < 0.6) {
				const points = [];
				const numPoints = 3 + Math.floor(Math.random() * 3);
				const radius = size;
				for (let k = 0; k < numPoints; k++) {
					const ang = (k / numPoints) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
					const r = radius * (0.35 + Math.random() * 1.1);
					points.push(new THREE.Vector2(Math.cos(ang) * r, Math.sin(ang) * r));
				}
				const shape = new THREE.Shape(points);
				const depth = Math.max(0.03, size * 0.12);
				const extrudeSettings = { depth: depth, bevelEnabled: false };
				geom = new THREE.ExtrudeGeometry(shape, extrudeSettings);
				geom.translate(0, 0, -depth * 0.5);
			} else {
				geom = new THREE.ConeGeometry(size * 0.6, size, 3);
				geom.rotateX(Math.PI / 2);
			}
			const gray = 0.0 + Math.random() * 0.06;
			const mat = new THREE.MeshPhongMaterial({ color: new THREE.Color(gray, gray, gray), flatShading: true, side: THREE.DoubleSide });
			const m = new THREE.Mesh(geom, mat);
			m.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
			m.scale.set(1.0 + Math.random() * 1.5, 1.0 + Math.random() * 1.5, 1.0 + Math.random() * 1.5);
			m._rotEuler = new THREE.Euler(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
			m._rotVel = new THREE.Vector3((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6);
			m.life = 4.0 + Math.random() * 8.0;
			m.maxLife = m.life;
			m.lon = lon + (Math.random() - 0.5) * 0.0001;
			m.lat = lat + (Math.random() - 0.5) * 0.0001;
			m.alt = alt + (Math.random() - 0.5) * 1.0;

			const spread = 1.2;
			const speed = 10 + Math.random() * 60;
			m._localVel = {
				east: (forward.east + (Math.random() - 0.5) * spread) * speed,
				north: (forward.north + (Math.random() - 0.5) * spread) * speed,
				up: (forward.up + (Math.random() - 0.5) * spread * 0.8) * speed
			};
			m._localVel.up -= (4 + Math.random() * 6);
			m._fallGravityMultiplier = opts.fallMultiplier || 2.2;
			m.isSmoke = false;
			this._addParticle(m);
		}
		this._enforceCap();
	},

	spawnSpark(lon, lat, alt, opts = {}) {
		const count = opts.count || 12;
		for (let i = 0; i < count; i++) {
			const geom = new THREE.SphereGeometry(0.08 + Math.random() * 0.12, 6, 6);
			const mat = new THREE.MeshBasicMaterial({ color: 0xffffaa, transparent: true });
			const m = new THREE.Mesh(geom, mat);
			m.life = 0.18 + Math.random() * 0.36;
			m.maxLife = m.life;
			m.lon = lon;
			m.lat = lat;
			m.alt = alt;
			const h = Math.random() * Math.PI * 2;
			const p = (Math.random() * 120 - 60) * (Math.PI / 180);
			const speed = 18 + Math.random() * 40;
			m._localVel = {
				east: Math.sin(h) * Math.cos(p) * speed,
				north: Math.cos(h) * Math.cos(p) * speed,
				up: Math.sin(p) * speed
			};
			m.isSmoke = false;
			this._addParticle(m);
		}
	},

	// Continuous fire — additive orange/yellow flame blobs, short-lived so
	// they cluster into a burning mass on/behind a stricken aircraft.
	spawnFire(lon, lat, alt, opts = {}) {
		const count = opts.count || 3;
		for (let i = 0; i < count; i++) {
			const size = (opts.size || 0.7) + Math.random() * 1.3;
			const geom = new THREE.SphereGeometry(size, 8, 6);
			// Hue 0.0–0.10 = red→orange→yellow; hot and saturated.
			const color = new THREE.Color().setHSL(0.02 + Math.random() * 0.08, 1.0, 0.5 + Math.random() * 0.18);
			const mat = new THREE.MeshBasicMaterial({
				color, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.95, depthWrite: false,
			});
			const m = new THREE.Mesh(geom, mat);
			m.life = 0.3 + Math.random() * 0.5;
			m.maxLife = m.life;
			m.lon = lon + (Math.random() - 0.5) * 0.00010;
			m.lat = lat + (Math.random() - 0.5) * 0.00010;
			m.alt = alt + (Math.random() - 0.5) * 1.0;
			m._localVel = {
				east: (Math.random() - 0.5) * 2.5,
				north: (Math.random() - 0.5) * 2.5,
				up: 0.5 + Math.random() * 1.5,
			};
			m.isSmoke = false;
			m._expand = true; m._expandAmount = 1.4;
			this._addParticle(m);
		}
	},

	// Continuous smoke puffs — used by the burning-aircraft death trail.
	// `dark` makes oily black smoke (shot-down jet); otherwise light gray.
	spawnSmoke(lon, lat, alt, opts = {}) {
		// Dark smoke is the densest thing on screen, so it shares the frame
		// budget too — a salvo going up together also fires a burst of these.
		const count = Math.max(1, Math.round((opts.count || 2) * this._burstScale()));
		this._frameSpawns += count;
		const dark = opts.dark;
		for (let i = 0; i < count; i++) {
			const size = (opts.size || 1.4) + Math.random() * 1.6;
			const geom = new THREE.SphereGeometry(size, 10, 8);
			const g = dark ? (0.03 + Math.random() * 0.07) : (0.18 + Math.random() * 0.3);
			const mat = new THREE.MeshBasicMaterial({
				color: new THREE.Color(g, g, g), transparent: true, opacity: 0.78,
			});
			const m = new THREE.Mesh(geom, mat);
			m.life = (opts.life || 2.0) + Math.random() * 1.6;
			m.maxLife = m.life;
			m.lon = lon + (Math.random() - 0.5) * 0.00012;
			m.lat = lat + (Math.random() - 0.5) * 0.00012;
			m.alt = alt + (Math.random() - 0.5) * 1.2;
			m._localVel = {
				east: (Math.random() - 0.5) * 2.0,
				north: (Math.random() - 0.5) * 2.0,
				up: 0.4 + Math.random() * 1.8,
			};
			m.isSmoke = true;
			this._addParticle(m);
		}
		try { if (this.viewer) this.viewer.scene && this.viewer.scene.requestRender(); } catch (e) { /* no-op */ }
	},

	update(dt) {
		if (!this.viewer) return;
		this._frameSpawns = 0;          // new frame → fresh burst budget
		this._enforceCap();
		for (let i = this.list.length - 1; i >= 0; i--) {
			const p = this.list[i];
			p.life -= dt * (p.isSmoke ? 1.1 : 1.0);
			if (p.life <= 0) {
				this.scene.remove(p);
				this.list.splice(i, 1);
				continue;
			}

			const fallMult = p.isSmoke ? 0.2 : (p._fallGravityMultiplier || 1.0);
			p._localVel.up -= 9.81 * dt * fallMult;

			if (p._rotEuler && p._rotVel) {
				p._rotEuler.x += p._rotVel.x * dt;
				p._rotEuler.y += p._rotVel.y * dt;
				p._rotEuler.z += p._rotVel.z * dt;
			}

			const latRad = Cesium.Math.toRadians(p.lat);
			const dLon = (p._localVel.east * dt) / (111320 * Math.cos(latRad));
			const dLat = (p._localVel.north * dt) / 111320;
			const dAlt = p._localVel.up * dt;

			p.lon += dLon;
			p.lat += dLat;
			p.alt += dAlt;

			const t = p.life / p.maxLife;
			if (p.material && p.material.opacity !== undefined) {
				if (p.isSmoke) {
					p.material.opacity = Math.max(0, t * 0.85);
				} else p.material.opacity = Math.max(0, t);
			}
			if (p._expand) {
				const grow = 1.0 + (1.0 - t) * (p._expandAmount || 1.0);
				if (!p.scale) p.scale = new THREE.Vector3(1, 1, 1);
				p.scale.set(grow, grow, grow);
			}
			if (p.isSmoke) {
				const grow = 1.0 + (1.0 - t) * 2.0;
				p.scale.set(grow, grow, grow);
			}

			// Position it (same bake the spawner already ran, see _bake).
			const cameraSpaceMatrix = this._bake(p);
			if (!cameraSpaceMatrix) continue;
			p.visible = true;                 // spawned before the viewer was up

			// ---- Camera-proximity fade ---------------------------------------
			// NOT the blackout fix — that's _bake() running at spawn time. This
			// is a separate, milder artefact: flying through your own explosion
			// puts a 3-7 m smoke puff a couple of metres from the eye, and one
			// that close covers most of the screen. Fading a particle out as the
			// camera reaches its own radius (the standard soft-particle trick)
			// keeps the cloud reading correctly from any normal distance while
			// stopping it curtaining the view at point-blank.
			//
			// Cesium.Matrix4 is column-major, so 12/13/14 is the camera-space
			// translation — the particle's position relative to the eye, free.
			if (p.material && p.material.opacity !== undefined) {
				if (p._radiusBase === undefined) {
					let r = 1;
					if (p.geometry) {
						if (!p.geometry.boundingSphere) p.geometry.computeBoundingSphere();
						if (p.geometry.boundingSphere) r = p.geometry.boundingSphere.radius || 1;
					}
					p._radiusBase = r;
				}
				const scl = p.scale ? Math.max(p.scale.x, p.scale.y, p.scale.z) : 1;
				const radius = p._radiusBase * scl;
				const camDist = Math.hypot(cameraSpaceMatrix[12], cameraSpaceMatrix[13], cameraSpaceMatrix[14]);
				const gone = radius * 0.75;              // fully transparent inside this
				const full = radius * 2.5 + 2;           // untouched beyond this
				if (camDist < full) {
					const k = (camDist - gone) / Math.max(0.001, full - gone);
					p.material.opacity *= Math.max(0, Math.min(1, k));
				}
			}
		}
	}
};

export { particles };
