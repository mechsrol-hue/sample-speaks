var copilotHistory = [];
var _pdfImportParsed = [];
// TEMPORARY CLEANUP SCRIPT (Will be removed after one reload)
(function cleanCorruptedLocalStorage() {
  try {
    const usersStr = localStorage.getItem('sample_speaks_users');
    if (usersStr) {
      let users = JSON.parse(usersStr);
      const initialCount = users.length;
      users = users.filter(u => !u.name.includes('{try{let val;') && !u.username.includes('test_user_xss_1'));
      if (users.length < initialCount) {
        localStorage.setItem('sample_speaks_users', JSON.stringify(users));
        console.log(`Successfully removed ${initialCount - users.length} corrupted employee records from localStorage.`);
      }
    }
  } catch (e) {
    console.error("Error cleaning localStorage:", e);
  }
})();

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
let allLocationsList = new Set();
let currentUnassignedSamples = [];

// --- Nigrani memory constants ---
const Nigrani_MEMORY_KEY = 'Nigrani_chat_memory_v1';
const Nigrani_MAX_TURNS = 40;   // keep last 40 turns verbatim
const Nigrani_SUMMARY_AFTER = 16; // summarize anything older than last 16 turns

// ============================================================================
// IS AMENDMENTS CLIENT-SIDE STATE & UTILITIES
// ============================================================================
let isAmendmentsMap = {};

function normalizeISNumber(isStr) {
    if (!isStr) return '';
    let match = isStr.toString().match(/IS\s*\d+/i);
    return match ? match[0].toUpperCase().replace(/\s+/g, ' ') : isStr.trim();
}

function getISNumberHtml(isNumberRaw) {
    if (!isNumberRaw || isNumberRaw === '—' || isNumberRaw === '-') return isNumberRaw || '—';
    const norm = normalizeISNumber(isNumberRaw);
    const data = isAmendmentsMap[norm];
    if (!data || data.count === 0) return escapeHtml(isNumberRaw);

    const count = data.count;
    const badgeClass = data.hasNew ? 'amd-badge new-amd-badge' : 'amd-badge';
    const text = data.hasNew ? `${count} Amds • New` : `${count} Amends`;
    const titleText = data.list.map(a => `${a.amendmentNumber}: ${a.title} (${a.publishDate})`).join('\n');

    return `<span class="amd-badge-container" style="display:inline-flex; align-items:center; flex-wrap:nowrap; gap:6px;">
        <span style="font-weight:inherit; color:inherit;">${escapeHtml(isNumberRaw)}</span>
        <span class="${badgeClass}" onclick="event.stopPropagation(); openAmendmentsModal('${norm}')" title="${escapeHtml(titleText)}">${escapeHtml(text)}</span>
    </span>`;
}

// Global modal handlers
function openAmendmentsModal(isNumber) {
    const titleEl = document.getElementById('amd-modal-is-title');
    const listEl = document.getElementById('amd-modal-list');
    const modal = document.getElementById('amendments-details-modal');
    if (!titleEl || !listEl || !modal) return;

    titleEl.textContent = `${isNumber} Amendments Directory`;
    const data = isAmendmentsMap[isNumber];
    if (!data || !data.list || data.list.length === 0) {
        listEl.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-muted);">No amendments logged for this standard.</div>';
    } else {
        const isAdmin = isAdminOrSuperAdmin();
        listEl.innerHTML = data.list.map(a => {
            const newTag = a.isNew ? '<span class="is-badge is-badge-medium new-amd-badge" style="display:inline-block; animation:none; font-size:0.7rem; padding:2px 6px; border-radius:4px; margin-left:8px;">New</span>' : '';
            const actionBtn = a.isNew 
                ? `<button onclick="dismissAmendmentHighlight(${a.id}, '${isNumber}')" class="btn-premium" style="font-size:0.75rem; padding:4px 8px; background:rgba(245,158,11,0.15); color:#b06000; border:1px solid rgba(245,158,11,0.3); border-radius:4px; cursor:pointer;">Dismiss Highlight</button>`
                : '';
            const deleteBtn = isAdmin
                ? `<button onclick="deleteAmendment(${a.id}, '${isNumber}')" style="background:transparent; border:none; color:var(--danger); font-size:1.15rem; cursor:pointer; padding:0 4px;" title="Delete Amendment">&times;</button>`
                : '';
            return `
                <div class="glass-panel" style="padding:14px; border:1px solid var(--glass-border); border-radius:8px; display:flex; justify-content:space-between; align-items:center; background:#ffffff;">
                    <div>
                        <div style="font-weight:700; color:var(--text-main); font-size:0.9rem; display:flex; align-items:center;">
                            ${escapeHtml(a.amendmentNumber)}${newTag}
                        </div>
                        <div style="font-size:0.8rem; color:var(--text-muted); margin-top:4px;">${escapeHtml(a.title)}</div>
                        <div style="font-size:0.75rem; color:#64748b; margin-top:6px;">Published: ${a.publishDate || 'Unknown'}</div>
                    </div>
                    <div style="display:flex; align-items:center; gap:10px;">
                        ${actionBtn}
                        ${deleteBtn}
                    </div>
                </div>
            `;
        }).join('');
    }

    modal.classList.add('active');
}

function closeAmendmentsModal() {
    const modal = document.getElementById('amendments-details-modal');
    if (modal) modal.classList.remove('active');
}

async function dismissAmendmentHighlight(amdId, isNumber) {
    try {
        const res = await fetch('/api/is-intelligence/amendments/toggle-new', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: amdId, isNew: false })
        });
        if (res.ok) {
            showToast('Amendment highlight dismissed.', 'success');
            await loadAmendments();
            // Refresh tables
            if (typeof renderTable === 'function') renderTable();
            if (typeof renderScTableFiltered === 'function') renderScTableFiltered();
            if (isActiveDocument && normalizeISNumber(isActiveDocument.isNumber) === isNumber) {
                renderISAmendments();
            }
            openAmendmentsModal(isNumber); // refresh modal view
        } else {
            showToast('Failed to dismiss highlight.', 'error');
        }
    } catch(e) {
        console.error(e);
        showToast('Error communicating with server.', 'error');
    }
}

async function deleteAmendment(amdId, isNumber) {
    if (!confirm('Are you sure you want to delete this amendment?')) return;
    try {
        const res = await fetch(`/api/is-intelligence/amendments/${amdId}`, {
            method: 'DELETE'
        });
        if (res.ok) {
            showToast('Amendment deleted successfully.', 'success');
            await loadAmendments();
            if (typeof renderTable === 'function') renderTable();
            if (typeof renderScTableFiltered === 'function') renderScTableFiltered();
            if (isActiveDocument && normalizeISNumber(isActiveDocument.isNumber) === isNumber) {
                renderISAmendments();
            }
            openAmendmentsModal(isNumber); // refresh modal view
        } else {
            showToast('Failed to delete amendment.', 'error');
        }
    } catch(e) {
        console.error(e);
        showToast('Error communicating with server.', 'error');
    }
}

async function loadAmendments() {
    try {
        const res = await fetch('/api/is-intelligence/amendments');
        const data = await res.json();
        
        isAmendmentsMap = {};
        const list = data.amendments || [];
        list.forEach(amd => {
            const norm = normalizeISNumber(amd.isNumber);
            if (!isAmendmentsMap[norm]) {
                isAmendmentsMap[norm] = {
                    count: 0,
                    hasNew: false,
                    list: []
                };
            }
            isAmendmentsMap[norm].list.push(amd);
            isAmendmentsMap[norm].count++;
            if (amd.isNew) {
                isAmendmentsMap[norm].hasNew = true;
            }
        });
    } catch(e) {
        console.error("Failed to load amendments from backend, using fallbacks:", e);
        const fallbackList = [
            { id: 1, isNumber: "IS 4985", amendmentNumber: "Amd 1", title: "Amendment No. 1 to IS 4985:2021", isNew: false, publishDate: "2022-05-10" },
            { id: 2, isNumber: "IS 4985", amendmentNumber: "Amd 2", title: "Amendment No. 2 to IS 4985:2021", isNew: false, publishDate: "2024-11-15" },
            { id: 3, isNumber: "IS 4985", amendmentNumber: "Amd 3", title: "Amendment No. 3 to IS 4985:2021", isNew: true, publishDate: "2026-05-01" },
            { id: 4, isNumber: "IS 14735", amendmentNumber: "Amd 1", title: "Amendment No. 1 to IS 14735:1999", isNew: true, publishDate: "2026-04-12" },
            { id: 5, isNumber: "IS 269", amendmentNumber: "Amd 1", title: "Amendment No. 1 to IS 269:2015", isNew: false, publishDate: "2018-09-05" },
            { id: 6, isNumber: "IS 269", amendmentNumber: "Amd 2", title: "Amendment No. 2 to IS 269:2015", isNew: false, publishDate: "2021-03-20" }
        ];
        isAmendmentsMap = {};
        fallbackList.forEach(amd => {
            const norm = normalizeISNumber(amd.isNumber);
            if (!isAmendmentsMap[norm]) {
                isAmendmentsMap[norm] = {
                    count: 0,
                    hasNew: false,
                    list: []
                };
            }
            isAmendmentsMap[norm].list.push(amd);
            isAmendmentsMap[norm].count++;
            if (amd.isNew) {
                isAmendmentsMap[norm].hasNew = true;
            }
        });
    }
}

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

function showComingSoon() {
    showToast('This feature is coming soon.', 'info');
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
            const displayRole = (currentUser.role === 'admin_sample_cell' || currentUser.role === 'super_admin') ? 'Super Admin' : currentUser.role === 'admin' ? 'Mechanical OIC' : 'TP';
            const userWelcomeEl = document.getElementById('user-welcome');
            if (userWelcomeEl) userWelcomeEl.textContent = `Welcome, ${currentUser.username} (${displayRole})`;
            
            document.getElementById('sidebar-nav').style.display = 'flex';
            
            toggleAdminViews();
            updateProfileUI(); // Populate avatar + profile page immediately on login
            // SRL: Land on New Sample Receive (Newly Received Queue) immediately after login
            // Side nav menus stay collapsed on login — user expands them manually.
            switchTab('tab-new-sample-receive');

            if (isSuperAdmin()) {
                loadSampleCellData();
                fetchScAuditLog();
            }
            
            showToast(`Welcome back, ${currentUser.username}!`, 'success');
            fetchSamples();
            loadPreferences();
            fetchTPUsers();
        } else {
            showToast(data.error || 'Login failed', 'error');
        }
    } catch (e) { 
        console.error(e); 
        showToast('Network Error: Is the server running?', 'error');
    }
}

function logout() {
    currentUser = null;
    toggleAdminViews();
    document.getElementById('dashboard-container').classList.remove('active');
    document.getElementById('auth-container').classList.add('active');
    document.getElementById('sidebar-nav').style.display = 'none';
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

function updateHeaderProfile() {
    if (!currentUser) return;
    
    const initials = getInitials(currentUser.username);
    
    // Map names/emails/roles to match the screenshot exactly for Admin user
    let displayEmail = `${currentUser.username.toLowerCase()}@bis.gov.in`;
    let displayRole = isSuperAdmin() ? 'Super Admin' : currentUser.role === 'admin' ? 'Mechanical OIC' : 'Testing Person (TP)';
    let welcomeName = currentUser.username;

    if (currentUser.username === 'Admin' || currentUser.role === 'admin') {
        welcomeName = 'Niraj Kumar Mahato (M)';
        displayEmail = 'nirajmahato@bis.gov.in';
        displayRole = 'OIC Testing';
    }

    const headerAvatarInitials = document.getElementById('header-avatar-initials');
    if (headerAvatarInitials) {
        headerAvatarInitials.textContent = initials;
    }

    const headerUserEmail = document.getElementById('header-user-email');
    if (headerUserEmail) {
        headerUserEmail.innerHTML = `${displayEmail} <i class="fas fa-chevron-down"></i>`;
    }

    // Update user-role spans in header
    const userRoleSpans = document.querySelectorAll('.user-role');
    userRoleSpans.forEach(span => {
        span.textContent = `You are logged in as ${displayRole}`;
    });

    // Update the large welcome text on the dashboard
    const dashboardWelcomeText = document.getElementById('dashboard-welcome-text');
    if (dashboardWelcomeText) {
        dashboardWelcomeText.textContent = `Hello ${welcomeName} (${displayRole})`;
    }
}

function updateProfileUI() {
    if (!currentUser) return;
    updateHeaderProfile();

    const initials = getInitials(currentUser.username);
    const displayRole = isSuperAdmin() ? 'Super Admin' : currentUser.role === 'admin' ? 'Mechanical OIC' : 'Testing Person (TP)';
    const accessLevel = isSuperAdmin() ? 'Full Access — Super Admin' : currentUser.role === 'admin' ? 'Mechanical OIC — Upload & Manage' : 'Standard TP — Own Samples Only';

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
    const myDueSoon = myPending.filter(s => calculateDaysOld(s.forwardedOn) > 15);

    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setEl('profile-stat-pending', myPending.length);
    setEl('profile-stat-priority', myPriority.length);
    setEl('profile-stat-submitted', mySubmitted.length);
    setEl('profile-stat-due-date', myDueSoon.length);

    const adminSection = document.getElementById('profile-admin-section');
    const vaultBtn = document.getElementById('profile-btn-confidential');
    
    if (adminSection) {
        if (isAdminOrSuperAdmin()) {
            adminSection.style.display = 'block';
            if (vaultBtn) {
                vaultBtn.style.display = isSuperAdmin() ? 'flex' : 'none';
            }
        } else {
            adminSection.style.display = 'none';
        }
    }

    if (isAdminOrSuperAdmin()) {
        checkDisposalReminders();
    }
}

// --- SKILL GRAPHIFY ---
let profileChartInstance = null;
let adminChartInstance = null;

function getProficiencyScore(level) {
    if (level === 'Expert') return 3;
    if (level === 'Standard') return 2;
    if (level === 'Trainee') return 1;
    return 0;
}

function renderSkillRadar(canvasId, competencies, chartInstanceObj, setChartObj) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;
    
    if (chartInstanceObj) chartInstanceObj.destroy();
    
    if (!competencies || competencies.length === 0) {
        setChartObj(new Chart(ctx, {
            type: 'radar',
            data: { labels: ['No Skills'], datasets: [{ data: [0] }] },
            options: { plugins: { legend: { display: false } }, scales: { r: { display: false, min: 0, max: 3 } } }
        }));
        return;
    }
    
    const labels = competencies.map(c => c.isNumber);
    const data = competencies.map(c => getProficiencyScore(c.proficiencyLevel));
    
    setChartObj(new Chart(ctx, {
        type: 'radar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Proficiency Level',
                data: data,
                backgroundColor: 'rgba(56, 189, 248, 0.2)',
                borderColor: 'rgba(56, 189, 248, 1)',
                pointBackgroundColor: 'rgba(255, 255, 255, 1)',
                pointBorderColor: 'rgba(56, 189, 248, 1)',
                pointHoverBackgroundColor: 'rgba(56, 189, 248, 1)',
                pointHoverBorderColor: 'rgba(255, 255, 255, 1)'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                r: {
                    angleLines: { color: 'rgba(255, 255, 255, 0.1)' },
                    grid: { color: 'rgba(255, 255, 255, 0.1)' },
                    pointLabels: { color: 'rgba(255, 255, 255, 0.7)', font: { size: 11, family: 'Inter' } },
                    ticks: {
                        display: false,
                        min: 0,
                        max: 3,
                        stepSize: 1
                    }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const val = context.raw;
                            if (val === 3) return 'Expert';
                            if (val === 2) return 'Standard';
                            if (val === 1) return 'Trainee';
                            return 'None';
                        }
                    }
                }
            }
        }
    }));
}

async function loadProfileSkillGraph() {
    if (!currentUser || !currentUser.id) return;
    try {
        const res = await fetch(`/api/admin/competencies/${currentUser.id}`);
        const data = await res.json();
        if (res.ok) {
            renderSkillRadar('profile-skill-radar', data.competencies, profileChartInstance, (c) => profileChartInstance = c);
        }
    } catch(e) {}
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
    
    // OICs (admins) and Super Admins should not see disposal alerts in their personal profile
    if (isAdminOrSuperAdmin()) return;

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
                        <td style="padding: 6px 4px; border-bottom: 1px solid rgba(0,0,0,0.05);">${getISNumberHtml(s.isNumber)}</td>
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
    // tab-pendancy is now merged into tab-new-sample-receive (SRL merged view)
    if (tabId === 'tab-pendancy') {
        tabId = 'tab-new-sample-receive';
    }

    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));

    const content = document.getElementById(tabId);
    if (content) content.classList.add('active');

    const btn = Array.from(document.querySelectorAll('.tab-btn')).find(b => b.getAttribute('onclick') === `switchTab('${tabId}')` || (tabId === 'tab-new-sample-receive' && b.getAttribute('onclick') === "switchTab('tab-pendancy')"));
    if (btn) btn.classList.add('active');

    // Load data specific to tabs
    if (tabId === 'tab-lims') {
        populateLimsISSelector().then(() => onLimsISChange());
        renderTestParametersTable();
    } else if (tabId === 'tab-employees') {
        loadEmployees();
        loadLeaves();
        populateLeaveEmployeeDropdown();
        ehUpdateKPIs();
    } else if (tabId === 'tab-leaves') {
        loadLeaves();
        populateLeaveEmployeeDropdown();
    } else if (tabId === 'tab-assigner') {
        loadUnassignedPool();
        loadRecommendations();
    } else if (tabId === 'tab-preferences') {
        loadPreferencesUI();
    } else if (tabId === 'tab-dashboard') {
        if (typeof renderAnalytics === 'function') renderAnalytics();
    } else if (tabId === 'tab-super-admin') {
        loadSampleCellData();
        fetchScAuditLog();
    } else if (tabId === 'tab-new-sample-receive') {
        // Un-hide all elements that might have been hidden by showTestingCompleted()
        const kpiRow = document.querySelector('#tab-new-sample-receive .kpi-row');
        if (kpiRow) kpiRow.style.display = 'flex';
        
        document.querySelectorAll('#tab-new-sample-receive .glass-panel').forEach(el => {
            if (el.textContent.includes('Aging Breakdown')) el.style.display = 'flex';
        });

        const nsrPending = document.getElementById('nsr-sub-pending');
        if (nsrPending) {
            Array.from(nsrPending.children).forEach(child => {
                if (child.id === 'submitted-wrapper') {
                    child.style.display = 'none'; // Will be managed by renderTable
                } else {
                    child.style.display = ''; // Reset to default display
                }
            });
        }
        
        // SRL merged view: render Allotted/Pending Queue
        renderTable();
    } else if (tabId === 'tab-equipment') {
        fetchAndRenderEquipments();
        fetchEquipmentStats();
    }

}


// --- PROFILE MODAL ---
function openProfileModal() {
    refreshProfileStats();
    const modal = document.getElementById('profile-modal');
    if (modal) modal.classList.add('active');
}

function closeProfileModal() {
    const modal = document.getElementById('profile-modal');
    if (modal) modal.classList.remove('active');
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
        if (res.ok) {
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
            const systemAccounts = data.users.filter(u => u.role !== 'tp');
            if (!systemAccounts.length) {
                tbody.innerHTML = `<tr><td colspan="3" style="padding:40px; text-align:center; color:#94a3b8; font-size:0.9rem;"><div style="font-size:2rem; margin-bottom:8px; opacity:0.35;">🛡️</div> No system accounts found.</td></tr>`;
            }
            systemAccounts.forEach(user => {
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
    
    closeModal('upload-center-modal');
    
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
            unrecognizedNameMapping = {};
            
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
        suggestionsHtml += '<option value="sNo">S.No. / Serial Number</option>';
        suggestionsHtml += '<option value="encodedCode">Sample Code / Encoded Code</option>';
        suggestionsHtml += '<option value="isNumber">IS Number</option>';
        suggestionsHtml += '<option value="assignedTo">Testing Person / TA Name</option>';
        suggestionsHtml += '<option value="receivedOn">Received Date</option>';
        suggestionsHtml += '<option value="forwardedOn">Forwarded Date</option>';
        suggestionsHtml += '<option value="reportStatus">Report Status</option>';
        suggestionsHtml += '<option value="quantity">Quantity</option>';
        suggestionsHtml += '<option value="totalTest">Total Tests</option>';
        suggestionsHtml += '<option value="pendingTest">Pending Tests</option>';
        suggestionsHtml += '<option value="approvedTest">Approved Tests</option>';
        suggestionsHtml += '<option value="pendencyDays">Pendency in Days</option>';
        
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

let unrecognizedNameMapping = {};

function levenshteinDistance(a, b) {
    const matrix = [];
    let i, j;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    for (i = 0; i <= b.length; i++) { matrix[i] = [i]; }
    for (j = 0; j <= a.length; j++) { matrix[0][j] = j; }
    for (i = 1; i <= b.length; i++) {
        for (j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) == a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1));
            }
        }
    }
    return matrix[b.length][a.length];
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
            
            const sortedTPs = [...allTPUsers].sort((a,b) => a.username.localeCompare(b.username));
            
            let itemsHtml = uploadMissingAccounts.map(name => {
                let bestMatch = "CREATE_NEW";
                let minD = Infinity;
                sortedTPs.forEach(tp => {
                    const d = levenshteinDistance(name.toLowerCase(), tp.username.toLowerCase());
                    if (d < minD) { minD = d; bestMatch = tp.username; }
                });
                
                // Auto-select if distance is small (<= 3 edits)
                if (minD > 3) bestMatch = "CREATE_NEW";
                
                unrecognizedNameMapping[name] = bestMatch;
                
                let optionsHtml = `<option value="CREATE_NEW" ${bestMatch==="CREATE_NEW" ? "selected":""}>➕ Create as New Account</option>`;
                sortedTPs.forEach(tp => {
                    optionsHtml += `<option value="${tp.username}" ${bestMatch===tp.username ? "selected":""}>${tp.username}</option>`;
                });
                
                return `
                <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px; padding:8px; background:rgba(0,0,0,0.03); border-radius:4px;">
                    <strong style="min-width: 200px;">${name}</strong>
                    <span>➡️</span>
                    <select onchange="unrecognizedNameMapping['${name}'] = this.value" style="padding:6px; border-radius:4px; border:1px solid #ccc; flex:1;">
                        ${optionsHtml}
                    </select>
                </div>
                `;
            }).join('');

            existingMissingBanner.innerHTML = `
                <strong>⚠️ ${uploadMissingAccounts.length} Unrecognized Name(s) Detected</strong>
                <p style="margin: 6px 0 12px;">The following names do not match any existing Testing Person perfectly. The system has automatically selected the closest matches. Please verify or map them to an existing employee.</p>
                <div style="display:flex; flex-direction:column;">
                    ${itemsHtml}
                </div>
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

    const duplicateCountEl = document.getElementById('duplicate-count');
    if (duplicateCountEl) duplicateCountEl.textContent = duplicates.length;

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
            columnMappingLog: Object.keys(pendingColumnMappings).length > 0 ? JSON.stringify(pendingColumnMappings) : null,
            nameMapping: unrecognizedNameMapping
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
let dueDateChartInstance = null;
let isVolumeChartInstance = null;
let pmPriorityChart = null;
let pmAllottedChart = null;
let pmTestingChart = null;
let pmReceivedChart = null;
let pmIsChart = null;

function renderPendencyMonitor() {
    if (typeof Chart === 'undefined') return;
    const pending = allSamples.filter(s => s.appStatus === 'Pending' || s.appStatus === 'PendingAccount' || s.appStatus === 'Submitted');

    const getDays = s => {
        if (s.pendencyDays && !isNaN(parseInt(s.pendencyDays))) return parseInt(s.pendencyDays);
        return calculateDaysOld(s.receivedOn || s.forwardedOn);
    };

    // (i) Day-wise buckets
    let lt30=0, d3145=0, d4660=0, d6190=0, gt90=0;
    pending.forEach(s => {
        const d = getDays(s);
        if (d <= 30) lt30++;
        else if (d <= 45) d3145++;
        else if (d <= 60) d4660++;
        else if (d <= 90) d6190++;
        else gt90++;
    });
    const setEl = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    setEl('pm-day-lt30', lt30);
    setEl('pm-day-31-45', d3145);
    setEl('pm-day-46-60', d4660);
    setEl('pm-day-61-90', d6190);
    setEl('pm-day-gt90', gt90);

    const makeDonut = (canvasId, labels, data, colors, legendId) => {
        const ctx = document.getElementById(canvasId);
        if (!ctx) return;
        const existing = Chart.getChart(ctx);
        if (existing) existing.destroy();
        new Chart(ctx, {
            type: 'doughnut',
            data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: '#fff' }] },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${ctx.raw}` } } },
                cutout: '65%'
            }
        });
        const leg = document.getElementById(legendId);
        if (leg) leg.innerHTML = labels.map((l, i) => `<span style="display:inline-flex;align-items:center;gap:4px;margin:2px 6px;"><span style="width:10px;height:10px;border-radius:50%;background:${colors[i]};display:inline-block;"></span>${l}: <strong>${data[i]}</strong></span>`).join('');
    };

    // (v) Priority vs Non-Priority
    const priCount = pending.filter(s => isTopPriority(s)).length;
    const nonPriCount = pending.length - priCount;
    makeDonut('pm-priority-chart', ['Priority', 'Non-Priority'], [priCount, nonPriCount], ['#f59e0b', '#3b82f6'], 'pm-priority-legend');

    // (vi) Allotted vs Not Allotted
    const allotted = pending.filter(s => s.assignedTo && s.assignedTo.trim()).length;
    const notAllotted = pending.length - allotted;
    makeDonut('pm-allotted-chart', ['Allotted', 'Not Allotted'], [allotted, notAllotted], ['#10b981', '#94a3b8'], 'pm-allotted-legend');

    // (vii) Testing Started vs Not Started
    const testingStarted = allSamples.filter(s => s.appStatus === 'Testing' || s.appStatus === 'Submitted').length;
    const notStarted = allSamples.filter(s => s.appStatus === 'Pending' || s.appStatus === 'PendingAccount').length;
    makeDonut('pm-testing-chart', ['Testing Done', 'Not Started'], [testingStarted, notStarted], ['#8b5cf6', '#e2e8f0'], 'pm-testing-legend');

    // (iii) Received Date Wise — monthly
    const monthCounts = {};
    pending.forEach(s => {
        if (!s.receivedOn) return;
        const parts = s.receivedOn.split('-');
        if (parts.length < 3) return;
        const label = `${parts[1]}/${parts[2].slice(-2)}`; // MM/YY
        monthCounts[label] = (monthCounts[label] || 0) + 1;
    });
    const sortedMonths = Object.keys(monthCounts).sort((a, b) => {
        const [am, ay] = a.split('/'); const [bm, by] = b.split('/');
        return (parseInt(ay)*12 + parseInt(am)) - (parseInt(by)*12 + parseInt(bm));
    });
    const recCtx = document.getElementById('pm-received-chart');
    if (recCtx) {
        const ex = Chart.getChart(recCtx); if (ex) ex.destroy();
        new Chart(recCtx, {
            type: 'bar',
            data: { labels: sortedMonths, datasets: [{ label: 'Samples Received', data: sortedMonths.map(m => monthCounts[m]), backgroundColor: 'rgba(99,102,241,0.7)', borderColor: '#4f46e5', borderWidth: 1, borderRadius: 4 }] },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { color: '#64748b' } }, x: { ticks: { color: '#64748b' } } } }
        });
    }

    // (ii) TP-wise table
    const tpMap = {};
    pending.forEach(s => {
        const tp = s.assignedTo || '— Unassigned —';
        if (!tpMap[tp]) tpMap[tp] = { total: 0, lt30: 0, critical: 0 };
        tpMap[tp].total++;
        const d = getDays(s);
        if (d <= 30) tpMap[tp].lt30++;
        if (d > 60) tpMap[tp].critical++;
    });
    const tpTableEl = document.getElementById('pm-tp-table');
    if (tpTableEl) {
        const sorted = Object.entries(tpMap).sort((a, b) => b[1].total - a[1].total);
        tpTableEl.innerHTML = `
            <table style="width:100%; border-collapse:collapse;">
                <thead><tr style="background:#f8fafc; position:sticky; top:0;">
                    <th style="text-align:left; padding:6px 8px; color:#475569; font-size:0.75rem; border-bottom:1px solid #e2e8f0;">TP Name</th>
                    <th style="text-align:center; padding:6px 8px; color:#475569; font-size:0.75rem; border-bottom:1px solid #e2e8f0;">Total</th>
                    <th style="text-align:center; padding:6px 8px; color:#047857; font-size:0.75rem; border-bottom:1px solid #e2e8f0;">≤30d</th>
                    <th style="text-align:center; padding:6px 8px; color:#b91c1c; font-size:0.75rem; border-bottom:1px solid #e2e8f0;">>60d</th>
                </tr></thead>
                <tbody>${sorted.map(([tp, v], i) => `
                    <tr style="background:${i%2===0?'#fff':'#f8fafc'};">
                        <td style="padding:5px 8px; color:#0f172a; font-size:0.78rem; max-width:140px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(tp)}</td>
                        <td style="text-align:center; padding:5px 8px; font-weight:700; color:#1e293b;">${v.total}</td>
                        <td style="text-align:center; padding:5px 8px; color:#047857;">${v.lt30}</td>
                        <td style="text-align:center; padding:5px 8px; color:${v.critical>0?'#b91c1c':'#94a3b8'}; font-weight:${v.critical>0?'700':'400'};">${v.critical}</td>
                    </tr>`).join('')}
                </tbody>
            </table>`;
    }

    // (iv) IS Number wise (top 20)
    const isMap = {};
    pending.forEach(s => {
        const is = s.isNumber || 'Unknown';
        isMap[is] = (isMap[is] || 0) + 1;
    });
    const top20IS = Object.entries(isMap).sort((a, b) => b[1] - a[1]).slice(0, 20);
    const isCtx = document.getElementById('pm-is-chart');
    if (isCtx) {
        const ex = Chart.getChart(isCtx); if (ex) ex.destroy();
        new Chart(isCtx, {
            type: 'bar',
            data: { labels: top20IS.map(e => e[0]), datasets: [{ label: 'Pending', data: top20IS.map(e => e[1]), backgroundColor: top20IS.map((_, i) => `hsl(${220 + i*6},70%,${55 + i%3*5}%)`), borderWidth: 0, borderRadius: 4 }] },
            options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { color: '#64748b' } }, y: { ticks: { color: '#64748b', font: { size: 10 } } } } }
        });
    }
}

