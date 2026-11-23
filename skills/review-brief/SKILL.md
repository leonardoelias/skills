---
name: review-brief
description: 'Builds a page that sums up a pull request so the reviewer can check the direction of the PR without reading all the code, and publishes it as an Artifact (or opens it locally). The page tells a short story, with shortened diffs, contracts, the decisions of the author, the open review threads, flow charts and the list of tests, and stays up to date while the PR changes. Use when asked to sum up a PR, explain a PR to the person who will review it, make an overview or a review summary, "what does this PR do", "make this PR easier to review", or with /review-brief. Triggers: review-brief, review brief, summarize PR, PR summary, PR overview, review summary, explain this PR, resumo-pr, resumo do PR, resumir PR, visão geral do PR.'
argument-hint: "[PR number, URL or branch; default: the PR of the current branch]"
---

# Review brief

Make a page that gives the reviewer the same confidence in the PR that they would have from reading the whole PR. Review agents already find mechanical errors better than people do. The person only needs to check the direction: what changes, why, the contracts between the parts, the choices of the author and what the tests guarantee. The page shows the direction and leaves the mechanics out.

The rules have two parts:

- **Content** is your judgment: what to show and how to say it.
- **Form** is fixed. `template.html` and the `check` command hold almost all of it. Do not step outside it.

