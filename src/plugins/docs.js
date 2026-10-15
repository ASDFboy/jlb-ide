// The language guide: the .jlb reference, inside the IDE. Code samples are
// colored like the editor, and any sample can be opened as a new file.

import { marked } from 'marked';
import { highlightTree } from '@lezer/highlight';
import { jlbLanguage, jlbStyle } from '../lang/jlb.js';
import index from '../docs/README.md';
import p01 from '../docs/01-getting-started.md';
import p02 from '../docs/02-syntax.md';
import p03 from '../docs/03-values-and-types.md';
import p04 from '../docs/04-operators.md';
import p05 from '../docs/05-control-flow.md';
import p06 from '../docs/06-functions.md';
import p07 from '../docs/07-tables-and-text.md';
import p08 from '../docs/08-errors.md';
import p09 from '../docs/09-programs-and-files.md';
import p10 from '../docs/10-built-ins.md';

const PAGES = {
  'README.md': index, '01-getting-started.md': p01, '02-syntax.md': p02, '03-values-and-types.md': p03,
  '04-operators.md': p04, '05-control-flow.md': p05, '06-functions.md': p06, '07-tables-and-text.md': p07,
  '08-errors.md': p08, '09-programs-and-files.md': p09, '10-built-ins.md': p10,
};

/** Short names other features use with docs.show(). */
const ALIASES = {
  operators: ['04-operators.md'],
  logic: ['04-operators.md', 'logic'],
  comparisons: ['04-operators.md', 'comparisons'],
  'built-ins': ['10-built-ins.md'],
  'control-flow': ['05-control-flow.md'],
  numbers: ['03-values-and-types.md', 'numbers-are-exact'],
  tables: ['07-tables-and-text.md'],
  errors: ['08-errors.md'],
};

const slug = (s) => s.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\w\- ]/g, '').trim().replace(/ /g, '-');
const titleOf = (md) => (md.match(/^# (.+)$/m)?.[1] || '').replace(/^\d+\.\s*/, '');

marked.use({
  renderer: {
    heading({ tokens, depth, text }) {
      return `<h${depth} id="${slug(text.replace(/`/g, ''))}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
    },
  },
});

function colorCode(code) {
  const out = document.createElement('code');
  const tree = jlbLanguage.parser.parse(code);
  let pos = 0;
  highlightTree(tree, jlbStyle, (from, to, classes) => {
    if (from > pos) out.append(code.slice(pos, from));
    const span = document.createElement('span');
    span.className = classes;
    span.textContent = code.slice(from, to);
    out.append(span);
    pos = to;
  });
  if (pos < code.length) out.append(code.slice(pos));
  return out;
}

export default {
  id: 'docs',
  name: 'Language guide',
  description: 'The complete .jlb reference in the sidebar, searchable, with a button to open any example as a new file.',
  builtin: true,
  activate(api) {
    const { h, clear, toast } = api.ui;
    let el = null;
    let body = null;
    let list = null;
    let search = null;
    let page = 'README.md';

    const show = (name = 'README.md', anchor) => {
      if (ALIASES[name]) [name, anchor = anchor] = [ALIASES[name][0], ALIASES[name][1] ?? anchor];
      if (!PAGES[name]) return;
      page = name;
      api.layout.showView('docs');
      if (search) search.value = '';
      renderPage(anchor);
    };

    const renderPage = (anchor) => {
      if (!body) return;
      list.hidden = true;
      body.hidden = false;
      body.innerHTML = marked.parse(PAGES[page]);
      for (const pre of body.querySelectorAll('pre')) {
        const code = pre.textContent.replace(/\n$/, '');
        pre.replaceChildren(colorCode(code));
        pre.before(h('div.code-tools',
          h('button.link', { on: { click: () => api.workspace.newFile(code + '\n') } }, 'Open as a new file'),
          h('button.link', { on: { click: () => navigator.clipboard.writeText(code).then(() => toast('Copied', { timeout: 1200 })) } }, 'Copy')));
      }
      if (page !== 'README.md') body.prepend(h('button.link.docs-back', { on: { click: () => show('README.md') } }, '‹ All topics'));
      const target = anchor && body.querySelector('#' + CSS.escape(anchor));
      if (target) target.scrollIntoView({ block: 'start' });
      else el.scrollTop = 0;
    };

    const runSearch = () => {
      const q = search.value.trim().toLowerCase();
      if (!q) return renderPage();
      body.hidden = true;
      list.hidden = false;
      clear(list);
      const hits = [];
      for (const [name, md] of Object.entries(PAGES)) {
        let heading = titleOf(md);
        let anchor = null;
        for (const line of md.split('\n')) {
          const hm = line.match(/^#{2,4} (.+)/);
          if (hm) {
            heading = hm[1].replace(/`/g, '');
            anchor = slug(heading);
          }
          if (line.toLowerCase().includes(q) && !line.startsWith('# ')) {
            hits.push({ name, anchor, heading, text: line.replace(/[`*|#>]/g, ' ').replace(/\s+/g, ' ').trim() });
            if (hits.length > 60) break;
          }
        }
      }
      if (!hits.length) list.append(h('p.view-note', 'Nothing in the guide matches that.'));
      for (const hit of hits.slice(0, 60)) {
        list.append(h('button.doc-hit', { on: { click: () => show(hit.name, hit.anchor) } },
          h('span.doc-hit-title', `${titleOf(PAGES[hit.name])}: ${hit.heading}`),
          h('span.doc-hit-text', hit.text.length > 120 ? hit.text.slice(0, 117) + '…' : hit.text)));
      }
    };

    api.layout.addView({
      id: 'docs',
      title: 'Language guide',
      icon: 'book',
      order: 30,
      render: (e) => {
        el = e;
        el.classList.add('docs-view');
        search = h('input.input.docs-search', { type: 'search', placeholder: 'Search the guide', spellcheck: false, 'aria-label': 'Search the guide' });
        search.addEventListener('input', runSearch);
        list = h('div.doc-hits');
        body = h('article.doc');
        body.addEventListener('click', (ev) => {
          const a = ev.target.closest('a');
          if (!a) return;
          ev.preventDefault();
          const href = a.getAttribute('href') || '';
          if (/^https?:/.test(href)) {
            navigator.clipboard.writeText(href).then(() => toast(`Link copied: ${href}`));
            return;
          }
          const [file, anchor] = href.split('#');
          if (!file) {
            body.querySelector('#' + CSS.escape(anchor))?.scrollIntoView({ block: 'start' });
          } else show(file, anchor);
        });
        el.append(search, list, body);
        renderPage();
      },
    });
    api.provide('docs', { show });
    api.commands.register({ id: 'docs.show', title: 'Open the language guide', key: 'Ctrl+F1', run: (name, anchor) => show(typeof name === 'string' ? name : undefined, anchor) });
  },
};
