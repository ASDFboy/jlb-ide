// Rename everywhere (F2): renames a name in every place it means the same thing.
// A function's own local or a FOR/FAIL name stays inside its function or block; an
// outside name is renamed in every file that shares it through IMPORT, and as
// tools.name in files that LOAD it. A POINT is renamed with its GOTOs.

import { scan, bindingOf, loadName } from './scan.js';
import { linked, resolvePath, fileKey } from './linked.js';
import { projectFiles, readAll, applyChanges } from './project.js';
import { same } from '../core/paths.js';

const NAME = /^[a-z_][a-z0-9_]*$/;

export default {
  id: 'rename',
  name: 'Rename everywhere',
  description: 'Press F2 on a name to rename it everywhere it\'s used: inside its function for local names, and across the files that share it through IMPORT and LOAD for outside names.',
  builtin: true,
  settings: [
    { key: 'otherFiles', title: 'Also rename in other files', description: 'Outside names are renamed in the files that IMPORT or LOAD them too, not just the file you\'re in.', type: 'boolean', default: true },
  ],
  activate(api) {
    const { prompt, confirm, toast } = api.ui;

    api.commands.register({
      id: 'rename.symbol',
      title: 'Rename everywhere',
      key: 'F2',
      category: 'Edit',
      // In the file list, F2 renames the file instead.
      enabled: () => !!api.workspace.active && !document.activeElement?.closest?.('.explorer'),
      run: () => rename(),
    });

    const rename = async () => {
      const doc = api.workspace.active;
      if (!doc) return;
      const view = api.editor.view;
      const pos = view.state.selection.main.head;
      let plan;
      try {
        plan = await planAt(api, doc, view.state.doc.toString(), pos);
      } catch (e) {
        console.error('[rename]', e);
        toast('Renaming failed. See the developer console for details.', { kind: 'error' });
        return;
      }
      if (plan.error) {
        toast(plan.error);
        return;
      }
      const to = await prompt(`Rename ${plan.name} to`, { value: plan.name, ok: 'Rename' });
      if (to === null || to === plan.name) return;
      const name = to.trim();
      if (!NAME.test(name)) {
        toast(`${name || 'That'} can't be a name. Names use lowercase letters, numbers and _, and don't start with a number (like ${suggest(name) || 'my_score'}).`, { kind: 'error', timeout: 6000 });
        return;
      }
      const files = plan.files.filter((f) => f.places.length);
      // Names already in use where the renamed one would go mix the two up.
      const clash = files.filter((f) => f.taken(name));
      if (clash.length) {
        const ok = await confirm(`${name} is already used in ${list(clash.map((f) => f.file.name))}.`, {
          detail: 'Renaming would make the two names one, which changes what the program does.',
          ok: 'Rename anyway',
          danger: true,
        });
        if (!ok) return;
      }
      const places = files.reduce((n, f) => n + f.places.length, 0);
      const changes = files.map((f) => ({ file: f.file, before: f.text, changes: f.places.map((p) => ({ from: p.off, to: p.off + plan.name.length, insert: name })) }));
      const what = `${places} place${places > 1 ? 's' : ''}`;
      // Just the file on screen: one edit, undone with Ctrl+Z.
      if (files.length === 1 && files[0].file.doc === doc) {
        if (api.workspace.textOf(doc) !== files[0].text) return toast('The file changed while renaming. Try again.');
        api.workspace.edit(doc, changes[0].changes.sort((a, b) => a.from - b.from));
        toast(`Renamed ${plan.name} to ${name} in ${what}.`, { kind: 'ok' });
        return;
      }
      const closed = files.filter((f) => !f.file.doc);
      const lines = files.slice(0, 10).map((f) => `${f.file.rel}: ${f.places.length} place${f.places.length > 1 ? 's' : ''}${f.file.doc ? '' : ' (not open)'}`);
      if (files.length > 10) lines.push(`and ${files.length - 10} more files`);
      const ok = await confirm(`Rename ${plan.name} to ${name} in ${what} across ${files.length} files?`, {
        detail: `${lines.join('\n')}\n\n${closed.length ? 'Open files are changed but not saved; the files that aren\'t open are saved straight away. ' : 'The files are changed but not saved. '}You can undo it from the message that appears.`,
        ok: 'Rename',
      });
      if (!ok) return;
      await applyChanges(api, changes, { message: `Renamed ${plan.name} to ${name} in ${what} across ${files.length} files.` });
    };
  },
};

/**
 * What renaming the name at `pos` changes: { name, files: [{ file, text, places: [{ off }], taken(name) }] },
 * or { error } saying why it can't be renamed.
 */
