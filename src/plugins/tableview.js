// The table viewer: shows a .jlb table as a grid, like a spreadsheet. A list of
// tables with the same names (like a list of players) gets a column per name.
// Opened from the debugger, the crash report and Quick-try.

export default {
  id: 'tableview',
  name: 'Table viewer',
  description: 'Shows a table as a grid you can sort, filter and open up, from the debugger, the crash report or Quick-try.',
  builtin: true,
  settings: [
    { key: 'rows', title: 'Rows to show at first', description: 'More appear with "Show more". Fewer rows keep big tables quick.', type: 'number', default: 300, min: 50, max: 5000 },
  ],
  activate(api) {
    const { h, clear, icon, toast } = api.ui;
    let el = null;
    // What's open: the table, then each entry opened inside it.
    let trail = []; // [{ title, node, load? }]
    let filter = '';
    let sort = null; // { col, dir }
    let limit = 0;

    /** Opens a table: { title, node, load?: async () => node (all of it) }. */
    const open = (source) => {
      if (!source?.node) return;
      trail = [source];
      filter = '';
      sort = null;
      limit = api.settings.get('rows');
      api.layout.showPanel('tableview');
      render();
    };

    const here = () => trail[trail.length - 1];

    const drill = (node, label) => {
      if (node.type !== 'TABLE') return;
      trail.push({ title: label, node });
      filter = '';
      sort = null;
      limit = api.settings.get('rows');
      render();
    };

    // ---------- shaping the table ----------

    /** Positional entries are numbered 1, 2, ...; the rest are named. */
    const parts = (node) => {
      const items = node.items || [];
      const list = items.filter((n) => /^\d+$/.test(n.name));
      const named = items.filter((n) => !/^\d+$/.test(n.name));
      return { list, named };
    };

    /** A list where most entries are tables with names gets a column per name. */
    const columnsOf = (list) => {
      const tables = list.filter((n) => n.type === 'TABLE' && n.items?.some((k) => !/^\d+$/.test(k.name)));
      if (list.length < 2 || tables.length < list.length * 0.6) return null;
      const cols = [];
      const seen = new Set();
      for (const t of tables) {
        for (const k of t.items) {
          if (/^\d+$/.test(k.name) || seen.has(k.name)) continue;
          seen.add(k.name);
          cols.push(k.name);
          if (cols.length >= 40) return cols;
        }
      }
      return cols;
    };

    const cellText = (n) => (n ? n.value : '');
    const asNumber = (n) => (n?.type === 'NUMBER' ? Number(n.value) : NaN);
    const compare = (a, b) => {
      const x = asNumber(a);
      const y = asNumber(b);
      if (!Number.isNaN(x) && !Number.isNaN(y)) return x - y;
      if (!a) return b ? 1 : 0;
      if (!b) return -1;
      return cellText(a).localeCompare(cellText(b), undefined, { numeric: true });
    };

    // ---------- the panel ----------

    const render = () => {
      if (!el) return;
      clear(el);
      const src = here();
      if (!src) {
        el.append(h('div.empty-note',
          h('p', 'No table open.'),
          h('p.muted', 'Open one with the grid button next to a table in the Debug view, the crash report or Quick-try.')));
        return;
      }
      const node = src.node;
      const { list, named } = parts(node);
      const cols = columnsOf(list);
      const total = list.length + named.length + (node.more || 0);

      // The path to here, and the tools.
      const crumbs = h('nav.tv-crumbs', { 'aria-label': 'Where in the table' }, trail.map((t, i) => [
        i ? h('span.tv-sep', '›') : null,
        i === trail.length - 1
          ? h('span.tv-crumb.on', t.title)
          : h('button.link.tv-crumb', { on: { click: () => { trail = trail.slice(0, i + 1); filter = ''; sort = null; render(); } } }, t.title),
      ]));
      const search = h('input.input.tv-filter', {
        type: 'search',
        placeholder: 'Filter',
        value: filter,
        spellcheck: false,
        'aria-label': 'Filter the rows',
        on: {
          input: (e) => {
            filter = e.target.value;
            fill();
          },
        },
      });
      const count = h('span.tv-count');
      el.append(h('div.tv-head', crumbs, h('span.spacer'), count, search,
        h('button.icon-btn', { title: 'Copy as CSV (for spreadsheets)', 'aria-label': 'Copy as CSV', on: { click: () => copy(toCsv(node, cols), 'Copied as CSV') } }, icon('copy', 15)),
        h('button.icon-btn', { title: 'Copy as .jlb', 'aria-label': 'Copy as .jlb', on: { click: () => copy(toJlb(node), 'Copied as .jlb') } }, icon('code', 15))));

      if (node.more && !src.loaded) {
        el.append(h('div.tv-note', `Showing ${list.length + named.length} of ${total} entries. `,
          src.load ? h('button.link', { on: { click: () => loadAll(src) } }, 'Load all') : 'The rest can only be loaded while the program is stopped in this function.'));
      }

      const body = h('div.tv-body');
      el.append(body);

      const fill = () => {
        clear(body);
        const q = filter.toLowerCase();
        const match = (cells) => !q || cells.some((c) => c && (c.value.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)));
        // Rows: [label, cells...]
        let rows;
        let headers;
        if (cols) {
          headers = ['#', ...cols];
          rows = list.map((n) => ({ key: n.name, node: n, cells: cols.map((c) => n.items?.find((k) => k.name === c) || null) }));
        } else {
          headers = ['#', 'value', 'type'];
          rows = list.map((n) => ({ key: n.name, node: n, cells: [n], type: true }));
        }
        rows = rows.filter((r) => match([...r.cells, r.node]));
        if (sort) {
          const pick = (r) => (sort.col === 0 ? { type: 'NUMBER', value: r.key } : r.cells[sort.col - 1]);
          rows.sort((a, b) => compare(pick(a), pick(b)) * sort.dir);
        }
        const namedRows = named.filter((n) => match([n]));
        count.textContent = `${list.length} item${list.length === 1 ? '' : 's'}${named.length ? `, ${named.length} name${named.length === 1 ? '' : 's'}` : ''}`;

        if (list.length) {
          const table = h('table.tv-grid');
          table.append(h('thead', h('tr', headers.map((name, i) => h('th', {
            'aria-sort': sort?.col === i ? (sort.dir > 0 ? 'ascending' : 'descending') : null,
          }, h('button.tv-sort', {
            title: `Sort by ${name}`,
            on: {
              click: () => {
                sort = sort?.col === i ? (sort.dir > 0 ? { col: i, dir: -1 } : null) : { col: i, dir: 1 };
                fill();
              },
            },
          }, name, sort?.col === i ? h('span.tv-arrow', sort.dir > 0 ? '▲' : '▼') : null))))));
          const tb = h('tbody');
          for (const r of rows.slice(0, limit)) {
            tb.append(h('tr',
              h('td.tv-key', r.key),
              r.cells.map((c) => cell(c, `${r.key}`)),
              r.type ? h('td.tv-type', r.node.type) : null));
          }
          table.append(tb);
          body.append(table);
          if (rows.length > limit) {
            body.append(h('div.tv-note', `${rows.length - limit} more rows. `, h('button.link', { on: { click: () => { limit += api.settings.get('rows'); fill(); } } }, 'Show more')));
          }
          if (!rows.length) body.append(h('p.view-note', 'No rows match.'));
        }
        if (named.length) {
          body.append(h('h4.tv-sub', list.length ? 'Names' : 'Entries'));
          body.append(h('table.tv-grid.tv-named', h('tbody', namedRows.map((n) => h('tr', h('td.tv-key', n.name), cell(n, n.name), h('td.tv-type', n.type))))));
        }
        if (!list.length && !named.length) body.append(h('p.view-note', 'This table is empty.'));
      };

      /** A cell; a table inside opens when clicked. */
      const cell = (n, label) => {
        if (!n) return h('td.tv-none', '');
        if (n.type === 'TABLE') {
          return h('td.tv-cell', h('button.tv-open', { title: 'Open this table', on: { click: () => drill(n, label === n.name ? n.name : `${label}.${n.name}`) } }, icon('chevron', 11), h('span', n.value)));
        }
        return h(`td.tv-cell.t-${n.type.toLowerCase()}`, { title: n.value.length > 60 ? n.value : null }, n.value);
      };

      fill();
    };

    const loadAll = async (src) => {
      try {
        const node = await src.load();
        if (!node) return toast('The program isn\'t stopped any more, so the rest can\'t be loaded.');
        src.node = node;
        src.loaded = true;
        render();
      } catch (e) {
        toast(String(e?.message || e), { kind: 'error' });
      }
    };

    const copy = (text, note) => navigator.clipboard.writeText(text).then(() => toast(note, { timeout: 1500 }), () => toast('Couldn\'t copy', { kind: 'error' }));

    api.layout.addPanel({
      id: 'tableview',
      title: 'Table',
      order: 35,
      render: (e) => {
        el = e;
        el.classList.add('tableview');
        render();
      },
    });

    // Other features open tables here.
    api.provide('tableview', { open, parse: parseValue });
    api.commands.register({ id: 'tableview.show', title: 'Show the table viewer', run: () => api.layout.showPanel('tableview') });
  },
};

