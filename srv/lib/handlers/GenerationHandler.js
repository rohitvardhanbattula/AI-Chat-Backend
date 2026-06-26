'use strict';
const { callGemini, callClaude, callGPT4o, callSAPGenAIHub, resolveClaudeModel } = require('../ai/llm-provider');
const { performValidation } = require('../abap/validation');
const { buildPromptWithContext, buildRetryPrompt, buildFinalReport, GLOBAL_SYSTEM_INSTRUCTION, MAX_RETRIES } = require('../utils/helpers');

async function generateWithValidation(sessionId, modelId, prompt, history, category, functionalSpec) {
    const normalizedModelId = (modelId || '').toLowerCase();
    const claudeModel = resolveClaudeModel(category);
    let attempt = 0;
    let currentPrompt = normalizedModelId === 'claude' ? prompt : buildPromptWithContext(prompt, functionalSpec);
    let internalHistory = [...history];

    const callModel = async (p, h) => {
        switch (normalizedModelId) {
            case 'gemini': {
                const res = await callGemini(sessionId, p, GLOBAL_SYSTEM_INSTRUCTION, h);
                return res.error ? 'model is not available at the moment' : res.content;
            }
            case 'claude': {
                const res = await callClaude(sessionId, p, h, claudeModel, functionalSpec);
                return res.error ? 'model is not available at the moment' : res.content;
            }
            case 'gpt4o': {
                const res = await callGPT4o(sessionId, p, GLOBAL_SYSTEM_INSTRUCTION, h);
                return res.error ? 'model is not available at the moment' : res.content;
            }
            default: {
                const res = await callSAPGenAIHub(sessionId, p, GLOBAL_SYSTEM_INSTRUCTION, h);
                return res.error ? 'model is not available at the moment' : res.content;
            }
        }
    };

    while (attempt < MAX_RETRIES) {
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