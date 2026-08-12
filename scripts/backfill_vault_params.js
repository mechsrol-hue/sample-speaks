#!/usr/bin/env node
// Backfill is_standards_vault.testParameters + dimensionData from the approved on-disk IS
// templates (public/is_templates/<slug>.json), using the SAME projection the agent-extract
// path now uses (server/agent/template-to-vault.js). This makes IS Intelligence the single
// source of truth for ALREADY-extracted standards without a costly live re-extraction:
// once the columns are populated, /params, /sync-to-master, and conformance-limit sync resolve.
//
// SAFE BY DEFAULT: dry-run (no DB writes). Pass --apply to write.
//   node scripts/backfill_vault_params.js            # dry run, shows the plan
//   node scripts/backfill_vault_params.js --apply     # writes testParameters + dimensionData
//
// Only UPDATES existing vault rows (never inserts) and only touches the testParameters +
// dimensionData columns — fully additive and reversible.
const fs = require('fs');
const path = require('path');
const supabase = require('../database-supabase');
const { agentTemplateToVaultParams } = require('../server/agent/template-to-vault');

const APPLY = process.argv.includes('--apply');
const TPL_DIR = path.join(__dirname, '..', 'public', 'is_templates');

(async () => {
    const files = fs.readdirSync(TPL_DIR).filter(f => f.endsWith('.json'));
    console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'} — ${files.length} template(s) in ${TPL_DIR}\n`);
    let updated = 0, skipped = 0, missing = 0;

    for (const f of files) {
        let tpl;
        try { tpl = JSON.parse(fs.readFileSync(path.join(TPL_DIR, f), 'utf8')); }
        catch (e) { console.log(`  ${f}: PARSE ERROR ${e.message}`); continue; }

        const isNumber = tpl.isNumber || '';
        if (!isNumber) { console.log(`  ${f}: no isNumber in template — skipped`); skipped++; continue; }

        const proj = agentTemplateToVaultParams(tpl);
        const nParams = (tpl.parameters || []).length;

        // RAG corpus: pull the whole-doc transcription if the agent left one in scratch/.
        const slug = f.replace(/\.json$/i, '');
        const transcriptPath = path.join(__dirname, '..', 'scratch', `${slug}_transcript.txt`);
        let fullText = '';
        try { if (fs.existsSync(transcriptPath)) fullText = fs.readFileSync(transcriptPath, 'utf8'); } catch (_) {}

        // Find the matching vault row (exact first, then loose).
        let { data: rows } = await supabase.from('is_standards_vault')
            .select('id, isNumber, testParameters').eq('isNumber', isNumber).limit(1);
        if (!rows || !rows.length) {
            const loose = isNumber.replace(/[^a-zA-Z0-9 ]/g, '%');
            ({ data: rows } = await supabase.from('is_standards_vault')
                .select('id, isNumber, testParameters').ilike('isNumber', `%${loose}%`).order('uploadedAt', { ascending: false }).limit(1));
        }
        if (!rows || !rows.length) {
            console.log(`  ${isNumber.padEnd(20)} — NO VAULT ROW (extract it first or it'll appear on next extraction)`);
            missing++; continue;
        }

        const row = rows[0];
        let existingFlat = 0;
        try { const tp = typeof row.testParameters === 'string' ? JSON.parse(row.testParameters || 'null') : row.testParameters; existingFlat = (tp && tp.flat ? tp.flat.length : (Array.isArray(tp) ? tp.length : 0)); } catch (_) {}

        console.log(`  ${isNumber.padEnd(20)} vault#${String(row.id).padEnd(5)} params=${String(nParams).padStart(2)} -> flatRows=${String(proj.flat.length).padStart(3)}  (existing flat: ${existingFlat}, fullText: ${fullText ? fullText.length + ' chars' : 'none'})`);

        if (APPLY) {
            const payload = {
                testParameters: JSON.stringify({ version: 3, flat: proj.flat, sections: proj.sections, referenced_standards: proj.referenced_standards }),
                dimensionData: JSON.stringify({ parameterizationDims: tpl.parameterizationDims || [], dimensionOptions: tpl.dimensionOptions || {}, defaults: tpl.defaults || {}, dimensionConstraints: tpl.dimensionConstraints || {} }),
            };
            if (fullText) payload.fullText = fullText;   // RAG corpus
            const { error } = await supabase.from('is_standards_vault').update(payload).eq('id', row.id);
            if (error) { console.log(`     !! UPDATE FAILED: ${error.message}`); }
            else { updated++; }
        } else {
            updated++; // would-update count
        }
    }

    console.log(`\n${APPLY ? 'Updated' : 'Would update'}: ${updated}   No vault row: ${missing}   Skipped: ${skipped}`);
    if (!APPLY) console.log('Re-run with --apply to write.');
    process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
