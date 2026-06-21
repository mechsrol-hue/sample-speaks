# Auto-Assigner — reality-aligned hours (local ML, no cloud)

_Built 2026-06-13. Everything here runs locally in your Node server + Supabase. No data
leaves your machine; no Claude/Gemini cloud calls at runtime._

## The problem you raised

> "the time mentioned in testing charges is not the same as in real — sometimes we
> load 3, 5 or any number depending on different parameters / different IS samples."

The old auto-assigner used **one flat number per IS** (`template.totalHours` from the BIS
PDF) for every sample, no matter how many were run together. Two things were wrong:

1. **The PDF numbers themselves were wrong in the DB** — see `docs/TEMPLATE_AUDIT.md`.
   16 of 18 templates didn't match the BIS source PDFs.
2. **No batch effect** — running 5 samples of one IS together shares the fixed setup
   (calibration, machine warm-up, report prep), so the real per-sample cost is lower.
   A flat number can never capture that.

## What was built

### 1. Template audit + correction (`scripts/audit_templates.js`)
Re-extracts the BIS testing-charge PDFs locally (`pdftotext`, deterministic regex) and
compares against the DB. Commits only standards with a trustworthy BIS-declared total,
backing up every old value to `template_backup_IS*` first.
- **13 templates corrected** (e.g. IS 4985 22.5h→15h, IS 14735 15h→29h).
- **5 flagged** for OIC manual entry (cement/multi-part standards whose tables can't be
  auto-located reliably — see the audit doc for the honest write-up).
- Rollback anytime: `node scripts/rollback_templates.js`

### 2. Local ML hours-model (`server/ml/hours-model.js`)
Per-IS model: `wallHours(n) ≈ setup_IS + n · marginal_IS` for a batch of n same-IS samples.
- **Cold-starts** from the corrected BIS priors (setup = 35% of total, marginal = 65%),
  so it gives sane numbers from day one with zero data.
- **Learns online** via recursive least squares (RLS) as samples complete — no retraining
  from scratch, adapts to drift with a forgetting factor.
- **Per-TA proficiency**: a multiplier learned per technician, shrunk toward 1.0 so one
  fast/slow batch doesn't swing it.
- **Working-hours clock**: a sample received Friday and finished Monday is scored on
  working hours (Mon–Sat, 9–18), not 72 wall-clock hours.
- Pure JS, zero dependencies, runs inside your server. Unit tests: `node server/ml/hours-model.test.js` (18/18 pass).

### 3. Batch-aware auto-assign (`server.js`, `/api/auto-assign`)
- A TA's **existing load** is now priced per-IS group (`setup + n·marginal`), not
  `n × full-hours` — so someone holding 30 samples of one IS isn't shown as 30× the work.
- When assigning a new sample, a TA who **already holds that IS pays only the marginal
  hours** (setup already paid). Tagged `🔗 BATCHED ×N (saves Xh)`.
- A **consolidation bonus** routes same-IS samples to the TA already set up for them —
  this is the real "load 5 together" efficiency.
- Falls back to flat template hours if the model is unavailable. FIFO/priority/urgency,
  leave, attendance, equipment-bottleneck logic all unchanged.

### 4. Self-learning loop
- Lifecycle events logged at three points: assignment (`approve-assignment`), testing
  start (`start-testing`), submission (`submit-sample`) → `ml_event_log` in
  system_preferences.
- Model retrains 30s after server boot and once per day automatically.
- Manual ops: `GET /api/admin/ml/status` (what the model believes), `POST /api/admin/ml/retrain`.

## How to operate it
- It already works — nothing to do. As TAs start/submit samples, the model learns real hours.
- Check what it has learned: `curl localhost:3030/api/admin/ml/status`
- After many submissions, force a retrain: `curl -X POST localhost:3030/api/admin/ml/retrain`
- The 5 flagged standards (IS 9873, 269, 4246, 455, 1489): OIC should set their `totalHours`
  from the BIS PDFs via the existing template editor. (IS 269's existing 10.5h is already ≈ correct.)

## Honest limitations
- **No completed-sample history yet** — all 759 samples are still Pending, so the model is
  currently pure prior. It gets better the moment real test durations start flowing in.
- **Clause-subset per grade** (different parameters → different applicable clauses) is NOT
  yet modeled per-sample; the ML batch model captures the dominant batch effect, and online
  learning absorbs grade variation into the per-IS estimate over time. A per-sample clause
  picker would be the next step if you want finer control.
- The local-LLM PDF enrichment was attempted but proved unreliable (it over-summed); not used.
