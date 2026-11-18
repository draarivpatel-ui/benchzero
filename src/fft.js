// Radix-2 Cooley-Tukey FFT and scope signal metrics. Pure Float64Array code.

/** In-place iterative radix-2 FFT. re and im must have the same power-of-two length. */
export function fft(re, im) {
  const n = re.length;
  if (n !== im.length || n < 2 || (n & (n - 1)) !== 0) throw new Error('fft length must be a power of two');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export function prevPow2(n) {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}

export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/**
 * Single-sided amplitude spectrum of a real signal sampled at fs.
 * Uses the last power-of-two block of samples (the steady-state end of a transient run),
 * removes the mean (AC coupling), applies a Hann window and corrects its coherent gain,
 * so a sine of amplitude A reads A (and 20*log10(A / fullScale) dBFS) at its peak bin.
 */
export function spectrum(signal, fs, opts = {}) {
  const N = Math.min(prevPow2(signal.length), opts.maxN || 16384);
  if (N < 8) return null;
  const start = signal.length - N;
  let mean = 0;
  for (let i = 0; i < N; i++) mean += signal[start + i];
  mean /= N;
  const w = hann(N);
  let wsum = 0;
  let w2 = 0;
  for (let i = 0; i < N; i++) { wsum += w[i]; w2 += w[i] * w[i]; }
  // Equivalent noise bandwidth in bins (1.5 for Hann): summed band power / enbw = tone power.
  const enbw = (N * w2) / (wsum * wsum);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = (signal[start + i] - mean) * w[i];
  fft(re, im);
  const M = N / 2 + 1;
  const amp = new Float64Array(M);
  const power = new Float64Array(M);
  for (let k = 0; k < M; k++) {
    const a = Math.hypot(re[k], im[k]) * (k === 0 || k === N / 2 ? 1 : 2) / wsum;
    amp[k] = a;
    power[k] = a * a;
  }
  let fullScale = opts.fullScale;
  if (!(fullScale > 0)) {
    let mx = 0;
    for (let k = 1; k < M; k++) mx = Math.max(mx, amp[k]);
    fullScale = mx > 0 ? mx : 1;
  }
  const db = new Float64Array(M);
  for (let k = 0; k < M; k++) db[k] = 20 * Math.log10(Math.max(amp[k] / fullScale, 1e-12));
  const binHz = fs / N;
  return { N, fs, binHz, amp, power, db, mean, fullScale, enbw, peak: findPeak(amp, binHz) };
}

/**
 * Coherent spectrum of a periodic signal: takes exactly `cycles` periods starting at i0, resamples
 * them (linear interpolation, about 1e-6 relative error at 1000 samples per cycle) onto a
 * power-of-two grid, and uses a rectangular window. With whole periods there is no leakage, so
 * harmonics land on exact bins (bin = cycles * harmonic number).
 */
export function spectrumCoherent(signal, fs, i0, len, opts = {}) {
  if (len < 16 || i0 < 0 || i0 + len > signal.length - 1 + 1e-9) return null;
  let M = 1;
  while (M < len) M *= 2;
  M = Math.min(M, opts.maxN || 16384);
  const re = new Float64Array(M);
  const im = new Float64Array(M);
  let mean = 0;
  for (let k = 0; k < M; k++) {
    const x = i0 + (k * len) / M;
    const j = Math.floor(x);
    const f = x - j;
    const v = j + 1 < signal.length ? signal[j] * (1 - f) + signal[j + 1] * f : signal[signal.length - 1];
    re[k] = v;
    mean += v;
  }
  mean /= M;
  for (let k = 0; k < M; k++) re[k] -= mean;
  fft(re, im);
  const half = M / 2 + 1;
  const amp = new Float64Array(half);
  const power = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    const a = (Math.hypot(re[k], im[k]) * (k === 0 || k === M / 2 ? 1 : 2)) / M;
    amp[k] = a;
    power[k] = a * a;
  }
  let fullScale = opts.fullScale;
  if (!(fullScale > 0)) {
    let mx = 0;
    for (let k = 1; k < half; k++) mx = Math.max(mx, amp[k]);
    fullScale = mx > 0 ? mx : 1;
  }
  const db = new Float64Array(half);
  for (let k = 0; k < half; k++) db[k] = 20 * Math.log10(Math.max(amp[k] / fullScale, 1e-12));
  const binHz = fs / len;
  let k = 1;
  for (let i = 2; i < half; i++) if (amp[i] > amp[k]) k = i;
  return { N: M, fs: binHz * M, binHz, amp, power, db, mean, fullScale, enbw: 1, coherent: true, peak: { freq: k * binHz, amp: amp[k], bin: k } };
}

