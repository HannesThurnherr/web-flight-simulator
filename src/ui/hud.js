import { setMinimapCamera, getMiniViewer, getViewer, setPauseMinimapCamera, getPauseMiniViewer } from '../world/cesiumWorld';
import { calculateDistance } from '../world/regions';
import * as Cesium from 'cesium';

export class HUD {
	constructor() {
		this.speedElem = document.getElementById('speed');
		this.altElem = document.getElementById('altitude');
		this.timeElem = document.getElementById('time');
		this.scoreElem = document.getElementById('score');
		this.fpsElem = document.getElementById('fps');
		this.localDateTimeElem = document.getElementById('local-datetime');
		this.coordsElem = document.getElementById('coords');
		this.minimapCanvas = document.getElementById('minimap');
		this.miniCtx = this.minimapCanvas.getContext('2d');

		this.pauseMinimapCanvas = document.getElementById('pauseMinimap');
		if (this.pauseMinimapCanvas) {
			this.pauseMiniCtx = this.pauseMinimapCanvas.getContext('2d');
		}
		this.pauseRegionElem = document.getElementById('pause-region');
		this.pauseLatElem = document.getElementById('pause-lat');
		this.pauseLonElem = document.getElementById('pause-lon');
		this.pauseAltElem = document.getElementById('pause-alt');
		this.pauseTimeElem = document.getElementById('pause-time');

		this.uiContainer = document.getElementById('uiContainer');
		this.compassTape = document.getElementById('compass-tape');
		this.headingDisplay = document.getElementById('heading-display');

		this.regionNotif = document.getElementById('region-notification');
		this.regionNameElem = document.getElementById('region-name');
		this.regionTimeout = null;

		this.pullUpElem = document.getElementById('pull-up-warning');

		this.killNotifContainer = document.getElementById('kill-notification-container');
		this.killTextElem = document.getElementById('kill-text');
		this.killScoreElem = document.getElementById('kill-score');
		this.killTimeout = null;

		this.weaponElems = {
			gun: document.getElementById('weapon-gun'),
			missile: document.getElementById('weapon-missile'),
			flare: document.getElementById('weapon-flare')
		};
		this.weaponAmmoElems = {
			gun: this.weaponElems.gun.querySelector('.weapon-ammo'),
			missile: this.weaponElems.missile.querySelector('.weapon-ammo'),
			flare: this.weaponElems.flare.querySelector('.weapon-ammo')
		};
		this.weaponProgressElems = {
			gun: this.weaponElems.gun.querySelector('.weapon-progress'),
			missile: this.weaponElems.missile.querySelector('.weapon-progress'),
			flare: this.weaponElems.flare.querySelector('.weapon-progress')
		};

		this.vignette = document.getElementById('transition-vignette');

		this.startTime = Date.now();

		this.smoothedPitch = 0;
		this.smoothedRoll = 0;
		this.smoothedHeading = 0;
		this.smoothedThrottle = 0;
		this.smoothedYaw = 0;
		this.smoothedBoostScale = 1.0;
		this.currentShakeX = 0;
		this.currentShakeY = 0;

		this.minimapRange = 1;
		this.showHorizonLines = false;

		this.npcMarkers = new Map();
		this.npcContainer = document.createElement('div');
		this.npcContainer.id = 'npc-markers-layer';
		this.npcContainer.style.cssText = 'position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:15;';
		this.uiContainer.appendChild(this.npcContainer);

		this.createHorizon();
		this.createMissileCrosshair();
		this.createCompass();
		this.createFlightDataPanel();
		this.createStallWarning();
		this.createAfterburnerIndicator();
		this.createMissileDebugPanel();
		this.createMissileMarkerLayer();
		this.createMouseSteeringOverlay();
		this.createRwrScope();
		this.resizeMinimap();
		window.addEventListener('resize', () => this.resizeMinimap());
	}

	// RWR scope: round display, your nose points to the top, hostile radars
	// currently illuminating the aircraft show up as chevrons at their
	// bearing. Radius maps inversely to signal strength — strong painters
	// draw close to centre, like a real scope.
	createRwrScope() {
		const NS = 'http://www.w3.org/2000/svg';
		const size = 100;
		const svg = document.createElementNS(NS, 'svg');
		svg.id = 'rwr-scope';
		svg.setAttribute('width',  size);
		svg.setAttribute('height', size);
		svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
		// Offset right of screen center so the scope doesn't overlap the
		// compass heading tape that lives along the top middle.
		svg.style.cssText = `
			position: absolute;
			top: 16px;
			left: 75%;
			transform: translateX(-50%);
			pointer-events: none;
			z-index: 10;
			filter: drop-shadow(0 0 4px rgba(0,0,0,0.6));
		`;

		const cx = size / 2, cy = size / 2, r = size / 2 - 4;
		const ring = (radius) => {
			const el = document.createElementNS(NS, 'circle');
			el.setAttribute('cx', cx); el.setAttribute('cy', cy);
			el.setAttribute('r', radius);
			el.setAttribute('fill', 'rgba(0, 20, 0, 0.55)');
			el.setAttribute('stroke', 'rgba(0, 255, 0, 0.5)');
			el.setAttribute('stroke-width', 1);
			return el;
		};
		svg.appendChild(ring(r));
		svg.appendChild(ring(r * 0.66));
		svg.appendChild(ring(r * 0.33));

		// Tick marks at N/E/S/W relative to the aircraft nose (nose = up).
		const tick = (ang, len) => {
			const a = ang - Math.PI / 2; // -π/2 so 0 rad points up
			const x1 = cx + Math.cos(a) * r;
			const y1 = cy + Math.sin(a) * r;
			const x2 = cx + Math.cos(a) * (r - len);
			const y2 = cy + Math.sin(a) * (r - len);
			const line = document.createElementNS(NS, 'line');
			line.setAttribute('x1', x1); line.setAttribute('y1', y1);
			line.setAttribute('x2', x2); line.setAttribute('y2', y2);
			line.setAttribute('stroke', 'rgba(0, 255, 0, 0.7)');
			line.setAttribute('stroke-width', 1.2);
			return line;
		};
		for (let i = 0; i < 4; i++) svg.appendChild(tick(i * Math.PI / 2, 8));

		// "NOSE" cue at top so it's unambiguous which way is forward.
		const noseLabel = document.createElementNS(NS, 'text');
		noseLabel.setAttribute('x', cx);
		noseLabel.setAttribute('y', 10);
		noseLabel.setAttribute('fill', '#0f0');
		noseLabel.setAttribute('font-family', 'AceCombat, monospace');
		noseLabel.setAttribute('font-size', '8');
		noseLabel.setAttribute('text-anchor', 'middle');
		noseLabel.textContent = 'RWR';
		svg.appendChild(noseLabel);

		// Container for contact chevrons; rebuilt each frame in update.
		const contactGroup = document.createElementNS(NS, 'g');
		contactGroup.id = 'rwr-contacts';
		svg.appendChild(contactGroup);

		this.uiContainer.appendChild(svg);
		this.rwrScope = { svg, contactGroup, size, cx, cy, r };
	}

	updateRwrScope(state) {
		const s = this.rwrScope;
		if (!s) return;
		const rwr = state && state.rwr;
		// Clear previous contacts.
		while (s.contactGroup.firstChild) s.contactGroup.removeChild(s.contactGroup.firstChild);
		if (!rwr || rwr.size === 0) return;

		const NS = 'http://www.w3.org/2000/svg';
		for (const [, c] of rwr) {
			// Bearing is in the aircraft's body frame (0 = nose, +right).
			// SVG angle = bearing - π/2 so nose goes to top of scope.
			const ang = (c.bearing || 0) - Math.PI / 2;
			// Stronger signal → closer to centre, like a real scope.
			const strength = Math.max(0, Math.min(1, c.strength || 0.1));
			const radius = s.r * (1 - 0.75 * strength);
			const x = s.cx + Math.cos(ang) * radius;
			const y = s.cy + Math.sin(ang) * radius;

			const color = c.lockType === 'track' ? '#ff4040' : '#ffcc00';

			// Chevron: triangle pointing toward the aircraft centre, i.e.
			// showing the bearing the threat is on.
			const chev = document.createElementNS(NS, 'polygon');
			const size = 5;
			const toCenterAng = Math.atan2(s.cy - y, s.cx - x);
			const p = (t, perp) => {
				const ax = Math.cos(toCenterAng + perp) * t;
				const ay = Math.sin(toCenterAng + perp) * t;
				return [x + ax, y + ay];
			};
			const [x1, y1] = p(size, 0);
			const [x2, y2] = p(size * 0.8,  Math.PI * 0.85);
			const [x3, y3] = p(size * 0.8, -Math.PI * 0.85);
			chev.setAttribute('points', `${x1},${y1} ${x2},${y2} ${x3},${y3}`);
			chev.setAttribute('fill', color);
			chev.setAttribute('stroke', '#000');
			chev.setAttribute('stroke-width', 0.6);
			s.contactGroup.appendChild(chev);

			// Small label showing lock type.
			if (c.lockType === 'track') {
				const lbl = document.createElementNS(NS, 'text');
				lbl.setAttribute('x', x);
				lbl.setAttribute('y', y + 13);
				lbl.setAttribute('fill', '#ff4040');
				lbl.setAttribute('font-family', 'AceCombat, monospace');
				lbl.setAttribute('font-size', '7');
				lbl.setAttribute('text-anchor', 'middle');
				lbl.textContent = 'STT';
				s.contactGroup.appendChild(lbl);
			}
		}
	}

