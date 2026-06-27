'use strict';
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const path = require('path');

class AdtMcpBridgeManager {
    constructor() {
        // Store in-memory connections mapped by sessionId
        this.sessions = new Map();
    }

    async connectWithCredentials(sessionId, credentials) {
        // Close and cleanup existing session if redefining
        if (this.sessions.has(sessionId)) {
            const existing = this.sessions.get(sessionId);
            try {
                if (existing.transport && typeof existing.transport.close === 'function') {
                    await existing.transport.close();
                }
            } catch (e) {
                console.warn(`Could not close existing transport for session ${sessionId}:`, e.message);
            }
            this.sessions.delete(sessionId);
        }

        const client = new Client({ name: `ai-chat-backend-${sessionId}`, version: '1.0.0' }, { capabilities: { tools: {} } });
        const serverPath = path.resolve(__dirname, '../../../mcp-abap-abap-adt-api-main/dist/index.js');

        // Inject credentials strictly in memory for this specific child process
        const env = {
            ...process.env,
            SAP_URL: credentials.url,
            SAP_USER: credentials.user,
            SAP_PASSWORD: credentials.password,
            SAP_CLIENT: credentials.client,
            SAP_LANGUAGE: credentials.language
        };

        const transport = new StdioClientTransport({
            command: 'node',
            args: [serverPath],
            env: env
        });

        await client.connect(transport);
        const toolsResponse = await client.listTools();
        const availableTools = toolsResponse.tools || [];

        // Store session before login so executeTool can use it
        this.sessions.set(sessionId, { client, transport, availableTools });
        console.log(`[MCP Bridge] Session ${sessionId} connected. Registered ${availableTools.length} tools.`);

        // Connection is only considered successful when the login tool succeeds.
        // If login throws, we clean up the session and surface the error.
        const hasLogin = availableTools.find(t => t.name === 'login');
        if (!hasLogin) {
            this.sessions.delete(sessionId);
            throw new Error('MCP server does not expose a login tool. Cannot verify connection.');
        }

        try {
            const loginResult = await client.callTool({ name: 'login', arguments: {} });
            const loginText = loginResult?.content?.[0]?.text;
            console.log(`[MCP Bridge] Login successful for session ${sessionId}:`, loginText);
            return `Connection established and authenticated. ${loginText ? loginText : ''}`.trim();
        } catch (err) {
            this.sessions.delete(sessionId);
            throw new Error(`SAP login failed: Please check your credentials and URL. (${err.message})`);
        }
    }

    getToolsForLLM(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return [];
        return session.availableTools.map(tool => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema
        }));
    }

    async executeTool(sessionId, name, args) {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return JSON.stringify({ error: 'No active SAP connection for this session. Please connect via the UI first.' });
        }

        try {
            console.log(`[MCP Bridge] Executing tool '${name}' for session ${sessionId}...`);
            const result = await session.client.callTool({ name, arguments: args });
            return result.content[0].text;
        } catch (err) {
            console.error(`[MCP Bridge] Tool execution failed for '${name}':`, err);
            return JSON.stringify({ error: err.message });
        }
    }
}

module.exports = new AdtMcpBridgeManager();