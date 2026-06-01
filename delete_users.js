require('dotenv').config();
const supabase = require('./database-supabase');

async function deleteUsers() {
    console.log("Fetching users from Supabase...");
    
    // The neq and not.in operators can be used, or we just fetch all and delete by ID
    const { data: users, error: fetchErr } = await supabase
        .from('users')
        .select('id, username, role');
        
    if (fetchErr) {
        console.error('Error fetching users:', fetchErr);
        return;
    }
    
    console.log(`Found ${users.length} users.`);
    
    for (const user of users) {
        if (user.username === 'Admin' || user.username === 'Super Admin') {
            console.log(`Skipping ${user.username} (${user.role})`);
            continue;
        }
        
        console.log(`Deleting user: ${user.username} (${user.role})...`);
        const { error: deleteErr } = await supabase
            .from('users')
            .delete()
            .eq('id', user.id);
            
        if (deleteErr) {
            console.error(`Failed to delete ${user.username}:`, deleteErr);
        } else {
            console.log(`Successfully deleted ${user.username}.`);
        }
    }
    
    console.log("Cleanup complete!");
}

deleteUsers();
