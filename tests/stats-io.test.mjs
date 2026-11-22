// Rigor I/O tests: row parsing, canonical JSON, checksummed reports, CSV and
// Markdown exports, the #bz= codec and the self-test battery itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sha256Hex } from '../src/sha256.js';
import { analyzeSuite } from '../src/stats-lab.js';
import {
  parseRows, canonicalJson, analyzeAll, buildReport, verifyReport, replayReport,
  csvCell, resultsToCsv, resultsToMarkdown, CSV_HEADER,
  packState, unpackState, encodeState, decodeState, stateFromHash, rowsToText,
  SELF_TESTS, runSelfTests, MAX_SUITES,
} from '../src/stats-io.js';

const mk = (pairs) => pairs.map(([a, b], i) => ({ id: `i${i + 1}`, a, b }));
const suiteOf = (pairs) => analyzeSuite(mk(pairs), { seed: 7, reps: 400 });

/* ------------------------------------------------------------------ */
/* parseRows                                                           */
/* ------------------------------------------------------------------ */

test('parseRows: two bare scores per line parse with generated ids', () => {
  const r = parseRows('1, 0\n0, 1\n1, 1');
  assert.ok(r.ok);
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.rows[0], { id: 'i1', a: 1, b: 0 });
});

test('parseRows: leading item ids are kept', () => {
  const r = parseRows('q1, 1, 0\nq2, 0, 1');
  assert.equal(r.rows[0].id, 'q1');
  assert.equal(r.rows[1].id, 'q2');
});

test('parseRows: tab and space separated fields parse', () => {
  const r = parseRows('q1\t1\t0\nq2 0 1');
  assert.ok(r.ok);
  assert.equal(r.rows.length, 2);
});

test('parseRows: semicolons separate fields', () => {
  const r = parseRows('q1;1;0\nq2;0;1');
  assert.equal(r.rows.length, 2);
});

test('parseRows: blank lines and comments are ignored', () => {
  const r = parseRows('# header\n\n1, 0\n   \n# tail\n0, 1');
  assert.equal(r.rows.length, 2);
  assert.equal(r.skipped.length, 0);
});

test('parseRows: a non-numeric header line is reported, not parsed', () => {
  const r = parseRows('item, A, B\nq1, 1, 0\nq2, 0, 1');
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.skipped, [1]);
});

test('parseRows: unparseable lines collect their line numbers', () => {
  const r = parseRows('q1, 1, 0\ngarbage line\nq2, 0, 1\nq3, x, 1');
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.skipped, [2, 4]);
});

test('parseRows: a single field is rejected as a row', () => {
  const r = parseRows('onlyone\n1, 0');
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.skipped, [1]);
});

test('parseRows: empty input is an error', () => {
  assert.equal(parseRows('').ok, false);
  assert.equal(parseRows('   \n\n').ok, false);
  assert.equal(parseRows(null).ok, false);
  assert.equal(parseRows(42).ok, false);
});

test('parseRows: all-bad input reports the error', () => {
  const r = parseRows('a, b\nc, d');
  assert.equal(r.ok, false);
  assert.match(r.error, /no usable rows/i);
});

test('parseRows: fractional and negative scores parse', () => {
  const r = parseRows('q1, 0.75, 0.5\nq2, -1.25, 2.5');
  assert.equal(r.rows[0].a, 0.75);
  assert.equal(r.rows[1].b, 2.5);
});

test('parseRows: scientific notation parses', () => {
  const r = parseRows('q1, 1e-3, 2E2');
  assert.equal(r.rows[0].a, 0.001);
  assert.equal(r.rows[0].b, 200);
});

test('parseRows: ids longer than 60 chars are truncated', () => {
  const r = parseRows(`${'x'.repeat(100)}, 1, 0`);
  assert.equal(r.rows[0].id.length, 60);
});

test('parseRows: enforces the item cap', () => {
  const text = Array.from({ length: 30 }, (_, i) => `i${i}, 1, 0`).join('\n');
  const r = parseRows(text, { maxItems: 10 });
  assert.equal(r.ok, false);
  assert.match(r.error, /10/);
});

test('parseRows: Infinity and NaN tokens are skipped, not parsed', () => {
  const r = parseRows('q1, Infinity, 0\nq2, 1, NaN\nq3, 1, 0');
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.skipped, [1, 2]);
});

