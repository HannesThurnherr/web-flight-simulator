import { setMinimapCamera, getMiniViewer, getViewer, setPauseMinimapCamera, getPauseMiniViewer } from '../world/cesiumWorld';
import { calculateDistance } from '../world/regions';
import * as Cesium from 'cesium';
import { releaseEnvelope, isStrikeWeapon } from '../systems/strikeEnvelope.js';
import { totalWingmanAmmo } from '../systems/formation.js';
import { getTeamDatalink } from '../systems/teamDatalink.js';
import { MUNITIONS } from '../weapon/munitions.js';
import { munitionIdForSimType } from '../weapon/munitionFactory.js';
import { playerDesignation, designationQueue } from '../systems/designation.js';

// Team → HUD accent color. Shared across the on-screen diamond, minimap
// icons, and (in future) the radar scope. Friendlies get the familiar
// mil-standard cyan; the two hostile factions get their faction colors
// so a 3-way merge is immediately legible. Unknown teams fall through
// to red — the safest default for "assume hostile".
function _hudTeamColor(team) {
	if (team === 'friendly')     return '#40d8ff';
	if (team === 'hostile-red')  return '#ff4040';
	if (team === 'hostile-blue') return '#4080ff';
	return '#ff4040';
}

// 6d — IFF-aware color. Looks up the player's CURRENT perception of
// an npc (from own sensor contacts first, then datalink fusion). If
// the contact is stamped 'unknown' anywhere along the way, returns
// amber; if 'friendly' returns cyan; if 'hostile' returns the
// faction-team color from _hudTeamColor. With omniscient mode on
// the IFF pipeline always returns truth so this collapses to
// _hudTeamColor(npc.team) — preserving the legacy look.
const HUD_IFF_AMBER    = '#ffb000';
const HUD_IFF_FRIENDLY = '#40d8ff';
function _hudIffColor(playerState, npc) {
	if (!playerState || !npc) return _hudTeamColor(npc && npc.team);
	let iff = null;
	const own = playerState.contacts && playerState.contacts.get(npc);
	if (own) iff = own.iffStatus;
	if (!iff) {
		const dl = getTeamDatalink(playerState.team || 'friendly');
		const fused = dl && dl.contacts && dl.contacts.get(npc);
		if (fused) iff = fused.iffStatus;
	}
	if (iff === 'unknown')  return HUD_IFF_AMBER;
	if (iff === 'friendly') return HUD_IFF_FRIENDLY;
	// 'hostile' OR no fused/own data (which means we can see it via
	// some other channel like briefed intel — assume the team color
	// is correct in that case).
	return _hudTeamColor(npc.team);
}

export class HUD {
	constructor() {
		this.speedElem = document.getElementById('speed');
		this.altElem = document.getElementById('altitude');
		this.timeElem = document.getElementById('time');
		this.scoreElem = document.getElementById('score');
		this.fpsElem = document.getElementById('fps');
		this.localDateTimeElem = document.getElementById('local-datetime');
		this.radarStateElem   = document.getElementById('radar-state');
		this.radarStatusElem  = document.getElementById('radar-status');
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

		// Weapon list is populated dynamically by updateWeapons().
		// Cache the container + a Map<weaponKey, rowElement> so DOM
		// gets built once per weapon-type and reused across frames
		// rather than rebuilt each tick. Keys come from weapon.type
		// (gun, AIM-9M, AIM-9X, AIM-120, METEOR, AGM-88, ...) plus a
		// dedicated 'flare' key for the pinned-bottom flare slot.
		this.weaponList = document.getElementById('weapon-list');
		this.weaponRows = new Map();
		// Legacy field kept for any other code path that still reads
		// individual weapon DOM nodes — initialise empty so any
		// stale querySelector returns undefined gracefully.
		this.weaponElems = {};
		this.weaponAmmoElems = {
		};
		this.weaponProgressElems = {
		};

		this.vignette = document.getElementById('transition-vignette');

		this.startTime = Date.now();

		this.smoothedPitch = 0;
		this.smoothedRoll = 0;
		// The pitch ladder (horizon bar + degree lines) is the primary
		// attitude reference — default it ON. Previously this defaulted
		// to false and the ladder was hidden unless something flipped
		// the toggle, which meant no visible horizon at all.
		this.showHorizonLines = true;
		this.smoothedHeading = 0;
		this.smoothedThrottle = 0;
		this.smoothedYaw = 0;
		this.smoothedBoostScale = 1.0;
		this.currentShakeX = 0;
		this.currentShakeY = 0;

		this.minimapRange = 1;
		// 6a — radar/SA scope display modes layered onto the existing
		// minimap. Two independent toggles:
		//   radarBackground   — when false, the Cesium terrain
		//     substrate (#minimapCesium) is hidden and the canvas
		//     overlay renders on a dark grid backdrop. Pure tactical
		//     scope; everything is icons + strobes, no map context.
		//   radarExpanded     — when true, the whole minimap-container
		//     scales up to a full-screen ~700 × 700 px overlay so the
		//     player can read dense pictures during a busy fight.
		// Both default OFF so the existing minimap UX is unchanged.
		this.radarBackground = true;
		this.radarExpanded   = false;

		this.npcMarkers = new Map();
		this.npcContainer = document.createElement('div');
		this.npcContainer.id = 'npc-markers-layer';
		// Appended as a sibling of uiContainer (direct child of body),
		// not INSIDE uiContainer. That way the markers stay visible when
		// the pilot HUD is hidden — specifically when the spectator
		// camera is following another unit (main.js sets uiContainer
		// opacity to 0 in that mode). Seeing where every unit is on
		// screen while watching the action from behind one of them is
		// the whole point of spectator view.
		this.npcContainer.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:15;';
		document.body.appendChild(this.npcContainer);

		this.createHorizon();
		this.createMissileCrosshair();
		this.createCompass();
		this.createMinimapZoomButtons();
		// Flight-data panel (AOA / G / VS / SLIP / THR bar) removed by
		// player request. Left edge is now occupied by the TGP panel
		// when a laser-guided weapon is selected. The remaining
		// flight cues (afterburner, stall, throttle level) live in
		// the existing right-side stack.
		this.createFlightInfoStrip();
		this.createStallWarning();
		this.createAfterburnerIndicator();
		this.createMissileDebugPanel();
		this.createMissileMarkerLayer();
		this.createMouseSteeringOverlay();
		this.createRwrScope();
		this.createGunReticle();
		this.resizeMinimap();
		window.addEventListener('resize', () => this.resizeMinimap());
	}

