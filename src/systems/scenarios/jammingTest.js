// Jamming Test — lab scenario for verifying the EW jammer subsystem.
//
// Two hostile bogeys fly a slow co-orbit ~60 km from the player. One
// carries a jammer pod that toggles ON / OFF every 10 seconds; the
// other is a plain bogey flying within the jammer's main-lobe corridor
// from the player's POV. When the jammer is ON the player's radar
// should drop both contacts (range cut + below detection threshold);
// when OFF both reappear. A live panel shows toggle countdown,
// attenuation factor, jammer LOS range, burn-through state, and
// per-bogey detection status.
//
// Sister scenario to notching-test: same panel pattern, same passive
// circling-pilot shim. Adding a jammer test instead of more sensor-
// state cases because jam attenuation cuts in BEFORE the notch / FOV
// gates and we want to see that isolated.

import * as Cesium from 'cesium';
import { SIGNATURES } from '../signatures.js';
import {
	FIGHTER_RADAR_DEFAULT,
	FIGHTER_IRST_DEFAULT,
	FIGHTER_EYEBALL_DEFAULT,
} from '../sensorSystem.js';
import { createJammer, accumulateJamAttenuation } from '../ew/jammerSubsystem.js';

// ----- Scenario knobs -------------------------------------------------------
const ORBIT_CENTER_RANGE_M = 50000;
const ORBIT_CENTER_BEARING_DEG = 0;
const BOGEY_ALT_M     = 8000;
// Tight orbit so the bogeys stay inside the realistic ~3° main-lobe
// corridor (±1.3 km cross-range at 50 km). With a 600 m orbit, B02 sits
// ≈850 m off the bearing line from B01 — comfortably inside the blind
// corridor when B01 is jamming.
const ORBIT_RADIUS_M  = 600;
const ORBIT_SPEED_MPS = 180;
const TOGGLE_INTERVAL_S = 10.0;
// Jammer config — strong + wide to make the effect obvious in lab use.
// attFloor: 0.15 = ~85% range cut. A reference fighter's nominal radar
// range is 150 km; against a fighter at the test orbit (~50 km) this
// drops effective detection to ~22 km — well below the bogey distance,
// so both bogeys vanish unambiguously when the jammer is on. The
// design-doc value of 0.4 (~60% cut) is realistic for offensive beam
// jamming at distance, but for the lab test we want the on/off
// behaviour to be unmistakable.
const JAMMER_SPEC = {
	type: 'radar',
	power: 100000,
	beamCount: 1,
	coneHalfDeg: 60,
	burnThroughRangeM: 8000,
	attFloor: 0.15,
	maxEffectRangeM: 80000,
};

// ----- Circling pilot (copied from notchingTest, simplified) ---------------
function makeCirclingPilot(centerLon, centerLat, altitude, phaseDeg) {
	const command = {
		targetHeading: 0, targetPitch: 0,
		throttle: 0.6, targetSpeed: ORBIT_SPEED_MPS,
		boost: false, fireFlare: false, fireWeapon: false,
	};
	return {
		command,
		subsystems: {},
		update(context /*, dt */) {
			const npc = context.unit;
			const plat = centerLat * Math.PI / 180;
			const dE = (npc.lon - centerLon) * 111320 * Math.cos(plat);
			const dN = (npc.lat - centerLat) * 111320;
			const radialBearing = Math.atan2(dE, dN) * 180 / Math.PI;
			// Tangent heading for counterclockwise orbit. phaseDeg is unused
			// at runtime — only the spawn phase used it — but kept on the
			// signature as a doc note for callers.
			void phaseDeg;
			command.targetHeading = (radialBearing + 90 + 360) % 360;
			const altErr = altitude - npc.alt;
			command.targetPitch = Math.max(-8, Math.min(8, altErr * 0.01));
			command.throttle = 0.6;
		},
	};
}