test('parseRows: ids with spaces join back together', () => {
  const r = parseRows('item forty two, 1, 0');
  assert.equal(r.rows[0].id, 'item forty two');
});

/* ------------------------------------------------------------------ */
/* canonicalJson                                                       */
/* ------------------------------------------------------------------ */

test('canonicalJson: object keys serialize in sorted order', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test('canonicalJson: key insertion order does not change the output', () => {
  const a = canonicalJson({ x: 1, y: { q: 2, p: 3 } });
  const b = canonicalJson({ y: { p: 3, q: 2 }, x: 1 });
  assert.equal(a, b);
});

test('canonicalJson: arrays keep their order', () => {
  assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
  assert.equal(canonicalJson({ k: ['z', 'a'] }), '{"k":["z","a"]}');
});

test('canonicalJson: nested empties serialize cleanly', () => {
  assert.equal(canonicalJson({ a: {}, b: [] }), '{"a":{},"b":[]}');
  assert.equal(canonicalJson(null), 'null');
});

/* ------------------------------------------------------------------ */
/* analyzeAll                                                          */
/* ------------------------------------------------------------------ */

test('analyzeAll: runs every suite and attaches Holm-adjusted p', () => {
  const suites = [
    { name: 'one', text: '1, 0\n0, 1\n1, 1\n1, 0' },
    { name: 'two', text: '1, 0\n1, 0\n0, 1\n1, 1' },
  ];
  const r = analyzeAll(suites, { seed: 3, reps: 300 });
  assert.equal(r.results.length, 2);
  assert.ok(Number.isFinite(r.results[0].pAdj));
  assert.ok(r.results[0].pAdj >= r.results[0].pPrimary - 1e-12);
});

test('analyzeAll: failed suites land in the errors list, not the results', () => {
  const r = analyzeAll([{ name: 'bad', text: 'junk' }, { name: 'ok', text: '1, 0\n0, 1' }], { reps: 100 });
  assert.equal(r.results.length, 1);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].name, 'bad');
});

test('analyzeAll: results keep suite order', () => {
  const r = analyzeAll([
    { name: 'zeta', text: '1, 0\n0, 1' },
    { name: 'alpha', text: '1, 1\n0, 0' },
  ], { reps: 100 });
  assert.deepEqual(r.results.map((s) => s.name), ['zeta', 'alpha']);
});

/* ------------------------------------------------------------------ */
/* buildReport + verifyReport + replayReport                           */
/* ------------------------------------------------------------------ */

function sampleReport() {
  const suites = [{ name: 'demo', rows: mk([[1, 0], [1, 0], [0, 1], [1, 1]]) }];
  const { results } = analyzeAll(suites, { seed: 7, reps: 400 });
  return buildReport({
    models: ['A', 'B'], seed: 7, reps: 400, alpha: 0.05, level: 0.95,
    suites, results,
    now: '2026-11-22T00:00:00.000Z',
  });
}

test('report: sha256 field is 64 lowercase hex', () => {
  const rep = sampleReport();
  assert.match(rep.sha256, /^[0-9a-f]{64}$/);
});

test('report: payload carries tool, format and honest notes', () => {
  const rep = sampleReport();
  assert.equal(rep.payload.tool, 'benchzero-rigor');
  assert.equal(rep.payload.format, 1);
  assert.ok(rep.payload.notes.some((n) => /unkeyed/.test(n) && /not a signature/.test(n)));
});

test('report: the digest matches the canonical payload', () => {
  const rep = sampleReport();
  assert.equal(rep.sha256, sha256Hex(canonicalJson(rep.payload)));
});

test('report: a fresh report verifies', () => {
  const v = verifyReport(sampleReport());
  assert.ok(v.ok && v.verified);
  assert.equal(v.error, null);
});

test('report: a one-character payload edit fails verification', () => {
  const rep = sampleReport();
  const t = JSON.parse(JSON.stringify(rep));
  t.payload.results[0].accA = 0.111;
  const v = verifyReport(t);
  assert.ok(v.ok);
  assert.equal(v.verified, false);
  assert.match(v.error, /mismatch/i);
  assert.equal(v.expected, rep.sha256);
  assert.notEqual(v.found, rep.sha256);
});

test('report: an added field still changes the digest', () => {
  const rep = sampleReport();
  const t = JSON.parse(JSON.stringify(rep));
  t.payload.extra = 'injected';
  assert.equal(verifyReport(t).verified, false);
});

