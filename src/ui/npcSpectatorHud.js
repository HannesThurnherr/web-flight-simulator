// ============================================================================
// NPC Spectator HUD — full AI-decision readout for the spectated fighter.
//
// Shown automatically while the player is spectating an NPC (VIEW button on
// the commander map / chase cam) and the unit has an AI pilot. Renders, every
// frame, the pilot's complete decision state:
//
//   - PLAN: a synthesized one-line intention ("close to 24,300 m and fire
//     R-37M", "beaming AIM-120 + terrain mask", ...)
//   - The behavior priority stack with this frame's arbitration result
//     (which behavior owns the jet, which are idle, which were shadowed)
//   - The active behavior's internal numbers (range, WEZ, fire-gate status,
//     track age, STT timer, salvo/claims, SAM bubble geometry ...)
//   - The TargetManager's scored candidate list (who it would shoot and why)
//   - The weapon rack: ammo, cooldown bars, rounds in flight (live vs trashed)
//
// All data is read from debug fields the AI already maintains:
//   pilot.debugTrace            (per-frame behavior arbitration)
//   behavior.debug              (per-behavior internals)
//   targetManager.lastCandidates (scored target list)
// No game logic lives here — pure presentation.
// ============================================================================

const PANEL_ID = 'npc-ai-hud';

const COL = {
	text:   '#a8ffe4',
	dim:    'rgba(168,255,228,0.45)',
	faint:  'rgba(168,255,228,0.25)',
	head:   '#00ffb4',
	plan:   '#ffd27a',
	warn:   '#ff9f6a',
	bad:    '#ff6a6a',
	good:   '#7dff8a',
};

function esc(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function km(m) {
	if (m == null || !isFinite(m)) return '—';
	return m >= 10000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m).toLocaleString()} m`;
}

function row(label, value, color = COL.text) {
	return `<div style="display:flex;justify-content:space-between;gap:8px;">`
		+ `<span style="opacity:0.55;">${esc(label)}</span>`
		+ `<span style="color:${color};text-align:right;">${value}</span></div>`;
}

function section(title) {
	return `<div style="color:${COL.head};margin:7px 0 2px;border-bottom:1px solid rgba(0,220,180,0.25);`
		+ `letter-spacing:1.5px;font-size:10px;">${esc(title)}</div>`;
}

function bar(frac, color, w = 70) {
	const f = Math.max(0, Math.min(1, frac));
	return `<span style="display:inline-block;width:${w}px;height:7px;background:rgba(255,255,255,0.08);`
		+ `vertical-align:middle;"><span style="display:block;width:${Math.round(f * 100)}%;height:100%;`
		+ `background:${color};"></span></span>`;
}

