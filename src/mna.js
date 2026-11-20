// Modified Nodal Analysis (MNA) solver with nonlinear Newton-Raphson, transient and AC analyses.
// Dense Float64Array matrices; meant for classroom-sized circuits (up to about 40 parts).

import { normalizeWave, waveValue, waveDC, waveBreakpoints } from './waves.js';

export const VT = 0.02585; // thermal voltage at about 300 K (V)
export const GMIN = 1e-12; // conductance across every diode junction (S)
export const GMIN_CAP = 1e-9; // tie to ground for nodes reached only through capacitors (S)
const MAX_EXP = 80; // diode exponent cap; the curve is continued linearly above it
const MAX_PARTS = 40;
const MAX_SAMPLES = 20000;

export const PART_TYPES = {
  R: { pins: 2, label: 'Resistor', unit: 'Ω' },
  C: { pins: 2, label: 'Capacitor', unit: 'F' },
  L: { pins: 2, label: 'Inductor', unit: 'H' },
  V: { pins: 2, label: 'Voltage source', unit: 'V' },
  D: { pins: 2, label: 'Diode', unit: '' },
  OPAMP: { pins: 3, label: 'Op-amp', unit: '' },
};

export const DIODE_MODELS = {
  si: { is: 1e-14, n: 1, label: 'Silicon' },
  led: { is: 1e-18, n: 2, label: 'Red LED' },
};

const NODE_RE = /^[A-Za-z0-9_]{1,12}$/;
const ID_RE = /^[A-Z][A-Za-z0-9]{0,7}$/;

function fail(code, message, extra = {}) {
  return { ok: false, error: { code, message, ...extra } };
}

/* ------------------------------------------------------------------ */
/* Dense linear algebra                                                */
/* ------------------------------------------------------------------ */

/** A pivot ratio below this is treated as a singular circuit, not just a stiff one. */
const SINGULAR_RATIO = 1e-14;
/** A smallest-to-largest pivot ratio below this flags an ill-conditioned but solvable system. */
export const ILL_CONDITION_RATIO = 1e-10;

/**
 * Solve A x = b in place with Gaussian elimination and scaled partial pivoting.
 * A is an n*n row-major Float64Array, b a Float64Array of length n.
 *
 * Pivots are chosen and judged relative to the largest entry in their own row. A global
 * threshold misreads a legitimately small pivot (a 1 mOhm short, a 1 GOhm DC tie, a stiff
 * source branch) as a singular circuit, which used to fail a shorted resistor outright.
 * Returns { ok: true, x, illConditioned, cond } or { ok: false, row, illConditioned, cond }.
 */
export function solveDense(A, b, n) {
  if (!(n > 0)) return { ok: false, row: 0, illConditioned: false, cond: 0 };
  let scale = 0;
  for (let i = 0; i < n * n; i++) scale = Math.max(scale, Math.abs(A[i]));
  if (!(scale > 0)) return { ok: false, row: 0, illConditioned: false, cond: 0 };
  const rowScale = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = 0; j < n; j++) m = Math.max(m, Math.abs(A[i * n + j]));
    rowScale[i] = m;
  }
  let minRatio = Infinity;
  let maxRatio = 0;
  for (let k = 0; k < n; k++) {
    let p = -1;
    let best = 0;
    let bestRatio = 0;
    for (let i = k; i < n; i++) {
      const s = rowScale[i];
      if (!(s > 0)) continue;
      const v = Math.abs(A[i * n + k]);
      const ratio = v / s;
      if (ratio > bestRatio) { bestRatio = ratio; best = v; p = i; }
    }
    if (p < 0 || !(bestRatio > SINGULAR_RATIO)) {
      return { ok: false, row: k, illConditioned: true, cond: 0 };
    }
    if (p !== k) {
      for (let j = 0; j < n; j++) {
        const t = A[k * n + j]; A[k * n + j] = A[p * n + j]; A[p * n + j] = t;
      }
      const rs = rowScale[k]; rowScale[k] = rowScale[p]; rowScale[p] = rs;
      const t = b[k]; b[k] = b[p]; b[p] = t;
    }
    const piv = A[k * n + k];
    const ratio = Math.abs(piv) / rowScale[k];
    if (ratio < minRatio) minRatio = ratio;
    if (ratio > maxRatio) maxRatio = ratio;
    for (let i = k + 1; i < n; i++) {
      const f = A[i * n + k] / piv;
      if (f === 0) continue;
      A[i * n + k] = 0;
      for (let j = k + 1; j < n; j++) A[i * n + j] -= f * A[k * n + j];
      b[i] -= f * b[k];
    }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < n; j++) s -= A[i * n + j] * x[j];
    x[i] = s / A[i * n + i];
  }
  const cond = maxRatio > 0 ? Math.min(1, minRatio / maxRatio) : 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(x[i])) return { ok: false, row: i, illConditioned: true, cond };
  }
  return { ok: true, x, illConditioned: cond < ILL_CONDITION_RATIO, cond };
}

