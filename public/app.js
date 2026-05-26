let currentUser = null;
let allSamples = [];
let currentSubmitId = null;
let pendingFreshSamples = [];
let pendingDuplicateSamples = [];
let forceCommittedCodes = new Set();
let currentFileName = "";
let currentDuplicateCount = 0;
let kpiFilter = "ALL";
let selectedUploadFile = null; // tracks file from both drop and browse
let currentPrefs = { priorityWeight: 5, nonPriorityWeight: 5, leaveWindowDays: 30, autoRunAssigner: false };
let pendingColumnMappings = {}; // resolved column mappings from admin
let uploadMissingAccounts = []; // TA names with no account
let allTPUsers = []; // cached list of all TP users for direct assign dropdown

// --- Toast Notification System ---
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let icon = 'ℹ️';
    if(type === 'success') icon = '✅';
    if(type === 'error') icon = '🚨';

    toast.innerHTML = `<span>${icon}</span> <span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('hiding');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}
// ---------------------------------

// Auth Logic
async function register() {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    if (!username || !password) return showToast('Enter username and password', 'error');

    try {
        const res = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (res.ok) {
            showToast('Registered successfully! You can now login.', 'success');
        } else {
            showToast(data.error, 'error');
        }
    } catch (e) { console.error(e); }
}

async function login() {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    if (!username || !password) return showToast('Enter username and password', 'error');

    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (res.ok) {
            currentUser = data.user;
            document.getElementById('auth-container').classList.remove('active');
            
            if (currentUser.role === 'admin_sample_cell') {
                const sidebarNav = document.getElementById('sidebar-nav');
                if (sidebarNav) sidebarNav.style.display = 'none';
                
                const mainHeader = document.getElementById('main-header');
                if (mainHeader) mainHeader.style.display = 'none';
                
                document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
                
                const scDashboard = document.getElementById('sample-cell-dashboard');
                if (scDashboard) scDashboard.style.display = 'block';
                
                loadSampleCellData();
                fetchScAuditLog();
                return;
            } else {
                document.getElementById('dashboard-container').classList.add('active');
                document.getElementById('user-welcome').textContent = `Welcome, ${currentUser.username} (Role: ${currentUser.role})`;
                
                document.getElementById('admin-tabs').style.display = 'flex';
                toggleAdminViews();
                switchTab('tab-dashboard');
                fetchSamples();
            }
            
            showToast(`Welcome back, ${currentUser.username}!`, 'success');
            fetchSamples();
            loadPreferences();
            fetchTPUsers();
        } else {
            showToast(data.error, 'error');
        }
    } catch (e) { console.error(e); }
}

function logout() {
    currentUser = null;
    toggleAdminViews();
    document.getElementById('dashboard-container').classList.remove('active');
    document.getElementById('sample-cell-dashboard').style.display = 'none';
    document.getElementById('auth-container').classList.add('active');
    document.getElementById('admin-tabs').style.display = 'none';
    document.getElementById('username').value = '';
    document.getElementById('password').value = '';
    showToast('Logged out securely.', 'info');
}

function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    
    document.getElementById(tabId).classList.add('active');
    
    const activeBtn = document.querySelector(`.tab-btn[onclick="switchTab('${tabId}')"]`);
    if (activeBtn) activeBtn.classList.add('active');

    if (tabId === 'tab-audit') {
        viewHistory();
    } else if (tabId === 'tab-lims') {
        renderTestParametersTable();
    } else if (tabId === 'tab-employees') {
        loadEmployees();
    } else if (tabId === 'tab-leaves') {
        loadLeaves();
        populateLeaveEmployeeDropdown();
    } else if (tabId === 'tab-assigner') {
        loadUnassignedPool();
        loadRecommendations();
    } else if (tabId === 'tab-preferences') {
        loadPreferencesUI();
    }
}

// --- PREFERENCES ---
async function loadPreferences() {
    try {
        const res = await fetch('/api/preferences');
        const data = await res.json();
        if (res.ok && data.preferences) {
            currentPrefs = {
                priorityWeight: parseInt(data.preferences.priorityWeight) || 5,
                nonPriorityWeight: parseInt(data.preferences.nonPriorityWeight) || 5,
                leaveWindowDays: parseInt(data.preferences.leaveWindowDays) || 30,
                autoRunAssigner: data.preferences.autoRunAssigner === 'true'
            };
        }
    } catch (err) { console.error('Failed to load preferences:', err); }
}

function loadPreferencesUI() {
    const pw = document.getElementById('pref-priority-weight');
    const npw = document.getElementById('pref-nonpriority-weight');
    const lw = document.getElementById('pref-leave-window');
    const ar = document.getElementById('pref-auto-run');
    if (pw) { pw.value = currentPrefs.priorityWeight; document.getElementById('pref-priority-val').textContent = currentPrefs.priorityWeight; }
    if (npw) { npw.value = currentPrefs.nonPriorityWeight; document.getElementById('pref-nonpriority-val').textContent = currentPrefs.nonPriorityWeight; }
    if (lw) lw.value = currentPrefs.leaveWindowDays;
    if (ar) ar.checked = currentPrefs.autoRunAssigner;
}

async function savePreferences() {
    const prefs = {
        priorityWeight: document.getElementById('pref-priority-weight').value,
        nonPriorityWeight: document.getElementById('pref-nonpriority-weight').value,
        leaveWindowDays: document.getElementById('pref-leave-window').value,
        autoRunAssigner: document.getElementById('pref-auto-run').checked ? 'true' : 'false'
    };
    try {
        const res = await fetch('/api/preferences', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(prefs)
        });
        if (res.ok) {
            showToast('Preferences saved.', 'success');
            loadPreferences();
        } else {
            showToast('Failed to save preferences.', 'error');
        }
    } catch (err) { showToast('Network error saving preferences.', 'error'); }
}

async function fetchTPUsers() {
    try {
        const res = await fetch('/api/admin/users');
        const data = await res.json();
        if (res.ok) {
            allTPUsers = (data.users || []).filter(u => u.role === 'tp');
        }
    } catch (err) { console.error(err); }
}

// User Management Modal Functions
function openUserManagement() {
    document.getElementById('user-management-modal').classList.add('active');
    fetchUsers();
}

function closeUserManagement() {
    document.getElementById('user-management-modal').classList.remove('active');
}

async function fetchUsers() {
    const tbody = document.getElementById('user-management-tbody');
    tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;">Loading directory...</td></tr>';
    
    try {
        const res = await fetch('/api/admin/users');
        const data = await res.json();
        if (res.ok) {
            tbody.innerHTML = '';
            data.users.forEach(user => {
                const tr = document.createElement('tr');
                
                let actionBtn = `<button onclick="adminDeleteUser(this, ${user.id}, '${user.username}')" style="background:var(--danger); color:white; font-size:0.8rem; padding:6px 12px; border:none; border-radius:6px; font-weight:600; cursor:pointer;">Delete</button>`;
                if (user.username === 'Admin') {
                    actionBtn = `<span style="font-size:0.8rem; color:var(--text-muted); font-weight:600;">System Protected</span>`;
                }
                
                tr.innerHTML = `
                    <td><strong>${user.username}</strong></td>
                    <td><span class="status-badge" style="background:rgba(0,0,0,0.05); color:var(--text-main); border:1px solid var(--border-light); font-weight:600;">${user.role.toUpperCase()}</span></td>
                    <td style="text-align:center;">${actionBtn}</td>
                `;
                tbody.appendChild(tr);
            });
        }
    } catch(e) {
        tbody.innerHTML = '<tr><td colspan="3" style="color:var(--danger); text-align:center;">Error loading directory.</td></tr>';
    }
}

async function adminCreateTP() {
    const username = document.getElementById('new-tp-username').value.trim();
    const password = document.getElementById('new-tp-password').value;
    if (!username || !password) return showToast('Please enter both name and password.', 'warning');
    
    try {
        const res = await fetch('/api/admin/create-tp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (res.ok) {
            showToast(data.message, 'success');
            document.getElementById('new-tp-username').value = '';
            document.getElementById('new-tp-password').value = '1234';
            fetchUsers();   
            fetchSamples(); 
        } else {
            showToast(data.error, 'error');
        }
    } catch(e) {
        console.error(e);
        showToast('Failed to create account.', 'error');
    }
}

async function adminDeleteUser(btn, userId, username) {
    if (!btn) return;

    if (btn.dataset.confirming === 'true') {
        // Second click — actually delete
        btn.disabled = true;
        btn.textContent = 'Deleting...';
        try {
            const res = await fetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
            const data = await res.json();
            if (res.ok) {
                showToast(`Account "${username}" deleted.`, 'success');
                fetchUsers();
                fetchSamples();
            } else {
                showToast(data.error, 'error');
                btn.disabled = false;
                btn.textContent = 'Delete';
                btn.dataset.confirming = 'false';
            }
        } catch(e) {
            console.error(e);
            showToast('Failed to delete account.', 'error');
            btn.disabled = false;
            btn.textContent = 'Delete';
            btn.dataset.confirming = 'false';
        }
    } else {
        // First click — ask for confirmation inline
        btn.dataset.confirming = 'true';
        btn.textContent = 'Confirm?';
        btn.style.background = '#dc2626';
        btn.style.outline = '2px solid #fca5a5';
        // Auto-reset after 3 seconds if not clicked again
        setTimeout(() => {
            if (btn.dataset.confirming === 'true') {
                btn.dataset.confirming = 'false';
                btn.textContent = 'Delete';
                btn.style.background = 'var(--danger)';
                btn.style.outline = '';
            }
        }, 3000);
    }
}

// Admin Upload
async function uploadExcel() {
    const file = selectedUploadFile || document.getElementById('excel-file').files[0];
    if (!file) return showToast('Select an Excel file first.', 'warning');
    
    const formData = new FormData();
    formData.append('file', file);

    showToast("Analyzing structure and duplicates...", 'info');
    try {
        const res = await fetch('/api/upload', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        if (res.ok) {
            currentFileName = data.fileName || "Unknown.xlsx";
            uploadMissingAccounts = data.missingAccounts || [];
            pendingColumnMappings = {};
            
            // Handle column mapping
            if (data.columnMapping && data.columnMapping.ambiguous && data.columnMapping.ambiguous.length > 0) {
                showColumnMappingUI(data.columnMapping);
            }
            
            showReviewModal(data.freshSamples, data.duplicateSamples, data.newTPs || []);
        } else {
            showToast(data.error, 'error');
        }
    } catch (e) { console.error(e); }
}

function showColumnMappingUI(columnMapping) {
    const section = document.getElementById('column-mapping-section');
    const rowsDiv = document.getElementById('column-mapping-rows');
    if (!section || !rowsDiv) return;
    
    if (columnMapping.ambiguous.length === 0) {
        section.style.display = 'none';
        return;
    }
    
    section.style.display = 'block';
    rowsDiv.innerHTML = '';
    
    columnMapping.ambiguous.forEach(col => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; gap:12px; margin-bottom:10px; padding:10px; background:rgba(0,0,0,0.03); border-radius:6px;';
        
        let suggestionsHtml = '<option value="skip">Skip this column</option>';
        suggestionsHtml += '<option value="assignedTo">Testing Person / TA Name</option>';
        suggestionsHtml += '<option value="isNumber">IS Number</option>';
        suggestionsHtml += '<option value="receivedOn">Received Date</option>';
        suggestionsHtml += '<option value="forwardedOn">Forwarded Date</option>';
        suggestionsHtml += '<option value="quantity">Quantity</option>';
        suggestionsHtml += '<option value="totalTest">Total Tests</option>';
        suggestionsHtml += '<option value="pendingTest">Pending Tests</option>';
        suggestionsHtml += '<option value="approvedTest">Approved Tests</option>';
        
        const sampleVals = (col.sampleValues || []).slice(0, 3).join(', ');
        
        row.innerHTML = `
            <div style="flex:1;">
                <strong style="color:var(--accent);">${col.originalName}</strong>
                <br><span style="font-size:0.8rem; color:var(--text-muted);">Sample values: ${sampleVals || 'N/A'}</span>
            </div>
            <div style="flex:1;">
                <select onchange="pendingColumnMappings['${col.originalName}']=this.value" style="width:100%; padding:8px; border-radius:4px;">
                    ${suggestionsHtml}
                </select>
            </div>
        `;
        rowsDiv.appendChild(row);
    });
}

function toggleReallotOverride(encodedCode) {
    if (forceCommittedCodes.has(encodedCode)) {
        forceCommittedCodes.delete(encodedCode);
        showToast(`Cancelled force-commit override for ${encodedCode}`, 'info');
    } else {
        forceCommittedCodes.add(encodedCode);
        showToast(`Approved force-commit override for ${encodedCode}!`, 'success');
    }
    
    // Update commit button state if fresh count is zero
    document.getElementById('commit-btn').disabled = (pendingFreshSamples.length === 0 && forceCommittedCodes.size === 0);
}

function showReviewModal(fresh, duplicates, newTPs = []) {
    pendingFreshSamples = fresh;
    pendingDuplicateSamples = duplicates;
    currentDuplicateCount = duplicates.length;
    forceCommittedCodes.clear();
    
    document.getElementById('fresh-count').textContent = fresh.length;
    document.getElementById('duplicate-count').textContent = duplicates.length;
    document.getElementById('commit-btn').disabled = (fresh.length === 0);

    // --- Missing Accounts Banner ---
    const existingMissingBanner = document.getElementById('missing-accounts-banner');
    if (existingMissingBanner) {
        if (uploadMissingAccounts.length > 0) {
            existingMissingBanner.style.display = 'block';
            existingMissingBanner.style.cssText = `
                background: #fff8e1; border: 1px solid #f59e0b; border-left: 4px solid #f59e0b;
                border-radius: 6px; padding: 12px 16px; margin-bottom: 16px;
                font-size: 0.9rem; color: #92400e;
            `;
            existingMissingBanner.innerHTML = `
                <strong>⚠️ ${uploadMissingAccounts.length} Missing Testing Person Account(s) Detected</strong>
                <p style="margin: 6px 0 0;">The following TP names are in the Excel sheet but have no user account. 
                Samples will be imported but marked as <strong>PendingAccount</strong> until their account is created.</p>
                <ul style="margin: 8px 0 0; padding-left: 20px; display:flex; flex-wrap:wrap; gap:4px; list-style:none; padding:0;">
                    ${uploadMissingAccounts.map(name => `<span style="background:#fef3c7; border:1px solid #fbbf24; border-radius:4px; padding:2px 8px; font-weight:600; font-size:0.85rem;">${name}</span>`).join(' ')}
                </ul>
            `;
        } else {
            existingMissingBanner.style.display = 'none';
        }
    }

    const freshTbody = document.getElementById('fresh-tbody');
    freshTbody.innerHTML = '';
    fresh.forEach(s => {
        const tr = document.createElement('tr');
        tr.classList.add('row-success-green');
        tr.innerHTML = `<td>${s.encodedCode}</td><td>${s.assignedTo}</td><td><strong>${s.priorityLevel}</strong></td>`;
        freshTbody.appendChild(tr);
    });

    const dupTbody = document.getElementById('duplicate-tbody');
    dupTbody.innerHTML = '';
    duplicates.forEach(s => {
        const tr = document.createElement('tr');
        
        let actionColumn = `<span style="font-size:0.8rem; color:var(--text-muted); font-weight:600;">Blocked</span>`;
        let highlightClass = 'row-danger-red';
        let detailHtml = `<strong>${s.encodedCode}</strong>`;

        if (s.isReallotted) {
            highlightClass = 'row-warning-yellow';
            actionColumn = `
                <label style="display:flex; align-items:center; gap:6px; cursor:pointer; font-size:0.8rem; font-weight:bold; color:var(--warning);">
                    <input type="checkbox" onchange="toggleReallotOverride('${s.encodedCode}')"> Force Commit
                </label>
            `;
            detailHtml = `
                <strong>${s.encodedCode}</strong><br>
                <span class="status-badge" style="background:rgba(245,158,11,0.15); color:#d97706; border:1px solid rgba(245,158,11,0.3); font-size:0.75rem; margin-top:4px;">
                    ⚠️ Re-allotted (Previously: ${s.previousTP})
                </span>
            `;
        }

        tr.className = highlightClass;
        tr.innerHTML = `
            <td style="text-align:center;">${actionColumn}</td>
            <td>${detailHtml}</td>
            <td><strong>${s.assignedTo}</strong></td>
        `;
        dupTbody.appendChild(tr);
    });

    document.getElementById('review-modal').classList.add('active');
}

function closeReviewModal() {
    document.getElementById('review-modal').classList.remove('active');
    pendingFreshSamples = [];
    pendingDuplicateSamples = [];
    forceCommittedCodes.clear();
    currentDuplicateCount = 0;
    currentFileName = "";
    selectedUploadFile = null;
    document.getElementById('excel-file').value = "";
    const info = document.getElementById('file-info');
    if (info) { info.style.display = 'none'; info.innerHTML = ''; }
}

async function commitUpload() {
    // Add force-committed reallotted duplicates into the list of samples to insert
    const overridesToCommit = pendingDuplicateSamples.filter(s => forceCommittedCodes.has(s.encodedCode));
    const samplesToInsert = [...pendingFreshSamples, ...overridesToCommit];

    if (samplesToInsert.length === 0) return closeReviewModal();
    
    document.getElementById('commit-btn').disabled = true;
    document.getElementById('commit-btn').textContent = "Committing...";

    try {
        const payload = {
            samples: samplesToInsert,
            duplicates: pendingDuplicateSamples.filter(s => !forceCommittedCodes.has(s.encodedCode)),
            duplicateCount: currentDuplicateCount - overridesToCommit.length,
            fileName: currentFileName,
            uploadedBy: currentUser ? currentUser.username : 'Unknown Admin',
            columnMappingLog: Object.keys(pendingColumnMappings).length > 0 ? JSON.stringify(pendingColumnMappings) : null
        };

        const res = await fetch('/api/confirm-upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        showToast(data.message, 'success');
        
        closeReviewModal();
        document.getElementById('excel-file').value = "";
        
        if (currentPrefs.autoRunAssigner) {
            showToast('Auto-running Smart Assigner...', 'info');
            await forceRunAssigner();
        }
        
        fetchSamples();
        
    } catch (e) { 
        console.error(e); 
        showToast('Failed to commit upload', 'error');
    } finally {
        document.getElementById('commit-btn').disabled = false;
        document.getElementById('commit-btn').textContent = "Commit to Master";
    }
}

// Upload History & Batch Details
let allHistory = []; // stored for client-side filtering

async function viewHistory() {
    const tbody = document.getElementById('history-tbody');
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px; color:var(--text-muted);">Loading audit trail...</td></tr>';
    
    try {
        const res = await fetch('/api/upload-history');
        const data = await res.json();
        if (res.ok) {
            allHistory = data.history;

            // Populate uploader filter dropdown
            const userFilter = document.getElementById('audit-user-filter');
            if (userFilter) {
                const uploaders = [...new Set(allHistory.map(h => h.uploadedBy).filter(Boolean))].sort();
                userFilter.innerHTML = '<option value="ALL">All Uploaders</option>';
                uploaders.forEach(u => {
                    const opt = document.createElement('option');
                    opt.value = u;
                    opt.textContent = u;
                    userFilter.appendChild(opt);
                });
            }

            renderAuditRows(allHistory);
        }
    } catch(e) {
        tbody.innerHTML = '<tr><td colspan="5" style="color:var(--danger); text-align:center;">Error loading history.</td></tr>';
    }
}

function filterAuditTable() {
    const searchTerm = (document.getElementById('audit-search')?.value || '').toLowerCase();
    const userVal = document.getElementById('audit-user-filter')?.value || 'ALL';

    const filtered = allHistory.filter(log => {
        const matchFile = !searchTerm || (log.fileName || '').toLowerCase().includes(searchTerm);
        const matchUser = userVal === 'ALL' || log.uploadedBy === userVal;
        return matchFile && matchUser;
    });

    renderAuditRows(filtered);
}

function renderAuditRows(rows) {
    const tbody = document.getElementById('history-tbody');
    const noResults = document.getElementById('audit-no-results');
    tbody.innerHTML = '';

    if (rows.length === 0) {
        if (noResults) noResults.style.display = 'block';
        const table = document.getElementById('audit-table');
        if (table) table.style.display = 'none';
        return;
    }

    if (noResults) noResults.style.display = 'none';
    const table = document.getElementById('audit-table');
    if (table) table.style.display = '';

    rows.forEach(log => {
        const tr = document.createElement('tr');
        tr.style.cursor = 'pointer';
        tr.title = 'Click to view batch details';
        tr.onclick = () => viewBatchDetails(log.batchId);

        const dateObj = new Date(log.uploadDate);
        const prettyDate = dateObj.toLocaleDateString() + ' ' + dateObj.toLocaleTimeString();
        tr.innerHTML = `
            <td style="color:var(--text-muted);">${prettyDate}</td>
            <td><strong>${log.fileName}</strong></td>
            <td style="color:var(--success); font-weight:bold;">+${log.sampleCount}</td>
            <td style="color:${log.duplicateCount > 0 ? 'var(--danger)' : 'var(--text-muted)'}; font-weight:bold;">${log.duplicateCount || 0}</td>
            <td>${log.uploadedBy}</td>
        `;
        tbody.appendChild(tr);
    });
}

async function viewBatchDetails(batchId) {
    document.getElementById('batch-details-modal').classList.add('active');
    document.getElementById('batch-id-display').textContent = batchId;
    
    const freshTbody = document.getElementById('batch-fresh-tbody');
    const dupTbody = document.getElementById('batch-duplicate-tbody');
    
    freshTbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Loading records...</td></tr>';
    dupTbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Loading duplicates...</td></tr>';
    
    try {
        const res = await fetch(`/api/batch-details/${batchId}`);
        const data = await res.json();
        if (res.ok) {
            // Populate summary
            if (data.batchInfo) {
                const dateObj = new Date(data.batchInfo.uploadDate);
                document.getElementById('batch-date-display').textContent = dateObj.toLocaleDateString() + ' ' + dateObj.toLocaleTimeString();
                document.getElementById('batch-uploader-display').textContent = data.batchInfo.uploadedBy || 'Unknown';
                document.getElementById('batch-filename-display').textContent = data.batchInfo.fileName || 'Unknown.xlsx';
                document.getElementById('batch-fresh-count').textContent = data.batchInfo.sampleCount || 0;
                document.getElementById('batch-dup-count').textContent = data.batchInfo.duplicateCount || 0;
                
                const mapSection = document.getElementById('batch-mapping-section');
                const mapContent = document.getElementById('batch-mapping-content');
                if (data.columnMappingLog) {
                    try {
                        const mapping = JSON.parse(data.columnMappingLog);
                        let html = '';
                        for (const [colName, mappedField] of Object.entries(mapping)) {
                            html += `<div style="display:inline-block; margin-right:15px; margin-bottom:5px;"><strong>${colName}</strong> → <span style="color:var(--accent);">${mappedField}</span></div>`;
                        }
                        if (html) {
                            mapContent.innerHTML = html;
                            mapSection.style.display = 'block';
                        } else {
                            mapSection.style.display = 'none';
                        }
                    } catch(e) { mapSection.style.display = 'none'; }
                } else {
                    mapSection.style.display = 'none';
                }
            }

            freshTbody.innerHTML = '';
            if (data.samples.length === 0) {
                freshTbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);">No fresh records in this batch.</td></tr>';
            } else {
                data.samples.forEach(s => {
                    const tr = document.createElement('tr');
                    let statusHtml = '';
                    if (s.appStatus === 'Pending') statusHtml = `<span class="status-badge" style="background:#e0e7ff; color:var(--primary);">Pending</span>`;
                    else if (s.appStatus === 'PendingAccount') statusHtml = `<span class="status-badge" style="background:#fef3c7; color:#d97706;">Pending Account</span>`;
                    else if (s.appStatus === 'Pass') statusHtml = `<span class="status-badge" style="background:#d1fae5; color:var(--success);">Pass</span>`;
                    else if (s.appStatus === 'Fail') statusHtml = `<span class="status-badge" style="background:#fee2e2; color:var(--danger);">Fail</span>`;
                    
                    tr.innerHTML = `
                        <td style="color: var(--success); font-weight:600;">${s.encodedCode}</td>
                        <td>${s.isNumber || '-'}</td>
                        <td>${s.assignedTo || '-'}</td>
                        <td><strong>${s.priorityLevel || '-'}</strong></td>
                        <td>${s.receivedOn || '-'}</td>
                        <td>${statusHtml}</td>
                    `;
                    freshTbody.appendChild(tr);
                });
            }

            dupTbody.innerHTML = '';
            if (!data.duplicates || data.duplicates.length === 0) {
                dupTbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);">No duplicates were blocked.</td></tr>';
            } else {
                data.duplicates.forEach(s => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td style="color: var(--danger); font-weight:600;">${s.encodedCode}</td>
                        <td>${s.assignedTo || '-'}</td>
                        <td>${s.isReallotted ? '✅ Yes' : '❌ No'}</td>
                        <td>${s.previousTP || '-'}</td>
                    `;
                    dupTbody.appendChild(tr);
                });
            }
        }
    } catch(e) {
        freshTbody.innerHTML = '<tr><td colspan="6" style="color:var(--danger);">Error loading details.</td></tr>';
        dupTbody.innerHTML = '<tr><td colspan="4" style="color:var(--danger);">Error loading details.</td></tr>';
    }
}

