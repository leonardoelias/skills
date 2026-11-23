import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseDiff } from '../src/diff.mjs';
import { changedTests, formatChangedTests, readChangedTests, scanTests } from '../src/tests.mjs';
import { readVersion } from '../src/versions.mjs';
import { EXAMPLE } from './helpers.mjs';

test('scanTests: groups, the extent of each test and a parametrized test', () => {
  const tests = scanTests(readVersion(EXAMPLE, 'head', 'src/shipping/cache.test.ts'));
  assert.deepEqual(tests.map((t) => [t.line, t.end, t.group, t.param]), [
    [5, 11, 'ExpiringCache', false],
    [13, 21, 'ExpiringCache', false],
    [25, 30, 'shippingKey', true],
  ]);
  assert.equal(tests[2].name, 'postal code %s with %i g becomes %s');
});

test('scanTests: Go with subtests, pytest with a class and Swift Testing', () => {
  const go = scanTests(['func TestShipping(t *testing.T) {', '\tt.Run("empty zip", func(t *testing.T) {', '\t\tt.Fatal()', '\t})', '}', '', 'func helper() {}'].join('\n'));
  assert.deepEqual(go.map((t) => [t.name, t.line, t.end]), [['TestShipping', 1, 5], ['TestShipping/empty zip', 2, 4]]);

  const py = scanTests(['class TestCache:', '    def test_expires(self):', '        assert True', '', 'def test_standalone():', '    pass'].join('\n'));
  assert.deepEqual(py.map((t) => [t.name, t.group, t.line, t.end]), [['test_expires', 'TestCache', 2, 3], ['test_standalone', '', 5, 6]]);

  const swift = scanTests(['@Suite("Cart")', 'struct CartTests {', '  @Test("empty has no shipping") func empty() {', '    #expect(true)', '  }', '}'].join('\n'));
  assert.equal(swift[0].name, 'empty has no shipping');
});

test('changedTests of the example: added, removed, and the ones the PR does not touch stay out', () => {
  const files = parseDiff(readFileSync(path.join(EXAMPLE, 'full.diff'), 'utf8'));
  const rows = changedTests(files, (side, file) => readVersion(EXAMPLE, side, file));
  assert.deepEqual(rows.map((r) => `${r.change} ${r.path}:${r.line}`), [
    'added src/shipping/cache.test.ts:5',
    'added src/shipping/cache.test.ts:13',
    'added src/shipping/cache.test.ts:25',
    'added src/shipping/quote.test.ts:22',
    'added src/shipping/quote.test.ts:31',
    'removed src/shipping/quote.test.ts:16',
  ]);
  assert.deepEqual(readChangedTests(formatChangedTests(rows)), rows.map(({ change, path: p, line, name, group }) => ({ change, path: p, line, name, group })));
});

test('changedTests: a changed body is modified; a test that changed files is moved', () => {
  const base = { 'a.test.ts': "it('adds', () => {\n  expect(1).toBe(1)\n})\nit('goes away', () => {\n  ok()\n})\n" };
  const head = {
    'a.test.ts': "it('adds', () => {\n  expect(2).toBe(2)\n})\n",
    'b.test.ts': "it('goes away', () => {\n  ok()\n})\n",
  };
  const files = parseDiff([
    'diff --git a/a.test.ts b/a.test.ts',
    '--- a/a.test.ts',
    '+++ b/a.test.ts',
    '@@ -1,6 +1,3 @@',
    " it('adds', () => {",
    '-  expect(1).toBe(1)',
    '+  expect(2).toBe(2)',
    ' })',
    "-it('goes away', () => {",
    '-  ok()',
    '-})',
    'diff --git a/b.test.ts b/b.test.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/b.test.ts',
    '@@ -0,0 +1,3 @@',
    "+it('goes away', () => {",
    '+  ok()',
    '+})',
  ].join('\n'));
  const rows = changedTests(files, (side, file) => (side === 'head' ? head : base)[file] ?? null);
  assert.deepEqual(rows.map((r) => `${r.change} ${r.path}:${r.line} ${r.name}`), ['modified a.test.ts:1 adds', 'moved b.test.ts:1 goes away']);
});
