// End-to-end tests of the IDE's UI, run in a real browser against the real
// interpreter (through scripts/dev-server.mjs).
//
//   npm run build:web && npm test
//
// Needs Chromium for Playwright: `npx playwright-core install chromium`, or set
// CHROMIUM_PATH to a Chromium/Chrome program. JLB_PATH picks the interpreter.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const PORT = 5199;
const URL_ = `http://127.0.0.1:${PORT}/`;
const config = fs.mkdtempSync(path.join(os.tmpdir(), 'jlb-ide-test-config-'));
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'jlb-ide-test-proj-'));
let server;
let browser;
let page;
const errors = [];

const dialog = (...paths) => fetch(URL_ + '__test/dialog', { method: 'POST', body: JSON.stringify({ paths }) });
const setText = (text) => page.evaluate((t) => {
  const v = window.jlbIde.editor.view;
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: t } });
}, text);
const coords = (line, find) => page.evaluate(([l, f]) => {
  const v = window.jlbIde.editor.view;
  const ln = v.state.doc.line(l);
  const c = v.coordsAtPos(ln.from + ln.text.indexOf(f));
  return { x: c.left + 3, y: (c.top + c.bottom) / 2 };
}, [line, find]);
const hoverText = async (line, find) => {
  await page.mouse.move(5, 5);
  await page.waitForTimeout(200);
  const c = await coords(line, find);
  await page.mouse.move(c.x, c.y);
  try {
    await page.waitForSelector('.hover-card', { timeout: 2500 });
    return await page.locator('.hover-card').innerText();
  } catch {
    return '';
  }
};
const problems = async () => {
  await page.click('.panel-tab:has-text("Problems")');
  await page.waitForTimeout(1200);
  return page.locator('.panel').innerText();
};

before(async () => {
  fs.writeFileSync(path.join(proj, 'guess.jlb'), 'secret = 42\nPOINT ask\nguess = NUM(INPUT("Your guess: "))\nIF guess < secret {\n    PRINT("Higher!")\n    GOTO ask\n}\nPRINT("Got it")\n');
  fs.writeFileSync(path.join(proj, 'crash.jlb'), 'FUNC area(w, h) {\n    LOCAL size = w * h\n    RETURN size / (h - 3)\n}\nname = "Alex"\nPRINT("Working...")\nPRINT(area(4, 3))\n');
  server = spawn(process.execPath, ['scripts/dev-server.mjs', String(PORT)], { env: { ...process.env, JLB_IDE_CONFIG: config }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res) => server.stdout.once('data', res));
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  await openPage();
});

/** Opens the IDE in a new page, like starting it again. */
async function openPage() {
  page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
  page.on('pageerror', (e) => errors.push(e.message));
  // Stopping a Quick-try snippet makes its pending call fail on purpose.
  page.on('console', (m) => m.type() === 'error' && !m.location().url?.endsWith('/__bridge/repl_eval') && errors.push(`${m.text()} (${m.location().url})`));
  await page.goto(URL_);
  await page.waitForSelector('body.ready');
}

/** Closes the IDE's page without any clean-up (like a crash), then opens it again. */
async function restartIde({ crash = true } = {}) {
  await page.evaluate(() => window.jlbIde.settings.saveNow());
  await page.close({ runBeforeUnload: false });
  if (crash) {
    // A crashed IDE's "alive" file stops being touched; make it look a minute old.
    const root = path.join(config, 'backups');
    const old = new Date(Date.now() - 60000);
    for (const d of fs.readdirSync(root)) if (fs.existsSync(path.join(root, d, 'alive'))) fs.utimesSync(path.join(root, d, 'alive'), old, old);
  }
  await fetch(URL_ + '__test/restart', { method: 'POST' });
  await openPage();
}

const backupFiles = () => {
  const root = path.join(config, 'backups');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).flatMap((d) => fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(root, d, f), 'utf8'))));
};

after(async () => {
  await browser?.close();
  server?.kill();
});

test('starts on the welcome screen', async () => {
  assert.ok(await page.isVisible('.welcome-title'));
  assert.ok(await page.isVisible('.run-btn'));
  assert.equal(await page.isVisible('.stop-btn'), false);
});

test('runs a program and answers INPUT', async () => {
  await dialog(proj);
  await page.click('.welcome-actions >> text=Open folder');
  await page.click('.tree-row:has-text("guess.jlb")');
  await page.waitForSelector('.tab.active:has-text("guess.jlb")');
  await page.keyboard.press('F5');
  await page.waitForSelector('.out-line:has-text("Your guess")', { timeout: 5000 });
  await page.fill('.out-input', '10');
  await page.press('.out-input', 'Enter');
  await page.waitForSelector('.out-line:has-text("Higher!")');
  await page.fill('.out-input', '42');
  await page.press('.out-input', 'Enter');
  await page.waitForSelector('.out-line:has-text("Finished")');
  const out = await page.locator('div.out').innerText();
  assert.match(out, /Your guess: 10\nHigher!\nYour guess: 42\nGot it/);
});

test('stops a running program', async () => {
  await page.keyboard.press('F5');
  await page.waitForSelector('.out-line:has-text("Your guess")');
  assert.ok(await page.isVisible('.stop-btn'));
  await page.click('.stop-btn');
  await page.waitForSelector('.out-line:has-text("Stopped")');
  assert.equal(await page.isVisible('.stop-btn'), false);
});

