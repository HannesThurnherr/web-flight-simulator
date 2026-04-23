// ============================================================================
// Main-menu scenario picker.
//
// Builds one card per entry in the SCENARIOS registry, highlights the
// currently-selected one, and persists the choice to gameSettings so the
// selection survives a page reload. Drop a new JSON in src/data/scenarios
// and the card appears automatically.
// ============================================================================

import { SCENARIOS, setActiveScenario } from '../systems/scenarios';
import { gameSettings, saveSettings } from './settings';

export function setupScenarioPicker() {
	const container = document.getElementById('scenarioCards');
	if (!container) return;

	const cards = new Map(); // id → DOM element

	const select = (id) => {
		setActiveScenario(id);
		for (const [cid, el] of cards) {
			el.classList.toggle('selected', cid === id);
			el.setAttribute('aria-pressed', cid === id ? 'true' : 'false');
		}
		// Remember the choice so next page-load doesn't revert to the
		// first-listed scenario.
		gameSettings.lastScenarioId = id;
		saveSettings();
	};

	const firstId = Object.keys(SCENARIOS)[0];
	for (const [id, scn] of Object.entries(SCENARIOS)) {
		const card = document.createElement('button');
		card.type = 'button';
		card.className = 'scenario-card clickable-ui';
		card.setAttribute('role', 'radio');
		card.setAttribute('aria-pressed', 'false');
		card.innerHTML = `
			<span class="card-name">${scn.name || id}</span>
			<span class="card-desc">${scn.description || ''}</span>
		`;
		card.addEventListener('click', () => select(id));
		container.appendChild(card);
		cards.set(id, card);
	}

	// Prefer the persisted choice if it still exists in the registry;
	// fall back to the first-listed scenario when it doesn't (e.g. the
	// user saved a scenario that was since deleted).
	const savedId = gameSettings.lastScenarioId;
	const initialId = (savedId && SCENARIOS[savedId]) ? savedId : firstId;
	if (initialId) select(initialId);
}
