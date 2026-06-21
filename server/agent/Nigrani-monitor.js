// Nigrani Agent — Phase 1 monitor.
//
// Responsibilities:
//   1. Maintain a 60s-cached lab snapshot (workload, samples, templates).
//      The chat endpoint can reuse the same snapshot to skip 200-400ms of
//      Supabase round-trips per turn.
//   2. Every 5 minutes, run the pure-JS rules engine against a fresh
//      snapshot and upsert the findings into lab_notifications.
//   3. Optionally call Gemini 2.5 Flash *only* to write a one-line body for
//      a brand-new finding (the title is already deterministic). Detection
//      is rules-based and never blocks on the LLM.

const supabase = require('../../database-supabase');
const { runRules } = require('./Nigrani-rules');

const SNAPSHOT_TTL_MS = 60_000;
const MONITOR_INTERVAL_MS = 5 * 60_000;

let cachedSnapshot = null;
let cachedAt = 0;
let inflightSnapshot = null;
let monitorTimer = null;

function normalizeIS(isNumber) {
    if (!isNumber) return '';
    return String(isNumber).trim().toUpperCase().replace(/\s+/g, ' ');
}

async function fetchSnapshot() {
    const now = Date.now();
    const [{ data: pending }, { data: employees }, { data: prefRows }] = await Promise.all([
        supabase.from('samples')
            .select('id, encodedCode, assignedTo, isNumber, priorityLevel, receivedOn, appStatus')
            .in('appStatus', ['Pending']),
        supabase.from('employee_profiles').select('fullName, designation, isActive'),
        supabase.from('system_preferences').select('key, value').like('key', 'template_%'),
    ]);

    const templates = {};
    (prefRows || []).forEach(p => {
        try {
            const val = JSON.parse(p.value);
            const baseKey = p.key.replace('template_', '');
            const normKey = normalizeIS(baseKey);
            templates[baseKey] = val;
            templates[normKey] = val;
        } catch (_) { /* ignore malformed template rows */ }
    });

    const activeTAs = (employees || [])
        .filter(e => e.isActive !== false)
        .map(e => e.fullName);

    const samples = pending || [];
    const loadHoursByTa = {};
    const sampleCountByTa = {};
    for (const s of samples) {
        if (!s.assignedTo) continue;
        sampleCountByTa[s.assignedTo] = (sampleCountByTa[s.assignedTo] || 0) + 1;
        const tmpl = templates[s.isNumber] || templates[normalizeIS(s.isNumber)];
        const hours = (tmpl && tmpl.totalHours) || 20;
        loadHoursByTa[s.assignedTo] = (loadHoursByTa[s.assignedTo] || 0) + hours;
    }

    return {
        now,
        samples,
        templates,
        activeTAs,
        loadHoursByTa,
        sampleCountByTa,
    };
}

async function getSnapshot({ force = false } = {}) {
    const now = Date.now();
    if (!force && cachedSnapshot && (now - cachedAt) < SNAPSHOT_TTL_MS) {
        return cachedSnapshot;
    }
    if (inflightSnapshot) return inflightSnapshot;
    inflightSnapshot = fetchSnapshot()
        .then(snap => {
            cachedSnapshot = snap;
            cachedAt = Date.now();
            return snap;
        })
        .finally(() => { inflightSnapshot = null; });
    return inflightSnapshot;
}

// --- Body generation -------------------------------------------------------
// The title is rules-derived. The body is one short sentence explaining
// WHY this matters and suggesting a next step. We try Gemini, but fall back
// to a deterministic line so monitor latency is bounded.
function fallbackBody(finding) {
    const p = finding.payload || {};
    switch (finding.rule) {
        case 'shelf_life_expiry':
            return p.daysLeft < 0
                ? `Sample ${p.encodedCode} is ${-p.daysLeft}d past its ${p.tatDays}d TAT. Consider expediting or escalating to ${p.assignedTo || 'an available TA'}.`
                : `Sample ${p.encodedCode} hits TAT in ${p.daysLeft}d. Confirm ${p.assignedTo || 'the assignee'} can finish in time.`;
        case 'workload_imbalance': {
            const targets = (p.suggestedRecipients || []).join(', ');
            return `${p.ta} is at ${p.load}${p.metric === 'hours' ? 'h' : ''} (${p.ratio}x median). ${targets ? `Consider rebalancing toward ${targets}.` : 'Consider rebalancing.'}`;
        }
        case 'aging_cluster':
            return `${p.count} samples aged >30d cluster on ${p.groupBy} ${p.key} (oldest ${p.oldestAge}d). Likely an equipment or competency bottleneck — check the source before assigning more work here.`;
        case 'unassigned_backlog':
            return `${p.count} samples are still unassigned; the oldest (${p.oldestCode || 'n/a'}) is ${p.oldestAge}d old. Run auto-assign or triage manually.`;
        default:
            return finding.title;
    }
}

