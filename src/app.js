// BenchZero app controller: state, compute scheduling, panels, keyboard, autosave and sharing.

import { parseSI, formatSI, toSIInput, logToUnit, unitToLog } from './units.js';
import { PART_TYPES } from './mna.js';
import { PRESETS, presetCircuit } from './presets.js';
import { encodeLab, labFromHash } from './serialize.js';
import { createBridge } from './bridge.js';
import { Schematic, nodePositions } from './schematic.js';
import { Scope } from './scope.js';
import { Sonifier, AcousticLab, SONIFY_LOW, SONIFY_HIGH } from './audio.js';

const $ = (s) => document.querySelector(s);
const STORE = 'benchzero:lab:v1';
const STORE_UI = 'benchzero:ui:v1';
const SWEEP_MS = 1800;
const VIEWS = ['dso', 'fft', 'bode', 'acoustic'];
const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const RANGES = {
  R: [1, 1e7], C: [1e-12, 1e-2], L: [1e-6, 10], freq: [0.1, 1e6], gain: [10, 1e7],
};

const state = {
  circuit: null,
  presetIdx: 0,
  selected: null,
  view: 'dso',
  running: !reduceMotion,
  sweepT0: performance.now(),
  sweepPos: 0,
  result: null,
  seq: 0,
  applied: 0,
  done: new Set(),
  cursorSel: 0,
  focusNode: null,
};

const bridge = createBridge({ onMode: () => updateTelemetry() });
const sonifier = new Sonifier();
const acoustic = new AcousticLab();

const schematic = new Schematic($('#schematic'), {
  onSelect: (id) => select(id),
  onProbe: (ch, node) => setProbe(ch, node),
  onMove: () => { save(); describeCircuit(); },
});
const scope = new Scope($('#scope'), { onCursor: () => {} });

/* ------------------------------------------------------------------ */
/* Utilities                                                          */
/* ------------------------------------------------------------------ */

function announce(msg) {
  const el = $('#live');
  el.textContent = '';
  setTimeout(() => { el.textContent = msg; }, 30);
}

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