/** Complex version of solveDense, same scaled partial pivoting and conditioning report. */
export function solveDenseComplex(Ar, Ai, br, bi, n) {
  let scale = 0;
  for (let i = 0; i < n * n; i++) scale = Math.max(scale, Math.hypot(Ar[i], Ai[i]));
  if (!(scale > 0)) return { ok: false, row: 0, illConditioned: false, cond: 0 };
  const rowScale = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = 0; j < n; j++) m = Math.max(m, Math.hypot(Ar[i * n + j], Ai[i * n + j]));
    rowScale[i] = m;
  }
  let minRatio = Infinity;
  let maxRatio = 0;
  for (let k = 0; k < n; k++) {
    let p = -1;
    let bestRatio = 0;
    for (let i = k; i < n; i++) {
      const s = rowScale[i];
      if (!(s > 0)) continue;
      const ratio = Math.hypot(Ar[i * n + k], Ai[i * n + k]) / s;
      if (ratio > bestRatio) { bestRatio = ratio; p = i; }
    }
    if (p < 0 || !(bestRatio > SINGULAR_RATIO)) {
      return { ok: false, row: k, illConditioned: true, cond: 0 };
    }
    if (p !== k) {
      for (let j = 0; j < n; j++) {
        let t = Ar[k * n + j]; Ar[k * n + j] = Ar[p * n + j]; Ar[p * n + j] = t;
        t = Ai[k * n + j]; Ai[k * n + j] = Ai[p * n + j]; Ai[p * n + j] = t;
      }
      const rs = rowScale[k]; rowScale[k] = rowScale[p]; rowScale[p] = rs;
      let t = br[k]; br[k] = br[p]; br[p] = t;
      t = bi[k]; bi[k] = bi[p]; bi[p] = t;
    }
    const pr = Ar[k * n + k];
    const pi = Ai[k * n + k];
    const ratio = Math.hypot(pr, pi) / rowScale[k];
    if (ratio < minRatio) minRatio = ratio;
    if (ratio > maxRatio) maxRatio = ratio;
    const d = pr * pr + pi * pi;
    for (let i = k + 1; i < n; i++) {
      const ar = Ar[i * n + k];
      const ai = Ai[i * n + k];
      if (ar === 0 && ai === 0) continue;
      const fr = (ar * pr + ai * pi) / d;
      const fi = (ai * pr - ar * pi) / d;
      Ar[i * n + k] = 0; Ai[i * n + k] = 0;
      for (let j = k + 1; j < n; j++) {
        const kr = Ar[k * n + j];
        const ki = Ai[k * n + j];
        Ar[i * n + j] -= fr * kr - fi * ki;
        Ai[i * n + j] -= fr * ki + fi * kr;
      }
      br[i] -= fr * br[k] - fi * bi[k];
      bi[i] -= fr * bi[k] + fi * br[k];
    }
  }
  const cond = maxRatio > 0 ? Math.min(1, minRatio / maxRatio) : 0;
  const xr = new Float64Array(n);
  const xi = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let sr = br[i];
    let si = bi[i];
    for (let j = i + 1; j < n; j++) {
      sr -= Ar[i * n + j] * xr[j] - Ai[i * n + j] * xi[j];
      si -= Ar[i * n + j] * xi[j] + Ai[i * n + j] * xr[j];
    }
    const pr = Ar[i * n + i];
    const pi = Ai[i * n + i];
    const d = pr * pr + pi * pi;
    xr[i] = (sr * pr + si * pi) / d;
    xi[i] = (si * pr - sr * pi) / d;
  }
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(xr[i]) || !Number.isFinite(xi[i])) {
      return { ok: false, row: i, illConditioned: true, cond };
    }
  }
  return { ok: true, xr, xi, illConditioned: cond < ILL_CONDITION_RATIO, cond };
}

/* ------------------------------------------------------------------ */
/* Circuit compilation and validation                                  */
/* ------------------------------------------------------------------ */

/**
 * Check a circuit and build the index maps the solver needs.
 * Returns { ok: true, net } or { ok: false, error }.
 */
