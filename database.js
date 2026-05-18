const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error connecting to SQLite database:', err.message);
    } else {
        console.log('Connected to the SQLite database. Re-initializing schema for Phase 7 (Audit Engine)...');
        initializeTables();
    }
});

function initializeTables() {
    db.serialize(() => {
        // Users Table
        db.run(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'tp'
            )
        `);

        // Drop and recreate Samples Table for Batch ID tracking
        db.run(`DROP TABLE IF EXISTS samples`);
        
        db.run(`
            CREATE TABLE samples (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                encodedCode TEXT,
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

        // Drop and recreate History Table for Batch ID tracking
        db.run(`DROP TABLE IF EXISTS upload_history`);

        db.run(`
            CREATE TABLE upload_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                batchId TEXT,
                uploadDate TEXT,
                fileName TEXT,
                sampleCount INTEGER,
                duplicateCount INTEGER,
                uploadedBy TEXT
            )
        `);

        // Create default admin user if it doesn't exist
        db.get("SELECT * FROM users WHERE username = 'admin'", (err, row) => {
            if (!row) {
                db.run("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", ['admin', 'admin123', 'admin']);
            }
        });
    });
}

module.exports = db;
