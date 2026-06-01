require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');
const supabase = require('./database-supabase');
const db = require('./database');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static('public'));

const upload = multer({ storage: multer.memoryStorage() });

// --- Universal Name Standardizer ---
function cleanName(name) {
    if (!name) return "";
    let cleaned = name.toString()
        .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "") // Strip trailing dots, symbols
        .replace(/\s+/g, " ")                        // Compress double spaces
        .trim();
    
    // Title Case
    return cleaned.toLowerCase().split(' ').map(word => {
        if (!word) return "";
        return word.charAt(0).toUpperCase() + word.slice(1);
    }).join(' ');
}

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
app.post('/api/register', async (req, res) => {
    const username = cleanName(req.body.username);
    const password = req.body.password;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

    const { data, error } = await supabase
        .from('users')
        .insert([{ username, password, role: 'tp' }])
        .select('id')
        .single();
        
    if (error) return res.status(400).json({ error: 'Username might already exist.' });
    res.json({ message: 'User registered successfully!', id: data?.id });
});

app.post('/api/login', async (req, res) => {
    const username = cleanName(req.body.username);
    const password = req.body.password;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

    const { data: row, error } = await supabase
        .from('users')
        .select('*')
        .eq('username', username)
        .eq('password', password)
        .single();

    if (error || !row) return res.status(401).json({ error: 'Invalid credentials.' });
    res.json({ message: 'Login successful', user: { id: row.id, username: row.username, role: row.role } });
});

// Change Password
app.post('/api/change-password', async (req, res) => {
    const { userId, currentPassword, newPassword } = req.body;
    if (!userId || !currentPassword || !newPassword) return res.status(400).json({ error: 'All fields are required.' });

    const { data: row, error: fetchErr } = await supabase
        .from('users')
        .select('password')
        .eq('id', userId)
        .single();

    if (fetchErr || !row) return res.status(404).json({ error: 'User not found.' });
    if (row.password !== currentPassword) return res.status(401).json({ error: 'Current password is incorrect.' });

    const { error: updateErr } = await supabase
        .from('users')
        .update({ password: newPassword })
        .eq('id', userId);

    if (updateErr) return res.status(500).json({ error: updateErr.message });
    res.json({ message: 'Password changed successfully.' });
});

// Admin Account Management Routes
app.get('/api/admin/users', async (req, res) => {
    const { data: rows, error } = await supabase
        .from('users')
        .select('id, username, role')
        .order('username', { ascending: true });
        
    if (error) return res.status(500).json({ error: error.message });
    res.json({ users: rows || [] });
});

app.delete('/api/admin/users/:id', async (req, res) => {
    const userId = req.params.id;
    const { data: row, error: getErr } = await supabase
        .from('users')
        .select('username')
        .eq('id', userId)
        .single();

    if (row && row.username === 'Admin') {
        return res.status(400).json({ error: "Cannot delete the main admin account." });
    }
    
    const { error } = await supabase
        .from('users')
        .delete()
        .eq('id', userId);
        
    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: "Account deleted successfully." });
});

app.post('/api/admin/create-tp', async (req, res) => {
    const username = cleanName(req.body.username);
    const password = req.body.password;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

    const { data: row } = await supabase
        .from('users')
        .select('*')
        .eq('username', username)
        .single();

    if (row) return res.status(400).json({ error: 'A user with this name already exists.' });

    const { error } = await supabase
        .from('users')
        .insert([{ username, password, role: 'tp' }]);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: `Successfully created TP account for ${username}` });
});

// --- SYSTEM_FIELDS: Two-Layer Column Matching ---
const SYSTEM_FIELDS = {
    encodedCode: { synonyms: ['encoded code', 'encoded sample', 'encodedcode', 'encode', 'sample code', 'samplecode', 'sample no', 'sample number'], contentTest: (vals) => vals.some(v => /^[0-9]{2}[A-Z]{1,2}[0-9]+[A-Z]?$/i.test(v)) },
    isNumber: { synonyms: ['is number', 'isnumber', 'is_number', 'is no', 'indian standard', 'standard'], contentTest: (vals) => vals.some(v => /^(IS\s*)?\d{3,5}/.test(v)) },
    quantity: { synonyms: ['quantity', 'qty'] },
    priorityLevel: { synonyms: ['priority', 'priority level'] },
    receivedOn: { synonyms: ['received on', 'receivedon', 'sample received on', 'received_on', 'received date', 'date received', 'recv dt'], contentTest: (vals) => vals.some(v => !isNaN(v) || /\d{2}[-\/]\d{2}[-\/]\d{2,4}/.test(v)) },
    forwardedOn: { synonyms: ['forwarded on', 'forwardedon', 'sample forwarded on', 'forwarded_on', 'forwarded date'], contentTest: (vals) => vals.some(v => !isNaN(v) || /\d{2}[-\/]\d{2}[-\/]\d{2,4}/.test(v)) },
    assignedTo: { synonyms: ['assigned to', 'tp name', 'assignedto', 'tpname', 'testing person name', 'testing person', 'tester', 'tester name', 'officer', 'allocated to', 'allocatedto', 'tp', 'tp_name', 'testing_person', 'tp name standard'], contentTest: null },
    totalTest: { synonyms: ['total test', 'totaltest', 'total tests'] },
    pendingTest: { synonyms: ['pending test', 'pendingtest', 'pending tests'] },
    approvedTest: { synonyms: ['approved test', 'approvedtest', 'approved tests'] }
};

