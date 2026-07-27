// ============================================================================
// Cockpit HUD — the head-up display combiner glass and its projected
// symbology.
//
// The combiner is a tilted glass plate above the glareshield; symbology is
// a CanvasTexture on an additive-blended plane a few mm in front of it.
// The canvas is calibrated in PIXELS PER DEGREE against the glass's real
// angular size from the design eye point, so the pitch ladder genuinely
// overlays the outside horizon and the flight-path marker really points
// where the jet is going — this is drawn from the same velocityENU state
// the physics integrates, not a cosmetic approximation.
//
// Everything is drawn in the AIRFRAME frame (the glass is bolted to the
// jet): pitch ladder translates by pitch and rotates by -roll about the
// boresight; the FPM and TD box are ENU vectors rotated into body axes.
// ============================================================================

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const PX = 512;                       // canvas resolution
const GLASS_W = 0.27;                 // meters
const GLASS_CY = -0.055;              // glass center height (eye = 0)
const GLASS_Z = -0.64;                // combiner distance
// Angular height of the glass in the COCKPIT render pass (fixed 75° FOV).
const GLASS_ANG_DEG = 2 * Math.atan((GLASS_W / 2) / Math.abs(GLASS_Z)) * 180 / Math.PI;
// Boresight (0° az / 0° el = straight ahead) in canvas coords: the glass
// center sits below eye level, so boresight lands above canvas center.
const BS_X = PX / 2;
const BS_Y = PX / 2 - (0 - GLASS_CY) / GLASS_W * PX;

const HUD_GREEN = '#4dff85';
const HUD_DIM   = 'rgba(77,255,133,0.55)';

const D2R = Math.PI / 180;

// ---------------------------------------------------------------------------
// ENU → body-frame az/el (deg) given heading/pitch/roll in degrees.
// Returns null if the vector is behind the aircraft.
// ---------------------------------------------------------------------------
function enuToBodyAngles(vE, vN, vU, headingDeg, pitchDeg, rollDeg) {
	const h = headingDeg * D2R, p = pitchDeg * D2R, r = rollDeg * D2R;
	// Body axes in ENU.
	const fE = Math.sin(h) * Math.cos(p), fN = Math.cos(h) * Math.cos(p), fU = Math.sin(p);
	let rtE = Math.cos(h), rtN = -Math.sin(h), rtU = 0;
	// upNoRoll = rt × f
	let upE = rtN * fU - rtU * fN;
	let upN = rtU * fE - rtE * fU;
	let upU = rtE * fN - rtN * fE;
	// Apply roll about the forward axis.
	const cr = Math.cos(r), sr = Math.sin(r);
	const rE = rtE * cr + upE * sr, rN = rtN * cr + upN * sr, rU = rtU * cr + upU * sr;
	const uE = upE * cr - rtE * sr, uN = upN * cr - rtN * sr, uU = upU * cr - rtU * sr;

	const len = Math.hypot(vE, vN, vU);
	if (len < 1e-6) return null;
	const df = (vE * fE + vN * fN + vU * fU) / len;
	const dr = (vE * rE + vN * rN + vU * rU) / len;
	const du = (vE * uE + vN * uN + vU * uU) / len;
	if (df <= 0.02) return null;      // behind / abeam — off the glass anyway
	return {
		az: Math.atan2(dr, df) / D2R,
		el: Math.atan2(du, Math.hypot(df, dr)) / D2R,
	};
}

