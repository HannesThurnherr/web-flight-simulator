import * as Cesium from 'cesium';
import { LaserBeam } from '../weapon/laserBeam.js';
import { isTerrainBlocked } from './sensorSystem.js';
import { particles } from '../utils/particles.js';
import { pushKill } from './eventLog.js';
import { soundManager } from '../utils/soundManager.js';

// ============================================================================
// Directed-energy point defense (NFAC.4).
//
// A LaserPDSubsystem rides on a ground platform (or, later, an NFAC fighter)
// and soft-kills inbound *subsonic* munitions — cruise missiles, glide bombs,
// and slow drones. It is deliberately useless against hypersonics (too fast to
// pre-compensate lead through the boundary layer), which is what makes the
// textbook counter "saturate the laser with cheap subsonic decoys, then send a
// hypersonic finisher behind them."
//
// Power model — capacitor brownout (Nuclear Option's EW-25 Medusa model):
//   * The weapon draws from a capacitor (0..1). Lasing drains it; idle time
//     recharges it.
//   * Below `brownout` charge, BOTH output and drain fall off linearly with
//     charge. So a near-empty capacitor produces a weak, slow-burning beam
//     that drains slowly — you brown out gracefully rather than cutting off.
//   * The search radar competes for the same capacitor: while it radiates,
//     recharge is taxed. Turning the radar off lets the laser recover faster.
//
// Kill model — dwell-to-burn:
//   * Each engaged munition accumulates heat while the beam holds LOS on it.
//     Heat builds at a rate scaled by output factor and (mildly) by range.
//   * At heat >= 1 the munition is destroyed (soft kill: guidance dies and the
//     airframe breaks up). Reference dwell ~`dwellSecToKill` at full power; a
//     small drone burns faster, a hardened cruise body slower.
//   * One target at a time. Saturate by sending more inbound than the laser
//     can sequence through within their flight time.
// ============================================================================

let _scene = null;
let _viewer = null;

export function initLaserPD(scene, viewer) {
	_scene = scene;
	_viewer = viewer;
}

// Munition classes a DEW point-defense will engage. Aircraft are excluded by
// doctrine (inadvisable / out of envelope); AAMs (unitClass 'missile') and
// hypersonics are excluded as too fast.
const ENGAGEABLE_CLASSES = new Set(['cruise_missile', 'bomb', 'drone_isr', 'decoy']);

// Per-class relative time-to-burn. A thin drone skin burns fast; a cruise
// missile body is the reference; a glide bomb is small and quick.
const CLASS_DWELL_MULT = {
	cruise_missile: 1.0,
	bomb: 0.7,
	drone_isr: 0.5,
	decoy: 0.5,
};

// Above this ground speed a munition is treated as un-engageable (hypersonic /
// fast AAM): the laser cannot hold a burn spot long enough. ~Mach 2.6.
const MAX_ENGAGE_SPEED_MS = 900;

const M_PER_DEG_LAT = 111320;

export class LaserPDSubsystem {
	constructor(params = {}) {
		this.maxRangeM   = params.maxRangeM   ?? 9000;
		this.minRangeM   = params.minRangeM   ?? 150;
		this.dwellSecToKill = params.dwellSecToKill ?? 2.5;
		this.capDrainS   = params.capDrainS   ?? 5.0;   // s of full-power lasing to empty
		this.capRechargeS = params.capRechargeS ?? 8.0; // s to recharge 0→1 (radar off)
		this.brownout    = params.brownout    ?? 0.7;   // below this, output falls off
		this.coolPerSec  = params.coolPerSec  ?? 0.35;  // target heat decay when not lased
		this.emitterHeightM = params.emitterHeightM ?? 4.0;
		this.radarRechargeTax = params.radarRechargeTax ?? 0.5; // recharge × this if radar on

		// Which munition classes this emitter will engage, and the speed
		// ceiling above which a target is un-burnable (hypersonics, and on a
		// ground site also fast AAMs). A fighter self-protect pod overrides
		// these to add 'missile' and a higher ceiling for last-ditch APS.
		this.engageClasses = new Set(params.engageClasses || [...ENGAGEABLE_CLASSES]);
		this.maxEngageSpeedMs = params.maxEngageSpeedMs ?? MAX_ENGAGE_SPEED_MS;

		this.capacitor = 1.0;
		this.beam = null;
		this.currentTarget = null;
	}

	_outputFactor() {
		// Brownout: full output above the knee, linear down to 0 at empty.
		return this.capacitor >= this.brownout ? 1.0 : Math.max(0, this.capacitor / this.brownout);
	}

	_enuRange(unit, p) {
		const cosLat = Math.cos(unit.lat * Math.PI / 180);
		const dE = (p.lon - unit.lon) * M_PER_DEG_LAT * cosLat;
		const dN = (p.lat - unit.lat) * M_PER_DEG_LAT;
		const dU = (p.alt - unit.alt);
		return Math.sqrt(dE * dE + dN * dN + dU * dU);
	}

