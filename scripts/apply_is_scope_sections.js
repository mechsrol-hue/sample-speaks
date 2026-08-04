#!/usr/bin/env node
/**
 * Write the lab's own section filing into system_preferences, so the app's section
 * list *is* the lab's list rather than a code-level default the admin can't see.
 *
 * Until this runs, sections come from server/is-scope-defaults.js at read time —
 * correct, but invisible in IS Scope Control → "1 · File standards", so an admin
 * can't tell what is filed where or change it. This makes the filing explicit and
 * editable in the UI.
 *
 *   node scripts/apply_is_scope_sections.js            # show what would change
 *   node scripts/apply_is_scope_sections.js --write    # apply it
 *   node scripts/apply_is_scope_sections.js --restore <backup.json>
 *
 * A timestamped backup of the previous values is always written before --write.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { DEFAULT_SECTIONS, defaultSectionFor } = require('../server/is-scope-defaults');

const SECTIONS_KEY = 'is_scope_sections';
const MAP_KEY = 'is_scope_section_map';

// Same client the app uses, so this writes to exactly the database the app reads.
const supabase = require('../database-supabase');

async function readPref(key, fallback) {
    const { data, error } = await supabase.from('system_preferences').select('value').eq('key', key).maybeSingle();
    if (error) throw new Error(`${key}: ${error.message}`);
    if (!data || !data.value) return fallback;
    try { return JSON.parse(data.value); } catch (e) { return fallback; }
}

async function writePref(key, value) {
    const { error } = await supabase.from('system_preferences')
        .upsert({ key, value: JSON.stringify(value) }, { onConflict: 'key' });
    if (error) throw new Error(`${key}: ${error.message}`);
}

async function main() {
    const args = process.argv.slice(2);
    const restoreIdx = args.indexOf('--restore');
    if (restoreIdx !== -1) {
        const file = args[restoreIdx + 1];
        if (!file) throw new Error('--restore needs a backup file path.');
        const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
        await writePref(SECTIONS_KEY, backup.sections);
        await writePref(MAP_KEY, backup.sectionMap);
        console.log(`Restored ${Object.keys(backup.sectionMap || {}).length} filings and ${(backup.sections || []).length} sections from ${file}`);
        return;
    }

    const write = args.includes('--write');

    const { data: vault, error } = await supabase.from('is_standards_vault').select('isNumber');
    if (error) throw new Error(error.message);

    const prevSections = await readPref(SECTIONS_KEY, []);
    const prevMap = await readPref(MAP_KEY, {});

    // Anything the admin already filed by hand wins — this only fills the gaps.
    const nextMap = { ...prevMap };
    let filled = 0;
    const perSection = {};
    for (const row of (vault || [])) {
        const already = prevMap[row.isNumber];
        const fromSheet = defaultSectionFor(row.isNumber);
        const section = already || fromSheet;
        if (!section) continue;
        if (!already) { nextMap[row.isNumber] = section; filled++; }
        perSection[section] = (perSection[section] || 0) + 1;
    }

    // Sections the lab uses, plus any section still holding standards, so nothing
    // that has filings under it disappears from the picker.
    const inUse = [...new Set(Object.values(nextMap).filter(Boolean))];
    const nextSections = [...new Set([...DEFAULT_SECTIONS, ...inUse])];

    const dropped = prevSections.filter(s => !nextSections.includes(s));

    console.log('Vault standards           :', (vault || []).length);
    console.log('Already filed by admin    :', Object.keys(prevMap).length);
    console.log('Newly filed from the sheet:', filled);
    console.log('Unfiled after this        :', (vault || []).length - Object.keys(nextMap).length);
    console.log('\nPer section:');
    for (const [s, n] of Object.entries(perSection).sort((a, b) => b[1] - a[1])) {
        console.log('  ', s.padEnd(16), n);
    }
    console.log('\nSections before:', prevSections.join(', ') || '(none stored)');
    console.log('Sections after :', nextSections.join(', '));
    if (dropped.length) console.log('Dropped (no standards filed under them):', dropped.join(', '));

    if (!write) {
        console.log('\nDry run — nothing written. Re-run with --write to apply.');
        return;
    }

    const dir = path.join(__dirname, 'data');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = path.join(dir, `is_scope_backup_${stamp}.json`);
    fs.writeFileSync(backupFile, JSON.stringify({ sections: prevSections, sectionMap: prevMap }, null, 2));
    console.log(`\nBacked up previous values → ${backupFile}`);

    await writePref(MAP_KEY, nextMap);
    await writePref(SECTIONS_KEY, nextSections);
    console.log('Written. IS Scope Control → "1 · File standards" now shows this filing, and it is editable there.');
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
