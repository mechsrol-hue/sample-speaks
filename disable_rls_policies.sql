-- Supabase SQL Queries to fix the RLS issue for Master Templates and system preferences.
-- Run one of these options in your Supabase SQL Editor.

-- OPTION 1: Disable Row Level Security (RLS) entirely on the system_preferences table (RECOMMENDED for simple setups)
ALTER TABLE system_preferences DISABLE ROW LEVEL SECURITY;

-- OPTION 2: If you want to keep RLS active but grant all rights to Anon/Authenticated users
-- CREATE POLICY "Allow anon select" ON system_preferences FOR SELECT USING (true);
-- CREATE POLICY "Allow anon insert" ON system_preferences FOR INSERT WITH CHECK (true);
-- CREATE POLICY "Allow anon update" ON system_preferences FOR UPDATE USING (true) WITH CHECK (true);
-- CREATE POLICY "Allow anon delete" ON system_preferences FOR DELETE USING (true);
