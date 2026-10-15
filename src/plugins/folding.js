// Code structure: fold { } blocks, multi-line tables and calls, and >>> comments
// away with the arrows next to the line numbers, and color brackets by how deep they are.

import { RangeSetBuilder } from '@codemirror/state';
import { EditorView, ViewPlugin, Decoration } from '@codemirror/view';
import {
  foldService, foldGutter, codeFolding, syntaxTree, matchBrackets, foldCode, unfoldCode, foldAll, unfoldAll, foldedRanges, foldEffect,
} from '@codemirror/language';

const OPEN = '([{';
const CLOSE = ')]}';
const BRACKET_NODES = new Set(['paren', 'squareBracket', 'brace']);

export default {
  id: 'folding',
  name: 'Folding and bracket colors',
  description: 'Fold blocks, multi-line tables and >>> comments away with the arrows next to the line numbers, and color brackets by depth so you can see which ones belong together.',
  builtin: true,
  settings: [
    { key: 'fold', title: 'Show fold arrows next to the line numbers', description: 'Ctrl+Shift+[ and Ctrl+Shift+] fold and unfold where the cursor is, even with the arrows hidden.', type: 'boolean', default: true },
    { key: 'arrowsOnHover', title: 'Only show the arrows when the mouse is near them', description: 'Folded spots always show theirs.', type: 'boolean', default: true },
    { key: 'bracketColors', title: 'Color brackets by depth', description: 'Each level of ( ), [ ] and { } gets its own color. A bracket that closes nothing is marked red.', type: 'boolean', default: true },
  ],
  activate(api) {
    const { icon } = api.ui;
    const S = api.settings;

    const build = () => {
      const exts = [foldService.of(foldable), codeFolding({ preparePlaceholder, placeholderDOM })];
      if (S.get('fold')) {
        exts.push(foldGutter({
          markerDOM: (open) => {
            const el = icon(open ? 'chevron-down' : 'chevron', 14);
            el.classList.add('fold-marker', open ? 'open' : 'folded');
            el.title = open ? 'Fold' : 'Unfold';
            return el;
          },
        }));
      }
      if (S.get('bracketColors')) exts.push(bracketColors);
      exts.push(EditorView.editorAttributes.of({ class: S.get('arrowsOnHover') ? 'fold-hover' : '' }));
      return exts;
    };
    let remove = api.editor.addExtension(build());
    const again = () => {
      remove();
      remove = api.editor.addExtension(build());
    };
    for (const k of ['fold', 'arrowsOnHover', 'bracketColors']) S.onChange(k, again);
    api.onDispose(() => remove());

    const run = (fn) => () => {
      const v = api.editor.view;
      if (api.workspace.active) fn(v);
    };
    api.commands.register({ id: 'fold.fold', title: 'Fold the block the cursor is in', key: 'Ctrl+Shift+[', category: 'Edit', run: run(foldInside) });
    api.commands.register({ id: 'fold.unfold', title: 'Unfold at the cursor', key: 'Ctrl+Shift+]', category: 'Edit', run: run(unfoldCode) });
    api.commands.register({ id: 'fold.all', title: 'Fold everything', key: 'Ctrl+Alt+[', category: 'Edit', run: run(foldAll) });
    api.commands.register({ id: 'fold.none', title: 'Unfold everything', key: 'Ctrl+Alt+]', category: 'Edit', run: run(unfoldAll) });
  },
};

/** What can fold on a line: the first bracket that closes on a later line, or a >>> comment. */
export function foldable(state, lineStart, lineEnd) {
  const tree = syntaxTree(state);
  const text = state.sliceDoc(lineStart, lineEnd);
  for (let i = 0; i < text.length; i++) {
    const pos = lineStart + i;
    if (text.startsWith('>>>', i)) {
      const node = tree.resolveInner(pos, 1);
      if (node.name !== 'blockComment') continue;
      const at = state.sliceDoc(pos + 3, pos + 200000).indexOf('<<<');
      const end = at < 0 ? -1 : pos + 3 + at;
      if (end > lineEnd) return { from: pos + 3, to: end };
      i += 2;
      continue;
    }
    if (!OPEN.includes(text[i])) continue;
    if (!BRACKET_NODES.has(tree.resolveInner(pos, 1).name)) continue; // in text or a comment
    const m = matchBrackets(state, pos, 1, { maxScanDistance: 200000 });
    if (m?.matched && m.end && m.end.from > lineEnd) return { from: pos + 1, to: m.end.from };
  }
  return null;
}

