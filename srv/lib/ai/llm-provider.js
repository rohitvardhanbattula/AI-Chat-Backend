'use strict';
const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const mcpBridge = require('../abap/adt-mcp-bridge');
const { 
    getCachedDestination, trimContext, GLOBAL_SYSTEM_INSTRUCTION, resolveClaudeModel,
    GENHUB_GEMINI_DEPLOYMENT, GENHUB_CLAUDE_DEPLOYMENT, CLAUDE_MAX_INPUT_TOKENS, GPT_MAX_INPUT_TOKENS,
    MAX_OUTPUT_TOKENS_CLAUDE
} = require('../utils/helpers');

// --- Updated agenticToolLoop to accept sessionId ---
async function agenticToolLoop(sessionId, prompt, systemInstruction, history, providerCallFn) {
    let currentHistory = [...history];
    let toolExecutionCount = 0;
    const MAX_TOOL_LOOPS = 5; 

    // Retrieve tools specifically configured for this user's active session
    const tools = mcpBridge.getToolsForLLM(sessionId);

    while (toolExecutionCount < MAX_TOOL_LOOPS) {
        const response = await providerCallFn(prompt, systemInstruction, currentHistory, tools);
        
        if (!response.toolCalls || response.toolCalls.length === 0) {
            return response.content;
        }

        const toolResults = [];
        for (const call of response.toolCalls) {
            // Execute against this session's isolated MCP process
            const resultText = await mcpBridge.executeTool(sessionId, call.name, call.arguments);
            toolResults.push({ toolCallId: call.id, name: call.name, result: resultText });
        }

        currentHistory.push({ role: 'assistant', toolCalls: response.toolCalls, content: response.content || '' });
        currentHistory.push({ role: 'tool', results: toolResults });
        
        toolExecutionCount++;
    }
    return "The model requested too many operations. Please refine your query.";
}

// ─── Gemini ───────────────────────────────────────────────────────────────────
async function callGeminiViaGenHub(prompt, systemInstruction, history = [], tools = []) {
    const { history: safeHistory, prompt: safePrompt } = trimContext(prompt, history);
    
    const contents = [
        ...safeHistory.map(m => {
            if (m.role === 'tool') {
                return { role: 'function', parts: m.results.map(r => ({ functionResponse: { name: r.name, response: { result: r.result } } })) };
            }
            if (m.role === 'assistant' && m.toolCalls) {
                return { role: 'model', parts: m.toolCalls.map(tc => ({ functionCall: { name: tc.name, args: tc.arguments } })) };
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

    const parts = response.data?.candidates?.[0]?.content?.parts || [];
    const text = parts.find(p => p.text)?.text || '';
    const functionCalls = parts.filter(p => p.functionCall).map(p => ({
        id: p.functionCall.name,
        name: p.functionCall.name,
        arguments: p.functionCall.args
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
        ...safeHistory.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        { role: 'user', parts: [{ text: safePrompt }] }
    ];

    const result = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents
    });

    return result.text ?? result.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

// --- Updated export functions to accept sessionId ---
async function callGemini(sessionId, prompt, systemInstruction, history = []) {
    const start = Date.now();
    try {
        console.log(`callGemini: trying GenAI Hub (with tools) for session ${sessionId}...`);
        const content = await agenticToolLoop(sessionId, prompt, systemInstruction, history, callGeminiViaGenHub);
        return { modelId: 'gemini', content, latency: Date.now() - start };
    } catch (hubErr) {
        console.warn('callGemini: GenAI Hub failed, falling back to Vertex AI:', hubErr?.message || hubErr);
        try {
            const content = await callGeminiViaVertexAI(prompt, systemInstruction, history);
            return { modelId: 'gemini', content, latency: Date.now() - start };
        } catch (fallbackErr) {
            console.error('callGemini: Vertex AI fallback also failed:', fallbackErr?.message || fallbackErr);
            return { modelId: 'gemini', content: 'model is not available at the moment', latency: 0, error: true };
        }
    }
}

// ─── Claude ───────────────────────────────────────────────────────────────────
function sanitiseHistoryForClaude(history) {
    return history.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ role: m.role, content: m.content }));
}
function applyCacheBreakpoint(history) {
    if (!history.length) return history;
    return history.map((m, idx) => {
        if (idx !== history.length - 1) return m;
        return { role: m.role, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] };
    });
}

async function callClaudeViaGenHub(prompt, history = [], functionalSpec = null) {
    const { history: safeHistory, prompt: safePrompt } = trimContext(prompt, sanitiseHistoryForClaude(history));
    const systemText = functionalSpec ? `${GLOBAL_SYSTEM_INSTRUCTION}\n\nFunctional Specification Context:\n${functionalSpec}` : GLOBAL_SYSTEM_INSTRUCTION;
    const messages = [...applyCacheBreakpoint(safeHistory), { role: 'user', content: safePrompt }];

    const response = await executeHttpRequest(
        { destinationName: 'GENERATIVE_AI_HUB' },
        {
            method:  'POST',
            url:     `/inference/deployments/${GENHUB_CLAUDE_DEPLOYMENT}/invoke`,
            headers: { 'Content-Type': 'application/json', 'AI-Resource-Group': 'default' },
            data: { anthropic_version: 'bedrock-2023-05-31', system: systemText, max_tokens: 5000, messages }
        },
        { fetchCsrfToken: false }
    );
    return response.data.content[0].text;
}

async function callClaudeViaApiKey(prompt, history = [], model = CLAUDE_MODEL_SIMPLE, functionalSpec = null) {
    const { history: safeHistory, prompt: safePrompt } = trimContext(prompt, sanitiseHistoryForClaude(history), CLAUDE_MAX_INPUT_TOKENS);
    const dest = await getCachedDestination('claude_api');
    const apikey = dest.originalProperties.apikey;
    const messages = [...applyCacheBreakpoint(safeHistory), { role: 'user', content: safePrompt }];
    const systemBlocks = require('../utils/helpers').buildClaudeSystemBlocks(functionalSpec);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method:  'POST',
        headers: {
            'x-api-key':         apikey,
            'anthropic-version': '2023-06-01',
            'anthropic-beta':    'prompt-caching-2024-07-31',
            'content-type':      'application/json'
        },
        body: JSON.stringify({ model, max_tokens: MAX_OUTPUT_TOKENS_CLAUDE, system: systemBlocks, messages })
    });

    if (!response.ok) throw new Error(`Claude API key request failed: ${response.status}`);
    const data = await response.json();
    return data?.content?.[0]?.text;
}

