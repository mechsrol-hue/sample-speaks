// Nigrani Agent — Phase 3 tool surface.
//
// Each tool is:
//   1. A Gemini functionDeclaration (schema for the LLM)
//   2. A handler that returns plain JSON (the result the LLM gets back)
//
// HITL boundary: no tool here mutates samples directly. The "action" tools
// (propose_reassignment, request_auto_assign) write to
// assignment_recommendations / lab_notifications so the OIC can approve in
// the existing UIs. The executor module is the only thing that, on OIC
// approval, performs durable changes.

const supabase = require('../../database-supabase');
const { normalizeTaName, normalizeIS } = require('./Nigrani-utils');

// ---------- helper queries -------------------------------------------------

async function loadTemplates() {
    const { data } = await supabase.from('system_preferences').select('key, value').like('key', 'template_%');
    const out = {};
    (data || []).forEach(p => {
        try {
            const val = JSON.parse(p.value);
            const baseKey = p.key.replace('template_', '');
            out[baseKey] = val;
            out[normalizeIS(baseKey)] = val;
        } catch (_) {}
    });
    return out;
}

async function loadPending() {
    const { data } = await supabase
        .from('samples')
        .select('id, encodedCode, assignedTo, isNumber, priorityLevel, receivedOn, appStatus')
        .in('appStatus', ['Pending']);
    return data || [];
}

function ageDays(iso, now = Date.now()) {
    if (!iso) return null;
    if (/^\d{2}-\d{2}-\d{4}$/.test(iso)) {
        const [d, m, y] = iso.split('-');
        const t = Date.parse(`${y}-${m}-${d}`);
        return Number.isFinite(t) ? Math.floor((now - t) / 86400000) : null;
    }
    const t = Date.parse(iso);
    return Number.isFinite(t) ? Math.floor((now - t) / 86400000) : null;
}

// ---------- tool handlers --------------------------------------------------

async function get_workload_snapshot() {
    const [pending, { data: employees }, templates] = await Promise.all([
        loadPending(),
        supabase.from('employee_profiles').select('id, fullName, isActive'),
        loadTemplates(),
    ]);

    const sampleCountByTa = {};
    const hoursByTa = {};
    const isByTa = {};
    for (const s of pending) {
        const ta = normalizeTaName(s.assignedTo || 'UNASSIGNED');
        sampleCountByTa[ta] = (sampleCountByTa[ta] || 0) + 1;
        const tmpl = templates[s.isNumber] || templates[normalizeIS(s.isNumber)];
        hoursByTa[ta] = (hoursByTa[ta] || 0) + ((tmpl && tmpl.totalHours) || 20);
        if (!isByTa[ta]) isByTa[ta] = new Set();
        if (s.isNumber) isByTa[ta].add(normalizeIS(s.isNumber));
    }

    const activeTAs = (employees || [])
        .filter(e => e.isActive !== false)
        .map(e => normalizeTaName(e.fullName));

    const counts = Object.entries(sampleCountByTa)
        .filter(([ta]) => ta !== 'UNASSIGNED')
        .map(([ta, c]) => c)
        .sort((a, b) => a - b);
    const median = counts.length
        ? (counts.length % 2 === 0 ? (counts[counts.length / 2 - 1] + counts[counts.length / 2]) / 2 : counts[Math.floor(counts.length / 2)])
        : 0;

    return {
        totalPending: pending.length,
        unassigned: sampleCountByTa['UNASSIGNED'] || 0,
        median,
        activeTAs,
        byTa: Object.entries(sampleCountByTa)
            .map(([ta, count]) => ({
                ta,
                samples: count,
                hours: hoursByTa[ta] || 0,
                isCount: isByTa[ta] ? isByTa[ta].size : 0,
                flag: count > median * 1.5 ? 'overload' : count < median * 0.5 ? 'capacity' : 'normal',
            }))
            .sort((a, b) => b.samples - a.samples),
    };
}

async function get_sample({ sampleCode }) {
    if (!sampleCode) return { error: 'sampleCode required' };
    const { data } = await supabase
        .from('samples')
        .select('*')
        .or(`encodedCode.eq.${sampleCode},id.eq.${Number(sampleCode) || -1}`)
        .maybeSingle();
    if (!data) return { error: `Sample ${sampleCode} not found.` };
    return {
        ...data,
        ageDays: ageDays(data.receivedOn),
    };
}

