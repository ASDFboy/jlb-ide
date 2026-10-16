// Live mistake checking: the interpreter's own syntax check, plus warnings for
// the .jlb quirks that trip people up.

import { scan, loadName, bindingOf } from './scan.js';
import { askedInterpreter } from '../lang/data.js';
import { linked, dependents, forgetLooked } from './linked.js';
import { basename } from '../core/paths.js';

export default {
  id: 'checker',
  name: 'Live mistake checking',
  description: 'Underlines mistakes as you type, using the interpreter\'s own syntax check plus warnings for common .jlb slip-ups.',
  builtin: true,
  settings: [
    { key: 'syntax', title: 'Check syntax with the interpreter', description: 'The same check that runs before a program starts.', type: 'boolean', default: true },
    { key: 'andOr', title: 'Warn when && or || would crash', description: 'In .jlb, & and | stop early but && and || always check both sides, so x !== NULL && x.hp crashes when x is NULL.', type: 'boolean', default: true },
    { key: 'textCompare', title: 'Note when text is compared with < or >', description: 'Text against text compares lengths, not alphabetical order.', type: 'boolean', default: true },
    { key: 'undefined', title: 'Warn about names that are never given a value', description: 'Catches typos like PRINT(scroe). Names from files brought in with IMPORT and LOAD count too.', type: 'boolean', default: true },
    { key: 'imports', title: 'Warn when IMPORT or LOAD can\'t find its file', description: 'Also catches tool.nmae typos for tables made by LOAD.', type: 'boolean', default: true },
    { key: 'gotoPoint', title: 'Warn about GOTO with no matching POINT', type: 'boolean', default: true },
    { key: 'scope', title: 'Point out names a function makes its own', description: 'Inside a function, a name given a value is the function\'s own unless GLOBAL comes first. This notes when an outside name has the same name, and warns when x += 1 tries to change an outside x.', type: 'boolean', default: true },
    { key: 'constants', title: 'Warn when a constant (CONST) is changed', description: 'Changing a constant, or the tables inside it, is an error when the program runs.', type: 'boolean', default: true },
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
      async check({ text, path }) {
        const out = [];
        const info = scan(text);
        if (api.settings.get('andOr')) out.push(...andOrCrashes(info));
        if (api.settings.get('textCompare')) out.push(...textCompares(info));
        if (api.settings.get('gotoPoint')) out.push(...gotoPoints(info));
        if (api.settings.get('constants')) out.push(...constChanges(info));
        out.push(...interpreterLine(text));
        const wantNames = api.settings.get('undefined');
        const wantImports = api.settings.get('imports');
        if (!wantNames && !wantImports && !api.settings.get('scope')) return out;
        // Files brought in are found next to this one, so an unsaved new file can't follow them.
        const link = path ? await linked(api, path, text, info) : null;
        if (wantImports) out.push(...importProblems(info, link));
        // Every IMPORT has to be followed to know which names exist.
        const imports = info.imports.filter((i) => i.kind === 'IMPORT').length;
        const followed = imports === (info.codeLines.join('\n').match(/\bIMPORT\b/g) || []).length;
        const canFollow = imports === 0 || (link && followed && !link.missing.some((m) => m.kind === 'IMPORT'));
        if (wantNames && canFollow) out.push(...undefinedNames(info, link));
        if (api.settings.get('scope') && canFollow) out.push(...functionScope(info, link));
        return out;
      },
    });

    // A change to a file that others bring in changes what those files can use.
    let timer = null;
    const changed = (doc) => {
      if (!doc?.path) return;
      clearTimeout(timer);
      timer = setTimeout(() => dependents(api, doc.path).forEach((d) => api.language.recheck(d)), 500);
    };
    api.events.on('editor-change', () => changed(api.workspace.active));
    api.events.on('file-save', (doc) => {
      forgetLooked();
      changed(doc);
    });
    api.onDispose(() => clearTimeout(timer));
  },
};

