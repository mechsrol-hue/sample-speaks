// Nigrani Agent — small shared helpers.

const supabase = require('../../database-supabase');

function normalizeTaName(raw) {
    if (!raw) return '';
    let s = String(raw).trim().replace(/\s+/g, ' ');
    // Collapse a duplicated trailing token: "Dangale Dangale" -> "Dangale".
    const parts = s.split(' ');
    while (parts.length >= 2 && parts[parts.length - 1].toLowerCase() === parts[parts.length - 2].toLowerCase()) {
        parts.pop();
    }
    s = parts.join(' ');
    return s;
}

function taKey(raw) {
    return normalizeTaName(raw).toLowerCase();
}

function normalizeIS(isNumber) {
    if (!isNumber) return '';
    return String(isNumber).trim().toUpperCase().replace(/\s+/g, ' ');
}

async function logAudit({ actor = 'Nigrani', action, targetType = null, targetId = null, beforeState = null, afterState = null, reason = null, payload = {} }) {
    try {
        await supabase.from('Nigrani_audit_log').insert({
            actor,
            action,
            target_type: targetType,
            target_id: targetId == null ? null : String(targetId),
            before_state: beforeState,
            after_state: afterState,
            reason,
            payload,
        });
    } catch (err) {
        console.warn('[Nigrani audit] insert failed:', err.message);
    }
}

async function getOicPreferences() {
    try {
        const { data, error } = await supabase
            .from('Nigrani_oic_preferences')
            .select('key, value, note');
        if (error || !data) return {};
        const out = {};
        for (const row of data) out[row.key] = row.value;
        return out;
    } catch (_) { return {}; }
}

module.exports = { normalizeTaName, taKey, normalizeIS, logAudit, getOicPreferences };
