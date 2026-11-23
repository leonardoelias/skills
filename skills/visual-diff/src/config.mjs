import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig } from './schema.mjs';
import { workingTree } from './tree.mjs';
import { CliError, relPath } from './util.mjs';
import { frameworkOf, readWorkspaces } from './workspace.mjs';

export const CONFIG_FILE = 'visual-diff.config.json';
export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SKILL_VERSION = JSON.parse(readFileSync(path.join(SKILL_ROOT, 'package.json'), 'utf8')).version;

export const VIEWPORT_PRESETS = {
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1 },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

export const DEFAULTS = {
  appDir: '.',
  startCommand: 'npm run dev -- --port {port}',
  baseUrl: 'http://localhost:{port}',
  installCommand: null,
  deps: 'auto',
  startTimeoutMs: 90_000,
  env: {},
  routes: [],
  globalFiles: [],
  viewports: ['desktop', 'mobile'],
  themes: [{ name: 'light' }],
  capture: {
    mask: [],
    hide: [],
    maskEmbeds: ['iframe'],
    fullPage: true,
    settleMs: 250,
    maxRetakes: 4,
    fixedTime: 'run-start',
    locale: 'en-US',
    timezone: 'UTC',
    maxHeight: 8000,
    maxScrollSteps: 40,
    networkIdleMs: 2500,
    waitFor: null,
    blockHosts: [],
    blockDefaultHosts: true,
    concurrency: 2,
  },
  diff: { threshold: 0.1, focusRegions: 3, rowTolerance: 0.003, composeFormat: 'jpeg', maxFocusArea: 0.4 },
  detect: {
    uiExtensions: ['.html', '.css', '.scss', '.sass', '.less', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue', '.svelte', '.astro', '.md', '.mdx', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.otf'],
    ignore: ['**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/*.d.ts', '**/*.stories.*', '**/__mocks__/**', '**/e2e/**'],
    maxRoutes: 10,
    maxDepth: 6,
    aliases: {},
  },
  auth: { headers: {}, cookies: [], storageState: null, origins: ['previews'] },
  audits: { a11y: false, tokens: false, motion: false },
  motion: { durationMs: 2500, fps: 10, maxWidth: 360, steps: [] },
  cache: { base: true, worktrees: false },
  publish: { branch: 'visual-diff-assets', marker: 'default', remote: null, repo: null, host: null },
};

const SECTIONS = ['capture', 'diff', 'detect', 'auth', 'audits', 'motion', 'cache', 'publish'];

/** Looks for the config at the repo root, validates it and returns it merged with the defaults. */
export function loadConfig(repoRoot, file) {
  const p = file ? path.resolve(file) : path.join(repoRoot, CONFIG_FILE);
  let user = {};
  if (file && !existsSync(p)) throw new CliError(`Config not found: ${p}`, { step: 'config' });
  if (existsSync(p)) {
    try {
      user = JSON.parse(readFileSync(p, 'utf8'));
    } catch (e) {
      throw new CliError(`${p} is not valid JSON: ${e.message}`, { step: 'config' });
    }
    const errors = validateConfig(user);
    if (errors.length) throw new CliError(`${path.basename(p)} has problems:\n- ${errors.join('\n- ')}`, { step: 'config' });
  }
  return normalizeConfig(user, { found: existsSync(p), path: p });
}

export function normalizeConfig(user = {}, meta = {}) {
  const cfg = { ...DEFAULTS, ...user };
  for (const s of SECTIONS) cfg[s] = { ...DEFAULTS[s], ...user[s] };
  if (typeof cfg.audits.tokens === 'object' && cfg.audits.tokens) cfg.audits.tokens = { ...cfg.audits.tokens };
  delete cfg.$schema;
  cfg.found = !!meta.found;
  cfg.path = meta.path ?? null;
  cfg.appDir = (cfg.appDir || '.').replace(/^\.\/+/, '').replace(/\/+$/, '') || '.';
  cfg.viewports = parseViewports(cfg.viewports);
  cfg.themes = cfg.themes.map(normalizeTheme);
  cfg.routes = cfg.routes.map((r) => (typeof r === 'string' ? { path: r, files: [] } : { files: [], ...r }));
  return cfg;
}

