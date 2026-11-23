// The tests declared in a file and the tests that the PR changes. The extent of each test comes from the indentation,
// which the repo's formatter already keeps consistent: the test goes from the line that declares it to the next line
// with the same indentation or less.
import { removedTests, TEST_FILE, testName } from './diff.mjs';

const GROUPS = [
  /(?:^|[^\w.$])(?:describe|context|suite)(?:\.(?:only|skip|concurrent|serial|parallel|sequential))*\(\s*(["'`])(?<name>(?:\\.|(?!\1).)*)\1/,
  /^\s*(?:RSpec\.)?describe\s+(["'])(?<name>(?:\\.|(?!\1).)*)\1/,
  /^\s*class\s+(?<name>Test\w*)\s*[:(]/,
  /@Suite\s*\(\s*"(?<name>(?:\\.|[^"])*)"/,
  /^\s*(?:final\s+)?class\s+(?<name>\w+)\s*:\s*XCTestCase\b/,
];
// it.each([...])('name %s', …): the name is on the line that closes the table.
const EACH_HEAD = /(?:^|[^\w.$])(?:it|test)(?:\.(?:only|skip|concurrent))*\.each\b/;
const EACH_TAIL = /^\s*[\])`]*\s*\)\s*\(\s*(["'`])(?<name>(?:\\.|(?!\1).)*)\1/;
const GO_SUBTEST = /\bt\.Run\(\s*"(?<name>(?:\\.|[^"])*)"/;

const indentOf = (line) => line.match(/^\s*/)[0].replace(/\t/g, '  ').length;

function matchName(patterns, line) {
  for (const pattern of patterns) {
    const name = line.match(pattern)?.groups?.name;
    if (name) return name;
  }
  return null;
}

/** The last line (index) of the block that starts at line `i`. */
function blockEnd(lines, i) {
  const indent = indentOf(lines[i]);
  let end = lines.length - 1;
  for (let j = i + 1; j < lines.length; j++) {
    if (!lines[j].trim()) continue;
    if (indentOf(lines[j]) <= indent) {
      end = /^\s*([)}\]]|end\b)/.test(lines[j]) ? j : j - 1;
      break;
    }
  }
  // Blank lines at the end are not part of the block (Python has no closing line).
  while (end > i && !lines[end].trim()) end--;
  return end;
}

/** Tests declared in the text: { line, end, name, group, param }, with lines from 1. */
export function scanTests(text) {
  const lines = String(text ?? '').split('\n');
  const tests = [];
  const groups = [];

  for (let i = 0; i < lines.length; i++) {
    while (groups.length > 0 && i > groups[groups.length - 1].end) groups.pop();
    const line = lines[i];
    const group = matchName(GROUPS, line);
    if (group) {
      groups.push({ name: group, end: blockEnd(lines, i) });
      continue;
    }

    let name = testName(line);
    let start = i;
    let param = false;
    if (!name) {
      const tail = line.match(EACH_TAIL)?.groups?.name;
      if (tail) {
        for (let k = i - 1; k >= Math.max(0, i - 100); k--) {
          if (EACH_HEAD.test(lines[k])) {
            start = k;
            break;
          }
        }
        if (start !== i) {
          name = tail;
          param = true;
        }
      }
    }

    if (!name) {
      // Go subtest: t.Run("case", …) inside a TestX.
      const sub = line.match(GO_SUBTEST)?.groups?.name;
      const parent = sub && [...tests].reverse().find((t) => t.end >= i + 1 && /^Test/.test(t.name) && !t.name.includes('/'));
      if (parent) tests.push({ line: i + 1, end: blockEnd(lines, i) + 1, name: `${parent.name}/${sub}`, group: parent.group, param: false });
      continue;
    }

    tests.push({ line: start + 1, end: blockEnd(lines, i) + 1, name, group: groups.map((g) => g.name).join(' › '), param });
  }
  return tests;
}

const isTestFile = (f) => TEST_FILE.test(f.newPath ?? '') || TEST_FILE.test(f.oldPath ?? '');

/**
 * The tests that the PR adds, modifies, moves or removes. `version(side, path)` returns the text of the file in the
 * 'head' or the 'base'. Modified: some line of the test body changed. Moved: the test existed in another file.
 * The removed ones come from the diff, like removed-tests.tsv.
 */
export function changedTests(diffFiles, version) {
  const files = diffFiles.filter(isTestFile).map((f) => ({
    f,
    head: f.newPath ? scanTests(version('head', f.newPath)) : [],
    base: f.oldPath ? scanTests(version('base', f.oldPath)) : [],
  }));
  const baseNames = new Map();
  for (const { f, base } of files) for (const t of base) baseNames.set(t.name, [...(baseNames.get(t.name) ?? []), f.oldPath]);

  const rows = [];
  for (const { f, head, base } of files) {
    const added = [...f.added.keys()];
    const removed = [...f.removed.keys()];
    for (const t of head) {
      const before = base.find((b) => b.name === t.name && b.group === t.group) ?? base.find((b) => b.name === t.name);
      const elsewhere = !before && (baseNames.get(t.name) ?? []).some((p) => p !== f.oldPath);
      const touched = added.some((n) => n >= t.line && n <= t.end) || (before && removed.some((n) => n >= before.line && n <= before.end));
      let change = null;
      if (!before && !elsewhere) change = 'added';
      else if (!before) change = 'moved';
      else if (touched) change = 'modified';
      if (change) rows.push({ change, path: f.newPath, line: t.line, name: t.name, group: t.group });
    }
  }

  for (const r of removedTests(diffFiles)) {
    const base = files.find(({ f }) => f.oldPath === r.path)?.base.find((t) => t.line === r.line);
    rows.push({ change: 'removed', path: r.path, line: r.line, name: r.name, group: base?.group ?? '' });
  }
  return rows;
}

export const formatChangedTests = (rows) => rows.map((r) => `${r.change}\t${r.path}\t${r.line}\t${r.name}\t${r.group}\n`).join('');

export function readChangedTests(text) {
  return text.split('\n').filter(Boolean).map((line) => {
    const [change, path, n, name, group = ''] = line.split('\t');
    return { change, path, line: Number(n), name, group };
  });
}
