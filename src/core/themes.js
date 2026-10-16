// Color themes, and the colors anyone can change. Night and Day are written out in
// styles.css; the others are worked out here from a handful of main colors, so each
// one sets every color the IDE uses. Changed colors (Settings → Colors) are kept per
// theme under the setting "colors.<theme>" as { "--bg": "#101010", ... }.

/** Every color, by section, with what it's used for. */
export const COLOR_GROUPS = [
  ['Interface', [
    ['--bg', 'Background (editor and main area)'],
    ['--panel', 'Panels and sidebar'],
    ['--chrome', 'Title bar, tabs and status bar'],
    ['--raised', 'Menus, inputs and cards'],
    ['--hover', 'Under the mouse'],
    ['--line', 'Borders and dividers'],
    ['--text', 'Text'],
    ['--muted', 'Quieter text'],
    ['--faint', 'Faint text and hints'],
    ['--sky', 'Accent: focus, links and buttons'],
    ['--accent-ink', 'Text on accent buttons'],
    ['--run', 'Run button'],
    ['--run-ink', 'Text on the Run button'],
    ['--run-glow', 'Glow around the Run button'],
    ['--amber', 'Yellow highlights'],
    ['--amber-ink', 'Text on yellow'],
    ['--rose', 'Errors'],
    ['--orange', 'Warnings'],
    ['--mint', 'Success'],
    ['--select', 'Selected text'],
    ['--active-line', 'The line the cursor is on'],
    ['--tint-sky', 'Accent shading (current item, debugger line)'],
    ['--tint-sky-line', 'Accent shading edge'],
    ['--tint-yellow', 'Yellow shading (search matches, changed values)'],
    ['--tint-yellow-strong', 'Strong yellow shading'],
    ['--tint-rose', 'Error shading'],
    ['--shadow-color', 'Shadows under menus and dialogs'],
    ['--backdrop', 'Behind dialogs'],
  ]],
  ['Code', [
    ['--syn-keyword', 'Keywords (IF, FOR, DEF)'],
    ['--syn-command', 'Built-in commands (PRINT, LEN)'],
    ['--syn-func', 'Function names'],
    ['--syn-def', 'Names being made (LOCAL x, FOR x)'],
    ['--syn-property', 'Table entries (hero.hp)'],
    ['--syn-string', 'Text in quotes'],
    ['--syn-escape', 'Backslash codes (\\n)'],
    ['--syn-number', 'Numbers'],
    ['--syn-constant', 'TRUE, FALSE and NULL'],
    ['--syn-comment', 'Comments'],
    ['--syn-operator', 'Math and assignment operators'],
    ['--syn-logic', 'Logic and comparison operators'],
    ['--syn-share', 'Sharing (@) and ...'],
    ['--syn-label', 'POINT and GOTO names'],
    ['--syn-punct', 'Brackets, commas and colons'],
    ['--syn-invalid', 'Mistakes'],
    ['--bracket-1', 'Brackets, level 1'],
    ['--bracket-2', 'Brackets, level 2'],
    ['--bracket-3', 'Brackets, level 3'],
  ]],
];

export const COLOR_VARS = COLOR_GROUPS.flatMap(([, list]) => list.map(([v]) => v));

