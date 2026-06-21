// ============================================================================
// Local ML — per-IS testing-hours model with batch decomposition.
//
// WHY THIS EXISTS
//   BIS testing-charge PDFs give ONE theoretical man-hour figure per IS. Reality
//   differs because (a) loading several samples of the same IS together shares
//   fixed setup (calibration, machine warm-up, report prep), so per-sample cost
//   drops with batch size; (b) different product grades exercise different clause
//   subsets; (c) some labs/TAs are faster. A flat number can never match all three.
//
// MODEL
//   For a batch of n same-IS samples handled together by one TA:
//       wallHours(n)  ≈  setup_IS  +  n · marginal_IS
//   We learn (setup_IS, marginal_IS) per standard ONLINE via recursive least
//   squares (RLS) with a forgetting factor, shrunk toward a BIS-derived prior so
//   it behaves sensibly with zero or very little data and adapts as data arrives.
//   A per-TA proficiency factor (shrunk toward 1.0) scales the estimate.
//
//   Everything is pure JS — no Python, no cloud, no network. The trained model is
//   a small JSON blob persisted in system_preferences (key `ml_hours_model`).
//
// PUBLIC API
//   loadModel()                              -> model object (cold-starts if absent)
//   saveModel(model)                         -> persist to system_preferences
//   priorFor(template)                       -> {setup, marginal} from a BIS template
//   estimateSampleHours(model, opts)         -> hours for ONE sample given batch position
//   estimateBatchHours(model, isNumber, n)   -> wall hours for a batch of n
//   trainFromEvents(model, events, opts)     -> update model from lifecycle events
//   rebuildFromHistory()                     -> pull events from DB and retrain end-to-end
// ============================================================================

const supabase = require('../../database-supabase');

const MODEL_KEY = 'ml_hours_model';
const EVENT_LOG_KEY = 'ml_event_log';

// --- Tunables ---------------------------------------------------------------
const SETUP_FRACTION = 0.35;   // prior: 35% of a single test is fixed setup
const FORGETTING = 0.985;      // RLS forgetting factor (slowly tracks drift)
const PRIOR_STRENGTH = 4;      // pseudo-observations anchoring RLS to the prior
const TA_PRIOR_STRENGTH = 5;   // shrinkage for per-TA proficiency factor
const DEFAULT_TOTAL_HOURS = 20;
const WORK_START = 9;          // working day 09:00
const WORK_END = 18;           //              18:00  (9h/day)
const WORK_DAYS = [1, 2, 3, 4, 5, 6]; // Mon–Sat (Sun off) — BIS labs run 6 days

function normalizeIS(isNumber) {
    if (!isNumber) return '';
    let s = String(isNumber).toUpperCase();
    const m = s.match(/IS\s*\d+/);
    return (m ? m[0].replace(/\s+/g, ' ') : s.trim()).replace(/\s+/g, ' ');
}

// ----------------------------------------------------------------------------
// Working-hours clock — turns two timestamps into elapsed *working* hours so a
// sample received Friday and finished Monday isn't scored as 72h of effort.
// ----------------------------------------------------------------------------
function workingHoursBetween(startMs, endMs) {
    if (!(endMs > startMs)) return 0;
    const perDay = WORK_END - WORK_START;
    let hours = 0;
    const cur = new Date(startMs);
    const end = new Date(endMs);
    // Iterate day by day; cheap because spans are days, not years.
    while (cur < end) {
        const dow = cur.getDay();
        if (WORK_DAYS.includes(dow)) {
            const dayStart = new Date(cur); dayStart.setHours(WORK_START, 0, 0, 0);
            const dayEnd = new Date(cur); dayEnd.setHours(WORK_END, 0, 0, 0);
            const segStart = Math.max(cur.getTime(), dayStart.getTime());
            const segEnd = Math.min(end.getTime(), dayEnd.getTime());
            if (segEnd > segStart) hours += (segEnd - segStart) / 3600000;
        }
        // advance to next midnight
        cur.setDate(cur.getDate() + 1);
        cur.setHours(0, 0, 0, 0);
    }
    return Math.min(hours, perDay * 30); // sanity cap
}

