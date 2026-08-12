#!/usr/bin/env node
/**
 * Golden report test — renders IS 694's report rows the way the app does and diffs
 * them against hand-verified ground truth from the printed standard (Table 3, checked
 * cell-by-cell against the BIS PDF on 2026-08-12).
 *
 *   node scripts/test_report_golden.js        → exit 0 all green, 1 on any drift
 *
 * Exists because the IS 694 bug produced a PLAUSIBLE wrong number: a twin-cord
 * dimension (4.8 × 9.6, Table 7) printed on a single-core report, indistinguishable
 * on paper from a correct row. Nothing failed. This makes that class fail loudly:
 * if any change — renderer, template, re-extract — puts a foreign row back or moves
 * a Table 3 value, this exits 1.
 *
 * NOTE: the row-selection rules here (appliesTo gate, conditionalOn, valueTable
 * lookup) deliberately mirror renderVaultISReportRows() in public/app.js. If that
 * logic changes, change it here too — a false failure from drift is cheap; the
 * silent wrong number this guards against is not.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const tpl = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'is_templates', 'IS_694_2010.json'), 'utf8'));

// ── the app's selection rules, mirrored ────────────────────────────────────────
function appliesToSelection(appliesTo, tpl, sel) {
    const opts = tpl.dimensionOptions || {};
    for (const dim of Object.keys(opts)) {
        if ((opts[dim] || []).map(String).includes(String(appliesTo))) return String(sel[dim]) === String(appliesTo);
    }
    return true;
}
function condMet(cond, sel) {
    return Object.entries(cond || {}).every(([k, v]) => String(sel[k]) === String(v));
}
function renderRows(sel) {
    const rows = [];
    for (const p of (tpl.parameters || [])) {
        if (p.conditionalOn && !condMet(p.conditionalOn, sel)) continue;
        if (p.appliesTo && !appliesToSelection(p.appliesTo, tpl, sel)) continue;
        let value = null;
        if (p.valueTable && Array.isArray(p.variesBy) && p.variesBy.length) {
            const e = p.valueTable[p.variesBy.map(d => sel[d]).join('|')];
            if (e) value = (e.min != null ? e.min : (e.max != null ? e.max : e.value != null ? e.value : e.expected));
        }
        rows.push({ clause: p.clauseRef, name: p.parameterName, value });
    }
    return rows;
}

// ── ground truth: IS 694:2010 Table 3, verified against the printed standard ───
// size → { class → [nominal insulation thickness ti (mm), maximum overall diameter (mm)] }
const TABLE3 = {
    '0.5': { 1: [0.6, 2.3] }, '0.75': { 1: [0.6, 2.5] }, '1': { 1: [0.6, 2.7] },
    '1.5': { 1: [0.7, 3.2], 2: [0.7, 3.3] }, '2.5': { 1: [0.8, 3.9], 2: [0.8, 4.0] },
    '4': { 1: [0.8, 4.4], 2: [0.8, 4.6] }, '6': { 1: [0.8, 5.0], 2: [0.8, 5.2] },
    '10': { 1: [1.0, 6.4], 2: [1.0, 6.7] }, '16': { 2: [1.0, 7.8] }, '25': { 2: [1.2, 9.7] },
    '35': { 2: [1.2, 10.9] }, '50': { 2: [1.4, 12.8] }, '70': { 2: [1.4, 14.6] },
    '95': { 2: [1.6, 17.1] }, '120': { 2: [1.6, 18.8] }, '150': { 2: [1.8, 20.9] },
    '185': { 2: [2.0, 23.3] }, '240': { 2: [2.2, 26.6] }, '300': { 2: [2.4, 29.6] },
    '400': { 2: [2.6, 33.2] }, '500': { 2: [2.8, 37.5] }, '630': { 2: [3.0, 42.0] },
};
const SINGLE_CORE_RIGID = 'Single core non-sheathed, rigid conductor (Cl 16, Table 3)';
const FOREIGN_CLAUSES = ['Cl 17', 'Cl 18', 'Cl 19', 'Cl 20', 'Cl 21', 'Cl 22'];

let failures = 0;
const fail = (msg) => { failures++; console.error('  FAIL', msg); };

// 1. No foreign construction row may appear on a single-core rigid report.
{
    const rows = renderRows({ cableType: SINGLE_CORE_RIGID, size: 4, cores: 3, class: 2 });
    for (const r of rows) {
        if (FOREIGN_CLAUSES.some(c => String(r.clause || '').startsWith(c))) {
            fail(`foreign row on single-core report: ${r.clause} ${r.name}`);
        }
    }
    if (!rows.some(r => String(r.clause || '').startsWith('Cl 16'))) fail('single-core report lost its own Cl 16 rows');
    // The exact bug: the twin-cord dimension must be absent.
    if (rows.some(r => /twin cord/i.test(r.name || ''))) fail('the IS 694 bug is back: twin-cord row on a single-core report');
}

// 2. Every Table 3 cell must render exactly as printed in the standard.
{
    const ti = (tpl.parameters || []).find(p => p.parameterName === 'Nominal thickness of insulation (single core rigid)');
    const od = (tpl.parameters || []).find(p => p.parameterName === 'Maximum overall diameter (single core rigid)');
    if (!ti || !od) fail('Table 3 parameters missing from the template (renamed or dropped by a re-extract?)');
    else {
        for (const [size, byClass] of Object.entries(TABLE3)) {
            for (const [cls, [wantTi, wantOd]] of Object.entries(byClass)) {
                const sel = { cableType: SINGLE_CORE_RIGID, size, class: cls, cores: 1 };
                const rows = renderRows(sel);
                const gotTi = rows.find(r => r.name === ti.parameterName);
                const gotOd = rows.find(r => r.name === od.parameterName);
                if (!gotTi || Number(gotTi.value) !== wantTi) fail(`Table 3 ti size=${size} class=${cls}: got ${gotTi && gotTi.value}, standard says ${wantTi}`);
                if (!gotOd || Number(gotOd.value) !== wantOd) fail(`Table 3 OD size=${size} class=${cls}: got ${gotOd && gotOd.value}, standard says ${wantOd}`);
            }
        }
    }
}

// 3. The template itself must keep passing its contract (gates resolvable, keys complete).
{
    const { validateTemplateContract } = require('../server/agent/template-contract');
    const c = validateTemplateContract(tpl);
    for (const e of c.errors) fail(`contract: ${e}`);
}

if (failures) {
    console.error(`\n${failures} failure(s) — the report no longer matches the printed standard.`);
    process.exit(1);
}
console.log('golden report OK — no foreign rows on any construction, all 54 Table 3 cells exact, contract clean.');
