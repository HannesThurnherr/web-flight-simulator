// ============================================================================
// Tactical map symbology.
//
// Turns a game unit (NPC airframe, ground emitter, in-flight munition) into a
// small team-coloured SVG glyph for the commander map. Replaces the old
// undifferentiated coloured dot so the player can read the picture the way a
// real C2 display reads — silhouette tells you *what*, colour tells you
// *whose*, rotation tells you *which way it's pointed*.
//
// The glyph set is deliberately small and iconic (NATO-ish, not MIL-STD-2525
// strict): a swept delta for fighters, a flying wing for the bomber, a dish
// for early-warning radar, a launcher-with-rising-missile for SAMs, etc. Each
// is authored pointing "north" (up the image) so a screen-space billboard
// rotation can aim airframes and munitions down their heading.
//
// Glyphs are emitted as `data:image/svg+xml` URIs and cached by
// (category, colour) — there are only a couple dozen live combinations, so the
// cache stays tiny and Cesium reuses the same GPU texture for every F-15 on a
// side.
// ============================================================================

// ---- Shared palette ---------------------------------------------------------
// Single source of truth for map colours, imported by commanderView so the
// markers, trails, legend and tooltips never drift apart.
export const MAP_COLORS = {
	player:          '#27e3ff',
	friendly:        '#5ad1ff',
	'hostile-red':   '#ff4d4d',
	'hostile-blue':  '#ffb030',
	neutral:         '#c8d0d8',
	missileFriendly: '#ffd24a',
	missileHostile:  '#ff5ce0',
	occluded:        '#8090a0',
};

export function teamColor(team) {
	return MAP_COLORS[team] || MAP_COLORS['hostile-red'];
}

// ---- Category resolution ----------------------------------------------------

// Air/munition categories rotate to heading; ground categories are static.
// Ships rotate too — course is meaningful on a naval plot, so a destroyer
// icon points down its heading just like an airframe.
const ROTATING = new Set([
	'fighter', 'stealth', 'bomber', 'awacs', 'drone', 'ew_jet',
	'aam', 'arm', 'cruise', 'bomb', 'sam_msl',
	'ship', 'destroyer', 'frigate', 'carrier', 'asm', 'shell',
]);

export function categoryRotates(cat) {
	return ROTATING.has(cat);
}

const GROUND_CLASSES = new Set(['sam_site', 'ewr', 'building']);

export function isGroundUnit(u) {
	if (!u) return false;
	if (u.isStatic) return true;
	const cls = u.signature && u.signature.unitClass;
	return GROUND_CLASSES.has(cls);
}

// Map a unit (player airframe or NPC) to a glyph category.
export function categoryForUnit(u) {
	if (!u) return 'fighter';
	const pid = (u.platformId || '').toLowerCase();
	const cls = (u.signature && u.signature.unitClass) || '';

	if (isGroundUnit(u)) {
		if (pid.includes('shilka') || pid.includes('zsu')) return 'aaa';
		if (pid.includes('jammer') || pid.includes('krasukha')) return 'jammer';
		if (pid.includes('laser') || pid.includes('iron-beam') || pid.includes('beam')) return 'laser';
		if (cls === 'ewr') return u.jammer ? 'jammer' : 'radar';
		if (cls === 'building') return 'command';
		// sam_site covers NASAMS, Tor (shorad), and any other launcher.
		return 'sam';
	}

	// Surface combatants. Checked before the airborne fallback because a
	// ship is neither a ground unit (not static) nor an aircraft — without
	// this it would render as a fighter delta. Sub-categorise by hull class
	// so a carrier reads differently from an escort.
	if (cls === 'ship') {
		if (pid.includes('carrier') || pid.includes('cvn') || /\bcv\b/.test(pid)) return 'carrier';
		if (pid.includes('frigate') || pid.includes('ffg') || pid.includes('corvette')) return 'frigate';
		if (pid.includes('burke') || pid.includes('ddg') || pid.includes('destroyer')) return 'destroyer';
		return 'ship';
	}

	// Airborne.
	if (pid.includes('growler') || pid.includes('ea-18')) return 'ew_jet';
	if (cls === 'awacs' || cls === 'cargo') return 'awacs';
	if (cls === 'drone_isr') return 'drone';
	if (cls === 'stealth_bomber') return 'bomber';
	if (cls === 'stealth_fighter') return 'stealth';
	return 'fighter';
}

