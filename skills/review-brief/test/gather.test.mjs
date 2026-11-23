import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { gather, stripSummaryLink } from '../src/gather.mjs';
import { EXAMPLE, fakeGh, tmpDir } from './helpers.mjs';

const HEAD = '1aaf327317787de90ed2eb7bcae8a4604d99ef11';
const BASE = '3c95c6154441dc2339383ee6c8e05cb6d04a9ec3';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';

// Fake gh: answers the calls that gather makes, with the example PR.
const gh = fakeGh(`
import { readFileSync } from 'node:fs';
const EXAMPLE = ${JSON.stringify(EXAMPLE)};
const out = (value) => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value) + '\\n');
const lines = (items) => process.stdout.write(items.map((i) => JSON.stringify(i) + '\\n').join(''));
export default function (args) {
  const a = args.join(' ');
  if (a.startsWith('pr view') && a.includes('-R acme/shop')) {
    process.stderr.write('GraphQL: Could not resolve to a PullRequest with the number of 471.');
    process.exit(1);
  }
  if (a.startsWith('pr view')) return out({
    number: 482, title: 'Reuse the shipping quote for 10 minutes in checkout', url: 'https://github.com/acme/shop/pull/482',
    state: process.env.FAKE_PR_STATE || 'OPEN', isDraft: false, author: { login: 'me' }, baseRefName: 'main', headRefName: 'shipping-cache',
    headRefOid: '${HEAD}', baseRefOid: '${BASE}', additions: 184, deletions: 7, changedFiles: 6,
    body: '<!-- review-brief -->\\n> [!TIP]\\n> [Brief of this PR](https://claude.ai/artifact/x): what changes.\\n<!-- /review-brief -->\\n\\n' + readFileSync(EXAMPLE + '/description.md', 'utf8'),
  });
  if (a.startsWith('pr diff 482 -R acme/shop')) return out(readFileSync(EXAMPLE + '/full.diff', 'utf8'));
  if (a.includes('pulls/482/files')) return lines([{ additions: 11, deletions: 2, status: 'modified', filename: 'src/shipping/quote.ts', previous_filename: null }]);
  if (a.includes('compare/${BASE}...${HEAD}')) return out('${BASE}\\n');
  if (a.includes('graphql')) return out({ data: { repository: { pullRequest: { reviewThreads: {
    pageInfo: { hasNextPage: false, endCursor: null },
    nodes: [
      { path: 'src/shipping/cache.ts', line: 47, startLine: null, diffSide: 'RIGHT', isResolved: false, isOutdated: false,
        comments: { nodes: [{ author: { __typename: 'User', login: 'marina-costa', avatarUrl: '${AVATAR}' }, body: 'Are five digits enough?', url: 'https://github.com/acme/shop/pull/482#discussion_r1' }] } },
      { path: 'src/shipping/cache.ts', line: 34, startLine: null, diffSide: 'RIGHT', isResolved: false, isOutdated: false,
        comments: { nodes: [{ author: { __typename: 'Bot', login: 'coderabbitai', avatarUrl: null }, body: 'Suggestion', url: 'https://github.com/acme/shop/pull/482#discussion_r2' }] } },
      { path: 'src/shipping/quote.ts', line: 3, startLine: null, diffSide: 'LEFT', isResolved: false, isOutdated: false,
        comments: { nodes: [{ author: { __typename: 'User', login: 'ai-reviewer', avatarUrl: null }, body: 'Ok', url: 'https://github.com/acme/shop/pull/482#discussion_r3' }] } },
    ],
  } } } } });
  if (a.includes('deployments?sha=${HEAD}')) return lines([{ id: 9, environment: 'Production', production_environment: true }, { id: 7, environment: 'Preview', production_environment: false }]);
  if (a.includes('deployments/7/statuses')) return lines([{ state: 'success', environment_url: 'https://shop-git-shipping.vercel.app' }]);
  if (a.includes('deployments/9/statuses')) return lines([{ state: 'success', environment_url: 'https://shop.example.com' }]);
  if (a.includes('issues/482/comments')) return lines([]);
  if (a.startsWith('api user')) return out('me\\n');
  const content = a.match(/contents\\/(.+)\\?ref=(\\w+)/);
  if (content && a.includes('application/vnd.github.raw')) {
    const side = content[2] === '${HEAD}' ? 'head' : 'base';
    try {
      return process.stdout.write(readFileSync(EXAMPLE + '/versions/' + side + '/' + decodeURIComponent(content[1])));
    } catch {
      process.stderr.write('HTTP 404: Not Found');
      process.exit(1);
    }
  }
  process.stderr.write('fake gh: unexpected command: ' + a + '\\n');
  process.exit(1);
}
`);

