// ============================================================================
// Cockpit instruments — the analog standby cluster, warning lamps, AOA
// indexer and the up-front-controller (UFC) readout strip.
//
// Everything mounts onto the panelGroup local frame from cockpitGeometry
// (origin at panel-face center, +X right, +Y up the panel, +Z toward the
// pilot). Each dial is a one-time-painted canvas face plus a needle mesh
// whose rotation is set every frame — no per-frame canvas work except the
// low-rate UFC strip. Faces and lamps use MeshBasicMaterial so the
// avionics stay readable at night without a floodlight (self-lit).
//
// Value→needle-angle mapping is piecewise-linear through calibration
// stops, angles measured CLOCKWISE from 12 o'clock (both the face painter
// and the needle setter share the convention, so ticks and needle always
// agree).
// ============================================================================

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const FACE_PX = 176;

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------
function faceCanvas(draw) {
	const c = document.createElement('canvas');
	c.width = c.height = FACE_PX;
	const g = c.getContext('2d');
	const cx = FACE_PX / 2;
	// Face background + rim.
	g.fillStyle = '#0a0c0d';
	g.beginPath(); g.arc(cx, cx, cx, 0, Math.PI * 2); g.fill();
	g.strokeStyle = '#2c3236';
	g.lineWidth = 3;
	g.beginPath(); g.arc(cx, cx, cx - 2, 0, Math.PI * 2); g.stroke();
	draw(g, cx);
	const tex = new THREE.CanvasTexture(c);
	tex.anisotropy = 4;
	tex.colorSpace = THREE.SRGBColorSpace;
	return tex;
}

// Polar helpers for face painting — angle clockwise from 12 o'clock.
function pol(cx, r, a) {
	return [cx + r * Math.sin(a), cx - r * Math.cos(a)];
}

function ticks(g, cx, a0, a1, n, rInner, rOuter, color = '#e8eaec', width = 2) {
	g.strokeStyle = color;
	g.lineWidth = width;
	for (let i = 0; i <= n; i++) {
		const a = a0 + (a1 - a0) * (i / n);
		const [x1, y1] = pol(cx, rInner, a);
		const [x2, y2] = pol(cx, rOuter, a);
		g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
	}
}

function numeral(g, cx, r, a, text, px = 16, color = '#e8eaec') {
	const [x, y] = pol(cx, r, a);
	g.fillStyle = color;
	g.font = `700 ${px}px Arial`;
	g.textAlign = 'center';
	g.textBaseline = 'middle';
	g.fillText(text, x, y);
}

function centerLabel(g, cx, text, dy = 30, px = 11, color = '#9aa2a8') {
	g.fillStyle = color;
	g.font = `600 ${px}px Arial`;
	g.textAlign = 'center';
	g.textBaseline = 'middle';
	g.fillText(text, cx, cx + dy);
}

function arcBand(g, cx, r, a0, a1, color, width = 6) {
	g.strokeStyle = color;
	g.lineWidth = width;
	// Canvas arcs measure from +X CCW-positive; our convention is from 12
	// o'clock clockwise → canvas angle = ours - π/2.
	g.beginPath();
	g.arc(cx, cx, r, a0 - Math.PI / 2, a1 - Math.PI / 2, false);
	g.stroke();
}

// ---------------------------------------------------------------------------
// Dial factory
// ---------------------------------------------------------------------------
function makeNeedle(len, w, color, zOff) {
	const geo = new THREE.BoxGeometry(w, len, 0.0012);
	geo.translate(0, len / 2, 0);                 // pivot at the hub
	const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
	mesh.position.z = zOff;
	return mesh;
}

// calib: ascending [{v, a}] stops. Returns angle for value (clamped).
function calibAngle(calib, v) {
	if (v <= calib[0].v) return calib[0].a;
	for (let i = 1; i < calib.length; i++) {
		if (v <= calib[i].v) {
			const t = (v - calib[i - 1].v) / (calib[i].v - calib[i - 1].v);
			return calib[i - 1].a + t * (calib[i].a - calib[i - 1].a);
		}
	}
	return calib[calib.length - 1].a;
}

