'use strict';
const cds        = require('@sap/cds');
const cors       = require('cors');
const express    = require('express');
const multer     = require('multer');
const pdfParse   = require('pdf-parse');
const mammoth    = require('mammoth');
const rateLimit  = require('express-rate-limit');
const { requireAuth }     = require('./lib/auth/middleware');
const { MAX_FILE_SIZE_BYTES, ALLOWED_MIME_TYPES } = require('./lib/utils/constants');

// ── PII extraction ────────────────────────────────────────────────────────────
function extractPII(text) {
    const piiMap = new Map();
    const emails = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
    const phones = text.match(/\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g) || [];
    const ccs    = text.match(/\b(?:\d[ -]?){13,16}\b/g) || [];
    emails.forEach(e => piiMap.set(e, 'Email'));
    phones.forEach(p => piiMap.set(p, 'Phone'));
    ccs.forEach(c => piiMap.set(c, 'Card'));
    return Array.from(piiMap, ([value, type]) => ({ type, value }));
}

// ── Multer ────────────────────────────────────────────────────────────────────
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
    fileFilter(_req, file, cb) {
        ALLOWED_MIME_TYPES.has(file.mimetype)
            ? cb(null, true)
            : cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Only PDF and DOCX files are allowed.'));
    }
});

// ── Rate limiters ─────────────────────────────────────────────────────────────
function makeRateLimiter(max, windowMs = 60_000) {
    return rateLimit({
        windowMs, max,
        standardHeaders: true, legacyHeaders: false,
        handler(_req, res) {
            res.status(429).json({ error: 'Too many requests. Please slow down.' });
        }
    });
}

const uploadLimiter = makeRateLimiter(10);
const streamLimiter = makeRateLimiter(30);
const authLimiter   = makeRateLimiter(10, 15 * 60_000);

// ── SSE helpers ───────────────────────────────────────────────────────────────
function initSSE(req, res) {
    res.setHeader('Content-Type',      'text/event-stream');
    res.setHeader('Cache-Control',     'no-cache, no-transform');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof req.setTimeout === 'function') req.setTimeout(600_000);
    if (typeof res.setTimeout === 'function') res.setTimeout(600_000);
    res.flushHeaders();
}

function sendSSE(res, payload) {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
cds.on('bootstrap', app => {

    app.use(cors());

    app.use(express.json({ limit: '5mb' }));

    // ── DEV ONLY: inject a fake CDS user so dummy auth stops blocking OData ──
    // In production NODE_ENV=production is set via mta.yaml so this is skipped
    if (process.env.NODE_ENV !== 'production') {
        app.use('/odata', (req, _res, next) => {
            req.user = { id: 'dev-user', roles: [], tenant: 'default' };
            next();
        });
    }

    // Security headers
    app.use((_req, res, next) => {
        res.setHeader('X-Content-Type-Options',  'nosniff');
        res.setHeader('X-Frame-Options',          'DENY');
        res.setHeader('X-XSS-Protection',         '1; mode=block');
        res.setHeader('Referrer-Policy',          'strict-origin-when-cross-origin');
        res.setHeader('Permissions-Policy',       'geolocation=(), microphone=(), camera=()');
        next();
    });

    // ── Document upload (JWT protected) ───────────────────────────────────────
    app.post('/odata/uploadDoc',
        uploadLimiter,
        requireAuth,
        upload.single('file'),
        async (req, res) => {
            try {
                if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

                let extractedText = '';
                if (req.file.mimetype === 'application/pdf') {
                    const pdfData  = await pdfParse(req.file.buffer);
                    extractedText  = pdfData.text;
                } else {
                    const docxData = await mammoth.extractRawText({ buffer: req.file.buffer });
                    extractedText  = docxData.value;
                }

                extractedText = extractedText
                    .replace(/\n{3,}/g, '\n\n')
                    .replace(/[ \t]+/g, ' ')
                    .trim();

                res.json({ text: extractedText, piiList: extractPII(extractedText) });

            } catch (err) {
                if (err instanceof multer.MulterError) {
                    return res.status(400).json({ error: err.message });
                }
                console.error('[uploadDoc]', err?.message);
                res.status(500).json({ error: 'Document extraction failed.' });
            }
        }
    );

    // ── Stream chat (JWT protected) ────────────────────────────────────────────
    app.post('/odata/streamChatMessage',
        streamLimiter,
        requireAuth,
        async (req, res) => {
            initSSE(req, res);
            const { sessionId, modelId, prompt, category, extractedText } = req.body;

            if (!sessionId || !modelId || !prompt) {
                sendSSE(res, { status: 'error', message: 'sessionId, modelId and prompt are required.' });
                return res.end();
            }

            sendSSE(res, { status: 'thinking' });
            const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': hb\n\n'); }, 15_000);

            try {
                const srv = await cds.connect.to('AIService');
                await srv.generateStream(sessionId, modelId, prompt, category, extractedText, chunk => {
                    if (chunk) sendSSE(res, { status: 'chunk', content: chunk });
                });
                clearInterval(heartbeat);
                sendSSE(res, { status: 'done' });
            } catch (err) {
                clearInterval(heartbeat);
                console.error('[streamChatMessage]', err?.message);
                sendSSE(res, { status: 'error', message: err.message || 'Internal server error.' });
            } finally {
                if (!res.writableEnded) res.end();
            }
        }
    );

    // ── Stream comparison (JWT protected) ──────────────────────────────────────
    app.post('/odata/streamComparison',
        streamLimiter,
        requireAuth,
        async (req, res) => {
            initSSE(req, res);
            const { modelId, prompt, category, extractedText } = req.body;

            if (!modelId || !prompt) {
                sendSSE(res, { status: 'error', message: 'modelId and prompt are required.' });
                return res.end();
            }

            sendSSE(res, { status: 'thinking' });
            const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': hb\n\n'); }, 15_000);

            try {
                const srv = await cds.connect.to('AIService');
                await srv.generateStreamNoSession(modelId, prompt, category, extractedText, chunk => {
                    if (chunk) sendSSE(res, { status: 'chunk', content: chunk });
                });
                clearInterval(heartbeat);
                sendSSE(res, { status: 'done' });
            } catch (err) {
                clearInterval(heartbeat);
                console.error('[streamComparison]', err?.message);
                sendSSE(res, { status: 'error', message: err.message || 'Internal server error.' });
            } finally {
                if (!res.writableEnded) res.end();
            }
        }
    );

    // ── Health check ───────────────────────────────────────────────────────────
    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // ── Global error handler ───────────────────────────────────────────────────
    // eslint-disable-next-line no-unused-vars
    app.use((err, _req, res, _next) => {
        console.error('[Server] Unhandled error:', err?.message);
        if (!res.headersSent) {
            res.status(500).json({ error: 'An unexpected error occurred.' });
        }
    });
});

module.exports = cds.server;