const byId = (id) => state.circuit.parts.find((p) => p.id === id);
const nodeNames = () => {
  const s = new Set();
  for (const p of state.circuit.parts) for (const n of p.nodes) if (n !== '0') s.add(n);
  return [...s];
};
function newNodeName() {
  const used = new Set(nodeNames());
  for (let i = 1; i < 999; i++) if (!used.has(`n${i}`)) return `n${i}`;
  return 'nx';
}
function nextId(type) {
  const prefix = type === 'OPAMP' ? 'U' : type;
  const used = new Set(state.circuit.parts.map((p) => p.id));
  for (let i = 1; i < 999; i++) if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`;
  return `${prefix}99`;
}

/* ------------------------------------------------------------------ */
/* Loading, saving, compute                                           */
/* ------------------------------------------------------------------ */

function presetIndexFor(circuit) {
  const i = PRESETS.findIndex((p) => p.id === circuit.lab);
  return i < 0 ? -1 : i;
}

function loadCircuit(circuit, { announceIt = true } = {}) {
  sonifier.stop();
  state.circuit = circuit;
  state.presetIdx = presetIndexFor(circuit);
  state.selected = null;
  state.focusNode = null;
  state.done = new Set();
  state.silentEval = true;
  state.sweepT0 = performance.now();
  schematic.select(null);
  schematic.setCircuit(circuit);
  renderPresets();
  renderParts();
  renderInspector();
  renderTimebase();
  renderProbeSelects();
  renderChallenges();
  describeCircuit();
  save();
  compute();
  if (announceIt) {
    const p = PRESETS[state.presetIdx];
    announce(p ? `Loaded lab ${p.key}, ${p.title}.` : 'Loaded a custom lab.');
  }
}

function loadPreset(i) {
  if (!PRESETS[i]) return;
  loadCircuit(presetCircuit(i));
}

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { safeSet(STORE, encodeLab(state.circuit)); } catch { /* invalid circuit while editing */ }
    safeSet(STORE_UI, JSON.stringify({ view: state.view, theory: scope.flags.theory, math: scope.flags.math }));
  }, 150);
}

let computeTimer = 0;
function compute(delay = 0) {
  clearTimeout(computeTimer);
  computeTimer = setTimeout(async () => {
    const id = ++state.seq;
    const snapshot = JSON.parse(JSON.stringify(state.circuit));
    const res = await bridge.run(snapshot);
    if (id < state.applied) return; // a newer result already landed
    state.applied = id;
    applyResult(res);
  }, delay);
}

function applyResult(res) {
  const wasError = state.result && !state.result.ok;
  state.result = res;
  scope.setResult(res, state.circuit);
  schematic.setResult(res);
  updateTelemetry();
  renderVerify();
  renderChallenges(!state.silentEval);
  if (res.ok) state.silentEval = false;
  if (!res.ok) announce(`Simulation error. ${res.error ? res.error.message : ''}`);
  else if (wasError) announce('Circuit solves again.');
}

/* ------------------------------------------------------------------ */
/* Header: presets and actions                                        */
/* ------------------------------------------------------------------ */

function renderPresets() {
  const nav = $('#presets');
  if (!nav.childElementCount) {
    PRESETS.forEach((p, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'preset';
      b.innerHTML = `<kbd>${p.key}</kbd><span></span>`;
      b.querySelector('span').textContent = p.short || p.title;
      b.title = `${p.title} (${p.key})`;
      b.addEventListener('click', () => loadPreset(i));
      nav.appendChild(b);
    });
  }
  [...nav.children].forEach((b, i) => b.setAttribute('aria-current', String(i === state.presetIdx)));
}

function setRunning(on) {
  state.running = on;
  const b = $('#btn-run');
  b.setAttribute('aria-pressed', String(on));
  b.querySelector('.lbl').textContent = on ? 'Pause' : 'Run';
  if (on) state.sweepT0 = performance.now() - state.sweepPos * SWEEP_MS;
  announce(on ? 'Sweep running.' : 'Sweep paused. Node voltages show cursor a.');
}

function toggleSonify() {
  const b = $('#btn-sonify');
  if (sonifier.playing) {
    sonifier.stop();
    b.setAttribute('aria-pressed', 'false');
    announce('Sonification stopped.');
    return;
  }
  if (!sonifier.supported) { toast('WebAudio is not available in this browser.'); return; }
  const r = state.result;
  const n = state.circuit.probes.ch1;
  if (!r || !r.ok || !r.tran.nodes[n]) { toast('Nothing to play yet. Fix the circuit first.'); return; }
  const span = sonifier.play(r.tran.nodes[n], 3);
  if (span) {
    b.setAttribute('aria-pressed', 'true');
    announce(`Playing CH1 at node ${n} over 3 seconds, left to right. ${SONIFY_LOW} hertz is ${formatSI(span.lo, 'V')}, ${SONIFY_HIGH} hertz is ${formatSI(span.hi, 'V')}.`);
  }
}

async function toggleAcoustic() {
  const b = $('#btn-acoustic');
  if (acoustic.running) {
    acoustic.stop();
    b.setAttribute('aria-pressed', 'false');
    announce('Acoustic lab stopped.');
    return;
  }
  setView('acoustic');
  b.setAttribute('aria-pressed', 'true');
  const ok = await acoustic.start();
  if (!ok) { b.setAttribute('aria-pressed', 'false'); toast(acoustic.status || 'Audio could not start.'); return; }
  announce(acoustic.simulated
    ? 'No microphone available, so the acoustic lab is running a simulated loopback. The view is labelled simulated.'
    : 'Acoustic lab running. Tones play from 100 hertz to 10 kilohertz while the microphone listens.');
}

async function share() {
  let code;
  try { code = encodeLab(state.circuit); } catch { toast('This circuit cannot be encoded.'); return; }
  const url = `${location.origin}${location.pathname}#lab=${code}`;
  let copied = false;
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(url); copied = true; }
  } catch { /* fall back below */ }
  if (!copied) {
    const ta = document.createElement('textarea');
    ta.value = url;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { copied = document.execCommand('copy'); } catch { copied = false; }
    ta.remove();
  }
  const bytes = `#lab=${code}`.length;
  toast(copied ? `Lab link copied (${bytes} byte hash).` : `Copy this link from the address ${url}`);
  announce(copied ? 'Lab link copied to the clipboard.' : 'Could not copy. The link is shown on screen.');
}

/* ------------------------------------------------------------------ */
/* Scope controls and telemetry                                       */
/* ------------------------------------------------------------------ */

function setView(v) {
  state.view = v;
  scope.setView(v);
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === v)));
  const names = { dso: 'Time domain', fft: 'Spectrum', bode: 'Bode plot', acoustic: 'Acoustic lab' };
  announce(`${names[v]} view.`);
  save();
}

function setFlag(flag, on) {
  scope.flags[flag] = on;
  const b = flag === 'theory' ? $('#tg-theory') : $('#tg-math');
  b.setAttribute('aria-pressed', String(on));
  announce(`${flag === 'theory' ? 'Theory overlay' : 'Math power trace'} ${on ? 'on' : 'off'}.`);
  save();
}

function renderProbeSelects() {
  const nodes = nodeNames();
  for (const ch of ['ch1', 'ch2']) {
    const sel = $(`#sel-${ch}`);
    sel.innerHTML = '';
    for (const n of nodes) {
      const o = document.createElement('option');
      o.value = n; o.textContent = n;
      sel.appendChild(o);
    }
    if (!nodes.includes(state.circuit.probes[ch])) state.circuit.probes[ch] = nodes[ch === 'ch1' ? nodes.length - 1 : 0] || '';
    sel.value = state.circuit.probes[ch];
  }
}

function setProbe(ch, node) {
  if (!node || node === '0') return;
  state.circuit.probes[ch] = node;
  renderProbeSelects();
  announce(`${ch.toUpperCase()} probe on node ${node}.`);
  save();
  compute();
}

function fmtNum(v, unit, d = 4) { return Number.isFinite(v) ? formatSI(v, unit, d) : '--'; }

