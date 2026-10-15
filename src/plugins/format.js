// The formatter: tidies the spacing and indentation of .jlb code without ever
// changing what it does. Lines stay as they are (statements end at line ends in
// .jlb); only the spaces between pieces, the indentation and runs of blank lines
// change. Text in quotes and comments are left exactly as written.

import { StringStream } from '@codemirror/language';
import { jlbStream } from '../lang/jlb.js';

export default {
  id: 'format',
  name: 'Formatter',
  description: 'Tidies spacing and indentation (Alt+Shift+F), the same way every time, without changing what the code does.',
  builtin: true,
  settings: [
    { key: 'onSave', title: 'Format files when saving', type: 'boolean', default: false },
    { key: 'blankLines', title: 'Most blank lines in a row', description: 'Longer runs of empty lines are shortened to this.', type: 'number', default: 2, min: 1, max: 10 },
  ],
  activate(api) {
    const { toast } = api.ui;
    const options = () => ({ indent: api.settings.get('editor.tabSize') || 4, blankLines: api.settings.get('blankLines') });
    const isJlb = (doc) => !doc.path || /\.jlb$/i.test(doc.path);

    const run = () => {
      const doc = api.workspace.active;
      if (!doc) return;
      if (!isJlb(doc)) return toast('Only .jlb files can be formatted.');
      const view = api.editor.view;
      const sel = view.state.selection.main;
      const text = view.state.doc.toString();
      // With a selection, just its lines.
      const lines = sel.empty ? null : [view.state.doc.lineAt(sel.from).number, view.state.doc.lineAt(sel.to).number];
      const out = format(text, { ...options(), lines });
      if (out === text) return toast('Already tidy.', { timeout: 1500 });
      api.workspace.edit(doc, diff(text, out));
    };
    api.commands.register({ id: 'format.document', title: 'Format the file (or the selected lines)', key: 'Alt+Shift+F', category: 'Edit', run });
    api.workspace.addSaveStep((text, doc) => (api.settings.get('onSave') && isJlb(doc) ? format(text, options()) : text));
  },
};

/** The smallest set of line changes that turns `a` into `b` (both split the same way). */
export function diff(a, b) {
  const al = a.split('\n');
  const bl = b.split('\n');
  const changes = [];
  if (al.length !== bl.length) {
    // Blank lines were dropped: one change from the first difference to the last.
    let s = 0;
    while (s < a.length && s < b.length && a[s] === b[s]) s++;
    let e = 0;
    while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
    return [{ from: s, to: a.length - e, insert: b.slice(s, b.length - e) }];
  }
  let at = 0;
  for (let i = 0; i < al.length; i++) {
    if (al[i] !== bl[i]) changes.push({ from: at, to: at + al[i].length, insert: bl[i] });
    at += al[i].length + 1;
  }
  return changes;
}

/**
 * Each line's pieces: { tokens: [{ text, type, glued, gap }], startsIn: 'string' | 'comment' | null,
 * raw }. `glued` pieces are part of the text in quotes before them; `gap` is the space
 * written before a piece.
 */
export function tokenize(text) {
  const state = jlbStream.startState();
  return text.split('\n').map((raw) => {
    const startsIn = state.inString ? 'string' : state.inBlock ? 'comment' : null;
    const tokens = [];
    const stream = new StringStream(raw, 4, 4);
    let lastEnd = 0;
    while (!stream.eol()) {
      stream.start = stream.pos;
      const glued = !!state.inString || state.inBlock;
      const type = jlbStream.token(stream, state);
      if (stream.pos === stream.start) stream.next(); // never stick
      const piece = raw.slice(stream.start, stream.pos);
      if (type === null && /^\s+$/.test(piece)) continue;
      tokens.push({ text: piece, type: type || '', glued, gap: raw.slice(lastEnd, stream.start) });
      lastEnd = stream.pos;
    }
    return { tokens, startsIn, raw };
  });
}

const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);
const isValue = (t) => /^(number|string|bool|null|variableName|propertyName|labelName)/.test(t.type) || t.text === ')' || t.text === ']' || t.text === '}';
const isName = (t) => /^(variableName|propertyName)/.test(t.type);
const isOp = (t) => /Operator$/.test(t.type) && t.type !== 'derefOperator';

