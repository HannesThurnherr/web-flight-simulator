import * as THREE from 'three';
import * as Cesium from 'cesium';
import { Missile } from '../weapon/missile';
import { AIM120 } from '../weapon/aim120';
import { Bullet } from '../weapon/bullet';
import { Flare } from '../weapon/flare';
import { soundManager } from '../utils/soundManager';
import { movePosition } from '../utils/math';

export class WeaponSystem {
	constructor(viewer, scene, playerModel) {
		this.viewer = viewer;
		this.scene = scene;
		this.playerModel = playerModel;

		this.weapons = [
			{ id: 'gun',     name: 'M61A1 CANNON',    ammo: Infinity, maxAmmo: Infinity, fireRate: 0.05, lastFire: 0 },
			// AIM-9X: short-range IIR, ±10° cone. Modern imaging-IR seekers
			// acquire and lock in well under a second — 0.5 s models the
			// brief seeker slew + cooling-gate confirmation without the
			// old arcade-style 2 s stare.
			{ id: 'missile', name: 'AIM-9X SIDEWINDER', ammo: 6,  maxAmmo: 6,  fireRate: 1.0,
			  lastFire: 0, type: 'AIM-9',    lockRange: 15000, lockCone: 0.985, lockTime: 0.5 },
			// AIM-120D: active-radar BVR. Modern AESA fighter radars
			// (APG-63V3, APG-77, APG-81, APG-82) hold firing-grade
			// tracks essentially continuously in TWS; transitioning to
			// STT for launch is near-instant. 0.3 s dwell is enough for
			// the RWR-tone transition without pretending the player is
			// still flying a 1970s mechanical-scan set. Range bumped to
			// 120 km so the firing envelope matches the radar's actual
			// tracking range, not an arbitrarily tighter number.
			{ id: 'missile', name: 'AIM-120D AMRAAM',  ammo: 4,  maxAmmo: 4,  fireRate: 1.5,
			  lastFire: 0, type: 'AIM-120',  lockRange: 120000, lockCone: 0.92,  lockTime: 0.3 },
		];

		this.flareWeapon = { id: 'flare', name: 'MJU-7A', ammo: 30, maxAmmo: 30, fireRate: 0.2, lastFire: 0 };

		this.selectedWeaponIndex = 0;
		this.projectiles = [];
		this.flares = [];
		this.onKill = null;

		this.target = null;
		this.isGunOverheated = false;
		this.gunHeat = 0;

		this.lockTime = 0;
		this.lockRequiredTime = 2.0; // overridden per-weapon when locking
		this.lockStatus = 'NONE';
		this.lockingTarget = null;

		this.flareQueue = 0;
		this.flareInterval = 0.15;
		this.lastFlarePulse = 0;

		this.lastMissileSide = false;

		this.emptyWarningTimers = {
			gun: 0,
			missile: 0,
			flare: 0
		};
		this.lastEmptyWarningSoundTime = 0;
	}

	resetAmmo() {
		this.selectedWeaponIndex = 0;
		for (const w of this.weapons) {
			if (typeof w.maxAmmo !== 'undefined') w.ammo = w.maxAmmo;
		}
		if (this.flareWeapon && typeof this.flareWeapon.maxAmmo !== 'undefined') {
			this.flareWeapon.ammo = this.flareWeapon.maxAmmo;
		}
		this.gunHeat = 0;
		this.isGunOverheated = false;

		this.emptyWarningTimers = {
			gun: 0,
			missile: 0,
			flare: 0
		};
	}

	getCurrentWeapon() {
		return this.weapons[this.selectedWeaponIndex];
	}

	toggleWeapon() {
		this.selectedWeaponIndex = (this.selectedWeaponIndex + 1) % this.weapons.length;
		try { soundManager.play('weapon-switch'); } catch (e) { }
	}

	selectWeapon(index) {
		if (index >= 0 && index < this.weapons.length) {
			this.selectedWeaponIndex = index;
		}
		try { soundManager.play('weapon-switch'); } catch (e) { }
	}

