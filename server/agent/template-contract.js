// Contract check for extraction-produced templates — the loud failure the IS 694 bug
// never had. The extraction wrote a correct construction label (appliesTo) that no
// reader checked, and a report printed a twin-cord dimension on a single-core cable.
// The renderer now gates, but a future re-extract that drops or misspells the label
// would silently reopen the hole. This makes that a gate failure at extraction time.
//
// Errors fail the extraction. Warnings are printed for the agent to resolve or
// consciously accept. Everything here uses the same JS string semantics the report
// renderer uses (String(1.0) === '1'), so a check can't disagree with the app.
'use strict';

const CONSTRUCTION_HINT = /\((?:[^)]*\b(?:single core|multicore|multi-core|flexible|rigid|flat|sheathed|unsheathed|cord|cable|solid|stranded)\b[^)]*)\)/i;

function validateTemplateContract(tpl) {
    const errors = [];
    const warnings = [];
    const dims = Array.isArray(tpl && tpl.parameterizationDims) ? tpl.parameterizationDims : [];
    const opts = (tpl && tpl.dimensionOptions) || {};
    const params = Array.isArray(tpl && tpl.parameters) ? tpl.parameters : [];

    const optionStrings = {};
    for (const d of dims) optionStrings[d] = (opts[d] || []).map(String);

    for (const d of dims) {
        if (!Array.isArray(opts[d]) || !opts[d].length) {
            errors.push(`dimension "${d}" is declared in parameterizationDims but has no dimensionOptions`);
        }
    }
    for (const d of Object.keys(opts)) {
        if (!dims.includes(d)) warnings.push(`dimensionOptions has "${d}" which parameterizationDims does not declare`);
    }

    // Does any dimension enumerate constructions/variants (string options)? If so, an
    // ungated construction-specific parameter is the exact IS 694 failure shape.
    const variantDims = dims.filter(d => (opts[d] || []).some(o => typeof o === 'string' && o.length > 3));

    params.forEach((p, i) => {
        const name = p.parameterName || `parameters[${i}]`;

        // appliesTo must name a real option of some dimension, or it can never gate.
        if (p.appliesTo) {
            const owned = Object.values(optionStrings).some(list => list.includes(String(p.appliesTo)));
            if (!owned) errors.push(`"${name}": appliesTo "${p.appliesTo}" matches no dimensionOptions value — the report can never gate this row`);
        }

        if (p.conditionalOn && typeof p.conditionalOn === 'object') {
            for (const [k, v] of Object.entries(p.conditionalOn)) {
                if (!dims.includes(k)) errors.push(`"${name}": conditionalOn references unknown dimension "${k}"`);
                else if (!optionStrings[k].includes(String(v))) errors.push(`"${name}": conditionalOn ${k}="${v}" is not one of that dimension's options`);
            }
        }

        const vb = Array.isArray(p.variesBy) ? p.variesBy : [];
        for (const d of vb) {
            if (!dims.includes(d)) errors.push(`"${name}": variesBy names unknown dimension "${d}"`);
        }

        // Every selectable combination must resolve, and no key may be unreachable.
        if (p.valueTable && typeof p.valueTable === 'object' && vb.length && vb.every(d => optionStrings[d] && optionStrings[d].length)) {
            const combos = vb.map(d => optionStrings[d])
                .reduce((acc, list) => acc.flatMap(a => list.map(v => (a ? a + '|' + v : v))), ['']);
            const missing = combos.filter(c => !(c in p.valueTable));
            const orphans = Object.keys(p.valueTable).filter(k => !combos.includes(k));
            if (missing.length) errors.push(`"${name}": valueTable is missing ${missing.length}/${combos.length} selectable combination(s), e.g. "${missing[0]}" — the report will show "pending re-extract" for real selections`);
            if (orphans.length) warnings.push(`"${name}": valueTable has ${orphans.length} key(s) no selection can ever reach, e.g. "${orphans[0]}"`);
        }

        // The IS 694 shape itself: a name that says which construction it belongs to,
        // in a template that HAS a construction dimension, with no gate declared.
        if (variantDims.length && !p.appliesTo && !p.conditionalOn && CONSTRUCTION_HINT.test(name)) {
            warnings.push(`"${name}": name looks construction-specific but has no appliesTo/conditionalOn — it will appear on every construction's report (the IS 694 bug shape)`);
        }
    });

    return { ok: errors.length === 0, errors, warnings };
}

module.exports = { validateTemplateContract };
