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
        // Newer interpreters list every problem; older ones give just the first.
        return (r.errors || [r]).map((e) => ({ line: e.line, col: e.col || undefined, severity: 'error', message: e.message, fix: fixFor(e.message) }));
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
function fixFor(message) {
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

// Names follow .jlb's scope rules: inside a function you see its inputs, its own
// names and the globals (no closures); outside, only globals. FOR and FAIL names
// exist only inside their block. At the top level, a name must already have a value
// when its line runs, so using it above the line that gives it one is a mistake too.
function undefinedNames({ uses, defined, globals, funcs, loads, gotos, points, lineAt }) {
  const out = [];
  const seen = new Set();
  const jumps = gotos.length > 0 || points.size > 0; // GOTO can run lines out of order
  const ownerOf = (name) => funcs.find((f) => f.locals.has(name) || paramNames(f).includes(name));
  for (const u of uses) {
    const key = u.line + ':' + u.name;
    if (seen.has(key)) continue;
    const fn = u.func >= 0 ? funcs[u.func] : null;
    const visible = u.blockNames.has(u.name) || globals.has(u.name) || loads.has(u.name)
      || (fn && (fn.locals.has(u.name) || paramNames(fn).includes(u.name)));
    if (!visible) {
      seen.add(key);
      const owner = ownerOf(u.name);
      if (owner && owner !== fn) {
        const where = owner.name ? `${owner.name}()` : `the function on line ${owner.line}`;
        out.push({
          line: u.line, col: u.col, endCol: u.col + u.name.length, severity: 'warning',
          message: `${u.name} only exists inside ${where}, so it has no value here. Give it a value outside the function to share it, or pass it in.`,
        });
        continue;
      }
      if (defined.has(u.name)) {
        out.push({
          line: u.line, col: u.col, endCol: u.col + u.name.length, severity: 'warning',
          message: `${u.name} only exists inside its own FOR or FAIL block, so it has no value here.`,
        });
        continue;
      }
      const close = [...visibleNames(u, fn, globals, loads)].filter((d) => near(d, u.name)).slice(0, 2);
      out.push({
        line: u.line, col: u.col, endCol: u.col + u.name.length, severity: 'warning',
        message: `${u.name} is never given a value in this file${close.length ? `. Did you mean ${close.join(' or ')}?` : '.'}`,
        fix: close.length ? close.map((c) => ({ label: `Change to ${c}`, text: c })) : undefined,
      });
      continue;
    }
    // Top-level code runs in order, so a value given further down isn't there yet.
    if (!fn && !jumps && u.depth === 0 && !u.blockNames.has(u.name) && !loads.has(u.name) && globals.get(u.name) >= u.off) {
      seen.add(key);
      const at = lineAt(globals.get(u.name));
      const isFunc = funcs.some((f) => f.name === u.name && f.inFunc < 0);
      out.push({
        line: u.line, col: u.col, endCol: u.col + u.name.length, severity: 'warning',
        message: isFunc
          ? `${u.name}() is used before its FUNC line has run (line ${at}). Move the FUNC above this line.`
          : globals.get(u.name) === u.off
            ? `${u.name} has no value yet, so it can't be changed here. Give it a starting value first, like ${u.name} = 0.`
            : `${u.name} is used before it's given a value (line ${at} gives it one).`,
      });
    }
  }
  return out;
}

const paramNames = (f) => f.params.map((p) => p.replace(/^(@|\.\.\.)/, ''));

function visibleNames(u, fn, globals, loads) {
  const names = new Set([...u.blockNames, ...globals.keys(), ...loads]);
  if (fn) for (const n of [...fn.locals, ...paramNames(fn)]) names.add(n);
  return names;
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
