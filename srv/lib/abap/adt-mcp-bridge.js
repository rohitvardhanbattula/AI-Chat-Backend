'use strict';
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { getDestination } = require('@sap-cloud-sdk/connectivity');
const path = require('path');

// ── Structured logger ─────────────────────────────────────────────────────────
// Every log line is a JSON object so it can be ingested by any log aggregator
// (Cloud Foundry, Kibana, Splunk, etc.) while still being readable in a terminal.
//
// Format: [MCP Bridge] <event> | <json-payload>
//
// Events emitted:
//   CONNECT_START        – about to spawn MCP child process
//   CONNECT_TOOLS        – child process up, listing available tools
//   CONNECT_LOGIN        – firing the login tool to verify credentials
//   CONNECT_OK           – session fully established
//   CONNECT_FAIL         – connection or login threw
//   CONNECT_LOGIN_RETRY  – login hit a transient network error (ECONNRESET/
//                          ETIMEDOUT/etc.), retrying once before failing
//   CHECK_RETRY          – health-check ping hit a transient network error,
//                          retrying once before reporting disconnected
//   RECONNECT_CLOSE      – closing old transport before reconnect
//   REMAP_OK             – tempId → realId migration succeeded
//   REMAP_MISS           – tempId had no session (no-op)
//   REMAP_COLLISION      – newId already had a session (closed it first)
//   CHECK_START          – health-check ping initiated
//   CHECK_OK             – ping returned alive
//   CHECK_FAIL           – ping returned dead / threw
//   TOOL_CALL            – executeTool invoked (name + args logged)
//   TOOL_RESULT          – executeTool response received (truncated preview)
//   TOOL_ERROR           – executeTool threw
//   NO_SESSION           – action attempted but no session for this id
//   TOOLS_LIST           – getToolsForLLM called (session found)

function mcpLog(level, event, payload = {}) {
    const entry = {
        ts:    new Date().toISOString(),
        level,
        event,
        ...payload,
    };
    const line = `[MCP Bridge] ${event} | ${JSON.stringify(entry)}`;
    if      (level === 'ERROR') console.error(line);
    else if (level === 'WARN')  console.warn(line);
    else                        console.log(line);
}

// Truncate long strings for log previews so the output stays readable
function preview(val, maxLen = 300) {
    const str = typeof val === 'string' ? val : JSON.stringify(val);
    if (!str) return '';
    return str.length > maxLen ? str.slice(0, maxLen) + `…(+${str.length - maxLen} chars)` : str;
}

// ── Transient network error retry helper ────────────────────────────────────
// The BTP Connectivity Proxy / Cloud Connector tunnel occasionally resets the
// connection (ECONNRESET) if the on-prem backend is slow to answer the ADT
// login handshake — the same login works fine outside the tunnel (e.g. via
// Claude Desktop directly against the system), so this looks like tunnel
// timeout behavior rather than a real auth/connectivity failure. A single
// quick retry is usually enough, since the backend session/buffers are
// already "warm" from the first attempt.
const TRANSIENT_ERROR_PATTERNS = ['ECONNRESET', 'ETIMEDOUT', 'socket hang up', 'EPIPE'];

