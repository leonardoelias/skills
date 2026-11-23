// Test utilities: throwaway git repositories, synthetic PNGs and a fake `gh`.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { normalizeConfig } from '../src/config.mjs';

export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(SKILL_ROOT, '..', '..');
export const CLI = path.join(SKILL_ROOT, 'bin', 'visual-diff.mjs');

export const GIT_ENV = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

export function tmpDir(prefix = 'vd-test-') {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    if (content === null) {
      rmSync(full, { force: true });
      continue;
    }
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

/** Creates a repo with `base` committed on main and `head` committed on feature. */
export function makeRepo(base, head = null) {
  const dir = tmpDir();
  git(dir, 'init', '-q', '-b', 'main');
  writeFiles(dir, base);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  if (head) {
    git(dir, 'checkout', '-qb', 'feature');
    writeFiles(dir, head);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'head');
  }
  return dir;
}

export function sidesFor(dir, base = 'main', head = 'feature') {
  const sha = (ref) => git(dir, 'rev-parse', ref);
  return {
    pr: null,
    base: { ref: base, sha: sha(base), label: base },
    head: { ref: head, sha: sha(head), workingTree: false, dirty: false, label: head },
  };
}

export const config = (user = {}) => normalizeConfig(user);

/** PNG built pixel by pixel: colorAt(x, y) returns the [r,g,b] color of each pixel. */
export function makePng(width, height, colorAt) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colorAt(x, y);
      const i = (y * width + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  return png;
}

export function writePng(file, png) {
  writeFileSync(file, PNG.sync.write(png));
  return file;
}

/**
 * Installs a fake `gh` on the PATH. handler is a Node script that receives the arguments and a JSON "state"
 * (state.json file in the same folder), and prints the response.
 */
export function fakeGh(handlerSource) {
  const dir = tmpDir('vd-gh-');
  const script = path.join(dir, 'gh');
  writeFileSync(path.join(dir, 'handler.mjs'), handlerSource);
  writeFileSync(script, `#!/usr/bin/env node\nimport(${JSON.stringify(path.join(dir, 'handler.mjs'))}).then((m) => m.default(process.argv.slice(2), ${JSON.stringify(dir)}));\n`);
  chmodSync(script, 0o755);
  return { dir, env: { PATH: `${dir}${path.delimiter}${process.env.PATH}` } };
}