	// SVG overlay that shows a line from screen center to the cursor plus a
	// dot at each end, visible only when mouse-steering mode is active.
	// Drawn with SVG because single-pixel diagonal lines look crisper than
	// CSS transforms and don't need per-frame width/angle trig in JS.
	createMouseSteeringOverlay() {
		const NS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(NS, 'svg');
		svg.id = 'mouse-steering-overlay';
		svg.setAttribute('width',  '100%');
		svg.setAttribute('height', '100%');
		svg.style.cssText = `
			position: absolute; top: 0; left: 0;
			width: 100%; height: 100%;
			pointer-events: none;
			z-index: 25;
			display: none;
		`;

		const line = document.createElementNS(NS, 'line');
		line.setAttribute('stroke', '#0f0');
		line.setAttribute('stroke-width', '1.2');
		line.setAttribute('stroke-opacity', '0.7');
		line.setAttribute('stroke-dasharray', '4 4');
		svg.appendChild(line);

		const centerDot = document.createElementNS(NS, 'circle');
		centerDot.setAttribute('r', '3');
		centerDot.setAttribute('fill', '#0f0');
		svg.appendChild(centerDot);

		const cursorDot = document.createElementNS(NS, 'circle');
		cursorDot.setAttribute('r', '5');
		cursorDot.setAttribute('fill', 'none');
		cursorDot.setAttribute('stroke', '#0f0');
		cursorDot.setAttribute('stroke-width', '1.5');
		svg.appendChild(cursorDot);

		const badge = document.createElementNS(NS, 'text');
		badge.setAttribute('fill', '#0f0');
		badge.setAttribute('font-family', 'AceCombat, monospace');
		badge.setAttribute('font-size', '11');
		badge.setAttribute('letter-spacing', '2');
		badge.textContent = 'MOUSE STEER';
		svg.appendChild(badge);

		this.uiContainer.appendChild(svg);
		this.mouseSteerOverlay = { svg, line, centerDot, cursorDot, badge };
	}

	updateMouseSteeringOverlay(state) {
		const o = this.mouseSteerOverlay;
		if (!o) return;
		if (!state.mouseSteering) {
			o.svg.style.display = 'none';
			return;
		}
		o.svg.style.display = 'block';

		const cx = window.innerWidth  / 2;
		const cy = window.innerHeight / 2;
		const x  = state.cursorX ?? cx;
		const y  = state.cursorY ?? cy;

		o.line.setAttribute('x1', cx); o.line.setAttribute('y1', cy);
		o.line.setAttribute('x2', x);  o.line.setAttribute('y2', y);
		o.centerDot.setAttribute('cx', cx); o.centerDot.setAttribute('cy', cy);
		o.cursorDot.setAttribute('cx', x);  o.cursorDot.setAttribute('cy', y);
		o.badge.setAttribute('x', cx + 10);
		o.badge.setAttribute('y', cy - 10);
	}

	// Separate DOM layer for live missile labels. Keeping a pool of marker
	// elements keyed on missile identity avoids thrashing the DOM every
	// frame for an airborne missile's label update.
	createMissileMarkerLayer() {
		this.missileMarkers = new Map();
		this.missileMarkerLayer = document.createElement('div');
		this.missileMarkerLayer.id = 'missile-markers-layer';
		this.missileMarkerLayer.style.cssText = `
			position: absolute; top: 0; left: 0;
			width: 100%; height: 100%;
			pointer-events: none; z-index: 14;
		`;
		this.uiContainer.appendChild(this.missileMarkerLayer);
	}

	_createMissileMarkerElement() {
		// Anchor the container's (left, top) at the missile's screen position.
		// Dot and label are absolutely positioned inside, so the dot is
		// exactly on the missile and the label floats to its right — no
		// flex layout games that shift the anchor when label width changes.
		const el = document.createElement('div');
		el.className = 'missile-marker';
		el.style.cssText = `
			position: absolute;
			width: 0; height: 0;
			pointer-events: none;
			color: #ffc040;
			font-family: 'AceCombat', monospace;
			font-size: 11px;
			letter-spacing: 1px;
			text-shadow: 0 0 6px rgba(255, 180, 0, 0.8);
		`;
		const dot = document.createElement('div');
		dot.style.cssText = `
			position: absolute;
			left: -4px; top: -4px;
			width: 8px; height: 8px;
			border-radius: 50%;
			background: #ffc040;
			box-shadow: 0 0 8px rgba(255, 180, 0, 0.9);
		`;
		const label = document.createElement('div');
		label.style.cssText = `
			position: absolute;
			left: 10px; top: -8px;
			white-space: nowrap;
		`;
		el.appendChild(dot);
		el.appendChild(label);
		this.missileMarkerLayer.appendChild(el);
		return { el, dot, label };
	}