/** Changes to a CONST name, or to the tables inside it (errors when the program runs). */
function constChanges(info) {
  const out = [];
  if (!info.consts.length) return out;
  const declAt = new Set(info.consts.map((c) => c.off));
  const decls = new Map(); // where the name lives + name -> its CONST
  const key = (r) => bindingOf(info, r) + '\0' + r.name;
  for (const r of info.refs) {
    if (!declAt.has(r.off)) continue;
    const at = info.at(r.off);
    const span = { line: at.line, col: at.col, endCol: at.col + r.name.length, severity: 'warning' };
    const c = decls.get(key(r));
    if (c) out.push({ ...span, message: `${r.name} is already a constant (CONST on line ${c.line}), so this CONST will be an error. CONST makes a new name.` });
    else decls.set(key(r), { ...r, line: at.line });
  }
  for (const r of info.refs) {
    if (!r.write || declAt.has(r.off)) continue;
    const c = decls.get(key(r));
    if (!c) continue;
    const at = info.at(r.off);
    const span = { line: at.line, col: at.col, endCol: at.col + r.name.length, severity: 'warning' };
    if (r.off < c.off && r.func === c.func) {
      out.push({ ...span, message: `${r.name} gets a value here, before CONST ${r.name} on line ${c.line}, so that CONST will be an error: CONST makes a new name.` });
    } else {
      const what = r.write === 'entry' ? `${r.name} is a constant (CONST on line ${c.line}), so the tables inside it can't be changed either.` : `${r.name} is a constant (CONST on line ${c.line}), so it can't be changed.`;
      out.push({ ...span, message: `${what} Copy it into another name to change the copy.` });
    }
  }
  return out;
}

/** >> @interpreter on the first line: a name the interpreters know, and only on line 1. */
function interpreterLine(text) {
  const out = [];
  const asked = askedInterpreter(text);
  const all = String(text).replace(/\r/g, '').split('\n');
  const first = all[0];
  const col = first.indexOf('@') + 1;
  if (asked != null && asked !== 'rust' && asked !== 'c') {
    out.push({ line: 1, col, endCol: first.length + 1, severity: 'error', message: `There's no interpreter called "${asked}". Use >> @interpreter rust or >> @interpreter c.` });
  } else if (asked == null && /^﻿?\s*>>\s*@interpreter/i.test(first) && !first.trim().startsWith('>>>')) {
    out.push({ line: 1, col, endCol: first.length + 1, severity: 'warning', message: 'This isn\'t read as an interpreter line, so it\'s just a comment. Write it as >> @interpreter rust or >> @interpreter c.' });
  }
  for (let i = 1; i < all.length && i < 5000; i++) {
    const m = all[i].match(/^\s*>>\s*@interpreter\s/);
    if (m) out.push({ line: i + 1, col: all[i].indexOf('@') + 1, endCol: all[i].length + 1, severity: 'warning', message: 'Only the first line can choose the interpreter, so this is just a comment. Move it to line 1.' });
  }
  return out;
}

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
function undefinedNames({ uses, defined, globals: own, funcs, loads, gotos, points, lineAt, imports }, link) {
  const out = [];
  const seen = new Set();
  const jumps = gotos.length > 0 || points.size > 0; // GOTO can run lines out of order
  const ownerOf = (name) => funcs.find((f) => f.locals.has(name) || paramNames(f).includes(name));
  // Names from IMPORT have a value from the IMPORT line on, like any other outside name.
  const globals = new Map(own);
  const imported = link?.names || new Map();
  for (const [n, d] of imported) if (!(globals.get(n) <= d.importOff)) globals.set(n, d.importOff);
  const outer = link?.outer || new Map();
  const where = imports.length ? 'in this file or the files it brings in' : 'in this file';
  for (const u of uses) {
    const key = u.line + ':' + u.name;
    if (seen.has(key)) continue;
    const fn = u.func >= 0 ? funcs[u.func] : null;
    const visible = u.blockNames.has(u.name) || globals.has(u.name) || loads.has(u.name) || outer.has(u.name)
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
      const close = [...visibleNames(u, fn, globals, loads, outer)].filter((d) => near(d, u.name)).slice(0, 2);
      out.push({
        line: u.line, col: u.col, endCol: u.col + u.name.length, severity: 'warning',
        message: `${u.name} is never given a value ${where}${close.length ? `. Did you mean ${close.join(' or ')}?` : '.'}`,
        fix: close.length ? close.map((c) => ({ label: `Change to ${c}`, text: c })) : undefined,
      });
      continue;
    }
    // Top-level code runs in order, so a value given further down isn't there yet.
    if (!fn && !jumps && u.depth === 0 && !u.blockNames.has(u.name) && !loads.has(u.name) && !outer.has(u.name) && globals.get(u.name) >= u.off) {
      seen.add(key);
      const at = lineAt(globals.get(u.name));
      const fromImport = imported.has(u.name) && globals.get(u.name) === imported.get(u.name).importOff;
      const isFunc = fromImport ? imported.get(u.name).kind === 'func' : funcs.some((f) => f.name === u.name && (f.inFunc < 0 || f.global));
      out.push({
        line: u.line, col: u.col, endCol: u.col + u.name.length, severity: 'warning',
        message: fromImport
          ? `${u.name}${isFunc ? '()' : ''} comes from the IMPORT on line ${at}, which hasn't run yet here. Move the IMPORT above this line.`
          : isFunc
            ? `${u.name}() is used before its DEF line has run (line ${at}). Move the DEF above this line.`
            : globals.get(u.name) === u.off
              ? `${u.name} has no value yet, so it can't be changed here. Give it a starting value first, like ${u.name} = 0.`
              : `${u.name} is used before it's given a value (line ${at} gives it one).`,
      });
    }
  }
  return out;
}

