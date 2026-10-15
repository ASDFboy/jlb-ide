// Language services: hover info, suggestions and mistake checking. The IDE owns
// the machinery; features and plugins supply the content through:
//   addHover(provider)      info shown when the mouse rests on code
//   addCompletions(source)  suggestions while typing
//   addCheck(rule)          mistakes shown as squiggles and in the Problems panel

import { hoverTooltip } from '@codemirror/view';
import { autocompletion } from '@codemirror/autocomplete';
import { linter, forceLinting } from '@codemirror/lint';
import { h, clear, icon } from './ui.js';
import { OPERATORS } from '../lang/data.js';

const OP_CHARS = /[!=<>&|~^%+\-*/@.]/;
const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

export class Language {
  constructor(ide) {
    this.ide = ide;
    this.hovers = [];
    this.completions = [];
    this.checks = [];
    this.problems = [];
    const s = ide.settings;
    s.define({ key: 'editor.hover', title: 'Show info when the mouse rests on code', type: 'boolean', default: true, section: 'Editor' });
    s.define({ key: 'editor.hoverDelay', title: 'Hover delay', description: 'Milliseconds before hover info appears.', type: 'number', default: 350, min: 0, max: 3000, section: 'Editor' });
    s.define({ key: 'editor.suggest', title: 'Suggest words while typing', description: 'Ctrl+Space shows suggestions even when this is off.', type: 'boolean', default: true, section: 'Editor' });
    s.define({ key: 'editor.checkDelay', title: 'Checking delay', description: 'Milliseconds after you stop typing before code is checked for mistakes.', type: 'number', default: 400, min: 0, max: 5000, section: 'Editor' });

    this.removeExt = null;
    this.rebuild();
    s.onChange('editor.hover', () => this.rebuild());
    s.onChange('editor.hoverDelay', () => this.rebuild());
    s.onChange('editor.suggest', () => this.rebuild());
    s.onChange('editor.checkDelay', () => this.rebuild());
    ide.events.on('active-change', () => this.recheck());
  }

