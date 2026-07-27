// ============================================================================
// Cockpit geometry — the static 3D shell of the first-person cockpit.
//
// Everything here is built procedurally in CAMERA SPACE: the pilot's eye
// sits at the origin, +X is right, +Y is up, -Z is forward through the
// HUD. The whole group is added to the normal THREE scene and counter-
// rotated by the look-around orbit each frame (cockpit.js), so it behaves
// as if bolted to the airframe while the world (baked with the Cesium
// view matrix) moves behind the canopy glass.
//
// Layout is a single-seat fighter blend (F-16 bubble canopy, F/A-18-ish
// panel): glareshield + HUD up front, two MFDs flanking a standby-gauge
// stack, side consoles with labeled switch panels, center stick, left
// throttle quadrant, rudder pedals, ejection handle, harness straps.
//
// SIGHT-LINE CALIBRATION: the game camera is 75° vertical FOV, so the
// bottom screen edge is ~37° below boresight. The panel is positioned so
// the glareshield lip sits ~10° below the horizon, the MFDs ~27°, and
// the standby dials ~35° — HUD + both MFDs + the dial cluster are all on
// screen in the default view, with consoles/stick appearing on a glance
// down (mouse-orbit). Don't lower the panel without rechecking those
// angles — at 20°+ for the glareshield the whole panel falls off-screen.
//
// Draw-call budget matters (this renders on top of the whole sim), so
// every static part is merged into a handful of per-material meshes.
// Only the things that move (stick, throttle, pedals, needles — the
// latter live in cockpitInstruments.js) get their own mesh.
// ============================================================================

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------------------
// Shared dimensions — exported so the instrument / MFD / HUD modules mount
// onto the same reference frame without magic-number drift.
// ---------------------------------------------------------------------------
export const COCKPIT_DIMS = {
	sillY: -0.235,          // canopy rail height
	sillX: 0.44,            // canopy rail half-width
	panelCenter: new THREE.Vector3(0, -0.40, -0.76),
	panelTilt: -0.36,       // rad about X — top edge leans away from pilot
	panelW: 0.84,
	panelH: 0.52,
	glareshieldY: -0.155,
	hudBaseZ: -0.66,
};

// ---------------------------------------------------------------------------
// Materials — shared across cockpit modules. Standard PBR-ish materials lit
// by the scene's ambient + directional; screens/lamps elsewhere use
// MeshBasicMaterial so they stay readable at night (self-lit avionics).
// ---------------------------------------------------------------------------
export function makeCockpitMaterials() {
	return {
		panel:   new THREE.MeshStandardMaterial({ color: 0x14171a, roughness: 0.88, metalness: 0.12 }),
		tub:     new THREE.MeshStandardMaterial({ color: 0x23282d, roughness: 0.92, metalness: 0.10 }),
		console: new THREE.MeshStandardMaterial({ color: 0x191d21, roughness: 0.86, metalness: 0.12 }),
		metal:   new THREE.MeshStandardMaterial({ color: 0x3a4046, roughness: 0.42, metalness: 0.72 }),
		grip:    new THREE.MeshStandardMaterial({ color: 0x101214, roughness: 0.62, metalness: 0.08 }),
		gray:    new THREE.MeshStandardMaterial({ color: 0x646b72, roughness: 0.58, metalness: 0.35 }),
		olive:   new THREE.MeshStandardMaterial({ color: 0x474a38, roughness: 0.95, metalness: 0.02 }),
		red:     new THREE.MeshStandardMaterial({ color: 0xb02020, roughness: 0.45, metalness: 0.1 }),
		white:   new THREE.MeshStandardMaterial({ color: 0xd8dade, roughness: 0.5,  metalness: 0.1 }),
		mirror:  new THREE.MeshStandardMaterial({ color: 0x46525e, roughness: 0.06, metalness: 1.0 }),
	};
}

// ---------------------------------------------------------------------------
// Small helpers — accumulate transformed geometries per material, merge once.
// ---------------------------------------------------------------------------
const _m4 = new THREE.Matrix4();
const _q  = new THREE.Quaternion();
const _e  = new THREE.Euler();

function pushGeo(list, geo, pos, rot) {
	if (rot) {
		_e.set(rot.x || 0, rot.y || 0, rot.z || 0);
		_q.setFromEuler(_e);
	} else {
		_q.identity();
	}
	_m4.compose(
		new THREE.Vector3(pos.x || 0, pos.y || 0, pos.z || 0),
		_q,
		new THREE.Vector3(1, 1, 1),
	);
	geo.applyMatrix4(_m4);
	list.push(geo);
}

