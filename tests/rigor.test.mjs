// Rigor engine tests: seeded RNG, normal distribution, McNemar exact and
// continuity-corrected statistics, paired bootstrap, Holm adjustment,
// contamination bounds and the power/MDE engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mulberry32, mean, normalCdf, normalInv, mcnemar, pairedBootstrap,
  holmAdjust, contaminationBounds, contaminationCurve, leakBreakEven,
  mcnemarPower, mde, correctnessScale, analyzeSuite,
} from '../src/stats-lab.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const rows = (pairs) => pairs.map(([a, b], i) => ({ id: `i${i + 1}`, a, b }));

/* ------------------------------------------------------------------ */
/* mulberry32                                                          */
/* ------------------------------------------------------------------ */

test('rng: same seed produces the identical stream', () => {
  const r1 = mulberry32(42);
  const r2 = mulberry32(42);
  for (let i = 0; i < 20; i++) assert.equal(r1(), r2());
});

test('rng: different seeds diverge immediately', () => {
  const r1 = mulberry32(1);
  const r2 = mulberry32(2);
  const s1 = Array.from({ length: 10 }, () => r1());
  const s2 = Array.from({ length: 10 }, () => r2());
  assert.ok(s1.some((v, i) => v !== s2[i]));
});

test('rng: every draw stays inside [0, 1)', () => {
  const r = mulberry32(7);
  for (let i = 0; i < 1000; i++) {
    const v = r();
    assert.ok(v >= 0 && v < 1, v);
  }
});

test('rng: seed 0 falls back to a valid stream', () => {
  const r = mulberry32(0);
  const vals = new Set(Array.from({ length: 50 }, () => r()));
  assert.ok(vals.size > 40, 'degenerate stream');
});

test('rng: stream is roughly uniform across the unit interval', () => {
  const r = mulberry32(99);
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 10000; i++) buckets[(r() * 10) | 0]++;
  for (const b of buckets) assert.ok(b > 850 && b < 1150, `bucket ${b}`);
});

test('mean: averages plain arrays and typed arrays', () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
  assert.equal(mean(new Float64Array([2, 4])), 3);
});

/* ------------------------------------------------------------------ */
/* normalCdf / normalInv                                               */
/* ------------------------------------------------------------------ */

test('normalCdf: Phi(0) is exactly 0.5', () => {
  assert.equal(normalCdf(0), 0.5);
});

test('normalCdf: textbook landmarks', () => {
  assert.ok(close(normalCdf(1.959964), 0.975, 1e-5));
  assert.ok(close(normalCdf(-1.959964), 0.025, 1e-5));
  assert.ok(close(normalCdf(1.644854), 0.95, 1e-5));
  assert.ok(close(normalCdf(1), 0.8413447, 1e-5));
  assert.ok(close(normalCdf(-1), 0.1586553, 1e-5));
});

test('normalCdf: symmetry Phi(-z) = 1 - Phi(z)', () => {
  for (const z of [0.1, 0.7, 1.3, 2.2, 3.1]) {
    assert.ok(close(normalCdf(-z), 1 - normalCdf(z), 1e-7), `z=${z}`);
  }
});

test('normalCdf: monotone increasing', () => {
  let prev = -Infinity;
  for (let z = -6; z <= 6; z += 0.25) {
    const v = normalCdf(z);
    assert.ok(v >= prev, `z=${z}`);
    prev = v;
  }
});

test('normalCdf: extreme tails', () => {
  assert.ok(normalCdf(-8) < 1e-12 && normalCdf(-8) >= 0);
  assert.ok(normalCdf(8) > 1 - 1e-12 && normalCdf(8) <= 1);
});

test('normalInv: inverts the CDF to machine precision', () => {
  for (const p of [0.001, 0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99, 0.999]) {
    assert.ok(close(normalCdf(normalInv(p)), p, 1e-7), `p=${p}`);
  }
});

test('normalInv: landmarks', () => {
  assert.ok(close(normalInv(0.5), 0, 1e-12));
  assert.ok(close(normalInv(0.975), 1.959964, 1e-4));
  assert.ok(close(normalInv(0.025), -1.959964, 1e-4));
});

