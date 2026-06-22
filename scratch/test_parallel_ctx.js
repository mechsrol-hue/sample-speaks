// Validates the new parallel DB-context block in /api/copilot/chat returns the right shapes
require('dotenv').config();
const supabase = require('../database-supabase');
const { getOicPreferences } = require('../server/agent/disha-utils');

(async () => {
    const tDb = Date.now();
    const [
        { data: allPending },
        { data: employees },
        { count: templatesCount },
        { data: openNotifications },
        { data: pendingRecs },
        oicPrefs,
    ] = await Promise.all([
        supabase
            .from('samples')
            .select('id, encodedCode, assignedTo, isNumber, priorityLevel, receivedOn')
            .in('appStatus', ['Pending'])
            .order('receivedOn', { ascending: true }),
        supabase
            .from('employee_profiles')
            .select('fullName, designation, isActive'),
        supabase
            .from('system_preferences')
            .select('key', { count: 'exact', head: true })
            .like('key', 'template_%'),
        supabase
            .from('lab_notifications')
            .select('id, type, severity, title, created_at')
            .eq('status', 'open')
            .order('created_at', { ascending: false })
            .limit(10),
        supabase
            .from('assignment_recommendations')
            .select('id, sampleId, recommendedEmployeeName, reason, score')
            .eq('status', 'pending')
            .limit(50),
        getOicPreferences(),
    ]);
    console.log('parallel fetch took', Date.now() - tDb, 'ms');
    console.log('pending samples:', (allPending || []).length);
    console.log('employees:', (employees || []).length);
    console.log('templates count:', templatesCount);
    console.log('open notifications:', (openNotifications || []).length);
    console.log('pending recs:', (pendingRecs || []).length);
    console.log('oicPrefs type:', typeof oicPrefs, '| keys:', Object.keys(oicPrefs || {}).length);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
