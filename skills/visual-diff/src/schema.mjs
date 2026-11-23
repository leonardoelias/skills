// JSON Schema for visual-diff.config.json. It is the single source: `validateConfig` uses this object and
// `npm run schema` writes visual-diff.schema.json from it (a test checks that they match).
import { suggest } from './util.mjs';

const str = { type: 'string' };
const bool = { type: 'boolean' };
const num = { type: 'number' };
const strList = { type: 'array', items: str };
const stringMap = { type: 'object', additionalProperties: str };
const envRef = { type: 'string', pattern: '^\\$\\w+$', description: 'Reference to an environment variable ("$NAME"), never the value.' };

const step = {
  type: 'object',
  description: 'An interaction step: hover, click, focus, type, press, scroll or wait.',
  properties: {
    hover: str,
    click: str,
    focus: str,
    type: { type: 'object', properties: { selector: str, text: str }, additionalProperties: false },
    press: str,
    scroll: num,
    wait: num,
  },
  additionalProperties: false,
};

const viewport = {
  oneOf: [
    { type: 'string', description: 'desktop, tablet, mobile or name:WxH@scale' },
    {
      type: 'object',
      properties: { name: str, width: num, height: num, deviceScaleFactor: num, isMobile: bool, hasTouch: bool },
      required: ['name'],
      additionalProperties: false,
    },
  ],
};

const variants = {
  type: 'object',
  description: 'Captures only the head with ?param=value for each value and builds a comparison strip.',
  properties: {
    param: str,
    values: { oneOf: [str, { type: 'array', items: { type: ['string', 'number'] } }], description: '"1..4" or a list' },
    viewports: strList,
    themes: strList,
  },
  required: ['param', 'values'],
  additionalProperties: false,
};