async function find_competent_tas({ isNumber }) {
    if (!isNumber) return { error: 'isNumber required' };
    const norm = normalizeIS(isNumber);
    const { data: comps } = await supabase
        .from('employee_competencies')
        .select('employeeId, isNumber, proficiencyLevel')
        .in('isNumber', [isNumber, norm]);
    if (!comps || !comps.length) return { isNumber: norm, competent: [], note: 'No TA marked competent for this IS.' };
    const { data: employees } = await supabase
        .from('employee_profiles')
        .select('id, fullName');
    const empMap = new Map((employees || []).map(e => [e.id, e]));
    return {
        isNumber: norm,
        competent: comps.map(c => ({
            ta:   empMap.get(c.employeeId) ? normalizeTaName(empMap.get(c.employeeId).fullName) : `(id ${c.employeeId})`,
            level: c.proficiencyLevel,
        })),
    };
}

async function get_aging_breakdown() {
    const pending = await loadPending();
    const buckets = { '0-15': 0, '16-30': 0, '31-45': 0, '46-90': 0, '90+': 0, 'unknown': 0 };
    const oldest = [];
    for (const s of pending) {
        const age = ageDays(s.receivedOn);
        if (age === null) { buckets.unknown++; continue; }
        if (age <= 15) buckets['0-15']++;
        else if (age <= 30) buckets['16-30']++;
        else if (age <= 45) buckets['31-45']++;
        else if (age <= 90) buckets['46-90']++;
        else buckets['90+']++;
        oldest.push({ encodedCode: s.encodedCode, isNumber: s.isNumber, assignedTo: s.assignedTo, age });
    }
    oldest.sort((a, b) => b.age - a.age);
    return { buckets, oldestFive: oldest.slice(0, 5) };
}

async function propose_reassignment({ sampleCode, toTa, reason }) {
    if (!sampleCode || !toTa) return { error: 'sampleCode and toTa required' };
    const { data: sample } = await supabase
        .from('samples')
        .select('id, encodedCode, assignedTo, isNumber')
        .eq('encodedCode', sampleCode)
        .maybeSingle();
    if (!sample) return { error: `Sample ${sampleCode} not found.` };

    const { data: employees } = await supabase
        .from('employee_profiles')
        .select('id, fullName');
    const target = (employees || []).find(e => normalizeTaName(e.fullName).toLowerCase() === normalizeTaName(toTa).toLowerCase());
    if (!target) return { error: `TA ${toTa} not found in employee_profiles.` };

    await supabase.from('assignment_recommendations')
        .delete()
        .eq('sampleId', sample.id)
        .eq('status', 'pending');

    const { data: rec, error } = await supabase
        .from('assignment_recommendations')
        .insert({
            sampleId: sample.id,
            recommendedEmployeeId: target.id,
            recommendedEmployeeName: target.fullName,
            reason: reason || 'Nigrani proposal',
            score: 0,
            status: 'pending',
        })
        .select()
        .maybeSingle();
    if (error) return { error: error.message };

    return {
        ok: true,
        proposed: { sampleCode: sample.encodedCode, from: sample.assignedTo, to: target.fullName },
        recommendationId: rec ? rec.id : null,
        nextStep: 'OIC approves in the Recommendations UI to execute.',
    };
}

async function get_audit_log({ sampleCode, limit }) {
    let q = supabase.from('Nigrani_audit_log').select('*').order('created_at', { ascending: false }).limit(Math.min(limit || 20, 100));
    if (sampleCode) {
        const { data: sample } = await supabase.from('samples').select('id').eq('encodedCode', sampleCode).maybeSingle();
        if (sample) q = q.eq('target_type', 'sample').eq('target_id', String(sample.id));
    }
    const { data } = await q;
    return { entries: data || [] };
}

async function list_open_notifications() {
    const { data } = await supabase
        .from('lab_notifications')
        .select('id, type, severity, title, body, created_at')
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .limit(20);
    return { open: data || [] };
}