/** Folds the innermost block around the cursor (or starting on its line). */
function foldInside(view) {
  if (foldCode(view)) return true;
  const { state } = view;
  const head = state.selection.main.head;
  // Walk up from the cursor's line to the first line whose fold covers it.
  for (let n = state.doc.lineAt(head).number - 1; n >= 1; n--) {
    const line = state.doc.line(n);
    const r = foldable(state, line.from, line.to);
    if (r && r.from <= head && r.to >= head) {
      let exists = false;
      foldedRanges(state).between(r.from, r.to, (a, b) => { if (a === r.from && b === r.to) exists = true; });
      if (!exists) view.dispatch({ effects: foldEffect.of(r) });
      return true;
    }
  }
  return false;
}

function preparePlaceholder(state, range) {
  return state.doc.lineAt(range.to).number - state.doc.lineAt(range.from).number - 1;
}

/** "⋯ 12 lines" in place of the folded code; clicking it unfolds. */
function placeholderDOM(view, onclick, hidden) {
  const el = document.createElement('span');
  el.className = 'cm-foldPlaceholder fold-placeholder';
  el.textContent = hidden > 0 ? `⋯ ${hidden} line${hidden > 1 ? 's' : ''}` : '⋯';
  el.title = 'Unfold';
  el.setAttribute('aria-label', 'folded code');
  el.onclick = onclick;
  return el;
}

// ---------- bracket colors ----------

const marks = [0, 1, 2].map((d) => Decoration.mark({ class: `cm-br${d}` }));
const bad = Decoration.mark({ class: 'cm-br-bad' });

/** The first index in a list sorted by `from` whose `from` is at least `pos`. */
function firstAt(list, pos) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].from < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The brackets in the file with their colors: [{ from, mark, open }], kept up to date
 * from the first changed spot on, so typing near the end of a long file stays quick.
 */
class Brackets {
  constructor() {
    this.list = [];
    this.done = 0; // everything before this is worked out
  }

  /** Forgets what comes at or after `pos` (where the text changed). */
  cut(pos) {
    this.list.length = firstAt(this.list, pos);
    this.done = Math.min(this.done, pos);
  }

  /** Works brackets out from `this.done` up to `to`, as far as the file has been read. */
  extend(state, tree, to) {
    to = Math.min(to, tree.length);
    if (to <= this.done) return;
    const from = this.done;
    // Which brackets are open at `from`, from the ones before it.
    const stack = [];
    for (const e of this.list) {
      if (e.open >= 0) stack.push(e.open);
      else if (e.mark !== bad) stack.pop();
    }
    const out = this.list;
    tree.iterate({
      from,
      to,
      enter(n) {
        if (!BRACKET_NODES.has(n.name)) return;
        // Brackets next to each other, like )), can come as one piece.
        const text = state.sliceDoc(n.from, n.to);
        for (let i = Math.max(0, from - n.from); i < text.length && n.from + i < to; i++) {
          const at = n.from + i;
          const o = OPEN.indexOf(text[i]);
          if (o >= 0) {
            out.push({ from: at, mark: marks[stack.length % 3], open: o });
            stack.push(o);
            continue;
          }
          const c = CLOSE.indexOf(text[i]);
          if (c < 0) continue;
          if (stack.length && stack[stack.length - 1] === c) {
            stack.pop();
            out.push({ from: at, mark: marks[stack.length % 3], open: -1 });
          } else out.push({ from: at, mark: bad, open: -1 });
        }
      },
    });
    this.done = to;
  }
}

const bracketColors = ViewPlugin.fromClass(class {
  constructor(view) {
    this.brackets = new Brackets();
    this.decorations = this.build(view);
  }

  update(u) {
    if (u.docChanged) {
      let first = Infinity;
      u.changes.iterChangedRanges((fromA) => { first = Math.min(first, fromA); });
      this.brackets.cut(first);
    }
    if (u.docChanged || u.viewportChanged || syntaxTree(u.state) !== syntaxTree(u.startState)) this.decorations = this.build(u.view);
  }

  build(view) {
    // Worked out from the top down to a little past what's on screen.
    this.brackets.extend(view.state, syntaxTree(view.state), view.viewport.to + 20000);
    const { list } = this.brackets;
    const b = new RangeSetBuilder();
    for (const { from, to } of view.visibleRanges) {
      for (let i = firstAt(list, from); i < list.length && list[i].from < to; i++) b.add(list[i].from, list[i].from + 1, list[i].mark);
    }
    return b.finish();
  }
}, { decorations: (v) => v.decorations });
