// Stats page invariant tests: stats.html ships the same CSP, script and hygiene
// rules as index.html, every id the controller touches exists, the service
// worker caches the new modules, and no external reference leaks in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

const html = read('stats.html');
const app = read('src/stats-app.js');
const css = read('styles.css');
const sw = read('sw.js');
const index = read('index.html');

test('stats.html: ships the same strict Content-Security-Policy as the bench', () => {
  const cspIndex = /<meta\s+http-equiv="Content-Security-Policy"[^>]+content="([^"]+)"/.exec(index)[1];
  const cspStats = /<meta\s+http-equiv="Content-Security-Policy"[^>]+content="([^"]+)"/.exec(html)[1];
  assert.equal(cspStats, cspIndex);
});

test('stats.html: CSP bans unsafe-inline and unsafe-eval', () => {
  const csp = /content="([^"]+)"/.exec(/<meta\s+http-equiv="Content-Security-Policy"[^>]+>/.exec(html)[0])[1];
  assert.ok(!/unsafe-inline/.test(csp));
  assert.ok(!/unsafe-eval/.test(csp));
});

test('stats.html: exactly one module script, same origin', () => {
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ['src/stats-app.js']);
  assert.ok(/<script type="module" src="src\/stats-app\.js">/.test(html));
});

test('stats.html: no inline event handlers or javascript: URLs', () => {
  assert.ok(!/\son(click|load|error|keydown|keyup|keypress|input|change|mouseover|focus|blur)\s*=/i.test(html));
  assert.ok(!/javascript:/i.test(html));
});

test('stats.html: no accesskey attributes', () => {
  assert.ok(!/accesskey\s*=/i.test(html));
});

test('stats.html: one h1 and every panel labelled by a heading', () => {
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.ok((html.match(/<h2\b/g) || []).length >= 6);
});

test('stats.html: no eyebrow, kicker, tagline or subtitle classes', () => {
  assert.equal(/class="[^"]*(eyebrow|kicker|tagline|subtitle)[^"]*"/i.test(html), false);
});

test('stats.html: no smooth scroll rule anywhere it ships', () => {
  assert.equal(/scroll-behavior:\s*smooth/.test(html), false);
});

test('stats.html: no external asset references', () => {
  const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
  for (const r of refs) {
    assert.ok(!/^https?:\/\//.test(r) || r === 'http://www.w3.org/2000/svg', `external ref ${r}`);
  }
});

test('stats.html: every element id the controller queries exists', () => {
  const ids = [...app.matchAll(/\$\('(#[-\w]+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length > 20, `expected many ids, found ${ids.length}`);
  for (const id of ids) {
    assert.ok(html.includes(`id="${id.slice(1)}"`), `${id} missing from stats.html`);
  }
});

test('service worker caches stats.html and every src module', () => {
  assert.ok(sw.includes("'./stats.html'"), 'sw must cache stats.html');
  const srcFiles = readdirSync(new URL('../src/', import.meta.url)).filter((f) => f.endsWith('.js'));
  for (const f of srcFiles) assert.ok(sw.includes(`'./src/${f}'`), `sw missing ${f}`);
});

test('service worker cache version was bumped for the new files', () => {
  assert.match(sw, /benchzero-v(\d+)/);
  const v = Number(/benchzero-v(\d+)/.exec(sw)[1]);
  assert.ok(v >= 6, `cache v${v}`);
});

test('index.html: links to the rigor page from the header', () => {
  assert.ok(/href="stats\.html"/.test(index));
});

test('stats-app: imported modules exist on disk', () => {
  for (const m of app.matchAll(/from '(\.\/[-\w]+\.js)'/g)) {
    const f = m[1].slice(2);
    assert.ok(readdirSync(new URL('../src/', import.meta.url)).includes(f), `${f} missing`);
  }
});

test('stats.html: skip link targets a real id', () => {
  const target = /<a class="skip" href="#([-\w]+)"/.exec(html)[1];
  assert.ok(html.includes(`id="${target}"`), `#${target} missing`);
});

test('stats.html: live region and toast exist for announcements', () => {
  assert.ok(/id="live"[^>]*aria-live="polite"/.test(html));
  assert.ok(/id="toast"/.test(html));
});

test('styles.css: rigor page grid spans are defined', () => {
  for (const cls of ['st-input', 'st-results', 'st-powerp', 'st-contamp', 'st-exportp', 'st-selfp']) {
    assert.ok(css.includes(`.${cls}`), `.${cls} missing`);
  }
});

test('styles.css: rigor panels collapse to full width on narrow screens', () => {
  assert.ok(/@media \(max-width: 1180px\)[\s\S]*\.st-input, \.st-results/.test(css));
});
