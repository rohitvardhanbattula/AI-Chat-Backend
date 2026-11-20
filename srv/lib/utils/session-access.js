'use strict';

const SESSIONS = 'sap.aigateway.ChatSessions';

/**
 * Columns that are safe to send to the browser. `functionalspec` can hold up to
 * ~200 KB of extracted document text per session, so it is never included in
 * list/create responses — it is only read server-side when building a prompt.
 */
const SESSION_PUBLIC_COLUMNS = ['ID', 'userId', 'title', 'selectedModel', 'createdAt', 'createdBy', 'modifiedAt', 'modifiedBy'];

/**
 * True only if `sessionId` exists AND belongs to `userId`.
 * Every session-scoped action must call this: session IDs arrive from the
 * client, and without an ownership check any logged-in user could read, rename,
 * delete or post into someone else's chat by guessing/leaking an ID.
 */
async function isSessionOwner(sessionId, userId) {
    if (!sessionId || !userId) return false;
    const row = await SELECT.one.from(SESSIONS).columns('ID').where({ ID: sessionId, userId });
    return !!row;
}

module.exports = { isSessionOwner, SESSION_PUBLIC_COLUMNS, SESSIONS };
