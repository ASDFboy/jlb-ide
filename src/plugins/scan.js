// A quick, forgiving scan of .jlb code for the editor tools: functions, POINTs,
// GOTOs, and which names are given values. It never fails on broken code.

const TOKEN = /[A-Za-z_][A-Za-z0-9_]*|\d[\w.]*|!===|===|!==|==|!\^=|!%=|@=|[-+*/^%]=|\.\.\.|\S/g;
const ASSIGN = new Set(['=', '@=']);
/** The types a variable can be declared with: NUMBER score = 0. STRING means TEXT. */
export const TYPE_WORDS = new Set(['NUMBER', 'TEXT', 'STRING', 'BOOL', 'TABLE', 'FUNCTION', 'TASK', 'IMAGE', 'WINDOW', 'FONT']);
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

/**
 * The comment that starts at `i` (after any spaces and new lines), as plain text: a
 * >>> ... <<< comment, or >> lines one after another. null if there isn't one.
 */
export function commentAt(text, i) {
  while (i < text.length && /\s/.test(text[i])) i++;
  let lines;
  if (text.startsWith('>>>', i)) {
    const end = text.indexOf('<<<', i + 3);
    if (end < 0) return null;
    lines = text.slice(i + 3, end).split('\n');
  } else if (text.startsWith('>>', i)) {
    lines = [];
    for (const ln of text.slice(i).split('\n')) {
      const t = ln.trim();
      if (!t.startsWith('>>') || t.startsWith('>>>')) break;
      lines.push(t.slice(2));
    }
  } else return null;
  lines = lines.map((l) => l.trim());
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines.at(-1)) lines.pop();
  return lines.join('\n').replace(/\n{3,}/g, '\n\n') || null;
}

/**
 * The comment at the end of the line that `off` is on (`x = 1 >> what x is`), as plain
 * text, or null. `noComments` is `text` with its comments blanked (see strip).
 */
export function lineComment(text, noComments, off) {
  let end = text.indexOf('\n', off);
  if (end < 0) end = text.length;
  for (let i = off; i < end; i++) {
    if (text[i] === '>' && text[i + 1] === '>' && noComments[i] !== '>') {
      if (text.startsWith('>>>', i)) return commentAt(text, i);
      return text.slice(i + 2, end).trim() || null;
    }
  }
  return null;
}

/** The type the name at `off` was declared with (NUMBER score), if any. */
export function typeAt(info, off, outside) {
  const r = info.refs.find((x) => x.off === off);
  if (!r) return null;
  const key = bindingOf(info, r, outside);
  const d = info.refs.find((x) => x.name === r.name && info.typedAt.has(x.off) && bindingOf(info, x, outside) === key);
  return d ? info.typedAt.get(d.off) : null;
}

/** The note (end-of-line comment) for the name at `off`, where that name was given a value. */
export function noteAt(info, off, outside) {
  const r = info.refs.find((x) => x.off === off);
  if (!r) return null;
  const key = bindingOf(info, r, outside);
  return info.notes.find((n) => n.ref?.name === r.name && bindingOf(info, n.ref, outside) === key) || null;
}

/** The name LOAD gives a file's table: "My-Tools.jlb" → my_tools. */
export function loadName(file) {
  // Like the interpreter: the file name without its extension, lowercase, - and space as _.
  return String(file).split(/[\\/]/).pop().replace(/(.)\.[^.]*$/, '$1').toLowerCase().replace(/[- ]/g, '_');
}

/**
 * Where a name in `refs` lives: "block:<id>" for a FOR or FAIL name, "func:<index>" for
 * a function's own local, or "global" for an outside name. Inside a function, a name
 * given a value there is its own (unless GLOBAL comes first); others are outside names,
 * so `outside` lists the names that come from other files.
 */
