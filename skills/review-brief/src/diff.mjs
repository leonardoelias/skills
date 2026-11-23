// Reads the unified diff of the PR: the added and removed lines of each file, and the tests that the PR removes.

/** Returns one file per `diff --git` block: { oldPath, newPath, added: Map(line → text), removed: Map(line → text) }. */
export function parseDiff(text) {
  const files = [];
  let file = null;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;

  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      file = { oldPath: m?.[1] ?? null, newPath: m?.[2] ?? null, added: new Map(), removed: new Map() };
      files.push(file);
      oldLeft = 0;
      newLeft = 0;
      continue;
    }
    if (!file) continue;

    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('+')) {
        file.added.set(newLine++, line.slice(1));
        newLeft--;
      } else if (line.startsWith('-')) {
        file.removed.set(oldLine++, line.slice(1));
        oldLeft--;
      } else if (line.startsWith(' ') || line === '') {
        oldLine++;
        newLine++;
        oldLeft--;
        newLeft--;
      }
      continue;
    }

    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLine = Number(hunk[3]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      continue;
    }
    if (line.startsWith('--- ')) file.oldPath = line === '--- /dev/null' ? null : line.replace(/^--- (a\/)?/, '');
    else if (line.startsWith('+++ ')) file.newPath = line === '+++ /dev/null' ? null : line.replace(/^\+\+\+ (b\/)?/, '');
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.binary = true;
    else if (line.startsWith('new file mode')) file.isNew = true;
    else if (line.startsWith('deleted file mode')) file.isDeleted = true;
    else if (line.startsWith('rename from ')) file.oldPath = line.slice('rename from '.length);
    else if (line.startsWith('rename to ')) file.newPath = line.slice('rename to '.length);
  }

  for (const f of files) {
    if (f.isNew) f.oldPath = null;
    if (f.isDeleted) f.newPath = null;
  }
  return files;
}

export const TEST_FILE = new RegExp([
  String.raw`(^|/)__tests__/`,
  String.raw`[._-](test|spec)\.[cm]?[jt]sx?$`,
  String.raw`_test\.go$`,
  String.raw`(^|/)test_[^/]*\.py$`,
  String.raw`_test\.py$`,
  String.raw`Tests?\.swift$`,
  String.raw`_(spec|test)\.rb$`,
  String.raw`Test\.(kt|java)$`,
  String.raw`_test\.exs?$`,
].join('|'));

const TEST_NAMES = [
  // Jest, Vitest, Mocha, node:test, Playwright: it("…"), test.only('…'). The name of it.each(…)("…") is not on the
  // line of the it, so it is left out.
  /(?:^|[^\w.$])(?:it|test|specify)(?:\.(?:only|skip|todo|concurrent|failing|fixme))*\(\s*(["'`])(?<name>(?:\\.|(?!\1).)*)\1/,
  // Go
  /^\s*func\s+(?<name>Test\w*)\s*\(/,
  // pytest
  /^\s*(?:async\s+)?def\s+(?<name>test\w*)\s*\(/,
  // XCTest
  /^\s*(?:(?:override|public|private|internal|final|@MainActor|@objc)\s+)*func\s+(?<name>test\w*)\s*\(/,
  // Swift Testing: @Test("name") or @Test func name()
  /@Test\s*\(\s*"(?<name>(?:\\.|[^"])*)"/,
  /@Test(?:\s*\([^)]*\))?\s+(?:(?:@MainActor|static)\s+)*func\s+(?<name>\w+)\s*\(/,
  // RSpec
  /^\s*it\s+(["'])(?<name>(?:\\.|(?!\1).)*)\1/,
  // JUnit with Kotlin: fun `name with spaces`()
  /^\s*fun\s+`(?<name>[^`]+)`\s*\(/,
];

export function testName(line) {
  for (const pattern of TEST_NAMES) {
    const name = line.match(pattern)?.groups?.name;
    if (name) return name;
  }
  return null;
}

/**
 * Tests that the PR removes: the name is on a removed line of a test file and on no added line of a test file. A test
 * that only moves (also to another file) has its name on both sides.
 */
export function removedTests(files) {
  const added = new Set();
  const removed = [];
  for (const file of files) {
    const path = file.oldPath ?? file.newPath;
    if (!path || !(TEST_FILE.test(file.oldPath ?? '') || TEST_FILE.test(file.newPath ?? ''))) continue;
    for (const text of file.added.values()) {
      const name = testName(text);
      if (name) added.add(name);
    }
    if (!file.oldPath) continue;
    for (const [line, text] of file.removed) {
      const name = testName(text);
      if (name) removed.push({ path: file.oldPath, line, name });
    }
  }

  const seen = new Set();
  return removed.filter((test) => {
    const key = `${test.path}\t${test.name}`;
    if (added.has(test.name) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const formatRemovedTests = (tests) => tests.map((t) => `${t.path}\t${t.line}\t${t.name}\n`).join('');

export function readRemovedTests(text) {
  return text.split('\n').filter(Boolean).map((line) => {
    const [path, n, ...name] = line.split('\t');
    return { path, line: Number(n), name: name.join('\t') };
  });
}
