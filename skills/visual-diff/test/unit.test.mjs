import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseArgs } from '../src/cli.mjs';
import { dynamicMatcher, fileToRoute, fileToScope, normalizeConfig, parseVariantValues, parseViewports } from '../src/config.mjs';
import { parseRemoteUrl } from '../src/git.mjs';
import { autoSummary, COMMENT_LIMIT, renderComment, renderCommentFitting } from '../src/markdown.mjs';
import { parseVariantsOpt } from '../src/pipeline.mjs';
import { CONFIG_SCHEMA, validateConfig } from '../src/schema.mjs';
import { globToRegExp, redact, registerSecret, routeSlug, stripJsonComments, suggest } from '../src/util.mjs';
import { CLI, makeRepo, SKILL_ROOT } from './helpers.mjs';

test('globToRegExp', () => {
  assert.ok(globToRegExp('src/**/*.css').test('src/a/b/c.css'));
  assert.ok(globToRegExp('src/**/*.css').test('src/c.css'));
  assert.ok(!globToRegExp('src/*.css').test('src/a/c.css'));
  assert.ok(globToRegExp('tailwind.config.{js,ts}').test('tailwind.config.ts'));
  assert.ok(globToRegExp('src/styles').test('src/styles/x/y.css'), 'a folder matches its contents');
});

test('fileToScope: framework conventions', () => {
  assert.deepEqual(fileToScope('app/(marketing)/pricing/page.tsx'), { kind: 'page', route: '/pricing' });
  assert.deepEqual(fileToScope('src/app/layout.tsx'), { kind: 'global' });
  assert.deepEqual(fileToScope('app/blog/layout.tsx'), { kind: 'layout', prefix: '/blog' });
  assert.deepEqual(fileToScope('app/blog/loading.tsx'), { kind: 'aux', prefix: '/blog' });
  assert.equal(fileToScope('app/_components/x/page.tsx'), null, 'private folder');
  assert.deepEqual(fileToScope('pages/_app.tsx'), { kind: 'global' });
  assert.deepEqual(fileToScope('pages/blog/index.tsx'), { kind: 'page', route: '/blog' });
  assert.equal(fileToScope('pages/api/x.ts'), null);
  assert.deepEqual(fileToScope('src/routes/(app)/account/+page.svelte'), { kind: 'page', route: '/account' });
  assert.deepEqual(fileToScope('src/routes/+layout.svelte'), { kind: 'global' });
  assert.deepEqual(fileToScope('src/pages/about.astro'), { kind: 'page', route: '/about' });
  assert.deepEqual(fileToScope('pages/products/[id].vue'), { kind: 'page', route: '/products/[id]' });
  assert.deepEqual(fileToScope('app/routes/blog.$slug.tsx'), { kind: 'page', route: '/blog/$slug' });
  assert.deepEqual(fileToScope('app/routes/_index.tsx'), { kind: 'page', route: '/' });
  assert.equal(fileToRoute('docs/coverage/index.html'), null, 'DET-6: HTML outside the root/public');
  assert.equal(fileToRoute('index.html'), '/');
  assert.equal(fileToRoute('public/help/index.html'), '/help/');
  assert.equal(fileToRoute('site/a.html', { staticDir: 'site' }), '/a.html');
  assert.equal(fileToRoute('dist/index.html', { staticDir: '.' }), null);
});

test('dynamicMatcher', () => {
  assert.ok(dynamicMatcher('/blog/[slug]').test('/blog/hello'));
  assert.ok(!dynamicMatcher('/blog/[slug]').test('/blog/a/b'));
  assert.ok(dynamicMatcher('/docs/[...path]').test('/docs/a/b'));
  assert.ok(dynamicMatcher('/shop/[[...f]]').test('/shop'));
  assert.ok(dynamicMatcher('/blog/$slug').test('/blog/x'));
});

test('parseViewports and routeSlug', () => {
  assert.deepEqual(parseViewports('desktop,tablet:600x900@2').map((v) => [v.name, v.width, v.deviceScaleFactor]), [['desktop', 1280, 1], ['tablet', 600, 2]]);
  assert.throws(() => parseViewports('phone'), /unknown/);
  assert.equal(routeSlug('/'), 'home');
  assert.equal(routeSlug('/blog/Hello/'), 'blog-hello');
  assert.equal(routeSlug('/search?q=test'), 'search--q-test');
});

