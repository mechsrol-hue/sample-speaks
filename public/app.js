let currentUser = null;

function isSuperAdmin() { return currentUser && (currentUser.role === 'admin_sample_cell' || currentUser.role === 'super_admin'); }
function isAdminOrSuperAdmin() { return currentUser && (currentUser.role === 'admin' || currentUser.role === 'admin_sample_cell' || currentUser.role === 'super_admin'); }
let allSamples = [];
let currentSubmitId = null;
let pendingFreshSamples = [];
let pendingDuplicateSamples = [];
let forceCommittedCodes = new Set();
let currentFileName = "";
let currentDuplicateCount = 0;
let kpiFilter = "ALL";
let selectedUploadFile = null; // tracks file from both drop and browse
let currentPrefs = { priorityRankingMode: 'prioritize', leaveWindowDays: 30, autoRunAssigner: false };
let pendingColumnMappings = {}; // resolved column mappings from admin
let uploadMissingAccounts = []; // TA names with no account
let allTPUsers = []; // cached list of all TP users for direct assign dropdown

const SYSTEM_FIELDS = {
    encodedCode: { synonyms: ['encoded code', 'encoded sample', 'encodedcode', 'encode', 'sample code', 'samplecode', 'sample no', 'sample number'] },
    isNumber: { synonyms: ['is number', 'isnumber', 'is_number', 'is no', 'indian standard', 'standard'] },
    quantity: { synonyms: ['quantity', 'qty'] },
    priorityLevel: { synonyms: ['priority', 'priority level'] },
    receivedOn: { synonyms: ['received on', 'receivedon', 'sample received on', 'received_on', 'received date', 'date received', 'recv dt'] },
    forwardedOn: { synonyms: ['forwarded on', 'forwardedon', 'sample forwarded on', 'forwarded_on', 'forwarded date'] },
    assignedTo: { synonyms: ['assigned to', 'tp name', 'assignedto', 'tpname', 'testing person name', 'testing person', 'tester', 'tester name', 'officer', 'allocated to', 'allocatedto', 'tp', 'tp_name', 'testing_person', 'tp name standard'] },
    totalTest: { synonyms: ['total test', 'totaltest', 'total tests'] },
    pendingTest: { synonyms: ['pending test', 'pendingtest', 'pending tests'] },
    approvedTest: { synonyms: ['approved test', 'approvedtest', 'approved tests'] }
};

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
            document.getElementById('dashboard-container').classList.add('active');
            const displayRole = (currentUser.role === 'admin_sample_cell' || currentUser.role === 'super_admin') ? 'Super Admin' : currentUser.role === 'admin' ? 'Admin' : 'TP';
            document.getElementById('user-welcome').textContent = `Welcome, ${currentUser.username} (${displayRole})`;
            
            document.getElementById('admin-tabs').style.display = 'flex';
            toggleAdminViews();
            updateProfileUI(); // Populate avatar + profile page immediately on login
            switchTab('tab-dashboard');
            
            if (isSuperAdmin()) {
                loadSampleCellData();
                fetchScAuditLog();
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
    document.getElementById('auth-container').classList.add('active');
    document.getElementById('admin-tabs').style.display = 'none';
    document.getElementById('username').value = '';
    document.getElementById('password').value = '';
    showToast('Logged out securely.', 'info');
}

// --- PROFILE ---
function getInitials(name) {
    if (!name) return 'U';
    const parts = name.trim().split(' ').filter(Boolean);
    if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

function updateProfileUI() {
    if (!currentUser) return;

    const initials = getInitials(currentUser.username);
    const displayRole = isSuperAdmin() ? 'Super Admin' : currentUser.role === 'admin' ? 'Admin' : 'Testing Person (TP)';
    const accessLevel = isSuperAdmin() ? 'Full Access — Super Admin' : currentUser.role === 'admin' ? 'Admin — Upload & Manage' : 'Standard TP — Own Samples Only';

    // Header avatar
    const headerInitialsEl = document.getElementById('header-avatar-initials');
    if (headerInitialsEl) headerInitialsEl.textContent = initials;

    // Profile page elements
    const profileInitialsLarge = document.getElementById('profile-avatar-initials-large');
    if (profileInitialsLarge) profileInitialsLarge.textContent = initials;

    const profileName = document.getElementById('profile-name');
    if (profileName) profileName.textContent = currentUser.username;

    const profileRoleBadge = document.getElementById('profile-role-badge');
    if (profileRoleBadge) {
        profileRoleBadge.textContent = displayRole;
        profileRoleBadge.className = 'profile-role-badge ' + (isAdminOrSuperAdmin() ? 'badge-admin' : 'badge-tp');
    }

    const profileInfoUsername = document.getElementById('profile-info-username');
    if (profileInfoUsername) profileInfoUsername.textContent = currentUser.username;

    const profileInfoRole = document.getElementById('profile-info-role');
    if (profileInfoRole) profileInfoRole.textContent = displayRole;

    const profileInfoAccess = document.getElementById('profile-info-access');
    if (profileInfoAccess) profileInfoAccess.textContent = accessLevel;

    // Stats from allSamples
    refreshProfileStats();
}

function refreshProfileStats() {
    if (!currentUser) return;

    const myPending = allSamples.filter(s =>
        (s.appStatus === 'Pending' || s.appStatus === 'PendingAccount') &&
        (!isAdminOrSuperAdmin() ? (s.assignedTo || '').toLowerCase() === (currentUser.username || '').toLowerCase() : true)
    );
    const mySubmitted = allSamples.filter(s => s.appStatus === 'Submitted' &&
        (!isAdminOrSuperAdmin() ? (s.assignedTo || '').toLowerCase() === (currentUser.username || '').toLowerCase() : true)
    );
    const myPriority = myPending.filter(s => isTopPriority(s));
    const mySLA = myPending.filter(s => calculateDaysOld(s.forwardedOn) > 15);

    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setEl('profile-stat-pending', myPending.length);
    setEl('profile-stat-priority', myPriority.length);
    setEl('profile-stat-submitted', mySubmitted.length);
    setEl('profile-stat-sla', mySLA.length);

    // IS Number breakdown
    const breakdownEl = document.getElementById('profile-is-breakdown');
    if (breakdownEl) {
        const isCounts = {};
        myPending.forEach(s => {
            if (s.isNumber) isCounts[s.isNumber] = (isCounts[s.isNumber] || 0) + 1;
        });
        const sorted = Object.entries(isCounts).sort((a, b) => b[1] - a[1]);
        if (sorted.length === 0) {
            breakdownEl.innerHTML = '<p style="color:var(--text-muted); font-size:0.9rem; text-align:center; padding:20px;">No pending samples assigned.</p>';
        } else {
            breakdownEl.innerHTML = sorted.map(([is, count]) =>
                `<div class="profile-is-row">
                    <span class="profile-is-label">${is}</span>
                    <div class="profile-is-bar-wrap">
                        <div class="profile-is-bar" style="width:${Math.min(100, (count / (sorted[0][1] || 1)) * 100)}%"></div>
                    </div>
                    <span class="profile-is-count">${count}</span>
                </div>`
            ).join('');
        }
    }

    // Samples table in profile
    const profileTbody = document.getElementById('profile-samples-tbody');
    const profileBadge = document.getElementById('profile-pending-badge');
    if (profileTbody) {
        profileTbody.innerHTML = '';
        if (myPending.length === 0) {
            profileTbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:20px; color:var(--text-muted);">🎉 No pending samples in your queue!</td></tr>';
        } else {
            const sorted = [...myPending].sort((a, b) => {
                if (isTopPriority(a) && !isTopPriority(b)) return -1;
                if (!isTopPriority(a) && isTopPriority(b)) return 1;
                return calculateDaysOld(b.forwardedOn) - calculateDaysOld(a.forwardedOn);
            });
            sorted.forEach(s => {
                const daysOld = calculateDaysOld(s.forwardedOn);
                const tr = document.createElement('tr');
                if (daysOld > 15) tr.classList.add('row-danger-red');
                else if (daysOld > 7) tr.classList.add('row-warning-yellow');

                let priorityHtml = `<strong>${s.priorityLevel || 'Standard'}</strong>`;
                if (isTopPriority(s)) priorityHtml += '<br><span class="badge-top-priority">Priority</span>';
                if (daysOld > 15) priorityHtml += '<br><span class="badge-fifo">SLA: >15 Days</span>';

                tr.innerHTML = `
                    <td>${priorityHtml}</td>
                    <td style="color:var(--accent); font-weight:600;">${s.encodedCode}</td>
                    <td style="color:var(--text-muted);">${s.isNumber || '—'}</td>
                    <td>${s.forwardedOn || '—'}</td>
                    <td>${s.receivedOn || '—'}</td>
                    <td><span class="status-badge status-pending">In Queue</span></td>
                    <td><button onclick="openSubmitModal(${s.id}, '${s.encodedCode}')">Submit</button></td>
                `;
                profileTbody.appendChild(tr);
            });
        }
        if (profileBadge) profileBadge.textContent = myPending.length;
    }

    checkDisposalReminders();
}

async function changePassword() {
    const currentPw = document.getElementById('profile-current-pw').value;
    const newPw = document.getElementById('profile-new-pw').value;
    const confirmPw = document.getElementById('profile-confirm-pw').value;

    if (!currentPw || !newPw || !confirmPw) return showToast('Please fill in all password fields.', 'warning');
    if (newPw !== confirmPw) return showToast('New passwords do not match.', 'error');
    if (newPw.length < 4) return showToast('Password must be at least 4 characters.', 'warning');

    try {
        const res = await fetch('/api/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id, currentPassword: currentPw, newPassword: newPw })
        });
        const data = await res.json();
        if (res.ok) {
            showToast('Password changed successfully! ✅', 'success');
            document.getElementById('profile-current-pw').value = '';
            document.getElementById('profile-new-pw').value = '';
            document.getElementById('profile-confirm-pw').value = '';
        } else {
            showToast(data.error || 'Failed to change password.', 'error');
        }
    } catch (err) {
        showToast('Network error while changing password.', 'error');
    }
}