export function bindingOf(info, r, outside) {
  if (!r) return null;
  if (r.block != null) return 'block:' + r.block;
  if (r.func < 0 || r.global) return 'global';
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
  // FUNC is the older name for DEF.
  const all = [...code.matchAll(TOKEN)].map((m) => ({ t: m[0] === 'FUNC' ? 'DEF' : m[0], off: m.index }));
  const isName = (t) => /^[a-z_][a-z0-9_]*$/.test(t || '');
  // NUMBER score = 0: the type is noted (by where the name is) and the rest reads as usual.
  const typedAt = new Map();
  const toks = all.filter((tk, i) => {
    if (!TYPE_WORDS.has(tk.t) || !isName(all[i + 1]?.t)) return true;
    typedAt.set(all[i + 1].off, tk.t === 'STRING' ? 'TEXT' : tk.t);
    return false;
  });

  const funcs = [];
  const points = new Map();
  const gotos = [];
  const defined = new Set();
  const definedAt = new Map();
  const uses = [];
  // Where names live, following .jlb's rules:
  //   globals   given a value outside any function (or DEF names), with the first place
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
  // Comments at the end of the line where a name (notes) or a table entry (entryNotes,
  // "table.name") is given a value, shown when hovering it: { ref, doc, kind, line }.
  const notes = [];
  const entryNotes = new Map();
  const note = (off, kind) => {
    const doc = lineComment(text, noComments, off);
    if (doc) notes.push({ ref: refs.at(-1), doc, kind, line: where(off).line });
  };
  const entryNote = (owner, name, off, kind) => {
    const key = owner + '.' + name;
    if (entryNotes.has(key)) return;
    const doc = lineComment(text, noComments, off);
    if (doc) entryNotes.set(key, { doc, kind, line: where(off).line });
  };
  let constNext = false;
  // How many "name:" entries each line has (worked out once, the first time it's needed).
  let perLine = null;
  const namedPerLine = () => {
    if (!perLine) {
      perLine = new Map();
      for (let q = 0; q + 1 < toks.length; q++) {
        if (toks[q + 1].t === ':' && isName(toks[q].t)) {
          const ln = where(toks[q].off).line;
          perLine.set(ln, (perLine.get(ln) || 0) + 1);
        }
      }
    }
    return perLine;
  };
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
  // Whether the name at toks[k] is a whole statement by itself (after GLOBAL, if `global`).
  const gapBreaks = (a, b) => /\n/.test(code.slice(a, b));
  const aloneAt = (k, global) => {
    const first = global ? k - 1 : k;
    const before = toks[first - 1];
    const after = toks[k + 1];
    // After an operator, a comma or an open bracket, the statement carries on onto the next line.
    const continues = before && /^[^\w"']/.test(before.t) && ![')', ']'].includes(before.t);
    const startOk = !before || ['{', '}', ';'].includes(before.t) || (!continues && gapBreaks(before.off + before.t.length, toks[first].off));
    const endOk = !after || ['}', ';'].includes(after.t) || gapBreaks(toks[k].off + toks[k].t.length, after.off);
    return startOk && endOk;
  };
  const currentFunc = () => {
    for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].kind === 'func') return scopes[i].func;
    return -1;
  };
  // GLOBAL before a name, DEF or CONST: the next name made is an outside one.
  let globalNext = false;
  // Inside functions: names that become the function's own while an outside one has the
  // same name, and x += 1 on an outside x (an error without GLOBAL).
  const shadows = [];
  const outsideChanges = [];
  const giveValue = (name, off, global = false) => {
    define(name, off);
    if (blockOf(name) != null) return; // the FOR or FAIL name
    const f = currentFunc();
    if (f >= 0 && !global) {
      if (!funcs[f].declared.has(name)) shadows.push({ name, off, func: f });
      funcs[f].locals.add(name);
      funcs[f].declared.add(name);
    } else if (!globals.has(name)) globals.set(name, off);
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
    if (t === 'GLOBAL') {
      globalNext = true;
      continue;
    }
    if (t === 'DEF') {
      let j = k + 1;
      let name = null;
      const index = funcs.length;
      // GLOBAL DEF name or DEF GLOBAL name: a function the whole file can use.
      const global = globalNext || (toks[j]?.t === 'GLOBAL' && isName(toks[j + 1]?.t));
      if (toks[j]?.t === 'GLOBAL') j++;
      globalNext = false;
      const fn = { name, params: [], locals: new Set(), declared: new Set(), line: where(off).line, col: where(off).col, nameCol: null, inFunc: currentFunc(), global };
      funcs.push(fn);
      if (isName(toks[j]?.t)) {
        fn.name = name = toks[j].t;
        fn.nameCol = where(toks[j].off).col;
        // A named function is a value like any other: its function's own when made inside one.
        giveValue(name, toks[j].off, global);
        ref(name, toks[j].off, global ? { global } : undefined);
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
      // A comment as the first thing inside the function describes it.
      if (toks[j + 1]?.t === '{') fn.doc = commentAt(text, toks[j + 1].off + 1);
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
      consts.push({ name: next, off: toks[k + 1].off, func: globalNext ? -1 : currentFunc() });
      constNext = true;
      if (!globalNext && currentFunc() >= 0) funcs[currentFunc()].declared.add(next); // meant to be its own
      continue; // x = ... is read next, as usual (GLOBAL still applies to it)
    }
    if (t === 'LOCAL' && isName(next)) {
      if (currentFunc() >= 0) funcs[currentFunc()].declared.add(next);
      giveValue(next, toks[k + 1].off);
      ref(next, toks[k + 1].off);
      if (ASSIGN.has(toks[k + 2]?.t)) note(toks[k + 1].off, toks[k + 3]?.t === '[' ? 'table' : 'variable');
      k++;
      continue;
    }
    if (!isName(t)) continue;
    if (prev === '.') {
      // a table entry: t.name
      if (isName(toks[k - 2]?.t) && toks[k - 3]?.t !== '.') {
        addField(toks[k - 2].t, t);
        entries.push({ owner: toks[k - 2].t, name: t, off });
        if (ASSIGN.has(next)) entryNote(toks[k - 2].t, t, off, toks[k + 2]?.t === '[' ? 'table' : 'entry');
      }
      continue;
    }
    if (next === ':') continue; // a name in a table: [name: 1]
    const global = globalNext;
    globalNext = false;
    if (global) ref(t, off, { write: writeAt(k), global });
    else refAt(k);
    const isConst = constNext;
    constNext = false;
    if (ASSIGN.has(next)) {
      giveValue(t, off, global);
      note(off, isConst ? 'constant' : toks[k + 2]?.t === '[' ? 'table' : 'variable');
      // t = [name: 1, other: 2] names its entries.
      if (toks[k + 2]?.t === '[') {
        let d = 0;
        for (let j = k + 2; j < toks.length; j++) {
          const x = toks[j].t;
          if (x === '[' || x === '(' || x === '{') d++;
          else if (x === ']' || x === ')' || x === '}') {
            if (--d === 0) break;
          } else if (d === 1 && isName(x) && toks[j + 1]?.t === ':' && (toks[j - 1].t === '[' || toks[j - 1].t === ',')) {
            addField(t, x);
            // An entry with a comment at the end of its own line (in a table written over several lines).
            const ln = where(toks[j].off).line;
            if (namedPerLine().get(ln) === 1 && ln !== where(off).line) entryNote(t, x, toks[j].off, toks[j + 2]?.t === '[' ? 'table' : 'entry');
          }
        }
      }
      continue;
    }
    // A name on a line by itself makes that variable (NULL), unless it has a value already.
    if (aloneAt(k, global)) {
      giveValue(t, off, global);
      continue;
    }
    // x += 1 reads x first, so x needs a value already.
    uses.push({ name: t, off, ...where(off), func: currentFunc(), depth, blockNames: visibleBlockNames(), global });
    if (COMPOUND.has(next)) {
      const f = currentFunc();
      if (f >= 0 && !global && !funcs[f].declared.has(t) && blockOf(t) == null) outsideChanges.push({ name: t, off, op: next, func: f });
      else giveValue(t, off, global);
    }
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
    notes,
    entryNotes,
    typedAt,
    shadows,
    outsideChanges,
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
