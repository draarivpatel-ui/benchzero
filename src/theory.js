// Closed-form physics for the five guided labs. Independent of the MNA solver on purpose:
// this module never imports mna.js, so comparing the two is a real check, not a circular one.
// It reads only the source definition (waves.js) and the part values.

import { normalizeWave, waveValue, waveDC } from './waves.js';

const TAU = 2 * Math.PI;
export const VT = 0.02585;

/** Required topology for each lab: [id, type, nodes]. Values may change freely. */
export const LAB_TOPOLOGY = {
  rc: [['V1', 'V', ['in', '0']], ['R1', 'R', ['in', 'out']], ['C1', 'C', ['out', '0']]],
  rlc: [['V1', 'V', ['in', '0']], ['R1', 'R', ['in', 'a']], ['L1', 'L', ['a', 'out']], ['C1', 'C', ['out', '0']]],
  rect: [['V1', 'V', ['in', '0']], ['D1', 'D', ['in', 'out']], ['C1', 'C', ['out', '0']], ['RL', 'R', ['out', '0']]],
  inv: [['V1', 'V', ['in', '0']], ['R1', 'R', ['in', 'inv']], ['R2', 'R', ['inv', 'out']], ['U1', 'OPAMP', ['0', 'inv', 'out']]],
  div: [['V1', 'V', ['in', '0']], ['R1', 'R', ['in', 'out']], ['R2', 'R', ['out', '0']], ['RL', 'R', ['out', '0']]],
};

const DIODE = { si: { is: 1e-14, n: 1 }, led: { is: 1e-18, n: 2 } };

function matchTopology(circuit) {
  const lab = circuit && circuit.lab;
  const want = LAB_TOPOLOGY[lab];
  if (!want) return { ok: false, reason: 'This circuit is not one of the guided labs, so there is no closed-form model for it.' };
  if (circuit.parts.length !== want.length) {
    return { ok: false, reason: 'The circuit was edited beyond the lab topology. Values can change freely, but adding or removing parts turns the theory check off.' };
  }
  const byId = {};
  for (const p of circuit.parts) byId[p.id] = p;
  for (const [id, type, nodes] of want) {
    const p = byId[id];
    if (!p || p.type !== type || p.nodes.length !== nodes.length || p.nodes.some((n, i) => n !== nodes[i])) {
      return { ok: false, reason: `Part ${id} was moved or changed type, so the closed-form model no longer applies.` };
    }
  }
  return { ok: true, lab, byId };
}

/* ------------------------------------------------------------------ */
/* Input helpers                                                       */
/* ------------------------------------------------------------------ */

// Points where a piecewise-linear source changes value or slope, sorted, inside (0, tEnd).
function pwlKinks(w, tEnd) {
  const out = [];
  if (w.kind === 'step') out.push(w.delay);
  if (w.kind === 'square' || w.kind === 'triangle') {
    const T = 1 / w.freq;
    const n = Math.ceil((tEnd - w.delay) / T) + 1;
    for (let k = 0; k < n && k < 400000; k++) {
      const a = w.delay + k * T;
      out.push(a, a + (w.kind === 'square' ? w.duty : 0.5) * T);
    }
  }
  return out.filter((t) => t >= 0 && t < tEnd).sort((a, b) => a - b);
}

const isPWL = (w) => ['dc', 'step', 'square', 'triangle'].includes(w.kind);

/**
 * Walk the sample grid, splitting at kinks, and call seg(t0, t1, u0, m) for each piece where the
 * input is u0 + m*(t - t0). Used to evaluate first- and second-order responses exactly.
 */
function walkPWL(w, tArr, seg, record) {
  const kinks = pwlKinks(w, tArr[tArr.length - 1]);
  let ki = 0;
  while (ki < kinks.length && kinks[ki] <= 0) ki++;
  record(0);
  let t = 0;
  for (let k = 1; k < tArr.length; k++) {
    const target = tArr[k];
    while (t < target) {
      let next = target;
      if (ki < kinks.length && kinks[ki] < target) next = kinks[ki++];
      if (next > t) {
        const u0 = waveValue(w, t, 1);
        const u1 = waveValue(w, next, -1);
        seg(t, next, u0, (u1 - u0) / (next - t));
      }
      t = next;
    }
    record(k);
  }
}

