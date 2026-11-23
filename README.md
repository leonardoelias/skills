# skills

Review and UI skills for Claude Code.

| Skill | What it does |
|---|---|
| [merge-gauge](#merge-gauge) | A short verdict (low, medium or high) on the risk of merging a PR, with the gaps behind each category |
| [review-brief](#review-brief) | A page that briefs the reviewer on a PR, so they can check its direction without reading all the code |
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

## review-brief

Builds a page that gives the reviewer the same confidence as reading the whole PR, by showing only its
direction: what changes and why, the contracts between the parts, the author's decisions (with the
cost of each), the open review threads from people, a flow chart when the PR changes how systems
connect, and the list of tests added, changed and removed. In Claude Code, it publishes the page as an
Artifact and keeps it up to date while the PR changes; in other agents, it opens a local HTML file.

Inspired by [MeLlamoPablo/skills · summarize-pr](https://github.com/MeLlamoPablo/skills/tree/main/skills/summarize-pr),
rewritten from scratch in plain JavaScript, with no dependencies.

```bash
./install.sh review-brief
```

Then ask: *"/review-brief 482"* or *"brief this PR for Marina to review"*.

Requirements: Node.js 20.10+, git and a logged-in `gh`. `render` (charts and screenshots) uses the
Playwright from the visual-diff skill next to it, or the one in `PW_DIR`.

### CLI

```bash
alias review-brief='node ~/.claude/skills/review-brief/bin/review-brief.mjs'   # after ./install.sh
review-brief gather 482                       # PR facts in <repo>/.review-brief/482/ (outside git)
review-brief check .review-brief/482/brief.html        # shape, line budget, avatars
review-brief render .review-brief/482/brief.html --shots   # charts and page in Chromium
review-brief open .review-brief/482/brief.html         # opens in the browser, without an Artifact
review-brief watch .review-brief/482          # waits for the PR to change and says what changed (in the background)
review-brief quiz prepare .review-brief/482   # question test: the page as text for whoever answers
review-brief quiz score .review-brief/482     # question test: the score, the gaps and the errors
review-brief eval prepare                     # skill evaluation: one folder per PR in the fixed set
review-brief eval quiz <round>                # evaluation: fixed questions on the finished pages
review-brief eval score <round> --label "what changed"   # evaluation: score per PR, compared with the previous version
```

The content (what to show and how to say it) is the agent's judgment, guided by `SKILL.md`. The shape
is fixed: the agent copies `template.html` and fills in the `{{…}}` slots, and `check` verifies the
rest against the PR's facts. `gather` saves every changed file at the head and at the merge base
(`versions/`), and `check` uses those versions to catch what the page made up:

- the template's style and script didn't change, and no slot is left;
- every line of code shown exists in the file on that side, comparing tokens in order: it accepts line
  breaks, trimmed types, `/* ... */` and rewritten comments; it rejects a name, value or call that isn't
  there, and code on the wrong side. On three real PRs (712 lines) it found all of them, and rejected
  all 704 with one name swapped;
- every diff has a `data-line` on a line the PR changes (with a suggestion when it's off), no imports,
  at most 100 columns and the same hidden blocks on both sides; a one-sided diff doesn't lie about the
  file being new;
- every open thread started by a person appears, on the line where it was written (with a suggestion),
  and no resolved or outdated one does; the open ones from an AI reviewer that were left out are listed,
  so the agent can show those that point to a problem still open;
- every test points to the line that declares it; every test the PR removes appears (or what replaces
  it), with names in words and the cases of parameterized tests grouped. `changed-tests.tsv` lists the
  tests added, changed, moved and removed, and `check` warns when the page disagrees with it;
- decisions closed with the why before the cost, terms explained once, charts without their own styles;
- the lines shown are at most 20% of the PR's lines.

`check` can't tell whether the page answers what a reviewer would ask. For that there's the **question
test** (`references/question-test.md`), with three subagents that lack the context of whoever wrote
the page: one reads the whole PR and writes a reviewer's questions, each with the answer and the lines
behind it; another answers by reading only the page, as text (`quiz prepare`); the third grades, and
`quiz score` adds it up. Only questions whose answer the PR states count toward the score. The ones the
agent inferred from the code (a risk, a contradiction, something untested) become findings for the
user, because the page doesn't give opinions.

To change the skill itself there's the **evaluation** (`references/evaluation.md`): a fixed set of PRs
(`eval/corpus.json`: the example, two real PRs from `cli/cli` in Go and a small UI PR), each with its
head pinned and fixed questions. After changing `SKILL.md`, the template or a reference, fresh agents
build the page for each PR, the question test grades it, and `eval score` compares with the previous
version of the skill and writes to `eval/results.tsv`. A wrong answer, a failing check or a score that
drops more than 1 point on a PR is an error.

### How the page works

| Piece | What it does |
|---|---|
| Diff | Its own viewer: an LCS that ignores indentation, side by side or unified (unified on phones), word-level highlighting, syntax with highlight.js, hidden blocks that open with a click, threads on their lines |
| Charts | Graphviz (`@viz-js/viz`) with the theme's colors; Before/Now with boxes and arrows added and removed |
| Tests | `+ ~ −` marks, `describe` and case groups, links to the line in "Files changed" |
| Terms | The first use explains; later uses get the same tooltip |
| Rereading | After a new publish, goes back to the block the reader was on |

| File | What it does |
|---|---|
| `skills/review-brief/SKILL.md` | The process and the rules for content and shape |
| `skills/review-brief/template.html` | The page: styles, light and dark themes, diff, charts, tests, terms |
| `skills/review-brief/src/` | `gather`, `check`, `render`, `watch`, an HTML parser, a diff reader, file versions (`versions.mjs`), each file's tests (`tests.mjs`), line lookup by tokens (`verify.mjs`), the question test (`quiz.mjs`) and the evaluation (`eval.mjs`) |
| `skills/review-brief/references/readable-code.md` | Where to put blank lines in the code shown |
| `skills/review-brief/references/question-test.md` | The question test: the steps, the formats and the prompts of the three agents |
| `skills/review-brief/references/evaluation.md` | The skill evaluation: the fixed set, the steps and the prompt for whoever builds the page |
| `skills/review-brief/eval/` | The fixed set (`corpus.json`), each PR's fixed questions and the score history (`results.tsv`) |
| `examples/review-brief/` | An example PR with the facts and the finished page (also the tests' fixture) |

```bash
cd skills/review-brief
npm test            # everything (~15 s; render opens Chromium)
npm run test:unit   # no browser
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
