// Getting around: go to a definition (F12 or Ctrl+click), also in files brought in
// with IMPORT and LOAD; the Outline of functions, POINTs and imports; and Go to line.

import { scan, loadName } from './scan.js';
import { linked, peek, resolvePath } from './linked.js';
import { same } from '../core/paths.js';

export default {
  id: 'navigate',
  name: 'Navigation',
  description: 'Jump to where a function, POINT or variable is defined (F12 or Ctrl+click), even in files brought in with IMPORT or LOAD, and see an outline of the file\'s functions, POINTs and imports.',
  builtin: true,
  settings: [
    { key: 'ctrlClick', title: 'Ctrl+click a name to go to its definition', type: 'boolean', default: true },
  ],
  activate(api) {
    const { h, clear, prompt, toast } = api.ui;
    const { EditorView } = api.cm.view;

    // Where the name at `pos` is defined: { line, col } in this file, or { path, line, col }
    // in a file brought in with IMPORT or LOAD. `link` is what those files give (see linked.js).
    const definition = (state, pos, link = peek(api.workspace.active?.path)) => {
      const info = scan(state.doc.toString());
      const line = state.doc.lineAt(pos);
      // On the file name of an IMPORT or LOAD: that file.
      const imp = info.imports.find((i) => i.line === line.number && pos - line.from >= i.col - 1 && pos - line.from < i.endCol - 1);
      if (imp) {
        const from = api.workspace.active?.path;
        return from ? { path: resolvePath(from, imp.file), line: 1, col: 1 } : null;
      }
      const { word } = api.language.context(state, pos);
      if (!word || !/^[a-z_][a-z0-9_]*$/.test(word.text)) return null;
      const before = line.text.slice(0, word.from - line.from);
      if (/\b(GOTO|POINT)\s+$/.test(before)) {
        const p = info.points.get(word.text);
        return p ? { line: p.line, col: p.col } : null;
      }
      // tool.name, where tool is a table made by LOAD.
      const owner = before.match(/(?<![\w.])([a-z_][a-z0-9_]*)\s*\.\s*$/)?.[1];
      if (owner) {
        const d = link?.loads.get(owner)?.names?.get(word.text);
        return d ? { path: d.path, line: d.line, col: d.col } : null;
      }
      const f = info.funcs.find((x) => x.name === word.text);
      if (f) return { line: f.line, col: f.nameCol || f.col };
      const d = info.definedAt.get(word.text) || link?.names.get(word.text) || link?.outer.get(word.text);
      return d ? { path: d.path, line: d.line, col: d.col } : null;
    };

    const goDef = async (pos) => {
      const view = api.editor.view;
      const doc = api.workspace.active;
      const state = view.state;
      pos ??= state.selection.main.head;
      let d = definition(state, pos);
      if (!d && doc?.path && scan(state.doc.toString()).imports.length) {
        // Not worked out yet: follow the IMPORTs and LOADs now.
        d = definition(state, pos, await linked(api, doc.path, state.doc.toString()));
      }
      if (!d) {
        toast(doc?.path && /\b(IMPORT|LOAD)\b/.test(state.doc.toString()) ? 'No definition found for that in this file or the files it brings in.' : 'No definition found for that in this file.');
        return;
      }
      if (d.path && !(doc?.path && same(d.path, doc.path))) {
        const exists = (await api.invoke('path_info', { path: d.path }).catch(() => null))?.exists;
        if (!exists && !api.workspace.files.some((x) => same(x.path, d.path))) {
          toast(`Can't find ${d.path}.`, { kind: 'error' });
          return;
        }
        if (!(await api.workspace.openFile(d.path))) return;
      }
      api.editor.goTo(d.line, d.col);
    };

    api.commands.register({ id: 'navigate.definition', title: 'Go to definition', key: 'F12', run: () => goDef() });
    api.commands.register({
      id: 'navigate.line',
      title: 'Go to line',
      key: 'Ctrl+G',
      run: async () => {
        const v = await prompt('Go to line', { placeholder: 'Line number', ok: 'Go' });
        const n = parseInt(v, 10);
        if (n > 0) api.editor.goTo(n);
      },
    });

    api.editor.addExtension(EditorView.domEventHandlers({
      mousedown(e, view) {
        if (!(e.ctrlKey || e.metaKey) || e.button !== 0 || !api.settings.get('ctrlClick')) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos === null || !definition(view.state, pos)) return false;
        e.preventDefault();
        goDef(pos);
        return true;
      },
    }));

    // ---------- the Outline view ----------
    let el = null;
    let timer = null;
    const render = () => {
      if (!el) return;
      clear(el);
      const doc = api.workspace.active;
      if (!doc) {
        el.append(h('div.empty-note', h('p', 'Open a file to see its functions, POINTs and imports.')));
        return;
      }
      const info = scan(api.editor.text);
      const missing = new Set((peek(doc.path)?.missing || []).map((m) => m.off));
      if (doc.path && info.imports.length) {
        // Make sure the files are looked for, then show again if that changes anything.
        const shown = [...missing].join();
        linked(api, doc.path, api.editor.text, info).then((r) => {
          if (api.workspace.active === doc && r.missing.map((m) => m.off).join() !== shown) render();
        }).catch(() => {});
      }
      const items = [
        ...info.imports.map((imp) => ({
          kind: imp.kind,
          label: imp.kind === 'LOAD' ? `${imp.file} → ${loadName(imp.file)}` : imp.file,
          line: imp.line,
          col: imp.col,
          missing: missing.has(imp.off),
          // Clicking opens the file it brings in.
          open: doc.path && !missing.has(imp.off) ? resolvePath(doc.path, imp.file) : null,
        })),
        ...info.funcs.filter((f) => f.name).map((f) => ({ kind: 'FUNC', label: `${f.name}(${f.params.join(', ')})`, line: f.line, col: f.nameCol || f.col })),
        ...[...info.points].map(([name, p]) => ({ kind: 'POINT', label: name, line: p.line, col: p.col })),
      ].sort((a, b) => a.line - b.line);
      if (!items.length) {
        el.append(h('div.empty-note', h('p', 'No functions, POINTs or imports in this file yet.')));
        return;
      }
      el.append(h('ul.outline', items.map((it) => h('li', h(`button.outline-item.${it.kind.toLowerCase()}${it.missing ? '.missing' : ''}`, {
        title: it.missing ? 'Can\'t find this file' : it.open ? `Open ${it.open}` : undefined,
        on: { click: () => (it.open ? api.workspace.openFile(it.open) : api.editor.goTo(it.line, it.col)) },
      }, h('span.outline-kind', it.kind), h('span.outline-label', it.label), h('span.outline-line', String(it.line)))))));
    };
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(render, 300);
    };
    api.events.on('editor-change', later);
    api.events.on('active-change', later);
    api.layout.addView({
      id: 'outline',
      title: 'Outline',
      icon: 'list',
      order: 20,
      render: (e) => {
        el = e;
        el.classList.add('outline-view');
        render();
      },
      onShow: render,
    });
    api.onDispose(() => clearTimeout(timer));
  },
};
