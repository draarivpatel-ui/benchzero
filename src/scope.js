// Digital storage oscilloscope canvas: time domain (CH1, CH2, theory, math, cursors, trigger),
// FFT spectrum with harmonic markers, Bode plot, and the acoustic lab view.

import { formatSI } from './units.js';
import { roundRect } from './schematic.js';

export const C = {
  bg: '#060a0e',
  grid: 'rgba(120, 144, 168, 0.16)',
  gridStrong: 'rgba(120, 144, 168, 0.34)',
  text: '#93a1b3',
  bright: '#e6edf5',
  ch1: '#22d3ee',
  ch2: '#f59e0b',
  theory: '#10b981',
  math: '#a78bfa',
  cursor: 'rgba(226, 232, 240, 0.75)',
  warn: '#fbbf24',
};

const MONO = '500 11px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const DIV_X = 10;
const DIV_Y = 8;

/** Smallest 1-2-5 step that is at least x. */
export function niceStep(x) {
  if (!(x > 0) || !Number.isFinite(x)) return 1;
  const e = Math.floor(Math.log10(x));
  const b = x / 10 ** e;
  const m = b <= 1 + 1e-9 ? 1 : b <= 2 + 1e-9 ? 2 : b <= 5 + 1e-9 ? 5 : 10;
  return m * 10 ** e;
}

