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
    { key: 'slowAfter', title: 'Offer to stop a snippet after this many seconds', description: 'A snippet stuck in an endless loop never finishes; this shows a Stop button for it.', type: 'number', default: 5, min: 1, max: 120 },
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

    /** Runs a snippet; `label` replaces the code shown in the list (for a whole file). */
    const run = async (code, { label } = {}) => {
      code = code.replace(/\s+$/, '');
      if (!code.trim() || busy) return;
      const it = interpreter();
      if (!it?.path) {
        add(h('div.qt-entry.err', h('div.qt-result', 'No interpreter is set up. Choose one in Settings → Interpreters.')));
        return;
      }
      busy = true;
      if (!label) {
        past = [code, ...past.filter((p) => p !== code)].slice(0, 50);
        if (api.settings.get('keepHistory')) api.settings.set('history', JSON.stringify(past));
      }
      back = -1;
      const res = h('div.qt-result.pending', 'Running…');
      const entry = h('div.qt-entry', label ? h('div.qt-label', label) : h('pre.qt-code', code), res);
      add(entry);
      // A snippet that takes a while gets a Stop button (an endless loop never finishes on its own).
      let stopped = false;
      const slow = setTimeout(() => {
        if (!res.classList.contains('pending')) return;
        clear(res).append('Still running… ', h('button.link', {
          on: {
            click: async () => {
              stopped = true;
              await api.invoke('repl_reset');
            },
          },
        }, 'Stop'));
      }, api.settings.get('slowAfter') * 1000);
      const show = (r) => {
        let out = r.output;
        // CLEAR() sends a form feed: everything shown before it goes, this snippet's
        // earlier output included.
        const f = out ? out.lastIndexOf('\f') : -1;
        if (f >= 0) {
          for (const el of [...log.children]) if (el !== entry) el.remove();
          entry.querySelectorAll('.qt-output').forEach((el) => el.remove());
          out = out.slice(f + 1);
        }
        if (out) entry.insertBefore(h('pre.qt-output', out.replace(/\n$/, '')), res);
      };
      try {
        let r = await api.invoke('repl_eval', { interpreter: it.path, cwd: sessionDir(), code });
        let reply = JSON.parse(r.reply);
        // INPUT: ask here, send the answer, and wait for what comes next.
        while ('input' in reply) {
          show(r);
          const answer = await ask(entry, res, reply.input);
          if (answer === null) {
            stopped = true;
            await api.invoke('repl_reset');
            throw new Error('stop');
          }
          r = await api.invoke('repl_answer', { text: answer });
          reply = JSON.parse(r.reply);
        }
        res.classList.remove('pending');
        show(r);
        if (!reply.ok) {
          entry.classList.add('err');
          res.textContent = reply.error.message + (reply.error.traced && reply.error.line > 1 ? ` (line ${reply.error.line})` : '');
        } else if ('value' in reply) {
          const tv = reply.type === 'TABLE' ? api.use('tableview') : null;
          clear(res).append(h('code.qt-value', reply.value), api.settings.get('showTypes') ? h('span.qt-type', reply.type) : null,
            tv ? h('button.link.qt-view', { title: 'Open in the table viewer', on: { click: () => tv.open({ title: label || code.split('\n')[0].slice(0, 40), node: tv.parse(reply.value, 'value') }) } }, icon('table', 12), 'View as a table') : null);
        } else if (reply.ended) {
          res.textContent = 'END stopped the session; variables were cleared.';
          api.invoke('repl_reset');
        } else {
          res.remove();
          if (!r.output) entry.classList.add('done');
        }
      } catch (e) {
        res.classList.remove('pending');
        entry.classList.add('err');
        res.textContent = stopped ? 'Stopped. The variables were cleared.' : String(e?.message || e);
      }
      clearTimeout(slow);
      busy = false;
      log.scrollTop = log.scrollHeight;
    };

    /** An answer box for INPUT, inside the snippet's entry. Resolves to the text, or null to stop. */
    const ask = (entry, res, prompt) => new Promise((resolve) => {
      const box = h('input.input.qt-answer', { placeholder: 'Type the answer and press Enter', spellcheck: false, 'aria-label': prompt || 'Answer for INPUT' });
      const row = h('div.qt-ask', h('span.qt-prompt', prompt || 'INPUT'), box, h('button.link', { on: { click: () => done(null) } }, 'Stop'));
      const done = (v) => {
        row.remove();
        if (v !== null) entry.insertBefore(h('div.qt-answered', h('span.qt-prompt', prompt), h('span.o-in', v)), res);
        resolve(v);
      };
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') done(box.value);
        if (e.key === 'Escape') done(null);
      });
      clear(res).append('Waiting for an answer');
      entry.insertBefore(row, res);
      log.scrollTop = log.scrollHeight;
      setTimeout(() => box.focus());
    });

    // Sessions run in the open folder (or the current file's folder), so READ and IMPORT find files.
    const sessionDir = () => {
      const doc = api.workspace.active;
      return api.workspace.folder || (doc?.path ? doc.path.replace(/[\\/][^\\/]*$/, '') : '');
    };

    /** Runs the current file in the session, so its functions and variables can be tried out. */
    const loadFile = () => {
      const doc = api.workspace.active;
      if (!doc) return api.ui.toast('Open a file to load it into Quick-try.');
      api.layout.showPanel('quicktry', { focus: false });
      setTimeout(() => run(api.workspace.textOf(doc), { label: `Loaded ${doc.name}` }), 0);
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
        { icon: 'file', title: 'Load the current file (runs it, so you can try its functions)', run: loadFile },
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
          h('p.muted', 'Variables stay between snippets, so you can build things up step by step. Select code in the editor and press Ctrl+Enter to try it here, or load the whole file (the page button above) to try out its functions.')));
      }
    };

    api.commands.register({ id: 'quicktry.loadFile', title: 'Load the current file into Quick-try', run: loadFile });
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
