// Crash report viewer: when a program stops with an error, shows the message,
// the chain of function calls and every variable's value, and marks the line.

import { normalize } from '../core/paths.js';

export default {
  id: 'crash',
  name: 'Crash report viewer',
  description: 'When a program crashes, shows the error, the function calls and every variable in a panel, and marks the line in your code.',
  builtin: true,
  settings: [
    { key: 'autoShow', title: 'Open the Crash panel when a program crashes', type: 'boolean', default: true },
    { key: 'markLine', title: 'Mark the crashing line in the editor', type: 'boolean', default: true },
    { key: 'openFile', title: 'Open the file where the crash happened', description: 'Switches to the file with the error, even when it\'s a file brought in with IMPORT or LOAD.', type: 'boolean', default: true },
    { key: 'hoverValues', title: 'Show values from the crash when hovering a name', description: 'Rest the mouse on a variable to see what it held when the program crashed.', type: 'boolean', default: true },
  ],
  activate(api) {
    const { h, clear, icon } = api.ui;
    const { StateField, StateEffect } = api.cm.state;
    const { Decoration, EditorView, WidgetType } = api.cm.view;
    let last = null; // { report, doc }
    let panelEl = null;

    // ---------- the mark in the editor ----------
    const setMark = StateEffect.define();
    class Note extends WidgetType {
      constructor(msg) {
        super();
        this.msg = msg;
      }
      eq(o) {
        return o.msg === this.msg;
      }
      toDOM() {
        return h('span.crash-note', this.msg);
      }
    }
    const field = StateField.define({
      create: () => Decoration.none,
      update(deco, tr) {
        for (const e of tr.effects) if (e.is(setMark)) deco = e.value;
        // Editing the code means the old crash may no longer apply.
        return tr.docChanged ? Decoration.none : deco;
      },
      provide: (f) => EditorView.decorations.from(f),
    });
    api.editor.addExtension(field);

    const mark = () => {
      const view = api.editor.view;
      const doc = api.workspace.active;
      let deco = Decoration.none;
      if (last && !last.edited && api.settings.get('markLine') && sameFile(last, doc) && last.report.line <= view.state.doc.lines) {
        const line = view.state.doc.line(last.report.line);
        deco = Decoration.set([
          Decoration.line({ class: 'cm-crash-line' }).range(line.from),
          Decoration.widget({ widget: new Note(last.report.message), side: 1 }).range(line.to),
        ]);
      }
      view.dispatch({ effects: setMark.of(deco) });
    };
    // Where the crash happened: the program itself, or a file it brought in with IMPORT or LOAD.
    const norm = (p) => normalize(p || '').replace(/\\/g, '/').replace(/^([a-z]):/i, (m, d) => d.toLowerCase() + ':');
    const crashPath = (c) => c.report.path || (c.doc?.path ? c.doc.path.replace(/[^\\/]*$/, '') + c.report.file : null);
    const sameFile = (c, doc) => {
      if (!doc) return false;
      if (doc.path && crashPath(c)) return norm(doc.path) === norm(crashPath(c));
      return c.doc === doc && c.report.file === doc.name;
    };
    // Crash-time values make sense in the program and in the file that crashed.
    const inProgram = (c, doc) => sameFile(c, doc) || c.doc === doc;

    api.events.on('crash', ({ report, doc }) => {
      last = { report, doc };
      render();
      api.layout.setBadge('crash', '!', 'error');
      if (api.settings.get('autoShow')) api.layout.showPanel('crash', { focus: false });
      const where = crashPath(last);
      if (where && api.settings.get('openFile') && !sameFile(last, api.workspace.active)) {
        api.workspace.openFile(where).then(() => setTimeout(mark, 30));
      } else setTimeout(mark, 30);
    });
    api.events.on('run-start', () => {
      // The report stays readable, but its values no longer describe the running program.
      if (last) last.stale = true;
      api.layout.setBadge('crash', '');
      api.editor.view.dispatch({ effects: setMark.of(Decoration.none) });
    });
    api.events.on('active-change', () => setTimeout(mark));
    // Once the file that crashed is changed, the mark is gone for good (until the next crash).
    const edited = (doc) => {
      if (last && !last.edited && sameFile(last, doc)) last.edited = true;
    };
    api.events.on('editor-change', () => edited(api.workspace.active));
    api.events.on('doc-change', edited);
    api.settings.onChange('markLine', mark);
    api.onDispose(() => api.editor.view.dispatch({ effects: setMark.of(Decoration.none) }));

    const goTo = async (line, path = crashPath(last)) => {
      if (!last) return;
      if (path && norm(api.workspace.active?.path) !== norm(path)) await api.workspace.openFile(path);
      api.editor.goTo(line, 1, { select: true });
    };

    // Long values are folded to a few lines; click to see all of it, or copy it.
    const value = (text) => {
      const code = h('code', text);
      const cell = h('div.value-cell', code);
      if (text.length > 160 || text.includes('\n')) {
        cell.classList.add('folded');
        cell.append(h('div.value-tools',
          h('button.link', { on: { click: (e) => { cell.classList.toggle('folded'); e.target.textContent = cell.classList.contains('folded') ? 'Show all' : 'Show less'; } } }, 'Show all'),
          h('button.link', { on: { click: () => navigator.clipboard.writeText(text).then(() => api.ui.toast('Copied', { timeout: 1200 })) } }, 'Copy')));
      }
      return cell;
    };

    // A table's value opens in the table viewer, when it's switched on.
    const viewButton = (v) => {
      const tv = api.use('tableview');
      if (!tv) return null;
      return h('button.icon-btn.view-table', {
        title: 'Open in the table viewer',
        'aria-label': `Open ${v.name} in the table viewer`,
        on: { click: () => tv.open({ title: v.name, node: tv.parse(v.value, v.name) }) },
      }, icon('table', 13));
    };

    // ---------- the panel ----------
    let filter = '';
    const render = () => {
      if (!panelEl) return;
      clear(panelEl);
      if (!last) {
        panelEl.append(h('div.empty-note', h('p', 'No crashes. When a program stops with an error, the report shows up here: the line, the function calls, and every variable.')));
        return;
      }
      const r = last.report;
      const groups = [...r.frames.map((f) => ({ title: `${f.name}()`, vars: f.vars })), { title: 'Outside functions', vars: r.outside }];
      const search = h('input.input.crash-filter', { type: 'search', placeholder: 'Filter variables', value: filter, spellcheck: false, 'aria-label': 'Filter variables' });
      const tables = h('div.crash-vars');
      const fill = () => {
        clear(tables);
        const q = filter.toLowerCase();
        for (const g of groups) {
          const rows = g.vars.filter((v) => !q || v.name.includes(q) || v.value.toLowerCase().includes(q));
          tables.append(h('div.var-group',
            h('h4', g.title),
            rows.length
              ? h('table.var-table',
                h('thead', h('tr', h('th', 'Name'), h('th', 'Value'), h('th', 'Type'))),
                h('tbody', rows.map((v) => h('tr', h('td.var-name', v.name), h('td.var-value', value(v.value)), h('td.var-type', v.type, v.type === 'TABLE' ? viewButton(v) : null)))))
              : h('p.view-note', q ? 'No matches' : 'No variables')));
        }
      };
      search.addEventListener('input', () => {
        filter = search.value;
        fill();
      });
      fill();
      panelEl.append(
        h('div.crash-head',
          h('div.crash-msg', icon('alert', 18), h('span', r.message)),
          h('button.link.crash-where', { on: { click: () => goTo(r.line) } }, `${r.file}, line ${r.line}`)),
        r.frames.length ? h('div.crash-calls',
          h('h4', 'Function calls (innermost first)'),
          h('ol', r.frames.map((f) => h('li', h('button.link', { on: { click: () => goTo(f.line, f.path || crashPath(last)) } }, `${f.name}()`), h('span.muted', ` line ${f.line}${f.path && norm(f.path) !== norm(crashPath(last)) ? ' in ' + f.path.split(/[\\/]/).pop() : ''}`))))) : null,
        r.traced ? h('div.crash-vars-wrap', search, tables) : h('p.view-note', 'This is a syntax error, so the program never started and there are no variables to show.'),
      );
    };
    api.layout.addPanel({
      id: 'crash',
      title: 'Crash',
      order: 30,
      render: (el) => {
        panelEl = el;
        el.classList.add('crash');
        render();
      },
    });

    // ---------- values on hover ----------
    api.language.addHover(({ word, op }) => {
      if (!last || last.stale || !word || op || !api.settings.get('hoverValues') || !inProgram(last, api.workspace.active)) return null;
      if (!/^[a-z_][a-z0-9_]*$/.test(word.text)) return null;
      const r = last.report;
      for (const g of [...r.frames.map((f) => ({ where: `in ${f.name}()`, vars: f.vars })), { where: 'outside functions', vars: r.outside }]) {
        const v = g.vars.find((x) => x.name === word.text);
        if (v) return { title: `${v.name} = ${v.value}`, subtitle: `${v.type}, when the program crashed (${g.where})` };
      }
      return null;
    });

    api.commands.register({ id: 'crash.show', title: 'Show the last crash report', run: () => api.layout.showPanel('crash') });
  },
};
