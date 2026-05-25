const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

let dbPath;
if (process.env.RENDER) {
    // On Render, we use the persistent disk mounted at /data
    dbPath = '/data/database.sqlite';
} else {
    // Local development
    dbPath = path.resolve(__dirname, 'database.sqlite');
}

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error connecting to SQLite database:', err.message);
    } else {
        console.log(`Connected to SQLite at ${dbPath}`);
        initializeTables();
    }
});

function initializeTables() {
    db.serialize(() => {
        // Users Table (Permanent)
        db.run(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'tp'
            )
        `);

        // Samples Table (Permanent - NEVER DROPPED)
        db.run(`
            CREATE TABLE IF NOT EXISTS samples (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                encodedCode TEXT UNIQUE,
                isNumber TEXT,
                quantity TEXT,
                priorityLevel TEXT,
                receivedOn TEXT,
                forwardedOn TEXT,
                assignedTo TEXT,
                totalTest TEXT,
                pendingTest TEXT,
                approvedTest TEXT,
                appStatus TEXT DEFAULT 'Pending',
                passFail TEXT,
                disposalDate TEXT,
                uploadBatchId TEXT
            )
        `);

        // History Table (Permanent - NEVER DROPPED)
        db.run(`
            CREATE TABLE IF NOT EXISTS upload_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                batchId TEXT UNIQUE,
                uploadDate TEXT,
                fileName TEXT,
                sampleCount INTEGER,
                duplicateCount INTEGER,
                duplicateDetails TEXT,
                uploadedBy TEXT
            )
        `);

        // Run migration to guarantee existing lowercase admin accounts are converted to Title Case (Admin)
        db.run("UPDATE users SET username = 'Admin' WHERE username = 'admin'", [], () => {
            // Create default admin user securely if it doesn't exist
            db.get("SELECT * FROM users WHERE username = 'Admin'", (err, row) => {
                if (!row) {
                    db.run("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", ['Admin', 'admin123', 'admin'], (err) => {
                        if (err) console.error('Admin seed error:', err.message);
                        else console.log('Default Admin account seeded successfully.');
                    });
                }
            });
        });

        // --- NEW TABLES FOR EMPLOYEE & WORKLOAD MANAGEMENT ---

        // Employee Profiles
        db.run(`
            CREATE TABLE IF NOT EXISTS employee_profiles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                userId INTEGER,
                fullName TEXT NOT NULL,
                designation TEXT,
                maxDailySamples INTEGER DEFAULT 5,
                currentWorkload INTEGER DEFAULT 0,
                isActive INTEGER DEFAULT 1,
                FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // Employee IS Competencies
        db.run(`
            CREATE TABLE IF NOT EXISTS employee_competencies (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                employeeId INTEGER,
                isNumber TEXT NOT NULL,
                avgTestDurationHours REAL DEFAULT 8.0,
                proficiencyLevel TEXT DEFAULT 'Standard',
                UNIQUE(employeeId, isNumber),
                FOREIGN KEY(employeeId) REFERENCES employee_profiles(id) ON DELETE CASCADE
            )
        `);

        // Employee Leaves
        db.run(`
            CREATE TABLE IF NOT EXISTS employee_leaves (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                employeeId INTEGER,
                leaveDate TEXT NOT NULL,
                leaveType TEXT DEFAULT 'CL',
                reason TEXT,
                approvedBy TEXT,
                UNIQUE(employeeId, leaveDate),
                FOREIGN KEY(employeeId) REFERENCES employee_profiles(id) ON DELETE CASCADE
            )
        `);

        // Assignment Recommendations
        db.run(`
            CREATE TABLE IF NOT EXISTS assignment_recommendations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sampleId INTEGER,
                recommendedEmployeeId INTEGER,
                recommendedEmployeeName TEXT,
                reason TEXT,
                score REAL,
                status TEXT DEFAULT 'pending',
                approvedBy TEXT,
                createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
                resolvedAt TEXT,
                FOREIGN KEY(sampleId) REFERENCES samples(id) ON DELETE CASCADE,
                FOREIGN KEY(recommendedEmployeeId) REFERENCES employee_profiles(id)
            )
        `);
    });
}

module.exports = db;

