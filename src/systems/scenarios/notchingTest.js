// Notching Test — lab scenario for verifying the radar Doppler filter.
//
// One hostile bogey spawns at a fixed range (default 70 km) and flies a
// perfect circle at constant altitude. Because its heading sweeps through
// every aspect relative to the player over one lap, it passes through the
// radar notch (closing rate ≈ 0 m/s along the LOS) twice per orbit — once
// on each side. If the sensor system's Doppler filter is working, the
// bogey should drop off radar for a short arc at beam aspect and reappear
// when the closing rate comes back up.
//
// A DOM panel on the left side of the screen shows:
//   - Range to bogey
//   - Closing rate along LOS (m/s; negative = opening)
//   - Aspect angle (target nose vs LOS-from-target)
//   - Per-channel detection status (radar / IR / visual) + radar signal
//
// This makes it trivial to correlate a disappearing radar contact with the
// moment closing rate crosses the ~90 m/s notch threshold.

import * as Cesium from 'cesium';
import { SIGNATURES } from '../signatures.js';
import {
	FIGHTER_RADAR_DEFAULT,
	FIGHTER_IRST_DEFAULT,
	FIGHTER_EYEBALL_DEFAULT,
} from '../sensorSystem.js';

// ----- Scenario knobs -------------------------------------------------------
// Placed at the top for easy tweaking during calibration work.
const BOGEY_RANGE_M     = 70000;  // how far the orbit center is from player
const BOGEY_BEARING_DEG = 0;      // bearing (0 = due north) of orbit center
const BOGEY_ALT_M       = 8000;
const ORBIT_RADIUS_M    = 8000;   // radius of the bogey's circular flight path
const ORBIT_SPEED_MPS   = 280;    // tangential speed

// ----- Circling-pilot shim --------------------------------------------------
//
// The NPC's normal AI pilot is replaced with this minimal object. npcSystem
// reads .command every frame (targetHeading / targetPitch / throttle /
// boost / fire*), so that's all we need to expose. No sensors, no weapons,
// no behaviors — this bogey only has to fly its orbit.
function makeCirclingPilot(centerLon, centerLat, altitude) {
	const command = {
		targetHeading: 0,
		targetPitch: 0,
		throttle: 0.7,
		// npcSystem.update() lerps actual speed toward targetSpeed — pin it
		// so the orbit speed stays at ORBIT_SPEED_MPS instead of drifting to
		// the 300 m/s default cruise value.
		targetSpeed: ORBIT_SPEED_MPS,
		boost: false,
		fireFlare: false,
		fireWeapon: false,
	};
	return {
		command,
		subsystems: {},
		update(context /*, dt */) {
			const npc = context.unit;
			const plat = centerLat * Math.PI / 180;
			// East/north offset from orbit center to the aircraft.
			const dE = (npc.lon - centerLon) * 111320 * Math.cos(plat);
			const dN = (npc.lat - centerLat) * 111320;
			// Radial bearing, 0 = north, +east. Tangent (counterclockwise) =
			// radial + 90°, so the aircraft keeps orbiting the same center.
			const radialBearing = Math.atan2(dE, dN) * 180 / Math.PI;
			command.targetHeading = (radialBearing + 90 + 360) % 360;
			// Proportional altitude hold; clamped so the bogey doesn't try
			// to porpoise if it drifts off by a few hundred metres.
			const altErr = altitude - npc.alt;
			command.targetPitch = Math.max(-8, Math.min(8, altErr * 0.01));
			command.throttle = 0.7;
		},
	};
}

// ----- Readout panel --------------------------------------------------------
//
// DOM-driven so it survives re-renders cheaply. Styled inline to keep this
// file self-contained — the scenario system shouldn't have to bleed into
// the main stylesheet every time we add a lab panel.
function buildPanel() {
	const el = document.createElement('div');
	el.id = 'notching-panel';
	el.style.cssText = `
		position: fixed;
		left: 16px;
		top: 180px;
		width: 260px;
		padding: 10px 12px;
		background: rgba(0, 20, 25, 0.75);
		border: 1px solid rgba(0, 255, 180, 0.4);
		color: #a8ffe4;
		font-family: 'Courier New', monospace;
		font-size: 11px;
		line-height: 1.45;
		z-index: 50;
		pointer-events: none;
		letter-spacing: 0.5px;
	`;
	el.innerHTML = `
		<div style="color:#00ffb4;font-weight:bold;border-bottom:1px solid rgba(0,255,180,0.3);padding-bottom:4px;margin-bottom:6px;">
			NOTCHING TEST
		</div>
		<div id="ntp-range">RANGE     ––––</div>
		<div id="ntp-tgtlos">TGT·LOS   ––––</div>
		<div id="ntp-closing">CLOSING   ––––</div>
		<div id="ntp-aspect">ASPECT    ––––</div>
		<div id="ntp-bearing">BEARING   ––––</div>
		<div style="margin-top:6px;border-top:1px solid rgba(0,255,180,0.2);padding-top:4px;">
			<div id="ntp-radar">RADAR   ––</div>
			<div id="ntp-ir">IR      ––</div>
			<div id="ntp-visual">VISUAL  ––</div>
		</div>
		<div id="ntp-hint" style="margin-top:6px;color:#6fcbb0;font-size:10px;">
			notch when |TGT·LOS| &lt; 90 m/s<br>
			(target velocity projected on LOS)
		</div>
	`;
	document.body.appendChild(el);
	return el;
}