export function compile(circuit) {
  if (!circuit || !Array.isArray(circuit.parts)) return fail('BAD_CIRCUIT', 'Circuit has no parts list.');
  const parts = circuit.parts;
  if (parts.length === 0) return fail('EMPTY', 'Add at least one part.');
  if (parts.length > MAX_PARTS) return fail('TOO_BIG', `At most ${MAX_PARTS} parts are supported.`);
  const ids = new Set();
  const nodeNames = [];
  const nodeIndex = new Map();
  let groundUsed = false;
  const prepared = [];
  for (const p of parts) {
    if (!p || typeof p !== 'object') return fail('BAD_PART', 'A part entry is null or invalid.');
    const spec = PART_TYPES[p.type];
    if (!spec) return fail('BAD_PART', `Unknown part type "${p.type}".`, { part: p.id });
    if (!ID_RE.test(p.id || '')) return fail('BAD_PART', `Bad part id "${p.id}".`);
    if (ids.has(p.id)) return fail('BAD_PART', `Duplicate part id ${p.id}.`, { part: p.id });
    ids.add(p.id);
    if (!Array.isArray(p.nodes) || p.nodes.length !== spec.pins) {
      return fail('BAD_PART', `${p.id} needs ${spec.pins} node connections.`, { part: p.id });
    }
    for (const nm of p.nodes) {
      if (!NODE_RE.test(String(nm))) return fail('BAD_NODE', `${p.id} has a bad node name "${nm}".`, { part: p.id });
      if (nm === '0') { groundUsed = true; continue; }
      if (!nodeIndex.has(nm)) { nodeIndex.set(nm, nodeNames.length); nodeNames.push(nm); }
    }
    if (p.type !== 'OPAMP' && p.nodes[0] === p.nodes[1]) {
      return fail('SHORTED_PART', `${p.id} has both ends on node ${p.nodes[0]}.`, { part: p.id });
    }
    const q = { id: p.id, type: p.type, nodes: p.nodes.slice() };
    if (p.type === 'R' || p.type === 'C' || p.type === 'L') {
      const v = Number(p.value);
      if (!(Number.isFinite(v) && v > 0)) return fail('BAD_VALUE', `${p.id} needs a positive value.`, { part: p.id });
      q.value = v;
    } else if (p.type === 'V') {
      q.wave = normalizeWave(p.wave);
    } else if (p.type === 'D') {
      const m = DIODE_MODELS[p.model] || DIODE_MODELS.si;
      q.is = Number.isFinite(p.is) && p.is > 0 ? p.is : m.is;
      q.n = Number.isFinite(p.n) && p.n > 0 ? p.n : m.n;
    } else if (p.type === 'OPAMP') {
      q.gain = Number.isFinite(p.gain) && p.gain > 1 ? p.gain : 1e5;
      q.rail = Number.isFinite(p.rail) && p.rail > 0 ? p.rail : 12;
      if (p.nodes[2] === '0') return fail('BAD_PART', `${p.id} output cannot be ground.`, { part: p.id });
    }
    prepared.push(q);
  }
  if (!groundUsed) return fail('NO_GROUND', 'Connect something to ground (node 0).');

  // Connectivity: every node must reach ground through some part.
  // Op-amp inputs draw no current, so they do not connect anything; the output is driven from ground.
  const N = nodeNames.length;
  const idx = (nm) => (nm === '0' ? N : nodeIndex.get(nm));
  const all = new UnionFind(N + 1);
  const dc = new UnionFind(N + 1);
  for (const p of prepared) {
    if (p.type === 'OPAMP') {
      all.union(idx(p.nodes[2]), N);
      dc.union(idx(p.nodes[2]), N);
      continue;
    }
    const a = idx(p.nodes[0]);
    const b = idx(p.nodes[1]);
    all.union(a, b);
    if (p.type !== 'C') dc.union(a, b);
  }
  const floating = nodeNames.filter((nm) => all.find(idx(nm)) !== all.find(N));
  if (floating.length) {
    return fail('FLOATING_NODE', `Node${floating.length > 1 ? 's' : ''} ${floating.join(', ')} ${floating.length > 1 ? 'have' : 'has'} no path to ground.`, { nodes: floating });
  }
  const capOnly = nodeNames.filter((nm) => dc.find(idx(nm)) !== dc.find(N));

  // Branch variables: voltage sources, inductors and op-amp outputs.
  let k = N;
  for (const p of prepared) {
    p.ix = p.nodes.map((nm) => (nm === '0' ? -1 : nodeIndex.get(nm)));
    if (p.type === 'V' || p.type === 'L' || p.type === 'OPAMP') p.br = k++;
  }
  const nonlinear = prepared.some((p) => p.type === 'D' || p.type === 'OPAMP');
  return {
    ok: true,
    net: {
      parts: prepared,
      nodeNames,
      nodeIndex,
      N,
      size: k,
      capOnly: capOnly.map((nm) => nodeIndex.get(nm)),
      capOnlyNames: capOnly,
      nonlinear,
    },
  };
}

class UnionFind {
  constructor(n) { this.p = Array.from({ length: n }, (_, i) => i); }
  find(a) { while (this.p[a] !== a) { this.p[a] = this.p[this.p[a]]; a = this.p[a]; } return a; }
  union(a, b) { a = this.find(a); b = this.find(b); if (a !== b) this.p[a] = b; }
}

