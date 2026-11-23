import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { browserInstalled, captureOne, launchBrowser } from './capture.mjs';
import { CONFIG_FILE, loadConfig, normalizeConfig, normalizeTheme, parseViewports, suggestConfig } from './config.mjs';
import { detect } from './detect.mjs';
import { githubRepo, listWorktrees, repoRoot, resolveSides } from './git.mjs';
import { cleanupStale, outDirOf, rediff, resolveAuth, run } from './pipeline.mjs';
import { prune, publish, render } from './publish.mjs';
import { startSide } from './server.mjs';
import { CliError, ensureDir, redact, sh, sleep, suggest } from './util.mjs';

const HELP = `visual-diff <command> [options]

Commands:
  init                 suggests ${CONFIG_FILE} (startCommand, routes, appDir in monorepos)
  doctor [--smoke]     checks git, node, gh, Chromium, config, remote and visibility;
                       --smoke starts the current app, captures the first route and stops it
  detect               changed files → routes (with reasons)
  run                  captures base and head, runs the diff → .visual-diff/report.json + images
  diff                 redoes only the diff and the images from the captures (e.g. after changing diff.threshold)
  render               comment preview → .visual-diff/comment.preview.md
  publish              pushes images to the assets branch and creates/updates the sticky comment
  prune --closed       removes images of closed PRs
  cleanup [--all]      kills servers and removes worktrees left by interrupted runs
  login --url <url>    opens a browser for you to sign in to the app and saves the session (auth.storageState)

detect/run options:
  --pr <n>             uses the PR's base/head (via gh)
  --base <ref>         base ref (default: origin's default branch)
  --head <ref>         head ref (default: current working tree, with local changes)
  --routes /,/pricing  explicit routes (skips detection)
  --viewports desktop,mobile,tablet:820x1180@2
  --themes light,dark
  --base-url/--head-url  uses already deployed previews instead of starting the app
  --only <key|route>   recaptures only that and merges it into the existing report
  --variants "/route:param=1..4"  captures head variants (?param=1..4) in a strip
  --json full          prints the whole report (default: summary)
  --no-cache           doesn't reuse cached base captures
  --keep-worktrees     doesn't delete the worktrees (debug)
  --config <file>      path to the config

publish:
  --dry-run            shows what would be sent and whether it would be refused; sends nothing
  --verify             after the push, checks the files on the branch and that the link requires login
  --no-upload          text-only comment
  --no-comment         pushes the images and prints the markdown without commenting
  --force-stale        publishes even if the PR got commits after the run (with a warning)
  --allow-public-repo  allows a public repository (only with explicit authorization)
  --allow-internal-repo  allows an INTERNAL repository (visible to the whole company)
  --assume-private     when the visibility can't be read

Exit codes: 0 ok · 1 error · 2 UI changed with no mapped route · 3 push refused ·
4 publish refused · 130/143 interrupted.
All JSON output goes to stdout; logs go to stderr.`;

const FLAGS = ['dryRun', 'noUpload', 'noComment', 'allowPublicRepo', 'allowInternalRepo', 'assumePrivate', 'keepWorktrees', 'closed', 'force', 'help', 'forceStale', 'verify', 'noCache', 'smoke', 'all'];
const SIDES = ['pr', 'base', 'head', 'config'];
const CAPTURE = [...SIDES, 'routes', 'viewports', 'themes', 'baseUrl', 'headUrl', 'keepWorktrees'];
export const COMMAND_OPTIONS = {
  init: ['force', 'config'],
  doctor: ['smoke', 'config', 'routes', 'viewports'],
  detect: [...SIDES],
  run: [...CAPTURE, 'only', 'json', 'noCache', 'variants'],
  diff: ['config', 'json'],
  render: ['config'],
  publish: ['pr', 'config', 'dryRun', 'noUpload', 'noComment', 'allowPublicRepo', 'allowInternalRepo', 'assumePrivate', 'forceStale', 'verify'],
  prune: ['closed', 'dryRun', 'config'],
  cleanup: ['all', 'config'],
  login: ['url', 'out', 'config'],
  help: [],
};

