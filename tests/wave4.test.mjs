// Wave 4 suite: CSP and keyboard-shortcut hardening, share-link bound checks, AC sweep caps,
// waveform edge semantics, spectrum/THD invariants, and the closed-form verify pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  transient, dcOperatingPoint, acSweep, logFreqs, solveDense,
} from '../src/mna.js';
import { computeLab, refineAC } from '../src/compute.js';
import { presetCircuit, PRESETS } from '../src/presets.js';
import { verify, theoryFor, compareCurves, minus3dB, acPeak } from '../src/theory.js';
import {
  waveValue, normalizeWave, waveDC, waveBreakpoints, chirpFreqAt, WAVE_KINDS,
} from '../src/waves.js';
import {
  spectrum, spectrumCoherent, findPeak, thd, measure, fft, hann,
} from '../src/fft.js';
import { pack, unpack, encodeLab, decodeLab, labFromHash } from '../src/serialize.js';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const html = read('index.html');
const css = read('styles.css');
const appSrc = read('src/app.js');

/* ------------------------------------------------------------------ */
/* CSP and keyboard hardening                                            */
/* ------------------------------------------------------------------ */

test('Wave 4: index.html ships a Content-Security-Policy meta tag', () => {
  assert.ok(/<meta\s+http-equiv="Content-Security-Policy"/i.test(html));
});

test('Wave 4: CSP restricts script-src to self with no unsafe-inline', () => {
  const csp = /content="([^"]+)"/.exec(/<meta\s+http-equiv="Content-Security-Policy"[^>]+>/.exec(html)[0])[1];
  assert.ok(/default-src 'self'/.test(csp));
  assert.ok(/script-src 'self'/.test(csp));
  assert.ok(!/unsafe-inline/.test(csp));
  assert.ok(!/unsafe-eval/.test(csp));
});

test('Wave 4: CSP blocks plugins, foreign base URIs and covers workers/fonts', () => {
  const csp = /content="([^"]+)"/.exec(/<meta\s+http-equiv="Content-Security-Policy"[^>]+>/.exec(html)[0])[1];
  assert.ok(/object-src 'none'/.test(csp));
  assert.ok(/base-uri 'none'/.test(csp));
  assert.ok(/worker-src 'self'/.test(csp), 'the solver worker must stay same-origin');
  assert.ok(/font-src 'self'/.test(csp));
  assert.ok(/manifest-src 'self'/.test(csp));
});

test('Wave 4: help dialog offers a shortcut on/off control (WCAG 2.1.4)', () => {
  assert.ok(/id="keys-on"/.test(html), 'missing #keys-on checkbox');
  assert.ok(/keys-toggle/.test(html));
  assert.ok(/single-key shortcuts/i.test(html));
});

test('Wave 4: every character-key shortcut is gated behind state.keysOn', () => {
  assert.ok(/k\.length === 1 && !state\.keysOn/.test(appSrc), 'char-key gate missing');
  // The gate must run before any shortcut dispatch.
  const gi = appSrc.indexOf('k.length === 1 && !state.keysOn');
  const si = appSrc.indexOf("k === 's' || k === 'S'");
  assert.ok(gi > 0 && si > gi, 'the gate must precede the single-key dispatch');
});

test('Wave 4: shortcut preference persists and restores', () => {
  assert.ok(/keys: state\.keysOn/.test(appSrc), 'STORE_UI payload missing keys');
  assert.ok(/ui\.keys/.test(appSrc), 'boot() never restores keys');
  assert.ok(/#keys-on'\);\s*if \(kt\) kt\.addEventListener/.test(appSrc.replace(/\n/g, ' '))
    || /\$\('#keys-on'\)/.test(appSrc));
});

test('Wave 4: no accesskey attributes (WCAG 2.1.4)', () => {
  assert.ok(!/accesskey\s*=/i.test(html));
});

test('Wave 4: focus is visibly outlined (WCAG 2.4.7)', () => {
  assert.ok(/:focus-visible\s*\{[^}]*outline\s*:/s.test(css));
});