test('normalInv: antisymmetric about 0.5', () => {
  for (const p of [0.1, 0.2, 0.4]) assert.ok(close(normalInv(1 - p), -normalInv(p), 1e-9));
});

test('normalInv: edges return infinities and NaN outside', () => {
  assert.equal(normalInv(0), -Infinity);
  assert.equal(normalInv(1), Infinity);
  assert.ok(Number.isNaN(normalInv(-0.1)));
  assert.ok(Number.isNaN(normalInv(1.1)));
  assert.ok(Number.isNaN(normalInv(NaN)));
});

/* ------------------------------------------------------------------ */
/* mcnemar                                                             */
/* ------------------------------------------------------------------ */

// Naive two-sided exact binomial for cross-checking small cases.
function naiveExact(n01, n10) {
  const n = n01 + n10;
  const k = Math.min(n01, n10);
  let p = 0;
  for (let j = 0; j <= k; j++) {
    let c = 1;
    for (let i = 0; i < j; i++) c = (c * (n - i)) / (i + 1);
    p += c / 2 ** n;
  }
  return Math.min(1, 2 * p);
}

test('mcnemar: identical models (n01 = n10 = 0) give p = 1', () => {
  const r = mcnemar(0, 0);
  assert.ok(r.ok);
  assert.equal(r.pExact, 1);
  assert.equal(r.pChi2, 1);
  assert.equal(r.chi2cc, 0);
});

test('mcnemar: equal discordants give exact p = 1, chi2cc = 1/(2k)', () => {
  for (const k of [1, 5, 40]) {
    const r = mcnemar(k, k);
    assert.equal(r.pExact, 1, `k=${k}`);
    // The continuity-corrected chi-square keeps (|d|-1)^2/n = 1/(2k), so its
    // p approaches 1 as the discordant count grows but never reaches it.
    assert.ok(Math.abs(r.chi2cc - 1 / (2 * k)) < 1e-12, `k=${k}: ${r.chi2cc}`);
    assert.ok(r.pChi2 < 1 && r.pChi2 > 0.4, `k=${k}: ${r.pChi2}`);
  }
});

test('mcnemar: known exact values from the binomial tail', () => {
  assert.ok(close(mcnemar(0, 5).pExact, 2 / 32, 1e-12));        // 0.0625
  assert.ok(close(mcnemar(0, 10).pExact, 2 / 1024, 1e-12));     // 0.001953125
  assert.ok(close(mcnemar(1, 8).pExact, 2 * (9 + 1) / 512, 1e-12)); // 0.0390625
});

test('mcnemar: exact p matches naive enumeration on small cases', () => {
  for (const [a, b] of [[0, 3], [2, 7], [4, 11], [1, 1], [9, 2], [13, 5], [3, 3]]) {
    const r = mcnemar(a, b);
    assert.ok(close(r.pExact, naiveExact(a, b), 1e-12), `n01=${a} n10=${b}`);
  }
});

test('mcnemar: swapping n01 and n10 preserves both p-values', () => {
  for (const [a, b] of [[3, 12], [0, 7], [5, 25], [11, 2]]) {
    const r1 = mcnemar(a, b);
    const r2 = mcnemar(b, a);
    assert.equal(r1.pExact, r2.pExact);
    assert.equal(r1.pChi2, r2.pChi2);
    assert.equal(r1.chi2cc, r2.chi2cc);
  }
});

test('mcnemar: continuity-corrected chi-square formula value', () => {
  const r = mcnemar(2, 10);
  assert.ok(close(r.chi2cc, (Math.abs(2 - 10) - 1) ** 2 / 12, 1e-12));
});

test('mcnemar: chi-square p agrees with the chi2(1) tail', () => {
  const r = mcnemar(5, 25);
  const expect = 2 * (1 - normalCdf(Math.sqrt(r.chi2cc)));
  assert.ok(close(r.pChi2, expect, 1e-6));
});