test('shows a crash report and marks the line', async () => {
  await page.click('.tree-row:has-text("crash.jlb")');
  await page.waitForSelector('.tab.active:has-text("crash.jlb")');
  await page.keyboard.press('F5');
  await page.waitForSelector('.crash-msg');
  const panel = await page.locator('.panel').innerText();
  assert.match(panel, /can't divide by zero/);
  assert.match(panel, /crash\.jlb, line 3/);
  assert.match(panel, /area\(\)/);
  assert.match(panel, /size\s+12\s+NUMBER/);
  assert.match(panel, /name\s+"Alex"\s+TEXT/);
  await page.waitForSelector('.cm-crash-line');
  assert.equal(await page.locator('.cm-crash-line').count(), 1);
  assert.match(await hoverText(2, 'size'), /size = 12/);
});

test('checks syntax as you type, with fixes', async () => {
  await page.keyboard.press('Control+n');
  await setText('x = 5\nIF x != 3 {\n    PRINT(x)\n}\n');
  assert.match(await problems(), /!= isn't an operator in \.jlb/);
  await setText('Print(1)\n');
  assert.match(await problems(), /did you mean PRINT\?/);
  await setText('myScore = 1\n');
  assert.match(await problems(), /should be "my_score"/);
});

test('warns about .jlb quirks', async () => {
  await setText('player = NULL\nIF player !== NULL && player.hp > 0 {\n    PRINT(1)\n}\nscore = 10\nPRINT(scroe)\nIF "abc" < "abd" {\n    PRINT(2)\n}\nGOTO nowhere\n');
  const p = await problems();
  assert.match(p, /&& always checks both sides/);
  assert.match(p, /scroe is never given a value in this file\. Did you mean score\?/);
  assert.match(p, /compares lengths, not alphabetical order/);
  assert.match(p, /no POINT nowhere/);
  await setText('player = NULL\nIF player !== NULL & player.hp > 0 {\n    PRINT(1)\n}\n');
  assert.match(await problems(), /No problems/);
});

test('explains operators and commands on hover', async () => {
  await setText('enemy = NULL\nIF enemy !== NULL & enemy.hp > 0 {\n    PRINT(LEN("abc") * -1)\n}\n');
  assert.match(await hoverText(2, '& '), /AND \(stops early\)/);
  assert.match(await hoverText(2, '!=='), /Not equal \(loose\)/);
  assert.match(await hoverText(3, 'LEN'), /LEN\(x\)/);
  assert.match(await hoverText(2, 'IF'), /truth|true/i);
});

test('suggests commands while typing', async () => {
  await setText('');
  await page.click('.cm-content');
  await page.keyboard.type('PRI');
  await page.waitForSelector('.cm-tooltip-autocomplete');
  assert.match(await page.locator('.cm-tooltip-autocomplete').innerText(), /PRINT/);
  await page.keyboard.press('Escape');
});

test('Quick-try shows results and types, and keeps variables', async () => {
  await page.click('.panel-tab:has-text("Quick-try")');
  const run = async (code) => {
    await page.click('.qt-input .cm-content');
    await page.keyboard.type(code);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.qt-result.pending'));
  };
  await run('"25" * 2');
  await run('x = 5');
  await run('x * 2');
  await run('x / 0');
  const log = await page.locator('.qt-log').innerText();
  assert.match(log, /"2525"\s*TEXT/);
  assert.match(log, /x \* 2\n10\s*NUMBER/);
  assert.match(log, /can't divide by zero/);
});

test('go to definition jumps to a function', async () => {
  await setText('FUNC double(n) {\n    RETURN n * 2\n}\n\nPRINT(double(4))\n');
  const c = await coords(5, 'double');
  await page.mouse.click(c.x + 4, c.y);
  await page.keyboard.press('F12');
  const line = await page.evaluate(() => {
    const s = window.jlbIde.editor.view.state;
    return s.doc.lineAt(s.selection.main.head).number;
  });
  assert.equal(line, 1);
});

test('features can be switched off and on in Settings', async () => {
  await setText('a = 1 & 0\n');
  assert.match(await hoverText(1, '&'), /AND/);
  await page.keyboard.press('Control+,');
  await page.fill('.settings-search', 'quirk explainer');
  await page.click('.setting:has-text("Quirk explainer") .switch input');
  await page.keyboard.press('Escape');
  assert.equal(await hoverText(1, '&'), '');
  await page.keyboard.press('Control+,');
  await page.fill('.settings-search', 'quirk explainer');
  await page.click('.setting:has-text("Quirk explainer") .switch input');
  await page.keyboard.press('Escape');
  assert.match(await hoverText(1, '&'), /AND/);
});

test('loads, runs and switches off an installed plugin', async () => {
  const dir = path.join(config, 'plugins', 'shout');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'shout', name: 'Shout', description: 'Test plugin' }));
  fs.writeFileSync(path.join(dir, 'main.js'), `export function activate(api) {
    api.layout.addStatus(api.ui.h('span.status-item.shout-status', 'SHOUT'), 'right');
    api.commands.register({ id: 'shout.upper', title: 'Make the selection uppercase', run: () => api.editor.insert(api.editor.selection().toUpperCase()) });
    api.language.addCheck({ check: ({ text }) => text.includes('quiet') ? [{ line: 1, severity: 'warning', message: 'Too quiet' }] : [] });
  }`);
  await page.evaluate(() => window.jlbIde.commands.run('plugins.reload'));
  await page.waitForSelector('.shout-status');
  await setText('quiet = 1\n');
  assert.match(await problems(), /Too quiet/);
  await page.evaluate(() => window.jlbIde.settings.set('plugins.shout.enabled', false));
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.shout-status').count(), 0);
  assert.doesNotMatch(await problems(), /Too quiet/);
});

