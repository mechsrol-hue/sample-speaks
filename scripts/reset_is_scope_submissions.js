#!/usr/bin/env node
/**
 * Clear the IS Scope review queue so TPs can declare again from scratch.
 *
 *   node scripts/reset_is_scope_submissions.js            # show what would go
 *   node scripts/reset_is_scope_submissions.js --write    # delete them
 *   node scripts/reset_is_scope_submissions.js --restore <backup.json>
 *
 * Deletes only the submissions (system_preferences rows keyed is_scope_tp_*).
 *
 * It deliberately does NOT touch employee_competencies. Those are what an approval
 * produced and what auto-assign reads — wiping them would silently change who gets
 * given work, which is a different decision from clearing the queue. Pass
 * --with-competencies to remove the ones these submissions created as well.
 *
 * Every run writes a timestamped backup first, and --restore puts it all back.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const supabase = require('../database-supabase');

const PREFIX = 'is_scope_tp_';

function normalizeISNumber(isStr) {
    if (!isStr) return '';
    const match = isStr.toString().match(/IS\s*\d+/i);
    return match ? match[0].toUpperCase().replace(/\s+/g, ' ') : isStr.trim();
}

async function main() {
    const args = process.argv.slice(2);

    const restoreIdx = args.indexOf('--restore');
    if (restoreIdx !== -1) {
        const file = args[restoreIdx + 1];
        if (!file) throw new Error('--restore needs a backup file path.');
        const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const row of backup.submissions || []) {
            const { error } = await supabase.from('system_preferences')
                .upsert({ key: row.key, value: row.value }, { onConflict: 'key' });
            if (error) throw new Error(error.message);
        }
        if ((backup.competencies || []).length) {
            const { error } = await supabase.from('employee_competencies').insert(backup.competencies);
            if (error) throw new Error(`Competencies: ${error.message}`);
        }
        console.log(`Restored ${(backup.submissions || []).length} submission(s) and ${(backup.competencies || []).length} competency row(s).`);
        return;
    }

    const write = args.includes('--write');
    const withComps = args.includes('--with-competencies');

    const { data: rows, error } = await supabase
        .from('system_preferences').select('key, value').like('key', `${PREFIX}%`);
    if (error) throw new Error(error.message);

    const parsed = (rows || []).map(r => {
        let sub = null;
        try { sub = JSON.parse(r.value); } catch (_) {}
        return { key: r.key, value: r.value, sub };
    });

    console.log(`Submissions in the queue: ${parsed.length}\n`);
    for (const { sub } of parsed) {
        if (!sub) { console.log('  (unreadable row)'); continue; }
        console.log(`  ${String(sub.username || sub.userId).padEnd(26)} ${String(sub.status).padEnd(9)} ${(sub.sections || []).join(', ').padEnd(16)} ${(sub.isNumbers || []).length} IS${sub.competenciesAdded ? ` · +${sub.competenciesAdded} competencies` : ''}`);
    }

    // Competencies these approvals produced, so the report is honest about what
    // survives the reset.
    const approved = parsed.filter(p => p.sub && p.sub.status === 'approved');
    let compRows = [];
    if (approved.length) {
        const userIds = approved.map(p => p.sub.userId);
        const { data: profiles } = await supabase
            .from('employee_profiles').select('id, userId, fullName').in('userId', userIds);
        const byUser = new Map((profiles || []).map(p => [String(p.userId), p]));
        const { data: comps } = await supabase
            .from('employee_competencies').select('id, employeeId, isNumber, proficiencyLevel, avgTestDurationHours');
        for (const p of approved) {
            const prof = byUser.get(String(p.sub.userId));
            if (!prof) continue;
            const declared = new Set((p.sub.isNumbers || []).map(normalizeISNumber));
            compRows.push(...(comps || []).filter(c =>
                c.employeeId === prof.id && declared.has(normalizeISNumber(c.isNumber))));
        }
    }
    console.log(`\nCompetencies created by approved submissions: ${compRows.length}`);
    console.log(withComps
        ? '  --with-competencies given: these will be deleted too.'
        : '  These will be KEPT. Auto-assign continues to use them. Pass --with-competencies to remove them.');

    if (!write) {
        console.log('\nDry run — nothing deleted. Re-run with --write to apply.');
        return;
    }

    const dir = path.join(__dirname, 'data');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(dir, `is_scope_submissions_backup_${stamp}.json`);
    fs.writeFileSync(backupFile, JSON.stringify({
        submissions: parsed.map(({ key, value }) => ({ key, value })),
        competencies: withComps ? compRows.map(({ id, ...rest }) => rest) : []
    }, null, 2));
    console.log(`\nBacked up → ${backupFile}`);

    if (withComps && compRows.length) {
        const { error: cErr } = await supabase
            .from('employee_competencies').delete().in('id', compRows.map(c => c.id));
        if (cErr) throw new Error(`Competencies: ${cErr.message}`);
        console.log(`Deleted ${compRows.length} competency row(s).`);
    }

    const { error: delErr } = await supabase
        .from('system_preferences').delete().like('key', `${PREFIX}%`);
    if (delErr) throw new Error(delErr.message);
    console.log(`Deleted ${parsed.length} submission(s). The review queue is empty.`);
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