function closeBatchDetailsModal() {
    document.getElementById('batch-details-modal').classList.remove('active');
}

// Fetch and Render Data
async function fetchSamples() {
    if (!currentUser) return;
    try {
        const res = await fetch(`/api/samples/${currentUser.username}?role=${currentUser.role}`);
        const data = await res.json();
        if (res.ok) {
            allSamples = data.samples;
            populateFilterDropdowns();
            renderTable();
            populateSampleCodeDatalist();
            if (typeof renderAnalytics === 'function') renderAnalytics();
        }
    } catch (e) { console.error(e); }
}

let workloadChartInstance = null;
let slaChartInstance = null;
let isVolumeChartInstance = null;

function renderAnalytics() {
    if (typeof Chart === 'undefined') return; // Wait until Chart.js loads

    // Extract pending/active samples
    const pendingSamples = allSamples.filter(s => s.appStatus === 'Pending' || s.appStatus === 'PendingAccount');

    // 1. Workload Distribution (Samples per TP)
    const tpCounts = {};
    pendingSamples.forEach(s => {
        const tp = s.assignedTo || 'Unassigned';
        tpCounts[tp] = (tpCounts[tp] || 0) + 1;
    });
    const tpLabels = Object.keys(tpCounts);
    const tpData = Object.values(tpCounts);

    const workloadCtx = document.getElementById('workloadChart');
    if (workloadCtx) {
        if (workloadChartInstance) workloadChartInstance.destroy();
        workloadChartInstance = new Chart(workloadCtx, {
            type: 'bar',
            data: {
                labels: tpLabels,
                datasets: [{
                    label: 'Pending Samples',
                    data: tpData,
                    backgroundColor: 'rgba(56, 189, 248, 0.6)',
                    borderColor: 'rgba(56, 189, 248, 1)',
                    borderWidth: 1,
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: { y: { beginAtZero: true, ticks: { color: '#ccc' }, grid: { color: 'rgba(255,255,255,0.1)' } }, x: { ticks: { color: '#ccc' }, grid: { display: false } } },
                plugins: { legend: { display: false } }
            }
        });
    }

    // 2. SLA Compliance (Days Pending)
    let fresh = 0, warning = 0, critical = 0;
    pendingSamples.forEach(s => {
        const daysOld = calculateDaysOld(s.forwardedOn || s.receivedOn);
        if (daysOld <= 7) fresh++;
        else if (daysOld <= 15) warning++;
        else critical++;
    });

    const slaCtx = document.getElementById('slaChart');
    if (slaCtx) {
        if (slaChartInstance) slaChartInstance.destroy();
        slaChartInstance = new Chart(slaCtx, {
            type: 'doughnut',
            data: {
                labels: ['< 7 Days', '8-15 Days', '> 15 Days (Critical)'],
                datasets: [{
                    data: [fresh, warning, critical],
                    backgroundColor: ['#10b981', '#f59e0b', '#ef4444'],
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { position: 'bottom', labels: { color: '#ccc' } } }
            }
        });
    }

    // 3. IS Volume Breakdown
    const isCounts = {};
    pendingSamples.forEach(s => {
        if (s.isNumber) {
            isCounts[s.isNumber] = (isCounts[s.isNumber] || 0) + 1;
        }
    });
    
    // Sort by volume descending
    const sortedIS = Object.keys(isCounts).sort((a,b) => isCounts[b] - isCounts[a]);
    const topIS = sortedIS.slice(0, 10); // Show top 10
    const topISData = topIS.map(is => isCounts[is]);

    const isCtx = document.getElementById('isVolumeChart');
    if (isCtx) {
        if (isVolumeChartInstance) isVolumeChartInstance.destroy();
        isVolumeChartInstance = new Chart(isCtx, {
            type: 'bar',
            data: {
                labels: topIS,
                datasets: [{
                    label: 'Sample Count',
                    data: topISData,
                    backgroundColor: 'rgba(167, 139, 250, 0.6)',
                    borderColor: 'rgba(167, 139, 250, 1)',
                    borderWidth: 1,
                    borderRadius: 4
                }]
            },
            options: {
                indexAxis: 'y', // horizontal bar chart
                responsive: true,
                maintainAspectRatio: false,
                scales: { x: { beginAtZero: true, ticks: { color: '#ccc' }, grid: { color: 'rgba(255,255,255,0.1)' } }, y: { ticks: { color: '#ccc' }, grid: { display: false } } },
                plugins: { legend: { display: false } }
            }
        });
    }
}

function populateSampleCodeDatalist() {
    const datalist = document.getElementById('sample-codes-list');
    if (!datalist) return;
    datalist.innerHTML = '';
    const uniqueCodes = [...new Set(allSamples.map(s => s.encodedCode).filter(Boolean))].sort();
    uniqueCodes.forEach(code => {
        const option = document.createElement('option');
        option.value = code;
        datalist.appendChild(option);
    });
}

function autoFillLimsDetails() {
    const codeInput = document.getElementById('lims-sample-code').value;
    if (!codeInput) return;
    
    const matchedSample = allSamples.find(s => s.encodedCode === codeInput);
    if (matchedSample && matchedSample.isNumber) {
        document.getElementById('lims-is-no').value = `IS ${matchedSample.isNumber}`;
        // Note: Size is not stored in DB, so user still selects size manually
    }
}

function parseDateDDMMYYYY(dateStr) {
    if (!dateStr) return null;
    const parts = dateStr.split('-');
    if (parts.length === 3) {
        return new Date(`${parts[2]}-${parts[1]}-${parts[0]}T00:00:00`);
    }
    return null;
}

function populateFilterDropdowns() {
    // 1. IS Number Filter
    const isFilter = document.getElementById('is-filter');
    if (isFilter) {
        const isCounts = {};
        allSamples.forEach(s => {
            if (s.isNumber && s.appStatus === 'Pending') {
                isCounts[s.isNumber] = (isCounts[s.isNumber] || 0) + 1;
            }
        });
        const uniqueIS = Object.keys(isCounts).sort();
        const currentVal = isFilter.value;
        isFilter.innerHTML = '<option value="ALL">All IS Numbers</option>';
        uniqueIS.forEach(isNum => {
            const opt = document.createElement('option');
            opt.value = isNum;
            opt.textContent = `${isNum} (${isCounts[isNum]})`;
            isFilter.appendChild(opt);
        });
        if (uniqueIS.includes(currentVal)) isFilter.value = currentVal;
    }

    // 2. Received Date Filter
    const dateFilter = document.getElementById('date-filter');
    if (dateFilter) {
        const uniqueDates = [...new Set(allSamples.map(s => s.receivedOn).filter(Boolean))].sort((a,b) => {
            const dateA = parseDateDDMMYYYY(a);
            const dateB = parseDateDDMMYYYY(b);
            if (!dateA) return 1;
            if (!dateB) return -1;
            return dateA - dateB;
        });
        const currentVal = dateFilter.value;
        dateFilter.innerHTML = '<option value="ALL">All Received Dates</option>';
        uniqueDates.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d;
            opt.textContent = d;
            dateFilter.appendChild(opt);
        });
        if (uniqueDates.includes(currentVal)) dateFilter.value = currentVal;
    }

    // 3. Assigned To Filter (Pending samples only — submitted have their own section)
    const assignedFilter = document.getElementById('assigned-filter');
    if (assignedFilter) {
        const assignedCounts = {};
        allSamples.forEach(s => {
            if (s.assignedTo && s.appStatus === 'Pending') {
                assignedCounts[s.assignedTo] = (assignedCounts[s.assignedTo] || 0) + 1;
            }
        });
        const uniqueAssigned = Object.keys(assignedCounts).sort();
        const currentVal = assignedFilter.value;
        assignedFilter.innerHTML = '<option value="ALL">All Testing Persons</option>';
        uniqueAssigned.forEach(tp => {
            const opt = document.createElement('option');
            opt.value = tp;
            opt.textContent = `${tp} (${assignedCounts[tp]})`;
            assignedFilter.appendChild(opt);
        });
        if (uniqueAssigned.includes(currentVal)) assignedFilter.value = currentVal;
    }
}

function calculateDaysOld(dateStr) {
    const targetDate = parseDateDDMMYYYY(dateStr);
    if (!targetDate) return 0;
    const now = new Date();
    const diffTime = Math.abs(now - targetDate);
    return Math.floor(diffTime / (1000 * 60 * 60 * 24));
}

// Support encoded codes ending in 'p' automatically as Priority
function isTopPriority(sample) {
    const p = (sample.priorityLevel || '').toLowerCase();
    return p === 'priority' || p === 'top priority';
}

function toggleKpiFilter(filterName) {
    if (kpiFilter === filterName) {
        kpiFilter = "ALL";
    } else {
        kpiFilter = filterName;
    }
    renderTable();
}

function toggleSubmittedSection() {
    const section = document.getElementById('submitted-section');
    const icon = document.getElementById('submitted-toggle-icon');
    if (!section) return;
    const isHidden = section.style.display === 'none';
    section.style.display = isHidden ? 'block' : 'none';
    if (icon) icon.textContent = isHidden ? '▲ Hide' : '▼ Show';
}

function renderTable() {
    const tbody = document.getElementById('table-body');
    tbody.innerHTML = '';

    const selectAllCheckbox = document.getElementById('select-all-checkbox');
    if (selectAllCheckbox) selectAllCheckbox.checked = false;
    updateSelectedCount();

    const selectAllCheckboxDisposal = document.getElementById('select-all-checkbox-disposal');
    if (selectAllCheckboxDisposal) selectAllCheckboxDisposal.checked = false;
    updateSelectedCountDisposal();

    const searchTerm = document.getElementById('search-input').value.toLowerCase();
    const isFilterVal = document.getElementById('is-filter') ? document.getElementById('is-filter').value : 'ALL';
    const priorityFilter = document.getElementById('priority-filter') ? document.getElementById('priority-filter').value : 'ALL';
    const dateFilter = document.getElementById('date-filter') ? document.getElementById('date-filter').value : 'ALL';
    const assignedFilterVal = document.getElementById('assigned-filter') ? document.getElementById('assigned-filter').value : 'ALL';

    document.getElementById('kpi-card-total').classList.toggle('active-filter', kpiFilter === 'ALL');
    document.getElementById('kpi-card-priority').classList.toggle('active-filter', kpiFilter === 'Priority');
    document.getElementById('kpi-card-urgent').classList.toggle('active-filter', kpiFilter === 'Urgent');
    document.getElementById('kpi-card-submitted').classList.toggle('active-filter', kpiFilter === 'Submitted');
    if(document.getElementById('kpi-card-unassigned')) {
        document.getElementById('kpi-card-unassigned').classList.toggle('active-filter', kpiFilter === 'Unassigned');
    }

    // Enhance all samples with computed fields
    const enhanced = allSamples.map(s => ({
        ...s,
        _daysOld: calculateDaysOld(s.forwardedOn),
        _isTopPriority: isTopPriority(s)
    }));

    // --- Update KPI counters ---
    const pendingAll = enhanced.filter(s => (s.appStatus === 'Pending' || s.appStatus === 'PendingAccount') && s.assignedTo);
    const unassignedAll = enhanced.filter(s => s.appStatus === 'Pending' && !s.assignedTo);
    const submittedAll = enhanced.filter(s => s.appStatus === 'Submitted');
    
    document.getElementById('kpi-total').textContent = pendingAll.length;
    document.getElementById('kpi-p-suffix').textContent = pendingAll.filter(s => s._isTopPriority).length;
    document.getElementById('kpi-urgent').textContent = pendingAll.filter(s => !s._isTopPriority && s._daysOld > 15).length;
    document.getElementById('kpi-submitted').textContent = submittedAll.length;
    
    const unassignedCard = document.getElementById('kpi-card-unassigned');
    if(unassignedCard) {
        if(unassignedAll.length > 0) {
            unassignedCard.style.display = 'block';
            document.getElementById('kpi-unassigned').textContent = unassignedAll.length;
        } else {
            unassignedCard.style.display = 'none';
        }
    }

    // Update badges
    const pendingBadge = document.getElementById('pending-count-badge');
    if (pendingBadge) pendingBadge.textContent = pendingAll.length;
    const submittedBadge = document.getElementById('submitted-count-badge');
    if (submittedBadge) submittedBadge.textContent = submittedAll.length;

    // --- Pending Queue: apply filters ---
    let pending = pendingAll.filter(s => {
        if (isFilterVal !== 'ALL' && s.isNumber !== isFilterVal) return false;
        if (priorityFilter !== 'ALL') {
            if (priorityFilter === 'Priority' && !s._isTopPriority) return false;
            if (priorityFilter === 'Non-Priority' && s._isTopPriority) return false;
        }
        if (dateFilter !== 'ALL' && s.receivedOn !== dateFilter) return false;
        if (assignedFilterVal !== 'ALL' && s.assignedTo !== assignedFilterVal) return false;
        const searchStr = `${s.encodedCode} ${s.isNumber} ${s.assignedTo}`.toLowerCase();
        if (searchTerm && !searchStr.includes(searchTerm)) return false;
        return true;
    });

    // Apply KPI filter to pending queue
    if (kpiFilter === 'Priority') {
        pending = pending.filter(s => s._isTopPriority);
    } else if (kpiFilter === 'Urgent') {
        pending = pending.filter(s => !s._isTopPriority && s._daysOld > 15);
    } else if (kpiFilter === 'Submitted') {
        pending = []; // show only submitted section when Submitted KPI clicked
    } else if (kpiFilter === 'Unassigned') {
        // Special case: show only unassigned samples
        pending = unassignedAll.filter(s => {
            const searchStr = `${s.encodedCode} ${s.isNumber}`.toLowerCase();
            if (searchTerm && !searchStr.includes(searchTerm)) return false;
            return true;
        });
    }

    // Sort: Priority first, then urgency (days old)
    pending.sort((a, b) => {
        if (a._isTopPriority && !b._isTopPriority) return -1;
        if (!a._isTopPriority && b._isTopPriority) return 1;
        return b._daysOld - a._daysOld;
    });

    // Render pending rows
    if (pending.length === 0 && kpiFilter !== 'Submitted') {
        tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:30px; color:var(--text-muted);">🎉 No pending samples match the current filters.</td></tr>`;
    } else if (kpiFilter === 'Submitted') {
        tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:30px; color:var(--text-muted);">Viewing Disposal Cycle — submitted samples are shown below.</td></tr>`;
    } else {
        const isAdmin = currentUser && currentUser.role === 'admin';
        pending.forEach(s => {
            const tr = document.createElement('tr');
            if (s._daysOld > 15) tr.classList.add('row-danger-red');
            else if (s._daysOld > 7) tr.classList.add('row-warning-yellow');

            let flagsHtml = `<strong>${s.priorityLevel || 'Standard'}</strong><br>`;
            if (s._isTopPriority) flagsHtml += '<span class="badge-top-priority">Priority</span><br>';
            if (s._daysOld > 15) flagsHtml += '<span class="badge-fifo">SLA: >15 Days</span>';

            const checkboxTd = isAdmin ? `<td style="text-align:center;"><input type="checkbox" class="sample-row-checkbox" value="${s.id}" onchange="updateSelectedCount()" style="cursor:pointer; width:16px; height:16px;"></td>` : '';
            const deleteBtn = isAdmin ? `<button onclick="deleteSingleSample(${s.id}, '${s.encodedCode}')" style="background:var(--danger); margin-left:5px; padding:6px 12px; font-size:0.85rem;">Delete</button>` : '';

            let statusBadge = '<span class="status-badge status-pending">In Queue</span>';
            if (s.appStatus === 'PendingAccount') {
                statusBadge = '<span class="status-badge" style="background:#fef3c7; color:#d97706; border:1px solid #fbbf24;">Pending Account</span>';
            }

            tr.innerHTML = `
                ${checkboxTd}
                <td>${flagsHtml}</td>
                <td style="color:var(--accent); font-weight:600;">${s.encodedCode}</td>
                <td style="color:var(--text-muted);">${s.isNumber || '—'}</td>
                <td>${s.forwardedOn || '—'}</td>
                <td>${s.quantity || '—'}</td>
                <td>${s.receivedOn || '—'}</td>
                <td><strong>${s.assignedTo || '—'}</strong></td>
                <td>${statusBadge}</td>
                <td>
                    <button onclick="openSubmitModal(${s.id}, '${s.encodedCode}')">Submit</button>
                    ${deleteBtn}
                </td>
            `;
            tbody.appendChild(tr);
        });
    }

    // --- Submitted Section ---
    // Only show when "In Disposal Cycle" KPI is active
    const submittedWrapper = document.getElementById('submitted-wrapper');
    const submittedTbody = document.getElementById('submitted-table-body');
    if (!submittedTbody) return;
    submittedTbody.innerHTML = '';

    if (kpiFilter === 'Submitted') {
        if (submittedWrapper) submittedWrapper.style.display = 'block';
    } else {
        if (submittedWrapper) submittedWrapper.style.display = 'none';
        return; // nothing more to render
    }

    if (submittedAll.length === 0) {
        submittedTbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px; color:var(--text-muted);">No submitted samples yet.</td></tr>';
        return;
    }

    const isAdmin = currentUser && currentUser.role === 'admin';
    submittedAll.forEach(s => {
        const tr = document.createElement('tr');
        const passFailClass = s.passFail === 'Pass' ? 'status-submitted' : 'status-retained';

        let disposalHtml = '—';
        if (s.disposalDate) {
            const now = new Date();
            const dispDate = new Date(s.disposalDate);
            const daysLeft = Math.ceil((dispDate - now) / (1000 * 60 * 60 * 24));
            if (daysLeft > 0) {
                disposalHtml = `<span class="badge-countdown" style="background:rgba(245,158,11,0.15); color:#b06000; border:1px solid rgba(245,158,11,0.3);">⏳ ${daysLeft} Days Retained</span>`;
            } else {
                disposalHtml = `<span class="badge-countdown" style="background:rgba(16,185,129,0.15); color:#137333; border:1px solid rgba(16,185,129,0.3);">✅ Safe to Dispose</span>`;
            }
        }

        const checkboxTd = isAdmin ? `<td style="text-align:center;"><input type="checkbox" class="sample-row-checkbox-disposal" value="${s.id}" onchange="updateSelectedCountDisposal()" style="cursor:pointer; width:16px; height:16px;"></td>` : '';

        tr.innerHTML = `
            ${checkboxTd}
            <td style="color:var(--accent); font-weight:600;">${s.encodedCode}</td>
            <td style="color:var(--text-muted);">${s.isNumber || '—'}</td>
            <td><strong>${s.assignedTo || '—'}</strong></td>
            <td>${s.forwardedOn || '—'}</td>
            <td><span class="status-badge ${passFailClass}">${s.passFail}</span></td>
            <td>${disposalHtml}</td>
        `;
        tr.classList.add(s.passFail === 'Pass' ? 'row-success-green' : 'row-warning-yellow');
        submittedTbody.appendChild(tr);
    });
}

// Submit Modal Functions
function openSubmitModal(id, code) {
    currentSubmitId = id;
    document.getElementById('modal-sno').textContent = `${code}`;
    document.getElementById('submit-modal').classList.add('active');
}

function closeModal() {
    document.getElementById('submit-modal').classList.remove('active');
    currentSubmitId = null;
}

async function confirmSubmit() {
    if (!currentSubmitId) return;
    const passFail = document.getElementById('pass-fail-select').value;
    
    try {
        const res = await fetch('/api/submit-sample', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: currentSubmitId, passFail })
        });
        if (res.ok) {
            closeModal();
            showToast('Test results submitted successfully.', 'success');
            fetchSamples();
        } else {
            showToast('Error submitting sample', 'error');
        }
    } catch(e) {
        console.error(e);
        showToast('Network error while submitting.', 'error');
    }
}