// The main colors of each theme. Roles that aren't set follow from the others:
// keyword → pink, command → cyan, string → yellow, accent → cyan, error → red.
const PALETTES = {
  dracula: ['Dracula', true, { bg: '#282a36', panel: '#21222c', chrome: '#191a21', raised: '#343746', hover: '#44475a', line: '#3a3c4e', text: '#f8f8f2', muted: '#c5c8d9', faint: '#8b8fa8', comment: '#6272a4', yellow: '#f1fa8c', green: '#50fa7b', cyan: '#8be9fd', blue: '#bd93f9', pink: '#ff79c6', red: '#ff5555', orange: '#ffb86c', purple: '#bd93f9' }],
  onedark: ['One Dark', true, { bg: '#282c34', panel: '#21252b', chrome: '#1b1f24', raised: '#2c313a', hover: '#3a3f4b', line: '#3b4048', text: '#abb2bf', muted: '#9da5b4', faint: '#7f848e', comment: '#5c6370', yellow: '#e5c07b', green: '#98c379', cyan: '#56b6c2', blue: '#61afef', pink: '#c678dd', red: '#e06c75', orange: '#d19a66', purple: '#c678dd', accent: '#61afef', command: '#61afef', string: '#98c379', func: '#61afef' }],
  nord: ['Nord', true, { bg: '#2e3440', panel: '#2b303b', chrome: '#242933', raised: '#3b4252', hover: '#434c5e', line: '#3b4252', text: '#eceff4', muted: '#d8dee9', faint: '#8f9bb3', comment: '#616e88', yellow: '#ebcb8b', green: '#a3be8c', cyan: '#88c0d0', blue: '#81a1c1', pink: '#81a1c1', red: '#bf616a', orange: '#d08770', purple: '#b48ead', string: '#a3be8c', func: '#88c0d0' }],
  gruvbox: ['Gruvbox Dark', true, { bg: '#282828', panel: '#232323', chrome: '#1d2021', raised: '#32302f', hover: '#3c3836', line: '#3c3836', text: '#ebdbb2', muted: '#d5c4a1', faint: '#a89984', comment: '#928374', yellow: '#fabd2f', green: '#b8bb26', cyan: '#8ec07c', blue: '#83a598', pink: '#fb4934', red: '#fb4934', orange: '#fe8019', purple: '#d3869b', accent: '#83a598', string: '#b8bb26', func: '#fabd2f' }],
  solarized: ['Solarized Dark', true, { bg: '#002b36', panel: '#00252f', chrome: '#001f27', raised: '#073642', hover: '#0a4352', line: '#0e4554', text: '#c5ccc6', muted: '#93a1a1', faint: '#839496', comment: '#657b83', yellow: '#b58900', green: '#859900', cyan: '#2aa198', blue: '#268bd2', pink: '#d33682', red: '#dc322f', orange: '#cb4b16', purple: '#6c71c4', accent: '#268bd2', keyword: '#859900', string: '#2aa198', func: '#268bd2' }],
  contrast: ['High Contrast', true, { bg: '#000000', panel: '#0a0a0a', chrome: '#000000', raised: '#161616', hover: '#2a2a2a', line: '#767676', text: '#ffffff', muted: '#e6e6e6', faint: '#c4c4c4', comment: '#b4b4b4', yellow: '#ffeb3b', green: '#7cfc00', cyan: '#00e5ff', blue: '#7ab8ff', pink: '#ff6ad5', red: '#ff6b6b', orange: '#ffa94d', purple: '#d4a4ff' }],
  solarlight: ['Solarized Light', false, { bg: '#fdf6e3', panel: '#f5efdc', chrome: '#eee8d5', raised: '#fffbef', hover: '#e9e2cc', line: '#ddd6c1', text: '#3f5359', muted: '#586e75', faint: '#7b8b8e', comment: '#93a1a1', yellow: '#9c7600', green: '#6f8000', cyan: '#1f8a82', blue: '#268bd2', pink: '#d33682', red: '#dc322f', orange: '#cb4b16', purple: '#6c71c4', accent: '#268bd2', keyword: '#859900', string: '#1f8a82', func: '#268bd2', run: '#859900' }],
  github: ['GitHub Light', false, { bg: '#ffffff', panel: '#f6f8fa', chrome: '#eff2f5', raised: '#ffffff', hover: '#eaeef2', line: '#d0d7de', text: '#1f2328', muted: '#59636e', faint: '#6e7781', comment: '#6e7781', yellow: '#9a6700', green: '#1a7f37', cyan: '#0550ae', blue: '#0969da', pink: '#cf222e', red: '#cf222e', orange: '#953800', purple: '#8250df', accent: '#0969da', string: '#0a3069', func: '#8250df', run: '#2da44e' }],
};

