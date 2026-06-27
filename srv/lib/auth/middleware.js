'use strict';
const { verifyAccessToken } = require('./jwt');

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
        return res.status(401).json({ error: err.message || 'Unauthorized.' });
    }
}

module.exports = { requireAuth };