function initializeDragAndDrop() {
    const dropZone = document.getElementById('drag-drop-zone');
    const fileInput = document.getElementById('excel-file');
    if (!dropZone || !fileInput) return;

    // Prevent default browser drag behavior on the zone
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, e => { e.preventDefault(); e.stopPropagation(); }, false);
    });

    // Visual feedback on drag-over
    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
    });
    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
    });

    // Handle dropped files
    dropZone.addEventListener('drop', (e) => {
        const files = e.dataTransfer.files;
        if (files.length) {
            // DataTransfer files can't be assigned directly to input.files in all browsers
            // So we manually call handleFileSelect with the dropped file
            handleFileSelect(files[0]);
        }
    }, false);

    // Handle browsed files (input is now full-coverage via CSS, no onclick needed)
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length) {
            handleFileSelect(e.target.files[0]);
        }
    });
}

function handleFileSelect(file) {
    selectedUploadFile = file;
    const info = document.getElementById('file-info');
    if (file && info) {
        info.style.display = 'block';
        info.innerHTML = `📎 <strong>Ready to analyze:</strong> ${file.name}`;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initializeDragAndDrop();
    toggleAdminViews();
    checkActiveLimsOnLoad();
});

// --- Admin Utilities & Bulk Actions ---

function toggleAdminViews() {
    const isAdmin = currentUser && currentUser.role === 'admin';
    
    // Toggle Select All columns in headers
    const selectAllHeader = document.getElementById('select-all-header');
    if (selectAllHeader) selectAllHeader.style.display = isAdmin ? 'table-cell' : 'none';
    
    const selectAllHeaderDisposal = document.getElementById('select-all-header-disposal');
    if (selectAllHeaderDisposal) selectAllHeaderDisposal.style.display = isAdmin ? 'table-cell' : 'none';
    
    // Toggle bulk actions bar
    const bulkActions = document.getElementById('admin-bulk-actions');
    if (bulkActions) bulkActions.style.display = isAdmin ? 'flex' : 'none';
    
    const bulkActionsDisposal = document.getElementById('admin-bulk-actions-disposal');
    if (bulkActionsDisposal) bulkActionsDisposal.style.display = isAdmin ? 'flex' : 'none';

    // Toggle specific admin tab buttons in tabs bar
    const uploadBtn = document.getElementById('tab-btn-upload');
    if (uploadBtn) uploadBtn.style.display = isAdmin ? 'inline-block' : 'none';

    const auditBtn = document.getElementById('tab-btn-audit');
    if (auditBtn) auditBtn.style.display = isAdmin ? 'inline-block' : 'none';
}

