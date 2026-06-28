'use strict';
const { getDestination } = require('@sap-cloud-sdk/connectivity');
const {
    MAX_INPUT_TOKENS, CHARS_PER_TOKEN, MAX_HISTORY_MESSAGES,
    CLAUDE_MODEL_COMPLEX, CLAUDE_MODEL_SIMPLE, GLOBAL_SYSTEM_INSTRUCTION,
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

    const promptTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN);
    let historyTokens  = trimmed.reduce((acc, m) => {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
        return acc + Math.ceil(content.length / CHARS_PER_TOKEN);
    }, 0);

    // Remove oldest messages until we fit within budget
    while (trimmed.length > 0 && (promptTokens + historyTokens) > maxTokens) {
        const removed        = trimmed.shift();
        const removedContent = typeof removed.content === 'string'
            ? removed.content
            : JSON.stringify(removed.content || '');
        historyTokens -= Math.ceil(removedContent.length / CHARS_PER_TOKEN);
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

function buildClaudeSystemBlocks(functionalSpec) {
    const blocks = [{ type: 'text', text: GLOBAL_SYSTEM_INSTRUCTION, cache_control: { type: 'ephemeral' } }];
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
    GLOBAL_SYSTEM_INSTRUCTION,
    GENHUB_GEMINI_DEPLOYMENT, GENHUB_CLAUDE_DEPLOYMENT,
    CLAUDE_MAX_INPUT_TOKENS, GPT_MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS_CLAUDE,
    CLAUDE_MODEL_SIMPLE, CLAUDE_MODEL_COMPLEX,GENHUB_GPT_DEPLOYMENT
};
