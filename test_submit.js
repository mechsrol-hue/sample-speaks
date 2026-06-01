const http = require('http');

const data = JSON.stringify({
    id: 1,
    passFail: 'Pass'
});

const req = http.request('http://localhost:3000/api/submit-sample', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
    }
}, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
        console.log('Response:', res.statusCode, body);
    });
});

req.on('error', console.error);
req.write(data);
req.end();
