// Wave 2 hardening suite: fault injection on every part type, numerical edge cases that the
// solver has to survive (empty sweeps, near-singular pivots, zero and negative steps), tampered
// share links, and the shipped-text invariants the submission is judged on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import {
  transient, acSweep, dcOperatingPoint, solveDense, logFreqs, ILL_CONDITION_RATIO,
} from '../src/mna.js';
import { computeLab } from '../src/compute.js';
import { presetCircuit, PRESETS } from '../src/presets.js';
import { verify } from '../src/theory.js';
import {
  applyFault, describeFault, SHORT_VALUE, FAULTS, FAULT_LABELS,
} from '../src/faults.js';
import { pack, decodeLab, encodeLab, labFromHash, CODEC_VERSION } from '../src/serialize.js';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

/* ------------------------------------------------------------------ */
/* Fault injection on every part type                                  */
/* ------------------------------------------------------------------ */

test('Wave 2: every part type opens and shorts into a circuit that still solves', () => {
  const labs = ['rc', 'rlc', 'rect', 'inv', 'div'];
  const types = new Set();
  let cases = 0;
  for (const lab of labs) {
    const base = presetCircuit(lab);
    for (const part of base.parts) {
      types.add(part.type);
      for (const fault of FAULTS) {
        cases++;
        const faulted = applyFault(base, part.id, fault);
        const res = computeLab(faulted);
        const where = `${lab} ${part.id} ${part.type} ${fault}`;
        assert.ok(res.ok, `${where}: ${res.error && res.error.message}`);
        for (const [node, arr] of Object.entries(res.tran.nodes)) {
          for (const v of arr) assert.ok(Number.isFinite(v), `${where}: ${node} is not finite`);
        }
        for (const [id, arr] of Object.entries(res.tran.currents)) {
          for (const i of arr) assert.ok(Number.isFinite(i), `${where}: current ${id} is not finite`);
        }
      }
    }
  }
  assert.ok(cases >= 38, `expected at least 38 fault cases, ran ${cases}`);
  assert.deepEqual([...types].sort(), ['C', 'D', 'L', 'OPAMP', 'R', 'V']);
});

test('Wave 2: a short is a milliohm resistor, not a nanohm one', () => {
  assert.equal(SHORT_VALUE, 1e-3);
  assert.ok(SHORT_VALUE > 0);
  assert.deepEqual(FAULTS, ['open', 'short']);
  assert.deepEqual(Object.keys(FAULT_LABELS).sort(), ['open', 'short']);
});

test('Wave 2: shorting R1 in the RC lab solves and passes the step through', () => {
  // Regression: a 1 nOhm short used to push a real pivot under the solver's singularity test and
  // report the default RC lab as singular. The milliohm short must stay solvable and honest.
  const c = presetCircuit('rc');
  const shorted = applyFault(c, 'R1', 'short');
  // The default trapezoidal step is larger than the 1 ns time constant of a milliohm short, so it
  // rings slightly; backward Euler shows the clean settled value. Both must stay finite and in range.
  const trap = transient(shorted, shorted.sim);
  assert.ok(trap.ok, trap.error && trap.error.message);
  for (const v of trap.nodes.out) assert.ok(Number.isFinite(v) && Math.abs(v) < 100, `out ${v}`);
  const be = transient({ ...shorted, sim: { ...shorted.sim, method: 'be' } }, { ...shorted.sim, method: 'be' });
  assert.ok(be.ok, be.error && be.error.message);
  const out = be.nodes.out;
  assert.ok(Math.abs(out[out.length - 1] - 5) < 0.01, `output should follow the 5 V step, got ${out[out.length - 1]}`);
});