// Upload Parsing — fully async, safe for 500-1000+ row files
app.post('/api/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    try {
        // Parse Excel — defval:'' prevents undefined for empty cells
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: false });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });

        if (!rows || rows.length === 0) {
            return res.status(400).json({ error: 'Excel file appears to be empty or has no readable rows.' });
        }

        // Load existing samples and user list in parallel
        const [samplesRes, usersRes] = await Promise.all([
            supabase.from('samples').select('encodedCode, assignedTo'),
            supabase.from('users').select('username')
        ]);
        const dbRows = samplesRes.data || [];
        const userRows = usersRes.data || [];

        // Build lookup maps
        const existingSamplesMap = new Map();
        dbRows.forEach(r => {
            if (r.encodedCode) {
                existingSamplesMap.set(r.encodedCode.toString().toLowerCase().trim(), r.assignedTo || '');
            }
        });

        const knownTPs = new Set(userRows.map(u => u.username.toLowerCase().trim()));

        // --- Layer 1: Header Synonym Matching ---
        const allHeaders = Object.keys(rows[0]);
        const columnMap = {};           // { systemField: excelColumnName }
        const matchedHeaders = new Set(); // track which Excel headers are already matched
        const recognizedMappings = [];  // [{originalName, mappedTo, confidence}]

        for (const [field, config] of Object.entries(SYSTEM_FIELDS)) {
            for (const header of allHeaders) {
                if (matchedHeaders.has(header)) continue;
                const hLower = header.toLowerCase().trim();
                const matched = config.synonyms.some(s => hLower === s.toLowerCase() || hLower.includes(s.toLowerCase()));
                if (matched) {
                    columnMap[field] = header;
                    matchedHeaders.add(header);
                    recognizedMappings.push({ originalName: header, mappedTo: field, confidence: 'synonym' });
                    break;
                }
            }
        }

        // Fallback for assignedTo: value-matching heuristic against known TP names
        if (!columnMap.assignedTo && knownTPs.size > 0 && rows.length > 0) {
            let bestKey = null;
            let maxMatches = 0;
            for (const key of allHeaders) {
                if (matchedHeaders.has(key)) continue;
                let matchCount = 0;
                let nonEmptyCount = 0;
                const sampleLimit = Math.min(rows.length, 100);
                for (let i = 0; i < sampleLimit; i++) {
                    if (!rows[i] || typeof rows[i] !== 'object') continue;
                    const val = String(rows[i][key] || '').trim().toLowerCase();
                    if (val) {
                        nonEmptyCount++;
                        if (knownTPs.has(val)) matchCount++;
                    }
                }
                if (nonEmptyCount > 0 && matchCount > maxMatches && (matchCount / nonEmptyCount) >= 0.20) {
                    maxMatches = matchCount;
                    bestKey = key;
                }
            }
            if (bestKey) {
                columnMap.assignedTo = bestKey;
                matchedHeaders.add(bestKey);
                recognizedMappings.push({ originalName: bestKey, mappedTo: 'assignedTo', confidence: 'value-heuristic' });
                console.log(`Smart Fallback: Dynamically identified TP column by cell contents -> "${bestKey}"`);
            }
        }

        if (!columnMap.assignedTo) {
            console.log("No Assigned To column found. All samples will be placed in the Unassigned Pool.");
        }

        // --- Layer 2: Content Profiling for Unmatched Columns ---
        const ambiguousMappings = []; // [{originalName, sampleValues, suggestions}]
        const unmatchedHeaders = allHeaders.filter(h => !matchedHeaders.has(h));

        for (const header of unmatchedHeaders) {
            // Sample first 50 non-empty values
            const sampleVals = [];
            for (let i = 0; i < rows.length && sampleVals.length < 50; i++) {
                const val = String(rows[i][header] || '').trim();
                if (val) sampleVals.push(val);
            }
            if (sampleVals.length === 0) continue; // skip fully empty columns

            const suggestions = [];
            for (const [field, config] of Object.entries(SYSTEM_FIELDS)) {
                if (columnMap[field]) continue; // already matched
                if (config.contentTest && config.contentTest(sampleVals)) {
                    suggestions.push(field);
                }
            }

            if (suggestions.length > 0) {
                ambiguousMappings.push({ originalName: header, sampleValues: sampleVals.slice(0, 5), suggestions });
            } else {
                ambiguousMappings.push({ originalName: header, sampleValues: sampleVals.slice(0, 5), suggestions: [] });
            }
        }

        // --- Parse samples using recognized columns ---
        const freshSamples = [];
        const duplicateSamples = [];

        const encodedCodeKey = columnMap.encodedCode;
        const isNumberKey    = columnMap.isNumber;
        const quantityKey    = columnMap.quantity;
        const priorityKey    = columnMap.priorityLevel;
        const receivedOnKey  = columnMap.receivedOn;
        const forwardedOnKey = columnMap.forwardedOn;
        const assignedToKey  = columnMap.assignedTo;
        const totalTestKey   = columnMap.totalTest;
        const pendingTestKey = columnMap.pendingTest;
        const approvedTestKey= columnMap.approvedTest;

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!row || typeof row !== 'object') continue;

            const encodedCode = encodedCodeKey ? String(row[encodedCodeKey] || '').trim() : '';
            if (!encodedCode) continue; // skip rows with no encoded code

            let priorityLevel = priorityKey ? String(row[priorityKey] || '').trim() : '';
            if (!priorityLevel || priorityLevel.toLowerCase() === 'non-priority') {
                priorityLevel = encodedCode.toLowerCase().endsWith('p') ? 'Priority' : 'Non-Priority';
            }

            const rawAssigned = assignedToKey ? String(row[assignedToKey] || '').trim() : '';
            const cleanAssigned = cleanName(rawAssigned);

            const receivedOn = receivedOnKey ? excelDateToString(row[receivedOnKey]) : '';
            const forwardedOn = forwardedOnKey ? excelDateToString(row[forwardedOnKey]) : receivedOn;

            const sample = {
                encodedCode,
                isNumber:     isNumberKey    ? String(row[isNumberKey]    || '').trim() : '',
                quantity:     quantityKey    ? String(row[quantityKey]    || '').trim() : '',
                priorityLevel,
                receivedOn,
                forwardedOn,
                assignedTo:   cleanAssigned,
                totalTest:    totalTestKey   ? String(row[totalTestKey]   || '').trim() : '',
                pendingTest:  pendingTestKey ? String(row[pendingTestKey] || '').trim() : '',
                approvedTest: approvedTestKey? String(row[approvedTestKey]|| '').trim() : ''
            };

            const checkCode = encodedCode.toLowerCase();
            if (existingSamplesMap.has(checkCode)) {
                const previousTP = existingSamplesMap.get(checkCode);
                sample.isReallotted = !!(previousTP && cleanAssigned &&
                    previousTP.toLowerCase().trim() !== cleanAssigned.toLowerCase().trim());
                sample.previousTP = previousTP;
                duplicateSamples.push(sample);
            } else {
                freshSamples.push(sample);
            }
        }

        // Detect TP names not yet in the users table
        const tpNamesInFile = [...new Set(
            freshSamples.concat(duplicateSamples).map(s => s.assignedTo).filter(Boolean)
        )];
        const newTPs = tpNamesInFile.filter(name => !knownTPs.has(name.toLowerCase().trim()));

        // Detect TA names with no user account (missingAccounts)
        const missingAccounts = newTPs.slice(); // same as newTPs for now

        res.json({
            freshSamples,
            duplicateSamples,
            newTPs,
            fileName: req.file.originalname,
            message: `Parsed ${freshSamples.length} fresh + ${duplicateSamples.length} duplicate records.`,
            columnMapping: {
                recognized: recognizedMappings,
                ambiguous: ambiguousMappings
            },
            missingAccounts
        });

    } catch (err) {
        console.error('Upload parse error:', err);
        res.status(500).json({ error: 'Failed to process Excel file: ' + err.message });
    }
});


// Confirm and Insert Fresh Samples & Approved Re-allotted Duplicates
app.post('/api/confirm-upload', async (req, res) => {
    const { samples, duplicates, duplicateCount, fileName, uploadedBy, columnMappingLog } = req.body;
    if (!samples || !Array.isArray(samples)) return res.status(400).json({ error: 'Invalid sample data provided.' });
    if (samples.length === 0) return res.json({ message: 'No new records to commit.' });

    const batchId = 'BATCH-' + Date.now();

    // Check which TPs have user accounts
    const uniqueTPs = [...new Set(samples.map(s => s.assignedTo).filter(Boolean))];
    const tpAccountStatus = {};
    for (const tp of uniqueTPs) {
        const { data: user } = await supabase.from('users').select('id').eq('username', tp).single();
        tpAccountStatus[tp] = !!user;
    }

    const upsertArray = samples.map(s => {
        let appStatus = 'Pending';
        if (s.assignedTo && !tpAccountStatus[s.assignedTo]) {
            appStatus = 'PendingAccount';
        }
        return {
            encodedCode: s.encodedCode,
            isNumber: s.isNumber,
            quantity: s.quantity,
            priorityLevel: s.priorityLevel,
            receivedOn: s.receivedOn,
            forwardedOn: s.forwardedOn,
            assignedTo: s.assignedTo || null,
            totalTest: s.totalTest,
            pendingTest: s.pendingTest,
            approvedTest: s.approvedTest,
            uploadBatchId: batchId,
            appStatus
        };
    });

    const { error: upsertErr } = await supabase.from('samples').upsert(upsertArray, { onConflict: 'encodedCode' });
    if (upsertErr) return res.status(500).json({ error: 'Batch insert failed: ' + upsertErr.message });

    // Create accounts for TPs that don't exist
    for (const tp of uniqueTPs) {
        if (!tpAccountStatus[tp]) {
            await supabase.from('users').insert({ username: tp, password: '1234', role: 'tp' });
        }
    }

    // Store full duplicate objects (not just encodedCode)
    const duplicatesJson = JSON.stringify(duplicates || []);
    const historyRecord = {
        batchId: batchId,
        uploadDate: new Date().toISOString(),
        fileName: fileName || 'Unknown.xlsx',
        sampleCount: samples.length,
        duplicateCount: duplicateCount || 0,
        duplicateDetails: duplicatesJson,
        uploadedBy: uploadedBy || 'Admin'
    };

    // Save columnMappingLog if provided
    if (columnMappingLog) {
        historyRecord.columnMappingLog = typeof columnMappingLog === 'string' ? columnMappingLog : JSON.stringify(columnMappingLog);
    }

    const { error: histErr } = await supabase.from('upload_history').insert(historyRecord);
    
    if (histErr) console.error('History insert error:', histErr);
    res.json({ message: 'Upload confirmed successfully!' });
});

// Get Upload History
app.get('/api/upload-history', async (req, res) => {
    const { data, error } = await supabase.from('upload_history').select('*').order('id', { ascending: false });
if (error) return res.status(500).json({ error: error.message });
res.json({ history: data });
});

// Get Batch Details
app.get('/api/batch-details/:batchId', async (req, res) => {
    const batchId = req.params.batchId;
    const { data: samples, error: err1 } = await supabase
        .from('samples')
        .select('*')
        .eq('uploadBatchId', batchId);
    const { data: historyRow, error: err2 } = await supabase
        .from('upload_history')
        .select('*')
        .eq('batchId', batchId)
        .single();
    if (err1 || err2) return res.status(500).json({ error: (err1||err2).message });
    
    let duplicates = [];
    try { duplicates = JSON.parse(historyRow?.duplicateDetails || '[]'); } catch(e) {}
    
    res.json({ 
        samples: samples || [], 
        duplicates,
        batchInfo: historyRow || {},
        columnMappingLog: historyRow?.columnMappingLog || null
    });
});

