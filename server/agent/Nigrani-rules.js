// Nigrani Agent — Phase 1 rules engine.
// Pure JS, no LLM, no DB calls. Input: a lab snapshot. Output: candidate
// notifications (one object per finding) that the monitor will dedupe and
// persist. Rule outputs are deterministic so dedupe_key collapses repeats.

const RULE_IDS = {
    SHELF_LIFE: 'shelf_life_expiry',
    WORKLOAD:   'workload_imbalance',
    AGING:      'aging_cluster',
    UNASSIGNED: 'unassigned_backlog',
    PRIORITY_UNASSIGNED: 'priority_unassigned',
    TESTING_NOT_STARTED: 'testing_not_started',
};

function parseReceivedOn(value) {
    if (!value) return null;
    // Stored variously as ISO ("2026-04-12") or dd-mm-yyyy ("12-04-2026")
    if (/^\d{2}-\d{2}-\d{4}$/.test(value)) {
        const [d, m, y] = value.split('-');
        const t = Date.parse(`${y}-${m}-${d}`);
        return Number.isFinite(t) ? t : null;
    }
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
}

function ageDays(receivedOn, now) {
    const t = parseReceivedOn(receivedOn);
    if (t === null) return null;
    return Math.floor((now - t) / 86400000);
}

function normalizeIS(isNumber) {
    if (!isNumber) return '';
    return String(isNumber).trim().toUpperCase().replace(/\s+/g, ' ');
}

// --- Rule 1: shelf-life expiry --------------------------------------------
// Sample is approaching or past its TAT (receivedOn + template.tatDays).
// Critical: overdue. Warn: <=2 days remaining.
function detectShelfLife(snapshot) {
    const { samples, templates, now } = snapshot;
    const findings = [];

    for (const s of samples) {
        const tmpl = templates[s.isNumber] || templates[normalizeIS(s.isNumber)];
        const tatDays = (tmpl && tmpl.tatDays) || 7;
        const age = ageDays(s.receivedOn, now);
        if (age === null) continue;

        const daysLeft = tatDays - age;
        if (daysLeft > 7) continue;

        const severity = daysLeft < 0 ? 'critical' : 'warn';
        findings.push({
            rule: RULE_IDS.SHELF_LIFE,
            severity,
            title: daysLeft < 0
                ? `${s.encodedCode} is ${-daysLeft}d past TAT`
                : `${s.encodedCode} TAT due in ${daysLeft}d`,
            sample_ids: [s.encodedCode],
            payload: {
                sampleId:     s.id,
                encodedCode:  s.encodedCode,
                isNumber:     s.isNumber,
                assignedTo:   s.assignedTo || null,
                priority:     s.priorityLevel || null,
                tatDays,
                ageDays:      age,
                daysLeft,
            },
            // One open notification per sample per overdue/critical state.
            // Bucket by severity so a "warn" upgrade to "critical" replaces it.
            dedupe_key: `${RULE_IDS.SHELF_LIFE}:${s.encodedCode}:${severity}`,
        });
    }

    return findings;
}