function renderAnalytics() {
    if (typeof Chart === 'undefined') return;
    renderPendencyMonitor();
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
        setLimsISValue(`IS ${matchedSample.isNumber}`);
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

function formatDateDDMMYYYY(date) {
    if (!date) return '—';
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}-${month}-${year}`;
}

function populateFilterDropdowns() {
    // Enhance all samples with computed fields
    const enhanced = allSamples.map(s => ({
        ...s,
        _daysOld: calculateDaysOld(s.forwardedOn),
        _isTopPriority: isTopPriority(s)
    }));

    const pendingAll = enhanced.filter(s => (s.appStatus === 'Pending' || s.appStatus === 'PendingAccount'));

    // Apply KPI filter to find the active set for dropdown counts
    let baseActiveSamples = pendingAll;
    if (kpiFilter === 'Priority') {
        baseActiveSamples = pendingAll.filter(s => s._isTopPriority);
    } else if (kpiFilter === 'Urgent') {
        baseActiveSamples = pendingAll.filter(s => !s._isTopPriority && s._daysOld > 15);
    } else if (kpiFilter === 'Submitted') {
        baseActiveSamples = [];
    } else if (kpiFilter === 'Unassigned') {
        baseActiveSamples = enhanced.filter(s => s.appStatus === 'Pending' && !s.assignedTo);
    }

    const isFilterNode = document.getElementById('is-filter');
    const priorityFilterNode = document.getElementById('priority-filter');
    const dateFilterNode = document.getElementById('date-filter');
    const assignedFilterNode = document.getElementById('assigned-filter');

    const currentIs = isFilterNode ? isFilterNode.value : 'ALL';
    const currentPri = priorityFilterNode ? priorityFilterNode.value : 'ALL';
    const currentDate = dateFilterNode ? dateFilterNode.value : 'ALL';
    const currentAssigned = assignedFilterNode ? assignedFilterNode.value : 'ALL';

    const matchIs = (s, val) => val === 'ALL' || s.isNumber === val;
    const matchPri = (s, val) => val === 'ALL' || (val === 'Priority' ? s._isTopPriority : !s._isTopPriority);
    const matchDate = (s, val) => val === 'ALL' || s.receivedOn === val;
    const matchAssigned = (s, val) => val === 'ALL' || s.assignedTo === val;

    // 1. IS Number Filter (Apply Pri, Date, Assigned)
    if (isFilterNode) {
        const activeForIs = baseActiveSamples.filter(s => matchPri(s, currentPri) && matchDate(s, currentDate) && matchAssigned(s, currentAssigned));
        const isCounts = {};
        activeForIs.forEach(s => {
            if (s.isNumber) isCounts[s.isNumber] = (isCounts[s.isNumber] || 0) + 1;
        });
        const uniqueIS = Object.keys(isCounts).sort();
        isFilterNode.innerHTML = '<option value="ALL">All IS Numbers</option>';
        uniqueIS.forEach(isNum => {
            const opt = document.createElement('option');
            opt.value = isNum;
            opt.textContent = `${isNum} (${isCounts[isNum]})`;
            isFilterNode.appendChild(opt);
        });
        if (uniqueIS.includes(currentIs)) {
            isFilterNode.value = currentIs;
        } else {
            isFilterNode.value = 'ALL';
        }
    }

    // 2. Priority Filter (Apply IS, Date, Assigned)
    if (priorityFilterNode) {
        const activeForPri = baseActiveSamples.filter(s => matchIs(s, currentIs) && matchDate(s, currentDate) && matchAssigned(s, currentAssigned));
        const priorityCounts = { 'Priority': 0, 'Non-Priority': 0 };
        activeForPri.forEach(s => {
            if (s._isTopPriority) priorityCounts['Priority']++;
            else priorityCounts['Non-Priority']++;
        });
        priorityFilterNode.innerHTML = `
            <option value="ALL">All Priorities</option>
            <option value="Priority">Priority (${priorityCounts['Priority']})</option>
            <option value="Non-Priority">Non-Priority (${priorityCounts['Non-Priority']})</option>
        `;
        if (currentPri === 'Priority' || currentPri === 'Non-Priority') {
            priorityFilterNode.value = currentPri;
        } else {
            priorityFilterNode.value = 'ALL';
        }
    }

    // 3. Received Date Filter (Apply IS, Pri, Assigned)
    if (dateFilterNode) {
        const activeForDate = baseActiveSamples.filter(s => matchIs(s, currentIs) && matchPri(s, currentPri) && matchAssigned(s, currentAssigned));
        const dateCounts = {};
        activeForDate.forEach(s => {
            if (s.receivedOn) dateCounts[s.receivedOn] = (dateCounts[s.receivedOn] || 0) + 1;
        });
        const uniqueDates = Object.keys(dateCounts).sort((a,b) => {
            const dateA = parseDateDDMMYYYY(a);
            const dateB = parseDateDDMMYYYY(b);
            if (!dateA) return 1;
            if (!dateB) return -1;
            return dateA - dateB;
        });
        dateFilterNode.innerHTML = '<option value="ALL">All Received Dates</option>';
        uniqueDates.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d;
            opt.textContent = `${d} (${dateCounts[d]})`;
            dateFilterNode.appendChild(opt);
        });
        if (uniqueDates.includes(currentDate)) {
            dateFilterNode.value = currentDate;
        } else {
            dateFilterNode.value = 'ALL';
        }
    }

    // 4. Assigned To Filter (Apply IS, Pri, Date)
    if (assignedFilterNode) {
        const activeForAssigned = baseActiveSamples.filter(s => matchIs(s, currentIs) && matchPri(s, currentPri) && matchDate(s, currentDate));
        const assignedCounts = {};
        activeForAssigned.forEach(s => {
            if (s.assignedTo) assignedCounts[s.assignedTo] = (assignedCounts[s.assignedTo] || 0) + 1;
        });
        const uniqueAssigned = Object.keys(assignedCounts).sort();
        assignedFilterNode.innerHTML = '<option value="ALL">All Testing Persons</option>';
        uniqueAssigned.forEach(tp => {
            const opt = document.createElement('option');
            opt.value = tp;
            opt.textContent = `${tp} (${assignedCounts[tp]})`;
            assignedFilterNode.appendChild(opt);
        });
        if (uniqueAssigned.includes(currentAssigned)) {
            assignedFilterNode.value = currentAssigned;
        } else {
            assignedFilterNode.value = 'ALL';
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
    switchNsrSubTab('pending');
    populateFilterDropdowns();
    renderTable();
}

// Always force-shows Testing Completed (no toggle behaviour) — used by sidebar nav
function showTestingCompleted() {
    try {
        kpiFilter = 'Submitted';
        
        // 1. Hide the KPI cards row
        const kpiRow = document.querySelector('#tab-new-sample-receive .kpi-row');
        if (kpiRow) kpiRow.style.display = 'none';

        // 2. Hide the Aging Breakdown panel
        document.querySelectorAll('#tab-new-sample-receive .glass-panel').forEach(el => {
            if (el.textContent.includes('Aging Breakdown')) {
                el.style.display = 'none';
            }
        });

        // 3. Hide the main pending queue elements specifically
        const controlsBar = document.querySelector('#nsr-sub-pending .controls-bar');
        const tableHeader = document.querySelector('#nsr-sub-pending .table-section-header');
        const mainTable = document.querySelector('#nsr-sub-pending .table-container');
        
        if (controlsBar) controlsBar.style.display = 'none';
        if (tableHeader) tableHeader.style.display = 'none';
        if (mainTable) mainTable.style.display = 'none';

        // 4. Render the data
        populateFilterDropdowns();
        renderTable();

        // 5. Explicitly guarantee the submitted wrapper is visible
        const submittedWrapper = document.getElementById('submitted-wrapper');
        if (submittedWrapper) {
            submittedWrapper.style.display = 'block';
            submittedWrapper.style.opacity = '1';
            submittedWrapper.style.visibility = 'visible';
            
            // Scroll to it
            setTimeout(() => {
                submittedWrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 100);
        }
    } catch (e) {
        console.error("Error in showTestingCompleted:", e);
    }
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

    populateFilterDropdowns();

    const showAction = currentUser && ['ta', 'tp', 'lo', 'admin', 'super_admin'].includes(currentUser.role.toLowerCase());
    const actionHeader = document.getElementById('th-action');
    if (actionHeader) {
        actionHeader.style.display = showAction ? '' : 'none';
    }

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

    const kpiTotalCard = document.getElementById('kpi-card-total');
    if (kpiTotalCard) kpiTotalCard.classList.toggle('active-filter', kpiFilter === 'ALL');
    const kpiPriorityCard = document.getElementById('kpi-card-priority');
    if (kpiPriorityCard) kpiPriorityCard.classList.toggle('active-filter', kpiFilter === 'Priority');
    const kpiUrgentCard = document.getElementById('kpi-card-urgent');
    if (kpiUrgentCard) kpiUrgentCard.classList.toggle('active-filter', kpiFilter === 'Urgent');
    const kpiSubmittedCard = document.getElementById('kpi-card-submitted');
    if (kpiSubmittedCard) kpiSubmittedCard.classList.toggle('active-filter', kpiFilter === 'Submitted');
    const kpiUnassignedCard = document.getElementById('kpi-card-unassigned');
    if (kpiUnassignedCard) kpiUnassignedCard.classList.toggle('active-filter', kpiFilter === 'Unassigned');

    const pill15 = document.getElementById('pill-age15');
    if (pill15) pill15.style.opacity = kpiFilter === 'Age15' ? '1' : '0.6';
    const pill30 = document.getElementById('pill-age30');
    if (pill30) pill30.style.opacity = kpiFilter === 'Age30' ? '1' : '0.6';
    const pill45 = document.getElementById('pill-age45');
    if (pill45) pill45.style.opacity = kpiFilter === 'Age45' ? '1' : '0.6';
    const pill90 = document.getElementById('pill-age90');
    if (pill90) pill90.style.opacity = kpiFilter === 'Age90' ? '1' : '0.6';
    const pillOld = document.getElementById('pill-ageold');
    if (pillOld) pillOld.style.opacity = kpiFilter === 'Age>90' ? '1' : '0.6';

    // Enhance all samples with computed fields
    const enhanced = allSamples.map(s => ({
        ...s,
        _daysOld: calculateDaysOld(s.forwardedOn),
        _isTopPriority: isTopPriority(s)
    }));

    // --- Apply Table Filters First ---
    const baseFilterFn = (s) => {
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
    };

    const pendingAll = enhanced.filter(s => (s.appStatus === 'Pending' || s.appStatus === 'PendingAccount')).filter(baseFilterFn);
    const unassignedAll = enhanced.filter(s => s.appStatus === 'Pending' && !s.assignedTo).filter(baseFilterFn);
    const submittedAll = enhanced.filter(s => s.appStatus === 'Submitted').filter(baseFilterFn);
    
    // --- Update KPI counters based on filtered data ---
    document.getElementById('kpi-total').textContent = pendingAll.length;
    const pSuffixEl = document.getElementById('kpi-p-suffix');
    if (pSuffixEl) pSuffixEl.textContent = pendingAll.filter(s => s._isTopPriority).length;
    const kpiUrgentEl = document.getElementById('kpi-urgent');
    if (kpiUrgentEl) kpiUrgentEl.textContent = pendingAll.filter(s => !s._isTopPriority && s._daysOld > 15).length;
    document.getElementById('kpi-submitted').textContent = submittedAll.length;
    
    const page15 = document.getElementById('pend-age-15');
    if (page15) page15.textContent = pendingAll.filter(s => s._daysOld <= 15).length;
    const page30 = document.getElementById('pend-age-30');
    if (page30) page30.textContent = pendingAll.filter(s => s._daysOld > 15 && s._daysOld <= 30).length;
    const page45 = document.getElementById('pend-age-45');
    if (page45) page45.textContent = pendingAll.filter(s => s._daysOld > 30 && s._daysOld <= 45).length;
    const page90 = document.getElementById('pend-age-90');
    if (page90) page90.textContent = pendingAll.filter(s => s._daysOld > 45 && s._daysOld <= 90).length;
    const pageOld = document.getElementById('pend-age-old');
    if (pageOld) pageOld.textContent = pendingAll.filter(s => s._daysOld > 90).length;
    
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

    // --- Pending Queue: Apply KPI filter ---
    let pending = [...pendingAll];
    if (kpiFilter === 'Priority') {
        pending = pending.filter(s => s._isTopPriority);
    } else if (kpiFilter === 'Urgent') {
        pending = pending.filter(s => !s._isTopPriority && s._daysOld > 15);
    } else if (kpiFilter === 'Submitted') {
        pending = []; // show only submitted section when Submitted KPI clicked
    } else if (kpiFilter === 'Age15') {
        pending = pending.filter(s => s._daysOld <= 15);
    } else if (kpiFilter === 'Age30') {
        pending = pending.filter(s => s._daysOld > 15 && s._daysOld <= 30);
    } else if (kpiFilter === 'Age45') {
        pending = pending.filter(s => s._daysOld > 30 && s._daysOld <= 45);
    } else if (kpiFilter === 'Age90') {
        pending = pending.filter(s => s._daysOld > 45 && s._daysOld <= 90);
    } else if (kpiFilter === 'Age>90') {
        pending = pending.filter(s => s._daysOld > 90);
    } else if (kpiFilter === 'Unassigned') {
        // Special case: show only unassigned samples
        pending = [...unassignedAll];
    }

    // Sort: Priority first, then urgency (days old)
    pending.sort((a, b) => {
        if (a._isTopPriority && !b._isTopPriority) return -1;
        if (!a._isTopPriority && b._isTopPriority) return 1;
        return b._daysOld - a._daysOld;
    });



    // Render pending rows
    if (pending.length === 0 && kpiFilter !== 'Submitted') {
        tbody.innerHTML = `<tr><td colspan="13" style="text-align:center; padding:30px; color:var(--sidebar-text);">🎉 No pending samples match the current filters.</td></tr>`;
    } else if (kpiFilter === 'Submitted') {
        tbody.innerHTML = `<tr><td colspan="13" style="text-align:center; padding:30px; color:var(--sidebar-text);">Viewing Testing Completed — submitted samples are shown below.</td></tr>`;
    } else {
        const isAdmin = isAdminOrSuperAdmin();
        pending.forEach(s => {
            const tr = document.createElement('tr');

            const checkboxHtml = isAdmin ? `<input type="checkbox" class="sample-row-checkbox" value="${s.id}" onchange="updateSelectedCount()" style="cursor:pointer; width:14px; height:14px; margin-right:8px; vertical-align:middle;">` : '';
            
            // PRIORITY PR/NP
            let priorityHtml = s.priorityLevel || 'Standard';
            if (s._isTopPriority) priorityHtml = `<span style="color:#d97706; font-weight:600;">Priority</span>`;

            // TEST BEFORE
            let testBefore = '—';
            if (s.forwardedOn) {
                const targetDate = parseDateDDMMYYYY(s.forwardedOn);
                if (targetDate) {
                    targetDate.setDate(targetDate.getDate() + 30);
                    testBefore = targetDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
                }
            }

            // ASSIGNED TO
            const assignedHtml = s.assignedTo ? s.assignedTo : '<span style="color:#f59e0b;">Unassigned</span>';

            // TESTING STATUS
            let statusBlock = s.appStatus;
            if (s.appStatus === 'PendingAccount') {
                statusBlock = '<span style="color:#d97706; font-weight:600;">Pending Account</span>';
            } else if (s.appStatus === 'Testing') {
                statusBlock = '<span style="display:inline-block; padding:3px 10px; border-radius:20px; background:#dcfce7; color:#15803d; font-size:0.75rem; font-weight:700;">🔬 Testing</span>';
            }

            // ACTION
            const isMyAssignedSample = s.assignedTo && currentUser &&
                s.assignedTo.toLowerCase() === currentUser.username.toLowerCase();
            const canStartTesting = (isMyAssignedSample || isAdminOrSuperAdmin()) && s.appStatus === 'Pending' && s.assignedTo;
            let startTestBtn = canStartTesting
                ? `<button onclick="startTesting(${s.id}, '${s.encodedCode}')" class="btn-premium" style="background:#f0fdf4; color:#15803d; border:1px solid #86efac; padding:3px 6px; font-size:0.6rem; border-radius:2px; box-shadow:none; white-space:nowrap;">▶</button>`
                : '';
            let submitBtn = showAction && (s.appStatus === 'Testing' || s.appStatus === 'PendingAccount') ? `<button onclick="openSubmitModal(${s.id}, '${s.encodedCode}')" class="btn-premium primary" style="padding:3px 6px; font-size:0.6rem; border-radius:2px; box-shadow:none; white-space:nowrap;">Send</button>` : '';
            if (showAction && s.appStatus === 'Pending' && !s.assignedTo) {
                submitBtn = `<button disabled class="btn-premium" style="background:#e2e8f0; color:#94a3b8; cursor:not-allowed; padding:3px 6px; font-size:0.6rem; border-radius:2px; box-shadow:none; white-space:nowrap;">🔒</button>`;
            }
            const deleteBtn = isAdmin ? `<button class="btn-icon" style="background:#fef2f2; border:1px solid #fecaca; color:#ef4444; padding:3px 5px;" onclick="deleteSingleSample(${s.id}, '${s.encodedCode}')" title="Delete"><i class="fas fa-trash"></i></button>` : '';

            const checkboxTd = isAdmin ? `<td style="text-align:center;">${checkboxHtml}</td>` : `<td style="display:none;"></td>`;

            tr.innerHTML = `
                ${checkboxTd}
                <td class="col-pin-left" style="padding:8px 6px; font-weight:600; color:#0f172a; font-size:0.65rem;">${s.encodedCode}</td>
                <td style="padding:8px 6px; color:#475569; font-size:0.65rem;">${getISNumberHtml(s.isNumber)}</td>
                <td style="padding:8px 6px; color:#475569; text-align:center; font-size:0.65rem;">${s.quantity || '—'}</td>
                <td style="padding:8px 6px; text-align:center; font-size:0.65rem;">${priorityHtml}</td>
                <td style="padding:8px 6px; color:#475569; text-align:center; font-size:0.65rem;">${s.receivedOn || '—'}</td>
                <td style="padding:8px 6px; color:#475569; text-align:center; font-size:0.65rem;">${s.forwardedOn || '—'}</td>
                <td style="padding:8px 6px; color:#475569; text-align:center; font-size:0.65rem;">${testBefore}</td>
                <td style="padding:8px 6px; color:#475569; font-size:0.65rem;">${assignedHtml}</td>
                <td style="padding:8px 6px; text-align:center; font-size:0.65rem;" class="status-block">${statusBlock}</td>
                <td style="padding:8px 6px; text-align:center;">
                    <button class="btn-icon" onclick="openJobcard('${s.id}')" title="Print Jobcard" style="font-size:0.9rem;"><i class="fas fa-print"></i></button>
                </td>
                <td style="padding:8px 6px; text-align:center;">
                    <button class="btn-icon" onclick="openClarifications('${s.id}')" title="View Clarifications" style="font-size:0.9rem;"><i class="fas fa-comments"></i></button>
                </td>
                <td style="padding:8px 6px; text-align:center;">
                    <button class="btn-icon" onclick="openSampleLogs('${s.id}')" title="View Logs" style="font-size:0.9rem;"><i class="fas fa-history"></i></button>
                </td>
                <td class="col-pin-right" style="padding:8px 4px; text-align:center;">
                    <div style="display:flex; justify-content:center; align-items:center; gap:2px; flex-wrap:nowrap;">
                        <button class="btn-premium primary" style="background:#10b981; padding:3px 6px; font-size:0.6rem; border-radius:2px; box-shadow:none;" onclick="handleNsrVerify('${s.encodedCode}')">✓</button>
                        ${startTestBtn}
                        ${submitBtn}
                        <button class="btn-icon" style="background:#eef2ff; border:1px solid #c7d2fe; color:#4f46e5; padding:3px 5px; font-size:0.75rem;" onclick="openTestReportModal(${s.id}, '${s.encodedCode}', '${s.isNumber}')" title="Test Report">📋</button>
                        <button class="btn-icon" style="background:#f8fafc; border:1px solid #e2e8f0; color:#475569; padding:3px 5px; font-size:0.75rem;" onclick="handleNsrAction('${s.encodedCode}')" title="More"><i class="fas fa-ellipsis-v"></i></button>
                        ${deleteBtn}
                    </div>
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

        const checkboxTd = isAdmin ? `<td style="text-align:center;"><input type="checkbox" class="sample-row-checkbox-disposal" value="${s.id}" onchange="updateSelectedCountDisposal()" style="cursor:pointer; width:16px; height:16px;"></td>` : `<td style="display:none;"></td>`;

        tr.innerHTML = `
            ${checkboxTd}
            <td class="col-pin-left" style="color:var(--accent); font-weight:600;">${s.encodedCode}</td>
            <td style="color:var(--text-muted);">${getISNumberHtml(s.isNumber)}</td>
            <td><strong>${s.assignedTo || '—'}</strong></td>
            <td>${s.forwardedOn || '—'}</td>
            <td><span class="status-badge ${passFailClass}">${s.passFail}</span></td>
            <td>${disposalHtml}</td>
        `;
        tr.classList.add(s.passFail === 'Pass' ? 'row-success-green' : 'row-warning-yellow');
        submittedTbody.appendChild(tr);
    });
}

async function startTesting(id, code) {
    if (!confirm(`Mark "${code}" as Testing Started?`)) return;
    try {
        const res = await fetch(`/api/samples/${id}/start-testing`, { method: 'POST' });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed');
        showToast(`Testing started for ${code}`, 'success');
        await fetchSamples();
    } catch (e) {
        showToast(e.message, 'error');
    }
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
            closeModal('submit-modal');
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
    const fileInput = document.getElementById('excel-file');
    const overlay = document.getElementById('global-drag-overlay');
    if (!fileInput) return;

    let dragCounter = 0;

    // Window level drag events to show the full-screen overlay
    window.addEventListener('dragenter', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter++;
        // Only show overlay if the user is an admin/super admin
        if (isAdminOrSuperAdmin() && overlay) {
            overlay.style.display = 'flex';
        }
    });

    window.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    window.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter--;
        if (dragCounter === 0 && overlay) {
            overlay.style.display = 'none';
        }
    });

    window.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter = 0;
        if (overlay) overlay.style.display = 'none';
        
        if (!isAdminOrSuperAdmin()) return;

        const files = e.dataTransfer.files;
        if (files.length) {
            handleFileSelect(files[0]);
            // User must explicitly click Analyze Document now
        }
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length) {
            handleFileSelect(e.target.files[0]);
            // User must explicitly click Analyze Document now
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
    
    // Update new Upload Engine Modal UI
    const filenameLabel = document.getElementById('master-upload-filename');
    const analyzeBtn = document.getElementById('master-analyze-btn');
    
    if (file) {
        if (filenameLabel) {
            filenameLabel.innerHTML = `<strong>Selected:</strong> ${file.name}`;
            filenameLabel.style.color = 'var(--primary)';
        }
        if (analyzeBtn) {
            analyzeBtn.style.display = 'block';
        }
    } else {
        if (filenameLabel) {
            filenameLabel.textContent = 'or click to browse files';
            filenameLabel.style.color = '';
        }
        if (analyzeBtn) analyzeBtn.style.display = 'none';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    loadAmendments();
    initializeDragAndDrop();
    toggleAdminViews();
    checkActiveLimsOnLoad();
    loadIS4985LimitsOverride();
    setupCustomDropdowns();

    // Mobile sidebar toggle
    const menuToggle = document.querySelector('.menu-toggle');
    const sidebar = document.getElementById('sidebar-nav');
    const overlay = document.getElementById('sidebar-overlay');

    function closeMobileSidebar() {
        if (sidebar) sidebar.classList.remove('mobile-open');
        if (overlay) overlay.classList.remove('open');
    }

    if (menuToggle) {
        menuToggle.addEventListener('click', () => {
            if (!sidebar || sidebar.style.display === 'none') return;
            if (window.innerWidth > 1024) {
                // Desktop: collapse/expand the side panel; content reflows to fill
                document.body.classList.toggle('sidebar-collapsed');
            } else {
                // Mobile/tablet: slide the sidebar in/out over the content
                sidebar.classList.toggle('mobile-open');
                if (overlay) overlay.classList.toggle('open');
            }
        });
    }
    if (overlay) {
        overlay.addEventListener('click', closeMobileSidebar);
    }

    // Close sidebar on nav item click (mobile)
    document.querySelectorAll('.sidebar-nav .tab-btn:not(.toggle-menu)').forEach(btn => {
        btn.addEventListener('click', () => {
            if (window.innerWidth <= 1024) closeMobileSidebar();
        });
    });
    document.querySelectorAll('.sidebar-nav .sub-nav-item').forEach(btn => {
        btn.addEventListener('click', () => {
            if (window.innerWidth <= 1024) closeMobileSidebar();
        });
    });

    // Toggle Sub-menus in Sidebar
    const toggleMenus = document.querySelectorAll('.toggle-menu');
    toggleMenus.forEach(menu => {
        menu.addEventListener('click', (e) => {
            e.preventDefault();
            menu.classList.toggle('nav-category');
            const subMenu = menu.nextElementSibling;
            const chevron = menu.querySelector('.chevron');
            if (subMenu && subMenu.classList.contains('sub-menu')) {
                if (subMenu.style.display === 'none' || subMenu.style.display === '') {
                    subMenu.style.display = 'block';
                    if (chevron) {
                        chevron.classList.remove('fa-chevron-right');
                        chevron.classList.add('fa-chevron-down');
                    }
                } else {
                    subMenu.style.display = 'none';
                    if (chevron) {
                        chevron.classList.remove('fa-chevron-down');
                        chevron.classList.add('fa-chevron-right');
                    }
                }
            }
        });
    });
});

// --- Admin Utilities & Bulk Actions ---

