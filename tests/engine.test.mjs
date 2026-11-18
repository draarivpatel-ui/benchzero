// BenchZero engine tests. Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSI, formatSI, toSIInput } from '../src/units.js';
import { transient, acSweep, dcOperatingPoint, solveDense } from '../src/mna.js';
import { fft, spectrum, thd, measure } from '../src/fft.js';
import { theoryFor, verify, compareCurves } from '../src/theory.js';
import { computeLab } from '../src/compute.js';
import { PRESETS, presetCircuit } from '../src/presets.js';
import { encodeLab, decodeLab, labFromHash } from '../src/serialize.js';
import { normalizeWave, waveValue, chirpFreqAt } from '../src/waves.js';

const TWO_PI = 2 * Math.PI;
const report = [];
const note = (name, r) => {
  report.push({ name, rmse: r.rmse, rmsePct: r.rmsePct, maxErr: r.maxErr });
  console.log(`  [rmse] ${name}: RMSE ${(r.rmse * 1e3).toPrecision(4)} mV (${r.rmsePct.toPrecision(4)}% of full scale), max error ${(r.maxErr * 1e3).toPrecision(4)} mV`);
};
const allFinite = (res) => Object.values(res.nodes).every((a) => a.every(Number.isFinite));
// Walk any result object and fail on NaN or Infinity anywhere (JSON.stringify would hide NaN as null).
function assertAllFinite(obj, where, path = '') {
  if (typeof obj === 'number') { assert.ok(Number.isFinite(obj), `${where}: non-finite number at ${path || '(root)'}`); return; }
  if (!obj || typeof obj !== 'object') return;
  if (ArrayBuffer.isView(obj)) { for (let i = 0; i < obj.length; i++) if (!Number.isFinite(obj[i])) assert.fail(`${where}: non-finite at ${path}[${i}]`); return; }
  for (const [k, v] of Object.entries(obj)) assertAllFinite(v, where, `${path}.${k}`);
}

const rc = (wave) => ({
  lab: 'rc',
  parts: [
    { id: 'V1', type: 'V', nodes: ['in', '0'], wave },
    { id: 'R1', type: 'R', nodes: ['in', 'out'], value: 1000 },
    { id: 'C1', type: 'C', nodes: ['out', '0'], value: 1e-6 },
  ],
});

test('units: SI parsing and formatting round-trip', () => {
  assert.equal(parseSI('1k'), 1000);
  assert.ok(Math.abs(parseSI('100n') - 1e-7) < 1e-22);
  assert.ok(Math.abs(parseSI('4.7m') - 4.7e-3) < 1e-18);
  assert.ok(Math.abs(parseSI('10u') - 1e-5) < 1e-20);
  assert.equal(parseSI('2.2meg'), 2.2e6);
  assert.ok(Math.abs(parseSI('100nF') - 1e-7) < 1e-22);
  assert.equal(parseSI('1.5 kOhm'), 1500);
  assert.equal(parseSI('5H'), 5);
  assert.ok(Number.isNaN(parseSI('abc')));
  assert.ok(Number.isNaN(parseSI('1kx')));
  assert.equal(formatSI(1e-7, 'F'), '100 nF');
  assert.equal(formatSI(4700, 'Ω'), '4.7 kΩ');
  for (const v of [1, 4.7e-3, 1e-7, 2.2e6, 33e3, 1e-12]) {
    assert.ok(Math.abs(parseSI(toSIInput(v)) - v) <= 1e-9 * v, `round trip ${v}`);
  }
});

test('linear solver: partial pivoting solves a matrix that needs a row swap', () => {
  const A = Float64Array.from([0, 1, 1, 1]);
  const b = Float64Array.from([2, 3]);
  const r = solveDense(A, b, 2);
  assert.ok(r.ok);
  assert.ok(Math.abs(r.x[0] - 1) < 1e-15 && Math.abs(r.x[1] - 2) < 1e-15);
});

