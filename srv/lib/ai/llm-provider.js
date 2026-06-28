'use strict';
const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const mcpBridge = require('../abap/adt-mcp-bridge');
const {
    getCachedDestination, trimContext, GLOBAL_SYSTEM_INSTRUCTION, resolveClaudeModel,
    GENHUB_GEMINI_DEPLOYMENT, GENHUB_CLAUDE_DEPLOYMENT,
    CLAUDE_MAX_INPUT_TOKENS, GPT_MAX_INPUT_TOKENS,
    MAX_OUTPUT_TOKENS_CLAUDE, CLAUDE_MODEL_SIMPLE,GENHUB_GPT_DEPLOYMENT
} = require('../utils/helpers');

// Re-export resolveClaudeModel so callers that import it from here continue to work
module.exports.resolveClaudeModel = resolveClaudeModel;

// ─── Agentic tool loop ────────────────────────────────────────────────────────
// providerCallFn(prompt, systemInstruction, history, tools) → { content, toolCalls }
// toolCalls: [{ id, name, arguments }] | null
async function agenticToolLoop(sessionId, prompt, systemInstruction, history, providerCallFn) {
    let currentHistory  = [...history];
    let toolLoopCount   = 0;
    const MAX_TOOL_LOOPS = 5;

    const tools = sessionId ? mcpBridge.getToolsForLLM(sessionId) : [];

    while (toolLoopCount < MAX_TOOL_LOOPS) {
        const response = await providerCallFn(prompt, systemInstruction, currentHistory, tools);

        if (!response.toolCalls || response.toolCalls.length === 0) {
            return response.content;
        }

        const toolResults = [];
        for (const call of response.toolCalls) {
            const resultText = await mcpBridge.executeTool(sessionId, call.name, call.arguments);
            toolResults.push({ toolCallId: call.id, name: call.name, result: resultText });
        }

        currentHistory.push({ role: 'assistant', toolCalls: response.toolCalls, content: response.content || '' });
        currentHistory.push({ role: 'tool', results: toolResults });
        toolLoopCount++;
    }

    return 'The model requested too many operations. Please refine your query.';
}

// ─── Gemini ───────────────────────────────────────────────────────────────────
async function callGeminiViaGenHub(prompt, systemInstruction, history = [], tools = []) {
    const { history: safeHistory, prompt: safePrompt } = trimContext(prompt, history);

    const contents = [
        ...safeHistory.map(m => {
            if (m.role === 'tool') {
                return {
                    role: 'function',
                    parts: m.results.map(r => ({
                        functionResponse: { name: r.name, response: { result: r.result } }
                    }))
                };
            }
            if (m.role === 'assistant' && m.toolCalls) {
                return {
                    role: 'model',
                    parts: m.toolCalls.map(tc => ({ functionCall: { name: tc.name, args: tc.arguments } }))
                };
            }
            return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content || '' }] };
        }),
        { role: 'user', parts: [{ text: safePrompt }] }
    ];

    const response = await executeHttpRequest(
        { destinationName: 'GENERATIVE_AI_HUB' },
        {
            method:  'POST',
            url:     `/inference/deployments/${GENHUB_GEMINI_DEPLOYMENT}/models/gemini-2.5-pro:generateContent`,
            headers: { 'Content-Type': 'application/json', 'AI-Resource-Group': 'default' },
            data: {
                system_instruction: { parts: [{ text: systemInstruction }] },
                contents,
                tools: tools.length > 0 ? [{ functionDeclarations: tools }] : undefined,
                generationConfig: { maxOutputTokens: 8000, temperature: 0.5 }
            }
        },
        { fetchCsrfToken: false }
    );

    const parts         = response.data?.candidates?.[0]?.content?.parts || [];
    const text          = parts.find(p => p.text)?.text || '';
    const functionCalls = parts.filter(p => p.functionCall).map(p => ({
        id: p.functionCall.name, name: p.functionCall.name, arguments: p.functionCall.args
    }));

    return { content: text, toolCalls: functionCalls.length > 0 ? functionCalls : null };
}