function toggleSelectAllSamples(masterCheckbox) {
    const checkValue = masterCheckbox.checked;
    const checkboxes = document.querySelectorAll('.sample-row-checkbox');
    checkboxes.forEach(cb => {
        cb.checked = checkValue;
    });
    updateSelectedCount();
}

function toggleSelectAllSamplesDisposal(masterCheckbox) {
    const checkValue = masterCheckbox.checked;
    const checkboxes = document.querySelectorAll('.sample-row-checkbox-disposal');
    checkboxes.forEach(cb => {
        cb.checked = checkValue;
    });
    updateSelectedCountDisposal();
}

function updateSelectedCount() {
    const checkboxes = document.querySelectorAll('.sample-row-checkbox:checked');
    const totalCount = document.querySelectorAll('.sample-row-checkbox').length;
    const selectAllCheckbox = document.getElementById('select-all-checkbox');
    
    if (selectAllCheckbox) {
        selectAllCheckbox.checked = (checkboxes.length === totalCount && totalCount > 0);
    }
    
    const countLabel = document.getElementById('selected-count-label');
    if (countLabel) {
        countLabel.textContent = `${checkboxes.length} Selected`;
    }
    
    const deleteBtn = document.getElementById('bulk-delete-btn');
    if (deleteBtn) {
        deleteBtn.disabled = (checkboxes.length === 0);
    }
}

