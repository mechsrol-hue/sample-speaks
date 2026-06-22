const supabase = require('../database-supabase');

async function getOpenAPI() {
    try {
        const url = `${supabase.supabaseUrl}/rest/v1/?apikey=${supabase.supabaseKey}`;
        const res = await fetch(url);
        if (res.ok) {
            const data = await res.json();
            console.log('Tables in schema:', Object.keys(data.definitions || {}));
            console.log('Paths available:', Object.keys(data.paths || {}));
        } else {
            console.error('Failed to fetch OpenAPI schema:', res.status, await res.text());
        }
    } catch(err) {
        console.error('Error:', err);
    }
}

getOpenAPI();