async function callGeminiViaVertexAI(prompt, systemInstruction, history = []) {
    const { GoogleGenAI } = require('@google/genai');
    const { history: safeHistory, prompt: safePrompt } = trimContext(prompt, history);
    const dest = await getCachedDestination('geminivertex_api');
    const { project_id, client_email, private_key } = dest.originalProperties;

    const ai = new GoogleGenAI({
        vertexai: true,
        project:  project_id,
        location: 'us-central1',
        googleAuthOptions: {
            credentials: { client_email, private_key: private_key.replace(/\\n/g, '\n') }
        }
    });

    const contents = [
        ...safeHistory.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content || '' }] })),
        { role: 'user', parts: [{ text: safePrompt }] }
    ];

    const result = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents
    });

    return result.text ?? result.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

async function callGemini(sessionId, prompt, systemInstruction, history = []) {
    const start = Date.now();
    try {
        const content = await agenticToolLoop(sessionId, prompt, systemInstruction, history, callGeminiViaGenHub);
        return { modelId: 'gemini', content, latency: Date.now() - start };
    } catch (hubErr) {
        console.warn('callGemini: GenAI Hub failed, falling back to Vertex AI:', hubErr?.message);
        try {
            const content = await callGeminiViaVertexAI(prompt, systemInstruction, history);
            return { modelId: 'gemini', content, latency: Date.now() - start };
        } catch (fallbackErr) {
            console.error('callGemini: Vertex AI fallback also failed:', fallbackErr?.message);
            return { modelId: 'gemini', content: 'model is not available at the moment', latency: 0, error: true };
        }
    }
}

// ─── Claude ───────────────────────────────────────────────────────────────────
function sanitiseHistoryForClaude(history) {
    // Claude requires strictly alternating user/assistant turns.
    // Tool-result turns from the agentic loop are serialised as user messages
    // so the conversation stays valid when replayed through trimContext.
    return history.map(m => {
        if (m.role === 'tool') {
            // Flatten tool results into a user-turn text block
            const resultText = m.results
                .map(r => `[Tool: ${r.name}]\n${r.result}`)
                .join('\n\n');
            return { role: 'user', content: resultText };
        }
        if (m.role === 'assistant' && m.toolCalls) {
            // Represent the assistant's tool-call decision as plain text
            const callText = m.toolCalls
                .map(tc => `[Calling tool: ${tc.name} with args: ${JSON.stringify(tc.arguments)}]`)
                .join('\n');
            return { role: 'assistant', content: (m.content ? m.content + '\n' : '') + callText };
        }
        if (m.role === 'user' || m.role === 'assistant') {
            return { role: m.role, content: m.content || '' };
        }
        return null;
    }).filter(Boolean);
}

function applyCacheBreakpoint(history) {
    if (!history.length) return history;
    return history.map((m, idx) => {
        if (idx !== history.length - 1) return m;
        return {
            role: m.role,
            content: [{ type: 'text', text: m.content || '', cache_control: { type: 'ephemeral' } }]
        };
    });
}

// Converts MCP tools to Anthropic tool format
function mcpToolsToClaudeFormat(tools) {
    return tools.map(t => ({
        name: t.name,
        description: t.description || '',
        input_schema: t.parameters || { type: 'object', properties: {} }
    }));
}

// Inner provider fn used by agenticToolLoop for Claude via GenAI Hub
async function callClaudeViaGenHubInner(functionalSpec) {
    return async function(prompt, systemInstruction, history, tools) {
        const cleanHistory = sanitiseHistoryForClaude(history);
        const { history: safeHistory, prompt: safePrompt } = trimContext(prompt, cleanHistory);

        const systemText = functionalSpec
            ? `${systemInstruction}\n\nFunctional Specification Context:\n${functionalSpec}`
            : systemInstruction;
        const messages = [...applyCacheBreakpoint(safeHistory), { role: 'user', content: safePrompt }];

        const body = {
            anthropic_version: 'bedrock-2023-05-31',
            system: systemText,
            max_tokens: 5000,
            messages
        };
        if (tools.length > 0) {
            body.tools = mcpToolsToClaudeFormat(tools);
        }

        const response = await executeHttpRequest(
            { destinationName: 'GENERATIVE_AI_HUB' },
            {
                method:  'POST',
                url:     `/inference/deployments/${GENHUB_CLAUDE_DEPLOYMENT}/invoke`,
                headers: { 'Content-Type': 'application/json', 'AI-Resource-Group': 'default' },
                data:    body
            },
            { fetchCsrfToken: false }
        );

        const contentBlocks = response.data?.content || [];
        const text       = contentBlocks.filter(b => b.type === 'text').map(b => b.text).join('');
        const toolUses   = contentBlocks.filter(b => b.type === 'tool_use');
        const toolCalls  = toolUses.length > 0
            ? toolUses.map(b => ({ id: b.id, name: b.name, arguments: b.input }))
            : null;

        if (!text && !toolCalls) throw new Error('Empty response from Claude via GenAI Hub');
        return { content: text, toolCalls };
    };
}

