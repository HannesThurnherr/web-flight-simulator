// ============================================================================
// Contrails — Phase 8.
//
// Per-plane condensation-trail emitter. Each contrailing engine spawns
// a long line of slowly-expanding white puffs that hangs in the world
// for tens of seconds. Same render approach as the missile trail
// (sphere mesh anchored in ECEF via eastNorthUpToFixedFrame, billboard
// transform composed with view matrix), with three differences:
//
//   - Lifetime is much longer (~45 s vs ~4 s) — real persistent
//     contrails linger for minutes; we cap at 45 s for memory budget.
//   - Color is white-ish, opacity rolls in fast then fades slowly.
//   - Spawn-by-distance interval is wider so the trail reads at
//     range without a 50 k-puff army on screen.
//
// Conditions for emission: real contrails form when engine exhaust
// water vapour cools fast enough to condense, which is essentially a
// function of altitude (cold + low pressure) modulated by humidity.
// We approximate with a single altitude threshold plus a minimum
// speed gate so taxiing on a snowy runway doesn't smoke. Tuneable
// per-airframe later if we ever model H2O exhaust mass differently
// (turbofans contrail at lower alts than turbojets in real life).
//
// Sensor coupling: while emitting, the plane's visual signature gets
// a multiplier in scanVisual — contrails are precisely the kind of
// thing that lets you spot a stealth fighter at altitude when its
// radar return wouldn't reveal it. The boolean lives on the unit as
// `unit.contrailing` and is flipped here in update().
// ============================================================================
import * as THREE from 'three';
import * as Cesium from 'cesium';
import { movePosition } from '../utils/math';

// ---- Tuneables -------------------------------------------------------------
const ALT_FORM_M       = 7000;      // contrail formation altitude (~23 000 ft)
const ALT_HYSTERESIS_M = 500;       // dropout uses ALT_FORM - HYST so the
                                    // plane doesn't flicker the trail at the
                                    // boundary
const MIN_SPEED_MPS    = 100;       // below this no condensation persists
const SPAWN_INTERVAL_M = 35;        // metres of travel per puff per engine
const PUFF_LIFE_S      = 45;        // seconds each puff lives
const PUFF_BASE_RADIUS = 1.2;       // initial sphere radius (m)
const PUFF_GROW_FACTOR = 22;        // multiplied by life-fraction to grow
const PUFF_MAX_OPACITY = 0.85;      // peak opacity (right after spawn)

// Shared scratch math objects so update() doesn't churn allocations.
const _scratchCart    = new Cesium.Cartesian3();
const _scratchMatrix  = new Cesium.Matrix4();
const _scratchCamMat  = new Cesium.Matrix4();
const _scratchThree   = new THREE.Matrix4();

export class Contrail {
	// `nozzleResolver` is a function(plane) → array of {x,y,z} world
	// offsets behind the plane's current pose where puffs should spawn.
	// We can't use the in-model jetFlame positions directly because
	// those live in plane-local coordinates and the plane is anchored
	// at the camera origin (third-person trick); we need real-world
	// trailing positions.
	//
	// Simplest workable shape: assume engines exit at the tail and
	// trail behind the plane along -heading. The visual offset
	// between engines is invisible at contrail scale (a few metres
	// either side of centerline disappears against a 45 s puff column).
	// So we just spawn one puff per emit-tick from a single point
	// roughly at the plane's tail. Per-engine offsetting can be added
	// later if it ever reads.
	constructor(scene, viewer) {
		this.scene  = scene;
		this.viewer = viewer;
		this.puffs  = [];
		this.distanceSinceLastSpawn = 0;
		this._wasEmitting = false;
	}