function updateTelemetry() {
  const r = state.result;
  const set = (id, v) => { $(id).textContent = v; };
  if (!r || !r.ok) {
    ['#m-vpp', '#m-vrms', '#m-freq', '#m-f0', '#m-rmse'].forEach((id) => set(id, '--'));
    set('#m-ms', r && r.ms ? `${r.ms.toFixed(1)} ms` : '--');
    return;
  }
  const m = r.chans.ch1 && r.chans.ch1.metrics;
  set('#m-vpp', m ? fmtNum(m.vpp, 'V') : '--');
  set('#m-vrms', m ? fmtNum(m.rms, 'V') : '--');
  set('#m-freq', m ? fmtNum(m.freq, 'Hz') : '--');
  const v = r.verify;
  let key = 'f0 / fc';
  let val = '--';
  const s = v && v.ok ? v.summary : null;
  if (s && state.circuit.lab === 'rc') { key = 'fc'; val = fmtNum(s.fc, 'Hz'); }
  else if (s && state.circuit.lab === 'rlc') { key = `f0 (ζ ${s.zeta.toFixed(3)})`; val = fmtNum(s.f0, 'Hz'); }
  else if (s && state.circuit.lab === 'inv') { key = 'Gain'; val = `${s.gain.toFixed(2)} V/V`; }
  else if (s && state.circuit.lab === 'rect') { key = 'Diode drop'; val = fmtNum(s.vf, 'V'); }
  else if (s && state.circuit.lab === 'div') { key = 'Vth / Rth'; val = `${fmtNum(s.vth, 'V', 3)} ${fmtNum(s.rth, 'Ω', 3)}`; }
  else if (r.ac && r.ac.ok && r.ac.refined && Number.isFinite(r.ac.refined.f3dB)) { key = 'fc'; val = fmtNum(r.ac.refined.f3dB, 'Hz'); }
  $('#m-f0k').textContent = key;
  set('#m-f0', val);
  set('#m-rmse', v && v.ok ? `${fmtPct(v.rmsePct)}` : '--');
  set('#m-ms', `${r.timing.total.toFixed(1)} ms${bridge.mode === 'worker' ? '' : ' (main)'}`);
  $('#m-ms').title = `Transient ${r.timing.tran.toFixed(1)} ms, AC ${r.timing.ac.toFixed(1)} ms, theory ${r.timing.theory.toFixed(1)} ms, computed in ${bridge.mode === 'worker' ? 'a Web Worker' : 'the main thread'}`;
}

function fmtPct(p) {
  if (!Number.isFinite(p)) return '--';
  if (p === 0) return '0 %';
  if (p < 0.001) return `${p.toExponential(1)} %`;
  if (p < 1) return `${p.toFixed(4)} %`;
  return `${p.toFixed(2)} %`;
}

/* ------------------------------------------------------------------ */
/* Verify panel and challenges                                        */
/* ------------------------------------------------------------------ */

function renderVerify(flash = false) {
  const body = $('#verify-body');
  const r = state.result;
  body.innerHTML = '';
  if (!r) return;
  if (!r.ok) {
    body.innerHTML = '<div class="verdict off"><div class="what"></div></div>';
    body.querySelector('.what').textContent = `The circuit did not solve. ${r.error ? r.error.message : ''}`;
    return;
  }
  const v = r.verify;
  if (!v || !v.ok) {
    body.innerHTML = '<div class="verdict off"><div class="what"></div></div>';
    body.querySelector('.what').textContent = v && v.reason ? v.reason : 'No closed-form model for this circuit.';
    return;
  }
  const verdict = document.createElement('div');
  verdict.className = `verdict ${v.exact ? 'ok' : 'approx'}`;
  verdict.innerHTML = '<div class="big"></div><div class="what"></div>';
  verdict.querySelector('.big').textContent = fmtPct(v.rmsePct);
  verdict.querySelector('.what').textContent = `RMSE of node ${v.node} against ${v.exact ? 'the exact closed form' : 'an approximate textbook model'}. ${fmtNum(v.rmse, 'V', 3)} RMS, max error ${fmtNum(v.maxErr, 'V', 3)} over ${r.tran.t.length} samples.`;
  body.appendChild(verdict);
  const model = document.createElement('p');
  model.className = 'model';
  model.textContent = v.model;
  body.appendChild(model);
  if (v.checks.length) {
    const t = document.createElement('table');
    t.className = 'checks';
    t.innerHTML = '<thead><tr><th scope="col">Check</th><th scope="col" class="num">Theory</th><th scope="col" class="num">Simulated</th><th scope="col"><span class="sr-only">Result</span></th></tr></thead><tbody></tbody>';
    const tb = t.querySelector('tbody');
    for (const c of v.checks) {
      const tr = document.createElement('tr');
      const unit = c.unit === 'V/V' || c.unit === '%' || c.unit === 'deg' || c.unit === 'dB' ? null : c.unit;
      const f = (x) => (unit ? fmtNum(x, unit, 5) : `${Number(x).toFixed(c.unit === 'V/V' ? 4 : 3)} ${c.unit === 'deg' ? '°' : c.unit}`);
      tr.innerHTML = '<td></td><td class="num"></td><td class="num"></td><td></td>';
      tr.children[0].textContent = c.name;
      tr.children[1].textContent = f(c.expected);
      tr.children[2].textContent = f(c.measured);
      tr.children[3].innerHTML = c.pass ? '<span class="pass" aria-label="pass">✓</span>' : '<span class="fail" aria-label="fail">✗</span>';
      tb.appendChild(tr);
    }
    body.appendChild(t);
  }
  if (flash) {
    const passed = v.checks.filter((c) => c.pass).length;
    announce(`Verified. RMSE ${fmtPct(v.rmsePct)} of full scale. ${passed} of ${v.checks.length} checks pass.`);
    toast(`RMSE ${fmtPct(v.rmsePct)}, ${passed}/${v.checks.length} checks pass`);
  }
}