test('mcnemar: exact and chi-square p converge on large discordant counts', () => {
  const r = mcnemar(60, 100);
  assert.ok(Math.abs(r.pExact - r.pChi2) / r.pExact < 0.2, `exact ${r.pExact} vs cc ${r.pChi2}`);
});

test('mcnemar: p-values shrink as the imbalance grows', () => {
  let prev = 1;
  for (const k of [0, 2, 5, 10, 20]) {
    const r = mcnemar(0, k);
    assert.ok(r.pExact <= prev + 1e-12, `k=${k}: ${r.pExact}`);
    prev = r.pExact;
  }
});

test('mcnemar: p-values stay inside [0, 1] even at huge n', () => {
  const r = mcnemar(900, 100);
  assert.ok(r.pExact >= 0 && r.pExact <= 1 && Number.isFinite(r.pExact));
  const r2 = mcnemar(25000, 24000);
  assert.ok(r2.pExact >= 0 && r2.pExact <= 1 && Number.isFinite(r2.pExact));
});

test('mcnemar: discordant count and odds ratio are reported', () => {
  const r = mcnemar(3, 12);
  assert.equal(r.nDisc, 15);
  assert.ok(close(r.oddsRatio, 4, 1e-12));
  assert.equal(mcnemar(0, 5).oddsRatio, Infinity);
  assert.equal(mcnemar(0, 0).oddsRatio, 1);
});

test('mcnemar: rejects invalid counts', () => {
  for (const [a, b] of [[-1, 0], [0, -2], [1.5, 2], [NaN, 1], ['a', 1], [null, 1]]) {
    const r = mcnemar(a, b);
    assert.equal(r.ok, false, `${a},${b}`);
    assert.equal(typeof r.error, 'string');
  }
});

test('mcnemar: a one-sided discordant count of 20 clears alpha 0.01', () => {
  const r = mcnemar(0, 20);
  assert.ok(r.pExact < 0.01, r.pExact);
});

/* ------------------------------------------------------------------ */
/* pairedBootstrap                                                     */
/* ------------------------------------------------------------------ */

test('bootstrap: identical models give delta 0, CI [0,0] and p = 1', () => {
  const diffs = new Float64Array(50);
  const r = pairedBootstrap(diffs, { seed: 4, reps: 500 });
  assert.ok(r.ok);
  assert.equal(r.mean, 0);
  assert.equal(r.lo, 0);
  assert.equal(r.hi, 0);
  assert.equal(r.p, 1);
});

test('bootstrap: deterministic under a seed', () => {
  const d = Array.from({ length: 40 }, (_, i) => ((i * 13) % 7 - 3) / 10);
  const a = pairedBootstrap(d, { seed: 9, reps: 800 });
  const b = pairedBootstrap(d, { seed: 9, reps: 800 });
  assert.equal(a.lo, b.lo);
  assert.equal(a.hi, b.hi);
  assert.equal(a.p, b.p);
});

test('bootstrap: different seeds give different (but close) intervals', () => {
  const d = Array.from({ length: 60 }, (_, i) => ((i * 11) % 5 - 2) / 10);
  const a = pairedBootstrap(d, { seed: 1, reps: 2000 });
  const b = pairedBootstrap(d, { seed: 2, reps: 2000 });
  assert.notEqual(a.lo + a.hi, b.lo + b.hi);
  assert.ok(Math.abs(a.lo - b.lo) < 0.05);
  assert.ok(Math.abs(a.hi - b.hi) < 0.05);
});

test('bootstrap: CI brackets the sample mean delta', () => {
  const d = Array.from({ length: 80 }, (_, i) => ((i * 7) % 9 - 4) / 8);
  const r = pairedBootstrap(d, { seed: 3, reps: 3000 });
  assert.ok(r.lo <= r.mean + 1e-12 && r.hi >= r.mean - 1e-12, `[${r.lo}, ${r.hi}] vs ${r.mean}`);
});

test('bootstrap: interval width shrinks like 1/sqrt(n)', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ((i * 7) % 5 - 2) / 4);
  const small = pairedBootstrap(mk(25), { seed: 8, reps: 3000 });
  const large = pairedBootstrap(mk(400), { seed: 8, reps: 3000 });
  const wS = small.hi - small.lo;
  const wL = large.hi - large.lo;
  assert.ok(wL < wS / 2, `widths ${wS} vs ${wL}`);
});