// ----------------------------------------------------------------------------
// Prior: split a BIS single-sample total into setup + marginal.
//   single sample (n=1): setup + marginal = total
//   => setup = f·total,  marginal = (1-f)·total
// ----------------------------------------------------------------------------
function priorFor(template) {
    const total = (template && Number(template.totalHours)) > 0 ? Number(template.totalHours) : DEFAULT_TOTAL_HOURS;
    return { setup: SETUP_FRACTION * total, marginal: (1 - SETUP_FRACTION) * total, total };
}

// RLS state for one IS: theta=[setup, marginal], P=2x2 covariance, n observations.
function initISState(prior) {
    // Anchor with PRIOR_STRENGTH pseudo-points: a single-sample point (1, total)
    // and a small-batch point so both params are identifiable from the start.
    const setup0 = prior.setup, marg0 = prior.marginal;
    return {
        theta: [setup0, marg0],
        // Covariance: smaller => more confident in prior. Scale by total so units sane.
        P: [[Math.pow(prior.total, 2) / PRIOR_STRENGTH, 0], [0, Math.pow(prior.total, 2) / PRIOR_STRENGTH]],
        n: 0,
        prior: { setup: setup0, marginal: marg0, total: prior.total },
    };
}

// One RLS update with input x=[1, n], target y=observed batch wall-hours.
function rlsUpdate(state, n, y) {
    const x = [1, n];
    const P = state.P, th = state.theta;
    // Px = P·x
    const Px = [P[0][0] * x[0] + P[0][1] * x[1], P[1][0] * x[0] + P[1][1] * x[1]];
    const xtPx = x[0] * Px[0] + x[1] * Px[1];
    const denom = FORGETTING + xtPx;
    const K = [Px[0] / denom, Px[1] / denom];           // gain
    const yhat = th[0] * x[0] + th[1] * x[1];
    const err = y - yhat;
    state.theta = [th[0] + K[0] * err, th[1] + K[1] * err];
    // P = (P - K·xᵀ·P) / FORGETTING
    const KxP = [
        [K[0] * Px[0], K[0] * Px[1]],
        [K[1] * Px[0], K[1] * Px[1]],
    ];
    state.P = [
        [(P[0][0] - KxP[0][0]) / FORGETTING, (P[0][1] - KxP[0][1]) / FORGETTING],
        [(P[1][0] - KxP[1][0]) / FORGETTING, (P[1][1] - KxP[1][1]) / FORGETTING],
    ];
    state.n += 1;
    // Guard rails: keep params physical (no negative time, marginal ≤ setup+marginal).
    if (state.theta[0] < 0) state.theta[0] = 0;
    if (state.theta[1] < 0.05) state.theta[1] = 0.05;
    return state;
}

// ----------------------------------------------------------------------------
// Model container
// ----------------------------------------------------------------------------
function emptyModel() {
    return {
        version: 2,
        updatedAt: null,
        isStates: {},        // normIS -> RLS state
        taFactors: {},       // taKey -> { factor, n }  (proficiency multiplier)
        trainedEvents: 0,
    };
}

async function loadTemplates() {
    const { data } = await supabase.from('system_preferences').select('key, value').like('key', 'template_IS%');
    const out = {};
    (data || []).forEach(r => {
        try {
            const v = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
            out[normalizeIS(r.key.replace('template_', ''))] = v;
        } catch (_) { /* skip malformed */ }
    });
    return out;
}

async function loadModel() {
    const { data } = await supabase.from('system_preferences').select('value').eq('key', MODEL_KEY).maybeSingle();
    if (data && data.value) {
        try { return typeof data.value === 'string' ? JSON.parse(data.value) : data.value; } catch (_) {}
    }
    return emptyModel();
}