The page is HTML, not a form to fill in. The template has the blocks that most PRs need (diffs, code examples, charts, decisions, tests). Start with them, but when a block of your own (a table of results, for example) shows the point of the PR better, write it (see [Free blocks](#free-blocks)).

## Commands

`$SKILL` is the folder of this file. The CLI has no dependencies: it needs Node 20.10+, a logged-in `gh` and `git`.

```bash
node "$SKILL/bin/review-brief.mjs" gather [<pr>]       # PR facts in <repo>/.review-brief/<number>/
node "$SKILL/bin/review-brief.mjs" check <page>        # form, line budget and avatars
node "$SKILL/bin/review-brief.mjs" render <page> [--shots]   # charts in Chromium; --shots: the whole page
node "$SKILL/bin/review-brief.mjs" open <page>         # a copy that opens directly in the browser
node "$SKILL/bin/review-brief.mjs" watch <folder>      # waits for the PR to change (in the background)
node "$SKILL/bin/review-brief.mjs" quiz prepare <folder>   # question test: the page as text
node "$SKILL/bin/review-brief.mjs" quiz score <folder>     # question test: the score
```

`render` uses the Playwright of the visual-diff skill next to it. Without that skill, install Playwright in a folder and point `PW_DIR` to it (the command's error shows how).

## Steps

1. **Gather the facts.** In the PR's repository: `gather [<number, URL or branch>]`. It writes to `<repo root>/.review-brief/<number>/` (outside version control, through `.git/info/exclude`):

   | File | What it has |
   |---|---|
   | `facts.json` | number, title, URL, author, head, base, merge base, additions, deletions, preview |
   | `description.md` | the PR description, without the brief link |
   | `files.tsv`, `full.diff` | the files and the diff of the PR |
   | `threads.json` | the review threads on the diff, with `startedByHuman` |
   | `avatars.json` | the avatars of the comment authors (`check` writes them into the page) |
   | `versions/head/<path>`, `versions/base/<path>` | each text file that the PR changes, at the head and at the merge base (from the local clone, or from the API when the clone does not have the commits) |
   | `changed-tests.tsv` | the tests that the PR changes: `added`, `modified`, `moved` or `removed`, path, line that declares the test (in the merge base for a removed one), name in the code and the `describe` around it. A parametrized test shows with the `%s` of its title |
   | `removed-tests.tsv` | the tests that the PR removes: path, line in the merge base, name |
   | `preview-url.txt` | the published preview of the head (GitHub deployments or a bot comment), or empty |
   | `linked-prs.tsv` | the state of each PR or issue that the description links |

   The summary it prints says what the page must show (the open threads by humans and the removed tests) and lists the open AI threads, for you to decide which to show. If a user account posts comments that an AI tool wrote, put the login in `ai-authors.txt` in that folder (one per line) and run `gather` again.

2. **Read.** `description.md`, `threads.json` and the diff. Then read the code in `versions/head/` until you know the contracts, the moving parts and the hot paths. For each new file, find the old code that it replaces (in `versions/base/` and in the removed lines of `full.diff`). The line numbers that the page uses (diffs, tests, chart boxes) are the ones of these files.
3. **Choose the content** (see [Content](#content)). Show only what is new or changed, and write the old and the new code, shortened, copied from `versions/` (`check` verifies each line). For each part of the story, ask whether a free block shows it better than the standard block. Choose the tests from `changed-tests.tsv` and, for each one you show, read the whole body at the head and compare it with the name and with each sentence of the page about it (see [Tests](#tests)).
4. **Rewrite the code comments you show** for a reader without context. The new text goes only to the page; do not edit the repository.
5. **Build the page.** Copy `$SKILL/template.html` to `<folder>/brief.html` (if it already exists, update it) and replace each `{{…}}` (see [Form](#form)).
6. **Check.** `check <folder>/brief.html`. Fix each error and run it again until it passes. Read the warnings: each one asks for a decision from you.
7. **Charts.** If the page has a chart, run `render <page>`. Fix each overlap and run it again. Then look at each `render/chart-<n>.png`: the main path reads from top to bottom, and the secondary boxes stay to the side. To see the whole page (desktop, dark and mobile) before you publish, use `--shots`.
8. **Question test.** Measure whether the page answers what a reviewer would ask, with three subagents that did not see this conversation, as [references/question-test.md](references/question-test.md) describes: one writes the questions reading the whole PR, another answers reading only the page, the third grades. `quiz score <folder>` gives the score, from the questions that the PR answers, and lists the findings: points that the question agent worked out from the code and the PR does not say. Fix each wrong answer (the page misleads) and each unanswered weight-3 question, run `check` and the answers and grades again. The findings go to the user, not to the page in the page's voice. Never rewrite the questions to raise the score. When you update the page, run it again if the PR got commits that change what the page shows.
9. **Publish.**
   - With the Artifact tool (Claude Code): publish the page file with the `code` icon and a one-sentence description. Save the URL in `<folder>/artifact-url.txt`. Publish each change from the same file so the URL does not change; in a new conversation, read the artifact from the saved URL and publish with `url`. The artifact starts private and the tool does not change who sees it: after the first publish, tell the user to share it with the organization from the Share menu, because the reviewers open the page from the PR.
   - Without the Artifact tool: run `open <page>` and give the path of the `.local.html`.
10. **Link in the description.** Only on the user's own PR (`gather` prints `Author: <login> (you)`) and with no link yet (`Brief link in the description: no`): offer once to put the link at the top of the description. With a yes, write to a file the block below, a blank line and the current description (`gh pr view <n> --json body --jq .body`), and run `gh pr edit <n> --body-file <file>`. Since the URL does not change, you do this only once. `gather` removes this block from `description.md` (also the older block named `resumo-pr`), so the page does not show it and `watch` does not see it as a change.

    ```markdown
    <!-- review-brief -->
    > [!TIP]
    > [Brief of this PR](<artifact URL>): what changes and why, to review the direction without reading all the code.
    <!-- /review-brief -->
    ```

11. **Comments on the artifact.** For each one: make the change, reply in the thread and resolve it. A comment that applies to more than the place where it is ("review all the text") applies to the whole page.
12. **Watch the PR**, unless the user says no. Run `watch <folder>` in the background (in the Bash tool, `run_in_background`), without a monitor that expires. It prints nothing while the PR stays the same. When the head, the base, the title, the description, the human threads, a linked PR or the preview changes, it says what changed and exits, and that wakes you: run `gather` again in the same folder, update the page (see [Discarded ideas](#discarded-ideas)), check it, run the question test if the code changed, publish to the same URL and run `watch` again. When the PR is merged or closed, it says so and exits: stop watching.

## Content

### Tell a story

The page tells a story, in this order. Skip the steps that the PR does not have:

1. **Header:** what changes and why, and the decisions that apply to the whole PR.
2. **Flow:** how the parts connect after the change, or before and after when the PR changes a flow that already exists. Only when the PR calls for a chart (see [Charts](#charts)).
3. **Where it changes:** what uses the change, and what each use did before and does now.
4. **Contract:** the types and signatures between the moving parts.
5. **One section per part of the system**, in the order in which the data moves (the producer before the consumer). Give the section the name of the part, not of the file.
6. **Tests:** how the automated tests verify the change.

### Use the words of the author

A person wrote the description. Copy the parts that help check the direction, each one next to the code or chart that it explains, and not in one block:

| In the description | On the page |
|---|---|
| tl;dr | the lede of the header; with **Before** / **Now** lines when it compares the two |
| motivation, "what was done" | a header note |
| `[!NOTE]` | a callout, next to its subject |
| a guarantee ("the old path still works", "the flag turns everything off") | above the code that makes it true |
| the why of a choice in the code | a page comment above the line that it explains |
| each decision | a decision, where it matters (see [Decisions](#decisions)) |
| a before/now table | the "Where it changes" section, with the author's sentence above |
| evidence (benchmark, evaluation) | a sentence with the result and what it shows, and the link |
| "CI, lint and tests pass" | out: a PR that is ready for review already passes |
| out of scope, future work | the header, with a link. With no PR or issue yet, in the future tense ("A later PR will …"), also when the author wrote it in the present tense |
| "depends on #12", "on top of #12" | a header note, only while the linked PR is open (`linked-prs.tsv`). A merged PR is already in the base: cite it only if the reader needs it, as history ("#12 made the response flat") |
| "alternatives considered", "do X instead…" | a discarded idea |
| QA steps | out: they are for the tester, not for the reviewer |
| how the PR came about (who asked, why this scope) | out, except a discussion in which the team agreed on the behavior: link it |

Keep the words of the author. You may only fix errors, replace code names and jargon with plain words, give each sentence the subject that does the action (see [Words](#words)), cut sentences that add nothing and remove ceremony (headings like "What was done", checkboxes, filler). Also remove internal details: ids (of nodes, requests, commits), names of internal types, model settings, commit history. Rewrite a clipped label from the author's template as a full sentence: "Accepts: X up to Y" becomes "Trade-off: up to Y, X". This applies to the whole page.

### Decisions

A decision is a choice that shapes the PR and that a reviewer may want to be different. It is where reviewers find most review points, so the page shows each one next to what it shapes.

- Take the decisions from the decisions section of the description ("Decisions", "Decisões", "Trade-offs"), in the words of the author. Do not invent one that the description does not have. If you know of one (because you wrote the PR, for example), tell the user, so the author puts it in the description first.
- Do not put the decisions together in a section of their own. Put each one at the top of the section of the part that it shapes, before the code. A decision about the whole PR goes at the end of the header.
- Each part of the decision has a place: the choice is the title; "implicit" (made during the implementation, without discussion) is the **Implicit** label, and an explicit decision has no label; the why comes below the title; what it accepts is the **Trade-off**, after the why; the alternatives are discarded ideas inside the decision, after the trade-off; an assumption is an **Assumption** box after the decision that depends on it, or at the top of the section that it is about.
- Link the discussion of each decision, when there is one: the link that the description already gives (Slack, issue, document, Linear); or, with Slack tools, search the project's channel for the words of the decision and for its old titles. Link the message where the discussion starts, also when it is older than the PR. The link shows only as the discussion icon on the title line.
- If a person made the decision in a discussion, it is explicit. When the description says implicit, keep the label on the page and tell the user, so the author fixes the description.

### Discarded ideas

A discarded idea is a path that an earlier version of the PR had, or that the author considered, and dropped. The page shows it faded, so the text about the current code stands out.

- Show it when you update the page for a new version of the PR and the reviewer already saw the old path (compare the code at the `data-head-sha` of the previous page with the new head, and the history of the description), or when the reader needs to know why the author dropped the idea to understand the current path.
- Do not show it when the old path is worse in every way, with no trade-off, or when it does not help to understand the current code.
- Keep it apart from the text about the current code: a lede, a note or a comment says only what the PR does now. When a note says "instead of X" or "X would …", X becomes a discarded idea.
- The **Before** / **Now** of the lede compares the base with the PR. It is not a discarded idea.
- Put each one at the end of the section of the part that it is about, after the code. About the whole PR: at the end of the header. An alternative of a decision: inside the decision.

### Review threads

- ✓ An open thread, started by a person, on the current diff, always shows: its code in a diff and the thread on its line. The code counts in the budget, so cut other code first.
- An open thread that an AI reviewer started shows when it points out a behavior problem that is still open: a requirement that the code does not meet, a risk, an unhandled case. Like a person's thread, its code counts in the budget. Leave out the ones about style, names, formatting, simplification or tests of mechanics. `gather` and `check` list the open AI threads that are not on the page. An AI reviewer is a GitHub app (a login with `[bot]`) or a user account whose comments an AI tool writes: put that login in `ai-authors.txt`.
- ✓ Leave out resolved and outdated threads.
- The comments are the words of their authors, so the rules of [Use the words of the author](#use-the-words-of-the-author) apply. A long AI reply can keep only its first paragraph, without labels like "**[Possible simplification]**": the author's name opens the whole comment.

### Code

**Show:** signatures, types and contracts; the dependencies between the moving parts; code of _very_ hot paths; the comments that the reviewer needs (a why, a TODO). Show the message of each `assert` or `throw` that you show: it says why the state is invalid. Cut the message (`/* ... */`) only when the condition already says it all.

**Do not show:**

- Imports and re-exports. Never.
- Implementation that the name of the contract already describes, implementation details and comments about them.
- Input guards (an early `assert` or `throw` for an unknown id), unless the PR is about them. A product rule ("a plugin-managed field cannot have a link") is not an input guard: show it.
- Internal signatures and types, which do not leave their system.
- Test implementation and test helpers.
- The same change in several places (each caller passes the same new argument). Show it in one place, with the page comment `//! The same in the other callers` above it, on both sides, so it is an unchanged line. Show another place only if its change is different.
- Code that only moves or gets a new name, without changing the behavior. Do not write about it either. If the reviewer needs to see a move, show it as a move: the code in the old file on the old side and in the new file on the new side, shortened the same way (`data-name="<old> → <new>"`). Never as a new file. In a file with new code and moved code, split it into diffs, one per moved part. In the diff of the old file, leave the place of the moved code empty. Put the diff of the move before the diff of the old file.
- Code extracted from one function into another: show it as an extraction, the old function on the old side and the result (the old one shortened plus the new one) on the new side, so the moved lines stay unchanged. ✓ Never show only the new side of code whose body already existed: the reader takes it for new logic. Before you show a new function, look for its body in the merge base (`git show <merge base>:<path>`) and in the removed lines of `full.diff` (`check` warns when it finds it).

**Show instead of telling.** A sentence or table that only says what the code would show becomes the code, shortened. A page comment that tells what left-out code does (`//! Each value becomes a row`) is wrong: show the loop, shortened. Use page comments only for a why, to name what a `// ...` repeats from what is already on the page (`//! The same for "number" and "date"`), or to say that other places make the same change. The text next to a diff does not repeat what the diff shows either: it keeps only the why, the trade-off, the cost, or a fact about code that the page does not show.

**Shorten to read, not only to fit.** Also cut inside the lines what the reviewer does not need (the type of a local variable, a filter that is a detail). Whole implementations, with no cuts, are very rare. Each comment you show makes sense with the shown code alone.

**Hidden context.** When the change only makes sense with unchanged code around it (the callers of a new check, where a parameter that the line uses comes from), put that code in a hidden block (see [Diffs (HTML)](#diffs-html)). The page shows the block as one line, `▸ <n> more lines`, and a click opens all the blocks of that file. Do not use it to show more just because it does not count in the budget: each hidden line helps to understand the change, shortened like the rest. The closed diff stays readable without it, because that is what most people read.

**Where each part is.** Keep the declaration around it (function, class, method, config object), shortened: `export async function send(/* ... */) {` … `}`.

**Both sides the same.** The page diffs only the shown code. Code that exists on both sides shows on both, shortened the same way (the same `// ...` in the same places), or it looks added or removed. This also applies when an update of the page adds code to one side.

**Also show:** both ends of each contract (where the value is made and where it is read); that the legacy path stays, when the PR keeps it; the removed safety net (a try/catch, a fallback), on the old side. For generated code, show what is easiest to read: the generator or the output (a snapshot).

**AI agent prompts.** When the PR changes what a model reads (system prompt, instructions, tool types that go into the prompt), show the rendered text as a diff, not the code that builds it: the reviewer checks the words that the model reads.

- Get the text at the merge base and at the head from the repo's prompt snapshots, or render it with the repo's test tools (a temporary test that writes the prompt to your scratch folder, deleted afterwards). Mark the diff with `data-rendered`: the rendered text is not in the `data-path` file, so `check` does not verify it line by line.
- If the change is behind an experiment that will be removed, the prompt diffs are the center of the page: the old side with the experiment off, the new side with it on, and `data-name` ending in `(experiment off → on)`. Say in a header note which side is which. The mechanics of the experiment go in a short section after the prompt sections, before the tests.
- Show only the parts that change, with the heading or the declaration that holds them, `…` for a cut sentence, `data-lang="markdown"` for prose. Break long prose at about 90 columns without changing the words.

**Over the budget,** first cut a whole diff that repeats a pattern already shown, then the lines that explain a diff.

### Code examples

An example is code that is not in the PR and shows how something uses the change: calls to a new API with the result, a script that an agent would write with the new operations.

- Write one when the PR adds or changes something that other code calls, and a few calls show it better than the signatures. It usually goes in "Where it changes", before the contract.
- Only calls that the code and the tests of the PR support: take names, arguments and values from the tests, so the example is real.
- Short: one call per thing that the reader can now do, with a one-line comment above it.
- It does not count in the budget, because these are not lines of the PR. So never show PR code in an example: it goes in a diff.

### Free blocks

A free block is HTML that the template does not have, like a table. Write one when it makes the reader see the pattern at once, instead of putting it together from several diffs. Examples: the same tests running in several modes (one row per test, one column per mode, pass or fail in each cell, in place of the list); the result of a function for many inputs, before and now; the old and the new cost on a hot path.

It replaces the standard block that shows the same thing (never show it twice) and follows all the other rules: the order of the story, the words, the budget (each test name in it counts) and the form (see [Free blocks (HTML)](#free-blocks-html)). Do not write a block that only decorates.

### Tests

- Show only tests that assert something non-obvious about the system, grouped by file.
- When the PR changes behavior and changes no test, say so in one sentence in the header ("No test changes."): without it, a page without the tests section does not say whether there are no tests or the page left them out.
- ✓ Mark each one as added, modified or removed. Added: the name (with the subtest's) is new in the PR. Removed: the PR deletes the name. The rest is modified.
- ✓ Show each test of `removed-tests.tsv`, also when the removal looks like a mistake: it changes what the tests verify, and the reviewer needs to agree. The exception is a test that another one, with a new name, replaces and that verifies the same behavior (a rename, even to another file): show the new name as modified, with `data-renamed-from`. When one new test replaces several, list them all.
- Show a modified test only when the tested behavior changes. Leave it out when the PR only changes how the test runs (setup, inputs, helpers, an expected value that follows from the new code, like a new hash).
- **Never misrepresent a test.** The reviewer trusts the name and each sentence about the test without reading it:
  - Before you show it, read the whole body: setup, inputs, expected values, each assertion. Do not take what it verifies from the name, the description or a commit.
  - The name must say what the assertions verify. It misrepresents the test when it says something that no assertion verifies, or the opposite of one.
  - In a parametrized test (`it.each`, `test.each`, a table of cases), build the name of each case with its values and compare each case on its own. One name per case; do not merge cases into a name of your own.
  - The tests of a `describe` are a group with the name of the block above them; do not repeat the block name in each test. Compare the block name and the test name together with the assertions.
  - When the name in the code misrepresents the test, do not show it: write a name in words taken from the assertions, as close as possible to the original, and put below the list a note with the code name and what the test expects. Tell the user, so the author renames it.
  - Each "passes", "fails" or "skipped" (in a table of modes, for example) comes from the marks in the code (`it.failing`, `it.skip`, the test modes): at the merge base for "before", at the head for "now". Do not guess.
  - Text about the tests (notes, tables, the lede) follows the same rules.
  - On an update to a new head, redo these checks for each shown test, also when the name did not change: a commit changes the body and keeps the name.
- ✓ Write each name in words, as close as possible to the name in the code. Remove the `Test` prefix, split the words, use lowercase (keep acronyms like AWS), write abbreviations in full and put the subtest after a colon: `TestUpsertAliasPreservesExistingDescription` becomes "Upsert alias preserves existing description"; `TestPreviewOrchestration/build once` becomes "Preview orchestration: build once". A name that is already in words (an `it("…")`) stays as it is, in the language it was written in.
- Do not show test code.

### Charts

- Charts show systems, not code. If the chart reads like pseudocode, it is wrong.
- Not every page needs one. Add a flow chart only when both are true:
  1. The PR creates or changes a connection between parts of the system. A new leaf in a system that does not change (an evaluation scenario, a test, a config entry) is not enough. A new service, a new call path or a responsibility that moves is enough.
  2. The connection is more than a straight line: it has branches, a loop, or many parts that interact. If the chart reads "A, then B, then C", a sentence is better.
- A small structure (a tree of a few nodes) is too simple, even to compare the expected shape with the real one: write one sentence per shape.
- In general, one chart. A second one only if it shows something else.
- Before/Now only when the PR changes a flow that already exists (removes, reroutes or adds connections between parts that already existed, or moves a responsibility). The pair counts as one chart. For a new system, a new leaf or a refactor that keeps the flow, one chart only. When in doubt, only one.
- Show only the main path. Edge cases (error responses, retries, limits) stay out; if one is very important, decide whether it deserves a chart of its own.
- Labels in plain words, for a reader without context: no code notation (`fn(…, config)` becomes "calls with the config"), no types (`config: unknown` becomes "config (the server does not read it)"), no local jargon that the page does not explain.
- The label of an arrow is the verb of a sentence from the source box to the target box ("creates"), or the name of what travels on it ("order, total"). No pronoun for the target. Few words; whys and conditions go in the text.
- When several arrows have the same kind of connection, each one has the full label.
- Check each label against the code before you publish.
- A dashed arrow (`style=dashed`) for a legacy or fallback path.
- Hierarchy: the main path uses the default style. Secondary parts (libraries, sources of types) are faded with `class="muted"`, one box per system, declared after the main path so Graphviz puts them to the side. Keep the arrow kinds and the full labels.
- ✓ Do not use `constraint=false`: the labels overlap.

### Words

- Use **very few words**. **Show instead of telling.** Before you write a sentence, ask: does a diff or a chart show it better? Maybe the code needs a better contract, name or comment.
- **Language:** write the page in the language of the PR description (English or Portuguese), unless the user asks for another one. The fixed labels follow the language (see [Labels](#labels)).
- The words you write (not the author's) are simple: in English, ASD-STE100 (Simplified Technical English); in Portuguese, short sentences, active voice, one name per thing.
- No text on the page has jargon: not yours, not the author's, not the shown code comments. Write for an engineer of the same company who does not work on this project: they know the product, the language and common technical terms (SQL, index, CI), but not the terms, code names and plans of the project. Do not explain more than that.
- Jargon is also the abstract word that hides who does what ("counterparts", "materialize", "hydration", "stitching") and the stack of nouns ("schemaless server contract"). Write a concrete subject and verb: "These counterparts exercise the persisted models" becomes "These tests run the same cases against the real database".
- The subject of the sentence is who does the action: a person (the editor, the customer, the reviewer) or the part of the system that runs the code (the server, the queue, the page). Data, configuration or an interface element do not do the action that a system does on them: "A list uses its own sort order" becomes "The server sorts the list by its sort order". This applies to the words of the author, decision titles, trade-offs and assumptions.
- Outside the diffs, call things by words, not by their name in the code (camelCase, PascalCase, snake_case, function, command or resource names). Build the name in words from the code name; do not invent another one. When the reader needs the name to find the thing, put it once in `<code>` after it: "the Lambda that resizes images (`image-resize`)". Keep only the code name when it is the point (a flag, a URL parameter).
- Explain each term of the PR's domain that a reader without context does not know, once, at the first use, in a tip (see [Terms](#terms)), not in parentheses. One short sentence, taken from the code (the comment of the type) or from the PR that created the term. A sentence whose only job is to explain a term becomes its tip.
- Do not write about the page itself: no "selected tests", budget or file counts.
- A change of cost on a hot path (queries per job, for example) goes in a small table, not in prose.

## Form

`check` or `render` verifies the rules marked with ✓.

### Page

- ✓ The page is a copy of `template.html`. Replace only the `{{…}}` and write the content between them. Do not change the `<style id="brief-base">` or the `<script id="brief-app">`. Free blocks are the only HTML that the template does not have.
- ✓ No `{{…}}` is left:

  | Slot | Value |
  |---|---|
  | `{{TITLE}}` | the PR title, the same as on GitHub (in the `<title>` and in the `<h1>`) |
  | `{{LANG}}` | `en` or `pt-BR` |
  | `{{REPO_URL}}` | `https://github.com/<owner>/<repo>` (`repoUrl` of `facts.json`) |
  | `{{REPO_NAME}}`, `{{NUMBER}}` | the repo name and the PR number |
  | `{{HEAD_SHA}}` | the full SHA of the head (`headSha`) |
  | `{{ADDITIONS}}`, `{{DELETIONS}}` | `additions` and `deletions` of `facts.json` |
  | `{{INDEX}}` | one `<li><a href="#<id>">Name</a></li>` per section, in page order |
  | `{{PREVIEW_URL}}` | the URL of `preview-url.txt` (`&` as `&amp;`). Empty: delete the whole `<a class="preview-link">` |
  | `{{HEADER}}` | lede, notes and decisions of the whole PR |
  | `{{SECTIONS}}` | the `<section id="…"><h2>…</h2>…</section>` |

- ✓ `<main>` has `data-repo`, `data-pr` and `data-head-sha`; the template builds all the GitHub links from them.
- The page is published again to the same URL at each update. The template keeps the block that the reader was reading (a heading, a note, a diff, found by its text or its file) and goes back to it after the reload. Do not rename sections or diffs without a reason.

### Header

- The template puts the PR link (`repo#number ↗`) in the corner and the count `+shown of +PR −shown of −PR` below the title; test names count as additions (removed ones, as deletions). ✓ Do not add eyebrows, branch names, file counts or another link to the PR.
- tl;dr: `<div class="story">` with `<p class="lede">` lines, starting with `<b>Before</b>` / `<b>Now</b>` when it compares.
- Prose: `<p class="note">`. Callout: `<aside class="callout"><span class="label">Note</span><p>…</p></aside>`.
- Discarded idea, in the header or in a section: `<aside class="discarded"><span class="label">Discarded idea</span><p>…</p></aside>`.
- A flag or experiment that turns the change on: `<div class="chips"><span class="chip">experiment: <code>name</code></span></div>`, right after the `<p class="stats">`.
- Convert the Markdown: `<code>`, `<em>`, links with `target="_blank" rel="noopener"`. `#123` becomes a link to the PR or the issue. ✓ The text of a GitHub link leaves out the owner when it is the owner of the PR's repo: `api#502`, not `acme/api#502`. Use typographic quotes and apostrophes (“ ” ’) and `→` in place of `->`.

### Decisions (HTML)

```html
<details class="decision">
  <summary>
    <span class="label">Decision</span>
    <span class="decision-head">
      <span class="decision-title">The choice</span>
      <span class="implicit" title="Made during the implementation, without discussion.">Implicit</span>
      <a class="discussion" href="<message URL>" title="Discussion on Slack"></a>
    </span>
  </summary>
  <div class="decision-body">
    <p class="why">The why.</p>
    <p class="cost"><span class="label">Trade-off</span>What the choice accepts.</p>
    <aside class="discarded"><span class="label">Discarded idea</span><p>…</p></aside>
  </div>
</details>
```

- ✓ Closed (no `open`). ✓ The `<summary>` starts with the label and has the title. ✓ Only an implicit decision has `.implicit`, with the text "Implicit" ("Implícita" in Portuguese).
- ✓ At most one `a.discussion`, last in `.decision-head`, with an http(s) `href`. Leave it empty: the template draws the icon. No discussion, no link.
- ✓ The why comes before the trade-off. The discarded idea goes after the trade-off.
- Assumption: `<div class="assumption"><span class="label">Assumption</span><p>…</p></div>`, one `<p>` per assumption.

### Terms

- `<dfn class="term" data-tip="<explanation>">term</dfn>` at the first use in the page text (lede, notes, callouts, tables), in the singular; a plural is `<dfn …>term</dfn>s`.
- ✓ Each `<dfn>` has `class="term"` and `data-tip`. ✓ One `<dfn>` per term: the other uses stay in normal text, and the template marks each one (also in the plural) with the same tip.
- `data-tip` is plain text; code goes between backticks (`` `image-resize` ``). ✓ No HTML, ✓ backticks in pairs. Typographic quotes, never `"`.
- The template does not mark terms in headings, links, code, diffs, charts and test names. If the first use is in one of these, put the `<dfn>` at the first use in the text.

### Index and preview

- ✓ One link in the index per `<section id>`, in page order.
- ✓ With a URL in `preview-url.txt`, the `<a class="preview-link">` points to it. Without one, delete the element.
- The template does the rest: a fixed index on the left with the current section marked, the Split / Unified control (each reader's choice is saved), and below 860px the index becomes a row at the top and the diffs are unified.

### Diffs (HTML)

```html
<figure class="diff" data-path="src/shipping/quote.ts" data-line="19" data-lang="ts">
<script type="text/plain" class="old">
…old code, shortened…
</script>
<script type="text/plain" class="new">
…new code, shortened…
</script>
</figure>
```

- A new file has only `new`; a deleted file, only `old`. ✓ For a file that exists on both sides, show both (the template would call a one-sided diff "new file" or "deleted file"). A diff can show part of a file, and a file can have several diffs.
- `data-name` only to show a name shorter than the path, or for a move: then `data-path` is the new path and `data-name` is `<old> → <new>`.
- ✓ `data-line` is the first changed line of the shown code, at the head (or at the merge base, for an `old`-only diff), and it must be a line that the PR adds or changes: the "Files changed" tab only has anchors for diff lines. `check` suggests the line when it is wrong.
- The template diffs while it ignores spaces at the start and end, like GitHub's "Hide whitespace": a line whose indentation is the only change (code that the PR put inside a `try`) stays unchanged, and each side keeps its own indentation. Show the real indentation of each side.
- If the diff still shows the same line removed and added (code that moved inside the part) and it is hard to follow, split it into smaller diffs, one per change.
- ✓ Each line has at most 100 columns (tab = 2). Break lines the way the repo's formatter would. Break the shown comments at about 80 columns, at a sentence boundary, so they fit on one side of the split view. Keep the repo's indentation.
- Put blank lines in the shown code as [references/readable-code.md](references/readable-code.md) says, on both sides. A `// ...` counts as the code that it leaves out. Blank lines do not count in the budget.
- No indentation jumps: when the code is inside a left-out block (a `try`), show its opening and closing, shortened.
- Shorten with `// ...` for left-out statements and `/* ... */` for expressions, parameters and types. A shortened literal does not look complete: `{ endpoint: /* ... */, siteId }`, not `{ endpoint, siteId }`.
- ✓ No `import` or `export … from` lines. The code does not contain `</script`.
- ✓ Each shown line of code exists in the file of that side: the new side in `versions/head/<data-path>`, the old side in `versions/base/` (at the old path, for a move). `check` compares the tokens in order and accepts what the page may change: spaces and line breaks, a cut type or argument, a part replaced by `/* ... */`, rewritten comments. It refuses a name, value or call that is not in the file, and code put on the wrong side. Never rewrite code; only the comments. A diff of rendered text (a prompt) has `data-rendered` and stays out of this check.
- **Page comment:** a comment that is only on the page, not in the PR. Each line starts with `//!` (or `#!` in languages with `#`). The template shows `//` in italics, in the accent color, with a tip saying that it is not in the code. ✓ It never points to other code on the page or says where the code came from ("see below", "moved from"): show that code in a diff, in its place.
- **Hidden block:** unchanged code between a `//{` line and a `//}` line, at the indentation of the code, the same on both sides (only the indentation can differ):

  ```ts
  export async function quoteShipping(postalCode: string, items: Item[]): Promise<Quote> {
    //{
    const digits = postalCode.replace(/\D/g, '')
    if (digits.length !== 8) {
      throw new Error(`Invalid postal code: "${postalCode}"`)
    }
    //}

    const weightInGrams = items.reduce(/* ... */)
  ```

  ✓ Markers on their own lines, not nested. ✓ The same number of blocks on both sides, with the same lines. ✓ A one-sided diff has no hidden blocks. Do not write the `▸ <n> more lines` line: the template writes it.

### Threads (HTML)

```html
<div class="thread" data-side="new" data-line="15">
  <div class="comment" data-author="<login>" data-href="<comment URL>"><script type="text/markdown">
The Markdown of the comment, starting at column 0.
</script></div>
</div>
```

- ✓ Inside the `figure.diff` of its code, after the scripts. One `.comment` per shown comment, in thread order, with `data-author` and `data-href` from `threads.json`.
- ✓ `data-side` is `old` or `new` (the `side` of `threads.json`). ✓ `data-line` is a line of the shown code on that side, counted from 1 in the shortened code (each hidden block counts as one line), not in the file. Use the last line of the thread's range, like GitHub. ✓ Never on a hidden block line. ✓ The shown line must be the line of the file where the thread was written (`line` of `threads.json`), in the same file and on the same side; when it is wrong, `check` suggests the right `data-line`.
- ✓ The Markdown stays as the `body` of `threads.json`, with the cuts that [Review threads](#review-threads) allows, starting at column 0 (an indented line becomes code). The template renders it like GitHub (quotes, lists, code, links, `#123`, `@login`) and shows raw HTML as text, so cut HTML blocks out of the comment.
- `check` writes the avatars (the Artifact host blocks external images). Do not edit the `#avatars` block.

### Code examples (HTML)

```html
<figure class="example" data-lang="ts">
<script type="text/plain">
// One line that says what the call does
await quoteShipping('01310-100', [{ weightInGrams: 300, quantity: 1 }])
</script>
</figure>
```

✓ It has `data-lang` and code, without `data-path` or `data-line`. ✓ At most 100 columns. ✓ Never `<pre><code>`: the page would not highlight it.

### Charts (HTML)

```html
<div class="chart" data-links='{"API": "src/api/server.ts#L10-L42"}'><script type="text/plain" class="dot">digraph {
  UI [label="Editor"]
  API [label="Server"]
  UI -> API [label="saves the draft"]
}</script></div>
```

- Graphviz DOT, from top to bottom. `rankdir=LR` only when top to bottom gets too wide.
- Only boxes and arrows: `ID [label="…"]` and `A -> B [label="…"]`, `\n` to break a line. Short, uppercase ids. ✓ No `shape`, `color`, `fillcolor`, `fontcolor`, `fontname`, `fontsize`, `penwidth` or `bgcolor`: the template sets the look, in both themes.
- ✓ `data-links` links each box that is a place in the code, with `<path>#L<n>` or `#L<a>-L<b>` at the head; each id exists in the chart.
- Before/Now pair: `<div class="chart-pair">` with two `<div>`, each with `<p class="lede"><b>Before</b></p>` (or `<b>Now</b>`) and the chart.
  - The Before has only the boxes of the old flow; the Now, only those of the new one. Declare the boxes in the same order in both, so the layouts match.
  - ✓ `class="added"` on each box and arrow that the PR adds (in the Now) and `class="removed"` on each one that it removes (in the Before). An arrow whose label changes is removed in the Before and added in the Now. The exception is a box that the PR takes out of the flow: the Now keeps it with `class="removed"` and only invisible arrows (`A -> B [style=invis]`), so the reader sees what went away; if its code stays in the repo, say so in the label. ✓ These classes only in a pair.
- `render` verifies that no label covers another label, a box or a line, and that the text fits in the box.

### Tests (HTML)

```html
<div class="tests">
  <div data-path="src/shipping/quote.test.ts">
    <ul>
      <li class="describe"><span class="describe-name">Quote shipping</span>
        <ul>
          <li data-line="22" data-change="added">reuses the quote for the same postal code prefix</li>
          <li data-line="16" data-change="removed">calls the carrier for every quote</li>
        </ul>
      </li>
      <li class="cases" title="Cases of one test">
        <ul>
          <li data-line="25" data-change="added">postal code 01310100 with 500 g becomes 01310:1</li>
          <li data-line="25" data-change="added">postal code 01310999 with 501 g becomes 01310:2</li>
        </ul>
      </li>
    </ul>
  </div>
</div>
```

- ✓ `data-line` is the line that declares the test at the head (the one of the `it(`, of the `func Test…`, of the `it.each(` of a parametrized test), as in `changed-tests.tsv`; for a removed one, `data-path` and `data-line` are the ones at the merge base. `check` gives the nearest test when the line does not declare one. It also warns when the PR does not change the shown test, when the kind of change differs from `changed-tests.tsv`, and when the shown name does not resemble the name in the code. ✓ `data-change` is `added`, `modified` or `removed`. ✓ A renamed test is `modified` with `data-renamed-from="<path>:<line>"` (several, separated by spaces).
- A `describe` is an `<li class="describe">` with the block name in words only in the `.describe-name`. A block inside another is a group inside the group. ✓ `check` warns when several names of a file start with the same `<name>: `.
- ✓ The cases of a parametrized test go in an `<li class="cases">`, all with the `data-line` of the test. A test with only one shown case needs no group.
- A table of tests (see [Free blocks](#free-blocks)) replaces the `<ul>` with a `<table>` in the same `<div data-path>`, with each name in a `<td data-line="…" data-change="…">` with only the name. ✓ `check` counts these cells as items.
- The template puts the file path above, the links to the "Files changed" tab and the `+` (green), `~` (orange) and `−` (red) marks, with a tip.
- The section title is only "Tests" ("Testes" in Portuguese).

### Free blocks (HTML)

- Plain HTML in place of the block in the story. Use the template's elements when they fit: `<table>` (inside `<div class="table-wrap">` if it can be wider than a phone), `<code>`, `<dfn class="term">`, links.
- Your own CSS: a `<style>` right before the block, each selector starting with a class of the block (`.modes td`), only with the template's variables (`--ink`, `--muted`, `--faint`, `--rule`, `--surface`, `--accent`, `--accent-soft`, `--add`, `--add-bg`, `--del`, `--del-bg`, `--mod`, `--code-bg`), so the dark theme works, and only the template's sizes (16, 14 and 12px).
- No script.
- Do not show a state by color alone: write a word or a symbol (✓, ✗) with a `title` that says it.

### Budget

- ✓ The shown lines are at most **20%** of the PR's additions + deletions (at least 12 lines, for small PRs). What counts are the added and removed lines of each shown diff (a line diff of the shortened code) and the test names. Unchanged lines, blank lines and the thread text do not count; a hidden block counts as one unchanged line, and its lines do not count. `check` prints the count.
- Unchanged lines are not free: show only the context that the reader needs to place the change.

### Links

- The PR link opens the conversation. The preview opens the preview deploy of the head.
- Diffs and test names open their line in the "Files changed" tab, which always shows the newest code. Comment authors open the comment on GitHub.
- Chart boxes open permalinks at the `data-head-sha`. When the PR gets commits, update `data-head-sha`, the lines of the diffs, boxes and tests, and the numbers of `.stats`.

### Labels

The labels you write follow the language of the page. The template translates its own (layout control, tips, `▸ <n> more lines`) by the `lang` of `<main>`.

| en | pt-BR |
|---|---|
| Before / Now | Antes / Agora |
| Note | Nota |
| Discarded idea | Ideia descartada |
| Decision | Decisão |
| Implicit | Implícita |
| Trade-off | Custo |
| Assumption | Premissa |
| Tests | Testes |

## Changing the template

- The part between `// <shared>` and `// </shared>` (hidden blocks, line diff, count) is the same code that `check` runs for the budget. Change both together by changing only that part.
- The libraries come from CDNs that the Artifact host allows, with pinned versions: highlight.js and marked from cdnjs, Graphviz (`@viz-js/viz`) from jsDelivr. The Graphviz defaults go at the start of the DOT (`CHART_DEFAULTS`), because the API defaults do not reach the nodes.
- Do not let the host draw charts with its Mermaid: it measures the text before the page font loads.
- After a change: `npm test` in the skill folder, and `check` and `render --shots` on `examples/review-brief/brief.html` (the example page of the skills repository), looking at the screenshots.
- After a change to SKILL.md, the template or a reference, run the evaluation ([references/evaluation.md](references/evaluation.md)): fresh agents build the page of a fixed set of PRs, and the question test compares the score with the one of the previous version. Put the mean in the commit.
