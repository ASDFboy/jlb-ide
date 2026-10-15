// Quick-try: type a bit of .jlb and see the result and its TYPE right away.
// Variables are kept between snippets until you reset.

import { EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { jlb, jlbHighlight } from '../lang/jlb.js';

export default {
  id: 'quicktry',
  name: 'Quick-try console',
  description: 'A panel where you type a bit of .jlb and instantly see the result and its type, like "25" * 2 giving "2525" (TEXT).',
  builtin: true,
  settings: [
    { key: 'showTypes', title: 'Show each result\'s type', type: 'boolean', default: true },
    { key: 'keepHistory', title: 'Remember what you typed between sessions', description: 'Press ↑ in the input to bring back earlier snippets.', type: 'boolean', default: true },
    { key: 'history', type: 'text', default: '[]', hidden: true },
  ],
  activate(api) {
    const { h, clear, icon } = api.ui;
    let log = null;
    let input = null;
    let busy = false;
    let past = [];
    let back = -1;
    try {
      past = api.settings.get('keepHistory') ? JSON.parse(api.settings.get('history') || '[]') : [];
    } catch {
      past = [];
    }

    const interpreter = () => {
      const it = api.run.current;
      return it?.path ? it : api.run.resolve('rust');
    };

    const add = (el) => {
      log.querySelector('.qt-empty')?.remove();
      log.append(el);
      log.scrollTop = log.scrollHeight;
    };

    const run = async (code) => {
      code = code.replace(/\s+$/, '');
      if (!code.trim() || busy) return;
      const it = interpreter();
      if (!it?.path) {
        add(h('div.qt-entry.err', h('div.qt-result', 'No interpreter is set up. Choose one in Settings → Interpreters.')));
        return;
      }
      busy = true;
      past = [code, ...past.filter((p) => p !== code)].slice(0, 50);
      if (api.settings.get('keepHistory')) api.settings.set('history', JSON.stringify(past));
      back = -1;
      const entry = h('div.qt-entry', h('pre.qt-code', code), h('div.qt-result.pending', 'Running…'));
      add(entry);
      try {
        const r = await api.invoke('repl_eval', { interpreter: it.path, cwd: api.workspace.folder || '', code });
        const reply = JSON.parse(r.reply);
        const res = entry.querySelector('.qt-result');
        res.classList.remove('pending');
        if (r.output) entry.insertBefore(h('pre.qt-output', r.output.replace(/\n$/, '')), res);
        if (!reply.ok) {
          entry.classList.add('err');
          res.textContent = reply.error.message + (reply.error.traced && reply.error.line > 1 ? ` (line ${reply.error.line})` : '');
        } else if ('value' in reply) {
          clear(res).append(h('code.qt-value', reply.value), api.settings.get('showTypes') ? h('span.qt-type', reply.type) : null);
        } else if (reply.ended) {
          res.textContent = 'END stopped the session; variables were cleared.';
          api.invoke('repl_reset');
        } else {
          res.remove();
          if (!r.output) entry.classList.add('done');
        }
      } catch (e) {
        entry.classList.add('err');
        entry.querySelector('.qt-result').textContent = String(e);
      }
      busy = false;
      log.scrollTop = log.scrollHeight;
    };

    const reset = async () => {
      await api.invoke('repl_reset');
      add(h('div.qt-note', 'Variables cleared'));
    };

    const setInput = (text) => input.dispatch({ changes: { from: 0, to: input.state.doc.length, insert: text }, selection: { anchor: text.length } });

    api.layout.addPanel({
      id: 'quicktry',
      title: 'Quick-try',
      order: 40,
      actions: [
        { icon: 'refresh', title: 'Clear variables', run: reset },
        { icon: 'trash', title: 'Clear the list', run: () => { clear(log); empty(); } },
      ],
      render(el) {
        el.classList.add('quicktry');
        log = h('div.qt-log', { role: 'log' });
        const box = h('div.qt-input');
        el.append(log, h('div.qt-bar', h('span.qt-caret', '›'), box,
          h('button.btn.small', { title: 'Run (Enter)', on: { click: () => { run(input.state.doc.toString()); setInput(''); } } }, icon('play', 12), 'Run')));
        input = new EditorView({
          parent: box,
          state: EditorState.create({
            extensions: [
              history(),
              jlb(),
              jlbHighlight,
              placeholder('Type .jlb here, like "25" * 2, then press Enter'),
              keymap.of([
                { key: 'Enter', run: (v) => { run(v.state.doc.toString()); setInput(''); return true; } },
                { key: 'Shift-Enter', run: (v) => { v.dispatch(v.state.replaceSelection('\n')); return true; } },
                {
                  key: 'ArrowUp',
                  run: (v) => {
                    if (v.state.doc.lineAt(v.state.selection.main.head).number !== 1 || !past.length) return false;
                    back = Math.min(back + 1, past.length - 1);
                    setInput(past[back]);
                    return true;
                  },
                },
                {
                  key: 'ArrowDown',
                  run: (v) => {
                    if (v.state.doc.lineAt(v.state.selection.main.head).number !== v.state.doc.lines || back < 0) return false;
                    back -= 1;
                    setInput(back >= 0 ? past[back] : '');
                    return true;
                  },
                },
                ...historyKeymap,
                ...defaultKeymap,
              ]),
              EditorView.theme({ '&': { maxHeight: '8em' }, '.cm-scroller': { overflow: 'auto' } }),
            ],
          }),
        });
        empty();
      },
      onShow({ focus }) {
        if (focus) input?.focus();
      },
    });

    const empty = () => {
      if (!log.childNodes.length) {
        log.append(h('div.qt-empty',
          h('p', 'Try a bit of .jlb and see the result and its type.'),
          h('p.muted', 'Variables stay between snippets, so you can build things up step by step. Select code in the editor and press Ctrl+Enter to try it here.')));
      }
    };

    api.commands.register({
      id: 'quicktry.focus',
      title: 'Open Quick-try',
      key: 'Ctrl+Shift+Q',
      run: () => api.layout.showPanel('quicktry'),
    });
    api.commands.register({
      id: 'quicktry.selection',
      title: 'Try the selection (or this line) in Quick-try',
      key: 'Ctrl+Enter',
      run: () => {
        const view = api.editor.view;
        const sel = view.state.selection.main;
        const code = sel.empty ? view.state.doc.lineAt(sel.head).text : view.state.sliceDoc(sel.from, sel.to);
        api.layout.showPanel('quicktry', { focus: false });
        setTimeout(() => run(code), 0);
      },
    });
    api.onDispose(() => input?.destroy());
  },
};