test('DC voltage divider matches R2/(R1+R2) within 1e-9 V', () => {
  const c = {
    parts: [
      { id: 'V1', type: 'V', nodes: ['in', '0'], wave: { kind: 'dc', offset: 10 } },
      { id: 'R1', type: 'R', nodes: ['in', 'out'], value: 4700 },
      { id: 'R2', type: 'R', nodes: ['out', '0'], value: 3300 },
    ],
  };
  const op = dcOperatingPoint(c);
  assert.ok(op.ok);
  const expect = (10 * 3300) / (4700 + 3300);
  assert.ok(Math.abs(op.nodes.out - expect) < 1e-9, `got ${op.nodes.out}, want ${expect}`);
  // Loaded divider (preset 5 with a 1 k load).
  const d = presetCircuit('div');
  d.parts.find((p) => p.id === 'RL').value = 1000;
  const op2 = dcOperatingPoint(d);
  const rp = (10000 * 1000) / 11000;
  assert.ok(Math.abs(op2.nodes.out - (10 * rp) / (10000 + rp)) < 1e-9);
});

test('RC step transient tracks V0(1 - exp(-t/RC)) under 0.5% RMSE', () => {
  const c = rc({ kind: 'step', amp: 5 });
  const res = transient(c, { tstop: 5e-3, dt: 2.5e-6 });
  assert.ok(res.ok);
  assert.ok(allFinite(res));
  const th = new Float64Array(res.t.length);
  for (let i = 0; i < th.length; i++) th[i] = 5 * (1 - Math.exp(-res.t[i] / 1e-3));
  const cmp = compareCurves(res.nodes.out, th);
  note('RC step (R=1k, C=1u, dt=RC/400)', cmp);
  assert.ok(cmp.rmsePct < 0.5);
  // The edge at t = 0 is handled exactly: output starts at 0, input at 5 V.
  assert.equal(res.nodes.in[0], 5);
  assert.ok(Math.abs(res.nodes.out[0]) < 1e-6);
  // theory.js gives the same curve independently.
  const v = verify({ ...c, sim: { tstop: 5e-3, dt: 2.5e-6 } }, res, null);
  assert.ok(v.ok && v.rmsePct < 0.5);
});

test('RC square and sine responses match the exact piecewise and closed-form solutions', () => {
  for (const wave of [
    { kind: 'square', amp: 2.5, offset: 2.5, freq: 200 },
    { kind: 'sine', amp: 1, offset: 0, freq: 159.15494309189535 },
    { kind: 'triangle', amp: 1, offset: 0, freq: 300 },
  ]) {
    const c = rc(wave);
    const res = transient(c, { tstop: 10e-3, dt: 2e-6 });
    assert.ok(res.ok);
    const v = verify(c, res, null);
    assert.ok(v.ok, v.reason);
    note(`RC ${wave.kind} ${wave.freq.toFixed(0)} Hz`, v);
    assert.ok(v.rmsePct < 0.5);
  }
});

test('RC Bode at fc is -3.0103 dB and -45 degrees', () => {
  const c = rc({ kind: 'step', amp: 5 });
  const fc = 1 / (TWO_PI * 1000 * 1e-6);
  const ac = acSweep(c, { source: 'V1', out: 'out', freqs: [fc] });
  assert.ok(ac.ok);
  assert.ok(Math.abs(ac.mag[0] - -3.0103) < 1e-3, `mag ${ac.mag[0]}`);
  assert.ok(Math.abs(ac.phase[0] - -45) < 1e-9, `phase ${ac.phase[0]}`);
  // The full pipeline finds the crossing by bisection.
  const lab = computeLab(presetCircuit('rc'));
  assert.ok(lab.ok);
  assert.ok(Math.abs(lab.ac.refined.f3dB - fc) / fc < 1e-4, `f3dB ${lab.ac.refined.f3dB}`);
  console.log(`  [bode] RC fc theory ${fc.toFixed(4)} Hz, measured -3 dB at ${lab.ac.refined.f3dB.toFixed(4)} Hz; |H(fc)| ${ac.mag[0].toFixed(5)} dB, phase ${ac.phase[0].toFixed(6)} deg`);
});