test('report: a forged sha field is rejected, never trusted', () => {
  const rep = sampleReport();
  const t = JSON.parse(JSON.stringify(rep));
  t.sha256 = 'f'.repeat(64);
  const v = verifyReport(t);
  assert.equal(v.verified, false);
});

test('report: malformed sha fields are an error, not a pass', () => {
  const rep = sampleReport();
  for (const bad of ['', 'xyz', 'A'.repeat(64), 'abc', 42, null]) {
    const t = { payload: rep.payload, sha256: bad };
    const v = verifyReport(t);
    assert.equal(v.ok, false, String(bad));
    assert.equal(v.verified, undefined);
  }
});

test('report: non-report inputs return errors, not crashes', () => {
  assert.equal(verifyReport(null).ok, false);
  assert.equal(verifyReport('str').ok, false);
  assert.equal(verifyReport({}).ok, false);
  assert.equal(verifyReport({ sha256: 'a'.repeat(64) }).ok, false);
});

test('report: replay recomputes the same numbers from embedded pairs', () => {
  const rep = sampleReport();
  const r = replayReport(rep);
  assert.ok(r.ok);
  assert.equal(r.matches, true);
});

test('report: replay catches edited results', () => {
  const rep = sampleReport();
  const t = JSON.parse(JSON.stringify(rep));
  t.payload.results[0].delta = 0.99;
  const r = replayReport(t);
  assert.equal(r.matches, false);
  assert.match(r.error, /different/i);
});

test('report: replay handles a payload without suites gracefully', () => {
  const r = replayReport({ payload: {} });
  assert.equal(r.ok, false);
});

test('report: identical inputs rebuild the identical digest', () => {
  const r1 = sampleReport();
  const r2 = sampleReport();
  assert.equal(r1.sha256, r2.sha256);
});

test('report: a different seed changes the digest', () => {
  const r1 = sampleReport();
  const s = suiteOf([[1, 0], [1, 0], [0, 1], [1, 1]]);
  const r2 = buildReport({
    models: ['A', 'B'], seed: 8, reps: 400, alpha: 0.05, level: 0.95,
    suites: [{ name: 'demo', rows: mk([[1, 0], [1, 0], [0, 1], [1, 1]]) }],
    results: [s], now: '2026-11-22T00:00:00.000Z',
  });
  assert.notEqual(r1.sha256, r2.sha256);
});

/* ------------------------------------------------------------------ */
/* csvCell + resultsToCsv                                              */
/* ------------------------------------------------------------------ */

test('csvCell: formula-start characters get the quote prefix', () => {
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvCell('+cmd'), "'+cmd");
  assert.equal(csvCell('-5'), "'-5");
  assert.equal(csvCell('@mention'), "'@mention");
});

test('csvCell: tab, carriage return and leading space are neutralised', () => {
  assert.equal(csvCell('\t=x'), "'\t=x");
  // A carriage return is both a dangerous start and a wrap character.
  assert.equal(csvCell('\r=x'), `"'\r=x"`);
  assert.equal(csvCell(' lead'), "' lead");
});

test('csvCell: commas wrap the cell in quotes', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
});

test('csvCell: embedded double quotes are doubled and wrapped', () => {
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
});

test('csvCell: newlines wrap the cell', () => {
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
});

test('csvCell: ordinary values pass through untouched', () => {
  assert.equal(csvCell('suite one'), 'suite one');
  assert.equal(csvCell('0.456'), '0.456');
  assert.equal(csvCell(0), '0');
});

test('csvCell: null and undefined render empty', () => {
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(undefined), '');
});

test('csvCell: a formula hidden behind a quote is still neutralised', () => {
  const cell = csvCell('=1+1');
  assert.ok(cell.startsWith("'"), 'dangerous start must be prefixed first');
});

test('resultsToCsv: header and one line per suite', () => {
  const csv = resultsToCsv([suiteOf([[1, 0], [0, 1]])], 0.05);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], CSV_HEADER);
  assert.equal(lines.length, 2);
});

test('resultsToCsv: verdict column reflects pAdj against alpha', () => {
  const sig = suiteOf(Array.from({ length: 30 }, () => [1, 0]));
  sig.pAdj = 0.001;
  const csv = resultsToCsv([sig], 0.05);
  assert.match(csv, /significant/);
});

