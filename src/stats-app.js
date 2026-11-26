// BenchZero Rigor page controller: paired benchmark significance, power and
// contamination views, checksummed exports, #bz= links and the self-test panel.

import {
  analyzeSuite, holmAdjust, mcnemarPower, mde, contaminationCurve,
  leakBreakEven, mulberry32,
} from './stats-lab.js';
import {
  parseRows, buildReport, verifyReport, replayReport, resultsToCsv,
  resultsToMarkdown, encodeState, stateFromHash, rowsToText, runSelfTests,
  MAX_ITEMS, MAX_SUITES,
} from './stats-io.js';

const $ = (s) => document.querySelector(s);
const STORE = 'benchzero:rigor:v1';

const state = {
  models: ['Model A', 'Model B'],
  suites: [],
  active: 0,
  seed: 7,
  reps: 10000,
  alpha: 0.05,
  level: 0.95,
  pdisc: 0.3,
  contamPct: 5,
  analysis: null,
  report: null,
};

/* ------------------------------------------------------------------ */
/* Synthetic example data (labelled synthetic on screen)               */
/* ------------------------------------------------------------------ */

// Deterministic paired data: item i is easy for model A with probability pA;
// model B shares most of A's outcomes (a correlated rater with a small true
// disadvantage), so the demo shows a real but shaky lead whose significance a
// judge can question. Generated from a fixed seed so every visitor sees the
// same numbers and every claim in the report replays.
function makeExample() {
  const rng = mulberry32(20261122);
  const gen = (name, n, pA, gap) => {
    const rows = [];
    for (let i = 0; i < n; i++) {
      const a = rng() < pA ? 1 : 0;
      // B disagrees on a fraction of items; when it does, it flips A's
      // answer with probability ~55% so the realized gap lands near `gap`.
      const b = rng() < 0.28 ? (rng() < 0.45 ? a : 1 - a) : a;
      rows.push({ id: `i${i + 1}`, a, b });
    }
    const accA = rows.reduce((s, r) => s + r.a, 0) / n;
    const accB = rows.reduce((s, r) => s + r.b, 0) / n;
    return { name, text: rowsToText(rows), rows, accA, accB };
  };
  const suites = [];
  let tries = 0;
  // Resample until each suite's realized delta lands inside its target band,
  // so the shipped example always tells the same story.
  for (const spec of [
    ['alpha bench (synthetic)', 120, 0.74, 0.06],
    ['beta bench (synthetic)', 48, 0.55, 0.10],
  ]) {
    let s;
    do { s = gen(spec[0], spec[1], spec[2], spec[3]); tries++; } while (tries < 400 && Math.abs((s.accA - s.accB) - spec[3]) > 0.03);
    suites.push(s);
  }
  return suites;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pct = (v, d = 1) => `${(v * 100).toFixed(d)}%`;
const pts = (v, d = 1) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(d)}`;
const fmtP = (p) => (p < 1e-4 ? p.toExponential(2) : p.toFixed(4));

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

function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }

function save() {
  safeSet(STORE, JSON.stringify({
    models: state.models, seed: state.seed, reps: state.reps,
    alpha: state.alpha, level: state.level, active: state.active,
    pdisc: state.pdisc, contamPct: state.contamPct,
    suites: state.suites.map((s) => ({ name: s.name, text: s.text })),
  }));
}

/* ------------------------------------------------------------------ */
/* Rendering: tabs and inputs                                          */
/* ------------------------------------------------------------------ */

function renderTabs() {
  const box = $('#st-tabs');
  box.innerHTML = '';
  state.suites.forEach((s, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'part-chip';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(i === state.active));
    b.textContent = s.name;
    b.addEventListener('click', () => { state.active = i; syncInputs(); analyze(); });
    box.appendChild(b);
  });
}

function syncInputs() {
  const s = state.suites[state.active];
  $('#st-model-a').value = state.models[0];
  $('#st-model-b').value = state.models[1];
  $('#st-sname').value = s ? s.name : '';
  $('#st-data').value = s ? s.text : '';
  $('#st-seed').value = String(state.seed);
  $('#st-reps').value = String(state.reps);
  $('#st-alpha').value = String(state.alpha);
  $('#st-level').value = String(state.level);
  $('#st-pdisc').value = String(state.pdisc);
  $('#st-contam-slider').value = String(state.contamPct);
}

/* ------------------------------------------------------------------ */
/* Analysis                                                            */
/* ------------------------------------------------------------------ */

function analyze() {
  const bad = [];
  for (const s of state.suites) {
    const p = parseRows(s.text);
    if (p.ok) { s.rows = p.rows; s.skipped = p.skipped; }
    else { s.rows = null; s.skipped = []; bad.push(`${s.name}: ${p.error}`); }
  }
  const usable = state.suites.filter((s) => s.rows);
  const results = usable.map((s) => ({ name: s.name, ...analyzeSuite(s.rows, { seed: state.seed, reps: state.reps, level: state.level }) }));
  const holm = holmAdjust(results.map((r) => r.pPrimary));
  results.forEach((r, i) => { r.pAdj = holm.adjusted[i]; });
  state.analysis = { results, bad };
  state.report = buildReport({
    models: state.models, seed: state.seed, reps: state.reps,
    alpha: state.alpha, level: state.level,
    suites: usable.map((s) => ({ name: s.name, rows: s.rows })),
    results,
    now: new Date().toISOString(),
  });
  renderResults();
  renderPower();
  renderContam();
  renderReport();
  save();
}

/* ------------------------------------------------------------------ */
/* Rendering: results panel                                            */
/* ------------------------------------------------------------------ */

function renderResults() {
  const { results, bad } = state.analysis;
  const r = results[state.active] || results[0];
  const suite = state.suites[state.active];
  if (!r) {
    $('#m-n').textContent = '--';
    $('#m-acca').textContent = '--';
    $('#m-accb').textContent = '--';
    $('#m-delta').textContent = '--';
    $('#m-ci').textContent = '--';
    $('#m-p').textContent = '--';
    $('#st-tables').innerHTML = `<p class="empty">No usable rows yet. Paste paired scores or press Example.</p>`;
    $('#st-verdict-tag').textContent = '';
    return;
  }
  $('#m-n').textContent = String(r.n);
  $('#m-acca').textContent = pct(r.accA);
  $('#m-accb').textContent = pct(r.accB);
  $('#m-delta').textContent = pts(r.delta);
  $('#m-ci').textContent = `[${pts(r.boot.lo)}, ${pts(r.boot.hi)}]`;
  $('#m-p').textContent = r.mc ? `${fmtP(r.mc.pExact)} / ${fmtP(r.pAdj)}` : `${fmtP(r.boot.p)} / ${fmtP(r.pAdj)}`;
  const sig = r.pAdj < state.alpha;
  $('#st-verdict-tag').textContent = sig ? `significant at alpha ${state.alpha}` : `not significant at alpha ${state.alpha}`;

  const rows = results.map((q, i) => {
    const v = q.pAdj < state.alpha ? '<span class="pass">significant</span>' : '<span class="fail">not significant</span>';
    const disc = q.mc ? `${q.n10} / ${q.n01}` : '<span class="fail">withheld</span>';
    return `<tr><td>${esc(q.name)}</td><td class="num">${q.n}</td>`
      + `<td class="num">${pct(q.accA)}</td><td class="num">${pct(q.accB)}</td>`
      + `<td class="num">${pts(q.delta)}</td>`
      + `<td class="num">[${pts(q.boot.lo)}, ${pts(q.boot.hi)}]</td>`
      + `<td class="num">${fmtP(q.boot.p)}</td>`
      + `<td class="num">${disc}</td>`
      + `<td class="num">${q.mc ? fmtP(q.mc.pExact) : '-'}</td>`
      + `<td class="num">${fmtP(q.pAdj)}</td><td>${v}</td></tr>`;
  }).join('');

  let detail = '';
  if (r.mc) {
    detail = `<div class="notice st-disc"><strong>discordant pairs</strong>`
      + `<span>${esc(state.models[0])} only: ${r.n10} &nbsp; ${esc(state.models[1])} only: ${r.n01} &nbsp; `
      + `chi2 (cc) ${r.mc.chi2cc.toFixed(3)}, exact p ${fmtP(r.mc.pExact)}, chi-square p ${fmtP(r.mc.pChi2)}</span></div>`;
  } else {
    detail = `<div class="notice st-disc"><strong>McNemar withheld</strong>`
      + `<span>scores sit outside [0,1] and [0,100], so "correct" has no threshold; bootstrap significance still applies.</span></div>`;
  }
  const scaleNote = r.scale.scale === 'percent'
    ? 'correctness threshold: score >= 50 on the 0-100 scale'
    : r.scale.scale === 'unit' ? 'correctness threshold: score >= 0.5 on the 0-1 scale' : '';
  const skips = suite && suite.skipped && suite.skipped.length
    ? `<p class="tb-note">${suite.skipped.length} line(s) could not be parsed and were excluded: line ${suite.skipped.slice(0, 5).join(', ')}${suite.skipped.length > 5 ? ', ...' : ''}</p>` : '';
  const warns = bad.map((w) => `<p class="tb-note">${esc(w)}</p>`).join('');
  $('#st-tables').innerHTML = `${detail}${skips}${warns}`
    + `<table class="checks st-table"><thead><tr><th>suite</th><th>n</th><th>acc A</th><th>acc B</th>`
    + `<th>delta</th><th>CI</th><th>p boot</th><th>n10/n01</th><th>p exact</th><th>p adj</th><th>verdict</th></tr></thead>`
    + `<tbody>${rows}</tbody></table>`
    + (scaleNote ? `<p class="tb-note">${scaleNote}</p>` : '');
}

/* ------------------------------------------------------------------ */
/* Rendering: SVG plots                                                */
/* ------------------------------------------------------------------ */

const SVGNS = 'http://www.w3.org/2000/svg';
const CW = 560;
const CH = 260;
const PAD = { l: 46, r: 12, t: 12, b: 30 };

function svgRoot() {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${CW} ${CH}`);
  svg.setAttribute('role', 'img');
  return svg;
}
function el(tag, attrs) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}
function txt(svg, x, y, s, cls = 'ax') {
  const t = el('text', { x, y, class: cls });
  t.textContent = s;
  svg.appendChild(t);
}
function line(svg, x1, y1, x2, y2, cls) {
  svg.appendChild(el('line', { x1, y1, x2, y2, class: cls }));
}
function path(svg, d, cls) {
  svg.appendChild(el('path', { d, class: cls, fill: 'none' }));
}
function dot(svg, cx, cy, r, cls) {
  svg.appendChild(el('circle', { cx, cy, r, class: cls }));
}

