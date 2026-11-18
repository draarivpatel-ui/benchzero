// The five guided labs. Layout: part.at = [x, y, rot] on a grid; rot 0 horizontal, 1 vertical
// (terminal 0 on top), 2 and 3 flipped. Op-amps: inputs at x-2 (inverting y-1, non-inverting y+1),
// output at x+2. circuit.nodePos pins a node's junction dot; otherwise it sits on its first terminal.

import { minus3dB } from './theory.js';

const clone = (o) => JSON.parse(JSON.stringify(o));

const near = (a, b, pct) => Number.isFinite(a) && Math.abs(a - b) <= Math.abs(b) * pct / 100;

function lastCycle(ctx) {
  const tr = ctx.result && ctx.result.tran;
  if (!tr || !tr.ok) return null;
  const out = tr.nodes.out;
  const w = ctx.parts.V1 && ctx.parts.V1.wave;
  const per = w && w.freq ? Math.round(1 / w.freq / tr.dt) : out.length;
  const start = Math.max(0, out.length - per);
  let mx = -Infinity;
  let mn = Infinity;
  for (let i = start; i < out.length; i++) { mx = Math.max(mx, out[i]); mn = Math.min(mn, out[i]); }
  return { mx, mn, out, tr };
}

export const PRESETS = [
  {
    key: '1',
    id: 'rc',
    title: 'RC Low-Pass Filter',
    short: 'RC Filter',
    circuit: {
      lab: 'rc',
      parts: [
        { id: 'V1', type: 'V', nodes: ['in', '0'], wave: { kind: 'step', amp: 5, offset: 0, freq: 100 }, at: [1, 4, 1] },
        { id: 'R1', type: 'R', nodes: ['in', 'out'], value: 1000, at: [4, 3, 0] },
        { id: 'C1', type: 'C', nodes: ['out', '0'], value: 1e-6, at: [7, 4, 1] },
      ],
      probes: { ch1: 'out', ch2: 'in' },
      sim: { tstop: 5e-3, dt: 2.5e-6 },
      ac: { fstart: 10, fstop: 1e5 },
      math: 'C1',
    },
    challenges: [
      {
        text: 'Tune R1 or C1 so the cutoff lands on 1 kHz (within 5%).',
        test: (c) => near(c.result.ac && c.result.ac.ok ? (c.result.ac.refined?.f3dB ?? minus3dB(c.result.ac)) : NaN, 1000, 5),
      },
      {
        text: 'Switch V1 to a sine at the cutoff and confirm the output is 0.707 of the input.',
        test: (c) => {
          const w = c.parts.V1.wave;
          const fc = 1 / (2 * Math.PI * c.parts.R1.value * c.parts.C1.value);
          const lc = lastCycle(c);
          return w.kind === 'sine' && near(w.freq, fc, 5) && lc && near((lc.mx - lc.mn) / 2 / w.amp, Math.SQRT1_2, 4);
        },
      },
      {
        text: 'Keep the simulation within 0.5% RMSE of the closed-form curve.',
        test: (c) => c.result.verify && c.result.verify.ok && c.result.verify.rmsePct < 0.5,
      },
    ],
  },
  {
    key: '2',
    id: 'rlc',
    title: 'Series RLC Resonance',
    short: 'RLC Resonance',
    circuit: {
      lab: 'rlc',
      parts: [
        { id: 'V1', type: 'V', nodes: ['in', '0'], wave: { kind: 'step', amp: 5, offset: 0, freq: 100 }, at: [1, 4, 1] },
        { id: 'R1', type: 'R', nodes: ['in', 'a'], value: 20, at: [3, 3, 0] },
        { id: 'L1', type: 'L', nodes: ['a', 'out'], value: 10e-3, at: [6, 3, 0] },
        { id: 'C1', type: 'C', nodes: ['out', '0'], value: 1e-6, at: [9, 4, 1] },
      ],
      probes: { ch1: 'out', ch2: 'in' },
      sim: { tstop: 5e-3, dt: 1e-6 },
      ac: { fstart: 100, fstop: 2e4 },
      math: 'R1',
    },
    challenges: [
      {
        text: 'Make it ring longer by bringing the damping ratio below 0.05.',
        test: (c) => (c.parts.R1.value / 2) * Math.sqrt(c.parts.C1.value / c.parts.L1.value) < 0.05,
      },
      {
        text: 'Critically damp it (damping ratio between 0.95 and 1.05). Which R does that take?',
        test: (c) => {
          const z = (c.parts.R1.value / 2) * Math.sqrt(c.parts.C1.value / c.parts.L1.value);
          return z >= 0.95 && z <= 1.05;
        },
      },
      {
        text: 'Move the natural frequency f0 to 1 kHz (within 5%).',
        test: (c) => near(1 / (2 * Math.PI * Math.sqrt(c.parts.L1.value * c.parts.C1.value)), 1000, 5),
      },
    ],
  },
  {
    key: '3',
    id: 'rect',
    title: 'Half-Wave Rectifier',
    short: 'Rectifier',
    circuit: {
      lab: 'rect',
      parts: [
        { id: 'V1', type: 'V', nodes: ['in', '0'], wave: { kind: 'sine', amp: 10, offset: 0, freq: 60 }, at: [1, 4, 1] },
        { id: 'D1', type: 'D', nodes: ['in', 'out'], model: 'si', at: [3, 3, 0] },
        { id: 'C1', type: 'C', nodes: ['out', '0'], value: 100e-6, at: [6, 4, 1] },
        { id: 'RL', type: 'R', nodes: ['out', '0'], value: 1000, at: [9, 4, 1] },
      ],
      probes: { ch1: 'out', ch2: 'in' },
      sim: { tstop: 100e-3, dt: 10e-6 },
      ac: null,
      math: 'D1',
    },
    challenges: [
      {
        text: 'Cut the ripple below 0.5 V peak-to-peak by changing C1 or RL.',
        test: (c) => { const l = lastCycle(c); return !!l && l.mx - l.mn < 0.5; },
      },
      {
        text: 'Swap D1 to the red LED model and watch the forward drop pass 1.5 V.',
        test: (c) => {
          const l = lastCycle(c);
          if (!l || c.parts.D1.model !== 'led') return false;
          let vin = -Infinity;
          for (const v of l.tr.nodes.in) vin = Math.max(vin, v);
          return vin - l.mx > 1.5;
        },
      },
      {
        text: 'Remove the smoothing by making C1 1 µF or less, and see the bare half-wave.',
        test: (c) => c.parts.C1.value <= 1.0001e-6,
      },
    ],
  },
  {
    key: '4',
    id: 'inv',
    title: 'Inverting Op-Amp',
    short: 'Op-Amp',
    circuit: {
      lab: 'inv',
      parts: [
        { id: 'V1', type: 'V', nodes: ['in', '0'], wave: { kind: 'sine', amp: 0.5, offset: 0, freq: 1000 }, at: [1, 6, 1] },
        { id: 'R1', type: 'R', nodes: ['in', 'inv'], value: 1000, at: [3, 4, 0] },
        { id: 'R2', type: 'R', nodes: ['inv', 'out'], value: 10000, at: [8, 2, 0] },
        { id: 'U1', type: 'OPAMP', nodes: ['0', 'inv', 'out'], gain: 1e5, rail: 12, at: [8, 5, 0] },
      ],
      nodePos: { inv: [5, 4], out: [10, 5] },
      probes: { ch1: 'out', ch2: 'in' },
      sim: { tstop: 10e-3, dt: 1e-6 },
      ac: { fstart: 10, fstop: 1e5 },
      math: 'R2',
    },
    challenges: [
      {
        text: 'Set a gain of -22 V/V (within 2%).',
        test: (c) => near(c.parts.R2.value / c.parts.R1.value, 22, 2),
      },
      {
        text: 'Drive the output into the rails and watch it clip.',
        test: (c) => {
          const tr = c.result.tran;
          if (!tr || !tr.ok) return false;
          let mx = 0;
          for (const v of tr.nodes.out) mx = Math.max(mx, Math.abs(v));
          return mx > 0.98 * (c.parts.U1.rail || 12);
        },
      },
      {
        text: 'Back off until the output matches -Rf/Rin within 0.5% RMSE again.',
        test: (c) => {
          const tr = c.result.tran;
          if (!tr || !tr.ok) return false;
          let mx = 0;
          for (const v of tr.nodes.out) mx = Math.max(mx, Math.abs(v));
          return mx < 0.9 * (c.parts.U1.rail || 12) && c.result.verify && c.result.verify.ok && c.result.verify.rmsePct < 0.5;
        },
      },
    ],
  },
  {
    key: '5',
    id: 'div',
    title: 'Divider and Thevenin Load',
    short: 'Divider',
    circuit: {
      lab: 'div',
      parts: [
        { id: 'V1', type: 'V', nodes: ['in', '0'], wave: { kind: 'dc', offset: 10 }, at: [1, 4, 1] },
        { id: 'R1', type: 'R', nodes: ['in', 'out'], value: 10000, at: [3, 3, 0] },
        { id: 'R2', type: 'R', nodes: ['out', '0'], value: 10000, at: [5, 4, 1] },
        { id: 'RL', type: 'R', nodes: ['out', '0'], value: 1e6, at: [8, 4, 1] },
      ],
      probes: { ch1: 'out', ch2: 'in' },
      sim: { tstop: 1e-3, dt: 5e-6 },
      ac: null,
      math: 'RL',
    },
    challenges: [
      {
        text: 'Make Vout read 3.3 V (within 1%).',
        test: (c) => c.result.tran && c.result.tran.ok && near(c.result.tran.nodes.out[0], 3.3, 1),
      },
      {
        text: 'Load it by setting RL to 1 kΩ or less, and watch Vout sag.',
        test: (c) => c.parts.RL.value <= 1000,
      },
      {
        text: 'Stiffen the divider so a 1 kΩ load stays within 5% of the unloaded voltage.',
        test: (c) => {
          const { R1, R2, RL } = c.parts;
          if (RL.value > 1000) return false;
          const vth = R2.value / (R1.value + R2.value);
          const rp = (R2.value * RL.value) / (R2.value + RL.value);
          const vl = rp / (R1.value + rp);
          return Math.abs(vl - vth) / vth < 0.05;
        },
      },
    ],
  },
];

export function presetById(id) {
  return PRESETS.find((p) => p.id === id) || null;
}

/** A fresh, editable copy of a preset's circuit. */
export function presetCircuit(idOrIndex) {
  const p = typeof idOrIndex === 'number' ? PRESETS[idOrIndex] : presetById(idOrIndex);
  return clone((p || PRESETS[0]).circuit);
}
