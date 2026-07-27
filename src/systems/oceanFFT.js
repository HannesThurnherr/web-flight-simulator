// ============================================================================
// FFT ocean engine (Tessendorf) — GPU inverse-FFT of a Phillips spectrum.
//
// Ported to vanilla three.js from gioeledallapozza/FFTOCEAN (R3F). Produces, in
// three MRT render targets, the spatial-domain ocean fields needed to displace
// and shade a water surface:
//   displacementY : R = height,   B = jacobian (folding → foam)
//   displacementX : R = choppy X,  B = slope X   (∂height/∂x)
//   displacementZ : R = choppy Z,  B = slope Z   (∂height/∂z)
//
// Pipeline per frame:
//   1. time evolution: H(k,t) = H0(k)·e^{iωt} + conj(H0(-k))·e^{-iωt}, plus the
//      choppiness / slope / jacobian spectra (one MRT pass).
//   2. inverse FFT: log2(N) horizontal + log2(N) vertical butterfly passes,
//      ping-ponging the three MRT targets, using a precomputed twiddle texture.
// The initial spectrum H0 (Phillips × Gaussian) is computed ONCE.
//
// Unlike a Gerstner sum, the output is a full random-phase spectrum, so it does
// not look like a repeating "rubber mat" — it tiles only at `patchSize`, and the
// content is rich enough that the seam is hard to see.
//
// WebGL2-only (MRT, GLSL3, half-float render targets) — fine for three 0.182.
// ============================================================================

import * as THREE from 'three';

const PI = '3.14159265359';

// --- shared GLSL helpers (inlined; vanilla three has no #include) -----------
const COMPLEX = `
vec2 cMul(vec2 a, vec2 b) { return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }
vec2 cExp(float t) { return vec2(cos(t), sin(t)); }
`;
const RANDOM = `
float hash(vec2 uv){ return fract(sin(dot(uv, vec2(12.9898,78.233)))*43758.5453123); }
vec2 gaussianRandom(vec2 uv){
	float u1 = max(1e-6, hash(uv));
	float u2 = hash(uv + vec2(1.234, 5.678));
	float r = sqrt(-2.0*log(u1));
	float th = 2.0*${PI}*u2;
	return vec2(r*cos(th), r*sin(th));
}
`;

