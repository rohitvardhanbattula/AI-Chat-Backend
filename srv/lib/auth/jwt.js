'use strict';
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getCachedDestination } = require('../utils/helpers');

const ACCESS_TOKEN_TTL  = 15 * 60;          // 15 minutes in seconds
const REFRESH_TOKEN_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

// ── Secret resolution ─────────────────────────────────────────────────────────
let _cachedSecret = null;
let _secretFetchedAt = 0;
const SECRET_CACHE_TTL = 10 * 60 * 1000; // refresh secret cache every 10 min

async function getJwtSecret() {
    const now = Date.now();
    if (_cachedSecret && (now - _secretFetchedAt) < SECRET_CACHE_TTL) {
        return _cachedSecret;
    }

    try {
        const dest = await getCachedDestination('AiChatDestination');
        const secret = dest.originalProperties?.destinationConfiguration?.jwt_secret;
        if (!secret || secret.length < 32) {
            throw new Error('jwt_secret in destination is missing or too short (min 32 chars).');
        }
        _cachedSecret = secret;
        _secretFetchedAt = now;
        return secret;
    } catch (destErr) {
        // Fallback for local dev — env variable
        const envSecret = process.env.JWT_SECRET;
        if (envSecret && envSecret.length >= 32) {
            console.warn('[JWT] Destination unavailable, using JWT_SECRET env variable.');
            return envSecret;
        }
        throw new Error(
            'JWT secret not available. Configure a "jwt_secret_store" destination ' +
            'or set the JWT_SECRET environment variable (min 32 chars).'
        );
    }
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
    await DELETE.from('sap.aigateway.RefreshTokens').where(`expiresAt < '${now}'`);
}

module.exports = {
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
