const cds = require('@sap/cds');
const { getDestination } = require('@sap-cloud-sdk/connectivity');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const { Registry, MemoryFile } = require("@abaplint/core");
const { sendMail } = require('@sap-cloud-sdk/mail-client');

const GLOBAL_SYSTEM_INSTRUCTION = "You are an expert SAP developer specializing in ABAP and SAP CAPM. Provide clean, optimized code. Always wrap your ABAP code in ```abap code blocks. Respond ONLY with the requested code and necessary brief explanations.";

let cloudificationCache = [];

async function syncCloudificationData() {
    try {
        const response = await fetch('https://raw.githubusercontent.com/SAP/abap-atc-cr-cv-s4hc/main/src/objectReleaseInfo_PCELatest.json');
        if (response.ok) {
            const data = await response.json();
            cloudificationCache = data.map(item => ({
                object: item.ObjectName,
                successor: item.SuccessorName,
                type: item.ObjectType
            }));
        }
    } catch (error) {
        cloudificationCache = [];
    }
}
syncCloudificationData();

async function validateGitHubRepo(abapCode) {
    let repoLogs = [];
    if (cloudificationCache.length === 0) return repoLogs;

    const objects = new Set();
    const kwRegex = /(?:TYPE|FROM|JOIN|CALL FUNCTION|CALL METHOD|REF TO)\s+(?:TABLE OF\s+|STANDARD TABLE OF\s+)?[']?([\/a-z0-9_]+)[']?/gi;
    let match;
    while ((match = kwRegex.exec(abapCode)) !== null) {
        objects.add(match[1].toUpperCase());
    }

    const classRegex = /([\/a-z0-9_]+)=>/gi;
    while ((match = classRegex.exec(abapCode)) !== null) {
        objects.add(match[1].toUpperCase());
    }

    const ignoreList = ['STRING', 'I', 'D', 'T', 'F', 'C', 'N', 'X', 'P', 'TABLE', 'ANY', 'STANDARD', 'DATA', 'REF', 'TO'];
    const foundObjects = Array.from(objects).filter(obj => !ignoreList.includes(obj) && obj.length > 2);

    let missingObjects = [];

    if (foundObjects.length > 0) {
        foundObjects.forEach(obj => {
            const isVerified = cloudificationCache.some(rule => 
                (rule.successor && rule.successor.toUpperCase().includes(obj)) ||
                (rule.object && rule.object.toUpperCase() === obj)
            );

            if (!isVerified) {
                missingObjects.push(obj);
            }
        });

        if (missingObjects.length > 0) {
            repoLogs.push(`**❌ VALIDATION FAILED: The following objects in the code are missing from the Git Cloud Repo:**`);
            missingObjects.forEach(obj => {
                repoLogs.push(`- \`${obj}\``);
            });
        } else {
            repoLogs.push(`**VALIDATION PASSED: All detected objects exist in the Git Cloud Repo.**`);
        }
    } else {
         repoLogs.push(`- No verifiable database objects, functions, or classes were detected in the code.`);
    }

    return repoLogs;
}

async function validateWithAPIHub(apiName) {
    try {
        const apiKey = process.env.API_HUB_KEY; 
        if (!apiKey) return null;

        const response = await executeHttpRequest(
            { url: 'https://sandbox.api.sap.com' },
            { method: 'GET', url: `/s4hanacloud/odata/v4/${apiName}/$metadata`, headers: { 'APIKey': apiKey, 'Accept': 'application/json' } }
        );

        return response.status === 200 ? { isValid: true } : { isValid: false, message: `API ${apiName} not found in SAP API Hub.` };
    } catch (error) { 
        return null; 
    }
}