async function saveModel(model) {
    model.updatedAt = new Date().toISOString();
    await supabase.from('system_preferences').upsert(
        { key: MODEL_KEY, value: JSON.stringify(model) }, { onConflict: 'key' }
    );
    return model;
}

// Ensure an IS has an RLS state, cold-starting from its BIS prior.
function ensureISState(model, normIS, templates) {
    if (!model.isStates[normIS]) {
        const tmpl = templates ? templates[normIS] : null;
        model.isStates[normIS] = initISState(priorFor(tmpl));
    }
    return model.isStates[normIS];
}

// ----------------------------------------------------------------------------
// Estimation
// ----------------------------------------------------------------------------
function taFactorFor(model, taName) {
    const key = String(taName || '').trim().toLowerCase();
    const f = model.taFactors[key];
    return f && f.factor > 0 ? f.factor : 1.0;
}

// Hours for ONE sample given its position in a same-IS batch being assigned to a
// TA. Position 0 (first of its IS for this TA) pays setup+marginal; the rest pay
// only marginal — this is the batch saving the lab actually experiences.
function estimateSampleHours(model, { isNumber, batchPosition = 0, taName = null, templates = null }) {
    const normIS = normalizeIS(isNumber);
    const st = model.isStates[normIS] || initISState(priorFor(templates ? templates[normIS] : null));
    const setup = st.theta[0], marginal = st.theta[1];
    const base = batchPosition === 0 ? setup + marginal : marginal;
    const hours = base * taFactorFor(model, taName);
    return Math.max(0.25, Math.round(hours * 100) / 100);
}

// Wall hours for a whole batch of n same-IS samples: setup + n·marginal.
function estimateBatchHours(model, isNumber, n, templates = null) {
    const normIS = normalizeIS(isNumber);
    const st = model.isStates[normIS] || initISState(priorFor(templates ? templates[normIS] : null));
    return Math.max(0.25, st.theta[0] + Math.max(1, n) * st.theta[1]);
}

// ----------------------------------------------------------------------------
// Training from lifecycle events.
// events: [{ sampleId, isNumber, taName, event, ts }]
//   event ∈ {'assigned','testing_started','submitted'}
// We reconstruct each sample's (start, end) then group concurrent same-(TA,IS)
// samples into batches and feed (n, batchWallHours) into the RLS.
// ----------------------------------------------------------------------------
function buildSampleSpans(events) {
    const bySample = {};
    for (const e of events) {
        const id = String(e.sampleId);
        if (!bySample[id]) bySample[id] = { isNumber: e.isNumber, taName: e.taName, marks: {} };
        if (e.isNumber) bySample[id].isNumber = e.isNumber;
        if (e.taName) bySample[id].taName = e.taName;
        const t = Date.parse(e.ts);
        if (Number.isFinite(t)) bySample[id].marks[e.event] = t;
    }
    const spans = [];
    for (const [id, s] of Object.entries(bySample)) {
        const start = s.marks.testing_started || s.marks.assigned;
        const end = s.marks.submitted;
        if (!start || !end || end <= start) continue;
        spans.push({ sampleId: id, isNumber: normalizeIS(s.isNumber), taName: s.taName, start, end });
    }
    return spans;
}

// Group spans into batches: same TA, same IS, overlapping or same-day windows.
function groupBatches(spans) {
    const byKey = {};
    for (const sp of spans) {
        const day = new Date(sp.start); day.setHours(0, 0, 0, 0);
        const k = `${String(sp.taName || '').toLowerCase()}::${sp.isNumber}::${day.getTime()}`;
        (byKey[k] = byKey[k] || []).push(sp);
    }
    return Object.values(byKey).map(group => {
        const start = Math.min(...group.map(g => g.start));
        const end = Math.max(...group.map(g => g.end));
        return {
            isNumber: group[0].isNumber,
            taName: group[0].taName,
            n: group.length,
            wallHours: workingHoursBetween(start, end) || (group.length * 0.5),
            spans: group,
        };
    });
}

