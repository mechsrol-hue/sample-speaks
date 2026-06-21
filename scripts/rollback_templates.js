// One-shot rollback: restore every template_IS* from its template_backup_IS*
// snapshot written by audit_templates.js --commit. Run: node scripts/rollback_templates.js
const supabase = require('../database-supabase');

(async () => {
    const { data: backups } = await supabase.from('system_preferences').select('key, value').like('key', 'template_backup_IS%');
    if (!backups || !backups.length) { console.log('No backups found — nothing to roll back.'); return; }
    for (const b of backups) {
        const is = b.key.replace('template_backup_', '');
        let parsed = null;
        try { parsed = JSON.parse(b.value); } catch (_) {}
        if (parsed && parsed.__absent) {
            // Template did not exist before --commit: remove it entirely.
            await supabase.from('system_preferences').delete().eq('key', `template_${is}`);
            console.log(`Deleted template_${is} (was newly created — no original to restore)`);
        } else {
            await supabase.from('system_preferences').upsert({ key: `template_${is}`, value: b.value }, { onConflict: 'key' });
            console.log(`Restored template_${is} from backup`);
        }
    }
    console.log(`\nRolled back ${backups.length} templates.`);
})();
