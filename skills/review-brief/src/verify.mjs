// Checks that a line of code on the page exists in the PR file. The comparison is by tokens, in order, in a short
// window of lines: it accepts what the page may change (spaces, line breaks, rewritten comments, a cut type,
// `/* ... */` in place of a part) and refuses names, values and calls that are not in the file.

const C_LIKE = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'typescript', 'javascript', 'go', 'swift', 'kotlin', 'kt', 'java', 'c', 'h', 'cpp', 'c++', 'cs', 'csharp', 'rust', 'rs', 'css', 'scss', 'less', 'dart', 'scala', 'php', 'objectivec', 'm', 'groovy', 'graphql', 'proto', 'jsonc', 'zig']);
const HASH = new Set(['py', 'python', 'rb', 'ruby', 'sh', 'bash', 'zsh', 'shell', 'yaml', 'yml', 'toml', 'ini', 'makefile', 'perl', 'r', 'dockerfile', 'elixir', 'ex', 'exs', 'nix', 'hcl', 'terraform']);
const XML = new Set(['html', 'xml', 'svg', 'vue', 'svelte', 'astro']);

export const GAP = '\u0000';
const WORD = /[\p{L}\p{N}_$]/u;

export function commentStyle(lang) {
  const l = String(lang ?? '').toLowerCase();
  if (C_LIKE.has(l)) return 'c';
  if (HASH.has(l)) return 'hash';
  if (l === 'sql') return 'sql';
  if (XML.has(l)) return 'xml';
  return 'none';
}

const CODE_TOKEN = /"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|`(?:\\.|[^`\\])*`?|\/\/|\/\*.*?\*\/|--|#|[\p{L}\p{N}_$]+|\u0001|\S/gu;
const PROSE_TOKEN = /[\p{L}\p{N}_$]+|\u0001|\S/gu;

/**
 * The tokens of a line, without comments. With `page`, `/* ... *\/` and `…` become a GAP: the part that the page
 * left out.
 */
export function lineTokens(line, style, { page = false } = {}) {
  let s = line;
  if (page) s = s.replace(/\/\*\s*(\.\.\.|…)\s*\*\//g, ' \u0001 ').replace(/…/g, ' \u0001 ');
  if (style === 'xml') s = s.replace(/<!--.*?(-->|$)/g, ' ');
  const trimmed = s.trim();
  // A line of a block comment (`/**`, ` * text`, ` */`): the page may rewrite it.
  if ((style === 'c' || style === 'xml') && /^(\/\*|\*\/|\*(\s|$))/.test(trimmed)) return [];

  const tokens = [];
  for (const m of s.matchAll(style === 'none' ? PROSE_TOKEN : CODE_TOKEN)) {
    const t = m[0];
    if ((style === 'c' || style === 'xml') && t === '//') break;
    if ((style === 'c' || style === 'xml') && t.startsWith('/*')) continue;
    if (style === 'hash' && t === '#') break;
    if (style === 'sql' && t === '--') break;
    tokens.push(t === '\u0001' ? GAP : t.replace(/\s+/g, ' '));
  }
  return tokens;
}

export function indexText(text, style) {
  const tokens = [];
  const lineOf = [];
  String(text).split('\n').forEach((line, i) => {
    for (const t of lineTokens(line, style)) {
      tokens.push(t);
      lineOf.push(i + 1);
    }
  });
  const positions = new Map();
  tokens.forEach((t, p) => {
    if (!positions.has(t)) positions.set(t, []);
    positions.get(t).push(p);
  });
  return { tokens, lineOf, positions };
}

// The tokens of a part are at most 3 lines from each other (a page line can join a call broken over several
// lines). After a GAP, the next token can be up to 150 lines ahead (a left-out body). Returns the last line of the
// match, or -1.
function matchAt(index, segments, start) {
  let pos = start;
  let lastLine = index.lineOf[start];
  for (let k = 0; k < segments.length; k++) {
    const segment = segments[k];
    for (let t = k === 0 ? 1 : 0; t < segment.length; t++) {
      const limit = t === 0 ? 150 : 3;
      let p = pos + 1;
      while (p < index.tokens.length && index.tokens[p] !== segment[t] && index.lineOf[p] - lastLine <= limit) p++;
      if (p >= index.tokens.length || index.tokens[p] !== segment[t] || index.lineOf[p] - lastLine > limit) return -1;
      pos = p;
      lastLine = index.lineOf[p];
    }
  }
  return lastLine;
}

/**
 * The line of the file where the page line starts, 0 when the line has nothing to check (comment, punctuation,
 * `// ...`), or -1 when it is not in the file. With `from` and `to`, the matched part must cover some line between
 * them. Among several matches, the shortest wins: `const x` on one line and `x` on the next match, but the line
 * that has both wins.
 */
export function findLine(index, tokens, { from = 1, to = Infinity } = {}) {
  if (!tokens.some((t) => t !== GAP && WORD.test(t))) return 0;
  const segments = [];
  let current = [];
  for (const t of tokens) {
    if (t === GAP) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push(t);
    }
  }
  if (current.length) segments.push(current);

  let best = null;
  for (const start of index.positions.get(segments[0][0]) ?? []) {
    const line = index.lineOf[start];
    if (line > to) break;
    const end = matchAt(index, segments, start);
    if (end === -1 || end < from) continue;
    if (!best || end - line < best.end - best.line) best = { line, end };
  }
  return best ? best.line : -1;
}
