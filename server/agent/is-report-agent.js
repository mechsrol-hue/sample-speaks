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
const os = require('os');
const fs = require('fs');

const REPO = path.join(__dirname, '../..');
const MODEL = process.env.AGENT_MODEL || 'claude-opus-4-8';

// The Agent SDK is Claude Code under the hood, and Claude Code prefers a logged-in OAuth
// session in $HOME/.claude.json over ANTHROPIC_API_KEY. If that session is stale it 401s even
// with a valid key. Point the subprocess at an isolated (empty) config dir so it finds no
// OAuth login and falls back to ANTHROPIC_API_KEY. Leaves the developer's global login intact.
const ISOLATED_CONFIG_DIR = path.join(os.tmpdir(), 'is-report-agent-claude-config');
try { fs.mkdirSync(ISOLATED_CONFIG_DIR, { recursive: true }); } catch (_) {}

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
   size/grade/class enumeration clauses (the option lists) must appear in it verbatim.
3. Build a clause-by-clause testing-report template as JSON. Detect the standard's OWN parameterization
   dimensions from the document — they vary by standard (e.g. pipes = size·type·socket; steel bars =
   size·grade; some = size·class·type). The report will render one dropdown per dimension, and EVERY
   parameter whose limit depends on a dimension must auto-fill the EXACT value for the chosen options and
   light green/red. Use this shape:

   {
     "isNumber": "...", "title": "...", "revision": "...",
     "parameterizationDims": ["size","grade"],                 // the dims THIS standard varies by
     "dimensionOptions": { "size":[8,10,12,16,20,25,32,40], "grade":["Fe 415","Fe 500","Fe 550","Fe 600"] },
     "defaults": { "size":16, "grade":"Fe 500" },
     "parameters": [
       { "clauseRef":"Cl 8.1", "section":"Mechanical", "parameterName":"0.2% proof / yield stress, Min",
         "unit":"MPa", "limitType":"min", "acceptanceOrType":"acceptance", "variesBy":["grade"],
         "sourceTable":"Table 3", "testMethod":"IS 1608",
         "valueTable": { "Fe 415":{"min":415}, "Fe 500":{"min":500}, "Fe 550":{"min":550}, "Fe 600":{"min":600} } },
       { "clauseRef":"Cl 4.2", "section":"Chemical", "parameterName":"Carbon, Max", "unit":"%",
         "limitType":"max", "acceptanceOrType":"acceptance", "variesBy":["grade"], "sourceTable":"Table 1",
         "valueTable": { "Fe 415":{"max":0.30}, "Fe 500":{"max":0.30}, "Fe 550":{"max":0.30}, "Fe 600":{"max":0.30} } },
       { "clauseRef":"Cl 6.2", "section":"Dimensions", "parameterName":"Mass per metre", "unit":"kg/m",
         "limitType":"range", "acceptanceOrType":"acceptance", "variesBy":["size"], "sourceTable":"Table 2",
         "valueTable": { "8":{"min":0.367,"max":0.420}, "16":{"min":1.501,"max":1.659} /* …EVERY size… */ } },
       { "clauseRef":"Cl 9.3", "section":"Bend", "parameterName":"Bend test", "limitType":"qualitative",
         "acceptanceOrType":"type", "variesBy":["grade"],
         "valueTable": { "Fe 415":{"expected":"No cracking; mandrel 3×nominal"}, "Fe 500":{"expected":"No cracking; mandrel 4×nominal"} /* …every grade… */ } },
       { "clauseRef":"Cl 6.1", "section":"General", "parameterName":"Nominal size designation",
         "limitType":"text", "acceptanceOrType":"acceptance", "variesBy":[], "specText":"As designated by the buyer" }
     ]
   }

   RULES (the completeness gate enforces these — do not finish until it passes):
   - Use the REAL clause number for each parameter (e.g. "Cl 8.1"), never a table name.
   - "variesBy" lists EXACTLY the dimensions a parameter's value depends on (minimal). Yield stress that
     depends only on grade → variesBy:["grade"], NOT ["size","grade"].
   - If variesBy is NON-EMPTY you MUST provide "valueTable": its KEY is the variesBy option values joined
     by "|" in variesBy order ("16" for ["size"]; "16|Fe 500" for ["size","grade"]); its VALUE is
     {min,max} for numeric limits (one-sided for min-only / max-only) or {expected:"..."} for qualitative.
     EVERY combination of the variesBy options MUST have a real entry pulled from the standard's tables.
     NEVER leave a varying limit as descriptive text only — that is the "partial report" failure we forbid.
   - For a qualitative test whose rule is a formula (e.g. mandrel = k × nominal size, k per grade), set
     variesBy:["grade"] and put the formula in the per-grade "expected" text — do NOT enumerate size×grade.
   - If variesBy is EMPTY (constant): put min/max (numeric) or expected (qualitative) directly on the param.
   - limitType ∈ max | min | range | qualitative | text. Always include "unit" for numeric limits.
   - Put any referenced test-method IS (e.g. "IS 12235 (Part 5)") in "testMethod" ONLY — never in a value.
   - Include ALL testing parameters (acceptance AND type tests); tag "acceptanceOrType"; drop none.
   - EXCLUDE sampling / acceptance-number / "scale of sampling" tables entirely.
   - If unsure whether something is a testing parameter, include it with "needsReview": true.

   DENSE / ROTATED / UNREADABLE TABLES (this is the #1 failure mode — read carefully):
   - Some tables (e.g. wall-thickness vs SDR, mass vs size) are printed ROTATED (landscape) and so dense
     that page-image OCR is unreliable. Do NOT loop re-reading such a table hoping it sharpens — that burns
     turns and stalls the run. Instead, in this order:
   - (a) USE THE FORMULA AS A SCAFFOLD, NOT THE FINAL ANSWER. Most such tables are GENERATED from a
     derivation rule stated in the table's own NOTES (e.g. IS 4984 Table 4: eMin = dn/SDR rounded up to next
     0.1 mm; tolerance derived from 0.1*eMin + 0.1; eMax = eMin + tolerance). Compute every cell from the rule
     to get a draft, then ALWAYS reconcile it against the actual printed cells.
   - (b) THE PRINTED CELLS ARE AUTHORITATIVE — even over the note's own wording. Standards sometimes
     CONTRADICT their own notes: IS 4984 Note 1 literally says tolerance is "rounded UP", but the printed
     Table 4 cells are actually rounded to NEAREST (e.g. dn20/SDR6 prints 3.8, not the round-up 3.9). A report
     must match the PRINTED values (that is what labs test against). So: render the page de-rotated and zoom
     into enough cells to determine which rounding the PRINTED table truly uses, then apply THAT to every
     cell. If the printed cells disagree with the note, follow the cells and say so in the note field.
   - (c) DO NOT FILL CELLS THE PRINTED TABLE LEAVES BLANK. Many size·SDR (or size·class) combinations are
     blank in the printed table because that product is not made (very thin walls at low pressure, or walls
     beyond the standard's max). The blank set is NOT a clean formula threshold — read the printed table to
     see which cells are empty, and set those to {"value":"Not specified in IS (combination not offered)"}
     (NOT a computed number). Filling a blank cell with a formula value (e.g. a 0.4 mm wall) is a real error.
   - (d) RENDERING RECIPE: via Bash use  pdftoppm -r 300 -f <page> -l <page> -png <pdf> scratch/<SLUG>_pNN
     (or ImageMagick  magick -density 300 -rotate 90 '<pdf>[<page0index>]' scratch/<SLUG>_pNN.png ), split
     wide tables into left/right halves and zoom per column, then Read the PNGs. If a page is genuinely
     unreadable after this, transcribe what you can and mark affected entries "needsReview": true with a note
     naming the table — never silently guess a number.
4. Write the draft to public/is_templates/<SLUG>.json (Write tool).
5. COMPLETENESS (critical — do not skip). Run EXACTLY:
     node scripts/check_template_completeness.js scratch/<SLUG>_transcript.txt public/is_templates/<SLUG>.json
   It prints JSON. If "complete" is false: the actions tell you exactly which size options are missing
   (add them to dimensionOptions) and which parameters have valueTable gaps (fill the listed combos with the
   REAL numbers from the standard's tables — re-read the specific pages if needed). Fix the file and run the
   command AGAIN. Repeat until it prints "complete": true (or, if a page is genuinely unreadable, mark those
   entries "needsReview": true and note it).
6. Reply with one line: "<isNumber>: <N> parameters, <M> <primary-dim> options, completeness=<ok|flagged>".

Be precise and exhaustive. Every varying parameter must resolve a real value for every option combination —
the completeness check enforces this, so do not finish until it passes.`;
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
  let costUsd = null, numTurns = null, usage = null;

  try {
    for await (const message of query({
      prompt: buildPrompt(pdfPath, opts.isHint),
      options: {
        model: MODEL,
        cwd: REPO,
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
        permissionMode: 'acceptEdits',
        settingSources: [],            // isolate: don't load the developer's personal ~/.claude config
        // env REPLACES the subprocess environment, so spread process.env (keeps PATH/HOME/ANTHROPIC_API_KEY),
        // then override CLAUDE_CONFIG_DIR so the stale OAuth login isn't picked up over the API key.
        env: { ...process.env, CLAUDE_CONFIG_DIR: ISOLATED_CONFIG_DIR },
        maxTurns: opts.maxTurns || 80,
      },
    })) {
      if (message.type === 'assistant' && message.message && Array.isArray(message.message.content)) {
        const text = message.message.content.filter(b => b.type === 'text').map(b => b.text).join('');
        if (text) { log.push(text); onEvent(text); }
      }
      if ('result' in message && message.type === 'result') {
        finalText = message.result || '';
        // The SDK result message carries billing/usage — surface it so callers can watch trial spend.
        if (typeof message.total_cost_usd === 'number') costUsd = message.total_cost_usd;
        if (typeof message.num_turns === 'number') numTurns = message.num_turns;
        if (message.usage) usage = message.usage;
        log.push(finalText); onEvent(finalText);
      }
    }
  } catch (e) {
    return { ok: false, error: `Agent run failed: ${e.message}`, log, costUsd, numTurns, usage };
  }

  // Tolerant of spacing variants across PDFs: "IS 1786:2008", "IS 1786 : 2008", "IS 1786-2008".
  const isNumber = opts.isHint || (finalText.match(/IS\s*\d{1,6}\s*[:\-]?\s*\d{4}/i) || [])[0] || '';
  const slug = slugify(isNumber);
  const templatePath = slug ? `public/is_templates/${slug}.json` : null;
  return { ok: true, isNumber, templatePath, summary: finalText.trim().slice(0, 300), log, costUsd, numTurns, usage };
}

module.exports = { runReportAgent, slugify };