export function normalizeTheme(t) {
  if (typeof t === 'string') return { name: t, colorScheme: t === 'dark' ? 'dark' : 'light' };
  return { colorScheme: t.name === 'dark' ? 'dark' : 'light', ...t };
}

/** Accepts "desktop", "tablet:820x1180@2" or objects { name, width, height, deviceScaleFactor }. */
export function parseViewports(list) {
  const items = typeof list === 'string' ? list.split(',').filter(Boolean) : list;
  return items.map((v) => {
    if (typeof v === 'object') return { ...(VIEWPORT_PRESETS[v.name] ?? {}), ...v };
    const m = /^([\w-]+)(?::(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?)?$/.exec(v.trim());
    if (!m) throw new CliError(`invalid viewport: "${v}" (use desktop, mobile, tablet or name:WxH@scale)`);
    const [, name, w, h, scale] = m;
    if (w) return { name, width: +w, height: +h, deviceScaleFactor: scale ? +scale : 1, isMobile: +w < 900, hasTouch: +w < 900 };
    if (!VIEWPORT_PRESETS[name]) throw new CliError(`unknown viewport: "${name}" (presets: ${Object.keys(VIEWPORT_PRESETS).join(', ')})`);
    return { name, ...VIEWPORT_PRESETS[name] };
  });
}

/** "1..4" → ['1','2','3','4']; lists pass through. At most 12 values. */
export function parseVariantValues(values) {
  let out;
  if (Array.isArray(values)) out = values.map(String);
  else {
    const m = /^(\d+)\.\.(\d+)$/.exec(String(values).trim());
    if (m) {
      const [a, b] = [Number(m[1]), Number(m[2])];
      out = [];
      for (let i = a; a <= b ? i <= b : i >= b; i += a <= b ? 1 : -1) out.push(String(i));
    } else out = String(values).split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (out.length === 0) throw new CliError('variants.values is empty.');
  if (out.length > 12) throw new CliError(`variants.values has ${out.length} values; the maximum is 12.`);
  return out;
}

/** Static server folder, relative to appDir, or null. */
export const staticDirOf = (cfg) => (cfg.startCommand?.startsWith('static:') ? (cfg.startCommand.slice('static:'.length) || '.').replace(/^\.\/+/, '').replace(/\/+$/, '') || '.' : null);

const CODE = '(?:tsx|jsx|ts|js|mdx)';
const BUILD_DIRS = /(^|\/)(dist|build|out|coverage|node_modules|\.next|\.svelte-kit|\.output|\.nuxt|\.astro|storybook-static)\//;

/**
 * Classifies a file (relative to appDir) by framework conventions:
 * { kind: 'page', route } | { kind: 'layout', prefix } | { kind: 'global' } | { kind: 'aux', prefix } | null.
 * layout covers the routes below the prefix; global covers all of them; aux (loading, error, 404) has low confidence.
 */
export function fileToScope(rel, { staticDir = null } = {}) {
  const f = rel.split(path.sep).join('/');
  if (BUILD_DIRS.test(f)) return null;
  let m;

  // Next.js App Router
  if ((m = new RegExp(`^(?:src/)?app/(?:(.*)/)?(page|layout|template|loading|error|not-found|global-error|default)\\.${CODE}$`).exec(f))) {
    const raw = (m[1] ?? '').split('/').filter(Boolean);
    if (raw.some((s) => s.startsWith('_') || s.startsWith('(.'))) return null; // private folders and intercepted routes
    const segs = raw.filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@'));
    const route = '/' + segs.join('/');
    const kind = m[2];
    if (kind === 'page') return { kind: 'page', route };
    if (kind === 'layout' || kind === 'template') return segs.length === 0 ? { kind: 'global' } : { kind: 'layout', prefix: route };
    if (kind === 'global-error') return { kind: 'aux', prefix: '/' };
    return { kind: 'aux', prefix: route };
  }
  // Next.js Pages Router
  if ((m = new RegExp(`^(?:src/)?pages/(.+)\\.${CODE}$`).exec(f))) {
    const name = m[1];
    if (/^api\//.test(name)) return null;
    if (/^_(app|document)$/.test(name)) return { kind: 'global' };
    if (/^(_error|404|500)$/.test(name)) return { kind: 'aux', prefix: '/' };
    if (/(^|\/)_/.test(name)) return null;
    return { kind: 'page', route: '/' + name.replace(/(^|\/)index$/, '').replace(/\/$/, '') };
  }
  // SvelteKit
  if ((m = /^src\/routes\/(?:(.*)\/)?\+(page|layout|error)(?:@[^.]*)?(?:\.server)?\.(svelte|ts|js)$/.exec(f))) {
    const segs = (m[1] ?? '').split('/').filter((s) => s && !/^\(.*\)$/.test(s));
    const route = '/' + segs.join('/');
    if (m[2] === 'page') return { kind: 'page', route };
    if (m[2] === 'layout') return segs.length === 0 ? { kind: 'global' } : { kind: 'layout', prefix: route };
    return { kind: 'aux', prefix: route };
  }
  if (f === 'src/app.html') return { kind: 'global' };
  // Astro
  if ((m = /^src\/pages\/(.+)\.(?:astro|md|mdx|html)$/.exec(f))) {
    if (/(^|\/)_/.test(m[1])) return null;
    return { kind: 'page', route: '/' + m[1].replace(/(^|\/)index$/, '').replace(/\/$/, '') };
  }
  // Nuxt
  if ((m = /^(?:app\/)?pages\/(.+)\.vue$/.exec(f))) return { kind: 'page', route: '/' + m[1].replace(/(^|\/)index$/, '').replace(/\/$/, '') };
  if (/^(?:app\/)?(app|error)\.vue$/.test(f)) return /error\.vue$/.test(f) ? { kind: 'aux', prefix: '/' } : { kind: 'global' };
  if (/^(?:app\/)?layouts\/.+\.vue$/.test(f)) return { kind: 'global' };
  // Remix / React Router (flat routes)
  if (new RegExp(`^app/root\\.${CODE}$`).test(f)) return { kind: 'global' };
  if ((m = new RegExp(`^app/routes/([^/]+?)(?:/route)?\\.${CODE}$`).exec(f))) {
    const segs = m[1].split('.').filter((s) => s !== '_index' && !s.startsWith('_')).map((s) => s.replace(/_$/, '').replace(/^\((.*)\)$/, '$1'));
    return { kind: 'page', route: '/' + segs.filter(Boolean).join('/') };
  }
  // Static HTML: in the static:<dir> folder, or at the root / public/ when there's no static server.
  if (/\.html$/.test(f)) {
    let inner = null;
    if (staticDir !== null) {
      if (staticDir === '.') inner = f;
      else if (f.startsWith(staticDir + '/')) inner = f.slice(staticDir.length + 1);
    } else if (!f.includes('/')) inner = f;
    else if (f.startsWith('public/')) inner = f.slice('public/'.length);
    if (inner === null) return null;
    const name = inner.slice(0, -'.html'.length);
    if (name === 'index') return { kind: 'page', route: '/' };
    if (name.endsWith('/index')) return { kind: 'page', route: '/' + name.slice(0, -'index'.length) };
    return { kind: 'page', route: `/${name}.html` };
  }
  return null;
}

/** Shortcut: a page's route, or null. */
export function fileToRoute(rel, opts) {
  const s = fileToScope(rel, opts);
  return s?.kind === 'page' ? s.route : null;
}

export const isDynamic = (route) => /\[|\$|(^|\/):/.test(route);

/** RegExp that matches concrete examples of a dynamic route (/blog/[slug] matches /blog/hello). */
export function dynamicMatcher(pattern) {
  let re = '';
  for (const seg of pattern.split('/').filter(Boolean)) {
    if (/^\[\[\.\.\..+\]\]$/.test(seg)) re += '(?:/.*)?';
    else if (/^\[\.\.\..+\]$/.test(seg) || seg === '$') re += '/.+';
    else if (/^\[.+\]$/.test(seg) || /^[$:]/.test(seg)) re += '/[^/]+';
    else re += '/' + seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re || '/'}/?$`);
}

/** Convention-based routes from a list of files (relative to the repo root). */
export function discoverRoutes(files, cfg) {
  const appPrefix = cfg.appDir === '.' ? '' : cfg.appDir + '/';
  const staticDir = staticDirOf(cfg);
  const out = new Set();
  for (const f of files) {
    if (appPrefix && !f.startsWith(appPrefix)) continue;
    const r = fileToRoute(f.slice(appPrefix.length), { staticDir });
    if (r && !isDynamic(r)) out.add(r);
  }
  return [...out].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

/** Suggests a config by looking at package.json, workspaces and the folder structure. */
export function suggestConfig(repoRoot) {
  const tree = workingTree(repoRoot);
  const notes = [];
  const readPkg = (dir) => {
    const p = path.join(repoRoot, dir, 'package.json');
    try {
      return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
    } catch {
      return null;
    }
  };

  let appDir = '.';
  const workspaces = readWorkspaces(tree);
  const apps = workspaces.filter((w) => frameworkOf(w.pkg) && (w.pkg.scripts?.dev || w.pkg.scripts?.start));
  if (apps.length) {
    // Prefers the "main" app (web, app, site…) and, after that, the one with the most routes.
    const files = tree.list();
    const score = (a) => (/^(web|app|frontend|site|www|client|dashboard)$/.test(path.posix.basename(a.dir)) ? 1000 : 0) + discoverRoutes(files, normalizeConfig({ appDir: a.dir })).length;
    const chosen = [...apps].sort((x, y) => score(y) - score(x))[0];
    appDir = chosen.dir;
    notes.push(`Monorepo: used appDir "${appDir}" (${frameworkOf(chosen.pkg)}).${apps.length > 1 ? ` Other apps: ${apps.filter((a) => a !== chosen).map((a) => a.dir).join(', ')}. Use one config per app with a different publish.marker, or change appDir.` : ''}`);
  }

  const pkg = readPkg(appDir);
  const framework = frameworkOf(pkg);
  let startCommand;
  if (!pkg) {
    startCommand = 'static:.';
    notes.push('No package.json: using the built-in static server (static:<folder>).');
  } else if (!pkg.scripts?.dev && !pkg.scripts?.start) {
    startCommand = 'static:.';
    notes.push('package.json has no dev/start script: using the built-in static server.');
  } else {
    const script = pkg.scripts.dev ? 'dev' : 'start';
    if (framework === 'next') {
      startCommand = `npm run ${script} -- -p {port}`;
      notes.push('Next.js: the production build captures faster and without dev overlays. If you want, use "startCommand": "npm run build && npm run start -- -p {port}".');
    } else if (['vite', 'sveltekit', 'astro'].includes(framework)) startCommand = `npm run ${script} -- --port {port} --strictPort`;
    else if (framework === 'nuxt' || framework === 'remix') startCommand = `npm run ${script} -- --port {port}`;
    else {
      startCommand = `PORT={port} npm run ${script}`;
      notes.push('Framework not recognized: check that the server respects PORT.');
    }
  }

  const cfgForRoutes = normalizeConfig({ appDir, startCommand });
  const routes = discoverRoutes(tree.list(), cfgForRoutes).slice(0, 15).map((r) => ({ path: r, files: [] }));
  if (routes.length === 0) routes.push({ path: '/', files: [] });

  const config = {};
  const schemaFile = path.join(SKILL_ROOT, 'visual-diff.schema.json');
  const relSchema = relPath(repoRoot, schemaFile);
  // Only references the schema when the skill is inside the repo (committable relative path).
  if (!relSchema.startsWith('..') && !path.isAbsolute(relSchema)) config.$schema = `./${relSchema}`;
  if (appDir !== '.') config.appDir = appDir;
  Object.assign(config, {
    startCommand,
    baseUrl: 'http://localhost:{port}',
    routes,
    globalFiles: ['tailwind.config.*', 'src/styles/**'],
    themes: [{ name: 'light' }],
    capture: { locale: 'en-US', fixedTime: 'run-start' },
  });
  notes.push('capture.locale sets the browser language (Accept-Language and navigator.language). Change it if the app redirects by language.');
  return { config, notes };
}
