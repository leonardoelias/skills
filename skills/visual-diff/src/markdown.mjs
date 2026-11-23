export const markerFor = (id = 'default') => `<!-- visual-diff:sticky id=${id} -->`;

export const COMMENT_LIMIT = 65_536; // GitHub's limit for a comment body

const groupBy = (arr, fn) => arr.reduce((m, x) => m.set(fn(x), [...(m.get(fn(x)) ?? []), x]), new Map());
const signed = (n) => (n > 0 ? `+${n}` : String(n));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const where = (i) => `${i.viewport}/${i.theme}`;

/** Sentence about shifts: "the content below y≈420px moved down 24px". */
export function shiftPhrase(i) {
  const parts = [];
  for (const s of (i.shifts ?? []).slice(0, 3)) parts.push(`the content below y≈${s.fromYCss}px moved ${s.byCss > 0 ? 'down' : 'up'} ${Math.abs(s.byCss)}px`);
  if ((i.shifts ?? []).length > 3) parts.push(`and ${i.shifts.length - 3} more shift(s)`);
  if (!parts.length && i.heightDeltaCss) parts.push(`the page height changed ${signed(i.heightDeltaCss)}px`);
  return parts.join('; ');
}

const describeItem = (i) => {
  if (i.status === 'added') return `${where(i)}: new page`;
  if (i.status === 'removed') return `${where(i)}: removed page`;
  if (i.kind === 'layout-shift') return `${where(i)}: spacing only (${shiftPhrase(i) || 'layout'})`;
  return `${where(i)} ${i.changedPercent}%`;
};

/** Automatic summary, based only on numbers (used in CI and as a starting point for the agent). */
export function autoSummary(report) {
  const lines = ['**What changed**'];
  const changed = report.items.filter((i) => i.changed);
  if (changed.length === 0) lines.push('- No visual difference in the captures.');
  for (const [route, items] of groupBy(changed, (i) => i.route)) {
    const content = items.find((i) => i.kind === 'content' && i.shifts?.length);
    const extra = content ? `; also, ${shiftPhrase(content)} (${where(content)}) and that doesn't count as a change` : '';
    lines.push(`- \`${route}\`: ${items.map(describeItem).join(', ')}${extra}.`);
  }
  for (const v of report.variants ?? []) lines.push(`- \`${v.route}\`: ${v.values.length} variant(s) of \`${v.param}\` captured (${v.viewport}/${v.theme}).`);

  const look = [];
  for (const i of report.items) {
    if (!i.changed || i.status !== 'changed') continue;
    const others = report.items.filter((o) => o.route === i.route && o.theme === i.theme && o.viewport !== i.viewport);
    if (others.length && others.every((o) => !o.changed)) look.push(`\`${i.route}\` only changed in ${i.viewport} (${i.theme}).`);
  }
  for (const i of report.items) {
    if (i.a11y?.added?.length) look.push(`\`${i.route}\` (${where(i)}): ${i.a11y.added.length} new accessibility problem(s) (${[...new Set(i.a11y.added.map((v) => v.id))].slice(0, 4).join(', ')}).`);
    if (i.tokens?.length) look.push(`\`${i.route}\` (${where(i)}): ${i.tokens.length} value(s) outside the design tokens in the changed regions.`);
  }
  for (const m of report.motion ?? []) if (m.changed) look.push(`\`${m.route}\`: the motion changed (see the GIF).`);
  for (const w of report.warnings) look.push(w);
  for (const f of report.failed) look.push(`Failed to capture \`${f.key}\` (base: ${f.base}; head: ${f.head}).`);
  if (look.length) lines.push('', '**Worth a look**', ...look.map((l) => `- ${l}`));

  const nc = [
    ...report.notCaptured.map((n) => `\`${n.route}\` (${n.reason})`),
    ...report.unmatchedFiles.map((f) => `\`${f}\` (no route)`),
    ...(report.unmatchedMaybe ?? []).map((f) => `\`${f}\` (maybe UI, no route)`),
  ];
  if (nc.length) lines.push('', `**Not verified:** ${nc.join(', ')}.`);
  return lines.join('\n') + '\n';
}

/**
 * Comment body. link(relPath) returns the URL (or local path) of each image; null = no images.
 * tier: 0 full; 1 no crops; 2 no images (links only); 3 truncated.
 */