// Builds a dial (face + bezel + needle(s)) at panel-local (x, y).
// Returns { group, set(v [, v2]) }.
function makeDial(bezelList, { x, y, r, face, calib, needle2 }) {
	const group = new THREE.Group();
	group.position.set(x, y, 0.006);

	const faceMesh = new THREE.Mesh(
		new THREE.CircleGeometry(r, 32),
		new THREE.MeshBasicMaterial({ map: faceCanvas(face) }),
	);
	group.add(faceMesh);

	// Bezel ring into the shared merged batch (panel-local coords).
	const torus = new THREE.TorusGeometry(r, r * 0.10, 8, 28);
	torus.translate(x, y, 0.008);
	bezelList.push(torus);

	const n1 = makeNeedle(r * 0.78, r * 0.055, 0xf2f4f6, 0.004);
	group.add(n1);
	let n2 = null;
	if (needle2) {
		n2 = makeNeedle(r * 0.52, r * 0.09, 0xffb43c, 0.0028);
		group.add(n2);
	}
	const hub = new THREE.Mesh(
		new THREE.CircleGeometry(r * 0.09, 12),
		new THREE.MeshBasicMaterial({ color: 0x30353a }),
	);
	hub.position.z = 0.0052;
	group.add(hub);

	return {
		group,
		set(v, v2) {
			n1.rotation.z = -calibAngle(calib, v);
			if (n2 && typeof v2 === 'number') n2.rotation.z = -calibAngle(calib, v2);
		},
		setRaw(a, a2) {
			n1.rotation.z = -a;
			if (n2 && typeof a2 === 'number') n2.rotation.z = -a2;
		},
	};
}

// ---------------------------------------------------------------------------
// Lamps — label quad lit/dimmed by scaling the material color.
// ---------------------------------------------------------------------------
function makeLamp(w, h, label, color, px = 22) {
	const c = document.createElement('canvas');
	c.width = 128; c.height = Math.round(128 * h / w);
	const g = c.getContext('2d');
	g.fillStyle = '#000';
	g.fillRect(0, 0, c.width, c.height);
	g.strokeStyle = 'rgba(255,255,255,0.25)';
	g.lineWidth = 3;
	g.strokeRect(1, 1, c.width - 2, c.height - 2);
	g.fillStyle = color;
	g.font = `700 ${px}px Arial`;
	g.textAlign = 'center';
	g.textBaseline = 'middle';
	const lines = label.split('\n');
	lines.forEach((ln, i) => {
		g.fillText(ln, c.width / 2, c.height / 2 + (i - (lines.length - 1) / 2) * (px + 4));
	});
	const tex = new THREE.CanvasTexture(c);
	tex.colorSpace = THREE.SRGBColorSpace;
	const mat = new THREE.MeshBasicMaterial({ map: tex });
	mat.color.setScalar(0.22);                    // unlit
	const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
	return {
		mesh,
		lit(on) { mat.color.setScalar(on ? 1.0 : 0.22); },
	};
}

// AOA indexer glyph lamp (chevron / donut).
function makeGlyphLamp(size, kind, color) {
	const c = document.createElement('canvas');
	c.width = c.height = 64;
	const g = c.getContext('2d');
	g.fillStyle = '#000'; g.fillRect(0, 0, 64, 64);
	g.strokeStyle = color;
	g.lineWidth = 7;
	g.lineCap = 'round';
	if (kind === 'donut') {
		g.beginPath(); g.arc(32, 32, 15, 0, Math.PI * 2); g.stroke();
	} else {
		// Chevron: 'down' = slow/high-AOA (points down), 'up' = fast/low.
		g.beginPath();
		if (kind === 'down') { g.moveTo(12, 22); g.lineTo(32, 44); g.lineTo(52, 22); }
		else                 { g.moveTo(12, 44); g.lineTo(32, 22); g.lineTo(52, 44); }
		g.stroke();
	}
	const tex = new THREE.CanvasTexture(c);
	const mat = new THREE.MeshBasicMaterial({ map: tex });
	mat.color.setScalar(0.15);
	const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size * 0.72), mat);
	return { mesh, lit(on) { mat.color.setScalar(on ? 1.0 : 0.15); } };
}

