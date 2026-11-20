import { test } from 'node:test';
import assert from 'node:assert/strict';

import { transient, dcOperatingPoint, acSweep, logFreqs } from '../src/mna.js';
import { computeLab, refineAC } from '../src/compute.js';
import { presetCircuit } from '../src/presets.js';
import { applyFault, FAULTS } from '../src/faults.js';
import { measure } from '../src/fft.js';
import { minus3dB, verify } from '../src/theory.js';
import { waveValue, normalizeWave } from '../src/waves.js';

const TAU = 2 * Math.PI;
const maxAbs = (a) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const allFinite = (a) => a.every(Number.isFinite);

/* ------------------------------------------------------------------ */
/* Wave 3 defect: op-amp Newton reported NO_CONVERGENCE at a real fixed */
/* point once |vd| grew past ~1e4 V (the u -> u/k round-trip broke the  */
/* absolute 1e-12 off-point test inside setLinFromX).                   */
/* ------------------------------------------------------------------ */

test('Wave 3: op-amp transient survives extreme drive into the rails', () => {
  for (const amp of [1e3, 1e5, 1e6]) {
    const c = presetCircuit('inv');
    c.parts[0].wave = { kind: 'sine', amp, freq: 1000 };
    const r = transient(c, c.sim);
    assert.ok(r.ok, `amp ${amp}: ${r.error && r.error.code}`);
    for (const arr of Object.values(r.nodes)) assert.ok(allFinite(arr), `amp ${amp}: NaN in trace`);
    const mx = maxAbs(r.nodes.out);
    assert.ok(mx <= 12 + 1e-9, `amp ${amp}: output ${mx} V exceeds the rail`);
    assert.ok(mx > 11.5, `amp ${amp}: expected hard saturation, got ${mx} V`);
    assert.ok(r.stats.maxIters < 60, `amp ${amp}: Newton needed ${r.stats.maxIters} iterations`);
  }
});

test('Wave 3: op-amp DC point rails cleanly at huge offsets', () => {
  const c = presetCircuit('inv');
  c.parts[0].wave = { kind: 'dc', offset: 1e6 };
  const r = dcOperatingPoint(c);
  assert.ok(r.ok, r.error && r.error.message);
  assert.equal(r.nodes.out, -12);
});

/* ------------------------------------------------------------------ */
/* Wave 3 defect: the recorded time grid overshot the declared window   */
/* whenever tstop/dt was not an integer (tstop 2 ms, dt 0.3 ms ended    */
/* at 2.1 ms while labels and cursors trusted 2 ms).                    */
/* ------------------------------------------------------------------ */

test('Wave 3: transient grid ends exactly at tstop for a non-integer ratio', () => {
  const c = presetCircuit('rc');
  const r = transient(c, { tstop: 2e-3, dt: 3e-4 });
  assert.ok(r.ok, r.error && r.error.message);
  const last = r.t[r.t.length - 1];
  assert.equal(last, r.tstop, `grid ends at ${last}, declared tstop ${r.tstop}`);
  assert.ok(r.t.every((t) => t <= r.tstop), 'a sample escaped the window');
  assert.ok(Math.abs(r.dt * (r.t.length - 1) - r.tstop) < 1e-18, 'reported dt must tile the window');
});

test('Wave 3: integer tstop/dt still uses the requested step', () => {
  const c = presetCircuit('rc');
  const r = transient(c, { tstop: 6e-3, dt: 3e-6 });
  assert.ok(r.ok);
  assert.equal(r.t.length, 2001);
  assert.equal(r.dt, 3e-6);
  assert.equal(r.t[2000], 6e-3);
});

/* ------------------------------------------------------------------ */
/* Wave 3 defect: refineAC took its -3 dB reference four decades below  */
/* the sweep start, which sits in a high-pass stopband (f3dB = NaN).    */
/* ------------------------------------------------------------------ */

const highPass = () => ({
  lab: '',
  ac: { fstart: 10, fstop: 1e5 },
  probes: { ch1: 'out', ch2: 'in' },
  sim: { tstop: 5e-3, dt: 2.5e-6 },
  parts: [
    { id: 'V1', type: 'V', nodes: ['in', '0'], wave: { kind: 'step', amp: 5 } },
    { id: 'C1', type: 'C', nodes: ['in', 'out'], value: 1e-6 },
    { id: 'R1', type: 'R', nodes: ['out', '0'], value: 1000 },
  ],
});

