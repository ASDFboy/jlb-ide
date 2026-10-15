// A quick, forgiving scan of .jlb code for the editor tools: functions, POINTs,
// GOTOs, and which names are given values. It never fails on broken code.

const TOKEN = /[A-Za-z_][A-Za-z0-9_]*|\d[\w.]*|!===|===|!==|==|!\^=|!%=|@=|[-+*/^%]=|\.\.\.|\S/g;
const ASSIGN = new Set(['=', '@=']);
const COMPOUND = new Set(['+=', '-=', '*=', '/=', '^=', '!^=', '%=', '!%=']);

/** Text with comments removed and (for `code`) strings blanked, keeping every position. */
export function strip(text) {
  let noComments = '';
  let code = '';
  let i = 0;
  const n = text.length;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    if (text.startsWith('>>>', i)) {
      const end = text.indexOf('<<<', i + 3);
      const stop = end < 0 ? n : end + 3;
      const b = blank(text.slice(i, stop));
      noComments += b;
      code += b;
      i = stop;
    } else if (text.startsWith('>>', i)) {
      let end = text.indexOf('\n', i);
      if (end < 0) end = n;
      const b = blank(text.slice(i, end));
      noComments += b;
      code += b;
      i = end;
    } else if (text[i] === '"' || text[i] === "'") {
      const q = text[i];
      let j = i + 1;
      while (j < n && text[j] !== q) j += q === "'" && text[j] === '\\' ? 2 : 1;
      const s = text.slice(i, Math.min(j + 1, n));
      noComments += s;
      code += q + blank(s.slice(1, -1)) + (s.length > 1 && s.endsWith(q) ? q : '');
      i = Math.min(j + 1, n);
    } else {
      noComments += text[i];
      code += text[i];
      i++;
    }
  }
  return { noComments, code };
}

