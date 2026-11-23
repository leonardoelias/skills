// Skill evaluation: a fixed set of PRs, each with fixed questions. After a change to SKILL.md, the template or the
// references, fresh agents build the page of each PR, the question test scores it, and the score of each PR goes to
// eval/results.tsv next to the skill version. A drop says that the change made the skill worse
// (references/evaluation.md).
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check } from './check.mjs';
import { gather } from './gather.mjs';
import { SKILL_ROOT } from './page.mjs';
import { prepare, QUIZ_DIR, score } from './quiz.mjs';

export const EVAL_DIR = path.join(SKILL_ROOT, 'eval');
const REPO_ROOT = path.resolve(SKILL_ROOT, '..', '..');
const RESULTS_HEADER = ['when', 'version', 'label', 'pr', 'check', 'lines', 'score', 'correct', 'incomplete', 'unanswered', 'wrong', 'findings', 'findings on page'];
// What does not come from a fixture: the page and what comes out of it.
const NOT_FACTS = new Set(['brief.html', QUIZ_DIR, 'render', 'artifact-url.txt']);

const pct = (n) => (n === null || n === undefined ? '—' : `${Math.round(n * 10) / 10}`);
const number = (s) => (s === '—' || s === '' || s === undefined ? null : Number(String(s).replace(',', '.')));

export function readCorpus(evalDir = EVAL_DIR) {
  const corpus = JSON.parse(readFileSync(path.join(evalDir, 'corpus.json'), 'utf8'));
  return corpus.prs ?? [];
}

