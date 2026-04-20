import * as Cesium from 'cesium';

// ============================================================================
// Commander ("god's eye") view.
//
// Detaches the Cesium camera from the player aircraft and lifts it above the
// battlefield for an RTS-style overview. Units (player, NPCs, in-flight
// missiles) get icon+label entities; if trails are enabled, each unit's
// recent position history is drawn as a polyline. Trails keep recording even
// while the view is inactive so switching in mid-engagement shows meaningful
// history — this is the hook for evaluating AI behavior later.
//
// Camera conventions here (own):
//   tilt = 0  ⇒ straight top-down     (Cesium pitch = −90°)
//   tilt = 89 ⇒ nearly horizontal     (Cesium pitch ≈  −1°)
//   rotation (deg) = compass heading of the viewer — 0 = north up
// ============================================================================

const TRAIL_INTERVAL   = 0.25;  // seconds between samples per unit
const TRAIL_DURATION   = 120;   // seconds of history kept
const TRAIL_MAX_POINTS = Math.ceil(TRAIL_DURATION / TRAIL_INTERVAL) + 2;

const COLOR_PLAYER  = Cesium.Color.fromCssColorString('#00eaff');
const COLOR_NPC     = Cesium.Color.fromCssColorString('#ff4040');
const COLOR_MISSILE = Cesium.Color.fromCssColorString('#ffc040');
const COLOR_TRAIL_PLAYER  = COLOR_PLAYER.withAlpha(0.6);
const COLOR_TRAIL_NPC     = COLOR_NPC.withAlpha(0.55);
const COLOR_TRAIL_MISSILE = COLOR_MISSILE.withAlpha(0.7);
// Colors used when a unit (or a trail segment) is behind terrain. Polylines
// use depthFailMaterial for this natively; points/labels need a manual
// per-frame occlusion test because Cesium's point graphic has no
// depth-fail color.
const COLOR_OCCLUDED_MARKER = Cesium.Color.fromCssColorString('#707070').withAlpha(0.55);
const COLOR_OCCLUDED_LABEL  = Cesium.Color.fromCssColorString('#a0a0a0');
const COLOR_TRAIL_OCCLUDED  = Cesium.Color.fromCssColorString('#707070').withAlpha(0.22);

export class CommanderView {
	constructor(viewer) {
		this.viewer = viewer;
		this.active = false;
		this.trailsEnabled = true;

		// Cesium polylines need this flag on for depth-fail materials to
		// apply against terrain. Without it, primitives skip depth-testing
		// the globe and trails just render over every mountain as if
		// unobstructed. No visible downside for us (marker points still
		// override depth via disableDepthTestDistance).
		if (viewer && viewer.scene && viewer.scene.globe) {
			viewer.scene.globe.depthTestAgainstTerrain = true;
		}

		// View state — updated by pan/zoom/tilt inputs and written to the
		// Cesium camera each frame while active.
		//
		//   centerLon/centerLat: the look-at point on the ground (alt 0).
		//   distance:            slant distance from camera to look-at point.
		//   tilt:                camera elevation above the look-at point.
		//                        0 = straight overhead, 89 = nearly horizontal.
		//   rotation:            map bearing (0 = north-up).
		//
		// Camera position is computed as look-at + distance · back_vector(tilt,
		// rotation). This means tilting orbits the camera around the look-at
		// point instead of tipping the camera in place; and zooming moves the
		// camera along its view direction, so zoom works the same whether the
		// view is top-down or tilted.
		this.centerLon = 0;
		this.centerLat = 0;
		this.distance  = 25000;
		this.tilt      = 25;
		this.rotation  = 0;

		// Unit tracking — one entity per unit for its marker+label, one
		// separate entity per unit for its trail polyline. Keyed on a stable
		// id so NPCs and missiles don't reuse slots across spawns.
		this._markers   = new Map(); // id → Cesium.Entity (point + label)
		this._trails    = new Map(); // id → { samples: [{lon,lat,alt,t}], entity }
		this._trailTick = 0;
		// Accumulated simulation time (sum of dt from update()). Used for
		// trail ageing instead of wall-clock time so pausing the game
		// doesn't retroactively expire samples once update() resumes.
		this._gameTime  = 0;

		// Input drag state. _dragDist accumulates pointer movement while a
		// button is held; a small value at mouseup means we treat it as a
		// click (for unit selection) instead of a drag (pan/tilt).
		this._dragMode  = null;  // 'pan' | 'tilt' | null
		this._dragDist  = 0;
		this._lastX     = 0;
		this._lastY     = 0;
		this._downX     = 0;
		this._downY     = 0;

		// Click-to-inspect tooltips. Map from marker id to { element, meta }.
		// Multiple tooltips may be open simultaneously (e.g. to compare two
		// aircraft's speed), hence a map rather than a single selection.
		this._tooltips = new Map();

		this._bindInputs();
	}

