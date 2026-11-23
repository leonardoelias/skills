# Variants, accessibility, motion and design tokens

All of them are optional and off by default. They run in the same `run` and show up in
`report.json`, in `summary.auto.md` and in the comment.

## Variants (`?param=1..n`)

To compare alternative versions of the same page (heroes, A/B test layouts) controlled by a query
string. Only the head is captured; the result is a strip with one column per value and, in the
comment, a table with checkboxes for the reviewer to mark the preferred one.

```json
{ "routes": [{ "path": "/", "variants": { "param": "hero", "values": "1..4", "viewports": ["desktop"], "themes": ["light"] } }] }
```

Or on the command line: `run --variants "/:hero=1..4;/pricing:plan=basic,pro"`. At most 12 values.
Without `viewports`/`themes`, it uses the first of each.

## Accessibility (axe-core)

```json
{ "audits": { "a11y": true } }
```

Runs axe (WCAG 2.0, 2.1 and 2.2 rules, levels A and AA) on every capture on both sides and compares
by rule + selector. Each changed item gets `a11y: { added, resolved, unchanged }`; the comment shows
what is new and what was resolved. New pages list all their violations as new. Tab focus order
isn't compared yet.

## Motion (before | after GIF)

```json
{
  "audits": { "motion": true },
  "motion": { "durationMs": 2500, "fps": 10, "maxWidth": 360 },
  "routes": [{ "path": "/", "motion": { "steps": [{ "hover": ".btn" }, { "wait": 400 }, { "click": "#menu" }] } }]
}
```

For changed routes (all of them with `audits.motion`, or only those with `routes[].motion`), records
the screen with animations on in the first viewport and theme, on both sides, while running the
steps, and builds a side-by-side GIF. `changed` says whether the two sides differ frame by frame.
Steps: `hover`, `click`, `focus`, `type: { selector, text }`, `press: "Tab"`, `scroll` (px or
selector), `wait` (ms). Missing selectors are skipped and listed in the warnings.

## Design tokens

```json
{ "audits": { "tokens": { "include": ["--color-*", "--space-*"], "colorTolerance": 0.02, "allow": ["rgb(255, 255, 255)"] } } }
```

(`"tokens": true` uses the defaults.) Reads the tokens from the `:root` CSS custom properties (colors
and lengths), collects the computed styles of the elements inside the changed regions on the head
(text, background, border, outline, fill/stroke colors; margin, padding and gap) and reports values
that don't match any token: colors by OKLab distance to the nearest token, spacing by equality.
Only **new** findings count, ones that didn't exist anywhere on the same page on the base.

Limits: tokens only from CSS custom properties (doesn't read JSON or StyleX); in Tailwind v4 spacing
is a single multiplied `--spacing`, so only that value counts as a spacing token.