/** Largest non-DC bin, refined by parabolic interpolation on the log magnitude. */
export function findPeak(amp, binHz) {
  let k = -1;
  let best = 0;
  for (let i = 2; i < amp.length - 1; i++) {
    if (amp[i] > best) { best = amp[i]; k = i; }
  }
  if (k < 0 || best <= 0) return { freq: NaN, amp: 0, bin: -1 };
  const a = Math.log(Math.max(amp[k - 1], 1e-300));
  const b = Math.log(amp[k]);
  const c = Math.log(Math.max(amp[k + 1], 1e-300));
  const den = a - 2 * b + c;
  const p = den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
  const peakAmp = Math.exp(b - 0.25 * (a - c) * p);
  return { freq: (k + p) * binHz, amp: peakAmp, bin: k };
}

/**
 * Total harmonic distortion from a spectrum, given the fundamental frequency.
 * Power is summed over +/- 3 bins around each harmonic (Hann main lobe is +/- 2 bins).
 */
export function thd(spec, f0, maxHarmonics = 10) {
  if (!spec || !(f0 > 0)) return { ratio: NaN, percent: NaN, db: NaN, harmonics: [] };
  // Coherent spectra put each harmonic on one exact bin; windowed ones spread it over +/- 3 bins.
  const w = spec.coherent ? 0 : 3;
  const band = (f) => {
    const c = Math.round(f / spec.binHz);
    let s = 0;
    for (let k = Math.max(1, c - w); k <= Math.min(spec.power.length - 1, c + w); k++) s += spec.power[k];
    return s;
  };
  const p1 = band(f0);
  const enbw = spec.enbw || 1.5;
  const harmonics = [{ n: 1, freq: f0, amp: Math.sqrt(p1 / enbw) }];
  let ph = 0;
  for (let h = 2; h <= maxHarmonics; h++) {
    const f = h * f0;
    if (f + w * spec.binHz >= spec.fs / 2) break;
    const p = band(f);
    harmonics.push({ n: h, freq: f, amp: Math.sqrt(p / enbw) });
    ph += p;
  }
  const ratio = p1 > 0 ? Math.sqrt(ph / p1) : NaN;
  return { ratio, percent: 100 * ratio, db: 20 * Math.log10(Math.max(ratio, 1e-12)), harmonics };
}

/**
 * Scope measurements over a window [i0, i1) of a uniformly sampled signal.
 * duty is the fraction of samples above the mid level (NaN for a flat trace).
 */
export function measure(signal, fs, opts = {}) {
  const i0 = Math.max(0, opts.i0 || 0);
  const i1 = Math.min(signal.length, opts.i1 || signal.length);
  const n = i1 - i0;
  if (n <= 0) return null;
  let mn = Infinity;
  let mx = -Infinity;
  let s = 0;
  let s2 = 0;
  for (let i = i0; i < i1; i++) {
    const v = signal[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    s += v;
    s2 += v * v;
  }
  const mean = s / n;
  const rms = Math.sqrt(s2 / n);
  const acRms = Math.sqrt(Math.max(0, s2 / n - mean * mean));
  const vpp = mx - mn;
  const flat = vpp <= 1e-9 * Math.max(1, Math.abs(mx), Math.abs(mn));
  let duty = NaN;
  if (!flat) {
    const mid = (mx + mn) / 2;
    let hi = 0;
    for (let i = i0; i < i1; i++) if (signal[i] > mid) hi++;
    duty = hi / n;
  }
  // Frequency from rising crossings of the mean level, with hysteresis of 5% of Vpp,
  // interpolated between samples. Needs at least two rising crossings in the window.
  let freq = NaN;
  if (!flat) {
    const hyst = 0.05 * vpp;
    let armed = false;
    let first = NaN;
    let last = NaN;
    let count = 0;
    for (let i = i0 + 1; i < i1; i++) {
      const v = signal[i];
      if (v < mean - hyst) armed = true;
      if (armed && signal[i - 1] < mean && v >= mean) {
        const tc = i - 1 + (mean - signal[i - 1]) / (v - signal[i - 1]);
        if (count === 0) first = tc;
        last = tc;
        count++;
        armed = false;
      }
    }
    if (count >= 2) freq = ((count - 1) * fs) / (last - first);
  }
  return { min: mn, max: mx, vpp, mean, rms, acRms, duty, freq };
}
