// Open files, tabs, saving, and the folder you're working in.

import { h, clear, icon, toast, choose, prompt, confirm, contextMenu } from './ui.js';
import { invoke, pickOpen, pickSave } from './backend.js';
import { basename, dirname, join, same, relative } from './paths.js';

let nextId = 1;

export class Workspace {
  constructor(ide) {
    this.ide = ide;
    this.docs = [];
    this.active = null;
    this.folder = null;
    const s = ide.settings;
    s.define({ key: 'workspace.restore', title: 'Reopen the last folder and files on start', type: 'boolean', default: true, section: 'Files' });
    s.define({ key: 'workspace.autoSave', title: 'Save automatically', description: 'Saves a file a moment after you stop typing (only files that already have a name).', type: 'boolean', default: false, section: 'Files' });
    s.define({ key: 'workspace.trimTrailing', title: 'Remove spaces at the ends of lines when saving', type: 'boolean', default: false, section: 'Files' });
    s.define({ key: 'workspace.finalNewline', title: 'End files with a new line when saving', type: 'boolean', default: true, section: 'Files' });
    s.define({ key: 'workspace.confirmDelete', title: 'Ask before deleting files', type: 'boolean', default: true, section: 'Files' });
    s.define({ key: 'workspace.folder', type: 'text', default: '', hidden: true });
    s.define({ key: 'workspace.openFiles', type: 'text', default: '[]', hidden: true });
    s.define({ key: 'workspace.activeFile', type: 'text', default: '', hidden: true });
    s.define({ key: 'workspace.recent', type: 'text', default: '[]', hidden: true });

    this.windowsSetup();
    this.welcome = h('div.welcome');
    ide.layout.editorHost.append(this.welcome);
    ide.events.on('editor-change', () => this.onEdit());
    window.addEventListener('focus', () => this.checkOutside());
  }

  /** Windows: right-click "Edit with JLB IDE" for .jlb files. */
  async windowsSetup() {
    const st = await invoke('file_setup_status').catch(() => ({ supported: false }));
    if (!st.supported) return;
    const run = async (enable) => {
      try {
        toast(await invoke('file_setup', { enable }), { kind: 'ok', timeout: 7000 });
      } catch (e) {
        toast(String(e), { kind: 'error' });
      }
    };
    this.ide.settings.define({
      key: 'files.windowsEdit',
      title: 'Edit .jlb files with JLB IDE',
      description: 'Adds "Edit with JLB IDE" to the right-click menu of .jlb files. Double-clicking a .jlb file still runs it.' + (st.double_click_runs ? '' : ' (Double-click to run isn\'t set up on this computer yet, so this sets it up too, using the interpreter that comes with the IDE.)'),
      type: 'action',
      section: 'Files',
      buttons: [{ label: 'Undo', run: () => run(false) }, { label: st.edit_with_ide ? 'Set up again' : 'Set up', primary: true, run: () => run(true) }],
    });
    this.ide.commands.register({ id: 'files.windowsEdit', title: 'Add "Edit with JLB IDE" to .jlb files', category: 'File', run: () => run(true) });
  }

  // ---------- documents ----------

  isDirty(doc) {
    return !doc.state.doc.eq(doc.saved);
  }

  createDoc(text, path) {
    const state = this.ide.editor.createState(text);
    const doc = { id: nextId++, path: path || null, name: path ? basename(path) : `untitled-${nextId - 1}.jlb`, state, saved: state.doc, mtime: 0 };
    this.docs.push(doc);
    return doc;
  }

  newFile(text = '') {
    const doc = this.createDoc(text, null);
    this.activate(doc);
    this.ide.events.emit('file-open', doc);
    return doc;
  }

  find(path) {
    return this.docs.find((d) => same(d.path, path));
  }

  async openFile(path, { activate = true } = {}) {
    const existing = this.find(path);
    if (existing) {
      if (activate) this.activate(existing);
      return existing;
    }
    let text;
    try {
      text = await invoke('read_text', { path });
    } catch (e) {
      toast(String(e), { kind: 'error' });
      return null;
    }
    const doc = this.createDoc(text.replace(/\r\n/g, '\n'), path);
    doc.crlf = text.includes('\r\n');
    doc.mtime = (await invoke('path_info', { path })).modified;
    if (activate) this.activate(doc);
    else this.renderTabs();
    this.ide.events.emit('file-open', doc);
    this.saveSession();
    return doc;
  }

  async openDialog() {
    const p = await pickOpen({ defaultPath: this.folder || undefined });
    if (p) await this.openFile(p);
  }