function toggleAdminViews() {
    const isAdmin = currentUser && isAdminOrSuperAdmin();
    const isSuper = currentUser && isSuperAdmin();
    
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
    const adminUploadSection = document.getElementById('admin-upload-section');
    if (adminUploadSection) adminUploadSection.style.display = isAdmin ? 'block' : 'none';



    const auditBtn = document.getElementById('tab-btn-audit');
    if (auditBtn) auditBtn.style.display = isAdmin ? 'inline-block' : 'none';
    
    const employeesBtn = document.getElementById('tab-btn-employees');
    if (employeesBtn) employeesBtn.style.display = isAdmin ? 'inline-block' : 'none';

    const leavesBtn = document.getElementById('tab-btn-leaves');
    if (leavesBtn) leavesBtn.style.display = isAdmin ? 'inline-block' : 'none';

    // Toggle confidential vault tab
    const confidentialBtn = document.getElementById('profile-btn-confidential');
    if (confidentialBtn) confidentialBtn.style.display = isSuperAdmin() ? 'flex' : 'none';

    const assignerBtn = document.getElementById('tab-btn-assigner');
    if (assignerBtn) assignerBtn.style.display = isAdmin ? 'inline-block' : 'none';

    const analyticsBtn = document.getElementById('tab-btn-analytics');
    if (analyticsBtn) analyticsBtn.style.display = isAdmin ? 'inline-block' : 'none';

    const preferencesBtn = document.getElementById('tab-btn-preferences');
    if (preferencesBtn) preferencesBtn.style.display = isAdmin ? 'inline-block' : 'none';

    const superAdminBtn = document.getElementById('tab-btn-super-admin');
    if (superAdminBtn) superAdminBtn.style.display = isSuper ? 'block' : 'none';

    const limsBtn = document.getElementById('tab-btn-lims');
    if (limsBtn) limsBtn.style.display = isAdmin ? 'block' : 'none';

    const adminCategory = document.getElementById('nav-admin-category');
    if (adminCategory) adminCategory.style.display = isSuper ? 'flex' : 'none';
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

// ─── Generic IS report: drive the LIMS report from the IS Intelligence vault ───
function limsEsc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Populate the IS dropdown from the vault only — IS Intelligence is the single source of truth.
async function populateLimsISSelector() {
    const sel = document.getElementById('lims-is-no');
    if (!sel) return;
    const current = sel.value;
    let vault = [];
    try { const r = await fetch('/api/is-intelligence/vault'); const d = await r.json(); vault = d.vault || []; } catch (e) {}
    const opts = vault.map(v => v.isNumber).filter(Boolean);
    if (!opts.length) opts.push('— Upload an IS standard in IS Intelligence —');
    const selected = current && opts.includes(current) ? current : opts[0];
    sel.innerHTML = opts.map(o => `<option value="${limsEsc(o)}"${o === selected ? ' selected' : ''}>${limsEsc(o)}</option>`).join('');
}

// Set the IS value programmatically (e.g. from a matched sample), adding the option if missing.
function setLimsISValue(val) {
    const sel = document.getElementById('lims-is-no');
    if (!sel) return;
    if (![...sel.options].some(o => o.value === val)) sel.add(new Option(val, val));
    sel.value = val;
    onLimsISChange();
}

// IS changed → always read from IS Intelligence vault (single source of truth).
function onLimsISChange() {
    const sel = document.getElementById('lims-is-no');
    const is = sel ? sel.value : '';
    if (is && !is.startsWith('—')) renderVaultReport(is);
}

// Render the report rows from saved IS Intelligence data (the "change IS → report appears" flow).
async function renderVaultReport(isNumber) {
    const tbody = document.getElementById('lims-parameters-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" style="padding:14px;color:var(--text-muted);">Loading parameters from IS Intelligence…</td></tr>';
    try {
        const res = await fetch(`/api/is-intelligence/params/${encodeURIComponent(isNumber)}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.found) {
            tbody.innerHTML = `<tr><td colspan="5" style="padding:14px;color:#e06c75;">No saved data for ${limsEsc(isNumber)} — upload it in IS Intelligence first.</td></tr>`;
            return;
        }
        const params = data.test_parameters || [];
        if (!params.length) {
            tbody.innerHTML = `<tr><td colspan="5" style="padding:14px;color:var(--text-muted);">No parameters extracted for this standard yet.</td></tr>`;
            return;
        }
        tbody.innerHTML = '';
        params.forEach((p, idx) => {
            const type = p.type || 'Quantitative';
            const isQual = /qual/i.test(type);
            const min = (p.min != null && p.min !== '') ? p.min : '';
            const max = (p.max != null && p.max !== '') ? p.max : '';
            const spec = p.spec_val || ((min !== '' || max !== '') ? `${min} – ${max}` : (p.expected || ''));
            let inputHtml;
            if (isQual) {
                const opts = ['', p.expected, 'Satisfactory', 'Unsatisfactory', 'Fail', 'Not Done', 'NA'].filter((v, i, a) => v != null && a.indexOf(v) === i);
                inputHtml = `<select class="lims-param-input" data-idx="${idx}" data-min="" data-max="" onchange="validateObservation(this)" style="width:100%;border-radius:4px;padding:6px;background:rgba(0,0,0,0.3);border:1px solid var(--glass-border);color:white;">${opts.map(o => `<option value="${limsEsc(o)}">${limsEsc(o || '—')}</option>`).join('')}</select>`;
            } else {
                inputHtml = `<input type="number" step="0.01" class="lims-param-input" data-idx="${idx}" data-min="${limsEsc(min)}" data-max="${limsEsc(max)}" oninput="validateObservation(this)" style="width:100%;border-radius:4px;padding:6px;background:rgba(0,0,0,0.3);border:1px solid var(--glass-border);color:white;" placeholder="Enter value">`;
            }
            const tr = document.createElement('tr');
            tr.innerHTML = `<td style="padding:8px;border-bottom:1px solid rgba(255,255,255,0.05);">${limsEsc(p.clause)}</td>`
                + `<td style="padding:8px;border-bottom:1px solid rgba(255,255,255,0.05);">${limsEsc(p.param)}</td>`
                + `<td style="padding:8px;border-bottom:1px solid rgba(255,255,255,0.05);">${limsEsc(spec)}</td>`
                + `<td style="padding:8px;border-bottom:1px solid rgba(255,255,255,0.05);">${limsEsc(type)}</td>`
                + `<td style="padding:8px;border-bottom:1px solid rgba(255,255,255,0.05);">${inputHtml}</td>`;
            tbody.appendChild(tr);
        });
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="5" style="padding:14px;color:#e06c75;">Failed to load: ${limsEsc(e.message)}</td></tr>`;
    }
}

// Add a custom/missing parameter row to the report (editable: clause, name, min, max, observed).
function addLimsParameterRow() {
    const tbody = document.getElementById('lims-parameters-tbody');
    if (!tbody) { showToast('Open a report first.', 'error'); return; }
    const cs = 'padding:6px; border-bottom:1px solid rgba(255,255,255,0.05);';
    const is = 'padding:5px; background:rgba(0,0,0,0.25); border:1px solid var(--glass-border); border-radius:4px; color:#e1e4e8; font-size:0.8rem;';
    const tr = document.createElement('tr');
    tr.innerHTML =
        `<td style="${cs}"><input placeholder="Clause" style="width:100%; ${is}"></td>`
        + `<td style="${cs}"><input placeholder="Parameter name" style="width:100%; ${is}"></td>`
        + `<td style="${cs}"><span style="display:flex; gap:4px;"><input class="lim-spec-min" placeholder="Min" style="width:50%; ${is}"><input class="lim-spec-max" placeholder="Max" style="width:50%; ${is}"></span></td>`
        + `<td style="${cs} color:var(--text-muted);">Quantitative</td>`
        + `<td style="${cs}"><span style="display:flex; gap:6px; align-items:center;"><input type="number" step="0.01" class="lims-param-input" data-min="" data-max="" oninput="validateObservation(this)" placeholder="Observed" style="flex:1; ${is}"><span onclick="this.closest('tr').remove()" title="Remove parameter" style="cursor:pointer; color:#e06c75; font-weight:700; padding:0 4px;">&times;</span></span></td>`;
    const obs = tr.querySelector('.lims-param-input');
    const mn = tr.querySelector('.lim-spec-min');
    const mx = tr.querySelector('.lim-spec-max');
    const sync = () => { obs.setAttribute('data-min', mn.value); obs.setAttribute('data-max', mx.value); validateObservation(obs); };
    mn.addEventListener('input', sync);
    mx.addEventListener('input', sync);
    tbody.appendChild(tr);
    tr.querySelector('input').focus();
}

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

    // ── Restore saved LIMS credentials from API ──
    const userEl = document.getElementById('lims-username-input');
    const passEl = document.getElementById('lims-password-input');
    fetch('/api/profile/lims-credentials')
        .then(res => res.json())
        .then(data => {
            if (data.limsUsername && userEl && !userEl.value) userEl.value = data.limsUsername;
            if (data.limsPassword && passEl && !passEl.value) passEl.value = data.limsPassword;
        }).catch(err => console.error("Failed to load LIMS credentials", err));
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

// Build a clean printable report preview from the on-screen table (works for any IS).
// No browser automation — shows a real document you can Save as PDF.
async function previewLimsPdf() {
    try {
        const meta = {
            sampleCode: (document.getElementById('lims-sample-code') || {}).value || '',
            isNo: (document.getElementById('lims-is-no') || {}).value || 'IS 4985 (2021)',
            size: (document.getElementById('lims-size-select') || {}).value || '',
            pipeClass: (document.getElementById('lims-class-select') || {}).value || '',
            type: (document.getElementById('lims-type-select') || {}).value || '',
        };
        if (!meta.sampleCode) {
            showToast('Please enter a Sample Code before previewing.', 'error');
            return;
        }

        const tbody = document.getElementById('lims-parameters-tbody');
        const rows = tbody ? [...tbody.querySelectorAll('tr')] : [];
        if (!rows.length) { showToast('No parameters to preview — load a standard first.', 'error'); return; }

        let bodyRows = '';
        rows.forEach(tr => {
            const c = tr.children;
            const clause = c[0] ? c[0].textContent.trim() : '';
            const param = c[1] ? c[1].textContent.trim() : '';
            const spec = c[2] ? c[2].textContent.trim() : '';
            const input = tr.querySelector('.lims-param-input');
            const observed = input ? (input.value || '') : '';
            let result = '—', color = '#64748b';
            if (observed !== '') {
                if (input && input.tagName.toLowerCase() === 'select') {
                    const bad = /unsatisfactory|fail/i.test(observed);
                    result = bad ? 'Fail' : 'Pass'; color = bad ? '#dc2626' : '#16a34a';
                } else {
                    const v = parseFloat(observed);
                    const mn = input ? parseFloat(input.getAttribute('data-min')) : NaN;
                    const mx = input ? parseFloat(input.getAttribute('data-max')) : NaN;
                    let ok = true;
                    if (!isNaN(mn) && v < mn) ok = false;
                    if (!isNaN(mx) && v > mx) ok = false;
                    result = ok ? 'Pass' : 'Fail'; color = ok ? '#16a34a' : '#dc2626';
                }
            }
            bodyRows += `<tr><td>${limsEsc(clause)}</td><td>${limsEsc(param)}</td><td>${limsEsc(spec)}</td><td>${limsEsc(observed) || '<span style="color:#94a3b8">—</span>'}</td><td style="color:${color};font-weight:700;">${result}</td></tr>`;
        });

        const now = new Date().toLocaleString();
        const html = `<!doctype html><html><head><meta charset="utf-8"><title>Test Report ${limsEsc(meta.sampleCode)}</title>
<style>
  body{font-family:-apple-system,'Segoe UI',sans-serif;color:#1a1a2e;padding:28px;}
  h2{margin:0 0 4px;color:#2957A3;font-size:20px;}
  .sub{color:#64748b;font-size:13px;margin-bottom:14px;}
  .meta{display:flex;flex-wrap:wrap;gap:18px;font-size:13px;margin:12px 0 18px;padding:12px 14px;background:#f1f5f9;border-radius:8px;}
  .meta b{color:#0f172a;}
  table{width:100%;border-collapse:collapse;font-size:12.5px;}
  th,td{border:1px solid #cbd5e1;padding:7px 9px;text-align:left;}
  th{background:#2957A3;color:#fff;}
  tr:nth-child(even) td{background:#f8fafc;}
</style></head><body>
  <h2>Bureau of Indian Standards — Test Report</h2>
  <div class="sub">${limsEsc(meta.isNo)}</div>
  <div class="meta"><span><b>Sample Code:</b> ${limsEsc(meta.sampleCode)}</span><span><b>Size (DN):</b> ${limsEsc(meta.size)}</span><span><b>Class:</b> ${limsEsc(meta.pipeClass)}</span><span><b>Type:</b> ${limsEsc(meta.type)}</span><span><b>Generated:</b> ${limsEsc(now)}</span></div>
  <table><thead><tr><th>Clause</th><th>Test Parameter</th><th>Specified Value</th><th>Observed</th><th>Result</th></tr></thead><tbody>${bodyRows}</tbody></table>
</body></html>`;

        const modal = document.getElementById('pdf-preview-modal');
        const iframe = document.getElementById('pdf-iframe');
        if (modal && iframe) {
            iframe.removeAttribute('src');
            iframe.srcdoc = html;
            modal.classList.add('active');
            const btnDownload = document.getElementById('btn-download-pdf');
            if (btnDownload) {
                btnDownload.textContent = '🖨️ Print / Save as PDF';
                btnDownload.onclick = () => { try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch (e) {} };
            }
        } else {
            const w = window.open('', '_blank');
            if (w) { w.document.write(html); w.document.close(); }
        }
    } catch (globalErr) {
        showToast('Preview error: ' + globalErr.message, 'error');
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

        // Save credentials via API so they pre-fill next time
        fetch('/api/profile/lims-credentials', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ limsUsername: usernameInput.value, limsPassword: passwordInput.value })
        }).catch(err => console.error("Failed to save LIMS credentials", err));

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
            fetchSamples(); // Refresh master list to show Submitted status
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

// --- EMPLOYEE HUB UI HELPERS ---

function ehToggleAddPanel() {
    const panel = document.getElementById('eh-add-panel');
    const btn = document.getElementById('eh-add-btn');
    if (!panel) return;
    const isOpen = panel.style.display !== 'none';
    panel.style.display = isOpen ? 'none' : 'block';
    if (btn) btn.textContent = isOpen ? '＋ Add Employee' : '× Cancel';
}

function ehSwitchTab(tab) {
    const panels = { roster: 'eh-panel-roster', leave: 'eh-panel-leave' };
    const btns   = { roster: 'eh-tab-btn-roster', leave: 'eh-tab-btn-leave' };
    Object.keys(panels).forEach(key => {
        const panel = document.getElementById(panels[key]);
        const btn   = document.getElementById(btns[key]);
        const isActive = key === tab;
        if (panel) panel.style.display = isActive ? 'block' : 'none';
        if (btn) {
            btn.dataset.active = isActive ? '1' : '0';
            btn.style.background = isActive ? '#2563eb' : '#f1f5f9';
            btn.style.color = isActive ? '#fff' : '#64748b';
            btn.style.fontWeight = isActive ? '700' : '600';
        }
    });
    // Lazy-load data for each tab
    if (tab === 'leave') {
        loadLeaves();
        populateLeaveEmployeeDropdown();
    } else if (tab === 'roster') {
        loadEmployees();
    }
}

async function ehUpdateKPIs() {
    try {
        const [empRes, leavesRes] = await Promise.all([
            fetch('/api/admin/employees'),
            fetch('/api/admin/leaves')
        ]);
        const empData    = empRes.ok    ? await empRes.json()    : { employees: [] };
        const leavesData = leavesRes.ok ? await leavesRes.json() : { leaves: [] };
        const employees  = empData.employees  || [];
        const leaves     = leavesData.leaves  || [];
        const today      = new Date().toISOString().slice(0, 10);
        const onLeaveToday = leaves.filter(l => l.leaveDate === today).length;
        const totalWorkload = employees.reduce((sum, e) => sum + (e.currentWorkload || 0), 0);
        const kpiTotal     = document.getElementById('eh-kpi-total');
        const kpiAvail     = document.getElementById('eh-kpi-available');
        const kpiLeave     = document.getElementById('eh-kpi-on-leave');
        const kpiWork      = document.getElementById('eh-kpi-workload');
        if (kpiTotal)  kpiTotal.textContent  = employees.length;
        if (kpiAvail)  kpiAvail.textContent  = Math.max(0, employees.length - onLeaveToday);
        if (kpiLeave)  kpiLeave.textContent  = onLeaveToday;
        if (kpiWork)   kpiWork.textContent   = totalWorkload;
    } catch(e) { console.error('ehUpdateKPIs error', e); }
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
                    <td style="font-family: monospace; font-size: 0.95rem;">${e.loginUsername}</td>
                    <td><span style="background: #f1f5f9; padding: 4px 10px; border-radius: 20px; font-weight: 600; color: #475569;">${e.currentWorkload} / ${e.maxDailySamples}</span></td>
                    <td style="text-align: right; white-space: nowrap;">
                        <button onclick="openEditEmployeeModal(${e.id}, '${e.fullName}', '${e.designation}', ${e.maxDailySamples})" style="background: rgba(59,130,246,0.1); color: #3b82f6; border: none; padding: 6px 10px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 0.85rem; margin-right: 5px;" title="Edit Profile">✏️ Edit</button>
                        <button onclick="openCompetencyModal(${e.id}, '${e.fullName}')" style="background: rgba(139,92,246,0.1); color: #8b5cf6; border: none; padding: 6px 10px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 0.85rem; margin-right: 5px;" title="Manage IS Skills">🧠 Skills</button>
                        <button onclick="deleteEmployee(${e.id})" style="background: rgba(239,68,68,0.1); color: #ef4444; border: none; padding: 6px 10px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 0.85rem;" title="Delete Employee">🗑️ Delete</button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
            if (!data.employees.length) {
                tbody.innerHTML = `<tr><td colspan="4" style="padding:40px; text-align:center; color:#94a3b8; font-size:0.9rem;"><div style="font-size:2rem; margin-bottom:8px; opacity:0.35;">👥</div> No employees yet. Click "Add Employee" above.</td></tr>`;
            }
        }
        ehUpdateKPIs();
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
            // Close the add panel and reset fields
            const panel = document.getElementById('eh-add-panel');
            const btn   = document.getElementById('eh-add-btn');
            if (panel) panel.style.display = 'none';
            if (btn)   btn.textContent = '＋ Add Employee';
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

async function importAccountsFromMasterList() {
    try {
        const previewRes = await fetch('/api/admin/master-list-import-preview');
        const preview = await previewRes.json();
        if (!previewRes.ok) {
            showToast(preview.error || 'Failed to preview master list import.', 'error');
            return;
        }

        const totals = preview.totals || {};
        const previewLines = (preview.candidates || [])
            .slice(0, 8)
            .map(c => `${c.fullName} (${c.sampleCount} samples, ${c.competencies?.length || 0} IS items)`)
            .join('\n');

        const confirmText = [
            `Create accounts from the master list?`,
            ``,
            `People found: ${totals.people || 0}`,
            `Missing user logins: ${totals.missingUsers || 0}`,
            `Missing employee profiles: ${totals.missingProfiles || 0}`,
            `Total sample links scanned: ${totals.totalSampleCount || 0}`,
            ``,
            `Top matches:`,
            previewLines || '(no sample owners found)',
            ``,
            `Default password for new logins: 1234`,
        ].join('\n');

        if (!confirm(confirmText)) return;

        const res = await fetch('/api/admin/master-list-import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                defaultPassword: '1234',
                defaultDesignation: 'Testing Person',
                defaultCapacity: 40
            })
        });
        const data = await res.json();
        if (res.ok) {
            showToast(data.message || 'Master list imported.', 'success');
            loadEmployees();
            fetchUsers();
            fetchTPUsers();
        } else {
            showToast(data.error || 'Failed to import master list.', 'error');
        }
    } catch (err) {
        console.error(err);
        showToast('Network error while importing master list.', 'error');
    }
}

function openEditEmployeeModal(id, fullName, designation, maxDailySamples) {
    document.getElementById('edit-emp-id').value = id;
    document.getElementById('edit-emp-fullname').value = fullName;
    document.getElementById('edit-emp-designation').value = designation;
    document.getElementById('edit-emp-max-capacity').value = maxDailySamples;
    document.getElementById('edit-employee-modal').classList.add('active');
}

function closeEditEmployeeModal() {
    document.getElementById('edit-employee-modal').classList.remove('active');
}

async function saveEmployeeEdits() {
    const id = document.getElementById('edit-emp-id').value;
    const fullName = document.getElementById('edit-emp-fullname').value;
    const designation = document.getElementById('edit-emp-designation').value;
    const maxDailySamples = document.getElementById('edit-emp-max-capacity').value;

    if (!fullName) return showToast('Full Name is required.', 'warning');

    try {
        const res = await fetch(`/api/admin/employees/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fullName, designation, maxDailySamples })
        });
        const data = await res.json();
        if (res.ok) {
            showToast('Employee updated successfully.', 'success');
            closeEditEmployeeModal();
            loadEmployees();
            fetchTPUsers();
        } else {
            showToast(data.error || 'Failed to update employee.', 'error');
        }
    } catch (err) {
        console.error(err);
        showToast('Network error.', 'error');
    }
}

async function deleteEmployee(id) {
    if (!confirm('Are you sure you want to delete this employee? This will also remove their IS competencies and Leave records.')) return;
    
    try {
        const res = await fetch(`/api/admin/employees/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (res.ok) {
            showToast('Employee deleted successfully.', 'success');
            loadEmployees();
            loadLeaves();
        } else {
            showToast(data.error || 'Failed to delete employee.', 'error');
        }
    } catch (err) {
        console.error(err);
        showToast('Network error while deleting employee.', 'error');
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
                    <td>${getISNumberHtml(c.isNumber)}</td>
                    <td>${c.proficiencyLevel}</td>
                    <td style="text-align:center;">
                        <button onclick="removeCompetency(${c.id})" style="background:transparent; border:none; color:var(--danger); cursor:pointer;" title="Remove">🗑️</button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
            renderSkillRadar('admin-skill-radar', data.competencies, adminChartInstance, (c) => adminChartInstance = c);
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
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:40px 20px; color:var(--text-muted);">
        <div class="loading-pulse" style="width: 40px; height: 40px; border-radius: 50%; border: 3px solid rgba(16,185,129,0.2); border-top-color: var(--success); animation: spin 1s linear infinite; margin: 0 auto 10px;"></div>
        Analyzing samples and competencies...
    </td></tr>`;
    try {
        const res = await fetch('/api/admin/recommendations');
        const data = await res.json();
        if (res.ok) {
            tbody.innerHTML = '';
            if (data.recommendations.length === 0) {
                tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:40px 20px; color:var(--text-muted);">
                    <div style="font-size: 2.5rem; margin-bottom: 15px; opacity: 0.5;">🤖</div>
                    No pending recommendations.<br><span style="font-size: 0.85rem;">Click "Run AI Assigner" to generate matches.</span>
                </td></tr>`;
            }
            data.recommendations.forEach(r => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td>
                        <strong style="color:var(--accent);">${r.encodedCode}</strong><br>
                        <span style="font-size:0.8rem; color:var(--text-muted);">${getISNumberHtml(r.isNumber)}</span>
                    </td>
                    <td>
                        <div style="display:flex; align-items:center; gap:8px;">
                            <div style="width:24px; height:24px; border-radius:50%; background:rgba(16,185,129,0.1); color:var(--success); display:flex; justify-content:center; align-items:center; font-size:0.75rem; font-weight:bold;">${r.recommendedEmployeeName.charAt(0)}</div>
                            <span style="font-weight:600;">${r.recommendedEmployeeName}</span>
                        </div>
                    </td>
                    <td>
                        <div style="display:inline-block; padding:4px 8px; background:rgba(99,102,241,0.1); border:1px solid rgba(99,102,241,0.2); border-radius:20px; font-size:0.8rem; color:var(--primary); font-weight:600;">
                            Score: ${r.score}
                        </div>
                        <div style="font-size:0.8rem; color:var(--text-muted); margin-top:4px; white-space: normal; word-wrap: break-word;">${r.reason}</div>
                    </td>
                    <td style="text-align: right;">
                        <button onclick="approveRecommendation(${r.id})" class="btn-premium" style="background:rgba(16,185,129,0.15); color:var(--success); border:1px solid rgba(16,185,129,0.3); padding:6px 12px; font-size:0.8rem;">✓</button>
                        <button onclick="rejectRecommendation(${r.id}, ${r.sampleId})" class="btn-premium" style="background:rgba(239,68,68,0.15); color:var(--danger); border:1px solid rgba(239,68,68,0.3); padding:6px 12px; font-size:0.8rem; margin-left:5px;">✕</button>
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
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:30px; color:var(--text-muted);">
        <div class="loading-pulse" style="width: 40px; height: 40px; border-radius: 50%; border: 3px solid rgba(99,102,241,0.2); border-top-color: var(--primary); animation: spin 1s linear infinite; margin: 0 auto 10px;"></div>
        Loading unassigned samples...
    </td></tr>`;
    
    // Update the unassigned count from the kpi badge
    const countSpan = document.getElementById('unassigned-pool-count');
    if (countSpan) countSpan.textContent = '...';

    try {
        const res = await fetch('/api/unassigned-samples');
        const data = await res.json();
        if (res.ok) {
            currentUnassignedSamples = data.samples || [];
            populateUnassignedIsDropdown(currentUnassignedSamples);
            filterUnassignedPoolTable();
        }
    } catch (err) { console.error(err); }
}

function populateUnassignedIsDropdown(samples) {
    const dropdown = document.getElementById('unassigned-is-filter');
    if (!dropdown) return;
    const prevVal = dropdown.value;
    
    const isNumbers = new Set();
    samples.forEach(s => {
        if (s.isNumber) {
            isNumbers.add(s.isNumber.trim());
        }
    });
    
    dropdown.innerHTML = '<option value="ALL">All IS Numbers</option>';
    const sortedIs = Array.from(isNumbers).sort();
    sortedIs.forEach(isNum => {
        const opt = document.createElement('option');
        opt.value = isNum;
        opt.textContent = isNum;
        dropdown.appendChild(opt);
    });
    
    // Restore selection if still present
    if (Array.from(dropdown.options).some(o => o.value === prevVal)) {
        dropdown.value = prevVal;
    }
}

function filterUnassignedPoolTable() {
    const searchVal = (document.getElementById('unassigned-search-input')?.value || '').toLowerCase().trim();
    const isFilterVal = document.getElementById('unassigned-is-filter')?.value || 'ALL';
    const priorityFilterVal = document.getElementById('unassigned-priority-filter')?.value || 'ALL';
    
    const filtered = currentUnassignedSamples.filter(s => {
        // Search filter
        if (searchVal) {
            const matchesCode = s.encodedCode && s.encodedCode.toLowerCase().includes(searchVal);
            const matchesIS = s.isNumber && s.isNumber.toLowerCase().includes(searchVal);
            if (!matchesCode && !matchesIS) return false;
        }
        
        // IS filter
        if (isFilterVal !== 'ALL') {
            if (!s.isNumber || s.isNumber.trim() !== isFilterVal.trim()) return false;
        }
        
        // Priority filter
        if (priorityFilterVal !== 'ALL') {
            const pl = (s.priorityLevel || '').toLowerCase();
            const isPriority = pl === 'high' || pl === 'medium' || pl === 'priority';
            if (priorityFilterVal === 'Priority' && !isPriority) return false;
            if (priorityFilterVal === 'Standard' && isPriority) return false;
        }
        
        return true;
    });
    
    renderUnassignedPoolTable(filtered);
}

function renderUnassignedPoolTable(samples) {
    const tbody = document.getElementById('unassigned-pool-tbody');
    if (!tbody) return;
    
    const countSpan = document.getElementById('unassigned-pool-count');
    if (countSpan) countSpan.textContent = samples.length;
    
    tbody.innerHTML = '';
    if (samples.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:40px 20px; color:var(--text-muted);">
            <div style="font-size: 2.5rem; margin-bottom: 15px; opacity: 0.5;">🎉</div>
            No matching samples.
        </td></tr>`;
        return;
    }
    
    let tpOptions = '<option value="">-- Direct Assign --</option>';
    const selectEl = document.getElementById('leave-employee-select');
    if (selectEl && selectEl.options.length > 0) {
        for(let i=0; i<selectEl.options.length; i++) {
            tpOptions += `<option value="${selectEl.options[i].text}">${selectEl.options[i].text}</option>`;
        }
    }
    
    samples.forEach(s => {
        const tr = document.createElement('tr');
        let priorityBadge = '';
        if (s.priorityLevel === 'High') priorityBadge = '<span style="color:var(--danger); font-size:1.2rem;" title="High Priority">🔥</span>';
        else if (s.priorityLevel === 'Medium') priorityBadge = '<span style="color:var(--warning); font-size:1.2rem;" title="Medium Priority">⚡</span>';
        
        tr.innerHTML = `
            <td>
                <strong style="color:var(--text-main); font-size:1.05rem;">${s.encodedCode}</strong>
                <div style="font-size:0.8rem; color:var(--text-muted); margin-top:2px;">Rcvd: ${s.receivedOn || '-'}</div>
            </td>
            <td>${getISNumberHtml(s.isNumber)}</td>
            <td style="text-align:center;">${priorityBadge || '<span style="color:var(--text-muted);">-</span>'}</td>
            <td>
                <select onchange="directAssignSample(${s.id}, this.value)" style="width:100%; padding:8px 12px; border-radius:6px; background: #f8fafc; color:var(--text-main); border: 1px solid #cbd5e1; font-size:0.85rem; outline:none;">
                    ${tpOptions}
                </select>
            </td>
        `;
        tbody.appendChild(tr);
    });
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
            fetchSamples(); // Sync with Master List
            triggerExcelDownloadAndPrint([sampleId]);
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
            // Refresh both modal and tab views
            loadModalUnassignedPool();
            loadModalRecommendations();
            loadRecommendations();
            loadUnassignedPool();
            fetchSamples(); // Sync with Master List
            if (data.sampleIds && data.sampleIds.length > 0) {
                triggerExcelDownloadAndPrint(data.sampleIds);
            }
        } else {
            showToast(data.error, 'error');
        }
    } catch (err) { console.error(err); }
}