	_engageable(unit, p) {
		if (!p || p.destroyed || p.active === false) return false;
		if (p.team && unit.team && p.team === unit.team) return false; // friendly
		const sig = p.signature;
		const cls = (sig && sig.unitClass) || (p.data && p.data.signature);
		if (!this.engageClasses.has(cls)) return false;
		if ((p.speed || 0) > this.maxEngageSpeedMs) return false; // hypersonic / too fast
		const range = this._enuRange(unit, p);
		if (range < this.minRangeM || range > this.maxRangeM) return false;
		return true;
	}

	// Pick the most imminent engageable threat (smallest range), with LOS.
	_acquire(unit, projectiles) {
		let best = null, bestRange = Infinity;
		const emitter = this._emitterCart(unit);
		for (const p of projectiles) {
			if (!this._engageable(unit, p)) continue;
			const range = this._enuRange(unit, p);
			if (range >= bestRange) continue;
			const tgtCart = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.alt);
			if (isTerrainBlocked(emitter, tgtCart)) continue; // beam can't pass through hills
			best = p; bestRange = range;
		}
		return best;
	}

	_emitterCart(unit) {
		return Cesium.Cartesian3.fromDegrees(unit.lon, unit.lat, unit.alt + this.emitterHeightM);
	}

	update(unit, projectiles, dt) {
		if (!unit || dt <= 0) return;

		// Validate / (re)acquire a target. Stay on the current one until it
		// dies, leaves the envelope, or LOS breaks.
		let target = this.currentTarget;
		if (!target || !this._engageable(unit, target)) {
			target = this._acquire(unit, projectiles || []);
			this.currentTarget = target;
		} else {
			const emitter = this._emitterCart(unit);
			const tgtCart = Cesium.Cartesian3.fromDegrees(target.lon, target.lat, target.alt);
			if (isTerrainBlocked(emitter, tgtCart)) { target = null; this.currentTarget = null; }
		}

		const radarOn = !!(unit.sensors && unit.sensors.radar && unit.sensors.radar.active);
		const lasing = !!target && this.capacitor > 0.02;

		if (lasing) {
			const output = this._outputFactor();
			// Drain scales with output (browned-out beam sips power).
			this.capacitor = Math.max(0, this.capacitor - dt * output / this.capDrainS);

			// Burn-through. Range effectiveness: near targets burn a touch
			// faster; clamp so the far edge of the envelope still works.
			const range = this._enuRange(unit, target);
			// Mild range falloff so the kill time stays close to dwellSecToKill
			// across the envelope (predictable ~N-second burn) rather than
			// finishing far faster up close.
			const rangeEff = Math.max(0.85, 1.0 - 0.15 * (range / this.maxRangeM));
			const cls = (target.signature && target.signature.unitClass) || 'cruise_missile';
			const dwellNeeded = this.dwellSecToKill * (CLASS_DWELL_MULT[cls] ?? 1.0);
			target._laserHeat = (target._laserHeat || 0) + dt * output * rangeEff / dwellNeeded;

			// Render the beam emitter→target, dimmed by output factor. The
			// beam only exists once the THREE scene/viewer are initialized;
			// the engagement logic still runs (and kills) without it.
			this._ensureBeam();
			if (this.beam) {
				this.beam.update(
					{ lon: unit.lon, lat: unit.lat, alt: unit.alt + this.emitterHeightM },
					{ lon: target.lon, lat: target.lat, alt: target.alt },
					output,
					Math.min(1, target._laserHeat),
				);
			}

			if (target._laserHeat >= 1) {
				this._burnThrough(unit, target);
				this.currentTarget = null;
				if (this.beam) this.beam.hide();
			}
		} else {
			if (this.beam) this.beam.hide();
			// Recharge while idle; radar competes for the capacitor.
			const rate = (1 / this.capRechargeS) * (radarOn ? this.radarRechargeTax : 1.0);
			this.capacitor = Math.min(1, this.capacitor + dt * rate);
		}

		// Cool down any munition we're no longer burning (heat leaks away).
		for (const p of projectiles || []) {
			if (p === target) continue;
			if (p._laserHeat > 0) p._laserHeat = Math.max(0, p._laserHeat - dt * this.coolPerSec);
		}
	}

	_ensureBeam() {
		if (!this.beam && _scene && _viewer) this.beam = new LaserBeam(_scene, _viewer);
	}

	_burnThrough(unit, target) {
		pushKill({
			shooter: unit,
			target,
			weapon: 'LASER',
			at: performance.now() * 0.001,
			reason: 'laser-kill',
		});
		target.destroyed = true;
		if ('active' in target) target.active = false;
		target._laserHeat = 0;
		try {
			particles.spawnExplosion(target.lon, target.lat, target.alt, { count: 30, smokeCount: 6, big: false });
			particles.spawnSpark(target.lon, target.lat, target.alt, { count: 14 });
			try { soundManager.play('explosion-random'); } catch (e) { /* no-op */ }
		} catch (e) { /* no-op */ }
	}

	destroy() {
		if (this.beam) { this.beam.destroy(); this.beam = null; }
	}
}
