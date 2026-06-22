const fs = require('fs');
const htmlPath = '/Users/saurabh/Desktop/Antigravity/SampleSpeaks_MacTransfer/public/index.html';
let html = fs.readFileSync(htmlPath, 'utf-8');

const missingCSS = `
    .quick-action-btn {
        background: #ffffff !important;
        border: 1px solid #e2e8f0 !important;
        padding: 24px !important;
        border-radius: 16px !important;
        box-shadow: 0 4px 10px rgba(0,0,0,0.04) !important;
        display: flex !important;
        flex-direction: column !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 12px !important;
        cursor: pointer !important;
        transition: all 0.2s ease !important;
        color: #0f172a !important;
        font-weight: 600 !important;
        text-align: center !important;
    }
    .quick-action-btn:hover {
        transform: translateY(-4px) !important;
        box-shadow: 0 12px 20px rgba(0,0,0,0.08) !important;
        border-color: #cbd5e1 !important;
        color: #2563eb !important;
    }
    .quick-action-btn span {
        font-size: 2.2rem !important;
        margin-bottom: 4px !important;
    }
    .glass-panel {
        background: #ffffff !important;
        border-radius: 12px !important;
        border: 1px solid #e2e8f0 !important;
        box-shadow: 0 4px 12px rgba(0,0,0,0.03) !important;
    }
`;

if (html.includes('id="premium-layout-style"')) {
    html = html.replace('</style>', missingCSS + '\n</style>');
    fs.writeFileSync(htmlPath, html);
    console.log("Quick Action styles injected.");
}
