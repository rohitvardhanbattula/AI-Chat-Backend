'use strict';

const cds    = require('@sap/cds');
const cors   = require('cors');
const express = require('express');
const multer  = require('multer');

// ─── Lazy-load heavy parsers only when a request actually arrives ────────────
// Importing pdf-parse at module load spins up worker threads unconditionally.
// Deferring the require() keeps cold-start time low and avoids wasted resources
// when the service pod handles no document uploads during its lifetime.
let pdfParse, mammoth;
function getPdfParse() { return (pdfParse ??= require('pdf-parse')); }
function getMammoth()  { return (mammoth  ??= require('mammoth'));   }

// ─── Multer: memory-storage with tight size cap ──────────────────────────────
// diskStorage would spill temp files to the container FS and risk leaving
// orphans on crash; memoryStorage is simpler but you must keep the cap low.
const upload = multer({
    storage: multer.memoryStorage(),
    limits:  { fileSize: 10 * 1024 * 1024 }   // 10 MB
});

// ─── Compiled regexes (module-level) ────────────────────────────────────────
// Re-creating RegExp objects on every maskPII() call is unnecessary GC churn.
const RE_EMAIL   = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const RE_PHONE   = /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
const RE_CC      = /\b(?:\d[ -]*?){13,16}\b/g;
const RE_CTRL    = /[\x00-\x09\x0B-\x0C\x0E-\x1F\x7F]/g;

// ─── CORS options (computed once) ────────────────────────────────────────────
// Passing `{ origin: '*' }` to cors() recreates the options object on every
// call in some versions; caching it is a micro-optimisation but keeps intent clear.
const CORS_OPTIONS = { origin: '*' };

function maskPII(text) {
    // Note: global regexes are stateful (lastIndex). Each replace() resets them,
    // but if maskPII were ever called concurrently on the same regex instance the
    // lastIndex could bleed. Calling .source + new RegExp would be the safe fix
    // in a worker-thread world; in Node's single event-loop this is fine as-is.
    return text
        .replace(RE_EMAIL, '[REDACTED_EMAIL]')
        .replace(RE_PHONE, '[REDACTED_PHONE]')
        .replace(RE_CC,    '[REDACTED_CC]');
}

// ─── Allowed MIME types (Set for O(1) lookup) ────────────────────────────────
const ALLOWED_MIME = new Set([
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

// ─── SSE helpers ─────────────────────────────────────────────────────────────
function setSSEHeaders(res) {
    res.setHeader('Content-Type',      'text/event-stream');
    res.setHeader('Cache-Control',     'no-cache, no-transform');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
}

function sseWrite(res, payload) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// ─── Timeout middleware factory ───────────────────────────────────────────────
// Extracted to a named factory so it can be reused without duplication and
// future changes only need to happen in one place.
function makeStreamTimeout(ms = 600_000) {
    return (req, res, next) => {
        if (typeof req.setTimeout === 'function') req.setTimeout(ms);
        if (typeof res.setTimeout === 'function') res.setTimeout(ms);
        next();
    };
}
const streamTimeout = makeStreamTimeout();

// ─── Heartbeat helper ────────────────────────────────────────────────────────
// Centralises the SSE comment-based keep-alive so it can't drift between the
// two streaming endpoints.
function startHeartbeat(res, intervalMs = 15_000) {
    return setInterval(() => res.write(': heartbeat\n\n'), intervalMs);
}

// ─── Generic SSE streaming handler factory ───────────────────────────────────
// The two streaming endpoints share identical SSE setup / teardown and only
// differ in which AIService method they call. Extracting the scaffold removes
// the duplicated try/catch/heartbeat pattern entirely.
function makeSseHandler(getServiceCall) {
    return async (req, res) => {
        setSSEHeaders(res);
        res.flushHeaders();

        sseWrite(res, { status: 'thinking' });
        const heartbeat = startHeartbeat(res);

        try {
            const srv = await cds.connect.to('AIService');
            await getServiceCall(srv, req.body, (chunkText) => {
                if (chunkText) sseWrite(res, { status: 'chunk', content: chunkText });
            });
            clearInterval(heartbeat);
            sseWrite(res, { status: 'done' });
        } catch (err) {
            clearInterval(heartbeat);
            sseWrite(res, { status: 'error', message: err.message });
        } finally {
            res.end();
        }
    };
}

// ─── CDS bootstrap ───────────────────────────────────────────────────────────
cds.on('bootstrap', app => {
    app.use(cors(CORS_OPTIONS));

    // Raised from the default 100 kb so large functional-spec payloads don't
    // cause a body-parse failure that surfaces as a generic 500.
    app.use(express.json({ limit: '20mb' }));

    // ── /odata/uploadDoc ─────────────────────────────────────────────────────
    app.post('/odata/uploadDoc', upload.single('file'), async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({ error: 'No file uploaded' });
            }
            if (!ALLOWED_MIME.has(req.file.mimetype)) {
                return res.status(400).json({
                    error: 'Unsupported file format. Only PDF and DOCX are supported.'
                });
            }

            // Run the extraction and the control-char strip+mask in a single pass
            // through the text rather than re-assigning `extractedText` multiple times.
            let rawText;
            if (req.file.mimetype === 'application/pdf') {
                const pdfData = await getPdfParse()(req.file.buffer);
                rawText = pdfData.text;
            } else {
                const docxData = await getMammoth().extractRawText({ buffer: req.file.buffer });
                rawText = docxData.value;
            }

            // Strip control chars first, then mask PII — order matters.
            const maskedText = maskPII(rawText.replace(RE_CTRL, ''));

            res.json({ text: maskedText });
        } catch (error) {
            console.error('uploadDoc error:', error?.message || error);
            res.status(500).json({
                error:   'Document extraction failed',
                details: error.message
            });
        }
    });

    // ── Streaming endpoints ──────────────────────────────────────────────────
    const streamChatHandler = makeSseHandler((srv, body, onChunk) => {
        const { sessionId, modelId, prompt, category } = body;
        return srv.generateStream(sessionId, modelId, prompt, category, onChunk);
    });

    const streamComparisonHandler = makeSseHandler((srv, body, onChunk) => {
        const { modelId, prompt, category, extractedText } = body;
        return srv.generateStreamNoSession(modelId, prompt, category, extractedText, onChunk);
    });

    app.use('/odata/streamChatMessage', streamTimeout);
    app.use('/odata/streamComparison',  streamTimeout);

    app.post('/odata/streamChatMessage', streamChatHandler);
    app.post('/odata/streamComparison',  streamComparisonHandler);
});

module.exports = cds.server;