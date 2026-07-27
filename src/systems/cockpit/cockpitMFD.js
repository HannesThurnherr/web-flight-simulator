// ============================================================================
// Cockpit MFDs — the two multi-purpose displays flanking the standby
// cluster plus the letterbox engine-data strip above the ADI.
//
//   Left  MFD: FCR — a B-scope radar repeater fed from state.contacts
//              (the same fused picture the 2D HUD scope reads), with IFF
//              coloring, designated-target highlight and EMCON state.
//   Right MFD: SMS — stores management: jet silhouette, carried weapons
//              with counts, selected station highlighted, flare count.
//   Center   : EED — engine data (RPM/FF/NOZ/FTIT/OIL + fuel), driven by
//              the cosmetic engine model in cockpit.js.
//
// Each display is a CanvasTexture refreshed at a low, staggered rate
// (radar/stores ~12 Hz, engine ~6 Hz) so the three of them cost well
// under one canvas upload per rendered frame on average.
// ============================================================================

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const GREEN  = '#58ff9c';
const DIM    = 'rgba(88,255,156,0.38)';
const AMBER  = '#ffb000';
const RED    = '#ff5050';
const CYAN   = '#40d8ff';
const WHITE  = '#f0f4f2';

// ---------------------------------------------------------------------------
// Display shell: bezel slab, 20 OSB pushbuttons, screen mesh + canvas.
// ---------------------------------------------------------------------------
function makeDisplay(px, sizeM) {
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = px;
	const g = canvas.getContext('2d');
	const tex = new THREE.CanvasTexture(canvas);
	tex.anisotropy = 4;
	tex.colorSpace = THREE.SRGBColorSpace;
	const mesh = new THREE.Mesh(
		new THREE.PlaneGeometry(sizeM, sizeM),
		new THREE.MeshBasicMaterial({ map: tex }),
	);
	return { canvas, g, tex, mesh };
}

function bezelFor(x, y, screenM, bezelM, gripList, metalList) {
	// Bezel slab with a hole is overkill — a slab behind + raised border
	// strips reads identically. Border strips:
	const t = (bezelM - screenM) / 2;
	const zb = 0.004;
	const mk = (w, h, dx, dy) => {
		const geo = new THREE.BoxGeometry(w, h, 0.014);
		geo.translate(x + dx, y + dy, zb);
		gripList.push(geo);
	};
	mk(bezelM, t, 0, (screenM + t) / 2);
	mk(bezelM, t, 0, -(screenM + t) / 2);
	mk(t, screenM, (screenM + t) / 2, 0);
	mk(t, screenM, -(screenM + t) / 2, 0);
	// OSB pushbuttons: 5 per edge.
	for (let i = 0; i < 5; i++) {
		const o = (i - 2) * (screenM / 5.2);
		for (const [dx, dy] of [[o, (screenM + t) / 2], [o, -(screenM + t) / 2],
			[(screenM + t) / 2, o], [-(screenM + t) / 2, o]]) {
			const b = new THREE.BoxGeometry(0.013, 0.013, 0.019);
			b.translate(x + dx, y + dy, zb + 0.002);
			metalList.push(b);
		}
	}
}

// Equirect-approx bearing/range between two lon/lat points — plenty for a
// cockpit scope (same approach the minimap uses).
function brgRange(lon0, lat0, lon1, lat1) {
	const toRad = Math.PI / 180;
	const dE = (lon1 - lon0) * toRad * Math.cos(lat0 * toRad) * 6371000;
	const dN = (lat1 - lat0) * toRad * 6371000;
	return { brg: Math.atan2(dE, dN), rng: Math.hypot(dE, dN) };
}

function wrapPi(a) {
	while (a > Math.PI) a -= Math.PI * 2;
	while (a < -Math.PI) a += Math.PI * 2;
	return a;
}

