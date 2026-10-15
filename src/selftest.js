// The app's own self-test: run inside the real desktop app (debug builds, started
// with JLB_IDE_SELFTEST=<folder>) to check the parts that only the native side does:
// listing and reading files, running programs, Compare, Tests and Search. The folder
// holds main.jlb (PRINT("hello", 1 + 2) >> needle_7731), main.out and flood.jlb (30000 lines); results go to <folder>/selftest.json.

import { invoke, listen } from './core/backend.js';

export async function run(ide, folder) {
  const sep = folder.includes('\\') ? '\\' : '/';
  const at = (name) => folder + sep + name;
  const results = {};
  const check = async (name, fn) => {
    try {
      const r = await fn();
      results[name] = r === true ? 'ok' : `FAILED: ${JSON.stringify(r)}`;
    } catch (e) {
      results[name] = `ERROR: ${String(e?.message || e)}`;
    }
  };
  const waitFor = async (test, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = test();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  };
  const rust = ide.runner.resolve('rust')?.path;
  const c = ide.runner.resolve('c')?.path;

  await check('list_files', async () => {
    const r = await invoke('list_files', { root: folder });
    return r.files.some((f) => f.path.endsWith('main.jlb')) || r;
  });
  await check('read_texts', async () => {
    const [t] = await invoke('read_texts', { paths: [at('main.jlb')], max_bytes: 1000 });
    return t?.startsWith('PRINT') || t;
  });
  await check('check_code', async () => JSON.parse(await invoke('check_code', { interpreter: rust, source: 'PRINT(1)\n' })).ok || 'not ok');
  for (const [name, path] of [['rust', rust], ['c', c]]) {
    await check(`run_capture_${name}`, async () => {
      const r = await invoke('run_capture', { interpreter: path, file: at('main.jlb'), cwd: folder, args: [], input: '', timeout_ms: 10000 });
      return r.stdout.trim() === 'hello 3' || r;
    });
  }
  await check('run_program_flood', async () => {
    let events = 0;
    let text = '';
    let exit = null;
    const offOut = await listen('run-output', (e) => {
      if (e.payload.stream === 'out') {
        events++;
        text = (text + e.payload.text).slice(-200);
      }
    });
    const offExit = await listen('run-exit', (e) => (exit = e.payload));
    const t0 = Date.now();
    await invoke('run_program', { interpreter: rust, file: at('flood.jlb'), cwd: folder, args: [] });
    await waitFor(() => exit, 30000);
    offOut();
    offExit();
    const secs = (Date.now() - t0) / 1000;
    // Gathered: a few dozen messages a second at most, and the end arrives before the exit.
    return (exit && text.trim().endsWith('line 30000') && events <= secs * 40 + 5) || { exit, end: text.slice(-30), events, secs };
  });

  ide.workspace.setFolder(folder);
  await check('search', async () => {
    await ide.commands.run('search.show');
    const input = document.querySelector('.sr-input');
    input.value = 'needle_7731';
    input.dispatchEvent(new Event('input'));
    return (await waitFor(() => /1 result in 1 file/.test(document.querySelector('.sr-summary')?.textContent))) || document.querySelector('.sr-summary')?.textContent;
  });
  await check('tests', async () => {
    ide.layout.showPanel('tests');
    await ide.commands.run('tests.runAll');
    const done = () => document.querySelectorAll('.tst-chip.pass').length >= 1 && !document.querySelector('.tst-chip.running, .tst-chip.fail');
    return (await waitFor(done)) ? true : [...document.querySelectorAll('.tst-chip')].map((x) => x.className).join(' ');
  });
  await check('compare', async () => {
    await ide.workspace.openFile(at('main.jlb'));
    await ide.commands.run('compare.run');
    return (await waitFor(() => document.querySelector('.cmp-verdict.good'))) ? true : document.querySelector('.cmp-verdict')?.textContent || 'no result';
  });

  await invoke('write_text', { path: at('selftest.json'), text: JSON.stringify(results, null, 2) });
}
