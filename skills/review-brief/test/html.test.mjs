import assert from 'node:assert/strict';
import { test } from 'node:test';
import { children, closest, find, findAll, hasClass, is, parse, text } from '../src/html.mjs';

test('parse: <li> and <p> close on their own; scripts keep the raw text', () => {
  const root = parse('<ul><li>one<li>two</ul><p>a<p>b<div class="x"><script type="text/plain">if (a < b) { "<div>" }</script></div>');
  const ul = find(root, is('ul'));
  assert.equal(children(ul, is('li')).length, 2);
  assert.equal(findAll(root, is('p')).length, 2);
  const script = find(root, is('script'));
  assert.equal(script.text, 'if (a < b) { "<div>" }');
  assert.ok(closest(script, (n) => hasClass(n, 'x')));
});

test('parse: entities in text and attributes; comments go away', () => {
  const root = parse('<!-- note --><a href="?a=1&amp;b=2" data-tip="“ok” &#8594;">x &lt; y</a>');
  const a = find(root, is('a'));
  assert.equal(a.attrs.href, '?a=1&b=2');
  assert.equal(a.attrs['data-tip'], '“ok” →');
  assert.equal(text(a), 'x < y');
});

test('parse: attributes without a value and empty elements', () => {
  const root = parse('<details class="decision" open><summary>s</summary><br><img src="x"></details>');
  const details = find(root, is('details', 'decision'));
  assert.ok('open' in details.attrs);
  assert.equal(children(details).length, 3);
});