function box(list, w, h, d, pos, rot) {
	pushGeo(list, new THREE.BoxGeometry(w, h, d), pos, rot);
}

function cyl(list, rTop, rBot, h, pos, rot, seg = 12) {
	pushGeo(list, new THREE.CylinderGeometry(rTop, rBot, h, seg), pos, rot);
}

// One-time canvas → texture plate with painted labels. Used for every
// console panel so the cockpit reads as densely stenciled avionics
// hardware instead of bare boxes. Textures are static (drawn once).
function labelPlate(wM, hM, px, draw) {
	const c = document.createElement('canvas');
	const scale = px / wM;
	c.width = px; c.height = Math.max(32, Math.round(hM * scale));
	const g = c.getContext('2d');
	g.fillStyle = '#1c2126';
	g.fillRect(0, 0, c.width, c.height);
	g.strokeStyle = 'rgba(210,216,222,0.55)';
	g.lineWidth = 2;
	g.strokeRect(2, 2, c.width - 4, c.height - 4);
	// Corner screws
	g.fillStyle = '#0c0e10';
	for (const [sx, sy] of [[8, 8], [c.width - 8, 8], [8, c.height - 8], [c.width - 8, c.height - 8]]) {
		g.beginPath(); g.arc(sx, sy, 3.4, 0, Math.PI * 2); g.fill();
	}
	draw(g, c.width, c.height);
	const tex = new THREE.CanvasTexture(c);
	tex.anisotropy = 4;
	tex.colorSpace = THREE.SRGBColorSpace;
	const mesh = new THREE.Mesh(
		new THREE.PlaneGeometry(wM, hM),
		new THREE.MeshStandardMaterial({
			map: tex, roughness: 0.85, metalness: 0.1,
			// Faint self-glow keeps panel stencils readable at night the way
			// real backlit panels do, without needing a cockpit floodlight.
			emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.14,
		}),
	);
	return mesh;
}

function plateTitle(g, w, text) {
	g.fillStyle = '#cfd5da';
	g.font = `600 ${Math.round(w * 0.085)}px Arial`;
	g.textAlign = 'center';
	g.textBaseline = 'top';
	g.fillText(text, w / 2, 7);
}

function plateLabel(g, x, y, text, size = 11, color = '#9aa2a8') {
	g.fillStyle = color;
	g.font = `600 ${size}px Arial`;
	g.textAlign = 'center';
	g.textBaseline = 'middle';
	g.fillText(text, x, y);
}

// Toggle switch: washer base + tilted stem + ball tip. Merged into the
// metal batch; `on` picks the tilt direction so rows look lived-in.
function toggleSwitch(metalList, x, y, z, on, rotFrame) {
	// rotFrame lets console switches stand perpendicular to the console
	// surface. Base washer:
	cyl(metalList, 0.007, 0.007, 0.004, { x, y, z }, rotFrame);
	const tilt = on ? -0.5 : 0.5;
	const stemLen = 0.016;
	// Stem tilts about local X — approximate by offsetting the tip.
	cyl(metalList, 0.0024, 0.0024, stemLen,
		{ x, y: y + 0.008, z: z + Math.sin(tilt) * 0.006 },
		{ x: (rotFrame ? rotFrame.x : 0) + tilt, y: 0, z: 0 });
	pushGeo(metalList, new THREE.SphereGeometry(0.0045, 8, 6),
		{ x, y: y + 0.015, z: z + Math.sin(tilt) * 0.011 }, null);
}

// Rotary knob: body + skirt + pointer stripe.
function knob(metalList, gripList, x, y, z, ang, rotFrame) {
	cyl(gripList, 0.013, 0.015, 0.012, { x, y: y + 0.006, z }, rotFrame);
	box(gripList, 0.004, 0.014, 0.026, { x, y: y + 0.013, z }, { x: 0, y: ang, z: 0 });
	cyl(metalList, 0.017, 0.017, 0.003, { x, y: y + 0.0015, z }, rotFrame);
}

