'use strict';
const cds        = require('@sap/cds');
const cors       = require('cors');
const express    = require('express');
const multer     = require('multer');
const rateLimit  = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const { requireAuth }     = require('./lib/auth/middleware');
const { MAX_FILE_SIZE_BYTES } = require('./lib/utils/constants');
const { AppError, toClientMessage } = require('./lib/utils/errors');
const { parseChatRequest } = require('./lib/utils/validation');
const { resolveFileKind, unsupportedTypeError } = require('./lib/files/file-types');
const { extractDocument } = require('./lib/files/document-extractor');

const IS_PROD    = process.env.NODE_ENV === 'production';
const BODY_LIMIT = process.env.BODY_LIMIT || '5mb';   // a prompt (50k) + spec (200k) + history is well under 1 MB

// ── Multer ────────────────────────────────────────────────────────────────────
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
    fileFilter(_req, file, cb) {
        resolveFileKind(file.originalname, file.mimetype)
            ? cb(null, true)
            : cb(unsupportedTypeError(file.originalname));
    }
});

/**
 * multer reports its own failures (wrong type, too big, malformed form) through
 * next(err), which would otherwise fall through to the generic 500 handler.
 * Translate them into the 4xx the client can act on.
 */
function handleUpload(req, res, next) {
    upload.single('file')(req, res, err => {
        if (!err) return next();
        if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message });
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(413).json({ error: `File exceeds the ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB limit.` });
            }
            return res.status(400).json({ error: 'Invalid upload. Send a single file in the "file" field.' });
        }
        return next(err);
    });
}

// ── Rate limiters ─────────────────────────────────────────────────────────────
// Keyed by authenticated user (falling back to IP). Behind the approuter every
// request can arrive from the same proxy IP, so an IP-only key would make the
// whole organisation share one bucket.
function makeRateLimiter(max, windowMs = 60_000) {
    return rateLimit({
        windowMs, max,
        standardHeaders: true, legacyHeaders: false,
        keyGenerator: req => req.user?.userId || ipKeyGenerator(req.ip),
        handler(req, res) {
            console.warn(`[RateLimit] 429 path=${req.path} user=${req.user?.userId || 'anon'}`);
            res.status(429).json({ error: 'Too many requests. Please slow down.' });
        }
    });
}

const uploadLimiter = makeRateLimiter(10);
const streamLimiter = makeRateLimiter(30);

// ── SSE helpers ───────────────────────────────────────────────────────────────
const HEARTBEAT_MS = 15_000;

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
    if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Shared lifecycle for both streaming endpoints:
 * validate → open the stream → run the work → always close it, with
 * user-safe error text and no leaked timers if the browser disconnects.
 */
async function runStream(req, res, tag, { requireSession }, work) {
    let params;
    try {
        params = parseChatRequest(req.body, { requireSession });
    } catch (err) {
        return res.status(err.statusCode || 400).json({ error: toClientMessage(err) });
    }

    initSSE(req, res);
    sendSSE(res, { status: 'thinking' });

    const startedAt = Date.now();
    let clientGone = false;
    const heartbeat = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(': hb\n\n'); }, HEARTBEAT_MS);
    res.on('close', () => {
        clearInterval(heartbeat);
        if (!res.writableEnded) {
            clientGone = true;
            console.warn(`[${tag}] client disconnected before completion | user=${req.user?.userId} after=${Date.now() - startedAt}ms`);
        }
    });

    console.log(`[${tag}] start | user=${req.user?.userId} model=${params.modelId} category=${params.category || '-'} ` +
        `promptChars=${params.prompt.length} specChars=${params.extractedText?.length || 0}`);

    try {
        const srv = await cds.connect.to('AIService');
        await work(srv, params, chunk => { if (chunk) sendSSE(res, { status: 'chunk', content: chunk }); });
        sendSSE(res, { status: 'done' });
        console.log(`[${tag}] done | user=${req.user?.userId} ms=${Date.now() - startedAt} clientGone=${clientGone}`);
    } catch (err) {
        console.error(`[${tag}] failed | user=${req.user?.userId} model=${params.modelId} error="${err?.message}"`);
        sendSSE(res, { status: 'error', message: toClientMessage(err) });
    } finally {
        clearInterval(heartbeat);
        if (!res.writableEnded) res.end();
    }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
cds.on('bootstrap', app => {
    app.set('trust proxy', 1);

    // CORS: the UI is served through the approuter (same origin), so cross-origin
    // access is normally not needed. Set CORS_ORIGINS="https://a.example,https://b.example"
    // to lock this down; without it the previous open behaviour is kept.
    const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
    if (corsOrigins.length) {
        app.use(cors({ origin: corsOrigins }));
    } else {
        if (IS_PROD) console.warn('[Server] CORS_ORIGINS is not set — allowing all origins. Set it to restrict access.');
        app.use(cors());
    }

    app.use(express.json({ limit: BODY_LIMIT }));

    // Security headers
    app.use((_req, res, next) => {
        res.setHeader('X-Content-Type-Options',  'nosniff');
        res.setHeader('X-Frame-Options',          'DENY');
        res.setHeader('X-XSS-Protection',         '1; mode=block');
        res.setHeader('Referrer-Policy',          'strict-origin-when-cross-origin');
        res.setHeader('Permissions-Policy',       'geolocation=(), microphone=(), camera=()');
        if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        next();
    });

    // ── Document upload (JWT protected) ───────────────────────────────────────
    // Accepts PDF, DOCX, XLSX and CSV. Returns { text, piiList, piiOverflow, meta }.
    app.post('/odata/uploadDoc',
        requireAuth,
        uploadLimiter,
        handleUpload,
        async (req, res) => {
            if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
            console.log(`[uploadDoc] received | user=${req.user?.userId} file="${req.file.originalname}" ` +
                `mime=${req.file.mimetype} bytes=${req.file.size}`);
            try {
                res.json(await extractDocument(req.file));
            } catch (err) {
                if (err instanceof AppError) {
                    console.warn(`[uploadDoc] rejected | user=${req.user?.userId} status=${err.statusCode} reason="${err.message}"`);
                    return res.status(err.statusCode).json({ error: err.message });
                }
                console.error('[uploadDoc] unexpected failure:', err?.message);
                res.status(500).json({ error: 'Document extraction failed.' });
            }
        }
    );

    // ── Stream chat (JWT protected) ────────────────────────────────────────────
    app.post('/odata/streamChatMessage',
        requireAuth,
        streamLimiter,
        (req, res) => runStream(req, res, 'streamChatMessage', { requireSession: true },
            (srv, p, onChunk) => srv.generateStream(
                p.sessionId, p.modelId, p.prompt, p.category, p.extractedText, onChunk, req.user?.userId
            ))
    );

    // ── Stream comparison (JWT protected) ──────────────────────────────────────
    app.post('/odata/streamComparison',
        requireAuth,
        streamLimiter,
        (req, res) => runStream(req, res, 'streamComparison', { requireSession: false },
            (srv, p, onChunk) => srv.generateStreamNoSession(
                p.modelId, p.prompt, p.category, p.extractedText, onChunk, req.user?.userId, p.connectionId
            ))
    );

    // ── Health check ───────────────────────────────────────────────────────────
    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // ── Global error handler ───────────────────────────────────────────────────
    // eslint-disable-next-line no-unused-vars
    app.use((err, _req, res, _next) => {
        if (res.headersSent) return;
        if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
        if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body.' });
        if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message });
        console.error('[Server] Unhandled error:', err?.message);
        res.status(500).json({ error: 'An unexpected error occurred.' });
    });
});

module.exports = cds.server;
