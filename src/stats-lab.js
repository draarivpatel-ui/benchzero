// BenchZero rigor engine: paired significance statistics for comparing two models on the
// same benchmark items. Pure functions, no dependencies, deterministic under a seed.
//
// What lives here:
//   - mulberry32            seeded RNG so every bootstrap is replayable bit for bit
//   - normalCdf/normalInv   used by the power engine (normal approximation, labelled so)
//   - mcnemar               continuity-corrected chi-square plus two-sided exact binomial
//   - pairedBootstrap       percentile CI and two-sided p for the paired item score delta
//   - holmAdjust            Holm step-down adjustment across a family of suite p-values
//   - contamination*        worst-case leaderboard-lead bounds under test-set leakage
//   - mcnemarPower / mde    approximate power curve and minimum detectable effect

/* ------------------------------------------------------------------ */
/* Deterministic RNG                                                   */
/* ------------------------------------------------------------------ */

/** mulberry32: a small, fast, seedable RNG. Same seed, same stream, every run. */
export function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

/* ------------------------------------------------------------------ */
/* Normal distribution (needed by the power engine)                    */
/* ------------------------------------------------------------------ */

// erfc via the Numerical Recipes t-fraction approximation (|rel err| < 1.2e-7).
function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(
    -z * z - 1.26551223
    + t * (1.00002368
    + t * (0.37409196
    + t * (0.09678418
    + t * (-0.18628806
    + t * (0.27886807
    + t * (-1.13520398
    + t * (1.48851587
    + t * (-0.82215223
    + t * 0.17087277)))))))),
  );
  return x < 0 ? 2 - r : r;
}

/** Standard normal CDF, Phi(z). */
export function normalCdf(z) {
  if (z === 0) return 0.5;
  return 0.5 * erfc(-z / Math.SQRT2);
}

// Acklam's inverse normal CDF with one Newton refinement (accurate to ~1e-15 in the
// central region). Used to place rejection cutoffs inside the power engine.
export function normalInv(p) {
  if (!(p > 0 && p < 1)) {
    if (p === 0) return -Infinity;
    if (p === 1) return Infinity;
    return NaN;
  }
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
    -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let x;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= phigh) {
    const q = p - 0.5;
    const r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
      / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  // One Newton step on Phi(x) - p tightens Acklam to machine precision.
  const e = normalCdf(x) - p;
  const pdf = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  return x - e / pdf;
}

/* ------------------------------------------------------------------ */
/* McNemar's test on paired binary outcomes                            */
/* ------------------------------------------------------------------ */

