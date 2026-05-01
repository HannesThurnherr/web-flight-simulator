// ============================================================================
// Main-menu scenario picker.
//
// Builds one card per entry in the SCENARIOS registry, highlights the
// currently-selected one, and persists the choice to gameSettings so the
// selection survives a page reload. Drop a new JSON in src/data/scenarios
// and the card appears automatically.
//
// Phase 10b: also surfaces the "+ NEW SCENARIO" entry-point + EDIT /
// DUPLICATE buttons on each card. EDIT is shown only for user-authored
// scenarios; bundled scenarios get DUPLICATE instead. Both routes
// dispatch a CustomEvent that main.js (or the editor lifecycle) listens
// to so the picker module stays decoupled from the editor's actual
// implementation.
// ============================================================================

import {
	SCENARIOS, setActiveScenario, refreshScenarios,
	isBundled, getRawScenario,
} from '../systems/scenarios';
import {
	emptyScenario, nextUserId, duplicateScenario, deleteUserScenario, saveUserScenario,
} from '../systems/scenarios/userScenarios.js';
import { gameSettings, saveSettings } from './settings';

// Dispatched on `window` when the user clicks NEW or EDIT. Carries
// `{ id }` of the scenario to open in the editor (newly-created for
// NEW, existing for EDIT). The editor opens itself in response.
function _dispatchEdit(id) {
	window.dispatchEvent(new CustomEvent('scenario-edit-request', { detail: { id } }));
}

export function setupScenarioPicker() {
	const container = document.getElementById('scenarioCards');
	if (!container) return;

	render(container);
}

function render(container) {
	container.innerHTML = '';
	const cards = new Map(); // id → DOM element

	const select = (id) => {
		setActiveScenario(id);
		for (const [cid, el] of cards) {
			el.classList.toggle('selected', cid === id);
			el.setAttribute('aria-pressed', cid === id ? 'true' : 'false');
		}
		gameSettings.lastScenarioId = id;
		saveSettings();
	};

	// "+ NEW SCENARIO" card always at the top — feels natural as the
	// first option in the picker grid. Clicking it generates a fresh
	// id and dispatches the edit-request event with that id; the
	// editor (10b.3) will pull the empty scenario template via
	// userScenarios.emptyScenario.
	const newCard = document.createElement('button');
	newCard.type = 'button';
	newCard.className = 'scenario-card scenario-card--new clickable-ui';
	newCard.innerHTML = `
		<span class="card-name">＋ NEW SCENARIO</span>
		<span class="card-desc">Open the editor with an empty scenario.</span>
	`;
	newCard.addEventListener('click', () => {
		const usedIds = Object.keys(SCENARIOS);
		const id = nextUserId(usedIds, 'untitled');
		const blank = emptyScenario(id, 'New Scenario');
		// Save the empty record up front so the editor has something
		// to load — otherwise the round-trip "EDIT untitled-1" would
		// fail because no JSON exists for that id yet.
		saveUserScenario(id, blank);
		refreshScenarios();
		_dispatchEdit(id);
	});
	container.appendChild(newCard);

	const firstId = Object.keys(SCENARIOS)[0];
	for (const [id, scn] of Object.entries(SCENARIOS)) {
		const isUser = !isBundled(id);
		const card = document.createElement('div');
		card.className = 'scenario-card clickable-ui'
			+ (isUser ? ' scenario-card--user' : ' scenario-card--bundled');
		card.setAttribute('role', 'radio');
		card.setAttribute('aria-pressed', 'false');

		const badge = isUser
			? '<span class="card-badge card-badge--user">USER</span>'
			: '<span class="card-badge card-badge--bundled">BUNDLED</span>';
		const editBtn = isUser
			? `<button type="button" class="card-action card-action--edit" data-id="${id}">EDIT</button>`
			+ `<button type="button" class="card-action card-action--delete" data-id="${id}">DEL</button>`
			: `<button type="button" class="card-action card-action--dup" data-id="${id}">DUPLICATE</button>`;

		card.innerHTML = `
			<div class="card-row card-row--top">
				<span class="card-name">${escapeHtml(scn.name || id)}</span>
				${badge}
			</div>
			<span class="card-desc">${escapeHtml(scn.description || '')}</span>
			<div class="card-actions">${editBtn}</div>
		`;

		// Card body click selects; explicit-button clicks shortcut to
		// edit / duplicate / delete and stop propagation so they don't
		// also flip the selection.
		card.addEventListener('click', () => select(id));

		const editEl = card.querySelector('.card-action--edit');
		if (editEl) editEl.addEventListener('click', (e) => {
			e.stopPropagation();
			_dispatchEdit(id);
		});

		const dupEl = card.querySelector('.card-action--dup');
		if (dupEl) dupEl.addEventListener('click', (e) => {
			e.stopPropagation();
			const usedIds = Object.keys(SCENARIOS);
			const sourceJson = getRawScenario(id);
			if (!sourceJson) return;
			const newId = duplicateScenario(sourceJson, usedIds);
			refreshScenarios();
			render(container);
			_dispatchEdit(newId);
		});

		const delEl = card.querySelector('.card-action--delete');
		if (delEl) delEl.addEventListener('click', (e) => {
			e.stopPropagation();
			// Confirm before destructive action — user scenarios are
			// the player's own work, accidental clicks on a tiny DEL
			// button shouldn't lose it.
			const ok = window.confirm(`Delete user scenario "${scn.name || id}"?`);
			if (!ok) return;
			deleteUserScenario(id);
			refreshScenarios();
			render(container);
		});

		container.appendChild(card);
		cards.set(id, card);
	}

	// Prefer the persisted choice if it still exists in the registry;
	// fall back to the first-listed scenario when it doesn't (e.g. the
	// user saved a scenario that was since deleted).
	const savedId = gameSettings.lastScenarioId;
	const initialId = (savedId && SCENARIOS[savedId]) ? savedId : firstId;
	if (initialId && cards.has(initialId)) select(initialId);
}

function escapeHtml(s) {
	return String(s)
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

