// Accessibility delta with axe-core: what the head introduced and what it resolved compared to the base.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const IMPACT = { critical: 4, serious: 3, moderate: 2, minor: 1 };

/** Runs axe on the page (already loaded). Returns [{ id, impact, help, helpUrl, target, html }], one per node. */
export async function runAxe(page) {
  await page.addScriptTag({ path: AXE_PATH });
  const results = await page.evaluate(async (tags) => {
    // eslint-disable-next-line no-undef
    const r = await axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
    return r.violations.flatMap((v) =>
      v.nodes.map((n) => ({
        id: v.id,
        impact: n.impact ?? v.impact ?? 'minor',
        help: v.help,
        helpUrl: v.helpUrl,
        target: n.target.map((t) => (Array.isArray(t) ? t.join(' ') : t)).join(' >>> '),
        html: (n.html ?? '').slice(0, 160),
      })),
    );
  }, TAGS);
  return results;
}

const keyOf = (v) => `${v.id}|${v.target}`;

/**
 * Compares base and head violations by rule + selector.
 * Returns { added, resolved, unchanged } (added/resolved sorted by severity).
 */
export function a11yDelta(before = [], after = []) {
  const b = new Map(before.map((v) => [keyOf(v), v]));
  const a = new Map(after.map((v) => [keyOf(v), v]));
  const byImpact = (x, y) => (IMPACT[y.impact] ?? 0) - (IMPACT[x.impact] ?? 0) || x.id.localeCompare(y.id);
  const added = [...a].filter(([k]) => !b.has(k)).map(([, v]) => v).sort(byImpact);
  const resolved = [...b].filter(([k]) => !a.has(k)).map(([, v]) => v).sort(byImpact);
  return { added, resolved, unchanged: [...a.keys()].filter((k) => b.has(k)).length };
}
