let currentUser = null;
let allSamples = [];
let currentSubmitId = null;
let pendingFreshSamples = [];
let currentFileName = "";
let currentDuplicateCount = 0;
let kpiFilter = "ALL";

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
            document.getElementById('user-welcome').textContent = `Welcome, ${currentUser.username} (Role: ${currentUser.role})`;
            
            if (currentUser.role === 'admin') {
                document.getElementById('admin-panel').style.display = 'block';
            }
            
            showToast(`Welcome back, ${currentUser.username}!`, 'success');
            fetchSamples();
        } else {
            showToast(data.error, 'error');
        }
    } catch (e) { console.error(e); }
}

function logout() {
    currentUser = null;
    document.getElementById('dashboard-container').classList.remove('active');
    document.getElementById('auth-container').classList.add('active');
    document.getElementById('admin-panel').style.display = 'none';
    document.getElementById('username').value = '';
    document.getElementById('password').value = '';
    showToast('Logged out securely.', 'info');
}

// Admin Upload
async function uploadExcel() {
    const fileInput = document.getElementById('excel-file');
    if (!fileInput.files[0]) return showToast('Select an Excel file first.', 'warning');
    
    const formData = new FormData();
    formData.append('file', fileInput.files[0]);

    showToast("Analyzing structure and duplicates...", 'info');
    try {
        const res = await fetch('/api/upload', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        if (res.ok) {
            currentFileName = data.fileName || "Unknown.xlsx";
            showReviewModal(data.freshSamples, data.duplicateSamples);
        } else {
            showToast(data.error, 'error');
        }
    } catch (e) { console.error(e); }
}

function showReviewModal(fresh, duplicates) {
    pendingFreshSamples = fresh;
    currentDuplicateCount = duplicates.length;
    
    document.getElementById('fresh-count').textContent = fresh.length;
    document.getElementById('duplicate-count').textContent = duplicates.length;
    
    document.getElementById('commit-btn').disabled = fresh.length === 0;

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
        tr.classList.add('row-danger-red');
        tr.innerHTML = `<td>${s.encodedCode}</td><td>${s.assignedTo}</td><td><strong>${s.priorityLevel}</strong></td>`;
        dupTbody.appendChild(tr);
    });

    document.getElementById('review-modal').classList.add('active');
}

function closeReviewModal() {
    document.getElementById('review-modal').classList.remove('active');
    pendingFreshSamples = [];
    currentDuplicateCount = 0;
    currentFileName = "";
    document.getElementById('excel-file').value = "";
}