	// ---- Public API ---------------------------------------------------------

	setActive(active, initialCenter = null) {
		if (active === this.active) return;
		this.active = active;

		if (active) {
			if (initialCenter) {
				this.centerLon = initialCenter.lon;
				this.centerLat = initialCenter.lat;
				// Start far enough that the aircraft and any nearby units
				// are visible at default tilt. Clamped so we don't snap
				// absurdly close at high altitudes.
				this.distance = Math.max(15000, (initialCenter.alt || 0) + 10000);
			}
		}
		// Toggle visibility on all pre-existing entities.
		this._setAllMarkersVisible(active);
		this._setAllTrailsVisible(active && this.trailsEnabled);
		if (!active) this._clearAllTooltips();
		this.viewer.scene.requestRender();
	}

	// Called every frame from main.js. `units` is the NPC array; `missiles`
	// is the weaponSystem.projectiles array. Player state is a plain
	// {lon, lat, alt, heading, speed} object.
	update(dt, playerState, units, missiles) {
		// Cache so the 'C' key handler can center on the aircraft at the
		// moment the mode is toggled on.
		this._lastPlayerState = playerState;

		// Advance sim-time. Pauses don't tick update(), so this stays frozen
		// across pause/unpause — exactly what we want for trail ageing.
		this._gameTime += dt;

		// Sample trails even when inactive — so entering the mode shows real
		// pre-switch history. Costs a handful of floats per unit per tick.
		this._sampleTrails(dt, playerState, units, missiles);

		if (!this.active) return;

		this._applyCamera();
		this._syncMarkers(playerState, units, missiles);
		this._syncTrails();
		this._updateTooltips();
		this.viewer.scene.requestRender();
	}

	// ---- Input --------------------------------------------------------------

	_bindInputs() {
		window.addEventListener('keydown', (e) => {
			if (e.repeat) return;
			const k = e.key.toLowerCase();
			if (k === 'm') {
				// M for Map / commander view. Toggle, centering on the latest
				// known player position so the first frame is useful.
				this.setActive(!this.active, this._lastPlayerState || null);
			} else if (k === 't' && this.active) {
				this.trailsEnabled = !this.trailsEnabled;
				this._setAllTrailsVisible(this.trailsEnabled);
				this.viewer.scene.requestRender();
			}
		});

		window.addEventListener('mousedown', (e) => {
			if (!this.active) return;
			if (e.button === 0)      this._dragMode = 'pan';
			else if (e.button === 2) this._dragMode = 'tilt';
			else return;
			this._lastX = e.clientX;
			this._lastY = e.clientY;
			this._downX = e.clientX;
			this._downY = e.clientY;
			this._dragDist = 0;
			e.preventDefault();
		}, true);

		window.addEventListener('mousemove', (e) => {
			if (!this.active || !this._dragMode) return;
			const dx = e.clientX - this._lastX;
			const dy = e.clientY - this._lastY;
			this._lastX = e.clientX;
			this._lastY = e.clientY;
			this._dragDist += Math.abs(dx) + Math.abs(dy);

			if (this._dragMode === 'pan') {
				// Grab-and-drag: the look-at point moves opposite to the cursor
				// in world space so the ground visually follows the cursor.
				//
				// Derivation: at bearing h, screen_right → ground direction
				// (cos h, -sin h) in (east, north); screen_up → (sin h, cos h).
				// A drag (dx, dy) in screen pixels therefore moves the cursor
				// across the ground by:
				//     east_cursor  =  dx·cos(h) - dy·sin(h)
				//     north_cursor = -dx·sin(h) - dy·cos(h)
				// Look-at moves the negation of that.
				const mpp = this.distance * 0.0015;
				const rotRad = Cesium.Math.toRadians(this.rotation);
				const cos = Math.cos(rotRad), sin = Math.sin(rotRad);
				const eastMeters  = (-dx * cos + dy * sin) * mpp;
				const northMeters = ( dx * sin + dy * cos) * mpp;
				const latRad = Cesium.Math.toRadians(this.centerLat);
				this.centerLat += northMeters / 111320;
				this.centerLon += eastMeters  / (111320 * Math.max(0.1, Math.cos(latRad)));
			} else if (this._dragMode === 'tilt') {
				this.rotation = (this.rotation + dx * 0.3) % 360;
				this.tilt     = Math.max(0, Math.min(89, this.tilt - dy * 0.3));
			}
			this.viewer.scene.requestRender();
		}, true);

		window.addEventListener('mouseup', (e) => {
			if (!this._dragMode) return;
			// Short travel ⇒ treat the press as a click, not a drag.
			// Left-click on an entity selects it; left-click elsewhere
			// clears the selection. Right-click is ignored for selection.
			if (this._dragDist < 6 && e.button === 0 && this.active) {
				this._handleClickAt(e.clientX, e.clientY);
			}
			this._dragMode = null;
		}, true);

		window.addEventListener('wheel', (e) => {
			if (!this.active) return;
			// Exponential zoom on the orbital distance. Because the camera
			// orbits the look-at point (rather than sitting directly above
			// it), this scales the visible ground area equally at any tilt,
			// not only top-down.
			const factor = e.deltaY > 0 ? 1.25 : 1 / 1.25;
			this.distance = Math.max(500, Math.min(2000000, this.distance * factor));
			e.preventDefault();
			this.viewer.scene.requestRender();
		}, { passive: false, capture: true });

		// Right-click normally shows a context menu; while commander is active
		// we use right-drag for tilt, so swallow it.
		window.addEventListener('contextmenu', (e) => {
			if (this.active) e.preventDefault();
		});
	}