async function get_template({ isNumber }) {
    if (!isNumber) return { error: 'isNumber required' };
    const templates = await loadTemplates();
    const tmpl = templates[isNumber] || templates[normalizeIS(isNumber)];
    if (!tmpl) return { isNumber, found: false, note: 'No template configured. This is a missing_template signal.' };
    const clauses = tmpl.activeClauses ? Object.entries(tmpl.activeClauses)
        .filter(([, c]) => c && c.active)
        .map(([name, c]) => ({ clause: name, equipment: c.equipment || null, hours: c.hours || null }))
        : [];
    return {
        isNumber: normalizeIS(isNumber),
        found: true,
        totalHours: tmpl.totalHours,
        tatDays: tmpl.tatDays,
        clauses,
    };
}

async function get_pending_recommendations({ limit }) {
    const { data } = await supabase
        .from('assignment_recommendations')
        .select('id, sampleId, recommendedEmployeeName, reason, score, status, created_at')
        .eq('status', 'pending')
        .order('score', { ascending: false })
        .limit(Math.min(limit || 50, 200));
    return { pending: data || [] };
}

async function count_distinct_is() {
    const pending = await loadPending();
    const map = new Map();
    for (const s of pending) {
        const k = normalizeIS(s.isNumber) || 'UNKNOWN';
        map.set(k, (map.get(k) || 0) + 1);
    }
    const breakdown = [...map.entries()]
        .map(([isNumber, count]) => ({ isNumber, count }))
        .sort((a, b) => b.count - a.count);
    return { distinctCount: map.size, totalSamples: pending.length, breakdown };
}

// ---------- new tools phase 1 ----------------------------------------------
async function get_pendency_report() {
    const pending = await loadPending();
    const buckets = { '<30': 0, '31-45': 0, '46-60': 0, '61-90': 0, '90+': 0 };
    let priorityCount = 0;
    let unassignedCount = 0;
    
    for (const s of pending) {
        const age = ageDays(s.receivedOn) || 0;
        if (age < 30) buckets['<30']++;
        else if (age <= 45) buckets['31-45']++;
        else if (age <= 60) buckets['46-60']++;
        else if (age <= 90) buckets['61-90']++;
        else buckets['90+']++;
        
        if (!s.assignedTo) unassignedCount++;
        if ((s.priorityLevel || '').toLowerCase() === 'priority' || (s.encodedCode || '').toLowerCase().endsWith('p')) {
            priorityCount++;
        }
    }
    
    return {
        totalPending: pending.length,
        priority: priorityCount,
        unassigned: unassignedCount,
        ageBuckets: buckets
    };
}

async function get_attendance_today() {
    const todayStr = new Date().toISOString().split('T')[0];
    const { data: attendance } = await supabase.from('employee_attendance').select('*').eq('attendanceDate', todayStr);
    const { data: employees } = await supabase.from('employee_profiles').select('id, fullName');
    
    const present = [];
    const absent = [];
    
    (employees || []).forEach(emp => {
        const record = (attendance || []).find(a => a.employeeId === emp.id);
        if (record && record.status === 'absent') absent.push(emp.fullName);
        else present.push(emp.fullName);
    });
    
    return { today: todayStr, present, absent };
}

async function get_conformance_limits({ isNumber, variety }) {
    if (!isNumber) return { error: 'isNumber required' };
    let q = supabase.from('is_conformance_limits').select('*').eq('isNumber', normalizeIS(isNumber));
    if (variety) q = q.eq('varietyTag', variety);
    const { data, error } = await q;
    if (error || !data) return { error: error ? error.message : 'No limits found', isNumber };
    return { isNumber, limits: data };
}

async function list_priority_unassigned() {
    const pending = await loadPending();
    const list = pending.filter(s => 
        !s.assignedTo && 
        ((s.priorityLevel || '').toLowerCase() === 'priority' || (s.encodedCode || '').toLowerCase().endsWith('p'))
    ).map(s => ({
        encodedCode: s.encodedCode,
        isNumber: s.isNumber,
        ageDays: ageDays(s.receivedOn)
    }));
    return { count: list.length, list };
}

// ---------- declarations for Gemini ---------------------------------------