// ---------------------------------------------------------------------------
// FCR page
// ---------------------------------------------------------------------------
function drawFCR(g, px, state, weaponSystem, scaleBox) {
	g.fillStyle = '#021006';
	g.fillRect(0, 0, px, px);

	const radar = state.sensors && state.sensors.radar;
	const mode = radar && radar.active ? (radar.playerMode || 'tws').toUpperCase() : 'OFF';

	// Screen furniture.
	g.font = '700 20px "Courier New", monospace';
	g.textBaseline = 'top';

	if (!radar || !radar.active) {
		g.fillStyle = DIM;
		g.textAlign = 'center';
		g.font = '700 30px "Courier New", monospace';
		g.fillText('EMCON', px / 2, px * 0.40);
		g.font = '700 18px "Courier New", monospace';
		g.fillText('RDR SILENT', px / 2, px * 0.52);
		g.textAlign = 'left';
		g.fillStyle = GREEN;
		g.fillText('FCR', 12, 8);
		return;
	}

	// Collect contacts first so the range scale can auto-step.
	const own = { lon: state.lon, lat: state.lat };
	const hdgRad = (state.heading || 0) * Math.PI / 180;
	const items = [];
	if (state.contacts) {
		for (const [npc] of state.contacts) {
			if (!npc || npc.destroyed || typeof npc.lon !== 'number') continue;
			const { brg, rng } = brgRange(own.lon, own.lat, npc.lon, npc.lat);
			const rel = wrapPi(brg - hdgRad);
			if (Math.abs(rel) > Math.PI / 3) continue;   // ±60° scope
			items.push({ npc, rel, rng });
		}
	}

	// Auto range scale with hysteresis (20/40/80/160 km).
	const steps = [20000, 40000, 80000, 160000];
	let maxR = 0;
	for (const it of items) maxR = Math.max(maxR, it.rng);
	let scale = scaleBox.v || 40000;
	if (maxR > scale * 0.95) {
		for (const s of steps) if (s > maxR) { scale = s; break; }
		if (maxR > steps[steps.length - 1] * 0.95) scale = steps[steps.length - 1];
	} else if (maxR < scale * 0.40 && scale > steps[0]) {
		scale = steps[Math.max(0, steps.indexOf(scale) - 1)];
	}
	scaleBox.v = scale;

	// B-scope grid: az on x, range on y.
	const left = 26, right = px - 26, top = 44, bot = px - 34;
	g.strokeStyle = DIM;
	g.lineWidth = 1;
	for (let i = 0; i <= 4; i++) {
		const x = left + (right - left) * (i / 4);
		g.beginPath(); g.moveTo(x, top); g.lineTo(x, bot); g.stroke();
	}
	for (let i = 0; i <= 4; i++) {
		const y = bot - (bot - top) * (i / 4);
		g.beginPath(); g.moveTo(left, y); g.lineTo(right, y); g.stroke();
	}
	// Range labels up the right edge.
	g.fillStyle = DIM;
	g.font = '700 13px "Courier New", monospace';
	g.textAlign = 'left';
	for (let i = 1; i <= 4; i++) {
		g.fillText(String(Math.round(scale * i / 4 / 1000)), right + 3, bot - (bot - top) * (i / 4) - 6);
	}

	// Own-ship marker bottom center.
	const cx = (left + right) / 2;
	g.strokeStyle = GREEN;
	g.lineWidth = 2;
	g.beginPath();
	g.moveTo(cx - 10, bot + 12); g.lineTo(cx, bot + 2); g.lineTo(cx + 10, bot + 12);
	g.stroke();

	// Contacts.
	const designated = weaponSystem && weaponSystem.designatedTarget;
	for (const it of items) {
		const x = cx + (it.rel / (Math.PI / 3)) * ((right - left) / 2);
		const y = bot - Math.min(1, it.rng / scale) * (bot - top);
		const iff = it.npc.team === state.team ? 'friendly'
			: (state.contacts.get(it.npc) || {}).iffStatus || 'hostile';
		const color = iff === 'friendly' ? CYAN : (iff === 'unknown' ? AMBER : RED);
		g.fillStyle = color;
		g.strokeStyle = color;
		g.lineWidth = 2;
		if (it.npc.kind === 'surface') {
			g.fillRect(x - 6, y - 3, 12, 6);
		} else if (it.npc.signature && /missile|cruise/.test(it.npc.signature.unitClass || '')) {
			g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill();
		} else {
			// Aircraft: track triangle oriented by relative heading.
			const th = ((it.npc.heading || 0) * Math.PI / 180) - hdgRad;
			g.save();
			g.translate(x, y);
			g.rotate(th);
			g.beginPath();
			g.moveTo(0, -7); g.lineTo(5, 5); g.lineTo(-5, 5); g.closePath();
			g.fill();
			g.restore();
		}
		// Altitude tag (kft-style but in km).
		g.font = '700 12px "Courier New", monospace';
		g.textAlign = 'left';
		g.fillText(String(Math.round((it.npc.alt || 0) / 1000)), x + 8, y - 4);

		if (designated && it.npc === designated) {
			g.strokeStyle = WHITE;
			g.lineWidth = 2;
			g.strokeRect(x - 10, y - 10, 20, 20);
			g.fillStyle = WHITE;
			g.fillText('TGT', x + 12, y + 6);
		}
	}

	// Header row.
	g.fillStyle = GREEN;
	g.font = '700 18px "Courier New", monospace';
	g.textAlign = 'left';
	g.fillText(`FCR  ${mode}`, 12, 8);
	g.textAlign = 'right';
	g.fillText(`${Math.round(scale / 1000)} KM`, px - 12, 8);
	g.textAlign = 'left';
	g.fillStyle = DIM;
	g.font = '700 14px "Courier New", monospace';
	g.fillText(`TRK ${items.length}`, 12, px - 22);
	if (designated) {
		const { rng } = brgRange(own.lon, own.lat, designated.lon, designated.lat);
		g.fillStyle = WHITE;
		g.textAlign = 'right';
		g.fillText(`TGT ${(rng / 1000).toFixed(1)} KM`, px - 12, px - 22);
	}
}