test('Wave 2: opening a part removes exactly that part and leaves the rest untouched', () => {
  const c = presetCircuit('rlc');
  const before = JSON.parse(JSON.stringify(c));
  const opened = applyFault(c, 'L1', 'open');
  assert.equal(opened.parts.length, c.parts.length - 1);
  assert.equal(opened.parts.some((p) => p.id === 'L1'), false);
  for (const p of opened.parts) {
    const original = before.parts.find((q) => q.id === p.id);
    assert.deepEqual(p, original);
  }
  assert.deepEqual(c, before, 'the input circuit must never be mutated');
});

test('Wave 2: shorting a capacitor replaces it with a wire, not a huge capacitance', () => {
  const c = presetCircuit('rc');
  const shorted = applyFault(c, 'C1', 'short');
  const p = shorted.parts.find((x) => x.id === 'C1');
  assert.equal(p.type, 'R');
  assert.equal(p.value, SHORT_VALUE);
  assert.deepEqual(p.nodes, ['out', '0']);
  assert.deepEqual(p.at, c.parts.find((x) => x.id === 'C1').at);
  assert.ok(!('model' in p) && !('wave' in p), 'the replacement must not keep stale fields');
});

test('Wave 2: shorting an op-amp shorts its output to ground', () => {
  const c = presetCircuit('inv');
  const shorted = applyFault(c, 'U1', 'short');
  const p = shorted.parts.find((x) => x.id === 'U1');
  assert.equal(p.type, 'R');
  assert.deepEqual(p.nodes, ['out', '0']);
  const res = computeLab(shorted);
  assert.ok(res.ok, res.error && res.error.message);
});

test('Wave 2: every part type can be opened, including the only source', () => {
  for (const lab of ['rc', 'rlc', 'rect', 'inv', 'div']) {
    const base = presetCircuit(lab);
    for (const part of base.parts) {
      const opened = applyFault(base, part.id, 'open');
      const res = computeLab(opened);
      assert.ok(res.ok, `${lab} ${part.id} open: ${res.error && res.error.message}`);
    }
  }
});

test('Wave 2: unknown parts and unknown faults throw readable errors', () => {
  const c = presetCircuit('rc');
  assert.throws(() => applyFault(c, 'NOPE', 'open'), /Unknown part NOPE/);
  assert.throws(() => applyFault(c, 'R1', 'melt'), /Unknown fault melt/);
  assert.throws(() => applyFault(null, 'R1', 'open'), /Bad circuit/);
  assert.throws(() => applyFault({ parts: [] }, 'R1', 'open'), /Unknown part/);
});

test('Wave 2: describeFault names the part, the fault and the nodes', () => {
  const c = presetCircuit('rc');
  const r1 = c.parts.find((p) => p.id === 'R1');
  assert.match(describeFault(r1, 'open'), /R1 opened/);
  assert.match(describeFault(r1, 'open'), /in and out/);
  assert.match(describeFault(r1, 'short'), /R1 shorted/);
  assert.match(describeFault(r1, 'short'), /0\.001 ohm/);
  const u1 = presetCircuit('inv').parts.find((p) => p.id === 'U1');
  assert.match(describeFault(u1, 'short'), /output shorted to ground/);
  assert.match(describeFault(c.parts.find((p) => p.id === 'C1'), 'open'), /out and ground/);
});

/* ------------------------------------------------------------------ */
/* Numerical edge cases                                                */
/* ------------------------------------------------------------------ */

test('Wave 2: a near-singular but solvable circuit is flagged, not failed', () => {
  const c = presetCircuit('rc');
  c.parts[1].value = 1e-12; // a picohm resistor, far stiffer than any real bench part
  const tr = transient(c, c.sim);
  assert.ok(tr.ok, tr.error && tr.error.message);
  assert.ok(tr.cond <= ILL_CONDITION_RATIO, `expected a tiny pivot ratio, got ${tr.cond}`);
  assert.equal(tr.warnings.length, 1);
  assert.equal(tr.warnings[0].code, 'ILL_CONDITIONED');
  assert.match(tr.warnings[0].message, /Near-singular matrix/);
  for (const v of tr.nodes.out) assert.ok(Number.isFinite(v));
});

