// State Management
let samples = [...INITIAL_SAMPLES];
let filteredSamples = [...INITIAL_SAMPLES];

let tpFilter = "ALL";
let isFilter = "ALL";
let sampleStatusFilter = "ALL";
let reportStatusFilter = "ALL";
let nlpQueryText = "";

let sortKey = "sNo";
let sortDirection = "asc"; // 'asc' or 'desc'

let currentPage = 1;
const rowsPerPage = 20;

let activeListTab = 'pending'; // 'pending' or 'submitted'

function switchListTab(tab) {
    activeListTab = tab;
    if (tab === 'pending') {
        document.getElementById('tab-pending').className = 'action-btn primary-btn';
        document.getElementById('tab-pending').style.background = '';
        document.getElementById('tab-pending').style.color = '';
        document.getElementById('tab-pending').style.border = '';
        
        document.getElementById('tab-submitted').className = 'action-btn';
        document.getElementById('tab-submitted').style.background = '#e2e8f0';
        document.getElementById('tab-submitted').style.color = '#475569';
        document.getElementById('tab-submitted').style.border = '1px solid #cbd5e1';
    } else {
        document.getElementById('tab-submitted').className = 'action-btn primary-btn';
        document.getElementById('tab-submitted').style.background = '';
        document.getElementById('tab-submitted').style.color = '';
        document.getElementById('tab-submitted').style.border = '';
        
        document.getElementById('tab-pending').className = 'action-btn';
        document.getElementById('tab-pending').style.background = '#e2e8f0';
        document.getElementById('tab-pending').style.color = '#475569';
        document.getElementById('tab-pending').style.border = '1px solid #cbd5e1';
    }
    applyFilters();
}