/* ------------------------------------------------------------------ */
/* RC low-pass                                                         */
/* ------------------------------------------------------------------ */

function rcCurve(R, C, w, tArr) {
  const tau = R * C;
  const out = new Float64Array(tArr.length);
  const v0 = waveDC(w); // capacitor sits at the input's pre-start level
  if (w.kind === 'sine') {
    const om = TAU * w.freq;
    const ph = (w.phase * Math.PI) / 180;
    const g = 1 / Math.sqrt(1 + (om * tau) ** 2);
    const lag = Math.atan(om * tau);
    const K = v0 - w.offset - w.amp * g * Math.sin(ph - lag);
    for (let i = 0; i < tArr.length; i++) {
      const t = tArr[i] - w.delay;
      out[i] = t <= 0 ? v0 : w.offset + w.amp * g * Math.sin(om * t + ph - lag) + K * Math.exp(-t / tau);
    }
    return out;
  }
  if (!isPWL(w)) return null;
  // Exact for a linear input piece u0 + m*s: v(s) = u(s) - m*tau + (v0 - u0 + m*tau) * exp(-s/tau).
  let v = v0;
  walkPWL(w, tArr, (t0, t1, u0, m) => {
    const h = t1 - t0;
    v = u0 + m * h - m * tau + (v - u0 + m * tau) * Math.exp(-h / tau);
  }, (k) => { out[k] = v; });
  return out;
}

/* ------------------------------------------------------------------ */
/* Series RLC (output across C)                                        */
/* ------------------------------------------------------------------ */

// Homogeneous solution of x'' + 2*a*x' + w0^2*x = 0 after time s, from x0 and x0'.
function homog(a, w0, x0, d0, s) {
  if (a < w0 * (1 - 1e-9)) {
    const wd = Math.sqrt(w0 * w0 - a * a);
    const K = (d0 + a * x0) / wd;
    const e = Math.exp(-a * s);
    const c = Math.cos(wd * s);
    const sn = Math.sin(wd * s);
    return { x: e * (x0 * c + K * sn), d: e * (-a * (x0 * c + K * sn) + wd * (-x0 * sn + K * c)) };
  }
  if (a > w0 * (1 + 1e-9)) {
    const r = Math.sqrt(a * a - w0 * w0);
    const s1 = -a + r;
    const s2 = -a - r;
    const A = (d0 - s2 * x0) / (s1 - s2);
    const B = x0 - A;
    const e1 = Math.exp(s1 * s);
    const e2 = Math.exp(s2 * s);
    return { x: A * e1 + B * e2, d: A * s1 * e1 + B * s2 * e2 };
  }
  const K = d0 + a * x0;
  const e = Math.exp(-a * s);
  return { x: e * (x0 + K * s), d: e * (K - a * (x0 + K * s)) };
}

function rlcCurve(R, L, C, w, tArr) {
  const a = R / (2 * L);
  const w0 = 1 / Math.sqrt(L * C);
  const out = new Float64Array(tArr.length);
  const v0 = waveDC(w);
  if (w.kind === 'sine') {
    const om = TAU * w.freq;
    const ph = (w.phase * Math.PI) / 180;
    const hr = 1 - om * om * L * C;
    const hi = om * R * C;
    const g = 1 / Math.hypot(hr, hi);
    const ang = -Math.atan2(hi, hr);
    const vp = (s) => w.offset + w.amp * g * Math.sin(om * s + ph + ang);
    const dp = (s) => w.amp * g * om * Math.cos(om * s + ph + ang);
    const x0 = v0 - vp(0);
    const d0 = 0 - dp(0); // inductor current starts at zero
    for (let i = 0; i < tArr.length; i++) {
      const s = tArr[i] - w.delay;
      out[i] = s <= 0 ? v0 : vp(s) + homog(a, w0, x0, d0, s).x;
    }
    return out;
  }
  if (!isPWL(w)) return null;
  // For a linear input piece u0 + m*s the particular solution is u - m*R*C (slope m).
  let v = v0;
  let dv = 0; // dVc/dt = i/C
  walkPWL(w, tArr, (t0, t1, u0, m) => {
    const h = t1 - t0;
    const r = homog(a, w0, v - (u0 - m * R * C), dv - m, h);
    v = u0 + m * h - m * R * C + r.x;
    dv = m + r.d;
  }, (k) => { out[k] = v; });
  return out;
}

