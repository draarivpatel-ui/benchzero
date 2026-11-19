// WebAudio features: trace sonification (pitch follows voltage) and the acoustic lab
// (stepped-sine speaker-to-mic frequency response, with a clearly labelled simulated loopback
// when no microphone is available).

const AC = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;

export const SONIFY_LOW = 220;
export const SONIFY_HIGH = 880;

/** Map a value in [lo, hi] to 220..880 Hz on a log (musical) scale: two octaves. */
function pitchFor(v, lo, hi) {
  if (!(hi > lo)) return Math.sqrt(SONIFY_LOW * SONIFY_HIGH);
  const u = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  return SONIFY_LOW * (SONIFY_HIGH / SONIFY_LOW) ** u;
}

export class Sonifier {
  constructor() {
    this.ctx = null;
    this.nodes = null;
    this.start = 0;
    this.duration = 0;
  }

  get supported() { return !!AC; }
  get playing() { return !!this.nodes; }

  /** Progress 0..1 of the current playback, or null when idle. */
  progress() {
    if (!this.nodes || !this.ctx) return null;
    const p = (this.ctx.currentTime - this.start) / this.duration;
    if (p >= 1) { this.stop(); return null; }
    return Math.max(0, p);
  }

  /** Play a trace left to right over `duration` seconds. Pitch follows voltage, pan follows time. */
  play(data, duration = 3) {
    if (!AC || !data || data.length < 2) return false;
    this.stop();
    if (!this.ctx) this.ctx = new AC();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const ctx = this.ctx;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < data.length; i++) { lo = Math.min(lo, data[i]); hi = Math.max(hi, data[i]); }
    const n = 512;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) curve[i] = pitchFor(data[Math.round((i / (n - 1)) * (data.length - 1))], lo, hi);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    const gain = ctx.createGain();
    const t0 = ctx.currentTime + 0.05;
    gain.gain.setValueAtTime(0, t0 - 0.05);
    gain.gain.linearRampToValueAtTime(0.16, t0 + 0.04);
    gain.gain.setValueAtTime(0.16, t0 + duration - 0.08);
    gain.gain.linearRampToValueAtTime(0, t0 + duration);
    osc.frequency.setValueAtTime(curve[0], t0);
    osc.frequency.setValueCurveAtTime(curve, t0, duration);
    let last = gain;
    let pan = null;
    if (ctx.createStereoPanner) {
      pan = ctx.createStereoPanner();
      pan.pan.setValueAtTime(-0.8, t0);
      pan.pan.linearRampToValueAtTime(0.8, t0 + duration);
      gain.connect(pan);
      last = pan;
    }
    osc.connect(gain);
    last.connect(ctx.destination);
    osc.start(t0 - 0.05);
    osc.stop(t0 + duration + 0.02);
    this.nodes = { osc, gain, pan };
    this.start = t0;
    this.duration = duration;
    osc.onended = () => { if (this.nodes && this.nodes.osc === osc) this.nodes = null; };
    return { lo, hi };
  }

  stop() {
    if (!this.nodes) return;
    const { osc, gain, pan } = this.nodes;
    this.nodes = null;
    try { osc.stop(); } catch { /* already stopped */ }
    try { osc.disconnect(); gain.disconnect(); if (pan) pan.disconnect(); } catch { /* ignore */ }
  }
}

/**
 * Acoustic lab. Plays a stepped sine sweep (100 Hz to 10 kHz) and reads the level at each tone
 * from an AnalyserNode. With a microphone, that is the real speaker-room-mic response. Without
 * one, the tones run through a silent simulated chain (speaker high-pass, a presence peak and a
 * mic roll-off, plus noise) and every view says SIMULATED.
 */
export class AcousticLab {
  constructor() {
    this.ctx = null;
    this.running = false;
    this.simulated = false;
    this.response = [];
    this.tone = 0;
    this.status = '';
    this.timer = null;
    this.parts = [];
  }

  get supported() { return !!AC; }

