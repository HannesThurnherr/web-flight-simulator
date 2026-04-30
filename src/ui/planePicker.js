// ============================================================================
// Plane picker — two-layer UI:
//   1. A compact "current airframe" badge in the main menu: small
//      spinning preview + name + tag chips + a CHANGE button.
//   2. A modal dialog opened by CHANGE, with a list of planes on the
//      left and a detail panel (bigger preview + full specs +
//      description) on the right. Selecting a plane in the list only
//      updates the detail view; CONFIRM commits the pick and closes
//      the modal. CLOSE (x) discards the pending pick.
//
// Both preview canvases are PlanePreview instances. Using two rather
// than trying to share keeps the animation loops independent and avoids
// re-parenting DOM canvases. Loadout configuration layers onto the
// same modal via a tab switch.
//
// Extracted from main.js. The caller supplies ctx.loadPlayerPlane so
// this module doesn't need to import the cockpit-loading pipeline
// directly (that would make the cycle: planePicker → main's
// loadPlayerPlane → planePicker again). `loadPlayerPlane` is only
// invoked for real selection changes AFTER `setupComplete` flips true,
// mirroring the previous inline behaviour.
// ============================================================================

import { PLANES, setActivePlane, getActivePlaneId } from '../plane/planes';
import { SIGNATURES } from '../systems/signatures';
import { MUNITIONS, munitionsForHardpoint } from '../weapon/munitions';
import {
	getLoadout, setLoadoutSlot, fillAllCompatible, clearAll,
	totalWeightKg, isStealthBroken,
	effectiveRcsM2, externalRcsM2,
} from '../plane/loadout';
import { PlanePreview } from './planePreview';
import { MunitionPreview } from './munitionPreview';
import { gameSettings, saveSettings } from './settings';
import { computeSpecs, UNMODELED_FIELDS } from './planeSpecsView';

