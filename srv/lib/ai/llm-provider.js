'use strict';
const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const mcpBridge = require('../abap/adt-mcp-bridge');
const { routeRelevantTools } = require('../../tool-router'); // Dynamic Tool Retrieval
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
// A tool result is considered a failure if it's JSON shaped like { error: ... }.
// This is the shape mcpBridge.executeTool() returns on any thrown error
// (including a 500 from the underlying SAP/ADT call).
function isToolErrorResult(resultText) {
    if (typeof resultText !== 'string') return false;
    try {
        const parsed = JSON.parse(resultText);
        return !!(parsed && typeof parsed === 'object' && 'error' in parsed);
    } catch {
        return false;
    }
}

function callSignature(call) {
    return `${call.name}::${JSON.stringify(call.arguments || {})}`;
}

async function agenticToolLoop(sessionId, prompt, systemInstruction, history, providerCallFn) {
    let currentHistory  = [...history];
    let toolLoopCount   = 0;
    const MAX_TOOL_LOOPS = 10;

    // Circuit breaker: how many times the *exact same* tool call (name + args)
    // is allowed to fail before we stop actually invoking it and instead tell
    // the model to stop retrying.
    const MAX_SAME_CALL_FAILURES = 2;
    const failureCounts = new Map(); // signature -> consecutive failure count

    // Accumulate every unique tool result across ALL loops for the final summary.
    // Key: tool name → {result, success}. Success overwrites failure so the
    // summary always shows the best outcome achieved for each tool.
    const allToolResults = new Map();

    // Hard ceiling on total tool executions per turn regardless of loop count,
    // to prevent runaway costs with large tool sets and many retries.
    const MAX_TOTAL_TOOL_CALLS = 20;
    let totalToolCalls = 0;

    // ── Dynamic Tool Retrieval ────────────────────────────────────────────────
    // Run the router ONCE before the while-loop begins. If the session has no
    // tools (no MCP connection) we skip routing entirely.
    // The router uses only the current prompt + last few history messages so it
    // stays fast; the main model still receives the full history below.
    let tools = [];
    if (sessionId) {
        const allTools = mcpBridge.getToolsForLLM(sessionId); // full catalog
        if (allTools.length > 0) {
            // If the catalog is small enough to fit comfortably, skip the router
            // overhead and inject directly (avoids an unnecessary LLM call).
            const ROUTER_THRESHOLD = 15;
            if (allTools.length <= ROUTER_THRESHOLD) {
                tools = allTools;
            } else {
                // Large catalog → route to a focused subset
                tools = await routeRelevantTools(prompt, sessionId, allTools, history);
                // Safety net: if the router returned nothing, fall back to a small
                // curated default set instead of dumping all 128 schemas into context.
                // These are the tools most likely to be useful for any SAP request.
                if (tools.length === 0) {
                    const DEFAULT_FALLBACK_TOOLS = new Set([
                        'healthcheck', 'searchObject', 'tableContents',
                        'runQuery', 'objectStructure', 'ddicElement'
                    ]);
                    tools = allTools.filter(t => DEFAULT_FALLBACK_TOOLS.has(t.name));
                    console.warn(`[agenticToolLoop] router returned 0 tools for session=${sessionId} — using ${tools.length} default fallback tools`);
                }
            }
        }
    }
    // tools is now the focused, hydrated subset for this turn.
    // It is captured here and reused across every iteration of the while-loop
    // so the router is never called more than once per user turn.

    while (toolLoopCount < MAX_TOOL_LOOPS) {
        const response = await providerCallFn(prompt, systemInstruction, currentHistory, tools);

        if (!response.toolCalls || response.toolCalls.length === 0) {
            return response.content;
        }

        const toolResults = [];
        for (const call of response.toolCalls) {
            const signature     = callSignature(call);
            const priorFailures = failureCounts.get(signature) || 0;

            // Hard stop: never exceed the total execution budget for this turn
            if (totalToolCalls >= MAX_TOTAL_TOOL_CALLS) {
                console.warn(`[agenticToolLoop] total tool call budget (${MAX_TOTAL_TOOL_CALLS}) exhausted — skipping remaining calls`);
                toolResults.push({
                    toolCallId: call.id,
                    name:       call.name,
                    result: JSON.stringify({
                        error: `Total tool execution budget exhausted. Tell the user what you have found so far and stop making tool calls.`,
                        retryable: false
                    })
                });
                continue;
            }

            if (priorFailures >= MAX_SAME_CALL_FAILURES) {
                // Circuit open: this exact call has already failed enough times.
                console.warn(`[agenticToolLoop] circuit open for ${signature} after ${priorFailures} failures — skipping call`);
                toolResults.push({
                    toolCallId: call.id,
                    name:       call.name,
                    result: JSON.stringify({
                        error: `Tool "${call.name}" has already failed ${priorFailures} times with these exact arguments and will not be called again. Do not retry it with the same arguments — try different arguments, a different tool, or tell the user the operation is currently unavailable.`,
                        retryable: false
                    })
                });
                continue;
            }

            totalToolCalls++;
            const resultText = await mcpBridge.executeTool(sessionId, call.name, call.arguments);

            if (isToolErrorResult(resultText)) {
                failureCounts.set(signature, priorFailures + 1);
            } else if (priorFailures > 0) {
                failureCounts.delete(signature); // succeeded — reset its failure streak
            }

            const isSuccess = !isToolErrorResult(resultText);
            // Always keep the best result for this tool — success beats failure
            const existing = allToolResults.get(call.name);
            if (!existing || (!existing.success && isSuccess)) {
                allToolResults.set(call.name, { result: resultText, success: isSuccess });
            }
            toolResults.push({ toolCallId: call.id, name: call.name, result: resultText });
        }

        currentHistory.push({ role: 'assistant', toolCalls: response.toolCalls, content: response.content || '' });
        currentHistory.push({ role: 'tool', results: toolResults });
        toolLoopCount++;
    }

    // Build a summary from ALL unique tool attempts across every loop,
    // not just the last one — so the user sees the full picture.
    let failureSummary = "The assistant reached the maximum number of tool operation steps without a final answer.\n\n**All Tool Results (unique tools attempted):**\n";

    if (allToolResults.size > 0) {
        for (const [toolName, { result, success }] of allToolResults) {
            let outputStr = result;
            try {
                const parsed = JSON.parse(result);
                if (parsed && parsed.error) outputStr = parsed.error;
            } catch (e) { /* not JSON, use raw */ }
            const icon = success ? '✓' : '✗';
            failureSummary += `- ${icon} **${toolName}**: ${outputStr}\n`;
        }
    } else {
        failureSummary += "- No tool results were recorded.";
    }

    // Return the formatted string rather than throwing
    return failureSummary;
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
            throw fallbackErr;
        }
    }
}

