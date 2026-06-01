require('dotenv').config();
const supabase = require('./database-supabase');

async function deleteTestUser() {
    console.log("Deleting Saurabhd...");
    
    const { error } = await supabase
        .from('users')
        .delete()
        .eq('username', 'Saurabhd');
        
    if (error) {
        console.error('Failed to delete:', error);
    } else {
        console.log('Successfully deleted Saurabhd.');
    }
}

deleteTestUser();
