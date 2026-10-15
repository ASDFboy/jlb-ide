// Running programs: the Run/Stop controls, choosing the interpreter, and the
// Output panel (which also takes typed input for INPUT).

import { h, clear, icon, toast } from './ui.js';
import { invoke, listen, pickOpen } from './backend.js';
import { showKey } from './commands.js';

const MARK = '\u001e';
const MAX_OUTPUT = 400_000; // characters kept in the Output panel
const MAX_LINES = 5000; // and lines

export class Runner {
  constructor(ide) {
    this.ide = ide;
    this.interpreters = new Map();
    this.outLen = 0; // characters in the Output panel
    this.outQueue = ''; // program output waiting to be shown
    this.found = { rust: null, c: null };
    this.run_ = null; // { id, doc, start, stderrLine }
    // Output can arrive before run_program has answered; it waits here until then.
    this.early = [];
    const s = ide.settings;
    s.define({ key: 'run.interpreter', title: 'Run with', description: 'Which interpreter runs your programs. You can also switch in the toolbar.', type: 'select', default: 'rust', options: [], section: 'Running' });
    s.define({ key: 'run.saveFirst', title: 'Save before running', type: 'boolean', default: true, section: 'Running' });
    s.define({ key: 'run.clearOutput', title: 'Clear the output when a program starts', type: 'boolean', default: true, section: 'Running' });
    s.define({ key: 'run.showOutput', title: 'Show the Output panel when a program starts', type: 'boolean', default: true, section: 'Running' });
    s.define({ key: 'run.focusInput', title: 'Put the cursor in the input box while a program runs', description: 'So you can answer INPUT right away.', type: 'boolean', default: true, section: 'Running' });
    s.define({ key: 'run.showTime', title: 'Show how long each run took', type: 'boolean', default: true, section: 'Running' });

    this.addInterpreter({ id: 'rust', name: 'Rust', description: 'The Rust interpreter (jlb). One comes with the IDE.', program: 'jlb' });
    this.addInterpreter({ id: 'c', name: 'C', description: 'The C interpreter (jlb-c).', program: 'jlb-c' });
    s.onChange('run.interpreter', () => this.renderSwitch());
    s.onChange('interpreters.', () => this.renderSwitch());

    listen('run-output', (e) => this.onOutput(e.payload));
    listen('run-exit', (e) => this.onExit(e.payload));
  }

  async init() {
    try {
      this.found = await invoke('find_interpreters');
    } catch {
      this.found = {};
    }
    this.renderSwitch();
  }

  /** { id, name, description, program } — gives back a function that removes it. */
  addInterpreter(it) {
    this.interpreters.set(it.id, it);
    this.ide.settings.define({
      key: `interpreters.${it.id}`,
      title: `${it.name} interpreter`,
      description: `${it.description} Leave empty to use the one found next to the IDE.`,
      type: 'path',
      default: '',
      section: 'Interpreters',
    });
    const def = this.ide.settings.defs.get('run.interpreter');
    def.options = [...this.interpreters.values()].map((x) => ({ value: x.id, label: x.name }));
    this.renderSwitch();
    return () => {
      this.interpreters.delete(it.id);
      def.options = def.options.filter((o) => o.value !== it.id);
      this.renderSwitch();
    };
  }

  /** The chosen interpreter: { id, name, path } (path is null when it isn't set up). */
  current() {
    let id = this.ide.settings.get('run.interpreter');
    if (!this.interpreters.has(id)) id = this.interpreters.keys().next().value;
    return this.resolve(id);
  }

  resolve(id) {
    const it = this.interpreters.get(id);
    if (!it) return null;
    const path = this.ide.settings.get(`interpreters.${id}`) || this.found?.[id] || null;
    return { ...it, path };
  }

  // ---------- toolbar ----------

  toolbar() {
    this.switchEl = h('div.seg', { role: 'radiogroup', 'aria-label': 'Interpreter' });
    this.runBtn = h('button.run-btn', { on: { click: () => this.ide.commands.run('run.start') } });
    this.stopBtn = h('button.stop-btn', { title: 'Stop (Shift+F5)', 'aria-label': 'Stop', hidden: true, on: { click: () => this.stop() } }, icon('stop', 14));
    this.renderSwitch();
    this.renderRunButton();
    return h('div.run-controls', this.switchEl, this.runBtn, this.stopBtn);
  }

  renderSwitch() {
    if (!this.switchEl) return;
    clear(this.switchEl);
    const chosen = this.current()?.id;
    for (const it of this.interpreters.values()) {
      const r = this.resolve(it.id);
      this.switchEl.append(h(`button.seg-btn${it.id === chosen ? '.on' : ''}${r.path ? '' : '.missing'}`, {
        role: 'radio',
        'aria-checked': it.id === chosen ? 'true' : 'false',
        title: r.path ? `Run with the ${it.name} interpreter\n${r.path}` : `The ${it.name} interpreter isn't set up yet`,
        on: { click: () => this.ide.settings.set('run.interpreter', it.id) },
      }, it.name));
    }
    this.ide.events.emit('interpreter-change', this.current());
  }