async function checkDisposalReminders() {
    if (!currentUser || !currentUser.username) return;
    try {
        const res = await fetch(`/api/disposal-reminders/${currentUser.username}?role=${currentUser.role}`);
        const data = await res.json();
        const banner = document.getElementById('disposal-alerts-banner');
        if (!banner) return;

        if (data.overdue && data.upcoming && (data.overdue.length > 0 || data.upcoming.length > 0)) {
            banner.style.display = 'block';
            document.getElementById('disposal-overdue-count').textContent = data.overdue.length;
            document.getElementById('disposal-upcoming-count').textContent = data.upcoming.length;

            const tbody = document.getElementById('disposal-alerts-tbody');
            tbody.innerHTML = '';
            const addRows = (list, labelColor, labelText) => {
                list.forEach(s => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td style="padding: 6px 4px; border-bottom: 1px solid rgba(0,0,0,0.05);">${s.encodedCode}</td>
                        <td style="padding: 6px 4px; border-bottom: 1px solid rgba(0,0,0,0.05);">${s.isNumber || '—'}</td>
                        <td style="padding: 6px 4px; border-bottom: 1px solid rgba(0,0,0,0.05);"><span style="background:${labelColor}; color:#fff; padding:2px 6px; border-radius:4px; font-size:0.75rem;">${labelText}</span></td>
                    `;
                    tbody.appendChild(tr);
                });
            };
            addRows(data.overdue, '#ef4444', 'Overdue');
            addRows(data.upcoming, '#f59e0b', 'Upcoming');
        } else {
            banner.style.display = 'none';
        }
    } catch (err) {
        console.error('Failed to fetch disposal reminders:', err);
    }
}

function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));

    const content = document.getElementById(tabId);
    if (content) content.classList.add('active');

    const btn = Array.from(document.querySelectorAll('.tab-btn')).find(b => b.getAttribute('onclick') === `switchTab('${tabId}')`);
    if (btn) btn.classList.add('active');

    // Load data specific to tabs
    if (tabId === 'tab-lims') {
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
    } else if (tabId === 'tab-super-admin') {
        loadSampleCellData();
        fetchScAuditLog();
    }
}

// --- PROFILE MODAL ---
function openProfileModal() {
    refreshProfileStats();
    const modal = document.getElementById('profile-modal');
    if (modal) modal.style.display = 'flex';
}

function closeProfileModal() {
    const modal = document.getElementById('profile-modal');
    if (modal) modal.style.display = 'none';
}

function toggleAuditLogs() {
    const container = document.getElementById('upload-audit-trail-container');
    if (container) {
        if (container.style.display === 'none') {
            container.style.display = 'block';
            viewHistory(); // Fetch fresh audit data when opened
        } else {
            container.style.display = 'none';
        }
    }
}

// --- PREFERENCES ---
let selectedRankingMode = 'prioritize';

function setRankingMode(mode) {
    selectedRankingMode = mode;
    const btnPrioritize = document.getElementById('btn-rank-prioritize');
    const btnEqual = document.getElementById('btn-rank-equal');
    if (btnPrioritize && btnEqual) {
        btnPrioritize.classList.toggle('active', mode === 'prioritize');
        btnEqual.classList.toggle('active', mode === 'equal');
    }
}

async function loadPreferences() {
    try {
        const res = await fetch('/api/preferences');
        const data = await res.json();
        if (res.ok && data.preferences) {
            currentPrefs = {
                priorityRankingMode: data.preferences.priorityRankingMode || 'prioritize',
                leaveWindowDays: parseInt(data.preferences.leaveWindowDays) || 30,
                autoRunAssigner: data.preferences.autoRunAssigner === 'true',
                passStorageDays: parseInt(data.preferences.passStorageDays) || 15,
                failStorageDays: parseInt(data.preferences.failStorageDays) || 45
            };
        }
    } catch (err) { console.error('Failed to load preferences:', err); }
}

function loadPreferencesUI() {
    const lw = document.getElementById('pref-leave-window');
    const ar = document.getElementById('pref-auto-run');
    if (lw) lw.value = currentPrefs.leaveWindowDays;
    if (ar) ar.checked = currentPrefs.autoRunAssigner;
    if (document.getElementById('pref-pass-storage')) document.getElementById('pref-pass-storage').value = currentPrefs.passStorageDays;
    if (document.getElementById('pref-fail-storage')) document.getElementById('pref-fail-storage').value = currentPrefs.failStorageDays;
    
    setRankingMode(currentPrefs.priorityRankingMode || 'prioritize');
}

async function savePriorityRanking() {
    const prefs = {
        ...currentPrefs,
        priorityRankingMode: selectedRankingMode
    };
    try {
        const res = await fetch('/api/preferences', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(prefs)
        });
        const data = await res.json();
        if (data.success) {
            showToast('Priority Mode applied successfully!', 'success');
            currentPrefs.priorityRankingMode = selectedRankingMode;
            fetchSamples(); // Reload samples with new ranking logic
        } else {
            showToast('Failed to apply Priority Mode.', 'error');
        }
    } catch (err) {
        showToast('Network error while saving.', 'error');
    }
}

async function savePreferences() {
    const prefs = {
        priorityRankingMode: selectedRankingMode,
        leaveWindowDays: document.getElementById('pref-leave-window').value,
        autoRunAssigner: document.getElementById('pref-auto-run').checked ? 'true' : 'false',
        passStorageDays: document.getElementById('pref-pass-storage').value,
        failStorageDays: document.getElementById('pref-fail-storage').value
    };
    try {
        const res = await fetch('/api/preferences', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(prefs)
        });
        if (res.ok) {
            showToast('Preferences saved successfully.', 'success');
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
    
    const assignedFresh = fresh.filter(s => s.assignedTo);
    const unassignedFresh = fresh.filter(s => !s.assignedTo);

    document.getElementById('fresh-count').textContent = assignedFresh.length;
    const unassignedModalCount = document.getElementById('unassigned-modal-count');
    if (unassignedModalCount) unassignedModalCount.textContent = unassignedFresh.length;

    // --- Missing Accounts Banner ---
    const existingMissingBanner = document.getElementById('missing-accounts-banner');
    if (existingMissingBanner) {
        if (typeof uploadMissingAccounts !== 'undefined' && uploadMissingAccounts.length > 0) {
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
    assignedFresh.forEach(s => {
        const tr = document.createElement('tr');
        tr.classList.add('row-success-green');
        tr.innerHTML = `<td>${s.encodedCode}</td><td>${s.assignedTo}</td><td><strong>${s.priorityLevel}</strong></td><td><span class="status-badge" style="background:var(--success); color:white;">Assigned</span></td>`;
        freshTbody.appendChild(tr);
    });

    const unassignedTbody = document.getElementById('unassigned-modal-tbody');
    if (unassignedTbody) {
        unassignedTbody.innerHTML = '';
        unassignedFresh.forEach(s => {
            const tr = document.createElement('tr');
            tr.classList.add('row-warning-yellow');
            tr.innerHTML = `<td>${s.encodedCode}</td><td>${s.isNumber || '—'}</td><td><strong>${s.priorityLevel}</strong></td><td><span class="status-badge" style="background:#fef3c7; color:#d97706;">Unassigned</span></td>`;
            unassignedTbody.appendChild(tr);
        });
    }

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
            refreshProfileStats(); // Keep profile in sync after data refresh
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
    // Enhance all samples with computed fields
    const enhanced = allSamples.map(s => ({
        ...s,
        _daysOld: calculateDaysOld(s.forwardedOn),
        _isTopPriority: isTopPriority(s)
    }));

    // Get the active pending samples (assigned pending/PendingAccount)
    const pendingAll = enhanced.filter(s => (s.appStatus === 'Pending' || s.appStatus === 'PendingAccount') && s.assignedTo);

    // Apply KPI filter to find the active set for dropdown counts
    let activeSamples = pendingAll;
    if (kpiFilter === 'Priority') {
        activeSamples = pendingAll.filter(s => s._isTopPriority);
    } else if (kpiFilter === 'Urgent') {
        activeSamples = pendingAll.filter(s => !s._isTopPriority && s._daysOld > 15);
    } else if (kpiFilter === 'Submitted') {
        activeSamples = [];
    } else if (kpiFilter === 'Unassigned') {
        activeSamples = enhanced.filter(s => s.appStatus === 'Pending' && !s.assignedTo);
    }

    // 1. IS Number Filter
    const isFilter = document.getElementById('is-filter');
    if (isFilter) {
        const isCounts = {};
        activeSamples.forEach(s => {
            if (s.isNumber) {
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
        if (uniqueIS.includes(currentVal)) {
            isFilter.value = currentVal;
        } else {
            isFilter.value = 'ALL';
        }
    }

    // 2. Priority Filter
    const priorityFilter = document.getElementById('priority-filter');
    if (priorityFilter) {
        const priorityCounts = { 'Priority': 0, 'Non-Priority': 0 };
        activeSamples.forEach(s => {
            const isPri = s._isTopPriority;
            if (isPri) {
                priorityCounts['Priority']++;
            } else {
                priorityCounts['Non-Priority']++;
            }
        });
        const currentVal = priorityFilter.value;
        priorityFilter.innerHTML = `
            <option value="ALL">All Priorities</option>
            <option value="Priority">Priority (${priorityCounts['Priority']})</option>
            <option value="Non-Priority">Non-Priority (${priorityCounts['Non-Priority']})</option>
        `;
        if (currentVal === 'Priority' || currentVal === 'Non-Priority') {
            priorityFilter.value = currentVal;
        } else {
            priorityFilter.value = 'ALL';
        }
    }

    // 3. Received Date Filter
    const dateFilter = document.getElementById('date-filter');
    if (dateFilter) {
        const dateCounts = {};
        activeSamples.forEach(s => {
            if (s.receivedOn) {
                dateCounts[s.receivedOn] = (dateCounts[s.receivedOn] || 0) + 1;
            }
        });
        const uniqueDates = Object.keys(dateCounts).sort((a,b) => {
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
            opt.textContent = `${d} (${dateCounts[d]})`;
            dateFilter.appendChild(opt);
        });
        if (uniqueDates.includes(currentVal)) {
            dateFilter.value = currentVal;
        } else {
            dateFilter.value = 'ALL';
        }
    }

    // 4. Assigned To Filter (Pending samples only)
    const assignedFilter = document.getElementById('assigned-filter');
    if (assignedFilter) {
        const assignedCounts = {};
        activeSamples.forEach(s => {
            if (s.assignedTo) {
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
        if (uniqueAssigned.includes(currentVal)) {
            assignedFilter.value = currentVal;
        } else {
            assignedFilter.value = 'ALL';
        }
    }

    // Initialize/Update custom styling on the dropdown UI
    setupCustomDropdowns();
}

function setupCustomDropdowns() {
    const selects = ['is-filter', 'priority-filter', 'date-filter', 'assigned-filter'];
    selects.forEach(id => {
        const select = document.getElementById(id);
        if (!select) return;
        
        let wrapper = select.parentElement;
        if (!wrapper.classList.contains('custom-select-wrapper')) {
            wrapper = document.createElement('div');
            wrapper.className = 'custom-select-wrapper';
            select.parentNode.insertBefore(wrapper, select);
            wrapper.appendChild(select);
            select.style.display = 'none';
            
            const trigger = document.createElement('div');
            trigger.className = 'custom-select-trigger';
            trigger.innerHTML = `<span class="selected-text"></span><span class="arrow">▼</span>`;
            wrapper.appendChild(trigger);
            
            const dropdown = document.createElement('div');
            dropdown.className = 'custom-select-dropdown custom-scrollbar';
            wrapper.appendChild(dropdown);
            
            trigger.addEventListener('click', (e) => {
                e.stopPropagation();
                document.querySelectorAll('.custom-select-wrapper').forEach(w => {
                    if (w !== wrapper) w.classList.remove('open');
                });
                wrapper.classList.toggle('open');
            });
        }
        
        const trigger = wrapper.querySelector('.custom-select-trigger');
        const dropdown = wrapper.querySelector('.custom-select-dropdown');
        const selectedText = trigger.querySelector('.selected-text');
        
        dropdown.innerHTML = '';
        
        Array.from(select.options).forEach(option => {
            const item = document.createElement('div');
            item.className = 'custom-select-option';
            
            if (option.selected) {
                item.classList.add('selected');
                const cleanText = option.text.replace(/\s*\(\d+\)$/, '').trim();
                selectedText.textContent = cleanText;
            }
            
            const match = option.text.match(/(.+)\s+\((\d+)\)$/);
            if (match) {
                const mainText = match[1].trim();
                const countVal = match[2];
                item.innerHTML = `<span>${mainText}</span><span class="count-badge">${countVal}</span>`;
            } else {
                item.innerHTML = `<span>${option.text}</span>`;
            }
            
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                select.value = option.value;
                
                const event = new Event('change', { bubbles: true });
                select.dispatchEvent(event);
                
                wrapper.classList.remove('open');
                setupCustomDropdowns();
            });
            
            dropdown.appendChild(item);
        });
    });

    if (!window.hasDropdownOutsideClickListener) {
        document.addEventListener('click', () => {
            document.querySelectorAll('.custom-select-wrapper').forEach(w => w.classList.remove('open'));
        });
        window.hasDropdownOutsideClickListener = true;
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
    populateFilterDropdowns();
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

    // --- Populate Unassigned Pool Table (Smart Assigner Tab) ---
    const unassignedPoolTbody = document.getElementById('unassigned-pool-tbody');
    if (unassignedPoolTbody) {
        unassignedPoolTbody.innerHTML = '';
        if (unassignedAll.length === 0) {
            unassignedPoolTbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:20px; color:var(--text-muted);">🎉 No unassigned samples.</td></tr>`;
        } else {
            unassignedAll.forEach(s => {
                const tr = document.createElement('tr');
                const isPrio = s._isTopPriority ? '<span class="badge-top-priority">Priority</span>' : '<span style="color:var(--text-muted);">Standard</span>';
                tr.innerHTML = `
                    <td style="color:var(--accent); font-weight:600;">${s.encodedCode}</td>
                    <td>${s.isNumber || '—'}</td>
                    <td>${isPrio}</td>
                    <td>${s.receivedOn || '—'}</td>
                    <td><button onclick="openSubmitModal(${s.id}, '${s.encodedCode}')" style="background:var(--primary); padding:4px 8px; font-size:0.8rem;">Direct Assign</button></td>
                `;
                unassignedPoolTbody.appendChild(tr);
            });
        }
        const unassignedPoolCount = document.getElementById('unassigned-pool-count');
        if (unassignedPoolCount) unassignedPoolCount.textContent = unassignedAll.length;
    }

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
        const isAdmin = isAdminOrSuperAdmin();
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

    const isAdmin = isAdminOrSuperAdmin();
    submittedAll.forEach(s => {
        const tr = document.createElement('tr');
        const passFailClass = s.passFail === 'Pass' ? 'status-submitted' : 'status-retained';

        let disposalHtml = '—';
        if (s.disposalDate) {
            const now = new Date();
            const dispDate = new Date(s.disposalDate);
            const daysLeft = Math.ceil((dispDate - now) / (1000 * 60 * 60 * 24));
            const dateStr = dispDate.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
            if (daysLeft > 0) {
                disposalHtml = `<div style="display:flex; flex-direction:column; gap:4px;">
                                    <span style="font-weight:600; font-size:0.9rem;">${dateStr}</span>
                                    <span class="badge-countdown" style="background:rgba(245,158,11,0.15); color:#b06000; border:1px solid rgba(245,158,11,0.3); align-self:flex-start;">⏳ ${daysLeft} Days Retained</span>
                                </div>`;
            } else {
                disposalHtml = `<div style="display:flex; flex-direction:column; gap:4px;">
                                    <span style="font-weight:600; font-size:0.9rem; color:var(--text-muted);">${dateStr}</span>
                                    <span class="badge-countdown" style="background:rgba(16,185,129,0.15); color:#137333; border:1px solid rgba(16,185,129,0.3); align-self:flex-start;">✅ Safe to Dispose</span>
                                </div>`;
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
    setupCustomDropdowns();
});

// --- Admin Utilities & Bulk Actions ---

function toggleAdminViews() {
    const isAdmin = isAdminOrSuperAdmin();
    
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

    // Change Section Titles for TP
    const mainTitle = document.getElementById('section-title');
    if (mainTitle) mainTitle.textContent = isAdmin ? 'Pending Sample Queue' : 'My Assigned Samples';
    
    const tableTitle = document.getElementById('table-section-title');
    if (tableTitle) tableTitle.textContent = isAdmin ? 'Pending Sample Queue' : 'My Assigned Samples';

    // Helper to safely toggle custom dropdowns
    const toggleDropdown = (id, show) => {
        const el = document.getElementById(id);
        if (!el) return;
        const parent = el.parentElement;
        if (parent && parent.classList.contains('custom-select-wrapper')) {
            parent.style.display = show ? '' : 'none';
        } else {
            el.style.display = show ? '' : 'none';
        }
    };

    // Hide TP irrelevant filters (assignedTo dropdown & uploader filter)
    toggleDropdown('assigned-filter', isAdmin);
    toggleDropdown('audit-user-filter', isAdmin);

    // Toggle specific admin tab buttons in tabs bar
    const uploadBtn = document.getElementById('tab-btn-upload');
    if (uploadBtn) uploadBtn.style.display = isAdmin ? 'inline-block' : 'none';

    const auditBtn = document.getElementById('tab-btn-audit');
    if (auditBtn) auditBtn.style.display = isAdmin ? 'inline-block' : 'none';
    
    const employeesBtn = document.getElementById('tab-btn-employees');
    if (employeesBtn) employeesBtn.style.display = isAdmin ? 'inline-block' : 'none';

    const leavesBtn = document.getElementById('tab-btn-leaves');
    if (leavesBtn) leavesBtn.style.display = isAdmin ? 'inline-block' : 'none';

    const assignerBtn = document.getElementById('tab-btn-assigner');
    if (assignerBtn) assignerBtn.style.display = isAdmin ? 'inline-block' : 'none';

    const analyticsBtn = document.getElementById('tab-btn-analytics');
    if (analyticsBtn) analyticsBtn.style.display = isAdmin ? 'inline-block' : 'none';

    const preferencesBtn = document.getElementById('tab-btn-preferences');
    if (preferencesBtn) preferencesBtn.style.display = isAdmin ? 'inline-block' : 'none';

    const superAdminBtn = document.getElementById('tab-btn-super-admin');
    if (superAdminBtn) superAdminBtn.style.display = isSuperAdmin() ? 'inline-block' : 'none';
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
    const maxDailySamples = parseInt(document.getElementById('emp-max-capacity').value) || 40;
    const username = document.getElementById('emp-username').value;
    const password = document.getElementById('emp-password').value;

    if (!fullName || !username || !password) return showToast('Please fill all required fields.', 'warning');

    try {
        const res = await fetch('/api/admin/employees', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fullName, designation, maxDailySamples, username, password })
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
async function openCompetencyModal(empId, empName) {
    currentCompEmpId = empId;
    document.getElementById('comp-emp-name').textContent = empName;
    document.getElementById('competency-modal').classList.add('active');
    
    // Populate the dropdown with unique IS Numbers from Unassigned pool AND existing db
    const select = document.getElementById('comp-is-number');
    select.innerHTML = '<option value="">Loading...</option>';
    
    try {
        const res = await fetch('/api/unassigned-samples');
        const data = await res.json();
        const unassigned = data.samples || [];
        
        let uniqueIS = new Set(Object.keys(EXTRACTED_STANDARDS_DB));
        unassigned.forEach(s => {
            if (s.isNumber) uniqueIS.add(s.isNumber);
        });
        
        select.innerHTML = '<option value="">-- Select IS Standard --</option>';
        Array.from(uniqueIS).sort().forEach(isNum => {
            const opt = document.createElement('option');
            opt.value = isNum;
            opt.textContent = isNum;
            select.appendChild(opt);
        });
    } catch(err) {
        console.error(err);
        select.innerHTML = '<option value="">Error loading standards</option>';
    }

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
                tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--text-muted);">No IS competencies assigned.</td></tr>';
            }
            data.competencies.forEach(c => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>${c.isNumber}</td>
                    <td>${c.proficiencyLevel}</td>
                    <td style="text-align:center;">
                        <button onclick="removeCompetency(${c.id})" style="background:transparent; border:none; color:var(--danger); cursor:pointer;" title="Remove">🗑️</button>
                    </td>
                `;
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

async function removeCompetency(compId) {
    if (!confirm('Are you sure you want to remove this competency?')) return;
    try {
        const res = await fetch(`/api/admin/competencies/${compId}`, { method: 'DELETE' });
        if (res.ok) {
            showToast('Competency removed.', 'success');
            if (currentCompEmpId) loadCompetencies(currentCompEmpId);
        } else {
            const data = await res.json();
            showToast(data.error || 'Failed to remove', 'error');
        }
    } catch(err) {
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
    const tbody = document.getElementById('unassigned-pool-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Loading...</td></tr>';
    
    // Update the unassigned count from the kpi badge
    const countSpan = document.getElementById('unassigned-pool-count');
    if (countSpan) countSpan.textContent = '...';

    try {
        const res = await fetch('/api/unassigned-samples');
        const data = await res.json();
        if (res.ok) {
            if (countSpan) countSpan.textContent = data.samples.length;
            tbody.innerHTML = '';
            if (data.samples.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:30px; color:var(--text-muted);">All samples are assigned.</td></tr>';
            } else {
                let tpOptions = '<option value="">-- Direct Assign --</option>';
                // fallback if allTPUsers is not available, we can fetch from DOM or global
                const selectEl = document.getElementById('leave-employee-select');
                if (selectEl && selectEl.options.length > 0) {
                    for(let i=0; i<selectEl.options.length; i++) {
                        tpOptions += `<option value="${selectEl.options[i].text}">${selectEl.options[i].text}</option>`;
                    }
                }
                
                data.samples.forEach(s => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `
                        <td style="color:var(--accent); font-weight:600;">${s.encodedCode}</td>
                        <td>${s.isNumber || '-'}</td>
                        <td><strong>${s.priorityLevel || '-'}</strong></td>
                        <td>${s.receivedOn || '-'}</td>
                        <td>
                            <select onchange="directAssignSample(${s.id}, this.value)" style="padding:4px 8px; border-radius:4px; background: rgba(0,0,0,0.2); color:white; border: 1px solid var(--glass-border);">
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
        const res = await fetch('/api/assign-sample-manual', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sampleId, username: tpName })
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

// ─── Super Admin Charts (Chart.js instances) ─────────────────────────────
let saAgeChartInst = null;
let saStatusChartInst = null;
let saTypeChartInst = null;
let saLabChartInst = null;

function destroySaChart(inst) { if (inst) { try { inst.destroy(); } catch(e){} } }

function renderSaCharts(data) {
    const analytics = data.analytics;
    const allRows   = data.data;

    // ── 1. Age Band bar chart ──────────────────────────────────────────────
    const ageCtx = document.getElementById('sa-age-chart');
    destroySaChart(saAgeChartInst);
    if (ageCtx) {
        saAgeChartInst = new Chart(ageCtx, {
            type: 'bar',
            data: {
                labels: ['0-15d', '15-30d', '30-45d', '45-60d', '60-90d', '>90d'],
                datasets: [{
                    label: 'Pending Samples',
                    data: [
                        analytics.totalPending - analytics.over15 - analytics.over30 - analytics.over45 - analytics.over60 - analytics.over90,
                        analytics.over15 - analytics.over30 - analytics.over45 - analytics.over60 - analytics.over90,
                        analytics.over30 - analytics.over45 - analytics.over60 - analytics.over90,
                        analytics.over45 - analytics.over60 - analytics.over90,
                        analytics.over60 - analytics.over90,
                        analytics.over90
                    ],
                    backgroundColor: [
                        'rgba(16,185,129,0.7)','rgba(99,102,241,0.7)','rgba(251,191,36,0.7)',
                        'rgba(245,158,11,0.7)','rgba(239,68,68,0.6)','rgba(220,38,38,0.85)'
                    ],
                    borderRadius: 6, borderSkipped: false
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    y: { ticks: { color: 'rgba(255,255,255,0.5)', stepSize: 1 }, grid: { color: 'rgba(255,255,255,0.05)' } },
                    x: { ticks: { color: 'rgba(255,255,255,0.6)' }, grid: { display: false } }
                }
            }
        });
    }

    // ── 2. Status donut ─────────────────────────────────────────────────────
    const statusCounts = {};
    allRows.forEach(r => {
        const s = r.reportStatus || r.sampleStatus || 'Unknown';
        statusCounts[s] = (statusCounts[s] || 0) + 1;
    });
    const statusCtx = document.getElementById('sa-status-chart');
    destroySaChart(saStatusChartInst);
    if (statusCtx) {
        const colors = ['rgba(99,102,241,0.8)','rgba(16,185,129,0.8)','rgba(239,68,68,0.8)','rgba(245,158,11,0.8)','rgba(168,85,247,0.8)'];
        saStatusChartInst = new Chart(statusCtx, {
            type: 'doughnut',
            data: {
                labels: Object.keys(statusCounts),
                datasets: [{ data: Object.values(statusCounts), backgroundColor: colors, borderWidth: 0, hoverOffset: 6 }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { position: 'bottom', labels: { color: 'rgba(255,255,255,0.7)', boxWidth: 12, padding: 14, font: { size: 11 } } } }
            }
        });
    }

    // ── 3. Testing Type bar ─────────────────────────────────────────────────
    const typeCounts = {};
    allRows.forEach(r => { if (r.testingType) typeCounts[r.testingType] = (typeCounts[r.testingType] || 0) + 1; });
    const typeCtx = document.getElementById('sa-type-chart');
    destroySaChart(saTypeChartInst);
    if (typeCtx) {
        saTypeChartInst = new Chart(typeCtx, {
            type: 'bar',
            data: {
                labels: Object.keys(typeCounts),
                datasets: [{ label: 'Samples', data: Object.values(typeCounts), backgroundColor: 'rgba(99,102,241,0.7)', borderRadius: 5 }]
            },
            options: {
                indexAxis: 'y', responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { ticks: { color: 'rgba(255,255,255,0.5)', stepSize: 1 }, grid: { color: 'rgba(255,255,255,0.05)' } },
                    y: { ticks: { color: 'rgba(255,255,255,0.6)' }, grid: { display: false } }
                }
            }
        });
    }

    // ── 4. Lab distribution bar ─────────────────────────────────────────────
    const labCounts = {};
    allRows.forEach(r => { if (r.labName) labCounts[r.labName] = (labCounts[r.labName] || 0) + 1; });
    const labCtx = document.getElementById('sa-lab-chart');
    destroySaChart(saLabChartInst);
    if (labCtx) {
        saLabChartInst = new Chart(labCtx, {
            type: 'bar',
            data: {
                labels: Object.keys(labCounts),
                datasets: [{ label: 'Samples', data: Object.values(labCounts), backgroundColor: 'rgba(16,185,129,0.7)', borderRadius: 5 }]
            },
            options: {
                indexAxis: 'y', responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { ticks: { color: 'rgba(255,255,255,0.5)', stepSize: 1 }, grid: { color: 'rgba(255,255,255,0.05)' } },
                    y: { ticks: { color: 'rgba(255,255,255,0.6)' }, grid: { display: false } }
                }
            }
        });
    }
}

async function fetchScAuditLog() {
    try {
        const res = await fetch('/api/sample-cell/history');
        const data = await res.json();
        if (res.ok) {
            const tbody = document.getElementById('sc-audit-log-body');
            const badge = document.getElementById('sa-batch-count-badge');
            if (badge) badge.textContent = `${data.history.length} batch${data.history.length !== 1 ? 'es' : ''}`;
            const kpiBatches = document.getElementById('sa-kpi-batches');
            if (kpiBatches) kpiBatches.textContent = data.history.length;
            if (data.history.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--text-muted);">No upload history found.</td></tr>';
                return;
            }
            tbody.innerHTML = '';
            data.history.forEach(log => {
                tbody.innerHTML += `
                    <tr>
                        <td><span style="background:rgba(255,255,255,0.1); padding:2px 6px; border-radius:4px; font-family:monospace; font-size:0.8rem;">${log.batchId}</span></td>
                        <td>${new Date(log.uploadDate).toLocaleString()}</td>
                        <td style="max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${log.fileName}</td>
                        <td><span style="color:var(--success); font-weight:bold;">+${log.sampleCount}</span></td>
                        <td><span style="color:var(--warning); font-weight:bold;">${log.duplicateCount}</span></td>
                        <td>${log.uploadedBy}</td>
                    </tr>
                `;
            });
        }
    } catch (e) { console.error(e); }
}

let scActiveFilter = 'all';

async function loadSampleCellData() {
    try {
        const res = await fetch('/api/sample-cell/data');
        const data = await res.json();
        if (res.ok) {
            currentScData = data.data;

            // ── KPI Strip ──────────────────────────────────────────────────
            const total = currentScData.length;
            const issued = currentScData.filter(r => r.reportStatus === 'Report Issued').length;
            const pending = data.analytics.totalPending;
            const critical = data.analytics.over90;

            const el = id => document.getElementById(id);
            if (el('sa-kpi-total'))   el('sa-kpi-total').textContent   = total;
            if (el('sa-kpi-pending')) el('sa-kpi-pending').textContent = pending;
            if (el('sa-kpi-critical'))el('sa-kpi-critical').textContent = critical;
            if (el('sa-kpi-issued'))  el('sa-kpi-issued').textContent  = issued;

            // Batch count updated by fetchScAuditLog — render it right after
            fetchScAuditLog().then(() => {
                // Also set batch count KPI if audit returns count
            });

            // ── Render charts ──────────────────────────────────────────────
            renderSaCharts(data);

            // ── Render table ───────────────────────────────────────────────
            scActiveFilter = 'all';
            setScChipActive('all');
            renderScTableFiltered();
        }
    } catch (e) { console.error(e); }
}

function filterScTable(band) {
    scActiveFilter = band;
    setScChipActive(band);
    renderScTableFiltered();
}

function setScChipActive(band) {
    document.querySelectorAll('.sa-chip').forEach(btn => {
        const isActive = btn.dataset.filter === band;
        btn.classList.toggle('active', isActive);
        btn.style.background = isActive ? 'rgba(99,102,241,0.25)' : 'transparent';
        btn.style.color = isActive ? 'var(--primary)' : '';
        btn.style.borderColor = isActive ? 'var(--primary)' : '';
        // Restore danger/warning color for non-active chips
        if (!isActive) {
            if (band !== '60-90' && btn.dataset.filter === '60-90') {
                btn.style.color = 'var(--warning)'; btn.style.borderColor = 'var(--warning)';
            }
            if (band !== '90+' && btn.dataset.filter === '90+') {
                btn.style.color = 'var(--danger)'; btn.style.borderColor = 'var(--danger)';
            }
        }
    });
    // Fix colors for non-active special chips
    document.querySelectorAll('.sa-chip').forEach(btn => {
        if (btn.dataset.filter !== band) {
            if (btn.dataset.filter === '60-90') { btn.style.color = 'var(--warning)'; btn.style.borderColor = 'var(--warning)'; btn.style.background = 'rgba(245,158,11,0.1)'; }
            if (btn.dataset.filter === '90+')   { btn.style.color = 'var(--danger)';  btn.style.borderColor = 'var(--danger)';  btn.style.background = 'rgba(239,68,68,0.1)'; }
            if (btn.dataset.filter === 'all' || btn.dataset.filter === '0-15' || btn.dataset.filter === '15-30' || btn.dataset.filter === '30-60') {
                btn.style.color = 'var(--text-muted)'; btn.style.borderColor = 'var(--glass-border)'; btn.style.background = 'transparent';
            }
        }
    });
}

function renderScTableFiltered() {
    if (!currentScData) return;
    const tbody = document.getElementById('sample-cell-tbody');
    const search = (document.getElementById('sa-table-search')?.value || '').toLowerCase();
    const countEl = document.getElementById('sa-table-count');

    let filtered = currentScData.filter(r => {
        const age = r.ageDays || 0;
        let passFilter = true;
        if (scActiveFilter === '0-15')  passFilter = age <= 15;
        else if (scActiveFilter === '15-30') passFilter = age > 15 && age <= 30;
        else if (scActiveFilter === '30-60') passFilter = age > 30 && age <= 60;
        else if (scActiveFilter === '60-90') passFilter = age > 60 && age <= 90;
        else if (scActiveFilter === '90+')   passFilter = age > 90;
        if (!passFilter) return false;
        if (search) {
            const haystack = `${r.barcode} ${r.sampleCode} ${r.isNumber} ${r.labName} ${r.testingType} ${r.sampleStatus}`.toLowerCase();
            if (!haystack.includes(search)) return false;
        }
        return true;
    });

    if (countEl) countEl.textContent = `${filtered.length} record${filtered.length !== 1 ? 's' : ''}`;

    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align:center; padding:24px; color:var(--text-muted);">No records match the current filter.</td></tr>';
        return;
    }

    tbody.innerHTML = '';
    filtered.forEach((row, idx) => {
        const ageDays = row.ageDays || 0;
        const ageColor = ageDays > 90 ? 'var(--danger)' : ageDays > 60 ? 'var(--warning)' : ageDays > 30 ? 'var(--accent)' : 'var(--success)';
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="color:var(--text-muted); font-size:0.8rem;">${idx + 1}</td>
            <td><strong style="font-family:monospace; font-size:0.85rem;">${row.barcode || '—'}</strong></td>
            <td>${row.sampleCode || '—'}</td>
            <td>${row.isNumber || '—'}</td>
            <td>${row.testingType || '—'}</td>
            <td>${row.labName || '—'}</td>
            <td>${row.sampleReceivedOn || '—'}</td>
            <td><span style="font-weight:700; color:${ageColor};">${ageDays}d</span></td>
            <td><span style="background:${ageDays > 0 ? 'rgba(239,68,68,0.1)' : 'rgba(16,185,129,0.1)'}; color:${ageDays > 0 ? 'var(--danger)' : 'var(--success)'}; padding:2px 8px; border-radius:20px; font-size:0.75rem; font-weight:600;">${row.sampleStatus || row.reportStatus || '—'}</span></td>
        `;
        tbody.appendChild(tr);
    });
}

function filterSampleCellData(minDays, maxDays) {
    currentScFilterMin = minDays;
    currentScFilterMax = maxDays;
    renderScTableFiltered();
}

function renderSampleCellTable() {
    // Legacy — just call new renderer
    renderScTableFiltered();
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

function toggleSaUpload() {
    const body = document.getElementById('sa-upload-body');
    const icon = document.getElementById('sa-upload-toggle-icon');
    if (!body) return;
    const isOpen = body.style.display !== 'none';
    body.style.display = isOpen ? 'none' : 'block';
    if (icon) icon.textContent = isOpen ? '▼ Expand' : '▲ Collapse';
}

function toggleScAuditLogs() { /* legacy no-op — audit log is always visible now */ }

// ============================================================
// IS INTELLIGENCE MODULE — Frontend Logic & RAG API Client
// ============================================================

let isVaultData = [];
let isActiveDocument = null;
let isChatHistory = [];
let isUncertainItems = [];
let isParsedClauses = [];

// --- Load IS Intelligence Tab ---
async function loadISIntelligence() {
    await fetchISVault();
    // Select first document by default if available and none active
    if (isVaultData.length > 0 && !isActiveDocument) {
        await selectISDocument(isVaultData[0].id);
    } else if (isVaultData.length === 0) {
        renderISEmptyState();
    }
}

// Hook into existing switchTab
const originalSwitchTab = switchTab;
switchTab = function(tabId) {
    originalSwitchTab(tabId);
    if (tabId === 'tab-is-intelligence') {
        loadISIntelligence();
    }
};

// --- Fetch Vault List ---
async function fetchISVault() {
    try {
        const res = await fetch('/api/is-intelligence/vault');
        const data = await res.json();
        isVaultData = data.vault || [];
        renderISVault();
    } catch(e) {
        showToast('Failed to load standard vault.', 'error');
    }
}

// --- Render Empty State ---
function renderISEmptyState() {
    const listEl = document.getElementById('is-vault-list');
    if (listEl) {
        listEl.innerHTML = '<div class="is-empty-state" style="padding:20px;"><span class="is-empty-icon">📂</span><p style="font-size:0.85rem;">No standards uploaded yet</p></div>';
    }
    const msgContainer = document.getElementById('is-rag-messages');
    if (msgContainer) {
        msgContainer.innerHTML = `
            <div class="is-empty-state" style="padding:40px 20px;">
                <span class="is-empty-icon">🤖</span>
                <h5>Select or upload a standard to begin</h5>
                <p>The AI is waiting to analyze the document.</p>
            </div>
        `;
    }
}

// --- Render Vault Sidebar ---
function renderISVault() {
    const listEl = document.getElementById('is-vault-list');
    const countEl = document.getElementById('is-vault-count');
    if (!listEl) return;

    if (countEl) countEl.textContent = isVaultData.length;

    if (isVaultData.length === 0) {
        renderISEmptyState();
        return;
    }

    listEl.innerHTML = isVaultData.map(doc => {
        const isActive = isActiveDocument && isActiveDocument.id === doc.id;
        const statusBadge = doc.status === 'has_uncertainties'
            ? '<span class="is-badge is-badge-medium">⚠ Flags</span>'
            : '<span class="is-badge is-badge-high">✓ Ready</span>';
        const date = new Date(doc.uploadedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
        return `
            <div class="is-vault-item ${isActive ? 'active' : ''}" onclick="selectISDocument(${doc.id})">
                <span class="is-vault-item-icon">📄</span>
                <div class="is-vault-item-info">
                    <div class="is-vault-item-title">${escapeHtml(doc.isNumber)}</div>
                    <div class="is-vault-item-meta">${escapeHtml(doc.title)} · ${date}</div>
                </div>
                <div class="is-vault-item-status">${statusBadge}</div>
            </div>
        `;
    }).join('');
}

// --- Select a Document ---
async function selectISDocument(docId) {
    try {
        const res = await fetch(`/api/is-intelligence/vault/${docId}`);
        const doc = await res.json();
        if (doc.error) {
            showToast(doc.error, 'error');
            return;
        }
        
        isActiveDocument = doc;
        isUncertainItems = doc.uncertainItems || [];
        isParsedClauses = doc.clauses || [];
        
        renderISVault();
        renderISAnalysis();
        renderISChatWelcome();

        // Update scope badge
        const scopeEl = document.getElementById('is-rag-scope-text');
        if (scopeEl) scopeEl.textContent = doc.isNumber;

        // Update parse status
        const statusEl = document.getElementById('is-parse-status-bar');
        if (statusEl) {
            statusEl.style.display = 'flex';
            statusEl.className = 'is-parse-status success';
            statusEl.innerHTML = `
                <span style="font-size:1.2rem;">✅</span>
                <div class="is-parse-progress">
                    <div style="font-size:0.88rem; font-weight:600; color:var(--success);">${escapeHtml(doc.isNumber)} — Fully Parsed</div>
                    <div style="font-size:0.78rem; color:var(--text-muted); margin-top:2px;">${doc.clauses.length} clauses · ${doc.tables.length} tables · Parse Confidence: ${Math.round(doc.confidenceScore * 100)}%</div>
                    <div class="is-parse-progress-bar" style="margin-top:6px;"><div class="is-parse-progress-fill" style="width:${doc.confidenceScore * 100}%;"></div></div>
                </div>
            `;
        }
    } catch(e) {
        showToast('Error loading document details.', 'error');
    }
}

// --- Render Analysis: Uncertainties + Clauses ---
function renderISAnalysis() {
    renderISUncertainties();
    renderISClauses();
    renderISTolerance();
}

// --- Render Uncertainty Flags ---
function renderISUncertainties() {
    const panel = document.getElementById('is-uncertainty-container');
    if (!panel) return;

    const unresolvedCount = isUncertainItems.filter(i => !i.resolved).length;

    if (unresolvedCount === 0) {
        panel.style.display = 'none';
        return;
    }

    panel.style.display = 'block';
    const countEl = document.getElementById('is-uncertainty-count');
    if (countEl) countEl.textContent = unresolvedCount;

    const listEl = document.getElementById('is-uncertainty-list');
    if (!listEl) return;

    listEl.innerHTML = isUncertainItems.map(item => {
        const confidenceColor = item.confidence < 0.4 ? 'color: var(--danger);' : item.confidence < 0.7 ? 'color: var(--warning);' : 'color: var(--success);';
        const resolvedClass = item.resolved ? 'resolved' : '';
        const inputArea = item.resolved
            ? `<div style="display:flex;align-items:center;gap:8px;"><span class="is-badge is-badge-resolved">✓ Resolved</span><span style="font-size:0.85rem;font-weight:600;color:var(--success);">${escapeHtml(item.userValue)}</span></div>`
            : `<div class="is-uncertainty-input-row">
                <input type="text" id="is-clarify-${item.id}" placeholder="Enter the correct value..." />
                <button onclick="submitISClarification('${item.id}')" class="primary" style="padding:8px 14px;">Confirm</button>
              </div>`;

        return `
            <div class="is-uncertainty-card ${resolvedClass}" id="is-card-${item.id}">
                <div class="is-uncertainty-location">
                    <span class="is-citation" style="cursor:default;">Page ${item.page}, ${escapeHtml(item.clauseNumber)}</span>
                    <span class="is-uncertainty-confidence" style="${confidenceColor}">Confidence: ${Math.round(item.confidence * 100)}%</span>
                </div>
                <div class="is-uncertainty-rawtext">${item.highlightedText}</div>
                <div class="is-uncertainty-reason">⚠️ ${escapeHtml(item.reason)}</div>
                ${inputArea}
            </div>
        `;
    }).join('');
}

// --- Submit Clarification ---
async function submitISClarification(itemId) {
    const input = document.getElementById(`is-clarify-${itemId}`);
    if (!input || !input.value.trim()) {
        showToast('Please enter the correct value before confirming.', 'error');
        return;
    }

    const val = input.value.trim();

    try {
        const res = await fetch('/api/is-intelligence/clarify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                documentId: isActiveDocument.id,
                itemId,
                resolvedValue: val
            })
        });
        const data = await res.json();
        if (data.error) {
            showToast(data.error, 'error');
            return;
        }
        
        isUncertainItems = data.uncertainItems || [];
        renderISUncertainties();
        // Refresh vault in case status badge changes
        await fetchISVault();
        showToast(`Clarification confirmed! Value: "${val}"`, 'success');
    } catch(e) {
        showToast('Error saving clarification.', 'error');
    }
}

// --- Render Parsed Clauses Accordion ---
function renderISClauses() {
    const container = document.getElementById('is-clauses-list');
    if (!container) return;

    if (isParsedClauses.length === 0) {
        container.innerHTML = '<p style="padding:15px;color:var(--text-muted);font-size:0.88rem;">No parsed clauses found.</p>';
        return;
    }

    container.innerHTML = isParsedClauses.map((clause, idx) => {
        const tableTag = clause.hasTable
            ? `<span style="font-size:0.72rem;background:#e8f0fe;color:var(--accent);padding:2px 8px;border-radius:4px;font-weight:600;margin-left:8px;">📊 Table</span>`
            : '';
        return `
            <div class="is-clause-item" id="is-clause-${idx}">
                <div class="is-clause-trigger" onclick="toggleISClause(${idx})">
                    <div class="is-clause-trigger-left">
                        <span class="is-clause-number">Cl ${escapeHtml(clause.clauseNumber)}</span>
                        <span class="is-clause-title">${escapeHtml(clause.title)}${tableTag}</span>
                    </div>
                    <span class="is-clause-arrow">▼</span>
                </div>
                <div class="is-clause-content">
                    <div class="is-clause-body">
                        <p style="white-space:pre-line;">${escapeHtml(clause.content)}</p>
                        ${clause.hasTable ? `<div style="margin-top:10px;padding:8px 12px;background:#f0f4ff;border-radius:6px;border:1px solid #d2e3fc;font-size:0.82rem;font-weight:600;color:var(--accent);">📊 Extracted Table Data</div>` : ''}
                        <div class="is-clause-page-ref">📄 Page ${clause.page} · ${escapeHtml(isActiveDocument.isNumber)}</div>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

// --- Toggle Clause Accordion ---
function toggleISClause(idx) {
    const el = document.getElementById(`is-clause-${idx}`);
    if (el) el.classList.toggle('open');
}

// --- Render Chat Welcome ---
function renderISChatWelcome() {
    const msgContainer = document.getElementById('is-rag-messages');
    if (!msgContainer) return;

    msgContainer.innerHTML = `
        <div class="is-rag-msg ai">
            <div class="is-rag-msg-avatar">🤖</div>
            <div class="is-rag-msg-body">
                <div class="is-rag-msg-sender">IS Intelligence</div>
                <div class="is-rag-msg-text">
                    I have parsed <strong>${escapeHtml(isActiveDocument.isNumber)}: ${escapeHtml(isActiveDocument.title)}</strong>. 
                    Ask me any question about the standard, generate an SOP, or get a test report template!
                </div>
            </div>
        </div>
    `;
    isChatHistory = [];
}

// --- Send RAG Query ---
async function sendISQuery() {
    if (!isActiveDocument) {
        showToast('Please select a document from the vault first.', 'error');
        return;
    }

    const input = document.getElementById('is-rag-input');
    if (!input || !input.value.trim()) return;

    const query = input.value.trim();
    input.value = '';

    const msgContainer = document.getElementById('is-rag-messages');
    if (!msgContainer) return;

    // Add user message
    msgContainer.innerHTML += `
        <div class="is-rag-msg user">
            <div class="is-rag-msg-avatar">👤</div>
            <div class="is-rag-msg-body">
                <div class="is-rag-msg-sender">You</div>
                <div class="is-rag-msg-text">${escapeHtml(query)}</div>
            </div>
        </div>
    `;

    // Show typing indicator
    msgContainer.innerHTML += `
        <div class="is-rag-msg ai" id="is-typing-msg">
            <div class="is-rag-msg-avatar">🤖</div>
            <div class="is-rag-msg-body">
                <div class="is-rag-msg-sender">IS Intelligence</div>
                <div class="is-typing-indicator">
                    <div class="is-typing-dot"></div>
                    <div class="is-typing-dot"></div>
                    <div class="is-typing-dot"></div>
                </div>
            </div>
        </div>
    `;
    msgContainer.scrollTop = msgContainer.scrollHeight;

    try {
        const res = await fetch('/api/is-intelligence/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                documentId: isActiveDocument.id,
                query: query
            })
        });
        const response = await res.json();
        
        const typingEl = document.getElementById('is-typing-msg');
        if (typingEl) typingEl.remove();

        if (response.error) {
            showToast(response.error, 'error');
            return;
        }

        const citationsHtml = (response.citations || []).map(c =>
            `<span class="is-citation" title="${escapeHtml(c.text)}">${escapeHtml(c.clause)}, Page ${c.page}</span>`
        ).join(' ');

        // Basic formatting for Markdown bold/italics/newlines/tables in the response
        let formattedText = response.answer
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/\n/g, '<br>')
            // Simple markdown table conversion
            .replace(/\|([\s\S]*?)\|/g, (match) => {
                return match; 
            });

        msgContainer.innerHTML += `
            <div class="is-rag-msg ai">
                <div class="is-rag-msg-avatar">🤖</div>
                <div class="is-rag-msg-body">
                    <div class="is-rag-msg-sender">IS Intelligence</div>
                    <div class="is-rag-msg-text">
                        ${formattedText}
                        ${citationsHtml ? `
                        <div style="margin-top:10px; border-top:1px solid var(--border-light); padding-top:8px;">
                            <span style="font-size:0.72rem; font-weight:700; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.3px;">Grounded Citations:</span><br>
                            ${citationsHtml}
                        </div>` : ''}
                    </div>
                </div>
            </div>
        `;
        msgContainer.scrollTop = msgContainer.scrollHeight;
    } catch(e) {
        const typingEl = document.getElementById('is-typing-msg');
        if (typingEl) typingEl.remove();
        showToast('Error querying local LLM RAG engine.', 'error');
    }
}

// --- Quick Action Handlers ---
function isQuickSOP() {
    const input = document.getElementById('is-rag-input');
    if (input) {
        input.value = 'Generate a detailed Step-by-Step SOP for wall thickness measurement as per this standard';
        sendISQuery();
    }
}

function isQuickReport() {
    const input = document.getElementById('is-rag-input');
    if (input) {
        input.value = 'Extract all testable parameters and return a structured markdown test report template';
        sendISQuery();
    }
}

function isQuickTolerance() {
    const input = document.getElementById('is-rag-input');
    if (input) {
        input.value = 'What are the dimensional tolerances and acceptable limits specified in this standard?';
        sendISQuery();
    }
}

function isQuickSummarize() {
    const input = document.getElementById('is-rag-input');
    if (input) {
        input.value = 'Provide a brief executive summary of this standard, including its primary scope and application.';
        sendISQuery();
    }
}

// --- Tolerance Lookup Widget ---
function renderISTolerance() {
    lookupISTolerance();
}

async function lookupISTolerance() {
    const sizeEl = document.getElementById('is-tol-size');
    const classEl = document.getElementById('is-tol-class');
    const resultsEl = document.getElementById('is-tolerance-results-body');
    if (!sizeEl || !classEl || !resultsEl) return;

    const size = sizeEl.value;
    const pipeClass = classEl.value;

    if (!isActiveDocument) {
        resultsEl.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--text-muted);padding:20px;">Select a standard from the vault first</td></tr>';
        return;
    }

    // Special offline path for IS 4985 (uses hardcoded local JS values)
    if (isActiveDocument.isNumber.includes('4985') && typeof IS_4985_SPECS !== 'undefined' && IS_4985_SPECS.sizes_db && IS_4985_SPECS.sizes_db[parseInt(size)]) {
        const data = IS_4985_SPECS.sizes_db[parseInt(size)];
        const thickness = data.thickness && data.thickness[parseInt(pipeClass)] ? data.thickness[parseInt(pipeClass)] : null;

        let rows = `
            <tr><td>Mean OD (Min)</td><td class="value-cell">${data.min_od.toFixed(1)} mm</td><td><span class="is-citation">Table 1, Cl 7.1.1.1</span></td></tr>
            <tr><td>Mean OD (Max)</td><td class="value-cell">${data.max_od.toFixed(1)} mm</td><td><span class="is-citation">Table 1, Cl 7.1.1.1</span></td></tr>
            <tr><td>Ovality (Max)</td><td class="value-cell">${data.ovality.toFixed(1)} mm</td><td><span class="is-citation">Table 1, Cl 7.1.1.2</span></td></tr>
            <tr><td>Socket Length (Min)</td><td class="value-cell">${data.socket} mm</td><td><span class="is-citation">Table 3, Cl 7.2.1.1</span></td></tr>
        `;

        if (thickness) {
            rows += `
                <tr><td>Wall Thickness (Min)</td><td class="value-cell">${thickness[1]} mm</td><td><span class="is-citation">Table 2, Cl 7.1.2.1</span></td></tr>
                <tr><td>Wall Thickness (Max)</td><td class="value-cell">${thickness[2]} mm</td><td><span class="is-citation">Table 2, Cl 7.1.2.1</span></td></tr>
                <tr><td>Wall Thickness (Avg)</td><td class="value-cell">${thickness[0]} mm</td><td><span class="is-citation">Table 2, Cl 7.1.2.1</span></td></tr>
            `;
        } else {
            rows += `<tr><td colspan="3" style="text-align:center;color:var(--warning);font-weight:600;">⚠ Class ${pipeClass} not available for ${size}mm</td></tr>`;
        }

        resultsEl.innerHTML = rows;
        return;
    }

    // Dynamic backend lookup for any other uploaded IS Standards
    resultsEl.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--text-muted);padding:20px;">🤖 Querying local LLM RAG for specifications...</td></tr>';
    try {
        const url = `/api/is-intelligence/lookup?isNumber=${encodeURIComponent(isActiveDocument.isNumber)}&size=${size}&class=${pipeClass}`;
        const res = await fetch(url);
        const data = await res.json();
        if (data.error) {
            resultsEl.innerHTML = `<tr><td colspan="3" style="text-align:center;color:var(--danger);padding:20px;">Error: ${escapeHtml(data.error)}</td></tr>`;
            return;
        }

        let rows = '';
        if (data.min_od) rows += `<tr><td>Mean OD (Min)</td><td class="value-cell">${data.min_od} mm</td><td><span class="is-citation">${escapeHtml(data.citation || 'Extracted')}</span></td></tr>`;
        if (data.max_od) rows += `<tr><td>Mean OD (Max)</td><td class="value-cell">${data.max_od} mm</td><td><span class="is-citation">${escapeHtml(data.citation || 'Extracted')}</span></td></tr>`;
        if (data.ovality) rows += `<tr><td>Ovality (Max)</td><td class="value-cell">${data.ovality} mm</td><td><span class="is-citation">${escapeHtml(data.citation || 'Extracted')}</span></td></tr>`;
        if (data.min_wall) rows += `<tr><td>Wall Thickness (Min)</td><td class="value-cell">${data.min_wall} mm</td><td><span class="is-citation">${escapeHtml(data.citation || 'Extracted')}</span></td></tr>`;
        if (data.max_wall) rows += `<tr><td>Wall Thickness (Max)</td><td class="value-cell">${data.max_wall} mm</td><td><span class="is-citation">${escapeHtml(data.citation || 'Extracted')}</span></td></tr>`;
        if (data.socket_length) rows += `<tr><td>Socket Length (Min)</td><td class="value-cell">${data.socket_length} mm</td><td><span class="is-citation">${escapeHtml(data.citation || 'Extracted')}</span></td></tr>`;

        if (!rows) {
            rows = '<tr><td colspan="3" style="text-align:center;color:var(--warning);padding:20px;">Could not extract specification tables for size/class. Ask the RAG chat for help.</td></tr>';
        }
        resultsEl.innerHTML = rows;
    } catch(e) {
        resultsEl.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--danger);padding:20px;">Failed to connect to RAG lookup server</td></tr>';
    }
}

