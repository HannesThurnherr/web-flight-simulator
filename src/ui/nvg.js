// ============================================================================
// Night-vision overlay — white-phosphor NVG look toggleable mid-flight.
//
// The illusion stack:
//
//   1. dynamicLighting forces arcade-bright when NVG is active so the
//      world is always at full daylight intensity underneath, even if
//      the user has realistic mode selected. (Real NVGs amplify dim
//      light to readable levels — we shortcut that by handing the
//      filter a bright scene to begin with.)
//   2. CSS filter on the Cesium + THREE canvases →
//        saturate(0) → sepia(0.7) → hue-rotate(75deg) → contrast(1.2)
//      This bleaches everything to grayscale, then washes it with the
//      classic green-phosphor tint and tightens the histogram.
//   3. Grain layer: a small <canvas> regenerated with fresh random
//      noise EVERY frame, then CSS-scaled up to fullscreen so each
//      noise pixel paints across several screen pixels. Per-frame
//      regeneration is what reads as boiling noise — shifting a
//      static texture (what we did first) reads as "an image of grain
//      sliding across the screen". Browsers handle the upscale on
//      the GPU; the per-frame redraw of a low-res canvas is ~1ms.
//   4. Vignette via a radial-gradient div so the eyepiece edges dim
//      out — sells the "looking through goggles" feel without modelling
//      a circular FOV mask.
//
// HUD overlays sit ABOVE all of this (z-index 10+ inside #uiContainer)
// and are NOT filtered, so the cockpit instruments stay readable in
// their native symbology colours without grain on top.
//
// Public API:
//   initNvg()         — call once at boot. Builds the canvas, vignette,
//                       and stylesheet. No-op on repeat.
//   setNvgActive(on)  — toggle the effect on / off.
//   isNvgActive()     — current state.
//   toggleNvg()       — flip + return new state.
// ============================================================================

let _initialised = false;
let _active = false;
let _grainCanvas = null;
let _grainCtx    = null;
let _grainImage  = null;        // ImageData buffer — reused each frame
let _grain32     = null;        // Uint32 view over the same buffer
let _rafId = null;

// Noise canvas internal resolution. Bigger = each sparkle takes up
// fewer screen pixels when CSS-scaled to fullscreen. 1280×720 at a
// typical 1080p screen gives ~1.5× upscale, so each 1-pixel sparkle
// reads as a 1-2 screen-pixel speckle rather than a chunky 4×4
// square. Higher than 1280×720 starts to cost meaningful per-frame
// fill time without much visual benefit.
const GRAIN_W = 1280;
const GRAIN_H = 720;
// How many sparkles to scatter each frame. Higher resolution canvas
// means we need more sparkles for the same on-screen density. ~8000
// of 920k pixels ≈ 0.9 % coverage — sparse enough to read as boil
// rather than uniform noise.
const SPARKLE_COUNT = 8000;
// Probability a sparkle is bright (white) rather than dark (black).
// Slightly biased toward bright because the eye reads occasional
// bright pinpricks as "noise floor on a phosphor tube" while
// pure-dark speckles read as dropouts.
const SPARKLE_BRIGHT_P = 0.65;
// Brightness ceiling for "bright" sparkles. Pure white (255) made
// the speckle look like flashbulbs popping; capping in the 80-160
// range keeps sparkles in muted-phosphor territory and lets bright
// detail in the underlying image show through.
const SPARKLE_BRIGHT_MIN = 80;
const SPARKLE_BRIGHT_MAX = 160;

function _injectStylesheet() {
	// Filter chain: the world's already arcade-bright underneath, so
	// no brightness multiplier needed (a leftover ×4 was blowing out
	// the whole picture). Just bleach to mono → tint phosphor-green
	// → bump contrast slightly.
	//
	// Z-index plan, top → bottom:
	//   #uiContainer         z=10  ← HUD / missile labels, NOT filtered
	//   #nvg-vignette        z= 7
	//   #nvg-grain (canvas)  z= 6
	//   #threeContainer      z= 5  ← filtered
	//   #cesiumContainer     z= 1  ← filtered
	const css = `
	body.nvg-active #cesiumContainer canvas,
	body.nvg-active #threeContainer canvas {
		filter: saturate(0) sepia(0.7) hue-rotate(75deg) contrast(1.2);
	}
	#nvg-grain {
		position: fixed; inset: 0;
		width: 100%; height: 100%;
		pointer-events: none;
		z-index: 6;
		display: none;
		/* Most of the layer is transparent; the per-sparkle alpha
		 * does the visibility. Layer opacity 1.0 lets bright
		 * sparkles fully replace the underlying pixel. */
		opacity: 1.0;
		/* Default 'auto' (bilinear) scaling — sparkles render as
		 * small soft dots instead of crisp squares when the canvas
		 * is upscaled to fullscreen. Combined with the high source
		 * resolution (1280×720) the upscale is small enough that
		 * the softening reads as analogue grain rather than blur. */
		image-rendering: auto;
	}
	body.nvg-active #nvg-grain { display: block; }
	#nvg-vignette {
		position: fixed; inset: 0;
		pointer-events: none;
		z-index: 7;
		display: none;
		background: radial-gradient(ellipse at center,
			rgba(0,0,0,0) 35%,
			rgba(0,0,0,0.55) 80%,
			rgba(0,0,0,0.92) 100%);
	}
	body.nvg-active #nvg-vignette { display: block; }
	`;
	const style = document.createElement('style');
	style.textContent = css;
	document.head.appendChild(style);
}

