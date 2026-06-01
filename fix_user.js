require('dotenv').config();
const supabase = require('./database-supabase');

async function fixUser() {
    console.log("Fixing username for ID 44...");
    const { error } = await supabase
        .from('users')
        .update({ username: 'Saurabhd' })
        .eq('id', 44);
        
    if (error) {
        console.error('Error fixing user:', error);
    } else {
        console.log('Successfully fixed username to Saurabhd');
    }
}

fixUser();
