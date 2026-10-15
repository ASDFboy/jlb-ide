// JLB IDE: starts everything up.

import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import './styles.css';

import { getCurrentWindow } from '@tauri-apps/api/window';
import { Emitter } from './core/emitter.js';
import { inTauri, invoke } from './core/backend.js';
import { Settings } from './core/settings.js';
import { Commands } from './core/commands.js';
import { Layout } from './core/layout.js';
import { Editor } from './core/editor.js';
import { Workspace } from './core/workspace.js';
import { Language } from './core/language.js';
import { Runner } from './core/runner.js';
import { Plugins } from './core/plugins.js';
import { openSettings, defineAppearance } from './core/settings-view.js';
import { h, choose } from './core/ui.js';

import checker from './plugins/checker.js';
import crash from './plugins/crash.js';
import explainer from './plugins/explainer.js';
import quicktry from './plugins/quicktry.js';
import complete from './plugins/complete.js';
import navigate from './plugins/navigate.js';
import docs from './plugins/docs.js';
import backups from './plugins/backups.js';
import debuggerPlugin from './plugins/debugger.js';
import compare from './plugins/compare.js';
import testsPlugin from './plugins/tests.js';
import tableview from './plugins/tableview.js';

const BUILT_IN = [crash, explainer, checker, quicktry, complete, navigate, docs, backups, tableview, debuggerPlugin, compare, testsPlugin];

async function start() {
  const ide = { events: new Emitter() };
  window.jlbIde = ide; // for debugging from the developer tools
  ide.settings = new Settings();
  await ide.settings.load();
  ide.settings.events.on('change', (k, v) => ide.events.emit('settings-change', k, v));
  defineAppearance(ide);
  ide.commands = new Commands(ide.settings);
  ide.layout = new Layout(ide, document.getElementById('app'));
  ide.editor = new Editor(ide, ide.layout.editorHost);
  ide.workspace = new Workspace(ide);
  ide.language = new Language(ide);
  ide.runner = new Runner(ide);
  ide.plugins = new Plugins(ide);

  registerCommands(ide);
  ide.layout.addView(ide.workspace.explorerView());
  ide.layout.addView(ide.plugins.view());
  ide.layout.addView({ id: 'settings', title: 'Settings (Ctrl+,)', icon: 'gear', order: 100, bottom: true, run: () => openSettings(ide) });
  ide.layout.addPanel(ide.runner.panel());
  ide.layout.addPanel(ide.language.problemsPanel());
  ide.layout.addToolbar(ide.runner.toolbar(), 'right');
  statusBar(ide);

  await ide.runner.init();
  for (const p of BUILT_IN) ide.plugins.add(p);
  await ide.plugins.loadInstalled();
  await ide.plugins.startAll();
  ide.plugins.watch();
  ide.layout.showView('explorer');
  await ide.workspace.restore();
  // Files the IDE was opened with (from the command line, or "Open with JLB IDE").
  for (const p of await invoke('startup_files').catch(() => [])) await ide.workspace.openFile(p);

  window.addEventListener('keydown', (e) => ide.commands.handleKey(e), true);
  guardClose(ide);
  document.body.classList.add('ready');
}

function registerCommands(ide) {
  const c = ide.commands;
  const ws = ide.workspace;
  const lay = ide.layout;
  const s = ide.settings;
  const add = (id, title, run, key, category = 'File') => c.register({ id, title, run, key, category });
  add('file.new', 'New file', () => ws.newFile(), 'Ctrl+N');
  add('file.open', 'Open file…', () => ws.openDialog(), 'Ctrl+O');
  add('file.openFolder', 'Open folder…', () => ws.openFolderDialog(), 'Ctrl+Shift+O');
  add('file.save', 'Save', () => ws.save(), 'Ctrl+S');
  add('file.saveAs', 'Save as…', () => ws.saveAs(), 'Ctrl+Shift+S');
  add('file.saveAll', 'Save all', () => ws.saveAll(), 'Ctrl+Alt+S');
  add('file.close', 'Close file', () => ws.close(), 'Ctrl+W');
  add('file.closeFolder', 'Close folder', () => ws.setFolder(null));
  add('tab.next', 'Next file', () => ws.cycle(1), 'Ctrl+Tab', 'View');
  add('tab.prev', 'Previous file', () => ws.cycle(-1), 'Ctrl+Shift+Tab', 'View');
  add('view.palette', 'Show all commands', () => c.palette(), 'Ctrl+Shift+P', 'View');
  add('view.settings', 'Open settings', (section) => openSettings(ide, typeof section === 'string' ? section : undefined), 'Ctrl+,', 'View');
  add('view.shortcuts', 'Change keyboard shortcuts', () => openSettings(ide, 'Keyboard shortcuts'), null, 'View');
  add('view.sidebar', 'Show or hide the sidebar', () => s.set('layout.sidebarOpen', !s.get('layout.sidebarOpen')), 'Ctrl+B', 'View');
  add('view.panel', 'Show or hide the bottom panel', () => s.set('layout.bottomOpen', !s.get('layout.bottomOpen')), 'Ctrl+J', 'View');
  add('view.explorer', 'Show files', () => lay.showView('explorer'), 'Ctrl+Shift+E', 'View');
  add('view.output', 'Show output', () => lay.showPanel('output'), 'Ctrl+Shift+U', 'View');
  add('view.problems', 'Show problems', () => lay.showPanel('problems'), 'Ctrl+Shift+M', 'View');
  add('view.theme', 'Switch between night and day themes', () => {
    const now = document.documentElement.dataset.theme;
    s.set('ui.theme', now === 'night' ? 'day' : 'night');
  }, null, 'View');
  add('run.start', 'Run the current file', () => ide.runner.run(), 'F5', 'Run');
  add('run.stop', 'Stop the running program', () => ide.runner.stop(), 'Shift+F5', 'Run');
  add('run.rust', 'Run with the Rust interpreter', () => s.set('run.interpreter', 'rust'), null, 'Run');
  add('run.c', 'Run with the C interpreter', () => s.set('run.interpreter', 'c'), null, 'Run');
  add('plugins.reload', 'Reload plugins', () => ide.plugins.reload(), null, 'Plugins');
  add('plugins.create', 'Create a plugin', () => ide.plugins.createExample(), null, 'Plugins');
  add('plugins.install', 'Install a plugin from a folder', () => ide.plugins.installFromFolder(), null, 'Plugins');
  add('plugins.show', 'Show plugins', () => lay.showView('plugins'), null, 'Plugins');
}

