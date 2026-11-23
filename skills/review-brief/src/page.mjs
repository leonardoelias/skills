// The page template and the part of code that the page and check share.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATE_PATH = path.join(SKILL_ROOT, 'template.html');

export const SLOTS = ['TITLE', 'LANG', 'REPO_URL', 'REPO_NAME', 'NUMBER', 'HEAD_SHA', 'ADDITIONS', 'DELETIONS', 'INDEX', 'PREVIEW_URL', 'HEADER', 'SECTIONS'];
export const STYLE_BLOCK = /<style id="brief-base">[\s\S]*?<\/style>/;
export const APP_BLOCK = /<script type="module" id="brief-app">[\s\S]*?<\/script>/;
export const AVATARS_BLOCK = /<script type="application\/json" id="avatars">[\s\S]*?<\/script>/;

export const templateText = () => readFileSync(TEMPLATE_PATH, 'utf8');

/** The functions between `// <shared>` and `// </shared>` in the template, to count the way the page counts. */
export function sharedCode(source = templateText()) {
  const m = source.match(/\/\/ <shared>[^\n]*\n([\s\S]*?)\/\/ <\/shared>/);
  if (!m) throw new Error('the template has no <shared> part');
  return new Function(`${m[1]}\nreturn { splitLines, readSide, diffRows, countShown, HIDDEN_OPEN, HIDDEN_CLOSE, HIDDEN_KEY };`)();
}

/** The Artifact host wraps the page in a document. This wrapper does the same, to open it in the browser. */
export function wrapPage(html) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
</head>
<body>
${html}
</body>
</html>
`;
}
