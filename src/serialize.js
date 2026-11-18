// Compact, deterministic lab codec for share links: #lab=<base64url(JSON)>.
// Decoding validates everything and rebuilds a clean circuit, so a hand-edited link cannot inject
// unexpected fields or values.

import { WAVE_KINDS } from './waves.js';

export const CODEC_VERSION = 1;
const TYPES = ['R', 'C', 'L', 'V', 'D', 'OPAMP'];
const PINS = { R: 2, C: 2, L: 2, V: 2, D: 2, OPAMP: 3 };
const LABS = ['rc', 'rlc', 'rect', 'inv', 'div', ''];
const NODE_RE = /^[A-Za-z0-9_]{1,12}$/;
const ID_RE = /^[A-Z][A-Za-z0-9]{0,7}$/;
const MAX_PARTS = 40;
const MAX_CODE = 4096;

const num = (v) => +Number(v).toPrecision(6);

function waveToArr(w = {}) {
  return [
    Math.max(0, WAVE_KINDS.indexOf(w.kind || 'dc')),
    num(w.amp ?? 0), num(w.offset ?? 0), num(w.freq ?? 1000),
    num(w.duty ?? 0.5), num(w.delay ?? 0), num(w.phase ?? 0), num(w.f2 ?? 10000), num(w.sweep ?? 0.01),
  ];
}

function arrToWave(a) {
  if (!Array.isArray(a) || a.length !== 9 || !a.every(Number.isFinite)) throw new Error('bad wave');
  const kind = WAVE_KINDS[a[0]];
  if (!kind) throw new Error('bad wave kind');
  const [, amp, offset, freq, duty, delay, phase, f2, sweep] = a;
  if (Math.abs(amp) > 1000 || Math.abs(offset) > 1000) throw new Error('source level out of range');
  if (!(freq > 0 && freq <= 1e7 && f2 > 0 && f2 <= 1e7)) throw new Error('frequency out of range');
  if (!(duty > 0 && duty < 1) || delay < 0 || !(sweep > 0)) throw new Error('bad wave timing');
  return { kind, amp, offset, freq, duty, delay, phase, f2, sweep };
}

/** Circuit -> compact plain object (stable key and part order). */
export function pack(c) {
  const parts = c.parts.map((p) => {
    let param;
    if (p.type === 'R' || p.type === 'C' || p.type === 'L') param = num(p.value);
    else if (p.type === 'V') param = waveToArr(p.wave);
    else if (p.type === 'D') param = p.model === 'led' ? 'led' : 'si';
    else if (p.type === 'OPAMP') param = [num(p.gain ?? 1e5), num(p.rail ?? 12)];
    const at = Array.isArray(p.at) ? p.at.map((v) => Math.round(v)) : 0;
    return [p.type, p.id, p.nodes.join(','), param, at];
  });
  const out = { v: CODEC_VERSION, l: c.lab || '', p: parts };
  if (c.nodePos && Object.keys(c.nodePos).length) {
    out.n = Object.keys(c.nodePos).sort().map((k) => [k, Math.round(c.nodePos[k][0]), Math.round(c.nodePos[k][1])]);
  }
  out.pr = [c.probes?.ch1 || '', c.probes?.ch2 || ''];
  out.s = c.sim.method === 'be' ? [num(c.sim.tstop), num(c.sim.dt), 1] : [num(c.sim.tstop), num(c.sim.dt)];
  out.a = c.ac ? [num(c.ac.fstart), num(c.ac.fstop)] : 0;
  out.m = c.math || '';
  return out;
}

