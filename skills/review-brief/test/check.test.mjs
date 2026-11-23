import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { check, embedAvatars } from '../src/check.mjs';
import { copyExample, editJson, editPage } from './helpers.mjs';

const errorsOf = (page) => check(page).errors;

function expectError(page, pattern) {
  const errors = errorsOf(page);
  assert.ok(errors.some((e) => pattern.test(e)), `expected an error ${pattern}; got:\n${errors.join('\n') || '(none)'}`);
}

test('the example page passes with no errors and within the budget', () => {
  const page = copyExample();
  const { errors, warnings, summary } = check(page);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.match(summary, /Shown lines: \+\d+ −\d+ = \d+ of 191 \(\d+%; limit 38\)/);
});

test('check writes the avatars of the shown authors only', () => {
  const page = copyExample();
  editPage(page, /<script type="application\/json" id="avatars">[\s\S]*?<\/script>/.exec(readFileSync(page, 'utf8'))[0], '<script type="application/json" id="avatars">{}</script>');
  check(page);
  const block = readFileSync(page, 'utf8').match(/<script type="application\/json" id="avatars">([\s\S]*?)<\/script>/)[1];
  assert.deepEqual(Object.keys(JSON.parse(block)).sort(), ['marina-costa', 'pedro-alves']);

  const { missing } = embedAvatars('<div class="comment" data-author="no-photo"></div>', {});
  assert.deepEqual(missing, ['no-photo']);
});

test('form: leftover slot, changed style, header and index', () => {
  expectError(editPage(copyExample(), '<h2>Flow</h2>', '<h2>Flow</h2>{{SECTIONS}}'), /The slot \{\{SECTIONS\}\} is still on the page/);
  expectError(editPage(copyExample(), '--accent: #2352c8;', '--accent: #ff0000;'), /style id="brief-base".*is not the same/);
  expectError(editPage(copyExample(), 'data-head-sha="1aaf327317787de90ed2eb7bcae8a4604d99ef11"', 'data-head-sha="0000000000000000000000000000000000000000"'), /PR head is now 1aaf327317/);
  expectError(editPage(copyExample(), '<li><a href="#contract">Contract</a></li>', ''), /The index .* must have one link per section/);
  expectError(editPage(copyExample(), '<a class="preview-link" href="https://shop-git-shipping-cache-acme.vercel.app" target="_blank" rel="noopener">Preview ↗</a>', ''), /preview link/);
  expectError(editPage(copyExample(), '>shop#471<', '>acme/shop#471<'), /repeats the repository owner/);
});

test('diffs: data-line, imports, one side, hidden blocks and comments that point', () => {
  expectError(editPage(copyExample(), 'data-line="19"', 'data-line="17"'), /line 17 of src\/shipping\/quote\.ts is not a line that the PR adds or changes \(maybe 19\)/);
  expectError(editPage(copyExample(), "export async function shippingLine(postalCode: string, items: Item[]) {\n  const quote = await quoteShipping(postalCode, items)\n  return {\n    label: quote", "import { x } from './x'\nexport async function shippingLine(postalCode: string, items: Item[]) {\n  const quote = await quoteShipping(postalCode, items)\n  return {\n    label: quote"), /imports and re-exports/);
  expectError(editPage(copyExample(), `<script type="text/plain" class="old">
export type Quote = {
  priceInCents: number
  deliveryDays: number
}
</script>`, ''), /has only the new side, but src\/shipping\/quote\.ts already existed/);
  expectError(editPage(copyExample(), "  //}\n\n  const weightInGrams = items.reduce(/* ... */)\n  const key", "  //}\n\n  const weightInGrams = items.reduce(/* ... */)\n  //! Moved from the old file, see above\n  const key"), /points to other code/);
  expectError(editPage(copyExample(), "  throw new Error(`Invalid postal code: \"${postalCode}\"`)\n  }\n  //}\n\n  const weightInGrams = items.reduce(/* ... */)\n  const key", "  throw new Error(`Invalid postal code!`)\n  }\n  //}\n\n  const weightInGrams = items.reduce(/* ... */)\n  const key"), /hidden block 1 is not the same on both sides/);
});