// ---- PLAN synthesis ---------------------------------------------------------
// One sentence describing what the pilot intends to do next, derived from the
// active behavior + its debug record.
function planLine(pilot, activeName) {
	const beh = pilot.behaviors.find(b => b.name === activeName);
	const d = beh && beh.debug;
	switch (activeName) {
		case 'Engage': {
			if (!d) return 'engage — acquiring picture';
			const tgt = d.targetName || 'target';
			if (d.fired) return `FIRING ${d.weapon} at ${tgt}`;
			if (d.blocked) {
				// blocked strings are already written as intentions
				// ("closing to WEZ: fire R-37M at 24,300 m", "STT flash —
				// firing in 0.8s", "turning to launch axis ...")
				return `${tgt} ${km(d.range)} — ${d.blocked}`;
			}
			return `engaging ${tgt} at ${km(d.range)}`;
		}
		case 'MissileEvasion': {
			if (!d) return 'defending inbound missile';
			return `${d.phase}${d.threat ? ` vs ${d.threat}` : ''}${d.rangeM != null ? ` (${km(d.rangeM)})` : ''}`
				+ (d.detail ? ` — ${d.detail}` : '');
		}
		case 'Crank':
			return 'missile in flight — cranking off-axis, keeping datalink support';
		case 'GroundAttack': {
			if (!d) return 'prosecuting ground target';
			if (d.released) return `RELEASED ${d.weapon} at ${d.targetName} (impact ~${Math.round(d.etaS)}s, ${Math.round(d.impactDeg)}°)`;
			if (d.blocked) return `${d.targetName} ${km(d.range)} — ${d.blocked}`;
			return `ingress on ${d.targetName} (${km(d.range)})`;
		}
		case 'Investigate': {
			if (!d) return 'investigating a known contact';
			const age = d.trackAge != null ? `, track ${d.trackAge.toFixed(0)}s old` : '';
			return `investigating ${d.targetName}${age} — will engage on reacquire`;
		}
		case 'SamAvoid': {
			if (!d) return 'avoiding SAM engagement zone';
			return `${d.phase}: ${d.samName} WEZ ${km(d.bubbleM)}, we are ${km(d.distM)} out`;
		}
		case 'ForwardTerrainAvoid': return 'TERRAIN AHEAD — pulling up';
		case 'TerrainAvoid':        return 'low altitude — climbing';
		case 'CapArea':             return 'holding station / returning to orbit';
		case 'WaypointFollow':      return 'flying patrol route';
		case 'Strike':              return 'flying strike profile';
		case 'Escort':              return 'holding escort slot';
		case 'Formation':           return 'holding formation slot';
		case 'Cruise':              return 'cruising';
		default:                    return activeName || 'idle';
	}
}

// ---- Sections ---------------------------------------------------------------

function stackSection(pilot, activeName) {
	let html = section('BEHAVIOR STACK · first active wins');
	const trace = pilot.debugTrace || [];
	for (const t of trace) {
		const isActive = t.state === 'ACTIVE';
		const color = isActive ? COL.good : (t.state === 'idle' ? COL.dim : COL.faint);
		const mark  = isActive ? '▶' : (t.state === 'idle' ? '·' : ' ');
		html += `<div style="color:${color};">${mark} ${esc(t.name)}`
			+ `<span style="float:right;opacity:0.6;font-size:9px;">${esc(t.state)}</span></div>`;
	}
	return html;
}

function engageSection(pilot) {
	const beh = pilot.behaviors.find(b => b.name === 'Engage');
	const d = beh && beh.debug;
	if (!d) return '';
	let html = section('ENGAGE FIRE CONTROL');
	html += row('target', esc(d.targetName));
	html += row('range', km(d.range));
	if (d.trackAge != null) {
		html += row('track age', `${d.trackAge.toFixed(1)} s${d.stale ? ' (STALE)' : ''}`,
			d.stale ? COL.warn : COL.text);
	}
	if (d.aspectCos != null) {
		const a = d.aspectCos;
		const aspect = a > 0.4 ? 'HOT (closing)' : a < -0.4 ? 'COLD (running)' : 'BEAM';
		html += row('aspect', `${aspect} (${a.toFixed(2)})`);
	}
	html += row('weapon', d.weapon ? esc(d.weapon) : '— none ready —', d.weapon ? COL.text : COL.warn);
	if (d.wezMax != null) {
		const inWez = d.range <= d.wezMax;
		html += row('WEZ Rmax', `${km(d.wezMax)} ${inWez ? '✓ inside' : '✗ outside'}`, inWez ? COL.good : COL.warn);
	}
	if (d.angleOff != null) html += row('angle-off', `${d.angleOff.toFixed(1)}°`);
	if (d.sttRemainS != null) html += row('STT flash', `${d.sttRemainS.toFixed(1)} s to launch`, COL.plan);
	html += row('status', d.fired ? 'FIRED' : esc(d.blocked || 'evaluating'),
		d.fired ? COL.good : COL.warn);
	return html;
}