// ---------------------------------------------------------------------------
// SMS page
// ---------------------------------------------------------------------------
function drawSMS(g, px, state, weaponSystem) {
	g.fillStyle = '#021006';
	g.fillRect(0, 0, px, px);

	g.fillStyle = GREEN;
	g.font = '700 18px "Courier New", monospace';
	g.textAlign = 'left';
	g.textBaseline = 'top';
	g.fillText('SMS  A/A', 12, 8);
	// Master-arm box.
	g.strokeStyle = GREEN;
	g.lineWidth = 2;
	g.strokeRect(px - 96, 6, 84, 24);
	g.textAlign = 'center';
	g.fillText('MSTR ARM', px - 54, 10);

	// Jet silhouette.
	const cx = px / 2, cy = px * 0.52;
	g.strokeStyle = DIM;
	g.lineWidth = 2;
	g.beginPath();
	g.moveTo(cx, cy - 78);
	g.lineTo(cx + 12, cy - 20);
	g.lineTo(cx + 62, cy + 18);
	g.lineTo(cx + 60, cy + 30);
	g.lineTo(cx + 10, cy + 26);
	g.lineTo(cx + 20, cy + 62);
	g.lineTo(cx + 6, cy + 70);
	g.lineTo(cx, cy + 58);
	g.lineTo(cx - 6, cy + 70);
	g.lineTo(cx - 20, cy + 62);
	g.lineTo(cx - 10, cy + 26);
	g.lineTo(cx - 60, cy + 30);
	g.lineTo(cx - 62, cy + 18);
	g.lineTo(cx - 12, cy - 20);
	g.closePath();
	g.stroke();

	// Carried weapons: gun + anything with rounds. Selected row inverse.
	const carried = [];
	if (weaponSystem && weaponSystem.weapons) {
		for (const w of weaponSystem.weapons) {
			if (w.id === 'gun' || w.ammo > 0 || w === weaponSystem.getCurrentWeapon()) {
				carried.push(w);
			}
		}
	}
	const current = weaponSystem && weaponSystem.getCurrentWeapon && weaponSystem.getCurrentWeapon();
	g.font = '700 15px "Courier New", monospace';
	const rowH = 26;
	carried.slice(0, 10).forEach((w, i) => {
		const side = i % 2 === 0 ? -1 : 1;
		const row = Math.floor(i / 2);
		const bx = side < 0 ? 10 : px - 128;
		const by = 52 + row * rowH;
		const short = w.name.split(' ').slice(0, 1).join(' ').slice(0, 9);
		const qty = w.ammo === Infinity ? '∞' : String(w.ammo);
		if (w === current) {
			g.fillStyle = GREEN;
			g.fillRect(bx - 2, by - 3, 120, 22);
			g.fillStyle = '#03210f';
		} else {
			g.fillStyle = w.ammo === 0 && w.id !== 'gun' ? DIM : GREEN;
		}
		g.textAlign = 'left';
		g.fillText(`${short}`, bx + 2, by);
		g.textAlign = 'right';
		g.fillText(qty, bx + 114, by);
	});

	// Flares + selected-weapon banner.
	g.fillStyle = AMBER;
	g.textAlign = 'left';
	g.fillText(`FLARE ${weaponSystem && weaponSystem.flareWeapon ? weaponSystem.flareWeapon.ammo : '—'}`, 12, px - 26);
	if (current) {
		g.fillStyle = WHITE;
		g.textAlign = 'right';
		g.fillText(current.name.slice(0, 20), px - 12, px - 26);
	}
}