function updateSelectedCountDisposal() {
    const checkboxes = document.querySelectorAll('.sample-row-checkbox-disposal:checked');
    const totalCount = document.querySelectorAll('.sample-row-checkbox-disposal').length;
    const selectAllCheckbox = document.getElementById('select-all-checkbox-disposal');
    
    if (selectAllCheckbox) {
        selectAllCheckbox.checked = (checkboxes.length === totalCount && totalCount > 0);
    }
    
    const countLabel = document.getElementById('selected-count-label-disposal');
    if (countLabel) {
        countLabel.textContent = `${checkboxes.length} Selected`;
    }
    
    const deleteBtn = document.getElementById('bulk-delete-btn-disposal');
    if (deleteBtn) {
        deleteBtn.disabled = (checkboxes.length === 0);
    }
}

async function deleteSelectedSamples() {
    const checkboxes = document.querySelectorAll('.sample-row-checkbox:checked');
    if (checkboxes.length === 0) return;
    
    const ids = Array.from(checkboxes).map(cb => parseInt(cb.value));
    
    const confirmMessage = `Are you sure you want to permanently delete the ${ids.length} selected pending sample(s)?`;
    if (!confirm(confirmMessage)) return;
    
    try {
        const res = await fetch('/api/admin/delete-samples-bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids })
        });
        const data = await res.json();
        if (res.ok) {
            showToast(data.message, 'success');
            fetchSamples();
        } else {
            showToast(data.error || 'Failed to delete selected samples.', 'error');
        }
    } catch (e) {
        console.error(e);
        showToast('Network error while deleting.', 'error');
    }
}

async function deleteSelectedSamplesDisposal() {
    const checkboxes = document.querySelectorAll('.sample-row-checkbox-disposal:checked');
    if (checkboxes.length === 0) return;
    
    const ids = Array.from(checkboxes).map(cb => parseInt(cb.value));
    
    const confirmMessage = `Are you sure you want to permanently delete the ${ids.length} selected submitted sample(s)?`;
    if (!confirm(confirmMessage)) return;
    
    try {
        const res = await fetch('/api/admin/delete-samples-bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids })
        });
        const data = await res.json();
        if (res.ok) {
            showToast(data.message, 'success');
            fetchSamples();
        } else {
            showToast(data.error || 'Failed to delete selected samples.', 'error');
        }
    } catch (e) {
        console.error(e);
        showToast('Network error while deleting.', 'error');
    }
}

async function deleteSingleSample(id, code) {
    if (!confirm(`Are you sure you want to permanently delete sample "${code}"?`)) return;
    
    try {
        const res = await fetch(`/api/samples/${id}`, {
            method: 'DELETE'
        });
        const data = await res.json();
        if (res.ok) {
            showToast(data.message, 'success');
            fetchSamples();
        } else {
            showToast(data.error || 'Failed to delete sample.', 'error');
        }
    } catch (e) {
        console.error(e);
        showToast('Network error while deleting.', 'error');
    }
}

async function resetDatabase() {
    const confirm1 = confirm("🚨 DANGER ALERT!\n\nAre you absolutely sure you want to delete ALL data from the database?\nThis will permanently delete all samples, upload histories, and Testing Person accounts.\nThis action is irreversible!");
    if (!confirm1) return;
    
    const confirm2 = confirm("🚨 FINAL WARNING!\n\nThis is your last chance to cancel. All system data (except the main Admin account) will be lost.\n\nType OK or click OK to proceed.");
    if (!confirm2) return;
    
    try {
        const res = await fetch('/api/admin/reset-database', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                role: currentUser ? currentUser.role : '',
                username: currentUser ? currentUser.username : ''
            })
        });
        const data = await res.json();
        if (res.ok) {
            showToast('Database reset completely. Workspace is clean.', 'success');
            // Log out the admin since all session related records are cleared
            logout();
        } else {
            showToast(data.error || 'Failed to reset database.', 'error');
        }
    } catch (e) {
        console.error(e);
        showToast('Network error while resetting database.', 'error');
    }
}

// --- LIMS Automation Controls ---

function renderTestParametersTable() {
    const sizeSelect = document.getElementById('lims-size-select');
    const classSelect = document.getElementById('lims-class-select');
    const typeSelect = document.getElementById('lims-type-select');
    const tbody = document.getElementById('lims-parameters-tbody');
    if (!sizeSelect || !classSelect || !typeSelect || !tbody) return;

    if (typeof IS_4985_SPECS === 'undefined') {
        tbody.innerHTML = '<tr><td colspan="5">Error: specs_db.js not loaded.</td></tr>';
        return;
    }

    const size = sizeSelect.value;
    const pipeClass = classSelect.value;
    const pipeType = typeSelect.value;
    const isPlumbingSelect = document.getElementById('lims-plumbing-select');
    const isPlumbing = isPlumbingSelect ? isPlumbingSelect.value : 'No';

    // Extract dirty values before overwriting
    let dirtyValues = {};
    if (tbody) {
        const currentInputs = tbody.querySelectorAll('.lims-param-input');
        currentInputs.forEach(input => {
            if (input.getAttribute('data-dirty') === 'true') {
                const paramName = input.closest('tr').cells[1].innerText.trim();
                dirtyValues[paramName] = input.value;
            }
        });
    }

    const rows = IS_4985_SPECS.generateTestParameters(size, pipeClass, pipeType, isPlumbing);

    tbody.innerHTML = '';
    rows.forEach((row, idx) => {
        const tr = document.createElement('tr');

        let inputHtml = '';
        let valToUse = dirtyValues[row.param] !== undefined ? dirtyValues[row.param] : (row.expected || '');
        let dirtyAttr = dirtyValues[row.param] !== undefined ? 'data-dirty="true"' : '';

        if (row.type === 'Qualitative') {
            let optionsHtml = '';
            let allOpts = [];
            if (row.expected) allOpts.push(row.expected);
            if (row.options) {
                row.options.forEach(o => { if (!allOpts.includes(o)) allOpts.push(o); });
            }
            ["Unsatisfactory", "Fail", "Not Done", "NA"].forEach(o => { if (!allOpts.includes(o)) allOpts.push(o); });
            if (valToUse && !allOpts.includes(valToUse)) allOpts.unshift(valToUse);

            allOpts.forEach(opt => {
                let sel = (opt === valToUse) ? 'selected' : '';
                optionsHtml += `<option value="${opt}" ${sel}>${opt}</option>`;
            });

            inputHtml = `
                <select class="lims-param-input" data-idx="${idx}" data-min="" data-max="" onchange="validateObservation(this)" ${dirtyAttr} style="width: 100%; border-radius: 4px; padding: 6px; background: rgba(0,0,0,0.3); border: 1px solid var(--glass-border); color: white;">
                    ${optionsHtml}
                </select>
            `;
        } else if (row.type === 'Text') {
            let customOpts = '';
            if (row.options) {
                row.options.forEach(opt => {
                    customOpts += `<option value="${opt}">`;
                });
            }
            let valAttr = valToUse ? `value="${valToUse}"` : '';
            inputHtml = `
                <input type="text" list="datalist-${idx}" ${valAttr} class="lims-param-input" data-idx="${idx}" data-min="${row.min}" data-max="${row.max}" oninput="validateObservation(this)" onclick="try{this.showPicker()}catch(e){}" ${dirtyAttr} style="width: 100%; border-radius: 4px; padding: 6px; background: rgba(0,0,0,0.3); border: 1px solid var(--glass-border); color: white;" placeholder="Type value or pick option">
                <datalist id="datalist-${idx}">
                    ${customOpts}
                </datalist>
            `;
        } else {
            let valAttr = valToUse ? `value="${valToUse}"` : '';
            inputHtml = `<input type="number" step="0.01" ${valAttr} class="lims-param-input" data-idx="${idx}" data-min="${row.min}" data-max="${row.max}" oninput="validateObservation(this)" ${dirtyAttr} style="width: 100%; border-radius: 4px; padding: 6px; background: rgba(0,0,0,0.3); border: 1px solid var(--glass-border); color: white;" placeholder="Enter value">`;
        }

        tr.innerHTML = `
            <td style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.05);">${row.clause}</td>
            <td style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.05);">${row.param}</td>
            <td style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.05); font-weight: 600; color: #61afef;">${row.spec_val}</td>
            <td style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.05);">${row.type}</td>
            <td style="padding: 10px; border-bottom: 1px solid rgba(255,255,255,0.05);">${inputHtml}</td>
        `;
        tbody.appendChild(tr);
    });

    // Re-validate dirty inputs to restore their border colors and dependencies
    setTimeout(() => {
        const inputs = tbody.querySelectorAll('.lims-param-input');
        inputs.forEach(input => {
            if (input.getAttribute('data-dirty') === 'true') {
                validateObservation(input);
            }
        });
    }, 0);

    // ── Keyboard Navigation: Enter / ArrowDown = next row, ArrowUp = previous row ──
    const allInputs = Array.from(tbody.querySelectorAll('.lims-param-input'));
    allInputs.forEach((el, i) => {
        el.addEventListener('keydown', (e) => {
            const goNext = e.key === 'Enter' || e.key === 'ArrowDown';
            const goPrev = e.key === 'ArrowUp';
            if (!goNext && !goPrev) return;
            e.preventDefault();
            const target = goNext ? allInputs[i + 1] : allInputs[i - 1];
            if (!target) return;
            // Scroll target row into view smoothly
            target.closest('tr').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            target.focus();
            // For number inputs, select all text so overtyping is easy
            if (target.tagName.toLowerCase() === 'input') {
                target.select();
            }
        });
    });

    // ── Restore saved LIMS credentials from localStorage ──
    const savedUser = localStorage.getItem('lims_saved_username');
    const savedPass = localStorage.getItem('lims_saved_password');
    const userEl = document.getElementById('lims-username-input');
    const passEl = document.getElementById('lims-password-input');
    if (savedUser && userEl && !userEl.value) userEl.value = savedUser;
    if (savedPass && passEl && !passEl.value) passEl.value = savedPass;
}