test('Wave 3: a high-pass reports its -3 dB corner', () => {
  const r = computeLab(highPass());
  assert.ok(r.ok && r.ac && r.ac.ok, 'high-pass computes');
  const fcTheory = 1 / (TAU * 1000 * 1e-6);
  const f3 = r.ac.refined.f3dB;
  assert.ok(Number.isFinite(f3), 'f3dB must exist for a high-pass');
  assert.ok(Math.abs(f3 - fcTheory) / fcTheory < 0.01, `f3dB ${f3} vs ${fcTheory}`);
  assert.ok(r.ac.refined.refDb > -1, `passband reference should sit near 0 dB, got ${r.ac.refined.refDb}`);
});

test('Wave 3: low-pass fc stays on the exact value', () => {
  const c = presetCircuit('rc');
  const r = computeLab(c);
  assert.ok(r.ok);
  const fcTheory = 1 / (TAU * 1000 * 1e-6);
  assert.ok(Math.abs(r.ac.refined.f3dB - fcTheory) / fcTheory < 0.001, `f3dB ${r.ac.refined.f3dB}`);
  assert.ok(Math.abs(r.ac.refined.phaseAtFc + 45) < 0.2, `phase at fc ${r.ac.refined.phaseAtFc}`);
});

test('Wave 3: minus3dB fallback reads a high-pass corner from raw sweep data', () => {
  const hp = highPass();
  const ac = acSweep(hp, { source: 'V1', out: 'out', freqs: logFreqs(10, 1e5, 60) });
  assert.ok(ac.ok);
  const fcTheory = 1 / (TAU * 1000 * 1e-6);
  const f3 = minus3dB(ac);
  assert.ok(Number.isFinite(f3), 'minus3dB must find the high-pass corner');
  assert.ok(Math.abs(f3 - fcTheory) / fcTheory < 0.05, `minus3dB ${f3} vs ${fcTheory}`);
});

test('Wave 3: resonant peak keeps its fpk data while f3dB stays finite', () => {
  const c = presetCircuit('rlc');
  const r = computeLab(c);
  assert.ok(r.ok && r.ac.ok);
  assert.ok(Number.isFinite(r.ac.refined.peakFreq), 'RLC must keep its resonant peak');
  assert.ok(Number.isFinite(r.ac.refined.peakDb) && r.ac.refined.peakDb > 1, 'peak must rise above the ends');
  assert.ok(Number.isFinite(r.ac.refined.f3dB), 'a half-power crossing exists too');
});

/* ------------------------------------------------------------------ */
/* Wave 3 probe: every injected fault must measurably change the run.   */
/* ------------------------------------------------------------------ */

test('Wave 3: no silent faults - every fault changes the recorded response', () => {
  for (const lab of ['rc', 'rlc', 'rect', 'inv', 'div']) {
    const base = presetCircuit(lab);
    const healthy = computeLab(base);
    assert.ok(healthy.ok, `${lab} healthy run`);
    for (const part of base.parts) {
      for (const fault of FAULTS) {
        const f = applyFault(base, part.id, fault);
        const r = computeLab(f);
        if (!r.ok) continue; // a circuit that no longer solves is already loud about it
        let diff = 0;
        for (const nm of Object.keys(healthy.tran.nodes)) {
          const a = healthy.tran.nodes[nm];
          const b = r.tran.nodes[nm];
          if (!b) continue;
          for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
        }
        assert.ok(diff > 1e-6, `${lab}/${part.id}/${fault} changed nothing (max diff ${diff} V)`);
      }
    }
  }
});

