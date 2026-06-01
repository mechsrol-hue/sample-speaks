require('dotenv').config();
const supabase = require('./database-supabase');

async function listUsers() {
    const { data: users, error } = await supabase
        .from('users')
        .select('id, username, password, role');
        
    if (error) {
        console.error('Error fetching users:', error);
    } else {
        console.log('Current users in Supabase:');
        console.log(JSON.stringify(users, null, 2));
    }
}

listUsers();
