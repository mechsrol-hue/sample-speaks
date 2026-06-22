# IS Pipeline Redesign — Auto-Generated Testing Reports

Status: **design approved (grill complete), build started**
Date: 2026-06-22

## Progress
- ✅ **Spike validated** (2026-06-22): whole-doc Gemini 3.5 read → Opus structure reproduced IS 13592's clause-by-clause params (real clauses, limits, methods, per-standard dims). Artifacts: `scratch/spike_13592_transcript.md`, `scratch/spike_13592_structured.json`. Confirmed the dimension-grid completeness gap (Table 1 truncated, Tables 2/3 missed) → needs the self-verify/completeness re-read.
- ✅ **Step 4 (report renderer) — template-driven, done & verified**: `public/is_templates/IS_13592_2013.json` (structured template) + new renderer in `public/app.js` (`loadVaultTemplate`, `renderVaultISReportFromTemplate`, `renderVaultISReportRows`, `tplResolvePath`, `tplCondMet`, `renderTemplateRowsToTbody`, `setReportThead`). Per-standard Size/Type/Socket dropdowns, conditional NA, grid lookup, section grouping, 4-col format, test-method metadata. 4985 still uses specs_db (regression-verified). The vault report prefers a `/is_templates/<slug>.json` if present, else 4985 specs_db, else flat pipeline fallback.
- ✅ **Completeness guard built & tested**: `server/pipeline/completeness.js` — deterministic anti-truncation gate. Derives expected DN rows from clause prose, expected dimension tables from in-text references (scoped to exclude sampling), cross-checks vs pdfplumber row counts, runs min<max + OD-monotonic sanity, and emits precise re-read actions. Verified against the real 13592 spike: correctly reports Table 1 missing [125,140,160,180,200,250,315] and Tables 2 & 3 absent.
- ✅ **Migration SQL written** (apply via Supabase service role): `migrations/2026_06_22_is_report_templates.sql` — `is_report_templates` (versioned approved template), `is_extraction_history` (audit/rescan-diff), + `is_standards_vault` columns fullText/sourcePdfPath/completeness, + is-pdfs storage bucket note.
- ✅ **In-app Agent SDK integration built** (the "Claude-Code-quality in the app" path): installed `@anthropic-ai/claude-agent-sdk`; `server/agent/is-report-agent.js` runs the same agent loop (built-in Read reads the PDF, Bash runs `completeness.js`, Write emits the template to `public/is_templates/<slug>.json`); endpoint `POST /api/is-intelligence/agent-extract` (+ poll `GET .../:jobId`). Verified end-to-end up to the auth boundary (returns a clean 503 telling the user to add the key).
- ⛔ **Activation blocker — needs `ANTHROPIC_API_KEY`** in `.env` (console.anthropic.com). The Agent SDK does NOT accept OpenRouter/Gemini/Azure-DI keys (their current keys). Cost ≈ $1/standard one-time; reports free.
- ⬜ Remaining: add the Anthropic key → live-test agent on 13592/4985; apply the `is_report_templates` migration; confirm/approve UX; rescan diff.

## Goal
Upload any IS standard PDF → the system reads the **whole document**, extracts **every testing parameter clause-by-clause** with its limits, builds a reusable **per-IS testing-report template**, the analyst **confirms it once**, and from then on the **testing report auto-generates** with size/grade/type/socket dropdowns that auto-fill limits. No hardcoded `specs_db`.

