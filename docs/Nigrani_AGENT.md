# Nigrani Agent — Phase 1

Nigrani is the BIS SRL lab co-pilot. Phase 1 is a **human-in-the-loop (HITL)
notification surface**: Nigrani watches the lab and tells the OIC what looks
off. **Phase 1 never auto-executes** — approval marks a finding as
acknowledged, nothing more.

## Scope

| In Phase 1                          | NOT in Phase 1                       |
|-------------------------------------|--------------------------------------|
| Detect 4 deviations (see Nigrani_RULES.md) | Auto-reassignment                |
| Write to `lab_notifications`        | Auto-running `/api/auto-assign`      |
| Bell + slide-out panel              | Free-text agentic commands           |
| Approve / dismiss / snooze (visibility) | Multi-step plans / tool use       |

## Architecture

```
+--------------------+         +-----------------------+
|  Nigrani-monitor.js  |  every  |   Nigrani-rules.js      |
|  setInterval 5min  | ─────▶  |   pure JS, no LLM     |
|  60s snapshot cache|         |   returns findings    |
+---------┬----------+         +-----------------------+
          │                             ▲
          │ upsert by dedupe_key        │ snapshot
          ▼                             │
+---------------------+        +-----------------------+
|  lab_notifications  | ◀───── |   Supabase queries    |
|  (Postgres table)   |        |   samples, employees, |
+----------┬----------+        |   templates           |
           │ GET / POST        +-----------------------+
           ▼
+---------------------+
|  /api/notifications |   bell panel polls /api/notifications every 30s
|  approve / dismiss  |
|  snooze             |
+---------------------+
```

Two surfaces:

- **`server/agent/Nigrani-monitor.js`** — the background loop. Boots from
  `server.js` on `app.listen`. First tick fires 5s after boot so the bell
  isn't empty on first paint; subsequent ticks every 5 min.
- **`server/agent/Nigrani-rules.js`** — a pure-JS module taking the cached
  snapshot in and returning candidate findings. No DB calls, no LLM calls,
  no I/O. Trivially testable.

## Why a 60-second snapshot cache?

Chat + monitor both need the same view of the lab. The cache:

- Saves 200–400 ms per chat turn (the Supabase queries are skipped if the
  cache is warm).
- Prevents the 5-minute monitor tick from doing redundant work if a chat
  call just refreshed it.
- TTL is short enough that real-time accuracy stays acceptable for an
  alert system that re-fires every 5 min anyway.

## Why the LLM is *not* on the detection path

- Detection must be cheap and deterministic. Rules engine = pure JS.
- The LLM (Gemini 2.5 Flash, `thinkingBudget: 0`) is invoked at most once
  per *new* finding — only to write the one-sentence body explaining
  what the OIC should do. If Gemini fails or is not configured, a
  deterministic fallback body is used and persisted.
- Snoozed/refreshed findings reuse the existing row; no extra LLM cost.

## Deduplication

Each rule emits a stable `dedupe_key`. A unique partial index
(`status = 'open'`) guarantees only one open notification per key at a
time. The monitor upserts:

- new `dedupe_key`: insert (and generate body)
- existing open row with same key: refresh title/payload/severity only
- approved/dismissed rows are kept as history for audit

## HITL contract (Phase 1)

| Action     | What it does (Phase 1)                                  |
|------------|---------------------------------------------------------|
| Approve    | `status='approved'`, records `acted_by` + `acted_at`. **No execution.** |
| Dismiss    | `status='dismissed'`, hides from default view.          |
| Snooze 4h  | `status='snoozed'`, `snooze_until = now + 4h`. Monitor flips it back to `open` at expiry. |

## Latency budget

| Phase                            | Target |
|----------------------------------|--------|
| Monitor tick wall-time           | ≤ 2s typical, ≤ 5s p95 |
| Bell panel open → first paint    | ≤ 200ms (cache + polling) |
| Action button → row updated      | ≤ 250ms |
| New chat turn with warm cache    | ≤ 1.0s (no Supabase round-trips) |

## What goes next (not Phase 1)

- **Phase 2**: wire Approve → `Nigrani-executor.js` that calls the real
  `/api/auto-assign` or manual-reassign endpoints, with audit log.
- **Phase 3**: function-calling tool surface for Nigrani (`get_workload`,
  `find_competent_tas`, `propose_reassignment`, …), free-text commands.

## File map

```
migrations/2026_06_05_lab_notifications.sql   schema
server/agent/Nigrani-rules.js                   detection
server/agent/Nigrani-monitor.js                 cron loop + cache
server.js   (/api/notifications/*)            routes + monitor.start()
public/index.html                             bell markup + panel
public/style.css                              .Nigrani-bell-* styles
public/app.js                                 toggleNigraniBell, polling, actions
docs/Nigrani_AGENT.md                           this file
docs/Nigrani_RULES.md                           per-rule spec sheet
```