async function generateBody(finding) {
    const key = process.env.GEMINI_API_KEY;
    if (!key || key.length < 10 || key.startsWith('sk_')) return fallbackBody(finding);

    try {
        const { GoogleGenAI } = require('@google/genai');
        const ai = new GoogleGenAI({ apiKey: key });
        const prompt = `You are Nigrani, the BIS lab co-pilot. Write ONE short sentence (<=180 chars) explaining why this finding matters and what the OIC should do next. Plainspoken, no preamble, no emojis.\n\nFinding: ${finding.title}\nData: ${JSON.stringify(finding.payload)}`;
        const resp = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            config: { temperature: 0.2, maxOutputTokens: 120, thinkingConfig: { thinkingBudget: 0 } },
        });
        const text = resp && resp.text ? resp.text.trim() : '';
        return text || fallbackBody(finding);
    } catch (_) {
        return fallbackBody(finding);
    }
}

// --- Persistence -----------------------------------------------------------
async function persistFindings(findings) {
    if (!findings.length) return { inserted: 0, refreshed: 0 };

    const { data: existing, error: exErr } = await supabase
        .from('lab_notifications')
        .select('id, dedupe_key, severity, title, payload')
        .eq('status', 'open')
        .in('dedupe_key', findings.map(f => f.dedupe_key));

    if (exErr) {
        console.warn('[Nigrani] persistFindings select failed:', exErr.message);
        return { inserted: 0, refreshed: 0 };
    }
    const existingByKey = new Map((existing || []).map(r => [r.dedupe_key, r]));

    let inserted = 0;
    let refreshed = 0;

    for (const f of findings) {
        const prior = existingByKey.get(f.dedupe_key);
        if (prior) {
            // Same finding still active — refresh the payload + title in case
            // counts moved. Don't touch status, snooze, or acted_*.
            const { error } = await supabase
                .from('lab_notifications')
                .update({
                    title: f.title,
                    payload: f.payload,
                    sample_ids: f.sample_ids,
                    severity: f.severity,
                })
                .eq('id', prior.id);
            if (!error) refreshed++;
            continue;
        }

        const body = await generateBody(f);
        const { error } = await supabase.from('lab_notifications').insert({
            type: f.rule,
            severity: f.severity,
            title: f.title,
            body,
            sample_ids: f.sample_ids,
            payload: f.payload,
            dedupe_key: f.dedupe_key,
            status: 'open',
        });
        if (!error) inserted++;
        else console.warn('[Nigrani] insert failed:', error.message);
    }

    return { inserted, refreshed };
}

async function runOnce({ force = false } = {}) {
    const started = Date.now();
    try {
        const snap = await getSnapshot({ force });
        const findings = runRules(snap);
        const stats = await persistFindings(findings);

        // Auto-expire snoozes whose time has come, so they re-surface.
        const nowIso = new Date().toISOString();
        await supabase.from('lab_notifications')
            .update({ status: 'open', snooze_until: null })
            .eq('status', 'snoozed')
            .lte('snooze_until', nowIso);

        console.log(`[Nigrani] monitor tick: ${findings.length} findings, ${stats.inserted} new, ${stats.refreshed} refreshed (${Date.now() - started}ms)`);
        return { findings: findings.length, ...stats };
    } catch (err) {
        console.error('[Nigrani] monitor tick failed:', err.message);
        return { error: err.message };
    }
}

function start() {
    if (monitorTimer) return;
    // Kick off a first tick shortly after boot so the bell isn't empty on
    // first paint, but not so soon that we block startup.
    setTimeout(() => { runOnce().catch(() => {}); }, 5000);
    monitorTimer = setInterval(() => { runOnce().catch(() => {}); }, MONITOR_INTERVAL_MS);
    // if (monitorTimer.unref) monitorTimer.unref();
    console.log(`[Nigrani] monitor started (tick every ${MONITOR_INTERVAL_MS / 60000}min, snapshot TTL ${SNAPSHOT_TTL_MS / 1000}s)`);
}

function stop() {
    if (monitorTimer) {
        clearInterval(monitorTimer);
        monitorTimer = null;
    }
}

module.exports = {
    start,
    stop,
    runOnce,
    getSnapshot,
};