function lgamma(z) {
  // Lanczos approximation, g = 7, n = 9 coefficients.
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < 9; i++) x += c[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// P(X <= k) for X ~ Bin(n, 1/2), summed in log space so n can be large.
function binomCdfHalf(n, k) {
  if (k < 0) return 0;
  if (k >= n) return 1;
  let sum = 0;
  for (let j = 0; j <= k; j++) {
    sum += Math.exp(lgamma(n + 1) - lgamma(j + 1) - lgamma(n - j + 1) - n * Math.LN2);
  }
  return Math.min(1, sum);
}

/**
 * McNemar on paired binary outcomes.
 * n01: items wrong under A but right under B. n10: items right under A but wrong under B.
 * Returns the continuity-corrected chi-square statistic and two p-values: the chi-square
 * tail and the two-sided exact binomial (the same definition R uses: min(1, 2*F(min, n, 1/2))).
 */
export function mcnemar(n01, n10) {
  if (!Number.isInteger(n01) || !Number.isInteger(n10) || n01 < 0 || n10 < 0) {
    return { ok: false, error: 'McNemar needs nonnegative integer discordant counts.' };
  }
  const nDisc = n01 + n10;
  const out = { ok: true, n01, n10, nDisc, chi2cc: 0, pChi2: 1, pExact: 1, oddsRatio: n01 === 0 ? (n10 === 0 ? 1 : Infinity) : n10 / n01 };
  if (nDisc === 0) return out;
  const d = Math.abs(n10 - n01);
  out.chi2cc = ((d - 1) ** 2) / nDisc;
  out.pChi2 = erfc(Math.sqrt(out.chi2cc / 2));
  const k = Math.min(n01, n10);
  out.pExact = Math.min(1, 2 * binomCdfHalf(nDisc, k));
  return out;
}

/* ------------------------------------------------------------------ */
/* Paired bootstrap                                                    */
/* ------------------------------------------------------------------ */

/**
 * Percentile bootstrap over the paired item score differences (a_i - b_i).
 * Deterministic for a given seed: resample the n item indices with replacement
 * `reps` times and collect the resampled mean delta of each replicate.
 * Returns the two-sided percentile CI, plus a p estimated as twice the smaller
 * tail share of replicates on either side of 0 with a (+1)/(B+1) correction.
 */
export function pairedBootstrap(diffs, { reps = 10000, seed = 1, level = 0.95, keep = false } = {}) {
  const n = diffs.length;
  if (n === 0 || !Array.isArray(diffs) && !ArrayBuffer.isView(diffs)) {
    return { ok: false, error: 'bootstrap needs a nonempty array of paired differences' };
  }
  if (!(reps >= 10 && reps <= 200000) || !(level > 0 && level < 1)) {
    return { ok: false, error: 'bad bootstrap settings' };
  }
  const rng = mulberry32(seed);
  const means = new Float64Array(reps);
  for (let r = 0; r < reps; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += diffs[(rng() * n) | 0];
    means[r] = s / n;
  }
  const sorted = Float64Array.from(means).sort();
  const q = (p) => {
    const idx = p * (reps - 1);
    const i0 = Math.floor(idx);
    const f = idx - i0;
    return i0 + 1 < reps ? sorted[i0] + f * (sorted[i0 + 1] - sorted[i0]) : sorted[i0];
  };
  const tail = (1 - level) / 2;
  let le = 0;
  let ge = 0;
  for (const m of means) { if (m <= 0) le++; if (m >= 0) ge++; }
  const p = Math.min(1, (2 * Math.min(le, ge) + 1) / (reps + 1));
  const out = {
    ok: true, mean: mean(diffs), lo: q(tail), hi: q(1 - tail), p,
    reps, seed, level, n,
  };
  if (keep) out.samples = sorted;
  return out;
}

/* ------------------------------------------------------------------ */
/* Holm step-down multiple-comparison adjustment                       */
/* ------------------------------------------------------------------ */

/**
 * Holm-Bonferroni adjusted p-values, returned in the original order.
 * Sort p ascending, multiply the i-th smallest by (m - i), clamp to 1, then
 * enforce monotonicity so the adjustment never decreases along the order.
 */
export function holmAdjust(pvals) {
  const m = pvals.length;
  const order = pvals.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const adjusted = new Array(m);
  let run = 0;
  for (let i = 0; i < m; i++) {
    const [p, idx] = order[i];
    run = Math.max(run, Math.min(1, (m - i) * p));
    adjusted[idx] = run;
  }
  return { ok: true, adjusted, order: order.map(([, i]) => i) };
}

/* ------------------------------------------------------------------ */
/* Contamination sensitivity (worst-case lead bound)                   */
/* ------------------------------------------------------------------ */

/**
 * Worst-case honest accuracy for A when a fraction c of evaluation items leaked
 * into A's training data and A scores a perfect 1 on every leaked item.
 *   accA_obs = (1 - c) * accA_true + c * 1   ->   accA_true <= (accA_obs - c) / (1 - c)
 * When c >= accA_obs the whole observed score could be leakage, so the bound is 0.
 */
export function contaminationBounds(accA, accB, c) {
  if (!(c >= 0 && c < 1)) return { ok: false, error: 'contamination fraction must be in [0, 1)' };
  const aUpper = c <= accA ? (accA - c) / (1 - c) : 0;
  return {
    ok: true, c, aUpper,
    deltaUpper: aUpper - accB,
    leadSurvives: aUpper - accB > 0,
  };
}

/** Curve of the worst-case delta bound across leakage fractions. */
export function contaminationCurve(accA, accB, cs) {
  return cs.map((c) => contaminationBounds(accA, accB, c)).map((r) => (r.ok ? r : { ok: false }));
}

/**
 * Leakage fraction at which A's worst-case bound meets B's observed accuracy.
 * Solve (accA - c) / (1 - c) = accB:  c* = (accA - accB) / (1 - accB).
 * Returns null when A does not lead or B is perfect (no finite break-even).
 */
export function leakBreakEven(accA, accB) {
  const delta = accA - accB;
  if (delta <= 0 || accB >= 1) return null;
  return Math.min(1, delta / (1 - accB));
}

/* ------------------------------------------------------------------ */
/* Power engine: two-sided paired test, normal approximation           */
/* ------------------------------------------------------------------ */

/**
 * Approximate power of the paired-significance test at sample size N.
 * D = n10 - n01 has mean N*delta and variance N*(pDisc - delta^2), where
 * pDisc = p01 + p10 is the expected discordant share. The two-sided alpha test
 * rejects |D| past a normal-approximation cutoff set under the null variance
 * N*pDisc. Labelled an approximation: exact conditional power differs at small N.
 */
export function mcnemarPower(N, pDisc, delta, alpha = 0.05) {
  if (!(N > 0) || !(pDisc > 0 && pDisc <= 1) || !(alpha > 0 && alpha < 1)) return NaN;
  const d = Math.abs(delta);
  if (d > pDisc) return NaN;
  if (d === 0) return alpha;
  const z = normalInv(1 - alpha / 2);
  const crit = z * Math.sqrt(N * pDisc);
  const sd1 = Math.max(Math.sqrt(N * Math.max(pDisc - d * d, 0)), 1e-9);
  const mu = N * d;
  const power = (1 - normalCdf((crit - mu) / sd1)) + normalCdf((-crit - mu) / sd1);
  return Math.min(1, Math.max(0, power));
}

/**
 * Minimum detectable effect: smallest |delta| whose approximated power reaches
 * `target` at size N. Bisection on [0, min(pDisc, 2 - pDisc)]. If even the
 * largest feasible delta cannot reach the target, `reached` is false and delta
 * is the feasible bound itself.
 */
export function mde(N, pDisc, alpha = 0.05, target = 0.8) {
  const bound = Math.min(pDisc, 2 - pDisc);
  if (!(bound > 0) || mcnemarPower(N, pDisc, bound, alpha) < target) {
    return { ok: true, delta: bound, reached: false, target };
  }
  let lo = 0;
  let hi = bound;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (mcnemarPower(N, pDisc, mid, alpha) >= target) hi = mid;
    else lo = mid;
  }
  return { ok: true, delta: hi, reached: true, target };
}

