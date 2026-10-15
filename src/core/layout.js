// The window's layout. Plugins add sidebar views, bottom panels, toolbar buttons
// and status bar items through these registries.
//
//  ┌ toolbar ─────────────────────────────────────────────┐
//  │ activity │ sidebar │ tabs / editor                   │
//  │   bar    │  view   ├─────────────────────────────────┤
//  │          │         │ bottom panel (Output, Problems…)│
//  └ status bar ──────────────────────────────────────────┘

import { h, clear, icon } from './ui.js';

export class Layout {
  constructor(ide, root) {
    this.ide = ide;
    this.views = new Map(); // sidebar views
    this.panels = new Map(); // bottom panels
    this.activeView = null;
    this.activePanel = null;

    this.toolbarLeft = h('div.toolbar-group');
    this.toolbarRight = h('div.toolbar-group');
    this.activity = h('nav.activity', { 'aria-label': 'Views' });
    this.activityBottom = h('div.activity-bottom');
    this.sideTitle = h('div.side-title');
    this.sideActions = h('div.side-actions');
    this.sideBody = h('div.side-body');
    this.sidebar = h('aside.sidebar', h('div.side-head', this.sideTitle, this.sideActions), this.sideBody);
    this.tabs = h('div.tabs', { role: 'tablist', 'aria-label': 'Open files' });
    this.tabsEnd = h('div.tabs-end');
    this.tabsBar = h('div.tabs-bar', this.tabs, this.tabsEnd);
    this.crumbs = h('div.crumbs', { 'aria-label': 'Current file' });
    this.editorHost = h('div.editor-host');
    this.panelTabs = h('div.panel-tabs', { role: 'tablist', 'aria-label': 'Panels' });
    this.panelActions = h('div.panel-actions');
    this.panelBody = h('div.panel-body');
    this.bottom = h('section.bottom', h('div.panel-head', this.panelTabs, this.panelActions), this.panelBody);
    this.statusLeft = h('div.status-group');
    this.statusRight = h('div.status-group');

    const sideGrip = h('div.grip.grip-x', { title: 'Drag to resize' });
    const bottomGrip = h('div.grip.grip-y', { title: 'Drag to resize' });
    this.center = h('div.center', this.tabsBar, this.editorHost, bottomGrip, this.bottom);
    root.append(
      h('header.toolbar', h('div.brand', { title: 'JLB IDE' }, h('img', { src: 'icon.svg', alt: '' })), this.crumbs, this.toolbarLeft, h('div.spacer'), this.toolbarRight),
      h('div.main', h('div.activity-col', this.activity, this.activityBottom), this.sidebar, sideGrip, this.center),
      h('footer.statusbar', this.statusLeft, h('div.spacer'), this.statusRight),
    );

    const s = ide.settings;
    s.define({ key: 'layout.sidebarWidth', type: 'number', default: 250, hidden: true });
    s.define({ key: 'layout.bottomHeight', type: 'number', default: 220, hidden: true });
    s.define({ key: 'layout.sidebarOpen', type: 'boolean', default: true, hidden: true });
    s.define({ key: 'layout.bottomOpen', type: 'boolean', default: true, hidden: true });
    this.drag(sideGrip, 'x', 'layout.sidebarWidth', 150, 600);
    this.drag(bottomGrip, 'y', 'layout.bottomHeight', 80, 900);
    this.applySizes();
    s.onChange('layout.', () => this.applySizes());
  }

  applySizes() {
    const s = this.ide.settings;
    this.sidebar.style.width = s.get('layout.sidebarWidth') + 'px';
    this.bottom.style.height = s.get('layout.bottomHeight') + 'px';
    document.body.classList.toggle('no-sidebar', !s.get('layout.sidebarOpen'));
    document.body.classList.toggle('no-bottom', !s.get('layout.bottomOpen'));
  }

  drag(grip, axis, key, min, max) {
    grip.addEventListener('pointerdown', (e) => {
      grip.setPointerCapture(e.pointerId);
      const start = axis === 'x' ? e.clientX : e.clientY;
      const size = this.ide.settings.get(key);
      const move = (ev) => {
        const d = (axis === 'x' ? ev.clientX : ev.clientY) - start;
        const v = Math.round(Math.min(max, Math.max(min, axis === 'x' ? size + d : size - d)));
        (axis === 'x' ? this.sidebar : this.bottom).style[axis === 'x' ? 'width' : 'height'] = v + 'px';
        grip.dataset.size = v;
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        if (grip.dataset.size) this.ide.settings.set(key, Number(grip.dataset.size));
        delete grip.dataset.size;
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up, { once: true });
    });
  }

  // ---------- sidebar views ----------

