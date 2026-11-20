// Schematic canvas: IEEE-style symbols, orthogonal wires, ground symbols, node voltage badges,
// probe pins and animated current-flow dots. Parts sit on a grid (see presets.js for layout rules).

import { formatSI } from './units.js';

const COLORS = {
  wire: '#7d8b9c',
  wireLive: '#a9b6c6',
  part: '#d7dee8',
  label: '#93a1b3',
  value: '#e6edf5',
  select: '#22d3ee',
  hover: '#5eead4',
  ch1: '#22d3ee',
  ch2: '#f59e0b',
  dot: '#f8fafc',
  error: '#f87171',
  badgeBg: 'rgba(9, 13, 18, 0.88)',
  grid: 'rgba(148, 163, 184, 0.07)',
};

const MONO = '600 11px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const MONO_SM = '500 10px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const UNITS = { R: 'Ω', C: 'F', L: 'H' };

/** Terminal grid positions of a part, in node order. */
export function terminals(p) {
  const [x, y, r] = p.at && p.at.length === 3 ? p.at : [0, 0, 0];
  if (p.type === 'OPAMP') {
    const s = r === 2 ? -1 : 1;
    return [[x - 2 * s, y + 1], [x - 2 * s, y - 1], [x + 2 * s, y]];
  }
  switch (r) {
    case 1: return [[x, y - 1], [x, y + 1]];
    case 2: return [[x + 1, y], [x - 1, y]];
    case 3: return [[x, y + 1], [x, y - 1]];
    default: return [[x - 1, y], [x + 1, y]];
  }
}

const WORLD_LIMIT = 2000;
const clampWorld = (v) => (Number.isFinite(v) ? Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, v)) : 0);

/** Junction position of every non-ground node. Node tables are prototype-free. */
export function nodePositions(circuit) {
  const pos = Object.create(null);
  for (const p of circuit.parts) {
    const ts = terminals(p);
    p.nodes.forEach((n, i) => {
      if (n !== '0' && pos[n] === undefined) pos[n] = ts[i].map(clampWorld);
    });
  }
  if (circuit.nodePos) {
    for (const [n, xy] of Object.entries(circuit.nodePos)) {
      if (pos[n] !== undefined && xy && xy.length >= 2) pos[n] = [clampWorld(xy[0]), clampWorld(xy[1])];
    }
  }
  return pos;
}

function describeValue(p) {
  if (p.type === 'R' || p.type === 'C' || p.type === 'L') return formatSI(p.value, UNITS[p.type]);
  if (p.type === 'V') {
    const w = p.wave || {};
    if (w.kind === 'dc') return formatSI(w.offset || 0, 'V');
    if (w.kind === 'step') return `step ${formatSI(w.amp, 'V')}`;
    if (w.kind === 'chirp') return `chirp ${formatSI(w.freq, 'Hz')}`;
    return `${formatSI(w.amp, 'V')} ${formatSI(w.freq, 'Hz')}`;
  }
  if (p.type === 'D') return p.model === 'led' ? 'red LED' : 'silicon';
  if (p.type === 'OPAMP') return `±${formatSI(p.rail || 12, 'V')}`;
  return '';
}

export class Schematic {
  constructor(canvas, handlers = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.h = handlers;
    this.circuit = null;
    this.selected = null;
    this.faults = [];
    this.hover = null;
    this.errorNodes = new Set();
    this.tran = null;
    this.index = 0;
    this.phase = new Map();
    this.lastT = 0;
    this.view = { u: 40, ox: 0, oy: 0 };
    this.drag = null;
    this.focusNode = null;
    this._bind();
  }