// Map an in-flight munition to a glyph category.
export function categoryForMissile(m) {
	if (!m) return 'aam';
	const t = (m.type || '').toUpperCase();
	const cls = (m.signature && m.signature.unitClass) || '';
	// Naval gun shell first — it's a ballistic 'bomb'-class round but reads
	// as a dumb projectile, not a glide bomb, so give it its own mark.
	if (t === 'MK45' || t.startsWith('MK45') || t === 'NAVAL-SHELL') return 'shell';
	if (t.startsWith('GBU') || cls === 'bomb') return 'bomb';
	if (t === 'AGM-88' || t.startsWith('HARM')) return 'arm';
	// Anti-ship missiles (Harpoon / NSM) — sea-skimmers. Checked before the
	// generic cruise test because they share the cruise_missile signature.
	if (t === 'HARPOON' || t === 'NSM' || t.startsWith('HARPOON') || t === 'TLAM-ASM') return 'asm';
	if (cls === 'cruise_missile' || t === 'STORM-SHADOW' || t === 'TOMAHAWK' || t.startsWith('AGM-86') || t === 'MALD') return 'cruise';
	if (t === 'NASAMS-MSL' || t === 'TOR-MSL' || t === 'SM-6' || t === 'SM-2' || t === 'RAM' || (m.launcher && m.launcher.isStatic) || (m.launcher && m.launcher.kind === 'surface')) return 'sam_msl';
	return 'aam';
}

// ---- Glyph geometry ---------------------------------------------------------
// Each entry is the inner markup of a 48×48 viewBox, authored pointing up.
// `fill="C"` / `stroke="C"` placeholders are swapped for the team colour at
// build time; `stroke="K"` is the fixed dark contrast outline.

const C = '__C__';   // team colour placeholder
const K = 'rgba(0,0,0,0.5)';

