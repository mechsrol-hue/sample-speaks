require('dotenv').config();
const supabase = require('./database-supabase');

async function seed() {
    console.log("Checking Supabase for Super Admin...");
    const { data: existing, error: checkErr } = await supabase
        .from('users')
        .select('*')
        .eq('username', 'Super Admin')
        .single();

    if (!existing) {
        console.log('Super Admin not found in Supabase. Inserting...');
        const { data, error } = await supabase
            .from('users')
            .insert([{ username: 'Super Admin', password: 'superadmin123', role: 'super_admin' }]);
            
        if (error) {
            console.error('Failed to insert:', error);
        } else {
            console.log('Successfully inserted Super Admin to Supabase.');
        }
    } else {
        console.log('Super Admin already exists in Supabase. Updating password and role just in case...');
        const { data, error } = await supabase
            .from('users')
            .update({ password: 'superadmin123', role: 'super_admin' })
            .eq('username', 'Super Admin');
            
        if (error) {
            console.error('Failed to update:', error);
        } else {
            console.log('Successfully updated Super Admin in Supabase.');
        }
    }
}

seed();