// ---------------------------------------------------------------------------
// ADI ball texture — sky over ground with pitch rulings, painted around the
// full circumference so the ball can spin freely without a seam mattering.
// ---------------------------------------------------------------------------
function adiTexture() {
	const c = document.createElement('canvas');
	c.width = 256; c.height = 128;
	const g = c.getContext('2d');
	// v=0 is the sphere's top pole. Horizon at the equator (v=0.5).
	const grad = g.createLinearGradient(0, 0, 0, 128);
	grad.addColorStop(0.0, '#2f6fb4');
	grad.addColorStop(0.5, '#69a4d8');
	g.fillStyle = grad;
	g.fillRect(0, 0, 256, 64);
	const grad2 = g.createLinearGradient(0, 64, 0, 128);
	grad2.addColorStop(0.0, '#8a6134');
	grad2.addColorStop(1.0, '#4c3116');
	g.fillStyle = grad2;
	g.fillRect(0, 64, 256, 64);
	// Horizon line.
	g.fillStyle = '#f2f4f6';
	g.fillRect(0, 63, 256, 2);
	// Pitch rulings every 10° (equirect: 10° = 128px/180° ≈ 7.1px).
	const pxPerDeg = 128 / 180;
	g.fillStyle = 'rgba(242,244,246,0.85)';
	for (let d = 10; d <= 60; d += 10) {
		const w = d % 30 === 0 ? 40 : 22;
		for (let rep = 0; rep < 4; rep++) {
			const cxr = 32 + rep * 64;
			g.fillRect(cxr - w / 2, 64 - d * pxPerDeg, w, 1.6);
			g.fillRect(cxr - w / 2, 64 + d * pxPerDeg, w, 1.6);
		}
	}
	const tex = new THREE.CanvasTexture(c);
	tex.colorSpace = THREE.SRGBColorSpace;
	return tex;
}