function validateObservation(inputEl) {
    inputEl.setAttribute('data-dirty', 'true');
    const min = inputEl.getAttribute('data-min');
    const max = inputEl.getAttribute('data-max');
    const val = inputEl.value;

    inputEl.style.boxShadow = 'none';
    inputEl.style.borderColor = 'var(--glass-border)';

    if (val === '') return;

    if (inputEl.tagName.toLowerCase() === 'select') {
        if (val.toLowerCase().includes('unsatisfactory') || val.toLowerCase().includes('fail')) {
            inputEl.style.boxShadow = '0 0 5px #e06c75';
            inputEl.style.borderColor = '#e06c75';
        } else {
            inputEl.style.boxShadow = '0 0 5px #98c379';
            inputEl.style.borderColor = '#98c379';
        }
        return;
    }

    const numVal = parseFloat(val);
    let valid = true;
    if (min && numVal < parseFloat(min)) valid = false;
    if (max && numVal > parseFloat(max)) valid = false;

    if (valid) {
        inputEl.style.boxShadow = '0 0 5px #98c379';
        inputEl.style.borderColor = '#98c379';
    } else {
        inputEl.style.boxShadow = '0 0 5px #e06c75';
        inputEl.style.borderColor = '#e06c75';
    }

    // Custom dependency for DIMENSIONS-Socket
    const rowIdx = parseInt(inputEl.getAttribute('data-idx'), 10);
    if (!isNaN(rowIdx)) {
        const tbody = document.getElementById('lims-parameters-tbody');
        if (tbody) {
            const rows = Array.from(tbody.querySelectorAll('tr'));
            let lengthInput = null;
            let socketSelect = null;
            rows.forEach(tr => {
                const paramCell = tr.cells[1];
                if (paramCell) {
                    const paramText = paramCell.innerText;
                    if (paramText.includes("DIMENSIONS-Socket-Sockets for solvent cement jointing-Minimum Length")) {
                        lengthInput = tr.querySelector('.lims-param-input');
                    } else if (paramText === "DIMENSIONS-Socket") {
                        socketSelect = tr.querySelector('.lims-param-input');
                    }
                }
            });
            if (lengthInput && socketSelect && inputEl === lengthInput) {
                if (lengthInput.value === "Socket end not provided") {
                    socketSelect.value = "NA";
                    socketSelect.style.boxShadow = '0 0 5px #98c379';
                    socketSelect.style.borderColor = '#98c379';
                }
            }
        }
    }
}

let limsPollingInterval = null;
let lastLogCount = 0;

async function previewLimsPdf() {
    try {
        const usernameInput = document.getElementById('lims-username-input');
        const passwordInput = document.getElementById('lims-password-input');
        
        // Ensure user hasn't left default Sample Code
        const meta = {
            sampleCode: document.getElementById('lims-sample-code').value || '',
            size: document.getElementById('lims-size-select').value,
            pipeClass: document.getElementById('lims-class-select').value,
            type: document.getElementById('lims-type-select').value,
            isPlumbing: document.getElementById('lims-plumbing-select') ? document.getElementById('lims-plumbing-select').value : 'No'
        };

        if (!meta.sampleCode) {
            showToast('Please enter a Sample Code before previewing.', 'error');
            return;
        }

        // Gather Table Parameters
        const tbody = document.getElementById('lims-parameters-tbody');
        const rows = IS_4985_SPECS.generateTestParameters(meta.size, meta.pipeClass, meta.type, meta.isPlumbing);
        const inputs = tbody.querySelectorAll('.lims-param-input');
        
        let tableData = [];

        inputs.forEach((input, i) => {
            const rowDef = rows[i];
            const val = input.value;
            tableData.push([
                val, // Observed value goes first as expected by script logic
                rowDef.clause,
                rowDef.param,
                rowDef.spec_val,
                val,
                rowDef.type,
                rowDef.min,
                rowDef.max
            ]);
        });

        const payload = {
            lims_user: usernameInput.value || 'preview_user',
            lims_pass: passwordInput.value || 'preview_pass',
            metadata: meta,
            table_rows: tableData
        };

        showToast('Generating PDF Preview...', 'info');
        
        const res = await fetch('/api/lims/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (res.ok) {
            showToast('PDF Preview generated successfully!', 'success');
            const blob = await res.blob();
            const pdfUrl = URL.createObjectURL(blob);
            
            // Open modal and set iframe source
            const modal = document.getElementById('pdf-preview-modal');
            const iframe = document.getElementById('pdf-iframe');
            if (modal && iframe) {
                iframe.src = pdfUrl;
                modal.classList.add('active');
                
                // Configure download button
                const btnDownload = document.getElementById('btn-download-pdf');
                btnDownload.onclick = () => {
                    const a = document.createElement('a');
                    a.href = pdfUrl;
                    a.download = `Report_${meta.sampleCode}.pdf`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                };
            }
        } else {
            const data = await res.json();
            showToast(data.error || 'Failed to generate preview.', 'error');
        }
    } catch (globalErr) {
        alert("Error in previewLimsPdf: " + globalErr.message);
        console.error(globalErr);
    }
}

function closePdfModal() {
    const modal = document.getElementById('pdf-preview-modal');
    const iframe = document.getElementById('pdf-iframe');
    if (modal) modal.classList.remove('active');
    if (iframe) iframe.src = '';
}