	// RWR scope: round display, your nose points to the top, hostile radars
	// currently illuminating the aircraft show up as chevrons at their
	// bearing. Radius maps inversely to signal strength — strong painters
	// draw close to centre, like a real scope.
	createRwrScope() {
		const NS = 'http://www.w3.org/2000/svg';
		const size = 170;
		const statusH = 36;
		const totalH = size + statusH;
		const svg = document.createElementNS(NS, 'svg');
		svg.id = 'rwr-scope';
		svg.setAttribute('width',  size);
		svg.setAttribute('height', totalH);
		svg.setAttribute('viewBox', `0 0 ${size} ${totalH}`);
		// Offset right of screen center so the scope doesn't overlap the
		// compass heading tape that lives along the top middle.
		svg.style.cssText = `
			position: absolute;
			bottom: 360px;
			right: 30px;
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
			el.setAttribute('stroke-width', 1.2);
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
			line.setAttribute('stroke-width', 1.5);
			return line;
		};
		for (let i = 0; i < 4; i++) svg.appendChild(tick(i * Math.PI / 2, 14));

		// "NOSE" cue at top so it's unambiguous which way is forward.
		const noseLabel = document.createElementNS(NS, 'text');
		noseLabel.setAttribute('x', cx);
		noseLabel.setAttribute('y', 16);
		noseLabel.setAttribute('fill', '#0f0');
		noseLabel.setAttribute('font-family', 'AceCombat, monospace');
		noseLabel.setAttribute('font-size', '12');
		noseLabel.setAttribute('text-anchor', 'middle');
		noseLabel.textContent = 'RWR';
		svg.appendChild(noseLabel);

		// Container for contact chevrons; rebuilt each frame in update.
		const contactGroup = document.createElementNS(NS, 'g');
		contactGroup.id = 'rwr-contacts';
		svg.appendChild(contactGroup);

		// ---- Status block below the scope ---------------------------------
		// Two lines:
		//   Line 1: own radar mode (TWS / STT) and a SPIKE warning when
		//           being painted by an STT lock.
		//   Line 2: count summary "X EMITTERS — Y STT".
		// Updated each frame in updateRwrScope.
		const statusGroup = document.createElementNS(NS, 'g');
		statusGroup.id = 'rwr-status';

		const modeLabel = document.createElementNS(NS, 'text');
		modeLabel.setAttribute('x', cx);
		modeLabel.setAttribute('y', size + 14);
		modeLabel.setAttribute('fill', '#0f0');
		modeLabel.setAttribute('font-family', 'AceCombat, monospace');
		modeLabel.setAttribute('font-size', '11');
		modeLabel.setAttribute('text-anchor', 'middle');
		modeLabel.textContent = 'MODE: TWS';
		statusGroup.appendChild(modeLabel);

		const countLabel = document.createElementNS(NS, 'text');
		countLabel.setAttribute('x', cx);
		countLabel.setAttribute('y', size + 28);
		countLabel.setAttribute('fill', 'rgba(0, 255, 0, 0.7)');
		countLabel.setAttribute('font-family', 'AceCombat, monospace');
		countLabel.setAttribute('font-size', '10');
		countLabel.setAttribute('text-anchor', 'middle');
		countLabel.textContent = '0 EMITTERS';
		statusGroup.appendChild(countLabel);

		svg.appendChild(statusGroup);

		this.uiContainer.appendChild(svg);
		this.rwrScope = { svg, contactGroup, size, cx, cy, r, modeLabel, countLabel };
	}

	updateRwrScope(state) {
		const s = this.rwrScope;
		if (!s) return;
		const rwr = state && state.rwr;
		// Clear previous contacts.
		while (s.contactGroup.firstChild) s.contactGroup.removeChild(s.contactGroup.firstChild);

		// Status block — own radar mode + emitter summary. Always
		// updated whether or not anything's painting us.
		const ownMode = state && state.sensors && state.sensors.radar
			? state.sensors.radar.mode
			: 'search';
		const ownModeLabel = ownMode === 'track' ? 'STT' : 'TWS';
		let total = 0;
		let stt = 0;
		if (rwr) {
			for (const [, c] of rwr) {
				if (!c) continue;
				total++;
				if (c.lockType === 'track') stt++;
			}
		}
		if (s.modeLabel) {
			if (stt > 0) {
				s.modeLabel.textContent = `SPIKE — MODE ${ownModeLabel}`;
				s.modeLabel.setAttribute('fill', '#ff4040');
			} else {
				s.modeLabel.textContent = `MODE: ${ownModeLabel}`;
				s.modeLabel.setAttribute('fill', '#0f0');
			}
		}
		if (s.countLabel) {
			let txt = total === 0
				? 'NO EMITTERS'
				: `${total} EMITTER${total === 1 ? '' : 'S'}${stt > 0 ? ` — ${stt} STT` : ''}`;
			// 6e.3 / 6e.2 — EW state line. Folded onto the same
			// status row to avoid taking another vertical slot.
			const jam = state && state.jammer;
			if (jam) {
				const off = jam.offensiveTargets && jam.offensiveTargets.size > 0;
				if (off && jam.defensiveOn)   txt += '  EW:DEF+OFF';
				else if (jam.defensiveOn)     txt += '  EW:DEF';
				else if (off)                 txt += '  EW:OFF';
				else                          txt += '  EW:STDBY';
			}
			s.countLabel.textContent = txt;
		}

		const NS = 'http://www.w3.org/2000/svg';

		// 6e.1 — jam strobes. Drawn before RWR chevrons so painted
		// emitters end up on top. A jam strobe is a hatched radial
		// wedge running from the scope centre outward in the jammer's
		// bearing, length scaled by attenuation strength (stronger
		// jam = longer strobe). Burn-through collapses the strobe so
		// the player sees the radar punch through visually.
		const jamStrobes = state && state.jamStrobes;
		if (jamStrobes && jamStrobes.size > 0) {
			for (const [, j] of jamStrobes) {
				const ang = (j.bearing || 0) - Math.PI / 2;
				// att: 1.0 = no jam, 0.4 = full jam. Strobe length
				// keyed off (1 - att) so full jam = full radius.
				const strength = Math.max(0, Math.min(1, (1 - j.att) / 0.6));
				if (j.burnThrough || strength <= 0.01) continue;
				const strobeLen = s.r * (0.55 + 0.45 * strength);
				// Draw the line FROM the strobe tip (out at the
				// jammer's bearing) INTO the scope centre. This way
				// dashes that march "forward along the stroke" travel
				// inward, matching the mental model of "jam noise
				// coming at me from out there." Reversing path
				// direction is simpler than fighting SVG's
				// stroke-dashoffset sign convention.
				const xTip = s.cx + Math.cos(ang) * strobeLen;
				const yTip = s.cy + Math.sin(ang) * strobeLen;
				// Hatched line: a fat semi-transparent base with a
				// dashed bright stripe over the top. SVG strokes
				// give us the moving-stipple look cheaply.
				const base = document.createElementNS(NS, 'line');
				base.setAttribute('x1', xTip); base.setAttribute('y1', yTip);
				base.setAttribute('x2', s.cx); base.setAttribute('y2', s.cy);
				base.setAttribute('stroke', 'rgba(255, 110, 60, 0.35)');
				base.setAttribute('stroke-width', 6);
				base.setAttribute('stroke-linecap', 'round');
				s.contactGroup.appendChild(base);
				const stripe = document.createElementNS(NS, 'line');
				stripe.setAttribute('x1', xTip); stripe.setAttribute('y1', yTip);
				stripe.setAttribute('x2', s.cx); stripe.setAttribute('y2', s.cy);
				stripe.setAttribute('stroke', '#ff7030');
				stripe.setAttribute('stroke-width', 2);
				stripe.setAttribute('stroke-dasharray', '3 4');
				// Negative offset advances the dash pattern along
				// stroke direction (tip → centre) → dashes appear to
				// flow inward, into the player's position.
				const phase = (performance.now() / 600) % 1;
				stripe.setAttribute('stroke-dashoffset', String(-phase * 7));
				s.contactGroup.appendChild(stripe);
				// Bearing label at the strobe tip.
				const bearingDeg = Math.round(((j.bearing * 180 / Math.PI) % 360 + 360) % 360);
				const lbl = document.createElementNS(NS, 'text');
				lbl.setAttribute('x', xTip + Math.cos(ang) * 8);
				lbl.setAttribute('y', yTip + Math.sin(ang) * 8 + 3);
				lbl.setAttribute('fill', '#ff7030');
				lbl.setAttribute('font-family', 'AceCombat, monospace');
				lbl.setAttribute('font-size', '8');
				lbl.setAttribute('text-anchor', 'middle');
				lbl.textContent = `JAM ${String(bearingDeg).padStart(3, '0')}`;
				s.contactGroup.appendChild(lbl);
			}
		}

		const designatedEmitter = state && state.weaponSystem
			&& state.weaponSystem.designatedEmitter;
		const designatedJam = state && state.weaponSystem
			&& state.weaponSystem.designatedJamTarget;
		const offensiveSet = state && state.jammer && state.jammer.offensiveTargets;

		// 6e.2 — outgoing jam beams. For every victim the player is
		// currently jamming offensively, draw a beam from scope
		// centre out toward that victim's bearing. Uses contact data
		// (radar/IR/visual fused bearing) rather than RWR, since the
		// victim might not be radiating at us — we still know roughly
		// where they are. Drawn separately from the receive-side
		// strobes so it visually reads as "I'm sending" not "I'm
		// being painted." The dashes flow OUTWARD here (centre → tip),
		// the inverse of the inbound jam strobes.
		if (offensiveSet && offensiveSet.size > 0 && state) {
			for (const victim of offensiveSet) {
				if (!victim) continue;
				let bearing = null;
				if (state.contacts && state.contacts.has(victim)) {
					const c2 = state.contacts.get(victim);
					if (c2 && c2.fused && c2.fused.bearing != null) bearing = c2.fused.bearing;
				}
				if (bearing == null && rwr && rwr.has(victim)) {
					const r2 = rwr.get(victim);
					if (r2) bearing = r2.bearing;
				}
				if (bearing == null) continue;
				const ang = bearing - Math.PI / 2;
				const tipLen = s.r * 0.85;
				const xT = s.cx + Math.cos(ang) * tipLen;
				const yT = s.cy + Math.sin(ang) * tipLen;
				const base = document.createElementNS(NS, 'line');
				base.setAttribute('x1', s.cx); base.setAttribute('y1', s.cy);
				base.setAttribute('x2', xT);   base.setAttribute('y2', yT);
				base.setAttribute('stroke', 'rgba(96, 220, 255, 0.30)');
				base.setAttribute('stroke-width', 5);
				base.setAttribute('stroke-linecap', 'round');
				s.contactGroup.appendChild(base);
				const stripe = document.createElementNS(NS, 'line');
				stripe.setAttribute('x1', s.cx); stripe.setAttribute('y1', s.cy);
				stripe.setAttribute('x2', xT);   stripe.setAttribute('y2', yT);
				stripe.setAttribute('stroke', '#60dcff');
				stripe.setAttribute('stroke-width', 2);
				stripe.setAttribute('stroke-dasharray', '3 4');
				const phase = (performance.now() / 600) % 1;
				// Negative offset = dashes march along stroke direction
				// (centre → tip) → reads as "outbound."
				stripe.setAttribute('stroke-dashoffset', String(-phase * 7));
				s.contactGroup.appendChild(stripe);
			}
		}

		// Even with no inbound emitters, we still want to render the
		// JAM-designation reticle for a passive (radar-off) victim
		// (handled by the fallback at the end of this method), so we
		// fall through instead of returning early like we used to.
		const rwrIter = rwr || new Map();
		for (const [src, c] of rwrIter) {
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
			const chevSize = 8;
			const toCenterAng = Math.atan2(s.cy - y, s.cx - x);
			const p = (t, perp) => {
				const ax = Math.cos(toCenterAng + perp) * t;
				const ay = Math.sin(toCenterAng + perp) * t;
				return [x + ax, y + ay];
			};
			const [x1, y1] = p(chevSize, 0);
			const [x2, y2] = p(chevSize * 0.8,  Math.PI * 0.85);
			const [x3, y3] = p(chevSize * 0.8, -Math.PI * 0.85);
			chev.setAttribute('points', `${x1},${y1} ${x2},${y2} ${x3},${y3}`);
			chev.setAttribute('fill', color);
			chev.setAttribute('stroke', '#000');
			chev.setAttribute('stroke-width', 0.8);
			s.contactGroup.appendChild(chev);

			// HARM designation reticle: brackets around the chevron
			// for the emitter the player has Tab-cycled to. Drawn
			// regardless of which weapon is selected so the player
			// can confirm their pick before switching to HARM.
			if (designatedEmitter && src === designatedEmitter) {
				const ring = document.createElementNS(NS, 'circle');
				ring.setAttribute('cx', x);
				ring.setAttribute('cy', y);
				ring.setAttribute('r', 12);
				ring.setAttribute('fill', 'none');
				ring.setAttribute('stroke', '#00eaff');
				ring.setAttribute('stroke-width', 1.6);
				ring.setAttribute('stroke-dasharray', '3 2');
				s.contactGroup.appendChild(ring);
				const tag = document.createElementNS(NS, 'text');
				tag.setAttribute('x', x);
				tag.setAttribute('y', y - 14);
				tag.setAttribute('fill', '#00eaff');
				tag.setAttribute('font-family', 'AceCombat, monospace');
				tag.setAttribute('font-size', '9');
				tag.setAttribute('text-anchor', 'middle');
				tag.textContent = 'HARM';
				s.contactGroup.appendChild(tag);
			}

			// 6e.2 — JAM designation reticle. Same bracket visual as
			// HARM but in the jammer-orange palette and with a solid
			// fill if the beam is actually firing on this victim.
			if (designatedJam && src === designatedJam) {
				const isLit = offensiveSet && offensiveSet.has(src);
				const ring = document.createElementNS(NS, 'circle');
				ring.setAttribute('cx', x);
				ring.setAttribute('cy', y);
				ring.setAttribute('r', 14);
				ring.setAttribute('fill', isLit ? 'rgba(255, 112, 48, 0.18)' : 'none');
				ring.setAttribute('stroke', '#ff7030');
				ring.setAttribute('stroke-width', 1.8);
				ring.setAttribute('stroke-dasharray', isLit ? '6 2' : '3 2');
				s.contactGroup.appendChild(ring);
				const tag = document.createElementNS(NS, 'text');
				tag.setAttribute('x', x);
				tag.setAttribute('y', y - 18);
				tag.setAttribute('fill', '#ff7030');
				tag.setAttribute('font-family', 'AceCombat, monospace');
				tag.setAttribute('font-size', '9');
				tag.setAttribute('text-anchor', 'middle');
				tag.textContent = isLit ? 'JAM ●' : 'JAM';
				s.contactGroup.appendChild(tag);
			}

			// Small label showing lock type.
			if (c.lockType === 'track') {
				const lbl = document.createElementNS(NS, 'text');
				lbl.setAttribute('x', x);
				lbl.setAttribute('y', y + 18);
				lbl.setAttribute('fill', '#ff4040');
				lbl.setAttribute('font-family', 'AceCombat, monospace');
				lbl.setAttribute('font-size', '10');
				lbl.setAttribute('text-anchor', 'middle');
				lbl.textContent = 'STT';
				s.contactGroup.appendChild(lbl);
			}
		}

		// 6e.2 — fall-through pass to show a JAM reticle when the
		// designated victim isn't currently radiating at us (so they
		// don't appear in the rwr Map above). We pull their bearing
		// from the player's contact track instead. Without this, a
		// player jamming a passive (radar-off) bogey sees no
		// confirmation that their designation actually picked
		// something — exactly the "I don't know how" failure mode.
		if (designatedJam && state && state.contacts && !(rwr && rwr.has(designatedJam))) {
			const c2 = state.contacts.get(designatedJam);
			if (c2 && c2.fused && c2.fused.bearing != null) {
				const ang = (c2.fused.bearing) - Math.PI / 2;
				const radius = s.r * 0.6;
				const x = s.cx + Math.cos(ang) * radius;
				const y = s.cy + Math.sin(ang) * radius;
				const isLit = offensiveSet && offensiveSet.has(designatedJam);
				const ring = document.createElementNS(NS, 'circle');
				ring.setAttribute('cx', x);
				ring.setAttribute('cy', y);
				ring.setAttribute('r', 14);
				ring.setAttribute('fill', isLit ? 'rgba(255, 112, 48, 0.18)' : 'none');
				ring.setAttribute('stroke', '#ff7030');
				ring.setAttribute('stroke-width', 1.8);
				ring.setAttribute('stroke-dasharray', isLit ? '6 2' : '3 2');
				s.contactGroup.appendChild(ring);
				const tag = document.createElementNS(NS, 'text');
				tag.setAttribute('x', x);
				tag.setAttribute('y', y - 18);
				tag.setAttribute('fill', '#ff7030');
				tag.setAttribute('font-family', 'AceCombat, monospace');
				tag.setAttribute('font-size', '9');
				tag.setAttribute('text-anchor', 'middle');
				tag.textContent = isLit ? 'JAM ●' : 'JAM';
				s.contactGroup.appendChild(tag);
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

		// "MOUSE STEER" badge removed — the cursor-to-centre line itself
		// plus the two dots make the mode visually obvious, and the text
		// competed with the pitch ladder for attention at the centre of
		// the HUD. Leave a stub element in place so the refs in
		// `updateMouseSteeringOverlay` don't have to be rewritten.
		const badge = document.createElementNS(NS, 'text');
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
			left: 10px; top: -10px;
			white-space: nowrap;
		`;
		// Sub-line beneath the name: smaller + dimmer, holds the
		// flight-state stuff (phase, speed, distance) that's useful
		// to glance at but shouldn't compete with the type tag.
		const subLabel = document.createElement('div');
		subLabel.style.cssText = `
			position: absolute;
			left: 10px; top: 4px;
			white-space: nowrap;
			font-size: 9px;
			letter-spacing: 0.5px;
			opacity: 0.65;
		`;
		el.appendChild(dot);
		el.appendChild(label);
		el.appendChild(subLabel);
		this.missileMarkerLayer.appendChild(el);
		return { el, dot, label, subLabel };
	}

