const cds = require('@sap/cds');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const { getDestination } = require('@sap-cloud-sdk/connectivity');

cds.on('bootstrap', app => {
    app.use(cors({ origin: '*' })); 
});

module.exports = cds.service.impl(async function () {
    
    this.on('generateMultiModelResponse', async (req) => {
        const { prompt } = req.data;
        const systemInstruction = "You are an expert SAP developer specializing in ABAP, SAP CAPM (Node.js), and enterprise architecture. Provide clean, secure, and highly optimized code.";

        const results = await Promise.allSettled([
            callGemini(prompt, systemInstruction),
            callClaude(prompt, systemInstruction),
            callGPT4o(prompt, systemInstruction)
        ]);

        return results.map(result => {
            if (result.status === 'fulfilled') {
                return result.value;
            } else {
                return {
                    modelId: "unknown", 
                    content: "Failed to fetch response.",
                    latency: 0,
                    error: result.reason.message
                };
            }
        });
    });

    this.on('sendChatMessage', async (req) => {
        const { sessionId, modelId, prompt } = req.data;
        const systemInstruction = "You are an expert SAP developer specializing in ABAP and SAP CAPM.";

        const messagesData = await SELECT.from('sap.aigateway.ChatMessages')
            .where({ session_ID: sessionId })
            .orderBy('createdAt asc');

        const history = messagesData.map(m => ({
            role: m.role,
            content: m.content
        }));

        await INSERT.into('sap.aigateway.ChatMessages').entries({
            session_ID: sessionId,
            role: 'user',
            content: prompt,
            modelId: modelId
        });

        let responseText = "";
        let latency = 0;

        try {
            switch (modelId) {
                case 'gemini':
                    const gemRes = await callGemini(prompt, systemInstruction, history);
                    responseText = gemRes.content;
                    latency = gemRes.latency;
                    break;
                case 'claude':
                    const claudeRes = await callClaude(prompt, systemInstruction, history);
                    responseText = claudeRes.content;
                    latency = claudeRes.latency;
                    break;
                case 'gpt4o':
                    const gptRes = await callGPT4o(prompt, systemInstruction, history);
                    responseText = gptRes.content;
                    latency = gptRes.latency;
                    break;
                default:
                    req.reject(400, `Unsupported model: ${modelId}`);
            }

            await INSERT.into('sap.aigateway.ChatMessages').entries({
                session_ID: sessionId,
                role: 'assistant',
                content: responseText,
                modelId: modelId,
                latency: latency
            });

            return responseText;
        } catch (error) {
            req.reject(500, `Failed to communicate with ${modelId}`);
        }
    });
});

async function callGemini(prompt, systemInstruction, history = []) {
    const start = Date.now();
    try {
        
        const dest = await getDestination({ destinationName: 'gemini_api' });
        console.log(dest);
        const apiKey = dest.originalProperties.apikey; 

        if (!apiKey) throw new Error("API Key not found in destination properties");
        //if (!apiKey) return { modelId: 'gemini', content: "API Key missing in .env", latency: 0, error: true };

        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash",
            systemInstruction: systemInstruction
        });

        const chatHistory = history.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
        }));

        const chat = model.startChat({ history: chatHistory });
        const result = await chat.sendMessage(prompt);
        
        return {
            modelId: 'gemini',
            content: result.response.text(),
            latency: Date.now() - start
        };
    } catch (err) {
        return { modelId: 'gemini', content: `Gemini SDK Error: ${err.message}`, latency: 0, error: true };
    }
}

async function callClaude(prompt, systemInstruction, history = []) {
    const start = Date.now();
    try {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) return { modelId: 'claude', content: "API Key missing in .env", latency: 0, error: true };

        const messages = history.map(m => ({ role: m.role, content: m.content }));
        messages.push({ role: 'user', content: prompt });

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                model: 'claude-3-5-sonnet-20241022',
                max_tokens: 1024, 
                system: systemInstruction,
                messages: messages
            })
        });

        const data = await response.json();
        if (!response.ok) return { modelId: 'claude', content: `Claude API Error`, latency: 0, error: true };

        return {
            modelId: 'claude',
            content: data.content[0].text,
            latency: Date.now() - start
        };
    } catch (err) {
        return { modelId: 'claude', content: `Network crash: ${err.message}`, latency: 0, error: true };
    }
}

async function callGPT4o(prompt, systemInstruction, history = []) {
    const start = Date.now();
    try {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) return { modelId: 'gpt4o', content: "API Key missing in .env", latency: 0, error: true };

        const messages = [{ role: 'system', content: systemInstruction }];
        history.forEach(m => messages.push({ role: m.role, content: m.content }));
        messages.push({ role: 'user', content: prompt });

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: messages
            })
        });

        const data = await response.json();
        if (!response.ok) return { modelId: 'gpt4o', content: `OpenAI API Error`, latency: 0, error: true };

        return {
            modelId: 'gpt4o',
            content: data.choices[0].message.content,
            latency: Date.now() - start
        };
    } catch (err) {
        return { modelId: 'gpt4o', content: `Network crash: ${err.message}`, latency: 0, error: true };
    }
}