// Suggestions while typing: commands, keywords, your own names, and snippets.

import { snippetCompletion } from '@codemirror/autocomplete';
import { StateField } from '@codemirror/state';
import { showTooltip } from '@codemirror/view';
import { scan, showParams } from './scan.js';
import { peek } from './linked.js';
import { basename } from '../core/paths.js';

const SNIPPETS = [
  ['IF', 'IF ${condition} {\n\t${}\n}', 'IF block'],
  ['IF', 'IF ${condition} {\n\t${}\n} ELSE {\n\t\n}', 'IF / ELSE block'],
  ['FOR', 'FOR ${item} IN ${table} {\n\t${}\n}', 'loop over a table or text'],
  ['FOR', 'FOR ${i} IN ${1} TO ${10} {\n\t${}\n}', 'counting loop'],
  ['WHILE', 'WHILE ${condition} {\n\t${}\n}', 'WHILE loop'],
  ['REPEAT', 'REPEAT ${3} {\n\t${}\n}', 'repeat a set number of times'],
  ['DEF', 'DEF ${name}(${inputs}) {\n\t${}\n}', 'function'],
  ['TRY', 'TRY {\n\t${}\n} FAIL ${err} {\n\tPRINT(err.message)\n}', 'catch errors'],
];

export default {
  id: 'complete',
  name: 'Suggestions',
  description: 'Suggests commands (with their inputs), keywords and your own names as you type, plus ready-made blocks like IF and FOR.',
  builtin: true,
  settings: [
    { key: 'snippets', title: 'Suggest ready-made blocks (IF, FOR, DEF, ...)', type: 'boolean', default: true },
    { key: 'names', title: 'Suggest names from the current file', type: 'boolean', default: true },
    { key: 'fields', title: 'Suggest table entries after a dot', description: 'After hero. it suggests the entries hero is given in this file, like hero.hp.', type: 'boolean', default: true },
    { key: 'inputHints', title: 'Show a command\'s inputs while typing them', description: 'Inside PRINT( ... ) or your own functions, shows what goes in each spot, with the current one highlighted.', type: 'boolean', default: true },
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
      const text = ctx.state.doc.toString();
      if (cache.text !== text) cache = { text, info: scan(text) };
      const info = cache.info;
      const options = [];

      // After "hero." come hero's entries (or a function's LOCAL names, like f.secret).
      const dot = before.match(/([a-z_][a-z0-9_]*)\.\s*$/);
      if (dot || /\.\s*$/.test(before)) {
        if (!dot || !api.settings.get('fields')) return null;
        const load = peek(api.workspace.active?.path)?.loads.get(dot[1]);
        const fromLoad = new Set();
        if (load?.names && !info.globals.has(dot[1])) {
          // tool. gives what the LOADed file defines.
          for (const d of load.names.values()) {
            fromLoad.add(d.name);
            options.push(d.kind === 'func'
              ? { label: d.name, type: 'function', detail: `(${showParams(d.params, d.types)})`, info: d.doc ? `${d.doc}\n\nFrom ${basename(d.path)}` : `From ${basename(d.path)}`, boost: 2, apply: callApply(d.name) }
              : { label: d.name, type: d.kind === 'load' ? 'namespace' : 'variable', info: `From ${basename(d.path)}`, boost: 2 });
          }
        }
        for (const name of info.fields.get(dot[1]) || []) if (!fromLoad.has(name)) options.push({ label: name, type: 'property', boost: 1 });
        const fn = info.funcs.find((f) => f.name === dot[1]);
        if (fn) for (const name of fn.locals) options.push({ label: name, type: 'variable', detail: `in ${fn.name}()` });
        return options.length ? { from, options, validFor: /^[a-z0-9_]*$/ } : null;
      }

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
          options.push({ label: f.name, type: 'function', detail: `(${showParams(f.params, f.types)})`, info: f.doc || undefined, boost: 1 });
        }
        const notes = new Map();
        for (const n of info.notes) if (n.ref && !notes.has(n.ref.name)) notes.set(n.ref.name, n.doc);
        for (const name of info.defined) {
          if (seen.has(name) || name === typed) continue;
          seen.add(name);
          options.push({ label: name, type: 'variable', info: notes.get(name), boost: 1 });
        }
        // Names from files brought in with IMPORT (and the files that IMPORT this one).
        const link = peek(api.workspace.active?.path);
        for (const d of link ? [...link.names.values(), ...link.outer.values()] : []) {
          if (seen.has(d.name) || d.name === typed) continue;
          seen.add(d.name);
          options.push(d.kind === 'func'
            ? { label: d.name, type: 'function', detail: `(${showParams(d.params, d.types)})`, info: d.doc ? `${d.doc}\n\nFrom ${basename(d.path)}` : `From ${basename(d.path)}`, boost: 1 }
            : { label: d.name, type: d.kind === 'load' ? 'namespace' : 'variable', info: d.doc ? `${d.doc}\n\nFrom ${basename(d.path)}` : `From ${basename(d.path)}`, boost: 1 });
        }
      }
      return { from, options };
    });

    // ---------- input hints ----------
    const signature = (name, state, owner) => {
      if (owner) {
        const load = peek(api.workspace.active?.path)?.loads.get(owner);
        const d = load?.names?.get(name);
        if (d?.kind === 'func') return { name: `${owner}.${name}`, params: d.params, desc: d.doc || null };
        if (load) return null;
      }
      if (BUILTINS[name]) {
        const [sig, desc] = BUILTINS[name];
        return { name, params: splitParams(sig.slice(sig.indexOf('(') + 1, sig.lastIndexOf(')'))), desc };
      }
      const text = state.doc.toString();
      if (cache.text !== text) cache = { text, info: scan(text) };
      const f = cache.info.funcs.find((x) => x.name === name);
      if (f) return { name, params: f.params, desc: f.doc || null };
      const link = peek(api.workspace.active?.path);
      const d = link?.names.get(name) || link?.outer.get(name);
      return d?.kind === 'func' && !cache.info.globals.has(name) ? { name, params: d.params, desc: d.doc || null } : null;
    };
    const hintField = StateField.define({
      create: () => null,
      update(value, tr) {
        if (!tr.docChanged && !tr.selection) return value;
        if (!api.settings.get('inputHints')) return null;
        // Shown while typing a call, and kept up while moving around inside it; just
        // clicking or jumping into one doesn't cover the lines above with it.
        if (!tr.docChanged && (!value || tr.isUserEvent('select.pointer'))) return null;
        return hintAt(tr.state, signature);
      },
      provide: (f) => showTooltip.from(f),
    });
    api.editor.addExtension(hintField);
  },
};