  /** { id, title, icon, order, render(el, view), actions: [{ icon, title, run }], bottom }
   *  (or { id, title, icon, run } for a button that does something instead of showing a view) */
  addView(view) {
    const v = { order: 50, ...view };
    v.button = h('button.activity-btn', {
      title: v.title,
      'aria-label': v.title,
      on: { click: () => (v.run ? v.run() : this.toggleView(v.id)) },
    }, icon(v.icon || 'list', 22));
    this.views.set(v.id, v);
    this.renderActivity();
    if (!this.activeView && !v.bottom && !v.run && this.ide.settings.get('layout.sidebarOpen')) this.showView(v.id);
    return () => {
      this.views.delete(v.id);
      this.renderActivity();
      if (this.activeView === v.id) {
        this.activeView = null;
        const next = [...this.views.values()].find((x) => !x.bottom && !x.run);
        if (next) this.showView(next.id);
        else clear(this.sideBody);
      }
    };
  }

  renderActivity() {
    const sorted = [...this.views.values()].sort((a, b) => a.order - b.order);
    clear(this.activity);
    clear(this.activityBottom);
    for (const v of sorted) (v.bottom ? this.activityBottom : this.activity).append(v.button);
  }

  toggleView(id) {
    const open = this.ide.settings.get('layout.sidebarOpen');
    if (open && this.activeView === id) this.ide.settings.set('layout.sidebarOpen', false);
    else this.showView(id);
  }

  showView(id) {
    const v = this.views.get(id);
    if (!v || v.run) return;
    this.ide.settings.set('layout.sidebarOpen', true);
    if (this.activeView !== id) {
      const old = this.views.get(this.activeView);
      old?.onHide?.();
      this.activeView = id;
      this.sideTitle.textContent = v.title;
      clear(this.sideActions);
      for (const a of v.actions || []) {
        this.sideActions.append(h('button.icon-btn', { title: a.title, 'aria-label': a.title, on: { click: a.run } }, icon(a.icon, 16)));
      }
      clear(this.sideBody);
      v.el ||= h('div.view');
      this.sideBody.append(v.el);
      if (!v.rendered) {
        v.rendered = true;
        v.render(v.el, v);
      }
      v.onShow?.();
    }
    for (const x of this.views.values()) x.button.classList.toggle('active', x.id === id);
  }

  // ---------- bottom panels ----------

  /** { id, title, order, render(el), actions: [{ icon, title, run }] } */
  addPanel(panel) {
    const p = { order: 50, ...panel };
    p.tab = h('button.panel-tab', { role: 'tab', on: { click: () => this.showPanel(p.id) } }, p.title, h('span.badge'));
    p.el = h('div.panel', { role: 'tabpanel' });
    this.panels.set(p.id, p);
    this.renderPanelTabs();
    if (!this.activePanel) this.showPanel(p.id, { focus: false });
    return () => {
      this.panels.delete(p.id);
      this.renderPanelTabs();
      if (this.activePanel === p.id) {
        this.activePanel = null;
        const next = [...this.panels.values()].sort((a, b) => a.order - b.order)[0];
        if (next) this.showPanel(next.id, { focus: false });
        else clear(this.panelBody);
      }
    };
  }

  renderPanelTabs() {
    clear(this.panelTabs);
    for (const p of [...this.panels.values()].sort((a, b) => a.order - b.order)) this.panelTabs.append(p.tab);
  }

  showPanel(id, { focus = true, open = true } = {}) {
    const p = this.panels.get(id);
    if (!p) return;
    if (open) this.ide.settings.set('layout.bottomOpen', true);
    if (this.activePanel !== id) {
      this.activePanel = id;
      clear(this.panelBody);
      this.panelBody.append(p.el);
      if (!p.rendered) {
        p.rendered = true;
        p.render(p.el, p);
      }
      clear(this.panelActions);
      for (const a of p.actions || []) {
        this.panelActions.append(h('button.icon-btn', { title: a.title, 'aria-label': a.title, on: { click: a.run } }, icon(a.icon, 16)));
      }
    }
    for (const x of this.panels.values()) {
      x.tab.classList.toggle('active', x.id === id);
      x.tab.setAttribute('aria-selected', x.id === id ? 'true' : 'false');
    }
    p.onShow?.({ focus });
  }

  /** Shows a number (or nothing) next to a panel's name, like a count of problems. */
  setBadge(id, value, kind = '') {
    const b = this.panels.get(id)?.tab.querySelector('.badge');
    if (!b) return;
    b.textContent = value ? String(value) : '';
    b.className = 'badge' + (kind ? ' ' + kind : '');
  }

  // ---------- toolbar and status bar ----------

  /** Adds an element to the toolbar (side "left" or "right"). */
  addToolbar(el, side = 'left') {
    (side === 'right' ? this.toolbarRight : this.toolbarLeft).append(el);
    return () => el.remove();
  }

  /** Adds an element to the status bar (side "left" or "right"). */
  addStatus(el, side = 'left') {
    (side === 'right' ? this.statusRight : this.statusLeft).append(el);
    return () => el.remove();
  }
}
