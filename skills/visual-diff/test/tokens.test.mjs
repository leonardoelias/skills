import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { auditTokens, collectStyles, newFindings, oklabDistance, parseRgb, readTokens } from '../src/tokens.mjs';

describe('parseRgb', () => {
  test('accepts rgb(), rgba(), space syntax and 3, 4, 6 and 8 digit hex', () => {
    assert.deepEqual(parseRgb('rgb(1, 2, 3)'), [1, 2, 3, 1]);
    assert.deepEqual(parseRgb('rgba(1,2,3,0.5)'), [1, 2, 3, 0.5]);
    assert.deepEqual(parseRgb('rgb(1 2 3 / 50%)'), [1, 2, 3, 0.5]);
    assert.deepEqual(parseRgb('#abc'), [170, 187, 204, 1]);
    assert.deepEqual(parseRgb('#abcd'), [170, 187, 204, 0.867]);
    assert.deepEqual(parseRgb('#0055FF'), [0, 85, 255, 1]);
    assert.deepEqual(parseRgb('#00000080'), [0, 0, 0, 0.502]);
    assert.deepEqual(parseRgb('transparent'), [0, 0, 0, 0]);
  });

  test('returns null for what is not a color', () => {
    for (const value of ['', 'red', '#12', '#12345', 'rgb(1, 2)', 'hsl(0 0% 0%)', '8px', null, undefined, 42]) {
      assert.equal(parseRgb(value), null, String(value));
    }
  });
});

describe('oklabDistance', () => {
  test('equal colors = 0; black × white ≈ 1; close colors stay below 0.02', () => {
    assert.equal(oklabDistance([10, 20, 30], [10, 20, 30]), 0);
    assert.ok(Math.abs(oklabDistance([0, 0, 0], [255, 255, 255]) - 1) < 0.001);
    assert.ok(oklabDistance([0, 85, 255], [0, 86, 254]) < 0.02);
    assert.ok(oklabDistance([0, 85, 255], [255, 0, 0]) > 0.2);
  });
});

const TOKENS = {
  colors: [
    { name: '--color-brand', value: 'rgb(0, 85, 255)', rgb: [0, 85, 255, 1] },
    { name: '--color-text', value: 'rgb(17, 24, 39)', rgb: [17, 24, 39, 1] },
  ],
  spacing: [
    { name: '--space-2', px: 8 },
    { name: '--space-3', px: 12 },
  ],
};

describe('auditTokens', () => {
  const styles = [
    { selector: '.ok', prop: 'color', value: 'rgb(0, 85, 255)', kind: 'color', rgb: [0, 85, 255, 1] },
    { selector: '.near', prop: 'color', value: 'rgb(0, 86, 254)', kind: 'color', rgb: [0, 86, 254, 1] },
    { selector: '.bad', prop: 'background-color', value: 'rgb(255, 0, 0)', kind: 'color', rgb: [255, 0, 0, 1] },
    { selector: '.bad', prop: 'background-color', value: 'rgb(255, 0, 0)', kind: 'color', rgb: [255, 0, 0, 1] },
    { selector: '.ok', prop: 'padding', value: '8px', kind: 'spacing', px: 8 },
    { selector: '.ok', prop: 'margin-top', value: '-12px', kind: 'spacing', px: -12 },
    { selector: '.almost', prop: 'gap', value: '8.4px', kind: 'spacing', px: 8.4 },
    { selector: '.bad', prop: 'padding', value: '13px', kind: 'spacing', px: 13 },
    { selector: '.black', prop: 'color', value: 'rgb(0, 0, 0)', kind: 'color' },
  ];

  test('reports only what falls outside the tokens, with the nearest token and no repeated key', () => {
    const findings = auditTokens(styles, TOKENS);
    assert.deepEqual(findings.map((f) => f.key), [
      'color|.bad|background-color|rgb(255, 0, 0)',
      'spacing|.bad|padding|13px',
      'color|.black|color|rgb(0, 0, 0)',
    ]);
    const padding = findings.find((f) => f.prop === 'padding');
    assert.deepEqual(padding.nearest, { name: '--space-3', value: '12px', distance: 1 });
    const black = findings.find((f) => f.selector === '.black');
    assert.equal(black.nearest.name, '--color-text');
    assert.ok(black.nearest.distance > 0.02);
  });

  test('allow accepts colors and lengths; tolerances are configurable', () => {
    const findings = auditTokens(styles, TOKENS, { allow: ['rgb(0, 0, 0)', '13px'] });
    assert.deepEqual(findings.map((f) => f.selector), ['.bad']);
    assert.equal(auditTokens(styles, TOKENS, { colorTolerance: 0.0001 }).some((f) => f.selector === '.near'), true);
    assert.equal(auditTokens(styles, TOKENS, { spacingTolerance: 0.1 }).some((f) => f.selector === '.almost'), true);
  });

  test('without tokens of a type, that type is not audited', () => {
    assert.deepEqual(auditTokens(styles, { colors: TOKENS.colors, spacing: [] }).map((f) => f.kind), ['color', 'color']);
    assert.deepEqual(auditTokens(styles, { colors: [], spacing: TOKENS.spacing }).map((f) => f.kind), ['spacing']);
    assert.deepEqual(auditTokens(styles, {}), []);
  });
});

