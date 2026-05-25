require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');
const supabase = require('./database-supabase');
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

        // Column header finder — flexible match
        const findKey = (row, searchStrings) => {
            const keys = Object.keys(row);
            return keys.find(k =>
                searchStrings.some(s =>
                    k.toLowerCase() === s.toLowerCase() ||
                    k.toLowerCase().includes(s.toLowerCase())
                )
            );
        };

        const freshSamples = [];
        const duplicateSamples = [];

        // 1. Identify all keys once before the loop to optimize performance and introduce robust matching logic
        const tpSearchHeaders = [
            'assigned to', 'tp name', 'assignedto', 'tpname', 
            'testing person name', 'testing person', 'tester', 
            'tester name', 'chemist', 'chemist name', 'analyst', 
            'analyst name', 'officer', 'allocated to', 'allocatedto', 
            'tp', 'tp_name', 'testing_person', 'tp name standard'
        ];

        let assignedToKey = findKey(rows[0], tpSearchHeaders);

        // Fallback value-matching heuristic: check if any column's content matches existing TP names in the database
        if (!assignedToKey && knownTPs.size > 0 && rows.length > 0) {
            const keys = Object.keys(rows[0]);
            let bestKey = null;
            let maxMatches = 0;
            
            keys.forEach(key => {
                let matchCount = 0;
                let nonEmptyCount = 0;
                
                const sampleLimit = Math.min(rows.length, 100);
                for (let i = 0; i < sampleLimit; i++) {
                    if (!rows[i] || typeof rows[i] !== 'object') continue;
                    const val = String(rows[i][key] || '').trim().toLowerCase();
                    if (val) {
                        nonEmptyCount++;
                        if (knownTPs.has(val)) {
                            matchCount++;
                        }
                    }
                }
                
                // Match criteria: must have highest match count and represent >= 20% of non-empty sampled entries
                if (nonEmptyCount > 0 && matchCount > maxMatches && (matchCount / nonEmptyCount) >= 0.20) {
                    maxMatches = matchCount;
                    bestKey = key;
                }
            });
            
            if (bestKey) {
                assignedToKey = bestKey;
                console.log(`Smart Fallback: Dynamically identified TP column by cell contents -> "${assignedToKey}"`);
            }
        }

        if (!assignedToKey) {
            console.log("No Assigned To column found. All samples will be placed in the Unassigned Pool.");
        }

        // Map other headers once before entering the row-by-row parsing loop
        const encodedCodeKey = findKey(rows[0], ['encoded code', 'encoded sample', 'encodedcode', 'encode', 'sample code', 'samplecode']);
        const isNumberKey    = findKey(rows[0], ['is number', 'isnumber', 'is_number']);
        const quantityKey    = findKey(rows[0], ['quantity', 'qty']);
        const priorityKey    = findKey(rows[0], ['priority']);
        const receivedOnKey  = findKey(rows[0], ['received on', 'receivedon', 'sample received on', 'received_on', 'received date']);
        const forwardedOnKey = findKey(rows[0], ['forwarded on', 'forwardedon', 'sample forwarded on', 'forwarded_on', 'forwarded date']);
        const totalTestKey   = findKey(rows[0], ['total test', 'totaltest']);
        const pendingTestKey = findKey(rows[0], ['pending test', 'pendingtest']);
        const approvedTestKey= findKey(rows[0], ['approved test', 'approvedtest']);

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
            
            // Allow upload if "Assigned To" is blank or missing for this sample
            // They will go to the Unassigned Pool.
            if (!cleanAssigned) {
                // Not throwing error anymore
            }

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

        res.json({
            freshSamples,
            duplicateSamples,
            newTPs,
            fileName: req.file.originalname,
            message: `Parsed ${freshSamples.length} fresh + ${duplicateSamples.length} duplicate records.`
        });

    } catch (err) {
        console.error('Upload parse error:', err);
        res.status(500).json({ error: 'Failed to process Excel file: ' + err.message });
    }
});


// Confirm and Insert Fresh Samples & Approved Re-allotted Duplicates
app.post('/api/confirm-upload', async (req, res) => {
    const { samples, duplicates, duplicateCount, fileName, uploadedBy } = req.body;
    if (!samples || !Array.isArray(samples)) return res.status(400).json({ error: 'Invalid sample data provided.' });
    if (samples.length === 0) return res.json({ message: 'No new records to commit.' });

    const batchId = 'BATCH-' + Date.now();

    const upsertArray = samples.map(s => ({
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
        appStatus: 'Pending'
    }));

    const { error: upsertErr } = await supabase.from('samples').upsert(upsertArray, { onConflict: 'encodedCode' });
    if (upsertErr) return res.status(500).json({ error: 'Batch insert failed: ' + upsertErr.message });

    const uniqueTPs = [...new Set(samples.map(s => s.assignedTo).filter(Boolean))];
    for (const tp of uniqueTPs) {
        const { data: user } = await supabase.from('users').select('id').eq('username', tp).single();
        if (!user) {
            await supabase.from('users').insert({ username: tp, password: '1234', role: 'tp' });
        }
    }

    const duplicatesJson = JSON.stringify(duplicates || []);
    const { error: histErr } = await supabase.from('upload_history').insert({
        batchId: batchId,
        uploadDate: new Date().toISOString(),
        fileName: fileName || 'Unknown.xlsx',
        sampleCount: samples.length,
        duplicateCount: duplicateCount || 0,
        duplicateDetails: duplicatesJson,
        uploadedBy: uploadedBy || 'Admin'
    });
    
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
    const { data: samples, error: err1 } = await supabase.from('samples').select('encodedCode, assignedTo, priorityLevel, isNumber').eq('uploadBatchId', batchId);
const { data: historyRow, error: err2 } = await supabase.from('upload_history').select('duplicateDetails').eq('batchId', batchId).single();
if (err1 || err2) return res.status(500).json({ error: (err1||err2).message });
res.json({ samples, duplicateDetails: historyRow ? historyRow.duplicateDetails : '[]' });
});

