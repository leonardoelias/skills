import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { before, test } from 'node:test';
import { normalizeConfig } from '../src/config.mjs';
import { outDirOf } from '../src/pipeline.mjs';
import { publish, uploadAssets } from '../src/publish.mjs';
import { fakeGh, git, makeRepo, makePng, tmpDir, writePng } from './helpers.mjs';

// Fake gh: keeps PR, visibility, user and comments in a state.json.
const gh = fakeGh(`
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
export default function (args, dir) {
  const file = path.join(dir, 'state.json');
  const st = JSON.parse(readFileSync(file, 'utf8'));
  const save = () => writeFileSync(file, JSON.stringify(st));
  const out = (x) => process.stdout.write(typeof x === 'string' ? x + '\\n' : JSON.stringify(x) + '\\n');
  const a = args.join(' ');
  if (a.startsWith('pr view')) return out({ number: 7, url: 'https://github.com/acme/app/pull/7', baseRefName: 'main', headRefName: 'feature', headRefOid: st.headSha, isCrossRepository: false, state: 'OPEN', isDraft: false });
  if (a.startsWith('repo view')) return out(st.visibility);
  if (a.startsWith('api user')) return out(st.login);
  if (a.includes('--method PATCH')) {
    const id = Number(/comments\\/(\\d+)/.exec(a)[1]);
    const body = readFileSync(args[args.indexOf('-F') + 1].slice('body=@'.length), 'utf8');
    st.comments.find((c) => c.id === id).body = body; st.patched = (st.patched ?? 0) + 1; save();
    return out('https://github.com/acme/app/pull/7#issuecomment-' + id);
  }
  if (a.includes('--method POST')) {
    const body = readFileSync(args[args.indexOf('-F') + 1].slice('body=@'.length), 'utf8');
    const id = 100 + st.comments.length; st.comments.push({ id, body, user: st.login, updated_at: '2026-11-21T10:00:00Z' }); save();
    return out('https://github.com/acme/app/pull/7#issuecomment-' + id);
  }
  if (a.includes('/comments')) { for (const c of st.comments) if (c.body.includes('visual-diff:sticky')) out({ id: c.id, html_url: 'u' + c.id, body: c.body, user: c.user, updated_at: c.updated_at }); return; }
  process.stderr.write('fake gh: unexpected command: ' + a + '\\n'); process.exit(1);
}
`);
const setState = (s) => writeFileSync(path.join(gh.dir, 'state.json'), JSON.stringify({ visibility: 'PRIVATE', login: 'me', comments: [], ...s }));
before(() => {
  process.env.PATH = gh.env.PATH;
});

/** Repo with a local bare remote, a report and two images. */
function setup() {
  const remote = path.join(tmpDir('vd-remote-'), 'app.git');
  git(path.dirname(remote), 'init', '-q', '--bare', remote);
  const dir = makeRepo({ 'index.html': '<p>a</p>' }, { 'index.html': '<p>b</p>' });
  git(dir, 'remote', 'add', 'origin', remote);
  const headSha = git(dir, 'rev-parse', 'feature');
  const out = outDirOf(dir);
  mkdirSync(path.join(out, 'compare'), { recursive: true });
  writePng(path.join(out, 'compare', 'home__desktop__light.png'), makePng(20, 20, () => [255, 0, 0]));
  writePng(path.join(out, 'compare', 'home__desktop__light__focus-1.png'), makePng(10, 10, () => [0, 0, 255]));
  const report = {
    version: 2,
    runId: '20261121120000',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    sides: { pr: { number: 7 }, base: { label: 'main @ x', sha: 'x' }, head: { label: 'feature @ y', sha: headSha, workingTree: false, dirty: false } },
    stats: { captures: 1, changed: 1, unchanged: 0, failed: 0 },
    items: [{ key: 'home__desktop__light', route: '/', viewport: 'desktop', theme: 'light', status: 'changed', changed: true, kind: 'content', changedPercent: 3, compare: 'compare/home__desktop__light.png', focus: ['compare/home__desktop__light__focus-1.png'], regionsTotal: 1, shifts: [] }],
    failed: [],
    warnings: [],
    notCaptured: [],
    unmatchedFiles: [],
    variants: [],
    motion: [],
  };
  writeFileSync(path.join(out, 'report.json'), JSON.stringify(report));
  writeFileSync(path.join(out, 'summary.auto.md'), '**What changed**\n- auto\n');
  const cfg = normalizeConfig({ publish: { repo: 'acme/app', remote: 'origin' } });
  return { dir, remote, headSha, out, cfg };
}

const lsRemote = (remote) => git(remote, 'ls-tree', '-r', '--name-only', 'visual-diff-assets').split('\n').filter(Boolean);