  setCircuit(circuit) { this.circuit = circuit; this._fit(); }
  setFaults(list) { this.faults = Array.isArray(list) ? list.slice() : []; }
  setResult(result) {
    this.tran = result && result.ok ? result.tran : null;
    this.errorNodes = new Set(result && !result.ok && result.error && result.error.nodes ? result.error.nodes : []);
  }
  setIndex(k) { this.index = k; }
  select(id) { this.selected = id; }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.dpr = dpr;
    this.W = r.width;
    this.H = r.height;
    this._fit();
  }

  _fit() {
    if (!this.circuit || !this.W) return;
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    const grow = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
    for (const p of this.circuit.parts) {
      for (const [x, y] of terminals(p)) grow(x, y);
      const [x, y] = p.at || [0, 0];
      grow(x, y - (p.type === 'OPAMP' ? 1.5 : 0.8));
      grow(x, y + (p.type === 'OPAMP' ? 1.5 : 0.8));
    }
    for (const xy of Object.values(nodePositions(this.circuit))) grow(xy[0], xy[1]);
    if (!Number.isFinite(x0)) { x0 = 0; y0 = 0; x1 = 1; y1 = 1; }
    // Room for labels, badges and ground symbols.
    x0 -= 1.4; y0 -= 1.3; y1 += 1.7;
    // Badges hang to the right of the rightmost node. Reserve the real measured badge
    // rectangle (offset + width) so the far-right voltage reading cannot clip at any width.
    const ctx = this.ctx;
    ctx.font = MONO_SM;
    const compactReserve = ctx.measureText('-00.00 mV').width + 10 + 8;
    const fullReserve = ctx.measureText('out -00.000 mV').width + 12 + 8;
    const spanX = Math.max(1e-6, x1 - x0);
    const spanY = Math.max(1e-6, y1 - y0);
    let u = Math.min((this.W - fullReserve) / spanX, this.H / spanY);
    this.compact = u < 34;
    const reserve = this.compact ? compactReserve : fullReserve;
    u = Math.min((this.W - reserve) / spanX, this.H / spanY);
    u = Math.max(16, Math.min(64, u));
    x1 += reserve / u;
    this.view = { u, ox: (this.W - u * (x1 + x0)) / 2, oy: (this.H - u * (y1 + y0)) / 2 };
  }

  toPx(x, y) { return [this.view.ox + x * this.view.u, this.view.oy + y * this.view.u]; }
  toGrid(px, py) { return [(px - this.view.ox) / this.view.u, (py - this.view.oy) / this.view.u]; }

  /* ---------------- hit testing ---------------- */

  partAt(px, py) {
    if (!this.circuit) return null;
    const [gx, gy] = this.toGrid(px, py);
    let best = null;
    let bestD = Infinity;
    for (const p of this.circuit.parts) {
      const [x, y] = p.at || [0, 0];
      const vertical = p.at && (p.at[2] === 1 || p.at[2] === 3);
      const rx = p.type === 'OPAMP' ? 1.5 : vertical ? 0.55 : 1;
      const ry = p.type === 'OPAMP' ? 1.4 : vertical ? 1 : 0.55;
      if (Math.abs(gx - x) <= rx && Math.abs(gy - y) <= ry) {
        const d = Math.hypot(gx - x, gy - y);
        if (d < bestD) { bestD = d; best = p.id; }
      }
    }
    return best;
  }

  nodeAt(px, py) {
    if (!this.circuit) return null;
    const pos = nodePositions(this.circuit);
    for (const [n, [x, y]] of Object.entries(pos)) {
      const [sx, sy] = this.toPx(x, y);
      if (Math.hypot(px - sx, py - sy) < 12) return n;
      const b = this._badgeRect(n, sx, sy);
      if (b && px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return n;
    }
    return null;
  }

  _bind() {
    const c = this.canvas;
    const local = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    c.addEventListener('pointerdown', (e) => {
      const [x, y] = local(e);
      const node = this.nodeAt(x, y);
      if (node) {
        const ch = e.shiftKey || e.button === 2 ? 'ch2' : 'ch1';
        if (this.h.onProbe) this.h.onProbe(ch, node);
        e.preventDefault();
        return;
      }
      const id = this.partAt(x, y);
      if (this.h.onSelect) this.h.onSelect(id);
      if (id) {
        const p = this.circuit.parts.find((q) => q.id === id);
        if (!p) return;
        if (!Array.isArray(p.at) || p.at.length !== 3) p.at = [0, 0, 0];
        const [gx, gy] = this.toGrid(x, y);
        this.drag = { id, dx: gx - p.at[0], dy: gy - p.at[1], moved: false, pointer: e.pointerId };
        c.setPointerCapture(e.pointerId);
      }
    });
    c.addEventListener('pointermove', (e) => {
      const [x, y] = local(e);
      if (this.drag) {
        const p = this.circuit.parts.find((q) => q.id === this.drag.id);
        if (!p) return;
        if (!Array.isArray(p.at) || p.at.length !== 3) p.at = [0, 0, 0];
        const [gx, gy] = this.toGrid(x, y);
        const nx = Math.round(clampWorld(gx - this.drag.dx));
        const ny = Math.round(clampWorld(gy - this.drag.dy));
        if (nx !== p.at[0] || ny !== p.at[1]) {
          p.at = [nx, ny, p.at[2]];
          this.drag.moved = true;
        }
        return;
      }
      const node = this.nodeAt(x, y);
      this.hover = node ? `node:${node}` : this.partAt(x, y);
      c.style.cursor = node ? 'crosshair' : this.hover ? 'grab' : 'default';
    });
    const end = () => {
      if (this.drag && this.drag.moved && this.h.onMove) { this._fit(); this.h.onMove(this.drag.id); }
      this.drag = null;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => { this.hover = null; });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /* ---------------- drawing ---------------- */

  draw(timeMs) {
    const ctx = this.ctx;
    if (!this.W) return;
    const dtS = this.lastT ? Math.min(0.1, (timeMs - this.lastT) / 1000) : 0;
    this.lastT = timeMs;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    if (!this.circuit) return;
    const { u } = this.view;
    // Dot grid.
    ctx.fillStyle = COLORS.grid;
    const [gx0, gy0] = this.toGrid(0, 0);
    const [gx1, gy1] = this.toGrid(this.W, this.H);
    // Bound the grid work so even a hostile coordinate cannot stall the animation loop.
    const loX = Math.floor(clampWorld(gx0));
    const hiX = Math.ceil(clampWorld(gx1));
    const loY = Math.floor(clampWorld(gy0));
    const hiY = Math.ceil(clampWorld(gy1));
    for (let gx = loX; gx <= hiX; gx++) {
      for (let gy = loY; gy <= hiY; gy++) {
        const [px, py] = this.toPx(gx, gy);
        if (px < -2 || px > this.W + 2 || py < -2 || py > this.H + 2) continue;
        ctx.fillRect(px - 0.75, py - 0.75, 1.5, 1.5);
      }
    }
    const pos = nodePositions(this.circuit);
    const k = this.tran ? Math.min(this.index, this.tran.t.length - 1) : -1;
    const volt = (n) => (n === '0' ? 0 : this.tran && this.tran.nodes[n] ? this.tran.nodes[n][k] : NaN);

    // Wires (vertical first from the junction, then horizontal to the terminal).
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const paths = new Map();
    for (const p of this.circuit.parts) {
      const ts = terminals(p);
      const legs = [];
      p.nodes.forEach((n, i) => {
        const [tx, ty] = ts[i];
        if (n === '0') { legs.push([[tx, ty]]); return; }
        const [nx, ny] = pos[n];
        const pts = [[nx, ny]];
        if (ny !== ty) pts.push([nx, ty]);
        pts.push([tx, ty]);
        legs.push(pts);
        ctx.strokeStyle = this.errorNodes.has(n) ? COLORS.error : COLORS.wire;
        ctx.lineWidth = Math.max(1.5, u * 0.045);
        ctx.beginPath();
        pts.forEach(([x, y], j) => { const [sx, sy] = this.toPx(x, y); if (j) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); });
        ctx.stroke();
      });
      paths.set(p.id, legs);
    }

    // Ground symbols on every grounded terminal.
    for (const p of this.circuit.parts) {
      const ts = terminals(p);
      p.nodes.forEach((n, i) => { if (n === '0') this._ground(ts[i], p, i); });
    }

    // Parts.
    for (const p of this.circuit.parts) this._part(p);

    // Fault tags sit above the part they describe, red so they read as a bench fault, not a label.
    for (const f of this.faults || []) this._faultTag(f);

    // Current-flow dots along two-terminal parts.
    if (this.tran && k >= 0) {
      for (const p of this.circuit.parts) {
        if (p.type === 'OPAMP') continue;
        const cur = this.tran.currents[p.id] ? this.tran.currents[p.id][k] : 0;
        this._flow(p, paths.get(p.id), cur, dtS);
      }
    }

    // Junction dots, probes and voltage badges.
    const degree = Object.create(null);
    for (const p of this.circuit.parts) for (const n of p.nodes) degree[n] = (degree[n] || 0) + 1;
    const probes = this.circuit.probes || {};
    for (const [n, [x, y]] of Object.entries(pos)) {
      const [sx, sy] = this.toPx(x, y);
      if (degree[n] >= 3) {
        ctx.fillStyle = COLORS.wireLive;
        ctx.beginPath(); ctx.arc(sx, sy, Math.max(3, u * 0.08), 0, Math.PI * 2); ctx.fill();
      }
      const isCh1 = probes.ch1 === n;
      const isCh2 = probes.ch2 === n;
      if (isCh1 || isCh2) this._probe(sx, sy, isCh1 ? 'ch1' : 'ch2', isCh1 && isCh2);
      this._badge(n, sx, sy, volt(n), isCh1 ? COLORS.ch1 : isCh2 ? COLORS.ch2 : null);
      if (this.focusNode === n || this.hover === `node:${n}`) {
        ctx.strokeStyle = COLORS.hover;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.arc(sx, sy, 11, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  _faultTag(f) {
    const ctx = this.ctx;
    const { u } = this.view;
    const at = Array.isArray(f.at) ? f.at : [0, 0, 0];
    const [sx, sy] = this.toPx(at[0], at[1]);
    const text = f.fault === 'open' ? 'OPEN' : 'SHORT';
    ctx.save();
    ctx.font = MONO;
    ctx.textBaseline = 'middle';
    const pad = 5;
    const bw = ctx.measureText(text).width + pad * 2;
    const bh = 16;
    const bx = sx + u * 0.55;
    const by = sy - u * 0.75 - bh / 2;
    ctx.fillStyle = 'rgba(42, 10, 14, 0.94)';
    ctx.strokeStyle = COLORS.error;
    ctx.lineWidth = 1.2;
    roundRect(ctx, bx, by, bw, bh, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = COLORS.error;
    ctx.fillText(text, bx + pad, by + bh / 2 + 0.5);
    // A slash marks the spot even when the part itself has been removed by an open fault.
    ctx.strokeStyle = COLORS.error;
    ctx.lineWidth = Math.max(1.6, u * 0.06);
    ctx.beginPath();
    ctx.moveTo(sx - u * 0.45, sy + u * 0.45);
    ctx.lineTo(sx + u * 0.45, sy - u * 0.45);
    ctx.stroke();
    ctx.restore();
  }

  _ground([x, y], p, i) {
    const ctx = this.ctx;
    const { u } = this.view;
    const [sx, sy] = this.toPx(x, y);
    const len = u * 0.35;
    ctx.strokeStyle = COLORS.wire;
    ctx.lineWidth = Math.max(1.5, u * 0.045);
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx, sy + len); ctx.stroke();
    const w = u * 0.36;
    for (let j = 0; j < 3; j++) {
      const yy = sy + len + j * u * 0.1;
      const ww = w * (1 - j * 0.32);
      ctx.beginPath(); ctx.moveTo(sx - ww, yy); ctx.lineTo(sx + ww, yy); ctx.stroke();
    }
  }

  _part(p) {
    const ctx = this.ctx;
    const { u } = this.view;
    const [x, y, r] = p.at || [0, 0, 0];
    const [cx, cy] = this.toPx(x, y);
    const sel = this.selected === p.id;
    const hov = this.hover === p.id;
    ctx.save();
    ctx.translate(cx, cy);
    if (sel || hov) {
      ctx.shadowColor = sel ? COLORS.select : COLORS.hover;
      ctx.shadowBlur = sel ? 14 : 8;
    }
    ctx.strokeStyle = sel ? COLORS.select : hov ? COLORS.hover : COLORS.part;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = Math.max(1.6, u * 0.05);
    if (p.type === 'OPAMP') {
      this._opamp(r === 2 ? -1 : 1);
    } else {
      ctx.rotate((r * Math.PI) / 2);
      ctx.scale(u, u);
      ctx.lineWidth /= u;
      const sym = { R: this._resistor, C: this._capacitor, L: this._inductor, D: this._diode, V: this._source }[p.type];
      if (sym) sym.call(this, ctx, p, r);
    }
    ctx.restore();
    // Labels: above horizontal parts, right of vertical ones.
    const vertical = p.type !== 'OPAMP' && (r === 1 || r === 3);
    ctx.font = MONO;
    ctx.textBaseline = 'middle';
    let lx;
    let ly;
    if (p.type === 'OPAMP') { lx = cx; ly = cy + u * 1.75; ctx.textAlign = 'center'; }
    else if (vertical) { lx = cx + u * 0.62; ly = cy - 7; ctx.textAlign = 'left'; }
    else { lx = cx; ly = cy + u * 0.5 + 6; ctx.textAlign = 'center'; }
    ctx.fillStyle = sel ? COLORS.select : COLORS.label;
    ctx.fillText(p.id, lx, ly);
    if (this.compact) return;
    ctx.fillStyle = COLORS.value;
    ctx.font = MONO_SM;
    ctx.fillText(describeValue(p), lx, ly + 13);
  }

  _leads(ctx, a) {
    ctx.beginPath();
    ctx.moveTo(-1, 0); ctx.lineTo(-a, 0);
    ctx.moveTo(a, 0); ctx.lineTo(1, 0);
    ctx.stroke();
  }

  _resistor(ctx) {
    this._leads(ctx, 0.6);
    ctx.beginPath();
    ctx.moveTo(-0.6, 0);
    const n = 6;
    for (let i = 0; i < n; i++) {
      const x = -0.6 + (1.2 * (i + 0.5)) / n;
      ctx.lineTo(x, i % 2 ? 0.18 : -0.18);
    }
    ctx.lineTo(0.6, 0);
    ctx.stroke();
  }

  _capacitor(ctx) {
    this._leads(ctx, 0.1);
    ctx.lineWidth *= 1.4;
    ctx.beginPath();
    ctx.moveTo(-0.1, -0.32); ctx.lineTo(-0.1, 0.32);
    ctx.moveTo(0.1, -0.32); ctx.lineTo(0.1, 0.32);
    ctx.stroke();
  }

  _inductor(ctx) {
    this._leads(ctx, 0.6);
    ctx.beginPath();
    const n = 4;
    const w = 1.2 / n;
    for (let i = 0; i < n; i++) {
      const c = -0.6 + w * (i + 0.5);
      ctx.moveTo(c - w / 2, 0);
      ctx.arc(c, 0, w / 2, Math.PI, 0, false);
    }
    ctx.stroke();
  }

  _diode(ctx, p) {
    this._leads(ctx, 0.24);
    ctx.beginPath();
    ctx.moveTo(-0.24, -0.26); ctx.lineTo(0.22, 0); ctx.lineTo(-0.24, 0.26); ctx.closePath();
    ctx.globalAlpha = 0.18; ctx.fill(); ctx.globalAlpha = 1;
    ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0.24, -0.26); ctx.lineTo(0.24, 0.26); ctx.stroke();
    if (p.model === 'led') {
      for (const off of [-0.02, 0.16]) {
        ctx.beginPath();
        ctx.moveTo(off, -0.34); ctx.lineTo(off + 0.16, -0.54);
        ctx.moveTo(off + 0.16, -0.54); ctx.lineTo(off + 0.06, -0.52);
        ctx.moveTo(off + 0.16, -0.54); ctx.lineTo(off + 0.15, -0.44);
        ctx.stroke();
      }
    }
  }

  _source(ctx, p, r) {
    this._leads(ctx, 0.42);
    ctx.beginPath(); ctx.arc(0, 0, 0.42, 0, Math.PI * 2); ctx.stroke();
    const kind = (p.wave && p.wave.kind) || 'dc';
    // Inner glyph drawn upright regardless of rotation.
    ctx.save();
    ctx.rotate((-r * Math.PI) / 2);
    ctx.beginPath();
    if (kind === 'sine' || kind === 'chirp') {
      for (let i = 0; i <= 24; i++) {
        const xx = -0.24 + (0.48 * i) / 24;
        const yy = -0.13 * Math.sin((i / 24) * Math.PI * 2 * (kind === 'chirp' ? 1.6 : 1));
        if (i) ctx.lineTo(xx, yy); else ctx.moveTo(xx, yy);
      }
    } else if (kind === 'square') {
      ctx.moveTo(-0.24, 0.12); ctx.lineTo(-0.12, 0.12); ctx.lineTo(-0.12, -0.12); ctx.lineTo(0.06, -0.12);
      ctx.lineTo(0.06, 0.12); ctx.lineTo(0.24, 0.12);
    } else if (kind === 'triangle') {
      ctx.moveTo(-0.24, 0.12); ctx.lineTo(-0.08, -0.12); ctx.lineTo(0.08, 0.12); ctx.lineTo(0.24, -0.12);
    } else if (kind === 'step') {
      ctx.moveTo(-0.24, 0.12); ctx.lineTo(-0.04, 0.12); ctx.lineTo(-0.04, -0.12); ctx.lineTo(0.24, -0.12);
    }
    ctx.stroke();
    ctx.restore();
    if (kind === 'dc' || kind === 'step') {
      // Polarity marks: + by terminal 0, - by terminal 1.
      ctx.beginPath();
      ctx.moveTo(-0.27, -0.08); ctx.lineTo(-0.27, 0.08);
      ctx.moveTo(-0.35, 0); ctx.lineTo(-0.19, 0);
      ctx.moveTo(0.27, -0.08); ctx.lineTo(0.27, 0.08);
      ctx.stroke();
    }
  }

  _opamp(s) {
    const ctx = this.ctx;
    const { u } = this.view;
    ctx.beginPath();
    ctx.moveTo(-1.3 * u * s, -1.35 * u); ctx.lineTo(1.3 * u * s, 0); ctx.lineTo(-1.3 * u * s, 1.35 * u); ctx.closePath();
    ctx.save(); ctx.globalAlpha = 0.08; ctx.fill(); ctx.restore();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-2 * u * s, -u); ctx.lineTo(-1.3 * u * s, -u);
    ctx.moveTo(-2 * u * s, u); ctx.lineTo(-1.3 * u * s, u);
    ctx.moveTo(1.3 * u * s, 0); ctx.lineTo(2 * u * s, 0);
    ctx.stroke();
    const m = u * 0.16;
    const ix = -1.0 * u * s;
    ctx.beginPath();
    ctx.moveTo(ix - m / 1.2, -u); ctx.lineTo(ix + m / 1.2, -u);
    ctx.moveTo(ix - m / 1.2, u); ctx.lineTo(ix + m / 1.2, u);
    ctx.moveTo(ix, u - m / 1.2); ctx.lineTo(ix, u + m / 1.2);
    ctx.stroke();
  }

  _flow(p, legs, current, dtS) {
    if (!legs || !Number.isFinite(current)) return;
    const mag = Math.abs(current);
    if (mag < 1e-7) return;
    // Polyline: node 0 junction -> terminal 0 -> body -> terminal 1 -> node 1 junction.
    const a = legs[0].slice();
    const b = legs[1].slice().reverse();
    const pts = [...a, ...b].map(([x, y]) => this.toPx(x, y));
    const seg = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      seg.push(d);
      total += d;
    }
    if (total < 1) return;
    // Speed grows with log current: 1 uA crawls, 100 mA races.
    const speed = 18 + 22 * Math.max(0, Math.min(5, Math.log10(mag / 1e-6)));
    const ph = ((this.phase.get(p.id) || 0) + Math.sign(current) * speed * dtS) % 16;
    this.phase.set(p.id, ph);
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.dot;
    ctx.globalAlpha = 0.85;
    for (let s = ((ph % 16) + 16) % 16; s < total; s += 16) {
      let acc = 0;
      for (let i = 0; i < seg.length; i++) {
        if (s <= acc + seg[i]) {
          const f = seg[i] ? (s - acc) / seg[i] : 0;
          const x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f;
          const y = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f;
          ctx.beginPath(); ctx.arc(x, y, 1.9, 0, Math.PI * 2); ctx.fill();
          break;
        }
        acc += seg[i];
      }
    }
    ctx.globalAlpha = 1;
  }

  _probe(sx, sy, ch, both) {
    const ctx = this.ctx;
    const col = COLORS[ch];
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(sx, sy, 6.5, 0, Math.PI * 2); ctx.stroke();
    if (both) {
      ctx.strokeStyle = COLORS.ch2;
      ctx.beginPath(); ctx.arc(sx, sy, 9.5, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(sx, sy, 3, 0, Math.PI * 2); ctx.fill();
  }

  _badgeRect(n, sx, sy) {
    const ctx = this.ctx;
    ctx.font = MONO_SM;
    const w = this.compact ? ctx.measureText('-00.00 mV').width + 10 : Math.max(ctx.measureText(`${n} -00.000 mV`).width + 12, 64);
    return { x: sx + 6, y: sy - 24, w, h: 16 };
  }

  _badge(n, sx, sy, v, color) {
    const ctx = this.ctx;
    const b = this._badgeRect(n, sx, sy);
    ctx.fillStyle = COLORS.badgeBg;
    ctx.strokeStyle = this.errorNodes.has(n) ? COLORS.error : color || 'rgba(148,163,184,0.35)';
    ctx.lineWidth = 1;
    roundRect(ctx, b.x, b.y, b.w, b.h, 4);
    ctx.fill(); ctx.stroke();
    ctx.font = MONO_SM;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    if (!this.compact) {
      ctx.fillStyle = color || COLORS.label;
      ctx.fillText(n, b.x + 6, b.y + b.h / 2 + 0.5);
    }
    ctx.fillStyle = this.compact && color ? color : COLORS.value;
    ctx.textAlign = 'right';
    ctx.fillText(this.errorNodes.has(n) ? 'float' : Number.isFinite(v) ? formatSI(v, 'V', this.compact ? 3 : 4) : '--', b.x + b.w - 5, b.y + b.h / 2 + 0.5);
  }
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
