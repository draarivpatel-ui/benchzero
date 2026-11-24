import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { pairedBootstrap, contaminationBounds, mde } from '../src/stats-lab.js';
import { encodeState, decodeState } from '../src/stats-io.js';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const state = (over = {}) => ({
  models: ['Model A', 'Model B'], seed: 7, reps: 2000, alpha: 0.05, level: 0.9,
  pdisc: 0.42, contamPct: 12.5,
  suites: [{ name: 'one', rows: [{ id: 'i1', a: 1, b: 0 }, { id: 'i2', a: 0, b: 1 }] }],
  ...over,
});

test('L510: rigor links restore every analysis setting', () => {
  const enc = encodeState(state());
  assert.equal(enc.ok, true, enc.error);
  const dec = decodeState(enc.code);
  assert.equal(dec.ok, true, dec.error);
  assert.equal(dec.state.level, 0.9);
  assert.equal(dec.state.pdisc, 0.42);
  assert.equal(dec.state.contamPct, 12.5);
});

test('L510: rigor links preserve a small nonzero alpha', () => {
  const alpha = 0.0000004;
  const dec = decodeState(encodeState(state({ alpha })).code);
  assert.equal(dec.ok, true, dec.error);
  assert.equal(dec.state.alpha, alpha);
});

test('L510: contamination bounds reject nonfinite or out-of-range accuracies', () => {
  for (const [a, b] of [[NaN, 0.8], [0.9, Infinity], [-0.1, 0.8], [0.9, 1.1]]) {
    assert.equal(contaminationBounds(a, b, 0.1).ok, false, `${a}, ${b}`);
  }
});

test('L510: mde rejects impossible discordant shares and targets', () => {
  assert.equal(mde(100, 0, 0.05, 0.8).ok, false);
  assert.equal(mde(100, 1.2, 0.05, 0.8).ok, false);
  assert.equal(mde(100, 0.4, 0.05, 1.2).ok, false);
});

test('L510: bootstrap validation never throws on malformed input', () => {
  assert.doesNotThrow(() => pairedBootstrap(undefined));
  assert.equal(pairedBootstrap(undefined).ok, false);
  assert.equal(pairedBootstrap(null).ok, false);
});

test('L510: the cursor-driven scope canvas uses interactive application semantics', () => {
  const html = read('index.html');
  const tag = /<canvas[^>]*id="scope"[^>]*>/.exec(html)[0];
  assert.match(tag, /role="application"/);
  assert.match(tag, /tabindex="0"/);
});

test('L510: chart legends and form labels meet the 11px functional text floor', () => {
  const css = read('styles.css');
  assert.doesNotMatch(css, /font(?:-size)?:[^;}\n]*\b10(?:\.5)?px/);
});
