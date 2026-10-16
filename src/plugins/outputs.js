// Shared by the Compare and Tests features: running a program to the end and
// comparing what it printed, line by line.

/**
 * Runs a file to the end with `input` typed in: { text, code, ms, timedOut } or { error }.
 * With `stay`, that interpreter runs it even if its first line asks for the other one.
 */
export async function runToEnd(api, interpreter, path, { input = '', timeout = 10000, stay = false } = {}) {
  const cwd = path.replace(/[\\/][^\\/]*$/, '');
  try {
    const r = await api.invoke('run_capture', { interpreter, file: path, cwd, args: [], input, timeout_ms: timeout, stay });
    // What a person sees: the program's output, then any error report.
    return { text: normalize(r.stdout + r.stderr), code: r.code, ms: r.ms, timedOut: r.timed_out };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

/** Line endings made plain, and trailing blank space dropped (like the interpreters' own tests). */
export function normalize(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

/**
 * Lines of `a` and `b` matched up: a list of { kind: 'same' | 'old' | 'new', a, b }
 * (a and b are line numbers, 1-based, or null). Big outputs are compared line by line.
 */
export function diffLines(aText, bText) {
  const a = aText === '' ? [] : aText.split('\n');
  const b = bText === '' ? [] : bText.split('\n');
  const out = [];
  // Common start and end first: usually most of it.
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  for (let i = 0; i < s; i++) out.push({ kind: 'same', a: i + 1, b: i + 1, text: a[i] });
  const am = a.slice(s, a.length - e);
  const bm = b.slice(s, b.length - e);
  if (am.length * bm.length <= 4_000_000) {
    // Longest common subsequence of the middle part.
    const n = am.length;
    const m = bm.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) lcs[i][j] = am[i] === bm[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) {
        out.push({ kind: 'same', a: s + i + 1, b: s + j + 1, text: am[i] });
        i++;
        j++;
      } else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) {
        // Lines only in the first come before lines only in the second.
        out.push({ kind: 'old', a: s + i + 1, b: null, text: am[i] });
        i++;
      } else {
        out.push({ kind: 'new', a: null, b: s + j + 1, text: bm[j] });
        j++;
      }
    }
  } else {
    for (let i = 0; i < Math.max(am.length, bm.length); i++) {
      if (am[i] === bm[i]) out.push({ kind: 'same', a: s + i + 1, b: s + i + 1, text: am[i] });
      else {
        if (i < am.length) out.push({ kind: 'old', a: s + i + 1, b: null, text: am[i] });
        if (i < bm.length) out.push({ kind: 'new', a: null, b: s + i + 1, text: bm[i] });
      }
    }
  }
  for (let k = 0; k < e; k++) {
    const ai = a.length - e + k;
    const bi = b.length - e + k;
    out.push({ kind: 'same', a: ai + 1, b: bi + 1, text: a[ai] });
  }
  return out;
}

/** The first line where two outputs differ (1-based), or 0 when they're the same. */
export function firstDifference(aText, bText) {
  if (aText === bText) return 0;
  const a = aText.split('\n');
  const b = bText.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return i + 1;
  return 0;
}

export function formatMs(ms) {
  if (ms == null) return '';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}
