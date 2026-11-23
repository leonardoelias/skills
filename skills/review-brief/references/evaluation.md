# Skill evaluation

A change to SKILL.md, the template or the references changes the pages that the agents build, and the unit tests do not see that. The evaluation measures it: fresh agents build the page of a fixed set of PRs with the current skill, the [question test](question-test.md) scores each page with fixed questions, and the score goes to `eval/results.tsv` next to the skill version. A drop says that the change made the skill worse.

Run it after a change to SKILL.md, `template.html` or a file in `references/`, before you call the change done. Each round costs three agents per PR (the one that builds is the most expensive), so put several changes in one round. In the baseline (skill `c3d5654b`), the builder took 5 to 14 minutes and 150 to 260 thousand tokens per PR; the round of the four PRs, with answers and grades, about 1.6 million tokens.

## The set

`eval/corpus.json` lists the PRs, each with its head pinned. The questions of each one are in `eval/<id>/questions.json` and do not change between rounds: that is what makes the scores comparable.

| id | What it measures |
|---|---|
| `example` | Fictional PR (the facts are in `examples/review-brief/`): decisions, an open thread, a flow that changes, a removed test |
| `cli-15081` | Real PR in Go, medium size, with a new path between parts |
| `cli-15083` | Real PR in Go, larger, with changes spread out and many tests |
| `sandbox-1` | Small interface PR, smaller than the minimum budget. It is private: whoever has no access runs without it |

## Steps

`$SKILL` is the skill folder. `<round>` is the folder that the first step prints.

1. **Prepare.** `node "$SKILL/bin/review-brief.mjs" eval prepare`. It creates one folder per PR with the facts (from `gather`, or copied from the fixture) and without the page, and checks that the head of each PR is the pinned one. `--only example,cli-15081` runs only those.
2. **Pages.** For each PR, run a fresh subagent with the [builder prompt](#agent-that-builds). Run them all at the same time: they are independent. Each one writes `<round>/<id>/brief.html`.
3. **Questions.** `eval quiz <round>`. It puts the fixed questions in each folder and writes the page text for the answering agent.
4. **Answers and grades.** For each PR, run the answering agent and then the grading agent, with the prompts of [question-test.md](question-test.md) and `<folder>` equal to `<round>/<id>`.
5. **Score.** `eval score <round> --label "<what changed in the skill>"`. It prints one line per PR (check, shown lines, score, the score of the previous version, wrong answers and findings), the mean, and writes the lines to `eval/results.tsv`.

## Reading the result

- **A wrong answer** (error): the page misleads. Open `<round>/<id>/quiz/grades.json` and the page, find the sentence, and see which rule of the skill led to it.
- **A page that does not pass check** (error): the builder stopped too early. See what it answered.
- **A score that drops more than 1 point** (error): compare the two pages (the earlier round stays in its folder, as long as the system does not delete it) and the questions whose grade changed.
- **Small differences** say nothing: the builder chooses other content in each round, and the answering agent reads differently. In the first comparison (skill `c3d5654b` → `386a0c88`), the two PRs that the change did not touch repeated the exact score, but two rounds are too few to say how much the score varies: distrust less than 1 point on one PR and look at the mean.
- **Findings** are about the PR, not the page: they show whether the page shows the code that lets the reviewer find them (the column of findings visible on the page).

Write the result in the commit of the change: the version, the mean and what changed.

## Changing the set

- **A new PR:** pick a merged or closed PR (its head no longer changes) that is public and that measures something the set does not measure (another language, an AI prompt, a code move, a huge PR). Put it in `corpus.json` with the `headSha`, run `eval prepare --only <id>`, run the question agent of [question-test.md](question-test.md) in its folder and read the questions: each source points to the right lines, each `origin` is right, the weights make sense. Then copy it to `eval/<id>/questions.json`.
- **A wrong question:** fix only the reference that is wrong, never to raise the score, and say so in the commit. The old scores of that PR stop being comparable.

## Agent that builds

```text
You will sum up a pull request with the review-brief skill, as you would for a user. The result measures the quality of the skill, so follow the skill to the letter and do not ask anyone for anything: decide as it says.

The skill is in <skill>. Read the whole <skill>/SKILL.md and the references it points to. The PR facts are already in <folder> (step 1 is done: do not run gather). Follow steps 2 to 7: read, choose the content, build <folder>/brief.html from <skill>/template.html, run `node <skill>/bin/review-brief.mjs check <folder>/brief.html` until it passes and, if the page has a chart, `node <skill>/bin/review-brief.mjs render <folder>/brief.html`. Do not do steps 8 and later: no question test, publishing, link in the description or watching.

Do not open <skill>/eval/, <folder>/quiz/ or other folders next to <folder>: they have the evaluation questions, and reading them invalidates the measure.

Answer only with the "Shown lines" line of check and a short paragraph with the hard decisions you made and the rules of the skill that seemed wrong or that contradicted each other.
```
