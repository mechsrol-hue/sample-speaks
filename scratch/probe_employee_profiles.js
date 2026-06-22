// Diagnose why employee_profiles returns 0 rows in /api/copilot/chat.
// Distinguishes: missing column (error), RLS filtering (0 rows + no error), empty table.
require('dotenv').config();
const supabase = require('../database-supabase');

(async () => {
    console.log('client url:', supabase.supabaseUrl);
    console.log('key prefix:', String(supabase.supabaseKey).slice(0, 20) + '...');
    console.log('env SUPABASE_URL set:', !!process.env.SUPABASE_URL);
    console.log('env SUPABASE_SERVICE_ROLE_KEY set:', !!process.env.SUPABASE_SERVICE_ROLE_KEY);
    console.log('env SUPABASE_ANON_KEY set:', !!process.env.SUPABASE_ANON_KEY);

    // 1. The exact query the copilot endpoint runs (it discards `error`!)
    const q1 = await supabase.from('employee_profiles').select('fullName, role');
    console.log('\n[1] select fullName, role');
    console.log('    rows:', (q1.data || []).length, '| status:', q1.status);
    console.log('    error:', q1.error ? JSON.stringify(q1.error) : 'none');

    // 2. Select everything to see real columns
    const q2 = await supabase.from('employee_profiles').select('*').limit(3);
    console.log('\n[2] select * limit 3');
    console.log('    rows:', (q2.data || []).length, '| status:', q2.status);
    console.log('    error:', q2.error ? JSON.stringify(q2.error) : 'none');
    if (q2.data && q2.data.length) {
        console.log('    columns:', Object.keys(q2.data[0]).join(', '));
        console.log('    sample row:', JSON.stringify(q2.data[0]));
    }

    // 3. Exact row count (head request)
    const q3 = await supabase.from('employee_profiles').select('id', { count: 'exact', head: true });
    console.log('\n[3] count head request');
    console.log('    count:', q3.count, '| status:', q3.status);
    console.log('    error:', q3.error ? JSON.stringify(q3.error) : 'none');

    // 4. A table known to work, for comparison (samples loads fine in the app)
    const q4 = await supabase.from('samples').select('id', { count: 'exact', head: true });
    console.log('\n[4] samples count (control)');
    console.log('    count:', q4.count, '| error:', q4.error ? JSON.stringify(q4.error) : 'none');
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