function statusBar(ide) {
  const pos = h('button.status-item', { title: 'Go to line', on: { click: () => ide.commands.run('navigate.line') } });
  const probs = h('button.status-item.probs', { title: 'Show problems', on: { click: () => ide.layout.showPanel('problems') } });
  const interp = h('button.status-item', { title: 'Choose the interpreter', on: { click: () => ide.commands.palette('Run with') } });
  const lang = h('span.status-item', 'JLB');
  ide.layout.addStatus(probs, 'left');
  ide.layout.addStatus(pos, 'right');
  ide.layout.addStatus(lang, 'right');
  ide.layout.addStatus(interp, 'right');
  ide.events.on('editor-cursor', (state) => {
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const sel = state.selection.main.to - state.selection.main.from;
    pos.textContent = `Line ${line.number}, column ${head - line.from + 1}${sel ? ` (${sel} selected)` : ''}`;
    pos.hidden = !ide.workspace.active;
    lang.hidden = !ide.workspace.active;
  });
  ide.events.on('problems', (list) => {
    const e = list.filter((p) => p.severity === 'error').length;
    const w = list.length - e;
    probs.textContent = !list.length ? 'No problems' : [e && `${e} error${e > 1 ? 's' : ''}`, w && `${w} warning${w > 1 ? 's' : ''}`].filter(Boolean).join(', ');
    probs.className = 'status-item probs' + (e ? ' has-errors' : w ? ' has-warnings' : '');
  });
  const showInterp = () => {
    const it = ide.runner.current();
    interp.textContent = it ? `${it.name} interpreter${it.path ? '' : ' (not set up)'}` : '';
  };
  ide.events.on('interpreter-change', showInterp);
  showInterp();
  probs.textContent = 'No problems';
}

/** Asks about unsaved changes before the window closes. */
function guardClose(ide) {
  const unsaved = () => ide.workspace.docs.filter((d) => ide.workspace.isDirty(d));
  if (!inTauri) {
    window.addEventListener('beforeunload', (e) => {
      if (unsaved().length) e.preventDefault();
    });
    return;
  }
  const win = getCurrentWindow();
  let closing = false;
  win.onCloseRequested(async (e) => {
    if (closing) return;
    e.preventDefault();
    const list = unsaved();
    const backups = ide.plugins.services.get('backups');
    let keep = false;
    if (list.length && backups?.keepOnClose()) {
      // Unsaved tabs stay as they are and come back next time.
      await backups.flush();
      keep = true;
    } else if (list.length) {
      const names = list.map((d) => d.name).join(', ');
      const answer = await choose(`Save changes before closing?`, [
        { label: "Don't save", value: 'discard', danger: true },
        { label: 'Cancel', value: null },
        { label: 'Save all', value: 'save', primary: true },
      ], { detail: `Unsaved: ${names}` });
      if (!answer) return;
      if (answer === 'save') {
        for (const d of list) if (!(await ide.workspace.save(d, { quiet: true }))) return;
      }
    }
    await backups?.close(keep);
    closing = true;
    await ide.settings.saveNow();
    if (ide.runner.run_) await ide.runner.stop(true);
    await invoke('repl_reset').catch(() => {});
    win.destroy();
  });
}

start().catch((e) => {
  console.error(e);
  document.getElementById('app').textContent = 'JLB IDE couldn\'t start: ' + (e?.message || e);
});
