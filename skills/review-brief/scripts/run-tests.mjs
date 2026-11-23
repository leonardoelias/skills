// Runs the tests with node:test, passing the files explicitly (Node 20 accepts a folder; 22+ does not).
// `node scripts/run-tests.mjs unit` skips the ones that open Chromium.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test');
const BROWSER = ['render.test.mjs'];
const unitOnly = process.argv[2] === 'unit';
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.mjs') && !(unitOnly && BROWSER.includes(f)))
  .sort()
  .map((f) => path.join(dir, f));
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