test('bootstrap: percentile interval covers the true delta at the stated level', () => {
  // Items ~ Bernoulli(0.6) vs (0.55): true delta 0.05. Check coverage over seeds.
  const rng0 = mulberry32(1);
  let covered = 0;
  const runs = 120;
  for (let s = 0; s < runs; s++) {
    const diffs = [];
    for (let i = 0; i < 150; i++) {
      const a = rng0() < 0.6 ? 1 : 0;
      const b = rng0() < 0.55 ? 1 : 0;
      diffs.push(a - b);
    }
    const r = pairedBootstrap(diffs, { seed: s + 1, reps: 400 });
    if (r.lo <= 0.05 && r.hi >= 0.05) covered++;
  }
  assert.ok(covered > runs * 0.85, `coverage ${covered}/${runs}`);
});

test('bootstrap: a strong effect is called significant', () => {
  const diffs = Array.from({ length: 100 }, () => 1);
  const r = pairedBootstrap(diffs, { seed: 2, reps: 500 });
  assert.ok(r.p <= 0.01, r.p);
  assert.ok(r.lo > 0);
});

test('bootstrap: pure noise is not called significant', () => {
  const d = Array.from({ length: 200 }, (_, i) => (i % 2 ? 1 : -1));
  const r = pairedBootstrap(d, { seed: 6, reps: 1000 });
  assert.ok(r.p > 0.5, r.p);
});

test('bootstrap: p is bounded in [0, 1]', () => {
  const d = Array.from({ length: 30 }, (_, i) => i % 3 - 1);
  const r = pairedBootstrap(d, { seed: 5, reps: 100 });
  assert.ok(r.p >= 0 && r.p <= 1);
});

test('bootstrap: respects reps and level settings', () => {
  const d = Array.from({ length: 40 }, (_, i) => (i % 3) - 1);
  const r = pairedBootstrap(d, { seed: 1, reps: 250, level: 0.8 });
  assert.equal(r.reps, 250);
  assert.equal(r.level, 0.8);
  const wide = pairedBootstrap(d, { seed: 1, reps: 250, level: 0.99 });
  assert.ok(wide.hi - wide.lo >= r.hi - r.lo - 1e-12, 'a 99% interval is not narrower');
});

test('bootstrap: keep returns the sorted replicate samples', () => {
  const d = [1, -1, 0.5, -0.5, 0.25];
  const r = pairedBootstrap(d, { seed: 1, reps: 200, keep: true });
  assert.equal(r.samples.length, 200);
  for (let i = 1; i < 200; i++) assert.ok(r.samples[i] >= r.samples[i - 1]);
});

test('bootstrap: replicate means only combine observed differences', () => {
  const r = pairedBootstrap([0.2, -0.1, 0.4], { seed: 1, reps: 500, keep: true });
  for (const m of r.samples) {
    // Every resample mean is a sum of the three observed diffs divided by 3.
    const k = m * 3;
    let found = false;
    for (const x of [0.2, -0.1, 0.4]) for (const y of [0.2, -0.1, 0.4]) for (const z of [0.2, -0.1, 0.4]) {
      if (Math.abs(k - (x + y + z)) < 1e-9) found = true;
    }
    assert.ok(found, `resample mean ${m} uses only observed diffs`);
  }
});

test('bootstrap: rejects empty input and bad settings', () => {
  assert.equal(pairedBootstrap([]).ok, false);
  assert.equal(pairedBootstrap('nope').ok, false);
  assert.equal(pairedBootstrap([1], { reps: 5 }).ok, false);
  assert.equal(pairedBootstrap([1], { reps: 500000 }).ok, false);
  assert.equal(pairedBootstrap([1], { level: 1.5 }).ok, false);
});

/* ------------------------------------------------------------------ */
/* holmAdjust                                                          */
/* ------------------------------------------------------------------ */

test('holm: a single p-value is unchanged', () => {
  const r = holmAdjust([0.03]);
  assert.deepEqual(r.adjusted, [0.03]);
});

