// Opens the example page in Chromium: the charts draw with no overlap and the script has no error.
// Needs Playwright (from the visual-diff skill or PW_DIR) and network for the CDNs.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { findChromium, render } from '../src/render.mjs';
import { copyExample, tmpDir } from './helpers.mjs';

let available = true;
try {
  findChromium();
} catch {
  available = false;
}

test('render: the example draws both charts and does not go past the width', { skip: !available && 'Playwright not found', timeout: 180000 }, async () => {
  const { problems, files } = await render(copyExample(), { out: tmpDir(), shots: true });
  assert.deepEqual(problems, []);
  assert.equal(files.filter((f) => /chart-\d+\.png$/.test(f)).length, 2);
  for (const file of files) assert.ok(existsSync(file));
});
