import * as THREE from 'three';
import * as Cesium from 'cesium';
import { createMunition, munitionIdForSimType } from '../weapon/munitionFactory';
import { MUNITIONS } from '../weapon/munitions';
import { Bullet } from '../weapon/bullet';
import { Flare } from '../weapon/flare';
import { soundManager } from '../utils/soundManager';
import { movePosition } from '../utils/math';
import { isRadiating } from './sensorSystem.js';
import { playerDesignation, consumeDesignationHead } from './designation.js';
import { consumeHardpointShot } from '../plane/loadout.js';
import { pickWingmanShooter } from './formation.js';

export class WeaponSystem {
	constructor(viewer, scene, playerModel) {
		this.viewer = viewer;
		this.scene = scene;
		this.playerModel = playerModel;

		this.weapons = [
			{ id: 'gun',     name: 'M61A1 CANNON',    ammo: Infinity, maxAmmo: Infinity, fireRate: 0.05, lastFire: 0 },
			// AIM-9M: legacy reticle IR seeker. Cheap, plentiful, but
			// flare-vulnerable; narrower acquisition cone than the X.
			{ id: 'missile', name: 'AIM-9M SIDEWINDER', ammo: 0,  maxAmmo: 0,  fireRate: 0,
			  lastFire: 0, type: 'AIM-9M',   lockRange: 12000, lockCone: 0.96,  lockTime: 0.7 },
			// AIM-9X: imaging-IR + thrust-vectoring. ±90° HOBS cone,
			// near-immune to flare decoys, ~50G turns. The premium WVR
			// option vs the older 9M.
			{ id: 'missile', name: 'AIM-9X SIDEWINDER', ammo: 6,  maxAmmo: 6,  fireRate: 0,
			  lastFire: 0, type: 'AIM-9X',   lockRange: 25000, lockCone: 0.0,   lockTime: 0.4 },
			// AIM-120D: active-radar BVR. Modern AESA fighter radars
			// (APG-63V3, APG-77, APG-81, APG-82) hold firing-grade
			// tracks essentially continuously in TWS; transitioning to
			// STT for launch is near-instant. 0.3 s dwell is enough for
			// the RWR-tone transition without pretending the player is
			// still flying a 1970s mechanical-scan set. Range bumped to
			// 120 km so the firing envelope matches the radar's actual
			// tracking range, not an arbitrarily tighter number.
			{ id: 'missile', name: 'AIM-120D AMRAAM',  ammo: 4,  maxAmmo: 4,  fireRate: 0,
			  lastFire: 0, type: 'AIM-120',  lockRange: 120000, lockCone: 0.92,  lockTime: 0.3 },
			// MBDA Meteor BVRAAM. Same Fox-3 architecture as AMRAAM —
			// midcourse datalink + active-radar terminal — but the
			// throttleable ramjet sustains thrust for the full flight,
			// so its no-escape zone is roughly 3× larger. Effective
			// launch range bumped to 180 km; the lockCone is the same
			// (it's a function of the radar's gimbal, not the missile)
			// and lockTime is identical (the radar doesn't know which
			// missile is loaded behind it).
			{ id: 'missile', name: 'MBDA METEOR',      ammo: 0,  maxAmmo: 0,  fireRate: 0,
			  lastFire: 0, type: 'METEOR',   lockRange: 180000, lockCone: 0.92,  lockTime: 0.3 },
			// Vympel R-77 (RVV-AE / "AA-12 Adder") — Russian active-radar
			// AAM, AMRAAM analog. Same Fox-3 fire profile as AIM-120;
			// slightly tighter no-escape zone in our model.
			{ id: 'missile', name: 'R-77 RVV-AE',      ammo: 0,  maxAmmo: 0,  fireRate: 0,
			  lastFire: 0, type: 'R-77',     lockRange: 80000,  lockCone: 0.92,  lockTime: 0.3 },
			// Vympel R-37M ("AA-13 Axehead") — long-range AESA-class
			// BVR weapon, Mach 6 peak, designed to swat tankers / AWACS
			// at very long range. Heavy + sluggish in terminal but the
			// no-escape envelope is enormous.
			{ id: 'missile', name: 'R-37M',            ammo: 0,  maxAmmo: 0,  fireRate: 0,
			  lastFire: 0, type: 'R-37M',    lockRange: 200000, lockCone: 0.92,  lockTime: 0.3 },
			// Vympel R-73 ("AA-11 Archer") — IR-guided WVR with TVC
			// and a 60° off-boresight seeker. Russian AIM-9X analog.
			{ id: 'missile', name: 'R-73',             ammo: 0,  maxAmmo: 0,  fireRate: 0,
			  lastFire: 0, type: 'R-73',     lockRange: 20000,  lockCone: 0.0,   lockTime: 0.4 },
			// AGM-88 HARM. Anti-radiation seeker — passive, no AESA
			// lock required. The seeker scans hostile radiating units
			// at launch and auto-picks the strongest in cone. id='agm'
			// (not 'missile') is what bypasses the lockStatus gate in
			// fire() and skips the AESA lock-progress loop in update().
			{ id: 'agm',     name: 'AGM-88 HARM',       ammo: 0,  maxAmmo: 0,  fireRate: 0,
			  lastFire: 0, type: 'AGM-88',   lockRange: 0,      lockCone: 0,     lockTime: 0 },
			// GBU-12 Paveway II — laser-guided 500 lb. Fires whenever
			// the player has a designation (TRACK or LASE on the TGP);
			// LASE is required during the bomb's terminal phase for
			// the seeker to hold the spot. id='gbu' bypasses the AESA
			// lock gate the same way 'agm' does.
			{ id: 'gbu',     name: 'GBU-12 PAVEWAY II', ammo: 0,  maxAmmo: 0,  fireRate: 0,
			  lastFire: 0, type: 'GBU-12',   lockRange: 0,      lockCone: 0,     lockTime: 0 },
			// GBU-38 JDAM — 500 lb GPS-guided. Fires whenever the player
			// has a designation (TRACK or LASE on the TGP); the seeker
			// freezes the spot's lat/lon/alt at release and ignores TGP
			// state changes afterward. Same `id: 'gbu'` slot as the
			// laser-guided weapons; the fire branch below dispatches on
			// the munition's seekerType to pick the right target shape.
			{ id: 'gbu',     name: 'GBU-38 JDAM',       ammo: 0,  maxAmmo: 0,  fireRate: 0,
			  lastFire: 0, type: 'GBU-38',   lockRange: 0,      lockCone: 0,     lockTime: 0 },
			// GBU-31 JDAM — 2000 lb GPS-guided. Same release behaviour
			// as the GBU-38 with a substantially larger warhead.
			{ id: 'gbu',     name: 'GBU-31 JDAM',       ammo: 0,  maxAmmo: 0,  fireRate: 0,
			  lastFire: 0, type: 'GBU-31',   lockRange: 0,      lockCone: 0,     lockTime: 0 },
			// GBU-39 SDB — 250 lb GPS glide bomb. Same fire path as
			// the JDAM family (id='gbu', seekerType='gps'); the high
			// glideFactor in its JSON gives it ~110 km stand-off
			// range from a high-altitude toss release.
			{ id: 'gbu',     name: 'GBU-39 SDB',        ammo: 0,  maxAmmo: 0,  fireRate: 0,
			  lastFire: 0, type: 'GBU-39',   lockRange: 0,      lockCone: 0,     lockTime: 0 },
			// AGM-86C ALCM — air-launched cruise missile, terrain-
			// following at ~120 m AGL, GPS terminal. id='agm' shares
			// the HARM/anti-radiation slot semantics (no AESA lock
			// required); the fire branch checks munition seekerType
			// to dispatch the right target shape (cruise wants the
			// frozen GPS coord just like JDAM, not the radiating-
			// emitter target HARM uses).
			{ id: 'agm',     name: 'AGM-86C CALCM',     ammo: 0,  maxAmmo: 0,  fireRate: 0,
			  lastFire: 0, type: 'AGM-86',  lockRange: 0,      lockCone: 0,     lockTime: 0 },
			// Storm Shadow / SCALP-EG (JASSM substitute). Same fire
			// path as the ALCM; the cruise profile differs entirely
			// per the munition JSON (MSL vs AGL altitude mode).
			{ id: 'agm',     name: 'STORM SHADOW',      ammo: 0,  maxAmmo: 0,  fireRate: 0,
			  lastFire: 0, type: 'STORM-SHADOW', lockRange: 0, lockCone: 0,    lockTime: 0 },
			// 6e.2 — EW JAMMER pseudo-weapon. Not a projectile launcher;
			// pressing fire toggles the currently-designated victim into
			// state.jammer.offensiveTargets (sustained beam). `ammo` is
			// effectively infinite when the airframe carries a pod
			// (state.jammer != null) — _carriedWeapons() promotes it
			// based on the player state, not the static `ammo` field.
			// Tab-cycle picks the victim from RWR ∪ radar contacts via
			// cycleDesignatedJamTarget().
			{ id: 'jammer',  name: 'EW JAMMER',         ammo: 0,  maxAmmo: 0,  fireRate: 0,
			  lastFire: 0, type: 'JAMMER',  lockRange: 0,      lockCone: 0,     lockTime: 0 },
		];

		this.flareWeapon = { id: 'flare', name: 'MJU-7A', ammo: 30, maxAmmo: 30, fireRate: 0.2, lastFire: 0 };

		this.selectedWeaponIndex = 0;
		this.projectiles = [];
		this.flares = [];
		this.onKill = null;

		// ---- AESA multi-target lock state ------------------------------
		// `locks` is a Map keyed by NPC, tracking each individual track's
		// status independently — modern AESA radars can maintain tracks
		// on many contacts simultaneously (typically 10+). `progress` is
		// 0..1 toward the weapon's lockTime requirement; once it hits 1
		// the status flips to 'LOCKED' and that contact is eligible as
		// the designated target. Contacts that leave the current weapon's
		// envelope drop out of the Map; contacts that come back in start
		// their progress timer from zero again.
		this.locks = new Map();
		// The one contact missile shots will actually launch at. Points
		// into `locks` (must have status === 'LOCKED' to fire). Cycled
		// by Tab / Shift+Tab.
		this.designatedTarget = null;

		// ---- Anti-radiation designation (HARM) -----------------------
		// The currently designated emitter for HARM shots. Independent
		// of the AESA designated target — emitters come from the RWR
		// (passive listening), not from the radar's track file. Cycled
		// by Tab while a HARM is the active weapon. If null at fire
		// time, the HARM auto-acquires the strongest emitter in its
		// forward cone (legacy behaviour). If set, the seeker locks
		// that specific unit at launch — the standard way real aircrews
		// avoid every HARM piling onto the biggest emitter.
		this.designatedEmitter = null;

		// ---- Jammer designation (offensive EW) -----------------------
		// Currently designated victim for offensive jamming. Cycled via
		// Tab while EW JAMMER is the active weapon. Eligible candidates
		// = (radar contacts ∪ RWR emitters) of opposing teams. Pressing
		// fire toggles this unit into state.jammer.offensiveTargets;
		// while present there, accumulateJamAttenuation applies a
		// stronger corridor jam against that victim's radar.
		this.designatedJamTarget = null;

		// Back-compat alias used by fire() and legacy callers. Kept in
		// sync with designatedTarget every update().
		this.target = null;
		// Legacy single-target lock status, derived from the designated
		// target's entry in `locks`. HUD reads this for the big centre
		// lock box.
		this.lockStatus = 'NONE';
		this.lockingTarget = null;

		this.isGunOverheated = false;
		this.gunHeat = 0;

		this.lockRequiredTime = 2.0; // overridden per-weapon when locking

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

	// Apply per-simType ammo counts from the loadout system. Called by
	// main.js on spawn commit with an object like { 'AIM-120': 4,
	// 'AIM-9': 2 }. Any type not present in the loadout is zeroed
	// (you didn't load it, you don't have it). Gun ammo (Infinity)
	// is unaffected.
	applyLoadout(counts = {}) {
		for (const w of this.weapons) {
			if (!w.type || w.ammo === Infinity) continue;
			const n = counts[w.type] || 0;
			w.ammo = n;
			w.maxAmmo = n;
		}
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

	// "Carried" = gun (always has ammo) or any missile slot the loadout
	// actually loaded. Used by toggleWeapon / selectWeapon below so the
	// player never gets stuck on an empty slot — pressing 2 lands on
	// the first non-empty missile, Q-cycle skips empty slots entirely.
	// Without this, a default-loaded F-15 (no AIM-9M) would happily
	// cycle into the AIM-9M slot, name it on the HUD, and silently
	// fail to fire — exactly the "AIM-9X won't fire" bug the player
	// sees when they think they're on AIM-9X but are actually on the
	// AIM-9M slot one over.
	_carriedWeapons() {
		const list = [];
		for (const w of this.weapons) {
			// EW jammer is a pseudo-weapon — it has no ammo, the
			// "carry" check is "does the airframe have a pod?" We
			// stash a back-reference to the player state on the
			// weapon system so this method can ask. If no pod, the
			// slot is silently invisible to Q-cycle and number keys.
			if (w.id === 'jammer') {
				if (this._playerState && this._playerState.jammer) list.push(w);
				continue;
			}
			if (w.ammo === Infinity || w.ammo > 0) list.push(w);
		}
		return list;
	}

	toggleWeapon() {
		const carried = this._carriedWeapons();
		if (carried.length === 0) return;
		const cur = this.weapons[this.selectedWeaponIndex];
		let pos = carried.indexOf(cur);
		if (pos < 0) pos = -1; // current weapon empty / not in carried list
		const next = carried[(pos + 1) % carried.length];
		this.selectedWeaponIndex = this.weapons.indexOf(next);
		try { soundManager.play('weapon-switch'); } catch (e) { }
	}

	selectWeapon(index) {
		// `index` is interpreted as the Nth *carried* weapon, not the raw
		// array index. So key 1 → gun, key 2 → first non-empty missile,
		// key 3 → second non-empty missile, etc. This makes the keys
		// adapt to whatever the player loaded — pressing 2 always
		// selects "the first AAM I'm carrying", regardless of whether
		// that's an AIM-9M, AIM-9X, AIM-120, or METEOR.
		const carried = this._carriedWeapons();
		if (index < 0 || index >= carried.length) return;
		this.selectedWeaponIndex = this.weapons.indexOf(carried[index]);
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
		// Edge-detection for non-gun weapons: one press = at most one
		// launch. Real ripple-fire is the pilot pressing the pickle
		// button repeatedly, not holding it down. Without this, holding
		// the trigger for 100ms would burn through a whole magazine.
		// The gun keeps its cyclic-rate gate (fireRate=0.05) so it
		// hoses bullets while held.
		if (weapon.id !== 'gun') {
			if (this._fireHeld) return;
			this._fireHeld = true;
		} else {
			if (now - weapon.lastFire < weapon.fireRate) return;
		}

		if (weapon.id === 'missile' && this.lockStatus !== 'LOCKED') {
			return;
		}

		weapon.lastFire = now;
		if (weapon.ammo !== Infinity) weapon.ammo--;

		// Pop one hardpoint off the per-shot plan so RCS reflects what
		// actually still sits on the rails. No-op for the gun
		// (Infinity ammo, no simType match), flares, or jammer beams
		// since none of those have a hardpoint entry. Internal-bay
		// shots leave RCS unchanged (they contributed 0 from the
		// start). External shots subtract their rcsContributionM2.
		consumeHardpointShot(playerState, weapon.type);

		// Phase 5.5 — formation flight pool. For coord-homing strike
		// weapons (cruise / GPS / laser-guided — any AGM or GBU), pick
		// the first wingman in formation mode with ammo of the same
		// simType and have THEM launch instead. The missile flies to
		// the same designated coord regardless of who released it,
		// effectively making the formation a 4-aircraft ammo rack
		// from the player's perspective. Wingmen exhaust their stocks
		// before the player burns their own — same priority a
		// real-world strike-package commander would use.
		//
		// Other weapon types stay player-only:
		//   - gun: aim is the player's nose; doesn't transfer.
		//   - missile (AAM): seeker takes the AESA-locked target ref,
		//     which only the player's radar produced. A wingman
		//     "firing" the same missile would have a stale lock.
		let shooter = playerState;
		const isFormationPoolEligible = (weapon.id === 'agm' || weapon.id === 'gbu');
		if (isFormationPoolEligible) {
			const wing = pickWingmanShooter(weapon.type);
			if (wing) {
				// Refund the player's round (decremented just above)
				// and consume the wingman's instead. Net: same total
				// ammo gone, but from the wingman's magazine.
				if (weapon.ammo !== Infinity) {
					weapon.ammo = Math.min(weapon.maxAmmo, weapon.ammo + 1);
				}
				wing.weapon.ammo    = Math.max(0, wing.weapon.ammo - 1);
				wing.weapon.lastFire = now;
				shooter = wing.unit;
			}
		}

		const startPos = {
			lon: shooter.lon,
			lat: shooter.lat,
			alt: shooter.alt
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
				this.onKill,
				playerState,
			);
			this.projectiles.push(bullet);
		} else if (weapon.id === 'missile' || weapon.id === 'agm' || weapon.id === 'gbu') {
			this.lastMissileSide = !this.lastMissileSide;
			const side = this.lastMissileSide ? 1 : -1;
			const missileOffset = new THREE.Vector3(15.0 * side, -15.0, 0.0);

			// Launch position: when the player is firing, use the
			// cockpit-relative hardpoint offset (calculateWeaponPos
			// projects the offset through the cockpit-camera transform
			// — only meaningful for the player's own model). When a
			// wingman is firing, just use the wingman's world pose
			// directly: a few meters of hardpoint offset is invisible
			// at the ranges these weapons engage.
			const launchPos = (shooter === playerState)
				? (this.calculateWeaponPos(missileOffset) || startPos)
				: { lon: shooter.lon, lat: shooter.lat, alt: shooter.alt };
			// AAMs hand the seeker the AESA-locked target. AGM-88 HARM
			// (anti-radiation) gets the player's designated emitter if
			// one is set on the RWR; otherwise null and the seeker
			// auto-picks the strongest emitter in its forward cone at
			// launch (legacy behaviour, fine when there's only one
			// thing radiating).
			let target;
			if (weapon.id === 'agm') {
				// AGM slot covers two seeker families:
				//   anti_radiation (HARM) → live emitter target.
				//   cruise (ALCM, Storm Shadow) → frozen GPS coord
				//     snapshotted from the strike-planner queue
				//     head, same shape JDAM uses. Refuse if no
				//     designation (mode === SLEW).
				const munId = munitionIdForSimType(weapon.type);
				const data  = munId ? MUNITIONS[munId] : null;
				const seekerType = data && data.seekerType;
				if (seekerType === 'cruise') {
					if (!playerDesignation || playerDesignation.mode === 'SLEW') {
						weapon.ammo = Math.min(weapon.maxAmmo, weapon.ammo + 1);
						try { soundManager.play('weapon-warning'); } catch (e) { }
						return;
					}
					target = {
						lon: playerDesignation.lon,
						lat: playerDesignation.lat,
						alt: playerDesignation.alt,
					};
					consumeDesignationHead();
				} else {
					// HARM path: designated emitter or null (seeker
					// auto-picks strongest in cone). Validity check
					// shared with RWR scope + commander debug overlay
					// via isRadiating().
					target = isRadiating(this.designatedEmitter)
						? this.designatedEmitter
						: null;
				}
			} else if (weapon.id === 'gbu') {
				// GBU slot covers both laser-guided (GBU-12) and
				// GPS-guided (GBU-31, GBU-38) bombs. Dispatch on the
				// munition's seekerType:
				//   laser → target null; LaserSeeker reads
				//           playerDesignation each frame.
				//   gps   → snapshot the current designation as a
				//           plain {lon,lat,alt} object; GPSSeeker
				//           freezes it on its instance and ignores
				//           the singleton afterward. Refuse the shot
				//           if the TGP is in SLEW (no point to
				//           freeze) — refund happens below via the
				//           null-projectile path.
				const munId = munitionIdForSimType(weapon.type);
				const data  = munId ? MUNITIONS[munId] : null;
				const seekerType = data && data.seekerType;
				if (seekerType === 'gps') {
					if (!playerDesignation || playerDesignation.mode === 'SLEW') {
						// Refund the round and bail. The empty-warning
						// pulse below isn't a great fit (this isn't an
						// ammo-out condition), but a soft refusal is
						// better than launching a bomb at null island.
						weapon.ammo = Math.min(weapon.maxAmmo, weapon.ammo + 1);
						try { soundManager.play('weapon-warning'); } catch (e) { }
						return;
					}
					target = {
						lon: playerDesignation.lon,
						lat: playerDesignation.lat,
						alt: playerDesignation.alt,
					};
					// Consume the head of the strike-planner queue so
					// the NEXT JDAM fired homes on the NEXT queued
					// point. Single-target sessions just fall to SLEW
					// after consume (queue empty); a salvo of N JDAMs
					// against N queued points walks the queue down.
					consumeDesignationHead();
				} else {
					// Laser (GBU-12) and any future seeker that reads
					// the singleton directly: no target object needed.
					target = null;
				}
			} else {
				target = this.target;
			}

			// Factory dispatch on the weapon's simType. Returns the
			// right seeker-class instance for whatever munition is
			// loaded in that slot (AIM-120D → AIM120, AIM-9X → Missile,
			// AGM-88 → AntiRadiationSeeker, future LGB / JDAM → their
			// own seeker classes).
			const munitionId = munitionIdForSimType(weapon.type);
			// Initial attitude / speed of the new projectile come from
			// whichever aircraft is actually firing — wingmen are
			// flying their own pose. `launcher` stays as playerState
			// so the missile's team / friendly-fire filtering keeps
			// referring to the human-controlled side; the wingman's
			// team is also 'friendly' so this would behave the same
			// either way, but the playerState-as-launcher convention
			// is what HARM auto-acquire and other systems already
			// expect downstream.
			const projectile = createMunition(
				munitionId,
				this.scene, this.viewer, launchPos,
				shooter.heading, shooter.pitch, shooter.speed,
				target, this.onKill, playerState,
			);
			if (!projectile) {
				// Unknown munition / unimplemented seeker — refund the
				// round so the user isn't punished for our missing code.
				weapon.ammo = Math.min(weapon.maxAmmo, weapon.ammo + 1);
				return;
			}
			this.projectiles.push(projectile);

			try { soundManager.play('missile-fire'); } catch (e) { }
		}
	}

	// Called when the fire input goes from held → released. Resets the
	// edge-detection flag so the next press fires again. Without this,
	// the player would launch one missile per fresh press (correct) but
	// also be permanently stuck after a single fire (incorrect).
	releaseFireHold() {
		this._fireHeld = false;
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
		// No artificial cooldown — modern CMDS will dispense as fast
		// as the pilot pulls the button. The only gate is "don't start
		// a new burst while the previous one is still pulsing out",
		// which is implicit: each press queues 6 flares spaced
		// flareInterval apart, and the queue drains in update(). Held
		// key = back-to-back bursts until the magazine is dry.
		if (this.flareQueue > 0) return;

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

	// Re-bake every live player projectile's mesh matrix against the
	// CURRENT Cesium view matrix. Mirrors npcSystem.syncMeshMatrices —
	// called from main.js after a camera move so the THREE meshes stay
	// aligned with the earth the Cesium camera is about to render.
	// Without this, switching into spectator mode on a moving target
	// makes player-fired missiles appear to shake in world space every
	// time frame-time jitters, because they were baked with a slightly
	// stale view matrix.
	syncMeshMatrices() {
		for (const p of this.projectiles) {
			if (!p || !p.active) continue;
			if (typeof p.updateThreeMatrix === 'function') p.updateThreeMatrix();
		}
	}

	update(dt, playerState, input = null) {
		// Cache back-ref so _carriedWeapons() can ask whether the
		// airframe is wearing a jammer pod (state.jammer != null) when
		// deciding whether to expose the EW JAMMER slot to Q-cycle and
		// the number-key shortcuts.
		this._playerState = playerState;
		const prevLockStatus = this.lockStatus;
		const currentWeapon = this.getCurrentWeapon();

		// Drop the jammer-designated victim if it's been killed.
		// Defensive sweep — same pattern as designatedEmitter below.
		if (this.designatedJamTarget
			&& (this.designatedJamTarget.destroyed
				|| this.designatedJamTarget.active === false)) {
			this.designatedJamTarget = null;
		}
		// And if the player isn't wearing a pod (e.g. they swapped
		// airframes), drop any leftover state.
		if (!playerState || !playerState.jammer) {
			this.designatedJamTarget = null;
		}

		// Drop the HARM-designated emitter if it's been killed or
		// permanently disabled. Don't drop on radar shutdown alone —
		// players designate-then-wait-for-emcon-cycle as a tactic.
		if (this.designatedEmitter
			&& (this.designatedEmitter.destroyed
				|| this.designatedEmitter.active === false)) {
			this.designatedEmitter = null;
		}

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

		// ------------------------------------------------------------
		// AESA-style multi-target lock maintenance.
		//
		// While a missile weapon is selected: for every hostile NPC in
		// the current weapon's envelope, accumulate an individual lock
		// timer. Once any track's timer hits the weapon's lockTime, that
		// track becomes 'LOCKED' — the designated-target pointer can be
		// switched to it via Tab. Tracks that leave the envelope are
		// dropped. When the gun is selected all locks are cleared.
		// ------------------------------------------------------------
		let newLockAcquired = false;
		if (currentWeapon.id === 'missile') {
			const lockTimeReq = currentWeapon.lockTime || this.lockRequiredTime;
			const inEnvelope = this.findTargetsInEnvelope(playerState);
			// 6b — radar mode gates the lock pipeline ONLY for
			// active-radar missiles (AIM-120, METEOR). IR missiles
			// (AIM-9M, AIM-9X) acquire via their own IR seekers and
			// the AESA-style "lock" pipeline here is just shared
			// target-designation infrastructure — independent of
			// what the radar's playerMode is. So we look up the
			// current weapon's seekerType and only apply the
			// rws/tws/stt modal behavior when it's radar-guided.
			//
			// Modes:
			//   rws → no firing-grade tracks form. Drop everything to
			//         search-only state. Scope still shows contacts;
			//         no LOCKED status → no AAM fire. Passive scan.
			//   tws → tracks progress as before; designated target gets
			//         the standard rate.
			//   stt → only the designated target progresses; everyone
			//         else stays at SEARCHING. Lock time halved on
			//         the designated so STT commits feel snappy.
			const radar    = playerState.sensors && playerState.sensors.radar;
			const playerMode = (radar && radar.playerMode) || 'tws';
			const munId    = munitionIdForSimType(currentWeapon.type);
			const munData  = munId ? MUNITIONS[munId] : null;
			const isRadarMissile = munData && munData.seekerType === 'active_radar';
			const effectiveMode = isRadarMissile ? playerMode : 'tws';

			if (effectiveMode === 'rws') {
				// Drop any in-progress / locked entries — no
				// firing-grade tracks in RWS.
				for (const [npc, entry] of this.locks) {
					if (!inEnvelope.has(npc) || npc.destroyed) {
						this.locks.delete(npc);
					} else if (entry.status !== 'SEARCHING') {
						entry.status = 'SEARCHING';
						entry.progress = 0;
					}
				}
				for (const npc of inEnvelope) {
					if (this.locks.has(npc)) continue;
					this.locks.set(npc, { progress: 0, status: 'SEARCHING' });
				}
			} else {
				// TWS / STT — locks progress. STT focuses on a single
				// target at a higher rate; TWS spreads attention
				// equally across all in-envelope contacts.
				const sttFocus = (effectiveMode === 'stt');
				const sttRate  = 2.0;  // STT halves lock time

				// In STT, choose the focused target. Prefer the
				// existing designatedTarget if it's still in
				// envelope; otherwise pick the nearest. This means
				// "switch to STT and you immediately start locking
				// the closest threat" — no need to manually
				// pre-designate before cycling modes.
				let sttTarget = null;
				if (sttFocus) {
					if (this.designatedTarget &&
						inEnvelope.has(this.designatedTarget) &&
						!this.designatedTarget.destroyed) {
						sttTarget = this.designatedTarget;
					} else {
						let bestDist = Infinity;
						for (const npc of inEnvelope) {
							const d = this.calculateDist(playerState, npc);
							if (d < bestDist) { bestDist = d; sttTarget = npc; }
						}
					}
				}

				for (const [npc, entry] of this.locks) {
					if (!inEnvelope.has(npc) || npc.destroyed) {
						this.locks.delete(npc);
					} else {
						if (entry.status !== 'LOCKED') {
							const rate = sttFocus
								? (npc === sttTarget ? sttRate : 0)
								: 1;
							entry.progress += rate * dt / lockTimeReq;
							if (entry.progress >= 1) {
								entry.progress = 1;
								entry.status = 'LOCKED';
								newLockAcquired = true;
							}
						}
					}
				}
				for (const npc of inEnvelope) {
					if (this.locks.has(npc)) continue;
					this.locks.set(npc, { progress: 0, status: 'LOCKING' });
				}
			}
		} else {
			// Gun selected: drop every radar track. Real jets keep the
			// air picture alive across mode switches, but this sim
			// doesn't animate a "reacquisition" transition and keeping
			// stale tracks around would be a footgun for the HUD.
			this.locks.clear();
			this.designatedTarget = null;
		}

		// Validate / refresh the designated target. Three cases:
		//   1. No designated target but at least one LOCKED contact →
		//      auto-promote the first one (closest would be marginally
		//      better, but locked tracks are already close-ish).
		//   2. Designated target still LOCKED → keep it.
		//   3. Designated target gone / not LOCKED → try to promote
		//      another LOCKED contact, or null out.
		const designatedEntry = this.designatedTarget && this.locks.get(this.designatedTarget);
		if (!designatedEntry || designatedEntry.status !== 'LOCKED') {
			let pick = null;
			for (const [npc, entry] of this.locks) {
				if (entry.status === 'LOCKED') { pick = npc; break; }
			}
			this.designatedTarget = pick;
		}

		// Legacy fields for the HUD / fire() path — mirror the designated
		// target's state into the single-target shape the rest of the
		// system was built around.
		this.target         = this.designatedTarget;
		this.lockingTarget  = this.designatedTarget;
		if (this.designatedTarget) {
			const e = this.locks.get(this.designatedTarget);
			this.lockStatus = e ? e.status : 'NONE';
		} else {
			// No designated target, but if anything is LOCKING we still
			// want the "searching" tone / HUD cue.
			let anyLocking = false;
			for (const [, e] of this.locks) {
				if (e.status === 'LOCKING') { anyLocking = true; break; }
			}
			this.lockStatus = anyLocking ? 'LOCKING' : 'NONE';
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

			// Play the lock tone whenever ANY track transitions to LOCKED
			// (not just when the single designated-target changes state).
			// Gives you the audible "ping" each time a new AESA track
			// completes the lock timer.
			if (newLockAcquired) {
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

		// Pass every possible target (player + NPCs + other projectiles)
		// to each projectile. Friendly-fire / self-kill is filtered
		// inside the missile via `missile.team` and `missile.launcher`.
		// Including NPC projectiles lets future AAM-vs-cruise-missile
		// engagements work; today nothing on the player side targets
		// inbound missiles, but the symmetric path is needed for the
		// SAM-shoots-down-cruise case to read identically.
		const npcs = playerState.npcs || [];
		const npcProjs = playerState.npcProjectiles || [];
		const targets = [playerState, ...npcs, ...npcProjs];

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

	// Return every hostile NPC inside the current weapon's lock envelope
	// (radar cone + range). Returns a Set for fast membership checks in
	// the lock-maintenance loop. Replaces the old findPotentialTarget,
	// which only returned the single best candidate — the multi-lock
	// path needs every candidate because each gets its own track entry.
	findTargetsInEnvelope(playerState) {
		const out = new Set();
		if (!playerState.npcs || playerState.npcs.length === 0) return out;

		const weapon = this.getCurrentWeapon();
		const lockRange = (weapon && weapon.lockRange != null) ? weapon.lockRange : 10000;
		// Note: lockCone of 0 = ±90° (HOBS), perfectly valid. Older
		// `weapon.lockCone ? ... : 0.985` truthy fallback would have
		// snapped that back to a 10° cone, breaking AIM-9X HOBS.
		const lockCone  = (weapon && weapon.lockCone  != null) ? weapon.lockCone  : 0.985;

		// 5i — AAM ground-targeting gating. Air-to-air missiles use
		// flying-target signatures (Doppler-rich return, hot exhaust,
		// big visual angular size in their seeker cones). Ground
		// units violate every assumption: zero ground speed gets
		// notched by pulse-Doppler, IR signature is dwarfed by terrain
		// thermal noise, AAMs have no ground-clutter rejection. The
		// player's AESA will happily *paint* a ground unit (radar is
		// notch=90 m/s, fine for SAMs that move 0 m/s — wait, no,
		// notch FILTERS those out. But the radar still tracks them
		// via terrain-blocking-aware fallback in the visual /
		// IR sensor channels.) Either way, locking an AIM-9X onto a
		// tank and firing produces a missile that thrashes around
		// for a few seconds and dives into the ground. So just gate
		// it: AAMs don't accept ground-class targets as locks.
		const isAAM = (weapon && weapon.id === 'missile');
		for (const npc of playerState.npcs) {
			if (npc.destroyed) continue;
			// Team filter — never lock onto friendlies (AWACS, wingman,
			// tanker). Without this the AESA would happily paint every
			// friendly in the sky.
			if (npc.team && npc.team === playerState.team) continue;
			// Ground-target filter for AAMs only. HARM / GBU / AGM
			// don't go through findTargetsInEnvelope — they take a
			// designation directly — so the gate here is air-only and
			// doesn't collaterally block strike weapons.
			if (isAAM && npc.kind === 'ground') continue;

			const dot = this.calculateDotProduct(playerState, npc);
			if (dot <= lockCone) continue;
			const dist = this.calculateDist(playerState, npc);
			if (dist >= lockRange) continue;
			out.add(npc);
		}
		return out;
	}

	// Cycle the designated target through the set of currently-LOCKED
	// contacts. `direction = +1` advances forward (Tab), `-1` goes back
	// (Shift+Tab). LOCKING contacts are excluded — you can only fire
	// at a fully-established track, and cycling to a track you can't
	// fire at would be a confusing UX. No-op if no contacts are locked.
	cycleDesignatedTarget(direction = 1) {
		const locked = [];
		for (const [npc, entry] of this.locks) {
			if (entry.status === 'LOCKED') locked.push(npc);
		}
		if (locked.length === 0) {
			this.designatedTarget = null;
			return;
		}
		// Stable order by name — otherwise the Map's insertion order can
		// shuffle as contacts drop in and out of envelope, making Tab
		// feel arbitrary. Name is a stable identifier the HUD already
		// shows, so cycling feels like "next bandit on the list".
		locked.sort((a, b) => {
			const na = (a.name || '').toString();
			const nb = (b.name || '').toString();
			return na.localeCompare(nb);
		});
		const idx = locked.indexOf(this.designatedTarget);
		const next = (idx + (direction > 0 ? 1 : -1) + locked.length) % locked.length;
		// If designated wasn't in the list (idx === -1), `next` still
		// resolves to a valid index in [0, locked.length).
		this.designatedTarget = locked[idx < 0 ? 0 : next];
		try { soundManager.play('weapon-switch'); } catch (e) {}
	}

	// Cycle the designated emitter through the set of currently-radiating
	// hostiles on the player's RWR. Used by Tab while a HARM is the
	// active weapon — the player picks which SAM the next HARM should
	// hunt rather than letting every shot pile onto the strongest
	// emitter (typically the EWR). `direction = +1` advances forward.
	// `playerState` is the live player state object; we read its `rwr`
	// Map (populated by sensorSystem each tick).
	cycleDesignatedEmitter(playerState, direction = 1) {
		const rwr = playerState && playerState.rwr;
		if (!rwr || rwr.size === 0) {
			this.designatedEmitter = null;
			return;
		}
		// Filter to live, currently-radiating hostiles. RWR entries can
		// linger briefly after an emitter shuts down (sensorSystem
		// expires them on its own clock), so re-validate here.
		const emitters = [];
		for (const [src] of rwr) {
			if (isRadiating(src)) emitters.push(src);
		}
		if (emitters.length === 0) {
			this.designatedEmitter = null;
			return;
		}
		// Stable order by name so the cycle feels deterministic.
		emitters.sort((a, b) => {
			const na = (a.name || '').toString();
			const nb = (b.name || '').toString();
			return na.localeCompare(nb);
		});
		const idx = emitters.indexOf(this.designatedEmitter);
		const step = direction > 0 ? 1 : -1;
		const next = (idx + step + emitters.length) % emitters.length;
		this.designatedEmitter = emitters[idx < 0 ? 0 : next];
		try { soundManager.play('weapon-switch'); } catch (e) {}
	}

	// 6e.2 — Cycle the designated jammer victim through the union of
	// (active radar contacts) ∪ (RWR emitters). Tab uses this when the
	// EW JAMMER is the active weapon. Same Map-keyed flat-list pattern
	// as the HARM cycle, but the candidate pool is wider — you can jam
	// a unit you're tracking on radar even if they're not radiating
	// at you, and you can jam a unit lighting your RWR even if your
	// own radar hasn't acquired them.
	cycleDesignatedJamTarget(playerState, direction = 1) {
		if (!playerState) { this.designatedJamTarget = null; return; }
		const candidates = new Set();
		// Radar contacts (anything alive on a different team that the
		// player's radar is currently painting). iffStatus is consulted
		// so we don't accidentally jam our own datalink-fused friendlies.
		if (playerState.contacts) {
			for (const [tgt, c] of playerState.contacts) {
				if (!tgt || tgt.destroyed || tgt.active === false) continue;
				if (tgt.team && playerState.team && tgt.team === playerState.team) continue;
				if (c && c.iffStatus === 'friendly') continue;
				candidates.add(tgt);
			}
		}
		// RWR strobes (anyone painting us — they have a radar, so they
		// have something to be jammed). Filter by team-mismatch as
		// usual; identifyContact-style team comparison is enough here
		// because RWR entries always have a `source` reference.
		if (playerState.rwr) {
			for (const [src] of playerState.rwr) {
				if (!src || src.destroyed || src.active === false) continue;
				if (src.team && playerState.team && src.team === playerState.team) continue;
				candidates.add(src);
			}
		}
		if (candidates.size === 0) { this.designatedJamTarget = null; return; }
		const arr = [...candidates].sort((a, b) =>
			(a.name || '').toString().localeCompare((b.name || '').toString()));
		const idx = arr.indexOf(this.designatedJamTarget);
		const step = direction > 0 ? 1 : -1;
		const next = (idx + step + arr.length) % arr.length;
		this.designatedJamTarget = arr[idx < 0 ? 0 : next];
		try { soundManager.play('weapon-switch'); } catch (e) {}
	}

	// 6e.2 — Toggle the currently-designated jammer victim into / out
	// of the player's offensiveTargets set. Capacity is gated by the
	// pod's beamCount: a single-pod airframe can only sustain one
	// offensive beam at a time (oldest beam drops if you exceed it).
	// Returns the action taken so the keybind can toast the right
	// message.
	toggleOffensiveJam(playerState) {
		if (!playerState || !playerState.jammer) return 'no-pod';
		const j = playerState.jammer;
		const tgt = this.designatedJamTarget;
		if (!tgt) return 'no-target';
		if (j.offensiveTargets.has(tgt)) {
			j.offensiveTargets.delete(tgt);
			return 'off';
		}
		// Beam-count exclusion: real fighter-pod jammers can only do
		// one thing at a time. If we're at capacity, evict the oldest.
		// JS Set preserves insertion order, so the first iterator
		// value is the oldest entry.
		if (j.offensiveTargets.size >= (j.beamCount || 1)) {
			const oldest = j.offensiveTargets.values().next().value;
			if (oldest) j.offensiveTargets.delete(oldest);
		}
		j.offensiveTargets.add(tgt);
		return 'on';
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