// ---------------------------------------------------------------------------
// Symbology painter
//
// `PPD` (pixels per degree) arrives per-frame: the world renders at
// Cesium's fovy while the pit renders at a fixed 75°, so canvas pixels
// per WORLD degree = (PX / GLASS_ANG_DEG) · (75 / worldFov). With that
// scaling the ladder's horizon genuinely tracks the terrain horizon.
// ---------------------------------------------------------------------------
function drawSymbology(g, state, dtClock, PPD) {
	g.clearRect(0, 0, PX, PX);
	g.strokeStyle = HUD_GREEN;
	g.fillStyle = HUD_GREEN;
	g.lineWidth = 2.4;
	g.shadowColor = 'rgba(77,255,133,0.6)';
	g.shadowBlur = 3;
	g.font = '700 21px "Courier New", monospace';
	g.textBaseline = 'middle';

	const pitch = state.pitch || 0;
	const roll  = state.roll || 0;
	const hdg   = ((state.heading || 0) % 360 + 360) % 360;
	const spdKmh = (state.speed || 0) * 3.6;
	const mach = (state.speed || 0) / 300;

	// ---- Heading tape (top) ------------------------------------------------
	{
		const ty = 34, halfWin = 16;    // ±16° window
		const pxPerHdgDeg = 13;
		g.save();
		g.beginPath();
		g.rect(BS_X - halfWin * pxPerHdgDeg, 6, halfWin * 2 * pxPerHdgDeg, 52);
		g.clip();
		const start = Math.floor((hdg - halfWin) / 5) * 5;
		for (let d = start; d <= hdg + halfWin; d += 5) {
			const x = BS_X + (d - hdg) * pxPerHdgDeg;
			const major = ((d % 360) + 360) % 360 % 10 === 0;
			g.beginPath();
			g.moveTo(x, ty + 8);
			g.lineTo(x, ty + (major ? 0 : 4));
			g.stroke();
			if (major) {
				const lbl = String((((d % 360) + 360) % 360) / 10).padStart(2, '0');
				g.textAlign = 'center';
				g.fillText(lbl, x, ty - 10);
			}
		}
		g.restore();
		// Caret + digital heading box.
		g.beginPath();
		g.moveTo(BS_X - 6, ty + 18); g.lineTo(BS_X, ty + 10); g.lineTo(BS_X + 6, ty + 18);
		g.stroke();
		g.strokeRect(BS_X - 26, ty + 22, 52, 24);
		g.textAlign = 'center';
		g.fillText(String(Math.round(hdg)).padStart(3, '0'), BS_X, ty + 35);
	}

	// ---- Speed / altitude boxes ---------------------------------------------
	{
		const y = BS_Y + 8;
		g.textAlign = 'right';
		g.strokeRect(28, y - 16, 92, 32);
		g.fillText(String(Math.round(spdKmh)), 112, y + 1);
		g.textAlign = 'left';
		g.font = '700 16px "Courier New", monospace';
		g.fillText(`M ${mach.toFixed(2)}`, 30, y + 34);
		g.fillText(`G ${(state.loadFactor || 1).toFixed(1)}`, 30, y + 54);
		if (state.alpha !== undefined) {
			g.fillText(`a ${(state.alpha || 0).toFixed(1)}`, 30, y + 74);
		}
		g.font = '700 21px "Courier New", monospace';

		g.strokeRect(PX - 132, y - 16, 104, 32);
		g.fillText(String(Math.round(Math.max(0, state.alt || 0))), PX - 128, y + 1);
		g.font = '700 16px "Courier New", monospace';
		const vv = Math.round(state.verticalSpeed || 0);
		g.fillText(`VV ${vv >= 0 ? '+' : ''}${vv}`, PX - 128, y + 34);
		g.font = '700 21px "Courier New", monospace';
	}

	// ---- Pitch ladder (rotated by -roll about boresight) ----------------------
	{
		g.save();
		g.beginPath();
		g.rect(BS_X - 190, BS_Y - 150, 380, 330);
		g.clip();
		g.translate(BS_X, BS_Y);
		g.rotate(-roll * D2R);
		g.lineWidth = 2.2;
		for (let p = -90; p <= 90; p += 5) {
			const y = (pitch - p) * PPD;
			if (Math.abs(y) > 190) continue;
			if (p === 0) {
				// Horizon: long bars with a center gap.
				g.beginPath();
				g.moveTo(-210, y); g.lineTo(-38, y);
				g.moveTo(38, y); g.lineTo(210, y);
				g.stroke();
			} else {
				const w = 74, gap = 34;
				const dash = p < 0;
				g.setLineDash(dash ? [10, 7] : []);
				// Rung tips bend toward the horizon.
				const tip = p > 0 ? 8 : -8;
				for (const s of [-1, 1]) {
					g.beginPath();
					g.moveTo(s * gap, y);
					g.lineTo(s * (gap + w), y);
					g.lineTo(s * (gap + w), y + tip);
					g.stroke();
				}
				g.setLineDash([]);
				if (p % 10 === 0) {
					g.font = '700 15px "Courier New", monospace';
					g.textAlign = 'left';
					g.fillText(String(Math.abs(p)), gap + w + 6, y + tip / 2);
					g.textAlign = 'right';
					g.fillText(String(Math.abs(p)), -(gap + w + 6), y + tip / 2);
				}
			}
		}
		g.restore();
		g.font = '700 21px "Courier New", monospace';
	}

	// ---- Boresight cross ---------------------------------------------------------
	g.lineWidth = 2;
	g.beginPath();
	g.moveTo(BS_X - 7, BS_Y); g.lineTo(BS_X + 7, BS_Y);
	g.moveTo(BS_X, BS_Y - 5); g.lineTo(BS_X, BS_Y + 5);
	g.stroke();

	// ---- Flight-path marker ---------------------------------------------------
	{
		const ang = enuToBodyAngles(
			state.velocityE || 0, state.velocityN || 0, state.verticalSpeed || 0,
			state.heading || 0, pitch, roll,
		);
		if (ang && (state.speed || 0) > 15) {
			const x = BS_X + Math.max(-170, Math.min(170, ang.az * PPD));
			const y = BS_Y - Math.max(-140, Math.min(200, ang.el * PPD));
			g.lineWidth = 2.6;
			g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.stroke();
			g.beginPath();
			g.moveTo(x - 22, y); g.lineTo(x - 9, y);
			g.moveTo(x + 9, y);  g.lineTo(x + 22, y);
			g.moveTo(x, y - 9);  g.lineTo(x, y - 17);
			g.stroke();
		}
	}

	// ---- Target-designator box -----------------------------------------------------
	{
		const ws = state.weaponSystem;
		const tgt = ws && ws.designatedTarget;
		if (tgt && !tgt.destroyed && typeof tgt.lon === 'number') {
			const toRad = D2R;
			const dE = (tgt.lon - state.lon) * toRad * Math.cos(state.lat * toRad) * 6371000;
			const dN = (tgt.lat - state.lat) * toRad * 6371000;
			const dU = (tgt.alt || 0) - (state.alt || 0);
			const rngKm = Math.hypot(dE, dN, dU) / 1000;
			const ang = enuToBodyAngles(dE, dN, dU, state.heading || 0, pitch, roll);
			if (ang) {
				const inX = Math.abs(ang.az) * PPD < 175;
				const inY = ang.el * PPD > -145 && ang.el * PPD < 205;
				const x = BS_X + Math.max(-175, Math.min(175, ang.az * PPD));
				const y = BS_Y - Math.max(-145, Math.min(205, ang.el * PPD));
				g.lineWidth = 2.4;
				g.setLineDash(inX && inY ? [] : [6, 6]);
				g.strokeRect(x - 13, y - 13, 26, 26);
				g.setLineDash([]);
				g.font = '700 15px "Courier New", monospace';
				g.textAlign = 'left';
				g.fillText(`${rngKm.toFixed(1)}`, x + 17, y + 1);
				g.font = '700 21px "Courier New", monospace';
			}
		}
	}

	// ---- Weapon / systems blocks (bottom corners) ------------------------------------
	{
		const ws = state.weaponSystem;
		g.font = '700 17px "Courier New", monospace';
		g.textAlign = 'left';
		const cur = ws && ws.getCurrentWeapon && ws.getCurrentWeapon();
		if (cur) {
			const qty = cur.ammo === Infinity ? '' : ` ${cur.ammo}`;
			g.fillText(`${cur.name.split(' ').slice(0, 2).join(' ')}${qty}`, 30, PX - 66);
		}
		g.fillText('ARM', 30, PX - 44);
		const radar = state.sensors && state.sensors.radar;
		g.fillStyle = radar && radar.active ? HUD_GREEN : HUD_DIM;
		g.fillText(radar && radar.active ? (radar.playerMode || 'tws').toUpperCase() : 'EMCON', 30, PX - 22);
		g.fillStyle = HUD_GREEN;

		g.textAlign = 'right';
		g.fillText(`THR ${Math.round((state.throttle || 0) * 100)}%`, PX - 30, PX - 44);
		if (state.isBoosting) {
			// Blink AB at 3 Hz so it registers peripherally.
			if (dtClock % 0.33 < 0.22) g.fillText('AB', PX - 30, PX - 66);
		}
	}
}

