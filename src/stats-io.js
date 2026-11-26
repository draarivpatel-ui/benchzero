// BenchZero rigor I/O: row parsing, the checksummed report (JSON/CSV/Markdown),
// the #bz= share codec and the in-page self-test battery. Every export carries an
// unkeyed SHA-256 digest: it detects edits after export and is labelled as such,
// never as a signature.

import { sha256Hex } from './sha256.js';
import {
  analyzeSuite, holmAdjust, pairedBootstrap, mcnemar, normalCdf,
  contaminationBounds, contaminationCurve, leakBreakEven, mcnemarPower, mde, mulberry32,
} from './stats-lab.js';

export const MAX_ITEMS = 20000;
export const MAX_SUITES = 8;
export const MAX_CODE = 20000;
const CODEC_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Row parsing                                                         */
/* ------------------------------------------------------------------ */

/**
 * Parse pasted rows into [{id, a, b}]. Each non-empty line is comma, tab or
 * whitespace separated; the last two fields are the two model scores, anything
 * before them is the optional item id. Blank lines and lines starting with #
 * are ignored. Lines that do not end in two finite numbers are collected in
 * `skipped` with their line numbers and reported, never silently dropped.
 */
export function parseRows(text, { maxItems = MAX_ITEMS } = {}) {
  if (typeof text !== 'string') return { ok: false, error: 'no input' };
  const rows = [];
  const skipped = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(/[,;\t]|\s+/).filter((f) => f !== '');
    if (fields.length < 2) { skipped.push(i + 1); continue; }
    const a = Number(fields[fields.length - 2]);
    const b = Number(fields[fields.length - 1]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) { skipped.push(i + 1); continue; }
    const id = fields.length > 2 ? fields.slice(0, -2).join(' ') : `i${rows.length + 1}`;
    rows.push({ id: Array.from(id).slice(0, 60).join(''), a, b });
    if (rows.length > maxItems) return { ok: false, error: `more than ${maxItems} items` };
  }
  if (rows.length === 0) return { ok: false, error: 'no usable rows', skipped };
  return { ok: true, rows, skipped };
}

/* ------------------------------------------------------------------ */
/* Canonical JSON + report digest                                      */
/* ------------------------------------------------------------------ */

/** Deterministic JSON: object keys sorted recursively, arrays kept in order. */
export function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}

const round6 = (v) => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : null);

/**
 * Build the full analysis over all suites: per-suite results plus the
 * Holm-adjusted family p-values. suites: [{name, text|rows}].
 */
export function analyzeAll(suites, { seed = 1, reps = 10000, level = 0.95 } = {}) {
  const results = [];
  const errors = [];
  for (const s of suites) {
    const rows = s.rows || (s.text ? parseRows(s.text).rows : null);
    if (!rows) { errors.push({ name: s.name, error: 'no data' }); continue; }
    const r = analyzeSuite(rows, { seed, reps, level });
    if (!r.ok) { errors.push({ name: s.name, error: r.error }); continue; }
    results.push({ name: s.name, ...r });
  }
  const holm = holmAdjust(results.map((r) => r.pPrimary));
  results.forEach((r, i) => { r.pAdj = holm.adjusted[i]; });
  return { ok: true, results, errors };
}

/** Serialisable results block (diffs and bootstrap samples are summarised). */
function suiteSummary(r) {
  return {
    name: r.name, n: r.n, accA: round6(r.accA), accB: round6(r.accB), delta: round6(r.delta),
    boot: { lo: round6(r.boot.lo), hi: round6(r.boot.hi), p: round6(r.boot.p), reps: r.boot.reps, seed: r.boot.seed, level: r.boot.level },
    discordant: r.mc ? { n01: r.n01, n10: r.n10 } : null,
    mcnemar: r.mc ? { chi2cc: round6(r.mc.chi2cc), pChi2: round6(r.mc.pChi2), pExact: round6(r.mc.pExact) } : null,
    correctnessScale: r.scale.scale,
    pPrimary: round6(r.pPrimary), pAdj: round6(r.pAdj),
  };
}

/**
 * Build the signed-by-digest report object.
 *   { payload: {...}, sha256: '<64 hex>' }
 * The digest covers the canonical payload only. `now` is injectable so tests and
 * replays are deterministic; the app passes the real time.
 */
