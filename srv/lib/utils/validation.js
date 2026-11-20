'use strict';
const { AppError } = require('./errors');
const {
    MAX_PROMPT_CHARS, MAX_SPEC_CHARS, ALLOWED_MODEL_IDS, ALLOWED_CATEGORIES
} = require('./constants');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = v => typeof v === 'string' && UUID_RE.test(v);

/**
 * Validate the JSON body of the two streaming endpoints and return cleaned values.
 * Throws AppError(400) with a user-safe message on any problem.
 *
 * @param {object}  body
 * @param {boolean} requireSession  true for /streamChatMessage, false for /streamComparison
 */
function parseChatRequest(body, { requireSession }) {
    const b = body && typeof body === 'object' ? body : {};

    if (requireSession && !isUuid(b.sessionId)) throw new AppError(400, 'A valid sessionId is required.');

    if (typeof b.modelId !== 'string' || !ALLOWED_MODEL_IDS.includes(b.modelId.toLowerCase())) {
        throw new AppError(400, 'Unsupported or missing modelId.');
    }

    if (typeof b.prompt !== 'string' || !b.prompt.trim()) throw new AppError(400, 'prompt is required.');
    if (b.prompt.length > MAX_PROMPT_CHARS) {
        throw new AppError(400, `prompt is too long (max ${MAX_PROMPT_CHARS.toLocaleString('en-US')} characters).`);
    }

    if (b.category != null && !ALLOWED_CATEGORIES.includes(b.category)) throw new AppError(400, 'Unsupported category.');

    if (b.extractedText != null && typeof b.extractedText !== 'string') throw new AppError(400, 'extractedText must be text.');
    if (b.connectionId != null && (typeof b.connectionId !== 'string' || b.connectionId.length > 100)) {
        throw new AppError(400, 'Invalid connectionId.');
    }

    return {
        sessionId:     requireSession ? b.sessionId : null,
        modelId:       b.modelId.toLowerCase(),
        prompt:        b.prompt,
        category:      b.category ?? undefined,
        extractedText: b.extractedText ? b.extractedText.slice(0, MAX_SPEC_CHARS) : null,
        connectionId:  b.connectionId || null
    };
}

module.exports = { isUuid, parseChatRequest };
