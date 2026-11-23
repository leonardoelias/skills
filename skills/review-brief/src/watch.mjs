// Waits for the PR to change in a way that the page shows, says what changed and exits. Run it in the background:
// while the PR stays the same it prints nothing, so it only wakes the agent when the page needs an update.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { gather } from './gather.mjs';

const read = (dir, name) => {
  const file = path.join(dir, name);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

/** The parts of the PR that the page shows. AI threads are left out: the page does not show them. */
export function fingerprint(dir) {
  const facts = JSON.parse(read(dir, 'facts.json'));
  const threads = JSON.parse(read(dir, 'threads.json') || '[]');
  return {
    'head commit': facts.headSha,
    'base branch': facts.baseRef,
    title: facts.title,
    description: read(dir, 'description.md'),
    'human threads': JSON.stringify(threads.filter((t) => t.startedByHuman).map((t) => ({
      path: t.path,
      line: t.line,
      resolved: t.isResolved,
      outdated: t.isOutdated,
      comments: t.comments.map((c) => c.url),
    }))),
    'linked PRs': read(dir, 'linked-prs.tsv'),
    preview: facts.previewUrl ?? '',
  };
}

export function changedParts(before, after) {
  return Object.keys(before).filter((key) => before[key] !== after[key]);
}

export async function watch(dir, { interval = 120, cwd = process.cwd() } = {}) {
  dir = path.resolve(dir);
  const facts = JSON.parse(read(dir, 'facts.json'));
  const live = path.join(dir, '.live');
  const before = fingerprint(dir);
  const aiAuthors = read(dir, 'ai-authors.txt').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  let failures = 0;

  for (;;) {
    await sleep(interval * 1000);
    try {
      await gather({ pr: facts.url, out: live, cwd, aiAuthors, quiet: true, versions: false });
      failures = 0;
    } catch (error) {
      // A network failure does not end the watch; a failure that repeats (expired login) does.
      failures++;
      if (failures >= 5) {
        process.stdout.write(`PR #${facts.number}: gathering failed ${failures} times in a row. Last error:\n${error.message}\n`);
        return 1;
      }
      continue;
    }

    const now = JSON.parse(read(live, 'facts.json'));
    if (now.state !== 'OPEN') {
      process.stdout.write(`PR #${facts.number} is ${now.state === 'MERGED' ? 'merged' : 'closed'}. Stop watching.\n`);
      return 0;
    }
    const changed = changedParts(before, fingerprint(live));
    if (changed.length > 0) {
      process.stdout.write(`PR #${facts.number} changed: ${changed.join(', ')}. Run gather again and update the page.\n`);
      return 0;
    }
  }
}
