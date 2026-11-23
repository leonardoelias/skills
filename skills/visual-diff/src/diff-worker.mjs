// Runs diffImages off the main thread (pixelmatch is synchronous and heavy on long pages).
import { parentPort, workerData } from 'node:worker_threads';
import { diffImages } from './diff.mjs';

try {
  const { before, after, opts } = workerData;
  parentPort.postMessage({ ok: true, result: diffImages(before, after, opts) });
} catch (e) {
  parentPort.postMessage({ ok: false, error: e.stack ?? String(e) });
}
