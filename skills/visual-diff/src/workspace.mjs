// Monorepo packages (npm/yarn/bun workspaces and pnpm-workspace.yaml) and framework detection.
import path from 'node:path';
import { globToRegExp } from './util.mjs';

const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** Workspace patterns from the root. tree: { list(), read(p) } (see tree.mjs). */
export function workspacePatterns(tree) {
  const pkg = parse(tree.read('package.json') ?? '') ?? {};
  const patterns = [];
  if (Array.isArray(pkg.workspaces)) patterns.push(...pkg.workspaces);
  else if (Array.isArray(pkg.workspaces?.packages)) patterns.push(...pkg.workspaces.packages);
  const pnpm = tree.read('pnpm-workspace.yaml');
  if (pnpm) {
    let inPackages = false;
    for (const line of pnpm.split('\n')) {
      if (/^packages\s*:/.test(line)) inPackages = true;
      else if (/^\S/.test(line)) inPackages = false;
      else if (inPackages) {
        const m = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/.exec(line);
        if (m) patterns.push(m[1].trim());
      }
    }
  }
  return patterns;
}

/** Lists the workspace packages: [{ name, dir, pkg }], dir relative to the repo root. */
export function readWorkspaces(tree) {
  const patterns = workspacePatterns(tree);
  if (!patterns.length) return [];
  // globToRegExp matches the folder and everything inside it; here we want the package's exact folder.
  const dirGlob = (p) => new RegExp(globToRegExp(p.replace(/^\.\//, '').replace(/\/$/, '')).source.replace(/\(\?:\/\.\*\)\?\$$/, '$'));
  const include = patterns.filter((p) => !p.startsWith('!')).map(dirGlob);
  const exclude = patterns.filter((p) => p.startsWith('!')).map((p) => dirGlob(p.slice(1)));
  const pkgFiles = tree.list().filter((f) => f.endsWith('/package.json') && !f.includes('node_modules/'));
  const contents = tree.readMany(pkgFiles);
  const out = [];
  for (const f of pkgFiles) {
    const dir = path.posix.dirname(f);
    if (!include.some((re) => re.test(dir)) || exclude.some((re) => re.test(dir))) continue;
    const pkg = parse(contents.get(f) ?? '');
    if (pkg?.name) out.push({ name: pkg.name, dir, pkg });
  }
  return out;
}

/** Framework of a package.json, by dependency name. */
export function frameworkOf(pkg) {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  if (deps.next) return 'next';
  if (deps['@sveltejs/kit']) return 'sveltekit';
  if (deps.astro) return 'astro';
  if (deps.nuxt) return 'nuxt';
  if (deps['@remix-run/dev'] || deps['@react-router/dev']) return 'remix';
  if (deps.vite) return 'vite';
  return null;
}