  renderRunButton() {
    if (!this.runBtn) return;
    clear(this.runBtn);
    const running = !!this.run_;
    this.runBtn.append(icon(running ? 'refresh' : 'play', 14), running ? 'Restart' : 'Run');
    this.runBtn.title = `${running ? 'Restart' : 'Run'} (${showKey(this.ide.commands.keyFor('run.start')) || 'F5'})`;
    this.runBtn.classList.toggle('running', running);
    this.stopBtn.hidden = !running;
    document.body.classList.toggle('is-running', running);
  }

  // ---------- running ----------

  /**
   * Runs the current file. With { debug: true } it runs under the debugger, which
   * needs the Rust interpreter; { debug: 'auto' } (what Run does) debugs only when
   * the debugger plugin says so, like when breakpoints are set.
   */
  async run({ debug = 'auto', stepFirst = false } = {}) {
    const ws = this.ide.workspace;
    const doc = ws.current();
    if (!doc) return toast('Open or create a .jlb file to run it.');
    let it = this.current();
    const dbg = this.ide.plugins.services.get('debugger');
    let note = null;
    if (debug === 'auto') debug = !!dbg?.wanted(doc);
    if (debug && it?.id !== 'rust') {
      const rust = this.resolve('rust');
      if (stepFirst || !dbg) {
        note = `Debugging uses the Rust interpreter, so this runs with Rust instead of ${it?.name}.`;
        it = rust;
      } else {
        // Breakpoints are only a reason to debug when the chosen interpreter can.
        note = `Breakpoints only work with the Rust interpreter, so ${it?.name} runs without stopping at them.`;
        debug = false;
      }
    }
    if (!it?.path) {
      this.ide.layout.showPanel('output');
      this.system(`The ${it?.name || ''} interpreter isn't set up yet. Choose its program in Settings → Interpreters.`, 'error');
      this.offerSetup(it);
      return;
    }
    if (this.run_) await this.stop(true);
    const s = this.ide.settings;
    if (!doc.path || (ws.isDirty(doc) && s.get('run.saveFirst'))) {
      if (!(await ws.save(doc, { quiet: true }))) return;
    } else if (ws.isDirty(doc)) {
      toast('Running the last saved version (saving before running is off).');
    }
    if (s.get('run.clearOutput')) this.clearOutput();
    if (s.get('run.showOutput')) this.ide.layout.showPanel('output', { focus: false });
    this.system(`${debug ? 'Debugging' : 'Running'} ${doc.name} with ${it.name}`);
    if (note) this.system(note);
    let id;
    try {
      id = await invoke('run_program', { interpreter: it.path, file: doc.path, cwd: ws.workDir(doc), args: [debug ? '--debug' : '--ide'] });
    } catch (e) {
      this.system(String(e), 'error');
      this.offerSetup(it);
      return;
    }
    this.run_ = { id, doc, it, debug: !!debug, stepFirst, start: performance.now(), stderrLine: '', crash: null };
    this.lastDoc = doc;
    this.renderRunButton();
    this.setInputEnabled(true);
    this.ide.events.emit('run-start', { doc, interpreter: it, debug: !!debug, stepFirst });
    const early = this.early.filter((e) => e.payload.id === id);
    this.early = [];
    for (const e of early) (e.kind === 'out' ? this.onOutput(e.payload) : this.onExit(e.payload));
  }

  async stop(quiet = false) {
    if (!this.run_) return;
    this.run_.stopped = true;
    if (!quiet) this.system('Stopping…');
    await invoke('stop_program', { id: this.run_.id }).catch(() => {});
    if (quiet) {
      // Wait briefly for the exit event, so the next run starts clean.
      for (let i = 0; i < 40 && this.run_; i++) await new Promise((r) => setTimeout(r, 25));
      this.run_ = null;
    }
  }

  onOutput(payload) {
    const { id, stream, text } = payload;
    const r = this.run_;
    if (!r || r.id !== id) {
      if (!r || id > r.id) this.early.push({ kind: 'out', payload });
      return;
    }
    if (stream === 'out') {
      this.queueOut(text);
    } else {
      // Error output arrives in pieces; the crash report's JSON line is for the IDE, not the person.
      r.stderrLine += text;
      const lines = r.stderrLine.split('\n');
      r.stderrLine = lines.pop();
      for (const line of lines) this.stderr(line + '\n');
    }
    this.ide.events.emit('run-output', { stream, text });
  }

