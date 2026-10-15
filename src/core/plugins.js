// The plugin host. Built-in features and installed plugins use the same API
// (documented in docs/plugins.md). Everything a plugin registers is tracked, so
// switching it off removes it cleanly, with no restart.

import * as cmState from '@codemirror/state';
import * as cmView from '@codemirror/view';
import * as cmLanguage from '@codemirror/language';
import * as cmAutocomplete from '@codemirror/autocomplete';
import * as cmLint from '@codemirror/lint';
import * as cmCommands from '@codemirror/commands';
import * as lezerHighlight from '@lezer/highlight';
import { h, clear, icon, toast, confirm, prompt, choose, contextMenu } from './ui.js';
import { invoke, pickOpen } from './backend.js';
import { join, basename } from './paths.js';
import * as langData from '../lang/data.js';

export const API_VERSION = 1;
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export class Plugins {
  constructor(ide) {
    this.ide = ide;
    this.list = new Map();
    this.services = new Map();
    ide.settings.define({
      key: 'plugins.autoReload',
      title: 'Reload plugins when their files change',
      description: 'Handy while writing a plugin: save main.js and see the change. Checks every 2 seconds while the IDE window is in front.',
      type: 'boolean',
      default: true,
      section: 'Plugins',
    });
  }

  /** Watches the plugins folder (cheaply: sizes and times only) and reloads on a change. */
  watch() {
    let last = null;
    let busy = false;
    const tick = async () => {
      if (busy || !this.ide.settings.get('plugins.autoReload') || document.hidden || !document.hasFocus()) return;
      busy = true;
      try {
        const stamp = await invoke('plugins_stamp');
        if (last !== null && stamp !== last) await this.reload({ note: 'Plugins reloaded (their files changed)' });
        last = stamp;
      } catch {
        // An older backend without plugins_stamp: nothing to watch.
        clearInterval(this.watchTimer);
      }
      busy = false;
    };
    tick();
    this.watchTimer = setInterval(tick, 2000);
  }

  /** Copies a plugin's folder (one with a plugin.json) into the plugins folder and starts it. */
  async installFromFolder(from) {
    from = from || (await pickOpen({ folder: true }));
    if (!from) return;
    let dest;
    try {
      dest = await invoke('install_plugin', { from, replace: false });
    } catch (e) {
      const msg = String(e?.message || e);
      const m = msg.match(/^already installed: (.+)$/);
      if (!m) return toast(`Couldn't install that plugin: ${msg}`, { kind: 'error', timeout: 8000 });
      if (!(await confirm(`A plugin called ${m[1]} is already installed. Replace it with this one?`, { ok: 'Replace' }))) return;
      try {
        dest = await invoke('install_plugin', { from, replace: true });
      } catch (e2) {
        return toast(`Couldn't install that plugin: ${String(e2?.message || e2)}`, { kind: 'error', timeout: 8000 });
      }
    }
    await this.reload({ note: `Installed the plugin from ${basename(from)}` });
    return dest;
  }

  /**
   * Adds a plugin. plugin: { id, name, description, version, author, builtin,
   * essential, activate(api), deactivate(), settings: [definitions] }
   */
  add(plugin) {
    if (!ID_RE.test(plugin.id || '')) throw new Error(`"${plugin.id}" isn't a valid plugin id (use lowercase letters, digits and dashes)`);
    if (this.list.has(plugin.id)) throw new Error(`there's already a plugin called ${plugin.id}`);
    const p = { version: '1.0.0', description: '', ...plugin, active: false, disposers: [], error: null };
    this.list.set(p.id, p);
    if (!p.essential) {
      this.ide.settings.define({
        key: `plugins.${p.id}.enabled`,
        title: p.name,
        description: p.description,
        type: 'boolean',
        default: p.enabledByDefault !== false,
        section: p.builtin ? 'Features' : 'Plugins',
        owner: p.id,
      });
    }
    for (const def of p.settings || []) this.ide.settings.define({ section: p.name, ...def, key: this.key(p, def.key), owner: p.id });
    return p;
  }

  key(p, k) {
    return k.startsWith(p.id + '.') ? k : `${p.id}.${k}`;
  }

  enabled(p) {
    return p.essential || this.ide.settings.get(`plugins.${p.id}.enabled`) !== false;
  }

  async startAll() {
    for (const p of this.list.values()) if (this.enabled(p)) await this.activate(p);
    this.ide.settings.onChange('plugins.', async (v, key) => {
      const m = key.match(/^plugins\.(.+)\.enabled$/);
      const p = m && this.list.get(m[1]);
      if (!p) return;
      if (v && !p.active) await this.activate(p);
      if (!v && p.active) this.deactivate(p);
      this.ide.events.emit('plugins-changed');
    });
  }

  async activate(p) {
    if (p.active) return;
    p.error = null;
    p.disposers = [];
    p.active = true;
    try {
      if (p.style) p.disposers.push(this.addStyle(p.style));
      await p.activate?.(this.api(p));
    } catch (e) {
      console.error(`[jlb-ide] the plugin ${p.id} failed to start:`, e);
      p.error = String(e?.message || e);
      this.deactivate(p);
      p.error = String(e?.message || e);
      toast(`The plugin "${p.name}" couldn't start: ${p.error}`, { kind: 'error', timeout: 8000 });
    }
    this.ide.events.emit('plugins-changed');
  }

  deactivate(p) {
    if (!p.active) return;
    try {
      p.deactivate?.();
    } catch (e) {
      console.error(`[jlb-ide] the plugin ${p.id} failed to stop:`, e);
    }
    for (const d of p.disposers.reverse()) {
      try {
        d();
      } catch (e) {
        console.error(e);
      }
    }
    p.disposers = [];
    p.active = false;
  }

  addStyle(css) {
    const el = h('style', css);
    document.head.append(el);
    return () => el.remove();
  }

  /** The API object a plugin's activate(api) receives. */
  api(p) {
    const ide = this.ide;
    const track = (dispose) => {
      p.disposers.push(dispose);
      return dispose;
    };
    const settingKey = (k) => (k.includes('.') ? k : `${p.id}.${k}`);
    return {
      apiVersion: API_VERSION,
      plugin: { id: p.id, name: p.name, version: p.version, folder: p.folder || null },

      /** CodeMirror's modules, so plugins can build editor extensions. */
      cm: { state: cmState, view: cmView, language: cmLanguage, autocomplete: cmAutocomplete, lint: cmLint, commands: cmCommands, highlight: lezerHighlight },

      /** What the IDE knows about .jlb: KEYWORDS, BUILTINS, OPERATORS and more. */
      jlb: langData,

      events: {
        /** Events: file-open, file-save, file-close, active-change, editor-change, doc-change, editor-cursor,
         *  folder-change, problems, run-start, run-output, run-exit, crash, settings-change. */
        on: (name, fn) => track(ide.events.on(name, fn)),
        emit: (name, ...args) => ide.events.emit(`${p.id}:${name}`, ...args),
      },

      settings: {
        define: (def) => track(ide.settings.define({ section: p.name, ...def, key: settingKey(def.key), owner: p.id })),
        get: (k) => ide.settings.get(settingKey(k)),
        set: (k, v) => ide.settings.set(settingKey(k), v),
        onChange: (k, fn) => track(ide.settings.onChange(settingKey(k), fn)),
      },

      commands: {
        register: (cmd) => track(ide.commands.register({ category: p.name, ...cmd })),
        run: (id, ...args) => ide.commands.run(id, ...args),
      },

      editor: {
        get view() { return ide.editor.view; },
        get text() { return ide.editor.text; },
        addExtension: (ext) => track(ide.editor.addExtension(ext)),
        goTo: (line, col) => ide.editor.goTo(line, col),
        insert: (text) => ide.editor.view.dispatch(ide.editor.view.state.replaceSelection(text)),
        selection: () => {
          const { from, to } = ide.editor.view.state.selection.main;
          return ide.editor.view.state.sliceDoc(from, to);
        },
        focus: () => ide.editor.focus(),
      },

      workspace: {
        get active() { return ide.workspace.active; },
        get folder() { return ide.workspace.folder; },
        get files() { return ide.workspace.docs; },
        openFile: (path) => ide.workspace.openFile(path),
        newFile: (text) => ide.workspace.newFile(text),
        save: () => ide.workspace.save(),
        textOf: (doc) => ide.workspace.textOf(doc),
        /** True when the tab has changes that aren't saved. */
        isDirty: (doc) => ide.workspace.isDirty(doc),
        /** Replaces a tab's text, as an edit that shows as unsaved. */
        setText: (doc, text) => ide.workspace.setText(doc, text),
        /** Changes part of a tab's text: { from, to, insert } or a list of them. Undoable, shows as unsaved. */
        edit: (doc, changes) => ide.workspace.edit(doc, changes),
        activate: (doc) => ide.workspace.activate(doc),
        /** True once the files from last time have been reopened (see the workspace-restored event). */
        get restored() { return !!ide.workspace.restored; },
      },

      layout: {
        addView: (view) => track(ide.layout.addView(view)),
        addPanel: (panel) => track(ide.layout.addPanel(panel)),
        showView: (id) => ide.layout.showView(id),
        showPanel: (id, opts) => ide.layout.showPanel(id, opts),
        setBadge: (id, v, kind) => ide.layout.setBadge(id, v, kind),
        addToolbar: (el, side, opts) => track(ide.layout.addToolbar(el, side, opts)),
        addStatus: (el, side) => track(ide.layout.addStatus(el, side)),
      },

      language: {
        addHover: (fn) => track(ide.language.addHover(fn)),
        addCompletions: (fn) => track(ide.language.addCompletions(fn)),
        addCheck: (rule) => track(ide.language.addCheck({ id: p.id, title: p.name, ...rule })),
        context: (state, pos) => ide.language.context(state, pos),
        /** Runs the checks again on an open file (the one on screen if none is given). */
        recheck: (doc) => (!doc || doc === ide.workspace.active ? ide.language.recheck() : ide.language.queueCheck(doc)),
      },

      run: {
        /** { id, name, description, settingKey } — another interpreter to run code with. */
        addInterpreter: (it) => track(ide.runner.addInterpreter(it)),
        get current() { return ide.runner.current(); },
        /** { id, name, path } for one interpreter ("rust", "c", ...); path is null if it isn't set up. */
        resolve: (id) => ide.runner.resolve(id),
        /** Runs the current file. { debug: true } runs it under the debugger (Rust interpreter). */
        start: (opts) => ide.runner.run(opts),
        stop: () => ide.runner.stop(),
        /** The running program, or null: { doc, interpreter, debug }. */
        get running() {
          const r = ide.runner.run_;
          return r ? { doc: r.doc, interpreter: r.it, debug: r.debug } : null;
        },
        /** Sends a debugger command (see jlb --debug) to the program being debugged. */
        debug: (command) => ide.runner.debugCommand(command),
      },

      /** Share an API with other plugins, or use one another plugin shared. */
      provide: (name, value) => {
        this.services.set(name, value);
        return track(() => this.services.get(name) === value && this.services.delete(name));
      },
      use: (name) => this.services.get(name),

      ui: { h, clear, icon, toast, confirm, prompt, choose, contextMenu },
      /** Calls the IDE's native commands directly (files, running programs, ...). */
      invoke: (cmd, args) => invoke(cmd, args),
      /** Registers a cleanup function to run when the plugin is switched off. */
      onDispose: (fn) => track(fn),
    };
  }

  // ---------- installed plugins ----------

  async loadInstalled() {
    let found = [];
    try {
      found = await invoke('list_plugins');
    } catch (e) {
      console.warn('[jlb-ide] could not read the plugins folder:', e);
    }
    for (const f of found) {
      let manifest;
      try {
        manifest = JSON.parse(f.manifest);
      } catch {
        this.addBroken(basename(f.folder), f.folder, 'plugin.json isn\'t valid JSON');
        continue;
      }
      if (f.error || !f.main) {
        this.addBroken(manifest.id || basename(f.folder), f.folder, f.error || `${manifest.main || 'main.js'} is missing`, manifest);
        continue;
      }
      if (manifest.apiVersion && manifest.apiVersion > API_VERSION) {
        this.addBroken(manifest.id, f.folder, `needs a newer JLB IDE (plugin API ${manifest.apiVersion})`, manifest);
        continue;
      }
      try {
        const url = URL.createObjectURL(new Blob([f.main + `\n//# sourceURL=jlb-plugin:${manifest.id}/main.js`], { type: 'text/javascript' }));
        const mod = await import(/* @vite-ignore */ url);
        URL.revokeObjectURL(url);
        this.add({
          id: manifest.id,
          name: manifest.name || manifest.id,
          description: manifest.description || '',
          version: manifest.version || '0.0.0',
          author: manifest.author || '',
          settings: manifest.settings || [],
          enabledByDefault: manifest.enabledByDefault,
          folder: f.folder,
          style: f.style || null,
          activate: mod.activate || mod.default?.activate,
          deactivate: mod.deactivate || mod.default?.deactivate,
        });
      } catch (e) {
        this.addBroken(manifest.id || basename(f.folder), f.folder, String(e?.message || e), manifest);
      }
    }
  }

  addBroken(id, folder, error, manifest = {}) {
    const safe = ID_RE.test(id || '') ? id : 'broken-' + Math.random().toString(36).slice(2, 8);
    if (this.list.has(safe)) return;
    this.list.set(safe, { id: safe, name: manifest.name || id, description: manifest.description || '', version: manifest.version || '', folder, error, broken: true, active: false, disposers: [] });
  }

  /** Writes a small example plugin to the plugins folder, as a starting point. */
  async createExample() {
    const name = await prompt('Name for the new plugin (lowercase, dashes allowed)', { value: 'my-plugin', ok: 'Create' });
    if (!name) return;
    const id = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!ID_RE.test(id)) return toast('Use lowercase letters, digits and dashes.', { kind: 'error' });
    const dir = join(await invoke('plugins_dir'), id);
    if ((await invoke('path_info', { path: dir })).exists) return toast(`A plugin folder called ${id} already exists.`, { kind: 'error' });
    await invoke('create_dir', { path: dir });
    await invoke('write_text', { path: join(dir, 'plugin.json'), text: exampleManifest(id) });
    await invoke('write_text', { path: join(dir, 'main.js'), text: EXAMPLE_MAIN });
    toast(`Created the plugin ${id}.${this.ide.settings.get('plugins.autoReload') ? ' It starts in a moment.' : ' Reload plugins to start it.'}`, { kind: 'ok', timeout: 6000 });
    this.ide.workspace.openFile(join(dir, 'main.js'));
  }

  /** Re-reads the plugins folder (installed plugins only; built-ins stay running). */
  async reload({ note = 'Plugins reloaded' } = {}) {
    for (const p of [...this.list.values()]) {
      if (p.builtin) continue;
      this.deactivate(p);
      this.list.delete(p.id);
    }
    await this.loadInstalled();
    for (const p of this.list.values()) if (!p.builtin && !p.broken && this.enabled(p)) await this.activate(p);
    this.ide.events.emit('plugins-changed');
    toast(note, { kind: 'ok', timeout: 2500 });
  }

  // ---------- the Plugins view ----------

  view() {
    let el;
    const render = async () => {
      if (!el) return;
      clear(el);
      const dir = await invoke('plugins_dir').catch(() => '');
      const all = [...this.list.values()];
      const section = (title, items, note) => {
        el.append(h('h3.view-heading', title));
        if (note) el.append(h('p.view-note', note));
        for (const p of items) el.append(this.card(p));
      };
      section('Built in', all.filter((p) => p.builtin), 'Switch off anything you don\'t want. Changes apply right away.');
      const installed = all.filter((p) => !p.builtin);
      section('Installed', installed, installed.length ? null : 'No plugins installed yet. A plugin is a folder with a plugin.json and a main.js inside the plugins folder.');
      el.append(
        h('div.view-buttons',
          h('button.btn', { on: { click: () => this.createExample() } }, icon('plus', 15), 'Create a plugin'),
          h('button.btn', { on: { click: () => this.installFromFolder() } }, icon('folder', 15), 'Install from a folder'),
          h('button.btn', { on: { click: () => this.reload() } }, icon('refresh', 15), 'Reload plugins')),
        h('p.view-note', 'Plugins folder: ', h('code.selectable', dir)),
        h('p.view-note.warn', 'Plugins can read and change your files and run programs, so only install plugins you trust.'));
    };
    this.ide.events.on('plugins-changed', render);
    return {
      id: 'plugins',
      title: 'Plugins',
      icon: 'puzzle',
      order: 90,
      bottom: true,
      render: (e) => {
        el = e;
        el.classList.add('plugins-view');
        render();
      },
    };
  }

  card(p) {
    const on = this.enabled(p) && !p.broken;
    const toggle = p.essential || p.broken ? null : h('label.switch', { title: on ? 'Switch off' : 'Switch on' },
      h('input', { type: 'checkbox', checked: on, 'aria-label': `${p.name} on or off`, on: { change: (e) => this.ide.settings.set(`plugins.${p.id}.enabled`, e.target.checked) } }),
      h('span.switch-track'));
    return h(`div.plugin-card${on ? '' : '.off'}${p.error ? '.has-error' : ''}`,
      h('div.plugin-top', h('span.plugin-name', p.name), p.version && !p.builtin ? h('span.plugin-ver', p.version) : null, h('span.spacer'), toggle),
      p.description ? h('p.plugin-desc', p.description) : null,
      p.essential ? h('p.plugin-note', 'Always on') : null,
      p.author ? h('p.plugin-note', 'By ' + p.author) : null,
      p.error ? h('p.plugin-error', p.error) : null);
  }
}