export function renderComment(report, summary, { link, markerId = 'default', stale = false, tier = 0 } = {}) {
  const s = report.stats;
  const out = [markerFor(markerId), '## 🖼️ visual-diff', ''];
  const sides = report.sides;
  out.push(`**Base:** \`${sides.base.label}\` → **Head:** \`${sides.head.label}\``);
  const counts = [`**${s.changed} with differences**`, `${s.unchanged} without differences`];
  if (s.added) counts.push(`${s.added} new page(s)`);
  if (s.removed) counts.push(`${s.removed} removed`);
  if (s.failed) counts.push(`${s.failed} failed`);
  out.push(`${s.captures} capture(s): ${counts.join(', ')}.`);
  if (stale) out.push('', '> ⚠️ This report is from a run before the PR\'s latest commit.');
  out.push('', summary.trim(), '');

  const img = (p, alt) => (tier >= 2 ? `[${esc(alt)}](${link(p)})` : `<img src="${link(p)}" alt="${esc(alt)}">`);
  const changed = report.items.filter((i) => i.changed && i.status === 'changed').sort((a, b) => b.changedPercent - a.changedPercent || (b.shifts?.length ?? 0) - (a.shifts?.length ?? 0));
  const added = report.items.filter((i) => i.status === 'added');
  const removed = report.items.filter((i) => i.status === 'removed');

  if (link && tier < 3) {
    for (const i of changed) {
      const head = i.kind === 'layout-shift' ? `spacing only — ${esc(shiftPhrase(i))}` : `${i.changedPercent}% of pixels`;
      out.push(`<details${i === changed[0] ? ' open' : ''}><summary><b>${esc(i.route)}</b> · ${i.viewport} · ${i.theme} — ${head}</summary>`, '');
      if (i.regionsTotal > (i.focus?.length ?? 0)) out.push(`<sub>${i.focus?.length ?? 0} of ${i.regionsTotal} changed regions highlighted${i.regionsSkipped ? ` (${i.regionsSkipped} too large to crop; see the full page)` : ''}.</sub>`, '');
      if (tier === 0) for (const f of i.focus ?? []) out.push(img(f, `Changed region in ${i.route} (${where(i)}): before, after and diff`), '');
      if (i.truncated) out.push(`<sub>The page exceeds capture.maxHeight; the capture was cut.</sub>`, '');
      out.push(`<details${tier > 0 || !(i.focus?.length) ? ' open' : ''}><summary>Full page</summary>`, '', img(i.compare, `Full page ${i.route} (${where(i)}): before, after and diff`), '', '</details>', '');
      if (i.a11y && (i.a11y.added.length || i.a11y.resolved.length)) out.push(a11yBlock(i.a11y), '');
      if (i.tokens?.length) out.push(tokensBlock(i.tokens), '');
      out.push('</details>', '');
    }
    if (added.length) {
      out.push('### New pages', '');
      for (const i of added) out.push(`<details><summary><b>${esc(i.route)}</b> · ${where(i)}</summary>`, '', img(i.compare, `New page ${i.route} (${where(i)})`), '', '</details>', '');
    }
    if (removed.length) {
      out.push('### Removed pages', '');
      for (const i of removed) out.push(`<details><summary><b>${esc(i.route)}</b> · ${where(i)}</summary>`, '', img(i.compare, `Removed page ${i.route} (${where(i)}), as it was before`), '', '</details>', '');
    }
    const motion = (report.motion ?? []).filter((m) => m.file);
    if (motion.length && tier < 2) {
      out.push('### Motion', '');
      for (const m of motion) out.push(`<details${m.changed ? ' open' : ''}><summary><b>${esc(m.route)}</b> · ${m.viewport}${m.changed ? ' — changed' : ' — same'}</summary>`, '', img(m.file, `Motion in ${m.route}: before and after`), '', '</details>', '');
    }
    for (const v of report.variants ?? []) {
      out.push(`### Variants of \`${esc(v.param)}\` in ${esc(v.route)}`, '');
      if (v.file) out.push(img(v.file, `Variants ${v.param} in ${v.route}`), '');
      out.push('| Variant | Pick |', '|---|---|', ...v.values.map((val) => `| \`${esc(v.param)}=${esc(val)}\` | - [ ] |`), '');
      if (v.failed?.length) out.push(`<sub>Failed: ${v.failed.map((f) => `\`${esc(f)}\``).join(', ')}</sub>`, '');
    }
  } else if (changed.length || added.length || removed.length) {
    out.push(tier >= 3 ? '_Images omitted: the comment would exceed GitHub\'s limit. See the artifact or run `render` locally._' : '_Images not uploaded (text-only mode)._', '');
    for (const i of [...changed, ...added, ...removed]) out.push(`- \`${i.route}\` ${describeItem(i)}`);
    out.push('');
  }

  const unchanged = report.items.filter((i) => !i.changed);
  if (unchanged.length) out.push(`<sub>No difference: ${unchanged.map((i) => `\`${i.route}\` ${where(i)}`).join(', ')}</sub>`, '');
  out.push(`<sub>Generated by visual-diff at ${report.createdAt.slice(0, 16).replace('T', ' ')} UTC. Reruns edit this comment.</sub>`);
  return out.join('\n') + '\n';
}

/** Picks the most complete tier that fits GitHub's limit; as a last resort, truncates with a note. */
export function renderCommentFitting(report, summary, opts) {
  for (const tier of [0, 1, 2, 3]) {
    const body = renderComment(report, summary, { ...opts, tier });
    if (body.length <= COMMENT_LIMIT - 512) return { body, tier };
  }
  const body = renderComment(report, summary, { ...opts, tier: 3 });
  const note = '\n\n_…comment truncated to fit GitHub\'s limit._\n';
  return { body: body.slice(0, COMMENT_LIMIT - note.length - 16) + note, tier: 4 };
}

function a11yBlock(d) {
  const row = (v) => `| ${v.impact} | \`${esc(v.id)}\` | ${esc(v.help)} | \`${esc(v.target).slice(0, 80)}\` |`;
  const out = ['<details><summary>Accessibility (axe)</summary>', ''];
  if (d.added.length) out.push(`**New (${d.added.length})**`, '', '| Impact | Rule | What it is | Where |', '|---|---|---|---|', ...d.added.slice(0, 15).map(row), '');
  if (d.resolved.length) out.push(`**Resolved (${d.resolved.length})**`, '', '| Impact | Rule | What it is | Where |', '|---|---|---|---|', ...d.resolved.slice(0, 10).map(row), '');
  out.push('</details>');
  return out.join('\n');
}

function tokensBlock(findings) {
  const row = (f) => `| ${f.kind === 'color' ? 'color' : 'spacing'} | \`${esc(f.selector).slice(0, 60)}\` | \`${esc(f.prop)}: ${esc(f.value)}\` | ${f.nearest ? `\`${esc(f.nearest.name)}\` (${esc(f.nearest.value)})` : '—'} |`;
  return ['<details><summary>Outside the design tokens</summary>', '', '| Type | Element | Value | Nearest token |', '|---|---|---|---|', ...findings.slice(0, 15).map(row), '', '</details>'].join('\n');
}
