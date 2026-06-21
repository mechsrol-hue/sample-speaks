-- Nigrani Agent — Phase 2 / 3
-- 1. Nigrani_audit_log: every state change Nigrani makes or proposes.
-- 2. Nigrani_oic_preferences: durable memory for OIC-stated rules
--    (e.g. "always recommend before execute"). Nigrani reads these into
--    every chat turn and obeys them.

create table if not exists public.Nigrani_audit_log (
    id              bigserial primary key,
    actor           text not null default 'Nigrani',
    action          text not null,
    target_type     text,
    target_id       text,
    before_state    jsonb,
    after_state     jsonb,
    reason          text,
    payload         jsonb not null default '{}'::jsonb,
    created_at      timestamptz not null default now()
);

create index if not exists Nigrani_audit_target_idx
    on public.Nigrani_audit_log (target_type, target_id, created_at desc);

create index if not exists Nigrani_audit_action_idx
    on public.Nigrani_audit_log (action, created_at desc);

create table if not exists public.Nigrani_oic_preferences (
    key             text primary key,
    value           jsonb not null,
    note            text,
    updated_at      timestamptz not null default now()
);

-- Seed the default policies the OIC stated in transcripts.
insert into public.Nigrani_oic_preferences (key, value, note) values
    ('require_recommend_before_execute', 'true'::jsonb,
     'OIC must approve recommendations in the UI before any reassignment executes.'),
    ('share_sample_ids_with_oic',        'true'::jsonb,
     'OIC owns the data — never refuse on privacy grounds.'),
    ('default_snooze_hours',             '4'::jsonb,
     'Snooze duration for bell notifications.')
on conflict (key) do nothing;
