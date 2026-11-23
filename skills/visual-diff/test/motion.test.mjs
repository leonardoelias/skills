import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { encodeMotionGif, recordMotion, resample, runSteps } from '../src/motion.mjs';

describe('resample', () => {
  test('a still page with one frame repeats the frame on every tick', () => {
    assert.deepEqual(resample([{ t: 0 }], 10, 2500), new Array(25).fill(0));
    assert.deepEqual(resample([{ t: 5 }], 10, 500), [0, 0, 0, 0, 0]);
  });

  test('with gaps, each tick uses the last frame already shown', () => {
    const frames = [{ t: 0 }, { t: 230 }, { t: 270 }, { t: 905 }];
    assert.deepEqual(resample(frames, 10, 1000), [0, 0, 1, 2, 2, 2, 2, 2, 2, 3]);
  });

  test('returns the original indices even with frames out of order', () => {
    assert.deepEqual(resample([{ t: 500 }, { t: 0 }], 10, 1000), [1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
  });

  test('the number of ticks follows duration × fps (at least 1) and an empty list gives []', () => {
    const frames = [{ t: 0 }, { t: 100 }];
    assert.equal(resample(frames, 10, 2500).length, 25);
    assert.equal(resample(frames, 12, 1000).length, 12);
    assert.equal(resample(frames, 10, 0).length, 1);
    assert.deepEqual(resample([], 10, 1000), []);
  });
});

describe('with Chromium', () => {
  let browser;
  let dir;
  before(async () => {
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
    dir = mkdtempSync(path.join(tmpdir(), 'visual-diff-motion-'));
  });
  after(async () => {
    await browser?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('runSteps runs the steps and skips missing selectors', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <button id="ok" onclick="this.dataset.clicked = 'yes'">ok</button>
        <input id="field">
        <div style="height: 3000px"></div>`);
      const skipped = await runSteps(page, [
        { click: '#ok' },
        { hover: '#does-not-exist' },
        { type: { selector: '#field', text: 'hello' } },
        { press: 'Tab' },
        { scroll: 400 },
        { wait: 10 },
        { focus: '.not-this-either' },
      ]);
      assert.deepEqual(skipped, ['hover #does-not-exist', 'focus .not-this-either']);
      assert.equal(await page.getAttribute('#ok', 'data-clicked'), 'yes');
      assert.equal(await page.inputValue('#field'), 'hello');
      assert.equal(await page.evaluate(() => window.scrollY), 400);
    } finally {
      await page.close();
    }
  });

  test('runSteps without skipMissing fails on a missing selector', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<p>nothing</p>');
      await assert.rejects(runSteps(page, [{ click: '#gone' }], { timeoutMs: 300, skipMissing: false }), /step "click #gone" failed/);
    } finally {
      await page.close();
    }
  });

  test('records animations on both sides and encodes the side-by-side GIF', async () => {
    const html = (css) => `<!doctype html><style>
      body { margin: 0; background: #fff; }
      .box { width: 60px; height: 60px; margin: 30px; background: #2563eb; }
      ${css}
    </style><div class="box"></div><p style="margin: 30px">static text</p>`;
    const pages = {
      '/move': html('@keyframes k { to { transform: translateX(240px); } } .box { animation: k 800ms steps(4, end) infinite; }'),
      '/color': html('@keyframes k { to { background: #dc2626; } } .box { animation: k 800ms steps(4, end) infinite; }'),
      '/still': html(''),
    };
    const prepareContext = (context) =>
      context.route('http://motion.test/**', (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: pages[new URL(route.request().url()).pathname] ?? '' }));
    const record = (pathname, steps = []) =>
      recordMotion(browser, {
        url: `http://motion.test${pathname}`,
        contextOptions: { viewport: { width: 480, height: 240 } },
        prepareContext,
        steps,
        durationMs: 800,
        fps: 10,
      });

    const move1 = await record('/move', [{ hover: '#does-not-exist' }]);
    const move2 = await record('/move');
    const color = await record('/color');
    const still = await record('/still');
    assert.equal(move1.status, 200);
    assert.deepEqual(move1.skipped, ['hover #does-not-exist']);
    assert.ok(move1.frames.length > 1, 'an animation produces several frames');
    assert.equal(still.frames.length, 1, 'a still page produces a single frame');
    assert.ok(move1.frames.every((f) => f.data.subarray(1, 4).toString() === 'PNG'));

    const opts = { fps: 10, durationMs: 800, maxWidth: 240, browser };
    const different = await encodeMotionGif({ before: move1.frames, after: color.frames }, { ...opts, title: 'move × color', outFile: path.join(dir, 'different.gif') });
    assert.ok(existsSync(different.file));
    assert.equal(readFileSync(different.file).subarray(0, 6).toString(), 'GIF89a');
    assert.ok(different.frameCount > 1);
    assert.ok(different.distinct.before > 1 && different.distinct.after > 1);
    assert.equal(different.changed, true);

    const same = await encodeMotionGif({ before: move1.frames, after: move2.frames }, { ...opts, outFile: path.join(dir, 'same.gif') });
    assert.ok(same.frameCount > 1);
    assert.equal(same.changed, false);

    const stillGif = await encodeMotionGif({ before: still.frames, after: still.frames }, { fps: 10, durationMs: 800, outFile: path.join(dir, 'still.gif') });
    assert.deepEqual({ frameCount: stillGif.frameCount, changed: stillGif.changed }, { frameCount: 1, changed: false });
    assert.equal(readFileSync(stillGif.file).subarray(0, 6).toString(), 'GIF89a');
  });
});