function renderChallenges(evaluate = false) {
  const list = $('#challenges');
  const p = PRESETS[state.presetIdx];
  list.innerHTML = '';
  if (!p) {
    $('#score').textContent = '';
    const li = document.createElement('li');
    li.textContent = 'Custom circuit. Press 1 to 5 to load a guided lab with challenges.';
    list.appendChild(li);
    return;
  }
  const r = state.result;
  const ctx = { circuit: state.circuit, parts: Object.fromEntries(state.circuit.parts.map((q) => [q.id, q])), result: r || {} };
  let done = 0;
  p.challenges.forEach((c, i) => {
    let ok = false;
    if (r && r.ok) { try { ok = !!c.test(ctx); } catch { ok = false; } }
    const li = document.createElement('li');
    li.textContent = c.text;
    if (ok) { li.classList.add('done'); done++; }
    li.setAttribute('aria-label', `${ok ? 'Done' : 'To do'}. ${c.text}`);
    list.appendChild(li);
    if (ok && !state.done.has(i)) {
      state.done.add(i);
      if (evaluate) { toast(`Challenge ${i + 1} complete`); announce(`Challenge ${i + 1} complete. ${c.text}`); }
    }
    if (!ok) state.done.delete(i);
  });
  $('#score').textContent = `${done} / ${p.challenges.length}`;
}

/* ------------------------------------------------------------------ */
/* Parts list and inspector                                           */
/* ------------------------------------------------------------------ */

function renderParts() {
  const box = $('#parts');
  box.innerHTML = '';
  for (const p of state.circuit.parts) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'part-chip';
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(state.selected === p.id));
    b.textContent = p.id;
    b.title = PART_TYPES[p.type] ? PART_TYPES[p.type].label : p.type;
    b.addEventListener('click', () => select(p.id));
    box.appendChild(b);
  }
}

function select(id) {
  state.selected = id || null;
  schematic.select(state.selected);
  renderParts();
  renderInspector();
  if (id) {
    const p = byId(id);
    announce(`${id} selected, ${PART_TYPES[p.type].label}, ${describeValueText(p)}, from ${p.nodes.join(' to ')}.`);
  }
}

function describeValueText(p) {
  if (p.type === 'R' || p.type === 'C' || p.type === 'L') return formatSI(p.value, { R: 'ohm', C: 'F', L: 'H' }[p.type]);
  if (p.type === 'V') return `${p.wave.kind} source`;
  if (p.type === 'D') return p.model === 'led' ? 'red LED' : 'silicon diode';
  return `gain ${formatSI(p.gain || 1e5, '')}, rails ${p.rail || 12} V`;
}

let editAnnounceTimer = 0;
function announceEdit(label, v, unit) {
  clearTimeout(editAnnounceTimer);
  editAnnounceTimer = setTimeout(() => announce(`${label} ${formatSI(v, unit === '\u03a9' ? 'ohm' : unit)}.`), 450);
}

function siField(label, value, unit, onSet, range) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const id = `f-${Math.random().toString(36).slice(2, 8)}`;
  wrap.innerHTML = `<span id="${id}-l"></span><div class="field-row"><input class="si" spellcheck="false" autocomplete="off" aria-labelledby="${id}-l"></div>`;
  wrap.querySelector('span').textContent = unit ? `${label} (${unit})` : label;
  const input = wrap.querySelector('input');
  input.value = toSIInput(value);
  const row = wrap.querySelector('.field-row');
  let slider = null;
  if (range) {
    slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0'; slider.max = '1000'; slider.step = '1';
    slider.setAttribute('aria-labelledby', `${id}-l`);
    slider.value = String(Math.round(1000 * logToUnit(Math.min(range[1], Math.max(range[0], value)), range[0], range[1])));
    slider.addEventListener('input', () => {
      const v = +unitToLog(+slider.value / 1000, range[0], range[1]).toPrecision(3);
      input.value = toSIInput(v);
      input.removeAttribute('aria-invalid');
      onSet(v, true);
      announceEdit(label, v, unit);
    });
    row.appendChild(slider);
  } else {
    row.style.gridTemplateColumns = '1fr';
  }
  const commit = () => {
    const v = parseSI(input.value);
    if (!Number.isFinite(v)) { input.setAttribute('aria-invalid', 'true'); announce(`${label} needs a number like 1k, 100n or 4.7m.`); return; }
    input.removeAttribute('aria-invalid');
    if (slider) slider.value = String(Math.round(1000 * logToUnit(Math.min(range[1], Math.max(range[0], Math.abs(v) || range[0])), range[0], range[1])));
    onSet(v, false);
    announceEdit(label, v, unit);
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(); e.preventDefault(); } });
  return wrap;
}