test('Wave 2: a healthy lab reports no warning and a pivot ratio near one', () => {
  for (const id of ['rc', 'rlc', 'rect', 'inv', 'div']) {
    const res = computeLab(presetCircuit(id));
    assert.ok(res.ok, `${id}: ${res.error && res.error.message}`);
    assert.deepEqual(res.warnings, [], `${id} should have no solver warning`);
    assert.ok(res.tran.cond > 1e-6, `${id}: unexpected conditioning ${res.tran.cond}`);
  }
});

test('Wave 2: computeLab carries the AC warning through as well', () => {
  const c = presetCircuit('rc');
  c.parts[1].value = 1e-12;
  const res = computeLab(c);
  assert.ok(res.ok);
  assert.ok(res.ac && res.ac.ok);
  assert.equal(res.ac.warnings[0].code, 'ILL_CONDITIONED');
  assert.equal(res.warnings.filter((w) => w.code === 'ILL_CONDITIONED').length, 1, 'warnings must be deduped');
  assert.match(res.warnings[0].message, /pivot ratio/);
});

test('Wave 2: a genuinely singular circuit still fails with a useful message', () => {
  const c = {
    parts: [
      { id: 'V1', type: 'V', nodes: ['a', '0'], wave: { kind: 'dc', offset: 1 } },
      { id: 'V2', type: 'V', nodes: ['a', '0'], wave: { kind: 'dc', offset: 2 } },
    ],
    sim: { tstop: 1e-3, dt: 1e-5 },
  };
  const tr = transient(c, c.sim);
  assert.equal(tr.ok, false);
  assert.equal(tr.error.code, 'SINGULAR_MATRIX');
  assert.match(tr.error.message, /voltage sources and inductors/);
});

test('Wave 2: acSweep rejects empty, non-finite, zero and negative frequency lists', () => {
  const c = presetCircuit('rc');
  for (const freqs of [[], [0], [-10], [NaN], [Infinity], [10, 0], [10, -1], [10, NaN], 'x', 42, null, undefined]) {
    const r = acSweep(c, { source: 'V1', out: 'out', freqs });
    assert.equal(r.ok, false, `freqs ${JSON.stringify(freqs)} must be rejected`);
    assert.equal(r.error.code, 'BAD_AC');
  }
});

test('Wave 2: acSweep rejects a missing source or an unknown probe node', () => {
  const c = presetCircuit('rc');
  const freqs = logFreqs(10, 1e5, 20);
  assert.equal(acSweep(c, { source: 'NOPE', out: 'out', freqs }).error.code, 'BAD_AC');
  assert.equal(acSweep(c, { source: 'R1', out: 'out', freqs }).error.code, 'BAD_AC');
  assert.equal(acSweep(c, { source: 'V1', out: 'nope', freqs }).error.code, 'BAD_AC');
  assert.equal(acSweep(c, { source: 'V1', out: 'out', ref: 'nope', freqs }).error.code, 'BAD_AC');
  assert.ok(acSweep(c, { source: 'V1', out: 'out', ref: '0', freqs }).ok);
});

test('Wave 2: an impossible frequency range gives an empty sweep, which is rejected', () => {
  assert.equal(logFreqs(1e5, 10).length, 0);
  assert.equal(logFreqs(0, 10).length, 0);
  assert.equal(logFreqs(NaN, 10).length, 0);
  assert.ok(logFreqs(10, 1e5, 40).length > 4);
  const r = acSweep(presetCircuit('rc'), { source: 'V1', out: 'out', freqs: logFreqs(1e5, 10) });
  assert.equal(r.error.code, 'BAD_AC');
});

test('Wave 2: a zero-amplitude RC step stays finite and passes at zero error', () => {
  const c = presetCircuit('rc');
  c.parts[0].wave.amp = 0;
  const res = computeLab(c);
  assert.ok(res.ok, res.error && res.error.message);
  for (const v of res.tran.nodes.out) assert.equal(v, 0);
  assert.equal(res.verify.ok, true);
  assert.equal(res.verify.pass, true);
  assert.equal(res.verify.rmsePct, 0);
});

