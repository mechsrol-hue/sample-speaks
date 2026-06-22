'use strict';
/**
 * IS Report Agent — runs the SAME agent loop Claude Code uses, inside this server.
 *
 * Given an IS standard PDF, the agent autonomously: reads the whole PDF (built-in Read tool,
 * which renders pages to images just like in Claude Code), structures a clause-by-clause
 * testing-report template, runs the deterministic completeness check (server/pipeline/
 * completeness.js via Bash), re-reads the PDF for any missing DN rows / tables, and writes the
 * finished template to public/is_templates/<slug>.json — where the report renderer picks it up.
 *
 * Requires ANTHROPIC_API_KEY (the Agent SDK does NOT accept OpenRouter/Gemini keys).
 * Cost ≈ ~$1 per standard, one-time. The generated report itself is free (pure render).
 */
const path = require('path');

const REPO = path.join(__dirname, '../..');
const MODEL = process.env.AGENT_MODEL || 'claude-opus-4-8';

function slugify(isNumber) {
  return String(isNumber || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function buildPrompt(pdfPath, isHint) {
  return `You are extracting a Bureau of Indian Standards testing-report template from an IS standard PDF.

PDF to read: ${pdfPath}
${isHint ? `Likely IS number: ${isHint}` : ''}

Let SLUG = the IS number with every non-alphanumeric run replaced by "_" (e.g. "IS 13592:2013" → "IS_13592_2013").

Follow these steps EXACTLY:
1. Read the ENTIRE PDF with the Read tool (all pages, using the pages parameter). Capture every clause and every table.
2. Write your COMPLETE faithful transcription (all prose with clause numbers + every table with all rows)
   to scratch/<SLUG>_transcript.txt using the Write tool. The completeness check reads THIS file — the
   size-designation clause (the DN list) must appear in it verbatim.
3. Read public/is_templates/IS_13592_2013.json first, then build a clause-by-clause template with the
   IDENTICAL shape (parameterizationDims, dimensionOptions, defaults, dimensionGrid, parameters[] with
   clauseRef, section, parameterName, limitType, variesBy, gridRows/min/max, unit, specText, expected,
   testMethod, conditionalOn, acceptanceOrType, needsReview, and sourceTable).
   Rules:
   - Use the REAL clause number for each parameter (e.g. "Cl 7.1"), never a table name.
   - Every parameter whose data comes from a numbered dimension table MUST carry "sourceTable": "Table N".
   - Limit types: max | min | range | qualitative | text. Pull numeric min/max + unit from the text.
   - Detect the per-standard parameterization dims (size / class / type / socket) from the doc.
   - Put the referenced test-method IS (e.g. "IS 12235 (Part 5)") in testMethod ONLY — never in the value.
   - Include ALL testing parameters (acceptance AND type tests). Tag acceptanceOrType. Drop none.
   - EXCLUDE sampling / acceptance-number / "scale of sampling" tables entirely.
   - If unsure whether something is a testing parameter, include it with "needsReview": true.
4. Write the draft to public/is_templates/<SLUG>.json (Write tool).
5. COMPLETENESS (critical — do not skip). Run EXACTLY:
     node scripts/check_template_completeness.js scratch/<SLUG>_transcript.txt public/is_templates/<SLUG>.json
   It prints JSON. If "complete" is false: for each action, RE-READ the specific PDF pages for the listed
   missing DN sizes / dimension tables, fix public/is_templates/<SLUG>.json, and run the command AGAIN.
   Repeat until it prints "complete": true (or, if a page is genuinely unreadable, mark those rows
   "needsReview": true and note it).
6. Reply with one line: "<isNumber>: <N> parameters, <M> dimension sizes, completeness=<ok|flagged>".

Be precise and exhaustive. The dimensionGrid MUST contain every DN size the standard lists in its
size-designation clause — the completeness check enforces this, so do not finish until it passes.`;
}

/**
 * Run the agent on a PDF. Resolves to { ok, isNumber, templatePath, summary, log }.
 * Streams progress to onEvent(line) if provided.
 */
async function runReportAgent(pdfPath, opts = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, error: 'ANTHROPIC_API_KEY not set — the Agent SDK requires an Anthropic API key (console.anthropic.com). Add it to .env to enable in-app extraction.' };
  }
  let query;
  try { ({ query } = require('@anthropic-ai/claude-agent-sdk')); }
  catch (e) { return { ok: false, error: `Agent SDK not installed: ${e.message}` }; }

  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const log = [];
  let finalText = '';

  try {
    for await (const message of query({
      prompt: buildPrompt(pdfPath, opts.isHint),
      options: {
        model: MODEL,
        cwd: REPO,
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
        permissionMode: 'acceptEdits',
        settingSources: [],            // isolate: don't load the developer's personal ~/.claude config
        maxTurns: opts.maxTurns || 40,
      },
    })) {
      if (message.type === 'assistant' && message.message && Array.isArray(message.message.content)) {
        const text = message.message.content.filter(b => b.type === 'text').map(b => b.text).join('');
        if (text) { log.push(text); onEvent(text); }
      }
      if ('result' in message && message.type === 'result') {
        finalText = message.result || '';
        log.push(finalText); onEvent(finalText);
      }
    }
  } catch (e) {
    return { ok: false, error: `Agent run failed: ${e.message}`, log };
  }

  const isNumber = opts.isHint || (finalText.match(/IS\s*[\d]{3,6}[:\s]\d{4}/) || [])[0] || '';
  const slug = slugify(isNumber);
  const templatePath = slug ? `public/is_templates/${slug}.json` : null;
  return { ok: true, isNumber, templatePath, summary: finalText.trim().slice(0, 300), log };
}

module.exports = { runReportAgent, slugify };