async function generateMockData() {
    if (!confirm('This will inject 50 mock samples into the unalloted samples. Are you sure?')) return;
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

// --- Smart Auto Assigner Modal Logic ---
function openAutoAssignerModal() {
    const modal = document.getElementById('modal-auto-assigner');
    if (modal) {
        modal.style.display = 'flex';
        // Hide body scroll to prevent double scrolling
        document.body.style.overflow = 'hidden';
        // Load data into the modal's own (uniquely-IDed) tables
        loadModalUnassignedPool();
        loadModalRecommendations();
    }
}

function closeAutoAssignerModal() {
    const modal = document.getElementById('modal-auto-assigner');
    if (modal) {
        modal.style.display = 'none';
        // Restore body scroll
        document.body.style.overflow = '';
    }
}

// Loads unassigned pool into the MODAL's table (id: modal-unassigned-pool-tbody)
async function loadModalUnassignedPool() {
    const tbody = document.getElementById('modal-unassigned-pool-tbody');
    const countSpan = document.getElementById('modal-unassigned-pool-count');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; padding:40px; color:#94a3b8;">
        <div class="loading-pulse" style="width: 30px; height: 30px; border-radius: 50%; border: 3px solid #e0e7ff; border-top-color: #4338ca; animation: spin 1s linear infinite; margin: 0 auto 10px;"></div>
        Loading unassigned samples...
    </td></tr>`;
    if (countSpan) countSpan.textContent = '...';
    try {
        const res = await fetch('/api/unassigned-samples');
        const data = await res.json();
        if (res.ok) {
            const samples = data.samples || [];
            if (countSpan) countSpan.textContent = samples.length;
            tbody.innerHTML = '';
            if (samples.length === 0) {
                tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; padding:40px; color:#94a3b8;">
                    <div style="font-size: 2.5rem; margin-bottom: 10px; opacity: 0.5;">🎉</div>
                    No unassigned samples in the pool.
                </td></tr>`;
                return;
            }
            samples.forEach(s => {
                let priorityBadge = '';
                if ((s.priorityLevel || '').toLowerCase() === 'high' || (s.priorityLevel || '').toLowerCase() === 'priority')
                    priorityBadge = '<span style="color:#ef4444; font-size:1rem;" title="High Priority">🔥</span>';
                else if ((s.priorityLevel || '').toLowerCase() === 'medium')
                    priorityBadge = '<span style="color:#f59e0b; font-size:1rem;" title="Medium Priority">⚡</span>';
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><strong style="color:#1e293b;">${s.encodedCode || '-'}</strong>
                    <div style="font-size:0.75rem;color:#94a3b8;margin-top:2px;">Rcvd: ${s.receivedOn || '-'}</div></td>
                    <td>${getISNumberHtml(s.isNumber)}</td>
                    <td style="text-align:center;">${priorityBadge || '<span style="color:#94a3b8;">-</span>'}</td>
                `;
                tbody.appendChild(tr);
            });
        } else {
            tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; color:#ef4444; padding:20px;">${data.error || 'Failed to load samples.'}</td></tr>`;
        }
    } catch (err) {
        console.error('loadModalUnassignedPool error:', err);
        tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; color:#ef4444; padding:20px;">Network error. Please try again.</td></tr>`;
    }
}

// Loads recommendations into the MODAL's table (id: modal-recommendations-tbody)
async function loadModalRecommendations() {
    const tbody = document.getElementById('modal-recommendations-tbody');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:40px 20px; color:#94a3b8;">
        <div class="loading-pulse" style="width: 40px; height: 40px; border-radius: 50%; border: 3px solid rgba(99,102,241,0.2); border-top-color: #6366f1; animation: spin 1s linear infinite; margin: 0 auto 10px;"></div>
        Checking recommendations...
    </td></tr>`;
    // reset bulk UI
    const bulkBtn = document.getElementById('bulk-reject-btn');
    const selectAll = document.getElementById('rec-select-all');
    if (bulkBtn) bulkBtn.style.display = 'none';
    if (selectAll) selectAll.checked = false;

    try {
        const res = await fetch('/api/admin/recommendations');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        tbody.innerHTML = '';
        const badge = document.getElementById('rec-count-badge');

        if (data.recommendations.length === 0) {
            if (badge) { badge.textContent = '0 Pending'; badge.style.background = '#f1f5f9'; badge.style.color = '#64748b'; }
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:40px 20px; color:#94a3b8;">
                <div style="font-size: 2.5rem; margin-bottom: 10px; opacity: 0.5;">🤖</div>
                No pending recommendations.<br><span style="font-size: 0.85rem;">Click "Run AI Assigner" to generate matches.</span>
            </td></tr>`;
            return;
        }

        if (badge) { badge.textContent = `${data.recommendations.length} Pending`; badge.style.background = '#d1fae5'; badge.style.color = '#047857'; }

        // Pre-fetch competent employees per unique IS number
        const isNumbers = [...new Set(data.recommendations.map(r => r.isNumber).filter(Boolean))];
        const competentMap = {}; // isNumber -> [{id, fullName, currentWorkload}]
        await Promise.all(isNumbers.map(async isn => {
            try {
                const r = await fetch(`/api/admin/competent-employees?isNumber=${encodeURIComponent(isn)}`);
                const d = await r.json();
                competentMap[isn] = d.employees || [];
            } catch(e) { competentMap[isn] = []; }
        }));

        data.recommendations.forEach(r => {
            const tr = document.createElement('tr');
            tr.dataset.recId = r.id;

            const empList = competentMap[r.isNumber] || [];
            const ddOptions = `<option value="">— Keep Unassigned —</option>` +
                empList.map(e =>
                    `<option value="${e.id}" data-name="${e.fullName}" ${r.recommendedEmployeeId == e.id ? 'selected' : ''}>${e.fullName} (${e.currentWorkload || 0})</option>`
                ).join('');

            const displayName = r.recommendedEmployeeName || '— Unassigned —';
            const avatar = r.recommendedEmployeeName ? r.recommendedEmployeeName.charAt(0) : '?';

            tr.innerHTML = `
                <td style="padding:10px 8px; text-align:center;">
                    <input type="checkbox" class="rec-checkbox" data-id="${r.id}" onchange="updateBulkRejectUI()" style="cursor:pointer;">
                </td>
                <td style="padding:10px 12px;">
                    <strong style="color:#6366f1;">${r.encodedCode}</strong><br>
                    <span style="font-size:0.75rem; color:#94a3b8;">${getISNumberHtml(r.isNumber)}</span>
                </td>
                <td style="padding:10px 12px;">
                    <select id="rec-dd-${r.id}" onchange="editRecommendation(${r.id}, this)"
                        style="border:1px solid #e2e8f0; border-radius:6px; padding:5px 8px; font-size:0.8rem; color:#1e293b; background:#f8fafc; width:100%; cursor:pointer;">
                        ${ddOptions}
                    </select>
                    <div id="rec-save-${r.id}" style="font-size:0.7rem; color:#10b981; margin-top:3px; display:none;">✓ Saved</div>
                </td>
                <td style="padding:10px 12px;">
                    <div style="display:inline-block; padding:3px 8px; background:rgba(99,102,241,0.1); border:1px solid rgba(99,102,241,0.2); border-radius:20px; font-size:0.78rem; color:#6366f1; font-weight:600;">
                        ${r.score}
                    </div>
                    <div style="font-size:0.7rem; color:#94a3b8; margin-top:3px; white-space:normal; word-wrap:break-word;">${r.reason || ''}</div>
                </td>
                <td style="padding:10px 8px; text-align:right; white-space:nowrap;">
                    <button onclick="approveRecommendation(${r.id}); loadModalUnassignedPool(); loadModalRecommendations();" class="btn-premium" style="background:rgba(16,185,129,0.15); color:#10b981; border:1px solid rgba(16,185,129,0.3); padding:5px 10px; font-size:0.78rem;" title="Approve">✓</button>
                    <button onclick="rejectRecommendation(${r.id}, ${r.sampleId});" class="btn-premium" style="background:rgba(239,68,68,0.15); color:#ef4444; border:1px solid rgba(239,68,68,0.3); padding:5px 10px; font-size:0.78rem; margin-left:4px;" title="Reject">✕</button>
                </td>
            `;
            tbody.appendChild(tr);
        });

    } catch (err) {
        console.error('loadModalRecommendations error:', err);
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:#ef4444; padding:20px;">Network error. Please try again.</td></tr>`;
    }
}

// Save edited employee to DB immediately on dropdown change
async function editRecommendation(recId, selectEl) {
    const selectedOption = selectEl.options[selectEl.selectedIndex];
    const employeeName = selectedOption.dataset.name || null;
    const employeeId = selectedOption.value || null;
    const savedEl = document.getElementById(`rec-save-${recId}`);
    try {
        const res = await fetch(`/api/admin/recommendations/${recId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ employeeName, employeeId })
        });
        if (res.ok) {
            if (savedEl) { savedEl.style.display = 'block'; setTimeout(() => savedEl.style.display = 'none', 2000); }
        } else {
            showToast('Failed to save edit', 'error');
        }
    } catch(e) { showToast('Network error', 'error'); }
}

// Toggle bulk reject button visibility
function updateBulkRejectUI() {
    const checked = document.querySelectorAll('.rec-checkbox:checked');
    const btn = document.getElementById('bulk-reject-btn');
    const countEl = document.getElementById('bulk-reject-count');
    if (btn) btn.style.display = checked.length > 0 ? 'inline-block' : 'none';
    if (countEl) countEl.textContent = checked.length;
}

// Select / deselect all recommendation checkboxes
function toggleSelectAllRecs(masterCb) {
    document.querySelectorAll('.rec-checkbox').forEach(cb => cb.checked = masterCb.checked);
    updateBulkRejectUI();
}

// Bulk reject selected recommendations
async function bulkRejectRecommendations() {
    const checked = [...document.querySelectorAll('.rec-checkbox:checked')];
    if (!checked.length) return;
    if (!confirm(`Reject ${checked.length} recommendation(s)? They will return to the unassigned pool.`)) return;
    const ids = checked.map(cb => parseInt(cb.dataset.id));
    try {
        const res = await fetch('/api/admin/recommendations/bulk-reject', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids })
        });
        const data = await res.json();
        if (res.ok) {
            showToast(data.message, 'success');
            loadModalRecommendations();
            loadModalUnassignedPool();
        } else {
            showToast(data.error || 'Bulk reject failed', 'error');
        }
    } catch(e) { showToast('Network error', 'error'); }
}

// --- Smart Assigner Tab Switching ---
function switchAssignerSubtab(tab) {
    document.querySelectorAll('.subtab-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`subtab-btn-${tab}`).classList.add('active');
    
    document.getElementById('subtab-content-live').style.display = tab === 'live' ? 'block' : 'none';
    document.getElementById('subtab-content-history').style.display = tab === 'history' ? 'block' : 'none';
    
    if (tab === 'history') {
        loadAssignmentHistory();
    }
}

// --- Assignment History ---
async function loadAssignmentHistory() {
    const tbody = document.getElementById('history-pool-tbody');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:30px; color:var(--text-muted);">
        <div class="loading-pulse-ring"></div>Loading history...</td></tr>`;
        
    try {
        const res = await fetch('/api/admin/assignment-history');
        const data = await res.json();
        if (res.ok) {
            tbody.innerHTML = '';
            if (!data.history || data.history.length === 0) {
                tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:30px; color:var(--text-muted);">No assignment history found.</td></tr>`;
                return;
            }
            data.history.forEach(h => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td><strong>${h.encodedCode}</strong></td>
                    <td>${getISNumberHtml(h.isNumber)}</td>
                    <td><span class="badge-premium pulse-indigo">${h.assignedTo}</span></td>
                    <td>
                        <button class="btn-premium" style="background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3);" onclick="revokeAssignment(${h.id})">Revoke</button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        }
    } catch(err) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:red;">Failed to load history</td></tr>`;
    }
}

async function revokeAssignment(sampleId) {
    if (!confirm('Are you sure you want to revoke this assignment and send it back to the unassigned pool?')) return;
    
    try {
        const res = await fetch('/api/admin/revoke-assignment', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sampleId })
        });
        if (res.ok) {
            showToast('Assignment revoked successfully', 'success');
            loadAssignmentHistory();
            loadUnassignedPool();
        } else {
            const data = await res.json();
            showToast(data.error || 'Failed to revoke', 'error');
        }
    } catch(err) {
        showToast('Network error', 'error');
    }
}

async function runAutoAssigner() {
    showToast('Running Smart Assigner...', 'info');
    try {
        const res = await fetch('/api/auto-assign', { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
            showToast(data.message, 'success');
            // Refresh both modal and tab views
            loadModalUnassignedPool();
            loadModalRecommendations();
            loadRecommendations();
            loadUnassignedPool();
            fetchSamples(); // Sync with Master List
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
            const data = await res.json();
            loadRecommendations();
            loadUnassignedPool();
            if (data.sampleId) {
                triggerExcelDownloadAndPrint([data.sampleId]);
            }
        }
    } catch (err) { console.error(err); }
}

async function rejectRecommendation(id, sampleId) {
    try {
        const res = await fetch(`/api/reject-assignment/${id}`, { method: 'POST' });
        if (res.ok) {
            showToast('Assignment Rejected', 'info');
            loadRecommendations();
            openManualAssignModal(sampleId, id);
        }
    } catch (err) { console.error(err); showToast('Network error, please try again.', 'error'); }
}

function openManualAssignModal(sampleId, recId) {
    document.getElementById('manual-assign-sample-id').value = sampleId;
    document.getElementById('manual-assign-rec-id').value = recId;
    
    const select = document.getElementById('manual-assign-employee');
    let tpOptions = '<option value="">-- Direct Assign --</option>';
    const sourceSelect = document.getElementById('leave-employee-select');
    if (sourceSelect && sourceSelect.options.length > 0) {
        for(let i=0; i<sourceSelect.options.length; i++) {
            tpOptions += `<option value="${sourceSelect.options[i].text}">${sourceSelect.options[i].text}</option>`;
        }
    }
    select.innerHTML = tpOptions;
    
    document.getElementById('manual-assign-modal').classList.add('active');
}

function closeManualAssignModal() {
    document.getElementById('manual-assign-modal').classList.remove('active');
}

async function confirmManualAssign() {
    const sampleId = document.getElementById('manual-assign-sample-id').value;
    const tpName = document.getElementById('manual-assign-employee').value;
    
    if (!tpName) return showToast('Please select an employee.', 'warning');
    
    try {
        const res = await fetch('/api/assign-sample-manual', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sampleId, username: tpName })
        });
        if (res.ok) {
            showToast(`Assigned manually to ${tpName}`, 'success');
            closeManualAssignModal();
            loadUnassignedPool();
            triggerExcelDownloadAndPrint([parseInt(sampleId)]);
        } else {
            showToast('Failed to assign manually.', 'error');
        }
    } catch (err) {
        console.error(err);
        showToast('Network error.', 'error');
    }
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

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

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
            <td>${getISNumberHtml(row.isNumber)}</td>
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
    if (tabId === 'tab-assigner') {
        fetchTemplates();
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
                    <div class="is-vault-item-title">${getISNumberHtml(doc.isNumber)}</div>
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
        renderISSimpleResults();

        // Update parse status bar — wording + colour reflect actual confidence so a low
        // score never reads as a confident "Fully Parsed" with a half-empty loading bar.
        const statusEl = document.getElementById('is-parse-status-bar');
        if (statusEl) {
            const conf = doc.confidenceScore || 0;
            const confPct = Math.round(conf * 100);
            const tier = conf >= 0.85
                ? { label: 'Fully Parsed', color: 'var(--success)', icon: '✅', cls: 'success' }
                : conf >= 0.6
                    ? { label: 'Parsed — review recommended', color: 'var(--warning)', icon: '⚠️', cls: 'warning' }
                    : { label: 'Parsed — low confidence, please review', color: 'var(--danger)', icon: '⚠️', cls: 'warning' };
            const nClauses = doc.clauses.length, nTables = doc.tables.length;
            statusEl.style.display = 'flex';
            statusEl.className = `is-parse-status ${tier.cls}`;
            statusEl.innerHTML = `
                <span style="font-size:1.2rem;">${tier.icon}</span>
                <div class="is-parse-progress">
                    <div style="font-size:0.88rem; font-weight:600; color:${tier.color};">${escapeHtml(doc.isNumber)} — ${tier.label}</div>
                    <div style="font-size:0.78rem; color:var(--text-muted); margin-top:2px;">${nClauses} clause${nClauses === 1 ? '' : 's'} · ${nTables} table${nTables === 1 ? '' : 's'} extracted</div>
                    <div class="is-parse-progress-bar" style="margin-top:6px;" title="Extraction confidence ${confPct}%"><div class="is-parse-progress-fill" style="width:${confPct}%; background:${tier.color};"></div></div>
                    <div style="font-size:0.7rem; color:var(--text-muted); margin-top:3px;">Extraction confidence: ${confPct}%</div>
                </div>
            `;
        }
    } catch(e) {
        showToast('Error loading document details.', 'error');
    }
}