export function setupPlanePicker(ctx) {
	const loadPlayerPlane = ctx.loadPlayerPlane;

	// ---- Compact "current aircraft" badge in the main menu ----
	const nameEl         = document.getElementById('currentAirframeName');
	const tagsEl         = document.getElementById('currentAirframeTags');
	const changeBtn      = document.getElementById('changeAirframeBtn');
	const compactCanvas  = document.getElementById('planePreview');
	const compactPreview = compactCanvas ? new PlanePreview(compactCanvas) : null;

	// ---- Modal detail picker ----
	const modal         = document.getElementById('airframeModal');
	const listEl        = document.getElementById('airframePickerList');
	const detailCanvas  = document.getElementById('planePreviewDetail');
	const detailPreview = detailCanvas ? new PlanePreview(detailCanvas) : null;
	const detailName    = document.getElementById('airframePickerName');
	const detailTags    = document.getElementById('airframePickerTags');
	const detailDesc    = document.getElementById('airframePickerDesc');
	const detailSpecs   = document.getElementById('airframePickerSpecs');
	const detailLoadout = document.getElementById('airframePickerLoadout');
	const tabButtons    = modal ? modal.querySelectorAll('.airframe-tab') : [];
	const confirmBtn    = document.getElementById('airframeConfirmBtn');

	// Tab switching. Clicking a tab highlights it and toggles the
	// matching panel's .hidden state. Panels are siblings of the tabs
	// inside the airframe-picker-detail column.
	function setTab(tabName) {
		for (const b of tabButtons) b.classList.toggle('active', b.dataset.tab === tabName);
		if (detailSpecs)   detailSpecs.classList.toggle('hidden',   tabName !== 'specs');
		if (detailLoadout) detailLoadout.classList.toggle('hidden', tabName !== 'loadout');
	}
	for (const b of tabButtons) {
		b.addEventListener('click', () => setTab(b.dataset.tab));
	}

	// Tag set shared by both badge and detail panel.
	const tagsFor = (plane) => {
		const tags = [];
		if (plane.signature && plane.signature.startsWith('stealth')) tags.push('STEALTH');
		if (plane.specs && plane.specs.supercruise) tags.push('SUPERCRUISE');
		return tags;
	};
	const renderTags = (el, tags) => {
		el.innerHTML = tags.map(t => `<span class="plane-tag">${t}</span>`).join('');
	};

	// Compact badge repaint — name, tag chips, and preview swap to
	// whatever the active plane is. Called both on initial setup and
	// every time a new plane is confirmed via the modal.
	function repaintBadge(id) {
		const p = PLANES[id];
		if (!p) return;
		if (nameEl) nameEl.textContent = p.name || id;
		if (tagsEl) renderTags(tagsEl, tagsFor(p));
		if (compactPreview) compactPreview.load(p);
	}

	// Detail panel in the modal — bigger preview, full spec sheet,
	// description. pendingId is the user's tentative pick; it replaces
	// the active selection only when they hit CONFIRM.
	let pendingId = null;
	const listItems = new Map();
	function paintDetail(id) {
		const p = PLANES[id];
		if (!p) return;
		if (detailName) detailName.textContent = p.name;
		if (detailTags) renderTags(detailTags, tagsFor(p));
		if (detailDesc) detailDesc.textContent = p.description || '';
		if (detailSpecs) {
			const c = computeSpecs(p);
			const s = p.specs || {};
			const agilityBars = Array.from({ length: 10 }, (_, i) =>
				`<span class="agility-bar ${i < (s.agility || 0) ? 'on' : ''}"></span>`,
			).join('');
			const row = (k, v, note) =>
				`<div><span class="spec-k">${k}${note ? ` <em>${note}</em>` : ''}</span>` +
				`<span class="spec-v">${v != null && v !== '' ? v : '—'}</span></div>`;
			const sect = (title) => `<div class="spec-section">${title}</div>`;

			detailSpecs.innerHTML =
				sect('Engines') +
				row('Dry thrust',         `${c.dryThrust_kN} kN`) +
				row('AB thrust',          `${c.abThrust_kN} kN`) +
				row('T/W (dry)',          c.twDry) +
				row('T/W (AB)',           c.twAB) +
				row('Supercruise',        c.supercruise ? 'YES' : 'NO') +
				row('Top speed (dry)',    `${c.topSpeedDry_ms} m/s · M ${c.topSpeedDry_M}`, '(sea-level model)') +
				row('Top speed (AB)',     `${c.topSpeedAB_ms} m/s · M ${c.topSpeedAB_M}`, '(sea-level model)') +
				sect('Airframe') +
				row('Mass',               `${c.mass_kg} kg`) +
				row('Wing area',          `${c.wingArea_m2} m²`) +
				row('Wing loading',       `${c.wingLoading_kgm2} kg/m²`) +
				row('CD₀ parasitic drag', c.cdZero) +
				sect('Control authority') +
				row('Pitch rate @ V=250', `${c.pitchRateRef} °/s`) +
				row('Roll rate @ V=250',  `${c.rollRateRef} °/s`) +
				row('Yaw rate @ V=250',   `${c.yawRateRef} °/s`) +
				row('Pitch coef (K_c)',   c.pitchCoef) +
				row('Roll coef (K_c)',    c.rollCoef) +
				row('Yaw coef (K_c)',     c.yawCoef) +
				row('G-limit soft/hard',  `${c.gSoft} / ${c.gHard}`) +
				`<div class="agility-row"><span class="spec-k">Agility index</span>
					<span class="spec-v">${agilityBars}</span></div>` +
				sect('Signature') +
				row('RCS',                c.rcs_m2 != null ? `${c.rcs_m2} m²` : null) +
				row('IR emission',        c.irEmission) +
				row('Visual size',        c.visualSize_m != null ? `${c.visualSize_m} m` : null) +
				sect('Sensors') +
				row('Radar range',        `${c.radarRange_km} km`) +
				row('Radar FOV',          `±${c.radarFovH_deg}°`) +
				row('Notch threshold',    `${c.radarNotch_ms} m/s`) +
				sect('Claimed (cosmetic)') +
				row('Role',               c.role) +
				row('Top speed (book)',   c.topSpeedClaim) +
				row('Combat radius',      c.combatRadiusClaim) +
				sect('Not yet modeled') +
				`<div class="unmodeled-list">` +
				UNMODELED_FIELDS.map(f => `<div>• ${f}</div>`).join('') +
				`</div>`;
		}
		if (detailPreview) detailPreview.load(p);
		for (const [iid, el] of listItems) el.classList.toggle('selected', iid === id);
		paintLoadout(id);
	}

	// Loadout editor.
	//
	// Layout (built once, then sub-areas innerHTML-rewritten per repaint):
	//   ┌────────────────────────────────────────────────────────────┐
	//   │ summary (weight / RCS / stealth / quick actions)           │
	//   │ tally  (LOADED chips)                                      │
	//   │ bulk toolbar  (visible when ≥1 hardpoint selected)         │
	//   │ ┌──────────────────────────────┬─────────────────────────┐ │
	//   │ │ hardpoint list (click-to-     │  munition preview        │ │
	//   │ │  select, per-row dropdown)    │  + spec readout          │ │
	//   │ └──────────────────────────────┴─────────────────────────┘ │
	//   └────────────────────────────────────────────────────────────┘
	//
	// Selection state is per plane id (cleared on plane switch). The
	// MunitionPreview is created once and persists across repaints
	// because its <canvas> sits inside an outer skeleton div whose
	// children we never wholesale-replace.
	const _selectedHps = new Set();      // current plane's selected hardpoint ids
	let _selectedPlaneForHps = null;     // plane id those selections belong to
	let _previewMunitionId = null;       // id whose model is currently shown
	let _munitionPreview = null;
	let _lastSkeletonPlaneId = null;
	let _skeletonInstalled = false;

	// Update only the preview pane (canvas + meta) without rebuilding the
	// whole list. Called from focus / hover paths so we don't blow away
	// the user's just-clicked dropdown before its menu opens.
	function updatePreviewPaneOnly(munId) {
		_previewMunitionId = munId || null;
		const m = _previewMunitionId && MUNITIONS[_previewMunitionId];
		if (_munitionPreview) _munitionPreview.show(m || null);
		const metaEl = detailLoadout && detailLoadout.querySelector('.munition-preview-meta');
		if (!metaEl) return;
		if (!m) {
			metaEl.innerHTML =
				`<div class="munition-meta-empty">Hover or focus a row to preview a weapon.</div>`;
			return;
		}
		const tagsHtml = (m.tags || []).map(t =>
			`<span class="munition-tag">${t.toUpperCase()}</span>`).join('');
		const seeker = m.seekerType ? m.seekerType.replace('_', ' ').toUpperCase() : '—';
		const range = m.loft && m.loft.maxLoftRangeM
			? `${(m.loft.maxLoftRangeM / 1000).toFixed(0)} km`
			: m.seeker && m.seeker.trackRangeM
				? `${(m.seeker.trackRangeM / 1000).toFixed(0)} km (track)`
				: '—';
		const wh = m.warhead && m.warhead.killRadiusM
			? `${m.warhead.killRadiusM} m kill / ${(m.warhead.fuzeSenseRadiusM || 0)} m fuze`
			: '—';
		metaEl.innerHTML = `
			<div class="munition-name">${m.name}</div>
			<div class="munition-tags">${tagsHtml}</div>
			<div class="munition-rows">
				<div><span class="mr-k">Mass</span><span class="mr-v">${m.massKg} kg</span></div>
				<div><span class="mr-k">Seeker</span><span class="mr-v">${seeker}</span></div>
				<div><span class="mr-k">Range</span><span class="mr-v">${range}</span></div>
				<div><span class="mr-k">Warhead</span><span class="mr-v">${wh}</span></div>
				<div><span class="mr-k">RCS</span><span class="mr-v">${(m.rcsContributionM2 || 0).toFixed(3)} m²</span></div>
			</div>
			${m.description ? `<div class="munition-desc">${m.description}</div>` : ''}
		`;
	}

	function ensureLoadoutSkeleton() {
		if (_skeletonInstalled) return;
		_skeletonInstalled = true;
		detailLoadout.innerHTML = `
			<div class="loadout-summary-area"></div>
			<div class="loadout-tally-area"></div>
			<div class="loadout-bulk-area"></div>
			<div class="loadout-body">
				<div class="loadout-list-area"></div>
				<div class="loadout-preview-area">
					<canvas class="munition-preview-canvas"></canvas>
					<div class="munition-preview-meta"></div>
				</div>
			</div>
		`;
		const canvas = detailLoadout.querySelector('.munition-preview-canvas');
		if (canvas) _munitionPreview = new MunitionPreview(canvas);
	}

	function paintLoadout(planeId) {
		if (!detailLoadout) return;
		const plane = PLANES[planeId];
		if (!plane || !Array.isArray(plane.hardpoints)) {
			if (_munitionPreview) { _munitionPreview.dispose(); _munitionPreview = null; }
			_skeletonInstalled = false;
			detailLoadout.innerHTML =
				'<div style="color:rgba(0,255,0,0.55);font-size:11px;padding:10px 0;">' +
				'No hardpoints defined for this airframe.</div>';
			return;
		}

		// Plane switch → clear selection (the old hardpoint ids may not
		// even exist on the new plane).
		if (_selectedPlaneForHps !== planeId) {
			_selectedHps.clear();
			_selectedPlaneForHps = planeId;
			_previewMunitionId = null;
		}

		ensureLoadoutSkeleton();
		_lastSkeletonPlaneId = planeId;
		const lo = getLoadout(planeId);
		const weight = totalWeightKg(planeId);
		const maxWeight = plane.maxLoadoutKg || 0;
		const over = maxWeight > 0 && weight > maxWeight;

		// RCS math: airframe baseline + per-external-store sum. Show
		// both the "clean" figure and the "effective" so the user can
		// see exactly how much the loadout costs in detectability.
		const sig = SIGNATURES[plane.signature] || {};
		const baseRcs = (typeof sig.rcs === 'number') ? sig.rcs : 0;
		const extRcs  = externalRcsM2(planeId);
		const effRcs  = effectiveRcsM2(planeId);
		const rcsPenaltyX = baseRcs > 0 ? (effRcs / baseRcs) : 0;
		const hasStealthCapability = baseRcs < 1;
		const stealthBreak = isStealthBroken(planeId);
		const stealthClass = !hasStealthCapability
			? 'na'
			: stealthBreak ? 'broken' : 'ok';
		const stealthLabel = !hasStealthCapability
			? 'N/A'
			: stealthBreak ? 'DEGRADED' : 'CLEAN';
		const weightPct = maxWeight > 0
			? Math.min(100, Math.round((weight / maxWeight) * 100))
			: 0;

		// Tally loaded munitions by id → {count, munition} so we can
		// render "LOADED: AIM-120D × 4  ·  AIM-9X × 2  ·  GBU-31 × 1"
		// below the summary. Gives an at-a-glance roster of what's on
		// the jet without scrolling the hardpoint list.
		const tally = new Map();
		for (const munId of Object.values(lo)) {
			if (!munId) continue;
			tally.set(munId, (tally.get(munId) || 0) + 1);
		}
		const tallyHtml = tally.size === 0
			? '<span style="color:rgba(0,255,0,0.4);">— nothing loaded —</span>'
			: Array.from(tally.entries()).map(([id, n]) => {
				const m = MUNITIONS[id];
				const short = (m && (m.shortName || m.name)) || id;
				return `<span class="loaded-chip">${short} <span class="loaded-count">×${n}</span></span>`;
			}).join(' ');

		// RCS display helper. Small numbers get more decimals.
		const rcsFmt = (v) => {
			if (v < 0.01) return v.toFixed(4);
			if (v < 1)    return v.toFixed(3);
			return v.toFixed(2);
		};

		// Summary row: weight meter, RCS meter, stealth chip, quick-fill
		// buttons. The RCS meter breaks out airframe baseline + store
		// contributions so the user can see where the RCS is coming
		// from (e.g. "0.008 airframe + 0.120 stores = 0.128 m²").
		const summaryHtml = `
			<div class="loadout-summary">
				<div class="meter">
					<span class="meter-label">WEIGHT</span>
					<span class="meter-value ${over ? 'over' : ''}">${weight.toLocaleString()} / ${maxWeight.toLocaleString()} kg</span>
					<div class="meter-bar"><span class="${over ? 'over' : ''}" style="width:${weightPct}%;"></span></div>
				</div>
				<div class="meter">
					<span class="meter-label">EFFECTIVE RCS</span>
					<span class="meter-value">${rcsFmt(effRcs)} m²</span>
					<span class="meter-sub">
						${rcsFmt(baseRcs)} airframe + ${rcsFmt(extRcs)} stores
						${hasStealthCapability && extRcs > 0 ? `<span class="rcs-penalty">· ${rcsPenaltyX.toFixed(0)}× clean</span>` : ''}
					</span>
				</div>
				<div class="meter">
					<span class="meter-label">STEALTH</span>
					<span class="loadout-stealth ${stealthClass}">${stealthLabel}</span>
				</div>
				<div class="loadout-actions">
					<button type="button" data-fill="aim-120d">FILL AAM</button>
					<button type="button" data-fill="clear">CLEAR</button>
				</div>
			</div>
		`;
		const tallyOnlyHtml = `
			<div class="loadout-tally">
				<span class="tally-label">LOADED</span>
				<span class="tally-body">${tallyHtml}</span>
			</div>
		`;

		// Hardpoint list. Each row is a clickable button that toggles
		// multi-selection, plus a per-row dropdown that still allows
		// fast single-slot edits. Multi-select drives the bulk toolbar
		// above the list, where the user picks one weapon and applies
		// it to every selected slot at once.
		const rowsHtml = plane.hardpoints.map((hp) => {
			const current = lo[hp.id] || '';
			const compatible = munitionsForHardpoint(hp);
			const hasOptions = compatible.length > 0;
			const isInternal = hp.type === 'internal';
			const options = ['<option value="">— empty —</option>'].concat(
				compatible.map(m => {
					const selected = m.id === current ? ' selected' : '';
					const rcs = (typeof m.rcsContributionM2 === 'number') ? m.rcsContributionM2 : 0;
					const rcsTag = isInternal ? '(internal)' : `${rcs.toFixed(3)} m²`;
					return `<option value="${m.id}"${selected}>${m.shortName || m.name} · ${m.massKg} kg · ${rcsTag}</option>`;
				}),
			);
			const cur = current && MUNITIONS[current];
			const mass = cur ? `${cur.massKg} kg` : '—';
			const rcsNote = cur
				? (isInternal
					? '<span class="hp-rcs internal">0 m² (internal)</span>'
					: `<span class="hp-rcs external">+${(cur.rcsContributionM2 || 0).toFixed(3)} m²</span>`)
				: '';
			const stealthTag = hp.stealthBreak ? ' <span style="color:#fa0;font-size:9px;">⚠ STEALTH</span>' : '';
			const selectHtml = hasOptions
				? `<select data-hp="${hp.id}">${options.join('')}</select>`
				: `<span class="hp-no-match">no ${(hp.accepts || []).join('/')} munitions available</span>`;
			const isSel = _selectedHps.has(hp.id);
			const rowClasses = ['hardpoint-row'];
			if (!hasOptions) rowClasses.push('disabled');
			if (isSel) rowClasses.push('selected');
			const checkChar = isSel ? '✓' : '';
			return `
				<div class="${rowClasses.join(' ')}" data-hprow="${hp.id}">
					<button type="button" class="hp-check" data-hpcheck="${hp.id}"
						title="Toggle selection"
						${hasOptions ? '' : 'disabled'}>${checkChar}</button>
					<div class="hp-label">
						<span class="hp-name">${hp.label || hp.id}${stealthTag}</span>
						<span class="hp-type ${hp.type || ''}">${(hp.type || '').toUpperCase()} · ${(hp.accepts || []).join('/')}</span>
					</div>
					${selectHtml}
					<span class="hp-mass">${mass}${rcsNote ? ' · ' + rcsNote : ''}</span>
				</div>
			`;
		}).join('');

		// Bulk toolbar: union of compatible munitions across selected
		// hardpoints. Using union (not intersection) keeps the dropdown
		// useful even with mixed selections — applying e.g. an AAM to a
		// GBU-only slot just no-ops on that one. We mark which slots a
		// given option will actually populate via the count badge.
		let bulkHtml = '';
		const selectedHpObjs = plane.hardpoints.filter(hp => _selectedHps.has(hp.id));
		if (selectedHpObjs.length > 0) {
			const munitionToSlots = new Map();   // munitionId -> count of slots that accept it
			for (const hp of selectedHpObjs) {
				for (const m of munitionsForHardpoint(hp)) {
					munitionToSlots.set(m.id, (munitionToSlots.get(m.id) || 0) + 1);
				}
			}
			const sorted = Array.from(munitionToSlots.entries()).sort((a, b) => b[1] - a[1]);
			const opts = ['<option value="">— pick a weapon —</option>',
				'<option value="__empty__">(empty / unload)</option>',
			].concat(sorted.map(([id, n]) => {
				const m = MUNITIONS[id];
				if (!m) return '';
				const fits = n === selectedHpObjs.length ? '' : ` · fits ${n}/${selectedHpObjs.length}`;
				const sel = id === _previewMunitionId ? ' selected' : '';
				return `<option value="${id}"${sel}>${m.shortName || m.name} · ${m.massKg} kg${fits}</option>`;
			}));
			bulkHtml = `
				<div class="loadout-bulk">
					<div class="bulk-count">${selectedHpObjs.length} slot${selectedHpObjs.length === 1 ? '' : 's'} selected</div>
					<select id="bulkWeaponSelect" class="bulk-weapon">${opts.join('')}</select>
					<button type="button" class="bulk-btn" data-bulk="apply">APPLY</button>
					<button type="button" class="bulk-btn" data-bulk="select-all">ALL</button>
					<button type="button" class="bulk-btn" data-bulk="select-none">NONE</button>
				</div>
			`;
		} else {
			bulkHtml = `
				<div class="loadout-bulk loadout-bulk-empty">
					<div class="bulk-hint">Click a slot's checkbox to multi-select, then assign a weapon to all at once</div>
					<button type="button" class="bulk-btn" data-bulk="select-all">SELECT ALL</button>
				</div>
			`;
		}

		// Munition preview side panel. Description + key spec readouts
		// next to the spinning model. Falls back to a "no preview"
		// placeholder when nothing is selected (or for munitions
		// without a 3D model, e.g. drop tanks).
		const previewMun = _previewMunitionId && MUNITIONS[_previewMunitionId];
		let metaHtml;
		if (!previewMun) {
			metaHtml = `<div class="munition-meta-empty">Hover or focus a row to preview a weapon.</div>`;
		} else {
			const m = previewMun;
			const tagsHtml = (m.tags || []).map(t =>
				`<span class="munition-tag">${t.toUpperCase()}</span>`).join('');
			const seeker = m.seekerType
				? m.seekerType.replace('_', ' ').toUpperCase()
				: '—';
			const range = m.loft && m.loft.maxLoftRangeM
				? `${(m.loft.maxLoftRangeM / 1000).toFixed(0)} km`
				: m.seeker && m.seeker.trackRangeM
					? `${(m.seeker.trackRangeM / 1000).toFixed(0)} km (track)`
					: '—';
			const wh = m.warhead && m.warhead.killRadiusM
				? `${m.warhead.killRadiusM} m kill / ${(m.warhead.fuzeSenseRadiusM || 0)} m fuze`
				: '—';
			metaHtml = `
				<div class="munition-name">${m.name}</div>
				<div class="munition-tags">${tagsHtml}</div>
				<div class="munition-rows">
					<div><span class="mr-k">Mass</span><span class="mr-v">${m.massKg} kg</span></div>
					<div><span class="mr-k">Seeker</span><span class="mr-v">${seeker}</span></div>
					<div><span class="mr-k">Range</span><span class="mr-v">${range}</span></div>
					<div><span class="mr-k">Warhead</span><span class="mr-v">${wh}</span></div>
					<div><span class="mr-k">RCS</span><span class="mr-v">${(m.rcsContributionM2 || 0).toFixed(3)} m²</span></div>
				</div>
				${m.description ? `<div class="munition-desc">${m.description}</div>` : ''}
			`;
		}

		// Push HTML into each sub-area; the canvas-bearing skeleton stays.
		detailLoadout.querySelector('.loadout-summary-area').innerHTML = summaryHtml;
		detailLoadout.querySelector('.loadout-tally-area').innerHTML = tallyOnlyHtml;
		detailLoadout.querySelector('.loadout-bulk-area').innerHTML = bulkHtml;
		detailLoadout.querySelector('.loadout-list-area').innerHTML =
			`<div class="hardpoint-list">${rowsHtml}</div>`;
		detailLoadout.querySelector('.munition-preview-meta').innerHTML = metaHtml;

		if (_munitionPreview) _munitionPreview.show(previewMun || null);

		// ----- Event wiring (re-attached each repaint, since innerHTML
		// in sub-areas blew the listeners away). -----

		// Per-row dropdown — single-slot edit path. Also bumps the
		// preview to the just-picked munition.
		for (const sel of detailLoadout.querySelectorAll('select[data-hp]')) {
			sel.addEventListener('change', (ev) => {
				const munId = ev.target.value;
				setLoadoutSlot(planeId, sel.dataset.hp, munId);
				if (munId) _previewMunitionId = munId;
				paintLoadout(planeId);
			});
			// Hovering an option doesn't bubble a usable event; fall back
			// to focus-as-preview-trigger. Critically: do NOT call
			// paintLoadout here — that rebuilds .loadout-list-area's
			// innerHTML, killing the just-focused <select> before its
			// dropdown can open. Update only the preview pane in place.
			sel.addEventListener('focus', () => {
				if (sel.value) updatePreviewPaneOnly(sel.value);
			});
		}

		// Row body click (anywhere except the dropdown / button) acts as
		// a checkbox toggle, so the user can multi-select rapidly.
		for (const row of detailLoadout.querySelectorAll('.hardpoint-row[data-hprow]')) {
			row.addEventListener('click', (ev) => {
				if (ev.target.closest('select')) return;          // dropdown handles its own
				if (ev.target.closest('[data-hpcheck]')) return;  // explicit button handles it
				const id = row.dataset.hprow;
				if (row.classList.contains('disabled')) return;
				if (_selectedHps.has(id)) _selectedHps.delete(id);
				else _selectedHps.add(id);
				paintLoadout(planeId);
			});
		}
		for (const btn of detailLoadout.querySelectorAll('[data-hpcheck]')) {
			btn.addEventListener('click', (ev) => {
				ev.stopPropagation();
				const id = btn.dataset.hpcheck;
				if (_selectedHps.has(id)) _selectedHps.delete(id);
				else _selectedHps.add(id);
				paintLoadout(planeId);
			});
		}

		// Bulk toolbar.
		const bulkSel = detailLoadout.querySelector('#bulkWeaponSelect');
		if (bulkSel) {
			bulkSel.addEventListener('change', () => {
				const v = bulkSel.value;
				if (v && v !== '__empty__') _previewMunitionId = v;
				paintLoadout(planeId);
			});
			bulkSel.addEventListener('focus', () => {
				const v = bulkSel.value;
				if (v && v !== '__empty__') updatePreviewPaneOnly(v);
			});
		}
		for (const btn of detailLoadout.querySelectorAll('[data-bulk]')) {
			btn.addEventListener('click', () => {
				const action = btn.dataset.bulk;
				if (action === 'select-all') {
					for (const hp of plane.hardpoints) {
						if (munitionsForHardpoint(hp).length > 0) _selectedHps.add(hp.id);
					}
				} else if (action === 'select-none') {
					_selectedHps.clear();
				} else if (action === 'apply') {
					const sel = detailLoadout.querySelector('#bulkWeaponSelect');
					const v = sel ? sel.value : '';
					if (!v) return;
					const munId = v === '__empty__' ? '' : v;
					for (const hp of plane.hardpoints) {
						if (!_selectedHps.has(hp.id)) continue;
						// Only assign if this hardpoint actually accepts it.
						// Mixed selections (AAM-only slot + AGM-only slot)
						// will silently no-op on the incompatible ones —
						// the count-badge in the dropdown made this clear.
						if (munId === '') {
							setLoadoutSlot(planeId, hp.id, '');
						} else {
							const fits = munitionsForHardpoint(hp).some(m => m.id === munId);
							if (fits) setLoadoutSlot(planeId, hp.id, munId);
						}
					}
				}
				paintLoadout(planeId);
			});
		}

		// Quick-action buttons in the summary row (FILL / CLEAR).
		for (const btn of detailLoadout.querySelectorAll('button[data-fill]')) {
			btn.addEventListener('click', () => {
				const what = btn.dataset.fill;
				if (what === 'clear') clearAll(planeId);
				else fillAllCompatible(planeId, what);
				paintLoadout(planeId);
			});
		}
	}

	// Build the left-side list once. Entries stay compact — just name
	// + any tag chip — so the list scans fast even as the roster grows.
	for (const [id, plane] of Object.entries(PLANES)) {
		const item = document.createElement('button');
		item.type = 'button';
		item.className = 'airframe-picker-item clickable-ui';
		const tags = tagsFor(plane);
		item.innerHTML = `
			<span class="api-name">${plane.name || id}</span>
			<span class="api-tags">${tags.map(t => `<span class="plane-tag">${t}</span>`).join('')}</span>
		`;
		item.addEventListener('click', () => {
			pendingId = id;
			paintDetail(id);
		});
		listEl.appendChild(item);
		listItems.set(id, item);
	}

	// ---- Commit / cancel flow ----
	let setupComplete = false;
	function commitSelection(id) {
		const changed = id !== window.__lastSelectedPlane;
		window.__lastSelectedPlane = id;
		setActivePlane(id);
		repaintBadge(id);
		if (setupComplete && changed && typeof loadPlayerPlane === 'function') {
			loadPlayerPlane(PLANES[id]);
		}
		// Persist the pick across page reloads.
		gameSettings.lastPlaneId = id;
		saveSettings();
	}

	if (changeBtn && modal) {
		changeBtn.addEventListener('click', () => {
			pendingId = getActivePlaneId();
			paintDetail(pendingId);
			modal.classList.remove('hidden');
		});
	}
	if (confirmBtn && modal) {
		confirmBtn.addEventListener('click', () => {
			if (pendingId) commitSelection(pendingId);
			modal.classList.add('hidden');
		});
	}
	// CLOSE button inherits the generic .close-modal behavior wired
	// up in setupModalListeners (toggles .hidden on parent .modal).

	// Initial selection. Prefer the persisted choice if the plane still
	// exists in the registry, otherwise fall through to whatever
	// getActivePlaneId() returns (the module-level default).
	const savedPlaneId = gameSettings.lastPlaneId;
	const initialPlaneId = (savedPlaneId && PLANES[savedPlaneId])
		? savedPlaneId
		: getActivePlaneId();
	commitSelection(initialPlaneId);
	setupComplete = true;
}
