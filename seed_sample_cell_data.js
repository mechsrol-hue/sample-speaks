const xlsx = require('xlsx');
const supabase = require('./database-supabase');
const fs = require('fs');

function excelDateToString(excelDate) {
    if (!excelDate) return "";
    if (isNaN(excelDate) && typeof excelDate === 'string') return excelDate.trim();
    try {
        const dateNum = parseFloat(excelDate);
        if (isNaN(dateNum)) return excelDate;
        const date = new Date((dateNum - 25569) * 86400 * 1000);
        const dd = String(date.getDate()).padStart(2, '0');
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const yyyy = date.getFullYear();
        return `${dd}-${mm}-${yyyy}`;
    } catch (e) {
        return excelDate.toString();
    }
}

async function seedData() {
    console.log("Reading excel file...");
    const workbook = xlsx.readFile('./PENDING SAMPLE MINISTRY MECH COPY.xlsx', { cellDates: false });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: '' });

    if (!rows || rows.length === 0) {
        console.log("File is empty.");
        return;
    }

    const firstRowKeys = Object.keys(rows[0]);
    const findKey = (searchStrings) => firstRowKeys.find(k => searchStrings.some(s => k.toLowerCase().includes(s.toLowerCase())));

    const sNoKey = findKey(['s.no', 'sno', 's no', 'sl no']);
    const barcodeKey = findKey(['barcode', 'bar code', 'bar-code', 'encode']);
    const sampleCodeKey = findKey(['sample code', 'samplecode', 'sample id']);
    const isNumberKey = findKey(['is number', 'isnumber', 'is_number', 'is-number']);
    const testingTypeKey = findKey(['testing type', 'testing_type']);
    const labNameKey = findKey(['lab name', 'labname', 'lab']);
    const receivedKey = findKey(['sample received on', 'received', 'receipt']);
    const lagKey = findKey(['time lag', 'lag']);
    const issuedKey = findKey(['report issued on', 'issued']);
    const sampleStatusKey = findKey(['sample status', 'samplestatus']);
    const reportStatusKey = findKey(['report status', 'reportstatus']);
    const sourceKey = findKey(['source']);

    const fresh = [];

    rows.forEach(row => {
        const barcodeVal = row[barcodeKey];
        if (!barcodeVal) return;
        
        const barcode = String(barcodeVal).trim();

        const record = {
            sNo: sNoKey ? String(row[sNoKey]).trim() : '',
            barcode: barcode,
            sampleCode: sampleCodeKey ? String(row[sampleCodeKey]).trim() : '',
            isNumber: isNumberKey ? String(row[isNumberKey]).trim() : '',
            testingType: testingTypeKey ? String(row[testingTypeKey]).trim() : '',
            labName: labNameKey ? String(row[labNameKey]).trim() : '',
            sampleReceivedOn: receivedKey ? excelDateToString(row[receivedKey]) : '',
            timeLagDays: lagKey ? String(row[lagKey]).trim() : '',
            reportIssuedOn: issuedKey ? excelDateToString(row[issuedKey]) : '',
            sampleStatus: sampleStatusKey ? String(row[sampleStatusKey]).trim() : '',
            reportStatus: reportStatusKey ? String(row[reportStatusKey]).trim() : '',
            source: sourceKey ? String(row[sourceKey]).trim() : ''
        };

        fresh.push(record);
    });

    console.log(`Found ${fresh.length} records. Uploading to Supabase...`);

    const { error: dataErr } = await supabase.from('sample_cell_data').upsert(fresh, { onConflict: 'barcode' });
    if (dataErr) {
        console.error("Error inserting:", dataErr);
    } else {
        console.log("Successfully seeded data!");
    }
}

seedData();
