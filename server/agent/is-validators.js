// ─────────────────────────────────────────────────────────────────────────────
// Deterministic validators for extracted IS-standard data.
// Pure rules + arithmetic — NO AI, no guessing. Same input → same flags, always.
// Validators FLAG (they never auto-correct), because the source can contain errata;
// the OIC decides. Each flag is explainable: it names the rule that failed.
// ─────────────────────────────────────────────────────────────────────────────

function num(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : NaN; // NaN = present but not a number
}

function flag(list, ref, field, rule, severity, detail) {
    list.push({ ref: String(ref), field, rule, severity, detail: detail || '' });
}

// ── Generic per-parameter checks (works on any IS's flat parameter list) ──
// Each param: { param, min, max, expected, limit_type, type, unit, ... }
function validateParameters(params) {
    const flags = [];
    (params || []).forEach((p, i) => {
        const ref = p.clause || p.param || `row ${i + 1}`;
        const lt = (p.limit_type || '').toLowerCase();
        const mn = num(p.min), mx = num(p.max);

        if (Number.isNaN(mn)) flag(flags, ref, 'min', 'non_numeric', 'error', `min "${p.min}" is not a number`);
        if (Number.isNaN(mx)) flag(flags, ref, 'max', 'non_numeric', 'error', `max "${p.max}" is not a number`);

        if (lt === 'two_sided') {
            if (mn === null || mx === null) flag(flags, ref, 'min/max', 'two_sided_missing_bound', 'warn', 'two-sided limit missing a bound');
            else if (mn > mx) flag(flags, ref, 'min/max', 'min_gt_max', 'error', `min ${mn} > max ${mx}`);
        } else if (lt === 'max_only') {
            if (mn !== null && !Number.isNaN(mn)) flag(flags, ref, 'min', 'max_only_has_min', 'warn', 'max_only limit has a min value');
            if (mx === null) flag(flags, ref, 'max', 'max_only_missing_max', 'warn', 'max_only limit missing its max');
        } else if (lt === 'min_only') {
            if (mx !== null && !Number.isNaN(mx)) flag(flags, ref, 'max', 'min_only_has_max', 'warn', 'min_only limit has a max value');
            if (mn === null) flag(flags, ref, 'min', 'min_only_missing_min', 'warn', 'min_only limit missing its min');
        } else if (lt === 'qualitative') {
            if (mn !== null || mx !== null) flag(flags, ref, 'min/max', 'qualitative_has_numeric', 'warn', 'qualitative limit has numeric bounds');
        }

        if (String(p.status || '').toLowerCase() === 'unreadable')
            flag(flags, ref, p.field || 'value', 'unreadable', 'error', 'model marked this cell unreadable');
        if (String(p.status || '').toLowerCase() === 'needs_review')
            flag(flags, ref, p.field || 'value', 'needs_review', 'warn', 'model flagged for review');
    });
    return flags;
}

// ── Dimension-grid checks (OD + per-class thickness table, e.g. IS 4985 Table 1) ──
// sizes: { <DN>: { min_od, max_od, min_od_any, max_od_any, thickness: { <class>: [avg, min, max] } } }
function validateDimensionGrid(sizes) {
    const flags = [];
    const dns = Object.keys(sizes || {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    let prevMinOd = -Infinity, prevMaxOd = -Infinity;

    for (const dn of dns) {
        const s = sizes[dn];
        const minOd = num(s.min_od), maxOd = num(s.max_od);
        const minAny = num(s.min_od_any), maxAny = num(s.max_od_any);

        if (minOd !== null && maxOd !== null && minOd > maxOd) flag(flags, dn, 'mean_od', 'min_gt_max', 'error', `${minOd} > ${maxOd}`);
        if (minAny !== null && maxAny !== null && minAny > maxAny) flag(flags, dn, 'od_any', 'min_gt_max', 'error', `${minAny} > ${maxAny}`);
        // Mean OD must grow with nominal size
        if (minOd !== null && minOd < prevMinOd) flag(flags, dn, 'min_od', 'od_not_monotonic', 'warn', `mean-OD min ${minOd} < previous ${prevMinOd}`);
        if (maxOd !== null && maxOd < prevMaxOd) flag(flags, dn, 'max_od', 'od_not_monotonic', 'warn', `mean-OD max ${maxOd} < previous ${prevMaxOd}`);
        if (minOd !== null) prevMinOd = minOd;
        if (maxOd !== null) prevMaxOd = maxOd;

        const classes = Object.keys(s.thickness || {}).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
        let prevMin = -Infinity;
        for (const c of classes) {
            const t = s.thickness[c] || [];
            const avg = num(t[0]), mn = num(t[1]), mx = num(t[2]);
            // ordering within a cell: min <= avg <= max
            if (mn !== null && avg !== null && mn > avg) flag(flags, dn, `thickness.C${c}`, 'min_gt_avg', 'error', `min ${mn} > avg ${avg}`);
            if (avg !== null && mx !== null && avg > mx) flag(flags, dn, `thickness.C${c}`, 'avg_gt_max', 'error', `avg ${avg} > max ${mx}`);
            // thickness must rise with pressure class for the same DN
            if (mn !== null && mn < prevMin) flag(flags, dn, `thickness.C${c}`, 'class_not_monotonic', 'warn', `class ${c} min ${mn} < lower class ${prevMin}`);
            if (mn !== null) prevMin = mn;
        }
    }
    return flags;
}

function summarize(flags) {
    return {
        total: flags.length,
        errors: flags.filter(f => f.severity === 'error').length,
        warnings: flags.filter(f => f.severity === 'warn').length,
        flags,
    };
}

module.exports = { validateParameters, validateDimensionGrid, summarize };