// ─── Claude ───────────────────────────────────────────────────────────────────
function sanitiseHistoryForClaude(history) {
    const messages = [];

    for (const m of history) {
        if (m.role === 'assistant' && m.toolCalls) {
            messages.push({
                role: 'assistant',
                content: m.toolCalls.map(tc => ({
                    type: 'tool_use',
                    id: tc.id,
                    name: tc.name,
                    input: tc.arguments
                }))
            });
        } else if (m.role === 'tool') {
            messages.push({
                role: 'user',
                content: m.results.map(r => ({
                    type: 'tool_result',
                    tool_use_id: r.toolCallId,
                    content: typeof r.result === 'string'
                        ? r.result
                        : JSON.stringify(r.result)
                }))
            });
        } else if (m.role === 'user' || m.role === 'assistant') {
            messages.push({
                role: m.role,
                content: m.content || ''
            });
        }
    }

    return messages;
}
function applyCacheBreakpoint(history) {
    if (!history.length) return history;

    return history.map((m, idx) => {
        if (idx !== history.length - 1) return m;

        // Already structured content (tool_use/tool_result)
        if (Array.isArray(m.content)) {
            return {
                ...m,
                content: m.content.map((block, i) => {
                    // Only cache text blocks
                    if (block.type === 'text') {
                        return {
                            ...block,
                            cache_control: i === m.content.length - 1
                                ? { type: 'ephemeral' }
                                : undefined
                        };
                    }
                    return block;
                })
            };
        }

        // Plain text message
        return {
            role: m.role,
            content: [
                {
                    type: 'text',
                    text: m.content || '',
                    cache_control: { type: 'ephemeral' }
                }
            ]
        };
    });
}

