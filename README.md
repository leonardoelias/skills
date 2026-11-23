# skills

Review and UI skills for Claude Code.

| Skill | What it does |
|---|---|
| [merge-gauge](#merge-gauge) | A short verdict (low, medium or high) on the risk of merging a PR, with the gaps behind each category |
| [visual-diff](#visual-diff) | Before/after screenshots, a pixel diff and a UX summary in one sticky PR comment |

```bash
./install.sh                 # all of them, in ~/.claude/skills (symlinks: git pull updates them)
./install.sh merge-gauge     # only the ones named
./install.sh --help
```

## merge-gauge

Answers whether a PR can go in: a risk level (low, medium or high) and five categories, each with a
verdict and the gaps that weigh on it, linked to the lines in the PR's commit. It does not hunt for
bugs line by line (that's `/code-review`): it sizes the damage the change could do, the evidence that
it works, the way back, and who finds out when it breaks.

Adapted from [warpdotdev/common-skills · merge-risk](https://github.com/warpdotdev/common-skills/blob/main/.agents/skills/merge-risk/SKILL.md)
(MIT, see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)), which in turn builds on Matt Pocock's
`pr` skill. This version adds the steps to collect the facts with `gh` and `git` without touching the
working tree, the signals that weigh in each category, rules for software people install (CLIs, apps,
libraries), opt-in changes and evidence against mocks, and a line saying which gap would lower the level.

```bash
./install.sh merge-gauge
```

Then ask: *"/merge-gauge 482"* or *"is this PR safe to merge?"*. Needs a logged-in `gh`; without a PR,
it compares the current branch with its base.

| Category | Low risk when | Weight |
|---|---|---|
| Impact | the scope is contained and away from sensitive areas (auth, payments, personal data, migrations, infra) | 2 |
| Verification | there's end-to-end proof from a real run for what users see, profiling for performance, and tests or notes for edge cases | 2 |
| Rollback cost | it's a two-way door: it comes out with `git revert` and a redeploy | 1.5 |
| Error detection | if it breaks in production, someone finds out before users do | 1 |
| Alignment | the code does what the description and the issue say, and the rest is written down | 1 |

Each verdict is worth 1 (✅), 2 (👀) or 3 (⚠️). A weighted average below 1.5 is low risk, up to 2.25
is medium, and from there on it's high. The math stays with the agent; the answer shows only the level
and the gaps:

```markdown
**Merge risk: medium**

**Alignment:** good ✅

**Impact:** medium 👀
- Changes `parseToken`, which the billing webhook also uses ([billing/webhook.ts#L40](…)); the description doesn't mention it

**Verification:** decent 👀
- No test for an expired token ([auth/token.ts#L88-L95](…))

**Rollback cost:** low ✅

**Error detection:** poor ⚠️
- The `catch` in [auth/middleware.ts#L31](…) returns an anonymous user without logging the error

**To lower it:** log the error in the `catch` in auth/middleware.ts
```

## visual-diff

A Claude Code skill that makes **before/after** screenshots, a **highlighted pixel diff** and a **UX
summary** for PRs that change the interface, and publishes it all as **one sticky comment** on the
PR. The images live on an orphan branch of the repository itself, so only people who can read the repo
can see them.

Inspired by [imuratalpay/ui-diff](https://github.com/imuratalpay/ui-diff), rewritten from scratch in
plain JavaScript (no build step).

### Install

Requirements: macOS or Linux, git, Node.js 20.10+. `gh auth login` is only needed for `--pr` and `publish`.

```bash
./install.sh visual-diff                           # ~/.claude/skills/visual-diff
./install.sh visual-diff --project ~/src/my-app    # copies into the project (to commit and use in CI)
./install.sh --uninstall visual-diff               # removes it (only if it's this skill)
```

Start a new session and ask: *"Run visual-diff on PR #123 and update the comment."*

### CLI

```bash
alias visual-diff='node ~/.claude/skills/visual-diff/bin/visual-diff.mjs'   # after ./install.sh
cd ~/src/my-app
visual-diff init                      # suggests a visual-diff.config.json (understands monorepos)
visual-diff doctor --smoke            # git, gh, Chromium, config, visibility; starts the app and captures one route
visual-diff detect --pr 123           # changed files → routes, with reasons
visual-diff run --pr 123              # capture + diff → .visual-diff/
visual-diff run --pr 123 --only /pricing  # recaptures one route and merges
visual-diff diff                      # redoes only the diff (after changing diff.threshold)
$EDITOR .visual-diff/summary.md       # the summary (start from summary.auto.md)
visual-diff render                    # preview: .visual-diff/comment.preview.md
visual-diff publish --pr 123 --dry-run
visual-diff publish --pr 123 --verify
visual-diff prune --closed
visual-diff cleanup                   # servers and worktrees from interrupted runs
visual-diff login --url http://localhost:3000/login   # session for pages behind a login
```

Without `--pr`/`--head`, it compares the current working tree (with uncommitted changes) with the default branch.

### How it works

1. **Detects** changed UI files and maps them to routes: `routes[].files`, `globalFiles`, the
   conventions of Next/SvelteKit/Astro/Nuxt/Remix/HTML (layouts cover the routes below them) and an
   import graph built in one pass, which resolves tsconfig aliases, `#imports` and workspace packages.
   New and removed pages are recognized.
2. **Starts base and head at the same time** in temporary worktrees, each on a free port, with
   `node_modules` linked (or installed when the lockfile changes), or uses published previews. An
   interrupted run is cleaned up by the next one.
3. **Captures with Playwright** deterministically (animations zeroed, fonts awaited, `Math.random` and
   `crypto` seeded, clock frozen, videos paused, iframes masked, analytics blocked, recapture until
   stable), alternating base and head.
4. **Compares with pixelmatch** after aligning the rows of both sides (patience diff with tolerance):
   what only moved doesn't count as changed, but the shift is reported ("the content below y moved
   down 24 px"). Builds `Before | After | Diff` and crops of the regions.
5. **Publishes** the images to the `visual-diff-assets` branch of the PR's repository (one commit, via
   git plumbing) and creates or edits the user's own comment, found by a hidden marker. It refuses
   public or internal repositories, reports from another commit and stale summaries.

Optional: `?param=1..n` variants, an accessibility delta with axe-core, before | after motion GIFs and
a design token audit (see `skills/visual-diff/references/audits.md`).

### Layout

```
skills/visual-diff/
├── SKILL.md                  the agent's flow
├── bin/visual-diff.mjs       entry point: installs dependencies on first use
├── visual-diff.schema.json   JSON Schema of the config (generated from src/schema.mjs)
├── src/
│   ├── cli.mjs               commands and option validation
│   ├── config.mjs            defaults, viewports, route conventions, init
│   ├── schema.mjs            config schema and validation
│   ├── detect.mjs            files → routes
│   ├── imports.mjs           import graph (aliases, workspaces)
│   ├── tree.mjs, workspace.mjs  one side's files (disk or commit) and monorepo packages
│   ├── git.mjs               base/head, merge-base, worktrees, remotes
│   ├── server.mjs            dev and static servers, dependencies
│   ├── capture.mjs           Playwright, determinism, auth
│   ├── diff.mjs              alignment, pixelmatch, regions, composition
│   ├── pipeline.mjs          orchestrates the run, cache, cleanup, report.json
│   ├── markdown.mjs          automatic summary and comment
│   ├── publish.mjs           assets branch and comment via gh
│   ├── a11y.mjs, motion.mjs, tokens.mjs   optional audits
├── references/               config · audits · privacy · troubleshooting · publish-test
└── test/                     node:test (unit, detection, diff, publishing, integration)
examples/sample-site/         static site for testing
examples/workflows/           example CI workflow for the app
```

### Testing

```bash
cd skills/visual-diff
npm test            # everything (~1 min; opens Chromium)
npm run test:unit   # no browser
```

The repository's CI (`.github/workflows/test.yml`) runs the tests on Linux with Node 20 and 22.

To try it by hand with the example:

```bash
cp -r examples/sample-site /tmp/vd-test && cd /tmp/vd-test
git init -q -b main && git add -A && git commit -qm before && git checkout -qb feature
sed -i '' 's/padding: 8px 14px; border-radius: 4px;/padding: 10px 18px; border-radius: 8px;/' styles.css
git commit -qam after
node ~/.claude/skills/visual-diff/bin/visual-diff.mjs run --base main --head feature
open .visual-diff/compare
```

Real publishing to GitHub has a manual script in `skills/visual-diff/references/publish-test.md`.

### CI in the app

Copy `examples/workflows/visual-diff.yml` into the app's `.github/workflows/` (with the skill committed
via `./install.sh --project`). It runs on PRs that are neither from forks nor drafts, caches Chromium
and the dependencies, publishes with the automatic summary and keeps the report as an artifact.

## License

[MIT](LICENSE). `merge-gauge` adapts MIT-licensed work from Warp; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