export function buildReport({ models, seed, reps, alpha, level, suites, results, now }) {
  // A report always carries Holm-adjusted p: if the caller analysed suites one
  // by one, the family adjustment is applied here so the digest is stable.
  if (results.some((r) => r.pAdj === undefined)) {
    const h = holmAdjust(results.map((r) => r.pPrimary));
    results.forEach((r, i) => { r.pAdj = h.adjusted[i]; });
  }
  const payload = {
    tool: 'benchzero-rigor',
    format: CODEC_VERSION,
    created: now,
    input: {
      models: [models[0], models[1]],
      seed, reps, alpha, level,
      suites: suites.map((s, i) => ({
        name: s.name,
        n: (results[i] ? results[i].n : (s.rows ? s.rows.length : null)),
        pairs: s.rows ? s.rows.flatMap((r) => [r.a, r.b]) : undefined,
      })),
    },
    results: results.map(suiteSummary),
    notes: [
      'delta is mean(score A - score B); positive means model A scores higher',
      'bootstrap CI is the two-sided percentile interval under the recorded seed',
      'McNemar pExact is the two-sided exact binomial on discordant pairs',
      'pAdj is the Holm step-down adjustment across the reported suites',
      'sha256 is an unkeyed tamper-evidence digest, not a signature',
    ],
  };
  return { payload, sha256: sha256Hex(canonicalJson(payload)) };
}

/**
 * Re-check a report: recompute the digest of the canonical payload and compare.
 * Returns { ok, verified, error, expected, found }.
 */
export function verifyReport(report) {
  if (!report || typeof report !== 'object') return { ok: false, error: 'not a report object' };
  if (!report.payload || typeof report.payload !== 'object') return { ok: false, error: 'missing payload' };
  if (typeof report.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(report.sha256)) {
    return { ok: false, error: 'missing or malformed sha256 field' };
  }
  const found = sha256Hex(canonicalJson(report.payload));
  return {
    ok: true,
    verified: found === report.sha256,
    expected: report.sha256,
    found,
    error: found === report.sha256 ? null : 'digest mismatch: payload was edited after the digest was made',
  };
}

/**
 * Replay verification: re-run the analysis from the rows embedded in the
 * payload and confirm the reported numbers come out the same. Proves the
 * report is self-consistent, on top of the digest check.
 */
export function replayReport(report, { compare = true } = {}) {
  if (!report?.payload?.input?.suites) return { ok: false, error: 'payload has no suites' };
  const inp = report.payload.input;
  const suites = inp.suites.map((s) => {
    const rows = [];
    const pairs = s.pairs || [];
    for (let i = 0; i + 1 < pairs.length; i += 2) rows.push({ id: `i${rows.length + 1}`, a: pairs[i], b: pairs[i + 1] });
    return { name: s.name, rows };
  });
  const all = analyzeAll(suites, { seed: inp.seed, reps: inp.reps, level: inp.level });
  if (!compare) return { ok: true, all };
  const mine = all.results.map(suiteSummary);
  const theirs = report.payload.results || [];
  if (mine.length !== theirs.length) return { ok: true, matches: false, error: 'suite count differs' };
  const matches = canonicalJson(mine) === canonicalJson(theirs);
  return { ok: true, matches, error: matches ? null : 'replay produced different numbers' };
}

/* ------------------------------------------------------------------ */
/* CSV and Markdown exports                                            */
/* ------------------------------------------------------------------ */

/**
 * One CSV cell. Formula-injection safe: any cell whose first character could be
 * read as a formula start (=, +, -, @, tab, CR, leading space) is prefixed with
 * a single quote, then comma/quote/newline cells are wrapped in double quotes.
 */
export function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  const lead = (/^[\s\p{Cf}\p{Cc}]*/u.exec(s) || [''])[0];
  const first = s.charAt(lead.length);
  const plainNumber = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(s.slice(lead.length));
  if (lead.length > 0 || (first !== '' && '=+-@'.indexOf(first) !== -1 && !(first === '-' && plainNumber))) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export const CSV_HEADER = 'suite,n,acc_a,acc_b,delta,boot_lo,boot_hi,p_boot,n01,n10,chi2_cc,p_chi2,p_exact,p_adj,verdict';