// Converts MCP tools to Anthropic tool format
function mcpToolsToClaudeFormat(tools) {
    const uniqueTools = [
        ...new Map(tools.map(tool => [tool.name, tool])).values()
    ];

    return uniqueTools.map(t => ({
        name: t.name,
        description: t.description || '',
        input_schema: t.parameters || { type: 'object', properties: {} }
    }));
}

// Inner provider fn used by agenticToolLoop for Claude via GenAI Hub.
// Unlike callClaudeViaApiKeyInner, this does NOT take a `model` argument —
// GENHUB_CLAUDE_DEPLOYMENT is a single fixed deployment in SAP AI Core, so
// there is no "simple vs complex" model to pick here (mirrors callGPT4oInner,
// which also always targets one fixed GENHUB_GPT_DEPLOYMENT).
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
async function callClaudeViaApiKeyInner(model, functionalSpec, apikey, category) {
    return async function(prompt, systemInstruction, history, tools) {
        const cleanHistory = sanitiseHistoryForClaude(history);
        const { history: safeHistory, prompt: safePrompt } = trimContext(
            prompt, cleanHistory, CLAUDE_MAX_INPUT_TOKENS
        );

        const messages     = [...applyCacheBreakpoint(safeHistory), { role: 'user', content: safePrompt }];
        const systemBlocks = require('../utils/helpers').buildClaudeSystemBlocks(functionalSpec, category);

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

async function callClaude(sessionId, prompt, history = [], model = CLAUDE_MODEL_SIMPLE, functionalSpec = null, category = null) {
    const start = Date.now();
    const isGeneral = (category || '').toString().toLowerCase() === 'general';
    const systemInstruction = isGeneral
        ? require('../utils/helpers').GENERAL_SYSTEM_INSTRUCTION
        : GLOBAL_SYSTEM_INSTRUCTION;

    // NOTE: GenHub always calls one fixed deployment (GENHUB_CLAUDE_DEPLOYMENT),
    // so `model` (simple vs complex) has no effect here — it only matters for
    // the direct API-key fallback below, where the model id is sent explicitly.
    try {
        const providerFn = await callClaudeViaGenHubInner(functionalSpec);
        const content    = await agenticToolLoop(sessionId, prompt, systemInstruction, history, providerFn);
        return { modelId: 'claude', content, latency: Date.now() - start, model: 'genhub-fixed-deployment' };
    } catch (hubErr) {
        console.warn('callClaude: GenAI Hub failed, falling back to API key:', hubErr?.message);
        try {
            const dest    = await getCachedDestination('claude_api');
            const apikey  = dest.originalProperties?.apikey;
            if (!apikey) throw new Error('Claude API key destination is not configured correctly.');

            const providerFn = await callClaudeViaApiKeyInner(model, functionalSpec, apikey, category);
            const content    = await agenticToolLoop(sessionId, prompt, systemInstruction, history, providerFn);
            return { modelId: 'claude', content, latency: Date.now() - start, model };
        } catch (fallbackErr) {
            console.error('callClaude: fallback also failed:', fallbackErr?.message);
            throw fallbackErr;
        }
    }
}

// ─── GPT-4o ───────────────────────────────────────────────────────────────────

function mcpToolsToGPTFormat(tools) {
    const uniqueTools = [
        ...new Map(tools.map(tool => [tool.name, tool])).values()
    ];

    return uniqueTools.map(t => ({
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
        throw err;
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
        throw err;
    }
}

module.exports = { callGemini, callClaude, callGPT4o, callSAPGenAIHub, resolveClaudeModel };