// Backups of unsaved work. A few seconds after you stop typing, every tab with
// unsaved changes is copied to a backup. If the IDE or the computer crashes, the
// next start brings those tabs back. Saving a tab, or closing it without saving,
// removes its backup. The native side (src-tauri/src/backups.rs) keeps each
// running IDE's backups apart, so two open IDEs never take each other's.

export default {
  id: 'backups',
  name: 'Backups of unsaved work',
  description: 'Copies unsaved changes to a backup every few seconds, and brings them back after a crash.',
  builtin: true,
  settings: [
    { key: 'delay', title: 'Back up this many seconds after you stop typing', type: 'number', default: 2, min: 1, max: 60 },
    {
      key: 'keepOnClose',
      title: 'Keep unsaved changes when closing, without asking',
      description: 'Closing the IDE keeps every unsaved tab as it is, and they come back the next time you open it. When off, the IDE asks whether to save.',
      type: 'boolean',
      default: false,
    },
  ],
  activate(api) {
    const { invoke } = api;
    const timers = new Map(); // doc -> timer
    const written = new WeakMap(); // doc -> the text last backed up
    let count = 0; // how many tabs have a backup right now
    let heartbeat = null;

    const keyOf = (doc) => (doc.backupKey ||= 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));

    /** Backs a tab up now (or removes its backup when it has no unsaved changes). */
    const backUp = async (doc) => {
      clearTimeout(timers.get(doc));
      timers.delete(doc);
      if (!api.workspace.files.includes(doc)) return;
      const text = api.workspace.textOf(doc);
      if (!api.workspace.isDirty(doc)) return forget(doc);
      if (written.get(doc) === text) return;
      const data = JSON.stringify({
        version: 1,
        path: doc.path,
        name: doc.name,
        text,
        // What the file held when these changes started, to tell later whether it changed on disk.
        base: hash(doc.saved.toString()),
        time: Date.now(),
      });
      try {
        await invoke('backup_write', { key: keyOf(doc), data });
        if (!written.has(doc)) count++;
        written.set(doc, text);
        beat();
      } catch (e) {
        console.warn('[backups] could not back up', doc.name, e);
      }
    };

    const forget = async (doc) => {
      clearTimeout(timers.get(doc));
      timers.delete(doc);
      if (!written.has(doc)) return;
      written.delete(doc);
      count = Math.max(0, count - 1);
      try {
        await invoke('backup_delete', { key: keyOf(doc) });
      } catch (e) {
        console.warn('[backups] could not remove a backup', e);
      }
      beat();
    };

    // While there are backups, other IDEs need to see this one is still running.
    const beat = () => {
      if (count && !heartbeat) heartbeat = setInterval(() => invoke('backup_heartbeat').catch(() => {}), 10000);
      if (!count && heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    };

    const later = (doc) => {
      if (!doc) return;
      clearTimeout(timers.get(doc));
      timers.set(doc, setTimeout(() => backUp(doc), api.settings.get('delay') * 1000));
    };

    api.events.on('editor-change', () => later(api.workspace.active));
    api.events.on('doc-change', (doc) => later(doc));
    // Switching tabs: back up the tab being left straight away.
    let shown = api.workspace.active;
    api.events.on('active-change', (doc) => {
      if (shown && timers.has(shown)) backUp(shown);
      shown = doc;
    });
    api.events.on('file-save', (doc) => forget(doc));
    api.events.on('file-close', (doc) => forget(doc));

    /** Brings back tabs from an IDE that crashed or closed with unsaved changes. */
    const recover = async () => {
      let left;
      try {
        left = await invoke('backup_leftovers');
      } catch (e) {
        console.warn('[backups] could not look for backups', e);
        return;
      }
      if (!left.length) return;
      const before = api.workspace.active;
      const back = [];
      const apart = [];
      for (const { folder, items } of left) {
        for (const raw of items) {
          let b;
          try {
            b = JSON.parse(raw);
          } catch {
            continue;
          }
          if (typeof b.text !== 'string') continue;
          const doc = await reopen(b);
          if (!doc) continue;
          (doc.path === b.path ? back : apart).push(doc);
          await backUp(doc);
        }
        // Everything is backed up again under this session, so the old folder can go.
        await invoke('backup_forget', { folder }).catch(() => {});
      }
      if (before && api.workspace.files.includes(before)) api.workspace.activate(before);
      else if (back[0] || apart[0]) api.workspace.activate(back[0] || apart[0]);
      if (back.length || apart.length) {
        const names = (list) => list.map((d) => d.name).join(', ');
        api.ui.toast([
          back.length ? `Brought back unsaved changes to ${names(back)}.` : '',
          apart.length ? `${names(apart)} changed since the backup, so the backup opened in its own tab.` : '',
        ].filter(Boolean).join(' '), { kind: 'ok', timeout: 9000 });
      }
    };

    /** Opens a backup: into its file's tab when the file is as it was, otherwise in a new tab. */
    const reopen = async (b) => {
      if (b.path) {
        const exists = await invoke('path_info', { path: b.path }).then((i) => i.exists).catch(() => false);
        const doc = exists ? await api.workspace.openFile(b.path, { activate: false }) : null;
        if (doc) {
          const onDisk = doc.saved.toString();
          if (onDisk === b.text) return null; // nothing was lost
          if (hash(onDisk) === b.base && !api.workspace.isDirty(doc)) {
            api.workspace.setText(doc, b.text);
            return doc;
          }
        }
      }
      // An untitled tab, or a file that changed (or went away) since the backup.
      const doc = api.workspace.newFile('');
      api.workspace.setText(doc, b.text); // as an edit, so the tab shows it isn't saved
      if (b.path) doc.name = `${b.name.replace(/\.jlb$/i, '')} (backup).jlb`;
      return doc;
    };

    if (api.workspace.restored) recover();
    else api.events.on('workspace-restored', recover);

    // For closing the window: back everything up now, and keep or drop the backups.
    api.provide('backups', {
      keepOnClose: () => api.settings.get('keepOnClose'),
      flush: async () => {
        for (const doc of api.workspace.files) await backUp(doc);
      },
      close: (keep) => invoke('backup_close', { keep }).catch(() => {}),
    });

    // Switched off: stop backing up, and remove this session's backups.
    api.onDispose(() => {
      for (const t of timers.values()) clearTimeout(t);
      clearInterval(heartbeat);
      invoke('backup_close', { keep: false }).catch(() => {});
    });
  },
};

/** A short fingerprint of some text (cyrb53). */
function hash(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
