// The versions of the files that the PR changes: the head in versions/head/<path> and the merge base in
// versions/base/<path>. check verifies the page's code, tests and threads against them, and the agent reads the
// code from them.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { run } from './run.mjs';

export const VERSIONS_DIR = 'versions';
const MAX_FILES = 600;

export function versionPath(dir, side, file) {
  const root = path.resolve(dir, VERSIONS_DIR, side);
  const full = path.resolve(root, file);
  if (!full.startsWith(root + path.sep)) throw new Error(`path outside the versions folder: ${file}`);
  return full;
}

export const hasVersions = (dir) => existsSync(path.join(dir, VERSIONS_DIR));

/** The text of the file on that side ('head' or 'base'), or null when it was not saved (binary, too large, failed). */
export function readVersion(dir, side, file) {
  if (!file) return null;
  try {
    return readFileSync(versionPath(dir, side, file), 'utf8');
  } catch {
    return null;
  }
}

function execBuffer(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 }, (error, stdout) => {
      resolve({ ok: !error, stdout });
    });
  });
}

async function pool(items, size, work) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

const hasCommit = (cwd, sha) => Boolean(sha) && run('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd, allowFail: true }) !== null;

/**
 * Saves the head and the merge base of each text file of the diff. Uses the local clone when it has both commits
 * (fast), otherwise the GitHub contents API.
 */
export async function fetchVersions({ out, diffFiles, headSha, baseSha, host, owner, name, cwd }) {
  rmSync(path.join(out, VERSIONS_DIR), { recursive: true, force: true });
  const wanted = [];
  for (const f of diffFiles) {
    if (f.binary) continue;
    if (f.newPath) wanted.push({ side: 'head', sha: headSha, file: f.newPath });
    if (f.oldPath && baseSha) wanted.push({ side: 'base', sha: baseSha, file: f.oldPath });
  }
  const skipped = wanted.splice(MAX_FILES).length;

  const local = hasCommit(cwd, headSha) && (!baseSha || hasCommit(cwd, baseSha));
  const api = host === 'github.com' ? ['api'] : ['api', '--hostname', host];
  const counts = { head: 0, base: 0 };
  const failed = [];

  await pool(wanted, local ? 4 : 8, async (w) => {
    const encoded = w.file.split('/').map(encodeURIComponent).join('/');
    const r = local
      ? await execBuffer('git', ['show', `${w.sha}:${w.file}`], cwd)
      : await execBuffer('gh', [...api, '-H', 'Accept: application/vnd.github.raw', `repos/${owner}/${name}/contents/${encoded}?ref=${w.sha}`], cwd);
    // A null byte means a binary file: there is nothing to check.
    if (!r.ok || r.stdout.includes(0)) {
      failed.push(`${w.side}:${w.file}`);
      return;
    }
    const target = versionPath(out, w.side, w.file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, r.stdout);
    counts[w.side]++;
  });

  return { source: local ? 'local git' : 'GitHub API', ...counts, failed, skipped };
}
