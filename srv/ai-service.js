'use strict';
const cds = require('@sap/cds');
const { validateAbapSyntax } = require('./lib/abap/validation');
const { generateWithValidation } = require('./lib/handlers/GenerationHandler');
const AuthService = require('./lib/handlers/AuthService');
const { MAX_PROMPTS_PER_SESSION } = require('./lib/utils/constants');
const { callGemini, callGPT4o, callSAPGenAIHub, callClaude, resolveClaudeModel } = require('./lib/ai/llm-provider');
const { buildPromptWithContext, GLOBAL_SYSTEM_INSTRUCTION } = require('./lib/utils/helpers');

const MODEL_IDS = ['gemini', 'gpt4o', 'perplexity', 'claude'];

module.exports = cds.service.impl(async function () {

    // Auth and limits
    this.before('CREATE', 'ChatSessions', AuthService.checkChatLimits);
    this.on('register', AuthService.register);
    this.on('verifyOTP', AuthService.verifyOTP);
    this.on('login', AuthService.login);
    this.on('submitRating', AuthService.submitRating);


    this.on('establishConnection', async (req) => {
        const { sessionId, url, user, password, client, language } = req.data;
        try {
            const mcpBridge = require('./lib/abap/adt-mcp-bridge');
            console.log(`[MCP Bridge] Establishing connection for session ${sessionId} with URL: ${url}`);
            const result = await mcpBridge.connectWithCredentials(sessionId, { url, user, password, client, language });
            const loginResult = await mcpBridge.executeTool(sessionId, 'login', {});
        console.log('[MCP Bridge] Login result:', loginResult);
            return result;
        } catch (err) {
            return req.reject(400, err.message);
        }
    });

    // Validation tools
    this.on('validateABAPCode', async (req) => {
        const issues = await validateAbapSyntax(req.data.code);
        return issues.length > 0 ? issues : ['No high-risk syntax issues found.'];
    });

    this.on('generateMultiModelResponse', async (req) => {
        const { prompt, category, extractedText } = req.data;
        const claudeModel = resolveClaudeModel(category);
        const promptWithContext = buildPromptWithContext(prompt, extractedText);

        const results = await Promise.allSettled([
            callGemini(promptWithContext, GLOBAL_SYSTEM_INSTRUCTION),
            callGPT4o(promptWithContext, GLOBAL_SYSTEM_INSTRUCTION),
            callSAPGenAIHub(promptWithContext, GLOBAL_SYSTEM_INSTRUCTION),
            callClaude(prompt, [], claudeModel, extractedText)
        ]);

        return results.map((result, index) => {
            if (result.status === 'fulfilled' && !result.value.error && result.value.content) {
                return result.value;
            }
            return { modelId: MODEL_IDS[index], content: 'model is not available at the moment', latency: 0, error: true };
        });
    });

    this.generateStreamNoSession = async function (modelId, prompt, category, extractedText, onChunk) {
        try {
            const finalOutput = await generateWithValidation(modelId, prompt, [], category, extractedText);
            onChunk(finalOutput);
        } catch (err) {
            console.error('generateStreamNoSession error:', err?.message || err);
            onChunk(`model is not available at the moment. Error: ${err?.message || err}`);
        }
    };

    this.generateStream = async function (sessionId, modelId, prompt, category, onChunk) {
        const [session, messagesData] = await Promise.all([
            SELECT.one.from('sap.aigateway.ChatSessions').where({ ID: sessionId }),
            SELECT.from('sap.aigateway.ChatMessages').where({ session_ID: sessionId }).orderBy('createdAt asc')
        ]);

        const userMessageCount = messagesData.reduce((acc, m) => acc + (m.role === 'user' ? 1 : 0), 0);
        if (userMessageCount >= MAX_PROMPTS_PER_SESSION) {
            throw new Error(`Maximum prompt limit (${MAX_PROMPTS_PER_SESSION}) reached for this chat. Please start a new chat.`);
        }

        const functionalSpec = session?.functionalspec || null;
        const dbHistory = messagesData.map(m => ({ role: m.role, content: m.content }));
        const latencyStart = Date.now();

        try {
            const finalOutput = await generateWithValidation(sessionId, modelId, prompt, dbHistory, category, functionalSpec);

            await INSERT.into('sap.aigateway.ChatMessages').entries([
                { session_ID: sessionId, role: 'user', content: prompt, modelId },
                { session_ID: sessionId, role: 'assistant', content: finalOutput, modelId, latency: Date.now() - latencyStart }
            ]);

            onChunk(finalOutput);
        } catch (err) {
            console.error('generateStream error:', err?.message || err);
            const errorMsg = 'model is not available at the moment';
            onChunk(errorMsg);

            await INSERT.into('sap.aigateway.ChatMessages').entries([
                { session_ID: sessionId, role: 'user', content: prompt, modelId },
                { session_ID: sessionId, role: 'assistant', content: errorMsg, modelId, latency: Date.now() - latencyStart }
            ]);
        }
    };
});