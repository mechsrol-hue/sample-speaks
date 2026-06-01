const fs = require('fs');

const appJs = fs.readFileSync('public/app.js', 'utf8');
const serverJs = fs.readFileSync('server.js', 'utf8');

const frontendFetchRegex = /fetch\((?:`|')(\/api\/[^`'?]+)/g;
const backendEndpointRegex = /app\.(get|post|put|delete)\((?:`|')(\/api\/[^`']+)/g;

const frontendEndpoints = new Set();
let match;
while ((match = frontendFetchRegex.exec(appJs)) !== null) {
    let endpoint = match[1];
    // Remove query params or template literal variable parts from the string for basic matching
    endpoint = endpoint.split('$')[0].replace(/\/$/, '');
    frontendEndpoints.add(endpoint);
}

const backendEndpoints = new Set();
while ((match = backendEndpointRegex.exec(serverJs)) !== null) {
    let endpoint = match[2];
    endpoint = endpoint.split(':')[0].replace(/\/$/, '');
    backendEndpoints.add(endpoint);
}

console.log("Frontend endpoints not found in backend:");
for (let ep of frontendEndpoints) {
    let found = false;
    for (let be of backendEndpoints) {
        if (ep.startsWith(be)) {
            found = true;
            break;
        }
    }
    if (!found) {
        console.log("Missing in backend:", ep);
    }
}

console.log("\nBackend endpoints not found in frontend (might be okay if unused currently):");
for (let be of backendEndpoints) {
    let found = false;
    for (let ep of frontendEndpoints) {
        if (ep.startsWith(be) || be.startsWith(ep)) {
            found = true;
            break;
        }
    }
    if (!found) {
        console.log("Missing in frontend:", be);
    }
}
