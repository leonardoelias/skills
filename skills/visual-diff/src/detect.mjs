import path from 'node:path';
import { discoverRoutes, dynamicMatcher, fileToScope, isDynamic, staticDirOf } from './config.mjs';
import { changedEntries } from './git.mjs';
import { buildGraph, reachEntries } from './imports.mjs';
import { commitTree, workingTree } from './tree.mjs';
import { matchesAny } from './util.mjs';
import { readWorkspaces } from './workspace.mjs';

// .js/.ts outside interface folders may be backend only: they count as "maybe UI".
const MAYBE_EXT = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'];
const UI_DIRS = /(^|\/)(components?|ui|styles?|css|theme|themes|app|pages|routes|layouts?|views|templates|public|assets|static|icons|design-system)\//;

/**
 * Maps changed files to routes. Order of precedence:
 * 1. the config's routes[].files  2. globalFiles (all routes)  3. framework conventions (pages,
 * layouts, global files)  4. reverse import graph up to a page, layout or global file.
 * No UI file gets lost: what has no route goes to `unmatched` (certain) or `unmatchedMaybe`.
 */
export function detect(root, cfg, sides) {
  const entries = changedEntries(root, sides);
  const appPrefix = cfg.appDir === '.' ? '' : cfg.appDir + '/';
  const staticDir = staticDirOf(cfg);
  const relToApp = (f) => (!appPrefix ? f : f.startsWith(appPrefix) ? f.slice(appPrefix.length) : null);
  const ignored = (f) => matchesAny(f, cfg.detect.ignore) || (relToApp(f) !== null && matchesAny(relToApp(f), cfg.detect.ignore));
  const ui = entries.filter((e) => cfg.detect.uiExtensions.includes(path.extname(e.path).toLowerCase()) && !ignored(e.path));

  const headTree = sides.head.workingTree ? workingTree(root) : commitTree(root, sides.head.sha);
  let baseTree = null;
  const graphs = new Map();
  const graphOf = (which) => {
    if (!graphs.has(which)) {
      const tree = which === 'head' ? headTree : (baseTree ??= commitTree(root, sides.base.sha));
      graphs.set(which, buildGraph(tree, { appDir: cfg.appDir, staticDir, aliases: cfg.detect.aliases }));
    }
    return graphs.get(which);
  };

  const configured = cfg.routes;
  let discovered = null;
  const known = () => {
    discovered ??= discoverRoutes(headTree.list(), cfg);
    return [...new Set([...configured.map((r) => r.path), ...discovered])];
  };
  // Targets of a global change: the configured routes; without them, the discovered ones; with nothing, "/".
  const globalTargets = () => {
    if (configured.length) return configured.map((r) => r.path);
    const d = known();
    return d.length ? d : ['/'];
  };
  const underPrefix = (prefix) => {
    const hits = known().filter((r) => {
      const p = r.split('?')[0];
      return p === prefix || p.startsWith(prefix.endsWith('/') ? prefix : prefix + '/');
    });
    return hits.length ? hits : isDynamic(prefix) ? [] : [prefix];
  };

  const routes = new Map(); // path → { path, reasons, confidence, change }
  const add = (route, reason, confidence, change = 'modified') => {
    const r = routes.get(route) ?? { path: route, reasons: [], confidence, change };
    if (!r.reasons.includes(reason)) r.reasons.push(reason);
    if (rank(confidence) > rank(r.confidence)) r.confidence = confidence;
    if (change !== 'modified') r.change = change;
    routes.set(route, r);
  };
  const unmatched = [];
  const unmatchedMaybe = [];
  const needsExample = [];

  // Dynamic route: uses a configured example (/blog/hello for /blog/[slug]) or asks for one.
  const addPage = (route, reason, confidence, file, change) => {
    if (!isDynamic(route)) return add(route, reason, confidence, change);
    const re = dynamicMatcher(route);
    const examples = configured.filter((r) => re.test(r.path.split('?')[0]));
    if (examples.length) for (const ex of examples) add(ex.path, `${reason} (example of ${route})`, confidence, change);
    else if (!needsExample.some((n) => n.pattern === route)) needsExample.push({ file, pattern: route });
  };

  const applyScope = (scope, file, reason, confidence, change) => {
    if (scope.kind === 'page') addPage(scope.route, reason, confidence, file, change);
    else if (scope.kind === 'layout') for (const t of underPrefix(scope.prefix)) add(t, `${reason} (layout of ${scope.prefix})`, rank(confidence) > 1 ? 'medium' : confidence);
    else if (scope.kind === 'global') for (const t of globalTargets()) add(t, `${reason} (affects all routes)`, rank(confidence) > 1 ? 'medium' : confidence);
    else if (scope.kind === 'aux') for (const t of underPrefix(scope.prefix)) add(t, `${reason} (loading/error state, may not show up)`, 'low');
  };

  for (const e of ui) {
    const file = e.path;
    const rel = relToApp(file);
    const maybe = MAYBE_EXT.includes(path.extname(file).toLowerCase()) && !UI_DIRS.test(file);
    let placed = false;

    for (const r of configured) {
      if (matchesAny(file, r.files) || (rel !== null && matchesAny(rel, r.files))) {
        add(r.path, `${file} (routes[].files)`, 'high');
        placed = true;
      }
    }
    if (matchesAny(file, cfg.globalFiles) || (rel !== null && matchesAny(rel, cfg.globalFiles))) {
      for (const t of globalTargets()) add(t, `${file} (globalFiles)`, 'medium');
      placed = true;
    }

    const scope = rel !== null ? fileToScope(rel, { staticDir }) : null;
    if (scope) {
      const change = scope.kind === 'page' ? (e.status === 'A' ? 'added' : e.status === 'D' ? 'removed' : 'modified') : 'modified';
      applyScope(scope, file, `${file} (route convention)`, 'high', change);
      if (e.status === 'R' && e.from) {
        const old = relToApp(e.from) !== null ? fileToScope(relToApp(e.from), { staticDir }) : null;
        if (old?.kind === 'page' && old.route !== scope.route) addPage(old.route, `${e.from} → ${file} (renamed)`, 'high', e.from, 'removed');
      }
      placed = true;
    }

    if (!placed) {
      // Deleted file: whoever imported it is on the base.
      const graph = graphOf(e.status === 'D' ? 'base' : 'head');
      const classify = (f) => {
        const r = relToApp(f);
        return r === null ? null : fileToScope(r, { staticDir });
      };
      const found = reachEntries(graph, file, classify, cfg.detect.maxDepth);
      for (const { scope: s, via } of found) {
        const chain = via.slice(1).join(' → ');
        applyScope(s, file, `${file} → imported by ${chain}`, maybe ? 'low' : 'medium');
      }
      if (found.length === 0) (maybe ? unmatchedMaybe : unmatched).push(file);
    }
  }

  const sorted = [...routes.values()].sort((a, b) => rank(b.confidence) - rank(a.confidence) || b.reasons.length - a.reasons.length || a.path.localeCompare(b.path));
  const notes = [];
  if (sorted.length > cfg.detect.maxRoutes) notes.push(`${sorted.length - cfg.detect.maxRoutes} route(s) beyond detect.maxRoutes (${cfg.detect.maxRoutes}) were cut; use --routes to choose.`);
  if (!appPrefix && (unmatched.length || unmatchedMaybe.length)) {
    const ws = readWorkspaces(headTree).filter((w) => [...unmatched, ...unmatchedMaybe].some((f) => f.startsWith(w.dir + '/')));
    if (ws.length) notes.push(`Looks like a monorepo (${ws.map((w) => w.dir).join(', ')}): set appDir in the config so the route conventions work.`);
  }
  return {
    changedFiles: entries.map((e) => e.path),
    uiFiles: ui.map((e) => e.path),
    routes: sorted.slice(0, cfg.detect.maxRoutes),
    droppedRoutes: sorted.slice(cfg.detect.maxRoutes).map((r) => r.path),
    unmatched,
    unmatchedMaybe,
    needsExample,
    notes,
  };
}

const rank = (c) => ({ low: 0, medium: 1, high: 2 })[c] ?? 0;