	// ---- Camera -------------------------------------------------------------

	_applyCamera() {
		// Camera is placed on an orbital sphere around the look-at point on
		// the ground. The "back" direction (from look-at to camera) in the
		// local ENU tangent frame is built from (tilt, rotation):
		//
		//   tilt=0  (top-down):    back = ( 0, 0, 1)     straight up
		//   tilt=90 (horizon):     back = ( 0,-1, 0)     due south (rot 0)
		//   any rotation r spins the horizontal component around the vertical
		//
		// The camera's orientation then just points from camera back toward
		// the look-at: heading = rotation, pitch = tilt - 90 (so pitch=-90 at
		// top-down, horizon-ish at tilt=89).
		const tiltRad = Cesium.Math.toRadians(this.tilt);
		const rotRad  = Cesium.Math.toRadians(this.rotation);
		const backENU = new Cesium.Cartesian3(
			-Math.sin(rotRad) * Math.sin(tiltRad),
			-Math.cos(rotRad) * Math.sin(tiltRad),
			 Math.cos(tiltRad),
		);

		const lookAt   = Cesium.Cartesian3.fromDegrees(this.centerLon, this.centerLat, 0);
		const enu      = Cesium.Transforms.eastNorthUpToFixedFrame(lookAt);
		const backECEF = Cesium.Matrix4.multiplyByPointAsVector(enu, backENU, new Cesium.Cartesian3());
		const camPos   = Cesium.Cartesian3.add(
			lookAt,
			Cesium.Cartesian3.multiplyByScalar(backECEF, this.distance, new Cesium.Cartesian3()),
			new Cesium.Cartesian3(),
		);

		this.viewer.camera.setView({
			destination: camPos,
			orientation: {
				heading: Cesium.Math.toRadians(this.rotation),
				pitch:   Cesium.Math.toRadians(this.tilt - 90),
				roll:    0,
			},
		});
	}

	// ---- Marker entities ---------------------------------------------------

	_ensureMarker(id, color, labelText) {
		let e = this._markers.get(id);
		if (e) return e;
		e = this.viewer.entities.add({
			position: Cesium.Cartesian3.fromDegrees(0, 0, 0),
			point: {
				pixelSize: 9,
				color: color,
				outlineColor: Cesium.Color.WHITE,
				outlineWidth: 1.2,
				disableDepthTestDistance: Number.POSITIVE_INFINITY,
			},
			label: {
				text: labelText,
				font: '12px sans-serif',
				fillColor: Cesium.Color.WHITE,
				outlineColor: Cesium.Color.BLACK,
				outlineWidth: 2,
				style: Cesium.LabelStyle.FILL_AND_OUTLINE,
				pixelOffset: new Cesium.Cartesian2(10, 0),
				verticalOrigin: Cesium.VerticalOrigin.CENTER,
				horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
				disableDepthTestDistance: Number.POSITIVE_INFINITY,
			},
			show: this.active,
		});
		this._markers.set(id, e);
		return e;
	}

