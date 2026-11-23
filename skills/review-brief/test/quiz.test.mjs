import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { checkQuestions, describeDot, prepare, questionCount, readerText, score } from '../src/quiz.mjs';
import { copyExample, EXAMPLE } from './helpers.mjs';

const HEAD = JSON.parse(readFileSync(path.join(EXAMPLE, 'facts.json'), 'utf8')).headSha;

const QUESTIONS = [
  { id: 'q1', type: 'why', origin: 'pr', weight: 3, question: 'Why reuse the quote?', answer: 'The carrier accepts 20 quotes per second.', sources: ['description'] },
  { id: 'q2', type: 'contract', origin: 'pr', weight: 3, question: 'How does the caller know it came from the cache?', answer: 'From the source field.', sources: ['src/shipping/quote.ts#L5-L10'] },
  { id: 'q3', type: 'tests', origin: 'pr', weight: 2, question: 'Which test goes away?', answer: 'The one that called the carrier for every quote.', sources: ['base:src/shipping/quote.test.ts#L16'] },
  { id: 'q4', type: 'impact', origin: 'pr', weight: 1, question: 'What does checkout show?', answer: 'Shipping (estimate).', sources: ['src/checkout/summary.ts#L8'] },
];

/** A copy of the example with questions, answers and grades written by the test. */
function quizDir({ questions = QUESTIONS, grades, headSha = HEAD } = {}) {
  const dir = path.dirname(copyExample());
  rmSync(path.join(dir, 'quiz'), { recursive: true, force: true });
  mkdirSync(path.join(dir, 'quiz'));
  writeFileSync(path.join(dir, 'quiz', 'questions.json'), JSON.stringify({ headSha, questions }));
  if (grades) {
    writeFileSync(path.join(dir, 'quiz', 'answers.json'), JSON.stringify({ answers: questions.map((q) => ({ id: q.id, answer: '…', excerpt: null })) }));
    writeFileSync(path.join(dir, 'quiz', 'grades.json'), JSON.stringify({ grades: questions.map((q, i) => ({ id: q.id, grade: grades[i], reason: 'because' })) }));
  }
  return dir;
}