function activeDetailSection(pilot, activeName) {
	const beh = pilot.behaviors.find(b => b.name === activeName);
	const d = beh && beh.debug;
	if (!d) return '';
	switch (activeName) {
		case 'MissileEvasion': {
			let html = section('DEFENSE');
			html += row('phase', esc(d.phase || '—'), COL.warn);
			if (d.threat)  html += row('threat', `${esc(d.threat)} (${esc(d.seeker || '?')})`);
			if (d.rangeM != null) html += row('range', km(d.rangeM));
			if (d.detail)  html += row('action', esc(d.detail));
			return html;
		}
		case 'GroundAttack': {
			let html = section('GROUND ATTACK');
			html += row('target', esc(d.targetName));
			html += row('range', km(d.range));
			html += row('emitter', d.radiating ? 'RADIATING' : 'silent', d.radiating ? COL.warn : COL.dim);
			if (d.weapon) {
				html += row('weapon', esc(d.weapon));
				if (d.etaS != null)     html += row('time-of-flight', `~${Math.round(d.etaS)} s`);
				if (d.impactDeg != null) html += row('impact angle', `${Math.round(d.impactDeg)}°`);
			}
			html += row('salvo', `${d.claims}/${d.salvo} inbound`, d.claims >= d.salvo ? COL.good : COL.text);
			html += row('status', d.released ? 'WEAPON AWAY' : esc(d.blocked || 'evaluating'),
				d.released ? COL.good : COL.warn);
			return html;
		}
		case 'SamAvoid': {
			let html = section('SAM AVOIDANCE');
			html += row('site', esc(d.samName));
			html += row('WEZ + margin', km(d.bubbleM));
			html += row('distance', km(d.distM), d.distM < d.bubbleM ? COL.bad : COL.text);
			html += row('mode', esc(d.phase), COL.warn);
			return html;
		}
		case 'Investigate': {
			let html = section('INVESTIGATE');
			html += row('contact', esc(d.targetName));
			if (d.trackAge != null) html += row('track age', `${d.trackAge.toFixed(1)} s`);
			html += row('intent', esc(d.detail || ''));
			return html;
		}
		default:
			return '';
	}
}

function targetsSection(pilot) {
	const tm = pilot.subsystems && pilot.subsystems.targetManager;
	if (!tm) return '';
	const cands = (tm.lastCandidates || []).slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
	const best = tm.getBest && tm.getBest();
	let html = section(`AIR PICTURE · ${cands.length} candidate${cands.length === 1 ? '' : 's'} (leash ${km(tm.maxEngagementRange)})`);
	if (!cands.length) return html + `<div style="color:${COL.dim};">no engageable contacts</div>`;
	for (const c of cands.slice(0, 5)) {
		const isBest = best && c.target === best.target;
		const name = c.target.name || (c.target.signature && c.target.signature.unitClass) || '?';
		const flags = `${c.isMemory ? `mem ${c.age.toFixed(0)}s` : 'live'}`;
		html += `<div style="display:flex;justify-content:space-between;gap:6px;color:${isBest ? COL.good : COL.dim};">`
			+ `<span>${isBest ? '▶' : ' '} ${esc(name)}</span>`
			+ `<span>${km(c.range)}</span>`
			+ `<span style="opacity:0.7;">${flags}</span>`
			+ `<span style="opacity:0.7;">${Math.round(c.score ?? 0).toLocaleString()}</span></div>`;
	}
	return html;
}

