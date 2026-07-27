// Disha Agent — Phase 3 utilities
// Name normalisation, preference management, helper functions

const supabase = require('../../database-supabase');

function normalizeTaName(rawName) {
    if (!rawName || rawName === 'UNASSIGNED') return 'UNASSIGNED';
    // Trim, collapse whitespace, dedupe trailing tokens, casefold for grouping only
    const trimmed = String(rawName).trim();
    const tokens = trimmed.split(/\s+/);
    // Remove duplicated trailing tokens (e.g., "Dangale Dangale" → "Dangale")
    while (tokens.length > 1 && tokens[tokens.length - 1] === tokens[tokens.length - 2]) {
        tokens.pop();
    }
    return tokens.join(' ');
}

function normalizeIS(rawIs) {
    if (!rawIs) return '';
    return String(rawIs).trim().toUpperCase().replace(/\s+/g, ' ');
}

async function getOicPreferences() {
    try {
        const { data: prefs } = await supabase
            .from('oic_preferences')
            .select('key, value');

        const map = {};
        (prefs || []).forEach(p => {
            try {
                map[p.key] = typeof p.value === 'string' ? JSON.parse(p.value) : p.value;
            } catch (_) {
                map[p.key] = p.value;
            }
        });
        return map;
    } catch (err) {
        console.warn('[Disha utils] getOicPreferences failed:', err.message);
        return {};
    }
}

module.exports = {
    normalizeTaName,
    normalizeIS,
    getOicPreferences,
};