function selectField(label, options, value, onSet) {
  const wrap = document.createElement('label');
  wrap.className = 'field';
  wrap.innerHTML = '<span></span><select></select>';
  wrap.querySelector('span').textContent = label;
  const sel = wrap.querySelector('select');
  for (const [v, t] of options) { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); }
  sel.value = value;
  sel.addEventListener('change', () => onSet(sel.value));
  return wrap;
}

function changed(live = false) {
  save();
  compute(live ? 0 : 0);
  if (!live) describeCircuit();
}

function structuralChange() {
  schematic.setCircuit(state.circuit);
  renderParts();
  renderInspector();
  renderProbeSelects();
  renderTimebase();
  renderChallenges();
  describeCircuit();
  save();
  compute();
}

const PIN_NAMES = {
  R: ['End a', 'End b'], C: ['End a', 'End b'], L: ['End a', 'End b'],
  V: ['+ terminal', '- terminal'], D: ['Anode', 'Cathode'], OPAMP: ['+ input', '- input', 'Output'],
};

function renderInspector() {
  const box = $('#inspector');
  box.innerHTML = '';
  const p = state.selected && byId(state.selected);
  if (!p) {
    const e = document.createElement('p');
    e.className = 'empty';
    e.textContent = 'Select a part on the schematic or in the parts list to tune it.';
    box.appendChild(e);
    return;
  }
  const title = document.createElement('div');
  title.className = 'insp-title';
  title.innerHTML = '<strong></strong><span></span>';
  title.querySelector('strong').textContent = p.id;
  title.querySelector('span').textContent = PART_TYPES[p.type].label;
  box.appendChild(title);

  if (p.type === 'R' || p.type === 'C' || p.type === 'L') {
    const unit = { R: 'Ω', C: 'F', L: 'H' }[p.type];
    box.appendChild(siField('Value', p.value, unit, (v) => {
      if (!(v > 0)) { announce('Value must be positive.'); return; }
      p.value = v;
      changed(true);
    }, RANGES[p.type]));
  } else if (p.type === 'V') {
    const w = p.wave;
    box.appendChild(selectField('Waveform', [['dc', 'DC'], ['step', 'Step'], ['sine', 'Sine'], ['square', 'Square'], ['triangle', 'Triangle'], ['chirp', 'Chirp']], w.kind, (k) => {
      w.kind = k;
      if (k === 'dc' && !Number.isFinite(w.offset)) w.offset = 5;
      if (k !== 'dc' && !(Math.abs(w.amp) > 0)) w.amp = 1;
      if (!(w.freq > 0)) w.freq = 1000;
      if (k === 'chirp') { w.f2 = w.f2 || w.freq * 10; w.sweep = state.circuit.sim.tstop; }
      fitTimebase(w);
      renderInspector();
      schematic.setCircuit(state.circuit);
      changed();
    }));
    const num = (key, label, unit, range) => box.appendChild(siField(label, w[key] ?? 0, unit, (v) => {
      w[key] = v;
      if (key === 'freq') fitTimebase(w);
      changed(true);
    }, range));
    if (w.kind === 'dc') num('offset', 'Level', 'V');
    else {
      num('amp', w.kind === 'step' ? 'Step size' : 'Amplitude', 'V');
      num('offset', w.kind === 'step' ? 'Start level' : 'Offset', 'V');
    }
    if (w.kind === 'sine' || w.kind === 'square' || w.kind === 'triangle') num('freq', 'Frequency', 'Hz', RANGES.freq);
    if (w.kind === 'square') box.appendChild(siField('Duty cycle', w.duty ?? 0.5, '', (v) => { if (v > 0 && v < 1) { w.duty = v; changed(true); } }));
    if (w.kind === 'sine') num('phase', 'Phase', 'deg');
    if (w.kind === 'step') num('delay', 'Delay', 's');
    if (w.kind === 'chirp') {
      num('freq', 'Start frequency', 'Hz', RANGES.freq);
      num('f2', 'End frequency', 'Hz', RANGES.freq);
      num('sweep', 'Sweep time', 's');
    }
  } else if (p.type === 'D') {
    box.appendChild(selectField('Model', [['si', 'Silicon (Is 10 fA, n 1)'], ['led', 'Red LED (Is 1 aA, n 2)']], p.model || 'si', (m) => {
      p.model = m;
      schematic.setCircuit(state.circuit);
      changed();
    }));
  } else if (p.type === 'OPAMP') {
    box.appendChild(siField('Open-loop gain', p.gain ?? 1e5, 'V/V', (v) => { if (v > 1) { p.gain = v; changed(true); } }, RANGES.gain));
    box.appendChild(siField('Supply rails (±)', p.rail ?? 12, 'V', (v) => { if (v > 0 && v <= 100) { p.rail = v; changed(true); } }));
  }

  // Node connections.
  const nodesWrap = document.createElement('div');
  nodesWrap.className = 'field';
  nodesWrap.innerHTML = '<span>Connections</span><div class="nodes"></div>';
  const grid = nodesWrap.querySelector('.nodes');
  const all = nodeNames();
  p.nodes.forEach((n, i) => {
    const l = document.createElement('label');
    l.innerHTML = '<span></span><select class="si"></select>';
    l.querySelector('span').textContent = PIN_NAMES[p.type][i];
    const sel = l.querySelector('select');
    for (const opt of ['0', ...all, '+new']) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt === '0' ? '0 (ground)' : opt === '+new' ? 'New node' : opt;
      sel.appendChild(o);
    }
    sel.value = n;
    sel.addEventListener('change', () => {
      p.nodes[i] = sel.value === '+new' ? newNodeName() : sel.value;
      if (state.circuit.nodePos) for (const k of Object.keys(state.circuit.nodePos)) if (!nodeNames().includes(k)) delete state.circuit.nodePos[k];
      structuralChange();
      announce(`${p.id} ${PIN_NAMES[p.type][i]} now on node ${p.nodes[i]}.`);
    });
    grid.appendChild(l);
  });
  box.appendChild(nodesWrap);

  const actions = document.createElement('div');
  actions.className = 'row-actions';
  actions.innerHTML = '<button type="button" class="btn btn-small" data-act="rot">Rotate</button><button type="button" class="btn btn-small" data-act="math">Use for Math V×I</button><button type="button" class="btn btn-small btn-danger" data-act="del">Delete</button>';
  actions.querySelector('[data-act=rot]').addEventListener('click', () => {
    const a = p.at || [0, 0, 0];
    p.at = [a[0], a[1], p.type === 'OPAMP' ? (a[2] === 2 ? 0 : 2) : (a[2] + 1) % 4];
    schematic.setCircuit(state.circuit);
    save();
  });
  actions.querySelector('[data-act=math]').addEventListener('click', () => {
    state.circuit.math = p.id;
    renderTimebase();
    setFlag('math', true);
    compute();
  });
  actions.querySelector('[data-act=del]').addEventListener('click', () => deletePart(p.id));
  box.appendChild(actions);
}

