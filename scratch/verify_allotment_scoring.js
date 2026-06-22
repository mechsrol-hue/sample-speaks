// Standalone verification of the allotment ordering + urgency logic in
// POST /api/auto-assign. Pure functions, no DB. Mirrors server.js so we can
// assert the HYBRID ordering (overdue-first, else strict FIFO) and the urgency
// math without a live lab.

const today = new Date();
function normalizeISNumber(s) { return String(s || '').toUpperCase().replace(/\s+/g, ' ').trim(); }

const templates = {
    'IS A': { tatDays: 3 },   // short shelf-life
    'IS B': { tatDays: 60 },  // generous TAT
    'IS C': { tatDays: 7 },
};

const parsePendency = (s) => (s.pendencyDays != null ? s.pendencyDays : 0);
const getTatDays = (s) => {
    const tmpl = templates[s.isNumber] || templates[normalizeISNumber(s.isNumber)];
    return (tmpl && tmpl.tatDays) || 7;
};
const daysToExpiry = (s) => getTatDays(s) - parsePendency(s);
const isPrioritySample = (s) => (s.priorityLevel || '').toLowerCase() === 'priority' || (s.encodedCode || '').toLowerCase().endsWith('p');

// HYBRID: overdue samples first (most overdue first); everything else strict FIFO (oldest first).
const byOverdueThenFifo = (a, b) => {
    const da = daysToExpiry(a), db = daysToExpiry(b);
    const aOver = da < 0, bOver = db < 0;
    if (aOver !== bOver) return aOver ? -1 : 1;
    if (aOver && bOver && da !== db) return da - db;
    return parsePendency(b) - parsePendency(a);
};

function urgency(sample) {
    const pendencyDays = parsePendency(sample);
    const tatDays = getTatDays(sample);
    const daysLeft = tatDays - pendencyDays;
    let deadlineBoost = 0, deadlineTag = '';
    if (daysLeft < 0) { deadlineBoost = 300 + Math.min(300, (-daysLeft) * 20); deadlineTag = `🔴 PAST TAT by ${-daysLeft}d (TAT ${tatDays}d)`; }
    else if (daysLeft <= 2) { deadlineBoost = 200; deadlineTag = `⚠️ EXPIRES in ${daysLeft}d (TAT ${tatDays}d)`; }
    else if (daysLeft <= 5) { deadlineBoost = 80; deadlineTag = `🔥 DUE SOON — ${daysLeft}d to TAT`; }

    let ageBoost = 0, ageTag = '';
    if (pendencyDays > 60) { ageBoost = 500; ageTag = '🔴 PENDING 60+ DAYS'; }
    else if (pendencyDays > 30) { ageBoost = 200; ageTag = '⚠️ PENDING 30+ DAYS'; }
    else if (pendencyDays > 14) { ageBoost = 80; ageTag = '🔥 PENDING 14+ DAYS'; }
    else { ageBoost = Math.max(0, pendencyDays * 2); }

    return { urgencyBoost: Math.max(deadlineBoost, ageBoost), urgencyTag: deadlineBoost >= ageBoost ? deadlineTag : ageTag };
}

let pass = 0, fail = 0;
const check = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`${ok ? '✅' : '❌'} ${label}\n     got : ${JSON.stringify(got)}\n     want: ${JSON.stringify(want)}`);
    ok ? pass++ : fail++;
};

// ── Test 1: overdue jumps the queue; the rest are strict FIFO (req d + e) ─────
// A5 is 2d overdue -> first. The remaining three are all within TAT, so they go
// strict oldest-first (FIFO) by pendency, NOT by how tight their TAT is.
const t1 = [
    { id: 'B20', isNumber: 'IS B', pendencyDays: 20 },  // dte +40, age 20
    { id: 'A5',  isNumber: 'IS A', pendencyDays: 5  },  // dte -2  (OVERDUE)
    { id: 'A1',  isNumber: 'IS A', pendencyDays: 1  },  // dte +2, age 1 (tight TAT but not overdue)
    { id: 'B50', isNumber: 'IS B', pendencyDays: 50 },  // dte +10, age 50 (oldest)
].sort(byOverdueThenFifo).map(s => s.id);
check('Test 1 — overdue first, then strict FIFO', t1, ['A5', 'B50', 'B20', 'A1']);

// ── Test 2: among non-overdue, strict FIFO ignores tighter TAT (req d) ───────
const t2 = [
    { id: 'X_tight_new', isNumber: 'IS A', pendencyDays: 1 },  // tat 3, dte +2, newest
    { id: 'Y_loose_old', isNumber: 'IS B', pendencyDays: 10 }, // tat 60, dte +50, oldest
].sort(byOverdueThenFifo).map(s => s.id);
check('Test 2 — non-overdue is pure FIFO (oldest first)', t2, ['Y_loose_old', 'X_tight_new']);

// ── Test 3: among overdue, most overdue first; FIFO breaks exact ties ─────────
const t3 = [
    { id: 'A5',  isNumber: 'IS A', pendencyDays: 5  }, // tat 3 -> dte -2
    { id: 'A10', isNumber: 'IS A', pendencyDays: 10 }, // tat 3 -> dte -7 (most overdue)
    { id: 'C9',  isNumber: 'IS C', pendencyDays: 9  }, // tat 7 -> dte -2 (ties A5, but older)
].sort(byOverdueThenFifo).map(s => s.id);
check('Test 3 — most overdue first, FIFO tiebreak', t3, ['A10', 'C9', 'A5']);

// ── Test 4: priority bucket processed before non-priority (req g) ────────────
const samples4 = [
    { id: 'NP_overdue', isNumber: 'IS A', pendencyDays: 10, priorityLevel: 'Non-Priority' }, // overdue
    { id: 'P_slack',    isNumber: 'IS B', pendencyDays: 1,  priorityLevel: 'Priority' },      // tons of slack
];
const pq = samples4.filter(isPrioritySample).sort(byOverdueThenFifo);
const npq = samples4.filter(s => !isPrioritySample(s)).sort(byOverdueThenFifo);
check('Test 4 — priority first even vs an overdue non-priority', [...pq, ...npq].map(s => s.id), ['P_slack', 'NP_overdue']);

// ── Test 5: urgency = max(deadline, age); expiry now drives it ───────────────
check('Test 5a — overdue short-TAT escalates via deadline',
    urgency({ isNumber: 'IS A', pendencyDays: 5 }),
    { urgencyBoost: 340, urgencyTag: '🔴 PAST TAT by 2d (TAT 3d)' });
check('Test 5b — long-waiting generous-TAT still escalates via age backstop',
    urgency({ isNumber: 'IS B', pendencyDays: 20 }),
    { urgencyBoost: 80, urgencyTag: '🔥 PENDING 14+ DAYS' });
check('Test 5c — about-to-expire flagged',
    urgency({ isNumber: 'IS A', pendencyDays: 1 }),
    { urgencyBoost: 200, urgencyTag: '⚠️ EXPIRES in 2d (TAT 3d)' });

console.log(`\n${fail === 0 ? '🎉 ALL PASS' : '💥 FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