async function startLimsAutomation() {
    try {
        const usernameInput = document.getElementById('lims-username-input');
        const passwordInput = document.getElementById('lims-password-input');
        
        if (!usernameInput.value || !passwordInput.value) {
            showToast('Please enter your LIMS Username and Password.', 'error');
            return;
        }

        // Gather Metadata
        const meta = {
            sampleCode: document.getElementById('lims-sample-code').value,
            isNo: document.getElementById('lims-is-no').value,
            size: document.getElementById('lims-size-select').value,
            pipeClass: document.getElementById('lims-class-select').value,
            type: document.getElementById('lims-type-select').value,
            isPlumbing: document.getElementById('lims-plumbing-select') ? document.getElementById('lims-plumbing-select').value : 'No'
        };

        if (!meta.sampleCode) {
            showToast('Sample Code is required.', 'error');
            return;
        }

        // Gather Table Parameters
        const tbody = document.getElementById('lims-parameters-tbody');
        const rows = IS_4985_SPECS.generateTestParameters(meta.size, meta.pipeClass, meta.type, meta.isPlumbing);
        const inputs = tbody.querySelectorAll('.lims-param-input');
        
        let tableData = [];
        let validationFailed = false;

        inputs.forEach((input, i) => {
            const rowDef = rows[i];
            const val = input.value;
            if (!val) validationFailed = true;

            tableData.push([
                val, // Observed value goes first as expected by script logic
                rowDef.clause,
                rowDef.param,
                rowDef.spec_val,
                val,
                rowDef.type,
                rowDef.min,
                rowDef.max
            ]);
        });

        if (validationFailed) {
            const proceed = confirm("Some test parameters have empty observed values. Are you sure you want to proceed?");
            if (!proceed) return;
        }

        const payload = {
            lims_user: usernameInput.value,
            lims_pass: passwordInput.value,
            metadata: meta,
            table_rows: tableData
        };

        // Save credentials locally so they pre-fill next time
        localStorage.setItem('lims_saved_username', usernameInput.value);
        localStorage.setItem('lims_saved_password', passwordInput.value);

        // Disable Start button, enable Stop button
        const btnStart = document.getElementById('btn-start-lims');
        const btnStop = document.getElementById('btn-stop-lims');
        if (btnStart) btnStart.disabled = true;
        if (btnStop) btnStop.disabled = false;
        
        clearConsole();
        appendConsoleLog('[SYSTEM] Sending local UI payload to backend for automation execution...');
        
        try {
            const res = await fetch('/api/lims/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            
            if (res.ok) {
                showToast(data.message || 'LIMS Automation started!', 'success');
                // Start polling status and logs
                startLimsPolling();
            } else {
                showToast(data.error || 'Failed to start automation.', 'error');
                if (btnStart) btnStart.disabled = false;
                if (btnStop) btnStop.disabled = true;
            }
        } catch (e) {
            console.error(e);
            showToast('Network error while starting LIMS automator.', 'error');
            if (btnStart) btnStart.disabled = false;
            if (btnStop) btnStop.disabled = true;
        }
    } catch (globalErr) {
        alert("Frontend Error in startLimsAutomation: " + globalErr.message + "\n" + globalErr.stack);
        console.error(globalErr);
    }
}

async function stopLimsAutomation() {
    appendConsoleLog('[SYSTEM] Stopping automation process...');
    
    try {
        const res = await fetch('/api/lims/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const data = await res.json();
        
        if (res.ok) {
            showToast(data.message || 'Automation stopped.', 'info');
            stopLimsPolling();
            updateLimsUI('idle');
        } else {
            showToast(data.error || 'Failed to stop automation.', 'error');
        }
    } catch (e) {
        console.error(e);
        showToast('Network error while stopping LIMS automator.', 'error');
    }
}

function startLimsPolling() {
    if (limsPollingInterval) clearInterval(limsPollingInterval);
    // Poll immediately, then every 1500ms
    pollLimsStatusAndLogs();
    limsPollingInterval = setInterval(pollLimsStatusAndLogs, 1500);
}

function stopLimsPolling() {
    if (limsPollingInterval) {
        clearInterval(limsPollingInterval);
        limsPollingInterval = null;
    }
}

async function pollLimsStatusAndLogs() {
    try {
        // Poll status
        const statusRes = await fetch('/api/lims/status');
        const statusData = await statusRes.json();
        const status = statusData.status;
        
        // Poll logs
        const logsRes = await fetch('/api/lims/logs');
        const logsData = await logsRes.json();
        const logs = logsData.logs || [];
        
        updateLimsUI(status);
        
        // Update console logs
        if (logs.length > lastLogCount) {
            const newLogs = logs.slice(lastLogCount);
            newLogs.forEach(line => appendConsoleLog(line));
            lastLogCount = logs.length;
        }
        
        // If system is idle, stop polling
        if (status === 'idle') {
            stopLimsPolling();
            lastLogCount = 0;
            const btnStart = document.getElementById('btn-start-lims');
            const btnStop = document.getElementById('btn-stop-lims');
            if (btnStart) btnStart.disabled = false;
            if (btnStop) btnStop.disabled = true;
        }
    } catch (e) {
        console.error('Error polling LIMS status/logs:', e);
    }
}

function updateLimsUI(status) {
    const badge = document.getElementById('lims-status-badge');
    const textSpan = document.getElementById('lims-status-text');
    const actionBanner = document.getElementById('lims-action-banner');
    
    if (!badge || !textSpan) return;
    
    // Clear old status classes
    badge.className = 'lims-badge';
    
    if (status === 'idle') {
        badge.classList.add('badge-idle');
        textSpan.textContent = 'SYSTEM READY';
        if (actionBanner) actionBanner.style.display = 'none';
    } else if (status === 'running') {
        badge.classList.add('badge-running');
        textSpan.textContent = 'AUTOMATION ACTIVE';
        if (actionBanner) actionBanner.style.display = 'none';
    } else if (status === 'waiting_for_login' || status === 'waiting_for_captcha') {
        badge.classList.add('badge-waiting');
        textSpan.textContent = 'ATTENTION REQUIRED';
        if (actionBanner) actionBanner.style.display = 'block';
    }
}

function clearConsole() {
    const consoleDiv = document.getElementById('lims-console');
    if (consoleDiv) {
        consoleDiv.innerHTML = '';
        lastLogCount = 0;
    }
}

function appendConsoleLog(line) {
    const consoleDiv = document.getElementById('lims-console');
    if (!consoleDiv) return;
    
    const div = document.createElement('div');
    div.className = 'terminal-line';
    
    // Format based on line tags
    if (line.includes('[SYSTEM]')) {
        div.classList.add('system-line');
    } else if (line.includes('[ERROR]')) {
        div.classList.add('error-line');
    } else if (line.includes('[SUCCESS]')) {
        div.classList.add('success-line');
    } else if (line.includes('[WARN]')) {
        div.classList.add('warn-line');
    } else if (line.includes('[AUTOMATION_WAITING')) {
        div.classList.add('waiting-line');
    }
    
    div.textContent = line;
    consoleDiv.appendChild(div);
    
    // Scroll to bottom
    consoleDiv.scrollTop = consoleDiv.scrollHeight;
}

async function checkActiveLimsOnLoad() {
    try {
        const res = await fetch('/api/lims/status');
        const data = await res.json();
        if (data.status && data.status !== 'idle') {
            // LIMS is active on backend, let's set UI buttons and start polling
            const btnStart = document.getElementById('btn-start-lims');
            const btnStop = document.getElementById('btn-stop-lims');
            if (btnStart) btnStart.disabled = true;
            if (btnStop) btnStop.disabled = false;
            
            // Poll for logs and status
            startLimsPolling();
        }
    } catch (e) {
        console.error('Failed to check active LIMS on load:', e);
    }
}

// --- EMPLOYEE HUB & COMPETENCIES ---

async function loadEmployees() {
    const tbody = document.getElementById('employee-tbody');
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Loading...</td></tr>';
    try {
        const res = await fetch('/api/admin/employees');
        const data = await res.json();
        if (res.ok) {
            tbody.innerHTML = '';
            data.employees.forEach(e => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><strong>${e.fullName}</strong><br><span style="font-size:0.8rem;color:var(--text-muted);">${e.designation}</span></td>
                    <td>${e.loginUsername}</td>
                    <td>${e.currentWorkload} / ${e.maxDailySamples}</td>
                    <td>
                        <button onclick="openCompetencyModal(${e.id}, '${e.fullName}')" style="font-size:0.85rem; padding:4px 8px;">IS Skills</button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        }
    } catch (err) {
        console.error(err);
    }
}

async function addEmployee() {
    const fullName = document.getElementById('emp-fullname').value;
    const designation = document.getElementById('emp-designation').value;
    const username = document.getElementById('emp-username').value;
    const password = document.getElementById('emp-password').value;

    if (!fullName || !username || !password) return showToast('Please fill all required fields.', 'warning');

    try {
        const res = await fetch('/api/admin/employees', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fullName, designation, username, password })
        });
        const data = await res.json();
        if (res.ok) {
            showToast(data.message, 'success');
            loadEmployees();
            document.getElementById('emp-fullname').value = '';
            document.getElementById('emp-username').value = '';
            document.getElementById('emp-password').value = '';
        } else {
            showToast(data.error, 'error');
        }
    } catch (err) {
        console.error(err);
    }
}

let currentCompEmpId = null;
function openCompetencyModal(empId, empName) {
    currentCompEmpId = empId;
    document.getElementById('comp-emp-name').textContent = empName;
    document.getElementById('competency-modal').classList.add('active');
    loadCompetencies(empId);
}

function closeCompetencyModal() {
    document.getElementById('competency-modal').classList.remove('active');
    currentCompEmpId = null;
}

async function loadCompetencies(empId) {
    const tbody = document.getElementById('comp-tbody');
    tbody.innerHTML = '<tr><td colspan="2" style="text-align:center;">Loading...</td></tr>';
    try {
        const res = await fetch(`/api/admin/competencies/${empId}`);
        const data = await res.json();
        if (res.ok) {
            tbody.innerHTML = '';
            if (data.competencies.length === 0) {
                tbody.innerHTML = '<tr><td colspan="2" style="text-align:center;color:var(--text-muted);">No IS competencies assigned.</td></tr>';
            }
            data.competencies.forEach(c => {
                const tr = document.createElement('tr');
                tr.innerHTML = `<td>${c.isNumber}</td><td>${c.proficiencyLevel}</td>`;
                tbody.appendChild(tr);
            });
        }
    } catch (err) {
        console.error(err);
    }
}

async function addCompetency() {
    const isNumber = document.getElementById('comp-is-number').value.trim();
    const proficiencyLevel = document.getElementById('comp-proficiency').value || 'Standard';
    if (!isNumber || !currentCompEmpId) return showToast('Please enter an IS number.', 'warning');

    try {
        const res = await fetch('/api/admin/competencies', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ employeeId: currentCompEmpId, isNumber, proficiencyLevel })
        });
        if (res.ok) {
            document.getElementById('comp-is-number').value = '';
            loadCompetencies(currentCompEmpId);
            showToast('Competency added.', 'success');
        }
    } catch (err) {
        console.error(err);
    }
}

// --- LEAVE MANAGER ---

async function populateLeaveEmployeeDropdown() {
    try {
        const res = await fetch('/api/admin/employees');
        const data = await res.json();
        if (res.ok) {
            const select = document.getElementById('leave-employee-select');
            select.innerHTML = '<option value="">-- Select Employee --</option>';
            data.employees.forEach(e => {
                const opt = document.createElement('option');
                opt.value = e.id;
                opt.textContent = e.fullName;
                select.appendChild(opt);
            });
        }
    } catch (err) { console.error(err); }
}

async function loadLeaves() {
    const tbody = document.getElementById('leaves-tbody');
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Loading...</td></tr>';
    try {
        const res = await fetch('/api/admin/leaves');
        const data = await res.json();
        if (res.ok) {
            tbody.innerHTML = '';
            if (data.leaves.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);">No leaves recorded.</td></tr>';
            }
            data.leaves.forEach(l => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><strong>${l.fullName}</strong></td>
                    <td>${l.leaveDate}</td>
                    <td>${l.reason || '-'}</td>
                    <td><button onclick="deleteLeave(${l.id})" style="background:var(--danger); padding:4px 8px; font-size:0.8rem; border:none; border-radius:4px; color:white; cursor:pointer;">Remove</button></td>
                `;
                tbody.appendChild(tr);
            });
        }
    } catch (err) { console.error(err); }
}

async function addLeave() {
    const employeeId = document.getElementById('leave-employee-select').value;
    const leaveDate = document.getElementById('leave-date').value;
    const reason = document.getElementById('leave-reason') ? document.getElementById('leave-reason').value : '';

    if (!employeeId || !leaveDate) return showToast('Select employee and date.', 'warning');

    try {
        const res = await fetch('/api/admin/leaves', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ employeeId, leaveDate, reason })
        });
        if (res.ok) {
            showToast('Leave recorded.', 'success');
            loadLeaves();
        }
    } catch (err) { console.error(err); }
}

async function deleteLeave(id) {
    if (!confirm('Remove this leave?')) return;
    try {
        const res = await fetch(`/api/admin/leaves/${id}`, { method: 'DELETE' });
        if (res.ok) {
            showToast('Leave removed.', 'success');
            loadLeaves();
        }
    } catch (err) { console.error(err); }
}

// --- SMART ASSIGNER ---

async function loadRecommendations() {
    const tbody = document.getElementById('recommendations-tbody');
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Loading...</td></tr>';
    try {
        const res = await fetch('/api/admin/recommendations');
        const data = await res.json();
        if (res.ok) {
            tbody.innerHTML = '';
            if (data.recommendations.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:30px; color:var(--text-muted);">No pending recommendations. Click "Run AI Assigner" to generate.</td></tr>';
            }
            data.recommendations.forEach(r => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><strong>${r.encodedCode}</strong></td>
                    <td>${r.isNumber}</td>
                    <td><span style="color:var(--success); font-weight:600;">${r.recommendedEmployeeName}</span></td>
                    <td>${r.reason} (Score: ${r.score})</td>
                    <td>
                        <button onclick="approveRecommendation(${r.id})" class="primary" style="padding:4px 8px; font-size:0.8rem;">Approve</button>
                        <button onclick="rejectRecommendation(${r.id})" style="background:var(--danger); padding:4px 8px; font-size:0.8rem; margin-left:5px;">Reject</button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        }
    } catch (err) { console.error(err); }
}

async function loadUnassignedPool() {
    const tbody = document.getElementById('unassigned-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Loading...</td></tr>';
    try {
        const res = await fetch('/api/unassigned-samples');
        const data = await res.json();
        if (res.ok) {
            tbody.innerHTML = '';
            if (data.samples.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:30px; color:var(--text-muted);">All samples are assigned.</td></tr>';
            } else {
                let tpOptions = '<option value="">-- Direct Assign --</option>';
                allTPUsers.forEach(u => {
                    tpOptions += `<option value="${u.username}">${u.username}</option>`;
                });
                
                data.samples.forEach(s => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td style="color:var(--accent); font-weight:600;">${s.encodedCode}</td>
                        <td>${s.isNumber || '-'}</td>
                        <td><strong>${s.priorityLevel || '-'}</strong></td>
                        <td>
                            <select onchange="directAssignSample(${s.id}, this.value)" style="padding:4px 8px; border-radius:4px;">
                                ${tpOptions}
                            </select>
                        </td>
                    `;
                    tbody.appendChild(tr);
                });
            }
        }
    } catch (err) { console.error(err); }
}