// --- Render Simple Results (demo UI: header + OD table + clauses) ---
function renderISSimpleResults() {
    const doc = isActiveDocument;
    if (!doc) return;

    const emptyEl = document.getElementById('is-empty-state');
    const resultsEl = document.getElementById('is-results-panel');
    if (emptyEl) emptyEl.style.display = 'none';
    if (resultsEl) resultsEl.style.display = 'block';

    // Header card — title + actions only. Counts/confidence live in the status bar above,
    // so they're not repeated here.
    const headerEl = document.getElementById('is-results-header');
    if (headerEl) {
        headerEl.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; padding:16px 20px; background:var(--glass-bg); border:1px solid var(--glass-border); border-radius:10px;">
                <div>
                    <div style="font-size:1.1rem; font-weight:700; color:var(--text-main);">${escapeHtml(doc.isNumber)}</div>
                    <div style="font-size:0.85rem; color:var(--text-muted); margin-top:3px;">${escapeHtml(doc.title || '')}</div>
                </div>
                <button onclick="openISReport()" class="btn-premium" style="background:rgba(59,130,246,0.15); color:#93c5fd; border:1px solid rgba(59,130,246,0.3); padding:9px 16px; border-radius:8px; cursor:pointer; font-weight:600; font-size:0.88rem; white-space:nowrap;">📋 Generate Report</button>
            </div>
        `;
    }

    // Dimension/OD table
    const odEl = document.getElementById('is-od-table-section');
    if (odEl) {
        const dimData = doc.dimensionData;
        if (dimData && dimData.tables && dimData.tables.length > 0) {
            odEl.style.display = 'block';
            odEl.innerHTML = dimData.tables.map(tbl => {
                const headers = tbl.columns || tbl.headers || [];
                const rows = tbl.rows || [];
                if (!rows.length) return '';
                return `
                    <div style="margin-bottom:16px;">
                        <div style="font-weight:700; font-size:0.9rem; color:var(--text-main); margin-bottom:8px;">📐 ${escapeHtml(tbl.description || tbl.tableId || 'Dimension Data')}</div>
                        <div class="table-container premium-table-container custom-scrollbar" style="max-height:300px; overflow:auto;">
                            <table class="premium-table glass-table" style="font-size:0.8rem; width:100%;">
                                <thead><tr>
                                    <th style="white-space:nowrap;">${tbl.type === 'dimensional' ? 'DN' : '#'}</th>
                                    ${headers.map(h => `<th style="white-space:nowrap;">${escapeHtml(h)}</th>`).join('')}
                                </tr></thead>
                                <tbody>
                                    ${rows.map(r => `<tr>
                                        <td style="font-weight:600;">${escapeHtml(String(r.key))}</td>
                                        ${headers.map(h => `<td>${escapeHtml(String(r.values[h] ?? '—'))}</td>`).join('')}
                                    </tr>`).join('')}
                                </tbody>
                            </table>
                        </div>
                    </div>
                `;
            }).join('');
        } else {
            odEl.style.display = 'none';
        }
    }

    // Clauses accordion
    const clausesSection = document.getElementById('is-clauses-section');
    if (clausesSection) {
        clausesSection.style.display = isParsedClauses.length > 0 ? 'block' : 'none';
        renderISClauses();
    }
}

// --- Test Report (opened from the vault screen's "Generate Report" button) ---
// For IS 4985 this replicates the LIMS auto-uploader report: Size/Class/Type/Plumbing
// selectors drive the 31 computed rows from specs_db.generateTestParameters, with the same
// type-aware observed-value inputs and green/red glow validation (validateObservation).
// Other standards fall back to the pipeline's extracted parameters in the same 5-column shape.
function isVaultReport4985() {
    return !!(isActiveDocument && /4985/.test(String(isActiveDocument.isNumber || '')));
}

async function openISReport() {
    const doc = isActiveDocument;
    if (!doc) { showToast('Select a standard first.', 'error'); return; }
    const modal = document.getElementById('is-report-modal');
    const tbody = document.getElementById('is-report-tbody');
    const titleEl = document.getElementById('is-report-title');
    const subEl = document.getElementById('is-report-subtitle');
    const toolbar = document.getElementById('is-report-toolbar');
    if (!modal || !tbody) return;

    const dynToolbar = document.getElementById('is-report-toolbar-dyn');
    if (titleEl) titleEl.textContent = `${doc.isNumber} — Test Report`;
    if (subEl) subEl.textContent = doc.title || '';
    modal.classList.add('active');
    tbody.innerHTML = '<tr><td colspan="5" style="padding:14px; color:var(--text-muted);">Loading…</td></tr>';

    // 1) Structured template (new path) — clause-by-clause, per-standard dropdowns.
    const tpl = await loadVaultTemplate(doc.isNumber);
    if (tpl) {
        if (toolbar) toolbar.style.display = 'none';
        vaultTemplate = tpl;
        renderVaultISReportFromTemplate(tpl);
        return;
    }
    if (dynToolbar) dynToolbar.style.display = 'none';
    vaultTemplate = null;

    // 2) IS 4985 (hardcoded specs_db, until its extracted template supersedes it).
    const is4985 = isVaultReport4985() && typeof IS_4985_SPECS !== 'undefined';
    if (toolbar) toolbar.style.display = is4985 ? 'flex' : 'none';
    setReportThead(false);

    if (is4985) {
        // Populate the size dropdown from sizes_db (kept in sync with the spec)
        const sizeSel = document.getElementById('is-report-size');
        if (sizeSel && !sizeSel.options.length) {
            const sizes = Object.keys(IS_4985_SPECS.sizes_db).map(Number).sort((a, b) => a - b);
            sizeSel.innerHTML = sizes.map(s => `<option value="${s}"${s === 75 ? ' selected' : ''}>${s}</option>`).join('');
        }
        renderVaultISReport();
    } else {
        await renderVaultISReportFallback(doc);
    }
}

// Load a structured per-IS report template (JSON) if one exists for this standard.
let vaultTemplate = null;
async function loadVaultTemplate(isNumber) {
    const slug = String(isNumber || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (!slug) return null;
    try {
        const r = await fetch(`/is_templates/${slug}.json`);
        if (!r.ok) return null;
        return await r.json();
    } catch (e) { return null; }
}

// Switch the report table header between the template format (4 cols) and the 4985 format (5 cols w/ Type).
function setReportThead(template) {
    const tr = document.getElementById('is-report-thead-row');
    if (!tr) return;
    const th = (t, w) => `<th style="padding:8px 10px;${w ? ` width:${w};` : ''}">${t}</th>`;
    tr.innerHTML = template
        ? th('Clause') + th('Test Parameter') + th('Specified value') + th('Observed value', '210px')
        : th('Clause') + th('Test Parameter') + th('Specified Value') + th('Type', '90px') + th('Observed Value', '190px');
}

// ── Template-driven renderer (clause-by-clause, per-standard dropdowns + conditional NA) ──
function renderVaultISReportFromTemplate(tpl) {
    setReportThead(true);
    const dyn = document.getElementById('is-report-toolbar-dyn');
    if (!dyn) return;
    const dims = tpl.parameterizationDims || [];
    const labels = { size: 'Nominal Size (DN)', type: 'Type', class: 'Class', socket: 'Socket' };
    const defaults = tpl.defaults || {};
    const selStyle = 'border-radius:6px; padding:8px; background:rgba(0,0,0,0.25); border:1px solid var(--glass-border); color:white; font-size:0.85rem;';
    let html = `<div><label style="display:block; font-size:0.72rem; color:var(--text-muted); margin-bottom:5px; font-weight:600;">Sample Code</label><input type="text" id="tpl-sample" placeholder="optional" style="width:140px; ${selStyle}"></div>`;
    dims.forEach(d => {
        const opts = (tpl.dimensionOptions && tpl.dimensionOptions[d]) || [];
        const def = defaults[d];
        html += `<div><label style="display:block; font-size:0.72rem; color:var(--text-muted); margin-bottom:5px; font-weight:600;">${labels[d] || d}</label>`
            + `<select id="tpl-dim-${d}" onchange="renderVaultISReportRows()" style="min-width:110px; ${selStyle}">`
            + opts.map(o => `<option value="${escapeHtml(String(o))}"${String(o) === String(def) ? ' selected' : ''}>${escapeHtml(String(o))}</option>`).join('')
            + `</select></div>`;
    });
    html += `<button onclick="printVaultISReport()" class="btn-premium" style="margin-left:auto; background:rgba(245,158,11,0.15); color:#f59e0b; border:1px solid rgba(245,158,11,0.3); padding:9px 14px; border-radius:6px; cursor:pointer; font-weight:600; font-size:0.85rem;">🖨️ Print / Save as PDF</button>`;
    dyn.innerHTML = html;
    dyn.style.display = 'flex';
    renderVaultISReportRows();
}

function tplCondMet(cond, sel) {
    return Object.entries(cond || {}).every(([k, v]) => String(sel[k]) === String(v));
}

function tplResolvePath(gridForSize, path, sel) {
    let cur = gridForSize;
    for (let seg of path) {
        if (typeof seg === 'string' && seg.startsWith('{') && seg.endsWith('}')) seg = sel[seg.slice(1, -1)];
        if (cur == null) return null;
        cur = cur[seg];
    }
    return (cur === undefined) ? null : cur;
}

function renderVaultISReportRows() {
    const tpl = vaultTemplate;
    if (!tpl) return;
    const sel = {};
    (tpl.parameterizationDims || []).forEach(d => {
        const el = document.getElementById('tpl-dim-' + d);
        sel[d] = el ? el.value : (tpl.defaults || {})[d];
    });
    const grid = (tpl.dimensionGrid || {})[String(sel.size)] || null;
    const rows = [];
    let lastSection = null;
    (tpl.parameters || []).forEach(p => {
        if (p.section && p.section !== lastSection) { rows.push({ section: p.section }); lastSection = p.section; }

        if (p.conditionalOn && !tplCondMet(p.conditionalOn, sel)) {
            rows.push({ clause: p.clauseRef, name: p.parameterName, method: p.testMethod, spec: '—', na: true });
            return;
        }
        if (Array.isArray(p.gridRows)) {
            p.gridRows.forEach(gr => {
                const val = grid ? tplResolvePath(grid, gr.path, sel) : null;
                rows.push({
                    clause: p.clauseRef, name: `${p.parameterName} (${gr.label})`, method: p.testMethod,
                    spec: (val == null) ? '— (pending re-extract)' : `${gr.label} ${val} ${p.unit || ''}`.trim(),
                    min: gr.limit === 'min' ? val : '', max: gr.limit === 'max' ? val : '',
                    type: 'Quantitative', needsReview: val == null,
                });
            });
            return;
        }
        // Constant parameter. specText already carries its own units; only synthesize
        // a spec (and append the unit) when there's no specText.
        const isQual = p.limitType === 'qualitative' || p.limitType === 'text';
        let spec;
        if (p.specText) {
            spec = p.specText;
        } else {
            const mm = [p.min ? `Min ${p.min}` : '', p.max ? `Max ${p.max}` : ''].filter(Boolean).join(' / ');
            spec = (mm + (p.unit ? ` ${p.unit}` : '')).trim() || (p.expected || '');
        }
        rows.push({
            clause: p.clauseRef, name: p.parameterName, method: p.testMethod, spec: spec,
            min: p.min || '', max: p.max || '', expected: p.expected || '', qualitative: isQual,
            type: isQual ? 'Qualitative' : 'Quantitative', needsReview: !!p.needsReview,
        });
    });
    renderTemplateRowsToTbody(rows);
}

function renderTemplateRowsToTbody(rows) {
    const tbody = document.getElementById('is-report-tbody');
    if (!tbody) return;
    const cell = 'padding:8px 10px; border-bottom:1px solid rgba(255,255,255,0.06); vertical-align:top;';
    tbody.innerHTML = rows.map((r, idx) => {
        if (r.section) {
            return `<tr class="tpl-section"><td colspan="4" style="padding:9px 10px; background:rgba(99,102,241,0.10); font-weight:700; font-size:0.8rem; color:var(--text-main); letter-spacing:0.4px;">${escapeHtml(r.section)}</td></tr>`;
        }
        const methodSub = r.method ? `<div style="font-size:0.68rem; color:var(--text-muted); margin-top:2px;">method: ${escapeHtml(r.method)}</div>` : '';
        const flag = r.needsReview ? ` <span style="font-size:0.62rem; background:rgba(245,158,11,0.18); color:var(--warning); padding:1px 6px; border-radius:8px; font-weight:700;">REVIEW</span>` : '';
        let observed;
        if (r.na) {
            observed = `<span style="color:var(--text-muted); font-style:italic;">Not applicable</span>`;
        } else if (r.qualitative) {
            const opts = [];
            if (r.expected) opts.push(r.expected);
            ['Satisfactory', 'Pass', 'Unsatisfactory', 'Fail', 'Not Done', 'NA'].forEach(o => { if (!opts.includes(o)) opts.push(o); });
            observed = `<select class="vault-report-input" data-idx="${idx}" data-min="" data-max="" onchange="validateObservation(this)" style="width:100%; border-radius:4px; padding:6px; background:rgba(0,0,0,0.3); border:1px solid var(--glass-border); color:white;">${opts.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('')}</select>`;
        } else {
            observed = `<input type="number" step="0.01" class="vault-report-input" data-idx="${idx}" data-min="${escapeHtml(String(r.min ?? ''))}" data-max="${escapeHtml(String(r.max ?? ''))}" oninput="validateObservation(this)" style="width:100%; border-radius:4px; padding:6px; background:rgba(0,0,0,0.3); border:1px solid var(--glass-border); color:white;" placeholder="Enter value">`;
        }
        return `<tr>
            <td style="${cell} white-space:nowrap; font-weight:600;">${escapeHtml(String(r.clause || ''))}</td>
            <td style="${cell}">${escapeHtml(String(r.name || ''))}${flag}${methodSub}</td>
            <td style="${cell} color:#61afef;">${escapeHtml(String(r.spec || ''))}</td>
            <td style="${cell}">${observed}</td>
        </tr>`;
    }).join('');
}

// Build the observed-value input for a parameter row — mirrors renderTestParametersTable
// so the vault report behaves identically to the LIMS table (green/red glow on input).
function vaultObservedInputHtml(row, idx) {
    const val = row.expected || '';
    if (row.type === 'Qualitative') {
        let opts = [];
        if (row.expected) opts.push(row.expected);
        (row.options || []).forEach(o => { if (!opts.includes(o)) opts.push(o); });
        ['Unsatisfactory', 'Fail', 'Not Done', 'NA'].forEach(o => { if (!opts.includes(o)) opts.push(o); });
        if (val && !opts.includes(val)) opts.unshift(val);
        const optionsHtml = opts.map(o => `<option value="${escapeHtml(o)}"${o === val ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('');
        return `<select class="vault-report-input" data-idx="${idx}" data-min="" data-max="" onchange="validateObservation(this)" style="width:100%; border-radius:4px; padding:6px; background:rgba(0,0,0,0.3); border:1px solid var(--glass-border); color:white;">${optionsHtml}</select>`;
    }
    if (row.type === 'Text') {
        const dlOpts = (row.options || []).map(o => `<option value="${escapeHtml(o)}">`).join('');
        return `<input type="text" list="vault-dl-${idx}" ${val ? `value="${escapeHtml(val)}"` : ''} class="vault-report-input" data-idx="${idx}" data-min="${escapeHtml(String(row.min ?? ''))}" data-max="${escapeHtml(String(row.max ?? ''))}" oninput="validateObservation(this)" style="width:100%; border-radius:4px; padding:6px; background:rgba(0,0,0,0.3); border:1px solid var(--glass-border); color:white;" placeholder="Type or pick"><datalist id="vault-dl-${idx}">${dlOpts}</datalist>`;
    }
    return `<input type="number" step="0.01" ${val ? `value="${escapeHtml(val)}"` : ''} class="vault-report-input" data-idx="${idx}" data-min="${escapeHtml(String(row.min ?? ''))}" data-max="${escapeHtml(String(row.max ?? ''))}" oninput="validateObservation(this)" style="width:100%; border-radius:4px; padding:6px; background:rgba(0,0,0,0.3); border:1px solid var(--glass-border); color:white;" placeholder="Enter value">`;
}

function renderRowsToVaultReport(rows) {
    const tbody = document.getElementById('is-report-tbody');
    if (!tbody) return;
    const cell = 'padding:8px 10px; border-bottom:1px solid rgba(255,255,255,0.06); vertical-align:top;';
    tbody.innerHTML = rows.map((row, idx) => `
        <tr>
            <td style="${cell}">${escapeHtml(String(row.clause || ''))}</td>
            <td style="${cell}">${escapeHtml(String(row.param || ''))}</td>
            <td style="${cell} font-weight:600; color:#61afef;">${escapeHtml(String(row.spec_val || ''))}</td>
            <td style="${cell} color:var(--text-muted);">${escapeHtml(String(row.type || ''))}</td>
            <td style="${cell}">${vaultObservedInputHtml(row, idx)}</td>
        </tr>
    `).join('');
}

// IS 4985: compute the 31 rows from the spec, driven by the four selectors.
function renderVaultISReport() {
    if (typeof IS_4985_SPECS === 'undefined') return;
    const size = (document.getElementById('is-report-size') || {}).value || '75';
    const pipeClass = (document.getElementById('is-report-class') || {}).value || '3';
    const pipeType = (document.getElementById('is-report-type') || {}).value || 'A';
    const isPlumbing = (document.getElementById('is-report-plumbing') || {}).value || 'No';
    const rows = IS_4985_SPECS.generateTestParameters(size, pipeClass, pipeType, isPlumbing);
    renderRowsToVaultReport(rows);
}

// Non-IS-4985: fall back to the pipeline's extracted parameters in the same 5-column shape.
async function renderVaultISReportFallback(doc) {
    const tbody = document.getElementById('is-report-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" style="padding:14px; color:var(--text-muted);">Loading parameters from IS Intelligence…</td></tr>';
    try {
        const res = await fetch(`/api/is-intelligence/params/${encodeURIComponent(doc.isNumber)}`);
        const data = await res.json().catch(() => ({}));
        const params = (data && data.test_parameters) || [];
        if (!params.length) {
            tbody.innerHTML = '<tr><td colspan="5" style="padding:14px; color:var(--text-muted);">No test parameters extracted for this standard yet.</td></tr>';
            return;
        }
        const rows = params.map(p => {
            const min = (p.min != null && p.min !== '') ? p.min : '';
            const max = (p.max != null && p.max !== '') ? p.max : '';
            const spec = p.spec_val || ((min !== '' || max !== '') ? `${min} – ${max}` : (p.expected || ''));
            return { clause: p.clause || '', param: p.param || '', spec_val: spec, type: p.type || 'Quantitative', expected: p.expected || '', options: [], min, max };
        });
        renderRowsToVaultReport(rows);
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="5" style="padding:14px; color:#e06c75;">Failed to load report: ${escapeHtml(e.message)}</td></tr>`;
    }
}

// Print a clean BIS Test Report document — same layout the LIMS uploader uses (previewLimsPdf).
function printVaultISReport() {
    const doc = isActiveDocument || {};
    const tbody = document.getElementById('is-report-tbody');
    const rows = tbody ? [...tbody.querySelectorAll('tr')] : [];
    if (!rows.length) { showToast('Nothing to print yet.', 'error'); return; }

    const esc = (typeof limsEsc === 'function') ? limsEsc : escapeHtml;
    const showMeta = isVaultReport4985();
    const meta = {
        sampleCode: (document.getElementById('is-report-sample') || {}).value || '',
        isNo: doc.isNumber || '',
        size: (document.getElementById('is-report-size') || {}).value || '',
        pipeClass: (document.getElementById('is-report-class') || {}).value || '',
        type: (document.getElementById('is-report-type') || {}).value || '',
    };

    let bodyRows = '';
    rows.forEach(tr => {
        if (tr.classList.contains('tpl-section')) return; // section header — not a data row
        const c = tr.children;
        const clause = c[0] ? c[0].textContent.trim() : '';
        const param = c[1] ? ((c[1].childNodes[0] && c[1].childNodes[0].textContent) || c[1].textContent).trim() : '';
        const spec = c[2] ? c[2].textContent.trim() : '';
        const input = tr.querySelector('.vault-report-input');
        const observed = input ? (input.value || '') : (c[c.length - 1] ? c[c.length - 1].textContent.trim() : '');
        let result = '—', color = '#64748b';
        if (observed !== '') {
            if (input && input.tagName.toLowerCase() === 'select') {
                const bad = /unsatisfactory|fail/i.test(observed);
                result = bad ? 'Fail' : 'Pass'; color = bad ? '#dc2626' : '#16a34a';
            } else {
                const v = parseFloat(observed);
                const mn = input ? parseFloat(input.getAttribute('data-min')) : NaN;
                const mx = input ? parseFloat(input.getAttribute('data-max')) : NaN;
                let ok = true;
                if (!isNaN(mn) && v < mn) ok = false;
                if (!isNaN(mx) && v > mx) ok = false;
                result = ok ? 'Pass' : 'Fail'; color = ok ? '#16a34a' : '#dc2626';
            }
        }
        bodyRows += `<tr><td>${esc(clause)}</td><td>${esc(param)}</td><td>${esc(spec)}</td><td>${esc(observed) || '<span style="color:#94a3b8">—</span>'}</td><td style="color:${color};font-weight:700;">${result}</td></tr>`;
    });

    const metaBar = showMeta
        ? `<div class="meta"><span><b>Sample Code:</b> ${esc(meta.sampleCode || '—')}</span><span><b>Size (DN):</b> ${esc(meta.size)}</span><span><b>Class:</b> ${esc(meta.pipeClass)}</span><span><b>Type:</b> ${esc(meta.type)}</span></div>`
        : `<div class="meta"><span><b>Sample Code:</b> ${esc(meta.sampleCode || '—')}</span></div>`;

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Test Report ${esc(meta.isNo)}</title>
<style>
  body{font-family:-apple-system,'Segoe UI',sans-serif;color:#1a1a2e;padding:28px;}
  h2{margin:0 0 4px;color:#2957A3;font-size:20px;}
  .sub{color:#64748b;font-size:13px;margin-bottom:14px;}
  .meta{display:flex;flex-wrap:wrap;gap:18px;font-size:13px;margin:12px 0 18px;padding:12px 14px;background:#f1f5f9;border-radius:8px;}
  .meta b{color:#0f172a;}
  table{width:100%;border-collapse:collapse;font-size:12px;}
  th,td{border:1px solid #cbd5e1;padding:7px 9px;text-align:left;}
  th{background:#2957A3;color:#fff;}
  tr:nth-child(even) td{background:#f8fafc;}
</style></head><body>
  <h2>Bureau of Indian Standards — Test Report</h2>
  <div class="sub">${esc(meta.isNo)} — ${esc(doc.title || '')}</div>
  ${metaBar}
  <table><thead><tr><th>Clause</th><th>Test Parameter</th><th>Specified Value</th><th>Observed</th><th>Result</th></tr></thead><tbody>${bodyRows}</tbody></table>
</body></html>`;

    const w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(() => { try { w.print(); } catch (e) {} }, 300); }
    else showToast('Pop-up blocked — allow pop-ups to print this report.', 'error');
}

function closeISReport() {
    const modal = document.getElementById('is-report-modal');
    if (modal) modal.classList.remove('active');
}

// --- Render Analysis: Uncertainties + Clauses ---
function renderISAnalysis() {
    renderISUncertainties();
    renderISClauses();
    renderISTolerance();
    renderISAmendments();
}

// --- Render Uncertainty Flags (enhanced for pipeline consensus items) ---
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
        const resolvedClass = item.resolved ? 'resolved' : '';

        // Severity badge
        const sev = (item.severity || 'warn').toLowerCase();
        const sevBadge = sev === 'error'
            ? '<span style="font-size:0.72rem;background:rgba(239,68,68,0.15);color:var(--danger);padding:2px 8px;border-radius:12px;font-weight:700;">⛔ Error</span>'
            : '<span style="font-size:0.72rem;background:rgba(245,158,11,0.15);color:var(--warning);padding:2px 8px;border-radius:12px;font-weight:700;">⚠ Warning</span>';

        // Reader comparison row (new pipeline format)
        let readerRow = '';
        if (item.reader1 !== undefined || item.reader2 !== undefined) {
            const r1 = item.reader1 ?? '—';
            const r2 = item.reader2 ?? '—';
            readerRow = `
                <div style="display:flex;gap:10px;margin:6px 0;font-size:0.82rem;">
                    <div style="flex:1;padding:6px 10px;background:rgba(99,102,241,0.08);border-radius:6px;border:1px solid rgba(99,102,241,0.2);">
                        <div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:2px;">GEMINI</div>
                        <span style="font-weight:600;font-family:monospace;color:${r1===r2?'var(--success)':'var(--warning)'}">${escapeHtml(String(r1))}</span>
                    </div>
                    <div style="flex:1;padding:6px 10px;background:rgba(16,185,129,0.08);border-radius:6px;border:1px solid rgba(16,185,129,0.2);">
                        <div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:2px;">QWEN</div>
                        <span style="font-weight:600;font-family:monospace;color:${r1===r2?'var(--success)':'var(--warning)'}">${escapeHtml(String(r2))}</span>
                    </div>
                </div>
            `;
        }

        // Location display
        const locParts = [
            item.tableId && item.tableId !== 'validator' ? escapeHtml(item.tableId) : null,
            item.key ? escapeHtml(item.key) : null,
            item.col ? escapeHtml(item.col) : null,
            item.page ? `p${item.page}` : (item.clauseNumber ? escapeHtml(item.clauseNumber) : null),
        ].filter(Boolean);
        const locationDisplay = locParts.join(' › ');

        // Page image hint
        const pageHint = item.hasPageImage
            ? `<div style="font-size:0.72rem;color:var(--accent);margin-top:4px;">📄 Page ${item.imagePage} image available from extraction</div>`
            : '';

        // Reason / detail display
        const reasonText = item.reason
            ? item.reason.replace(/_/g, ' ').replace(/validator:/i, 'Validator — ')
            : 'Unknown reason';
        const detailText = item.detail || item.highlightedText || '';

        const inputArea = item.resolved
            ? `<div style="display:flex;align-items:center;gap:8px;"><span class="is-badge is-badge-resolved">✓ Resolved</span><span style="font-size:0.85rem;font-weight:600;color:var(--success);">${escapeHtml(item.userValue)}</span></div>`
            : `<div class="is-uncertainty-input-row">
                <input type="text" id="is-clarify-${item.id}" placeholder="Enter correct value (e.g. 25.3)…" />
                <button onclick="submitISClarification('${item.id}')" class="primary" style="padding:8px 14px;">✓ Confirm</button>
               </div>`;

        return `
            <div class="is-uncertainty-card ${resolvedClass}" id="is-card-${item.id}">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
                    <span class="is-citation" style="cursor:default;font-size:0.8rem;">${locationDisplay || 'Unknown location'}</span>
                    ${sevBadge}
                </div>
                <div style="font-size:0.82rem;color:var(--text-muted);margin-bottom:4px;">⚠ ${escapeHtml(reasonText)}</div>
                ${detailText ? `<div style="font-size:0.78rem;color:var(--text-muted);font-style:italic;margin-bottom:4px;">${escapeHtml(String(detailText).slice(0, 120))}</div>` : ''}
                ${readerRow}
                ${pageHint}
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

function renderISAmendments() {
    const listEl = document.getElementById('is-amendments-list');
    const badgeEl = document.getElementById('is-amendments-badge-count');
    const formEl = document.getElementById('is-amendments-admin-form');
    if (!listEl) return;

    if (!isActiveDocument) {
        listEl.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-muted);">Select a standard from the vault first</div>';
        if (badgeEl) badgeEl.textContent = '0 Amendments';
        if (formEl) formEl.style.display = 'none';
        return;
    }

    const norm = normalizeISNumber(isActiveDocument.isNumber);
    const data = isAmendmentsMap[norm] || { count: 0, hasNew: false, list: [] };

    if (badgeEl) badgeEl.textContent = `${data.count} Amendment${data.count !== 1 ? 's' : ''}`;

    if (formEl) {
        formEl.style.display = isAdminOrSuperAdmin() ? 'block' : 'none';
    }

    if (data.list.length === 0) {
        listEl.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-muted); font-size:0.88rem;">No amendments registered for this standard yet.</div>';
        return;
    }

    listEl.innerHTML = data.list.map(a => {
        const newTag = a.isNew ? '<span class="is-badge is-badge-medium new-amd-badge" style="display:inline-block; animation:none; font-size:0.7rem; padding:2px 6px; border-radius:4px; margin-left:8px;">New</span>' : '';
        const actionBtn = a.isNew 
            ? `<button onclick="dismissAmendmentHighlight(${a.id}, '${norm}')" class="btn-premium" style="font-size:0.75rem; padding:4px 8px; background:rgba(245,158,11,0.15); color:#b06000; border:1px solid rgba(245,158,11,0.3); border-radius:4px; cursor:pointer;">Dismiss Highlight</button>`
            : '';
        const deleteBtn = isAdminOrSuperAdmin()
            ? `<button onclick="deleteAmendment(${a.id}, '${norm}')" style="background:transparent; border:none; color:var(--danger); font-size:1.15rem; cursor:pointer; padding:0 4px;" title="Delete Amendment">&times;</button>`
            : '';
        return `
            <div class="glass-panel" style="padding:14px; border:1px solid var(--glass-border); border-radius:8px; display:flex; justify-content:space-between; align-items:center; background:#ffffff;">
                <div>
                    <div style="font-weight:700; color:var(--text-main); font-size:0.9rem; display:flex; align-items:center;">
                        ${escapeHtml(a.amendmentNumber)}${newTag}
                    </div>
                    <div style="font-size:0.8rem; color:var(--text-muted); margin-top:4px;">${escapeHtml(a.title)}</div>
                    <div style="font-size:0.75rem; color:#64748b; margin-top:6px;">Published: ${a.publishDate || 'Unknown'}</div>
                </div>
                <div style="display:flex; align-items:center; gap:10px;">
                    ${actionBtn}
                    ${deleteBtn}
                </div>
            </div>
        `;
    }).join('');
}

async function addNewAmendment() {
    if (!isActiveDocument) return;
    const numEl = document.getElementById('add-amd-num');
    const dateEl = document.getElementById('add-amd-date');
    const titleEl = document.getElementById('add-amd-title');
    const isNewEl = document.getElementById('add-amd-is-new');

    if (!numEl || !titleEl) return;

    const amendmentNumber = numEl.value.trim();
    const title = titleEl.value.trim();
    const publishDate = dateEl ? dateEl.value : '';
    const isNew = isNewEl ? isNewEl.checked : true;

    if (!amendmentNumber || !title) {
        showToast('Please fill in Amendment Number and Title.', 'warning');
        return;
    }

    try {
        const res = await fetch('/api/is-intelligence/amendments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                isNumber: isActiveDocument.isNumber,
                amendmentNumber,
                title,
                publishDate,
                isNew
            })
        });

        if (res.ok) {
            showToast('Amendment added successfully.', 'success');
            numEl.value = '';
            titleEl.value = '';
            if (dateEl) dateEl.value = '';
            if (isNewEl) isNewEl.checked = true;

            await loadAmendments();
            if (typeof renderTable === 'function') renderTable();
            if (typeof renderScTableFiltered === 'function') renderScTableFiltered();
            renderISAmendments();
        } else {
            showToast('Failed to save amendment.', 'error');
        }
    } catch(e) {
        console.error(e);
        showToast('Error adding amendment.', 'error');
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
        showToast('Only PDF files are accepted.', 'error');
        return;
    }

    const PHASE_LABELS = [
        '📄 Phase 0 — Ingesting document…',
        '🧠 Phase 1 — Claude Opus reading structure…',
        '👁 Phase 2 — Gemini Flash extracting tables…',
        '✅ Phase 3 — Validating & normalising cells…',
        '✅ Phase 4 — Finalizing trusted output…',
        '💾 Phase 5 — Saving to vault…',
        '📊 Phase 6 — Calibrating against baseline…',
    ];
    const statusEl = document.getElementById('is-parse-status-bar');

    function setStatus(phaseName, pct, isError) {
        if (!statusEl) return;
        statusEl.style.display = 'flex';
        statusEl.className = 'is-parse-status ' + (isError ? 'error' : 'parsing');
        statusEl.innerHTML = `
            <div class="is-parse-spinner" style="${isError ? 'display:none' : ''}"></div>
            <div class="is-parse-progress">
                <div style="font-size:0.88rem; font-weight:600; color:var(--accent);">
                    ${isError ? '❌ ' : ''}${escapeHtml(file.name)}
                </div>
                <div style="font-size:0.78rem; color:var(--text-muted); margin-top:2px;">${escapeHtml(phaseName)}</div>
                <div class="is-parse-progress-bar" style="margin-top:6px;">
                    <div class="is-parse-progress-fill" style="width:${pct}%; ${isError ? 'background:var(--danger)' : ''};"></div>
                </div>
            </div>
        `;
    }

    setStatus(PHASE_LABELS[0], 3, false);

    const formData = new FormData();
    formData.append('pdf', file);

    let jobId = null;
    try {
        const startRes = await fetch('/api/is-intelligence/upload', { method: 'POST', body: formData });
        const startData = await startRes.json();
        if (!startRes.ok || startData.error) {
            setStatus(startData.error || 'Upload failed', 0, true);
            showToast(startData.error || 'Upload failed', 'error');
            return;
        }
        jobId = startData.jobId;
        showToast(`Pipeline started for ${file.name} — extracting all ${PHASE_LABELS.length} phases…`, 'info');
    } catch (e) {
        setStatus('Upload failed: ' + e.message, 0, true);
        showToast('Upload failed: ' + e.message, 'error');
        return;
    }

    fileInput.value = '';
    const analyzeBtn = document.getElementById('is-analyze-btn');
    if (analyzeBtn) analyzeBtn.style.display = 'none';
    const filenameLabel = document.getElementById('is-upload-filename');
    if (filenameLabel) { filenameLabel.textContent = 'Auto-parses clauses & tables'; filenameLabel.style.color = ''; }

    // Poll until done
    await pollPipelineJob(jobId, setStatus, PHASE_LABELS);
}

async function pollPipelineJob(jobId, setStatus, phaseLabels) {
    const POLL_INTERVAL = 2500;
    const MAX_POLLS = 240; // 10 minutes max
    let polls = 0;

    return new Promise(resolve => {
        async function poll() {
            polls++;
            if (polls > MAX_POLLS) {
                setStatus('Pipeline timed out — please check server logs', 0, true);
                showToast('Pipeline timed out after 10 minutes', 'error');
                return resolve(null);
            }

            let job;
            try {
                const res = await fetch('/api/is-intelligence/pipeline/' + jobId);
                job = await res.json();
            } catch (e) {
                setTimeout(poll, POLL_INTERVAL);
                return;
            }

            if (job.error && job.status !== 'error') {
                // 404 or network issue — keep retrying briefly
                setTimeout(poll, POLL_INTERVAL);
                return;
            }

            const label = phaseLabels[Math.min(job.phase, phaseLabels.length - 1)];
            const pct = Math.max(3, job.progress || 0);

            if (job.status === 'running') {
                setStatus(label + ' ' + (job.phaseLabel || ''), pct, false);
                setTimeout(poll, POLL_INTERVAL);
                return;
            }

            if (job.status === 'error') {
                setStatus('Error in ' + (job.phaseLabel || 'pipeline') + ': ' + (job.error || ''), pct, true);
                showToast('Pipeline failed: ' + (job.error || 'unknown error'), 'error');
                return resolve(null);
            }

            if (job.status === 'done' && job.result) {
                const r = job.result;
                const statusEl = document.getElementById('is-parse-status-bar');
                if (statusEl) {
                    statusEl.style.display = 'flex';
                    statusEl.className = 'is-parse-status success';
                    statusEl.innerHTML = `
                        <span style="font-size:1.2rem;">✅</span>
                        <div class="is-parse-progress">
                            <div style="font-size:0.88rem; font-weight:600; color:var(--success);">
                                ${escapeHtml(r.isNumber)} — Pipeline Complete
                            </div>
                            <div style="font-size:0.78rem; color:var(--text-muted); margin-top:2px;">
                                ${r.pagesProcessed}/${r.pagesTotal} pages · ${r.tablesFound} tables · ${r.paramsExtracted} params · ${Math.round((r.agreementRate || 0) * 100)}% reader agreement
                                ${r.uncertainCount > 0 ? ` · <span style="color:var(--warning);">⚠ ${r.uncertainCount} items need confirm</span>` : ' · <span style="color:var(--success);">✓ all agreed</span>'}
                            </div>
                            <div class="is-parse-progress-bar" style="margin-top:6px;"><div class="is-parse-progress-fill" style="width:100%;"></div></div>
                            ${r.calibration ? `<div style="font-size:0.75rem; margin-top:4px; color:${r.calibration.accuracy >= 95 ? 'var(--success)' : 'var(--warning)'};">📊 IS 4985 calibration: ${r.calibration.accuracy}% vs specs_db.js</div>` : ''}
                        </div>
                    `;
                }

                showToast(`✅ ${r.isNumber} extracted — ${r.paramsExtracted} params, ${r.uncertainCount} flags`, 'success');
                await fetchISVault();
                await selectISDocument(r.vaultId);
                return resolve(r);
            }

            setTimeout(poll, POLL_INTERVAL);
        }
        setTimeout(poll, 1000); // first poll after 1s
    });
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

function switchISInnerTab(tabName) {
    document.querySelectorAll('.is-inner-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.is-inner-content').forEach(c => c.style.display = 'none');

    const activeTab = document.querySelector(`.is-inner-tab[data-tab="${tabName}"]`);
    if (activeTab) activeTab.classList.add('active');

    const activeContent = document.getElementById(`is-inner-${tabName}`);
    if (activeContent) activeContent.style.display = 'block';

    if (tabName === 'amendments') {
        renderISAmendments();
    }
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

var currentTemplates = {};

function openTemplatesModal() {
    const modal = document.getElementById('templates-modal');
    if (modal) {
        modal.classList.add('active');
        fetchTemplates();
    }
}

function closeTemplatesModal() {
    const modal = document.getElementById('templates-modal');
    if (modal) modal.classList.remove('active');
}

async function populateISDropdown() {
    const isSelect = document.getElementById('template-is-select');
    if (!isSelect) return;
    // Only populate if empty
    if (isSelect.options.length > 0) return;
    try {
        const r = await fetch('/api/is-intelligence/vault');
        const d = await r.json();
        const standards = (d.vault || []).map(v => v.isNumber).filter(Boolean);
        standards.forEach(standard => {
            const opt = document.createElement('option');
            opt.value = standard;
            opt.textContent = standard;
            isSelect.appendChild(opt);
        });
        if (!standards.length) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '— Upload an IS standard in IS Intelligence first —';
            isSelect.appendChild(opt);
        }
        isSelect.selectedIndex = 0;
    } catch (e) { console.error('Failed to load vault standards for template dropdown:', e); }
}

async function fetchTemplates() {
    await populateISDropdown(); // Ensure dropdown is populated from vault first
    loadTemplateForIS(); // Load clause list from vault for selected IS

    try {
        const res = await fetch('/api/admin/templates');
        if (res.ok) {
            const data = await res.json();
            currentTemplates = data.templates || {};
            // Reload with any saved user preferences from backend
            loadTemplateForIS();
        }
    } catch(e) { 
        console.error("Could not fetch templates from backend:", e); 
    }
}

async function loadTemplateForIS() {
    const tbody = document.getElementById('template-params-tbody');
    if (!tbody) return;

    const isSelect = document.getElementById('template-is-select');
    if (!isSelect) return;
    const isNumber = isSelect.value;
    if (!isNumber) return;

    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text-muted);">Loading from IS Intelligence vault…</td></tr>';

    let clauses = [];
    try {
        const res = await fetch(`/api/is-intelligence/params/${encodeURIComponent(isNumber)}`);
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.found && data.test_parameters && data.test_parameters.length) {
            // Deduplicate by clause — one row per clause in the template
            const seen = new Set();
            data.test_parameters.forEach(p => {
                if (!seen.has(p.clause)) {
                    seen.add(p.clause);
                    clauses.push({ clause: p.clause, param: p.param, hours: 1.0 });
                }
            });
        }
    } catch (e) { console.error('Failed to load params from vault:', e); }

    if (!clauses.length) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:20px;color:#e06c75;">No parameters found for <strong>${isNumber}</strong> in IS Intelligence vault. Upload the IS standard PDF in IS Intelligence first.</td></tr>`;
        return;
    }

    try {

        tbody.innerHTML = '';
        
        if (!clauses || clauses.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:20px; color:var(--text-muted);">No clauses found for ${isNumber}.</td></tr>`;
            return;
        }
        
        const savedTemplate = currentTemplates[isNumber] || {};
        const activeClauses = savedTemplate.activeClauses || {};

        const tatInput = document.getElementById('template-tat-days');
        if (tatInput) tatInput.value = savedTemplate.tatDays || 7;

        let totalHrs = 0;

        clauses.forEach(c => {
            let isChecked = true;
            let equipment = '';
            let passiveHrs = 0;
            let stdActiveHrs = c.hours || (typeof RAW_MAN_HOURS_DB !== 'undefined' ? RAW_MAN_HOURS_DB[c.clause] : 1.0) || 1.0;
            let activeHrs = stdActiveHrs;

            if (activeClauses && activeClauses.hasOwnProperty(c.clause)) {
                const savedC = activeClauses[c.clause];
                if (typeof savedC === 'object') {
                    isChecked = savedC.active;
                    if (savedC.useSource) {
                        activeHrs = savedC.useSource === 'custom' ? (savedC.customHours || stdActiveHrs) : stdActiveHrs;
                    } else {
                        activeHrs = savedC.activeHours !== undefined ? savedC.activeHours : stdActiveHrs;
                    }
                    passiveHrs = savedC.passiveHours || 0;
                    equipment = savedC.equipment || '';
                } else {
                    isChecked = savedC; // legacy boolean
                }
            }
            
            if (isChecked) totalHrs += activeHrs;

            const tr = document.createElement('tr');
            tr.style.cssText = "border-bottom: 1px solid #f1f5f9; transition: background 0.2s ease;";
            tr.onmouseover = () => tr.style.background = '#f8fafc';
            tr.onmouseout = () => tr.style.background = 'transparent';
            
            // Custom designed animated checkbox for a premium look
            const checkboxHtml = `
                <div style="display: flex; justify-content: center;">
                    <label style="position: relative; cursor: pointer; display: flex; align-items: center;">
                        <input type="checkbox" class="template-clause-chk" data-clause="${c.clause}" ${isChecked ? 'checked' : ''} onchange="this.nextElementSibling.style.opacity = this.checked ? '1' : '0'; this.nextElementSibling.style.transform = this.checked ? 'scale(1)' : 'scale(0.5)'; this.style.borderColor = this.checked ? '#3b82f6' : '#cbd5e1'; this.style.background = this.checked ? '#3b82f6' : 'white'; this.style.boxShadow = this.checked ? '0 2px 5px rgba(59,130,246,0.3)' : 'none'; updateTemplateTotal()" style="appearance: none; width: 22px; height: 22px; border: 2px solid ${isChecked ? '#3b82f6' : '#cbd5e1'}; border-radius: 6px; background: ${isChecked ? '#3b82f6' : 'white'}; cursor: pointer; transition: all 0.2s ease; margin: 0; box-shadow: ${isChecked ? '0 2px 5px rgba(59,130,246,0.3)' : 'none'};">
                        <svg style="position: absolute; left: 4px; top: 4px; pointer-events: none; opacity: ${isChecked ? '1' : '0'}; transform: scale(${isChecked ? '1' : '0.5'}); transition: all 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275);" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                    </label>
                </div>
            `;

            tr.innerHTML = `
                <td style="padding: 14px 16px;">${checkboxHtml}</td>
                <td style="padding: 14px 16px;">
                    <div style="display: flex; flex-direction: column; gap: 4px;">
                        <span style="font-weight: 700; color: #0f172a; font-size: 0.95rem;">Clause ${c.clause}</span>
                        <span style="color: #64748b; font-size: 0.85rem; font-weight: 500;">${c.param}</span>
                    </div>
                </td>
                <td style="padding: 14px 16px;">
                    <input type="text" class="template-equip-input" value="${equipment}" placeholder="e.g. UTM, Oven" style="width: 100%; padding: 8px 10px; background: white; border: 1px solid #cbd5e1; color: #0f172a; border-radius: 6px; font-size: 0.85rem; font-weight: 500; transition: all 0.2s; outline: none; box-shadow: 0 1px 2px rgba(0,0,0,0.03);" onchange="saveTemplateForIS()" onfocus="this.style.borderColor='#3b82f6'; this.style.boxShadow='0 0 0 3px rgba(59,130,246,0.1)';" onblur="this.style.borderColor='#cbd5e1'; this.style.boxShadow='0 1px 2px rgba(0,0,0,0.03)';">
                </td>
                <td style="padding: 14px 16px; text-align: center;">
                    <span class="template-std-hrs" data-val="${stdActiveHrs}" style="font-weight: 700; color: #64748b; font-size: 0.9rem;">${stdActiveHrs}</span>
                </td>
                <td style="padding: 14px 16px; text-align: center;">
                    <input type="number" class="template-passive-hrs-input" value="${passiveHrs}" step="0.5" style="width: 70px; padding: 8px; background: white; border: 1px solid #cbd5e1; color: #0f172a; border-radius: 6px; font-size: 0.85rem; font-weight: 600; text-align: center; transition: all 0.2s; outline: none; box-shadow: 0 1px 2px rgba(0,0,0,0.03);" onchange="saveTemplateForIS()" onfocus="this.style.borderColor='#3b82f6'; this.style.boxShadow='0 0 0 3px rgba(59,130,246,0.1)';" onblur="this.style.borderColor='#cbd5e1'; this.style.boxShadow='0 1px 2px rgba(0,0,0,0.03)';">
                </td>
            `;
            tbody.appendChild(tr);
        });

        const totalEl = document.getElementById('template-total-hours');
        if (totalEl) totalEl.textContent = totalHrs.toFixed(1) + ' hrs';
        
        try {
            renderManHoursChart();
            if (typeof updateTemplateCoverage === 'function') updateTemplateCoverage();
        } catch (chartErr) {
            console.error("Chart render error", chartErr);
        }
        
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="5" style="color:red; padding:20px; font-weight:bold;">Debug Error: ${err.message}</td></tr>`;
        console.error(err);
    }
}

let manHoursChartInstance = null;

function renderManHoursChart() {
    if (typeof Chart === 'undefined') return; // Guard against CDN failure
    const ctx = document.getElementById('manHoursChart');
    if (!ctx) return;
    
    const trs = document.querySelectorAll('#template-params-tbody tr');
    let labels = [];
    let data = [];
    let colors = [];
    
    const chartColors = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f43f5e', '#6366f1', '#facc15', '#a855f7'];
    let cIdx = 0;

    trs.forEach(tr => {
        const chk = tr.querySelector('.template-clause-chk');
        const activeInput = tr.querySelector('.template-std-hrs');

        if (chk && chk.checked && activeInput) {
            let hrs = parseFloat(activeInput.dataset.val) || parseFloat(activeInput.textContent) || 0;

            if (hrs > 0) {
                let labelText = chk.getAttribute('data-clause');
                labels.push(labelText);
                data.push(hrs);
                colors.push(chartColors[cIdx % chartColors.length]);
                cIdx++;
            }
        }
    });

    if (manHoursChartInstance) {
        manHoursChartInstance.destroy();
    }
    
    if (data.length === 0) {
        // Show empty grey ring if no data
        data = [1];
        labels = ['No Active Clauses'];
        colors = ['#e2e8f0'];
    }
    
    manHoursChartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                data: data,
                backgroundColor: colors,
                borderWidth: 2,
                borderColor: '#ffffff'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            if (context.label === 'No Active Clauses') return '0 hrs';
                            return context.label + ': ' + context.raw + ' hrs';
                        }
                    }
                }
            },
            cutout: '75%'
        }
    });
}

function updateTemplateCoverage() {
    const trs = document.querySelectorAll('#template-params-tbody tr');
    const total = trs.length;
    let selected = 0;
    
    const grid = document.getElementById('coverage-grid');
    if (!grid) return;
    
    grid.innerHTML = '';
    
    trs.forEach(tr => {
        const chk = tr.querySelector('.template-clause-chk');
        if (chk) {
            const isChecked = chk.checked;
            const clauseNum = chk.dataset.clause || '';
            
            if (isChecked) selected++;
            
            const block = document.createElement('div');
            block.title = 'Clause ' + clauseNum + (isChecked ? ' (Selected)' : ' (Unselected)');
            block.style.width = '28px';
            block.style.height = '28px';
            block.style.borderRadius = '6px';
            block.style.display = 'flex';
            block.style.alignItems = 'center';
            block.style.justifyContent = 'center';
            block.style.fontSize = '0.65rem';
            block.style.fontWeight = 'bold';
            block.style.cursor = 'help';
            block.style.transition = 'all 0.2s ease';
            
            if (isChecked) {
                block.style.background = '#10b981';
                block.style.color = 'white';
                block.style.boxShadow = '0 2px 4px rgba(16,185,129,0.3)';
            } else {
                block.style.background = '#f1f5f9';
                block.style.color = '#94a3b8';
                block.style.border = '1px solid #e2e8f0';
            }
            
            const shortClause = clauseNum.split('.').pop();
            block.textContent = shortClause;
            
            grid.appendChild(block);
        }
    });
    
    const percent = total > 0 ? Math.round((selected / total) * 100) : 0;
    
    const textEl = document.getElementById('coverage-text');
    const percentEl = document.getElementById('coverage-percent');
    const barEl = document.getElementById('coverage-bar');
    
    if (textEl) textEl.textContent = `${selected} of ${total} Selected`;
    if (percentEl) percentEl.textContent = `${percent}%`;
    if (barEl) barEl.style.width = `${percent}%`;
}

function updateTemplateTotal() {
    const trs = document.querySelectorAll('#template-params-tbody tr');
    let totalHrs = 0;
    trs.forEach(tr => {
        const chk = tr.querySelector('.template-clause-chk');
        const activeInput = tr.querySelector('.template-std-hrs');

        if (chk && chk.checked && activeInput) {
            totalHrs += parseFloat(activeInput.dataset.val) || parseFloat(activeInput.textContent) || 0;
        }
    });
    document.getElementById('template-total-hours').textContent = totalHrs.toFixed(1) + ' hrs';
    renderManHoursChart();
    if (typeof updateTemplateCoverage === 'function') updateTemplateCoverage();
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
        const activeInput = tr.querySelector('.template-std-hrs');
        const passiveInput = tr.querySelector('.template-passive-hrs-input');
        const equipInput = tr.querySelector('.template-equip-input');
        
        if (!chk) return;
        
        const clause = chk.dataset.clause;
        const isActive = chk.checked;
        const activeHrs = activeInput ? (parseFloat(activeInput.dataset.val) || parseFloat(activeInput.textContent) || 0) : 0;
        const passiveHrs = passiveInput ? (parseFloat(passiveInput.value) || 0) : 0;
        const equip = equipInput ? (equipInput.value || '') : '';

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
        const data = await res.json();
        if (res.ok) {
            showToast('Template saved successfully!', 'success');
            currentTemplates[isNumber] = templateData;
        } else {
            showToast('Failed to save template: ' + (data.error || 'Unknown database error'), 'error');
        }
    } catch(e) {
        showToast('Error saving template', 'error');
        console.error(e);
    }
}

async function seedDefaultTemplates() {
    if (!confirm("Are you sure you want to seed all default templates from the standards database? This will overwrite existing defaults.")) return;
    showToast("Seeding default templates...", "info");
    try {
        const res = await fetch('/api/admin/templates/seed', {
            method: 'POST'
        });
        const data = await res.json();
        if (res.ok) {
            showToast(data.message, 'success');
            // Reload templates list and view
            fetchTemplates();
        } else {
            showToast('Failed to seed templates: ' + (data.error || 'Unknown error'), 'error');
        }
    } catch(e) {
        showToast('Error seeding default templates', 'error');
        console.error(e);
    }
}

// ============================================================
// PDF Master-Template Importer (frontend)
// ============================================================
// _pdfImportParsed declared at top of file (line 2) to avoid TDZ on hot reload

function openPdfImportModal() {
    document.getElementById('pdf-import-modal').classList.add('active');
    document.getElementById('pdf-import-step-upload').style.display = 'flex';
    document.getElementById('pdf-import-step-preview').style.display = 'none';
    document.getElementById('pdf-import-filename').textContent = 'BIS testing-charges format (e.g. "Testing charges for IS 2791:1992")';
    document.getElementById('pdf-import-status').textContent = '';
    document.getElementById('pdf-import-commit-btn').disabled = true;
    document.getElementById('pdf-import-commit-btn').style.opacity = '0.5';
    document.getElementById('pdf-import-file').value = '';
    _pdfImportParsed = [];
}

function closePdfImportModal() {
    document.getElementById('pdf-import-modal').classList.remove('active');
}

async function handlePdfImportFileSelect(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
    document.getElementById('pdf-import-filename').textContent = `${file.name} (${sizeMB} MB) — parsing...`;
    document.getElementById('pdf-import-status').textContent = 'Uploading and parsing PDF (this may take a minute for large files)...';

    const formData = new FormData();
    formData.append('pdf', file);
    
    const engineSelect = document.getElementById('pdf-import-engine');
    if (engineSelect) {
        formData.append('engine', engineSelect.value);
    }
    
    try {
        const res = await fetch('/api/admin/templates/import-pdf/preview', { method: 'POST', body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Parse failed');
        if (data.warning) {
            document.getElementById('pdf-import-status').innerHTML = `<span style="color:#dc2626;">⚠️ ${data.warning}</span>`;
            return;
        }
        _pdfImportParsed = data.templates || [];
        renderPdfImportPreview(data);
    } catch (e) {
        document.getElementById('pdf-import-status').innerHTML = `<span style="color:#dc2626;">Error: ${e.message}</span>`;
    }
}

function renderPdfImportPreview(data) {
    document.getElementById('pdf-import-step-upload').style.display = 'none';
    document.getElementById('pdf-import-step-preview').style.display = 'flex';

    const s = data.summary || {};
    const chip = (label, value, color) => `<div style="background:${color}15; border:1px solid ${color}40; color:${color}; padding:8px 14px; border-radius:8px; font-weight:700; font-size:0.88rem;">${label}: ${value}</div>`;
    document.getElementById('pdf-import-summary').innerHTML =
        chip('Total detected', s.total || 0, '#0f172a') +
        chip('Clean (auto-import)', s.clean || 0, '#10b981') +
        chip('Medium confidence', s.medium || 0, '#f59e0b') +
        chip('Needs review', s.review || 0, '#dc2626');

    const tbody = document.getElementById('pdf-import-preview-tbody');
    tbody.innerHTML = _pdfImportParsed.map((t, idx) => {
        const conf = t.confidence === 'high' ? '<span style="color:#10b981; font-weight:700;">HIGH</span>'
            : t.confidence === 'medium' ? '<span style="color:#f59e0b; font-weight:700;">MEDIUM</span>'
            : '<span style="color:#dc2626; font-weight:700;">REVIEW</span>';
        const checked = t.confidence !== 'review' ? 'checked' : '';
        return `<tr>
            <td style="padding:8px 12px; border-bottom:1px solid #f1f5f9;"><input type="checkbox" class="pdf-import-row-chk" data-idx="${idx}" ${checked}></td>
            <td style="padding:8px 12px; border-bottom:1px solid #f1f5f9; font-weight:700;">${t.isNumber}${t.year ? ' : ' + t.year : ''}</td>
            <td style="padding:8px 12px; border-bottom:1px solid #f1f5f9; color:#475569;">${t.productName || '<em style="color:#94a3b8;">(not detected)</em>'}</td>
            <td style="padding:8px 12px; border-bottom:1px solid #f1f5f9; text-align:center;">${t.clauseCount}</td>
            <td style="padding:8px 12px; border-bottom:1px solid #f1f5f9; text-align:center; font-weight:700;">${t.totalHours}</td>
            <td style="padding:8px 12px; border-bottom:1px solid #f1f5f9; text-align:center;"><input type="number" min="1" value="${t.tatDays}" style="width:60px; padding:4px 6px; border:1px solid #cbd5e1; border-radius:4px; text-align:center;" data-idx="${idx}" onchange="_pdfImportParsed[${idx}].tatDays = parseInt(this.value)||7;"></td>
            <td style="padding:8px 12px; border-bottom:1px solid #f1f5f9; text-align:center;">${conf}</td>
        </tr>`;
    }).join('');

    const btn = document.getElementById('pdf-import-commit-btn');
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.textContent = `Import Selected (${_pdfImportParsed.length})`;
}

function togglePdfImportSelectAll() {
    const checked = document.getElementById('pdf-import-select-all').checked;
    document.querySelectorAll('.pdf-import-row-chk').forEach(cb => cb.checked = checked);
}

async function commitPdfImport() {
    const checkedIdx = [...document.querySelectorAll('.pdf-import-row-chk:checked')].map(cb => parseInt(cb.dataset.idx));
    const selected = checkedIdx.map(i => _pdfImportParsed[i]).filter(Boolean);
    if (selected.length === 0) { showToast('Select at least one template to import', 'warning'); return; }
    const overwrite = document.getElementById('pdf-import-overwrite').checked;

    const btn = document.getElementById('pdf-import-commit-btn');
    btn.disabled = true; btn.textContent = 'Importing...';

    try {
        const res = await fetch('/api/admin/templates/import-pdf/commit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ templates: selected, overwrite })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Import failed');
        showToast(data.message, 'success');
        closePdfImportModal();
        if (typeof fetchTemplates === 'function') fetchTemplates();
    } catch (e) {
        showToast('Import failed: ' + e.message, 'error');
        btn.disabled = false;
        btn.textContent = `Import Selected (${selected.length})`;
    }
}


function openPreviewModal() {
    const trs = document.querySelectorAll('#template-params-tbody tr');
    const previewTbody = document.getElementById('preview-tbody');
    previewTbody.innerHTML = '';
    
    let totalHrs = 0;
    
    trs.forEach(tr => {
        const chk = tr.querySelector('.template-clause-chk');
        if (chk && chk.checked) {
            const clause = chk.dataset.clause;
            const param = tr.querySelector('td:nth-child(2)').textContent.trim();
            const equip = tr.querySelector('.template-equip-input').value;
            const activeInput = tr.querySelector('.template-std-hrs');
            const activeHrs = activeInput ? (parseFloat(activeInput.dataset.val) || parseFloat(activeInput.textContent) || 0) : 0;
            const passiveHrs = parseFloat(tr.querySelector('.template-passive-hrs-input').value) || 0;
            
            totalHrs += activeHrs;
            
            const newTr = document.createElement('tr');
            newTr.style.borderBottom = '1px solid #f1f5f9';
            newTr.innerHTML = `
                <td style="padding: 14px 20px; color: #0f172a; font-weight: 700; font-size: 0.95rem;">${clause}</td>
                <td style="padding: 14px 20px; color: #475569; font-size: 0.95rem;">${param}</td>
                <td style="padding: 14px 20px; color: #64748b; font-size: 0.9rem; text-align: center;">${equip || '-'}</td>
                <td style="padding: 14px 20px; color: #64748b; font-size: 0.95rem; text-align: center;">${passiveHrs}</td>
            `;
            previewTbody.appendChild(newTr);
        }
    });
    
    if (previewTbody.innerHTML === '') {
        previewTbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 40px; color: #94a3b8; font-weight: 500;">No parameters selected.</td></tr>';
    }
    
    document.getElementById('preview-total-hours').textContent = totalHrs.toFixed(1) + ' hrs';
    document.getElementById('preview-modal').style.display = 'flex';
}


// Apply any locally-saved edits over the built-in specs_db (persists user corrections).
function loadIS4985LimitsOverride() {
    try {
        if (typeof IS_4985_SPECS === 'undefined' || !IS_4985_SPECS.sizes_db) return;
        const ov = localStorage.getItem('is4985_limits_override');
        if (ov) {
            const parsed = JSON.parse(ov);
            if (parsed && typeof parsed === 'object') IS_4985_SPECS.sizes_db = parsed;
        }
    } catch (e) { console.warn('limits override load failed', e.message); }
}

function limCell(dn, field, value, width) {
    const v = (value === null || value === undefined) ? '' : value;
    return `<td style="border:1px solid #e2e8f0; padding:3px;"><input class="lim-cell" data-dn="${dn}" data-field="${field}" value="${limsEsc(v)}" style="width:${width || 56}px; padding:5px; text-align:center; background:#ffffff; border:1px solid #cbd5e1; border-radius:4px; color:#1a1a2e; font-size:0.8rem;"></td>`;
}

function openIS4985LimitsModal() {
    const modal = document.getElementById('is-limits-modal');
    const tbody = document.getElementById('is-limits-tbody');

    if (modal && tbody && typeof IS_4985_SPECS !== 'undefined' && IS_4985_SPECS.sizes_db) {
        loadIS4985LimitsOverride();
        tbody.innerHTML = '';
        const sizes = Object.keys(IS_4985_SPECS.sizes_db).sort((a, b) => parseFloat(a) - parseFloat(b));

        sizes.forEach(size => {
            const data = IS_4985_SPECS.sizes_db[size];
            const tr = document.createElement('tr');

            let thicknessHtml = '';
            for (let c = 1; c <= 6; c++) {
                const t = (data.thickness && data.thickness[c]) ? data.thickness[c].join(', ') : '';
                thicknessHtml += limCell(size, `t${c}`, t, 86);
            }

            tr.innerHTML =
                `<td style="border:1px solid var(--glass-border); padding:8px; font-weight:bold; color:var(--accent);">${size}</td>`
                + limCell(size, 'min_od', data.min_od)
                + limCell(size, 'max_od', data.max_od)
                + limCell(size, 'min_od_any', data.min_od_any)
                + limCell(size, 'max_od_any', data.max_od_any)
                + limCell(size, 'ovality', data.ovality)
                + limCell(size, 'socket', data.socket)
                + thicknessHtml;
            tbody.appendChild(tr);
        });

        modal.classList.add('active');
    } else {
        showToast('IS 4985 Specs Database not found.', 'error');
    }
}

// Read the editable grid back into specs_db and persist to localStorage.
function saveIS4985Limits() {
    if (typeof IS_4985_SPECS === 'undefined' || !IS_4985_SPECS.sizes_db) return;
    document.querySelectorAll('#is-limits-tbody .lim-cell').forEach(inp => {
        const dn = inp.getAttribute('data-dn');
        const field = inp.getAttribute('data-field');
        const data = IS_4985_SPECS.sizes_db[dn];
        if (!data) return;
        const raw = inp.value.trim();
        if (field[0] === 't') {
            const cls = field.slice(1);
            if (raw === '') { if (data.thickness) delete data.thickness[cls]; return; }
            const parts = raw.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
            if (parts.length === 3) { data.thickness = data.thickness || {}; data.thickness[cls] = parts; }
        } else if (field === 'socket') {
            const n = parseFloat(raw);
            if (!isNaN(n)) data.socket = n;
        } else {
            const n = parseFloat(raw);
            if (!isNaN(n)) data[field] = n;
        }
    });
    try { localStorage.setItem('is4985_limits_override', JSON.stringify(IS_4985_SPECS.sizes_db)); } catch (e) {}
    showToast('IS 4985 limits saved — the report now uses these values.', 'success');
    try { renderTestParametersTable(); } catch (e) {}
}

function closeIS4985LimitsModal() {
    const modal = document.getElementById('is-limits-modal');
    if (modal) modal.classList.remove('active');
}

function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.add('active');
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove('active');
}

function handleISFileSelect(event) {
    const fileInput = event.target;
    const filenameLabel = document.getElementById('is-upload-filename');
    const analyzeBtn = document.getElementById('is-analyze-btn');

    if (fileInput.files && fileInput.files.length > 0) {
        const fileName = fileInput.files[0].name;
        if (filenameLabel) {
            filenameLabel.innerHTML = `<strong>Selected:</strong> ${fileName}`;
            filenameLabel.style.color = 'var(--primary)';
        }
        if (analyzeBtn) {
            analyzeBtn.style.display = 'block';
        }
    } else {
        if (filenameLabel) {
            filenameLabel.textContent = 'Auto-parses clauses & tables';
            filenameLabel.style.color = '';
        }
        if (analyzeBtn) analyzeBtn.style.display = 'none';
    }
}



function handleNsrVerify(code) {
    showToast(`Verification process for ${code} initiated.`, 'success');
}

function handleNsrAction(code) {
    showToast(`Action menu for ${code} opened (Coming Soon).`, 'info');
}

function exportNsrData() {
    showToast('Exporting table data to Excel...', 'success');
}

// SRL: switchNsrSubTab is retained as a no-op stub for backward compatibility.
// The two sub-sections (Newly Received Queue SRL & Allotted/Pending Queue SRL)
// are now always visible together in a single merged scrollable view.
function switchNsrSubTab(subTabId) {
    // No-op: sub-tabs have been merged. Both sections display simultaneously.
    console.debug('[SRL] switchNsrSubTab called with:', subTabId, '— sections are now always visible (merged view).');
}

// ============================================================
// AI COPILOT LOGIC
// ============================================================

var copilotHistory = [];

function toggleCopilot() {
    const panel = document.getElementById('ai-copilot-panel');
    const badge = document.getElementById('ai-copilot-badge');
    const input = document.getElementById('ai-copilot-input');
    
    if (panel.classList.contains('copilot-panel-hidden')) {
        // Open
        panel.classList.remove('copilot-panel-hidden');
        badge.style.display = 'none';
        
        // Replay saved conversation, or greet fresh
        const messagesDiv = document.getElementById('ai-copilot-messages');
        if (messagesDiv.children.length === 0) {
            if (Array.isArray(copilotHistory) && copilotHistory.length > 0) {
                copilotHistory.forEach(t => addCopilotMessage(t.content, t.role === 'user' ? 'user' : 'assistant'));
            } else {
                const uname = (typeof currentUser === 'object' && currentUser && currentUser.username) ? currentUser.username : '';
                const greet = uname
                    ? `Hi ${uname.split(/[\s.@]/)[0]} — Nigrani here. What are we looking at today?`
                    : `Hi — I'm Nigrani, your lab co-pilot. What are we looking at?`;
                addCopilotMessage(greet, 'assistant');
            }
        }
        
        // Focus input
        setTimeout(() => input.focus(), 100);
    } else {
        // Close
        panel.classList.add('copilot-panel-hidden');
    }
}