test('Series RLC underdamped step under 0.5% RMSE and AC resonance peak', () => {
  const c = presetCircuit('rlc');
  const res = transient(c, c.sim);
  assert.ok(res.ok && allFinite(res));
  const th = theoryFor(c);
  assert.ok(th.ok);
  const cmp = compareCurves(res.nodes.out, th.curve(res.t));
  note('RLC step (R=20, L=10m, C=1u, zeta=0.1)', cmp);
  assert.ok(cmp.rmsePct < 0.5);
  // Damped sinusoid written out independently of theory.js.
  const L = 10e-3;
  const C = 1e-6;
  const R = 20;
  const w0 = 1 / Math.sqrt(L * C);
  const z = (R / 2) * Math.sqrt(C / L);
  const wd = w0 * Math.sqrt(1 - z * z);
  let se = 0;
  for (let i = 0; i < res.t.length; i++) {
    const t = res.t[i];
    const e = 5 * (1 - Math.exp(-z * w0 * t) * (Math.cos(wd * t) + (z / Math.sqrt(1 - z * z)) * Math.sin(wd * t)));
    se += (res.nodes.out[i] - e) ** 2;
  }
  assert.ok(Math.sqrt(se / res.t.length) / 10 < 0.005);
  // AC: the capacitor-voltage peak sits at f0*sqrt(1 - 2 zeta^2) with gain 1/(2 zeta sqrt(1 - zeta^2)).
  const lab = computeLab(c);
  const fpk = (w0 / TWO_PI) * Math.sqrt(1 - 2 * z * z);
  const gpk = 20 * Math.log10(1 / (2 * z * Math.sqrt(1 - z * z)));
  assert.ok(Math.abs(lab.ac.refined.peakFreq - fpk) / fpk < 1e-4, `peak ${lab.ac.refined.peakFreq} vs ${fpk}`);
  assert.ok(Math.abs(lab.ac.refined.peakDb - gpk) < 1e-3);
  console.log(`  [bode] RLC peak theory ${fpk.toFixed(3)} Hz / ${gpk.toFixed(4)} dB, measured ${lab.ac.refined.peakFreq.toFixed(3)} Hz / ${lab.ac.refined.peakDb.toFixed(4)} dB`);
  // Driving at f0: the resistor voltage is in phase with the source (V_R/V_in = 1 at f0).
  const vr = acSweep(c, { source: 'V1', out: 'in', ref: 'a', freqs: [w0 / TWO_PI] });
  assert.ok(Math.abs(vr.mag[0]) < 1e-6 && Math.abs(vr.phase[0]) < 1e-6);
});

test('RLC sine drive at f0 matches the closed-form forced plus natural response', () => {
  const c = presetCircuit('rlc');
  c.parts[0].wave = { kind: 'sine', amp: 1, offset: 0, freq: 1591.549 };
  const res = transient(c, c.sim);
  const v = verify(c, res, null);
  assert.ok(v.ok);
  note('RLC sine at f0', v);
  assert.ok(v.rmsePct < 0.5);
});

test('Diode rectifier: Newton-Raphson converges with a silicon drop near 0.7 V', () => {
  const c = presetCircuit('rect');
  const res = transient(c, c.sim);
  assert.ok(res.ok, res.error && res.error.message);
  assert.ok(allFinite(res));
  assert.ok(res.stats.maxIters < 30, `max iterations ${res.stats.maxIters}`);
  let vin = -Infinity;
  let vout = -Infinity;
  const n = res.t.length;
  for (let i = n - 1667; i < n; i++) { vin = Math.max(vin, res.nodes.in[i]); vout = Math.max(vout, res.nodes.out[i]); }
  const drop = vin - vout;
  assert.ok(drop > 0.6 && drop < 0.8, `drop ${drop}`);
  // Diode current never meaningfully negative (reverse leakage only).
  let minI = Infinity;
  for (const i of res.currents.D1) minI = Math.min(minI, i);
  assert.ok(minI > -1e-9, `reverse current ${minI}`);
  const v = verify(c, res, null);
  assert.ok(v.ok);
  note('Rectifier vs approximate ideal-switch model', v);
  for (const ch of v.checks) assert.ok(ch.pass, `${ch.name}: expected ${ch.expected}, got ${ch.measured}`);
  console.log(`  [diode] peak drop ${drop.toFixed(4)} V, Newton iterations ${res.stats.newtonIters} over ${res.stats.steps} steps (max ${res.stats.maxIters})`);
  // LED model drops much more.
  c.parts.find((p) => p.id === 'D1').model = 'led';
  const led = transient(c, c.sim);
  assert.ok(led.ok && allFinite(led));
  let lo = -Infinity;
  for (let i = n - 1667; i < n; i++) lo = Math.max(lo, led.nodes.out[i]);
  assert.ok(vin - lo > 1.5, `LED drop ${vin - lo}`);
});

