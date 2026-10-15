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
  page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(URL_);
  await page.waitForSelector('body.ready');
});

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

test('no errors in the page', () => {
  assert.deepEqual(errors.filter((e) => !/favicon/.test(e)), []);
});
