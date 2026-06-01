const http = require('http');

const registerData = JSON.stringify({
    username: 'saurabhd',
    password: 'password123'
});

const reqRegister = http.request('http://localhost:3000/api/register', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(registerData)
    }
}, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
        console.log('Register Response:', res.statusCode, body);
        
        // Now test login
        const loginData = JSON.stringify({
            username: 'saurabhd',
            password: 'password123'
        });
        
        const reqLogin = http.request('http://localhost:3000/api/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(loginData)
            }
        }, (resLogin) => {
            let bodyLogin = '';
            resLogin.on('data', chunk => bodyLogin += chunk);
            resLogin.on('end', () => {
                console.log('Login Response:', resLogin.statusCode, bodyLogin);
            });
        });
        
        reqLogin.on('error', console.error);
        reqLogin.write(loginData);
        reqLogin.end();
    });
});

reqRegister.on('error', console.error);
reqRegister.write(registerData);
reqRegister.end();
