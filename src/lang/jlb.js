// The .jlb language for CodeMirror: highlighting, indentation and comment toggling.

import { StreamLanguage, LanguageSupport, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { KEYWORDS, BUILTIN_NAMES } from './data.js';

const KW = new Set(KEYWORDS);
const COMMANDS = new Set([...BUILTIN_NAMES, 'INSERT', 'DROP', 'UNDEFINE']);

// Longest first, so "!===" wins over "!==", like the interpreter's lexer.
const OPS = [
  '!===', '===', '!==', '!&&', '!||', '...', '!^=', '!%=', '<==', '>==', '==', '!=', '<=', '>=',
  '&&', '||', '!&', '!|', '!~', '!^', '!%', '^=', '%=', '+=', '-=', '*=', '/=', '@=', '=', '<',
  '>', '&', '|', '~', '^', '%', '+', '-', '*', '/', '@', '!',
];
const LOGIC = new Set(['&', '&&', '!&', '!&&', '|', '||', '!|', '!||', '~', '!~', '!']);
const COMPARE = new Set(['==', '===', '!==', '!===', '<', '>', '<=', '>=', '<==', '>==']);
const ASSIGN = new Set(['=', '@=', '+=', '-=', '*=', '/=', '^=', '!^=', '%=', '!%=']);

function opKind(op) {
  if (op === '!=') return 'invalid';
  if (LOGIC.has(op)) return 'logicOperator';
  if (COMPARE.has(op)) return 'compareOperator';
  if (ASSIGN.has(op)) return 'definitionOperator';
  if (op === '@' || op === '...') return 'modifier';
  return 'arithmeticOperator';
}

function stringBody(stream, state) {
  const q = state.inString;
  while (!stream.eol()) {
    if (q === "'" && stream.peek() === '\\') {
      if (stream.pos > stream.start) return 'string';
      stream.next();
      // Only these backslash codes exist; anything else is an error in .jlb.
      const e = stream.next();
      return e && "'\"nt\\".includes(e) ? 'escape' : 'invalid';
    }
    if (stream.next() === q) {
      state.inString = null;
      return 'string';
    }
  }
  return 'string';
}

export const jlbStream = {
  name: 'jlb',
  startState: () => ({ inString: null, inBlock: false, depth: 0, prev: null }),
  copyState: (s) => ({ ...s }),
  token(stream, state) {
    if (state.inBlock) {
      if (stream.skipTo('<<<')) {
        stream.pos += 3;
        state.inBlock = false;
      } else stream.skipToEnd();
      return 'blockComment';
    }
    if (state.inString) return stringBody(stream, state);
    if (stream.eatSpace()) return null;

    if (stream.match('>>>')) {
      state.inBlock = true;
      return 'blockComment';
    }
    if (stream.match('>>')) {
      stream.skipToEnd();
      return 'lineComment';
    }
    const ch = stream.peek();
    if (ch === '"' || ch === "'") {
      stream.next();
      state.inString = ch;
      state.prev = 'value';
      return stringBody(stream, state);
    }
    if (/[0-9]/.test(ch)) {
      state.prev = 'value';
      if (stream.match(/^0[xX][0-9a-fA-F]+/)) return 'number';
      if (stream.match(/^0[0-9]/)) {
        stream.match(/^[0-9]*/);
        return 'invalid'; // numbers can't start with 0, like 025
      }
      stream.match(/^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/);
      if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) return 'invalid'; // names can't start with a digit
      return 'number';
    }
    const word = stream.match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (word) {
      const w = word[0];
      const prev = state.prev;
      state.prev = 'value';
      const upper = /[A-Z]/.test(w);
      const lower = /[a-z]/.test(w);
      if (upper && !lower) {
        if (w === 'TRUE' || w === 'FALSE') return 'bool';
        if (w === 'NULL') return 'null';
        state.prev = w;
        if (KW.has(w)) return 'keyword';
        if (COMMANDS.has(w)) return 'variableName.standard';
        return 'invalid';
      }
      if (upper) return 'invalid'; // mixed case: names are lowercase, commands ALL CAPS
      if (prev === 'FUNC') return 'variableName.function.definition';
      if (prev === 'POINT' || prev === 'GOTO') return 'labelName';
      if (prev === '.') return 'propertyName';
      if (prev === 'LOCAL' || prev === 'FOR' || prev === 'FAIL') return 'variableName.definition';
      if (stream.match(/^\s*\(/, false)) return 'variableName.function';
      return 'variableName';
    }
    for (const op of OPS) {
      if (stream.match(op)) {
        state.prev = op === '@' || op === '...' ? state.prev : 'op';
        return opKind(op);
      }
    }
    stream.next();
    if ('([{'.includes(ch)) {
      state.depth++;
      state.prev = 'open';
      return ch === '(' ? 'paren' : ch === '[' ? 'squareBracket' : 'brace';
    }
    if (')]}'.includes(ch)) {
      state.depth = Math.max(0, state.depth - 1);
      state.prev = 'value';
      return ch === ')' ? 'paren' : ch === ']' ? 'squareBracket' : 'brace';
    }
    if (ch === '.') {
      state.prev = '.';
      return 'derefOperator';
    }
    if (ch === ',' || ch === ':' || ch === ';') {
      state.prev = 'sep';
      return 'separator';
    }
    return 'invalid';
  },
  indent(state, textAfter, cx) {
    if (state.inString || state.inBlock) return null;
    const closing = /^\s*[)\]}]/.test(textAfter) ? 1 : 0;
    return Math.max(0, state.depth - closing) * cx.unit;
  },
  languageData: {
    commentTokens: { line: '>>', block: { open: '>>>', close: '<<<' } },
    closeBrackets: { brackets: ['(', '[', '{', '"', "'"] },
    indentOnInput: /^\s*[)\]}]$/,
  },
};

export const jlbLanguage = StreamLanguage.define(jlbStream);

export function jlb() {
  return new LanguageSupport(jlbLanguage);
}

/** Colors for code. They read CSS variables, so themes (and plugins) can restyle them. */
export const jlbStyle = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--syn-keyword)', fontWeight: '600' },
  { tag: t.standard(t.variableName), color: 'var(--syn-command)' },
  { tag: [t.bool, t.null], color: 'var(--syn-constant)', fontWeight: '600' },
  { tag: t.number, color: 'var(--syn-number)' },
  { tag: t.string, color: 'var(--syn-string)' },
  { tag: t.escape, color: 'var(--syn-escape)', fontWeight: '600' },
  { tag: [t.lineComment, t.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.logicOperator, t.compareOperator], color: 'var(--syn-logic)' },
  { tag: [t.arithmeticOperator, t.definitionOperator, t.derefOperator], color: 'var(--syn-operator)' },
  { tag: t.modifier, color: 'var(--syn-share)', fontWeight: '600' },
  { tag: t.function(t.definition(t.variableName)), color: 'var(--syn-func)', fontWeight: '600' },
  { tag: t.function(t.variableName), color: 'var(--syn-func)' },
  { tag: t.definition(t.variableName), color: 'var(--syn-def)' },
  { tag: t.labelName, color: 'var(--syn-label)', fontWeight: '600' },
  { tag: t.propertyName, color: 'var(--syn-property)' },
  { tag: [t.paren, t.squareBracket, t.brace, t.separator], color: 'var(--syn-punct)' },
  { tag: t.invalid, color: 'var(--syn-invalid)', textDecoration: 'underline wavy' },
]);

export const jlbHighlight = syntaxHighlighting(jlbStyle);
