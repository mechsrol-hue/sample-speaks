const fs = require('fs');

async function testUpload() {
    try {
        const fileBuffer = fs.readFileSync('PENDING SAMPLE MINISTRY MECH COPY.xlsx');
        const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
        let body = '';
        body += '--' + boundary + '\r\n';
        body += 'Content-Disposition: form-data; name="file"; filename="PENDING SAMPLE MINISTRY MECH COPY.xlsx"\r\n';
        body += 'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n';

        const tail = '\r\n--' + boundary + '--\r\n';

        const payload = Buffer.concat([
            Buffer.from(body, 'utf8'),
            fileBuffer,
            Buffer.from(tail, 'utf8')
        ]);

        const fetch = (await import('node-fetch')).default;
        
        const res = await fetch('http://localhost:3000/api/upload', {
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`
            },
            body: payload
        });
        
        const text = await res.text();
        console.log("Status:", res.status);
        console.log("Response:", text);
    } catch (e) {
        console.error("Client Error:", e);
    }
}
testUpload();
