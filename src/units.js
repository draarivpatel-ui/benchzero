// SI prefix parsing and formatting (SPICE-style: m = milli, M or meg = mega).

const PREFIX = {
  f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, '\u00b5': 1e-6, m: 1e-3,
  k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12,
};

const UNIT_RE = /(ohms?|\u03a9|hz|f|h|v|a|s|w)$/i;

/**
 * Parse an SI string such as "1k", "100n", "4.7m", "10u", "2.2meg", "100nF", "1.5 kOhm".
 * Returns a finite number or NaN.
 */
export function parseSI(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? input : NaN;
  if (typeof input !== 'string') return NaN;
  let s = input.trim().replace(/\s+/g, '');
  if (!s) return NaN;
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)(.*)$/.exec(s);
  if (!m) return NaN;
  const base = parseFloat(m[1]);
  let rest = m[2];
  if (!rest) return base;
  if (/^meg/i.test(rest)) return base * 1e6 * (validTail(rest.slice(3)) ? 1 : NaN);
  const p = rest[0];
  if (p in PREFIX) {
    const tail = rest.slice(1);
    // "1F" / "5H" style: a bare unit letter that is not a prefix is handled below.
    if (validTail(tail)) return base * PREFIX[p];
  }
  if (validTail(rest)) return base;
  return NaN;
}

function validTail(t) {
  return t === '' || UNIT_RE.test(t) && t.replace(UNIT_RE, '') === '';
}

const FMT = [
  [1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''],
  [1e-3, 'm'], [1e-6, '\u00b5'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f'],
];

/** Format a number with an SI prefix, e.g. formatSI(1e-7, 'F') -> "100 nF". */
export function formatSI(v, unit = '', digits = 3) {
  if (!Number.isFinite(v)) return '--';
  if (v === 0) return `0 ${unit}`.trim();
  const a = Math.abs(v);
  for (const [scale, sym] of FMT) {
    if (a >= scale * 0.9995) {
      const x = v / scale;
      return `${trimNum(x, digits)} ${sym}${unit}`.trim();
    }
  }
  return `${trimNum(v / 1e-15, digits)} f${unit}`;
}

/** Compact editable form, e.g. 4.7e-3 -> "4.7m" (round-trips through parseSI). */
export function toSIInput(v) {
  if (!Number.isFinite(v)) return '';
  if (v === 0) return '0';
  const a = Math.abs(v);
  const table = [[1e9, 'G'], [1e6, 'meg'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'u'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f']];
  for (const [scale, sym] of table) {
    if (a >= scale * 0.9999999) return `${+(v / scale).toPrecision(6)}${sym}`;
  }
  return String(v);
}

function trimNum(x, digits) {
  const s = Math.abs(x) >= 100 ? x.toFixed(Math.max(0, digits - 3))
    : Math.abs(x) >= 10 ? x.toFixed(Math.max(0, digits - 2))
      : x.toFixed(Math.max(0, digits - 1));
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** Map v in [lo, hi] (log scale) to [0, 1] and back, for log sliders. */
export function logToUnit(v, lo, hi) {
  return (Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo));
}
export function unitToLog(u, lo, hi) {
  return 10 ** (Math.log10(lo) + u * (Math.log10(hi) - Math.log10(lo)));
}