// ----- Readout panel --------------------------------------------------------
function buildPanel() {
	const el = document.createElement('div');
	el.id = 'jamming-panel';
	el.style.cssText = `
		position: fixed;
		left: 16px;
		top: 180px;
		width: 280px;
		padding: 10px 12px;
		background: rgba(25, 12, 0, 0.78);
		border: 1px solid rgba(255, 140, 80, 0.5);
		color: #ffd0a8;
		font-family: 'Courier New', monospace;
		font-size: 11px;
		line-height: 1.45;
		z-index: 50;
		pointer-events: none;
		letter-spacing: 0.5px;
	`;
	el.innerHTML = `
		<div style="color:#ff9050;font-weight:bold;border-bottom:1px solid rgba(255,140,80,0.4);padding-bottom:4px;margin-bottom:6px;">
			JAMMING TEST
		</div>
		<div id="jtp-state">JAMMER    ––</div>
		<div id="jtp-toggle">TOGGLE IN ––</div>
		<div id="jtp-range">JAM RANGE ––</div>
		<div id="jtp-att">ATTEN     ––</div>
		<div id="jtp-burn">BURNTHRU  ––</div>
		<div style="margin-top:6px;border-top:1px solid rgba(255,140,80,0.25);padding-top:4px;">
			<div id="jtp-bog1">BOGEY 1   ––</div>
			<div id="jtp-bog2">BOGEY 2   ––</div>
		</div>
		<div id="jtp-hint" style="margin-top:6px;color:#bf8470;font-size:10px;">
			BOGEY 1 carries the jammer.<br>
			BOGEY 2 sits 5 km away, no pod.<br>
			Both should vanish when JAM = ON.
		</div>
	`;
	document.body.appendChild(el);
	return el;
}

function fmt(v, unit = '', d = 0) {
	if (v == null || !Number.isFinite(v)) return '––';
	return v.toFixed(d) + unit;
}

function setBogeyLine(el, label, hasContact, signal) {
	if (!el) return;
	const color = hasContact ? '#00ff88' : '#ff4466';
	const tag   = hasContact ? 'DET' : 'OUT';
	el.innerHTML = `<span style="color:${color};font-weight:bold;">${label.padEnd(9, ' ')} ${tag}</span>` +
		(hasContact && signal != null ? `  <span style="color:#bf8470;">sig ${(signal*100).toFixed(0)}%</span>` : '');
}

// ----- Scenario object ------------------------------------------------------