export async function planAt(api, doc, text, pos) {
  const info = scan(text);
  const at = (list, len) => list.find((r) => pos >= r.off && pos <= r.off + len(r));
  const here = { path: doc.path, name: doc.name, rel: doc.name, doc };
  const single = (places) => ({ files: [{ file: here, text, places, taken: (n) => takenIn(info, n) }] });

  const label = at(info.labels, (r) => r.name.length);
  if (label) return { name: label.name, ...single(info.labels.filter((l) => l.name === label.name)) };

  const link = doc.path ? await linked(api, doc.path, text, info) : null;
  const outside = new Set([...(link?.names.keys() || []), ...(link?.outer.keys() || [])]);
  const r = at(info.refs, (x) => x.name.length);
  if (r) {
    if ((info.loads.has(r.name) || link?.names.get(r.name)?.kind === 'load') && bindingOf(info, r, outside) === 'global') {
      return { error: `${r.name} is named after the file LOAD brings in. Rename that file to change it.` };
    }
    const binding = bindingOf(info, r, outside);
    if (binding !== 'global') {
      const places = info.refs.filter((x) => x.name === r.name && bindingOf(info, x, outside) === binding);
      // A function's local can also be reached from outside it as fn.name.
      const fn = binding.startsWith('func:') ? info.funcs[Number(binding.slice(5))] : null;
      if (fn?.name && fn.inFunc < 0) places.push(...info.entries.filter((e) => e.owner === fn.name && e.name === r.name));
      return { name: r.name, ...single(places) };
    }
    if (!doc.path || !api.settings.get('otherFiles')) {
      return { name: r.name, ...single(info.refs.filter((x) => x.name === r.name && bindingOf(info, x, new Set([r.name])) === 'global')) };
    }
    return { name: r.name, files: await everywhere(api, doc.path, r.name) };
  }

  const entry = at(info.entries, (e) => e.name.length);
  if (entry) {
    const def = link?.loads.get(entry.owner)?.names?.get(entry.name);
    if (def && !info.globals.has(entry.owner)) {
      if (!api.settings.get('otherFiles')) return { error: `${entry.name} is defined in another file. Turn on "Also rename in other files" in Settings to rename it.` };
      return { name: entry.name, files: await everywhere(api, def.path, entry.name) };
    }
    const idx = info.funcs.findIndex((f) => f.name === entry.owner && f.inFunc < 0);
    if (idx >= 0 && (info.funcs[idx].locals.has(entry.name) || info.funcs[idx].declared.has(entry.name))) {
      const places = info.refs.filter((x) => x.name === entry.name && bindingOf(info, x, outside) === 'func:' + idx);
      places.push(...info.entries.filter((e) => e.owner === entry.owner && e.name === entry.name));
      return { name: entry.name, ...single(places) };
    }
    return { error: `${entry.owner}.${entry.name} is an entry in a table, and only names can be renamed.` };
  }
  return { error: 'Put the cursor on a name to rename it.' };
}

/**
 * An outside name in every file that shares it: the files joined to `path` by IMPORT
 * (either way round) share their outside names, and files that LOAD one of them reach
 * it as tools.name.
 */
async function everywhere(api, path, name) {
  const { files } = await projectFiles(api);
  const index = new Map(); // key -> { file, text, info }
  const jlb = files.filter((f) => f.path && /\.jlb$/i.test(f.path));
  const texts = await readAll(api, jlb);
  const add = (file, text) => {
    if (text == null) return;
    index.set(fileKey(file.path), { file, text, info: scan(text) });
  };
  for (const f of jlb) add(f, texts.get(f));
  // Files outside the folder that are brought in count too.
  const fetch = async (p) => {
    if (index.has(fileKey(p))) return index.get(fileKey(p));
    const f = { path: p, name: p.split(/[\\/]/).pop(), rel: p, doc: api.workspace.files.find((d) => same(d.path, p)) || null, modified: 0 };
    const t = await readAll(api, [f]);
    add(f, t.get(f));
    return index.get(fileKey(p)) || null;
  };
  const start = await fetch(path);
  if (!start) return [];

  // Files joined by IMPORT, either way round.
  const targets = (e, kind) => e.info.imports.filter((i) => i.kind === kind).map((i) => resolvePath(e.file.path, i.file));
  const group = new Map([[fileKey(path), start]]);
  const queue = [start];
  while (queue.length) {
    const e = queue.shift();
    const next = [];
    for (const t of targets(e, 'IMPORT')) next.push(await fetch(t));
    for (const other of index.values()) if (targets(other, 'IMPORT').some((t) => same(t, e.file.path))) next.push(other);
    for (const n of next) {
      if (!n || group.has(fileKey(n.file.path))) continue;
      group.set(fileKey(n.file.path), n);
      queue.push(n);
    }
  }

  const out = new Map();
  const entry = (e) => {
    const k = fileKey(e.file.path);
    if (!out.has(k)) out.set(k, { file: e.file, text: e.text, places: [], taken: (n) => takenIn(e.info, n) });
    return out.get(k);
  };
  const shared = new Set([name]);
  for (const e of group.values()) {
    const places = e.info.refs.filter((r) => r.name === name && bindingOf(e.info, r, shared) === 'global');
    if (places.length) entry(e).places.push(...places);
  }
  // tools.name, in any file that LOADs one of them.
  for (const e of index.values()) {
    for (const imp of e.info.imports) {
      if (imp.kind !== 'LOAD' || !group.has(fileKey(resolvePath(e.file.path, imp.file)))) continue;
      const owner = loadName(imp.file);
      if (e.info.globals.has(owner)) continue; // the program gave that name another value
      const places = e.info.entries.filter((x) => x.owner === owner && x.name === name);
      if (places.length) entry(e).places.push(...places);
    }
  }
  // The file you're in first, then by name.
  return [...out.values()].sort((a, b) => (same(a.file.path, path) ? -1 : same(b.file.path, path) ? 1 : a.file.rel.localeCompare(b.file.rel)));
}

/** Whether a file already uses a name (anywhere, as any kind of name). */
function takenIn(info, name) {
  return info.refs.some((r) => r.name === name) || info.labels.some((l) => l.name === name) || info.loads.has(name);
}

function list(names) {
  const u = [...new Set(names)];
  return u.length > 3 ? `${u.slice(0, 3).join(', ')} and ${u.length - 3} more` : u.length > 1 ? `${u.slice(0, -1).join(', ')} and ${u.at(-1)}` : u[0];
}

/** myScore → my_score, for the message about a name that can't be used. */
function suggest(name) {
  const s = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^(\d)/, '_$1');
  return NAME.test(s) && s !== name ? s : '';
}
