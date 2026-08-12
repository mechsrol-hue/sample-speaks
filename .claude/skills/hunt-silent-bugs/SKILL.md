---
name: hunt-silent-bugs
description: Adversarial sweep for silent failures — data captured but ignored, plausible-wrong values, swallowed errors, identity drift — anywhere in this codebase and its live database. Use when the user says /hunt-silent-bugs, "find silent bugs", "what else is silently failing", or after any manually-found bug to sweep for its whole family.
---

# Hunt silent bugs

You are auditing this system the way its user audits it: by refusing to believe a
screen just because it rendered. The deadliest bugs here have all shared one shape —
**the system produced a plausible, confident, WRONG output, and nothing anywhere
failed.** A twin-cord dimension printed on a single-core cable report. A Class 5
selection resolving a Class 1/2 table. FR-LSH-only tests on a Cat-01 report. Limits
"synced" while the write silently errored. The same standard stored twice under two
spellings, with updates scattering across both. Every one of these was found by a
human squinting at one row — your job is to find the rest before they do.

## Standing rules

- **Arrive unprepared.** Do not assume the bug classes below are the complete list, and
  do not assume any component is clean because it was audited before. Prior fixes tell
  you where the family LIVES, not where it ends. Anything can be wrong anywhere:
  code, templates, database rows, prompts, scripts, config, comments that lie.
- **Evidence or it didn't happen.** Every finding needs the exact file:line and the code
  quoted, or the live DB row printed. Reproduce before reporting. If you cannot
  demonstrate the wrong output with concrete inputs, mark it PLAUSIBLE, not CONFIRMED.
- **Verify in the app's semantics.** Validators must use the same runtime as the code
  under test (a Python audit once "found" 4 template bugs that were only
  `str(1.0) != '1'` — JavaScript said all clean). Node for JS behaviour, live HTTP for
  endpoints, real DB reads for data.
- **The renderer passing is not correctness.** Correctness means matching the external
  ground truth (the printed standard, the source document, the user's hand-verified
  table) — internal consistency proves nothing about truth.
- **When you find one, hunt the family.** A bug in one path exists in its siblings:
  screen + print + PDF + fallback + API + sync + export + downstream store. Enumerate
  every sibling path and check each. The IS 694 gate was fixed in the report screen
  while the vault projection, conformance sync, and dimensionData all still had it.
- **No guessed fixes.** Constraints and corrections come only from printed evidence or
  data already in the system ("not offered" cells, table headers, schedules). A past
  manual "correction" to IS 4984 Table 4 was itself the error; the extraction was right.
- **Solo by default.** No multi-agent unless the user asks. Cheap greps and targeted
  reads before full-file reads.

## The taxonomy — sweep every one

1. **Written-but-never-read.** For every field a producer writes (template schema,
   vault rows, submission blobs, prefs), grep for read sites. A field with zero readers
   that changes meaning (applicability, classification, gating) is a live bug or a
   bug-in-waiting. `appliesTo` was written perfectly and read nowhere.
2. **Dropped-in-the-bridge.** Diff each projector/sync/exporter field-by-field against
   its input. Anything discarded is unavailable to every consumer downstream — they
   cannot gate even if they want to. Check: template→vault, vault→conformance limits,
   vault→master template, template→report, scope→competencies.
3. **Under-declared dependence.** For every keyed lookup (valueTable, variety, limits,
   competency match), ask: is the key built from ALL the conditions that make the value
   valid? A value that varies by size but is only VALID for certain classes resolves
   confidently for illegal combinations. Markers like "not offered" in sibling
   parameters are evidence of a missing axis.
4. **Knowledge encoded as prose.** Applicability living only in names, section titles,
   labels, or comments ("Fire (FR-LSH)", "(single core rigid)", "Outdoor (Cat 02)")
   instead of machine-checkable fields. Grep parameter/section names for qualifier
   patterns and check each has a matching gate field.
5. **Swallowed failures.** Empty catches, `catch (_) {}`, destructured `error` never
   checked, fallbacks that return empty on corrupt input, success responses sent
   regardless, toasts as the only witness. Grep: `catch`, `.error`, `|| []`,
   `|| null`, `JSON.parse` inside try. Each one: what does the user see when it fires?
   If the answer is "success" or "empty state", it is a finding.
6. **Identity drift.** Every dedup/match/join on a string identity: is it normalized?
   ("IS 694 : 2010" vs "IS 694:2010" became two vault rows; base-number competency
   matching made Part 2 grant Part 16.) Then check the LIVE data for duplicates that
   already exist — the code fix does not heal the data.
7. **Non-deterministic reads.** `.limit(1).single()` without ORDER BY over possibly-
   duplicated data; ilike patterns that can match multiple standards (694 vs 6944).
   These scatter reads and writes across rows silently.
8. **Two stores, two truths.** Wherever the same information lives twice (on-disk
   template vs vault projection, specs_db vs template, stored prefs vs code defaults),
   diff them. Stored config shadowing new code defaults hid an entire section list once.
9. **One-path enforcement.** For every rule enforced in a renderer, list every other
   route to the same output (print, export, fallback, API consumer, agent tool) and
   verify the rule holds there too — or that the path provably reuses the enforced one.
10. **Stale processes.** Server code loads at boot; a running process serves old logic
    while the files look fixed. Before declaring any server-side bug fixed or
    unreproducible, confirm which code the live process is actually running.
11. **Guards that cannot fire.** Gates referencing options that don't exist, conditions
    on unknown dimensions, constraints emptying dropdowns, defaults violating their own
    constraints. Run `npm test` (contract + golden) and treat warnings as leads.
12. **Captured but invisible, or present but unfindable.** "Missing" data often IS
    captured — it just never renders (a classification field no row displays), renders
    once where the source repeats it (a schedule listing each test 2-3x), or renders in
    a different grouping/order than the document the reader is holding. Before hunting
    a capture bug, reconcile item-by-item against the source page; if capture is 100%,
    the bug is display: hidden column, deduplication, or ordering — name which.
13. **The ground-truth gap.** Which outputs have NO external verification at all?
    (Only IS 694 has a golden table today.) Every unverified standard/report is a place
    this family hides undetected. List them.

## Method

1. Map the data flow first: producers → stores → bridges → consumers for the artifact
   under audit. Build the field-level contract table. Mismatches are findings.
2. Run the mechanical sweeps (greps per taxonomy item) before reading anything fully.
3. Query the live database for the data-level instances: duplicates, orphans,
   colliding keys, rows that violate the current contract.
4. For each suspect, construct the concrete failing input and show the wrong output.
5. Fix only with evidence; after each fix, re-run `npm test` and re-check the live data.
6. Ship each axis as its own commit so any one can be reverted alone.

## Report format

Ranked table: severity (🔴 wrong output possible now / 🟠 latent, trap is set /
🟡 degraded honesty / 🟢 hygiene), the one-line defect, the proof (file:line or DB row),
blast radius, and status (fixed now / needs user action / listed). Close with:
- what each fix turned into a LOUD failure (gate, test, surfaced error) — if nothing
  now screams when it regresses, the fix is incomplete;
- the ground-truth gaps that remain;
- anything you could not check and why. Never report "all clean" — report what was
  checked, what wasn't, and what would catch what you missed.
