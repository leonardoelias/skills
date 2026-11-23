import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commentStyle, findLine, GAP, indexText, lineTokens } from '../src/verify.mjs';

const FILE = `export async function quote(zip: string, items: Item[]): Promise<Quote> {
  // Validate the postal code before anything else.
  const row: Record<string, number> = {}
  const response = await carrier.quote({
    zip,
    weight: items.reduce((total, item) => total + item.weight, 0),
  })
  /**
   * A block comment.
   */
  return { price: Math.round(response.price * 100), source: 'carrier' } // end
}
`;
const index = indexText(FILE, 'c');
const find = (line, options) => findLine(index, lineTokens(line, 'c', { page: true }), options);

test('lineTokens removes comments and marks /* ... */ as a left-out part', () => {
  assert.deepEqual(lineTokens('foo(/* ... */) // note', 'c', { page: true }), ['foo', '(', GAP, ')']);
  assert.deepEqual(lineTokens(" * JSDoc text", 'c'), []);
  assert.deepEqual(lineTokens("url = 'http://x' # comment", 'hash'), ['url', '=', "'http://x'"]);
  assert.deepEqual(lineTokens('select 1 -- note', 'sql'), ['select', '1']);
  assert.equal(commentStyle('tsx'), 'c');
  assert.equal(commentStyle('markdown'), 'none');
});

test('findLine finds the line even with a cut type, a left-out part or a joined call', () => {
  assert.equal(find('const row = {}'), 3);
  assert.equal(find('const response = await carrier.quote({ zip, weight: items.reduce(/* ... */) })'), 4);
  assert.equal(find("return { price: Math.round(response.price * 100), source: 'carrier' }"), 11);
  assert.equal(find('export async function quote(/* ... */): Promise<Quote> {'), 1);
});

test('findLine: a rewritten comment and punctuation have nothing to check', () => {
  assert.equal(find('// The postal code is checked first, so the error comes out early.'), 0);
  assert.equal(find('  })'), 0);
  assert.equal(find('//! A comment only on the page'), 0);
});

test('findLine refuses names, values and calls that are not in the file', () => {
  assert.equal(find('const response = await carrier.fetch({ zip })'), -1);
  assert.equal(find("return { price: response.price, source: 'cache' }"), -1);
  assert.equal(find('const key = shippingKey(zip, weight)'), -1);
});

test('findLine with from/to: the line must start in the requested part', () => {
  assert.equal(find('const row = {}', { from: 3, to: 3 }), 3);
  assert.equal(find('const row = {}', { from: 5, to: 9 }), -1);
});