/* ------------------------------------------------------------------ */
/* Device equations                                                    */
/* ------------------------------------------------------------------ */

function diodeIG(p, vd) {
  const nvt = p.n * VT;
  const x = vd / nvt;
  if (x > MAX_EXP) {
    const e = Math.exp(MAX_EXP);
    const g = (p.is * e) / nvt;
    return { i: p.is * (e - 1) + g * (vd - MAX_EXP * nvt), g };
  }
  const e = Math.exp(x);
  return { i: p.is * (e - 1), g: (p.is * e) / nvt };
}

/** SPICE-style junction voltage limiting so Newton steps cannot overshoot the exponential. */
function pnjlim(vnew, vold, nvt, vcrit) {
  if (vnew > vcrit && Math.abs(vnew - vold) > 2 * nvt) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / nvt;
      return arg > 0 ? vold + nvt * Math.log(arg) : vcrit;
    }
    return nvt * Math.log(vnew / nvt);
  }
  return vnew;
}

// Op-amp output: Vout = rail * tanh(A * vd / rail). Linear (gain A) in the middle, clamps at +/- rail.
function opampOut(p, vd) {
  const u = (p.gain * vd) / p.rail;
  const th = Math.tanh(u);
  return { v: p.rail * th, g: p.gain * (1 - th * th) };
}

const volt = (x, i) => (i < 0 ? 0 : x[i]);

/* ------------------------------------------------------------------ */
/* Real-valued assembly (DC and transient)                             */
/* ------------------------------------------------------------------ */

// ctx: { mode: 'dc' | 'trap' | 'be', h, t, side, scale, state, lin }
function assemble(net, ctx, A, b) {
  const n = net.size;
  A.fill(0);
  b.fill(0);
  const add = (i, j, v) => { if (i >= 0 && j >= 0) A[i * n + j] += v; };
  const rhs = (i, v) => { if (i >= 0) b[i] += v; };
  const stampG = (a, c, g) => { add(a, a, g); add(c, c, g); add(a, c, -g); add(c, a, -g); };
  for (const i of net.capOnly) add(i, i, GMIN_CAP);
  for (const p of net.parts) {
    const [a, c] = p.ix;
    switch (p.type) {
      case 'R':
        stampG(a, c, 1 / p.value);
        break;
      case 'C': {
        if (ctx.mode === 'dc') break;
        const s = ctx.state.cap.get(p.id);
        const g = ctx.mode === 'trap' ? (2 * p.value) / ctx.h : p.value / ctx.h;
        const j = ctx.mode === 'trap' ? g * s.v + s.i : g * s.v;
        stampG(a, c, g);
        rhs(a, j); rhs(c, -j);
        break;
      }
      case 'L': {
        const k = p.br;
        add(a, k, 1); add(c, k, -1); add(k, a, 1); add(k, c, -1);
        if (ctx.mode === 'dc') break;
        const s = ctx.state.ind.get(p.id);
        const z = ctx.mode === 'trap' ? (2 * p.value) / ctx.h : p.value / ctx.h;
        add(k, k, -z);
        b[k] += ctx.mode === 'trap' ? -z * s.i - s.v : -z * s.i;
        break;
      }
      case 'V': {
        const k = p.br;
        add(a, k, 1); add(c, k, -1); add(k, a, 1); add(k, c, -1);
        const v = ctx.mode === 'dc' && ctx.t === null ? waveDC(p.wave) : waveValue(p.wave, ctx.t, ctx.side);
        b[k] += v * ctx.scale;
        break;
      }
      case 'D': {
        const vd = ctx.lin.get(p.id);
        const { i, g } = diodeIG(p, vd);
        const geq = g + GMIN;
        const ieq = i - g * vd;
        stampG(a, c, geq);
        rhs(a, -ieq); rhs(c, ieq);
        break;
      }
      case 'OPAMP': {
        const [ip, im, io] = p.ix;
        const k = p.br;
        const vd = ctx.lin.get(p.id);
        const { v, g } = opampOut(p, vd);
        add(io, k, 1);
        add(k, io, 1); add(k, ip, -g); add(k, im, g);
        b[k] += v - g * vd;
        break;
      }
      default:
        break;
    }
  }
}

function initialLin(net) {
  const lin = new Map();
  for (const p of net.parts) if (p.type === 'D' || p.type === 'OPAMP') lin.set(p.id, 0);
  return lin;
}

/**
 * Newton-Raphson solve at one time point. Returns { ok, x, iters, cond } or a structured failure.
 * For linear circuits this is a single direct solve. `cond` is the smallest pivot ratio seen, so a
 * stiff but solvable system (a near-zero ohm short) can be reported instead of failing silently.
 */