test('holm: sorted family matches the textbook example', () => {
  const r = holmAdjust([0.01, 0.04, 0.03]);
  assert.deepEqual(r.adjusted.map((v) => Math.round(v * 1000) / 1000), [0.03, 0.06, 0.06]);
});

test('holm: adjusted >= raw and <= 1 for every entry', () => {
  const raw = [0.001, 0.02, 0.5, 0.9, 0.04];
  const { adjusted } = holmAdjust(raw);
  adjusted.forEach((p, i) => {
    assert.ok(p >= raw[i] - 1e-12, `i=${i}: ${p} < ${raw[i]}`);
    assert.ok(p <= 1);
  });
});

test('holm: equal p-values all get the m-fold penalty', () => {
  const { adjusted } = holmAdjust([0.02, 0.02, 0.02]);
  assert.deepEqual(adjusted, [0.06, 0.06, 0.06]);
});

test('holm: adjustment clamps at 1', () => {
  const { adjusted } = holmAdjust([0.4, 0.5, 0.9]);
  assert.deepEqual(adjusted, [1, 1, 1]);
});

test('holm: adjusted values are nondecreasing along the sorted order', () => {
  const raw = [0.5, 0.001, 0.3, 0.2, 0.9, 0.05];
  const { adjusted, order } = holmAdjust(raw);
  let prev = 0;
  for (const idx of order) {
    assert.ok(adjusted[idx] >= prev - 1e-12, 'non-monotone adjustment');
    prev = adjusted[idx];
  }
});

test('holm: order lists indices from smallest to largest raw p', () => {
  const { order } = holmAdjust([0.3, 0.01, 0.2]);
  assert.deepEqual(order, [1, 2, 0]);
});

test('holm: result does not depend on input order', () => {
  const a = holmAdjust([0.01, 0.5, 0.04]);
  const b = holmAdjust([0.5, 0.04, 0.01]);
  assert.ok(close(a.adjusted[0], b.adjusted[2]));
  assert.ok(close(a.adjusted[1], b.adjusted[0]));
  assert.ok(close(a.adjusted[2], b.adjusted[1]));
});

test('holm: the smallest p pays the full m penalty', () => {
  const { adjusted } = holmAdjust([0.02, 0.6, 0.7]);
  assert.ok(close(adjusted[0], 0.06));
});

test('holm: a large family stays bounded and monotone', () => {
  const raw = Array.from({ length: 8 }, (_, i) => (i + 1) * 0.01);
  const { adjusted } = holmAdjust(raw);
  assert.equal(adjusted.length, 8);
  for (let i = 1; i < 8; i++) assert.ok(adjusted[i] >= adjusted[i - 1] - 1e-12);
});

/* ------------------------------------------------------------------ */
/* contamination bounds                                                */
/* ------------------------------------------------------------------ */

test('contamination: zero leakage returns the observed delta', () => {
  const r = contaminationBounds(0.9, 0.8, 0);
  assert.ok(r.ok);
  assert.ok(close(r.aUpper, 0.9));
  assert.ok(close(r.deltaUpper, 0.1));
  assert.equal(r.leadSurvives, true);
});

test('contamination: the bound never exceeds the observed delta', () => {
  for (const c of [0, 0.02, 0.05, 0.1, 0.2, 0.5]) {
    const r = contaminationBounds(0.85, 0.7, c);
    assert.ok(r.deltaUpper <= 0.15 + 1e-9, `c=${c}: ${r.deltaUpper}`);
  }
});

test('contamination: the bound decreases monotonically in c', () => {
  let prev = Infinity;
  for (let c = 0; c < 0.6; c += 0.02) {
    const r = contaminationBounds(0.9, 0.6, c);
    assert.ok(r.deltaUpper <= prev + 1e-12, `c=${c}`);
    prev = r.deltaUpper;
  }
});

test('contamination: leakage beyond the observed score zeroes the bound', () => {
  const r = contaminationBounds(0.4, 0.3, 0.5);
  assert.equal(r.aUpper, 0);
  assert.ok(close(r.deltaUpper, -0.3));
});

