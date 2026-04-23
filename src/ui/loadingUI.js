// ============================================================================
// Boot-time loading indicator.
//
// Four async dependencies have to land before the START button becomes
// clickable: audio buffers, the plane model, Cesium itself, and the globe
// surface tiles. Each loader flips its corresponding key in
// `loadingStatus` and then calls `updateLoadingUI(currentState)`; this
// module works out what the user should see based on the combined state.
//
// Extracted from main.js so the bootstrap file stops owning DOM text
// formatting. `loadingStatus` is exported as a mutable object — importers
// flip fields on it directly, same idiom as `gameSettings` in
// ./settings.js.
// ============================================================================

export const loadingStatus = {
	audio:  false,
	model:  false,
	cesium: false,
	globe:  false,
	failed: false,
};

// Re-paint the loading indicator + START button. Takes the current game
// state as a plain string so this module doesn't have to import the
// States enum from main.js (which would create a cycle — main.js
// imports this file). Accepts the same values main.js's States enum
// produces: 'MENU', 'PICK_SPAWN', 'TRANSITIONING', 'FLYING', 'PAUSED',
// 'CRASHED'. Once FLYING / TRANSITIONING, the indicator is hidden
// regardless of loadingStatus contents — the player is already past
// the menu.
export function updateLoadingUI(currentState) {
	const loadingIndicator = document.getElementById('loadingIndicator');
	const loadingText      = document.getElementById('loadingText');
	const startBtn         = document.getElementById('startBtn');
	if (!loadingIndicator || !loadingText || !startBtn) return;

	if (currentState === 'FLYING' || currentState === 'TRANSITIONING') {
		loadingIndicator.classList.add('hidden');
		return;
	}

	let msg = '';
	const isAllLoaded = loadingStatus.audio && loadingStatus.model && loadingStatus.cesium && loadingStatus.globe;

	if (loadingStatus.failed) {
		msg = 'Loading Failed. Please Refresh.';
	} else if (!isAllLoaded) {
		if      (!loadingStatus.audio)  msg = 'Loading Audio...';
		else if (!loadingStatus.model)  msg = 'Loading Aircraft Model...';
		else if (!loadingStatus.cesium) msg = 'Loading Satellite Imagery...';
		else if (!loadingStatus.globe)  msg = 'Loading Globe Surface...';
	}

	if (msg) {
		loadingText.textContent = msg;
		startBtn.disabled = true;
		startBtn.style.pointerEvents = 'none';
		loadingIndicator.classList.remove('hidden');

		if (loadingStatus.failed) {
			loadingText.style.color = '#f00';
			const spinner = loadingIndicator.querySelector('.spinner');
			if (spinner) {
				spinner.style.borderColor = 'rgba(255, 0, 0, 0.3)';
				spinner.style.borderTopColor = '#f00';
			}
		}
	} else {
		loadingIndicator.classList.add('hidden');
		startBtn.disabled = false;
		startBtn.style.pointerEvents = 'auto';
	}
}
