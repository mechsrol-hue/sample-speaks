const fs = require('fs');
const path = require('path');
const supabase = require('../database-supabase');

function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current.trim());
    return result;
}

function cleanStatus(statusStr) {
    if (!statusStr) return 'Working';
    const s = statusStr.toLowerCase().trim();
    if (s.includes('not working') || s.includes('notworking')) return 'Not Working';
    if (s.includes('under repair')) return 'Under Repair';
    if (s.includes('partially working')) return 'Partially Working';
    if (s.includes('condemned')) return 'Condemned';
    if (s.includes('working')) return 'Working';
    return statusStr.trim(); // Keep raw if it doesn't match standard categories
}

function cleanCost(costStr) {
    if (!costStr) return '';
    // Strip quotes and commas, e.g. "1,13,280 " -> "113280"
    return costStr.replace(/["\s,]/g, '');
}

async function seed() {
    console.log('Starting equipment seeder...');
    
    const csvPath = path.join(__dirname, '../scratch/sheet.csv');
    if (!fs.existsSync(csvPath)) {
        console.error('Error: CSV file not found at scratch/sheet.csv');
        process.exit(1);
    }

    const content = fs.readFileSync(csvPath, 'utf8');
    const lines = content.split(/\r?\n/);
    
    // The data starts from line 5 (index 4) because:
    // Line 1: BUREAU OF INDIAN STANDARDS
    // Line 2: SOUTHERN REGIONAL LABORATORY
    // Line 3: PHYSICAL VERIFICATION OF CAPITAL EQUIPMENT...
    // Line 4: S.No.,Name,Make,Cost Rs.P,Lab Code,Location,Dt. Rec.,Entry details...
    
    const equipments = [];
    for (let i = 4; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        const row = parseCSVLine(line);
        // Ensure we have at least Name and some data, and skip footer/empty commas
        if (row.length < 2 || !row[1] || row[1].startsWith('BUREAU OF') || row[1] === 'Name') {
            continue;
        }

        const name = row[1];
        const sNo = row[0] || null;
        const make = row[2] || null;
        const cost = cleanCost(row[3]) || null;
        const labCode = row[4] ? row[4].trim() : null;
        const location = row[5] || null;
        const dtRec = row[6] || null;
        const registerDetails = row[7] || null;
        const url = row[8] || null;
        const qrCode = row[9] || null;
        const status = cleanStatus(row[10]);

        equipments.push({
            sNo,
            name,
            make,
            cost,
            labCode: labCode || null, // Ensure empty string becomes null to avoid unique key conflicts in PostgreSQL
            location,
            dtRec,
            registerDetails,
            url,
            qrCode,
            status
        });
    }

    console.log(`Parsed ${equipments.length} equipment records from CSV.`);

    if (equipments.length === 0) {
        console.log('No records found to insert.');
        return;
    }

    // Insert in batches of 50 to avoid payload limits
    const batchSize = 50;
    for (let i = 0; i < equipments.length; i += batchSize) {
        const batch = equipments.slice(i, i + batchSize);
        console.log(`Inserting batch ${i / batchSize + 1} (${batch.length} items)...`);
        
        const { data, error } = await supabase.from('equipments').upsert(batch, { onConflict: 'labCode' });
        if (error) {
            console.error('Error inserting batch:', error.message);
            if (error.message.includes('relation "equipments" does not exist')) {
                console.error('CRITICAL: The "equipments" table does not exist in Supabase yet.');
                console.error('Please create the table using the SQL definition in supabase_migration.sql first.');
            }
            process.exit(1);
        }
    }

    console.log('Equipment seeder finished successfully!');
    process.exit(0);
}

seed().catch(err => {
    console.error('Unhandled error during seeding:', err);
    process.exit(1);
});
