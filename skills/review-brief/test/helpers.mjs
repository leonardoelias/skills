// Test utilities: the example page as a fixture and a fake `gh`.
import { chmodSync, cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(SKILL_ROOT, '..', '..');
export const EXAMPLE = path.join(REPO_ROOT, 'examples', 'review-brief');
export const CLI = path.join(SKILL_ROOT, 'bin', 'review-brief.mjs');

export function tmpDir(prefix = 'review-brief-test-') {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Copies the example to a temporary folder and returns the path of the page. */
export function copyExample() {
  const dir = tmpDir();
  cpSync(EXAMPLE, dir, { recursive: true });
  return path.join(dir, 'brief.html');
}

/** Replaces a part of the page (it must exist) and returns the path. */
export function editPage(page, from, to) {
  const html = readFileSync(page, 'utf8');
  if (!html.includes(from)) throw new Error(`part not found in the page: ${from.slice(0, 80)}`);
  writeFileSync(page, html.replace(from, to));
  return page;
}

export function editJson(file, change) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify(change(data) ?? data, null, 2));
}

/** A `gh` on the PATH that calls `handler.mjs` with the arguments and its folder. */
export function fakeGh(handlerSource) {
  const dir = tmpDir('review-brief-gh-');
  const script = path.join(dir, 'gh');
  writeFileSync(path.join(dir, 'handler.mjs'), handlerSource);
  writeFileSync(script, `#!/usr/bin/env node\nimport(${JSON.stringify(path.join(dir, 'handler.mjs'))}).then((m) => m.default(process.argv.slice(2), ${JSON.stringify(dir)}));\n`);
  chmodSync(script, 0o755);
  return { dir, env: { PATH: `${dir}${path.delimiter}${process.env.PATH}` } };
}
