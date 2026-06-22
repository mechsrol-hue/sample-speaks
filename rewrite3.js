const fs = require('fs');

let code = fs.readFileSync('server.js', 'utf8');

// 1. Replace sample-cell/commit db.serialize logic
code = code.replace(/db\.serialize\(\(\) => \{[\s\S]*?db\.run\('COMMIT', \(err\) => \{[\s\S]*?res\.json\(\{ message: `Successfully committed \$\{allRecords\.length\} records\. Batch: \$\{batchId\}` \}\);\n\s*\}\);\n\s*\}\);\n\s*\}\);/g, 
`    const batchId = 'SC-BATCH-' + Date.now();
    try {
        const { error: histErr } = await supabase.from('sample_cell_history').insert([{
            batchId, uploadDate: new Date().toISOString(), fileName, sampleCount: fresh.length, duplicateCount: duplicates.length, uploadedBy
        }]);
        if (histErr) throw histErr;

        const { error: dataErr } = await supabase.from('sample_cell_data').upsert(allRecords, { onConflict: 'barcode' });
        if (dataErr) throw dataErr;

        res.json({ message: \`Successfully committed \${allRecords.length} records. Batch: \${batchId}\` });
    } catch(err) {
        res.status(500).json({ error: 'Transaction failed: ' + err.message });
    }`);
    
// We also need to add async to the sample-cell/commit handler if it doesn't have it
code = code.replace(/app\.post\('\/api\/sample-cell\/commit', \(req, res\) => \{/, "app.post('/api/sample-cell/commit', async (req, res) => {");

// 2. Replace sample-cell/history
code = code.replace(/app\.get\('\/api\/sample-cell\/history', \(req, res\) => \{[\s\S]*?\}\);/g,
`app.get('/api/sample-cell/history', async (req, res) => {
    try {
        const { data: rows, error } = await supabase.from('sample_cell_history').select('*').order('id', { ascending: false });
        if (error) throw error;
        res.json({ history: rows || [] });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});`);

// 3. Replace sample-cell/data
code = code.replace(/db\.all\('SELECT \* FROM sample_cell_data ORDER BY id DESC', \[\], \(err, rows\) => \{/g,
`try {
        const { data: rows, error } = await supabase.from('sample_cell_data').select('*').order('id', { ascending: false });
        if (error) throw error;`);
code = code.replace(/res\.json\(\{\n\s*data: dataWithAge,\n\s*analytics: \{ over15, over30, over45, over60, over90, totalPending \}\n\s*\}\);\n\s*\}\);/g, 
`res.json({
            data: dataWithAge,
            analytics: { over15, over30, over45, over60, over90, totalPending }
        });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }`);
code = code.replace(/app\.get\('\/api\/sample-cell\/data', \(req, res\) => \{/, "app.get('/api/sample-cell/data', async (req, res) => {");

// 4. Replace sample-cell/data DELETE
code = code.replace(/app\.delete\('\/api\/sample-cell\/data', \(req, res\) => \{[\s\S]*?\}\);/g,
`app.delete('/api/sample-cell/data', async (req, res) => {
    try {
        const { error } = await supabase.from('sample_cell_data').delete().neq('id', 0);
        if (error) throw error;
        res.json({ message: 'All confidential data successfully wiped from the local vault.' });
    } catch(err) {
        res.status(500).json({ error: 'Failed to delete confidential data: ' + err.message });
    }
});`);

// 5. Replace standards_db.js and specs_db.js dynamic creation in GET routes
// In /standards_db.js
code = code.replace(/if \(!fs\.existsSync\(localFile\)\) \{[\s\S]*?fs\.writeFileSync\(localFile, 'const IS_STANDARDS = ' \+ JSON\.stringify\(dbData, null, 2\) \+ ';'\);\n\s*\}/g, "");
// In /specs_db.js
code = code.replace(/if \(!fs\.existsSync\(localFile\)\) \{[\s\S]*?fs\.writeFileSync\(localFile, 'const MATERIAL_SPECS = ' \+ JSON\.stringify\(dbData, null, 2\) \+ ';'\);\n\s*\}/g, "");

// 6. Replace lims_payload.json writes with nothing (we will pass to stdin)
// Wait, the payload is used by exec. We need to rewrite how lims_uploader_is4985.py is called.
// Let's find /api/lims/start
// It does fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2));
// then exec(\`python3 ...\`)
code = code.replace(/fs\.writeFileSync\(payloadPath, JSON\.stringify\(payload, null, 2\)\);[\s\S]*?exec\(\`python3 "\$\{scriptPath\}" --payload "\$\{payloadPath\}" --mode \$\{mode\}\`, \(error, stdout, stderr\) => \{/g, 
`// Payload passed via stdin
        const child = require('child_process').exec(\`python3 "\${scriptPath}" --payload - --mode \${mode}\`, (error, stdout, stderr) => {`);

// 7. Same for /api/lims/preview
code = code.replace(/fs\.writeFileSync\(payloadPath, JSON\.stringify\(payload, null, 2\)\);[\s\S]*?exec\(\`python3 "\$\{scriptPath\}" --payload "\$\{payloadPath\}" --mode single --preview\`, \(error, stdout, stderr\) => \{/g, 
`// Payload passed via stdin
        const child = require('child_process').exec(\`python3 "\${scriptPath}" --payload - --mode single --preview\`, (error, stdout, stderr) => {`);

// We also need to feed the payload into the child process stdin.
// So let's refine the replacement above:
code = code.replace(/const child = require\('child_process'\)\.exec\(\`python3 "\$\{scriptPath\}" --payload - --mode \$\{mode\}\`, \(error, stdout, stderr\) => \{/g,
`const child = require('child_process').exec(\`python3 "\${scriptPath}" --payload - --mode \${mode}\`, (error, stdout, stderr) => {`);
// Actually, exec() returns a ChildProcess, so we can do child.stdin.write(JSON.stringify(payload)); child.stdin.end();

// Let's rewrite the whole /api/lims/start block correctly.
code = code.replace(/app\.post\('\/api\/lims\/start'[\s\S]*?exec\([\s\S]*?\}\);/g, match => {
    return match.replace(/const payloadPath = path\.join\(__dirname, 'lims_payload\.json'\);[\s\S]*?exec\(\`python3 "\$\{scriptPath\}" --payload "\$\{payloadPath\}" --mode \$\{mode\}\`, \(error, stdout, stderr\) => \{/g,
`const child = require('child_process').exec(\`python3 "\${scriptPath}" --payload - --mode \${mode}\`, (error, stdout, stderr) => {`);
});

fs.writeFileSync('server.js', code);
console.log('Migration step 1 complete');
