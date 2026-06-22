const fs = require('fs');

const indexPath = '/Users/saurabh/Desktop/Antigravity/SampleSpeaks_MacTransfer/public/index.html';
let html = fs.readFileSync(indexPath, 'utf-8');

// 1. Remove the tab button
html = html.replace(/<button id="tab-btn-upload" class="tab-btn" onclick="switchTab\('tab-upload'\)">📤 Upload Center<\/button>/, '<!-- Upload Center merged -->');

// 2. Extract the content of tab-upload
const startMarker = '<!-- Tab: Upload Center -->\n        <div id="tab-upload" class="tab-content">';
const startIndex = html.indexOf(startMarker);
if (startIndex === -1) throw new Error("Could not find start of tab-upload");

// Find the closing div of tab-upload. 
// It ends right before `<!-- Tab: LIMS Automator -->`
const endMarker = '        <!-- Tab: LIMS Automator -->';
const endIndex = html.indexOf(endMarker);
if (endIndex === -1) throw new Error("Could not find end of tab-upload");

// The extracted content is between startIndex and endIndex
const uploadContent = html.substring(startIndex, endIndex);

// Remove the old tab-upload from the html
html = html.substring(0, startIndex) + html.substring(endIndex);

// Wrap the extracted content (minus the `<div id="tab-upload" class="tab-content">` wrapper)
// Wait, the extracted content includes the start marker which has `<div id="tab-upload" class="tab-content">`.
// Let's strip the start marker and its closing tag.
let innerContent = uploadContent.replace(startMarker, '');
// Remove the last `</div>` from innerContent
innerContent = innerContent.trimRight();
if (innerContent.endsWith('</div>')) {
    innerContent = innerContent.substring(0, innerContent.lastIndexOf('</div>'));
}

const mergedSection = `
        <!-- Merged Upload Center Section (Visible to Admins Only) -->
        <div id="admin-upload-section">
            ${innerContent}
        </div>
`;

// Insert into tab-pendancy right before its closing tag
// Find the end of tab-pendancy, which is `</div> <!-- End tab-dashboard -->` according to the earlier check, 
// wait, the closing tags were:
//             </div>
//         </div>
//         </div> <!-- End tab-dashboard -->
const pendancyEndMarker = '        </div> <!-- End tab-dashboard -->';
const pendancyEndIndex = html.indexOf(pendancyEndMarker);

if (pendancyEndIndex !== -1) {
    // Insert before the last closing div of tab-pendancy
    const insertPos = html.lastIndexOf('</div>', pendancyEndIndex - 1);
    
    html = html.substring(0, insertPos) + mergedSection + '\n        ' + html.substring(insertPos);
} else {
    throw new Error("Could not find end of tab-pendancy");
}

fs.writeFileSync(indexPath, html);
console.log("index.html updated successfully");

const appPath = '/Users/saurabh/Desktop/Antigravity/SampleSpeaks_MacTransfer/public/app.js';
let appJs = fs.readFileSync(appPath, 'utf-8');

appJs = appJs.replace(
    /const uploadBtn = document\.getElementById\('tab-btn-upload'\);\s+if \(uploadBtn\) uploadBtn\.style\.display = isAdmin \? 'inline-block' : 'none';/,
    `const adminUploadSection = document.getElementById('admin-upload-section');
    if (adminUploadSection) adminUploadSection.style.display = isAdmin ? 'block' : 'none';`
);

fs.writeFileSync(appPath, appJs);
console.log("app.js updated successfully");
