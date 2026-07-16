'use strict';
const { getDestination } = require('@sap-cloud-sdk/connectivity');
const {
    MAX_INPUT_TOKENS, CHARS_PER_TOKEN, MAX_HISTORY_MESSAGES,
    CLAUDE_MODEL_COMPLEX, CLAUDE_MODEL_SIMPLE, GLOBAL_SYSTEM_INSTRUCTION, GENERAL_SYSTEM_INSTRUCTION,
    GENHUB_GEMINI_DEPLOYMENT, GENHUB_CLAUDE_DEPLOYMENT,
    CLAUDE_MAX_INPUT_TOKENS, GPT_MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS_CLAUDE,GENHUB_GPT_DEPLOYMENT
} = require('./constants');

// ─── Destination cache ────────────────────────────────────────────────────────
const DEST_CACHE     = new Map();
const DEST_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getCachedDestination(name) {
    const now    = Date.now();
    const cached = DEST_CACHE.get(name);
    if (cached && cached.expiresAt > now) return cached.dest;

    const dest = await getDestination({ destinationName: name });
    DEST_CACHE.set(name, { dest, expiresAt: now + DEST_CACHE_TTL });
    return dest;
}

// ─── Context trimming ─────────────────────────────────────────────────────────
/**
 * Trim conversation history + prompt to stay within token budget.
 * Removes oldest messages first (always keeps user's current prompt).
 */
function trimContext(prompt, history, maxTokens = MAX_INPUT_TOKENS) {
    let trimmed = history.slice(-MAX_HISTORY_MESSAGES);

    // Correctly estimate token cost for ALL message shapes:
    //   - Plain text messages:               { role, content: string }
    //   - Agentic assistant turns:           { role: 'assistant', toolCalls: [...], content: '' }
    //   - Agentic tool result turns:         { role: 'tool', results: [...] }
    //   - Claude-sanitised tool_use turns:   { role: 'assistant', content: [{type:'tool_use',...}] }
    //   - Claude-sanitised tool_result turns:{ role: 'user',      content: [{type:'tool_result',...}] }
    function messageTokens(m) {
        if (typeof m.content === 'string') {
            // Also account for toolCalls on assistant turns
            const tcCost = m.toolCalls ? JSON.stringify(m.toolCalls).length : 0;
            return Math.ceil((m.content.length + tcCost) / CHARS_PER_TOKEN);
        }
        if (Array.isArray(m.content)) {
            // Claude structured content blocks
            return Math.ceil(JSON.stringify(m.content).length / CHARS_PER_TOKEN);
        }
        if (m.results) {
            // Tool result turns { role: 'tool', results: [...] }
            return Math.ceil(JSON.stringify(m.results).length / CHARS_PER_TOKEN);
        }
        return 0;
    }

    const promptTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN);
    let historyTokens  = trimmed.reduce((acc, m) => acc + messageTokens(m), 0);

    // Remove oldest messages until we fit within budget.
    // IMPORTANT: always remove in pairs when an assistant tool-call turn is
    // followed by its tool-result turn — orphaning either side causes provider errors.
    while (trimmed.length > 0 && (promptTokens + historyTokens) > maxTokens) {
        // Find the oldest tool-call pair or plain message to drop
        const firstIsToolCall = trimmed[0]?.toolCalls || (Array.isArray(trimmed[0]?.content) && trimmed[0]?.content?.some(b => b.type === 'tool_use'));
        const secondIsToolResult = trimmed[1]?.role === 'tool' || (Array.isArray(trimmed[1]?.content) && trimmed[1]?.content?.some(b => b.type === 'tool_result'));

        if (firstIsToolCall && secondIsToolResult && trimmed.length >= 2) {
            // Drop the pair together to keep history consistent
            historyTokens -= messageTokens(trimmed[0]) + messageTokens(trimmed[1]);
            trimmed.splice(0, 2);
        } else {
            historyTokens -= messageTokens(trimmed[0]);
            trimmed.shift();
        }
    }

    let finalPrompt = prompt;
    if (promptTokens > maxTokens) {
        const maxChars = maxTokens * CHARS_PER_TOKEN;
        finalPrompt    = prompt.slice(0, maxChars) + '\n\n[PROMPT TRUNCATED — PLEASE BREAK INTO SMALLER PARTS]';
        console.warn(`trimContext: prompt truncated to ${maxChars} chars`);
    }

    return { history: trimmed, prompt: finalPrompt };
}