export const jammingTestScenario = {
	id: 'jamming',
	name: 'Jamming Test',
	description: 'Two bogeys orbit 60 km out; one carries a jammer that toggles on/off every 10 s. Both should vanish from radar while jamming is active.',

	onStart(ctx) {
		const { npcSystem, playerState } = ctx;
		npcSystem.autoSpawn = false;

		const plat = playerState.lat * Math.PI / 180;
		const bRad = ORBIT_CENTER_BEARING_DEG * Math.PI / 180;
		const dE = ORBIT_CENTER_RANGE_M * Math.sin(bRad);
		const dN = ORBIT_CENTER_RANGE_M * Math.cos(bRad);
		const centerLon = playerState.lon + dE / (111320 * Math.cos(plat));
		const centerLat = playerState.lat + dN / 111320;

		// BOGEY 1 spawns on the near side of the orbit (closest to the
		// player). BOGEY 2 starts 90° around the orbit so they're a few
		// km apart but well inside the same main-lobe corridor from the
		// player's POV.
		const spawnAt = (offE, offN, headingDeg) => {
			const lon = centerLon + offE / (111320 * Math.cos(plat));
			const lat = centerLat + offN / 111320;
			return { lon, lat, headingDeg };
		};
		const offE1 = -ORBIT_RADIUS_M * Math.sin(bRad);
		const offN1 = -ORBIT_RADIUS_M * Math.cos(bRad);
		const offE2 = -ORBIT_RADIUS_M * Math.sin(bRad + Math.PI / 4);
		const offN2 = -ORBIT_RADIUS_M * Math.cos(bRad + Math.PI / 4);
		const radialBearing = (offE, offN) => Math.atan2(offE, offN) * 180 / Math.PI;
		const heading1 = (radialBearing(offE1, offN1) + 90 + 360) % 360;
		const heading2 = (radialBearing(offE2, offN2) + 90 + 360) % 360;
		const p1 = spawnAt(offE1, offN1, heading1);
		const p2 = spawnAt(offE2, offN2, heading2);

		this._spec = {
			centerLon, centerLat,
			p1, p2,
		};
		this._toggleTimer = TOGGLE_INTERVAL_S;
		this._jamOn = true;
		this._panel = buildPanel();
		this._tryAttach(ctx);
	},

	_tryAttach(ctx) {
		if (this._bog1 && this._bog2) return;
		const sp = this._spec;
		if (!this._bog1) {
			const npc = ctx.npcSystem.createNPCMesh(
				'BOGEY 01',
				sp.p1.lon, sp.p1.lat, BOGEY_ALT_M,
				sp.p1.headingDeg, ORBIT_SPEED_MPS,
				'hostile-red',
			);
			if (npc) this._attachBogey(npc, 1);
		}
		if (!this._bog2) {
			const npc = ctx.npcSystem.createNPCMesh(
				'BOGEY 02',
				sp.p2.lon, sp.p2.lat, BOGEY_ALT_M,
				sp.p2.headingDeg, ORBIT_SPEED_MPS,
				'hostile-red',
			);
			if (npc) this._attachBogey(npc, 2);
		}
	},

	_attachBogey(npc, idx) {
		const sp = this._spec;
		// Mirror notchingTest: passive circling pilot, no firing, radar
		// off so the player's RWR isn't lit up by the lab targets.
		npc.pilot = makeCirclingPilot(sp.centerLon, sp.centerLat, BOGEY_ALT_M, idx * 90);
		npc.signature = { ...SIGNATURES.fighter };
		npc.sensors = {
			radar:   { ...FIGHTER_RADAR_DEFAULT, active: false },
			ir:      { ...FIGHTER_IRST_DEFAULT },
			eyeball: { ...FIGHTER_EYEBALL_DEFAULT },
		};
		if (idx === 1) {
			// Bogey 1 is the jammer carrier. Defensive on by default —
			// the toggle in update() flips this every TOGGLE_INTERVAL_S.
			npc.jammer = createJammer(JAMMER_SPEC);
			npc.jammer.defensiveOn = true;
			this._bog1 = npc;
		} else {
			this._bog2 = npc;
		}
	},

	update(ctx, dt) {
		this._tryAttach(ctx);
		if (!this._bog1 || !this._bog2 || !this._panel) return;

		// Toggle the jammer every TOGGLE_INTERVAL_S.
		this._toggleTimer -= dt;
		if (this._toggleTimer <= 0) {
			this._jamOn = !this._jamOn;
			this._bog1.jammer.defensiveOn = this._jamOn;
			this._toggleTimer = TOGGLE_INTERVAL_S;
		}

		const player = ctx.playerState;

		// Attenuation that detectRadar() is currently applying for the
		// observer→bog2 pair (proxy for "how much is the corridor noise
		// hurting bog2's detection").
		const att2 = accumulateJamAttenuation(player, this._bog2);
		const att1 = accumulateJamAttenuation(player, this._bog1);

		// Jam range = LOS distance to bogey 1 (the carrier).
		const plat = player.lat * Math.PI / 180;
		const dE = (this._bog1.lon - player.lon) * 111320 * Math.cos(plat);
		const dN = (this._bog1.lat - player.lat) * 111320;
		const dU = this._bog1.alt - player.alt;
		const range = Math.hypot(dE, dN, dU);
		const burn  = range <= JAMMER_SPEC.burnThroughRangeM;

		const c1 = player.contacts ? player.contacts.get(this._bog1) : null;
		const c2 = player.contacts ? player.contacts.get(this._bog2) : null;

		const p = this._panel;
		const stateColor = this._jamOn ? '#ff7030' : '#888';
		p.querySelector('#jtp-state').innerHTML =
			`JAMMER    <span style="color:${stateColor};font-weight:bold;">${this._jamOn ? 'ON' : 'OFF'}</span>`;
		p.querySelector('#jtp-toggle').textContent =
			`TOGGLE IN ${fmt(Math.max(0, this._toggleTimer), ' s', 1)}`;
		p.querySelector('#jtp-range').textContent =
			`JAM RANGE ${fmt(range / 1000, ' km', 1)}`;
		p.querySelector('#jtp-att').textContent =
			`ATTEN     bog1=${(att1*100).toFixed(0)}%  bog2=${(att2*100).toFixed(0)}%`;
		p.querySelector('#jtp-burn').innerHTML =
			`BURNTHRU  <span style="color:${burn ? '#00ff88' : '#bf8470'};">${burn ? 'YES' : 'NO'}</span>`;
		setBogeyLine(p.querySelector('#jtp-bog1'), 'BOGEY 1*',
			!!(c1 && c1.radar), c1 && c1.radar ? c1.radar.signal : null);
		setBogeyLine(p.querySelector('#jtp-bog2'), 'BOGEY 2',
			!!(c2 && c2.radar), c2 && c2.radar ? c2.radar.signal : null);
	},

	onStop(ctx) {
		if (this._panel && this._panel.parentNode) {
			this._panel.parentNode.removeChild(this._panel);
		}
		this._panel = null;
		this._bog1 = null;
		this._bog2 = null;
		this._spec = null;
		ctx.npcSystem.autoSpawn = true;
	},
};

// Suppress unused-import warning — we keep Cesium imported for parity
// with the sister scenario in case future telemetry needs ECEF math.
void Cesium;