test('resultsToCsv: a hostile suite name cannot inject a formula', () => {
  const s = suiteOf([[1, 0], [0, 1]]);
  s.name = '=cmd|evil';
  s.pAdj = 0.5;
  const csv = resultsToCsv([s], 0.05);
  assert.ok(csv.includes("'=cmd|evil"), 'name must be escaped');
});

test('resultsToCsv: a comma inside a suite name stays inside quotes', () => {
  const s = suiteOf([[1, 0], [0, 1]]);
  s.name = 'a,b';
  const csv = resultsToCsv([s], 0.05);
  assert.ok(csv.includes('"a,b"'));
  const rows = csv.trim().split('\n');
  assert.equal(rows.length, 2);
});

test('resultsToCsv: non-binary suites leave McNemar cells empty', () => {
  const s = analyzeSuite(mk([[5, 300], [9, 200]]), { reps: 100 });
  s.pAdj = s.pPrimary;
  const csv = resultsToCsv([s], 0.05);
  const fields = csv.trim().split('\n')[1].split(',');
  assert.equal(fields[8], '');   // n01
  assert.equal(fields[9], '');   // n10
});

/* ------------------------------------------------------------------ */
/* resultsToMarkdown                                                   */
/* ------------------------------------------------------------------ */

test('markdown: renders a table with every suite', () => {
  const md = resultsToMarkdown({
    models: ['A', 'B'], seed: 7, reps: 400, alpha: 0.05, level: 0.95,
    results: [suiteOf([[1, 0], [0, 1], [1, 1]])], sha256: 'ab'.repeat(32), now: 'x',
  });
  assert.match(md, /\| Suite \|/);
  assert.match(md, /\| --- \|/);
});

test('markdown: includes the digest and the unkeyed honesty label', () => {
  const md = resultsToMarkdown({
    models: ['A', 'B'], seed: 7, reps: 400, alpha: 0.05, level: 0.95,
    results: [suiteOf([[1, 0]])], sha256: 'cd'.repeat(32), now: 'x',
  });
  assert.match(md, /unkeyed tamper-evidence digest, not a signature/);
  assert.match(md, new RegExp('cd'.repeat(32)));
});

test('markdown: documents the delta sign convention', () => {
  const md = resultsToMarkdown({
    models: ['A', 'B'], seed: 7, reps: 400, alpha: 0.05, level: 0.95,
    results: [suiteOf([[1, 0]])], sha256: '0'.repeat(64), now: 'x',
  });
  assert.match(md, /delta = mean\(A - B\)/);
});

/* ------------------------------------------------------------------ */
/* #bz= codec                                                          */
/* ------------------------------------------------------------------ */

const sampleState = () => ({
  models: ['Model A', 'Model B'],
  seed: 7, reps: 2000, alpha: 0.05,
  suites: [
    { name: 'one', rows: mk([[1, 0], [0, 1], [1, 1]]) },
    { name: 'two', rows: mk([[0.5, 0.25], [1, 0]]) },
  ],
});

test('codec: state round-trips through encode and decode', () => {
  const enc = encodeState(sampleState());
  assert.ok(enc.ok);
  const dec = decodeState(enc.code);
  assert.ok(dec.ok, dec.error);
  assert.deepEqual(dec.state.models, ['Model A', 'Model B']);
  assert.equal(dec.state.seed, 7);
  assert.equal(dec.state.reps, 2000);
  assert.equal(dec.state.alpha, 0.05);
  assert.equal(dec.state.suites.length, 2);
  assert.equal(dec.state.suites[0].rows.length, 3);
  assert.equal(dec.state.suites[1].rows[0].a, 0.5);
});

test('codec: encoding is deterministic', () => {
  assert.equal(encodeState(sampleState()).code, encodeState(sampleState()).code);
});

test('codec: the code stays well inside the cap for normal suites', () => {
  const enc = encodeState(sampleState());
  assert.ok(enc.code.length < 1000, enc.code.length);
});

test('codec: oversized states refuse with an error, not a giant link', () => {
  const state = sampleState();
  state.suites = [{ name: 'big', rows: Array.from({ length: 9000 }, (_, i) => ({ id: `i${i}`, a: 0.123456, b: 0.654321 })) }];
  const r = encodeState(state);
  assert.equal(r.ok, false);
  assert.match(r.error, /cap/i);
});

