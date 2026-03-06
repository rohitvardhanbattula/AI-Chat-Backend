const cds = require('@sap/cds');
const { getDestination } = require('@sap-cloud-sdk/connectivity');
const { Registry, MemoryFile } = require("@abaplint/core");

async function validateAbapCode(abapCode) {
    const registry = new Registry();
    const file = new MemoryFile("z_generated_code.prog.abap", abapCode);
    registry.addFile(file);
    await registry.parseAsync();
    const issues = registry.findIssues();

    // 🛑 AGGRESSIVE FILTER: Ignore stylistic, formatting, and noisy rules
    const ignoredPhrases = [
        "align ",
        "change if to case",
        "end of line comments",
        "name too long",
        "text element",
        "exit is not allowed",
        "specify table key",
        "functional writing style",
        "indentation",
        "does not match pattern",
        "main file must have specific contents",
        "only one statement is allowed",
        "hungarian notation",
        "is obsolete",
        "statement does not exist", // Catches the *& comment parsing errors
        "reduce procedural code",
        "add order by",
        "remove space",
        "remove whitespace",
        "start statement at tab",
        "strict sql", // Catches "INTO/APPENDING must be last"
        "unnecessary chaining",
        "must be escaped with @",
        "empty event",
        "specify table type",
        "not found, findtop"
    ];

    const highRiskIssues = issues.filter(issue => {
        const severity = issue.getSeverity();
        const message = issue.getMessage().toLowerCase();

        const isHighSeverity = (severity === 1 || severity === 2 || severity === 'Error');

        const isIgnored = ignoredPhrases.some(phrase => message.includes(phrase));

        return isHighSeverity && !isIgnored;
    });

    if (highRiskIssues.length > 0) {
        return {
            count: highRiskIssues.length,
            issues: highRiskIssues.map(issue => `Line ${issue.getStart().getRow()}: ${issue.getMessage()}`)
        };
    }
    return null;
}

async function extractAndValidateABAP(text) {
    const abapRegex = /```abap\s*?\n([\s\S]*?)```/gi;
    let match;
    let allIssues = [];
    let containsAbap = false;
    let errorCount = 0;

    while ((match = abapRegex.exec(text)) !== null) {
        containsAbap = true;
        const code = match[1];
        const validationResult = await validateAbapCode(code);
        if (validationResult) {
            allIssues.push(...validationResult.issues);
            errorCount += validationResult.count;
        }
    }

    if (!containsAbap) return { report: "", count: 0, hasAbap: false };

    if (allIssues.length > 0) {
        return {
            report: "\n\n---\n** Abaplint Analysis:**\n" + allIssues.map(i => `- ${i}`).join('\n'),
            count: errorCount,
            hasAbap: true
        };
    }
    return {
        report: "\n\n---\n** abaplint Analysis:** No high-risk syntax issues found in the generated ABAP code.",
        count: 0,
        hasAbap: true
    };
}


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

    this.on('validateABAPCode', async (req) => {
        const { code } = req.data;
        const validation = await validateAbapCode(code);
        return validation ? validation.issues : ["No high-risk syntax issues found."];
    });

    this.on('generateMultiModelResponse', async (req) => {
        const { prompt } = req.data;
        const sysInst = "You are an expert SAP developer specializing in ABAP and SAP CAPM. Provide clean, optimized code. Always wrap your ABAP code in ```abap code blocks.";
        const results = await Promise.allSettled([
            callGemini(prompt, sysInst), callGPT4o(prompt, sysInst), callSAPGenAIHub(prompt, sysInst)
        ]);

        return Promise.all(results.map(async (result, index) => {
            if (result.status === 'fulfilled') {
                let responseData = result.value;
                if (!responseData.error) {
                    
                    const validation = await extractAndValidateABAP(responseData.content);
                    
                    if (validation.hasAbap) {
                        const topHeader = validation.count > 0 
                            ? `** abaplint: ${validation.count} high-risk issue(s) found**\n\n` 
                            : `** abaplint: 0 high-risk issues**\n\n`;
                        
                        responseData.content = topHeader + responseData.content + validation.report;
                    }
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
                        onChunk(chunkText);
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

            const validation = await extractAndValidateABAP(fullResponse);
            if (validation.report) {
                fullResponse += validation.report;
                onChunk(validation.report);
            }

            
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
        const response = await openai.send({ query: "POST /chat/completions?api-version=2024-02-15-preview", data: { model: "sonar", max_tokens: 4000, temperature: 0.5, messages: messages }, headers: { "AI-Resource-Group": "default", "Content-Type": "application/json" } });
        if (!response || !response.choices) throw new Error("AI response did not contain 'choices'.");
        return { modelId: 'perplexity', content: response.choices[0].message.content, latency: Date.now() - start };
    } catch (err) { return { modelId: 'perplexity', content: `Perplexity Error: ${err.message}`, latency: 0, error: true }; }
}