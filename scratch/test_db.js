const supabase = require('../database-supabase');

async function checkTable() {
    try {
        const { data, error } = await supabase.from('equipments').select('id').limit(1);
        if (error) {
            console.log('Error selecting from equipments:', error.message);
            if (error.message.includes('relation "equipments" does not exist')) {
                console.log('Result: Table "equipments" does not exist.');
            } else {
                console.log('Result: Other error:', error);
            }
        } else {
            console.log('Result: Table "equipments" exists. Data count:', data.length);
        }
    } catch (err) {
        console.error('Exception:', err);
    }
}

checkTable();
