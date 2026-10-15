// The formatter: tidy spacing, and never a change in what the code does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { format, tokenize, diff } from '../src/plugins/format.js';

const pieces = (text) => tokenize(text).flatMap((l) => l.tokens.map((t) => t.text));

test('tidies spacing around operators, commas, brackets and calls', () => {
  assert.equal(format('x=1+2*-3\n'), 'x = 1 + 2 * -3\n');
  assert.equal(format('PRINT ( a,b ,c )\n'), 'PRINT(a, b, c)\n');
  assert.equal(format('hero=[ name:"Ann" ,hp : 10 ]\n'), 'hero = [name: "Ann", hp: 10]\n');
  assert.equal(format('IF(x>1)&&!done{\nPRINT(x)\n}\n'), 'IF (x > 1) && !done {\n    PRINT(x)\n}\n');
  assert.equal(format('FUNC  add( @t , ...rest ){\nRETURN t [1] . hp+f( )\n}\n'), 'FUNC add(@t, ...rest) {\n    RETURN t[1].hp + f()\n}\n');
  assert.equal(format('a = 1;b=2\n'), 'a = 1; b = 2\n');
  assert.equal(format('x = a - -b\ny = (-1) ^ 2\n'), 'x = a - -b\ny = (-1) ^ 2\n');
  assert.equal(format('FOR i IN [1,2] {PRINT(i)}\nIF x { } ELSE {}\n'), 'FOR i IN [1, 2] { PRINT(i) }\nIF x { } ELSE {}\n');
});

test('indents once per line that opens brackets, and lines that carry on', () => {
  assert.equal(format('PRINT(run(FUNC() {\na = 1\n}))\nx = 1 +\n2 +\n3\nIF a &\nb {\nPRINT(1)\n}\n'), 'PRINT(run(FUNC() {\n    a = 1\n}))\nx = 1 +\n    2 +\n    3\nIF a &\n    b {\n    PRINT(1)\n}\n');
});

test('indents by brackets, and leaves text and comments exactly as written', () => {
  const src = '>>>\n   keep   me\n<<<\nFUNC f() {\nIF x {\n      PRINT("a  ,b",   \'c\\n  d\')   >>   note\n}\n}\ns = "two\n   lines  "\nt = [\n1,\n2\n]\n';
  assert.equal(format(src), '>>>\n   keep   me\n<<<\nFUNC f() {\n    IF x {\n        PRINT("a  ,b", \'c\\n  d\')   >>   note\n    }\n}\ns = "two\n   lines  "\nt = [\n    1,\n    2\n]\n');
});

test('drops extra blank lines and trailing space, and can do just some lines', () => {
  assert.equal(format('\n\na=1   \n\n\n\n\nb=2\n\n\n'), 'a = 1\n\n\nb = 2\n');
  assert.equal(format('a=1\nb=2\nc=3', { lines: [2, 2] }), 'a=1\nb = 2\nc=3');
});

test('changes only the lines that need it', () => {
  assert.deepEqual(diff('a=1\nb = 2\n', 'a = 1\nb = 2\n'), [{ from: 0, to: 3, insert: 'a = 1' }]);
});

// Every example program: same pieces, formatting twice changes nothing, and it prints the same.
const cases = path.resolve('../jlb-rust/tests/cases');
const jlb = ['src-tauri/interpreters/jlb', 'src-tauri/interpreters/jlb.exe'].map((p) => path.resolve(p)).find((p) => fs.existsSync(p));
test('formatting example programs keeps them the same program', { skip: !fs.existsSync(cases) && 'no example programs next to this folder' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jlb-format-'));
  let ran = 0;
  for (const name of fs.readdirSync(cases).filter((f) => f.endsWith('.jlb'))) {
    const src = fs.readFileSync(path.join(cases, name), 'utf8');
    const out = format(src);
    assert.deepEqual(pieces(out), pieces(src), name);
    assert.equal(format(out), out, `${name} formats the same twice`);
    if (!jlb) continue;
    // Run both versions in a copy of the folder, so IMPORT, LOAD and files work the same.
    for (const [dir, text] of [['a', src], ['b', out]]) {
      fs.cpSync(cases, path.join(tmp, dir), { recursive: true });
      fs.writeFileSync(path.join(tmp, dir, name), text);
    }
    const input = fs.existsSync(path.join(cases, name.replace(/\.jlb$/, '.in'))) ? fs.readFileSync(path.join(cases, name.replace(/\.jlb$/, '.in'))) : '';
    const runIn = (dir) => {
      try {
        return execFileSync(jlb, [name], { cwd: path.join(tmp, dir), input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 20000 });
      } catch (e) {
        return `exit ${e.status}\n${e.stdout}${String(e.stderr).replace(/line \d+/g, 'line N')}`;
      }
    };
    assert.equal(runIn('b'), runIn('a'), `${name} prints the same`);
    ran++;
  }
  if (jlb) assert.ok(ran > 10);
});

// Every example in the language guide: same pieces, and formatting twice changes nothing.
const guide = path.resolve('src/docs');
test('formatting the language guide examples keeps their pieces', { skip: !fs.existsSync(guide) && 'no guide' }, () => {
  let n = 0;
  for (const f of fs.readdirSync(guide).filter((x) => x.endsWith('.md'))) {
    for (const m of fs.readFileSync(path.join(guide, f), 'utf8').matchAll(/```(?:text|jlb)\n([\s\S]*?)```/g)) {
      const out = format(m[1]);
      assert.deepEqual(pieces(out), pieces(m[1]), `${f}: ${m[1].slice(0, 40)}`);
      assert.equal(format(out), out, `${f} twice: ${m[1].slice(0, 40)}`);
      n++;
    }
  }
  assert.ok(n > 50);
});
