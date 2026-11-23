import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { diffImages, diffInWorker, readPng } from '../src/diff.mjs';
import { makePng, tmpDir, writePng } from './helpers.mjs';

const W = 120;
const dir = tmpDir('vd-diff-');

/**
 * Synthetic page: "text lines" with a unique pattern (each one 6 px tall) separated by
 * 6 px of background. blocks: list of { kind: 'text', id } | { kind: 'gap', h }.
 */
function page(blocks, { bg = [255, 255, 255], noise = 0 } = {}) {
  const rows = [];
  for (const b of blocks) {
    if (b.kind === 'gap') for (let i = 0; i < b.h; i++) rows.push(null);
    else for (let i = 0; i < 6; i++) rows.push({ id: b.id, i });
    if (b.kind === 'text') for (let i = 0; i < 6; i++) rows.push(null);
  }
  return makePng(W, rows.length, (x, y) => {
    const r = rows[y];
    if (!r) return bg;
    // stable pseudo-random pattern per (id, row, x)
    let h = (r.id * 7919 + r.i * 104729 + x * 1299709) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    const on = h % 3 === 0;
    let v = on ? 20 : bg[0];
    if (noise && x % 17 === y % 17) v = Math.max(0, Math.min(255, v + noise));
    return on ? [v, v, v] : [v, bg[1], bg[2]];
  });
}

const text = (from, to) => Array.from({ length: to - from }, (_, i) => ({ kind: 'text', id: from + i }));
const file = (name, png) => writePng(path.join(dir, `${name}.png`), png);

test('equal images: kind none', () => {
  const a = file('same-a', page(text(0, 20)));
  const r = diffImages(a, a);
  assert.equal(r.kind, 'none');
  assert.equal(r.changedPixels, 0);
});

test('DIF-2: inserted space (margin only) counts as layout-shift, with the shift', () => {
  const a = file('gap-a', page([...text(0, 10), ...text(10, 30)]));
  const b = file('gap-b', page([...text(0, 10), { kind: 'gap', h: 48 }, ...text(10, 30)]));
  const r = diffImages(a, b);
  assert.equal(r.changedPixels, 0);
  assert.equal(r.kind, 'layout-shift');
  assert.equal(r.shifts.length, 1);
  assert.equal(r.shifts[0].by, 48);
  assert.equal(r.inserted.length, 1);
  assert.equal(r.inserted[0].blank, true);
  assert.ok(r.regionsTotal >= 1, 'the inserted strip becomes a region');
});

test('inserted content: only the new lines count; the rest just moved down', () => {
  const a = file('ins-a', page(text(0, 30)));
  const b = file('ins-b', page([...text(0, 10), ...text(100, 103), ...text(10, 30)]));
  const r = diffImages(a, b);
  assert.equal(r.kind, 'content');
  assert.ok(r.changedPixels > 0);
  // 3 new 6 px lines, ~1/3 of the pixels on: far less than the whole page
  assert.ok(r.changedPixels < 3 * 6 * W, `changed=${r.changedPixels}`);
  assert.equal(r.shifts[0].by, 36);
  const reg = r.regions[0];
  assert.ok(reg.y <= 120 + 36 && reg.y + reg.h >= 120, 'region around the insertion');
});

test('DIF-3: two insertions at different points produce two shifts', () => {
  const a = file('two-a', page(text(0, 40)));
  const b = file('two-b', page([...text(0, 10), { kind: 'gap', h: 20 }, ...text(10, 25), { kind: 'gap', h: 30 }, ...text(25, 40)]));
  const r = diffImages(a, b);
  assert.equal(r.changedPixels, 0);
  assert.deepEqual(r.shifts.map((s) => s.by), [20, 50]);
});

test('DIF-1: the diff has no yellow anti-aliasing pixels', () => {
  const a = file('aa-a', page(text(0, 20)));
  const b = file('aa-b', page([...text(0, 5), { kind: 'gap', h: 12 }, ...text(5, 12), ...text(200, 202), ...text(12, 20)]));
  const r = diffImages(a, b, { workDir: dir, key: 'aa' });
  const d = readPng(r.files.diff);
  let yellow = 0;
  for (let i = 0; i < d.data.length; i += 4) if (d.data[i] === 255 && d.data[i + 1] === 255 && d.data[i + 2] === 0) yellow++;
  assert.equal(yellow, 0);
});