// --- Upload IS Standard ---
async function uploadISStandard() {
    const fileInput = document.getElementById('is-pdf-input');
    if (!fileInput || !fileInput.files.length) {
        showToast('Please select a PDF file to upload.', 'error');
        return;
    }

    const file = fileInput.files[0];
    if (!file.name.toLowerCase().endsWith('.pdf')) {
        showToast('Only PDF files are accepted for IS Standard upload.', 'error');
        return;
    }

    // Show parsing animation
    const statusEl = document.getElementById('is-parse-status-bar');
    if (statusEl) {
        statusEl.style.display = 'flex';
        statusEl.className = 'is-parse-status parsing';
        statusEl.innerHTML = `
            <div class="is-parse-spinner"></div>
            <div class="is-parse-progress">
                <div style="font-size:0.88rem; font-weight:600; color:var(--accent);">Uploading &amp; Parsing: ${escapeHtml(file.name)}</div>
                <div style="font-size:0.78rem; color:var(--text-muted); margin-top:2px;">Local LLM is reading, scanning and analyzing pages...</div>
                <div class="is-parse-progress-bar"><div class="is-parse-progress-fill" id="is-parse-fill" style="width: 10%;"></div></div>
            </div>
        `;
    }

    const formData = new FormData();
    formData.append('pdf', file);

    // Simulate progress while uploading/parsing
    let progress = 10;
    const progressInterval = setInterval(() => {
        progress += Math.random() * 10;
        if (progress > 90) progress = 90;
        const fill = document.getElementById('is-parse-fill');
        if (fill) fill.style.width = progress + '%';
    }, 600);

    try {
        const res = await fetch('/api/is-intelligence/upload', {
            method: 'POST',
            body: formData
        });
        
        clearInterval(progressInterval);
        const fill = document.getElementById('is-parse-fill');
        if (fill) fill.style.width = '100%';

        const doc = await res.json();
        if (doc.error) {
            showToast(doc.error, 'error');
            if (statusEl) statusEl.style.display = 'none';
            return;
        }

        showToast(`${escapeHtml(file.name)} uploaded and parsed successfully!`, 'success');
        fileInput.value = '';
        
        // Refresh Vault list
        await fetchISVault();
        // Select the newly uploaded document
        await selectISDocument(doc.id);
    } catch(e) {
        clearInterval(progressInterval);
        if (statusEl) statusEl.style.display = 'none';
        showToast('Error uploading or parsing PDF document.', 'error');
    }
}