// Refill the grain canvas with fresh scintillation. We DON'T fill
// every pixel — that produces the flickering-grid look that doesn't
// match real NVG output. Instead the canvas is mostly transparent
// each frame, with a few thousand bright + dark pinprick sparkles
// scattered at random positions. Real image-intensifier tubes show
// exactly this pattern: sparse random photon-event-style speckle
// against the phosphor wash, not a uniform per-pixel boil.
//
// Backing store is reused (Uint32 view of the same buffer) so we
// avoid per-frame allocations.
function _refreshGrain() {
	if (!_grainCtx || !_grainImage) return;
	// Wipe to fully transparent. A Uint32Array view lets us blank
	// the whole 130k-pixel buffer with a single typed-array .fill,
	// which is meaningfully faster than walking the byte array.
	_grain32.fill(0);
	const d = _grainImage.data;
	const brightSpan = SPARKLE_BRIGHT_MAX - SPARKLE_BRIGHT_MIN;
	for (let i = 0; i < SPARKLE_COUNT; i++) {
		const x = (Math.random() * GRAIN_W) | 0;
		const y = (Math.random() * GRAIN_H) | 0;
		const idx = (y * GRAIN_W + x) * 4;
		const bright = Math.random() < SPARKLE_BRIGHT_P;
		// Bright sparkles get a muted brightness in [MIN..MAX] so
		// no individual pinprick reaches pure white. Dark sparkles
		// stay at zero — they just punch through with low alpha,
		// reading as faint shadow speckle.
		const v = bright
			? (SPARKLE_BRIGHT_MIN + Math.random() * brightSpan) | 0
			: 0;
		// Per-sparkle alpha varies so the grain doesn't read as
		// uniform — some pixels are visible dots, others are just
		// faint highlights / shadows. Triangular distribution biased
		// low so most sparkles are subtle and only a few catch
		// the eye.
		const a = ((Math.random() + Math.random()) * 0.5 * 180 + 30) | 0;
		d[idx]     = v;
		d[idx + 1] = v;
		d[idx + 2] = v;
		d[idx + 3] = a;
	}
	_grainCtx.putImageData(_grainImage, 0, 0);
}

function _animate() {
	if (!_active) {
		_rafId = null;
		return;
	}
	_refreshGrain();
	_rafId = requestAnimationFrame(_animate);
}

export function initNvg() {
	if (_initialised) return;
	_initialised = true;

	// Grain canvas — small internal resolution, CSS-scaled to fill
	// the screen so each noise pixel paints across several screen
	// pixels. Per-frame redraw runs against this canvas's 2D context;
	// the browser composites it as a regular DOM element.
	const c = document.createElement('canvas');
	c.id = 'nvg-grain';
	c.width = GRAIN_W;
	c.height = GRAIN_H;
	document.body.appendChild(c);
	_grainCanvas = c;
	_grainCtx    = c.getContext('2d');
	_grainImage  = _grainCtx.createImageData(GRAIN_W, GRAIN_H);
	// 32-bit view of the same backing buffer so .fill(0) zeros all
	// four channels per pixel in one pass. _refreshGrain relies on
	// this for cheap per-frame clears.
	_grain32     = new Uint32Array(_grainImage.data.buffer);

	// Vignette overlay (kept separate so its blend mode stays normal).
	const vignette = document.createElement('div');
	vignette.id = 'nvg-vignette';
	document.body.appendChild(vignette);

	_injectStylesheet();
}

export function setNvgActive(on) {
	_active = !!on;
	document.body.classList.toggle('nvg-active', _active);
	if (_active && !_rafId) {
		_rafId = requestAnimationFrame(_animate);
	}
}

export function isNvgActive() {
	return _active;
}

export function toggleNvg() {
	setNvgActive(!_active);
	return _active;
}