function renderPower() {
  const box = $('#st-power');
  box.innerHTML = '';
  const { results } = state.analysis;
  const r = results[state.active] || results[0];
  const svg = svgRoot();
  svg.setAttribute('aria-label', 'Statistical power versus benchmark item count for three effect sizes');
  const nMin = 25;
  const nMax = 5000;
  const x = (N) => PAD.l + ((Math.log10(N) - Math.log10(nMin)) / (Math.log10(nMax) - Math.log10(nMin))) * (CW - PAD.l - PAD.r);
  const y = (p) => CH - PAD.b - p * (CH - PAD.t - PAD.b);
  for (const N of [50, 100, 200, 500, 1000, 2000, 5000]) {
    line(svg, x(N), y(0), x(N), y(1), 'grid');
    txt(svg, x(N) - 10, CH - PAD.b + 16, N >= 1000 ? `${N / 1000}k` : `${N}`);
  }
  for (const p of [0, 0.5, 0.8, 1]) {
    line(svg, PAD.l, y(p), CW - PAD.r, y(p), p === 0.8 ? 'grid target' : 'grid');
    txt(svg, 6, y(p) + 4, `${Math.round(p * 100)}%`);
  }
  txt(svg, PAD.l - 4, CH - 4, 'N items');
  const deltas = [[0.01, 'd1'], [0.02, 'd2'], [0.05, 'd3']];
  for (const [d, cls] of deltas) {
    let dAttr = '';
    for (let i = 0; i <= 60; i++) {
      const N = Math.round(10 ** (Math.log10(nMin) + (i / 60) * (Math.log10(nMax) - Math.log10(nMin))));
      const p = mcnemarPower(N, state.pdisc, d, state.alpha);
      dAttr += `${i === 0 ? 'M' : 'L'}${x(N).toFixed(1)},${y(p).toFixed(1)} `;
    }
    path(svg, dAttr, `curve ${cls}`);
  }
  // Legend.
  txt(svg, CW - PAD.r - 150, PAD.t + 10, '+1 pt', 'leg d1');
  txt(svg, CW - PAD.r - 100, PAD.t + 10, '+2 pt', 'leg d2');
  txt(svg, CW - PAD.r - 50, PAD.t + 10, '+5 pt', 'leg d3');
  // Current N marker.
  if (r) {
    line(svg, x(r.n), y(0), x(r.n), y(1), 'marker');
    txt(svg, Math.min(x(r.n) + 4, CW - 60), PAD.t + 24, `this suite N=${r.n}`, 'mk');
  }
  box.appendChild(svg);

  const disc = r && r.mc ? r.nDisc / r.n : null;
  $('#st-pdisc-v').textContent = `pDisc ${state.pdisc.toFixed(2)}${disc !== null ? ` (observed ${disc.toFixed(2)})` : ''}`;
  if (r) {
    const m = mde(r.n, state.pdisc, state.alpha, 0.8);
    $('#st-mde-tag').textContent = m.reached
      ? `MDE at N=${r.n}: ${pts(m.delta)} for 80% power`
      : `even ${pts(m.delta)} cannot reach 80% power at N=${r.n}`;
  } else {
    $('#st-mde-tag').textContent = '';
  }
}

