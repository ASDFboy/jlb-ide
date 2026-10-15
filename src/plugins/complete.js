// Suggestions while typing: commands, keywords, your own names, and snippets.

import { snippetCompletion } from '@codemirror/autocomplete';
import { scan } from './scan.js';

const SNIPPETS = [
  ['IF', 'IF ${condition} {\n\t${}\n}', 'IF block'],
  ['IF', 'IF ${condition} {\n\t${}\n} ELSE {\n\t\n}', 'IF / ELSE block'],
  ['FOR', 'FOR ${item} IN ${table} {\n\t${}\n}', 'loop over a table or text'],
  ['FOR', 'FOR ${i} IN ${1} TO ${10} {\n\t${}\n}', 'counting loop'],
  ['WHILE', 'WHILE ${condition} {\n\t${}\n}', 'WHILE loop'],
  ['REPEAT', 'REPEAT ${3} {\n\t${}\n}', 'repeat a set number of times'],
  ['FUNC', 'FUNC ${name}(${inputs}) {\n\t${}\n}', 'function'],
  ['TRY', 'TRY {\n\t${}\n} FAIL ${err} {\n\tPRINT(err.message)\n}', 'catch errors'],
];

export default {
  id: 'complete',
  name: 'Suggestions',
  description: 'Suggests commands (with their inputs), keywords and your own names as you type, plus ready-made blocks like IF and FOR.',
  builtin: true,
  settings: [
    { key: 'snippets', title: 'Suggest ready-made blocks (IF, FOR, FUNC, ...)', type: 'boolean', default: true },
    { key: 'names', title: 'Suggest names from the current file', type: 'boolean', default: true },
  ],
  activate(api) {
    const { BUILTINS, KEYWORDS, KEYWORD_HELP, CONSTANTS } = api.jlb;
    let cache = { text: null, info: null };

    api.language.addCompletions((ctx) => {
      const word = ctx.matchBefore(/[A-Za-z_][A-Za-z0-9_]*/);
      if (!word && !ctx.explicit) return null;
      const from = word ? word.from : ctx.pos;
      const typed = word ? word.text : '';
      const line = ctx.state.doc.lineAt(ctx.pos);
      const before = line.text.slice(0, from - line.from);
      // Not inside comments or text.
      if (/(^|[^>])>>/.test(before.replace(/"[^"]*"|'(?:\\.|[^'\\])*'/g, '')) || /["'][^"']*$/.test(before.replace(/"[^"]*"|'(?:\\.|[^'\\])*'/g, ''))) return null;
      if (/\.\s*$/.test(before)) return null; // after "t." comes a table entry name, which can be anything

      const text = ctx.state.doc.toString();
      if (cache.text !== text) cache = { text, info: scan(text) };
      const info = cache.info;
      const options = [];

      // After GOTO, only POINT names make sense.
      if (/\bGOTO\s+$/.test(before)) {
        for (const [name, p] of info.points) options.push({ label: name, type: 'label', detail: `POINT on line ${p.line}` });
        return { from, options };
      }
      const caps = /^[A-Z_]/.test(typed);
      if (caps || !typed) {
        for (const [name, [sig, desc]] of Object.entries(BUILTINS)) {
          options.push({
            label: name,
            type: 'function',
            detail: sig.slice(name.length),
            info: desc,
            apply: (view, completion, f, t) => {
              const next = view.state.sliceDoc(t, t + 1);
              const insert = next === '(' ? name : name + '()';
              view.dispatch({ changes: { from: f, to: t, insert }, selection: { anchor: f + name.length + 1 } });
            },
          });
        }
        for (const k of KEYWORDS) options.push({ label: k, type: 'keyword', info: KEYWORD_HELP[k], boost: -1 });
        for (const c of CONSTANTS) options.push({ label: c, type: 'constant', info: KEYWORD_HELP[c] });
        if (api.settings.get('snippets')) {
          for (const [label, body, detail] of SNIPPETS) options.push(snippetCompletion(body, { label, detail, type: 'text', boost: -2 }));
        }
      }
      if ((!caps || !typed) && api.settings.get('names')) {
        const seen = new Set();
        for (const f of info.funcs) {
          if (!f.name || seen.has(f.name)) continue;
          seen.add(f.name);
          options.push({ label: f.name, type: 'function', detail: `(${f.params.join(', ')})`, boost: 1 });
        }
        for (const name of info.defined) {
          if (seen.has(name) || name === typed) continue;
          seen.add(name);
          options.push({ label: name, type: 'variable', boost: 1 });
        }
      }
      return { from, options };
    });
  },
};