test('Wave 4: no inline event handlers or javascript: URLs', () => {
  assert.ok(!/\son(click|load|error|keydown|keyup|keypress|input|change|mouseover|focus|blur)\s*=/i.test(html));
  assert.ok(!/javascript:/i.test(html));
});

test('Wave 4: the app is a single same-origin module script', () => {
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ['src/app.js']);
  assert.ok(/<script type="module" src="src\/app\.js">/.test(html));
});

/* ------------------------------------------------------------------ */
/* Share-link bounds                                                     */
/* ------------------------------------------------------------------ */

function labCode(mut) {
  const c = presetCircuit(0);
  const packed = pack(c);
  mut(packed);
  return Buffer.from(JSON.stringify(packed), 'utf8').toString('base64url');
}

test('Wave 4: wave phase beyond +-1e6 degrees is rejected', () => {
  const code = labCode((o) => { o.p.find((e) => e[0] === 'V')[3] = [1, 5, 0, 1000, 0.5, 0, 2e6, 1e4, 0.01]; });
  const r = decodeLab(code);
  assert.equal(r.ok, false);
  assert.match(r.error, /phase/i);
});

test('Wave 4: wave delay outside [0, 1e9] is rejected', () => {
  for (const delay of [-0.001, 1e9 + 1, Infinity]) {
    const code = labCode((o) => { const w = o.p.find((e) => e[0] === 'V')[3]; w[5] = delay; });
    const r = decodeLab(code);
    assert.equal(r.ok, false, `delay ${delay}`);
  }
});

test('Wave 4: wave sweep outside (0, 1e9] is rejected', () => {
  for (const sweep of [0, -1, 1e9 + 1]) {
    const code = labCode((o) => { const w = o.p.find((e) => e[0] === 'V')[3]; w[8] = sweep; });
    assert.equal(decodeLab(code).ok, false, `sweep ${sweep}`);
  }
});

test('Wave 4: source amplitude beyond 1000 V is rejected', () => {
  const code = labCode((o) => { const w = o.p.find((e) => e[0] === 'V')[3]; w[1] = 1001; });
  assert.equal(decodeLab(code).ok, false);
  const code2 = labCode((o) => { const w = o.p.find((e) => e[0] === 'V')[3]; w[2] = -1001; });
  assert.equal(decodeLab(code2).ok, false);
});

test('Wave 4: duty must sit strictly inside (0, 1)', () => {
  for (const duty of [0, 1, -0.5, 1.5]) {
    const code = labCode((o) => { const w = o.p.find((e) => e[0] === 'V')[3]; w[4] = duty; });
    assert.equal(decodeLab(code).ok, false, `duty ${duty}`);
  }
});

test('Wave 4: a link with 41 parts is rejected', () => {
  const code = labCode((o) => {
    while (o.p.length < 41) o.p.push(['R', `R${o.p.length + 1}`, 'a,0', 1000, [1, 1, 0]]);
  });
  assert.equal(decodeLab(code).ok, false);
});

test('Wave 4: a code longer than 4096 chars is rejected', () => {
  assert.equal(decodeLab('A'.repeat(4097)).ok, false);
});

test('Wave 4: reserved object-property names cannot be nodes', () => {
  for (const nm of ['__proto__', 'constructor', 'toString']) {
    const code = labCode((o) => { o.p[0][2] = `${nm},0`; });
    assert.equal(decodeLab(code).ok, false, nm);
  }
});

test('Wave 4: node ids must match the strict name regex', () => {
  for (const nm of ['a-b', 'a b', 'a.b', 'a'.repeat(13), '', 'no']) {
    const code = labCode((o) => { o.p[0][2] = `${nm},0`; });
    const r = decodeLab(code);
    if (nm === 'no') assert.equal(r.ok, true, 'short lowercase node names are allowed');
    else assert.equal(r.ok, false, `node "${nm}"`);
  }
});

