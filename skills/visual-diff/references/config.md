# visual-diff.config.json

Lives at the repository root. Every key is optional; `init` suggests a starting point.
The config is validated: an unknown key or a key with the wrong type stops the command, with a
suggestion ("did you mean `capture`?"). The JSON Schema is in `visual-diff.schema.json` (`init`
points to the file in `$schema` when the skill is inside the repo, so the editor can complete and validate).

```json
{
  "$schema": "./.claude/skills/visual-diff/visual-diff.schema.json",
  "appDir": "apps/web",
  "startCommand": "npm run dev -- --port {port}",
  "baseUrl": "http://localhost:{port}",
  "installCommand": null,
  "deps": "auto",
  "startTimeoutMs": 90000,
  "env": { "NEXT_TELEMETRY_DISABLED": "1" },
  "routes": [
    { "path": "/", "files": ["src/app/page.tsx", "src/components/Hero/**"] },
    { "path": "/pricing", "files": ["src/app/pricing/**"], "waitFor": "[data-loaded]" },
    { "path": "/blog/hello" }
  ],
  "globalFiles": ["src/styles/**", "tailwind.config.*"],
  "viewports": ["desktop", "mobile", "tablet:820x1180@2"],
  "themes": [{ "name": "light" }, { "name": "dark", "colorScheme": "dark", "localStorage": { "theme": "dark" } }],
  "capture": { "mask": ["[data-testid=timestamp]"], "hide": [".cookie-banner"], "locale": "pt-BR", "maxHeight": 8000 },
  "diff": { "threshold": 0.1, "focusRegions": 3 },
  "detect": { "maxRoutes": 10, "aliases": { "~": "src" } },
  "auth": { "headers": { "x-vercel-protection-bypass": "$VERCEL_AUTOMATION_BYPASS_SECRET" } },
  "audits": { "a11y": true },
  "publish": { "branch": "visual-diff-assets", "marker": "default" }
}
```

## Server

| Key | Default | |
|---|---|---|
| `appDir` | `"."` | The app's subfolder in a monorepo. Commands run in it; convention-based routes are relative to it. Files outside it (shared packages) come in through the import graph. |
| `startCommand` | `npm run dev -- --port {port}` | `{port}` is replaced by a free port (also exported as `PORT`). `static:<folder>` uses the built-in static server. Production builds (`npm run build && npm run start -- -p {port}`) capture faster and without dev overlays. |
| `baseUrl` | `http://localhost:{port}` | Where to wait for a response. Use `localhost`, not `127.0.0.1`: Vite often listens on IPv6 only and Next blocks dev resources for `127.0.0.1`. |
| `deps` | `"auto"` | `auto`: creates a `node_modules` whose entries are links to the main checkout's (workspace packages point to the worktree itself) and installs when the lockfile differs or the app uses Turbopack (Next 16+ or `--turbo`). `link`: never installs. `install`: always installs. If the server fails with links, it installs and tries again. |
| `installCommand` | inferred | Install command. Without it, it comes from the nearest lockfile (going up to the root): `npm ci`, `pnpm install --frozen-lockfile`, `yarn install --immutable`/`--frozen-lockfile`, `bun install --frozen-lockfile`. |
| `startTimeoutMs` | `90000` | How long to wait for the server to respond. |
| `env` | `{}` | Extra variables for the server (no secrets; secrets come from your environment). |

## Routes and detection

- `routes[].path`: captured path (may have a query: `/search?q=test`). A concrete example of a
  dynamic route (`/blog/hello` for `app/blog/[slug]/page.tsx`) is then used by detection on its own.
- `routes[].files`: globs (relative to `appDir` or to the root) that, when they change, affect that route.
- `routes[].waitFor`: CSS selector or `"js:<expression>"` that must become true before the capture.
- `routes[].variants` and `routes[].motion`: see `audits.md`.
- `globalFiles`: globs that affect every configured route (or, with no configured routes, every
  route discovered by convention).
- `detect.uiExtensions`, `detect.ignore`, `detect.maxRoutes`: detection filters.
- `detect.maxDepth` (6): how many import levels to climb to find a page or layout.
- `detect.aliases`: aliases that aren't in the tsconfig (e.g. the ones in `vite.config`), relative to `appDir`.

Detection already understands tsconfig and jsconfig `paths`/`baseUrl` (following `extends`),
package.json `imports` (`#x`), SvelteKit's `$lib` and workspace packages (npm, yarn, bun and pnpm). Globs
accept `**`, `*`, `?` and `{a,b}`; a glob that names a folder matches everything inside it.

## Capture