/* ------------------------------------------------------------------ */
/* Half-wave rectifier with smoothing capacitor (approximate model)    */
/* ------------------------------------------------------------------ */

/**
 * Piecewise model: while the diode conducts, Vout = Vs - Vf with Vf from the Shockley law at the
 * current C*dVs/dt + Vout/R; it turns off when that current reaches zero, after which C discharges
 * through R as Voff*exp(-(t - toff)/RC) until the source again exceeds Vout + Vf.
 * This is the textbook ideal-switch analysis with a Shockley forward drop. It is an approximation.
 */
function rectCurve(d, C, R, w, tArr) {
  if (w.kind !== 'sine') return null;
  const nvt = d.n * VT;
  const vf = (i) => nvt * Math.log(1 + Math.max(i, 1e-9) / d.is);
  const h = 1e-6 / w.freq;
  const vs = (t) => waveValue(w, t);
  const dvs = (t) => (waveValue(w, t + h) - waveValue(w, t - h)) / (2 * h);
  const out = new Float64Array(tArr.length);
  let v = Math.max(0, waveDC(w) - 0.6);
  let on = false;
  let toff = 0;
  let voff = v;
  for (let k = 0; k < tArr.length; k++) {
    const t = tArr[k];
    if (!on) {
      const vd = voff * Math.exp(-(t - toff) / (R * C));
      if (vs(t) - vf(vd / R) > vd) on = true;
      else v = vd;
    }
    if (on) {
      let vo = v;
      for (let it = 0; it < 4; it++) vo = vs(t) - vf(C * dvs(t) + vo / R);
      const i = C * dvs(t) + vo / R;
      if (i <= 0 && k > 0) {
        on = false;
        toff = t;
        voff = v;
      } else v = vo;
    }
    out[k] = Math.max(v, 0);
  }
  return out;
}

