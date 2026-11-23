import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { formatRemovedTests, parseDiff, readRemovedTests, removedTests, testName } from '../src/diff.mjs';
import { EXAMPLE } from './helpers.mjs';

test('parseDiff: added and removed lines with the right number', () => {
  const files = parseDiff(readFileSync(path.join(EXAMPLE, 'full.diff'), 'utf8'));
  const quote = files.find((f) => f.newPath === 'src/shipping/quote.ts');
  assert.equal(quote.added.get(19).trim(), 'const key = shippingKey(digits, weightInGrams)');
  assert.equal(quote.removed.get(18).trim(), 'return {');
  const cache = files.find((f) => f.newPath === 'src/shipping/cache.ts');
  assert.equal(cache.oldPath, null);
  assert.equal(cache.added.size, 50);
});

test('parseDiff: renamed and deleted file; a "--- " line inside the hunk is a removal', () => {
  const diff = [
    'diff --git a/old.sql b/new.sql',
    'similarity index 90%',
    'rename from old.sql',
    'rename to new.sql',
    '--- a/old.sql',
    '+++ b/new.sql',
    '@@ -1,3 +1,3 @@',
    ' select 1;',
    '--- old comment',
    '+-- new comment',
    ' select 2;',
    'diff --git a/deleted.ts b/deleted.ts',
    'deleted file mode 100644',
    '--- a/deleted.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-export const x = 1',
    '',
  ].join('\n');
  const [renamed, deleted] = parseDiff(diff);
  assert.equal(renamed.oldPath, 'old.sql');
  assert.equal(renamed.newPath, 'new.sql');
  assert.equal(renamed.removed.get(2), '-- old comment');
  assert.equal(renamed.added.get(2), '-- new comment');
  assert.equal(deleted.newPath, null);
  assert.equal(deleted.removed.get(1), 'export const x = 1');
});

test('testName recognizes the common frameworks', () => {
  assert.equal(testName("  it('reuses the quote', async () => {"), 'reuses the quote');
  assert.equal(testName('  test.only("does something", () => {'), 'does something');
  assert.equal(testName('func TestUpsertAlias(t *testing.T) {'), 'TestUpsertAlias');
  assert.equal(testName('    def test_cache_expires(self):'), 'test_cache_expires');
  assert.equal(testName('  func testLoginFails() async throws {'), 'testLoginFails');
  assert.equal(testName('  @Test("Empty cart has no shipping") func empty() {'), 'Empty cart has no shipping');
  assert.equal(testName('  @Test func emptyCart() {'), 'emptyCart');
  assert.equal(testName('  it "returns 404" do'), 'returns 404');
  assert.equal(testName('  fun `adds up the weights`() {'), 'adds up the weights');
  assert.equal(testName('  const x = await it.each(list)'), null);
  assert.equal(testName('  wait("nothing")'), null);
});

test('removedTests: the deleted test goes in; the one that only changed files does not', () => {
  const files = parseDiff(readFileSync(path.join(EXAMPLE, 'full.diff'), 'utf8'));
  assert.deepEqual(removedTests(files), [{ path: 'src/shipping/quote.test.ts', line: 16, name: 'calls the carrier for every quote' }]);

  const moved = parseDiff([
    'diff --git a/a.test.ts b/a.test.ts',
    '--- a/a.test.ts',
    '+++ b/a.test.ts',
    '@@ -1,2 +1,1 @@',
    " it('stays', () => {})",
    "-it('moves to another file', () => {})",
    'diff --git a/b.test.ts b/b.test.ts',
    '--- a/b.test.ts',
    '+++ b/b.test.ts',
    '@@ -1,1 +1,2 @@',
    " it('other', () => {})",
    "+it('moves to another file', () => {})",
    'diff --git a/src/x.ts b/src/x.ts',
    '--- a/src/x.ts',
    '+++ b/src/x.ts',
    '@@ -1 +1 @@',
    "-it('not a test file', () => {})",
    "+const y = 2",
  ].join('\n'));
  assert.deepEqual(removedTests(moved), []);
});

test('removed-tests.tsv: round trip', () => {
  const tests = [{ path: 'a_test.go', line: 12, name: 'TestA' }, { path: 'b.test.ts', line: 3, name: 'with\ttab' }];
  assert.deepEqual(readRemovedTests(formatRemovedTests(tests)), tests);
});
