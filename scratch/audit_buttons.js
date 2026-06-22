// Static button / wiring audit:
//  (A) every inline handler (onclick/onchange/oninput/onsubmit) -> is the JS function defined?
//  (B) every fetch('/api/...') URL -> is there a matching Express route in server.js?
// Heuristic but catches dead buttons, missing handlers, and wrong endpoints.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch { return ''; } };

const appJs = read('public/app.js');
const indexHtml = read('public/index.html');
const serverJs = read('server.js');
const frontend = appJs + '\n' + indexHtml;

// ---- (A) handlers --------------------------------------------------------
const handlerRe = /\bon(?:click|change|input|submit|keyup|keydown|focus|blur)\s*=\s*["']\s*([A-Za-z_$][\w$]*)\s*\(/g;
const handlers = new Map(); // name -> count
let m;
while ((m = handlerRe.exec(frontend))) handlers.set(m[1], (handlers.get(m[1]) || 0) + 1);

// Defined names in the frontend JS
const defined = new Set();
const defRes = [
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/g,
    /\bwindow\.([A-Za-z_$][\w$]*)\s*=/g,
    /\b([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?function/g, // object-method style
];
for (const re of defRes) { let x; while ((x = re.exec(frontend))) defined.add(x[1]); }

// Browser/global builtins that are legitimately called from handlers
const BUILTINS = new Set(['alert','confirm','prompt','print','sendPrompt','event','open','location','history','reload']);

const deadHandlers = [...handlers.keys()].filter(h => !defined.has(h) && !BUILTINS.has(h)).sort();

// ---- (B) fetch endpoints -------------------------------------------------
const norm = (p) => p
    .split('?')[0]
    .replace(/\$\{[^}]*\}/g, ':p')   // template literals
    .replace(/:[A-Za-z_$][\w$]*/g, ':p') // express params
    .replace(/\/\d+(?=\/|$)/g, '/:p')    // literal numeric ids
    .replace(/\/+$/, '');

const fetchRe = /fetch\(\s*[`'"]([^`'"]+)[`'"]/g;
const fetchUrls = new Set();
while ((m = fetchRe.exec(appJs))) { if (m[1].startsWith('/api') || m[1].includes('/api/')) fetchUrls.add(m[1]); }

const routeRe = /app\.(get|post|put|delete|patch)\(\s*[`'"]([^`'"]+)[`'"]/g;
const routes = new Set();
while ((m = routeRe.exec(serverJs))) routes.add(norm(m[2]));

const deadEndpoints = [...fetchUrls]
    .map(u => ({ raw: u, n: norm(u) }))
    .filter(u => u.n.startsWith('/api') && !routes.has(u.n))
    .sort((a, b) => a.n.localeCompare(b.n));

// ---- report --------------------------------------------------------------
console.log(`Handlers referenced: ${handlers.size} unique | JS names defined: ${defined.size}`);
console.log(`Fetch /api URLs: ${fetchUrls.size} | Express routes: ${routes.size}`);

console.log(`\n=== (A) Handlers with NO matching function definition (${deadHandlers.length}) ===`);
if (!deadHandlers.length) console.log('  ✅ none — every inline handler resolves to a defined function');
else deadHandlers.forEach(h => console.log(`  ❌ ${h}()  (used ${handlers.get(h)}x)`));

console.log(`\n=== (B) fetch() URLs with NO matching server route (${deadEndpoints.length}) ===`);
if (!deadEndpoints.length) console.log('  ✅ none — every /api fetch maps to a route');
else deadEndpoints.forEach(e => console.log(`  ❌ ${e.raw}   (normalized ${e.n})`));

const total = deadHandlers.length + deadEndpoints.length;
console.log(`\n${total === 0 ? '🎉 WIRING CLEAN' : '⚠️ ' + total + ' wiring issue(s) — inspect above'}`);
