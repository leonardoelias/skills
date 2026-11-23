import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { evalPrepare, evalQuiz, evalScore, readResults, skillVersion } from '../src/eval.mjs';
import { EXAMPLE, SKILL_ROOT, tmpDir } from './helpers.mjs';

const HEAD = JSON.parse(readFileSync(path.join(EXAMPLE, 'facts.json'), 'utf8')).headSha;
const QUESTIONS = {
  headSha: HEAD,
  questions: [
    { id: 'q1', type: 'why', origin: 'pr', weight: 3, question: 'Why?', answer: 'A limit of 20 per second.', sources: ['description'] },
    { id: 'q2', type: 'contract', origin: 'pr', weight: 1, question: 'Which field?', answer: 'source.', sources: ['src/shipping/quote.ts#L5-L10'] },
    { id: 'q3', type: 'risk', origin: 'analysis', weight: 3, question: 'And in parallel?', answer: 'They all go to the carrier.', sources: ['src/shipping/quote.ts#L18-L30'] },
  ],
};

/** An eval/ folder with the example, a PR that the fake gather collects and a private one that fails. */
function evalDir({ head = HEAD } = {}) {
  const dir = tmpDir('review-brief-evaldir-');
  writeFileSync(path.join(dir, 'corpus.json'), JSON.stringify({
    prs: [
      { id: 'example', fixture: 'examples/review-brief', headSha: HEAD },
      { id: 'other', pr: 'https://github.com/acme/shop/pull/482', headSha: head },
      { id: 'private', pr: 'https://github.com/me/secret/pull/1', headSha: 'abc', private: true },
    ],
  }));
  mkdirSync(path.join(dir, 'example'));
  writeFileSync(path.join(dir, 'example', 'questions.json'), JSON.stringify(QUESTIONS));
  return dir;
}

// A fake gather: copies the example's facts for the "other" PR and fails for the private one.
async function fakeGather({ pr, out }) {
  if (pr.includes('secret')) throw new Error('HTTP 404: Not Found');
  for (const name of ['facts.json', 'full.diff', 'threads.json', 'versions', 'description.md']) cpSync(path.join(EXAMPLE, name), path.join(out, name), { recursive: true });
}

function answer(dir, grades) {
  writeFileSync(path.join(dir, 'quiz', 'answers.json'), JSON.stringify({ answers: QUESTIONS.questions.map((q) => ({ id: q.id, answer: '…', excerpt: null })) }));
  writeFileSync(path.join(dir, 'quiz', 'grades.json'), JSON.stringify({ grades: QUESTIONS.questions.map((q, i) => ({ id: q.id, grade: grades[i], reason: '' })) }));
}

test('skillVersion changes when SKILL.md, the template or a reference changes', () => {
  const root = tmpDir('review-brief-skill-');
  for (const name of ['SKILL.md', 'template.html', 'references']) cpSync(path.join(SKILL_ROOT, name), path.join(root, name), { recursive: true });
  const before = skillVersion(root);
  assert.match(before, /^[0-9a-f]{8}$/);
  writeFileSync(path.join(root, 'references', 'new.md'), 'new rule');
  assert.notEqual(skillVersion(root), before);
});

test('eval prepare: facts without the page, pinned head, a private one that fails and a PR without questions', async () => {
  const dir = evalDir();
  const out = tmpDir('review-brief-round-');
  const result = await evalPrepare({ out, evalDir: dir, gatherPr: fakeGather });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.prepared.map((p) => p.id), ['example', 'other']);
  assert.ok(result.warnings.some((w) => /private: could not gather the facts \(HTTP 404: Not Found\)\. It is a private PR/.test(w)));
  assert.ok(result.warnings.some((w) => /other: no fixed questions/.test(w)));
  assert.ok(existsSync(path.join(out, 'example', 'facts.json')));
  assert.ok(existsSync(path.join(out, 'example', 'versions', 'head', 'src', 'shipping', 'cache.ts')));
  assert.ok(!existsSync(path.join(out, 'example', 'brief.html')), 'the fixture page does not go in');
  assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'round.json'), 'utf8')).prs, ['example', 'other']);

  const moved = await evalPrepare({ out: tmpDir('review-brief-round-'), evalDir: evalDir({ head: 'f'.repeat(40) }), gatherPr: fakeGather, only: ['other', 'gone'] });
  assert.ok(moved.errors.some((e) => /gone is not in eval\/corpus\.json/.test(e)));
  assert.ok(moved.errors.some((e) => /other: the head is now 1aaf327317, and the set pinned ffffffffff/.test(e)));
});

test('eval quiz and score: fixed questions after the page, a score per PR and a drop between versions', async () => {
  const dir = evalDir();
  const out = tmpDir('review-brief-round-');
  await evalPrepare({ out, evalDir: dir, gatherPr: fakeGather, only: ['example'] });

  assert.match(evalQuiz({ out, evalDir: dir }).errors.join('\n'), /example: brief\.html is missing/);
  cpSync(path.join(EXAMPLE, 'brief.html'), path.join(out, 'example', 'brief.html'));
  const quiz = evalQuiz({ out, evalDir: dir });
  assert.deepEqual(quiz.errors, []);
  assert.ok(existsSync(path.join(out, 'example', 'quiz', 'page.txt')));

  answer(path.join(out, 'example'), ['correct', 'correct', 'correct']);
  const first = evalScore({ out, label: 'baseline', evalDir: dir });
  assert.deepEqual(first.errors, []);
  assert.match(first.summary, /example\s+ok\s+33\/38\s+10\s+—\s+0\s+1 \(1 visible on the page\)/);
  const [row] = readResults(path.join(dir, 'results.tsv'));
  assert.equal(row.pr, 'example');
  assert.equal(row.label, 'baseline');

  // The earlier line becomes one of another skill version, and the weight-3 answer goes unanswered: the score drops
  // from 10 to 2.5.
  const results = path.join(dir, 'results.tsv');
  writeFileSync(results, readFileSync(results, 'utf8').replace(/\t[0-9a-f]{8}\tbaseline/, '\tdeadbeef\tbaseline'));
  answer(path.join(out, 'example'), ['unanswered', 'correct', 'wrong']);
  const second = evalScore({ out, label: 'new rule', evalDir: dir });
  assert.match(second.summary, /example\s+ok\s+33\/38\s+2\.5\s+10\s+1/);
  assert.match(second.summary, /Mean: 2\.5; on the 1 PRs with an earlier round, before 10, now 2\.5\./);
  assert.ok(second.errors.some((e) => /example: 1 wrong answer\(s\)/.test(e)));
  assert.ok(second.errors.some((e) => /example: the score dropped from 10 \(skill deadbeef\) to 2\.5/.test(e)));
  assert.equal(readResults(path.join(dir, 'results.tsv')).length, 2);
});