test('contamination: aUpper formula matches (accA - c) / (1 - c)', () => {
  const r = contaminationBounds(0.8, 0.6, 0.2);
  assert.ok(close(r.aUpper, (0.8 - 0.2) / 0.8));
});

test('contamination: leadSurvives flips at the break-even', () => {
  const be = leakBreakEven(0.9, 0.8);
  const just = contaminationBounds(0.9, 0.8, be - 0.001);
  const past = contaminationBounds(0.9, 0.8, be + 0.001);
  assert.equal(just.leadSurvives, true);
  assert.equal(past.leadSurvives, false);
});

test('contamination: curve returns one bound per requested fraction', () => {
  const cs = [0, 0.05, 0.1, 0.15, 0.2];
  const curve = contaminationCurve(0.9, 0.7, cs);
  assert.equal(curve.length, 5);
  assert.ok(curve.every((r) => r.ok));
  assert.ok(curve[0].deltaUpper > curve[4].deltaUpper);
});

test('contamination: break-even is null without a lead or against a perfect B', () => {
  assert.equal(leakBreakEven(0.7, 0.8), null);
  assert.equal(leakBreakEven(0.7, 0.7), null);
  assert.equal(leakBreakEven(0.9, 1), null);
});

test('contamination: break-even solves delta / (1 - accB)', () => {
  assert.ok(close(leakBreakEven(0.9, 0.8), 0.1 / 0.2));
  assert.ok(close(leakBreakEven(0.75, 0.5), 0.25 / 0.5));
});

test('contamination: bound at the break-even sits at zero', () => {
  const be = leakBreakEven(0.85, 0.65);
  const at = contaminationBounds(0.85, 0.65, be);
  assert.ok(Math.abs(at.deltaUpper) < 1e-9, at.deltaUpper);
});

test('contamination: rejects c outside [0, 1)', () => {
  assert.equal(contaminationBounds(0.9, 0.8, -0.1).ok, false);
  assert.equal(contaminationBounds(0.9, 0.8, 1).ok, false);
  assert.equal(contaminationBounds(0.9, 0.8, 1.5).ok, false);
});

test('contamination: a 2 to 20 percent sweep maps the advertised range', () => {
  const curve = contaminationCurve(0.9, 0.8, [0.02, 0.2]);
  assert.ok(close(curve[0].deltaUpper, (0.9 - 0.02) / 0.98 - 0.8, 1e-9));
  assert.ok(close(curve[1].deltaUpper, (0.9 - 0.2) / 0.8 - 0.8, 1e-9));
});

/* ------------------------------------------------------------------ */
/* power engine                                                        */
/* ------------------------------------------------------------------ */

test('power: zero effect returns the alpha level', () => {
  assert.equal(mcnemarPower(500, 0.4, 0, 0.05), 0.05);
});

test('power: increases monotonically with N', () => {
  let prev = -1;
  for (const N of [50, 100, 200, 500, 1000, 2000]) {
    const p = mcnemarPower(N, 0.4, 0.05, 0.05);
    assert.ok(p >= prev - 1e-12, `N=${N}: ${p}`);
    prev = p;
  }
});

test('power: increases monotonically with effect size', () => {
  let prev = -1;
  for (const d of [0.005, 0.01, 0.02, 0.05, 0.1]) {
    const p = mcnemarPower(500, 0.5, d, 0.05);
    assert.ok(p >= prev - 1e-12, `d=${d}: ${p}`);
    prev = p;
  }
});

test('power: approaches 1 for a large N and a real effect', () => {
  assert.ok(mcnemarPower(20000, 0.5, 0.05, 0.05) > 0.999);
});

test('power: a tiny eval stays a coin flip for small effects', () => {
  const p = mcnemarPower(50, 0.5, 0.02, 0.05);
  assert.ok(p < 0.35, `N=50 +2pt power=${p}`);
});

test('power: is symmetric in the sign of the effect', () => {
  assert.ok(close(mcnemarPower(400, 0.4, 0.05, 0.05), mcnemarPower(400, 0.4, -0.05, 0.05)));
});

