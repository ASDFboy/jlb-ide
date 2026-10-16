// The Settings screen. It's built from the setting definitions, so a plugin's
// settings show up here on their own.

import { h, clear, icon } from './ui.js';
import { invoke, pickOpen } from './backend.js';
import { keyOf, showKey } from './commands.js';
import { join } from './paths.js';
import { THEMES, COLOR_GROUPS, COLOR_VARS, themeColors, parseColor, toHex, withAlphaOf } from './themes.js';

const ORDER = ['Appearance', 'Editor', 'Files', 'Running', 'Interpreters', 'Features'];

let closeOpen = null;

export function openSettings(ide, focusSection) {
  closeOpen?.();
  const s = ide.settings;
  const search = h('input.settings-search', { type: 'search', placeholder: 'Search settings', spellcheck: false, 'aria-label': 'Search settings' });
  const nav = h('nav.settings-nav', { 'aria-label': 'Sections' });
  const body = h('div.settings-body');
  const close = () => {
    closeOpen = null;
    back.remove();
    off.forEach((f) => f());
    document.removeEventListener('keydown', onKey);
    ide.editor.focus();
  };
  // Escape closes Settings wherever the focus is (a rebuilt row can leave it on the page).
  const onKey = (e) => {
    if (e.key === 'Escape' && !e.target.classList?.contains('key-input') && !document.querySelector('.dialog')) close();
  };
  document.addEventListener('keydown', onKey);
  closeOpen = close;
  const sheet = h('div.settings-sheet', { role: 'dialog', 'aria-label': 'Settings' },
    h('div.settings-head',
      h('h2', 'Settings'),
      search,
      h('button.icon-btn', { title: 'Close (Esc)', 'aria-label': 'Close settings', on: { click: close } }, icon('x', 18))),
    h('div.settings-main', nav, body));
  const back = h('div.settings-back', sheet);
  back.addEventListener('mousedown', (e) => e.target === back && close());

  const sections = () => {
    const map = new Map();
    for (const d of s.defs.values()) {
      if (d.hidden) continue;
      if (!map.has(d.section)) map.set(d.section, []);
      map.get(d.section).push(d);
    }
    const names = [...map.keys()].sort((a, b) => {
      const ia = ORDER.indexOf(a);
      const ib = ORDER.indexOf(b);
      if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      if (a === 'Plugins') return 1;
      if (b === 'Plugins') return -1;
      return a.localeCompare(b);
    });
    return names.map((n) => [n, map.get(n)]);
  };

  const render = () => {
    const q = search.value.trim().toLowerCase();
    clear(nav);
    clear(body);
    const all = sections();
    all.splice(all.findIndex(([n]) => n === 'Appearance') + 1, 0, ['Colors', null]);
    all.push(['Keyboard shortcuts', null]);
    for (const [name, defs] of all) {
      const id = 'set-' + name.toLowerCase().replace(/\W+/g, '-');
      let rows;
      if (defs) {
        rows = defs.filter((d) => !q || `${d.title} ${d.description || ''} ${name}`.toLowerCase().includes(q)).map((d) => row(d));
      } else {
        rows = name === 'Colors' ? colorRows(q) : keyRows(q);
      }
      if (!rows.length) continue;
      nav.append(h('button.settings-nav-btn', { on: { click: () => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) } }, name));
      body.append(h('section.settings-section', { id }, h('h3', name), rows));
    }
    if (!body.childNodes.length) body.append(h('p.view-note', 'No settings match that search.'));
    body.append(h('p.settings-foot',
      h('button.link', { on: { click: openFile } }, 'Open settings.json'),
      ' to edit settings as text.'));
  };

  const row = (d) => {
    const v = s.get(d.key);
    const changed = d.type !== 'action' && v !== d.default;
    let control;
    switch (d.type) {
      case 'boolean':
        control = h('label.switch', h('input', { type: 'checkbox', checked: !!v, 'aria-label': d.title, on: { change: (e) => s.set(d.key, e.target.checked) } }), h('span.switch-track'));
        break;
      case 'number':
        control = h('input.input.num', { type: 'number', value: v, min: d.min, max: d.max, step: d.step || (Number.isInteger(d.default) ? 1 : 0.05), 'aria-label': d.title, on: { change: (e) => s.set(d.key, e.target.value) } });
        break;
      case 'select':
        control = h('select.input', { 'aria-label': d.title, on: { change: (e) => s.set(d.key, e.target.value) } },
          (d.options || []).map((o) => h('option', { value: o.value, selected: o.value === v }, o.label)));
        break;
      case 'action':
        control = h('div.path-control', (d.buttons || []).map((b) => h(`button.btn${b.primary ? '.primary' : ''}`, { on: { click: b.run } }, b.label)));
        break;
      case 'path':
        control = h('div.path-control',
          h('input.input', { value: v || '', placeholder: 'Automatic', spellcheck: false, 'aria-label': d.title, on: { change: (e) => s.set(d.key, e.target.value.trim()) } }),
          h('button.btn', { on: { click: async () => { const p = await pickOpen(); if (p) s.set(d.key, p); } } }, 'Browse…'));
        break;
      default:
        control = h('input.input', { value: v ?? '', spellcheck: false, 'aria-label': d.title, on: { change: (e) => s.set(d.key, e.target.value) } });
    }
    return h(`div.setting${changed ? '.changed' : ''}`,
      h('div.setting-text',
        h('div.setting-title', d.title),
        d.description ? h('div.setting-desc', d.description) : null,
        changed ? h('button.link.setting-reset', { on: { click: () => s.reset(d.key) } }, 'Reset to default') : null),
      h('div.setting-control', control));
  };

  /** Every color of the theme in use, each one changeable (kept per theme). */
  const colorRows = (q) => {
    const id = currentTheme(s);
    const key = 'colors.' + id;
    const own = s.get(key) || {};
    const root = document.documentElement;
    // The theme's own colors: worked out in themes.js, or (Night and Day) read from the
    // stylesheet with the changed colors left out for a moment.
    let base = themeColors(id);
    if (!base) {
      const style = document.getElementById('theme-colors');
      const text = style?.textContent;
      if (style) style.textContent = '';
      const cs = getComputedStyle(root);
      base = Object.fromEntries(COLOR_VARS.map((v) => [v, cs.getPropertyValue(v).trim()]));
      if (style) style.textContent = text;
    }
    const themeValue = (v) => base[v];
    const save = (v, value) => {
      const next = { ...(s.get(key) || {}) };
      if (value == null) delete next[v];
      else next[v] = value;
      root.style.removeProperty(v);
      if (Object.keys(next).length) s.set(key, next);
      else s.reset(key);
    };
    const rows = [];
    const any = Object.keys(own).length;
    if (!q || 'colors theme reset'.includes(q)) {
      rows.push(h('div.setting',
        h('div.setting-text', h('div.setting-title', `Colors of ${THEMES[id].label}`),
          h('div.setting-desc', 'Change any color below; it changes right away and is kept for this theme. Pick another theme under Appearance.')),
        h('div.setting-control', any ? h('button.btn', { on: { click: () => s.reset(key) } }, 'Reset all colors') : null)));
    }
    for (const [group, list] of COLOR_GROUPS) {
      for (const [v, label] of list) {
        if (q && !`${label} ${group} color colour ${v}`.toLowerCase().includes(q)) continue;
        const value = own[v] ?? themeValue(v);
        const text = h('input.input.color-text', {
          value, spellcheck: false, 'aria-label': `${label}, as text`,
          on: { change: (e) => (parseColor(e.target.value) ? save(v, e.target.value.trim()) : (e.target.value = value)) },
        });
        const pick = h('input.color-pick', {
          type: 'color', value: toHex(value), 'aria-label': label,
          on: {
            // Shown while choosing; kept when the picker closes.
            input: (e) => {
              const c = withAlphaOf(e.target.value, value);
              root.style.setProperty(v, c);
              text.value = c;
            },
            change: (e) => save(v, withAlphaOf(e.target.value, value)),
          },
        });
        rows.push(h(`div.setting.color-row${own[v] ? '.changed' : ''}`,
          h('div.setting-text', h('div.setting-title', label), h('div.setting-desc', group),
            own[v] ? h('button.link.setting-reset', { on: { click: () => save(v, null) } }, 'Reset to the theme\'s color') : null),
          h('div.setting-control.color-control', pick, text)));
      }
    }
    return rows;
  };

  const keyRows = (q) => {
    const cmds = [...ide.commands.list.values()].filter((c) => !c.hidden).sort((a, b) => `${a.category}${a.title}`.localeCompare(`${b.category}${b.title}`));
    return cmds.filter((c) => !q || `${c.category} ${c.title} shortcut keyboard`.toLowerCase().includes(q)).map((c) => {
      const key = ide.commands.keyFor(c.id);
      const input = h('input.input.key-input', {
        value: showKey(key),
        placeholder: 'None',
        readOnly: true,
        'aria-label': `Shortcut for ${c.title}. Press keys to change it, Backspace to remove it.`,
        on: {
          keydown: (e) => {
            if (e.key === 'Tab') return;
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Escape') return input.blur();
            if (e.key === 'Backspace' || e.key === 'Delete') return s.set('keys.' + c.id, '');
            const k = keyOf(e);
            if (k) s.set('keys.' + c.id, k);
          },
        },
      });
      const custom = s.get('keys.' + c.id) !== undefined;
      return h(`div.setting${custom ? '.changed' : ''}`,
        h('div.setting-text', h('div.setting-title', c.title), h('div.setting-desc', c.category),
          custom ? h('button.link.setting-reset', { on: { click: () => { delete s.values['keys.' + c.id]; s.scheduleSave(); s.events.emit('change', 'keys.' + c.id); } } }, 'Reset to default') : null),
        h('div.setting-control', input));
    });
  };

  const openFile = async () => {
    await s.saveNow();
    const info = await invoke('app_info');
    close();
    ide.workspace.openFile(join(info.config_dir, 'settings.json'));
  };

  const keep = () => {
    const y = body.scrollTop;
    const focusedLabel = document.activeElement?.getAttribute('aria-label');
    render();
    body.scrollTop = y;
    if (focusedLabel) body.querySelector(`[aria-label="${CSS.escape(focusedLabel)}"]`)?.focus();
  };
  const off = [s.events.on('change', keep), s.events.on('defined', keep)];
  search.addEventListener('input', render);
  document.body.append(back);
  render();
  if (focusSection) document.getElementById('set-' + focusSection.toLowerCase().replace(/\W+/g, '-'))?.scrollIntoView({ block: 'start' });
  search.focus();
}

