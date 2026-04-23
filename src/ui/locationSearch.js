// ============================================================================
// Spawn-picker location search box.
//
// Debounced Nominatim autocomplete: type ≥3 characters, wait 500 ms,
// get up to 5 matching places. Clicking a result flies the Cesium
// camera there, places a spawn marker, samples terrain height so the
// player spawns 1.5 km AGL over the terrain, and updates the spawn-
// picker instruction text. Replaces "CLICK ANYWHERE ON THE MAP" with
// the chosen place name.
//
// Extracted from main.js with the same DOM + state touches the inline
// function had. The caller supplies a ctx with:
//   state              — the player state object (lon / lat / alt written here)
//   getSpawnMarker()   — reads the current spawn marker entity (may be null)
//   setSpawnMarker(e)  — stores the new spawn marker entity
// The spawn-marker accessors exist because the marker is module-owned by
// the spawn-picker layer (main.js today, spawnFlow.js later) and this
// file has to swap it out when a new search result is chosen.
// ============================================================================

import * as Cesium from 'cesium';
import { getViewer } from '../world/cesiumWorld';

export function setupLocationSearch(ctx) {
	const { state } = ctx;
	const searchInput      = document.getElementById('locationSearch');
	const resultsContainer = document.getElementById('search-results');
	const instructionText  = document.getElementById('instruction-text');
	const searchToggleBtn  = document.getElementById('search-toggle-btn');
	const confirmSpawnBtn  = document.getElementById('confirmSpawnBtn');
	const originalSearchIcon = searchToggleBtn ? searchToggleBtn.innerHTML : '';
	let debounceTimer;

	if (searchToggleBtn) {
		searchToggleBtn.onclick = (e) => {
			e.stopPropagation();
			const isSearching = searchInput.style.display === 'block';

			if (isSearching) {
				searchInput.style.display = 'none';
				instructionText.style.display = 'block';
				resultsContainer.style.display = 'none';
			} else {
				searchInput.style.display = 'block';
				instructionText.style.display = 'none';
				searchInput.focus();
			}
		};
	}

	searchInput.addEventListener('input', (e) => {
		clearTimeout(debounceTimer);
		const query = e.target.value.trim();

		if (query.length < 3) {
			resultsContainer.style.display = 'none';
			return;
		}

		debounceTimer = setTimeout(async () => {
			if (searchToggleBtn) {
				searchToggleBtn.innerHTML = '<div class="loader-spinner"></div>';
			}

			try {
				const response = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5`);
				const data = await response.json();

				resultsContainer.innerHTML = '';
				if (data.length > 0) {
					data.forEach(item => {
						const div = document.createElement('div');
						div.textContent = item.display_name;
						div.style.padding = '10px';
						div.style.cursor = 'pointer';
						div.onclick = () => {
							const lon = parseFloat(item.lon);
							const lat = parseFloat(item.lat);

							const viewer = getViewer();
							const position = Cesium.Cartesian3.fromDegrees(lon, lat);

							state.lon = lon;
							state.lat = lat;
							state.alt = 1500;

							const cartographic = Cesium.Cartographic.fromDegrees(lon, lat);
							Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, [cartographic])
								.then(([p]) => {
									state.alt = Math.max(0, p.height || 0) + 1500;
								})
								.catch(() => { });

							viewer.camera.flyTo({
								destination: Cesium.Cartesian3.fromDegrees(lon, lat, 15000),
								duration: 1.5,
							});

							const prevMarker = ctx.getSpawnMarker ? ctx.getSpawnMarker() : null;
							if (prevMarker) {
								viewer.entities.remove(prevMarker);
							}
							const newMarker = viewer.entities.add({
								position: position,
								point: {
									pixelSize: 15,
									color: Cesium.Color.RED,
									outlineColor: Cesium.Color.WHITE,
									outlineWidth: 2,
									disableDepthTestDistance: Number.POSITIVE_INFINITY,
								},
								label: {
									text: item.display_name.split(',')[0],
									font: `14pt ${getComputedStyle(document.body).fontFamily}`,
									style: Cesium.LabelStyle.FILL_AND_OUTLINE,
									outlineWidth: 2,
									verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
									pixelOffset: new Cesium.Cartesian2(0, -20),
									disableDepthTestDistance: Number.POSITIVE_INFINITY,
								},
							});
							if (ctx.setSpawnMarker) ctx.setSpawnMarker(newMarker);

							if (confirmSpawnBtn) confirmSpawnBtn.classList.remove('hidden');
							resultsContainer.style.display = 'none';

							searchInput.style.display = 'none';
							instructionText.style.display = 'block';
							instructionText.textContent = item.display_name.split(',')[0].toUpperCase();
							searchInput.value = item.display_name;
						};
						resultsContainer.appendChild(div);
					});
					resultsContainer.style.display = 'block';
				} else {
					resultsContainer.style.display = 'none';
				}
			} catch (error) {
				console.error('Search error:', error);
			} finally {
				if (searchToggleBtn) {
					searchToggleBtn.innerHTML = originalSearchIcon;
				}
			}
		}, 500);
	});

	document.addEventListener('click', (e) => {
		if (!searchInput.contains(e.target) && !resultsContainer.contains(e.target) && !searchToggleBtn.contains(e.target)) {
			resultsContainer.style.display = 'none';
			if (searchInput.style.display === 'block') {
				searchInput.style.display = 'none';
				instructionText.style.display = 'block';
			}
		}
	});
}
