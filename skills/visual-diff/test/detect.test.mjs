import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detect } from '../src/detect.mjs';
import { config, makeRepo, sidesFor } from './helpers.mjs';

const routesOf = (d) => d.routes.map((r) => r.path).sort();

const NEXT = {
  'package.json': JSON.stringify({ name: 'app', dependencies: { next: '15.0.0' } }),
  'tsconfig.json': '{\n  // comment\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./*"] }, },\n}\n',
  'app/layout.tsx': "import './globals.css';\nexport default function L({ children }) { return children; }\n",
  'app/globals.css': 'body { margin: 0 }\n',
  'app/page.tsx': "import Button from '@/components/Button';\nexport default () => <Button />;\n",
  'app/blog/layout.tsx': 'export default ({ children }) => children;\n',
  'app/blog/page.tsx': "import { Card } from '@/components/Card';\nexport default () => <Card />;\n",
  'app/blog/[slug]/page.tsx': "import Button from '@/components/forms/Button';\nexport default () => <Button />;\n",
  'app/contact/page.tsx': "import Button from '@/components/forms/Button';\nexport default () => <Button />;\n",
  'components/Button.tsx': 'export default () => <button>a</button>;\n',
  'components/forms/Button.tsx': 'export default () => <button>b</button>;\n',
  'components/Card/index.tsx': "export { Card } from './Card';\n",
  'components/Card/Card.tsx': 'export const Card = () => <div />;\n',
  'lib/db.ts': 'export const db = 1;\n',
};

test('DET-1: alias @/components/forms/Button finds the importers (path with "n")', () => {
  const dir = makeRepo(NEXT, { 'components/forms/Button.tsx': 'export default () => <button>c</button>;\n' });
  const d = detect(dir, config(), sidesFor(dir));
  assert.deepEqual(routesOf(d), ['/contact']);
  assert.deepEqual(d.needsExample.map((n) => n.pattern), ['/blog/[slug]']);
  assert.deepEqual(d.unmatched, []);
});

test('DET-4: equal names in different folders don\'t get mixed up', () => {
  const dir = makeRepo(NEXT, { 'components/Button.tsx': 'export default () => <button>z</button>;\n' });
  const d = detect(dir, config(), sidesFor(dir));
  assert.deepEqual(routesOf(d), ['/']);
});

test('barrel (index.tsx) leads to the right page', () => {
  const dir = makeRepo(NEXT, { 'components/Card/Card.tsx': 'export const Card = () => <section />;\n' });
  const d = detect(dir, config(), sidesFor(dir));
  assert.deepEqual(routesOf(d), ['/blog']);
});

test('DET-2: a layout covers the routes below it; root layout and global CSS cover all of them', () => {
  let dir = makeRepo(NEXT, { 'app/blog/layout.tsx': 'export default ({ children }) => <main>{children}</main>;\n' });
  let d = detect(dir, config(), sidesFor(dir));
  assert.deepEqual(routesOf(d), ['/blog']);
  assert.deepEqual(d.unmatched, []);

  dir = makeRepo(NEXT, { 'app/globals.css': 'body { margin: 4px }\n' });
  d = detect(dir, config(), sidesFor(dir));
  assert.deepEqual(routesOf(d), ['/', '/blog', '/contact']);
  assert.deepEqual(d.unmatched, []);

  dir = makeRepo(NEXT, { 'app/layout.tsx': "import './globals.css';\nexport default ({ children }) => <body>{children}</body>;\n" });
  d = detect(dir, config({ routes: ['/', '/blog'] }), sidesFor(dir));
  assert.deepEqual(routesOf(d), ['/', '/blog']);
});

test('a dynamic route uses the configured example', () => {
  const dir = makeRepo(NEXT, { 'components/forms/Button.tsx': 'export default () => <button>c</button>;\n' });
  const d = detect(dir, config({ routes: [{ path: '/blog/hello' }] }), sidesFor(dir));
  assert.deepEqual(routesOf(d), ['/blog/hello', '/contact']);
  assert.deepEqual(d.needsExample, []);
});

test('DET-5: a backend-only change is not an error: it goes to unmatchedMaybe', () => {
  const dir = makeRepo(NEXT, { 'lib/db.ts': 'export const db = 2;\n' });
  const d = detect(dir, config(), sidesFor(dir));
  assert.deepEqual(d.routes, []);
  assert.deepEqual(d.unmatched, []);
  assert.deepEqual(d.unmatchedMaybe, ['lib/db.ts']);
});

const MONO = {
  'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['apps/*', 'packages/*'] }),
  'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { next: '15', '@acme/ui': '*' }, scripts: { dev: 'next dev' } }),
  'apps/web/app/page.tsx': "import { Card } from '@acme/ui';\nexport default () => <Card />;\n",
  'apps/web/app/about/page.tsx': 'export default () => <p>about</p>;\n',
  'packages/ui/package.json': JSON.stringify({ name: '@acme/ui', exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } } }),
  'packages/ui/src/index.ts': "export { Card } from './Card';\n",
  'packages/ui/src/Card.tsx': 'export const Card = () => <div />;\n',
};

test('DET-3: a monorepo with appDir finds changes in shared packages', () => {
  const dir = makeRepo(MONO, { 'packages/ui/src/Card.tsx': 'export const Card = () => <article />;\n' });
  const d = detect(dir, config({ appDir: 'apps/web' }), sidesFor(dir));
  assert.deepEqual(d.uiFiles, ['packages/ui/src/Card.tsx']);
  assert.deepEqual(routesOf(d), ['/']);
});

test('DET-3: without appDir, nothing gets lost and there is a note suggesting appDir', () => {
  const dir = makeRepo(MONO, { 'apps/web/app/about/page.tsx': 'export default () => <p>about!</p>;\n' });
  const d = detect(dir, config(), sidesFor(dir));
  assert.deepEqual(d.routes, []);
  assert.deepEqual(d.unmatched, ['apps/web/app/about/page.tsx']);
  assert.match(d.notes.join('\n'), /appDir/);
});

const STATIC = {
  'index.html': '<link rel="stylesheet" href="styles.css"><a href="about.html">about</a>',
  'about.html': '<link rel="stylesheet" href="/styles.css">',
  'styles.css': 'body{}',
  'docs/coverage/index.html': '<p>coverage</p>',
  'emails/welcome.html': '<p>hi</p>',
};

test('DET-6: HTML only at the root/public (or in the static: folder), and a deleted page becomes removed', () => {
  const dir = makeRepo(STATIC, { 'emails/welcome.html': '<p>hello</p>', 'about.html': null, 'pricing.html': '<p>pricing</p>' });
  const d = detect(dir, config(), sidesFor(dir));
  const byPath = Object.fromEntries(d.routes.map((r) => [r.path, r.change]));
  assert.deepEqual(byPath, { '/pricing.html': 'added', '/about.html': 'removed' });
  assert.deepEqual(d.unmatched, ['emails/welcome.html']);
});

test('CSS referenced by HTML with relative and absolute paths', () => {
  const dir = makeRepo(STATIC, { 'styles.css': 'body{color:red}' });
  const d = detect(dir, config({ startCommand: 'static:.' }), sidesFor(dir));
  assert.deepEqual(routesOf(d), ['/', '/about.html']);
});
