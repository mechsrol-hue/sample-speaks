#!/usr/bin/env node
/**
 * Generate public/is_templates/IS_694_2010.json from the verified table data of
 * IS 694:2010 (+ Amd 1 & 2). Tables 3-10 were transcribed from pdftotext AND verified
 * against 300-dpi page renders (printed cells authoritative — including the odd printed
 * single-core ts 2.4 at 70 mm² in Table 5 and the two-decimal ODs 15.47/17.69 in Table 6).
 * Combinations the printed tables leave blank get an explicit "not offered" cell —
 * never a computed number.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');

const SIZES = [0.5, 0.75, 1.0, 1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120, 150, 185, 240, 300, 400, 500, 630];
const CORES = Array.from({ length: 25 }, (_, i) => i + 1);
const NOT_OFFERED = 'Not specified in IS (combination not offered)';

// ── Table 3: single-core unsheathed rigid — ti by size; OD by size|class ──
const T3 = [
  // [size, class, ti, odMax]
  [0.5, 1, 0.6, 2.3], [0.75, 1, 0.6, 2.5], [1.0, 1, 0.6, 2.7],
  [1.5, 1, 0.7, 3.2], [1.5, 2, 0.7, 3.3], [2.5, 1, 0.8, 3.9], [2.5, 2, 0.8, 4.0],
  [4, 1, 0.8, 4.4], [4, 2, 0.8, 4.6], [6, 1, 0.8, 5.0], [6, 2, 0.8, 5.2],
  [10, 1, 1.0, 6.4], [10, 2, 1.0, 6.7], [16, 2, 1.0, 7.8], [25, 2, 1.2, 9.7],
  [35, 2, 1.2, 10.9], [50, 2, 1.4, 12.8], [70, 2, 1.4, 14.6], [95, 2, 1.6, 17.1],
  [120, 2, 1.6, 18.8], [150, 2, 1.8, 20.9], [185, 2, 2.0, 23.3], [240, 2, 2.2, 26.6],
  [300, 2, 2.4, 29.6], [400, 2, 2.6, 33.2], [500, 2, 2.8, 37.5], [630, 2, 3.0, 42],
];

// ── Table 4: single-core unsheathed flexible (Class 5) — by size ──
const T4 = [
  [0.5, 0.6, 2.6], [0.75, 0.6, 2.8], [1.0, 0.6, 3.0], [1.5, 0.7, 3.4], [2.5, 0.8, 4.1],
  [4, 0.8, 4.8], [6, 0.8, 5.3], [10, 1.0, 7.0], [16, 1.0, 8.1], [25, 1.2, 10.2],
  [35, 1.2, 11.7], [50, 1.4, 13.9], [70, 1.4, 16.0], [95, 1.6, 18.2], [120, 1.6, 20.2],
  [150, 1.8, 22.5], [185, 2.0, 24.9], [240, 2.2, 28.4], [300, 2.4, 31.0],
];

// ── Table 5: rigid sheathed, cores 1-4, sizes 1.0-120 ──
const T5 = [
  // [size, ti, ts1..ts4, od1..od4]
  [1.0, 0.6, [0.8, 0.9, 0.9, 0.9], [4.7, 8.2, 8.6, 9.2]],
  [1.5, 0.6, [0.8, 0.9, 0.9, 0.9], [5.0, 8.8, 9.2, 10.0]],
  [2.5, 0.7, [0.8, 1.0, 1.0, 1.0], [5.8, 10.5, 11.0, 12.0]],
  [4, 0.8, [0.9, 1.0, 1.1, 1.1], [6.8, 12.0, 13.0, 14.0]],
  [6, 0.8, [0.9, 1.1, 1.1, 1.2], [7.8, 13.5, 14.5, 15.5]],
  [10, 1.0, [0.9, 1.2, 1.2, 1.3], [8.8, 16.5, 17.5, 19.5]],
  [16, 1.0, [1.0, 1.3, 1.3, 1.4], [10.5, 19.0, 20.0, 22.5]],
  [25, 1.2, [1.1, 1.4, 1.5, 1.6], [12.5, 23.0, 24.5, 27.5]],
  [35, 1.2, [1.1, 1.5, 1.6, 1.7], [13.5, 25.5, 27.5, 30.5]],
  [50, 1.4, [1.2, 1.6, 1.7, 1.8], [15.5, 29.5, 31.5, 35.0]],
  [70, 1.4, [2.4, 2.4, 2.5, 2.8], [17.5, 35.0, 37.0, 41.4]],
  [95, 1.6, [1.5, 2.7, 2.9, 3.1], [21.0, 40.5, 43.2, 48.1]],
  [120, 1.6, [1.5, 2.9, 3.1, 3.4], [22.5, 44.0, 47.3, 52.8]],
];

// ── Table 6: flexible sheathed cables, cores 1-5, sizes 4-300 (null = printed blank) ──
const T6 = [
  [4, 0.8, [1, 1, 1, 1, 1.1], [6.8, 11.6, 12.4, 13.6, 15.3]],
  [6, 0.8, [1.1, 1.1, 1.2, 1.2, null], [7.5, 13.0, 13.8, 15.47, null]],
  [10, 1, [1.3, 1.3, 1.4, 1.4, null], [9.4, 16.5, 17.69, 19.5, null]],
  [16, 1, [1.4, 1.4, 1.4, 1.4, null], [10.9, 19.4, 20.6, 23.0, null]],
  [25, 1.2, [1.4, 1.4, 1.5, 1.6, null], [13.6, 23.8, 25.6, 28.5, null]],
  [35, 1.2, [1.6, 1.6, 1.6, 1.7, null], [15.5, 27.2, 29.3, 32.7, null]],
  [50, 1.4, [2.0, 2.0, 2.0, 2.0, null], [18.1, 32.0, 34.6, 38.6, null]],
  [70, 1.4, [2.2, 2.2, 2.2, 2.2, null], [20.8, 36.8, 39.6, 44.3, null]],
  [95, 1.6, [2.4, 2.4, 2.4, 2.4, null], [23.6, 41.8, 47.0, 50.2, null]],
  [120, 1.6, [2.5, 2.5, 2.5, 2.5, null], [26.0, 46.2, 51.0, 55.7, null]],
  [150, 1.8, [null, null, 2.6, 2.6, null], [null, null, 54.8, 62.1, null]],
  [185, 2, [null, null, 2.8, 2.8, null], [null, null, 61.2, 68.5, null]],
  [240, 2.2, [null, null, 3.0, 3.0, null], [null, null, 69.7, 77.9, null]],
  [300, 2.4, [null, null, 3.2, 3.2, null], [null, null, 75.7, 84.7, null]],
];

// ── Table 7: flexible cords circular, cores 1-5, sizes 0.5-2.5 (+ twins incl 4 mm²) ──
const T7 = [
  // [size, ti, ts1..5, od1..5, parallelTwin, twistedTwin]
  [0.5, 0.6, [0.9, 0.9, 0.9, 0.9, 0.9], [4.3, 6.9, 7.3, 8.0, 8.7], '2.6 × 5.2', 5.2],
  [0.75, 0.6, [0.9, 0.9, 0.9, 0.9, 0.9], [4.5, 7.3, 7.7, 8.4, 9.2], '2.8 × 5.6', 5.6],
  [1.0, 0.6, [0.9, 0.9, 0.9, 0.9, 1.0], [4.7, 7.6, 8.1, 8.8, 9.6], '3.0 × 6.0', 6.0],
  [1.5, 0.6, [0.9, 0.9, 0.9, 1.0, 1.0], [5.4, 8.9, 9.4, 10.4, 11.4], '3.3 × 6.6', 6.6],
  [2.5, 0.7, [1.0, 1.0, 1.0, 1.0, 1.0], [6.2, 10.3, 10.9, 12.0, 13.2], '4.0 × 8.0', 8.0],
  [4, 0.8, [null, null, null, null, null], [null, null, null, null, null], '4.8 × 9.6', 9.6],
];

// ── Table 9: multicore flexible cords, cores 6-25 × sizes [0.5, 0.75, 1.0, 1.5, 2.5] ──
const T9_SIZES = [0.5, 0.75, 1.0, 1.5, 2.5];
const T9_TI = [0.6, 0.6, 0.6, 0.6, 0.7];
const T9 = { // cores: [ts×5, od×5]
  6: [[0.9, 1.0, 1.0, 1.0, 1.1], [9.5, 10.0, 10.5, 12.4, 14.5]],
  7: [[0.9, 1.0, 1.0, 1.0, 1.1], [9.5, 10.0, 10.5, 12.4, 14.5]],
  8: [[1.0, 1.0, 1.0, 1.1, 1.2], [11.1, 11.8, 12.4, 14.7, 17.3]],
  9: [[1.0, 1.1, 1.1, 1.1, 1.3], [11.8, 12.4, 13.1, 15.6, 18.3]],
  10: [[1.0, 1.1, 1.1, 1.1, 1.3], [12.0, 12.7, 13.4, 16.0, 18.7]],
  11: [[1.0, 1.1, 1.1, 1.1, 1.3], [12.0, 12.7, 13.4, 16.0, 18.7]],
  12: [[1.0, 1.1, 1.1, 1.1, 1.3], [12.4, 13.1, 13.9, 16.5, 19.4]],
  13: [[1.0, 1.1, 1.1, 1.2, 1.3], [13.1, 13.8, 14.6, 17.4, 20.5]],
  14: [[1.1, 1.1, 1.1, 1.2, 1.3], [13.1, 13.8, 14.6, 17.4, 20.5]],
  15: [[1.1, 1.2, 1.2, 1.2, 1.4], [13.5, 14.3, 15.1, 18.1, 21.3]],
  16: [[1.1, 1.2, 1.2, 1.2, 1.4], [13.8, 14.6, 15.4, 18.4, 21.7]],
  17: [[1.1, 1.2, 1.2, 1.3, 1.4], [14.6, 15.4, 16.3, 19.5, 23.0]],
  18: [[1.1, 1.2, 1.3, 1.3, 1.4], [14.6, 15.4, 16.3, 19.5, 23.3]],
  19: [[1.1, 1.2, 1.3, 1.3, 1.4], [14.6, 15.4, 16.3, 19.5, 23.8]],
  20: [[1.2, 1.3, 1.4, 1.4, 1.5], [15.4, 16.3, 17.3, 20.7, 24.4]],
  21: [[1.2, 1.3, 1.4, 1.4, 1.5], [15.4, 16.3, 17.3, 20.7, 25.0]],
  22: [[1.2, 1.3, 1.4, 1.4, 1.5], [16.3, 17.3, 18.2, 21.9, 25.8]],
  23: [[1.2, 1.3, 1.4, 1.4, 1.5], [16.3, 17.3, 18.2, 21.9, 26.3]],
  24: [[1.2, 1.3, 1.4, 1.4, 1.5], [17.1, 18.2, 19.2, 23.0, 27.2]],
  25: [[1.2, 1.3, 1.4, 1.4, 1.5], [17.1, 19.0, 19.2, 23.0, 27.9]],
};

// ── Table 10: flat cables 2/3 core — ti/ts by size; W×H by size|cores ──
const T10 = [
  // [size, ti, ts, wh2, wh3]
  [0.5, 0.6, 0.9, '7.2 × 4.9', '9.6 × 4.9'],
  [0.75, 0.6, 0.9, '7.8 × 5.2', '10.5 × 5.2'],
  [1.0, 0.6, 0.9, '8.0 × 5.4', '11.0 × 5.4'],
  [1.5, 0.6, 0.9, '8.6 × 5.6', '10.7 × 5.3'],
  [2.5, 0.7, 1.0, '10.5 × 6.6', '13.0 × 6.2'],
  [4, 0.8, 1.0, '12.0 × 7.4', '15.3 × 7.1'],
  [6, 0.8, 1.1, '13.0 × 8.0', '19.2 × 8.4'],
  [10, 1.0, 1.4, '16.0 × 9.6', '24.2 × 10.4'],
  [16, 1.0, 1.4, '18.5 × 11.0', '29.0 × 12.4'],
  [25, 1.2, 2.0, '22.5 × 13.0', '36.5 × 15.7'],
  [35, 1.2, 2.0, '25.5 × 14.5', '40.5 × 17.2'],
  [50, 1.4, 2.2, '29.0 × 16.5', '46.5 × 19.3'],
  [70, 1.4, 2.2, null, '52.0 × 21.0'],
  [95, 1.6, 2.4, null, '61.0 × 24.5'],
];

const S = v => String(v);
const filler = { value: NOT_OFFERED, expected: NOT_OFFERED };

// Build a [size] valueTable: realBySize is Map(sizeString -> cell)
function bySize(realBySize) {
  const vt = {};
  for (const s of SIZES) vt[S(s)] = realBySize.get(S(s)) || filler;
  return vt;
}
// Build a [size|cores] valueTable
function bySizeCores(realFn) {
  const vt = {};
  for (const s of SIZES) for (const c of CORES) {
    vt[`${S(s)}|${S(c)}`] = realFn(s, c) || filler;
  }
  return vt;
}

const params = [];
const add = p => params.push(p);

// ---- Section 2 (Tables 3-4) ----
{
  const ti = new Map(); const odByClass = {};
  for (const [s, cl, t, od] of T3) { ti.set(S(s), { min: t }); odByClass[`${S(s)}|${S(cl)}`] = { max: od }; }
  add({
    clauseRef: 'Cl 16.1.2 / Table 3', section: 'Single-core unsheathed (rigid)', parameterName: 'Insulation thickness (nominal ti), mean Min',
    unit: 'mm', limitType: 'min', acceptanceOrType: 'acceptance', variesBy: ['size'], sourceTable: 'Table 3',
    testMethod: 'IS 10810 (Part 6)', specText: 'Mean ≥ nominal ti; smallest measured ≥ ti − (0.1 mm + 0.1 ti)',
    valueTable: bySize(ti),
  });
  const vtOd = {};
  for (const s of SIZES) for (const cl of ['1', '2']) vtOd[`${S(s)}|${cl}`] = odByClass[`${S(s)}|${cl}`] || filler;
  add({
    clauseRef: 'Cl 16.1.3 / Table 3', section: 'Single-core unsheathed (rigid)', parameterName: 'Overall diameter, Max',
    unit: 'mm', limitType: 'max', acceptanceOrType: 'acceptance', variesBy: ['size', 'class'], sourceTable: 'Table 3',
    testMethod: 'IS 10810 (Part 6)', valueTable: vtOd,
  });
}
{
  const ti = new Map(); const od = new Map();
  for (const [s, t, d] of T4) { ti.set(S(s), { min: t }); od.set(S(s), { max: d }); }
  add({
    clauseRef: 'Cl 17.1.2 / Table 4', section: 'Single-core unsheathed (flexible, Class 5)', parameterName: 'Insulation thickness (nominal ti), mean Min',
    unit: 'mm', limitType: 'min', acceptanceOrType: 'acceptance', variesBy: ['size'], sourceTable: 'Table 4',
    testMethod: 'IS 10810 (Part 6)', specText: 'Mean ≥ nominal ti; smallest measured ≥ ti − (0.1 mm + 0.1 ti)',
    valueTable: bySize(ti),
  });
  add({
    clauseRef: 'Cl 17.1.3 / Table 4', section: 'Single-core unsheathed (flexible, Class 5)', parameterName: 'Overall diameter, Max',
    unit: 'mm', limitType: 'max', acceptanceOrType: 'acceptance', variesBy: ['size'], sourceTable: 'Table 4',
    testMethod: 'IS 10810 (Part 6)', valueTable: bySize(od),
  });
}
// ---- Section 3 Table 5 ----
{
  const ti = new Map(); const rows = new Map();
  for (const [s, t, ts, od] of T5) { ti.set(S(s), { min: t }); rows.set(S(s), { ts, od }); }
  add({
    clauseRef: 'Cl 18.1.2 / Table 5', section: 'Sheathed cables, rigid conductor (fixed wiring)', parameterName: 'Insulation thickness (nominal ti), mean Min',
    unit: 'mm', limitType: 'min', acceptanceOrType: 'acceptance', variesBy: ['size'], sourceTable: 'Table 5',
    testMethod: 'IS 10810 (Part 6)', specText: 'Mean ≥ nominal ti; smallest measured ≥ ti − (0.1 mm + 0.1 ti). Cables 1.0-120 mm², 1-4 cores (1.0 mm² copper conductor only)',
    valueTable: bySize(ti),
  });
  add({
    clauseRef: 'Cl 18.1.4 / Table 5', section: 'Sheathed cables, rigid conductor (fixed wiring)', parameterName: 'Sheath thickness (nominal ts), average Min',
    unit: 'mm', limitType: 'min', acceptanceOrType: 'acceptance', variesBy: ['size', 'cores'], sourceTable: 'Table 5',
    testMethod: 'IS 10810 (Part 6)', specText: 'Average ≥ nominal ts; smallest measured ≥ ts − (0.1 mm + 0.15 ts). Note: printed Table 5 gives single-core ts 2.4 at 70 mm² (adjacent sizes 1.2/1.5) — printed cells are authoritative',
    valueTable: bySizeCores((s, c) => { const r = rows.get(S(s)); return r && c >= 1 && c <= 4 && r.ts[c - 1] != null ? { min: r.ts[c - 1] } : null; }),
  });
  add({
    clauseRef: 'Cl 18.1.6 / Table 5', section: 'Sheathed cables, rigid conductor (fixed wiring)', parameterName: 'Overall dimensions, Max',
    unit: 'mm', limitType: 'max', acceptanceOrType: 'acceptance', variesBy: ['size', 'cores'], sourceTable: 'Table 5',
    testMethod: 'IS 10810 (Part 6)',
    valueTable: bySizeCores((s, c) => { const r = rows.get(S(s)); return r && c >= 1 && c <= 4 && r.od[c - 1] != null ? { max: r.od[c - 1] } : null; }),
  });
}
// ---- Table 6 ----
{
  const ti = new Map(); const rows = new Map();
  for (const [s, t, ts, od] of T6) { ti.set(S(s), { min: t }); rows.set(S(s), { ts, od }); }
  add({
    clauseRef: 'Cl 19.1.3 / Table 6', section: 'Flexible sheathed cables (Class 5)', parameterName: 'Insulation thickness (nominal ti), mean Min',
    unit: 'mm', limitType: 'min', acceptanceOrType: 'acceptance', variesBy: ['size'], sourceTable: 'Table 6',
    testMethod: 'IS 10810 (Part 6)', specText: 'Flexible cables 4-300 mm², 1-5 cores. Mean ≥ nominal ti; smallest ≥ ti − (0.1 mm + 0.1 ti)',
    valueTable: bySize(ti),
  });
  add({
    clauseRef: 'Cl 19.1.5 / Table 6', section: 'Flexible sheathed cables (Class 5)', parameterName: 'Sheath thickness (nominal ts), average Min',
    unit: 'mm', limitType: 'min', acceptanceOrType: 'acceptance', variesBy: ['size', 'cores'], sourceTable: 'Table 6',
    testMethod: 'IS 10810 (Part 6)', specText: 'Average ≥ nominal ts; smallest ≥ ts − (0.1 mm + 0.15 ts)',
    valueTable: bySizeCores((s, c) => { const r = rows.get(S(s)); return r && c >= 1 && c <= 5 && r.ts[c - 1] != null ? { min: r.ts[c - 1] } : null; }),
  });
  add({
    clauseRef: 'Cl 19.1.7 / Table 6', section: 'Flexible sheathed cables (Class 5)', parameterName: 'Overall diameter, Max',
    unit: 'mm', limitType: 'max', acceptanceOrType: 'acceptance', variesBy: ['size', 'cores'], sourceTable: 'Table 6',
    testMethod: 'IS 10810 (Part 6)', specText: 'Printed values 15.47 (6 mm² four-core) and 17.69 (10 mm² three-core) verified against page image',
    valueTable: bySizeCores((s, c) => { const r = rows.get(S(s)); return r && c >= 1 && c <= 5 && r.od[c - 1] != null ? { max: r.od[c - 1] } : null; }),
  });
}
// ---- Table 7 ----
{
  const ti = new Map(); const rows = new Map(); const pt = new Map(); const tt = new Map();
  for (const [s, t, ts, od, p, w] of T7) {
    ti.set(S(s), { min: t }); rows.set(S(s), { ts, od });
    pt.set(S(s), { expected: `${p} mm Max (W × H)` }); tt.set(S(s), { max: w });
  }
  add({
    clauseRef: 'Cl 19.1.3 / Table 7', section: 'Flexible cords (Class 5)', parameterName: 'Insulation thickness (nominal ti), mean Min',
    unit: 'mm', limitType: 'min', acceptanceOrType: 'acceptance', variesBy: ['size'], sourceTable: 'Table 7',
    testMethod: 'IS 10810 (Part 6)', specText: 'Cords 0.5-2.5 mm² (4 mm² for twin parallel/twisted only). Mean ≥ nominal ti; smallest ≥ ti − (0.1 mm + 0.1 ti)',
    valueTable: bySize(ti),
  });
  add({
    clauseRef: 'Cl 19.1.5 / Table 7', section: 'Flexible cords (Class 5)', parameterName: 'Sheathing wall thickness (nominal ts), average Min',
    unit: 'mm', limitType: 'min', acceptanceOrType: 'acceptance', variesBy: ['size', 'cores'], sourceTable: 'Table 7',
    testMethod: 'IS 10810 (Part 6)', specText: 'Average ≥ nominal ts; smallest ≥ ts − (0.1 mm + 0.15 ts)',
    valueTable: bySizeCores((s, c) => { const r = rows.get(S(s)); return r && c >= 1 && c <= 5 && r.ts[c - 1] != null ? { min: r.ts[c - 1] } : null; }),
  });
  add({
    clauseRef: 'Cl 19.1.7 / Table 7', section: 'Flexible cords (Class 5)', parameterName: 'Overall dimension (circular cords), Max',
    unit: 'mm', limitType: 'max', acceptanceOrType: 'acceptance', variesBy: ['size', 'cores'], sourceTable: 'Table 7',
    testMethod: 'IS 10810 (Part 6)',
    valueTable: bySizeCores((s, c) => { const r = rows.get(S(s)); return r && c >= 1 && c <= 5 && r.od[c - 1] != null ? { max: r.od[c - 1] } : null; }),
  });
  add({
    clauseRef: 'Cl 21.1.2 / Table 7', section: 'Twin parallel / twisted twin cords', parameterName: 'Parallel twin overall dimension (W × H), Max',
    unit: 'mm', limitType: 'text', acceptanceOrType: 'acceptance', variesBy: ['size'], sourceTable: 'Table 7',
    testMethod: 'IS 10810 (Part 6)', valueTable: bySize(pt),
  });
  add({
    clauseRef: 'Cl 21.1.2 / Table 7', section: 'Twin parallel / twisted twin cords', parameterName: 'Twisted twin overall dimension, Max',
    unit: 'mm', limitType: 'max', acceptanceOrType: 'acceptance', variesBy: ['size'], sourceTable: 'Table 7',
    testMethod: 'IS 10810 (Part 6)', valueTable: bySize(tt),
  });
}
// ---- Table 9 (6-25 cores) ----
{
  const idx = s => T9_SIZES.findIndex(x => S(x) === S(s));
  const ti = new Map();
  T9_SIZES.forEach((s, i) => ti.set(S(s), { min: T9_TI[i] }));
  add({
    clauseRef: 'Cl 20.1.2 / Table 9', section: 'Multicore flexible cables 6-25 cores (Class 5)', parameterName: 'Insulation thickness (nominal ti), mean Min',
    unit: 'mm', limitType: 'min', acceptanceOrType: 'acceptance', variesBy: ['size'], sourceTable: 'Table 9',
    testMethod: 'IS 10810 (Part 6)', specText: 'Multicore cords 0.5-2.5 mm², 6-25 cores. Mean ≥ nominal ti; smallest ≥ ti − (0.1 mm + 0.1 ti)',
    valueTable: bySize(ti),
  });
  add({
    clauseRef: 'Cl 20.1.4 / Table 9', section: 'Multicore flexible cables 6-25 cores (Class 5)', parameterName: 'Sheath thickness (nominal ts), average Min',
    unit: 'mm', limitType: 'min', acceptanceOrType: 'acceptance', variesBy: ['size', 'cores'], sourceTable: 'Table 9',
    testMethod: 'IS 10810 (Part 6)', specText: 'Average ≥ nominal ts; smallest ≥ ts − (0.1 mm + 0.15 ts)',
    valueTable: bySizeCores((s, c) => { const i = idx(s); return i >= 0 && T9[c] ? { min: T9[c][0][i] } : null; }),
  });
  add({
    clauseRef: 'Cl 20.1.4 / Table 9', section: 'Multicore flexible cables 6-25 cores (Class 5)', parameterName: 'Overall dimension, Max',
    unit: 'mm', limitType: 'max', acceptanceOrType: 'acceptance', variesBy: ['size', 'cores'], sourceTable: 'Table 9',
    testMethod: 'IS 10810 (Part 6)',
    valueTable: bySizeCores((s, c) => { const i = idx(s); return i >= 0 && T9[c] ? { max: T9[c][1][i] } : null; }),
  });
}
// ---- Table 10 (flat cables) ----
{
  const ti = new Map(); const ts = new Map(); const rows = new Map();
  for (const [s, t, sh, wh2, wh3] of T10) { ti.set(S(s), { min: t }); ts.set(S(s), { min: sh }); rows.set(S(s), { wh2, wh3 }); }
  add({
    clauseRef: 'Cl 22.1.2 / Table 10', section: 'Flat cables 2/3 core', parameterName: 'Insulation thickness (nominal ti), mean Min',
    unit: 'mm', limitType: 'min', acceptanceOrType: 'acceptance', variesBy: ['size'], sourceTable: 'Table 10',
    testMethod: 'IS 10810 (Part 6)', specText: 'Flat cables 0.5-95 mm² (3-core) / 0.5-50 mm² (flat twin). Mean ≥ nominal ti; smallest ≥ ti − (0.1 mm + 0.1 ti)',
    valueTable: bySize(ti),
  });
  add({
    clauseRef: 'Cl 22.1.4 / Table 10', section: 'Flat cables 2/3 core', parameterName: 'Sheath thickness (nominal ts), average Min',
    unit: 'mm', limitType: 'min', acceptanceOrType: 'acceptance', variesBy: ['size'], sourceTable: 'Table 10',
    testMethod: 'IS 10810 (Part 6)', specText: 'Average ≥ nominal ts; smallest ≥ ts − (0.1 mm + 0.15 ts)',
    valueTable: bySize(ts),
  });
  add({
    clauseRef: 'Cl 22.1.4 / Table 10', section: 'Flat cables 2/3 core', parameterName: 'Overall dimensions (W × H), Max',
    unit: 'mm', limitType: 'text', acceptanceOrType: 'acceptance', variesBy: ['size', 'cores'], sourceTable: 'Table 10',
    testMethod: 'IS 10810 (Part 6)',
    valueTable: bySizeCores((s, c) => {
      const r = rows.get(S(s));
      if (!r || (c !== 2 && c !== 3)) return null;
      const wh = c === 2 ? r.wh2 : r.wh3;
      return wh ? { expected: `${wh} mm Max (W × H)` } : null;
    }),
  });
}

// ---- Constant / qualitative parameters ----
const constants = [
  {
    clauseRef: 'Cl 4.1', section: 'Conductor', parameterName: 'Conductor material and class',
    limitType: 'qualitative', acceptanceOrType: 'type', variesBy: [],
    testMethod: 'IS 8130',
    expected: 'Annealed, bare or tinned high-conductivity copper (Class 1, 2 or 5) or aluminium wires per IS 8130 (aluminium: Class 1 or 2 up to and including 10 mm², stranded Class 2 above 10 mm²); optional separator tape. Fixed-installation conductors circular solid, circular stranded or compacted circular/shaped stranded',
  },
  {
    clauseRef: 'Cl 4.2', section: 'Conductor', parameterName: 'Conductor resistance at 20 °C',
    limitType: 'qualitative', acceptanceOrType: 'acceptance', variesBy: [],
    testMethod: 'IS 10810 (Part 5)',
    expected: 'Resistance of each conductor at 20 °C per IS 8130 for the class of conductor (routine + acceptance + type test per Table 1)',
  },
  {
    clauseRef: 'Cl 5.1', section: 'Insulation', parameterName: 'Insulation material (PVC type)',
    limitType: 'qualitative', acceptanceOrType: 'type', variesBy: [],
    testMethod: 'IS 5831',
    expected: 'PVC conforming to IS 5831 — Type A (fixed installation), Type C (heat-resistant 85 °C), Type D (flexible cords, per Amd 1); FR / FR-LSH insulation properties required for unsheathed FR / FR-LSH cables (not required for insulation of sheathed FR / FR-LSH cables)',
  },
  {
    clauseRef: 'Cl 5.4', section: 'Insulation', parameterName: 'Insulation mechanical properties before/after ageing',
    limitType: 'qualitative', acceptanceOrType: 'type', variesBy: [],
    testMethod: 'IS 5831, Table 1 / IS 10810 (Parts 7, 10, 11, 12, 14, 15, 60, 20, 21)',
    expected: 'Tensile strength and elongation per Table 1 of IS 5831 for the PVC type; type tests also include loss of mass, ageing in air oven, shrinkage, heat shock, hot deformation, thermal stability, cold bend and cold impact (02 category) per Table 1',
  },
  {
    clauseRef: 'Cl 8.1', section: 'Sheath', parameterName: 'Sheath material (PVC type)',
    limitType: 'qualitative', acceptanceOrType: 'type', variesBy: [],
    testMethod: 'IS 5831, Table 2',
    expected: 'PVC per IS 5831 — Type ST1 (fixed installations), Type ST2 (85 °C HR), Type ST3 (flexible cables and cords); FR / FR-LSH sheathing compound shall satisfy the special FR / FR-LSH properties',
  },
  {
    clauseRef: 'Cl 8.4', section: 'Sheath', parameterName: 'Sheath mechanical properties before/after ageing',
    limitType: 'qualitative', acceptanceOrType: 'type', variesBy: [],
    testMethod: 'IS 5831, Table 2 / IS 10810 (Parts 7, 10, 11, 12, 14, 15, 60)',
    expected: 'Tensile strength and elongation per Table 2 of IS 5831 for the PVC type; sheath type tests include loss of mass, ageing, shrinkage, heat shock, hot deformation, thermal stability, cold bend/cold impact (02, per Amd 1)',
  },
  {
    clauseRef: 'Cl 9.1', section: 'Dimensions', parameterName: 'Ovality of sheathed circular cables, Max',
    unit: '%', limitType: 'max', acceptanceOrType: 'acceptance', variesBy: [], max: 15,
    testMethod: 'IS 10810 (Part 6)',
    expected: 'Difference between maximum and minimum measured overall diameter ≤ 15 percent of maximum measured value at the same cross-section',
  },
  {
    clauseRef: 'Cl 10.1', section: 'Electrical', parameterName: 'High voltage test (water immersion)',
    limitType: 'qualitative', acceptanceOrType: 'type', variesBy: [],
    testMethod: 'IS 10810 (Part 45)',
    expected: 'Core in water bath at 60 ± 3 °C, ends ≥ 200 mm above water; after 24 h apply 3 kV rms conductor-to-water, raise to 6 kV rms within 10 s, hold 5 min (one retest permitted); cores then withstand dc 1.2 kV (conductor negative) in same bath for total 240 h without breakdown',
  },
  {
    clauseRef: 'Cl 10.2', section: 'Electrical', parameterName: 'High voltage test at room temperature',
    limitType: 'qualitative', acceptanceOrType: 'acceptance', variesBy: [],
    testMethod: 'IS 10810 (Part 45)',
    expected: 'Withstand without breakdown ac 3 kV rms or dc 7.2 kV for 5 min per test connection (single core: immersed in water 1 h before test, voltage conductor-to-water). Routine + acceptance + type test',
  },
  {
    clauseRef: 'Cl 10.3', section: 'Electrical', parameterName: 'Spark test (alternative to HV test, single-core unsheathed)',
    limitType: 'qualitative', acceptanceOrType: 'acceptance', variesBy: [],
    testMethod: 'IS 10810 (Part 44)',
    expected: 'Test voltage by insulation thickness: ≤ 1.0 mm — 6 kV rms; > 1.0-1.5 mm — 10 kV; > 1.5-2.0 mm — 15 kV; > 2.0-2.5 mm — 20 kV; > 2.5 mm — 25 kV',
  },
  {
    clauseRef: 'Cl 10.4', section: 'Fire performance', parameterName: 'Flammability — period of burning after flame removal, Max',
    unit: 's', limitType: 'max', acceptanceOrType: 'acceptance', variesBy: [], max: 60,
    testMethod: 'IS 10810 (Part 53)',
  },
  {
    clauseRef: 'Cl 10.4', section: 'Fire performance', parameterName: 'Flammability — unaffected portion from lower edge of top clamp, Min',
    unit: 'mm', limitType: 'min', acceptanceOrType: 'acceptance', variesBy: [], min: 50,
    testMethod: 'IS 10810 (Part 53)',
  },
  {
    clauseRef: 'Cl 10.5', section: 'Fire performance', parameterName: 'Oxygen index (FR and FR-LSH), Min',
    unit: '%', limitType: 'min', acceptanceOrType: 'acceptance', variesBy: [], min: 29,
    testMethod: 'IS 10810 (Part 58)',
    expected: 'Samples at 27 ± 2 °C; oxygen index not less than 29 percent',
  },
  {
    clauseRef: 'Cl 10.6', section: 'Fire performance', parameterName: 'Halogen acid gas evolution (FR-LSH), Max',
    unit: '% by weight', limitType: 'max', acceptanceOrType: 'acceptance', variesBy: [], max: 20,
    testMethod: 'IS 10810 (Part 59)',
  },
  {
    clauseRef: 'Cl 10.7 (Amd 2)', section: 'Fire performance', parameterName: 'Temperature index (FR and FR-LSH), Min',
    unit: '°C', limitType: 'min', acceptanceOrType: 'acceptance', variesBy: [], min: 250,
    testMethod: 'IS 10810 (Part 64)',
    expected: 'Per Amendment 2: minimum measured temperature index 250 °C at which the oxygen index is 21',
  },
  {
    clauseRef: 'Cl 10.8 (Amd 2)', section: 'Fire performance', parameterName: 'Smoke density rating (FR-LSH), Max',
    unit: '%', limitType: 'max', acceptanceOrType: 'acceptance', variesBy: [], max: 60,
    testMethod: 'IS 13360 (Part 6/Sec 9):2001',
  },
  {
    clauseRef: 'Cl 10.9', section: 'Type tests', parameterName: 'Additional ageing test (outdoor / category 02 cables)',
    limitType: 'qualitative', acceptanceOrType: 'type', variesBy: [],
    testMethod: 'IS 694, Cl 10.9',
    expected: '6 m sample at 80 ± 2 °C for 168 h, then boiling water 8 h + water bath 27 ± 2 °C for 16 h, repeated 5 successive days (ends ≥ 200 mm above water); then 5 m sample passes HV test per 10.2 in water bath at 60 ± 3 °C, remainder passes cold bend or cold impact test as appropriate',
  },
  {
    clauseRef: 'Cl 10.11', section: 'Conductor', parameterName: 'Persulphate test (tinned copper conductor)',
    limitType: 'qualitative', acceptanceOrType: 'acceptance', variesBy: [],
    testMethod: 'IS 10810 (Part 4)',
    expected: 'Requirements per 6.1.1 of IS 8130',
  },
  {
    clauseRef: 'Cl 11', section: 'Identification & marking', parameterName: 'Manufacturer identification and durability of marking',
    limitType: 'qualitative', acceptanceOrType: 'acceptance', variesBy: [],
    expected: 'Name/trade-mark printed, indented or embossed throughout length (insulation for unsheathed, sheath for sheathed), spacing ≤ 1 m; printed marking withstands 10 light rubs with water-soaked cotton; markings clear and legible',
  },
  {
    clauseRef: 'Cl 12 / Table 2', section: 'Identification & marking', parameterName: 'Core identification',
    limitType: 'qualitative', acceptanceOrType: 'acceptance', variesBy: [],
    expected: 'Core colours per Table 2 (fixed wiring ≤ 4 cores; flexible ≤ 25 cores) or number-coded cores (Arabic numerals, contrasting colour, start 1 innermost, spacing ≤ 50 mm, yellow-green outermost); yellow-green earthing core: each colour 30-70 percent of surface per 15 mm',
  },
  {
    clauseRef: 'Cl 13', section: 'Identification & marking', parameterName: 'Cable code designation',
    limitType: 'qualitative', acceptanceOrType: 'acceptance', variesBy: [],
    expected: 'Code letters: A aluminium conductor; Y PVC insulation; Y PVC sheath; OU suitable for outdoor use; FR / FR-LSH fire categories; ECC earth continuity conductor and SZ suitable for low temperature (per Amd 1); no letter for copper conductor; e.g. Y (FR), YY (FR-LSH)',
  },
  {
    clauseRef: 'Cl 15.2', section: 'Identification & marking', parameterName: 'Packing and marking on drum/reel/coil',
    limitType: 'qualitative', acceptanceOrType: 'acceptance', variesBy: [],
    expected: 'IS 694 reference; manufacturer; type of cable and voltage grade; FR/FR-LSH where applicable; number of cores; nominal cross-sectional area; ATC for tinned copper; cable code; core colour (single core); length; number of lengths; direction-of-rotation arrow (wooden drums); approximate gross mass; country and year of manufacture; "suitable for outdoor use" where applicable; optional Standard Mark',
  },
  {
    clauseRef: 'Table 1 (iii)(e)3', section: 'Electrical', parameterName: 'Insulation resistance (completed cable)',
    limitType: 'qualitative', acceptanceOrType: 'type', variesBy: [],
    testMethod: 'IS 10810 (Part 43)',
    expected: 'Insulation resistance requirement per IS 5831 for the PVC type (acceptance + type test per Table 1)',
  },
];
for (const c of constants) add(c);

const tpl = {
  isNumber: 'IS 694:2010',
  title: 'Polyvinyl Chloride Insulated Unsheathed and Sheathed Cables/Cords with Rigid and Flexible Conductor for Rated Voltages up to and including 450/750 V',
  revision: 'Fourth Revision (incl. Amendments 1 & 2)',
  parameterizationDims: ['size', 'cores', 'class'],
  dimensionOptions: { size: SIZES, cores: CORES, class: ['1', '2'] },
  defaults: { size: 2.5, cores: 3, class: '2' },
  parameters: params,
};

const out = path.join(REPO, 'public/is_templates/IS_694_2010.json');
fs.writeFileSync(out, JSON.stringify(tpl, null, 1));
const nCells = params.reduce((n, p) => n + (p.valueTable ? Object.keys(p.valueTable).length : 0), 0);
console.log(`[gen] wrote ${out}: ${params.length} parameters, ${nCells} valueTable cells, ${Math.round(fs.statSync(out).size / 1024)} KB`);