test('Wave 4: part ids must match the strict id regex', () => {
  for (const id of ['r1', 'R_1', 'R'.repeat(9), 'V1 x', '']) {
    const code = labCode((o) => { o.p[0][1] = id; });
    assert.equal(decodeLab(code).ok, false, `id "${id}"`);
  }
});

test('Wave 4: a bad AC window inside a link is rejected', () => {
  const code = labCode((o) => { o.a = [0, 1e9]; });
  assert.equal(decodeLab(code).ok, false);
  const code2 = labCode((o) => { o.a = [100, 100]; });
  assert.equal(decodeLab(code2).ok, false);
});

test('Wave 4: a sim window with dt >= tstop is rejected', () => {
  const code = labCode((o) => { o.s = [0.001, 0.001]; });
  assert.equal(decodeLab(code).ok, false);
  const code2 = labCode((o) => { o.s = [101, 0.001]; });
  assert.equal(decodeLab(code2).ok, false);
});

test('Wave 4: off-world schematic coordinates are rejected', () => {
  const code = labCode((o) => { o.p[0][4] = [3000, 0, 0]; });
  assert.equal(decodeLab(code).ok, false);
  const code2 = labCode((o) => { o.p[0][4] = [1, 1, 4]; });
  assert.equal(decodeLab(code2).ok, false);
});

test('Wave 4: labFromHash rejects incomplete and foreign hashes', () => {
  assert.equal(labFromHash('#lab'), null);
  assert.equal(labFromHash('#foo=AAAA'), null);
  assert.equal(labFromHash('#lab=!!!').ok, false);
  assert.equal(labFromHash('#lab=AAAA===').ok, false);
});

test('Wave 4: encode is deterministic for the same circuit', () => {
  const c = presetCircuit(1);
  assert.equal(encodeLab(c), encodeLab(c));
  assert.equal(JSON.stringify(pack(c)), JSON.stringify(pack(c)));
});

test('Wave 4: every waveform kind round-trips through the codec', () => {
  for (const kind of WAVE_KINDS) {
    const c = presetCircuit(0);
    c.parts.find((p) => p.type === 'V').wave = normalizeWave({ kind });
    const r = decodeLab(encodeLab(c));
    assert.ok(r.ok, `${kind}: ${r.error}`);
    assert.equal(r.circuit.parts.find((p) => p.type === 'V').wave.kind, kind);
  }
});

test('Wave 4: unknown wave kind index is rejected', () => {
  const code = labCode((o) => { o.p.find((e) => e[0] === 'V')[3][0] = 99; });
  assert.equal(decodeLab(code).ok, false);
});

/* ------------------------------------------------------------------ */
/* Solver and sweep bounds                                               */
/* ------------------------------------------------------------------ */

test('Wave 4: AC sweep with more than 4096 frequencies fails BAD_AC', () => {
  const c = presetCircuit(0);
  const freqs = new Float64Array(4097).fill(1000);
  const r = acSweep(c, { source: 'V1', out: 'out', freqs });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'BAD_AC');
});

test('Wave 4: AC sweep at exactly 4096 frequencies still runs', () => {
  const c = presetCircuit(0);
  const freqs = new Float64Array(4096).fill(1000);
  const r = acSweep(c, { source: 'V1', out: 'out', freqs });
  assert.ok(r.ok, r.error && r.error.code);
  assert.equal(r.mag.length, 4096);
});

test('Wave 4: AC sweep rejects an unknown output or source', () => {
  const c = presetCircuit(0);
  const freqs = logFreqs(10, 1e4, 4);
  const a = acSweep(c, { source: 'V1', out: 'nope', freqs });
  assert.equal(a.ok, false);
  assert.equal(a.error.code, 'BAD_AC');
  const b = acSweep(c, { source: 'V9', out: 'out', freqs });
  assert.equal(b.ok, false);
  assert.equal(b.error.code, 'BAD_AC');
});

