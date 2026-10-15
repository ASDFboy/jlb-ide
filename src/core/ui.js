// Small UI helpers shared by the IDE and plugins: building elements, icons,
// toasts, dialogs and context menus.

/** h('div.class#id', { attrs, on: { click } }, ...children) */
export function h(tag, props, ...children) {
  if (props instanceof Node || typeof props === 'string' || Array.isArray(props)) {
    children.unshift(props);
    props = null;
  }
  const [, name = 'div', rest = ''] = tag.match(/^([a-z0-9-]*)(.*)$/i);
  const el = document.createElement(name || 'div');
  for (const part of rest.match(/[.#][^.#]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

const ICONS = {
  files: '<path d="M4 4h6l2 2h8v13H4z"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  folder: '<path d="M3 6h7l2 2h9v11H3z"/>',
  'folder-open': '<path d="M3 6h7l2 2h8v3"/><path d="M3 19l3-8h16l-3 8z"/>',
  book: '<path d="M5 4h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H5z"/><path d="M19 4h-6a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6z"/>',
  puzzle: '<path d="M9 4h4v3a2 2 0 1 0 4 0V4h3v6h-3a2 2 0 1 0 0 4h3v6H4V14h3a2 2 0 1 0 0-4H4V4h5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  play: '<path d="M7 4l13 8-13 8z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  pencil: '<path d="M4 20l1-5L16 4l4 4L9 19z"/>',
  flask: '<path d="M9 3h6M10 3v6L4 19a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2l-6-10V3"/><path d="M7 15h10"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  'chevron-down': '<path d="M6 9l6 6 6-6"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  terminal: '<path d="M4 5h16v14H4z"/><path d="M8 10l3 2-3 2M13 15h4"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.5M4 12h.5M4 18h.5"/>',
  bug: '<rect x="7" y="8" width="10" height="12" rx="5"/><path d="M12 8v12M7 13H3M21 13h-4M8 5l2 3M16 5l-2 3M4 8l3 2M20 8l-3 2M4 19l3-2M20 19l-3-2"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/>',
  continue: '<path d="M5 5v14"/><path d="M9 5l11 7-11 7z" fill="currentColor" stroke="none"/>',
  'step-over': '<path d="M4 14a8 8 0 0 1 14.5-4.5"/><path d="M19.5 4.5v5.5h-5.5"/><circle cx="12" cy="19" r="2" fill="currentColor"/>',
  'step-into': '<path d="M12 3v10"/><path d="M8 9l4 4 4-4"/><circle cx="12" cy="19.5" r="2" fill="currentColor"/>',
  'step-out': '<path d="M12 14V4"/><path d="M8 8l4-4 4 4"/><circle cx="12" cy="19.5" r="2" fill="currentColor"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 10v10"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  code: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/>',
  dot: '<circle cx="12" cy="12" r="6" fill="currentColor" stroke="none"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  replace: '<path d="M4 8h14l-4-4"/><path d="M20 16H6l4 4"/>',
};

/** An inline SVG icon by name (plugins can pass their own SVG path markup instead). */
export function icon(name, size = 18) {
  const body = ICONS[name] || name;
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  return span;
}

// ---------- toasts ----------

let toastBox = null;

/** A short message in the corner. kind: "info" | "error" | "ok" */
export function toast(message, { kind = 'info', timeout = 4000 } = {}) {
  if (!toastBox) {
    toastBox = h('div.toasts', { role: 'status', 'aria-live': 'polite' });
    document.body.append(toastBox);
  }
  const t = h(`div.toast.${kind}`, message);
  toastBox.append(t);
  const remove = () => t.remove();
  if (timeout) setTimeout(remove, timeout);
  t.addEventListener('click', remove);
  return remove;
}

// ---------- dialogs ----------

function modal(build) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const close = (value) => {
      back.remove();
      prev?.focus?.();
      resolve(value);
    };
    const box = h('div.dialog', { role: 'dialog', 'aria-modal': 'true' });
    const back = h('div.dialog-back', { on: { mousedown: (e) => e.target === back && close(null) } }, box);
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(null);
      }
      // Enter on a button presses it here, so the key doesn't also reach the editor
      // that gets the focus back when the dialog closes.
      if (e.key === 'Enter' && e.target.tagName === 'BUTTON') {
        e.preventDefault();
        e.target.click();
      }
    });
    build(box, close);
    document.body.append(back);
    (box.querySelector('[autofocus]') || box.querySelector('input, button'))?.focus();
  });
}

/** Asks a yes/no question. Gives back true or false. */
export function confirm(message, { ok = 'OK', cancel = 'Cancel', danger = false, detail } = {}) {
  return modal((box, close) => {
    box.append(
      h('p.dialog-msg', message),
      detail ? h('p.dialog-detail', detail) : null,
      h('div.dialog-buttons',
        h('button.btn', { on: { click: () => close(false) } }, cancel),
        h(`button.btn.${danger ? 'danger' : 'primary'}`, { autofocus: true, on: { click: () => close(true) } }, ok)),
    );
  }).then((v) => v === true);
}

/** Asks for a line of text. Gives back the text, or null if cancelled. */
export function prompt(message, { value = '', ok = 'OK', placeholder = '', select } = {}) {
  return modal((box, close) => {
    const input = h('input.input', { value, placeholder, autofocus: true, spellcheck: false });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      // Otherwise the Enter would also type a new line in the editor that gets the focus back.
      e.preventDefault();
      close(input.value);
    });
    box.append(
      h('label.dialog-msg', message, input),
      h('div.dialog-buttons',
        h('button.btn', { on: { click: () => close(null) } }, 'Cancel'),
        h('button.btn.primary', { on: { click: () => close(input.value) } }, ok)),
    );
    setTimeout(() => {
      if (select) input.setSelectionRange(...select);
      else input.select();
    });
  });
}

/** Asks the person to pick one of several choices. Gives back its value, or null. */
export function choose(message, choices, { detail } = {}) {
  return modal((box, close) => {
    box.append(
      h('p.dialog-msg', message),
      detail ? h('p.dialog-detail', detail) : null,
      h('div.dialog-buttons', choices.map((c, i) =>
        h(`button.btn${c.primary ? '.primary' : ''}${c.danger ? '.danger' : ''}`, { autofocus: c.primary, on: { click: () => close(c.value) } }, c.label))),
    );
  });
}

// ---------- context menus ----------

/** Shows a menu at the mouse. items: [{ label, run, danger }] or null for a separator. */
export function contextMenu(event, items) {
  event.preventDefault();
  document.querySelector('.menu')?.remove();
  const menu = h('div.menu', { role: 'menu' });
  for (const it of items) {
    if (!it) {
      menu.append(h('div.menu-sep'));
      continue;
    }
    menu.append(h(`button.menu-item${it.danger ? '.danger' : ''}`, {
      role: 'menuitem',
      on: { click: () => { menu.remove(); it.run(); } },
    }, it.label));
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(event.clientX, innerWidth - r.width - 4) + 'px';
  menu.style.top = Math.min(event.clientY, innerHeight - r.height - 4) + 'px';
  menu.querySelector('button')?.focus();
  const away = (e) => {
    if (!menu.contains(e.target) || e.key === 'Escape') {
      menu.remove();
      removeEventListener('mousedown', away, true);
      removeEventListener('keydown', esc, true);
    }
  };
  const esc = (e) => e.key === 'Escape' && away(e);
  setTimeout(() => {
    addEventListener('mousedown', away, true);
    addEventListener('keydown', esc, true);
  });
}