test('power: a stricter alpha lowers power', () => {
  assert.ok(mcnemarPower(1000, 0.4, 0.03, 0.01) < mcnemarPower(1000, 0.4, 0.03, 0.05));
});

test('power: returns NaN on impossible inputs', () => {
  assert.ok(Number.isNaN(mcnemarPower(0, 0.4, 0.05)));
  assert.ok(Number.isNaN(mcnemarPower(100, 0, 0.05)));
  assert.ok(Number.isNaN(mcnemarPower(100, 1.5, 0.05)));
  assert.ok(Number.isNaN(mcnemarPower(100, 0.4, 0.5)));     // delta > pDisc
  assert.ok(Number.isNaN(mcnemarPower(100, 0.4, 0.05, 0)));
});

test('power: stays inside [0, 1]', () => {
  for (const [N, d, pd] of [[30, 0.01, 0.9], [100, 0.1, 0.3], [5000, 0.005, 0.6]]) {
    const p = mcnemarPower(N, pd, d, 0.05);
    assert.ok(p >= 0 && p <= 1, `N=${N} d=${d} pd=${pd}: ${p}`);
  }
});

test('power: known sanity range for a mid-size eval', () => {
  // 2000 items, 50% discordance, +5pt effect: power lands in the high 0.8s.
  const p = mcnemarPower(2000, 0.5, 0.05, 0.05);
  assert.ok(p > 0.7 && p < 0.99, `power ${p}`);
});

/* ------------------------------------------------------------------ */
/* minimum detectable effect                                           */
/* ------------------------------------------------------------------ */

test('mde: shrinks as N grows', () => {
  const small = mde(100, 0.4, 0.05, 0.8);
  const mid = mde(500, 0.4, 0.05, 0.8);
  const large = mde(5000, 0.4, 0.05, 0.8);
  assert.ok(mid.delta < small.delta && large.delta < mid.delta,
    `${small.delta} ${mid.delta} ${large.delta}`);
});

test('mde: reported delta reaches the requested power', () => {
  const r = mde(800, 0.4, 0.05, 0.8);
  assert.ok(r.reached);
  const p = mcnemarPower(800, 0.4, r.delta, 0.05);
  assert.ok(p >= 0.8 - 1e-9, `power at MDE ${p}`);
});

test('mde: cannot be negative or exceed the feasible bound', () => {
  const r = mde(1000, 0.4, 0.05, 0.8);
  assert.ok(r.delta > 0 && r.delta <= Math.min(0.4, 1.6));
});

test('mde: unreachable targets report reached=false at the bound', () => {
  const r = mde(10, 0.4, 0.05, 0.999);
  assert.equal(r.reached, false);
  assert.equal(r.delta, 0.4);
});

test('mde: a higher power target needs a larger effect', () => {
  const p80 = mde(500, 0.4, 0.05, 0.8);
  const p95 = mde(500, 0.4, 0.05, 0.95);
  assert.ok(p95.delta > p80.delta);
});

test('mde: more discordance needs a larger effect', () => {
  // More baseline disagreement is more binomial noise to beat, so the
  // detectable effect scales like sqrt(pDisc), not the other way round.
  const rare = mde(1000, 0.1, 0.05, 0.8);
  const common = mde(1000, 0.6, 0.05, 0.8);
  assert.ok(rare.reached && common.reached);
  assert.ok(common.delta > rare.delta, `${common.delta} vs ${rare.delta}`);
});

/* ------------------------------------------------------------------ */
/* correctness scale                                                   */
/* ------------------------------------------------------------------ */

test('correctnessScale: exact 0/1 sets are binary with a 0.5 threshold', () => {
  const s = correctnessScale([0, 1, 1, 0, 1]);
  assert.equal(s.binary, true);
  assert.equal(s.threshold, 0.5);
  assert.equal(s.scale, 'binary');
});

test('correctnessScale: fractional scores in [0,1] use the unit scale', () => {
  const s = correctnessScale([0.2, 0.9, 0.5]);
  assert.equal(s.scale, 'unit');
  assert.equal(s.threshold, 0.5);
  assert.equal(s.binary, false);
});