function autoResizeCopilotInput(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
}

function handleCopilotKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendCopilotMessage();
    }
}

function sendCopilotChip(text) {
    document.getElementById('ai-copilot-input').value = text;
    sendCopilotMessage();
}

async function sendCopilotMessage() {
    const inputEl = document.getElementById('ai-copilot-input');
    if (!inputEl) { console.error('[Copilot] ai-copilot-input not found!'); return; }
    const text = inputEl.value.trim();
    if (!text) return;
    
    // Disable send button while processing
    const sendBtn = document.getElementById('ai-copilot-send-btn');
    if (sendBtn) {
        sendBtn.disabled = true;
        sendBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="animation:copilot-spin 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';
    }
    
    // Clear input
    inputEl.value = '';
    inputEl.style.height = 'auto';
    
    // Add user message
    addCopilotMessage(text, 'user');
    if (!Array.isArray(copilotHistory)) copilotHistory = [];
    copilotHistory.push({ role: 'user', content: text });
    saveNigraniMemory();

    try {
        // Show typing
        showCopilotTyping();

        const res = await fetch('/api/copilot/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: text,
                history: copilotHistory.slice(-8, -1), // last few turns for short-term context
                memorySummary: buildNigraniMemorySummary(), // long-term rolling memory
                userName: (typeof currentUser === 'object' && currentUser) ? (currentUser.username || '') : ''
            })
        });
        
        let data;
        try {
            data = await res.json();
        } catch(parseErr) {
            throw new Error('Server returned an invalid response. Please try again.');
        }
        
        removeCopilotTyping();
        
        if (res.ok && data.reply) {
            addCopilotMessage(data.reply, 'assistant', data.actionData);
            copilotHistory.push({ role: 'assistant', content: data.reply });
            saveNigraniMemory();
        } else {
            addCopilotMessage('⚠️ ' + (data.error || 'The AI could not generate a response. Please try again.'), 'assistant');
        }
    } catch (err) {
        console.error('[Copilot] Error:', err);
        removeCopilotTyping();
        addCopilotMessage('❌ Error: ' + (err.message || 'Network error. Please check your connection.'), 'assistant');
    } finally {
        // Re-enable send button
        if (sendBtn) {
            sendBtn.disabled = false;
            sendBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
        }
    }
}

// ─── Nigrani memory layer ───────────────────────────────────────
// Persists conversation across page reloads + builds a rolling summary
// of older turns so Nigrani keeps context without paying for huge prompts.

function saveNigraniMemory() {
    try {
        const trimmed = (copilotHistory || []).slice(-Nigrani_MAX_TURNS);
        localStorage.setItem(Nigrani_MEMORY_KEY, JSON.stringify(trimmed));
    } catch (e) {}
}

