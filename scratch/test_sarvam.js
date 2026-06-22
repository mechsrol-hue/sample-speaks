const apiKey = 'sk_sg3ywjhv_tFBYghsi5LEN5mTEEtQ8FN6Q';

async function test() {
    try {
        console.log("Testing Sarvam AI Chat completions (sarvam-30b)...");
        const res = await fetch('https://api.sarvam.ai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'sarvam-30b',
                messages: [
                    { role: 'user', content: 'Say hello in 3 words.' }
                ]
            })
        });
        
        const data = await res.json();
        console.log("Status:", res.status);
        console.log("Response:", JSON.stringify(data, null, 2));
    } catch(e) {
        console.error("Fetch failed:", e);
    }
}
test();