test('PUB-5/PUB-8: a single commit, no parent, keeping other PRs\' files, with [skip ci] and the default identity', async () => {
  const { dir, remote, headSha, cfg } = setup();
  setState({ headSha });
  // Another PR already published.
  const other = makeRepo({ 'x.txt': 'x' });
  git(other, 'remote', 'add', 'origin', remote);
  uploadAssets(other, 'visual-diff-assets', () => ({ keep: [], add: [{ path: 'pr-3/1/a.png', file: path.join(other, 'x.txt') }], message: 'other' }));

  const env = { ...process.env };
  // No git identity (like in CI): commit-tree uses the default.
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  try {
    const r = await publish(dir, cfg, { pr: 7 });
    assert.equal(r.posted, true);
    assert.equal(r.commentAction, 'created');
  } finally {
    process.env = env;
  }
  const files = lsRemote(remote);
  assert.deepEqual(files.sort(), ['pr-3/1/a.png', 'pr-7/20261121120000/home__desktop__light.png', 'pr-7/20261121120000/home__desktop__light__focus-1.png']);
  assert.equal(git(remote, 'rev-list', '--count', 'visual-diff-assets'), '1');
  assert.match(git(remote, 'log', '-1', '--format=%s %an', 'visual-diff-assets'), /\[skip ci\]/);
  // The comment points to the assets branch.
  const body = readFileSync(path.join(outDirOf(dir), 'comment.md'), 'utf8');
  assert.match(body, /https:\/\/github\.com\/acme\/app\/raw\/visual-diff-assets\/pr-7\/20261121120000\/home__desktop__light__focus-1\.png/);
});

test('PUB-5: a concurrent publish breaks the lease and the retry keeps both', () => {
  const { dir, remote } = setup();
  const rival = makeRepo({ 'r.txt': 'r' });
  git(rival, 'remote', 'add', 'origin', remote);
  let attempts = 0;
  uploadAssets(dir, 'visual-diff-assets', (tree) => {
    attempts++;
    if (attempts === 1) uploadAssets(rival, 'visual-diff-assets', () => ({ keep: [], add: [{ path: 'pr-9/1/r.png', file: path.join(rival, 'r.txt') }], message: 'rival' }));
    return { keep: tree.filter((e) => !e.path.startsWith('pr-7/')), add: [{ path: 'pr-7/1/a.png', file: path.join(dir, 'index.html') }], message: 'mine' };
  });
  assert.equal(attempts, 2);
  assert.deepEqual(lsRemote(remote).sort(), ['pr-7/1/a.png', 'pr-9/1/r.png']);
});

test('PUB-2: a summary.md older than the report blocks', async () => {
  const { dir, headSha, out, cfg } = setup();
  setState({ headSha });
  writeFileSync(path.join(out, 'summary.md'), 'summary from another PR');
  const old = new Date(Date.now() - 3600_000);
  utimesSync(path.join(out, 'summary.md'), old, old);
  const r = await publish(dir, cfg, { pr: 7, dryRun: true });
  assert.equal(r.publishable, false);
  assert.match(r.problems.join('\n'), /\[blocking\].*summary\.md predates/);
  // Without summary.md: doesn't block, only warns.
  const { dir: d2, headSha: h2, cfg: c2 } = setup();
  setState({ headSha: h2 });
  const r2 = await publish(d2, c2, { pr: 7, dryRun: true });
  assert.equal(r2.publishable, true);
  assert.match(r2.problems.join('\n'), /automatic summary/);
});

test('PUB-3: a report from another head blocks; --force-stale publishes with a warning', async () => {
  const { dir, cfg } = setup();
  setState({ headSha: 'f'.repeat(40) });
  const r = await publish(dir, cfg, { pr: 7, dryRun: true });
  assert.equal(r.publishable, false);
  assert.match(r.problems.join('\n'), /the report is from/);
  const forced = await publish(dir, cfg, { pr: 7, dryRun: true, forceStale: true });
  assert.equal(forced.publishable, true);
  assert.match(readFileSync(path.join(outDirOf(dir), 'comment.md'), 'utf8'), /run before the PR's latest commit/);
});

test('PUB-3: a working tree with local changes blocks', async () => {
  const { dir, headSha, out, cfg } = setup();
  setState({ headSha });
  const rep = JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8'));
  rep.sides.head.workingTree = true;
  rep.sides.head.dirty = true;
  writeFileSync(path.join(out, 'report.json'), JSON.stringify(rep));
  const r = await publish(dir, cfg, { pr: 7, dryRun: true });
  assert.match(r.problems.join('\n'), /local changes/);
});

test('PUB-7: INTERNAL and PUBLIC repositories require confirmation', async () => {
  const { dir, headSha, cfg } = setup();
  setState({ headSha, visibility: 'INTERNAL' });
  assert.equal((await publish(dir, cfg, { pr: 7, dryRun: true })).publishable, false);
  assert.equal((await publish(dir, cfg, { pr: 7, dryRun: true, allowInternalRepo: true })).publishable, true);
  setState({ headSha, visibility: 'PUBLIC' });
  assert.equal((await publish(dir, cfg, { pr: 7, dryRun: true })).publishable, false);
});

test('PUB-4: doesn\'t edit someone else\'s comment; edits its own', async () => {
  const { dir, headSha, cfg } = setup();
  setState({ headSha, comments: [{ id: 1, body: '<!-- visual-diff:sticky id=default --> old', user: 'github-actions[bot]', updated_at: '2026-11-20T00:00:00Z' }] });
  const r = await publish(dir, cfg, { pr: 7, noUpload: true });
  assert.equal(r.commentAction, 'created');
  assert.match(r.warning, /github-actions\[bot\]/);
  const r2 = await publish(dir, cfg, { pr: 7, noUpload: true });
  assert.equal(r2.commentAction, 'unchanged');
  writeFileSync(path.join(outDirOf(dir), 'summary.md'), 'new summary');
  const r3 = await publish(dir, cfg, { pr: 7, noUpload: true });
  assert.equal(r3.commentAction, 'updated');
  const st = JSON.parse(readFileSync(path.join(gh.dir, 'state.json'), 'utf8'));
  assert.equal(st.comments.find((c) => c.id === 1).body, '<!-- visual-diff:sticky id=default --> old', "the bot's comment stayed intact");
});