| Key | Default | |
|---|---|---|
| `viewports` | `desktop, mobile` | Presets `desktop` (1280×800), `tablet` (820×1180 @2x), `mobile` (390×844 @2x), or `name:WxH@scale`, or objects `{ name, width, height, deviceScaleFactor, isMobile }`. |
| `themes` | `light` | `{ name, colorScheme, query, localStorage, cookie, htmlClass, htmlAttr }`. `colorScheme` emulates `prefers-color-scheme`; `query` goes in the URL; `localStorage`/`cookie` are written before the page loads (next-themes and similar); `htmlClass`/`htmlAttr` go on `<html>`. If two themes come out identical, the report warns. |
| `capture.mask` | `[]` | Selectors painted magenta on both sides (dates, random avatars, live data). |
| `capture.maskEmbeds` | `["iframe"]` | Same thing for embedded content; add `"canvas"` or `"video"` if needed. |
| `capture.hide` | `[]` | Selectors hidden with `visibility: hidden` (cookie banners, chat widgets). |
| `capture.fullPage` | `true` | Full page or just the first fold. |
| `capture.maxHeight` | `8000` | Maximum height (CSS px); taller pages are cut and marked `truncated`. |
| `capture.maxScrollSteps` | `40` | Cap on scroll steps to trigger lazy loading (infinite feeds). |
| `capture.fixedTime` | `"run-start"` | Freezes `Date` on both sides (`"run-start"`, an ISO date or `null`). Timers keep running. |
| `capture.locale`, `capture.timezone` | `en-US`, `UTC` | Browser language and time zone. Change the language if the app redirects by language. |
| `capture.networkIdleMs` | `2500` | How long to wait for the network to go idle (dev servers with HMR never do). |
| `capture.waitFor` | `null` | Like `routes[].waitFor`, for every route. |
| `capture.blockHosts` | `[]` | Extra hosts to block (`"widget.example.com"` or `"example.com/pixel"`). |
| `capture.blockDefaultHosts` | `true` | Blocks well-known analytics, chats and pixels (Google Analytics, Segment, Hotjar, Intercom, Sentry…). |
| `capture.settleMs`, `capture.maxRetakes` | `250`, `4` | Wait between captures and how many times to retake until stable. After 2 changes, timers and animations are paused. |
| `capture.concurrency` | `2` | How many keys to capture at the same time (each one opens a page per side). |

## Diff

| Key | Default | |
|---|---|---|
| `diff.threshold` | `0.1` | pixelmatch sensitivity (0 to 1; lower = more sensitive). |
| `diff.rowTolerance` | `0.003` | Fraction of the width that may differ for two rows to still count as "the same" in the alignment (absorbs different rasterization on tall pages). |
| `diff.focusRegions` | `3` | How many zoomed crops per capture. The comment says how many regions there were in total. |
| `diff.maxFocusArea` | `0.4` | Regions larger than this fraction of the image don't become a crop (the full page already shows them). |
| `diff.composeFormat` | `"jpeg"` | Format of the full-page composition (crops are always PNG). |

After changing `diff.*`, `visual-diff diff` redoes the images without recapturing.

## Authentication

| Key | |
|---|---|
| `auth.headers` | `{ "header": "$VARIABLE" }`. The value is always a reference to an environment variable. |
| `auth.cookies` | `[{ "name", "value": "$VARIABLE", "domain"?, "path"? }]`. Without `domain`, it applies to each side's origin. |
| `auth.storageState` | File generated by `visual-diff login --url <login>` (default `.visual-diff/auth/storage-state.json`, outside git). |
| `auth.origins` | `["previews"]` (default), `["local"]` or both: where the credentials are used. When unused, the variables aren't even read. |

Secret values are removed from logs, errors and reports. Details in `privacy.md`.

## Audits, variants and motion

`audits.a11y`, `audits.tokens`, `audits.motion`, `motion.*` and `routes[].variants`: see `audits.md`.

## Cache

| Key | Default | |
|---|---|---|
| `cache.base` | `true` | Keeps base captures in `.visual-diff/cache/` (key: commit + config + route/viewport/theme). If all of them are cached, the base server isn't even started. `--no-cache` ignores it. |
| `cache.worktrees` | `false` | Keeps worktrees per commit (with warm `node_modules` and `.next`/`.vite`) between runs. `cleanup --all` removes them. |

## Publishing

| Key | |
|---|---|
| `publish.branch` | Orphan branch for the images. |
| `publish.marker` | Id of the sticky comment; use different ids to have more than one comment per PR (e.g. one per app in a monorepo). |
| `publish.repo` | `owner/repo` (or `host/owner/repo`) where the PR lives, when it isn't the remote's. Usually comes from the PR URL. |
| `publish.remote` | Git remote used to push the images (default: the one pointing to the PR's repository, otherwise `origin`). |
| `publish.host` | GitHub Enterprise Server host (e.g. `github.company.com`). `GH_HOST` is accepted too. |

## Environment variables

- `VISUAL_DIFF_BROWSER_CHANNEL=chrome` uses the installed Chrome instead of Playwright's Chromium.