test('correctnessScale: percentages use the 50 mark', () => {
  const s = correctnessScale([20, 90, 50, 100, 0]);
  assert.equal(s.scale, 'percent');
  assert.equal(s.threshold, 50);
});

test('correctnessScale: unknown scales are withheld', () => {
  const s = correctnessScale([-3, 7, 200]);
  assert.equal(s.scale, null);
  assert.equal(s.threshold, null);
});

test('correctnessScale: a lone 0 or 1 is still binary', () => {
  assert.equal(correctnessScale([1]).binary, true);
  assert.equal(correctnessScale([0]).binary, true);
});

/* ------------------------------------------------------------------ */
/* analyzeSuite                                                        */
/* ------------------------------------------------------------------ */

test('analyzeSuite: counts items, accuracies and delta', () => {
  const r = analyzeSuite(rows([[1, 0], [1, 1], [0, 1], [1, 0]]), { reps: 200 });
  assert.ok(r.ok);
  assert.equal(r.n, 4);
  assert.ok(close(r.accA, 0.75));
  assert.ok(close(r.accB, 0.5));
  assert.ok(close(r.delta, 0.25));
});

test('analyzeSuite: discordant pairs split correctly', () => {
  const r = analyzeSuite(rows([[1, 0], [1, 0], [0, 1], [1, 1], [0, 0]]), { reps: 200 });
  assert.equal(r.n10, 2); // A only
  assert.equal(r.n01, 1); // B only
  assert.equal(r.mc.nDisc, 3);
});

test('analyzeSuite: identical rows give delta 0, p 1', () => {
  const r = analyzeSuite(rows([[1, 1], [0, 0], [1, 1]]), { reps: 300 });
  assert.equal(r.delta, 0);
  assert.equal(r.boot.p, 1);
  assert.equal(r.mc.pExact, 1);
  assert.equal(r.pPrimary, 1);
});

test('analyzeSuite: picks exact McNemar as primary when a scale exists', () => {
  const r = analyzeSuite(rows([[1, 0], [0, 1], [1, 1], [1, 0]]), { reps: 200 });
  assert.equal(r.pPrimary, r.mc.pExact);
});

test('analyzeSuite: falls back to the bootstrap p on an unknown scale', () => {
  const r = analyzeSuite(rows([[5, 300], [10, 250], [8, 275]]), { reps: 200 });
  assert.equal(r.mc, null);
  assert.equal(r.pPrimary, r.boot.p);
});

test('analyzeSuite: percent-scale scores still get a McNemar', () => {
  const r = analyzeSuite(rows([[90, 40], [80, 30], [30, 60]]), { reps: 200 });
  assert.ok(r.mc);
  assert.equal(r.n10, 2);
  assert.equal(r.n01, 1);
});

test('analyzeSuite: rejects an empty suite', () => {
  const r = analyzeSuite([]);
  assert.equal(r.ok, false);
  assert.match(r.error, /no rows/i);
});

test('analyzeSuite: rejects non-finite scores with the row number', () => {
  const r = analyzeSuite(rows([[1, 0], [NaN, 1]]));
  assert.equal(r.ok, false);
  assert.match(r.error, /row 2/);
});

test('analyzeSuite: rejects Infinity scores', () => {
  assert.equal(analyzeSuite(rows([[Infinity, 0]])).ok, false);
  assert.equal(analyzeSuite(rows([[1, -Infinity]])).ok, false);
});

test('analyzeSuite: every reported number is finite', () => {
  const r = analyzeSuite(rows([[1, 0], [0, 1], [1, 1], [0, 0], [1, 0]]), { reps: 500 });
  for (const v of [r.accA, r.accB, r.delta, r.boot.lo, r.boot.hi, r.boot.p, r.pPrimary]) {
    assert.ok(Number.isFinite(v), v);
  }
});

test('analyzeSuite: delta sign points at the higher scorer', () => {
  const r = analyzeSuite(rows([[0, 1], [0, 1], [1, 0]]), { reps: 200 });
  assert.ok(r.delta < 0, 'B scores higher so delta is negative');
});