export function defineAppearance(ide) {
  const s = ide.settings;
  s.define({
    key: 'ui.theme', title: 'Theme', description: 'Every color can also be changed, under Colors.', type: 'select', default: 'system', section: 'Appearance',
    options: [{ value: 'system', label: 'Match my computer (Monokai Night or Day)' }, ...Object.entries(THEMES).map(([value, t]) => ({ value, label: `${t.label} (${t.dark ? 'dark' : 'light'})` }))],
  });
  s.define({ key: 'ui.fontSize', title: 'Interface text size', description: 'The size of menus, panels and buttons. The code size is under Editor.', type: 'number', default: 13, min: 10, max: 22, section: 'Appearance' });
  s.define({ key: 'ui.reduceMotion', title: 'Reduce motion', description: 'Turns off animations.', type: 'boolean', default: false, section: 'Appearance' });
  const media = matchMedia('(prefers-color-scheme: light)');
  const style = h('style#theme-colors');
  document.head.append(style);
  const apply = () => {
    const id = currentTheme(s);
    document.documentElement.dataset.theme = THEMES[id].dark ? 'night' : 'day';
    // The theme's colors with any changed ones on top, in one rule (cheap to swap).
    const colors = { ...themeColors(id), ...(s.get('colors.' + id) || {}) };
    const css = Object.entries(colors).filter(([k, v]) => /^--[\w-]+$/.test(k) && parseColor(v)).map(([k, v]) => `${k}:${v};`).join('');
    if (style.textContent !== css) style.textContent = css ? `:root:root{${css}}` : '';
    document.documentElement.style.setProperty('--ui-size', s.get('ui.fontSize') + 'px');
    document.documentElement.classList.toggle('reduce-motion', !!s.get('ui.reduceMotion'));
  };
  media.addEventListener('change', apply);
  s.onChange('ui.', apply);
  s.onChange('colors.', apply);
  apply();
}

/** The theme in use: the chosen one, or Night or Day to match the computer. */
export function currentTheme(s) {
  const t = s.get('ui.theme');
  if (THEMES[t]) return t;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'day' : 'night';
}
