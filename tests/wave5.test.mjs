// Wave 5 suite: regressions for the hostile review findings — verify() applicability guards,
// coherent-spectrum Nyquist cap, source aliasing warning, and the codec window-ratio bound.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeLab } from '../src/compute.js';
import { presetCircuit } from '../src/presets.js';
import { verify } from '../src/theory.js';
import { transient } from '../src/mna.js';
import { pack, decodeLab } from '../src/serialize.js';

function rcWith(tauR, tauC) {
  const c = presetCircuit('rc');
  c.parts.find((p) => p.id === 'R1').value = tauR;
  c.parts.find((p) => p.id === 'C1').value = tauC;
  return c;
}

/* Findings 1+2: an unevaluable check must be skipped, not failed. */

test('Wave 5: RC tau below step resolution skips the 63.2% check instead of false-failing', () => {
  // tau = 1 ns, dt = 2.5 us -> x ~ 4e-4. BE integrates this stiff RC essentially exactly.
  const c = rcWith(1, 1e-9);
  c.sim = { ...c.sim, method: 'be' };
  const tran = transient(c, c.sim);
  assert.ok(tran.ok, tran.error && tran.error.code);
  const r = verify(c, tran, null);
  assert.ok(r.ok, r.reason);
  const chk = r.checks.find((k) => k.name.includes('63.2%'));
  assert.ok(chk && chk.skipped, `expected a skipped check, got ${JSON.stringify(chk)}`);
  assert.match(chk.note, /resolution/);
  assert.ok(r.pass, 'a correct BE result must not be failed by an unmeasurable check');
});

test('Wave 5: theory fc outside the AC sweep skips the cutoff check', () => {
  const c = rcWith(1, 1e-9); // fc ~ 159 MHz, far above the preset sweep
  c.sim = { ...c.sim, method: 'be' }; // BE stays accurate on this stiff RC; trap legitimately fails rmse
  const r = computeLab(c);
  assert.ok(r.ok, r.error && r.error.code);
  assert.ok(r.verify.ok, r.verify.reason);
  const chk = r.verify.checks.find((k) => k.name.includes('Cutoff'));
  if (chk) {
    assert.ok(chk.skipped, `expected skip, got ${JSON.stringify(chk)}`);
    assert.match(chk.note, /outside sweep/);
  }
  assert.ok(r.verify.pass, 'verify.pass must ignore unevaluable checks');
});

test('Wave 5: resolved RC still measures the 63.2% point (guard did not over-skip)', () => {
  const c = presetCircuit('rc'); // default tau is far above dt
  c.sim = { ...c.sim, method: 'be' };
  const tran = transient(c, c.sim);
  const r = verify(c, tran, null);
  assert.ok(r.ok, r.reason);
  const chk = r.checks.find((k) => k.name.includes('63.2%'));
  assert.ok(chk && !chk.skipped, 'the check must still run when tau is resolved');
  assert.ok(chk.pass, `resolved RC check failed: measured ${chk.measured} vs ${chk.expected}`);
});

/* Finding 3: overshoot check must respect step delay and ring completion. */

test('Wave 5: a step that never fires inside the window skips overshoot', () => {
  const c = presetCircuit('rlc');
  const v = c.parts.find((p) => p.type === 'V');
  v.wave = { ...v.wave, kind: 'step', delay: 1 }; // fires at 1 s, tstop ~ ms
  const tran = transient(c, c.sim);
  assert.ok(tran.ok);
  const r = verify(c, tran, null);
  assert.ok(r.ok, r.reason);
  const chk = r.checks.find((k) => k.name.includes('overshoot'));
  assert.ok(chk && chk.skipped, `expected skip, got ${JSON.stringify(chk)}`);
  assert.ok(r.pass);
});

test('Wave 5: a ring whose peak falls after tstop also skips overshoot', () => {
  const c = presetCircuit('rlc');
  const v = c.parts.find((p) => p.type === 'V');
  v.wave = { ...v.wave, kind: 'step', delay: 0 };
  // Horizon so short the first ring peak never arrives.
  c.sim = { ...c.sim, tstop: 1e-7, dt: 1e-9 };
  const tran = transient(c, c.sim);
  if (tran.ok) {
    const r = verify(c, tran, null);
    assert.ok(r.ok, r.reason);
    const chk = r.checks.find((k) => k.name.includes('overshoot'));
    assert.ok(!chk || chk.skipped, `expected skip/absent, got ${JSON.stringify(chk)}`);
    assert.ok(r.pass);
  }
});