let previousPath;
before(() => {
  previousPath = process.env.PATH;
  process.env.PATH = gh.env.PATH;
});
after(() => {
  process.env.PATH = previousPath;
});

test('stripSummaryLink removes only the brief block', () => {
  assert.equal(stripSummaryLink('<!-- review-brief -->\n> [!TIP]\n> link\n<!-- /review-brief -->\n\nAuthor text.\n\n'), 'Author text.');
  assert.equal(stripSummaryLink('No block.'), 'No block.');
});

test('stripSummaryLink also removes the block with the old name, resumo-pr, that older PRs have', () => {
  assert.equal(stripSummaryLink('<!-- resumo-pr -->\n> [!TIP]\n> link\n<!-- /resumo-pr -->\n\nAuthor text.\n\n'), 'Author text.');
  // The end marker must match the start marker.
  const mixed = '<!-- resumo-pr -->\nlink\n<!-- /review-brief -->\n\nAuthor text.';
  assert.equal(stripSummaryLink(mixed), mixed);
});

test('gather writes the facts of the PR', async () => {
  const out = tmpDir();
  writeFileSync(path.join(out, 'ai-authors.txt'), '# accounts that post AI text\nai-reviewer\n');
  const original = process.stdout.write;
  let printed = '';
  process.stdout.write = (chunk) => {
    printed += chunk;
    return true;
  };
  try {
    await gather({ pr: '482', out, cwd: out });
  } finally {
    process.stdout.write = original;
  }

  const facts = JSON.parse(readFileSync(path.join(out, 'facts.json'), 'utf8'));
  assert.equal(facts.repoUrl, 'https://github.com/acme/shop');
  assert.equal(facts.mergeBase, BASE);
  assert.equal(facts.isMine, true);
  assert.equal(facts.hasSummaryLink, true);
  assert.equal(facts.previewUrl, 'https://shop-git-shipping.vercel.app');

  assert.ok(readFileSync(path.join(out, 'description.md'), 'utf8').startsWith('## tl;dr'));
  assert.equal(readFileSync(path.join(out, 'removed-tests.tsv'), 'utf8'), 'src/shipping/quote.test.ts\t16\tcalls the carrier for every quote\n');
  assert.equal(readFileSync(path.join(out, 'linked-prs.tsv'), 'utf8'), 'ISSUE\tacme/shop#471\t\n');

  const threads = JSON.parse(readFileSync(path.join(out, 'threads.json'), 'utf8'));
  assert.deepEqual(threads.map((t) => [t.comments[0].author, t.side, t.startedByHuman]), [
    ['marina-costa', 'new', true],
    ['coderabbitai[bot]', 'new', false],
    ['ai-reviewer', 'old', false],
  ]);
  assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'avatars.json'), 'utf8')), { 'marina-costa': 'data:image/png;base64,iVBORw0KGgo=' });

  // Without the local clone, the versions come from the contents API.
  assert.equal(readFileSync(path.join(out, 'versions', 'head', 'src', 'shipping', 'cache.ts'), 'utf8'), readFileSync(path.join(EXAMPLE, 'versions', 'head', 'src', 'shipping', 'cache.ts'), 'utf8'));
  assert.equal(readFileSync(path.join(out, 'changed-tests.tsv'), 'utf8'), readFileSync(path.join(EXAMPLE, 'changed-tests.tsv'), 'utf8'));
  assert.match(printed, /File versions in versions\/ \(GitHub API\): 6 from the head, 3 from the merge base/);
  assert.match(printed, /Tests that the PR changes \(changed-tests\.tsv\): 5 added, 0 modified, 0 moved, 1 removed/);

  assert.match(printed, /Author: me \(you\)\. Brief link in the description: yes/);
  assert.match(printed, /\(the page must show them\): 1\n {2}src\/shipping\/cache\.ts:47 by marina-costa/);
  assert.doesNotMatch(printed, /State:/);
  assert.match(printed, /Open, started by AI \(show the ones that point out a behavior problem that is still open\): 2\n {2}src\/shipping\/cache\.ts:34 by coderabbitai\[bot\]: Suggestion/);
});

test('gather says when the PR is already closed', async () => {
  const out = tmpDir();
  const original = process.stdout.write;
  let printed = '';
  process.stdout.write = (chunk) => {
    printed += chunk;
    return true;
  };
  process.env.FAKE_PR_STATE = 'CLOSED';
  try {
    await gather({ pr: '482', out, cwd: out, versions: false });
  } finally {
    process.stdout.write = original;
    delete process.env.FAKE_PR_STATE;
  }
  assert.match(printed, /State: closed without merge\. Do not run watch or put the link in the description\./);
});