  activate(doc) {
    if (this.active && this.active !== doc && this.docs.includes(this.active)) this.active.state = this.ide.editor.view.state;
    this.active = doc;
    if (doc) {
      this.ide.editor.view.setState(doc.state);
      this.ide.editor.refreshConfig();
      this.ide.editor.focus();
    }
    this.welcome.hidden = !!doc;
    this.ide.layout.editorHost.classList.toggle('empty', !doc);
    this.renderTabs();
    this.ide.events.emit('active-change', doc);
    this.ide.events.emit('editor-cursor', this.ide.editor.view.state);
    this.saveSession();
    if (!doc) this.renderWelcome();
  }

  /** The active document with its latest text. */
  current() {
    if (this.active) this.active.state = this.ide.editor.view.state;
    return this.active;
  }

  textOf(doc) {
    return (doc === this.active ? this.ide.editor.view.state : doc.state).doc.toString();
  }

  onEdit() {
    const doc = this.current();
    if (!doc) return;
    this.renderTabs();
    if (this.ide.settings.get('workspace.autoSave') && doc.path) {
      clearTimeout(doc.autoTimer);
      doc.autoTimer = setTimeout(() => this.isDirty(doc) && this.save(doc, { quiet: true }), 1200);
    }
  }

  async save(doc = this.current(), { quiet = false } = {}) {
    if (!doc) return false;
    if (!doc.path) return this.saveAs(doc);
    let text = this.textOf(doc);
    if (this.ide.settings.get('workspace.trimTrailing')) text = text.replace(/[ \t]+$/gm, '');
    if (this.ide.settings.get('workspace.finalNewline') && text && !text.endsWith('\n')) text += '\n';
    if (text !== this.textOf(doc) && doc === this.active) {
      // Show what was saved, keeping the cursor where it was as far as possible.
      const v = this.ide.editor.view;
      const head = Math.min(v.state.selection.main.head, text.length);
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, selection: { anchor: head } });
    }
    try {
      await invoke('write_text', { path: doc.path, text: doc.crlf ? text.replace(/\n/g, '\r\n') : text });
    } catch (e) {
      toast(String(e), { kind: 'error' });
      return false;
    }
    doc.saved = (doc === this.active ? this.ide.editor.view.state : doc.state).doc;
    doc.mtime = (await invoke('path_info', { path: doc.path })).modified;
    this.renderTabs();
    this.ide.events.emit('file-save', doc);
    if (!quiet) toast(`Saved ${doc.name}`, { kind: 'ok', timeout: 1500 });
    return true;
  }

  async saveAs(doc = this.current()) {
    if (!doc) return false;
    const p = await pickSave({ defaultPath: doc.path || (this.folder ? join(this.folder, doc.name) : doc.name) });
    if (!p) return false;
    const path = /\.[a-z0-9]+$/i.test(basename(p)) ? p : p + '.jlb';
    const other = this.find(path);
    if (other && other !== doc) this.closeNow(other);
    doc.path = path;
    doc.name = basename(path);
    const ok = await this.save(doc);
    this.refreshExplorer();
    this.saveSession();
    return ok;
  }

  async saveAll() {
    for (const d of this.docs) if (this.isDirty(d) && d.path) await this.save(d, { quiet: true });
  }

  /** Closes a tab, asking about unsaved changes. Gives back false if cancelled. */
  async close(doc = this.current()) {
    if (!doc) return true;
    if (doc === this.active) this.current();
    if (this.isDirty(doc)) {
      this.activate(doc);
      const answer = await choose(`Save the changes to ${doc.name}?`, [
        { label: "Don't save", value: 'discard', danger: true },
        { label: 'Cancel', value: null },
        { label: 'Save', value: 'save', primary: true },
      ], { detail: "Your changes are lost if you don't save them." });
      if (!answer) return false;
      if (answer === 'save' && !(await this.save(doc))) return false;
    }
    this.closeNow(doc);
    return true;
  }

  closeNow(doc) {
    const i = this.docs.indexOf(doc);
    if (i < 0) return;
    this.docs.splice(i, 1);
    this.ide.events.emit('file-close', doc);
    if (this.active === doc) {
      this.active = null;
      this.activate(this.docs[Math.min(i, this.docs.length - 1)] || null);
    } else this.renderTabs();
    this.saveSession();
  }

  async closeAll() {
    for (const d of [...this.docs]) if (!(await this.close(d))) return false;
    return true;
  }

  cycle(step) {
    if (this.docs.length < 2) return;
    const i = this.docs.indexOf(this.active);
    this.activate(this.docs[(i + step + this.docs.length) % this.docs.length]);
  }

  /** Reloads files changed by another program (when they have no unsaved changes here). */
  async checkOutside() {
    for (const d of this.docs) {
      if (!d.path) continue;
      const info = await invoke('path_info', { path: d.path });
      if (!info.exists || !info.modified || info.modified === d.mtime) continue;
      d.mtime = info.modified;
      if (this.isDirty(d)) {
        toast(`${d.name} was changed by another program. Saving here will replace those changes.`, { timeout: 8000 });
        continue;
      }
      const text = (await invoke('read_text', { path: d.path })).replace(/\r\n/g, '\n');
      if (d === this.active) {
        const v = this.ide.editor.view;
        v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
        d.state = v.state;
      } else {
        d.state = d.state.update({ changes: { from: 0, to: d.state.doc.length, insert: text } }).state;
      }
      d.saved = d.state.doc;
      this.renderTabs();
    }
    this.refreshExplorer();
  }

  // ---------- tabs ----------

  renderTabs() {
    const bar = this.ide.layout.tabs;
    clear(bar);
    for (const d of this.docs) {
      const dirty = this.isDirty(d === this.active ? { state: this.ide.editor.view.state, saved: d.saved } : d);
      const tab = h(`div.tab${d === this.active ? '.active' : ''}${dirty ? '.dirty' : ''}`, {
        role: 'tab',
        title: d.path || 'Not saved yet',
        'aria-selected': d === this.active ? 'true' : 'false',
        tabindex: d === this.active ? '0' : '-1',
        on: {
          mousedown: (e) => {
            if (e.button === 1) {
              e.preventDefault();
              this.close(d);
            }
          },
          click: () => this.activate(d),
          contextmenu: (e) => contextMenu(e, [
            { label: 'Close', run: () => this.close(d) },
            { label: 'Close others', run: async () => { for (const o of this.docs.filter((x) => x !== d)) if (!(await this.close(o))) break; } },
            null,
            { label: 'Copy path', run: () => d.path && navigator.clipboard.writeText(d.path) },
          ]),
        },
      },
      h('span.tab-name', d.name),
      h('button.tab-close', { title: dirty ? 'Unsaved changes. Close' : 'Close', 'aria-label': `Close ${d.name}`, on: { click: (e) => { e.stopPropagation(); this.close(d); } } }, h('span.dot'), icon('x', 14)));
      bar.append(tab);
    }
    bar.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // ---------- folder ----------

  async openFolderDialog() {
    const p = await pickOpen({ folder: true, defaultPath: this.folder || undefined });
    if (p) this.setFolder(p);
  }

  setFolder(path) {
    this.folder = path || null;
    this.ide.settings.set('workspace.folder', this.folder || '');
    if (path) {
      const recent = JSON.parse(this.ide.settings.get('workspace.recent') || '[]').filter((r) => !same(r, path));
      recent.unshift(path);
      this.ide.settings.set('workspace.recent', JSON.stringify(recent.slice(0, 8)));
    }
    this.expanded = new Set(path ? [path] : []);
    this.refreshExplorer();
    this.ide.events.emit('folder-change', path);
    if (!this.active) this.renderWelcome();
  }

  /** The folder programs run in: the open folder, else the file's own folder. */
  workDir(doc = this.active) {
    if (doc?.path) return dirname(doc.path);
    return this.folder || '';
  }

  explorerView() {
    return {
      id: 'explorer',
      title: 'Files',
      icon: 'files',
      order: 10,
      actions: [
        { icon: 'plus', title: 'New file', run: () => this.newFileIn(this.folder) },
        { icon: 'folder', title: 'New folder', run: () => this.newFolderIn(this.folder) },
        { icon: 'refresh', title: 'Refresh', run: () => this.refreshExplorer() },
        { icon: 'folder-open', title: 'Open folder', run: () => this.openFolderDialog() },
      ],
      render: (el) => {
        this.treeEl = el;
        el.classList.add('explorer');
        this.refreshExplorer();
      },
    };
  }

  async refreshExplorer() {
    const el = this.treeEl;
    if (!el) return;
    clear(el);
    if (!this.folder) {
      el.append(h('div.empty-note',
        h('p', 'Open a folder to see its files here.'),
        h('button.btn.primary', { on: { click: () => this.openFolderDialog() } }, 'Open folder')));
      return;
    }
    this.expanded ||= new Set([this.folder]);
    el.append(h('div.tree-root', { title: this.folder }, basename(this.folder)));
    const tree = h('div.tree', { role: 'tree' });
    el.append(tree);
    await this.renderDir(tree, this.folder, 0);
  }

  async renderDir(container, dir, depth) {
    let entries;
    try {
      entries = await invoke('list_dir', { path: dir });
    } catch (e) {
      container.append(h('div.tree-error', String(e)));
      return;
    }
    if (!entries.length && depth === 0) container.append(h('div.empty-note', h('p', 'This folder is empty.')));
    for (const e of entries) {
      const open = e.is_dir && this.expanded.has(e.path);
      const row = h(`div.tree-row${e.is_dir ? '.dir' : ''}${!e.is_dir && same(e.path, this.active?.path) ? '.active' : ''}${!e.is_dir && !e.name.endsWith('.jlb') ? '.other' : ''}`, {
        role: 'treeitem',
        tabindex: '0',
        title: e.path,
        style: { paddingLeft: 8 + depth * 14 + 'px' },
        'aria-expanded': e.is_dir ? String(open) : undefined,
        on: {
          click: () => this.treeClick(e),
          keydown: (ev) => ev.key === 'Enter' && this.treeClick(e),
          contextmenu: (ev) => this.treeMenu(ev, e),
        },
      },
      e.is_dir ? h(`span.twisty${open ? '.open' : ''}`, icon('chevron', 14)) : h('span.twisty'),
      icon(e.is_dir ? (open ? 'folder-open' : 'folder') : 'file', 16),
      h('span.tree-name', e.name));
      container.append(row);
      if (open) {
        const kids = h('div', { role: 'group' });
        container.append(kids);
        await this.renderDir(kids, e.path, depth + 1);
      }
    }
  }

  treeClick(e) {
    if (e.is_dir) {
      if (this.expanded.has(e.path)) this.expanded.delete(e.path);
      else this.expanded.add(e.path);
      this.refreshExplorer();
    } else this.openFile(e.path);
  }

  treeMenu(ev, e) {
    const dir = e.is_dir ? e.path : dirname(e.path);
    contextMenu(ev, [
      { label: 'New file', run: () => this.newFileIn(dir) },
      { label: 'New folder', run: () => this.newFolderIn(dir) },
      null,
      { label: 'Rename', run: () => this.renamePath(e) },
      { label: 'Copy path', run: () => navigator.clipboard.writeText(e.path) },
      null,
      { label: 'Delete', danger: true, run: () => this.deletePath(e) },
    ]);
  }

  async newFileIn(dir) {
    if (!dir) return this.newFile();
    const name = await prompt('Name of the new file', { value: 'untitled.jlb', ok: 'Create', select: [0, 8] });
    if (!name) return;
    const path = join(dir, name);
    if ((await invoke('path_info', { path })).exists) return toast(`${name} already exists`, { kind: 'error' });
    try {
      await invoke('write_text', { path, text: '' });
    } catch (err) {
      return toast(String(err), { kind: 'error' });
    }
    this.expanded.add(dir);
    await this.refreshExplorer();
    this.openFile(path);
  }

  async newFolderIn(dir) {
    if (!dir) return this.openFolderDialog();
    const name = await prompt('Name of the new folder', { ok: 'Create' });
    if (!name) return;
    try {
      await invoke('create_dir', { path: join(dir, name) });
    } catch (err) {
      return toast(String(err), { kind: 'error' });
    }
    this.expanded.add(dir);
    this.refreshExplorer();
  }

  async renamePath(e) {
    const dot = e.name.lastIndexOf('.');
    const name = await prompt(`Rename ${e.name}`, { value: e.name, ok: 'Rename', select: [0, dot > 0 && !e.is_dir ? dot : e.name.length] });
    if (!name || name === e.name) return;
    const to = join(dirname(e.path), name);
    try {
      await invoke('rename_path', { from: e.path, to });
    } catch (err) {
      return toast(String(err), { kind: 'error' });
    }
    for (const d of this.docs) {
      if (d.path && (same(d.path, e.path) || d.path.startsWith(e.path + '/') || d.path.startsWith(e.path + '\\'))) {
        d.path = to + d.path.slice(e.path.length);
        d.name = basename(d.path);
      }
    }
    this.renderTabs();
    this.refreshExplorer();
    this.saveSession();
  }

  async deletePath(e) {
    if (this.ide.settings.get('workspace.confirmDelete')) {
      const ok = await confirm(`Delete ${e.name}?`, { ok: 'Delete', danger: true, detail: e.is_dir ? 'The folder and everything in it will be deleted. This can\'t be undone.' : "This can't be undone." });
      if (!ok) return;
    }
    try {
      await invoke('delete_path', { path: e.path });
    } catch (err) {
      return toast(String(err), { kind: 'error' });
    }
    for (const d of [...this.docs]) if (d.path && (same(d.path, e.path) || d.path.startsWith(e.path))) this.closeNow(d);
    this.refreshExplorer();
  }

  // ---------- welcome screen ----------

  renderWelcome() {
    const w = clear(this.welcome);
    const recent = JSON.parse(this.ide.settings.get('workspace.recent') || '[]');
    const cmd = (id) => () => this.ide.commands.run(id);
    w.append(
      h('div.welcome-inner',
        h('h1.welcome-title', h('img', { src: 'icon.svg', alt: '' }), 'JLB IDE'),
        h('p.welcome-lead', 'Write, check and run .jlb programs.'),
        h('div.welcome-actions',
          h('button.btn.primary', { on: { click: cmd('file.new') } }, icon('plus', 16), 'New file'),
          h('button.btn', { on: { click: cmd('file.open') } }, icon('file', 16), 'Open file'),
          h('button.btn', { on: { click: cmd('file.openFolder') } }, icon('folder-open', 16), 'Open folder')),
        recent.length ? h('section.welcome-section',
          h('h2', 'Recent folders'),
          h('ul.welcome-list', recent.map((r) => h('li', h('button.link', { title: r, on: { click: () => this.setFolder(r) } }, basename(r), h('span.muted', ' ' + r)))))) : null,
        h('section.welcome-section',
          h('h2', 'Try an example'),
          h('ul.welcome-list', EXAMPLES.map((ex) => h('li', h('button.link', { on: { click: () => this.newFile(ex.code) } }, ex.title, h('span.muted', ' ' + ex.note)))))),
        h('p.welcome-keys', 'Press ', h('kbd', 'Ctrl+Shift+P'), ' for every command, and ', h('kbd', 'F5'), ' to run.')),
    );
  }

  // ---------- session ----------

  saveSession() {
    if (this.restoring) return;
    const s = this.ide.settings;
    s.set('workspace.openFiles', JSON.stringify(this.docs.filter((d) => d.path).map((d) => d.path)));
    s.set('workspace.activeFile', this.active?.path || '');
  }

  async restore() {
    const s = this.ide.settings;
    if (!s.get('workspace.restore')) {
      this.activate(null);
      return;
    }
    this.restoring = true;
    const folder = s.get('workspace.folder');
    if (folder && (await invoke('path_info', { path: folder })).is_dir) this.setFolder(folder);
    for (const p of JSON.parse(s.get('workspace.openFiles') || '[]')) {
      if ((await invoke('path_info', { path: p })).exists) await this.openFile(p, { activate: false });
    }
    this.restoring = false;
    const want = this.find(s.get('workspace.activeFile')) || this.docs[0] || null;
    this.activate(want);
  }
}