test('codec: decode rejects a truncated or foreign code', () => {
  assert.equal(decodeState('').ok, false);
  assert.equal(decodeState('!!!').ok, false);
  assert.equal(decodeState('AAAA===').ok, false);
  assert.equal(decodeState('A'.repeat(20001)).ok, false);
});

test('codec: decode rejects a wrong version', () => {
  const obj = packState(sampleState());
  obj.v = 99;
  const code = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
  const r = decodeState(code);
  assert.equal(r.ok, false);
  assert.match(r.error, /version/i);
});

test('codec: decode validates every field', () => {
  const good = packState(sampleState());
  const cases = [
    (o) => { o.m = ['only']; },
    (o) => { o.m = ['ok name', '']; },
    (o) => { o.s = [7, 2000, 0]; },        // alpha 0
    (o) => { o.s = [7, 5, 0.05]; },        // reps too low
    (o) => { o.s = [-1, 2000, 0.05]; },    // negative seed
    (o) => { o.q = []; },
    (o) => { o.q[0][1] = [1, 0, 1]; },     // odd pair count
    (o) => { o.q[0][1] = [1e10, 0]; },     // score out of range
    (o) => { o.q[0][0] = ''; },            // empty name
  ];
  for (const mut of cases) {
    const o = JSON.parse(JSON.stringify(good));
    mut(o);
    const code = Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
    assert.equal(decodeState(code).ok, false, JSON.stringify(o).slice(0, 80));
  }
});

test('codec: more than eight suites is rejected', () => {
  const o = packState(sampleState());
  while (o.q.length <= MAX_SUITES) o.q.push(['s' + o.q.length, [1, 0, 0, 1]]);
  const code = Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
  assert.equal(decodeState(code).ok, false);
});

test('codec: stateFromHash parses #bz= and ignores foreign hashes', () => {
  const enc = encodeState(sampleState());
  const r = stateFromHash(`#bz=${enc.code}`);
  assert.ok(r.ok);
  assert.equal(r.state.suites[0].name, 'one');
  assert.equal(stateFromHash('#lab=AAAA'), null);
  assert.equal(stateFromHash(''), null);
  assert.equal(stateFromHash('#other'), null);
});

test('codec: stateFromHash rejects a malformed hash politely', () => {
  const r = stateFromHash('#bz=%%%');
  assert.equal(r.ok, false);
  assert.match(r.error, /malformed|characters|truncated/i);
});

test('codec: pairs round-trip with regenerated item ids', () => {
  const dec = decodeState(encodeState(sampleState()).code);
  assert.ok(dec.ok);
  const ids = dec.state.suites[0].rows.map((r) => r.id);
  assert.deepEqual(ids, ['i1', 'i2', 'i3']);
});

test('codec: decoded scores are rounded to 1e-6', () => {
  const state = sampleState();
  state.suites[0].rows[0].a = 0.123456789;
  const dec = decodeState(encodeState(state).code);
  assert.equal(dec.state.suites[0].rows[0].a, 0.123457);
});

test('codec: pack/unpack are inverse for a clean state', () => {
  const s = sampleState();
  const u = unpackState(JSON.parse(JSON.stringify(packState(s))));
  assert.equal(u.suites.length, s.suites.length);
  assert.equal(u.models[0], s.models[0]);
});

test('codec: rowsToText and parseRows round-trip', () => {
  const rows = mk([[1, 0.5], [0.25, 1]]);
  const back = parseRows(rowsToText(rows));
  assert.ok(back.ok);
  assert.deepEqual(back.rows, rows);
});

/* ------------------------------------------------------------------ */
/* self-test battery                                                   */
/* ------------------------------------------------------------------ */

test('self-tests: the battery reports all pass in Node too', () => {
  const r = runSelfTests();
  assert.equal(r.pass, r.total, r.results.filter((x) => !x.pass).map((x) => x.name).join(', '));
  assert.ok(r.total >= 12);
});

test('self-tests: every check has a name and a boolean verdict', () => {
  for (const [name, run] of SELF_TESTS) {
    assert.equal(typeof name, 'string');
    assert.ok(name.length > 5);
    assert.equal(typeof run, 'function');
  }
});

test('self-tests: runSelfTests never throws, even if a check throws', () => {
  const r = runSelfTests();
  assert.ok(Array.isArray(r.results));
  for (const t of r.results) assert.equal(typeof t.pass, 'boolean');
});
