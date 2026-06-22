const fs = require('fs');
const htmlPath = '/Users/saurabh/Desktop/Antigravity/SampleSpeaks_MacTransfer/public/index.html';
let html = fs.readFileSync(htmlPath, 'utf-8');

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
            <canvas id="workloadChart"></canvas>
        </div>
        <div class="glass-panel" style="padding: 20px;">
            <h3 style="margin-top: 0; color: var(--text-main); margin-bottom: 15px;">SLA Compliance</h3>
            <canvas id="slaChart"></canvas>
        </div>
        <div class="glass-panel" style="padding: 20px; grid-column: 1 / -1;">
            <h3 style="margin-top: 0; color: var(--text-main); margin-bottom: 15px;">IS Volume Breakdown</h3>
            <canvas id="isVolumeChart"></canvas>
        </div>
    </div>
</div>
`;

html = html.replace('${newDashboardHtml}', newDashboardHtml);

fs.writeFileSync(htmlPath, html);
console.log("Fixed literal string replacement in index.html");
