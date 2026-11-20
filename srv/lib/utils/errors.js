'use strict';

/**
 * An error whose message is safe to show to the end user.
 *
 * Anything that is NOT an AppError (DB errors, upstream LLM errors such as
 * "Claude API returned 500: {...}", stack-trace-bearing exceptions) must never
 * reach the browser verbatim — use toClientMessage() at the API boundary.
 */
class AppError extends Error {
    constructor(statusCode, message) {
        super(message);
        this.name       = 'AppError';
        this.statusCode = statusCode;
        this.expose     = true;
    }
}

const GENERIC_MESSAGE = 'Something went wrong while processing your request. Please try again.';

/** Message that is safe to return to the client for any thrown value. */
function toClientMessage(err, fallback = GENERIC_MESSAGE) {
    return err && err.expose && err.message ? err.message : fallback;
}

module.exports = { AppError, toClientMessage, GENERIC_MESSAGE };
