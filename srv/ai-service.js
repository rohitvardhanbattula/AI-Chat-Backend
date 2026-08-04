'use strict';
const cds = require('@sap/cds');
const { validateAbapSyntax } = require('./lib/abap/validation');
const { generateWithValidation } = require('./lib/handlers/GenerationHandler');
const AuthService = require('./lib/handlers/AuthService');
const { MAX_PROMPTS_PER_SESSION } = require('./lib/utils/constants');
const { callGemini, callGPT4o, callSAPGenAIHub, callClaude, resolveClaudeModel } = require('./lib/ai/llm-provider');
const { buildPromptWithContext, GLOBAL_SYSTEM_INSTRUCTION } = require('./lib/utils/helpers');
const { verifyAccessToken, purgeExpiredTokens, ConfigError } = require('./lib/auth/jwt');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

const MODEL_IDS = ['gemini', 'gpt4o', 'perplexity', 'claude'];

// ── Input sanitisation ────────────────────────────────────────────────────────
function sanitise(val, maxLen = 500_000) {
    if (typeof val !== 'string') return '';
    return val.slice(0, maxLen);
}

// ── Usage tracking ────────────────────────────────────────────────────────────
// Increments Users.promptCount by 1 every time a user submits a prompt.
// Fire-and-forget with logging so a tracking failure never breaks the chat flow.
async function incrementPromptCount(userId) {
    if (!userId) return;
    try {
        await UPDATE('sap.aigateway.Users')
            .set('promptCount = promptCount + 1')
            .where({ ID: userId });
    } catch (err) {
        console.error('[incrementPromptCount] failed for userId=' + userId, err?.message);
    }
}

// ── JWT guard for CDS actions that need authentication ─────────────────────────
async function requireJwt(req) {
    const headers = req._.req?.headers;
    const token = headers?.['x-custom-auth'] ||
        (headers?.authorization || '').replace('Bearer ', '') ||
        null;

    if (!token) return req.reject(401, 'Authentication required.');

    try {
        const payload = await verifyAccessToken(token);
        req.user = payload;
    } catch (err) {
        if (err instanceof ConfigError) {
            console.error('[Auth] Server misconfiguration:', err.message);
            return req.reject(500, 'Server authentication is misconfigured. Contact an administrator.');
        }
        return req.reject(401, err.message || 'Invalid token.');
    }
}

// ── Periodic housekeeping ─────────────────────────────────────────────────────
setInterval(() => {
    purgeExpiredTokens().catch(err =>
        console.error('[Auth] purgeExpiredTokens failed:', err?.message)
    );
}, 60 * 60 * 1000);