function exampleManifest(id) {
  return JSON.stringify({
    id,
    name: id.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()),
    version: '0.1.0',
    description: 'Counts the words in the current file.',
    author: '',
    apiVersion: API_VERSION,
    main: 'main.js',
    settings: [
      { key: 'showInStatusBar', title: 'Show the word count in the status bar', type: 'boolean', default: true },
    ],
  }, null, 2) + '\n';
}

const EXAMPLE_MAIN = `// A JLB IDE plugin. activate(api) runs when the plugin is switched on; everything
// registered through api is removed automatically when it's switched off.
// The full API is described in docs/plugins.md in the jlb-ide repository.

export function activate(api) {
  const { h } = api.ui;
  const label = h('span.status-item');

  const update = () => {
    const words = api.editor.text.split(/\\s+/).filter(Boolean).length;
    label.textContent = words + ' words';
    label.hidden = !api.settings.get('showInStatusBar');
  };

  api.layout.addStatus(label, 'right');
  api.events.on('editor-change', update);
  api.events.on('active-change', update);
  api.settings.onChange('showInStatusBar', update);
  update();

  api.commands.register({
    id: 'word-count.show',
    title: 'Show word count',
    run: () => api.ui.toast(label.textContent),
  });

  // Adds a check: a warning on lines longer than 100 characters.
  api.language.addCheck({
    check: ({ text }) => text.split('\\n').flatMap((line, i) =>
      line.length > 100 ? [{ line: i + 1, col: 101, severity: 'warning', message: 'This line is longer than 100 characters.' }] : []),
  });
}
`;
