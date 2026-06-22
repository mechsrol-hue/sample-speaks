const http = require('http');

const data = JSON.stringify({
  isNumber: "4985",
  templateData: { totalHours: 42, activeClauses: {} }
});

const req = http.request({
  hostname: 'localhost',
  port: 3005,
  path: '/api/admin/templates',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data)
  }
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => console.log('Status:', res.statusCode, 'Body:', body));
});

req.on('error', (e) => console.error(e));
req.write(data);
req.end();
