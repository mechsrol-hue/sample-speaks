// Local-LLM enrichment for standards the deterministic parser couldn't pin a
// clean BIS-declared total on. Uses LM Studio (http://localhost:1234) — fully
// local, NO cloud. For each flagged IS we pull its section text from the
// already-extracted PDF text and ask the local model for the total MECHANICAL
// man-hours, returned as strict JSON. Results are written to the DB (with backup)
// only when the model is confident and the number is plausible.
//
// Run:  node scripts/enrich_templates_local.js            (dry-run, writes JSON)
//       node scripts/enrich_templates_local.js --commit   (also upserts to DB)

const fs = require('fs');
const path = require('path');
const supabase = require('../database-supabase');

const LM_URL = process.env.LM_STUDIO_URL || 'http://localhost:1234/v1/chat/completions';
const LM_MODEL = process.env.LM_STUDIO_MODEL || 'qwen/qwen2.5-vl-7b';
const TMP_DIR = '/tmp';

// Standards flagged 'low' by the deterministic audit (no clean declared total).
const FLAGGED = ['IS 9873', 'IS 269', 'IS 4246', 'IS 455', 'IS 1489'];

function loadAllText() {
    const files = fs.readdirSync(TMP_DIR).filter(f => /^tc_.*\.txt$/.test(f));
    return files.map(f => fs.readFileSync(path.join(TMP_DIR, f), 'utf8')).join('\n\n');
}

// Grab the SUBJECT table for an IS — the heading where the IS directly follows
// "testing charges for IS <n>" (it is the product being tested), NOT a row that
// merely says "As per IS <n>" (a cross-reference inside another standard's table).
// Picking the wrong occurrence makes the model read a completely different table.
function sliceForIS(text, isNum) {
    const n = isNum.replace(/\D/g, '');
    const subject = new RegExp(`testing\\s+charges\\s+for\\s+IS[\\s:]*${n}\\b`, 'i'); // "...for IS 1489"
    let m = subject.exec(text);
    if (!m) return null; // no subject heading -> do NOT guess from a cross-reference
    return text.slice(m.index, m.index + 3500);
}

async function askLocalModel(isNum, sectionText) {
    const prompt = `You are a laboratory quality manager reading a Bureau of Indian Standards (BIS) testing-charges table.
Extract the TOTAL man-hours for testing one sample under ${isNum}, from the text below.

Rules:
- Use the printed "TOTAL TIME" / "Total Man Hours" line if present.
- If absent, sum the man-hour values of the individual MECHANICAL/PHYSICAL test rows only.
- Ignore chemical, electrical, and microbiological rows. Ignore rupee/cost/electricity figures.
- Hours are small numbers (typically 0.5 to 60). Never return a rupee amount.
- Respond with ONLY this JSON, no prose:
{"is":"${isNum}","total_man_hours":<number>,"basis":"declared|summed","confidence":"high|medium|low"}

TEXT:
"""
${sectionText.slice(0, 3000)}
"""`;
    const body = {
        model: LM_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 200,
    };
    const res = await fetch(LM_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`LM Studio HTTP ${res.status}`);
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('no JSON in model reply: ' + content.slice(0, 120));
    return JSON.parse(jsonMatch[0]);
}

async function main() {
    const commit = process.argv.includes('--commit');
    const text = loadAllText();
    const results = [];

    for (const is of FLAGGED) {
        const slice = sliceForIS(text, is);
        if (!slice) { results.push({ is, error: 'section not found in PDF text' }); console.log(`${is}: section not found`); continue; }
        try {
            const out = await askLocalModel(is, slice);
            const hrs = Number(out.total_man_hours);
            const plausible = Number.isFinite(hrs) && hrs > 0 && hrs <= 200;
            results.push({ is, ...out, plausible });
            console.log(`${is}: ${hrs}h (${out.basis}, conf=${out.confidence}) ${plausible ? '✅' : '⚠️ implausible'}`);
        } catch (e) {
            results.push({ is, error: e.message });
            console.log(`${is}: ERROR ${e.message}`);
        }
    }

    fs.writeFileSync(path.join(__dirname, 'enriched_templates.json'), JSON.stringify(results, null, 2));
    console.log('\nWrote scripts/enriched_templates.json');

    if (commit) {
        for (const r of results) {
            if (!r.plausible || r.confidence === 'low') { console.log(`Skip ${r.is} (not committed)`); continue; }
            const { data: existing } = await supabase.from('system_preferences').select('value').eq('key', `template_${r.is}`).maybeSingle();
            let tmpl = {};
            if (existing && existing.value) { try { tmpl = JSON.parse(existing.value); } catch (_) {} }
            if (existing) await supabase.from('system_preferences').upsert({ key: `template_backup_${r.is}`, value: existing.value }, { onConflict: 'key' });
            tmpl = { ...tmpl, isNumber: r.is, _oldTotalHours: tmpl.totalHours ?? null, totalHours: r.total_man_hours, samplesPerRun: tmpl.samplesPerRun || 1, confidence: 'local-llm', source: `LM Studio ${LM_MODEL} ${r.basis}` };
            await supabase.from('system_preferences').upsert({ key: `template_${r.is}`, value: JSON.stringify(tmpl) }, { onConflict: 'key' });
            console.log(`Committed ${r.is} = ${r.total_man_hours}h (local-llm)`);
        }
    }
}

main().catch(e => { console.error(e); process.exit(1); });
