// SPIKE: new extraction approach on IS 13592:2013.
// Whole-doc read (Gemini 3.5 Flash, every page) -> structure (Opus 4.8) -> clause-by-clause params.
// Goal: see if it reproduces the real report's ~14 clause-numbered parameters + limits.
require('dotenv').config();
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PDF = '/Users/saurabh/Downloads/IS 13592 _ 2013.pdf';
const KEY = process.env.OPENROUTER_API_KEY;
const OR = 'https://openrouter.ai/api/v1/chat/completions';
const READER = 'google/gemini-3.5-flash';
const BRAIN = 'anthropic/claude-opus-4.8';
const SCRIPTS = path.join(__dirname, '../scripts');
const MAX_PAGES = 32;
const CONCURRENCY = 4;

if (!KEY) { console.error('No OPENROUTER_API_KEY in env'); process.exit(1); }

function pyRender(pages, dpi = 220) {
  return new Promise((resolve, reject) => {
    const py = spawn('python3', [path.join(SCRIPTS, 'render_pages.py'), PDF, pages.join(','), String(dpi)]);
    let out = '', err = '';
    py.stdout.on('data', d => out += d); py.stderr.on('data', d => err += d);
    py.on('close', c => { if (c !== 0) return reject(new Error(err.slice(0, 300))); try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
  });
}

async function orCall(model, messages, opts = {}) {
  const body = { model, messages, temperature: opts.temp ?? 0.05, max_tokens: opts.max ?? 8000 };
  if (opts.json && !model.startsWith('google/')) body.response_format = { type: 'json_object' };
  const r = await fetch(OR, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost:3030', 'X-Title': 'spike-13592' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${model} ${r.status}: ${JSON.stringify(j.error || j).slice(0, 220)}`);
  return j.choices[0].message.content;
}

function pageCount() {
  const out = execSync(`python3 -c "import pdfplumber,sys; print(len(pdfplumber.open(sys.argv[1]).pages))" "${PDF}"`).toString().trim();
  return parseInt(out, 10);
}

const READER_SYS = `You are reading ONE page of an Indian Standard (IS) specification. Transcribe EVERYTHING on the page faithfully:
- all prose, keeping clause numbers exactly (e.g. "7.1.1", "8.2", "11");
- every table rendered as markdown with ALL header rows, ALL data rows, ALL columns.
Do NOT summarise, infer, round, or skip. If a table is rotated, read it anyway. Output plain text / markdown only.`;

async function readPage(pageNum) {
  let img;
  try { const r = await pyRender([pageNum], 220); img = (r.pages || []).find(p => p.image_base64); }
  catch (e) { return `\n\n=== PAGE ${pageNum}: render error ${e.message} ===\n`; }
  if (!img) return `\n\n=== PAGE ${pageNum}: (no image) ===\n`;
  const content = [
    { type: 'text', text: `Transcribe page ${pageNum} of this IS standard fully (all prose with clause numbers + every table).` },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${img.image_base64}` } },
  ];
  try {
    const txt = await orCall(READER, [{ role: 'system', content: READER_SYS }, { role: 'user', content }], { max: 6000, temp: 0.02 });
    process.stderr.write(`  read page ${pageNum} (${txt.length} chars)\n`);
    return `\n\n=== PAGE ${pageNum} ===\n${txt}`;
  } catch (e) {
    return `\n\n=== PAGE ${pageNum}: reader error ${e.message} ===\n`;
  }
}

const BRAIN_SYS = `You are a Bureau of Indian Standards testing-report analyst. From the full transcription of an IS specification, produce a clause-by-clause list of EVERY testing parameter needed for a conformance test report.
Rules:
- Use the REAL clause number for each parameter (e.g. "Cl 7.1", "Cl 8.2") — NEVER a table name like "Table 3".
- For each: limitType one of max|min|range|qualitative|text, with numeric min/max + unit where applicable.
- variesBy: subset of ["size","class","type","socket"] — dimensional params vary by size (and type/socket); physical/mechanical are usually constant ([]).
- testMethod: the referenced IS for HOW to test (e.g. "IS 12235 (Part 5)") — keep SEPARATE from the requirement, as metadata.
- acceptanceOrType: "acceptance" for routine acceptance tests, "type" for type tests.
- For qualitative params, expected = the pass condition (e.g. "Satisfactory").
- Include ALL testing parameters (acceptance AND type). Drop none.
- If unsure whether something is a testing parameter, include it with needsReview=true.
Return ONLY JSON (no markdown fences):
{"isNumber":"","title":"","parameterizationDims":[],"parameters":[{"clauseRef":"","section":"","parameterName":"","limitType":"","min":"","max":"","unit":"","variesBy":[],"specText":"","expected":"","testMethod":"","referencedIS":[],"acceptanceOrType":"","needsReview":false}]}`;

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

(async () => {
  const t0 = Date.now();
  const total = pageCount();
  const pages = Array.from({ length: Math.min(total, MAX_PAGES) }, (_, i) => i + 1);
  console.error(`IS 13592 has ${total} pages; reading ${pages.length} with ${READER.split('/').pop()} (concurrency ${CONCURRENCY})…`);

  const parts = await pool(pages, CONCURRENCY, p => readPage(p));
  const transcript = parts.join('');
  fs.writeFileSync(path.join(__dirname, 'spike_13592_transcript.md'), transcript);
  console.error(`Transcript: ${transcript.length} chars. Structuring with ${BRAIN.split('/').pop()}…`);

  let raw;
  try {
    raw = await orCall(BRAIN, [
      { role: 'system', content: BRAIN_SYS },
      { role: 'user', content: `Full transcription of IS 13592:2013:\n\n${transcript.slice(0, 60000)}` },
    ], { max: 12000, temp: 0.05, json: true });
  } catch (e) { console.error('Opus error:', e.message); process.exit(1); }

  let parsed;
  try { parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()); }
  catch (e) { console.error('Could not parse Opus JSON; raw saved.'); fs.writeFileSync(path.join(__dirname, 'spike_13592_raw.txt'), raw); process.exit(1); }

  fs.writeFileSync(path.join(__dirname, 'spike_13592_out.json'), JSON.stringify(parsed, null, 2));

  const ps = parsed.parameters || [];
  console.log(`\n=== SPIKE RESULT (${((Date.now() - t0) / 1000).toFixed(0)}s) ===`);
  console.log(`isNumber: ${parsed.isNumber} | parameterizationDims: ${JSON.stringify(parsed.parameterizationDims)}`);
  console.log(`parameters: ${ps.length} | distinct clauses: ${[...new Set(ps.map(p => p.clauseRef))].join(', ')}`);
  console.log(`\nclause | parameter | limitType min/max unit | variesBy | method | acc/type${''}`);
  ps.forEach(p => console.log(`${(p.clauseRef||'?').padEnd(10)} ${(p.parameterName||'').slice(0,34).padEnd(35)} ${(p.limitType||'').padEnd(11)} ${String(p.min||'').padEnd(6)}${String(p.max||'').padEnd(7)}${(p.unit||'').padEnd(6)} vary=${JSON.stringify(p.variesBy||[]).padEnd(20)} ${(p.testMethod||'-').padEnd(20)} ${p.acceptanceOrType||''}${p.needsReview?' ⚠REVIEW':''}`));
  console.log(`\nFull JSON -> scratch/spike_13592_out.json ; transcript -> scratch/spike_13592_transcript.md`);
})();