function renderContam() {
  const box = $('#st-contam');
  box.innerHTML = '';
  const { results } = state.analysis;
  const r = results[state.active] || results[0];
  const svg = svgRoot();
  svg.setAttribute('aria-label', 'Worst-case adjusted lead versus assumed test-set leakage');
  const cMax = 0.2;
  const accA = r ? r.accA : 0.8;
  const accB = r ? r.accB : 0.7;
  const delta = accA - accB;
  const yMin = Math.min(0, contaminationCurve(accA, accB, [cMax])[0].deltaUpper, delta) - 0.02;
  const yMax = Math.max(0.02, delta) + 0.02;
  const x = (c) => PAD.l + (c / cMax) * (CW - PAD.l - PAD.r);
  const y = (v) => CH - PAD.b - ((v - yMin) / (yMax - yMin)) * (CH - PAD.t - PAD.b);
  for (const c of [0, 0.05, 0.1, 0.15, 0.2]) {
    line(svg, x(c), y(yMin), x(c), y(yMax), 'grid');
    txt(svg, x(c) - 8, CH - PAD.b + 16, `${c * 100}%`);
  }
  const yTicks = [];
  for (let v = Math.ceil(yMin / 0.05) * 0.05; v <= yMax; v += 0.05) yTicks.push(v);
  for (const v of yTicks) {
    line(svg, PAD.l, y(v), CW - PAD.r, y(v), Math.abs(v) < 1e-9 ? 'grid target' : 'grid');
    txt(svg, 6, y(v) + 4, pts(v, 0));
  }
  txt(svg, PAD.l - 4, CH - 4, 'leakage');
  // Worst-case adjusted delta curve.
  const curve = contaminationCurve(accA, accB, Array.from({ length: 81 }, (_, i) => (i / 80) * cMax));
  let dAttr = '';
  curve.forEach((pt, i) => {
    if (pt.ok) dAttr += `${i === 0 ? 'M' : 'L'}${x(pt.c).toFixed(1)},${y(Math.max(pt.deltaUpper, yMin)).toFixed(1)} `;
  });
  path(svg, dAttr, 'curve d3');
  line(svg, PAD.l, y(0), CW - PAD.r, y(0), 'marker');
  txt(svg, PAD.l + 4, y(0) - 5, 'lead gone', 'mk');
  // Break-even and slider markers.
  const be = leakBreakEven(accA, accB);
  if (be !== null && be <= cMax) {
    line(svg, x(be), y(yMin), x(be), y(yMax), 'marker');
    txt(svg, Math.min(x(be) + 4, CW - 90), PAD.t + 12, `evaporates at ${(be * 100).toFixed(1)}%`, 'mk');
    $('#st-be-tag').textContent = `lead bound crosses 0 at ${(be * 100).toFixed(1)}% leakage`;
  } else {
    $('#st-be-tag').textContent = delta <= 0 ? 'no lead to evaporate' : 'no break-even inside 20%';
  }
  const c = state.contamPct / 100;
  const at = contaminationCurve(accA, accB, [c])[0];
  line(svg, x(c), y(yMin), x(c), y(yMax), 'marker');
  dot(svg, x(c), y(at.deltaUpper), 4, 'dot d3');
  $('#st-contam-v').textContent = `${state.contamPct.toFixed(1)}% -> worst-case lead ${pts(at.deltaUpper)} (${at.leadSurvives ? 'survives' : 'evaporates'})`;
  box.appendChild(svg);
}

