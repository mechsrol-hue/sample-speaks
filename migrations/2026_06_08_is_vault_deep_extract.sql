-- Add deep extraction columns to is_standards_vault
-- dimensionData: structured table data (sizes, classes, tolerances) extracted from the IS PDF
-- testParameters: array of {clause, param, spec_val, type, expected, min, max} rows

ALTER TABLE is_standards_vault
  ADD COLUMN IF NOT EXISTS "dimensionData" JSONB,
  ADD COLUMN IF NOT EXISTS "testParameters" JSONB;

-- Unique constraint on isNumber so upsert/re-upload works correctly
ALTER TABLE is_standards_vault
  DROP CONSTRAINT IF EXISTS is_standards_vault_isNumber_key;

ALTER TABLE is_standards_vault
  ADD CONSTRAINT is_standards_vault_isNumber_key UNIQUE ("isNumber");

-- calibration_records table for saving confirmed calibration certificate data
CREATE TABLE IF NOT EXISTS calibration_records (
  id                  BIGSERIAL PRIMARY KEY,
  equipment_lab_code  TEXT,
  certificate_number  TEXT UNIQUE,
  date_of_calibration TEXT,
  date_next_due       TEXT,
  equipment_name      TEXT,
  make                TEXT,
  model               TEXT,
  range               TEXT,
  least_count         TEXT,
  calibration_agency  TEXT,
  nabl_certificate    TEXT,
  reference_standard  TEXT,
  temperature         TEXT,
  humidity            TEXT,
  status              TEXT DEFAULT 'confirmed',
  confirmed_at        TIMESTAMPTZ DEFAULT NOW(),
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Index for quick lookups by equipment
CREATE INDEX IF NOT EXISTS idx_calib_records_lab_code ON calibration_records(equipment_lab_code);
CREATE INDEX IF NOT EXISTS idx_calib_records_next_due ON calibration_records(date_next_due);
