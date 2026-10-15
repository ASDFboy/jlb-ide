// Serves the UI (dist/) in a normal browser, with the IDE's native commands
// done by Node instead of Tauri. Used by the UI tests, and handy for working on
// the UI without rebuilding the app:
//
//   npm run build:web && node scripts/dev-server.mjs [port]
//
// Settings and plugins live in a temporary folder unless JLB_IDE_CONFIG is set.
// The interpreter comes from JLB_PATH (default: src-tauri/interpreters/jlb).

import http from 'node:http';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const port = Number(process.argv[2] || process.env.PORT || 5180);
const root = path.resolve('dist');
const config = process.env.JLB_IDE_CONFIG || fss.mkdtempSync(path.join(os.tmpdir(), 'jlb-ide-config-'));
const exe = (n) => (process.platform === 'win32' ? n + '.exe' : n);
const jlbPath = process.env.JLB_PATH || path.resolve('src-tauri/interpreters', exe('jlb'));
const MARK = '\u001e';

const clients = new Set();
const emit = (event, payload) => {
  const data = `data: ${JSON.stringify({ event, payload })}\n\n`;
  for (const c of clients) c.write(data);
};

const runs = new Map();
let nextRun = 1;
let repl = null;
const dialogQueue = [];
// Backups of unsaved work (see src-tauri/src/backups.rs). Tests start a new
// session with /__test/restart to act like the IDE being opened again.
let backupSession = `s${Date.now()}-${process.pid}`;
const backupRoot = () => path.join(config, 'backups');
const backupDir = () => path.join(backupRoot(), backupSession);
const plainName = (n) => {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(n || '')) throw `"${n}" isn't a valid backup name`;
  return n;
};