/** Vertical scale for a trace: units per division and the division where zero sits. */
export function autoScale(arr) {
  let mn = Infinity;
  let mx = -Infinity;
  for (let i = 0; i < arr.length; i++) { const v = arr[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  if (!Number.isFinite(mn)) return { per: 1, zero: 0 };
  const span = Math.max(Math.abs(mn), Math.abs(mx));
  if (span < 1e-12) return { per: 1e-3, zero: 0 };
  if (mn >= -0.02 * span) return { per: niceStep(mx / 6.6), zero: -3 };
  if (mx <= 0.02 * span) return { per: niceStep(-mn / 6.6), zero: 3 };
  return { per: niceStep(span / 3.6), zero: 0 };
}

export class Scope {
  constructor(canvas, handlers = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.h = handlers;
    this.view = 'dso';
    this.result = null;
    this.circuit = null;
    this.flags = { ch1: true, ch2: true, theory: true, math: false };
    this.sweep = null; // 0..1 beam position, or null for a full static trace
    this.playhead = null; // sonification playhead 0..1
    this.cursors = { t: [0.2, 0.6], v: [0.25, -0.25] }; // t as window fraction, v in CH1 divisions/4
    this.drag = null;
    this.acoustic = null;
    this.error = null;
    this._bind();
  }

  setResult(result, circuit) {
    this.circuit = circuit;
    if (result && result.ok) {
      this.result = result;
      this.error = null;
      this._scales();
    } else {
      // Never leave stale traces under an error: they would look like a valid result.
      this.error = result && result.error ? result.error : null;
      this.result = null;
    }
  }

  setView(v) { this.view = v; }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.dpr = dpr;
    this.W = r.width;
    this.H = r.height;
    const padL = 12;
    const padR = 12;
    const padT = 12;
    const padB = 30;
    this.plot = { x: padL, y: padT, w: this.W - padL - padR, h: this.H - padT - padB };
  }

  _scales() {
    const r = this.result;
    const tr = r.tran;
    const ch = (k) => r.chans[k] && tr.nodes[r.chans[k].node];
    const s = {};
    if (ch('ch1')) s.ch1 = autoScale(tr.nodes[r.chans.ch1.node]);
    if (ch('ch2')) s.ch2 = autoScale(tr.nodes[r.chans.ch2.node]);
    if (r.math) s.math = autoScale(r.math.power);
    this.scales = s;
  }

  /** Scale and samples for each visible time-domain trace. */
  traces() {
    const r = this.result;
    if (!r) return [];
    const tr = r.tran;
    const out = [];
    const probes = (this.circuit && this.circuit.probes) || {};
    for (const k of ['ch1', 'ch2']) {
      const n = probes[k];
      if (this.flags[k] && n && tr.nodes[n] && this.scales[k]) out.push({ key: k, node: n, data: tr.nodes[n], scale: this.scales[k], color: C[k] });
    }
    if (this.flags.theory && r.verify && r.verify.ok) {
      const node = r.verify.node;
      const k = probes.ch1 === node ? 'ch1' : probes.ch2 === node ? 'ch2' : null;
      const sc = k ? this.scales[k] : autoScale(r.verify.curve);
      out.push({ key: 'theory', node, data: r.verify.curve, scale: sc, color: C.theory, dashed: true });
    }
    if (this.flags.math && r.math && this.scales.math) out.push({ key: 'math', node: r.math.part, data: r.math.power, scale: this.scales.math, color: C.math });
    return out;
  }

  /* ---------------- interaction (cursors) ---------------- */

  _bind() {
    const c = this.canvas;
    const local = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    c.addEventListener('pointerdown', (e) => {
      if (this.view !== 'dso' || !this.result) return;
      const [x, y] = local(e);
      const P = this.plot;
      let best = null;
      let bd = 10;
      this.cursors.t.forEach((f, i) => { const d = Math.abs(x - (P.x + f * P.w)); if (d < bd) { bd = d; best = { kind: 't', i }; } });
      this.cursors.v.forEach((f, i) => { const d = Math.abs(y - this._vy(f)); if (d < bd) { bd = d; best = { kind: 'v', i }; } });
      if (best) { this.drag = best; c.setPointerCapture(e.pointerId); e.preventDefault(); }
    });
    c.addEventListener('pointermove', (e) => {
      const [x, y] = local(e);
      const P = this.plot;
      if (!this.drag) {
        if (this.view !== 'dso') { c.style.cursor = 'default'; return; }
        const nearT = this.cursors.t.some((f) => Math.abs(x - (P.x + f * P.w)) < 10);
        const nearV = this.cursors.v.some((f) => Math.abs(y - this._vy(f)) < 10);
        c.style.cursor = nearT ? 'ew-resize' : nearV ? 'ns-resize' : 'default';
        return;
      }
      if (this.drag.kind === 't') this.cursors.t[this.drag.i] = Math.max(0, Math.min(1, (x - P.x) / P.w));
      else this.cursors.v[this.drag.i] = Math.max(-1, Math.min(1, -((y - P.y - P.h / 2) / (P.h / 2))));
      if (this.h.onCursor) this.h.onCursor(this.cursorReadout());
    });
    const end = () => { this.drag = null; };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  _vy(f) { const P = this.plot; return P.y + P.h / 2 - f * (P.h / 2); }

  /** Cursor measurements: dt, 1/dt, dV (CH1 units) and CH1 values at both time cursors. */
  cursorReadout() {
    if (!this.result) return null;
    const tr = this.result.tran;
    const T = tr.tstop;
    const [a, b] = this.cursors.t;
    const dt = Math.abs(b - a) * T;
    const sc = this.scales.ch1 || { per: 1, zero: 0 };
    const vAt = (f) => (f * (DIV_Y / 2) - sc.zero) * sc.per;
    const dv = Math.abs(vAt(this.cursors.v[0]) - vAt(this.cursors.v[1]));
    const n = this.circuit && this.circuit.probes && this.circuit.probes.ch1;
    const data = n && tr.nodes[n];
    const at = (f) => (data ? data[Math.round(f * (data.length - 1))] : NaN);
    return { dt, inv: dt > 0 ? 1 / dt : NaN, dv, va: at(a), vb: at(b), ta: a * T, tb: b * T };
  }

  /** Nudge a cursor from the keyboard. */
  nudgeCursor(i, delta) {
    this.cursors.t[i] = Math.max(0, Math.min(1, this.cursors.t[i] + delta));
    if (this.h.onCursor) this.h.onCursor(this.cursorReadout());
  }

  /* ---------------- drawing ---------------- */

  draw() {
    const ctx = this.ctx;
    if (!this.W) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, this.W, this.H);
    if (this.view === 'acoustic') { this._drawAcoustic(); return; }
    if (this.error) { this._graticule(); this._banner(this.error.message || 'Simulation failed.', '#f87171'); return; }
    if (this.view === 'fft') this._drawFFT();
    else if (this.view === 'bode') this._drawBode();
    else this._drawDSO();
  }

  _graticule(divx = DIV_X, divy = DIV_Y) {
    const ctx = this.ctx;
    const P = this.plot;
    ctx.lineWidth = 1;
    ctx.strokeStyle = C.grid;
    ctx.beginPath();
    for (let i = 0; i <= divx; i++) { const x = Math.round(P.x + (i * P.w) / divx) + 0.5; ctx.moveTo(x, P.y); ctx.lineTo(x, P.y + P.h); }
    for (let j = 0; j <= divy; j++) { const y = Math.round(P.y + (j * P.h) / divy) + 0.5; ctx.moveTo(P.x, y); ctx.lineTo(P.x + P.w, y); }
    ctx.stroke();
    // Centre axes with minor ticks, like a real graticule.
    ctx.strokeStyle = C.gridStrong;
    ctx.beginPath();
    const cx = Math.round(P.x + P.w / 2) + 0.5;
    const cy = Math.round(P.y + P.h / 2) + 0.5;
    ctx.moveTo(cx, P.y); ctx.lineTo(cx, P.y + P.h);
    ctx.moveTo(P.x, cy); ctx.lineTo(P.x + P.w, cy);
    for (let i = 0; i <= divx * 5; i++) { const x = P.x + (i * P.w) / (divx * 5); ctx.moveTo(x, cy - 3); ctx.lineTo(x, cy + 3); }
    for (let j = 0; j <= divy * 5; j++) { const y = P.y + (j * P.h) / (divy * 5); ctx.moveTo(cx - 3, y); ctx.lineTo(cx + 3, y); }
    ctx.stroke();
    ctx.strokeStyle = C.gridStrong;
    ctx.strokeRect(P.x + 0.5, P.y + 0.5, P.w - 1, P.h - 1);
  }

  _trace(data, map, color, opts = {}) {
    const ctx = this.ctx;
    const P = this.plot;
    const n = data.length;
    const upto = opts.upto === undefined ? n : Math.max(1, Math.min(n, opts.upto));
    const from = opts.from || 0;
    if (upto - from < 2) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(P.x, P.y, P.w, P.h);
    ctx.clip();
    ctx.strokeStyle = color;
    ctx.globalAlpha = opts.alpha ?? 1;
    if (opts.dashed) ctx.setLineDash([6, 5]);
    const cols = Math.max(2, Math.floor(P.w));
    const path = () => {
      ctx.beginPath();
      if (opts.exact || n <= cols * 2) {
        for (let i = from; i < upto; i++) {
          const [x, y] = map(i, data[i]);
          if (i === from) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
      } else {
        // Min/max per pixel column keeps fast edges and ringing sharp.
        let first = true;
        const per = n / cols;
        const c0 = Math.floor(from / per);
        const c1 = Math.ceil(upto / per);
        for (let c = c0; c < c1; c++) {
          const i0 = Math.max(from, Math.floor(c * per));
          const i1 = Math.min(upto, Math.floor((c + 1) * per));
          if (i1 <= i0) continue;
          let mn = Infinity;
          let mx = -Infinity;
          for (let i = i0; i < i1; i++) { const v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
          const [x, ya] = map(i0, data[i0]);
          const [, ymn] = map(i0, mn);
          const [, ymx] = map(i0, mx);
          if (first) { ctx.moveTo(x, ya); first = false; }
          ctx.lineTo(x, ymx); ctx.lineTo(x, ymn);
          const [, yb] = map(i1 - 1, data[i1 - 1]);
          ctx.lineTo(x, yb);
        }
      }
    };
    if (!opts.dashed && opts.glow !== false) {
      ctx.lineWidth = 5;
      ctx.globalAlpha = (opts.alpha ?? 1) * 0.16;
      path(); ctx.stroke();
      ctx.globalAlpha = opts.alpha ?? 1;
    }
    ctx.lineWidth = opts.width || 1.6;
    path(); ctx.stroke();
    ctx.restore();
  }

  _drawDSO() {
    const ctx = this.ctx;
    const P = this.plot;
    this._graticule();
    if (!this.result) return;
    const tr = this.result.tran;
    const n = tr.t.length;
    const tx = (i) => P.x + (i / (n - 1)) * P.w;
    const vy = (sc) => (v) => P.y + P.h / 2 - ((v / sc.per + sc.zero) * P.h) / DIV_Y;
    const traces = this.traces().sort((a, b) => (a.dashed ? 1 : 0) - (b.dashed ? 1 : 0));
    const beam = this.sweep === null ? n : Math.round(this.sweep * (n - 1)) + 1;
    for (const t of traces) {
      const yv = vy(t.scale);
      const map = (i, v) => [tx(i), yv(v)];
      if (t.dashed) { this._trace(t.data, map, t.color, { dashed: true, width: 1.6, alpha: 0.95 }); continue; }
      if (beam < n) {
        this._trace(t.data, map, t.color, { from: Math.max(0, beam - 1), alpha: 0.22, glow: false });
        this._trace(t.data, map, t.color, { upto: beam });
        const [bx, by] = map(beam - 1, t.data[beam - 1]);
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = t.color; ctx.shadowBlur = 12;
        ctx.beginPath(); ctx.arc(bx, by, 2.6, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
      } else {
        this._trace(t.data, map, t.color);
      }
      // Zero marker on the left edge.
      if (t.key === 'ch1' || t.key === 'ch2' || t.key === 'math') {
        const y0 = yv(0);
        if (y0 >= P.y && y0 <= P.y + P.h) {
          ctx.fillStyle = t.color;
          ctx.beginPath(); ctx.moveTo(P.x, y0 - 5); ctx.lineTo(P.x + 8, y0); ctx.lineTo(P.x, y0 + 5); ctx.fill();
          ctx.font = '700 9px ui-monospace, Menlo, monospace';
          ctx.fillStyle = C.bg;
          ctx.fillText(t.key === 'ch1' ? '1' : t.key === 'ch2' ? '2' : 'M', P.x + 1, y0 + 3);
        }
      }
    }
    // Trigger: t = 0 marker on top, CH1 50% level arrow on the right.
    ctx.fillStyle = C.warn;
    ctx.beginPath(); ctx.moveTo(P.x + 2, P.y); ctx.lineTo(P.x + 10, P.y); ctx.lineTo(P.x + 6, P.y + 7); ctx.fill();
    const m1 = this.result.chans.ch1 && this.result.chans.ch1.metrics;
    if (m1 && this.scales.ch1 && this.flags.ch1) {
      const ly = vy(this.scales.ch1)((m1.max + m1.min) / 2);
      if (ly > P.y && ly < P.y + P.h) {
        ctx.beginPath(); ctx.moveTo(P.x + P.w, ly - 5); ctx.lineTo(P.x + P.w - 8, ly); ctx.lineTo(P.x + P.w, ly + 5); ctx.fill();
      }
    }
    // Sonification playhead.
    if (this.playhead !== null) {
      const x = P.x + this.playhead * P.w;
      ctx.strokeStyle = C.math; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, P.y); ctx.lineTo(x, P.y + P.h); ctx.stroke();
    }
    this._cursors();
    // Scale legend. Wrap onto extra rows so every channel, power scale, timebase and
    // theory label stays readable inside the canvas at phone widths (including Math on).
    ctx.font = MONO;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const gap = 12;
    const items = [];
    for (const t of traces) {
      if (t.key === 'theory') continue;
      const unit = t.key === 'math' ? 'W' : 'V';
      const isOp = this.result && this.result.math && this.result.math.type === 'OPAMP';
      const label = t.key === 'math' ? `M ${isOp ? 'Pdel' : 'P'}(${t.node})` : `${t.key.toUpperCase()} ${t.node}`;
      items.push({ text: `${label} ${formatSI(t.scale.per, unit)}/div`, color: t.color });
    }
    items.push({ text: `${formatSI(tr.tstop / DIV_X, 's')}/div`, color: C.text });
    if (traces.some((t) => t.key === 'theory')) items.push({ text: 'theory', color: C.theory });
    // Reserve up to three rows in the bottom margin area, drawn over the lower graticule.
    const lineH = 13;
    const rows = Math.min(3, Math.max(1, Math.ceil(items.reduce((n, it) => n + ctx.measureText(it.text).width + gap, 0) / Math.max(1, P.w))));
    let row = 0;
    let x = P.x;
    let y = this.H - 8 - (rows - 1) * lineH;
    for (const it of items) {
      const w = ctx.measureText(it.text).width;
      if (x > P.x && x + w > P.x + P.w) { row++; x = P.x; y += lineH; }
      if (row >= rows) row = rows - 1;
      ctx.fillStyle = it.color;
      ctx.fillText(it.text, x, Math.min(this.H - 7, y));
      x += w + gap;
    }
  }

  _cursors() {
    const ctx = this.ctx;
    const P = this.plot;
    ctx.save();
    ctx.strokeStyle = C.cursor;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    for (const f of this.cursors.t) { const x = Math.round(P.x + f * P.w) + 0.5; ctx.beginPath(); ctx.moveTo(x, P.y); ctx.lineTo(x, P.y + P.h); ctx.stroke(); }
    for (const f of this.cursors.v) { const y = Math.round(this._vy(f)) + 0.5; ctx.beginPath(); ctx.moveTo(P.x, y); ctx.lineTo(P.x + P.w, y); ctx.stroke(); }
    ctx.setLineDash([]);
    ctx.fillStyle = C.cursor;
    ctx.font = '700 9px ui-monospace, Menlo, monospace';
    this.cursors.t.forEach((f, i) => { ctx.fillText(i ? 'b' : 'a', P.x + f * P.w + 3, P.y + P.h - 6); });
    const r = this.cursorReadout();
    if (r) {
      const lines = [
        `Δt ${formatSI(r.dt, 's', 4)}`,
        `1/Δt ${formatSI(r.inv, 'Hz', 4)}`,
        `ΔV ${formatSI(r.dv, 'V', 3)}`,
      ];
      ctx.font = MONO;
      const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
      const x = P.x + P.w - w - 8;
      const y = P.y + 8;
      ctx.fillStyle = 'rgba(6, 10, 14, 0.82)';
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
      roundRect(ctx, x, y, w, lines.length * 15 + 8, 5);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = C.bright;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      lines.forEach((l, i) => ctx.fillText(l, x + 8, y + 5 + i * 15));
    }
    ctx.restore();
  }

  _logAxis(f0, f1, labelY) {
    const ctx = this.ctx;
    const P = this.plot;
    const a = Math.log10(f0);
    const b = Math.log10(f1);
    const fx = (f) => P.x + ((Math.log10(f) - a) / (b - a)) * P.w;
    ctx.lineWidth = 1;
    for (let d = Math.floor(a); d <= Math.ceil(b); d++) {
      for (let m = 1; m <= 9; m++) {
        const f = m * 10 ** d;
        if (f < f0 || f > f1) continue;
        const x = Math.round(fx(f)) + 0.5;
        ctx.strokeStyle = m === 1 ? C.gridStrong : C.grid;
        ctx.beginPath(); ctx.moveTo(x, P.y); ctx.lineTo(x, P.y + P.h); ctx.stroke();
        if (m === 1) {
          ctx.fillStyle = C.text;
          ctx.font = MONO;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(formatSI(f, 'Hz'), Math.min(Math.max(x, P.x + 24), P.x + P.w - 24), labelY);
        }
      }
    }
    ctx.strokeStyle = C.gridStrong;
    ctx.strokeRect(P.x + 0.5, P.y + 0.5, P.w - 1, P.h - 1);
    return fx;
  }

  _drawFFT() {
    const ctx = this.ctx;
    const P = this.plot;
    const r = this.result;
    if (!r) { this._graticule(); return; }
    const ch1 = r.chans.ch1 && r.chans.ch1.spectrum;
    if (!ch1) { this._graticule(); this._banner('No spectrum for this probe.'); return; }
    // binHz * N inflates past the true Nyquist for coherent spectra (the resample pads onto a
    // power-of-two grid); spec.fs carries the real sample rate, so cap the axis at fs/2.
    const fs = ch1.fs || ch1.binHz * ch1.N;
    const f0 = Math.max(ch1.binHz, 1);
    const f1 = fs / 2;
    const fx = this._logAxis(f0, f1, this.H - 14);
    const top = 0;
    const bottom = -120;
    // Horizontal dB grid.
    ctx.strokeStyle = C.grid;
    ctx.fillStyle = C.text;
    ctx.font = MONO;
    ctx.textAlign = 'left';
    for (let db = top; db >= bottom; db -= 20) {
      const y = Math.round(P.y + ((top - db) / (top - bottom)) * P.h) + 0.5;
      ctx.beginPath(); ctx.moveTo(P.x, y); ctx.lineTo(P.x + P.w, y); ctx.stroke();
      ctx.fillText(`${db} dB`, P.x + 4, y + (db === top ? 9 : -6));
    }
    const ym = (db) => P.y + ((top - Math.max(bottom - 5, Math.min(top + 5, db))) / (top - bottom)) * P.h;
    const plotSpec = (spec, color, alpha) => {
      const k0 = Math.max(1, Math.ceil(f0 / spec.binHz));
      const k1 = Math.min(spec.db.length, Math.floor(f1 / spec.binHz) + 1);
      const data = spec.db;
      const map = (i, v) => [fx(i * spec.binHz), ym(v)];
      this._trace(data, map, color, { alpha, from: k0, upto: k1, exact: true });
    };
    if (this.flags.ch2 && r.chans.ch2 && r.chans.ch2.spectrum) plotSpec(r.chans.ch2.spectrum, C.ch2, 0.4);
    plotSpec(ch1, C.math, 1);
    // Harmonic markers.
    const th = r.chans.ch1.thd;
    if (th && Array.isArray(th.harmonics) && th.harmonics.length > 0) {
      ctx.font = '600 10px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center';
      for (const h of th.harmonics.slice(0, 8)) {
        if (h.freq < f0 || h.freq > f1) continue;
        const db = 20 * Math.log10(Math.max(h.amp / ch1.fullScale, 1e-12));
        if (db < bottom + 10) continue;
        const x = fx(h.freq);
        const y = ym(db) - 6;
        ctx.fillStyle = h.n === 1 ? C.bright : C.math;
        ctx.beginPath(); ctx.moveTo(x - 4, y - 8); ctx.lineTo(x + 4, y - 8); ctx.lineTo(x, y - 2); ctx.fill();
        ctx.fillText(`H${h.n}`, x, y - 15);
      }
      const range = th.harmonics.length > 1 ? `H2-H${th.harmonics[th.harmonics.length - 1].n}` : 'H2-H10';
      const pct = Number.isFinite(th.percent) ? (th.percent < 0.01 ? th.percent.toExponential(1) : th.percent.toFixed(2)) : null;
      const lines = [`f1 ${formatSI(th.harmonics[0].freq, 'Hz', 4)}`];
      if (pct !== null) lines.push(`THD ${pct} % (${range})`);
      else lines.push(`THD ${th.reason || 'N/A'} (${range})`);
      lines.push(ch1.coherent ? 'whole-cycle FFT' : 'Hann window');
      this._tag(lines, C.math, true);
    } else {
      const reason = r.chans.ch1.thd && r.chans.ch1.thd.reason;
      const peak = Number.isFinite(ch1.peak.freq) ? formatSI(ch1.peak.freq, 'Hz', 4) : 'none';
      this._tag([`peak ${peak}`, reason ? `THD ${reason}` : 'THD needs a periodic signal'], C.math, true);
    }
  }

  _drawBode() {
    const ctx = this.ctx;
    const P = this.plot;
    const r = this.result;
    const ac = r && r.ac;
    if (!ac || !ac.ok) {
      this._graticule();
      this._banner(r && r.ac && r.ac.error ? r.ac.error.message : 'The AC sweep is off for this lab. Enable an AC frequency range in the circuit to activate the small-signal sweep; the theory panel shows the flat response where one applies.');
      return;
    }
    const f0 = ac.freqs[0];
    const f1 = ac.freqs[ac.freqs.length - 1];
    const fx = this._logAxis(f0, f1, this.H - 14);
    const half = P.h / 2;
    // Magnitude range.
    let mx = -Infinity;
    let mn = Infinity;
    for (const v of ac.mag) { mx = Math.max(mx, v); mn = Math.min(mn, v); }
    const mTop = Math.ceil((mx + 3) / 10) * 10;
    const mBot = Math.min(mTop - 20, Math.floor((mn - 3) / 10) * 10);
    let pmx = -Infinity;
    let pmn = Infinity;
    for (const v of ac.phase) { pmx = Math.max(pmx, v); pmn = Math.min(pmn, v); }
    const pq = pmx - pmn > 135 ? 90 : 45;
    const pTop = Math.ceil((pmx + 5) / pq) * pq;
    const pBot = Math.min(pTop - 2 * pq, Math.floor((pmn - 5) / pq) * pq);
    const ymag = (db) => P.y + ((mTop - db) / (mTop - mBot)) * (half - 6);
    const yph = (d) => P.y + half + 6 + ((pTop - d) / (pTop - pBot)) * (half - 6);
    ctx.font = MONO;
    ctx.textAlign = 'left';
    ctx.strokeStyle = C.grid;
    const stepM = niceStep((mTop - mBot) / 4);
    for (let db = mTop; db >= mBot; db -= stepM) {
      const y = Math.round(ymag(db)) + 0.5;
      ctx.beginPath(); ctx.moveTo(P.x, y); ctx.lineTo(P.x + P.w, y); ctx.stroke();
      ctx.fillStyle = C.text; ctx.fillText(`${db.toFixed(0)} dB`, P.x + 4, y - 6);
    }
    const stepP = pq;
    for (let d = pTop; d >= pBot; d -= stepP) {
      const y = Math.round(yph(d)) + 0.5;
      ctx.beginPath(); ctx.moveTo(P.x, y); ctx.lineTo(P.x + P.w, y); ctx.stroke();
      ctx.fillStyle = C.text; ctx.fillText(`${d.toFixed(0)}°`, P.x + 4, y - 6);
    }
    ctx.strokeStyle = C.gridStrong;
    ctx.beginPath(); ctx.moveTo(P.x, P.y + half); ctx.lineTo(P.x + P.w, P.y + half); ctx.stroke();
    const n = ac.freqs.length;
    if (this.flags.theory && r.bodeTheory) {
      this._trace(r.bodeTheory.mag, (i, v) => [fx(ac.freqs[i]), ymag(v)], C.theory, { dashed: true });
      this._trace(r.bodeTheory.phase, (i, v) => [fx(ac.freqs[i]), yph(v)], C.theory, { dashed: true });
    }
    this._trace(ac.mag, (i, v) => [fx(ac.freqs[i]), ymag(v)], C.ch1);
    this._trace(ac.phase, (i, v) => [fx(ac.freqs[i]), yph(v)], C.math);
    // -3 dB line and the fc or resonance marker.
    const ref = ac.refined || {};
    const lines = [];
    if (Number.isFinite(ref.refDb)) {
      const y = ymag(ref.refDb - 3.0103);
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.55)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(P.x, y); ctx.lineTo(P.x + P.w, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = C.warn; ctx.textAlign = 'left';
      // Keep the -3 dB label away from the right-hand marker/tag region.
      ctx.fillText('-3 dB', P.x + 4, y - 6);
    }
    const mark = (f, label) => {
      if (!Number.isFinite(f) || f < f0 || f > f1) return;
      const x = Math.round(fx(f)) + 0.5;
      ctx.strokeStyle = C.warn;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, P.y); ctx.lineTo(x, P.y + P.h); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = C.warn;
      ctx.textAlign = x > P.x + P.w - 90 ? 'right' : 'left';
      ctx.fillText(label, x + (ctx.textAlign === 'left' ? 5 : -5), P.y + half - 12);
    };
    // A resonance marker is meaningful only when the peak rises clearly above both sweep ends;
    // for a one-pole response the maximum sits on an edge and the fc marker carries the info.
    const isPeak = Number.isFinite(ref.peakFreq) && ref.peakDb > Math.max(ac.mag[0], ac.mag[n - 1]) + 1;
    if (isPeak) {
      mark(ref.peakFreq, `fpk ${formatSI(ref.peakFreq, 'Hz', 4)}`);
      lines.push(`peak ${ref.peakDb.toFixed(2)} dB`);
    } else if (Number.isFinite(ref.f3dB)) {
      mark(ref.f3dB, `fc ${formatSI(ref.f3dB, 'Hz', 4)}`);
      const ph = Number.isFinite(ref.phaseAtFc) ? ref.phaseAtFc : (() => {
        const k = ac.freqs.findIndex((f) => f >= ref.f3dB);
        return k > 0 ? ac.phase[k] : NaN;
      })();
      if (Number.isFinite(ph)) lines.push(`phase at fc ${ph.toFixed(1)}°`);
    } else {
      lines.push(`gain ${ac.mag[Math.floor(n / 2)].toFixed(2)} dB`);
      lines.push(`phase ${ac.phase[Math.floor(n / 2)].toFixed(1)}°`);
    }
    this._tag(lines, C.ch1, true);
  }

  _drawAcoustic() {
    const ctx = this.ctx;
    const P = this.plot;
    const a = this.acoustic;
    this._graticule(10, 8);
    if (!a) { this._banner('Press Acoustic Lab to start the speaker-to-mic measurement.'); return; }
    const half = P.h / 2;
    // Top: live waveform.
    if (a.wave) {
      const w = a.wave;
      let peak = 0.05;
      for (let i = 0; i < w.length; i++) peak = Math.max(peak, Math.abs(w[i]));
      const sc = niceStep(peak / 1.8);
      this._trace(w, (i, v) => [P.x + (i / (w.length - 1)) * P.w, P.y + half / 2 - (v / sc) * (half / 4.4)], C.ch1, { glow: true });
    }
    // Bottom: live spectrum (dB) on a log axis from 50 Hz to 12 kHz, plus the measured response points.
    const fa = 50;
    const fb = 12000;
    const fxl = (f) => P.x + ((Math.log10(f) - Math.log10(fa)) / (Math.log10(fb) - Math.log10(fa))) * P.w;
    const yd = (db) => P.y + half + 8 + ((-10 - Math.max(-110, Math.min(-10, db))) / 100) * (half - 16);
    if (a.spec) {
      const s = a.spec;
      const bin = a.sampleRate / 2 / s.length;
      const k0 = Math.ceil(fa / bin);
      const k1 = Math.min(s.length - 1, Math.floor(fb / bin));
      this._trace(s, (i, v) => [fxl(Math.max(i, k0) * bin), yd(v)], C.math, { from: k0, upto: k1, glow: false, width: 1.2, alpha: 0.8 });
    }
    if (a.response && a.response.length) {
      ctx.strokeStyle = C.theory;
      ctx.fillStyle = C.theory;
      ctx.lineWidth = 2;
      ctx.beginPath();
      a.response.forEach((p, i) => { const x = fxl(p.f); const y = yd(p.db); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
      ctx.stroke();
      for (const p of a.response) { ctx.beginPath(); ctx.arc(fxl(p.f), yd(p.db), 2.5, 0, Math.PI * 2); ctx.fill(); }
    }
    if (a.tone) {
      ctx.strokeStyle = C.warn;
      ctx.setLineDash([3, 3]);
      const x = fxl(a.tone);
      ctx.beginPath(); ctx.moveTo(x, P.y + half); ctx.lineTo(x, P.y + P.h); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = C.gridStrong;
    ctx.beginPath(); ctx.moveTo(P.x, P.y + half); ctx.lineTo(P.x + P.w, P.y + half); ctx.stroke();
    ctx.fillStyle = C.text;
    ctx.font = MONO;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    // Endpoint labels keep the bottom corners; the loopback label goes in the tag so
    // they never run together on a narrow phone canvas.
    ctx.fillText('50 Hz', P.x + 4, this.H - 14);
    ctx.textAlign = 'right';
    ctx.fillText('12 kHz', P.x + P.w - 4, this.H - 14);
    const lines = [a.simulated ? 'SIMULATED loopback' : 'Live microphone'];
    if (a.status) lines.push(a.status);
    if (a.tone) lines.push(`tone ${formatSI(a.tone, 'Hz', 4)}`);
    this._tag(lines.filter(Boolean), a.simulated ? C.warn : C.theory);
  }

  _tag(lines, color, right = false) {
    const ctx = this.ctx;
    const P = this.plot;
    ctx.font = MONO;
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
    const h = lines.length * 15 + 8;
    const x0 = right ? P.x + P.w - w - 8 : P.x + 8;
    ctx.fillStyle = 'rgba(6, 10, 14, 0.82)';
    ctx.strokeStyle = color;
    ctx.globalAlpha = 1;
    roundRect(ctx, x0, P.y + 8, w, h, 5);
    ctx.fill();
    ctx.globalAlpha = 0.5; ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillStyle = C.bright;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, x0 + 8, P.y + 13 + i * 15));
  }

  _banner(msg, color = C.text) {
    const ctx = this.ctx;
    const P = this.plot;
    ctx.font = '500 13px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Wrap to the plot width.
    const words = msg.split(' ');
    const lines = [];
    let line = '';
    for (const w of words) {
      const t = line ? `${line} ${w}` : w;
      if (ctx.measureText(t).width > P.w - 60 && line) { lines.push(line); line = w; } else line = t;
    }
    if (line) lines.push(line);
    const bh = lines.length * 18 + 18;
    const bw = Math.min(P.w - 30, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 36);
    const bx = P.x + (P.w - bw) / 2;
    const by = P.y + (P.h - bh) / 2;
    ctx.fillStyle = 'rgba(6, 10, 14, 0.9)';
    ctx.strokeStyle = color;
    roundRect(ctx, bx, by, bw, bh, 8);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = color === C.text ? C.bright : color;
    lines.forEach((l, i) => ctx.fillText(l, P.x + P.w / 2, by + 18 + i * 18));
  }
}
