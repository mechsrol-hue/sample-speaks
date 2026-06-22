-- Create missing tables from SQLite to Supabase

CREATE TABLE IF NOT EXISTS sample_cell_data (
    id SERIAL PRIMARY KEY,
    "sNo" TEXT,
    "barcode" TEXT UNIQUE,
    "sampleCode" TEXT,
    "isNumber" TEXT,
    "testingType" TEXT,
    "labName" TEXT,
    "sampleReceivedOn" TEXT,
    "timeLagDays" TEXT,
    "reportIssuedOn" TEXT,
    "sampleStatus" TEXT,
    "reportStatus" TEXT,
    "source" TEXT,
    "uploadedAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sample_cell_history (
    id SERIAL PRIMARY KEY,
    "batchId" TEXT,
    "uploadDate" TEXT,
    "fileName" TEXT,
    "sampleCount" INTEGER,
    "duplicateCount" INTEGER,
    "uploadedBy" TEXT
);

CREATE TABLE IF NOT EXISTS is_standards_vault (
    id SERIAL PRIMARY KEY,
    "isNumber" TEXT,
    "title" TEXT,
    "pdfFileName" TEXT,
    "clauses" TEXT,
    "uncertainItems" TEXT,
    "confidenceScore" INTEGER,
    "isFullyResolved" BOOLEAN DEFAULT false,
    "uploadedAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS lims_submitted_samples (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "sampleCode" TEXT UNIQUE,
    "submittedDate" TEXT,
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Alter existing users table to add LIMS credentials
ALTER TABLE users ADD COLUMN IF NOT EXISTS "limsUsername" TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS "limsPassword" TEXT;

-- Create equipments table
CREATE TABLE IF NOT EXISTS equipments (
    id SERIAL PRIMARY KEY,
    "sNo" TEXT,
    "name" TEXT NOT NULL,
    "make" TEXT,
    "cost" TEXT,
    "labCode" TEXT UNIQUE,
    "location" TEXT,
    "dtRec" TEXT,
    "registerDetails" TEXT,
    "url" TEXT,
    "qrCode" TEXT,
    "status" TEXT DEFAULT 'Working',
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE equipments DISABLE ROW LEVEL SECURITY;