// Get Samples for User
app.get('/api/samples/:tpName', async (req, res) => {
    const tpName = cleanName(req.params.tpName);
    const { role } = req.query;

    const isAdmin = role === 'admin' || role === 'admin_sample_cell' || role === 'super_admin';

    let query = supabase.from('samples').select('*');

    // TP users can ONLY see samples assigned to them
    if (!isAdmin) {
        query = query.eq('assignedTo', tpName);
    }

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json({ samples: data || [] });
});

// Submit Sample Workflow
app.post('/api/submit-sample', async (req, res) => {
    const { id, passFail } = req.body;
    let disposalDate = null;
    let appStatus = 'Submitted';
    const now = new Date();
    
    let passStorageDays = 15;
    let failStorageDays = 45;
    try {
        const { data: prefs } = await supabase.from('system_preferences').select('*').in('key', ['passStorageDays', 'failStorageDays']);
        if (prefs) {
            const pPass = prefs.find(p => p.key === 'passStorageDays');
            const pFail = prefs.find(p => p.key === 'failStorageDays');
            if (pPass) passStorageDays = parseInt(pPass.value) || 15;
            if (pFail) failStorageDays = parseInt(pFail.value) || 45;
        }
    } catch (e) { console.error('Could not fetch storage prefs:', e); }

    if (passFail === 'Pass') {
        now.setDate(now.getDate() + passStorageDays);
        disposalDate = now.toISOString();
    } else if (passFail === 'Fail') {
        now.setDate(now.getDate() + failStorageDays);
        disposalDate = now.toISOString();
    }

    const { error } = await supabase.from('samples').update({ appStatus, passFail, disposalDate }).eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: 'Sample submitted successfully', disposalDate });
});

// Disposal Reminders — returns overdue + upcoming (within 7 days) submitted samples
app.get('/api/disposal-reminders/:tpName', async (req, res) => {
    const tpName = cleanName(req.params.tpName);
    const { role } = req.query;

    const { data: rows, error } = await supabase.from('samples').select('*').eq('appStatus', 'Submitted');
    if (error) return res.status(500).json({ error: error.message });

    const now = new Date();
    const sevenDaysLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const filtered = (role === 'admin' || role === 'admin_sample_cell') ? rows : rows.filter(r => r.assignedTo && r.assignedTo.toLowerCase().includes(tpName.toLowerCase()));

    const overdue = [];
    const upcoming = [];

    filtered.forEach(s => {
        if (!s.disposalDate) return;
        const dispDate = new Date(s.disposalDate);
        const daysLeft = Math.ceil((dispDate - now) / (1000 * 60 * 60 * 24));

        const enriched = { ...s, daysLeft };

        if (daysLeft <= 0) {
            overdue.push(enriched);
        } else if (dispDate <= sevenDaysLater) {
            upcoming.push(enriched);
        }
    });

    // Sort overdue by most overdue first, upcoming by soonest first
    overdue.sort((a, b) => a.daysLeft - b.daysLeft);
    upcoming.sort((a, b) => a.daysLeft - b.daysLeft);

    res.json({ overdue, upcoming, total: overdue.length + upcoming.length });
});

// Admin reset-database
app.post('/api/admin/reset-database', async (req, res) => {
    const { role, username } = req.body;
    const cleanUser = cleanName(username);
    const isValidAdmin = (role === 'admin' && cleanUser === 'Admin') || (role === 'admin_sample_cell' && (cleanUser === 'Admin' || cleanUser === 'Super Admin' || cleanUser === 'admin_sample_cell'));
    if (!isValidAdmin) {
        return res.status(403).json({ error: 'Unauthorized. Only Admin or Super Admin can reset the database.' });
    }
    
    const { error: err1 } = await supabase.from('samples').delete().neq('id', 0);
    const { error: err2 } = await supabase.from('upload_history').delete().neq('id', 0);
    const { error: err3 } = await supabase.from('users').delete().neq('username', 'Admin');

    const errors = [err1, err2, err3].filter(Boolean);
    if (errors.length > 0) {
        return res.status(500).json({ error: 'Failed to reset database: ' + errors.map(e => e.message).join(', ') });
    }
    
    res.json({ message: 'Database reset successfully. All samples, history, and non-admin users deleted.' });
});

// Admin bulk delete samples
app.post('/api/admin/delete-samples-bulk', async (req, res) => {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: 'No sample IDs provided.' });
    }
    
    const { error } = await supabase.from('samples').delete().in('id', ids);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: `Successfully deleted sample(s).` });
});

// Delete single sample
app.delete('/api/samples/:id', async (req, res) => {
    const { id } = req.params;
    const { error } = await supabase.from('samples').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: 'Sample deleted successfully.' });
});

// --- LIMS Automation Routes ---
const { spawn } = require('child_process');
let activeLimsProcess = null;
let limsLogs = [];
let limsStatus = 'idle'; // 'idle', 'running', 'waiting_for_login', 'waiting_for_captcha'

app.post('/api/lims/start', (req, res) => {
    const payload = req.body;
    
    if (!payload || !payload.lims_user || !payload.lims_pass) {
        return res.status(400).json({ error: 'LIMS credentials are required.' });
    }
    
    if (activeLimsProcess) {
        return res.status(400).json({ error: 'An automation process is already running.' });
    }
    
    // Save payload to a temporary file for Python script
    const payloadPath = path.resolve(__dirname, 'lims_payload.json');
    try {
        fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2));
    } catch (err) {
        console.error('Failed to write lims_payload.json', err);
        return res.status(500).json({ error: 'Failed to initialize automation payload.' });
    }

    limsLogs = [];
    limsStatus = 'running';
    limsLogs.push(`[SYSTEM] Initializing Native LIMS automator for sample: ${payload.metadata.sampleCode}...`);
    
    console.log(`Spawning LIMS uploader with payload for: ${payload.metadata.sampleCode}`);
    
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    activeLimsProcess = spawn(pythonCmd, ['lims_uploader_is4985.py', '--payload', payloadPath]);
    
    activeLimsProcess.stdout.on('data', (data) => {
        const text = data.toString();
        // Parse logs to detect status
        if (text.includes('[AUTOMATION_WAITING_FOR_CAPTCHA]')) {
            limsStatus = 'waiting_for_captcha';
        } else if (text.includes('[AUTOMATION_WAITING_FOR_LOGIN]')) {
            limsStatus = 'waiting_for_login';
        } else if (text.includes('[SUCCESS] Login detected')) {
            limsStatus = 'running';
        }
        
        // Add to log lines
        const lines = text.split('\n').map(l => l.trim()).filter(l => l);
        limsLogs.push(...lines);
    });
    
    activeLimsProcess.stderr.on('data', (data) => {
        const text = data.toString();
        const lines = text.split('\n').map(l => l.trim()).filter(l => l);
        limsLogs.push(...lines.map(line => `[ERROR] ${line}`));
    });
    
    activeLimsProcess.on('close', (code) => {
        console.log(`LIMS uploader process exited with code ${code}`);
        limsStatus = 'idle';
        activeLimsProcess = null;
        limsLogs.push(`[SYSTEM] Automation completed. Process exited with code ${code}`);
    });
    
    res.json({ message: 'Automation started successfully.' });
});

app.post('/api/lims/preview', (req, res) => {
    const payload = req.body;
    
    // Save payload to a temporary file for Python script
    const payloadPath = path.resolve(__dirname, 'lims_payload.json');
    try {
        fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2));
    } catch (err) {
        console.error('Failed to write lims_payload.json', err);
        return res.status(500).json({ error: 'Failed to initialize preview payload.' });
    }

    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    // We don't track this in activeLimsProcess because it's just a fast preview generator
    const previewProcess = spawn(pythonCmd, ['lims_uploader_is4985.py', '--payload', payloadPath, '--preview']);
    
    previewProcess.on('close', (code) => {
        if (code === 0) {
            const sampleCode = payload.metadata.sampleCode || 'UNKNOWN';
            const pdfFile = path.resolve(__dirname, `Report_${sampleCode}.pdf`);
            if (fs.existsSync(pdfFile)) {
                res.sendFile(pdfFile);
            } else {
                res.status(500).json({ error: 'PDF was generated but file not found.' });
            }
        } else {
            res.status(500).json({ error: `Preview failed with code ${code}` });
        }
    });
});