	// `plane` must carry { lon, lat, alt, heading, pitch, speed,
	// destroyed?, active? }. Used for both the player state and NPCs
	// — both shapes match.
	update(dt, plane) {
		if (!plane || plane.destroyed || plane.active === false) {
			plane && (plane.contrailing = false);
			this._ageExisting(dt);
			return;
		}

		// Hysteresis: once contrailing, you keep contrailing until you
		// drop noticeably below the formation altitude (otherwise the
		// trail strobes at the boundary while bouncing on the alt
		// ceiling). Going from off → on uses the strict threshold.
		const altThreshold = this._wasEmitting
			? ALT_FORM_M - ALT_HYSTERESIS_M
			: ALT_FORM_M;
		const emitting = (plane.alt >= altThreshold) && (plane.speed >= MIN_SPEED_MPS);
		this._wasEmitting = emitting;
		plane.contrailing = emitting;

		if (emitting) {
			this.distanceSinceLastSpawn += plane.speed * dt;
			while (this.distanceSinceLastSpawn >= SPAWN_INTERVAL_M) {
				const back = this.distanceSinceLastSpawn - SPAWN_INTERVAL_M;
				// Spawn just behind the plane along its heading vector
				// at the time of the missed-distance tick. Using the
				// missile.updateTrail trick of negative-distance
				// movePosition gives us a stable trail even when the
				// plane is turning / climbing during the spawn frame.
				const pos = movePosition(plane.lon, plane.lat, plane.alt,
					plane.heading, plane.pitch, -back);
				this._spawnPuff(pos.lon, pos.lat, pos.alt);
				this.distanceSinceLastSpawn -= SPAWN_INTERVAL_M;
			}
		}

		this._ageExisting(dt);
	}

	_spawnPuff(lon, lat, alt) {
		// SphereGeometry once + reuse via `geometry` swap would save
		// memory but we only spawn at the spawn-interval cadence so
		// the per-puff allocation is bounded. Reuse can come later
		// if profiling shows it matters.
		const geom = new THREE.SphereGeometry(PUFF_BASE_RADIUS, 12, 8);
		const mat  = new THREE.MeshBasicMaterial({
			color:       0xf0f5ff,        // very slightly blue-white
			transparent: true,
			opacity:     PUFF_MAX_OPACITY,
			depthWrite:  false,           // additive-friendly fade
		});
		const puff = new THREE.Mesh(geom, mat);
		puff.lon  = lon;
		puff.lat  = lat;
		puff.alt  = alt;
		puff.life = PUFF_LIFE_S;
		// Per-puff random scale shimmer so the trail isn't a uniform
		// sausage. Same trick missile trails use.
		puff.randomScale = 0.85 + Math.random() * 0.4;
		puff.matrixAutoUpdate = false;
		this.scene.add(puff);
		this.puffs.push(puff);
	}

	_ageExisting(dt) {
		const viewMatrix = this.viewer.camera.viewMatrix;
		for (let i = this.puffs.length - 1; i >= 0; i--) {
			const t = this.puffs[i];
			t.life -= dt;
			if (t.life <= 0) {
				this.scene.remove(t);
				if (t.geometry) t.geometry.dispose();
				if (t.material) t.material.dispose();
				this.puffs.splice(i, 1);
				continue;
			}
			const lifeFrac = t.life / PUFF_LIFE_S;        // 1 → 0
			const ageFrac  = 1 - lifeFrac;                 // 0 → 1
			// Grow over life. Real contrails diffuse from ~5 m to
			// 30+ m diameter over their lifetime; we model with a
			// linear ramp scaled by PUFF_GROW_FACTOR.
			const scale = t.randomScale * (1.0 + ageFrac * PUFF_GROW_FACTOR);
			// Two-stage opacity: ramp up fast for the first 10 % of
			// life (so a fresh puff is visible immediately), hold
			// near peak, then long linear fade. Avoids the "appears
			// transparent" frame that pure linear-fade creates at
			// spawn.
			let opacity;
			if (ageFrac < 0.1) {
				opacity = PUFF_MAX_OPACITY * (ageFrac / 0.1);
			} else {
				opacity = PUFF_MAX_OPACITY * (1.0 - (ageFrac - 0.1) / 0.9);
			}
			t.material.opacity = opacity;

			const pos = Cesium.Cartesian3.fromDegrees(t.lon, t.lat, t.alt, undefined, _scratchCart);
			const enuMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(pos, undefined, _scratchMatrix);
			const camSpace  = Cesium.Matrix4.multiply(viewMatrix, enuMatrix, _scratchCamMat);
			for (let j = 0; j < 16; j++) _scratchThree.elements[j] = camSpace[j];
			t.matrix.copy(_scratchThree);
			t.matrix.scale(new THREE.Vector3(scale, scale, scale));
			t.updateMatrixWorld(true);
		}
	}

	dispose() {
		for (const t of this.puffs) {
			this.scene.remove(t);
			if (t.geometry) t.geometry.dispose();
			if (t.material) t.material.dispose();
		}
		this.puffs.length = 0;
	}
}
