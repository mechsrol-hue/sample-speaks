const fs = require('fs');
const path = require('path');
const vm = require('vm');
const supabase = require('../database-supabase');

async function migrate() {
    console.log('Starting migration to Supabase system_preferences...');
    
    const dbPath = path.join(__dirname, '../public/standards_db.js');
    if (!fs.existsSync(dbPath)) {
        console.error('File not found: public/standards_db.js');
        process.exit(1);
    }
    
    const fileContent = fs.readFileSync(dbPath, 'utf8');
    const sandbox = {};
    vm.createContext(sandbox);
    
    // Replace const with var so it gets exported to the sandbox object
    const code = fileContent.replace('const EXTRACTED_STANDARDS_DB', 'var EXTRACTED_STANDARDS_DB');
    vm.runInNewContext(code, sandbox);
    
    const standardsDb = sandbox.EXTRACTED_STANDARDS_DB;
    if (!standardsDb) {
        console.error('EXTRACTED_STANDARDS_DB not found in file');
        process.exit(1);
    }
    
    const keys = Object.keys(standardsDb);
    console.log(`Found ${keys.length} standards in public/standards_db.js.`);
    
    for (const isNumber of keys) {
        const clauses = standardsDb[isNumber];
        let totalHours = 0;
        const activeClauses = {};
        
        clauses.forEach(c => {
            const hrs = parseFloat(c.hours) || 0;
            totalHours += hrs;
            activeClauses[c.clause] = {
                active: true,
                activeHours: hrs,
                passiveHours: 0,
                equipment: ''
            };
        });
        
        const templateData = {
            tatDays: 7, // default pending days (Pending Days replaces TAT)
            activeClauses,
            totalHours
        };
        
        const key = `template_${isNumber}`;
        console.log(`Saving template for ${isNumber}: totalHours = ${totalHours}`);
        
        const { error } = await supabase.from('system_preferences').upsert({
            key: key,
            value: JSON.stringify(templateData)
        }, { onConflict: 'key' });
        
        if (error) {
            console.error(`Error saving template for ${isNumber}:`, error);
        }
    }
    
    console.log('Migration finished successfully!');
    process.exit(0);
}

migrate().catch(err => {
    console.error('Error during migration:', err);
    process.exit(1);
});
