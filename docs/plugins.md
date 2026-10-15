# Writing plugins for JLB IDE

A plugin adds features to JLB IDE: commands, panels, hover info, suggestions, mistake checks, settings, and more. The IDE's own features are built the same way, so a plugin can do anything they do.

## The quickest start

1. Open **Plugins** (the puzzle piece at the bottom left) and click **Create a plugin**.
2. Give it a name. The IDE writes a working example to the plugins folder and opens its `main.js`.
3. Change the code and save. The IDE notices and reloads the plugin within a couple of seconds (or click **Reload plugins** if you've switched off *Reload plugins when their files change* in Settings).

The example counts the words in the current file, shows the count in the status bar, adds a command, a setting and a check. It's a good template to start from.

## Where plugins live

Each plugin is a folder inside the plugins folder:

| System | Plugins folder |
| --- | --- |
| Windows | `%APPDATA%\io.github.asdfboy.jlbide\plugins` |
| macOS | `~/Library/Application Support/io.github.asdfboy.jlbide/plugins` |
| Linux | `~/.config/io.github.asdfboy.jlbide/plugins` |

The exact path is shown at the bottom of the Plugins view. To install a plugin, click **Install from a folder** in the Plugins view and pick the plugin's folder (the one with `plugin.json` in it); it's copied into the plugins folder and started. You can also put the folder there yourself.

```text
plugins/
  word-count/
    plugin.json    the manifest (required)
    main.js        the code (required)
    style.css      extra styles (optional)
```

> **Plugins are trusted code.** They run inside the IDE with full access to your files and can start programs, like extensions in other editors. Only install plugins you trust.

## plugin.json

```json
{
  "id": "word-count",
  "name": "Word count",
  "version": "0.1.0",
  "description": "Counts the words in the current file.",
  "author": "Your name",
  "apiVersion": 1,
  "main": "main.js",
  "style": "style.css",
  "enabledByDefault": true,
  "settings": [
    { "key": "showInStatusBar", "title": "Show the word count in the status bar", "type": "boolean", "default": true }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Required. Lowercase letters, digits and dashes. Must be unique. |
| `name` | Shown in the Plugins view and as the plugin's section in Settings. |
| `version`, `description`, `author` | Shown in the Plugins view. |
| `apiVersion` | The plugin API version it was written for. The current version is 1. |
| `main` | The code file. Default `main.js`. |
| `style` | A CSS file added while the plugin is on. Default `style.css` (optional). |
| `enabledByDefault` | Set to `false` to install switched off. |
| `settings` | Setting definitions (see [Settings](#settings)). They appear in Settings automatically. |

## main.js

`main.js` is a JavaScript module. It exports `activate(api)`, which runs when the plugin is switched on, and optionally `deactivate()`.

```js
export function activate(api) {
  api.commands.register({
    id: 'hello.say',
    title: 'Say hello',
    key: 'Ctrl+Alt+H',
    run: () => api.ui.toast('Hello from a plugin!'),
  });
}
```

**Everything you register through `api` is removed automatically when the plugin is switched off,** so most plugins never need `deactivate`. For anything else (timers, your own listeners), pass a cleanup function to `api.onDispose(fn)`.

Plugins can't `import` packages. The IDE's CodeMirror modules are available as `api.cm` instead.

## The API

### `api.commands`

| Call | What it does |
| --- | --- |
| `register({ id, title, run, key, category })` | Adds a command to the command palette (Ctrl+Shift+P). `key` is an optional shortcut like `"Ctrl+Alt+H"` or `"F7"`; people can change it in Settings → Keyboard shortcuts. |
| `run(id, ...args)` | Runs any command, including the IDE's own (see [Command ids](#command-ids)). |

### `api.settings`

| Call | What it does |
| --- | --- |
| `define(definition)` | Adds a setting (see below). |
| `get(key)` | The current value. |
| `set(key, value)` | Changes it (and saves). |
| `onChange(key, fn)` | Calls `fn(value)` when it changes. |

A plain key like `"showInStatusBar"` is your plugin's own: it's stored as `word-count.showInStatusBar`. A key with a dot, like `"editor.fontSize"`, reads the IDE's settings.

<a id="settings"></a>A setting definition:

| Field | Meaning |
| --- | --- |
| `key` | The name. |
| `title` | Short label in Settings. |
| `description` | One sentence on what it does (optional). |
| `type` | `"boolean"`, `"number"`, `"text"`, `"select"` or `"path"`. |
| `default` | The starting value. |
| `options` | For `"select"`: `[{ "value": "a", "label": "Option A" }]`. |
| `min`, `max` | For `"number"`. |
| `hidden` | `true` to store a value without showing it in Settings. |

### `api.editor`

| Call | What it does |
| --- | --- |
| `text` | The current file's text. |
| `view` | The CodeMirror `EditorView`. |
| `addExtension(ext)` | Adds a CodeMirror extension (built with `api.cm`). |
| `goTo(line, col)` | Moves the cursor there and scrolls to it. |
| `insert(text)` | Replaces the selection with text. |
| `selection()` | The selected text. |
| `focus()` | Puts the keyboard focus in the editor. |

### `api.workspace`

| Call | What it does |
| --- | --- |
| `active` | The current file: `{ name, path }` (`path` is `null` before it's saved). |
| `files` | Every open file. |
| `folder` | The open folder's path, or `null`. |
| `openFile(path)`, `newFile(text)`, `save()` | Open, create and save files. |
| `textOf(file)` | Any open file's current text. |
| `isDirty(file)` | `true` when the file has unsaved changes. |
| `setText(file, text)` | Replaces a file's text as an edit (it can be undone, and shows as unsaved). |
| `activate(file)` | Switches to an open file's tab. |
| `restored` | `true` once the files from last time have been reopened. |

### `api.layout`

| Call | What it does |
| --- | --- |
| `addView({ id, title, icon, order, render(el), actions, bottom })` | A view in the sidebar, with a button in the activity bar. `render(el)` fills the element once. `icon` is an icon name (`files`, `book`, `list`, `puzzle`, `gear`, `flask`, `bug`, `terminal`, `search`) or your own SVG path markup for a 24×24 box. `actions` adds small buttons to its title: `[{ icon, title, run }]`. |
| `addPanel({ id, title, order, render(el), actions })` | A tab in the bottom panel (next to Output and Problems). |
| `showView(id)`, `showPanel(id)` | Opens one. |
| `setBadge(panelId, text, kind)` | Shows a small count on a panel's tab. `kind`: `"error"`, `"warning"` or nothing. |
| `addToolbar(el, side)` | Puts an element in the top toolbar (`"left"` or `"right"`). |
| `addStatus(el, side)` | Puts an element in the status bar. Give it the class `status-item` to match. |

### `api.language`

The IDE's mistake checking, hover info and suggestions are built from these.

**`addCheck({ id, title, check })`** adds a mistake check. `check(ctx)` gets `{ text, path }` and gives back (or resolves to) a list of problems. They're underlined in the editor and listed in Problems:

```js
api.language.addCheck({
  title: 'TODO finder',
  check: ({ text }) => text.split('\n').flatMap((line, i) =>
    line.includes('TODO') ? [{ line: i + 1, col: line.indexOf('TODO') + 1, severity: 'info', message: 'Something to do here' }] : []),
});
```

A problem is `{ line, col, endCol, severity, message, fix }`. `line` and `col` count from 1; without `col` the whole line is marked. `severity` is `"error"`, `"warning"` or `"info"`. `fix` is an optional one-click fix that replaces the marked text: `{ label: 'Change to &', text: '&' }` (or a list of them).

**`addHover(provider)`** adds info shown when the mouse rests on code. `provider(ctx)` gets `{ word, op, line, pos, state }`, where `word` and `op` are the word or operator under the mouse (`{ text, from, to }`, or `null`). It gives back `null` to pass, or:

```js
{ title: 'PRINT(a, b, ...)', subtitle: 'Command', body: 'Prints its inputs.', example: 'PRINT("hi")' }
```

**`addCompletions(source)`** adds suggestions. `source` is a [CodeMirror completion source](https://codemirror.net/docs/ref/#autocomplete.CompletionSource): it gets a context and gives back `{ from, options: [{ label, type, detail, info }] }` or `null`.

### `api.run`

| Call | What it does |
| --- | --- |
| `addInterpreter({ id, name, description })` | Adds another interpreter to the Rust/C switch, with a path setting in Settings → Interpreters. It must support the [editor modes](https://github.com/ASDFboy/jlb-rust/blob/main/docs/09-programs-and-files.md#editor-modes). |
| `current` | The chosen interpreter: `{ id, name, path }` (`path` is `null` if it isn't set up). |
| `resolve(id)` | The same, for any interpreter. |
| `start(options)`, `stop()` | Runs or stops the current file. `start({ debug: true })` runs it under the debugger (with the Rust interpreter); add `stepFirst: true` to stop at the first line. |
| `running` | The running program: `{ doc, interpreter, debug }`, or `null`. |
| `debug(command)` | Sends a debugger command (`continue`, `step`, `over`, `out`, `pause`, `eval <id>⇥<expression>`, ...; see [`--debug`](https://github.com/ASDFboy/jlb-rust/blob/main/docs/09-programs-and-files.md#editor-modes)) to the program being debugged. Gives back `false` when nothing is being debugged. |

### `api.events`

`api.events.on(name, fn)` listens for:

| Event | Gets |
| --- | --- |
| `file-open`, `file-save`, `file-close` | the file |
| `active-change` | the new current file (or `null`) |
| `editor-change` | a CodeMirror update, after the text changes |
| `editor-cursor` | the editor state, after the cursor moves |
| `folder-change` | the new folder path |
| `workspace-restored` | nothing; the files from last time have been reopened |
| `problems` | the list of problems, from every open file (each has a `file`) |
| `run-start` | `{ doc, interpreter, debug, stepFirst }` |
| `run-output` | `{ stream, text }` (`stream` is `"out"` or `"err"`) |
| `run-exit` | `{ code, stopped, doc, debug }` |
| `debug-event` | a message from the debugger, like `{ event: "paused", reason, path, line, stack, globals }` (see [`--debug`](https://github.com/ASDFboy/jlb-rust/blob/main/docs/09-programs-and-files.md#editor-modes)), plus `doc` |
| `crash` | `{ report, doc }`; `report` is the [JSON crash report](https://github.com/ASDFboy/jlb-rust/blob/main/docs/09-programs-and-files.md#editor-modes) |
| `settings-change` | `key, value` |

### Everything else

| Call | What it does |
| --- | --- |
| `api.ui` | `h(tag, props, ...children)` builds elements (`h('div.box', { on: { click } }, 'text')`), plus `icon(name)`, `toast(message)`, `confirm(question)`, `prompt(question)`, `choose(question, choices)` and `contextMenu(event, items)`. |
| `api.cm` | CodeMirror: `state`, `view`, `language`, `autocomplete`, `lint`, `commands` and `highlight`. |
| `api.jlb` | What the IDE knows about .jlb: `KEYWORDS`, `BUILTINS` (`{ NAME: [signature, description] }`), `OPERATORS`, `KEYWORD_HELP`. |
| `api.provide(name, value)`, `api.use(name)` | Share an object with other plugins, or use one they shared. The language guide shares `docs`, with `docs.show(page, anchor)`. |
| `api.invoke(command, args)` | Calls the IDE's native side directly, for example `read_text`, `write_text` and `list_dir`. |
| `api.onDispose(fn)` | Runs `fn` when the plugin is switched off. |
| `api.plugin` | Your plugin's `{ id, name, version, folder }`. |

## Command ids

The IDE's own commands, for `api.commands.run(id)`:

| Id | Does |
| --- | --- |
| `file.new`, `file.open`, `file.openFolder`, `file.save`, `file.saveAs`, `file.saveAll`, `file.close` | files |
| `run.start`, `run.stop`, `run.rust`, `run.c` | running |
| `view.palette`, `view.settings`, `view.sidebar`, `view.panel`, `view.output`, `view.problems` | the window |
| `navigate.definition`, `navigate.line` | getting around |
| `quicktry.focus`, `quicktry.selection` | Quick-try |
| `docs.show` | the language guide |
| `plugins.reload`, `plugins.create`, `plugins.install` | plugins |

## A bigger example

A panel that lists every `PRINT` in the file, with buttons that jump to each one:

```js
export function activate(api) {
  const { h, clear } = api.ui;
  let el;

  const render = () => {
    if (!el) return;
    clear(el);
    api.editor.text.split('\n').forEach((line, i) => {
      if (!line.includes('PRINT(')) return;
      el.append(h('button.link', { on: { click: () => api.editor.goTo(i + 1) } }, `Line ${i + 1}: ${line.trim()}`), h('br'));
    });
  };

  api.layout.addPanel({ id: 'prints', title: 'PRINTs', render: (e) => { el = e; render(); } });
  api.events.on('editor-change', render);
  api.events.on('active-change', render);
}
```

## Tips

- **Errors are contained.** If `activate` throws, the IDE shows the error on the plugin's card and keeps running.
- **See what's going on** with the developer tools: right-click in the IDE and choose Inspect (in development builds), or open the browser version (see the README).
- **Name your settings and commands after your plugin** (like `word-count.show`) so they don't clash with others.