const kebab = (k) => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  if (cmd === '--help' || cmd === '-h') return { cmd: 'help', opts };
  if (cmd && !COMMAND_OPTIONS[cmd]) {
    const hint = suggest(cmd, Object.keys(COMMAND_OPTIONS));
    throw new CliError(`unknown command: ${cmd}${hint ? ` (did you mean "${hint}"?)` : ''}\n\n${HELP}`);
  }
  const allowed = [...(COMMAND_OPTIONS[cmd] ?? []), 'help'];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-h') {
      opts.help = true;
      continue;
    }
    if (!a.startsWith('--')) throw new CliError(`unexpected argument: ${a}`);
    const eq = a.indexOf('=');
    const k = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    const inline = eq >= 0 ? a.slice(eq + 1) : undefined;
    const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!allowed.includes(key)) {
      const hint = suggest(key, allowed);
      throw new CliError(`unknown option for \`${cmd}\`: --${k}${hint ? ` (did you mean --${kebab(hint)}?)` : ''}. Options: ${allowed.filter((o) => o !== 'help').map((o) => '--' + kebab(o)).join(' ') || '(none)'}`);
    }
    if (FLAGS.includes(key)) {
      if (inline === undefined || inline === 'true') opts[key] = true;
      else if (inline === 'false') opts[key] = false;
      else throw new CliError(`--${k} takes no value (use --${k} or --${k}=false)`);
      continue;
    }
    const value = inline ?? rest[++i];
    if (value === undefined || (inline === undefined && value.startsWith('--'))) throw new CliError(`--${k} needs a value`);
    opts[key] = value;
  }
  if (opts.pr !== undefined && !/^\d+$/.test(opts.pr)) throw new CliError(`--pr must be a number (got "${opts.pr}")`);
  if (opts.json !== undefined && opts.json !== 'full') throw new CliError('--json only accepts "full"');
  return { cmd, opts };
}

export async function main(argv) {
  try {
    const { cmd, opts } = parseArgs(argv);
    if (!cmd || cmd === 'help' || opts.help) {
      process.stderr.write(HELP + '\n');
      return 0;
    }
    const root = repoRoot();
    let cfg;
    let cfgError = null;
    try {
      cfg = loadConfig(root, opts.config);
    } catch (e) {
      if (cmd !== 'doctor' && cmd !== 'init' && cmd !== 'cleanup') throw e;
      cfgError = e;
      cfg = normalizeConfig({});
    }
    if (opts.viewports) cfg.viewports = parseViewports(opts.viewports);
    if (opts.themes) cfg.themes = opts.themes.split(',').map((n) => cfg.themes.find((t) => t.name === n) ?? normalizeTheme(n));
    const runOpts = {
      pr: opts.pr ? Number(opts.pr) : undefined,
      base: opts.base,
      head: opts.head,
      routes: opts.routes ? opts.routes.split(',').map((r) => r.trim()).filter(Boolean) : undefined,
      baseUrl: opts.baseUrl,
      headUrl: opts.headUrl,
      keepWorktrees: opts.keepWorktrees,
      only: opts.only,
      json: opts.json,
      noCache: opts.noCache,
      variants: opts.variants,
    };
    ensureExcluded(root);

    let result;
    switch (cmd) {
      case 'init': {
        const target = path.join(root, CONFIG_FILE);
        if (existsSync(target) && !opts.force) {
          result = { written: false, file: CONFIG_FILE, reason: 'already exists (use --force to overwrite)', config: JSON.parse(readFileSync(target, 'utf8')), ...(cfgError ? { problems: cfgError.message } : {}) };
          break;
        }
        const { config, notes } = suggestConfig(root);
        writeFileSync(target, JSON.stringify(config, null, 2) + '\n');
        result = { written: true, file: CONFIG_FILE, config, notes, next: 'Check startCommand, appDir and routes before the first run; run `doctor --smoke` to test the startCommand.' };
        break;
      }
      case 'doctor':
        result = await doctor(root, cfg, { cfgError, smoke: opts.smoke, routes: runOpts.routes });
        break;
      case 'detect': {
        const sides = resolveSides(root, runOpts, cfg);
        const d = detect(root, cfg, sides);
        result = { base: sides.base.label, head: sides.head.label, ...d, changedFiles: d.changedFiles.length };
        break;
      }
      case 'run':
        result = await run(root, cfg, runOpts);
        break;
      case 'diff':
        result = await rediff(root, cfg);
        break;
      case 'render':
        result = render(root, cfg);
        break;
      case 'publish':
        result = await publish(root, cfg, { ...runOpts, dryRun: opts.dryRun, noUpload: opts.noUpload, noComment: opts.noComment, allowPublicRepo: opts.allowPublicRepo, allowInternalRepo: opts.allowInternalRepo, assumePrivate: opts.assumePrivate, forceStale: opts.forceStale, verify: opts.verify });
        break;
      case 'prune':
        if (!opts.closed) throw new CliError('Use `prune --closed` (removes the images of closed or merged PRs).');
        result = prune(root, cfg, { closed: true, dryRun: opts.dryRun });
        break;
      case 'cleanup':
        result = cleanupStale(root, { all: opts.all });
        break;
      case 'login':
        result = await login(root, opts);
        break;
    }
    const exitCode = result?.exitCode ?? 0;
    if (result && 'exitCode' in result) delete result.exitCode;
    process.stdout.write(redact(JSON.stringify(result, null, 2)) + '\n');
    return exitCode;
  } catch (e) {
    const err = e instanceof CliError ? e : new CliError(e.stack ?? String(e));
    process.stdout.write(redact(JSON.stringify({ error: err.message, step: err.step ?? null, code: err.code ?? 1 }, null, 2)) + '\n');
    process.stderr.write(`[visual-diff] error${err.step ? ` (${err.step})` : ''}: ${redact(err.message)}\n`);
    return err.code ?? 1;
  }
}

