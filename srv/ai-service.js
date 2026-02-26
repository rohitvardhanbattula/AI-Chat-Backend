const cds = require('@sap/cds');
const cors = require('cors');

cds.on('bootstrap', app => {
    // This allows your React app (or any local app) to securely hit the CAP endpoints
    app.use(cors({ origin: '*' })); 
});

module.exports = cds.service.impl(async function () {
    
    this.on('generateMultiModelResponse', async (req) => {
        const { prompt } = req.data;
        
        const systemInstruction = "You are an expert SAP developer specializing in ABAP, SAP CAPM (Node.js), and enterprise architecture. Provide clean, secure, and highly optimized code.";

        const results = await Promise.allSettled([
            callGemini(prompt, systemInstruction),
            callClaude(prompt, systemInstruction),
            callGPT4o(prompt, systemInstruction),
            callAzure(prompt, systemInstruction)
        ]);

        return results.map(result => {
            if (result.status === 'fulfilled') {
                return result.value;
            } else {
                
                console.error("Model call failed:", result.reason);
                return {
                    modelId: "unknown", 
                    content: "Failed to fetch response.",
                    latency: 0,
                    error: result.reason.message
                };
            }
        });
    });

    // Secondary Action: Continuing a 1-on-1 Chat
    this.on('sendChatMessage', async (req) => {
        const { modelId, prompt, history } = req.data;
        const systemInstruction = "You are an expert SAP developer specializing in ABAP and SAP CAPM.";

        let responseText = "";
        const startTime = Date.now();

        try {
            
            switch (modelId) {
                case 'gemini':
                    const gemRes = await callGemini(prompt, systemInstruction);
                    responseText = gemRes.content;
                    break;
                case 'claude':
                    const claudeRes = await callClaude(prompt, systemInstruction);
                    responseText = claudeRes.content;
                    break;
                case 'gpt4o':
                    const gptRes = await callGPT4o(prompt, systemInstruction);
                    responseText = gptRes.content;
                    break;
                case 'azure':
                    break;
                default:
                    req.reject(400, `Unsupported model: ${modelId}`);
            }
            return responseText;
        } catch (error) {
            console.error(`Error chatting with ${modelId}:`, error);
            req.reject(500, `Failed to communicate with ${modelId}`);
        }
    });
});


async function callGemini(prompt, systemInstruction) {
    const start = Date.now();
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY missing");

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${apiKey}`;
    
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            system_instruction: { parts: { text: systemInstruction } },
            contents: [{ parts: [{ text: prompt }] }]
        })
    });

    if (!response.ok) throw new Error(`Gemini Error: ${response.status}`);
    const data = await response.json();
    
    return {
        modelId: 'gemini',
        content: data.candidates[0].content.parts[0].text,
        latency: Date.now() - start
    };
}

async function callClaude(prompt, systemInstruction) {
    const start = Date.now();
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing");

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            model: 'claude-3-5-sonnet-20241022',
            max_tokens: 2000,
            system: systemInstruction,
            messages: [{ role: 'user', content: prompt }]
        })
    });

    if (!response.ok) throw new Error(`Claude Error: ${response.status}`);
    const data = await response.json();

    return {
        modelId: 'claude',
        content: data.content[0].text,
        latency: Date.now() - start
    };
}

async function callGPT4o(prompt, systemInstruction) {
    const start = Date.now();
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY missing");

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: systemInstruction },
                { role: 'user', content: prompt }
            ]
        })
    });

    if (!response.ok) throw new Error(`OpenAI Error: ${response.status}`);
    const data = await response.json();

    return {
        modelId: 'gpt4o',
        content: data.choices[0].message.content,
        latency: Date.now() - start
    };
}
