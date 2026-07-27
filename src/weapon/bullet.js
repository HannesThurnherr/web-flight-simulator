import * as THREE from 'three';
import * as Cesium from 'cesium';
import { movePosition } from '../utils/math';
import { particles } from '../utils/particles';
import { soundManager } from '../utils/soundManager';
import { pushKill } from '../systems/eventLog.js';
import { mortallyWound } from '../systems/deathSequence.js';
import { applyShipDamage } from '../systems/shipDamage.js';
import { recordAdHit } from '../systems/adStats.js';

export class Bullet {
	// `launcher` (optional) is the unit that fired this round. Used for
	// friendly-fire filtering — a bullet won't damage anything on the
	// launcher's team. Player bullets get launcher = playerState so
	// they can't clip a wingman flying in front of them.
	constructor(scene, viewer, startPos, heading, pitch, speed, onKill = null, launcher = null) {
		this.scene = scene;
		this.viewer = viewer;
		this.onKill = onKill;
		this.launcher = launcher;
		this.team = (launcher && launcher.team) || 'friendly';

		this.lon = startPos.lon;
		this.lat = startPos.lat;
		this.alt = startPos.alt;
		this.heading = heading;
		this.pitch = pitch;
		this.speed = speed + 1500;

		// 5 s life × ~1500 m/s muzzle velocity ≈ 7.5 km — the requested
		// "I wanna snipe" sniper range. Real 20 mm rounds tumble past
		// ~1.5 km but this is a game; we let tracers reach out further.
		this.life = 5;
		this.active = true;

		this._scratchMatrix = new Cesium.Matrix4();
		this._scratchCartesian = new Cesium.Cartesian3();
		this._scratchThreeMatrix = new THREE.Matrix4();
		this._scratchCameraMatrix = new Cesium.Matrix4();

		this.initMesh();
	}