const functionDeclarations = [
    {
        name: 'get_workload_snapshot',
        description: 'Return the live per-TA workload (sample count, hours, IS variety, overload/capacity flag) plus the lab-wide median. Use this for any "who is busy / who has capacity" question.',
        parameters: { type: 'object', properties: {} },
    },
    {
        name: 'get_sample',
        description: 'Fetch one sample by its encodedCode. Use when the user names a specific sample.',
        parameters: { type: 'object', properties: { sampleCode: { type: 'string' } }, required: ['sampleCode'] },
    },
    {
        name: 'find_competent_tas',
        description: 'List TAs marked competent for an IS standard, with proficiency level. Use before proposing a reassignment to a particular TA.',
        parameters: { type: 'object', properties: { isNumber: { type: 'string' } }, required: ['isNumber'] },
    },
    {
        name: 'get_aging_breakdown',
        description: 'Bucket pending samples by age (0-15/16-30/31-45/46-90/90+ days) and return the 5 oldest. Use for any "how old / how aged" question.',
        parameters: { type: 'object', properties: {} },
    },
    {
        name: 'propose_reassignment',
        description: 'Write a pending recommendation (NOT execute) to reassign one sample from its current TA to a target TA. The OIC approves in the Recommendations UI for the move to take effect.',
        parameters: {
            type: 'object',
            properties: {
                sampleCode: { type: 'string' },
                toTa:       { type: 'string' },
                reason:     { type: 'string' },
            },
            required: ['sampleCode', 'toTa'],
        },
    },
    {
        name: 'get_audit_log',
        description: 'Read recent Nigrani audit log entries — globally, or for a specific sample if sampleCode is provided.',
        parameters: { type: 'object', properties: { sampleCode: { type: 'string' }, limit: { type: 'number' } } },
    },
    {
        name: 'list_open_notifications',
        description: 'Return the bell\'s currently open notifications.',
        parameters: { type: 'object', properties: {} },
    },
    {
        name: 'get_template',
        description: 'Return the BIS testing-charges template for an IS standard: tatDays, totalHours, and the active clauses (each with equipment + hours). Use for "what tests are in IS X" or "how long does IS X take".',
        parameters: { type: 'object', properties: { isNumber: { type: 'string' } }, required: ['isNumber'] },
    },
    {
        name: 'get_pending_recommendations',
        description: 'Return pending rows from assignment_recommendations — i.e. the auto-assigner / Nigrani proposals awaiting OIC approval.',
        parameters: { type: 'object', properties: { limit: { type: 'number' } } },
    },
    {
        name: 'count_distinct_is',
        description: 'Count distinct IS standards currently among pending samples, with per-IS counts.',
        parameters: { type: 'object', properties: {} },
    },
    {
        name: 'get_pendency_report',
        description: 'Returns a structured pendency summary across multiple dimensions (age buckets, priority vs non-priority, assigned vs unassigned).',
        parameters: { type: 'object', properties: {} },
    },
    {
        name: 'get_attendance_today',
        description: 'Returns which TAs are present or absent today based on the attendance register.',
        parameters: { type: 'object', properties: {} },
    },
    {
        name: 'get_conformance_limits',
        description: 'Returns pass/fail limits for a given IS + variety (helps answer "what are the limits for IS 4985 DN75?").',
        parameters: { type: 'object', properties: { isNumber: { type: 'string' }, variety: { type: 'string' } }, required: ['isNumber'] },
    },
    {
        name: 'list_priority_unassigned',
        description: 'Returns all priority samples that are currently unassigned, along with their age in days.',
        parameters: { type: 'object', properties: {} },
    },
];

const HANDLERS = {
    get_workload_snapshot,
    get_sample,
    find_competent_tas,
    get_aging_breakdown,
    propose_reassignment,
    get_audit_log,
    list_open_notifications,
    get_template,
    get_pending_recommendations,
    count_distinct_is,
    get_pendency_report,
    get_attendance_today,
    get_conformance_limits,
    list_priority_unassigned,
};

async function dispatch(name, args) {
    const handler = HANDLERS[name];
    if (!handler) return { error: `Unknown tool: ${name}` };
    try {
        return await handler(args || {});
    } catch (err) {
        return { error: err.message || String(err) };
    }
}

module.exports = { functionDeclarations, dispatch, HANDLERS };