// --- Helper: Escape HTML ---
function escapeHtml(text) {
    if (!text) return '';
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
    return text.toString().replace(/[&<>"']/g, m => map[m]);
}

// --- Handle Enter key in RAG input ---
document.addEventListener('DOMContentLoaded', () => {
    const ragInput = document.getElementById('is-rag-input');
    if (ragInput) {
        ragInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                sendISQuery();
            }
        });
    }
});

// --- IS Inner Tab Switching ---
function switchISInnerTab(tabName) {
    document.querySelectorAll('.is-inner-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.is-inner-content').forEach(c => c.style.display = 'none');

    const activeTab = document.querySelector(`.is-inner-tab[data-tab="${tabName}"]`);
    if (activeTab) activeTab.classList.add('active');

    const activeContent = document.getElementById(`is-inner-${tabName}`);
    if (activeContent) activeContent.style.display = 'block';
}

// ==========================================
// MASTER TEMPLATES (MAN-HOURS) LOGIC
// ==========================================

const RAW_MAN_HOURS_DB = {
    "7.1.1.1": 7.0,   // Dimensions of pipes
    "7.1.1.2": 7.0,
    "7.1.2.1": 7.0,
    "7.2.1": 7.0,
    "8": 8.0,         // Sealing Ring
    "10.1": 0.5,      // Visual Appearance
    "10.1.1": 0.5,
    "10.2": 1.0,      // Opacity
    "11.1": 3.0,      // Reversion / Hydrostatic
    "11.1.1": 3.0,
    "11.2": 2.0,      // VST / Impact
    "11.3": 2.0       // Density
};