test('Inverting op-amp: gain -Rf/Rin, 180 degree inversion and rail clipping', () => {
  const c = presetCircuit('inv');
  const lab = computeLab(c);
  assert.ok(lab.ok);
  const gainAC = 10 ** (lab.ac.mag[0] / 20);
  assert.ok(Math.abs(gainAC - 10) / 10 < 1e-3, `gain ${gainAC}`);
  const ph = ((lab.ac.phase[0] % 360) + 360) % 360;
  assert.ok(Math.abs(ph - 180) < 0.01, `phase ${ph}`);
  note('Inverting amp (gain -10, A=1e5)', lab.verify);
  assert.ok(lab.verify.rmsePct < 0.5);
  // Overdrive: 2 V in, gain -10, rails +/- 12 V.
  c.parts[0].wave = { kind: 'sine', amp: 2, offset: 0, freq: 1000 };
  const res = transient(c, c.sim);
  assert.ok(res.ok && allFinite(res));
  let mx = -Infinity;
  let mn = Infinity;
  for (const v of res.nodes.out) { mx = Math.max(mx, v); mn = Math.min(mn, v); }
  assert.ok(mx <= 12 && mn >= -12, `out ${mn}..${mx}`);
  assert.ok(mx > 11.9 && mn < -11.9);
  const v = verify(c, res, null);
  note('Inverting amp clipping at the rails', v);
  assert.ok(v.rmsePct < 0.5);
});

test('FFT: peak frequency, amplitude, square-wave harmonics and THD', () => {
  const fs = 48000;
  const N = 8192;
  const f = 1234.5;
  const x = new Float64Array(N);
  for (let i = 0; i < N; i++) x[i] = 0.8 * Math.sin((TWO_PI * f * i) / fs);
  const s = spectrum(x, fs);
  assert.ok(Math.abs(s.peak.freq - f) < 0.05 * s.binHz, `peak ${s.peak.freq}`);
  assert.ok(Math.abs(s.peak.amp - 0.8) < 0.02, `amp ${s.peak.amp}`);
  assert.ok(thd(s, s.peak.freq).percent < 0.1);
  // Sine plus 10% third harmonic.
  for (let i = 0; i < N; i++) x[i] += 0.08 * Math.sin((TWO_PI * 3 * f * i) / fs);
  const s3 = spectrum(x, fs);
  const t3 = thd(s3, s3.peak.freq);
  assert.ok(Math.abs(t3.percent - 10) < 0.3, `thd ${t3.percent}`);
  // Square wave: odd harmonics at 4/(pi k), THD = sqrt(pi^2/8 - 1) = 48.3% (finite band).
  const fsq = 750;
  for (let i = 0; i < N; i++) x[i] = Math.sin((TWO_PI * fsq * i) / fs) >= 0 ? 1 : -1;
  const sq = spectrum(x, fs);
  const tq = thd(sq, sq.peak.freq, 9);
  assert.ok(Math.abs(tq.harmonics[0].amp - 4 / Math.PI) < 0.03);
  assert.ok(Math.abs(tq.harmonics[2].amp - 4 / (3 * Math.PI)) < 0.03);
  assert.ok(tq.harmonics[1].amp < 0.02, 'even harmonic should vanish');
  const thd9 = Math.sqrt([3, 5, 7, 9].reduce((a, k) => a + (1 / k) ** 2, 0));
  assert.ok(Math.abs(tq.ratio - thd9) < 0.02, `thd ${tq.ratio} vs ${thd9}`);
  // Raw radix-2 transform of a single bin.
  const re = new Float64Array(16);
  const im = new Float64Array(16);
  for (let i = 0; i < 16; i++) re[i] = Math.cos((TWO_PI * 3 * i) / 16);
  fft(re, im);
  assert.ok(Math.abs(re[3] - 8) < 1e-12 && Math.abs(re[13] - 8) < 1e-12 && Math.abs(re[0]) < 1e-12);
  // Duty cycle and frequency from a 25% pulse train.
  const p = new Float64Array(N);
  for (let i = 0; i < N; i++) p[i] = ((i * 1000) / fs) % 1 < 0.25 ? 5 : 0;
  const m = measure(p, fs);
  assert.ok(Math.abs(m.duty - 0.25) < 0.01 && Math.abs(m.freq - 1000) < 1 && Math.abs(m.vpp - 5) < 1e-12);
});

