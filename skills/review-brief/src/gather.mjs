// Gathers in a folder the facts of the PR that the page needs: PR data, description, files, diff, review threads,
// avatars, removed tests, published preview and the PRs that the description links.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { formatRemovedTests, parseDiff, removedTests } from './diff.mjs';
import { CliError, gh, ghJson, ghLines, git, run, tryRun } from './run.mjs';
import { changedTests, formatChangedTests } from './tests.mjs';
import { fetchVersions, readVersion } from './versions.mjs';

// The block that the skill puts at the top of the description. It is not the author's text: the page leaves it out
// and watch does not see it as a change. PRs from before the rename have the block with the old name, resumo-pr.
export const LINK_START = '<!-- review-brief -->';
export const LINK_END = '<!-- /review-brief -->';
const LINK_BLOCK = /<!-- (review-brief|resumo-pr) -->[\s\S]*?<!-- \/\1 -->\s*/;

// Comments written by AI tools from user accounts.
const AI_HINT = /generated (by|with) \[?(claude|copilot|chatgpt|cursor|codex|gemini|devin)|🤖 generated|coderabbit|greptile|ellipsis\.dev|graphite reviewer|cubic\.dev/i;

const PR_FIELDS = 'number,title,body,url,state,isDraft,author,baseRefName,headRefName,headRefOid,baseRefOid,additions,deletions,changedFiles';

export function stripSummaryLink(body) {
  return String(body ?? '').replace(LINK_BLOCK, '').replace(/\s+$/, '');
}

function repoOf(url) {
  const m = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/\d+/);
  if (!m) throw new CliError(`unexpected PR URL: ${url}`);
  return { host: m[1], owner: m[2], name: m[3], repoUrl: `https://${m[1]}/${m[2]}/${m[3]}` };
}

function apiArgs(host) {
  return host === 'github.com' ? ['api'] : ['api', '--hostname', host];
}

function reviewThreads({ host, owner, name, number, aiAuthors }) {
  const query = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          path line startLine diffSide isResolved isOutdated
          comments(first: 100) { nodes { author { __typename login avatarUrl(size: 48) } body url } }
        }
      }
    }
  }
}`;
  const threads = [];
  let after = null;
  do {
    const args = [...apiArgs(host), 'graphql', '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`, '-f', `query=${query}`];
    if (after) args.push('-f', `after=${after}`);
    const page = ghJson(args).data.repository.pullRequest.reviewThreads;
    for (const node of page.nodes) {
      const comments = node.comments.nodes.map((c) => {
        const bot = c.author?.__typename === 'Bot';
        const login = c.author ? (bot ? `${c.author.login}[bot]` : c.author.login) : 'ghost';
        return { author: login, bot, avatarUrl: c.author?.avatarUrl ?? null, body: c.body, url: c.url };
      });
      const first = comments[0];
      const byAi = !first || first.bot || aiAuthors.has(first.author.toLowerCase());
      threads.push({
        path: node.path,
        line: node.line,
        startLine: node.startLine,
        side: node.diffSide === 'LEFT' ? 'old' : 'new',
        isResolved: node.isResolved,
        isOutdated: node.isOutdated,
        startedByHuman: !byAi,
        aiHint: Boolean(first && !byAi && AI_HINT.test(first.body)),
        comments: comments.map(({ bot, ...rest }) => rest),
      });
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return threads;
}

// The Artifact host blocks external images, so the avatars go into the page as data URIs.
async function fetchAvatars(threads) {
  const avatars = {};
  const urls = new Map();
  for (const thread of threads) for (const c of thread.comments) if (c.avatarUrl && !urls.has(c.author)) urls.set(c.author, c.avatarUrl);
  await Promise.all([...urls].map(async ([author, url]) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) return;
      const type = (response.headers.get('content-type') || 'image/png').split(';')[0];
      avatars[author] = `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`;
    } catch {
      // Without an avatar the page shows only the name.
    }
  }));
  return avatars;
}

