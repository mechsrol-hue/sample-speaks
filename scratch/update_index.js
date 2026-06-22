const fs = require('fs');

const demoHtml = fs.readFileSync('public/demo_dashboard.html', 'utf8');
let indexHtml = fs.readFileSync('public/index.html', 'utf8');

// 1. Extract CSS from demo
const demoStyleMatch = demoHtml.match(/<style>([\s\S]*?)<\/style>/);
if (demoStyleMatch) {
    let demoStyle = demoStyleMatch[1];
    
    // We need to keep auth-wrapper and toast-container styles
    const extraStyles = `
        /* Auth screen */
        .auth-wrapper { display: none; }
        .auth-wrapper.active {
            display: block !important;
            max-width: 440px !important;
            margin: 12vh auto !important;
        }
        
        .glass-panel {
            background: #ffffff !important;
            border-radius: 12px !important;
            border: 1px solid #e2e8f0 !important;
            box-shadow: 0 2px 8px rgba(0,0,0,0.04) !important;
            padding: 24px;
        }

        #profile-modal { z-index: 9999 !important; }
        
        /* Toast */
        #toast-container {
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 10000;
        }

        .tab-content { display: none; }
        .tab-content.active { display: block; }
    `;
    
    demoStyle += extraStyles;
    
    // Replace premium-layout-style in index.html
    indexHtml = indexHtml.replace(/<style id="premium-layout-style">[\s\S]*?<\/style>/, `<style id="premium-layout-style">\n${demoStyle}\n</style>`);
}

// 2. Build the new Dashboard Container HTML
const headerHtml = demoHtml.match(/<!-- Header -->([\s\S]*?)<!-- Sidebar -->/)[1].trim();
const sidebarHtml = demoHtml.match(/<!-- Sidebar -->([\s\S]*?)<!-- Main Content -->/)[1].trim();

// Update Sidebar links
let newSidebar = sidebarHtml
    .replace('id="nav-dashboard"', 'id="nav-dashboard" onclick="switchTab(\'tab-dashboard\')"')
    .replace('id="nav-sample-allotted"', 'id="nav-sample-allotted" onclick="switchTab(\'tab-pendancy\')"')
    .replace('<a href="#" class="sub-nav-item">Verify Test Results</a>', '<a href="#" class="sub-nav-item" onclick="switchTab(\'tab-assigner\')">Auto Assigner</a>\n            <a href="#" class="sub-nav-item" onclick="showComingSoon()">Verify Test Results</a>');

// Replace all other links with showComingSoon()
newSidebar = newSidebar.replace(/<a href="#" class="(nav-item|sub-nav-item)"(?! id| onclick)([^>]*)>/g, '<a href="#" class="$1" onclick="showComingSoon()"$2>');
// And for toggle-menu, don't show coming soon, they just toggle
newSidebar = newSidebar.replace(/onclick="showComingSoon\(\)"([^>]*) toggle-menu"/g, 'class="nav-item toggle-menu"'); // revert

// Extract views from demo
const viewDashboard = demoHtml.match(/<div id="view-dashboard"[\s\S]*?<!-- Sample Allotted Table View -->/)[0].replace('<!-- Sample Allotted Table View -->', '').trim();
const viewSampleAllotted = demoHtml.match(/<!-- Sample Allotted Table View -->([\s\S]*?)<\/main>/)[1].trim();

// Now build the structure
const newStructure = `
    <!-- Dashboard Container -->
    <div id="dashboard-container" style="display: none;">
        ${headerHtml}
        
        ${newSidebar}

        <main class="main-content">
            <div id="tab-dashboard" class="tab-content active">
                ${viewDashboard}
            </div>
            
            <div id="tab-pendancy" class="tab-content">
                ${viewSampleAllotted}
            </div>

            <!-- Existing other tabs -->
            <div id="tab-assigner" class="tab-content">
                <h2>Auto Assigner</h2>
                <div id="auto-assigner-root"></div>
            </div>
            
            <!-- Other modals/components will remain below -->
`;

// Find where dashboard-container starts and replace up to end of content-area
const startIndex = indexHtml.indexOf('<!-- Dashboard Container -->');
const endIndex = indexHtml.indexOf('<div id="tab-assigner"');

if (startIndex !== -1 && endIndex !== -1) {
    const originalTabs = indexHtml.substring(indexHtml.indexOf('<div id="tab-assigner"'), indexHtml.indexOf('<!-- Modals -->'));
    
    const replacement = `
    <!-- Dashboard Container -->
    <div id="dashboard-container" style="display: none; height: 100vh; width: 100vw;">
        ${headerHtml.replace('id="header-avatar"', 'id="header-avatar" onclick="openProfileModal()"').replace('nirajmahato@bis.gov.in', '<span id="header-user-email">nirajmahato@bis.gov.in</span>')}
        
        ${newSidebar}

        <main class="main-content">
            <div id="tab-dashboard" class="tab-content active">
                ${viewDashboard}
            </div>
            
            <div id="tab-pendancy" class="tab-content">
                ${viewSampleAllotted}
            </div>

            ${originalTabs}
        </main>
    </div>
    <!-- Modals -->
    `;
    
    // Fix header upload button inside viewSampleAllotted
    const uploadBtnHtml = `<button id="global-upload-btn" onclick="openModal('upload-center-modal')" style="background: #3b82f6; color: white; padding: 6px 12px; border: none; border-radius: 4px; font-weight: 600; cursor: pointer; display: flex; align-items: center; gap: 5px; font-size: 13px;">☁️ Upload LIMS Data</button>`;
    
    // We replace indexHtml part
    const beforeDash = indexHtml.substring(0, startIndex);
    const afterModals = indexHtml.substring(indexHtml.indexOf('<!-- Modals -->'));
    
    let finalHtml = beforeDash + replacement + afterModals;
    
    // Insert the upload button in tab-pendancy page-header
    finalHtml = finalHtml.replace('<div class="header-actions">', '<div class="header-actions" style="display:flex; gap:10px; align-items:center;">\n                    ' + uploadBtnHtml);
    
    fs.writeFileSync('public/index.html', finalHtml);
    console.log("Updated index.html successfully!");
} else {
    console.log("Could not find start/end indexes.");
}
