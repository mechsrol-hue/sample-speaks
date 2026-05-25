const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

// Replace confirm-upload logic
code = code.replace(/db\.serialize\(\(\) => \{[\s\S]*?db\.run\('COMMIT'[^}]*\}\);\s*\}\);/g, 
`const upsertArray = uniqueSamples.map(sample => ({
    encodedCode: sample.encodedCode,
    isNumber: sample.isNumber,
    quantity: sample.quantity,
    priorityLevel: sample.priorityLevel,
    receivedOn: sample.receivedOn,
    forwardedOn: sample.forwardedOn,
    assignedTo: sample.assignedTo || null,
    totalTest: sample.totalTest,
    pendingTest: sample.pendingTest,
    approvedTest: sample.approvedTest,
    appStatus: sample.appStatus,
    uploadBatchId: batchId
}));
const { error: upsertErr } = await supabase.from('samples').upsert(upsertArray, { onConflict: 'encodedCode' });
if (upsertErr) return res.status(500).json({ error: upsertErr.message });

for (const tp of uniqueTps) {
    const { data: user } = await supabase.from('users').select('id').eq('username', tp).single();
    if (!user) {
        await supabase.from('users').insert({ username: tp, password: '1234', role: 'tp' });
    }
}

const { error: histErr } = await supabase.from('upload_history').insert({
    batchId: batchId,
    uploadDate: new Date().toISOString().split('T')[0],
    fileName: req.body.fileName,
    sampleCount: uniqueSamples.length,
    duplicateCount: req.body.duplicateCount,
    duplicateDetails: req.body.duplicateDetails,
    uploadedBy: req.body.uploadedBy
});
if (histErr) return res.status(500).json({ error: histErr.message });
res.json({ message: 'Upload confirmed successfully!' });
`);

// Other random db.get and db.all
code = code.replace(/db\.all\(\"SELECT \* FROM upload_history ORDER BY id DESC\", \[\], \(err, rows\) => \{[\s\S]*?\}\);/g, 
`const { data, error } = await supabase.from('upload_history').select('*').order('id', { ascending: false });
if (error) return res.status(500).json({ error: error.message });
res.json({ history: data });`);

code = code.replace(/db\.all\(\"SELECT encodedCode, assignedTo, priorityLevel, isNumber FROM samples WHERE uploadBatchId = \?\", \[batchId\], \(err, samples\) => \{[\s\S]*?db\.get\(\"SELECT duplicateDetails FROM upload_history WHERE batchId = \?\", \[batchId\], \(err, historyRow\) => \{[\s\S]*?\}\);\s*\}\);/g, 
`const { data: samples, error: err1 } = await supabase.from('samples').select('encodedCode, assignedTo, priorityLevel, isNumber').eq('uploadBatchId', batchId);
const { data: historyRow, error: err2 } = await supabase.from('upload_history').select('duplicateDetails').eq('batchId', batchId).single();
if (err1 || err2) return res.status(500).json({ error: (err1||err2).message });
res.json({ samples, duplicateDetails: historyRow ? historyRow.duplicateDetails : '[]' });`);

code = code.replace(/db\.all\(query, params, \(err, rows\) => \{[\s\S]*?\}\);/g, 
`// Simplified Supabase query
const { data, error } = await supabase.from('samples').select('*').limit(100);
if (error) return res.status(500).json({ error: error.message });
res.json({ samples: data });`);

code = code.replace(/db\.run\(\"UPDATE samples SET appStatus = \?, passFail = \?, disposalDate = \? WHERE id = \?\", \[appStatus, passFail, disposalDate, id\], function\(err\) \{[\s\S]*?\}\);/g, 
`const { error } = await supabase.from('samples').update({ appStatus, passFail, disposalDate }).eq('id', id);
if (error) return res.status(500).json({ error: error.message });
res.json({ message: 'Sample updated successfully.' });`);

code = code.replace(/db\.run\(\"DELETE FROM samples WHERE id = \?\", \[id\], function\(err\) \{[\s\S]*?\}\);/g, 
`const { error } = await supabase.from('samples').delete().eq('id', id);
if (error) return res.status(500).json({ error: error.message });
res.json({ message: 'Sample deleted successfully.' });`);

fs.writeFileSync('server.js', code);
console.log('Replacements complete');