// The published preview of the head: first from the GitHub deployments (Vercel, Netlify and others publish there),
// then from bot comments with a preview link.
function findPreview({ host, owner, name, number, headSha }) {
  const api = apiArgs(host);
  const deployments = ghLines([...api, `repos/${owner}/${name}/deployments?sha=${headSha}&per_page=30`, '--jq', '.[] | {id, environment, production_environment}'], { allowFail: true }) ?? [];
  for (const d of deployments) {
    if (d.production_environment || /^prod(uction)?$/i.test(d.environment)) continue;
    const status = ghLines([...api, `repos/${owner}/${name}/deployments/${d.id}/statuses?per_page=1`, '--jq', '.[] | {state, environment_url}'], { allowFail: true })?.[0];
    if (status?.state === 'success' && status.environment_url) return status.environment_url;
  }

  const bodies = ghLines([...api, '--paginate', `repos/${owner}/${name}/issues/${number}/comments?per_page=100`, '--jq', '.[] | select(.user.type == "Bot") | .body'], { allowFail: true }) ?? [];
  for (const body of bodies.reverse()) {
    if (!/preview/i.test(body)) continue;
    const url = body.match(/https:\/\/[^\s)<>"'\]]+\.(?:vercel\.app|netlify\.app|pages\.dev|onrender\.com|fly\.dev)[^\s)<>"'\]]*/);
    if (url) return url[0];
  }
  return '';
}

// The state of each PR that the description links ("Depends on #12"). A PR that is already merged is in the base:
// the page cites it only as history.
function linkedPrs({ description, host, owner, name, number }) {
  const refs = new Map();
  const add = (repo, n) => {
    if (repo === `${owner}/${name}` && Number(n) === Number(number)) return;
    refs.set(`${repo}#${n}`, { repo, number: n });
  };
  const hostPattern = host.replace(/\./g, '\\.');
  for (const m of description.matchAll(new RegExp(`https?://${hostPattern}/([\\w.-]+/[\\w.-]+)/(?:pull|issues)/(\\d+)`, 'g'))) add(m[1], m[2]);
  // `&` skips entities like `&#39;`.
  for (const m of description.matchAll(/(?:^|[^\w/&#])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g)) add(m[1] ?? `${owner}/${name}`, m[2]);

  const lines = [];
  for (const { repo, number: n } of [...refs.values()].sort((x, y) => x.repo.localeCompare(y.repo) || x.number - y.number)) {
    const args = ['pr', 'view', String(n), '-R', host === 'github.com' ? repo : `${host}/${repo}`, '--json', 'state,url,title'];
    const r = tryRun('gh', args);
    if (r.ok) {
      const pr = JSON.parse(r.stdout);
      lines.push(`${pr.state}\t${pr.url}\t${pr.title}`);
    } else if (/Could not resolve to a|not found/i.test(r.stderr)) {
      lines.push(`ISSUE\t${repo}#${n}\t`);
    } else {
      // Network or rate limit: fail the whole gathering, so watch tries again instead of seeing a changed list.
      throw new CliError(`gh ${args.join(' ')} failed:\n${r.stderr.trim()}`);
    }
  }
  return lines;
}

function prDiff({ host, owner, name, number, mergeBase, headSha, cwd }) {
  const repo = host === 'github.com' ? `${owner}/${name}` : `${host}/${owner}/${name}`;
  const r = tryRun('gh', ['pr', 'diff', String(number), '-R', repo]);
  if (r.ok) return r.stdout;

  // The API refuses very large diffs. With the commits in the local clone, git makes the same diff.
  if (mergeBase && run('git', ['cat-file', '-e', `${headSha}^{commit}`], { cwd, allowFail: true }) !== null) {
    return git(['diff', '--no-color', '--no-ext-diff', '-M', mergeBase, headSha], { cwd });
  }
  throw new CliError(`gh pr diff failed and the local clone does not have the head ${headSha.slice(0, 12)}:\n${r.stderr.trim()}\n`
    + `Run \`git fetch origin pull/${number}/head\` in the PR's repository and try again.`);
}

function readAiAuthors(out) {
  const file = path.join(out, 'ai-authors.txt');
  if (!existsSync(file)) return new Set();
  return new Set(readFileSync(file, 'utf8').split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')));
}

export function defaultOutDir(number, cwd) {
  const top = run('git', ['rev-parse', '--show-toplevel'], { cwd, allowFail: true })?.trim();
  if (!top) return path.resolve(cwd, '.review-brief', String(number));

  // Stays outside version control without touching the project's .gitignore.
  const exclude = run('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: top, allowFail: true })?.trim();
  if (exclude) {
    const file = path.resolve(top, exclude);
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (!current.split('\n').includes('.review-brief/')) {
      mkdirSync(path.dirname(file), { recursive: true });
      appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}.review-brief/\n`);
    }
  }
  return path.join(top, '.review-brief', String(number));
}

/**
 * Gathers the facts of the PR. `pr` is a number, URL or branch (empty: the PR of the current branch). `aiAuthors` are
 * logins of user accounts whose comments an AI tool wrote.
 */
export async function gather({ pr, out, cwd = process.cwd(), aiAuthors, quiet = false, versions = true } = {}) {
  const view = ghJson(['pr', 'view', ...(pr ? [String(pr)] : []), '--json', PR_FIELDS], { cwd });
  const { host, owner, name, repoUrl } = repoOf(view.url);
  const number = view.number;
  out = path.resolve(out ?? defaultOutDir(number, cwd));
  mkdirSync(out, { recursive: true });
  aiAuthors = new Set([...(aiAuthors ?? []), ...readAiAuthors(out)].map((a) => a.toLowerCase()));
  const api = apiArgs(host);

  const files = ghLines([...api, '--paginate', `repos/${owner}/${name}/pulls/${number}/files?per_page=100`, '--jq', '.[] | {additions, deletions, status, filename, previous_filename}']);
  const mergeBase = gh([...api, `repos/${owner}/${name}/compare/${view.baseRefOid}...${view.headRefOid}`, '--jq', '.merge_base_commit.sha'], { allowFail: true })?.trim() || null;
  const diff = prDiff({ host, owner, name, number, mergeBase, headSha: view.headRefOid, cwd });
  const description = stripSummaryLink(view.body);
  const threads = reviewThreads({ host, owner, name, number, aiAuthors });
  const avatars = await fetchAvatars(threads);
  const previewUrl = findPreview({ host, owner, name, number, headSha: view.headRefOid });
  const linked = linkedPrs({ description, host, owner, name, number });
  const diffFiles = parseDiff(diff);
  const removed = removedTests(diffFiles);
  const me = gh([...api, 'user', '--jq', '.login'], { allowFail: true })?.trim() || null;

  // watch only compares metadata and skips the file versions.
  let versionInfo = null;
  let changed = null;
  if (versions) {
    versionInfo = await fetchVersions({ out, diffFiles, headSha: view.headRefOid, baseSha: mergeBase, host, owner, name, cwd });
    changed = changedTests(diffFiles, (side, file) => readVersion(out, side, file));
  }

  const facts = {
    number,
    title: view.title,
    url: view.url,
    repoUrl,
    host,
    owner,
    name,
    state: view.state,
    isDraft: view.isDraft,
    author: view.author?.login ?? null,
    isMine: Boolean(me && view.author?.login === me),
    hasSummaryLink: LINK_BLOCK.test(view.body ?? ''),
    baseRef: view.baseRefName,
    headRef: view.headRefName,
    baseSha: view.baseRefOid,
    headSha: view.headRefOid,
    mergeBase,
    additions: view.additions,
    deletions: view.deletions,
    changedFiles: view.changedFiles,
    previewUrl,
  };

  writeFileSync(path.join(out, 'facts.json'), `${JSON.stringify(facts, null, 2)}\n`);
  writeFileSync(path.join(out, 'description.md'), `${description}\n`);
  writeFileSync(path.join(out, 'files.tsv'), files.map((f) => `${f.additions}\t${f.deletions}\t${f.status}\t${f.filename}${f.previous_filename ? `\t${f.previous_filename}` : ''}\n`).join(''));
  writeFileSync(path.join(out, 'full.diff'), diff);
  writeFileSync(path.join(out, 'threads.json'), `${JSON.stringify(threads, null, 2)}\n`);
  writeFileSync(path.join(out, 'avatars.json'), `${JSON.stringify(avatars)}\n`);
  writeFileSync(path.join(out, 'removed-tests.tsv'), formatRemovedTests(removed));
  writeFileSync(path.join(out, 'preview-url.txt'), previewUrl ? `${previewUrl}\n` : '');
  writeFileSync(path.join(out, 'linked-prs.tsv'), linked.map((l) => `${l}\n`).join(''));
  if (changed) writeFileSync(path.join(out, 'changed-tests.tsv'), formatChangedTests(changed));

  if (!quiet) printSummary({ facts, out, threads, removed, changed, linked, versionInfo, cwd });
  return { facts, out };
}

function printSummary({ facts, out, threads, removed, changed, linked, versionInfo, cwd }) {
  const say = (line = '') => process.stdout.write(`${line}\n`);
  const short = (sha) => (sha ? sha.slice(0, 10) : '?');
  say(`PR #${facts.number}: ${facts.title}${facts.isDraft ? ' (draft)' : ''}`);
  say(facts.url);
  // A closed PR does not change anymore: there is nothing to watch and no description to link from.
  if (facts.state === 'MERGED') say('State: merged. Do not run watch or put the link in the description.');
  else if (facts.state === 'CLOSED') say('State: closed without merge. Do not run watch or put the link in the description.');
  say(`${facts.headRef} → ${facts.baseRef}, head ${short(facts.headSha)}, merge base ${short(facts.mergeBase)}`);
  say(`+${facts.additions} −${facts.deletions} in ${facts.changedFiles} files`);
  say(facts.isMine
    ? `Author: ${facts.author} (you). Brief link in the description: ${facts.hasSummaryLink ? 'yes' : 'no'}`
    : `Author: ${facts.author}`);
  say(`Published preview (the index links it): ${facts.previewUrl || 'none'}`);

  const mustShow = threads.filter((t) => t.startedByHuman && !t.isResolved && !t.isOutdated);
  say(`Review threads: ${threads.length}. Open, started by humans, on the current diff (the page must show them): ${mustShow.length}`);
  for (const t of mustShow) say(`  ${t.path}:${t.line ?? '?'} by ${t.comments[0].author}${t.aiHint ? ' (looks written by AI; see ai-authors.txt)' : ''} ${t.comments[0].url}`);
  const fromAi = threads.filter((t) => !t.startedByHuman && !t.isResolved && !t.isOutdated);
  if (fromAi.length > 0) {
    say(`Open, started by AI (show the ones that point out a behavior problem that is still open): ${fromAi.length}`);
    for (const t of fromAi) say(`  ${t.path}:${t.line ?? '?'} by ${t.comments[0].author}: ${t.comments[0].body.split('\n')[0].slice(0, 90)} ${t.comments[0].url}`);
  }

  say(`Tests that the PR removes (the page must show them, or the ones that replace them): ${removed.length}`);
  for (const t of removed) say(`  ${t.path}:${t.line}  ${t.name}`);
  if (changed) {
    const count = (change) => changed.filter((t) => t.change === change).length;
    say(`Tests that the PR changes (changed-tests.tsv): ${count('added')} added, ${count('modified')} modified, ${count('moved')} moved, ${count('removed')} removed`);
  }

  if (versionInfo) {
    say(`File versions in versions/ (${versionInfo.source}): ${versionInfo.head} from the head, ${versionInfo.base} from the merge base`);
    if (versionInfo.failed.length > 0) say(`  no version (binary or failed): ${versionInfo.failed.slice(0, 5).join(', ')}${versionInfo.failed.length > 5 ? ` and ${versionInfo.failed.length - 5} more` : ''}`);
    if (versionInfo.skipped > 0) say(`  warning: ${versionInfo.skipped} files went over the limit and have no version`);
  }

  if (linked.length > 0) {
    say('PRs and issues that the description links:');
    for (const l of linked) say(`  ${l.replace(/\t/g, '  ').trim()}`);
  }

  say(`Facts in ${out}`);
  say(`Page: ${path.join(out, 'brief.html')}${existsSync(path.join(out, 'brief.html')) ? ' (already exists: update it)' : ' (copy template.html there)'}`);
  if (existsSync(path.join(out, 'artifact-url.txt'))) say(`Artifact already published: ${readFileSync(path.join(out, 'artifact-url.txt'), 'utf8').trim()}`);

  // The links of the charts and tests point to lines of the head, so read the code there.
  const localHead = run('git', ['rev-parse', 'HEAD'], { cwd, allowFail: true })?.trim();
  const hasHead = run('git', ['cat-file', '-e', `${facts.headSha}^{commit}`], { cwd, allowFail: true }) !== null;
  if (!hasHead) say(`warning: the local clone does not have the PR head. Run: git fetch origin pull/${facts.number}/head`);
  else if (localHead !== facts.headSha) {
    say(`warning: the local HEAD is not the PR head. Read the PR files in versions/head/ and the others with: git show ${short(facts.headSha)}:<path>`);
  }
}
