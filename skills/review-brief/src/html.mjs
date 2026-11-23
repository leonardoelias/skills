// A small HTML parser, only for check: the page is written from the template, so a tree of elements with
// attributes, text and the raw content of <script>, <style> and <title> is enough.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'title', 'textarea']);
// The most common implicit closings: an <li> opens after another <li>, a <p> closes before a block.
const CLOSES = {
  li: ['li'],
  p: ['p'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  tr: ['tr', 'td', 'th'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
};
const BLOCKS = new Set(['div', 'ul', 'ol', 'table', 'section', 'figure', 'aside', 'details', 'header', 'nav', 'pre', 'h1', 'h2', 'h3', 'h4', 'blockquote']);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rarr: '→', larr: '←', hellip: '…', mdash: '—', ndash: '–', middot: '·' };

export function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

function parseAttributes(source) {
  const attrs = {};
  for (const m of source.matchAll(/([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    attrs[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/** Returns the root. Each node: { tag, attrs, children, parent, text?, line }. Text nodes have the tag '#text'. */
export function parse(html) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null, line: 1 };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;
  let line = 1;
  const advance = (to) => {
    for (let k = i; k < to; k++) if (html.charCodeAt(k) === 10) line++;
    i = to;
  };

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      top().children.push({ tag: '#text', text: decode(html.slice(i)), parent: top(), line });
      advance(html.length);
      break;
    }
    if (lt > i) {
      top().children.push({ tag: '#text', text: decode(html.slice(i, lt)), parent: top(), line });
      advance(lt);
    }

    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      advance(end === -1 ? html.length : end + 3);
      continue;
    }
    if (html.startsWith('<!', i) || html.startsWith('<?', i)) {
      const end = html.indexOf('>', i);
      advance(end === -1 ? html.length : end + 1);
      continue;
    }

    const close = html.slice(i).match(/^<\/([a-zA-Z][\w-]*)\s*>/);
    if (close) {
      const tag = close[1].toLowerCase();
      const at = stack.map((n) => n.tag).lastIndexOf(tag);
      if (at > 0) stack.length = at;
      advance(i + close[0].length);
      continue;
    }

    const open = html.slice(i).match(/^<([a-zA-Z][\w-]*)((?:\s+(?:[^\s"'<>\/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/);
    if (!open) {
      top().children.push({ tag: '#text', text: '<', parent: top(), line });
      advance(i + 1);
      continue;
    }

    const tag = open[1].toLowerCase();
    const closes = CLOSES[tag] ?? (BLOCKS.has(tag) ? ['p'] : []);
    if (closes.length > 0) {
      // Closes an open <li>/<p>/<td>, but only inside the same list or table parent.
      for (let k = stack.length - 1; k > 0; k--) {
        const t = stack[k].tag;
        if (closes.includes(t)) {
          stack.length = k;
          break;
        }
        if (['ul', 'ol', 'table', 'tbody', 'thead', 'tr', 'div', 'section', 'figure', 'details'].includes(t)) break;
      }
    }

    const node = { tag, attrs: parseAttributes(open[2]), children: [], parent: top(), line };
    top().children.push(node);
    advance(i + open[0].length);

    if (RAW.has(tag)) {
      const end = html.toLowerCase().indexOf(`</${tag}`, i);
      const stop = end === -1 ? html.length : end;
      node.text = tag === 'title' ? decode(html.slice(i, stop)) : html.slice(i, stop);
      advance(stop);
      const closeTag = html.slice(i).match(new RegExp(`^</${tag}\\s*>`, 'i'));
      if (closeTag) advance(i + closeTag[0].length);
      continue;
    }
    if (!VOID.has(tag) && !open[3]) stack.push(node);
  }
  return root;
}

export const classes = (node) => (node.attrs?.class ?? '').split(/\s+/).filter(Boolean);
export const hasClass = (node, name) => classes(node).includes(name);

export function* walk(node) {
  for (const child of node.children ?? []) {
    yield child;
    yield* walk(child);
  }
}

export const findAll = (node, test) => [...walk(node)].filter((n) => n.tag !== '#text' && test(n));
export const find = (node, test) => findAll(node, test)[0] ?? null;
export const children = (node, test = () => true) => (node.children ?? []).filter((n) => n.tag !== '#text' && test(n));

export function closest(node, test) {
  for (let n = node.parent; n; n = n.parent) if (n.tag !== '#root' && test(n)) return n;
  return null;
}

export function text(node) {
  if (node.tag === '#text') return node.text;
  if (['script', 'style'].includes(node.tag)) return '';
  if (node.tag === 'title') return node.text ?? '';
  return (node.children ?? []).map(text).join('');
}

export const is = (tag, className) => (n) => n.tag === tag && (!className || hasClass(n, className));
