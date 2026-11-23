import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { normalizeConfig } from '../src/config.mjs';
import { cleanupStale, outDirOf } from '../src/pipeline.mjs';
import { findLockfile, groupAlive, inferInstallCommand, linkNodeModules, startSide, startStatic, usesTurbopack } from '../src/server.mjs';
import { freePort, isAlive, sleep } from '../src/util.mjs';
import { git, makeRepo, tmpDir } from './helpers.mjs';

const get = (port, p) =>
  new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.end();
  });

test('SRV-4: the static server refuses traversal, survives a malformed URI and redirects folders', async () => {
  const base = tmpDir('vd-static-');
  const site = path.join(base, 'site');
  mkdirSync(path.join(site, 'blog'), { recursive: true });
  mkdirSync(path.join(base, 'site-secret'));
  writeFileSync(path.join(base, 'site-secret', 'x.txt'), 'secret');
  writeFileSync(path.join(site, 'index.html'), '<p>home</p>');
  writeFileSync(path.join(site, 'blog', 'index.html'), '<p>blog</p>');
  writeFileSync(path.join(site, 'font.ttf'), 'ttf');
  const port = await freePort();
  const server = await startStatic(site, port);
  try {
    assert.notEqual((await get(port, '/..%2fsite-secret%2fx.txt')).body, 'secret');
    assert.equal((await get(port, '/%E0%A4%A')).status, 400);
    assert.equal((await get(port, '/')).status, 200, 'the server is still up');
    const dir = await get(port, '/blog');
    assert.equal(dir.status, 301);
    assert.equal(dir.headers.location, '/blog/');
    assert.equal((await get(port, '/blog/')).body, '<p>blog</p>');
    assert.equal((await get(port, '/font.ttf')).headers['content-type'], 'font/ttf');
  } finally {
    server.close();
  }
});

test('SRV-1: stop() kills the group even when sh already exited', async () => {
  const dir = makeRepo({ 'serve.mjs': "import http from 'node:http'; http.createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT));\n" });
  // sh exits right away (the server stays in the background in the same group).
  const cfg = normalizeConfig({ startCommand: 'node serve.mjs & exit 0', baseUrl: 'http://127.0.0.1:{port}', startTimeoutMs: 10_000 });
  let pgid = null;
  const srv = await startSide(dir, cfg, { name: 'head', dir }, path.join(dir, 'srv.log'), null, { onSpawn: (g) => (pgid = g) });
  assert.ok(pgid);
  assert.ok(groupAlive(pgid));
  await srv.stop();
  await sleep(200);
  assert.ok(!groupAlive(pgid), 'the background server died too');
});

test('SRV-1: cleanupStale kills servers and removes worktrees of a dead run', async () => {
  const dir = makeRepo({ 'a.txt': 'a' });
  const wt = path.join(tmpDir('visual-diff-wt-test-'), 'base');
  git(dir, 'worktree', 'add', '--detach', wt, 'HEAD');
  const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  child.unref();
  mkdirSync(outDirOf(dir), { recursive: true });
  mkdirSync(path.join(outDirOf(dir), '.run-999999'));
  writeFileSync(path.join(outDirOf(dir), 'state.json'), JSON.stringify({ pid: 999999, servers: [child.pid], worktrees: [wt] }));
  const r = cleanupStale(dir);
  await sleep(100);
  assert.deepEqual(r.killed, [child.pid]);
  assert.ok(!isAlive(child.pid));
  assert.ok(r.worktrees.includes(wt));
  assert.ok(!git(dir, 'worktree', 'list').includes(wt));
  assert.deepEqual(r.stages, ['.run-999999']);
  assert.ok(!existsSync(path.join(outDirOf(dir), 'state.json')));
  assert.ok(!existsSync(path.dirname(wt)), 'the empty temp folder goes away too');
});

test('SRV-2: lockfile at the monorepo root and inferred install command', () => {
  const dir = makeRepo({ 'pnpm-lock.yaml': 'x', 'apps/web/package.json': '{}' });
  assert.equal(findLockfile(dir, 'apps/web'), 'pnpm-lock.yaml');
  assert.equal(inferInstallCommand(dir, 'pnpm-lock.yaml'), 'pnpm install --frozen-lockfile');
  assert.equal(inferInstallCommand(dir, 'package-lock.json'), 'npm ci');
  assert.equal(usesTurbopack({ dependencies: { next: '^16.0.0' } }), true);
  assert.equal(usesTurbopack({ dependencies: { next: '15.1.0' }, scripts: { dev: 'next dev --turbopack' } }), true);
  assert.equal(usesTurbopack({ dependencies: { next: '15.1.0' }, scripts: { dev: 'next dev' } }), false);
});

test('SRV-2: a linked node_modules points workspace packages to the worktree', () => {
  const root = tmpDir('vd-mono-');
  const wt = tmpDir('vd-mono-wt-');
  mkdirSync(path.join(root, 'packages/ui'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules/react'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules/@acme'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules/.cache'), { recursive: true });
  symlinkSync('../../packages/ui', path.join(root, 'node_modules/@acme/ui'));
  mkdirSync(path.join(wt, 'packages/ui'), { recursive: true });
  linkNodeModules(path.join(root, 'node_modules'), path.join(wt, 'node_modules'), root, wt);
  assert.ok(lstatSync(path.join(wt, 'node_modules')).isDirectory() && !lstatSync(path.join(wt, 'node_modules')).isSymbolicLink(), 'real node_modules');
  assert.equal(readlinkSync(path.join(wt, 'node_modules/@acme/ui')), path.join(wt, 'packages/ui'));
  assert.ok(readlinkSync(path.join(wt, 'node_modules/react')).endsWith(path.join('node_modules', 'react')));
  assert.ok(!existsSync(path.join(wt, 'node_modules/.cache')), 'build caches stay out');
});