const commands = {
  async read_text({ path: p }) {
    return fs.readFile(p, 'utf8');
  },
  async write_text({ path: p, text }) {
    await fs.writeFile(p, text);
  },
  async list_dir({ path: p }) {
    const ents = await fs.readdir(p, { withFileTypes: true });
    return ents.filter((e) => !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: path.join(p, e.name), is_dir: e.isDirectory() }))
      .sort((a, b) => (b.is_dir - a.is_dir) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  },
  async path_info({ path: p }) {
    try {
      const s = await fs.stat(p);
      return { exists: true, is_dir: s.isDirectory(), modified: Math.floor(s.mtimeMs) };
    } catch {
      return { exists: false, is_dir: false, modified: 0 };
    }
  },
  async create_dir({ path: p }) {
    await fs.mkdir(p, { recursive: true });
  },
  async rename_path({ from, to }) {
    if (fss.existsSync(to)) throw `${to} already exists`;
    await fs.rename(from, to);
  },
  async delete_path({ path: p }) {
    await fs.rm(p, { recursive: true, force: true });
  },
  async list_files({ root, limit = 20000 }) {
    const st = await fs.stat(root).catch(() => null);
    if (!st?.isDirectory()) throw `${root} isn't a folder`;
    const files = [];
    let truncated = false;
    const stack = [root];
    walk: while (stack.length) {
      const dir = stack.pop();
      const ents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of ents) {
        if (e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!['node_modules', 'target', '__pycache__'].includes(e.name)) stack.push(p);
        } else if (e.isFile()) {
          if (files.length >= limit) {
            truncated = true;
            break walk;
          }
          const s = await fs.stat(p).catch(() => null);
          files.push({ path: p, size: s?.size || 0, modified: Math.floor(s?.mtimeMs || 0) });
        }
      }
    }
    files.sort((a, b) => (a.path.toLowerCase() < b.path.toLowerCase() ? -1 : a.path.toLowerCase() > b.path.toLowerCase() ? 1 : 0));
    return { files, truncated };
  },
  async read_texts({ paths, max_bytes = 1 << 20 }) {
    return Promise.all(paths.map(async (p) => {
      try {
        const s = await fs.stat(p);
        if (!s.isFile() || s.size > max_bytes) return null;
        const b = await fs.readFile(p);
        if (b.includes(0)) return null;
        const t = new TextDecoder('utf-8', { fatal: true }).decode(b);
        return t;
      } catch {
        return null;
      }
    }));
  },
  async run_program({ interpreter, file, cwd, args }) {
    if (!fss.existsSync(interpreter)) throw `couldn't find the interpreter at ${interpreter} (check Settings → Interpreters)`;
    const id = nextRun++;
    const child = spawn(interpreter, [...args, file], { cwd: cwd || undefined });
    runs.set(id, child);
    let open = 2;
    const done = () => {
      if (--open === 0) child.once('exit', () => {}), setTimeout(() => {}, 0);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text) => emit('run-output', { id, stream: 'out', text }));
    child.stderr.on('data', (text) => emit('run-output', { id, stream: 'err', text }));
    child.stdout.on('end', done);
    child.stderr.on('end', done);
    child.on('close', (code) => {
      runs.delete(id);
      emit('run-exit', { id, code });
    });
    return id;
  },
  async send_input({ id, text }) {
    const c = runs.get(id);
    if (!c) throw "the program isn't running";
    c.stdin.write(text + '\n');
  },
  async stop_program({ id }) {
    runs.get(id)?.kill();
  },
  async run_capture({ interpreter, file, cwd, args, input, timeout_ms }) {
    if (!fss.existsSync(interpreter)) throw `couldn't find the interpreter at ${interpreter} (check Settings → Interpreters)`;
    return new Promise((resolve) => {
      const start = performance.now();
      const c = spawn(interpreter, [...(args || []), file], { cwd: cwd || undefined });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      c.stdout.setEncoding('utf8');
      c.stderr.setEncoding('utf8');
      c.stdout.on('data', (d) => (stdout += d));
      c.stderr.on('data', (d) => (stderr += d));
      const timer = setTimeout(() => {
        timedOut = true;
        c.kill();
      }, timeout_ms);
      c.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code: timedOut ? null : code, ms: performance.now() - start, timed_out: timedOut });
      });
      c.stdin.on('error', () => {});
      c.stdin.end(input || '');
    });
  },
  async check_code({ interpreter, source }) {
    return new Promise((resolve, reject) => {
      const c = spawn(interpreter, ['--check', '-']);
      let out = '';
      c.on('error', (e) => reject(String(e)));
      c.stdout.on('data', (d) => (out += d));
      c.on('close', () => (out.trim().startsWith('{') ? resolve(out.trim()) : reject(`${interpreter} doesn't support --check`)));
      c.stdin.end(source);
    });
  },
  async repl_eval({ interpreter, cwd, code }) {
    if (!repl || repl.interpreter !== interpreter || repl.cwd !== cwd) {
      repl?.child.kill();
      const child = spawn(interpreter, ['--repl'], { cwd: cwd || undefined });
      child.stdout.setEncoding('utf8');
      const session = { child, interpreter, cwd, buf: '', waiting: null };
      repl = session;
      child.stdout.on('data', (d) => {
        session.buf += d;
        const i = session.buf.indexOf(MARK);
        const nl = i >= 0 ? session.buf.indexOf('\n', i) : -1;
        if (nl >= 0 && session.waiting) {
          const output = session.buf.slice(0, i);
          const reply = session.buf.slice(i + 1, nl);
          session.buf = session.buf.slice(nl + 1);
          const w = session.waiting;
          session.waiting = null;
          w.resolve({ output, reply });
        }
      });
      child.on('close', () => {
        session.waiting?.reject('the Quick-try session stopped');
        if (repl === session) repl = null;
      });
    }
    const lines = code.split('\n').filter((l) => l.trim() !== MARK).join('\n');
    return new Promise((resolve, reject) => {
      repl.waiting = { resolve, reject };
      repl.child.stdin.write(lines + '\n' + MARK + '\n');
    });
  },
  async repl_answer({ text }) {
    if (!repl) throw "the Quick-try session isn't running";
    return new Promise((resolve, reject) => {
      repl.waiting = { resolve, reject };
      repl.child.stdin.write(text.replace(/[\r\n]/g, ' ') + '\n');
    });
  },
  async repl_reset() {
    repl?.child.kill();
    repl = null;
  },
  async load_settings() {
    try {
      return await fs.readFile(path.join(config, 'settings.json'), 'utf8');
    } catch {
      return '{}';
    }
  },
  async save_settings({ text }) {
    await fs.writeFile(path.join(config, 'settings.json'), text);
  },
  async plugins_dir() {
    const d = path.join(config, 'plugins');
    await fs.mkdir(d, { recursive: true });
    return d;
  },
  async list_plugins() {
    const d = await commands.plugins_dir();
    const out = [];
    for (const name of (await fs.readdir(d)).sort()) {
      const folder = path.join(d, name);
      if (!(await fs.stat(folder)).isDirectory()) continue;
      let manifest;
      try {
        manifest = await fs.readFile(path.join(folder, 'plugin.json'), 'utf8');
      } catch {
        continue;
      }
      let m = {};
      try { m = JSON.parse(manifest); } catch { /* reported by the IDE */ }
      const read = (n) => fs.readFile(path.join(folder, n), 'utf8').catch(() => null);
      out.push({ folder, manifest, main: await read(m.main || 'main.js'), style: await read(m.style || 'style.css'), error: null });
    }
    return out;
  },
  async plugins_stamp() {
    const d = await commands.plugins_dir();
    const parts = [];
    for (const name of await fs.readdir(d)) {
      const folder = path.join(d, name);
      if (!(await fs.stat(folder)).isDirectory()) continue;
      for (const f of await fs.readdir(folder)) {
        const st = await fs.stat(path.join(folder, f));
        if (st.isFile()) parts.push(`${path.join(folder, f)}|${st.size}|${Math.round(st.mtimeMs)}`);
      }
    }
    return parts.sort().join('\n');
  },
  async install_plugin({ from, replace }) {
    let m;
    try {
      m = JSON.parse(await fs.readFile(path.join(from, 'plugin.json'), 'utf8'));
    } catch {
      throw "that folder has no plugin.json, so it isn't a plugin";
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(m.id || '')) throw `"${m.id}" in plugin.json isn't a valid plugin id (use lowercase letters, digits and dashes)`;
    const dest = path.join(await commands.plugins_dir(), m.id);
    if (fss.existsSync(dest)) {
      if (!replace) throw `already installed: ${m.id}`;
      await fs.rm(dest, { recursive: true });
    }
    await fs.cp(from, dest, { recursive: true, filter: (p) => !/[\\/](\.git|node_modules)$/.test(p) });
    return dest;
  },
  async backup_write({ key, data }) {
    const d = backupDir();
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(d, 'alive'), '');
    await fs.writeFile(path.join(d, plainName(key) + '.tmp'), data);
    await fs.rename(path.join(d, key + '.tmp'), path.join(d, key + '.json'));
  },
  async backup_delete({ key }) {
    const d = backupDir();
    await fs.rm(path.join(d, plainName(key) + '.json'), { force: true });
    const left = fss.existsSync(d) ? (await fs.readdir(d)).filter((f) => f.endsWith('.json')) : [];
    if (!left.length) await fs.rm(d, { recursive: true, force: true });
  },
  async backup_heartbeat() {
    if (fss.existsSync(backupDir())) await fs.writeFile(path.join(backupDir(), 'alive'), '');
  },
  async backup_close({ keep }) {
    if (!fss.existsSync(backupDir())) return;
    if (keep) await fs.writeFile(path.join(backupDir(), 'closed'), '');
    else await fs.rm(backupDir(), { recursive: true, force: true });
  },
  async backup_leftovers() {
    await fs.mkdir(backupRoot(), { recursive: true });
    const out = [];
    for (const name of await fs.readdir(backupRoot())) {
      const d = path.join(backupRoot(), name);
      if (name === backupSession || !(await fs.stat(d)).isDirectory()) continue;
      let stale = true;
      try {
        stale = Date.now() - (await fs.stat(path.join(d, 'alive'))).mtimeMs > 45000;
      } catch { /* no alive file */ }
      if (!stale && !fss.existsSync(path.join(d, 'closed'))) continue;
      const items = [];
      for (const f of await fs.readdir(d)) if (f.endsWith('.json')) items.push(await fs.readFile(path.join(d, f), 'utf8'));
      out.push({ folder: name, items });
    }
    return out;
  },
  async backup_forget({ folder }) {
    if (folder !== backupSession) await fs.rm(path.join(backupRoot(), plainName(folder)), { recursive: true, force: true });
  },
  async find_interpreters() {
    const c = process.env.JLB_C_PATH || path.resolve('src-tauri/interpreters', exe('jlb-c'));
    return { rust: fss.existsSync(jlbPath) ? jlbPath : null, c: c && fss.existsSync(c) ? c : null };
  },
  async app_info() {
    return { version: '0.1.0', os: process.platform, config_dir: config, home: os.homedir() };
  },
  async file_setup_status() {
    return { supported: false, edit_with_ide: false, double_click_runs: false };
  },
  async startup_files() {
    return [];
  },
  async dialog_open() {
    return dialogQueue.shift() ?? null;
  },
  async dialog_save() {
    return dialogQueue.shift() ?? null;
  },
};

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': hi\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/__test/dialog' && req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    dialogQueue.push(...JSON.parse(body).paths);
    res.end('{}');
    return;
  }
  if (url.pathname === '/__test/restart' && req.method === 'POST') {
    backupSession = `s${Date.now()}-${process.pid}`;
    res.end(JSON.stringify({ session: backupSession }));
    return;
  }
  if (url.pathname.startsWith('/__bridge/')) {
    let body = '';
    for await (const c of req) body += c;
    const cmd = commands[url.pathname.slice(10)];
    res.setHeader('content-type', 'application/json');
    if (!cmd) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'unknown command' }));
      return;
    }
    try {
      const result = await cmd(JSON.parse(body || '{}'));
      res.end(JSON.stringify({ result: result ?? null }));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(e?.message || e) }));
    }
    return;
  }
  const file = path.join(root, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
  if (!file.startsWith(root)) {
    res.statusCode = 403;
    res.end();
    return;
  }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`JLB IDE (browser mode) at http://127.0.0.1:${port}  config: ${config}`));