/** Whether to put a space between two pieces on a line (a comes right before b). */
function spaced(a, b, beforeA) {
  if (b.glued) return b.gap.length > 0 ? null : false; // inside text: as written
  if (a.type === 'invalid' || b.type === 'invalid') return null; // not sure what it is: as written
  if (b.type === 'lineComment' || b.type === 'blockComment') return true;
  const x = a.text;
  const y = b.text;
  if (y === ',' || y === ';' || y === ':') return false;
  if (x === ',' || x === ';' || x === ':') return true;
  if (x === '.' || y === '.') return false;
  if (x === '(' || x === '[') return false;
  if (y === ')' || y === ']') return false;
  if (x === '{') return y !== '}' || b.gap.length > 0; // {} or { } as written
  if (y === '}') return true;
  if (x === '}') return true;
  if (y === '{') return true;
  if (a.type === 'modifier') return false; // @hero, ...rest
  // Unary: -x and !x after something that isn't a value.
  if (isOp(a) && (x === '-' || x === '+' || x === '!') && !(beforeA && isValue(beforeA))) return false;
  if (y === '(') return !(isName(a) || x === 'FUNC' || x === ')' || x === ']' || a.type === 'variableName.standard');
  if (y === '[') return !(isName(a) || x === ')' || x === ']' || a.type === 'string');
  if (isOp(a) || isOp(b)) return true;
  if (b.type === 'modifier') return true;
  return b.gap.length > 0;
}

/** The code with tidy spacing and indentation. `lines` limits it to [first, last] (1-based). */
export function format(text, { indent = 4, blankLines = 2, lines: only = null } = {}) {
  const lines = tokenize(text);
  const unit = ' '.repeat(indent);
  // Open brackets, with the line each was opened on. Brackets opened on the same
  // line add one level together, so PRINT(run(FUNC() { indents its body once.
  const stack = [];
  let continues = false; // the line before ended with an operator, so this one carries on
  const out = [];
  let blanks = 0;
  lines.forEach((ln, i) => {
    const inRange = !only || (i + 1 >= only[0] && i + 1 <= only[1]);
    let result;
    if (ln.startsIn) result = ln.raw; // inside text or a >>> comment: exactly as written
    else if (!ln.tokens.length) result = '';
    else {
      // Closing brackets at the start come out at the level of what they close.
      let lead = 0;
      while (lead < ln.tokens.length && CLOSE.has(ln.tokens[lead].text) && !ln.tokens[lead].glued) lead++;
      const open = stack.slice(0, Math.max(0, stack.length - lead));
      const level = new Set(open).size + (continues && !lead ? 1 : 0);
      let s = unit.repeat(level) + ln.tokens[0].text;
      for (let k = 1; k < ln.tokens.length; k++) {
        const t = ln.tokens[k];
        const sp = spaced(ln.tokens[k - 1], t, ln.tokens[k - 2]);
        // A comment after code keeps its own spacing (they're often lined up).
        if (t.type === 'lineComment' || (t.type === 'blockComment' && !t.glued)) s += t.gap.length ? t.gap : ' ';
        else s += sp === null ? t.gap : sp ? ' ' : '';
        s += t.text;
      }
      result = s.replace(/\s+$/, '');
      // Safety: the pieces must come out exactly the same.
      if (!same(ln.tokens, result)) result = unit.repeat(level) + ln.raw.trim();
      if (!same(ln.tokens, result)) result = ln.raw;
    }
    let last = null;
    for (const t of ln.tokens) {
      if (t.glued || t.type === 'lineComment' || t.type === 'blockComment') continue;
      last = t;
      if (t.type === 'string') continue;
      if (OPEN.has(t.text)) stack.push(i);
      else if (CLOSE.has(t.text)) stack.pop();
    }
    // A blank line leaves it as it was.
    if (last) continues = isOp(last);
    if (!inRange) {
      out.push(ln.raw);
      blanks = ln.raw.trim() ? 0 : blanks + 1;
      return;
    }
    if (result === '' && !ln.startsIn) {
      blanks++;
      // Not at the very start, and not too many in a row.
      if (blanks > blankLines || (!only && out.every((l) => l === ''))) return;
    } else blanks = 0;
    out.push(result);
  });
  if (!only) {
    while (out.length && out[out.length - 1] === '') out.pop();
    return out.length ? out.join('\n') + '\n' : '';
  }
  return out.join('\n');
}

/** True when a formatted line has exactly the same pieces as the original. */
function same(tokens, line) {
  const again = tokenize(line)[0].tokens;
  if (again.length !== tokens.length) return false;
  for (let i = 0; i < tokens.length; i++) if (again[i].text !== tokens[i].text) return false;
  return true;
}