/**
 * Keep a periodic source readable: if the window shows fewer than 3 or more than 400 cycles,
 * reset it to 6 cycles at 2000 samples per window and say so.
 */
function fitTimebase(w) {
  if (!['sine', 'square', 'triangle'].includes(w.kind) || !(w.freq > 0)) return;
  const sim = state.circuit.sim;
  const cycles = sim.tstop * w.freq;
  if (cycles >= 3 && cycles <= 400) return;
  sim.tstop = +(6 / w.freq).toPrecision(4);
  sim.dt = +(sim.tstop / 2000).toPrecision(4);
  renderTimebase();
  announce(`Window set to ${formatSI(sim.tstop, 's')} so six cycles fit.`);
}

function deletePart(id) {
  if (state.circuit.parts.length <= 1) { toast('Keep at least one part.'); return; }
  state.circuit.parts = state.circuit.parts.filter((q) => q.id !== id);
  if (state.circuit.math === id) state.circuit.math = '';
  state.selected = null;
  schematic.select(null);
  structuralChange();
  announce(`${id} deleted.`);
}

function addPart(type) {
  const c = state.circuit;
  const id = nextId(type);
  let maxX = -Infinity;
  let minY = Infinity;
  for (const p of c.parts) { if (p.at) { maxX = Math.max(maxX, p.at[0]); minY = Math.min(minY, p.at[1]); } }
  if (!Number.isFinite(maxX)) { maxX = 0; minY = 3; }
  const sel = state.selected && byId(state.selected);
  const anchor = (sel && sel.nodes.find((n) => n !== '0')) || c.probes.ch1 || nodeNames()[0] || newNodeName();
  const x = maxX + 3;
  let part;
  if (type === 'R') part = { id, type, nodes: [anchor, '0'], value: 1000, at: [x, minY + 1, 1] };
  else if (type === 'C') part = { id, type, nodes: [anchor, '0'], value: 1e-6, at: [x, minY + 1, 1] };
  else if (type === 'L') part = { id, type, nodes: [anchor, newNodeName()], value: 1e-3, at: [x, minY, 0] };
  else if (type === 'D') part = { id, type, nodes: [anchor, newNodeName()], model: 'si', at: [x, minY, 0] };
  else if (type === 'V') part = { id, type, nodes: [newNodeName(), '0'], wave: { kind: 'sine', amp: 1, offset: 0, freq: 1000 }, at: [x, minY + 1, 1] };
  else part = { id, type: 'OPAMP', nodes: ['0', anchor, newNodeName()], gain: 1e5, rail: 12, at: [x + 1, minY + 1, 0] };
  c.parts.push(part);
  state.selected = id;
  schematic.select(id);
  structuralChange();
  announce(`Added ${id}, ${PART_TYPES[type].label}, connected ${part.nodes.join(' to ')}.`);
}

function renderTimebase() {
  const c = state.circuit;
  const tstop = $('#in-tstop');
  const dt = $('#in-dt');
  tstop.value = toSIInput(c.sim.tstop);
  dt.value = toSIInput(c.sim.dt);
  $('#in-method').value = c.sim.method === 'be' ? 'be' : 'trap';
  const m = $('#in-math');
  m.innerHTML = '';
  for (const p of c.parts) {
    if (p.type === 'OPAMP') continue;
    const o = document.createElement('option');
    o.value = p.id; o.textContent = p.id;
    m.appendChild(o);
  }
  m.value = c.math || '';
}