/* ------------------------------------------------------------------ */
/* Suite analysis                                                      */
/* ------------------------------------------------------------------ */

/**
 * Correctness scale for the paired binary view.
 * Scores in [0, 1]: correct is >= 0.5 (exact 0/1 sets report binary: true).
 * Scores in [0, 100]: correct is >= 50. Anything wider is withheld with a reason
 * because a "correct" threshold is undefined on an unknown scale.
 */
export function correctnessScale(scores) {
  let mn = Infinity;
  let mx = -Infinity;
  let binary = true;
  for (const s of scores) {
    if (s < mn) mn = s;
    if (s > mx) mx = s;
    if (s !== 0 && s !== 1) binary = false;
  }
  if (binary) return { threshold: 0.5, binary: true, scale: 'binary' };
  if (mn >= 0 && mx <= 1) return { threshold: 0.5, binary: false, scale: 'unit' };
  if (mn >= 0 && mx <= 100) return { threshold: 50, binary: false, scale: 'percent' };
  return { threshold: null, binary: false, scale: null };
}

/**
 * Full paired analysis of one suite. rows: [{id, a, b}].
 * delta is mean(a_i - b_i): positive means model A scores higher.
 */
export function analyzeSuite(rows, { seed = 1, reps = 10000, level = 0.95 } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return { ok: false, error: 'suite has no rows' };
  const n = rows.length;
  const a = new Float64Array(n);
  const b = new Float64Array(n);
  const diffs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    if (!r || !Number.isFinite(r.a) || !Number.isFinite(r.b)) {
      return { ok: false, error: `row ${i + 1} has a non-finite score` };
    }
    a[i] = r.a;
    b[i] = r.b;
    diffs[i] = r.a - r.b;
  }
  const accA = mean(a);
  const accB = mean(b);
  const delta = accA - accB;
  const boot = pairedBootstrap(diffs, { reps, seed, level });
  const scale = correctnessScale([...a, ...b]);
  let mc = null;
  let n01 = 0;
  let n10 = 0;
  if (scale.threshold !== null) {
    const t = scale.threshold;
    for (let i = 0; i < n; i++) {
      const ca = a[i] >= t;
      const cb = b[i] >= t;
      if (!ca && cb) n01++;
      else if (ca && !cb) n10++;
    }
    mc = mcnemar(n01, n10);
  }
  // The family p for Holm: exact McNemar where a correctness scale exists,
  // the bootstrap two-sided p otherwise.
  const pPrimary = mc ? mc.pExact : boot.p;
  return {
    ok: true, n, accA, accB, delta, diffs, boot, scale, mc, n01, n10, pPrimary,
    seed, reps, level,
  };
}
