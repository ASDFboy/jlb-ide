// Path helpers that work with both Windows (C:\a\b) and Unix (/a/b) paths.

export const sep = (p) => (p && p.includes('\\') ? '\\' : '/');

export function basename(p) {
  return String(p).split(/[\\/]/).filter(Boolean).pop() || p;
}

export function dirname(p) {
  const s = String(p);
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (i <= 0) return s.slice(0, i + 1) || s;
  // Keep "C:\" whole.
  if (i === 2 && s[1] === ':') return s.slice(0, 3);
  return s.slice(0, i);
}

export function join(dir, name) {
  const s = sep(dir);
  return dir.endsWith('/') || dir.endsWith('\\') ? dir + name : dir + s + name;
}

/** The path relative to a folder, or the whole path if it's outside it. */
export function relative(folder, p) {
  if (folder && p.startsWith(folder)) {
    const rest = p.slice(folder.length).replace(/^[\\/]/, '');
    return rest || basename(p);
  }
  return p;
}

/**
 * The same path written plainly: "." and ".." steps worked out ("C:\\a\\.\\lib\\..\\b.jlb" is
 * "C:\\a\\b.jlb"), repeated separators joined, and no separator at the end.
 */
export function normalize(p) {
  if (!p) return p;
  const s = sep(p);
  const unc = /^[\\/]{2}[^\\/]/.test(p); // \\server\share
  const root = unc ? s + s : /^[a-z]:[\\/]/i.test(p) ? p.slice(0, 3) : /^[\\/]/.test(p) ? s : '';
  const out = [];
  for (const part of p.slice(root.length).split(/[\\/]+/)) {
    if (!part || part === '.') continue;
    if (part === '..' && out.length && out.at(-1) !== '..') out.pop();
    else if (part !== '..' || !root) out.push(part);
  }
  return root + out.join(s);
}

export function same(a, b) {
  if (!a || !b) return false;
  const norm = (x) => normalize(x).replace(/\\/g, '/');
  // Windows paths aren't case-sensitive.
  return /^[a-z]:/i.test(a) ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}
