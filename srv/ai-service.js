const cds = require('@sap/cds');
const { getDestination } = require('@sap-cloud-sdk/connectivity');
const { Registry, MemoryFile } = require("@abaplint/core"); // <-- NEW

// --- NEW ABAPLINT HELPER FUNCTIONS ---
async function validateAbapCode(abapCode) {
    const registry = new Registry();
    const file = new MemoryFile("z_generated_code.prog.abap", abapCode);
    registry.addFile(file);
    await registry.parseAsync();
    const issues = registry.findIssues();

    if (issues.length > 0) {
        return issues.map(issue => `Line ${issue.getStart().getRow()}: ${issue.getMessage()}`);
    }
    return null;
}

async function extractAndValidateABAP(text) {
    const abapRegex = /```abap\n([\s\S]*?)```/gi;
    let match;
    let allIssues = [];
    let containsAbap = false;

    while ((match = abapRegex.exec(text)) !== null) {
        containsAbap = true;
        const code = match[1];
        const issues = await validateAbapCode(code);
        if (issues) {
            allIssues.push(...issues);
        }
    }

    if (!containsAbap) return ""; // No ABAP code found in response

    if (allIssues.length > 0) {
        return "\n\n---\n**🔍 abaplint Analysis:**\n" + allIssues.map(i => `- ${i}`).join('\n');
    }
    return "\n\n---\n**🔍 abaplint Analysis:** ✅ No syntax issues found in the generated ABAP code.";
}
// --------------------------------------

module.exports = cds.service.impl(async function () {

    this.on('register', async (req) => {
        const { username, password } = req.data;
        const existing = await SELECT.one.from('sap.aigateway.Users').where({ username });
        if (existing) return req.reject(400, 'Username already taken');
        await INSERT.into('sap.aigateway.Users').entries({ username, password });
        const newUser = await SELECT.one.from('sap.aigateway.Users').where({ username });
        return newUser.ID;
    });

    this.on('login', async (req) => {
        const { username, password } = req.data;
        const user = await SELECT.one.from('sap.aigateway.Users').where({ username, password });
        if (!user) return req.reject(401, 'Invalid credentials');
        return user.ID;
    });

    this.on('submitRating', async (req) => {
        const { userId, modelId, category, rating } = req.data;
        await INSERT.into('sap.aigateway.Ratings').entries({ userId, modelId, category, rating });
        return "Success";
    });

    // NEW: Manual validation action
    this.on('validateABAPCode', async (req) => {
        const { code } = req.data;
        const issues = await validateAbapCode(code);
        return issues || ["✅ No syntax issues found."];
    });

    this.on('generateMultiModelResponse', async (req) => {
        const { prompt } = req.data;
        const sysInst = "You are an expert SAP developer specializing in ABAP and SAP CAPM. Provide clean, optimized code.";
        const results = await Promise.allSettled([
            callGemini(prompt, sysInst), callGPT4o(prompt, sysInst), callSAPGenAIHub(prompt, sysInst)
        ]);

        return Promise.all(results.map(async (result, index) => {
            if (result.status === 'fulfilled') {
                let responseData = result.value;
                if (!responseData.error) {
                    // Inject abaplint validation report into multi-model response
                    const lintReport = await extractAndValidateABAP(responseData.content);
                    responseData.content += lintReport;
                }
                return responseData;
            }
            return { modelId: ["gemini", "gpt4o", "perplexity"][index] || "unknown", content: "Failed.", latency: 0, error: result.reason.message };
        }));
    });

    this.generateStream = async function (sessionId, modelId, prompt, onChunk) {
        const normalizedModelId = modelId ? modelId.toLowerCase() : "";
        const systemInstruction = "You are an expert SAP developer specializing in ABAP and SAP CAPM.";

        const messagesData = await SELECT.from('sap.aigateway.ChatMessages').where({ session_ID: sessionId }).orderBy('createdAt asc');
        const history = messagesData.map(m => ({ role: m.role, content: m.content }));

        await INSERT.into('sap.aigateway.ChatMessages').entries({ session_ID: sessionId, role: 'user', content: prompt, modelId: modelId });

        let fullResponse = "";
        let latencyStart = Date.now();

        try {
            if (normalizedModelId === 'gemini') {
                const { VertexAI } = require('@google-cloud/vertexai');
                const dest = await getDestination({ destinationName: 'geminivertex_api' });
                const svcKey = dest.originalProperties;
                const vertexAI = new VertexAI({ project: svcKey.project_id, location: 'us-central1', googleAuthOptions: { credentials: { client_email: svcKey.client_email, private_key: svcKey.private_key.replace(/\\n/g, '\n') } } });
                const model = vertexAI.getGenerativeModel({ model: 'gemini-2.0-flash', systemInstruction: { parts: [{ text: systemInstruction }] } });
                const chatHistory = history.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

                const resultStream = await model.startChat({ history: chatHistory }).sendMessageStream(prompt);
                for await (const chunk of resultStream.stream) {
                    
                    const chunkText = chunk.candidates?.[0]?.content?.parts?.[0]?.text || "";

                    if (chunkText) {
                        fullResponse += chunkText;
                        onChunk(chunkText); // Emit immediately
                    }
                }
            } else if (normalizedModelId === 'claude') {
                throw new Error("Claude is currently under build progress.");
            } else {
                let res = normalizedModelId === 'gpt4o' ? await callGPT4o(prompt, systemInstruction, history) : await callSAPGenAIHub(prompt, systemInstruction, history);
                fullResponse = res.content;

                const chunkSize = 10;
                for (let i = 0; i < fullResponse.length; i += chunkSize) {
                    onChunk(fullResponse.slice(i, i + chunkSize));
                    await new Promise(r => setTimeout(r, 10));
                }
            }

            // --- NEW: Post-Process with ABAPLint ---
            const lintReport = await extractAndValidateABAP(fullResponse);
            if (lintReport) {
                fullResponse += lintReport;
                onChunk(lintReport); // Send the report as the final chunk to the UI
            }

            // Save the combined text (AI Answer + Validation Report) to DB
            await INSERT.into('sap.aigateway.ChatMessages').entries({
                session_ID: sessionId, role: 'assistant', content: fullResponse, modelId: modelId, latency: Date.now() - latencyStart
            });

        } catch (error) { throw error; }
    };
});

