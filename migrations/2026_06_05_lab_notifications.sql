-- Nigrani Agent — Phase 1
-- lab_notifications: HITL notification queue surfaced in the OIC bell panel.
-- Phase 1 contract: approve = visible/marked only. No auto-execution.

create table if not exists public.lab_notifications (
    id              bigserial primary key,
    type            text not null,
    severity        text not null default 'info'
                    check (severity in ('info', 'warn', 'critical')),
    title           text not null,
    body            text,
    sample_ids      jsonb not null default '[]'::jsonb,
    payload         jsonb not null default '{}'::jsonb,
    dedupe_key      text not null,
    status          text not null default 'open'
                    check (status in ('open', 'approved', 'dismissed', 'snoozed')),
    snooze_until    timestamptz,
    acted_by        text,
    acted_at        timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

-- One open notification per dedupe_key. Approved/dismissed rows are kept
-- as history, so the partial index is on status = 'open' only.
create unique index if not exists lab_notifications_open_dedupe_idx
    on public.lab_notifications (dedupe_key)
    where status = 'open';

create index if not exists lab_notifications_status_idx
    on public.lab_notifications (status, created_at desc);

create index if not exists lab_notifications_severity_idx
    on public.lab_notifications (severity, created_at desc);

-- Keep updated_at fresh on writes
create or replace function public.lab_notifications_touch_updated()
returns trigger language plpgsql as $$
begin
    new.updated_at = now();
    return new;
end$$;

drop trigger if exists lab_notifications_touch on public.lab_notifications;
create trigger lab_notifications_touch
    before update on public.lab_notifications
    for each row execute function public.lab_notifications_touch_updated();
