require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');
const db = require('./database');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static('public'));

const upload = multer({ storage: multer.memoryStorage() });

function excelDateToString(excelDate) {
    if (!excelDate) return "";
    if (isNaN(excelDate) && typeof excelDate === 'string') return excelDate.trim();
    try {
        const dateNum = parseFloat(excelDate);
        if (isNaN(dateNum)) return excelDate;
        const date = new Date((dateNum - 25569) * 86400 * 1000);
        const dd = String(date.getDate()).padStart(2, '0');
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const yyyy = date.getFullYear();
        return `${dd}-${mm}-${yyyy}`;
    } catch (e) {
        return excelDate.toString();
    }
}

// Auth Routes
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    db.run("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", [username, password, 'tp'], function(err) {
        if (err) return res.status(400).json({ error: 'Username might already exist.' });
        res.json({ message: 'User registered successfully!', id: this.lastID });
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ? AND password = ?", [username, password], (err, row) => {
        if (err || !row) return res.status(401).json({ error: 'Invalid credentials.' });
        res.json({ message: 'Login successful', user: { id: row.id, username: row.username, role: row.role } });
    });
});

// Upload Parsing
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    try {
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        
        const rows = xlsx.utils.sheet_to_json(sheet); 

        db.all("SELECT encodedCode FROM samples", [], (err, dbRows) => {
            if (err) return res.status(500).json({ error: 'Database error while checking duplicates.' });

            const existingEncodes = new Set();
            dbRows.forEach(r => {
                if (r.encodedCode) existingEncodes.add(r.encodedCode.toString().toLowerCase().trim());
            });

            const freshSamples = [];
            const duplicateSamples = [];

            const findKey = (row, searchStrings) => {
                const keys = Object.keys(row);
                return keys.find(k => searchStrings.some(s => k.toLowerCase() === s.toLowerCase() || k.toLowerCase().includes(s.toLowerCase())));
            };

            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                if (!row) continue;

                const encodedCodeKey = findKey(row, ['encoded code', 'encoded sample']);
                const isNumberKey = findKey(row, ['is number']);
                const quantityKey = findKey(row, ['quantity']);
                const priorityKey = findKey(row, ['priority']);
                const receivedOnKey = findKey(row, ['received on']);
                const forwardedOnKey = findKey(row, ['forwarded on']);
                const assignedToKey = findKey(row, ['assigned to', 'tp name']);
                const totalTestKey = findKey(row, ['total test']);
                const pendingTestKey = findKey(row, ['pending test']);
                const approvedTestKey = findKey(row, ['approved test']);

                let encodedCode = encodedCodeKey ? (row[encodedCodeKey] || '').toString().trim() : '';
                
                let explicitPriority = priorityKey ? (row[priorityKey] || '').toString().trim() : 'Non-Priority';
                if (!explicitPriority || explicitPriority === 'Non-Priority') {
                    if (encodedCode.toLowerCase().endsWith('p')) {
                        explicitPriority = 'Priority';
                    }
                }

                const sample = {
                    encodedCode: encodedCode,
                    isNumber: isNumberKey ? (row[isNumberKey] || '').toString().trim() : '',
                    quantity: quantityKey ? (row[quantityKey] || '').toString().trim() : '',
                    priorityLevel: explicitPriority,
                    receivedOn: receivedOnKey ? excelDateToString(row[receivedOnKey]) : '',
                    forwardedOn: forwardedOnKey ? excelDateToString(row[forwardedOnKey]) : '',
                    assignedTo: assignedToKey ? (row[assignedToKey] || '').toString().trim() : '',
                    totalTest: totalTestKey ? (row[totalTestKey] || '').toString().trim() : '',
                    pendingTest: pendingTestKey ? (row[pendingTestKey] || '').toString().trim() : '',
                    approvedTest: approvedTestKey ? (row[approvedTestKey] || '').toString().trim() : ''
                };

                const checkCode = sample.encodedCode.toLowerCase();
                const isDuplicate = checkCode && existingEncodes.has(checkCode);

                if (isDuplicate) {
                    duplicateSamples.push(sample);
                } else if (sample.encodedCode) { 
                    freshSamples.push(sample);
                }
            }

            res.json({ freshSamples, duplicateSamples, fileName: req.file.originalname, message: 'Upload parsed dynamically' });
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to process Excel file: ' + err.message });
    }
});

// Confirm and Insert Fresh Samples (Phase 7: Batch Tracking)
app.post('/api/confirm-upload', (req, res) => {
    const { samples, duplicateCount, fileName, uploadedBy } = req.body;
    if (!samples || !Array.isArray(samples)) return res.status(400).json({ error: 'Invalid sample data provided.' });

    const batchId = 'BATCH-' + Date.now();
    let inserted = 0;
    let errors = 0;

    const stmt = db.prepare(`
        INSERT INTO samples (encodedCode, isNumber, quantity, priorityLevel, receivedOn, forwardedOn, assignedTo, totalTest, pendingTest, approvedTest, uploadBatchId)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    samples.forEach(s => {
        stmt.run([s.encodedCode, s.isNumber, s.quantity, s.priorityLevel, s.receivedOn, s.forwardedOn, s.assignedTo, s.totalTest, s.pendingTest, s.approvedTest, batchId], (err) => {
            if (err) { console.error("Error inserting:", err); errors++; }
            else { inserted++; }
        });
    });

    stmt.finalize(() => {
        const uniqueTPs = [...new Set(samples.map(s => s.assignedTo).filter(Boolean))];
        uniqueTPs.forEach(tp => {
            db.get("SELECT * FROM users WHERE username = ?", [tp], (err, row) => {
                if (!err && !row) {
                    db.run("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", [tp, '1234', 'tp']);
                }
            });
        });

        db.run("INSERT INTO upload_history (batchId, uploadDate, fileName, sampleCount, duplicateCount, uploadedBy) VALUES (?, ?, ?, ?, ?, ?)",
            [batchId, new Date().toISOString(), fileName || 'Unknown.xlsx', inserted, duplicateCount || 0, uploadedBy || 'Admin']
        );

        res.json({ message: `Successfully committed ${inserted} fresh samples to batch ${batchId}.` });
    });
});

// Get Upload History
app.get('/api/upload-history', (req, res) => {
    db.all("SELECT * FROM upload_history ORDER BY id DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ history: rows });
    });
});

// Get Batch Details (Phase 7)
app.get('/api/batch-details/:batchId', (req, res) => {
    const batchId = req.params.batchId;
    db.all("SELECT encodedCode, assignedTo, priorityLevel, isNumber FROM samples WHERE uploadBatchId = ?", [batchId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ samples: rows });
    });
});

// Get Samples for User
app.get('/api/samples/:tpName', (req, res) => {
    const tpName = req.params.tpName;
    const { role } = req.query;

    let query = "SELECT * FROM samples";
    let params = [];

    if (role !== 'admin') {
        query += " WHERE assignedTo LIKE ?";
        params.push('%' + tpName + '%');
    }

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ samples: rows });
    });
});

// Submit Sample Workflow
app.post('/api/submit-sample', (req, res) => {
    const { id, passFail } = req.body;
    let disposalDate = null;
    let appStatus = 'Submitted';
    const now = new Date();

    if (passFail === 'Pass') {
        disposalDate = now.toISOString();
    } else if (passFail === 'Fail') {
        now.setDate(now.getDate() + 45);
        disposalDate = now.toISOString();
    }

    db.run("UPDATE samples SET appStatus = ?, passFail = ?, disposalDate = ? WHERE id = ?", [appStatus, passFail, disposalDate, id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Sample submitted successfully', disposalDate });
    });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
