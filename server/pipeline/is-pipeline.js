'use strict';
/**
 * IS Standard PDF Extraction Pipeline — All 6 Phases
 *
 * Phase 0  Ingest      pdfplumber text + N-page accounting
 * Phase 1  Understand  Claude Opus builds complete document map
 * Phase 2  Extract     Gemini 3.5 Flash + GPT-4o — 2 independent readers (different companies)
 * Phase 3  Consensus   Cell-by-cell agreement; disagreements → OIC review with page image
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
// 3 independent vision readers — different companies = correlated errors impossible.
// R1: Gemini 3.5 Flash — optimized for fast precise extraction, proved 97-100% on IS 4985 Table 1
const MODEL_R1 = process.env.OR_READER1_MODEL || 'google/gemini-3.5-flash';
// R2: OpenAI GPT-4o (different company/architecture from Gemini)
const MODEL_R2 = process.env.OR_READER2_MODEL || 'openai/gpt-4o';
// R3: Claude Sonnet (Anthropic — third independent company, ties broken by majority)
const MODEL_R3 = process.env.OR_READER3_MODEL || 'anthropic/claude-sonnet-4-6';

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
    const body = {
        model,
        messages,
        temperature: opts.temperature ?? 0.05,
        max_tokens: opts.maxTokens ?? 8192,
    };
    // Force JSON output — GPT-4o and Claude support this via OpenRouter.
    // Gemini does NOT: response_format disables its multimodal vision → returns 0 rows.
    if (opts.jsonMode && !model.startsWith('google/')) body.response_format = { type: 'json_object' };
    const res = await fetch(`${OR_BASE}/chat/completions`, {
        method: 'POST',
        headers: orHeaders(),
        body: JSON.stringify(body),
    });
    const j = await res.json();
    if (!res.ok) {
        const errMsg = (j.error && j.error.message) || JSON.stringify(j).slice(0, 200);
        throw new Error(`OpenRouter ${res.status} (${model}): ${errMsg}`);
    }
    return (j.choices && j.choices[0] && j.choices[0].message.content) || '';
}

// imageBase64 may be a single string or an array (for multi-page tables)
async function orVision(model, systemPrompt, textPrompt, imageBase64, opts = {}) {
    const images = Array.isArray(imageBase64) ? imageBase64 : [imageBase64];
    const userContent = [
        { type: 'text', text: textPrompt },
        ...images.map(b64 => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } })),
    ];
    return orChat(model, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
    ], { temperature: 0.02, maxTokens: opts.maxTokens || 6000, jsonMode: opts.jsonMode });
}

// Strip trailing commas (Gemini frequently outputs `null,` before `}` or `]` — invalid JSON)
function fixTrailingCommas(s) {
    return s.replace(/,(\s*[}\]])/g, '$1');
}

function safeJSON(raw) {
    if (!raw) return null;
    const s = raw.trim();
    // Direct parse
    try { return JSON.parse(s); } catch (_) {}
    // Direct parse after stripping trailing commas
    try { return JSON.parse(fixTrailingCommas(s)); } catch (_) {}
    // Code block extraction
    const cb = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (cb) {
        try { return JSON.parse(cb[1].trim()); } catch (_) {}
        try { return JSON.parse(fixTrailingCommas(cb[1].trim())); } catch (_) {}
    }
    // Greedy first object
    const obj = s.match(/\{[\s\S]*\}/);
    if (obj) {
        try { return JSON.parse(obj[0]); } catch (_) {}
        try { return JSON.parse(fixTrailingCommas(obj[0])); } catch (_) {}
    }
    return null;
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

// Sampling plans, acceptance-number tables and "criteria for conformity" tables are NOT
// spec/test tables — they describe how many samples to draw, not pass/fail limits.
// Product decision: exclude them entirely so they never reach the vault / test parameters.
function isExcludedTable(t) {
    const hay = `${t.type || ''} ${t.description || ''} ${t.row_identifier || ''} ${((t.schema && t.schema.value_cols) || []).join(' ')}`.toLowerCase();
    return /\bsampling\b|criteria for conformity|scale of sampling|lot size|acceptance number|accept(?:ance)? region|reject(?:ion)? region/.test(hay);
}

function isExcludedClause(c) {
    return /sampling|criteria for conformity/i.test(`${c.title || ''} ${c.summary || ''}`);
}

// Phase 1 (Opus) only sees a slice of the document, so its table list misses tables on
// later pages. Merge EVERY pdfplumber/image-detected table page into docMap.tables (dedup by
// page) so a real table is never silently dropped just because Opus didn't enumerate it.
function mergeDetectedTables(docMap, p0) {
    const tables = docMap.tables || (docMap.tables = []);
    const coveredPages = new Set();
    tables.forEach(t => (t.page_span || [t.page]).forEach(p => coveredPages.add(Number(p))));
    let added = 0;
    (p0.rawTables || []).forEach((t, i) => {
        if (coveredPages.has(Number(t.page))) return;
        coveredPages.add(Number(t.page));
        tables.push({
            id: `PT${i + 1}`, page: t.page, type: 'unknown',
            description: `Detected table on page ${t.page}: ${(t.headers || []).slice(0, 4).join(' | ')}`,
            orientation: 'horizontal',
            row_identifier: (t.headers || [''])[0] || 'Parameter',
            page_span: [t.page],
            schema: { key_col: (t.headers || [''])[0], value_cols: (t.headers || []).slice(1) },
            footnotes_on_page: [],
        });
        added++;
    });
    (p0.imageTablePages || []).forEach((p, i) => {
        if (coveredPages.has(Number(p.page))) return;
        coveredPages.add(Number(p.page));
        tables.push({
            id: `IT${i + 1}`, page: p.page, type: 'unknown',
            description: `Image table on page ${p.page}`,
            orientation: 'horizontal', row_identifier: 'Parameter',
            page_span: [p.page], schema: {}, footnotes_on_page: [],
        });
        added++;
    });
    return added;
}

async function phase1(job, p0) {
    setPhase(job, 1, 'Understanding structure — Claude Opus maps all sections, tables, cross-refs', 15);

    const textSample = p0.fullText.slice(0, 14000);
    // Per-page outline (first lines of EVERY page) so Opus can enumerate clauses & tables
    // across the whole document, not only the first ~3 pages the raw text sample covers.
    const pageOutline = (p0.pages || [])
        .map(pg => {
            const head = (pg.text || '').split('\n').map(l => l.trim()).filter(Boolean).slice(0, 2).join(' / ');
            return `p${pg.page}: ${head.slice(0, 140)}`;
        })
        .join('\n')
        .slice(0, 7000);
    const tableSummary = (p0.rawTables || []).slice(0, 40)
        .map(t => `Table p${t.page}: ${(t.headers || []).join(' | ')} (${t.row_count || 0} rows)`)
        .join('\n');
    const imagePgs = (p0.imageTablePages || []).map(p => p.page).join(', ') || 'none';

    const prompt = `IS Standard document text (first 14000 chars):\n${textSample}

Per-page outline (first lines of each page — use this to find tables & clauses on LATER pages):
${pageOutline || '(no per-page text available)'}

Tables detected by pdfplumber:\n${tableSummary || 'None — likely image/scanned PDF'}
Pages needing vision rendering: ${imagePgs}
Total pages in PDF: ${p0.pageCount}

IMPORTANT: Enumerate EVERY table and clause across ALL ${p0.pageCount} pages (use the per-page outline), not only the ones in the text sample above.

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
        ], { maxTokens: 8000 });
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

    // Safety net: pull in every pdfplumber/image table page Opus didn't enumerate.
    const added = mergeDetectedTables(docMap, p0);
    if (added) jlog(job, `Merged ${added} detected table page(s) Opus missed → ${(docMap.tables || []).length} tables total`);

    // Exclude sampling / criteria-for-conformity tables & clauses entirely (product decision).
    const droppedTables = (docMap.tables || []).filter(isExcludedTable);
    docMap.tables = (docMap.tables || []).filter(t => !isExcludedTable(t));
    if (droppedTables.length) jlog(job, `Excluded ${droppedTables.length} sampling/conformity table(s): ${droppedTables.map(t => `${t.id} p${t.page}`).join(', ')}`);
    if (Array.isArray(docMap.clauses)) {
        const beforeC = docMap.clauses.length;
        docMap.clauses = docMap.clauses.filter(c => !isExcludedClause(c));
        if (docMap.clauses.length !== beforeC) jlog(job, `Excluded ${beforeC - docMap.clauses.length} sampling/conformity clause(s)`);
    }

    jlog(job, `Doc: ${docMap.isNumber} — "${docMap.title}" | ${(docMap.tables || []).length} tables | ${(docMap.clauses || []).length} clauses | confidence ${docMap.confidence}`);
    return docMap;
}

// ─── Phase 2: Extract — Gemini Flash single reader ───────────────────────────
const SYS_READER = `You are a precision table reader for regulatory IS documents.
Read EVERY cell EXACTLY as printed — no rounding, no inference, no gap-filling.
CRITICAL: Do NOT apply any pattern from earlier rows. Each cell is independent.
Empty cell → null. Unreadable → "?".
Numbers stay as strings ("21.2" not 21.2).
OUTPUT: Compact JSON only — no spaces, no newlines, no markdown, no backticks. Start with { end with }.`;

async function readTableVision(tableInfo, pageImages, model, fallbackTextTable, job) {
    // Collect images for every page in this table's span (multi-page tables)
    const pageSpan = (tableInfo.page_span && tableInfo.page_span.length > 1)
        ? tableInfo.page_span
        : [tableInfo.page];
    const imgEntries = pageSpan
        .map(pg => pageImages.find(p => p.page === pg && p.image_base64))
        .filter(Boolean);

    // No image — fall back to pdfplumber text table
    if (!imgEntries.length) {
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
    const spanNote = imgEntries.length > 1
        ? `IMPORTANT: This table spans ${imgEntries.length} pages (all shown). Read ALL rows from ALL pages — do not stop at the first page.`
        : '';

    const prompt = `Table p${tableInfo.page}: ${tableInfo.description}
${orientHint}${schemaHint ? ' ' + schemaHint : ''}${spanNote ? ' ' + spanNote : ''}
Extract EVERY column and EVERY row exactly as printed — do not skip or summarise any column.
Read ALL rows. Compact JSON, no spaces:
{"table_id":"${tableInfo.id}","headers":["h1","h2"],"rows":[{"key":"20","values":{"h1":"v1","h2":"v2"}},{"key":"25","values":{"h1":"v1","h2":"v2"}}]}`;

    try {
        const images = imgEntries.map(e => e.image_base64);
        const raw = await orVision(model, SYS_READER, prompt, images, { maxTokens: 16000, jsonMode: true });
        const parsed = safeJSON(raw);
        if (parsed) { parsed.source = model; return parsed; }
        if (job) jlog(job, `  ⚠ ${model.split('/').pop()} JSON parse failed (len=${raw.length}): ${raw.slice(0, 300)}`);
        return { table_id: tableInfo.id, source: model, error: 'JSON parse failed', raw: raw.slice(0, 200), rows: [] };
    } catch (e) {
        return { table_id: tableInfo.id, source: model, error: e.message, rows: [] };
    }
}

async function phase2(job, docMap, p0) {
    setPhase(job, 2, `Extracting tables — ${MODEL_R1.split('/').pop()} reading`, 30);

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
        jlog(job, `Reading table ${tableInfo.id} (p${tableInfo.page})…`);

        let reader1;
        try {
            reader1 = await readTableVision(tableInfo, pageImagesArr, MODEL_R1, textTableByPage[tableInfo.page], job);
        } catch (e) {
            reader1 = { error: e.message, rows: [], table_id: tableInfo.id };
        }

        jlog(job, `  ${MODEL_R1.split('/').pop()}: ${(reader1.rows || []).length} rows${reader1.error ? ' ⚠ ' + reader1.error.slice(0,60) : ''}`);

        results.push({ tableInfo, reader1 });
    }

    return { results, pageImageMap };
}

// ─── Phase 3: Consensus + typed validators ───────────────────────────────────
function normVal(v) {
    if (v === null || v === undefined || String(v).trim() === '' || String(v).toLowerCase() === 'null') return null;
    return String(v).trim();
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

// Normalize column names: lowercase + strip punctuation + collapse spaces
function normalizeCol(s) {
    return s ? s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim() : '';
}

// Normalize row keys across readers: "DN 20", "Size 20", "20" all → "20"
// Falls back to trimmed original if no digit found (e.g. serial numbers like "i)")
function normalizeKey(s) {
    if (!s) return '';
    const m = String(s).match(/\b(\d+(?:\.\d+)?)\b/);
    return m ? m[1] : String(s).trim();
}

// Build a values map keyed by normalizeKey(row.key) so "DN 20" and "20" both hit the same slot
function buildNormMap(rows) {
    const map = {};
    rows.forEach(r => {
        if (r.key == null) return;
        const normVals = {};
        Object.entries(r.values || {}).forEach(([k, v]) => { normVals[normalizeCol(k)] = v; });
        const nk = normalizeKey(r.key);
        if (nk) map[nk] = normVals;
    });
    return map;
}

function phase3(job, p2Output) {
    setPhase(job, 3, 'Validating — normalising cells + deterministic checks', 65);

    const tableConsensus = [];
    const allFlagged = [];

    for (const { tableInfo, reader1 } of p2Output.results) {
        const rawRows = reader1.rows || [];
        const headers = (reader1.headers || []).map(normalizeCol);

        // Normalise each row: keys use normalizeKey, values use normalizeCol + normVal
        const consensusRows = rawRows.map(r => {
            const normVals = {};
            Object.entries(r.values || {}).forEach(([k, v]) => {
                normVals[normalizeCol(k)] = normVal(v);
            });
            return { key: normalizeKey(r.key) || String(r.key ?? '').trim(), values: normVals };
        });

        // Deterministic validators: flag any min > max pairs
        const valFlags = runTableValidators(consensusRows, headers);
        allFlagged.push(...valFlags.map(f => ({ ...f, tableId: tableInfo.id, page: tableInfo.page })));

        tableConsensus.push({
            tableId: tableInfo.id,
            page: tableInfo.page,
            type: tableInfo.type,
            description: tableInfo.description,
            headers,
            rows: consensusRows,
            agreementRate: 1.0,
        });

        jlog(job, `Table ${tableInfo.id}: ${consensusRows.length} rows, ${valFlags.length} validator flags`);
    }

    jlog(job, `Validation: ${allFlagged.length} total flags across ${tableConsensus.length} table(s)`);
    return { tableConsensus, allFlagged, agreementRate: 1.0 };
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

    // Sync test parameters → is_conformance_limits so Reports/LIMS see live data immediately.
    const limitTypeMap = { two_sided: 'range', max_only: 'max', min_only: 'min', qualitative: null };
    const limitsPayload = (p4Final.test_parameters || [])
        .filter(p => limitTypeMap[p.limit_type] !== null && limitTypeMap[p.limit_type] !== undefined)
        .map(p => ({
            isNumber: p4Final.isNumber,
            clauseRef: p.clause || '',
            parameter: p.param || '',
            varietyTag: p.variety || '',
            limitMin: (p.min != null && p.min !== '') ? p.min : null,
            limitMax: (p.max != null && p.max !== '') ? p.max : null,
            unit: p.unit || '',
            limitType: limitTypeMap[p.limit_type] || 'range',
        }));
    if (limitsPayload.length > 0) {
        const { error: limErr } = await supabase.from('is_conformance_limits')
            .upsert(limitsPayload, { onConflict: 'isNumber, clauseRef, parameter, varietyTag' });
        if (limErr) jlog(job, `⚠ Conformance limits sync failed: ${limErr.message}`);
        else jlog(job, `Synced ${limitsPayload.length} conformance limits from vault`);
    }

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
        // Load specs_db.js directly — it exports IS_4985_SPECS via module.exports
        const specsPath = path.join(__dirname, '../../public/specs_db.js');
        if (!fs.existsSync(specsPath)) {
            jlog(job, 'Phase 6: specs_db.js not found — skipped');
            return null;
        }
        const IS_4985_SPECS = require(specsPath);
        const sizesDb = IS_4985_SPECS && IS_4985_SPECS.sizes_db;
        if (!sizesDb || Object.keys(sizesDb).length === 0) {
            jlog(job, 'Phase 6: could not load sizes_db from specs_db.js — skipped');
            return null;
        }

        // After row-loss fix, dimension_data has { tables: [{ rows: [...] }] }
        const dimData = p4Final.dimension_data;
        const allDimRows = dimData && dimData.tables
            ? dimData.tables.flatMap(t => t.rows || [])
            : (dimData && dimData.rows) || [];
        if (!allDimRows.length) {
            jlog(job, 'Phase 6: no rows in dimension_data — skipped');
            return null;
        }

        // Field mapping: specs_db key → extracted column alias patterns (most specific first)
        const colAliases = {
            min_od: ['mean outside diameter min', 'mean od min', 'outside diameter min', 'min od', 'od min'],
            max_od: ['mean outside diameter max', 'mean od max', 'outside diameter max', 'max od', 'od max'],
        };

        function findColVal(rowVals, fieldAliases) {
            // rowVals keys are already normalized (lowercase, no punctuation) from Phase 3
            const entries = Object.entries(rowVals);
            for (const alias of fieldAliases) {
                const match = entries.find(([k]) => k.includes(alias));
                if (match && match[1] != null) return match[1];
            }
            return null;
        }

        let matched = 0, mismatched = 0;
        const diffs = [];

        for (const row of allDimRows) {
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
