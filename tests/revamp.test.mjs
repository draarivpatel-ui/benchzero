import { test } from 'node:test';
import assert from 'node:assert/strict';

import { solveDense } from '../src/mna.js';
import { acSweep, transient, dcOperatingPoint } from '../src/mna.js';
import { verify } from '../src/theory.js';
import { computeLab } from '../src/compute.js';
import { presetCircuit } from '../src/presets.js';
import { applyFault, FAULTS, SHORT_VALUE } from '../src/faults.js';

test('Wave 1: verify reports an explicit pass for every guided lab', () => {
  for (const id of ['rc', 'rlc', 'rect', 'inv', 'div']) {
    const c = presetCircuit(id);
    const lab = computeLab(c);
    assert.ok(lab.ok, `${id}: ${lab.error && lab.error.message}`);
    assert.ok(lab.verify.ok, `${id}: ${lab.verify.reason}`);
    assert.equal(typeof lab.verify.pass, 'boolean', `${id}: pass must be boolean`);
    assert.equal(lab.verify.pass, true, `${id}: expected pass, got rmse ${lab.verify.rmsePct}%`);
  }
});

test('Wave 1: acSweep rejects an empty frequency list', () => {
  const c = presetCircuit('rc');
  const r = acSweep(c, { source: 'V1', out: 'out', freqs: [] });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'BAD_AC');
});

test('Wave 1: solveDense reports ill-conditioning for a near-singular matrix', () => {
  const A = Float64Array.from([1, 1, 1, 1 + 1e-12]);
  const b = Float64Array.from([2, 2 + 1e-12]);
  const r = solveDense(A, b, 2);
  // Either singular or flagged ill-conditioned; never silently ok without the flag.
  if (r.ok) assert.equal(r.illConditioned, true, 'near-singular solve must be flagged');
  else assert.ok(['SINGULAR_MATRIX'].includes(r.error && r.error.code) || r.row !== undefined);
});

test('Wave 1: solveDense is well-conditioned for a healthy matrix', () => {
  const A = Float64Array.from([2, 1, 1, 3]);
  const b = Float64Array.from([5, 10]);
  const r = solveDense(A, b, 2);
  assert.ok(r.ok);
  assert.equal(r.illConditioned, false);
});

test('Wave 1: fault helper opens and shorts a part without mutating the original', () => {
  const c = presetCircuit('rc');
  const before = c.parts.length;
  const opened = applyFault(c, 'C1', 'open');
  assert.equal(opened.parts.length, before - 1);
  assert.equal(c.parts.length, before, 'original must be unchanged');
  const shorted = applyFault(c, 'R1', 'short');
  const r = shorted.parts.find((p) => p.id === 'R1');
  assert.ok(r, 'shorted part must remain');
  assert.equal(r.type, 'R');
  assert.equal(r.value, SHORT_VALUE, 'a short must be the milliohm value the solver can solve');
  assert.throws(() => applyFault(c, 'NOPE', 'open'));
  assert.throws(() => applyFault(c, 'R1', 'bogus'));
  assert.deepEqual(FAULTS, ['open', 'short']);
});

test('Wave 1: fault injection produces a solvable circuit', () => {
  const c = presetCircuit('rc');
  const opened = applyFault(c, 'C1', 'open');
  // Removing C leaves in still connected to out through R; out is now a dangling-ish node but R connects in-out, out has no ground path? Actually out only via R to in, in via V to ground -> connected. Should solve.
  const tr = transient(opened, opened.sim);
  assert.ok(tr.ok, tr.error && tr.error.message);
  for (const arr of Object.values(tr.nodes)) for (const v of arr) assert.ok(Number.isFinite(v));
  const shorted = applyFault(c, 'R1', 'short');
  const tr2 = transient(shorted, shorted.sim);
  assert.ok(tr2.ok, tr2.error && tr2.error.message);
  for (const arr of Object.values(tr2.nodes)) for (const v of arr) assert.ok(Number.isFinite(v));
});

test('Wave 1: backward Euler transient solves the RC lab', () => {
  const c = presetCircuit('rc');
  c.sim.method = 'be';
  const tr = transient(c, c.sim);
  assert.ok(tr.ok, tr.error && tr.error.message);
  const v = verify(c, tr, null);
  assert.ok(v.ok, v.reason);
  assert.ok(v.rmsePct < 1, `BE rmse ${v.rmsePct}%`);
});

test('Wave 1: zero-amplitude RLC step does not produce NaN overshoot', () => {
  const c = presetCircuit('rlc');
  c.parts[0].wave = { ...c.parts[0].wave, amp: 0 };
  const lab = computeLab(c);
  assert.ok(lab.ok, lab.error && lab.error.message);
  const os = lab.verify.checks.find((x) => x.name === 'Step overshoot');
  assert.ok(os, 'overshoot check must exist');
  assert.ok(os.skipped, 'zero step overshoot must be skipped');
  assert.equal(os.note, 'N/A (zero step)');
});

test('Wave 1: DC operating point rejects a missing ground', () => {
  const c = { parts: [{ id: 'R1', type: 'R', nodes: ['a', 'b'], value: 100 }] };
  const r = dcOperatingPoint(c);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'NO_GROUND');
});

test('Wave 1: fault on a voltage source replaces it with a resistor', () => {
  const c = presetCircuit('rc');
  const f = applyFault(c, 'V1', 'short');
  const p = f.parts.find((x) => x.id === 'V1');
  assert.equal(p.type, 'R');
  assert.equal(p.value, SHORT_VALUE);
});

test('Wave 1: verify.pass is false when RMSE is huge', () => {
  // Grade the healthy RC trace against a circuit whose theory is 1000x slower: real, huge RMSE.
  const c = presetCircuit('rc');
  const lab = computeLab(c);
  assert.equal(lab.verify.pass, true);
  assert.ok(Number.isFinite(lab.verify.rmsePct));
  const wrong = presetCircuit('rc');
  wrong.parts[1].value = 1e6;
  const v = verify(wrong, lab.tran, lab.ac);
  assert.ok(v.ok);
  assert.ok(v.rmsePct > 10, `expected a huge RMSE, got ${v.rmsePct}`);
  assert.equal(v.pass, false);
});

test('Wave 1: a genuinely singular matrix is reported, never solved silently', () => {
  const A = Float64Array.from([4, 2, 2, 1]);
  const b = Float64Array.from([1, 1]);
  const r = solveDense(A, b, 2);
  assert.equal(r.ok, false);
  assert.equal(r.illConditioned, true);
  assert.equal(typeof r.row, 'number');
});