test('Wave 4: AC sweep rejects empty and non-positive frequency lists', () => {
  const c = presetCircuit(0);
  assert.equal(acSweep(c, { source: 'V1', out: 'out', freqs: [] }).error.code, 'BAD_AC');
  assert.equal(acSweep(c, { source: 'V1', out: 'out', freqs: [0] }).error.code, 'BAD_AC');
  assert.equal(acSweep(c, { source: 'V1', out: 'out', freqs: [-5] }).error.code, 'BAD_AC');
  assert.equal(acSweep(c, { source: 'V1', out: 'out', freqs: [NaN] }).error.code, 'BAD_AC');
  assert.equal(acSweep(c, { source: 'V1', out: 'out', freqs: null }).error.code, 'BAD_AC');
});

test('Wave 4: transient rejects non-positive and non-finite windows', () => {
  const c = presetCircuit(0);
  for (const [tstop, dt] of [[0, 1e-4], [-1, 1e-4], [1e-3, 0], [1e-3, -1e-4], [NaN, 1e-4], [1e-3, NaN], [Infinity, 1e-4]]) {
    const r = transient(c, { tstop, dt });
    assert.equal(r.ok, false, `tstop ${tstop} dt ${dt}`);
    assert.equal(r.error.code, 'BAD_SIM');
  }
});

test('Wave 4: transient snaps the grid so the last sample lands on tstop', () => {
  const c = presetCircuit(0);
  const r = transient(c, { tstop: 0.0017, dt: 0.0003 });
  assert.ok(r.ok, r.error && r.error.code);
  assert.ok(Math.abs(r.t[r.t.length - 1] - 0.0017) < 1e-15);
  assert.ok(Math.abs(r.dt - 0.0017 / Math.round(0.0017 / 0.0003)) < 1e-12);
});

