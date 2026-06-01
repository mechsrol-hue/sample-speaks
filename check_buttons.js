const fs = require('fs');

const indexHtml = fs.readFileSync('public/index.html', 'utf8');
const appJs = fs.readFileSync('public/app.js', 'utf8');

const onclickRegex = /onclick="([a-zA-Z0-9_]+)\(/g;
const htmlFunctions = new Set();
let match;
while ((match = onclickRegex.exec(indexHtml)) !== null) {
    htmlFunctions.add(match[1]);
}

const functionRegex = /async function ([a-zA-Z0-9_]+)\(|function ([a-zA-Z0-9_]+)\(/g;
const jsFunctions = new Set();
while ((match = functionRegex.exec(appJs)) !== null) {
    jsFunctions.add(match[1] || match[2]);
}

// Special case: Some functions might be globally defined in window or just native JS (like alert, confirm).
// Also check specs_db.js if any function is there.
const specsJs = fs.readFileSync('public/specs_db.js', 'utf8');
while ((match = functionRegex.exec(specsJs)) !== null) {
    jsFunctions.add(match[1] || match[2]);
}

console.log("Functions used in HTML but not defined in JS:");
let missing = false;
for (let fn of htmlFunctions) {
    if (!jsFunctions.has(fn)) {
        // Exclude native JS
        if (!['alert', 'console.log', 'confirm', 'javascript', 'location.reload', 'window.open', 'document.getElementById'].includes(fn)) {
            console.log("Missing function:", fn);
            missing = true;
        }
    }
}
if (!missing) console.log("All HTML onclick functions are correctly wired to JS functions!");
