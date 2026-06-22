const fs = require('fs');

const serverPath = '/Users/saurabh/Desktop/Antigravity/SampleSpeaks_MacTransfer/server.js';
let serverContent = fs.readFileSync(serverPath, 'utf-8');

const interceptCode = `
// Intercept DB files to serve dynamically from Supabase
app.get('/standards_db.js', async (req, res, next) => {
    try {
        const { data } = await supabase.from('system_preferences').select('value').eq('key', 'standards_db').single();
        if (data && data.value) {
            res.type('.js');
            return res.send(\`const EXTRACTED_STANDARDS_DB = \${data.value};\`);
        } else {
            const fs = require('fs');
            const path = require('path');
            const fileContent = fs.readFileSync(path.join(__dirname, 'public/standards_db.js'), 'utf-8');
            const vm = require('vm');
            const sandbox = {};
            vm.createContext(sandbox);
            vm.runInContext(fileContent, sandbox);
            const jsonStr = JSON.stringify(sandbox.EXTRACTED_STANDARDS_DB);
            await supabase.from('system_preferences').upsert({ key: 'standards_db', value: jsonStr }, { onConflict: 'key' });
            res.type('.js');
            return res.send(\`const EXTRACTED_STANDARDS_DB = \${jsonStr};\`);
        }
    } catch(err) {
        console.error("Error with standards_db.js migration:", err);
        next(); // fallback to static if DB fails completely
    }
});

app.get('/specs_db.js', async (req, res, next) => {
    try {
        const { data } = await supabase.from('system_preferences').select('value').eq('key', 'specs_db').single();
        if (data && data.value) {
            res.type('.js');
            return res.send(\`const SpecsDB = \${data.value};\`);
        } else {
            const fs = require('fs');
            const path = require('path');
            const fileContent = fs.readFileSync(path.join(__dirname, 'public/specs_db.js'), 'utf-8');
            const vm = require('vm');
            const sandbox = {};
            vm.createContext(sandbox);
            vm.runInContext(fileContent, sandbox);
            const jsonStr = JSON.stringify(sandbox.SpecsDB);
            await supabase.from('system_preferences').upsert({ key: 'specs_db', value: jsonStr }, { onConflict: 'key' });
            res.type('.js');
            return res.send(\`const SpecsDB = \${jsonStr};\`);
        }
    } catch(err) {
        console.error("Error with specs_db.js migration:", err);
        next();
    }
});

app.post('/api/admin/standards_db', async (req, res) => {
    const { standardsData } = req.body;
    try {
        await supabase.from('system_preferences').upsert({ key: 'standards_db', value: JSON.stringify(standardsData) }, { onConflict: 'key' });
        res.json({ message: 'Standards DB updated' });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/specs_db', async (req, res) => {
    const { specsData } = req.body;
    try {
        await supabase.from('system_preferences').upsert({ key: 'specs_db', value: JSON.stringify(specsData) }, { onConflict: 'key' });
        res.json({ message: 'Specs DB updated' });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.use(express.static('public'));`;

serverContent = serverContent.replace("app.use(express.static('public'));", interceptCode);

fs.writeFileSync(serverPath, serverContent);
console.log("Migration interception added to server.js");