const GLYPHS = {
	// Swept-delta fighter, nose up.
	fighter:
		`<path d="M24 4 L28 22 L44 37 L44 41 L26 33 L26 41 L31 45 L24 45.5 L17 45 L22 41 L22 33 L4 41 L4 37 L20 22 Z"/>`,

	// Sleeker chevron-arrow for low-observable fighters.
	stealth:
		`<path d="M24 4 L31 21 L42 42 L24 33 L6 42 L17 21 Z"/>`,

	// Flying-wing boomerang (B-2).
	bomber:
		`<path d="M24 13 L46 35 L33 35 L24 29 L15 35 L2 35 Z"/>`,

	// Big straight-wing aircraft with a rotodome disc.
	awacs:
		`<path d="M22 7 L26 7 L26 22 L45 27 L45 31 L26 31 L26 41 L31 44 L31 45.5 L17 45.5 L17 44 L22 41 L22 31 L3 31 L3 27 L22 22 Z"/>` +
		`<circle cx="24" cy="19" r="6.5" fill="none" stroke="${C}" stroke-width="2.4"/>`,

	// Long thin-wing ISR drone (RQ-4), V-tail.
	drone:
		`<path d="M23 6 L25 6 L25.3 30 L46 33 L46 35 L25.4 34 L25.6 39 L31 45 L29 45 L24 40 L19 45 L17 45 L22.4 39 L22.6 34 L2 35 L2 33 L22.7 30 Z"/>`,

	// Electronic-attack jet: fighter body + emission arcs.
	ew_jet:
		`<path d="M24 8 L27.5 23 L41 37 L41 41 L26 34 L26 41 L30 44 L24 44.5 L18 44 L22 41 L22 34 L7 41 L7 37 L20.5 23 Z"/>` +
		`<path d="M9 11 Q5 16 9 21" fill="none" stroke="${C}" stroke-width="2"/>` +
		`<path d="M39 11 Q43 16 39 21" fill="none" stroke="${C}" stroke-width="2"/>`,

	// SAM launcher: base box + rising missile + fins.
	sam:
		`<rect x="11" y="33" width="26" height="9" rx="1.5" fill="${C}" fill-opacity="0.25" stroke="${C}" stroke-width="2.2"/>` +
		`<path d="M24 5 L29 19 L25.6 19 L25.6 33 L22.4 33 L22.4 19 L19 19 Z"/>` +
		`<path d="M22.4 24 L17 30 L22.4 28 Z M25.6 24 L31 30 L25.6 28 Z" fill="${C}"/>`,

	// AAA / SHORAD gun (ZSU-23 Shilka): hull + twin barrels + muzzle flash.
	aaa:
		`<rect x="11" y="30" width="26" height="11" rx="2" fill="${C}" fill-opacity="0.25" stroke="${C}" stroke-width="2.2"/>` +
		`<path d="M20 30 L19 9 M28 30 L29 9" fill="none" stroke="${C}" stroke-width="2.6"/>` +
		`<path d="M19 9 l-2.5 -3 l2.8 1.4 l0.2 -3 l1 3 l2.6 -1 l-1.8 2.6 Z" fill="${C}" stroke="none"/>` +
		`<path d="M29 9 l2.5 -3 l-2.8 1.4 l-0.2 -3 l-1 3 l-2.6 -1 l1.8 2.6 Z" fill="${C}" stroke="none"/>`,

	// Early-warning radar: ground base, mast, dish, sweep arcs.
	radar:
		`<rect x="18" y="39" width="12" height="4" rx="1" fill="${C}"/>` +
		`<path d="M24 39 L24 27" fill="none" stroke="${C}" stroke-width="2.4"/>` +
		`<path d="M14 30 A 12 12 0 0 1 28 18 L24 27 Z" fill="${C}" fill-opacity="0.55" stroke="${C}" stroke-width="2"/>` +
		`<path d="M30 22 A 10 10 0 0 1 38 30" fill="none" stroke="${C}" stroke-width="2"/>` +
		`<path d="M32 17 A 16 16 0 0 1 43 30" fill="none" stroke="${C}" stroke-width="1.8" stroke-opacity="0.65"/>`,

	// Jammer / EW emitter: mast with broadcast waves both sides + bolt.
	jammer:
		`<rect x="18" y="39" width="12" height="4" rx="1" fill="${C}"/>` +
		`<path d="M24 39 L24 20" fill="none" stroke="${C}" stroke-width="2.4"/>` +
		`<path d="M25 20 l-5 8 l3.5 0 l-4 9 l9 -12 l-3.5 0 l4 -5 Z" fill="${C}" stroke="none"/>` +
		`<path d="M15 14 Q9 22 15 30 M11 9 Q2 21 11 35" fill="none" stroke="${C}" stroke-width="1.8" stroke-opacity="0.7"/>` +
		`<path d="M33 14 Q39 22 33 30 M37 9 Q46 21 37 35" fill="none" stroke="${C}" stroke-width="1.8" stroke-opacity="0.7"/>`,

	// Directed-energy weapon (Iron Beam): turret + vertical beam + burst.
	laser:
		`<path d="M14 40 A 10 10 0 0 1 34 40 Z" fill="${C}" fill-opacity="0.3" stroke="${C}" stroke-width="2.2"/>` +
		`<path d="M24 31 L24 5" fill="none" stroke="${C}" stroke-width="3" stroke-opacity="0.95"/>` +
		`<path d="M24 4 l2.5 4 l-2.5 -1.5 l-2.5 1.5 Z" fill="${C}" stroke="none"/>` +
		`<path d="M18 12 L30 12 M19 18 L29 18" stroke="${C}" stroke-width="1.6" stroke-opacity="0.6"/>`,

	// Command post: building + antenna + pennant.
	command:
		`<path d="M11 42 L11 25 L24 15 L37 25 L37 42 Z" fill="${C}" fill-opacity="0.28" stroke="${C}" stroke-width="2.2" stroke-linejoin="round"/>` +
		`<path d="M30 25 L30 7" fill="none" stroke="${C}" stroke-width="2"/>` +
		`<path d="M30 7 L40 10 L34 13 L40 16 L30 16 Z" fill="${C}" stroke="none"/>` +
		`<rect x="20" y="30" width="8" height="12" fill="${C}" fill-opacity="0.5"/>`,

	// Air-to-air missile: slim dart with cruciform fins, nose up.
	aam:
		`<path d="M24 5 L26.4 13 L26.4 36 L24 41 L21.6 36 L21.6 13 Z"/>` +
		`<path d="M21.6 31 L16 37 L21.6 35 Z M26.4 31 L32 37 L26.4 35 Z" fill="${C}"/>`,

	// Anti-radiation missile (HARM): dart + seeker zigzag accent.
	arm:
		`<path d="M24 5 L26.4 13 L26.4 36 L24 41 L21.6 36 L21.6 13 Z"/>` +
		`<path d="M21.6 31 L16 37 L21.6 35 Z M26.4 31 L32 37 L26.4 35 Z" fill="${C}"/>` +
		`<path d="M20 9 L28 9 L21 15 L28 15" fill="none" stroke="${C}" stroke-width="1.7"/>`,

	// Cruise missile: tube fuselage + mid wings + tailplane, nose up.
	cruise:
		`<path d="M24 4 L27 11 L27 38 L24 43 L21 38 L21 11 Z"/>` +
		`<path d="M21 22 L7 27 L21 25 Z M27 22 L41 27 L27 25 Z" fill="${C}"/>` +
		`<path d="M21 34 L14 38 L21 37 Z M27 34 L34 38 L27 37 Z" fill="${C}"/>`,

	// Free-fall / glide bomb (GBU): teardrop body + boxed tail fins, nose up.
	bomb:
		`<path d="M24 6 C29 11 29 28 25 33 L25 36 L23 36 L23 33 C19 28 19 11 24 6 Z"/>` +
		`<path d="M17 35 L31 35 L29 43 L19 43 Z" fill="${C}" fill-opacity="0.5" stroke="${C}" stroke-width="1.6"/>` +
		`<path d="M24 33 L24 43 M19 38 L29 38" stroke="${C}" stroke-width="1.6"/>`,

	// Surface-to-air interceptor in flight: rising dart + exhaust flame.
	sam_msl:
		`<path d="M24 5 L26.4 13 L26.4 34 L24 38 L21.6 34 L21.6 13 Z"/>` +
		`<path d="M21.6 29 L16 35 L21.6 33 Z M26.4 29 L32 35 L26.4 33 Z" fill="${C}"/>` +
		`<path d="M22 38 L24 45 L26 38 Z" fill="${C}" stroke="none"/>`,

	// Generic surface combatant: top-down hull, sharp bow up, flat stern,
	// with a centred superstructure block.
	ship:
		`<path d="M24 4 L30 18 L30 40 L18 40 L18 18 Z" fill="${C}" fill-opacity="0.32" stroke="${C}" stroke-width="2.2" stroke-linejoin="round"/>` +
		`<rect x="21" y="22" width="6" height="12" rx="1" fill="${C}"/>`,

	// Destroyer (Arleigh Burke): long hull, bow gun turret, blocky
	// superstructure + mast, aft helo deck line.
	destroyer:
		`<path d="M24 3 L31 17 L31 43 L17 43 L17 17 Z" fill="${C}" fill-opacity="0.28" stroke="${C}" stroke-width="2.2" stroke-linejoin="round"/>` +
		`<circle cx="24" cy="13" r="2.4" fill="${C}"/>` +                       // forward 5" gun
		`<rect x="20" y="20" width="8" height="13" rx="1" fill="${C}" fill-opacity="0.6" stroke="${C}" stroke-width="1.6"/>` + // superstructure
		`<path d="M24 20 L24 33" stroke="${C}" stroke-width="1.4" stroke-opacity="0.7"/>` +
		`<path d="M20 38 L28 38 M20 40.5 L28 40.5" stroke="${C}" stroke-width="1.3" stroke-opacity="0.7"/>`, // aft helo deck

	// Frigate / corvette: shorter, leaner hull, single deckhouse.
	frigate:
		`<path d="M24 6 L29 18 L29 40 L19 40 L19 18 Z" fill="${C}" fill-opacity="0.3" stroke="${C}" stroke-width="2.2" stroke-linejoin="round"/>` +
		`<rect x="21" y="22" width="6" height="10" rx="1" fill="${C}" fill-opacity="0.7" stroke="${C}" stroke-width="1.4"/>` +
		`<path d="M24 14 l0 -3" stroke="${C}" stroke-width="2"/>`,

	// Carrier: wide flight deck with an angled bow, starboard island, and a
	// dashed centreline.
	carrier:
		`<path d="M22 3 L31 9 L31 44 L17 44 L17 12 Z" fill="${C}" fill-opacity="0.26" stroke="${C}" stroke-width="2.2" stroke-linejoin="round"/>` +
		`<rect x="27" y="22" width="3.4" height="9" rx="0.8" fill="${C}"/>` +    // starboard island
		`<path d="M23 8 L23 42" fill="none" stroke="${C}" stroke-width="1.4" stroke-dasharray="3 3" stroke-opacity="0.8"/>`,

	// Anti-ship missile (Harpoon / NSM): sea-skimming dart with swept delta
	// wings set well aft + a small motor flame.
	asm:
		`<path d="M24 4 L26.6 13 L26.6 37 L24 41 L21.4 37 L21.4 13 Z"/>` +
		`<path d="M21.4 27 L12 35 L21.4 32 Z M26.6 27 L36 35 L26.6 32 Z" fill="${C}"/>` +
		`<path d="M22.2 41 L24 45 L25.8 41 Z" fill="${C}" stroke="none"/>`,

	// Naval gun shell: small ballistic round (ogive) with a faint arc trail.
	shell:
		`<path d="M24 13 C27 17 27 29 24.5 33 L23.5 33 C21 29 21 17 24 13 Z"/>` +
		`<path d="M22 34 L26 34 L25 38 L23 38 Z" fill="${C}"/>`,

	// Generic fallback: ringed dot.
	dot:
		`<circle cx="24" cy="24" r="7" fill="${C}"/>` +
		`<circle cx="24" cy="24" r="11" fill="none" stroke="${C}" stroke-width="2" stroke-opacity="0.6"/>`,
};

