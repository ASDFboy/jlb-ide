// The files of the open folder, for Find in files and Rename everywhere: listing
// them, reading their text (open tabs with their unsaved changes), and changing
// several files at once with a way to undo it.

import { same, basename, relative } from '../core/paths.js';
import { fileKey } from './linked.js';

const disk = new Map(); // key -> { modified, text } (text is null for files that aren't text)

/**
 * The folder's files plus any open tab outside it:
 * [{ path, name, rel, doc (the open tab or null), modified }], and whether the list was cut short.
 */
export async function projectFiles(api, { limit } = {}) {
  const folder = api.workspace.folder;
  let listed = [];
  let truncated = false;
  if (folder) {
    try {
      const r = await api.invoke('list_files', { root: folder, limit });
      listed = r.files;
      truncated = r.truncated;
    } catch (e) {
      console.warn('[project] could not list the folder', e);
    }
  }
  const docs = api.workspace.files;
  const out = listed.map((f) => ({ path: f.path, modified: f.modified, size: f.size, doc: docs.find((d) => same(d.path, f.path)) || null }));
  // Open tabs that aren't in the folder (or aren't saved yet) count too.
  for (const d of docs) if (!d.path || !out.some((f) => f.doc === d)) out.push({ path: d.path, modified: 0, size: 0, doc: d });
  for (const f of out) {
    f.name = f.doc?.name || basename(f.path);
    f.rel = f.path ? relative(folder, f.path) : f.name;
  }
  return { files: out, truncated };
}

/** The text of each file (null when it isn't text, is too big, or can't be read). */
export async function readAll(api, files) {
  const texts = new Map();
  const need = [];
  for (const f of files) {
    if (f.doc) texts.set(f, api.workspace.textOf(f.doc));
    else {
      const c = disk.get(fileKey(f.path));
      if (c && c.modified === f.modified && f.modified) texts.set(f, c.text);
      else need.push(f);
    }
  }
  // A few hundred at a time keeps each call small.
  for (let i = 0; i < need.length; i += 200) {
    const part = need.slice(i, i + 200);
    let got;
    try {
      got = await api.invoke('read_texts', { paths: part.map((f) => f.path) });
    } catch {
      got = part.map(() => null);
    }
    part.forEach((f, k) => {
      const text = got[k] == null ? null : got[k].replace(/\r\n/g, '\n');
      disk.set(fileKey(f.path), { modified: f.modified, text });
      texts.set(f, text);
    });
  }
  return texts;
}

/**
 * Changes several files at once. Each change is { file, before, changes: [{ from, to, insert }] },
 * where `before` is the text the offsets are for. Open tabs are edited (not saved, and Ctrl+Z
 * works there); other files are saved straight away. Files that changed since `before`
 * are left alone. Shows a message with an Undo button; gives back { done, skipped }.
 */
export async function applyChanges(api, list, { message }) {
  const done = [];
  const skipped = [];
  for (const c of list) {
    const sorted = [...c.changes].sort((a, b) => a.from - b.from);
    const after = apply(c.before, sorted);
    const doc = c.file.doc && api.workspace.files.includes(c.file.doc) ? c.file.doc : api.workspace.files.find((d) => c.file.path && same(d.path, c.file.path));
    if (doc) {
      if (api.workspace.textOf(doc) !== c.before) {
        skipped.push(c.file);
        continue;
      }
      api.workspace.edit(doc, sorted);
      done.push({ file: c.file, doc, before: c.before, after });
    } else {
      try {
        const raw = await api.invoke('read_text', { path: c.file.path });
        if (raw.replace(/\r\n/g, '\n') !== c.before) {
          skipped.push(c.file);
          continue;
        }
        // Files saved with Windows line endings keep them.
        await api.invoke('write_text', { path: c.file.path, text: raw.includes('\r\n') ? after.replace(/\n/g, '\r\n') : after });
        disk.delete(fileKey(c.file.path));
        done.push({ file: c.file, doc: null, before: c.before, after });
      } catch (e) {
        console.warn('[project] could not change', c.file.path, e);
        skipped.push(c.file);
      }
    }
  }
  const { h, toast } = api.ui;
  const note = skipped.length ? ` ${skipped.length} file${skipped.length > 1 ? 's' : ''} changed meanwhile and ${skipped.length > 1 ? 'were' : 'was'} left alone: ${skipped.map((f) => f.name).join(', ')}.` : '';
  if (done.length) {
    let close = null;
    const undo = h('button.link.toast-action', {
      on: {
        click: async (e) => {
          e.stopPropagation();
          close?.();
          const back = await undoChanges(api, done);
          toast(back.skipped.length ? `Undone, except in ${back.skipped.map((f) => f.name).join(', ')}, which changed since.` : 'Undone.', { kind: back.skipped.length ? 'error' : 'info' });
        },
      },
    }, 'Undo');
    close = toast(h('span', message + note + ' ', undo), { timeout: 12000 });
  } else if (skipped.length) toast(`Nothing was changed.${note}`, { kind: 'error' });
  return { done, skipped };
}

async function undoChanges(api, done) {
  const skipped = [];
  for (const d of done) {
    const doc = d.doc && api.workspace.files.includes(d.doc) ? d.doc : api.workspace.files.find((x) => d.file.path && same(x.path, d.file.path));
    if (doc) {
      if (api.workspace.textOf(doc) === d.after) api.workspace.setText(doc, d.before);
      else skipped.push(d.file);
      continue;
    }
    try {
      const raw = await api.invoke('read_text', { path: d.file.path });
      if (raw.replace(/\r\n/g, '\n') !== d.after) {
        skipped.push(d.file);
        continue;
      }
      await api.invoke('write_text', { path: d.file.path, text: raw.includes('\r\n') ? d.before.replace(/\n/g, '\r\n') : d.before });
      disk.delete(fileKey(d.file.path));
    } catch {
      skipped.push(d.file);
    }
  }
  return { skipped };
}

/** Applies sorted, non-overlapping { from, to, insert } changes to text. */
export function apply(text, changes) {
  let out = '';
  let at = 0;
  for (const c of changes) {
    out += text.slice(at, c.from) + c.insert;
    at = c.to;
  }
  return out + text.slice(at);
}