test('saves a new file with Save as', async () => {
  const target = path.join(proj, 'saved.jlb');
  await page.keyboard.press('Control+n');
  await setText('PRINT("saved")');
  await dialog(target);
  await page.keyboard.press('Control+Shift+s');
  await page.waitForFunction(() => document.querySelector('.tab.active .tab-name')?.textContent === 'saved.jlb');
  for (let i = 0; i < 50 && !(fs.existsSync(target) && fs.readFileSync(target, 'utf8')); i++) await page.waitForTimeout(50);
  assert.equal(fs.readFileSync(target, 'utf8'), 'PRINT("saved")\n');
  await page.waitForFunction(() => !document.querySelector('.tab.active.dirty'));
});

test('error lines in Output are links to the code', async () => {
  await page.click('.tree-row:has-text("crash.jlb")');
  await page.waitForSelector('.tab.active:has-text("crash.jlb")');
  await page.keyboard.press('F5');
  await page.waitForSelector('.crash-msg');
  await page.click('.panel-tab:has-text("Output")');
  await page.evaluate(() => window.jlbIde.editor.goTo(6));
  await page.click('.out-link:has-text("line 3") >> nth=0');
  const line = await page.evaluate(() => { const s = window.jlbIde.editor.view.state; return s.doc.lineAt(s.selection.main.head).number; });
  assert.equal(line, 3);
});

test('a crash in an imported file opens and marks that file', async () => {
  fs.mkdirSync(path.join(proj, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'tools', 'helpers.jlb'), 'FUNC helper(n) {\n    RETURN n / 0\n}\n');
  fs.writeFileSync(path.join(proj, 'uses.jlb'), 'IMPORT "tools/helpers.jlb"\nPRINT("start")\nPRINT(helper(4))\n');
  await page.evaluate((p) => window.jlbIde.workspace.openFile(p), path.join(proj, 'uses.jlb'));
  await page.waitForSelector('.tab.active:has-text("uses.jlb")');
  await page.keyboard.press('F5');
  await page.waitForSelector('.tab.active:has-text("helpers.jlb")');
  await page.waitForSelector('.cm-crash-line');
  const marked = await page.evaluate(() => window.jlbIde.editor.view.state.doc.lineAt(window.jlbIde.editor.view.posAtDOM(document.querySelector('.cm-crash-line'))).number);
  assert.equal(marked, 2);
  // Going back to the program shows no mark: the error isn't in it.
  await page.click('.tab:has-text("uses.jlb")');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.cm-crash-line').count(), 0);
});

test('the toolbar shows where the file is', async () => {
  assert.match(await page.locator('.crumbs').innerText(), /uses\.jlb/);
  await page.keyboard.press('Control+n');
  assert.match(await page.locator('.crumbs').innerText(), /not saved yet/);
});

test('tabs can be dragged into a new order, and listed', async () => {
  const names = () => page.locator('.tab .tab-name').allInnerTexts();
  const before = await names();
  assert.ok(before.length >= 3);
  await page.dragAndDrop('.tab >> nth=0', '.tab >> nth=2', { targetPosition: { x: 60, y: 10 } });
  const after = await names();
  assert.notDeepEqual(after, before);
  assert.deepEqual([...after].sort(), [...before].sort());
  await page.click('.tabs-menu');
  assert.equal(await page.locator('.menu .menu-item').count(), before.length);
  await page.keyboard.press('Escape');
});

test('files can be moved by dragging, and the tree works with arrow keys', async () => {
  fs.mkdirSync(path.join(proj, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'move-me.jlb'), 'PRINT(1)\n');
  await page.click('.side-actions [title="Refresh"]');
  await page.waitForSelector('.tree-row:has-text("move-me.jlb")');
  await page.dragAndDrop('.tree-row:has-text("move-me.jlb")', '.tree-row:has-text("lib")');
  await page.waitForFunction(() => !document.querySelector('.tree-row[data-path$="move-me.jlb"]') || document.querySelector('.tree-row[data-path*="lib"][data-path$="move-me.jlb"]'));
  assert.ok(fs.existsSync(path.join(proj, 'lib', 'move-me.jlb')));
  assert.ok(!fs.existsSync(path.join(proj, 'move-me.jlb')));
  // Dropping onto a folder opens it, showing the moved file.
  await page.waitForSelector('.tree-row[data-path$="move-me.jlb"]');
  await page.focus('.tree-row:has-text("lib")');
  await page.keyboard.press('ArrowDown');
  assert.match(await page.evaluate(() => document.activeElement.dataset.path), /move-me\.jlb$/);
  await page.keyboard.press('ArrowLeft');
  assert.match(await page.evaluate(() => document.activeElement.dataset.path), /lib$/);
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => !document.querySelector('.tree-row[data-path$="move-me.jlb"]'));
});

test('hover info can wait for Ctrl', async () => {
  await page.evaluate(() => window.jlbIde.workspace.newFile('a = 1 & 0\n'));
  await page.evaluate(() => window.jlbIde.settings.set('editor.hoverCtrl', true));
  await page.waitForTimeout(100);
  assert.equal(await hoverText(1, '&'), '');
  await page.keyboard.down('Control');
  assert.match(await hoverText(1, '&'), /AND/);
  await page.keyboard.up('Control');
  await page.evaluate(() => window.jlbIde.settings.set('editor.hoverCtrl', false));
});

test('the welcome screen lists recent files', async () => {
  await page.evaluate(async () => { const ws = window.jlbIde.workspace; for (const d of [...ws.docs]) ws.closeNow(d); });
  await page.waitForSelector('.welcome-section h2:has-text("Recent files")');
  assert.match(await page.locator('.welcome').innerText(), /crash\.jlb/);
});

test('the syntax check lists several mistakes at once', async () => {
  await page.evaluate(() => window.jlbIde.workspace.newFile(''));
  await setText('x = 1\nIF x == 1 {\n  y = * 2\n}\nz = 3 3\n');
  const p = await problems();
  assert.match(p, /expected a value but found `\*`/);
  assert.match(p, /two statements on one line/);
});

