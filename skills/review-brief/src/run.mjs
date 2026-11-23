// Runs gh and git, with errors that say what failed.
import { spawnSync } from 'node:child_process';

export class CliError extends Error {}

export function run(cmd, args, { cwd, input, allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, input, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (r.error) {
    if (r.error.code === 'ENOENT') throw new CliError(`${cmd} is not on the PATH`);
    throw r.error;
  }
  if (r.status !== 0) {
    if (allowFail) return null;
    const detail = (r.stderr || r.stdout || '').trim();
    throw new CliError(`${cmd} ${args.filter((a) => !a.includes('\n')).join(' ')} failed${detail ? `:\n${detail}` : ''}`);
  }
  return r.stdout;
}

/** Like `run`, but also returns the stderr when it fails, so the caller decides what is a real error. */
export function tryRun(cmd, args, { cwd } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (r.error) {
    if (r.error.code === 'ENOENT') throw new CliError(`${cmd} is not on the PATH`);
    throw r.error;
  }
  return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr };
}

export const gh = (args, opts) => run('gh', args, opts);
export const ghJson = (args, opts) => JSON.parse(gh(args, opts));
export const git = (args, opts) => run('git', args, opts);

/** `gh api --paginate --jq '.[] | …'` prints one JSON per line. */
export function ghLines(args, opts) {
  const out = gh(args, opts);
  if (out === null) return null;
  return out.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line));
}
