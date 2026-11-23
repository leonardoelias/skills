// Question test: measures whether the page answers what a reviewer would ask. One agent writes the questions reading
// the whole PR, another answers reading only the page, a third grades (references/question-test.md). This file
// does the part without a model: the page text as the reader sees it, the check of the questions and the score.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { children, find, findAll, hasClass, is, parse } from './html.mjs';
import { sharedCode } from './page.mjs';
import { readVersion } from './versions.mjs';

export const QUIZ_DIR = 'quiz';
export const TYPES = ['what-changes', 'why', 'contract', 'decision', 'impact', 'tests', 'risk'];
// "pr": the PR says the answer (description, comments, threads, test names, the code that changes). "analysis": the
// question agent worked out the answer from the code, and the PR does not say it. The page gives no opinion, so an
// analysis question does not count in the score: it becomes a finding for the user.
export const ORIGINS = ['pr', 'analysis'];
export const GRADES = { correct: 1, incomplete: 0.5, unanswered: 0, wrong: -1 };
export const NO_ANSWER = 'The page does not say.';

const CHANGE = { added: ['+', 'added'], modified: ['~', 'modified'], removed: ['−', 'removed'] };

// Reader text

const squash = (s) => s.replace(/\s+/g, ' ').trim();

/** The running text of a node, as the reader reads it: code between backticks, the tip of each term after it. */
function inline(node, { skipLabels = false } = {}) {
  if (node.tag === '#text') return node.text;
  if (['script', 'style'].includes(node.tag)) return '';
  if (skipLabels && node.tag === 'span' && hasClass(node, 'label')) return '';
  const inner = (node.children ?? []).map((c) => inline(c, { skipLabels })).join('');
  if (node.tag === 'code') return `\`${inner}\``;
  if (node.tag === 'b' || node.tag === 'strong') return `**${inner}**`;
  if (node.tag === 'br') return '\n';
  if (node.tag === 'dfn' && node.attrs['data-tip']) return `${inner} [term: ${node.attrs['data-tip']}]`;
  return inner;
}

const line = (node, opts) => squash(inline(node, opts));

/** The boxes and arrows of a DOT chart, in words. */
export function describeDot(dot) {
  const body = dot.replace(/^\s*digraph\b[^{]*\{/, '').replace(/\}\s*$/, '');
  const attrsOf = (raw = '') => {
    const attrs = {};
    for (const m of raw.matchAll(/(\w+)\s*=\s*("(?:\\.|[^"\\])*"|[\w.-]+)/g)) {
      attrs[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1).replace(/\\n/g, ' ').replace(/\\"/g, '"') : m[2];
    }
    return attrs;
  };
  const LIST = /\[((?:"(?:\\.|[^"\\])*"|[^\]"])*)\]/.source;
  const labels = new Map();
  const nodes = [];
  const edges = [];
  for (const m of body.matchAll(new RegExp(`([A-Za-z_]\\w*)\\s*->\\s*([A-Za-z_]\\w*)\\s*(?:${LIST})?`, 'g'))) {
    edges.push({ from: m[1], to: m[2], attrs: attrsOf(m[3]) });
  }
  const withoutEdges = body.replace(new RegExp(`[A-Za-z_]\\w*\\s*->\\s*[A-Za-z_]\\w*\\s*(?:${LIST})?`, 'g'), '');
  for (const m of withoutEdges.matchAll(new RegExp(`(?:^|[;\\n{])\\s*([A-Za-z_]\\w*)\\s*${LIST}`, 'g'))) {
    if (['graph', 'node', 'edge'].includes(m[1])) continue;
    const attrs = attrsOf(m[2]);
    labels.set(m[1], attrs.label ?? m[1]);
    nodes.push({ id: m[1], attrs });
  }
  const mark = (attrs) => {
    const classes = (attrs.class ?? '').split(/\s+/);
    if (classes.includes('added')) return ' (the PR adds)';
    if (classes.includes('removed')) return ' (the PR removes)';
    if (classes.includes('muted')) return ' (secondary)';
    return '';
  };
  const out = [];
  out.push(`boxes: ${nodes.map((n) => `${labels.get(n.id)}${mark(n.attrs)}`).join('; ') || '(none)'}`);
  const visible = edges.filter((e) => e.attrs.style !== 'invis');
  if (visible.length > 0) {
    out.push('arrows:');
    for (const e of visible) {
      const label = e.attrs.label ? `: “${e.attrs.label}”` : '';
      const dashed = e.attrs.style === 'dashed' ? ' (dashed)' : '';
      out.push(`  ${labels.get(e.from) ?? e.from} → ${labels.get(e.to) ?? e.to}${label}${dashed}${mark(e.attrs)}`);
    }
  }
  return out;
}

