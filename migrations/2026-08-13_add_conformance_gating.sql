-- Conformance limits need to know which construction and category a limit belongs
-- to. Without these, a twin-cord limit keyed varietyTag '4' is indistinguishable
-- from a single-core one — the IS 694 report bug, reproduced at the pass/fail layer.
-- sync-to-master writes these columns when they exist and degrades loudly when not.
ALTER TABLE is_conformance_limits ADD COLUMN IF NOT EXISTS "appliesTo" text NOT NULL DEFAULT '';
ALTER TABLE is_conformance_limits ADD COLUMN IF NOT EXISTS "conditionalOn" text NOT NULL DEFAULT '';