  stderr(line) {
    const r = this.run_;
    if (line.startsWith(MARK)) {
      let msg;
      try {
        msg = JSON.parse(line.slice(1));
      } catch {
        // Not JSON after all; show it.
        this.write(line, 'err');
        return;
      }
      // The debugger's messages have an "event"; anything else is the crash report.
      if (msg.event) this.ide.events.emit('debug-event', { ...msg, doc: r.doc });
      else r.crash = msg;
      return;
    }
    this.writeLinked(line, 'err');
  }

  /** Sends a command to the program being debugged (see jlb --debug). */
  async debugCommand(command) {
    const r = this.run_;
    if (!r?.debug) return false;
    try {
      await invoke('send_input', { id: r.id, text: MARK + command });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Program output is gathered and shown a few times a second, so a program printing
   * thousands of lines can't swamp the window. Anything else written shows it first.
   */
  queueOut(text) {
    this.outQueue = (this.outQueue || '') + text;
    // Older output would be trimmed off anyway.
    if (this.outQueue.length > MAX_OUTPUT) this.outQueue = this.outQueue.slice(-MAX_OUTPUT);
    // Waits longer after a slow update, so the window always has time to respond.
    this.outTimer ||= setTimeout(() => this.flushOut(), Math.max(40, (this.flushCost || 0) * 4));
  }

  flushOut() {
    clearTimeout(this.outTimer);
    this.outTimer = null;
    let q = this.outQueue;
    if (!q) return;
    this.outQueue = '';
    // So much new output that everything shown now would be trimmed off anyway:
    // show just the end of it.
    let cut = q.length;
    for (let n = 0; n <= MAX_LINES && cut > 0; n++) cut = q.lastIndexOf('\n', cut - 1);
    if (cut > 0) q = q.slice(cut + 1);
    if ((cut > 0 || q.length >= MAX_OUTPUT) && this.outEl) {
      clear(this.outEl);
      this.outLen = 0;
      this.lastLine = null;
    }
    const t0 = performance.now();
    this.write(q, 'out');
    this.flushCost = performance.now() - t0;
  }

  /** Writes an error line with its "line N" parts as links to the code. */
  writeLinked(line, kind) {
    this.flushOut();
    // "ERROR in helpers.jlb, line 4" names a file; "f()  line 3" is in the program itself.
    const re = /\bin ([^,]+?\.jlb), line (\d+)|\bline (\d+)/g;
    let last = 0;
    let m;
    while ((m = re.exec(line))) {
      let start = m.index;
      if (m[1]) start += 3; // keep "in " as plain text
      if (start > last) this.write(line.slice(last, start), kind);
      const file = m[1] || null;
      const n = Number(m[2] || m[3]);
      // In "helper()  line 2", the line is in the file where helper is.
      const func = !file ? line.slice(0, start).match(/(\w+)\(\)\s*$/)?.[1] : null;
      const text = line.slice(start, m.index + m[0].length);
      this.lastLine ||= (() => {
        const l = h('div.out-line');
        this.outEl.append(l);
        return l;
      })();
      this.lastLine.append(h('button.out-link', { title: 'Go to this line', on: { click: () => this.goToLine(file, n, func) } }, text));
      this.outLen += text.length;
      last = start + text.length;
    }
    this.write(line.slice(last), kind);
  }

  async goToLine(file, line, func) {
    const doc = this.lastDoc;
    const ws = this.ide.workspace;
    const crash = this.lastCrash;
    const path = (file && crash?.file === file && crash.path) || (func && crash?.frames.find((f) => f.name === func && f.line === line)?.path);
    if (path) {
      await ws.openFile(path);
    } else if (file && doc?.path && file !== doc.name) {
      const sep = doc.path.includes('\\') ? '\\' : '/';
      await ws.openFile(doc.path.replace(/[\\/][^\\/]*$/, '') + sep + file);
    } else if (doc && ws.docs.includes(doc) && ws.active !== doc) ws.activate(doc);
    this.ide.editor.goTo(line, 1, { select: true });
  }

  onExit(payload) {
    const { id, code } = payload;
    const r = this.run_;
    if (!r || r.id !== id) {
      if (!r || id > r.id) this.early.push({ kind: 'exit', payload });
      return;
    }
    if (r.stderrLine) this.stderr(r.stderrLine);
    this.run_ = null;
    this.renderRunButton();
    this.setInputEnabled(false);
    const secs = ((performance.now() - r.start) / 1000).toFixed(2);
    const time = this.ide.settings.get('run.showTime') ? ` in ${secs}s` : '';
    if (r.stopped) this.system('Stopped');
    else if (code === 0) this.system(`Finished${time}`, 'ok');
    else this.system(`Ended with an error${time}`, 'error');
    this.lastCrash = r.crash;
    if (r.crash) this.ide.events.emit('crash', { report: r.crash, doc: r.doc, interpreter: r.it });
    this.ide.events.emit('run-exit', { code, stopped: !!r.stopped, doc: r.doc, debug: r.debug });
  }

  offerSetup(it) {
    if (!it) return;
    this.flushOut();
    this.lastLine = null;
    const line = h('div.out-line',
      h('button.link', { on: { click: () => this.pickInterpreter(it.id) } }, `Choose the ${it.name} interpreter program…`));
    this.outEl?.append(line);
  }

  async pickInterpreter(id) {
    const p = await pickOpen();
    if (!p) return;
    this.ide.settings.set(`interpreters.${id}`, p);
    toast(`The ${this.interpreters.get(id).name} interpreter is set to ${p}`, { kind: 'ok' });
  }

  // ---------- the Output panel ----------

  panel() {
    return {
      id: 'output',
      title: 'Output',
      order: 10,
      actions: [{ icon: 'trash', title: 'Clear output', run: () => this.clearOutput() }],
      render: (el) => {
        el.classList.add('output');
        this.outEl = h('div.out', { role: 'log', 'aria-live': 'polite', tabindex: '0' });
        this.inputEl = h('input.out-input', {
          placeholder: 'Type here and press Enter to answer INPUT',
          spellcheck: false,
          disabled: true,
          'aria-label': 'Input for the running program',
          on: { keydown: (e) => this.inputKey(e) },
        });
        this.inputRow = h('div.out-input-row', h('span.out-prompt', '›'), this.inputEl);
        el.append(this.outEl, this.inputRow);
        this.empty();
      },
      onShow: ({ focus }) => {
        if (focus && this.run_) this.inputEl?.focus();
      },
    };
  }

  empty() {
    if (!this.outEl || this.outEl.childNodes.length) return;
    this.outEl.append(h('div.out-empty', 'Output from your programs shows up here. Press ', h('kbd', showKey(this.ide.commands.keyFor('run.start')) || 'F5'), ' to run the current file.'));
  }

  clearOutput() {
    this.outQueue = '';
    if (!this.outEl) return;
    clear(this.outEl);
    this.outLen = 0;
    this.lastLine = null;
    if (!this.run_) this.empty();
  }

  /** Adds text to the output. A line that didn't end (like an INPUT prompt) is continued. */
  write(text, kind) {
    if (!this.outEl) return;
    if (this.outQueue && kind !== 'out') this.flushOut();
    this.outEl.querySelector('.out-empty')?.remove();
    const stick = this.outEl.scrollTop + this.outEl.clientHeight >= this.outEl.scrollHeight - 30;
    const parts = text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) this.lastLine = null;
      if (part === '' && i === parts.length - 1) return;
      if (!this.lastLine) {
        this.lastLine = h('div.out-line');
        this.outEl.append(this.lastLine);
      }
      if (!part) return;
      this.outLen += part.length;
      const last = this.lastLine.lastChild;
      if (last && last.dataset.kind === kind) last.append(part);
      else {
        const seg = h(`span.${kind.split(' ').map((k) => 'o-' + k).join('.')}`, part);
        seg.dataset.kind = kind;
        this.lastLine.append(seg);
      }
    });
    this.trim();
    if (stick) this.outEl.scrollTop = this.outEl.scrollHeight;
  }

  system(text, tone = '') {
    this.lastLine = null;
    this.write(text + '\n', 'sys' + (tone ? ` ${tone}` : ''));
  }

  /** Drops the oldest lines past MAX_LINES or MAX_OUTPUT characters (counted as they're added). */
  trim() {
    while ((this.outLen > MAX_OUTPUT || this.outEl.childElementCount > MAX_LINES) && this.outEl.firstChild) {
      this.outLen -= this.outEl.firstChild.textContent.length;
      this.outEl.firstChild.remove();
    }
    if (!this.outEl.firstChild) this.outLen = 0;
  }

  setInputEnabled(on) {
    if (!this.inputEl) return;
    this.inputEl.disabled = !on;
    this.inputRow.classList.toggle('live', on);
    if (on && this.ide.settings.get('run.focusInput') && this.ide.layout.activePanel === 'output') this.inputEl.focus();
  }

  async inputKey(e) {
    if (e.key !== 'Enter' || !this.run_) return;
    // A line starting with the marker would be taken as a debugger command.
    const text = this.inputEl.value.replace(new RegExp('^' + MARK + '+'), '');
    this.inputEl.value = '';
    // Show what was typed, after the prompt, like a terminal does.
    this.write(text + '\n', 'in');
    try {
      await invoke('send_input', { id: this.run_.id, text });
    } catch (err) {
      this.system(String(err), 'error');
    }
  }
}
