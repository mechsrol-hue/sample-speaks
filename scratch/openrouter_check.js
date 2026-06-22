// Verify the OpenRouter key: auth, available models we care about, real text + vision calls.
require('dotenv').config();
const fs = require('fs');

const KEY = process.env.OPENROUTER_API_KEY;
const BASE = 'https://openrouter.ai/api/v1';
const H = {
    'Authorization': `Bearer ${KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'http://localhost:3005',
    'X-Title': 'SampleSpeaks',
};

async function chat(model, messages, opts = {}) {
    try {
        const r = await fetch(`${BASE}/chat/completions`, {
            method: 'POST', headers: H,
            body: JSON.stringify({ model, messages, max_tokens: opts.max || 40, temperature: 0 }),
        });
        const j = await r.json();
        if (!r.ok) return { ok: false, status: r.status, err: (j.error && j.error.message) || JSON.stringify(j).slice(0, 160) };
        return { ok: true, text: (j.choices && j.choices[0] && j.choices[0].message.content || '').replace(/\s+/g, ' ').trim().slice(0, 120) };
    } catch (e) { return { ok: false, err: e.message }; }
}

(async () => {
    if (!KEY || !KEY.startsWith('sk-or-')) { console.log('No valid OPENROUTER_API_KEY found.'); return; }

    // 1) Auth + credits
    try {
        const r = await fetch(`${BASE}/auth/key`, { headers: H }); const j = await r.json();
        console.log('AUTH:', r.status, JSON.stringify(j.data || j));
    } catch (e) { console.log('AUTH err', e.message); }
    try {
        const r = await fetch(`${BASE}/credits`, { headers: H }); const j = await r.json();
        console.log('CREDITS:', JSON.stringify(j.data || j));
    } catch (e) {}

    // 2) Which models we want are available?
    const mr = await fetch(`${BASE}/models`, { headers: H }); const mj = await mr.json();
    const ids = (mj.data || []).map(m => m.id);
    const opus = ids.filter(i => /anthropic\/claude-opus/i.test(i)).sort().reverse();
    const gemini = ids.filter(i => /google\/gemini-(3|2\.5)/i.test(i)).sort().reverse();
    const ocr = ids.filter(i => /ocr/i.test(i));
    console.log('\nTOTAL MODELS:', ids.length);
    console.log('CLAUDE OPUS:', opus.slice(0, 6).join(', ') || '(none)');
    console.log('GEMINI 2.5/3:', gemini.slice(0, 10).join(', ') || '(none)');
    console.log('OCR MODELS:', ocr.slice(0, 6).join(', ') || '(none)');

    // 3) Real calls — pick best available ids
    const opusId = opus[0];
    const gemId = gemini.find(i => /flash/i.test(i)) || gemini[0];
    console.log('\n--- live calls ---');
    if (opusId) console.log(`TEXT ${opusId}:`, JSON.stringify(await chat(opusId, [{ role: 'user', content: 'Reply with exactly: OK' }])));
    if (gemId) console.log(`TEXT ${gemId}:`, JSON.stringify(await chat(gemId, [{ role: 'user', content: 'Reply with exactly: OK' }])));

    // 4) Vision/OCR test (the real workflow) — read text from a document image
    const imgPath = '/tmp/ocr_test.png';
    if (gemId && fs.existsSync(imgPath)) {
        const b64 = fs.readFileSync(imgPath, { encoding: 'base64' });
        const msg = [{ role: 'user', content: [
            { type: 'text', text: 'Transcribe ALL text in this image exactly. If a character is unreadable, write [?]. Do not guess.' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
        ] }];
        console.log(`VISION ${gemId}:`, JSON.stringify(await chat(gemId, msg, { max: 80 })));
    } else {
        console.log('VISION: skipped (no /tmp/ocr_test.png)');
    }
})();