function markAsSubmitted(sampleCode) {
    if(!confirm(`Are you sure you want to mark ${sampleCode} as Submitted?`)) return;
    let manualSubmitted = [];
    try { manualSubmitted = JSON.parse(localStorage.getItem('manualSubmittedSamples') || '[]'); } catch(e) {}
    if (!manualSubmitted.find(s => (s.sampleCode || s.encode1) === sampleCode)) {
        manualSubmitted.push({ sampleCode: sampleCode, date: new Date().toLocaleDateString('en-GB').replace(/\//g, '-') });
        localStorage.setItem('manualSubmittedSamples', JSON.stringify(manualSubmitted));
    }
    applyFilters();
}

function unmarkAsSubmitted(sampleCode) {
    if(!confirm(`Move ${sampleCode} back to Pending?`)) return;
    let manualSubmitted = [];
    try { manualSubmitted = JSON.parse(localStorage.getItem('manualSubmittedSamples') || '[]'); } catch(e) {}
    const initialLen = manualSubmitted.length;
    manualSubmitted = manualSubmitted.filter(s => (s.sampleCode || s.encode1) !== sampleCode);
    if (manualSubmitted.length < initialLen) {
        localStorage.setItem('manualSubmittedSamples', JSON.stringify(manualSubmitted));
        applyFilters();
    } else {
        alert("This sample was automatically submitted by the Python system and cannot be unmarked here.");
    }
}

// On Page Load Initialization
document.addEventListener("DOMContentLoaded", () => {
    populateFilterDropdowns();
    initializeDragAndDrop();
    
    // Bind NLP query input listener (real-time filtering!)
    const nlpInput = document.getElementById("nlp-query-input");
    nlpInput.addEventListener("input", (e) => {
        nlpQueryText = e.target.value;
        const clearBtn = document.getElementById("nlp-clear-btn");
        if (nlpQueryText) {
            clearBtn.style.display = "block";
        } else {
            clearBtn.style.display = "none";
        }
        processNLPAndApply();
    });

    applyFilters(); // Initial render
});

// Populate dropdown filters dynamically from the current dataset
function populateFilterDropdowns() {
    const tpSelect = document.getElementById("tp-name-filter");
    const isSelect = document.getElementById("is-number-filter");

    // Clear previous options except "ALL"
    tpSelect.innerHTML = '<option value="ALL">All Testers</option>';
    isSelect.innerHTML = '<option value="ALL">All Standards</option>';

    // Get unique sorted values
    const uniqueTps = [...new Set(samples.map(s => s.tpName).filter(Boolean))].sort();
    const uniqueIs = [...new Set(samples.map(s => s.isNumber).filter(Boolean))].sort();

    uniqueTps.forEach(tp => {
        const opt = document.createElement("option");
        opt.value = tp;
        opt.textContent = tp;
        tpSelect.appendChild(opt);
    });

    uniqueIs.forEach(isNum => {
        const opt = document.createElement("option");
        opt.value = isNum;
        opt.textContent = isNum;
        isSelect.appendChild(opt);
    });

    // Sync elements
    tpSelect.value = tpFilter;
    isSelect.value = isFilter;
}

// ----------------------------------------------------
// NLP Conversational Engine
// ----------------------------------------------------
function applyNLPQuery(query) {
    const nlpInput = document.getElementById("nlp-query-input");
    nlpInput.value = query;
    nlpQueryText = query;
    document.getElementById("nlp-clear-btn").style.display = "block";
    processNLPAndApply();
}

function clearNLPInput() {
    const nlpInput = document.getElementById("nlp-query-input");
    nlpInput.value = "";
    nlpQueryText = "";
    document.getElementById("nlp-clear-btn").style.display = "none";
    processNLPAndApply();
}

function processNLPAndApply() {
    // Reset other manual dropdown filters to avoid collision
    if (nlpQueryText.trim() !== "") {
        tpFilter = "ALL";
        isFilter = "ALL";
        sampleStatusFilter = "ALL";
        reportStatusFilter = "ALL";
        
        document.getElementById("tp-name-filter").value = "ALL";
        document.getElementById("is-number-filter").value = "ALL";
        document.getElementById("sample-status-filter").value = "ALL";
        document.getElementById("report-status-filter").value = "ALL";
    }

    applyFilters();
}

// Perform advanced keywords matching client-side
function filterByNLP(sample, queryLower) {
    if (!queryLower) return true;

    // Check simple full text match across all fields
    const fullText = `
        ${sample.sNo} 
        ${sample.encode1} 
        ${sample.encode2} 
        ${sample.encode3} 
        ${sample.isNumber} 
        ${sample.tpName} 
        ${sample.sampleStatus} 
        ${sample.reportStatus} 
        ${sample.mechRemarks}
    `.toLowerCase();

    // Check if query is directly a substring
    if (fullText.includes(queryLower)) return true;

    // Split query into terms to support multi-keyword intersection
    const terms = queryLower.split(/\s+/).filter(t => t.length > 1);
    if (terms.length === 0) return true;

    // Ensure all terms match somewhere in the text
    return terms.every(term => {
        // Special mapping for common synonyms
        if (term === "saurabh") return fullText.includes("saurabh");
        if (term === "mageshwaran") return fullText.includes("mageshwaran");
        if (term === "yashwanth" || term === "kaduluri") return fullText.includes("yashwanth") || fullText.includes("kaduluri");
        if (term === "progress" || term === "testing") return fullText.includes("testing in progress") || fullText.includes("forwarded for testing");
        if (term === "partial" || term === "report") return fullText.includes("partial report");
        if (term === "urgent" || term === "due") return fullText.includes("due") || fullText.includes("issued by") || fullText.includes("30-05-2026") || fullText.includes("pending");
        if (term === "march") return sample.receivedOn.includes("-03-");
        if (term === "february" || term === "feb") return sample.receivedOn.includes("-02-");
        
        return fullText.includes(term);
    });
}

function generateNLPResponse(count) {
    const box = document.getElementById("nlp-response-box");
    const textEl = document.getElementById("nlp-response-text");
    
    if (!nlpQueryText.trim()) {
        box.classList.remove("active");
        textEl.textContent = "Console loaded. Type a query above to filter real-time data!";
        return;
    }

    box.classList.add("active");
    const q = nlpQueryText.toLowerCase();

    let reply = `I found **${count}** pending samples matching your query.`;

    if (q.includes("saurabh")) {
        reply = `Found **${count}** samples assigned to **SAURABH SHANTARAM DANGALE** (all listed with indigo left borders below).`;
    } else if (q.includes("mageshwaran")) {
        reply = `I found **${count}** samples currently assigned to **MAGESHWARAN S**.`;
    } else if (q.includes("yashwanth") || q.includes("kaduluri")) {
        reply = `I retrieved **${count}** samples allocated to **KADULURI YASHWANTH**.`;
    } else if (q.includes("partial")) {
        reply = `Filtered to **${count}** samples that have **Partial Reports Issued**.`;
    } else if (q.includes("progress")) {
        reply = `Identified **${count}** samples with status **Testing in Progress**.`;
    } else if (q.includes("due") || q.includes("urgent") || q.includes("30-05-2026")) {
        reply = `Alert! Displaying **${count}** samples with remarks detailing deadlines (highlighted in soft red below).`;
    } else if (q.includes("14756")) {
        reply = `Loaded **${count}** quality control samples under standard **IS 14756 (Kitchen Utensils)**.`;
    } else if (q.includes("march")) {
        reply = `Found **${count}** samples received during **March 2026**.`;
    }

    textEl.innerHTML = reply;
}

// ----------------------------------------------------
// Filtering & Sorting Core
// ----------------------------------------------------
function applyFilters() {
    // Read dropdown filter values
    if (nlpQueryText.trim() === "") {
        tpFilter = document.getElementById("tp-name-filter").value;
        isFilter = document.getElementById("is-number-filter").value;
        sampleStatusFilter = document.getElementById("sample-status-filter").value;
        reportStatusFilter = document.getElementById("report-status-filter").value;
    }

    const nlpLower = nlpQueryText.toLowerCase().trim();

    // Read submitted samples from JS and LocalStorage
    const autoSubmitted = typeof SUBMITTED_SAMPLES !== 'undefined' ? SUBMITTED_SAMPLES : [];
    let manualSubmitted = [];
    try { manualSubmitted = JSON.parse(localStorage.getItem('manualSubmittedSamples') || '[]'); } catch(e) {}
    
    const allSubmittedSet = new Set();
    autoSubmitted.forEach(s => allSubmittedSet.add(s.sampleCode || s.encode1));
    manualSubmitted.forEach(s => allSubmittedSet.add(s.sampleCode || s.encode1));

    // Perform filter
    filteredSamples = samples.filter(sample => {
        // Tab separation logic
        const isSubmitted = allSubmittedSet.has(sample.encode1);
        if (activeListTab === 'pending' && isSubmitted) return false;
        if (activeListTab === 'submitted' && !isSubmitted) return false;

        // Dropdown Filters
        if (tpFilter !== "ALL" && sample.tpName !== tpFilter) return false;
        if (isFilter !== "ALL" && sample.isNumber !== isFilter) return false;
        if (sampleStatusFilter !== "ALL" && sample.sampleStatus !== sampleStatusFilter) return false;
        if (reportStatusFilter !== "ALL" && sample.reportStatus !== reportStatusFilter) return false;

        // NLP search matching
        return filterByNLP(sample, nlpLower);
    });

    // Generate Conversational feedback
    generateNLPResponse(filteredSamples.length);

    // Apply active sort
    sortFilteredData();

    // Reset pagination to first page after filters change
    currentPage = 1;

    // Render View
    renderAll();
}

function handleSort(key) {
    if (sortKey === key) {
        sortDirection = sortDirection === "asc" ? "desc" : "asc";
    } else {
        sortKey = key;
        sortDirection = "asc";
    }

    // Update Th headers indicators
    const headers = ["sNo", "encode", "isNumber", "receivedOn", "sampleStatus", "reportStatus", "mechRemarks", "tpName"];
    headers.forEach(h => {
        const el = document.getElementById(`th-${h}`);
        if (!el) return;
        let text = el.textContent.substring(0, el.textContent.length - 2);
        if (h === sortKey || (h === "encode" && sortKey === "encode1")) {
            el.innerHTML = `${text} <span>${sortDirection === "asc" ? "▲" : "▼"}</span>`;
            el.style.color = "var(--primary)";
        } else {
            el.innerHTML = `${text} <span>⇅</span>`;
            el.style.color = "";
        }
    });

    sortFilteredData();
    renderAll();
}

function sortFilteredData() {
    filteredSamples.sort((a, b) => {
        let valA = a[sortKey];
        let valB = b[sortKey];

        // Format dates correctly for comparison (DD-MM-YYYY)
        if (sortKey === "receivedOn") {
            const partsA = valA.split("-");
            const partsB = valB.split("-");
            // Convert to YYYYMMDD numeric value for clean sorting
            const numA = partsA.length === 3 ? parseInt(partsA[2] + partsA[1] + partsA[0]) : 0;
            const numB = partsB.length === 3 ? parseInt(partsB[2] + partsB[1] + partsB[0]) : 0;
            return sortDirection === "asc" ? numA - numB : numB - numA;
        }

        // Numeric sort for S.No.
        if (sortKey === "sNo") {
            const numA = parseInt(valA) || 0;
            const numB = parseInt(valB) || 0;
            return sortDirection === "asc" ? numA - numB : numB - numA;
        }

        // Lexicographical string sort for others
        valA = (valA || "").toString().toLowerCase();
        valB = (valB || "").toString().toLowerCase();

        if (valA < valB) return sortDirection === "asc" ? -1 : 1;
        if (valA > valB) return sortDirection === "asc" ? 1 : -1;
        return 0;
    });
}

function filterBySampleStatus(status) {
    resetAllFilters(false);
    sampleStatusFilter = status;
    document.getElementById("sample-status-filter").value = status;
    applyFilters();
}

function filterByReportStatus(status) {
    resetAllFilters(false);
    reportStatusFilter = status;
    document.getElementById("report-status-filter").value = status;
    applyFilters();
}

function filterByTPName(name) {
    resetAllFilters(false);
    tpFilter = name;
    document.getElementById("tp-name-filter").value = name;
    applyFilters();
}

function resetAllFilters(shouldRender = true) {
    tpFilter = "ALL";
    isFilter = "ALL";
    sampleStatusFilter = "ALL";
    reportStatusFilter = "ALL";
    nlpQueryText = "";

    document.getElementById("tp-name-filter").value = "ALL";
    document.getElementById("is-number-filter").value = "ALL";
    document.getElementById("sample-status-filter").value = "ALL";
    document.getElementById("report-status-filter").value = "ALL";
    document.getElementById("nlp-query-input").value = "";
    document.getElementById("nlp-clear-btn").style.display = "none";

    if (shouldRender) {
        applyFilters();
    }
}

// ----------------------------------------------------
// UI Renderer Functions
// ----------------------------------------------------
function renderAll() {
    renderKPIs();
    renderWorkloadList();
    renderTable();
}

function renderKPIs() {
    // Calculate stats based on active filtered list or full list
    // (Here we calculate them based on the full preloaded samples to show overall progress)
    const total = samples.length;
    const forwarded = samples.filter(s => s.sampleStatus === "Forwarded For Testing").length;
    const progress = samples.filter(s => s.sampleStatus === "Testing in Progress").length;
    const partial = samples.filter(s => s.reportStatus === "Partial Report Issued").length;

    document.getElementById("kpi-total").textContent = total;
    document.getElementById("kpi-forwarded").textContent = forwarded;
    document.getElementById("kpi-progress").textContent = progress;
    document.getElementById("kpi-partial").textContent = partial;

    document.getElementById("kpi-forwarded-percent").textContent = `${((forwarded/total)*100).toFixed(1)}% of total`;
    document.getElementById("kpi-progress-percent").textContent = `${((progress/total)*100).toFixed(1)}% of total`;
    document.getElementById("kpi-partial-percent").textContent = `${((partial/total)*100).toFixed(1)}% of total`;
}

function renderWorkloadList() {
    const container = document.getElementById("workload-list-container");
    container.innerHTML = "";

    // Count workload among all samples (or active samples)
    const tpCounts = {};
    samples.forEach(s => {
        if (s.tpName) {
            tpCounts[s.tpName] = (tpCounts[s.tpName] || 0) + 1;
        } else {
            tpCounts["Unassigned"] = (tpCounts["Unassigned"] || 0) + 1;
        }
    });

    // Format into array and sort by count descending
    const workloads = Object.keys(tpCounts).map(name => ({
        name,
        count: tpCounts[name]
    })).sort((a, b) => b.count - a.count);

    document.getElementById("workload-testers-count").textContent = `${workloads.filter(w => w.name !== "Unassigned").length} Active Testers`;

    const maxCount = workloads.length > 0 ? workloads[0].count : 1;

    workloads.forEach(w => {
        const item = document.createElement("div");
        item.className = `workload-item ${tpFilter === w.name ? 'active' : ''}`;
        
        // Highlight Saurabh's workload specifically
        const isSaurabh = w.name === "SAURABH SHANTARAM DANGALE";
        
        item.onclick = () => {
            if (w.name === "Unassigned") {
                filterByTPName("");
            } else {
                filterByTPName(w.name);
            }
        };

        const pct = (w.count / maxCount) * 100;

        item.innerHTML = `
            <div class="workload-name" style="${isSaurabh ? 'color: var(--primary); font-weight:600;' : ''}">
                <span>${isSaurabh ? '⭐ ' : ''}${w.name}</span>
                <span class="workload-count">${w.count} samples</span>
            </div>
            <div class="workload-bar-bg">
                <div class="workload-bar-fill" style="width: ${pct}%; ${isSaurabh ? 'background: linear-gradient(90deg, var(--primary), #818cf8);' : ''}"></div>
            </div>
        `;
        container.appendChild(item);
    });
}

function renderTable() {
    const tbody = document.getElementById("table-body");
    tbody.innerHTML = "";

    const totalEntries = filteredSamples.length;
    const totalPages = Math.ceil(totalEntries / rowsPerPage) || 1;

    // Check bounds
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;

    const startIdx = (currentPage - 1) * rowsPerPage;
    const endIdx = Math.min(startIdx + rowsPerPage, totalEntries);

    // Update Pagination Display
    document.getElementById("current-page-num").textContent = currentPage;
    document.getElementById("total-pages-num").textContent = totalPages;
    document.getElementById("prev-page-btn").disabled = currentPage === 1;
    document.getElementById("next-page-btn").disabled = currentPage === totalPages;

    if (totalEntries === 0) {
        document.getElementById("pagination-summary").textContent = "Showing 0 to 0 of 0 entries";
        tbody.innerHTML = `
            <tr>
                <td colspan="8">
                    <div class="table-empty">
                        <div class="table-empty-icon">🔍</div>
                        <h3>No samples found</h3>
                        <p>Try resetting filters or adjusting your natural language query.</p>
                    </div>
                </td>
            </tr>
        `;
        return;
    }

    document.getElementById("pagination-summary").textContent = `Showing ${startIdx + 1} to ${endIdx} of ${totalEntries} entries`;

    const pageSamples = filteredSamples.slice(startIdx, endIdx);

    pageSamples.forEach(s => {
        const tr = document.createElement("tr");

        // Highlights
        const isSaurabh = s.tpName === "SAURABH SHANTARAM DANGALE";
        const hasDeadline = s.mechRemarks.toLowerCase().includes("issued by") || s.mechRemarks.toLowerCase().includes("due");
        
        if (isSaurabh) tr.classList.add("row-saurabh");
        if (hasDeadline) tr.classList.add("row-urgent");

        // Status Badge class mapping
        let statusClass = "badge-blue";
        if (s.sampleStatus === "Forwarded For Testing") statusClass = "badge-blue";
        else if (s.sampleStatus === "Testing in Progress") statusClass = "badge-violet";
        else if (s.sampleStatus === "Accepted By Sample Cell") statusClass = "badge-rose";
        else if (s.sampleStatus === "Testing Completed") statusClass = "badge-emerald";

        let reportClass = "badge-rose";
        if (s.reportStatus === "Not Sent") reportClass = "badge-rose";
        else if (s.reportStatus === "Partial Report Issued") reportClass = "badge-amber";

        // Stacked encodes mapping
        let encodeHtml = `<div class="encode-stack">`;
        if (s.encode1) encodeHtml += `<span class="encode-pill mech">${s.encode1}</span>`;
        if (s.encode2) encodeHtml += `<span class="encode-pill chem">${s.encode2}</span>`;
        if (s.encode3) encodeHtml += `<span class="encode-pill">${s.encode3}</span>`;
        encodeHtml += `</div>`;

        let actionsHtml = '';
        if (activeListTab === 'pending') {
            actionsHtml = `<button onclick="markAsSubmitted('${s.encode1}')" style="background:#10b981; color:white; border:none; padding:4px 8px; border-radius:4px; cursor:pointer; font-size:0.75rem; box-shadow: 0 1px 2px rgba(0,0,0,0.1); transition: all 0.2s;">Submit</button>`;
        } else {
            actionsHtml = `<button onclick="unmarkAsSubmitted('${s.encode1}')" style="background:#f59e0b; color:white; border:none; padding:4px 8px; border-radius:4px; cursor:pointer; font-size:0.75rem; box-shadow: 0 1px 2px rgba(0,0,0,0.1); transition: all 0.2s;">Revert</button>`;
        }

        tr.innerHTML = `
            <td style="font-weight: 600;">${s.sNo}</td>
            <td>${encodeHtml}</td>
            <td style="font-family: monospace; font-size: 0.82rem;">${s.isNumber || '—'}</td>
            <td>${s.receivedOn}</td>
            <td><span class="badge ${statusClass}">${s.sampleStatus}</span></td>
            <td><span class="badge ${reportClass}">${s.reportStatus}</span></td>
            <td style="font-size: 0.85rem; color: ${hasDeadline ? 'var(--accent-rose)' : 'var(--text-secondary)'}; font-weight: ${hasDeadline ? '500' : '400'};">${s.mechRemarks || '—'}</td>
            <td style="font-weight: ${isSaurabh ? '600' : '400'}; color: ${isSaurabh ? 'var(--primary)' : ''}">${s.tpName || '<span style="color:var(--text-muted);">Unassigned</span>'}</td>
            <td style="text-align:center;">${actionsHtml}</td>
        `;

        tbody.appendChild(tr);
    });
}

function changePage(direction) {
    currentPage += direction;
    renderTable();
}

// ----------------------------------------------------
// Excel File Upload & Parser Integration
// ----------------------------------------------------
function initializeDragAndDrop() {
    const dropZone = document.getElementById("drop-zone");
    const fileInput = document.getElementById("file-input");

    // Click trigger
    dropZone.addEventListener("click", () => fileInput.click());

    // Browse change trigger
    fileInput.addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (file) handleFile(file);
    });

    // Drag-over styling hooks
    dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropZone.classList.add("dragover");
    });

    ["dragleave", "dragend"].forEach(type => {
        dropZone.addEventListener(type, () => {
            dropZone.classList.remove("dragover");
        });
    });

    dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZone.classList.remove("dragover");
        const file = e.dataTransfer.files[0];
        if (file) handleFile(file);
    });
}