// Inner provider fn used by agenticToolLoop for Claude via direct API key
async function callClaudeViaApiKeyInner(model, functionalSpec, apikey) {
    return async function(prompt, systemInstruction, history, tools) {
        const cleanHistory = sanitiseHistoryForClaude(history);
        const { history: safeHistory, prompt: safePrompt } = trimContext(
            prompt, cleanHistory, CLAUDE_MAX_INPUT_TOKENS
        );

        const messages     = [...applyCacheBreakpoint(safeHistory), { role: 'user', content: safePrompt }];
        const systemBlocks = require('../utils/helpers').buildClaudeSystemBlocks(functionalSpec);

        const body = { model, max_tokens: MAX_OUTPUT_TOKENS_CLAUDE, system: systemBlocks, messages };
        if (tools.length > 0) {
            body.tools = mcpToolsToClaudeFormat(tools);
        }

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method:  'POST',
            headers: {
                'x-api-key':         apikey,
                'anthropic-version': '2023-06-01',
                'anthropic-beta':    'prompt-caching-2024-07-31',
                'content-type':      'application/json'
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errBody = await response.text().catch(() => '');
            throw new Error(`Claude API returned ${response.status}: ${errBody.slice(0, 200)}`);
        }

        const data          = await response.json();
        const contentBlocks = data?.content || [];
        const text          = contentBlocks.filter(b => b.type === 'text').map(b => b.text).join('');
        const toolUses      = contentBlocks.filter(b => b.type === 'tool_use');
        const toolCalls     = toolUses.length > 0
            ? toolUses.map(b => ({ id: b.id, name: b.name, arguments: b.input }))
            : null;

        if (!text && !toolCalls) throw new Error('Empty response from Claude API');
        return { content: text, toolCalls };
    };
}

async function callClaude(sessionId, prompt, history = [], model = CLAUDE_MODEL_SIMPLE, functionalSpec = null) {
    const start = Date.now();
    try {
        const providerFn = await callClaudeViaGenHubInner(functionalSpec);
        const content    = await agenticToolLoop(sessionId, prompt, GLOBAL_SYSTEM_INSTRUCTION, history, providerFn);
        return { modelId: 'claude', content, latency: Date.now() - start, model: 'opus-genhub' };
    } catch (hubErr) {
        console.warn('callClaude: GenAI Hub failed, falling back to API key:', hubErr?.message);
        try {
            const dest    = await getCachedDestination('claude_api');
            const apikey  = dest.originalProperties?.apikey;
            if (!apikey) throw new Error('Claude API key destination is not configured correctly.');

            const providerFn = await callClaudeViaApiKeyInner(model, functionalSpec, apikey);
            const content    = await agenticToolLoop(sessionId, prompt, GLOBAL_SYSTEM_INSTRUCTION, history, providerFn);
            return { modelId: 'claude', content, latency: Date.now() - start, model };
        } catch (fallbackErr) {
            console.error('callClaude: fallback also failed:', fallbackErr?.message);
            return { modelId: 'claude', content: 'model is not available at the moment', latency: 0, error: true };
        }
    }
}

// ─── GPT-4o ───────────────────────────────────────────────────────────────────

// Converts MCP tools to OpenAI function-calling format
function mcpToolsToGPTFormat(tools) {
    return tools.map(t => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description || '',
            parameters: t.parameters || { type: 'object', properties: {} }
        }
    }));
}

