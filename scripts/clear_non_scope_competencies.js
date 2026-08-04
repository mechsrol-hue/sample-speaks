#!/usr/bin/env node
/**
 * Remove competencies that did NOT come from an approved IS Scope submission —
 * the rows Scope Control → By standard → Approved lists under "Testable, but not
 * approved here". They were set in the Employee Hub or imported from sample
 * history; on a lab starting its declarations from scratch they are demo residue.
 *
 *   node scripts/clear_non_scope_competencies.js            # show what would go
 *   node scripts/clear_non_scope_competencies.js --write    # delete them
 *   node scripts/clear_non_scope_competencies.js --restore <backup.json>
 *
 * THIS CHANGES WHO GETS GIVEN WORK. Auto-assign matches samples to people by
 * competency, so a person loses every standard removed here until it is declared
 * and approved again. Every run backs up first and --restore puts it all back.
 *
 * A competency is KEPT when an approved is_scope_tp_* submission from that same
 * employee covers the same base IS number.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const supabase = require('../database-supabase');

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
        const rows = JSON.parse(fs.readFileSync(file, 'utf8')).competencies || [];
        if (!rows.length) { console.log('Backup holds no competencies.'); return; }
        const { error } = await supabase.from('employee_competencies').insert(rows);
        if (error) throw new Error(error.message);
        console.log(`Restored ${rows.length} competency row(s).`);
        return;
    }

    const write = args.includes('--write');

    const [{ data: comps }, { data: profiles }, { data: prefs }] = await Promise.all([
        supabase.from('employee_competencies').select('id, employeeId, isNumber, proficiencyLevel, avgTestDurationHours'),
        supabase.from('employee_profiles').select('id, userId, fullName'),
        supabase.from('system_preferences').select('key, value').like('key', 'is_scope_tp_%')
    ]);

    const profileById = new Map((profiles || []).map(p => [p.id, p]));

    // employee + base IS number pairs that an approval here produced.
    const approvedKeys = new Set();
    for (const p of (prefs || [])) {
        let sub;
        try { sub = JSON.parse(p.value); } catch (_) { continue; }
        if (sub.status !== 'approved') continue;
        for (const n of (sub.isNumbers || [])) approvedKeys.add(`${sub.userId}|${normalizeISNumber(n)}`);
    }

    const doomed = [];
    const kept = [];
    for (const c of (comps || [])) {
        const prof = profileById.get(c.employeeId);
        const key = `${prof ? prof.userId : '?'}|${normalizeISNumber(c.isNumber)}`;
        (approvedKeys.has(key) ? kept : doomed).push({ ...c, who: (prof && prof.fullName) || `Employee #${c.employeeId}` });
    }

    console.log(`Competencies scanned: ${(comps || []).length}`);
    console.log(`\nWould remove — not approved through IS Scope: ${doomed.length}`);
    for (const c of doomed) {
        console.log(`  · ${String(c.who).padEnd(28)} ${String(c.isNumber).padEnd(26)} ${c.proficiencyLevel || ''}`);
    }
    console.log(`\nWould keep — approved through IS Scope: ${kept.length}`);
    for (const c of kept) {
        console.log(`  · ${String(c.who).padEnd(28)} ${String(c.isNumber).padEnd(26)} ${c.proficiencyLevel || ''}`);
    }

    if (!doomed.length) { console.log('\nNothing to remove.'); return; }

    if (!write) {
        console.log('\nDry run — nothing deleted. Re-run with --write to apply.');
        return;
    }

    const dir = path.join(__dirname, 'data');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(dir, `non_scope_competencies_backup_${stamp}.json`);
    fs.writeFileSync(backupFile, JSON.stringify({
        competencies: doomed.map(({ id, who, ...rest }) => rest)
    }, null, 2));
    console.log(`\nBacked up → ${backupFile}`);

    const { error } = await supabase.from('employee_competencies').delete().in('id', doomed.map(c => c.id));
    if (error) throw new Error(error.message);
    console.log(`Deleted ${doomed.length} competency row(s). Auto-assign no longer matches those people to those standards.`);
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
