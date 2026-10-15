// Find in files: search every file in the folder (and the open tabs, with their
// unsaved changes), see each match in its line, and replace them all at once.

import { projectFiles, readAll, applyChanges } from './project.js';
import { basename, dirname } from '../core/paths.js';

export default {
  id: 'search',
  name: 'Find in files',
  description: 'Search every file in the folder (Ctrl+Shift+F) and replace across them, with match case, whole word and pattern (regular expression) options.',
  builtin: true,
  settings: [
    { key: 'maxResults', title: 'Most results to show', description: 'Searching stops after this many matches, to stay quick in big folders.', type: 'number', default: 2000, min: 100, max: 20000 },
    { key: 'live', title: 'Search again as files change', description: 'Keeps the results up to date while you type in the editor.', type: 'boolean', default: true },
    { key: 'caseSensitive', type: 'boolean', default: false, hidden: true },
    { key: 'wholeWord', type: 'boolean', default: false, hidden: true },
    { key: 'regex', type: 'boolean', default: false, hidden: true },
    { key: 'include', type: 'text', default: '', hidden: true },
    { key: 'showReplace', type: 'boolean', default: false, hidden: true },
  ],
  activate(api) {
    const { h, clear, icon, confirm } = api.ui;
    const S = api.settings;
    let el = null;
    let run = 0; // the latest search; older ones stop when a new one starts
    let results = null; // { groups: [{ file, text, matches }], count, cut, truncated, error }
    const collapsed = new Set();
    let timer = null;

    // ---------- the view ----------
    const query = h('input.input.sr-input', { placeholder: 'Search', spellcheck: false, 'aria-label': 'Search' });
    const replace = h('input.input.sr-input', { placeholder: 'Replace', spellcheck: false, 'aria-label': 'Replace with' });
    const include = h('input.input.sr-include', { placeholder: 'Files to include, like *.jlb, lib/', spellcheck: false, 'aria-label': 'Files to include', value: S.get('include') });
    const toggle = (key, label, title) => {
      const b = h('button.sr-opt', { title, 'aria-label': title, 'aria-pressed': String(!!S.get(key)), on: { click: () => { S.set(key, !S.get(key)); b.setAttribute('aria-pressed', String(!!S.get(key))); b.classList.toggle('on', !!S.get(key)); later(0); } } }, label);
      b.classList.toggle('on', !!S.get(key));
      return b;
    };
    const opts = h('div.sr-opts', toggle('caseSensitive', 'Aa', 'Match case'), toggle('wholeWord', 'ab', 'Whole words only'), toggle('regex', '.*', 'Use a pattern (regular expression)'));
    const replaceAll = h('button.btn.small.sr-replace-all', { title: 'Replace all', on: { click: () => doReplace() } }, 'Replace all');
    const replaceRow = h('div.sr-row.sr-replace-row', replace, replaceAll);
    const expand = h('button.icon-btn.sr-expand', { title: 'Show replace', 'aria-label': 'Show replace', on: { click: () => setReplace(!S.get('showReplace')) } }, icon('chevron', 14));
    const summary = h('div.sr-summary', { role: 'status' });
    const list = h('div.sr-results');
    const setReplace = (on) => {
      S.set('showReplace', on);
      replaceRow.hidden = !on;
      expand.classList.toggle('open', on);
      expand.title = on ? 'Hide replace' : 'Show replace';
      render();
    };

    query.addEventListener('input', () => later());
    query.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') later(0);
    });
    replace.addEventListener('input', () => render());
    replace.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doReplace();
    });
    include.addEventListener('input', () => {
      S.set('include', include.value);
      later();
    });

    const later = (ms = 250) => {
      clearTimeout(timer);
      timer = setTimeout(search, ms);
    };

    // ---------- searching ----------
    const search = async () => {
      const id = ++run;
      const q = query.value;
      if (!q) {
        results = null;
        render();
        return;
      }
      const m = matcher(q, { caseSensitive: S.get('caseSensitive'), wholeWord: S.get('wholeWord'), regex: S.get('regex') });
      if (m.error) {
        results = { error: m.error };
        render();
        return;
      }
      summary.textContent = 'Searching…';
      const { files, truncated } = await projectFiles(api);
      if (id !== run) return;
      const wanted = files.filter(includes(include.value));
      const texts = await readAll(api, wanted);
      if (id !== run) return;
      const max = S.get('maxResults');
      const groups = [];
      let count = 0;
      let cut = false;
      for (const f of wanted) {
        const text = texts.get(f);
        if (text == null) continue;
        const matches = findAll(text, m.re, max - count);
        if (!matches.length) continue;
        groups.push({ file: f, text, matches });
        count += matches.length;
        if (count >= max) {
          cut = true;
          break;
        }
      }
      results = { groups, count, cut, truncated, re: m.re };
      render();
    };

    const render = () => {
      if (!el) return;
      clear(list);
      summary.className = 'sr-summary';
      if (!results) {
        summary.textContent = '';
        if (!api.workspace.folder) list.append(h('div.empty-note', h('p', 'Open a folder to search all its files. Open tabs are searched too.')));
        replaceAll.disabled = true;
        return;
      }
      if (results.error) {
        summary.textContent = results.error;
        summary.classList.add('warn');
        replaceAll.disabled = true;
        return;
      }
      const { groups, count, cut, truncated } = results;
      replaceAll.disabled = !count;
      summary.textContent = !count ? 'No results.'
        : `${count.toLocaleString()} result${count > 1 ? 's' : ''} in ${groups.length} file${groups.length > 1 ? 's' : ''}${cut ? ` (the first ${count.toLocaleString()}; the limit is in Settings)` : ''}.`;
      if (truncated) summary.append(h('div.sr-note', 'This folder has a lot of files, so only the first 20,000 were searched.'));
      const showReplace = S.get('showReplace');
      const rep = replace.value;
      for (const g of groups) {
        const key = g.file.path || g.file.name;
        const closed = collapsed.has(key);
        const dir = g.file.path ? dirname(g.file.rel) : '';
        const head = h('div.sr-file',
          h('button.sr-file-btn', {
            'aria-expanded': String(!closed),
            title: g.file.path || g.file.name,
            on: { click: () => { closed ? collapsed.delete(key) : collapsed.add(key); render(); } },
          }, icon(closed ? 'chevron' : 'chevron-down', 14), h('span.sr-name', basename(g.file.rel)), dir && dir !== g.file.rel ? h('span.sr-dir', dir) : null),
          showReplace ? h('button.icon-btn.sr-file-replace', { title: `Replace in ${g.file.name}`, 'aria-label': `Replace in ${g.file.name}`, on: { click: () => doReplace([g]) } }, icon('replace', 14)) : null,
          h('span.sr-count', String(g.matches.length)));
        list.append(head);
        if (closed) continue;
        const lines = g.text.split('\n');
        const ul = h('ul.sr-lines');
        for (const mt of g.matches) {
          const lineText = lines[mt.line - 1];
          // A bit of the line before the match, so it starts close to it.
          let start = Math.max(0, mt.from - 14);
          while (start < mt.from && /\s/.test(lineText[start])) start++;
          const lead = (start > 0 ? '…' : '') + lineText.slice(start, mt.from);
          const found = lineText.slice(mt.from, mt.to);
          const tail = lineText.slice(mt.to, mt.to + 120);
          // With Replace open, each match shows what it would become.
          const with$ = showReplace ? expand$(rep, mt, S.get('regex')) : '';
          const parts = showReplace ? [h('del', found), with$ ? h('ins', with$) : null] : [h('mark', found)];
          ul.append(h('li', h('button.sr-line', {
            title: `Line ${mt.line}`,
            on: { click: () => openAt(g.file, mt) },
          }, h('span.sr-text', lead, ...parts, tail), h('span.sr-ln', String(mt.line)))));
        }
        list.append(ul);
      }
    };

    const openAt = async (file, mt) => {
      const doc = file.doc && api.workspace.files.includes(file.doc) ? file.doc : file.path ? await api.workspace.openFile(file.path) : null;
      if (!doc) return;
      if (api.workspace.active !== doc) api.workspace.activate(doc);
      const view = api.editor.view;
      const d = view.state.doc;
      const line = d.line(Math.min(mt.line, d.lines));
      const from = Math.min(line.from + mt.from, line.to);
      const to = Math.min(line.from + mt.to, line.to);
      view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
      view.focus();
    };

    // ---------- replacing ----------
    const doReplace = async (only) => {
      if (!results?.count) return;
      const groups = only || results.groups;
      const count = groups.reduce((n, g) => n + g.matches.length, 0);
      const closedFiles = groups.filter((g) => !g.file.doc).length;
      if (!only || closedFiles) {
        const ok = await confirm(`Replace ${count.toLocaleString()} match${count > 1 ? 'es' : ''} in ${groups.length} file${groups.length > 1 ? 's' : ''} with “${replace.value}”?`, {
          ok: 'Replace',
          detail: closedFiles
            ? `Open files are changed but not saved. The ${closedFiles} file${closedFiles > 1 ? 's' : ''} that aren't open are saved straight away. You can undo it from the message that appears.`
            : 'The files are changed but not saved, and you can undo it.',
        });
        if (!ok) return;
      }
      const regex = S.get('regex');
      const list = groups.map((g) => {
        const starts = lineStarts(g.text);
        return {
          file: g.file,
          before: g.text,
          changes: g.matches.map((mt) => ({ from: starts[mt.line - 1] + mt.from, to: starts[mt.line - 1] + mt.to, insert: expand$(replace.value, mt, regex) })),
        };
      });
      const r = await applyChanges(api, list, { message: `Replaced ${count.toLocaleString()} match${count > 1 ? 'es' : ''} in ${groups.length} file${groups.length > 1 ? 's' : ''}.` });
      if (r.done.length) later(0);
    };

    // ---------- keeping up to date ----------
    const refresh = () => {
      if (query.value && api.settings.get('live') && el?.isConnected) later(500);
    };
    api.events.on('editor-change', refresh);
    api.events.on('doc-change', refresh);
    api.events.on('file-save', refresh);
    api.events.on('folder-change', () => {
      if (query.value) later(0);
      else render();
    });
    api.onDispose(() => clearTimeout(timer));

    api.layout.addView({
      id: 'search',
      title: 'Search',
      icon: 'search',
      order: 15,
      actions: [
        { icon: 'refresh', title: 'Search again', run: () => later(0) },
        { icon: 'list', title: 'Fold or unfold all files', run: () => {
          const groups = results?.groups || [];
          const all = groups.every((g) => collapsed.has(g.file.path || g.file.name));
          for (const g of groups) all ? collapsed.delete(g.file.path || g.file.name) : collapsed.add(g.file.path || g.file.name);
          render();
        } },
      ],
      render: (e) => {
        el = e;
        el.classList.add('search-view');
        el.append(h('div.sr-form',
          h('div.sr-row', expand, h('div.sr-box', query, opts)),
          replaceRow,
          h('div.sr-row.sr-include-row', include)), summary, list);
        replaceRow.hidden = !S.get('showReplace');
        expand.classList.toggle('open', !!S.get('showReplace'));
        render();
      },
      onShow: () => {
        if (query.value) later(0);
      },
    });

    /** Opens the Search view with the selected text (if it's on one line) in the search box. */
    const show = (withReplace) => {
      api.layout.showView('search');
      const sel = api.workspace.active ? api.editor.selection() : '';
      if (sel && !sel.includes('\n')) {
        query.value = sel;
        later(0);
      }
      if (withReplace) setReplace(true);
      setTimeout(() => {
        (withReplace && query.value ? replace : query).focus();
        (withReplace && query.value ? replace : query).select();
      });
    };
    api.commands.register({ id: 'search.show', title: 'Find in files', key: 'Ctrl+Shift+F', run: () => show(false) });
    api.commands.register({ id: 'search.replace', title: 'Replace in files', key: 'Ctrl+Shift+H', run: () => show(true) });
    api.provide('search', {
      /** Searches all files for text, as if typed in the Search view. */
      find: (text, opts = {}) => {
        for (const k of ['caseSensitive', 'wholeWord', 'regex']) if (k in opts) S.set(k, !!opts[k]);
        api.layout.showView('search');
        query.value = text;
        later(0);
      },
    });
  },
};

