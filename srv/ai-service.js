'use strict';
const cds = require('@sap/cds');
const { validateAbapSyntax } = require('./lib/abap/validation');
const { generateWithValidation } = require('./lib/handlers/GenerationHandler');
const AuthService = require('./lib/handlers/AuthService');
const { MAX_PROMPTS_PER_SESSION } = require('./lib/utils/constants');
const { callGemini, callGPT4o, callSAPGenAIHub, callClaude, resolveClaudeModel } = require('./lib/ai/llm-provider');
const { buildPromptWithContext, GLOBAL_SYSTEM_INSTRUCTION } = require('./lib/utils/helpers');
const { verifyAccessToken, purgeExpiredTokens } = require('./lib/auth/jwt');

const MODEL_IDS = ['gemini', 'gpt4o', 'perplexity', 'claude'];

// ── Input sanitisation ────────────────────────────────────────────────────────
function sanitise(val, maxLen = 500_000) {
    if (typeof val !== 'string') return '';
    return val.slice(0, maxLen);
}

// ── JWT guard for CDS actions that need authentication ─────────────────────────
async function requireJwt(req) {
    // In dev/hybrid, skip JWT — CDS dummy auth handles access
    // In production, NODE_ENV=production is set via mta.yaml
    console.log('>>> requireJwt called, NODE_ENV:', process.env.NODE_ENV);
    if (process.env.NODE_ENV !== 'production') return;
    
    const raw = req._.req?.headers;
    const authHeader = raw?.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) return req.reject(401, 'Authentication required.');

    try {
        const payload = await verifyAccessToken(token);
        req.user = payload;
    } catch (err) {
        return req.reject(401, err.message || 'Invalid token.');
    }
}
// ── Periodic housekeeping ─────────────────────────────────────────────────────
// Purge expired refresh tokens once every hour
setInterval(() => {
    purgeExpiredTokens().catch(err =>
        console.error('[Auth] purgeExpiredTokens failed:', err?.message)
    );
}, 60 * 60 * 1000);

