'use strict';
/**
 * Completeness contract for IS table extraction — the guard against silent truncation.
 *
 * Principle: NEVER trust a single vision read of a dense table. Establish what "complete"
 * looks like from sources that don't truncate (clause prose, pdfplumber, table references),
 * then verify the read against it and demand a re-read of whatever is missing. Nothing is
 * marked done until every expected table has every expected row + passes sanity, OR a human
 * has explicitly accepted the gap.
 *
 * All checks here are DETERMINISTIC (no LLM) so the gate itself can't hallucinate completeness.
 */

// ── 1. Expected row keys (DN sizes) from the clause prose ──────────────────────
// IS dimension tables are keyed by Nominal Diameter, and the standard ALWAYS enumerates
// the DN set in prose (e.g. Cl 4.2 "... are 40, 50, 63, ... and 315 mm"). Prose survives
// vision reads intact, so it's a reliable "expected row" source even when the TABLE truncates.
function expectedDnSet(fullText) {
  const t = String(fullText || '');
  // Capture the whole enumeration after "are"/":" up to "mm". The bracket class swallows
  // the "N, N, N, ... N and N" shape (Indian standards drop the comma before the final "and").
  const m = t.match(/(?:nominal\s+(?:outside\s+)?diameter|nominal\s+size|size\s+designation|\bDN\b)[^.]{0,90}?\b(?:are|:)\s*([0-9][0-9,\s]*(?:and\s+[0-9,\s]+)?)\s*mm/i);
  if (m) {
    const nums = (m[1].match(/\d{1,4}/g) || []).map(Number).filter(n => n >= 10 && n <= 2000);
    if (nums.length >= 3) return [...new Set(nums)].sort((a, b) => a - b);
  }
  return [];
}

// ── 2. Expected table inventory from "Table N" references in the text ──────────
// The body references every real table by number ("as given in Table 1", "Tables 3 and 4").
// If a referenced table never shows up in the extraction, it was dropped → re-read its page.
function referencedTables(fullText) {
  const refs = new Set();
  const re = /\bTables?\s+(\d{1,2})(?:\s+and\s+(\d{1,2}))?/gi;
  let m;
  while ((m = re.exec(String(fullText || '')))) { refs.add(+m[1]); if (m[2]) refs.add(+m[2]); }
  return [...refs].sort((a, b) => a - b);
}

// Only the SPEC/dimension tables that feed the report matter for completeness — not the
// sampling-plan / acceptance-number / test-setup tables (we exclude those by design). Keep a
// "Table N" reference only when its surrounding context is dimensional and not sampling.
function referencedDimensionalTables(fullText) {
  const t = String(fullText || '');
  const keep = new Set();
  const re = /\bTables?\s+(\d{1,2})(?:\s+and\s+(\d{1,2}))?/gi;
  let m;
  while ((m = re.exec(t))) {
    const ctx = t.slice(Math.max(0, m.index - 90), m.index + 90);
    const dimensional = /diameter|thickness|socket|dimension|wall/i.test(ctx);
    const sampling = /sampl|acceptance|\blot\b|striker|scale of sampling|criteria for conformity/i.test(ctx);
    if (dimensional && !sampling) { keep.add(+m[1]); if (m[2]) keep.add(+m[2]); }
  }
  return [...keep].sort((a, b) => a - b);
}

// Numeric row keys present in an extracted table (handles {key} or first-cell rows).
function tableDnKeys(table) {
  const rows = (table && table.rows) || [];
  const keys = rows.map(r => {
    const raw = r && (r.key != null ? r.key : (Array.isArray(r) ? r[0] : (r.values && Object.values(r.values)[0])));
    const mm = String(raw == null ? '' : raw).match(/\d{1,4}(?:\.\d+)?/);
    return mm ? Number(mm[0]) : null;
  }).filter(v => v != null);
  return [...new Set(keys)].sort((a, b) => a - b);
}

// ── 3. Structural sanity (catches misreads a count check would miss) ───────────
// OD must increase with DN; every min must be ≤ its max. A truncated/garbled read
// frequently violates one of these.
function sanityFlags(table) {
  const flags = [];
  const rows = (table && table.rows) || [];
  // min ≤ max per labelled pair
  rows.forEach(r => {
    const v = (r && r.values) || {};
    Object.keys(v).forEach(col => {
      if (/\bmin\b/i.test(col)) {
        const base = col.replace(/\bmin\b/i, '').trim();
        const maxCol = Object.keys(v).find(c => c.replace(/\bmax\b/i, '').trim() === base && /\bmax\b/i.test(c));
        const a = parseFloat(v[col]), b = parseFloat(v[maxCol]);
        if (!isNaN(a) && !isNaN(b) && a > b) flags.push(`min>max at ${r.key}/${base}: ${a}>${b}`);
      }
    });
  });
  // OD monotonic with DN (first numeric value column, by sorted key)
  const dnRows = rows.map(r => ({ dn: (String(r.key || '').match(/\d+/) || [])[0], v: r.values || {} }))
    .filter(x => x.dn).sort((a, b) => a.dn - b.dn);
  const odCol = dnRows.length ? Object.keys(dnRows[0].v).find(c => /\bod\b|outside\s*dia|mean/i.test(c)) : null;
  if (odCol) {
    let prev = -Infinity;
    for (const x of dnRows) {
      const val = parseFloat(x.v[odCol]);
      if (!isNaN(val)) { if (val < prev - 0.01) flags.push(`OD non-monotonic at DN${x.dn} (${val} < ${prev})`); prev = val; }
    }
  }
  return flags;
}

