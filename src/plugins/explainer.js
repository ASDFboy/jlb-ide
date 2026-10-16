// Quirk explainer: rest the mouse on an operator, command or keyword for a
// plain-English explanation, focused on what's different in .jlb.

import { scan } from './scan.js';
import { peek, describe } from './linked.js';
import { basename } from '../core/paths.js';

const DOC_FOR_OP = (op) => (/^[&|~!]/.test(op) && !op.startsWith('!=') && !op.startsWith('!^') && !op.startsWith('!%') ? 'logic' : /[<>=]/.test(op) ? 'comparisons' : 'operators');

export default {
  id: 'explainer',
  name: 'Quirk explainer',
  description: 'Rest the mouse on an operator, command or keyword to see what it does in .jlb, like how & differs from &&.',
  builtin: true,
  settings: [
    { key: 'operators', title: 'Explain operators', type: 'boolean', default: true },
    { key: 'commands', title: 'Explain built-in commands', type: 'boolean', default: true },
    { key: 'keywords', title: 'Explain keywords (IF, FOR, LOCAL, ...)', type: 'boolean', default: true },
    { key: 'functions', title: 'Show the inputs of your own functions', type: 'boolean', default: true },
    { key: 'numbers', title: 'Show what hex and scientific numbers equal', type: 'boolean', default: true },
  ],
  activate(api) {
    const { OPERATORS, BUILTINS, KEYWORD_HELP } = api.jlb;
    const more = (page, anchor) => {
      const docs = api.use('docs');
      return docs ? { label: 'Read more in the language guide', run: () => docs.show(page, anchor) } : undefined;
    };
    let cache = { text: null, info: null };
    const info = (state) => {
      const text = state.doc.toString();
      if (cache.text !== text) cache = { text, info: scan(text) };
      return cache.info;
    };

    api.language.addHover(({ state, word, op, line, pos }) => {
      const before = line.text.slice(0, pos - line.from);
      const inComment = /(^|[^>])>>/.test(stripStrings(before));
      if (op && api.settings.get('operators')) {
        if (op.text === '>>' || op.text === '>>>') {
          if (!/^\s*$|[^>]$/.test(line.text.slice(0, op.from - line.from))) return null;
        } else if (inComment) return null;
        const o = OPERATORS[op.text];
        if (o) return { title: op.text, subtitle: o[0], body: o[1], range: op, more: more(DOC_FOR_OP(op.text)) };
      }
      if (!word || inComment || insideString(before)) return null;
      const w = word.text;
      if (/^[A-Z_]+$/.test(w)) {
        if (BUILTINS[w] && api.settings.get('commands')) return { title: BUILTINS[w][0], body: BUILTINS[w][1], more: more('built-ins') };
        if (KEYWORD_HELP[w] && api.settings.get('keywords')) return { title: w, body: KEYWORD_HELP[w], more: more('control-flow') };
        return null;
      }
      if (/^\d/.test(w) && api.settings.get('numbers')) {
        const full = line.text.slice(word.from - line.from).match(/^(0[xX][0-9a-fA-F]+|\d+(\.\d+)?[eE][+-]?\d+)/);
        if (!full) return null;
        const v = full[0].startsWith('0') && /x/i.test(full[0]) ? BigInt(full[0]).toString() : expand(full[0]);
        return { title: `${full[0]} is ${v}`, code: true };
      }
      if (/^[a-z_][a-z0-9_]*$/.test(w) && api.settings.get('functions')) {
        const own = info(state);
        const link = peek(api.workspace.active?.path);
        const owner = line.text.slice(0, word.from - line.from).match(/(?<![\w.])([a-z_][a-z0-9_]*)\s*\.\s*$/)?.[1];
        if (owner) {
          // tool.name, for a table made by LOAD.
          const d = link?.loads.get(owner)?.names?.get(w);
          return d?.kind === 'func' ? funcHover(w, d.params, `From ${describe(d)}`, d.doc) : null;
        }
        const f = own.funcs.find((x) => x.name === w);
        if (f) return funcHover(w, f.params, `Defined on line ${f.line}`, f.doc);
        if (own.globals.has(w)) return null;
        const d = link?.names.get(w) || link?.outer.get(w);
        if (d?.kind === 'func') return funcHover(w, d.params, `From ${describe(d)}`, d.doc);
        const load = link?.loads.get(w);
        if (load && (own.loads.has(w) || d?.kind === 'load')) {
          const names = load.names ? [...load.names.values()] : null;
          const fns = names?.filter((n) => n.kind === 'func').map((n) => n.name) || [];
          return {
            title: w,
            subtitle: `The table LOAD makes from ${basename(load.path)}`,
            body: !names ? 'That file can\'t be found.'
              : names.length ? `It holds that file's outside names as they were when it loaded${fns.length ? `, including ${list(fns.map((n) => `${w}.${n}()`))}` : ''}.`
                : 'That file gives no outside names.',
          };
        }
      }
      return null;
    });
  },
};

/** A function's hover: the comment at the top of its body, or else how its inputs work. */
function funcHover(name, params, subtitle, doc) {
  const shared = params.filter((p) => p.startsWith('@'));
  return {
    title: `DEF ${name}(${params.join(', ')})`,
    subtitle,
    body: doc || (shared.length ? `${shared.map((p) => p.slice(1)).join(' and ')} ${shared.length > 1 ? 'are' : 'is'} shared (@), so changes inside the function change what you pass in. Other inputs are copies.` : 'Inputs are copies, so the function can\'t change what you pass in (mark an input with @ to share it).'),
  };
}

/** "a, b and 3 more" */
function list(items, max = 4) {
  if (items.length > max) return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0];
}

function stripStrings(s) {
  return s.replace(/"[^"]*"|'(?:\\.|[^'\\])*'/g, '""');
}

function insideString(before) {
  const s = stripStrings(before);
  return /["']/.test(s.replace(/""/g, ''));
}

/** Writes 1.5e3 as 1500 and 2e-3 as 0.002, exactly. */
function expand(sci) {
  const [m, e] = sci.toLowerCase().split('e');
  const exp = Number(e);
  let [ip, fp = ''] = m.split('.');
  let digits = ip + fp;
  let point = ip.length + exp;
  if (point <= 0) return '0.' + '0'.repeat(-point) + digits.replace(/0+$/, '');
  if (point >= digits.length) return (digits + '0'.repeat(point - digits.length)).replace(/^0+(?=\d)/, '');
  return (digits.slice(0, point).replace(/^0+(?=\d)/, '') + '.' + digits.slice(point)).replace(/\.?0+$/, '');
}