export function scan(text) {
  const { noComments, code } = strip(text);
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const where = (off) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: off - starts[lo] + 1 };
  };
  const toks = [...code.matchAll(TOKEN)].map((m) => ({ t: m[0], off: m.index }));
  const isName = (t) => /^[a-z_][a-z0-9_]*$/.test(t || '');

  const funcs = [];
  const points = new Map();
  const gotos = [];
  const defined = new Set();
  const definedAt = new Map();
  const uses = [];
  // Where names live, following .jlb's rules:
  //   globals   given a value outside any function (or FUNC names), with the first place
  //   locals    per function: its inputs, LOCAL names, and names first given a value inside it
  //   blocks    FOR loop variables and FAIL names exist only inside their { } block
  const globals = new Map();
  const fields = new Map(); // table name -> entry names seen (t.name = ..., [name: 1])
  const addField = (table, name) => {
    if (!fields.has(table)) fields.set(table, new Set());
    fields.get(table).add(name);
  };
  const define = (name, off) => {
    defined.add(name);
    if (!definedAt.has(name)) definedAt.set(name, where(off));
  };
  const scopes = []; // { depth, names: Set, func: index | -1, kind }
  let depth = 0;
  let pending = null; // what the next "{" opens: { kind, names, func }
  const currentFunc = () => {
    for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].kind === 'func') return scopes[i].func;
    return -1;
  };
  const giveValue = (name, off) => {
    define(name, off);
    const f = currentFunc();
    if (f >= 0) funcs[f].locals.add(name);
    else if (!globals.has(name)) globals.set(name, off);
  };
  const visibleBlockNames = () => {
    const names = new Set();
    for (let i = scopes.length - 1; i >= 0; i--) {
      for (const n of scopes[i].names) names.add(n);
      if (scopes[i].kind === 'func') break; // no closures: an outer function's names aren't visible
    }
    return names;
  };

  for (let k = 0; k < toks.length; k++) {
    const { t, off } = toks[k];
    const next = toks[k + 1]?.t;
    const prev = toks[k - 1]?.t;
    if (t === '{') {
      depth++;
      scopes.push({ depth, names: new Set(pending?.names || []), func: pending?.func ?? -1, kind: pending?.kind || 'block' });
      pending = null;
      continue;
    }
    if (t === '}') {
      if (scopes.length && scopes[scopes.length - 1].depth === depth) scopes.pop();
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (t === 'FUNC') {
      let j = k + 1;
      let name = null;
      const index = funcs.length;
      const fn = { name, params: [], locals: new Set(), line: where(off).line, col: where(off).col, nameCol: null, inFunc: currentFunc() };
      funcs.push(fn);
      if (isName(toks[j]?.t)) {
        fn.name = name = toks[j].t;
        fn.nameCol = where(toks[j].off).col;
        // A named function is a value like any other: global when made outside functions.
        giveValue(name, toks[j].off);
        j++;
      }
      const names = [];
      if (toks[j]?.t === '(') {
        let d = 0;
        let start = true;
        for (j++; j < toks.length; j++) {
          const x = toks[j].t;
          if (x === '(' || x === '[') d++;
          else if (x === ')' || x === ']') {
            if (d === 0) break;
            d--;
          } else if (x === ',' && d === 0) start = true;
          else if (start && isName(x)) {
            define(x, toks[j].off);
            names.push(x);
            fn.params.push(toks[j - 1]?.t === '@' ? '@' + x : toks[j - 1]?.t === '...' ? '...' + x : x);
            start = false;
          }
        }
      }
      pending = { kind: 'func', names, func: index };
      k = j;
      continue;
    }
    if ((t === 'POINT' || t === 'GOTO') && isName(next)) {
      const p = where(toks[k + 1].off);
      if (t === 'POINT' && !points.has(next)) points.set(next, p);
      if (t === 'GOTO') gotos.push({ name: next, ...p });
      k++;
      continue;
    }
    if (t === 'FOR') {
      const names = [];
      let j = k + 1;
      for (; j < toks.length && toks[j].t !== 'IN' && toks[j].t !== '{'; j++) {
        if (isName(toks[j].t)) {
          define(toks[j].t, toks[j].off);
          names.push(toks[j].t);
        }
      }
      pending = { kind: 'block', names, func: -1 };
      k = j - 1;
      continue;
    }
    if (t === 'FAIL' && isName(next)) {
      define(next, toks[k + 1].off);
      pending = { kind: 'block', names: [next], func: -1 };
      k++;
      continue;
    }
    if (t === 'LOCAL' && isName(next)) {
      giveValue(next, toks[k + 1].off);
      k++;
      continue;
    }
    if (!isName(t)) continue;
    if (prev === '.') {
      // a table entry: t.name
      if (isName(toks[k - 2]?.t) && toks[k - 3]?.t !== '.') addField(toks[k - 2].t, t);
      continue;
    }
    if (next === ':') continue; // a name in a table: [name: 1]
    if (ASSIGN.has(next)) {
      giveValue(t, off);
      // t = [name: 1, other: 2] names its entries.
      if (toks[k + 2]?.t === '[') {
        let d = 0;
        for (let j = k + 2; j < toks.length; j++) {
          const x = toks[j].t;
          if (x === '[' || x === '(' || x === '{') d++;
          else if (x === ']' || x === ')' || x === '}') {
            if (--d === 0) break;
          } else if (d === 1 && isName(x) && toks[j + 1]?.t === ':' && (toks[j - 1].t === '[' || toks[j - 1].t === ',')) addField(t, x);
        }
      }
      continue;
    }
    // x += 1 reads x first, so x needs a value already.
    uses.push({ name: t, off, ...where(off), func: currentFunc(), depth, blockNames: visibleBlockNames() });
    if (COMPOUND.has(next)) giveValue(t, off);
  }

  // LOAD "My-Tools.jlb" gives a table called my_tools.
  const loads = new Set();
  for (const m of noComments.matchAll(/\bLOAD\s+["']([^"']+)["']/g)) {
    const base = m[1].split(/[\\/]/).pop().replace(/\.jlb$/i, '');
    const name = base.toLowerCase().replace(/[-\s]+/g, '_');
    define(name, m.index);
    loads.add(name);
  }

  return {
    funcs,
    globals,
    fields,
    loads,
    lineAt: (off) => where(off).line,
    points,
    gotos,
    defined,
    definedAt,
    uses,
    usesImport: /\bIMPORT\b/.test(code),
    lines: noComments.split('\n'),
    codeLines: code.split('\n'),
  };
}