// ---- SVG assembly + caching -------------------------------------------------

function buildSvg(category, hex) {
	const inner = (GLYPHS[category] || GLYPHS.dot).replace(/__C__/g, hex);
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">` +
		`<defs><filter id="g" x="-45%" y="-45%" width="190%" height="190%">` +
		`<feDropShadow dx="0" dy="0" stdDeviation="1.25" flood-color="${hex}" flood-opacity="0.85"/>` +
		`</filter></defs>` +
		`<g filter="url(#g)" fill="${hex}" stroke="${K}" stroke-width="1.4" ` +
		`stroke-linejoin="round" stroke-linecap="round">${inner}</g>` +
		`</svg>`
	);
}

const _uriCache = new Map();

// Public: data-URI for a (category, hex) pair, cached.
export function iconUri(category, hex) {
	const key = `${category}|${hex}`;
	let uri = _uriCache.get(key);
	if (!uri) {
		uri = 'data:image/svg+xml,' + encodeURIComponent(buildSvg(category, hex));
		_uriCache.set(key, uri);
	}
	return uri;
}

// Public: raw inline SVG (for DOM legend chips, not Cesium billboards).
export function iconSvgMarkup(category, hex, sizePx = 18) {
	return buildSvg(category, hex)
		.replace('width="48" height="48"', `width="${sizePx}" height="${sizePx}"`);
}
