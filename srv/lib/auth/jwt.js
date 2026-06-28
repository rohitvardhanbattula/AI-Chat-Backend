'use strict';
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getCachedDestination } = require('../utils/helpers');

const ACCESS_TOKEN_TTL  = 15 * 60;          // 15 minutes in seconds
const REFRESH_TOKEN_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

// ── Configuration error ───────────────────────────────────────────────────────
// Thrown when the server itself is mis-configured (e.g. missing secret).
// Distinguished from auth errors so middleware can return 500 instead of a
// misleading 401 — this is what made the original 401s so hard to diagnose.
class ConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConfigError';
        this.statusCode = 500;
    }
}

// ── Secret resolution ─────────────────────────────────────────────────────────
// IMPORTANT: JWT_SECRET is read from the environment ONLY, the same way in
// every environment (local dev, hybrid, production). Do NOT make this depend
// on an SAP destination, a profile, or NODE_ENV — that was the root cause of
// the inconsistent dev/prod behaviour and the hard-to-diagnose 401s.
//
// Local dev / hybrid : set JWT_SECRET in a `.env` file (see `.env.example`).
// Production (CF/BTP): set JWT_SECRET as an application environment variable,
//                      e.g. `cf set-env ai-chat-backend-srv JWT_SECRET "..."`
//                      (or via a deploy-time mtaext file — never commit it).
let _cachedSecret = null;

async function getJwtSecret() {
    if (_cachedSecret) return _cachedSecret;
    const dest = await getCachedDestination('AiChatDestination');
    const envSecret = dest.originalProperties?.destinationConfiguration?.jwt_secret;
    //const envSecret = process.env.JWT_SECRET;
    console.log('JWT_SECRET from destination:', envSecret ? '[REDACTED]' : '[MISSING]');
    if (!envSecret || envSecret.length < 32) {
        throw new ConfigError(
            'Server misconfiguration: JWT_SECRET environment variable is missing or ' +
            'shorter than 32 characters. Set it identically in every environment ' +
            '(local .env, hybrid, and production) — see .env.example.'
        );
    }

    _cachedSecret = envSecret;
    return _cachedSecret;
}

// ── Token generation ──────────────────────────────────────────────────────────
async function signAccessToken(payload) {
    const secret = await getJwtSecret();
    return jwt.sign(
        { sub: payload.userId, username: payload.username, type: 'access' },
        secret,
        { expiresIn: ACCESS_TOKEN_TTL, algorithm: 'HS256', issuer: 'ai-hub' }
    );
}

function generateRefreshTokenValue() {
    // Cryptographically random opaque token
    return uuidv4() + '-' + crypto.randomBytes(32).toString('hex');
}

function hashRefreshToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

// ── Token verification ────────────────────────────────────────────────────────
async function verifyAccessToken(token) {
    // Let ConfigError (missing/bad JWT_SECRET) propagate as-is so callers can
    // return 500 instead of a misleading 401 — this was previously masked.
    const secret = await getJwtSecret();
    try {
        const decoded = jwt.verify(token, secret, { algorithms: ['HS256'], issuer: 'ai-hub' });
        if (decoded.type !== 'access') throw new Error('Not an access token');
        return { userId: decoded.sub, username: decoded.username };
    } catch (err) {
        throw new Error(`Invalid or expired access token: ${err.message}`);
    }
}

// ── DB-backed refresh token management ───────────────────────────────────────
async function createRefreshToken(userId) {
    const tokenValue = generateRefreshTokenValue();
    const tokenHash  = hashRefreshToken(tokenValue);
    const expiresAt  = new Date(Date.now() + REFRESH_TOKEN_TTL * 1000).toISOString();

    await INSERT.into('sap.aigateway.RefreshTokens').entries({
        userId, tokenHash, expiresAt, revoked: false
    });

    return { tokenValue, expiresAt };
}

async function rotateRefreshToken(oldTokenValue) {
    const oldHash = hashRefreshToken(oldTokenValue);
    const record  = await SELECT.one
        .from('sap.aigateway.RefreshTokens')
        .where({ tokenHash: oldHash });

    if (!record)         throw new Error('Refresh token not found.');
    if (record.revoked)  throw new Error('Refresh token has been revoked.');
    if (new Date(record.expiresAt) < new Date()) throw new Error('Refresh token has expired.');

    // Revoke old token (rotation — one-time use)
    await UPDATE('sap.aigateway.RefreshTokens')
        .set({ revoked: true })
        .where({ tokenHash: oldHash });

    return { userId: record.userId };
}

async function revokeRefreshToken(tokenValue) {
    const tokenHash = hashRefreshToken(tokenValue);
    await UPDATE('sap.aigateway.RefreshTokens')
        .set({ revoked: true })
        .where({ tokenHash });
}

// Housekeeping — called periodically to purge expired tokens
async function purgeExpiredTokens() {
    const now = new Date().toISOString();
    await DELETE.from('sap.aigateway.RefreshTokens').where({ expiresAt: { '<': now } });
}

module.exports = {
    ConfigError,
    getJwtSecret,
    signAccessToken,
    verifyAccessToken,
    createRefreshToken,
    rotateRefreshToken,
    revokeRefreshToken,
    purgeExpiredTokens,
    hashRefreshToken,
    ACCESS_TOKEN_TTL,
    REFRESH_TOKEN_TTL
};