// ── Service implementation ────────────────────────────────────────────────────
module.exports = cds.service.impl(async function () {

    // ── Auth — no JWT required ─────────────────────────────────────────────
    this.on('register',      AuthService.register);
    this.on('verifyOTP',     AuthService.verifyOTP);
    this.on('login',         AuthService.login);
    this.on('refreshToken',  AuthService.refreshToken);
    this.on('logout',        AuthService.logout);

    // ── Protected: all actions below require a valid access token ──────────
    this.before(['generateMultiModelResponse', 'sendChatMessage',
                 'submitRating', 'validateABAPCode', 'establishConnection',
                 'CREATE', 'UPDATE', 'DELETE', 'READ'], requireJwt);

    // ── Chat session limits ────────────────────────────────────────────────
    this.before('CREATE', 'ChatSessions', AuthService.checkChatLimits);

    // ── SAP ADT MCP connection ─────────────────────────────────────────────
    this.on('establishConnection', async (req) => {
        const { sessionId, url, user, password, client, language } = req.data;
        if (!sessionId || !url || !user || !password) {
            return req.reject(400, 'sessionId, url, user and password are required.');
        }
        try {
            const mcpBridge  = require('./lib/abap/adt-mcp-bridge');
            const result     = await mcpBridge.connectWithCredentials(sessionId, { url, user, password, client, language });
            await mcpBridge.executeTool(sessionId, 'login', {});
            return result;
        } catch (err) {
            console.error('[MCP Bridge] Connection error:', err?.message);
            return req.reject(400, err.message);
        }
    });

    // ── ABAP validation ────────────────────────────────────────────────────
    this.on('validateABAPCode', async (req) => {
        const code = sanitise(req.data.code, 200_000);
        if (!code) return req.reject(400, 'code is required.');
        const issues = await validateAbapSyntax(code);
        return issues.length > 0 ? issues : ['No high-risk syntax issues found.'];
    });

    // ── Multi-model comparison (non-streaming, used as fallback) ───────────
    this.on('generateMultiModelResponse', async (req) => {
        const prompt        = sanitise(req.data.prompt, 50_000);
        const category      = sanitise(req.data.category, 100);
        const extractedText = sanitise(req.data.extractedText, 200_000) || null;
        if (!prompt) return req.reject(400, 'prompt is required.');

        const claudeModel       = resolveClaudeModel(category);
        const promptWithContext = buildPromptWithContext(prompt, extractedText);

        const results = await Promise.allSettled([
            callGemini(null, promptWithContext, GLOBAL_SYSTEM_INSTRUCTION),
            callGPT4o(null, promptWithContext, GLOBAL_SYSTEM_INSTRUCTION),
            callSAPGenAIHub(null, promptWithContext, GLOBAL_SYSTEM_INSTRUCTION),
            callClaude(null, prompt, [], claudeModel, extractedText)
        ]);

        return results.map((r, i) =>
            r.status === 'fulfilled' && !r.value.error && r.value.content
                ? r.value
                : { modelId: MODEL_IDS[i], content: 'model is not available at the moment', latency: 0, error: true }
        );
    });

    // ── Rating ─────────────────────────────────────────────────────────────
    this.on('submitRating', AuthService.submitRating);

    // ── Streaming (no session — comparison screen) ─────────────────────────
    this.generateStreamNoSession = async function (modelId, prompt, category, extractedText, onChunk) {
        const safePrompt = sanitise(prompt, 50_000);
        const safeSpec   = sanitise(extractedText, 200_000) || null;
        try {
            const output = await generateWithValidation(null, modelId, safePrompt, [], category, safeSpec);
            onChunk(output);
        } catch (err) {
            console.error('[generateStreamNoSession]', err?.message);
            onChunk('model is not available at the moment');
        }
    };

    // ── Streaming (with session — active chat) ─────────────────────────────
    this.generateStream = async function (sessionId, modelId, prompt, category, extractedText, onChunk) {
        const safePrompt = sanitise(prompt, 50_000);
        const safeSpec   = sanitise(extractedText, 200_000) || null;

        const [session, messagesData] = await Promise.all([
            SELECT.one.from('sap.aigateway.ChatSessions').where({ ID: sessionId }),
            SELECT.from('sap.aigateway.ChatMessages')
                .where({ session_ID: sessionId })
                .orderBy('createdAt asc')
        ]);

        if (!session) throw new Error('Session not found.');

        const userMessageCount = messagesData.reduce((acc, m) => acc + (m.role === 'user' ? 1 : 0), 0);
        if (userMessageCount >= MAX_PROMPTS_PER_SESSION) {
            throw new Error(`Maximum prompt limit (${MAX_PROMPTS_PER_SESSION}) reached. Please start a new chat.`);
        }

        const functionalSpec = safeSpec || session.functionalspec || null;
        const dbHistory      = messagesData.map(m => ({ role: m.role, content: m.content }));
        const latencyStart   = Date.now();

        try {
            const output  = await generateWithValidation(sessionId, modelId, safePrompt, dbHistory, category, functionalSpec);
            const latency = Date.now() - latencyStart;

            await INSERT.into('sap.aigateway.ChatMessages').entries([
                { session_ID: sessionId, role: 'user',      content: safePrompt, modelId },
                { session_ID: sessionId, role: 'assistant', content: output,     modelId, latency }
            ]);

            onChunk(output);
        } catch (err) {
            console.error('[generateStream]', err?.message);
            const errMsg  = 'model is not available at the moment';
            const latency = Date.now() - latencyStart;
            onChunk(errMsg);

            await INSERT.into('sap.aigateway.ChatMessages').entries([
                { session_ID: sessionId, role: 'user',      content: safePrompt, modelId },
                { session_ID: sessionId, role: 'assistant', content: errMsg,     modelId, latency }
            ]);
        }
    };
});
