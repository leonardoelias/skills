// The <shared> part of the template: the page and check count the lines with it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sharedCode } from '../src/page.mjs';

const { readSide, diffRows, countShown, splitLines } = sharedCode();

test('splitLines removes blank lines at the ends and spaces at the end', () => {
  assert.deepEqual(splitLines('\n\n  a  \n\n b\t\n\n'), ['  a', '', ' b']);
  assert.deepEqual(splitLines(undefined), []);
});

test('readSide: a hidden block becomes one line; full and fullIndex open the block', () => {
  const side = readSide(['function f() {', '  //{', '  const a = 1', '  const b = 2', '  //}', '  return a + b', '}'].join('\n'));
  assert.equal(side.shown.length, 4);
  assert.deepEqual(side.shown[1].hidden, ['  const a = 1', '  const b = 2']);
  assert.equal(side.shown[1].indent, '  ');
  assert.deepEqual(side.full, ['function f() {', '  const a = 1', '  const b = 2', '  return a + b', '}']);
  assert.deepEqual(side.fullIndex, [0, 1, 3, 4]);
});

test('diffRows ignores indentation, like GitHub\'s "Hide whitespace"', () => {
  const ops = diffRows(['a()', 'b()'], ['try {', '  a()', '  b()', '}']);
  assert.deepEqual(ops.map((op) => op.type), ['add', 'same', 'same', 'add']);
});

test('diffRows prefers matching a line of code to a blank line', () => {
  const old = ['const weight = x', 'const response = quote()', '', 'return {', '  price,', '}'];
  const now = ['const weight = x', 'const key = f()', '', 'const response = quote()', 'const result = {', '  price,', '}'];
  const same = diffRows(old, now).filter((op) => op.type === 'same').map((op) => old[op.a]);
  assert.ok(same.includes('const response = quote()'));
});

test('diffRows: in each part, removals before additions', () => {
  const ops = diffRows(['a', 'x', 'b'], ['a', 'y', 'b']);
  assert.deepEqual(ops.map((op) => op.type), ['same', 'del', 'add', 'same']);
});

test('countShown counts neither blank lines nor the content of hidden blocks', () => {
  const old = 'f() {\n  //{\n  a\n  b\n  //}\n  c\n}';
  const now = 'f() {\n  //{\n  a\n  b\n  //}\n  d\n\n  e\n}';
  assert.deepEqual(countShown(old, now), { added: 2, removed: 1 });
  assert.deepEqual(countShown(undefined, 'a\n\nb'), { added: 2, removed: 0 });
});