test('knows where names exist: functions, FOR blocks, and lines that run later', async () => {
  await setText('PRINT(total)\ntotal = 1\nFUNC f(a) {\n    inside = a\n    RETURN inside + total\n}\nPRINT(inside)\nFOR i IN [1, 2] {\n    PRINT(i)\n}\nPRINT(i)\nPRINT(sq(2))\nFUNC sq(n) {\n    RETURN n * n\n}\ncount += 1\n');
  const p = await problems();
  assert.match(p, /total is used before it's given a value \(line 2 gives it one\)/);
  assert.match(p, /inside only exists inside f\(\)/);
  assert.match(p, /i only exists inside its own FOR or FAIL block/);
  assert.match(p, /sq\(\) is used before its FUNC line has run \(line 13\)/);
  assert.match(p, /count has no value yet/);
  assert.doesNotMatch(p, /Line 5\b/); // inside + total inside the function is fine
});

test('Problems lists every open file', async () => {
  fs.writeFileSync(path.join(proj, 'oops.jlb'), 'PRINT(oops)\n');
  await page.evaluate((p) => window.jlbIde.workspace.openFile(p), path.join(proj, 'oops.jlb'));
  await page.evaluate((p) => window.jlbIde.workspace.openFile(p), path.join(proj, 'guess.jlb'));
  const p = await problems();
  assert.match(p, /oops\.jlb/);
  assert.match(p, /oops is never given a value/);
  await page.click('.problem:has-text("oops is never given")');
  assert.equal(await page.evaluate(() => window.jlbIde.workspace.active.name), 'oops.jlb');
  await page.evaluate(() => window.jlbIde.settings.set('editor.problemsAllFiles', false));
  await page.evaluate((p) => window.jlbIde.workspace.openFile(p), path.join(proj, 'guess.jlb'));
  assert.doesNotMatch(await problems(), /oops/);
  await page.evaluate(() => window.jlbIde.settings.set('editor.problemsAllFiles', true));
});

test('suggests table entries and shows a command\'s inputs while typing', async () => {
  await page.evaluate(() => window.jlbIde.workspace.newFile(''));
  await setText('hero = [name: "Ann", hp: 10]\nhero.level = 2\nFUNC add(a, b) {\n    RETURN a + b\n}\n');
  await page.click('.cm-content');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('PRINT(hero.');
  await page.keyboard.type('h');
  await page.waitForSelector('.cm-tooltip-autocomplete');
  assert.match(await page.locator('.cm-tooltip-autocomplete').innerText(), /hp/);
  await page.keyboard.press('Escape');
  assert.match(await page.locator('.jlb-hint').innerText(), /PRINT\(a, b, \.\.\.\)/);
  await page.keyboard.type('p, ');
  assert.equal(await page.locator('.jlb-hint .on').innerText(), 'b');
  await page.keyboard.type('1)\nadd(1, ');
  assert.match(await page.locator('.jlb-hint').innerText(), /^add\(a, b\)/);
  assert.equal(await page.locator('.jlb-hint .on').innerText(), 'b');
  await page.keyboard.type('2)');
  assert.equal(await page.locator('.jlb-hint').count(), 0);
});

test('Quick-try answers INPUT, stops endless snippets, and loads a file', async () => {
  await page.click('.panel-tab:has-text("Quick-try")');
  const type = async (code) => {
    await page.click('.qt-input .cm-content');
    await page.keyboard.type(code);
    await page.keyboard.press('Enter');
  };
  const settle = () => page.waitForFunction(() => !document.querySelector('.qt-result.pending'));
  await type('who = INPUT("Who? ")');
  await page.waitForSelector('.qt-answer');
  await page.fill('.qt-answer', 'Ann');
  await page.keyboard.press('Enter');
  await settle();
  await type('who');
  await settle();
  assert.match(await page.locator('.qt-log').innerText(), /"Ann"\s*TEXT/);

  await page.evaluate(() => window.jlbIde.settings.set('quicktry.slowAfter', 1));
  await type('WHILE TRUE { }');
  await page.waitForSelector('.qt-result button:has-text("Stop")', { timeout: 4000 });
  await page.click('.qt-result button:has-text("Stop")');
  await settle();
  assert.match(await page.locator('.qt-log').innerText(), /Stopped\. The variables were cleared\./);

  await page.evaluate(() => window.jlbIde.workspace.newFile('FUNC double(n) {\n    RETURN n * 2\n}\n'));
  await page.evaluate(() => window.jlbIde.commands.run('quicktry.loadFile'));
  await settle();
  await type('double(21)');
  await settle();
  assert.match(await page.locator('.qt-log').innerText(), /Loaded untitled-\d+\.jlb[\s\S]*double\(21\)\n42\s*NUMBER/);
});

test('installs a plugin from a folder, and reloads it when its files change', async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'jlb-ide-test-plugin-'));
  fs.writeFileSync(path.join(src, 'plugin.json'), JSON.stringify({ id: 'hello-folder', name: 'Hello' }));
  const main = (t) => `export function activate(api) { api.layout.addStatus(api.ui.h('span.status-item.hello-status', '${t}'), 'right'); }`;
  fs.writeFileSync(path.join(src, 'main.js'), main('HELLO 1'));
  await dialog(src);
  await page.evaluate(() => window.jlbIde.commands.run('plugins.install'));
  await page.waitForSelector('.hello-status:has-text("HELLO 1")');
  assert.ok(fs.existsSync(path.join(config, 'plugins', 'hello-folder', 'main.js')));
  await page.bringToFront();
  fs.writeFileSync(path.join(config, 'plugins', 'hello-folder', 'main.js'), main('HELLO 2'));
  await page.waitForSelector('.hello-status:has-text("HELLO 2")', { timeout: 8000 });
  assert.equal(await page.locator('.hello-status').count(), 1);
});