/** A short hash of what guides the agent: SKILL.md, template and references. It changes when the skill changes. */
export function skillVersion(root = SKILL_ROOT) {
  const hash = createHash('sha256');
  const refs = path.join(root, 'references');
  const files = ['SKILL.md', 'template.html', ...(existsSync(refs) ? readdirSync(refs).sort().map((f) => path.join('references', f)) : [])];
  for (const file of files) hash.update(`${file}\n`).update(readFileSync(path.join(root, file)));
  return hash.digest('hex').slice(0, 8);
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/**
 * Prepares a round: one folder per PR with the facts (from gather, or copied from the fixture), without the page and
 * without the questions, which only go in after the page is done.
 */
export async function evalPrepare({ out, only, evalDir = EVAL_DIR, gatherPr = gather } = {}) {
  out = path.resolve(out ?? path.join(os.tmpdir(), 'review-brief-eval', stamp()));
  const errors = [];
  const warnings = [];
  const prepared = [];
  const wanted = only?.length ? new Set(only) : null;
  const prs = readCorpus(evalDir).filter((p) => !wanted || wanted.has(p.id));
  if (wanted) for (const id of wanted) if (!prs.some((p) => p.id === id)) errors.push(`${id} is not in eval/corpus.json.`);

  for (const entry of prs) {
    const dir = path.join(out, entry.id);
    mkdirSync(dir, { recursive: true });
    try {
      if (entry.fixture) {
        const source = path.resolve(REPO_ROOT, entry.fixture);
        for (const name of readdirSync(source)) {
          if (NOT_FACTS.has(name) || name.endsWith('.local.html') || name.startsWith('.')) continue;
          cpSync(path.join(source, name), path.join(dir, name), { recursive: true });
        }
      } else {
        await gatherPr({ pr: entry.pr, out: dir, cwd: dir, quiet: true });
      }
    } catch (error) {
      const message = `${entry.id}: could not gather the facts (${String(error.message ?? error).split('\n')[0]}).`;
      if (entry.private) warnings.push(`${message} It is a private PR: it stays out of this round.`);
      else errors.push(message);
      continue;
    }

    const facts = JSON.parse(readFileSync(path.join(dir, 'facts.json'), 'utf8'));
    if (entry.headSha && facts.headSha !== entry.headSha) {
      errors.push(`${entry.id}: the head is now ${facts.headSha.slice(0, 10)}, and the set pinned ${entry.headSha.slice(0, 10)}. A PR of the set cannot change: replace it with a merged one.`);
      continue;
    }
    if (!existsSync(path.join(evalDir, entry.id, 'questions.json'))) {
      warnings.push(`${entry.id}: no fixed questions in eval/${entry.id}/questions.json. Write them before the round (references/evaluation.md).`);
    }
    prepared.push({ id: entry.id, dir, lines: facts.additions + facts.deletions });
  }

  writeFileSync(path.join(out, 'round.json'), JSON.stringify({ created: new Date().toISOString(), version: skillVersion(), prs: prepared.map((p) => p.id) }, null, 2));
  return { out, prepared, errors, warnings };
}

function readRound(out) {
  const file = path.join(out, 'round.json');
  if (!existsSync(file)) throw new Error(`${out} is not a round: round.json is missing. Run eval prepare.`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** After each page is done: puts in the fixed questions and writes the page text for the answering agent. */
export function evalQuiz({ out, evalDir = EVAL_DIR }) {
  const round = readRound(out);
  const errors = [];
  const ready = [];
  for (const id of round.prs) {
    const dir = path.join(out, id);
    if (!existsSync(path.join(dir, 'brief.html'))) {
      errors.push(`${id}: brief.html is missing. The agent that builds the page did not finish.`);
      continue;
    }
    const fixed = path.join(evalDir, id, 'questions.json');
    if (!existsSync(fixed)) {
      errors.push(`${id}: no fixed questions in eval/${id}/questions.json.`);
      continue;
    }
    mkdirSync(path.join(dir, QUIZ_DIR), { recursive: true });
    cpSync(fixed, path.join(dir, QUIZ_DIR, 'questions.json'));
    const result = prepare(dir);
    errors.push(...result.errors.map((e) => `${id}: ${e}`));
    if (result.errors.length === 0) ready.push({ id, dir });
  }
  return { errors, ready };
}

export function readResults(file = path.join(EVAL_DIR, 'results.tsv')) {
  if (!existsSync(file)) return [];
  const [header, ...rows] = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const keys = header.split('\t');
  return rows.map((line) => Object.fromEntries(line.split('\t').map((v, i) => [keys[i], v])));
}

/** The score of each PR of the round, compared with the last round of an earlier version of the skill. */
export function evalScore({ out, label = '', record = true, evalDir = EVAL_DIR }) {
  const round = readRound(out);
  const resultsFile = path.join(evalDir, 'results.tsv');
  const history = readResults(resultsFile);
  // The version that counts is the one the agents read: the current one. If the skill changed after prepare, the
  // pages may come from different versions.
  const version = skillVersion();
  const errors = [];
  const warnings = [];
  if (round.version && round.version !== version) warnings.push(`The skill changed after eval prepare (${round.version} → ${version}). If it changed while the agents were building the pages, the round mixes versions.`);
  const rows = [];

  for (const id of round.prs) {
    const dir = path.join(out, id);
    const page = path.join(dir, 'brief.html');
    if (!existsSync(page)) {
      errors.push(`${id}: brief.html is missing.`);
      continue;
    }
    const form = check(page, { write: false });
    const budget = form.summary.match(/= (\d+) of \d+ \(\d+%; limit (\d+)\)/);
    const quiz = score(dir, { record: false });
    if (quiz.summary === '') {
      errors.push(...quiz.errors.map((e) => `${id}: ${e}`));
      continue;
    }
    const previous = history.filter((r) => r.pr === id && r.version !== version).at(-1);
    rows.push({
      when: new Date().toISOString(),
      version,
      label: label.replace(/\s+/g, ' ').trim(),
      pr: id,
      check: form.errors.length === 0 ? 'ok' : `${form.errors.length} errors`,
      lines: budget ? `${budget[1]}/${budget[2]}` : '?',
      score: pct(quiz.value),
      correct: quiz.counts.correct,
      incomplete: quiz.counts.incomplete,
      unanswered: quiz.counts.unanswered,
      wrong: quiz.counts.wrong + quiz.findings.filter((f) => f.grade === 'wrong').length,
      findings: quiz.findings.length,
      'findings on page': quiz.findings.filter((f) => f.grade === 'correct').length,
      before: previous ? previous.score : null,
      beforeVersion: previous ? previous.version : null,
    });
  }

  if (record && rows.length > 0) {
    if (!existsSync(resultsFile)) writeFileSync(resultsFile, `${RESULTS_HEADER.join('\t')}\n`);
    for (const row of rows) appendFileSync(resultsFile, `${RESULTS_HEADER.map((k) => row[k]).join('\t')}\n`);
  }

  const width = Math.max(4, ...rows.map((r) => r.pr.length));
  const lines = [`Skill ${version}${label ? ` (${label})` : ''}. Round in ${out}`];
  lines.push(`${'PR'.padEnd(width)}  check     lines    score  before wrong    findings`);
  for (const r of rows) {
    const before = r.before === null ? '—' : r.before;
    lines.push(`${r.pr.padEnd(width)}  ${r.check.padEnd(8)}  ${r.lines.padEnd(7)}  ${r.score.padEnd(5)}  ${before.padEnd(5)}  ${String(r.wrong).padEnd(7)}  ${r.findings} (${r['findings on page']} visible on the page)`);
  }
  const mean = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
  const now = mean(rows.map((r) => number(r.score)));
  const compared = rows.filter((r) => r.before !== null);
  if (rows.length > 0) {
    const before = mean(compared.map((r) => number(r.before)));
    lines.push(`Mean: ${pct(now)}${compared.length ? `; on the ${compared.length} PRs with an earlier round, before ${pct(before)}, now ${pct(mean(compared.map((r) => number(r.score))))}` : ''}.`);
  }
  for (const r of rows) {
    if (r.check !== 'ok') errors.push(`${r.pr}: the page does not pass check (${r.check}). The agent that builds it must make it pass; check its prompt.`);
    if (r.wrong > 0) errors.push(`${r.pr}: ${r.wrong} wrong answer(s): the page misleads. See ${path.join(out, r.pr, QUIZ_DIR, 'grades.json')}.`);
    if (r.before !== null && number(r.score) < number(r.before) - 1) errors.push(`${r.pr}: the score dropped from ${r.before} (skill ${r.beforeVersion}) to ${r.score}.`);
  }
  return { errors, warnings, rows, summary: lines.join('\n') };
}