const EXAMPLES = [
  {
    title: 'Hello, world',
    note: 'the smallest program',
    code: '>> Press F5 to run this program.\nPRINT("Hello, world!")\n',
  },
  {
    title: 'Number guessing game',
    note: 'INPUT, TRY and GOTO',
    code: `>> A number guessing game
secret = RANDOM(1, 100)
tries = 0
PRINT("I'm thinking of a number from 1 to 100.")

POINT ask
guess = INPUT("Your guess: ")
TRY {
    guess = NUM(guess)
} FAIL err {
    PRINT("That's not a number, try again.")
    GOTO ask
}
tries += 1

IF guess < secret {
    PRINT("Higher!")
    GOTO ask
} ELIF guess > secret {
    PRINT("Lower!")
    GOTO ask
}
PRINT("You got it in " + tries + " tries!")
`,
  },
  {
    title: 'Text and table tricks',
    note: 'the operators that make .jlb different',
    code: `>> Text and tables can be multiplied, subtracted and reversed.
word = "stressed"
PRINT(word * -1)              >> reversed
PRINT("ab" * 3)               >> repeated
PRINT("hello world" - "o")    >> every o removed

scores = [40, 10, 30]
scores += 20                  >> added to the end
PRINT(SORT(scores) * -1)      >> biggest first

>> & stops early, so this is safe even when there's no player
player = NULL
IF player !== NULL & player.hp > 0 {
    PRINT("alive")
}
PRINT(0.1 + 0.2)              >> exactly 0.3
`,
  },
];