test('backs up unsaved changes, and removes the backup on saving', async () => {
  await page.evaluate(() => window.jlbIde.settings.set('backups.delay', 1));
  // Start from no tabs (closing without saving drops their backups).
  await page.evaluate(() => {
    const ws = window.jlbIde.workspace;
    for (const d of [...ws.docs]) ws.closeNow(d);
  });
  await page.waitForTimeout(300);
  assert.equal(backupFiles().length, 0);
  await page.evaluate((p) => window.jlbIde.workspace.openFile(p), path.join(proj, 'guess.jlb'));
  await page.click('.cm-content');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('PRINT("backed up")');
  await page.waitForTimeout(1600);
  const found = backupFiles().find((b) => b.path === path.join(proj, 'guess.jlb'));
  assert.ok(found, 'a backup was written');
  assert.match(found.text, /PRINT\("backed up"\)$/);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(1600);
  assert.equal(backupFiles().filter((b) => b.path === path.join(proj, 'guess.jlb')).length, 0, 'undoing everything removes the backup');
  await page.keyboard.type('\n>> saved');
  await page.waitForTimeout(1600);
  assert.equal(backupFiles().length, 1);
  await page.evaluate(() => window.jlbIde.commands.run('file.save'));
  await page.waitForTimeout(400);
  assert.equal(backupFiles().length, 0, 'saving removes the backup');
});

test('brings back unsaved work after a crash', async () => {
  const file = path.join(proj, 'crash.jlb');
  await page.evaluate((p) => window.jlbIde.workspace.openFile(p), file);
  await page.click('.cm-content');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('PRINT("not saved")');
  await page.evaluate(() => window.jlbIde.workspace.newFile(''));
  await page.click('.cm-content');
  await page.keyboard.type('x = "an untitled tab"');
  await page.waitForTimeout(1600);
  assert.equal(backupFiles().length, 2);
  await restartIde();
  await page.waitForSelector('.toast:has-text("Brought back unsaved changes to crash.jlb")');
  const tabs = await page.evaluate(() => window.jlbIde.workspace.docs.map((d) => ({ name: d.name, path: d.path, text: window.jlbIde.workspace.textOf(d), dirty: window.jlbIde.workspace.isDirty(d) })));
  const c = tabs.find((t) => t.path === file);
  assert.ok(c.dirty && c.text.endsWith('PRINT("not saved")'), 'the file got its unsaved changes back');
  assert.ok(tabs.some((t) => !t.path && t.dirty && t.text === 'x = "an untitled tab"'), 'the untitled tab came back');
  assert.equal(fs.readFileSync(file, 'utf8').includes('not saved'), false, 'the file itself is untouched');
  assert.equal(backupFiles().length, 2, 'the tabs are backed up again by the new session');
  assert.equal(fs.readdirSync(path.join(config, 'backups')).length, 1, 'the old session\'s backups are gone');
});

test('keeps unsaved tabs when closing, and opens a backup apart if the file changed', async () => {
  const file = path.join(proj, 'crash.jlb');
  // Close "keeping unsaved changes" (what the window does with that setting on).
  await page.evaluate(async () => {
    const b = window.jlbIde.plugins.services.get('backups');
    await b.flush();
    await b.close(true);
  });
  // Meanwhile, the file is changed by something else.
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + '>> changed elsewhere\n');
  await restartIde({ crash: false });
  await page.waitForSelector('.toast:has-text("changed since the backup")');
  const tabs = await page.evaluate(() => window.jlbIde.workspace.docs.map((d) => ({ name: d.name, path: d.path, text: window.jlbIde.workspace.textOf(d), dirty: window.jlbIde.workspace.isDirty(d) })));
  const c = tabs.find((t) => t.path === file);
  assert.ok(c && !c.dirty && c.text.includes('changed elsewhere'), 'the file shows what is on disk');
  const apart = tabs.find((t) => t.name === 'crash (backup).jlb');
  assert.ok(apart && apart.dirty && apart.text.endsWith('PRINT("not saved")'), 'the backup opened in its own tab');
  assert.ok(tabs.some((t) => t.text === 'x = "an untitled tab"'));
  // Closing a tab without saving drops its backup.
  await page.evaluate(() => {
    const ws = window.jlbIde.workspace;
    for (const d of [...ws.docs]) if (!d.path) ws.closeNow(d);
  });
  await page.waitForTimeout(300);
  assert.equal(backupFiles().length, 0);
});

const clickGutter = async (line) => {
  const p = await page.evaluate((n) => {
    const v = window.jlbIde.editor.view;
    const c = v.coordsAtPos(v.state.doc.line(n).from);
    const g = document.querySelector('.cm-bp-gutter').getBoundingClientRect();
    return { x: g.x + g.width / 2, y: (c.top + c.bottom) / 2 };
  }, line);
  await page.mouse.click(p.x, p.y);
};
/** The Variables section's rows, as "name = value". */
const varRows = () => page.$$eval('.dbg-sec-variables .dbg-var', (rows) => rows.map((r) => `${r.querySelector('.dbg-name').textContent} = ${r.querySelector('.dbg-value').textContent}`));
const editorLine = () => page.evaluate(() => {
  const v = window.jlbIde.editor.view;
  return v.state.doc.lineAt(v.state.selection.main.head).number;
});

