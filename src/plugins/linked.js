// What a file gets from the files it brings in with IMPORT and LOAD, shared by the
// mistake checks, go to definition, hover info and suggestions.
//
// Follows the interpreter's rules: paths are relative to the importing file, IMPORT
// shares the importer's outside names (so the imported file's own IMPORTs count too),
// and LOAD gives a table named after the file holding that file's outside names.
// Open tabs are read with their unsaved changes; other files are read from disk and
// kept until they change.

import { scan, loadName } from './scan.js';
import { dirname, same, basename } from '../core/paths.js';

const files = new Map(); // key -> { path, text, info, stamp }
const results = new Map(); // key of a file -> its last linked() result

/** A path that compares equal however it was written (Windows paths ignore case). */
export function fileKey(p) {
  const s = String(p).replace(/\\/g, '/');
  return /^[a-z]:/i.test(s) ? s.toLowerCase() : s;
}

/** `rel` as written in `fromFile`, made into a full path with . and .. worked out. */
export function resolvePath(fromFile, rel) {
  const s = fromFile.includes('\\') ? '\\' : '/';
  const absolute = /^([a-z]:)?[\\/]/i.test(rel);
  const full = absolute ? rel : dirname(fromFile) + s + rel;
  const drive = full.match(/^[a-z]:/i)?.[0] || '';
  const parts = [];
  for (const part of full.slice(drive.length).split(/[\\/]+/)) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return drive + s + parts.join(s);
}

async function read(api, path) {
  const k = fileKey(path);
  const cached = files.get(k);
  const doc = api.workspace.files.find((d) => d.path && same(d.path, path));
  if (doc) {
    const text = api.workspace.textOf(doc);
    if (cached?.text === text) return cached;
    const entry = { path, text, info: scan(text), stamp: null };
    files.set(k, entry);
    return entry;
  }
  let st;
  try {
    st = await api.invoke('path_info', { path });
  } catch {
    return null;
  }
  if (!st.exists || st.is_dir) return null;
  if (cached && cached.stamp === st.modified) return cached;
  let text;
  try {
    text = (await api.invoke('read_text', { path })).replace(/\r\n/g, '\n');
  } catch {
    return null;
  }
  const entry = { path, text, info: scan(text), stamp: st.modified };
  files.set(k, entry);
  return entry;
}

/** One name a file defines outside its functions: { name, path, line, col, kind, params?, target? }. */
function ownNames(path, info) {
  const out = new Map();
  for (const [name, off] of info.globals) {
    const fn = info.funcs.find((f) => f.name === name && f.inFunc < 0);
    const at = fn ? { line: fn.line, col: fn.nameCol || fn.col } : info.at(off);
    out.set(name, { name, path, line: at.line, col: at.col, kind: fn ? 'func' : 'value', params: fn?.params });
  }
  return out;
}

/**
 * Every outside name a file has once it has run, including what its own IMPORTs
 * bring in and the tables its LOADs make. null when the file can't be read.
 */
async function exportsOf(api, path, seen, deps) {
  const k = fileKey(path);
  if (seen.has(k)) return new Map(); // already run: the interpreter runs a file once
  seen.add(k);
  deps.add(k);
  const f = await read(api, path);
  if (!f) return null;
  const out = new Map();
  for (const imp of f.info.imports) {
    const target = resolvePath(path, imp.file);
    if (imp.kind === 'IMPORT') {
      const sub = await exportsOf(api, target, seen, deps);
      if (sub) for (const [n, d] of sub) out.set(n, d);
    } else {
      const name = loadName(imp.file);
      out.set(name, { name, path, line: imp.line, col: imp.col, kind: 'load', target });
    }
  }
  for (const [n, d] of ownNames(path, f.info)) out.set(n, d);
  return out;
}

/**
 * What the file at `path` (with text `text`) gets from IMPORT and LOAD:
 *   names    name -> definition, plus `importOff`: where in this file the IMPORT that brings it in is
 *   loads    load name -> { path, names (null if unreadable), off }
 *   missing  the IMPORT/LOAD lines whose file can't be found, with the full path tried
 *   outer    names from open files that IMPORT this one (this file can use their outside names)
 *   deps     keys of every file read, to know when to check again
 */
export async function linked(api, path, text, info = scan(text)) {
  const deps = new Set();
  const names = new Map();
  const loads = new Map();
  const missing = [];
  const seen = new Set([fileKey(path)]);
  const addLoad = async (name, target, off, from) => {
    if (loads.has(name)) return;
    const ex = await exportsOf(api, target, new Set([fileKey(from)]), deps);
    loads.set(name, { path: target, names: ex, off });
    return ex;
  };
  for (const imp of info.imports) {
    const target = resolvePath(path, imp.file);
    if (imp.kind === 'IMPORT') {
      const ex = await exportsOf(api, target, seen, deps);
      if (!ex) {
        missing.push({ ...imp, path: target });
        continue;
      }
      for (const [n, d] of ex) {
        // The last import wins, but the name has a value from the first one on.
        names.set(n, { ...d, importOff: names.get(n)?.importOff ?? imp.off, importLine: names.get(n)?.importLine ?? imp.line });
        if (d.kind === 'load') await addLoad(n, d.target, imp.off, d.path);
      }
    } else {
      const name = loadName(imp.file);
      const ex = await addLoad(name, target, imp.off, path);
      if (ex === null) missing.push({ ...imp, path: target });
    }
  }

  // Files that IMPORT this one share their outside names with it.
  const outer = new Map();
  for (const doc of api.workspace.files) {
    if (!doc.path || same(doc.path, path)) continue;
    const f = await read(api, doc.path);
    if (!f || !f.info.imports.some((imp) => imp.kind === 'IMPORT' && same(resolvePath(doc.path, imp.file), path))) continue;
    deps.add(fileKey(doc.path));
    for (const [n, d] of ownNames(doc.path, f.info)) if (!outer.has(n)) outer.set(n, d);
  }

  const result = { names, loads, missing, outer, deps, path };
  results.set(fileKey(path), result);
  return result;
}

/** The last linked() result for a file, without waiting (null if it hasn't been worked out). */
export function peek(path) {
  return path ? results.get(fileKey(path)) || null : null;
}

/** Open files whose last result read `path`, so they need checking again when it changes. */
export function dependents(api, path) {
  const k = fileKey(path);
  return api.workspace.files.filter((d) => d.path && !same(d.path, path) && peek(d.path)?.deps.has(k));
}

/** Where a definition is, for messages: "helpers.jlb, line 3". */
export function describe(def) {
  return `${basename(def.path)}, line ${def.line}`;
}