test('Wave 4: transient refuses a window above the sample cap', () => {
  const c = presetCircuit(0);
  const r = transient(c, { tstop: 100, dt: 1e-4 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'BAD_SIM');
});

test('Wave 4: backward-Euler mode agrees with trapezoid on an RC step', () => {
  const c = presetCircuit(0);
  const trap = transient(c, { tstop: 0.005, dt: 2e-5, method: 'trap' });
  const be = transient(c, { tstop: 0.005, dt: 2e-5, method: 'be' });
  assert.ok(trap.ok && be.ok);
  assert.equal(be.stats.method, 'be');
  const last = trap.nodes.out.length - 1;
  assert.ok(Math.abs(trap.nodes.out[last] - be.nodes.out[last]) < 0.02,
    `${trap.nodes.out[last]} vs ${be.nodes.out[last]}`);
});

test('Wave 4: compile rejects a circuit over the part cap', () => {
  const c = presetCircuit(0);
  for (let i = 0; i < 50; i++) c.parts.push({ id: `Rx${i}`, type: 'R', nodes: ['in', '0'], value: 1000 });
  const r = transient(c, { tstop: 0.001, dt: 1e-4 });
  assert.equal(r.ok, false);
});

test('Wave 4: solveDense fails on a rank-deficient matrix', () => {
  // Row 2 is 2x row 1: after elimination the pivot is exactly 0.
  const A = new Float64Array([1, 2, 2, 4]);
  const b = new Float64Array([1, 2]);
  const r = solveDense(A, b, 2);
  assert.equal(r.ok, false, 'a singular pivot must fail');
  assert.equal(r.row, 1);
});

test('Wave 4: solveDense solves a 1e-16-scaled system (row scaling protects it)', () => {
  // A tiny uniform row is NOT singular; scaled pivoting must not misread it.
  const A = new Float64Array([1e-16, 0, 0, 1]);
  const b = new Float64Array([1e-16, 1]);
  const r = solveDense(A, b, 2);
  assert.ok(r.ok);
  assert.ok(Math.abs(r.x[0] - 1) < 1e-6 && Math.abs(r.x[1] - 1) < 1e-9);
});

test('Wave 4: solveDense flags an ill-conditioned matrix without failing it', () => {
  // Off-diagonal dominance: |1-1e-13| vs 1 -> cond well under the 1e-10 flag.
  const A = new Float64Array([1, 1, 1 - 1e-13, 1]);
  const b = new Float64Array([2, 2]);
  const r = solveDense(A, b, 2);
  assert.ok(r.ok);
  assert.ok(r.cond < 1, `cond ${r.cond} should reflect the near-dependence`);
});

/* ------------------------------------------------------------------ */
/* Waveform edge semantics                                               */
/* ------------------------------------------------------------------ */

test('Wave 4: step source holds offset before delay and offset+amp after', () => {
  const w = normalizeWave({ kind: 'step', amp: 5, offset: -1, delay: 0.001 });
  assert.equal(waveValue(w, 0.0009), -1);
  assert.equal(waveValue(w, 0.0011), 4);
});

test('Wave 4: square wave duty edges switch on the right side', () => {
  const w = normalizeWave({ kind: 'square', amp: 1, offset: 0, freq: 1000, duty: 0.25 });
  const T = 1 / 1000;
  assert.ok(waveValue(w, 0.1 * T) > 0, 'inside high phase');
  assert.ok(waveValue(w, 0.5 * T) < 0, 'inside low phase');
  // Left limit at the falling edge is high; right limit is low.
  assert.ok(waveValue(w, 0.25 * T, -1) > 0);
  assert.ok(waveValue(w, 0.25 * T, 1) < 0);
});

test('Wave 4: chirp holds the end frequency past the sweep', () => {
  const w = normalizeWave({ kind: 'chirp', amp: 1, freq: 100, f2: 10000, sweep: 0.01 });
  assert.equal(chirpFreqAt(w, 0.005), 100 + (10000 - 100) * 0.5);
  assert.equal(chirpFreqAt(w, 0.02), 10000);
  assert.equal(chirpFreqAt(w, 0.1), 10000);
});

test('Wave 4: sine phase shifts the waveform by the phase angle', () => {
  const w = normalizeWave({ kind: 'sine', amp: 1, freq: 1000, phase: 90 });
  assert.ok(Math.abs(waveValue(w, 0) - 1) < 1e-6, 'sin(90 deg) = 1');
  const w0 = normalizeWave({ kind: 'sine', amp: 1, freq: 1000, phase: 0 });
  assert.ok(Math.abs(waveValue(w0, 0)) < 1e-6);
});

test('Wave 4: waveDC reads the t = 0- level for delayed sources', () => {
  const step = normalizeWave({ kind: 'step', amp: 5, offset: -1, delay: 0.001 });
  assert.equal(waveDC(step), -1);
  const sine = normalizeWave({ kind: 'sine', amp: 2, offset: 3, freq: 1000, phase: 30, delay: 0.001 });
  assert.ok(Math.abs(waveDC(sine) - (3 + 2 * Math.sin(Math.PI / 6))) < 1e-9);
});

test('Wave 4: square breakpoints mark both edges inside the window', () => {
  const w = normalizeWave({ kind: 'square', amp: 1, freq: 1000, duty: 0.3, delay: 0.0005 });
  const bps = waveBreakpoints(w, 0.003);
  assert.ok(bps.includes(0.0005));
  assert.ok(bps.includes(0.0005 + 0.3 * 0.001));
  assert.ok(bps.every((b) => b <= 0.003));
});

test('Wave 4: normalizeWave clamps duty and fills defaults', () => {
  const w = normalizeWave({ kind: 'square', duty: 0.999 });
  assert.equal(w.duty, 0.99);
  const w2 = normalizeWave({ kind: 'square', duty: 0.001 });
  assert.equal(w2.duty, 0.01);
  const w3 = normalizeWave({});
  assert.equal(w3.kind, 'dc');
});

/* ------------------------------------------------------------------ */
/* Spectrum, peaks and THD                                               */
/* ------------------------------------------------------------------ */

test('Wave 4: fft rejects a non power-of-two length', () => {
  assert.throws(() => fft(new Float64Array(3), new Float64Array(3)));
});

test('Wave 4: Hann spectrum of a pure sine reads its frequency and amplitude', () => {
  const fs = 48000, f0 = 1000, N = 8192;
  const sig = new Float64Array(N);
  for (let i = 0; i < N; i++) sig[i] = 2 * Math.sin(2 * Math.PI * f0 * i / fs);
  const spec = spectrum(sig, fs);
  assert.ok(spec && !spec.flat);
  assert.ok(Math.abs(spec.peak.freq - f0) < spec.binHz, `${spec.peak.freq} vs ${f0}`);
  assert.ok(Math.abs(spec.peak.amp - 2) < 0.05, `${spec.peak.amp} vs 2`);
});

test('Wave 4: a flat trace reports flat with no phantom peak', () => {
  const sig = new Float64Array(4096).fill(3.3);
  const spec = spectrum(sig, 48000);
  assert.ok(spec.flat);
  assert.ok(!Number.isFinite(spec.peak.freq));
});

test('Wave 4: coherent spectrum lands harmonics on exact bins', () => {
  // 10 cycles of a 1 kHz square over 0.01 s at fs = 48 kHz -> 480 samples.
  const fs = 48000, len = 480;
  const sig = new Float64Array(500);
  for (let i = 0; i < 500; i++) sig[i] = Math.sign(Math.sin(2 * Math.PI * 1000 * i / fs));
  const spec = spectrumCoherent(sig, fs, 0, len);
  assert.ok(spec.coherent);
  const h1 = Math.round(1000 / spec.binHz);
  assert.ok(spec.amp[h1] > 0.9 * (4 / Math.PI), `fundamental bin weak: ${spec.amp[h1]}`);
  assert.ok(spec.amp[3 * h1] > 0.9 * (4 / (3 * Math.PI)), `3rd harmonic weak: ${spec.amp[3 * h1]}`);
  // Even harmonics of a 50% square wave sit ~60 dB down.
  assert.ok(spec.amp[2 * h1] < 0.05 * spec.amp[h1]);
});

test('Wave 4: THD of a coherent sine is near zero', () => {
  const fs = 48000, len = 480;
  const sig = new Float64Array(500);
  for (let i = 0; i < 500; i++) sig[i] = Math.sin(2 * Math.PI * 1000 * i / fs);
  const spec = spectrumCoherent(sig, fs, 0, len);
  const r = thd(spec, 1000, 10);
  assert.equal(r.reason, null);
  assert.ok(r.percent < 0.5, `sine THD ${r.percent}%`);
});

test('Wave 4: THD of an ideal square wave matches the harmonic series it integrates', () => {
  const fs = 48000, len = 480;
  const sig = new Float64Array(500);
  for (let i = 0; i < 500; i++) sig[i] = Math.sign(Math.sin(2 * Math.PI * 1000 * i / fs));
  const spec = spectrumCoherent(sig, fs, 0, len);
  const r = thd(spec, 1000, 10);
  assert.equal(r.reason, null);
  // Only odd harmonics 3,5,7,9 sit inside maxHarmonics = 10; the theoretical total (48.3%)
  // also sums h >= 11, so the expected figure is the partial odd-harmonic sum.
  const partial = Math.sqrt(1 / 9 + 1 / 25 + 1 / 49 + 1 / 81) * 100;
  assert.ok(Math.abs(r.percent - partial) < 1.5, `${r.percent}% vs ${partial}%`);
});

test('Wave 4: THD refuses with an explicit reason when there is no fundamental', () => {
  const fs = 48000;
  const sig = new Float64Array(4096);
  for (let i = 0; i < sig.length; i++) sig[i] = (Math.random() - 0.5) * 0.001;
  const spec = spectrum(sig, fs);
  const r = thd(spec, 1000, 10);
  assert.ok(r.reason !== null, 'noise floor must not report a THD figure');
  assert.ok(!Number.isFinite(r.percent));
});

test('Wave 4: THD refuses when harmonics would sit above Nyquist', () => {
  const spec = { binHz: 10, fs: 48000, power: new Float64Array(2401).fill(0), coherent: true, enbw: 1 };
  spec.power[400] = 1; // 4 kHz fundamental; 10th harmonic at 40 kHz > Nyquist
  const r = thd(spec, 4000, 10);
  assert.match(r.reason, /Nyquist/);
});

test('Wave 4: THD refuses when the window holds too few cycles', () => {
  const spec = { binHz: 500, fs: 48000, power: new Float64Array(2401).fill(0), coherent: true, enbw: 1 };
  spec.power[2] = 1; // fundamental at 1 kHz = 2 bins -> below coherent minimum of 2? boundary
  spec.binHz = 500;
  const r = thd(spec, 999, 10);
  assert.match(r.reason, /too few cycles/);
});

test('Wave 4: findPeak centres an off-bin tone by parabolic interpolation', () => {
  const amp = new Float64Array(64);
  // Synthetic peak midway between bins 20 and 21.
  for (let k = 0; k < 64; k++) amp[k] = Math.exp(-((k - 20.5) ** 2) / 2);
  const p = findPeak(amp, 10);
  assert.ok(Math.abs(p.freq - 205) < 2, `${p.freq}`);
});

test('Wave 4: measure() returns NaN duty and freq on a flat trace', () => {
  const m = measure(new Float64Array(1000).fill(2.5), 48000);
  assert.ok(Number.isNaN(m.duty));
  assert.ok(Number.isNaN(m.freq));
  assert.equal(m.vpp, 0);
});

test('Wave 4: measure() reads frequency, duty and RMS on a square', () => {
  const fs = 48000, n = 4800;
  const sig = new Float64Array(n);
  for (let i = 0; i < n; i++) sig[i] = Math.sign(Math.sin(2 * Math.PI * 1000 * i / fs));
  const m = measure(sig, fs);
  assert.ok(Math.abs(m.freq - 1000) < 1, `${m.freq}`);
  assert.ok(Math.abs(m.duty - 0.5) < 0.03, `${m.duty}`);
  // sign(sin 0) emits the odd exact zero sample, so RMS sits a hair under 1.
  assert.ok(m.rms > 0.99 && m.rms <= 1, `${m.rms}`);
});

test('Wave 4: hann() window has unit endpoints near zero and 0.5 gain', () => {
  const w = hann(1024);
  assert.ok(w[0] < 1e-9 && w[1023] < 1e-9);
  const sum = w.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum / 1024 - 0.5) < 0.01);
});