// ---------- reading values ----------

/**
 * Turns a value written the way .jlb writes it inside a table (as in crash
 * reports and Quick-try) into a tree: { name, type, value, items }.
 * Text that isn't a value comes back as TEXT, unchanged.
 */
export function parseValue(text, name = 'value') {
  let i = 0;
  const s = text;
  const ws = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  const fail = () => {
    throw new Error('not a value');
  };
  const quoted = () => {
    const q = s[i++];
    let out = '';
    while (i < s.length && s[i] !== q) {
      if (q === "'" && s[i] === '\\') {
        const c = s[i + 1];
        out += c === 'n' ? '\n' : c === 't' ? '\t' : c;
        i += 2;
      } else out += s[i++];
    }
    if (s[i] !== q) fail();
    i++;
    return out;
  };
  const value = (label) => {
    ws();
    const start = i;
    if (s[i] === '[') {
      i++;
      const items = [];
      let pos = 0;
      ws();
      while (s[i] !== ']') {
        ws();
        // A name: value pair, or a plain value.
        let key = null;
        const save = i;
        const m = /^([a-z_][a-z0-9_]*)\s*:\s/.exec(s.slice(i, i + 200));
        if (m) {
          key = m[1];
          i += m[0].length;
        } else if (s[i] === '"' || s[i] === "'") {
          const k = quoted();
          ws();
          if (s[i] === ':') {
            key = k;
            i++;
          } else i = save;
        }
        items.push(value(key ?? String(++pos)));
        ws();
        if (s[i] === ',') i++;
        else if (s[i] !== ']') fail();
      }
      i++;
      return { name: label, type: 'TABLE', value: summary(s.slice(start, i)), items, more: 0 };
    }
    if (s[i] === '"' || s[i] === "'") {
      quoted();
      return { name: label, type: 'TEXT', value: s.slice(start, i) };
    }
    const m = /^(TRUE|FALSE|NULL|TASK (?:[a-z_][a-z0-9_]*|FUNCTION)|FUNCTION(?: [a-z_][a-z0-9_]*)?|[A-Z_]+|-?[0-9][0-9a-zA-Z.+-]*)/.exec(s.slice(i));
    if (!m) fail();
    i += m[0].length;
    const t = m[0];
    const type = t === 'TRUE' || t === 'FALSE' ? 'BOOL' : t === 'NULL' ? 'NULL' : t.startsWith('TASK ') ? 'TASK' : /^FUNCTION|^[A-Z_]+$/.test(t) ? 'FUNCTION' : 'NUMBER';
    return { name: label, type, value: t };
  };
  try {
    const v = value(name);
    ws();
    if (i !== s.length) fail();
    return v;
  } catch {
    return { name, type: 'TEXT', value: s };
  }
}