async function validateAbapCode(abapCode) {
    const registry = new Registry();
    const file = new MemoryFile("z_generated_code.prog.abap", abapCode);
    registry.addFile(file);
    await registry.parseAsync();
    const issues = registry.findIssues();

    const ignoredPhrases = [
        "align ", "change if to case", "end of line comments", "name too long","remove double space", "implicit start-of-selection",
        "text element", "exit is not allowed", "specify table key", "functional writing style",
        "indentation", "does not match pattern", "main file must have specific contents",
        "only one statement is allowed", "hungarian notation", "is obsolete",
        "statement does not exist", "reduce procedural code", "add order by",
        "remove space", "remove whitespace", "start statement at tab", "strict sql",
        "unnecessary chaining", "must be escaped with @", "empty event",
        "specify table type", "not found, findtop"
    ];

    const highRiskIssues = issues.filter(issue => {
        const severity = issue.getSeverity();
        const message = issue.getMessage().toLowerCase();
        const isHighSeverity = (severity === 1 || severity === 2 || severity === 'Error');
        return isHighSeverity && !ignoredPhrases.some(phrase => message.includes(phrase));
    });

    return highRiskIssues.map(issue => `Line ${issue.getStart().getRow()}: ${issue.getMessage()}`);
}

async function extractAndValidateABAP(text) {
    const abapRegex = /```abap\s*?\n([\s\S]*?)```/gi;
    let match;
    let allSyntaxIssues = [];
    let allRepoLogs = [];
    let allApiLogs = [];
    let containsAbap = false;
    let errorCount = 0;

    while ((match = abapRegex.exec(text)) !== null) {
        containsAbap = true;
        const code = match[1];
        
        const syntaxIssues = await validateAbapCode(code);
        if (syntaxIssues && syntaxIssues.length > 0) {
            allSyntaxIssues.push(...syntaxIssues);
            errorCount += syntaxIssues.length;
        }

        const repoResult = await validateGitHubRepo(code);
        if (repoResult.length > 0) allRepoLogs.push(...repoResult);

        const apiRegex = /API_[a-zA-Z0-9_]+/gi; 
        const foundApis = code.match(apiRegex);
        
        if (foundApis) {
            const uniqueApis = [...new Set(foundApis)];
            for (const apiName of uniqueApis) {
                const apiStatus = await validateWithAPIHub(apiName.toUpperCase()); 
                if (apiStatus && !apiStatus.isValid) {
                    allApiLogs.push(`- 🚨 **API Hub Error:** ${apiStatus.message}`);
                }
            }
        }
    }

    if (!containsAbap) return { report: "", hasAbap: false };

    let reportText = "\n\n---\n### 🔍 Final Validation Report\n";
    
    if (allRepoLogs.length > 0) {
        reportText += "**Git Cloud Repository Check:**\n" + allRepoLogs.join('\n') + "\n\n";
    }

    if (allApiLogs.length > 0) {
        reportText += "**API Hub Check:**\n" + allApiLogs.join('\n') + "\n\n";
    }

    if (allSyntaxIssues.length > 0) {
        reportText += `**abaplint Syntax Check: ${errorCount} high-risk issue(s)**\n` + allSyntaxIssues.map(i => `- ${i}`).join('\n');
    } else {
        reportText += "**abaplint Syntax Check: 0 high-risk issues**\n";
    }

    return { report: reportText, hasAbap: true };
}