// ---------------------------------------------------------------------------
// Canopy glass — fresnel shader. Nearly clear looking straight through,
// picks up tint + sheen at grazing angles; subtle gold canopy coating
// toward the top like a real EMI-coated bubble.
// ---------------------------------------------------------------------------
function makeCanopyGlassMaterial() {
	return new THREE.ShaderMaterial({
		transparent: true,
		depthWrite: false,
		side: THREE.DoubleSide,
		uniforms: {
			uTint:  { value: new THREE.Color(0.62, 0.70, 0.66) },
			uGold:  { value: new THREE.Color(0.82, 0.68, 0.34) },
			uSun:   { value: new THREE.Vector3(0.35, 0.75, -0.55) },
		},
		vertexShader: /* glsl */`
			varying vec3 vNormal;
			varying vec3 vView;
			varying vec3 vLocal;
			void main() {
				vLocal = position;
				vNormal = normalMatrix * normal;
				vec4 mv = modelViewMatrix * vec4(position, 1.0);
				vView = -mv.xyz;
				gl_Position = projectionMatrix * mv;
			}
		`,
		fragmentShader: /* glsl */`
			uniform vec3 uTint;
			uniform vec3 uGold;
			uniform vec3 uSun;
			varying vec3 vNormal;
			varying vec3 vView;
			varying vec3 vLocal;
			void main() {
				vec3 n = normalize(vNormal);
				vec3 v = normalize(vView);
				float ndv = abs(dot(n, v));
				// Fresnel-ish edge response: clear on-axis, milky at grazing.
				float fres = pow(1.0 - ndv, 3.0);
				// Gold anti-EMI coating strongest on the upper dome.
				float goldMix = smoothstep(-0.1, 0.55, vLocal.y) * 0.35;
				vec3 col = mix(uTint, uGold, goldMix);
				// Cheap sun glint: specular lobe against a fixed high sun in
				// camera space — reads as a moving sheen as you look around.
				vec3 h = normalize(normalize(uSun) + v);
				float spec = pow(max(dot(n, h), 0.0), 60.0) * 0.5;
				float alpha = 0.055 + fres * 0.38 + spec * 0.35;
				col = mix(col, vec3(1.0), fres * 0.4 + spec);
				gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.6));
			}
		`,
	});
}

// Striped ejection-handle texture (yellow/black barber pole).
function stripedTexture() {
	const c = document.createElement('canvas');
	c.width = 64; c.height = 8;
	const g = c.getContext('2d');
	for (let i = 0; i < 8; i++) {
		g.fillStyle = i % 2 ? '#0c0c0c' : '#e0b400';
		g.fillRect(i * 8, 0, 8, 8);
	}
	const tex = new THREE.CanvasTexture(c);
	tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
	tex.repeat.set(3, 1);
	return tex;
}

