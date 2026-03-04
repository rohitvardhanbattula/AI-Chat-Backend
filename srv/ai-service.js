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
            callGPT4o(prompt, systemInstruction),
            callSAPGenAIHub(prompt, systemInstruction)
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
        // Normalize modelId to lowercase to prevent switch-case mismatches
        const normalizedModelId = modelId ? modelId.toLowerCase() : "";
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
            // Use normalizedModelId here!
            switch (normalizedModelId) {
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
                case 'perplexity':
                    const sapRes = await callSAPGenAIHub(prompt, systemInstruction, history);
                    responseText = sapRes.content;
                    latency = sapRes.latency;
                    break;
                default:
                    return req.reject(400, `Unsupported model: ${modelId}`);
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
            // Unmask the actual error to your console so you can debug future issues
            console.error(`[ERROR] sendChatMessage failed for model ${modelId}:`, error);
            
            // If the error was a deliberate req.reject (like a 400), don't wrap it in a 500
            if (error.code && error.code === '400') throw error;
            
            req.reject(500, `Failed to communicate with ${modelId}`);
        }
    });
});

async function callGemini(prompt, systemInstruction, history = []) {
    const start = Date.now();
    try {
        const { VertexAI } = require('@google-cloud/vertexai');
        const { getDestination } = require('@sap-cloud-sdk/connectivity');

        const dest = await getDestination({ destinationName: 'geminivertex_api' });
        const serviceAccountKey = dest.originalProperties;
        
        const vertexAI = new VertexAI({
            project: serviceAccountKey.project_id,
            location: 'us-central1',
            googleAuthOptions: {
                credentials: {
                    client_email: serviceAccountKey.client_email,
                    private_key: serviceAccountKey.private_key.replace(/\\n/g, '\n')
                }
            }
        });

        const model = vertexAI.getGenerativeModel({
            model: 'gemini-2.0-flash',
            systemInstruction: { parts: [{ text: systemInstruction }] }
        });

        const chatHistory = history.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
        }));

        const chat = model.startChat({ history: chatHistory });
        const result = await chat.sendMessage(prompt);
        const responseText = result.response.candidates[0].content.parts[0].text;

        return { modelId: 'gemini', content: responseText, latency: Date.now() - start };

    } catch (err) {
        console.error("Vertex AI Error:", err.message);
        return { modelId: 'gemini', content: `Gemini Error: ${err.message}`, latency: 0, error: true };
    }
}

async function callGPT4o(prompt, systemInstruction, history = []) {
    const start = Date.now();
    try {
        const openai = await cds.connect.to("openai");
        
        const messages = [{ role: 'system', content: systemInstruction }];
        history.forEach(m => messages.push({ role: m.role, content: m.content }));
        messages.push({ role: 'user', content: prompt });
        
        const payload = {
            model: "gpt-5.2", 
            temperature: 0.5,
            messages: messages
        };
        
        const response = await openai.send({
            query: "POST /chat/completions?api-version=2024-02-15-preview",
            data: payload,
            headers: {
                "AI-Resource-Group": "default", 
                "Content-Type": "application/json"
            }
        });
        
        if (!response || !response.choices) {
            throw new Error("AI response did not contain 'choices'.");
        }
        
        return {
            modelId: 'gpt4o',
            content: response.choices[0].message.content,
            latency: Date.now() - start
        };
        
    } catch (err) {
        console.error("GPT4o AI Proxy Call Failed:", err.message);
        return { modelId: 'gpt4o', content: `SAP Gen AI Hub Error (GPT4o): ${err.message}`, latency: 0, error: true };
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



async function callSAPGenAIHub(prompt, systemInstruction, history = []) {
    const start = Date.now();
    try {
        const openai = await cds.connect.to("perplexity");
        
        const messages = [{ role: 'system', content: systemInstruction }];
        history.forEach(m => messages.push({ role: m.role, content: m.content }));
        messages.push({ role: 'user', content: prompt });
        
        const payload = {
            model: "sonar",
            max_tokens: 800,
            temperature: 0.5,
            messages: messages
        };
        
        const response = await openai.send({
            
            query: "POST /chat/completions?api-version=2024-02-15-preview",
            data: payload,
            headers: {
                "AI-Resource-Group": "default", 
                "Content-Type": "application/json"
            }
        });
        
        if (!response || !response.choices) {
            throw new Error("AI response did not contain 'choices'.");
        }
        
        return {
            modelId: 'perplexity',
            content: response.choices[0].message.content,
            latency: Date.now() - start
        };
        
    } catch (err) {
        console.error("AI Proxy Call Failed:", err.message);
        return { modelId: 'perplexity', content: `SAP Gen AI Hub Error: ${err.message}`, latency: 0, error: true };
    }
}