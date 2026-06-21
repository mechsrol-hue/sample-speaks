// Disha Agent — Phase 2 executor
// When OIC approves a notification, executor performs the action.
// Every action writes to audit_log.
// NO action without approval.

const supabase = require('../../database-supabase');

async function recordAudit({
    actionType,
    actor = 'oic',
    targetType,
    targetId,
    beforeState,
    afterState,
    reason,
    sourceNotificationId,
}) {
    try {
        await supabase.from('audit_log').insert({
            action_type: actionType,
            actor,
            target_type: targetType,
            target_id: targetId,
            before_state: beforeState,
            after_state: afterState,
            reason,
            source_notification_id: sourceNotificationId,
        });
    } catch (err) {
        console.warn('[Disha executor] audit insert failed:', err.message);
    }
}

// --- Reassign a single sample ---
async function reassignSample(sampleId, fromTA, toTA, reason, notificationId) {
    const { data: sample, error: getErr } = await supabase
        .from('samples')
        .select('*')
        .eq('id', sampleId)
        .maybeSingle();

    if (getErr || !sample) {
        throw new Error(`Sample ${sampleId} not found`);
    }

    const before = { assignedTo: sample.assignedTo };
    const { error: updateErr } = await supabase
        .from('samples')
        .update({ assignedTo: toTA })
        .eq('id', sampleId);

    if (updateErr) throw updateErr;

    await recordAudit({
        actionType: 'reassign_sample',
        targetType: 'sample',
        targetId: String(sampleId),
        beforeState: before,
        afterState: { assignedTo: toTA },
        reason,
        sourceNotificationId: notificationId,
    });

    return { sampleId, from: fromTA, to: toTA };
}

// --- Run auto-assign, return recommendations ---
async function runAutoAssign(notificationId) {
    // Fetch unassigned samples
    const { data: unassigned, error: err1 } = await supabase
        .from('samples')
        .select('id, encodedCode, isNumber, priorityLevel, receivedOn')
        .or('assignedTo.is.null,assignedTo.eq.');

    if (err1 || !unassigned || !unassigned.length) {
        return { message: 'No unassigned samples found', count: 0 };
    }

    // Clear old pending recommendations
    await supabase.from('assignment_recommendations').delete().eq('status', 'pending');

    // Fetch data for scoring
    const [
        { data: employees },
        { data: competencies },
        { data: prefRows },
        { data: leavesToday },
        { data: allPending },
    ] = await Promise.all([
        supabase.from('employee_profiles').select('*'),
        supabase.from('employee_competencies').select('*'),
        supabase.from('system_preferences').select('*').like('key', 'template_%'),
        supabase
            .from('employee_leaves')
            .select('employeeId')
            .eq('leaveDate', new Date().toISOString().split('T')[0]),
        supabase.from('samples').select('assignedTo, isNumber').in('appStatus', ['Pending']),
    ]);

    // Build templates map
    const templates = {};
    (prefRows || []).forEach(p => {
        try {
            const val = JSON.parse(p.value);
            const baseKey = p.key.replace('template_', '');
            templates[baseKey] = val;
        } catch (_) {}
    });

    // Build competency map
    const compMap = {};
    (competencies || []).forEach(c => {
        if (!compMap[c.isNumber]) compMap[c.isNumber] = [];
        compMap[c.isNumber].push(c);
    });

    // Calculate current load
    const loadMap = {};
    (allPending || []).forEach(s => {
        if (s.assignedTo) {
            loadMap[s.assignedTo] = (loadMap[s.assignedTo] || 0) + 1;
        }
    });

    const onLeaveToday = new Set((leavesToday || []).map(l => l.employeeId));

    // Score each unassigned sample
    const recommendations = [];
    for (const sample of unassigned) {
        const matchingComps = compMap[sample.isNumber] || [];
        let bestEmployee = null;
        let bestScore = -Infinity;
        let bestReason = '';

        for (const comp of matchingComps) {
            const emp = (employees || []).find(e => e.id === comp.employeeId);
            if (!emp) continue;
            if (onLeaveToday.has(emp.id)) continue;

            const currentLoad = loadMap[emp.fullName] || 0;
            const maxLoad = emp.maxDailySamples || 40;
            const capacityScore = (maxLoad - currentLoad) * 2;

            let profMult = 1.0;
            if (comp.proficiencyLevel === 'Expert') profMult = 1.5;
            else if (comp.proficiencyLevel === 'Trainee') profMult = 0.6;

            const score = (10 * profMult) + capacityScore;

            if (score > bestScore) {
                bestScore = score;
                bestEmployee = emp;
                bestReason = `IS ${sample.isNumber} (${comp.proficiencyLevel}), Avail: ${maxLoad - currentLoad} slots`;
            }
        }

        if (bestEmployee) {
            loadMap[bestEmployee.fullName] = (loadMap[bestEmployee.fullName] || 0) + 1;
            recommendations.push({
                sampleId: sample.id,
                recommendedEmployeeId: bestEmployee.id,
                recommendedEmployeeName: bestEmployee.fullName,
                reason: bestReason,
                score: Math.round(bestScore * 100) / 100,
                status: 'pending',
            });
        }
    }

    // Insert recommendations
    if (recommendations.length) {
        const { error: insErr } = await supabase
            .from('assignment_recommendations')
            .insert(recommendations);
        if (insErr) console.warn('[Executor] recommendations insert failed:', insErr);
    }

    await recordAudit({
        actionType: 'run_auto_assign',
        targetType: 'batch',
        targetId: 'all_unassigned',
        afterState: { recommendationsGenerated: recommendations.length },
        reason: 'OIC triggered auto-assign',
        sourceNotificationId: notificationId,
    });

    return {
        message: `Generated ${recommendations.length} recommendations for ${unassigned.length} unassigned samples`,
        count: recommendations.length,
        recommendations,
    };
}

// --- Execute a notification (if it's executable) ---
async function executeNotification(notificationId, actorId = 'oic') {
    const { data: notif, error: getErr } = await supabase
        .from('lab_notifications')
        .select('*')
        .eq('id', notificationId)
        .maybeSingle();

    if (getErr || !notif) {
        throw new Error(`Notification ${notificationId} not found`);
    }

    if (notif.status !== 'approved') {
        throw new Error(`Notification must be approved first (current status: ${notif.status})`);
    }

    // Execute based on type
    let result = null;
    switch (notif.type) {
        case 'rebalance_proposal': {
            // notif.payload.moves = [{sampleId, from, to}, ...]
            const moves = (notif.payload && notif.payload.moves) || [];
            result = { executed_moves: [] };
            for (const move of moves) {
                try {
                    const moved = await reassignSample(
                        move.sampleId,
                        move.from,
                        move.to,
                        `Rebalance: ${move.from} → ${move.to}`,
                        notificationId
                    );
                    result.executed_moves.push(moved);
                } catch (err) {
                    console.warn(`[Executor] failed to move ${move.sampleId}:`, err.message);
                }
            }
            break;
        }
        case 'unassigned_backlog': {
            // Run auto-assign
            result = await runAutoAssign(notificationId);
            break;
        }
        default:
            throw new Error(`Notification type "${notif.type}" is not executable`);
    }

    // Mark notification as executed
    await supabase
        .from('lab_notifications')
        .update({ status: 'executed', acted_at: new Date().toISOString() })
        .eq('id', notificationId);

    return result;
}

module.exports = {
    recordAudit,
    reassignSample,
    runAutoAssign,
    executeNotification,
};