function isTransientNetworkError(err) {
    const msg = (err && err.message) || '';
    return TRANSIENT_ERROR_PATTERNS.some(pattern => msg.includes(pattern));
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Call the MCP `login` tool, retrying once on a transient network error
 * (ECONNRESET / ETIMEDOUT / socket hang up / EPIPE) before giving up.
 *
 * IMPORTANT: MCP tool-execution failures do NOT reject the promise — they
 * resolve normally with `isError: true` and the error text buried in
 * `result.content[0].text` (see the comment further down where this is
 * consumed). So a transient failure has to be detected on the *resolved*
 * result, not just via try/catch — a bare try/catch around callTool() alone
 * would never see it and would never retry.
 */
async function callLoginWithRetry(client, sessionId, { maxRetries = 1, retryDelayMs = 500, logPrefix = 'CONNECT_LOGIN' } = {}) {
    let attempt = 0;
    for (;;) {
        attempt++;
        let result;
        try {
            result = await client.callTool({ name: 'login', arguments: {} });
        } catch (err) {
            const canRetry = attempt <= maxRetries && isTransientNetworkError(err);
            if (!canRetry) throw err;
            mcpLog('WARN', `${logPrefix}_RETRY`, {
                sessionId, attempt, error: err.message, retryInMs: retryDelayMs, source: 'exception',
            });
            await sleep(retryDelayMs);
            continue;
        }

        const resultText = result?.content?.[0]?.text;
        const resolvedAsError = result?.isError && isTransientNetworkError({ message: resultText || '' });
        if (resolvedAsError && attempt <= maxRetries) {
            mcpLog('WARN', `${logPrefix}_RETRY`, {
                sessionId, attempt, error: preview(resultText), retryInMs: retryDelayMs, source: 'isError result',
            });
            await sleep(retryDelayMs);
            continue;
        }

        return result;
    }
}

// ── Session lifecycle limits ─────────────────────────────────────────────────
// Each session holds a live spawned child process (StdioClientTransport) in
// memory on THIS instance. Left unbounded, abandoned sessions (user closes
// the tab without disconnecting) accumulate child processes until the app
// OOMs or runs out of file descriptors. These two knobs put a hard ceiling
// on that: a cap on concurrent sessions, and an idle sweep that kills
// sessions nobody has touched in a while. Both are overridable via env vars
// so they can be tuned per-environment without a redeploy.
const MAX_MCP_SESSIONS      = Number(process.env.MCP_MAX_SESSIONS) || 25;
const SESSION_IDLE_TIMEOUT_MS = Number(process.env.MCP_SESSION_IDLE_TIMEOUT_MS) || 30 * 60 * 1000; // 30 min
const IDLE_SWEEP_INTERVAL_MS  = 5 * 60 * 1000; // check every 5 min

// ── Bridge manager ─────────────────────────────────────────────────────────────
class AdtMcpBridgeManager {
    constructor() {
        // Store in-memory connections mapped by sessionId
        this.sessions = new Map();

        // Periodically close sessions that have been idle too long.
        this._sweepTimer = setInterval(() => this._sweepIdleSessions(), IDLE_SWEEP_INTERVAL_MS);
        if (typeof this._sweepTimer.unref === 'function') this._sweepTimer.unref();
    }

    // ── Internal: close + remove a session's transport safely ───────────────
    async _closeAndDelete(sessionId, session, reason) {
        try {
            if (session?.transport && typeof session.transport.close === 'function') {
                await session.transport.close();
            }
        } catch (e) {
            mcpLog('WARN', 'SESSION_CLOSE_FAIL', { sessionId, reason, error: e.message });
        }
        this.sessions.delete(sessionId);
        mcpLog('INFO', 'SESSION_CLOSED', { sessionId, reason });
    }

    // ── Internal: idle sweep, called on a timer ──────────────────────────────
    _sweepIdleSessions() {
        const now = Date.now();
        for (const [sessionId, session] of this.sessions.entries()) {
            const idleFor = now - (session.lastActivity || 0);
            if (idleFor > SESSION_IDLE_TIMEOUT_MS) {
                mcpLog('INFO', 'SESSION_IDLE_EVICT', { sessionId, idleForMs: idleFor });
                this._closeAndDelete(sessionId, session, 'idle-timeout').catch(() => {});
            }
        }
    }

    // ── Internal: bump last-activity timestamp on any use ────────────────────
    _touch(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) session.lastActivity = Date.now();
    }

    // ── Connect ────────────────────────────────────────────────────────────
    async connectWithCredentials(sessionId, credentials) {
        mcpLog('INFO', 'CONNECT_START', {
            sessionId,
            destinationName: credentials.destinationName,
            user:     credentials.user,
            client:   credentials.client,
            language: credentials.language,
            // password intentionally omitted from logs
        });

        // ── Resolve the BTP Destination ──────────────────────────────────────
        // The client only ever sends a destination *name* (picked from the
        // Destinations table / dropdown) — never a raw system URL. We resolve
        // the actual host here via the bound Destination service.
        let destination;
        try {
            destination = await getDestination({ destinationName: credentials.destinationName });
        } catch (err) {
            mcpLog('ERROR', 'CONNECT_FAIL', {
                sessionId,
                destinationName: credentials.destinationName,
                reason: 'destination lookup threw',
                error: err.message,
            });
            throw new Error(`Could not resolve destination "${credentials.destinationName}": ${err.message}`);
        }

        if (!destination || !destination.url) {
            mcpLog('ERROR', 'CONNECT_FAIL', {
                sessionId,
                destinationName: credentials.destinationName,
                reason: 'destination not found or has no url',
            });
            throw new Error(
                `Destination "${credentials.destinationName}" was not found (or has no URL). ` +
                `Check that it exists in the BTP cockpit under Connectivity > Destinations and that the name matches exactly.`
            );
        }

        // For OnPremise-proxied destinations, a raw resolved URL isn't enough to
        // reach the system — the request has to go through the Connectivity
        // Proxy / Cloud Connector tunnel. The spawned MCP process is told to use
        // `DestinationProxyHttpClient` (which re-resolves this same destination
        // and routes through that tunnel) instead of connecting to SAP_URL
        // directly. Internet-proxied destinations are simple and reachable
        // directly, so they keep using the plain SAP_URL path.
        const useDestinationProxy = destination.proxyType === 'OnPremise';
        if (useDestinationProxy) {
            mcpLog('INFO', 'CONNECT_START', {
                sessionId,
                destinationName: credentials.destinationName,
                info: 'OnPremise destination — routing through Connectivity Proxy / Cloud Connector tunnel',
            });
        }

        const url = destination.url;

        // Close and cleanup existing session if redefining
        if (this.sessions.has(sessionId)) {
            mcpLog('INFO', 'RECONNECT_CLOSE', { sessionId, reason: 'replacing existing session' });
            await this._closeAndDelete(sessionId, this.sessions.get(sessionId), 'reconnect');
        } else if (this.sessions.size >= MAX_MCP_SESSIONS) {
            // Only a genuinely new session counts against the cap — reconnects
            // to an existing sessionId are always allowed since they net zero.
            mcpLog('ERROR', 'CONNECT_FAIL', {
                sessionId,
                reason: 'session cap reached',
                activeSessions: this.sessions.size,
                cap: MAX_MCP_SESSIONS,
            });
            throw new Error(
                `Too many active SAP connections right now (${this.sessions.size}/${MAX_MCP_SESSIONS}). ` +
                `Please try again shortly, or ask an idle user to disconnect.`
            );
        }

        const client = new Client(
            { name: `ai-chat-backend-${sessionId}`, version: '1.0.0' },
            { capabilities: { tools: {} } }
        );
        const serverPath = path.resolve(__dirname, '../../../mcp-abap-abap-adt-api-main/dist/index.js');

        const env = {
            ...process.env,
            SAP_URL:                  url,
            SAP_USER:                 credentials.user,
            SAP_PASSWORD:             credentials.password,
            SAP_CLIENT:               credentials.client,
            SAP_LANGUAGE:             credentials.language,
            SAP_USE_DESTINATION_PROXY: String(useDestinationProxy),
            SAP_DESTINATION_NAME:      credentials.destinationName,
        };

        const transport = new StdioClientTransport({ command: 'node', args: [serverPath], env });

        const connectStart = Date.now();
        await client.connect(transport);
        mcpLog('INFO', 'CONNECT_TOOLS', { sessionId, spawnMs: Date.now() - connectStart });

        const toolsResponse  = await client.listTools();
        const availableTools = toolsResponse.tools || [];
        const toolNames      = availableTools.map(t => t.name);

        // mcpLog('INFO', 'CONNECT_TOOLS', {
        //     sessionId,
        //     toolCount: availableTools.length,
        //     tools:     toolNames,
        // });

        // Store session before login so executeTool can use it
        this.sessions.set(sessionId, { client, transport, availableTools, lastActivity: Date.now() });

        // Connection is only considered successful when the login tool succeeds.
        const hasLogin = availableTools.find(t => t.name === 'login');
        if (!hasLogin) {
            this.sessions.delete(sessionId);
            mcpLog('ERROR', 'CONNECT_FAIL', { sessionId, reason: 'login tool not exposed by MCP server' });
            throw new Error('MCP server does not expose a login tool. Cannot verify connection.');
        }

        mcpLog('INFO', 'CONNECT_LOGIN', { sessionId, tool: 'login', args: {} });
        const loginStart = Date.now();
        let loginResult;
        try {
            loginResult = await callLoginWithRetry(client, sessionId, { logPrefix: 'CONNECT_LOGIN' });
        } catch (err) {
            this.sessions.delete(sessionId);
            mcpLog('ERROR', 'CONNECT_FAIL', {
                sessionId,
                tool:     'login',
                loginMs:  Date.now() - loginStart,
                error:    err.message,
            });
            throw new Error(`SAP login failed: Please check your credentials and URL. (${err.message})`);
        }

        const loginText = loginResult?.content?.[0]?.text;

        // MCP tool-execution failures resolve normally with isError:true —
        // they do NOT reject the promise. Without this check, a failed SAP
        // login (e.g. a 500 from the ADT login endpoint) would fall through
        // to the success path below and the connection would be marked
        // "connected" even though authentication never succeeded.
        if (loginResult?.isError) {
            this.sessions.delete(sessionId);
            mcpLog('ERROR', 'CONNECT_FAIL', {
                sessionId,
                tool:     'login',
                loginMs:  Date.now() - loginStart,
                error:    preview(loginText),
            });
            throw new Error(`SAP login failed: ${loginText || 'Unknown error'}`);
        }

        mcpLog('INFO', 'CONNECT_OK', {
            sessionId,
            loginMs:  Date.now() - loginStart,
            response: preview(loginText),
        });
        return `Connection established and authenticated. ${loginText ? loginText : ''}`.trim();
    }

    // ── Remap ──────────────────────────────────────────────────────────────
    /**
     * Move an existing bridge connection from tempId to a real DB session UUID
     * without re-authenticating.
     */
    remapSession(tempId, newId) {
        if (!this.sessions.has(tempId)) {
            mcpLog('WARN', 'REMAP_MISS', { tempId, newId, activeSessions: [...this.sessions.keys()] });
            return false;
        }

        if (this.sessions.has(newId)) {
            mcpLog('WARN', 'REMAP_COLLISION', { tempId, newId, action: 'closing existing newId session' });
            this._closeAndDelete(newId, this.sessions.get(newId), 'remap-collision').catch(() => {});
        }

        const session = this.sessions.get(tempId);
        this.sessions.set(newId, session);
        this.sessions.delete(tempId);

        mcpLog('INFO', 'REMAP_OK', {
            tempId,
            newId,
            toolCount: session.availableTools.length,
            tools:     session.availableTools.map(t => t.name),
        });
        return true;
    }

    // ── Health check ───────────────────────────────────────────────────────
    /**
     * Ping the SAP connection. Returns { connected, message }.
     */
    async checkConnection(sessionId) {
        mcpLog('INFO', 'CHECK_START', { sessionId });

        const session = this.sessions.get(sessionId);
        if (!session) {
            mcpLog('WARN', 'NO_SESSION', { sessionId, caller: 'checkConnection' });
            return { connected: false, message: 'No active SAP connection for this session.' };
        }

        const hasLogin = session.availableTools.find(t => t.name === 'login');
        if (!hasLogin) {
            mcpLog('WARN', 'CHECK_FAIL', { sessionId, reason: 'login tool unavailable in session' });
            return { connected: false, message: 'MCP session exists but login tool is unavailable.' };
        }

        const pingStart = Date.now();
        try {
            const result = await callLoginWithRetry(session.client, sessionId, { logPrefix: 'CHECK' });
            const text   = result?.content?.[0]?.text || 'OK';
            // NOTE: intentionally NOT touching lastActivity here — checkConnection
            // is a passive health-check the UI may poll on a timer, and treating
            // polling as "activity" would defeat the idle-eviction sweep entirely.

            // As in connectWithCredentials: a failed login resolves with
            // isError:true rather than rejecting. Treat that as disconnected.
            if (result?.isError) {
                mcpLog('WARN', 'CHECK_FAIL', { sessionId, pingMs: Date.now() - pingStart, error: preview(text) });
                return { connected: false, message: `SAP ping failed: ${text || 'Unknown error'}` };
            }

            mcpLog('INFO', 'CHECK_OK', { sessionId, pingMs: Date.now() - pingStart, response: preview(text) });
            return { connected: true, message: text };
        } catch (err) {
            mcpLog('WARN', 'CHECK_FAIL', {
                sessionId,
                pingMs: Date.now() - pingStart,
                error:  err.message,
            });
            return { connected: false, message: `SAP ping failed: ${err.message}` };
        }
    }

    // ── Tools list for LLM ─────────────────────────────────────────────────
    getToolsForLLM(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            mcpLog('WARN', 'NO_SESSION', { sessionId, caller: 'getToolsForLLM' });
            return [];
        }
        const tools = session.availableTools.map(tool => ({
            name:        tool.name,
            description: tool.description,
            parameters:  tool.inputSchema
        }));
        mcpLog('INFO', 'TOOLS_LIST', { sessionId, toolCount: tools.length, tools: tools.map(t => t.name) });
        return tools;
    }

    // ── Execute tool ───────────────────────────────────────────────────────
    async executeTool(sessionId, name, args) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            mcpLog('WARN', 'NO_SESSION', { sessionId, caller: 'executeTool', tool: name });
            return JSON.stringify({ error: 'No active SAP connection for this session. Please connect via the UI first.' });
        }

        mcpLog('INFO', 'TOOL_CALL', {
            sessionId,
            tool: name,
            args: preview(args),   // args may contain code snippets — truncate
        });

        this._touch(sessionId); // real usage — resets the idle-eviction clock

        const callStart = Date.now();
        try {
            const result  = await session.client.callTool({ name, arguments: args });
            const text    = result.content[0].text;
            mcpLog('INFO', 'TOOL_RESULT', {
                sessionId,
                tool:    name,
                callMs:  Date.now() - callStart,
                preview: preview(text),
            });
            return text;
        } catch (err) {
            mcpLog('ERROR', 'TOOL_ERROR', {
                sessionId,
                tool:   name,
                callMs: Date.now() - callStart,
                error:  err.message,
            });
            return JSON.stringify({ error: err.message });
        }
    }
}

module.exports = new AdtMcpBridgeManager();