	_syncMarkers(playerState, units, missiles) {
		const seen = new Set();

		// Update one marker: position it, color based on terrain occlusion,
		// and tag the entity with a meta pointer so scene.pick can look up
		// the underlying game unit on click.
		const updateOne = (id, u, color, meta) => {
			const e = this._markers.get(id);
			if (!e) return;
			const pos = Cesium.Cartesian3.fromDegrees(u.lon, u.lat, u.alt);
			e.position = pos;
			const occluded = this._isPositionOccluded(pos);
			e.point.color      = occluded ? COLOR_OCCLUDED_MARKER : color;
			e.label.fillColor  = occluded ? COLOR_OCCLUDED_LABEL  : Cesium.Color.WHITE;
			e.show = true;
			// Include the marker id so the click handler can key tooltips on
			// it. Without this every tooltip keys on `undefined`, which is
			// why clicks appeared to toggle the same slot no matter what
			// you clicked on.
			e.__commanderMeta = { id, ...meta };
			seen.add(id);
		};

		if (playerState) {
			this._ensureMarker('__player', COLOR_PLAYER, 'PLAYER');
			updateOne('__player', playerState, COLOR_PLAYER,
				{ kind: 'player', ref: playerState });
		}
		if (units) {
			for (const u of units) {
				if (!u || u.destroyed) continue;
				const id = `npc-${u.id || u.name}`;
				this._ensureMarker(id, COLOR_NPC, u.name || 'BOGEY');
				updateOne(id, u, COLOR_NPC, { kind: 'npc', ref: u });
			}
		}
		if (missiles) {
			for (const m of missiles) {
				if (!m || !m.active) continue;
				const id = `m-${m.id || (m.id = `m${seen.size}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)}`;
				const typeTag = m.type || 'MSL';
				const phaseTag = (typeof m.boostRemaining === 'number' && m.boostRemaining > 0) ? ' BOOST' : '';
				const entity = this._ensureMarker(id, COLOR_MISSILE, typeTag + phaseTag);
				if (entity && entity.label) entity.label.text = typeTag + phaseTag;
				updateOne(id, m, COLOR_MISSILE, { kind: 'missile', ref: m });
			}
		}

		// Hide any marker whose unit is gone this frame.
		for (const [id, ent] of this._markers) {
			if (!seen.has(id)) ent.show = false;
		}
	}

	// ---- Click-to-inspect tooltips ----------------------------------------

	// Pick the entity under the pointer. Left-click on a marker toggles its
	// tooltip. Left-click on empty space closes every open tooltip.
	_handleClickAt(x, y) {
		const picked = this.viewer.scene.pick(new Cesium.Cartesian2(x, y));
		if (picked && picked.id && picked.id.__commanderMeta) {
			const meta = picked.id.__commanderMeta;
			if (this._tooltips.has(meta.id)) {
				this._tooltips.get(meta.id).element.remove();
				this._tooltips.delete(meta.id);
			} else {
				const el = this._createTooltipElement(meta.kind);
				this._tooltips.set(meta.id, { element: el, meta });
			}
		} else {
			this._clearAllTooltips();
		}
	}

	_clearAllTooltips() {
		for (const [, tt] of this._tooltips) tt.element.remove();
		this._tooltips.clear();
	}

	// One small floating panel per pinned unit. Border/text colored by kind
	// so three open tooltips stay visually distinct at a glance.
	_createTooltipElement(kind) {
		let border = 'rgba(0, 255, 0, 0.55)';
		let color  = '#0f0';
		if (kind === 'player')  { border = 'rgba(0, 234, 255, 0.65)'; color = '#00eaff'; }
		else if (kind === 'npc') { border = 'rgba(255, 64, 64, 0.65)'; color = '#ff4040'; }
		else if (kind === 'missile') { border = 'rgba(255, 192, 64, 0.7)'; color = '#ffc040'; }
		const el = document.createElement('div');
		el.className = 'commander-tooltip';
		el.style.cssText = `
			position: fixed;
			padding: 5px 9px;
			border: 1px solid ${border};
			background: rgba(0, 12, 0, 0.82);
			color: ${color};
			font-family: 'AceCombat', monospace;
			font-size: 11px;
			line-height: 1.45;
			letter-spacing: 1px;
			text-shadow: 0 0 5px ${border};
			z-index: 30;
			pointer-events: none;
			white-space: nowrap;
		`;
		document.body.appendChild(el);
		return el;
	}

	// Per-frame: move each tooltip next to its marker's screen position,
	// refresh its contents from the unit's current state, and clean up any
	// whose unit is gone.
	_updateTooltips() {
		if (this._tooltips.size === 0) return;
		const scene = this.viewer.scene;
		const camera = scene.camera;
		const transformFunc = Cesium.SceneTransforms.worldToWindowCoordinates ||
			Cesium.SceneTransforms.wgs84ToWindowCoordinates;

		for (const [id, tt] of this._tooltips) {
			const ent = this._markers.get(id);
			const ref = tt.meta.ref;
			const alive = ref && (tt.meta.kind === 'missile' ? ref.active : !ref.destroyed);
			if (!ent || !alive) {
				tt.element.remove();
				this._tooltips.delete(id);
				continue;
			}
			const pos = Cesium.Cartesian3.fromDegrees(ref.lon, ref.lat, ref.alt);
			// Reject when the marker is behind the camera (depth < 0); the
			// Cesium projection is undefined for those, and tooltips would
			// otherwise jump to the opposite side of the screen.
			const toPos = Cesium.Cartesian3.subtract(pos, camera.positionWC, new Cesium.Cartesian3());
			if (Cesium.Cartesian3.dot(toPos, camera.direction) <= 0) {
				tt.element.style.display = 'none';
				continue;
			}
			const win = transformFunc ? transformFunc(scene, pos) : null;
			if (!win) { tt.element.style.display = 'none'; continue; }

			tt.element.style.display = 'block';
			tt.element.style.left = `${Math.round(win.x) + 14}px`;
			tt.element.style.top  = `${Math.round(win.y) - 8}px`;
			tt.element.innerHTML = this._buildTooltipHtml(tt.meta);
		}
	}

	_buildTooltipHtml(meta) {
		const { kind, ref } = meta;
		const altFt = Math.max(0, Math.round(ref.alt * 3.28084)).toLocaleString();
		const row = (lbl, val) =>
			`<div><span style="display:inline-block; width:36px; opacity:0.65">${lbl}</span>${val}</div>`;
		const dir = (d) => `${Math.round(((d % 360) + 360) % 360).toString().padStart(3, '0')}°`;

		if (kind === 'missile') {
			const typeTag = ref.type || 'MSL';
			const phase   = ref.boostRemaining > 0 ? `BOOST ${ref.boostRemaining.toFixed(1)}s` : 'COAST';
			const seeker  = ref.lostLock ? 'LOST' : (ref.pitbullFired || ref.seekerActive ? 'ACTIVE' : 'DL');
			const dbg     = ref.debug || {};
			const rng     = typeof dbg.rangeToTarget === 'number'
				? `${(dbg.rangeToTarget / 1000).toFixed(2)} km` : '—';
			const tgt     = dbg.targetName || (ref.target && ref.target.name) || '—';
			return (
				`<div style="font-weight:bold; margin-bottom:3px;">${typeTag} ${phase}</div>` +
				row('TGT', tgt) + row('RNG', rng) +
				row('SPD', `${Math.round(ref.speed)} m/s`) +
				row('ALT', `${altFt} ft`) +
				row('SEEK', seeker) +
				row('TTL', `${ref.life.toFixed(1)} s`)
			);
		}
		const name = kind === 'player' ? 'PLAYER' : (ref.name || 'BOGEY');
		const spd  = typeof ref.speed   === 'number' ? `${Math.round(ref.speed)} m/s` : '—';
		const hdg  = typeof ref.heading === 'number' ? dir(ref.heading) : '—';
		const pit  = typeof ref.pitch   === 'number' ? `${ref.pitch.toFixed(1)}°` : '—';
		let html =
			`<div style="font-weight:bold; margin-bottom:3px;">${name}</div>` +
			row('ALT', `${altFt} ft`) +
			row('SPD', spd) +
			row('HDG', hdg) +
			row('PIT', pit);
		if (kind === 'player') {
			const alphaDeg = (ref.alpha || 0) * 180 / Math.PI;
			html += row('AOA', `${alphaDeg.toFixed(1)}°`);
			html += row('G',   `${(ref.loadFactor || 0).toFixed(1)}`);
			html += row('THR', `${Math.round((ref.throttle || 0) * 100)}%${ref.isBoosting ? ' AB' : ''}`);
		} else if (kind === 'npc' && ref.pilot && ref.pilot.command) {
			// Debugging cue: which AI behavior currently owns this NPC?
			// "MissileEvasion" tells you evasion actually fired, not just that
			// it *should*. Flare/chaff counts tick down as defenses expire.
			const beh = ref.pilot.command.activeBehaviorName || '—';
			html += row('AI',  beh);
			const cm = ref.pilot.subsystems && ref.pilot.subsystems.countermeasures;
			if (cm) html += row('CM',  `${cm.flareCount}F / ${cm.chaffCount}C`);
		}
		return html;
	}

	// Cheap terrain-occlusion test for a world-space point: cast a ray from
	// the camera toward the point, ask the globe for its intersection, and
	// compare distances. Cesium's scene.globe.pick uses the current LOD
	// terrain tile — good enough for visual correctness and much faster
	// than sampleTerrainMostDetailed.
	_isPositionOccluded(pos) {
		const cam = this.viewer.camera;
		if (!this._scratchDir) this._scratchDir = new Cesium.Cartesian3();
		const dir = Cesium.Cartesian3.subtract(pos, cam.positionWC, this._scratchDir);
		const distUnit = Cesium.Cartesian3.magnitude(dir);
		if (distUnit < 1) return false;
		Cesium.Cartesian3.divideByScalar(dir, distUnit, dir);
		if (!this._scratchRay) this._scratchRay = new Cesium.Ray();
		Cesium.Cartesian3.clone(cam.positionWC, this._scratchRay.origin);
		Cesium.Cartesian3.clone(dir, this._scratchRay.direction);
		const hit = this.viewer.scene.globe.pick(this._scratchRay, this.viewer.scene);
		if (!hit) return false;
		const distTerrain = Cesium.Cartesian3.distance(cam.positionWC, hit);
		// 5 m fudge so a unit sitting exactly on terrain isn't flagged.
		return distTerrain < distUnit - 5;
	}

	_setAllMarkersVisible(show) {
		for (const [, e] of this._markers) e.show = show;
	}

	// ---- Trail entities -----------------------------------------------------

	_sampleTrails(dt, playerState, units, missiles) {
		this._trailTick += dt;
		if (this._trailTick < TRAIL_INTERVAL) return;
		this._trailTick = 0;

		// Sim-time, not wall-clock: a real-time pause must not age trails.
		const now = this._gameTime;

		const sample = (id, u, color) => {
			if (!u) return;
			let rec = this._trails.get(id);
			if (!rec) { rec = { samples: [], entity: null, color }; this._trails.set(id, rec); }
			rec.samples.push({ lon: u.lon, lat: u.lat, alt: u.alt, t: now });
			while (rec.samples.length > TRAIL_MAX_POINTS) rec.samples.shift();
			while (rec.samples.length > 0 && (now - rec.samples[0].t) > TRAIL_DURATION) {
				rec.samples.shift();
			}
		};

		if (playerState) sample('__player', playerState, COLOR_TRAIL_PLAYER);
		if (units) for (const u of units) {
			if (u && !u.destroyed) sample(`npc-${u.id || u.name}`, u, COLOR_TRAIL_NPC);
		}
		if (missiles) for (const m of missiles) {
			if (m && m.active) sample(`m-${m.id}`, m, COLOR_TRAIL_MISSILE);
		}
	}

	_syncTrails() {
		for (const [id, rec] of this._trails) {
			if (rec.samples.length < 2) {
				if (rec.entity) rec.entity.show = false;
				continue;
			}
			// Cache the computed Cartesian3 positions; Cesium's CallbackProperty
			// re-reads this array every frame. Direct assignment to
			// polyline.positions would wrap into a ConstantProperty, which
			// in practice doesn't always force the batch-rendered polyline
			// primitive to rebuild — trails would only appear after something
			// else forced a full refresh (opening the pause menu, for ex).
			rec.positionsCache = rec.samples.map(p =>
				Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.alt),
			);
			if (!rec.entity) {
				rec.entity = this.viewer.entities.add({
					polyline: {
						positions: new Cesium.CallbackProperty(() => rec.positionsCache, false),
						width: 1.8,
						material: rec.color,
						// When a segment is behind terrain Cesium swaps to
						// this material — produces the "ghosted" look for
						// trail portions hidden by mountains.
						depthFailMaterial: new Cesium.ColorMaterialProperty(COLOR_TRAIL_OCCLUDED),
						arcType: Cesium.ArcType.NONE,
					},
					show: this.active && this.trailsEnabled,
				});
			} else {
				rec.entity.show = this.active && this.trailsEnabled;
			}
		}
	}

	_setAllTrailsVisible(show) {
		for (const [, rec] of this._trails) {
			if (rec.entity) rec.entity.show = show;
		}
	}
}