const route = {
  oneOf: [
    str,
    {
      type: 'object',
      properties: {
        path: str,
        files: strList,
        waitFor: { type: 'string', description: 'CSS selector or "js:<expression>" that must be true before the capture.' },
        variants,
        motion: {
          type: 'object',
          properties: { steps: { type: 'array', items: step }, durationMs: num },
          additionalProperties: false,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  ],
};

const theme = {
  oneOf: [
    str,
    {
      type: 'object',
      properties: {
        name: str,
        colorScheme: { enum: ['light', 'dark', 'no-preference'] },
        query: stringMap,
        localStorage: stringMap,
        cookie: stringMap,
        htmlClass: str,
        htmlAttr: stringMap,
      },
      required: ['name'],
      additionalProperties: false,
    },
  ],
};

export const CONFIG_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'visual-diff.config.json',
  type: 'object',
  properties: {
    $schema: str,
    appDir: { type: 'string', description: "The app's subfolder in a monorepo." },
    startCommand: { type: 'string', description: 'Server command; {port} becomes a free port. "static:<folder>" uses the built-in static server.' },
    baseUrl: str,
    installCommand: { type: ['string', 'null'] },
    deps: { enum: ['auto', 'link', 'install'], description: "auto: links the main checkout's node_modules and installs when the lockfile differs or the app is Next." },
    startTimeoutMs: num,
    env: stringMap,
    routes: { type: 'array', items: route },
    globalFiles: strList,
    viewports: { oneOf: [str, { type: 'array', items: viewport }] },
    themes: { type: 'array', items: theme },
    capture: {
      type: 'object',
      properties: {
        mask: strList,
        hide: strList,
        maskEmbeds: strList,
        fullPage: bool,
        settleMs: num,
        maxRetakes: num,
        fixedTime: { type: ['string', 'null'], description: '"run-start", an ISO date or null' },
        locale: str,
        timezone: str,
        maxHeight: num,
        maxScrollSteps: num,
        networkIdleMs: num,
        waitFor: { type: ['string', 'null'] },
        blockHosts: strList,
        blockDefaultHosts: bool,
        concurrency: num,
      },
      additionalProperties: false,
    },
    diff: {
      type: 'object',
      properties: {
        threshold: num,
        focusRegions: num,
        rowTolerance: num,
        composeFormat: { enum: ['jpeg', 'png'] },
        maxFocusArea: num,
      },
      additionalProperties: false,
    },
    detect: {
      type: 'object',
      properties: {
        uiExtensions: strList,
        ignore: strList,
        maxRoutes: num,
        maxDepth: num,
        aliases: stringMap,
      },
      additionalProperties: false,
    },
    auth: {
      type: 'object',
      properties: {
        headers: { type: 'object', additionalProperties: envRef },
        cookies: {
          type: 'array',
          items: {
            type: 'object',
            properties: { name: str, value: envRef, domain: str, path: str },
            required: ['name', 'value'],
            additionalProperties: false,
          },
        },
        storageState: { type: ['string', 'null'] },
        origins: { type: 'array', items: { enum: ['previews', 'local'] } },
      },
      additionalProperties: false,
    },
    audits: {
      type: 'object',
      properties: {
        a11y: bool,
        tokens: { oneOf: [bool, { type: 'object', properties: { include: strList, colorTolerance: num, allow: strList }, additionalProperties: false }] },
        motion: bool,
      },
      additionalProperties: false,
    },
    motion: {
      type: 'object',
      properties: { durationMs: num, fps: num, maxWidth: num, steps: { type: 'array', items: step } },
      additionalProperties: false,
    },
    cache: {
      type: 'object',
      properties: { base: bool, worktrees: bool },
      additionalProperties: false,
    },
    publish: {
      type: 'object',
      properties: {
        branch: str,
        marker: str,
        remote: { type: ['string', 'null'] },
        repo: { type: ['string', 'null'], description: "owner/repo (or host/owner/repo) where the PR lives, if it isn't the remote's." },
        host: { type: ['string', 'null'] },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

/**
 * Validates a value against the schema above (the subset it uses). Returns a list of readable errors,
 * with a name suggestion when the key looks like a typo.
 */
export function validateConfig(value, schema = CONFIG_SCHEMA, where = '') {
  const errors = [];
  check(value, schema, where || '(root)', errors);
  return errors;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function matchesType(v, t) {
  const actual = typeOf(v);
  const types = Array.isArray(t) ? t : [t];
  return types.some((x) => x === actual || (x === 'integer' && Number.isInteger(v)));
}

function check(v, s, where, errors) {
  if (s.oneOf) {
    const attempts = s.oneOf.map((alt) => {
      const e = [];
      check(v, alt, where, e);
      return e;
    });
    if (attempts.some((e) => e.length === 0)) return;
    // Shows the errors of the alternative whose type matches the value, if any.
    const byType = s.oneOf.findIndex((alt) => alt.type && matchesType(v, alt.type));
    errors.push(...(byType >= 0 ? attempts[byType] : [`${where}: invalid value`]));
    return;
  }
  if (s.enum) {
    if (!s.enum.includes(v)) errors.push(`${where}: use ${s.enum.map((x) => JSON.stringify(x)).join(', ')} (got ${JSON.stringify(v)})`);
    return;
  }
  if (s.type && !matchesType(v, s.type)) {
    errors.push(`${where}: expected ${[].concat(s.type).join(' or ')}, got ${typeOf(v)}`);
    return;
  }
  if (s.pattern && typeof v === 'string' && !new RegExp(s.pattern).test(v)) {
    errors.push(`${where}: ${s.description ?? `does not match ${s.pattern}`}`);
  }
  if (typeOf(v) === 'object' && (s.properties || s.additionalProperties !== undefined)) {
    for (const [k, val] of Object.entries(v)) {
      const sub = s.properties?.[k];
      if (sub) check(val, sub, `${where === '(root)' ? '' : where + '.'}${k}`, errors);
      else if (s.additionalProperties === false) {
        const hint = suggest(k, Object.keys(s.properties ?? {}));
        errors.push(`${where === '(root)' ? '' : where + '.'}${k}: unknown key${hint ? ` (did you mean "${hint}"?)` : ''}`);
      } else if (typeof s.additionalProperties === 'object') check(val, s.additionalProperties, `${where}.${k}`, errors);
    }
    for (const req of s.required ?? []) if (!(req in v)) errors.push(`${where}: missing "${req}"`);
  }
  if (typeOf(v) === 'array' && s.items) v.forEach((item, i) => check(item, s.items, `${where}[${i}]`, errors));
}