/** Peak output and Shockley drop for a source peak Vs and load R (fixed point). */
export function rectifierPeak(vsPeak, R, d) {
  let vo = vsPeak - 0.7;
  for (let i = 0; i < 30; i++) vo = vsPeak - d.n * VT * Math.log(1 + Math.max(vo, 1e-6) / R / d.is);
  return { vout: vo, vf: vsPeak - vo };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Closed-form model for a lab circuit.
 * Returns { ok, lab, node, exact, curve(tArr), bode(f) -> {re, im} | null, summary } or { ok: false, reason }.
 */
export function theoryFor(circuit) {
  const m = matchTopology(circuit);
  if (!m.ok) return m;
  const P = m.byId;
  const w = normalizeWave(P.V1.wave);
  const base = { ok: true, lab: m.lab, node: 'out' };
  switch (m.lab) {
    case 'rc': {
      const R = P.R1.value;
      const C = P.C1.value;
      const fc = 1 / (TAU * R * C);
      return {
        ...base,
        exact: true,
        model: 'Vc(t) = V0(1 - e^(-t/RC)) for a step, exact piecewise and sine solutions otherwise',
        supported: w.kind !== 'chirp',
        curve: (t) => rcCurve(R, C, w, t),
        bode: (f) => { const x = TAU * f * R * C; const d = 1 + x * x; return { re: 1 / d, im: -x / d }; },
        summary: { tau: R * C, fc },
      };
    }
    case 'rlc': {
      const R = P.R1.value;
      const L = P.L1.value;
      const C = P.C1.value;
      const f0 = 1 / (TAU * Math.sqrt(L * C));
      const zeta = (R / 2) * Math.sqrt(C / L);
      const fpk = zeta < Math.SQRT1_2 ? f0 * Math.sqrt(1 - 2 * zeta * zeta) : null; // no peak above zeta = 0.707
      return {
        ...base,
        exact: true,
        model: 'Vc(t) from x\'\' + 2ζω0 x\' + ω0² x = ω0² u, solved in closed form',
        supported: w.kind !== 'chirp',
        curve: (t) => rlcCurve(R, L, C, w, t),
        bode: (f) => {
          const om = TAU * f;
          const hr = 1 - om * om * L * C;
          const hi = om * R * C;
          const d = hr * hr + hi * hi;
          return { re: hr / d, im: -hi / d };
        },
        summary: {
          f0,
          zeta,
          q: 1 / (2 * zeta),
          fpk,
          peakGain: zeta < Math.SQRT1_2 ? 1 / (2 * zeta * Math.sqrt(1 - zeta * zeta)) : 1,
          fd: zeta < 1 ? f0 * Math.sqrt(1 - zeta * zeta) : null,
        },
      };
    }
    case 'rect': {
      const d = { ...(DIODE[P.D1.model] || DIODE.si) };
      if (Number.isFinite(P.D1.is) && P.D1.is > 0) d.is = P.D1.is;
      if (Number.isFinite(P.D1.n) && P.D1.n > 0) d.n = P.D1.n;
      const C = P.C1.value;
      const R = P.RL.value;
      const pk = rectifierPeak(w.offset + w.amp, R, d);
      return {
        ...base,
        exact: false,
        model: 'Ideal-switch rectifier with a Shockley forward drop (approximate)',
        supported: w.kind === 'sine',
        curve: (t) => rectCurve(d, C, R, w, t),
        bode: null,
        summary: { vpeak: pk.vout, vf: pk.vf, ripple: pk.vout / (w.freq * R * C), f: w.freq },
      };
    }
    case 'inv': {
      const gain = -P.R2.value / P.R1.value;
      const rail = Number.isFinite(P.U1.rail) && P.U1.rail > 0 ? P.U1.rail : 12;
      return {
        ...base,
        exact: true,
        model: 'Vout = -(Rf/Rin) Vin, clipped at the supply rails',
        supported: true,
        curve: (t) => {
          const out = new Float64Array(t.length);
          for (let i = 0; i < t.length; i++) out[i] = Math.max(-rail, Math.min(rail, gain * waveValue(w, t[i])));
          return out;
        },
        bode: () => ({ re: gain, im: 0 }),
        summary: { gain, rail, gainDb: 20 * Math.log10(Math.abs(gain)) },
      };
    }
    case 'div': {
      const R1 = P.R1.value;
      const R2 = P.R2.value;
      const RL = P.RL.value;
      const Rp = (R2 * RL) / (R2 + RL);
      const k = Rp / (R1 + Rp);
      const vin = waveDC(w);
      return {
        ...base,
        exact: true,
        model: 'Vout = Vin R2 / (R1 + R2), loaded by RL through Rth = R1 || R2',
        supported: true,
        curve: (t) => {
          const out = new Float64Array(t.length);
          for (let i = 0; i < t.length; i++) out[i] = k * waveValue(w, t[i]);
          return out;
        },
        bode: () => ({ re: k, im: 0 }),
        summary: {
          ratio: k,
          vth: (vin * R2) / (R1 + R2),
          rth: (R1 * R2) / (R1 + R2),
          vloaded: vin * k,
          unloadedRatio: R2 / (R1 + R2),
        },
      };
    }
    default:
      return { ok: false, reason: 'Unknown lab.' };
  }
}

/** RMSE and max error between two equal-length arrays; percent is of the theory's full scale. */
export function compareCurves(sim, theory) {
  const n = Math.min(sim.length, theory.length);
  let se = 0;
  let mx = 0;
  let fs = 0;
  for (let i = 0; i < n; i++) {
    const e = sim[i] - theory[i];
    se += e * e;
    if (Math.abs(e) > mx) mx = Math.abs(e);
    if (Math.abs(theory[i]) > fs) fs = Math.abs(theory[i]);
  }
  const rmse = Math.sqrt(se / n);
  // A zero-signal theory curve has no meaningful full-scale percentage; report 0 when the
  // simulation also matches it exactly, NaN otherwise (rendered as -- by the UI).
  return {
    rmse, maxErr: mx, fullScale: fs,
    rmsePct: fs > 0 ? (100 * rmse) / fs : (mx === 0 ? 0 : NaN),
    maxPct: fs > 0 ? (100 * mx) / fs : (mx === 0 ? 0 : NaN),
  };
}

/** Frequency where an AC sweep's magnitude crosses (max gain - 3.0103 dB) nearest the passband edge, log-interpolated. */
export function minus3dB(ac) {
  // Reference the strongest visible gain and take the crossing nearest it, either direction, so
  // high-pass and bandpass shapes report a corner as well as low-pass ones.
  let k = 0;
  for (let i = 1; i < ac.mag.length; i++) if (ac.mag[i] > ac.mag[k]) k = i;
  const target = ac.mag[k] - 10 * Math.log10(2);
  let bi = -1;
  for (let i = 1; i < ac.mag.length; i++) {
    const a = ac.mag[i - 1] - target;
    const b = ac.mag[i] - target;
    if (a === 0 || a * b < 0) {
      if (bi < 0 || Math.abs(i - k) < Math.abs(bi - k)) bi = i;
    }
  }
  if (bi < 0) return NaN;
  const a = ac.mag[bi - 1];
  const b = ac.mag[bi];
  const u = a === b ? 0 : (a - target) / (a - b);
  return 10 ** (Math.log10(ac.freqs[bi - 1]) + u * (Math.log10(ac.freqs[bi]) - Math.log10(ac.freqs[bi - 1])));
}

/** Peak of an AC sweep with parabolic refinement in log frequency. */
export function acPeak(ac) {
  let k = 0;
  for (let i = 1; i < ac.mag.length; i++) if (ac.mag[i] > ac.mag[k]) k = i;
  if (k === 0 || k === ac.mag.length - 1) return { freq: ac.freqs[k], db: ac.mag[k] };
  const a = ac.mag[k - 1];
  const b = ac.mag[k];
  const c = ac.mag[k + 1];
  const den = a - 2 * b + c;
  const p = den !== 0 ? (0.5 * (a - c)) / den : 0;
  const lf = Math.log10(ac.freqs[k]) + p * (Math.log10(ac.freqs[k + 1]) - Math.log10(ac.freqs[k]));
  return { freq: 10 ** lf, db: b - 0.25 * (a - c) * p };
}

function check(name, expected, measured, unit, tolPct, absTol = 0) {
  const err = Math.abs(measured - expected);
  const pass = Number.isFinite(measured) && (err <= Math.abs(expected) * tolPct / 100 || err <= absTol);
  return { name, expected, measured, unit, tolPct, pass };
}

/**
 * Compare a simulation against the closed-form model.
 * tran: transient result ({ t, nodes }); ac: optional AC sweep result.
 */
export function verify(circuit, tran, ac) {
  const th = theoryFor(circuit);
  if (!th.ok) return th;
  if (!th.supported) return { ok: false, reason: 'The closed-form model does not cover this source shape. Try a step, square or sine.' };
  if (!tran || !tran.ok || !tran.nodes[th.node]) return { ok: false, reason: 'No transient result to compare.' };
  const curve = th.curve(tran.t);
  if (!curve) return { ok: false, reason: 'The closed-form model does not cover this source shape.' };
  const cmp = compareCurves(tran.nodes[th.node], curve);
  const checks = [];
  const s = th.summary;
  const out = tran.nodes[th.node];
  const P = Object.fromEntries(circuit.parts.map((p) => [p.id, p]));
  if (th.lab === 'rc' && ac && ac.ok) {
    const f3 = ac.refined && Number.isFinite(ac.refined.f3dB) ? ac.refined.f3dB : minus3dB(ac);
    checks.push(check('Cutoff fc (-3.01 dB)', s.fc, f3, 'Hz', 0.1));
  }
  if (th.lab === 'rc') {
    // Value at t = RC after a step from rest should be 63.2% of the step.
    const w = normalizeWave(P.V1.wave);
    if (w.kind === 'step' && w.delay === 0) {
      // Linear interpolation between the samples around t = RC.
      const x = s.tau / tran.dt;
      const i = Math.floor(x);
      if (i + 1 < out.length) {
        const v = out[i] + (x - i) * (out[i + 1] - out[i]);
        checks.push(check('Vc at t = RC (63.2%)', w.offset + w.amp * (1 - Math.exp(-1)), v, 'V', 0.5));
      }
    }
  }
  if (th.lab === 'rlc') {
    if (ac && ac.ok && Number.isFinite(s.fpk)) {
      const pk = ac.refined && Number.isFinite(ac.refined.peakFreq) ? { freq: ac.refined.peakFreq, db: ac.refined.peakDb } : acPeak(ac);
      checks.push(check('Resonant peak frequency', s.fpk, pk.freq, 'Hz', 0.1));
      checks.push(check('Peak gain', 20 * Math.log10(s.peakGain), pk.db, 'dB', 0.1, 0.01));
    }
    const w = normalizeWave(P.V1.wave);
    if (w.kind === 'step' && s.zeta < 1) {
      // Overshoot is a percentage of the step amplitude. A zero-amplitude step has no
      // defined overshoot; a negative step must be measured relative to its own direction.
      if (w.amp === 0) {
        checks.push({ name: 'Step overshoot', expected: NaN, measured: NaN, unit: '%', tolPct: 0, pass: true, skipped: true, note: 'N/A (zero step)' });
      } else {
        const os = Math.exp((-Math.PI * s.zeta) / Math.sqrt(1 - s.zeta * s.zeta));
        let extreme = w.amp > 0 ? -Infinity : Infinity;
        for (const v of out) extreme = w.amp > 0 ? Math.max(extreme, v) : Math.min(extreme, v);
        const measured = (100 * Math.abs(extreme - w.offset - w.amp)) / Math.abs(w.amp);
        checks.push(check('Step overshoot', 100 * os, measured, '%', 2, 0.05));
      }
    }
  }
  if (th.lab === 'rect') {
    const n = out.length;
    const per = Math.round(1 / s.f / tran.dt);
    const start = Math.max(0, n - per);
    let mx = -Infinity;
    let mn = Infinity;
    for (let i = start; i < n; i++) { mx = Math.max(mx, out[i]); mn = Math.min(mn, out[i]); }
    const vin = tran.nodes.in;
    let vinPk = -Infinity;
    for (let i = start; i < n; i++) vinPk = Math.max(vinPk, vin[i]);
    checks.push(check('Forward drop at peak', s.vf, vinPk - mx, 'V', 0, 0.05));
    checks.push(check('Peak output (Shockley at load current)', s.vpeak, mx, 'V', 2));
    // The Vp / (f R C) ripple estimate only holds when RC is long compared with one period.
    if (s.ripple < 0.2 * s.vpeak) checks.push(check('Ripple (Vp / f R C estimate)', s.ripple, mx - mn, 'V', 20));
  }
  if (th.lab === 'inv') {
    if (ac && ac.ok) {
      const g = 10 ** (ac.mag[Math.floor(ac.mag.length / 2)] / 20);
      checks.push(check('|Gain| = Rf / Rin', Math.abs(s.gain), g, 'V/V', 0.1));
      const ph = ((ac.phase[Math.floor(ac.phase.length / 2)] % 360) + 360) % 360;
      checks.push(check('Phase inversion', 180, ph, 'deg', 0.1, 0.05));
    }
    let mx = 0;
    for (const v of out) mx = Math.max(mx, Math.abs(v));
    checks.push({ name: 'Output stays within rails', expected: s.rail, measured: mx, unit: 'V', tolPct: 0, pass: mx <= s.rail + 1e-9 });
  }
  if (th.lab === 'div') {
    const vin = tran.nodes.in;
    checks.push(check('Loaded Vout', s.ratio * vin[0], out[0], 'V', 1e-6, 1e-9));
  }
  const allChecksPass = checks.every((c) => c && c.pass);
  const exact = !!(th && th.exact);
  const rmseOk = exact ? cmp.rmsePct < 0.5 : cmp.rmsePct < 1;
  return {
    ok: true,
    lab: th.lab,
    node: th.node,
    exact: th.exact,
    model: th.model,
    curve,
    summary: s,
    ...cmp,
    checks,
    pass: allChecksPass && rmseOk,
  };
}