test('Wave 3: restoring a fault after an earlier delete keeps the part order', () => {
  // Mirrors faultPart/restoreFault bookkeeping: deleting a part before the faulted one shifts the
  // recorded index. A short restores where its stub sits; an open anchors next to the surviving
  // neighbour recorded at fault time, not at the stale numeric slot.
  const base = presetCircuit('rc'); // parts: V1, R1, C1
  const ids = (c) => c.parts.map((p) => p.id);
  const originalR1 = base.parts.find((p) => p.id === 'R1');

  // Short: stub keeps R1's slot. Delete V1 -> stub at index 0 -> restore splices there.
  let c = applyFault(base, 'R1', 'short');
  c = { ...c, parts: c.parts.filter((p) => p.id !== 'V1') };
  assert.deepStrictEqual(ids(c), ['R1', 'C1']);
  const stubAt = c.parts.findIndex((p) => p.id === 'R1');
  c.parts.splice(stubAt, 1, JSON.parse(JSON.stringify(originalR1)));
  assert.deepStrictEqual(ids(c), ['R1', 'C1'], 'short restores at the stub slot, not the end');

  // Open: no stub. Fault-time neighbours are V1 before and C1 after; deleting V1 must still land
  // R1 immediately before the surviving C1, not appended at the stale index 1.
  c = applyFault(base, 'R1', 'open');
  c = { ...c, parts: c.parts.filter((p) => p.id !== 'V1') };
  assert.deepStrictEqual(ids(c), ['C1']);
  const afterAt = c.parts.findIndex((p) => p.id === 'C1'); // rec.afterId
  c.parts.splice(afterAt >= 0 ? afterAt : c.parts.length, 0, JSON.parse(JSON.stringify(originalR1)));
  assert.deepStrictEqual(ids(c), ['R1', 'C1'], 'open restores before its surviving neighbour');
});

/* ------------------------------------------------------------------ */
/* Wave 3 numeric probes the earlier suite never checked.               */
/* ------------------------------------------------------------------ */

test('Wave 3: RL step response matches v_L = V e^{-t R/L} and i_ss = V/R', () => {
  const c = {
    parts: [
      { id: 'V1', type: 'V', nodes: ['in', '0'], wave: { kind: 'step', amp: 5 } },
      { id: 'R1', type: 'R', nodes: ['in', 'out'], value: 100 },
      { id: 'L1', type: 'L', nodes: ['out', '0'], value: 10e-3 },
    ],
    sim: { tstop: 2e-3, dt: 1e-6 },
  };
  const r = transient(c, c.sim);
  assert.ok(r.ok, r.error && r.error.message);
  const tau = 10e-3 / 100;
  let worst = 0;
  for (let i = 0; i < r.t.length; i++) worst = Math.max(worst, Math.abs(r.nodes.out[i] - 5 * Math.exp(-r.t[i] / tau)));
  assert.ok(worst < 5e-3, `RL envelope error ${worst} V`);
  assert.ok(Math.abs(r.currents.L1[r.t.length - 1] - 0.05) < 1e-4, 'steady state 50 mA');
});

test('Wave 3: KCL holds at the divider node and source current is absorbed-sign', () => {
  const c = presetCircuit('div');
  const r = transient(c, c.sim);
  assert.ok(r.ok);
  let worst = 0;
  let worstSrc = 0;
  for (let i = 0; i < r.t.length; i++) {
    worst = Math.max(worst, Math.abs(r.currents.R1[i] - r.currents.R2[i] - r.currents.RL[i]));
    worstSrc = Math.max(worstSrc, Math.abs(r.currents.V1[i] + r.currents.R1[i]));
  }
  assert.ok(worst < 1e-9, `KCL residual ${worst}`);
  assert.ok(worstSrc < 1e-9, `source current residual ${worstSrc}`);
  assert.ok(r.currents.V1[0] < 0, 'a source delivering current reads negative (absorbed convention)');
});

test('Wave 3: diode survives 100 V forward through 1 ohm and -50 V reverse', () => {
  const mk = (off) => ({
    parts: [
      { id: 'V1', type: 'V', nodes: ['in', '0'], wave: { kind: 'dc', offset: off } },
      { id: 'R1', type: 'R', nodes: ['in', 'out'], value: 1 },
      { id: 'D1', type: 'D', nodes: ['out', '0'] },
    ],
  });
  const f = dcOperatingPoint(mk(100));
  assert.ok(f.ok, f.error && f.error.message);
  assert.ok(f.iters < 60, `Newton took ${f.iters}`);
  assert.ok(f.nodes.out > 0.5 && f.nodes.out < 3, `forward drop ${f.nodes.out}`);
  assert.ok(Math.abs(100 - f.nodes.out - f.currents.D1) < 1e-6, 'KCL through the diode');
  const rv = dcOperatingPoint(mk(-50));
  assert.ok(rv.ok, rv.error && rv.error.message);
  assert.ok(Math.abs(rv.nodes.out + 50) < 1e-6, `reverse sees the full -50 V, got ${rv.nodes.out}`);
  assert.ok(Math.abs(rv.currents.D1) < 1e-6, `reverse leakage ${rv.currents.D1}`);
});