// ---------------------------------------------------------------------------
// Builder — combiner glass, frame, projector, symbology plane.
// ---------------------------------------------------------------------------
export function buildCockpitHUD(group, mats) {
	const hudRoot = new THREE.Group();
	hudRoot.name = 'cockpitHUD';
	const TILT = -0.16;                 // combiner leans back at the top

	// Combiner glass — two stacked plates like a real reflector HUD.
	const glassMat = new THREE.MeshBasicMaterial({
		color: 0x2a4a38, transparent: true, opacity: 0.16, depthWrite: false,
	});
	for (const [dz, dy] of [[0, 0], [0.012, -0.004]]) {
		const glass = new THREE.Mesh(new THREE.PlaneGeometry(GLASS_W, GLASS_W), glassMat);
		glass.position.set(0, GLASS_CY + dy, GLASS_Z - dz);
		glass.rotation.x = TILT;
		glass.renderOrder = 3;
		hudRoot.add(glass);
	}

	// Frame: side arms + top/bottom edge strips + projector wedge.
	const armGeoms = [];
	const mkBox = (w, h, d, x, y, z, rx = 0) => {
		const geo = new THREE.BoxGeometry(w, h, d);
		geo.rotateX(rx);
		geo.translate(x, y, z);
		armGeoms.push(geo);
	};
	mkBox(0.012, GLASS_W + 0.02, 0.02, -GLASS_W / 2 - 0.008, GLASS_CY, GLASS_Z, TILT);
	mkBox(0.012, GLASS_W + 0.02, 0.02,  GLASS_W / 2 + 0.008, GLASS_CY, GLASS_Z, TILT);
	mkBox(GLASS_W + 0.028, 0.014, 0.02, 0, GLASS_CY - GLASS_W / 2 - 0.004, GLASS_Z + 0.022, TILT);
	// Projector housing sunk into the glareshield behind the combiner.
	mkBox(0.17, 0.05, 0.15, 0, -0.20, GLASS_Z - 0.14);
	const frame = new THREE.Mesh(mergeGeometries(armGeoms), mats.grip);
	hudRoot.add(frame);
	// Projector exit lens — faint green glow.
	const lens = new THREE.Mesh(
		new THREE.PlaneGeometry(0.11, 0.05),
		new THREE.MeshBasicMaterial({ color: 0x0c2417 }),
	);
	lens.position.set(0, -0.172, GLASS_Z - 0.085);
	lens.rotation.x = -1.05;
	hudRoot.add(lens);

	// Symbology plane.
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = PX;
	const g = canvas.getContext('2d');
	const tex = new THREE.CanvasTexture(canvas);
	tex.anisotropy = 4;
	const symb = new THREE.Mesh(
		new THREE.PlaneGeometry(GLASS_W, GLASS_W),
		new THREE.MeshBasicMaterial({
			map: tex, transparent: true, depthWrite: false,
			blending: THREE.AdditiveBlending,
		}),
	);
	symb.position.set(0, GLASS_CY + 0.002, GLASS_Z + 0.006);
	symb.rotation.x = TILT;
	symb.renderOrder = 4;
	hudRoot.add(symb);

	group.add(hudRoot);

	let clock = 0;
	function update(state, dt, worldFovDeg) {
		clock += dt;
		const ppd = (PX / GLASS_ANG_DEG) * (75 / Math.max(20, worldFovDeg || 75));
		drawSymbology(g, state, clock, ppd);
		tex.needsUpdate = true;
	}

	return { update };
}