test('the debugger stops at breakpoints, steps, and shows every variable', async () => {
  const file = path.join(proj, 'game.jlb');
  fs.writeFileSync(file, 'hero = [name: "Ann", hp: 10, bag: [1, 2]]\nFUNC heal(who, amount) {\n    LOCAL before = who.hp\n    who.hp += amount\n    RETURN who.hp - before\n}\ntotal = 0\nFOR i IN 1 TO 3 {\n    total += heal(hero, i)\n}\nname = INPUT("Name? ")\nPRINT("Hi", name, total)\nPRINT(10 / (total - 6))\n');
  await page.evaluate((p) => window.jlbIde.workspace.openFile(p), file);
  await clickGutter(4);
  assert.equal(await page.locator('.bp-dot').count() >= 1, true);
  await page.waitForTimeout(400); // breakpoints are remembered a moment later
  assert.deepEqual(JSON.parse(await page.evaluate(() => window.jlbIde.settings.get('debugger.breakpoints')))[file], [4]);

  // Run stops at the breakpoint, because one is set.
  await page.keyboard.press('F5');
  await page.waitForSelector('.dbg-status.paused');
  assert.match(await page.locator('.dbg-status').innerText(), /Stopped at heal\(\), line 4/);
  assert.equal(await editorLine(), 4);
  assert.equal(await page.locator('.cm-debug-line').count(), 1);
  const stack = await page.locator('.dbg-stack').innerText();
  assert.match(stack, /heal\(\)\s+game\.jlb:4\s+top level\s+game\.jlb:9/);
  let rows = await varRows();
  assert.ok(rows.includes('who = [name: "Ann", hp: 10, bag: [1, 2]]'), rows.join('\n'));
  assert.ok(rows.includes('amount = 1') && rows.includes('before = 10') && rows.includes('total = 0'), rows.join('\n'));
  // Tables open up to show their entries.
  await page.click('.dbg-var.table:has(.dbg-name:text-is("who"))');
  rows = await varRows();
  assert.deepEqual(rows.slice(0, 4), ['who = 3 entries', 'name = "Ann"', 'hp = 10', 'bag = [1, 2]']);

  // Watch an expression.
  await page.fill('.dbg-watch-input', 'who.hp * 2');
  await page.press('.dbg-watch-input', 'Enter');
  await page.waitForSelector('.dbg-watch:has-text("20")');

  // Hovering a name shows its value.
  await page.mouse.move(5, 5);
  const c = await coords(5, 'amount');
  await page.mouse.move(c.x, c.y);
  await page.waitForSelector('.hover-card:has-text("amount = 1")');

  // Step over: the next line, and hp shows it changed.
  await page.keyboard.press('F10');
  await page.waitForFunction(() => document.querySelector('.dbg-status')?.innerText.includes('line 5'));
  assert.equal(await editorLine(), 5);
  // What changed since the last stop stands out: hp, and the table it's in.
  assert.deepEqual(await page.$$eval('.dbg-sec-variables .dbg-var.changed', (rs) => rs.map((r) => r.querySelector('.dbg-name').textContent + ' = ' + r.querySelector('.dbg-value').textContent)), ['who = 3 entries', 'hp = 11']);
  await page.waitForSelector('.dbg-watch:has-text("22")');

  // Step out: back in the loop.
  await page.keyboard.press('Shift+F11');
  await page.waitForFunction(() => document.querySelector('.dbg-status')?.innerText.includes('line 9'));

  // Remove the breakpoint and carry on: INPUT still works, then the error stops it.
  await page.click('.dbg-bps .dbg-x', { force: true });
  await page.waitForFunction(() => !document.querySelector('.dbg-bps'));
  await page.keyboard.press('F8');
  await page.waitForSelector('.out-input:not([disabled])');
  await page.waitForFunction(() => document.querySelector('.out')?.innerText.includes('Name?'));
  await page.fill('.out-input', 'Sam');
  await page.press('.out-input', 'Enter');
  await page.waitForSelector('.dbg-status.error');
  assert.match(await page.locator('.dbg-status').innerText(), /can't divide by zero/);
  assert.ok((await varRows()).includes('name = "Sam"'));
  await page.keyboard.press('F8');
  // The program ends with its crash report (the Crash panel opens).
  await page.waitForFunction(() => !window.jlbIde.runner.run_);
  await page.waitForSelector('.crash-msg:has-text("can\'t divide by zero")');
  assert.match(await page.locator('.dbg-status').innerText(), /Not debugging/);
  assert.equal(await page.locator('.cm-debug-line').count(), 0);
  assert.equal(await page.locator('.dbg-strip').isVisible(), false);
});

test('Start debugging stops at the first line, and Pause stops a loop', async () => {
  const file = path.join(proj, 'loop.jlb');
  fs.writeFileSync(file, 'n = 0\nWHILE TRUE {\n    n += 1\n}\n');
  await page.evaluate((p) => window.jlbIde.workspace.openFile(p), file);
  await page.keyboard.press('F6');
  await page.waitForSelector('.dbg-status.paused:has-text("line 1")');
  assert.match(await page.locator('.out').innerText(), /Debugging loop\.jlb/);
  await page.keyboard.press('F8');
  await page.waitForSelector('.dbg-status.running');
  await page.waitForTimeout(300);
  await page.click('.dbg-strip .dbg-btn[title^="Pause"]');
  await page.waitForSelector('.dbg-status.paused');
  assert.match(await page.locator('.dbg-status').innerText(), /Paused/);
  const n = Number((await page.locator('.dbg-var:has(.dbg-name:text-is("n")) .dbg-value').innerText()).trim());
  assert.ok(n > 0, `n is ${n}`);
  await page.keyboard.press('Shift+F5');
  await page.waitForFunction(() => document.querySelector('.out')?.innerText.includes('Stopped'));
  assert.equal(await page.locator('.dbg-strip').isVisible(), false);
});

test('breakpoints come back with their file, and Run ignores them when asked', async () => {
  const file = path.join(proj, 'game.jlb');
  await page.evaluate(() => window.jlbIde.commands.run('debug.clear'));
  await page.evaluate(() => {
    const ws = window.jlbIde.workspace;
    for (const d of [...ws.docs]) ws.closeNow(d);
  });
  await page.evaluate((p) => window.jlbIde.workspace.openFile(p), path.join(proj, 'loop.jlb'));
  await page.evaluate((p) => window.jlbIde.workspace.openFile(p), file);
  await clickGutter(12);
  await page.evaluate(() => {
    const ws = window.jlbIde.workspace;
    ws.closeNow(ws.active);
  });
  await page.evaluate((p) => window.jlbIde.workspace.openFile(p), file);
  await page.evaluate(() => window.jlbIde.layout.showView('debug'));
  await page.waitForTimeout(200);
  assert.match(await page.locator('.dbg-bps').innerText(), /^game\.jlb\s+line 12$/);
  assert.equal(await page.locator('.cm-bp-gutter .bp-dot:visible').count(), 1);
  await page.evaluate(() => window.jlbIde.settings.set('debugger.stopAtBreakpoints', false));
  await page.keyboard.press('F5');
  await page.waitForSelector('.out-input:not([disabled])');
  await page.fill('.out-input', 'Al');
  await page.press('.out-input', 'Enter');
  await page.waitForFunction(() => !window.jlbIde.runner.run_);
  await page.click('.panel-tab:has-text("Output")');
  assert.match(await page.locator('.out').innerText(), /Running game\.jlb[\s\S]*Ended with an error/);
  await page.evaluate(() => window.jlbIde.settings.set('debugger.stopAtBreakpoints', true));
  await page.evaluate(() => window.jlbIde.commands.run('debug.clear'));
  assert.equal(await page.locator('.cm-bp-gutter .bp-dot:visible').count(), 0);
  await page.waitForFunction(() => !document.querySelector('.dbg-bps'));
  assert.equal(await page.evaluate(() => window.jlbIde.settings.get('debugger.breakpoints')), '{}');
});

test('the table viewer shows a list of tables as a grid', async () => {
  await page.click('.panel-tab:has-text("Quick-try")');
  const type = async (code) => {
    await page.click('.qt-input .cm-content');
    await page.keyboard.type(code);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('.qt-result.pending'));
  };
  await type('players = [[name: "Ann", hp: 10, bag: [1, 2]], [name: "Bo", hp: 7], [name: "Cy", hp: 12, team: "red"]]');
  await type('players');
  await page.click('.qt-entry:last-child .qt-view');
  await page.waitForSelector('.tv-grid');
  const grid = () => page.$$eval('.tv-grid:not(.tv-named) tr', (rows) => rows.map((r) => [...r.children].map((c) => c.textContent.replace(/[▲▼]/, '').trim()).join(' | ')));
  assert.deepEqual(await grid(), ['# | name | hp | bag | team', '1 | "Ann" | 10 | [1, 2] | ', '2 | "Bo" | 7 |  | ', '3 | "Cy" | 12 |  | "red"']);
  assert.match(await page.locator('.tv-count').innerText(), /3 items/);
  // Sort by hp, then the other way.
  await page.click('.tv-sort:has-text("hp")');
  assert.deepEqual((await grid()).slice(1).map((r) => r.split(' | ')[1]), ['"Bo"', '"Ann"', '"Cy"']);
  await page.click('.tv-sort:has-text("hp")');
  assert.deepEqual((await grid()).slice(1).map((r) => r.split(' | ')[1]), ['"Cy"', '"Ann"', '"Bo"']);
  // Filter.
  await page.fill('.tv-filter', 'red');
  assert.equal((await grid()).length, 2);
  await page.fill('.tv-filter', '');
  // A table inside opens, and the path leads back.
  await page.click('.tv-open:has-text("[1, 2]")');
  assert.match(await page.locator('.tv-crumbs').innerText(), /players\s*›\s*1\.bag/);
  assert.deepEqual(await grid(), ['# | value | type', '1 | 1 | NUMBER', '2 | 2 | NUMBER']);
  await page.click('.tv-crumb:has-text("players")');
  assert.equal((await grid()).length, 4);
});

