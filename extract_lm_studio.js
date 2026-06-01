const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const TARGET_STANDARDS = [
    "IS 14756", "IS 9873", "IS 2185", "IS 269", "IS 4246", "IS 14735", "IS 1660", "IS 1038",
    "IS 3196", "IS 4985", "IS 4413", "IS 4283",
    "IS 303", "IS 12330", "IS 2556", "IS 455", "IS 710", "IS 1489"
];

const PDF_DIR = path.join(__dirname, 'Testing Charges', 'Testing charges BIS 09.2.2026');

async function extractTextFromPDFs() {
    const files = fs.readdirSync(PDF_DIR).filter(f => f.endsWith('.pdf'));
    let combinedText = '';
    
    for (const file of files) {
        console.log(`Extracting text from ${file}...`);
        const pdfPath = path.join(PDF_DIR, file);
        const txtPath = path.join(PDF_DIR, file + '.txt');
        try {
            execSync(`pdftotext "${pdfPath}" "${txtPath}"`);
            const data = fs.readFileSync(txtPath, 'utf8');
            combinedText += `\n\n--- FILE: ${file} ---\n\n` + data;
            fs.unlinkSync(txtPath); // Cleanup
        } catch (e) {
            console.error(`Error reading ${file}:`, e.message);
        }
    }
    return combinedText;
}

async function queryLMStudio(chunk, standard) {
    const prompt = `You are an expert Laboratory Quality Manager and LIMS Database Architect. Your task is to extract test parameters and testing durations (man-hours) for the standard ${standard} from the provided text.

### STRICT RULES:
1. ONLY extract mechanical and physical parameters. STRICTLY IGNORE chemical, electrical, microbiological.
2. NO ASSUMPTIONS: Only extract if it is present. If man-hours/testing duration is found, extract it. If a charge or fee is found instead of hours, estimate hours based on standard rates or leave hours as null.
3. OUTPUT VALID JSON ONLY.

### REQUIRED JSON STRUCTURE:
{
  "IS_NUMBER": "${standard}",
  "PARAMETERS": {
    "clause_or_test_name": {
      "parameter_name": "[Name of the test]",
      "estimated_man_hours": [Number or null],
      "charge_if_any": "[Any Rs value found]"
    }
  }
}

### TEXT TO ANALYZE (Focus on ${standard}):
${chunk}
`;

    try {
        const response = await fetch('http://127.0.0.1:1234/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'google/gemma-4-e4b', // default or whatever is loaded
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.1,
                max_tokens: 2000
            })
        });
        
        const data = await response.json();
        return data.choices[0].message.content;
    } catch (e) {
        console.error(`Error querying LM Studio for ${standard}:`, e.message);
        return null;
    }
}

async function main() {
    console.log("Loading all PDFs...");
    const allText = await extractTextFromPDFs();
    console.log(`Loaded ${allText.length} characters.`);
    
    const results = {};
    
    for (const standard of TARGET_STANDARDS) {
        console.log(`Processing ${standard}...`);
        const regex = new RegExp(`(${standard}[\\s\\S]{0,3000})`, 'gi');
        const matches = allText.match(regex);
        
        if (!matches) {
            console.log(`   Not found in text.`);
            continue;
        }
        
        // Grab context chunk around the standard.
        const chunk = matches.slice(0, 3).join("\n\n..."); // limit to first 3 matches
        
        console.log(`   Found chunk for ${standard}. Querying LM Studio...`);
        const jsonResponse = await queryLMStudio(chunk, standard);
        
        if (jsonResponse) {
            console.log(`   LM Studio returned data for ${standard}.`);
            // Try to parse the JSON
            try {
                const cleaned = jsonResponse.replace(/```json/g, '').replace(/```/g, '').trim();
                results[standard] = JSON.parse(cleaned);
            } catch(e) {
                console.log(`   Failed to parse JSON for ${standard}. Storing raw.`);
                results[standard] = { raw: jsonResponse };
            }
        }
    }
    
    fs.writeFileSync('extracted_standards_data.json', JSON.stringify(results, null, 2));
    console.log("Extraction complete! Saved to extracted_standards_data.json");
}

main();