function excelDateToString(excelDate) {
    if (!excelDate) return "";
    if (isNaN(excelDate)) return excelDate.toString().trim();
    
    try {
        const dateNum = parseFloat(excelDate);
        // JS Date base is 1970-01-01, Excel is 1899-12-30. Diff is 25569 days.
        const date = new Date((dateNum - 25569) * 86400 * 1000);
        
        const dd = String(date.getDate()).padStart(2, '0');
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const yyyy = date.getFullYear();
        
        return `${dd}-${mm}-${yyyy}`;
    } catch (e) {
        return excelDate.toString();
    }
}

function handleFile(file) {
    const reader = new FileReader();
    
    // Speaks console loading feedback
    const box = document.getElementById("nlp-response-box");
    const textEl = document.getElementById("nlp-response-text");
    box.classList.add("active");
    textEl.innerHTML = `⚙️ Processing Excel file: <strong>${file.name}</strong>...`;

    reader.onload = (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: "array" });
            const firstSheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[firstSheetName];
            
            // Read rows as raw matrices
            const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
            if (rows.length < 2) {
                throw new Error("Worksheet has no data records.");
            }

            // Headers mapping
            const headerRow = rows[0];
            
            const newSamples = [];
            for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                if (!row || row.length === 0 || !row[0]) continue; // Skip blank rows
                
                // Map columns: A:S.No, B:Encode1, C:Encode2, D:Encode3, E:IS Number, F:ReceivedOn, G:SampleStatus, H:ReportStatus, I:MechRemarks, J:TPName
                const sNo = row[0];
                const sample = {
                    sNo: typeof sNo === "number" ? sNo : parseInt(sNo) || i,
                    encode1: (row[1] || "").toString().trim(),
                    encode2: (row[2] || "").toString().trim(),
                    encode3: (row[3] || "").toString().trim(),
                    isNumber: (row[4] || "").toString().trim(),
                    receivedOn: excelDateToString(row[5]),
                    sampleStatus: (row[6] || "").toString().trim(),
                    reportStatus: (row[7] || "").toString().trim(),
                    mechRemarks: (row[8] || "").toString().trim(),
                    tpName: (row[9] || "").toString().trim()
                };
                newSamples.append ? newSamples.append(sample) : newSamples.push(sample);
            }

            if (newSamples.length === 0) {
                throw new Error("Could not parse any valid records from the Excel file structure.");
            }

            // Update State
            samples = newSamples;
            
            // Update UI indicators
            document.getElementById("data-status-text").textContent = `Custom Excel Loaded: ${file.name} (${samples.length} Records)`;
            document.getElementById("data-status-text").style.color = "var(--accent-emerald)";

            // Update dropdown values dynamically
            populateFilterDropdowns();

            // Reset filters to load fresh
            resetAllFilters(false);
            applyFilters();

            // Success conversational feedback
            textEl.innerHTML = `🎉 Successfully imported Excel sheet! Loaded **${samples.length}** sample records from **${file.name}**.`;

        } catch (error) {
            console.error("Excel import failed:", error);
            textEl.innerHTML = `❌ Excel Import Failed! Please ensure the file has columns in the order: S.No, Encodes (1-3), IS Number, Received Date, Sample Status, Report Status, Remarks, and Tester.`;
        }
    };

    reader.readAsArrayBuffer(file);
}