function newton(net, ctx, x0, maxIter = 150) {
  const n = net.size;
  const A = new Float64Array(n * n);
  const b = new Float64Array(n);
  const lin = ctx.lin;
  let x = x0 ? Float64Array.from(x0) : new Float64Array(n);
  let cond = 1;
  // Start each device's linearization point from the previous solution when we have one.
  if (x0) for (const p of net.parts) setLinFromX(p, x, lin, true);
  for (let it = 1; it <= maxIter; it++) {
    assemble(net, ctx, A, b);
    const r = solveDense(A, b, n);
    if (!r.ok) {
      return fail('SINGULAR_MATRIX', singularMessage(net, r.row), { row: r.row, illConditioned: !!r.illConditioned });
    }
    if (Number.isFinite(r.cond) && r.cond < cond) cond = r.cond;
    const xn = r.x;
    if (!net.nonlinear) return { ok: true, x: xn, iters: 1, cond };
    let converged = true;
    for (let i = 0; i < n; i++) {
      const tol = 1e-9 + 1e-7 * Math.abs(xn[i]);
      if (Math.abs(xn[i] - x[i]) > tol) { converged = false; break; }
    }
    for (const p of net.parts) {
      if (setLinFromX(p, xn, lin, false)) converged = false;
    }
    x = xn;
    if (converged && it > 1) return { ok: true, x, iters: it, cond };
  }
  return fail('NO_CONVERGENCE', 'Newton-Raphson did not converge. Try a smaller time step or gentler source.');
}

// Update a nonlinear part's linearization point from solution x. Returns true if limiting was applied.
function setLinFromX(p, x, lin, raw) {
  if (p.type === 'D') {
    const vd = volt(x, p.ix[0]) - volt(x, p.ix[1]);
    if (raw) { lin.set(p.id, Math.min(vd, 1.5 * p.n)); return false; }
    const nvt = p.n * VT;
    const vcrit = nvt * Math.log(nvt / (Math.SQRT2 * p.is));
    const old = lin.get(p.id);
    const lim = pnjlim(vd, old, nvt, vcrit);
    lin.set(p.id, lim);
    return Math.abs(lim - vd) > 1e-12 || Math.abs(lim - old) > 1e-9 + 1e-7 * Math.abs(lim);
  }
  if (p.type === 'OPAMP') {
    const vd = volt(x, p.ix[0]) - volt(x, p.ix[1]);
    const old = lin.get(p.id);
    if (raw) { lin.set(p.id, vd); return false; }
    // Limit moves of the tanh argument u = A*vd/rail so saturation cannot fling Newton between rails.
    const k = p.gain / p.rail;
    const uo = k * old;
    const un = k * vd;
    let u;
    if (Math.abs(uo) > 3 && Math.abs(un) > 3 && Math.sign(uo) === Math.sign(un)) u = un; // stays saturated
    else if (Math.abs(uo) > 3) u = Math.sign(uo) * 3; // leaving saturation: enter at the knee
    else u = uo + Math.max(-1.5, Math.min(1.5, un - uo));
    const lim = u / k;
    lin.set(p.id, lim);
    return Math.abs(lim - old) > 1e-12 + 1e-9 * Math.abs(lim) || Math.abs(lim - vd) > 1e-12;
  }
  return false;
}

function singularMessage(net, row) {
  if (row < net.N) {
    return `The circuit equations are singular near node ${net.nodeNames[row]}. Check for a loop of voltage sources or inductors, or a part left unconnected.`;
  }
  const p = net.parts.find((q) => q.br === row);
  if (p) return `The circuit equations are singular at ${p.id}. A loop made only of voltage sources and inductors has no unique current.`;
  return 'The circuit equations are singular.';
}

/** A readable, structured warning for a stiff but solvable matrix. */
export function conditionWarning(cond) {
  const ratio = Number.isFinite(cond) && cond > 0 ? cond : 0;
  return {
    code: 'ILL_CONDITIONED',
    cond: ratio,
    message: `Near-singular matrix (smallest pivot ratio ${ratio.toExponential(1)}). A part value is far outside the usual range or shorts a stiff node, so the last digits are not trustworthy. Open or restore the part, or widen the value.`,
  };
}

/* ------------------------------------------------------------------ */
/* DC operating point                                                  */
/* ------------------------------------------------------------------ */

function dcSolve(net, t, side) {
  const ctx = { mode: 'dc', h: 0, t, side, scale: 1, lin: initialLin(net), state: null };
  let r = newton(net, ctx, null);
  if (!r.ok && r.error.code === 'NO_CONVERGENCE') {
    // Source stepping: ramp all sources from 10% to 100%, carrying the solution along.
    let x = null;
    ctx.lin = initialLin(net);
    for (let s = 1; s <= 10; s++) {
      ctx.scale = s / 10;
      r = newton(net, ctx, x);
      if (!r.ok) return r;
      x = r.x;
    }
  }
  if (r.ok) r.lin = ctx.lin;
  return r;
}

