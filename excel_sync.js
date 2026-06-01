const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');

const MASTER_SHEET_PATH = path.join(__dirname, 'Sample Speaks.xlsx');

/**
 * Ensures the Master Sheet exists. If not, creates a basic structure.
 */
function ensureMasterSheet() {
    if (!fs.existsSync(MASTER_SHEET_PATH)) {
        const wb = xlsx.utils.book_new();
        const headers = [
            'Encoded Code', 'IS Number', 'Quantity', 'Priority', 
            'Received On', 'Forwarded On', 'Assigned To', 
            'Total Test', 'Pending Test', 'Approved Test'
        ];
        const ws = xlsx.utils.aoa_to_sheet([headers]);
        xlsx.utils.book_append_sheet(wb, ws, 'Samples');
        xlsx.writeFile(wb, MASTER_SHEET_PATH);
    }
}

/**
 * Appends new samples to the Master Sheet.
 * @param {Array} samples - Array of sample objects.
 */
function appendSamplesToMaster(samples) {
    try {
        ensureMasterSheet();
        const wb = xlsx.readFile(MASTER_SHEET_PATH);
        const sheetName = wb.SheetNames[0];
        const ws = wb.Sheets[sheetName];
        
        let existingData = xlsx.utils.sheet_to_json(ws, { defval: '' });
        
        // Map backend sample object keys to Excel column headers
        const newRows = samples.map(s => ({
            'Encoded Code': s.encodedCode || '',
            'IS Number': s.isNumber || '',
            'Quantity': s.quantity || '1',
            'Priority': s.priorityLevel || '',
            'Received On': s.receivedOn || '',
            'Forwarded On': s.forwardedOn || '',
            'Assigned To': s.assignedTo || '',
            'Total Test': s.totalTest || '',
            'Pending Test': s.pendingTest || '',
            'Approved Test': s.approvedTest || ''
        }));

        const updatedData = [...existingData, ...newRows];
        const newWs = xlsx.utils.json_to_sheet(updatedData);
        
        wb.Sheets[sheetName] = newWs;
        xlsx.writeFile(wb, MASTER_SHEET_PATH);
        console.log(`Successfully appended ${samples.length} samples to Master Sheet.`);
    } catch (err) {
        console.error('Error appending to Master Sheet:', err);
    }
}

/**
 * Updates a single assignment in the Master Sheet.
 * @param {string} encodedCode 
 * @param {string} assignedUsername 
 */
function updateAssignmentInMaster(encodedCode, assignedUsername) {
    updateBulkAssignmentsInMaster([{ encodedCode, assignedUsername }]);
}

/**
 * Updates multiple assignments in the Master Sheet.
 * @param {Array} updates - Array of { encodedCode, assignedUsername }
 */
function updateBulkAssignmentsInMaster(updates) {
    try {
        if (!updates || updates.length === 0) return;
        ensureMasterSheet();
        
        const wb = xlsx.readFile(MASTER_SHEET_PATH);
        const sheetName = wb.SheetNames[0];
        const ws = wb.Sheets[sheetName];
        
        let existingData = xlsx.utils.sheet_to_json(ws, { defval: '' });
        let updatedCount = 0;
        
        // Create lookup map for faster processing
        const updateMap = {};
        updates.forEach(u => updateMap[u.encodedCode] = u.assignedUsername);

        existingData = existingData.map(row => {
            const code = row['Encoded Code'];
            if (code && updateMap[code] !== undefined) {
                row['Assigned To'] = updateMap[code];
                updatedCount++;
            }
            return row;
        });

        if (updatedCount > 0) {
            const newWs = xlsx.utils.json_to_sheet(existingData);
            wb.Sheets[sheetName] = newWs;
            xlsx.writeFile(wb, MASTER_SHEET_PATH);
            console.log(`Successfully updated ${updatedCount} assignments in Master Sheet.`);
        }
    } catch (err) {
        console.error('Error updating assignments in Master Sheet:', err);
    }
}

module.exports = {
    appendSamplesToMaster,
    updateAssignmentInMaster,
    updateBulkAssignmentsInMaster
};
