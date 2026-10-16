// The code editor (CodeMirror 6). One view is shared by every tab; each open file
// keeps its own editor state (text, undo history, cursor), swapped in on switch.

import { EditorState, Compartment } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection,
  dropCursor, rectangularSelection, crosshairCursor, highlightActiveLine,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { indentOnInput, bracketMatching, indentUnit } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { lintKeymap } from '@codemirror/lint';
import { jlb, jlbHighlight } from '../lang/jlb.js';

const SETTINGS = [
  { key: 'editor.fontSize', title: 'Font size', type: 'number', default: 14, min: 8, max: 40, section: 'Editor' },
  { key: 'editor.fontFamily', title: 'Font', description: 'Any font installed on this computer. JetBrains Mono comes with the IDE.', type: 'text', default: 'JetBrains Mono', section: 'Editor' },
  { key: 'editor.ligatures', title: 'Font ligatures', description: 'Joins symbols like != into one shape. Off by default, so .jlb operators such as !== and <== stay easy to read.', type: 'boolean', default: false, section: 'Editor' },
  { key: 'editor.lineHeight', title: 'Line height', type: 'number', default: 1.55, min: 1, max: 3, section: 'Editor' },
  { key: 'editor.tabSize', title: 'Indent size', description: 'Spaces per indent level.', type: 'number', default: 4, min: 1, max: 8, section: 'Editor' },
  { key: 'editor.wordWrap', title: 'Wrap long lines', type: 'boolean', default: false, section: 'Editor' },
  { key: 'editor.lineNumbers', title: 'Line numbers', type: 'boolean', default: true, section: 'Editor' },
  { key: 'editor.activeLine', title: 'Highlight the current line', type: 'boolean', default: true, section: 'Editor' },
  { key: 'editor.matchBrackets', title: 'Highlight matching brackets', type: 'boolean', default: true, section: 'Editor' },
  { key: 'editor.closeBrackets', title: 'Close brackets and quotes automatically', type: 'boolean', default: true, section: 'Editor' },
  { key: 'editor.selectionMatches', title: 'Highlight other copies of the selected word', type: 'boolean', default: true, section: 'Editor' },
];

/** Editor colors, using the CSS variables from styles.css (so they follow the theme). */
const baseTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--bg)', color: 'var(--text)' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--faint)', border: 'none' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--select) !important' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--sky)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--tint-sky)', outline: '1px solid var(--tint-sky-line)' },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'var(--tint-rose)' },
  '.cm-tooltip': { backgroundColor: 'var(--raised)', border: '1px solid var(--line)', color: 'var(--text)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--hover)', color: 'var(--text)' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text)' },
  '.cm-searchMatch': { backgroundColor: 'var(--tint-yellow-strong)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--amber)', color: 'var(--amber-ink)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--tint-yellow)' },
  '.cm-diagnosticAction': { backgroundColor: 'var(--sky)', color: 'var(--bg)', borderRadius: '5px', padding: '2px 8px', fontWeight: '700' },
  '.cm-diagnosticSource': { color: 'var(--faint)', opacity: '1' },
});

export class Editor {
  constructor(ide, parent) {
    this.ide = ide;
    for (const s of SETTINGS) ide.settings.define(s);
    this.parts = {};
    for (const k of ['look', 'tab', 'wrap', 'numbers', 'active', 'brackets', 'close', 'matches', 'plugins', 'readOnly']) {
      this.parts[k] = new Compartment();
    }
    this.pluginExtensions = [];
    this.view = new EditorView({ parent, state: this.createState('') });
    ide.settings.onChange('editor.', () => this.refreshConfig());
  }

  config() {
    const s = (k) => this.ide.settings.get(k);
    const font = `"${String(s('editor.fontFamily')).replace(/"/g, '')}", "JetBrains Mono", monospace`;
    return {
      look: EditorView.theme({
        '&': { fontSize: s('editor.fontSize') + 'px' },
        '.cm-content, .cm-gutters, .cm-tooltip.cm-completionInfo, .cm-completionLabel': { fontFamily: font },
        '.cm-content': { lineHeight: String(s('editor.lineHeight')), fontVariantLigatures: s('editor.ligatures') ? 'normal' : 'none' },
      }),
      tab: [EditorState.tabSize.of(s('editor.tabSize')), indentUnit.of(' '.repeat(s('editor.tabSize')))],
      wrap: s('editor.wordWrap') ? EditorView.lineWrapping : [],
      numbers: s('editor.lineNumbers') ? [lineNumbers(), highlightActiveLineGutter()] : [],
      active: s('editor.activeLine') ? highlightActiveLine() : [],
      brackets: s('editor.matchBrackets') ? bracketMatching() : [],
      close: s('editor.closeBrackets') ? [closeBrackets(), keymap.of(closeBracketsKeymap)] : [],
      matches: s('editor.selectionMatches') ? highlightSelectionMatches() : [],
      plugins: this.pluginExtensions.map((p) => p.ext),
      readOnly: [],
    };
  }

  createState(text) {
    const c = this.config();
    return EditorState.create({
      doc: text,
      extensions: [
        Object.entries(this.parts).map(([k, part]) => part.of(c[k])),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        rectangularSelection(),
        crosshairCursor(),
        jlb(),
        jlbHighlight,
        baseTheme,
        keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, ...lintKeymap, indentWithTab]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) this.ide.events.emit('editor-change', u);
          if (u.selectionSet || u.docChanged) this.ide.events.emit('editor-cursor', u.state);
        }),
      ],
    });
  }

  /** Applies the current settings and plugin extensions to the editor. */
  refreshConfig() {
    const c = this.config();
    this.view.dispatch({ effects: Object.entries(this.parts).map(([k, part]) => part.reconfigure(c[k])) });
  }

  /** Adds a CodeMirror extension (from a plugin). Gives back a function that removes it. */
  addExtension(ext) {
    const entry = { ext };
    this.pluginExtensions.push(entry);
    this.refreshConfig();
    return () => {
      this.pluginExtensions = this.pluginExtensions.filter((e) => e !== entry);
      this.refreshConfig();
    };
  }

  get text() {
    return this.view.state.doc.toString();
  }

  /** Moves the cursor to a line (and column), scrolls there and focuses the editor. */
  goTo(line, col = 1, { select = false } = {}) {
    const doc = this.view.state.doc;
    const l = doc.line(Math.max(1, Math.min(line, doc.lines)));
    const from = Math.min(l.from + Math.max(0, col - 1), l.to);
    this.view.dispatch({
      selection: select ? { anchor: l.from, head: l.to } : { anchor: from },
      effects: EditorView.scrollIntoView(from, { y: 'center' }),
    });
    this.view.focus();
  }

  focus() {
    this.view.focus();
  }
}