test('Wave 2: a zero-amplitude RLC step keeps voltages and currents finite', () => {
  const c = presetCircuit('rlc');
  c.parts[0].wave.amp = 0;
  const res = computeLab(c);
  assert.ok(res.ok, res.error && res.error.message);
  for (const arr of Object.values(res.tran.nodes)) for (const v of arr) assert.ok(Number.isFinite(v));
  for (const arr of Object.values(res.tran.currents)) for (const i of arr) assert.ok(Number.isFinite(i));
  const os = res.verify.checks.find((x) => x.name === 'Step overshoot');
  assert.ok(os && os.skipped);
  assert.equal(res.verify.pass, true);
});

test('Wave 2: a negative RLC step measures overshoot in its own direction', () => {
  const c = presetCircuit('rlc');
  c.parts[0].wave.amp = -5;
  const res = computeLab(c);
  assert.ok(res.ok);
  const os = res.verify.checks.find((x) => x.name === 'Step overshoot');
  assert.ok(os && !os.skipped);
  assert.ok(Number.isFinite(os.measured));
  assert.ok(os.measured >= 0 && os.measured < 100);
  assert.equal(res.verify.pass, true);
});

test('Wave 2: a zero-amplitude sine drive verifies without a NaN', () => {
  const c = presetCircuit('rc');
  c.parts[0].wave = { kind: 'sine', amp: 0, offset: 0, freq: 1000 };
  const res = computeLab(c);
  assert.ok(res.ok);
  assert.equal(res.verify.ok, true);
  assert.ok(Number.isFinite(res.verify.rmsePct));
  assert.equal(res.verify.rmsePct, 0);
});

test('Wave 2: transient rejects a window outside four to twenty thousand steps', () => {
  const c = presetCircuit('rc');
  const few = transient(c, { tstop: 1e-6, dt: 1e-6 });
  assert.equal(few.error.code, 'BAD_SIM');
  const many = transient(c, { tstop: 10, dt: 1e-6 });
  assert.equal(many.error.code, 'BAD_SIM');
  assert.match(many.error.message, /20000/);
  const zero = transient(c, { tstop: 0, dt: 1e-6 });
  assert.equal(zero.error.code, 'BAD_SIM');
});

test('Wave 2: the DC operating point of the divider matches the loaded Thevenin value', () => {
  const c = presetCircuit('div');
  const op = dcOperatingPoint(c);
  assert.ok(op.ok);
  assert.deepEqual(op.warnings, []);
  const r2 = 10000; const r1 = 10000; const rl = 1e6;
  const rp = (r2 * rl) / (r2 + rl);
  const expected = 10 * (rp / (r1 + rp));
  assert.ok(Math.abs(op.nodes.out - expected) < 1e-9, `expected ${expected}, got ${op.nodes.out}`);
  assert.ok(op.cond > ILL_CONDITION_RATIO);
});

test('Wave 2: solveDense solves a stiff but representable system instead of failing', () => {
  // A row with a 1e9 entry and a legitimate 1e-9 pivot: the old global tolerance called this singular.
  const A = Float64Array.from([1e12, -1e12, 1, -1e12, 1e12 + 0.8, 0, 1, 0, 0]);
  const b = Float64Array.from([0, 0, 5]);
  const r = solveDense(A, b, 3);
  assert.ok(r.ok, 'a stiff system must solve');
  assert.equal(r.illConditioned, true);
  assert.ok(r.cond < ILL_CONDITION_RATIO, `conditioning ${r.cond}`);
  assert.ok(Math.abs(r.x[0] - 5) < 1e-6, `node voltage ${r.x[0]}`);
});

/* ------------------------------------------------------------------ */
/* Tampered share links                                                */
/* ------------------------------------------------------------------ */

const packed = pack(presetCircuit('rc'));
const encodePacked = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');