test('threads: an open human one is required; a line outside the code; a resolved one stays out', () => {
  const page = copyExample();
  const html = readFileSync(page, 'utf8');
  const thread = html.match(/ {6}<div class="thread"[\s\S]*?\n {6}<\/div>\n/)[0];
  expectError(editPage(page, thread, ''), /A person opened this thread/);
  expectError(editPage(copyExample(), 'data-side="new" data-line="15"', 'data-side="new" data-line="99"'), /is not a line of the shown new code/);

  const resolved = copyExample();
  editJson(path.join(path.dirname(resolved), 'threads.json'), (threads) => {
    threads[0].isResolved = true;
  });
  expectError(resolved, /shows a resolved thread/);
});

test('tests: a removed one is required, code name, cases outside the group', () => {
  expectError(editPage(copyExample(), '<li data-line="16" data-change="removed">calls the carrier for every quote</li>', ''), /The PR removes the test "calls the carrier for every quote"/);
  expectError(editPage(copyExample(), '>reuses the quote for the same postal code prefix and weight band<', '>reusesQuoteForSamePrefix<'), /has the code name/);
  expectError(editPage(copyExample(), '<li class="cases" title="Cases of one test">', '<li class="group">'), /same data-line 25/);
});

test('decisions, terms and charts', () => {
  expectError(editPage(copyExample(), '<details class="decision">', '<details class="decision" open>'), /is open/);
  expectError(editPage(copyExample(), '<p class="note">A later PR', '<p class="note"><dfn class="term" data-tip="Again.">weight band</dfn>. A later PR'), /explained more than once/);
  expectError(editPage(copyExample(), 'CARRIER [label="Carrier API"]\n  CHECKOUT', 'CARRIER [label="Carrier API" shape=box]\n  CHECKOUT'), /remove shape/);
  expectError(editPage(copyExample(), '"CACHE": "src/shipping/cache.ts#L6-L42"', '"REDIS": "src/shipping/cache.ts#L6-L42"'), /data-links has "REDIS"/);
});

test('shown code: made up or on the wrong side is an error; a line break and a rewritten comment pass', () => {
  expectError(editPage(copyExample(), '  const cached = shippingCache.read(key)\n', '  const cached = shippingCache.fetch(key)\n'), /Diff 3 .* \(new\): 1 line is not in src\/shipping\/quote\.ts in the head: “const cached = shippingCache\.fetch\(key\)”/);
  expectError(editPage(copyExample(), "    label: 'Shipping',\n", "    label: quote.source === 'cache' ? 'Shipping (estimate)' : 'Shipping',\n"), /Diff 1 .* \(old\): 1 line is not in src\/checkout\/summary\.ts in the merge base/);

  const page = copyExample();
  editPage(page, '  const response = await quoteFromCarrier({ postalCode: digits, weightInGrams })\n  const quote = {', '  const response = await quoteFromCarrier({\n    postalCode: digits,\n    weightInGrams,\n  })\n  const quote = {');
  editPage(page, '  // "cache" when the price came from a quote made less than 10 minutes ago.', '  // "cache": the price came from a quote less than 10 minutes old.');
  const errors = errorsOf(page).filter((e) => /is not in|are not in/.test(e));
  assert.deepEqual(errors, []);

  // A rendered prompt is not in the file: data-rendered takes the diff out of the check.
  const rendered = editPage(copyExample(), "    label: 'Shipping',\n", "    text that the model reads\n");
  expectError(rendered, /\(old\): 1 line is not in/);
  editPage(rendered, '<figure class="diff" data-path="src/checkout/summary.ts"', '<figure class="diff" data-rendered data-path="src/checkout/summary.ts"');
  assert.deepEqual(errorsOf(rendered).filter((e) => /is not in/.test(e)), []);
});