// Serialises agentic history into the flat OpenAI messages array format.
// tool-call turns become an assistant message with tool_calls + individual
// tool messages for each result.
function buildGPTMessages(systemInstruction, history, prompt) {
    const messages = [{ role: 'system', content: systemInstruction }];

    for (const m of history) {
        if (m.role === 'assistant' && m.toolCalls) {
            messages.push({
                role: 'assistant',
                content: m.content || null,
                tool_calls: m.toolCalls.map(tc => ({
                    id:       tc.id,
                    type:     'function',
                    function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
                }))
            });
        } else if (m.role === 'tool') {
            for (const r of m.results) {
                messages.push({
                    role:         'tool',
                    tool_call_id: r.toolCallId,
                    content:      r.result
                });
            }
        } else if (m.role === 'user' || m.role === 'assistant') {
            messages.push({ role: m.role, content: m.content || '' });
        }
    }

    messages.push({ role: 'user', content: prompt });
    return messages;
}

// Inner provider fn used by agenticToolLoop for GPT-4o
function callGPT4oInner(systemInstruction) {
    return async function(prompt, _sysInstr, history, tools) {
        const { history: safeHistory, prompt: safePrompt } = trimContext(prompt, history, GPT_MAX_INPUT_TOKENS);
        const messages = buildGPTMessages(systemInstruction, safeHistory, safePrompt);

        const body = { model: 'gpt-5.2', temperature: 0.5, messages };
        if (tools.length > 0) {
            body.tools       = mcpToolsToGPTFormat(tools);
            body.tool_choice = 'auto';
        }

        const response = await executeHttpRequest(
            { destinationName: 'GENERATIVE_AI_HUB' },
            {
                method:  'POST',
                url: `/inference/deployments/${GENHUB_GPT_DEPLOYMENT}/chat/completions?api-version=2024-02-15-preview`,
                headers: { 'Content-Type': 'application/json', 'AI-Resource-Group': 'default' },
                data:    body
            },
            { fetchCsrfToken: false }
        );

        const choice     = response.data?.choices?.[0];
        const message    = choice?.message || {};
        const text       = message.content || '';
        const rawCalls   = message.tool_calls || [];
        const toolCalls  = rawCalls.length > 0
            ? rawCalls.map(tc => ({
                id:        tc.id,
                name:      tc.function.name,
                arguments: JSON.parse(tc.function.arguments || '{}')
            }))
            : null;

        if (!text && !toolCalls) throw new Error('Empty response from GPT-4o');
        return { content: text, toolCalls };
    };
}

async function callGPT4o(sessionId, prompt, systemInstruction, history = []) {
    const start = Date.now();
    try {
        const providerFn = callGPT4oInner(systemInstruction);
        const content    = await agenticToolLoop(sessionId, prompt, systemInstruction, history, providerFn);
        return { modelId: 'gpt4o', content, latency: Date.now() - start };
    } catch (err) {
        console.error('callGPT4o error:', err?.message);
        return { modelId: 'gpt4o', content: 'model is not available at the moment', latency: 0, error: true };
    }
}

// ─── Perplexity / SAP GenAI Hub (Sonar) ───────────────────────────────────────
async function callSAPGenAIHub(sessionId, prompt, systemInstruction, history = []) {
    const start = Date.now();
    try {
        const openai   = await cds.connect.to('perplexity');
        const messages = [
            { role: 'system', content: systemInstruction },
            ...history,
            { role: 'user', content: prompt }
        ];
        const response = await openai.send({
            query:   'POST /chat/completions?api-version=2024-02-15-preview',
            data:    { model: 'sonar', max_tokens: 2000, temperature: 0.5, messages },
            headers: { 'AI-Resource-Group': 'default', 'Content-Type': 'application/json' }
        });

        const content = response.choices?.[0]?.message?.content;
        if (!content) throw new Error('Empty response from Perplexity');
        return { modelId: 'perplexity', content, latency: Date.now() - start };
    } catch (err) {
        console.error('callSAPGenAIHub error:', err?.message);
        return { modelId: 'perplexity', content: 'model is not available at the moment', latency: 0, error: true };
    }
}

module.exports = { callGemini, callClaude, callGPT4o, callSAPGenAIHub, resolveClaudeModel };