/* ------------------------------------------------------------------ */
/* Rendering: report panel                                             */
/* ------------------------------------------------------------------ */

function renderReport() {
  const rep = state.report;
  $('#st-digest').textContent = rep ? rep.sha256 : '--';
  const prev = $('#st-report-out');
  if (!rep) { prev.textContent = ''; return; }
  const full = JSON.stringify(rep, null, 2);
  const lines = full.split('\n');
  prev.textContent = lines.length > 60 ? `${lines.slice(0, 60).join('\n')}\n... (${lines.length - 60} more lines)` : full;
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function exportJson() {
  if (!state.report) return;
  download('benchzero-rigor-report.json', JSON.stringify(state.report, null, 2), 'application/json');
}

async function copyText(t, okMsg) {
  try {
    await navigator.clipboard.writeText(t);
    toast(okMsg);
  } catch {
    toast('Clipboard refused; the text is selected instead.');
  }
}

/* ------------------------------------------------------------------ */
/* Boot, events                                                        */
/* ------------------------------------------------------------------ */

function applyState(s) {
  state.models = s.models;
  state.seed = s.seed;
  state.reps = s.reps;
  state.alpha = s.alpha;
  state.level = s.level ?? state.level;
  state.pdisc = s.pdisc ?? state.pdisc;
  state.contamPct = s.contamPct ?? state.contamPct;
  state.suites = s.suites.map((su) => ({ name: su.name, text: rowsToText(su.rows), rows: su.rows }));
  state.active = 0;
}

function boot() {
  const fromHash = stateFromHash(location.hash);
  if (fromHash && fromHash.ok) {
    applyState(fromHash.state);
    toast('Loaded rigor link.');
  } else if (fromHash && !fromHash.ok) {
    toast(fromHash.error);
    state.suites = makeExample();
  } else {
    const saved = safeGet(STORE);
    let ok = false;
    if (saved) {
      try {
        const s = JSON.parse(saved);
        if (Array.isArray(s.suites) && s.suites.length) {
          state.models = s.models || state.models;
          state.seed = s.seed ?? state.seed;
          state.reps = s.reps ?? state.reps;
          state.alpha = s.alpha ?? state.alpha;
          state.level = s.level ?? state.level;
          state.pdisc = s.pdisc ?? state.pdisc;
          state.contamPct = s.contamPct ?? state.contamPct;
          state.active = Math.min(s.active || 0, s.suites.length - 1);
          state.suites = s.suites;
          ok = true;
        }
      } catch { ok = false; }
    }
    if (!ok) state.suites = makeExample();
  }
  syncInputs();
  renderTabs();
  analyze();
  announce('BenchZero Rigor loaded.');
}

let deb = 0;
function queue() {
  clearTimeout(deb);
  deb = setTimeout(analyze, 250);
}

function wire() {
  $('#st-data').addEventListener('input', () => {
    const s = state.suites[state.active];
    if (s) { s.text = $('#st-data').value; queue(); }
  });
  $('#st-sname').addEventListener('input', () => {
    const s = state.suites[state.active];
    if (s) { s.name = Array.from($('#st-sname').value).slice(0, 60).join('') || 'suite'; renderTabs(); queue(); }
  });
  $('#st-model-a').addEventListener('input', () => { state.models[0] = Array.from($('#st-model-a').value).slice(0, 60).join('') || 'Model A'; queue(); });
  $('#st-model-b').addEventListener('input', () => { state.models[1] = Array.from($('#st-model-b').value).slice(0, 60).join('') || 'Model B'; queue(); });
  $('#st-seed').addEventListener('input', () => {
    const v = Number($('#st-seed').value);
    if (Number.isInteger(v) && v >= 0 && v <= 0xffffffff) { state.seed = v; queue(); }
  });
  $('#st-reps').addEventListener('input', () => {
    const v = Number($('#st-reps').value);
    if (Number.isInteger(v) && v >= 10 && v <= 200000) { state.reps = v; queue(); }
  });
  $('#st-alpha').addEventListener('input', () => {
    const v = Number($('#st-alpha').value);
    if (v > 0 && v <= 0.5) { state.alpha = v; queue(); }
  });
  $('#st-level').addEventListener('input', () => {
    const v = Number($('#st-level').value);
    if (v > 0.5 && v < 1) { state.level = v; queue(); }
  });
  $('#st-example').addEventListener('click', () => {
    state.suites = makeExample();
    state.active = 0;
    syncInputs();
    renderTabs();
    analyze();
    toast('Loaded the synthetic example. It is generated, not a real benchmark.');
  });
  $('#st-add').addEventListener('click', () => {
    if (state.suites.length >= MAX_SUITES) { toast(`Up to ${MAX_SUITES} suites.`); return; }
    state.suites.push({ name: `suite ${state.suites.length + 1}`, text: 'i1, 1, 0\ni2, 0, 1\ni3, 1, 1\ni4, 1, 0\ni5, 0, 0', rows: null });
    state.active = state.suites.length - 1;
    syncInputs();
    renderTabs();
    analyze();
  });
  $('#st-del').addEventListener('click', () => {
    if (state.suites.length <= 1) { toast('Keep at least one suite.'); return; }
    state.suites.splice(state.active, 1);
    state.active = Math.max(0, state.active - 1);
    syncInputs();
    renderTabs();
    analyze();
  });
  $('#st-pdisc').addEventListener('input', () => {
    state.pdisc = Number($('#st-pdisc').value);
    renderPower();
    save();
  });
  $('#st-contam-slider').addEventListener('input', () => {
    state.contamPct = Number($('#st-contam-slider').value);
    renderContam();
    save();
  });
  $('#st-link').addEventListener('click', async () => {
    const enc = encodeState({
      models: state.models, seed: state.seed, reps: state.reps, alpha: state.alpha,
      level: state.level, pdisc: state.pdisc, contamPct: state.contamPct,
      suites: state.suites.filter((s) => s.rows),
    });
    if (!enc.ok) { toast(enc.error); return; }
    const url = `${location.origin}${location.pathname}#bz=${enc.code}`;
    await copyText(url, 'Rigor link copied.');
    history.replaceState(null, '', `#bz=${enc.code}`);
  });
  $('#st-export').addEventListener('click', exportJson);
  $('#st-exp-json').addEventListener('click', exportJson);
  $('#st-exp-csv').addEventListener('click', () => {
    if (!state.analysis.results.length) return;
    download('benchzero-rigor-report.csv', resultsToCsv(state.analysis.results, state.alpha), 'text/csv');
  });
  $('#st-exp-md').addEventListener('click', () => {
    if (!state.analysis.results.length) return;
    download('benchzero-rigor-report.md', resultsToMarkdown({
      models: state.models, seed: state.seed, reps: state.reps,
      alpha: state.alpha, level: state.level,
      results: state.analysis.results,
      sha256: state.report ? state.report.sha256 : '',
      now: new Date().toISOString().slice(0, 10),
    }), 'text/markdown');
  });
  $('#st-copy-report').addEventListener('click', async () => {
    if (state.report) await copyText(JSON.stringify(state.report, null, 2), 'Report JSON copied.');
  });
  $('#st-tamper-btn').addEventListener('click', () => {
    const out = $('#st-tamper-out');
    let obj;
    try {
      obj = JSON.parse($('#st-tamper-in').value);
    } catch {
      out.textContent = 'not valid JSON';
      out.className = 'st-read fail';
      return;
    }
    const v = verifyReport(obj);
    if (!v.ok) {
      out.textContent = `cannot verify: ${v.error}`;
      out.className = 'st-read fail';
      return;
    }
    if (!v.verified) {
      out.textContent = `MISMATCH: ${v.error}`;
      out.className = 'st-read fail';
      return;
    }
    const replay = replayReport(obj);
    const tail = replay.ok && replay.matches ? 'replay matches' : (replay.error ? `replay: ${replay.error}` : 'replay differs');
    out.textContent = `digest verified; ${tail}`;
    out.className = 'st-read pass';
  });
  $('#st-selftest').addEventListener('click', () => {
    const r = runSelfTests();
    const lines = [`${r.pass}/${r.total} passed`];
    for (const t of r.results) lines.push(`${t.pass ? 'ok  ' : 'FAIL'} ${t.name}${t.detail ? ` (${t.detail})` : ''}`);
    $('#st-selfout').textContent = lines.join('\n');
    $('#st-selfout').classList.toggle('all-pass', r.pass === r.total);
    announce(`Self tests: ${r.pass} of ${r.total} passed.`);
  });
}

wire();
boot();