module.exports = cds.service.impl(async function () {

    this.before('CREATE', 'ChatSessions', async (req) => {
        const userId = req.data.userId;
        if (userId) {
            const sessionCount = await SELECT.from('sap.aigateway.ChatSessions').where({ userId: userId });
            if (sessionCount.length >= 10) return req.reject(403, 'Maximum of 10 chats reached. Please delete an older chat to create a new one.');
        }
    });

    this.on('register', async (req) => {
        const { username, password } = req.data;
        if (!username.toLowerCase().endsWith('@answerthink.com')) return req.reject(400, 'Registration is restricted to @answerthink.com emails only.');

        const existing = await SELECT.one.from('sap.aigateway.Users').where({ username });
        if (existing && existing.isVerified) return req.reject(400, 'User already exists and is verified. Please log in.');

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const otpExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();

        if (existing && !existing.isVerified) {
            await UPDATE('sap.aigateway.Users').set({ password, otp, otpExpiry }).where({ username });
        } else {
            await INSERT.into('sap.aigateway.Users').entries({ username, password, otp, otpExpiry, isVerified: false });
        }

        try {
            await sendMail({ destinationName: 'sap_process_automation_mail' }, [{ to: username, subject: 'AnswerThink Enterprise AI Hub - Registration OTP', text: `Your one-time password (OTP) is: ${otp}. It is valid for 10 minutes.` }]);
            return `An OTP has been sent to ${username}.`;
        } catch (error) { return req.error(500, 'Could not send the verification email.'); }
    });

    this.on('verifyOTP', async (req) => {
        const { username, otp } = req.data;
        const user = await SELECT.one.from('sap.aigateway.Users').where({ username, otp });

        if (!user) return req.reject(400, 'Invalid OTP.');
        if (new Date(user.otpExpiry) < new Date()) return req.reject(400, 'OTP has expired. Please register again.');

        await UPDATE('sap.aigateway.Users').set({ isVerified: true, otp: null, otpExpiry: null }).where({ username });
        return user.ID;
    });

    this.on('login', async (req) => {
        const { username, password } = req.data;
        if (!username.toLowerCase().endsWith('@answerthink.com')) return req.reject(400, 'Only @answerthink.com emails are allowed.');

        const user = await SELECT.one.from('sap.aigateway.Users').where({ username, password });
        if (!user) return req.reject(401, 'Invalid credentials or Register your User');
        if (!user.isVerified) return req.reject(403, 'Email not verified. Please register to generate a new OTP.');

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
        return validation && validation.length > 0 ? validation : ["No high-risk syntax issues found."];
    });

    this.on('generateMultiModelResponse', async (req) => {
        const { prompt } = req.data;
        const results = await Promise.allSettled([
            callGemini(prompt, GLOBAL_SYSTEM_INSTRUCTION), callGPT4o(prompt, GLOBAL_SYSTEM_INSTRUCTION), callSAPGenAIHub(prompt, GLOBAL_SYSTEM_INSTRUCTION), callClaude(prompt, GLOBAL_SYSTEM_INSTRUCTION)
        ]);

        return Promise.all(results.map(async (result, index) => {
            const models = ["gemini", "gpt4o", "perplexity", "claude"];
            if (result.status === 'fulfilled') {
                let responseData = result.value;
                if (!responseData.error && responseData.content) {
                    const validation = await extractAndValidateABAP(responseData.content);
                    if (validation.hasAbap) {
                        responseData.content += validation.report;
                    }
                    return responseData;
                } else {
                    responseData.content = "model is not available at the moment";
                }
                return responseData;
            }
            return { modelId: models[index] || "unknown", content: "model is not available at the moment", latency: 0, error: true };
        }));
    });

    this.generateStreamNoSession = async function (modelId, prompt, onChunk) {
        const normalizedModelId = modelId ? modelId.toLowerCase() : "";
        let fullResponse = "";

        try {
            if (normalizedModelId === 'gemini') {
                const { VertexAI } = require('@google-cloud/vertexai');
                const dest = await getDestination({ destinationName: 'geminivertex_api' });
                const svcKey = dest.originalProperties;
                const vertexAI = new VertexAI({ project: svcKey.project_id, location: 'us-central1', googleAuthOptions: { credentials: { client_email: svcKey.client_email, private_key: svcKey.private_key.replace(/\\n/g, '\n') } } });
                const model = vertexAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite', systemInstruction: { parts: [{ text: GLOBAL_SYSTEM_INSTRUCTION }] } });

                const resultStream = await model.startChat({ history: [] }).sendMessageStream(prompt);
                for await (const chunk of resultStream.stream) {
                    const chunkText = chunk.candidates?.[0]?.content?.parts?.[0]?.text || "";
                    if (chunkText) {
                        fullResponse += chunkText;
                        onChunk(chunkText);
                    }
                }
            } else if (normalizedModelId === 'claude') {
                fullResponse = await streamClaude(prompt, GLOBAL_SYSTEM_INSTRUCTION, [], onChunk);
            } else {
                let res = normalizedModelId === 'gpt4o' ? await callGPT4o(prompt, GLOBAL_SYSTEM_INSTRUCTION, []) : await callSAPGenAIHub(prompt, GLOBAL_SYSTEM_INSTRUCTION, []);
                fullResponse = (res.error || !res.content) ? "model is not available at the moment" : res.content;
                onChunk(fullResponse);
            }

            if (fullResponse !== "model is not available at the moment") {
                const validation = await extractAndValidateABAP(fullResponse);
                if (validation.hasAbap) {
                    onChunk(validation.report);
                }
            }

        } catch (error) { 
            onChunk(`model is not available at the moment. Error: ${error.message || error}`);
        }
    };

    this.generateStream = async function (sessionId, modelId, prompt, onChunk) {
        const userMessageCount = await SELECT.from('sap.aigateway.ChatMessages').where({ session_ID: sessionId, role: 'user' });
        if (userMessageCount.length >= 20) throw new Error('Maximum prompt limit (20) reached for this chat. Please start a new chat.');
        
        const normalizedModelId = modelId ? modelId.toLowerCase() : "";
        const messagesData = await SELECT.from('sap.aigateway.ChatMessages').where({ session_ID: sessionId }).orderBy('createdAt asc');
        const history = messagesData.map(m => ({ role: m.role, content: m.content }));

        await INSERT.into('sap.aigateway.ChatMessages').entries({ session_ID: sessionId, role: 'user', content: prompt, modelId: modelId });

        let latencyStart = Date.now();
        let fullResponse = "";

        try {
            if (normalizedModelId === 'gemini') {
                const { VertexAI } = require('@google-cloud/vertexai');
                const dest = await getDestination({ destinationName: 'geminivertex_api' });
                const svcKey = dest.originalProperties;
                const vertexAI = new VertexAI({ project: svcKey.project_id, location: 'us-central1', googleAuthOptions: { credentials: { client_email: svcKey.client_email, private_key: svcKey.private_key.replace(/\\n/g, '\n') } } });
                const model = vertexAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite', systemInstruction: { parts: [{ text: GLOBAL_SYSTEM_INSTRUCTION }] } });
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
                fullResponse = await streamClaude(prompt, GLOBAL_SYSTEM_INSTRUCTION, history, onChunk);
            } else {
                let res = normalizedModelId === 'gpt4o' ? await callGPT4o(prompt, GLOBAL_SYSTEM_INSTRUCTION, history) : await callSAPGenAIHub(prompt, GLOBAL_SYSTEM_INSTRUCTION, history);
                fullResponse = (res.error || !res.content) ? "model is not available at the moment" : res.content;
                onChunk(fullResponse);
            }

            if (fullResponse !== "model is not available at the moment") {
                const validation = await extractAndValidateABAP(fullResponse);
                if (validation.hasAbap) {
                    fullResponse += validation.report;
                    onChunk(validation.report);
                }
            }

            await INSERT.into('sap.aigateway.ChatMessages').entries({ session_ID: sessionId, role: 'assistant', content: fullResponse, modelId: modelId, latency: Date.now() - latencyStart });

        } catch (error) { 
            onChunk("model is not available at the moment");
            await INSERT.into('sap.aigateway.ChatMessages').entries({ session_ID: sessionId, role: 'assistant', content: "model is not available at the moment", modelId: modelId, latency: Date.now() - latencyStart });
        }
    };
});

