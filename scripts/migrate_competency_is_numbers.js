#!/usr/bin/env node
/**
 * Competencies were stored collapsed to a base number — "IS 2556" — which cannot
 * distinguish Part 2 from Part 16. This rewrites each row to the standard it
 * actually refers to, so the record says what was approved.
 *
 *   node scripts/migrate_competency_is_numbers.js            # show what would change
 *   node scripts/migrate_competency_is_numbers.js --write    # apply
 *   node scripts/migrate_competency_is_numbers.js --restore <backup.json>
 *
 * A base row is only rewritten when exactly ONE standard in the vault carries that
 * base number — there is no way to tell which of nine IS 2556 parts an "IS 2556"
 * row meant, and guessing would grant competence nobody approved. Ambiguous rows
 * are listed and left alone for a human to settle.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const supabase = require('../database-supabase');

function normalizeISNumber(isStr) {
    if (!isStr) return '';
    const m = isStr.toString().match(/IS\s*\d+/i);
    return m ? m[0].toUpperCase().replace(/\s+/g, ' ') : isStr.trim();
}

async function main() {
    const args = process.argv.slice(2);

    const restoreIdx = args.indexOf('--restore');
    if (restoreIdx !== -1) {
        const file = args[restoreIdx + 1];
        if (!file) throw new Error('--restore needs a backup file path.');
        const rows = JSON.parse(fs.readFileSync(file, 'utf8')).competencies || [];
        for (const r of rows) {
            const { error } = await supabase.from('employee_competencies')
                .update({ isNumber: r.isNumber }).eq('id', r.id);
            if (error) throw new Error(error.message);
        }
        console.log(`Restored ${rows.length} row(s) to their previous isNumber.`);
        return;
    }

    const write = args.includes('--write');

    const [{ data: comps }, { data: vault }, { data: profiles }] = await Promise.all([
        supabase.from('employee_competencies').select('id, employeeId, isNumber'),
        supabase.from('is_standards_vault').select('isNumber'),
        supabase.from('employee_profiles').select('id, fullName')
    ]);

    const nameById = new Map((profiles || []).map(p => [p.id, p.fullName]));
    const byBase = new Map();
    for (const r of (vault || [])) {
        const b = normalizeISNumber(r.isNumber);
        if (!byBase.has(b)) byBase.set(b, []);
        byBase.get(b).push(r.isNumber);
    }

    const rewrite = [];
    const ambiguous = [];
    const alreadyFine = [];

    for (const c of (comps || [])) {
        const candidates = byBase.get(normalizeISNumber(c.isNumber)) || [];
        // Already a full standard name — nothing to do.
        if (candidates.includes(c.isNumber)) { alreadyFine.push(c); continue; }
        if (candidates.length === 1) rewrite.push({ ...c, to: candidates[0] });
        else ambiguous.push({ ...c, candidates });
    }

    const who = (c) => (nameById.get(c.employeeId) || `Employee #${c.employeeId}`).padEnd(26);
    console.log(`Competencies: ${(comps || []).length}\n`);
    console.log(`Already naming a real standard: ${alreadyFine.length}`);
    console.log(`\nWould rewrite (one standard carries that base): ${rewrite.length}`);
    for (const c of rewrite) console.log(`  · ${who(c)} ${String(c.isNumber).padEnd(16)} → ${c.to}`);
    console.log(`\nAmbiguous — left alone, settle by hand: ${ambiguous.length}`);
    for (const c of ambiguous) console.log(`  · ${who(c)} ${String(c.isNumber).padEnd(16)} could be any of ${c.candidates.length}: ${c.candidates.slice(0, 4).join(' | ')}${c.candidates.length > 4 ? ' …' : ''}`);

    if (!rewrite.length) { console.log('\nNothing to rewrite.'); return; }
    if (!write) { console.log('\nDry run — nothing written. Re-run with --write to apply.'); return; }

    const dir = path.join(__dirname, 'data');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(dir, `competency_isnumbers_backup_${stamp}.json`);
    fs.writeFileSync(backupFile, JSON.stringify({
        competencies: rewrite.map(c => ({ id: c.id, isNumber: c.isNumber }))
    }, null, 2));
    console.log(`\nBacked up → ${backupFile}`);

    for (const c of rewrite) {
        const { error } = await supabase.from('employee_competencies')
            .update({ isNumber: c.to }).eq('id', c.id);
        if (error) throw new Error(`${c.isNumber}: ${error.message}`);
    }
    console.log(`Rewrote ${rewrite.length} row(s).`);
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