test('Whole-cycle spectrum of a simulated square wave has exact odd harmonics', () => {
  const c = presetCircuit('rc');
  c.parts[0].wave = { kind: 'square', amp: 2.5, offset: 2.5, freq: 200 };
  c.sim = { tstop: 20e-3, dt: 2e-6 };
  const lab = computeLab(c);
  const th = lab.chans.ch2.thd; // CH2 probes the source node
  assert.ok(lab.chans.ch2.spectrum.coherent);
  assert.ok(Math.abs(th.harmonics[0].amp - 10 / Math.PI) < 1e-3, `H1 ${th.harmonics[0].amp}`);
  assert.ok(Math.abs(th.harmonics[2].amp - 10 / (3 * Math.PI)) < 1e-3);
  assert.ok(th.harmonics[1].amp < 1e-6, 'even harmonics vanish');
  const expect = 100 * Math.sqrt([3, 5, 7, 9].reduce((a, k) => a + 1 / (k * k), 0));
  assert.ok(Math.abs(th.percent - expect) < 0.05, `THD ${th.percent} vs ${expect}`);
  // The clean inverting amplifier output is a near-perfect sine.
  const inv = computeLab(presetCircuit('inv'));
  assert.ok(inv.chans.ch1.thd.percent < 0.01, `inverting THD ${inv.chans.ch1.thd.percent}`);
  console.log(`  [fft] square THD (H2..H10) ${th.percent.toFixed(3)}% vs ${expect.toFixed(3)}% theory; inverting amp THD ${inv.chans.ch1.thd.percent.toExponential(2)}%`);
});

test('Chirp phase is integrated, so the instantaneous frequency sweeps f1 to f2', () => {
  const w = normalizeWave({ kind: 'chirp', amp: 1, freq: 100, f2: 1100, sweep: 0.1 });
  const dt = 1e-6;
  const fAt = (t) => {
    const h = 2e-6;
    // Phase slope from the waveform itself via zero crossings near t.
    let crossings = [];
    for (let s = t - 0.004; s < t + 0.004; s += dt) {
      const a = waveValue(w, s);
      const b = waveValue(w, s + dt);
      if (a < 0 && b >= 0) crossings.push(s + (dt * -a) / (b - a));
    }
    return (crossings.length - 1) / (crossings[crossings.length - 1] - crossings[0]) + 0 * h;
  };
  assert.ok(Math.abs(fAt(0.05) - chirpFreqAt(w, 0.05)) / 600 < 0.01);
  assert.ok(Math.abs(fAt(0.09) - chirpFreqAt(w, 0.09)) / 1000 < 0.01);
});