	initMesh() {
		const createGradientMaterial = (width, opacity, intensity) => {
			return new THREE.ShaderMaterial({
				uniforms: {
					colorStart: { value: new THREE.Color(0xff3300) },
					colorMid: { value: new THREE.Color(0xffcc00) },
					colorEnd: { value: new THREE.Color(0xffffff) },
					opacity: { value: opacity },
					intensity: { value: intensity }
				},
				vertexShader: `
					varying vec2 vUv;
					void main() {
						vUv = uv;
						gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
					}
				`,
				fragmentShader: `
					uniform vec3 colorStart;
					uniform vec3 colorMid;
					uniform vec3 colorEnd;
					uniform float opacity;
					uniform float intensity;
					varying vec2 vUv;
					void main() {
						float t = clamp(vUv.y, 0.0, 1.0);
						vec3 a = mix(colorStart, colorMid, smoothstep(0.0, 0.5, t));
						vec3 b = mix(colorMid, colorEnd, smoothstep(0.5, 1.0, t));
						vec3 col = mix(a, b, smoothstep(0.0, 1.0, t));
						float alpha = opacity * pow(t, 0.6) * intensity;
						float edge = 1.0 - smoothstep(0.0, 0.5, abs(vUv.x - 0.5) * 2.0);
						alpha *= edge;
						gl_FragColor = vec4(col, alpha);
					}
				`,
				transparent: true,
				depthWrite: false,
				blending: THREE.AdditiveBlending,
				side: THREE.DoubleSide
			});
		};

		const mainLen = 20;

		this.mesh = new THREE.Group();

		const createPlaneMesh = (width, len, opacity, intensity) => {
			const geom = new THREE.PlaneGeometry(width, len, 1, 1);
			geom.translate(0, -len / 2, 0);
			const mat = createGradientMaterial(width, opacity, intensity);
			return new THREE.Mesh(geom, mat);
		};

		for (let i = 0; i < 3; i++) {
			const p = createPlaneMesh(0.6, mainLen, 1.0, 1.0);
			p.rotateY((i * Math.PI * 2) / 3);
			this.mesh.add(p);
		}

		for (let i = 0; i < 3; i++) {
			const g = createPlaneMesh(1.6, mainLen * 1.1, 0.35, 0.65);
			g.rotateY((i * Math.PI * 2) / 3 + Math.PI / 6);
			this.mesh.add(g);
		}

		const tipGeom = new THREE.ConeGeometry(0.12, 0.8, 12);
		tipGeom.translate(0, -0.4, 0);
		const tipMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1.0, blending: THREE.AdditiveBlending, depthWrite: false });
		const tip = new THREE.Mesh(tipGeom, tipMat);
		this.mesh.add(tip);

		this.mesh.matrixAutoUpdate = false;
		this.scene.add(this.mesh);
	}

	update(dt, npcs) {
		if (!this.active) return;

		this.life -= dt;
		if (this.life <= 0) {
			this.destroy();
			return;
		}

		// Pre-move position: the hit test below sweeps the whole segment
		// flown this frame rather than sampling only the endpoint. A CIWS
		// round at 1500 m/s covers ~25 m per frame, but the hit radius
		// against a cruise missile clamps to 3 m — endpoint sampling let
		// most well-aimed rounds tunnel clean through the target between
		// two frames, which is why the inner gun layer almost never
		// scored. Mirrors Missile._segmentMissDistSq.
		const prevLon = this.lon, prevLat = this.lat, prevAlt = this.alt;

		const newPos = movePosition(this.lon, this.lat, this.alt, this.heading, this.pitch, this.speed * dt);
		this.lon = newPos.lon;
		this.lat = newPos.lat;
		this.alt = newPos.alt;

		this.updateThreeMatrix();

		if (npcs) {
			for (const npc of npcs) {
				if (!npc || npc.destroyed) continue;
				// Munition targets retire by clearing `.active` rather than
				// `.destroyed`; without this a round "kills" a missile that
				// already detonated, logging a phantom kill and a second
				// fireball. Aircraft don't define `.active`, so they're
				// unaffected.
				if (npc.active === false) continue;
				if (npc === this.launcher) continue;
				if (npc.team && this.team && npc.team === this.team) continue;
				const distSq = this._segmentMissDistSq(prevLon, prevLat, prevAlt, npc);
				// Hit radius scales with the target's physical size.
				// A 20 m radius is right for a fighter (≈19 m
				// visualSize) but 7× oversized for a cruise missile
				// (~6 m visualSize, real airframe < 1 m wide). Without
				// scaling, AAA bullets clip Storm Shadows / SDBs at
				// ranges where a real round wouldn't have come close
				// enough to fragment them.
				//   fighter   visualSize 19 → 7.6 m hit
				//   drone_isr           14 → 5.6 m
				//   cruise              6  → 2.4 m → clamped to 3
				//   bomb                4  → 1.6 m → clamped to 3
				// Clamp [3, 22] keeps the very-small targets reachable
				// without bullet-tunneling at 1500 m/s, and caps the
				// very-large targets so a B-2 isn't a 50 m vacuum
				// cleaner.
				const sig = npc.signature;
				const sz  = (sig && sig.visualSize) || 19;
				const hitR = Math.max(3, Math.min(22, sz * 0.4));
				if (distSq < hitR * hitR) {
					this.hitTarget(npc);
					return;
				}
			}
		}
		this.checkTerrainCollision();
	}

	updateThreeMatrix() {
		const viewMatrix = this.viewer.camera.viewMatrix;
		const pos = Cesium.Cartesian3.fromDegrees(this.lon, this.lat, this.alt, undefined, this._scratchCartesian);
		const enuMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(pos, undefined, this._scratchMatrix);

		const hRad = Cesium.Math.toRadians(this.heading);
		const pRad = Cesium.Math.toRadians(this.pitch);

		const localForward = new Cesium.Cartesian3(
			Math.sin(hRad) * Math.cos(pRad),
			Math.cos(hRad) * Math.cos(pRad),
			Math.sin(pRad)
		);

		const worldForward = Cesium.Matrix4.multiplyByPointAsVector(enuMatrix, localForward, new Cesium.Cartesian3());
		Cesium.Cartesian3.normalize(worldForward, worldForward);
		const enuUp = new Cesium.Cartesian3(enuMatrix[8], enuMatrix[9], enuMatrix[10]);

		let worldRight = new Cesium.Cartesian3();
		if (Math.abs(Cesium.Cartesian3.dot(worldForward, enuUp)) > 0.999) {
			const enuNorth = new Cesium.Cartesian3(enuMatrix[4], enuMatrix[5], enuMatrix[6]);
			Cesium.Cartesian3.cross(worldForward, enuNorth, worldRight);
		} else {
			Cesium.Cartesian3.cross(worldForward, enuUp, worldRight);
		}
		Cesium.Cartesian3.normalize(worldRight, worldRight);
		const worldUp = Cesium.Cartesian3.cross(worldRight, worldForward, new Cesium.Cartesian3());

		const finalModelMatrix = this._scratchMatrix;
		finalModelMatrix[0] = worldRight.x; finalModelMatrix[1] = worldRight.y; finalModelMatrix[2] = worldRight.z; finalModelMatrix[3] = 0;
		finalModelMatrix[4] = worldForward.x; finalModelMatrix[5] = worldForward.y; finalModelMatrix[6] = worldForward.z; finalModelMatrix[7] = 0;
		finalModelMatrix[8] = worldUp.x; finalModelMatrix[9] = worldUp.y; finalModelMatrix[10] = worldUp.z; finalModelMatrix[11] = 0;
		finalModelMatrix[12] = pos.x; finalModelMatrix[13] = pos.y; finalModelMatrix[14] = pos.z; finalModelMatrix[15] = 1;

		const cameraSpaceMatrix = Cesium.Matrix4.multiply(viewMatrix, finalModelMatrix, this._scratchCameraMatrix);
		for (let i = 0; i < 16; i++) {
			this._scratchThreeMatrix.elements[i] = cameraSpaceMatrix[i];
		}
		this.mesh.matrix.copy(this._scratchThreeMatrix);
		this.mesh.updateMatrixWorld(true);
	}

	calculateDistSqToNPC(npc) {
		const dLon = (npc.lon - this.lon) * 111320 * Math.cos(Cesium.Math.toRadians(this.lat));
		const dLat = (npc.lat - this.lat) * 111320;
		const dAlt = npc.alt - this.alt;
		return dLon * dLon + dLat * dLat + dAlt * dAlt;
	}

	// Closest-approach distance² between the segment flown this frame
	// (lon0,lat0,alt0 → this.lon,this.lat,this.alt) and the target's
	// position. Flat-Earth metric frame is plenty at a <40 m segment
	// length. The target is treated as fixed within the frame: it moves
	// at most ~7 m while the round moves 25, and the perpendicular miss
	// distance — the quantity actually compared against the hit radius —
	// is barely sensitive to that.
	_segmentMissDistSq(lon0, lat0, alt0, target) {
		const mPerDegLon = 111320 * Math.cos(Cesium.Math.toRadians(lat0));
		const ax = (target.lon - lon0) * mPerDegLon;
		const ay = (target.lat - lat0) * 111320;
		const az = (target.alt - alt0);
		const bx = (this.lon - lon0) * mPerDegLon;
		const by = (this.lat - lat0) * 111320;
		const bz = (this.alt - alt0);
		const segLenSq = bx * bx + by * by + bz * bz;
		if (segLenSq < 1e-6) return ax * ax + ay * ay + az * az;
		let t = (ax * bx + ay * by + az * bz) / segLenSq;
		t = Math.max(0, Math.min(1, t));
		const cx = ax - bx * t, cy = ay - by * t, cz = az - bz * t;
		return cx * cx + cy * cy + cz * cz;
	}

	hitTarget(target) {
		// AD hit-rate diagnostic (AAA rounds stamped at the muzzle).
		if (this._adStats) { try { recordAdHit(this._adStats.type, this._adStats.column); } catch (e) {} }
		// Surface ships: a gun/CIWS round does little to a warship — chip a
		// couple of HP and move on through the damage model, never a one-shot.
		if (target && target.kind === 'surface') {
			applyShipDamage(target, 2, { lon: this.lon, lat: this.lat, alt: this.alt }, 'GUN', this.launcher);
			if (target.sinking && this.onKill) this.onKill(target);
			this.destroy();
			return;
		}
		// Aircraft → burning-spiral death sequence (logs kill, hit flash,
		// tumble). The bullet is consumed either way.
		if (mortallyWound(target, { shooter: this.launcher, weapon: 'GUN', reason: 'kill' })) {
			if (this.onKill) this.onKill(target);
			this.destroy();
			return;
		}
		// No lethality roll here either: a 20 mm round that connects with a
		// missile airframe kills it. A CIWS misses because its rounds go past,
		// not because they bounce off — that's modelled as barrel dispersion in
		// the gun's fire solution (see gunLead in npcPilots.js), so most of the
		// burst physically misses and the ones that connect count.
		pushKill({
			shooter: this.launcher,
			target,
			weapon:  'GUN',
			at:      performance.now() * 0.001,
			reason:  'kill',
		});
		target.destroyed = true;
		// Projectile-type targets (cruise missiles, MALD decoys) gate
		// on `.active`, not `.destroyed` — flip both so a CIWS or gun
		// kill on a cruise actually stops the projectile.
		if ('active' in target) target.active = false;
		if (this.onKill) this.onKill(target);
		try {
			particles.spawnExplosion(this.lon, this.lat, this.alt, { count: 36, smokeCount: 8, big: true });
			particles.spawnWreckage(this.lon, this.lat, this.alt, this.heading, this.pitch, { count: 18 });
			try { soundManager.play('explosion-random'); } catch (e) { }
		} catch (e) { }
		this.destroy();
	}

	checkTerrainCollision() {
		const cartographic = Cesium.Cartographic.fromDegrees(this.lon, this.lat);
		const terrainHeight = this.viewer.scene.globe.getHeight(cartographic);
		if (terrainHeight !== undefined && this.alt < terrainHeight) {
			try { particles.spawnSpark(this.lon, this.lat, this.alt, { count: 10 }); } catch (e) { }
			this.destroy();
		}
	}

	destroy() {
		this.active = false;
		this.scene.remove(this.mesh);
	}
}