/** Puts in name() with the cursor between the brackets (or just the name before an existing "("). */
function callApply(name) {
  return (view, completion, f, t) => {
    const next = view.state.sliceDoc(t, t + 1);
    view.dispatch({ changes: { from: f, to: t, insert: next === '(' ? name : name + '()' }, selection: { anchor: f + name.length + 1 } });
  };
}

/** "t, value, [pos]" → ["t", "value", "[pos]"], keeping [ ] groups together. */
function splitParams(inner) {
  const out = [];
  let d = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '[' || ch === '(') d++;
    if (ch === ']' || ch === ')') d--;
    if (ch === ',' && d === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The call the cursor is inside, and which input it's on, as a tooltip. */
function hintAt(state, signature) {
  const sel = state.selection.main;
  if (!sel.empty) return null;
  const pos = sel.head;
  const start = Math.max(0, state.doc.lineAt(pos).from - 2000);
  const text = state.sliceDoc(start, pos);
  let depth = 0;
  let commas = 0;
  let quote = null;
  // Walk back to the "(" this spot is inside, counting commas at that level.
  // Text is skipped by first finding which characters are inside quotes.
  const inText = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      inText[i] = 1;
      if (c === '\\' && quote === "'") { inText[++i] = 1; continue; }
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
      inText[i] = 1;
    } else if (c === '>' && text[i + 1] === '>') {
      // a comment to the end of the line
      const nl = text.indexOf('\n', i);
      const stop = nl < 0 ? text.length : nl;
      for (; i < stop; i++) inText[i] = 1;
    }
  }
  if (quote) return null;
  for (let i = text.length - 1; i >= 0; i--) {
    if (inText[i]) continue;
    const c = text[i];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '[' || c === '{') {
      if (depth === 0) return null; // inside a table or block, not a call
      depth--;
    } else if (c === '(') {
      if (depth > 0) { depth--; continue; }
      const called = text.slice(0, i).match(/(?:(?<![\w.])([a-z_][a-z0-9_]*)\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*$/);
      const name = called?.[2];
      const owner = called?.[1];
      if (!name || /^(IF|ELIF|ELSEIF|WHILE|FOR|REPEAT|RETURN|DEF|FUNC)$/.test(name)) return null;
      if (/\b(DEF|FUNC)(\s+GLOBAL)?\s+$/.test(text.slice(0, i - name.length))) return null; // defining, not calling
      const sig = signature(name, state, owner);
      if (!sig || !sig.params.length) return null;
      return {
        pos: start + called.index,
        above: true,
        strictSide: false,
        create: () => {
          const dom = document.createElement('div');
          dom.className = 'jlb-hint';
          // A "..." input takes everything from there on.
          const rest = sig.params.findIndex((p) => p.includes('...'));
          const at = rest >= 0 && commas >= rest ? rest : commas;
          dom.append(sig.name + '(');
          sig.params.forEach((p, k) => {
            if (k) dom.append(', ');
            const span = document.createElement('span');
            span.textContent = p;
            if (k === at) span.className = 'on';
            dom.append(span);
          });
          dom.append(')');
          if (sig.desc) {
            const d = document.createElement('span');
            d.className = 'desc';
            d.textContent = sig.desc;
            dom.append(d);
          }
          return { dom };
        },
      };
    } else if (c === ',' && depth === 0) commas++;
    else if (c === '\n' && depth === 0 && /\{\s*$/.test(text.slice(0, i))) return null;
  }
  return null;
}