// ---------------------------------------------------------------------------
// UFC display strip — the only per-frame-ish canvas here (throttled ~5 Hz).
// ---------------------------------------------------------------------------
function makeUfcDisplay(w, h) {
	const c = document.createElement('canvas');
	c.width = 320; c.height = 72;
	const g = c.getContext('2d');
	const tex = new THREE.CanvasTexture(c);
	tex.colorSpace = THREE.SRGBColorSpace;
	const mesh = new THREE.Mesh(
		new THREE.PlaneGeometry(w, h),
		new THREE.MeshBasicMaterial({ map: tex }),
	);
	function drawText(line1, line2) {
		g.fillStyle = '#03140a';
		g.fillRect(0, 0, c.width, c.height);
		g.fillStyle = '#46ff8c';
		g.font = '700 26px "Courier New", monospace';
		g.textBaseline = 'middle';
		g.textAlign = 'left';
		g.fillText(line1, 12, 20);
		g.fillText(line2, 12, 52);
		tex.needsUpdate = true;
	}
	return { mesh, drawText };
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------
export function buildInstruments(panelGroup, mats) {
	const bezelList = [];
	const dials = {};

	// ---- Standby cluster (center column between the MFDs) ------------------
	// Airspeed — km/h, 0..1600 across a 270° sweep.
	dials.asi = makeDial(bezelList, {
		x: -0.053, y: -0.115, r: 0.040,
		calib: [{ v: 0, a: -2.36 }, { v: 1600, a: 2.36 }],
		face: (g, cx) => {
			ticks(g, cx, -2.36, 2.36, 16, cx * 0.78, cx * 0.92);
			for (let i = 0; i <= 8; i++) {
				const a = -2.36 + (4.72 * i / 8);
				numeral(g, cx, cx * 0.60, a, String(i * 2), 15);
			}
			centerLabel(g, cx, 'IAS', 34);
			centerLabel(g, cx, '×100 KM/H', 48, 9, '#6d747a');
		},
	});

	// Altimeter — long needle 100s-in-1000, short needle 1000s-in-10000.
	dials.alt = makeDial(bezelList, {
		x: 0.053, y: -0.115, r: 0.040, needle2: true,
		calib: [{ v: 0, a: 0 }, { v: 1, a: Math.PI * 2 }],
		face: (g, cx) => {
			ticks(g, cx, 0, Math.PI * 2, 10, cx * 0.80, cx * 0.92);
			for (let i = 0; i < 10; i++) {
				numeral(g, cx, cx * 0.62, (Math.PI * 2 * i) / 10, String(i), 15);
			}
			centerLabel(g, cx, 'ALT m', 34);
		},
	});

	// VSI — ±150 m/s, zero parked at 9 o'clock.
	dials.vsi = makeDial(bezelList, {
		x: -0.053, y: -0.20, r: 0.034,
		calib: [{ v: -150, a: -Math.PI * 0.94 }, { v: 0, a: -Math.PI / 2 }, { v: 150, a: -Math.PI * 0.06 }],
		face: (g, cx) => {
			ticks(g, cx, -Math.PI * 0.94, -Math.PI * 0.06, 6, cx * 0.78, cx * 0.92);
			numeral(g, cx, cx * 0.60, -Math.PI / 2, '0', 14);
			numeral(g, cx, cx * 0.60, -Math.PI * 0.20, '1', 12);
			numeral(g, cx, cx * 0.60, -Math.PI * 0.80, '1', 12);
			centerLabel(g, cx, 'VVI', 30, 10);
			centerLabel(g, cx, '×100 m/s', 44, 8, '#6d747a');
		},
	});

	// HSI / compass — rotating card under a fixed lubber mark.
	const hsi = (() => {
		const group = new THREE.Group();
		group.position.set(0.053, -0.20, 0.006);
		const r = 0.034;
		const cardTex = faceCanvas((g, cx) => {
			ticks(g, cx, 0, Math.PI * 2, 36, cx * 0.84, cx * 0.95, '#c8cdd2', 1.5);
			const names = ['N', '3', '6', 'E', '12', '15', 'S', '21', '24', 'W', '30', '33'];
			names.forEach((t, i) => {
				numeral(g, cx, cx * 0.66, (Math.PI * 2 * i) / 12, t, t.length > 1 ? 12 : 16,
					'NESW'.includes(t) ? '#ffd24a' : '#e8eaec');
			});
		});
		const card = new THREE.Mesh(
			new THREE.CircleGeometry(r, 32),
			new THREE.MeshBasicMaterial({ map: cardTex }),
		);
		group.add(card);
		const torus = new THREE.TorusGeometry(r, r * 0.10, 8, 28);
		torus.translate(0.053, -0.20, 0.008);
		bezelList.push(torus);
		// Fixed lubber line + own-ship mark.
		const lubber = new THREE.Mesh(new THREE.PlaneGeometry(r * 0.06, r * 0.28),
			new THREE.MeshBasicMaterial({ color: 0xffb43c }));
		lubber.position.set(0, r * 0.86, 0.004);
		group.add(lubber);
		const ownShip = new THREE.Mesh(new THREE.PlaneGeometry(r * 0.30, r * 0.06),
			new THREE.MeshBasicMaterial({ color: 0xffb43c }));
		ownShip.position.z = 0.004;
		group.add(ownShip);
		return { group, card };
	})();

	// ---- ADI (attitude ball) — center, the visual anchor of the cluster ----
	const adi = (() => {
		const group = new THREE.Group();
		group.position.set(0, 0.02, 0.012);
		const r = 0.044;
		const ball = new THREE.Mesh(
			new THREE.SphereGeometry(r, 32, 24),
			new THREE.MeshBasicMaterial({ map: adiTexture() }),
		);
		ball.rotation.order = 'ZXY';
		group.add(ball);
		// Case: black surround ring + bezel so only the front hemisphere shows.
		const surround = new THREE.Mesh(
			new THREE.RingGeometry(r * 0.98, r * 1.5, 32),
			new THREE.MeshBasicMaterial({ color: 0x0a0c0d }),
		);
		surround.position.z = r * 0.62;
		group.add(surround);
		const torus = new THREE.TorusGeometry(r * 1.18, r * 0.09, 8, 32);
		torus.translate(0, 0.02, 0.012 + r * 0.64);
		bezelList.push(torus);
		// Fixed miniature-aircraft reference: two wings + center dot, orange.
		const mkBar = (w, x) => {
			const m = new THREE.Mesh(new THREE.PlaneGeometry(w, r * 0.07),
				new THREE.MeshBasicMaterial({ color: 0xff8c1e }));
			m.position.set(x, 0, r * 1.02);
			return m;
		};
		group.add(mkBar(r * 0.5, -r * 0.55));
		group.add(mkBar(r * 0.5, r * 0.55));
		const dot = new THREE.Mesh(new THREE.CircleGeometry(r * 0.06, 10),
			new THREE.MeshBasicMaterial({ color: 0xff8c1e }));
		dot.position.z = r * 1.02;
		group.add(dot);
		return { group, ball };
	})();

	// ---- Left flank: master caution, AOA indexer, G-meter -------------------
	const masterCaution = makeLamp(0.075, 0.030, 'MASTER\nCAUTION', '#ffb000', 15);
	masterCaution.mesh.position.set(-0.37, 0.225, 0.008);

	const aoaLamps = {
		high: makeGlyphLamp(0.030, 'down', '#ff4040'),
		on:   makeGlyphLamp(0.030, 'donut', '#40ff70'),
		low:  makeGlyphLamp(0.030, 'up', '#ffb000'),
	};
	aoaLamps.high.mesh.position.set(-0.37, 0.165, 0.008);
	aoaLamps.on.mesh.position.set(-0.37, 0.138, 0.008);
	aoaLamps.low.mesh.position.set(-0.37, 0.111, 0.008);

	dials.g = makeDial(bezelList, {
		x: -0.37, y: 0.035, r: 0.036,
		calib: [{ v: -3, a: -2.9 }, { v: 0, a: -2.2 }, { v: 10, a: 2.4 }],
		face: (g, cx) => {
			ticks(g, cx, -2.9, 2.4, 13, cx * 0.78, cx * 0.92);
			for (const [v, t] of [[-2, '-2'], [0, '0'], [2, '2'], [4, '4'], [6, '6'], [8, '8'], [10, '10']]) {
				const a = calibAngle([{ v: -3, a: -2.9 }, { v: 0, a: -2.2 }, { v: 10, a: 2.4 }], v);
				numeral(g, cx, cx * 0.58, a, t, 13);
			}
			arcBand(g, cx, cx * 0.90, calibAngle([{ v: -3, a: -2.9 }, { v: 0, a: -2.2 }, { v: 10, a: 2.4 }], 9),
				2.4, '#e03030', 5);
			centerLabel(g, cx, 'G', 34, 13);
		},
	});

	// ---- Right flank: warn lamp, caution panel, RPM, fuel --------------------
	const fireWarn = makeLamp(0.075, 0.030, 'FIRE', '#ff3020', 20);
	fireWarn.mesh.position.set(0.37, 0.225, 0.008);

	// Caution panel: static plate + 4 dynamic lenses.
	const cautionPlate = (() => {
		const c = document.createElement('canvas');
		c.width = 128; c.height = 112;
		const g = c.getContext('2d');
		g.fillStyle = '#141719'; g.fillRect(0, 0, 128, 112);
		g.strokeStyle = 'rgba(210,216,222,0.4)'; g.lineWidth = 2;
		g.strokeRect(1, 1, 126, 110);
		g.fillStyle = '#9aa2a8';
		g.font = '600 11px Arial'; g.textAlign = 'center';
		g.fillText('CAUTION', 64, 13);
		const tex = new THREE.CanvasTexture(c);
		tex.colorSpace = THREE.SRGBColorSpace;
		const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.09),
			new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 }));
		mesh.position.set(0.375, 0.135, 0.004);
		return mesh;
	})();
	const cLens = {
		fuel:  makeLamp(0.044, 0.019, 'FUEL LO', '#ffb000', 13),
		glim:  makeLamp(0.044, 0.019, 'G-LIM', '#ffb000', 13),
		emcon: makeLamp(0.044, 0.019, 'EMCON', '#7ec8ff', 13),
		eng:   makeLamp(0.044, 0.019, 'ENG', '#ffb000', 13),
	};
	cLens.fuel.mesh.position.set(0.352, 0.147, 0.008);
	cLens.glim.mesh.position.set(0.398, 0.147, 0.008);
	cLens.emcon.mesh.position.set(0.352, 0.124, 0.008);
	cLens.eng.mesh.position.set(0.398, 0.124, 0.008);

	dials.rpm = makeDial(bezelList, {
		x: 0.37, y: 0.035, r: 0.036,
		calib: [{ v: 0, a: -2.36 }, { v: 110, a: 2.36 }],
		face: (g, cx) => {
			ticks(g, cx, -2.36, 2.36, 11, cx * 0.78, cx * 0.92);
			for (let i = 0; i <= 10; i += 2) {
				const a = -2.36 + 4.72 * (i * 10) / 110;
				numeral(g, cx, cx * 0.58, a, String(i), 13);
			}
			arcBand(g, cx, cx * 0.90, -2.36 + 4.72 * 105 / 110, 2.36, '#e03030', 5);
			centerLabel(g, cx, 'RPM %', 34, 10);
		},
	});

	dials.fuel = makeDial(bezelList, {
		x: 0.37, y: -0.055, r: 0.036,
		calib: [{ v: 0, a: -2.2 }, { v: 8000, a: 2.2 }],
		face: (g, cx) => {
			ticks(g, cx, -2.2, 2.2, 8, cx * 0.78, cx * 0.92);
			for (let i = 0; i <= 8; i += 2) {
				const a = -2.2 + 4.4 * i / 8;
				numeral(g, cx, cx * 0.58, a, String(i), 13);
			}
			arcBand(g, cx, cx * 0.90, -2.2, -2.2 + 4.4 * 1600 / 8000, '#e03030', 5);
			centerLabel(g, cx, 'FUEL', 30, 10);
			centerLabel(g, cx, '×1000 KG', 44, 8, '#6d747a');
		},
	});

	// ---- UFC (up-front controller) under the HUD -----------------------------
	const ufc = makeUfcDisplay(0.175, 0.036);
	ufc.mesh.position.set(0, 0.225, 0.008);
	// Button rows below the display window (static greeble, merged).
	const btnList = [];
	for (let r = 0; r < 2; r++) {
		for (let i = 0; i < 5; i++) {
			const bg = new THREE.BoxGeometry(0.020, 0.014, 0.008);
			bg.translate(-0.072 + i * 0.036, 0.186 - r * 0.022, 0.006);
			btnList.push(bg);
		}
	}

	// ---- Assemble -------------------------------------------------------------
	const root = new THREE.Group();
	root.name = 'cockpitInstruments';
	for (const d of Object.values(dials)) root.add(d.group);
	root.add(hsi.group, adi.group, masterCaution.mesh, fireWarn.mesh, cautionPlate,
		ufc.mesh);
	for (const l of Object.values(aoaLamps)) root.add(l.mesh);
	for (const l of Object.values(cLens)) root.add(l.mesh);
	root.add(new THREE.Mesh(mergeGeometries(bezelList), mats.metal));
	root.add(new THREE.Mesh(mergeGeometries(btnList), mats.grip));
	panelGroup.add(root);

	// ---- Per-frame update -------------------------------------------------------
	let ufcT = 0;
	function update(state, dt, sim) {
		const spdKmh = (state.speed || 0) * 3.6;
		dials.asi.set(spdKmh);

		const altM = Math.max(0, state.alt || 0);
		dials.alt.setRaw(
			((altM % 1000) / 1000) * Math.PI * 2,
			((altM % 10000) / 10000) * Math.PI * 2,
		);

		dials.vsi.set(state.verticalSpeed || 0);
		dials.g.set(state.loadFactor || 1);
		dials.rpm.set(sim.rpm);
		dials.fuel.set(sim.fuelKg);

		// HSI card: bring the current heading to the top (CCW-positive z).
		hsi.card.rotation.z = THREE.MathUtils.degToRad(state.heading || 0);

		// ADI ball: bank rotates the horizon opposite the aircraft; pitch
		// rolls the drum. Signs chosen so nose-up shows more ground under
		// the horizon bar (sky recedes upward) and right bank tips the
		// horizon CCW, matching the real instrument.
		adi.ball.rotation.z = THREE.MathUtils.degToRad(state.roll || 0);
		adi.ball.rotation.x = -THREE.MathUtils.degToRad(state.pitch || 0);

		// AOA indexer: approach-style bands off the live alpha.
		const a = state.alpha || 0;
		aoaLamps.high.lit(a > 14);
		aoaLamps.on.lit(a >= 8 && a <= 14);
		aoaLamps.low.lit(a < 8);

		// Lamps. Master caution aggregates and blinks at ~2 Hz.
		const cautions = {
			fuel:  sim.fuelKg < 1600,
			glim:  !!state.gLimiterActive,
			emcon: !!(state.sensors && state.sensors.radar && !state.sensors.radar.active),
			eng:   !!state.dying,
		};
		cLens.fuel.lit(cautions.fuel);
		cLens.glim.lit(cautions.glim);
		cLens.emcon.lit(cautions.emcon);
		cLens.eng.lit(cautions.eng);
		const anyCaution = cautions.fuel || cautions.glim || cautions.eng;
		masterCaution.lit(anyCaution && (sim.t % 0.5 < 0.32));
		fireWarn.lit(!!state.dying && (sim.t % 0.4 < 0.26));

		// UFC strip at ~5 Hz.
		ufcT += dt;
		if (ufcT > 0.2) {
			ufcT = 0;
			const hdg = String(Math.round(((state.heading || 0) % 360 + 360) % 360)).padStart(3, '0');
			ufc.drawText(
				`HDG ${hdg}   IAS ${String(Math.round(spdKmh)).padStart(4, ' ')}`,
				`ALT ${String(Math.round(altM)).padStart(5, ' ')}  THR ${String(Math.round((state.throttle || 0) * 100)).padStart(3, ' ')}%`,
			);
		}
	}

	return { update };
}