test('ORIG-1: variant values', () => {
  assert.deepEqual(parseVariantValues('1..4'), ['1', '2', '3', '4']);
  assert.deepEqual(parseVariantValues(['a', 2]), ['a', '2']);
  assert.throws(() => parseVariantValues('1..20'), /maximum is 12/);
  assert.deepEqual(parseVariantsOpt('/:hero=1..2;/pricing:plan=a,b'), [
    { route: '/', param: 'hero', values: ['1', '2'] },
    { route: '/pricing', param: 'plan', values: ['a', 'b'] },
  ]);
});

test('SKL-3: parseArgs refuses an unknown option and suggests the right one', () => {
  assert.throws(() => parseArgs(['run', '--viewport', 'mobile']), /did you mean --viewports/);
  assert.throws(() => parseArgs(['publsh']), /did you mean "publish"/);
  assert.equal(parseArgs(['publish', '--dry-run=false']).opts.dryRun, false);
  assert.equal(parseArgs(['publish', '--dry-run']).opts.dryRun, true);
  assert.throws(() => parseArgs(['publish', '--dry-run=yes']), /takes no value/);
  assert.throws(() => parseArgs(['run', '--pr', 'abc']), /number/);
  assert.throws(() => parseArgs(['detect', '--only', 'x']), /unknown option/);
  assert.deepEqual(parseArgs(['run', '--routes=/,/a', '--base-url', 'http://x']).opts, { routes: '/,/a', baseUrl: 'http://x' });
});

test('SKL-3: config with a wrong key is refused with a suggestion', () => {
  const errs = validateConfig({ captures: {}, capture: { fullpage: true }, viewports: ['desktop', { name: 'x', width: 'a' }], auth: { headers: { a: 'literal' } } });
  const text = errs.join('\n');
  assert.match(text, /captures: unknown key \(did you mean "capture"\?\)/);
  assert.match(text, /capture\.fullpage: unknown key \(did you mean "fullPage"\?\)/);
  assert.match(text, /viewports\[1\]\.width: expected number/);
  assert.match(text, /auth\.headers\.a/);
  assert.deepEqual(validateConfig({ $schema: './x.json', routes: ['/', { path: '/a', variants: { param: 'v', values: '1..3' } }] }), []);
});

test('the published schema is in sync with src/schema.mjs', () => {
  const file = JSON.parse(readFileSync(path.join(SKILL_ROOT, 'visual-diff.schema.json'), 'utf8'));
  assert.deepEqual(file, JSON.parse(JSON.stringify(CONFIG_SCHEMA)), 'run `npm run schema`');
});

test('stripJsonComments and parseRemoteUrl', () => {
  assert.deepEqual(JSON.parse(stripJsonComments('{ // a\n "x": "//not", /* b */ "y": [1,], }')), { x: '//not', y: [1] });
  assert.deepEqual(parseRemoteUrl('git@github.com:acme/app.git'), { host: 'github.com', owner: 'acme', repo: 'app', slug: 'acme/app' });
  assert.deepEqual(parseRemoteUrl('https://ghe.company.com/team/site'), { host: 'ghe.company.com', owner: 'team', repo: 'site', slug: 'team/site' });
  assert.equal(suggest('viewport', ['viewports', 'themes']), 'viewports');
});

test('CAP-3: registered secrets disappear from text', () => {
  registerSecret('s3cr3t-value');
  assert.equal(redact('error with s3cr3t-value in the middle'), 'error with *** in the middle');
});

const report = (items, extra = {}) => ({
  runId: '20261121000000',
  createdAt: '2026-11-21T00:00:00.000Z',
  sides: { pr: null, base: { label: 'main @ 1', sha: '1' }, head: { label: 'feat @ 2', sha: '2' } },
  stats: { captures: items.length, changed: items.filter((i) => i.changed && i.status === 'changed').length, unchanged: items.filter((i) => !i.changed).length, failed: 0, added: items.filter((i) => i.status === 'added').length, removed: 0 },
  items,
  failed: [],
  warnings: [],
  notCaptured: [],
  unmatchedFiles: [],
  unmatchedMaybe: [],
  variants: [],
  motion: [],
  ...extra,
});
const item = (o) => ({ key: 'home__mobile__light', route: '/', viewport: 'mobile', theme: 'light', status: 'changed', changed: true, kind: 'content', changedPercent: 1, shifts: [], focus: ['compare/a__focus-1.png'], compare: 'compare/a.jpg', regionsTotal: 1, ...o });

