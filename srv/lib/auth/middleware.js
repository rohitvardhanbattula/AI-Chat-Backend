'use strict';
const { verifyAccessToken, ConfigError } = require('./jwt');

async function requireAuth(req, res, next) {
    const authHeader = req.headers['authorization'] || '';
    const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
        return res.status(401).json({ error: 'Missing Authorization header.' });
    }

    try {
        const payload = await verifyAccessToken(token);
        req.user = payload; // { userId, username }
        next();
    } catch (err) {
        if (err instanceof ConfigError) {
            console.error('[Auth] Server misconfiguration:', err.message);
            return res.status(500).json({ error: 'Server authentication is misconfigured. Contact an administrator.' });
        }
        return res.status(401).json({ error: err.message || 'Unauthorized.' });
    }
}

module.exports = { requireAuth };