/** Map a solution vector to node voltages and per-part currents. */
function readout(net, x, ctx) {
  const v = {};
  for (let i = 0; i < net.N; i++) v[net.nodeNames[i]] = x[i];
  const cur = {};
  for (const p of net.parts) cur[p.id] = partCurrent(p, x, ctx);
  return { v, i: cur };
}

function partCurrent(p, x, ctx) {
  const va = volt(x, p.ix[0]);
  const vb = volt(x, p.ix[1]);
  switch (p.type) {
    case 'R': return (va - vb) / p.value;
    case 'C': return ctx && ctx.state ? ctx.state.cap.get(p.id).i : 0;
    case 'L': case 'V': return x[p.br];
    case 'D': return diodeIG(p, va - vb).i + GMIN * (va - vb);
    case 'OPAMP': return -x[p.br];
    default: return 0;
  }
}

/** DC operating point with sources at their t = 0- values. */
export function dcOperatingPoint(circuit) {
  const c = compile(circuit);
  if (!c.ok) return c;
  const net = c.net;
  const r = dcSolve(net, null, -1);
  if (!r.ok) return r;
  const out = readout(net, r.x, null);
  const warnings = Number.isFinite(r.cond) && r.cond < ILL_CONDITION_RATIO ? [conditionWarning(r.cond)] : [];
  return { ok: true, nodes: out.v, currents: out.i, iters: r.iters, cond: r.cond, warnings, notes: notesFor(net) };
}

function notesFor(net) {
  return net.capOnlyNames.length
    ? [`Node ${net.capOnlyNames.join(', ')} only reaches ground through capacitors; a 1 GΩ tie sets its DC level.`]
    : [];
}

/* ------------------------------------------------------------------ */
/* Transient analysis                                                  */
/* ------------------------------------------------------------------ */

/**
 * Transient analysis on a uniform output grid t = 0, dt, ..., tstop.
 * Source discontinuities are handled exactly: the solver steps to each edge, then makes a
 * tiny backward-Euler step (1e-6 dt) with capacitor voltages and inductor currents held,
 * which gives the correct right-hand state before integration continues.
 * opts: { tstop, dt, method: 'trap' | 'be' }
 */