async function callGemini(prompt, systemInstruction, history = []) {
    const start = Date.now();
    try {
        const { VertexAI } = require('@google-cloud/vertexai');
        const dest = await getDestination({ destinationName: 'geminivertex_api' });
        const svcKey = dest.originalProperties;
        const vertexAI = new VertexAI({ project: svcKey.project_id, location: 'us-central1', googleAuthOptions: { credentials: { client_email: svcKey.client_email, private_key: svcKey.private_key.replace(/\\n/g, '\n') } } });
        const model = vertexAI.getGenerativeModel({ model: 'gemini-2.0-flash', systemInstruction: { parts: [{ text: systemInstruction }] } });
        const chatHistory = history.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
        const result = await model.startChat({ history: chatHistory }).sendMessage(prompt);
        return { modelId: 'gemini', content: result.response.candidates[0].content.parts[0].text, latency: Date.now() - start };
    } catch (err) { return { modelId: 'gemini', content: `Gemini Error: ${err.message}`, latency: 0, error: true }; }
}

async function callGPT4o(prompt, systemInstruction, history = []) {
    const start = Date.now();
    try {
        const openai = await cds.connect.to("openai");
        const messages = [{ role: 'system', content: systemInstruction }, ...history, { role: 'user', content: prompt }];
        const response = await openai.send({ query: "POST /chat/completions?api-version=2024-02-15-preview", data: { model: "gpt-5.2", temperature: 0.5, messages: messages }, headers: { "AI-Resource-Group": "default", "Content-Type": "application/json" } });
        if (!response || !response.choices) throw new Error("AI response did not contain 'choices'.");
        return { modelId: 'gpt4o', content: response.choices[0].message.content, latency: Date.now() - start };
    } catch (err) { return { modelId: 'gpt4o', content: `GPT Error: ${err.message}`, latency: 0, error: true }; }
}

async function callSAPGenAIHub(prompt, systemInstruction, history = []) {
    const start = Date.now();
    try {
        const openai = await cds.connect.to("perplexity");
        const messages = [{ role: 'system', content: systemInstruction }, ...history, { role: 'user', content: prompt }];
        const response = await openai.send({ query: "POST /chat/completions?api-version=2024-02-15-preview", data: { model: "sonar", max_tokens: 800, temperature: 0.5, messages: messages }, headers: { "AI-Resource-Group": "default", "Content-Type": "application/json" } });
        if (!response || !response.choices) throw new Error("AI response did not contain 'choices'.");
        return { modelId: 'perplexity', content: response.choices[0].message.content, latency: Date.now() - start };
    } catch (err) { return { modelId: 'perplexity', content: `Perplexity Error: ${err.message}`, latency: 0, error: true }; }
}