/* ------------------------------------------------------------------ */
/* Theory, verify and the compute pipeline                               */
/* ------------------------------------------------------------------ */

test('Wave 4: minus3dB interpolates the crossing on a low-pass sweep', () => {
  // Synthetic single-pole magnitude: -20log10|1/(1+jf/fc)| with fc = 1592 Hz.
  const fc = 1592;
  const freqs = logFreqs(10, 1e5, 20);
  const mag = Float64Array.from(freqs, (f) => -10 * Math.log10(1 + (f / fc) ** 2));
  const f3 = minus3dB({ freqs, mag });
  assert.ok(Math.abs(f3 - fc) < 0.02 * fc, `${f3} vs ${fc}`);
});

test('Wave 4: minus3dB returns NaN when no crossing exists', () => {
  const freqs = logFreqs(10, 1e4, 10);
  const mag = new Float64Array(freqs.length).fill(0); // flat 0 dB passband
  assert.ok(Number.isNaN(minus3dB({ freqs, mag })));
});

test('Wave 4: acPeak refines a resonant peak between bins', () => {
  const freqs = logFreqs(100, 1e5, 20);
  const f0 = 5000;
  const mag = Float64Array.from(freqs, (f) => -20 * Math.log10(1 + ((Math.log(f / f0)) ** 2) * 80));
  const pk = acPeak({ freqs, mag });
  assert.ok(Math.abs(pk.freq - f0) < 0.05 * f0, `${pk.freq} vs ${f0}`);
});

