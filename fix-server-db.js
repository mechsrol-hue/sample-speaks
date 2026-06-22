const fs = require('fs');

const serverPath = '/Users/saurabh/Desktop/Antigravity/SampleSpeaks_MacTransfer/server.js';
let serverContent = fs.readFileSync(serverPath, 'utf-8');

// We will use regex to replace the endpoints
// First, GET /api/admin/templates
serverContent = serverContent.replace(
    /app\.get\('\/api\/admin\/templates', async \(req, res\) => \{[\s\S]*?\}\);/,
    `app.get('/api/admin/templates', async (req, res) => {
        try {
            const fs = require('fs');
            const path = require('path');
            const prefsPath = path.join(__dirname, 'system_preferences.json');
            let templates = {};
            if (fs.existsSync(prefsPath)) {
                const data = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
                Object.keys(data).forEach(key => {
                    if (key.startsWith('template_')) {
                        try { templates[key.replace('template_', '')] = JSON.parse(data[key]); } catch(e){}
                    }
                });
            }
            res.json({ templates });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });`
);

// POST /api/admin/templates
serverContent = serverContent.replace(
    /app\.post\('\/api\/admin\/templates', async \(req, res\) => \{[\s\S]*?\}\);/,
    `app.post('/api/admin/templates', async (req, res) => {
        const { isNumber, templateData } = req.body;
        if (!isNumber || !templateData) return res.status(400).json({ error: 'Missing isNumber or templateData' });
        try {
            const fs = require('fs');
            const path = require('path');
            const prefsPath = path.join(__dirname, 'system_preferences.json');
            let data = {};
            if (fs.existsSync(prefsPath)) {
                data = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
            }
            data[\`template_\${isNumber}\`] = JSON.stringify(templateData);
            fs.writeFileSync(prefsPath, JSON.stringify(data, null, 2));
            res.json({ message: 'Template saved successfully.' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });`
);

// GET /api/admin/preferences
serverContent = serverContent.replace(
    /app\.get\('\/api\/admin\/preferences', async \(req, res\) => \{[\s\S]*?\}\);/,
    `app.get('/api/admin/preferences', async (req, res) => {
        try {
            const fs = require('fs');
            const path = require('path');
            const prefsPath = path.join(__dirname, 'system_preferences.json');
            let prefs = {};
            if (fs.existsSync(prefsPath)) {
                prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
            }
            res.json({ preferences: prefs });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });`
);

// POST /api/admin/preferences
serverContent = serverContent.replace(
    /app\.post\('\/api\/admin\/preferences', async \(req, res\) => \{[\s\S]*?\}\);/,
    `app.post('/api/admin/preferences', async (req, res) => {
        const { preferences } = req.body;
        try {
            const fs = require('fs');
            const path = require('path');
            const prefsPath = path.join(__dirname, 'system_preferences.json');
            let data = {};
            if (fs.existsSync(prefsPath)) {
                data = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
            }
            Object.keys(preferences).forEach(key => {
                data[key] = preferences[key];
            });
            fs.writeFileSync(prefsPath, JSON.stringify(data, null, 2));
            res.json({ message: 'Preferences saved successfully.' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });`
);

// Fix GET /api/auto-assign to use the local file for templates
serverContent = serverContent.replace(
    /const \{ data \} = await supabase\.from\('system_preferences'\)\.select\('\*'\)\.like\('key', 'template_%'\);/,
    `const fs = require('fs');
            const path = require('path');
            const prefsPath = path.join(__dirname, 'system_preferences.json');
            let data = [];
            if (fs.existsSync(prefsPath)) {
                const prefsObj = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
                data = Object.keys(prefsObj).filter(k => k.startsWith('template_')).map(k => ({ key: k, value: prefsObj[k] }));
            }`
);

// Fix GET /api/admin/analytics to use local file for storage days
serverContent = serverContent.replace(
    /const \{ data: prefs \} = await supabase\.from\('system_preferences'\)\.select\('\*'\)\.in\('key', \['passStorageDays', 'failStorageDays'\]\);/,
    `const fs = require('fs');
        const path = require('path');
        const prefsPath = path.join(__dirname, 'system_preferences.json');
        let prefs = [];
        if (fs.existsSync(prefsPath)) {
            const prefsObj = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
            if (prefsObj['passStorageDays']) prefs.push({ key: 'passStorageDays', value: prefsObj['passStorageDays'] });
            if (prefsObj['failStorageDays']) prefs.push({ key: 'failStorageDays', value: prefsObj['failStorageDays'] });
        }`
);


fs.writeFileSync(serverPath, serverContent);
console.log("Updated server.js to use local system_preferences.json");
