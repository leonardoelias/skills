// The review-brief commands. All plain JavaScript: it needs only Node, gh and git. `render` uses Playwright.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { check } from './check.mjs';
import { gather } from './gather.mjs';
import { wrapPage } from './page.mjs';
import { evalPrepare, evalQuiz, evalScore } from './eval.mjs';
import { prepare, score } from './quiz.mjs';
import { render } from './render.mjs';
import { CliError } from './run.mjs';
import { watch } from './watch.mjs';

const HELP = `usage: review-brief <command> [options]

  gather [<pr>] [--out <folder>] [--ai <login,…>]
      Gathers the facts of the PR (number, URL or branch; with nothing, the PR of
      the current branch). Default: <repo root>/.review-brief/<number>/, outside
      version control.
  check <page>
      Checks the form of the page against the template and the facts in its folder,
      counts the line budget and writes the comment avatars. Exits with 1 on error.
  render <page> [--out <folder>] [--shots]
      Draws the page in Chromium: a PNG of each chart, and label overlaps.
      --shots also saves the whole page (desktop, dark, mobile).
  open <page>
      Writes <page>.local.html, which opens directly in the browser, and opens it.
  watch <folder> [--interval <seconds>]
      Waits for the PR to change (head, base, title, description, human threads,
      linked PRs, preview), says what changed and exits. Run it in the background.
  quiz prepare <folder>
      Question test: checks quiz/questions.json and writes what the answering agent
      reads, quiz/page.txt (the page as text) and quiz/questions.txt.
  quiz score <folder>
      Joins questions, answers and grades, prints the score and the gaps and keeps
      the line in quiz/history.tsv. Exits with 1 if the page misleads or leaves a
      weight-3 question without an answer.
  eval prepare [--out <folder>] [--only <id,…>]
      Skill evaluation: one folder per PR of the fixed set (eval/corpus.json), with
      the facts and without the page. See references/evaluation.md.
  eval quiz <folder>
      After the agents built the pages: puts in the fixed questions and writes the
      text of each page for the answering agent.
  eval score <folder> [--label <what changed in the skill>]
      Score of each PR, compared with the previous version of the skill, and writes
      the lines to eval/results.tsv. Exits with 1 if a page misleads, does not pass
      check, or loses more than 1 point.
`;

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--shots') options.shots = true;
    else if (['--out', '--ai', '--interval', '--only', '--label'].includes(arg)) {
      if (i + 1 >= argv.length) throw new CliError(`${arg} needs a value`);
      options[arg.slice(2)] = argv[++i];
    } else if (arg.startsWith('--')) throw new CliError(`unknown option: ${arg} (see --help)`);
    else positional.push(arg);
  }
  return { positional, options };
}

export async function main(argv) {
  try {
    const [command, ...rest] = argv;
    const { positional, options } = parseArgs(rest);
    if (!command || command === 'help' || options.help) {
      process.stdout.write(HELP);
      return command ? 0 : 1;
    }

    if (command === 'gather') {
      const aiAuthors = options.ai ? options.ai.split(',').map((s) => s.trim()).filter(Boolean) : [];
      await gather({ pr: positional[0], out: options.out, aiAuthors });
      return 0;
    }

    if (command === 'check') {
      const page = need(positional[0], 'check <page>');
      const { errors, warnings, summary } = check(page);
      for (const e of errors) process.stdout.write(`error: ${e}\n`);
      for (const w of warnings) process.stdout.write(`warning: ${w}\n`);
      if (summary) process.stdout.write(`${summary}\n`);
      process.stdout.write(errors.length ? `${errors.length} error(s). Fix them and run check again.\n` : 'Form ok.\n');
      return errors.length ? 1 : 0;
    }

    if (command === 'render') {
      const page = need(positional[0], 'render <page>');
      const { problems, files } = await render(page, { out: options.out, shots: options.shots });
      for (const f of files) process.stdout.write(`${f}\n`);
      for (const p of problems) process.stdout.write(`error: ${p}\n`);
      process.stdout.write(problems.length ? `${problems.length} problem(s).\n` : 'No overlaps or errors.\n');
      return problems.length ? 1 : 0;
    }

    if (command === 'open') {
      const page = path.resolve(need(positional[0], 'open <page>'));
      const local = page.replace(/\.html?$/, '') + '.local.html';
      writeFileSync(local, wrapPage(readFileSync(page, 'utf8')));
      process.stdout.write(`${local}\n`);
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      spawn(opener, [local], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
      return 0;
    }

    if (command === 'watch') {
      const dir = need(positional[0], 'watch <folder>');
      const interval = options.interval ? Number(options.interval) : 120;
      if (!(interval >= 10)) throw new CliError('--interval is in seconds, 10 or more');
      return await watch(dir, { interval });
    }

    if (command === 'quiz') {
      const [action, target] = positional;
      const usage = 'quiz prepare|score <folder>';
      if (!['prepare', 'score'].includes(action)) throw new CliError(`usage: review-brief ${usage}`);
      const dir = need(target, usage).replace(/\/brief\.html$/, '');
      const result = action === 'prepare' ? prepare(dir) : score(dir);
      for (const e of result.errors) process.stdout.write(`error: ${e}\n`);
      for (const w of result.warnings) process.stdout.write(`warning: ${w}\n`);
      for (const f of result.files ?? []) process.stdout.write(`${f}\n`);
      if (result.summary) process.stdout.write(`${result.summary}\n`);
      return result.errors.length ? 1 : 0;
    }

    if (command === 'eval') {
      const [action, target] = positional;
      const usage = 'eval prepare [--out <folder>] [--only <id,…>] | eval quiz <folder> | eval score <folder> [--label <text>]';
      let result;
      if (action === 'prepare') {
        const only = options.only ? options.only.split(',').map((s) => s.trim()).filter(Boolean) : null;
        result = await evalPrepare({ out: options.out ?? target, only });
        for (const p of result.prepared) process.stdout.write(`${p.id}\t${p.dir}\t${p.lines} lines\n`);
        result.summary = `Round in ${result.out}. Now run an agent that builds the page of each PR (references/evaluation.md).`;
      } else if (action === 'quiz') {
        result = evalQuiz({ out: need(target, usage) });
        for (const r of result.ready) process.stdout.write(`${r.id}\t${path.join(r.dir, 'quiz')}\n`);
      } else if (action === 'score') {
        result = evalScore({ out: need(target, usage), label: options.label ?? '' });
      } else throw new CliError(`usage: review-brief ${usage}`);
      for (const e of result.errors) process.stdout.write(`error: ${e}\n`);
      for (const w of result.warnings ?? []) process.stdout.write(`warning: ${w}\n`);
      if (result.summary) process.stdout.write(`${result.summary}\n`);
      return result.errors.length ? 1 : 0;
    }

    throw new CliError(`unknown command: ${command} (see --help)`);
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`error: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

function need(value, usage) {
  if (!value) throw new CliError(`usage: review-brief ${usage}`);
  return value;
}
