-- ============================================================================
-- 2026_06_21_fix_conformance_limits_casing.sql
-- Run in Supabase Dashboard → SQL Editor (anon key can't run DDL).
--
-- ROOT CAUSE of "column is_conformance_limits.isNumber does not exist" and the
-- silently-failing vault→limits sync:
--   The original migration created columns as UNQUOTED  isNumber, clauseRef, ...
--   Postgres folds unquoted identifiers to lowercase, so the real columns became
--   isnumber / clauseref. But the Supabase JS client queries them CASE-SENSITIVELY
--   ( .eq('isNumber', ...) → PostgREST looks for "isNumber" ) → not found.
--   select('*') still worked (returns lowercased names) → table looked "empty but present".
--
-- FIX: recreate the table with QUOTED camelCase identifiers so they are stored
-- case-sensitively and match exactly what server.js / is-pipeline.js send.
--
-- SAFETY: aborts if is_conformance_limits already holds rows, so it never
-- destroys real data. The live table was empty at time of writing (0 rows).
-- ============================================================================

DO $$
DECLARE
    n_limits  bigint := 0;
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema = 'public' AND table_name = 'is_conformance_limits') THEN
        EXECUTE 'SELECT count(*) FROM public.is_conformance_limits' INTO n_limits;
    END IF;

    IF n_limits > 0 THEN
        RAISE EXCEPTION 'ABORT: is_conformance_limits has % row(s). Migrate the data manually before running this drop/recreate.', n_limits;
    END IF;

    -- Drop dependents first (FK), then the broken table. Both are empty/new.
    DROP TABLE IF EXISTS public.test_report_observations;
    DROP TABLE IF EXISTS public.is_conformance_limits;
    RAISE NOTICE 'Dropped broken is_conformance_limits / test_report_observations (were empty).';
END $$;

-- ── is_conformance_limits ───────────────────────────────────────────────────
-- Every camelCase column is QUOTED so it is stored case-sensitively.
-- A dimensional parameter = many rows here, one per grade combination,
-- distinguished by "varietyTag" (e.g. 'DN 20 Class 1'). The grade dropdown is
-- auto-built from DISTINCT "varietyTag" values, so no schema change is ever
-- needed to add a new standard's axes.
CREATE TABLE public.is_conformance_limits (
    id              bigserial PRIMARY KEY,
    "isNumber"      text   NOT NULL,                 -- e.g. 'IS 4985:2021'
    "clauseRef"     text   NOT NULL DEFAULT '',      -- e.g. 'Cl 7.1 / Table 1'
    parameter       text   NOT NULL,                 -- e.g. 'Outer Diameter'
    unit            text,                            -- e.g. 'mm', 'N/mm²'
    "limitMin"      numeric,
    "limitMax"      numeric,
    "limitType"     text   DEFAULT 'range',          -- 'min'|'max'|'range'|'nominal'
    -- NOT NULL DEFAULT '' (not nullable) so the UNIQUE key / upsert onConflict
    -- behaves deterministically — NULLs are distinct in a UNIQUE and would break
    -- the onConflict('isNumber, clauseRef, parameter, varietyTag') upsert.
    "varietyTag"    text   NOT NULL DEFAULT '',       -- e.g. 'DN 63 Class 4' ('' = applies to all)
    "amendmentRef"  text,
    "isAmended"     boolean DEFAULT false,
    "amendmentNote" text,
    CONSTRAINT is_conformance_limits_uniq
        UNIQUE ("isNumber", "clauseRef", parameter, "varietyTag")
);
CREATE INDEX limits_is_idx       ON public.is_conformance_limits ("isNumber");
CREATE INDEX limits_is_variety_idx ON public.is_conformance_limits ("isNumber", "varietyTag");

-- ── test_report_observations (TP-entered values vs limits) ──────────────────
CREATE TABLE public.test_report_observations (
    id              bigserial PRIMARY KEY,
    "sampleId"      bigint REFERENCES public.samples(id) ON DELETE CASCADE,
    "limitId"       bigint REFERENCES public.is_conformance_limits(id) ON DELETE CASCADE,
    "observedValue" text,
    verdict         text,                            -- 'pass'|'fail'|'pending'
    remarks         text,
    "enteredBy"     text,
    "enteredAt"     timestamptz DEFAULT now(),
    CONSTRAINT test_report_observations_uniq UNIQUE ("sampleId", "limitId")
);

-- ── Access: anon-key only on this project → RLS off (matches disable_rls_all_tables.sql) ──
ALTER TABLE public.is_conformance_limits   DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_report_observations DISABLE ROW LEVEL SECURITY;

-- ── Verify (should list the exact camelCase names the code queries) ──────────
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'is_conformance_limits' ORDER BY ordinal_position;
