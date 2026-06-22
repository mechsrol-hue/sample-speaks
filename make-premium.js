require('dotenv').config();
const supabase = require('./database-supabase');

async function syncEmployees() {
    console.log("Fetching users...");
    const { data: users, error: uErr } = await supabase.from('users').select('*').in('role', ['tp', 'ta', 'lo']);
    if (uErr) return console.error(uErr);

    console.log("Fetching employee profiles...");
    const { data: profiles, error: pErr } = await supabase.from('employee_profiles').select('*');
    if (pErr) return console.error(pErr);

    const existingUserIds = new Set(profiles.map(p => p.userId));
    
    let added = 0;
    for (const user of users) {
        if (!existingUserIds.has(user.id)) {
            const { error: insErr } = await supabase.from('employee_profiles').insert({
                userId: user.id,
                fullName: user.username,
                designation: user.role.toUpperCase(),
                maxDailySamples: 40
            });
            if (insErr) {
                console.error("Failed for user", user.username, insErr.message);
            } else {
                console.log("Created employee profile for", user.username);
                added++;
            }
        }
    }
    console.log(`Finished. Added ${added} employee profiles.`);
}

syncEmployees();
