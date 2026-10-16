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

/** The name LOAD gives a file's table: "My-Tools.jlb" → my_tools. */
export function loadName(file) {
  // Like the interpreter: the file name without its extension, lowercase, - and space as _.
  return String(file).split(/[\\/]/).pop().replace(/(.)\.[^.]*$/, '$1').toLowerCase().replace(/[- ]/g, '_');
}

/**
 * Where a name in `refs` lives: "block:<id>" for a FOR or FAIL name, "func:<index>" for
 * a function's own local, or "global" for an outside name. Inside a function, giving a
 * value to a name that exists outside changes the outside one, so `outside` lists the
 * names that come from other files.
 */
export function bindingOf(info, r, outside) {
  if (r.block != null) return 'block:' + r.block;
  if (r.func < 0) return 'global';
  const f = info.funcs[r.func];
  if (f.declared.has(r.name)) return 'func:' + r.func;
  if (info.globals.has(r.name) || outside?.has(r.name)) return 'global';
  return 'func:' + r.func;
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
  const scopes = []; // { depth, names: Set, func: index | -1, kind, id }
  let depth = 0;
  let pending = null; // what the next "{" opens: { kind, names, func, id }
  let scopeIds = 0;
  // Every place a name appears, for renaming: refs are names (with where they live,
  // see bindingOf), labels are POINT and GOTO names, entries are t.name.
  const refs = [];
  const labels = [];
  const entries = [];
  const consts = []; // CONST names: { name, off, func }
  const COMMANDS = new Set(['INSERT', 'DROP', 'UNDEFINE']);
  // How the name at toks[k] gets changed, if it does: 'assign' (x = 1, x += 1),
  // 'entry' (x.a = 1, x[2] += 1) or 'command' (INSERT(x, ...), DROP, UNDEFINE).
  const writeAt = (k) => {
    if (toks[k - 1]?.t === '(' && COMMANDS.has(toks[k - 2]?.t)) return 'command';
    let j = k + 1;
    if (ASSIGN.has(toks[j]?.t) || COMPOUND.has(toks[j]?.t)) return 'assign';
    let moved = false;
    while (j < toks.length) {
      if (toks[j].t === '.' && isName(toks[j + 1]?.t)) j += 2;
      else if (toks[j].t === '[') {
        let d = 0;
        for (; j < toks.length; j++) {
          if (toks[j].t === '[') d++;
          else if (toks[j].t === ']' && --d === 0) break;
        }
        j++;
      } else break;
      moved = true;
    }
    return moved && (ASSIGN.has(toks[j]?.t) || COMPOUND.has(toks[j]?.t)) ? 'entry' : null;
  };
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
  // The FOR or FAIL block a name belongs to, if any (stopping at the function it's in).
  const blockOf = (name) => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i].kind === 'func') return null;
      if (scopes[i].names.has(name)) return scopes[i].id;
    }
    return null;
  };
  const ref = (name, off, extra) => refs.push({ name, off, func: currentFunc(), block: blockOf(name), ...extra });
  const refAt = (k) => {
    const write = writeAt(k);
    ref(toks[k].t, toks[k].off, write ? { write } : undefined);
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
      scopes.push({ depth, names: new Set(pending?.names || []), func: pending?.func ?? -1, kind: pending?.kind || 'block', id: pending?.id ?? ++scopeIds });
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
      const fn = { name, params: [], locals: new Set(), declared: new Set(), line: where(off).line, col: where(off).col, nameCol: null, inFunc: currentFunc() };
      funcs.push(fn);
      if (isName(toks[j]?.t)) {
        fn.name = name = toks[j].t;
        fn.nameCol = where(toks[j].off).col;
        // A named function is a value like any other: global when made outside functions.
        giveValue(name, toks[j].off);
        ref(name, toks[j].off);
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
            fn.declared.add(x);
            refs.push({ name: x, off: toks[j].off, func: index, block: null });
            fn.params.push(toks[j - 1]?.t === '@' ? '@' + x : toks[j - 1]?.t === '...' ? '...' + x : x);
            start = false;
          }
        }
      }
      pending = { kind: 'func', names, func: index, id: ++scopeIds };
      k = j;
      continue;
    }
    if ((t === 'POINT' || t === 'GOTO') && isName(next)) {
      const p = where(toks[k + 1].off);
      if (t === 'POINT' && !points.has(next)) points.set(next, p);
      if (t === 'GOTO') gotos.push({ name: next, ...p });
      labels.push({ name: next, off: toks[k + 1].off });
      k++;
      continue;
    }
    if (t === 'FOR') {
      const names = [];
      const id = ++scopeIds;
      let j = k + 1;
      for (; j < toks.length && toks[j].t !== 'IN' && toks[j].t !== '{'; j++) {
        if (isName(toks[j].t)) {
          define(toks[j].t, toks[j].off);
          names.push(toks[j].t);
          refs.push({ name: toks[j].t, off: toks[j].off, func: currentFunc(), block: id });
        }
      }
      pending = { kind: 'block', names, func: -1, id };
      k = j - 1;
      continue;
    }
    if (t === 'FAIL' && isName(next)) {
      define(next, toks[k + 1].off);
      pending = { kind: 'block', names: [next], func: -1, id: ++scopeIds };
      refs.push({ name: next, off: toks[k + 1].off, func: currentFunc(), block: pending.id });
      k++;
      continue;
    }
    if (t === 'CONST' && isName(next)) {
      // CONST x = ... makes a new name where it is: like LOCAL inside a function.
      consts.push({ name: next, off: toks[k + 1].off, func: currentFunc() });
      if (currentFunc() >= 0) funcs[currentFunc()].declared.add(next);
      continue; // x = ... is read next, as usual
    }
    if (t === 'LOCAL' && isName(next)) {
      giveValue(next, toks[k + 1].off);
      if (currentFunc() >= 0) funcs[currentFunc()].declared.add(next);
      ref(next, toks[k + 1].off);
      k++;
      continue;
    }
    if (!isName(t)) continue;
    if (prev === '.') {
      // a table entry: t.name
      if (isName(toks[k - 2]?.t) && toks[k - 3]?.t !== '.') {
        addField(toks[k - 2].t, t);
        entries.push({ owner: toks[k - 2].t, name: t, off });
      }
      continue;
    }
    if (next === ':') continue; // a name in a table: [name: 1]
    refAt(k);
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

  // IMPORT "helpers.jlb" and LOAD "My-Tools.jlb" (LOAD gives a table called my_tools).
  const imports = [];
  const loads = new Set();
  for (const m of noComments.matchAll(/\b(IMPORT|LOAD)\s+(?:"([^"\n]*)"|'((?:\\.|[^'\\\n])*)')/g)) {
    if (!code.startsWith(m[1], m.index)) continue; // inside text, not code
    const raw = m[2] ?? m[3];
    const file = m[2] !== undefined ? raw : raw.replace(/\\(.)/g, '$1');
    const at = where(m.index + m[0].length - raw.length - 2);
    imports.push({ kind: m[1], file, off: m.index, line: at.line, col: at.col, endCol: at.col + raw.length + 2 });
    if (m[1] === 'LOAD' && isName(loadName(file))) {
      const name = loadName(file);
      define(name, m.index);
      loads.add(name);
    }
  }

  return {
    funcs,
    consts,
    globals,
    fields,
    loads,
    imports,
    refs,
    labels,
    entries,
    lineAt: (off) => where(off).line,
    at: where,
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
