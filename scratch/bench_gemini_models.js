// Benchmarks candidate Gemini models with the exact config /api/copilot/chat uses:
// systemInstruction + real tool declarations + thinkingBudget 0. Checks tool-calling works.
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const dishaTools = require('../server/agent/disha-tools');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODELS = process.argv.slice(2);

const systemPrompt = `You are Nigrani — a friendly assistant for the BIS Sample Receiving Lab.
Use a tool whenever the answer is not already given. Cite the tool you called.`;

async function bench(model) {
    const sharedConfig = {
        systemInstruction: systemPrompt,
        temperature: 0.2,
        maxOutputTokens: 2000,
        tools: [{ functionDeclarations: dishaTools.functionDeclarations }],
        thinkingConfig: { thinkingBudget: 0 },
    };
    const contents = [{ role: 'user', parts: [{ text: 'Which TAs are overloaded right now?' }] }];
    const t0 = Date.now();
    try {
        const r1 = await ai.models.generateContent({ model, contents, config: sharedConfig });
        const calls = r1.functionCalls || [];
        const t1 = Date.now();
        if (!calls.length) {
            return console.log(`${model}: round1 ${t1 - t0}ms, NO tool call (text: ${(r1.text || '').slice(0, 60)}...)`);
        }
        // Echo the model's original turn verbatim — preserves thoughtSignature (required by Gemini 3.x)
        contents.push(r1.candidates[0].content);
        const results = await Promise.all(calls.map(async c => ({ name: c.name, response: await dishaTools.callTool(c.name, c.args || {}) })));
        const t2 = Date.now();
        contents.push({ role: 'user', parts: results.map(r => ({ functionResponse: { name: r.name, response: r.response || {} } })) });
        const r2 = await ai.models.generateContent({ model, contents, config: { ...sharedConfig, tools: undefined } });
        const t3 = Date.now();
        console.log(`${model}: round1 ${t1 - t0}ms [called: ${calls.map(c => c.name).join(',')}] | tool ${t2 - t1}ms | round2 ${t3 - t2}ms | TOTAL ${t3 - t0}ms | reply: ${(r2.text || '').slice(0, 80).replace(/\n/g, ' ')}`);
    } catch (e) {
        console.log(`${model}: FAILED — ${(e.message || e).toString().slice(0, 160)}`);
    }
}

(async () => { for (const m of MODELS) await bench(m); })();