test('the debugger opens big tables in the table viewer and loads them in full', async () => {
  const file = path.join(proj, 'big.jlb');
  fs.writeFileSync(file, 'rows = []\nFOR i IN 1 TO 300 {\n    INSERT(rows, [n: i, sq: i * i], -1)\n}\nPRINT(LEN(rows))\n');
  await page.evaluate((p) => window.jlbIde.workspace.openFile(p), file);
  await page.evaluate(() => window.jlbIde.commands.run('debug.clear'));
  await clickGutter(5);
  await page.keyboard.press('F5');
  await page.waitForSelector('.dbg-status.paused:has-text("line 5")');
  await page.hover('.dbg-sec-variables .dbg-var:has(.dbg-name:text-is("rows"))');
  await page.click('.dbg-sec-variables .dbg-var:has(.dbg-name:text-is("rows")) .dbg-view');
  await page.waitForSelector('.tv-grid');
  assert.match(await page.locator('.tableview').innerText(), /Showing 200 of 300 entries/);
  await page.click('.tv-note button:has-text("Load all")');
  await page.waitForFunction(() => document.querySelector('.tv-count')?.textContent.startsWith('300 items'));
  assert.doesNotMatch(await page.locator('.tableview').innerText(), /Showing/);
  assert.match(await page.locator('.tv-grid tbody tr:last-child').innerText(), /300\s+300\s+90000/);
  await page.keyboard.press('Shift+F5');
  await page.waitForFunction(() => !window.jlbIde.runner.run_);
  await page.evaluate(() => window.jlbIde.commands.run('debug.clear'));
});