async function callClaude(sessionId, prompt, history = [], model = CLAUDE_MODEL_SIMPLE, functionalSpec = null) {
    // Note: Claude tool calling via MCP is not fully implemented in this wrapper yet. 
    // It currently falls back to standard text generation.
    const start = Date.now();
    try {
        console.log('callClaude: trying GenAI Hub (Opus)...');
        const content = await callClaudeViaGenHub(prompt, history, functionalSpec);
        return { modelId: 'claude', content, latency: Date.now() - start, model: 'opus-genhub' };
    } catch (hubErr) {
        console.warn('callClaude: GenAI Hub failed, falling back to API key:', hubErr?.message || hubErr);
        try {
            const content = await callClaudeViaApiKey(prompt, history, model, functionalSpec);
            return { modelId: 'claude', content, latency: Date.now() - start, model };
        } catch (fallbackErr) {
            console.error('callClaude: fallback failed:', fallbackErr?.message || fallbackErr);
            return { modelId: 'claude', content: 'model is not available at the moment', latency: 0, error: true };
        }
    }
}

// ─── GPT-4o ───────────────────────────────────────────────────────────────────
async function callGPT4o(sessionId, prompt, systemInstruction, history = []) {
    const start = Date.now();
    try {
        const { history: safeHistory, prompt: safePrompt } = trimContext(prompt, history, GPT_MAX_INPUT_TOKENS);
        const messages = [{ role: 'system', content: systemInstruction }, ...safeHistory, { role: 'user', content: safePrompt }];

        const response = await executeHttpRequest(
            { destinationName: 'GENERATIVE_AI_HUB' },
            {
                method:  'POST',
                url:     '/inference/deployments/d905723f4f0b8b08/chat/completions?api-version=2024-02-15-preview',
                headers: { 'Content-Type': 'application/json', 'AI-Resource-Group': 'default' },
                data: { model: 'gpt-5.2', temperature: 0.5, messages }
            },
            { fetchCsrfToken: false }
        );

        const content = response.data?.choices?.[0]?.message?.content;
        return { modelId: 'gpt4o', content, latency: Date.now() - start };
    } catch (err) {
        console.error('callGPT4o error:', err?.message || err);
        return { modelId: 'gpt4o', content: 'model is not available at the moment', latency: 0, error: true };
    }
}

// ─── Perplexity / SAP GenAI Hub (Sonar) ──────────────────────────────────────
async function callSAPGenAIHub(sessionId, prompt, systemInstruction, history = []) {
    const start = Date.now();
    try {
        const openai   = await cds.connect.to('perplexity');
        const messages = [{ role: 'system', content: systemInstruction }, ...history, { role: 'user', content: prompt }];
        const response = await openai.send({
            query:   'POST /chat/completions?api-version=2024-02-15-preview',
            data:    { model: 'sonar', max_tokens: 2000, temperature: 0.5, messages },
            headers: { 'AI-Resource-Group': 'default', 'Content-Type': 'application/json' }
        });
        return { modelId: 'perplexity', content: response.choices[0].message.content, latency: Date.now() - start };
    } catch (err) {
        console.error('callSAPGenAIHub error:', err?.message || err);
        return { modelId: 'perplexity', content: 'model is not available at the moment', latency: 0, error: true };
    }
}

module.exports = { callGemini, callClaude, callGPT4o, callSAPGenAIHub, resolveClaudeModel };