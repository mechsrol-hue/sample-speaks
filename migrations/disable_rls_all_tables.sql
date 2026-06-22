-- ============================================================================
-- FIX: Disable RLS on all backend tables (safe — skips tables that don't exist yet)
-- Run this in Supabase Dashboard → SQL Editor
-- ============================================================================

DO $$
DECLARE
  tbl TEXT;
  tables TEXT[] := ARRAY[
    'is_standards_vault',
    'is_conformance_limits',
    'is_amendments',
    'samples',
    'users',
    'upload_history',
    'employee_profiles',
    'employee_competencies',
    'employee_attendance',
    'employee_leaves',
    'sample_cell_data',
    'sample_cell_history',
    'test_report_observations',
    'lims_submitted_samples',
    'calibration_records',
    'audit_log',
    'lab_notifications',
    'system_preferences',
    'oic_preferences',
    'equipments',
    'assignment_recommendations'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tbl
    ) THEN
      EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', tbl);
      RAISE NOTICE 'Disabled RLS on: %', tbl;
    ELSE
      RAISE NOTICE 'Skipped (table does not exist): %', tbl;
    END IF;
  END LOOP;
END $$;
