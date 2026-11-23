# Common problems

## The run is slow or was killed by the timeout

- Run it with a 10 min timeout or in the background. The first stderr line estimates the time.
- If the process died (timeout, `kill -9`), the next `run` kills the servers and removes the
  leftover worktrees. To clean up now: `cleanup` (`cleanup --all` also removes the
  `cache.worktrees` worktrees). `doctor` warns when there are orphan worktrees.
- Speeding up: production build in `startCommand`, fewer viewports/themes, a higher
  `capture.concurrency`, `cache.worktrees: true` to reuse `node_modules` and `.next` between runs.
  Recaptures of the same PR reuse the cached base captures.

## The server never gets ready (`step: start:base` / `start:head`)

- Check that `startCommand` uses `{port}` (or reads `PORT`) and that `baseUrl` has `{port}`. Both
  sides start at the same time on different ports. `doctor --smoke` tests the command on the current checkout.
- Use `"baseUrl": "http://localhost:{port}"`: Vite often listens only on `::1`, and Next.js blocks
  dev resources for `127.0.0.1`.
- Slow boot (cold Next, large monorepo): raise `startTimeoutMs`.
- Missing environment variable: the end of the log shows up in the error; the full log is in
  `.visual-diff/logs/<side>.log`. Put non-secret values in `env`; secrets come from your shell.
- Dependencies: with `deps: "auto"`, `node_modules` is linked and the install runs when the lockfile
  changes or the app uses Turbopack (which refuses links pointing outside the project). If the
  server fails with the links, the install runs and the server tries again. Force it with `"deps": "install"`.

## "No UI changes", `no-mapped-routes` or files in `unmatched`

- Run `detect` and read the `reasons` and the `notes`.
- Monorepo: set `appDir` (`init` suggests one). Workspace packages are resolved by `name`.
- Alias that isn't in the tsconfig (e.g. only in `vite.config`): `detect.aliases`.
- `unmatchedMaybe` lists `.js`/`.ts` that may be backend only; if they affect the screen, pass `--routes`.
- Or map them with `routes[].files`, or pass the routes directly: `--routes /,/pricing`.

## Differences between identical commits (false positives)

- Run `run --base HEAD --head HEAD --routes /`: everything should come out with no difference.
- The "did not stabilize" warning says where something moves and suggests a selector: use
  `capture.mask` or `capture.hide`. After 2 changes, timers and animations are paused; if it only
  stabilized that way, the warning shows up too.
- Dates on the page: `capture.fixedTime` (default `"run-start"`).
- Slow remote fonts: raise `capture.settleMs`. Content that loads late: `waitFor`.
- Third-party widgets: the well-known ones are already blocked; add others in `capture.blockHosts`.

## Only spacing changed

Items with `kind: "layout-shift"` have no different content pixels, but the content moved
(`shifts`: "below y it moved down N px"). In the Diff, the amber strip on the left marks what only
moved, green marks inserted space and the magenta line marks where something was removed.

## Dark theme looks like the light one

The warning "the light and dark captures are identical" means the theme wasn't applied. If the
app switches theme by class or localStorage (next-themes), use `themes[].localStorage`,
`themes[].cookie` or `themes[].htmlClass`.

## New, removed or redirecting page

- A new page (404 on base, 200 on head) becomes an `added` item; a removed one becomes `removed`. Other
  4xx/5xx are failures and show up in `failed`.
- A redirect to login shows up in `notCaptured`: configure `auth` (see `privacy.md`).
  Other redirects (e.g. `/` → `/en`) are captured with a warning; adjust `capture.locale`.

## Very long pages

Above `capture.maxHeight` (8000 CSS px) the capture is cut and the item marked `truncated`; what
comes in through the cut because of a shift doesn't count as a change. Infinite feeds stop at
`capture.maxScrollSteps`.

## Publish refused

- `problems` from `publish --dry-run` explains; `[blocking]` items stop the publish.
- The PR got commits after the run: `run --pr <n>` again.
- `summary.md` older than the report: rewrite or delete it.
- Exit 3: no push permission (fork, token without `contents: write`) or a rule that blocks
  force-push on the assets branch (see `privacy.md`). Use `--no-upload`.

## Debug

- `--keep-worktrees` keeps the worktrees and prints where they are.
- `--json full` prints the whole report.
- `VISUAL_DIFF_BROWSER_CHANNEL=chrome` uses the installed Chrome.