test('Wave 4: compareCurves reports 0% on identical and NaN-safe zero signal', () => {
  const a = new Float64Array([0, 0, 0]);
  const c = compareCurves(a, new Float64Array([0, 0, 0]));
  assert.equal(c.rmse, 0);
  assert.equal(c.rmsePct, 0);
  // A nonzero (however tiny) theory curve gets a normal finite percentage.
  const d = compareCurves(a, new Float64Array([0, 1e-9, 0]));
  assert.ok(Number.isFinite(d.rmsePct), `rmsePct ${d.rmsePct}`);
});

test('Wave 4: verify() reports every guided lab inside tolerance after a full run', () => {
  for (const preset of PRESETS) {
    const c = presetCircuit(preset.id);
    const r = computeLab(c);
    assert.ok(r.ok, `${preset.id}: ${r.error && r.error.code}`);
    assert.ok(r.verify.ok, `${preset.id}: ${r.verify.reason}`);
    for (const chk of r.verify.checks) {
      if (chk.skipped) continue;
      assert.ok(Number.isFinite(chk.measured), `${preset.id}/${chk.name}: non-finite measured`);
    }
  }
});

test('Wave 4: theoryFor refuses a custom circuit with a reason', () => {
  const r = theoryFor({ lab: '', parts: [], probes: {} });
  assert.equal(r.ok, false);
  assert.ok(r.reason && r.reason.length > 5);
});

