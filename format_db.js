const fs = require('fs');
const path = require('path');

const dataRaw = fs.readFileSync('extracted_standards_data.json', 'utf8');
const data = JSON.parse(dataRaw);

const DB = {};

for (const [standard, val] of Object.entries(data)) {
    let parsedVal = val;
    
    // Handle raw string
    if (val.raw) {
        try {
            let cleaned = val.raw.replace(/```json/gi, '').replace(/```/gi, '').trim();
            // fix trailing commas or incomplete json if needed, but lets assume it parses
            // if it doesn't parse, we'll try to find the last complete object bracket
            // simple fix for truncated json at the end
            if (!cleaned.endsWith('}')) {
                const lastBrace = cleaned.lastIndexOf('}');
                if (lastBrace > -1) {
                    cleaned = cleaned.substring(0, lastBrace + 1) + "\n  }\n}";
                }
            }
            parsedVal = JSON.parse(cleaned);
        } catch(e) {
            console.error(`Failed to parse raw for ${standard}: ${e.message}`);
            continue;
        }
    }
    
    // We expect { IS_NUMBER: "...", PARAMETERS: { ... } }
    if (!parsedVal.PARAMETERS) continue;
    
    const outParams = [];
    
    for (const [clause, param] of Object.entries(parsedVal.PARAMETERS)) {
        let name = param.parameter_name || clause;
        let hrs = param.estimated_man_hours;
        
        let needsReview = false;
        
        // Handle arrays
        if (Array.isArray(hrs)) {
            hrs = Math.max(...hrs);
            needsReview = true;
        }
        
        // Handle null/0/missing
        if (hrs === null || hrs === undefined || hrs === 0 || isNaN(hrs)) {
            hrs = 1;
            needsReview = true;
        }
        
        if (needsReview) {
            name = `⚠️ [REVIEW] ${name}`;
        }
        
        outParams.push({
            clause: clause,
            param: name,
            hours: hrs
        });
    }
    
    DB[standard] = outParams;
}

const jsContent = `// Automatically generated from LM Studio extraction
const EXTRACTED_STANDARDS_DB = ${JSON.stringify(DB, null, 2)};
`;

fs.writeFileSync(path.join(__dirname, 'public', 'standards_db.js'), jsContent);
console.log('Successfully created public/standards_db.js');
