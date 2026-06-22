const fs = require('fs');
let html = fs.readFileSync('public/index.html', 'utf8');

// The new CSS for the login screen
const loginCss = `
    /* New Split Login Layout */
    #auth-container {
        display: none;
    }
    #auth-container.active {
        display: flex !important;
        width: 100vw !important;
        height: 100vh !important;
        max-width: 100% !important;
        margin: 0 !important;
        padding: 0 !important;
        border: none !important;
        border-radius: 0 !important;
        box-shadow: none !important;
        background: #ffffff !important;
        position: fixed;
        top: 0;
        left: 0;
        z-index: 99999;
    }
    
    .login-left-panel {
        flex: 1;
        background: #2b5ba4;
        border-radius: 0 50% 50% 0 / 0 100% 100% 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        color: white;
        text-align: center;
        position: relative;
        overflow: hidden;
        margin-right: 50px;
    }

    .login-logo-circle {
        background: white;
        border-radius: 50%;
        width: 120px;
        height: 120px;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 20px;
        box-shadow: 0 10px 25px rgba(0,0,0,0.1);
    }
    
    .login-logo-circle svg {
        width: 80px;
        height: 80px;
    }

    .login-left-text h1 {
        font-size: 24px;
        font-weight: 700;
        margin-bottom: 10px;
        letter-spacing: 0.5px;
    }

    .login-left-text p {
        font-size: 15px;
        line-height: 1.5;
        font-weight: 400;
        opacity: 0.9;
        max-width: 300px;
        margin: 0 auto;
    }

    .login-right-panel {
        flex: 1;
        display: flex;
        flex-direction: column;
        justify-content: center;
        padding: 0 10%;
        max-width: 600px;
    }

    .login-form-container {
        width: 100%;
        max-width: 400px;
    }

    .login-form-container h2 {
        font-size: 26px;
        color: #333;
        margin-bottom: 5px;
        text-align: center;
    }

    .login-form-container > p {
        font-size: 11px;
        color: #666;
        margin-bottom: 20px;
    }

    .login-input-group {
        margin-bottom: 15px;
    }

    .login-input-group label {
        display: block;
        font-size: 12px;
        color: #555;
        margin-bottom: 5px;
    }
    
    .login-input-group label span {
        color: red;
    }

    .login-input-group input {
        width: 100%;
        padding: 12px 15px;
        background: #f3f4f6;
        border: none;
        border-radius: 4px;
        font-size: 14px;
        color: #333;
        outline: none;
    }
    
    .captcha-row {
        display: flex;
        gap: 10px;
        align-items: center;
    }
    
    .captcha-image-box {
        background: #f3f4f6;
        padding: 8px 15px;
        font-family: monospace;
        font-size: 18px;
        letter-spacing: 4px;
        font-weight: bold;
        color: #333;
        text-decoration: line-through;
        border-radius: 4px;
        user-select: none;
    }

    .login-action-row {
        display: flex;
        align-items: center;
        gap: 15px;
        margin-top: 20px;
        margin-bottom: 30px;
    }

    .btn-login-main {
        background: #2b5ba4;
        color: white;
        border: none;
        padding: 10px 40px;
        border-radius: 30px;
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.2s;
    }
    
    .btn-login-main:hover {
        background: #1e3a8a;
    }

    .login-links {
        font-size: 12px;
        color: #2b5ba4;
        text-decoration: none;
    }

    .login-footer-links {
        display: flex;
        gap: 20px;
        font-size: 12px;
    }
    
    .login-footer-links a {
        color: #2b5ba4;
        text-decoration: none;
    }
    
    /* Welcome Banner on Dashboard */
    .dashboard-welcome-banner {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        margin-bottom: 40px;
        padding: 30px 0;
        background: #ffffff;
        border-radius: 12px;
        box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    
    .dashboard-welcome-banner img {
        height: 220px;
        margin-bottom: 20px;
    }
    
    .dashboard-welcome-banner h2 {
        font-size: 22px;
        color: #4b5563;
        font-weight: 600;
        margin: 0;
    }
`;

// Insert the new CSS right before </style>
html = html.replace('</style>', loginCss + '\n</style>');

// Build the new HTML for auth container
const newAuthHtml = `
    <!-- Auth Container (Split Layout) -->
    <div id="auth-container" class="auth-wrapper active">
        <div class="login-left-panel">
            <div class="login-logo-circle">
                <svg viewBox="0 0 100 100" width="100%" height="100%">
                    <circle cx="50" cy="50" r="45" fill="white" stroke="#2b5ba4" stroke-width="2"/>
                    <polygon points="50,15 85,80 15,80" fill="none" stroke="#2b5ba4" stroke-width="4"/>
                    <circle cx="50" cy="65" r="8" fill="red"/>
                </svg>
            </div>
            <div class="login-left-text">
                <h1>Welcome to the</h1>
                <p>Laboratory Information Management System of<br>BIS</p>
            </div>
        </div>
        
        <div class="login-right-panel">
            <div class="login-form-container">
                <h2>Login</h2>
                <p>Please login with your Email and Password.</p>
                
                <div class="login-input-group">
                    <label>User Name <span>*</span></label>
                    <input type="text" id="username" placeholder="">
                </div>
                
                <div class="login-input-group">
                    <label>Password <span>*</span></label>
                    <input type="password" id="password" placeholder="">
                </div>
                
                <div class="login-input-group">
                    <label>Captcha <span>*</span></label>
                    <div class="captcha-row">
                        <div class="captcha-image-box">YKIARE</div>
                        <input type="text" style="flex: 1;" placeholder="">
                        <i class="fas fa-sync-alt" style="cursor: pointer; color: #555;"></i>
                    </div>
                </div>
                
                <div class="login-action-row">
                    <button class="btn-login-main" onclick="login()">Login</button>
                    <a href="javascript:void(0)" class="login-links">Forgot password?</a>
                </div>
                
                <div class="login-footer-links">
                    <a href="javascript:void(0)" onclick="register()">New Lab/Register Now</a>
                    <a href="javascript:void(0)">New Auditor/Register Now</a>
                </div>
            </div>
        </div>
    </div>
`;

// Replace the old auth container
const oldAuthRegex = /<!-- Auth Container -->\s*<div id="auth-container" class="auth-wrapper active glass-panel">[\s\S]*?<\/div>\s*<\/div>/;
html = html.replace(oldAuthRegex, newAuthHtml);

// Build the welcome banner for the dashboard
const welcomeBannerHtml = `
                <!-- Dashboard Welcome Banner -->
                <div class="dashboard-welcome-banner">
                    <img src="images/welcome-banner.png" alt="Welcome Illustration">
                    <h2 id="dashboard-welcome-text">Hello User</h2>
                </div>
`;

// Insert the welcome banner at the top of tab-dashboard
html = html.replace('<div id="tab-dashboard" class="tab-content active">', '<div id="tab-dashboard" class="tab-content active">\n' + welcomeBannerHtml);

fs.writeFileSync('public/index.html', html);
console.log("Updated login screen and welcome banner successfully!");