function bindTimebase() {
  const apply = (input, key) => {
    const v = parseSI(input.value);
    const c = state.circuit;
    const next = { ...c.sim, [key]: v };
    const steps = next.tstop / next.dt;
    if (!(v > 0) || !(steps >= 4) || steps > 20000) {
      input.setAttribute('aria-invalid', 'true');
      announce('Window divided by step must be between 4 and 20000 samples.');
      return;
    }
    input.removeAttribute('aria-invalid');
    c.sim[key] = v;
    changed();
  };
  $('#in-tstop').addEventListener('change', (e) => apply(e.target, 'tstop'));
  $('#in-dt').addEventListener('change', (e) => apply(e.target, 'dt'));
  $('#in-method').addEventListener('change', (e) => { state.circuit.sim.method = e.target.value; changed(); });
  $('#in-math').addEventListener('change', (e) => { state.circuit.math = e.target.value; changed(); });
}

function describeCircuit() {
  const parts = state.circuit.parts.map((p) => `${p.id} ${describeValueText(p)} from ${p.nodes.map((n) => (n === '0' ? 'ground' : n)).join(' to ')}`);
  $('#schem-desc').textContent = `${parts.length} parts. ${parts.join('. ')}.`;
}

/* ------------------------------------------------------------------ */
/* Keyboard                                                           */
/* ------------------------------------------------------------------ */

function nudge(p, dir, big) {
  const f = big ? 1.25 : 1.05;
  const k = dir > 0 ? f : 1 / f;
  if (p.type === 'R' || p.type === 'C' || p.type === 'L') p.value = +(p.value * k).toPrecision(4);
  else if (p.type === 'V') {
    if (p.wave.kind === 'dc') p.wave.offset = +((p.wave.offset || 0.1) * k).toPrecision(4);
    else p.wave.amp = +(p.wave.amp * k).toPrecision(4);
  } else if (p.type === 'OPAMP') p.rail = Math.min(100, +(p.rail * k).toPrecision(3));
  else return;
  renderInspector();
  announce(`${p.id} ${describeValueText(p)}.`);
  changed(true);
}

function onKey(e) {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  const tag = t && t.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
  if ($('#help').open) return;
  const inSchem = t === $('#schematic');
  const inScope = t === $('#scope');
  const k = e.key;
  if (inSchem) {
    const parts = state.circuit.parts;
    const i = parts.findIndex((p) => p.id === state.selected);
    if (k === 'ArrowRight' || k === 'ArrowLeft') {
      const j = i < 0 ? 0 : (i + (k === 'ArrowRight' ? 1 : -1) + parts.length) % parts.length;
      select(parts[j].id);
      e.preventDefault();
      return;
    }
    if ((k === 'ArrowUp' || k === 'ArrowDown') && i >= 0) { nudge(parts[i], k === 'ArrowUp' ? 1 : -1, e.shiftKey); e.preventDefault(); return; }
    if (k === 'n' || k === 'N') {
      const ns = nodeNames();
      const j = (ns.indexOf(state.focusNode) + 1) % ns.length;
      state.focusNode = ns[j];
      schematic.focusNode = ns[j];
      const r = state.result;
      const v = r && r.ok ? r.tran.nodes[ns[j]][schematic.index] : NaN;
      announce(`Node ${ns[j]}, ${fmtNum(v, 'volts', 4)}. Press 1 for CH1 or 2 for CH2.`);
      e.preventDefault();
      return;
    }
    if ((k === '1' || k === '2') && state.focusNode) { setProbe(k === '1' ? 'ch1' : 'ch2', state.focusNode); e.preventDefault(); return; }
    if (k === 'Enter' && state.selected) {
      const inp = $('#inspector input.si, #inspector select');
      if (inp) inp.focus();
      e.preventDefault();
      return;
    }
    if ((k === 'Delete' || k === 'Backspace') && state.selected) { deletePart(state.selected); e.preventDefault(); return; }
    if (k === 'Escape') { select(null); state.focusNode = null; schematic.focusNode = null; return; }
  }
  if (inScope && (k === 'ArrowLeft' || k === 'ArrowRight')) {
    scope.nudgeCursor(state.cursorSel, (k === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 0.05 : 0.005));
    const c = scope.cursorReadout();
    if (c) announce(`Cursor ${state.cursorSel ? 'b' : 'a'} at ${formatSI(state.cursorSel ? c.tb : c.ta, 's')}, CH1 ${fmtNum(state.cursorSel ? c.vb : c.va, 'V')}. Delta t ${formatSI(c.dt, 's')}.`);
    e.preventDefault();
    return;
  }
  if (t && (t.tagName === 'BUTTON' || t.tagName === 'SUMMARY') && (k === ' ' || k === 'Enter')) return;
  if (k >= '1' && k <= '5') { loadPreset(+k - 1); e.preventDefault(); }
  else if (k === ' ') { setRunning(!state.running); e.preventDefault(); }
  else if (k === 's' || k === 'S') toggleSonify();
  else if (k === 't' || k === 'T') setFlag('theory', !scope.flags.theory);
  else if (k === 'm' || k === 'M') setFlag('math', !scope.flags.math);
  else if (k === 'v' || k === 'V') setView(VIEWS[(VIEWS.indexOf(state.view) + 1) % VIEWS.length]);
  else if (k === 'r' || k === 'R') {
    if (state.presetIdx >= 0) { loadPreset(state.presetIdx); toast('Lab reset'); }
  } else if (k === 'a' || k === 'A' || k === 'b' || k === 'B') {
    state.cursorSel = k.toLowerCase() === 'a' ? 0 : 1;
    $('#scope').focus();
    announce(`Cursor ${k.toLowerCase()} selected. Use the arrow keys to move it.`);
  } else if (k === '?') $('#help').showModal();
}