app.get('/api/lims/status', (req, res) => {
    res.json({ status: limsStatus });
});

app.get('/api/lims/logs', (req, res) => {
    res.json({ logs: limsLogs });
});

app.post('/api/lims/stop', (req, res) => {
    if (!activeLimsProcess) {
        return res.status(400).json({ error: 'No active automation process to stop.' });
    }
    
    try {
        activeLimsProcess.kill();
        limsStatus = 'idle';
        activeLimsProcess = null;
        limsLogs.push('[SYSTEM] Automation manually stopped by user.');
        res.json({ message: 'Automation process stopped successfully.' });
    } catch (e) {
        res.status(500).json({ error: `Failed to stop automation: ${e.message}` });
    }
});

// --- EMPLOYEE & WORKLOAD MANAGEMENT API ---

app.get('/api/admin/employees', async (req, res) => {
    try {
        const { data: employees, error } = await supabase
            .from('employee_profiles')
            .select('*, users!inner(username)');
        if (error) throw error;

        // Compute currentWorkload dynamically from pending samples
        const { data: pendingSamples } = await supabase.from('samples').select('assignedTo').in('appStatus', ['Pending']);
        const loadMap = {};
        (pendingSamples || []).forEach(s => {
            if (s.assignedTo) loadMap[s.assignedTo] = (loadMap[s.assignedTo] || 0) + 1;
        });

        const formatted = employees.map(e => ({
            ...e,
            loginUsername: e.users?.username,
            currentWorkload: loadMap[e.fullName] || 0
        })).sort((a, b) => a.fullName.localeCompare(b.fullName));
        res.json({ employees: formatted });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/employees', async (req, res) => {
    const { fullName, designation, maxDailySamples, password } = req.body;
    const username = cleanName(req.body.username);
    if (!fullName || !username || !password) return res.status(400).json({ error: 'Missing required fields' });

    const { data: row } = await supabase.from('users').select('*').eq('username', username).single();
    if (row) return res.status(400).json({ error: 'Username already exists.' });

    const { data: newUser, error: userErr } = await supabase
        .from('users')
        .insert([{ username, password, role: 'tp' }])
        .select('id')
        .single();

    if (userErr) return res.status(500).json({ error: userErr.message });

    const { error: empErr } = await supabase
        .from('employee_profiles')
        .insert([{ userId: newUser?.id, fullName, designation: designation || '', maxDailySamples: maxDailySamples || 40 }]);

    if (empErr) return res.status(500).json({ error: empErr.message });
    res.json({ message: 'Employee profile created successfully.' });
});

app.get('/api/admin/competencies/:employeeId', async (req, res) => {
    try {
        const { data: competencies, error } = await supabase.from('employee_competencies').select('*').eq('employeeId', req.params.employeeId);
        if (error) throw error;
        res.json({ competencies });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/competencies', async (req, res) => {
    const { employeeId, isNumber, avgTestDurationHours, proficiencyLevel } = req.body;
    const { error } = await supabase
        .from('employee_competencies')
        .upsert([{ employeeId, isNumber, avgTestDurationHours: avgTestDurationHours || 8, proficiencyLevel: proficiencyLevel || 'Standard' }]);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: 'Competency added.' });
});

app.get('/api/admin/leaves', async (req, res) => {
    try {
        const { data: leaves, error } = await supabase
            .from('employee_leaves')
            .select('*, employee_profiles!inner(fullName)')
            .order('leaveDate', { ascending: false });
        if (error) throw error;
        const formatted = leaves.map(l => ({ ...l, fullName: l.employee_profiles?.fullName }));
        res.json({ leaves: formatted });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/leaves', async (req, res) => {
    const { employeeId, leaveDate, reason } = req.body;
    const { error } = await supabase
        .from('employee_leaves')
        .upsert([{ employeeId, leaveDate, reason: reason || '' }]);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: 'Leave added.' });
});

app.delete('/api/admin/leaves/:id', async (req, res) => {
    const { error } = await supabase.from('employee_leaves').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: 'Leave removed.' });
});

// --- AUTO-ASSIGNMENT ENGINE ---