/** id → { label, dark }: Night and Day first, then the rest. */
export const THEMES = {
  night: { label: 'Monokai Night', dark: true },
  day: { label: 'Monokai Day', dark: false },
  ...Object.fromEntries(Object.entries(PALETTES).map(([id, [label, dark]]) => [id, { label, dark }])),
};

const cache = new Map();

/** Every color of a theme, or null for Night and Day (they come from styles.css). */
export function themeColors(id) {
  if (!PALETTES[id]) return null;
  if (!cache.has(id)) cache.set(id, derive(...PALETTES[id].slice(1)));
  return cache.get(id);
}

function derive(dark, c) {
  const a = (hex, alpha) => {
    const [r, g, b] = rgbOf(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };
  const accent = c.accent || c.cyan;
  const run = c.run || c.green;
  const keyword = c.keyword || c.pink;
  const ink = (on) => (contrast(on, c.text) >= contrast(on, c.bg) ? c.text : c.bg);
  const t = dark ? [0.16, 0.5, 0.16, 0.28, 0.14] : [0.12, 0.45, 0.2, 0.34, 0.1];
  return {
    '--bg': c.bg, '--panel': c.panel, '--chrome': c.chrome, '--raised': c.raised, '--hover': c.hover, '--line': c.line,
    '--text': c.text, '--muted': c.muted, '--faint': c.faint,
    '--sky': accent, '--accent-ink': ink(accent), '--run': run, '--run-ink': ink(run), '--run-glow': a(run, 0.18),
    '--amber': c.yellow, '--amber-ink': ink(c.yellow), '--rose': c.red, '--orange': c.orange, '--mint': c.green,
    '--select': a(accent, dark ? 0.2 : 0.15), '--active-line': dark ? a(c.hover, 0.55) : a(c.text, 0.04),
    '--tint-sky': a(accent, t[0]), '--tint-sky-line': a(accent, t[1]), '--tint-yellow': a(c.yellow, t[2]),
    '--tint-yellow-strong': a(c.yellow, t[3]), '--tint-rose': a(c.red, t[4]),
    '--shadow-color': dark ? 'rgba(0, 0, 0, 0.5)' : a(c.text, 0.18), '--backdrop': dark ? 'rgba(0, 0, 0, 0.5)' : a(c.text, 0.22),
    '--syn-keyword': keyword, '--syn-command': c.command || c.cyan, '--syn-func': c.func || c.green, '--syn-def': c.orange,
    '--syn-property': c.text, '--syn-string': c.string || c.yellow, '--syn-escape': c.purple, '--syn-number': c.purple,
    '--syn-constant': c.purple, '--syn-comment': c.comment, '--syn-operator': keyword, '--syn-logic': c.orange,
    '--syn-share': c.cyan, '--syn-label': c.green, '--syn-punct': c.muted, '--syn-invalid': c.red,
    '--bracket-1': c.purple, '--bracket-2': c.blue, '--bracket-3': c.yellow,
  };
}

/** [r, g, b, alpha] from #rgb, #rrggbb, #rrggbbaa or rgb()/rgba(); null if it's none of those. */
export function parseColor(s) {
  s = String(s || '').trim();
  let m = s.match(/^#([0-9a-f]{3,8})$/i);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? Math.round((n(6) / 255) * 100) / 100 : 1];
  }
  m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
  return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null;
}

const rgbOf = (s) => parseColor(s) || [0, 0, 0, 1];

/** #rrggbb for a color input. */
export function toHex(s) {
  const [r, g, b] = rgbOf(s);
  return '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join('');
}

/** `hex` with the see-through amount of `like` (so picking a color keeps it). */
export function withAlphaOf(hex, like) {
  const alpha = rgbOf(like)[3];
  if (alpha >= 1) return hex;
  const [r, g, b] = rgbOf(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function luminance(s) {
  const [r, g, b] = rgbOf(s).map((x) => {
    const v = x / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(x, y) {
  const [a, b] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (a + 0.05) / (b + 0.05);
}