## Locked decisions (from the grill)
- **Hybrid**: extract a draft → human confirms once per standard → approved template drives the report. Never silently ship a wrong/empty report.
- **Extract ALL testing parameters** (acceptance + type tests, e.g. stress relief / sulphuric acid / sunlight). Analyst ticks `includeInReport` + applicability; nothing is silently dropped.
- **Models (quality, simple)**: **Gemini 3.5 Flash** reads (proven 97–100% on real tables) → **Opus 4.8** structures. **No independent third-model verify.**
- **Whole-doc first, structure after** (inverse of today's blind Opus-first).
- **Reliability nets are free**: render all pages, deterministic checks, completeness check, self-verify only on empty/flagged grids, human confirm.
- **Report format = the real LIMS report** (see the 13592 reference): columns `Clause | Test Parameter | Specified value | Observed value`. No "Type" column, no "Test Method" column. Real clause numbers (Cl 4, Cl 7.1, Cl 8.2…). Green/red glow on observed input.
- **Parameterization is per-standard**: 4985 = Size·Class·Type; 13592 = Size·Type·Socket. Dropdowns adapt per standard, with conditional NA rows (e.g. Socket=Solvent Cementing ⇒ grooved-socket rows = "Not applicable").
- **Referenced IS / test method**: detected, stored as **metadata**, surfaced for human resolution — never jammed into the value column.
- **Persistence**: retain the source PDF, keep version history, store the approved template separately so a rescan can't overwrite confirmed data.
- **Rescan**: diff vs approved template, show changes, ask before overriding.

## Data model — the per-IS template (the central artifact)
```
ISTemplate {
  isNumber, title, revision,
  parameterizationDims: ["size","type","socket"],     // per-standard
  dimensionOptions: { size:[...], type:["A","B"], socket:["Solvent Cementing","Grooved"], class:[...] },
  dimensionGrid: {                                     // lookup by size (+class/type where needed)
    "90": { mean_od_min:90.0, mean_od_max:90.3, od_any_min:88.9, od_any_max:91.2,
            thickness:{ A:{min:1.9,max:2.3} }, socket:{...} }, ...
  },
  parameters: [{
    id, clauseRef:"Cl 7.1", section:"Dimensions", parameterName:"Mean Outside Diameter",
    isTestingParameter:true, includeInReport:true, acceptanceOrType:"acceptance"|"type",
    limitType:"range"|"max"|"min"|"qualitative"|"text",
    variesBy:["size"],                                 // [] = constant
    rows:[ {label:"Min", source:"grid:mean_od_min"}, {label:"Max", source:"grid:mean_od_max"} ],
    specText, unit, expected:"Satisfactory",           // qualitative pass condition
    testMethod:"IS 12235 (Part 5)",                    // metadata, not shown
    referencedIS:[...],
    conditionalOn:{ socket:"Grooved" },                // else rendered NA
    status:"ok"|"needs_review"|"blank", note, confidence
  }]
}
```

## New pipeline
- **P0 Ingest**: render **all** pages to images (pdfplumber demoted to a hint). Persist full text + source PDF.
- **P1 Read — Gemini 3.5 Flash**: read every page → faithful transcription (prose + tables + clause structure).
- **P2 Structure — Opus 4.8**: build the clause-by-clause template — real clause numbers, limit typing, varies-by, grid + column mapping, testMethod, referencedIS, conditional rows, uncertainty flags. Extract ALL params.
- **P3 Checks**: deterministic (min<max, OD monotonic, no nulls in required cells) + completeness (every detected table & limit-bearing clause represented). Flag failures.
- **P4 Self-verify (targeted)**: re-read only grids that came back empty/short/failed a check (Gemini, higher DPI).
- **P5 Persist**: raw extraction + version history + source PDF.
- **P6 Human confirm**: analyst resolves flags, fills blanks, links referenced IS, ticks include/applicability → **Approve** → writes versioned approved template.
- **P7 Report**: renderer reads the approved template; dropdowns from `parameterizationDims`; auto-fill from grid; conditional NA; green/red glow; print.
- **Rescan**: re-run P0–P5 → diff vs approved template → analyst approves/merges.

## Persistence changes
- `is_standards_vault`: keep as latest raw extraction; add retained full text.
- **New** `is_report_templates`: the approved, human-confirmed template, **versioned**.
- **New** `is_extraction_history`: audit trail of each extraction + approval (drives rescan-diff + traceability).
- **Source PDF** retained (Supabase storage bucket, keyed by isNumber+version).

## Build sequence (green-light incrementally)
1. **Schema + persistence** — new tables, PDF retention, versioning. *(foundation)*
2. **New extraction flow** (P0–P4) — whole-doc read → Opus structure → checks. Benchmark on 4985 + 13592.
3. **Confirm/approve UX** — review panel, flag resolution, referenced-IS linking, include/applicability ticks.
4. **Report renderer** — per-standard dropdowns + grid + conditional NA + glow + print; **replaces `specs_db` dependency**.
5. **Rescan diff-and-confirm**.
6. **Migrate** existing data — seed 4985 approved template from `specs_db` (so the live 4985 report never breaks), then 13592.

## Transition / safety
- Seed the **4985** approved template from `specs_db` as v1 so the working report keeps running during the rebuild; deprecate `specs_db` only once the extracted+approved 4985 template supersedes it.
- The vault "Generate Report" modal already built this session becomes the renderer in step 4 (swap data source: `specs_db` → approved template).
