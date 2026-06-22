// Phase 1 smoke: does the OpenRouter structure path (Claude Opus) return our schema as valid JSON?
require('dotenv').config();
const KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_STRUCTURE_MODEL || 'anthropic/claude-opus-4.8';

const sys = `You are an IS parser. Return ONLY valid JSON:
{"isNumber":"","sections":[{"name":"dimensional","parameters":[{"clause":"","param":"","min":"","max":"","limit_type":"two_sided | max_only | min_only | qualitative","status":"ok | unreadable | needs_review"}]}],"test_parameters":[{"clause":"","param":"","min":"","max":""}]}
Rules: never guess; only-max requirements use limit_type max_only with empty min.`;

const user = `IS 4985 snippet, DN 90 Class 4: Mean OD min 90.0 max 90.3 mm. Ovality max 1.2 mm (no min). Transcribe to the schema.`;

(async () => {
    if (!KEY) { console.log('no key'); return; }
    try {
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost:3005', 'X-Title': 'SampleSpeaks' },
            body: JSON.stringify({ model: MODEL, temperature: 0.1, max_tokens: 700, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] }),
        });
        const j = await r.json();
        if (!r.ok) { console.log('HTTP', r.status, JSON.stringify(j.error || j).slice(0, 200)); return; }
        const raw = j.choices[0].message.content;
        const m = raw.match(/```json\s*([\s\S]*?)\s*```/) || raw.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse((m ? (m[1] || m[0]) : raw).trim());
        const ov = (parsed.sections || []).flatMap(s => s.parameters || []).find(p => /ovality/i.test(p.param || ''));
        console.log('MODEL:', MODEL);
        console.log('PARSED OK. isNumber:', parsed.isNumber, '| sections:', (parsed.sections || []).length);
        console.log('Ovality row:', JSON.stringify(ov));
    } catch (e) { console.log('ERR', e.message); }
})();