function fmt(v, unit = '', decimals = 0) {
	if (v == null || !Number.isFinite(v)) return '––';
	return v.toFixed(decimals) + unit;
}

function setChannelLine(el, label, detected, detail) {
	if (!el) return;
	const color = detected ? '#00ff88' : '#ff4466';
	const tag   = detected ? 'DET' : 'OUT';
	el.innerHTML = `<span style="color:${color};font-weight:bold;">${label.padEnd(7, ' ')} ${tag}</span>` +
		(detail ? `  <span style="color:#7fbfa8;">${detail}</span>` : '');
}

// ----- Scenario object ------------------------------------------------------

export const notchingTestScenario = {
	id: 'notching',
	name: 'Notching Test',
	description: 'Single distant bogey flies a perfect circle. Watch the radar drop at beam aspect.',

	onStart(ctx) {
		const { npcSystem, playerState } = ctx;
		npcSystem.autoSpawn = false;

		// Place the orbit center BOGEY_RANGE_M from the player on the given
		// bearing. The bogey itself starts on the near side of the circle.
		const plat = playerState.lat * Math.PI / 180;
		const bearingRad = BOGEY_BEARING_DEG * Math.PI / 180;
		const dE = BOGEY_RANGE_M * Math.sin(bearingRad);
		const dN = BOGEY_RANGE_M * Math.cos(bearingRad);
		const centerLon = playerState.lon + dE / (111320 * Math.cos(plat));
		const centerLat = playerState.lat + dN / 111320;

		// Start position: the near-side point of the orbit (closest to the
		// player), where a tangent heading points broadside to us. That
		// puts the bogey right at the notch the moment the scenario
		// starts, so "where's my radar return?" becomes the immediate
		// question.
		const startOffE = -ORBIT_RADIUS_M * Math.sin(bearingRad);
		const startOffN = -ORBIT_RADIUS_M * Math.cos(bearingRad);
		const startLon = centerLon + startOffE / (111320 * Math.cos(plat));
		const startLat = centerLat + startOffN / 111320;

		// Initial heading: tangent to the orbit, pointing in the direction
		// of counterclockwise motion.
		const radialBearing = Math.atan2(startOffE, startOffN) * 180 / Math.PI;
		const initialHeading = (radialBearing + 90 + 360) % 360;

		// Use npcSystem.createNPCMesh directly so we can override team /
		// pilot without fighting the triangle-spawn logic in spawnNPC().
		const npc = npcSystem.createNPCMesh(
			'BOGEY 01',
			startLon, startLat, BOGEY_ALT_M,
			initialHeading, ORBIT_SPEED_MPS,
			'hostile-red',
		);
		if (!npc) {
			// Model not loaded yet — retry next frame via update().
			this._retry = { ctx, centerLon, centerLat, initialHeading, startLon, startLat };
			return;
		}
		this._attachBogey(npc, centerLon, centerLat);
		this._panel = buildPanel();
	},

	_attachBogey(npc, centerLon, centerLat) {
		// Swap out the combat AI pilot for the circling shim. The bogey
		// should be a passive test target — no evasion, no firing.
		npc.pilot = makeCirclingPilot(centerLon, centerLat, BOGEY_ALT_M);
		// Give it a fighter signature explicitly so detection ranges match
		// the "reference 5 m² fighter" the radar docs assume.
		npc.signature = { ...SIGNATURES.fighter };
		npc.sensors = {
			radar:   { ...FIGHTER_RADAR_DEFAULT, active: false }, // no RWR pollution
			ir:      { ...FIGHTER_IRST_DEFAULT },
			eyeball: { ...FIGHTER_EYEBALL_DEFAULT },
		};
		this._bogey = npc;
		this._centerLon = centerLon;
		this._centerLat = centerLat;
	},

	update(ctx /*, dt */) {
		// Lazy spawn in case the model wasn't loaded during onStart.
		if (!this._bogey && this._retry) {
			const r = this._retry;
			const npc = ctx.npcSystem.createNPCMesh(
				'BOGEY 01',
				r.startLon, r.startLat, BOGEY_ALT_M,
				r.initialHeading, ORBIT_SPEED_MPS,
				'hostile-red',
			);
			if (npc) {
				this._attachBogey(npc, r.centerLon, r.centerLat);
				this._panel = buildPanel();
				this._retry = null;
			}
		}
		if (!this._bogey || !this._panel) return;
		const bogey = this._bogey;
		const player = ctx.playerState;

		// Geometry: LOS vector from player to bogey in ENU metres.
		const plat = player.lat * Math.PI / 180;
		const dE = (bogey.lon - player.lon) * 111320 * Math.cos(plat);
		const dN = (bogey.lat - player.lat) * 111320;
		const dU = bogey.alt - player.alt;
		const range = Math.hypot(dE, dN, dU);
		const losHat = range > 1 ? { x: dE / range, y: dN / range, z: dU / range } : { x: 0, y: 1, z: 0 };

		// Relative velocity in the world (ENU) frame. Both units carry
		// heading/pitch/speed, so reconstruct from those.
		const vOf = (u) => {
			const h = u.heading * Math.PI / 180;
			const p = (u.pitch || 0) * Math.PI / 180;
			const spd = u.speed || 0;
			return {
				x: Math.sin(h) * Math.cos(p) * spd,
				y: Math.cos(h) * Math.cos(p) * spd,
				z: Math.sin(p) * spd,
			};
		};
		const vP = vOf(player);
		const vB = vOf(bogey);
		const relE = vB.x - vP.x;
		const relN = vB.y - vP.y;
		const relU = vB.z - vP.z;
		// Closing rate positive = range decreasing. v_rel·LOS gives range
		// RATE (positive = opening), so flip the sign. Useful as context
		// but NOT the notch criterion.
		const rangeRate = relE * losHat.x + relN * losHat.y + relU * losHat.z;
		const closing = -rangeRate;

		// Actual notch criterion: target's own velocity projected onto LOS.
		// After main-lobe clutter cancellation on the radar this is the
		// residual Doppler shift of the target — when it approaches 0 the
		// target is indistinguishable from ground clutter and gets filtered
		// out. Flying perpendicular to the LOS (beaming) drives this to
		// zero regardless of either aircraft's speed.
		const tgtLosSpeed = vB.x * losHat.x + vB.y * losHat.y + vB.z * losHat.z;
		const tgtLosAbs   = Math.abs(tgtLosSpeed);

		// Aspect: angle between bogey's nose and the bogey-to-player vector.
		// 0° = nose-on to us (hot), 180° = tail-on (cold, pure beam ≈ 90°).
		const bogeyFwd = {
			x: Math.sin(bogey.heading * Math.PI / 180),
			y: Math.cos(bogey.heading * Math.PI / 180),
			z: 0,
		};
		const backLosHat = { x: -losHat.x, y: -losHat.y, z: -losHat.z };
		const aspectDot = Math.max(-1, Math.min(1,
			bogeyFwd.x * backLosHat.x + bogeyFwd.y * backLosHat.y + bogeyFwd.z * backLosHat.z));
		const aspectDeg = Math.acos(aspectDot) * 180 / Math.PI;

		// Body-frame bearing of the bogey from the player (for HUD parity).
		const pHead = player.heading * Math.PI / 180;
		const bearingBody = Math.atan2(
			Math.sin(pHead) * dN - Math.cos(pHead) * (-dE),
			Math.cos(pHead) * dN + Math.sin(pHead) * dE,
		) * 180 / Math.PI;

		// What did the sensor system actually see this frame? We read the
		// player's contact on the bogey; any channel present means detected.
		let radar = null, ir = null, vis = null;
		if (player.contacts) {
			const c = player.contacts.get(bogey);
			if (c) { radar = c.radar; ir = c.ir; vis = c.visual; }
		}

		// Push everything to the panel.
		const p = this._panel;
		p.querySelector('#ntp-range').textContent  = `RANGE     ${fmt(range / 1000, ' km', 1)}`;
		const notched = tgtLosAbs < 90;
		const tgtLosEl = p.querySelector('#ntp-tgtlos');
		tgtLosEl.textContent =
			`TGT·LOS   ${fmt(tgtLosSpeed, ' m/s', 0)}${notched ? '  ← NOTCH' : ''}`;
		tgtLosEl.style.color = notched ? '#ff4466' : '#a8ffe4';
		p.querySelector('#ntp-closing').textContent = `CLOSING   ${fmt(closing, ' m/s', 0)}`;
		p.querySelector('#ntp-aspect').textContent  = `ASPECT    ${fmt(aspectDeg, '°', 0)}`;
		p.querySelector('#ntp-bearing').textContent = `BEARING   ${fmt(bearingBody, '°', 0)}`;
		setChannelLine(p.querySelector('#ntp-radar'), 'RADAR',
			!!radar, radar ? `sig ${(radar.signal * 100).toFixed(0)}%` : '');
		setChannelLine(p.querySelector('#ntp-ir'), 'IR',
			!!ir, ir ? `sig ${(ir.signal * 100).toFixed(0)}%` : '');
		setChannelLine(p.querySelector('#ntp-visual'), 'VISUAL',
			!!vis, vis ? `${(vis.apparentSize * 1000).toFixed(2)} mrad` : '');
	},

	onStop(ctx) {
		if (this._panel && this._panel.parentNode) {
			this._panel.parentNode.removeChild(this._panel);
		}
		this._panel = null;
		this._bogey = null;
		this._retry = null;
		ctx.npcSystem.autoSpawn = true;
	},
};
