-- 2026_06_19_conformance_limits.sql
-- Extends the existing template system with per-clause conformance limits
CREATE TABLE IF NOT EXISTS is_conformance_limits (
    id              bigserial PRIMARY KEY,
    isNumber        text NOT NULL,
    clauseRef       text NOT NULL,    -- matches activeClauses key in template
    parameter       text NOT NULL,    -- e.g. "Tensile Strength", "Wall Thickness"
    unit            text,             -- e.g. "N/mm²", "mm"
    limitMin        numeric,
    limitMax        numeric,
    limitType       text DEFAULT 'range', -- 'min' | 'max' | 'range' | 'nominal'
    varietyTag      text,             -- e.g. "DN 63", "PN 10" (null = applies to all)
    amendmentRef    text,             -- e.g. "Amd 1:2023"
    isAmended       boolean DEFAULT false,
    amendmentNote   text,
    UNIQUE(isNumber, clauseRef, parameter, varietyTag)
);
CREATE INDEX IF NOT EXISTS limits_is_idx ON is_conformance_limits(isNumber);

-- Test report observations (TP-entered values against limits)
CREATE TABLE IF NOT EXISTS test_report_observations (
    id              bigserial PRIMARY KEY,
    sampleId        bigint REFERENCES samples(id) ON DELETE CASCADE,
    limitId         bigint REFERENCES is_conformance_limits(id),
    observedValue   text,
    verdict         text,  -- 'pass' | 'fail' | 'pending'
    remarks         text,
    enteredBy       text,
    enteredAt       timestamptz DEFAULT now(),
    UNIQUE(sampleId, limitId)
);
