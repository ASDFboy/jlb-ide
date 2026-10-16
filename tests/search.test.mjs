// The pieces behind Find in files and Rename everywhere, without the interface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matcher, findAll, expand$, includes } from '../src/plugins/search.js';
import { scan, bindingOf } from '../src/plugins/scan.js';
import { resolvePath } from '../src/plugins/linked.js';

test('matches plain text, whole words and patterns', () => {
  const find = (q, opts, text) => findAll(text, matcher(q, opts).re).map((m) => [m.line, m.from, m.to]);
  assert.deepEqual(find('a.b', {}, 'a.b axb\nA.B'), [[1, 0, 3], [2, 0, 3]]);
  assert.deepEqual(find('a.b', { caseSensitive: true }, 'a.b A.B'), [[1, 0, 3]]);
  assert.deepEqual(find('score', { wholeWord: true }, 'score add_score score2 (score)'), [[1, 0, 5], [1, 24, 29]]);
  assert.deepEqual(find('x*', { regex: true }, 'axxb'), [[1, 1, 3]]); // empty matches are skipped
  assert.match(matcher('(', { regex: true }).error, /doesn't work/);
});

test('fills in $1, $& and $<name> only for patterns', () => {
  const [m] = findAll('hp: 20', matcher('(?<key>\\w+): (\\d+)', { regex: true }).re);
  assert.equal(expand$('$2 $<key> [$&] $$ $9', m, true), '20 hp [hp: 20] $ $9');
  assert.equal(expand$('$1', m, false), '$1');
});

test('picks files by name or folder', () => {
  const f = (rel) => ({ rel });
  assert.equal(includes('')(f('a/b.txt')), true);
  assert.equal(includes('*.jlb')(f('lib/x.jlb')), true);
  assert.equal(includes('*.jlb')(f('lib/x.out')), false);
  assert.equal(includes('lib/')(f('lib/x.out')), true);
  assert.equal(includes('lib/')(f('other/x.out')), false);
  assert.equal(includes('src/**/*.jlb, *.txt')(f('src/a/b/c.jlb')), true);
  assert.equal(includes('src/**/*.jlb, *.txt')(f('notes.txt')), true);
});

test('knows which names are the same name', () => {
  const info = scan('count = 0\nFUNC f(n) {\n    count += n\n    made = 1\n    GLOBAL shared = 1\n    LOCAL count2 = 2\n    FOR i IN [1] { PRINT(i) }\n}\nFOR i IN [2] { PRINT(i) }\n');
  const where = (name) => info.refs.filter((r) => r.name === name).map((r) => bindingOf(info, r));
  assert.deepEqual(where('count'), ['global', 'global']);
  assert.deepEqual(where('n'), ['func:0', 'func:0']);
  assert.deepEqual(where('made'), ['func:0']);
  assert.deepEqual(where('count2'), ['func:0']);
  const loops = where('i');
  assert.equal(loops[0], loops[1]);
  assert.equal(loops[2], loops[3]);
  assert.notEqual(loops[0], loops[2]);
  // Inside a function, a name given a value is its own, even when another file has it,
  // unless GLOBAL comes first.
  assert.deepEqual(info.refs.filter((r) => r.name === 'made').map((r) => bindingOf(info, r, new Set(['made']))), ['func:0']);
  assert.deepEqual(where('shared'), ['global']);
});

test('works out import paths like the interpreter', () => {
  assert.equal(resolvePath('/a/b/main.jlb', 'lib/../x.jlb'), '/a/b/x.jlb');
  assert.equal(resolvePath('/a/b/main.jlb', '../c/./y.jlb'), '/a/c/y.jlb');
  assert.equal(resolvePath('C:\\p\\main.jlb', 'lib\\h.jlb'), 'C:\\p\\lib\\h.jlb');
  assert.equal(resolvePath('C:\\p\\main.jlb', '/abs.jlb'), 'C:\\abs.jlb');
  assert.equal(resolvePath('C:\\p\\main.jlb', 'D:\\q\\z.jlb'), 'D:\\q\\z.jlb');
});