function trainFromEvents(model, events, templates) {
    const spans = buildSampleSpans(events);
    const batches = groupBatches(spans);
    for (const b of batches) {
        if (!b.isNumber) continue;
        const st = ensureISState(model, b.isNumber, templates);
        rlsUpdate(st, b.n, b.wallHours);

        // Per-TA proficiency: ratio of observed to model-predicted batch hours,
        // shrunk toward 1.0 so a single fast/slow batch doesn't swing it wildly.
        const predicted = st.theta[0] + b.n * st.theta[1];
        if (predicted > 0) {
            const ratio = b.wallHours / predicted;
            const key = String(b.taName || '').trim().toLowerCase();
            if (key) {
                const cur = model.taFactors[key] || { factor: 1.0, n: 0 };
                const w = cur.n + 1;
                cur.factor = (TA_PRIOR_STRENGTH * 1.0 + cur.factor * cur.n + ratio) / (TA_PRIOR_STRENGTH + w);
                cur.factor = Math.min(2.0, Math.max(0.4, cur.factor)); // clamp sane band
                cur.n = w;
                model.taFactors[key] = cur;
            }
        }
    }
    model.trainedEvents = (model.trainedEvents || 0) + events.length;
    return { batches: batches.length, spans: spans.length };
}

// ----------------------------------------------------------------------------
// Event log helpers (stored in system_preferences as a JSON array).
// Kept append-only and bounded so it never grows unbounded.
// ----------------------------------------------------------------------------
const MAX_EVENTS = 20000;

// The event log is a single JSON-array row, so a naive read-modify-write loses
// events when two requests interleave (both read the same baseline, both push,
// the second upsert clobbers the first). The server is a single Node process, so
// we serialize every append through an in-process promise chain — each append
// waits for the previous one to finish its read+write before starting its own.
// (Multi-process deployments would still need a DB-side atomic append.)
let _appendChain = Promise.resolve();

function appendEvent(evt) {
    const run = async () => {
        try {
            const { data } = await supabase.from('system_preferences').select('value').eq('key', EVENT_LOG_KEY).maybeSingle();
            let log = [];
            if (data && data.value) { try { log = JSON.parse(data.value); } catch (_) {} }
            log.push({ ts: new Date().toISOString(), ...evt });
            if (log.length > MAX_EVENTS) log = log.slice(-MAX_EVENTS);
            await supabase.from('system_preferences').upsert({ key: EVENT_LOG_KEY, value: JSON.stringify(log) }, { onConflict: 'key' });
        } catch (err) {
            console.warn('[ml] appendEvent failed:', err.message);
        }
    };
    // Chain regardless of prior outcome so one failure doesn't stall the queue.
    _appendChain = _appendChain.then(run, run);
    return _appendChain;
}

async function loadEvents() {
    const { data } = await supabase.from('system_preferences').select('value').eq('key', EVENT_LOG_KEY).maybeSingle();
    if (data && data.value) { try { return JSON.parse(data.value); } catch (_) {} }
    return [];
}

// Full retrain from the persisted event log + current templates. Safe to call
// nightly or after a batch of submissions. Returns a small summary.
async function rebuildFromHistory() {
    const [templates, events] = await Promise.all([loadTemplates(), loadEvents()]);
    const model = emptyModel();
    // Cold-start every known IS from its prior so estimates exist before any data.
    for (const normIS of Object.keys(templates)) ensureISState(model, normIS, templates);
    const summary = trainFromEvents(model, events, templates);
    await saveModel(model);
    return {
        ...summary,
        events: events.length,
        standardsModeled: Object.keys(model.isStates).length,
        tasProfiled: Object.keys(model.taFactors).length,
    };
}

module.exports = {
    normalizeIS,
    workingHoursBetween,
    priorFor,
    emptyModel,
    loadModel,
    saveModel,
    loadTemplates,
    estimateSampleHours,
    estimateBatchHours,
    trainFromEvents,
    appendEvent,
    loadEvents,
    rebuildFromHistory,
    // exported for tests
    _internal: { initISState, rlsUpdate, buildSampleSpans, groupBatches },
};