const summary = (t) => (t.length > 100 ? t.slice(0, 99) + '…' : t);

/** Writes a value back as .jlb (for copying). Shortened values can't be written back. */
function toJlb(node) {
  if (node.type !== 'TABLE') return node.value;
  const parts = (node.items || []).map((n) => (/^\d+$/.test(n.name) ? toJlb(n) : `${/^[a-z_][a-z0-9_]*$/.test(n.name) ? n.name : JSON.stringify(n.name)}: ${toJlb(n)}`));
  if (node.more) parts.push('...');
  return `[${parts.join(', ')}]`;
}

function toCsv(node, cols) {
  const esc = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const plain = (n) => (!n ? '' : n.type === 'TEXT' ? textOf(n.value) : n.type === 'TABLE' ? toJlb(n) : n.value);
  const list = (node.items || []).filter((n) => /^\d+$/.test(n.name));
  const named = (node.items || []).filter((n) => !/^\d+$/.test(n.name));
  const lines = [];
  if (cols) {
    lines.push(['#', ...cols].map(esc).join(','));
    for (const r of list) lines.push([r.name, ...cols.map((c) => plain(r.items?.find((k) => k.name === c)))].map(esc).join(','));
  } else {
    lines.push('#,value');
    for (const r of list) lines.push([r.name, plain(r)].map(esc).join(','));
  }
  for (const n of named) lines.push([n.name, plain(n)].map(esc).join(','));
  return lines.join('\n') + '\n';
}

/** "Ann" or 'it\'s' as plain text. */
function textOf(v) {
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/\\(.)/g, (m, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
  return v;
}