/** A search pattern from the box: { re } (global), or { error } for a broken pattern. */
export function matcher(q, { caseSensitive, wholeWord, regex }) {
  let src = regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (wholeWord) src = `(?<![A-Za-z0-9_])(?:${src})(?![A-Za-z0-9_])`;
  try {
    return { re: new RegExp(src, caseSensitive ? 'g' : 'gi') };
  } catch (e) {
    return { error: `That pattern doesn't work: ${String(e.message).replace(/^Invalid regular expression: /, '')}` };
  }
}

/** Every match, line by line: [{ line, from, to, groups }] with from/to counted in the line. */
export function findAll(text, re, max = Infinity) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const line = lines[i];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line)) && out.length < max) {
      if (m[0] === '') {
        // An empty match finds nothing to show; move on.
        re.lastIndex++;
        if (re.lastIndex > line.length) break;
        continue;
      }
      out.push({ line: i + 1, from: m.index, to: m.index + m[0].length, groups: [...m], named: m.groups });
    }
  }
  return out;
}

/** The replacement text for one match; with a pattern, $1, $& and $<name> are filled in. */
export function expand$(template, mt, regex) {
  if (!regex) return template;
  return template.replace(/\$(\$|&|\d{1,2}|<([^>]*)>)/g, (all, what, name) => {
    if (what === '$') return '$';
    if (what === '&') return mt.groups[0];
    if (name !== undefined) return mt.named?.[name] ?? '';
    const n = Number(what);
    if (n < mt.groups.length) return mt.groups[n] ?? '';
    // $12 with only one group means $1 then "2".
    if (what.length === 2 && Number(what[0]) < mt.groups.length) return (mt.groups[Number(what[0])] ?? '') + what[1];
    return all;
  });
}

/** Turns "*.jlb, lib/" into a test for a file: which files to search. */
export function includes(spec) {
  const pats = String(spec || '').split(',').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean);
  if (!pats.length) return () => true;
  const tests = pats.map((p) => {
    if (p.endsWith('/')) return (rel) => rel.startsWith(p) || rel.includes('/' + p);
    const re = new RegExp('^' + p.split(/(\*\*\/|\*\*|\*|\?)/).map((part) => (
      part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('') + '$', 'i');
    // A pattern without a / is about the file name, wherever the file is.
    return p.includes('/') ? (rel) => re.test(rel) : (rel) => re.test(rel.split('/').pop());
  });
  return (f) => {
    const rel = String(f.rel).replace(/\\/g, '/');
    return tests.some((t) => t(rel));
  };
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}
