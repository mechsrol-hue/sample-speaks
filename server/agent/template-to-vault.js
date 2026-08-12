// Project an agent-built IS template (clause-by-clause, with per-combo valueTable) into the
// vault's v3 testParameters shape { flat, sections, referenced_standards } — the SAME columns
// the OpenRouter pipeline writes (server/pipeline/is-pipeline.js, P5). This is the keystone
// that makes IS Intelligence the single source of truth: once these columns are populated,
// /api/is-intelligence/params, /sync-to-master (man-hours link), the conformance-limit sync,
// and the report-from-vault fallback all resolve for agent-extracted standards — instead of
// being empty because the clause data only lived in the on-disk template JSON.
//
// A parameter that varies (valueTable) emits ONE flat row PER value-combo, with variety = the
// joined dimension key the template uses ("Fe 500", "16", or "16|Fe 500"), so per-size/grade
// conformance limits resolve to the exact cell. Constant parameters emit a single row.
//
// limitType vocabularies are bridged to the flat limit_type the conformance sync consumes:
//   template max -> max_only, min -> min_only, range -> two_sided, qualitative|text -> qualitative
// (the conformance sync maps two_sided->range, max_only->max, min_only->min, qualitative->null).
function agentTemplateToVaultParams(tpl) {
    const ltMap = { max: 'max_only', min: 'min_only', range: 'two_sided', qualitative: 'qualitative', text: 'qualitative' };
    const num = (v) => (v === 0 || (v != null && v !== '' && !Number.isNaN(Number(v)))) ? Number(v) : null;
    const params = Array.isArray(tpl && tpl.parameters) ? tpl.parameters : [];
    const flat = [];
    for (const p of params) {
        const base = {
            clause: p.clauseRef || '',
            param: p.parameterName || '',
            unit: p.unit || '',
            limit_type: ltMap[p.limitType] || 'qualitative',
            type: p.acceptanceOrType || '',
            section: p.section || '',
            test_method: p.testMethod || '',
            spec_text: p.specText || '',
        };
        const vt = (p.valueTable && typeof p.valueTable === 'object') ? p.valueTable : null;
        if (vt && Object.keys(vt).length) {
            for (const [combo, v] of Object.entries(vt)) {
                const cell = (v && typeof v === 'object') ? v : {};
                flat.push({
                    ...base,
                    variety: combo,
                    min: num(cell.min),
                    max: num(cell.max),
                    expected: cell.expected != null ? String(cell.expected) : (p.expected != null ? String(p.expected) : ''),
                });
            }
        } else {
            flat.push({
                ...base,
                variety: '',
                min: num(p.min),
                max: num(p.max),
                expected: p.expected != null ? String(p.expected) : '',
            });
        }
    }
    const sections = [...new Set(flat.map(r => r.section).filter(Boolean))];
    const referenced_standards = [...new Set(params.map(p => p.testMethod).filter(Boolean))];
    return { flat, sections, referenced_standards };
}

module.exports = { agentTemplateToVaultParams };