	calculateWeaponPos(offset) {
		if (!this.playerModel || !this.viewer) return null;

		const scale = this.playerModel.scale.x;
		const scaledOffset = offset.clone().multiplyScalar(scale);

		scaledOffset.applyQuaternion(this.playerModel.quaternion);
		scaledOffset.add(this.playerModel.position);

		const planeFov = 75;
		const worldFov = Cesium.Math.toDegrees(this.viewer.camera.frustum.fovy);

		const factor = Math.tan(Cesium.Math.toRadians(worldFov) * 0.5) / Math.tan(Cesium.Math.toRadians(planeFov) * 0.5);

		scaledOffset.x *= factor;
		scaledOffset.y *= factor;

		const cam = this.viewer.camera;
		const right = cam.right;
		const up = cam.up;
		const dir = cam.direction;

		const worldOffset = new Cesium.Cartesian3();

		const xVec = Cesium.Cartesian3.multiplyByScalar(right, scaledOffset.x, new Cesium.Cartesian3());
		const yVec = Cesium.Cartesian3.multiplyByScalar(up, scaledOffset.y, new Cesium.Cartesian3());
		const zVec = Cesium.Cartesian3.multiplyByScalar(dir, -scaledOffset.z, new Cesium.Cartesian3());

		Cesium.Cartesian3.add(xVec, yVec, worldOffset);
		Cesium.Cartesian3.add(worldOffset, zVec, worldOffset);

		const camPos = cam.positionWC;
		const finalPos = new Cesium.Cartesian3();
		Cesium.Cartesian3.add(camPos, worldOffset, finalPos);

		const carto = Cesium.Cartographic.fromCartesian(finalPos);

		return {
			lon: Cesium.Math.toDegrees(carto.longitude),
			lat: Cesium.Math.toDegrees(carto.latitude),
			alt: carto.height
		};
	}

	fire(playerState, specificWeaponId = null) {
		const weapon = specificWeaponId
			? this.weapons.find(w => w.id === specificWeaponId)
			: this.weapons[this.selectedWeaponIndex];

		if (!weapon) return;

		const now = performance.now() * 0.001;

		if (weapon.ammo <= 0) {
			if (now - this.lastEmptyWarningSoundTime > 2.0) {
				this.emptyWarningTimers[weapon.id] = 1.0;
				this.lastEmptyWarningSoundTime = now;
				try { soundManager.play('weapon-warning'); } catch (e) { }
			}
			return;
		}
		if (weapon.id === 'gun' && this.isGunOverheated) return;
		if (now - weapon.lastFire < weapon.fireRate) return;

		if (weapon.id === 'missile' && this.lockStatus !== 'LOCKED') {
			return;
		}

		weapon.lastFire = now;
		if (weapon.ammo !== Infinity) weapon.ammo--;

		const startPos = {
			lon: playerState.lon,
			lat: playerState.lat,
			alt: playerState.alt
		};

		if (weapon.id === 'gun') {
			this.gunHeat += 0.02;
			if (this.gunHeat >= 1.0) {
				this.isGunOverheated = true;
				try { soundManager.play('weapon-warning'); } catch (e) { }
			}

			const gunOffset = new THREE.Vector3(0, 0, 0);
			const nosePos = this.calculateWeaponPos(gunOffset) || movePosition(startPos.lon, startPos.lat, startPos.alt, playerState.heading, playerState.pitch, 5);

			const bullet = new Bullet(
				this.scene,
				this.viewer,
				nosePos,
				playerState.heading,
				playerState.pitch,
				playerState.speed,
				this.onKill
			);
			this.projectiles.push(bullet);
		} else if (weapon.id === 'missile') {
			this.lastMissileSide = !this.lastMissileSide;
			const side = this.lastMissileSide ? 1 : -1;
			const missileOffset = new THREE.Vector3(15.0 * side, -15.0, 0.0);

			const launchPos = this.calculateWeaponPos(missileOffset) || startPos;
			const target = this.target;

			// Dispatch on weapon type. AIM-120 gets the BVR-optimized class;
			// anything else (AIM-9 today, other IR weapons later) uses the
			// base Missile class.
			// playerState carries team='friendly'; pass it as the launcher so
			// team/signature are set at construction. Same call signature is
			// used by NPC firing in npcSystem.
			let projectile;
			if (weapon.type === 'AIM-120') {
				projectile = new AIM120(
					this.scene, this.viewer, launchPos,
					playerState.heading, playerState.pitch, playerState.speed,
					target, this.onKill, playerState,
				);
			} else {
				projectile = new Missile(
					this.scene, this.viewer, launchPos,
					playerState.heading, playerState.pitch, playerState.speed,
					target, this.onKill, playerState,
				);
			}
			this.projectiles.push(projectile);

			try { soundManager.play('missile-fire'); } catch (e) { }
		}
	}