// ── 4. The gate: expected vs got, with concrete re-read actions ────────────────
/**
 * @param {Array} tables  extracted tables: [{ tableId, page, type, rows:[{key,values}] }]
 * @param {string} fullText  whole-document transcription / pdfplumber text
 * @param {object} opts  { pdfplumberRowCounts?: { [page]: n } }
 * @returns {{ complete:boolean, expectedDn:number[], perTable:object[], missingTables:number[], actions:object[], summary:string }}
 */
function checkCompleteness(tables, fullText, opts = {}) {
  const expectedDn = expectedDnSet(fullText);
  const refTables = referencedDimensionalTables(fullText);
  const actions = [];
  const perTable = [];

  for (const t of (tables || [])) {
    const isDimensional = t.type === 'dimensional' || /diameter|thickness|socket|dimension/i.test(t.description || '');
    const gotKeys = tableDnKeys(t);
    const missingRows = (isDimensional && expectedDn.length)
      ? expectedDn.filter(dn => !gotKeys.some(g => Math.abs(g - dn) < 0.5))
      : [];
    const sanity = sanityFlags(t);
    const pdfCount = opts.pdfplumberRowCounts && opts.pdfplumberRowCounts[t.page];
    const rowCountMismatch = (pdfCount != null && Math.abs(pdfCount - (t.rows || []).length) > 1)
      ? `vision read ${ (t.rows||[]).length } rows but pdfplumber saw ${pdfCount}` : null;

    const ok = missingRows.length === 0 && sanity.length === 0 && !rowCountMismatch;
    perTable.push({ tableId: t.tableId, page: t.page, gotRows: (t.rows || []).length, missingRows, sanity, rowCountMismatch, ok });

    if (missingRows.length || rowCountMismatch) {
      actions.push({
        type: 'reread', tableId: t.tableId, page: t.page,
        reason: missingRows.length ? `missing DN rows: ${missingRows.join(', ')}` : rowCountMismatch,
        // The re-read prompt gets these so it can demand the exact missing rows:
        demandKeys: missingRows,
      });
    }
  }

  // Tables referenced in prose but never extracted → re-read whichever pages mention them.
  const gotTableNums = new Set((tables || []).map(t => +(String(t.tableId || '').match(/\d+/) || [])[0]).filter(Boolean));
  const missingTables = refTables.filter(n => !gotTableNums.has(n));
  missingTables.forEach(n => actions.push({ type: 'reread_table', tableNum: n, reason: `Table ${n} referenced in text but not extracted` }));

  const complete = actions.length === 0;
  const summary = complete
    ? `✅ complete — ${(tables || []).length} tables, all expected DN rows present, sanity OK`
    : `⚠ incomplete — ${actions.length} action(s): ${actions.map(a => a.reason).join('; ')}`;

  return { complete, expectedDn, perTable, missingTables, actions, summary };
}

// ── 5. Template-centric completeness — the check the agent actually runs ────────
// Runs against the agent's OWN vision transcript (clean text — pdfplumber mangles the
// size-designation clause) + the draft template. Verifies the dimensionGrid covers every DN the
// standard specifies, and that every referenced dimension table is represented (via sourceTable).
function checkTemplateCompleteness(template, fullText) {
  template = template || {};
  const expectedDn = expectedDnSet(fullText);
  const gridKeys = Object.keys(template.dimensionGrid || {}).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
  const missingDn = expectedDn.filter(dn => !gridKeys.some(g => Math.abs(g - dn) < 0.5));

  // Which dimension tables did the agent actually capture? Tracked via each param's sourceTable.
  const refTables = referencedDimensionalTables(fullText);
  const gotTables = new Set();
  (template.parameters || []).forEach(p => {
    const m = String(p.sourceTable || '').match(/\d+/);
    if (m) gotTables.add(+m[0]);
  });
  const missingTables = refTables.filter(n => !gotTables.has(n));

  const actions = [];
  if (missingDn.length) actions.push({ type: 'reread', reason: `dimensionGrid missing DN sizes: ${missingDn.join(', ')}`, demandKeys: missingDn });
  missingTables.forEach(n => actions.push({ type: 'reread_table', tableNum: n, reason: `dimension Table ${n} is referenced but no parameter carries sourceTable "Table ${n}" — extract it` }));

  const complete = actions.length === 0;
  return {
    complete, expectedDn, gridKeys, missingDn, refTables, missingTables, actions,
    summary: complete
      ? `✅ complete — grid covers all ${expectedDn.length || gridKeys.length} DN sizes; dimension tables [${refTables.join(', ')}] all present`
      : `⚠ incomplete — ${actions.map(a => a.reason).join('; ')}`,
  };
}

module.exports = { expectedDnSet, referencedTables, referencedDimensionalTables, tableDnKeys, sanityFlags, checkCompleteness, checkTemplateCompleteness };
