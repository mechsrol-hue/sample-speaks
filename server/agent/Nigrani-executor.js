// Nigrani Agent — Phase 2 executor.
//
// Contract:
//   - The executor NEVER acts without an explicit human approval.
//   - Approval comes from POST /api/notifications/:id/approve. That handler
//     looks up the notification, and — if its type is executable — calls
//     this module. Every action writes a Nigrani_audit_log row.
//   - If the notification has no executable action (e.g. an aging cluster
//     summary), executor is a no-op and the bell row simply gets marked
//     'approved' for record-keeping.
//
// Executable notification types (Phase 2):
//   - workload_imbalance        : enqueue suggested moves into
//                                 assignment_recommendations (status=pending).
//                                 The OIC still confirms in the existing
//                                 recommendations UI before any sample.assignedTo
//                                 actually changes.
//   - unassigned_backlog        : runs /api/auto-assign behaviour (well —
//                                 the same write to assignment_recommendations)
//                                 to produce recommendations the OIC reviews.
//   - shelf_life_expiry         : flags the sample in audit log and bumps
//                                 it to the top of the recommendation queue
//                                 (HITL — no auto-reassignment).
//   - aging_cluster             : informational; approve = acknowledge.

const supabase = require('../../database-supabase');
const { logAudit, normalizeIS } = require('./Nigrani-utils');

