// One full lab run: transient, AC sweep, scope measurements, spectra and the theory check.
// Pure function shared by the Web Worker, the synchronous fallback and the tests.

import { transient, acSweep, logFreqs } from './mna.js';
import { spectrum, spectrumCoherent, thd, measure } from './fft.js';
import { verify, theoryFor } from './theory.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function periodic(circuit) {
  const v1 = circuit.parts.find((p) => p.type === 'V');
  return !!(v1 && v1.wave && ['sine', 'square', 'triangle'].includes(v1.wave.kind));
}

function steadyStart(tran, circuit) {
  // Measure the last half of the window, where start-up transients have mostly settled.
  const v1 = circuit.parts.find((p) => p.type === 'V');
  const n = tran.t.length;
  if (v1 && v1.wave && ['sine', 'square', 'triangle'].includes(v1.wave.kind)) {
    const per = Math.max(1, Math.round(1 / v1.wave.freq / tran.dt));
    const cycles = Math.floor((n * 0.6) / per);
    if (cycles >= 1) return n - cycles * per;
  }
  return 0;
}

export function computeLab(circuit) {
  const t0 = now();
  const tran = transient(circuit, circuit.sim || {});
  if (!tran.ok) return { ok: false, error: tran.error, ms: now() - t0 };
  const fs = 1 / tran.dt;
  const probes = circuit.probes || {};
  const i0 = steadyStart(tran, circuit);
  const chans = {};
  for (const ch of ['ch1', 'ch2']) {
    const node = probes[ch];
    const sig = node === '0' ? new Float64Array(tran.t.length) : tran.nodes[node];
    if (!sig) continue;
    const m = measure(sig, fs, { i0 });
    // Whole-cycle (coherent) spectrum for periodic drive; Hann-windowed tail otherwise.
    let spec = null;
    if (periodic(circuit) && i0 > 0) {
      // Exact (fractional) number of samples in the whole cycles, so no period is cut short.
      const f = circuit.parts.find((p) => p.type === 'V').wave.freq;
      const cycles = Math.floor(0.6 * (sig.length - 1) * f * tran.dt);
      const len = cycles / (f * tran.dt);
      if (cycles >= 1) spec = spectrumCoherent(sig, fs, sig.length - 1 - len, len);
    }
    if (!spec) spec = spectrum(sig, fs);
    const f0 = Number.isFinite(m.freq) ? m.freq : spec && spec.peak.freq;
    chans[ch] = {
      node,
      metrics: m,
      spectrum: spec ? { binHz: spec.binHz, db: spec.db, amp: spec.amp, N: spec.N, peak: spec.peak, fullScale: spec.fullScale, enbw: spec.enbw, coherent: !!spec.coherent } : null,
      thd: spec && Number.isFinite(m.freq) ? thd(spec, f0, 10) : null,
    };
  }
  // Math trace: instantaneous power V*I in the chosen part.
  let math = null;
  const mp = circuit.math && circuit.parts.find((p) => p.id === circuit.math);
  if (mp) {
    const va = mp.nodes[0] === '0' ? null : tran.nodes[mp.nodes[0]];
    const vb = mp.nodes[1] === '0' ? null : tran.nodes[mp.nodes[1]];
    const cur = tran.currents[mp.id];
    const p = new Float64Array(tran.t.length);
    for (let i = 0; i < p.length; i++) p[i] = ((va ? va[i] : 0) - (vb ? vb[i] : 0)) * cur[i];
    math = { part: mp.id, power: p };
  }
  let ac = null;
  if (circuit.ac && circuit.parts.some((p) => p.type === 'V')) {
    const src = circuit.parts.find((p) => p.id === 'V1' && p.type === 'V') || circuit.parts.find((p) => p.type === 'V');
    const out = probes.ch1 && probes.ch1 !== '0' ? probes.ch1 : null;
    if (out && tran.nodes[out]) {
      const freqs = logFreqs(circuit.ac.fstart, circuit.ac.fstop, 60);
      ac = acSweep(circuit, { source: src.id, out, freqs });
      if (ac.ok) {
        ac.source = src.id;
        ac.refined = refineAC(circuit, ac, src.id, out);
      }
      ac.out = out;
    }
  }
  const tv = now();
  const ver = verify(circuit, tran, ac && ac.ok ? ac : null);
  let bodeTheory = null;
  const th = theoryFor(circuit);
  if (th.ok && th.bode && ac && ac.ok && ac.out === th.node) {
    const mag = new Float64Array(ac.freqs.length);
    const phase = new Float64Array(ac.freqs.length);
    for (let i = 0; i < ac.freqs.length; i++) {
      const h = th.bode(ac.freqs[i]);
      mag[i] = 20 * Math.log10(Math.max(Math.hypot(h.re, h.im), 1e-300));
      phase[i] = (Math.atan2(h.im, h.re) * 180) / Math.PI;
    }
    for (let i = 1; i < phase.length; i++) {
      while (phase[i] - phase[i - 1] > 180) phase[i] -= 360;
      while (phase[i] - phase[i - 1] < -180) phase[i] += 360;
    }
    // Match the simulated phase branch so the overlay sits on the same wrap.
    if (ac.phase.length) {
      const shift = Math.round((ac.phase[0] - phase[0]) / 360) * 360;
      for (let i = 0; i < phase.length; i++) phase[i] += shift;
    }
    bodeTheory = { mag, phase };
  }
  return {
    ok: true,
    tran,
    ac,
    chans,
    math,
    verify: ver,
    bodeTheory,
    timing: { tran: tran.stats.ms, ac: ac && ac.ok ? ac.ms : 0, theory: now() - tv, total: now() - t0 },
  };
}

/**
 * Refine the -3 dB crossing and the resonant peak of a sweep by re-solving the AC system at
 * single frequencies (bisection for the crossing, golden-section search for the peak).
 */
export function refineAC(circuit, ac, source, out) {
  const at = (f) => {
    const r = acSweep(circuit, { source, out, freqs: [f] });
    return r.ok ? r.mag[0] : NaN;
  };
  const res = { f3dB: NaN, peakFreq: NaN, peakDb: NaN };
  // Reference is the low-frequency (passband) gain, taken four decades below the sweep start.
  const ref = at(ac.freqs[0] * 1e-4);
  const target = ref - 10 * Math.log10(2);
  res.refDb = ref;
  for (let i = 1; i < ac.mag.length; i++) {
    if (ac.mag[i - 1] > target && ac.mag[i] <= target && Number.isFinite(ref)) {
      let lo = Math.log10(ac.freqs[i - 1]);
      let hi = Math.log10(ac.freqs[i]);
      for (let k = 0; k < 50; k++) {
        const mid = (lo + hi) / 2;
        if (at(10 ** mid) > target) lo = mid; else hi = mid;
      }
      res.f3dB = 10 ** ((lo + hi) / 2);
      break;
    }
  }
  let k = 0;
  for (let i = 1; i < ac.mag.length; i++) if (ac.mag[i] > ac.mag[k]) k = i;
  if (k > 0 && k < ac.mag.length - 1) {
    let a = Math.log10(ac.freqs[k - 1]);
    let b = Math.log10(ac.freqs[k + 1]);
    const g = (Math.sqrt(5) - 1) / 2;
    for (let it = 0; it < 60; it++) {
      const c = b - g * (b - a);
      const d = a + g * (b - a);
      if (at(10 ** c) > at(10 ** d)) b = d; else a = c;
    }
    res.peakFreq = 10 ** ((a + b) / 2);
    res.peakDb = at(res.peakFreq);
  }
  return res;
}
