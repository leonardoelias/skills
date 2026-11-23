# Question test

`check` verifies the form and the shown code, but it does not know whether the page answers what a reviewer needs to know. The question test measures that: one agent writes the questions that a reviewer would ask reading the whole PR, another answers reading only the page, and a third grades. An unanswered question is a gap in the page; a wrong answer means that the page misleads.

The questions are of two kinds, by the `origin` of the answer:

- **`pr`**: the PR says the answer (the description, the code comments, the threads, the test names, what the changing code does in a direct way). Only these count in the score: they measure whether the page sums up the PR.
- **`analysis`**: the question agent worked out the answer from the code, and the PR does not say it (a consequence, a risk, a contradiction, something without a test). The page gives no opinion, so these do not count in the score. They become **findings**: review points that the test found for free.

The three are fresh subagents (Agent tool), without this conversation: whoever wrote the page knows what they meant and does not see what is missing. None of them sees the work of the others beyond what the step asks.

## Steps

`<folder>` is the folder of the page (the `gather` one). `<language>` is the language of the page. `<n>` is the number of questions: 5 for a small PR, one more for every 50 lines (additions + deletions), up to 15.

1. **Questions.** Run the question agent with the [prompt below](#question-agent). It reads the PR, not the page, and writes `<folder>/quiz/questions.json`.
2. **Prepare.** `quiz prepare <folder>`. It checks the questions (format, weights, whether each source points to lines that exist) and writes `quiz/page.txt`, the page as text, and `quiz/questions.txt`, the questions without the answers. If the questions have errors, send the question agent to fix them (with `SendMessage`, so it keeps what it read).
3. **Answers.** Run the answering agent with the [prompt below](#answering-agent). It reads only the two files of step 2 and writes `quiz/answers.json`.
4. **Grades.** Run the grading agent with the [prompt below](#grading-agent). It compares each answer with the reference one and writes `quiz/grades.json`.
5. **Score.** `quiz score <folder>`. It prints the score (from 0 to 10, with the weights, only from the questions with origin `pr`), the gaps, the errors and the findings, and keeps a line in `quiz/history.tsv`.

## What to do with the result

- **Wrong** (error): the page leads the reader to a false conclusion. Find the sentence, the diff or the test name that led to the answer (the `excerpt` of the answer) and fix it. Never publish with one.
- **Unanswered, weight 3** (error): the reviewer should not approve without knowing it. Show it on the page, following the content rules: the code in a diff, the choice in a decision, the why in a note. If the budget does not allow it, cut something else.
- **Unanswered, weight 1 or 2, and incomplete** (warning): decide. Often the answer is mechanics that the page leaves out on purpose; then leave it as it is.
- **Findings** (analysis questions): do not write the conclusion on the page in the page's voice. Show on the page the code that lets the reader see the point, if it fits in the budget, and pass each finding to the user. On the user's own PR, they fix the code or explain the choice in the description (then it becomes part of the PR and the page shows it). On another person's PR, the findings are candidates for review comments: post on GitHub only with the user's yes.
- An analysis question with a **wrong** answer is also an error: the page leads the reader to a false conclusion.
- After you fix the page, run `check` and steps 2 to 5 again (prepare, answers, grades, score). **Never rewrite the questions to raise the score.** They change only when the PR gets commits: then `quiz prepare` reports the old head, and the question agent writes them again.
- Tell the user the score and what changed because of it.

The test does not replace the content rules: a page can answer everything and be too long. The budget still applies.

## Formats

`quiz/questions.json`:

```json
{
  "headSha": "<headSha of facts.json>",
  "questions": [
    {
      "id": "q1",
      "type": "why",
      "origin": "pr",
      "weight": 3,
      "question": "Why does checkout reuse the shipping quote?",
      "answer": "The carrier accepts 20 quotes per second, and checkout went over that on Black Friday.",
      "sources": ["description"]
    },
    {
      "id": "q2",
      "type": "contract",
      "origin": "pr",
      "weight": 3,
      "question": "How does the caller of the quote know that the price came from the cache?",
      "answer": "The quote gets the source field, with 'cache' or 'carrier'.",
      "sources": ["src/shipping/quote.ts#L5-L10"]
    }
  ]
}
```

- `type`: `what-changes`, `why`, `contract`, `decision`, `impact`, `tests` or `risk`.
- `origin`: `pr` (the PR says the answer) or `analysis` (the answer comes only from the code).
- `weight`: 3 if the reviewer should not approve without knowing it; 2 if they should know it; 1 if it helps.
- `sources`: `"description"`, `"threads"`, `"<path>#L<a>-L<b>"` (at the head) or `"base:<path>#L<a>-L<b>"` (at the merge base), with the lines of the files in `versions/`.

`quiz/answers.json`: `{"answers": [{"id": "q1", "answer": "…", "excerpt": "…"}]}`. With no answer on the page: `"answer": "The page does not say."` and `"excerpt": null`.

`quiz/grades.json`: `{"grades": [{"id": "q1", "grade": "correct", "reason": "…"}]}`, with `grade` equal to `correct`, `incomplete`, `unanswered` or `wrong`.

The score is worth 1 for correct, 0.5 for incomplete, 0 for unanswered and −1 for wrong, multiplied by the weight, only on the questions with origin `pr`.

## Question agent

```text
You will write the questions that a reviewer would ask to check the direction of a pull request before approving it. Another agent will try to answer them reading only a summary of the PR, to measure what the summary leaves out or says wrong.

Read in <folder>: facts.json, description.md, threads.json, full.diff, changed-tests.tsv, removed-tests.tsv and the code in versions/head/ (the PR head) and versions/base/ (the merge base). Read the code until you understand what the PR changes, not only the diff. Do not open brief.html, render/ or quiz/: the questions come from the PR, not from the summary.

Write <n> questions about the direction of the PR:
- what changes in the behavior, and why;
- the contracts between the parts: types, signatures, formats, what each side expects;
- the choices of the author, what they cost and what the author left aside;
- who is affected: what uses the changing code and what changes for each one;
- what the tests guarantee, and what they stopped guaranteeing (removed or weakened tests);
- what the PR removes or puts at risk: a safety net, an old path, a limit.

Do not ask about mechanics that an automated reviewer finds better (names, style, typos, imports, formatting) or about trivia (how many files, how many lines, branch name).

Each question has:
- "question": one that is answered with facts, not with opinion. "What does checkout show when the quote comes from the cache?", not "Is the cache a good idea?". Do not put the answer in the question.
- "answer": short, with only the facts that the reviewer needs to decide (values, conditions, who does what), one to three of them, in words, without code names when there are words for them. Do not add details that only someone reading the code would notice (a number you calculated, a secondary consequence): each one becomes a false gap.
- "sources": where the answer comes from: "description", "threads", "<path>#L<a>-L<b>" for lines of the head, "base:<path>#L<a>-L<b>" for lines of the merge base. Use the real lines of the files in versions/.
- "weight": 3 if the reviewer should not approve without knowing it, 2 if they should know it, 1 if it helps. At least a third with weight 3.
- "type": what-changes, why, contract, decision, impact, tests or risk. Mix the types.
- "origin": "pr" when the PR itself says the answer: the description, the code comments, the threads, the test names, or what the changing code does in a direct way (a new field, a new label, a value). "analysis" when the answer is a conclusion of yours drawn from the code, which the PR does not say anywhere: a consequence, a risk, a contradiction, something that the tests do not cover. If a question mixes the two, split it into two. About two in three with "pr".
- "id": q1, q2, …

Write in <language>. Write <folder>/quiz/questions.json (create the quiz folder) in this format:
{"headSha": "<headSha of facts.json>", "questions": [{"id": "q1", "type": "…", "origin": "pr", "weight": 3, "question": "…", "answer": "…", "sources": ["…"]}]}

Do not write anything other than that file. Answer only with the number of questions, how many have weight 3 and how many are analysis ones.
```

## Answering agent

```text
You are a reviewer who read only the summary of a pull request. Read <folder>/quiz/page.txt (the text of the summary, as the reader sees it) and <folder>/quiz/questions.txt. Do not open any other file and do not run commands: the test measures what the summary says on its own, and any other reading invalidates the test.

Answer each question only with what the summary says or shows. The code of the diffs, the charts, the test names and the threads count. If the summary does not answer it, write exactly "The page does not say." Do not fill in with what you know about programming or with a reasonable guess: a guessed answer hides a gap in the summary. A partial answer is better than a guessed one: say only the part that the summary supports.

In "excerpt", copy the sentence or the line of the summary that supports the answer (null when the page does not say).

Write <folder>/quiz/answers.json in this format:
{"answers": [{"id": "q1", "answer": "…", "excerpt": "…"}]}

Do not write anything other than that file. Answer only "done".
```

## Grading agent

```text
You check the answers of a test about a pull request. Read <folder>/quiz/questions.json (each question with its reference answer and its sources) and <folder>/quiz/answers.json (the answers of someone who read only a summary of the PR).

Give each answer a grade:
- "correct": it has the facts of the reference that matter to the reviewer. Different words do not matter.
- "incomplete": it gets one part right, but a fact of the reference is missing that would change what the reviewer concludes or decides. One less detail (a derived number, an example, a secondary consequence) does not make the answer incomplete.
- "unanswered": "The page does not say.", or a vague answer that states nothing.
- "wrong": it states something that contradicts the reference, or a fact that neither the reference nor the sources support. Wrong is worse than unanswered: the reader leaves misled.

When the answer states something that the reference does not cover, check the question's sources (the files in <folder>/versions/, the lines given, or <folder>/description.md) before you call it wrong: the reference may be incomplete. Do not open brief.html or quiz/page.txt.

In "reason", say in one sentence what is missing or what is wrong (empty when correct).

Write <folder>/quiz/grades.json in this format:
{"grades": [{"id": "q1", "grade": "correct", "reason": ""}]}

Do not write anything other than that file. Answer only "done".
```