test('Wave 5: a normal underdamped step still measures overshoot', () => {
  const c = presetCircuit('rlc');
  const tran = transient(c, c.sim);
  assert.ok(tran.ok);
  const r = verify(c, tran, null);
  assert.ok(r.ok, r.reason);
  const chk = r.checks.find((k) => k.name.includes('overshoot'));
  assert.ok(chk && !chk.skipped, 'the check must run when the ring fits');
  assert.ok(chk.pass, `overshoot ${chk.measured}% vs ${chk.expected}%`);
});

/* Finding 4: coherent spectra carry the true sample rate so the axis stops at Nyquist. */

test('Wave 5: coherent spectrum payload carries the true fs for the axis cap', () => {
  // Find a lab that actually yields a coherent whole-cycle spectrum.
  let spec = null;
  let tran = null;
  for (const id of ['rc', 'rlc', 'rect', 'opamp', 'div', 0, 1, 2, 3, 4]) {
    try {
      const r = computeLab(presetCircuit(id));
      if (r.ok && r.chans && r.chans.ch1 && r.chans.ch1.spectrum && r.chans.ch1.spectrum.coherent) {
        spec = r.chans.ch1.spectrum;
        tran = r.tran;
        break;
      }
    } catch { /* preset id may not exist */ }
  }
  assert.ok(spec, 'no lab produced a coherent spectrum');
  assert.ok(Math.abs(spec.fs - 1 / tran.dt) < 1, `fs ${spec.fs}`);
  // The resampled grid is longer than real data permits: binHz*N > fs proves the old axis
  // overshot Nyquist, and spec.fs is what the view must cap at.
  assert.ok(spec.binHz * spec.N >= spec.fs);
});

/* Finding 6: source frequency above Nyquist warns instead of silently aliasing. */

test('Wave 5: a source above Nyquist raises SOURCE_ABOVE_NYQUIST', () => {
  const c = presetCircuit('rc');
  const v = c.parts.find((p) => p.type === 'V');
  v.wave = { ...v.wave, kind: 'sine', freq: 120e3 };
  c.sim = { ...c.sim, tstop: 1e-3, dt: 1e-5 }; // fs = 100 kHz, Nyquist 50 kHz
  const r = computeLab(c);
  assert.ok(r.ok, r.error && r.error.code);
  const w = r.warnings.find((x) => x.code === 'SOURCE_ABOVE_NYQUIST');
  assert.ok(w, `no alias warning in ${JSON.stringify(r.warnings)}`);
  assert.match(w.message, /Nyquist/);
});

test('Wave 5: in-band sources raise no alias warning', () => {
  const c = presetCircuit('rc');
  const v = c.parts.find((p) => p.type === 'V');
  v.wave = { ...v.wave, kind: 'sine', freq: 1000 };
  const r = computeLab(c);
  assert.ok(r.ok);
  assert.ok(!r.warnings.some((x) => x.code === 'SOURCE_ABOVE_NYQUIST'));
});

/* Finding 7: the codec rejects a window that can never run. */

test('Wave 5: share link rejects a sim window above the step cap', () => {
  const c = presetCircuit(0);
  const packed = pack(c);
  packed.s = [100, 1e-9]; // 1e11 steps >> MAX_SAMPLES
  const code = Buffer.from(JSON.stringify(packed), 'utf8').toString('base64url');
  const r = decodeLab(code);
  assert.equal(r.ok, false);
  assert.match(r.error, /simulation window/i);
});

test('Wave 5: a window exactly at the step cap still decodes', () => {
  const c = presetCircuit(0);
  const packed = pack(c);
  packed.s = [2, 1e-4]; // exactly 20000 steps
  const code = Buffer.from(JSON.stringify(packed), 'utf8').toString('base64url');
  const r = decodeLab(code);
  assert.ok(r.ok, r.error);
});

/* Finding 5: the split power convention is pinned. */

test('Wave 5: op-amp Math reports delivered power, V source reports absorbed', () => {
  // Lab 4 is the op-amp driver; lab 0 has a plain V source delivering power.
  const op = presetCircuit(3);
  op.math = op.parts.find((p) => p.type === 'OPAMP').id;
  const rop = computeLab(op);
  assert.ok(rop.ok && rop.math, 'op-amp math trace missing');
  assert.equal(rop.math.type, 'OPAMP');
  const vsrc = presetCircuit(0);
  vsrc.math = 'V1';
  const rv = computeLab(vsrc);
  assert.ok(rv.ok && rv.math);
  assert.equal(rv.math.type, 'V');
});