function weaponsSection(pilot, npc, projectiles) {
	const ws = pilot.subsystems && pilot.subsystems.weapons;
	if (!ws || !ws.weapons) return '';
	const now = pilot.lastNow ?? 0;
	let html = section('WEAPONS');
	for (const w of ws.weapons) {
		const ammoStr = w.ammo === Infinity ? '∞' : String(w.ammo);
		// Cooldown bar: 1 = ready.
		const since = now - (w.lastFire ?? -Infinity);
		const cdFrac = w.fireRate > 0 ? Math.min(1, since / w.fireRate) : 1;
		// In-flight count, split live vs trashed (lostLock / maddog).
		let live = 0, dead = 0;
		if (projectiles) {
			for (const p of projectiles) {
				if (!p || !p.active || p.launcher !== npc || p.type !== w.type) continue;
				if (p.lostLock || p.maddog) dead++; else live++;
			}
		}
		const ready = w.ammo > 0 && cdFrac >= 1 && (!w.maxInFlight || live < w.maxInFlight);
		let state;
		if (w.ammo <= 0) state = `<span style="color:${COL.bad};">WINCHESTER</span>`;
		else if (cdFrac < 1) state = bar(cdFrac, COL.warn) + ` <span style="color:${COL.warn};">${(w.fireRate - since).toFixed(0)}s</span>`;
		else if (w.maxInFlight && live >= w.maxInFlight) state = `<span style="color:${COL.warn};">supporting ${live} in flight</span>`;
		else state = `<span style="color:${COL.good};">READY</span>`;
		const flight = (live || dead)
			? ` <span style="opacity:0.6;">[${live} fly${dead ? `, ${dead} missed` : ''}]</span>` : '';
		html += `<div style="display:flex;justify-content:space-between;gap:6px;">`
			+ `<span style="color:${ready ? COL.text : COL.dim};">${esc(w.type)} ×${ammoStr}${flight}</span>`
			+ `<span>${state}</span></div>`;
	}
	const cm = pilot.subsystems.countermeasures;
	if (cm) html += row('countermeasures', `${cm.flareCount ?? 0} flare / ${cm.chaffCount ?? 0} chaff`);
	return html;
}

// ---- Main entry --------------------------------------------------------------

export function updateNpcSpectatorHud(ctx) {
	const npc = ctx.spectatorTarget;
	const pilot = npc && npc.pilot;
	let panel = document.getElementById(PANEL_ID);
	// Only meaningful for AI units that run the behavior-stack pilot
	// (fighters & strikers). SAM/AAA closure pilots have no behaviors array.
	if (!pilot || !Array.isArray(pilot.behaviors) || !pilot.behaviors.length) {
		if (panel) panel.style.display = 'none';
		return;
	}
	if (!panel) {
		panel = document.createElement('div');
		panel.id = PANEL_ID;
		panel.style.cssText = `
			position: fixed;
			left: 16px;
			top: 70px;
			width: 330px;
			max-height: calc(100vh - 140px);
			overflow: hidden;
			padding: 10px 12px;
			background: rgba(0, 18, 22, 0.82);
			border: 1px solid rgba(0, 220, 180, 0.45);
			color: ${COL.text};
			font-family: 'AceCombat', 'Courier New', monospace;
			font-size: 11px;
			line-height: 1.45;
			z-index: 56;
			pointer-events: none;
			letter-spacing: 0.4px;
		`;
		document.body.appendChild(panel);
	}
	panel.style.display = '';

	const activeName = pilot.command && pilot.command.activeBehaviorName;
	const npcSystem = ctx.npcSystem;
	const projectiles = npcSystem ? npcSystem.projectiles : null;

	let html = `<div style="color:${COL.head};font-weight:bold;border-bottom:1px solid rgba(0,220,180,0.35);`
		+ `padding-bottom:3px;margin-bottom:4px;">AI PILOT · ${esc(npc.name || npc.type || 'NPC')}`
		+ `<span style="float:right;opacity:0.6;font-size:9px;">${esc(npc.team || '')}</span></div>`;

	// PLAN — the headline.
	html += `<div style="color:${COL.plan};margin:2px 0 4px;min-height:26px;">`
		+ `<span style="opacity:0.6;font-size:9px;letter-spacing:1.5px;">PLAN</span><br>`
		+ `${esc(planLine(pilot, activeName))}</div>`;

	html += stackSection(pilot, activeName);
	// Engage fire-control detail is interesting even when Engage isn't the
	// active behavior (e.g. while cranking) — show it whenever it has data
	// AND a target exists; the dedicated detail section covers the rest.
	if (activeName === 'Engage' || activeName === 'Crank') html += engageSection(pilot);
	html += activeDetailSection(pilot, activeName);
	html += targetsSection(pilot);
	html += weaponsSection(pilot, npc, projectiles);

	panel.innerHTML = html;
}
