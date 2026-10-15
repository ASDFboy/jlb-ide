// Settings: each one is defined once (by the IDE or a plugin), shown in the
// Settings view automatically, and saved to settings.json in the app's config folder.

import { Emitter } from './emitter.js';
import { invoke } from './backend.js';

/**
 * A setting definition:
 *   key          unique id, like "editor.fontSize"
 *   title        short name shown in Settings
 *   description  one sentence on what it does (optional)
 *   type         "boolean" | "number" | "text" | "select" | "path", or "action" for
 *                buttons ({ buttons: [{ label, run, primary }] }) that don't store a value
 *   default      the starting value
 *   options      for "select": [{ value, label }]
 *   min, max     for "number"
 *   section      the heading it's listed under in Settings
 */
export class Settings {
  constructor() {
    this.defs = new Map();
    this.values = {};
    this.events = new Emitter();
    this.saveTimer = null;
  }

  async load() {
    try {
      this.values = JSON.parse(await invoke('load_settings')) || {};
    } catch (e) {
      console.warn('[jlb-ide] settings.json could not be read, starting fresh:', e);
      this.values = {};
    }
  }

  define(def) {
    if (!def.key || !def.type) throw new Error('a setting needs a key and a type');
    this.defs.set(def.key, { section: 'Other', ...def });
    this.events.emit('defined', def.key);
    return () => {
      this.defs.delete(def.key);
      this.events.emit('defined', def.key);
    };
  }

  get(key) {
    if (key in this.values) return this.values[key];
    return this.defs.get(key)?.default;
  }

  set(key, value) {
    const def = this.defs.get(key);
    if (def?.type === 'number') {
      value = Number(value);
      if (Number.isNaN(value)) return;
      if (def.min !== undefined) value = Math.max(def.min, value);
      if (def.max !== undefined) value = Math.min(def.max, value);
    }
    if (this.get(key) === value) return;
    if (def && value === def.default) delete this.values[key];
    else this.values[key] = value;
    this.scheduleSave();
    this.events.emit('change', key, value);
  }

  reset(key) {
    this.set(key, this.defs.get(key)?.default);
  }

  /** Calls fn(value, key) whenever a setting changes; a key ending in "." matches a whole group. */
  onChange(key, fn) {
    return this.events.on('change', (k, v) => {
      if (k === key || (key.endsWith('.') && k.startsWith(key))) fn(v, k);
    });
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 250);
  }

  async saveNow() {
    clearTimeout(this.saveTimer);
    try {
      await invoke('save_settings', { text: JSON.stringify(this.values, null, 2) });
    } catch (e) {
      console.error('[jlb-ide] settings could not be saved:', e);
    }
  }
}
