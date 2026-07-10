'use strict';
const { callGemini, callClaude, callGPT4o, callSAPGenAIHub, resolveClaudeModel } = require('../ai/llm-provider');
const { performValidation } = require('../abap/validation');
const { buildPromptWithContext, buildRetryPrompt, buildFinalReport, GLOBAL_SYSTEM_INSTRUCTION, GENERAL_SYSTEM_INSTRUCTION } = require('../utils/helpers');
const { MAX_RETRIES } = require('../utils/constants');
async function generateWithValidation(sessionId, modelId, prompt, history, category, functionalSpec) {
    const normalizedModelId = (modelId || '').toLowerCase();
    const isGeneral = (category || '').toString().toLowerCase() === 'general';
    const claudeModel = resolveClaudeModel(category);
    const nonClaudeSystemInstruction = isGeneral ? GENERAL_SYSTEM_INSTRUCTION : GLOBAL_SYSTEM_INSTRUCTION;
    let attempt = 0;
    let currentPrompt = normalizedModelId === 'claude' ? prompt : buildPromptWithContext(prompt, functionalSpec);
    let internalHistory = [...history];
    //console.log(`[generateWithValidation] sessionId: ${sessionId}, modelId: ${normalizedModelId}, attempt: ${attempt + 1}, prompt length: ${currentPrompt.length}, history length: ${internalHistory.length}`);
    const callModel = async (p, h) => {
        switch (normalizedModelId) {
            case 'gemini': {
                const res = await callGemini(sessionId, p, nonClaudeSystemInstruction, h);
                return res.error ? 'model is not available at the moment' : res.content;
            }
            case 'claude': {
                
                const res = await callClaude(sessionId, p, h, claudeModel, functionalSpec, category);
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
        const generatedText = await callModel(currentPrompt, internalHistory);
        return generatedText;
    }

    while (attempt < MAX_RETRIES) {
        //console.log("entry");
        const generatedText = await callModel(currentPrompt, internalHistory);
        if (generatedText === 'model is not available at the moment') return generatedText;

        const validation = performValidation(generatedText);

        if (!validation.hasAbap) {
            if (attempt < MAX_RETRIES - 1) {
                internalHistory.push({ role: 'user', content: currentPrompt });
                internalHistory.push({ role: 'assistant', content: generatedText });
                currentPrompt = 'You did not wrap your code in ```abap blocks. Your response must start with ```abap and end with ```. Please provide the ABAP code again, correctly wrapped.';
                attempt++;
                continue;
            }
            return buildFinalReport(generatedText, 'Failed to generate properly formatted ABAP code after maximum attempts.');
        }

        if (!validation.isInvalid) {
            return generatedText;
        }

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