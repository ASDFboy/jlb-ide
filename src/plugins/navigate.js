// Getting around: go to a definition (F12 or Ctrl+click), the Outline of
// functions and POINTs, and Go to line.

import { scan } from './scan.js';

export default {
  id: 'navigate',
  name: 'Navigation',
  description: 'Jump to where a function, POINT or variable is defined (F12 or Ctrl+click), and see an outline of the file\'s functions and POINTs.',
  builtin: true,
  settings: [
    { key: 'ctrlClick', title: 'Ctrl+click a name to go to its definition', type: 'boolean', default: true },
  ],
  activate(api) {
    const { h, clear, prompt, toast } = api.ui;
    const { EditorView } = api.cm.view;

    const definition = (state, pos) => {
      const { word, line } = api.language.context(state, pos);
      if (!word || !/^[a-z_][a-z0-9_]*$/.test(word.text)) return null;
      const info = scan(state.doc.toString());
      const before = line.text.slice(0, word.from - line.from);
      if (/\b(GOTO|POINT)\s+$/.test(before)) {
        const p = info.points.get(word.text);
        return p ? { line: p.line, col: p.col } : null;
      }
      const f = info.funcs.find((x) => x.name === word.text);
      if (f) return { line: f.line, col: f.nameCol || f.col };
      const d = info.definedAt.get(word.text);
      return d || null;
    };

    const goDef = (pos) => {
      const view = api.editor.view;
      const d = definition(view.state, pos ?? view.state.selection.main.head);
      if (d) api.editor.goTo(d.line, d.col);
      else toast('No definition found for that in this file.');
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
        el.append(h('div.empty-note', h('p', 'Open a file to see its functions and POINTs.')));
        return;
      }
      const info = scan(api.editor.text);
      const items = [
        ...info.funcs.filter((f) => f.name).map((f) => ({ kind: 'FUNC', label: `${f.name}(${f.params.join(', ')})`, line: f.line, col: f.nameCol || f.col })),
        ...[...info.points].map(([name, p]) => ({ kind: 'POINT', label: name, line: p.line, col: p.col })),
      ].sort((a, b) => a.line - b.line);
      if (!items.length) {
        el.append(h('div.empty-note', h('p', 'No functions or POINTs in this file yet.')));
        return;
      }
      el.append(h('ul.outline', items.map((it) => h('li', h(`button.outline-item.${it.kind.toLowerCase()}`, {
        on: { click: () => api.editor.goTo(it.line, it.col) },
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
