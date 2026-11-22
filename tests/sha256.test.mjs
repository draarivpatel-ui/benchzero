// SHA-256 tests: FIPS 180-4 known answers plus a differential sweep against
// node:crypto (the test harness reference, never shipped in the page).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { sha256Hex, sha256Bytes } from '../src/sha256.js';

const ref = (input) => createHash('sha256').update(input).digest('hex');

/* FIPS 180-4 known-answer vectors */

test('sha256: empty message matches the FIPS known answer', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('sha256: "abc" matches the FIPS known answer', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('sha256: 56-byte FIPS message (two-block) matches', () => {
  const m = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
  assert.equal(sha256Hex(m), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

test('sha256: 112-byte FIPS message matches', () => {
  const m = 'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu';
  assert.equal(sha256Hex(m), 'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1');
});

test('sha256: one million "a" characters match the FIPS known answer', () => {
  assert.equal(sha256Hex('a'.repeat(1_000_000)), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});

/* Boundary lengths: padding turns at 55/56 and 119/120 bytes */

for (const n of [0, 1, 2, 3, 7, 31, 32, 54, 55, 56, 57, 63, 64, 65, 100, 118, 119, 120, 121, 127, 128, 129]) {
  test(`sha256: ${n}-byte ascii payload agrees with node:crypto`, () => {
    const s = Array.from({ length: n }, (_, i) => String.fromCharCode(33 + ((i * 7) % 90))).join('');
    assert.equal(sha256Hex(s), ref(s), `length ${n}`);
  });
}

for (const n of [200, 255, 256, 500, 511, 512, 1000, 2048, 4096]) {
  test(`sha256: ${n}-byte payload agrees with node:crypto`, () => {
    const s = 'x'.repeat(n);
    assert.equal(sha256Hex(s), ref(s));
  });
}

/* Binary input */

test('sha256: Uint8Array input agrees with node:crypto', () => {
  const b = new Uint8Array(300);
  for (let i = 0; i < b.length; i++) b[i] = (i * 31 + 7) & 255;
  assert.equal(sha256Hex(b), ref(b));
});

test('sha256: sha256Bytes returns exactly 32 bytes', () => {
  const d = sha256Bytes(new TextEncoder().encode('bench'));
  assert.ok(d instanceof Uint8Array);
  assert.equal(d.length, 32);
});

test('sha256: Uint8Array and string forms agree', () => {
  const bytes = new TextEncoder().encode('same bytes');
  assert.equal(sha256Hex(bytes), sha256Hex('same bytes'));
});

test('sha256: all 256 byte values in one message', () => {
  const b = new Uint8Array(256);
  for (let i = 0; i < 256; i++) b[i] = i;
  assert.equal(sha256Hex(b), ref(b));
});

test('sha256: a buffer longer than 64 KiB hashes correctly', () => {
  const b = new Uint8Array(70_000);
  for (let i = 0; i < b.length; i++) b[i] = (i * i + i) & 255;
  assert.equal(sha256Hex(b), ref(b));
});

/* UTF-8 handling */

test('sha256: multi-byte UTF-8 input matches node:crypto', () => {
  for (const s of ['café', 'naïve façade', 'Δ delta', 'bench Ω test', 'score ½']) {
    assert.equal(sha256Hex(s), ref(s), s);
  }
});

test('sha256: astral-plane characters (surrogate pairs) hash correctly', () => {
  const s = '𝕏 emoji \u{1f9ee}\u{1f4ca} end';
  assert.equal(sha256Hex(s), ref(s));
});

/* Output properties */

test('sha256: output is 64 lowercase hex characters', () => {
  assert.match(sha256Hex('anything'), /^[0-9a-f]{64}$/);
});

test('sha256: deterministic for identical input', () => {
  assert.equal(sha256Hex('repeat me'), sha256Hex('repeat me'));
});

test('sha256: a single-bit input change flips roughly half the digest', () => {
  const a = sha256Hex('benchzero');
  const b = sha256Hex('benchzerp');
  let same = 0;
  for (let i = 0; i < 64; i++) if (a[i] === b[i]) same++;
  assert.notEqual(a, b);
  assert.ok(same < 20, `only ${same}/64 hex chars should coincide`);
});

test('sha256: empty Uint8Array equals empty string digest', () => {
  assert.equal(sha256Hex(new Uint8Array(0)), sha256Hex(''));
});

test('sha256: ArrayBuffer view with an offset hashes only its own bytes', () => {
  const buf = new Uint8Array(100);
  for (let i = 0; i < 100; i++) buf[i] = i;
  const view = buf.subarray(10, 50);
  assert.equal(sha256Hex(view), ref(view));
});