test('Wave 3: extreme resistance ratios solve without false singularities', () => {
  const c = {
    parts: [
      { id: 'V1', type: 'V', nodes: ['in', '0'], wave: { kind: 'dc', offset: 10 } },
      { id: 'R1', type: 'R', nodes: ['in', 'out'], value: 1e-3 },
      { id: 'R2', type: 'R', nodes: ['out', '0'], value: 1e9 },
    ],
  };
  const r = dcOperatingPoint(c);
  assert.ok(r.ok, r.error && r.error.message);
  const expect = 10 * 1e9 / (1e-3 + 1e9);
  assert.ok(Math.abs(r.nodes.out - expect) / expect < 1e-9, `out ${r.nodes.out} vs ${expect}`);
  const tr = transient({ ...c, sim: { tstop: 1e-3, dt: 1e-5 } }, { tstop: 1e-3, dt: 1e-5 });
  assert.ok(tr.ok && allFinite(tr.nodes.out), 'transient over a 1e12:1 ratio stays finite');
  const big = dcOperatingPoint({
    parts: [
      { id: 'V1', type: 'V', nodes: ['in', '0'], wave: { kind: 'dc', offset: 1 } },
      { id: 'R1', type: 'R', nodes: ['in', 'out'], value: 1e12 - 1 },
      { id: 'R2', type: 'R', nodes: ['out', '0'], value: 1 },
    ],
  });
  assert.ok(big.ok, 'the largest share-link resistance solves');
});

test('Wave 3: parallel voltage sources report a clean singular error', () => {
  const c = {
    parts: [
      { id: 'V1', type: 'V', nodes: ['a', '0'], wave: { kind: 'dc', offset: 5 } },
      { id: 'V2', type: 'V', nodes: ['a', '0'], wave: { kind: 'dc', offset: 5 } },
      { id: 'R1', type: 'R', nodes: ['a', '0'], value: 100 },
    ],
  };
  const r = dcOperatingPoint(c);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'SINGULAR_MATRIX');
  assert.match(r.error.message, /V\d/);
});

test('Wave 3: Bode phase stays continuous through a resonance', () => {
  const c = presetCircuit('rlc');
  const ac = acSweep(c, { source: 'V1', out: 'out', freqs: logFreqs(100, 2e4, 60) });
  assert.ok(ac.ok);
  let jump = 0;
  for (let i = 1; i < ac.phase.length; i++) jump = Math.max(jump, Math.abs(ac.phase[i] - ac.phase[i - 1]));
  assert.ok(jump < 180, `phase jumped ${jump} degrees between bins`);
});

test('Wave 3: non-inverting op-amp gives 1 + R2/R1 in time and AC', () => {
  const c = {
    parts: [
      { id: 'V1', type: 'V', nodes: ['in', '0'], wave: { kind: 'sine', amp: 0.5, freq: 1000 } },
      { id: 'R1', type: 'R', nodes: ['inv', '0'], value: 1000 },
      { id: 'R2', type: 'R', nodes: ['inv', 'out'], value: 9000 },
      { id: 'U1', type: 'OPAMP', nodes: ['in', 'inv', 'out'], gain: 1e5, rail: 15 },
    ],
    sim: { tstop: 5e-3, dt: 2e-6 },
  };
  const r = transient(c, c.sim);
  assert.ok(r.ok, r.error && r.error.message);
  assert.ok(Math.abs(maxAbs(r.nodes.out) - 5) < 0.05, `gain of 10 expected, peak ${maxAbs(r.nodes.out)}`);
  const ac = acSweep(c, { source: 'V1', out: 'out', freqs: [1000] });
  assert.ok(ac.ok);
  assert.ok(Math.abs(ac.mag[0] - 20) < 0.01, `AC gain ${ac.mag[0]} dB`);
  assert.ok(Math.abs(ac.phase[0]) < 0.1, `non-inverting phase ${ac.phase[0]}`);
});

