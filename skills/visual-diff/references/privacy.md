# Privacy and image hosting

Screenshots of private code are as sensitive as the code. That's why `publish`:

- writes the images to the orphan branch `visual-diff-assets` of the **PR's repository** (taken from
  the PR URL, so fork and upstream don't get mixed up), using git plumbing with a temporary index
  (the working tree, the index and local branches aren't touched);
- links them as `https://github.com/<owner>/<repo>/raw/visual-diff-assets/pr-<n>/<run>/<file>`,
  which only renders for people who are signed in and can read the repository;
- keeps the branch at **a single commit** (replaced with `--force-with-lease`, with up to 4
  attempts if another publish touched the branch at the same time), preserves other PRs' files
  and drops older runs of the same PR, so clones don't bloat;
- checks visibility first and **refuses public repositories** (unless the user passes
  `--allow-public-repo`) and **INTERNAL** ones (visible to everyone in the company on GitHub
  Enterprise; requires `--allow-internal-repo`); unknown visibility requires `--assume-private`;
- refuses reports from another commit (the PR got commits after the `run`), from the working tree
  with local changes, and with a `summary.md` older than the report;
- edits only the user's own comment; if the existing one belongs to someone else (or to the CI
  bot), it creates a new one and says so.

`publish --verify` checks, after the push, that each file exists on the branch (through the API,
with your login) and that the link returns 404 without login.

## Before publishing

Look at the images. Dev servers can show real data (production database, customer e-mails,
tokens on screen, names on avatars). Mask with `capture.mask` and run again.

## Trade-offs and limits

- Everyone with read access to the repo (including outside collaborators) can open the images.
- Full clones download the current asset snapshot (`git clone --single-branch` avoids it).
- `prune` replaces the branch commit, but doesn't erase it from GitHub's history: old objects
  stay reachable by SHA for a while, and images may stay in caches (camo, CDN).
  To truly remove something sensitive, you need GitHub support.
- GitHub Mobile and e-mail notifications may not render the images.
- The commit carries `[skip ci]` so it doesn't trigger `on: push` workflows. Rulesets or branch
  protection that forbid force-push on all branches (`*`) block publishing (exit 3): exclude
  `visual-diff-assets` from the rule (Settings → Rules → Rulesets → Target branches → Exclude) or use
  `--no-upload`.

Alternatives: a text-only comment (`--no-upload`), or CI artifacts.

## Protected previews and pages behind login

Header for previews (Vercel Authentication and similar):

```json
{ "auth": { "headers": { "x-vercel-protection-bypass": "$VERCEL_AUTOMATION_BYPASS_SECRET" } } }
```

```bash
VERCEL_AUTOMATION_BYPASS_SECRET=… node "$SKILL/bin/visual-diff.mjs" run \
  --base-url https://app-git-main-acme.vercel.app --head-url https://app-git-feature-acme.vercel.app --routes /,/pricing
```

Cookies from the environment, or a session you record in the browser:

```json
{ "auth": { "cookies": [{ "name": "session", "value": "$APP_SESSION" }], "origins": ["local"] } }
```

```bash
node "$SKILL/bin/visual-diff.mjs" login --url http://localhost:3000/login   # sign in and close the window
```

```json
{ "auth": { "storageState": ".visual-diff/auth/storage-state.json", "origins": ["local"] } }
```

- The value in the config is always a `"$NAME"` reference; a literal value is refused.
- `auth.origins` says where the credentials apply: `previews` (default) and/or `local`. When
  unused, the variables aren't even read (a local run doesn't require the preview's variable).
- Headers and cookies only go to that side's origin, never to third parties loaded by the page.
- The `login` file lives in `.visual-diff/` (excluded from git) with mode 600. Don't commit it.
- A route that redirects to a login page shows up in `notCaptured`, not as "no change".
- Never create share links or URLs with a bypass token, and never print the secret: the
  values are removed from logs, errors and reports.