// Get Samples for User
app.get('/api/samples/:tpName', async (req, res) => {
    const tpName = cleanName(req.params.tpName);
    const { role } = req.query;

    // Simplified Supabase query
    const { data, error } = await supabase.from('samples').select('*').limit(100);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ samples: data });
});

// Submit Sample Workflow
app.post('/api/submit-sample', async (req, res) => {
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

    const filtered = role === 'admin' ? rows : rows.filter(r => r.assignedTo && r.assignedTo.toLowerCase().includes(tpName.toLowerCase()));

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
    if (role !== 'admin' || cleanName(username) !== 'Admin') {
        return res.status(403).json({ error: 'Unauthorized. Only Admin can reset the database.' });
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
        const formatted = employees.map(e => ({ ...e, loginUsername: e.users?.username })).sort((a, b) => a.fullName.localeCompare(b.fullName));
        res.json({ employees: formatted });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/employees', async (req, res) => {
    const { fullName, designation, maxDailySamples, username, password } = req.body;
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
        .insert([{ userId: newUser?.id, fullName, designation: designation || '', maxDailySamples: maxDailySamples || 5 }]);

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
    const { employeeId, leaveDate, leaveType, reason } = req.body;
    const { error } = await supabase
        .from('employee_leaves')
        .upsert([{ employeeId, leaveDate, leaveType: leaveType || 'CL', reason: reason || '' }]);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: 'Leave added.' });
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

app.post('/api/auto-assign', async (req, res) => {
    try {
        const { data: unassignedSamples, error: sampleErr } = await supabase.from('samples').select('*').or('assignedTo.is.null,assignedTo.eq.\'\'');
        if (sampleErr) throw sampleErr;
        if (unassignedSamples.length === 0) return res.json({ message: 'No unassigned samples found.', recommendations: [] });

        const todayStr = new Date().toISOString().split('T')[0];
        const { data: employees } = await supabase.from('employee_profiles').select('*').eq('isActive', 1);
        const { data: competencies } = await supabase.from('employee_competencies').select('*');
        const { data: leavesToday } = await supabase.from('employee_leaves').select('employeeId').eq('leaveDate', todayStr);
        
        const leaveSet = new Set((leavesToday || []).map(l => l.employeeId));

        let recommendationsGenerated = 0;

        // Build competency map
        const compMap = {};
        (competencies || []).forEach(c => {
            if (!compMap[c.isNumber]) compMap[c.isNumber] = [];
            compMap[c.isNumber].push(c);
        });

        // 3. Generate recommendations
        for (const sample of unassignedSamples) {
            if (!sample.isNumber) continue;
            
            // Look for matching IS
            const matchingCompetencies = compMap[sample.isNumber] || [];
            let bestEmployee = null;
            let bestScore = -1;

            for (const comp of matchingCompetencies) {
                if (leaveSet.has(comp.employeeId)) continue; // Skip if on leave today

                const emp = (employees || []).find(e => e.id === comp.employeeId);
                if (!emp) continue;

                // Calculate score: Capacity remaining
                const remainingCapacity = emp.maxDailySamples - emp.currentWorkload;
                if (remainingCapacity > 0) {
                    const score = remainingCapacity * (comp.proficiencyLevel === 'Expert' ? 1.5 : 1.0);
                    if (score > bestScore) {
                        bestScore = score;
                        bestEmployee = emp;
                    }
                }
            }

            if (bestEmployee) {
                // Generate recommendation
                const { error } = await supabase.from('assignment_recommendations').insert({
                    sampleId: sample.id,
                    recommendedEmployeeId: bestEmployee.id,
                    recommendedEmployeeName: bestEmployee.fullName,
                    reason: `Available capacity with IS competency ${sample.isNumber}`,
                    score: bestScore
                });
                if (error) console.error("Auto-assign insert error:", error);
                recommendationsGenerated++;
            }
        }

        res.json({ message: `Generated ${recommendationsGenerated} recommendations.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/recommendations', async (req, res) => {
    try {
        const { data: recs, error } = await supabase
            .from('assignment_recommendations')
            .select('*, samples!inner(encodedCode, isNumber, priorityLevel)')
            .eq('status', 'pending')
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

// Export for Vercel serverless + listen locally
const PORT = process.env.PORT || 3000;
if (!process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}
module.exports = app;