// Full-screen passthrough vertex shaders. The compute quad spans clip space
// (PlaneGeometry(2,2)), so position.xy already IS clip space.
const VERT1 = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const VERT3 = `out vec2 vUv;     void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// --- initial spectrum H0 (GLSL1, single target) -----------------------------
const INITIAL_FRAG = `
precision highp float;
uniform float uResolution, uPatchSize, uAmplitude, uWindSpeed;
uniform vec2 uWindDirection;
varying vec2 vUv;
${COMPLEX}
${RANDOM}
float phillips(vec2 k, float kMag){
	kMag = max(1e-6, kMag);
	float L = (uWindSpeed*uWindSpeed)/9.81;
	vec2 kHat = k / kMag;
	float kDotW = max(0.0, dot(kHat, uWindDirection));
	float k2 = kMag*kMag, k4 = k2*k2;
	float damping = exp(-1.0/(k2*L*L));
	return uAmplitude * (damping/k4) * (kDotW*kDotW);
}
void main(){
	vec2 px = floor(vUv * uResolution);
	float halfRes = uResolution/2.0;
	float nx = px.x < halfRes ? px.x : px.x - uResolution;
	float ny = px.y < halfRes ? px.y : px.y - uResolution;
	float dk = (2.0*${PI})/uPatchSize;
	vec2 k = vec2(nx, ny) * dk;
	float kMag = length(k);
	float omega = sqrt(9.81 * kMag);
	float energy = phillips(k, kMag);
	vec2 h0 = vec2(0.0);
	if (energy > 0.0) {
		vec2 g = gaussianRandom(vUv);
		float es = sqrt(energy * dk * dk);
		float hf = exp(-kMag*kMag*0.1);
		float c = es * 0.70710678 * hf;
		h0 = vec2(g.x*c, g.y*c);
	}
	gl_FragColor = vec4(h0.x, h0.y, omega, 1.0);
}`;

// --- time evolution (GLSL3, MRT x3) -----------------------------------------
const TIME_FRAG = `
precision highp float;
uniform sampler2D uH0Target;
uniform float uResolution, uTime, uPatchSize;
in vec2 vUv;
layout(location = 0) out vec4 outY;
layout(location = 1) out vec4 outX;
layout(location = 2) out vec4 outZ;
${COMPLEX}
void main(){
	vec2 h0 = texture(uH0Target, vUv).rg;
	vec2 negUv = mod(1.0 - vUv + (1.0/uResolution), 1.0);
	vec2 h0mk = texture(uH0Target, negUv).rg;
	vec2 h0mkConj = vec2(h0mk.x, -h0mk.y);
	float omega = texture(uH0Target, vUv).b;
	float phase = omega * uTime;
	vec2 hPos = cMul(h0, cExp(phase));
	vec2 hNeg = cMul(h0mkConj, cExp(-phase));
	vec2 h = hPos + hNeg;                 // Hermitian height spectrum

	vec2 px = floor(vUv * uResolution);
	float nx = px.x < (uResolution/2.0) ? px.x : px.x - uResolution;
	float ny = px.y < (uResolution/2.0) ? px.y : px.y - uResolution;
	vec2 k = vec2(nx, ny) * (2.0*${PI}/uPatchSize);
	float kLen = length(k);
	vec2 kN = (kLen > 1e-5) ? k/kLen : vec2(0.0);

	vec2 hChoppy = vec2(h.y, -h.x);       // ×(-i): horizontal displacement spectrum
	vec2 choppyX = hChoppy * kN.x;
	vec2 choppyZ = hChoppy * kN.y;
	vec2 slopeX = vec2(-h.y*k.x, h.x*k.x); // ×(i·k): slope spectrum
	vec2 slopeZ = vec2(-h.y*k.y, h.x*k.y);
	vec2 jac = h * kLen;

	outY = vec4(h, jac);
	outX = vec4(choppyX, slopeX);
	outZ = vec4(choppyZ, slopeZ);
}`;

// --- butterfly IFFT pass (GLSL3, MRT x3) ------------------------------------
const BUTTERFLY_FRAG = `
precision highp float;
uniform float uStage, uStages;
uniform int uDirection;
uniform sampler2D uButterfly, uPingY, uPingX, uPingZ;
in vec2 vUv;
layout(location = 0) out vec4 outY;
layout(location = 1) out vec4 outX;
layout(location = 2) out vec4 outZ;
${COMPLEX}
void main(){
	float pixelIndex = (uDirection == 0) ? vUv.x : vUv.y;
	float stageUv = (uStage + 0.5) / uStages;
	vec4 ins = texture(uButterfly, vec2(stageUv, pixelIndex));
	float ev = ins.r, od = ins.g;
	vec2 tw = ins.ba;
	vec2 evUv, odUv;
	if (uDirection == 0) { evUv = vec2(ev, vUv.y); odUv = vec2(od, vUv.y); }
	else                 { evUv = vec2(vUv.x, ev); odUv = vec2(vUv.x, od); }

	vec4 eY = texture(uPingY, evUv), oY = texture(uPingY, odUv);
	vec4 eX = texture(uPingX, evUv), oX = texture(uPingX, odUv);
	vec4 eZ = texture(uPingZ, evUv), oZ = texture(uPingZ, odUv);

	// Each texture carries two complex numbers (rg + ba); rotate both odd halves.
	outY = vec4(eY.rg + cMul(tw, oY.rg), eY.ba + cMul(tw, oY.ba));
	outX = vec4(eX.rg + cMul(tw, oX.rg), eX.ba + cMul(tw, oX.ba));
	outZ = vec4(eZ.rg + cMul(tw, oZ.rg), eZ.ba + cMul(tw, oZ.ba));
}`;

// Precompute the butterfly (twiddle + bit-reversal) texture: width = log2(N)
// stages, height = N, RGBA = (evenUv, oddUv, twiddleReal, twiddleImag).
function buildButterflyTexture(resolution) {
	const stages = Math.log2(resolution);
	const data = new Float32Array(resolution * stages * 4);
	const reverseBits = (index, bits) => {
		let r = 0;
		for (let i = 0; i < bits; i++) if (index & (1 << i)) r |= (1 << ((bits - 1) - i));
		return r;
	};
	for (let i = 0; i < stages; i++) {
		const span = Math.pow(2, i);
		for (let j = 0; j < resolution; j++) {
			const k = j % (span * 2);
			const theta = (2.0 * Math.PI * k) / (span * 2.0);
			let evenIndex, oddIndex;
			if (i === 0) {
				evenIndex = reverseBits(j - (j % 2), stages);
				oddIndex  = reverseBits(j - (j % 2) + 1, stages);
			} else if (k < span) {
				evenIndex = j; oddIndex = j + span;
			} else {
				evenIndex = j - span; oddIndex = j;
			}
			const p = (i + j * stages) * 4;
			data[p + 0] = (evenIndex + 0.5) / resolution;
			data[p + 1] = (oddIndex + 0.5) / resolution;
			data[p + 2] = Math.cos(theta);
			data[p + 3] = Math.sin(theta);
		}
	}
	const tex = new THREE.DataTexture(data, stages, resolution, THREE.RGBAFormat, THREE.FloatType);
	tex.minFilter = THREE.NearestFilter;
	tex.magFilter = THREE.NearestFilter;
	tex.generateMipmaps = false;
	tex.needsUpdate = true;
	return tex;
}

function mrtOptions(count) {
	return {
		type: THREE.HalfFloatType,
		minFilter: THREE.LinearFilter,
		magFilter: THREE.LinearFilter,
		format: THREE.RGBAFormat,
		depthBuffer: false,
		stencilBuffer: false,
		generateMipmaps: false,
		wrapS: THREE.RepeatWrapping,
		wrapT: THREE.RepeatWrapping,
		count,
	};
}

export class OceanFFT {
	constructor(renderer, opts = {}) {
		this.renderer = renderer;
		this.resolution = opts.resolution ?? 256;
		this.patchSize  = opts.patchSize ?? 250;
		const windSpeed = opts.windSpeed ?? 18;
		const amplitude = opts.amplitude ?? 2.0;
		const wd = opts.windDirection ?? new THREE.Vector2(1, 0.6).normalize();
		const N = this.resolution;
		this.stages = Math.log2(N);

		// Compute scene: a clip-space quad we re-skin with each pass's material.
		this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
		this._scene = new THREE.Scene();
		this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
		this._scene.add(this._quad);

		// H0 spectrum (single target) — computed once below.
		this._h0 = new THREE.WebGLRenderTarget(N, N, mrtOptions(1));

		// Ping-pong MRT targets (3 attachments: Y, X, Z).
		this._ppA = new THREE.WebGLRenderTarget(N, N, mrtOptions(3));
		this._ppB = new THREE.WebGLRenderTarget(N, N, mrtOptions(3));
		this._read = this._ppA; this._write = this._ppB;

		this._butterfly = buildButterflyTexture(N);

		this._initialMat = new THREE.ShaderMaterial({
			vertexShader: VERT1, fragmentShader: INITIAL_FRAG,
			uniforms: {
				uResolution: { value: N }, uPatchSize: { value: this.patchSize },
				uAmplitude: { value: amplitude }, uWindSpeed: { value: windSpeed },
				uWindDirection: { value: wd },
			},
		});
		this._timeMat = new THREE.ShaderMaterial({
			vertexShader: VERT3, fragmentShader: TIME_FRAG, glslVersion: THREE.GLSL3,
			uniforms: {
				uH0Target: { value: this._h0.texture }, uResolution: { value: N },
				uTime: { value: 0 }, uPatchSize: { value: this.patchSize },
			},
		});
		this._butterflyMat = new THREE.ShaderMaterial({
			vertexShader: VERT3, fragmentShader: BUTTERFLY_FRAG, glslVersion: THREE.GLSL3,
			uniforms: {
				uStage: { value: 0 }, uStages: { value: this.stages }, uDirection: { value: 0 },
				uButterfly: { value: this._butterfly },
				uPingY: { value: null }, uPingX: { value: null }, uPingZ: { value: null },
			},
		});

		this._computeInitialSpectrum();
	}

	_render(material, target) {
		this._quad.material = material;
		this.renderer.setRenderTarget(target);
		this.renderer.render(this._scene, this._camera);
	}

	_computeInitialSpectrum() {
		const r = this.renderer;
		const prevTarget = r.getRenderTarget();
		const prevAutoClear = r.autoClear;
		r.autoClear = true;
		this._render(this._initialMat, this._h0);
		r.setRenderTarget(prevTarget);
		r.autoClear = prevAutoClear;
	}

	// Run one frame of the simulation; returns the three spatial-domain textures.
	update(time) {
		const r = this.renderer;
		const prevTarget = r.getRenderTarget();
		const prevAutoClear = r.autoClear;
		r.autoClear = true;

		// 1) time evolution → write target (MRT)
		this._timeMat.uniforms.uTime.value = time;
		this._render(this._timeMat, this._write);
		this._swap();

		// 2) butterfly IFFT — log2(N) horizontal then vertical
		const bind = () => {
			this._butterflyMat.uniforms.uPingY.value = this._read.textures[0];
			this._butterflyMat.uniforms.uPingX.value = this._read.textures[1];
			this._butterflyMat.uniforms.uPingZ.value = this._read.textures[2];
		};
		for (let dir = 0; dir <= 1; dir++) {
			this._butterflyMat.uniforms.uDirection.value = dir;
			for (let s = 0; s < this.stages; s++) {
				this._butterflyMat.uniforms.uStage.value = s;
				bind();
				this._render(this._butterflyMat, this._write);
				this._swap();
			}
		}

		r.setRenderTarget(prevTarget);
		r.autoClear = prevAutoClear;
		return {
			displacementY: this._read.textures[0],
			displacementX: this._read.textures[1],
			displacementZ: this._read.textures[2],
		};
	}

	_swap() { const t = this._read; this._read = this._write; this._write = t; }

	dispose() {
		this._h0.dispose();
		this._ppA.dispose();
		this._ppB.dispose();
		this._butterfly.dispose();
		this._initialMat.dispose();
		this._timeMat.dispose();
		this._butterflyMat.dispose();
		this._quad.geometry.dispose();
	}
}