// ----------------------------------------------------
// CSV Exporter Core
// ----------------------------------------------------
function exportFilteredToCSV() {
    if (filteredSamples.length === 0) {
        alert("The active filtered list is empty. Nothing to export!");
        return;
    }

    // Headers row
    const headers = ["S.No.", "Encode 1", "Encode 2", "Encode 3", "IS Number", "Sample Received On", "Sample Status", "Report Status", "Mech Remarks", "TP NAME"];
    
    // Convert records to rows
    const csvRows = [headers.join(",")];
    
    filteredSamples.forEach(s => {
        const row = [
            s.sNo,
            `"${(s.encode1 || '').replace(/"/g, '""')}"`,
            `"${(s.encode2 || '').replace(/"/g, '""')}"`,
            `"${(s.encode3 || '').replace(/"/g, '""')}"`,
            `"${(s.isNumber || '').replace(/"/g, '""')}"`,
            s.receivedOn,
            `"${(s.sampleStatus || '').replace(/"/g, '""')}"`,
            `"${(s.reportStatus || '').replace(/"/g, '""')}"`,
            `"${(s.mechRemarks || '').replace(/"/g, '""')}"`,
            `"${(s.tpName || '').replace(/"/g, '""')}"`
        ];
        csvRows.push(row.join(","));
    });

    const csvContent = csvRows.join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement("a");
    link.setAttribute("href", url);
    
    // Generate clean date string
    const dateStr = new Date().toISOString().slice(0,10);
    link.setAttribute("download", `Sample_Speaks_Report_${dateStr}.csv`);
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}