async function doctor(root, cfg, { cfgError, smoke, routes }) {
  const checks = [];
  const add = (name, level, detail) => checks.push({ name, level, detail });
  add('git', 'OK', sh('git', ['--version']).stdout.trim());
  const node = process.versions.node.split('.').map(Number);
  add('node', node[0] > 20 || (node[0] === 20 && node[1] >= 10) ? 'OK' : 'FAIL', process.versions.node);
  const gh = sh('gh', ['auth', 'status'], { allowFail: true });
  add('gh', gh.ok ? 'OK' : 'WARN', gh.ok ? 'logged in' : 'gh missing or not logged in: only needed for --pr and publish');
  const br = await browserInstalled();
  add('browser', br.ok ? 'OK' : 'WARN', br.ok ? `Playwright's Chromium at ${br.path}` : "Playwright's Chromium not downloaded yet; the first run downloads it (~150 MB)");
  if (cfgError) add('config', 'FAIL', cfgError.message);
  else add('config', cfg.found ? 'OK' : 'WARN', cfg.found ? path.relative(root, cfg.path) : `no ${CONFIG_FILE}: run \`init\``);
  if (!cfg.startCommand.startsWith('static:') && !cfg.startCommand.includes('{port}') && !/\bPORT\b/.test(cfg.startCommand)) {
    add('startCommand', 'FAIL', 'startCommand must use {port} (or read PORT) so both sides run on different ports');
  }
  if (!cfg.startCommand.startsWith('static:') && !cfg.baseUrl.includes('{port}')) add('baseUrl', 'FAIL', 'baseUrl must contain {port} (e.g. http://localhost:{port})');
  if (cfg.appDir !== '.' && !existsSync(path.join(root, cfg.appDir))) add('appDir', 'FAIL', `${cfg.appDir} does not exist`);
  const orphans = listWorktrees(root).filter((w) => w.includes('visual-diff-wt-'));
  if (orphans.length) add('worktrees', 'WARN', `${orphans.length} worktree(s) from interrupted runs; run \`cleanup\``);
  const repo = githubRepo(root, cfg);
  if (!repo) add('remote', 'WARN', 'no GitHub remote (or publish.repo): publish will not work');
  else if (gh.ok) {
    const v = sh('gh', ['repo', 'view', repo.host === 'github.com' ? repo.slug : `${repo.host}/${repo.slug}`, '--json', 'visibility', '-q', '.visibility'], { allowFail: true }).stdout.trim();
    const level = v === 'PRIVATE' ? 'OK' : 'WARN';
    const extra = v === 'PUBLIC' ? ' (publish refuses without --allow-public-repo)' : v === 'INTERNAL' ? ' (visible to the whole company; publish requires --allow-internal-repo)' : '';
    add('visibility', level, v ? `${repo.slug}: ${v}${extra}` : 'could not read it');
  }
  const out = { ok: !checks.some((c) => c.level === 'FAIL'), checks };
  if (smoke && out.ok) out.smoke = await smokeTest(root, cfg, routes?.[0] ?? cfg.routes[0]?.path ?? '/');
  if (out.smoke && !out.smoke.ok) out.ok = false;
  return out;
}

