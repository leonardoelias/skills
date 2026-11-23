// Integration with Chromium on examples/sample-site. Takes ~1 min.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { CLI, git, makeRepo, REPO_ROOT } from './helpers.mjs';

const SAMPLE = path.join(REPO_ROOT, 'examples', 'sample-site');
const sampleFiles = () => Object.fromEntries(readdirSync(SAMPLE).map((f) => [f, readFileSync(path.join(SAMPLE, f), 'utf8')]));
const css = sampleFiles()['styles.css'];

function cli(dir, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', timeout: 240_000 });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {}
  return { code: r.status, json, stderr: r.stderr };
}

test('base equal to head: no difference', () => {
  const dir = makeRepo(sampleFiles());
  const r = cli(dir, 'run', '--base', 'main', '--head', 'main', '--routes', '/,/about.html');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.stats.captures, 8);
  assert.equal(r.json.stats.changed, 0);
  assert.equal(r.json.stats.layoutOnly, 0);
});

test('button change: 4 changed captures, crops generated, --only and diff reuse them', () => {
  const dir = makeRepo(sampleFiles(), { 'styles.css': css.replace('padding: 8px 14px; border-radius: 4px;', 'padding: 10px 18px; border-radius: 8px;') });
  const r = cli(dir, 'run', '--base', 'main', '--head', 'feature');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.stats.changed, 4);
  assert.deepEqual(r.json.changed.map((c) => c.key).sort(), ['home__desktop__dark', 'home__desktop__light', 'home__mobile__dark', 'home__mobile__light']);
  for (const c of r.json.changed) {
    assert.equal(c.kind, 'content');
    assert.ok(c.focus.length >= 1);
    assert.ok(existsSync(path.join(dir, c.compare)));
  }
  assert.ok(!git(dir, 'worktree', 'list').includes('visual-diff-wt'), 'worktrees removed');

  // --only recaptures one key and keeps the rest of the report.
  const only = cli(dir, 'run', '--base', 'main', '--head', 'feature', '--only', 'home__desktop__light');
  assert.equal(only.code, 0, only.stderr);
  assert.equal(only.json.stats.captures, 8);
  assert.equal(only.json.stats.changed, 4);

  // diff redoes only the images.
  const rd = cli(dir, 'diff');
  assert.equal(rd.code, 0, rd.stderr);
  assert.equal(rd.json.stats.changed, 4);
});

test('RTE-1: a new page becomes an "added" item instead of aborting', () => {
  const files = sampleFiles();
  const dir = makeRepo(files, { 'pricing.html': files['about.html'].replace(/<main>[\s\S]*<\/main>/, '<main><h1>Pricing</h1><p>$10</p></main>') });
  const r = cli(dir, 'run', '--base', 'main', '--head', 'feature', '--viewports', 'desktop', '--themes', 'light');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.stats.added, 1);
  assert.equal(r.json.added[0].key, 'pricing-html__desktop__light');
});

test('DIF-2: a margin-only change comes out as layout-shift, not as "no difference"', () => {
  const dir = makeRepo(sampleFiles(), { 'styles.css': css.replace('margin: 48px 0;', 'margin: 72px 0;') });
  const r = cli(dir, 'run', '--base', 'main', '--head', 'feature', '--routes', '/', '--themes', 'light');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.stats.unchanged, 0);
  for (const c of r.json.changed) {
    assert.equal(c.kind, 'layout-shift', JSON.stringify(c));
    assert.ok(c.shifts.some((s) => s.byCss === 24), JSON.stringify(c.shifts));
  }
  const summary = readFileSync(path.join(dir, '.visual-diff', 'summary.auto.md'), 'utf8');
  assert.match(summary, /moved down 24px/);
});

test('ORIG-1/3/4/5: variants, a11y, motion GIF and tokens in a single run', () => {
  const files = sampleFiles();
  files['index.html'] = files['index.html'].replace('<h1>', '<h1 class="t">').replace('</head>', '<script>const v=new URLSearchParams(location.search).get("v");if(v)document.documentElement.dataset.v=v;</script><style>[data-v="2"] .hero h1{color:#b91c1c}</style></head>');
  const dir = makeRepo(files, {
    'styles.css': css.replace('.btn { background: var(--brand);', '.btn { transition: transform .6s; animation: pulse 1s infinite alternate; background: #e11d48;') + '\n@keyframes pulse { to { transform: scale(1.15); } }\n',
    'index.html': files['index.html'].replace('placeholder="you@company.com">', 'placeholder="you@company.com"><img src="x.png">'),
  });
  const cfg = JSON.parse(files['visual-diff.config.json']);
  cfg.audits = { a11y: true, tokens: true, motion: true };
  cfg.motion = { durationMs: 1200, fps: 8 };
  cfg.themes = ['light'];
  cfg.viewports = ['desktop'];
  writeFileSync(path.join(dir, 'visual-diff.config.json'), JSON.stringify(cfg));
  const r = cli(dir, 'run', '--base', 'main', '--head', 'feature', '--routes', '/', '--variants', '/:v=1..2', '--json', 'full');
  assert.equal(r.code, 0, r.stderr);
  const item = r.json.items.find((i) => i.key === 'home__desktop__light');
  assert.ok(item.changed);
  assert.ok(item.a11y.added.some((v) => v.id === 'image-alt'), JSON.stringify(item.a11y));
  assert.ok(item.tokens?.some((f) => f.kind === 'color'), JSON.stringify(item.tokens));
  assert.equal(r.json.variants.length, 1);
  assert.ok(existsSync(path.join(dir, '.visual-diff', r.json.variants[0].file)));
  assert.equal(r.json.motion.length, 1);
  assert.ok(readFileSync(path.join(dir, '.visual-diff', r.json.motion[0].file)).subarray(0, 6).toString() === 'GIF89a');
  assert.equal(r.json.motion[0].changed, true);
  const preview = cli(dir, 'render');
  assert.equal(preview.code, 0);
  const md = readFileSync(path.join(dir, '.visual-diff', 'comment.preview.md'), 'utf8');
  assert.match(md, /### Motion/);
  assert.match(md, /### Variants of `v`/);
  assert.match(md, /Accessibility \(axe\)/);
});

test('SRV-1: a run killed with SIGKILL leaves worktrees; the next run (or cleanup) cleans up', async () => {
  const dir = makeRepo(sampleFiles(), { 'styles.css': css.replace('gap: 16px; margin-top: 20px;', 'gap: 24px; margin-top: 20px;') });
  const child = spawn(process.execPath, [CLI, 'run', '--base', 'main', '--head', 'feature'], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
  await new Promise((resolve) => {
    child.stderr.on('data', (d) => {
      if (String(d).includes('base:')) resolve();
    });
    child.on('exit', resolve);
  });
  child.kill('SIGKILL');
  await new Promise((r) => child.on('exit', r));
  assert.ok(git(dir, 'worktree', 'list').includes('visual-diff-wt'), 'worktrees were left over');
  const c = cli(dir, 'cleanup');
  assert.equal(c.code, 0);
  assert.ok(c.json.worktrees.length >= 2);
  assert.ok(!git(dir, 'worktree', 'list').includes('visual-diff-wt'));
});
