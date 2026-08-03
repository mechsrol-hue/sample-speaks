#!/usr/bin/env node
/**
 * Import the SRL LIMS scope list (261 standards) into IS Intelligence + IS Scope.
 *
 *   node scripts/import_srl_scope.js --preview        show what would be added, write nothing
 *   node scripts/import_srl_scope.js --import         add the missing standards, UNCATEGORISED
 *   node scripts/import_srl_scope.js --import --file  also auto-file them by keyword (opt-in)
 *   node scripts/import_srl_scope.js --undo           remove exactly what --import added
 *
 * Standards import UNFILED by default: sectioning is a judgement call the lab makes, and a
 * keyword guess that looks authoritative is worse than an obviously empty field. Pass --file
 * only if you want the keyword split as a starting point.
 *
 * Source: https://lims.bis.gov.in/home_lab_scope/10/ (all 9 pages), captured to
 * scripts/data/srl_scope_261.json. Re-capture that file to refresh.
 *
 * Standards land as name-only vault rows (no clauses, no limits, no report format) —
 * enough for TPs to declare what they test. Running the normal PDF extraction on any of
 * them later fills in the same row.
 *
 * --undo is exact: it removes only rows this script created, identified by the marker
 * below, and never touches an extracted standard even if the IS numbers match.
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const supabase = require('../database-supabase');

const SOURCE = path.join(__dirname, 'data', 'srl_scope_261.json');
const MARKER = '(SRL LIMS scope — not extracted)';   // goes in pdfFileName; --undo keys off it
const SECTIONS_KEY = 'is_scope_sections';
const MAP_KEY = 'is_scope_section_map';

// Same standard written two ways: LIMS "IS 4985 (2021)" vs vault "IS 4985:2021".
// Year is kept — IS 4246 (2002) and IS 4246 (2025) are different revisions.
const key = s => String(s || '').toUpperCase()
    .replace(/[()\[\]:,.]/g, ' ').replace(/\bPART\s+/g, 'PART').replace(/\s+/g, ' ').trim();

// Section rules, applied in order — first match wins, so the specific ones come first.
// Plurals are explicit (`stoves?`): "Domestic gas stoves" must not slip past `\bstove\b`.
// Anything unmatched goes to Miscellaneous rather than being guessed into a section a TP
// would then be wrongly offered.
const RULES = [
    // Stoves before everything — an LPG stove is a stove, not a metal fabrication.
    ['Gas Stove', /\b(gas stoves?|stoves?|hobs?|burners?)\b/i],

    // Metal FIRST where the product itself is metal, even if the title mentions cement:
    // "Cast iron specials for asbestos cement pressure pipes" is a metal casting.
    ['Metal', /\b(cast iron|ductile iron|grey iron|malleable (cast )?iron|stainless steel|steel|aluminium|aluminum|brass|bronze|copper|zinc|nickel|silver|gold)\b/i],

    ['Cement', /\b(cements?|concrete|standard sand|masonry)\b/i],

    // Cables and cords are tested as cables, not as plastics, even though they are
    // PVC/XLPE insulated — so they fall through to Miscellaneous.
    ['Plastic', /\b(pvc|pvc-u|upvc|polyvinyl|polyethylene|hdpe|plastics?|polyurethane|thermoplastic|polypropylene|blow moulded|injection moulded)\b/i],

    // Broader metal catch-all for products named by form rather than by alloy.
    ['Metal', /\b(wires?|tubes?|tubulars?|cylinders?|castings?|ingots?|drums?|hinges?|bolts?|screws?|conductors?|strands?|chequered plates?)\b/i],
];

// Titles that say what a product is NOT. "(Other Than Plastic Cisterns)" was matching
// the Plastic rule on the very word that excludes it.
const NEGATIVE = [
    ['Plastic', /other than plastic/i],
];

const classify = (isNumber, title) => {
    const hay = `${isNumber} ${title}`;
    for (const [section, re] of RULES) {
        if (!re.test(hay)) continue;
        if (NEGATIVE.some(([s, nre]) => s === section && nre.test(hay))) continue;
        return section;
    }
    return 'Miscellaneous';
};

async function readPref(k, fallback) {
    const { data } = await supabase.from('system_preferences').select('value').eq('key', k).maybeSingle();
    if (!data || !data.value) return fallback;
    try { return JSON.parse(data.value); } catch (_) { return fallback; }
}
async function writePref(k, v) {
    const { error } = await supabase.from('system_preferences')
        .upsert({ key: k, value: JSON.stringify(v) }, { onConflict: 'key' });
    if (error) throw new Error(error.message);
}

async function plan() {
    const rows = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
    const { data: vault } = await supabase.from('is_standards_vault').select('isNumber');
    const have = new Map((vault || []).map(v => [key(v.isNumber), v.isNumber]));

    const fresh = [], already = [];
    const seen = new Set();
    for (const r of rows) {
        const k = key(r.isNumber);
        if (have.has(k)) { already.push({ ...r, existingAs: have.get(k) }); continue; }
        if (seen.has(k)) continue;
        seen.add(k);
        fresh.push({ ...r, section: classify(r.isNumber, r.title) });
    }
    return { rows, fresh, already };
}

function printSplit(fresh) {
    const by = {};
    fresh.forEach(f => (by[f.section] = by[f.section] || []).push(f));
    for (const s of ['Plastic', 'Metal', 'Cement', 'Gas Stove', 'Miscellaneous']) {
        if (!by[s]) continue;
        console.log(`\n  ${s} (${by[s].length})`);
        by[s].slice(0, 6).forEach(f => console.log(`    ${f.isNumber.padEnd(26)} ${f.title.slice(0, 52)}`));
        if (by[s].length > 6) console.log(`    … and ${by[s].length - 6} more`);
    }
}

(async () => {
    const mode = process.argv[2];

    if (mode === '--preview' || mode === '--import') {
        const { rows, fresh, already } = await plan();
        console.log(`source: ${rows.length} standards from the SRL scope list`);
        console.log(`already in the app: ${already.length}`);
        already.forEach(a => console.log(`    ${a.isNumber.padEnd(26)} → have it as ${a.existingAs}`));
        console.log(`to add: ${fresh.length}`);
        printSplit(fresh);

        if (mode === '--preview') { console.log('\n(preview only — nothing written)'); return; }

        const now = new Date().toISOString();
        const payload = fresh.map(f => ({
            isNumber: f.isNumber,
            title: f.title,
            pdfFileName: MARKER,
            uploadedAt: now,
            confidenceScore: null,
            testParameters: JSON.stringify({ flat: [], sections: [], referenced_standards: [] }),
            uncertainItems: JSON.stringify([]),
            extractedClauses: JSON.stringify([]),
            extractedTables: JSON.stringify([]),
            isFullyResolved: false
        }));

        // Insert in chunks — one 252-row insert is a single point of failure.
        let inserted = 0;
        for (let i = 0; i < payload.length; i += 50) {
            const chunk = payload.slice(i, i + 50);
            const { error } = await supabase.from('is_standards_vault').insert(chunk);
            if (error) throw new Error(`chunk at ${i}: ${error.message}`);
            inserted += chunk.length;
            process.stdout.write(`\r  inserted ${inserted}/${payload.length}`);
        }
        console.log('');

        if (process.argv.includes('--file')) {
            const sections = await readPref(SECTIONS_KEY, ['Plastic', 'Metal', 'Gas Stove', 'Cement', 'Miscellaneous']);
            for (const s of new Set(fresh.map(f => f.section))) if (!sections.includes(s)) sections.push(s);
            await writePref(SECTIONS_KEY, sections);

            const map = await readPref(MAP_KEY, {});
            for (const f of fresh) map[f.isNumber] = f.section;
            await writePref(MAP_KEY, map);
            console.log(`\nDone. ${inserted} standards added and filed by keyword.`);
        } else {
            console.log(`\nDone. ${inserted} standards added, all uncategorised.`);
            console.log('File them under Admin Control ▸ IS Scope Control ▸ 1 · File standards.');
        }
        console.log('Check them under Admin Control ▸ IS Scope Control ▸ 1 · File standards.');
        console.log('Undo with: node scripts/import_srl_scope.js --undo');
        return;
    }

    if (mode === '--undo') {
        const { data: mine } = await supabase.from('is_standards_vault')
            .select('id, isNumber').eq('pdfFileName', MARKER);
        if (!mine || !mine.length) { console.log('Nothing to undo — no rows carry the import marker.'); return; }

        const map = await readPref(MAP_KEY, {});
        for (const r of mine) delete map[r.isNumber];
        await writePref(MAP_KEY, map);

        for (let i = 0; i < mine.length; i += 50) {
            const ids = mine.slice(i, i + 50).map(r => r.id);
            const { error } = await supabase.from('is_standards_vault').delete().in('id', ids);
            if (error) throw new Error(error.message);
        }
        console.log(`Removed ${mine.length} imported standards and their filing.`);
        return;
    }

    console.log('Usage: node scripts/import_srl_scope.js --preview | --import | --undo');
    process.exit(1);
})().catch(e => { console.error('\nFailed:', e.message); process.exit(1); });
