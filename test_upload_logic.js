const fs = require('fs');
const xlsx = require('xlsx');

function cleanName(name) {
    if (!name) return "";
    let cleaned = name.toString()
        .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    return cleaned.toLowerCase().split(' ').map(word => {
        if (!word) return "";
        return word.charAt(0).toUpperCase() + word.slice(1);
    }).join(' ');
}

const SYSTEM_FIELDS = {
    encodedCode: { synonyms: ['encoded code', 'encoded sample', 'encodedcode', 'encode', 'sample code', 'samplecode', 'sample no', 'sample number'], contentTest: (vals) => vals.some(v => /^[0-9]{2}[A-Z]{1,2}[0-9]+[A-Z]?$/i.test(v)) },
    isNumber: { synonyms: ['is number', 'isnumber', 'is_number', 'is no', 'indian standard', 'standard'], contentTest: (vals) => vals.some(v => /^(IS\s*)?\d{3,5}/.test(v)) },
    quantity: { synonyms: ['quantity', 'qty'] },
    priorityLevel: { synonyms: ['priority', 'priority level'] },
    receivedOn: { synonyms: ['received on', 'receivedon', 'sample received on', 'received_on', 'received date', 'date received', 'recv dt'], contentTest: (vals) => vals.some(v => !isNaN(v) || /\d{2}[-\/]\d{2}[-\/]\d{2,4}/.test(v)) },
    forwardedOn: { synonyms: ['forwarded on', 'forwardedon', 'sample forwarded on', 'forwarded_on', 'forwarded date'], contentTest: (vals) => vals.some(v => !isNaN(v) || /\d{2}[-\/]\d{2}[-\/]\d{2,4}/.test(v)) },
    assignedTo: { synonyms: ['assigned to', 'tp name', 'assignedto', 'tpname', 'testing person name', 'testing person', 'tester', 'tester name', 'officer', 'allocated to', 'allocatedto', 'tp', 'tp_name', 'testing_person', 'tp name standard'], contentTest: null },
    totalTest: { synonyms: ['total test', 'totaltest', 'total tests'] },
    pendingTest: { synonyms: ['pending test', 'pendingtest', 'pending tests'] },
    approvedTest: { synonyms: ['approved test', 'approvedtest', 'approved tests'] }
};

try {
    const buf = fs.readFileSync('PENDING SAMPLE MINISTRY MECH COPY.xlsx');
    const workbook = xlsx.read(buf, { type: 'buffer', cellDates: false });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });

    const allHeaders = Object.keys(rows[0]);
    const columnMap = {};
    const matchedHeaders = new Set();
    const recognizedMappings = [];

    for (const [field, config] of Object.entries(SYSTEM_FIELDS)) {
        for (const header of allHeaders) {
            if (matchedHeaders.has(header)) continue;
            const hLower = header.toLowerCase().trim();
            const matched = config.synonyms.some(s => hLower === s.toLowerCase() || hLower.includes(s.toLowerCase()));
            if (matched) {
                columnMap[field] = header;
                matchedHeaders.add(header);
                recognizedMappings.push({ originalName: header, mappedTo: field, confidence: 'synonym' });
                break;
            }
        }
    }

    const ambiguousMappings = [];
    const unmatchedHeaders = allHeaders.filter(h => !matchedHeaders.has(h));

    for (const header of unmatchedHeaders) {
        const sampleVals = [];
        for (let i = 0; i < rows.length && sampleVals.length < 50; i++) {
            const val = String(rows[i][header] || '').trim();
            if (val) sampleVals.push(val);
        }
        if (sampleVals.length === 0) continue;

        const suggestions = [];
        for (const [field, config] of Object.entries(SYSTEM_FIELDS)) {
            if (columnMap[field]) continue;
            if (config.contentTest && config.contentTest(sampleVals)) {
                suggestions.push(field);
            }
        }
        ambiguousMappings.push({ originalName: header, sampleValues: sampleVals.slice(0, 5), suggestions });
    }

    console.log("Success: mapped headers", columnMap);
} catch (e) {
    console.error("Error:", e);
}
