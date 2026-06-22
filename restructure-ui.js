const fs = require('fs');

const cssPath = '/Users/saurabh/Desktop/Antigravity/SampleSpeaks_MacTransfer/public/style.css';
let css = fs.readFileSync(cssPath, 'utf-8');

const htmlPath = '/Users/saurabh/Desktop/Antigravity/SampleSpeaks_MacTransfer/public/index.html';
let html = fs.readFileSync(htmlPath, 'utf-8');

// Update CSS
if (!css.includes('.main-app-layout')) {
    css += `
/* Sidebar Navigation Layout */
.main-app-layout {
    display: flex;
    flex-direction: row;
    height: calc(100vh - 80px); /* Adjust based on header */
    overflow: hidden;
}

.sidebar-nav {
    width: 260px;
    background: rgba(255, 255, 255, 0.85);
    backdrop-filter: blur(12px);
    border-right: 1px solid #e2e8f0;
    display: flex;
    flex-direction: column;
    padding: 20px 0;
    overflow-y: auto;
    z-index: 100;
}

.sidebar-section {
    margin-bottom: 20px;
}

.sidebar-heading {
    padding: 0 20px;
    font-size: 0.75rem;
    font-weight: 800;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 10px;
}

.sidebar-nav .tab-btn {
    background: transparent;
    border: none;
    padding: 12px 20px;
    width: 100%;
    text-align: left;
    font-size: 0.95rem;
    font-weight: 600;
    color: #475569;
    cursor: pointer;
    transition: all 0.2s ease;
    border-left: 3px solid transparent;
    display: flex;
    align-items: center;
    gap: 10px;
}

.sidebar-nav .tab-btn:hover {
    background: #f1f5f9;
    color: #0f172a;
}

.sidebar-nav .tab-btn.active {
    background: #eff6ff;
    color: #2563eb;
    border-left: 3px solid #3b82f6;
    font-weight: 700;
}

.content-area {
    flex: 1;
    overflow-y: auto;
    padding: 24px;
    background: #f8fafc;
}

/* Hide original tabs container to be safe */
.tabs-container {
    display: none !important;
}

/* Quick Action Buttons */
.quick-action-btn {
    background: white;
    border: 1px solid #e2e8f0;
    padding: 15px 20px;
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    cursor: pointer;
    transition: all 0.2s ease;
    box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);
    color: #0f172a;
    font-weight: 600;
}
.quick-action-btn:hover {
    transform: translateY(-2px);
    box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1);
    border-color: #cbd5e1;
}
.quick-action-btn span {
    font-size: 1.5rem;
}
`;
    fs.writeFileSync(cssPath, css);
}

// Extract the charts from the old Analytics tabs
const workloadChartMatch = html.match(/<canvas id="workloadChart"[^>]*><\/canvas>/);
const dueDateChartMatch = html.match(/<canvas id="dueDateChart"[^>]*><\/canvas>/);
const isVolumeChartMatch = html.match(/<canvas id="isVolumeChart"[^>]*><\/canvas>/);

const workloadChartHtml = workloadChartMatch ? workloadChartMatch[0] : '<canvas id="workloadChart"></canvas>';
const dueDateChartHtml = dueDateChartMatch ? dueDateChartMatch[0] : '<canvas id="dueDateChart"></canvas>';
const isVolumeChartHtml = isVolumeChartMatch ? isVolumeChartMatch[0] : '<canvas id="isVolumeChart"></canvas>';

// New Dashboard HTML
const newDashboardHtml = `
<div id="tab-dashboard" class="tab-content active">
    <!-- Quick Actions Row -->
    <div style="margin-bottom: 24px;">
        <h3 style="margin-top: 0; margin-bottom: 15px; color: #0f172a;">Quick Actions</h3>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px;">
            <div class="quick-action-btn" onclick="switchTab('tab-upload')">
                <span>📤</span>
                Upload Excel Sheet
            </div>
            <div class="quick-action-btn" onclick="switchTab('tab-assigner')">
                <span>✨</span>
                Run Auto Assigner
            </div>
            <div class="quick-action-btn" onclick="switchTab('tab-lims')">
                <span>🤖</span>
                Push to LIMS
            </div>
        </div>
    </div>
    
    <!-- Charts Row -->
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px;">
        <div class="glass-panel" style="padding: 20px;">
            <h3 style="margin-top: 0; color: var(--text-main); margin-bottom: 15px;">Workload Distribution</h3>
            \${workloadChartHtml}
        </div>
        <div class="glass-panel" style="padding: 20px;">
            <h3 style="margin-top: 0; color: var(--text-main); margin-bottom: 15px;">Due Date Urgency</h3>
            \${dueDateChartHtml}
        </div>
        <div class="glass-panel" style="padding: 20px; grid-column: 1 / -1;">
            <h3 style="margin-top: 0; color: var(--text-main); margin-bottom: 15px;">IS Volume Breakdown</h3>
            \${isVolumeChartHtml}
        </div>
    </div>
</div>
`;

// Replace tab-dashboard with tab-pendancy
if (!html.includes('id="tab-pendancy"')) {
    html = html.replace('id="tab-dashboard"', 'id="tab-pendancy"');
}

// Remove the old tab-analytics and tab-super-admin
html = html.replace(/<div id="tab-analytics"[\s\S]*?<!-- Tab: (Dashboard|Pendancy) -->/, '<!-- Tab: Pendancy -->');
html = html.replace(/<div id="tab-super-admin"[\s\S]*?<\/div>\s*<\/div>\s*<!-- End tabs -->/g, '</div>\n        <!-- End tabs -->');

// Build the new sidebar and content layout wrapper
const newStructureRegex = /<div id="admin-tabs"[\s\S]*?<!-- Profile Modal -->/;
const newStructureHtml = `
        <div class="main-app-layout">
            <nav id="sidebar-nav" class="sidebar-nav" style="display: none;">
                <div class="sidebar-section">
                    <div class="sidebar-heading">Operations</div>
                    <button class="tab-btn active" onclick="switchTab('tab-dashboard')">📊 Dashboard</button>
                    <button id="tab-btn-pendancy" class="tab-btn" onclick="switchTab('tab-pendancy')">⏳ Pendancy</button>
                    <button id="tab-btn-assigner" class="tab-btn" onclick="switchTab('tab-assigner')">✨ Auto Assigner</button>
                    <button id="tab-btn-lims" class="tab-btn" onclick="switchTab('tab-lims')">🤖 LIMS Automator</button>
                    <button id="tab-btn-upload" class="tab-btn" onclick="switchTab('tab-upload')">📤 Upload Center</button>
                </div>
                <div class="sidebar-section">
                    <div class="sidebar-heading">Administration</div>
                    <button id="tab-btn-employees" class="tab-btn" onclick="switchTab('tab-employees')">👥 Employee Hub</button>
                    <button id="tab-btn-is-intelligence" class="tab-btn" onclick="switchTab('tab-is-intelligence')">📚 IS Intelligence</button>
                    <button id="tab-btn-preferences" class="tab-btn" onclick="switchTab('tab-preferences')">⚙️ Preferences</button>
                </div>
            </nav>
            <main class="content-area">
                \${newDashboardHtml}
        <!-- Profile Modal -->`;

html = html.replace(newStructureRegex, newStructureHtml);
html = html.replace(/<\/div>\s*<!-- End Dashboard Container -->/, '        </main>\n        </div>\n    </div>\n    <!-- End Dashboard Container -->');

fs.writeFileSync(htmlPath, html);
console.log("UI HTML and CSS restructured successfully");