  async start() {
    if (!AC) { this.status = 'WebAudio is not available in this browser.'; return false; }
    this.stop();
    this.ctx = new AC();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const ctx = this.ctx;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 8192;
    this.analyser.smoothingTimeConstant = 0.2;
    this.osc = ctx.createOscillator();
    this.osc.type = 'sine';
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.osc.connect(this.out);
    let stream = null;
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('no mic api');
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch {
      stream = null;
    }
    if (!this.ctx) return false; // stopped while waiting for permission
    if (stream) {
      this.simulated = false;
      this.stream = stream;
      const mic = ctx.createMediaStreamSource(stream);
      mic.connect(this.analyser);
      this.out.connect(ctx.destination); // tones play through the speakers
      this.status = 'Measuring speaker to microphone';
      this.parts.push(mic);
    } else {
      this.simulated = true;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 140; hp.Q.value = 0.9;
      const pk = ctx.createBiquadFilter();
      pk.type = 'peaking'; pk.frequency.value = 2800; pk.Q.value = 1.4; pk.gain.value = 6;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 7000; lp.Q.value = 0.7;
      const noise = ctx.createBufferSource();
      const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * 0.001;
      noise.buffer = buf;
      noise.loop = true;
      this.out.connect(hp); hp.connect(pk); pk.connect(lp); lp.connect(this.analyser);
      noise.connect(this.analyser);
      noise.start();
      // Keep the graph pulled without making any sound.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      this.analyser.connect(mute); mute.connect(ctx.destination);
      this.parts.push(hp, pk, lp, noise, mute);
      this.status = 'No microphone, so this is a simulated loopback';
    }
    if (ctx.state !== 'running') {
      try { await ctx.resume(); } catch { /* blocked */ }
    }
    if (ctx.state !== 'running') {
      this.status = 'The browser blocked audio. Click Acoustic Lab again.';
      this.stop();
      return false;
    }
    this.osc.start();
    this.running = true;
    this.response = [];
    this._sweep();
    return true;
  }

  _sweep() {
    const freqs = [];
    const n = 24;
    for (let i = 0; i < n; i++) freqs.push(100 * 100 ** (i / (n - 1)));
    let i = 0;
    let settled = false;
    const next = () => {
      if (!settled) {
        // Let the graph and the microphone settle before the first reading.
        settled = true;
        this.timer = setTimeout(next, 350);
        return;
      }
      if (!this.running || !this.ctx) return;
      if (i >= freqs.length) {
        this.tone = 0;
        this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.01);
        this.status = this.simulated ? 'Simulated sweep done' : 'Sweep done';
        return;
      }
      const f = freqs[i];
      this.tone = f;
      const t = this.ctx.currentTime;
      this.osc.frequency.setValueAtTime(f, t);
      this.out.gain.setTargetAtTime(this.simulated ? 0.5 : 0.12, t, 0.01);
      this.timer = setTimeout(() => {
        if (!this.running || !this.analyser) return;
        const spec = new Float32Array(this.analyser.frequencyBinCount);
        this.analyser.getFloatFrequencyData(spec);
        const bin = this.ctx.sampleRate / 2 / spec.length;
        const k = Math.round(f / bin);
        let db = -Infinity;
        for (let j = Math.max(0, k - 3); j <= Math.min(spec.length - 1, k + 3); j++) db = Math.max(db, spec[j]);
        if (Number.isFinite(db)) this.response.push({ f, db });
        i++;
        next();
      }, 170);
    };
    next();
  }

  /** Current live data for the scope's acoustic view. */
  frame() {
    if (!this.analyser || !this.ctx) return { response: this.response, simulated: this.simulated, status: this.status };
    const wave = new Float32Array(2048);
    this.analyser.getFloatTimeDomainData(wave);
    const spec = new Float32Array(this.analyser.frequencyBinCount);
    this.analyser.getFloatFrequencyData(spec);
    return { wave, spec, sampleRate: this.ctx.sampleRate, response: this.response, tone: this.tone, simulated: this.simulated, status: this.status };
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    try { if (this.osc) this.osc.stop(); } catch { /* not started */ }
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    for (const p of this.parts) { try { p.disconnect(); } catch { /* ignore */ } }
    this.parts = [];
    if (this.ctx) { try { this.ctx.close(); } catch { /* ignore */ } }
    this.ctx = null;
    this.analyser = null;
    this.osc = null;
    this.tone = 0;
  }
}