// --- Rule 2: workload imbalance -------------------------------------------
// Some TA is >1.5x the median TA load (in hours, or sample count fallback).
// One finding per overloaded TA. Severity is warn unless >2x median.
function detectWorkloadImbalance(snapshot) {
    const { loadHoursByTa, sampleCountByTa, activeTAs } = snapshot;
    const findings = [];

    const useHours = Object.keys(loadHoursByTa || {}).length > 0;
    const loadMap = useHours ? loadHoursByTa : sampleCountByTa;

    const taLoads = (activeTAs || [])
        .map(ta => ({ ta, load: loadMap[ta] || 0 }))
        .filter(x => x.load > 0);

    if (taLoads.length < 3) return findings;

    const sorted = taLoads.map(x => x.load).sort((a, b) => a - b);
    const median = sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[Math.floor(sorted.length / 2)];

    if (median <= 0) return findings;

    const warnAt = median * 1.5;
    const critAt = median * 2.0;

    // Candidate light TAs to offload onto (load < 0.5 * median, but > 0 to
    // avoid suggesting people who may simply be on leave).
    const lightTAs = taLoads
        .filter(t => t.load < median * 0.5)
        .sort((a, b) => a.load - b.load)
        .slice(0, 3)
        .map(t => t.ta);

    for (const { ta, load } of taLoads) {
        if (load < warnAt) continue;
        const severity = load >= critAt ? 'critical' : 'warn';
        findings.push({
            rule: RULE_IDS.WORKLOAD,
            severity,
            title: `${ta} is overloaded (${load.toFixed(0)}${useHours ? 'h' : ''} vs ${median.toFixed(0)} median)`,
            sample_ids: [],
            payload: {
                ta,
                load,
                median,
                metric: useHours ? 'hours' : 'count',
                ratio: +(load / median).toFixed(2),
                suggestedRecipients: lightTAs,
            },
            // One open finding per TA per severity bucket.
            dedupe_key: `${RULE_IDS.WORKLOAD}:${ta}:${severity}`,
        });
    }

    return findings;
}

// --- Rule 3: aging cluster -------------------------------------------------
// 5+ samples in the same IS or same TA aged past 30 days. Suggests a
// systemic blocker (equipment, training, leave) rather than a single sample.
function detectAgingCluster(snapshot) {
    const { samples, now } = snapshot;
    const findings = [];

    const agedByIs = new Map();
    const agedByTa = new Map();

    for (const s of samples) {
        const age = ageDays(s.receivedOn, now);
        if (age === null || age <= 30) continue;
        const isKey = normalizeIS(s.isNumber) || 'UNKNOWN_IS';
        const taKey = s.assignedTo || 'UNASSIGNED';
        if (!agedByIs.has(isKey)) agedByIs.set(isKey, []);
        if (!agedByTa.has(taKey)) agedByTa.set(taKey, []);
        agedByIs.get(isKey).push(s);
        agedByTa.get(taKey).push(s);
    }

    for (const [is, list] of agedByIs.entries()) {
        if (list.length < 5) continue;
        const severity = list.length >= 10 ? 'critical' : 'warn';
        findings.push({
            rule: RULE_IDS.AGING,
            severity,
            title: `${list.length} samples aged >30d under IS ${is}`,
            sample_ids: list.slice(0, 25).map(s => s.encodedCode),
            payload: {
                groupBy: 'isNumber',
                key: is,
                count: list.length,
                oldestAge: Math.max(...list.map(s => ageDays(s.receivedOn, now) || 0)),
            },
            dedupe_key: `${RULE_IDS.AGING}:is:${is}`,
        });
    }

    for (const [ta, list] of agedByTa.entries()) {
        if (ta === 'UNASSIGNED') continue; // covered by rule 4
        if (list.length < 5) continue;
        const severity = list.length >= 10 ? 'critical' : 'warn';
        findings.push({
            rule: RULE_IDS.AGING,
            severity,
            title: `${ta} has ${list.length} samples aged >30d`,
            sample_ids: list.slice(0, 25).map(s => s.encodedCode),
            payload: {
                groupBy: 'ta',
                key: ta,
                count: list.length,
                oldestAge: Math.max(...list.map(s => ageDays(s.receivedOn, now) || 0)),
            },
            dedupe_key: `${RULE_IDS.AGING}:ta:${ta}`,
        });
    }

    return findings;
}