describe('newFindings', () => {
  const finding = (selector, prop, value, kind = 'color') => ({ kind, selector, prop, value, nearest: null, key: `${kind}|${selector}|${prop}|${value}` });

  test('keeps only what did not exist on the base, by key or by kind + prop + value', () => {
    const base = [finding('.a', 'color', 'rgb(255, 0, 0)'), finding('.b', 'padding', '13px', 'spacing')];
    const head = [
      finding('.a', 'color', 'rgb(255, 0, 0)'),
      finding('div.b:nth-of-type(2)', 'padding', '13px', 'spacing'),
      finding('.a', 'background-color', 'rgb(255, 0, 0)'),
      finding('.c', 'margin', '13px', 'spacing'),
    ];
    assert.deepEqual(newFindings(base, head).map((f) => f.key), [
      'color|.a|background-color|rgb(255, 0, 0)',
      'spacing|.c|margin|13px',
    ]);
    assert.equal(newFindings([], head).length, 4);
    assert.deepEqual(newFindings(head, []), []);
  });
});

describe('with Chromium', () => {
  let browser;
  let page;
  before(async () => {
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent(`<!doctype html><style>
      :root { --color-brand: #0055ff; --space-2: 8px; --font-size-lg: 13px; --radius: 4px; --shadow: 0 1px 2px rgba(0,0,0,.2); }
      @media (min-width: 1px) { :root { --color-accent: oklch(0.7 0.15 150); } }
      body { margin: 8px; color: rgb(0, 85, 255); }
      .token { color: var(--color-brand); padding: var(--space-2); }
      .near { color: #0056fe; }
      .bad { color: #ff0000; padding: 13px; }
      .ghost { color: #ff00ff; padding: 21px; visibility: hidden; }
    </style>
    <div class="token">token</div>
    <div class="near">near</div>
    <div class="bad">outside</div>
    <div class="ghost">invisible</div>
    <div class="far" style="position:absolute;top:1500px;color:#00ff00;padding:31px">far</div>`);
  });
  after(async () => {
    await browser?.close();
  });

  test('readTokens reads colors and spacing from :root and respects include', async () => {
    const tokens = await readTokens(page);
    const colors = Object.fromEntries(tokens.colors.map((t) => [t.name, t]));
    assert.deepEqual(colors['--color-brand'], { name: '--color-brand', value: 'rgb(0, 85, 255)', rgb: [0, 85, 255, 1] });
    assert.ok(colors['--color-accent'], 'an oklch color inside @media becomes a token');
    assert.equal(colors['--color-accent'].rgb.length, 4);
    assert.deepEqual(tokens.spacing, [{ name: '--space-2', px: 8 }], 'font, radius and shadow are not spacing');

    const only = await readTokens(page, { include: ['--space-*', '--font-size-'] });
    assert.deepEqual(only.colors, []);
    assert.deepEqual(only.spacing.map((t) => t.name).sort(), ['--font-size-lg', '--space-2']);
  });

  test('collects styles in the regions and reports only what falls outside the tokens', async () => {
    const tokens = await readTokens(page);
    const styles = await collectStyles(page, { regions: [{ x: 0, y: 0, w: 800, h: 600 }] });
    assert.ok(styles.some((s) => s.selector === 'div.token' && s.prop === 'padding' && s.value === '8px' && s.px === 8));
    assert.ok(!styles.some((s) => s.selector === 'div.ghost'), 'an invisible element stays out');
    assert.ok(!styles.some((s) => s.selector === 'div.far'), 'an element outside the region stays out');
    assert.ok(!styles.some((s) => s.selector === 'div.token' && s.prop === 'color'), "an inherited color equal to the parent's is not repeated");

    const findings = auditTokens(styles, tokens);
    assert.deepEqual(findings.map((f) => f.key).sort(), [
      'color|div.bad|color|rgb(255, 0, 0)',
      'spacing|div.bad|padding|13px',
    ]);

    assert.deepEqual(await collectStyles(page, { regions: [] }), []);
    const all = await collectStyles(page);
    assert.ok(all.some((s) => s.selector === 'div.far' && s.prop === 'padding' && s.value === '31px'));
    assert.equal((await collectStyles(page, { maxElements: 2 })).length > 0, true);
  });
});