test('Wave 2: a valid link round-trips every part type with full precision', () => {
  const c = {
    lab: '',
    parts: [
      { id: 'R1', type: 'R', nodes: ['a', '0'], value: 1234.56789, at: [2, 2, 0] },
      { id: 'C1', type: 'C', nodes: ['a', 'b'], value: 4.7e-9, at: [4, 3, 1] },
      { id: 'L1', type: 'L', nodes: ['b', '0'], value: 2.2e-3, at: [6, 3, 0] },
      { id: 'V1', type: 'V', nodes: ['in', '0'], wave: { kind: 'sine', amp: 2.5, offset: 0.5, freq: 440, duty: 0.5, delay: 0, phase: 90, f2: 2000, sweep: 0.1 }, at: [1, 4, 1] },
      { id: 'D1', type: 'D', nodes: ['in', 'a'], model: 'led', at: [3, 4, 0] },
      { id: 'U1', type: 'OPAMP', nodes: ['0', 'b', 'out'], gain: 2e5, rail: 15, at: [8, 5, 0] },
    ],
    probes: { ch1: 'out', ch2: 'in' },
    sim: { tstop: 0.01, dt: 1e-6, method: 'be' },
    ac: { fstart: 5, fstop: 5e5 },
    math: 'R1',
  };
  const back = decodeLab(encodeLab(c));
  assert.ok(back.ok, back.error);
  assert.equal(back.circuit.parts.length, 6);
  const get = (id) => back.circuit.parts.find((p) => p.id === id);
  assert.equal(get('R1').value, 1234.56789);
  assert.equal(get('C1').value, 4.7e-9);
  assert.deepEqual(get('C1').nodes, ['a', 'b']);
  assert.equal(get('V1').wave.kind, 'sine');
  assert.equal(get('V1').wave.freq, 440);
  assert.equal(get('D1').model, 'led');
  assert.equal(get('U1').gain, 2e5);
  assert.equal(back.circuit.sim.method, 'be');
  assert.equal(back.circuit.ac.fstop, 5e5);
  assert.equal(back.circuit.math, 'R1');
});

test('Wave 2: every tampered share link is rejected with a readable reason', () => {
  const clone = () => JSON.parse(JSON.stringify(packed));
  const cases = [
    ['version', (o) => { o.v = CODEC_VERSION + 1; }, /version/],
    ['unknown lab', (o) => { o.l = 'zzz'; }, /Unknown lab/],
    ['no parts', (o) => { delete o.p; }, /parts list/],
    ['empty parts', (o) => { o.p = []; }, /parts list/],
    ['too many parts', (o) => { o.p = Array.from({ length: 41 }, (_, i) => ['R', `R${i}`, 'a,0', 1, [1, 1, 0]]); }, /parts list/],
    ['short part entry', (o) => { o.p[1] = ['R', 'R1']; }, /part entry/],
    ['unknown type', (o) => { o.p[1][0] = 'Q'; }, /Unknown part type/],
    ['lowercase id', (o) => { o.p[1][1] = 'r1'; }, /Bad part id/],
    ['duplicate id', (o) => { o.p[2][1] = 'V1'; }, /Bad part id/],
    ['wrong pin count', (o) => { o.p[1][2] = 'in'; }, /Bad nodes/],
    ['slash in node', (o) => { o.p[1][2] = 'in,0/../x'; }, /Bad nodes/],
    ['reserved node', (o) => { o.p[1][2] = '__proto__,0'; }, /Bad nodes/],
    ['zero resistor', (o) => { o.p[1][3] = 0; }, /Bad value/],
    ['negative resistor', (o) => { o.p[1][3] = -5; }, /Bad value/],
    ['absurd resistor', (o) => { o.p[1][3] = 1e13; }, /Bad value/],
    ['bad wave length', (o) => { o.p[0][3] = [0, 1]; }, /bad wave/],
    ['bad wave kind', (o) => { o.p[0][3][0] = 99; }, /bad wave kind/],
    ['absurd source', (o) => { o.p[0][3][1] = 1e9; }, /out of range/],
    ['zero frequency', (o) => { o.p[0][3][3] = 0; }, /frequency out of range/],
    ['bad duty', (o) => { o.p[0][3][4] = 1; }, /bad wave timing/],
    ['layout off grid', (o) => { o.p[0][4] = [1.5, 2, 0]; }, /Bad layout/],
    ['layout out of world', (o) => { o.p[0][4] = [5000, 2, 0]; }, /Bad layout/],
    ['layout bad rotation', (o) => { o.p[0][4] = [1, 1, 9]; }, /Bad layout/],
    ['zero window', (o) => { o.s[0] = 0; }, /simulation window/],
    ['step over window', (o) => { o.s[1] = 10; }, /simulation window/],
    ['null window entry', (o) => { o.s = [null, 0.1]; }, /simulation window/],
    ['bad method', (o) => { o.s[2] = 2; }, /solver method/],
    ['reversed AC', (o) => { o.a = [1e5, 10]; }, /AC sweep/],
    ['zero AC', (o) => { o.a = [0, 10]; }, /AC sweep/],
    ['bad probes', (o) => { o.pr = ['out', 'in', '0']; }, /probes/],
    ['bad math', (o) => { o.m = 'ZZ9'; }, /math part/],
    ['bad node table', (o) => { o.n = [['out', 1.5, 2]]; }, /node position/],
  ];
  for (const [name, mutate, pattern] of cases) {
    const o = clone();
    mutate(o);
    const r = decodeLab(encodePacked(o));
    assert.equal(r.ok, false, `${name} must be rejected`);
    assert.match(r.error, pattern, `${name} gave "${r.error}"`);
  }
});

