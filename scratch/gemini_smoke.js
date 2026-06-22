// One-off smoke test: confirm the Gemini key + model + JSON mode work for IS extraction.
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

(async () => {
    const key = process.env.GEMINI_API_KEY;
    if (!key) { console.log(JSON.stringify({ ok: false, reason: 'no GEMINI_API_KEY' })); return; }
    const model = process.env.GEMINI_EXTRACT_MODEL || 'gemini-3.5-flash';
    try {
        const ai = new GoogleGenAI({ apiKey: key });
        const t0 = Date.now();
        const resp = await ai.models.generateContent({
            model,
            contents: [{ role: 'user', parts: [{ text: 'Return JSON: the OD min and max in mm for a 90mm IS 4985 pipe is min 90.0 max 90.3. Echo as {"min":..,"max":..}. If unsure, set status "needs_review".' }] }],
            config: { temperature: 0.1, responseMimeType: 'application/json' },
        });
        console.log(JSON.stringify({ ok: true, model, ms: Date.now() - t0, text: (resp.text || '').slice(0, 200) }));
    } catch (e) {
        console.log(JSON.stringify({ ok: false, model, error: e.message }));
    }
})();
