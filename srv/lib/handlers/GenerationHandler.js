'use strict';
const { callGemini, callClaude, callGPT4o, callSAPGenAIHub, resolveClaudeModel } = require('../ai/llm-provider');
const { performValidation } = require('../abap/validation');
const { buildPromptWithContext, buildRetryPrompt, buildFinalReport, GLOBAL_SYSTEM_INSTRUCTION, GENERAL_SYSTEM_INSTRUCTION } = require('../utils/helpers');
const { MAX_RETRIES, CLAUDE_MODEL_SIMPLE } = require('../utils/constants');

// A response that isn't even ABAP-shaped (no fence, no ABAP keywords — see
// validation.js's RE_ABAP_KEYWORDS_QUICK salvage) means the model ignored the
// system instruction outright. That rarely self-corrects with more blind
// retries, so it gets a tighter budget than the object-validation retry path
// (deprecated/classic-API fixes), which genuinely benefits from another pass.
const MAX_FORMAT_RETRIES = 1;

function logAttempt(sessionId, modelId, attempt, outcome, extra = {}) {
    console.log(`[GenerationHandler] attempt=${attempt + 1} modelId=${modelId} sessionId=${sessionId || 'none'} outcome=${outcome}` +
        (Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : ''));
}

async function generateWithValidation(sessionId, modelId, prompt, history, category, functionalSpec) {
    const normalizedModelId = (modelId || '').toLowerCase();
    const isGeneral = (category || '').toString().toLowerCase() === 'general';
    const claudeModel = resolveClaudeModel(category);
    const nonClaudeSystemInstruction = isGeneral ? GENERAL_SYSTEM_INSTRUCTION : GLOBAL_SYSTEM_INSTRUCTION;
    let attempt = 0;
    let formatRetries = 0;
    let currentPrompt = normalizedModelId === 'claude' ? prompt : buildPromptWithContext(prompt, functionalSpec);
    let internalHistory = [...history];
    //console.log(`[generateWithValidation] sessionId: ${sessionId}, modelId: ${normalizedModelId}, attempt: ${attempt + 1}, prompt length: ${currentPrompt.length}, history length: ${internalHistory.length}`);
    const callModel = async (p, h, useCheaperModel) => {
        switch (normalizedModelId) {
            case 'gemini': {
                const res = await callGemini(sessionId, p, nonClaudeSystemInstruction, h);
                return res.error ? 'model is not available at the moment' : res.content;
            }
            case 'claude': {
                // Retries are refinement passes (fix formatting / swap a
                // deprecated object), not fresh complex generation — the
                // cheaper model is usually enough and cuts retry cost.
                const modelForThisCall = useCheaperModel ? CLAUDE_MODEL_SIMPLE : claudeModel;
                const res = await callClaude(sessionId, p, h, modelForThisCall, functionalSpec, category);
                return res.error ? 'model is not available at the moment' : res.content;
            }
            case 'gpt4o': {
                const res = await callGPT4o(sessionId, p, nonClaudeSystemInstruction, h);
                return res.error ? 'model is not available at the moment' : res.content;
            }
            default: {
                const res = await callSAPGenAIHub(sessionId, p, nonClaudeSystemInstruction, h);
                return res.error ? 'model is not available at the moment' : res.content;
            }
        }
    };

    // 'general' category is a plain conversational/tool-use flow — skip ABAP validation & retry loop entirely.
    if (isGeneral) {
        const generatedText = await callModel(currentPrompt, internalHistory, false);
        return generatedText;
    }

    while (attempt < MAX_RETRIES) {
        //console.log("entry");
        const generatedText = await callModel(currentPrompt, internalHistory, attempt > 0);
        if (generatedText === 'model is not available at the moment') return generatedText;

        const validation = performValidation(generatedText);

        if (!validation.hasAbap) {
            logAttempt(sessionId, normalizedModelId, attempt, 'no-abap-detected', { formatRetries });
            if (formatRetries < MAX_FORMAT_RETRIES && attempt < MAX_RETRIES - 1) {
                internalHistory.push({ role: 'user', content: currentPrompt });
                internalHistory.push({ role: 'assistant', content: generatedText });
                currentPrompt = 'You did not wrap your code in ```abap blocks. Your response must start with ```abap and end with ```. Please provide the ABAP code again, correctly wrapped.';
                attempt++;
                formatRetries++;
                continue;
            }
            return buildFinalReport(generatedText, 'Failed to generate properly formatted ABAP code after maximum attempts.');
        }

        if (!validation.isInvalid) {
            logAttempt(sessionId, normalizedModelId, attempt, 'ok');
            return generatedText;
        }

        logAttempt(sessionId, normalizedModelId, attempt, 'invalid-objects', { invalidCount: validation.invalidObjects.length });
        if (attempt < MAX_RETRIES - 1) {
            internalHistory.push({ role: 'user', content: currentPrompt });
            internalHistory.push({ role: 'assistant', content: generatedText });
            currentPrompt = buildRetryPrompt(validation.internalFeedback, validation.invalidObjects, attempt + 1);
            attempt++;
            continue;
        }

        return buildFinalReport(generatedText, validation.internalFeedback.trim());
    }

    return 'model is not available at the moment';
}

module.exports = { generateWithValidation };