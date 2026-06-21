// Offline unit test for the hours model. No DB, no network — exercises the pure
// math (priors, RLS learning, batch decomposition, working-hours clock).
// Run: node server/ml/hours-model.test.js

const path = require('path');
const Module = require('module');

// Stub the supabase dependency so requiring the model does no network I/O.
const origResolve = Module._resolveFilename;
const dbPath = path.join(__dirname, '..', '..', 'database-supabase.js');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (parent && parent.filename === path.join(__dirname, 'hours-model.js') && request === '../../database-supabase') {
        return {}; // never used by the pure functions under test
    }
    return origLoad(request, parent, isMain);
};

const m = require('./hours-model');
const { initISState, rlsUpdate, buildSampleSpans, groupBatches } = m._internal;

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
}
function approx(a, b, tol = 0.5) { return Math.abs(a - b) <= tol; }

console.log('\n1. Prior decomposition');
{
    const p = m.priorFor({ totalHours: 20 });
    ok('setup = 35% of total', approx(p.setup, 7), `got ${p.setup}`);
    ok('marginal = 65% of total', approx(p.marginal, 13), `got ${p.marginal}`);
    ok('single sample == total', approx(p.setup + p.marginal, 20), `got ${p.setup + p.marginal}`);
}

console.log('\n2. Batch saving (prior, before any learning)');
{
    const model = m.emptyModel();
    model.isStates['IS 4985'] = initISState(m.priorFor({ totalHours: 20 }));
    const one = m.estimateBatchHours(model, 'IS 4985', 1);
    const five = m.estimateBatchHours(model, 'IS 4985', 5);
    ok('1 sample ≈ 20h', approx(one, 20), `got ${one}`);
    ok('5 samples < 5×20 (batch saving)', five < 100, `got ${five}`);
    ok('5 samples per-sample < single', five / 5 < one, `per-sample ${(five / 5).toFixed(1)} vs ${one}`);
    const firstPos = m.estimateSampleHours(model, { isNumber: 'IS 4985', batchPosition: 0 });
    const nextPos = m.estimateSampleHours(model, { isNumber: 'IS 4985', batchPosition: 2 });
    ok('first sample of IS pays setup+marginal', firstPos > nextPos, `first ${firstPos} vs next ${nextPos}`);
}

console.log('\n3. Online learning — RLS tracks observed reality');
{
    // Ground truth: setup=4h, marginal=2h. Feed noisy batch observations.
    const st = initISState(m.priorFor({ totalHours: 20 })); // wrong prior (setup7,marg13)
    const truthSetup = 4, truthMarg = 2;
    for (let i = 0; i < 60; i++) {
        const n = 1 + (i % 6);
        const noise = ((i * 37) % 7 - 3) * 0.1; // deterministic pseudo-noise
        rlsUpdate(st, n, truthSetup + n * truthMarg + noise);
    }
    ok('learned setup → ~4h', approx(st.theta[0], truthSetup, 1.5), `got ${st.theta[0].toFixed(2)}`);
    ok('learned marginal → ~2h', approx(st.theta[1], truthMarg, 1.0), `got ${st.theta[1].toFixed(2)}`);
}

console.log('\n4. Working-hours clock');
{
    // Wed 2026-06-10 14:00 -> Wed 2026-06-10 17:00 = 3 working hours.
    const a = new Date(2026, 5, 10, 14, 0, 0).getTime();
    const b = new Date(2026, 5, 10, 17, 0, 0).getTime();
    ok('same-day 14:00→17:00 = 3h', approx(m.workingHoursBetween(a, b), 3, 0.1), `got ${m.workingHoursBetween(a, b)}`);
    // Fri 17:00 -> Mon 10:00 should NOT count the weekend as 65h.
    const fri = new Date(2026, 5, 12, 17, 0, 0).getTime(); // Fri
    const mon = new Date(2026, 5, 15, 10, 0, 0).getTime(); // Mon
    const wh = m.workingHoursBetween(fri, mon);
    ok('Fri 17:00→Mon 10:00 excludes weekend', wh < 12, `got ${wh.toFixed(1)}h (would be ~65 wall)`);
}

console.log('\n5. Event reconstruction → batch grouping');
{
    const events = [
        { sampleId: 'A', isNumber: 'IS 4985', taName: 'Dinesh', event: 'testing_started', ts: '2026-06-10T09:00:00' },
        { sampleId: 'A', isNumber: 'IS 4985', taName: 'Dinesh', event: 'submitted', ts: '2026-06-10T12:00:00' },
        { sampleId: 'B', isNumber: 'IS 4985', taName: 'Dinesh', event: 'testing_started', ts: '2026-06-10T09:30:00' },
        { sampleId: 'B', isNumber: 'IS 4985', taName: 'Dinesh', event: 'submitted', ts: '2026-06-10T12:30:00' },
        { sampleId: 'C', isNumber: 'IS 2185', taName: 'Asha', event: 'assigned', ts: '2026-06-11T09:00:00' },
        { sampleId: 'C', isNumber: 'IS 2185', taName: 'Asha', event: 'submitted', ts: '2026-06-11T15:00:00' },
    ];
    const spans = buildSampleSpans(events);
    ok('3 valid spans reconstructed', spans.length === 3, `got ${spans.length}`);
    const batches = groupBatches(spans);
    const dineshBatch = batches.find(b => String(b.taName).toLowerCase() === 'dinesh');
    ok('Dinesh 2 same-IS same-day → 1 batch of 2', dineshBatch && dineshBatch.n === 2, `got ${dineshBatch && dineshBatch.n}`);
    ok('batch wall-hours computed', dineshBatch && dineshBatch.wallHours > 0, `got ${dineshBatch && dineshBatch.wallHours}`);
}

console.log('\n6. Full train pass updates model + TA factors');
{
    const model = m.emptyModel();
    const templates = { 'IS 4985': { totalHours: 15 }, 'IS 2185': { totalHours: 17 } };
    const events = [];
    // 20 days of Dinesh doing IS 4985 fast (batches of 3, ~6h wall => very efficient)
    for (let d = 0; d < 20; d++) {
        const day = `2026-06-${String((d % 27) + 1).padStart(2, '0')}`;
        for (let s = 0; s < 3; s++) {
            events.push({ sampleId: `D${d}_${s}`, isNumber: 'IS 4985', taName: 'Dinesh', event: 'testing_started', ts: `${day}T09:00:00` });
            events.push({ sampleId: `D${d}_${s}`, isNumber: 'IS 4985', taName: 'Dinesh', event: 'submitted', ts: `${day}T15:00:00` });
        }
    }
    const sum = m.trainFromEvents(model, events, templates);
    ok('batches detected', sum.batches >= 18, `got ${sum.batches}`);
    ok('IS 4985 state exists', !!model.isStates['IS 4985'], '');
    ok('Dinesh profiled', !!model.taFactors['dinesh'], '');
    const est5 = m.estimateBatchHours(model, 'IS 4985', 5, templates);
    ok('batch-of-5 estimate is finite & < 5×15', est5 > 0 && est5 < 75, `got ${est5.toFixed(1)}`);
}

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`);
Module._load = origLoad;
process.exit(fail === 0 ? 0 : 1);
