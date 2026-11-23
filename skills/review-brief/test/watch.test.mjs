import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { changedParts, fingerprint } from '../src/watch.mjs';
import { copyExample, editJson } from './helpers.mjs';

test('watch: only the parts that the page shows count as a change', () => {
  const dir = path.dirname(copyExample());
  const before = fingerprint(dir);

  // A new AI thread does not change the page.
  editJson(path.join(dir, 'threads.json'), (threads) => {
    threads.push({ path: 'a.ts', line: 1, side: 'new', isResolved: false, isOutdated: false, startedByHuman: false, comments: [{ author: 'bot[bot]', url: 'u' }] });
  });
  assert.deepEqual(changedParts(before, fingerprint(dir)), []);

  editJson(path.join(dir, 'threads.json'), (threads) => {
    threads[0].isResolved = true;
  });
  editJson(path.join(dir, 'facts.json'), (facts) => {
    facts.headSha = 'f'.repeat(40);
  });
  assert.deepEqual(changedParts(before, fingerprint(dir)), ['head commit', 'human threads']);
});