// ─── Spec truncation ──────────────────────────────────────────────────────────
function truncateSpec(spec, reserve = 1000) {
    const limit = (MAX_INPUT_TOKENS * CHARS_PER_TOKEN) - reserve;
    return spec.length > limit
        ? spec.slice(0, limit) + '\n\n[DOCUMENT TRUNCATED DUE TO LENGTH]'
        : spec;
}

// ─── Prompt building ──────────────────────────────────────────────────────────
function buildPromptWithContext(prompt, functionalSpec) {
    if (!functionalSpec) return prompt;
    return `${prompt}\n\nFunctional Specification Context:\n${truncateSpec(functionalSpec, prompt.length + 1000)}`;
}

function buildClaudeSystemBlocks(functionalSpec, category) {
    const isGeneral = (category || '').toString().toLowerCase() === 'general';
    const systemText = isGeneral ? GENERAL_SYSTEM_INSTRUCTION : GLOBAL_SYSTEM_INSTRUCTION;
    const blocks = [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }];
    if (functionalSpec) {
        blocks.push({
            type:          'text',
            text:          `Functional Specification Context:\n${truncateSpec(functionalSpec, 2000)}`,
            cache_control: { type: 'ephemeral' }
        });
    }
    return blocks;
}

// ─── Model resolution ─────────────────────────────────────────────────────────
function resolveClaudeModel(category) {
    return (category || '').toString().toLowerCase().includes('complex')
        ? CLAUDE_MODEL_COMPLEX
        : CLAUDE_MODEL_SIMPLE;
}

// ─── Retry prompt construction ────────────────────────────────────────────────
function buildRetryPrompt(feedback, invalidObjects, attempt) {
    const toReplace      = invalidObjects.filter(obj => obj.successor);
    const classicOrNTBR  = invalidObjects.filter(obj => !obj.successor && (obj.reason === 'classic_api' || obj.reason === 'not_to_be_released'));

    const replacementLines = toReplace.map(
        obj => `- Replace '${obj.name}' with its official SAP Cloud Tier 1 successor: '${obj.successor}'`
    );
    const classicLines = classicOrNTBR.map(
        obj => `- '${obj.name}' is ${obj.reason === 'not_to_be_released' ? 'Not To Be Released' : 'a Classic API (Tier 2 only)'}. Replace with an officially released Tier 1 SAP Cloud object.`
    );

    return [
        `Your previously generated code failed SAP Cloud validation (attempt ${attempt}).`,
        'CRITICAL: Do NOT delete the business logic or functionality to avoid errors. Replace every invalid object with its proper ABAP Cloud Tier 1 equivalent.',
        'Return ONLY the corrected ABAP code wrapped in ```abap blocks. Nothing else.',
        '',
        '### Errors to Fix',
        feedback,
        replacementLines.length ? '\n### Required Replacements (Deprecated → Successor)\n' + replacementLines.join('\n') : '',
        classicLines.length     ? '\n### Classic API / Not To Be Released — Must Use Tier 1 Alternatives\n' + classicLines.join('\n') : ''
    ].filter(Boolean).join('\n');
}

function buildFinalReport(generatedText, feedback) {
    return [
        generatedText,
        '',
        '---',
        '### ⚠️ Validation Report (All Retry Attempts Exhausted)',
        '',
        feedback
    ].join('\n');
}

module.exports = {
    getCachedDestination, trimContext, truncateSpec, buildPromptWithContext,
    buildClaudeSystemBlocks, resolveClaudeModel, buildRetryPrompt, buildFinalReport,
    GLOBAL_SYSTEM_INSTRUCTION, GENERAL_SYSTEM_INSTRUCTION,
    GENHUB_GEMINI_DEPLOYMENT, GENHUB_CLAUDE_DEPLOYMENT,
    CLAUDE_MAX_INPUT_TOKENS, GPT_MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS_CLAUDE,
    CLAUDE_MODEL_SIMPLE, CLAUDE_MODEL_COMPLEX,GENHUB_GPT_DEPLOYMENT
};