	// Designation markers: little green diamonds on the cockpit HUD
	// at the screen positions of the strike-planner queue. Lets the
	// player see WHERE the JDAMs will go without leaving cockpit
	// view. Off-screen designations get pinned to the screen edge in
	// the direction of the spot, mirroring the NPC marker behavior.
	updateDesignationMarkers(state) {
		// Lazy DOM container — created on first call so it doesn't
		// add a layer for the (common) case where the player never
		// touches the strike planner.
		if (!this._designationLayer) {
			const layer = document.createElement('div');
			layer.id = 'designation-markers-layer';
			layer.style.cssText = `
				position: fixed; inset: 0;
				pointer-events: none;
				z-index: 11;
			`;
			document.body.appendChild(layer);
			this._designationLayer = layer;
			this._designationEls = [];
		}

		const viewer = getViewer();
		if (!viewer) return;
		const scene = viewer.scene;
		const camera = scene.camera;
		const transformFunc = Cesium.SceneTransforms.worldToWindowCoordinates
			|| Cesium.SceneTransforms.wgs84ToWindowCoordinates;
		if (!transformFunc) return;

		// Bring DOM-element pool in sync with queue length.
		while (this._designationEls.length < designationQueue.length) {
			const idx = this._designationEls.length;
			const el = document.createElement('div');
			el.style.cssText = `
				position: absolute;
				width: 22px; height: 22px;
				margin-left: -11px; margin-top: -11px;
				color: #40ff40;
				font-family: 'AceCombat', monospace;
				font-size: 11px;
				font-weight: bold;
				text-shadow: 0 0 6px rgba(0, 255, 0, 0.8);
			`;
			el.innerHTML = `
				<div style="
					position: absolute;
					left: 50%; top: 50%;
					width: 14px; height: 14px;
					margin-left: -7px; margin-top: -7px;
					transform: rotate(45deg);
					border: 1.5px solid #40ff40;
					box-shadow: 0 0 6px rgba(0, 255, 0, 0.6);
				"></div>
				<div class="designation-label" style="
					position: absolute;
					left: 16px; top: -2px;
					white-space: nowrap;
				">TGT ${idx + 1}</div>
			`;
			this._designationLayer.appendChild(el);
			this._designationEls.push(el);
		}
		while (this._designationEls.length > designationQueue.length) {
			const el = this._designationEls.pop();
			el.remove();
		}

		for (let i = 0; i < designationQueue.length; i++) {
			const d = designationQueue[i];
			const worldPos = Cesium.Cartesian3.fromDegrees(d.lon, d.lat, d.alt || 0);
			const windowPos = transformFunc(scene, worldPos);
			const direction = Cesium.Cartesian3.subtract(worldPos, camera.position, new Cesium.Cartesian3());
			const depth = Cesium.Cartesian3.dot(direction, camera.direction);

			const el = this._designationEls[i];
			const labelEl = el.querySelector('.designation-label');
			if (labelEl) labelEl.textContent = `TGT ${i + 1}`;

			const onScreen = windowPos && depth > 0
				&& windowPos.x >= 0 && windowPos.x <= window.innerWidth
				&& windowPos.y >= 0 && windowPos.y <= window.innerHeight;

			if (onScreen) {
				el.style.display = 'block';
				el.style.left = `${windowPos.x}px`;
				el.style.top  = `${windowPos.y}px`;
				el.style.opacity = '1';
			} else {
				// Pin to the screen edge in the direction of the spot.
				const dx = Cesium.Cartesian3.dot(direction, camera.right);
				const dy = -Cesium.Cartesian3.dot(direction, camera.up);
				const cx = window.innerWidth / 2;
				const cy = window.innerHeight / 2;
				// Behind the camera: pull to the bottom edge by flipping dy.
				const eff_dy = depth > 0 ? dy : -dy;
				const eff_dx = depth > 0 ? dx : -dx;
				const ang = Math.atan2(eff_dy, eff_dx);
				const margin = 32;
				const rx = cx - margin;
				const ry = cy - margin;
				// Project onto bounding rect.
				const tan = Math.tan(ang);
				let x, y;
				if (Math.abs(tan) <= ry / rx) {
					x = eff_dx > 0 ? rx : -rx;
					y = x * tan;
				} else {
					y = eff_dy > 0 ? ry : -ry;
					x = y / tan;
				}
				el.style.display = 'block';
				el.style.left = `${cx + x}px`;
				el.style.top  = `${cy + y}px`;
				el.style.opacity = '0.6';
			}
		}
	}

	// 5g.4 — strike-planner queued-targets HUD strip. Compact list of
	// the next ≤3 queued points with name (taken from a hostile npc
	// at the same coord, if any), range to the player, and bearing
	// arrow. Visible only when the player has a strike weapon loaded
	// AND the queue has at least one entry — otherwise hidden so it
	// doesn't clutter dogfights.
	// 10d.1 — objectives overlay. Reads the active scenario's
	// `getObjectives()` (a method exposed by buildScenarioFromJson)
	// and renders a small mission-status block in the top-left of
	// the HUD. Hidden when the scenario has no objectives.
	updateObjectivesPanel(state) {
		let panel = document.getElementById('objectives-panel');
		const scn = state && state._activeScenario;
		const list = (scn && typeof scn.getObjectives === 'function')
			? scn.getObjectives() : null;
		if (!list || list.length === 0) {
			if (panel) panel.style.display = 'none';
			return;
		}
		if (!panel) {
			panel = document.createElement('div');
			panel.id = 'objectives-panel';
			panel.style.cssText = `
				position: fixed;
				left: 16px;
				top: 80px;
				min-width: 240px;
				padding: 8px 12px;
				background: rgba(0, 25, 0, 0.65);
				border: 1px solid rgba(0, 255, 0, 0.45);
				color: #0f0;
				font-family: 'AceCombat', 'Courier New', monospace;
				font-size: 11px;
				line-height: 1.55;
				z-index: 50;
				pointer-events: none;
				letter-spacing: 0.5px;
			`;
			document.body.appendChild(panel);
		}
		panel.style.display = '';
		const symbol = (status) => status === 'done' ? '✓'
			: status === 'failed' ? '✗' : '◇';
		const colour = (status) => status === 'done' ? '#80ff80'
			: status === 'failed' ? '#ff6060'
			: '#0f0';
		let html = '<div style="font-weight:bold;border-bottom:1px solid rgba(0,255,0,0.3);padding-bottom:3px;margin-bottom:4px;">MISSION</div>';
		for (const o of list) {
			const c = colour(o.status);
			html += `<div style="color:${c};">${symbol(o.status)} ${o.label || o.id}${o.required === false ? '  (opt)' : ''}</div>`;
		}
		panel.innerHTML = html;
	}