	updateMissileMarkers(state) {
		if (!this.missileMarkerLayer) return;
		// Both pools: player's outgoing + NPC-fired incoming. We want ALL
		// live missiles the player should know about on the HUD.
		const playerPool = (state.weaponSystem && state.weaponSystem.projectiles) || [];
		const npcPool    = (state.npcProjectiles) || [];
		const projectiles = playerPool.concat(npcPool);

		const viewer = getViewer();
		if (!viewer) { this._hideAllMissileMarkers(); return; }

		const scene  = viewer.scene;
		const camera = scene.camera;
		const activeIds = new Set();
		const playerTeam = state.team || 'friendly';

		for (let i = 0; i < projectiles.length; i++) {
			const m = projectiles[i];
			// Only AMRAAM-ish missiles get labels — otherwise the HUD clutters
			// fast with bullets & AIM-9 tags.
			if (!m.active || typeof m.boostRemaining !== 'number') continue;

			// Visibility rule: the pilot always knows what *they* launched
			// (friendly outgoing). Hostile incoming missiles only appear if
			// one of the pilot's sensor channels has a contact on them —
			// so a very stealthy, never-detected missile would never show,
			// and a detected one flips on live as MAWS picks it up.
			const isOwnTeam = (m.team || 'friendly') === playerTeam;
			const detected = isOwnTeam ||
				(state.contacts && state.contacts.has(m));
			if (!detected) continue;

			const id = m.id || (m.id = `m${i}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
			activeIds.add(id);

			let marker = this.missileMarkers.get(id);
			if (!marker) {
				marker = this._createMissileMarkerElement();
				this.missileMarkers.set(id, marker);
			}
			// Color per team: own missiles stay amber (existing cue), hostile
			// in red so an incoming launch is unmistakable.
			const color = isOwnTeam ? '#ffc040' : '#ff4040';
			marker.dot.style.background = color;
			marker.dot.style.boxShadow  = `0 0 8px ${color}`;
			marker.label.style.color    = color;
			marker.el.style.textShadow  = `0 0 6px ${color}`;

			const pos = Cesium.Cartesian3.fromDegrees(m.lon, m.lat, m.alt);
			const direction = Cesium.Cartesian3.subtract(pos, camera.position, new Cesium.Cartesian3());
			const depth = Cesium.Cartesian3.dot(direction, camera.direction);
			const transformFunc = Cesium.SceneTransforms.worldToWindowCoordinates || Cesium.SceneTransforms.wgs84ToWindowCoordinates;
			const windowPos = transformFunc ? transformFunc(scene, pos) : null;

			const onScreen = windowPos && depth > 0 &&
				windowPos.x >= 0 && windowPos.x <= window.innerWidth &&
				windowPos.y >= 0 && windowPos.y <= window.innerHeight;

			if (!onScreen) {
				marker.el.style.display = 'none';
				continue;
			}
			marker.el.style.display = 'flex';
			marker.el.style.left = `${windowPos.x}px`;
			marker.el.style.top  = `${windowPos.y}px`;

			const spd = Math.round(m.speed);
			const phase = m.boostRemaining > 0 ? 'BOOST' : 'COAST';
			const typeTag = m.type || 'MSL';
			const prefix = isOwnTeam ? '' : 'INBOUND ';
			marker.label.innerText = `${prefix}${typeTag} ${phase}  ${spd}m/s`;
		}

		// Prune markers whose missile is gone (destroyed or despawned).
		for (const [id, marker] of this.missileMarkers) {
			if (!activeIds.has(id)) {
				marker.el.remove();
				this.missileMarkers.delete(id);
			}
		}
	}

	_hideAllMissileMarkers() {
		for (const [, m] of this.missileMarkers) m.el.style.display = 'none';
	}

	// Compact list of all in-flight missiles. One line per missile — type,
	// phase, range-to-target, target name, heading error. Hidden when none
	// are airborne. For detailed stats on a specific missile the player can
	// open the map view (M) and click it.
	createMissileDebugPanel() {
		if (document.getElementById('missile-debug-panel')) return;
		const p = document.createElement('div');
		p.id = 'missile-debug-panel';
		p.style.cssText = `
			position: absolute;
			top: 16px;
			right: 16px;
			padding: 8px 12px;
			border: 1px solid rgba(255, 180, 0, 0.6);
			background: rgba(30, 20, 0, 0.55);
			color: #ffc040;
			font-family: 'AceCombat', monospace;
			font-size: 12px;
			line-height: 1.45;
			letter-spacing: 1px;
			text-shadow: 0 0 6px rgba(255, 180, 0, 0.7);
			pointer-events: none;
			z-index: 10;
			min-width: 240px;
			display: none;
		`;
		this.uiContainer.appendChild(p);
		this.missilePanel = p;
	}

	updateMissileDebugPanel(state) {
		if (!this.missilePanel) return;
		const projectiles = (state.weaponSystem && state.weaponSystem.projectiles) || [];
		const active = projectiles.filter(p => p.active && typeof p.boostRemaining === 'number');
		if (active.length === 0) { this.missilePanel.style.display = 'none'; return; }

		const rows = [
			`<div style="font-weight:bold; margin-bottom:4px;">MSL IN FLIGHT  ${active.length}</div>`,
		];
		for (let i = 0; i < active.length; i++) {
			const m = active[i];
			const d = m.debug || {};
			const typeTag = (m.type || 'MSL').padEnd(7);
			const phase   = m.boostRemaining > 0 ? `BOOST ${m.boostRemaining.toFixed(1)}s` : 'COAST      ';
			const rng     = typeof d.rangeToTarget === 'number'
				? `${(d.rangeToTarget / 1000).toFixed(1)}km`.padStart(6)
				: '  —  ';
			const tgt     = (d.targetName || (m.target && m.target.name) || '—').slice(0, 14);
			const hdgErr  = typeof d.headingError === 'number' ? d.headingError : 0;
			const errTxt  = `err ${hdgErr.toFixed(0)}°`;
			const errCol  = Math.abs(hdgErr) > 20 ? '#ff4040'
				: (Math.abs(hdgErr) > 5 ? '#ffcc00' : '#40ff40');
			rows.push(
				`<div style="white-space:pre; font-family:monospace;">` +
				`${(i + 1).toString().padStart(2)}: ${typeTag} ${phase}  ${rng}  ` +
				`<span style="color:${errCol}">${errTxt.padEnd(9)}</span>` +
				`<span style="opacity:0.75">tgt ${tgt}</span>` +
				`</div>`,
			);
		}
		this.missilePanel.innerHTML = rows.join('');
		this.missilePanel.style.display = 'block';
	}

	// Phase 5 HUD: AoA / G-load / VSI readouts plus stall & AB indicators.
	// All styled to match the existing green-monochrome avionics look so the
	// new readouts don't feel bolted-on.
	createFlightDataPanel() {
		if (document.getElementById('flight-data-panel')) return;
		const panel = document.createElement('div');
		panel.id = 'flight-data-panel';
		panel.style.cssText = `
			position: absolute;
			top: 50%;
			left: 16px;
			transform: translateY(-50%);
			padding: 10px 14px;
			border: 1px solid rgba(0, 255, 0, 0.4);
			background: rgba(0, 20, 0, 0.35);
			color: #0f0;
			font-family: 'AceCombat', monospace;
			font-size: 14px;
			line-height: 1.5;
			letter-spacing: 1px;
			text-shadow: 0 0 6px rgba(0, 255, 0, 0.7);
			pointer-events: none;
			z-index: 10;
			min-width: 130px;
		`;
		panel.innerHTML = `
			<div><span style="opacity:0.7">AOA </span><span id="hud-aoa">  0.0°</span></div>
			<div><span style="opacity:0.7">G   </span><span id="hud-g">  1.0</span></div>
			<div><span style="opacity:0.7">V/S </span><span id="hud-vs">    0</span></div>
			<div><span style="opacity:0.7">SLIP</span><span id="hud-beta">  0.0°</span></div>
			<div style="margin-top:8px; display:flex; align-items:center;">
				<span style="opacity:0.7; margin-right:6px;">THR</span>
				<div id="hud-thrust-bar" style="
					position:relative;
					width:90px; height:10px;
					border:1px solid rgba(0,255,0,0.5);
					background:rgba(0,20,0,0.5);
				">
					<!-- Fill: 0..100% of bar = 0..mil thrust. -->
					<div id="hud-thrust-fill" style="
						position:absolute; top:0; left:0; height:100%;
						background:#0f0;
						width:0%;
					"></div>
					<!-- AB overlay: glows amber when afterburner lit. -->
					<div id="hud-thrust-ab" style="
						position:absolute; top:0; left:0; height:100%;
						width:100%;
						background:repeating-linear-gradient(
							45deg, rgba(255,180,0,0.85), rgba(255,180,0,0.85) 4px,
							rgba(255,120,0,0.6) 4px, rgba(255,120,0,0.6) 8px);
						opacity:0;
						transition:opacity 0.12s;
					"></div>
				</div>
				<span id="hud-thrust-pct" style="margin-left:6px; min-width:30px;">  0%</span>
			</div>
		`;
		this.uiContainer.appendChild(panel);
		this.aoaElem       = document.getElementById('hud-aoa');
		this.gElem         = document.getElementById('hud-g');
		this.vsElem        = document.getElementById('hud-vs');
		this.betaElem      = document.getElementById('hud-beta');
		this.thrustFill    = document.getElementById('hud-thrust-fill');
		this.thrustAB      = document.getElementById('hud-thrust-ab');
		this.thrustPctElem = document.getElementById('hud-thrust-pct');
	}

	createStallWarning() {
		if (document.getElementById('stall-warning')) return;
		const w = document.createElement('div');
		w.id = 'stall-warning';
		w.style.cssText = `
			position: absolute;
			top: 28%;
			left: 50%;
			transform: translateX(-50%);
			padding: 6px 16px;
			color: #ff4040;
			border: 2px solid #ff4040;
			background: rgba(40, 0, 0, 0.3);
			font-family: 'AceCombat', monospace;
			font-size: 22px;
			font-weight: bold;
			letter-spacing: 3px;
			text-shadow: 0 0 10px rgba(255, 64, 64, 0.9);
			pointer-events: none;
			z-index: 20;
			display: none;
		`;
		w.innerText = 'STALL';
		this.uiContainer.appendChild(w);
		this.stallElem = w;
	}

	createAfterburnerIndicator() {
		if (document.getElementById('ab-indicator')) return;
		const ind = document.createElement('div');
		ind.id = 'ab-indicator';
		ind.style.cssText = `
			position: absolute;
			bottom: 80px;
			left: 16px;
			padding: 4px 10px;
			color: #ffcc00;
			border: 1px solid #ffcc00;
			background: rgba(40, 20, 0, 0.3);
			font-family: 'AceCombat', monospace;
			font-size: 14px;
			letter-spacing: 2px;
			text-shadow: 0 0 8px rgba(255, 200, 0, 0.8);
			pointer-events: none;
			z-index: 10;
			opacity: 0;
			transition: opacity 0.15s ease-in-out;
		`;
		ind.innerText = 'A/B';
		this.uiContainer.appendChild(ind);
		this.abElem = ind;
	}

	createMissileCrosshair() {
		if (document.getElementById('missile-crosshair')) return;

		const cross = document.createElement('div');
		cross.id = 'missile-crosshair';
		cross.style.cssText = `
			position: absolute;
			left: 50%;
			top: 50%;
			transform: translate(-50%, -50%);
			width: 220px;
			height: 220px;
			display: none;
		`;

		const innerRing = document.createElement('div');
		innerRing.style.cssText = `
			position:absolute; left:50%; top:50%; width:76px; height:76px; transform:translate(-50%,-50%);
			border-radius:50%;
			border:2px solid #0f0;
		`;

		const centerDot = document.createElement('div');
		centerDot.style.cssText = `position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:10px; height:10px; border-radius:50%; background:#0f0;`;

		const makeTick = (left, top, w, h, translate) => {
			const t = document.createElement('div');
			t.style.cssText = `position:absolute; left:${left}; top:${top}; width:${w}; height:${h}; background:#0f0; transform:${translate};`;
			return t;
		};

		const tickOffset = 48;
		const tickLen = 18;

		const leftTick = makeTick('calc(50% - ' + tickOffset + 'px - ' + (tickLen / 2) + 'px)', '50%', '18px', '2px', 'translateY(-50%)');
		const rightTick = makeTick('calc(50% + ' + tickOffset + 'px - ' + (tickLen / 2) + 'px)', '50%', '18px', '2px', 'translateY(-50%)');
		const topTick = makeTick('50%', 'calc(50% - ' + tickOffset + 'px - ' + (tickLen / 2) + 'px)', '2px', tickLen + 'px', 'translateX(-50%)');

		cross.appendChild(innerRing);
		cross.appendChild(centerDot);
		cross.appendChild(topTick);
		cross.appendChild(leftTick);
		cross.appendChild(rightTick);

		const horizon = document.getElementById('horizon-container');
		if (horizon) horizon.appendChild(cross);
		else this.uiContainer.appendChild(cross);
		this.missileCrosshair = cross;
	}

	// Refresh the AoA / G / VSI / sideslip readouts plus stall & AB cues.
	// Stall warning fires when α exceeds ~80% of the stall angle, giving the
	// pilot a buffer before lift actually drops. G and AoA change color as
	// they approach their respective limits to communicate risk at a glance.
	updateFlightData(state) {
		if (!this.aoaElem) return;

		const alphaDeg = (state.alpha || 0) * 180 / Math.PI;
		const betaDeg  = (state.sideslip || 0) * 180 / Math.PI;
		const g        = state.loadFactor || 0;
		const vsFpm    = Math.round((state.verticalSpeed || 0) * 196.85); // m/s → ft/min

		this.aoaElem.innerText = `${alphaDeg.toFixed(1).padStart(6)}°`;
		this.gElem.innerText   = `${g.toFixed(1).padStart(5)}`;
		this.vsElem.innerText  = `${vsFpm >= 0 ? '+' : ''}${vsFpm.toString().padStart(5)}`;
		this.betaElem.innerText = `${betaDeg.toFixed(1).padStart(6)}°`;

		// Color cues: amber when approaching limits, red when at/beyond.
		const aoaAbs = Math.abs(alphaDeg);
		let aoaColor = '#0f0';
		if (aoaAbs > 16) aoaColor = '#ff4040';
		else if (aoaAbs > 12) aoaColor = '#ffcc00';
		this.aoaElem.style.color = aoaColor;

		const gAbs = Math.abs(g);
		let gColor = '#0f0';
		if (state.gLimiterActive) gColor = '#ff40ff'; // magenta = FBW limiter active
		else if (gAbs > 9) gColor = '#ff4040';
		else if (gAbs > 7) gColor = '#ffcc00';
		this.gElem.style.color = gColor;

		// Stall warning: 0.8 × stall α (≈ 14.4°) — same threshold a real
		// stick-shaker would fire at.
		const stall = aoaAbs > 14.4;
		if (this.stallElem) {
			if (stall) {
				this.stallElem.style.display = 'block';
				// Blink: modulate opacity on a fast timer.
				const phase = (Date.now() / 120) | 0;
				this.stallElem.style.opacity = (phase & 1) ? '1' : '0.35';
			} else {
				this.stallElem.style.display = 'none';
			}
		}

		if (this.abElem) {
			this.abElem.style.opacity = state.isBoosting ? '1' : '0';
		}

		// Thrust bar: green fill scales with throttle; amber AB overlay lights
		// whenever afterburner is engaged. The fill tracks mil-thrust fraction
		// (0 → full dry thrust), so the bar at 100% = military power.
		if (this.thrustFill) {
			const thr = Math.max(0, Math.min(1, state.throttle || 0));
			this.thrustFill.style.width = `${(thr * 100).toFixed(0)}%`;
		}
		if (this.thrustAB) {
			this.thrustAB.style.opacity = state.isBoosting ? '1' : '0';
		}
		if (this.thrustPctElem) {
			const pct = Math.round((state.throttle || 0) * 100);
			this.thrustPctElem.innerText = `${state.isBoosting ? 'AB' : pct.toString().padStart(3)}${state.isBoosting ? '  ' : '%'}`;
		}
	}

	showMissileCrosshair(shouldShow) {
		if (!this.missileCrosshair) return;
		const normal = document.getElementById('normal-crosshair');
		if (shouldShow) {
			if (normal) normal.style.display = 'none';
			this.missileCrosshair.style.display = 'block';
		} else {
			this.missileCrosshair.style.display = 'none';
			if (normal) normal.style.display = 'flex';
		}
	}

	createCompass() {
		if (!this.compassTape) return;

		const step = 5;
		const pixelsPerDegree = 4;

		this.compassTape.innerHTML = '';

		for (let i = -360; i <= 720; i += step) {
			const tick = document.createElement('div');
			tick.className = 'compass-tick';

			const isMajor = i % 10 === 0;
			const isCardinal = i % 90 === 0;

			tick.style.left = `${(i + 360) * pixelsPerDegree}px`;
			tick.style.height = isMajor ? '10px' : '5px';

			if (isMajor) {
				const label = document.createElement('div');
				label.className = 'compass-label';
				label.style.left = `${(i + 360) * pixelsPerDegree}px`;

				let degree = i % 360;
				if (degree < 0) degree += 360;

				let text = Math.round(degree).toString().padStart(3, '0');
				if (Math.round(degree) === 0 || Math.round(degree) === 360) text = 'N';
				else if (Math.round(degree) === 90) text = 'E';
				else if (Math.round(degree) === 180) text = 'S';
				else if (Math.round(degree) === 270) text = 'W';

				label.innerText = text;
				this.compassTape.appendChild(label);
			}

			this.compassTape.appendChild(tick);
		}
	}

	resetTime() {
		this.startTime = Date.now();
	}

	setMinimapRange(range) {
		this.minimapRange = range;
	}

	setShowHorizonLines(show) {
		this.showHorizonLines = show;
		const lines = document.getElementById('pitch-lines');
		if (lines) {
			lines.style.display = show ? 'block' : 'none';
		}
	}

	showKillNotification(npcName, scoreGain) {
		if (this.killTimeout) clearTimeout(this.killTimeout);

		if (this.killNotifContainer) {
			this.killNotifContainer.classList.remove('hidden');
			this.killNotifContainer.classList.remove('kill-notification-exit');

			const targetText = `${npcName} DESTROYED`;
			const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()';
			let iteration = 0;
			if (this.glitchInterval) clearInterval(this.glitchInterval);

			this.glitchInterval = setInterval(() => {
				if (this.killTextElem) {
					const currentPos = Math.floor(iteration);

					const processedText = targetText.split("")
						.map((char, index) => {
							if (index < currentPos) return targetText[index];
							if (index === currentPos) return chars[Math.floor(Math.random() * chars.length)];
							return "";
						})
						.join("");

					const cursor = currentPos < targetText.length ? (Math.random() > 0.5 ? "_" : " ") : "";
					this.killTextElem.innerText = processedText + cursor;
				}

				if (iteration >= targetText.length) {
					if (this.killTextElem) this.killTextElem.innerText = targetText;
					clearInterval(this.glitchInterval);
				}

				iteration += 1;
			}, 40);

			if (this.killScoreElem) this.killScoreElem.innerText = `+${scoreGain}`;

			this.killNotifContainer.style.animation = 'none';
			this.killNotifContainer.offsetHeight;
			this.killNotifContainer.style.animation = null;

			this.killTimeout = setTimeout(() => {
				this.killNotifContainer.classList.add('kill-notification-exit');

				setTimeout(() => {
					this.killNotifContainer.classList.add('hidden');
					this.killNotifContainer.classList.remove('kill-notification-exit');
				}, 500);

				if (this.glitchInterval) clearInterval(this.glitchInterval);
			}, 3000);
		}
	}

	showRegion(name) {
		if (this.regionTimeout) {
			clearTimeout(this.regionTimeout);
		}

		this.regionNameElem.innerText = name;
		this.regionNotif.classList.remove('hidden');
		this.regionNotif.classList.remove('region-exit');

		this.regionTimeout = setTimeout(() => {
			this.regionNotif.classList.add('region-exit');
			this.regionTimeout = setTimeout(() => {
				this.regionNotif.classList.add('hidden');
				this.regionTimeout = null;
			}, 1000);
		}, 4000);
	}

	setPullUpWarning(shouldShow) {
		if (this.pullUpElem) {
			if (shouldShow) {
				this.pullUpElem.classList.remove('hidden');
			} else {
				this.pullUpElem.classList.add('hidden');
			}
		}
	}

	resizeMinimap() {
		requestAnimationFrame(() => {
			this.minimapCanvas.width = this.minimapCanvas.offsetWidth;
			this.minimapCanvas.height = this.minimapCanvas.offsetHeight;

			if (this.pauseMinimapCanvas) {
				this.pauseMinimapCanvas.width = this.pauseMinimapCanvas.offsetWidth;
				this.pauseMinimapCanvas.height = this.pauseMinimapCanvas.offsetHeight;
			}

			const miniViewer = getMiniViewer();
			if (miniViewer) {
				miniViewer.resize();
			}

			const pauseMiniViewer = getPauseMiniViewer();
			if (pauseMiniViewer) {
				pauseMiniViewer.resize();
			}
		});
	}

	createHorizon() {
		if (!document.getElementById('horizon-container')) {
			const ui = document.getElementById('uiContainer');
			const horizon = document.createElement('div');
			horizon.id = 'horizon-container';
			horizon.style.cssText = `
				position: absolute;
				top: 50%;
				left: 50%;
				width: 600px;
				height: 600px;
				transform: translate(-50%, -50%);
				pointer-events: none;
				overflow: hidden;
			`;

			const crosshair = document.createElement('div');
			crosshair.id = 'normal-crosshair';
			crosshair.style.cssText = 'position:absolute; top:50%; left:50%; width:120px; height:48px; transform:translate(-50%,-50%); pointer-events:none;';

			const ring = document.createElement('div');
			ring.style.cssText = 'position:absolute; left:50%; top:50%; width:12px; height:12px; transform:translate(-50%,-50%); border-radius:50%; border:2px solid #0f0; background:transparent;';

			const leftLine = document.createElement('div');
			leftLine.style.cssText = 'position:absolute; top:50%; left:calc(50% - 6px - 20px); width:20px; height:2px; transform:translateY(-50%); background:#0f0;';

			const rightLine = document.createElement('div');
			rightLine.style.cssText = 'position:absolute; top:50%; left:calc(50% + 6px); width:20px; height:2px; transform:translateY(-50%); background:#0f0;';

			const topTick = document.createElement('div');
			topTick.style.cssText = 'position:absolute; left:50%; top:calc(50% - 6px - 12px); width:2px; height:12px; transform:translateX(-50%); background:#0f0;';

			crosshair.appendChild(leftLine);
			crosshair.appendChild(rightLine);
			crosshair.appendChild(ring);
			crosshair.appendChild(topTick);
			horizon.appendChild(crosshair);

			const pitchLines = document.createElement('div');
			pitchLines.id = 'pitch-lines';
			pitchLines.style.cssText = `
				position: absolute;
				width: 100%;
				height: 100%;
			`;

			for (let i = -90; i <= 90; i += 10) {
				if (i === 0) continue;
				const line = document.createElement('div');
				line.style.cssText = `
					position: absolute;
					left: 30%;
					width: 40%;
					height: 1px;
					background: rgba(0, 255, 0, 0.5);
					top: ${50 - i}% ;
					text-align: center;
					font-size: 10px;
				`;
				line.innerText = i;
				pitchLines.appendChild(line);
			}

			horizon.appendChild(pitchLines);
			ui.appendChild(horizon);

			this.setShowHorizonLines(this.showHorizonLines);
		}
	}

	updatePauseMenu(state, currentRegionName, npcs = []) {
		if (this.pauseRegionElem) this.pauseRegionElem.innerText = currentRegionName || "UNKNOWN REGION";

		if (this.pauseLatElem) {
			const latDir = state.lat >= 0 ? 'N' : 'S';
			this.pauseLatElem.innerText = `${Math.abs(state.lat).toFixed(4)}°${latDir}`;
		}
		if (this.pauseLonElem) {
			const lonDir = state.lon >= 0 ? 'E' : 'W';
			this.pauseLonElem.innerText = `${Math.abs(state.lon).toFixed(4)}°${lonDir}`;
		}
		if (this.pauseAltElem) {
			const altFeet = Math.max(0, Math.round(state.alt * 3.28084));
			this.pauseAltElem.innerText = `${altFeet.toLocaleString()} FT`;
		}

		if (this.pauseTimeElem) {
			const now = new Date();
			const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
			const tzOffsetHours = Math.round((state.lon || 0) / 15);
			const localDate = new Date(utc + (3600000 * tzOffsetHours));

			const yyyy = localDate.getFullYear();
			const mm = (localDate.getMonth() + 1).toString().padStart(2, '0');
			const dd = localDate.getDate().toString().padStart(2, '0');
			const hh = localDate.getHours().toString().padStart(2, '0');
			const min = localDate.getMinutes().toString().padStart(2, '0');
			const ss = localDate.getSeconds().toString().padStart(2, '0');

			this.pauseTimeElem.innerText = `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}Z`;
		}

		const zoomAlt = this.minimapRange * 10000;
		setPauseMinimapCamera(state.lon, state.lat, zoomAlt, 0);

		if (!this.pauseMiniCtx || !this.pauseMinimapCanvas) return;
		const ctx = this.pauseMiniCtx;
		const w = this.pauseMinimapCanvas.width;
		const h = this.pauseMinimapCanvas.height;
		const centerX = w / 2;
		const centerY = h / 2;

		ctx.clearRect(0, 0, w, h);

		ctx.strokeStyle = 'rgba(0, 255, 0, 0.2)';
		ctx.lineWidth = 1;
		const gridSize = 50;

		ctx.beginPath();
		for (let x = centerX; x <= w; x += gridSize) {
			ctx.moveTo(x, 0); ctx.lineTo(x, h);
		}
		for (let x = centerX - gridSize; x >= 0; x -= gridSize) {
			ctx.moveTo(x, 0); ctx.lineTo(x, h);
		}
		for (let y = centerY; y <= h; y += gridSize) {
			ctx.moveTo(0, y); ctx.lineTo(w, y);
		}
		for (let y = centerY - gridSize; y >= 0; y -= gridSize) {
			ctx.moveTo(0, y); ctx.lineTo(w, y);
		}
		ctx.stroke();

		ctx.strokeStyle = '#0f0';
		ctx.lineWidth = 2;
		const size = 15;
		ctx.beginPath();
		ctx.moveTo(centerX - size, centerY); ctx.lineTo(centerX + size, centerY);
		ctx.moveTo(centerX, centerY - size); ctx.lineTo(centerX, centerY + size);
		ctx.stroke();

		ctx.fillStyle = '#0f0';
		ctx.font = '12px AceCombat';
		ctx.fillText("YOU", centerX + 20, centerY + 5);

		const verticalMeters = zoomAlt * 1.1547;
		const pixelsPerMeter = h / verticalMeters;

		npcs.forEach(npc => {
			const dx_m = (npc.lon - state.lon) * 111320 * Math.cos(state.lat * Math.PI / 180);
			const dy_m = (npc.lat - state.lat) * 111320;

			const px = centerX + dx_m * pixelsPerMeter;
			const py = centerY - dy_m * pixelsPerMeter;

			if (px < 0 || px > w || py < 0 || py > h) return;

			ctx.strokeStyle = '#fff';
			ctx.lineWidth = 2;
			ctx.save();
			ctx.translate(px, py);
			ctx.rotate(45 * Math.PI / 180);
			ctx.beginPath();
			ctx.rect(-5, -5, 10, 10);
			ctx.stroke();
			ctx.restore();

			ctx.fillStyle = '#fff';
			ctx.font = '10px AceCombat';
			ctx.fillText(npc.name || "BOGEY", px + 10, py + 5);
		});
	}

	update(state, npcs = []) {
		const lerpFactor = 0.5;

		const lerpAngle = (current, target, factor) => {
			let diff = target - current;
			while (diff < -180) diff += 360;
			while (diff > 180) diff -= 360;
			return current + diff * factor;
		};

		const getAngleDiff = (target, current) => {
			let diff = target - current;
			while (diff < -180) diff += 360;
			while (diff > 180) diff -= 360;
			return diff;
		};

		const normalizeAngle = (a) => {
			while (a <= -180) a += 360;
			while (a > 180) a -= 360;
			return a;
		};

		this.smoothedPitch = lerpAngle(this.smoothedPitch, state.pitch, lerpFactor);
		this.smoothedRoll = lerpAngle(this.smoothedRoll, state.roll, lerpFactor);
		this.smoothedHeading = lerpAngle(this.smoothedHeading, state.heading || 0, lerpFactor);
		this.smoothedThrottle = this.smoothedThrottle + ((state.throttle || 0) - this.smoothedThrottle) * (lerpFactor * 0.4);
		this.smoothedYaw = this.smoothedYaw + ((state.yaw || 0) - this.smoothedYaw) * lerpFactor;

		this.smoothedPitch = normalizeAngle(this.smoothedPitch);
		this.smoothedRoll = normalizeAngle(this.smoothedRoll);
		this.smoothedHeading = normalizeAngle(this.smoothedHeading);

		const baseZoom = this.minimapRange * 1500;
		const speedFactor = this.minimapRange * 2;
		let zoomAlt = baseZoom + (state.speed * speedFactor);
		if (state.isBoosting) zoomAlt *= 1.2;
		this.currentZoom = zoomAlt;
		setMinimapCamera(state.lon, state.lat, zoomAlt, this.smoothedHeading);

		const isBoosting = state.isBoosting || false;
		if (this.vignette) {
			this.vignette.style.opacity = isBoosting ? "1" : "0";
		}

		const pitchDiff = getAngleDiff(state.pitch, this.smoothedPitch);
		const rollDiff = getAngleDiff(state.roll, this.smoothedRoll);
		const yawDiff = (state.yaw || 0) - this.smoothedYaw;
		const throttleDiff = (state.throttle || 0) - this.smoothedThrottle;

		if (this.uiContainer) {
			const maxTilt = 15;
			const tiltX = Math.max(-maxTilt, Math.min(maxTilt, pitchDiff * 0.8));
			const tiltY = Math.max(-maxTilt, Math.min(maxTilt, -rollDiff * 0.3 + yawDiff * 5.0));

			const maxShift = 50;
			const shiftX = Math.max(-maxShift, Math.min(maxShift, -rollDiff * 1.5 - yawDiff * 20.0));
			const shiftY = Math.max(-maxShift, Math.min(maxShift, pitchDiff * 3.0 + throttleDiff * 15.0));

			const targetBoostScale = isBoosting ? 1.02 : 1.0;
			this.smoothedBoostScale = this.smoothedBoostScale + (targetBoostScale - this.smoothedBoostScale) * 0.1;

			const scale = (1 + (throttleDiff * 0.25)) * this.smoothedBoostScale;

			if (isBoosting) {
				const time = Date.now() * 0.05;
				this.currentShakeX = Math.sin(time * 1.5) * 2 + Math.cos(time * 2.1) * 1.5;
				this.currentShakeY = Math.cos(time * 1.7) * 2 + Math.sin(time * 2.3) * 1.5;
			} else {
				this.currentShakeX *= 0.85;
				this.currentShakeY *= 0.85;
			}

			this.uiContainer.style.transform = `perspective(1000px) rotateX(${tiltX}deg) rotateY(${tiltY}deg) translate(${shiftX + this.currentShakeX}px, ${shiftY + this.currentShakeY}px) scale(${scale})`;
		}

		this.speedElem.innerText = Math.round(state.speed).toString().padStart(3, '0');

		this.updateFlightData(state);
		this.updateMissileDebugPanel(state);
		this.updateMissileMarkers(state);
		this.updateMouseSteeringOverlay(state);
		this.updateRwrScope(state);

		if (state.weaponSystem) {
			this.updateWeapons(state.weaponSystem);
		}

		let compassHeading = this.smoothedHeading;
		while (compassHeading < 0) compassHeading += 360;
		while (compassHeading >= 360) compassHeading -= 360;

		if (this.headingDisplay) {
			let displayHeading = Math.round(compassHeading);
			if (displayHeading === 360) displayHeading = 0;

			let cardinal = '';
			if (displayHeading >= 337.5 || displayHeading < 22.5) cardinal = 'N';
			else if (displayHeading >= 22.5 && displayHeading < 67.5) cardinal = 'NE';
			else if (displayHeading >= 67.5 && displayHeading < 112.5) cardinal = 'E';
			else if (displayHeading >= 112.5 && displayHeading < 157.5) cardinal = 'SE';
			else if (displayHeading >= 157.5 && displayHeading < 202.5) cardinal = 'S';
			else if (displayHeading >= 202.5 && displayHeading < 247.5) cardinal = 'SW';
			else if (displayHeading >= 247.5 && displayHeading < 292.5) cardinal = 'W';
			else if (displayHeading >= 292.5 && displayHeading < 337.5) cardinal = 'NW';

			this.headingDisplay.innerText = `${displayHeading.toString().padStart(3, '0')} ${cardinal}`;
		}

		if (this.compassTape) {
			const pixelsPerDegree = 4;
			const centerOffset = 160;
			const targetPosOnTape = (compassHeading + 360) * pixelsPerDegree;
			const offset = centerOffset - targetPosOnTape;
			this.compassTape.style.transform = `translateX(${offset}px)`;
		}

		const altFeet = Math.max(0, Math.round(state.alt * 3.28084));
		this.altElem.innerText = altFeet.toString().padStart(5, '0');

		if (this.scoreElem) {
			this.scoreElem.innerText = (state.score || 0).toString().padStart(6, '0');
		}

		const elapsedMs = Date.now() - this.startTime;
		const m = Math.floor(elapsedMs / 60000);
		const s = Math.floor((elapsedMs % 60000) / 1000);
		const cs = Math.floor((elapsedMs % 1000) / 10);
		this.timeElem.innerText = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}:${cs.toString().padStart(2, '0')}`;

		const now = new Date();
		const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
		const tzOffsetHours = Math.round((state.lon || 0) / 15);
		const localDate = new Date(utc + (3600000 * tzOffsetHours));

		if (this.localDateTimeElem) {
			const yyyy = localDate.getFullYear();
			const mm = (localDate.getMonth() + 1).toString().padStart(2, '0');
			const dd = localDate.getDate().toString().padStart(2, '0');
			const hh = localDate.getHours().toString().padStart(2, '0');
			const min = localDate.getMinutes().toString().padStart(2, '0');
			const ss = localDate.getSeconds().toString().padStart(2, '0');

			this.localDateTimeElem.innerText = `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}Z`;
		}

		if (this.coordsElem) {
			const latDir = state.lat >= 0 ? 'N' : 'S';
			const lonDir = state.lon >= 0 ? 'E' : 'W';
			this.coordsElem.innerText = `POS: ${Math.abs(state.lat).toFixed(4)}°${latDir} ${Math.abs(state.lon).toFixed(4)}°${lonDir}`;
		}

		const pitchLines = document.getElementById('pitch-lines');
		const horizon = document.getElementById('horizon-container');
		if (pitchLines && horizon) {
			horizon.style.transform = `translate(-50%, -50%) rotate(${-this.smoothedRoll}deg)`;
			pitchLines.style.transform = `translateY(${this.smoothedPitch * 6}px)`;
		}

		this.drawMinimap(state, npcs);
		this.updateNPCMarkers(npcs, state);
	}

	drawMinimap(state, npcs = []) {
		if (!this.miniCtx || !this.minimapCanvas) return;

		const ctx = this.miniCtx;
		const w = this.minimapCanvas.width || 250;
		const h = this.minimapCanvas.height || 250;
		const centerX = w / 2;
		const centerY = h / 2;
		const radius = Math.min(centerX, centerY) - 10;

		ctx.clearRect(0, 0, w, h);

		ctx.save();
		ctx.translate(centerX, centerY);

		const heading = this.smoothedHeading;
		ctx.rotate(-heading * Math.PI / 180);

		ctx.strokeStyle = 'rgba(0, 255, 0, 0.35)';
		ctx.lineWidth = 1.0;

		const metersPerGrid = this.minimapRange * 1000;
		const verticalMeters = (this.currentZoom || (this.minimapRange * 1500)) * 1.1547;
		const gridSize = (metersPerGrid * h) / verticalMeters;
		const pixelsPerMeter = h / verticalMeters;

		const circleRadius = Math.min(10000 * pixelsPerMeter, radius);

		const limit = radius * 2;
		for (let x = 0; x <= limit; x += gridSize) {
			ctx.beginPath();
			ctx.moveTo(x, -limit); ctx.lineTo(x, limit); ctx.stroke();
			if (x > 0) {
				ctx.beginPath();
				ctx.moveTo(-x, -limit); ctx.lineTo(-x, limit); ctx.stroke();
			}
		}
		for (let y = 0; y <= limit; y += gridSize) {
			ctx.beginPath();
			ctx.moveTo(-limit, y); ctx.lineTo(limit, y); ctx.stroke();
			if (y > 0) {
				ctx.beginPath();
				ctx.moveTo(-limit, -y); ctx.lineTo(limit, -y); ctx.stroke();
			}
		}

		npcs.forEach(npc => {
			const dist = calculateDistance(state.lon, state.lat, npc.lon, npc.lat);
			if (dist > this.minimapRange * 5000) return;

			const dx_m = (npc.lon - state.lon) * 111320 * Math.cos(state.lat * Math.PI / 180);
			const dy_m = (npc.lat - state.lat) * 111320;

			const px = dx_m * pixelsPerMeter;
			const py = -dy_m * pixelsPerMeter;

			if (Math.sqrt(px * px + py * py) > radius - 5) return;

			ctx.save();
			ctx.translate(px, py);
			ctx.rotate(npc.heading * Math.PI / 180);

			ctx.fillStyle = '#fff';
			ctx.shadowBlur = 0;
			ctx.beginPath();
			ctx.moveTo(0, -8);
			ctx.lineTo(6, 6);
			ctx.lineTo(0, 3);
			ctx.lineTo(-6, 6);
			ctx.closePath();
			ctx.fill();
			ctx.restore();
		});

		ctx.restore();

		const pad = 12;
		const edgeX = centerX - pad;
		const edgeY = centerY - pad;

		ctx.strokeStyle = 'rgba(0, 255, 0, 0.7)';
		ctx.lineWidth = 1.2;
		ctx.beginPath();
		ctx.moveTo(0, centerY);
		ctx.lineTo(w, centerY);
		ctx.moveTo(centerX, 0);
		ctx.lineTo(centerX, h);

		const mainViewer = getViewer();
		let halfHFov = Math.PI / 4;
		if (mainViewer && mainViewer.camera && mainViewer.camera.frustum) {
			const fovy = mainViewer.camera.frustum.fovy;
			const aspect = window.innerWidth / window.innerHeight;
			halfHFov = Math.atan(Math.tan(fovy / 2) * aspect);
		}

		const fovLineLen = w + h;
		ctx.moveTo(centerX, centerY);
		ctx.lineTo(centerX - Math.sin(halfHFov) * fovLineLen, centerY - Math.cos(halfHFov) * fovLineLen);
		ctx.moveTo(centerX, centerY);
		ctx.lineTo(centerX + Math.sin(halfHFov) * fovLineLen, centerY - Math.cos(halfHFov) * fovLineLen);
		ctx.stroke();

		ctx.fillStyle = '#0f0';
		ctx.font = `bold 16px ${getComputedStyle(document.body).fontFamily}`;
		ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
		ctx.shadowBlur = 4;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';

		[
			{ label: 'N', angle: 0 },
			{ label: 'E', angle: 90 },
			{ label: 'S', angle: 180 },
			{ label: 'W', angle: 270 }
		].forEach(dir => {
			const relAngle = (dir.angle - heading) * Math.PI / 180;
			const sinA = Math.sin(relAngle);
			const cosA = Math.cos(relAngle);

			const absSin = Math.abs(sinA);
			const absCos = Math.abs(cosA);

			let dx, dy;
			if (edgeX * absCos > edgeY * absSin) {
				dy = (cosA > 0) ? -edgeY : edgeY;
				dx = (dy * sinA) / -cosA;
			} else {
				dx = (sinA > 0) ? edgeX : -edgeX;
				dy = (dx * -cosA) / sinA;
			}

			ctx.fillText(dir.label, centerX + dx, centerY + dy);
		});

		ctx.save();
		ctx.translate(centerX, centerY);
		ctx.fillStyle = '#0f0';
		ctx.shadowBlur = 0;
		ctx.beginPath();
		ctx.moveTo(0, -12);
		ctx.lineTo(8, 10);
		ctx.lineTo(0, 5);
		ctx.lineTo(-8, 10);
		ctx.closePath();
		ctx.fill();

		ctx.strokeStyle = 'rgba(0, 255, 0, 0.7)';
		ctx.lineWidth = 1.2;
		ctx.beginPath();
		ctx.arc(0, 0, circleRadius, 0, Math.PI * 2);
		ctx.stroke();

		ctx.restore();

		const sweepTime = (Date.now() / 1500) % 1;
		ctx.strokeStyle = `rgba(0, 255, 0, ${0.7 * (1 - sweepTime)})`;
		ctx.lineWidth = 1.2;
		ctx.beginPath();
		ctx.arc(centerX, centerY, sweepTime * circleRadius, 0, Math.PI * 2);
		ctx.stroke();
	}

	updateNPCMarkers(npcs, playerState) {
		const viewer = getViewer();
		if (!viewer) return;

		// Filter through the player's own sensor contacts: the HUD shows only
		// NPCs that at least one channel (radar / IR / visual) has picked up.
		// Stealth jets, low-signature cruise missiles, and NPCs outside the
		// radar cone will simply not appear until something sees them.
		const contactsMap = playerState && playerState.contacts;
		const visible = (contactsMap && contactsMap.size > 0)
			? npcs.filter(n => contactsMap.has(n))
			: [];

		const activeIds = new Set();
		if (visible.length > 0) {
			this.npcContainer.style.display = 'block';
			const scene = viewer.scene;
			const camera = scene.camera;
			const maxDist = 200000;

			const scratchPos = new Cesium.Cartesian3();
			const scratchPlayerPos = new Cesium.Cartesian3();

			visible.forEach(npc => {
				Cesium.Cartesian3.fromDegrees(npc.lon, npc.lat, npc.alt, undefined, scratchPos);
				Cesium.Cartesian3.fromDegrees(playerState.lon, playerState.lat, playerState.alt, undefined, scratchPlayerPos);
				const dist = Cesium.Cartesian3.distance(scratchPos, scratchPlayerPos);

				if (dist > maxDist) return;
				const id = npc.id || npc.name;
				activeIds.add(id);

				let marker = this.npcMarkers.get(id);
				if (!marker) {
					marker = this.createNPCMarker(npc);
					this.npcMarkers.set(id, marker);
				}

				const transformFunc = Cesium.SceneTransforms.worldToWindowCoordinates || Cesium.SceneTransforms.wgs84ToWindowCoordinates;
				const windowPos = transformFunc ? transformFunc(scene, scratchPos) : null;

				const direction = Cesium.Cartesian3.subtract(scratchPos, camera.position, new Cesium.Cartesian3());
				const depth = Cesium.Cartesian3.dot(direction, camera.direction);

				const isOffScreen = !windowPos || depth <= 0 ||
					windowPos.x < 0 || windowPos.x > window.innerWidth ||
					windowPos.y < 0 || windowPos.y > window.innerHeight;

				if (isOffScreen) {
					const dx = Cesium.Cartesian3.dot(direction, camera.right);
					const dy = -Cesium.Cartesian3.dot(direction, camera.up);
					this.updateOffScreenMarker(marker, dx, dy, npc, dist);
				} else {
					this.updateOnScreenMarker(marker, windowPos, npc, dist, playerState);
				}
			});
		} else {
			this.npcContainer.style.display = 'none';
		}

		for (const [id, marker] of this.npcMarkers) {
			if (!activeIds.has(id)) {
				marker.container.remove();
				this.npcMarkers.delete(id);
			}
		}
	}

	createNPCMarker(npc) {
		const container = document.createElement('div');
		container.className = 'npc-marker-container';

		const visualWrapper = document.createElement('div');
		visualWrapper.className = 'npc-visual-wrapper';

		const diamond = document.createElement('div');
		diamond.className = 'npc-diamond';

		const lockBox = document.createElement('div');
		lockBox.className = 'npc-lock-box';
		lockBox.style.display = 'none';

		const label = document.createElement('div');
		label.className = 'npc-label';

		const dot = document.createElement('div');
		dot.className = 'npc-offscreen-dot';
		dot.style.display = 'none';

		const offscreenName = document.createElement('div');
		offscreenName.className = 'npc-offscreen-name';
		offscreenName.style.display = 'none';

		visualWrapper.appendChild(diamond);
		visualWrapper.appendChild(lockBox);

		container.appendChild(visualWrapper);
		container.appendChild(label);
		container.appendChild(dot);
		container.appendChild(offscreenName);
		this.npcContainer.appendChild(container);

		return { container, diamond, label, dot, offscreenName, lockBox };
	}

	updateOnScreenMarker(marker, pos, npc, dist, state) {
		marker.container.style.display = 'flex';
		marker.container.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0) translate(-50%, -50%)`;

		marker.diamond.style.display = 'block';
		marker.label.style.display = 'block';
		marker.dot.style.display = 'none';
		marker.offscreenName.style.display = 'none';

		const ws = state.weaponSystem;
		if (ws && ws.lockingTarget === npc) {
			marker.lockBox.style.display = 'block';
			if (ws.lockStatus === 'LOCKED') {
				marker.lockBox.classList.remove('locking-blink');
				marker.lockBox.style.borderColor = '#0f0';
				marker.lockBox.innerHTML = '<span style="position:absolute; top:-20px; left:50%; transform:translateX(-50%); font-weight:bold; color:#0f0; font-size:12px; text-shadow: 0 0 8px rgba(0, 255, 0, 0.8);">LOCK</span>';
			} else if (ws.lockStatus === 'LOCKING') {
				marker.lockBox.classList.add('locking-blink');
				marker.lockBox.style.borderColor = '#0f0';
				marker.lockBox.innerHTML = '';
			}
		} else {
			marker.lockBox.style.display = 'none';
			marker.lockBox.innerHTML = '';
		}

		const distKm = (dist / 1000).toFixed(1);
		// Which channels of the player's sensor suite currently hold this
		// contact? Lit letter = live detection on that channel, dimmed = no
		// detection. Lets the pilot see at a glance whether a contact is
		// radar-only (lose it by going below RWR horizon), visual-only
		// (close-in stealth jet), etc.
		const contact = state.contacts && state.contacts.get(npc);
		const ch = (letter, live, color) =>
			`<span style="color:${live ? color : '#444'}; margin:0 1px;">${letter}</span>`;
		const channelHtml =
			ch('R', !!(contact && contact.radar),  '#40ff40') +
			ch('I', !!(contact && contact.ir),     '#ff4040') +
			ch('V', !!(contact && contact.visual), '#80c0ff');
		const labelHtml = `${npc.name}<br>${distKm} KM &nbsp; ${channelHtml}`;
		if (marker.label.dataset.html !== labelHtml) {
			marker.label.innerHTML = labelHtml;
			marker.label.dataset.html = labelHtml;
		}
	}

