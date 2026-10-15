// The debugger: breakpoints, stepping through a program line by line, and every
// variable's value while it's stopped. It drives the Rust interpreter's --debug
// mode (described in the jlb-rust repo, docs/09-programs-and-files.md).

export default {
  id: 'debugger',
  name: 'Debugger',
  description: 'Stops a program at breakpoints so you can step through it line by line and see every variable, including what\'s inside tables.',
  builtin: true,
  settings: [
    { key: 'stopAtBreakpoints', title: 'Stop at breakpoints when running', description: 'With breakpoints set, Run (F5) stops at them. When off, only Start debugging (F6) does.', type: 'boolean', default: true },
    { key: 'stopOnError', title: 'Stop when an error would end the program', description: 'So you can look at every variable before the program ends. Errors caught by TRY never stop it.', type: 'boolean', default: true },
    { key: 'showView', title: 'Show the Debug view when the program stops', type: 'boolean', default: true },
    { key: 'hoverValues', title: 'Show values when hovering a name while stopped', type: 'boolean', default: true },
    { key: 'breakpoints', type: 'text', default: '{}', hidden: true },
    { key: 'watches', type: 'text', default: '[]', hidden: true },
  ],
  activate(api) {
    const { h, clear, icon } = api.ui;
    const { StateField, StateEffect, RangeSet, Prec } = api.cm.state;
    const { gutter, GutterMarker, Decoration, EditorView } = api.cm.view;

    // ---------- breakpoints in the editor ----------

    const toggleAt = StateEffect.define(); // a line's start position
    const resetTo = StateEffect.define(); // line numbers
    class Dot extends GutterMarker {
      toDOM() {
        return h('span.bp-dot', { title: 'Breakpoint (click to remove)' });
      }
    }
    class Arrow extends GutterMarker {
      constructor(top) {
        super();
        this.top = top;
      }
      eq(o) {
        return o.top === this.top;
      }
      toDOM() {
        return h(`span.bp-here${this.top ? '' : '.caller'}`, icon('play', 11));
      }
    }
    const dot = new Dot();
    const bpField = StateField.define({
      create: () => RangeSet.empty,
      update(set, tr) {
        set = set.map(tr.changes);
        for (const e of tr.effects) {
          if (e.is(toggleAt)) {
            let has = false;
            set.between(e.value, e.value, () => {
              has = true;
            });
            set = has ? set.update({ filter: (from) => from !== e.value }) : set.update({ add: [dot.range(e.value)], sort: true });
          } else if (e.is(resetTo)) {
            const doc = tr.state.doc;
            const ranges = [...new Set(e.value)].filter((n) => n >= 1 && n <= doc.lines).sort((a, b) => a - b).map((n) => dot.range(doc.line(n).from));
            set = RangeSet.of(ranges);
          }
        }
        return set;
      },
    });
    const linesOf = (state) => {
      const set = state.field(bpField, false);
      const out = new Set();
      if (set) set.between(0, state.doc.length, (from) => void out.add(state.doc.lineAt(from).number));
      return [...out].sort((a, b) => a - b);
    };

    // Where the program is stopped: a highlighted line and an arrow in the gutter.
    const setHere = StateEffect.define(); // { line, top } or null
    const hereField = StateField.define({
      create: () => ({ deco: Decoration.none, gutter: RangeSet.empty }),
      update(v, tr) {
        v = { deco: v.deco.map(tr.changes), gutter: v.gutter.map(tr.changes) };
        for (const e of tr.effects) {
          if (!e.is(setHere)) continue;
          if (!e.value || e.value.line > tr.state.doc.lines) v = { deco: Decoration.none, gutter: RangeSet.empty };
          else {
            const from = tr.state.doc.line(e.value.line).from;
            v = {
              deco: Decoration.set([Decoration.line({ class: e.value.top ? 'cm-debug-line' : 'cm-debug-line caller' }).range(from)]),
              gutter: RangeSet.of([new Arrow(e.value.top).range(from)]),
            };
          }
        }
        return v;
      },
      provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
    });

    const toggleLine = (view, lineNo) => {
      const line = view.state.doc.line(lineNo);
      view.dispatch({ effects: toggleAt.of(line.from) });
    };

    api.editor.addExtension([
      bpField,
      hereField,
      Prec.high(gutter({
        class: 'cm-bp-gutter',
        markers: (v) => [v.state.field(bpField), v.state.field(hereField).gutter],
        initialSpacer: () => dot,
        domEventHandlers: {
          mousedown(view, block, event) {
            if (event.button !== 0) return false;
            toggleLine(view, view.state.doc.lineAt(block.from).number);
            return true;
          },
        },
      })),
      EditorView.updateListener.of((u) => {
        // (A state that only just got the field, when a tab is first shown, has nothing to remember.)
        const before = u.startState.field(bpField, false);
        if (before && u.state.field(bpField) !== before) remember(api.workspace.active, u.state);
      }),
    ]);

    // Breakpoints are kept per file, so they come back when the file is opened again.
    let saved = {};
    try {
      saved = JSON.parse(api.settings.get('breakpoints') || '{}');
    } catch {
      saved = {};
    }
    const unsavedDocs = new WeakMap(); // untitled tabs: doc -> lines
    let rememberTimer = null;
    const remember = (doc, state) => {
      if (!doc) return;
      const lines = linesOf(state);
      if (!doc.path) unsavedDocs.set(doc, lines);
      else if (lines.length) saved[doc.path] = lines;
      else delete saved[doc.path];
      clearTimeout(rememberTimer);
      rememberTimer = setTimeout(() => api.settings.set('breakpoints', JSON.stringify(saved)), 300);
      if (session) sendBreaks(doc.path, lines);
      renderSoon();
    };
    const restoreInto = (doc) => {
      const view = api.editor.view;
      if (!doc || api.workspace.active !== doc || linesOf(view.state).length) return;
      const lines = doc.path ? saved[doc.path] : unsavedDocs.get(doc);
      if (lines?.length) view.dispatch({ effects: resetTo.of(lines) });
    };
    api.events.on('active-change', (doc) => {
      setTimeout(() => {
        restoreInto(doc);
        showHere();
      });
    });
    setTimeout(() => restoreInto(api.workspace.active));
    // Save As gives an untitled tab a path: keep its breakpoints under it.
    api.events.on('file-save', (doc) => {
      const state = doc === api.workspace.active ? api.editor.view.state : doc.state;
      if (doc.path && linesOf(state).length && !saved[doc.path]) remember(doc, state);
    });

    /** Every breakpoint: open files (as they are now) and closed files (as remembered). */
    const allBreakpoints = () => {
      const all = new Map(Object.entries(saved));
      for (const doc of api.workspace.files) {
        const state = doc === api.workspace.active ? api.editor.view.state : doc.state;
        const lines = state.field(bpField, false) ? linesOf(state) : doc.path ? saved[doc.path] || [] : unsavedDocs.get(doc) || [];
        if (doc.path) {
          if (lines.length) all.set(doc.path, lines);
          else all.delete(doc.path);
        }
      }
      return all;
    };

    const toggleHere = () => {
      const view = api.editor.view;
      if (!api.workspace.active) return;
      toggleLine(view, view.state.doc.lineAt(view.state.selection.main.head).number);
    };

    const clearAll = () => {
      for (const doc of api.workspace.files) {
        if (doc === api.workspace.active) api.editor.view.dispatch({ effects: resetTo.of([]) });
        else if (doc.state.field(bpField, false)) doc.state = doc.state.update({ effects: resetTo.of([]) }).state;
        if (session && doc.path) sendBreaks(doc.path, []);
      }
      if (session) for (const p of Object.keys(saved)) sendBreaks(p, []);
      saved = {};
      api.settings.set('breakpoints', '{}');
      renderSoon();
    };

    // ---------- a debugging session ----------

    let session = null; // { doc, paused, frame, stepFirst }
    let evalId = 0;
    const waiting = new Map(); // eval id -> resolve
    let watches = [];
    try {
      watches = JSON.parse(api.settings.get('watches') || '[]');
    } catch {
      watches = [];
    }
    const watchValues = new Map(); // expression -> { ok, value | message }
    const expanded = new Set();
    // Values at the previous stop, to show which ones changed since.
    let before = new Map();
    let now = new Map();
    const flatten = (nodes, base, into) => {
      for (const n of nodes) {
        into.set(base + '/' + n.name, n.value);
        if (n.items) flatten(n.items, base + '/' + n.name, into);
      }
      return into;
    };
    // A frame's key stays the same while it runs, even as calls come and go above it.
    const frameKey = (p, i) => `f:${p.stack.length - i}:${p.stack[i].name}`;
    const snapshot = (p) => {
      const m = new Map();
      p.stack.forEach((f, i) => flatten(f.vars, frameKey(p, i), m));
      return flatten(p.globals, 'g', m);
    };

    const send = (cmd) => api.run.debug(cmd);
    const sendBreaks = (path, lines) => path && send(`break ${path}\t${lines.join(',')}`);

    // `how` is "eval", or "view" for a whole big table (for the table viewer).
    const evaluate = (expr, how = 'eval') => new Promise((resolve) => {
      const id = 'e' + ++evalId;
      waiting.set(id, resolve);
      send(`${how} ${id}\t${expr.replace(/[\r\n]+/g, ' ')}`).then((ok) => {
        if (!ok) {
          waiting.delete(id);
          resolve({ ok: false, message: 'the program isn\'t stopped' });
        }
      });
    });

    api.provide('debugger', {
      /** Whether Run should debug: when breakpoints are set and that's switched on. */
      wanted: () => api.settings.get('stopAtBreakpoints') && [...allBreakpoints().values()].some((l) => l.length),
    });

    api.events.on('run-start', ({ doc, debug, stepFirst }) => {
      session = debug ? { doc, paused: null, frame: 0, stepFirst } : null;
      watchValues.clear();
      before = new Map();
      now = new Map();
      showHere();
      render();
    });
    api.events.on('run-exit', () => {
      if (!session) return;
      session = null;
      for (const resolve of waiting.values()) resolve({ ok: false, message: 'the program ended' });
      waiting.clear();
      showHere();
      render();
    });

    api.events.on('debug-event', async (ev) => {
      if (!session) return;
      if (ev.event === 'ready') {
        for (const [path, lines] of allBreakpoints()) if (lines.length) sendBreaks(path, lines);
        send(session.stepFirst ? 'step' : 'continue');
      } else if (ev.event === 'paused') {
        if (ev.reason === 'error' && !api.settings.get('stopOnError')) {
          send('continue');
          return;
        }
        session.paused = ev;
        session.frame = 0;
        before = now;
        now = snapshot(ev);
        await showFrame(0);
        if (api.settings.get('showView')) api.layout.showView('debug');
        render();
        await refreshWatches();
      } else if (ev.event === 'resumed') {
        session.paused = null;
        showHere();
        render();
      } else if (ev.event === 'eval') {
        const resolve = waiting.get(ev.id);
        waiting.delete(ev.id);
        resolve?.(ev);
      }
    });

    const refreshWatches = async () => {
      if (!session?.paused) return;
      for (const w of watches) watchValues.set(w, await evaluate(w));
      render();
    };

    const frameOf = () => session?.paused?.stack[session.frame] || null;

    /** Opens the file of a stack frame and marks its line. */
    const showFrame = async (i) => {
      const f = session?.paused?.stack[i];
      if (!f) return;
      session.frame = i;
      if (f.path && norm(api.workspace.active?.path) !== norm(f.path)) await api.workspace.openFile(f.path);
      showHere();
      api.editor.goTo(f.line, 1);
    };

    const norm = (p) => (p || '').replace(/\\/g, '/').replace(/^([a-z]):/i, (m, d) => d.toLowerCase() + ':');

    /** Marks the stopped line in the file on screen (if it's the right file). */
    const showHere = () => {
      const view = api.editor.view;
      const f = frameOf();
      const doc = api.workspace.active;
      const here = f && doc && (f.path ? norm(f.path) === norm(doc.path) : doc === session.doc) ? { line: f.line, top: session.frame === 0 } : null;
      view.dispatch({ effects: setHere.of(here) });
    };

    const can = {
      paused: () => !!session?.paused,
      running: () => !!session && !session.paused,
    };
    const resume = (how) => {
      if (!session?.paused) return;
      send(how);
    };
    const start = () => api.run.start({ debug: true, stepFirst: true });

    // ---------- values ----------

    /** A value tree: a row per value, tables open to show their entries. */
    // `exprOf` gives the .jlb expression for a value (so the table viewer can load
    // all of a big table), or is null where that can't be worked out.
    const tree = (nodes, keyBase, depth = 0, exprOf = null) => {
      const out = [];
      for (const n of nodes) {
        const key = keyBase + '/' + n.name;
        const expr = exprOf ? exprOf(n.name) : null;
        const open = expanded.has(key);
        const hasKids = n.items?.length || n.more;
        const changed = before.has(key) && before.get(key) !== n.value && now.get(key) === n.value;
        const row = h(`div.dbg-var${hasKids ? '.table' : ''}${changed ? '.changed' : ''}`, {
          style: `padding-left: ${10 + depth * 14}px`,
          title: n.value,
          tabindex: hasKids ? '0' : null,
          on: hasKids ? {
            click: () => {
              if (open) expanded.delete(key);
              else expanded.add(key);
              render();
            },
            keydown: (e) => {
              if (e.key === 'Enter' || e.key === ' ' || (e.key === 'ArrowRight' && !open) || (e.key === 'ArrowLeft' && open)) {
                e.preventDefault();
                if (open) expanded.delete(key);
                else expanded.add(key);
                render();
                setTimeout(() => document.querySelector(`.dbg-var[data-key="${CSS.escape(key)}"]`)?.focus());
              }
            },
          } : {},
        },
        hasKids ? icon(open ? 'chevron-down' : 'chevron', 12) : h('span.dbg-twisty'),
        changed ? h('span.sr-only', 'changed: ') : null,
        h('span.dbg-name', n.name),
        h('span.dbg-value', open ? `${(n.items?.length || 0) + (n.more || 0)} entries` : n.value),
        n.type === 'TABLE' && api.use('tableview') ? h('button.icon-btn.dbg-view', {
          title: 'Open in the table viewer',
          'aria-label': `Open ${n.name} in the table viewer`,
          on: { click: (e) => { e.stopPropagation(); viewTable(n, expr); } },
        }, icon('table', 13)) : null,
        h('span.dbg-type', n.type));
        row.dataset.key = key;
        out.push(row);
        if (open) {
          out.push(...tree(n.items || [], key, depth + 1, expr ? (name) => expr + access(name) : null));
          if (n.more) out.push(h('div.dbg-more', { style: `padding-left: ${24 + (depth + 1) * 14}px` }, `…and ${n.more} more`));
        }
      }
      return out;
    };

    const access = (name) => (/^\d+$/.test(name) ? `[${name}]` : /^[a-z_][a-z0-9_]*$/.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`);

    /** Opens a table in the table viewer; "Load all" works it out again in full. */
    const viewTable = (node, expr) => {
      const tv = api.use('tableview');
      if (!tv) return;
      const at = session?.paused;
      tv.open({
        title: expr || node.name,
        node,
        load: expr ? async () => {
          if (!session?.paused || session.paused !== at) return null;
          const r = await evaluate(expr, 'view');
          if (!r.ok) throw new Error(r.message);
          return { ...r.value, name: node.name };
        } : null,
      });
    };

    /** Finds a.b.c in the stopped frame's variables (then the globals). */
    const lookup = (chain) => {
      const f = frameOf();
      if (!f) return null;
      let node = f.vars.find((v) => v.name === chain[0]) || session.paused.globals.find((v) => v.name === chain[0]);
      let where = node && f.vars.includes(node) ? (f.name ? `in ${f.name}()` : 'in its block') : 'outside functions';
      for (const part of chain.slice(1)) {
        node = node?.items?.find((x) => x.name === part);
        where = 'inside ' + chain[0];
      }
      return node ? { node, where } : null;
    };

    api.language.addHover(({ state, word, op }) => {
      if (!session?.paused || !word || op || !api.settings.get('hoverValues')) return null;
      const f = frameOf();
      const doc = api.workspace.active;
      if (!f || !doc || (f.path && norm(f.path) !== norm(doc.path))) return null;
      // hero.bag.gold: walk back over ".name" parts.
      const line = state.doc.lineAt(word.from);
      const prefix = line.text.slice(0, word.from - line.from);
      const chainBefore = prefix.match(/((?:[a-z_][a-z0-9_]*\.)+)$/)?.[1];
      const chain = [...(chainBefore ? chainBefore.split('.').filter(Boolean) : []), word.text];
      const found = lookup(chain);
      if (!found) return null;
      const { node, where } = found;
      const kids = node.items?.slice(0, 12).map((k) => `${k.name}: ${k.value}`).join('\n');
      return {
        title: `${chain.join('.')} = ${node.value}`,
        subtitle: `${node.type}, ${where}`,
        example: kids ? kids + (node.items.length > 12 || node.more ? '\n…' : '') : undefined,
      };
    });

    // ---------- the Debug view ----------

    let viewEl = null;
    let renderTimer = null;
    const renderSoon = () => {
      clearTimeout(renderTimer);
      renderTimer = setTimeout(render, 30);
    };

    const section = (title, extra, ...body) => h(`section.dbg-section.dbg-sec-${title.toLowerCase().replace(/\s+/g, '-')}`, h('h4.dbg-heading', h('span', title), extra), ...body);

    const render = () => {
      renderControls();
      if (!viewEl) return;
      clear(viewEl);
      const p = session?.paused;
      // Where things stand.
      let status;
      if (!session) {
        status = h('div.dbg-status', h('p', 'Not debugging.'), h('p.muted', 'Click left of a line number (or press F9) to set a breakpoint, then Run. Start debugging (F6) stops at the first line.'));
      } else if (!p) {
        status = h('div.dbg-status.running', h('p', 'Running…'), h('p.muted', 'It stops at the next breakpoint. Pause (F8) stops it now.'));
      } else {
        const where = `${p.stack[0]?.name ? p.stack[0].name + '(), ' : ''}line ${p.line}`;
        status = p.reason === 'error'
          ? h('div.dbg-status.error', h('p', icon('alert', 14), ` ${p.message}`), h('p.muted', `Stopped at ${where}, before the program ends. Continue to end it.`))
          : h('div.dbg-status.paused', h('p', `Stopped at ${where}`), h('p.muted', p.reason === 'breakpoint' ? 'At a breakpoint.' : p.reason === 'pause' ? 'Paused.' : 'After a step.'));
      }
      viewEl.append(controlsRow(), status);

      if (p) {
        viewEl.append(section('Call stack', null, h('ol.dbg-stack', p.stack.map((f, i) => h(`li${i === session.frame ? '.on' : ''}`,
          h('button.dbg-frame', { on: { click: async () => { await showFrame(i); render(); } } },
            h('span', f.name ? `${f.name}()` : 'top level'),
            h('span.muted', `${f.path ? f.path.split(/[\\/]/).pop() : ''}:${f.line}`)))))));
        const f = frameOf();
        const locals = f.vars;
        viewEl.append(section('Variables', null,
          locals.length ? h('div.dbg-vars', tree(locals, frameKey(p, session.frame), 0, session.frame === 0 ? (name) => name : null)) : null,
          h('div.dbg-sub', 'Outside functions'),
          // (A global hidden by a local of the same name can't be reached by its name.)
          p.globals.length ? h('div.dbg-vars', tree(p.globals, 'g', 0, (name) => (p.stack[0]?.vars.some((v) => v.name === name) ? null : name))) : h('p.view-note', 'None yet')));
      }

      // Watch expressions.
      const add = h('input.input.dbg-watch-input', {
        placeholder: 'Add an expression to watch, like hero.hp * 2',
        spellcheck: false,
        'aria-label': 'Expression to watch',
        on: {
          keydown: async (e) => {
            if (e.key !== 'Enter' || !e.target.value.trim()) return;
            const expr = e.target.value.trim();
            if (!watches.includes(expr)) watches.push(expr);
            api.settings.set('watches', JSON.stringify(watches));
            if (session?.paused) watchValues.set(expr, await evaluate(expr));
            render();
            setTimeout(() => viewEl.querySelector('.dbg-watch-input')?.focus());
          },
        },
      });
      viewEl.append(section('Watch', null,
        h('div.dbg-watches', watches.map((w) => {
          const v = watchValues.get(w);
          const value = !session?.paused ? h('span.muted', session ? 'running' : 'not running') : !v ? h('span.muted', '…') : v.ok ? null : h('span.dbg-err', v.message);
          return h('div.dbg-watch',
            v?.ok && session?.paused
              ? h('div.dbg-vars', tree([{ ...v.value, name: w }], 'w', 0, () => `(${w})`))
              : h('div.dbg-vars', h('div.dbg-var', { style: 'padding-left: 10px', title: v?.message || '' }, h('span.dbg-twisty'), h('span.dbg-name', w), h('span.dbg-value', value))),
            h('button.icon-btn.dbg-x', { title: 'Stop watching', 'aria-label': `Stop watching ${w}`, on: { click: () => { watches = watches.filter((x) => x !== w); api.settings.set('watches', JSON.stringify(watches)); render(); } } }, icon('x', 12)));
        })),
        add,
        session?.paused && session.frame > 0 ? h('p.view-note', 'Watches are worked out in the innermost function.') : null));

      // Breakpoints.
      const all = [...allBreakpoints()].filter(([, l]) => l.length);
      viewEl.append(section('Breakpoints', all.length ? h('button.link', { on: { click: clearAll } }, 'Remove all') : null,
        all.length ? h('ul.dbg-bps', all.flatMap(([path, lines]) => lines.map((n) => h('li',
          h('button.dbg-bp', { on: { click: async () => { if (norm(api.workspace.active?.path) !== norm(path)) await api.workspace.openFile(path); api.editor.goTo(n, 1); } } },
            h('span.bp-dot'), h('span', path.split(/[\\/]/).pop()), h('span.muted', `line ${n}`)),
          h('button.icon-btn.dbg-x', { title: 'Remove', 'aria-label': `Remove the breakpoint on line ${n}`, on: { click: () => removeBreak(path, n) } }, icon('x', 12))))))
          : h('p.view-note', 'None')));
    };

    const removeBreak = (path, n) => {
      const doc = api.workspace.files.find((d) => norm(d.path) === norm(path));
      const view = api.editor.view;
      if (doc === api.workspace.active) {
        if (n <= view.state.doc.lines) toggleLine(view, n);
      } else if (doc?.state.field(bpField, false)) {
        doc.state = doc.state.update({ effects: resetTo.of(linesOf(doc.state).filter((x) => x !== n)) }).state;
        remember(doc, doc.state);
      } else {
        saved[path] = (saved[path] || []).filter((x) => x !== n);
        if (!saved[path].length) delete saved[path];
        api.settings.set('breakpoints', JSON.stringify(saved));
        if (session) sendBreaks(path, saved[path] || []);
        render();
      }
    };

    // The step buttons, in the Debug view and in the toolbar while debugging.
    const buttons = () => {
      const p = !!session?.paused;
      const b = (ic, title, run, enabled) => h('button.icon-btn.dbg-btn', { title, 'aria-label': title, disabled: !enabled, on: { click: run } }, icon(ic, 16));
      return [
        p || !session
          ? b('continue', session ? 'Continue (F8)' : 'Start debugging (F6)', () => (session ? resume('continue') : start()), true)
          : b('pause', 'Pause (F8)', () => send('pause'), true),
        b('step-over', 'Step over (F10)', () => resume('over'), p),
        b('step-into', 'Step into (F11)', () => resume('step'), p),
        b('step-out', 'Step out (Shift+F11)', () => resume('out'), p),
      ];
    };
    const controlsRow = () => h('div.dbg-controls', ...buttons());
    const strip = h('div.dbg-strip', { hidden: true });
    const renderControls = () => {
      clear(strip).append(...buttons());
      strip.hidden = !session;
    };
    api.layout.addToolbar(strip, 'right', { first: true });

    api.layout.addView({
      id: 'debug',
      title: 'Debug',
      icon: 'bug',
      order: 30,
      render: (el) => {
        viewEl = el;
        el.classList.add('debug-view');
        render();
      },
    });

    // ---------- commands ----------

    api.commands.register({ id: 'debug.start', title: 'Start debugging (stop at the first line)', key: 'F6', run: start });
    api.commands.register({ id: 'debug.continue', title: 'Continue, or pause', key: 'F8', run: () => (session?.paused ? resume('continue') : session ? send('pause') : start()) });
    api.commands.register({ id: 'debug.over', title: 'Step over', key: 'F10', enabled: can.paused, run: () => resume('over') });
    api.commands.register({ id: 'debug.into', title: 'Step into', key: 'F11', enabled: can.paused, run: () => resume('step') });
    api.commands.register({ id: 'debug.out', title: 'Step out', key: 'Shift+F11', enabled: can.paused, run: () => resume('out') });
    api.commands.register({ id: 'debug.toggle', title: 'Set or remove a breakpoint on this line', key: 'F9', run: toggleHere });
    api.commands.register({ id: 'debug.clear', title: 'Remove all breakpoints', run: clearAll });
    api.commands.register({ id: 'debug.show', title: 'Show the Debug view', run: () => api.layout.showView('debug') });

    api.onDispose(() => {
      clearTimeout(rememberTimer);
      api.editor.view.dispatch({ effects: setHere.of(null) });
    });
    render();
  },
};