function diffText(figure, shared) {
  const { readSide, diffRows, HIDDEN_KEY } = shared;
  const oldScript = children(figure, (n) => n.tag === 'script' && hasClass(n, 'old'))[0];
  const newScript = children(figure, (n) => n.tag === 'script' && hasClass(n, 'new'))[0];
  const oldSide = readSide(oldScript?.text);
  const newSide = readSide(newScript?.text);
  const a = oldSide.shown.map((l) => l.text);
  const b = newSide.shown.map((l) => l.text);

  const name = figure.attrs['data-name'] || figure.attrs['data-path'] || '?';
  const kind = oldScript && newScript ? '' : newScript ? ', new file' : ', deleted file';
  const rendered = 'data-rendered' in figure.attrs ? ', rendered text' : '';
  const out = [`Diff of ${name}${kind}${rendered}:`];

  const threads = new Map();
  for (const thread of children(figure, is('div', 'thread'))) {
    const key = `${thread.attrs['data-side'] === 'old' ? 'old' : 'new'}:${Number(thread.attrs['data-line']) - 1}`;
    threads.set(key, [...(threads.get(key) ?? []), thread]);
  }
  const threadLines = (side, index) => {
    for (const thread of threads.get(`${side}:${index}`) ?? []) {
      out.push(`    ┌ Open review thread (not resolved) on this line (${side === 'old' ? 'old side' : 'new side'}):`);
      for (const comment of children(thread, is('div', 'comment'))) {
        const body = (children(comment, (n) => n.tag === 'script')[0]?.text ?? '').trim();
        const [first, ...rest] = body.split('\n');
        out.push(`    │ ${comment.attrs['data-author']}: ${first}`);
        for (const l of rest) out.push(`    │   ${l}`);
      }
      out.push('    └');
    }
  };

  const shown = (sideLines, text) => (text.startsWith(HIDDEN_KEY) ? sideLines.find((l) => l.text === text) : null);
  for (const op of diffRows(a, b)) {
    if (op.type === 'same') {
      const hidden = shown(newSide.shown, b[op.b]) ?? shown(oldSide.shown, a[op.a]);
      if (hidden) {
        out.push(`  ${hidden.indent}▸ ${hidden.hidden.length} more lines, hidden until the reader clicks:`);
        for (const l of hidden.hidden) out.push(`  ┊ ${l}`);
      } else out.push(`  ${b[op.b]}`);
      threadLines('old', op.a);
      threadLines('new', op.b);
    } else if (op.type === 'del') {
      out.push(`- ${a[op.a]}`);
      threadLines('old', op.a);
    } else {
      out.push(`+ ${b[op.b]}`);
      threadLines('new', op.b);
    }
  }
  return out;
}

