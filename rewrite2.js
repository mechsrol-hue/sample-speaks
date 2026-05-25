const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

code = code.replace(/app\.get\('\/api\/upload-history',\s*\(req,\s*res\)\s*=>/g, "app.get('/api/upload-history', async (req, res) =>");
code = code.replace(/app\.get\('\/api\/batch-details\/:batchId',\s*\(req,\s*res\)\s*=>/g, "app.get('/api/batch-details/:batchId', async (req, res) =>");
code = code.replace(/app\.get\('\/api\/samples\/:tpName',\s*\(req,\s*res\)\s*=>/g, "app.get('/api/samples/:tpName', async (req, res) =>");
code = code.replace(/app\.post\('\/api\/submit-sample',\s*\(req,\s*res\)\s*=>/g, "app.post('/api/submit-sample', async (req, res) =>");
code = code.replace(/app\.post\('\/api\/admin\/reset-database',\s*\(req,\s*res\)\s*=>/g, "app.post('/api/admin/reset-database', async (req, res) =>");

fs.writeFileSync('server.js', code);
console.log('Fixed async');
