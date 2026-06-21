'use strict';
/**
 * IS Standard PDF Extraction Pipeline — All 6 Phases
 *
 * Phase 0  Ingest      pdfplumber text + N-page accounting
 * Phase 1  Understand  Claude Opus builds complete document map
 * Phase 2  Extract     Gemini 3.5-flash + Qwen3-VL read each table (vision)
 * Phase 3  Consensus   Cell-by-cell agreement + typed validators
 * Phase 4  Finalize    Claude Opus assembles trusted structured output
 * Phase 5  Vault       Persist with page references for human review
 * Phase 6  Calibrate   Diff against specs_db.js baseline (IS 4985 only)
 *
 * Azure DI: slot reserved — wire when AZURE_DI_KEY + AZURE_DI_ENDPOINT set.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');

// ─── Config ──────────────────────────────────────────────────────────────────
const OR_BASE = 'https://openrouter.ai/api/v1';

// Claude Opus: brain (understand + finalize)
const MODEL_BRAIN = process.env.OR_BRAIN_MODEL || 'anthropic/claude-opus-4.8';
// Gemini 3.5 Flash: vision reader 1 (fast, top OCR — scored 97.8% on IS 4985 Table 1)
const MODEL_R1 = process.env.OR_READER1_MODEL || 'google/gemini-3.5-flash';
// Vision reader 2 for consensus. NOTE: qwen2.5-vl-72b garbled rotated tables (16% in
// testing) — using a reliable Gemini Pro pass instead. Swap via OR_READER2_MODEL once a
// different-lineage model is validated on rotated IS tables.
const MODEL_R2 = process.env.OR_READER2_MODEL || 'google/gemini-3.1-pro-preview';

const SCRIPTS_DIR = path.join(__dirname, '../../scripts');
const SCRATCH_DIR = path.join(__dirname, '../../scratch');
if (!fs.existsSync(SCRATCH_DIR)) fs.mkdirSync(SCRATCH_DIR, { recursive: true });

// ─── In-memory job store ──────────────────────────────────────────────────────
const jobs = new Map();

function newJob(jobId, filename) {
    const job = {
        id: jobId,
        filename,
        status: 'running',   // running | done | error
        phase: 0,
        phaseLabel: 'Starting pipeline…',
        progress: 0,
        log: [],
        result: null,
        error: null,
        startedAt: Date.now(),
        _tmpPath: null,
    };
    jobs.set(jobId, job);
    return job;
}

function setPhase(job, phase, label, progress) {
    job.phase = phase;
    job.phaseLabel = label;
    job.progress = progress;
    const ts = new Date().toISOString().split('T')[1].slice(0, 8);
    const msg = `Phase ${phase}: ${label}`;
    job.log.push(`[${ts}] ${msg}`);
    console.log(`[IS-Pipeline][${job.id.slice(-6)}] ${msg}`);
}

function jlog(job, msg) {
    const ts = new Date().toISOString().split('T')[1].slice(0, 8);
    job.log.push(`[${ts}] ${msg}`);
    console.log(`[IS-Pipeline][${job.id.slice(-6)}] ${msg}`);
}

// ─── OpenRouter helpers ───────────────────────────────────────────────────────
function orHeaders() {
    return {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3005',
        'X-Title': 'SampleSpeaks IS Pipeline',
    };
}

async function orChat(model, messages, opts = {}) {
    const res = await fetch(`${OR_BASE}/chat/completions`, {
        method: 'POST',
        headers: orHeaders(),
        body: JSON.stringify({
            model,
            messages,
            temperature: opts.temperature ?? 0.05,
            max_tokens: opts.maxTokens ?? 8192,
        }),
    });
    const j = await res.json();
    if (!res.ok) {
        const errMsg = (j.error && j.error.message) || JSON.stringify(j).slice(0, 200);
        throw new Error(`OpenRouter ${res.status} (${model}): ${errMsg}`);
    }
    return (j.choices && j.choices[0] && j.choices[0].message.content) || '';
}

async function orVision(model, systemPrompt, textPrompt, imageBase64, opts = {}) {
    return orChat(model, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: [
            { type: 'text', text: textPrompt },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
        ]},
    ], { temperature: 0.02, maxTokens: opts.maxTokens || 6000 });
}

function safeJSON(raw) {
    if (!raw) return null;
    const m = raw.match(/```json\s*([\s\S]*?)\s*```/) || raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    const s = m ? (m[1] || m[0]) : raw;
    try { return JSON.parse(s.trim()); } catch (e) { return null; }
}

// ─── Python runner helper ─────────────────────────────────────────────────────
function pyRun(scriptName, args, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        const py = spawn('python3', [path.join(SCRIPTS_DIR, scriptName), ...args]);
        let out = '', err = '';
        const timer = setTimeout(() => {
            py.kill('SIGTERM');
            reject(new Error(`${scriptName} timed out after ${timeoutMs / 1000}s`));
        }, timeoutMs);
        py.stdout.on('data', d => out += d.toString());
        py.stderr.on('data', d => err += d.toString());
        py.on('close', code => {
            clearTimeout(timer);
            if (code !== 0) return reject(new Error(`${scriptName} exited ${code}: ${err.slice(0, 400)}`));
            try { resolve(JSON.parse(out)); }
            catch (e) { reject(new Error(`Bad JSON from ${scriptName}: ${out.slice(0, 200)}`)); }
        });
    });
}

// ─── Phase 0: Ingest ──────────────────────────────────────────────────────────
async function phase0(job, buffer, filename) {
    setPhase(job, 0, 'Ingesting document — extracting text and detecting table pages', 5);

    const ext = path.extname(filename).toLowerCase() || '.pdf';
    const tmpPath = path.join(SCRATCH_DIR, `isp_${crypto.randomBytes(8).toString('hex')}${ext}`);
    fs.writeFileSync(tmpPath, buffer);
    job._tmpPath = tmpPath; // kept alive through Phase 2

    let extracted;
    try {
        extracted = await pyRun('extract_is_tables.py', [tmpPath], 180000);
    } catch (e) {
        // If pdfplumber fails, return minimal structure
        jlog(job, `⚠ Python extractor failed: ${e.message} — using empty base`);
        extracted = { text: '', pages: [], tables: [], image_table_pages: [], page_count: 0, page_types: {} };
    }

    const pagesExpected = extracted.page_count || 0;
    const pagesGot = (extracted.pages || []).length;
    const coverageOk = pagesExpected === 0 || pagesGot >= Math.floor(pagesExpected * 0.9);

    jlog(job, `Pages: ${pagesGot}/${pagesExpected} (${coverageOk ? 'OK ✓' : 'INCOMPLETE ⚠'}), text-tables: ${(extracted.tables || []).length}, image-pages: ${(extracted.image_table_pages || []).length}`);
    if (!coverageOk) jlog(job, `⚠ Page coverage ${pagesGot}/${pagesExpected} — some pages may have been skipped`);

    return {
        fullText: extracted.text || '',
        pages: extracted.pages || [],
        rawTables: extracted.tables || [],
        imageTablePages: extracted.image_table_pages || [],
        pageCount: pagesExpected,
        pagesGot,
        coverageOk,
        pageTypes: extracted.page_types || {},
    };
}

// ─── Phase 1: Understand — Claude Opus document map ──────────────────────────
const SYS_UNDERSTAND = `You are an expert Bureau of Indian Standards (IS) document analyst.
Read this IS standard and build a precise document map covering EVERY section, table, clause, footnote, and cross-reference.
CRITICAL: Do NOT invent page numbers, values, or column names. If you cannot determine something, set confidence < 0.7.
Return ONLY valid JSON — no markdown fences, no explanation.`;

async function phase1(job, p0) {
    setPhase(job, 1, 'Understanding structure — Claude Opus maps all sections, tables, cross-refs', 15);

    const textSample = p0.fullText.slice(0, 7000);
    const tableSummary = (p0.rawTables || []).slice(0, 10)
        .map(t => `Table p${t.page}: ${(t.headers || []).join(' | ')} (${t.row_count || 0} rows)`)
        .join('\n');
    const imagePgs = (p0.imageTablePages || []).map(p => p.page).join(', ') || 'none';

    const prompt = `IS Standard document text (first 7000 chars):\n${textSample}

Tables detected by pdfplumber:\n${tableSummary || 'None — likely image/scanned PDF'}
Pages needing vision rendering: ${imagePgs}
Total pages in PDF: ${p0.pageCount}

Build the complete document map. Return JSON exactly matching this schema:
{
  "isNumber": "IS 4985:2021",
  "title": "Full standard title from cover page",
  "scope": "One-sentence scope",
  "sections": ["dimensional", "physical", "chemical", "performance", "marking", "sampling"],
  "tables": [
    {
      "id": "T1",
      "page": 5,
      "type": "dimensional",
      "description": "Dimensions and tolerances — OD and wall thickness for each DN size",
      "orientation": "horizontal",
      "row_identifier": "DN (Nominal Size mm)",
      "page_span": [5, 6],
      "schema": {
        "key_col": "DN",
        "value_cols": ["Min OD","Max OD","Ovality max","Class 1 min","Class 1 max","Class 2 min","Class 2 max","Class 3 min","Class 3 max","Class 4 min","Class 4 max","Class 5 min","Class 5 max","Class 6 min","Class 6 max"]
      },
      "footnotes_on_page": ["All dimensions in mm", "Ovality = max-min diameter of any cross section"]
    }
  ],
  "cross_refs": [
    { "isNumber": "IS 4984", "clause": "7.1.1", "reason": "method for measuring OD" }
  ],
  "footnotes": ["All dimensions in mm unless stated", "Tolerances apply to mean OD"],
  "total_params_expected": 45,
  "clauses": [
    { "number": "5.1", "title": "Dimensions", "page": 3, "summary": "Dimensional requirements" }
  ],
  "confidence": 0.92
}`;

    let docMap = null;
    try {
        const raw = await orChat(MODEL_BRAIN, [
            { role: 'system', content: SYS_UNDERSTAND },
            { role: 'user', content: prompt },
        ], { maxTokens: 5000 });
        docMap = safeJSON(raw);
    } catch (e) {
        jlog(job, `⚠ Phase 1 Claude Opus failed: ${e.message} — using regex fallback`);
    }

    // Regex fallback: build minimal map from detected tables + text
    if (!docMap) {
        const isM = p0.fullText.match(/IS\s*[:\s]*([\d]{3,6})/);
        const titleM = p0.fullText.match(/Indian\s+Standard\s*\n+\s*(.+?)(?:\n|$)/i);
        docMap = {
            isNumber: isM ? `IS ${isM[1]}` : 'IS Standard',
            title: titleM ? titleM[1].trim() : filename,
            scope: '',
            sections: ['dimensional', 'physical'],
            tables: [
                ...(p0.rawTables || []).map((t, i) => ({
                    id: `T${i + 1}`, page: t.page, type: 'dimensional',
                    description: `Table on page ${t.page}`, orientation: 'horizontal',
                    row_identifier: (t.headers || [''])[0] || 'Parameter',
                    page_span: [t.page],
                    schema: { key_col: (t.headers || [''])[0], value_cols: (t.headers || []).slice(1) },
                    footnotes_on_page: [],
                })),
                ...(p0.imageTablePages || []).map((p, i) => ({
                    id: `IT${i + 1}`, page: p.page, type: 'dimensional',
                    description: `Image table on page ${p.page}`, orientation: 'horizontal',
                    row_identifier: 'Parameter', page_span: [p.page],
                    schema: {}, footnotes_on_page: [],
                })),
            ],
            cross_refs: [], footnotes: [], total_params_expected: 0,
            clauses: [], confidence: 0.3,
        };
        jlog(job, 'Used regex fallback for document map');
    }

    jlog(job, `Doc: ${docMap.isNumber} — "${docMap.title}" | ${(docMap.tables || []).length} tables | ${(docMap.clauses || []).length} clauses | confidence ${docMap.confidence}`);
    return docMap;
}

// ─── Phase 2: Extract — two vision readers per table ─────────────────────────
const SYS_READER = `You are a precision table reader for regulatory IS documents.
Read EVERY cell in the table EXACTLY as printed — no rounding, no inference, no gap-filling.
Empty cell → null. Unreadable cell → "UNREADABLE".
Numbers remain as strings (preserve exact decimal places as printed, e.g. "21.2" not 21.2).
The table may be HORIZONTAL (parameters in rows) or VERTICAL (parameters in columns) — read whatever is shown.
Return ONLY valid JSON, no other text.`;

async function readTableVision(tableInfo, pageImages, model, fallbackTextTable) {
    const imgEntry = pageImages.find(p => p.page === tableInfo.page && p.image_base64);

    // No image — fall back to pdfplumber text table
    if (!imgEntry) {
        if (fallbackTextTable) {
            return {
                table_id: tableInfo.id, source: 'pdfplumber_fallback',
                headers: fallbackTextTable.headers || [],
                rows: (fallbackTextTable.rows || []).map((row, i) => ({
                    key: row[0] || `Row${i + 1}`,
                    values: Object.fromEntries((fallbackTextTable.headers || []).slice(1).map((h, j) => [h, row[j + 1] ?? null])),
                })),
                notes: [], unreadable_cells: [],
            };
        }
        return { table_id: tableInfo.id, source: 'no_image', error: 'No page image available', rows: [] };
    }

    const orientHint = tableInfo.orientation === 'vertical'
        ? 'IMPORTANT: parameters are in COLUMNS here, not rows. Transpose to row-keyed output.'
        : 'Parameters are in rows.';
    const schemaHint = tableInfo.schema && tableInfo.schema.value_cols && tableInfo.schema.value_cols.length
        ? `Expected value columns: ${tableInfo.schema.value_cols.join(', ')}`
        : '';
    const footnoteHint = tableInfo.footnotes_on_page && tableInfo.footnotes_on_page.length
        ? `Footnotes on this page: ${tableInfo.footnotes_on_page.join('; ')}`
        : '';

    const prompt = `Table on page ${tableInfo.page}: ${tableInfo.description}
Type: ${tableInfo.type} | Row identifier: ${tableInfo.row_identifier}
${orientHint}
${schemaHint}
${footnoteHint}

Read EVERY row and column. Return JSON:
{
  "table_id": "${tableInfo.id}",
  "headers": ["col1", "col2", "..."],
  "rows": [
    { "key": "DN 20", "values": { "Min OD": "21.2", "Max OD": "21.4", "Class 1 min": "1.8", "Class 1 max": "2.2" } },
    { "key": "DN 25", "values": { "Min OD": "26.2", "Max OD": "26.4", "Class 1 min": "1.9", "Class 1 max": "2.3" } }
  ],
  "notes": ["any footnote markers observed in the table"],
  "unreadable_cells": [{ "row": "DN 20", "col": "Class 3 min", "reason": "ink smudge" }]
}`;

    try {
        const raw = await orVision(model, SYS_READER, prompt, imgEntry.image_base64, { maxTokens: 7000 });
        const parsed = safeJSON(raw);
        if (parsed) { parsed.source = model; return parsed; }
        return { table_id: tableInfo.id, source: model, error: 'JSON parse failed', raw: raw.slice(0, 200), rows: [] };
    } catch (e) {
        return { table_id: tableInfo.id, source: model, error: e.message, rows: [] };
    }
}

async function phase2(job, docMap, p0) {
    setPhase(job, 2, 'Extracting tables — Gemini + Qwen vision readers working in parallel', 30);

    // Collect all unique pages we need to render
    const neededPages = new Set();
    (docMap.tables || []).forEach(t => (t.page_span || [t.page]).forEach(p => neededPages.add(p)));
    (p0.imageTablePages || []).forEach(p => neededPages.add(p.page));

    // Build page-image map: start with images already rendered by Phase 0
    const pageImageMap = {};
    (p0.imageTablePages || []).forEach(p => {
        if (p.image_path) {
            try {
                pageImageMap[p.page] = { page: p.page, image_base64: fs.readFileSync(p.image_path, 'base64') };
                fs.unlink(p.image_path, () => {}); // clean temp file
            } catch (_) {}
        }
    });

    // Render any additional pages via Python at 300 DPI
    const toRender = [...neededPages].filter(p => !pageImageMap[p] && p > 0);
    if (toRender.length > 0 && job._tmpPath && fs.existsSync(job._tmpPath)) {
        jlog(job, `Rendering ${toRender.length} page(s) at 300 DPI for vision readers…`);
        try {
            const rendered = await pyRun('render_pages.py', [job._tmpPath, toRender.join(','), '300'], 120000);
            (rendered.pages || []).forEach(p => { if (p.image_base64) pageImageMap[p.page] = p; });
            jlog(job, `Rendered pages: ${Object.keys(pageImageMap).join(', ')}`);
        } catch (e) {
            jlog(job, `⚠ Page rendering failed: ${e.message} — vision reads will use pdfplumber fallback`);
        }
    }

    const pageImagesArr = Object.values(pageImageMap);
    const textTableByPage = {};
    (p0.rawTables || []).forEach(t => { if (!textTableByPage[t.page]) textTableByPage[t.page] = t; });

    const tables = docMap.tables || [];
    const results = [];

    for (let i = 0; i < tables.length; i++) {
        const tableInfo = tables[i];
        job.progress = 30 + Math.round((i / (tables.length || 1)) * 30);
        jlog(job, `Reading table ${tableInfo.id} (p${tableInfo.page}) with both readers…`);

        const [r1res, r2res] = await Promise.allSettled([
            readTableVision(tableInfo, pageImagesArr, MODEL_R1, textTableByPage[tableInfo.page]),
            readTableVision(tableInfo, pageImagesArr, MODEL_R2, textTableByPage[tableInfo.page]),
        ]);

        const reader1 = r1res.status === 'fulfilled' ? r1res.value : { error: r1res.reason?.message, rows: [], table_id: tableInfo.id };
        const reader2 = r2res.status === 'fulfilled' ? r2res.value : { error: r2res.reason?.message, rows: [], table_id: tableInfo.id };

        jlog(job, `  R1 (${MODEL_R1.split('/').pop()}): ${(reader1.rows || []).length} rows${reader1.error ? ' ⚠ ' + reader1.error.slice(0,60) : ''}`);
        jlog(job, `  R2 (${MODEL_R2.split('/').pop()}): ${(reader2.rows || []).length} rows${reader2.error ? ' ⚠ ' + reader2.error.slice(0,60) : ''}`);

        results.push({ tableInfo, reader1, reader2 });
    }

    return { results, pageImageMap };
}

// ─── Phase 3: Consensus + typed validators ───────────────────────────────────
function normVal(v) {
    if (v === null || v === undefined || String(v).trim() === '' || String(v).toLowerCase() === 'null') return null;
    return String(v).trim();
}

function numClose(a, b, tol = 0.015) {
    const na = parseFloat(a), nb = parseFloat(b);
    return !isNaN(na) && !isNaN(nb) && Math.abs(na - nb) <= tol;
}

function mergeRow(key, r1vals, r2vals, headers) {
    const agreed = {}, flagged = [];
    for (const col of headers) {
        const v1 = normVal(r1vals[col]);
        const v2 = normVal(r2vals[col]);
        if (v1 === null && v2 === null) { agreed[col] = null; continue; }
        if (v1 === v2) { agreed[col] = v1; continue; }
        if (v1 !== null && v2 !== null && numClose(v1, v2)) { agreed[col] = v1; continue; } // tiny float diff — use reader1 exact text
        flagged.push({
            key, col,
            reader1: v1, reader2: v2,
            reason: (v1 === null || v2 === null) ? 'one_reader_empty' : 'value_mismatch',
        });
        // Best guess for flagged: prefer non-null, or reader1
        agreed[col] = v1 !== null ? v1 : v2;
    }
    return { agreed, flagged };
}

function detectLimitType(minVal, maxVal, colName) {
    const hasMin = minVal !== null && minVal !== '' && minVal !== 'UNREADABLE';
    const hasMax = maxVal !== null && maxVal !== '' && maxVal !== 'UNREADABLE';
    // Hint from column name
    if (/max\s*only|maximum\s*only/i.test(colName)) return 'max_only';
    if (/min\s*only|minimum\s*only/i.test(colName)) return 'min_only';
    if (hasMin && hasMax) return 'two_sided';
    if (hasMax && !hasMin) return 'max_only';
    if (hasMin && !hasMax) return 'min_only';
    return 'qualitative';
}

function runTableValidators(consensusRows, headers) {
    const flags = [];
    // Identify min/max column pairs by matching base names
    const minCols = headers.filter(h => /\bmin\b/i.test(h));
    const maxCols = headers.filter(h => /\bmax\b/i.test(h));

    for (const row of consensusRows) {
        const v = row.values || {};
        for (const minCol of minCols) {
            // Find matching max: same base name
            const base = minCol.replace(/\bmin\b/i, '').trim();
            const matchedMax = maxCols.find(m => m.replace(/\bmax\b/i, '').trim() === base);
            if (!matchedMax) continue;
            const minNum = parseFloat(v[minCol]), maxNum = parseFloat(v[matchedMax]);
            if (!isNaN(minNum) && !isNaN(maxNum) && minNum > maxNum) {
                flags.push({
                    tableId: 'validator', page: null,
                    key: row.key, col: `${minCol}/${matchedMax}`,
                    reader1: null, reader2: null,
                    reason: `min_gt_max: ${minNum} > ${maxNum} (${base})`,
                    severity: 'error',
                });
            }
        }

        // Monotonicity check: for numeric keys (DN sizes), OD should increase
        // (done in validateDimensionGrid in phase 4 after Opus finalizes)
    }
    return flags;
}

function phase3(job, p2Output) {
    setPhase(job, 3, 'Building consensus — cell-by-cell agreement + deterministic validators', 65);

    const tableConsensus = [];
    const allFlagged = [];
    let totalAgreed = 0, totalCells = 0;

    for (const { tableInfo, reader1, reader2 } of p2Output.results) {
        const r1rows = reader1.rows || [];
        const r2rows = reader2.rows || [];
        const headers = reader1.headers || reader2.headers || [];

        // Build row lookup for reader2
        const r2Map = {};
        r2rows.forEach(r => { if (r.key != null) r2Map[String(r.key).trim()] = r.values || {}; });

        const consensusRows = [];
        let tAgreed = 0;

        for (const r1row of r1rows) {
            const key = String(r1row.key ?? '').trim();
            const r2vals = r2Map[key] || {};
            const { agreed, flagged } = mergeRow(key, r1row.values || {}, r2vals, headers);
            consensusRows.push({ key, values: agreed, hasFlagged: flagged.length > 0 });
            tAgreed += headers.length - flagged.length;
            flagged.forEach(f => allFlagged.push({ ...f, tableId: tableInfo.id, page: tableInfo.page }));
        }

        // Row-exists-in-r2-but-not-r1 (extra rows from reader2)
        const r1keys = new Set(r1rows.map(r => String(r.key ?? '').trim()));
        r2rows.forEach(r2row => {
            const key = String(r2row.key ?? '').trim();
            if (!r1keys.has(key) && key) {
                // Reader 2 found a row Reader 1 missed
                allFlagged.push({
                    tableId: tableInfo.id, page: tableInfo.page,
                    key, col: '(all)', reader1: null, reader2: JSON.stringify(r2row.values).slice(0, 100),
                    reason: 'reader2_extra_row',
                });
            }
        });

        // Validator: check min>max within agreed cells
        const valFlags = runTableValidators(consensusRows, headers);
        allFlagged.push(...valFlags);

        totalAgreed += tAgreed;
        totalCells += r1rows.length * headers.length;

        tableConsensus.push({
            tableId: tableInfo.id,
            page: tableInfo.page,
            type: tableInfo.type,
            description: tableInfo.description,
            headers,
            rows: consensusRows,
            agreementRate: r1rows.length ? tAgreed / Math.max(r1rows.length * headers.length, 1) : 0,
        });

        jlog(job, `Table ${tableInfo.id}: ${r1rows.length} rows, ${tAgreed}/${r1rows.length * headers.length} cells agreed, ${allFlagged.filter(f => f.tableId === tableInfo.id).length} flags`);
    }

    const overallAgreement = totalCells ? totalAgreed / totalCells : 0;
    jlog(job, `Consensus: ${totalAgreed}/${totalCells} cells agreed (${Math.round(overallAgreement * 100)}%), ${allFlagged.length} total flags`);

    return { tableConsensus, allFlagged, agreementRate: overallAgreement };
}

// ─── Phase 4: Finalize — Claude Opus assembles trusted output ─────────────────
const SYS_FINALIZE = `You are finalizing IS standard data extraction. You receive:
1. A document map (sections, tables, cross-references, footnotes)
2. Cell-by-cell consensus from two independent vision readers

Your job:
- Assemble agreed cells into section-aware flat parameter list
- Apply each clause's rounding rule EXACTLY as stated — never assume one
- One-sided limits (max only, min only) are legitimate — never fabricate a missing bound
- For cross-referenced ISes (e.g. "as per IS 4984"), record the reference but do NOT invent its values
- Flagged cells (reader disagreement) go into uncertainItems — NOT into test_parameters
Return ONLY valid JSON — no markdown fences.`;

async function phase4(job, docMap, p3Output, p0) {
    setPhase(job, 4, 'Finalizing — Claude Opus assembles trusted structured output', 78);

    const consensusSummary = p3Output.tableConsensus.slice(0, 8).map(tc => {
        const rowSample = tc.rows.slice(0, 5).map(r =>
            `  ${r.key}: ${Object.entries(r.values || {}).slice(0, 6).map(([c, v]) => `${c}=${v}`).join(', ')}`
        ).join('\n');
        return `Table ${tc.tableId} (${tc.type}, p${tc.page}), ${tc.rows.length} rows:\n${rowSample}`;
    }).join('\n\n');

    const flagSummary = p3Output.allFlagged.slice(0, 25).map(f =>
        `${f.tableId}/${f.key}/${f.col}: R1="${f.reader1}" R2="${f.reader2}" [${f.reason}]`
    ).join('\n');

    const docMapSnippet = JSON.stringify(docMap, null, 2).slice(0, 3500);

    const prompt = `Document Map:
${docMapSnippet}

Consensus Cell Values (what both readers agreed on):
${consensusSummary}

Flagged Cells (disagreement or validator error — must go into uncertainItems):
${flagSummary || 'None — all cells agreed!'}

Assemble final output. Return this JSON schema exactly:
{
  "isNumber": "IS 4985:2021",
  "title": "Unplasticized PVC Pipes for Potable Water Supply — Specification",
  "scope": "one sentence",
  "confidenceScore": 0.95,
  "sections": [
    {
      "name": "dimensional",
      "parameters": [
        {
          "clause": "Table 1",
          "param": "Outer Diameter",
          "variety": "DN 20",
          "min": "21.2",
          "max": "21.4",
          "unit": "mm",
          "limit_type": "two_sided",
          "rounding_rule": "nearest 0.1 mm as stated in Cl 5.1",
          "referenced_IS": [],
          "status": "ok",
          "confidence": 0.98
        }
      ]
    }
  ],
  "test_parameters": [
    { "clause": "Cl 5.1 / Table 1", "param": "OD — DN 20", "spec_val": "21.2 to 21.4 mm", "type": "Quantitative", "min": "21.2", "max": "21.4", "unit": "mm", "limit_type": "two_sided", "expected": "" }
  ],
  "dimension_data": {
    "description": "Nominal OD and wall thickness by DN size and class",
    "columns": ["Min OD","Max OD","Ovality max","C1 min","C1 max","C2 min","C2 max","C3 min","C3 max","C4 min","C4 max","C5 min","C5 max","C6 min","C6 max"],
    "rows": [
      { "key": "DN 20", "values": { "Min OD": "21.2", "Max OD": "21.4", "Ovality max": "0.4", "C1 min": "1.8", "C1 max": "2.2", "C2 min": "2.0", "C2 max": "2.4", "C3 min": "2.5", "C3 max": "3.0", "C4 min": "3.2", "C4 max": "3.8", "C5 min": "4.1", "C5 max": "4.9", "C6 min": "5.1", "C6 max": "6.1" } }
    ]
  },
  "referenced_standards": [
    { "isNumber": "IS 4984", "clause": "7.1.1", "reason": "OD measurement method", "inVault": false }
  ],
  "clauses": [
    { "clauseNumber": "5.1", "title": "Dimensions", "page": 3, "content": "Pipes shall conform to Table 1", "hasTable": true }
  ],
  "uncertainItems": [
    { "id": "u1", "page": 6, "tableId": "T1", "key": "DN 400", "col": "Class 5 max", "reader1": "25.4", "reader2": "25.3", "reason": "value_mismatch", "severity": "warn", "resolved": false, "userValue": "", "hasPageImage": true, "imagePage": 6 }
  ]
}`;

    let final = null;
    try {
        const raw = await orChat(MODEL_BRAIN, [
            { role: 'system', content: SYS_FINALIZE },
            { role: 'user', content: prompt },
        ], { maxTokens: 9000 });
        final = safeJSON(raw);
    } catch (e) {
        jlog(job, `⚠ Phase 4 Claude Opus failed: ${e.message} — using consensus-direct fallback`);
    }

    // Direct consensus fallback
    if (!final) {
        jlog(job, 'Building output directly from consensus (no Opus)');
        const flatParams = [];
        for (const tc of p3Output.tableConsensus) {
            for (const row of tc.rows) {
                Object.entries(row.values || {}).forEach(([col, val]) => {
                    flatParams.push({
                        clause: `${tc.tableId}`, param: col, variety: row.key,
                        spec_val: String(val ?? ''), type: 'Quantitative',
                        min: '', max: val, limit_type: 'max_only',
                        unit: '', status: 'ok', confidence: 0.7,
                    });
                });
            }
        }
        final = {
            isNumber: docMap.isNumber, title: docMap.title, scope: docMap.scope || '',
            confidenceScore: p3Output.agreementRate || 0.5,
            sections: [], test_parameters: flatParams,
            dimension_data: null, referenced_standards: docMap.cross_refs || [],
            clauses: docMap.clauses || [], uncertainItems: [],
        };
    }

    // Ensure uncertainItems includes all phase3 flags not already present
    const finalUncertain = final.uncertainItems || [];
    const existingIds = new Set(finalUncertain.map(u => `${u.tableId}/${u.key}/${u.col}`));
    let uIdx = finalUncertain.length;
    for (const f of p3Output.allFlagged) {
        const key = `${f.tableId}/${f.key}/${f.col}`;
        if (!existingIds.has(key)) {
            finalUncertain.push({
                id: `u_p3_${uIdx++}`,
                page: f.page, tableId: f.tableId, key: f.key, col: f.col,
                reader1: f.reader1, reader2: f.reader2, reason: f.reason,
                severity: f.severity || 'warn', detail: f.detail || '',
                resolved: false, userValue: '',
                hasPageImage: f.page != null, imagePage: f.page,
            });
        }
    }
    final.uncertainItems = finalUncertain;

    // Run full validateParameters on the finalized test_parameters
    try {
        const { validateParameters } = require('../agent/is-validators');
        const valFlags = validateParameters(final.test_parameters || []);
        if (valFlags.length) {
            jlog(job, `Validators flagged ${valFlags.length} parameter-level issues`);
            valFlags.forEach((f, i) => {
                final.uncertainItems.push({
                    id: `u_val_${uIdx++}`, page: null, tableId: 'validator',
                    key: f.ref, col: f.field, reader1: null, reader2: null,
                    reason: `validator:${f.rule}`, severity: f.severity,
                    detail: f.detail || '', resolved: false, userValue: '',
                    hasPageImage: false, imagePage: null,
                });
            });
        }
    } catch (ve) { jlog(job, `Validator step skipped: ${ve.message}`); }

    // ── ROW-LOSS FIX ──────────────────────────────────────────────────────────
    // Opus only saw a truncated sample (~5 rows/table) in its prompt, so its reproduced
    // dimension_data drops rows on big tables (e.g. IS 4985 Table 1 has 24 DN rows). The
    // Phase-3 consensus holds EVERY row — use it as the authoritative numeric grid.
    // Opus's sections / clauses / rounding rules remain as-is (the narrative it's good at).
    try {
        const dimTables = (p3Output.tableConsensus || []).map(tc => {
            const columns = [];
            (tc.rows || []).forEach(r => Object.keys(r.values || {}).forEach(c => { if (!columns.includes(c)) columns.push(c); }));
            return {
                tableId: tc.tableId, type: tc.type, page: tc.page, columns,
                rows: (tc.rows || []).map(r => ({ key: r.key, values: r.values || {} })),
                agreementRate: tc.agreementRate,
            };
        });
        const totalRows = dimTables.reduce((n, t) => n + t.rows.length, 0);
        final.dimension_data = {
            description: (final.dimension_data && final.dimension_data.description) || 'Extracted tolerance tables — full consensus grid, every row preserved',
            tables: dimTables,
        };
        jlog(job, `Row-loss fix: dimension_data rebuilt from full consensus — ${totalRows} rows across ${dimTables.length} table(s) (Opus prompt only saw ~5/table)`);
    } catch (ge) { jlog(job, `Grid rebuild skipped: ${ge.message}`); }

    jlog(job, `Final: ${(final.test_parameters || []).length} params, ${(final.uncertainItems || []).length} items need review, confidence ${final.confidenceScore}`);
    return final;
}

// ─── Phase 5: Vault ───────────────────────────────────────────────────────────
async function phase5(job, p4Final, p2Output, filename) {
    setPhase(job, 5, 'Persisting to vault — ready for human review of flagged cells', 90);

    // Mark which uncertain items have a page image available for the confirm UI
    const pagesWithImage = new Set(Object.keys(p2Output.pageImageMap || {}).map(Number));
    (p4Final.uncertainItems || []).forEach(item => {
        item.hasPageImage = item.imagePage != null && pagesWithImage.has(item.imagePage);
    });

    const supabase = require('../../database-supabase');
    const { data, error } = await supabase.from('is_standards_vault').upsert({
        isNumber: p4Final.isNumber,
        title: p4Final.title,
        pdfFileName: filename,
        rawExtractedContext: JSON.stringify(
            (p2Output.results || []).map(r => ({
                tableId: r.tableInfo.id, page: r.tableInfo.page,
                type: r.tableInfo.type, description: r.tableInfo.description,
            }))
        ),
        extractedClauses: JSON.stringify(p4Final.clauses || []),
        extractedTables: JSON.stringify(
            (p2Output.results || []).map(r => ({
                tableId: r.tableInfo.id, page: r.tableInfo.page,
                headers: r.reader1?.headers || r.reader2?.headers || [],
                row_count: (r.reader1?.rows || []).length,
                agreement_rate: (p2Output.tableConsensus || []).find(tc => tc.tableId === r.tableInfo.id)?.agreementRate || 0,
            }))
        ),
        dimensionData: JSON.stringify(p4Final.dimension_data || null),
        testParameters: JSON.stringify({
            version: 3,
            flat: p4Final.test_parameters || [],
            sections: p4Final.sections || [],
            referenced_standards: p4Final.referenced_standards || [],
        }),
        uncertainItems: JSON.stringify(p4Final.uncertainItems || []),
        isFullyResolved: (p4Final.uncertainItems || []).every(u => u.resolved),
        confidenceScore: p4Final.confidenceScore || 0,
    }, { onConflict: 'isNumber' }).select('id').single();

    if (error) throw new Error(`Vault save failed: ${error.message}`);

    jlog(job, `Saved to vault id=${data.id}, ${(p4Final.uncertainItems || []).filter(u => !u.resolved).length} items pending review`);
    return { vaultId: data.id, isNumber: p4Final.isNumber };
}

// ─── Phase 6: Calibrate against specs_db.js baseline ─────────────────────────
async function phase6(job, p4Final) {
    const normIS = String(p4Final.isNumber || '').toUpperCase().replace(/\s+/g, '');
    if (!normIS.includes('4985')) {
        setPhase(job, 6, 'Calibration skipped — baseline is IS 4985 only', 98);
        jlog(job, 'Phase 6: skipped (not IS 4985)');
        return null;
    }

    setPhase(job, 6, 'Calibrating against hand-verified IS 4985 specs_db.js baseline', 94);

    try {
        const specsPath = path.join(__dirname, '../../public/specs_db.js');
        if (!fs.existsSync(specsPath)) {
            jlog(job, 'Phase 6: specs_db.js not found — skipped');
            return null;
        }
        const specsContent = fs.readFileSync(specsPath, 'utf8');

        // Extract IS 4985 sizes_db from the JS file
        // Pattern: IS_4985_SPECS = { sizes_db: { 20: { min_od: X, max_od: Y, ... }, ... } }
        const sizesDbMatch = specsContent.match(/sizes_db\s*:\s*(\{[\s\S]*?\})\s*[,}]/);
        if (!sizesDbMatch) {
            jlog(job, 'Phase 6: could not parse sizes_db from specs_db.js — skipped');
            return null;
        }

        // Safe eval of the object literal (it's local, trusted)
        let sizesDb = null;
        try {
            // eslint-disable-next-line no-new-func
            sizesDb = new Function('return ' + sizesDbMatch[1])();
        } catch (_) {}
        if (!sizesDb) {
            jlog(job, 'Phase 6: could not evaluate sizes_db — skipped');
            return null;
        }

        const dimData = p4Final.dimension_data;
        if (!dimData || !dimData.rows || dimData.rows.length === 0) {
            jlog(job, 'Phase 6: no dimension_data in extraction — skipped');
            return null;
        }

        // Field mapping: specs_db key → extracted column alias patterns
        const colAliases = {
            min_od: ['min od', 'min_od', 'dn min', 'minimum od', 'od min'],
            max_od: ['max od', 'max_od', 'dn max', 'maximum od', 'od max'],
        };

        function findColVal(rowVals, fieldAliases) {
            const keys = Object.keys(rowVals).map(k => k.toLowerCase().trim());
            for (const alias of fieldAliases) {
                const idx = keys.findIndex(k => k.includes(alias));
                if (idx !== -1) return Object.values(rowVals)[idx];
            }
            return null;
        }

        let matched = 0, mismatched = 0;
        const diffs = [];

        for (const row of dimData.rows) {
            const keyStr = String(row.key || '');
            const dnMatch = keyStr.match(/\d+/);
            if (!dnMatch) continue;
            const dn = parseInt(dnMatch[0]);
            const spec = sizesDb[dn];
            if (!spec) continue;

            for (const [field, aliases] of Object.entries(colAliases)) {
                const specVal = parseFloat(spec[field]);
                if (isNaN(specVal)) continue;
                const extractedRaw = findColVal(row.values || {}, aliases);
                if (extractedRaw == null) continue;
                const extractedVal = parseFloat(extractedRaw);
                if (isNaN(extractedVal)) continue;

                if (Math.abs(extractedVal - specVal) <= 0.05) {
                    matched++;
                } else {
                    mismatched++;
                    diffs.push({
                        key: `DN ${dn}`, field,
                        extracted: extractedVal, specs_db: specVal,
                        diff: +(extractedVal - specVal).toFixed(3),
                        pipelineIsRight: null, // OIC decides
                    });
                }
            }
        }

        const total = matched + mismatched;
        const accuracy = total ? Math.round(matched / total * 1000) / 10 : null;
        jlog(job, `Phase 6: ${matched}/${total} cells match specs_db.js → ${accuracy}% accuracy`);
        if (diffs.length) diffs.forEach(d => jlog(job, `  ${d.key}.${d.field}: extracted=${d.extracted}, specs_db=${d.specs_db} (Δ${d.diff > 0 ? '+' : ''}${d.diff})`));

        return {
            accuracy, matched, mismatched, total,
            diffs,
            message: mismatched === 0
                ? '✅ Perfect match with specs_db.js'
                : `⚠ ${mismatched} cell(s) differ — pipeline vs specs_db.js (${accuracy}% match). Diffs may reveal specs_db typos.`,
        };
    } catch (e) {
        jlog(job, `Phase 6 error: ${e.message}`);
        return { error: e.message };
    }
}

// ─── Cleanup helpers ──────────────────────────────────────────────────────────
function cleanupJob(job) {
    if (job._tmpPath) { try { fs.unlinkSync(job._tmpPath); } catch (_) {} job._tmpPath = null; }
}

// ─── Main pipeline runner ─────────────────────────────────────────────────────
async function runPipeline(jobId, buffer, filename) {
    const job = jobs.get(jobId);
    if (!job) return;

    try {
        const p0 = await phase0(job, buffer, filename);

        // Abort early if no text and no image pages
        if (p0.pagesGot === 0 && p0.imageTablePages.length === 0) {
            throw new Error('Could not extract any content from this PDF — it may be corrupted or encrypted');
        }

        const docMap = await phase1(job, p0);
        const p2 = await phase2(job, docMap, p0);
        const p3 = phase3(job, p2);
        const p4 = await phase4(job, docMap, p3, p0);
        const { vaultId, isNumber } = await phase5(job, p4, p2, filename);
        const calibration = await phase6(job, p4);

        cleanupJob(job);

        job.status = 'done';
        job.phase = 6;
        job.phaseLabel = 'Complete ✅';
        job.progress = 100;
        job.result = {
            vaultId,
            isNumber: p4.isNumber,
            title: p4.title,
            confidenceScore: p4.confidenceScore,
            pagesTotal: p0.pageCount,
            pagesProcessed: p0.pagesGot,
            tablesFound: (docMap.tables || []).length,
            paramsExtracted: (p4.test_parameters || []).length,
            uncertainCount: (p4.uncertainItems || []).filter(u => !u.resolved).length,
            agreementRate: p3.agreementRate,
            calibration,
        };

        jlog(job, `✅ Pipeline complete — vault:${vaultId}, ${job.result.paramsExtracted} params, ${job.result.uncertainCount} need confirm, agreement:${Math.round(p3.agreementRate * 100)}%`);

    } catch (e) {
        cleanupJob(job);
        job.status = 'error';
        job.error = e.message;
        job.phaseLabel = `Error: ${e.message.slice(0, 80)}`;
        jlog(job, `❌ Pipeline error: ${e.message}`);
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────
module.exports = {
    /** Start a pipeline job. Returns jobId immediately; pipeline runs async. */
    startPipeline(buffer, filename) {
        const jobId = crypto.randomBytes(8).toString('hex');
        newJob(jobId, filename);
        setImmediate(() => runPipeline(jobId, buffer, filename));
        return jobId;
    },

    /** Get current job state (status, phase, progress, log, result). */
    getJob(jobId) {
        const job = jobs.get(jobId);
        if (!job) return null;
        // Return safe copy without internal fields
        return {
            id: job.id, filename: job.filename,
            status: job.status, phase: job.phase,
            phaseLabel: job.phaseLabel, progress: job.progress,
            log: job.log.slice(-50), // last 50 log lines
            result: job.result, error: job.error,
            startedAt: job.startedAt,
            elapsedMs: Date.now() - job.startedAt,
        };
    },

    /** List all jobs (for admin). */
    listJobs() {
        return [...jobs.values()].map(j => ({
            id: j.id, filename: j.filename, status: j.status,
            phase: j.phase, progress: j.progress, startedAt: j.startedAt,
        }));
    },
};