test('Compare runs both interpreters and marks where they differ', async () => {
  const file = path.join(proj, 'cmp.jlb');
  fs.writeFileSync(file, 'name = INPUT("Name? ")\nPRINT("Hi " + name)\nPRINT(0.1 + 0.2, 2 ^ 70)\n');
  await page.evaluate((p) => window.jlbIde.workspace.openFile(p), file);
  await page.keyboard.press('Control+Shift+F5');
  await page.waitForSelector('.cmp-head');
  await page.click('.cmp-head button:has-text("Input")');
  await page.fill('.cmp-input', 'Sam');
  await page.click('.cmp-head button:has-text("Compare")');
  await page.waitForSelector('.cmp-verdict');
  assert.match(await page.locator('.cmp-verdict').innerText(), /Same output from both interpreters/);
  const cols = await page.locator('.cmp-table').innerText();
  assert.match(cols, /Name\? Hi Sam/);
  assert.match(cols, /0\.3 1180591620717411303424/);
  assert.match(await page.locator('.cmp-cols').innerText(), /Rust[\s\S]*exit 0[\s\S]*C[\s\S]*exit 0/);
  // A pretend "C interpreter" that prints something else shows the difference.
  const fake = path.join(os.tmpdir(), `fake-jlb-c-${process.pid}.sh`);
  fs.writeFileSync(fake, '#!/bin/sh\ncat > /dev/null\necho "Name? Hi Sam"\necho "0.30000000000000004 1180591620717411303424"\n');
  fs.chmodSync(fake, 0o755);
  await page.evaluate((p) => window.jlbIde.settings.set('interpreters.c', p), fake);
  await page.click('.cmp-head button:has-text("Compare")');
  await page.waitForSelector('.cmp-verdict.bad');
  assert.match(await page.locator('.cmp-verdict').innerText(), /differ, starting on line 2/);
  assert.equal(await page.locator('.cmp-line.old').innerText(), '0.3 1180591620717411303424');
  assert.equal(await page.locator('.cmp-line.new').innerText(), '0.30000000000000004 1180591620717411303424');
  await page.evaluate(() => window.jlbIde.settings.set('interpreters.c', ''));
});

test('the test runner finds tests, runs them with both interpreters, and saves new expected output', async () => {
  const dir = path.join(proj, 'tests');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'good.jlb'), 'PRINT(1 + 1)\n');
  fs.writeFileSync(path.join(dir, 'good.out'), '2\n');
  fs.writeFileSync(path.join(dir, 'asks.jlb'), 'n = NUM(INPUT())\nPRINT(n * 2)\n');
  fs.writeFileSync(path.join(dir, 'asks.in'), '21\n');
  fs.writeFileSync(path.join(dir, 'asks.out'), '42\n');
  fs.writeFileSync(path.join(dir, 'wrong.jlb'), 'PRINT("a")\nPRINT("b")\n');
  fs.writeFileSync(path.join(dir, 'wrong.out'), 'a\nc\n');
  fs.writeFileSync(path.join(dir, 'not-a-test.jlb'), 'PRINT(1)\n');
  await page.evaluate((p) => window.jlbIde.workspace.setFolder(p), proj);
  await page.click('.panel-tab:has-text("Tests")');
  await page.waitForSelector('.tst-item');
  const names = await page.$$eval('.tst-name', (e) => e.map((x) => x.textContent));
  assert.deepEqual(names.filter((n) => n.startsWith('tests/')), ['tests/asks.jlb', 'tests/good.jlb', 'tests/wrong.jlb']);
  await page.click('.tst-head button:has-text("Run all")');
  await page.waitForFunction(() => document.querySelectorAll('.tst-chip').length >= 6 && !document.querySelector('.tst-chip.running') && document.querySelector('.tst-head')?.innerText.includes('Run all'));
  const row = (n) => page.locator(`.tst-item:has(.tst-name:text-is("tests/${n}.jlb"))`);
  assert.match(await row('good').innerText(), /Rust ✓[\s\S]*C ✓/);
  assert.match(await row('asks').innerText(), /Rust ✓[\s\S]*C ✓/);
  assert.match(await row('wrong').innerText(), /Rust ✗[\s\S]*C ✗/);
  await row('wrong').click();
  const detail = page.locator('.tst-detail');
  assert.match(await detail.innerText(), /printed something different/);
  const rows = await page.locator('.tst-detail .tst-diff').first().locator('.tst-row').evaluateAll((r) => r.map((x) => x.className.replace('tst-row ', '') + ':' + x.textContent.slice(1)));
  assert.deepEqual(rows, ['same:a', 'old:c', 'new:b']);
  // Accept Rust's output as the expected output.
  await page.click('.tst-detail button:has-text("Use Rust")');
  await page.click('.dialog-buttons button:has-text("Save")');
  await page.waitForFunction(() => /Rust ✓[\s\S]*C ✓/.test([...document.querySelectorAll('.tst-item')].find((e) => e.textContent.includes('wrong'))?.innerText || ''));
  assert.equal(fs.readFileSync(path.join(dir, 'wrong.out'), 'utf8'), 'a\nb\n');
  // Make a test from the current file.
  await page.evaluate((p) => window.jlbIde.workspace.openFile(p), path.join(dir, 'not-a-test.jlb'));
  await page.evaluate(() => { window.jlbIde.commands.run('tests.fromFile'); }); // (it waits for the dialog)
  await page.click('.dialog-buttons button:has-text("Make test")');
  await page.waitForSelector('.tst-name:text-is("tests/not-a-test.jlb")');
  assert.equal(fs.readFileSync(path.join(dir, 'not-a-test.out'), 'utf8'), '1\n');
});

test('no errors in the page', () => {
  assert.deepEqual(errors.filter((e) => !/favicon/.test(e)), []);
});