/** Compact object -> validated circuit. Throws Error with a readable message on any problem. */
export function unpack(o) {
  if (!o || typeof o !== 'object' || o.v !== CODEC_VERSION) throw new Error('Unsupported lab link version.');
  if (!LABS.includes(o.l)) throw new Error('Unknown lab.');
  if (!Array.isArray(o.p) || o.p.length < 1 || o.p.length > MAX_PARTS) throw new Error('Bad parts list.');
  const ids = new Set();
  const parts = o.p.map((e) => {
    if (!Array.isArray(e) || e.length !== 5) throw new Error('Bad part entry.');
    const [type, id, nodesStr, param, at] = e;
    if (!TYPES.includes(type)) throw new Error(`Unknown part type ${type}.`);
    if (typeof id !== 'string' || !ID_RE.test(id) || ids.has(id)) throw new Error(`Bad part id ${id}.`);
    ids.add(id);
    const nodes = typeof nodesStr === 'string' ? nodesStr.split(',') : [];
    if (nodes.length !== PINS[type] || !nodes.every((n) => NODE_RE.test(n))) throw new Error(`Bad nodes on ${id}.`);
    const p = { id, type, nodes };
    if (type === 'R' || type === 'C' || type === 'L') {
      if (!(Number.isFinite(param) && param > 0 && param < 1e12)) throw new Error(`Bad value on ${id}.`);
      p.value = param;
    } else if (type === 'V') p.wave = arrToWave(param);
    else if (type === 'D') {
      if (param !== 'si' && param !== 'led') throw new Error(`Bad diode model on ${id}.`);
      p.model = param;
    } else if (type === 'OPAMP') {
      if (!Array.isArray(param) || param.length !== 2 || !(param[0] > 1 && param[0] <= 1e9) || !(param[1] > 0 && param[1] <= 100)) {
        throw new Error(`Bad op-amp settings on ${id}.`);
      }
      p.gain = param[0];
      p.rail = param[1];
    }
    if (at !== 0) {
      if (!Array.isArray(at) || at.length !== 3 || !at.every((v) => Number.isInteger(v) && Math.abs(v) <= 200) || at[2] < 0 || at[2] > 3) {
        throw new Error(`Bad layout on ${id}.`);
      }
      p.at = at;
    }
    return p;
  });
  const c = { lab: o.l, parts };
  if (o.n !== undefined) {
    if (!Array.isArray(o.n) || o.n.length > 60) throw new Error('Bad node positions.');
    c.nodePos = {};
    for (const e of o.n) {
      if (!Array.isArray(e) || e.length !== 3 || !NODE_RE.test(e[0]) || !Number.isInteger(e[1]) || !Number.isInteger(e[2])) {
        throw new Error('Bad node position.');
      }
      c.nodePos[e[0]] = [e[1], e[2]];
    }
  }
  if (!Array.isArray(o.pr) || o.pr.length !== 2 || !o.pr.every((n) => n === '' || NODE_RE.test(n))) throw new Error('Bad probes.');
  c.probes = { ch1: o.pr[0], ch2: o.pr[1] };
  if (!Array.isArray(o.s) || o.s.length < 2 || o.s.length > 3 || !(o.s[0] > 0 && o.s[0] <= 100) || !(o.s[1] > 0 && o.s[1] < o.s[0])) {
    throw new Error('Bad simulation window.');
  }
  if (o.s.length === 3 && o.s[2] !== 1) throw new Error('Bad solver method.');
  c.sim = { tstop: o.s[0], dt: o.s[1] };
  if (o.s[2] === 1) c.sim.method = 'be';
  if (o.a === 0) c.ac = null;
  else if (Array.isArray(o.a) && o.a.length === 2 && o.a[0] > 0 && o.a[1] > o.a[0] && o.a[1] <= 1e9) c.ac = { fstart: o.a[0], fstop: o.a[1] };
  else throw new Error('Bad AC sweep.');
  if (typeof o.m !== 'string' || (o.m && !ids.has(o.m))) throw new Error('Bad math part.');
  c.math = o.m;
  return c;
}

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('Link has characters outside base64url.');
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : s.length % 4 === 0 ? '' : null;
  if (pad === null) throw new Error('Link is truncated.');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Circuit -> base64url code (the part after #lab=). */
export function encodeLab(circuit) {
  return b64urlEncode(JSON.stringify(pack(circuit)));
}

/** base64url code -> { ok: true, circuit } or { ok: false, error }. Never throws. */
export function decodeLab(code) {
  try {
    if (typeof code !== 'string' || !code) throw new Error('Empty lab link.');
    if (code.length > MAX_CODE) throw new Error('Lab link is too long.');
    const obj = JSON.parse(b64urlDecode(code));
    return { ok: true, circuit: unpack(obj) };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'Could not read the lab link.' };
  }
}

/** Read a lab from a location.hash string such as "#lab=...". */
export function labFromHash(hash) {
  const m = /^#?lab=([A-Za-z0-9_-]+)$/.exec(hash || '');
  return m ? decodeLab(m[1]) : null;
}
