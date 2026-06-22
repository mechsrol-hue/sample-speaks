const supabase = require('./database-supabase');
async function test() {
    console.log("Fetching tables...");
    // Try to query a non-existent table just to see the response
    const { data, error } = await supabase.from('non_existent_table').select('*').limit(1);
    console.log(error);
}
test();