async function directAssignSample(sampleId, tpName) {
    if (!tpName) return;
    try {
        const res = await fetch('/api/admin/direct-assign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sampleId, assignedTo: tpName })
        });
        if (res.ok) {
            showToast(`Assigned to ${tpName}`, 'success');
            loadUnassignedPool();
        } else {
            const data = await res.json();
            showToast(data.error || 'Failed to assign.', 'error');
        }
    } catch (err) { showToast('Network error.', 'error'); }
}

async function approveAllRecommendations() {
    try {
        const res = await fetch('/api/admin/approve-all-recommendations', { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
            showToast(data.message, 'success');
            loadRecommendations();
            loadUnassignedPool();
        } else {
            showToast(data.error, 'error');
        }
    } catch (err) { console.error(err); }
}

async function generateMockData() {
    if (!confirm('This will inject 50 mock samples into the unassigned pool. Are you sure?')) return;
    try {
        const res = await fetch('/api/admin/generate-mocks', { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
            showToast(data.message, 'success');
            fetchSamples(); // Refresh data
            loadUnassignedPool(); // Refresh pool view
        } else {
            showToast(data.error, 'error');
        }
    } catch(e) { showToast(e.message, 'error'); }
}

async function runAutoAssigner() {
    showToast('Running Smart Assigner...', 'info');
    try {
        const res = await fetch('/api/auto-assign', { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
            showToast(data.message, 'success');
            loadRecommendations();
            loadUnassignedPool();
        } else {
            showToast(data.error, 'error');
        }
    } catch (err) { console.error(err); }
}

async function forceRunAssigner() {
    await runAutoAssigner();
}

async function approveRecommendation(id) {
    try {
        const res = await fetch(`/api/approve-assignment/${id}`, { method: 'POST' });
        if (res.ok) {
            showToast('Assignment Approved', 'success');
            loadRecommendations();
            loadUnassignedPool();
        }
    } catch (err) { console.error(err); }
}

async function rejectRecommendation(id) {
    try {
        const res = await fetch(`/api/reject-assignment/${id}`, { method: 'POST' });
        if (res.ok) {
            showToast('Assignment Rejected', 'info');
            loadRecommendations();
        }
    } catch (err) { console.error(err); }
}

// ==========================================
// SAMPLE CELL CONFIDENTIAL // State for Confidential Sample Cell
let currentScData = [];
let scSelectedFile = null;
let scFreshData = [];
let scDuplicateData = [];
let scFileName = '';
let currentScFilterMin = 0;
let currentScFilterMax = Infinity;

function handleScFileSelect(event) {
    scSelectedFile = event.target.files[0];
    if (scSelectedFile) {
        const info = document.getElementById('sc-file-info');
        info.textContent = `Selected: ${scSelectedFile.name}`;
        info.style.display = 'block';
    }
}

function setupScDragAndDrop() {
    const dropZone = document.getElementById('sc-drag-drop-zone');
    if (!dropZone) return;

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
    });

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
    });

    dropZone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        document.getElementById('sc-excel-file').files = files;
        handleScFileSelect({ target: { files: files } });
    }, false);
}
setupScDragAndDrop();

async function analyzeSampleCellExcel() {
    if (!scSelectedFile) return showToast('Please select an Excel file first.', 'error');
    
    const formData = new FormData();
    formData.append('file', scSelectedFile);

    // Safely find the button regardless of which attribute it uses
    const btn = document.getElementById('sc-analyze-btn');
    if (btn) { btn.textContent = 'Analyzing...'; btn.disabled = true; }

    try {
        const res = await fetch('/api/sample-cell/upload', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        
        if (res.ok) {
            scFreshData = data.fresh;
            scDuplicateData = data.duplicates;
            scFileName = data.fileName;
            
            document.getElementById('sc-fresh-count').textContent = scFreshData.length;
            document.getElementById('sc-duplicate-count').textContent = scDuplicateData.length;
            
            const freshTbody = document.getElementById('sc-fresh-tbody');
            freshTbody.innerHTML = '';
            if (scFreshData.length === 0) {
                freshTbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--text-muted);">No new records</td></tr>';
            } else {
                scFreshData.forEach(r => {
                    freshTbody.innerHTML += `<tr>
                        <td><strong>${r.barcode || '-'}</strong></td>
                        <td>${r.sampleCode || '-'}</td>
                        <td>${r.isNumber || '-'}</td>
                        <td>${r.testingType || '-'}</td>
                        <td>${r.labName || '-'}</td>
                        <td>${r.sampleReceivedOn || '-'}</td>
                        <td><span style="color:var(--success); font-weight:600;">${r.sampleStatus || '-'}</span></td>
                    </tr>`;
                });
            }

            const dupTbody = document.getElementById('sc-duplicate-tbody');
            dupTbody.innerHTML = '';
            if (scDuplicateData.length === 0) {
                dupTbody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--text-muted);">No duplicates</td></tr>';
            } else {
                scDuplicateData.forEach(r => {
                    dupTbody.innerHTML += `<tr style="background:rgba(239,68,68,0.04);">
                        <td><strong>${r.barcode || '-'}</strong></td>
                        <td>${r.sampleCode || '-'}</td>
                        <td>${r.isNumber || '-'}</td>
                        <td>${r.testingType || '-'}</td>
                        <td>${r.labName || '-'}</td>
                        <td>${r.sampleReceivedOn || '-'}</td>
                        <td><span style="color:var(--warning); font-weight:600;">${r.sampleStatus || '-'}</span></td>
                    </tr>`;
                });
            }
            
            // Use classList to properly show modal with overlay
            document.getElementById('sc-review-modal').classList.add('active');
        } else {
            showToast(data.error || 'Analysis failed. Check file format.', 'error');
        }
    } catch (e) {
        console.error(e);
        showToast('Analysis failed. Please try again.', 'error');
    } finally {
        if (btn) { btn.textContent = 'Analyze Document'; btn.disabled = false; }
    }
}

function closeScReviewModal() {
    document.getElementById('sc-review-modal').classList.remove('active');
}

async function commitSampleCellUpload() {
    const btn = document.getElementById('sc-commit-btn');
    btn.textContent = 'Committing...';
    btn.disabled = true;

    try {
        const res = await fetch('/api/sample-cell/commit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fresh: scFreshData,
                duplicates: scDuplicateData,
                fileName: scFileName,
                uploadedBy: currentUser ? currentUser.username : 'Unknown'
            })
        });
        
        const data = await res.json();
        if (res.ok) {
            showToast(data.message, 'success');
            closeScReviewModal();
            scSelectedFile = null;
            document.getElementById('sc-file-info').style.display = 'none';
            document.getElementById('sc-excel-file').value = '';
            loadSampleCellData();
            fetchScAuditLog();
        } else {
            showToast(data.error, 'error');
        }
    } catch (e) {
        console.error(e);
        showToast('Commit failed.', 'error');
    } finally {
        btn.textContent = 'Commit to Local Vault';
        btn.disabled = false;
    }
}

async function fetchScAuditLog() {
    try {
        const res = await fetch('/api/sample-cell/history');
        const data = await res.json();
        if (res.ok) {
            const tbody = document.getElementById('sc-audit-log-body');
            if (data.history.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No history found in local vault.</td></tr>';
                return;
            }
            tbody.innerHTML = '';
            data.history.forEach(log => {
                tbody.innerHTML += `
                    <tr>
                        <td><span style="background:rgba(255,255,255,0.1); padding:2px 6px; border-radius:4px; font-family:monospace;">${log.batchId}</span></td>
                        <td>${new Date(log.uploadDate).toLocaleString()}</td>
                        <td>${log.fileName}</td>
                        <td><span style="color:var(--success); font-weight:bold;">+${log.sampleCount}</span></td>
                        <td><span style="color:var(--danger); font-weight:bold;">${log.duplicateCount}</span></td>
                        <td>${log.uploadedBy}</td>
                    </tr>
                `;
            });
        }
    } catch (e) {
        console.error(e);
    }
}

async function loadSampleCellData() {
    try {
        const res = await fetch('/api/sample-cell/data');
        const data = await res.json();
        if (res.ok) {
            currentScData = data.data;
            document.getElementById('sc-kpi-15').textContent = data.analytics.over15;
            document.getElementById('sc-kpi-30').textContent = data.analytics.over30;
            document.getElementById('sc-kpi-45').textContent = data.analytics.over45;
            document.getElementById('sc-kpi-60').textContent = data.analytics.over60;
            document.getElementById('sc-kpi-90').textContent = data.analytics.over90;
            document.getElementById('sc-kpi-all').textContent = data.analytics.totalPending;
            renderSampleCellTable();
        }
    } catch (e) { console.error(e); }
}

function filterSampleCellData(minDays, maxDays) {
    currentScFilterMin = minDays;
    currentScFilterMax = maxDays;
    renderSampleCellTable();
}

function renderSampleCellTable() {
    const tbody = document.getElementById('sample-cell-tbody');
    tbody.innerHTML = '';

    const filtered = currentScData.filter(r => {
        // Always filter out fully completed reports FIRST
        if (r.reportStatus === 'Report Issued') return false;
        
        // If "All Pending" is clicked, show everything that wasn't filtered above
        if (currentScFilterMin === 0 && currentScFilterMax === Infinity) return true;
        
        // Otherwise, filter by age band
        return r.ageDays > currentScFilterMin && r.ageDays <= currentScFilterMax;
    });

    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;">No records found.</td></tr>';
        return;
    }

    filtered.forEach(row => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${row.sNo || '-'}</td>
            <td><strong>${row.barcode || '-'}</strong></td>
            <td>${row.sampleCode || '-'}</td>
            <td>${row.isNumber || '-'}</td>
            <td>${row.testingType || '-'}</td>
            <td>${row.labName || '-'}</td>
            <td>${row.sampleReceivedOn || '-'}</td>
            <td><span style="color:${row.ageDays > 90 ? 'var(--danger)' : row.ageDays > 60 ? 'var(--warning)' : row.ageDays > 30 ? 'var(--accent)' : 'inherit' }">${row.ageDays}</span></td>
            <td>${row.reportIssuedOn || '-'}</td>
            <td>${row.sampleStatus || '-'}</td>
        `;
        tbody.appendChild(tr);
    });
}

async function wipeSampleCellData() {
    if (!confirm('WARNING: Are you sure you want to permanently delete ALL confidential sample records? This cannot be undone.')) return;
    try {
        const res = await fetch('/api/sample-cell/data', { method: 'DELETE' });
        const data = await res.json();
        if (res.ok) {
            showToast(data.message, 'success');
            loadSampleCellData();
            fetchScAuditLog();
        } else {
            showToast(data.error, 'error');
        }
    } catch (e) {
        console.error(e);
        showToast('Failed to wipe data.', 'error');
    }
}

function toggleScAuditLogs() {
    const container = document.getElementById('sc-audit-logs-container');
    const btn = document.querySelector('button[onclick="toggleScAuditLogs()"]');
    if (!container) return;

    const isHidden = container.style.display === 'none' || container.style.display === '';
    if (isHidden) {
        container.style.display = 'block';
        if (btn) btn.textContent = '📜 Hide Audit Logs';
        // Always fetch fresh data when opening
        fetchScAuditLog();
        // Smooth scroll to the logs
        setTimeout(() => container.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    } else {
        container.style.display = 'none';
        if (btn) btn.textContent = '📜 View Audit Logs';
    }
}
