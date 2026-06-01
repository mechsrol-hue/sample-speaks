const fs = require('fs');
const path = require('path');

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const FormData = require('form-data');

async function testUpload() {
    try {
        const formData = new FormData();
        formData.append('file', fs.createReadStream(path.join(__dirname, 'Sample Speaks.xlsx')));
        
        const response = await fetch('http://localhost:3000/api/upload', {
            method: 'POST',
            body: formData,
            headers: formData.getHeaders()
        });
        
        const text = await response.text();
        console.log('Status:', response.status);
        console.log('Response:', text);
    } catch (e) {
        console.error('Error:', e);
    }
}

testUpload();