function testsText(tests) {
  const out = ['Tests that the PR changes (+ added, ~ modified, − removed):'];
  const items = (list, depth) => {
    const pad = '  '.repeat(depth);
    for (const li of children(list, is('li'))) {
      if (hasClass(li, 'describe')) {
        const name = find(li, is('span', 'describe-name'));
        out.push(`${pad}${name ? line(name) : ''}`);
        for (const ul of children(li, is('ul'))) items(ul, depth + 1);
      } else if (hasClass(li, 'cases')) {
        out.push(`${pad}Cases of one test:`);
        for (const ul of children(li, is('ul'))) items(ul, depth + 1);
      } else {
        const [sign, word] = CHANGE[li.attrs['data-change']] ?? ['·', ''];
        const renamed = li.attrs['data-renamed-from'] ? `, renamed from ${li.attrs['data-renamed-from']}` : '';
        out.push(`${pad}${sign} ${line(li)} (${word}${renamed})`);
      }
    }
  };
  for (const file of children(tests, (n) => 'data-path' in n.attrs)) {
    out.push(`  ${file.attrs['data-path']}`);
    for (const ul of children(file, is('ul'))) items(ul, 2);
    for (const table of children(file, is('table'))) out.push(...tableText(table).map((l) => `    ${l}`));
  }
  return out;
}

function tableText(table) {
  return findAll(table, is('tr')).map((tr) => children(tr, (n) => n.tag === 'td' || n.tag === 'th')
    .map((cell) => {
      const [sign] = CHANGE[cell.attrs['data-change']] ?? [''];
      return `${sign ? `${sign} ` : ''}${line(cell)}`;
    })
    .join(' | '));
}

function decisionText(decision) {
  const title = find(decision, is('span', 'decision-title'));
  const implicit = find(decision, is('span', 'implicit'));
  const discussion = find(decision, is('a', 'discussion'));
  const out = [`Decision${implicit ? ` (${line(implicit).toLowerCase()})` : ''}: ${title ? line(title) : ''}${discussion ? ' [link to the discussion]' : ''}`];
  out.push('  (closed: the reader sees only the title until they click)');
  const body = find(decision, is('div', 'decision-body'));
  for (const child of body ? children(body) : []) {
    if (hasClass(child, 'why')) out.push(`  Why: ${line(child)}`);
    else if (hasClass(child, 'cost')) out.push(`  Trade-off: ${line(child, { skipLabels: true })}`);
    else out.push(...blockText(child).map((l) => `  ${l}`));
  }
  return out;
}

function blockText(node, shared) {
  if (node.tag === '#text') return squash(node.text) ? [squash(node.text)] : [];
  if (['script', 'style'].includes(node.tag)) return [];
  if (node.tag === 'a' && hasClass(node, 'pr-link')) return [];
  if (node.tag === 'p' && hasClass(node, 'stats')) return [];
  if (node.tag === 'h1') return [`# ${line(node)}`, ''];
  if (node.tag === 'h2') return ['', `## ${line(node)}`, ''];
  if (node.tag === 'h3') return ['', `### ${line(node)}`, ''];
  if (node.tag === 'p') return [line(node), ''];
  if (node.tag === 'aside' && hasClass(node, 'callout')) return [`Note: ${line(node, { skipLabels: true })}`, ''];
  if (node.tag === 'aside' && hasClass(node, 'discarded')) return [`Discarded idea: ${line(node, { skipLabels: true })}`, ''];
  if (node.tag === 'div' && hasClass(node, 'assumption')) return [`Assumption: ${line(node, { skipLabels: true })}`, ''];
  if (node.tag === 'details' && hasClass(node, 'decision')) return [...decisionText(node), ''];
  if (node.tag === 'figure' && hasClass(node, 'diff')) return [...diffText(node, shared), ''];
  if (node.tag === 'figure' && hasClass(node, 'example')) {
    const code = (children(node, (n) => n.tag === 'script')[0]?.text ?? '').replace(/^\n+|\s+$/g, '');
    return ['Usage example (code that is not in the PR):', ...code.split('\n').map((l) => `  ${l}`), ''];
  }
  if (node.tag === 'div' && hasClass(node, 'chart')) {
    const dot = children(node, (n) => n.tag === 'script' && hasClass(n, 'dot'))[0]?.text ?? '';
    return ['Chart:', ...describeDot(dot).map((l) => `  ${l}`), ''];
  }
  if (node.tag === 'div' && hasClass(node, 'tests')) return [...testsText(node), ''];
  if (node.tag === 'table') return [...tableText(node), ''];
  if (node.tag === 'ul' || node.tag === 'ol') return [...children(node, is('li')).map((li) => `- ${line(li)}`), ''];
  return (node.children ?? []).flatMap((c) => blockText(c, shared));
}