test('DIF-3: nearly equal rows (rasterization) don\'t become a false positive', () => {
  const a = file('near-a', page(text(0, 60)));
  const b = file('near-b', page([{ kind: 'gap', h: 10 }, ...text(0, 60)], { noise: 12 }));
  const r = diffImages(a, b);
  assert.equal(r.changedPixels, 0);
  assert.equal(r.kind, 'layout-shift');
});

test('DIF-2: an empty row doesn\'t match a light border or a 2 px accent mark (Linux font)', () => {
  // Card with a #e2e8f0 border (difference of 29, below the 48 limit) and a row with only the tip of an
  // accent mark: the tolerant alignment matched those rows with the background and 2 "changed" pixels were left over.
  const CW = 1280;
  const LIGHT = [226, 232, 240];
  const cardRows = (top) => {
    const rows = new Map();
    rows.set(top, 'top');
    for (let y = top + 1; y < top + 16; y++) rows.set(y, 'side');
    rows.set(top + 16, 'accent');
    for (let y = top + 17; y < top + 29; y++) rows.set(y, `text${y - top}`);
    for (let y = top + 29; y < top + 41; y++) rows.set(y, 'side');
    rows.set(top + 41, 'top');
    return rows;
  };
  // Stable pseudo-random dark pixel per (row, x): each text row has a unique hash.
  const dot = (row, x) => {
    let h = (row * 7919 + x * 1299709) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
    return h % 3 === 0;
  };
  const card = (gap) => {
    const rows = cardRows(12 + gap);
    return makePng(CW, 200, (x, y) => {
      if (y < 12) return dot(y, x) ? [15, 23, 42] : [255, 255, 255];
      const r = rows.get(y);
      if (!r) return [255, 255, 255];
      if (r === 'top') return x >= 184 && x <= 476 ? LIGHT : [255, 255, 255];
      if (x === 184 || x === 476) return LIGHT;
      if (r === 'accent') return x === 230 || x === 231 ? [137, 141, 150] : [255, 255, 255];
      if (r.startsWith('text')) return x > 200 && x < 460 && dot(100 + Number(r.slice(4)), x) ? [15, 23, 42] : [255, 255, 255];
      return [255, 255, 255];
    });
  };
  const r = diffImages(file('card-a', card(48)), file('card-b', card(72)));
  assert.equal(r.changedPixels, 0);
  assert.equal(r.kind, 'layout-shift');
  assert.ok(r.shifts.some((s) => s.by === 24), JSON.stringify(r.shifts));
  assert.ok(r.inserted.every((i) => i.blank), JSON.stringify(r.inserted));
});

test('a removal is reported and counts as a change', () => {
  const a = file('rm-a', page(text(0, 30)));
  const b = file('rm-b', page([...text(0, 10), ...text(14, 30)]));
  const r = diffImages(a, b);
  assert.equal(r.removed.length, 1);
  assert.ok(r.changedPixels > 0);
  assert.equal(r.kind, 'content');
});

test('DIF-5: different heights in a dark theme don\'t paint the leftover white', () => {
  const dark = [20, 20, 30];
  const a = file('dark-a', page(text(0, 10), { bg: dark }));
  const b = file('dark-b', page([...text(0, 10), { kind: 'gap', h: 40 }], { bg: dark }));
  const r = diffImages(a, b);
  assert.equal(r.changedPixels, 0);
  assert.equal(r.kind, 'layout-shift');
});

test('PERF-1: diffInWorker returns the same result', async () => {
  const a = file('w-a', page(text(0, 20)));
  const b = file('w-b', page([...text(0, 8), ...text(50, 51), ...text(8, 20)]));
  const local = diffImages(a, b);
  const remote = await diffInWorker(a, b, { workDir: dir, key: 'w' });
  assert.equal(remote.changedPixels, local.changedPixels);
  assert.deepEqual(remote.shifts, local.shifts);
});