app.get('/api/unassigned-samples', async (req, res) => {
    try {
        const { data: samples, error } = await supabase.from('samples').select('*').or('assignedTo.is.null,assignedTo.eq.\'\'');
        if (error) throw error;
        res.json({ samples });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// NEW TEMPLATE ENDPOINTS
app.get('/api/admin/templates', async (req, res) => {
        try {
            const { data } = await supabase.from('system_preferences').select('*').like('key', 'template_%');
            const templates = {};
            (data || []).forEach(p => {
                try { templates[p.key.replace('template_', '')] = JSON.parse(p.value); } catch(e){}
            });
            res.json({ templates });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/admin/templates', async (req, res) => {
        const { isNumber, templateData } = req.body;
        if (!isNumber || !templateData) return res.status(400).json({ error: 'Missing isNumber or templateData' });
        try {
            const { error } = await supabase.from('system_preferences').upsert({
                key: `template_${isNumber}`,
                value: JSON.stringify(templateData)
            }, { onConflict: 'key' });
            if (error) throw error;
            res.json({ message: 'Template saved successfully.' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/assign-sample-manual', async (req, res) => {
        const { sampleId, username } = req.body;
        if (!sampleId || !username) return res.status(400).json({ error: 'Missing sampleId or username' });
        try {
            const { error } = await supabase.from('samples').update({ assignedTo: username }).eq('id', sampleId);
            if (error) throw error;
            
            // Cleanup any pending recommendations for this sample
            await supabase.from('assignment_recommendations').delete().eq('sampleId', sampleId);
            
            res.json({ message: 'Sample manually assigned successfully.' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/auto-assign', async (req, res) => {
        try {
            // 1. Get unassigned samples
            const { data: unassignedSamples, error: sampleErr } = await supabase.from('samples').select('*').or('assignedTo.is.null,assignedTo.eq.');
            if (sampleErr) throw sampleErr;
            if (!unassignedSamples || unassignedSamples.length === 0) return res.json({ message: 'No unassigned samples found.', recommendations: [], forcedCount: 0 });

            // 2. Load preferences & Master Templates
            let priorityRankingMode = 'prioritize';
            const templates = {};
            try {
                const { data: prefRows } = await supabase.from('system_preferences').select('*');
                (prefRows || []).forEach(p => {
                    if (p.key === 'priorityRankingMode') priorityRankingMode = p.value || 'prioritize';
                    if (p.key && p.key.startsWith('template_')) {
                        try { templates[p.key.replace('template_', '')] = JSON.parse(p.value); } catch(e){}
                    }
                });
            } catch(e) { console.error('Pref load error', e); }

            // 3. Load employees, competencies, leaves
            const { data: employees } = await supabase.from('employee_profiles').select('*');
            const { data: competencies } = await supabase.from('employee_competencies').select('*');
            
            // Get leaves for TODAY
            const todayStr = new Date().toISOString().split('T')[0];
            const { data: leavesToday } = await supabase.from('employee_leaves').select('employeeId').eq('leaveDate', todayStr);
            const onLeaveToday = new Set((leavesToday || []).map(l => l.employeeId));

            // Build competency map
            const compMap = {};
            (competencies || []).forEach(c => {
                if (!compMap[c.isNumber]) compMap[c.isNumber] = [];
                compMap[c.isNumber].push(c);
            });

            // 4. Calculate Current Load Hours per TA
            const { data: allPending } = await supabase.from('samples').select('assignedTo, isNumber').in('appStatus', ['Pending']);
            const loadHoursMap = {};
            (allPending || []).forEach(s => {
                if (s.assignedTo) {
                    let h = 20; // fallback avg hours
                    if (templates[s.isNumber] && templates[s.isNumber].totalHours) {
                        h = templates[s.isNumber].totalHours;
                    }
                    loadHoursMap[s.assignedTo] = (loadHoursMap[s.assignedTo] || 0) + h;
                }
            });

            let recommendationsGenerated = 0;
            let forcedCount = 0;

            await supabase.from('assignment_recommendations').delete().eq('status', 'pending');

            const today = new Date();

            for (const sample of unassignedSamples) {
                let requiredHours = 20; // default
                if (templates[sample.isNumber] && templates[sample.isNumber].totalHours) {
                    requiredHours = templates[sample.isNumber].totalHours;
                }

                const matchingComps = compMap[sample.isNumber] || [];
                let bestEmployee = null;
                let bestScore = -Infinity;
                let bestReason = '';

                // Calculate FIFO age
                let sampleAge = 0;
                if (sample.receivedOn) {
                    const parts = sample.receivedOn.split('-');
                    if (parts.length === 3) {
                        const recDate = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
                        sampleAge = Math.floor((today - recDate) / (1000 * 60 * 60 * 24));
                    }
                }

                const isPriority = (sample.priorityLevel || '').toLowerCase() === 'priority' || (sample.encodedCode || '').toLowerCase().endsWith('p');
                const priorityBoost = (priorityRankingMode === 'prioritize' && isPriority) ? 50 : 0;

                // Evaluate competent employees
                for (const comp of matchingComps) {
                    const emp = (employees || []).find(e => e.id === comp.employeeId);
                    if (!emp) continue;

                    // We no longer strictly skip people on leave or over capacity.
                    // Instead, we heavily penalize their score and tag the recommendation.
                    let isOnLeave = onLeaveToday.has(emp.id);
                    
                    const maxQueueHours = emp.maxDailySamples || 40; // using maxDailySamples as maxQueueHours
                    const currentLoadHours = loadHoursMap[emp.fullName] || 0;
                    const availableCapacity = maxQueueHours - currentLoadHours;

                    let isOverCapacity = availableCapacity < requiredHours;

                    // Trainees cannot do Top Priority
                    if (comp.proficiencyLevel === 'Trainee' && isPriority) continue;

                    let profMult = 1.0;
                    if (comp.proficiencyLevel === 'Expert') profMult = 1.5;
                    else if (comp.proficiencyLevel === 'Trainee') profMult = 0.6;

                    // Load score factor (higher available capacity = better)
                    const capacityScore = availableCapacity * 2; 

                    // FIFO boost (1 point per day old, max 30)
                    const fifoBoost = Math.min(sampleAge, 30);

                    // Penalties
                    const leavePenalty = isOnLeave ? 1000 : 0; // Extremely low priority if on leave
                    const capacityPenalty = isOverCapacity ? 500 : 0; // Low priority if it overloads their queue

                    let score = (10 * profMult) + capacityScore + priorityBoost + fifoBoost - leavePenalty - capacityPenalty;

                    if (score > bestScore) {
                        bestScore = score;
                        bestEmployee = emp;
                        
                        let tags = [];
                        if (isOnLeave) tags.push('⚠️ ON LEAVE TODAY');
                        if (isOverCapacity) tags.push('⚠️ EXCEEDS CAPACITY');
                        let tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
                        
                        bestReason = `IS ${sample.isNumber} (${comp.proficiencyLevel})${tagStr}, Avail: ${availableCapacity.toFixed(1)} hrs left`;
                    }
                }

                // We DO NOT FORCE an assignment if nobody qualifies. We leave it Unassigned.
                if (bestEmployee) {
                    // Update the tracked load so we don't over-assign in the same batch
                    loadHoursMap[bestEmployee.fullName] = (loadHoursMap[bestEmployee.fullName] || 0) + requiredHours;

                    const { error } = await supabase.from('assignment_recommendations').insert({
                        sampleId: sample.id,
                        recommendedEmployeeId: bestEmployee.id,
                        recommendedEmployeeName: bestEmployee.fullName,
                        reason: bestReason + ` | Sample Needs: ${requiredHours} hrs`,
                        score: Math.round(bestScore * 100) / 100,
                        status: 'pending'
                    });
                    if (error) console.error('Auto-assign insert error:', error);
                    recommendationsGenerated++;
                } else {
                    console.log(`Could not assign sample ${sample.encodedCode} - everyone is on leave or at capacity.`);
                }
            }

            res.json({ message: `Generated ${recommendationsGenerated} capacity-based recommendations. Unassigned samples remain parked.`, forcedCount: 0 });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

app.get('/api/admin/recommendations', async (req, res) => {
    try {
        const { data: recs, error } = await supabase
            .from('assignment_recommendations')
            .select('*, samples!inner(encodedCode, isNumber, priorityLevel)')
            .in('status', ['pending', 'forced'])
            .order('score', { ascending: false });
        if (error) throw error;
        const formatted = recs.map(r => ({ ...r, encodedCode: r.samples?.encodedCode, isNumber: r.samples?.isNumber, priorityLevel: r.samples?.priorityLevel }));
        res.json({ recommendations: formatted });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/approve-assignment/:id', async (req, res) => {
    const recId = req.params.id;
    try {
        const { data: rec, error: fetchErr } = await supabase.from('assignment_recommendations').select('*').eq('id', recId).single();
        if (fetchErr || !rec) return res.status(404).json({ error: 'Recommendation not found' });

        // Update sample assignment
        await supabase.from('samples').update({ assignedTo: rec.recommendedEmployeeName }).eq('id', rec.sampleId);
        
        // Update employee workload
        const { data: emp } = await supabase.from('employee_profiles').select('currentWorkload').eq('id', rec.recommendedEmployeeId).single();
        if (emp) {
            await supabase.from('employee_profiles').update({ currentWorkload: (emp.currentWorkload || 0) + 1 }).eq('id', rec.recommendedEmployeeId);
        }
        
        // Mark recommendation as approved
        await supabase.from('assignment_recommendations').update({ status: 'approved', resolvedAt: new Date().toISOString() }).eq('id', recId);
        
        res.json({ message: 'Assignment approved.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/reject-assignment/:id', async (req, res) => {
    const recId = req.params.id;
    try {
        await supabase.from('assignment_recommendations').update({ status: 'rejected', resolvedAt: new Date().toISOString() }).eq('id', recId);
        res.json({ message: 'Assignment rejected.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- SAMPLE CELL SECURE API ---

app.post('/api/sample-cell/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    try {
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: false });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });

        if (!rows || rows.length === 0) {
            return res.status(400).json({ error: 'File appears empty.' });
        }

        db.serialize(() => {
            db.all('SELECT barcode FROM sample_cell_data', [], (err, existingRows) => {
                if (err) return res.status(500).json({ error: 'Database error: ' + err.message });
                
                const existingBarcodes = new Set(existingRows.map(r => String(r.barcode).toLowerCase().trim()));
                const fresh = [];
                const duplicates = [];

                const firstRowKeys = Object.keys(rows[0]);
                const findKey = (searchStrings) => firstRowKeys.find(k => searchStrings.some(s => k.toLowerCase().includes(s.toLowerCase())));

                const sNoKey = findKey(['s.no', 'sno', 's no', 'sl no']);
                const barcodeKey = findKey(['barcode', 'bar code', 'bar-code']);
                const sampleCodeKey = findKey(['sample code', 'samplecode', 'sample id']);
                const isNumberKey = findKey(['is number', 'isnumber', 'is_number', 'is-number']);
                const testingTypeKey = findKey(['testing type', 'testing_type']);
                const labNameKey = findKey(['lab name', 'labname', 'lab']);
                const receivedKey = findKey(['sample received on', 'received', 'receipt']);
                const lagKey = findKey(['time lag', 'lag']);
                const issuedKey = findKey(['report issued on', 'issued']);
                const sampleStatusKey = findKey(['sample status', 'samplestatus']);
                const reportStatusKey = findKey(['report status', 'reportstatus']);
                const sourceKey = findKey(['source']);

                if (!barcodeKey) {
                    return res.status(400).json({ error: 'Could not find a Barcode column in the uploaded file.' });
                }

                rows.forEach(row => {
                    const barcodeVal = row[barcodeKey];
                    if (!barcodeVal) return;
                    
                    const barcode = String(barcodeVal).trim();

                    const record = {
                        sNo: sNoKey ? String(row[sNoKey]).trim() : '',
                        barcode: barcode,
                        sampleCode: sampleCodeKey ? String(row[sampleCodeKey]).trim() : '',
                        isNumber: isNumberKey ? String(row[isNumberKey]).trim() : '',
                        testingType: testingTypeKey ? String(row[testingTypeKey]).trim() : '',
                        labName: labNameKey ? String(row[labNameKey]).trim() : '',
                        sampleReceivedOn: receivedKey ? excelDateToString(row[receivedKey]) : '',
                        timeLagDays: lagKey ? String(row[lagKey]).trim() : '',
                        reportIssuedOn: issuedKey ? excelDateToString(row[issuedKey]) : '',
                        sampleStatus: sampleStatusKey ? String(row[sampleStatusKey]).trim() : '',
                        reportStatus: reportStatusKey ? String(row[reportStatusKey]).trim() : '',
                        source: sourceKey ? String(row[sourceKey]).trim() : ''
                    };

                    if (existingBarcodes.has(barcode.toLowerCase())) {
                        duplicates.push(record);
                    } else {
                        fresh.push(record);
                    }
                });

                res.json({
                    fresh: fresh,
                    duplicates: duplicates,
                    fileName: req.file.originalname
                });
            });
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to process file: ' + err.message });
    }
});

app.post('/api/sample-cell/commit', (req, res) => {
    const { fresh, duplicates, fileName, uploadedBy } = req.body;
    if (!fresh || !duplicates) return res.status(400).json({ error: 'Invalid payload.' });

    const allRecords = [...fresh, ...duplicates];
    if (allRecords.length === 0) return res.status(400).json({ error: 'No records to commit.' });

    db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        const stmt = db.prepare(`
            INSERT INTO sample_cell_data (
                sNo, barcode, sampleCode, isNumber, testingType, labName, 
                sampleReceivedOn, timeLagDays, reportIssuedOn, sampleStatus, reportStatus, source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(barcode) DO UPDATE SET
                sampleCode=excluded.sampleCode,
                isNumber=excluded.isNumber,
                testingType=excluded.testingType,
                labName=excluded.labName,
                sampleReceivedOn=excluded.sampleReceivedOn,
                timeLagDays=excluded.timeLagDays,
                reportIssuedOn=excluded.reportIssuedOn,
                sampleStatus=excluded.sampleStatus,
                reportStatus=excluded.reportStatus,
                source=excluded.source
        `);

        allRecords.forEach(r => {
            stmt.run(r.sNo, r.barcode, r.sampleCode, r.isNumber, r.testingType, r.labName, r.sampleReceivedOn, r.timeLagDays, r.reportIssuedOn, r.sampleStatus, r.reportStatus, r.source);
        });
        stmt.finalize();

        const batchId = 'SC-BATCH-' + Date.now();
        db.run(`
            INSERT INTO sample_cell_history (batchId, uploadDate, fileName, sampleCount, duplicateCount, uploadedBy)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [batchId, new Date().toISOString(), fileName, fresh.length, duplicates.length, uploadedBy], function(err) {
            if (err) {
                db.run('ROLLBACK');
                return res.status(500).json({ error: 'Audit log failed: ' + err.message });
            }
            db.run('COMMIT', (err) => {
                if (err) return res.status(500).json({ error: 'Transaction failed: ' + err.message });
                res.json({ message: `Successfully committed ${allRecords.length} records. Batch: ${batchId}` });
            });
        });
    });
});

app.get('/api/sample-cell/history', (req, res) => {
    db.all('SELECT * FROM sample_cell_history ORDER BY id DESC', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ history: rows || [] });
    });
});

app.get('/api/sample-cell/data', (req, res) => {
    db.all('SELECT * FROM sample_cell_data ORDER BY id DESC', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        let over15 = 0;
        let over30 = 0;
        let over45 = 0;
        let over60 = 0;
        let over90 = 0;
        let totalPending = 0;

        const now = new Date();

        const dataWithAge = rows.map(r => {
            let ageDays = 0;
            if (r.sampleReceivedOn) {
                // Normalize separators to hyphens
                const cleanDate = r.sampleReceivedOn.replace(/[\/\.]/g, '-').trim();
                const parts = cleanDate.split('-');
                let receivedDate = null;
                
                if (parts.length === 3) {
                    if (parts[0].length === 4) {
                        // yyyy-mm-dd
                        receivedDate = new Date(`${parts[0]}-${parts[1]}-${parts[2]}T00:00:00`);
                    } else if (parts[2].length === 4) {
                        // dd-mm-yyyy
                        receivedDate = new Date(`${parts[2]}-${parts[1]}-${parts[0]}T00:00:00`);
                    }
                } 
                
                if (!receivedDate || isNaN(receivedDate.getTime())) {
                    // Fallback to native parsing
                    receivedDate = new Date(r.sampleReceivedOn);
                }

                if (receivedDate && !isNaN(receivedDate.getTime())) {
                    ageDays = Math.floor((now - receivedDate) / (1000 * 60 * 60 * 24));
                    // Ensure age is never negative
                    if (ageDays < 0) ageDays = 0;
                }
            }

            if (r.reportStatus !== 'Report Issued') {
                totalPending++;
                if (ageDays > 90) over90++;
                else if (ageDays > 60) over60++;
                else if (ageDays > 45) over45++;
                else if (ageDays > 30) over30++;
                else if (ageDays > 15) over15++;
            }

            return { ...r, ageDays };
        });

        res.json({
            data: dataWithAge,
            analytics: { over15, over30, over45, over60, over90, totalPending }
        });
    });
});

app.delete('/api/sample-cell/data', (req, res) => {
    db.run('DELETE FROM sample_cell_data', function(err) {
        if (err) return res.status(500).json({ error: 'Failed to delete confidential data: ' + err.message });
        res.json({ message: 'All confidential data successfully wiped from the local vault.' });
    });
});

// --- EMPLOYEE CAPACITY ---
app.get('/api/admin/employees/:id/capacity', async (req, res) => {
    try {
        const empId = req.params.id;
        const { data: emp } = await supabase.from('employee_profiles').select('*').eq('id', empId).single();
        if (!emp) return res.status(404).json({ error: 'Employee not found' });
        
        // Count live pending samples
        const { data: samples } = await supabase.from('samples').select('id').eq('assignedTo', emp.fullName).in('appStatus', ['Pending']);
        const currentLoad = samples ? samples.length : 0;
        
        // Get competencies
        const { data: competencies } = await supabase.from('employee_competencies').select('*').eq('employeeId', empId);
        
        res.json({ currentLoad, competencies: competencies || [], fullName: emp.fullName });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- PREFERENCES API ---
app.get('/api/preferences', async (req, res) => {
    try {
        const { data, error } = await supabase.from('system_preferences').select('*');
        if (error) {
            // Table might not exist yet, return defaults
            return res.json({ preferences: {
                priorityRankingMode: 'prioritize',
                leaveWindowDays: '30',
                autoRunAssigner: 'false',
                passStorageDays: '15',
                failStorageDays: '45'
            }});
        }
        const prefs = {};
        (data || []).forEach(row => { prefs[row.key] = row.value; });
        // Fill defaults
        if (!prefs.priorityRankingMode) prefs.priorityRankingMode = 'prioritize';
        if (!prefs.leaveWindowDays) prefs.leaveWindowDays = '30';
        if (!prefs.autoRunAssigner) prefs.autoRunAssigner = 'false';
        if (!prefs.passStorageDays) prefs.passStorageDays = '15';
        if (!prefs.failStorageDays) prefs.failStorageDays = '45';
        res.json({ preferences: prefs });
    } catch (err) {
        res.json({ preferences: { priorityRankingMode: 'prioritize', leaveWindowDays: '30', autoRunAssigner: 'false', passStorageDays: '15', failStorageDays: '45' } });
    }
});

app.post('/api/preferences', async (req, res) => {
    try {
        const prefs = req.body;
        const entries = Object.entries(prefs);
        for (const [key, value] of entries) {
            await supabase.from('system_preferences').upsert({ key, value: String(value), updatedAt: new Date().toISOString() }, { onConflict: 'key' });
        }
        res.json({ message: 'Preferences saved.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- DIRECT ASSIGN ---
app.post('/api/admin/direct-assign', async (req, res) => {
    const { sampleId, assignedTo } = req.body;
    if (!sampleId || !assignedTo) return res.status(400).json({ error: 'Sample ID and assignee required.' });
    
    const { error } = await supabase.from('samples').update({ assignedTo, appStatus: 'Pending' }).eq('id', sampleId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: `Sample assigned to ${assignedTo}.` });
});

// --- ACTIVATE PENDING ACCOUNT ---
app.post('/api/admin/activate-pending-account', async (req, res) => {
    const { tpName } = req.body;
    if (!tpName) return res.status(400).json({ error: 'TP name required.' });
    
    const { data, error } = await supabase.from('samples').update({ appStatus: 'Pending' }).eq('assignedTo', tpName).eq('appStatus', 'PendingAccount');
    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: `Activated samples for ${tpName}.` });
});

// --- APPROVE ALL RECOMMENDATIONS ---
app.post('/api/admin/approve-all-recommendations', async (req, res) => {
    try {
        const { data: recs, error: fetchErr } = await supabase.from('assignment_recommendations').select('*').in('status', ['pending', 'forced']);
        if (fetchErr) throw fetchErr;
        if (!recs || recs.length === 0) return res.json({ message: 'No pending recommendations to approve.' });

        let approved = 0;
        for (const rec of recs) {
            await supabase.from('samples').update({ assignedTo: rec.recommendedEmployeeName }).eq('id', rec.sampleId);
            await supabase.from('assignment_recommendations').update({ status: 'approved', resolvedAt: new Date().toISOString() }).eq('id', rec.id);
            approved++;
        }
        res.json({ message: `Approved ${approved} assignments.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- MOCK GENERATOR ---
app.post('/api/admin/generate-mocks', async (req, res) => {
    try {
        const mockSamples = [];
        const isNumbers = ['IS 4985', 'IS 13592', 'IS 15778', 'IS 14735', 'IS 15328'];
        const priorities = ['Standard', 'Priority'];
        
        for (let i = 0; i < 50; i++) {
            mockSamples.push({
                encodedCode: `MOCK-${Date.now().toString().slice(-6)}-${i}`,
                isNumber: isNumbers[Math.floor(Math.random() * isNumbers.length)],
                priorityLevel: Math.random() > 0.8 ? 'Priority' : 'Standard',
                receivedOn: new Date().toLocaleDateString('en-GB').replace(/\//g, '-'),
                forwardedOn: new Date(Date.now() - Math.floor(Math.random() * 20) * 86400000).toLocaleDateString('en-GB').replace(/\//g, '-'),
                quantity: '1',
                appStatus: 'Pending',
                assignedTo: null
            });
        }
        
        const { error } = await supabase.from('samples').insert(mockSamples);
        if (error) throw error;
        
        res.json({ message: '50 Mock samples successfully injected into unassigned pool!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// IS INTELLIGENCE MODULE — Backend Logic & Local RAG API
// ============================================================

const pdfParse = require('pdf-parse');

// Promisified SQLite functions
function dbRun(query, params = []) {
    return new Promise((resolve, reject) => {
        db.run(query, params, function(err) {
            if (err) reject(err);
            else resolve(this);
        });
    });
}

function dbAll(query, params = []) {
    return new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function dbGet(query, params = []) {
    return new Promise((resolve, reject) => {
        db.get(query, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

// Extract PDF page by page
async function extractPdfPages(buffer) {
    let pages = [];
    const options = {
        pagerender: function(pageData) {
            return pageData.getTextContent().then(function(textContent) {
                let lastY, text = '';
                for (let item of textContent.items) {
                    if (lastY == item.transform[5] || !lastY){
                        text += item.str;
                    } else {
                        text += '\n' + item.str;
                    }
                    lastY = item.transform[5];
                }
                pages.push({
                    page: pageData.pageIndex + 1,
                    text: text
                });
                return text;
            });
        }
    };
    await pdfParse(buffer, options);
    pages.sort((a, b) => a.page - b.page);
    return pages;
}

// Call LM Studio with retry and model discovery
async function callLMStudio(systemPrompt, userPrompt) {
    const lmStudioUrl = process.env.LM_STUDIO_URL || 'http://localhost:1234/v1';
    let modelId = 'qwen/qwen2.5-coder-14b';
    
    try {
        const modelsRes = await fetch(`${lmStudioUrl}/models`);
        if (modelsRes.ok) {
            const modelsData = await modelsRes.json();
            if (modelsData.data && modelsData.data.length > 0) {
                const activeModel = modelsData.data.find(m => !m.id.includes('embed')) || modelsData.data[0];
                modelId = activeModel.id;
            }
        }
    } catch(e) {
        console.warn("Could not query active model from LM Studio, using default:", e.message);
    }

    const payload = {
        model: modelId,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ],
        temperature: 0.1,
    };

    const res = await fetch(`${lmStudioUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`LM Studio Error: ${res.status} - ${errText}`);
    }

    const resData = await res.json();
    return resData.choices[0].message.content;
}

// Simple keyword matching across pages
function findRelevantPages(pages, query, topN = 3) {
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const scoredPages = pages.map(p => {
        let score = 0;
        const pageTextLower = (p.text || '').toLowerCase();
        queryWords.forEach(word => {
            if (pageTextLower.includes(word)) {
                const occurrences = pageTextLower.split(word).length - 1;
                score += occurrences;
            }
        });
        return { page: p.page, text: p.text, score };
    });
    scoredPages.sort((a, b) => b.score - a.score);
    // Keep top pages, ensure page 1-3 are included if query matches are low
    let selected = scoredPages.slice(0, topN).filter(p => p.score > 0);
    if (selected.length === 0) {
        selected = pages.slice(0, 2);
    }
    return selected;
}

// 1. Vault List
app.get('/api/is-intelligence/vault', async (req, res) => {
    try {
        const rows = await dbAll('SELECT id, isNumber, title, pdfFileName, uncertainItems, confidenceScore, uploadedAt FROM is_standards_vault ORDER BY id DESC');
        const formatted = rows.map(r => {
            let uncertain = [];
            try { uncertain = JSON.parse(r.uncertainItems || '[]'); } catch(e){}
            const hasUncertainties = uncertain.some(item => !item.resolved);
            return {
                id: r.id,
                isNumber: r.isNumber,
                title: r.title,
                pdfFileName: r.pdfFileName,
                uploadedAt: r.uploadedAt,
                confidenceScore: r.confidenceScore,
                status: hasUncertainties ? 'has_uncertainties' : 'parsed',
                clauseCount: 12, // Mock count placeholder
                tableCount: 6 // Mock count placeholder
            };
        });
        res.json({ vault: formatted });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// 1b. Single Vault Item Details
app.get('/api/is-intelligence/vault/:id', async (req, res) => {
    try {
        const row = await dbGet('SELECT * FROM is_standards_vault WHERE id = ?', [req.params.id]);
        if (!row) {
            return res.status(404).json({ error: "Document not found" });
        }
        res.json({
            id: row.id,
            isNumber: row.isNumber,
            title: row.title,
            pdfFileName: row.pdfFileName,
            clauses: JSON.parse(row.extractedClauses || '[]'),
            tables: JSON.parse(row.extractedTables || '[]'),
            uncertainItems: JSON.parse(row.uncertainItems || '[]'),
            isFullyResolved: row.isFullyResolved === 1,
            confidenceScore: row.confidenceScore,
            uploadedAt: row.uploadedAt
        });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// 2. Upload and Parse IS Standard
app.post('/api/is-intelligence/upload', upload.single('pdf'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "No PDF file uploaded" });
    }
    try {
        const pages = await extractPdfPages(req.file.buffer);
        // We take the first 10 pages for parsing metadata and index
        const firstPagesText = pages.slice(0, 10).map(p => `--- PAGE ${p.page} ---\n${p.text}`).join('\n');
        
        const systemPrompt = `You are a technical document parser. Analyze the text of the uploaded Indian Standard (IS) document and extract key metadata in strict JSON format.
Respond ONLY with a JSON object wrapped inside a \`\`\`json ... \`\`\` code block.

JSON Schema:
{
  "isNumber": "e.g. 'IS 4985 (2021)'",
  "title": "e.g. 'Unplasticized PVC Pipes for Potable Water Supplies'",
  "confidenceScore": 0.0 to 1.0,
  "clauses": [
     { "clauseNumber": "e.g. '5'", "title": "Classification", "page": 3, "content": "Summary of classification parameters" }
  ],
  "tables": [
     { "tableNumber": "e.g. 'Table 1'", "title": "Mean Outside Diameter", "page": 5, "previewContent": "Brief description of the structure" }
  ],
  "uncertainItems": [
     { "id": "u1", "page": 5, "clauseNumber": "Table 1", "rawText": "Raw text matching the obscured/unclear block", "highlightedText": "Raw text with unclear parts wrapped in <mark>???</mark>", "reason": "Reason for uncertainty", "confidence": 0.35, "resolved": false, "userValue": "" }
  ]
}

Ensure you scan for any blurred numbers, strange unicode characters in tables, or values with '?' and put them in 'uncertainItems'. Extract up to 10 key clauses/tables containing dimensions, tolerances, and testing parameters.`;

        const userPrompt = `Here is the text of the first 10 pages:\n\n${firstPagesText}`;
        
        let parsedData;
        try {
            const rawContent = await callLMStudio(systemPrompt, userPrompt);
            const jsonMatch = rawContent.match(/```json\s*([\s\S]*?)\s*```/) || rawContent.match(/{[\s\S]*}/);
            const jsonStr = jsonMatch ? jsonMatch[1] || jsonMatch[0] : rawContent;
            parsedData = JSON.parse(jsonStr.trim());
            
            // Sanitize to prevent missing keys from causing crashes
            parsedData.isNumber = parsedData.isNumber || `IS Standard (${req.file.originalname})`;
            parsedData.title = parsedData.title || 'Uploaded Document';
            parsedData.clauses = parsedData.clauses || [];
            parsedData.tables = parsedData.tables || [];
            parsedData.uncertainItems = parsedData.uncertainItems || [];
            parsedData.confidenceScore = parsedData.confidenceScore || 0.8;
        } catch(e) {
            console.error("LLM parser failed, using fallback:", e);
            parsedData = {
                isNumber: `IS Standard (${req.file.originalname})`,
                title: 'Uploaded Document',
                confidenceScore: 0.8,
                clauses: [
                    { clauseNumber: "1", title: "Scope", page: 1, content: "This standard covers general requirements." }
                ],
                tables: [],
                uncertainItems: []
            };
        }

        const insertQuery = `
            INSERT INTO is_standards_vault 
            (isNumber, title, pdfFileName, rawExtractedContext, extractedClauses, extractedTables, uncertainItems, isFullyResolved, confidenceScore)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        const result = await dbRun(insertQuery, [
            parsedData.isNumber,
            parsedData.title,
            req.file.originalname,
            JSON.stringify(pages),
            JSON.stringify(parsedData.clauses),
            JSON.stringify(parsedData.tables),
            JSON.stringify(parsedData.uncertainItems),
            parsedData.uncertainItems.length === 0 ? 1 : 0,
            parsedData.confidenceScore
        ]);

        res.json({
            id: result.lastID,
            isNumber: parsedData.isNumber,
            title: parsedData.title,
            pdfFileName: req.file.originalname,
            clauses: parsedData.clauses,
            tables: parsedData.tables,
            uncertainItems: parsedData.uncertainItems,
            status: parsedData.uncertainItems.length > 0 ? 'has_uncertainties' : 'parsed',
            confidenceScore: parsedData.confidenceScore || 0.95
        });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// 3. RAG Query
app.post('/api/is-intelligence/query', async (req, res) => {
    const { documentId, query } = req.body;
    if (!documentId || !query) {
        return res.status(400).json({ error: "Missing required fields: documentId, query" });
    }
    try {
        const doc = await dbGet('SELECT * FROM is_standards_vault WHERE id = ?', [documentId]);
        if (!doc) {
            return res.status(404).json({ error: "Standard not found" });
        }

        const pages = JSON.parse(doc.rawExtractedContext || '[]');
        const relevant = findRelevantPages(pages, query, 3);
        const contextText = relevant.map(p => `--- PAGE ${p.page} ---\n${p.text}`).join('\n\n');

        const systemPrompt = `You are a technical document analyst answering questions about the active Indian Standard (IS) document.
Answer the user's question based strictly on the provided document context. Do not use any external knowledge.
If you cannot find the answer in the provided context, state that the information is not in the document.
Cite the exact page number, clause number, and matching sentence from the context.
You must return your response as a valid JSON object in a \`\`\`json ... \`\`\` block with the following schema:
{
  "answer": "Your detailed answer written in markdown format (can include bullet points and simple tables).",
  "citations": [
     { "page": 5, "clause": "e.g. Cl 7.1.1", "text": "Specific sentence from document matching the answer" }
  ]
}`;

        const userPrompt = `Context:\n${contextText}\n\nQuestion: ${query}`;
        
        let queryResult;
        try {
            const rawContent = await callLMStudio(systemPrompt, userPrompt);
            const jsonMatch = rawContent.match(/```json\s*([\s\S]*?)\s*```/) || rawContent.match(/{[\s\S]*}/);
            const jsonStr = jsonMatch ? jsonMatch[1] || jsonMatch[0] : rawContent;
            queryResult = JSON.parse(jsonStr.trim());
            
            // Sanitize queryResult
            queryResult.answer = queryResult.answer || "No answer could be generated from the document.";
            queryResult.citations = queryResult.citations || [];
        } catch(e) {
            console.error("LLM RAG query failed:", e);
            queryResult = {
                answer: "The local AI failed to query the document successfully. Please ensure LM Studio is running correctly.",
                citations: []
            };
        }
        res.json(queryResult);
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// 4. Submit Clarification
app.post('/api/is-intelligence/clarify', async (req, res) => {
    const { documentId, itemId, resolvedValue } = req.body;
    if (!documentId || !itemId || !resolvedValue) {
        return res.status(400).json({ error: "Missing required fields: documentId, itemId, resolvedValue" });
    }
    try {
        const doc = await dbGet('SELECT * FROM is_standards_vault WHERE id = ?', [documentId]);
        if (!doc) {
            return res.status(404).json({ error: "Standard not found" });
        }

        let items = JSON.parse(doc.uncertainItems || '[]');
        items = items.map(item => {
            if (item.id === itemId) {
                item.resolved = true;
                item.userValue = resolvedValue;
                item.confidence = 1.0;
            }
            return item;
        });

        const allResolved = items.every(item => item.resolved) ? 1 : 0;
        await dbRun('UPDATE is_standards_vault SET uncertainItems = ?, isFullyResolved = ? WHERE id = ?', [
            JSON.stringify(items),
            allResolved,
            documentId
        ]);

        res.json({ success: true, uncertainItems: items });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// 5. Dynamic Tolerance Lookup API
app.get('/api/is-intelligence/lookup', async (req, res) => {
    const { isNumber, size, class: pipeClass } = req.query;
    if (!isNumber || !size || !pipeClass) {
        return res.status(400).json({ error: "Missing size, class or isNumber" });
    }
    try {
        const doc = await dbGet('SELECT * FROM is_standards_vault WHERE isNumber LIKE ? OR title LIKE ?', [`%${isNumber}%`, `%${isNumber}%`]);
        if (!doc) {
            return res.status(404).json({ error: "Standard not found in vault" });
        }
        const pages = JSON.parse(doc.rawExtractedContext || '[]');
        const relevantPages = pages.filter(p => 
            p.text.toLowerCase().includes('table') && 
            (p.text.toLowerCase().includes('dimension') || p.text.toLowerCase().includes('thickness') || p.text.toLowerCase().includes('diameter'))
        );
        const contextText = relevantPages.map(p => `--- PAGE ${p.page} ---\n${p.text}`).join('\n\n');

        const systemPrompt = `You are a precision lookup assistant for Indian Standards. Extract specific tolerance and dimensional values from the provided document text.
Respond strictly in JSON format wrapped in a \`\`\`json ... \`\`\` block with the following schema:
{
  "min_od": "Float (in mm) or null",
  "max_od": "Float (in mm) or null",
  "ovality": "Float (in mm) or null",
  "min_wall": "Float (in mm) or null",
  "max_wall": "Float (in mm) or null",
  "socket_length": "Float (in mm) or null",
  "citation": "String citing Table number and page"
}`;
        const userPrompt = `Context:\n${contextText.slice(0, 30000)}\n\nExtract dimensions for size: "${size}mm" and class: "Class ${pipeClass}" (or equivalent pressure rating).`;
        
        let result;
        try {
            const rawContent = await callLMStudio(systemPrompt, userPrompt);
            const jsonMatch = rawContent.match(/```json\s*([\s\S]*?)\s*```/) || rawContent.match(/{[\s\S]*}/);
            const jsonStr = jsonMatch ? jsonMatch[1] || jsonMatch[0] : rawContent;
            result = JSON.parse(jsonStr.trim());
            
            // Sanitize lookup result
            result.min_od = result.min_od !== undefined ? result.min_od : null;
            result.max_od = result.max_od !== undefined ? result.max_od : null;
            result.ovality = result.ovality !== undefined ? result.ovality : null;
            result.min_wall = result.min_wall !== undefined ? result.min_wall : null;
            result.max_wall = result.max_wall !== undefined ? result.max_wall : null;
            result.socket_length = result.socket_length !== undefined ? result.socket_length : null;
            result.citation = result.citation || "No citation provided.";
        } catch(e) {
            console.error("LLM Lookup failed, using nulls:", e);
            result = { min_od: null, max_od: null, ovality: null, min_wall: null, max_wall: null, socket_length: null, citation: "Error parsing" };
        }
        res.json(result);
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// Export for Vercel serverless + listen locally
const PORT = process.env.PORT || 3000;
if (!process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}
module.exports = app;