async function commitUpload() {
    if (pendingFreshSamples.length === 0) return closeReviewModal();
    
    document.getElementById('commit-btn').disabled = true;
    document.getElementById('commit-btn').textContent = "Committing...";

    try {
        const payload = {
            samples: pendingFreshSamples,
            duplicateCount: currentDuplicateCount,
            fileName: currentFileName,
            uploadedBy: currentUser ? currentUser.username : 'Unknown Admin'
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
        
        fetchSamples();
        
    } catch (e) { 
        console.error(e); 
        showToast('Failed to commit upload', 'error');
    } finally {
        document.getElementById('commit-btn').disabled = false;
        document.getElementById('commit-btn').textContent = "Commit to Master";
    }
}

// Upload History & Batch Details Modal (Phase 7)
async function viewHistory() {
    document.getElementById('history-modal').classList.add('active');
    const tbody = document.getElementById('history-tbody');
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Loading audit trail...</td></tr>';
    
    try {
        const res = await fetch('/api/upload-history');
        const data = await res.json();
        if (res.ok) {
            tbody.innerHTML = '';
            if (data.history.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">No uploads recorded yet.</td></tr>';
                return;
            }
            data.history.forEach(log => {
                const tr = document.createElement('tr');
                tr.style.cursor = 'pointer';
                tr.title = "Click to view batch details";
                tr.onclick = () => viewBatchDetails(log.batchId);
                
                const dateObj = new Date(log.uploadDate);
                const prettyDate = dateObj.toLocaleDateString() + ' ' + dateObj.toLocaleTimeString();
                tr.innerHTML = `
                    <td style="color:var(--text-muted);">${prettyDate}</td>
                    <td><strong>${log.fileName}</strong></td>
                    <td style="color:var(--success); font-weight:bold;">+${log.sampleCount}</td>
                    <td style="color:var(--danger); font-weight:bold;">${log.duplicateCount || 0}</td>
                    <td>${log.uploadedBy}</td>
                `;
                tbody.appendChild(tr);
            });
        }
    } catch(e) {
        tbody.innerHTML = '<tr><td colspan="5" style="color:var(--danger);">Error loading history.</td></tr>';
    }
}

function closeHistoryModal() {
    document.getElementById('history-modal').classList.remove('active');
}

async function viewBatchDetails(batchId) {
    document.getElementById('history-modal').classList.remove('active');
    document.getElementById('batch-details-modal').classList.add('active');
    document.getElementById('batch-id-display').textContent = batchId;
    
    const tbody = document.getElementById('batch-details-tbody');
    tbody.innerHTML = '<tr><td colspan="2" style="text-align:center;">Loading batch samples...</td></tr>';
    
    try {
        const res = await fetch(`/api/batch-details/${batchId}`);
        const data = await res.json();
        if (res.ok) {
            tbody.innerHTML = '';
            data.samples.forEach(s => {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td style="color: var(--accent); font-weight:600;">${s.encodedCode}</td>
                    <td>${s.assignedTo}</td>
                `;
                tbody.appendChild(tr);
            });
        }
    } catch(e) {
        tbody.innerHTML = '<tr><td colspan="2" style="color:var(--danger);">Error loading details.</td></tr>';
    }
}

function closeBatchDetailsModal() {
    document.getElementById('batch-details-modal').classList.remove('active');
    document.getElementById('history-modal').classList.add('active'); // Go back to history
}


// Fetch and Render Data
async function fetchSamples() {
    if (!currentUser) return;
    try {
        const res = await fetch(`/api/samples/${currentUser.username}?role=${currentUser.role}`);
        const data = await res.json();
        if (res.ok) {
            allSamples = data.samples;
            populateTpDropdown();
            renderTable();
        }
    } catch (e) { console.error(e); }
}

function populateTpDropdown() {
    const tpFilter = document.getElementById('tp-filter');
    if (!tpFilter) return;
    const uniqueTPs = [...new Set(allSamples.map(s => s.assignedTo).filter(Boolean))].sort();
    
    const currentVal = tpFilter.value;
    tpFilter.innerHTML = '<option value="ALL">All Assigned To</option>';
    uniqueTPs.forEach(tp => {
        const opt = document.createElement('option');
        opt.value = tp;
        opt.textContent = tp;
        tpFilter.appendChild(opt);
    });
    
    if (uniqueTPs.includes(currentVal)) {
        tpFilter.value = currentVal;
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

function calculateDaysOld(dateStr) {
    const targetDate = parseDateDDMMYYYY(dateStr);
    if (!targetDate) return 0;
    const now = new Date();
    const diffTime = Math.abs(now - targetDate);
    return Math.floor(diffTime / (1000 * 60 * 60 * 24));
}

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

function renderTable() {
    const tbody = document.getElementById('table-body');
    tbody.innerHTML = '';

    const searchTerm = document.getElementById('search-input').value.toLowerCase();
    const statusFilter = document.getElementById('status-filter').value;
    const tpFilter = document.getElementById('tp-filter') ? document.getElementById('tp-filter').value : 'ALL';

    document.getElementById('kpi-card-total').classList.toggle('active-filter', kpiFilter === 'ALL');
    document.getElementById('kpi-card-priority').classList.toggle('active-filter', kpiFilter === 'Priority');
    document.getElementById('kpi-card-urgent').classList.toggle('active-filter', kpiFilter === 'Urgent');
    document.getElementById('kpi-card-submitted').classList.toggle('active-filter', kpiFilter === 'Submitted');

    let filtered = allSamples.filter(s => {
        if (statusFilter !== 'ALL' && s.appStatus !== statusFilter) return false;
        if (tpFilter !== 'ALL' && s.assignedTo !== tpFilter) return false;
        
        const searchString = `${s.encodedCode} ${s.isNumber} ${s.assignedTo}`.toLowerCase();
        if (searchTerm && !searchString.includes(searchTerm)) return false;
        
        return true;
    });

    filtered = filtered.map(s => {
        const daysOld = calculateDaysOld(s.forwardedOn);
        return { ...s, _daysOld: daysOld, _isTopPriority: isTopPriority(s) };
    });

    if (kpiFilter === 'Priority') {
        filtered = filtered.filter(s => s._isTopPriority && s.appStatus === 'Pending');
    } else if (kpiFilter === 'Urgent') {
        filtered = filtered.filter(s => !s._isTopPriority && s._daysOld > 15 && s.appStatus === 'Pending');
    } else if (kpiFilter === 'Submitted') {
        filtered = filtered.filter(s => s.appStatus === 'Submitted');
    }

    filtered.sort((a, b) => {
        if (a._isTopPriority && !b._isTopPriority) return -1;
        if (!a._isTopPriority && b._isTopPriority) return 1;

        const aUrgent = a._daysOld > 15;
        const bUrgent = b._daysOld > 15;

        if (aUrgent && !bUrgent) return -1;
        if (!aUrgent && bUrgent) return 1;

        return b._daysOld - a._daysOld;
    });

    const rawEnhanced = allSamples.map(s => {
        const daysOld = calculateDaysOld(s.forwardedOn);
        return { ...s, _daysOld: daysOld, _isTopPriority: isTopPriority(s) };
    });
    
    document.getElementById('kpi-total').textContent = rawEnhanced.length;
    document.getElementById('kpi-p-suffix').textContent = rawEnhanced.filter(s => s._isTopPriority && s.appStatus === 'Pending').length;
    document.getElementById('kpi-urgent').textContent = rawEnhanced.filter(s => !s._isTopPriority && s._daysOld > 15 && s.appStatus === 'Pending').length;
    document.getElementById('kpi-submitted').textContent = rawEnhanced.filter(s => s.appStatus === 'Submitted').length;

    filtered.forEach(s => {
        const tr = document.createElement('tr');
        
        if (s.appStatus === 'Pending') {
            if (s._daysOld > 15) {
                tr.classList.add('row-danger-red');
            } else if (s._daysOld > 7) {
                tr.classList.add('row-warning-yellow');
            }
        }

        let flagsHtml = `<strong>${s.priorityLevel || 'Standard'}</strong><br>`;
        if (s._isTopPriority && s.appStatus === 'Pending') flagsHtml += '<span class="badge-top-priority">Priority</span><br>';
        if (s._daysOld > 15 && s.appStatus === 'Pending') flagsHtml += '<span class="badge-fifo">SLA: >15 Days</span>';

        // Custom Status and Live Countdown
        let statusHtml = '';
        if (s.appStatus === 'Pending') {
            statusHtml = `<span class="status-badge status-pending">In Queue</span>`;
        } else {
            const passFailColor = s.passFail === 'Pass' ? 'status-submitted' : 'status-retained';
            
            // Calculate Disposal Countdown
            let countdownHtml = '';
            if (s.disposalDate) {
                const now = new Date();
                const dispDate = new Date(s.disposalDate);
                const diffTime = dispDate - now;
                const daysLeft = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                
                if (daysLeft > 0) {
                    countdownHtml = `<br><span class="badge-countdown" style="background: rgba(245, 158, 11, 0.2); color: #fcd34d;">⏳ ${daysLeft} Days Retained</span>`;
                } else {
                    countdownHtml = `<br><span class="badge-countdown" style="background: rgba(16, 185, 129, 0.2); color: #6ee7b7;">✅ Safe to Dispose</span>`;
                }
            }
            
            statusHtml = `
                <span class="status-badge ${passFailColor}">${s.passFail}</span>
                ${countdownHtml}
            `;
        }

        let actionHtml = '';
        if (s.appStatus === 'Pending') {
            if (currentUser.role === 'admin') {
                actionHtml = `<button disabled style="background:rgba(255,255,255,0.1); color:#999; border:1px solid #666;" title="Only TPs can submit">Admin View</button>`;
            } else {
                actionHtml = `<button onclick="openSubmitModal(${s.id}, '${s.encodedCode}')">Submit</button>`;
            }
        } else {
            actionHtml = `<button disabled style="background:rgba(255,255,255,0.1); color:#999; border:1px solid #666;">Completed</button>`;
        }

        tr.innerHTML = `
            <td>${flagsHtml}</td>
            <td style="color: var(--accent); font-weight:600;">${s.encodedCode}</td>
            <td style="color: var(--text-muted);">${s.isNumber}</td>
            <td>${s.quantity}</td>
            <td>${s.receivedOn}</td>
            <td>${s.forwardedOn}</td>
            <td><strong>${s.assignedTo}</strong></td>
            <td>${statusHtml}</td>
            <td>${actionHtml}</td>
        `;

        tbody.appendChild(tr);
    });
}

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