test('DIF-2: autoSummary describes spacing only and doesn\'t say "only changed in desktop"', () => {
  const r = report([
    item({ viewport: 'desktop', key: 'home__desktop__light', changedPercent: 2 }),
    item({ kind: 'layout-shift', changedPercent: 0, shifts: [{ fromYCss: 420, toYCss: 900, byCss: 24 }], heightDeltaCss: 48 }),
  ]);
  const s = autoSummary(r);
  assert.match(s, /spacing only \(the content below y≈420px moved down 24px\)/);
  assert.doesNotMatch(s, /only changed in/);
  const c = renderComment(r, s, { link: (p) => p });
  assert.match(c, /spacing only — the content below y≈420px moved down 24px/);
});

test('RTE-1: the comment has the new pages section', () => {
  const r = report([item({ status: 'added', kind: 'added', route: '/pricing', focus: [] })]);
  const c = renderComment(r, 'x', { link: (p) => `https://x/${p}` });
  assert.match(c, /### New pages/);
  assert.match(c, /1 new page\(s\)/);
});

test('PUB-8: a huge comment drops a tier and fits GitHub\'s limit', () => {
  const many = Array.from({ length: 400 }, (_, i) => item({ key: `r${i}__mobile__light`, route: `/route-${i}`, focus: ['compare/a__focus-1.png', 'compare/a__focus-2.png', 'compare/a__focus-3.png'] }));
  const r = report(many);
  const { body, tier } = renderCommentFitting(r, 'summary', { link: (p) => `https://github.com/acme/app/raw/visual-diff-assets/pr-1/20261121000000/${p}` });
  assert.ok(body.length <= COMMENT_LIMIT, `size ${body.length}`);
  assert.ok(tier > 0);
});

test('CLI: a wrong option exits with code 1 and a suggestion', () => {
  const dir = makeRepo({ 'index.html': '<p>hi</p>' });
  const r = spawnSync(process.execPath, [CLI, 'run', '--viewport', 'mobile'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error, /--viewports/);
  const cfgBad = spawnSync(process.execPath, [CLI, 'doctor'], { cwd: dir, encoding: 'utf8' });
  assert.equal(JSON.parse(cfgBad.stdout).ok, true);
  execFileSync('sh', ['-c', `echo '{"captures":{}}' > visual-diff.config.json`], { cwd: dir });
  const doc = JSON.parse(spawnSync(process.execPath, [CLI, 'doctor'], { cwd: dir, encoding: 'utf8' }).stdout);
  assert.equal(doc.ok, false);
  assert.match(doc.checks.find((c) => c.name === 'config').detail, /capture/);
  assert.deepEqual(normalizeConfig({}).capture.locale, 'en-US', 'CAP-1: default locale');
});

test('SKL-6: init in a monorepo picks the main app and sets appDir', async () => {
  const { suggestConfig } = await import('../src/config.mjs');
  const dir = makeRepo({
    'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['apps/*', 'packages/*'] }),
    'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { next: '15' }, scripts: { dev: 'next dev' } }),
    'apps/web/app/page.tsx': 'x',
    'apps/web/app/about/page.tsx': 'x',
    'apps/docs/package.json': JSON.stringify({ name: 'docs', dependencies: { astro: '4' }, scripts: { dev: 'astro dev' } }),
  });
  const { config, notes } = suggestConfig(dir);
  assert.equal(config.appDir, 'apps/web');
  assert.equal(config.startCommand, 'npm run dev -- -p {port}');
  assert.deepEqual(config.routes.map((r) => r.path), ['/', '/about']);
  assert.match(notes.join('\n'), /apps\/docs/);
  assert.deepEqual(validateConfig(config), []);
});