	fireFlare(playerState) {
		const flareWeapon = this.flareWeapon;
		const now = performance.now() * 0.001;

		if (!flareWeapon || flareWeapon.ammo <= 0) {
			if (now - this.lastEmptyWarningSoundTime > 2.0) {
				this.emptyWarningTimers['flare'] = 1.0;
				this.lastEmptyWarningSoundTime = now;
				try { soundManager.play('weapon-warning'); } catch (e) { }
			}
			return;
		}
		if (now - flareWeapon.lastFire < 1.0) return;

		flareWeapon.ammo--;
		flareWeapon.lastFire = now;

		this.flareQueue = 6;
		this.lastFlarePulse = 0;
	}

	_spawnSingleFlare(playerState) {
		const flareOffset = new THREE.Vector3(0, -10.0, 6.0);
		const startPos = this.calculateWeaponPos(flareOffset) || {
			lon: playerState.lon,
			lat: playerState.lat,
			alt: playerState.alt
		};

		const flare = new Flare(
			this.scene,
			this.viewer,
			startPos,
			playerState.heading,
			playerState.pitch,
			playerState.speed
		);

		this.flares.push(flare);
	}

	update(dt, playerState, input = null) {
		const prevLockStatus = this.lockStatus;
		const currentWeapon = this.getCurrentWeapon();

		try {
			const isFiringGun = input && input.fire && currentWeapon.id === 'gun' && !this.isGunOverheated && currentWeapon.ammo > 0;
			if (isFiringGun) {
				if (!soundManager.isPlaying('m61-firing')) {
					soundManager.play('m61-firing');
				}
			} else {
				if (soundManager.isPlaying('m61-firing')) {
					soundManager.stop('m61-firing');
				}
			}
		} catch (e) { }

		if (currentWeapon.id === 'missile') {
			const potentialTarget = this.findPotentialTarget(playerState);
			const lockTimeReq = currentWeapon.lockTime || this.lockRequiredTime;

			if (potentialTarget) {
				if (this.lockingTarget === potentialTarget) {
					this.lockTime += dt;
					if (this.lockTime >= lockTimeReq) {
						this.lockStatus = 'LOCKED';
						this.target = potentialTarget;
					} else {
						this.lockStatus = 'LOCKING';
					}
				} else {
					this.lockingTarget = potentialTarget;
					this.lockTime = 0;
					this.lockStatus = 'LOCKING';
					this.target = null;
				}
			} else {
				this.lockingTarget = null;
				this.lockTime = 0;
				this.lockStatus = 'NONE';
				this.target = null;
			}
		} else {
			this.lockingTarget = null;
			this.lockTime = 0;
			this.lockStatus = 'NONE';
			this.target = null;
		}

		try {
			if (this.lockStatus === 'LOCKING') {
				if (!soundManager.isPlaying('rwr-tws')) {
					soundManager.play('rwr-tws');
				}
			} else {
				if (soundManager.isPlaying('rwr-tws')) {
					soundManager.stop('rwr-tws');
				}
			}

			if (prevLockStatus !== this.lockStatus && this.lockStatus === 'LOCKED') {
				soundManager.play('rwr-lock');
			}
			if (prevLockStatus === 'LOCKED' && this.lockStatus !== 'LOCKED') {
				if (soundManager.isPlaying('rwr-lock')) {
					soundManager.stop('rwr-lock');
				}
			}
		} catch (e) { }

		if (this.flareQueue > 0) {
			this.lastFlarePulse += dt;
			if (this.lastFlarePulse >= this.flareInterval || this.flareQueue === 6) {
				this._spawnSingleFlare(playerState);
				this.flareQueue--;
				this.lastFlarePulse = 0;
			}
		}

		if (this.gunHeat > 0) {
			this.gunHeat -= dt * 0.2;
			if (this.gunHeat <= 0) {
				this.gunHeat = 0;
				this.isGunOverheated = false;
			}
			if (this.isGunOverheated && this.gunHeat < 0.3) {
				this.isGunOverheated = false;
			}
		}

		for (const key in this.emptyWarningTimers) {
			if (this.emptyWarningTimers[key] > 0) {
				this.emptyWarningTimers[key] -= dt;
				if (this.emptyWarningTimers[key] < 0) this.emptyWarningTimers[key] = 0;
			}
		}

		// Pass every possible target (player + NPCs) to each projectile.
		// Friendly-fire / self-kill is filtered inside the missile via
		// `missile.team` and `missile.launcher`.
		const npcs = playerState.npcs || [];
		const targets = [playerState, ...npcs];

		for (let i = this.projectiles.length - 1; i >= 0; i--) {
			const p = this.projectiles[i];
			p.update(dt, targets);
			const hasTrail = p.trail && p.trail.length > 0;
			if (!p.active && !hasTrail) {
				this.projectiles.splice(i, 1);
			}
		}

		for (let i = this.flares.length - 1; i >= 0; i--) {
			const f = this.flares[i];
			f.update(dt);
			if (!f.active) {
				this.flares.splice(i, 1);
			}
		}
	}