function loadNigraniMemory() {
    try {
        const raw = localStorage.getItem(Nigrani_MEMORY_KEY);
        if (!raw) return;
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) copilotHistory = arr;
    } catch (e) {}
}

function buildNigraniMemorySummary() {
    // Take older turns and condense them into a single short paragraph.
    // Goal: enough for Nigrani to remember threads ("you mentioned Ashish earlier")
    // without bloating the prompt.
    const arr = copilotHistory || [];
    if (arr.length <= Nigrani_SUMMARY_AFTER) return '';
    const older = arr.slice(0, arr.length - Nigrani_SUMMARY_AFTER);
    const lines = older.map(t => {
        const who = t.role === 'user' ? 'User' : 'Nigrani';
        const content = (t.content || '').replace(/\s+/g, ' ').slice(0, 200);
        return `${who}: ${content}`;
    });
    // Cap total summary length
    let s = lines.join(' | ');
    if (s.length > 800) s = s.slice(0, 780) + '…';
    return s;
}

function clearNigraniMemory() {
    copilotHistory = [];
    try { localStorage.removeItem(Nigrani_MEMORY_KEY); } catch(e) {}
    const messagesDiv = document.getElementById('ai-copilot-messages');
    if (messagesDiv) messagesDiv.innerHTML = '';
    addCopilotMessage("Memory cleared. Fresh start — what would you like to look at?", 'assistant');
}

// Restore memory on script load
try { loadNigraniMemory(); } catch (e) {}

function addCopilotMessage(text, role, actionData = null) {
    const messagesDiv = document.getElementById('ai-copilot-messages');
    if (!messagesDiv) { console.error('[Copilot] ai-copilot-messages not found!'); return; }
    
    const wrapper = document.createElement('div');
    wrapper.className = `copilot-msg ${role}`;
    
    // Safely convert text (handle null/undefined)
    const safeText = (text || '(empty response)').toString();
    // Convert basic markdown-like bold to HTML
    const formattedText = safeText.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
    
    let html = `<div class="copilot-bubble">${formattedText}</div>`;
    
    // Inject action card if available
    if (actionData && actionData.type === 'rebalance_proposal') {
        let rowsHtml = '';
        actionData.moves.forEach(m => {
            rowsHtml += `
                <div class="copilot-move-row">
                    <span style="font-weight:600;">${m.sampleId}</span>: 
                    <span style="color:#ef4444;text-decoration:line-through;">${m.from}</span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin:0 4px;"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                    <span style="color:#10b981;font-weight:600;">${m.to}</span>
                </div>
            `;
        });
        
        html += `
            <div class="copilot-action-card">
                <h4>Proposed Reassignments</h4>
                <div style="margin-bottom:10px;">${rowsHtml}</div>
                <button class="copilot-approve-btn" onclick="approveCopilotAction('${actionData.actionId}', this)">
                    Approve Recommendations
                </button>
            </div>
        `;
    }
    
    wrapper.innerHTML = html;
    messagesDiv.appendChild(wrapper);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function showCopilotTyping() {
    const messagesDiv = document.getElementById('ai-copilot-messages');
    if (!messagesDiv) { console.error('[Copilot] ai-copilot-messages not found in showCopilotTyping!'); return; }
    const typing = document.createElement('div');
    typing.id = 'copilot-typing-indicator';
    typing.className = 'copilot-msg assistant';
    typing.innerHTML = `
        <div class="copilot-typing">
            <span></span><span></span><span></span>
        </div>
    `;
    messagesDiv.appendChild(typing);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function removeCopilotTyping() {
    const typing = document.getElementById('copilot-typing-indicator');
    if (typing) typing.remove();
}

async function approveCopilotAction(actionId, btnEl) {
    btnEl.disabled = true;
    btnEl.innerHTML = 'Approving...';
    
    try {
        const res = await fetch('/api/copilot/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ actionId })
        });
        const data = await res.json();
        
        if (res.ok) {
            btnEl.innerHTML = '✅ Approved & Applied';
            btnEl.style.background = '#e2e8f0';
            btnEl.style.color = '#475569';
            btnEl.style.boxShadow = 'none';
            showToast('Workloads updated successfully!', 'success');
            fetchSamples(); // reload dashboard
        } else {
            btnEl.disabled = false;
            btnEl.innerHTML = 'Approve Recommendations';
            showToast(data.error || 'Failed to approve', 'error');
        }
    } catch(e) {
        btnEl.disabled = false;
        btnEl.innerHTML = 'Approve Recommendations';
        showToast('Network error.', 'error');
    }
}

// --- CAPITAL EQUIPMENT HANDLERS ---

async function fetchAndRenderEquipments() {
    const search = document.getElementById('eq-search-input').value;
    const status = document.getElementById('eq-status-filter').value;
    const location = document.getElementById('eq-location-filter').value;

    const queryParams = new URLSearchParams();
    if (search) queryParams.append('search', search);
    if (status && status !== 'ALL') queryParams.append('status', status);
    if (location && location !== 'ALL') queryParams.append('location', location);

    const tbody = document.getElementById('equipment-tbody');
    try {
        const res = await fetch(`/api/equipments?${queryParams.toString()}`);
        const data = await res.json();
        
        if (res.ok) {
            renderEquipmentTable(data.equipments || []);
            // Update location dropdown
            updateLocationFilterDropdown(data.equipments || []);
        } else {
            tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--danger); padding: 30px;">Error: ${data.error}</td></tr>`;
        }
    } catch (err) {
        console.error("Error loading equipment:", err);
        tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--danger); padding: 30px;">Error: ${err.message}</td></tr>`;
    }
}

function renderEquipmentTable(equipments) {
    const tbody = document.getElementById('equipment-tbody');
    tbody.innerHTML = '';

    if (equipments.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 40px; color: #64748b; font-size: 0.95rem;">No matching equipment found.</td></tr>`;
        return;
    }

    equipments.forEach(eq => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid #e2e8f0';

        // Cost formatting
        let costVal = '—';
        if (eq.cost) {
            const num = parseFloat(eq.cost);
            if (!isNaN(num)) {
                costVal = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(num);
            } else {
                costVal = eq.cost;
            }
        }

        // Status badge styling
        let badgeStyle = 'background: #e2e8f0; color: #475569;'; // default Grey
        const status = (eq.status || '').toLowerCase().trim();
        if (status.includes('not working') || status.includes('notworking')) {
            badgeStyle = 'background: #fecdd3; color: #9f1239; border: 1px solid #fda4af;'; // Red
        } else if (status.includes('repair') || status.includes('partially')) {
            badgeStyle = 'background: #fef3c7; color: #92400e; border: 1px solid #fde68a;'; // Orange/Amber
        } else if (status.includes('working')) {
            badgeStyle = 'background: #d1fae5; color: #065f46; border: 1px solid #a7f3d0;'; // Green
        } else if (status.includes('condemned')) {
            badgeStyle = 'background: #e2e8f0; color: #475569; border: 1px solid #cbd5e1;'; // Grey
        }

        const statusHtml = `<span style="display: inline-block; padding: 4px 10px; border-radius: 20px; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; ${badgeStyle}">${eq.status || 'Working'}</span>`;

        // URL link button
        let urlBtnHtml = '';
        if (eq.url) {
            urlBtnHtml = `<a class="btn btn-primary btn-sm" href="${eq.url}" target="_blank" style="padding: 4px 8px; font-size: 0.75rem; border-radius: 4px; display: inline-flex; align-items: center; gap: 4px; background: #3b82f6; color: white; text-decoration: none;"><i class="fas fa-file-alt"></i> View Doc</a>`;
        } else {
            urlBtnHtml = `<span style="font-size: 0.8rem; color: #94a3b8;">No link</span>`;
        }

        // Actions: Edit status, Delete (admin/superadmin)
        const isUserAdmin = currentUser && (currentUser.role === 'admin' || currentUser.role === 'super_admin' || currentUser.role === 'admin_sample_cell');
        let deleteBtnHtml = '';
        if (isUserAdmin) {
            deleteBtnHtml = `<button onclick="deleteEquipment(${eq.id}, '${eq.name.replace(/'/g, "\\'")}')" class="btn btn-sm" style="background: #ef4444; color: white; padding: 4px 8px; font-size: 0.75rem; border-radius: 4px; border: none; cursor: pointer; margin-left: 5px;"><i class="fas fa-trash"></i></button>`;
        }

        tr.innerHTML = `
            <td style="padding: 12px 16px; font-weight: 700; color: #1e293b; font-size: 0.85rem;">${eq.labCode || '—'}</td>
            <td style="padding: 12px 16px; font-weight: 600; color: #0f172a; font-size: 0.85rem; max-width: 250px; white-space: normal; word-break: break-word;">${eq.name}</td>
            <td style="padding: 12px 16px; color: #475569; font-size: 0.85rem;">${eq.make || '—'}</td>
            <td style="padding: 12px 16px; font-weight: 600; color: #0f172a; font-size: 0.85rem;">${costVal}</td>
            <td style="padding: 12px 16px; font-weight: 600; color: #475569; font-size: 0.85rem;">${eq.location || '—'}</td>
            <td style="padding: 12px 16px; color: #64748b; font-size: 0.85rem;">${eq.dtRec || '—'}</td>
            <td style="padding: 12px 16px;">${statusHtml}</td>
            <td style="padding: 12px 16px; text-align: center; white-space: nowrap;">
                <button onclick="openEditEquipmentModal(${eq.id}, '${eq.name.replace(/'/g, "\\'")}', '${eq.labCode || ''}', '${eq.status}', '${eq.location || ''}', '${eq.registerDetails || ''}')" class="btn btn-sm" style="background: #f1f5f9; color: #475569; padding: 4px 8px; font-size: 0.75rem; border-radius: 4px; border: 1px solid #cbd5e1; cursor: pointer;"><i class="fas fa-edit"></i> Edit</button>
                ${urlBtnHtml}
                ${deleteBtnHtml}
            </td>
        `;
        tbody.appendChild(tr);
    });
}

function updateLocationFilterDropdown(equipments) {
    const dropdown = document.getElementById('eq-location-filter');
    if (!dropdown) return;
    const prevVal = dropdown.value;
    
    // Scan all locations
    const locations = new Set();
    equipments.forEach(eq => {
        if (eq.location) {
            locations.add(eq.location.trim());
        }
    });

    // Check if we have new locations to update
    let needsUpdate = false;
    locations.forEach(loc => {
        if (!allLocationsList.has(loc)) {
            allLocationsList.add(loc);
            needsUpdate = true;
        }
    });

    if (needsUpdate || dropdown.options.length <= 1) {
        dropdown.innerHTML = '<option value="ALL">All Locations</option>';
        const sortedLocs = Array.from(allLocationsList).sort();
        sortedLocs.forEach(loc => {
            const opt = document.createElement('option');
            opt.value = loc;
            opt.textContent = loc;
            dropdown.appendChild(opt);
        });
        dropdown.value = prevVal;
    }
}

async function fetchEquipmentStats() {
    try {
        const res = await fetch('/api/equipments/stats');
        const data = await res.json();
        
        if (res.ok) {
            document.getElementById('eq-kpi-total').textContent = data.total;
            document.getElementById('eq-kpi-working').textContent = data.working;
            document.getElementById('eq-kpi-repair').textContent = data.underRepair;
            document.getElementById('eq-kpi-not-working').textContent = data.notWorking;

            const costVal = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(data.totalCost || 0);
            document.getElementById('eq-kpi-cost').textContent = costVal;
        }
    } catch(err) {
        console.error('Failed to load equipment stats:', err);
    }
}

function resetEquipmentFilters() {
    document.getElementById('eq-search-input').value = '';
    document.getElementById('eq-status-filter').value = 'ALL';
    document.getElementById('eq-location-filter').value = 'ALL';
    fetchAndRenderEquipments();
}

// ── OCR Test ──────────────────────────────────────────────────────────────
let ocrSelectedFile = null;

function openOcrTestModal() {
    resetOcrTest();
    openModal('ocr-test-modal');
}

function resetOcrTest() {
    ocrSelectedFile = null;
    const dropZone = document.getElementById('ocr-drop-zone');
    const preview = document.getElementById('ocr-preview-area');
    const processing = document.getElementById('ocr-processing');
    const results = document.getElementById('ocr-results');
    const errorEl = document.getElementById('ocr-error');
    const runBtn = document.getElementById('ocr-run-btn');
    const fileInput = document.getElementById('ocr-file-input');
    if (dropZone) dropZone.style.display = '';
    if (preview) preview.style.display = 'none';
    if (processing) processing.style.display = 'none';
    if (results) results.style.display = 'none';
    if (errorEl) errorEl.style.display = 'none';
    if (runBtn) runBtn.style.display = 'none';
    if (fileInput) fileInput.value = '';
}

function handleOcrDrop(e) {
    const files = e.dataTransfer.files;
    if (files.length) ocrSetFile(files[0]);
}

function handleOcrFileSelect(e) {
    if (e.target.files.length) ocrSetFile(e.target.files[0]);
}

function ocrSetFile(file) {
    ocrSelectedFile = file;
    document.getElementById('ocr-file-name').textContent = file.name;
    document.getElementById('ocr-file-size').textContent = (file.size / 1024).toFixed(1) + ' KB';
    document.getElementById('ocr-preview-area').style.display = '';
    document.getElementById('ocr-run-btn').style.display = '';
    document.getElementById('ocr-results').style.display = 'none';
    document.getElementById('ocr-error').style.display = 'none';
}

async function runOcrTest() {
    if (!ocrSelectedFile) return showToast('Please select a file first.', 'warning');

    document.getElementById('ocr-drop-zone').style.display = 'none';
    document.getElementById('ocr-run-btn').style.display = 'none';
    document.getElementById('ocr-processing').style.display = '';
    document.getElementById('ocr-results').style.display = 'none';
    document.getElementById('ocr-error').style.display = 'none';

    const formData = new FormData();
    formData.append('file', ocrSelectedFile);

    try {
        const res = await fetch('/api/ocr/test', { method: 'POST', body: formData });
        const data = await res.json();
        document.getElementById('ocr-processing').style.display = 'none';

        if (res.ok && data.success) {
            document.getElementById('ocr-output-text').value = data.text;
            document.getElementById('ocr-method-badge').textContent = data.method === 'paddleocr' ? 'PaddleOCR (Local)' : data.method === 'pdfplumber' ? 'pdfplumber' : data.method;
            document.getElementById('ocr-line-count').textContent = data.lines + ' lines extracted';
            document.getElementById('ocr-results').style.display = '';
            document.getElementById('ocr-run-btn').style.display = '';
        } else {
            document.getElementById('ocr-error').style.display = '';
            document.getElementById('ocr-error').textContent = data.error || 'OCR extraction failed.';
            document.getElementById('ocr-run-btn').style.display = '';
            document.getElementById('ocr-drop-zone').style.display = '';
        }
    } catch (err) {
        document.getElementById('ocr-processing').style.display = 'none';
        document.getElementById('ocr-error').style.display = '';
        document.getElementById('ocr-error').textContent = 'Network error: ' + err.message;
        document.getElementById('ocr-run-btn').style.display = '';
        document.getElementById('ocr-drop-zone').style.display = '';
    }
}

// ── Document Parser (calibration certs + IS standards) ──
let docParseFile = null;
let docParseType = 'auto';
let docParseResult = null;

function openDocParseModal() {
    resetDocParse();
    openModal('doc-parse-modal');
}

function resetDocParse() {
    docParseFile = null;
    docParseResult = null;
    docParseType = 'auto';
    const el = (id) => document.getElementById(id);
    el('doc-parse-dropzone').style.display = '';
    el('doc-parse-file-info').style.display = 'none';
    el('doc-parse-processing').style.display = 'none';
    el('doc-parse-calib-result').style.display = 'none';
    el('doc-parse-is-result').style.display = 'none';
    el('doc-parse-error').style.display = 'none';
    el('doc-parse-confidence').style.display = 'none';
    el('doc-parse-run-btn').style.display = 'none';
    el('doc-parse-confirm-btn').style.display = 'none';
    document.querySelectorAll('.doc-type-btn').forEach(b => {
        b.style.background = 'transparent';
        b.style.color = '';
        b.style.borderColor = '#cbd5e1';
    });
    const autoBtn = el('doc-type-auto');
    if (autoBtn) { autoBtn.style.background = '#8b5cf6'; autoBtn.style.color = 'white'; autoBtn.style.borderColor = '#8b5cf6'; }
}

function setDocType(type) {
    docParseType = type;
    document.querySelectorAll('.doc-type-btn').forEach(b => {
        b.style.background = 'transparent';
        b.style.color = '';
        b.style.borderColor = '#cbd5e1';
    });
    const btn = document.getElementById('doc-type-' + (type === 'calibration_certificate' ? 'calib' : type === 'is_standard' ? 'is' : 'auto'));
    if (btn) { btn.style.background = '#8b5cf6'; btn.style.color = 'white'; btn.style.borderColor = '#8b5cf6'; }
}

function handleDocParseDrop(e) {
    e.preventDefault();
    e.currentTarget.style.borderColor = '#cbd5e1';
    const file = e.dataTransfer.files[0];
    if (file) docParseSetFile(file);
}

function handleDocParseFileSelect(e) {
    const file = e.target.files[0];
    if (file) docParseSetFile(file);
}

function docParseSetFile(file) {
    docParseFile = file;
    document.getElementById('doc-parse-file-name').textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
    document.getElementById('doc-parse-file-info').style.display = '';
    document.getElementById('doc-parse-run-btn').style.display = '';
}

async function runDocParse() {
    if (!docParseFile) return showToast('Please select a file first.', 'warning');

    const el = (id) => document.getElementById(id);
    el('doc-parse-dropzone').style.display = 'none';
    el('doc-parse-run-btn').style.display = 'none';
    el('doc-parse-error').style.display = 'none';
    el('doc-parse-calib-result').style.display = 'none';
    el('doc-parse-is-result').style.display = 'none';
    el('doc-parse-confidence').style.display = 'none';
    el('doc-parse-processing').style.display = '';
    el('doc-parse-status').textContent = 'Extracting text with local OCR...';

    const formData = new FormData();
    formData.append('file', docParseFile);
    if (docParseType !== 'auto') formData.append('doc_type', docParseType);

    try {
        const res = await fetch('/api/document/parse-structured', { method: 'POST', body: formData });
        const data = await res.json();
        el('doc-parse-processing').style.display = 'none';

        if (!data.success) {
            el('doc-parse-error').style.display = '';
            el('doc-parse-error').textContent = data.error || 'Parsing failed.';
            el('doc-parse-run-btn').style.display = '';
            el('doc-parse-dropzone').style.display = '';
            return;
        }

        docParseResult = data;

        if (data.doc_type === 'calibration_certificate') {
            renderCalibResult(data);
        } else if (data.doc_type === 'is_standard') {
            renderISResult(data);
        } else {
            el('doc-parse-error').style.display = '';
            el('doc-parse-error').textContent = 'Could not identify document type. Please select Calibration Certificate or IS Standard manually and try again.';
            el('doc-parse-run-btn').style.display = '';
            el('doc-parse-dropzone').style.display = '';
            return;
        }

        // Show confidence warnings
        const lowConf = Object.entries(data.confidence || {}).filter(([k, v]) => v > 0 && v < 0.8);
        if (lowConf.length > 0 || data.llm_enhanced) {
            el('doc-parse-confidence').style.display = '';
            let msg = '';
            if (data.llm_enhanced) msg += 'Some fields were filled by LM Studio (local LLM). ';
            if (lowConf.length > 0) msg += `${lowConf.length} field(s) have lower confidence — please verify.`;
            el('doc-parse-confidence-text').textContent = msg;
        }

        el('doc-parse-confirm-btn').style.display = '';

    } catch (err) {
        el('doc-parse-processing').style.display = 'none';
        el('doc-parse-error').style.display = '';
        el('doc-parse-error').textContent = 'Network error: ' + err.message;
        el('doc-parse-run-btn').style.display = '';
        el('doc-parse-dropzone').style.display = '';
    }
}

function renderCalibResult(data) {
    const fields = data.parsed || {};
    const conf = data.confidence || {};
    const container = document.getElementById('doc-parse-calib-fields');
    container.innerHTML = '';

    const fieldLabels = {
        certificate_number: 'Certificate Number',
        date_of_calibration: 'Date of Calibration',
        date_next_due: 'Next Due Date',
        equipment_name: 'Equipment Name',
        equipment_id: 'Equipment ID / Lab Code',
        make: 'Make',
        model: 'Model',
        range: 'Range',
        least_count: 'Least Count',
        calibration_agency: 'Calibration Agency',
        nabl_certificate: 'NABL Certificate No.',
        reference_standard: 'Reference Standard',
        temperature: 'Temperature',
        humidity: 'Humidity',
    };

    for (const [key, label] of Object.entries(fieldLabels)) {
        const val = fields[key] || '';
        const c = conf[key] || 0;
        const borderColor = c >= 0.8 ? '#bbf7d0' : c > 0 ? '#fde68a' : '#fecaca';
        const icon = c >= 0.8 ? '✓' : c > 0 ? '~' : '?';

        container.innerHTML += `
            <div style="position: relative;">
                <label style="font-size: 0.72rem; color: var(--text-muted); display: block;">${label} <span style="color: ${c >= 0.8 ? '#16a34a' : c > 0 ? '#d97706' : '#dc2626'}">${icon}</span></label>
                <input data-calib-field="${key}" value="${val.replace(/"/g, '&quot;')}" style="width: 100%; padding: 6px 10px; border: 1px solid ${borderColor}; border-radius: 4px; font-size: 0.85rem; background: ${c === 0 ? '#fef2f2' : 'white'};">
            </div>`;
    }

    document.getElementById('doc-parse-calib-result').style.display = '';
}

function renderISResult(data) {
    const parsed = data.parsed || {};
    document.getElementById('doc-is-number').value = parsed.is_number || '';
    document.getElementById('doc-is-title').value = parsed.title || '';

    const params = parsed.test_parameters || [];
    document.getElementById('doc-is-param-count').textContent = `(${params.length} parameters)`;
    const tbody = document.getElementById('doc-is-params-tbody');
    tbody.innerHTML = '';

    params.forEach((p, i) => {
        tbody.innerHTML += `<tr style="border-bottom: 1px solid #f1f5f9;">
            <td style="padding: 5px 8px;"><input data-is-param="${i}" data-field="clause" value="${(p.clause || '').replace(/"/g, '&quot;')}" style="width: 60px; padding: 3px 5px; border: 1px solid #e2e8f0; border-radius: 3px; font-size: 0.8rem;"></td>
            <td style="padding: 5px 8px;"><input data-is-param="${i}" data-field="param" value="${(p.param || '').replace(/"/g, '&quot;')}" style="width: 100%; padding: 3px 5px; border: 1px solid #e2e8f0; border-radius: 3px; font-size: 0.8rem;"></td>
            <td style="padding: 5px 8px;"><input data-is-param="${i}" data-field="spec_val" value="${(p.spec_val || '').replace(/"/g, '&quot;')}" style="width: 100%; padding: 3px 5px; border: 1px solid #e2e8f0; border-radius: 3px; font-size: 0.8rem;"></td>
            <td style="padding: 5px 8px;">
                <select data-is-param="${i}" data-field="type" style="padding: 3px 5px; border: 1px solid #e2e8f0; border-radius: 3px; font-size: 0.8rem;">
                    <option ${p.type === 'Quantitative' ? 'selected' : ''}>Quantitative</option>
                    <option ${p.type === 'Qualitative' ? 'selected' : ''}>Qualitative</option>
                </select>
            </td>
            <td style="padding: 5px 8px;"><input data-is-param="${i}" data-field="min" value="${(p.min || '').replace(/"/g, '&quot;')}" style="width: 60px; padding: 3px 5px; border: 1px solid #e2e8f0; border-radius: 3px; font-size: 0.8rem;"></td>
            <td style="padding: 5px 8px;"><input data-is-param="${i}" data-field="max" value="${(p.max || '').replace(/"/g, '&quot;')}" style="width: 60px; padding: 3px 5px; border: 1px solid #e2e8f0; border-radius: 3px; font-size: 0.8rem;"></td>
        </tr>`;
    });

    document.getElementById('doc-parse-is-result').style.display = '';
}

async function confirmDocParse() {
    if (!docParseResult) return;

    const el = (id) => document.getElementById(id);

    if (docParseResult.doc_type === 'calibration_certificate') {
        const parsed = {};
        document.querySelectorAll('[data-calib-field]').forEach(input => {
            parsed[input.dataset.calibField] = input.value.trim();
        });

        try {
            const res = await fetch('/api/calibration/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ parsed })
            });
            const data = await res.json();
            if (data.success) {
                showToast('Calibration record saved successfully!', 'success');
                closeModal('doc-parse-modal');
                resetDocParse();
            } else {
                showToast(data.error || 'Save failed', 'error');
            }
        } catch (err) {
            showToast('Network error: ' + err.message, 'error');
        }

    } else if (docParseResult.doc_type === 'is_standard') {
        const isNumber = el('doc-is-number').value.trim();
        const title = el('doc-is-title').value.trim();
        const params = [];

        document.querySelectorAll('#doc-is-params-tbody tr').forEach((tr, i) => {
            const param = {};
            tr.querySelectorAll('[data-is-param]').forEach(input => {
                param[input.dataset.field] = input.tagName === 'SELECT' ? input.value : input.value.trim();
            });
            if (param.clause || param.param) params.push(param);
        });

        try {
            const res = await fetch('/api/is-standard/save-params', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    is_number: isNumber,
                    title: title,
                    test_parameters: params,
                    pdf_file_name: docParseFile ? docParseFile.name : ''
                })
            });
            const data = await res.json();
            if (data.success) {
                showToast('IS Standard parameters saved successfully!', 'success');
                closeModal('doc-parse-modal');
                resetDocParse();
            } else {
                showToast(data.error || 'Save failed', 'error');
            }
        } catch (err) {
            showToast('Network error: ' + err.message, 'error');
        }
    }
}

function openAddEquipmentModal() {
    // Clear inputs first
    document.getElementById('add-eq-name').value = '';
    document.getElementById('add-eq-make').value = '';
    document.getElementById('add-eq-cost').value = '';
    document.getElementById('add-eq-labcode').value = '';
    document.getElementById('add-eq-location').value = '';
    document.getElementById('add-eq-dtrec').value = '';
    document.getElementById('add-eq-status').value = 'Working';
    document.getElementById('add-eq-url').value = '';
    document.getElementById('add-eq-register').value = '';
    
    openModal('add-equipment-modal');
}

async function submitAddEquipment() {
    const name = document.getElementById('add-eq-name').value.trim();
    const make = document.getElementById('add-eq-make').value.trim();
    const cost = document.getElementById('add-eq-cost').value.trim();
    const labCode = document.getElementById('add-eq-labcode').value.trim();
    const location = document.getElementById('add-eq-location').value.trim();
    const dtRec = document.getElementById('add-eq-dtrec').value.trim();
    const status = document.getElementById('add-eq-status').value;
    const url = document.getElementById('add-eq-url').value.trim();
    const registerDetails = document.getElementById('add-eq-register').value.trim();

    if (!name || !labCode) {
        return showToast('Equipment Name and Lab Code are required fields.', 'warning');
    }

    const payload = {
        name,
        make: make || null,
        cost: cost || null,
        labCode,
        location: location || null,
        dtRec: dtRec || null,
        status,
        url: url || null,
        registerDetails: registerDetails || null
    };

    try {
        const res = await fetch('/api/equipments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok) {
            showToast('New capital equipment registered successfully!', 'success');
            closeModal('add-equipment-modal');
            fetchAndRenderEquipments();
            fetchEquipmentStats();
        } else {
            showToast(data.error || 'Failed to save equipment.', 'error');
        }
    } catch(err) {
        showToast('Network error while saving equipment.', 'error');
    }
}

function openEditEquipmentModal(id, name, labCode, status, location, registerDetails) {
    document.getElementById('edit-eq-id').value = id;
    document.getElementById('edit-eq-display-name').textContent = name;
    document.getElementById('edit-eq-display-code').textContent = `Lab Code: ${labCode || '—'}`;
    document.getElementById('edit-eq-status').value = status || 'Working';
    document.getElementById('edit-eq-location').value = location || '';
    document.getElementById('edit-eq-register').value = registerDetails || '';
    
    openModal('edit-equipment-modal');
}