	updateOffScreenMarker(marker, dx, dy, npc, dist) {
		marker.container.style.display = 'flex';
		marker.diamond.style.display = 'none';
		marker.label.style.display = 'none';
		marker.dot.style.display = 'block';
		marker.offscreenName.style.display = 'block';

		const centerX = window.innerWidth / 2;
		const centerY = window.innerHeight / 2;

		if (Math.abs(dx) < 0.0001 && Math.abs(dy) < 0.0001) dy = -1;

		const angle = Math.atan2(dy, dx);
		const margin = 40;
		const viewW = centerX - margin;
		const viewH = centerY - margin;

		const cosA = Math.cos(angle);
		const sinA = Math.sin(angle);

		let x, y;
		if (Math.abs(viewW * sinA) > Math.abs(viewH * cosA)) {
			y = viewH * Math.sign(sinA);
			x = y * cosA / sinA;
		} else {
			x = viewW * Math.sign(cosA);
			y = x * sinA / cosA;
		}

		const finalX = centerX + x;
		const finalY = centerY + y;
		marker.container.style.transform = `translate3d(${finalX}px, ${finalY}px, 0) translate(-50%, -50%)`;

		if (marker.offscreenName.innerText !== npc.name) {
			marker.offscreenName.innerText = npc.name;
		}

		if (marker.lockBox) {
			marker.lockBox.style.display = 'none';
			marker.lockBox.innerHTML = '';
		}
	}

