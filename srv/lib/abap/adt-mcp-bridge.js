'use strict';
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
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

// ── Bridge manager ─────────────────────────────────────────────────────────────
class AdtMcpBridgeManager {
    constructor() {
        // Store in-memory connections mapped by sessionId
        this.sessions = new Map();
    }

    // ── Connect ────────────────────────────────────────────────────────────
    async connectWithCredentials(sessionId, credentials) {
        mcpLog('INFO', 'CONNECT_START', {
            sessionId,
            url:      credentials.url,
            user:     credentials.user,
            client:   credentials.client,
            language: credentials.language,
            // password intentionally omitted from logs
        });

        // Close and cleanup existing session if redefining
        if (this.sessions.has(sessionId)) {
            mcpLog('INFO', 'RECONNECT_CLOSE', { sessionId, reason: 'replacing existing session' });
            const existing = this.sessions.get(sessionId);
            try {
                if (existing.transport && typeof existing.transport.close === 'function') {
                    await existing.transport.close();
                }
            } catch (e) {
                mcpLog('WARN', 'RECONNECT_CLOSE', { sessionId, error: e.message });
            }
            this.sessions.delete(sessionId);
        }

        const client = new Client(
            { name: `ai-chat-backend-${sessionId}`, version: '1.0.0' },
            { capabilities: { tools: {} } }
        );
        const serverPath = path.resolve(__dirname, '../../../mcp-abap-abap-adt-api-main/dist/index.js');

        const env = {
            ...process.env,
            SAP_URL:      credentials.url,
            SAP_USER:     credentials.user,
            SAP_PASSWORD: credentials.password,
            SAP_CLIENT:   credentials.client,
            SAP_LANGUAGE: credentials.language
        };

        const transport = new StdioClientTransport({ command: 'node', args: [serverPath], env });

        const connectStart = Date.now();
        await client.connect(transport);
        mcpLog('INFO', 'CONNECT_TOOLS', { sessionId, spawnMs: Date.now() - connectStart });

        const toolsResponse  = await client.listTools();
        const availableTools = toolsResponse.tools || [];
        const toolNames      = availableTools.map(t => t.name);

        mcpLog('INFO', 'CONNECT_TOOLS', {
            sessionId,
            toolCount: availableTools.length,
            tools:     toolNames,
        });

        // Store session before login so executeTool can use it
        this.sessions.set(sessionId, { client, transport, availableTools });

        // Connection is only considered successful when the login tool succeeds.
        const hasLogin = availableTools.find(t => t.name === 'login');
        if (!hasLogin) {
            this.sessions.delete(sessionId);
            mcpLog('ERROR', 'CONNECT_FAIL', { sessionId, reason: 'login tool not exposed by MCP server' });
            throw new Error('MCP server does not expose a login tool. Cannot verify connection.');
        }

        mcpLog('INFO', 'CONNECT_LOGIN', { sessionId, tool: 'login', args: {} });
        const loginStart = Date.now();
        try {
            const loginResult = await client.callTool({ name: 'login', arguments: {} });
            const loginText   = loginResult?.content?.[0]?.text;
            mcpLog('INFO', 'CONNECT_OK', {
                sessionId,
                loginMs:  Date.now() - loginStart,
                response: preview(loginText),
            });
            return `Connection established and authenticated. ${loginText ? loginText : ''}`.trim();
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
            const existing = this.sessions.get(newId);
            try {
                if (existing.transport && typeof existing.transport.close === 'function') {
                    existing.transport.close().catch(() => {});
                }
            } catch (_) { /* best effort */ }
            this.sessions.delete(newId);
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
            const result = await session.client.callTool({ name: 'login', arguments: {} });
            const text   = result?.content?.[0]?.text || 'OK';
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