/** The text of the page as the reader sees it: header, sections, diffs with +/−, threads, tests and charts. */
export function readerText(html, shared = sharedCode()) {
  const root = parse(html);
  const main = find(root, is('main'));
  if (!main) throw new Error('the page has no <main>');
  const lines = blockText(main, shared).map((l) => l.replace(/\s+$/, ''));
  const out = [];
  for (const l of lines) if (l !== '' || (out.length > 0 && out[out.length - 1] !== '')) out.push(l);
  while (out[out.length - 1] === '') out.pop();
  const legend = [
    'Text of the PR brief page, as the reader sees it.',
    'In the diffs: "-" is a line that the PR removes, "+" is a line that the PR adds, the rest does not change.',
    '"// ..." and "/* ... */" mark cut code. "//!" or "#!" lines are comments written for the page; they are not',
    'in the code.',
    '',
  ];
  return `${legend.join('\n')}\n${out.join('\n')}\n`;
}

// Questions

function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`);
  }
}

const SOURCE = /^(?:(head|base):)?([^#\s]+)#L(\d+)(?:-L(\d+))?$/;

/** Checks quiz/questions.json: format, types, weights, and whether each source points to lines that exist. */
export function checkQuestions(dir) {
  const errors = [];
  const warnings = [];
  const file = path.join(dir, QUIZ_DIR, 'questions.json');
  const data = readJson(file);
  if (!data) return { errors: [`${path.join(QUIZ_DIR, 'questions.json')} is missing. The question agent writes that file.`], warnings, questions: [] };
  const questions = Array.isArray(data.questions) ? data.questions : [];
  if (questions.length === 0) errors.push('questions.json has no "questions".');

  const facts = readJson(path.join(dir, 'facts.json'));
  if (facts && data.headSha && data.headSha !== facts.headSha) {
    errors.push(`The questions are from head ${data.headSha.slice(0, 10)}, and the PR is now at ${facts.headSha.slice(0, 10)}. Write the questions again for the new head.`);
  }
  if (!data.headSha) warnings.push('questions.json has no "headSha": there is no way to know which version of the PR they are from.');
  if (facts && questions.length > 0) {
    const suggested = questionCount(facts.additions + facts.deletions);
    if (questions.length < suggested - 2 || questions.length > suggested + 3) {
      warnings.push(`There are ${questions.length} questions; for a PR of ${facts.additions + facts.deletions} lines, ask for about ${suggested}.`);
    }
  }

  const ids = new Set();
  for (const [index, q] of questions.entries()) {
    const label = `Question ${q?.id ?? index + 1}`;
    if (!q || typeof q !== 'object') {
      errors.push(`${label}: is not an object.`);
      continue;
    }
    if (!q.id || ids.has(q.id)) errors.push(`${label}: needs a unique "id".`);
    ids.add(q.id);
    for (const key of ['question', 'answer']) if (!String(q[key] ?? '').trim()) errors.push(`${label}: "${key}" is missing.`);
    if (!TYPES.includes(q.type)) errors.push(`${label}: "type" is one of ${TYPES.join(', ')}.`);
    if (![1, 2, 3].includes(q.weight)) errors.push(`${label}: "weight" is 1, 2 or 3.`);
    if (!ORIGINS.includes(q.origin)) errors.push(`${label}: "origin" is "pr" (the PR says the answer) or "analysis" (the answer comes only from the code).`);
    const sources = Array.isArray(q.sources) ? q.sources : [];
    if (sources.length === 0) errors.push(`${label}: "sources", where the answer comes from, is missing.`);
    for (const source of sources) {
      if (source === 'description' || source === 'threads') continue;
      const m = String(source).match(SOURCE);
      if (!m) {
        errors.push(`${label}: the source "${source}" must be "description", "threads", "<path>#L<a>-L<b>" or "base:<path>#L<a>-L<b>".`);
        continue;
      }
      const side = m[1] ?? 'head';
      const text = readVersion(dir, side, m[2]);
      if (text === null) {
        errors.push(`${label}: ${m[2]} is not in versions/${side}/.`);
        continue;
      }
      const count = text.replace(/\n$/, '').split('\n').length;
      const from = Number(m[3]);
      const to = Number(m[4] ?? m[3]);
      if (from < 1 || to < from || to > count) errors.push(`${label}: ${source} goes past the file (${m[2]} has ${count} lines in the ${side === 'head' ? 'head' : 'merge base'}).`);
    }
  }

  const fromPr = questions.filter((q) => q.origin === 'pr');
  if (questions.length > 0 && fromPr.length === 0) errors.push('No question has "origin": "pr". Without them the test does not measure the page.');
  else if (fromPr.length > 0 && !fromPr.some((q) => q.weight === 3)) warnings.push('No PR question has weight 3: the test does not say what the reviewer must not miss.');
  if (fromPr.length > 0 && fromPr.length < questions.length / 2) warnings.push(`Only ${fromPr.length} of ${questions.length} questions have origin "pr": the score comes from few questions. Ask for about two in three from the PR.`);
  const types = new Set(questions.map((q) => q.type));
  if (questions.length >= 5 && types.size < 3) warnings.push(`The questions are almost all of one type (${[...types].join(', ')}). Mix the types.`);
  return { errors, warnings, questions };
}

/** How many questions to ask for: 5 for a small PR, one more for every 50 lines, up to 15. */
export const questionCount = (lines) => Math.min(15, 5 + Math.floor(Math.max(0, lines) / 50));

/** Writes what the answering agent reads: the page as text and the questions without the answers. */
export function prepare(dir) {
  const { errors, warnings, questions } = checkQuestions(dir);
  if (errors.length > 0) return { errors, warnings, files: [] };
  const page = path.join(dir, 'brief.html');
  if (!existsSync(page)) return { errors: [`${page} is missing.`], warnings, files: [] };

  const quiz = path.join(dir, QUIZ_DIR);
  mkdirSync(quiz, { recursive: true });
  const pageFile = path.join(quiz, 'page.txt');
  const questionsFile = path.join(quiz, 'questions.txt');
  writeFileSync(pageFile, readerText(readFileSync(page, 'utf8')));
  writeFileSync(questionsFile, questions.map((q) => `${q.id}: ${q.question}`).join('\n') + '\n');
  return { errors, warnings, files: [pageFile, questionsFile] };
}

// Score

const pct = (n) => `${Math.round(n * 10) / 10}`;

/** Joins questions, answers and grades. Error: the page misleads, or leaves a weight-3 question without an answer. */
export function score(dir, { record = true } = {}) {
  const quiz = path.join(dir, QUIZ_DIR);
  const { errors: questionErrors, questions } = checkQuestions(dir);
  const errors = [...questionErrors];
  const warnings = [];
  const answers = readJson(path.join(quiz, 'answers.json'))?.answers;
  const grades = readJson(path.join(quiz, 'grades.json'))?.grades;
  if (!Array.isArray(answers)) errors.push(`${path.join(QUIZ_DIR, 'answers.json')} with "answers" is missing. The answering agent writes that file.`);
  if (!Array.isArray(grades)) errors.push(`${path.join(QUIZ_DIR, 'grades.json')} with "grades" is missing. The grading agent writes that file.`);
  if (errors.length > 0) return { errors, warnings, summary: '' };

  const answerOf = new Map(answers.map((a) => [a.id, a]));
  const gradeOf = new Map(grades.map((g) => [g.id, g]));
  for (const q of questions) {
    if (!answerOf.has(q.id)) errors.push(`Question ${q.id} has no answer in answers.json.`);
    if (!gradeOf.has(q.id)) errors.push(`Question ${q.id} has no grade in grades.json.`);
    else if (!(gradeOf.get(q.id).grade in GRADES)) errors.push(`The grade of ${q.id} must be ${Object.keys(GRADES).join(', ')}.`);
  }
  for (const id of new Set([...answerOf.keys(), ...gradeOf.keys()])) {
    if (!questions.some((q) => q.id === id)) errors.push(`${id} is in the answers or the grades, but not in the questions.`);
  }
  if (errors.length > 0) return { errors, warnings, summary: '' };

  // The score comes only from the questions whose answer the PR says. The analysis ones become findings, except when
  // the page misleads.
  const counts = Object.fromEntries(Object.keys(GRADES).map((g) => [g, 0]));
  let points = 0;
  let total = 0;
  const report = { wrong: [], unanswered: [], incomplete: [] };
  const findings = [];
  const scored = questions.filter((q) => q.origin === 'pr');
  for (const q of questions) {
    const grade = gradeOf.get(q.id);
    if (grade.grade === 'wrong') report.wrong.push({ q, grade });
    if (q.origin !== 'pr') {
      findings.push({ q, grade });
      continue;
    }
    counts[grade.grade]++;
    points += q.weight * GRADES[grade.grade];
    total += q.weight;
    if (grade.grade !== 'wrong' && grade.grade in report) report[grade.grade].push({ q, grade });
  }
  const value = total > 0 ? Math.max(0, points) / total * 10 : 0;

  const describe = ({ q, grade }) => `${q.id} (weight ${q.weight}, ${q.type}): ${q.question} — ${grade.reason ?? ''}`.trim();
  for (const item of report.wrong) errors.push(`The page misleads: ${describe(item)}`);
  for (const item of report.unanswered) {
    if (item.q.weight === 3) errors.push(`Unanswered, and the reviewer needs to know: ${describe(item)}`);
    else warnings.push(`Unanswered: ${describe(item)}`);
  }
  for (const item of report.incomplete) warnings.push(`Incomplete: ${describe(item)}`);

  const lines = [`Question test: score ${pct(value)} of 10, from ${scored.length} questions that the PR answers. `
    + `${counts.correct} correct, ${counts.incomplete} incomplete, ${counts.unanswered} unanswered, ${counts.wrong} wrong.`];
  if (findings.length > 0) {
    lines.push(`Findings for the user (the PR does not say them; the question agent worked them out from the code): ${findings.length}`);
    for (const { q, grade } of findings) lines.push(`  ${q.id} (weight ${q.weight}, ${q.type}; on the page: ${grade.grade}): ${q.answer}`);
  }
  const summary = lines.join('\n');

  if (record) {
    const facts = readJson(path.join(dir, 'facts.json'));
    const page = path.join(dir, 'brief.html');
    const head = /data-head-sha="([0-9a-f]+)"/.exec(existsSync(page) ? readFileSync(page, 'utf8') : '')?.[1] ?? facts?.headSha ?? '';
    const history = path.join(quiz, 'history.tsv');
    if (!existsSync(history)) writeFileSync(history, 'when\thead\tscore\tcorrect\tincomplete\tunanswered\twrong\n');
    appendFileSync(history, `${new Date().toISOString()}\t${head.slice(0, 10)}\t${pct(value)}\t${counts.correct}\t${counts.incomplete}\t${counts.unanswered}\t${counts.wrong}\n`);
  }
  return { errors, warnings, summary, value, counts, findings: findings.map(({ q, grade }) => ({ ...q, grade: grade.grade })) };
}
