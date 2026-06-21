-- Disha Agent — Phase 2/3
-- audit_log: every action Disha takes or OIC approves
-- oic_preferences: durable memory (e.g., "recommend-before-execute")

create table if not exists public.audit_log (
    id              bigserial primary key,
    action_type     text not null,
    actor           text not null,
    actor_role      text,
    target_type     text,
    target_id       text,
    before_state    jsonb,
    after_state     jsonb,
    reason          text,
    source_notification_id bigint references public.lab_notifications(id) on delete set null,
    executed_at     timestamptz not null default now(),
    created_at      timestamptz not null default now()
);

create index if not exists audit_log_action_type_idx
    on public.audit_log (action_type, executed_at desc);
create index if not exists audit_log_actor_idx
    on public.audit_log (actor, executed_at desc);
create index if not exists audit_log_target_idx
    on public.audit_log (target_type, target_id, executed_at desc);

-- OIC preferences — durable memory for lab operating rules
create table if not exists public.oic_preferences (
    id              bigserial primary key,
    key             text not null unique,
    value           jsonb not null,
    description     text,
    set_by          text,
    set_at          timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index if not exists oic_preferences_key_idx on public.oic_preferences (key);

-- Example preferences (user can insert):
-- { key: "workflow_mode", value: {"recommend_first": true, "auto_execute": false} }
-- { key: "notification_rules", value: {"alert_on_aging_days": 30, "alert_on_unassigned_count": 10} }
-- { key: "memory_window", value: {"chat_history_turns": 8, "summary_length_chars": 1000} }