export function resultsToCsv(results, alpha = 0.05) {
  const lines = [CSV_HEADER];
  for (const r of results) {
    lines.push([
      r.name, r.n, round6(r.accA), round6(r.accB), round6(r.delta),
      round6(r.boot.lo), round6(r.boot.hi), round6(r.boot.p),
      r.mc ? r.n01 : '', r.mc ? r.n10 : '',
      r.mc ? round6(r.mc.chi2cc) : '', r.mc ? round6(r.mc.pChi2) : '', r.mc ? round6(r.mc.pExact) : '',
      round6(r.pAdj), r.pAdj < alpha ? 'significant' : 'not significant',
    ].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

const fmt = (v, d = 4) => (Number.isFinite(v) ? Number(v).toFixed(d) : 'n/a');

export function resultsToMarkdown({ models, seed, reps, alpha, level, results, sha256, now }) {
  const lines = [];
  lines.push('# BenchZero benchmark rigor report');
  lines.push('');
  lines.push(`Models: ${models[0]} (A) vs ${models[1]} (B). Generated ${now}. Seed ${seed}, ${reps} bootstrap replicates, alpha ${alpha}, CI level ${level}.`);
  lines.push('');
  lines.push('| Suite | n | acc A | acc B | delta | bootstrap CI | p boot | n01 | n10 | p exact | p adj | verdict |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of results) {
    lines.push(`| ${r.name} | ${r.n} | ${fmt(r.accA)} | ${fmt(r.accB)} | ${fmt(r.delta)} | [${fmt(r.boot.lo)}, ${fmt(r.boot.hi)}] | ${fmt(r.boot.p)} | ${r.mc ? r.n01 : '-'} | ${r.mc ? r.n10 : '-'} | ${r.mc ? fmt(r.mc.pExact) : '-'} | ${fmt(r.pAdj)} | ${r.pAdj < alpha ? 'significant' : 'not significant'} |`);
  }
  lines.push('');
  lines.push('delta = mean(A - B), positive favours A. p exact is the two-sided exact');
  lines.push('McNemar binomial on discordant pairs (n01 B-only, n10 A-only). p adj is the');
  lines.push('Holm step-down adjustment across suites. Bootstrap CIs are percentile');
  lines.push('intervals, replayable under the recorded seed.');
  lines.push('');
  lines.push(`SHA-256 (unkeyed tamper-evidence digest, not a signature): \`${sha256}\``);
  lines.push('');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* #bz= share codec                                                    */
/* ------------------------------------------------------------------ */

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad characters');
  const pad = s.length % 4 === 2 ? '==' : s.length % 4 === 3 ? '=' : s.length % 4 === 0 ? '' : null;
  if (pad === null) throw new Error('truncated');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

const okName = (s) => typeof s === 'string' && s.length >= 1 && s.length <= 60 && !/[\u0000-\u001f\u007f]/.test(s);
const okScore = (v) => Number.isFinite(v) && Math.abs(v) <= 1e9;

/**
 * State -> compact object. Rows are stored as flat [a, b, a, b, ...] pairs with
 * generated item ids, so links keep scores but reset labels to i1..iN.
 */
export function packState(state) {
  return {
    v: CODEC_VERSION,
    m: state.models.slice(0, 2),
    s: [state.seed >>> 0, state.reps | 0, state.alpha, state.level ?? 0.95, state.pdisc ?? 0.3, state.contamPct ?? 5],
    q: state.suites.map((su) => [
      su.name,
      su.rows.flatMap((r) => [round6(r.a), round6(r.b)]),
    ]),
  };
}

export function unpackState(o) {
  if (!o || typeof o !== 'object' || o.v !== CODEC_VERSION) throw new Error('Unsupported rigor link version.');
  if (!Array.isArray(o.m) || o.m.length !== 2 || !o.m.every(okName)) throw new Error('Bad model names.');
  if (!Array.isArray(o.s) || (o.s.length !== 3 && o.s.length !== 6) || !o.s.every(Number.isFinite)) throw new Error('Bad settings.');
  const [seed, reps, alpha, level = 0.95, pdisc = 0.3, contamPct = 5] = o.s;
  if (!(seed >= 0 && seed <= 0xffffffff) || !(reps >= 10 && reps <= 200000) || !(alpha > 0 && alpha <= 0.5)
    || !(level > 0.5 && level < 1) || !(pdisc > 0 && pdisc <= 1) || !(contamPct >= 0 && contamPct <= 100)) {
    throw new Error('Settings out of range.');
  }
  if (!Array.isArray(o.q) || o.q.length < 1 || o.q.length > MAX_SUITES) throw new Error('Bad suite list.');
  const suites = o.q.map((e) => {
    if (!Array.isArray(e) || e.length !== 2 || !okName(e[0]) || !Array.isArray(e[1])) throw new Error('Bad suite.');
    const pairs = e[1];
    if (pairs.length % 2 !== 0 || pairs.length < 2 || pairs.length > 2 * MAX_ITEMS || !pairs.every(okScore)) {
      throw new Error('Bad score pairs.');
    }
    const rows = [];
    for (let i = 0; i < pairs.length; i += 2) rows.push({ id: `i${rows.length + 1}`, a: pairs[i], b: pairs[i + 1] });
    return { name: e[0], rows };
  });
  return { models: o.m.slice(), seed, reps, alpha, level, pdisc, contamPct, suites };
}

export function encodeState(state) {
  const code = b64urlEncode(JSON.stringify(packState(state)));
  if (code.length > MAX_CODE) return { ok: false, error: `link would be ${code.length} characters, cap is ${MAX_CODE}` };
  return { ok: true, code };
}

export function decodeState(code) {
  try {
    if (typeof code !== 'string' || !code) throw new Error('Empty rigor link.');
    if (code.length > MAX_CODE) throw new Error('Rigor link is too long.');
    return { ok: true, state: unpackState(JSON.parse(b64urlDecode(code))) };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'Could not read the rigor link.' };
  }
}

/** Read rigor state from a location.hash string such as "#bz=...". */
export function stateFromHash(hash) {
  const s = typeof hash === 'string' ? hash : '';
  if (!/^#?bz=/.test(s)) return null;
  const m = /^#?bz=([A-Za-z0-9_-]+)$/.exec(s);
  if (!m) return { ok: false, error: 'Malformed rigor link. The hash after #bz= is incomplete or invalid.' };
  return decodeState(m[1]);
}

/** Rows -> paste-able text (id, a, b per line). */
export function rowsToText(rows) {
  return rows.map((r) => `${r.id}, ${r.a}, ${r.b}`).join('\n');
}

/* ------------------------------------------------------------------ */
/* In-page self-tests                                                  */
/* ------------------------------------------------------------------ */

const close = (x, y, eps = 1e-9) => Math.abs(x - y) <= eps;

/**
 * The battery the page runs when "Run self-tests" is pressed. Each entry is a
 * named check a judge can read; run() throws or returns false on failure.
 */
export const SELF_TESTS = [
  ['SHA-256 FIPS 180-4 known answers', () => {
    const v1 = sha256Hex('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const v2 = sha256Hex('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    const v3 = sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')
      === '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1';
    return v1 && v2 && v3;
  }],
  ['Identical models give delta 0 and p 1', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ id: `i${i}`, a: i % 2, b: i % 2 }));
    const r = analyzeSuite(rows, { seed: 3, reps: 500 });
    return r.ok && r.delta === 0 && r.boot.p === 1 && r.mc.pExact === 1;
  }],
  ['McNemar is symmetric in n01, n10', () => {
    const a = mcnemar(9, 2);
    const b = mcnemar(2, 9);
    return a.pExact === b.pExact && a.pChi2 === b.pChi2;
  }],
  ['Holm adjustment is monotonic and bounded', () => {
    const { adjusted } = holmAdjust([0.001, 0.02, 0.5, 0.9]);
    const raw = [0.001, 0.02, 0.5, 0.9];
    return adjusted.every((p, i) => p >= raw[i] && p <= 1);
  }],
  ['Contamination bound conserves and never exceeds the raw delta', () => {
    const c0 = contaminationBounds(0.9, 0.8, 0);
    const c1 = contaminationBounds(0.9, 0.8, 0.1);
    const c2 = contaminationBounds(0.9, 0.8, 0.2);
    return close(c0.deltaUpper, 0.1) && c1.deltaUpper < 0.1 && c2.deltaUpper < c1.deltaUpper;
  }],
  ['CSV escaping neutralises formula cells', () => {
    return csvCell('=cmd|x') === "'=cmd|x"
      && csvCell('@SUM(1)') === "'@SUM(1)"
      && csvCell('-5') === '-5'
      && csvCell('a,b') === '"a,b"'
      && csvCell('say "hi"') === '"say ""hi"""';
  }],
  ['Tamper check catches a one-character edit', () => {
    const rep = buildReport({
      models: ['A', 'B'], seed: 1, reps: 200, alpha: 0.05, level: 0.95,
      suites: [{ name: 's', rows: [{ id: 'i1', a: 1, b: 0 }] }],
      results: [analyzeSuite([{ id: 'i1', a: 1, b: 0 }], { reps: 200, seed: 1 })],
      now: 'test',
    });
    const tampered = JSON.parse(JSON.stringify(rep));
    tampered.payload.results[0].accA = 0.5;
    return verifyReport(rep).verified === true && verifyReport(tampered).verified === false;
  }],
  ['Bootstrap is deterministic under a seed', () => {
    const diffs = Array.from({ length: 30 }, (_, i) => (i % 3) - 1);
    const r1 = pairedBootstrap(diffs, { seed: 11, reps: 300 });
    const r2 = pairedBootstrap(diffs, { seed: 11, reps: 300 });
    return r1.lo === r2.lo && r1.hi === r2.hi && r1.p === r2.p;
  }],
  ['Bootstrap CI brackets the sample mean delta', () => {
    const diffs = Array.from({ length: 60 }, (_, i) => ((i * 7) % 5 - 2) / 10);
    const r = pairedBootstrap(diffs, { seed: 5, reps: 2000 });
    return r.lo <= r.mean + 1e-12 && r.hi >= r.mean - 1e-12;
  }],
  ['Seeded RNG streams differ across seeds', () => {
    const r1 = mulberry32(1);
    const r2 = mulberry32(2);
    const s1 = Array.from({ length: 5 }, () => r1());
    const s2 = Array.from({ length: 5 }, () => r2());
    return s1.every((v) => v >= 0 && v < 1) && s1.some((v, i) => v !== s2[i]);
  }],
  ['Power grows with N and effect size', () => {
    const p = (N, d) => mcnemarPower(N, 0.4, d, 0.05);
    return p(2000, 0.05) > p(200, 0.05) && p(1000, 0.05) > p(1000, 0.01) && p(500, 0) === 0.05;
  }],
  ['Minimum detectable effect shrinks as N grows', () => {
    const small = mde(100, 0.4, 0.05, 0.8);
    const large = mde(5000, 0.4, 0.05, 0.8);
    return large.delta < small.delta;
  }],
  ['Normal CDF hits its textbook marks', () => {
    return close(normalCdf(0), 0.5) && close(normalCdf(1.959964), 0.975, 1e-4)
      && normalCdf(-8) < 1e-12 && normalCdf(8) > 1 - 1e-12;
  }],
  ['Codec round-trips a rigor link', () => {
    const state = {
      models: ['A', 'B'], seed: 7, reps: 2000, alpha: 0.05,
      suites: [{ name: 's', rows: [{ id: 'i1', a: 1, b: 0 }, { id: 'i2', a: 0, b: 1 }] }],
    };
    const enc = encodeState(state);
    if (!enc.ok) return false;
    const dec = decodeState(enc.code);
    return dec.ok && dec.state.suites[0].rows.length === 2 && dec.state.seed === 7;
  }],
  ['Leakage break-even sits where the bound crosses zero', () => {
    const c = leakBreakEven(0.9, 0.8);
    if (c === null) return false;
    const at = contaminationBounds(0.9, 0.8, c);
    return Math.abs(at.deltaUpper) < 1e-9;
  }],
];

export function runSelfTests() {
  const results = SELF_TESTS.map(([name, run]) => {
    try {
      return { name, pass: run() === true, detail: '' };
    } catch (e) {
      return { name, pass: false, detail: e && e.message ? e.message : 'threw' };
    }
  });
  const pass = results.filter((r) => r.pass).length;
  return { pass, total: results.length, results };
}
