require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');
const supabase = require('./database-supabase');
const path = require('path');
const fs = require('fs');
const hoursModel = require('./server/ml/hours-model');
// IS Intelligence single input = Claude Agent SDK path (/api/is-intelligence/agent-extract).
// The OpenRouter 6-phase pipeline (server/pipeline/is-pipeline.js) was retired as an input on
// 2026-06-24; the file stays on disk (unreferenced) for reversibility. specs_db.js is kept only
// as the canonical IS 4985 report reference, never as an extraction input.

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static('public'));

const upload = multer({ storage: multer.memoryStorage() });
const MASTER_LIST_FILE = path.join(__dirname, 'Sample Speaks.xlsx');

// ── Admin sessions ─────────────────────────────────────────────────────────────
// Scope: the destructive IS Intelligence routes only (retire a standard, re-link a
// standard to the Master Templates). Those change what the whole lab tests against,
// so a hidden nav item is not a control — the server has to decide.
//
// /api/login mints an unguessable token; the protected routes require it. Nothing
// else in the app is touched, so no existing flow can break on a missing token.
// Deliberately NOT a general auth layer: every other endpoint remains unauthenticated,
// and this does not pretend otherwise.
//
// Tokens live in memory: a server restart signs everyone out of these two actions
// (the client then asks the user to sign in again). Acceptable at this scale, and it
// keeps the token off disk.
// require inline — `crypto` is already declared further down this file.
const SESSIONS = new Map();               // token -> { userId, username, role, expiresAt }
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const ADMIN_ROLES = new Set(['admin', 'admin_sample_cell', 'super_admin']);

function issueSession(user) {
    const token = require('crypto').randomBytes(32).toString('hex');
    SESSIONS.set(token, {
        userId: user.id,
        username: user.username,
        role: user.role,
        expiresAt: Date.now() + SESSION_TTL_MS
    });
    // Opportunistic sweep — no timer, so this can't keep the process alive.
    for (const [t, s] of SESSIONS) if (s.expiresAt <= Date.now()) SESSIONS.delete(t);
    return token;
}

// 401 = "you are not signed in / your session expired", 403 = "signed in, wrong role".
// The client distinguishes them so it can tell the user which one actually happened.
function requireAdmin(req, res, next) {
    const token = req.get('x-session-token') || '';
    const session = SESSIONS.get(token);
    if (!session || session.expiresAt <= Date.now()) {
        SESSIONS.delete(token);
        return res.status(401).json({ error: 'Sign in as an admin to perform this action.' });
    }
    if (!ADMIN_ROLES.has(session.role)) {
        return res.status(403).json({ error: `${session.username} is not an admin account.` });
    }
    req.sessionUser = session;
    next();
}

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