// ── Service implementation ────────────────────────────────────────────────────
module.exports = cds.service.impl(async function () {



    this.on('getChatSessions', async (req) => {
        await requireJwt(req);
        const { userId } = req.user;
        return await SELECT.from('sap.aigateway.ChatSessions')
            .where({ userId })
            .orderBy('createdAt desc');
    });

    this.on('getChatMessages', async (req) => {
        await requireJwt(req);
        const { sessionId } = req.data;
        return await SELECT.from('sap.aigateway.ChatMessages')
            .where({ session_ID: sessionId })
            .orderBy('createdAt asc');
    });

    // ── Destinations dropdown source ────────────────────────────────────────
    this.on('getDestinations', async (req) => {
        await requireJwt(req);
        return await SELECT.from('sap.aigateway.Destinations')
            .where({ isActive: true })
            .orderBy('name asc');
    });

    this.on('deleteSession', async (req) => {
        await requireJwt(req);
        const { sessionId } = req.data;
        await DELETE.from('sap.aigateway.ChatSessions').where({ ID: sessionId });
        return 'deleted';
    });

    this.on('createSession', async (req) => {
        await requireJwt(req);
        const { userId } = req.user;
        const { title, selectedModel, functionalspec, messages } = req.data;
        const { MAX_CHATS_PER_USER } = require('./lib/utils/constants');

        // Lock this user's row for the rest of the transaction. Two concurrent
        // createSession calls for the same user will now serialize here instead
        // of both reading the same pre-insert count and both slipping past the
        // limit — the second call blocks until the first commits (releasing the
        // lock), by which point its own count query sees the first call's insert.
        // No-op on sqlite (dev); enforced as a real row lock on HANA (prod).
        await SELECT.one.from('sap.aigateway.Users').where({ ID: userId }).forUpdate();

        const [{ count }] = await SELECT
            .from('sap.aigateway.ChatSessions')
            .columns('count(*) as count')
            .where({ userId });

        if (Number(count) >= MAX_CHATS_PER_USER) {
            return req.reject(403, `Maximum of ${MAX_CHATS_PER_USER} chats reached.`);
        }

        const crypto = require('crypto');
        const now = new Date().toISOString();
        const ID = crypto.randomUUID();

        await INSERT.into('sap.aigateway.ChatSessions').entries({
            ID, userId,
            title: title.slice(0, 100),
            selectedModel,
            functionalspec: functionalspec ?? null,
            createdAt: now, createdBy: userId,
            modifiedAt: now, modifiedBy: userId
        });

        if (messages && messages.length > 0) {
            const messageEntries = messages.map((m, i) => ({
                ID: crypto.randomUUID(),
                session_ID: ID,
                role: m.role,
                content: m.content,
                modelId: m.modelId || selectedModel,
                createdAt: new Date(Date.now() + i).toISOString(),
                createdBy: userId,
                modifiedAt: now,
                modifiedBy: userId
            }));
            await INSERT.into('sap.aigateway.ChatMessages').entries(messageEntries);
        }

        const session = await SELECT.one.from('sap.aigateway.ChatSessions').where({ ID });
        session.messages = (messages && messages.length > 0)
            ? await SELECT.from('sap.aigateway.ChatMessages').where({ session_ID: ID })
            : [];
        return session;
    });

    this.on('renameSession', async (req) => {
        await requireJwt(req);
        const { sessionId, title } = req.data;
        await UPDATE('sap.aigateway.ChatSessions').set({ title }).where({ ID: sessionId });
        return 'renamed';
    });

    // ── Auth — no JWT required ─────────────────────────────────────────────
    this.on('register', AuthService.register);
    this.on('verifyOTP', AuthService.verifyOTP);
    this.on('login', AuthService.login);
    this.on('refreshToken', AuthService.refreshToken);
    this.on('logout',          AuthService.logout);
    this.on('forgotPassword',  AuthService.forgotPassword);
    this.on('resetPassword',   AuthService.resetPassword);

    // ── SAP ADT MCP — initial connection ──────────────────────────────────
    this.on('establishConnection', async (req) => {
        await requireJwt(req);
        const { sessionId, destinationName, user, password, client, language } = req.data;
        console.log(`[AIService] establishConnection | sessionId=${sessionId} destinationName=${destinationName} user=${user} client=${client} language=${language}`);
        if (!sessionId || !destinationName || !user || !password) {
            return req.reject(400, 'sessionId, destinationName, user and password are required.');
        }
        try {
            const mcpBridge = require('./lib/abap/adt-mcp-bridge');
            const result = await mcpBridge.connectWithCredentials(sessionId, { destinationName, user, password, client, language });
            console.log(`[AIService] establishConnection OK | sessionId=${sessionId} result="${result}"`);
            return result;
        } catch (err) {
            console.error(`[AIService] establishConnection FAIL | sessionId=${sessionId} error="${err?.message}"`);
            return req.reject(400, err.message);
        }
    });

    // ── SAP ADT MCP — remap temp → real session ───────────────────────────
    this.on('remapConnection', async (req) => {
        await requireJwt(req);
        const { tempId, newSessionId } = req.data;
        console.log(`[AIService] remapConnection | tempId=${tempId} newSessionId=${newSessionId}`);
        if (!tempId || !newSessionId) {
            return req.reject(400, 'tempId and newSessionId are required.');
        }
        try {
            const mcpBridge = require('./lib/abap/adt-mcp-bridge');
            const ok = mcpBridge.remapSession(tempId, newSessionId);
            if (!ok) {
                console.warn(`[AIService] remapConnection no-op | tempId=${tempId} had no active session`);
                return 'no-op: tempId had no active session';
            }
            console.log(`[AIService] remapConnection OK | ${tempId} → ${newSessionId}`);
            return `Remapped ${tempId} → ${newSessionId}`;
        } catch (err) {
            console.error(`[AIService] remapConnection FAIL | tempId=${tempId} error="${err?.message}"`);
            return req.reject(500, err.message);
        }
    });

    // ── SAP ADT MCP — health check ────────────────────────────────────────
    this.on('checkConnection', async (req) => {
        await requireJwt(req);
        const { sessionId } = req.data;
        console.log(`[AIService] checkConnection | sessionId=${sessionId}`);
        if (!sessionId) {
            return req.reject(400, 'sessionId is required.');
        }
        try {
            const mcpBridge = require('./lib/abap/adt-mcp-bridge');
            const status = await mcpBridge.checkConnection(sessionId);
            console.log(`[AIService] checkConnection result | sessionId=${sessionId} connected=${status.connected} message="${status.message}"`);
            return status;
        } catch (err) {
            console.error(`[AIService] checkConnection FAIL | sessionId=${sessionId} error="${err?.message}"`);
            return { connected: false, message: err.message };
        }
    });

    // ── ABAP validation ────────────────────────────────────────────────────
    this.on('validateABAPCode', async (req) => {
        await requireJwt(req);
        const code = sanitise(req.data.code, 200_000);
        if (!code) return req.reject(400, 'code is required.');
        const issues = await validateAbapSyntax(code);
        return issues.length > 0 ? issues : ['No high-risk syntax issues found.'];
    });

    // ── Multi-model comparison (non-streaming, used as fallback) ───────────
    this.on('generateMultiModelResponse', async (req) => {
        await requireJwt(req);
        const prompt = sanitise(req.data.prompt, 50_000);
        const category = sanitise(req.data.category, 100);
        const extractedText = sanitise(req.data.extractedText, 200_000) || null;
        const connectionId = sanitise(req.data.connectionId, 100) || null;
        if (!prompt) return req.reject(400, 'prompt is required.');

        const claudeModel = resolveClaudeModel(category);
        const promptWithContext = buildPromptWithContext(prompt, extractedText);

        incrementPromptCount(req.user?.userId);

        const results = await Promise.allSettled([
            callGemini(connectionId, promptWithContext, GLOBAL_SYSTEM_INSTRUCTION),
            callGPT4o(connectionId, promptWithContext, GLOBAL_SYSTEM_INSTRUCTION),
            callSAPGenAIHub(connectionId, promptWithContext, GLOBAL_SYSTEM_INSTRUCTION),
            callClaude(connectionId, prompt, [], claudeModel, extractedText)
        ]);

        return results.map((r, i) =>
            r.status === 'fulfilled' && !r.value.error && r.value.content
                ? r.value
                : { modelId: MODEL_IDS[i], content: 'model is not available at the moment', latency: 0, error: true }
        );
    });

    // ── Rating ─────────────────────────────────────────────────────────────
    this.on('submitRating', async (req) => {
        await requireJwt(req);
        return AuthService.submitRating(req);
    });

    // ── Streaming (no session — comparison screen) ─────────────────────────
    this.generateStreamNoSession = async function (modelId, prompt, category, extractedText, onChunk, userId, connectionId) {
        const safePrompt = sanitise(prompt, 50_000);
        const safeSpec = sanitise(extractedText, 200_000) || null;
        incrementPromptCount(userId); // fire-and-forget
        try {
            const output = await generateWithValidation(connectionId || null, modelId, safePrompt, [], category, safeSpec);
            onChunk(output);
        } catch (err) {
            console.error('[generateStreamNoSession]', err?.message);
            throw err;
        }
    };

    // ── Streaming (with session — active chat) ─────────────────────────────
    this.generateStream = async function (sessionId, modelId, prompt, category, extractedText, onChunk, userId) {
        const crypto = require('crypto');
        const safePrompt = sanitise(prompt, 50_000);
        const safeSpec = sanitise(extractedText, 200_000) || null;
        incrementPromptCount(userId); // fire-and-forget

        let session, messagesData;
        const reservedAt = new Date().toISOString();

        // ── Atomically reserve a prompt "slot" ──────────────────────────────
        // The old code checked the count *before* the LLM call but only
        // inserted the user's message *after* it finished (which can take
        // minutes) — two concurrent prompts in the same session could both
        // read the same pre-call count and both slip past MAX_PROMPTS_PER_SESSION.
        // Locking the session row, re-checking, and inserting the message all
        // happen here in one short transaction (milliseconds), closing that
        // window, instead of holding a lock for the entire LLM round-trip.
        await cds.tx(async (tx) => {
            session = await tx.run(
                SELECT.one.from('sap.aigateway.ChatSessions').where({ ID: sessionId }).forUpdate()
            );
            if (!session) throw new Error('Session not found.');

            messagesData = await tx.run(
                SELECT.from('sap.aigateway.ChatMessages')
                    .where({ session_ID: sessionId })
                    .orderBy('createdAt asc')
            );

            const userMessageCount = messagesData.reduce((acc, m) => acc + (m.role === 'user' ? 1 : 0), 0);
            if (userMessageCount >= MAX_PROMPTS_PER_SESSION) {
                throw new Error(`Maximum prompt limit (${MAX_PROMPTS_PER_SESSION}) reached. Please start a new chat.`);
            }

            await tx.run(INSERT.into('sap.aigateway.ChatMessages').entries({
                ID: crypto.randomUUID(), session_ID: sessionId,
                role: 'user', content: safePrompt, modelId,
                createdAt: reservedAt, createdBy: 'system',
                modifiedAt: reservedAt, modifiedBy: 'system'
            }));
        });

        const functionalSpec = safeSpec || session.functionalspec || null;
        // messagesData was captured BEFORE the reservation insert above, so it
        // correctly excludes the current prompt — same semantics as before.
        const dbHistory = messagesData.map(m => ({ role: m.role, content: m.content }));
        const latencyStart = Date.now();

        try {
            const output = await generateWithValidation(sessionId, modelId, safePrompt, dbHistory, category, functionalSpec);
            const latency = Date.now() - latencyStart;
            const now = new Date().toISOString();

            await INSERT.into('sap.aigateway.ChatMessages').entries({
                ID: crypto.randomUUID(), session_ID: sessionId,
                role: 'assistant', content: output, modelId, latency,
                createdAt: now, createdBy: 'system',
                modifiedAt: now, modifiedBy: 'system'
            });

            onChunk(output);
        } catch (err) {
            console.error('[generateStream]', err?.message);
            const errMsg = err?.message || 'An unexpected error occurred.';
            const latency = Date.now() - latencyStart;
            const now = new Date().toISOString();

            // Re-throw limit errors so the SSE layer can send the correct error
            // event to the frontend (which shows the "start a new chat" popup).
            // For all other errors, record the failure in the DB and surface the
            // real message — never silently swallow it as "model is not available".
            if (errMsg.includes('Maximum prompt limit')) {
                throw err;
            }

            await INSERT.into('sap.aigateway.ChatMessages').entries({
                ID: crypto.randomUUID(), session_ID: sessionId,
                role: 'assistant', content: errMsg, modelId, latency,
                createdAt: now, createdBy: 'system',
                modifiedAt: now, modifiedBy: 'system'
            });
            onChunk(errMsg);
        }
    };
});