	updateFPS(fps) {
		if (this.fpsElem) {
			this.fpsElem.innerText = Math.round(fps).toString();
		}
	}

	updateWeapons(weaponSystem) {
		const currentWeapon = weaponSystem.getCurrentWeapon();
		const now = performance.now() * 0.001;

		const isMissileSelected = !!currentWeapon && (
			currentWeapon.id === 'missile' ||
			currentWeapon.id === 'aim-9' ||
			(currentWeapon.name && currentWeapon.name.toLowerCase().includes('aim-9'))
		);
		this.showMissileCrosshair(isMissileSelected);

		['gun', 'missile', 'flare'].forEach(id => {
			const elem = this.weaponElems[id];
			const ammoElem = this.weaponAmmoElems[id];
			const progressElem = this.weaponProgressElems[id];

			const weapon = id === 'flare' ? weaponSystem.flareWeapon : weaponSystem.weapons.find(w => w.id === id && (id !== 'missile' || w === currentWeapon));
			const displayWeapon = weapon || (id === 'flare' ? weaponSystem.flareWeapon : weaponSystem.weapons.find(w => w.id === id));

			if (elem) {
				const isEmptyWarning = weaponSystem.emptyWarningTimers && weaponSystem.emptyWarningTimers[id] > 0;
				const isActive = (currentWeapon && currentWeapon.id === id) ||
					(id === 'flare' && (now - weaponSystem.flareWeapon.lastFire < 1.0)) ||
					isEmptyWarning;
				const isGunOverheated = id === 'gun' && weaponSystem.isGunOverheated;

				if (isActive) {
					elem.classList.add('active');
				} else {
					elem.classList.remove('active');
				}

				if (isGunOverheated || isEmptyWarning) {
					elem.classList.add('overheated');
				} else {
					elem.classList.remove('overheated');
				}

				if (isActive && id === 'missile' && displayWeapon) {
					const nameElem = elem.querySelector('.weapon-name');
					if (nameElem) nameElem.innerText = displayWeapon.name;
				}
			}

			if (progressElem && displayWeapon) {
				let progress = 0;
				if (id === 'gun') {
					progress = weaponSystem.gunHeat * 100;
				} else {
					const timeSinceLast = now - displayWeapon.lastFire;
					const reloadTime = id === 'flare' ? 1.0 : displayWeapon.fireRate;

					if (timeSinceLast < reloadTime) {
						progress = (timeSinceLast / reloadTime) * 100;
					} else {
						progress = 0;
					}
				}
				progressElem.style.width = `${progress}%`;
			}

			if (ammoElem && displayWeapon) {
				if (id === 'gun' && weaponSystem.isGunOverheated) {
					ammoElem.innerText = 'OVERHEAT';
				} else if (displayWeapon.ammo === Infinity) {
					ammoElem.innerText = 'INF';
				} else {
					ammoElem.innerText = displayWeapon.ammo.toString().padStart(2, '0');
				}
			}
		});
	}
}
