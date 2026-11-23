// Checks the form of a review-brief page against the template and the facts of the PR. The content (what to show
// and how to say it) is the agent's judgment; the form is not, and all of it is here.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseDiff, readRemovedTests } from './diff.mjs';
import { children, closest, find, findAll, hasClass, is, parse, text } from './html.mjs';
import { APP_BLOCK, AVATARS_BLOCK, SLOTS, STYLE_BLOCK, sharedCode, templateText } from './page.mjs';
import { run } from './run.mjs';
import { readChangedTests, scanTests } from './tests.mjs';
import { commentStyle, findLine, indexText, lineTokens } from './verify.mjs';
import { hasVersions, readVersion } from './versions.mjs';

const CHANGE_WORDS = { added: 'added', modified: 'modified', moved: 'moved', removed: 'removed' };

// The words of a test name, to see if the name on the page resembles the one in the code.
function nameWords(name) {
  return name
    .replace(/%[sdifjo#]|\$\w+|\{\w+\}/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_/:.\-()"'`]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !['test', 'tests', 'should'].includes(w));
}

function similarNames(shown, code) {
  const words = nameWords(code);
  if (words.length === 0) return true;
  const shownWords = new Set(nameWords(shown));
  return words.filter((w) => shownWords.has(w)).length >= Math.ceil(words.length / 2);
}

export const MAX_COLUMNS = 100;
export const BUDGET_RATIO = 0.2;
export const BUDGET_MIN = 12;

const IMPORT = /^\s*(import\s[^(]*\sfrom\s|import\s+['"]|export\s+(\*|\{[^}]*\})\s+from\s|export\s+\*\s+as\s+\w+\s+from\s)/;
const PY_IMPORT = /^\s*(from\s+\S+\s+import\s|import\s+[\w.]+(\s+as\s+\w+)?\s*$)/;
// A page comment that sends the reader somewhere else ("see above", "moved to…"). The page can be in English or
// Portuguese, so the list has the words of both.
const POINTER = /\b(above|below|moved|move[sd]? to|came from|comes from|went to|further (?:down|on)|later on|earlier|acima|abaixo|movid[oa]s?|veio de|vem de|foi para|mais adiante)\b/i;
const HIDDEN_ROW_TEXT = /▸\s*(mais\s+)?\d+\s+(more\s+)?(linhas?|lines?)/i;
const COMMENT_URL = /^https:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/\d+#discussion_r\d+$/;
const CODE_NAME = /^(Test[A-Z_]\w*|test_\w+|[a-z]+(?:[A-Z][a-z0-9]*)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*){2,}|[a-z0-9]+(?:_[a-z0-9]+){2,})(\/\S+)?$/;
const CHART_CLASSES = ['muted', 'added', 'removed'];
const CHART_STYLE = /\b(shape|color|fillcolor|fontcolor|fontname|fontsize|penwidth|bgcolor)\s*=/gi;

const columns = (line) => line.replace(/\t/g, '  ').length;

function readText(dir, name) {
  const file = path.join(dir, name);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

function readJson(dir, name) {
  const raw = readText(dir, name);
  return raw === null ? null : JSON.parse(raw);
}

function dotIds(dot) {
  const ids = new Set();
  const KEYWORDS = new Set(['graph', 'node', 'edge', 'digraph', 'subgraph', 'strict']);
  const body = dot.replace(/"(?:\\.|[^"\\])*"/g, '""');
  for (const m of body.matchAll(/([A-Za-z_][\w]*)\s*->\s*([A-Za-z_][\w]*)/g)) ids.add(m[1]).add(m[2]);
  for (const m of body.matchAll(/(?:^|[;{\n])\s*([A-Za-z_][\w]*)\s*(?=\[|;|\n|$)/g)) if (!KEYWORDS.has(m[1])) ids.add(m[1]);
  for (const k of KEYWORDS) ids.delete(k);
  return ids;
}

/** Writes the #avatars block with the avatars of the authors of the comments that the page shows. */
export function embedAvatars(html, avatars) {
  const authors = new Set([...html.matchAll(/<div class="comment"[^>]*\sdata-author="([^"]*)"/g)].map((m) => m[1]));
  const shown = Object.fromEntries([...authors].filter((a) => avatars[a]).map((a) => [a, avatars[a]]));
  const block = `<script type="application/json" id="avatars">${JSON.stringify(shown).replace(/</g, '\\u003c')}</script>`;
  const next = AVATARS_BLOCK.test(html)
    ? html.replace(AVATARS_BLOCK, () => block)
    : html.replace('<script type="module" id="brief-app">', () => `${block}\n<script type="module" id="brief-app">`);
  return { html: next, authors: [...authors], missing: [...authors].filter((a) => !avatars[a]) };
}

export function check(pagePath, { factsDir, write = true, cwd = process.cwd() } = {}) {
  const dir = factsDir ?? path.dirname(path.resolve(pagePath));
  const errors = [];
  const warnings = [];
  const error = (message) => errors.push(message);
  const warn = (message) => warnings.push(message);

  const facts = readJson(dir, 'facts.json');
  const threadFacts = readJson(dir, 'threads.json');
  const avatarFacts = readJson(dir, 'avatars.json') ?? {};
  const diffText = readText(dir, 'full.diff');
  const removedRaw = readText(dir, 'removed-tests.tsv');
  const removedList = removedRaw === null ? null : readRemovedTests(removedRaw);
  const previewRaw = readText(dir, 'preview-url.txt');
  const previewUrl = previewRaw === null ? null : previewRaw.trim();
  const changedRaw = readText(dir, 'changed-tests.tsv');
  const changedList = changedRaw === null ? null : readChangedTests(changedRaw);
  if (!facts) warn(`${dir} has no facts.json: the facts of the PR were not checked. Run gather in the page's folder.`);

  // The versions of the files (head and merge base) that gather saved, indexed to find lines.
  const versioned = hasVersions(dir);
  if (facts && !versioned) warn('The folder has no versions/: the code, the test lines and the thread lines were not checked against the files of the PR. Run gather again.');
  const unverified = new Set();
  const indexes = new Map();
  const indexFor = (side, file, lang) => {
    const key = `${side}\0${file}\0${commentStyle(lang)}`;
    if (!indexes.has(key)) {
      const textOf = versioned ? readVersion(dir, side, file) : null;
      if (versioned && textOf === null) unverified.add(`${file} (${side === 'head' ? 'head' : 'merge base'})`);
      indexes.set(key, textOf === null ? null : indexText(textOf, commentStyle(lang)));
    }
    return indexes.get(key);
  };
  const scans = new Map();
  const testsIn = (side, file) => {
    const key = `${side}\0${file}`;
    if (!scans.has(key)) {
      const textOf = versioned ? readVersion(dir, side, file) : null;
      if (versioned && textOf === null) unverified.add(`${file} (${side === 'head' ? 'head' : 'merge base'})`);
      scans.set(key, textOf === null ? null : scanTests(textOf));
    }
    return scans.get(key);
  };
  const threadByUrl = new Map();
  for (const t of threadFacts ?? []) for (const c of t.comments) threadByUrl.set(c.url, t);

  // Avatars: derived data, so check writes the block instead of asking the agent.
  let html = readFileSync(pagePath, 'utf8');
  const embedded = embedAvatars(html, avatarFacts);
  if (embedded.html !== html && write) writeFileSync(pagePath, embedded.html);
  html = embedded.html;
  for (const author of embedded.missing) warn(`The author ${author} has no avatar in avatars.json. The page shows only the name.`);

  const template = templateText();
  const shared = sharedCode(template);
  for (const [label, pattern] of [['The <style id="brief-base">', STYLE_BLOCK], ['The <script id="brief-app">', APP_BLOCK]]) {
    const mine = html.match(pattern)?.[0];
    if (!mine) error(`${label} of the template is missing from the page.`);
    else if (mine !== template.match(pattern)[0]) error(`${label} is not the same as the template's. Do not change the form: copy the template again and redo only the content.`);
  }
  for (const slot of SLOTS) if (html.includes(`{{${slot}}}`)) error(`The slot {{${slot}}} is still on the page.`);
  if (statSync(pagePath).size > 8 * 1024 * 1024) warn('The page is over 8 MB. The Artifact limit is 16 MB.');

  const root = parse(html);
  const main = find(root, is('main'));
  if (!main) {
    error('The page has no <main>.');
    return { errors, warnings, summary: null };
  }

  // Header
  const repo = main.attrs['data-repo'] ?? '';
  if (!/^https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+$/.test(repo)) error('<main data-repo> must be https://github.com/<owner>/<repo>.');
  else if (facts && repo !== facts.repoUrl) error(`<main data-repo> is ${repo}, but the PR is from ${facts.repoUrl}.`);
  if (!/^\d+$/.test(main.attrs['data-pr'] ?? '')) error('<main data-pr> must be the PR number.');
  else if (facts && Number(main.attrs['data-pr']) !== facts.number) error(`<main data-pr> is ${main.attrs['data-pr']}, but the PR is #${facts.number}.`);
  const headSha = main.attrs['data-head-sha'] ?? '';
  if (!/^[0-9a-f]{40}$/.test(headSha)) error('<main data-head-sha> must be the full SHA of the PR head commit.');
  else if (facts && headSha !== facts.headSha) error(`<main data-head-sha> is ${headSha.slice(0, 10)}, but the PR head is now ${facts.headSha.slice(0, 10)}. Update the page to the new head.`);
  if (!main.attrs.lang) error('<main lang> must be the language of the page (en or pt-BR).');

  const title = find(root, is('title'))?.text.trim() ?? '';
  const h1 = find(main, is('h1'));
  if (!h1) error('The page has no <h1>.');
  else if (text(h1).trim() !== title) error('<title> and <h1> must be the same text: the PR title.');
  if (facts && title && title !== facts.title.trim()) error(`The page title is not the PR title on GitHub: "${facts.title}".`);

  const stats = find(main, (n) => n.tag === 'p' && hasClass(n, 'stats'));
  if (!stats) error('The header lost the <p class="stats">.');
  else if (facts && (Number(stats.attrs['data-pr-additions']) !== facts.additions || Number(stats.attrs['data-pr-deletions']) !== facts.deletions)) {
    error(`.stats needs data-pr-additions="${facts.additions}" and data-pr-deletions="${facts.deletions}" (from facts.json).`);
  }
  if (findAll(root, (n) => hasClass(n, 'eyebrow') || hasClass(n, 'kicker')).length > 0) error('The page has an eyebrow. Do not use eyebrows.');

  for (const a of findAll(root, is('a'))) {
    const label = text(a).trim();
    const m = label.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
    if (m && facts && m[1].toLowerCase() === facts.owner.toLowerCase()) error(`The link text "${label}" repeats the repository owner. Write "${m[2]}#${m[3]}".`);
  }

  // Index and sections
  const sections = findAll(main, is('section'));
  const sectionIds = sections.map((s) => s.attrs.id);
  if (sectionIds.some((id) => !id)) error('Every <section> needs an id, so the index can link to it.');
  for (const s of sections) if (!children(s, is('h2')).length) warn(`The section #${s.attrs.id ?? '?'} has no <h2>.`);
  const navIds = findAll(root, (n) => n.tag === 'a' && closest(n, is('ol', 'index'))).map((a) => (a.attrs.href ?? '').replace(/^#/, ''));
  if (navIds.join('\n') !== sectionIds.join('\n')) {
    error(`The index (${navIds.join(', ') || 'empty'}) must have one link per section, in page order (${sectionIds.join(', ') || 'none'}).`);
  }

  const previewLinks = findAll(root, is('a', 'preview-link'));
  if (previewUrl !== null) {
    if (previewUrl && (previewLinks.length !== 1 || previewLinks[0].attrs.href !== previewUrl)) error(`The index needs a preview link to ${previewUrl} (from preview-url.txt).`);
    if (!previewUrl && previewLinks.length > 0) error('The PR has no published preview (preview-url.txt is empty): remove the <a class="preview-link">.');
  }

  // Diffs
  const diffFiles = diffText === null ? null : parseDiff(diffText);
  const byNew = new Map((diffFiles ?? []).filter((f) => f.newPath).map((f) => [f.newPath, f]));
  const byOld = new Map((diffFiles ?? []).filter((f) => f.oldPath).map((f) => [f.oldPath, f]));
  const removedEverywhere = new Set((diffFiles ?? []).flatMap((f) => [...f.removed.values()].map((l) => l.trim())));
  const shownCommentUrls = new Set();
  let shownAdded = 0;
  let shownRemoved = 0;
  let hiddenLines = 0;

  const figures = findAll(main, is('figure', 'diff'));
  figures.forEach((fig, index) => {
    const filePath = fig.attrs['data-path'];
    const label = `Diff ${index + 1} (${fig.attrs['data-name'] || filePath || 'no path'})`;
    if (!filePath) error(`${label}: data-path is missing.`);
    if (!fig.attrs['data-lang']) error(`${label}: data-lang is missing.`);

    const scripts = children(fig, is('script'));
    const oldScript = scripts.find((s) => hasClass(s, 'old'));
    const newScript = scripts.find((s) => hasClass(s, 'new'));
    for (const s of scripts) if (!hasClass(s, 'old') && !hasClass(s, 'new')) error(`${label}: a <script> without class="old" or class="new".`);
    const sides = { old: oldScript?.text, new: newScript?.text };
    if (!sides.old?.trim() && !sides.new?.trim()) {
      error(`${label}: has no code.`);
      return;
    }
    for (const side of ['old', 'new']) {
      if (sides[side] !== undefined && !sides[side].trim()) error(`${label}: the ${side} side is empty. With no code on that side, remove the <script class="${side}">.`);
    }

    const blocks = {};
    for (const side of ['old', 'new']) {
      if (sides[side] === undefined) continue;
      blocks[side] = [];
      let open = null;
      const python = /^(py|python)$/i.test(fig.attrs['data-lang'] ?? '');
      for (const line of shared.splitLines(sides[side])) {
        if (columns(line) > MAX_COLUMNS) error(`${label} (${side}): line with ${columns(line)} columns; the limit is ${MAX_COLUMNS}: ${line.trim().slice(0, 60)}`);
        if (IMPORT.test(line) || (python && PY_IMPORT.test(line))) error(`${label} (${side}): imports and re-exports never appear: ${line.trim()}`);
        if (/^\s*(\/\/|#)!/.test(line) && POINTER.test(line)) error(`${label} (${side}): a page comment points to other code. Show that code in a diff, in its place: ${line.trim()}`);
        if (HIDDEN_ROW_TEXT.test(line)) error(`${label} (${side}): "${line.trim()}" is the line that the template writes for a hidden block. Write the block between //{ and //}.`);
        if (shared.HIDDEN_OPEN.test(line)) {
          if (open) error(`${label} (${side}): a //{ inside another hidden block. Hidden blocks do not nest.`);
          open = [];
        } else if (shared.HIDDEN_CLOSE.test(line)) {
          if (!open) error(`${label} (${side}): a //} without a //{ before it.`);
          else blocks[side].push(open);
          open = null;
        } else if (open) {
          open.push(line.trim());
        }
      }
      if (open) error(`${label} (${side}): a //{ without a //} after it.`);
    }

    const twoSided = Boolean(oldScript && newScript);
    const blockCount = (blocks.old?.length ?? 0) + (blocks.new?.length ?? 0);
    if (blockCount > 0 && !twoSided) {
      error(`${label}: a hidden block is only for unchanged code, so it needs both sides (old and new).`);
    } else if (twoSided) {
      if (blocks.old.length !== blocks.new.length) {
        error(`${label}: the old side has ${blocks.old.length} hidden blocks and the new side has ${blocks.new.length}. They must be the same.`);
      } else {
        blocks.old.forEach((block, k) => {
          if (block.join('\n') !== blocks.new[k].join('\n')) error(`${label}: hidden block ${k + 1} is not the same on both sides. Hide only unchanged code.`);
          if (!block.some(Boolean)) error(`${label}: hidden block ${k + 1} is empty.`);
          hiddenLines += block.filter(Boolean).length;
        });
      }
    }

    const count = shared.countShown(sides.old, sides.new);
    shownAdded += count.added;
    shownRemoved += count.removed;

    // data-line: the anchor of the ↗ only exists on a line that the PR diff shows.
    const lineAttr = fig.attrs['data-line'];
    const movedFrom = (fig.attrs['data-name'] ?? '').includes('→') ? fig.attrs['data-name'].split('→')[0].trim() : null;
    const lang = fig.attrs['data-lang'];
    const style = commentStyle(lang);
    const fileOf = (side) => (side === 'new' ? filePath : movedFrom ?? filePath);
    const versionOf = (side) => (side === 'new' ? 'head' : 'base');

    // Each shown line of code exists in the file of that side. Comments can be rewritten; spaces, line breaks and
    // parts replaced by `/* ... */` do not count. Rendered text (a prompt) is not in the file, so data-rendered
    // leaves it out.
    if (versioned && filePath && !('data-rendered' in fig.attrs)) {
      for (const side of ['old', 'new']) {
        if (sides[side] === undefined) continue;
        const index = indexFor(versionOf(side), fileOf(side), lang);
        if (!index) continue;
        const misses = shared.readSide(sides[side]).full.filter((line) => findLine(index, lineTokens(line, style, { page: true })) === -1);
        if (misses.length > 0) {
          const where = side === 'new' ? 'in the head' : 'in the merge base';
          const sample = misses.slice(0, 3).map((l) => `“${l.trim().slice(0, 70)}”`).join(', ');
          error(`${label} (${side}): ${misses.length} ${misses.length === 1 ? 'line is not' : 'lines are not'} in ${fileOf(side)} ${where}: ${sample}. Show the code of the PR, shortened with // ... and /* ... */; only the comments can be rewritten.`);
        }
      }
    }
    if (!/^\d+$/.test(lineAttr ?? '')) {
      error(`${label}: data-line="${lineAttr ?? ''}" must be the number of the first changed line of the shown code.`);
    } else if (diffFiles && filePath) {
      const n = Number(lineAttr);
      const shownChanged = (side) => {
        const a = shared.readSide(sides.old).shown.map((l) => l.text);
        const b = shared.readSide(sides.new).shown.map((l) => l.text);
        return shared.diffRows(a, b)
          .filter((op) => op.type === (side === 'new' ? 'add' : 'del'))
          .map((op) => (side === 'new' ? b[op.b] : a[op.a]).trim())
          .filter((l) => l && !l.startsWith('//!'));
      };
      const suggest = (file, side) => {
        const wanted = new Set(shownChanged(side));
        const lines = side === 'new' ? file.added : file.removed;
        const hit = [...lines].find(([, t]) => wanted.has(t.trim()));
        return hit ? ` (maybe ${hit[0]})` : '';
      };

      if (newScript) {
        const file = byNew.get(filePath);
        if (!file) error(`${label}: the PR does not change ${filePath}. data-path is the path in the head.`);
        else if (!file.added.has(n)) error(`${label}: line ${n} of ${filePath} is not a line that the PR adds or changes${suggest(file, 'new')}.`);
        if (file && !oldScript && file.oldPath) error(`${label}: has only the new side, but ${filePath} already existed: the page would say "new file". Show both sides, with the same context shortened the same way.`);
      } else {
        const oldPath = movedFrom ?? filePath;
        const file = byOld.get(oldPath);
        if (!file) error(`${label}: the PR does not remove code from ${oldPath}.`);
        else if (!file.removed.has(n)) error(`${label}: line ${n} of ${oldPath} (in the merge base) is not a line that the PR removes${suggest(file, 'old')}.`);
        if (file && file.newPath && !movedFrom) error(`${label}: has only the old side, but ${oldPath} stays in the PR: the page would say "deleted file". Show both sides.`);
      }
    }

    // "New" code that already existed in the merge base: moved or extracted.
    if (newScript && !oldScript && diffFiles) {
      const lines = shared.splitLines(sides.new).map((l) => l.trim())
        .filter((l) => l.length >= 20 && !/^(\/\/|#|\/\*|\*)/.test(l));
      if (lines.length >= 3) {
        const base = facts?.mergeBase ? run('git', ['show', `${facts.mergeBase}:${filePath}`], { cwd, allowFail: true }) : null;
        const baseLines = new Set((base ?? '').split('\n').map((l) => l.trim()));
        const found = lines.filter((l) => removedEverywhere.has(l) || baseLines.has(l)).length;
        if (found / lines.length >= 0.6) warn(`${label}: ${found} of ${lines.length} lines already existed in the merge base. If it is moved or extracted code, show it as a move (old side in the old file) or an extraction (old side with the original function).`);
      }
    }

    // Threads
    for (const thread of children(fig, is('div', 'thread'))) {
      const side = thread.attrs['data-side'];
      if (side !== 'old' && side !== 'new') {
        error(`${label}: a thread without data-side="old" or data-side="new".`);
        continue;
      }
      if (sides[side] === undefined) {
        error(`${label}: a thread on data-side="${side}", but the diff does not have that side.`);
        continue;
      }
      const shown = shared.readSide(sides[side]).shown;
      const n = Number(thread.attrs['data-line']);
      if (!Number.isInteger(n) || n < 1 || n > shown.length) {
        error(`${label}: a thread has data-line="${thread.attrs['data-line'] ?? ''}", which is not a line of the shown ${side} code (1 to ${shown.length}). Count the lines of the shortened code, with each hidden block as one line.`);
      } else if (shown[n - 1].hidden) {
        error(`${label}: a thread is in a hidden block. Keep the thread's line outside the //{ … //}.`);
      } else {
        // The thread goes on the line of code where it was written: the same side, the same file, the same line.
        const fact = findAll(thread, is('div', 'comment')).map((c) => threadByUrl.get(c.attrs['data-href'])).find(Boolean);
        if (fact && fact.side !== side) {
          error(`${label}: the thread by ${fact.comments[0].author} is on the ${fact.side} side on GitHub, but it is on data-side="${side}".`);
        } else if (fact && fact.path !== fileOf(side)) {
          error(`${label}: the thread by ${fact.comments[0].author} is about ${fact.path}, but it is in a diff of ${fileOf(side)}.`);
        } else if (fact?.line && versioned) {
          const index = indexFor(versionOf(side), fileOf(side), lang);
          const range = { from: fact.startLine ?? fact.line, to: fact.line };
          const at = (line) => findLine(index, lineTokens(line, style, { page: true }), range);
          if (index && at(shown[n - 1].text) === -1) {
            const better = shown.findIndex((line) => !line.hidden && at(line.text) > 0);
            error(`${label}: the thread by ${fact.comments[0].author} is about line ${fact.line} of ${fact.path}, but data-line="${n}" shows “${shown[n - 1].text.trim().slice(0, 60)}”${better >= 0 ? ` (maybe data-line="${better + 1}")` : ''}.`);
          }
        }
      }

      const comments = findAll(thread, is('div', 'comment'));
      if (comments.length === 0) error(`${label}: a thread without comments.`);
      for (const comment of comments) {
        if (!comment.attrs['data-author']) error(`${label}: a comment without data-author.`);
        const href = comment.attrs['data-href'] ?? '';
        if (!COMMENT_URL.test(href)) error(`${label}: a comment has data-href="${href}", which is not the URL of a GitHub review comment.`);
        shownCommentUrls.add(href);
        const markdown = find(comment, (n) => n.tag === 'script' && n.attrs.type === 'text/markdown');
        if (!markdown?.text.trim()) error(`${label}: a comment without the Markdown in <script type="text/markdown">.`);
        else if (markdown.text.split('\n').filter((l) => l.trim()).every((l) => /^\s{2,}/.test(l))) error(`${label}: the Markdown of the comment by ${comment.attrs['data-author']} is indented. Start the lines at column 0 (an indented line becomes code).`);
      }
    }
  });

  for (const thread of findAll(root, is('div', 'thread'))) {
    if (!closest(thread, is('figure', 'diff'))) error('A thread is outside a <figure class="diff">. It goes inside the diff of its code, after the scripts.');
  }

  // An open thread by a person always shows. One by AI shows when it points out a behavior problem that is still
  // open, which check cannot judge: it only lists the ones left out, in the summary, not as a warning that can
  // never be silenced.
  const aiLeftOut = [];
  if (threadFacts) {
    for (const t of threadFacts) {
      const urls = t.comments.map((c) => c.url);
      const shown = urls.some((u) => shownCommentUrls.has(u));
      const open = !t.isResolved && !t.isOutdated;
      if (open && t.startedByHuman && !shown) error(`A person opened this thread and it is still open: the page must show it. ${t.path}:${t.line ?? '?'} by ${t.comments[0]?.author} ${urls[0]}`);
      if (!open && shown) error(`The page shows a ${t.isResolved ? 'resolved' : 'outdated'} thread. Remove it: ${urls[0]}`);
      if (open && !t.startedByHuman && !shown) aiLeftOut.push(t);
    }
  }

  // Code examples
  findAll(main, is('figure', 'example')).forEach((fig, index) => {
    const label = `Example ${index + 1}`;
    if (!fig.attrs['data-lang']) error(`${label}: data-lang is missing.`);
    if (fig.attrs['data-path'] || fig.attrs['data-line']) error(`${label}: an example is not in the repository, so it has no data-path or data-line.`);
    const code = children(fig, is('script'))[0]?.text ?? '';
    if (!code.trim()) error(`${label}: the code in a <script type="text/plain"> is missing.`);
    for (const line of sharedLines(shared, code)) {
      if (columns(line) > MAX_COLUMNS) error(`${label}: line with ${columns(line)} columns; the limit is ${MAX_COLUMNS}: ${line.trim().slice(0, 60)}`);
    }
  });
  if (findAll(main, (n) => n.tag === 'pre' && children(n, is('code')).length > 0).length > 0) {
    error('There is code in <pre><code>. Write it as <figure class="example"> (or a diff), so the page highlights it.');
  }

  // Charts
  if (findAll(root, (n) => n.tag === 'pre' && hasClass(n, 'mermaid')).length > 0) error('A chart uses Mermaid. Write it in DOT, in <script type="text/plain" class="dot">.');
  findAll(main, is('div', 'chart')).forEach((chart, index) => {
    const label = `Chart ${index + 1}`;
    const dot = children(chart, (n) => n.tag === 'script' && hasClass(n, 'dot'))[0]?.text ?? '';
    if (!dot.trim()) {
      error(`${label}: <script type="text/plain" class="dot"> is missing.`);
      return;
    }
    if (!/^\s*digraph\b[^{]*\{/.test(dot)) error(`${label}: start with "digraph {".`);
    if (/constraint\s*=\s*"?false/i.test(dot)) error(`${label}: remove constraint=false. With it, Graphviz places the arrow labels after the layout, and they overlap.`);
    for (const attr of new Set([...dot.matchAll(CHART_STYLE)].map((m) => m[1].toLowerCase()))) {
      error(`${label}: remove ${attr}. The template sets the look of boxes and arrows.`);
    }
    const inPair = Boolean(closest(chart, is('div', 'chart-pair')));
    for (const m of dot.matchAll(/\bclass\s*=\s*(?:"([^"]*)"|([\w-]+))/g)) {
      for (const name of (m[1] ?? m[2]).split(/\s+/).filter(Boolean)) {
        if (!CHART_CLASSES.includes(name)) error(`${label}: the class "${name}" does not exist. Use muted, added or removed.`);
        else if (name !== 'muted' && !inPair) error(`${label}: the class "${name}" is only for a before/now pair (<div class="chart-pair">).`);
      }
    }

    const ids = dotIds(dot);
    const raw = chart.attrs['data-links'];
    if (!raw) {
      warn(`${label}: without data-links, the boxes do not open the code.`);
      return;
    }
    let links;
    try {
      links = JSON.parse(raw);
    } catch {
      error(`${label}: data-links is not valid JSON.`);
      return;
    }
    for (const [id, target] of Object.entries(links)) {
      if (!ids.has(id)) error(`${label}: data-links has "${id}", but the chart has no such box.`);
      if (!/^[^#\s]+#L\d+(-L\d+)?$/.test(String(target))) error(`${label}: the link "${target}" must be "<path>#L<line>" or "<path>#L<a>-L<b>".`);
    }
  });

  // Decisions
  findAll(main, is('details', 'decision')).forEach((decision, index) => {
    const label = `Decision ${index + 1}`;
    if ('open' in decision.attrs) error(`${label} is open. A decision starts closed (no open).`);
    const summary = children(decision, is('summary'))[0];
    if (!summary) {
      error(`${label}: the <summary> is missing.`);
      return;
    }
    const first = children(summary)[0];
    if (!first || !hasClass(first, 'label')) error(`${label}: the <summary> starts with <span class="label">Decision</span>.`);
    const head = find(summary, (n) => hasClass(n, 'decision-head'));
    const title = find(summary, (n) => hasClass(n, 'decision-title'));
    if (!head) error(`${label}: <span class="decision-head"> is missing.`);
    if (!title || !text(title).trim()) error(`${label}: the choice in <span class="decision-title"> is missing.`);
    const origin = find(summary, (n) => hasClass(n, 'implicit'));
    if (origin && !/^(implicit|implícita)$/i.test(text(origin).trim())) error(`${label}: the only origin label is "Implicit" (or "Implícita" on a Portuguese page), and only on an implicit decision.`);
    const links = findAll(decision, is('a', 'discussion'));
    if (links.length > 1) error(`${label}: has ${links.length} discussion links. Link only the message where the discussion starts.`);
    for (const link of links) {
      if (!/^https?:\/\//.test(link.attrs.href ?? '')) error(`${label}: the discussion link needs an http(s) href.`);
      if (head && children(head).at(-1) !== link) error(`${label}: the discussion link is the last item of .decision-head.`);
    }
    const body = children(decision, (n) => hasClass(n, 'decision-body'))[0];
    if (!body) {
      error(`${label}: <div class="decision-body"> is missing.`);
      return;
    }
    const kids = children(body);
    const why = kids.findIndex((n) => hasClass(n, 'why'));
    const cost = kids.findIndex((n) => hasClass(n, 'cost'));
    if (why === -1) error(`${label}: the reason in <p class="why"> is missing.`);
    if (cost === -1) warn(`${label}: no <p class="cost">. If the description says the trade-off of the choice, show it.`);
    else {
      if (why > cost) error(`${label}: the trade-off comes before the reason. Show the reason first.`);
      if (!find(kids[cost], (n) => hasClass(n, 'label'))) error(`${label}: the trade-off starts with <span class="label">Trade-off</span>.`);
    }
  });

  // Terms
  const terms = new Set();
  for (const dfn of findAll(root, is('dfn'))) {
    const term = text(dfn).trim();
    const tip = dfn.attrs['data-tip'] ?? '';
    if (!hasClass(dfn, 'term')) error(`The term "${term}" needs class="term".`);
    if (!tip.trim()) error(`The term "${term}" needs the explanation in data-tip.`);
    if ((tip.match(/`/g) ?? []).length % 2) error(`The data-tip of "${term}" has a backtick without a pair.`);
    if (/<[a-z/!]/i.test(tip)) error(`The data-tip of "${term}" has HTML. Write code between backticks.`);
    if (tip.includes('"')) warn(`The data-tip of "${term}" has straight quotes. Use typographic quotes (“ ”).`);
    const key = term.toLowerCase();
    if (terms.has(key)) error(`The term "${term}" is explained more than once. Keep only the <dfn> of the first use.`);
    terms.add(key);
  }

  // Tests
  const tests = [];
  for (const block of findAll(main, is('div', 'tests'))) {
    for (const file of children(block)) {
      const filePath = file.attrs['data-path'];
      if (!filePath) {
        error('Each test file is a <div data-path="<file>"> inside <div class="tests">.');
        continue;
      }
      const items = findAll(file, (n) => (n.tag === 'li' || n.tag === 'td') && 'data-change' in n.attrs).map((node) => ({
        node,
        path: filePath,
        line: Number(node.attrs['data-line']),
        rawLine: node.attrs['data-line'] ?? '',
        change: node.attrs['data-change'],
        renamed: node.attrs['data-renamed-from'] ?? null,
        name: text(node).trim(),
      }));

      for (const t of items) {
        if (!/^\d+$/.test(t.rawLine)) error(`The test "${t.name}" has data-line="${t.rawLine}". It must be a line number.`);
        if (!['added', 'modified', 'removed'].includes(t.change)) error(`The test "${t.name}" needs data-change="added", "modified" or "removed".`);
        if (t.renamed !== null) {
          if (t.change !== 'modified') error(`The test "${t.name}" has data-renamed-from, so it is data-change="modified".`);
          if (!/^(\S+:\d+)(\s+\S+:\d+)*$/.test(t.renamed.trim())) error(`The data-renamed-from of "${t.name}" must be "<path>:<line>", separated by spaces.`);
        }
        if (!/\s/.test(t.name) && CODE_NAME.test(t.name)) error(`The test "${t.name}" has the code name. Write it in words (for example "Upsert alias keeps description").`);
        if (t.node.tag === 'li' && children(t.node, (n) => n.tag === 'ul' || n.tag === 'ol').length > 0) error(`The test "${t.name}" has a list inside. Groups are <li class="describe"> or <li class="cases">, without data-change.`);

        // data-line is the line that declares the test: in the head, or in the merge base for a removed one.
        const side = t.change === 'removed' ? 'base' : 'head';
        const declared = /^\d+$/.test(t.rawLine) ? testsIn(side, filePath) : null;
        if (!declared) continue;
        const decl = declared.find((d) => d.line === t.line);
        if (!decl) {
          const nearest = [...declared].sort((x, y) => Math.abs(x.line - t.line) - Math.abs(y.line - t.line))[0];
          error(`The test "${t.name}" has data-line="${t.line}", but ${filePath} does not declare a test on that line ${side === 'head' ? 'in the head' : 'in the merge base'}${nearest ? ` (the nearest: "${nearest.name}", line ${nearest.line})` : ''}.`);
          continue;
        }
        if (!similarNames(t.name, decl.name)) warn(`The test shown as "${t.name}" (${filePath}:${t.line}) is called "${decl.name}" in the code. Check the line; if the code name misrepresents the test, say so in a note.`);
        if (changedList) {
          const row = changedList.find((r) => r.path === filePath && r.line === t.line && (r.change === 'removed') === (t.change === 'removed'));
          if (!row) warn(`The PR does not change the test "${t.name}" (${filePath}:${t.line}), according to changed-tests.tsv. The page shows only tests that the PR changes.`);
          else if (row.change !== t.change && !(row.change === 'added' && t.renamed !== null) && !(row.change === 'moved' && t.change === 'modified')) {
            warn(`changed-tests.tsv says that "${t.name}" was ${CHANGE_WORDS[row.change]}, and the page says ${CHANGE_WORDS[t.change] ?? t.change}. Check it.`);
          }
        }
      }

      const byLine = new Map();
      for (const t of items) byLine.set(t.line, [...(byLine.get(t.line) ?? []), t]);
      for (const [line, same] of byLine) {
        if (same.length < 2) continue;
        const groups = new Set(same.map((t) => closest(t.node, (n) => hasClass(n, 'cases'))));
        if (groups.has(null) || groups.size > 1) error(`"${same[0].name}" and "${same[1].name}" (${filePath}) have the same data-line ${line}: they are cases of one test, so they go in an <li class="cases">.`);
      }

      const prefixes = new Map();
      for (const t of items) {
        const m = t.name.match(/^([^:]{3,60}):\s/);
        if (m) prefixes.set(m[1], (prefixes.get(m[1]) ?? 0) + 1);
      }
      for (const [prefix, n] of prefixes) if (n > 1) warn(`${n} tests of ${filePath} start with "${prefix}: ". Put them in an <li class="describe"> group with that name.`);
      tests.push(...items);
    }
  }

  if (removedList) {
    for (const r of removedList) {
      const ok = tests.some((t) => (t.change === 'removed' && t.path === r.path && t.line === r.line)
        || (t.renamed ?? '').split(/\s+/).includes(`${r.path}:${r.line}`));
      if (!ok) error(`The PR removes the test "${r.name}" (${r.path}:${r.line}). Show it as removed, or show the test that replaces it with data-renamed-from="${r.path}:${r.line}".`);
    }
    for (const t of tests) {
      if (t.change === 'removed' && !removedList.some((r) => r.path === t.path && r.line === t.line)) {
        warn(`The page shows "${t.name}" (${t.path}:${t.line}) as removed, but removed-tests.tsv does not list it. Check the path and the line in the merge base.`);
      }
      for (const ref of (t.renamed ?? '').split(/\s+/).filter(Boolean)) {
        if (!removedList.some((r) => `${r.path}:${r.line}` === ref)) warn(`"${t.name}" says it replaces ${ref}, but removed-tests.tsv does not list that test.`);
      }
    }
  }

  if (unverified.size > 0) warn(`No saved version to check against (binary, or gathering failed): ${[...unverified].join(', ')}.`);

  // Budget: the shown lines are at most 20% of the lines of the PR.
  const testsRemoved = tests.filter((t) => t.change === 'removed').length;
  const added = shownAdded + tests.length - testsRemoved;
  const removed = shownRemoved + testsRemoved;
  const shown = added + removed;
  let summary = `Shown lines: +${added} −${removed}. Hidden lines: ${hiddenLines}.`;
  if (facts) {
    const total = facts.additions + facts.deletions;
    const limit = Math.max(Math.floor(total * BUDGET_RATIO), BUDGET_MIN);
    summary = `Shown lines: +${added} −${removed} = ${shown} of ${total} (${total ? Math.round((shown / total) * 100) : 0}%; limit ${limit}). Hidden lines: ${hiddenLines}.`;
    if (shown > limit) error(`The page shows ${shown} lines; the limit is ${limit} (20% of the ${total} lines of the PR). Cut first the diffs that repeat a pattern already shown, then implementation details.`);
  }
  if (aiLeftOut.length > 0) {
    summary += `\nOpen AI threads left off the page: ${aiLeftOut.length}. Show the ones that point out a behavior problem that is still open:`;
    for (const t of aiLeftOut) summary += `\n  ${t.path}:${t.line ?? '?'} by ${t.comments[0]?.author}: ${t.comments[0]?.body.split('\n')[0].slice(0, 90)} ${t.comments[0]?.url}`;
  }

  return { errors, warnings, summary };
}

function sharedLines(shared, code) {
  return shared.splitLines(code);
}