export function transient(circuit, opts = {}) {
  const t0 = nowMs();
  const c = compile(circuit);
  if (!c.ok) return c;
  const net = c.net;
  const tstop = Number(opts.tstop);
  const dt = Number(opts.dt);
  if (!(Number.isFinite(tstop) && Number.isFinite(dt) && tstop > 0 && dt > 0)) {
    return fail('BAD_SIM', 'Simulation time and step must be finite positive numbers.');
  }
  const steps = Math.round(tstop / dt);
  if (steps < 4) return fail('BAD_SIM', 'The window holds fewer than 4 time steps.');
  if (steps > MAX_SAMPLES) return fail('BAD_SIM', `At most ${MAX_SAMPLES} time steps (asked for ${steps}). Raise the step or shorten the window.`);
  const method = opts.method === 'be' ? 'be' : 'trap';

  // Breakpoints from every source, merged and sorted. Use iterative accumulation instead of
  // spread so a large edge list cannot overflow the JavaScript argument stack.
  const bps = [];
  for (const p of net.parts) {
    if (p.type === 'V') {
      const edges = waveBreakpoints(p.wave, tstop);
      for (let i = 0; i < edges.length; i++) bps.push(edges[i]);
    }
  }
  // A huge number of internal edges would take too long; return a useful sampling error.
  if (bps.length > 200000) {
    return fail('BAD_SIM', `Too many source edges (${bps.length}). Widen the step or shorten the window.`);
  }
  const seen = new Set();
  const unique = [];
  for (let i = 0; i < bps.length; i++) {
    const key = +bps[i].toPrecision(15);
    if (!seen.has(key)) { seen.add(key); unique.push(key); }
  }
  bps.length = 0;
  for (let i = 0; i < unique.length; i++) bps.push(unique[i]);
  bps.sort((a, b) => a - b);

  // Operating point at t = 0- (before any edge at t = 0).
  const op = dcSolve(net, 0, -1);
  if (!op.ok) return op;
  let x = op.x;
  const lin = op.lin;
  const state = { cap: new Map(), ind: new Map() };
  for (const p of net.parts) {
    if (p.type === 'C') state.cap.set(p.id, { v: volt(x, p.ix[0]) - volt(x, p.ix[1]), i: 0 });
    if (p.type === 'L') state.ind.set(p.id, { v: 0, i: x[p.br] });
  }

  const nT = steps + 1;
  const time = new Float64Array(nT);
  const nodes = {};
  for (const nm of net.nodeNames) nodes[nm] = new Float64Array(nT);
  const currents = {};
  for (const p of net.parts) currents[p.id] = new Float64Array(nT);

  let newtonIters = 0;
  let maxIters = 0;
  let edges = 0;
  let cond = Number.isFinite(op.cond) ? op.cond : 1;
  const ctx = { mode: method, h: dt, t: 0, side: 1, scale: 1, lin, state };

  const commit = (xn, mode, h) => {
    for (const p of net.parts) {
      if (p.type === 'C') {
        const s = state.cap.get(p.id);
        const vNew = volt(xn, p.ix[0]) - volt(xn, p.ix[1]);
        const g = mode === 'trap' ? (2 * p.value) / h : p.value / h;
        s.i = mode === 'trap' ? g * (vNew - s.v) - s.i : g * (vNew - s.v);
        s.v = vNew;
      } else if (p.type === 'L') {
        const s = state.ind.get(p.id);
        s.v = volt(xn, p.ix[0]) - volt(xn, p.ix[1]);
        s.i = xn[p.br];
      }
    }
  };
  const step = (t, h, mode, side) => {
    ctx.mode = mode; ctx.h = h; ctx.t = t; ctx.side = side;
    const r = newton(net, ctx, x);
    if (!r.ok) return r;
    newtonIters += r.iters;
    if (r.iters > maxIters) maxIters = r.iters;
    if (Number.isFinite(r.cond) && r.cond < cond) cond = r.cond;
    commit(r.x, mode, h);
    x = r.x;
    return r;
  };
  const jump = (t) => {
    edges++;
    return step(t, dt * 1e-6, 'be', 1);
  };
  const record = (k) => {
    time[k] = k * dt;
    for (let i = 0; i < net.N; i++) nodes[net.nodeNames[i]][k] = x[i];
    for (const p of net.parts) currents[p.id][k] = partCurrent(p, x, ctx);
  };

  let bi = 0;
  const tTol = dt * 1e-9;
  // Edge exactly at t = 0.
  while (bi < bps.length && bps[bi] <= tTol) {
    const r = jump(0);
    if (!r.ok) return r;
    bi++;
  }
  record(0);
  let t = 0;
  for (let k = 1; k <= steps; k++) {
    const target = k * dt;
    while (t < target - tTol) {
      let next = target;
      let isEdge = false;
      if (bi < bps.length && bps[bi] <= target + tTol) {
        next = Math.min(bps[bi], target);
        if (Math.abs(bps[bi] - target) <= tTol) next = target;
        isEdge = true;
      }
      const h = next - t;
      if (h > tTol) {
        const r = step(next, h, method, isEdge ? -1 : 1);
        if (!r.ok) return { ...r, error: { ...r.error, time: next } };
      }
      t = next;
      if (isEdge) {
        const r = jump(t);
        if (!r.ok) return { ...r, error: { ...r.error, time: t } };
        bi++;
      }
    }
    t = target;
    record(k);
  }
  for (const nm of net.nodeNames) {
    const arr = nodes[nm];
    for (let i = 0; i < nT; i++) if (!Number.isFinite(arr[i])) return fail('NAN', `Non-finite voltage at node ${nm}.`);
  }
  return {
    ok: true,
    t: time,
    dt,
    tstop,
    nodes,
    currents,
    nodeNames: net.nodeNames.slice(),
    cond,
    warnings: cond < ILL_CONDITION_RATIO ? [conditionWarning(cond)] : [],
    stats: { steps, edges, newtonIters, maxIters, method, ms: nowMs() - t0 },
    notes: notesFor(net),
  };
}

/* ------------------------------------------------------------------ */
/* AC small-signal analysis                                            */
/* ------------------------------------------------------------------ */

/**
 * Small-signal AC analysis around the DC operating point.
 * opts: { source: id of the V source driven with 1 V AC, freqs: array of Hz, out: node name, ref?: node name }
 * Returns magnitude (dB) and phase (degrees, unwrapped) of V(out) - V(ref) per 1 V of source.
 */