async function submitEditEquipment() {
    const id = document.getElementById('edit-eq-id').value;
    const status = document.getElementById('edit-eq-status').value;
    const location = document.getElementById('edit-eq-location').value.trim();
    const registerDetails = document.getElementById('edit-eq-register').value.trim();

    const payload = {
        status,
        location: location || null,
        registerDetails: registerDetails || null
    };

    try {
        const res = await fetch(`/api/equipments/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok) {
            showToast('Equipment updated successfully!', 'success');
            closeModal('edit-equipment-modal');
            fetchAndRenderEquipments();
            fetchEquipmentStats();
        } else {
            showToast(data.error || 'Failed to update equipment.', 'error');
        }
    } catch(err) {
        showToast('Network error while updating equipment.', 'error');
    }
}

async function deleteEquipment(id, name) {
    if (!confirm(`Are you absolutely sure you want to delete the equipment record for: "${name}"? This action is permanent.`)) {
        return;
    }

    try {
        const res = await fetch(`/api/equipments/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (res.ok) {
            showToast(`Deleted equipment: "${name}"`, 'success');
            fetchAndRenderEquipments();
            fetchEquipmentStats();
        } else {
            showToast(data.error || 'Failed to delete equipment.', 'error');
        }
    } catch (err) {
        showToast('Network error while deleting equipment.', 'error');
    }
}

// --- ALLOTMENT EXCEL DOWNLOAD AND PRINTING HANDLERS ---
async function triggerExcelDownloadAndPrint(sampleIds) {
    if (!sampleIds || sampleIds.length === 0) return;
    
    // 1. Trigger the Excel download
    await triggerExcelDownload(sampleIds);
    
    // 2. Fetch sample details and print
    try {
        const res = await fetch('/api/samples-by-ids', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sampleIds })
        });
        if (res.ok) {
            const data = await res.json();
            if (data.samples && data.samples.length > 0) {
                printAllotmentSlips(data.samples);
            }
        } else {
            console.error('Failed to fetch sample details for printing');
        }
    } catch(err) {
        console.error('Error fetching print details:', err);
    }
}

async function triggerExcelDownload(sampleIds) {
    try {
        const res = await fetch('/api/download-allotted', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sampleIds })
        });
        if (res.ok) {
            const blob = await res.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `allotment_slip_${Date.now()}.xlsx`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
        } else {
            console.error('Failed to download Excel file');
        }
    } catch(err) {
        console.error('Error during Excel download:', err);
    }
}

function printMasterList() {
    const searchTerm = (document.getElementById('search-input')?.value || '').toLowerCase();
    const isFilterVal = document.getElementById('is-filter')?.value || 'ALL';
    const priorityFilter = document.getElementById('priority-filter')?.value || 'ALL';
    const assignedFilterVal = document.getElementById('assigned-filter')?.value || 'ALL';

    const filtered = allSamples.filter(s => {
        if (searchTerm && !s.encodedCode?.toLowerCase().includes(searchTerm)) return false;
        if (isFilterVal !== 'ALL' && s.isNumber !== isFilterVal) return false;
        if (priorityFilter !== 'ALL' && s.priorityLevel !== priorityFilter) return false;
        if (assignedFilterVal !== 'ALL' && s.assignedTo !== assignedFilterVal) return false;
        return true;
    });

    const printWindow = window.open('', '_blank');
    if (!printWindow) { showToast('Allow popups to print.', 'warning'); return; }

    const now = new Date().toLocaleString('en-IN');
    const rows = filtered.map((s, i) => `
        <tr class="${i % 2 === 0 ? 'even' : 'odd'}">
            <td>${i + 1}</td>
            <td>${s.encodedCode || '—'}</td>
            <td>${s.isNumber || '—'}</td>
            <td>${s.receivedOn || '—'}</td>
            <td>${s.priorityLevel || '—'}</td>
            <td>${s.assignedTo || 'Unassigned'}</td>
            <td>${s.appStatus || '—'}</td>
        </tr>`).join('');

    printWindow.document.write(`<!DOCTYPE html><html><head>
        <title>Master Sample List</title>
        <style>
            body { font-family: Arial, sans-serif; font-size: 11px; margin: 20px; color: #111; }
            h2 { text-align: center; margin-bottom: 4px; font-size: 15px; }
            .meta { text-align: center; color: #555; margin-bottom: 12px; font-size: 10px; }
            table { width: 100%; border-collapse: collapse; }
            th { background: #1e3a5f; color: white; padding: 7px 6px; text-align: left; font-size: 10px; }
            td { padding: 6px 6px; border-bottom: 1px solid #ddd; }
            tr.even { background: #f8fafc; }
            tr.odd { background: #ffffff; }
            @media print {
                body { margin: 10px; }
                button { display: none; }
            }
        </style>
    </head><body>
        <h2>Namoona Paridarshan — Master Sample List</h2>
        <div class="meta">Printed: ${now} &nbsp;|&nbsp; Total Records: ${filtered.length}</div>
        <table>
            <thead><tr>
                <th>#</th><th>Encoded Code</th><th>IS Number</th>
                <th>Received On</th><th>Priority</th><th>Assigned To</th><th>Status</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>
        <script>window.onload = () => { window.print(); }<\/script>
    </body></html>`);
    printWindow.document.close();
}

function printAllotmentSlips(samples) {
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
        showToast('Popup blocker prevented opening the print window. Please allow popups.', 'warning');
        return;
    }
    
    let html = `
    <html>
    <head>
        <title>Job Allotment Slips</title>
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 20px; color: #333; }
            .slip-card { 
                border: 2px solid #333; 
                border-radius: 8px; 
                padding: 20px; 
                margin-bottom: 20px; 
                page-break-inside: avoid;
                max-width: 600px;
                background: #fff;
            }
            .slip-header { 
                text-align: center; 
                border-bottom: 2px double #333; 
                padding-bottom: 10px; 
                margin-bottom: 15px; 
            }
            .slip-title { font-size: 1.4rem; font-weight: bold; margin: 0; text-transform: uppercase; }
            .slip-subtitle { font-size: 0.9rem; color: #666; margin: 5px 0 0 0; }
            .slip-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 15px; }
            .slip-item { font-size: 1rem; line-height: 1.5; }
            .slip-item strong { color: #000; }
            .slip-footer { 
                display: flex; 
                justify-content: space-between; 
                margin-top: 30px; 
                border-top: 1px dashed #999; 
                padding-top: 15px; 
            }
            .signature-line { text-align: center; width: 45%; }
            .signature-line p { margin: 5px 0 0 0; font-size: 0.85rem; font-weight: bold; }
            .signature-box { border-bottom: 1px solid #000; height: 40px; }
            @media print {
                body { padding: 0; }
                .slip-card { border: 2px solid #000; box-shadow: none; margin-bottom: 0; page-break-after: always; }
                .slip-card:last-child { page-break-after: avoid; }
            }
        </style>
    </head>
    <body>
    `;
    
    samples.forEach(sample => {
        const dateStr = new Date().toLocaleDateString('en-IN', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
        html += `
        <div class="slip-card">
            <div class="slip-header">
                <div class="slip-title">Bureau of Indian Standards</div>
                <div class="slip-subtitle">Job Allotment Slip - Mechanical/Water Testing Lab</div>
            </div>
            <div class="slip-grid">
                <div class="slip-item"><strong>Sample Code:</strong> ${sample.encodedCode}</div>
                <div class="slip-item"><strong>Allotted Date:</strong> ${dateStr}</div>
                <div class="slip-item"><strong>IS Number:</strong> ${sample.isNumber || '—'}</div>
                <div class="slip-item"><strong>Priority:</strong> ${sample.priorityLevel || 'Standard'}</div>
                <div class="slip-item"><strong>Quantity:</strong> ${sample.quantity || '—'}</div>
                <div class="slip-item"><strong>Assigned To:</strong> ${sample.assignedTo || '—'}</div>
                <div class="slip-item"><strong>Received On:</strong> ${sample.receivedOn || '—'}</div>
                <div class="slip-item"><strong>Forwarded On:</strong> ${sample.forwardedOn || '—'}</div>
            </div>
            <div class="slip-footer">
                <div class="signature-line">
                    <div class="signature-box"></div>
                    <p>Signature of Testing Officer</p>
                </div>
                <div class="signature-line">
                    <div class="signature-box"></div>
                    <p>Signature of OIC / Lab Admin</p>
                </div>
            </div>
        </div>
        `;
    });
    
    html += `
        <script>
            window.onload = function() {
                window.print();
                setTimeout(function() { window.close(); }, 500);
            }
        </script>
    </body>
    </html>
    `;
    
    printWindow.document.write(html);
    printWindow.document.close();
}

// =============================================================================
// DISHA AGENT — bell + slide-out panel (Phase 1–3: notification + execution)
// =============================================================================
(function () {
    const POLL_MS = 30_000;
    let pollTimer = null;
    let currentFilter = 'open';
    let lastOpenCount = 0;

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function relTime(iso) {
        if (!iso) return '';
        const diff = Date.now() - new Date(iso).getTime();
        if (!Number.isFinite(diff)) return '';
        const m = Math.floor(diff / 60000);
        if (m < 1) return 'just now';
        if (m < 60) return `${m}m ago`;
        const h = Math.floor(m / 60);
        if (h < 24) return `${h}h ago`;
        return `${Math.floor(h / 24)}d ago`;
    }

    function renderCards(list) {
        const host = document.getElementById('Nigrani-bell-list');
        if (!host) return;
        if (!list || !list.length) {
            host.innerHTML = `<div class="Nigrani-bell-empty">${
                currentFilter === 'open' ? 'No active alerts. Nigrani is watching.' : 'Nothing here.'
            }</div>`;
            return;
        }
        host.innerHTML = list.map(n => {
            const sev = (n.severity || 'info').toLowerCase();
            const sevLabel = sev === 'critical' ? 'Urgent' : sev === 'warn' ? 'Heads up' : 'Info';
            const samples = (n.sample_ids || []);
            const isOpen = n.status === 'open';
            const resolvedCls = isOpen ? '' : ' is-resolved';
            return `
                <div class="Nigrani-card sev-${sev}${resolvedCls}" data-id="${n.id}">
                    <div class="Nigrani-card-head">
                        <span class="Nigrani-card-sev sev-${sev}">${sevLabel}</span>
                        <span class="Nigrani-card-meta">${escapeHtml(n.type || '')} · ${relTime(n.created_at)}${
                            n.status !== 'open' ? ` · ${escapeHtml(n.status)}` : ''
                        }</span>
                    </div>
                    <div class="Nigrani-card-title">${escapeHtml(n.title || '')}</div>
                    <div class="Nigrani-card-body">${escapeHtml(n.body || '')}</div>
                    ${samples.length ? `<div class="Nigrani-card-samples">Samples: ${samples.slice(0, 6).map(escapeHtml).join(', ')}${samples.length > 6 ? ` (+${samples.length - 6})` : ''}</div>` : ''}
                    ${isOpen ? `
                        <div class="Nigrani-card-actions">
                            <button class="Nigrani-btn primary" onclick="NigraniAct(${n.id}, 'approve')">Acknowledge</button>
                            <button class="Nigrani-btn" onclick="NigraniAct(${n.id}, 'snooze')">Snooze 4h</button>
                            <button class="Nigrani-btn ghost" onclick="NigraniAct(${n.id}, 'dismiss')">Dismiss</button>
                        </div>` : ''}
                </div>
            `;
        }).join('');
    }

    function updateBellBadge(count, hasCritical) {
        const badge = document.getElementById('Nigrani-bell-badge');
        const wrap = document.querySelector('.Nigrani-bell-wrap');
        if (badge) {
            if (count > 0) {
                badge.style.display = '';
                badge.textContent = count > 99 ? '99+' : String(count);
            } else {
                badge.style.display = 'none';
            }
        }
        if (wrap) wrap.classList.toggle('has-critical', !!hasCritical && count > 0);
    }

    async function fetchAndRender({ silent } = {}) {
        const sub = document.getElementById('Nigrani-bell-sub');
        if (!silent && sub) sub.textContent = 'Refreshing…';
        try {
            const resp = await fetch(`/api/notifications?status=${encodeURIComponent(currentFilter)}&limit=50`);
            const json = await resp.json().catch(() => ({}));
            if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
            const list = json.notifications || [];
            renderCards(list);
            const openCount = json.openCount || 0;
            lastOpenCount = openCount;
            const hasCritical = list.some(n => n.status === 'open' && n.severity === 'critical');
            updateBellBadge(openCount, hasCritical);
            if (sub) sub.textContent = `${openCount} open · checked ${new Date().toLocaleTimeString()}`;
        } catch (err) {
            if (sub) sub.textContent = 'Couldn’t reach Nigrani — will retry.';
            console.warn('[Nigrani bell] fetch failed', err);
        }
    }

    window.toggleDishaBell = function (forceState) {
        const panel = document.getElementById('Nigrani-bell-panel');
        const overlay = document.getElementById('Nigrani-bell-overlay');
        if (!panel || !overlay) return;
        const shouldOpen = forceState === undefined ? !panel.classList.contains('open') : !!forceState;
        panel.classList.toggle('open', shouldOpen);
        overlay.classList.toggle('open', shouldOpen);
        panel.setAttribute('aria-hidden', shouldOpen ? 'false' : 'true');
        if (shouldOpen) fetchAndRender();
    };
    window.toggleNigraniBell = window.toggleDishaBell;

    window.refreshNigraniBell = async function (force) {
        if (force) {
            try { await fetch('/api/notifications/run-monitor', { method: 'POST' }); } catch (_) {}
        }
        await fetchAndRender();
    };

    window.setNigraniFilter = function (status) {
        currentFilter = status;
        document.querySelectorAll('.Nigrani-bell-filter .Nigrani-chip').forEach(c => {
            c.classList.toggle('active', c.getAttribute('data-status') === status);
        });
        fetchAndRender();
    };

    window.dishaAct = async function (id, action) {
        const body = action === 'snooze' ? { hours: 4 } : {};
        try {
            const r = await fetch(`/api/notifications/${id}/${action}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!r.ok) throw new Error(await r.text());
            const json = await r.json();

            // Show executor result if present (Phase 2+)
            if (json.executionResult) {
                const isError = !!json.executionResult.error;
                const msg = isError
                    ? `Failed: ${json.executionResult.error}`
                    : json.executionResult.message || `Action executed: ${json.executionResult.count || 0} items`;
                showToast(msg, isError ? 'error' : 'success');
            } else {
                const actionLabel = action === 'approve' ? 'Acknowledged' : action === 'dismiss' ? 'Dismissed' : 'Snoozed';
                showToast(actionLabel, 'info');
            }

            await fetchAndRender({ silent: true });
        } catch (err) {
            console.warn('[Disha bell] action failed', err);
            showToast('Action failed: ' + err.message, 'error');
        }
    };
    window.NigraniAct = window.dishaAct;

    function initNigraniBell() {
        // Light background poll for the badge — every 30s while page is open.
        fetchAndRender({ silent: true });
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(() => {
            if (document.hidden) return;
            fetchAndRender({ silent: true });
        }, POLL_MS);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initNigraniBell, { once: true });
    } else {
        initNigraniBell();
    }
})();

// --- PHASE 1: ATTENDANCE SYSTEM ---
async function loadAttendance() {
    try {
        const grid = document.getElementById('attendance-grid');
        if (!grid) return;
        grid.innerHTML = '<div style="color:var(--text-muted);">Loading...</div>';
        
        const res = await fetch('/api/attendance/today');
        if (!res.ok) throw new Error('Failed to load attendance');
        const data = await res.json();
        
        grid.innerHTML = '';
        data.attendance.forEach(emp => {
            const isPresent = emp.status === 'present';
            const card = document.createElement('div');
            card.style.cssText = `
                background: rgba(255,255,255,0.02);
                border: 1px solid rgba(255,255,255,0.05);
                border-radius: 8px;
                padding: 12px 15px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                transition: all 0.2s;
            `;
            if (isPresent) {
                card.style.borderColor = 'rgba(16, 185, 129, 0.3)';
                card.style.background = 'rgba(16, 185, 129, 0.05)';
            }
            
            card.innerHTML = `
                <span style="font-weight: 500; font-size: 0.95rem; color: var(--text-main);">${emp.fullName}</span>
                <button onclick="toggleAttendance(${emp.employeeId}, '${isPresent ? 'absent' : 'present'}')" 
                        style="background: ${isPresent ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)'}; 
                               color: ${isPresent ? '#10b981' : '#ef4444'}; 
                               border: 1px solid ${isPresent ? 'rgba(16, 185, 129, 0.5)' : 'rgba(239, 68, 68, 0.5)'}; 
                               border-radius: 6px; padding: 4px 8px; cursor: pointer; font-size: 0.85rem; font-weight: bold;">
                    ${isPresent ? '✅ Present' : '❌ Absent'}
                </button>
            `;
            grid.appendChild(card);
        });
    } catch (err) {
        console.error(err);
        document.getElementById('attendance-grid').innerHTML = '<div style="color:#ef4444;">Error loading attendance</div>';
    }
}

async function toggleAttendance(employeeId, status) {
    try {
        const res = await fetch('/api/attendance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ employeeId, status })
        });
        if (!res.ok) throw new Error('Update failed');
        loadAttendance();
    } catch (err) {
        alert(err.message);
    }
}

async function markAllPresent() {
    try {
        const res = await fetch('/api/attendance/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'present' })
        });
        if (!res.ok) throw new Error('Update failed');
        loadAttendance();
    } catch (err) {
        alert(err.message);
    }
}

// Hook to load attendance when assigner tab is opened
const _originalSwitchTabPhase1 = typeof switchTab === 'function' ? switchTab : function(){};
switchTab = function(tabId) {
    _originalSwitchTabPhase1(tabId);
    if (tabId === 'tab-assigner') {
        if (typeof loadAttendance === 'function') loadAttendance();
    }
};

// --- PHASE 1: TEST REPORT SYSTEM ---
let currentReportLimits = [];
let currentObservations = [];

async function openTestReportModal(sampleId, encodedCode, isNumber) {
    document.getElementById('test-report-modal').style.display = 'flex';
    document.getElementById('report-sample-code').textContent = `- ${encodedCode}`;
    document.getElementById('report-sample-id').value = sampleId;
    document.getElementById('report-is-number').value = isNumber;
    document.getElementById('report-verdict-banner').style.display = 'none';
    
    // Load variety dropdown based on IS limits table
    const varietySelect = document.getElementById('report-variety-select');
    varietySelect.innerHTML = '<option value="">Select Variety...</option>';
    
    document.getElementById('test-report-tbody').innerHTML = '<tr><td colspan="5" style="text-align:center;">Loading limits...</td></tr>';
    
    try {
        // Just get distinct varieties first (backend query without variety fetches all)
        const res = await fetch(`/api/conformance-limits/${encodeURIComponent(isNumber)}`);
        if (res.ok) {
            const data = await res.json();
            const varieties = new Set(data.limits.map(l => l.varietyTag).filter(v => v));
            varieties.forEach(v => {
                const opt = document.createElement('option');
                opt.value = v;
                opt.textContent = v;
                varietySelect.appendChild(opt);
            });
        }
        
        // Load the sample's existing test report data (which might have limits already fetched)
        const res2 = await fetch(`/api/test-report/${sampleId}`);
        if (res2.ok) {
            const reportData = await res2.json();
            currentObservations = reportData.observations || [];
            // If they already have observations, try to pick the variety that matches
            if (currentObservations.length > 0 && reportData.limits && reportData.limits.length > 0) {
                const limitIds = currentObservations.map(o => o.limitId);
                const matchingLimits = reportData.limits.filter(l => limitIds.includes(l.id));
                if (matchingLimits.length > 0 && matchingLimits[0].varietyTag) {
                    varietySelect.value = matchingLimits[0].varietyTag;
                }
            }
        }
        
        await loadTestReportLimits();
    } catch (err) {
        console.error(err);
        document.getElementById('test-report-tbody').innerHTML = '<tr><td colspan="5" style="text-align:center; color:red;">Failed to load.</td></tr>';
    }
}

function closeTestReportModal() {
    document.getElementById('test-report-modal').style.display = 'none';
}

async function loadTestReportLimits() {
    const isNumber = document.getElementById('report-is-number').value;
    const variety = document.getElementById('report-variety-select').value;
    
    document.getElementById('test-report-tbody').innerHTML = '<tr><td colspan="5" style="text-align:center;">Loading limits...</td></tr>';
    try {
        let url = `/api/conformance-limits/${encodeURIComponent(isNumber)}`;
        if (variety) url += `?variety=${encodeURIComponent(variety)}`;
        
        const res = await fetch(url);
        if (!res.ok) throw new Error('Failed to fetch limits');
        const data = await res.json();
        
        currentReportLimits = data.limits || [];
        renderTestReportTable();
    } catch (err) {
        console.error(err);
        document.getElementById('test-report-tbody').innerHTML = '<tr><td colspan="5" style="text-align:center; color:red;">Error loading limits</td></tr>';
    }
}

function computeVerdict(valueStr, min, max, limitType) {
    if (!valueStr || valueStr.trim() === '') return 'pending';
    const val = parseFloat(valueStr);
    if (isNaN(val)) return 'pending'; // could handle pass/fail string logic here
    
    if (limitType === 'min') return val >= min ? 'pass' : 'fail';
    if (limitType === 'max') return val <= max ? 'pass' : 'fail';
    if (limitType === 'range') return (val >= min && val <= max) ? 'pass' : 'fail';
    if (limitType === 'nominal') return val === min ? 'pass' : 'fail';
    return 'pending';
}

function onObservationChange(limitId, inputEl) {
    const limit = currentReportLimits.find(l => l.id === limitId);
    if (!limit) return;
    
    const verdict = computeVerdict(inputEl.value, limit.limitMin, limit.limitMax, limit.limitType);
    
    // update observation cache
    let obs = currentObservations.find(o => o.limitId === limitId);
    if (!obs) {
        obs = { limitId, observedValue: inputEl.value, verdict, remarks: '' };
        currentObservations.push(obs);
    } else {
        obs.observedValue = inputEl.value;
        obs.verdict = verdict;
    }
    
    // update UI
    const tr = inputEl.closest('tr');
    const verdictTd = tr.querySelector('.verdict-cell');
    if (verdict === 'pass') verdictTd.innerHTML = '<span style="color:#10b981; font-weight:bold;">✅ Pass</span>';
    else if (verdict === 'fail') verdictTd.innerHTML = '<span style="color:#ef4444; font-weight:bold;">❌ Fail</span>';
    else verdictTd.innerHTML = '<span style="color:#94a3b8;">Pending</span>';
    
    updateOverallVerdict();
}

function updateOverallVerdict() {
    if (currentReportLimits.length === 0) return;
    
    let allPass = true;
    let anyFail = false;
    let missing = false;
    
    currentReportLimits.forEach(l => {
        const obs = currentObservations.find(o => o.limitId === l.id);
        if (!obs || obs.verdict === 'pending') { missing = true; allPass = false; }
        else if (obs.verdict === 'fail') { anyFail = true; allPass = false; }
    });
    
    const banner = document.getElementById('report-verdict-banner');
    banner.style.display = 'block';
    
    if (anyFail) {
        banner.style.background = '#fef2f2';
        banner.style.color = '#991b1b';
        banner.innerHTML = '🚨 Sample Fails Conformance';
    } else if (missing) {
        banner.style.background = '#f8fafc';
        banner.style.color = '#475569';
        banner.innerHTML = '⏳ Testing In Progress...';
    } else if (allPass) {
        banner.style.background = '#f0fdf4';
        banner.style.color = '#166534';
        banner.innerHTML = '🎉 Sample Passes All Conformance Requirements';
    }
}

function renderTestReportTable() {
    const tbody = document.getElementById('test-report-tbody');
    tbody.innerHTML = '';
    
    if (currentReportLimits.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding: 20px;">No conformance limits configured for this IS/Variety. Please configure them in IS Intelligence tab.</td></tr>`;
        return;
    }
    
    currentReportLimits.forEach(limit => {
        const obs = currentObservations.find(o => o.limitId === limit.id) || { observedValue: '', verdict: 'pending' };
        
        let reqStr = '';
        if (limit.limitType === 'range') reqStr = `${limit.limitMin} - ${limit.limitMax} ${limit.unit||''}`;
        else if (limit.limitType === 'min') reqStr = `Min: ${limit.limitMin} ${limit.unit||''}`;
        else if (limit.limitType === 'max') reqStr = `Max: ${limit.limitMax} ${limit.unit||''}`;
        else if (limit.limitType === 'nominal') reqStr = `Nominal: ${limit.limitMin} ${limit.unit||''}`;
        
        let amendmentBadge = limit.isAmended ? `<span style="background:#fee2e2; color:#ef4444; font-size:0.6rem; padding:2px 6px; border-radius:10px; margin-left:8px; font-weight:bold;" title="${limit.amendmentNote||''}">🔔 ${limit.amendmentRef||'Amended'}</span>` : '';
        
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="font-weight:600;">${limit.clauseRef} ${amendmentBadge}</td>
            <td>${limit.parameter}</td>
            <td style="color:#64748b; font-family:monospace;">${reqStr}</td>
            <td>
                <input type="text" class="premium-input" style="width:100%; padding: 6px; font-size:0.9rem;" value="${obs.observedValue||''}" oninput="onObservationChange(${limit.id}, this)">
            </td>
            <td class="verdict-cell" style="text-align:center;">
                ${obs.verdict === 'pass' ? '<span style="color:#10b981; font-weight:bold;">✅ Pass</span>' : obs.verdict === 'fail' ? '<span style="color:#ef4444; font-weight:bold;">❌ Fail</span>' : '<span style="color:#94a3b8;">Pending</span>'}
            </td>
        `;
        tbody.appendChild(tr);
    });
    
    updateOverallVerdict();
}

async function saveTestObservations() {
    const sampleId = document.getElementById('report-sample-id').value;
    try {
        const res = await fetch(`/api/test-report/${sampleId}/observations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ observations: currentObservations })
        });
        if (!res.ok) throw new Error('Save failed');
        alert('Observations saved successfully!');
    } catch(err) {
        alert(err.message);
    }
}

function printTestReport() {
    window.print();
}

// --- PHASE 1: CONFORMANCE LIMITS EDITOR ---
async function loadAdminLimits() {
    try {
        const tbody = document.getElementById('admin-limits-tbody');
        if (!tbody) return;
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;">Loading...</td></tr>';
        
        // Passing ALL to fetch all limits for the admin editor
        const res = await fetch(`/api/conformance-limits/ALL`);
        if (!res.ok) throw new Error('Failed to load limits');
        const data = await res.json();
        
        tbody.innerHTML = '';
        if (!data.limits || data.limits.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;">No limits configured yet.</td></tr>';
            return;
        }
        
        data.limits.forEach(limit => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${limit.isNumber}</td>
                <td>${limit.varietyTag || 'General'}</td>
                <td>${limit.clauseRef || ''}</td>
                <td>${limit.parameter}</td>
                <td>${limit.limitType}</td>
                <td>${limit.limitMin !== null ? limit.limitMin : '—'}</td>
                <td>${limit.limitMax !== null ? limit.limitMax : '—'}</td>
                <td>
                    <button class="btn-icon" style="color:#ef4444;" onclick="deleteAdminLimit(${limit.id})"><i class="fas fa-trash"></i></button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch(err) {
        console.error(err);
        document.getElementById('admin-limits-tbody').innerHTML = '<tr><td colspan="8" style="text-align:center; color:red;">Failed to load</td></tr>';
    }
}

async function saveAdminLimit() {
    const payload = {
        isNumber: document.getElementById('admin-limit-is').value,
        varietyTag: document.getElementById('admin-limit-variety').value,
        clauseRef: document.getElementById('admin-limit-clause').value,
        parameter: document.getElementById('admin-limit-parameter').value,
        unit: document.getElementById('admin-limit-unit').value,
        limitType: document.getElementById('admin-limit-type').value,
        limitMin: document.getElementById('admin-limit-min').value || null,
        limitMax: document.getElementById('admin-limit-max').value || null
    };
    
    if (!payload.isNumber || !payload.parameter) {
        alert('IS Number and Parameter are required.');
        return;
    }
    
    try {
        const res = await fetch('/api/conformance-limits', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error('Save failed');
        document.getElementById('add-limit-form').style.display = 'none';
        
        // clear form
        document.getElementById('admin-limit-parameter').value = '';
        document.getElementById('admin-limit-clause').value = '';
        document.getElementById('admin-limit-min').value = '';
        document.getElementById('admin-limit-max').value = '';
        
        loadAdminLimits();
    } catch(err) {
        alert(err.message);
    }
}

async function deleteAdminLimit(id) {
    if (!confirm('Are you sure you want to delete this limit?')) return;
    try {
        const res = await fetch(`/api/conformance-limits/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Delete failed');
        loadAdminLimits();
    } catch(err) {
        alert(err.message);
    }
}

// Hook to load admin limits when switching to Limits tab
const _originalSwitchISInnerTabPhase1 = typeof switchISInnerTab === 'function' ? switchISInnerTab : function(){};
switchISInnerTab = function(tabId) {
    _originalSwitchISInnerTabPhase1(tabId);
    if (tabId === 'limits') {
        if (typeof loadAdminLimits === 'function') loadAdminLimits();
    }
};
