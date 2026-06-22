const fs = require('fs');

const htmlPath = '/Users/saurabh/Desktop/Antigravity/SampleSpeaks_MacTransfer/public/index.html';
let html = fs.readFileSync(htmlPath, 'utf-8');

// The most foolproof way to fix the layout: Inline the critical layout CSS directly in the HTML <head>
// to ensure it overrides everything and bypasses any caching/syntax issues in style.css

const foolproofCSS = `
<style id="premium-layout-style">
    body {
        margin: 0 !important;
        padding: 0 !important;
        background-color: #f8fafc !important;
        height: 100vh !important;
        overflow: hidden !important;
    }
    
    #dashboard-container.active {
        display: flex !important;
        flex-direction: row !important;
        height: 100vh !important;
        width: 100vw !important;
        max-width: none !important;
        margin: 0 !important;
        padding: 0 !important;
    }
    
    .sidebar-nav {
        width: 260px !important;
        background: #ffffff !important;
        border-right: 1px solid #e2e8f0 !important;
        display: flex !important;
        flex-direction: column !important;
        padding: 24px 0 !important;
        height: 100vh !important;
        z-index: 100 !important;
    }
    
    .sidebar-nav[style*="display: none"] {
        display: none !important;
    }
    
    .sidebar-section {
        display: flex !important;
        flex-direction: column !important;
        margin-bottom: 24px !important;
    }
    
    .sidebar-heading {
        padding: 0 24px !important;
        font-size: 0.75rem !important;
        font-weight: 700 !important;
        color: #94a3b8 !important;
        text-transform: uppercase !important;
        letter-spacing: 1.5px !important;
        margin-bottom: 12px !important;
    }
    
    .sidebar-nav .tab-btn {
        padding: 12px 24px !important;
        margin: 4px 16px !important;
        width: auto !important;
        border-radius: 8px !important;
        font-size: 0.95rem !important;
        color: #475569 !important;
        font-weight: 500 !important;
        text-align: left !important;
        border: none !important;
        background: transparent !important;
    }
    
    .sidebar-nav .tab-btn.active {
        background: #eff6ff !important;
        color: #2563eb !important;
        font-weight: 600 !important;
    }
    
    .app-right-wrapper {
        flex: 1 !important;
        display: flex !important;
        flex-direction: column !important;
        height: 100vh !important;
        overflow: hidden !important;
        background: #f8fafc !important;
    }
    
    .app-header {
        height: 70px !important;
        background: #ffffff !important;
        border-bottom: 1px solid #e2e8f0 !important;
        display: flex !important;
        justify-content: space-between !important;
        align-items: center !important;
        padding: 0 32px !important;
        margin-bottom: 0 !important;
    }
    
    .content-area {
        flex: 1 !important;
        overflow-y: auto !important;
        padding: 32px !important;
    }
    
    .auth-wrapper {
        display: none;
    }
    .auth-wrapper.active {
        display: block !important;
        max-width: 440px !important;
        margin: 12vh auto !important;
        background: #ffffff !important;
        padding: 40px !important;
        border-radius: 16px !important;
        box-shadow: 0 10px 25px rgba(0,0,0,0.1) !important;
        position: relative !important;
        z-index: 1000 !important;
    }
    
    #profile-modal {
        z-index: 9999 !important;
    }
</style>
`;

if (!html.includes('id="premium-layout-style"')) {
    html = html.replace('</head>', foolproofCSS + '\n</head>');
    fs.writeFileSync(htmlPath, html);
    console.log("Foolproof layout CSS injected directly into HTML head.");
} else {
    console.log("Already injected.");
}