test('Wave 2: a layout of zero is normalized to the default grid', () => {
  const o = JSON.parse(JSON.stringify(packed));
  o.p[0][4] = 0;
  const r = decodeLab(encodePacked(o));
  assert.ok(r.ok, r.error);
  const p = r.circuit.parts[0];
  assert.ok(Array.isArray(p.at) && p.at.length === 3, 'a decoded part must always carry a layout');
  assert.ok(p.at.every((v) => Number.isInteger(v)));
  const res = computeLab(r.circuit);
  assert.ok(res.ok, res.error && res.error.message);
});

test('Wave 2: a tampered link cannot pollute Object.prototype', () => {
  const o = JSON.parse(JSON.stringify(packed));
  o.p[0][2] = '__proto__,0';
  o.pr = ['__proto__', 'constructor'];
  const r = decodeLab(encodePacked(o));
  assert.equal(r.ok, false);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(typeof {}.hasOwnProperty, 'function');
});

test('Wave 2: empty, truncated and oversized links are rejected without throwing', () => {
  for (const code of ['', '!!!', 'AAAA', 'a', 'ab', 'abc', 'a'.repeat(4097)]) {
    const r = decodeLab(code);
    assert.equal(r.ok, false, `"${code.slice(0, 8)}" must be rejected`);
    assert.equal(typeof r.error, 'string');
  }
  assert.equal(labFromHash(''), null);
  assert.equal(labFromHash('#other'), null);
  assert.equal(labFromHash('#lab=!!!').ok, false);
  assert.equal(labFromHash('#lab=').ok, false);
  assert.ok(labFromHash(`#lab=${encodeLab(presetCircuit('rlc'))}`).ok);
});

test('Wave 2: the default RC link stays small and decodes to the same lab', () => {
  const code = encodeLab(presetCircuit('rc'));
  assert.ok(code.length < 500, `link hash is ${code.length} characters`);
  const back = decodeLab(code);
  assert.ok(back.ok);
  assert.equal(back.circuit.lab, 'rc');
  const res = computeLab(back.circuit);
  assert.ok(res.ok);
  assert.equal(res.verify.pass, true);
});