test('Share links: every preset round-trips in under 1024 bytes, and bad links are rejected', () => {
  for (const p of PRESETS) {
    const c = presetCircuit(p.id);
    const code = encodeLab(c);
    const url = `https://aariv.me/benchzero/#lab=${code}`;
    assert.ok(`#lab=${code}`.length < 1024, `${p.id} hash is ${code.length} bytes`);
    assert.equal(encodeLab(c), code, 'deterministic');
    const d = decodeLab(code);
    assert.ok(d.ok, d.error);
    assert.equal(encodeLab(d.circuit), code, 'round-trip is stable');
    assert.deepEqual(d.circuit.parts.map((q) => q.id), c.parts.map((q) => q.id));
    const back = labFromHash(new URL(url).hash);
    assert.ok(back && back.ok);
    console.log(`  [link] ${p.id}: #lab= hash ${code.length + 5} bytes`);
  }
  for (const bad of ['', '!!!', 'abc', encodeLab(presetCircuit('rc')).slice(0, 40), btoa('{"v":1}'), 'x'.repeat(5000)]) {
    const r = decodeLab(bad);
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, 'string');
  }
  const evil = presetCircuit('rc');
  evil.parts[1].type = 'Q';
  assert.equal(decodeLab(encodeLab({ ...presetCircuit('rc'), parts: [...presetCircuit('rc').parts] })).ok, true);
  const tampered = JSON.parse(atob(encodeLab(presetCircuit('rc')).replace(/-/g, '+').replace(/_/g, '/')));
  tampered.p[1][3] = -5;
  const code = btoa(JSON.stringify(tampered)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(decodeLab(code).ok, false);
});