async function callGemini(prompt, systemInstruction, history = []) {
    const start = Date.now();
    try {
        const { VertexAI } = require('@google-cloud/vertexai');
        const dest = await getDestination({ destinationName: 'geminivertex_api' });
        const svcKey = dest.originalProperties;
        const vertexAI = new VertexAI({ project: svcKey.project_id, location: 'us-central1', googleAuthOptions: { credentials: { client_email: svcKey.client_email, private_key: svcKey.private_key.replace(/\\n/g, '\n') } } });
        const model = vertexAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite', systemInstruction: { parts: [{ text: systemInstruction }] } });
        const chatHistory = history.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
        
        const result = await model.startChat({ history: chatHistory }).sendMessage(prompt);
        return { modelId: 'gemini', content: result.response.candidates[0].content.parts[0].text, latency: Date.now() - start };
    } catch (err) { return { modelId: 'gemini', content: "model is not available at the moment", latency: 0, error: true }; }
}

async function callGPT4o(prompt, systemInstruction, history = []) {
    const start = Date.now();
    try {
        const openai = await cds.connect.to("openai");
        const messages = [{ role: 'system', content: systemInstruction }, ...history, { role: 'user', content: prompt }];
        const response = await openai.send({ query: "POST /chat/completions?api-version=2024-02-15-preview", data: { model: "gpt-4o", temperature: 0.5, messages: messages }, headers: { "AI-Resource-Group": "default", "Content-Type": "application/json" } });

        if (!response || !response.choices) throw new Error();
        return { modelId: 'gpt4o', content: response.choices[0].message.content, latency: Date.now() - start };
    } catch (err) { return { modelId: 'gpt4o', content: "model is not available at the moment", latency: 0, error: err }; }
}