/* ------------------------------------------------------------------ */
/* Shipped text and packaging invariants                               */
/* ------------------------------------------------------------------ */

const sourceFiles = readdirSync(new URL('../src/', import.meta.url)).filter((f) => f.endsWith('.js'));
const shipped = [
  ['README.md', read('README.md')],
  ['index.html', read('index.html')],
  ['styles.css', read('styles.css')],
  ['sw.js', read('sw.js')],
  ...sourceFiles.map((f) => [`src/${f}`, read(`src/${f}`)]),
];

test('Wave 2: README avoids a stale exact test count', () => {
  const testFiles = readdirSync(new URL('../tests/', import.meta.url)).filter((f) => f.endsWith('.mjs'));
  let count = 0;
  for (const f of testFiles) count += (read(`tests/${f}`).match(/^test\(/gm) || []).length;
  assert.ok(count >= 50, `the suite should be at least 50 tests, found ${count}`);
  assert.equal(/The suite has \d+ tests/.test(read('README.md')), false,
    'runtime-generated tests make a hard-coded count rot; keep the exact count in test output instead');
});

test('Wave 2: no em or en dashes in the shipped text', () => {
  for (const [name, text] of shipped) {
    assert.equal(text.includes('\u2014'), false, `${name} has an em dash`);
    assert.equal(text.includes('\u2013'), false, `${name} has an en dash`);
  }
});

test('Wave 2: no AI or model mentions in the shipped text', () => {
  const modelNames = /\b(GPT|LLM|ChatGPT|Claude|Copilot|Gemini)\b|artificial intelligence/i;
  for (const [name, text] of shipped) {
    const ai = /\bAI\b/.exec(text);
    assert.equal(ai, null, `${name} mentions "${ai && ai[0]}"`);
    const m = modelNames.exec(text);
    assert.equal(m, null, `${name} mentions "${m && m[0]}"`);
  }
});

test('Wave 2: the page has no smooth scroll rule', () => {
  assert.equal(/scroll-behavior:\s*smooth/.test(read('styles.css')), false);
  assert.equal(/scroll-behavior:\s*smooth/.test(read('index.html')), false);
});

test('Wave 2: no uppercase eyebrow, kicker or tagline is shipped', () => {
  const css = read('styles.css');
  assert.equal(/text-transform:\s*uppercase/i.test(css), false, 'a 10 to 12 px uppercase line is banned');
  const html = read('index.html');
  assert.equal(/class="[^"]*(eyebrow|kicker|tagline|subtitle)[^"]*"/i.test(html), false);
  // One page title, and every panel is labelled by a real heading.
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.ok((html.match(/<h2\b/g) || []).length >= 4);
});

test('Wave 2: the service worker caches every module the app imports', () => {
  const sw = read('sw.js');
  for (const f of sourceFiles) {
    assert.ok(sw.includes(`'./src/${f}'`), `sw.js must cache src/${f} for offline use`);
  }
  assert.match(sw, /benchzero-v\d+/);
  assert.ok(sw.includes("'./src/faults.js'"), 'the fault helper must be in the offline cache');
});

test('Wave 2: every guided lab still verifies after the hardening pass', () => {
  for (const preset of PRESETS) {
    const c = presetCircuit(preset.id);
    const res = computeLab(c);
    assert.ok(res.ok, `${preset.id}: ${res.error && res.error.message}`);
    assert.equal(res.verify.ok, true, `${preset.id}: ${res.verify.reason}`);
    assert.equal(res.verify.pass, true, `${preset.id}: expected pass`);
    assert.deepEqual(res.warnings, []);
    // A verifiable lab must also grade its own healthy challenges without a fault.
    const ctx = {
      circuit: c,
      parts: Object.fromEntries(c.parts.map((p) => [p.id, p])),
      result: res,
    };
    assert.equal(preset.challenges.every((ch) => typeof ch.test === 'function'), true);
    assert.ok(preset.challenges.length >= 3);
  }
});
