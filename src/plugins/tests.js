// Tests: a test is a .jlb program with a .out file next to it holding what it
// should print (and, if it reads INPUT, a .in file with the answers). This runs
// them with the Rust interpreter, the C one, or both, and shows what differs.
// It's the same layout the interpreters' own tests use (tests/cases).

import { runToEnd, normalize, diffLines, formatMs } from './outputs.js';
import { askedInterpreter } from '../lang/data.js';

const SKIP = /^(\.|node_modules$|target$|dist$)/;

export default {
  id: 'tests',
  name: 'Test runner',
  description: 'Runs the .jlb programs in your folder that have a .out file (what they should print) and shows which pass, with either interpreter or both.',
  builtin: true,
  settings: [
    { key: 'with', title: 'Run tests with', type: 'select', default: 'both', options: [{ value: 'both', label: 'Both interpreters' }, { value: 'rust', label: 'Rust' }, { value: 'c', label: 'C' }] },
    { key: 'timeout', title: 'Stop a test after this many seconds', type: 'number', default: 10, min: 1, max: 600 },
  ],
  activate(api) {
    const { h, clear, icon, toast, confirm } = api.ui;
    let el = null;
    let tests = []; // { path, name, out, inp }
    const results = new Map(); // path -> { rust?, c? } each { pass, text, expected, ms, error, timedOut }
    let selected = null;
    let running = false;
    let stopRequested = false;
    let scanning = false;

    const rel = (p) => {
      const f = api.workspace.folder;
      return f && p.startsWith(f) ? p.slice(f.length + 1) : p.split(/[\\/]/).pop();
    };

    /** Finds every X.jlb with an X.out next to it. */
    const scan = async () => {
      const folder = api.workspace.folder;
      tests = [];
      if (!folder) return render();
      scanning = true;
      render();
      const found = [];
      let budget = 5000;
      const walk = async (dir, depth) => {
        let entries;
        try {
          entries = await api.invoke('list_dir', { path: dir });
        } catch {
          return;
        }
        budget -= entries.length;
        const names = new Map(entries.map((e) => [e.name, e]));
        for (const e of entries) {
          if (!e.is_dir && /\.jlb$/i.test(e.name)) {
            const base = e.name.replace(/\.jlb$/i, '');
            const out = names.get(base + '.out');
            if (out && !out.is_dir) found.push({ path: e.path, name: rel(e.path), out: out.path, inp: names.get(base + '.in')?.path || null });
          }
        }
        if (depth >= 5 || budget <= 0) return;
        for (const e of entries) if (e.is_dir && !SKIP.test(e.name)) await walk(e.path, depth + 1);
      };
      await walk(folder, 0);
      tests = found.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      for (const p of [...results.keys()]) if (!tests.some((t) => t.path === p)) results.delete(p);
      scanning = false;
      render();
    };

    const which = () => {
      const w = api.settings.get('with');
      return w === 'both' ? ['rust', 'c'] : [w];
    };

    const runOne = async (t, ids) => {
      const expected = normalize(await api.invoke('read_text', { path: t.out }).catch(() => ''));
      const input = t.inp ? await api.invoke('read_text', { path: t.inp }).catch(() => '') : '';
      // A test can choose its interpreter on its first line (>> @interpreter c). Running
      // with one interpreter follows that; running with both checks both anyway.
      const both = ids.length > 1;
      let fresh = false;
      if (!both) {
        const [head] = await api.invoke('read_texts', { paths: [t.path], max_bytes: 300 }).catch(() => ['']);
        const asked = askedInterpreter(head || '');
        if (asked && api.run.resolve(asked)) {
          ids = [asked];
          fresh = true;
        }
      }
      const res = fresh ? {} : results.get(t.path) || {};
      for (const id of ids) {
        const it = api.run.resolve(id);
        if (!it?.path) {
          res[id] = { error: `The ${it?.name || id} interpreter isn't set up`, pass: false, expected };
          continue;
        }
        res[id] = { running: true };
        results.set(t.path, res);
        render();
        const r = await runToEnd(api, it.path, t.path, { input, timeout: api.settings.get('timeout') * 1000, stay: both });
        res[id] = r.error ? { error: r.error, pass: false, expected } : { pass: !r.timedOut && r.text === expected, text: r.text, expected, ms: r.ms, timedOut: r.timedOut };
      }
      results.set(t.path, res);
    };

    const runAll = async (list = tests) => {
      if (running || !list.length) return;
      // Unsaved changes to a test would otherwise be left out.
      for (const doc of api.workspace.files) {
        if (doc.path && api.workspace.isDirty(doc) && list.some((t) => t.path === doc.path || t.out === doc.path || t.inp === doc.path)) {
          if (!(await confirm(`${doc.name} has unsaved changes. Save them before running the tests?`, { ok: 'Save and run' }))) return;
          api.workspace.activate(doc);
          if (!(await api.workspace.save())) return;
        }
      }
      running = true;
      stopRequested = false;
      api.layout.showPanel('tests', { focus: false });
      const ids = which();
      for (const t of list) {
        if (stopRequested) break;
        await runOne(t, ids);
        render();
      }
      running = false;
      render();
      const failed = list.filter((t) => statusOf(t) === 'fail').length;
      api.layout.setBadge('tests', failed || '', failed ? 'error' : '');
    };

    const statusOf = (t) => {
      const r = results.get(t.path);
      if (!r) return 'none';
      const vals = Object.values(r);
      if (vals.some((x) => x.running)) return 'running';
      if (!vals.length) return 'none';
      return vals.every((x) => x.pass) ? 'pass' : 'fail';
    };

    /** Saves what an interpreter printed as the test's expected output. */
    const accept = async (t, id) => {
      const r = results.get(t.path)?.[id];
      if (!r || r.text == null) return;
      if (!(await confirm(`Make this the expected output of ${t.name}?`, { ok: 'Save', detail: `${t.out.split(/[\\/]/).pop()} gets what the ${id === 'rust' ? 'Rust' : 'C'} interpreter printed.` }))) return;
      await api.invoke('write_text', { path: t.out, text: r.text + '\n' });
      await runOne(t, which());
      render();
    };

    /** Makes the current file a test: its output now becomes what it should print. */
    const fromFile = async () => {
      const doc = api.workspace.active;
      if (!doc) return toast('Open a .jlb file to make a test from it.');
      if (!doc.path || api.workspace.isDirty(doc)) {
        if (!(await api.workspace.save())) return;
      }
      const chosen = api.run.forDoc(doc);
      const it = chosen?.path ? chosen : api.run.resolve('rust');
      if (!it?.path) return toast('No interpreter is set up.', { kind: 'error' });
      const base = doc.path.replace(/\.jlb$/i, '');
      const inp = await api.invoke('path_info', { path: base + '.in' }).then((i) => (i.exists ? base + '.in' : null)).catch(() => null);
      const input = inp ? await api.invoke('read_text', { path: inp }) : '';
      const r = await runToEnd(api, it.path, doc.path, { input, timeout: api.settings.get('timeout') * 1000 });
      if (r.error) return toast(r.error, { kind: 'error' });
      if (r.timedOut) return toast('The program didn\'t finish, so it can\'t be a test.', { kind: 'error' });
      const out = base + '.out';
      const exists = await api.invoke('path_info', { path: out }).then((i) => i.exists).catch(() => false);
      const preview = r.text.split('\n').slice(0, 8).join('\n') + (r.text.split('\n').length > 8 ? '\n…' : '');
      if (!(await confirm(exists ? `Replace the expected output in ${out.split(/[\\/]/).pop()}?` : `Make ${doc.name} a test?`, {
        ok: exists ? 'Replace' : 'Make test',
        detail: `From now on it should print what it just printed with ${it.name}:\n\n${preview || '(nothing)'}${inp ? '' : '\n\nIf it reads INPUT, put the answers in a .in file next to it.'}`,
      }))) return;
      await api.invoke('write_text', { path: out, text: r.text + '\n' });
      toast(`Saved ${out.split(/[\\/]/).pop()}`, { kind: 'ok' });
      await scan();
      selected = doc.path;
      render();
    };

    // ---------- the panel ----------

    const chip = (id, r) => {
      const name = id === 'rust' ? 'Rust' : 'C';
      if (!r) return null;
      if (r.running) return h('span.tst-chip.running', `${name} …`);
      return h(`span.tst-chip.${r.pass ? 'pass' : 'fail'}`, { title: r.error || (r.timedOut ? 'It didn\'t finish in time' : '') },
        `${name} ${r.pass ? '✓' : '✗'}`, r.ms != null ? h('span.muted', ` ${formatMs(r.ms)}`) : null);
    };

    const statusIcon = (s) => {
      if (s === 'pass') return h('span.tst-status.pass', { title: 'Passed' }, icon('check', 14));
      if (s === 'fail') return h('span.tst-status.fail', { title: 'Failed' }, icon('x', 14));
      if (s === 'running') return h('span.tst-status.running', { title: 'Running' }, icon('refresh', 13));
      return h('span.tst-status.none', { title: 'Not run yet' }, icon('dot', 8));
    };

    const detail = (t) => {
      const r = results.get(t.path);
      const box = h('div.tst-detail');
      box.append(h('div.tst-detail-head', h('strong', t.name), h('span.spacer'),
        h('button.btn.small', { on: { click: () => api.workspace.openFile(t.path) } }, icon('file', 12), 'Open'),
        h('button.btn.small', { on: { click: () => api.workspace.openFile(t.out) } }, 'Open .out'),
        h('button.btn.small', { disabled: running, on: { click: () => runAll([t]) } }, icon('play', 12), 'Run')));
      if (!r) {
        box.append(h('p.view-note', 'Not run yet.'));
        return box;
      }
      for (const [id, x] of Object.entries(r)) {
        const name = id === 'rust' ? 'Rust' : 'C';
        if (x.running) continue;
        if (x.error) {
          box.append(h('p.tst-msg.fail', `${name}: ${x.error}`));
          continue;
        }
        if (x.pass) {
          box.append(h('p.tst-msg.pass', `${name}: printed exactly what was expected (${formatMs(x.ms)}).`));
          continue;
        }
        box.append(h('p.tst-msg.fail', `${name}: ${x.timedOut ? 'didn\'t finish in time. Here\'s what it printed before it was stopped.' : 'printed something different.'}`),
          h('div.tst-legend', h('span.old', '− expected'), h('span.new', '+ printed')),
          unified(x.expected, x.text),
          x.timedOut ? null : h('button.btn.small', { on: { click: () => accept(t, id) } }, `Use ${name}'s output as the expected output`));
      }
      return box;
    };

    const unified = (expected, actual) => {
      const ops = diffLines(expected, actual);
      const pre = h('div.tst-diff');
      // Show changes with a little context around them.
      const near = new Set();
      ops.forEach((o, i) => {
        if (o.kind !== 'same') for (let k = i - 2; k <= i + 2; k++) near.add(k);
      });
      let skipped = 0;
      ops.forEach((o, i) => {
        if (!near.has(i)) {
          skipped++;
          return;
        }
        if (skipped) {
          pre.append(h('div.tst-skip', `… ${skipped} matching line${skipped === 1 ? '' : 's'}`));
          skipped = 0;
        }
        pre.append(h(`div.tst-row.${o.kind}`, h('span.tst-mark', o.kind === 'old' ? '−' : o.kind === 'new' ? '+' : ' '), h('span', o.text || ' ')));
      });
      if (skipped) pre.append(h('div.tst-skip', `… ${skipped} matching line${skipped === 1 ? '' : 's'}`));
      return pre;
    };

    const render = () => {
      if (!el) return;
      clear(el);
      const folder = api.workspace.folder;
      const counts = { pass: 0, fail: 0, none: 0, running: 0 };
      for (const t of tests) counts[statusOf(t)]++;
      const pick = h('select.input.small', { 'aria-label': 'Run tests with', on: { change: (e) => api.settings.set('with', e.target.value) } },
        [['both', 'Both'], ['rust', 'Rust'], ['c', 'C']].map(([v, l]) => h('option', { value: v, selected: api.settings.get('with') === v }, l)));
      el.append(h('div.tst-head',
        h('span.tst-title', folder ? `Tests in ${folder.split(/[\\/]/).pop()}` : 'Tests'),
        tests.length ? h('span.tst-counts', [
          counts.pass ? h('span.pass', `${counts.pass} passed`) : null,
          counts.fail ? h('span.fail', `${counts.fail} failed`) : null,
          counts.none ? h('span.muted', `${counts.none} not run`) : null,
        ]) : null,
        h('span.spacer'),
        h('label.tst-with', 'With ', pick),
        running
          ? h('button.btn.small', { on: { click: () => { stopRequested = true; } } }, icon('stop', 11), 'Stop')
          : h('button.btn.small.primary', { disabled: !tests.length, on: { click: () => runAll() } }, icon('play', 12), 'Run all'),
        h('button.icon-btn', { title: 'Look for tests again', 'aria-label': 'Look for tests again', on: { click: scan } }, icon('refresh', 15))));
      if (!folder || (!tests.length && !scanning)) {
        el.append(h('div.empty-note',
          h('p', folder ? 'No tests in this folder yet.' : 'Open a folder to see its tests.'),
          h('p.muted', 'A test is a .jlb program with a .out file next to it (same name) holding exactly what it should print. If it reads INPUT, a .in file holds the answers, one per line.'),
          h('button.btn', { on: { click: fromFile } }, icon('plus', 13), 'Make a test from the current file')));
        return;
      }
      if (scanning) {
        el.append(h('div.empty-note', h('p', 'Looking for tests…')));
        return;
      }
      const list = h('ul.tst-list', { role: 'listbox', 'aria-label': 'Tests' }, tests.map((t) => {
        const r = results.get(t.path) || {};
        return h(`li.tst-item${selected === t.path ? '.on' : ''}`, {
          role: 'option',
          tabindex: '0',
          'aria-selected': selected === t.path ? 'true' : 'false',
          on: {
            click: () => { selected = t.path; render(); },
            dblclick: () => api.workspace.openFile(t.path),
            keydown: (e) => {
              if (e.key === 'Enter') { selected = t.path; render(); }
            },
          },
        }, statusIcon(statusOf(t)), h('span.tst-name', t.name), h('span.tst-chips', chip('rust', r.rust), chip('c', r.c)));
      }));
      const sel = tests.find((t) => t.path === selected);
      el.append(h('div.tst-body', list, sel ? detail(sel) : h('div.tst-detail', h('p.view-note', 'Pick a test to see what it printed.'))));
    };

    api.layout.addPanel({
      id: 'tests',
      title: 'Tests',
      order: 46,
      render: (e) => {
        el = e;
        el.classList.add('tests');
        scan();
      },
    });
    api.events.on('folder-change', () => {
      results.clear();
      selected = null;
      scan();
    });
    // A saved .out or .in file (or a new test) may change the list.
    api.events.on('file-save', (doc) => {
      if (doc.path && /\.(out|in|jlb)$/i.test(doc.path)) setTimeout(scan, 50);
    });
    api.commands.register({ id: 'tests.runAll', title: 'Run all tests', run: async () => { if (!tests.length) await scan(); runAll(); } });
    api.commands.register({ id: 'tests.fromFile', title: 'Make a test from the current file', run: fromFile });
    api.commands.register({ id: 'tests.show', title: 'Show the tests', run: () => api.layout.showPanel('tests') });
  },
};