// ---------------------------------------------------------------------------
// EED strip (engine data)
// ---------------------------------------------------------------------------
function drawEED(g, w, h, state, sim) {
	g.fillStyle = '#03140a';
	g.fillRect(0, 0, w, h);
	g.strokeStyle = 'rgba(88,255,156,0.25)';
	g.lineWidth = 2;
	g.strokeRect(1, 1, w - 2, h - 2);

	g.font = '700 20px "Courier New", monospace';
	g.textBaseline = 'top';
	const col = (x, label, val, warn) => {
		g.textAlign = 'center';
		g.fillStyle = 'rgba(88,255,156,0.5)';
		g.font = '700 15px "Courier New", monospace';
		g.fillText(label, x, 6);
		g.fillStyle = warn ? AMBER : GREEN;
		g.font = '700 22px "Courier New", monospace';
		g.fillText(val, x, 26);
	};
	col(w * 0.10, 'RPM',  `${sim.rpm.toFixed(0)}`, sim.rpm > 104);
	col(w * 0.28, 'FF',   `${Math.round(sim.ffKgh / 10) * 10}`);
	col(w * 0.46, 'NOZ',  `${Math.round(sim.nozPct)}`);
	col(w * 0.64, 'FTIT', `${Math.round(sim.ftit)}`, sim.ftit > 940);
	col(w * 0.84, 'FUEL', `${Math.round(sim.fuelKg)}`, sim.fuelKg < 1600);

	if (state.isBoosting) {
		g.fillStyle = AMBER;
		g.font = '700 16px "Courier New", monospace';
		g.textAlign = 'left';
		g.fillText('AB', 8, h - 22);
	}
	g.fillStyle = 'rgba(88,255,156,0.5)';
	g.font = '700 14px "Courier New", monospace';
	g.textAlign = 'right';
	g.fillText(`THR ${Math.round((state.throttle || 0) * 100)}%`, w - 8, h - 20);
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------
export function buildMFDs(panelGroup, mats) {
	const gripList = [];
	const metalList = [];
	const root = new THREE.Group();
	root.name = 'cockpitMFDs';

	const SCREEN = 0.16, BEZEL = 0.225, X = 0.215, Y = 0.02;

	const fcr = makeDisplay(384, SCREEN);
	fcr.mesh.position.set(-X, Y, 0.012);
	bezelFor(-X, Y, SCREEN, BEZEL, gripList, metalList);
	root.add(fcr.mesh);

	const sms = makeDisplay(384, SCREEN);
	sms.mesh.position.set(X, Y, 0.012);
	bezelFor(X, Y, SCREEN, BEZEL, gripList, metalList);
	root.add(sms.mesh);

	// EED letterbox between UFC and ADI.
	const eed = (() => {
		const canvas = document.createElement('canvas');
		canvas.width = 320; canvas.height = 84;
		const g = canvas.getContext('2d');
		const tex = new THREE.CanvasTexture(canvas);
		tex.colorSpace = THREE.SRGBColorSpace;
		const mesh = new THREE.Mesh(
			new THREE.PlaneGeometry(0.155, 0.040),
			new THREE.MeshBasicMaterial({ map: tex }),
		);
		mesh.position.set(0, 0.128, 0.008);
		return { canvas, g, tex, mesh };
	})();
	root.add(eed.mesh);
	// Thin frame around the EED.
	{
		const fr = new THREE.BoxGeometry(0.165, 0.05, 0.008);
		fr.translate(0, 0.128, 0.002);
		gripList.push(fr);
	}

	root.add(new THREE.Mesh(mergeGeometries(gripList), mats.grip));
	root.add(new THREE.Mesh(mergeGeometries(metalList), mats.metal));
	panelGroup.add(root);

	// ---- Staggered refresh ---------------------------------------------------
	const scaleBox = { v: 40000 };
	let tFcr = 0, tSms = 0.028, tEed = 0.09;   // phase offsets
	function update(state, dt, sim) {
		const weaponSystem = state.weaponSystem;
		tFcr += dt; tSms += dt; tEed += dt;
		if (tFcr >= 0.085) {
			tFcr = 0;
			drawFCR(fcr.g, fcr.canvas.width, state, weaponSystem, scaleBox);
			fcr.tex.needsUpdate = true;
		}
		if (tSms >= 0.20) {
			tSms = 0;
			drawSMS(sms.g, sms.canvas.width, state, weaponSystem);
			sms.tex.needsUpdate = true;
		}
		if (tEed >= 0.18) {
			tEed = 0;
			drawEED(eed.g, eed.canvas.width, eed.canvas.height, state, sim);
			eed.tex.needsUpdate = true;
		}
	}

	return { update };
}