async function callSAPGenAIHub(prompt, systemInstruction, history = []) {
    const start = Date.now();
    try {
        const openai = await cds.connect.to("perplexity");
        const messages = [{ role: 'system', content: systemInstruction }, ...history, { role: 'user', content: prompt }];
        
        const response = await openai.send({ query: "POST /chat/completions?api-version=2024-02-15-preview", data: { model: "sonar", max_tokens: 2000, temperature: 0.5, messages: messages }, headers: { "AI-Resource-Group": "default", "Content-Type": "application/json" } });

        if (!response || !response.choices) throw new Error();
        return { modelId: 'perplexity', content: response.choices[0].message.content, latency: Date.now() - start };
    } catch (err) { return { modelId: 'perplexity', content: "model is not available at the moment", latency: 0, error: true }; }
}

async function callClaude(prompt, systemInstruction, history = []) {
    const start = Date.now();
    try {
        const dest = await getDestination({ destinationName: 'claude_api' });
        const apikey = dest.originalProperties.apikey;
        
        const formattedHistory = history.map(m => ({ role: m.role, content: m.content }));
        
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: "POST",
            headers: { "x-api-key": apikey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
            body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 8000, system: systemInstruction, messages: [...formattedHistory, { role: 'user', content: prompt }] })
        });

        if (!response.ok) throw new Error();
        const data = await response.json();
        
        return { modelId: 'claude', content: data.content[0].text, latency: Date.now() - start };
    } catch (err) { return { modelId: 'claude', content: "model is not available at the moment", latency: 0, error: true }; }
}

async function streamClaude(prompt, systemInstruction, history, onChunk) {
    const dest = await getDestination({ destinationName: 'claude_api' });
    const apikey = dest.originalProperties.apikey;
    
    const formattedHistory = history.map(m => ({ role: m.role, content: m.content }));
    
    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: "POST",
        headers: { "x-api-key": apikey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-20250514", stream: true, max_tokens: 4000, system: systemInstruction, messages: [...formattedHistory, { role: 'user', content: prompt }] })
    });

    if (!response.ok) throw new Error();

    let fullResponse = "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = ""; 

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        
        buffer = lines.pop() || "";
        
        for (let line of lines) {
            line = line.trim();
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                try {
                    const data = JSON.parse(line.slice(6));
                    if (data.type === 'content_block_delta' && data.delta && data.delta.text) {
                        fullResponse += data.delta.text;
                        onChunk(data.delta.text);
                    }
                } catch (err) {}
            }
        }
    }
    
    return fullResponse;
}