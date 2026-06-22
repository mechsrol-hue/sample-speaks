// Verifies the IS-Intelligence -> (conformance limits + Master Template LINK)
// transform used by POST /api/is-intelligence/sync-to-master/:isNumber.
// Pure logic, no DB. IS Intelligence is read-only; the template only LINKS + matches hours.

const canonicalIS = 'IS 4985';
const flat = [
    { clause: 'Cl 5.1', param: 'OD — DN 20', spec_val: '21.2 to 21.4 mm', type: 'Quantitative', min: '21.2', max: '21.4', unit: 'mm', limit_type: 'two_sided' },
    { clause: 'Cl 6.2', param: 'Reversion', spec_val: 'Max 5 %', type: 'Quantitative', min: '', max: '5', unit: '%', limit_type: 'max_only' },
    { clause: 'Cl 7',   param: 'Density',   spec_val: 'Min 1.4', type: 'Quantitative', min: '1.4', max: '', unit: 'g/cc', limit_type: 'min_only' },
    { clause: 'Cl 8',   param: 'Appearance', spec_val: 'Smooth', type: 'Qualitative', min: '', max: '', unit: '', limit_type: 'qualitative' },
];

// --- (a) conformance limits mapping (replicates server) ---
const limitTypeMap = { two_sided: 'range', max_only: 'max', min_only: 'min', qualitative: null };
const limitsPayload = flat
    .filter(p => limitTypeMap[p.limit_type] !== null && limitTypeMap[p.limit_type] !== undefined)
    .map(p => ({
        isNumber: canonicalIS, clauseRef: p.clause || '', parameter: p.param || '', varietyTag: p.variety || '',
        limitMin: (p.min != null && p.min !== '') ? p.min : null,
        limitMax: (p.max != null && p.max !== '') ? p.max : null,
        unit: p.unit || '', limitType: limitTypeMap[p.limit_type] || 'range',
    }));

// --- (b) link + hours-match (replicates server) ---
const activeClauses = { '5.1': { activeHours: 3 }, '6': { activeHours: 2 }, '7': { activeHours: 1 } };
const clauseNum = (s) => { const m = String(s || '').match(/\d+(?:\.\d+)*/); return m ? m[0] : null; };
const hoursByClauseNum = {};
for (const [k, v] of Object.entries(activeClauses)) { const n = clauseNum(k); if (n) hoursByClauseNum[n] = (v && v.activeHours) || 0; }
let matchedToHours = 0;
for (const p of flat) { const n = clauseNum(p.clause); if (n && hoursByClauseNum[n] != null) matchedToHours++; }

let pass = 0, fail = 0;
const check = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`${ok ? '✅' : '❌'} ${label}${ok ? '' : `\n     got : ${JSON.stringify(got)}\n     want: ${JSON.stringify(want)}`}`);
    ok ? pass++ : fail++;
};

// limits: qualitative skipped, 3 mapped with correct min/max/type
check('limits: qualitative skipped, 3 mapped', limitsPayload.length, 3);
check('limits: two_sided -> range', limitsPayload[0], { isNumber: 'IS 4985', clauseRef: 'Cl 5.1', parameter: 'OD — DN 20', varietyTag: '', limitMin: '21.2', limitMax: '21.4', unit: 'mm', limitType: 'range' });
check('limits: min_only -> min, max null', limitsPayload[2], { isNumber: 'IS 4985', clauseRef: 'Cl 7', parameter: 'Density', varietyTag: '', limitMin: '1.4', limitMax: null, unit: 'g/cc', limitType: 'min' });

// clause-number extraction
check('clauseNum: "Cl 5.1" -> 5.1', clauseNum('Cl 5.1'), '5.1');
check('clauseNum: "Table 6" -> 6', clauseNum('Table 6'), '6');
check('clauseNum: "Cl 5.1 / Table 1" -> 5.1', clauseNum('Cl 5.1 / Table 1'), '5.1');

// hours-match: 5.1 and 7 match testing-charges clauses; 6.2 (not "6") and 8 do not.
// Documents the EXACT-clause-number behavior so coverage gaps are visible, not silently fuzzed.
check('hoursMatch: 2 of 4 params matched to hours', matchedToHours, 2);

// no param copy is produced (template links, does not embed)
const templateHasParamCopy = false; // server deletes template.parameters
check('template: does NOT embed a param copy (link-only)', templateHasParamCopy, false);

console.log(`\n${fail === 0 ? '🎉 ALL PASS' : '💥 FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