	updateStrikeQueueStrip(state) {
		const el = document.getElementById('strike-queue-strip');
		if (!el) return;
		const ws = state && state.weaponSystem;
		const cur = ws && ws.getCurrentWeapon && ws.getCurrentWeapon();
		const isStrike = cur && (cur.id === 'agm' || cur.id === 'gbu');
		if (!isStrike || designationQueue.length === 0) {
			el.classList.add('hidden');
			return;
		}
		el.classList.remove('hidden');
		// Resolve a name for each queued point: walk known npcs and
		// pick the one whose lat/lon best matches (within ~150 m).
		// Suspected briefed dots will match the unit by reference; the
		// jitter is sub-uncertaintyM so still close enough for name
		// matching.
		const npcs = state.npcs || [];
		const cosLat = Math.cos((state.lat || 0) * Math.PI / 180) || 1;
		const lookup = (lon, lat) => {
			let best = null;
			let bestSq = (150 / 111320) ** 2;
			for (const u of npcs) {
				if (!u || u.destroyed) continue;
				if (u.team === state.team) continue;
				const dE = (u.lon - lon) * cosLat;
				const dN = (u.lat - lat);
				const sq = dE * dE + dN * dN;
				if (sq < bestSq) { bestSq = sq; best = u; }
			}
			return best;
		};
		const N = Math.min(3, designationQueue.length);
		const lines = [];
		lines.push('<div class="strike-queue-strip-title">QUEUE  ' +
			`${designationQueue.length}  · ${cur.name || cur.type}</div>`);
		for (let i = 0; i < N; i++) {
			const d = designationQueue[i];
			const dE = (d.lon - state.lon) * 111320 * cosLat;
			const dN = (d.lat - state.lat) * 111320;
			const range = Math.hypot(dE, dN);
			const bearing = (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360;
			const relBearing = (((bearing - (state.heading || 0)) + 540) % 360) - 180;
			// Compact arrow direction. 8 sectors: ↑↗→↘↓↙←↖
			const arrows = ['↑','↗','→','↘','↓','↙','←','↖'];
			const sector = Math.round((relBearing + 180) / 45) % 8;
			// Mapping: relBearing -180=↓ -135=↙ -90=← -45=↖ 0=↑ 45=↗ 90=→ 135=↘ 180=↓
			const arrowMap = ['↓','↙','←','↖','↑','↗','→','↘'];
			const arrow = arrowMap[sector] || '↑';
			const u    = lookup(d.lon, d.lat);
			const name = u ? (u.name || 'TGT') : `TGT ${i + 1}`;
			const rangeStr = range >= 1000
				? `${(range / 1000).toFixed(1)} km`
				: `${range.toFixed(0)} m`;
			const cls = i === 0 ? 'strike-queue-strip-row head' : 'strike-queue-strip-row';
			lines.push(`<div class="${cls}"><span>${i + 1}. ${name}</span>` +
				`<span>${arrow} ${rangeStr}</span></div>`);
		}
		if (designationQueue.length > N) {
			lines.push(`<div class="strike-queue-strip-row" style="opacity:0.5">` +
				`<span>+ ${designationQueue.length - N} more</span><span></span></div>`);
		}
		el.innerHTML = lines.join('');
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
			// MALD decoys spoof a fighter signature — they should
			// look like a contact, not an inbound missile, on the
			// player's HUD. Skip the missile-marker render path; the
			// regular sensor pipeline will surface them as fighter
			// contacts the same way it does any radar paint.
			if (m.type === 'MALD') continue;

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
			// Color per team: own missiles stay amber, hostile in magenta so
			// they're unmistakable against red NPC plane markers (four-way
			// separation: player=cyan, NPC=red, friendly msl=amber, hostile
			// msl=magenta). Matches the commander view color scheme.
			const color = isOwnTeam ? '#ffc040' : '#ff40e0';
			marker.dot.style.background = color;
			marker.dot.style.boxShadow  = `0 0 8px ${color}`;
			marker.label.style.color    = color;
			if (marker.subLabel) marker.subLabel.style.color = color;
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

			const spd = Math.round(m.speed * 3.6);
			const phase = m.boostRemaining > 0 ? 'BOOST' : 'COAST';
			const typeTag = m.type || 'MSL';
			const prefix = isOwnTeam ? '' : 'INBOUND ';
			// Distance: missile → player, in km.
			const playerPos = Cesium.Cartesian3.fromDegrees(state.lon, state.lat, state.alt);
			const distKm = Cesium.Cartesian3.distance(pos, playerPos) / 1000;
			const distStr = distKm < 10 ? distKm.toFixed(1) : Math.round(distKm).toString();
			marker.label.innerText = `${prefix}${typeTag}`;
			if (marker.subLabel) {
				marker.subLabel.innerText = `${phase} · ${spd} km/h · ${distStr} km`;
			}
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
		// Top-right, pushed down below the RWR scope (which lives at
		// top:16 with a height of ~100 px at left:75%) so the two don't
		// overlap. Keeps the panel out of the minimap's bottom-right
		// region and out of the timestamp row at the very top.
		p.style.cssText = `
			position: absolute;
			top: 130px;
			right: 16px;
			padding: 8px 12px;
			border: 1px solid rgba(255, 180, 0, 0.6);
			background: rgba(30, 20, 0, 0.55);
			color: #ffc040;
			font-family: 'AceCombat', monospace;
			font-size: 11px;
			line-height: 1.4;
			letter-spacing: 1px;
			text-shadow: 0 0 6px rgba(255, 180, 0, 0.7);
			pointer-events: none;
			z-index: 10;
			min-width: 260px;
			max-width: 460px;
			overflow: hidden;
			box-sizing: border-box;
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
			// Truncate every field to a fixed width so the row can't
			// blow past the panel's max-width. padEnd alone doesn't
			// truncate longer strings, hence the slice() pairs.
			const typeTag = (m.type || 'MSL').slice(0, 7).padEnd(7);
			const phase   = (m.boostRemaining > 0
				? `BOOST ${m.boostRemaining.toFixed(1)}s`
				: 'COAST      ').slice(0, 11).padEnd(11);
			const rng     = typeof d.rangeToTarget === 'number'
				? `${(d.rangeToTarget / 1000).toFixed(1)}km`.padStart(6)
				: '  —  ';
			const tgt     = (d.targetName || (m.target && m.target.name) || '—').slice(0, 10);
			const hdgErr  = typeof d.headingError === 'number' ? d.headingError : 0;
			const errTxt  = `err ${hdgErr.toFixed(0)}°`;
			const errCol  = Math.abs(hdgErr) > 20 ? '#ff4040'
				: (Math.abs(hdgErr) > 5 ? '#ffcc00' : '#40ff40');
			// Guidance mode tag: DL = datalink midcourse, DR = dead reckoning,
			// ACT = pitbull active lock, MAD = maddog (no lock post-pitbull).
			// Color cues: good (green) through degraded (amber/red).
			const mode = d.mode || '—';
			const modeCol = mode === 'ACT' || mode === 'DL' || mode === 'EMIT' ? '#40ff40'
				: mode === 'DR' || mode === 'LKP' ? '#ffcc00'
				: mode === 'MAD' || mode === 'LOST' ? '#ff4040'
				: mode === 'SRCH' ? '#888'
				: '#888';
			rows.push(
				`<div style="white-space:pre; font-family:monospace;">` +
				`${(i + 1).toString().padStart(2)}: ${typeTag} ${phase}  ${rng}  ` +
				`<span style="color:${modeCol}">${mode.padEnd(4)}</span>` +
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

	// Bottom-center flight info strip. AOA, G-load, V/S, SLIP, and
	// THR (with AB stripes) in one horizontal bar so the player has
	// the cockpit dials at a glance without giving up a quadrant of
	// the screen. Pinned bottom-center so it sits between the
	// minimap (bottom-left, ~250 wide) and the weapons HUD
	// (bottom-right, ~300 wide); the inline max-width keeps the
	// strip from growing into either neighbor on narrow viewports.
	createFlightInfoStrip() {
		if (document.getElementById('flight-info-strip')) return;
		const panel = document.createElement('div');
		panel.id = 'flight-info-strip';
		panel.style.cssText = `
			position: absolute;
			bottom: 30px;
			left: 50%;
			transform: translateX(-50%);
			padding: 6px 14px;
			border: 1px solid rgba(0, 255, 0, 0.4);
			background: rgba(0, 20, 0, 0.45);
			color: #0f0;
			font-family: 'AceCombat', monospace;
			font-size: 12px;
			letter-spacing: 1px;
			text-shadow: 0 0 6px rgba(0, 255, 0, 0.7);
			pointer-events: none;
			z-index: 10;
			display: flex;
			align-items: center;
			gap: 14px;
			white-space: nowrap;
			max-width: calc(100vw - 640px);
		`;
		const cell = (label, valueId, valueInit, w = 56) => `
			<div style="display:flex; align-items:center;">
				<span style="opacity:0.7; margin-right:6px;">${label}</span>
				<span id="${valueId}" style="display:inline-block; min-width:${w}px; text-align:right;">${valueInit}</span>
			</div>
		`;
		panel.innerHTML = `
			${cell('AOA',  'hud-aoa',  '  0.0&deg;')}
			<span style="opacity:0.3;">|</span>
			${cell('G',    'hud-g',    '  1.0', 38)}
			<span style="opacity:0.3;">|</span>
			${cell('V/S',  'hud-vs',   '    0', 60)}
			<span style="opacity:0.3;">|</span>
			${cell('SLIP', 'hud-beta', '  0.0&deg;')}
			<span style="opacity:0.3;">|</span>
			<div style="display:flex; align-items:center;">
				<span style="opacity:0.7; margin-right:6px;">THR</span>
				<div id="hud-thrust-bar" style="
					position:relative;
					width:90px; height:10px;
					border:1px solid rgba(0,255,0,0.5);
					background:rgba(0,20,0,0.5);
				">
					<div id="hud-thrust-fill" style="
						position:absolute; top:0; left:0; height:100%;
						background:#0f0; width:0%;
					"></div>
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
				<span id="hud-thrust-pct" style="margin-left:8px; min-width:34px; text-align:right;">  0%</span>
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
		// Per-element guards so this function still drives the thrust /
		// AB / stall indicators when the full AOA panel has been
		// retired. The AOA / G / VS / SLIP block only updates if its
		// elements are still around (i.e. createFlightDataPanel was
		// called). Stall, AB, and thrust all live in their own DOM
		// nodes and are still on by default.
		const alphaDeg = (state.alpha || 0) * 180 / Math.PI;
		const betaDeg  = (state.sideslip || 0) * 180 / Math.PI;
		const g        = state.loadFactor || 0;
		const vsFpm    = Math.round((state.verticalSpeed || 0) * 196.85);
		const aoaAbs   = Math.abs(alphaDeg);

		if (this.aoaElem) {
			this.aoaElem.innerText = `${alphaDeg.toFixed(1).padStart(6)}°`;
			this.gElem.innerText   = `${g.toFixed(1).padStart(5)}`;
			this.vsElem.innerText  = `${vsFpm >= 0 ? '+' : ''}${vsFpm.toString().padStart(5)}`;
			this.betaElem.innerText = `${betaDeg.toFixed(1).padStart(6)}°`;

			let aoaColor = '#0f0';
			if (aoaAbs > 16) aoaColor = '#ff4040';
			else if (aoaAbs > 12) aoaColor = '#ffcc00';
			this.aoaElem.style.color = aoaColor;

			const gAbs = Math.abs(g);
			let gColor = '#0f0';
			if (state.gLimiterActive) gColor = '#ff40ff';
			else if (gAbs > 9) gColor = '#ff4040';
			else if (gAbs > 7) gColor = '#ffcc00';
			this.gElem.style.color = gColor;
		}

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

	// 6a — radar/SA scope toggles. Two independent flags advanced by '
	// (background) and ; (expand) — see src/ui/menus.js / KEYBINDS.md.
	// Container classList drives layout; we just flip the JS state and
	// push it into the DOM via _applyRadarMode().
	toggleRadarBackground() {
		this.radarBackground = !this.radarBackground;
		this._applyRadarMode();
	}
	// 6b — kicked by the T-key handler in setupGlobalKeybinds when the
	// player cycles RWS/TWS/STT. Stamps a 600 ms peripheral-vision
	// glow on the scope's mode label so the change is hard to miss.
	_flashScopeMode(_mode) {
		this._scopeModeFlashUntil = performance.now() + 600;
	}

	// 6c — transient banner across the centre of the HUD for radar /
	// EW state changes. Used by the R-key emcon toggle and by the
	// T-key mode cycle when the change is consequential (RADAR
	// ACTIVE / RADAR SILENT, etc.). Self-clears after durationS.
	showRadarToast(message, color = 'rgba(255, 220, 96, 0.95)', durationS = 2.0) {
		let el = document.getElementById('radar-toast');
		if (!el) {
			el = document.createElement('div');
			el.id = 'radar-toast';
			el.style.cssText = `
				position: absolute;
				top: 70px;
				left: 50%;
				transform: translateX(-50%);
				z-index: 60;
				padding: 6px 18px;
				background: rgba(0, 25, 0, 0.65);
				border: 1px solid currentColor;
				font-family: 'AceCombat', monospace;
				font-size: 14px;
				letter-spacing: 2px;
				text-shadow: 0 0 8px currentColor;
				pointer-events: none;
				transition: opacity 0.3s ease;
				opacity: 0;
			`;
			document.body.appendChild(el);
		}
		el.textContent = message;
		el.style.color = color;
		el.style.opacity = '1';
		clearTimeout(this._radarToastTimer);
		this._radarToastTimer = setTimeout(() => {
			el.style.opacity = '0';
		}, durationS * 1000);
	}
	toggleRadarExpanded() {
		this.radarExpanded = !this.radarExpanded;
		this._applyRadarMode();
	}
	_applyRadarMode() {
		const container = document.getElementById('minimap-container');
		const cesium    = document.getElementById('minimapCesium');
		if (!container) return;
		container.classList.toggle('radar-no-bg',    !this.radarBackground);
		container.classList.toggle('radar-expanded',  this.radarExpanded);
		if (cesium) cesium.style.display = this.radarBackground ? '' : 'none';
		// Resize the canvas backing buffer to match the new container
		// size — without this the canvas stays at its old pixel
		// dimensions and CSS scales it visually, producing the blurry
		// upscaled look the user reported. Also fires the Cesium
		// viewer.resize so its WebGL context follows along.
		this.resizeMinimap();
	}

	// Discrete zoom levels cycled by the on-screen +/- buttons. `1` is
	// the "default" range used by the old settings dropdown, the rest
	// are a log-ish progression above and below so each click noticeably
	// changes what's visible. `minimapRange` is a multiplier the draw
	// code already consumes — many places use `range * 1000` or similar,
	// so these values need to stay reasonable.
	_minimapZoomLevels = [0.5, 1, 2, 5, 10, 20, 50];

	// Step the minimap zoom. +1 = zoom in (smaller range = see less area,
	// each unit appears bigger), -1 = zoom out (larger range). Called by
	// the on-screen +/− buttons and potentially future keybindings.
	adjustMinimapZoom(delta) {
		const levels = this._minimapZoomLevels;
		// Find the level closest to the current range, since the setting
		// could have been changed via the dropdown or a scenario to a
		// value that isn't exactly on our list.
		let idx = 0, bestDiff = Infinity;
		for (let i = 0; i < levels.length; i++) {
			const d = Math.abs(levels[i] - this.minimapRange);
			if (d < bestDiff) { bestDiff = d; idx = i; }
		}
		// +1 (zoom in) ⇒ go to a SMALLER range ⇒ earlier index.
		idx = Math.max(0, Math.min(levels.length - 1, idx - delta));
		this.minimapRange = levels[idx];
	}

	// On-screen +/- buttons inside the minimap frame. Added once at
	// setup; click handlers call adjustMinimapZoom.
	createMinimapZoomButtons() {
		const container = document.getElementById('minimap-container');
		if (!container) return;
		if (container.querySelector('.minimap-zoom-btn')) return; // idempotent

		const btnBase = `
			position: absolute;
			right: 4px;
			width: 22px;
			height: 22px;
			background: rgba(0, 40, 0, 0.6);
			border: 1px solid #0f0;
			color: #0f0;
			font-family: 'AceCombat', monospace;
			font-size: 16px;
			font-weight: bold;
			line-height: 18px;
			text-align: center;
			cursor: pointer;
			pointer-events: auto;
			z-index: 10;
			user-select: none;
			box-shadow: 0 0 6px rgba(0, 255, 0, 0.4);
			padding: 0;
		`;

		// Swallow mousedown as well as click. planeController wires the
		// LMB fire-trigger to the `mousedown` event at window level, and
		// `mousedown` fires BEFORE `click`. If we only stopPropagation
		// on the click, pressing the zoom buttons would still fire a
		// round of missile/gun before the zoom happens. `preventDefault`
		// on mousedown also blocks the browser from starting any drag /
		// text-select behaviour that could follow.
		const swallow = (e) => {
			e.stopPropagation();
			e.preventDefault();
		};

		const zoomInBtn = document.createElement('button');
		zoomInBtn.className = 'minimap-zoom-btn';
		zoomInBtn.textContent = '+';
		zoomInBtn.title = 'Zoom in (tighter range)';
		zoomInBtn.style.cssText = btnBase + 'top: 4px;';
		zoomInBtn.addEventListener('mousedown', swallow);
		zoomInBtn.addEventListener('mouseup',   swallow);
		zoomInBtn.addEventListener('click', (e) => {
			swallow(e);
			this.adjustMinimapZoom(+1);
		});

		const zoomOutBtn = document.createElement('button');
		zoomOutBtn.className = 'minimap-zoom-btn';
		zoomOutBtn.textContent = '\u2212'; // real minus sign (U+2212), looks balanced
		zoomOutBtn.title = 'Zoom out (wider range)';
		zoomOutBtn.style.cssText = btnBase + 'top: 30px;';
		zoomOutBtn.addEventListener('mousedown', swallow);
		zoomOutBtn.addEventListener('mouseup',   swallow);
		zoomOutBtn.addEventListener('click', (e) => {
			swallow(e);
			this.adjustMinimapZoom(-1);
		});

		container.appendChild(zoomInBtn);
		container.appendChild(zoomOutBtn);
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

			// Pitch ladder. NATO convention:
			//   - solid horizontal line at 0° (the "horizon bar")
			//   - solid lines every 5° above with small down-ticks at the
			//     ends (indicating "pitch up from horizon")
			//   - dashed lines every 5° below with up-ticks at the ends
			//     (indicating "pitch down below horizon")
			//   - number label at both ends of every line, oriented so the
			//     readout is upright from the pilot's POV
			// The whole ladder is inside horizon-container, which rotates
			// with roll — so the ladder tilts with the aircraft and the
			// horizon bar visually separates sky from ground the way a
			// real horizon would.
			const pitchLines = document.createElement('div');
			pitchLines.id = 'pitch-lines';
			pitchLines.style.cssText = `
				position: absolute;
				width: 100%;
				height: 100%;
			`;

			// Track the line elements so the update loop can reposition
			// them whenever the 3D camera's FOV changes (zoom in / zoom
			// out / window resize). The vertical spacing between lines
			// must equal the 3D view's pixels-per-degree or the ladder
			// will lag the real horizon.
			this.ladderLines = [];

			for (let i = -90; i <= 90; i += 5) {
				const isHorizon = (i === 0);
				// NATO-style: finer granularity, only show labels at
				// 5° increments that are multiples of 5. Skip the 0°
				// since it's the horizon bar (labeled via a separate
				// "+0" or just unlabeled).
				const line = document.createElement('div');
				line.dataset.pitchDeg = String(i);

				// Thicker, full-width for 0° (horizon), thinner & shorter for
				// above/below; below gets a dashed stroke for "pitch down".
				const isBelow = i < 0;
				const lineWidth = isHorizon ? 70 : (i % 10 === 0 ? 22 : 12);
				const leftPct = 50 - lineWidth / 2;
				line.style.cssText = `
					position: absolute;
					left: ${leftPct}%;
					width: ${lineWidth}%;
					height: ${isHorizon ? 2 : 1}px;
					top: 50%;
					${isHorizon
						? 'background: rgba(0, 255, 0, 0.9); box-shadow: 0 0 6px rgba(0, 255, 0, 0.5);'
						: isBelow
							? 'background: transparent; border-top: 1px dashed rgba(0, 255, 0, 0.55);'
							: 'background: rgba(0, 255, 0, 0.55);'}
				`;
				this.ladderLines.push(line);

				// End ticks on above-horizon lines (pitch-up) point DOWN;
				// on below-horizon lines (pitch-down) they point UP. Classic
				// HUD convention that lets a pilot instantly read "which
				// side of horizon" during violent manoeuvres.
				if (!isHorizon && i % 10 === 0) {
					const tickL = document.createElement('div');
					const tickR = document.createElement('div');
					const tickStyle = `
						position: absolute;
						width: 1px;
						height: 6px;
						background: rgba(0, 255, 0, 0.55);
					`;
					tickL.style.cssText = tickStyle + `left: 0; top: ${isBelow ? -6 : 0}px;`;
					tickR.style.cssText = tickStyle + `right: 0; top: ${isBelow ? -6 : 0}px;`;
					line.appendChild(tickL);
					line.appendChild(tickR);

					// Degree labels at both ends (left and right side of
					// the ladder). Minus sign is only shown below.
					const makeLabel = (side) => {
						const el = document.createElement('div');
						el.style.cssText = `
							position: absolute;
							${side}: -26px;
							top: -7px;
							color: rgba(0, 255, 0, 0.75);
							font-size: 10px;
							font-family: 'AceCombat', monospace;
							text-shadow: 0 0 4px rgba(0, 255, 0, 0.6);
						`;
						el.innerText = `${i}`;
						return el;
					};
					line.appendChild(makeLabel('left'));
					line.appendChild(makeLabel('right'));
				}

				pitchLines.appendChild(line);
			}

			// Flight-path marker ("velocity vector" / "waterline" / FPM).
			// Small circle with three short spokes — top, left, right —
			// that marks where the aircraft is actually going relative
			// to where its nose is pointed.
			//
			// NOTE: deliberately NOT a child of horizon-container. The
			// marker is world-referenced (screen-up always means the
			// velocity is above the nose in world pitch, screen-right
			// always means the velocity is to the right of the nose in
			// world heading), so it must stay un-rotated regardless of
			// bank. If it lived inside horizon-container it would pick
			// up the −roll rotation and, in a banked turn, pitch input
			// would move it sideways across the screen — which reads as
			// broken to the pilot even though real HUDs do it that way.
			const fpm = document.createElement('div');
			fpm.id = 'flight-path-marker';
			fpm.style.cssText = `
				position: absolute;
				top: 50%;
				left: 50%;
				width: 18px;
				height: 18px;
				transform: translate(-50%, -50%);
				pointer-events: none;
				z-index: 11;
			`;
			const fpmSvgNS = 'http://www.w3.org/2000/svg';
			const fpmSvg = document.createElementNS(fpmSvgNS, 'svg');
			fpmSvg.setAttribute('width', '18');
			fpmSvg.setAttribute('height', '18');
			fpmSvg.setAttribute('viewBox', '0 0 18 18');
			const fpmCircle = document.createElementNS(fpmSvgNS, 'circle');
			fpmCircle.setAttribute('cx', '9'); fpmCircle.setAttribute('cy', '9');
			fpmCircle.setAttribute('r', '4');
			fpmCircle.setAttribute('fill', 'none');
			fpmCircle.setAttribute('stroke', '#0f0');
			fpmCircle.setAttribute('stroke-width', '1.5');
			fpmSvg.appendChild(fpmCircle);
			// Three spokes: top + two horizontals.
			for (const [x1, y1, x2, y2] of [[9, 0, 9, 5], [0, 9, 5, 9], [13, 9, 18, 9]]) {
				const l = document.createElementNS(fpmSvgNS, 'line');
				l.setAttribute('x1', x1); l.setAttribute('y1', y1);
				l.setAttribute('x2', x2); l.setAttribute('y2', y2);
				l.setAttribute('stroke', '#0f0');
				l.setAttribute('stroke-width', '1.5');
				fpmSvg.appendChild(l);
			}
			fpm.appendChild(fpmSvg);

			horizon.appendChild(pitchLines);
			ui.appendChild(horizon);
			// FPM is appended to uiContainer AFTER horizon-container so
			// it stacks on top of the ladder visually.
			ui.appendChild(fpm);

			this.setShowHorizonLines(this.showHorizonLines);
		}
	}

	// NOTE: createBankIndicator() removed. The tilting pitch-ladder +
	// horizon bar already convey bank angle directly (line on the
	// ground horizon tilts) — adding a separate arc/pointer was
	// redundant and cluttered the centre of the HUD.
	_removed_createBankIndicator() {
		if (document.getElementById('bank-indicator')) return;
		const ui = document.getElementById('uiContainer');

		const container = document.createElement('div');
		container.id = 'bank-indicator';
		container.style.cssText = `
			position: absolute;
			top: 50%;
			left: 50%;
			width: 360px;
			height: 360px;
			transform: translate(-50%, -50%);
			pointer-events: none;
		`;

		const svgNS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(svgNS, 'svg');
		svg.setAttribute('width', '360');
		svg.setAttribute('height', '360');
		svg.style.cssText = 'position:absolute; inset:0;';

		const cx = 180, cy = 180, r = 150;

		// Tick angles. Longer ticks at the "major" references (0, ±30,
		// ±60), shorter at ±10, ±20, ±45. Angles given in aviation
		// convention: 0° = nose up (12 o'clock), +ve = right bank.
		const ticks = [
			{ a:   0, len: 12 },
			{ a: -10, len:  6 }, { a:  10, len:  6 },
			{ a: -20, len:  6 }, { a:  20, len:  6 },
			{ a: -30, len: 10 }, { a:  30, len: 10 },
			{ a: -45, len:  8 }, { a:  45, len:  8 },
			{ a: -60, len: 10 }, { a:  60, len: 10 },
		];
		for (const { a, len } of ticks) {
			// Screen-space position: 0° at the top (12 o'clock) is at
			// angle -π/2; a positive bank angle rotates clockwise from
			// there.
			const rad = (a - 90) * Math.PI / 180;
			const x1 = cx + r * Math.cos(rad);
			const y1 = cy + r * Math.sin(rad);
			const x2 = cx + (r - len) * Math.cos(rad);
			const y2 = cy + (r - len) * Math.sin(rad);
			const line = document.createElementNS(svgNS, 'line');
			line.setAttribute('x1', x1); line.setAttribute('y1', y1);
			line.setAttribute('x2', x2); line.setAttribute('y2', y2);
			line.setAttribute('stroke', '#0f0');
			line.setAttribute('stroke-width', '2');
			line.setAttribute('opacity', '0.7');
			svg.appendChild(line);
		}

		// Fine guide arc in the upper half so the eye can trace between
		// ticks. Drawn with a reduced opacity so it's a subtle "rail"
		// rather than a dominant element.
		const arc = document.createElementNS(svgNS, 'path');
		// Path: arc from -60° to +60° over the top of the circle.
		const aRad = (60 - 90) * Math.PI / 180;
		const bRad = (-60 - 90) * Math.PI / 180;
		const ax = cx + r * Math.cos(bRad), ay = cy + r * Math.sin(bRad);
		const bx = cx + r * Math.cos(aRad), by = cy + r * Math.sin(aRad);
		arc.setAttribute('d', `M ${ax} ${ay} A ${r} ${r} 0 0 1 ${bx} ${by}`);
		arc.setAttribute('fill', 'none');
		arc.setAttribute('stroke', '#0f0');
		arc.setAttribute('stroke-width', '1');
		arc.setAttribute('opacity', '0.25');
		svg.appendChild(arc);

		container.appendChild(svg);

		// Pointer — a small triangle that sits just inside the arc at
		// 12 o'clock. Lives in its own wrapper so we can rotate it per
		// frame without touching the static SVG.
		const pointerWrap = document.createElement('div');
		pointerWrap.id = 'bank-pointer-wrap';
		pointerWrap.style.cssText = `
			position: absolute;
			top: 50%;
			left: 50%;
			width: 360px;
			height: 360px;
			transform: translate(-50%, -50%) rotate(0deg);
			pointer-events: none;
			transform-origin: center center;
		`;
		const pointer = document.createElement('div');
		// Downward-pointing triangle (base up, apex down), sits just
		// below the arc's 12 o'clock tick so it reads as "this is where
		// my wings are tilted to". Positioned with `top` relative to
		// the wrap's centre via transform arithmetic: r - 16 px below
		// the centre from the top, then the triangle's apex.
		pointer.style.cssText = `
			position: absolute;
			top: ${180 - r + 4}px;
			left: 50%;
			width: 0;
			height: 0;
			border-left: 7px solid transparent;
			border-right: 7px solid transparent;
			border-top: 12px solid #0f0;
			transform: translateX(-50%);
			filter: drop-shadow(0 0 3px rgba(0, 255, 0, 0.7));
		`;
		pointerWrap.appendChild(pointer);
		container.appendChild(pointerWrap);

		ui.appendChild(container);
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
			const altMeters = Math.max(0, Math.round(state.alt || 0));
			this.pauseAltElem.innerText = `${altMeters.toLocaleString()} M`;
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
			// Gate on the player's fused picture — minimap should not
			// leak god-mode position info for bogeys the player hasn't
			// detected on any channel.
			if (!this._playerCanSee(state, npc)) return;

			const dx_m = (npc.lon - state.lon) * 111320 * Math.cos(state.lat * Math.PI / 180);
			const dy_m = (npc.lat - state.lat) * 111320;

			const px = centerX + dx_m * pixelsPerMeter;
			const py = centerY - dy_m * pixelsPerMeter;

			if (px < 0 || px > w || py < 0 || py > h) return;

			const teamC = _hudIffColor(state, npc);
			// 6d — first-time unknown encounter teaches the player the
			// system. One-shot toast on the first amber contact ever
			// (per session) so they connect "amber = uncertain ID,
			// don't shoot blindly" before they fire.
			if (teamC === HUD_IFF_AMBER && !this._iffUnknownToastShown) {
				this._iffUnknownToastShown = true;
				if (this.showRadarToast) {
					this.showRadarToast('UNKNOWN — IFF FAIL — VISUAL ID NEEDED',
						'rgba(255, 176, 0, 0.95)', 4.0);
				}
			}
			ctx.strokeStyle = teamC;
			ctx.lineWidth = 2;
			ctx.save();
			ctx.translate(px, py);
			ctx.rotate(45 * Math.PI / 180);
			ctx.beginPath();
			ctx.rect(-5, -5, 10, 10);
			ctx.stroke();
			ctx.restore();

			ctx.fillStyle = teamC;
			ctx.font = '10px AceCombat';
			ctx.fillText(npc.name || "BOGEY", px + 10, py + 5);
		});
	}

	// Gun reticle — a fixed boresight cross at screen centre plus a
	// lead-computed "pipper" ring showing where bullets fired NOW will
	// actually hit the currently-locked (or closest-in-cone) target.
	// Classic LCOS gunsight behaviour: pull the pipper onto the bandit,
	// squeeze the trigger. Only renders while the gun is the selected
	// weapon; hidden otherwise so it doesn't clutter missile workflows.
	createGunReticle() {
		const layer = document.createElement('div');
		layer.id = 'gun-reticle-layer';
		layer.style.cssText = 'position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none; z-index:16; display:none;';

		// Boresight cross (where the nose is pointing — where bullets
		// leave the muzzle, before target motion).
		const boresight = document.createElement('div');
		boresight.style.cssText = 'position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:40px; height:40px; pointer-events:none;';
		boresight.innerHTML = `
			<svg width="40" height="40" viewBox="-20 -20 40 40" style="overflow:visible;">
				<line x1="-18" y1="0"  x2="-6" y2="0" stroke="#0f0" stroke-width="1.5"/>
				<line x1="6"   y1="0"  x2="18" y2="0" stroke="#0f0" stroke-width="1.5"/>
				<line x1="0"   y1="-18" x2="0" y2="-6" stroke="#0f0" stroke-width="1.5"/>
				<line x1="0"   y1="6"   x2="0" y2="18" stroke="#0f0" stroke-width="1.5"/>
				<circle cx="0" cy="0" r="1.5" fill="#0f0"/>
			</svg>
		`;
		layer.appendChild(boresight);

		// Pipper — the solved-lead aimpoint. Translates each frame to
		// the predicted target intercept. Dashed funnel line back to
		// the boresight makes the solution legible at a glance.
		const pipper = document.createElement('div');
		pipper.style.cssText = 'position:absolute; left:0; top:0; width:34px; height:34px; transform:translate(-50%,-50%); pointer-events:none; display:none;';
		pipper.innerHTML = `
			<svg width="34" height="34" viewBox="-17 -17 34 34" style="overflow:visible;">
				<circle cx="0" cy="0" r="14" fill="none" stroke="#0f0" stroke-width="2"/>
				<circle cx="0" cy="0" r="2"  fill="#0f0"/>
				<line x1="-14" y1="0" x2="-17" y2="0" stroke="#0f0" stroke-width="2"/>
				<line x1="14"  y1="0" x2="17"  y2="0" stroke="#0f0" stroke-width="2"/>
				<line x1="0" y1="-14" x2="0" y2="-17" stroke="#0f0" stroke-width="2"/>
				<line x1="0" y1="14"  x2="0" y2="17"  stroke="#0f0" stroke-width="2"/>
			</svg>
		`;
		layer.appendChild(pipper);

		// Funnel line: pipper ↔ boresight. SVG line updated each frame.
		const funnel = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		funnel.setAttribute('style', 'position:absolute; left:0; top:0; width:100%; height:100%; pointer-events:none; overflow:visible;');
		const funnelLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
		funnelLine.setAttribute('stroke', '#0f0');
		funnelLine.setAttribute('stroke-width', '1');
		funnelLine.setAttribute('stroke-dasharray', '3,3');
		funnelLine.setAttribute('opacity', '0.6');
		funnel.appendChild(funnelLine);
		layer.appendChild(funnel);

		// Range readout under the pipper — "0.8 km" tells the pilot
		// whether a gun snapshot is even worth taking (>2 km is wishful
		// thinking with a 20 mm).
		const rangeLabel = document.createElement('div');
		rangeLabel.style.cssText = 'position:absolute; left:0; top:0; transform:translate(-50%, 20px); font-family:AceCombat; font-size:11px; color:#0f0; text-shadow:0 0 4px rgba(0,255,0,0.6); white-space:nowrap; pointer-events:none; display:none;';
		layer.appendChild(rangeLabel);

		this.uiContainer.appendChild(layer);
		this.gunReticle = { layer, boresight, pipper, funnel, funnelLine, rangeLabel };
	}

	// Solve for gun lead: where will the target be when a bullet fired
	// right now reaches it? Iterative solution — bullet speed is fast
	// enough that one or two passes converge. Bullet speed matches
	// Bullet.js: plane speed + 1500 m/s muzzle velocity.
	updateGunReticle(state, npcs) {
		const ret = this.gunReticle;
		if (!ret) return;

		const ws = state.weaponSystem;
		const weapon = ws && ws.getCurrentWeapon && ws.getCurrentWeapon();
		const isGun  = weapon && weapon.id === 'gun';
		if (!isGun) {
			ret.layer.style.display = 'none';
			return;
		}
		ret.layer.style.display = 'block';

		// Prefer whatever the lock logic already picked; falls back to
		// a short-range cone search so the pipper still shows something
		// useful during an unguided snapshot pass.
		let target = ws.lockingTarget || null;
		if (!target) target = this._findGunTarget(state, npcs);
		if (!target || target.destroyed) {
			ret.pipper.style.display = 'none';
			ret.funnelLine.setAttribute('x1', '0'); ret.funnelLine.setAttribute('x2', '0');
			ret.funnelLine.setAttribute('y1', '0'); ret.funnelLine.setAttribute('y2', '0');
			ret.rangeLabel.style.display = 'none';
			return;
		}

		const viewer = getViewer();
		const scene  = viewer && viewer.scene;
		const camera = scene && scene.camera;
		if (!scene || !camera) return;

		// Target state → ENU velocity vector (m/s).
		const tHdg = Cesium.Math.toRadians(target.heading || 0);
		const tPit = Cesium.Math.toRadians(target.pitch   || 0);
		const tSpd = target.speed || 0;
		const tvE = Math.sin(tHdg) * Math.cos(tPit) * tSpd;
		const tvN = Math.cos(tHdg) * Math.cos(tPit) * tSpd;
		const tvU = Math.sin(tPit) * tSpd;

		// Player state → ENU velocity vector for relative-motion lead.
		const pHdg = Cesium.Math.toRadians(state.heading || 0);
		const pPit = Cesium.Math.toRadians(state.pitch   || 0);
		const pSpd = state.speed || 0;
		const pvE = Math.sin(pHdg) * Math.cos(pPit) * pSpd;
		const pvN = Math.cos(pHdg) * Math.cos(pPit) * pSpd;
		const pvU = Math.sin(pPit) * pSpd;

		// Muzzle velocity in world frame: plane's forward unit × (spd+1500).
		// Since a bullet inherits the player's velocity, its ground speed
		// is pSpd + 1500 along the boresight — same as Bullet.speed.
		const bulletSpd = pSpd + 1500;

		// Initial range & tof estimate.
		const cosLat = Math.cos(state.lat * Math.PI / 180);
		let dE = (target.lon - state.lon) * 111320 * cosLat;
		let dN = (target.lat - state.lat) * 111320;
		let dU = (target.alt - state.alt);
		let range = Math.sqrt(dE*dE + dN*dN + dU*dU);
		let tof = range / bulletSpd;

		// Two iterations — the bullet's forward motion cancels against
		// its own velocity, so we lead by the TARGET's velocity over
		// tof. (Treating the bullet as straight-line, no gravity — fine
		// for the ~1s flight times at gun range.)
		for (let i = 0; i < 2; i++) {
			const lE = dE + tvE * tof;
			const lN = dN + tvN * tof;
			const lU = dU + tvU * tof;
			const lr = Math.sqrt(lE*lE + lN*lN + lU*lU);
			tof = lr / bulletSpd;
		}

		const leadE = dE + tvE * tof;
		const leadN = dN + tvN * tof;
		const leadU = dU + tvU * tof;

		// Back to lon/lat/alt for Cesium projection.
		const leadLon = state.lon + leadE / (111320 * cosLat);
		const leadLat = state.lat + leadN / 111320;
		const leadAlt = state.alt + leadU;

		const scratch = Cesium.Cartesian3.fromDegrees(leadLon, leadLat, leadAlt);
		const playerPos = Cesium.Cartesian3.fromDegrees(state.lon, state.lat, state.alt);

		const transformFunc = Cesium.SceneTransforms.worldToWindowCoordinates || Cesium.SceneTransforms.wgs84ToWindowCoordinates;
		const windowPos = transformFunc ? transformFunc(scene, scratch) : null;
		const dir = Cesium.Cartesian3.subtract(scratch, camera.position, new Cesium.Cartesian3());
		const depth = Cesium.Cartesian3.dot(dir, camera.direction);
		const onScreen = windowPos && depth > 0 &&
			windowPos.x >= 0 && windowPos.x <= window.innerWidth &&
			windowPos.y >= 0 && windowPos.y <= window.innerHeight;

		if (!onScreen) {
			ret.pipper.style.display = 'none';
			ret.funnelLine.setAttribute('x1', '0'); ret.funnelLine.setAttribute('x2', '0');
			ret.funnelLine.setAttribute('y1', '0'); ret.funnelLine.setAttribute('y2', '0');
			ret.rangeLabel.style.display = 'none';
			return;
		}

		ret.pipper.style.display = 'block';
		ret.pipper.style.left = windowPos.x + 'px';
		ret.pipper.style.top  = windowPos.y + 'px';

		// Gun-snapshot-range color cue. Green inside ~1500 m (lethal
		// envelope), amber out to ~2500 m, red beyond — still draws the
		// pipper but the pilot knows the solution is marginal.
		let color = '#0f0';
		const actualRange = Math.sqrt(dE*dE + dN*dN + dU*dU);
		// Rescaled for 7 km effective range: green inside 3 km where the
		// solution is tight, amber out to 5 km (sniper-ish), red beyond.
		if (actualRange > 5000) color = '#f44';
		else if (actualRange > 3000) color = '#fa0';
		ret.pipper.querySelectorAll('circle, line').forEach(el => {
			if (el.getAttribute('fill') && el.getAttribute('fill') !== 'none') el.setAttribute('fill', color);
			if (el.getAttribute('stroke')) el.setAttribute('stroke', color);
		});
		ret.funnelLine.setAttribute('stroke', color);

		// Funnel: centre screen → pipper.
		const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
		ret.funnelLine.setAttribute('x1', String(cx));
		ret.funnelLine.setAttribute('y1', String(cy));
		ret.funnelLine.setAttribute('x2', String(windowPos.x));
		ret.funnelLine.setAttribute('y2', String(windowPos.y));

		ret.rangeLabel.style.display = 'block';
		ret.rangeLabel.style.left = windowPos.x + 'px';
		ret.rangeLabel.style.top  = windowPos.y + 'px';
		ret.rangeLabel.style.color = color;
		ret.rangeLabel.textContent = (actualRange / 1000).toFixed(2) + ' km';
	}

	// Fallback target for the pipper when nothing is locked — nearest
	// hostile inside ~3 km and a 25° forward cone. Lets the pipper
	// light up during a visual snapshot even without a radar/IR lock.
	_findGunTarget(state, npcs) {
		if (!npcs || !npcs.length) return null;
		const hRad = state.heading * Math.PI / 180;
		const pRad = state.pitch   * Math.PI / 180;
		const fwdE = Math.sin(hRad) * Math.cos(pRad);
		const fwdN = Math.cos(hRad) * Math.cos(pRad);
		const fwdU = Math.sin(pRad);
		const cosLat = Math.cos(state.lat * Math.PI / 180);
		const coneCos = Math.cos(30 * Math.PI / 180);
		// Extended to 7 km to match the bumped bullet range — the pipper
		// should light up on any feasible gun target, not just knife-
		// fight distance. Beyond 7 km bullets time out mid-flight anyway.
		let best = null, bestDist = 7000;
		for (const npc of npcs) {
			if (!npc || npc.destroyed) continue;
			if (npc.team && npc.team === state.team) continue;
			const dE = (npc.lon - state.lon) * 111320 * cosLat;
			const dN = (npc.lat - state.lat) * 111320;
			const dU = (npc.alt - state.alt);
			const d = Math.sqrt(dE*dE + dN*dN + dU*dU);
			if (d < 1 || d > bestDist) continue;
			const dot = (dE*fwdE + dN*fwdN + dU*fwdU) / d;
			if (dot < coneCos) continue;
			best = npc; bestDist = d;
		}
		return best;
	}

	update(state, npcs = []) {
		const lerpFactor = 0.5;

		// 6c — radar emitter state badge. Shows the active mode so the
		// player can read their own EW posture at a glance:
		//   SILENT  — radar.active=false (R-key emcon). Player is
		//             passive: own scope/HUD shows only datalink + RWR
		//             + IRST contacts. Bandits don't see your search
		//             emissions.
		//   RWS     — search-only, no firing-grade tracks for AAMs.
		//   TWS     — track-while-scan, default BVR mode.
		//   STT     — single-target track, victim RWR spikes.
		// Color graded by aggression: green RWS (non-spike), amber TWS
		// (active scan), red STT (committed lock), grey SILENT.
		if (this.radarStateElem && this.radarStatusElem) {
			const r = state.sensors && state.sensors.radar;
			const on = !!(r && r.active);
			let text, color;
			if (!on) {
				text = 'SILENT'; color = 'rgba(180, 180, 180, 0.85)';
			} else {
				const pm = (r.playerMode || 'tws').toUpperCase();
				text = pm;
				color = pm === 'RWS' ? '#80e8ff'
					: pm === 'STT' ? '#ff7070'
					: '#ffd060';
			}
			this.radarStateElem.textContent = text;
			this.radarStatusElem.style.color = color;
		}

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
		// No longer punch out the minimap camera on afterburner — that
		// extra 1.2× zoom was visually jarring and made the map drift
		// away from the player at exactly the moment they're trying to
		// track where they are in the world.
		const zoomAlt = baseZoom + (state.speed * speedFactor);
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

			// Afterburner effects removed from the HUD layer per user
			// preference: no punchy 1.02× zoom-out, no sinusoidal
			// cockpit-shake. The HUD still tilts / shifts with
			// attitude changes (inherits pitchDiff / rollDiff /
			// throttleDiff), but the boost-specific flourish is gone.
			const scale = 1 + (throttleDiff * 0.25);
			this.currentShakeX = 0;
			this.currentShakeY = 0;
			this.smoothedBoostScale = 1.0;

			this.uiContainer.style.transform = `perspective(1000px) rotateX(${tiltX}deg) rotateY(${tiltY}deg) translate(${shiftX}px, ${shiftY}px) scale(${scale})`;
		}

		// state.speed is m/s; display in km/h since that's what the
		// player has the easiest time relating to.
		const speedKmh = Math.round((state.speed || 0) * 3.6);
		this.speedElem.innerText = speedKmh.toString().padStart(4, '0');

		// AOA panel is gone but updateFlightData still drives the
		// thrust bar, AB tag, and stall warning (per-element guarded).
		this.updateFlightData(state);
		this.updateMissileDebugPanel(state);
		this.updateMissileMarkers(state);
		this.updateMouseSteeringOverlay(state);
		this.updateRwrScope(state);
		this.updateDesignationMarkers(state);
		this.updateStrikeQueueStrip(state);
		this.updateObjectivesPanel(state);

		if (state.weaponSystem) {
			this.updateWeapons(state.weaponSystem, state);
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

		// state.alt is metres; show in metres directly.
		const altMeters = Math.max(0, Math.round(state.alt || 0));
		this.altElem.innerText = altMeters.toString().padStart(5, '0');

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

		// Pixels-per-degree scale that actually matches the 3D camera.
		// The pitch ladder is drawn on a 2D DOM overlay but the user
		// reads it against the real horizon rendered by Cesium. Those
		// two need to share the same angular scale or the ladder will
		// visibly lag behind (or race ahead of) the horizon during a
		// pitch manoeuvre. Compute it from the live vertical FOV:
		//   px/deg = windowHeight / fovY_deg
		// and fall back to a sensible guess if the viewer isn't ready
		// yet (first frame before Cesium spins up).
		let pxPerDeg = 12;
		{
			const v = getViewer();
			const fovy = v && v.camera && v.camera.frustum && v.camera.frustum.fovy;
			if (fovy) {
				pxPerDeg = window.innerHeight / ((fovy * 180) / Math.PI);
			}
		}

		const pitchLines = document.getElementById('pitch-lines');
		const horizon = document.getElementById('horizon-container');
		if (pitchLines && horizon) {
			horizon.style.transform = `translate(-50%, -50%) rotate(${-this.smoothedRoll}deg)`;
			pitchLines.style.transform = `translateY(${this.smoothedPitch * pxPerDeg}px)`;

			// Reposition each ladder line so its separation from the
			// horizon bar matches the 3D view's px/deg. Without this,
			// the translateY above would slide a correctly-spaced
			// ladder across the screen at the right speed, but the
			// lines themselves would sit at the wrong rest positions
			// (previously baked in at an implicit 6 px/deg via the %
			// layout). Skipping this would make the ladder's spacing
			// feel "compressed" relative to the actual horizon. We
			// only re-lay-out when pxPerDeg actually changes — cheap
			// in the common case (constant FOV, stable window size).
			if (this.ladderLines && Math.abs(pxPerDeg - (this._lastLadderPxPerDeg || 0)) > 0.25) {
				this._lastLadderPxPerDeg = pxPerDeg;
				for (const line of this.ladderLines) {
					const i = parseFloat(line.dataset.pitchDeg);
					// +i goes above horizon → negative offset in CSS
					// (lower top value). Using calc lets the line's
					// anchor stay at 50% (screen centre), so changes in
					// container size don't drift the origin.
					line.style.top = `calc(50% - ${i * pxPerDeg}px)`;
				}
			}
		}

		// Flight-path marker — world-referenced.
		//
		// The marker is positioned by the angular offset between the
		// velocity vector and the nose vector in WORLD axes (heading and
		// pitch), not body axes. Two consequences:
		//   - Bank angle doesn't change the marker's screen position
		//     (the horizon container isn't its parent any more).
		//   - Pitching up always moves the marker down on screen; yawing
		//     right always moves it left; regardless of how banked you
		//     are. This reads as "the marker shows where the jet is
		//     going relative to where it's pointing" from a chase-cam
		//     view, which is the intuition the user asked for.
		// Real fighter HUDs use the BODY-referenced version (so the FPM
		// sits along the tilting pitch ladder), but that only makes
		// sense from inside the cockpit — in 3rd-person view, the
		// world-referenced version is what behaves "correctly".
		const fpm = document.getElementById('flight-path-marker');
		if (fpm) {
			const vE = state.velocityE || 0;
			const vN = state.velocityN || 0;
			const vU = state.verticalSpeed || 0;
			const spd = Math.hypot(vE, vN, vU);
			// Hide when the jet isn't moving enough to have a meaningful
			// velocity direction — the atan2 / asin below would flicker
			// wildly around zero and the marker would jitter.
			if (spd > 2) {
				const vHeadingDeg = Math.atan2(vE, vN) * 180 / Math.PI;
				const vPitchDeg   = Math.asin(Math.max(-1, Math.min(1, vU / spd))) * 180 / Math.PI;
				let dHdg = vHeadingDeg - (state.heading || 0);
				while (dHdg < -180) dHdg += 360;
				while (dHdg >  180) dHdg -= 360;
				const dPitch = vPitchDeg - (state.pitch || 0);

				// Same px/deg the pitch ladder uses — keeps the FPM
				// visually consistent with the ladder's spacing, so "2
				// tick marks below the horizon" on the ladder and the
				// FPM at 10° pitch-down both sit at the same pixel.
				const dx =  dHdg   * pxPerDeg; // +right = screen-right
				const dy = -dPitch * pxPerDeg; // +pitch(up) = screen-up = negative Y in CSS
				// Clamp so extreme angles don't slide the marker off the
				// HUD altogether — caps it near the edge of the pitch-
				// ladder box.
				const cx = Math.max(-140, Math.min(140, dx));
				const cy = Math.max(-140, Math.min(140, dy));
				fpm.style.transform = `translate(calc(-50% + ${cx}px), calc(-50% + ${cy}px))`;
				fpm.style.display = 'block';
			} else {
				fpm.style.display = 'none';
			}
		}

		this.drawMinimap(state, npcs);
		this.updateNPCMarkers(npcs, state);
		this.updateGunReticle(state, npcs);
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

		// Grid intensity is dialed up when the Cesium terrain background is
		// off — without the map underneath, the canvas needs a stronger
		// reference grid to read as "tactical scope" and not "empty box."
		ctx.strokeStyle = this.radarBackground
			? 'rgba(0, 255, 0, 0.35)' : 'rgba(0, 255, 0, 0.18)';
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

		// 6a — concentric range arcs at every grid step, so the player
		// can read distance-to-contact at a glance without measuring
		// off the rectangular grid. Quartered (only an arc per
		// quadrant) so the arcs don't trip on the rectangular grid
		// lines visually.
		ctx.strokeStyle = this.radarBackground
			? 'rgba(0, 255, 0, 0.30)' : 'rgba(0, 255, 0, 0.45)';
		for (let r = gridSize; r < radius; r += gridSize) {
			ctx.beginPath();
			ctx.arc(0, 0, r, 0, Math.PI * 2);
			ctx.stroke();
		}

		// FOV wedge moved to AFTER the rotation block so it draws in
		// screen-axis-aligned coords. (Drawn here, inside the rotated
		// frame, "up on canvas" doesn't equal "forward of the player"
		// — it equals world-north — and the wedge ends up locked to
		// north regardless of player heading. See block below the
		// rotation restore.)

		npcs.forEach(npc => {
			// Same visibility gate as the pause-menu minimap — fused
			// sensor + datalink picture only, no god-mode positions.
			if (!this._playerCanSee(state, npc)) return;

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

			ctx.fillStyle = _hudIffColor(state, npc);
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

		// Missiles: the player's own always show (you fired them, you know
		// where they are). Hostile ones only show if one of the player's
		// sensor channels has a contact on them — same rule as the cockpit
		// HUD's incoming-missile markers, so the two views stay consistent.
		// Drawn as small arrows oriented along the missile's heading, in the
		// same amber/magenta palette as the commander view.
		const playerPool = (state.weaponSystem && state.weaponSystem.projectiles) || [];
		const npcPool    = state.npcProjectiles || [];
		const allMissiles = playerPool.concat(npcPool);
		const playerTeam = state.team || 'friendly';

		for (const m of allMissiles) {
			if (!m || !m.active) continue;
			const isOwnTeam = (m.team || 'friendly') === playerTeam;
			const detected = isOwnTeam ||
				(state.contacts && state.contacts.has(m));
			if (!detected) continue;

			const mdist = calculateDistance(state.lon, state.lat, m.lon, m.lat);
			if (mdist > this.minimapRange * 5000) continue;

			const dx_m = (m.lon - state.lon) * 111320 * Math.cos(state.lat * Math.PI / 180);
			const dy_m = (m.lat - state.lat) * 111320;
			const px = dx_m * pixelsPerMeter;
			const py = -dy_m * pixelsPerMeter;
			if (Math.sqrt(px * px + py * py) > radius - 4) continue;

			const color = isOwnTeam ? '#ffc040' : '#ff40e0';
			ctx.save();
			ctx.translate(px, py);
			ctx.rotate(m.heading * Math.PI / 180);
			ctx.fillStyle = color;
			// Missile shape: narrow arrowhead — visibly different from the
			// NPC kite shape at a glance.
			ctx.beginPath();
			ctx.moveTo(0, -5);
			ctx.lineTo(3, 3);
			ctx.lineTo(-3, 3);
			ctx.closePath();
			ctx.fill();
			ctx.restore();
		}

		ctx.restore();

		// 6a — radar FOV wedge. Drawn in screen-axis-aligned coords
		// (after the heading-rotated block above) because the scope is
		// HEADING-UP: forward direction is always straight UP on
		// canvas regardless of where the player is facing. Drawing
		// inside the rotated frame would lock the wedge to world-
		// north instead of the player's nose. As the player turns,
		// the wedge stays visually fixed (pointing up); ground-
		// stabilized contacts inside the rotated block visibly drift
		// across the wedge's azimuth — exactly the cranking-vs-
		// gimbal-edge cue this view is for.
		const radar = state.sensors && state.sensors.radar;
		if (radar && radar.enabled !== false && radar.fovH != null) {
			const fovH = radar.fovH;
			const wedgeR = radius;
			const fovOn  = !!radar.active && radar.mode !== 'off';
			ctx.save();
			ctx.translate(centerX, centerY);
			ctx.strokeStyle = fovOn ? 'rgba(0, 255, 80, 0.55)' : 'rgba(120, 200, 120, 0.25)';
			ctx.fillStyle   = fovOn ? 'rgba(0, 255, 80, 0.06)' : 'rgba(120, 200, 120, 0.02)';
			ctx.lineWidth = 1.2;
			ctx.beginPath();
			ctx.moveTo(0, 0);
			// Wedge fans symmetric around the straight-up direction
			// (canvas −Y). At angle ±fovH from up, the rim points are:
			//   left edge:  (−sin fovH, −cos fovH) · wedgeR
			//   right edge: (+sin fovH, −cos fovH) · wedgeR
			ctx.lineTo(-Math.sin(fovH) * wedgeR, -Math.cos(fovH) * wedgeR);
			ctx.arc(0, 0, wedgeR,
				-Math.PI / 2 - fovH, -Math.PI / 2 + fovH, false);
			ctx.lineTo(0, 0);
			ctx.fill();
			ctx.stroke();
			// Boresight line — solid down the middle of the wedge so
			// the antenna's "look-here" direction is unambiguous.
			ctx.beginPath();
			ctx.strokeStyle = fovOn ? 'rgba(0, 255, 80, 0.85)' : 'rgba(120, 200, 120, 0.4)';
			ctx.lineWidth = 1.0;
			ctx.setLineDash([4, 4]);
			ctx.moveTo(0, 0);
			ctx.lineTo(0, -wedgeR);
			ctx.stroke();
			ctx.setLineDash([]);
			ctx.restore();
		}

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

		// 6a/6b — status row at bottom of the scope. Range scale (km),
		// radar mode (RWS / TWS / STT or OFF), color-coded by
		// aggression: cyan RWS (passive), amber TWS (search + track),
		// red STT (committing). Mode flashes briefly when the player
		// cycles via T (see _flashScopeMode below).
		const radar2 = state.sensors && state.sensors.radar;
		const rdrOn = !!(radar2 && radar2.enabled !== false && radar2.active && radar2.mode !== 'off');
		let modeText, modeColor;
		if (!rdrOn) {
			modeText = 'OFF';
			modeColor = 'rgba(255, 100, 100, 0.85)';
		} else {
			const pm = (radar2.playerMode || 'tws').toUpperCase();
			modeText = pm;
			modeColor = pm === 'RWS' ? '#80e8ff'
				: pm === 'STT' ? '#ff7070'
				: '#ffd060';   // TWS amber
		}
		const rangeKm = this.minimapRange * 5;  // matches the 5000-m range gate
		ctx.save();
		ctx.font = '11px AceCombat, monospace';
		ctx.textBaseline = 'bottom';
		ctx.shadowBlur = 0;
		ctx.fillStyle = 'rgba(0, 255, 0, 0.85)';
		ctx.textAlign = 'left';
		ctx.fillText(`${rangeKm} KM`, 6, h - 4);
		// Mode label, with a brief glow flash on cycle so the player
		// catches the change in their peripheral vision.
		const flashT = this._scopeModeFlashUntil
			? Math.max(0, this._scopeModeFlashUntil - performance.now())
			: 0;
		const flashing = flashT > 0;
		ctx.textAlign = 'right';
		ctx.fillStyle = modeColor;
		if (flashing) {
			ctx.shadowColor = modeColor;
			ctx.shadowBlur  = 12 * (flashT / 600);
			ctx.font = 'bold 12px AceCombat, monospace';
		}
		ctx.fillText(modeText, w - 6, h - 4);
		ctx.shadowBlur = 0;
		ctx.font = '11px AceCombat, monospace';
		// Center cue when expanded: shows the toggles available.
		if (this.radarExpanded) {
			ctx.textAlign = 'center';
			ctx.fillStyle = 'rgba(0, 255, 0, 0.55)';
			ctx.font = '9px AceCombat, monospace';
			ctx.fillText("' map · ; size · T mode · R emcon", w / 2, h - 4);
		}
		ctx.restore();
	}

	// Player-visible check: unit appears in the player's own RADAR
	// or IR contacts, OR in the team datalink fused picture (AWACS,
	// wingmen). Used to gate every HUD / minimap / marker that
	// shows NPC positions — without this, the player sees unit
	// positions as god-mode, which makes stealth, radar-off runs,
	// and notching meaningless.
	//
	// Visual contacts deliberately do NOT generate HUD tracks. The
	// pilot's eyeballs aren't tied into the targeting system — what
	// they see out the canopy is up to them, not the avionics. The
	// visual channel still feeds NPC AI decision-making (see
	// scanVisual + the AI behavior tree); we only suppress it from
	// the player's HUD.
	_playerCanSee(playerState, npc) {
		if (!playerState || !npc) return false;
		// Friendlies are always visible (wingmen, AWACS, tankers) —
		// no need to "detect" your own team.
		if (npc.team && npc.team === playerState.team) return true;
		if (playerState.contacts && playerState.contacts.has(npc)) {
			const c = playerState.contacts.get(npc);
			if (c && (c.radar || c.ir)) return true;
		}
		if (playerState.datalinkContacts && playerState.datalinkContacts.has(npc)) return true;
		return false;
	}

	updateNPCMarkers(npcs, playerState) {
		const viewer = getViewer();
		if (!viewer) return;

		const visible = npcs.filter(n => this._playerCanSee(playerState, n));

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

		// 6d — color the diamond by IFF perception, not raw team.
		// Realistic IFF can leave a contact 'unknown' until visual ID
		// or NCTR resolves it; that comes through as amber here so
		// the player has clear ROE pressure (don't shoot the amber!).
		// Omniscient mode bypasses identifyContact and this collapses
		// back to team-based coloring.
		const teamC = _hudIffColor(state, npc);
		marker.diamond.style.borderColor = teamC;
		marker.diamond.style.boxShadow = `0 0 10px ${teamC}80`;

		// AESA lock indicator. Three visual tiers:
		//   - DESIGNATED (this one will fire): bright solid green box +
		//     "TGT" label above.
		//   - LOCKED (other simultaneous tracks): dimmer yellow/amber
		//     box + small "LOK" tag.
		//   - LOCKING (track in progress): blinking dashed amber box.
		//   - otherwise: no box.
		const ws = state.weaponSystem;
		const lockEntry = ws && ws.locks && ws.locks.get(npc);
		const isDesignated = ws && ws.designatedTarget === npc;
		if (lockEntry) {
			marker.lockBox.style.display = 'block';
			if (isDesignated && lockEntry.status === 'LOCKED') {
				marker.lockBox.classList.remove('locking-blink');
				marker.lockBox.style.borderColor     = '#0f0';
				marker.lockBox.style.borderStyle     = 'solid';
				marker.lockBox.style.borderWidth     = '2px';
				marker.lockBox.style.boxShadow       = '0 0 10px rgba(0, 255, 0, 0.6)';
				marker.lockBox.innerHTML = '<span style="position:absolute; top:-20px; left:50%; transform:translateX(-50%); font-weight:bold; color:#0f0; font-size:12px; text-shadow: 0 0 8px rgba(0, 255, 0, 0.8);">TGT</span>';
			} else if (lockEntry.status === 'LOCKED') {
				// Secondary track: still locked, still targetable via
				// Tab, but not the one a missile shot will fire at.
				marker.lockBox.classList.remove('locking-blink');
				marker.lockBox.style.borderColor     = '#ffcc40';
				marker.lockBox.style.borderStyle     = 'solid';
				marker.lockBox.style.borderWidth     = '1px';
				marker.lockBox.style.boxShadow       = '0 0 6px rgba(255, 204, 64, 0.35)';
				marker.lockBox.innerHTML = '<span style="position:absolute; top:-18px; left:50%; transform:translateX(-50%); color:#ffcc40; font-size:10px; letter-spacing:1px; text-shadow: 0 0 4px rgba(255, 204, 64, 0.6);">LOK</span>';
			} else {
				// Still LOCKING — acquisition in progress.
				marker.lockBox.classList.add('locking-blink');
				marker.lockBox.style.borderColor     = '#ffcc40';
				marker.lockBox.style.borderStyle     = 'dashed';
				marker.lockBox.style.borderWidth     = '1px';
				marker.lockBox.style.boxShadow       = 'none';
				marker.lockBox.innerHTML = '';
			}
		} else {
			marker.lockBox.style.display = 'none';
			marker.lockBox.innerHTML = '';
			marker.lockBox.classList.remove('locking-blink');
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
		// Visual channel intentionally omitted — the pilot's eyes
		// aren't part of the targeting system. See _playerCanSee.
		const channelHtml =
			ch('R', !!(contact && contact.radar),  '#40ff40') +
			ch('I', !!(contact && contact.ir),     '#ff4040');
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

	// Build (or fetch from cache) one weapon-list row keyed by weapon
	// type. Rows are reused across frames so we don't churn DOM when
	// updating ammo / progress — innerHTML is touched once on creation.
	_ensureWeaponRow(key) {
		let row = this.weaponRows.get(key);
		if (row) return row;
		row = document.createElement('div');
		row.className = 'weapon-item';
		row.dataset.key = key;
		row.innerHTML =
			'<div class="weapon-progress"></div>' +
			'<span class="weapon-name"></span>' +
			'<span class="weapon-status" style="font-weight:bold; margin-right:6px;"></span>' +
			'<span class="weapon-ammo">--</span>';
		this.weaponList.appendChild(row);
		this.weaponRows.set(key, row);
		return row;
	}

	// One-row update. Pulls name / ammo / progress / classes from
	// `weapon` (a slot from weaponSystem.weapons or the flareWeapon).
	// `weaponSlotKey` is the legacy id ('gun' | 'missile' | 'agm' |
	// 'flare') used by the empty-warning blink path. `slotNumber` is
	// the in-list index shown as a small "1." / "2." prefix on the
	// row — matches the player's number-key bind for this weapon.
	_updateWeaponRow(row, weapon, isActive, isOverheated, isEmptyWarning,
	                 slotNumberOrNull, progressPct, weaponSystem, playerState) {
		row.style.display = '';
		row.classList.toggle('active', !!isActive);
		row.classList.toggle('overheated', !!(isOverheated || isEmptyWarning));

		const nameElem   = row.querySelector('.weapon-name');
		const ammoElem   = row.querySelector('.weapon-ammo');
		const progElem   = row.querySelector('.weapon-progress');
		const statusElem = row.querySelector('.weapon-status');

		if (nameElem) {
			const prefix = (slotNumberOrNull != null) ? `${slotNumberOrNull}. ` : '';
			nameElem.textContent = prefix + (weapon.name || weapon.type || weapon.id);
		}
		if (ammoElem) {
			if (isOverheated) ammoElem.textContent = 'OVERHEAT';
			else if (weapon.ammo === Infinity) ammoElem.textContent = '∞';
			else {
				// Phase 5.5 — display aggregate flight ammo when wingmen
				// are present. The trigger pull walks the formation pool
				// (pickWingmanShooter) for AGM/GBU classes, so the
				// player's "ammo remaining" mental model is the SUM
				// across the formation, not just their own. Render as
				// `total / own` when wingmen contribute, plain `total`
				// otherwise so 0-wingmen sorties stay unchanged.
				let extra = 0;
				try {
					if (weapon.id === 'agm' || weapon.id === 'gbu') {
						extra = totalWingmanAmmo(weapon.type) || 0;
					}
				} catch (e) { extra = 0; }
				const total = weapon.ammo + extra;
				if (extra > 0) {
					ammoElem.textContent = `${String(total).padStart(2, '0')}`;
					ammoElem.title = `${weapon.ammo} you + ${extra} flight`;
				} else {
					ammoElem.textContent = String(weapon.ammo).padStart(2, '0');
					ammoElem.title = '';
				}
			}
		}
		if (progElem) progElem.style.width = `${progressPct}%`;

		// Strike-weapon release-envelope tag. Only the active row gets
		// it (multiple in-zone tags would be visual noise) and only
		// when the player has actually designated a point. Hides on
		// SLEW or non-strike weapons.
		if (statusElem) {
			let tag = '';
			let col = '';
			if (isActive && weapon.id === 'jammer' && playerState) {
				// Show the current jam designation + beam state right
				// next to the EW JAMMER weapon row, since this slot
				// has no lock progress / ammo to read.
				const ws  = weaponSystem;
				const tgt = ws && ws.designatedJamTarget;
				const off = playerState.jammer && playerState.jammer.offensiveTargets;
				if (tgt) {
					const lit = off && off.has(tgt);
					tag = lit ? `JAMMING ${tgt.name || ''}`.trim()
					          : `TGT ${tgt.name || ''}`.trim();
					col = lit ? '#ff7030' : '#ffcc60';
				} else {
					tag = 'TAB TO DESIGNATE';
					col = '#aa9070';
				}
			} else if (isActive && weapon.type && playerState) {
				const munId = munitionIdForSimType(weapon.type);
				const data  = munId ? MUNITIONS[munId] : null;
				if (isStrikeWeapon(data)) {
					const env = releaseEnvelope(playerState, playerDesignation, data);
					if (env) {
						if (env.status === 'IN')        { tag = 'IN ZONE'; col = '#40ff40'; }
						else if (env.status === 'NEAR') { tag = 'NEAR';    col = '#ffcc00'; }
						else                            { tag = 'OUT';     col = '#ff4040'; }
					}
				}
			}
			statusElem.textContent = tag;
			statusElem.style.color = col;
		}
	}

	updateWeapons(weaponSystem, playerState) {
		const currentWeapon = weaponSystem.getCurrentWeapon();
		this._updateWeaponsPlayerState = playerState || null;
		const now = performance.now() * 0.001;

		// Show the missile-crosshair overlay whenever a guided weapon
		// (any AAM, AGM, or otherwise non-gun) is selected. Gun gets
		// its own pipper logic elsewhere.
		const isGuidedSelected = !!currentWeapon &&
			currentWeapon.id !== 'gun' &&
			currentWeapon.id !== 'flare';
		this.showMissileCrosshair(isGuidedSelected);

		// Build the row list dynamically from carried weapons. The
		// flare row pins to the bottom regardless. Number keys
		// 1..N map to the Nth carried weapon (see
		// weaponSystem._carriedWeapons + planeController), so the
		// label prefix matches what the player sees on the keyboard.
		const carried = (typeof weaponSystem._carriedWeapons === 'function')
			? weaponSystem._carriedWeapons()
			: weaponSystem.weapons.filter(w => w.ammo === Infinity || w.ammo > 0);

		const seen = new Set();

		carried.forEach((weapon, idx) => {
			const key = `w:${weapon.type || weapon.id}`;
			seen.add(key);
			const row = this._ensureWeaponRow(key);

			const isActive       = weapon === currentWeapon;
			const isOverheated   = weapon.id === 'gun' && weaponSystem.isGunOverheated;
			const isEmptyWarning = weaponSystem.emptyWarningTimers
				&& weaponSystem.emptyWarningTimers[weapon.id] > 0;

			let progressPct = 0;
			if (weapon.id === 'gun') {
				progressPct = (weaponSystem.gunHeat || 0) * 100;
			} else if (weapon.fireRate) {
				const dt = now - (weapon.lastFire || 0);
				if (dt < weapon.fireRate) progressPct = (dt / weapon.fireRate) * 100;
			}

			this._updateWeaponRow(
				row, weapon, isActive, isOverheated, isEmptyWarning,
				idx + 1, progressPct, weaponSystem,
				this._updateWeaponsPlayerState,
			);
		});

		// Flare row — always last, even when empty (so the player
		// can see flare count even if a magazine is dry).
		const flare = weaponSystem.flareWeapon;
		if (flare) {
			seen.add('flare');
			const row = this._ensureWeaponRow('flare');
			const isFlareEmpty = flare.ammo <= 0;
			const isFlareActiveBlink = (now - flare.lastFire) < 1.0;
			const isEmptyWarning = weaponSystem.emptyWarningTimers
				&& weaponSystem.emptyWarningTimers.flare > 0;
			let progressPct = 0;
			const dt = now - (flare.lastFire || 0);
			if (dt < 1.0) progressPct = (dt / 1.0) * 100;
			this._updateWeaponRow(
				row, flare, isFlareActiveBlink, false, isEmptyWarning,
				null, progressPct, weaponSystem,
				this._updateWeaponsPlayerState,
			);
			// Fade out when the magazine is dry — visual cue distinct
			// from "active" / "overheated".
			row.style.opacity = isFlareEmpty ? '0.35' : '';
		}

		// Hide rows for weapons no longer in the carried list (e.g.
		// the player just emptied an AAM magazine). Keep them in the
		// DOM cache so a refill / reload re-uses the same row.
		for (const [key, row] of this.weaponRows) {
			if (!seen.has(key)) row.style.display = 'none';
		}
	}
}