export function acSweep(circuit, opts = {}) {
  const t0 = nowMs();
  const c = compile(circuit);
  if (!c.ok) return c;
  const net = c.net;
  const src = net.parts.find((p) => p.id === opts.source && p.type === 'V');
  if (!src) return fail('BAD_AC', 'AC analysis needs a voltage source to drive.');
  const outIx = opts.out === '0' ? -1 : net.nodeIndex.get(opts.out);
  if (outIx === undefined) return fail('BAD_AC', `Unknown output node ${opts.out}.`);
  const refIx = !opts.ref || opts.ref === '0' ? -1 : net.nodeIndex.get(opts.ref);
  if (refIx === undefined) return fail('BAD_AC', `Unknown reference node ${opts.ref}.`);
  // Validate the sweep before paying for a DC operating point, so an empty list always reports
  // the real problem instead of a solve error from a circuit the caller did not mean to analyse.
  const rawFreqs = opts.freqs;
  if (!rawFreqs || typeof rawFreqs.length !== 'number' || rawFreqs.length === 0) {
    return fail('BAD_AC', 'AC sweep needs at least one frequency.');
  }
  for (let i = 0; i < rawFreqs.length; i++) {
    if (!Number.isFinite(rawFreqs[i]) || rawFreqs[i] <= 0) {
      return fail('BAD_AC', 'AC sweep frequencies must be finite positive numbers.');
    }
  }
  const op = dcSolve(net, null, -1);
  if (!op.ok) return op;
  const lin = op.lin;
  const freqs = Float64Array.from(rawFreqs);
  const n = net.size;
  const Ar = new Float64Array(n * n);
  const Ai = new Float64Array(n * n);
  const br = new Float64Array(n);
  const bi = new Float64Array(n);
  const mag = new Float64Array(freqs.length);
  const phase = new Float64Array(freqs.length);
  const re = new Float64Array(freqs.length);
  const im = new Float64Array(freqs.length);
  let cond = Number.isFinite(op.cond) ? op.cond : 1;
  for (let fi = 0; fi < freqs.length; fi++) {
    const w = 2 * Math.PI * freqs[fi];
    Ar.fill(0); Ai.fill(0); br.fill(0); bi.fill(0);
    const addR = (i, j, v) => { if (i >= 0 && j >= 0) Ar[i * n + j] += v; };
    const addI = (i, j, v) => { if (i >= 0 && j >= 0) Ai[i * n + j] += v; };
    const yR = (a, b, g) => { addR(a, a, g); addR(b, b, g); addR(a, b, -g); addR(b, a, -g); };
    const yI = (a, b, g) => { addI(a, a, g); addI(b, b, g); addI(a, b, -g); addI(b, a, -g); };
    for (const i of net.capOnly) addR(i, i, GMIN_CAP);
    for (const p of net.parts) {
      const [a, b] = p.ix;
      if (p.type === 'R') yR(a, b, 1 / p.value);
      else if (p.type === 'C') yI(a, b, w * p.value);
      else if (p.type === 'L') {
        const k = p.br;
        addR(a, k, 1); addR(b, k, -1); addR(k, a, 1); addR(k, b, -1);
        addI(k, k, -w * p.value);
      } else if (p.type === 'V') {
        const k = p.br;
        addR(a, k, 1); addR(b, k, -1); addR(k, a, 1); addR(k, b, -1);
        if (p === src) br[k] = 1;
      } else if (p.type === 'D') {
        yR(a, b, diodeIG(p, lin.get(p.id)).g + GMIN);
      } else if (p.type === 'OPAMP') {
        const [ip, im2, io] = p.ix;
        const k = p.br;
        const g = opampOut(p, lin.get(p.id)).g;
        addR(io, k, 1); addR(k, io, 1); addR(k, ip, -g); addR(k, im2, g);
      }
    }
    const r = solveDenseComplex(Ar, Ai, br, bi, n);
    if (!r.ok) return fail('SINGULAR_MATRIX', singularMessage(net, r.row), { freq: freqs[fi] });
    if (Number.isFinite(r.cond) && r.cond < cond) cond = r.cond;
    const vr = (outIx < 0 ? 0 : r.xr[outIx]) - (refIx < 0 ? 0 : r.xr[refIx]);
    const vi = (outIx < 0 ? 0 : r.xi[outIx]) - (refIx < 0 ? 0 : r.xi[refIx]);
    re[fi] = vr; im[fi] = vi;
    mag[fi] = 20 * Math.log10(Math.max(Math.hypot(vr, vi), 1e-300));
    phase[fi] = (Math.atan2(vi, vr) * 180) / Math.PI;
  }
  // Unwrap phase so it reads as a continuous curve.
  for (let i = 1; i < phase.length; i++) {
    while (phase[i] - phase[i - 1] > 180) phase[i] -= 360;
    while (phase[i] - phase[i - 1] < -180) phase[i] += 360;
  }
  return {
    ok: true, freqs, mag, phase, re, im, cond,
    warnings: cond < ILL_CONDITION_RATIO ? [conditionWarning(cond)] : [],
    ms: nowMs() - t0,
  };
}

/** Log-spaced frequencies from fstart to fstop with ppd points per decade. */
export function logFreqs(fstart, fstop, ppd = 40) {
  if (!(Number.isFinite(fstart) && Number.isFinite(fstop) && fstart > 0 && fstop > fstart)) {
    return new Float64Array(0);
  }
  const a = Math.log10(fstart);
  const b = Math.log10(fstop);
  const n = Math.max(2, Math.round((b - a) * ppd) + 1);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = 10 ** (a + ((b - a) * i) / (n - 1));
  return out;
}

function nowMs() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}