// ---------------------------------------------------------------------------
// Main builder.
// ---------------------------------------------------------------------------
export function buildCockpitGeometry() {
	const D = COCKPIT_DIMS;
	const mats = makeCockpitMaterials();
	const group = new THREE.Group();
	group.name = 'cockpitShell';

	// Per-material geometry accumulators for the static shell.
	const G = { panel: [], tub: [], console: [], metal: [], grip: [], gray: [], olive: [], white: [], red: [] };

	// ---- Instrument panel slab + local mount frame -----------------------
	// The panel is a tilted slab; instruments/MFDs mount onto `panelGroup`,
	// whose local XY plane is the panel face (origin center, +Z to pilot).
	const panelGroup = new THREE.Group();
	panelGroup.position.copy(D.panelCenter);
	panelGroup.rotation.x = D.panelTilt;
	group.add(panelGroup);

	// Slab behind the face (in panel-local coords, merged separately then
	// added to panelGroup so it shares the tilt).
	const panelLocal = [];
	box(panelLocal, D.panelW, D.panelH, 0.055, { x: 0, y: 0, z: -0.030 });
	// Side cheeks angling back toward the consoles.
	box(panelLocal, 0.05, D.panelH, 0.16, { x: -D.panelW / 2 - 0.012, y: 0, z: -0.07 }, { x: 0, y: 0.35, z: 0 });
	box(panelLocal, 0.05, D.panelH, 0.16, { x:  D.panelW / 2 + 0.012, y: 0, z: -0.07 }, { x: 0, y: -0.35, z: 0 });
	// Bottom kick strip with breaker dots.
	box(panelLocal, D.panelW, 0.05, 0.02, { x: 0, y: -D.panelH / 2 - 0.02, z: 0.005 });
	const panelSlab = new THREE.Mesh(mergeGeometries(panelLocal), mats.panel);
	panelGroup.add(panelSlab);

	// Rows of tiny circuit-breaker studs along the bottom strip — pure
	// greeble, but exactly the kind of density a real pit has.
	const breakerList = [];
	for (let i = 0; i < 18; i++) {
		const bx = -0.36 + i * 0.042;
		cyl(breakerList, 0.004, 0.004, 0.008, { x: bx, y: -D.panelH / 2 - 0.018, z: 0.012 }, { x: Math.PI / 2, y: 0, z: 0 }, 8);
	}
	const breakers = new THREE.Mesh(mergeGeometries(breakerList), mats.grip);
	panelGroup.add(breakers);

	// ---- Glareshield ------------------------------------------------------
	// Anti-glare hood running forward from the panel top to the windscreen
	// base. Rounded front lip. Sits ~10° below boresight so the panel
	// beneath it stays on screen at the game's 75° vertical FOV.
	box(G.panel, 0.86, 0.035, 0.26, { x: 0, y: D.glareshieldY - 0.017, z: -0.95 });
	cyl(G.panel, 0.020, 0.020, 0.84, { x: 0, y: D.glareshieldY - 0.017, z: -1.075 }, { x: 0, y: 0, z: Math.PI / 2 }, 10);
	// Padded top surface (olive) — classic anti-reflection covering.
	box(G.olive, 0.82, 0.008, 0.24, { x: 0, y: D.glareshieldY + 0.002, z: -0.95 });

	// ---- Nose cowl --------------------------------------------------------
	// Aircraft skin sloping down and away in front of the windscreen so a
	// forward-down glance sees jet, not a hole in the world.
	box(G.gray, 0.84, 0.02, 0.30, { x: 0, y: -0.185, z: -1.22 }, { x: 0.08, y: 0, z: 0 });
	box(G.gray, 0.66, 0.02, 0.55, { x: 0, y: -0.29, z: -1.60 },  { x: 0.28, y: 0, z: 0 });
	box(G.gray, 0.34, 0.02, 0.70, { x: 0, y: -0.53, z: -2.09 },  { x: 0.42, y: 0, z: 0 });
	// Pitot probe way out front — tiny but sells the nose.
	cyl(G.metal, 0.006, 0.010, 0.55, { x: 0, y: -0.65, z: -2.59 }, { x: Math.PI / 2 + 0.42, y: 0, z: 0 }, 8);

	// ---- Cockpit tub: floor, walls, bulkheads, shoulders -------------------
	// Floor with two raised heel troughs.
	box(G.tub, 0.92, 0.02, 1.18, { x: 0, y: -0.90, z: -0.145 });
	box(G.tub, 0.05, 0.015, 0.62, { x: -0.185, y: -0.883, z: -0.55 });
	box(G.tub, 0.05, 0.015, 0.62, { x:  0.185, y: -0.883, z: -0.55 });
	// Side walls up to the sills.
	box(G.tub, 0.022, 0.68, 1.28, { x: -0.455, y: -0.565, z: -0.11 });
	box(G.tub, 0.022, 0.68, 1.28, { x:  0.455, y: -0.565, z: -0.11 });
	// Horizontal stiffener ribs on each wall (visible texture/depth).
	for (const sx of [-1, 1]) {
		for (let i = 0; i < 3; i++) {
			box(G.metal, 0.012, 0.018, 1.1, { x: sx * 0.442, y: -0.37 - i * 0.16, z: -0.11 });
		}
	}
	// Front bulkhead below the panel; rear bulkhead behind the seat.
	box(G.tub, 0.9, 0.30, 0.024, { x: 0, y: -0.78, z: -0.60 });
	box(G.tub, 0.9, 0.75, 0.03,  { x: 0, y: -0.53, z: 0.56 });
	// Canopy sill rails — the metal tubes the bubble locks onto.
	cyl(G.metal, 0.016, 0.016, 1.12, { x: -D.sillX, y: D.sillY + 0.005, z: -0.09 }, { x: Math.PI / 2, y: 0, z: 0 }, 10);
	cyl(G.metal, 0.016, 0.016, 1.12, { x:  D.sillX, y: D.sillY + 0.005, z: -0.09 }, { x: Math.PI / 2, y: 0, z: 0 }, 10);
	// Canopy latch hooks along each rail.
	for (const sx of [-1, 1]) {
		for (const lz of [-0.45, -0.05, 0.35]) {
			box(G.metal, 0.02, 0.03, 0.035, { x: sx * (D.sillX - 0.005), y: D.sillY + 0.028, z: lz });
		}
	}
	// Exterior fuselage shoulders outside the sills — block the see-through
	// gap when peering steeply over the rail.
	box(G.gray, 0.16, 0.03, 1.15, { x: -0.52, y: D.sillY - 0.02, z: -0.10 });
	box(G.gray, 0.16, 0.03, 1.15, { x:  0.52, y: D.sillY - 0.02, z: -0.10 });

	// ---- Side consoles -----------------------------------------------------
	// Sloped shelves under each sill carrying the switch panels.
	for (const sx of [-1, 1]) {
		box(G.console, 0.245, 0.024, 1.00, { x: sx * 0.325, y: -0.455, z: -0.135 });
		// Inner vertical face down to the floor.
		box(G.console, 0.02, 0.44, 1.00, { x: sx * 0.205, y: -0.685, z: -0.135 });
		// Forward wedge rising to the panel cheeks.
		box(G.console, 0.245, 0.024, 0.22, { x: sx * 0.325, y: -0.39, z: -0.585 }, { x: -0.45, y: 0, z: 0 });
	}

	// ---- Center pedestal + control stick -----------------------------------
	box(G.console, 0.16, 0.18, 0.32, { x: 0, y: -0.815, z: -0.475 });
	// Stick: pivot group so cockpit.js can tilt it with pitch/roll input.
	const stick = new THREE.Group();
	stick.position.set(0, -0.725, -0.40);
	group.add(stick);
	{
		const boot = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.052, 0.075, 12), mats.olive);
		boot.position.y = 0.037;
		stick.add(boot);
		const shaftAndGrip = [];
		cyl(shaftAndGrip, 0.0115, 0.013, 0.155, { x: 0, y: 0.145, z: 0 });
		// Contoured grip, raked forward.
		cyl(shaftAndGrip, 0.021, 0.024, 0.115, { x: 0, y: 0.263, z: -0.008 }, { x: 0.18, y: 0, z: 0 });
		pushGeo(shaftAndGrip, new THREE.SphereGeometry(0.022, 10, 8), { x: 0, y: 0.318, z: -0.018 });
		// Trigger guard + trigger out front.
		box(shaftAndGrip, 0.012, 0.035, 0.01, { x: 0, y: 0.255, z: -0.033 }, { x: 0.3, y: 0, z: 0 });
		// Rear palm paddle.
		box(shaftAndGrip, 0.026, 0.05, 0.008, { x: 0, y: 0.225, z: 0.02 }, { x: -0.15, y: 0, z: 0 });
		const gripMesh = new THREE.Mesh(mergeGeometries(shaftAndGrip), mats.grip);
		stick.add(gripMesh);
		// Red pickle button + gray trim hat on top — separate for color.
		const pickle = new THREE.Mesh(new THREE.CylinderGeometry(0.0075, 0.0075, 0.006, 10), mats.red);
		pickle.position.set(-0.009, 0.329, -0.024); pickle.rotation.x = 0.18;
		stick.add(pickle);
		const hat = new THREE.Mesh(new THREE.SphereGeometry(0.0065, 8, 6), mats.gray);
		hat.position.set(0.012, 0.329, -0.020);
		stick.add(hat);
	}

	// ---- Throttle quadrant (left console) -----------------------------------
	// Slot plate on the console; lever pivots from beneath so the grip
	// slides fore/aft with throttle setting. cockpit.js drives rotation.x.
	box(G.grip, 0.075, 0.006, 0.30, { x: -0.315, y: -0.442, z: -0.10 });
	box(G.metal, 0.018, 0.004, 0.26, { x: -0.315, y: -0.438, z: -0.10 });
	const throttle = new THREE.Group();
	throttle.position.set(-0.315, -0.575, -0.09);
	group.add(throttle);
	{
		const parts = [];
		cyl(parts, 0.011, 0.014, 0.15, { x: 0, y: 0.075, z: 0 });
		// Grip head: chunky fist-sized handle with a thumb ledge.
		box(parts, 0.062, 0.052, 0.13, { x: 0, y: 0.168, z: -0.01 });
		box(parts, 0.07, 0.02, 0.05, { x: 0, y: 0.20, z: -0.045 });
		const lever = new THREE.Mesh(mergeGeometries(parts), mats.grip);
		throttle.add(lever);
		// Red comms slider + white radar-elevation wheel details on the head.
		const slider = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.01, 0.02), mats.red);
		slider.position.set(-0.033, 0.175, -0.02);
		throttle.add(slider);
		const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.006, 12), mats.white);
		wheel.position.set(0.03, 0.168, 0.028); wheel.rotation.z = Math.PI / 2;
		throttle.add(wheel);
	}

	// ---- Rudder pedals -------------------------------------------------------
	const pedals = { left: new THREE.Group(), right: new THREE.Group() };
	for (const [side, sx] of [['left', -1], ['right', 1]]) {
		const p = pedals[side];
		p.position.set(sx * 0.115, -0.72, -0.92);
		const plate = new THREE.Mesh(new THREE.BoxGeometry(0.115, 0.16, 0.014), mats.metal);
		plate.rotation.x = -0.28;
		p.add(plate);
		for (let i = 0; i < 3; i++) {
			const rib = new THREE.Mesh(new THREE.BoxGeometry(0.115, 0.012, 0.006), mats.grip);
			rib.position.set(0, -0.05 + i * 0.05, 0.010);
			rib.rotation.x = -0.28;
			p.add(rib);
		}
		const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.22, 8), mats.metal);
		arm.position.set(0, -0.14, 0.05); arm.rotation.x = 0.5;
		p.add(arm);
		group.add(p);
	}

	// ---- Ejection handle ------------------------------------------------------
	const ejTex = stripedTexture();
	const ejMat = new THREE.MeshStandardMaterial({ map: ejTex, roughness: 0.6 });
	const eject = new THREE.Mesh(new THREE.TorusGeometry(0.046, 0.011, 8, 20), ejMat);
	eject.position.set(0, -0.775, -0.28);
	eject.rotation.x = 1.15;
	group.add(eject);
	box(G.grip, 0.10, 0.02, 0.05, { x: 0, y: -0.808, z: -0.30 });

	// ---- Seat furniture: bolsters, harness, headrest ---------------------------
	box(G.olive, 0.055, 0.24, 0.36, { x: -0.30, y: -0.40, z: 0.28 });
	box(G.olive, 0.055, 0.24, 0.36, { x:  0.30, y: -0.40, z: 0.28 });
	// Shoulder straps converging from behind toward the lap buckle — visible
	// at the lower screen edges when you glance down.
	box(G.olive, 0.048, 0.008, 0.42, { x: -0.095, y: -0.25, z: 0.22 }, { x: -0.85, y: 0.08, z: 0 });
	box(G.olive, 0.048, 0.008, 0.42, { x:  0.095, y: -0.25, z: 0.22 }, { x: -0.85, y: -0.08, z: 0 });
	const buckle = [];
	box(buckle, 0.075, 0.05, 0.02, { x: 0, y: -0.47, z: 0.10 });
	pushGeo(buckle, new THREE.CylinderGeometry(0.016, 0.016, 0.022, 10), { x: 0, y: -0.47, z: 0.10 }, { x: Math.PI / 2, y: 0, z: 0 });
	const buckleMesh = new THREE.Mesh(mergeGeometries(buckle), mats.metal);
	group.add(buckleMesh);
	box(G.olive, 0.17, 0.20, 0.06, { x: 0, y: -0.10, z: 0.545 });

	// ---- Canopy bubble + frames -------------------------------------------------
	// One-piece bubble (sphere scaled to a teardrop-ish dome). Front pole
	// dips behind the glareshield, sides just outside the sills.
	const glassMat = makeCanopyGlassMaterial();
	const bubble = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), glassMat);
	bubble.scale.set(0.47, 0.62, 1.05);
	bubble.position.set(0, -0.20, -0.05);
	bubble.renderOrder = 3;
	bubble.name = 'canopyGlass';
	group.add(bubble);

	// Windscreen bow arc — the frame separating windscreen from canopy,
	// tracing the bubble cross-section at z = -0.60.
	{
		const pts = [];
		const N = 26;
		for (let i = 0; i <= N; i++) {
			const t = -0.066 + (Math.PI + 0.132) * (i / N);
			pts.push(new THREE.Vector3(0.40 * Math.cos(t), -0.20 + 0.53 * Math.sin(t), -0.60));
		}
		const curve = new THREE.CatmullRomCurve3(pts);
		pushGeo(G.metal, new THREE.TubeGeometry(curve, 26, 0.018, 8), { x: 0, y: 0, z: 0 });
		// Inner pad strip along the bow (olive de-mist pad).
		pushGeo(G.olive, new THREE.TubeGeometry(curve, 26, 0.010, 6), { x: 0, y: 0.0, z: 0.012 });
	}
	// Rear canopy arc behind the headrest (mostly seen when checking six).
	{
		const pts = [];
		const N = 22;
		for (let i = 0; i <= N; i++) {
			const t = -0.066 + (Math.PI + 0.132) * (i / N);
			pts.push(new THREE.Vector3(0.37 * Math.cos(t), -0.20 + 0.47 * Math.sin(t), 0.72));
		}
		pushGeo(G.metal, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 22, 0.016, 8), { x: 0, y: 0, z: 0 });
	}

	// ---- Rear-view mirrors on the bow --------------------------------------------
	// Three angled mirror quads: center + two outboard. Polished-metal
	// material catches the directional light as a believable glint.
	const mirrorDefs = [
		{ x: 0,     y: 0.30, z: -0.585, ry: 0,     rx: 0.45 },
		{ x: -0.20, y: 0.25, z: -0.575, ry: 0.35,  rx: 0.42 },
		{ x: 0.20,  y: 0.25, z: -0.575, ry: -0.35, rx: 0.42 },
	];
	for (const md of mirrorDefs) {
		const frame = new THREE.Mesh(new THREE.BoxGeometry(0.082, 0.042, 0.008), mats.grip);
		frame.position.set(md.x, md.y, md.z);
		frame.rotation.set(md.rx, md.ry, 0);
		group.add(frame);
		const face = new THREE.Mesh(new THREE.PlaneGeometry(0.072, 0.034), mats.mirror);
		face.position.set(md.x, md.y, md.z + 0.005);
		face.rotation.set(md.rx, md.ry, 0);
		// Nudge along the frame normal so it sits proud of the frame box.
		face.translateZ(0.001);
		group.add(face);
	}

	// ---- Console switch panels (labeled plates + switches/knobs) -------------------
	// Left console, front to back: FUEL, EXT LT, CMS (countermeasures).
	const leftPlates = [
		{
			z: -0.44, w: 0.20, h: 0.13, title: 'FUEL',
			draw: (g, w, h) => {
				plateTitle(g, w, 'FUEL');
				plateLabel(g, w * 0.28, h * 0.52, 'MASTER', 10);
				plateLabel(g, w * 0.72, h * 0.52, 'DUMP', 10);
				plateLabel(g, w * 0.28, h * 0.88, 'ON', 9, '#6d747a');
				plateLabel(g, w * 0.72, h * 0.88, 'OFF', 9, '#6d747a');
			},
			switches: [{ dx: -0.045, dz: 0.012, on: true }, { dx: 0.045, dz: 0.012, on: false }],
		},
		{
			z: -0.28, w: 0.20, h: 0.13, title: 'EXT LT',
			draw: (g, w, h) => {
				plateTitle(g, w, 'EXT LT');
				plateLabel(g, w * 0.2, h * 0.52, 'NAV', 10);
				plateLabel(g, w * 0.5, h * 0.52, 'STROBE', 10);
				plateLabel(g, w * 0.8, h * 0.52, 'FORM', 10);
			},
			switches: [{ dx: -0.06, dz: 0.012, on: true }, { dx: 0, dz: 0.012, on: false }, { dx: 0.06, dz: 0.012, on: true }],
		},
		{
			z: 0.12, w: 0.22, h: 0.15, title: 'CMS',
			draw: (g, w, h) => {
				plateTitle(g, w, 'CMS — CM DISPENSE');
				plateLabel(g, w * 0.25, h * 0.45, 'FLARE', 10);
				plateLabel(g, w * 0.75, h * 0.45, 'CHAFF', 10);
				plateLabel(g, w * 0.5, h * 0.78, 'PGM  AUTO / MAN', 9, '#6d747a');
			},
			switches: [{ dx: -0.05, dz: 0.005, on: true }, { dx: 0.05, dz: 0.005, on: true }],
			knobs: [{ dx: 0, dz: 0.045, ang: 0.7 }],
		},
	];
	// Right console: ECS, COMM, IFF / LIGHTING.
	const rightPlates = [
		{
			z: -0.44, w: 0.20, h: 0.13, title: 'ECS',
			draw: (g, w, h) => {
				plateTitle(g, w, 'ECS');
				plateLabel(g, w * 0.3, h * 0.55, 'TEMP', 10);
				plateLabel(g, w * 0.72, h * 0.55, 'DEFOG', 10);
			},
			knobs: [{ dx: -0.04, dz: 0.01, ang: -0.5 }],
			switches: [{ dx: 0.045, dz: 0.01, on: true }],
		},
		{
			z: -0.27, w: 0.22, h: 0.16, title: 'COMM',
			draw: (g, w, h) => {
				plateTitle(g, w, 'COMM 1 / COMM 2');
				// Painted frequency window — static but convincing.
				g.fillStyle = '#04140a';
				g.fillRect(w * 0.24, h * 0.34, w * 0.52, h * 0.22);
				g.fillStyle = '#4bff96';
				g.font = `700 ${Math.round(w * 0.09)}px 'Courier New', monospace`;
				g.textAlign = 'center';
				g.fillText('251.750', w * 0.5, h * 0.51);
				plateLabel(g, w * 0.2, h * 0.85, 'VOL', 9, '#6d747a');
				plateLabel(g, w * 0.8, h * 0.85, 'CHAN', 9, '#6d747a');
			},
			knobs: [{ dx: -0.065, dz: 0.045, ang: 0.3 }, { dx: 0.065, dz: 0.045, ang: -0.9 }],
		},
		{
			z: 0.12, w: 0.22, h: 0.15, title: 'IFF',
			draw: (g, w, h) => {
				plateTitle(g, w, 'IFF / INT LT');
				plateLabel(g, w * 0.28, h * 0.5, 'MODE 4', 10);
				plateLabel(g, w * 0.72, h * 0.5, 'FLOOD', 10);
			},
			knobs: [{ dx: -0.05, dz: 0.01, ang: 1.2 }],
			switches: [{ dx: 0.05, dz: 0.01, on: true }, { dx: 0.05, dz: 0.045, on: false }],
		},
	];
	for (const [defs, sx] of [[leftPlates, -1], [rightPlates, 1]]) {
		for (const pd of defs) {
			const plate = labelPlate(pd.w, pd.h, 256, pd.draw);
			// Lay flat on the console top (normal up, text top pointing away
			// from the pilot — read like a desk from a chair).
			plate.rotation.x = -Math.PI / 2;
			plate.position.set(sx * 0.325, -0.4415, pd.z);
			group.add(plate);
			for (const sw of (pd.switches || [])) {
				toggleSwitch(G.metal, sx * 0.325 + sw.dx, -0.438, pd.z + (sw.dz || 0), sw.on, null);
			}
			for (const kn of (pd.knobs || [])) {
				knob(G.metal, G.grip, sx * 0.325 + kn.dx, -0.438, pd.z + (kn.dz || 0), kn.ang, null);
			}
		}
	}

	// ---- Gear lever (panel left-low) + canopy handle (right sill) -------------------
	{
		const lever = [];
		cyl(lever, 0.006, 0.006, 0.075, { x: 0, y: 0.038, z: 0 }, { x: 0.35, y: 0, z: 0 });
		const leverMesh = new THREE.Mesh(mergeGeometries(lever), mats.metal);
		leverMesh.position.set(-0.365, -0.655, -0.60);
		group.add(leverMesh);
		const wheelKnob = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.012, 12), mats.white);
		wheelKnob.position.set(-0.365, -0.615, -0.613);
		wheelKnob.rotation.z = Math.PI / 2;
		group.add(wheelKnob);
	}
	box(G.red, 0.05, 0.014, 0.02, { x: D.sillX - 0.03, y: D.sillY - 0.015, z: 0.18 });

	// ---- Merge the static shell batches ----------------------------------------------
	for (const [key, list] of Object.entries(G)) {
		if (!list.length) continue;
		const mesh = new THREE.Mesh(mergeGeometries(list), mats[key]);
		mesh.name = `cockpit_${key}`;
		group.add(mesh);
	}

	return { group, panelGroup, stick, throttle, pedals, mats, glassMat };
}
