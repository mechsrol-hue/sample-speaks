# Nigrani Rules — Phase 1

Four detection rules, all implemented in `server/agent/Nigrani-rules.js`.
Each rule is a pure function: snapshot in, findings out. Thresholds live
in code (not in the DB) for Phase 1; promote to `system_preferences` if
the OIC needs to tune them without a deploy.

Every finding carries:

| Field         | Purpose                                           |
|---------------|---------------------------------------------------|
| `rule`        | rule ID (mapped to `lab_notifications.type`)      |
| `severity`    | `info` / `warn` / `critical`                      |
| `title`       | one-line headline — deterministic                 |
| `sample_ids`  | sample codes referenced (≤ 25)                    |
| `payload`     | structured evidence (used by future executor)     |
| `dedupe_key`  | stable key for the partial unique index           |

---

## R1 — `shelf_life_expiry`

| Aspect           | Value                                                              |
|------------------|--------------------------------------------------------------------|
| **Signal**       | sample's age vs its IS template's `tatDays`                        |
| **Fires when**   | `tatDays - ageDays ≤ 2`                                            |
| **Severity**     | `critical` if overdue (`daysLeft < 0`), else `warn`                |
| **Granularity**  | one finding per sample per severity bucket                         |
| **Dedupe key**   | `shelf_life_expiry:{encodedCode}:{severity}`                       |
| **Intended Phase 2 action** | offer reassign-to-less-loaded-TA, or escalate to OIC inbox |

**Why this matters:** every overdue sample is a missed TAT against the
BIS internal commitment. Bucketing by severity means a warn → critical
upgrade replaces the prior row cleanly (the warn row is no longer
emitted, so the index just adopts the critical one on the next tick).

---

## R2 — `workload_imbalance`

| Aspect           | Value                                                              |
|------------------|--------------------------------------------------------------------|
| **Signal**       | per-TA load (man-hours from templates, falls back to sample count) |
| **Fires when**   | TA's load ≥ 1.5× median load (across TAs with load > 0)            |
| **Severity**     | `critical` at ≥ 2× median, else `warn`                             |
| **Skipped when** | fewer than 3 TAs carrying load (median is unreliable)              |
| **Granularity**  | one finding per overloaded TA per severity bucket                  |
| **Dedupe key**   | `workload_imbalance:{ta}:{severity}`                               |
| **Payload extras** | `suggestedRecipients`: up to 3 TAs with load < 0.5× median       |

**Why median, not mean?** A single 60-sample TA distorts the mean and
hides the rest. The median is robust and matches how the existing chat
endpoint already reports workload.

---

## R3 — `aging_cluster`

| Aspect           | Value                                                              |
|------------------|--------------------------------------------------------------------|
| **Signal**       | samples aged > 30 days grouped by IS number or by TA               |
| **Fires when**   | a group has ≥ 5 aged-out samples                                   |
| **Severity**     | `critical` at ≥ 10, else `warn`                                    |
| **Granularity**  | one finding per group (IS or TA); UNASSIGNED is excluded (covered by R4) |
| **Dedupe key**   | `aging_cluster:is:{isNumber}` or `aging_cluster:ta:{ta}`           |
| **Payload extras** | `groupBy`, `key`, `count`, `oldestAge`, top 25 `sample_ids`       |

**Why this matters:** single-sample aging is R1's job. R3 catches the
*pattern* — a cluster usually means a structural blocker (single
competent TA, missing equipment, missing template) rather than a
scheduling lapse on one card.

---

## R4 — `unassigned_backlog`

| Aspect           | Value                                                              |
|------------------|--------------------------------------------------------------------|
| **Signal**       | rollup of unassigned (`assignedTo` empty/null) Pending samples     |
| **Fires when**   | any unassigned with age ≥ 3d, OR total unassigned ≥ 10             |
| **Severity**     | `critical` if oldest ≥ 7d or count ≥ 25; `warn` for medium; `info` otherwise |
| **Granularity**  | **one** rollup finding for the whole lab (never per sample)        |
| **Dedupe key**   | `unassigned_backlog:{severity}`                                    |
| **Payload extras** | `count`, `agedCount`, `oldestAge`, `oldestCode`                  |
| **Intended Phase 2 action** | one-click trigger of `/api/auto-assign`                  |

**Why one rollup, not per-sample?** A bell flooded with 47 "unassigned"
items is noise. One card with "47 unassigned, oldest 11d" + a Phase 2
button to run auto-assign is signal.

---

## Tunable thresholds (today they're literals)

| Param                             | Default | Lives in                  |
|-----------------------------------|---------|---------------------------|
| Shelf-life warning window         | 2 days  | `Nigrani-rules.js`          |
| Workload warn ratio               | 1.5×    | `Nigrani-rules.js`          |
| Workload critical ratio           | 2.0×    | `Nigrani-rules.js`          |
| Aging cluster cutoff              | 30 days | `Nigrani-rules.js`          |
| Aging cluster minimum group size  | 5       | `Nigrani-rules.js`          |
| Aging cluster critical group size | 10      | `Nigrani-rules.js`          |
| Unassigned age that escalates     | 3d / 7d | `Nigrani-rules.js`          |
| Unassigned count that escalates   | 10 / 25 | `Nigrani-rules.js`          |
| Monitor tick interval             | 5 min   | `Nigrani-monitor.js`        |
| Snapshot TTL                      | 60s     | `Nigrani-monitor.js`        |
| UI poll interval                  | 30s     | `public/app.js` Nigrani IIFE|
| Snooze duration                   | 4 hours | `/api/notifications/:id/snooze` body |

When promoting any of these to runtime config, add a `system_preferences`
row (e.g. `Nigrani_threshold_workload_warn`) and read it inside the snapshot
fetch so the rules stay pure.
