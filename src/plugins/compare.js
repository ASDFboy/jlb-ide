// Compare: runs the current file with both interpreters and shows the two
// outputs side by side, with any differences marked, and how long each took.

import { runToEnd, diffLines, firstDifference, formatMs } from './outputs.js';

export default {
  id: 'compare',
  name: 'Compare Rust and C',
  description: 'Runs the current file with both interpreters and shows where their outputs differ, and which was faster.',
  builtin: true,
  settings: [
    { key: 'timeout', title: 'Stop a program after this many seconds', description: 'A program that never ends is stopped, so the comparison always finishes.', type: 'number', default: 10, min: 1, max: 600 },
  ],
  activate(api) {
    const { h, clear, icon, toast } = api.ui;
    let el = null;
    let result = null; // { doc, rust, c, input }
    let busy = false;
    const inputs = new Map(); // file path -> typed input
    let showInput = false;

    const run = async () => {
      if (busy) return;
      const doc = api.workspace.active;
      if (!doc) return toast('Open a .jlb file to compare.');
      const rust = api.run.resolve('rust');
      const c = api.run.resolve('c');
      api.layout.showPanel('compare', { focus: false });
      if (!rust?.path || !c?.path) {
        result = { doc, missing: [!rust?.path && 'Rust', !c?.path && 'C'].filter(Boolean) };
        return render();
      }
      if (!doc.path || api.workspace.isDirty(doc)) {
        if (!(await api.workspace.save())) return;
      }
      busy = true;
      const input = inputs.get(doc.path) || '';
      result = { doc, running: true, input };
      render();
      const timeout = api.settings.get('timeout') * 1000;
      // One after the other, so the times aren't skewed by running together.
      const r = await runToEnd(api, rust.path, doc.path, { input: withNewline(input), timeout });
      const cr = await runToEnd(api, c.path, doc.path, { input: withNewline(input), timeout });
      result = { doc, rust: r, c: cr, input };
      busy = false;
      render();
    };

    const withNewline = (t) => (t && !t.endsWith('\n') ? t + '\n' : t);

    const verdict = (r) => {
      if (r.rust.error || r.c.error) return h('div.cmp-verdict.bad', icon('alert', 15), h('span', r.rust.error || r.c.error));
      const same = r.rust.text === r.c.text && r.rust.code === r.c.code;
      if (same) return h('div.cmp-verdict.good', icon('check', 15), h('span', 'Same output from both interpreters'));
      const line = firstDifference(r.rust.text, r.c.text);
      return h('div.cmp-verdict.bad', icon('alert', 15),
        h('span', line ? `The outputs differ, starting on line ${line}` : `The outputs match, but the exit codes differ (Rust ${r.rust.code}, C ${r.c.code})`));
    };

    const speed = (r) => {
      if (r.rust.error || r.c.error || r.rust.timedOut || r.c.timedOut) return null;
      const [a, b] = [r.rust.ms, r.c.ms];
      if (!a || !b) return null;
      const ratio = a > b ? a / b : b / a;
      const faster = a > b ? 'C' : 'Rust';
      return h('span.cmp-speed', ratio < 1.1 ? 'About the same speed' : `${faster} was ${ratio.toFixed(1)}× faster`);
    };

    const side = (name, r) => h('div.cmp-col-head',
      h('strong', name),
      r.error ? h('span.muted', 'couldn\'t run') : h('span.muted',
        r.timedOut ? `stopped after ${formatMs(r.ms)}` : `${formatMs(r.ms)} · exit ${r.code ?? '?'}`));

    /** The two outputs side by side; lines that differ are marked, changed lines facing each other. */
    const columns = (r) => {
      const ops = diffLines(r.rust.text || '', r.c.text || '');
      const rows = [];
      for (let i = 0; i < ops.length;) {
        if (ops[i].kind === 'same') {
          rows.push([ops[i], ops[i]]);
          i++;
          continue;
        }
        const olds = [];
        const news = [];
        while (i < ops.length && ops[i].kind !== 'same') (ops[i].kind === 'old' ? olds : news).push(ops[i++]);
        for (let k = 0; k < Math.max(olds.length, news.length); k++) rows.push([olds[k] || null, news[k] || null]);
      }
      const table = h('table.cmp-table');
      const cell = (op, which) => {
        if (!op) return [h('td.cmp-num'), h('td.cmp-line.gap')];
        const changed = op.kind !== 'same';
        return [h('td.cmp-num', String(which === 'a' ? op.a : op.b)), h(`td.cmp-line${changed ? (which === 'a' ? '.old' : '.new') : ''}`, op.text)];
      };
      const shown = rows.slice(0, 5000);
      for (const [x, y] of shown) table.append(h('tr', cell(x, 'a'), cell(y, 'b')));
      return h('div.cmp-scroll', table, rows.length > shown.length ? h('p.view-note', `…and ${rows.length - shown.length} more lines`) : null,
        !ops.length ? h('p.view-note', 'Neither printed anything.') : null);
    };

    const render = () => {
      if (!el) return;
      clear(el);
      const doc = result?.doc || api.workspace.active;
      const inputBox = h('textarea.input.cmp-input', {
        placeholder: 'Answers for INPUT, one per line',
        spellcheck: false,
        'aria-label': 'Answers for INPUT, one per line',
        rows: 3,
        hidden: !showInput,
        value: doc?.path ? inputs.get(doc.path) || '' : '',
        on: { input: (e) => doc?.path && inputs.set(doc.path, e.target.value) },
      });
      el.append(h('div.cmp-head',
        h('span.cmp-title', doc ? doc.name : 'No file open'),
        h('span.spacer'),
        h('button.btn.small', { title: 'What the program reads with INPUT', 'aria-pressed': showInput ? 'true' : 'false', on: { click: () => { showInput = !showInput; render(); } } }, 'Input…'),
        h('button.btn.small.primary', { disabled: busy || !doc, title: 'Run with both (Ctrl+Shift+F5)', on: { click: run } }, icon('play', 12), busy ? 'Running…' : 'Compare')),
      inputBox);
      if (!result) {
        el.append(h('div.empty-note',
          h('p', 'Runs the current file with the Rust and the C interpreter, then shows both outputs side by side with any differences marked.'),
          h('p.muted', 'The two should always agree. If a program needs INPUT, type its answers under Input… first.')));
        return;
      }
      if (result.missing) {
        el.append(h('div.empty-note', h('p', `The ${result.missing.join(' and ')} interpreter isn't set up.`),
          h('button.btn', { on: { click: () => api.commands.run('view.settings', 'Interpreters') } }, 'Open Settings → Interpreters')));
        return;
      }
      if (result.running) {
        el.append(h('div.empty-note', h('p', 'Running with Rust, then C…')));
        return;
      }
      el.append(h('div.cmp-summary', verdict(result), speed(result)),
        h('div.cmp-cols', side('Rust', result.rust), side('C', result.c)),
        columns(result));
    };

    api.layout.addPanel({
      id: 'compare',
      title: 'Compare',
      order: 45,
      render: (e) => {
        el = e;
        el.classList.add('compare');
        render();
      },
    });
    api.commands.register({ id: 'compare.run', title: 'Compare the Rust and C interpreters on this file', key: 'Ctrl+Shift+F5', run });
  },
};
