// Commands: every action in the IDE is a command with an id, a title and an
// optional keyboard shortcut. The command palette (Ctrl+Shift+P) lists them all,
// and shortcuts can be changed in Settings → Keyboard shortcuts.

import { Emitter } from './emitter.js';
import { h, clear } from './ui.js';

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

/** "Ctrl+Shift+P" style text for a key event. */
export function keyOf(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(k)) return null;
  if (k === ' ') k = 'Space';
  else if (k.length === 1) k = k.toUpperCase();
  // Shift changes the character on some keys; use the physical key for those.
  if (e.shiftKey && e.code?.startsWith('Digit')) k = e.code.slice(5);
  if (e.code === 'Backquote') k = '`';
  // Shift+[ types {, but the shortcut is still Shift+[.
  if (e.code === 'BracketLeft') k = '[';
  if (e.code === 'BracketRight') k = ']';
  parts.push(k);
  return parts.join('+');
}

/** How a shortcut is shown to the person (⌘ on a Mac). */
export function showKey(key) {
  if (!key) return '';
  return isMac ? key.replace(/Ctrl\+/g, '⌘').replace(/Shift\+/g, '⇧').replace(/Alt\+/g, '⌥') : key;
}

export class Commands {
  constructor(settings) {
    this.settings = settings;
    this.list = new Map();
    this.events = new Emitter();
  }

  /** { id, title, run, key, category } — gives back a function that removes it. */
  register(cmd) {
    if (!cmd.id || typeof cmd.run !== 'function') throw new Error('a command needs an id and a run function');
    this.list.set(cmd.id, { category: 'General', ...cmd });
    this.events.emit('changed');
    return () => {
      if (this.list.get(cmd.id)?.run === cmd.run) this.list.delete(cmd.id);
      this.events.emit('changed');
    };
  }

  keyFor(id) {
    const custom = this.settings.get('keys.' + id);
    if (custom !== undefined) return custom || null;
    return this.list.get(id)?.key || null;
  }

  async run(id, ...args) {
    const cmd = this.list.get(id);
    if (!cmd) {
      console.warn(`[jlb-ide] no command called ${id}`);
      return;
    }
    if (cmd.enabled && !cmd.enabled()) return;
    return cmd.run(...args);
  }

  /** Runs the command bound to this key event, if there is one. */
  handleKey(e) {
    const key = keyOf(e);
    if (!key) return false;
    for (const [id, cmd] of this.list) {
      // A command that can't run right now leaves the key to whatever else uses it.
      if (this.keyFor(id) === key && !(cmd.enabled && !cmd.enabled())) {
        e.preventDefault();
        e.stopPropagation();
        this.run(id);
        return true;
      }
    }
    return false;
  }

  /** The command palette: type to filter, Enter to run. */
  palette(initial = '') {
    document.querySelector('.palette-back')?.remove();
    const input = h('input.palette-input', { placeholder: 'Type a command', spellcheck: false, value: initial, 'aria-label': 'Command' });
    const listEl = h('div.palette-list', { role: 'listbox' });
    const back = h('div.palette-back', h('div.palette', input, listEl));
    let shown = [];
    let sel = 0;
    const close = () => back.remove();
    const render = () => {
      const q = input.value.toLowerCase().trim();
      shown = [...this.list.values()]
        .filter((c) => !c.hidden && (!c.enabled || c.enabled()))
        .map((c) => ({ c, score: fuzzy(q, `${c.category}: ${c.title}`.toLowerCase()) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => a.score - b.score || a.c.title.localeCompare(b.c.title))
        .map((x) => x.c);
      sel = Math.min(sel, Math.max(0, shown.length - 1));
      clear(listEl);
      if (!shown.length) listEl.append(h('div.palette-empty', 'No matching commands'));
      shown.forEach((c, i) => {
        listEl.append(h(`div.palette-item${i === sel ? '.selected' : ''}`, {
          role: 'option',
          'aria-selected': i === sel ? 'true' : 'false',
          on: { mousedown: (e) => { e.preventDefault(); close(); this.run(c.id); } },
        }, h('span.palette-cat', c.category + ': '), h('span', c.title), h('kbd', showKey(this.keyFor(c.id)))));
      });
      listEl.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
    };
    input.addEventListener('input', () => { sel = 0; render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, shown.length - 1); render(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); render(); e.preventDefault(); }
      else if (e.key === 'Escape') close();
      else if (e.key === 'Enter' && shown[sel]) { close(); this.run(shown[sel].id); }
    });
    back.addEventListener('mousedown', (e) => e.target === back && close());
    document.body.append(back);
    render();
    input.focus();
  }
}

/** -1 if the letters of q don't appear in order in text; otherwise lower is a better match. */
function fuzzy(q, text) {
  if (!q) return 0;
  const direct = text.indexOf(q);
  if (direct >= 0) return direct;
  let pos = 0;
  let gaps = 100;
  for (const ch of q) {
    const i = text.indexOf(ch, pos);
    if (i < 0) return -1;
    gaps += i - pos;
    pos = i + 1;
  }
  return gaps;
}