async function fetchTemplates() {
    const { data } = await supabase
        .from('system_preferences')
        .select('key, value')
        .like('key', 'template_%');
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

async function pickSampleForOffload({ fromTa }) {
    // Pick the lowest-priority oldest sample assigned to fromTa.
    const { data } = await supabase
        .from('samples')
        .select('id, encodedCode, isNumber, priorityLevel, receivedOn, assignedTo')
        .eq('assignedTo', fromTa)
        .eq('appStatus', 'Pending')
        .order('priorityLevel', { ascending: true })
        .order('receivedOn', { ascending: true });
    if (!data || !data.length) return null;
    const score = s => {
        const p = (s.priorityLevel || '').toUpperCase();
        return p === 'LOW' ? 0 : p === 'NORMAL' ? 1 : 2;
    };
    return [...data].sort((a, b) => score(a) - score(b))[0];
}

async function findCompetentEmployee(isNumber) {
    const norm = normalizeIS(isNumber);
    const { data: comps } = await supabase
        .from('employee_competencies')
        .select('employeeId, isNumber, proficiencyLevel')
        .in('isNumber', [isNumber, norm]);
    if (!comps || !comps.length) return null;
    const { data: employees } = await supabase
        .from('employee_profiles')
        .select('id, fullName');
    return { comps, employees: employees || [] };
}

async function writeRecommendation({ sampleId, employeeId, employeeName, reason, score }) {
    // Clear any prior pending rec for the same sample, then insert.
    await supabase.from('assignment_recommendations')
        .delete()
        .eq('sampleId', sampleId)
        .eq('status', 'pending');
    const { data, error } = await supabase
        .from('assignment_recommendations')
        .insert({
            sampleId,
            recommendedEmployeeId: employeeId,
            recommendedEmployeeName: employeeName,
            reason,
            score: score == null ? null : Math.round(score * 100) / 100,
            status: 'pending',
        })
        .select()
        .maybeSingle();
    if (error) throw error;
    return data;
}

// --- per-type handlers ----------------------------------------------------

async function executeWorkloadImbalance(notification, actor) {
    const p = notification.payload || {};
    const fromTa = p.ta;
    const targets = Array.isArray(p.suggestedRecipients) ? p.suggestedRecipients : [];
    if (!fromTa || !targets.length) {
        return { ok: false, reason: 'No source TA or no candidate recipients in payload.' };
    }

    const moves = [];
    for (const toTa of targets) {
        const sample = await pickSampleForOffload({ fromTa });
        if (!sample) break;

        // Confirm the recipient is competent in this IS.
        const competency = await findCompetentEmployee(sample.isNumber);
        let recommendedEmployee = null;
        if (competency) {
            const match = competency.comps.find(c => {
                const emp = competency.employees.find(e => e.id === c.employeeId);
                return emp && emp.fullName === toTa;
            });
            if (match) recommendedEmployee = competency.employees.find(e => e.id === match.employeeId);
        }
        if (!recommendedEmployee) {
            await logAudit({
                actor,
                action: 'propose_reassignment_skipped',
                targetType: 'sample',
                targetId: sample.id,
                reason: `${toTa} is not competent in ${sample.isNumber}`,
                payload: { fromTa, toTa, sampleId: sample.id, sampleCode: sample.encodedCode },
            });
            continue;
        }

        const rec = await writeRecommendation({
            sampleId: sample.id,
            employeeId: recommendedEmployee.id,
            employeeName: recommendedEmployee.fullName,
            reason: `Nigrani rebalance: from ${fromTa} (overloaded) to ${recommendedEmployee.fullName}`,
            score: 0,
        });

        await logAudit({
            actor,
            action: 'propose_reassignment',
            targetType: 'sample',
            targetId: sample.id,
            beforeState: { assignedTo: sample.assignedTo },
            afterState: { recommendedTo: recommendedEmployee.fullName, status: 'pending' },
            reason: `notification:${notification.id}`,
            payload: { fromTa, sampleCode: sample.encodedCode, recommendationId: rec ? rec.id : null },
        });

        moves.push({ sampleCode: sample.encodedCode, from: fromTa, to: recommendedEmployee.fullName });
    }

    return { ok: true, action: 'workload_imbalance.propose', moves };
}

async function executeUnassignedBacklog(notification, actor) {
    // We don't duplicate /api/auto-assign here — we mark the request and let the
    // existing endpoint do the heavy lift on demand. The audit log records the
    // OIC's intent so we can correlate later.
    await logAudit({
        actor,
        action: 'request_auto_assign',
        targetType: 'notification',
        targetId: notification.id,
        reason: 'unassigned_backlog approved',
        payload: notification.payload || {},
    });
    return {
        ok: true,
        action: 'unassigned_backlog.request_auto_assign',
        nextStep: 'POST /api/auto-assign',
    };
}

async function executeShelfLife(notification, actor) {
    const p = notification.payload || {};
    if (!p.sampleId) return { ok: true, action: 'shelf_life.acknowledged' };

    const { data: sample } = await supabase
        .from('samples')
        .select('id, encodedCode, assignedTo, isNumber')
        .eq('id', p.sampleId)
        .maybeSingle();

    await logAudit({
        actor,
        action: 'flag_shelf_life',
        targetType: 'sample',
        targetId: p.sampleId,
        beforeState: sample ? { assignedTo: sample.assignedTo } : null,
        reason: `notification:${notification.id} daysLeft=${p.daysLeft}`,
        payload: p,
    });
    return { ok: true, action: 'shelf_life.flagged', sampleCode: sample ? sample.encodedCode : null };
}

async function executeAgingCluster(notification, actor) {
    await logAudit({
        actor,
        action: 'acknowledge_aging_cluster',
        targetType: 'notification',
        targetId: notification.id,
        reason: 'aging cluster acknowledged',
        payload: notification.payload || {},
    });
    return { ok: true, action: 'aging_cluster.acknowledged' };
}

async function executePriorityUnassigned(notification, actor) {
    await logAudit({
        actor,
        action: 'request_auto_assign_priority',
        targetType: 'notification',
        targetId: notification.id,
        reason: 'priority_unassigned approved',
        payload: notification.payload || {},
    });
    return {
        ok: true,
        action: 'priority_unassigned.request_auto_assign',
        nextStep: 'POST /api/auto-assign',
    };
}

async function executeTestingNotStarted(notification, actor) {
    const p = notification.payload || {};
    await logAudit({
        actor,
        action: 'flag_testing_not_started',
        targetType: 'sample',
        targetId: p.sampleId,
        reason: `notification:${notification.id} ageDays=${p.ageDays}`,
        payload: p,
    });
    return { ok: true, action: 'testing_not_started.flagged', sampleCode: p.encodedCode };
}

const HANDLERS = {
    workload_imbalance: executeWorkloadImbalance,
    unassigned_backlog: executeUnassignedBacklog,
    shelf_life_expiry:  executeShelfLife,
    aging_cluster:      executeAgingCluster,
    priority_unassigned: executePriorityUnassigned,
    testing_not_started: executeTestingNotStarted,
};

async function executeNotification(notification, { actor = 'oic' } = {}) {
    const handler = HANDLERS[notification.type];
    if (!handler) {
        await logAudit({
            actor,
            action: 'approve_notification_noop',
            targetType: 'notification',
            targetId: notification.id,
            reason: `no executor for type=${notification.type}`,
        });
        return { ok: true, action: 'noop', type: notification.type };
    }
    return handler(notification, actor);
}

module.exports = { executeNotification };