// --- Normalize IS Standard Numbers (e.g. "IS 4985 (2021)" -> "IS 4985") ---
function normalizeISNumber(isStr) {
    if (!isStr) return '';
    let match = isStr.toString().match(/IS\s*\d+/i);
    return match ? match[0].toUpperCase().replace(/\s+/g, ' ') : isStr.trim();
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

function inferCompetencyLevel(sampleCount) {
    if (sampleCount >= 8) return 'Expert';
    if (sampleCount >= 3) return 'Standard';
    return 'Trainee';
}

function normalizePersonKey(value) {
    return cleanName(value).toLowerCase();
}

async function loadSampleHistoryAccountCandidates() {
    const [{ data: samples }, { data: users }, { data: profiles }, { data: competencies }] = await Promise.all([
        supabase.from('samples').select('assignedTo, isNumber, appStatus'),
        supabase.from('users').select('id, username, role'),
        supabase.from('employee_profiles').select('id, userId, fullName, designation, maxDailySamples'),
        supabase.from('employee_competencies').select('id, employeeId, isNumber, proficiencyLevel, avgTestDurationHours'),
    ]);

    const userMap = new Map((users || []).map(u => [normalizePersonKey(u.username), u]));
    const profileMap = new Map((profiles || []).map(p => [normalizePersonKey(p.fullName), p]));
    const competencyMap = new Map();
    (competencies || []).forEach(c => {
        const key = `${c.employeeId}::${normalizeISNumber(c.isNumber)}`;
        competencyMap.set(key, c);
    });

    const candidates = new Map();
    (samples || []).forEach(sample => {
        const rawName = cleanName(sample.assignedTo);
        if (!rawName || rawName.toUpperCase() === 'UNASSIGNED') return;
        const personKey = normalizePersonKey(rawName);
        if (!candidates.has(personKey)) {
            candidates.set(personKey, {
                fullName: rawName,
                sampleCount: 0,
                isCounts: {},
            });
        }
        const row = candidates.get(personKey);
        row.sampleCount += 1;
        const isKey = normalizeISNumber(sample.isNumber) || 'UNKNOWN';
        row.isCounts[isKey] = (row.isCounts[isKey] || 0) + 1;
    });

    const enriched = [...candidates.values()]
        .sort((a, b) => b.sampleCount - a.sampleCount || a.fullName.localeCompare(b.fullName))
        .map(candidate => {
            const user = userMap.get(normalizePersonKey(candidate.fullName)) || null;
            const profile = profileMap.get(normalizePersonKey(candidate.fullName)) || null;
            const competencyPreview = Object.entries(candidate.isCounts)
                .filter(([isNumber]) => isNumber && isNumber !== 'UNKNOWN')
                .sort((a, b) => b[1] - a[1])
                .map(([isNumber, count]) => ({
                    isNumber,
                    sampleCount: count,
                    inferredLevel: inferCompetencyLevel(count),
                    alreadyExists: !!(profile && competencyMap.has(`${profile.id}::${normalizeISNumber(isNumber)}`)),
                }));

            return {
                ...candidate,
                hasUser: !!user,
                hasProfile: !!profile,
                userId: user?.id || null,
                profileId: profile?.id || null,
                existingDesignation: profile?.designation || '',
                existingCapacity: profile?.maxDailySamples || null,
                competencies: competencyPreview,
            };
        });

    return enriched;
}

async function applySampleHistoryImport({ defaultPassword = '1234', defaultDesignation = 'Testing Person', defaultCapacity = 40 } = {}) {
    const candidates = await loadSampleHistoryAccountCandidates();
    const summary = {
        scannedPeople: candidates.length,
        createdUsers: 0,
        createdProfiles: 0,
        linkedProfiles: 0,
        addedCompetencies: 0,
        skippedExistingCompetencies: 0,
        candidates: [],
    };

    for (const candidate of candidates) {
        let userId = candidate.userId;
        let profileId = candidate.profileId;

        if (!userId) {
            const { data: newUser, error: userErr } = await supabase
                .from('users')
                .insert([{ username: candidate.fullName, password: defaultPassword, role: 'tp' }])
                .select('id')
                .single();
            if (userErr) throw userErr;
            userId = newUser.id;
            summary.createdUsers += 1;
        }

        if (!profileId) {
            const { data: newProfile, error: profileErr } = await supabase
                .from('employee_profiles')
                .insert([{
                    userId,
                    fullName: candidate.fullName,
                    designation: defaultDesignation,
                    maxDailySamples: defaultCapacity,
                }])
                .select('id')
                .single();
            if (profileErr) throw profileErr;
            profileId = newProfile.id;
            summary.createdProfiles += 1;
        } else if (!candidate.userId) {
            const { error: linkErr } = await supabase
                .from('employee_profiles')
                .update({ userId })
                .eq('id', profileId);
            if (linkErr) throw linkErr;
            summary.linkedProfiles += 1;
        }

        for (const competency of candidate.competencies) {
            if (!competency.isNumber || competency.alreadyExists) {
                if (competency.alreadyExists) summary.skippedExistingCompetencies += 1;
                continue;
            }

            const { error: compErr } = await supabase
                .from('employee_competencies')
                .insert([{
                    employeeId: profileId,
                    isNumber: competency.isNumber,
                    avgTestDurationHours: 8,
                    proficiencyLevel: competency.inferredLevel,
                }]);
            if (compErr) throw compErr;
            summary.addedCompetencies += 1;
        }

        summary.candidates.push({
            fullName: candidate.fullName,
            sampleCount: candidate.sampleCount,
            isCount: candidate.competencies.length,
            createdUser: !candidate.userId,
            createdProfile: !candidate.profileId,
        });
    }

    return summary;
}

function readWorkbookRows(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Master list file not found at ${filePath}`);
    }

    const workbook = xlsx.readFile(filePath, { cellDates: true });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    return xlsx.utils.sheet_to_json(sheet, { defval: '', raw: false });
}

async function loadMasterListAccountCandidates() {
    const rows = readWorkbookRows(MASTER_LIST_FILE);
    const candidates = new Map();

    for (const row of rows) {
        const rawName = cleanName(row['Assigned To'] || row['Assigned to'] || row['assignedTo'] || row['assigned to']);
        if (!rawName || rawName.toUpperCase() === 'UNASSIGNED') continue;

        const personKey = normalizePersonKey(rawName);
        if (!candidates.has(personKey)) {
            candidates.set(personKey, {
                fullName: rawName,
                sampleCount: 0,
                isCounts: {},
            });
        }

        const candidate = candidates.get(personKey);
        candidate.sampleCount += 1;

        const isNumber = normalizeISNumber(row['IS Number'] || row['IS number'] || row['isNumber'] || row['is number']);
        if (!isNumber) continue;
        candidate.isCounts[isNumber] = (candidate.isCounts[isNumber] || 0) + 1;
    }

    const users = await supabase.from('users').select('id, username, role');
    const profiles = await supabase.from('employee_profiles').select('id, userId, fullName, designation, maxDailySamples');
    const competencies = await supabase.from('employee_competencies').select('id, employeeId, isNumber, proficiencyLevel, avgTestDurationHours');

    const userMap = new Map((users.data || []).map(u => [normalizePersonKey(u.username), u]));
    const profileMap = new Map((profiles.data || []).map(p => [normalizePersonKey(p.fullName), p]));
    const competencyMap = new Map();
    (competencies.data || []).forEach(c => {
        competencyMap.set(`${c.employeeId}::${normalizeISNumber(c.isNumber)}`, c);
    });

    return [...candidates.values()]
        .sort((a, b) => b.sampleCount - a.sampleCount || a.fullName.localeCompare(b.fullName))
        .map(candidate => {
            const user = userMap.get(normalizePersonKey(candidate.fullName)) || null;
            const profile = profileMap.get(normalizePersonKey(candidate.fullName)) || null;
            const competencyPreview = Object.entries(candidate.isCounts)
                .sort((a, b) => b[1] - a[1])
                .map(([isNumber, count]) => ({
                    isNumber,
                    sampleCount: count,
                    inferredLevel: inferCompetencyLevel(count),
                    alreadyExists: !!(profile && competencyMap.has(`${profile.id}::${normalizeISNumber(isNumber)}`)),
                }));

            return {
                ...candidate,
                hasUser: !!user,
                hasProfile: !!profile,
                userId: user?.id || null,
                profileId: profile?.id || null,
                existingDesignation: profile?.designation || '',
                existingCapacity: profile?.maxDailySamples || null,
                competencies: competencyPreview,
            };
        });
}

async function applyMasterListImport({ defaultPassword = '1234', defaultDesignation = 'Testing Person', defaultCapacity = 40 } = {}) {
    const candidates = await loadMasterListAccountCandidates();
    const summary = {
        scannedPeople: candidates.length,
        createdUsers: 0,
        createdProfiles: 0,
        linkedProfiles: 0,
        addedCompetencies: 0,
        skippedExistingCompetencies: 0,
        candidates: [],
    };

    for (const candidate of candidates) {
        let userId = candidate.userId;
        let profileId = candidate.profileId;

        if (!userId) {
            const { data: newUser, error: userErr } = await supabase
                .from('users')
                .insert([{ username: candidate.fullName, password: defaultPassword, role: 'tp' }])
                .select('id')
                .single();
            if (userErr) throw userErr;
            userId = newUser.id;
            summary.createdUsers += 1;
        }

        if (!profileId) {
            const { data: newProfile, error: profileErr } = await supabase
                .from('employee_profiles')
                .insert([{
                    userId,
                    fullName: candidate.fullName,
                    designation: defaultDesignation,
                    maxDailySamples: defaultCapacity,
                }])
                .select('id')
                .single();
            if (profileErr) throw profileErr;
            profileId = newProfile.id;
            summary.createdProfiles += 1;
        } else if (!candidate.userId) {
            const { error: linkErr } = await supabase
                .from('employee_profiles')
                .update({ userId })
                .eq('id', profileId);
            if (linkErr) throw linkErr;
            summary.linkedProfiles += 1;
        }

        for (const competency of candidate.competencies) {
            if (!competency.isNumber || competency.alreadyExists) {
                if (competency.alreadyExists) summary.skippedExistingCompetencies += 1;
                continue;
            }

            const { error: compErr } = await supabase
                .from('employee_competencies')
                .insert([{
                    employeeId: profileId,
                    isNumber: competency.isNumber,
                    avgTestDurationHours: 8,
                    proficiencyLevel: competency.inferredLevel,
                }]);
            if (compErr) throw compErr;
            summary.addedCompetencies += 1;
        }

        summary.candidates.push({
            fullName: candidate.fullName,
            sampleCount: candidate.sampleCount,
            isCount: candidate.competencies.length,
            createdUser: !candidate.userId,
            createdProfile: !candidate.profileId,
        });
    }

    return summary;
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
    // Do NOT Title-Case usernames (cleanName turns "SSD" into "Ssd").
    // Login is case-insensitive against the stored username.
    const username = String(req.body.username || '').trim();
    const password = req.body.password;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

    const { data: row, error } = await supabase
        .from('users')
        .select('*')
        .ilike('username', username)
        .eq('password', password)
        .maybeSingle();

    if (error || !row) return res.status(401).json({ error: 'Invalid credentials.' });
    const token = issueSession(row);
    res.json({ message: 'Login successful', token, user: { id: row.id, username: row.username, role: row.role } });
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
    sNo: { synonyms: ['s.no.', 's.no', 'sno', 'sr no', 'sr.no', 'sr. no', 'sr no.', 'serial no', 'serial number', 'sl no', 'sl.no', 'sl. no'] },
    encodedCode: { synonyms: ['encoded code', 'encoded sample', 'encodedcode', 'encode', 'sample code', 'samplecode', 'sample no', 'sample number'], contentTest: (vals) => vals.some(v => /^[0-9]{2}[A-Z]{1,2}[0-9]+[A-Z]?$/i.test(v)) },
    isNumber: { synonyms: ['is number', 'isnumber', 'is_number', 'is no', 'indian standard', 'standard'], contentTest: (vals) => vals.some(v => /^(IS\s*)?\d{3,5}/.test(v)) },
    quantity: { synonyms: ['quantity', 'qty'] },
    priorityLevel: { synonyms: ['priority', 'priority level'] },
    receivedOn: { synonyms: ['received on', 'receivedon', 'sample received on', 'received_on', 'received date', 'date received', 'recv dt'], contentTest: (vals) => vals.some(v => !isNaN(v) || /\d{2}[-\/]\d{2}[-\/]\d{2,4}/.test(v)) },
    forwardedOn: { synonyms: ['forwarded on', 'forwardedon', 'sample forwarded on', 'forwarded_on', 'forwarded date'], contentTest: (vals) => vals.some(v => !isNaN(v) || /\d{2}[-\/]\d{2}[-\/]\d{2,4}/.test(v)) },
    assignedTo: { synonyms: ['assigned to', 'tp name', 'assignedto', 'tpname', 'testing person name', 'testing person', 'tester', 'tester name', 'officer', 'allocated to', 'allocatedto', 'tp', 'tp_name', 'testing_person', 'tp name standard'], contentTest: null },
    reportStatus: { synonyms: ['report status', 'status', 'report_status'] },
    totalTest: { synonyms: ['total test', 'totaltest', 'total tests'] },
    pendingTest: { synonyms: ['pending test', 'pendingtest', 'pending tests'] },
    approvedTest: { synonyms: ['approved test', 'approvedtest', 'approved tests'] },
    pendencyDays: { synonyms: ['pendency in days', 'pendency days', 'pending days', 'days pending'] }
};

// Upload Parsing — fully async, safe for 500-1000+ row files
app.post('/api/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    try {
        // Parse Excel — defval:'' prevents undefined for empty cells
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: false });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];

        // Auto-detect header row: scan first 10 rows for recognized column names
        const allSynonyms = [];
        for (const config of Object.values(SYSTEM_FIELDS)) {
            allSynonyms.push(...config.synonyms.map(s => s.toLowerCase()));
        }

        let headerRowIndex = 0;
        const rawData = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
        for (let i = 0; i < Math.min(rawData.length, 10); i++) {
            const row = rawData[i];
            if (!Array.isArray(row)) continue;
            const cellTexts = row.map(c => String(c || '').toLowerCase().trim()).filter(Boolean);
            const matchCount = cellTexts.filter(ct => allSynonyms.some(s => ct === s || ct.includes(s))).length;
            if (matchCount >= 2) {
                headerRowIndex = i;
                break;
            }
        }

        const rows = xlsx.utils.sheet_to_json(sheet, { defval: '', range: headerRowIndex });

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

            // Reject non-mechanical samples (3rd character must be 'M')
            if (encodedCode.length < 3 || encodedCode.charAt(2).toUpperCase() !== 'M') {
                continue; 
            }

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
    const { samples, duplicates, duplicateCount, fileName, uploadedBy, columnMappingLog, nameMapping } = req.body;
    if (!samples || !Array.isArray(samples)) return res.status(400).json({ error: 'Invalid sample data provided.' });
    if (samples.length === 0) return res.json({ message: 'No new records to commit.' });

    // Apply Name Mappings (Interactive resolution of typos)
    if (nameMapping) {
        samples.forEach(s => {
            if (s.assignedTo && nameMapping[s.assignedTo] && nameMapping[s.assignedTo] !== 'CREATE_NEW') {
                s.assignedTo = nameMapping[s.assignedTo];
            }
        });
        if (duplicates && Array.isArray(duplicates)) {
            duplicates.forEach(s => {
                if (s.assignedTo && nameMapping[s.assignedTo] && nameMapping[s.assignedTo] !== 'CREATE_NEW') {
                    s.assignedTo = nameMapping[s.assignedTo];
                }
            });
        }
    }

    const batchId = 'BATCH-' + Date.now();

    // Check which TPs have user accounts
    const uniqueTPs = [...new Set(samples.map(s => s.assignedTo).filter(Boolean))];
    const tpAccountStatus = {};
    for (const tp of uniqueTPs) {
        const { data: user } = await supabase.from('users').select('id').eq('username', tp).single();
        tpAccountStatus[tp] = !!user;
    }

    // Deduplicate by encodedCode — keep last occurrence to avoid Postgres upsert conflict within same batch
    const seenCodes = new Map();
    samples.forEach(s => {
        if (s.encodedCode) seenCodes.set(s.encodedCode.toLowerCase(), s);
    });
    const dedupedSamples = [...seenCodes.values()];

    const upsertArray = dedupedSamples.map(s => {
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
    // Preserve original casing (e.g. "SSD") — cleanName Title-Cases and breaks all-caps usernames.
    const tpNameRaw = String(req.params.tpName || '').trim();
    const tpNameClean = cleanName(tpNameRaw);
    const { role } = req.query;

    const isAdmin = role === 'admin' || role === 'admin_sample_cell' || role === 'super_admin';

    let query = supabase.from('samples').select('*');

    // TP users can ONLY see samples assigned to them (match raw or cleaned name, case-insensitive)
    if (!isAdmin) {
        const { data, error } = await query;
        if (error) return res.status(500).json({ error: error.message });
        const meKeys = new Set(
            [tpNameRaw, tpNameClean]
                .filter(Boolean)
                .map(v => String(v).trim().toLowerCase())
        );
        const samples = (data || []).filter(s => meKeys.has(String(s.assignedTo || '').trim().toLowerCase()));
        return res.json({ samples });
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

    // Capture pre-update IS/assignee for the ML lifecycle log.
    const { data: sBefore } = await supabase.from('samples').select('isNumber, assignedTo').eq('id', id).single();

    const { error } = await supabase.from('samples').update({ appStatus, passFail, disposalDate }).eq('id', id);
    if (error) return res.status(500).json({ error: error.message });

    // ML: record the completion so the hours model can learn real durations.
    hoursModel.appendEvent({ sampleId: id, isNumber: sBefore && sBefore.isNumber, taName: sBefore && sBefore.assignedTo, event: 'submitted' });

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
    const { error: err3 } = await supabase.from('users').delete().neq('username', 'Admin').neq('username', 'Super Admin');

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
app.post('/api/samples/:id/start-testing', async (req, res) => {
    const { id } = req.params;
    const { data: sample } = await supabase.from('samples').select('appStatus, assignedTo, isNumber').eq('id', id).single();
    if (!sample) return res.status(404).json({ error: 'Sample not found' });
    if (sample.appStatus !== 'Pending') return res.status(400).json({ error: 'Only Pending samples can be started' });
    if (!sample.assignedTo) return res.status(400).json({ error: 'Sample must be assigned before starting testing' });
    const { error } = await supabase.from('samples').update({ appStatus: 'Testing' }).eq('id', id);
    if (error) return res.status(500).json({ error: error.message });

    // ML: mark the start of active testing — the clock for actual man-hours.
    hoursModel.appendEvent({ sampleId: id, isNumber: sample.isNumber, taName: sample.assignedTo, event: 'testing_started' });

    res.json({ message: 'Moved to Under Testing' });
});

app.delete('/api/samples/:id', async (req, res) => {
    const { id } = req.params;
    const { error } = await supabase.from('samples').delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: 'Sample deleted successfully.' });
});

// --- LIIS Automation Routes ---
const { spawn } = require('child_process');
let activeLiisProcess = null;
let liisLogs = [];
let lisStatus = 'idle'; // 'idle', 'running', 'waiting_for_login', 'waiting_for_captcha'

app.post('/api/liis/start', (req, res) => {
    const payload = req.body;
    
    if (!payload || !payload.lis_user || !payload.lis_pass) {
        return res.status(400).json({ error: 'LIIS credentials are required.' });
    }
    
    if (activeLiisProcess) {
        return res.status(400).json({ error: 'An automation process is already running.' });
    }
    
    liisLogs = [];
    lisStatus = 'running';
    liisLogs.push(`[SYSTEM] Initializing Native LIIS automator for sample: ${payload.metadata.sampleCode}...`);
    
    console.log(`Spawning LIIS uploader with payload for: ${payload.metadata.sampleCode}`);
    
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    activeLiisProcess = spawn(pythonCmd, ['lims_uploader_is4985.py', '--payload', '-']);
    activeLiisProcess.stdin.write(JSON.stringify(payload));
    activeLiisProcess.stdin.end();
    
    activeLiisProcess.stdout.on('data', (data) => {
        const text = data.toString();
        // Parse logs to detect status
        if (text.includes('[AUTOMATION_WAITING_FOR_CAPTCHA]')) {
            lisStatus = 'waiting_for_captcha';
        } else if (text.includes('[AUTOMATION_WAITING_FOR_LOGIN]')) {
            lisStatus = 'waiting_for_login';
        } else if (text.includes('[SUCCESS] Login detected')) {
            lisStatus = 'running';
        } else if (text.includes('[[SUBMITTED_SAMPLE]]:')) {
            const matches = text.match(/\[\[SUBMITTED_SAMPLE\]\]:(.+)/);
            if (matches && matches[1]) {
                const sampleCode = matches[1].trim();
                const nowStr = new Date().toISOString().split('T')[0].split('-').reverse().join('-');
                supabase.from('lims_submitted_samples').upsert({ sampleCode, submittedDate: nowStr }, { onConflict: 'sampleCode' }).then();
                // Also update the main sample record status to Submitted
                supabase.from('samples').update({ appStatus: 'Submitted' }).eq('encodedCode', sampleCode).then();
            }
        }
        
        // Add to log lines
        const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.includes('[[SUBMITTED_SAMPLE]]:'));
        liisLogs.push(...lines);
    });
    
    activeLiisProcess.stderr.on('data', (data) => {
        const text = data.toString();
        const lines = text.split('\n').map(l => l.trim()).filter(l => l);
        liisLogs.push(...lines.map(line => `[ERROR] ${line}`));
    });
    
    activeLiisProcess.on('close', (code) => {
        console.log(`LIIS uploader process exited with code ${code}`);
        lisStatus = 'idle';
        activeLiisProcess = null;
        liisLogs.push(`[SYSTEM] Automation completed. Process exited with code ${code}`);
    });
    
    res.json({ message: 'Automation started successfully.' });
});

app.post('/api/liis/preview', (req, res) => {
    const payload = req.body;
    
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
    // We don't track this in activeLiisProcess because it's just a fast preview generator
    const previewProcess = spawn(pythonCmd, ['lims_uploader_is4985.py', '--payload', '-', '--preview']);
    previewProcess.stdin.write(JSON.stringify(payload));
    previewProcess.stdin.end();
    
    previewProcess.on('close', (code) => {
        if (code === 0) {
            const sampleCode = payload.metadata.sampleCode || 'UNKNOWN';
            const pdfFile = path.resolve(__dirname, `Report_${sampleCode}.pdf`);
            if (fs.existsSync(pdfFile)) {
                res.sendFile(pdfFile, (err) => {
                    if (err) console.error("Error sending PDF:", err);
                    // Delete the file after sending to keep file system clean
                    fs.unlink(pdfFile, (err) => {
                        if (err) console.error("Failed to delete PDF:", err);
                    });
                });
            } else {
                res.status(500).json({ error: 'PDF was generated but file not found.' });
            }
        } else {
            res.status(500).json({ error: `Preview failed with code ${code}` });
        }
    });
});

app.get('/api/liis/status', (req, res) => {
    res.json({ status: lisStatus });
});

app.get('/api/liis/logs', (req, res) => {
    res.json({ logs: liisLogs });
});

app.post('/api/liis/stop', (req, res) => {
    if (!activeLiisProcess) {
        return res.status(400).json({ error: 'No active automation process to stop.' });
    }
    
    try {
        activeLiisProcess.kill();
        lisStatus = 'idle';
        activeLiisProcess = null;
        liisLogs.push('[SYSTEM] Automation manually stopped by user.');
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

app.put('/api/admin/employees/:id', async (req, res) => {
    const empId = req.params.id;
    const { fullName, designation, maxDailySamples } = req.body;
    if (!fullName) return res.status(400).json({ error: 'Full Name is required.' });

    try {
        // Fetch the employee to get the associated userId + old name
        const { data: emp, error: fetchErr } = await supabase
            .from('employee_profiles')
            .select('userId, fullName')
            .eq('id', empId)
            .single();
        if (fetchErr) throw fetchErr;

        const oldName = emp && emp.fullName ? String(emp.fullName).trim() : '';
        let oldUsername = oldName;
        if (emp && emp.userId) {
            const { data: u } = await supabase.from('users').select('username').eq('id', emp.userId).maybeSingle();
            if (u && u.username) oldUsername = String(u.username).trim();
        }

        const { error } = await supabase
            .from('employee_profiles')
            .update({ fullName, designation: designation || '', maxDailySamples: parseInt(maxDailySamples) || 40 })
            .eq('id', empId);

        if (error) throw error;

        // Also update the username in the users table to keep them synced for login
        if (emp && emp.userId) {
            await supabase.from('users').update({ username: fullName }).eq('id', emp.userId);
        }

        // Keep sample assignments in sync when the display/login name changes
        const namesToRewrite = [...new Set([oldName, oldUsername].filter(Boolean))];
        for (const prev of namesToRewrite) {
            if (prev.toLowerCase() === String(fullName).trim().toLowerCase()) continue;
            await supabase.from('samples').update({ assignedTo: fullName }).eq('assignedTo', prev);
        }

        res.json({ message: 'Employee profile updated successfully.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/admin/employees/:id', async (req, res) => {
    try {
        // Cascade delete competencies, leaves, and assignment recommendations
        await supabase.from('employee_competencies').delete().eq('employeeId', req.params.id);
        await supabase.from('employee_leaves').delete().eq('employeeId', req.params.id);
        await supabase.from('assignment_recommendations').delete().eq('recommendedEmployeeId', req.params.id);
        
        // Delete the profile
        const { error } = await supabase.from('employee_profiles').delete().eq('id', req.params.id);
        if (error) throw error;
        res.json({ message: 'Employee deleted successfully.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/master-list-import-preview', async (req, res) => {
    try {
        const candidates = await loadMasterListAccountCandidates();
        res.json({
            candidates,
            totals: {
                people: candidates.length,
                missingUsers: candidates.filter(c => !c.hasUser).length,
                missingProfiles: candidates.filter(c => !c.hasProfile).length,
                totalSampleCount: candidates.reduce((sum, c) => sum + c.sampleCount, 0),
            },
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/master-list-import', async (req, res) => {
    try {
        const result = await applyMasterListImport({
            defaultPassword: req.body?.defaultPassword || '1234',
            defaultDesignation: req.body?.defaultDesignation || 'Testing Person',
            defaultCapacity: parseInt(req.body?.defaultCapacity) || 40,
        });
        res.json({
            message: `Imported ${result.createdUsers} users, ${result.createdProfiles} profiles, and ${result.addedCompetencies} competencies from sample history.`,
            ...result,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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

app.delete('/api/admin/competencies/:id', async (req, res) => {
    const { error } = await supabase.from('employee_competencies').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ message: 'Competency removed.' });
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
            let templates = {};
            const { data: prefs } = await supabase.from('system_preferences').select('*').like('key', 'template_%');
            (prefs || []).forEach(p => {
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

    app.post('/api/admin/templates/seed', async (req, res) => {
        try {
            const dbPath = path.join(__dirname, 'public/standards_db.js');
            if (!fs.existsSync(dbPath)) {
                return res.status(404).json({ error: 'public/standards_db.js not found' });
            }
            const fileContent = fs.readFileSync(dbPath, 'utf8');
            const vm = require('vm');
            const sandbox = {};
            vm.createContext(sandbox);
            const code = fileContent.replace('const EXTRACTED_STANDARDS_DB', 'var EXTRACTED_STANDARDS_DB');
            vm.runInNewContext(code, sandbox);
            
            const standardsDb = sandbox.EXTRACTED_STANDARDS_DB;
            if (!standardsDb) {
                return res.status(500).json({ error: 'EXTRACTED_STANDARDS_DB not found in file' });
            }
            
            const keys = Object.keys(standardsDb);
            const upsertData = [];
            
            for (const isNumber of keys) {
                const clauses = standardsDb[isNumber];
                let totalHours = 0;
                const activeClauses = {};
                
                clauses.forEach(c => {
                    const hrs = parseFloat(c.hours) || 0;
                    totalHours += hrs;
                    activeClauses[c.clause] = {
                        active: true,
                        activeHours: hrs,
                        passiveHours: 0,
                        equipment: ''
                    };
                });
                
                const templateData = {
                    tatDays: 7,
                    activeClauses,
                    totalHours
                };
                
                upsertData.push({
                    key: `template_${isNumber}`,
                    value: JSON.stringify(templateData)
                });
            }
            
            const { error } = await supabase.from('system_preferences').upsert(upsertData, { onConflict: 'key' });
            if (error) throw error;
            
            res.json({ message: `Successfully seeded ${keys.length} default templates into database.` });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ============================================================
    // PDF → Master Template importer (deterministic parser)
    // Extracts IS templates from BIS testing-charges PDFs.
    // Two-step: /preview returns parsed JSON for OIC review;
    // /commit upserts approved templates into system_preferences.
    // ============================================================
    function parseBISTestingChargesPDF(rawText) {
        const text = (rawText || '').replace(/\r/g, '');
        // Split into IS sections. Each section starts with a heading like:
        //   "Testing charges for IS 2791:1992" or "TESTING CHARGES FOR IS 2797:1994"
        //   "The BIS testing charges for IS 2802:1964 effective from ..."
        // Heading anchors. We accept three forms of section start:
        //   1. "Testing charges for IS 2791:1992"  (and uppercase variants)
        //   2. "OUR REF ... IS 2830:1975" (heading appears after OUR REF line)
        //   3. Any line that is *only* "IS NNNN:YYYY ..." — a bare title line
        // For each match we capture the IS number; later we dedupe by IS#.
        const headingPatterns = [
            /testing\s+charges\s+for\s+IS\s*[:\s]*(\d{3,5})\s*[:\-]?\s*(\d{4})?/gi,
            /OUR\s+REF[\s\S]{0,200}?IS\s*[:\s]*(\d{3,5})\s*[:\-]?\s*(\d{4})?/gi
        ];
        const matches = [];
        for (const re of headingPatterns) {
            let m;
            while ((m = re.exec(text)) !== null) {
                matches.push({ isNumber: m[1], year: m[2] || '', index: m.index });
            }
        }
        if (matches.length === 0) return [];

        // Dedupe by IS number FIRST (keep first occurrence as canonical section start),
        // THEN slice sections from one canonical start to the next. This avoids
        // tiny slivers between repeated mentions of the same IS code.
        const firstOf = new Map();
        for (const mm of matches) {
            if (!firstOf.has(mm.isNumber)) firstOf.set(mm.isNumber, mm);
        }
        const anchors = [...firstOf.values()].sort((a, b) => a.index - b.index);
        const unique = [];
        for (let i = 0; i < anchors.length; i++) {
            const start = anchors[i].index;
            const end = i + 1 < anchors.length ? anchors[i + 1].index : text.length;
            unique.push({
                isNumber: anchors[i].isNumber,
                year: anchors[i].year,
                body: text.slice(start, end)
            });
        }

        const templates = [];
        for (const sec of unique) {
            const parsed = parseISTemplateSection(sec);
            if (parsed) templates.push(parsed);
        }
        return templates;
    }

    function parseISTemplateSection({ isNumber, year, body }) {
        const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
        if (!lines.length) return null;

        // Product name: usually appears as "(Soluble Coffee Powder)" or after "for IS X:Y"
        let productName = '';
        const prodMatch = body.match(/IS\s*\d{3,5}\s*[:\-]?\s*\d{0,4}\s*(?:Amd[\-\s]?\d+)?\s*\(([^)]+)\)/i);
        if (prodMatch) productName = prodMatch[1].trim();
        else {
            const altMatch = body.match(/for\s+([A-Z][A-Za-z0-9 ,\-]+?)\s+as\s+per\s+IS/i);
            if (altMatch) productName = altMatch[1].trim();
        }

        // Lab origin (for audit trail)
        let lab = '';
        const labMatch = body.match(/BIS\s+(NROL|WROL|EROL|SROL|CROL|Central\s+Laboratory)[\s,]+([A-Za-z]+)?/i);
        if (labMatch) lab = `BIS ${labMatch[1]}${labMatch[2] ? ' ' + labMatch[2] : ''}`;

        // Parse table rows. Two patterns (try strict first, then loose):
        //   STRICT:  "<num>. <test name> <Cl X.Y[ Table N]> <hours>"
        //   LOOSE :  "<num>. <test name> <hours>"   (no clause ref, e.g. central-lab format)
        // Hours can be a number, a unicode fraction (½ ¼ ¾), or an inactive marker (**, --, N/A).
        const FRAC = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 0.33, '⅔': 0.67, '⅛': 0.125 };
        const HOURS_TOKEN = '(?:[\\d.]+(?:\\s*[½¼¾⅓⅔⅛])?|[½¼¾⅓⅔⅛]|\\*+|--|—|N\\/?A)';
        const clauseRowRe = new RegExp(
            `^\\s*\\d+\\.?\\s+(.+?)\\s+(Cl\\.?\\s*\\d[\\d.]*(?:\\s*Table\\s*\\d+)?|Table\\s*\\d+\\s*,\\s*[ivxlcdm]+\\)|\\d[\\d.]*(?:\\s*&\\s*\\d[\\d.]*)?)\\s+(${HOURS_TOKEN})\\b`,
            'i'
        );
        const looseRowRe = new RegExp(`^\\s*\\d+\\.?\\s+(.+?)\\s+(${HOURS_TOKEN})\\s*$`, 'i');

        const parseHours = (raw) => {
            if (!raw) return 0;
            raw = String(raw).trim();
            if (/^\*+$|^--$|^—$|^N\/?A$/i.test(raw)) return null; // inactive
            // Mixed "1 ½" → 1.5
            const mixed = raw.match(/^([\d.]+)\s*([½¼¾⅓⅔⅛])$/);
            if (mixed) return parseFloat(mixed[1]) + (FRAC[mixed[2]] || 0);
            if (FRAC[raw]) return FRAC[raw];
            const n = parseFloat(raw);
            return Number.isFinite(n) ? n : 0;
        };

        const clauses = {};
        let totalFromRows = 0;
        let totalDeclared = 0;
        const lastTotalMatch = body.match(/Total\s*(?:Man[\-\s]*Hours|Time)?\s*[:\-]?\s*(\d+(?:\.\d+)?(?:\s*[½¼¾⅓⅔⅛])?)/i);
        if (lastTotalMatch) totalDeclared = parseHours(lastTotalMatch[1]) || 0;

        let rowIdx = 0;
        for (const line of lines) {
            if (/^(sr|s\.?\s*no|sl\.?\s*no|requirements?|tests?|clause|man[\-\s]*hours?|electricity|consumable|grade\s*\d|total\b)/i.test(line)) continue;

            let testName = '', clauseRef = '', hoursRaw = '';
            let mm = line.match(clauseRowRe);
            if (mm) { testName = mm[1]; clauseRef = mm[2]; hoursRaw = mm[3]; }
            else {
                mm = line.match(looseRowRe);
                if (!mm) continue;
                testName = mm[1];
                clauseRef = `Row ${++rowIdx}`;
                hoursRaw = mm[2];
            }
            testName = testName.replace(/\s+/g, ' ').trim();
            clauseRef = clauseRef.replace(/\s+/g, ' ').trim();

            const hours = parseHours(hoursRaw);
            const isInactive = hours === null;
            const safeHours = isInactive ? 0 : hours;
            if (!isInactive && safeHours <= 0) continue;

            // Avoid duplicate clause keys
            let key = clauseRef;
            let dupCount = 2;
            while (clauses[key]) { key = `${clauseRef} (${dupCount++})`; }
            clauses[key] = {
                active: !isInactive,
                activeHours: safeHours,
                passiveHours: 0,
                equipment: '',
                name: testName
            };
            if (!isInactive) totalFromRows += safeHours;
        }

        // If we couldn't parse any rows, bail
        if (Object.keys(clauses).length === 0) return null;

        // Always include report preparation (most PDFs list it; if missing, add 0.5h default)
        if (!Object.keys(clauses).some(k => /report/i.test(clauses[k].name || ''))) {
            clauses['Report Prep'] = {
                active: true,
                activeHours: 0.5,
                passiveHours: 0,
                equipment: '',
                name: 'Preparation of Test Report'
            };
            totalFromRows += 0.5;
        }

        // Prefer declared TOTAL if present and within 20% of summed rows (cross-check),
        // else use summed rows.
        let totalHours = totalFromRows;
        let confidence = 'high';
        if (totalDeclared > 0) {
            const delta = Math.abs(totalDeclared - totalFromRows) / Math.max(totalDeclared, 1);
            if (delta <= 0.2) {
                totalHours = totalDeclared;
            } else {
                confidence = 'review'; // row sum disagrees with declared total
            }
        } else {
            confidence = 'medium'; // no declared total found
        }

        return {
            isNumber: `IS ${isNumber}`,
            year,
            productName,
            sourceLab: lab,
            totalHours,
            tatDays: 7, // default shelf-life — OIC can override
            activeClauses: clauses,
            confidence,
            clauseCount: Object.keys(clauses).length
        };
    }

    app.post('/api/admin/templates/import-pdf/preview', upload.single('pdf'), async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded' });
            
            const engine = req.body.engine || 'js';
            let extractedText = '';
            
            if (engine === 'python') {
                const pyResult = await extractPdfWithPython(req.file.buffer);
                extractedText = pyResult.text;
            } else {
                const data = await pdfParseBuffer(req.file.buffer);
                extractedText = data.text || '';
            }
            
            const parsed = parseBISTestingChargesPDF(extractedText);
            if (parsed.length === 0) {
                return res.json({
                    templates: [],
                    summary: { total: 0, clean: 0, review: 0, medium: 0 },
                    warning: 'No IS templates detected. The PDF may be scanned (image-only) or use an unrecognized format.'
                });
            }
            const summary = {
                total: parsed.length,
                clean: parsed.filter(t => t.confidence === 'high').length,
                medium: parsed.filter(t => t.confidence === 'medium').length,
                review: parsed.filter(t => t.confidence === 'review').length
            };
            res.json({ templates: parsed, summary });
        } catch (err) {
            console.error('[PDF import preview] error:', err);
            res.status(500).json({ error: err.message || 'PDF parse failed' });
        }
    });

    app.post('/api/admin/templates/import-pdf/commit', async (req, res) => {
        try {
            const { templates, overwrite } = req.body;
            if (!Array.isArray(templates) || templates.length === 0) {
                return res.status(400).json({ error: 'No templates provided' });
            }

            // Optionally fetch existing keys to skip if not overwriting
            let existingKeys = new Set();
            if (!overwrite) {
                const { data: existing } = await supabase
                    .from('system_preferences')
                    .select('key')
                    .like('key', 'template_%');
                existingKeys = new Set((existing || []).map(r => r.key));
            }

            const upsertData = [];
            let skipped = 0;
            for (const t of templates) {
                if (!t || !t.isNumber) continue;
                const key = `template_${t.isNumber}`;
                if (!overwrite && existingKeys.has(key)) { skipped++; continue; }
                const templateData = {
                    tatDays: parseInt(t.tatDays) || 7,
                    totalHours: parseFloat(t.totalHours) || 0,
                    activeClauses: t.activeClauses || {},
                    productName: t.productName || '',
                    sourceLab: t.sourceLab || '',
                    importedAt: new Date().toISOString(),
                    importedFrom: 'PDF'
                };
                upsertData.push({ key, value: JSON.stringify(templateData) });
            }

            if (upsertData.length > 0) {
                const { error } = await supabase
                    .from('system_preferences')
                    .upsert(upsertData, { onConflict: 'key' });
                if (error) throw error;
            }

            res.json({
                message: `Imported ${upsertData.length} template(s)${skipped ? `, skipped ${skipped} existing` : ''}.`,
                imported: upsertData.length,
                skipped
            });
        } catch (err) {
            console.error('[PDF import commit] error:', err);
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/assign-sample-manual', async (req, res) => {
        const { sampleId, username: fullName } = req.body;
        if (!sampleId || !fullName) return res.status(400).json({ error: 'Missing sampleId or username' });
        try {
            let assignedUsername = fullName;
            const { data: emp } = await supabase.from('employee_profiles').select('userId').eq('fullName', fullName).single();
            if (emp && emp.userId) {
                const { data: user } = await supabase.from('users').select('username').eq('id', emp.userId).single();
                if (user && user.username) assignedUsername = user.username;
            }

            const { data: sample } = await supabase.from('samples').select('encodedCode').eq('id', sampleId).single();
            const { error } = await supabase.from('samples').update({ 
                assignedTo: assignedUsername,
                appStatus: 'Pending'
            }).eq('id', sampleId);
            if (error) throw error;
            
            // Sync to Master Sheet
            if (sample) updateAssignmentInMaster(sample.encodedCode, assignedUsername);   // Cleanup any pending recommendations for this sample
            await supabase.from('assignment_recommendations').delete().eq('sampleId', sampleId);
            
            res.json({ message: 'Sample manually assigned successfully.' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/download-allotted', async (req, res) => {
        const { sampleIds } = req.body;
        if (!sampleIds || !Array.isArray(sampleIds) || sampleIds.length === 0) {
            return res.status(400).json({ error: 'Missing or invalid sampleIds' });
        }
        try {
            const { data: samples, error } = await supabase.from('samples').select('*').in('id', sampleIds);
            if (error) throw error;
            
            const worksheetData = [
                ["Job Allotment Report", "", "", "", "", "", "", ""],
                ["Generated On", new Date().toLocaleString(), "", "", "", "", "", ""],
                [],
                ["Sample ID", "IS Number", "Priority Level", "Quantity", "Assigned To", "Received On", "Forwarded On", "Status"]
            ];
            
            (samples || []).forEach(s => {
                worksheetData.push([
                    s.encodedCode,
                    s.isNumber || '',
                    s.priorityLevel || 'Standard',
                    s.quantity || '',
                    s.assignedTo || '',
                    s.receivedOn || '',
                    s.forwardedOn || '',
                    s.appStatus || ''
                ]);
            });
            
            const worksheet = xlsx.utils.aoa_to_sheet(worksheetData);
            worksheet['!cols'] = [
                { wch: 18 },
                { wch: 12 },
                { wch: 15 },
                { wch: 10 },
                { wch: 15 },
                { wch: 15 },
                { wch: 15 },
                { wch: 15 }
            ];
            
            const workbook = xlsx.utils.book_new();
            xlsx.utils.book_append_sheet(workbook, worksheet, "Allotments");
            
            const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
            
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', 'attachment; filename="allotment_slip.xlsx"');
            res.send(buffer);
        } catch(err) {
            console.error(err);
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/samples-by-ids', async (req, res) => {
        const { sampleIds } = req.body;
        if (!sampleIds || !Array.isArray(sampleIds) || sampleIds.length === 0) {
            return res.status(400).json({ error: 'Missing or invalid sampleIds' });
        }
        try {
            const { data: samples, error } = await supabase.from('samples').select('*').in('id', sampleIds);
            if (error) throw error;
            res.json({ samples });
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
                        try { 
                            const val = JSON.parse(p.value);
                            const baseKey = p.key.replace('template_', '');
                            const normKey = normalizeISNumber(baseKey);
                            templates[baseKey] = val; 
                            if (baseKey !== normKey) {
                                templates[normKey] = val;
                            }
                        } catch(e){}
                    }
                });
            } catch(e) { console.error('Pref load error', e); }

            // 2b. Load the local ML hours-model (batch-aware, learns from history).
            // Cold-starts from BIS priors if never trained — always returns sane numbers.
            let mlModel = null;
            try { mlModel = await hoursModel.loadModel(); } catch (e) { console.warn('ML model load failed, using template hours:', e.message); }

            // 3. Load employees, competencies, leaves
            const { data: employees } = await supabase.from('employee_profiles').select('*');
            const { data: competencies } = await supabase.from('employee_competencies').select('*');
            const { data: usersForAssign } = await supabase.from('users').select('id, username');

            // IDENTITY BRIDGE: samples.assignedTo stores the USERNAME, but employee_profiles
            // carries fullName. They often differ. To make the existing-load pass (keyed off
            // assignedTo) and the candidate loop (keyed off emp.fullName) agree, we canonicalize
            // every assignee to normalizePersonKey(fullName). usernameKeyToFullKey maps a
            // username's key -> the employee's fullName key via employee_profiles.userId.
            const userIdToUsername = new Map((usersForAssign || []).map(u => [u.id, u.username]));
            const usernameKeyToFullKey = {};
            (employees || []).forEach(e => {
                const uname = userIdToUsername.get(e.userId);
                if (uname) usernameKeyToFullKey[normalizePersonKey(uname)] = normalizePersonKey(e.fullName);
            });
            // Canonical key for any assignee identity (username or fullName) used in this handler.
            const assigneeKey = (name) => {
                const k = normalizePersonKey(name);
                return usernameKeyToFullKey[k] || k;
            };
            
            // Get leaves for TODAY
            const todayStr = new Date().toISOString().split('T')[0];
            const { data: leavesToday } = await supabase.from('employee_leaves').select('employeeId').eq('leaveDate', todayStr);
            const onLeaveToday = new Set((leavesToday || []).map(l => l.employeeId));

            // Best-effort attendance lookup. If an attendance table exists,
            // use explicit present/absent rows to influence assignment. If no
            // table exists, keep the current leave-only behavior.
            const attendanceStatusByEmployeeId = new Map();
            const attendanceTables = ['employee_attendance', 'attendance_records', 'attendance_logs'];
            const parseDateLike = (value) => {
                if (!value) return null;
                if (typeof value === 'string' && /^\d{2}[-/]\d{2}[-/]\d{4}$/.test(value)) {
                    const [d, m, y] = value.split(/[-/]/);
                    const t = Date.parse(`${y}-${m}-${d}`);
                    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
                }
                const t = Date.parse(value);
                return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
            };
            for (const table of attendanceTables) {
                try {
                    const { data: attendanceRows, error: attendanceErr } = await supabase.from(table).select('*');
                    if (attendanceErr || !attendanceRows || attendanceRows.length === 0) continue;

                    for (const row of attendanceRows) {
                        const employeeId = row.employeeId ?? row.employee_id ?? row.empId ?? row.emp_id ?? row.userId ?? row.user_id;
                        if (!employeeId) continue;

                        const dateValue = row.attendanceDate ?? row.attendance_date ?? row.date ?? row.logDate ?? row.log_date ?? row.workDate ?? row.work_date;
                        const rowDate = parseDateLike(dateValue);
                        if (rowDate && rowDate !== todayStr) continue;

                        const rawStatus = String(
                            row.status ?? row.attendanceStatus ?? row.attendance_status ?? row.presentStatus ?? row.present_status ?? ''
                        ).trim().toLowerCase();

                        if (['present', 'p', 'in', 'checked-in', 'checked in', 'working', 'office'].includes(rawStatus)) {
                            attendanceStatusByEmployeeId.set(employeeId, 'present');
                        } else if (['absent', 'a', 'out', 'not present', 'missing'].includes(rawStatus)) {
                            attendanceStatusByEmployeeId.set(employeeId, 'absent');
                        }
                    }

                    // Stop after the first attendance source that returns rows.
                    if (attendanceStatusByEmployeeId.size > 0) break;
                } catch (_) {
                    // Ignore missing tables / incompatible schemas and fall back.
                }
            }

            // Build competency map
            const compMap = {};
            (competencies || []).forEach(c => {
                const normC = normalizeISNumber(c.isNumber);
                if (!compMap[normC]) compMap[normC] = [];
                compMap[normC].push(c);
                if (c.isNumber !== normC) {
                    if (!compMap[c.isNumber]) compMap[c.isNumber] = [];
                    compMap[c.isNumber].push(c);
                }
            });

            // 4. Calculate Current Load Hours and Equipment Load
            // BATCH-AWARE: a TA already holding several samples of the same IS shares
            // that IS's fixed setup, so their real load is setup + n·marginal — NOT
            // n × full-hours. We group each TA's pending work by IS and price the
            // group through the ML model (falls back to flat hours if no model).
            const { data: allPending } = await supabase.from('samples').select('assignedTo, isNumber').in('appStatus', ['Pending']);
            const loadHoursMap = {};
            const equipmentLoadMap = {};                 // equipmentName -> pendingCount
            // empIsCounts[assignee][normIS] = how many of that IS the TA already holds.
            // Drives both the realistic load above and the marginal cost of new work below.
            const empIsCounts = {};

            (allPending || []).forEach(s => {
                const normIS = normalizeISNumber(s.isNumber);
                const tmpl = templates[s.isNumber] || templates[normIS];
                if (s.assignedTo) {
                    // Canonicalize username -> fullName key so this matches emp.fullName below.
                    const aKey = assigneeKey(s.assignedTo);
                    if (!empIsCounts[aKey]) empIsCounts[aKey] = {};
                    empIsCounts[aKey][normIS] = (empIsCounts[aKey][normIS] || 0) + 1;
                }
                // Equipment backlog is per-sample regardless of who holds it.
                if (tmpl && tmpl.activeClauses) {
                    Object.values(tmpl.activeClauses).forEach(clause => {
                        if (clause.active && clause.equipment) {
                            equipmentLoadMap[clause.equipment] = (equipmentLoadMap[clause.equipment] || 0) + 1;
                        }
                    });
                }
            });
            // Price each TA's grouped pending load through the batch model.
            for (const [assignee, isCounts] of Object.entries(empIsCounts)) {
                let total = 0;
                for (const [normIS, n] of Object.entries(isCounts)) {
                    total += mlModel
                        ? hoursModel.estimateBatchHours(mlModel, normIS, n, templates)
                        : ((templates[normIS] && templates[normIS].totalHours) || 20) * n;
                }
                loadHoursMap[assignee] = total;
            }

            let recommendationsGenerated = 0;
            let forcedCount = 0;

            await supabase.from('assignment_recommendations').delete().eq('status', 'pending');

            const today = new Date();
            const recommendationsToInsert = [];

            // --- Ordering: priority buckets, then HYBRID overdue-first / strict FIFO ---
            // Priority samples are processed first (req g). Within each bucket, any sample
            // already PAST its TAT deadline jumps the queue, most-overdue first (req e);
            // everything still within TAT is processed strict oldest-received-first (req d).
            // So expiry only pre-empts the queue when a sample is genuinely overdue —
            // otherwise the discipline is strict FIFO.
            const parsePendency = (s) => {
                if (s.pendencyDays && !isNaN(parseInt(s.pendencyDays))) return parseInt(s.pendencyDays);
                if (s.receivedOn) {
                    const parts = s.receivedOn.split('-');
                    if (parts.length === 3) {
                        const recDate = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
                        return Math.floor((today - recDate) / (1000 * 60 * 60 * 24));
                    }
                }
                return 0;
            };

            // TAT (shelf-life) for a sample's IS — drives the "days before expiry" signal.
            // Samples carry no explicit expiry column, so the deadline is receivedOn + TAT,
            // i.e. daysToExpiry = tatDays - pendencyDays (negative = already past TAT).
            const getTatDays = (s) => {
                const tmpl = templates[s.isNumber] || templates[normalizeISNumber(s.isNumber)];
                return (tmpl && tmpl.tatDays) || 7;
            };
            const daysToExpiry = (s) => getTatDays(s) - parsePendency(s);

            const isPrioritySample = (s) => (s.priorityLevel || '').toLowerCase() === 'priority' || (s.encodedCode || '').toLowerCase().endsWith('p');

            // Overdue samples first (most overdue first); everything else strict FIFO (oldest first).
            const byOverdueThenFifo = (a, b) => {
                const da = daysToExpiry(a), db = daysToExpiry(b);
                const aOver = da < 0, bOver = db < 0;
                if (aOver !== bOver) return aOver ? -1 : 1;       // overdue jumps the queue
                if (aOver && bOver && da !== db) return da - db;  // most overdue first
                return parsePendency(b) - parsePendency(a);       // else strict FIFO (oldest first)
            };
            const priorityQueue    = unassignedSamples.filter(s =>  isPrioritySample(s)).sort(byOverdueThenFifo);
            const nonPriorityQueue = unassignedSamples.filter(s => !isPrioritySample(s)).sort(byOverdueThenFifo);
            const orderedSamples   = [...priorityQueue, ...nonPriorityQueue];

            for (const sample of orderedSamples) {
                let tatDays = 7;
                let requiredEquipments = [];

                const sampleNorm = normalizeISNumber(sample.isNumber);
                const tmpl = templates[sample.isNumber] || templates[sampleNorm];
                if (tmpl) {
                    tatDays = tmpl.tatDays || 7;
                    if (tmpl.activeClauses) {
                        Object.values(tmpl.activeClauses).forEach(c => {
                            if (c.active && c.equipment) requiredEquipments.push(c.equipment);
                        });
                    }
                }

                // Full standalone cost (setup+marginal) — used for display and as the
                // fallback when no candidate already holds this IS. The actual cost
                // charged to a TA is computed PER-CANDIDATE below, because a TA who
                // already has this IS in their queue only pays the marginal hours.
                const fullRequiredHours = mlModel
                    ? hoursModel.estimateSampleHours(mlModel, { isNumber: sampleNorm, batchPosition: 0, templates })
                    : ((tmpl && tmpl.totalHours) || 20);
                const marginalRequiredHours = mlModel
                    ? hoursModel.estimateSampleHours(mlModel, { isNumber: sampleNorm, batchPosition: 1, templates })
                    : ((tmpl && tmpl.totalHours) || 20);

                // Calculate Machine Bottleneck
                let maxEquipLoad = 0;
                let bottleneckMachine = '';
                requiredEquipments.forEach(eq => {
                    const load = equipmentLoadMap[eq] || 0;
                    if (load > maxEquipLoad) {
                        maxEquipLoad = load;
                        bottleneckMachine = eq;
                    }
                });

                // Use pendencyDays directly from file if available, else calculate from receivedOn
                const pendencyDays = parsePendency(sample);
                const isPriority = isPrioritySample(sample);

                // Urgency = the worse of two signals, so neither expiry nor raw age is ignored:
                //   (e) days-before-expiry: how close the sample is to (or past) its TAT deadline
                //   (d) FIFO age: a long-waiting sample is bad regardless of a generous TAT
                const daysLeft = tatDays - pendencyDays; // <0 = already past the TAT deadline
                let deadlineBoost = 0, deadlineTag = '';
                if (daysLeft < 0) {
                    deadlineBoost = 300 + Math.min(300, (-daysLeft) * 20);
                    deadlineTag = `🔴 PAST TAT by ${-daysLeft}d (TAT ${tatDays}d)`;
                } else if (daysLeft <= 2) {
                    deadlineBoost = 200;
                    deadlineTag = `⚠️ EXPIRES in ${daysLeft}d (TAT ${tatDays}d)`;
                } else if (daysLeft <= 5) {
                    deadlineBoost = 80;
                    deadlineTag = `🔥 DUE SOON — ${daysLeft}d to TAT`;
                }

                let ageBoost = 0, ageTag = '';
                if (pendencyDays > 60) {
                    ageBoost = 500;
                    ageTag = '🔴 PENDING 60+ DAYS';
                } else if (pendencyDays > 30) {
                    ageBoost = 200;
                    ageTag = '⚠️ PENDING 30+ DAYS';
                } else if (pendencyDays > 14) {
                    ageBoost = 80;
                    ageTag = '🔥 PENDING 14+ DAYS';
                } else {
                    ageBoost = Math.max(0, pendencyDays * 2);
                }

                const urgencyBoost = Math.max(deadlineBoost, ageBoost);
                const urgencyTag = deadlineBoost >= ageBoost ? deadlineTag : ageTag;

                const priorityBoost = (priorityRankingMode === 'prioritize' && isPriority) ? 100 : 0;
                // FIFO within bucket is enforced by the EDF queue order above; score reflects age for tie-breaking
                const fifoBoost = Math.min(pendencyDays, 30);

                const matchingComps = compMap[sample.isNumber] || compMap[sampleNorm] || [];
                let bestEmployee = null;
                let bestScore = -Infinity;
                let bestReason = '';
                let bestRequiredHours = fullRequiredHours;

                // Evaluate competent employees
                for (const comp of matchingComps) {
                    const emp = (employees || []).find(e => e.id === comp.employeeId);
                    if (!emp) continue;

                    let isOnLeave = onLeaveToday.has(emp.id);
                    const attendanceStatus = attendanceStatusByEmployeeId.get(emp.id) || null;
                    const isExplicitAbsent = attendanceStatus === 'absent';
                    const attendanceBonus = attendanceStatus === 'present' ? 25 : 0;
                    if (isExplicitAbsent) continue;
                    const maxQueueHours = emp.maxDailySamples || 40;
                    const empKey = normalizePersonKey(emp.fullName);
                    const currentLoadHours = loadHoursMap[empKey] || 0;
                    const availableCapacity = maxQueueHours - currentLoadHours;

                    // BATCH-AWARE COST: if this TA already holds samples of the same IS
                    // (existing queue or earlier picks this run), the new sample only
                    // costs the MARGINAL hours — the setup is already paid. Otherwise
                    // it costs the full setup+marginal.
                    const alreadyHasIS = (empIsCounts[empKey] && empIsCounts[empKey][sampleNorm]) || 0;
                    const empRequiredHours = alreadyHasIS > 0 ? marginalRequiredHours : fullRequiredHours;

                    let isOverCapacity = availableCapacity < empRequiredHours;

                    if (comp.proficiencyLevel === 'Trainee' && isPriority) continue;

                    let profMult = 1.0;
                    if (comp.proficiencyLevel === 'Expert') profMult = 1.5;
                    else if (comp.proficiencyLevel === 'Trainee') profMult = 0.6;

                    const capacityScore = availableCapacity * 2;

                    // Consolidation bonus: prefer routing a same-IS sample to a TA who
                    // is already set up for it — that's the real efficiency win when
                    // "loading 5 samples together". Scales with the hours saved.
                    const batchAffinityBonus = alreadyHasIS > 0 ? Math.min(60, (fullRequiredHours - marginalRequiredHours) * 4) : 0;

                    // Penalties
                    const leavePenalty = isOnLeave ? 1000 : 0;
                    const capacityPenalty = isOverCapacity ? 500 : 0;
                    const machinePenalty = maxEquipLoad * 5; // e.g. 10 pending samples = -50 points
                    const attendancePenalty = attendanceStatus === 'present' ? 0 : 0;

                    let score = (10 * profMult) + capacityScore + batchAffinityBonus + priorityBoost + fifoBoost + urgencyBoost + attendanceBonus - leavePenalty - capacityPenalty - machinePenalty - attendancePenalty;

                    if (score > bestScore) {
                        bestScore = score;
                        bestEmployee = emp;
                        bestRequiredHours = empRequiredHours;

                        let tags = [];
                        if (urgencyTag) tags.push(urgencyTag);
                        if (alreadyHasIS > 0) tags.push(`🔗 BATCHED ×${alreadyHasIS + 1} (saves ${(fullRequiredHours - marginalRequiredHours).toFixed(1)}h)`);
                        if (maxEquipLoad > 5) tags.push(`⚠️ [${bottleneckMachine}] BACKLOGGED`);
                        if (isOnLeave) tags.push('⚠️ ON LEAVE');
                        if (attendanceStatus === 'present') tags.push('✅ PRESENT');
                        if (isOverCapacity) tags.push('⚠️ EXCEEDS CAPACITY');
                        let tagStr = tags.length > 0 ? ` [${tags.join(' | ')}]` : '';

                        bestReason = `IS ${sample.isNumber} (${comp.proficiencyLevel})${tagStr}, Avail: ${availableCapacity.toFixed(1)}h`;
                    }
                }

                if (bestEmployee) {
                    const bestKey = normalizePersonKey(bestEmployee.fullName);
                    loadHoursMap[bestKey] = (loadHoursMap[bestKey] || 0) + bestRequiredHours;
                    // Track the new same-IS count so the NEXT same-IS sample this run
                    // is correctly priced as marginal and consolidates onto this TA.
                    if (!empIsCounts[bestKey]) empIsCounts[bestKey] = {};
                    empIsCounts[bestKey][sampleNorm] = (empIsCounts[bestKey][sampleNorm] || 0) + 1;

                    // Also update equipment load to simulate the future backlog
                    requiredEquipments.forEach(eq => {
                        equipmentLoadMap[eq] = (equipmentLoadMap[eq] || 0) + 1;
                    });

                    recommendationsToInsert.push({
                        sampleId: sample.id,
                        recommendedEmployeeId: bestEmployee.id,
                        recommendedEmployeeName: bestEmployee.fullName,
                        reason: bestReason + ` | Needs: ${bestRequiredHours.toFixed(1)}h Active`,
                        score: Math.round(bestScore * 100) / 100,
                        status: 'pending'
                    });
                    recommendationsGenerated++;
                } else {
                    console.log(`Could not assign sample ${sample.encodedCode} - no competent employee found or everyone is on leave/at capacity.`);
                }
            }
            
            if (recommendationsToInsert.length > 0) {
                const { error } = await supabase.from('assignment_recommendations').insert(recommendationsToInsert);
                if (error) console.error('Auto-assign bulk insert error:', error);
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

        // Update sample assignment with username and mark as active Pending
        let assignedUsername = rec.recommendedEmployeeName;
        const { data: empData } = await supabase.from('employee_profiles').select('userId').eq('fullName', rec.recommendedEmployeeName).single();
        if (empData && empData.userId) {
            const { data: user } = await supabase.from('users').select('username').eq('id', empData.userId).single();
            if (user && user.username) assignedUsername = user.username;
        }

        await supabase.from('samples').update({ 
            assignedTo: assignedUsername,
            appStatus: 'Pending'
        }).eq('id', rec.sampleId);
        
        // Update employee workload
        const { data: emp } = await supabase.from('employee_profiles').select('currentWorkload').eq('id', rec.recommendedEmployeeId).single();
        if (emp) {
            await supabase.from('employee_profiles').update({ currentWorkload: (emp.currentWorkload || 0) + 1 }).eq('id', rec.recommendedEmployeeId);
        }
        
        // Mark recommendation as approved
        await supabase.from('assignment_recommendations').update({ status: 'approved', resolvedAt: new Date().toISOString() }).eq('id', recId);

        // ML: record the assignment event (start of the sample's lifecycle clock).
        const { data: sMeta } = await supabase.from('samples').select('isNumber').eq('id', rec.sampleId).single();
        hoursModel.appendEvent({ sampleId: rec.sampleId, isNumber: sMeta && sMeta.isNumber, taName: assignedUsername, event: 'assigned' });

        res.json({ message: 'Assignment approved.', sampleId: rec.sampleId });
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

// --- Local ML hours-model ops (all local, no cloud) -------------------------
// Status: what the model currently believes per IS (setup/marginal hours) and
// per-TA proficiency, plus how much real data it has learned from.
app.get('/api/admin/ml/status', async (req, res) => {
    try {
        const model = await hoursModel.loadModel();
        const templates = await hoursModel.loadTemplates();
        const standards = Object.entries(model.isStates || {}).map(([is, st]) => ({
            isNumber: is,
            setupHours: Math.round(st.theta[0] * 100) / 100,
            marginalHours: Math.round(st.theta[1] * 100) / 100,
            standalone: Math.round((st.theta[0] + st.theta[1]) * 100) / 100,
            perSampleInBatchOf5: Math.round((hoursModel.estimateBatchHours(model, is, 5, templates) / 5) * 100) / 100,
            observations: st.n || 0,
        })).sort((a, b) => a.isNumber.localeCompare(b.isNumber));
        res.json({
            updatedAt: model.updatedAt,
            trainedEvents: model.trainedEvents || 0,
            standardsModeled: standards.length,
            tasProfiled: Object.keys(model.taFactors || {}).length,
            taFactors: model.taFactors || {},
            standards,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Retrain on demand from the persisted lifecycle event log + current templates.
app.post('/api/admin/ml/retrain', async (req, res) => {
    try {
        const summary = await hoursModel.rebuildFromHistory();
        res.json({ message: 'ML hours-model retrained from lifecycle history.', ...summary });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Edit recommendation — swap suggested employee (or set unassigned)
app.patch('/api/admin/recommendations/:id', async (req, res) => {
    const recId = req.params.id;
    const { employeeName, employeeId } = req.body;
    try {
        await supabase.from('assignment_recommendations').update({
            recommendedEmployeeName: employeeName || null,
            recommendedEmployeeId: employeeId || null
        }).eq('id', recId);
        res.json({ message: 'Recommendation updated.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Bulk reject recommendations
app.post('/api/admin/recommendations/bulk-reject', async (req, res) => {
    const { ids } = req.body;
    if (!ids || !ids.length) return res.status(400).json({ error: 'No ids provided.' });
    try {
        await supabase.from('assignment_recommendations')
            .update({ status: 'rejected', resolvedAt: new Date().toISOString() })
            .in('id', ids);
        res.json({ message: `${ids.length} recommendation(s) rejected.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get competent employees for a given IS number (for inline edit dropdown)
app.get('/api/admin/competent-employees', async (req, res) => {
    const { isNumber } = req.query;
    if (!isNumber) return res.status(400).json({ error: 'isNumber required' });
    try {
        const normalize = s => s ? s.trim().replace(/\s+/g, ' ').toUpperCase() : '';
        const { data: competencies } = await supabase
            .from('employee_competencies')
            .select('employeeId, isNumber')
            .ilike('isNumber', `%${isNumber.trim()}%`);
        const empIds = [...new Set((competencies || []).map(c => c.employeeId))];
        if (!empIds.length) return res.json({ employees: [] });
        const { data: profiles } = await supabase
            .from('employee_profiles')
            .select('id, fullName, currentWorkload')
            .in('id', empIds)
            .order('currentWorkload', { ascending: true });
        res.json({ employees: profiles || [] });
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
                const barcodeKey = findKey(['barcode', 'bar code', 'bar-code', 'encode']);
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

app.post('/api/sample-cell/commit', async (req, res) => {
    const { fresh, duplicates, fileName, uploadedBy } = req.body;
    if (!fresh || !duplicates) return res.status(400).json({ error: 'Invalid payload.' });

    const allRecords = [...fresh, ...duplicates];
    if (allRecords.length === 0) return res.status(400).json({ error: 'No records to commit.' });

    const batchId = 'SC-BATCH-' + Date.now();
    try {
        const { error: histErr } = await supabase.from('sample_cell_history').insert([{
            batchId, uploadDate: new Date().toISOString(), fileName, sampleCount: fresh.length, duplicateCount: duplicates.length, uploadedBy
        }]);
        if (histErr) throw histErr;

        const { error: dataErr } = await supabase.from('sample_cell_data').upsert(allRecords, { onConflict: 'barcode' });
        if (dataErr) throw dataErr;

        res.json({ message: `Successfully committed ${allRecords.length} records. Batch: ${batchId}` });
    } catch(err) {
        res.status(500).json({ error: 'Transaction failed: ' + err.message });
    }
});

app.get('/api/sample-cell/history', async (req, res) => {
    try {
        const { data: rows, error } = await supabase.from('sample_cell_history').select('*').order('id', { ascending: false });
        if (error) throw error;
        res.json({ history: rows || [] });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/sample-cell/data', async (req, res) => {
    try {
        const { data: rows, error } = await supabase.from('sample_cell_data').select('*').order('id', { ascending: false });
        if (error) throw error;

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
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/sample-cell/data', async (req, res) => {
    try {
        const { error } = await supabase.from('sample_cell_data').delete().neq('id', 0);
        if (error) throw error;
        res.json({ message: 'All confidential data successfully wiped from the local vault.' });
    } catch(err) {
        res.status(500).json({ error: 'Failed to delete confidential data: ' + err.message });
    }
});

// --- EMPLOYEE CAPACITY ---
app.get('/api/admin/employees/:id/capacity', async (req, res) => {
    try {
        const empId = req.params.id;
        const { data: emp } = await supabase.from('employee_profiles').select('*').eq('id', empId).single();
        if (!emp) return res.status(404).json({ error: 'Employee not found' });
        
        // Count live pending samples (assignedTo stores username, which may differ from fullName)
        let assigneeKeys = [emp.fullName].filter(Boolean);
        if (emp.userId) {
            const { data: u } = await supabase.from('users').select('username').eq('id', emp.userId).maybeSingle();
            if (u && u.username) assigneeKeys.push(u.username);
        }
        assigneeKeys = [...new Set(assigneeKeys.map(k => String(k).trim()).filter(Boolean))];
        let currentLoad = 0;
        if (assigneeKeys.length) {
            const { data: samples } = await supabase
                .from('samples')
                .select('id, assignedTo')
                .in('appStatus', ['Pending', 'PendingAccount']);
            const keySet = new Set(assigneeKeys.map(k => k.toLowerCase()));
            currentLoad = (samples || []).filter(s => keySet.has(String(s.assignedTo || '').trim().toLowerCase())).length;
        }
        
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
    if (error) return res.status(500).json({ error: err.message });
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
            let assignedUsername = rec.recommendedEmployeeName;
            const { data: empData } = await supabase.from('employee_profiles').select('userId').eq('fullName', rec.recommendedEmployeeName).single();
            if (empData && empData.userId) {
                const { data: user } = await supabase.from('users').select('username').eq('id', empData.userId).single();
                if (user && user.username) assignedUsername = user.username;
            }

            // Update the sample assignment
            await supabase.from('samples').update({ 
                assignedTo: assignedUsername,
                appStatus: 'Pending'
            }).eq('id', rec.sampleId);

            // Update employee workload
            if (rec.recommendedEmployeeId) {
                const { data: emp } = await supabase.from('employee_profiles').select('currentWorkload').eq('id', rec.recommendedEmployeeId).single();
                if (emp) {
                    await supabase.from('employee_profiles').update({ currentWorkload: (emp.currentWorkload || 0) + 1 }).eq('id', rec.recommendedEmployeeId);
                }
            }

            // Mark recommendation as approved
            await supabase.from('assignment_recommendations').update({ status: 'approved', resolvedAt: new Date().toISOString() }).eq('id', rec.id);

            // ML: record the assignment event (start of the sample's lifecycle clock)
            const { data: sMeta } = await supabase.from('samples').select('isNumber').eq('id', rec.sampleId).single();
            hoursModel.appendEvent({ 
                sampleId: rec.sampleId, 
                isNumber: sMeta && sMeta.isNumber, 
                taName: assignedUsername, 
                event: 'assigned' 
            });

            approved++;
        }
        res.json({ message: `Approved ${approved} assignments.`, sampleIds: recs.map(r => r.sampleId) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- ASSIGNMENT HISTORY & REVOKE ---
app.get('/api/admin/assignment-history', async (req, res) => {
    try {
        const { data: history, error } = await supabase
            .from('samples')
            .select('id, encodedCode, isNumber, assignedTo')
            .not('assignedTo', 'is', null)
            .neq('assignedTo', '')
            .order('id', { ascending: false })
            .limit(50);
        if (error) throw error;
        res.json({ history });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/revoke-assignment', async (req, res) => {
    try {
        const { sampleId } = req.body;
        if (!sampleId) return res.status(400).json({ error: 'Sample ID is required' });

        // Update the sample to unassigned
        await supabase.from('samples').update({ assignedTo: null }).eq('id', sampleId);
        
        // Also remove any approved recommendation so it can be picked up again
        await supabase.from('assignment_recommendations').delete().eq('sampleId', sampleId);

        // Update the master sheet via excel_sync
        const { data: sample } = await supabase.from('samples').select('encodedCode').eq('id', sampleId).single();
        if (sample && sample.encodedCode) {
            const { updateAssignmentInMaster } = require('./excel_sync');
            updateAssignmentInMaster(sample.encodedCode, ''); // Clear the assignment in sheet
        }

        res.json({ message: 'Assignment revoked successfully.' });
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
        
        res.json({ message: '50 Mock samples successfully injected into unalloted samples!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// IS INTELLIGENCE MODULE — Backend Logic & Local RAG API
// ============================================================

const { PDFParse } = require('pdf-parse');
async function pdfParseBuffer(buffer) {
    const p = new PDFParse({ data: buffer });
    return await p.getText();
}

// Promisified SQLite functions

// Extract PDF page by page (pdf-parse v2 API)
async function extractPdfPages(buffer) {
    const p = new PDFParse({ data: buffer });
    const result = await p.getText();
    const pages = (result.pages || []).map((pg, idx) => ({
        page: pg.pageNumber || (idx + 1),
        text: pg.text || ''
    }));
    return pages;
}

// Extract text from PDF (pdfplumber) or image (PaddleOCR) — fully local, no cloud
const crypto = require('crypto');
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.tif', '.webp']);

async function extractFileWithPython(buffer, originalName) {
    return new Promise((resolve, reject) => {
        const ext = path.extname(originalName || '.pdf').toLowerCase();
        const tempPath = path.join(__dirname, 'scratch', `temp_${crypto.randomBytes(8).toString('hex')}${ext}`);
        if (!fs.existsSync(path.join(__dirname, 'scratch'))) {
            fs.mkdirSync(path.join(__dirname, 'scratch'));
        }

        fs.writeFile(tempPath, buffer, (err) => {
            if (err) return reject(err);

            const pyProcess = spawn('python3', [path.join(__dirname, 'scripts', 'python_pdf_extractor.py'), tempPath]);
            let outputData = '';
            let errorData = '';

            pyProcess.stdout.on('data', (data) => outputData += data.toString());
            pyProcess.stderr.on('data', (data) => errorData += data.toString());

            pyProcess.on('close', (code) => {
                fs.unlink(tempPath, () => {});
                if (code !== 0) {
                    return reject(new Error(`Python process exited with code ${code}. ${errorData}`));
                }
                try {
                    const result = JSON.parse(outputData);
                    if (result.success) {
                        resolve(result);
                    } else {
                        reject(new Error(result.error || 'Extraction failed'));
                    }
                } catch (e) {
                    reject(new Error('Failed to parse Python output: ' + outputData));
                }
            });
        });
    });
}
// Backward-compatible alias
async function extractPdfWithPython(buffer) {
    return extractFileWithPython(buffer, 'document.pdf');
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
        const { data: rows, error } = await supabase.from('is_standards_vault').select('id, isNumber, title, pdfFileName, uncertainItems, extractedClauses, extractedTables, confidenceScore, uploadedAt').order('id', { ascending: false });
        if (error) throw error;
        const parseLen = (v) => {
            try { const a = typeof v === 'string' ? JSON.parse(v || '[]') : (v || []); return Array.isArray(a) ? a.length : 0; }
            catch (e) { return 0; }
        };
        const formatted = (rows || []).map(r => {
            let uncertain = [];
            try {
                uncertain = typeof r.uncertainItems === 'string' ? JSON.parse(r.uncertainItems || '[]') : (r.uncertainItems || []);
            } catch(e){}
            const hasUncertainties = uncertain.some(item => !item.resolved);
            return {
                id: r.id,
                isNumber: r.isNumber,
                title: r.title,
                pdfFileName: r.pdfFileName,
                uploadedAt: r.uploadedAt,
                confidenceScore: r.confidenceScore,
                status: hasUncertainties ? 'has_uncertainties' : 'parsed',
                clauseCount: parseLen(r.extractedClauses),
                tableCount: parseLen(r.extractedTables)
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
        const { data: row, error } = await supabase.from('is_standards_vault').select('*').eq('id', req.params.id).single();
        if (error || !row) {
            return res.status(404).json({ error: "Document not found" });
        }
        res.json({
            id: row.id,
            isNumber: row.isNumber,
            title: row.title,
            pdfFileName: row.pdfFileName,
            clauses: typeof row.extractedClauses === 'string' ? JSON.parse(row.extractedClauses || '[]') : (row.extractedClauses || []),
            tables: typeof row.extractedTables === 'string' ? JSON.parse(row.extractedTables || '[]') : (row.extractedTables || []),
            uncertainItems: typeof row.uncertainItems === 'string' ? JSON.parse(row.uncertainItems || '[]') : (row.uncertainItems || []),
            dimensionData: typeof row.dimensionData === 'string' ? JSON.parse(row.dimensionData || 'null') : (row.dimensionData || null),
            isFullyResolved: row.isFullyResolved === 1 || row.isFullyResolved === true,
            confidenceScore: row.confidenceScore,
            uploadedAt: row.uploadedAt
        });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// ── IS & Report Formats manager ────────────────────────────────────────────────
// One call that answers "what standards do we hold, and what does each one's
// report look like?". It JOINS three places that already exist independently:
//   1. is_standards_vault      — the extracted standard (params, clauses, flags)
//   2. public/is_templates/*   — the on-disk report FORMAT (clause-by-clause template)
//   3. system_preferences      — the master-template link marker written by /sync-to-master
// Nothing is written here; this is a read-only projection for the manager screen.
const IS_TEMPLATE_DIR = path.join(__dirname, 'public', 'is_templates');
const isTemplateSlug = (isNumber) =>
    String(isNumber || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');

function readISReportFormat(isNumber) {
    const slug = isTemplateSlug(isNumber);
    if (!slug) return null;
    const file = path.join(IS_TEMPLATE_DIR, `${slug}.json`);
    if (!fs.existsSync(file)) return null;
    try {
        const tpl = JSON.parse(fs.readFileSync(file, 'utf8'));
        const params = Array.isArray(tpl.parameters) ? tpl.parameters : [];
        const stat = fs.statSync(file);
        return {
            file: `${slug}.json`,
            url: `/is_templates/${slug}.json`,
            title: tpl.title || '',
            paramCount: params.length,
            dims: Array.isArray(tpl.parameterizationDims) ? tpl.parameterizationDims : [],
            sections: [...new Set(params.map(p => p.section).filter(Boolean))],
            variableParams: params.filter(p => p.valueTable && Object.keys(p.valueTable).length).length,
            sizeKb: Math.round(stat.size / 1024),
            updatedAt: stat.mtime.toISOString()
        };
    } catch (e) {
        return { file: `${slug}.json`, url: `/is_templates/${slug}.json`, broken: e.message, paramCount: 0, dims: [], sections: [] };
    }
}

app.get('/api/is-intelligence/standards', async (req, res) => {
    try {
        const { data: rows, error } = await supabase
            .from('is_standards_vault')
            .select('id, isNumber, title, pdfFileName, uncertainItems, extractedClauses, extractedTables, testParameters, dimensionData, confidenceScore, uploadedAt');
        if (error) throw error;

        // Amendments per standard (best effort — table may not be migrated).
        const amendments = {};
        try {
            const { data: am } = await supabase.from('is_amendments').select('isNumber, isNew');
            for (const a of (am || [])) {
                const k = normalizeISNumber(a.isNumber);
                amendments[k] = amendments[k] || { total: 0, fresh: 0 };
                amendments[k].total++;
                if (a.isNew === true || a.isNew === 1) amendments[k].fresh++;
            }
        } catch (_) {}

        // Master-template link markers written by /sync-to-master.
        const linked = {};
        try {
            const { data: prefs } = await supabase.from('system_preferences').select('key, value').like('key', 'template_%');
            for (const p of (prefs || [])) {
                let v = {};
                try { v = JSON.parse(p.value || '{}'); } catch (_) {}
                if (v.paramsSource === 'is_intelligence') {
                    linked[p.key.replace(/^template_/, '')] = {
                        matchedToHours: (v.hoursMatch && v.hoursMatch.matchedToHours) || 0,
                        totalParams: (v.hoursMatch && v.hoursMatch.totalParams) || 0,
                        syncedAt: (v.hoursMatch && v.hoursMatch.syncedAt) || null
                    };
                }
            }
        } catch (_) {}

        const parseJson = (v, fallback) => {
            try { return typeof v === 'string' ? JSON.parse(v || 'null') : v; } catch (_) { return fallback; }
        };
        const len = (v) => { const a = parseJson(v, []); return Array.isArray(a) ? a.length : 0; };

        const standards = (rows || []).map(r => {
            const uncertain = parseJson(r.uncertainItems, []) || [];
            const openFlags = Array.isArray(uncertain) ? uncertain.filter(u => !u.resolved).length : 0;
            const tp = parseJson(r.testParameters, null);
            const flat = Array.isArray(tp) ? tp : ((tp && tp.flat) || []);
            const key = normalizeISNumber(r.isNumber);
            return {
                id: r.id,
                isNumber: r.isNumber,
                normalizedIS: key,
                title: r.title || '',
                pdfFileName: r.pdfFileName || '',
                uploadedAt: r.uploadedAt,
                confidenceScore: r.confidenceScore,
                clauseCount: len(r.extractedClauses),
                tableCount: len(r.extractedTables),
                vaultParamCount: flat.length,
                openFlags,
                status: openFlags > 0 ? 'has_uncertainties' : 'parsed',
                reportFormat: readISReportFormat(r.isNumber),
                amendments: amendments[key] || { total: 0, fresh: 0 },
                masterLink: linked[key] || null
            };
        }).sort((a, b) => String(a.isNumber).localeCompare(String(b.isNumber), undefined, { numeric: true }));

        // Report formats sitting on disk with no vault row behind them — these would
        // silently render reports nobody can trace back to an extraction, so surface them.
        const known = new Set(standards.map(s => isTemplateSlug(s.isNumber)));
        let orphanFormats = [];
        try {
            orphanFormats = fs.readdirSync(IS_TEMPLATE_DIR)
                .filter(f => f.endsWith('.json') && !known.has(f.replace(/\.json$/, '')))
                .map(f => ({ file: f, url: `/is_templates/${f}`, isNumber: f.replace(/\.json$/, '').replace(/_/g, ' ') }));
        } catch (_) {}

        res.json({
            standards,
            orphanFormats,
            summary: {
                total: standards.length,
                withFormat: standards.filter(s => s.reportFormat).length,
                linkedToMaster: standards.filter(s => s.masterLink).length,
                needsReview: standards.filter(s => s.openFlags > 0).length,
                totalParameters: standards.reduce((n, s) => n + (s.reportFormat ? s.reportFormat.paramCount : s.vaultParamCount), 0)
            }
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Remove a standard from the manager. The vault row and its derived conformance
// limits go; the report-format JSON is ARCHIVED (moved to is_templates/_deleted/),
// never unlinked — an extraction takes minutes of agent time to reproduce.
app.delete('/api/is-intelligence/standards/:id', requireAdmin, async (req, res) => {
    try {
        const { data: row, error } = await supabase
            .from('is_standards_vault').select('id, isNumber').eq('id', req.params.id).single();
        if (error || !row) return res.status(404).json({ error: 'Standard not found.' });

        let limitsRemoved = 0;
        try {
            const { data: del } = await supabase.from('is_conformance_limits')
                .delete().eq('isNumber', row.isNumber).select('id');
            limitsRemoved = (del || []).length;
        } catch (_) {}

        let formatArchived = null;
        const slug = isTemplateSlug(row.isNumber);
        const src = path.join(IS_TEMPLATE_DIR, `${slug}.json`);
        if (slug && fs.existsSync(src)) {
            const archiveDir = path.join(IS_TEMPLATE_DIR, '_deleted');
            try {
                fs.mkdirSync(archiveDir, { recursive: true });
                const dest = path.join(archiveDir, `${slug}.${Date.now()}.json`);
                fs.renameSync(src, dest);
                formatArchived = path.relative(__dirname, dest);
            } catch (e) {
                return res.status(500).json({ error: `Could not archive the report format: ${e.message}` });
            }
        }

        const { error: delErr } = await supabase.from('is_standards_vault').delete().eq('id', row.id);
        if (delErr) throw delErr;

        res.json({ removed: row.isNumber, limitsRemoved, formatArchived });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── IS Scope: publish the standards to TPs, collect what each one tests ────────
// Flow: admin files every IS under a section (Plastic / Metal / …) → each TP picks
// the sections they work in, then ticks the ISs they actually test → admin approves
// → the approved list is written to employee_competencies, which is what the
// auto-assigner already reads. There is deliberately no second competency store:
// a self-declared list that the assigner ignored would be worse than no list.
//
// Approval is the control point. A TP tick alone must never make someone assignable
// for a standard — it becomes competency only when an admin says so, and the
// approving account is recorded on the submission.
//
// Stored in system_preferences (key/value) rather than new tables: the volume is a
// few dozen rows, the table already exists, and it needs no migration to deploy.
const SCOPE_SECTIONS_KEY = 'is_scope_sections';
const SCOPE_MAP_KEY = 'is_scope_section_map';
const SCOPE_TP_PREFIX = 'is_scope_tp_';
const DEFAULT_SECTIONS = ['Plastic', 'Metal', 'Gas Stove', 'Cement', 'Miscellaneous'];
// New competencies start as Trainee, not Standard: Trainee is excluded from priority
// samples and weighted 0.6, so an approval can't silently put an untested declaration
// at full weight. Admin promotes from the Employee Hub as usual.
const SCOPE_DEFAULT_PROFICIENCY = 'Trainee';

// Same standard, different house style: LIMS exports "IS 4985 (2021)" and
// "IS 3196 : Part 1 (2013)"; the vault holds "IS 4985:2021" and "IS 3196 (Part 1) : 2013".
// Compare on punctuation-free uppercase so a bulk paste from LIMS doesn't create a second
// copy of a standard we already have. The YEAR is deliberately kept — IS 4246 (2002) and
// IS 4246 (2025) are different revisions and must stay distinct.
function isNumberKey(s) {
    return String(s || '').toUpperCase()
        .replace(/[()\[\]:,.]/g, ' ')
        .replace(/\bPART\s+/g, 'PART')
        .replace(/\s+/g, ' ')
        .trim();
}

async function readPref(key, fallback) {
    try {
        const { data } = await supabase.from('system_preferences').select('value').eq('key', key).maybeSingle();
        if (!data || !data.value) return fallback;
        return JSON.parse(data.value);
    } catch (e) { return fallback; }
}
async function writePref(key, value) {
    const { error } = await supabase.from('system_preferences')
        .upsert({ key, value: JSON.stringify(value) }, { onConflict: 'key' });
    if (error) throw new Error(error.message);
}

// Everything a TP or admin needs to render the picker: the section list, the
// IS→section filing, and every standard currently in IS Intelligence.
app.get('/api/is-scope/catalogue', async (req, res) => {
    try {
        const sections = await readPref(SCOPE_SECTIONS_KEY, DEFAULT_SECTIONS);
        const sectionMap = await readPref(SCOPE_MAP_KEY, {});
        const { data: rows, error } = await supabase
            .from('is_standards_vault').select('isNumber, title');
        if (error) throw error;
        const standards = (rows || [])
            .map(r => ({ isNumber: r.isNumber, title: r.title || '', section: sectionMap[r.isNumber] || null }))
            .sort((a, b) => String(a.isNumber).localeCompare(String(b.isNumber), undefined, { numeric: true }));
        res.json({
            sections,
            standards,
            unfiled: standards.filter(s => !s.section).length
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Admin files the standards and maintains the section list ("fill the data").
app.post('/api/is-scope/catalogue', requireAdmin, async (req, res) => {
    try {
        const { sections, sectionMap } = req.body || {};
        if (!Array.isArray(sections) || !sections.length) {
            return res.status(400).json({ error: 'At least one section is required.' });
        }
        const cleanSections = [...new Set(sections.map(s => String(s).trim()).filter(Boolean))];
        const cleanMap = {};
        for (const [isNumber, section] of Object.entries(sectionMap || {})) {
            // Drop filings that point at a section that no longer exists, otherwise a
            // renamed section would leave standards invisible to every TP.
            if (section && cleanSections.includes(section)) cleanMap[isNumber] = section;
        }
        await writePref(SCOPE_SECTIONS_KEY, cleanSections);
        await writePref(SCOPE_MAP_KEY, cleanMap);
        res.json({ sections: cleanSections, filed: Object.keys(cleanMap).length, savedBy: req.sessionUser.username });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Add a standard straight from IS Scope Control, without an extraction.
//
// The scope exercise asks "which ISs do you test" — that does not need the standard's
// clauses, limits or report format. Requiring a PDF + minutes of agent time just to
// put an IS in front of TPs would leave real standards unlistable, so this creates a
// name-only vault row and files it in one step.
//
// The row is deliberately marked as un-extracted (`pdfFileName` says so, no parameters,
// no confidence score) so the manager screen shows it as "— no template —" rather than
// implying an extraction happened. Running the normal extraction later updates the same
// isNumber in place.
app.post('/api/is-scope/standards', requireAdmin, async (req, res) => {
    try {
        const isNumber = String((req.body || {}).isNumber || '').trim();
        const title = String((req.body || {}).title || '').trim();
        const section = String((req.body || {}).section || '').trim();
        if (!isNumber) return res.status(400).json({ error: 'IS number is required.' });
        if (!/\d/.test(isNumber)) return res.status(400).json({ error: 'That does not look like an IS number.' });

        const { data: allRows } = await supabase.from('is_standards_vault').select('isNumber');
        const clash = (allRows || []).find(r => isNumberKey(r.isNumber) === isNumberKey(isNumber));
        if (clash) {
            return res.status(409).json({
                error: `Already in the system as "${clash.isNumber}" — file it from the section picker instead.`
            });
        }

        const row = {
            isNumber,
            title: title || isNumber,
            pdfFileName: '(added manually — not extracted)',
            uploadedAt: new Date().toISOString(),
            confidenceScore: null,
            testParameters: JSON.stringify({ flat: [], sections: [], referenced_standards: [] }),
            uncertainItems: JSON.stringify([]),
            extractedClauses: JSON.stringify([]),
            extractedTables: JSON.stringify([]),
            isFullyResolved: false
        };
        const { error } = await supabase.from('is_standards_vault').insert(row);
        if (error) throw new Error(error.message);

        // File it immediately, merging into the stored map so a concurrent edit
        // elsewhere in the filing screen is not overwritten.
        let filedInto = null;
        if (section) {
            const sections = await readPref(SCOPE_SECTIONS_KEY, DEFAULT_SECTIONS);
            if (sections.includes(section)) {
                const map = await readPref(SCOPE_MAP_KEY, {});
                map[isNumber] = section;
                await writePref(SCOPE_MAP_KEY, map);
                filedInto = section;
            }
        }
        res.json({ isNumber, title: row.title, section: filedInto, addedBy: req.sessionUser.username });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Bulk version of the above — one paste instead of one form per standard.
// Partial success is the normal case (a pasted list usually contains a few the lab
// already has), so this never fails the whole batch: each item comes back as added
// or skipped-with-a-reason, and the caller shows both.
app.post('/api/is-scope/standards/bulk', requireAdmin, async (req, res) => {
    try {
        const items = Array.isArray((req.body || {}).items) ? req.body.items : [];
        const section = String((req.body || {}).section || '').trim();
        if (!items.length) return res.status(400).json({ error: 'Nothing to add.' });
        if (items.length > 500) return res.status(400).json({ error: 'Too many at once — split into batches of 500.' });

        const { data: existingRows } = await supabase.from('is_standards_vault').select('isNumber');
        const existing = new Map((existingRows || []).map(r => [isNumberKey(r.isNumber), r.isNumber]));

        const sections = await readPref(SCOPE_SECTIONS_KEY, DEFAULT_SECTIONS);
        const validSection = section && sections.includes(section) ? section : null;

        const added = [], skipped = [], toInsert = [];
        const seenInBatch = new Set();
        const now = new Date().toISOString();

        for (const raw of items) {
            const isNumber = String((raw && raw.isNumber) || '').trim();
            const title = String((raw && raw.title) || '').trim();
            if (!isNumber) { skipped.push({ isNumber: '(blank)', reason: 'No IS number' }); continue; }
            if (!/\d/.test(isNumber)) { skipped.push({ isNumber, reason: 'Not an IS number' }); continue; }
            const k = isNumberKey(isNumber);
            if (existing.has(k)) { skipped.push({ isNumber, reason: `Already in the system as "${existing.get(k)}"` }); continue; }
            if (seenInBatch.has(k)) { skipped.push({ isNumber, reason: 'Duplicate in your list' }); continue; }
            seenInBatch.add(k);
            toInsert.push({
                isNumber,
                title: title || isNumber,
                pdfFileName: '(added manually — not extracted)',
                uploadedAt: now,
                confidenceScore: null,
                testParameters: JSON.stringify({ flat: [], sections: [], referenced_standards: [] }),
                uncertainItems: JSON.stringify([]),
                extractedClauses: JSON.stringify([]),
                extractedTables: JSON.stringify([]),
                isFullyResolved: false
            });
            added.push({ isNumber, title: title || isNumber });
        }

        if (toInsert.length) {
            const { error } = await supabase.from('is_standards_vault').insert(toInsert);
            if (error) throw new Error(error.message);
        }

        // File the whole batch in one map write, merged so nothing already filed is lost.
        if (validSection && added.length) {
            const map = await readPref(SCOPE_MAP_KEY, {});
            for (const a of added) map[a.isNumber] = validSection;
            await writePref(SCOPE_MAP_KEY, map);
        }

        res.json({ added, skipped, section: validSection, addedBy: req.sessionUser.username });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// A TP's own submission.
app.get('/api/is-scope/mine/:userId', async (req, res) => {
    try {
        const sub = await readPref(SCOPE_TP_PREFIX + req.params.userId, null);
        res.json({ submission: sub });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/is-scope/mine', async (req, res) => {
    try {
        const { userId, username, sections, isNumbers, proposedSection, note } = req.body || {};
        if (!userId) return res.status(400).json({ error: 'Missing user.' });
        if (!Array.isArray(sections) || !sections.length) {
            return res.status(400).json({ error: 'Select at least one section.' });
        }
        if (!Array.isArray(isNumbers) || !isNumbers.length) {
            return res.status(400).json({ error: 'Select at least one standard you test.' });
        }
        const prev = await readPref(SCOPE_TP_PREFIX + userId, null);
        const submission = {
            userId,
            username: username || (prev && prev.username) || '',
            sections: [...new Set(sections.map(String))],
            isNumbers: [...new Set(isNumbers.map(String))],
            proposedSection: String(proposedSection || '').trim(),
            note: String(note || '').trim(),
            status: 'pending',
            submittedAt: new Date().toISOString(),
            // Re-submitting after a decision clears the old verdict but keeps the history.
            previousStatus: prev ? prev.status : null,
            reviewedBy: null,
            reviewedAt: null,
            reviewNote: ''
        };
        await writePref(SCOPE_TP_PREFIX + userId, submission);
        res.json({ submission });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Admin review queue. Read-only, so no admin token required — it exposes nothing
// beyond what /api/admin/employees already returns, and gating it would make the
// queue invisible in demo mode for no security gain. The DECISION below is guarded.
app.get('/api/is-scope/submissions', async (req, res) => {
    try {
        const { data: prefs, error } = await supabase
            .from('system_preferences').select('key, value').like('key', `${SCOPE_TP_PREFIX}%`);
        if (error) throw error;

        const submissions = [];
        for (const p of (prefs || [])) {
            try { submissions.push(JSON.parse(p.value)); } catch (_) {}
        }

        // Who hasn't responded yet — the point of the exercise is completion, so the
        // outstanding list matters as much as the queue.
        const { data: profiles } = await supabase
            .from('employee_profiles').select('id, userId, fullName, designation, isActive');
        const responded = new Set(submissions.map(s => String(s.userId)));
        const outstanding = (profiles || [])
            .filter(p => p.isActive && !responded.has(String(p.userId)))
            .map(p => ({ userId: p.userId, fullName: p.fullName, designation: p.designation }));

        submissions.sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));
        res.json({
            submissions,
            outstanding,
            counts: {
                pending: submissions.filter(s => s.status === 'pending').length,
                approved: submissions.filter(s => s.status === 'approved').length,
                rejected: submissions.filter(s => s.status === 'rejected').length,
                outstanding: outstanding.length
            }
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/is-scope/submissions/:userId/decide', requireAdmin, async (req, res) => {
    try {
        const { decision, note } = req.body || {};
        if (!['approve', 'reject'].includes(decision)) {
            return res.status(400).json({ error: 'decision must be "approve" or "reject".' });
        }
        const key = SCOPE_TP_PREFIX + req.params.userId;
        const sub = await readPref(key, null);
        if (!sub) return res.status(404).json({ error: 'No submission from that user.' });

        let competenciesAdded = 0;
        if (decision === 'approve') {
            // employee_competencies is keyed by employee_profiles.id, not users.id.
            const { data: profile } = await supabase
                .from('employee_profiles').select('id').eq('userId', sub.userId).maybeSingle();
            if (!profile) {
                return res.status(400).json({ error: `${sub.username || 'That user'} has no employee profile, so competencies cannot be recorded. Create the profile in Employee Hub first.` });
            }
            const { data: existing } = await supabase
                .from('employee_competencies').select('isNumber').eq('employeeId', profile.id);
            const have = new Set((existing || []).map(c => normalizeISNumber(c.isNumber)));
            const toAdd = [...new Set(sub.isNumbers.map(normalizeISNumber))]
                .filter(n => n && !have.has(n))
                .map(n => ({ employeeId: profile.id, isNumber: n, proficiencyLevel: SCOPE_DEFAULT_PROFICIENCY, avgTestDurationHours: 8 }));
            if (toAdd.length) {
                const { error } = await supabase.from('employee_competencies').insert(toAdd);
                if (error) throw new Error(`Competency write failed: ${error.message}`);
                competenciesAdded = toAdd.length;
            }
        }

        sub.status = decision === 'approve' ? 'approved' : 'rejected';
        sub.reviewedBy = req.sessionUser.username;
        sub.reviewedAt = new Date().toISOString();
        sub.reviewNote = String(note || '').trim();
        sub.competenciesAdded = competenciesAdded;
        await writePref(key, sub);

        res.json({ submission: sub, competenciesAdded });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 2. Upload and Parse IS Standard
// Call LM Studio with a vision (image) message — for reading table images
async function callLMStudioVision(systemPrompt, textPrompt, imageBase64) {
    const lmStudioUrl = process.env.LM_STUDIO_URL || 'http://localhost:1234/v1';
    let modelId = null;

    try {
        const modelsRes = await fetch(`${lmStudioUrl}/models`);
        if (modelsRes.ok) {
            const modelsData = await modelsRes.json();
            if (modelsData.data && modelsData.data.length > 0) {
                // Prefer vision model (VL in name), fallback to any loaded model
                modelId = (modelsData.data.find(m => /vl|vision|llava/i.test(m.id)) || modelsData.data[0]).id;
            }
        }
    } catch(e) {
        console.warn("Could not query LM Studio models:", e.message);
    }

    if (!modelId) throw new Error('No model loaded in LM Studio');

    const payload = {
        model: modelId,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: [
                { type: 'text', text: textPrompt },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } }
            ]}
        ],
        temperature: 0.05,
        max_tokens: 4096,
    };

    const res = await fetch(`${lmStudioUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`LM Studio Vision Error: ${res.status} - ${errText}`);
    }

    const resData = await res.json();
    return resData.choices[0].message.content;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemini-backed extraction. Used as the primary extractor; falls back to local
// LM Studio if Gemini is unavailable or errors.
// NOTE: this account's accessible models top out at the 2.5 family — "gemini-3.5-flash"
// returns 403 (not a real model here), so we default to gemini-2.5-flash.
// Set GEMINI_EXTRACT_MODEL=gemini-2.5-pro for a stronger structure pass.
// ─────────────────────────────────────────────────────────────────────────────
const IS_EXTRACT_MODEL = process.env.GEMINI_EXTRACT_MODEL || 'gemini-2.5-flash';

function geminiAvailable() {
    const k = process.env.GEMINI_API_KEY;
    return !!(k && k.length > 10 && !k.startsWith('sk_'));
}

async function callGeminiJSON(systemPrompt, userPrompt) {
    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({
        model: IS_EXTRACT_MODEL,
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        config: {
            systemInstruction: systemPrompt,
            temperature: 0.1,
            responseMimeType: 'application/json',
        },
    });
    return response.text;
}

async function callGeminiVisionJSON(systemPrompt, textPrompt, imageBase64) {
    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({
        model: IS_EXTRACT_MODEL,
        contents: [{ role: 'user', parts: [
            { text: textPrompt },
            { inlineData: { mimeType: 'image/png', data: imageBase64 } },
        ]}],
        config: {
            systemInstruction: systemPrompt,
            temperature: 0.05,
            responseMimeType: 'application/json',
        },
    });
    return response.text;
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenRouter — one key for the best models (Gemini reads, Claude Opus structures).
// Preferred path when OPENROUTER_API_KEY is set; OpenAI chat-completions compatible.
// ─────────────────────────────────────────────────────────────────────────────
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
const OR_VISION_MODEL = process.env.OPENROUTER_VISION_MODEL || 'google/gemini-3.5-flash';
const OR_STRUCTURE_MODEL = process.env.OPENROUTER_STRUCTURE_MODEL || 'anthropic/claude-opus-4.8';

function openRouterAvailable() {
    const k = process.env.OPENROUTER_API_KEY;
    return !!(k && k.startsWith('sk-or-'));
}

async function callOpenRouter(model, messages, opts = {}) {
    const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'http://localhost:3005',
            'X-Title': 'LIIS',
        },
        body: JSON.stringify({
            model,
            messages,
            temperature: opts.temperature ?? 0.1,
            max_tokens: opts.maxTokens ?? 4096,
        }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(j.error && j.error.message) || JSON.stringify(j).slice(0, 160)}`);
    return (j.choices && j.choices[0] && j.choices[0].message.content) || '';
}

// Unified extractor entry points — prefer OpenRouter, then direct Gemini, then local LM Studio.
async function extractLLM(systemPrompt, userPrompt) {
    if (openRouterAvailable()) {
        try { return await callOpenRouter(OR_STRUCTURE_MODEL, [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ], { maxTokens: 8192 }); }
        catch (e) { console.warn('[IS Extract] OpenRouter structure failed, falling back:', e.message); }
    }
    if (geminiAvailable()) {
        try { return await callGeminiJSON(systemPrompt, userPrompt); }
        catch (e) { console.warn('[IS Extract] Gemini text failed, falling back to LM Studio:', e.message); }
    }
    return callLMStudio(systemPrompt, userPrompt);
}

async function extractVisionLLM(systemPrompt, textPrompt, imageBase64) {
    if (openRouterAvailable()) {
        try { return await callOpenRouter(OR_VISION_MODEL, [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: [
                { type: 'text', text: textPrompt },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
            ] },
        ], { maxTokens: 4096, temperature: 0.05 }); }
        catch (e) { console.warn('[IS Extract] OpenRouter vision failed, falling back:', e.message); }
    }
    if (geminiAvailable()) {
        try { return await callGeminiVisionJSON(systemPrompt, textPrompt, imageBase64); }
        catch (e) { console.warn('[IS Extract] Gemini vision failed, falling back to LM Studio:', e.message); }
    }
    return callLMStudioVision(systemPrompt, textPrompt, imageBase64);
}

// Smart IS table extractor — text from pdfplumber, image renders for table pages
async function extractISTablesWithPython(buffer, originalName) {
    return new Promise((resolve, reject) => {
        const ext = path.extname(originalName || '.pdf').toLowerCase();
        const tempPath = path.join(__dirname, 'scratch', `is_${crypto.randomBytes(8).toString('hex')}${ext}`);
        if (!fs.existsSync(path.join(__dirname, 'scratch'))) {
            fs.mkdirSync(path.join(__dirname, 'scratch'));
        }
        fs.writeFile(tempPath, buffer, (err) => {
            if (err) return reject(err);
            const pyProcess = spawn('python3', [path.join(__dirname, 'scripts', 'extract_is_tables.py'), tempPath]);
            let out = '', errOut = '';
            pyProcess.stdout.on('data', d => out += d.toString());
            pyProcess.stderr.on('data', d => errOut += d.toString());
            pyProcess.on('close', code => {
                fs.unlink(tempPath, () => {});
                if (code !== 0) return reject(new Error(`Extractor exited ${code}. ${errOut}`));
                try { resolve(JSON.parse(out)); } catch(e) { reject(new Error('Bad extractor output: ' + out.slice(0, 300))); }
            });
        });
    });
}

// ── RETIRED 2026-06-24: the OpenRouter 6-phase pipeline is no longer an input. ──
// IS Intelligence has a single input source now: POST /api/is-intelligence/agent-extract
// (Claude Agent SDK). These two routes are kept registered (not 404) so any stale client
// gets a clear redirect instead of a confusing not-found.
app.post('/api/is-intelligence/upload', (req, res) => {
    res.status(410).json({ error: 'IS pipeline retired. Use POST /api/is-intelligence/agent-extract.' });
});

app.get('/api/is-intelligence/pipeline/:jobId', (req, res) => {
    res.status(410).json({ error: 'IS pipeline retired. Use POST /api/is-intelligence/agent-extract.' });
});

// ── Agent SDK extraction: upload PDF → Claude Agent reads it & writes the template ──
// Runs the SAME agent loop Claude Code uses, in-process. Needs ANTHROPIC_API_KEY.
const agentJobs = new Map();
// Projects an agent template (per-combo valueTable) into the vault's v3 testParameters shape,
// so IS Intelligence is the single source of truth for /params, /sync-to-master, conformance,
// and the report-from-vault fallback. See server/agent/template-to-vault.js.
const { agentTemplateToVaultParams } = require('./server/agent/template-to-vault');

app.post('/api/is-intelligence/agent-extract', upload.single('pdf'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded' });
    if (!req.file.originalname.toLowerCase().endsWith('.pdf')) return res.status(400).json({ error: 'Only PDF files are accepted' });
    if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(503).json({ error: 'Agent extraction needs ANTHROPIC_API_KEY in .env (get one at console.anthropic.com). The Agent SDK does not accept OpenRouter/Gemini keys.' });
    }
    const { runReportAgent } = require('./server/agent/is-report-agent');
    const dir = path.join(__dirname, 'scratch');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const pdfPath = path.join(dir, `agent_${crypto.randomBytes(6).toString('hex')}.pdf`);
    fs.writeFileSync(pdfPath, req.file.buffer);

    const jobId = crypto.randomBytes(8).toString('hex');
    const job = { status: 'running', log: [], result: null, error: null, startedAt: Date.now() };
    agentJobs.set(jobId, job);

    const uploadedName = req.file.originalname;
    (async () => {
        const out = await runReportAgent(pdfPath, {
            isHint: (req.body && req.body.isNumber) || '',
            onEvent: (line) => { job.log.push(line); if (job.log.length > 200) job.log.shift(); },
        });
        // Register the standard in the IS vault so it appears in the list (like pipeline-scanned ones).
        // The clause-by-clause data lives in the template file; this row just makes the standard
        // discoverable + openable. MUST finish BEFORE status flips to 'done', else the frontend
        // refreshes the vault list before the row exists and the new standard won't appear / auto-open.
        if (out.ok && out.templatePath) {
            try {
                const tpl = JSON.parse(fs.readFileSync(path.join(__dirname, out.templatePath), 'utf8'));
                const isNumber = out.isNumber || tpl.isNumber || '';
                // Persist the clause-by-clause data INTO the vault (not only the on-disk template),
                // so IS Intelligence is the single source of truth for downstream consumers.
                const vaultParams = agentTemplateToVaultParams(tpl);
                // Retain the whole-doc transcription the agent wrote (scratch/<SLUG>_transcript.txt)
                // as fullText, so the RAG layer can chunk + embed it. Best-effort.
                let fullText = '';
                try {
                    const slug = path.basename(out.templatePath).replace(/\.json$/i, '');
                    const tp = path.join(__dirname, 'scratch', `${slug}_transcript.txt`);
                    if (fs.existsSync(tp)) fullText = fs.readFileSync(tp, 'utf8');
                } catch (_) {}
                const vaultRow = {
                    isNumber,
                    title: tpl.title || '',
                    pdfFileName: uploadedName,
                    confidenceScore: 1.0,
                    isFullyResolved: true,
                    uploadedAt: new Date().toISOString(),
                    testParameters: JSON.stringify({
                        version: 3,
                        flat: vaultParams.flat,
                        sections: vaultParams.sections,
                        referenced_standards: vaultParams.referenced_standards,
                    }),
                    dimensionData: JSON.stringify({
                        parameterizationDims: tpl.parameterizationDims || [],
                        dimensionOptions: tpl.dimensionOptions || {},
                        defaults: tpl.defaults || {},
                    }),
                    ...(fullText ? { fullText } : {}),
                };
                console.log(`[agent] projected ${vaultParams.flat.length} flat param rows from template (${(tpl.parameters || []).length} parameters) for ${isNumber}`);
                const { data: existing, error: selErr } = await supabase.from('is_standards_vault').select('id').eq('isNumber', isNumber).limit(1);
                if (selErr) throw selErr;
                if (existing && existing.length) {
                    const { error } = await supabase.from('is_standards_vault').update(vaultRow).eq('id', existing[0].id);
                    if (error) throw error;
                    out.vaultId = existing[0].id;
                } else {
                    const { data: ins, error } = await supabase.from('is_standards_vault').insert(vaultRow).select('id');
                    if (error) throw error;
                    out.vaultId = ins && ins[0] ? ins[0].id : null;
                }
                console.log(`[agent] IS vault row upserted: ${isNumber} (id ${out.vaultId})`);
            } catch (e) {
                console.error('[agent] IS vault upsert FAILED (template still usable):', e.message);
            }
        }

        // Flip status LAST — only now is the vault row present for the frontend to find + auto-open.
        job.result = out;
        job.status = out.ok ? 'done' : 'error';
        job.error = out.ok ? null : out.error;
        try { fs.unlinkSync(pdfPath); } catch (_) {}
    })().catch(e => { job.status = 'error'; job.error = e.message; });

    res.json({ jobId, message: 'Agent extraction started — poll /api/is-intelligence/agent-extract/' + jobId });
});

app.get('/api/is-intelligence/agent-extract/:jobId', (req, res) => {
    const job = agentJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({ status: job.status, log: job.log.slice(-40), result: job.result, error: job.error, elapsedMs: Date.now() - job.startedAt });
});

// ── On-demand page image for the confirm grid ─────────────────────────────────
// Renders a single PDF page at the requested DPI and returns it as base64 PNG.
// Used so the confirm UI can show the actual page alongside each flagged cell.
app.post('/api/is-intelligence/render-page', upload.single('pdf'), async (req, res) => {
    // This endpoint accepts the same PDF again for on-demand rendering,
    // OR accepts a page render from a previously saved job image map.
    // For now, it returns a placeholder instruction — the phase 2 page images
    // are already stored in the vault uncertainItems.hasPageImage flag.
    // Full implementation: save the PDF buffer in job state and serve from there.
    res.json({ error: 'on-demand render: pass the original PDF and use the pipeline job images' });
});


// Fetch structured IS data by IS number — used for dynamic test parameter generation
// Replaces the hardcoded specs_db.js lookup when IS data has been extracted from a PDF
app.get('/api/is-intelligence/params/:isNumber', async (req, res) => {
    try {
        const isNum = decodeURIComponent(req.params.isNumber).trim();
        // Try exact match first, then partial
        let { data: row, error } = await supabase
            .from('is_standards_vault')
            .select('id, isNumber, title, testParameters, dimensionData, confidenceScore, pdfFileName, uploadedAt')
            .ilike('isNumber', `%${isNum.replace(/[^a-zA-Z0-9 ]/g, '%')}%`)
            .order('uploadedAt', { ascending: false })
            .limit(1)
            .single();

        if (error || !row) {
            return res.status(404).json({ found: false, message: `No extracted data found for ${isNum}` });
        }

        let tpRaw = null;
        let dimData = null;
        try { tpRaw = typeof row.testParameters === 'string' ? JSON.parse(row.testParameters || 'null') : row.testParameters; } catch(e) {}
        try { dimData = typeof row.dimensionData === 'string' ? JSON.parse(row.dimensionData || 'null') : row.dimensionData; } catch(e) {}

        // Normalize: old rows stored a flat array; v2 rows store { flat, sections, referenced_standards }.
        const tpNorm = Array.isArray(tpRaw)
            ? { flat: tpRaw, sections: [], referenced_standards: [] }
            : (tpRaw && typeof tpRaw === 'object'
                ? { flat: tpRaw.flat || [], sections: tpRaw.sections || [], referenced_standards: tpRaw.referenced_standards || [] }
                : { flat: [], sections: [], referenced_standards: [] });

        res.json({
            found: true,
            id: row.id,
            isNumber: row.isNumber,
            title: row.title,
            pdfFileName: row.pdfFileName,
            confidenceScore: row.confidenceScore,
            test_parameters: tpNorm.flat,
            sections: tpNorm.sections,
            referenced_standards: tpNorm.referenced_standards,
            dimension_data: dimData,
            param_count: tpNorm.flat.length
        });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// Make IS Intelligence the SINGLE SOURCE OF TRUTH for a standard's parameters —
// by LINKING, not copying. IS Intelligence (the vault) is only READ here, never
// modified. This endpoint:
//   (a) refreshes is_conformance_limits — a derived pass/fail projection sourced
//       FROM IS Intelligence (so the report's limits always trace back to it), and
//   (b) marks the auto-assigner's Master Template (template_<IS>) as linked to IS
//       Intelligence (params read live from the vault, not embedded) and MATCHES
//       the testing-charges man-hours to the IS-Intelligence clauses.
// Man-hours/equipment are NOT in IS Intelligence (they come from the BIS testing-
// charges PDF) and are preserved untouched — IS Intelligence is the source for
// WHAT is tested + the limits; testing-charges stays the source for HOW LONG.
app.post('/api/is-intelligence/sync-to-master/:isNumber', requireAdmin, async (req, res) => {
    try {
        const isNum = decodeURIComponent(req.params.isNumber).trim();
        const { data: row, error } = await supabase
            .from('is_standards_vault')
            .select('isNumber, testParameters')
            .ilike('isNumber', `%${isNum.replace(/[^a-zA-Z0-9 ]/g, '%')}%`)
            .order('uploadedAt', { ascending: false })
            .limit(1)
            .single();
        if (error || !row) return res.status(404).json({ error: `No IS Intelligence data found for ${isNum}. Extract it first.` });

        let tpRaw = null;
        try { tpRaw = typeof row.testParameters === 'string' ? JSON.parse(row.testParameters || 'null') : row.testParameters; } catch (_) {}
        const flat = Array.isArray(tpRaw) ? tpRaw : ((tpRaw && tpRaw.flat) || []);
        const canonicalIS = row.isNumber || isNum;
        if (!flat.length) return res.status(400).json({ error: `${canonicalIS} has no extracted parameters in IS Intelligence yet.` });

        // (a) Conformance limits — same mapping as the pipeline phase-5 sync.
        const limitTypeMap = { two_sided: 'range', max_only: 'max', min_only: 'min', qualitative: null };
        const limitsPayload = flat
            .filter(p => limitTypeMap[p.limit_type] !== null && limitTypeMap[p.limit_type] !== undefined)
            .map(p => ({
                isNumber: canonicalIS,
                clauseRef: p.clause || '',
                parameter: p.param || '',
                varietyTag: p.variety || '',
                limitMin: (p.min != null && p.min !== '') ? p.min : null,
                limitMax: (p.max != null && p.max !== '') ? p.max : null,
                unit: p.unit || '',
                limitType: limitTypeMap[p.limit_type] || 'range',
            }));
        let limitsSynced = 0;
        if (limitsPayload.length) {
            const { error: limErr } = await supabase.from('is_conformance_limits')
                .upsert(limitsPayload, { onConflict: 'isNumber, clauseRef, parameter, varietyTag' });
            if (!limErr) limitsSynced = limitsPayload.length;
        }

        // (b) Master Template — attach IS-Intelligence parameters, preserve hours.
        // Key by the NORMALIZED IS ("IS 4985:2021" -> "IS 4985") so we merge into the
        // existing testing-charges template the auto-assigner already uses, instead of
        // creating a year-suffixed orphan that would lose the man-hours/clauses.
        const templateKey = `template_${normalizeISNumber(canonicalIS)}`;
        const { data: prefRow } = await supabase.from('system_preferences').select('value').eq('key', templateKey).maybeSingle();
        let template = {};
        if (prefRow && prefRow.value) { try { template = JSON.parse(prefRow.value); } catch (_) { template = {}; } }
        template.tatDays = template.tatDays || 7;
        template.totalHours = template.totalHours || 0;
        template.activeClauses = template.activeClauses || {};

        // LINK, don't copy: the template does NOT embed the parameter list — IS
        // Intelligence stays the single, untouched source (params are read live from
        // the vault). We only record a link marker and MATCH the testing-charges
        // man-hours (activeClauses) to the IS-Intelligence clauses, so each parameter
        // can be associated with its testing time by clause number.
        const clauseNum = (s) => { const m = String(s || '').match(/\d+(?:\.\d+)*/); return m ? m[0] : null; };
        const hoursByClauseNum = {};
        for (const [k, v] of Object.entries(template.activeClauses)) {
            const n = clauseNum(k); if (n) hoursByClauseNum[n] = (v && v.activeHours) || 0;
        }
        let matchedToHours = 0;
        for (const p of flat) {
            const n = clauseNum(p.clause);
            if (n && hoursByClauseNum[n] != null) matchedToHours++;
        }
        delete template.parameters;                 // remove any copy left by earlier syncs
        template.paramsSource = 'is_intelligence';  // link marker: params read live from the vault
        template.linkedISNumber = canonicalIS;
        template.hoursMatch = { totalParams: flat.length, matchedToHours, syncedAt: new Date().toISOString() };

        const { error: tErr } = await supabase.from('system_preferences')
            .upsert({ key: templateKey, value: JSON.stringify(template) }, { onConflict: 'key' });
        if (tErr) return res.status(500).json({ error: `Master Template link failed: ${tErr.message}` });

        res.json({
            message: `Linked ${canonicalIS}: IS Intelligence is the live parameter source; testing-charges hours matched by clause.`,
            isNumber: canonicalIS,
            paramsInIntelligence: flat.length,
            paramsMatchedToHours: matchedToHours,
            limitsSynced,
            clausesWithHours: Object.keys(template.activeClauses).length,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. RAG Query
app.post('/api/is-intelligence/query', async (req, res) => {
    const { documentId, query } = req.body;
    if (!documentId || !query) {
        return res.status(400).json({ error: "Missing required fields: documentId, query" });
    }
    try {
        const { data: doc, error } = await supabase.from('is_standards_vault').select('*').eq('id', documentId).single();
        if (error || !doc) {
            return res.status(404).json({ error: "Standard not found" });
        }

        const pages = typeof doc.rawExtractedContext === 'string' ? JSON.parse(doc.rawExtractedContext || '[]') : (doc.rawExtractedContext || []);
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
        const { data: doc, error } = await supabase.from('is_standards_vault').select('*').eq('id', documentId).single();
        if (error || !doc) {
            return res.status(404).json({ error: "Standard not found" });
        }

        let items = typeof doc.uncertainItems === 'string' ? JSON.parse(doc.uncertainItems || '[]') : (doc.uncertainItems || []);
        items = items.map(item => {
            if (item.id === itemId) {
                item.resolved = true;
                item.userValue = resolvedValue;
                item.confidence = 1.0;
            }
            return item;
        });

        const allResolved = items.every(item => item.resolved);
        const { error: updateError } = await supabase.from('is_standards_vault').update({
            uncertainItems: JSON.stringify(items),
            isFullyResolved: allResolved
        }).eq('id', documentId);
        
        if (updateError) throw updateError;

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
        // Supabase wildcard matching requires .or() with .ilike()
        const { data: docs, error } = await supabase.from('is_standards_vault')
            .select('*')
            .or(`isNumber.ilike.%${isNumber}%,title.ilike.%${isNumber}%`)
            .limit(1);
            
        if (error || !docs || docs.length === 0) {
            return res.status(404).json({ error: "Standard not found in vault" });
        }
        const doc = docs[0];
        const pages = typeof doc.rawExtractedContext === 'string' ? JSON.parse(doc.rawExtractedContext || '[]') : (doc.rawExtractedContext || []);
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

// --- LIIS Credentials API ---
app.get('/api/profile/liis-credentials', async (req, res) => {
    try {
        const { data: user, error } = await supabase.from('users').select('limsUsername, limsPassword').eq('id', req.query.userId || 1).single();
        if (error || !user) return res.status(404).json({ error: 'User not found' });
        res.json({ limsUsername: user.limsUsername || '', limsPassword: user.limsPassword || '' });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/profile/liis-credentials', async (req, res) => {
    try {
        const { userId, limsUsername, limsPassword } = req.body;
        const targetUserId = userId || 1; // Fallback to 1 if not provided
        const { error } = await supabase.from('users').update({ limsUsername, limsPassword }).eq('id', targetUserId);
        if (error) throw error;
        res.json({ message: 'Credentials updated successfully' });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// --- LIIS Submitted Samples API ---
app.get('/api/liis/submitted', async (req, res) => {
    try {
        const { data: samples, error } = await supabase.from('lims_submitted_samples').select('sampleCode, submittedDate');
        if (error) throw error;
        res.json({ submittedSamples: samples || [] });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// AI COPILOT API ENDPOINTS
// ============================================================================

// In-memory store for pending copilot actions
const pendingCopilotActions = new Map();

app.post('/api/copilot/chat', async (req, res) => {
    try {
        const { message, history, userName } = req.body;
        // AI assistant is restricted to the SSD account only.
        if (String(userName || '').trim().toUpperCase() !== 'SSD') {
            return res.status(403).json({ error: 'AI assistant is only available for the SSD account.' });
        }
        if (!message) return res.status(400).json({ error: 'Message is required' });

        const anthropicApiKey = process.env.ANTHROPIC_API_KEY; // Claude (Sonnet 4.6) powers Nigrani

        const { normalizeTaName, normalizeIS: _normIS, getOicPreferences } = require('./server/agent/nigrani-assistant-utils');
        const nigraniTools = require('./server/agent/nigrani-assistant-tools');

        // 1. Fetch live DB context — all queries run in parallel (latency = slowest one, not the sum)
        const tDb = Date.now();
        const [
            { data: allPending },
            { data: employees, error: employeesError },
            { count: templatesCount },
            { data: openNotifications },
            { data: pendingRecs },
            oicPrefs,
        ] = await Promise.all([
            supabase
                .from('samples')
                .select('id, encodedCode, assignedTo, isNumber, priorityLevel, receivedOn')
                .in('appStatus', ['Pending'])
                .order('receivedOn', { ascending: true }),
            supabase
                .from('employee_profiles')
                .select('fullName, designation, isActive'),
            // Count only — template bodies are fetched on demand by the get_template tool
            supabase
                .from('system_preferences')
                .select('key', { count: 'exact', head: true })
                .like('key', 'template_%'),
            // Open bell notifications (so Nigrani knows about her own audit signals)
            supabase
                .from('lab_notifications')
                .select('id, type, severity, title, created_at')
                .eq('status', 'open')
                .order('created_at', { ascending: false })
                .limit(10),
            // Pending auto-assigner recommendations
            supabase
                .from('assignment_recommendations')
                .select('id, sampleId, recommendedEmployeeName, reason, score')
                .eq('status', 'pending')
                .limit(50),
            // Durable OIC preferences (e.g. "recommend before execute")
            getOicPreferences(),
        ]);
        const templatesLoadedCount = templatesCount || 0;
        console.log(`[Copilot] DB context fetched in ${Date.now() - tDb}ms`);
        if (employeesError) console.warn('[Copilot] employee_profiles query failed:', employeesError.message);

        // Build workload map with full sample objects (not just codes)
        const loadMap = {};
        (allPending || []).forEach(s => {
            const ta = s.assignedTo || 'UNASSIGNED';
            if (!loadMap[ta]) loadMap[ta] = [];
            loadMap[ta].push(s);
        });

        const activeTAs = (employees || [])
            .filter(e => e.isActive !== false)
            .map(e => e.fullName);

        const totalPending = allPending ? allPending.length : 0;

        // --- Compute analytics for richer context ---
        // Per-TA counts excluding UNASSIGNED, for median calculation
        const taCounts = Object.entries(loadMap)
            .filter(([ta]) => ta !== 'UNASSIGNED')
            .map(([ta, samples]) => ({ ta, count: samples.length }))
            .sort((a, b) => b.count - a.count);

        const countsOnly = taCounts.map(x => x.count).sort((a, b) => a - b);
        const median = countsOnly.length
            ? (countsOnly.length % 2 === 0
                ? (countsOnly[countsOnly.length / 2 - 1] + countsOnly[countsOnly.length / 2]) / 2
                : countsOnly[Math.floor(countsOnly.length / 2)])
            : 0;
        const overThreshold = median * 1.5;
        const underThreshold = median * 0.5;

        const overloaded = taCounts.filter(t => t.count > overThreshold);
        const underutilized = taCounts.filter(t => t.count < underThreshold && t.count > 0);

        // Workload table (compact)
        const workloadTable = taCounts
            .map(t => {
                const flag = t.count > overThreshold ? ' [OVERLOAD]'
                    : t.count < underThreshold ? ' [CAPACITY]'
                    : '';
                return `${t.ta}: ${t.count}${flag}`;
            })
            .join(' | ');

        const unassignedCount = (loadMap['UNASSIGNED'] || []).length;

        // Aging buckets (days since receivedOn)
        const now = Date.now();
        // A3 fix: receivedOn is DD-MM-YYYY; raw new Date() reads it as MM-DD-YYYY (US order),
        // turning valid May dates into future Nov/Sep dates → negative ages. Parse the real order.
        const ageDays = (iso) => {
            if (!iso) return null;
            const p = String(iso).replace(/[\/.]/g, '-').trim().split('-');
            let d;
            if (p.length === 3 && p[0].length === 4) d = new Date(`${p[0]}-${p[1]}-${p[2]}T00:00:00`).getTime();      // yyyy-mm-dd
            else if (p.length === 3 && p[2].length === 4) d = new Date(`${p[2]}-${p[1]}-${p[0]}T00:00:00`).getTime(); // dd-mm-yyyy
            else d = new Date(iso).getTime();
            return Number.isFinite(d) ? Math.floor((now - d) / 86400000) : null;
        };
        const buckets = { '0-15': 0, '16-30': 0, '31-45': 0, '46-90': 0, '90+': 0, 'unknown': 0 };
        (allPending || []).forEach(s => {
            const age = ageDays(s.receivedOn);
            if (age === null || age < 0) buckets['unknown']++;  // A3: future-dated/unparseable → unknown, not 0-15
            else if (age <= 15) buckets['0-15']++;
            else if (age <= 30) buckets['16-30']++;
            else if (age <= 45) buckets['31-45']++;
            else if (age <= 90) buckets['46-90']++;
            else buckets['90+']++;
        });
        const agingLine = Object.entries(buckets)
            .filter(([, n]) => n > 0)
            .map(([range, n]) => `${range}d: ${n}`)
            .join(' | ');

        // Priority distribution
        const priorityMap = {};
        (allPending || []).forEach(s => {
            const p = (s.priorityLevel || 'UNSPECIFIED').toUpperCase();
            priorityMap[p] = (priorityMap[p] || 0) + 1;
        });
        const priorityLine = Object.entries(priorityMap).map(([k, v]) => `${k}: ${v}`).join(' | ');

        // Top 5 oldest pending samples (already sorted ascending by receivedOn)
        const oldestFive = (allPending || []).slice(0, 5).map(s => {
            const age = ageDays(s.receivedOn);
            return `${s.encodedCode} (IS ${s.isNumber || '?'}, ${age !== null ? age + 'd' : 'unknown age'}, ${s.assignedTo || 'UNASSIGNED'}, ${s.priorityLevel || 'NORMAL'})`;
        }).join('; ');

        // Re-key loadMap with normalised TA names (collapses "Dangale Dangale", lowercase dups)
        const normLoadMap = {};
        Object.entries(loadMap).forEach(([rawTa, items]) => {
            const key = rawTa === 'UNASSIGNED' ? 'UNASSIGNED' : normalizeTaName(rawTa);
            if (!normLoadMap[key]) normLoadMap[key] = [];
            normLoadMap[key].push(...items);
        });

        // Distinct IS counts (pending only) — fixes "how many IS do we have"
        const isCountMap = new Map();
        (allPending || []).forEach(s => {
            const k = _normIS(s.isNumber) || 'UNKNOWN_IS';
            isCountMap.set(k, (isCountMap.get(k) || 0) + 1);
        });
        const distinctIsCount = isCountMap.size;
        const topIs = [...isCountMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

        // 2. System prompt — analyst persona, evidence-driven, structured output
        const isRebalanceQuery = /rebalance|reassign/i.test(message);

        const memorySummary = (req.body.memorySummary || '').slice(0, 800);

        const topIsLine = topIs.map(([k, v]) => `${k}:${v}`).join(' | ') || 'none';
        const openNotifLine = (openNotifications || []).length
            ? (openNotifications || []).map(n => `[${n.severity}] ${n.title}`).join('; ')
            : 'none open';
        const pendingRecsLine = (pendingRecs || []).length
            ? `${(pendingRecs || []).length} pending recommendations waiting OIC approval`
            : 'no pending recommendations';
        const prefsLine = Object.entries(oicPrefs).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('; ') || 'none';

        let systemPrompt = `You are Nigrani — a friendly assistant for the BIS Sample Receiving Lab. You were built by Saurabh. The name "Nigrani" means "oversight".

WHO YOU TALK TO:
You are speaking to the OIC, who OWNS this data. Every table in the database is fair game for them — samples, employees, competencies, templates, leaves, recommendations, notifications, audit log. NEVER refuse to share sample IDs, IS standards, TA names, or any other lab data on privacy grounds. The data belongs to the OIC.

THE NO-ASSUMPTION RULE (most important):
- Never claim a fact that is not in the data passed to you this turn or returned from a tool you called this turn.
- Banned phrases: "the system will", "probably", "I think", "I believe", "should be", "it just executes directly", "it doesn't have a recommendation mode". Replace with "the data shows" / "the template for IS X says" / "I don't have that data right now — want me to pull it?".
- If you don't know, say which table or which tool would have the answer. Then offer to call the tool.

TOOLS YOU CAN CALL (function calling):
Lab operations:
- get_workload_snapshot() — per-TA load + median + overload/capacity flags
- get_sample({sampleId}) — full row for one sample
- find_competent_tas({isNumber}) — TAs marked competent for an IS, with proficiency
- get_aging_breakdown() — age buckets + 5 oldest
- get_audit_log({limit?, actionType?}) — Nigrani's audit trail
- get_open_notifications() — current bell items
- get_template({isNumber}) — testing-charges template (tatDays, totalHours, active clauses, equipment per clause)
- list_pending_recommendations() — auto-assigner / Nigrani proposals awaiting OIC approval
- count_distinct_is() — distinct IS standards among pending samples
IS standards knowledge (IS Intelligence — your eyes into the actual standards):
- list_standards() — every IS standard available in the vault (call this first to get the exact isNumber)
- read_standard({isNumber}) — full document text + every extracted parameter (clause, limits, unit). Read this before answering ANY question about what a standard says.
- get_limit({isNumber, size?, grade?, class?, type?, parameter?}) — the exact specified min/max/unit/clause for a size/grade. Use for any limit/tolerance/value question so the number is authoritative.

STANDARDS RULES (as strict as the no-assumption rule):
- NEVER answer a question about an IS standard from memory or training. Call read_standard or get_limit FIRST, then answer ONLY from what it returned.
- ALWAYS cite the clause (and section/page if given). For a numeric limit, quote the exact value + unit from get_limit — never round or paraphrase it.
- If the standard isn't in the vault, say so plainly and call list_standards to show what IS available — do not guess.

Use a tool whenever the answer is not already in LIVE LAB DATA below. Prefer DOING the work — call the tool, take the next step, chain several tools if needed — over asking permission.

WHAT YOU CAN AND CANNOT DO:
- You CAN read every table, propose reassignments (as pending recommendations), and trigger the rules engine.
- You CANNOT directly mutate samples, edit templates, or execute reassignments. Only the OIC's approval in the UI executes anything.
- The auto-assigner (POST /api/auto-assign) writes pending recommendations the OIC approves. There IS a recommendation mode.

ANTI-WAFFLE:
- Never ask "does that sound good?" or "want me to proceed?" if you have the data to just answer.
- One clarifying question per turn, max. Prefer calling a tool over asking.

OIC POLICIES (durable preferences):
${prefsLine}

HOW YOU REMEMBER:
${memorySummary ? `What you and the user have discussed so far:\n"${memorySummary}"\n\nCarry that context forward. If the user says "that one" or "the same TA", you know what they mean.` : 'This appears to be the start of a fresh conversation.'}

LIVE LAB DATA (refreshed every message):
- Total pending: ${totalPending} (${unassignedCount} unassigned)
- Distinct IS standards in pending: ${distinctIsCount}; top: ${topIsLine}
- Templates loaded: ${templatesLoadedCount}
- TAs on roster: ${activeTAs.join(', ') || 'none'}
- Median TA load: ${median} (overload >${overThreshold.toFixed(0)}, capacity <${underThreshold.toFixed(0)})
- Workload now: ${workloadTable || 'no assignments yet'}
- Overloaded right now: ${overloaded.length ? overloaded.map(t => `${t.ta} (${t.count})`).join(', ') : 'no one'}
- Has spare capacity: ${underutilized.length ? underutilized.map(t => `${t.ta} (${t.count})`).join(', ') : 'no one obvious'}
- Aging: ${agingLine || 'no aging data'}
- Priority mix: ${priorityLine || 'no priority data'}
- Oldest 5 pending: ${oldestFive || 'n/a'}
- Open bell notifications: ${openNotifLine}
- Pending recommendations: ${pendingRecsLine}

WHEN ASKED ABOUT ASSIGNMENT:
The auto-assigner considers IS competency, man-hours per IS, TAT/shelf-life, equipment bottlenecks, leave. If someone asks "why was X assigned to Y", call get_audit_log({sampleCode:'X'}) and cite the actual reason from the row. Don't speculate.

IDENTITY:
"I'm Nigrani — your friendly assistant, built by Saurabh." Volunteer only if asked.

STYLE RULES:
- Default to short. Long lists only if user explicitly asks.
- No emojis unless the user uses one first.
- No "as an AI" / "I'd be happy to" preambles.
- Cite the source of any number you report (the field name or tool you called).`;

        if (isRebalanceQuery) {
            // Build TOP-N moves (one per overloaded TA), not just one — matches what the LLM will say.
            const norm = name => name === 'UNASSIGNED' ? 'UNASSIGNED' : normalizeTaName(name);
            const movesPlan = [];
            const lightTAs = [...taCounts].reverse().filter(x => x.count < median).slice(0, 5);
            let lightIdx = 0;
            for (const heavy of taCounts.filter(t => t.count > overThreshold)) {
                if (!lightTAs.length) break;
                const target = lightTAs[lightIdx % lightTAs.length];
                lightIdx++;
                const heavySamples = normLoadMap[norm(heavy.ta)] || [];
                if (!heavySamples.length) continue;
                const ranked = [...heavySamples].sort((a, b) => {
                    const score = s => (s.priorityLevel || '').toUpperCase() === 'LOW' ? 0
                        : (s.priorityLevel || '').toUpperCase() === 'NORMAL' ? 1 : 2;
                    return score(a) - score(b);
                });
                const sampleToMove = ranked[0];
                if (!sampleToMove) continue;
                movesPlan.push({
                    sampleId: sampleToMove.encodedCode,
                    from: norm(heavy.ta),
                    to: norm(target.ta),
                });
                if (movesPlan.length >= 10) break;
            }
            if (movesPlan.length) {
                systemPrompt += `

REBALANCE CONTEXT:
${movesPlan.length} moves proposed (one per overloaded TA, capped at 10). State the count plainly, then append EXACTLY this JSON block — no extra prose around it:
\`\`\`json
${JSON.stringify({ type: 'rebalance_proposal', moves: movesPlan })}
\`\`\`
The OIC will see one row per move in the UI and approve each.`;
            }
        }

        // 3. Build messages array (keep last 8 history items so Nigrani can summarise the conversation)
        const messages = [{ role: 'system', content: systemPrompt }];
        const recentHistory = (history || []).slice(-8);
        recentHistory.forEach(h => {
            messages.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content });
        });
        messages.push({ role: 'user', content: message });

        // 4. Call AI with tool-use loop (Claude — Sonnet 4.6 via the Anthropic SDK)
        let aiReply = '';
        let toolTrace = [];

        const useAnthropic = anthropicApiKey && anthropicApiKey.startsWith('sk-ant-');

        if (useAnthropic) {
            try {
                console.log('[Copilot] Calling Claude (Sonnet 4.6) with tool-use…');
                const tAi = Date.now();
                const { Anthropic } = require('@anthropic-ai/sdk');
                const anthropic = new Anthropic({ apiKey: anthropicApiKey });

                const CLAUDE_MODEL = 'claude-sonnet-4-6'; // best speed/quality balance for a tool-calling chat; thinking off for snappy latency

                // Anthropic tool defs: TOOLS already carry a clean JSON-schema inputSchema — just rename the key.
                const anthropicTools = nigraniTools.TOOLS.map(t => ({
                    name: t.name,
                    description: t.description,
                    input_schema: t.inputSchema,
                }));

                // System prompt is a top-level param on Anthropic — strip it out of the messages array.
                const claudeMessages = messages
                    .filter(m => m.role !== 'system')
                    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

                const callClaude = () => anthropic.messages.create({
                    model: CLAUDE_MODEL,
                    max_tokens: 4096,
                    system: systemPrompt,
                    tools: anthropicTools,
                    messages: claudeMessages,
                });

                // Tool-use loop: keep going until Claude stops requesting tools (cap rounds so we never recurse forever).
                let response = await callClaude();
                let rounds = 0;
                while (response.stop_reason === 'tool_use' && rounds < 12) {
                    rounds++;
                    const toolUses = response.content.filter(b => b.type === 'tool_use');
                    console.log(`[Copilot] Claude requested ${toolUses.length} tool call(s):`, toolUses.map(b => b.name).join(', '));

                    // Echo the assistant turn (incl. tool_use blocks) verbatim before sending results.
                    claudeMessages.push({ role: 'assistant', content: response.content });

                    const toolResults = await Promise.all(toolUses.map(async b => {
                        let out;
                        try {
                            out = await nigraniTools.callTool(b.name, b.input || {});
                            toolTrace.push({ name: b.name, args: b.input || {}, ok: !out || !out.error });
                        } catch (e) {
                            out = { error: e.message };
                            toolTrace.push({ name: b.name, args: b.input || {}, ok: false });
                        }
                        return { type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out ?? {}) };
                    }));
                    claudeMessages.push({ role: 'user', content: toolResults });

                    response = await callClaude();
                }

                aiReply = (response.content || [])
                    .filter(b => b.type === 'text')
                    .map(b => b.text)
                    .join('')
                    .trim();
                console.log(`[Copilot] Claude succeeded in ${Date.now() - tAi}ms (${rounds} tool round(s)).`);
            } catch (anthropicErr) {
                console.error('[Copilot] Claude error:', anthropicErr.message || anthropicErr);
                throw new Error('Claude AI error: ' + (anthropicErr.message || 'Unknown error'));
            }
        }

        if (!aiReply) {
            throw new Error('Claude API key not configured. Please set ANTHROPIC_API_KEY in .env');
        }

        // 5. Parse action cards (JSON block)
        let actionData = null;
        const jsonMatch = aiReply.match(/```json\n([\s\S]*?)\n```/);
        if (jsonMatch) {
            try {
                const parsed = JSON.parse(jsonMatch[1]);
                if (parsed.type === 'rebalance_proposal' && parsed.moves && parsed.moves.length > 0) {
                    const actionId = 'act_' + Date.now() + Math.random().toString(36).substr(2, 5);
                    pendingCopilotActions.set(actionId, parsed.moves);
                    actionData = { type: 'rebalance_proposal', actionId, moves: parsed.moves };
                    aiReply = aiReply.replace(/```json\n[\s\S]*?\n```/, '').trim();
                }
            } catch (e) { console.warn('[Copilot] Failed to parse JSON action block:', e.message); }
        }

        res.json({ reply: aiReply, actionData, toolTrace });

    } catch (err) {
        console.error('[Copilot] Exception:', err.message || err);
        res.status(500).json({ error: err.message || 'Internal server error' });
    }
});

app.post('/api/copilot/action', async (req, res) => {
    try {
        const { actionId, userName } = req.body;
        // AI assistant is restricted to the SSD account only.
        if (String(userName || '').trim().toUpperCase() !== 'SSD') {
            return res.status(403).json({ error: 'AI assistant is only available for the SSD account.' });
        }
        if (!actionId || !pendingCopilotActions.has(actionId)) {
            return res.status(400).json({ error: 'Invalid or expired action' });
        }

        const moves = pendingCopilotActions.get(actionId);

        // Resolve a TA's fullName to the USERNAME convention samples.assignedTo uses
        // everywhere else (fullName -> employee_profiles.userId -> users.username).
        // Without this the copilot accept path would write a raw fullName, breaking
        // every assignedTo-by-username query (TP sample list, load maps, etc.).
        const resolveAssignee = async (name) => {
            if (!name) return name;
            const { data: emp } = await supabase.from('employee_profiles').select('userId').eq('fullName', name).maybeSingle();
            if (emp && emp.userId) {
                const { data: user } = await supabase.from('users').select('username').eq('id', emp.userId).maybeSingle();
                if (user && user.username) return user.username;
            }
            return name;
        };

        // Execute the moves
        for (const move of moves) {
            // Validate and update DB
            const { data: sample } = await supabase.from('samples').select('id, assignedTo').eq('encodedCode', move.sampleId).single();
            if (sample) {
                const assignedUsername = await resolveAssignee(move.to);
                await supabase.from('samples').update({ assignedTo: assignedUsername }).eq('id', sample.id);
            }
        }

        // Clear the action so it can't be reused
        pendingCopilotActions.delete(actionId);

        res.json({ message: 'Action executed successfully', appliedMoves: moves.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- CAPITAL EQUIPMENT APIS ---
app.get('/api/equipments', async (req, res) => {
    try {
        const { status, location, search } = req.query;
        let query = supabase.from('equipments').select('*').order('id', { ascending: true });

        if (status && status !== 'ALL') {
            query = query.eq('status', status);
        }
        if (location && location !== 'ALL') {
            query = query.eq('location', location);
        }

        const { data, error } = await query;
        if (error) throw error;

        let filteredData = data || [];
        if (search) {
            const term = search.toLowerCase();
            filteredData = filteredData.filter(item => 
                (item.name && item.name.toLowerCase().includes(term)) ||
                (item.make && item.make.toLowerCase().includes(term)) ||
                (item.labCode && item.labCode.toLowerCase().includes(term)) ||
                (item.location && item.location.toLowerCase().includes(term))
            );
        }

        res.json({ equipments: filteredData });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/equipments/stats', async (req, res) => {
    try {
        const { data, error } = await supabase.from('equipments').select('status, cost');
        if (error) throw error;

        const total = data ? data.length : 0;
        let working = 0;
        let notWorking = 0;
        let underRepair = 0;
        let totalCost = 0;

        (data || []).forEach(item => {
            const status = (item.status || '').toLowerCase().trim();
            if (status.includes('not working') || status.includes('notworking')) {
                notWorking++;
            } else if (status.includes('repair') || status.includes('partially')) {
                underRepair++;
            } else {
                working++;
            }

            if (item.cost) {
                const num = parseFloat(item.cost);
                if (!isNaN(num)) {
                    totalCost += num;
                }
            }
        });

        res.json({
            total,
            working,
            notWorking,
            underRepair,
            totalCost
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/equipments', async (req, res) => {
    try {
        const record = req.body;
        const { data, error } = await supabase.from('equipments').insert([record]).select().single();
        if (error) throw error;
        res.status(201).json({ message: 'Equipment added successfully', equipment: data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/equipments/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const updates = req.body;
        const { data, error } = await supabase.from('equipments').update(updates).eq('id', id).select().single();
        if (error) throw error;
        res.json({ message: 'Equipment updated successfully', equipment: data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/equipments/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const { error } = await supabase.from('equipments').delete().eq('id', id);
        if (error) throw error;
        res.json({ message: 'Equipment deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================================
// OCR TEST ENDPOINT — fully local PaddleOCR
// ============================================================================

app.post('/api/ocr/test', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const originalName = req.file.originalname || 'upload.png';
    const ext = path.extname(originalName).toLowerCase();
    const allowed = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.tif', '.webp', '.pdf']);
    if (!allowed.has(ext)) {
        return res.status(400).json({ error: `Unsupported file type: ${ext}. Use PNG, JPG, TIFF, BMP, or PDF.` });
    }

    try {
        const result = await extractFileWithPython(req.file.buffer, originalName);
        res.json({
            success: true,
            text: result.text,
            method: result.method || 'unknown',
            lines: (result.text || '').split('\n').filter(l => l.trim()).length
        });
    } catch (err) {
        console.error('OCR test error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================================
// STRUCTURED DOCUMENT PARSER — calibration certs + IS standards
// Hybrid pipeline: regex first (free, instant) → LM Studio fallback → user confirms
// ============================================================================

async function parseDocumentWithPython(buffer, originalName, docTypeHint) {
    return new Promise((resolve, reject) => {
        const ext = path.extname(originalName || '.pdf').toLowerCase();
        const tempPath = path.join(__dirname, 'scratch', `parse_${crypto.randomBytes(8).toString('hex')}${ext}`);
        if (!fs.existsSync(path.join(__dirname, 'scratch'))) {
            fs.mkdirSync(path.join(__dirname, 'scratch'));
        }

        fs.writeFile(tempPath, buffer, (err) => {
            if (err) return reject(err);

            const args = [path.join(__dirname, 'scripts', 'parse_document.py'), tempPath];
            if (docTypeHint) args.push(docTypeHint);

            const pyProcess = spawn('python3', args);
            let outputData = '';
            let errorData = '';

            pyProcess.stdout.on('data', (data) => outputData += data.toString());
            pyProcess.stderr.on('data', (data) => errorData += data.toString());

            pyProcess.on('close', (code) => {
                fs.unlink(tempPath, () => {});
                if (code !== 0) {
                    return reject(new Error(`Parser exited with code ${code}. ${errorData}`));
                }
                try {
                    resolve(JSON.parse(outputData));
                } catch (e) {
                    reject(new Error('Failed to parse output: ' + outputData.slice(0, 500)));
                }
            });
        });
    });
}

app.post('/api/document/parse-structured', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const originalName = req.file.originalname || 'upload.pdf';
    const ext = path.extname(originalName).toLowerCase();
    const allowed = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.tiff', '.tif', '.webp', '.pdf']);
    if (!allowed.has(ext)) {
        return res.status(400).json({ error: `Unsupported file type: ${ext}` });
    }

    const docTypeHint = req.body.doc_type || null;

    try {
        const regexResult = await parseDocumentWithPython(req.file.buffer, originalName, docTypeHint);

        if (!regexResult.success) {
            return res.status(500).json({ error: regexResult.error || 'Extraction failed' });
        }

        if (regexResult.needs_llm && regexResult.raw_text) {
            try {
                const llmEnhanced = await enhanceWithLLM(regexResult);
                return res.json(llmEnhanced);
            } catch (llmErr) {
                console.warn('LM Studio unavailable, returning regex-only result:', llmErr.message);
                return res.json(regexResult);
            }
        }

        res.json(regexResult);
    } catch (err) {
        console.error('Document parse error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

async function enhanceWithLLM(regexResult) {
    const { doc_type, parsed, raw_text } = regexResult;

    if (doc_type === 'calibration_certificate') {
        const missingFields = Object.entries(parsed)
            .filter(([k, v]) => !v)
            .map(([k]) => k);

        if (missingFields.length === 0) return regexResult;

        const systemPrompt = `You are a calibration certificate parser. Extract ONLY what is explicitly written in the document. NEVER assume or invent values.
Return a JSON object with ONLY these missing fields: ${missingFields.join(', ')}
If a field is not found in the text, set it to empty string "".
Return ONLY valid JSON, no explanation.`;

        const raw = await callLMStudio(systemPrompt, raw_text.slice(0, 3000));
        try {
            const jsonMatch = raw.match(/```json\s*([\s\S]*?)\s*```/) || raw.match(/\{[\s\S]*\}/);
            const llmParsed = JSON.parse((jsonMatch ? jsonMatch[1] || jsonMatch[0] : raw).trim());

            for (const field of missingFields) {
                if (llmParsed[field] && llmParsed[field].trim()) {
                    regexResult.parsed[field] = llmParsed[field].trim();
                    regexResult.confidence[field] = 0.7;
                }
            }
            regexResult.needs_llm = false;
            regexResult.llm_enhanced = true;
        } catch (e) {
            console.warn('LLM output not parseable:', e.message);
        }
        return regexResult;
    }

    if (doc_type === 'is_standard') {
        const systemPrompt = `You are an Indian Standard (IS) document parser. Extract test parameters from the document text.
CRITICAL RULES:
- Extract ONLY what is explicitly written. NEVER assume or invent values.
- Every value must come directly from the document text.
- If a value is not clearly stated, leave it as empty string.

Return a JSON object with this exact structure:
{
  "is_number": "e.g. IS 4985:2021",
  "title": "full title",
  "test_parameters": [
    {
      "clause": "clause number e.g. 7.1.1",
      "param": "parameter name",
      "spec_val": "specification value as written in document",
      "type": "Quantitative or Qualitative",
      "expected": "expected result for qualitative tests",
      "min": "minimum value for quantitative tests",
      "max": "maximum value for quantitative tests"
    }
  ]
}

Return ONLY valid JSON, no explanation.`;

        const raw = await callLMStudio(systemPrompt, raw_text.slice(0, 4000));
        try {
            const jsonMatch = raw.match(/```json\s*([\s\S]*?)\s*```/) || raw.match(/\{[\s\S]*\}/);
            const llmParsed = JSON.parse((jsonMatch ? jsonMatch[1] || jsonMatch[0] : raw).trim());

            if (llmParsed.is_number) {
                regexResult.parsed.is_number = llmParsed.is_number;
                regexResult.confidence.is_number = 0.8;
            }
            if (llmParsed.title) {
                regexResult.parsed.title = llmParsed.title;
                regexResult.confidence.title = 0.8;
            }
            if (llmParsed.test_parameters && llmParsed.test_parameters.length > 0) {
                regexResult.parsed.test_parameters = llmParsed.test_parameters;
                regexResult.confidence.test_parameters = 0.7;
            }
            regexResult.needs_llm = false;
            regexResult.llm_enhanced = true;
        } catch (e) {
            console.warn('LLM output not parseable:', e.message);
        }
        return regexResult;
    }

    return regexResult;
}

// Save confirmed calibration data
app.post('/api/calibration/save', async (req, res) => {
    const { equipment_lab_code, parsed } = req.body;
    if (!parsed) return res.status(400).json({ error: 'No parsed data provided' });

    try {
        const record = {
            equipment_lab_code: equipment_lab_code || parsed.equipment_id || null,
            certificate_number: parsed.certificate_number || null,
            date_of_calibration: parsed.date_of_calibration || null,
            date_next_due: parsed.date_next_due || null,
            equipment_name: parsed.equipment_name || null,
            make: parsed.make || null,
            model: parsed.model || null,
            range: parsed.range || null,
            least_count: parsed.least_count || null,
            calibration_agency: parsed.calibration_agency || null,
            nabl_certificate: parsed.nabl_certificate || null,
            reference_standard: parsed.reference_standard || null,
            temperature: parsed.temperature || null,
            humidity: parsed.humidity || null,
            status: 'confirmed',
            confirmed_at: new Date().toISOString(),
        };

        const { data, error } = await supabase.from('calibration_records').upsert(record, { onConflict: 'certificate_number' }).select().single();
        if (error) throw error;

        res.json({ success: true, record: data });
    } catch (err) {
        console.error('Calibration save error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Save confirmed IS standard test parameters
app.post('/api/is-standard/save-params', async (req, res) => {
    const { is_number, title, test_parameters } = req.body;
    if (!is_number || !test_parameters) {
        return res.status(400).json({ error: 'Missing is_number or test_parameters' });
    }

    try {
        const { data, error } = await supabase.from('is_standards_vault').upsert({
            isNumber: is_number,
            title: title || '',
            extractedClauses: JSON.stringify(test_parameters),
            isFullyResolved: true,
            confidenceScore: 1.0,
            pdfFileName: req.body.pdf_file_name || '',
        }, { onConflict: 'isNumber' }).select().single();

        if (error) throw error;
        res.json({ success: true, record: data });
    } catch (err) {
        console.error('IS standard save error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================================
// IS AMENDMENTS API ENDPOINTS (WITH RESILIENT FALLBACK)
// ============================================================================

let inMemoryAmendments = [
    { id: 1, isNumber: "IS 4985", amendmentNumber: "Amd 1", title: "Amendment No. 1 to IS 4985:2021", isNew: false, publishDate: "2022-05-10", pdfFileName: "IS_4985_Amd_1.pdf" },
    { id: 2, isNumber: "IS 4985", amendmentNumber: "Amd 2", title: "Amendment No. 2 to IS 4985:2021", isNew: false, publishDate: "2024-11-15", pdfFileName: "IS_4985_Amd_2.pdf" },
    { id: 3, isNumber: "IS 4985", amendmentNumber: "Amd 3", title: "Amendment No. 3 to IS 4985:2021", isNew: true, publishDate: "2026-05-01", pdfFileName: "IS_4985_Amd_3.pdf" },
    { id: 4, isNumber: "IS 14735", amendmentNumber: "Amd 1", title: "Amendment No. 1 to IS 14735:1999", isNew: true, publishDate: "2026-04-12", pdfFileName: "IS_14735_Amd_1.pdf" },
    { id: 5, isNumber: "IS 269", amendmentNumber: "Amd 1", title: "Amendment No. 1 to IS 269:2015", isNew: false, publishDate: "2018-09-05", pdfFileName: "IS_269_Amd_1.pdf" },
    { id: 6, isNumber: "IS 269", amendmentNumber: "Amd 2", title: "Amendment No. 2 to IS 269:2015", isNew: false, publishDate: "2021-03-20", pdfFileName: "IS_269_Amd_2.pdf" }
];

app.get('/api/is-intelligence/amendments', async (req, res) => {
    try {
        const { data, error } = await supabase.from('is_amendments').select('*').order('id', { ascending: true });
        if (error) {
            console.warn("is_amendments table not found/query failed, falling back to in-memory store.");
            return res.json({ amendments: inMemoryAmendments });
        }
        if (!data || data.length === 0) {
            try {
                const inserted = await supabase.from('is_amendments').insert(inMemoryAmendments.map(({id, ...r}) => r)).select();
                if (!inserted.error && inserted.data) {
                    return res.json({ amendments: inserted.data });
                }
            } catch (err) {
                console.error("Could not auto-seed is_amendments:", err);
            }
            return res.json({ amendments: inMemoryAmendments });
        }
        res.json({ amendments: data });
    } catch(err) {
        res.json({ amendments: inMemoryAmendments });
    }
});

app.post('/api/is-intelligence/amendments', async (req, res) => {
    try {
        const { isNumber, amendmentNumber, title, isNew, publishDate } = req.body;
        if (!isNumber || !amendmentNumber || !title) {
            return res.status(400).json({ error: 'Missing required amendment fields.' });
        }
        const record = {
            isNumber: normalizeISNumber(isNumber),
            amendmentNumber,
            title,
            isNew: isNew !== undefined ? isNew : true,
            publishDate: publishDate || new Date().toISOString().split('T')[0]
        };

        const { data, error } = await supabase.from('is_amendments').insert([record]).select().single();
        if (error) {
            console.warn("Could not insert to Supabase, updating in-memory store.");
            const newId = inMemoryAmendments.length > 0 ? Math.max(...inMemoryAmendments.map(a => a.id)) + 1 : 1;
            const newRecord = { id: newId, ...record };
            inMemoryAmendments.push(newRecord);
            return res.json({ message: 'Amendment saved in-memory', amendment: newRecord });
        }
        res.status(201).json({ message: 'Amendment added successfully', amendment: data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/is-intelligence/amendments/toggle-new', async (req, res) => {
    try {
        const { id, isNew } = req.body;
        const targetIsNew = isNew !== undefined ? isNew : false;
        
        try {
            await supabase.from('is_amendments').update({ isNew: targetIsNew }).eq('id', id);
        } catch(e) {}

        const item = inMemoryAmendments.find(a => a.id === parseInt(id));
        if (item) {
            item.isNew = targetIsNew;
        }

        res.json({ success: true, message: 'Amendment status updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/is-intelligence/amendments/:id', async (req, res) => {
    try {
        const id = req.params.id;
        try {
            await supabase.from('is_amendments').delete().eq('id', id);
        } catch(e) {}

        inMemoryAmendments = inMemoryAmendments.filter(a => a.id !== parseInt(id));
        res.json({ success: true, message: 'Amendment deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================================
// NIGRANI AGENT — Phases 1–3 (HITL notification queue + executor + agentic)
// ============================================================================
const nigraniMonitor = require('./server/agent/Nigrani-monitor');
const NigraniMonitor = nigraniMonitor;
const { executeNotification } = require('./server/agent/Nigrani-executor');

app.get('/api/notifications', async (req, res) => {
    try {
        const status = (req.query.status || 'open').toString();
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
        const username = String(req.query.username || '').trim();
        const role = String(req.query.role || '').trim().toLowerCase();
        const isAdminViewer = ['admin', 'admin_sample_cell', 'super_admin'].includes(role);
        const ADMIN_ONLY_TYPES = new Set([
            'unassigned_backlog', 'workload_imbalance', 'aging_cluster', 'priority_unassigned',
        ]);

        const norm = (v) => String(v || '').trim().toLowerCase();
        const me = norm(username);

        // Unauthenticated / unknown non-admin callers get an empty feed (no lab-wide leak).
        if (!isAdminViewer && !me) {
            return res.json({ notifications: [], openCount: 0 });
        }

        let q = supabase.from('lab_notifications')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(isAdminViewer ? limit : Math.min(limit * 4, 200));
        if (status !== 'all') q = q.eq('status', status);
        // Never surface the retired testing_not_started type
        q = q.neq('type', 'testing_not_started');
        const { data, error } = await q;
        if (error) throw error;

        const visibleToUser = (n) => {
            if (isAdminViewer) return true;
            if (ADMIN_ONLY_TYPES.has(n.type)) return false;
            const p = n.payload || {};
            const candidates = [
                p.targetUser, p.ta, p.assignedTo,
            ].map(norm).filter(Boolean);
            return candidates.includes(me);
        };

        const filtered = (data || []).filter(visibleToUser).slice(0, limit);

        // Badge open-count is always against OPEN + visibility, independent of the list chip.
        let openCount = 0;
        if (status === 'open') {
            openCount = filtered.filter(n => n.status === 'open').length;
        } else {
            let oq = supabase.from('lab_notifications')
                .select('*')
                .eq('status', 'open')
                .neq('type', 'testing_not_started')
                .order('created_at', { ascending: false })
                .limit(isAdminViewer ? 200 : 200);
            const { data: openRows } = await oq;
            openCount = (openRows || []).filter(visibleToUser).length;
        }

        res.json({ notifications: filtered, openCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

async function transitionNotification(id, patch) {
    const { data, error } = await supabase
        .from('lab_notifications')
        .update(patch)
        .eq('id', id)
        .select()
        .maybeSingle();
    if (error) throw error;
    if (!data) {
        const e = new Error('Notification not found');
        e.status = 404;
        throw e;
    }
    return data;
}

app.post('/api/notifications/:id/approve', async (req, res) => {
    try {
        const notificationId = parseInt(req.params.id, 10);
        const actor = (req.body && req.body.actor) || 'oic';

        // Mark as approved first
        const approved = await transitionNotification(notificationId, {
            status: 'approved',
            acted_by: actor,
            acted_at: new Date().toISOString(),
        });

        // Execute the action — workload rebalance, unassigned backlog, shelf-life flag, etc.
        let executionResult = null;
        try {
            executionResult = await executeNotification(approved, { actor });
        } catch (execErr) {
            executionResult = { ok: false, error: execErr.message };
        }

        res.json({ notification: approved, executionResult });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

app.post('/api/notifications/:id/dismiss', async (req, res) => {
    try {
        const data = await transitionNotification(req.params.id, {
            status: 'dismissed',
            acted_by: (req.body && req.body.actor) || 'oic',
            acted_at: new Date().toISOString(),
        });
        res.json({ notification: data });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

app.post('/api/notifications/:id/snooze', async (req, res) => {
    try {
        const hours = Math.max(1, Math.min(parseInt((req.body || {}).hours, 10) || 4, 72));
        const until = new Date(Date.now() + hours * 3600 * 1000).toISOString();
        const data = await transitionNotification(req.params.id, {
            status: 'snoozed',
            snooze_until: until,
            acted_by: (req.body && req.body.actor) || 'oic',
            acted_at: new Date().toISOString(),
        });
        res.json({ notification: data });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.message });
    }
});

// Manual trigger — handy during dev, also used by the bell's "Refresh" button.
app.post('/api/notifications/run-monitor', async (_req, res) => {
    try {
        const result = await nigraniMonitor.runOnce({ force: true });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Audit log endpoints ---
app.get('/api/nigrani/audit', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
        const actionType = req.query.actionType || null;

        let q = supabase.from('audit_log')
            .select('*')
            .order('executed_at', { ascending: false })
            .limit(limit);

        if (actionType) q = q.eq('action_type', actionType);

        const { data, error } = await q;
        if (error) throw error;

        res.json({ audit_log: data || [], count: (data || []).length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- OIC preferences endpoints ---
app.get('/api/nigrani/preferences', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('oic_preferences')
            .select('key, value, description');

        if (error) throw error;

        const prefs = {};
        (data || []).forEach(p => {
            try {
                prefs[p.key] = {
                    value: typeof p.value === 'string' ? JSON.parse(p.value) : p.value,
                    description: p.description,
                };
            } catch (_) {
                prefs[p.key] = p.value;
            }
        });

        res.json(prefs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/nigrani/preferences/:key', async (req, res) => {
    try {
        const key = req.params.key;
        const { value, description } = req.body;

        if (!key || typeof value === 'undefined') {
            return res.status(400).json({ error: 'key and value are required' });
        }

        const { data, error } = await supabase
            .from('oic_preferences')
            .upsert({
                key,
                value: typeof value === 'object' ? JSON.stringify(value) : value,
                description,
                set_by: 'oic',
            }, { onConflict: 'key' })
            .select()
            .maybeSingle();

        if (error) throw error;
        res.json({ preference: data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- ATTENDANCE API ---
app.get('/api/attendance/today', async (req, res) => {
    try {
        const todayStr = new Date().toISOString().split('T')[0];
        const { data: attendance, error } = await supabase.from('employee_attendance').select('*').eq('attendanceDate', todayStr);
        if (error) {
            // Table might not exist yet, return defaults
            const { data: employees } = await supabase.from('employee_profiles').select('id, fullName');
            return res.json({ attendance: (employees || []).map(emp => ({ employeeId: emp.id, fullName: emp.fullName, status: 'present' })) });
        }
        const { data: employees } = await supabase.from('employee_profiles').select('id, fullName');
        
        const result = (employees || []).map(emp => {
            const record = (attendance || []).find(a => a.employeeId === emp.id);
            return {
                employeeId: emp.id,
                fullName: emp.fullName,
                status: record ? record.status : 'present' // default present
            };
        });
        res.json({ attendance: result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/attendance', async (req, res) => {
    const { employeeId, status } = req.body;
    const todayStr = new Date().toISOString().split('T')[0];
    try {
        const { error } = await supabase.from('employee_attendance').upsert(
            { employeeId, attendanceDate: todayStr, status },
            { onConflict: 'employeeId, attendanceDate' }
        );
        if (error) throw error;
        res.json({ message: 'Attendance updated.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/attendance/bulk', async (req, res) => {
    const { status } = req.body;
    const todayStr = new Date().toISOString().split('T')[0];
    try {
        const { data: employees } = await supabase.from('employee_profiles').select('id');
        const upserts = (employees || []).map(e => ({ employeeId: e.id, attendanceDate: todayStr, status: status || 'present' }));
        const { error } = await supabase.from('employee_attendance').upsert(upserts, { onConflict: 'employeeId, attendanceDate' });
        if (error) throw error;
        res.json({ message: 'Bulk attendance updated.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- CONFORMANCE LIMITS API ---

// Latest amendment for an IS (req 2a.iii). "Latest" = max publishDate. Reads the
// is_amendments table, falling back to the in-memory seed list if the table is
// unavailable. Returned alongside conformance limits so the test report can
// highlight the most recent amendment against the standard.
async function getLatestAmendment(isNumber) {
    const norm = normalizeISNumber(isNumber);
    let rows = [];
    try {
        const { data } = await supabase.from('is_amendments').select('*');
        if (data && data.length) rows = data;
    } catch (_) { /* fall back below */ }
    if (!rows.length) rows = inMemoryAmendments;
    const matches = (rows || []).filter(a => normalizeISNumber(a.isNumber) === norm);
    if (!matches.length) return null;
    matches.sort((a, b) => (Date.parse(b.publishDate || '') || 0) - (Date.parse(a.publishDate || '') || 0));
    const latest = matches[0];
    return {
        amendmentNumber: latest.amendmentNumber,
        title: latest.title,
        publishDate: latest.publishDate,
        isNew: !!latest.isNew,
        pdfFileName: latest.pdfFileName || null,
        count: matches.length,
    };
}

app.get('/api/conformance-limits/:isNumber', async (req, res) => {
    const { isNumber } = req.params;
    const variety = req.query.variety;
    try {
        // 'ALL' = the admin editor wants every limit across all standards (no IS filter).
        const all = isNumber === 'ALL';
        const latestAmendment = all ? null : await getLatestAmendment(isNumber);
        let q = supabase.from('is_conformance_limits').select('*');
        if (!all) q = q.eq('isNumber', isNumber);
        if (variety) q = q.eq('varietyTag', variety);
        const { data, error } = await q;
        if (error) {
            // Table might not exist yet
            return res.json({ limits: [], latestAmendment });
        }
        res.json({ limits: data || [], latestAmendment });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/conformance-limits', async (req, res) => {
    try {
        const payload = req.body; // should be the record object or array
        const { data, error } = await supabase.from('is_conformance_limits').upsert(payload, { onConflict: 'isNumber, clauseRef, parameter, varietyTag' });
        if (error) throw error;
        res.json({ message: 'Limits saved.', data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/conformance-limits/:id', async (req, res) => {
    try {
        const { error } = await supabase.from('is_conformance_limits').delete().eq('id', req.params.id);
        if (error) throw error;
        res.json({ message: 'Limit deleted.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- TEST REPORT API ---
app.get('/api/test-report/:sampleId', async (req, res) => {
    try {
        const { data: sample, error } = await supabase.from('samples').select('*').eq('id', req.params.sampleId).single();
        if (error || !sample) throw new Error('Sample not found');
        
        let limits = [];
        let obs = [];
        try {
            const { data: l } = await supabase.from('is_conformance_limits').select('*').eq('isNumber', sample.isNumber);
            if (l) limits = l;
            const { data: o } = await supabase.from('test_report_observations').select('*').eq('sampleId', req.params.sampleId);
            if (o) obs = o;
        } catch (e) {
            // Ignore if tables don't exist yet
        }
        
        res.json({ sample, limits, observations: obs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/test-report/:sampleId/observations', async (req, res) => {
    const { sampleId } = req.params;
    const { observations } = req.body; // array of { limitId, observedValue, verdict, remarks, enteredBy }
    try {
        const upserts = observations.map(o => ({
            sampleId,
            limitId: o.limitId,
            observedValue: o.observedValue,
            verdict: o.verdict,
            remarks: o.remarks,
            enteredBy: o.enteredBy || 'system'
        }));
        const { error } = await supabase.from('test_report_observations').upsert(upserts, { onConflict: 'sampleId, limitId' });
        if (error) throw error;
        res.json({ message: 'Observations saved.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3005;
if (!process.env.VERCEL) {
    // Bind 0.0.0.0 so phones/laptops on the same WiFi can reach this Mac.
    app.listen(PORT, '0.0.0.0', () => {
        const os = require('os');
        const nets = os.networkInterfaces();
        const lanIps = Object.values(nets).flat()
            .filter(n => n && n.family === 'IPv4' && !n.internal)
            .map(n => n.address);
        console.log(`Server running on http://localhost:${PORT}`);
        lanIps.forEach(ip => console.log(`WiFi / LAN:     http://${ip}:${PORT}`));
        NigraniMonitor.start();

        // Local ML: retrain the hours-model from lifecycle history shortly after
        // boot, then once a day. Pure-local, no cloud — keeps per-IS setup/marginal
        // hours and TA proficiency tracking reality as samples complete.
        const retrain = () => hoursModel.rebuildFromHistory()
            .then(s => console.log(`[ml] hours-model retrained — ${s.standardsModeled} standards, ${s.batches} batches, ${s.tasProfiled} TAs`))
            .catch(e => console.warn('[ml] retrain failed:', e.message));
        setTimeout(retrain, 30 * 1000);
        setInterval(retrain, 24 * 60 * 60 * 1000);
    });
}
module.exports = {
    app,
    loadSampleHistoryAccountCandidates,
    applySampleHistoryImport,
    loadMasterListAccountCandidates,
    applyMasterListImport,
};
