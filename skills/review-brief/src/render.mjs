// Opens the page in headless Chromium with the same script as the Artifact, saves a PNG of each chart and looks for
// labels and lines that overlap. With `shots`, it also saves the whole page (desktop, dark desktop and mobile) and
// checks that nothing goes past the window width.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SKILL_ROOT, wrapPage } from './page.mjs';
import { CliError } from './run.mjs';

export function findChromium() {
  const candidates = [process.env.PW_DIR, process.cwd(), SKILL_ROOT, path.join(SKILL_ROOT, '..', 'visual-diff')].filter(Boolean);
  for (const dir of candidates) {
    try {
      return createRequire(path.join(path.resolve(dir), 'noop.js'))('playwright').chromium;
    } catch {
      // try the next folder
    }
  }
  throw new CliError('Playwright not found. It comes with the visual-diff skill; without it, install it in a folder and point PW_DIR to it:\n'
    + '  npm i --prefix /tmp/review-brief-pw playwright && npx --prefix /tmp/review-brief-pw playwright install chromium\n'
    + '  PW_DIR=/tmp/review-brief-pw node <skill>/bin/review-brief.mjs render <page>');
}

// Runs inside the page: a drawn chart has boxes (g.node) and arrows (g.edge) with labels.
function chartProblems(element) {
  if (!element.querySelector(':scope > svg')) return ['did not draw (see the console errors)'];
  const problems = [];
  const box = (nodes) => {
    const rects = nodes.map((n) => n.getBoundingClientRect());
    return {
      left: Math.min(...rects.map((r) => r.left)),
      top: Math.min(...rects.map((r) => r.top)),
      right: Math.max(...rects.map((r) => r.right)),
      bottom: Math.max(...rects.map((r) => r.bottom)),
    };
  };
  // 1px of slack: edges that only touch do not count.
  const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
  const words = (group) => [...group.querySelectorAll('text')].map((t) => t.textContent).join(' ');

  const nodes = [...element.querySelectorAll('g.node')].map((g) => ({
    g,
    label: words(g),
    shape: box([g.querySelector(':scope > :is(path, polygon, ellipse)')].filter(Boolean)),
  }));
  const labels = [...element.querySelectorAll('g.edge')].filter((g) => g.querySelector('text')).map((g) => ({
    g,
    label: words(g),
    rect: box([...g.querySelectorAll('text')]),
  }));

  for (const node of nodes) {
    const t = box([...node.g.querySelectorAll('text')]);
    if (t.left < node.shape.left + 2 || t.right > node.shape.right - 2) problems.push(`the text of the box “${node.label}” is wider than the box`);
  }
  labels.forEach((a, i) => {
    for (const b of labels.slice(i + 1)) if (overlap(a.rect, b.rect)) problems.push(`the label “${a.label}” covers the label “${b.label}”`);
    for (const node of nodes) if (overlap(a.rect, node.shape)) problems.push(`the label “${a.label}” covers the box “${node.label}”`);
  });
  for (const edge of element.querySelectorAll('g.edge')) {
    const line = edge.querySelector('path');
    if (!line) continue;
    const matrix = line.getScreenCTM();
    const length = line.getTotalLength();
    // Also the arrow itself: with the font measured wrong, the label grows over its own line.
    for (const label of labels) {
      for (let at = 0; at <= length; at += 3) {
        const p = line.getPointAtLength(at);
        const q = new DOMPoint(p.x, p.y).matrixTransform(matrix);
        const r = label.rect;
        if (q.x > r.left + 2 && q.x < r.right - 2 && q.y > r.top + 2 && q.y < r.bottom - 2) {
          problems.push(label.g === edge ? `the arrow crosses its own label “${label.label}”` : `a line crosses the label “${label.label}”`);
          break;
        }
      }
    }
  }
  return problems;
}

export async function render(pagePath, { out, shots = false } = {}) {
  const chromium = findChromium();
  out = path.resolve(out ?? path.join(path.dirname(path.resolve(pagePath)), 'render'));
  mkdirSync(out, { recursive: true });
  const wrapped = path.join(out, 'page.html');
  writeFileSync(wrapped, wrapPage(readFileSync(pagePath, 'utf8')));

  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const problems = [];
  const files = [];
  try {
    const open = async ({ width, height, scheme = 'light', mobile = false }) => {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: scheme, isMobile: mobile, hasTouch: mobile });
      const page = await context.newPage();
      page.on('console', (m) => {
        if (m.type() === 'error' || m.type() === 'warning') problems.push(`console (${width}px ${scheme}): ${m.text()}`);
      });
      page.on('pageerror', (e) => problems.push(`script error (${width}px ${scheme}): ${e.message}`));
      await page.goto(pathToFileURL(wrapped).href);
      await page.waitForFunction(() => document.documentElement.dataset.briefCharts === '1', null, { timeout: 60000 });
      await page.evaluate(() => document.fonts.ready);
      return { context, page };
    };

    const { context, page } = await open({ width: 1440, height: 1000 });
    const charts = await page.$$('.chart');
    for (const [i, chart] of charts.entries()) {
      const file = path.join(out, `chart-${i + 1}.png`);
      await chart.screenshot({ path: file });
      files.push(file);
      for (const p of await chart.evaluate(chartProblems)) problems.push(`chart ${i + 1}: ${p}`);
    }

    if (shots) {
      const views = [
        { name: 'page-desktop', page, context: null },
        { name: 'page-desktop-dark', ...(await open({ width: 1440, height: 1000, scheme: 'dark' })) },
        { name: 'page-mobile', ...(await open({ width: 390, height: 844, mobile: true })) },
      ];
      for (const view of views) {
        const wide = await view.page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        if (wide > 1) problems.push(`${view.name}: the page goes ${wide}px past the window width`);
        const file = path.join(out, `${view.name}.png`);
        await view.page.screenshot({ path: file, fullPage: true });
        files.push(file);
        await view.context?.close();
      }
    }
    await context.close();
  } finally {
    await browser.close();
  }
  return { problems, files, out };
}