// --- Rule 4: unassigned backlog -------------------------------------------
// Unassigned samples have been sitting too long. Fires a single rollup
// finding (not one per sample) so the bell doesn't drown the OIC.
function detectUnassignedBacklog(snapshot) {
    const { samples, now } = snapshot;
    const unassigned = samples.filter(s => !s.assignedTo);
    if (unassigned.length === 0) return [];

    const oldest = unassigned
        .map(s => ({ s, age: ageDays(s.receivedOn, now) }))
        .filter(x => x.age !== null)
        .sort((a, b) => b.age - a.age);

    const oldestAge = oldest.length ? oldest[0].age : 0;
    const agedCount = oldest.filter(x => x.age >= 3).length;

    // Don't fire if everything is fresh (<3 days).
    if (agedCount === 0 && unassigned.length < 10) return [];

    let severity = 'info';
    if (oldestAge >= 7 || unassigned.length >= 25) severity = 'critical';
    else if (oldestAge >= 3 || unassigned.length >= 10) severity = 'warn';

    return [{
        rule: RULE_IDS.UNASSIGNED,
        severity,
        title: `${unassigned.length} unassigned samples (oldest ${oldestAge}d)`,
        sample_ids: oldest.slice(0, 25).map(x => x.s.encodedCode),
        payload: {
            count: unassigned.length,
            agedCount,
            oldestAge,
            oldestCode: oldest[0] ? oldest[0].s.encodedCode : null,
        },
        // Severity changes the bucket so warn -> critical replaces cleanly.
        dedupe_key: `${RULE_IDS.UNASSIGNED}:${severity}`,
    }];
}

// --- Rule 5: priority unassigned ------------------------------------------
function detectPriorityUnassigned(snapshot) {
    const { samples, now } = snapshot;
    const findings = [];
    const priorityUnassigned = samples.filter(s => 
        !s.assignedTo && 
        ((s.priorityLevel || '').toLowerCase() === 'priority' || (s.encodedCode || '').toLowerCase().endsWith('p'))
    );
    
    for (const s of priorityUnassigned) {
        const age = ageDays(s.receivedOn, now);
        if (age === null || age < 1) continue;
        
        findings.push({
            rule: RULE_IDS.PRIORITY_UNASSIGNED,
            severity: 'critical',
            title: `Priority sample ${s.encodedCode} unassigned for ${age} days`,
            sample_ids: [s.encodedCode],
            payload: {
                sampleId: s.id,
                encodedCode: s.encodedCode,
                ageDays: age
            },
            dedupe_key: `${RULE_IDS.PRIORITY_UNASSIGNED}:${s.encodedCode}`,
        });
    }
    return findings;
}

// --- Rule 6: testing not started ------------------------------------------
function detectTestingNotStarted(snapshot) {
    const { samples, now } = snapshot;
    const findings = [];
    
    for (const s of samples) {
        if (s.appStatus !== 'Pending' || !s.assignedTo) continue;
        const age = ageDays(s.receivedOn, now);
        if (age === null || age <= 5) continue;
        
        findings.push({
            rule: RULE_IDS.TESTING_NOT_STARTED,
            severity: age >= 10 ? 'critical' : 'warn',
            title: `Testing not started for ${s.encodedCode} assigned to ${s.assignedTo} (${age}d)`,
            sample_ids: [s.encodedCode],
            payload: {
                sampleId: s.id,
                encodedCode: s.encodedCode,
                assignedTo: s.assignedTo,
                ageDays: age
            },
            dedupe_key: `${RULE_IDS.TESTING_NOT_STARTED}:${s.encodedCode}`,
        });
    }
    return findings;
}

function runRules(snapshot) {
    return [
        ...detectShelfLife(snapshot),
        ...detectWorkloadImbalance(snapshot),
        ...detectAgingCluster(snapshot),
        ...detectUnassignedBacklog(snapshot),
        ...detectPriorityUnassigned(snapshot),
        ...detectTestingNotStarted(snapshot),
    ];
}

module.exports = {
    RULE_IDS,
    runRules,
    detectShelfLife,
    detectWorkloadImbalance,
    detectAgingCluster,
    detectUnassignedBacklog,
    detectPriorityUnassigned,
    detectTestingNotStarted,
    // exported for tests / monitor
    _internal: { parseReceivedOn, ageDays, normalizeIS },
};