  /** Rebuilds the editor extensions after settings or providers change. */
  rebuild() {
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => {
      this.removeExt?.();
      const s = this.ide.settings;
      const exts = [];
      if (s.get('editor.hover') && this.hovers.length) {
        exts.push(hoverTooltip((view, pos, side) => this.hover(view, pos, side), { hoverTime: s.get('editor.hoverDelay') }));
      }
      exts.push(autocompletion({
        override: [(ctx) => this.complete(ctx)],
        activateOnTyping: s.get('editor.suggest'),
        icons: false,
        closeOnBlur: true,
      }));
      if (this.checks.length) exts.push(linter((view) => this.check(view), { delay: s.get('editor.checkDelay') }));
      else this.setProblems([]);
      this.removeExt = this.ide.editor.addExtension(exts);
    });
  }

  // ---------- hover ----------

  addHover(provider) {
    this.hovers.push(provider);
    this.rebuild();
    return () => {
      this.hovers = this.hovers.filter((p) => p !== provider);
      this.rebuild();
    };
  }

  /** What's under the mouse: the word, and the longest operator touching it. */
  context(state, pos) {
    const line = state.doc.lineAt(pos);
    const text = line.text;
    const i = pos - line.from;
    let a = i;
    let b = i;
    while (a > 0 && /\w/.test(text[a - 1])) a--;
    while (b < text.length && /\w/.test(text[b])) b++;
    const word = b > a ? { text: text.slice(a, b), from: line.from + a, to: line.from + b } : null;
    let op = null;
    if (OP_CHARS.test(text[i] || '') || OP_CHARS.test(text[i - 1] || '')) {
      let s = i;
      let e = i;
      while (s > 0 && OP_CHARS.test(text[s - 1])) s--;
      while (e < text.length && OP_CHARS.test(text[e])) e++;
      // The longest known operator in that run of symbols that covers the mouse.
      for (let len = e - s; len > 0 && !op; len--) {
        for (let st = s; st + len <= e; st++) {
          const cand = text.slice(st, st + len);
          if (OPERATORS[cand] && st <= i && i <= st + len) {
            op = { text: cand, from: line.from + st, to: line.from + st + len };
            break;
          }
        }
      }
    }
    const inComment = /(^|[^>])>>/.test(text.slice(0, i)) && !/["']/.test(text.slice(0, i));
    return { state, pos, line, word, op, inComment };
  }

  async hover(view, pos, side) {
    const ctx = this.context(view.state, pos);
    for (const p of this.hovers) {
      let r;
      try {
        r = await p(ctx);
      } catch (e) {
        console.error('[jlb-ide] a hover provider failed:', e);
      }
      if (!r) continue;
      const range = r.range || ctx.op || ctx.word || { from: pos, to: pos };
      return {
        pos: range.from,
        end: range.to,
        above: true,
        create: () => {
          const dom = h('div.hover-card',
            r.title ? h('div.hover-title', r.code === false ? r.title : h('code', r.title)) : null,
            r.subtitle ? h('div.hover-sub', r.subtitle) : null,
            r.body ? h('div.hover-body', r.body) : null,
            r.example ? h('pre.hover-example', r.example) : null,
            r.more ? h('button.hover-more', { on: { mousedown: (e) => { e.preventDefault(); r.more.run(); } } }, r.more.label) : null);
          return { dom };
        },
      };
    }
    return null;
  }

  // ---------- suggestions ----------

  addCompletions(source) {
    this.completions.push(source);
    return () => {
      this.completions = this.completions.filter((s) => s !== source);
    };
  }

  async complete(ctx) {
    const results = [];
    for (const src of this.completions) {
      try {
        const r = await src(ctx);
        if (r) results.push(r);
      } catch (e) {
        console.error('[jlb-ide] a suggestion source failed:', e);
      }
    }
    if (!results.length) return null;
    const from = Math.min(...results.map((r) => r.from));
    return {
      from,
      options: results.flatMap((r) => r.options),
      validFor: /^\w*$/,
    };
  }

  // ---------- checks ----------

  /**
   * rule: { id, title, check(ctx) } — check gives back (or resolves to) a list of
   * { line, col?, endCol?, from?, to?, severity, message, fix?: { label, text } }.
   * ctx: { text, state, path, interpreter }.
   */
  addCheck(rule) {
    this.checks.push(rule);
    this.rebuild();
    return () => {
      this.checks = this.checks.filter((r) => r !== rule);
      this.rebuild();
    };
  }

  recheck() {
    const v = this.ide.editor.view;
    if (this.checks.length) setTimeout(() => forceLinting(v), 30);
  }

  async check(view) {
    const state = view.state;
    const doc = this.ide.workspace.active;
    const ctx = { text: state.doc.toString(), state, path: doc?.path || null, doc };
    const all = [];
    for (const rule of this.checks) {
      try {
        const found = (await rule.check(ctx)) || [];
        for (const d of found) all.push({ ...d, source: d.source || rule.title || rule.id });
      } catch (e) {
        console.error(`[jlb-ide] the check "${rule.id}" failed:`, e);
      }
    }
    // The text may have changed while checks ran; drop results for an old version.
    if (view.state.doc !== state.doc) return [];
    const out = [];
    for (const d of all) {
      const r = this.range(state, d);
      if (!r) continue;
      out.push({
        from: r.from,
        to: r.to,
        severity: d.severity || 'error',
        message: d.message,
        source: d.source,
        actions: d.fix ? [].concat(d.fix).map((f) => ({
          name: f.label || 'Fix',
          apply: (v, from, to) => v.dispatch({ changes: { from, to, insert: f.text } }),
        })) : undefined,
      });
    }
    this.setProblems(out.map((d) => ({ ...d, line: state.doc.lineAt(d.from).number, col: d.from - state.doc.lineAt(d.from).from + 1, file: doc })));
    return out;
  }

  /** Turns line/column (1-based) into editor offsets; a missing column covers the line's text. */
  range(state, d) {
    if (d.from !== undefined) return { from: d.from, to: d.to ?? d.from };
    if (!d.line || d.line > state.doc.lines) return null;
    const line = state.doc.line(d.line);
    if (!d.col) {
      const start = line.from + (line.text.length - line.text.trimStart().length);
      return { from: start, to: Math.max(start, line.to) };
    }
    const from = Math.min(line.from + d.col - 1, line.to);
    let to;
    if (d.endCol) to = Math.min(line.from + d.endCol - 1, line.to);
    else {
      // Cover the word or symbol run that starts there.
      const rest = line.text.slice(from - line.from);
      const m = rest.match(/^(\w+|["'][^"']*["']?|[^\s\w]+)/);
      to = from + (m ? m[0].length : 1);
    }
    return { from, to: Math.max(to, from) };
  }

  setProblems(list) {
    this.problems = list.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.from - b.from);
    this.ide.events.emit('problems', this.problems);
  }

  problemsPanel() {
    let el;
    const render = () => {
      if (!el) return;
      clear(el);
      const list = this.problems;
      const errors = list.filter((p) => p.severity === 'error').length;
      this.ide.layout.setBadge('problems', list.length || '', errors ? 'error' : list.length ? 'warning' : '');
      if (!list.length) {
        el.append(h('div.empty-note', h('p', this.checks.length ? 'No problems found in this file.' : 'Mistake checking is off. Turn it on in Settings → Features.')));
        return;
      }
      const ul = h('ul.problem-list');
      for (const p of list) {
        ul.append(h(`li.problem.${p.severity}`, {
          tabindex: '0',
          on: {
            click: () => this.ide.editor.goTo(p.line, p.col),
            keydown: (e) => e.key === 'Enter' && this.ide.editor.goTo(p.line, p.col),
          },
        }, icon(p.severity === 'info' ? 'info' : 'alert', 15), h('span.problem-msg', p.message), h('span.problem-where', { title: p.source || '' }, `Line ${p.line}`)));
      }
      el.append(ul);
    };
    this.ide.events.on('problems', render);
    return {
      id: 'problems',
      title: 'Problems',
      order: 20,
      render: (e) => {
        el = e;
        el.classList.add('problems');
        render();
      },
    };
  }
}