/* ------------------------------------------------------------------ */
/* Animation loop                                                     */
/* ------------------------------------------------------------------ */

function frame(now) {
  const r = state.result;
  const n = r && r.ok ? r.tran.t.length : 0;
  if (state.running) {
    state.sweepPos = ((now - state.sweepT0) % SWEEP_MS) / SWEEP_MS;
    scope.sweep = state.sweepPos;
    if (n) schematic.setIndex(Math.round(state.sweepPos * (n - 1)));
  } else {
    scope.sweep = null;
    if (n) schematic.setIndex(Math.round(scope.cursors.t[0] * (n - 1)));
  }
  const ph = sonifier.progress();
  scope.playhead = ph;
  if (ph === null && $('#btn-sonify').getAttribute('aria-pressed') === 'true') $('#btn-sonify').setAttribute('aria-pressed', 'false');
  if (state.view === 'acoustic') scope.acoustic = acoustic.ctx || acoustic.response.length ? acoustic.frame() : null;
  scope.draw();
  schematic.draw(now);
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

function bind() {
  $('#btn-run').addEventListener('click', () => setRunning(!state.running));
  $('#btn-sonify').addEventListener('click', toggleSonify);
  $('#btn-acoustic').addEventListener('click', toggleAcoustic);
  $('#btn-share').addEventListener('click', share);
  $('#btn-help').addEventListener('click', () => $('#help').showModal());
  $('#btn-verify').addEventListener('click', async () => {
    const res = await bridge.run(JSON.parse(JSON.stringify(state.circuit)));
    state.applied = ++state.seq;
    applyResult(res);
    renderVerify(true);
  });
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
  $('#tg-theory').addEventListener('click', () => setFlag('theory', !scope.flags.theory));
  $('#tg-math').addEventListener('click', () => setFlag('math', !scope.flags.math));
  $('#sel-ch1').addEventListener('change', (e) => setProbe('ch1', e.target.value));
  $('#sel-ch2').addEventListener('change', (e) => setProbe('ch2', e.target.value));
  document.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => addPart(b.dataset.add)));
  document.addEventListener('keydown', onKey);
  bindTimebase();
  const ro = new ResizeObserver(() => { schematic.resize(); scope.resize(); });
  ro.observe($('#schematic'));
  ro.observe($('#scope'));
  schematic.resize();
  scope.resize();
  window.addEventListener('hashchange', () => {
    const h = labFromHash(location.hash);
    if (h && h.ok) { loadCircuit(h.circuit); toast('Lab loaded from link'); clearHash(); }
    else if (h) toast(`Link not loaded. ${h.error}`);
  });
}

function clearHash() {
  try { history.replaceState(null, '', location.pathname + location.search); } catch { /* file:// */ }
}

function boot() {
  bind();
  try {
    const ui = JSON.parse(safeGet(STORE_UI) || '{}');
    if (VIEWS.includes(ui.view) && ui.view !== 'acoustic') state.view = ui.view;
    if (typeof ui.theory === 'boolean') scope.flags.theory = ui.theory;
    if (typeof ui.math === 'boolean') scope.flags.math = ui.math;
  } catch { /* ignore */ }
  $('#tg-theory').setAttribute('aria-pressed', String(scope.flags.theory));
  $('#tg-math').setAttribute('aria-pressed', String(scope.flags.math));
  scope.setView(state.view);
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === state.view)));
  $('#btn-run').setAttribute('aria-pressed', String(state.running));
  $('#btn-run .lbl').textContent = state.running ? 'Pause' : 'Run';

  // Startup order: share link, then autosave, then lab 1.
  let circuit = null;
  const fromHash = labFromHash(location.hash);
  if (fromHash && fromHash.ok) { circuit = fromHash.circuit; clearHash(); setTimeout(() => toast('Lab loaded from link'), 300); }
  else if (fromHash) setTimeout(() => toast(`Link not loaded. ${fromHash.error}`), 300);
  if (!circuit) {
    const saved = safeGet(STORE);
    if (saved) {
      const h = labFromHash(`#lab=${saved}`);
      if (h && h.ok) circuit = h.circuit;
    }
  }
  loadCircuit(circuit || presetCircuit(0), { announceIt: false });
  requestAnimationFrame(frame);
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline cache is optional */ });
  }
}

boot();

// Exposed for automated checks in a browser console; not used by the app itself.
window.benchzero = { state, nodePositions };