test('Floating nodes, missing ground and source loops give structured errors, never NaN', () => {
  const floating = {
    parts: [
      { id: 'V1', type: 'V', nodes: ['in', '0'], wave: { kind: 'dc', offset: 5 } },
      { id: 'R1', type: 'R', nodes: ['in', '0'], value: 100 },
      { id: 'R2', type: 'R', nodes: ['x', 'y'], value: 100 },
    ],
  };
  const r = transient(floating, { tstop: 1e-3, dt: 1e-5 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'FLOATING_NODE');
  assert.deepEqual(r.error.nodes, ['x', 'y']);
  const lab = computeLab({ ...floating, sim: { tstop: 1e-3, dt: 1e-5 } });
  assert.equal(lab.ok, false);
  assertAllFinite(lab, 'floating-node result');
  // Op-amp input that only touches the op-amp is floating too.
  const opfloat = {
    parts: [
      { id: 'R1', type: 'R', nodes: ['out', '0'], value: 1000 },
      { id: 'U1', type: 'OPAMP', nodes: ['p', 'm', 'out'] },
      { id: 'R2', type: 'R', nodes: ['m', '0'], value: 1000 },
    ],
  };
  assert.equal(dcOperatingPoint(opfloat).error.code, 'FLOATING_NODE');
  const noGround = { parts: [{ id: 'R1', type: 'R', nodes: ['a', 'b'], value: 1 }, { id: 'R2', type: 'R', nodes: ['a', 'b'], value: 1 }] };
  assert.equal(dcOperatingPoint(noGround).error.code, 'NO_GROUND');
  const loop = {
    parts: [
      { id: 'V1', type: 'V', nodes: ['a', '0'], wave: { kind: 'dc', offset: 5 } },
      { id: 'V2', type: 'V', nodes: ['a', '0'], wave: { kind: 'dc', offset: 3 } },
      { id: 'R1', type: 'R', nodes: ['a', '0'], value: 1 },
    ],
  };
  const lr = dcOperatingPoint(loop);
  assert.equal(lr.ok, false);
  assert.equal(lr.error.code, 'SINGULAR_MATRIX');
  assert.equal(dcOperatingPoint({ parts: [{ id: 'R1', type: 'R', nodes: ['a', '0'], value: -5 }] }).error.code, 'BAD_VALUE');
  // A node reached only through a capacitor is tied by 1 G-ohm, so it still solves.
  const series = {
    parts: [
      { id: 'V1', type: 'V', nodes: ['in', '0'], wave: { kind: 'step', amp: 1 } },
      { id: 'C1', type: 'C', nodes: ['in', 'mid'], value: 1e-6 },
      { id: 'C2', type: 'C', nodes: ['mid', '0'], value: 1e-6 },
    ],
  };
  const sr = transient(series, { tstop: 1e-3, dt: 1e-5 });
  assert.ok(sr.ok && allFinite(sr));
  assert.ok(Math.abs(sr.nodes.mid[1] - 0.5) < 1e-3, 'capacitive divider splits the step');
});

test('Every guided lab runs, verifies and reports finite numbers', () => {
  for (const p of PRESETS) {
    const c = presetCircuit(p.id);
    const lab = computeLab(c);
    assert.ok(lab.ok, `${p.id}: ${lab.error && lab.error.message}`);
    assert.ok(allFinite(lab.tran));
    assert.ok(lab.verify.ok, lab.verify.reason);
    for (const ch of lab.verify.checks) assert.ok(ch.pass, `${p.id} ${ch.name}: expected ${ch.expected}, got ${ch.measured}`);
    if (lab.verify.exact) assert.ok(lab.verify.rmsePct < 0.5, `${p.id} rmse ${lab.verify.rmsePct}%`);
    note(`Preset ${p.key} ${p.title}`, lab.verify);
    console.log(`  [time] ${p.id}: ${lab.tran.stats.steps} steps, total compute ${lab.timing.total.toFixed(1)} ms`);
  }
});

test('Every challenge can be solved, and solving it never turns a verify check red', () => {
  const set = (c, id, patch) => Object.assign(c.parts.find((p) => p.id === id), patch);
  const fc = 1 / (2 * Math.PI * 1000 * 1e-6);
  const solved = {
    rc: [
      (c) => set(c, 'R1', { value: 1 / (2 * Math.PI * 1000 * 1e-6) }),
      (c) => { set(c, 'V1', { wave: { kind: 'sine', amp: 1, offset: 0, freq: fc } }); c.sim = { tstop: 6 / fc, dt: 6 / fc / 2000 }; },
      () => {},
    ],
    rlc: [
      (c) => set(c, 'R1', { value: 5 }),
      (c) => set(c, 'R1', { value: 200 }),
      (c) => set(c, 'L1', { value: 1 / ((2 * Math.PI * 1000) ** 2 * 1e-6) }),
    ],
    rect: [
      (c) => set(c, 'C1', { value: 470e-6 }),
      (c) => set(c, 'D1', { model: 'led' }),
      (c) => set(c, 'C1', { value: 1e-6 }),
    ],
    inv: [
      (c) => set(c, 'R2', { value: 22000 }),
      (c) => set(c, 'V1', { wave: { kind: 'sine', amp: 2, offset: 0, freq: 1000 } }),
      () => {},
    ],
    div: [
      (c) => set(c, 'R2', { value: 1 / (1 / ((3.3 * 10000) / 6.7) - 1 / 1e6) }),
      (c) => set(c, 'RL', { value: 1000 }),
      (c) => { set(c, 'R1', { value: 100 }); set(c, 'R2', { value: 100 }); set(c, 'RL', { value: 1000 }); },
    ],
  };
  for (const p of PRESETS) {
    p.challenges.forEach((ch, i) => {
      const c = presetCircuit(p.id);
      solved[p.id][i](c);
      const lab = computeLab(c);
      assert.ok(lab.ok, `${p.id} challenge ${i + 1}: ${lab.error && lab.error.message}`);
      assertAllFinite(lab.verify, `${p.id} challenge ${i + 1} verify`);
      const ctx = { circuit: c, parts: Object.fromEntries(c.parts.map((q) => [q.id, q])), result: lab };
      assert.ok(ch.test(ctx), `${p.id} challenge ${i + 1} should pass in its solved state`);
      assert.ok(lab.verify.ok, `${p.id} challenge ${i + 1}: ${lab.verify.reason}`);
      for (const k of lab.verify.checks) assert.ok(k.pass, `${p.id} challenge ${i + 1} check "${k.name}": expected ${k.expected}, got ${k.measured}`);
    });
  }
});