// Inside a function, a name given a value is its own unless GLOBAL comes first: note
// when that hides an outside name, and warn about x += 1 on an outside x (an error).
function functionScope({ shadows, outsideChanges, globals, loads, funcs, at }, link) {
  const out = [];
  const outside = (n) => globals.has(n) || loads.has(n) || link?.names.has(n) || link?.outer.has(n);
  const fname = (f) => (funcs[f].name ? `${funcs[f].name}()` : 'this function');
  const span = (n, off) => {
    const p = at(off);
    return { line: p.line, col: p.col, endCol: p.col + n.length };
  };
  for (const c of outsideChanges) {
    if (!outside(c.name)) continue;
    out.push({
      ...span(c.name, c.off), severity: 'warning',
      message: `${c.name} isn't one of ${fname(c.func)}'s own variables, so ${c.name} ${c.op} can't change it. To change the outside ${c.name}, write GLOBAL ${c.name} ${c.op} ...`,
      fix: { label: `Change to GLOBAL ${c.name}`, text: `GLOBAL ${c.name}` },
    });
  }
  for (const s of shadows) {
    if (!outside(s.name)) continue;
    out.push({
      ...span(s.name, s.off), severity: 'info',
      message: `This ${s.name} is ${fname(s.func)}'s own, separate from the outside ${s.name}. To change the outside one, write GLOBAL ${s.name}; to keep it separate on purpose, LOCAL ${s.name} says so.`,
      fix: { label: `Change to GLOBAL ${s.name}`, text: `GLOBAL ${s.name}` },
    });
  }
  return out;
}

// IMPORT and LOAD files that aren't there, LOAD names that can't be made, and
// tool.name for a LOAD table that has no such name.
function importProblems(info, link) {
  const out = [];
  for (const imp of info.imports) {
    const span = { line: imp.line, col: imp.col, endCol: imp.endCol };
    if (imp.kind === 'LOAD' && !/^[a-z_][a-z0-9_]*$/.test(loadName(imp.file))) {
      out.push({ ...span, severity: 'warning', message: `LOAD names its table after the file, and "${loadName(imp.file)}" can't be a name. Rename the file to use only letters, numbers, _ and -, starting with a letter.` });
    }
    const miss = link?.missing.find((m) => m.off === imp.off);
    if (miss) {
      out.push({ ...span, severity: 'warning', message: `Can't find ${imp.file}: there's no ${miss.path}. ${imp.kind} paths start from this file's folder.` });
    }
  }
  if (!link) return out;
  const code = info.codeLines.join('\n');
  info.codeLines.forEach((line, i) => {
    for (const m of line.matchAll(/(?<![\w.])([a-z_][a-z0-9_]*)\s*\.\s*([a-z_][a-z0-9_]*)/g)) {
      const load = link.loads.get(m[1]);
      if (!load?.names || load.names.has(m[2]) || info.globals.has(m[1]) || (!info.loads.has(m[1]) && !link.names.has(m[1]))) continue;
      // The program can add its own entries to the table.
      if (new RegExp(`\\b${m[1]}\\s*\\.\\s*${m[2]}\\s*(=|@=|[-+*/^%]=)(?!=)`).test(code)) continue;
      const col = m.index + m[0].length - m[2].length + 1;
      const close = [...load.names.keys()].filter((n) => near(n, m[2])).slice(0, 2);
      out.push({
        line: i + 1, col, endCol: col + m[2].length, severity: 'warning',
        message: `${basename(load.path)} has no ${m[2]}, so ${m[1]}.${m[2]} is NULL${close.length ? `. Did you mean ${close.join(' or ')}?` : '.'}`,
        fix: close.length ? close.map((c) => ({ label: `Change to ${c}`, text: c })) : undefined,
      });
    }
  });
  return out;
}

const paramNames = (f) => f.params.map((p) => p.replace(/^(@|\.\.\.)/, ''));

function visibleNames(u, fn, globals, loads, outer) {
  const names = new Set([...u.blockNames, ...globals.keys(), ...loads, ...outer.keys()]);
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
