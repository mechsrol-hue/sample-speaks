// Accuracy check: Gemini reads IS 4985 Table 1 from the page images, diff vs hand-verified specs_db.js
require('dotenv').config();
const fs = require('fs');

const KEY = process.env.OPENROUTER_API_KEY;
const VISION = process.env.OPENROUTER_VISION_MODEL || 'google/gemini-3.5-flash';

// Ground truth from the app's hand-coded table
const specsCode = fs.readFileSync(__dirname + '/../public/specs_db.js', 'utf8');
const SPECS = new Function(specsCode + '\nreturn IS_4985_SPECS;')();
const GT = SPECS.sizes_db;

const SYS = `You are a precise Bureau of Indian Standards table reader. Read every number EXACTLY as printed. NEVER guess, round, or infer. If a cell is blank or unreadable, use null. The table is rotated — read it regardless.`;

function userPrompt(which) {
    return `This is Table 1 "Dimensions of Unplasticized PVC Pipes" from IS 4985:2021 (${which}).
Column layout: Nominal Outside Diameter (DN); Mean Outside Diameter [Min, Max]; Outside Diameter at Any Point [Min, Max]; then Wall Thickness for Class 1..6, each having THREE sub-columns in order [Avg Max, Min, Max]. Small and large DNs leave some classes blank.
Extract EVERY row. Return ONLY JSON:
{"rows":[{"dn":<number>,"mean_od":[min,max],"od_any":[min,max],"thickness":{"1":[avgmax,min,max],"2":[...],"6":[...]}}]}
Include a class key only if that class has printed numbers for that DN. Use null for any unreadable cell.`;
}

async function readPage(imgPath, which) {
    const b64 = fs.readFileSync(imgPath, { encoding: 'base64' });
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost:3005', 'X-Title': 'SampleSpeaks' },
        body: JSON.stringify({
            model: VISION, temperature: 0, max_tokens: 12000,
            messages: [
                { role: 'system', content: SYS },
                { role: 'user', content: [
                    { type: 'text', text: userPrompt(which) },
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
                ] },
            ],
        }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j.error || j).slice(0, 200)}`);
    const raw = j.choices[0].message.content;
    const m = raw.match(/```json\s*([\s\S]*?)\s*```/) || raw.match(/\{[\s\S]*\}/);
    return JSON.parse((m ? (m[1] || m[0]) : raw).trim()).rows || [];
}

const eq = (a, b) => a != null && b != null && Math.abs(parseFloat(a) - parseFloat(b)) < 1e-9;

(async () => {
    if (!KEY) { console.log('no key'); return; }
    let rows = [];
    for (const [p, label] of [['/tmp/is4985_p7.png', 'DN 20-355'], ['/tmp/is4985_p8.png', 'DN 400-630 (concluded)']]) {
        try { const r = await readPage(p, label); console.log(`read ${label}: ${r.length} rows`); rows = rows.concat(r); }
        catch (e) { console.log(`FAIL ${label}:`, e.message); }
    }
    const byDn = {}; rows.forEach(r => { byDn[parseFloat(r.dn)] = r; });

    let total = 0, ok = 0; const miss = [];
    const cmp = (dn, field, exp, got) => { total++; if (eq(exp, got)) ok++; else miss.push(`DN${dn} ${field}: expected ${exp}, got ${got}`); };

    for (const dnKey of Object.keys(GT)) {
        const dn = parseFloat(dnKey); const g = GT[dnKey]; const e = byDn[dn];
        if (!e) { miss.push(`DN${dn}: MISSING from extraction`); total += 4; continue; }
        cmp(dn, 'meanOD.min', g.min_od, e.mean_od && e.mean_od[0]);
        cmp(dn, 'meanOD.max', g.max_od, e.mean_od && e.mean_od[1]);
        cmp(dn, 'odAny.min', g.min_od_any, e.od_any && e.od_any[0]);
        cmp(dn, 'odAny.max', g.max_od_any, e.od_any && e.od_any[1]);
        for (const cls of Object.keys(g.thickness || {})) {
            const gt = g.thickness[cls]; const et = e.thickness && e.thickness[cls];
            ['avg', 'min', 'max'].forEach((lbl, i) => cmp(dn, `t.C${cls}.${lbl}`, gt[i], et && et[i]));
        }
    }
    console.log(`\n=== ACCURACY: ${ok}/${total} cells = ${(100 * ok / total).toFixed(1)}% ===`);
    console.log(`mismatches: ${miss.length}`);
    miss.slice(0, 40).forEach(m => console.log('  ✗', m));
    if (miss.length > 40) console.log(`  ...and ${miss.length - 40} more`);
})();