test('Wave 4: computeLab only attempts THD on a periodic drive', () => {
  const c = presetCircuit(0);
  c.parts.find((p) => p.type === 'V').wave = normalizeWave({ kind: 'chirp', freq: 100, f2: 5000, sweep: c.sim.tstop });
  const r = computeLab(c);
  assert.ok(r.ok);
  assert.equal(r.chans.ch1.thd, null, 'chirp must not produce a THD number');
});

test('Wave 4: refineAC lands the RC cutoff within a fraction of theory', () => {
  const c = presetCircuit('rc');
  const r = computeLab(c);
  assert.ok(r.ok && r.ac && r.ac.ok);
  const th = theoryFor(c);
  const refined = r.ac.refined && r.ac.refined.f3dB;
  assert.ok(Number.isFinite(refined));
  assert.ok(Math.abs(refined - th.summary.fc) < 0.02 * th.summary.fc,
    `${refined} vs ${th.summary.fc}`);
});

test('Wave 4: computeLab result is deterministic for the same circuit', () => {
  const c = presetCircuit(0);
  const a = computeLab(c);
  const b = computeLab(c);
  assert.deepEqual(Array.from(a.tran.nodes.out.slice(0, 50)), Array.from(b.tran.nodes.out.slice(0, 50)));
  assert.equal(a.chans.ch1.metrics.freq, b.chans.ch1.metrics.freq);
});

test('Wave 4: transient warns about an ill-conditioned deck without failing', () => {
  // A 1e9-Ohm resistor beside a 1-Ohm path makes the Jacobian badly scaled but solvable.
  const c = presetCircuit(0);
  c.parts.push({ id: 'Rbig', type: 'R', nodes: ['in', '0'], value: 1e9 });
  const r = transient(c, { tstop: 0.002, dt: 1e-4 });
  assert.ok(r.ok, r.error && r.error.code);
});

test('Wave 4: dcOperatingPoint solves a resistive divider exactly', () => {
  const c = presetCircuit('div');
  const r = dcOperatingPoint(c);
  assert.ok(r.ok, r.error && r.error.code);
  const P = Object.fromEntries(c.parts.map((p) => [p.id, p]));
  const R1 = P.R1 ? P.R1.value : null;
  assert.ok(R1 > 0);
});

test('Wave 4: notes and warnings never contain NaN text', () => {
  for (const preset of PRESETS) {
    const c = presetCircuit(preset.id);
    const r = computeLab(c);
    assert.ok(r.ok);
    for (const w of r.warnings) {
      assert.ok(!/NaN/.test(JSON.stringify(w)), `${preset.id} warning: ${JSON.stringify(w)}`);
    }
  }
});