let currentTemplates = {};

function toggleTemplatesUI() {
    const body = document.getElementById('templates-body');
    const icon = document.getElementById('templates-toggle-icon');
    if (!body) return;
    const isHidden = body.style.display === 'none';
    body.style.display = isHidden ? 'block' : 'none';
    icon.textContent = isHidden ? '▲ Hide' : '▼ Expand';
    
    if (isHidden) {
        fetchTemplates();
    }
}

async function fetchTemplates() {
    try {
        const res = await fetch('/api/admin/templates');
        if (res.ok) {
            const data = await res.json();
            currentTemplates = data.templates || {};
            
            // Populate IS select dynamically from EXTRACTED_STANDARDS_DB
            const isSelect = document.getElementById('template-is-select');
            if (isSelect && typeof EXTRACTED_STANDARDS_DB !== 'undefined') {
                // Only populate if empty
                if (isSelect.options.length === 0) {
                    Object.keys(EXTRACTED_STANDARDS_DB).forEach(standard => {
                        const opt = document.createElement('option');
                        opt.value = standard;
                        opt.textContent = standard;
                        isSelect.appendChild(opt);
                    });
                }
            }
            
            loadTemplateForIS();
        }
    } catch(e) { console.error(e); }
}

function loadTemplateForIS() {
    const isSelect = document.getElementById('template-is-select');
    if (!isSelect) return;
    const isNumber = isSelect.value;
    
    let clauses = [];
    if (typeof EXTRACTED_STANDARDS_DB !== 'undefined' && EXTRACTED_STANDARDS_DB[isNumber]) {
        clauses = EXTRACTED_STANDARDS_DB[isNumber];
    } else if (isNumber === 'IS 4985' && typeof IS_4985_SPECS !== 'undefined') {
        const rows = IS_4985_SPECS.generateTestParameters(75, 3, "A", "No");
        const seen = new Set();
        rows.forEach(r => {
            let c = r.clause.split(' ')[0];
            if (!seen.has(c)) {
                seen.add(c);
                clauses.push({ clause: c, param: r.param, hours: RAW_MAN_HOURS_DB[c] || 1.0 });
            }
        });
    }

    const tbody = document.getElementById('template-params-tbody');
    tbody.innerHTML = '';
    
    const savedTemplate = currentTemplates[isNumber] || {};
    const activeClauses = savedTemplate.activeClauses || {};

    const tatInput = document.getElementById('template-tat-days');
    if (tatInput) tatInput.value = savedTemplate.tatDays || 7;

    let totalHrs = 0;

    clauses.forEach(c => {
        let isChecked = true;
        let equipment = '';
        let passiveHrs = 0;
        let activeHrs = c.hours || RAW_MAN_HOURS_DB[c.clause] || 1.0;

        if (activeClauses.hasOwnProperty(c.clause)) {
            const savedC = activeClauses[c.clause];
            if (typeof savedC === 'object') {
                isChecked = savedC.active;
                activeHrs = savedC.activeHours;
                passiveHrs = savedC.passiveHours || 0;
                equipment = savedC.equipment || '';
            } else {
                isChecked = savedC; // legacy boolean
            }
        }
        
        if (isChecked) totalHrs += activeHrs;

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="text-align: center;">
                <input type="checkbox" class="template-clause-chk" data-clause="${c.clause}" ${isChecked ? 'checked' : ''} onchange="updateTemplateTotal()">
            </td>
            <td><strong>${c.clause}</strong> - ${c.param}</td>
            <td>
                <input type="text" class="template-equip-input" value="${equipment}" placeholder="e.g. UTM, Oven" style="width:100%; padding:4px; background:rgba(0,0,0,0.2); border:1px solid var(--glass-border); color:white; border-radius:4px;" onchange="saveTemplateForIS()">
            </td>
            <td style="text-align: center;">
                <input type="number" class="template-active-hrs-input" value="${activeHrs}" step="0.5" style="width:60px; padding:4px; background:rgba(0,0,0,0.2); border:1px solid var(--glass-border); color:white; border-radius:4px;" onchange="updateTemplateTotal()">
            </td>
            <td style="text-align: center;">
                <input type="number" class="template-passive-hrs-input" value="${passiveHrs}" step="0.5" style="width:60px; padding:4px; background:rgba(0,0,0,0.2); border:1px solid var(--glass-border); color:white; border-radius:4px;" onchange="saveTemplateForIS()">
            </td>
        `;
        tbody.appendChild(tr);
    });

    document.getElementById('template-total-hours').textContent = totalHrs.toFixed(1) + ' hrs';
}

function updateTemplateTotal() {
    const trs = document.querySelectorAll('#template-params-tbody tr');
    let totalHrs = 0;
    trs.forEach(tr => {
        const chk = tr.querySelector('.template-clause-chk');
        const activeInput = tr.querySelector('.template-active-hrs-input');
        if (chk && chk.checked && activeInput) {
            totalHrs += parseFloat(activeInput.value) || 0;
        }
    });
    document.getElementById('template-total-hours').textContent = totalHrs.toFixed(1) + ' hrs';
    saveTemplateForIS(); // Auto-save on change
}

async function saveTemplateForIS() {
    const isNumber = document.getElementById('template-is-select').value;
    const tatInput = document.getElementById('template-tat-days');
    const trs = document.querySelectorAll('#template-params-tbody tr');
    
    let activeClauses = {};
    let totalHours = 0;
    
    trs.forEach(tr => {
        const chk = tr.querySelector('.template-clause-chk');
        const activeInput = tr.querySelector('.template-active-hrs-input');
        const passiveInput = tr.querySelector('.template-passive-hrs-input');
        const equipInput = tr.querySelector('.template-equip-input');
        
        if (!chk) return;
        
        const clause = chk.dataset.clause;
        const isActive = chk.checked;
        const activeHrs = parseFloat(activeInput.value) || 0;
        const passiveHrs = parseFloat(passiveInput.value) || 0;
        const equip = equipInput.value || '';

        activeClauses[clause] = {
            active: isActive,
            activeHours: activeHrs,
            passiveHours: passiveHrs,
            equipment: equip
        };
        
        if (isActive) totalHours += activeHrs;
    });

    const templateData = { 
        tatDays: tatInput ? parseFloat(tatInput.value) : 7,
        activeClauses, 
        totalHours 
    };

    try {
        const res = await fetch('/api/admin/templates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isNumber, templateData })
        });
        if (res.ok) {
            showToast('Template saved successfully!', 'success');
            currentTemplates[isNumber] = templateData;
        } else {
            showToast('Failed to save template', 'error');
        }
    } catch(e) {
        showToast('Error saving template', 'error');
        console.error(e);
    }
}