test('threads: on the wrong line, check suggests the right one', () => {
  expectError(editPage(copyExample(), 'data-side="new" data-line="15"', 'data-side="new" data-line="14"'), /is about line 47 of src\/shipping\/cache\.ts, but data-line="14" shows “const band = Math\.ceil\(weightInGrams \/ 500\)” \(maybe data-line="15"\)/);
  expectError(editPage(copyExample(), 'data-side="new" data-line="15"', 'data-side="old" data-line="15"'), /data-side="old", but the diff does not have that side/);

  // The same thread in a diff of another file, with both sides: the side and the file do not match.
  const thread = '<div class="thread" data-side="old" data-line="4"><div class="comment" data-author="marina-costa" data-href="https://github.com/acme/shop/pull/482#discussion_r1873001"><script type="text/markdown">\nHi\n</script></div></div>\n';
  const page = editPage(copyExample(), "    label: quote.source === 'cache' ? 'Shipping (estimate)' : 'Shipping',\n    // ...\n  }\n}\n</script>\n", `    label: quote.source === 'cache' ? 'Shipping (estimate)' : 'Shipping',\n    // ...\n  }\n}\n</script>\n${thread}`);
  expectError(page, /is on the new side on GitHub, but it is on data-side="old"/);
  expectError(editPage(page, 'data-side="old" data-line="4"><div class="comment" data-author="marina-costa"', 'data-side="new" data-line="4"><div class="comment" data-author="marina-costa"'), /is about src\/shipping\/cache\.ts, but it is in a diff of src\/checkout\/summary\.ts/);
});

test('tests: a data-line that does not declare a test is an error; a test the PR does not change is a warning', () => {
  expectError(editPage(copyExample(), '<li data-line="22" data-change="added">', '<li data-line="23" data-change="added">'), /does not declare a test on that line in the head \(the nearest: "reuses the quote for the same postal code prefix and weight band", line 22\)/);
  expectError(editPage(copyExample(), '<li data-line="16" data-change="removed">', '<li data-line="17" data-change="removed">'), /does not declare a test on that line in the merge base/);

  const page = editPage(copyExample(), '<li data-line="31" data-change="added">quotes the carrier again for another weight band</li>', '<li data-line="31" data-change="added">quotes the carrier again for another weight band</li>\n              <li data-line="12" data-change="modified">rejects a postal code with fewer than 8 digits</li>');
  const { warnings } = check(page);
  assert.ok(warnings.some((w) => /The PR does not change the test "rejects a postal code with fewer than 8 digits"/.test(w)), warnings.join('\n'));

  const renamed = editPage(copyExample(), '>quotes the carrier again for another weight band<', '>shipping is priced in dollars<');
  assert.ok(check(renamed).warnings.some((w) => /is called "quotes the carrier again for another weight band" in the code/.test(w)));
});

test('without the versions/ folder, check warns that it did not check the code', () => {
  const page = copyExample();
  rmSync(path.join(path.dirname(page), 'versions'), { recursive: true });
  const { errors, warnings } = check(page);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => /has no versions\//.test(w)));
});

test('budget: over 20% of the PR lines is an error', () => {
  const page = copyExample();
  editJson(path.join(path.dirname(page), 'facts.json'), (facts) => {
    facts.additions = 60;
  });
  expectError(page, /The page shows \d+ lines; the limit is 13/);
});

test('AI threads: an open one may show; one left out is listed in the summary, with no warning', () => {
  const { errors, warnings, summary } = check(copyExample());
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.match(summary, /Open AI threads left off the page: 1\. Show the ones that point out a behavior problem that is still open:\n {2}src\/shipping\/cache\.ts:34 by coderabbitai\[bot\]: .*discussion_r1872990/);

  // The same thread on the page: not an error, and it leaves the list.
  const bot = '<div class="thread" data-side="new" data-line="4"><div class="comment" data-author="coderabbitai[bot]" data-href="https://github.com/acme/shop/pull/482#discussion_r1872990"><script type="text/markdown">\nIt can be a method.\n</script></div></div>\n';
  const page = editPage(copyExample(), '      <div class="thread" data-side="new" data-line="15">', `      ${bot}      <div class="thread" data-side="new" data-line="15">`);
  const result = check(page);
  assert.ok(!result.errors.some((e) => /AI|coderabbit/.test(e)), result.errors.join('\n'));
  assert.doesNotMatch(result.summary, /Open AI threads/);
});

test('page comments that point elsewhere: the English and the Portuguese words both count', () => {
  for (const note of ['//! Same as further down', '//! This came from the old helper', '//! Veja abaixo']) {
    expectError(editPage(copyExample(), "  //}\n\n  const weightInGrams = items.reduce(/* ... */)\n  const key", `  //}\n\n  const weightInGrams = items.reduce(/* ... */)\n  ${note}\n  const key`), /points to other code/);
  }
});