test('the reader text has what the page shows, and not the style or the scripts', () => {
  const text = readerText(readFileSync(path.join(EXAMPLE, 'brief.html'), 'utf8'));
  for (const expected of [
    '# Reuse the shipping quote for 10 minutes in checkout',
    '**Now** checkout reuses for 10 minutes',
    'weight band [term: A range of 500 g.',
    'Decision (implicit): The key uses only the first 5 digits of the postal code',
    '  Trade-off: In the other 3%',
    '  Discarded idea: A Redis shared between the instances.',
    "-     label: 'Shipping',",
    "+     label: quote.source === 'cache' ? 'Shipping (estimate)' : 'Shipping',",
    '▸ 4 more lines, hidden until the reader clicks:',
    "  ┊     throw new Error(`Invalid postal code: \"${postalCode}\"`)",
    'Diff of src/shipping/cache.ts, new file:',
    '    │ marina-costa: Five digits cover one neighborhood in São Paulo',
    '      − calls the carrier for every quote (removed)',
    '        + postal code 01310100 with 500 g becomes 01310:1 (added)',
    '    Shipping quote → Carrier API: “postal code, weight, if not in the cache” (the PR adds)',
    'Usage example (code that is not in the PR):',
  ]) assert.ok(text.includes(expected), `missing from the text: ${expected}`);
  assert.doesNotMatch(text, /--accent|HIDDEN_KEY|shop#482 ↗|data-pr-additions/);
  assert.doesNotMatch(text, / +\n/, 'line with a space at the end');

  // The thread shows right after its line.
  assert.match(text, /return `\$\{postalCode\.slice\(0, 5\)\}:\$\{band\}`\n {4}┌ Open review thread/);
});

test('describeDot: invisible arrows go away, dashed and secondary ones show', () => {
  const lines = describeDot('digraph {\n  A [label="Editor\\nweb"]\n  B [label="Server" class="muted"]\n  A -> B [label="saves" style=dashed]\n  B -> A [style=invis]\n}');
  assert.deepEqual(lines, ['boxes: Editor web; Server (secondary)', 'arrows:', '  Editor web → Server: “saves” (dashed)']);
});

test('checkQuestions: format, sources that do not exist and an old head', () => {
  assert.deepEqual(checkQuestions(quizDir()).errors, []);

  const bad = quizDir({
    questions: [
      { id: 'q1', type: 'opinion', origin: 'hunch', weight: 5, question: 'x', answer: '', sources: ['src/shipping/quote.ts#L5-L999', 'src/does/not/exist.ts#L1', 'base:src/shipping/cache.ts#L1', 'line 3'] },
      { id: 'q1', type: 'risk', origin: 'analysis', weight: 3, question: 'y', answer: 'z', sources: [] },
    ],
  });
  const { errors } = checkQuestions(bad);
  for (const pattern of [/"type" is one of/, /"weight" is 1, 2 or 3/, /"origin" is "pr"/, /No question has "origin": "pr"/, /"answer" is missing/, /goes past the file \(src\/shipping\/quote\.ts has \d+ lines in the head\)/,
    /src\/does\/not\/exist\.ts is not in versions\/head/, /src\/shipping\/cache\.ts is not in versions\/base/, /the source "line 3" must be/, /needs a unique "id"/, /"sources", where the answer comes from, is missing/]) {
    assert.ok(errors.some((e) => pattern.test(e)), `expected ${pattern}; got:\n${errors.join('\n')}`);
  }

  assert.match(checkQuestions(quizDir({ headSha: '0'.repeat(40) })).errors.join('\n'), /The questions are from head 0000000000/);
  assert.equal(questionCount(24), 5);
  assert.equal(questionCount(191), 8);
  assert.equal(questionCount(5000), 15);
});

test('prepare writes the page as text and the questions without the answers', () => {
  const dir = quizDir();
  const { errors, files } = prepare(dir);
  assert.deepEqual(errors, []);
  assert.equal(files.length, 2);
  const questions = readFileSync(path.join(dir, 'quiz', 'questions.txt'), 'utf8');
  assert.match(questions, /^q1: Why reuse the quote\?\nq2: /);
  assert.doesNotMatch(questions, /20 quotes|source field/);
  assert.ok(readFileSync(path.join(dir, 'quiz', 'page.txt'), 'utf8').startsWith('Text of the PR brief page'));
});

test('score: weights, a page that misleads, weight 3 unanswered and history', () => {
  const good = quizDir({ grades: ['correct', 'correct', 'incomplete', 'unanswered'] });
  const result = score(good);
  assert.deepEqual(result.errors, []);
  assert.equal(result.value, (3 + 3 + 1) / 9 * 10);
  assert.match(result.summary, /score 7\.8 of 10, from 4 questions that the PR answers\. 2 correct, 1 incomplete, 1 unanswered, 0 wrong\./);
  assert.ok(result.warnings.some((w) => /^Unanswered: q4 \(weight 1, impact\)/.test(w)));
  assert.ok(result.warnings.some((w) => /^Incomplete: q3/.test(w)));
  const history = readFileSync(path.join(good, 'quiz', 'history.tsv'), 'utf8').trim().split('\n');
  assert.equal(history.length, 2);
  assert.match(history[1], /\t1aaf327317\t7\.8\t2\t1\t1\t0$/);

  const bad = score(quizDir({ grades: ['wrong', 'unanswered', 'correct', 'correct'] }));
  assert.ok(bad.errors.some((e) => /^The page misleads: q1 \(weight 3, why\)/.test(e)));
  assert.ok(bad.errors.some((e) => /^Unanswered, and the reviewer needs to know: q2/.test(e)));
  assert.equal(bad.value, 0);

  const missing = quizDir({ grades: ['correct', 'correct', 'correct', 'correct'] });
  writeFileSync(path.join(missing, 'quiz', 'grades.json'), JSON.stringify({ grades: [{ id: 'q1', grade: 'correct' }, { id: 'q9', grade: 'great' }] }));
  const errors = score(missing, { record: false }).errors.join('\n');
  assert.match(errors, /Question q2 has no grade/);
  assert.match(errors, /q9 is in the answers or the grades, but not in the questions/);
  assert.ok(!existsSync(path.join(missing, 'quiz', 'history.tsv')));
});

test('score: an analysis question does not count in the score and becomes a finding, unless the page misleads', () => {
  const questions = [
    ...QUESTIONS.slice(0, 2),
    { id: 'q5', type: 'risk', origin: 'analysis', weight: 3, question: 'What happens with simultaneous requests?', answer: 'They all go to the carrier until the first response.', sources: ['src/shipping/quote.ts#L18-L30'] },
  ];
  const result = score(quizDir({ questions, grades: ['correct', 'correct', 'unanswered'] }), { record: false });
  assert.deepEqual(result.errors, []);
  assert.equal(result.value, 10);
  assert.match(result.summary, /from 2 questions that the PR answers/);
  assert.match(result.summary, /Findings for the user .*: 1\n {2}q5 \(weight 3, risk; on the page: unanswered\): They all go to the carrier/);
  assert.deepEqual(result.findings.map((f) => [f.id, f.grade]), [['q5', 'unanswered']]);

  const misleading = score(quizDir({ questions, grades: ['correct', 'correct', 'wrong'] }), { record: false });
  assert.ok(misleading.errors.some((e) => /^The page misleads: q5/.test(e)));
});
