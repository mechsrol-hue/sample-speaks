-- Migration Script: Create is_amendments table in Supabase

CREATE TABLE IF NOT EXISTS is_amendments (
    id SERIAL PRIMARY KEY,
    "isNumber" TEXT NOT NULL,
    "amendmentNumber" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "isNew" BOOLEAN DEFAULT true,
    "publishDate" TEXT,
    "uploadedAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE is_amendments DISABLE ROW LEVEL SECURITY;