	findPotentialTarget(playerState) {
		if (!playerState.npcs || playerState.npcs.length === 0) return null;

		// Use the currently-selected weapon's lock envelope. AIM-120 has a
		// much wider cone and 8× the range of the AIM-9.
		const weapon = this.getCurrentWeapon();
		const lockRange = weapon && weapon.lockRange ? weapon.lockRange : 10000;
		const lockCone  = weapon && weapon.lockCone  ? weapon.lockCone  : 0.985;

		let bestTarget = null;
		let maxDot = lockCone;

		for (const npc of playerState.npcs) {
			if (npc.destroyed) continue;
			// Team filter — never lock onto friendlies (AWACS, wingman,
			// tanker). Previously the lock cone would happily grab an
			// AWACS orbiting behind the player because nothing filtered
			// by team.
			if (npc.team && npc.team === playerState.team) continue;

			const dot = this.calculateDotProduct(playerState, npc);
			if (dot > maxDot) {
				const dist = this.calculateDist(playerState, npc);
				if (dist < lockRange) {
					bestTarget = npc;
					maxDot = dot;
				}
			}
		}
		return bestTarget;
	}

	calculateDotProduct(player, npc) {
		const hRad = Cesium.Math.toRadians(player.heading);
		const pRad = Cesium.Math.toRadians(player.pitch);
		const pDir = new THREE.Vector3(
			Math.sin(hRad) * Math.cos(pRad),
			Math.sin(pRad),
			Math.cos(hRad) * Math.cos(pRad)
		);

		const dLon = (npc.lon - player.lon) * 111320 * Math.cos(Cesium.Math.toRadians(player.lat));
		const dLat = (npc.lat - player.lat) * 111320;
		const dAlt = npc.alt - player.alt;
		const toNpc = new THREE.Vector3(dLon, dAlt, dLat).normalize();

		return pDir.dot(toNpc);
	}

	calculateDist(player, npc) {
		const dLon = (npc.lon - player.lon) * 111320 * Math.cos(Cesium.Math.toRadians(player.lat));
		const dLat = (npc.lat - player.lat) * 111320;
		const dAlt = npc.alt - player.alt;
		return Math.sqrt(dLon * dLon + dLat * dLat + dAlt * dAlt);
	}
}
