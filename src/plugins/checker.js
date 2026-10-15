// Live mistake checking: the interpreter's own syntax check, plus warnings for
// the .jlb quirks that trip people up.

import { scan } from './scan.js';

export default {
  id: 'checker',
  name: 'Live mistake checking',
  description: 'Underlines mistakes as you type, using the interpreter\'s own syntax check plus warnings for common .jlb slip-ups.',
  builtin: true,
  settings: [
    { key: 'syntax', title: 'Check syntax with the interpreter', description: 'The same check that runs before a program starts.', type: 'boolean', default: true },
    { key: 'andOr', title: 'Warn when && or || would crash', description: 'In .jlb, & and | stop early but && and || always check both sides, so x !== NULL && x.hp crashes when x is NULL.', type: 'boolean', default: true },
    { key: 'textCompare', title: 'Note when text is compared with < or >', description: 'Text against text compares lengths, not alphabetical order.', type: 'boolean', default: true },
    { key: 'undefined', title: 'Warn about names that are never given a value', description: 'Catches typos like PRINT(scroe). Skipped in files that use IMPORT or LOAD.', type: 'boolean', default: true },
    { key: 'gotoPoint', title: 'Warn about GOTO with no matching POINT', type: 'boolean', default: true },
  ],
  activate(api) {
    let warnedMissing = false;
    api.language.addCheck({
      id: 'syntax',
      title: 'Syntax',
      async check({ text }) {
        if (!api.settings.get('syntax')) return [];
        let it = api.run.current;
        if (!it?.path) it = null;
        // The bundled Rust interpreter checks syntax when the chosen one can't.
        const tryWith = async (interp) => JSON.parse(await api.invoke('check_code', { interpreter: interp, source: text }));
        let r;
        try {
          if (!it) throw new Error('no interpreter');
          r = await tryWith(it.path);
        } catch (e) {
          const rust = api.run.resolve('rust');
          if (rust?.path && rust.path !== it?.path) {
            try {
              r = await tryWith(rust.path);
            } catch {
              r = null;
            }
          }
          if (!r) {
            if (!warnedMissing) console.warn('[checker] syntax check unavailable:', e);
            warnedMissing = true;
            return [];
          }
        }
        if (r.ok) return [];
        return [{ line: r.line, col: r.col || undefined, severity: 'error', message: r.message, fix: fixFor(r.message, text, r.line, r.col) }];
      },
    });

    api.language.addCheck({
      id: 'quirks',
      title: '.jlb tips',
      check({ text }) {
        const out = [];
        const info = scan(text);
        if (api.settings.get('andOr')) out.push(...andOrCrashes(info));
        if (api.settings.get('textCompare')) out.push(...textCompares(info));
        if (api.settings.get('gotoPoint')) out.push(...gotoPoints(info));
        if (api.settings.get('undefined') && !info.usesImport) out.push(...undefinedNames(info));
        return out;
      },
    });
  },
};

/** One-click fixes for the interpreter's suggestions. */
function fixFor(message, text, line, col) {
  let m = message.match(/^did you mean ([A-Z_]+)\?/);
  if (m) return { label: `Change to ${m[1]}`, text: m[1] };
  m = message.match(/^"(\w+)" should be "(\w+)"/);
  if (m) return { label: `Rename to ${m[2]}`, text: m[2] };
  if (message.startsWith('!= isn\'t an operator')) return [{ label: 'Change to !==', text: '!==' }, { label: 'Change to !===', text: '!===' }];
  return undefined;
}

// `x !== NULL && x.hp` checks both sides, so x.hp runs (and crashes) when x is NULL.
function andOrCrashes({ codeLines: lines }) {
  const out = [];
  const re = /\b([a-z_][a-z0-9_]*)\s*(!==|!===|==|===)\s*NULL\s*(&&|\|\|)\s*\1\s*[.[]/g;
  lines.forEach((code, i) => {
    for (const m of code.matchAll(re)) {
      const safeWith = m[3] === '&&' ? '&' : '|';
      const fitsOp = (m[2].startsWith('!') && m[3] === '&&') || (!m[2].startsWith('!') && m[3] === '||');
      if (!fitsOp) continue;
      const col = m.index + m[0].indexOf(m[3], m[1].length + m[2].length) + 1;
      out.push({
        line: i + 1, col, endCol: col + 2, severity: 'warning',
        message: `${m[3]} always checks both sides, so the part after it still runs when ${m[1]} is NULL, and crashes. Use ${safeWith} to stop early.`,
        fix: { label: `Change to ${safeWith}`, text: safeWith },
      });
    }
  });
  return out;
}

// "abc" < "abd" compares lengths in .jlb.
function textCompares({ lines }) {
  const out = [];
  const re = /("[^"]*"|'(?:\\.|[^'\\])*')\s*(<==|>==|<=|>=|<|>)\s*("[^"]*"|'(?:\\.|[^'\\])*'|[a-z_][a-z0-9_]*)|([a-z_][a-z0-9_]*)\s*(<==|>==|<=|>=|<|>)\s*("[^"]*"|'(?:\\.|[^'\\])*')/g;
  lines.forEach((raw, i) => {
    for (const m of raw.matchAll(re)) {
      const op = m[2] || m[5];
      const text = m[1] || m[6];
      // Numeric text compares as a number when the other side is a number.
      if (/^["']-?\d/.test(text) && !(m[1] && m[3] && /^["']/.test(m[3]))) continue;
      const col = m.index + m[0].indexOf(op) + 1;
      out.push({
        line: i + 1, col, endCol: col + op.length, severity: 'info',
        message: `${op} on text compares lengths, not alphabetical order ("b" > "a" is FALSE). Use ALPHA_SORT for alphabetical order.`,
      });
    }
  });
  return out;
}

function gotoPoints({ gotos, points }) {
  return gotos.filter((g) => !points.has(g.name)).map((g) => ({
    line: g.line, col: g.col, endCol: g.col + g.name.length, severity: 'warning',
    message: `There's no POINT ${g.name} for this GOTO to jump to.`,
  }));
}

function undefinedNames({ uses, defined }) {
  const out = [];
  const seen = new Set();
  for (const u of uses) {
    if (defined.has(u.name) || seen.has(u.line + ':' + u.name)) continue;
    seen.add(u.line + ':' + u.name);
    const close = [...defined].filter((d) => near(d, u.name)).slice(0, 2);
    out.push({
      line: u.line, col: u.col, endCol: u.col + u.name.length, severity: 'warning',
      message: `${u.name} is never given a value in this file${close.length ? `. Did you mean ${close.join(' or ')}?` : '.'}`,
      fix: close.length ? close.map((c) => ({ label: `Change to ${c}`, text: c })) : undefined,
    });
  }
  return out;
}

/** True when two names are one small typo apart. */
function near(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 2) return false;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length] <= (Math.max(a.length, b.length) > 4 ? 2 : 1);
}