/** Starts the app from the current checkout (no worktree), captures one route and stops it. */
async function smokeTest(root, cfg, route) {
  const logFile = path.join(ensureDir(path.join(outDirOf(root), 'logs')), 'smoke.log');
  const t0 = Date.now();
  let srv;
  let browser;
  try {
    srv = await startSide(root, { ...cfg, deps: 'link' }, { name: 'smoke', dir: root }, logFile, null);
    const bootMs = Date.now() - t0;
    browser = await launchBrowser();
    const auth = resolveAuth(root, cfg, { usingPreviews: false });
    const shot = await captureOne(browser, { target: new URL(route, srv.url + '/').toString(), vp: cfg.viewports[0], theme: cfg.themes[0], cfg, runStart: new Date(), auth, isPreview: false });
    if (shot.ok) writeFileSync(path.join(outDirOf(root), 'smoke.png'), shot.png);
    return { ok: shot.ok, route, url: srv.url, status: shot.status, bootMs, captureMs: Date.now() - t0 - bootMs, stable: shot.stable, image: shot.ok ? '.visual-diff/smoke.png' : null, log: path.relative(root, logFile) };
  } catch (e) {
    return { ok: false, route, error: redact(e.message), log: path.relative(root, logFile) };
  } finally {
    await browser?.close().catch(() => {});
    await srv?.stop().catch(() => {});
  }
}

/** CAP-3: visible browser for the person to sign in; the session is saved while the window is open. */
async function login(root, opts) {
  if (!opts.url) throw new CliError('Pass --url <login page> (e.g. http://localhost:3000/login).');
  const file = path.resolve(root, opts.out ?? '.visual-diff/auth/storage-state.json');
  ensureDir(path.dirname(file));
  const ignored = sh('git', ['check-ignore', '-q', file], { cwd: root, allowFail: true }).ok || file.startsWith(outDirOf(root) + path.sep);
  const browser = await launchBrowser({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(opts.url);
  process.stderr.write('[visual-diff] sign in to the app in the open window and close the window when done (up to 10 min).\n');
  let last = null;
  const deadline = Date.now() + 10 * 60_000;
  let closed = false;
  page.on('close', () => (closed = true));
  browser.on('disconnected', () => (closed = true));
  while (!closed && Date.now() < deadline) {
    try {
      last = await context.storageState();
    } catch {
      break;
    }
    await sleep(1500);
  }
  await browser.close().catch(() => {});
  if (!last) throw new CliError('Could not read the browser session.');
  writeFileSync(file, JSON.stringify(last, null, 2), { mode: 0o600 });
  const rel = path.relative(root, file);
  return {
    file: rel,
    cookies: last.cookies.length,
    domains: [...new Set(last.cookies.map((c) => c.domain))],
    origins: last.origins.map((o) => o.origin),
    next: `Add to the config: "auth": { "storageState": "${rel}", "origins": ["local"] } (use "previews" for deployed previews).`,
    ...(ignored ? {} : { warning: `${rel} is not ignored by git; don't commit this file.` }),
  };
}

/** Makes sure .visual-diff/ stays out of commits. */
function ensureExcluded(root) {
  const gitDir = sh('git', ['rev-parse', '--git-common-dir'], { cwd: root }).stdout.trim();
  const exclude = path.resolve(root, gitDir, 'info', 'exclude');
  ensureDir(path.dirname(exclude));
  const cur = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  if (!cur.split('\n').includes('.visual-diff/')) appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}.visual-diff/\n`);
  ensureDir(outDirOf(root));
}
