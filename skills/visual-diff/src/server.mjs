import { spawn } from 'node:child_process';
import { createReadStream, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { CliError, freePort, killGroup, log, shAsync, sleep } from './util.mjs';
import { frameworkOf } from './workspace.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.pdf': 'application/pdf',
  '.webmanifest': 'application/manifest+json',
};

/** Built-in static server, used with startCommand "static:<folder>". */
export function startStatic(dir, port, host = '127.0.0.1') {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      return res.writeHead(400, { 'content-type': 'text/plain' }).end('bad request');
    }
    if (pathname.includes('\0')) return res.writeHead(400).end();
    let file = path.join(root, pathname);
    const inside = path.relative(root, file);
    if (inside.startsWith('..') || path.isAbsolute(inside)) return res.writeHead(403).end();
    try {
      if (existsSync(file) && statSync(file).isDirectory()) {
        // /folder → /folder/ so the page's relative links work.
        if (!pathname.endsWith('/')) {
          const u = new URL(req.url, 'http://x');
          return res.writeHead(301, { location: `${u.pathname}/${u.search}` }).end();
        }
        file = path.join(file, 'index.html');
      }
      if (!existsSync(file) && existsSync(file + '.html')) file += '.html';
      if (!existsSync(file) || !statSync(file).isFile()) return res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      createReadStream(file).on('error', () => res.destroy()).pipe(res);
    } catch {
      res.writeHead(500).end();
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

const LOCKFILES = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json'];

/** Lockfile nearest to the app, going up to the checkout root. Returns the path relative to the root. */
export function findLockfile(checkoutRoot, appDir) {
  let dir = appDir === '.' ? '' : appDir;
  for (;;) {
    for (const l of LOCKFILES) {
      const rel = dir ? `${dir}/${l}` : l;
      if (existsSync(path.join(checkoutRoot, rel))) return rel;
    }
    if (!dir) return null;
    dir = path.posix.dirname(dir) === '.' ? '' : path.posix.dirname(dir);
  }
}

/** Install command inferred from the lockfile (without changing the lockfile). */
export function inferInstallCommand(checkoutRoot, lockRel) {
  if (!lockRel) return null;
  const name = path.basename(lockRel);
  if (name === 'pnpm-lock.yaml') return 'pnpm install --frozen-lockfile';
  if (name === 'yarn.lock') return existsSync(path.join(checkoutRoot, path.dirname(lockRel), '.yarnrc.yml')) ? 'yarn install --immutable' : 'yarn install --frozen-lockfile';
  if (name.startsWith('bun.')) return 'bun install --frozen-lockfile';
  return 'npm ci';
}

/** Next with Turbopack (default from 16 on, or --turbo/--turbopack in the script) doesn't accept a linked node_modules. */
export function usesTurbopack(pkg, startCommand = '') {
  if (frameworkOf(pkg) !== 'next') return false;
  const scripts = Object.values(pkg.scripts ?? {}).join(' ') + ' ' + startCommand;
  if (/--turbo(pack)?\b/.test(scripts)) return true;
  if (/--webpack\b/.test(scripts)) return false;
  const v = /(\d+)/.exec(String(pkg.dependencies?.next ?? pkg.devDependencies?.next ?? ''));
  return v ? Number(v[1]) >= 16 : false;
}

const SKIP_NM = new Set(['.cache', '.vite', '.vite-temp', '.next', '.turbo', '.astro', '.svelte-kit', '.package-lock.json', '.modules.yaml']);

/**
 * Creates a real node_modules in the worktree whose entries are links to the main checkout's.
 * Workspace packages (links that point inside the repository) are repointed to the
 * matching folder in the worktree, so each side uses its own version of the shared package.
 */
export function linkNodeModules(mainNm, wtNm, root, wt) {
  if (!existsSync(mainNm) || existsSync(wtNm)) return 0;
  const realRoot = realpathSync(root);
  mkdirSync(wtNm, { recursive: true });
  let n = 0;
  const linkEntry = (src, dest) => {
    let target = src;
    const st = lstatSync(src);
    if (st.isSymbolicLink()) {
      const resolved = path.resolve(path.dirname(src), readlinkSync(src));
      let real = resolved;
      try {
        real = realpathSync(resolved);
      } catch {}
      const insideRepo = path.relative(realRoot, real);
      if (!insideRepo.startsWith('..') && !path.isAbsolute(insideRepo) && !insideRepo.split(path.sep).includes('node_modules')) {
        target = path.join(wt, insideRepo); // workspace package: use the worktree's copy
      } else target = real;
    }
    symlinkSync(target, dest, 'dir');
    n++;
  };
  for (const e of readdirSync(mainNm)) {
    if (SKIP_NM.has(e)) continue;
    const src = path.join(mainNm, e);
    if (e.startsWith('@') && lstatSync(src).isDirectory() && !lstatSync(src).isSymbolicLink()) {
      mkdirSync(path.join(wtNm, e), { recursive: true });
      for (const s of readdirSync(src)) linkEntry(path.join(src, s), path.join(wtNm, e, s));
    } else linkEntry(src, path.join(wtNm, e));
  }
  return n;
}

/**
 * Dependencies for one side. deps: 'link' always links; 'install' always installs; 'auto' links, and installs
 * when the lockfile differs from the main checkout or the app is Next (Turbopack refuses a node_modules
 * with links pointing outside the project). Returns { mode, installCommand, warning }.
 */
export async function prepareDeps(root, wt, cfg, logFile, { force } = {}) {
  const appRoot = path.join(root, cfg.appDir);
  const appWt = path.join(wt, cfg.appDir);
  const lockRel = findLockfile(root, cfg.appDir);
  const lockChanged = lockRel
    ? !existsSync(path.join(wt, lockRel)) || readFileSync(path.join(root, lockRel), 'utf8') !== readFileSync(path.join(wt, lockRel), 'utf8')
    : false;
  let pkg = null;
  try {
    pkg = JSON.parse(readFileSync(path.join(appWt, 'package.json'), 'utf8'));
  } catch {}
  const installCommand = cfg.installCommand ?? inferInstallCommand(root, lockRel);
  const installDir = cfg.installCommand ? appWt : lockRel ? path.join(wt, path.dirname(lockRel)) : appWt;
  const hasNm = existsSync(path.join(appRoot, 'node_modules'));
  const wantInstall =
    force || cfg.deps === 'install' || (cfg.deps === 'auto' && installCommand && (lockChanged || !hasNm || usesTurbopack(pkg, cfg.startCommand)));

  if (wantInstall && installCommand) {
    if (existsSync(path.join(appWt, 'node_modules')) && !force) return { mode: 'existing', installCommand, warning: null };
    log(`installing dependencies in ${path.relative(wt, installDir) || '.'} of ${path.basename(wt)} (${installCommand})`);
    const r = await shAsync('sh', ['-c', installCommand], { cwd: installDir, logFile });
    if (!r.ok) throw new CliError(`The install (${installCommand}) failed; see ${logFile}`, { step: 'install' });
    return { mode: 'install', installCommand, warning: null };
  }
  // Links: the app's node_modules and, in a monorepo, the root one (where npm/yarn hoist).
  linkNodeModules(path.join(appRoot, 'node_modules'), path.join(appWt, 'node_modules'), root, wt);
  if (cfg.appDir !== '.') linkNodeModules(path.join(root, 'node_modules'), path.join(wt, 'node_modules'), root, wt);
  const warning = lockChanged && !installCommand ? "The lockfile differs between the sides and the main checkout's node_modules was reused; set installCommand if the result looks wrong." : null;
  return { mode: 'link', installCommand, warning };
}

/**
 * Starts the app for one side. Returns { url, stop, warning, pgid }.
 * side: { name: 'base'|'head', dir } ; previewUrl skips the server.
 * onSpawn(pgid) is called as soon as the process is born, so the pipeline can record the group in state.json.
 */
export async function startSide(root, cfg, side, logFile, previewUrl, { onSpawn } = {}) {
  if (previewUrl) return { url: previewUrl.replace(/\/$/, ''), stop: async () => {}, warning: null, pgid: null };
  const cmd = cfg.startCommand;

  if (cmd.startsWith('static:')) {
    const port = await freePort();
    const dir = path.resolve(side.dir, cfg.appDir, cmd.slice('static:'.length) || '.');
    const server = await startStatic(dir, port);
    return { url: `http://127.0.0.1:${port}`, stop: () => new Promise((r) => server.close(() => r())), warning: null, pgid: null };
  }

  const deps = await prepareDeps(root, side.dir, cfg, logFile);
  try {
    return await spawnServer(cfg, side, logFile, deps.warning, onSpawn);
  } catch (e) {
    // With linked dependencies, a failure may come from the borrowed node_modules: install and try again.
    if (deps.mode !== 'link' || !deps.installCommand || cfg.deps === 'link') throw e;
    log(`${side.name}: the server failed with linked dependencies; installing and trying again`);
    await prepareDepsAfterFailure(root, side.dir, cfg, logFile);
    return await spawnServer(cfg, side, logFile, null, onSpawn);
  }
}

async function prepareDepsAfterFailure(root, wt, cfg, logFile) {
  const { rmSync } = await import('node:fs');
  rmSync(path.join(wt, cfg.appDir, 'node_modules'), { recursive: true, force: true });
  if (cfg.appDir !== '.') rmSync(path.join(wt, 'node_modules'), { recursive: true, force: true });
  return prepareDeps(root, wt, cfg, logFile, { force: true });
}

async function spawnServer(cfg, side, logFile, warning, onSpawn) {
  const port = await freePort();
  const cmd = cfg.startCommand;
  const url = cfg.baseUrl.replace('{port}', String(port)).replace(/\/$/, '');
  const fd = openSync(logFile, 'a');
  const child = spawn('sh', ['-c', cmd.replaceAll('{port}', String(port))], {
    cwd: path.join(side.dir, cfg.appDir),
    detached: true, // own process group: we kill all of it at the end
    stdio: ['ignore', fd, fd],
    env: { ...process.env, ...cfg.env, PORT: String(port), BROWSER: 'none', NODE_ENV: process.env.NODE_ENV ?? 'development' },
  });
  const pgid = child.pid;
  onSpawn?.(pgid);
  let exited = null;
  child.on('exit', (code) => (exited = code ?? -1));

  // Always kill the group: sh may have exited and left the server (child) alive.
  const stop = async () => {
    killGroup(pgid, 'SIGTERM');
    for (let i = 0; i < 30; i++) {
      if (!groupAlive(pgid)) return;
      await sleep(100);
    }
    killGroup(pgid, 'SIGKILL');
  };

  log(`${side.name}: starting \`${cmd.replaceAll('{port}', port)}\` → ${url}`);
  const deadline = Date.now() + cfg.startTimeoutMs;
  while (Date.now() < deadline) {
    if (exited !== null && !groupAlive(pgid)) {
      throw new CliError(`The ${side.name} server exited with code ${exited} before responding.\n${tail(logFile)}`, { step: `start:${side.name}` });
    }
    if (await responds(url)) return { url, stop, warning, pgid };
    await sleep(500);
  }
  await stop();
  throw new CliError(`The ${side.name} server did not respond at ${url} after ${cfg.startTimeoutMs} ms (check startCommand/baseUrl; see ${logFile}).\n${tail(logFile)}`, { step: `start:${side.name}` });
}

export function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function responds(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => req.destroy());
  });
}

function tail(file, n = 15) {
  try {
    return readFileSync(file, 'utf8').trim().split('\n').slice(-n).join('\n');
  } catch {
    return '';
  }
}
