import path from 'node:path';
import { PNG } from 'pngjs';
import { SKILL_ROOT } from './config.mjs';
import { log, routeSlug, sh } from './util.mjs';

const FREEZE_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important;
  transition-duration: 0s !important; transition-delay: 0s !important;
  caret-color: transparent !important; scroll-behavior: auto !important;
}
::-webkit-scrollbar { display: none !important; }
html { scrollbar-width: none !important; }
nextjs-portal, [data-nextjs-toast], [data-nextjs-dev-tools-button], #__next-build-watcher, vite-error-overlay, astro-dev-toolbar, #svelte-announcer:empty { display: none !important; }
`;

// Analytics, chat and ads: they make the capture unstable and send traffic out on every run.
export const DEFAULT_BLOCKED_HOSTS = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'googlesyndication.com', 'facebook.net',
  'connect.facebook.net', 'segment.io', 'segment.com', 'cdn.segment.com', 'hotjar.com', 'hotjar.io', 'clarity.ms',
  'intercom.io', 'intercomcdn.com', 'widget.intercom.io', 'crisp.chat', 'drift.com', 'driftt.com', 'zdassets.com',
  'zopim.com', 'tawk.to', 'mixpanel.com', 'amplitude.com', 'posthog.com', 'plausible.io', 'fullstory.com',
  'heap.io', 'heapanalytics.com', 'sentry.io', 'ingest.sentry.io', 'datadoghq-browser-agent.com', 'browser-intake-datadoghq.com',
  'newrelic.com', 'nr-data.net', 'hs-scripts.com', 'hs-analytics.net', 'hubspot.com', 'linkedin.com/px', 'ads-twitter.com',
  'tiktok.com/i18n/pixel', 'bat.bing.com', 'vercel-insights.com', 'va.vercel-scripts.com',
];

export async function launchBrowser({ headless = true } = {}) {
  const { chromium } = await import('playwright');
  const opts = {
    headless,
    channel: process.env.VISUAL_DIFF_BROWSER_CHANNEL || undefined,
    // Same text and colors across machines; the pipeline handles the signals (SRV-1).
    args: ['--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb', '--hide-scrollbars', '--disable-skia-runtime-opts', '--disable-font-subpixel-positioning'],
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  };
  try {
    return await chromium.launch(opts);
  } catch (e) {
    if (!/Executable doesn't exist|playwright install/i.test(e.message)) throw e;
    log("downloading Playwright's Chromium (first time only, ~150 MB)…");
    sh(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['playwright', 'install', 'chromium'], { cwd: SKILL_ROOT, step: 'browser' });
    return await chromium.launch(opts);
  }
}

/** Is Playwright's Chromium installed? Downloads nothing. */
export async function browserInstalled() {
  try {
    const { chromium } = await import('playwright');
    const exe = chromium.executablePath();
    const { existsSync } = await import('node:fs');
    return { ok: existsSync(exe), path: exe };
  } catch (e) {
    return { ok: false, path: null, error: e.message };
  }
}

export const captureKey = (route, vp, theme) => `${routeSlug(route)}__${vp.name}__${theme.name}`;

export function buildUrl(base, route, theme, extraQuery = {}) {
  const u = new URL(route, base + '/');
  for (const [k, v] of Object.entries({ ...(theme?.query ?? {}), ...extraQuery })) u.searchParams.set(k, v);
  return u.toString();
}

/** Browser context options for a viewport and theme. */
export function contextOptions(vp, theme, cfg, auth) {
  return {
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor ?? 1,
    isMobile: !!vp.isMobile,
    hasTouch: !!vp.hasTouch,
    colorScheme: theme?.colorScheme ?? 'light',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    locale: cfg.capture.locale,
    timezoneId: cfg.capture.timezone,
    ...(auth?.storageState ? { storageState: auth.storageState } : {}),
  };
}

// Runs inside the page, before any of its scripts.
function determinism({ seed, theme }) {
  let s = seed >>> 0;
  const rand = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  Math.random = rand;
  try {
    if (globalThis.crypto) {
      const fill = (arr) => {
        const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
        for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(rand() * 256);
        return arr;
      };
      crypto.getRandomValues = fill;
      crypto.randomUUID = () => {
        const b = fill(new Uint8Array(16));
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
      };
    }
  } catch {}

  // Timer registry: __vdFreeze() stops everything that moves on its own (carousels, clocks).
  const intervals = new Set();
  const timeouts = new Set();
  const [si, ci, st, ct, raf] = [window.setInterval, window.clearInterval, window.setTimeout, window.clearTimeout, window.requestAnimationFrame];
  let frozen = false;
  window.setInterval = function (fn, ms, ...rest) {
    if (frozen) return 0;
    const id = si.call(window, fn, ms, ...rest);
    intervals.add(id);
    return id;
  };
  window.clearInterval = function (id) {
    intervals.delete(id);
    return ci.call(window, id);
  };
  window.setTimeout = function (fn, ms, ...rest) {
    if (frozen) return 0;
    let id;
    const wrapped = typeof fn === 'function' ? function (...args) { timeouts.delete(id); return fn.apply(this, args); } : fn;
    id = st.call(window, wrapped, ms, ...rest);
    timeouts.add(id);
    return id;
  };
  window.clearTimeout = function (id) {
    timeouts.delete(id);
    return ct.call(window, id);
  };
  window.requestAnimationFrame = function (cb) {
    return frozen ? 0 : raf.call(window, cb);
  };
  const pauseVideos = () => {
    for (const v of document.querySelectorAll('video')) {
      try {
        v.autoplay = false;
        v.pause();
        v.currentTime = 0;
      } catch {}
    }
  };
  Object.defineProperty(window, '__vdFreeze', {
    value: () => {
      frozen = true;
      intervals.forEach((id) => ci.call(window, id));
      timeouts.forEach((id) => ct.call(window, id));
      try {
        document.getAnimations().forEach((a) => a.pause());
      } catch {}
      pauseVideos();
    },
  });

  // Theme via localStorage, class or attribute on <html> (next-themes and similar).
  try {
    for (const [k, v] of Object.entries(theme.localStorage ?? {})) localStorage.setItem(k, v);
  } catch {}
  const applyHtml = () => {
    const el = document.documentElement;
    if (!el) return;
    if (theme.htmlClass) el.classList.add(...theme.htmlClass.split(/\s+/).filter(Boolean));
    for (const [k, v] of Object.entries(theme.htmlAttr ?? {})) el.setAttribute(k, v);
  };
  applyHtml();
  document.addEventListener('DOMContentLoaded', () => {
    applyHtml();
    pauseVideos();
  });
  window.addEventListener('load', () => {
    applyHtml();
    pauseVideos();
  });
}

const hostBlocked = (url, hosts) => {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const full = u.hostname + u.pathname;
  return hosts.some((h) => (h.includes('/') ? full.startsWith(h) || full.includes('.' + h) : u.hostname === h || u.hostname.endsWith('.' + h)));
};

/**
 * Auth headers and cookies (only on the side's origin, and only if auth.origins allows it), blocked
 * hosts and determinism and theme scripts.
 */
export async function prepareContext(context, { cfg, theme, origin, auth, isPreview, seed = 0x2f6b4a1d }) {
  const allowAuth = auth && (isPreview ? auth.origins.includes('previews') : auth.origins.includes('local'));
  const headers = allowAuth && auth.headers && Object.keys(auth.headers).length ? auth.headers : null;
  const blocked = [...(cfg.capture.blockDefaultHosts ? DEFAULT_BLOCKED_HOSTS : []), ...cfg.capture.blockHosts];
  if (headers || blocked.length) {
    await context.route('**/*', (route) => {
      const req = route.request();
      const url = req.url();
      if (blocked.length && hostBlocked(url, blocked) && !url.startsWith(origin)) return route.abort('blockedbyclient');
      if (headers && url.startsWith(origin + '/')) return route.continue({ headers: { ...req.headers(), ...headers } });
      return route.continue();
    });
  }
  const cookies = [];
  for (const c of allowAuth ? auth.cookies : []) cookies.push(c.domain ? { name: c.name, value: c.value, domain: c.domain, path: c.path ?? '/' } : { name: c.name, value: c.value, url: origin });
  for (const [name, value] of Object.entries(theme?.cookie ?? {})) cookies.push({ name, value, url: origin });
  if (cookies.length) await context.addCookies(cookies);
  await context.addInitScript(determinism, { seed, theme: theme ?? {} });
}

async function waitIdle(page, ms) {
  if (ms > 0) await page.waitForLoadState('networkidle', { timeout: ms }).catch(() => {});
}

/** capture.waitFor / routes[].waitFor: CSS selector or "js:<expression>". Returns false if it timed out. */
async function waitForCondition(page, cond, timeout = 15_000) {
  try {
    if (cond.startsWith('js:')) await page.waitForFunction(cond.slice(3), null, { timeout });
    else await page.waitForSelector(cond, { state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

/** Box (image px) of the pixels that differ between two PNGs of the same size. */
export function changedBox(pngA, pngB) {
  const a = PNG.sync.read(pngA);
  const b = PNG.sync.read(pngB);
  if (a.width !== b.width || a.height !== b.height) return { x: 0, y: Math.min(a.height, b.height), w: Math.max(a.width, b.width), h: Math.abs(a.height - b.height) || 1 };
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  const w = a.width;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) {
      const p = i / 4;
      const x = p % w;
      const y = (p - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Short selector of the element at the center of a box (page CSS px), to suggest capture.mask. */
async function selectorAt(page, box) {
  return page.evaluate(({ cx, cy }) => {
    window.scrollTo(0, Math.max(0, cy - window.innerHeight / 2));
    const el = document.elementFromPoint(Math.min(cx, window.innerWidth - 1), cy - window.scrollY);
    window.scrollTo(0, 0);
    if (!el) return null;
    const describe = (e) => {
      if (e.id && /^[a-zA-Z][\w-]*$/.test(e.id)) return `#${e.id}`;
      const testid = e.getAttribute('data-testid');
      if (testid) return `[data-testid="${testid}"]`;
      const cls = [...e.classList].filter((c) => /^[a-zA-Z][\w-]*$/.test(c) && c.length < 40).slice(0, 2);
      return e.tagName.toLowerCase() + cls.map((c) => '.' + c).join('');
    };
    // Climbs to an ancestor with an id/class, which is what usually gets masked (carousel, clock).
    let cur = el;
    for (let i = 0; i < 4 && cur.parentElement && !cur.id && !cur.classList.length; i++) cur = cur.parentElement;
    return describe(cur);
  }, { cx: box.x + box.w / 2, cy: box.y + box.h / 2 });
}