test('Wave 3: diode small-signal gain equals the analytic rd divider', () => {
  const c = {
    parts: [
      { id: 'V1', type: 'V', nodes: ['in', '0'], wave: { kind: 'dc', offset: 5 } },
      { id: 'R1', type: 'R', nodes: ['in', 'out'], value: 10000 },
      { id: 'D1', type: 'D', nodes: ['out', '0'] },
    ],
  };
  const op = dcOperatingPoint(c);
  assert.ok(op.ok);
  const rd = 0.02585 / (op.currents.D1 + 1e-14);
  const ac = acSweep(c, { source: 'V1', out: 'out', freqs: [100] });
  assert.ok(ac.ok);
  const expect = 20 * Math.log10(rd / (10000 + rd));
  assert.ok(Math.abs(ac.mag[0] - expect) < 0.5, `gain ${ac.mag[0]} vs ${expect} dB`);
});

test('Wave 3: an undamped LC rings at twice the step without NaN', () => {
  const c = {
    parts: [
      { id: 'V1', type: 'V', nodes: ['in', '0'], wave: { kind: 'step', amp: 1 } },
      { id: 'L1', type: 'L', nodes: ['in', 'a'], value: 1e-3 },
      { id: 'C1', type: 'C', nodes: ['a', '0'], value: 1e-6 },
      { id: 'R1', type: 'R', nodes: ['a', '0'], value: 1e9 },
    ],
    sim: { tstop: 0.02, dt: 1e-5 },
  };
  const r = transient(c, c.sim);
  assert.ok(r.ok && allFinite(r.nodes.a), 'LC tank stays finite');
  const mx = maxAbs(r.nodes.a);
  assert.ok(mx > 1.5 && mx < 2.5, `overshoot ${mx} should be near 2x the 1 V step`);
});

test('Wave 3: measure() reads frequency, duty and RMS off solver output', () => {
  const c = presetCircuit('rc');
  c.parts[0].wave = { kind: 'sine', amp: 2, freq: 997.3 };
  c.sim = { tstop: 20e-3, dt: 2e-6 };
  const r = transient(c, c.sim);
  const m = measure(r.nodes.in, 1 / r.dt, { i0: Math.floor(r.t.length / 2) });
  assert.ok(Math.abs(m.freq - 997.3) / 997.3 < 0.005, `freq ${m.freq}`);
  assert.ok(Math.abs(m.duty - 0.5) < 0.02, `duty ${m.duty}`);
  assert.ok(Math.abs(m.acRms - Math.SQRT2) < 0.01, `acRms ${m.acRms}`);
});

test('Wave 3: extreme duty squares and delayed steps switch on the right side', () => {
  const sq = normalizeWave({ kind: 'square', amp: 1, freq: 100, duty: 0.01 });
  assert.equal(waveValue(sq, 5e-5, 1), 1);
  assert.equal(waveValue(sq, 1e-4, -1), 1);
  assert.equal(waveValue(sq, 1.5e-4, 1), -1);
  const w = normalizeWave({ kind: 'step', amp: 3, offset: 1, delay: 1e-3 });
  assert.equal(waveValue(w, 0.5e-3, 1), 1);
  assert.equal(waveValue(w, 1e-3, -1), 1);
  assert.equal(waveValue(w, 1e-3, 1), 4);
});

test('Wave 3: a skipped check carries its note, never a NaN pair', () => {
  const c = presetCircuit('rlc');
  c.parts[0].wave = { ...c.parts[0].wave, amp: 0 };
  const r = computeLab(c);
  const os = r.verify.checks.find((x) => x.name === 'Step overshoot');
  assert.ok(os && os.skipped, 'zero-step overshoot must be a skipped check');
  assert.equal(os.note, 'N/A (zero step)');
  assert.ok(!Number.isFinite(os.expected) && !Number.isFinite(os.measured), 'skipped checks stay NaN internally');
});
