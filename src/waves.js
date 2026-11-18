// Independent source waveforms shared by the solver (as stimulus) and the theory module
// (as the same stimulus). This file defines inputs only; it contains no circuit solving.

export const WAVE_KINDS = ['dc', 'sine', 'square', 'triangle', 'step', 'chirp'];

const TAU = 2 * Math.PI;

/** Fill in defaults so every wave has every field. */
export function normalizeWave(w = {}) {
  const kind = WAVE_KINDS.includes(w.kind) ? w.kind : 'dc';
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  return {
    kind,
    amp: num(w.amp, kind === 'dc' ? 0 : 1),
    offset: num(w.offset, 0),
    freq: Math.max(1e-3, num(w.freq, 1000)),
    phase: num(w.phase, 0), // degrees, sine only
    duty: Math.min(0.99, Math.max(0.01, num(w.duty, 0.5))),
    delay: Math.max(0, num(w.delay, 0)),
    f2: Math.max(1e-3, num(w.f2, 10 * num(w.freq, 1000))), // chirp end frequency
    sweep: Math.max(1e-6, num(w.sweep, 0.01)), // chirp sweep time (s)
  };
}

/**
 * Source value at time t. side = -1 returns the left limit at a discontinuity,
 * side = +1 (default) the right limit. For t < 0 the source holds its t = 0- value.
 */
export function waveValue(w, t, side = 1) {
  const eps = 1e-12 * Math.max(1 / w.freq, 1e-9);
  const tt = t + (side < 0 ? -eps : eps);
  switch (w.kind) {
    case 'dc':
      return w.offset;
    case 'step':
      return tt > w.delay ? w.offset + w.amp : w.offset;
    case 'sine': {
      if (tt < w.delay) return w.offset + w.amp * Math.sin((w.phase * Math.PI) / 180);
      return w.offset + w.amp * Math.sin(TAU * w.freq * (tt - w.delay) + (w.phase * Math.PI) / 180);
    }
    case 'square': {
      if (tt < w.delay) return w.offset - w.amp;
      const T = 1 / w.freq;
      const ph = ((tt - w.delay) % T + T) % T;
      return ph < w.duty * T ? w.offset + w.amp : w.offset - w.amp;
    }
    case 'triangle': {
      // Starts at the low level, rises for half a period, falls for the other half.
      const T = 1 / w.freq;
      if (tt < w.delay) return w.offset - w.amp;
      const ph = (((tt - w.delay) % T) + T) % T / T;
      const tri = ph < 0.5 ? -1 + 4 * ph : 3 - 4 * ph;
      return w.offset + w.amp * tri;
    }
    case 'chirp': {
      // Linear chirp; the phase is the integral of the instantaneous frequency.
      if (tt < w.delay) return w.offset;
      const T = w.sweep;
      const x = Math.min(tt - w.delay, T);
      const k = (w.f2 - w.freq) / T;
      let phi = TAU * (w.freq * x + 0.5 * k * x * x);
      if (tt - w.delay > T) phi += TAU * w.f2 * (tt - w.delay - T);
      return w.offset + w.amp * Math.sin(phi);
    }
    default:
      return 0;
  }
}

/** Instantaneous frequency of a chirp (for display and tests). */
export function chirpFreqAt(w, t) {
  const x = Math.min(Math.max(t - w.delay, 0), w.sweep);
  return w.freq + ((w.f2 - w.freq) * x) / w.sweep;
}

/** The DC level the source has before t = 0 (used for operating points and AC linearization). */
export function waveDC(w) {
  return waveValue(w, 0, -1);
}

/** Times in (0, tstop] (and t = 0 itself) where the waveform jumps. */
export function waveBreakpoints(w, tstop) {
  const out = [];
  if (w.kind === 'step') {
    if (w.delay <= tstop) out.push(w.delay);
  } else if (w.kind === 'square') {
    const T = 1 / w.freq;
    const n = Math.ceil((tstop - w.delay) / T) + 1;
    if (n > 200000) return out; // absurd frequency for the window; the step grid samples it
    for (let k = 0; k < n; k++) {
      const a = w.delay + k * T;
      const b = a + w.duty * T;
      if (a <= tstop) out.push(a);
      if (b <= tstop) out.push(b);
    }
  }
  return out;
}