/**
 * Captures a URL. Never throws on HTTP 4xx/5xx: returns { ok: false, status } for the pipeline to decide
 * (new, removed or broken page). Success: { ok, status, finalUrl, png, stable, frozen, truncated,
 * fullHeightCss, unstable: { box, selector } | null, waitForTimedOut, extra }.
 * onPage(page) runs after the screenshot, on the same page (e.g. axe).
 */
export async function captureOne(browser, { target, vp, theme, cfg, runStart, auth, isPreview, waitFor, onPage }) {
  const context = await browser.newContext(contextOptions(vp, theme, cfg, auth));
  const origin = new URL(target).origin;
  try {
    await prepareContext(context, { cfg, theme, origin, auth, isPreview });
    const page = await context.newPage();
    if (cfg.capture.fixedTime) {
      const t = cfg.capture.fixedTime === 'run-start' ? runStart : new Date(cfg.capture.fixedTime);
      await page.clock.setFixedTime(t);
    }
    const resp = await page.goto(target, { waitUntil: 'load', timeout: 60_000 });
    const status = resp?.status() ?? 0;
    const finalUrl = page.url();
    if (status >= 400) return { ok: false, status, finalUrl, error: `HTTP ${status}` };

    await waitIdle(page, cfg.capture.networkIdleMs);
    const cond = waitFor ?? cfg.capture.waitFor;
    const waitForTimedOut = cond ? !(await waitForCondition(page, cond)) : false;
    await page.addStyleTag({ content: FREEZE_CSS + cfg.capture.hide.map((s) => `${s}{visibility:hidden!important}`).join('\n') });

    // Scrolls to trigger lazy loading, with a cap on steps and height (infinite feeds), and goes back to the top.
    await page.evaluate(
      async ({ maxHeight, maxSteps }) => {
        const step = window.innerHeight;
        for (let i = 0, y = 0; i < maxSteps && y < Math.min(document.documentElement.scrollHeight, maxHeight); i++, y += step) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 30));
        }
        window.scrollTo(0, 0);
        await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 5000))]);
        await Promise.all(
          [...document.images].filter((i) => !i.complete).map((i) => new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 5000); })),
        );
      },
      { maxHeight: cfg.capture.maxHeight, maxSteps: cfg.capture.maxScrollSteps },
    );
    await waitIdle(page, Math.min(2000, cfg.capture.networkIdleMs));
    await page.waitForTimeout(cfg.capture.settleMs);

    const fullHeightCss = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0));
    const truncated = cfg.capture.fullPage && fullHeightCss > cfg.capture.maxHeight;
    const mask = [...cfg.capture.mask, ...cfg.capture.maskEmbeds].map((sel) => page.locator(sel));
    const opts = {
      fullPage: cfg.capture.fullPage,
      animations: 'disabled',
      caret: 'hide',
      mask,
      maskColor: '#ff00ff',
      ...(truncated ? { clip: { x: 0, y: 0, width: vp.width, height: cfg.capture.maxHeight } } : {}),
    };

    // Repeats until two captures in a row are identical. After 2 changes, stops timers and animations.
    let prev = await page.screenshot(opts);
    let stable = false;
    let frozen = false;
    let changes = 0;
    let lastPair = null;
    for (let i = 0; i < cfg.capture.maxRetakes; i++) {
      await page.waitForTimeout(cfg.capture.settleMs);
      const next = await page.screenshot(opts);
      if (next.equals(prev)) {
        stable = true;
        prev = next;
        break;
      }
      changes++;
      lastPair = [prev, next];
      if (changes === 2 && !frozen) {
        await page.evaluate(() => window.__vdFreeze?.()).catch(() => {});
        frozen = true;
      }
      prev = next;
    }
    let unstable = null;
    if (lastPair) {
      const box = changedBox(lastPair[0], lastPair[1]);
      if (box) {
        const scale = vp.deviceScaleFactor ?? 1;
        const css = { x: Math.round(box.x / scale), y: Math.round(box.y / scale), w: Math.round(box.w / scale), h: Math.round(box.h / scale) };
        unstable = { box: css, selector: await selectorAt(page, css).catch(() => null) };
      }
    }
    const extra = onPage ? await onPage(page).catch((e) => ({ error: e.message })) : undefined;
    return { ok: true, status, finalUrl, png: prev, stable, frozen, truncated, fullHeightCss, unstable, waitForTimedOut, extra };
  } finally {
    await context.close().catch(() => {});
  }
}

/** Path of a capture's PNG file. */
export const captureFile = (dir, key) => path.join(dir, `${key}.png`);
