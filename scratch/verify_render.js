#!/usr/bin/env node
'use strict';
/**
 * Headless mirror of app.js renderVaultISReportRows() — resolves every report row for a given
 * dropdown selection exactly as the browser renderer does (valueTable branch → gridRows branch →
 * constant). Proves a template produces a COMPLETE report (no "pending" rows) and that numeric
 * limits resolve with the min/max that drive green/red.
 *
 *   node scratch/verify_render.js public/is_templates/IS_1786_2008.json size=16 grade="Fe 500"
 */
const fs = require('fs');

function specFromEntry(e, unit, specText) {
  const u = unit ? ` ${unit}` : '';
  if (e.min != null && e.max != null) return `${e.min}–${e.max}${u}`.trim();
  if (e.min != null) return `Min ${e.min}${u}`.trim();
  if (e.max != null) return `Max ${e.max}${u}`.trim();
  if (e.value != null) return `${e.value}${u}`.trim();
  if (e.expected != null) return String(e.expected);
  return specText || '';
}
function tplResolvePath(grid, path, sel) {
  let cur = grid;
  for (let seg of path) {
    if (typeof seg === 'string' && seg.startsWith('{') && seg.endsWith('}')) seg = sel[seg.slice(1, -1)];
    if (cur == null) return null; cur = cur[seg];
  }
  return cur === undefined ? null : cur;
}
function tplCondMet(cond, sel) { return Object.entries(cond || {}).every(([k, v]) => String(sel[k]) === String(v)); }

function resolveRows(tpl, sel) {
  const grid = (tpl.dimensionGrid || {})[String(sel.size)] || null;
  const rows = [];
  (tpl.parameters || []).forEach(p => {
    if (p.conditionalOn && !tplCondMet(p.conditionalOn, sel)) { rows.push({ clause: p.clauseRef, name: p.parameterName, spec: 'Not applicable', na: true }); return; }
    if (p.valueTable && Array.isArray(p.variesBy) && p.variesBy.length) {
      const e = p.valueTable[p.variesBy.map(d => sel[d]).join('|')];
      const isQ = p.limitType === 'qualitative' || p.limitType === 'text';
      if (!e) rows.push({ clause: p.clauseRef, name: p.parameterName, spec: '— (pending re-extract)', pending: true });
      else rows.push({ clause: p.clauseRef, name: p.parameterName, spec: specFromEntry(e, p.unit, p.specText), min: e.min, max: e.max, expected: e.expected, qualitative: isQ });
      return;
    }
    if (Array.isArray(p.gridRows)) {
      p.gridRows.forEach(gr => {
        const val = grid ? tplResolvePath(grid, gr.path, sel) : null;
        rows.push({ clause: p.clauseRef, name: `${p.parameterName} (${gr.label})`, spec: val == null ? '— (pending re-extract)' : `${gr.label} ${val} ${p.unit || ''}`.trim(), pending: val == null, min: gr.limit === 'min' ? val : '', max: gr.limit === 'max' ? val : '' });
      });
      return;
    }
    const isQ = p.limitType === 'qualitative' || p.limitType === 'text';
    const spec = p.specText || [p.min ? `Min ${p.min}` : '', p.max ? `Max ${p.max}` : ''].filter(Boolean).join(' / ') || p.expected || '';
    rows.push({ clause: p.clauseRef, name: p.parameterName, spec, min: p.min, max: p.max, expected: p.expected, qualitative: isQ });
  });
  return rows;
}

const [, , file, ...kv] = process.argv;
const tpl = JSON.parse(fs.readFileSync(file, 'utf8'));
const sel = {};
(tpl.parameterizationDims || []).forEach(d => { sel[d] = (tpl.defaults || {})[d]; });
kv.forEach(pair => { const i = pair.indexOf('='); if (i > 0) sel[pair.slice(0, i)] = pair.slice(i + 1).replace(/^["']|["']$/g, ''); });

console.log(`\n${tpl.isNumber}  —  selection: ${JSON.stringify(sel)}\n`);
const rows = resolveRows(tpl, sel);
let pending = 0;
rows.forEach(r => {
  const bound = r.qualitative ? (r.expected != null ? `expect=${r.expected}` : '') : `min=${r.min ?? ''} max=${r.max ?? ''}`;
  const mark = r.pending ? ' ❌PENDING' : '';
  if (r.pending) pending++;
  console.log(`  ${String(r.clause || '').padEnd(9)} ${String(r.name).slice(0, 44).padEnd(45)} ${String(r.spec).slice(0, 30).padEnd(31)} ${bound}${mark}`);
});
console.log(`\n${pending === 0 ? '✅ COMPLETE' : '❌ ' + pending + ' PENDING'} — ${rows.length} rows, ${rows.filter(r => !r.qualitative && !r.na && (r.min != null && r.min !== '' || r.max != null && r.max !== '')).length} with numeric bounds (green/red enabled)\n`);
process.exit(pending === 0 ? 0 : 1);
