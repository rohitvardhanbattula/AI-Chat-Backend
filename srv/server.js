const cds = require('@sap/cds');
const cors = require('cors');
const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

// Restrict file size to exactly 70 KB (70 * 1024 bytes)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 70 * 1024 } });

function extractPII(text) {
    const piiMap = new Map();
    
    const emails = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
    const phones = text.match(/\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g) || [];
    const ccs = text.match(/\b(?:\d[ -]*?){13,16}\b/g) || [];
    
    emails.forEach(e => piiMap.set(e, 'Email'));
    phones.forEach(p => piiMap.set(p, 'Phone'));
    ccs.forEach(c => piiMap.set(c, 'Card'));
    
    const piiList = [];
    piiMap.forEach((type, value) => piiList.push({ type, value }));
    
    return piiList;
}

cds.on('bootstrap', app => {
    app.use(cors({ origin: '*' }));
    app.use(express.json({ limit: '20mb' }));

    const setStreamTimeout = (req, res, next) => {
        if (typeof req.setTimeout === 'function') req.setTimeout(600000);
        if (typeof res.setTimeout === 'function') res.setTimeout(600000);
        next();
    };

    // NEW: Custom middleware to catch Multer errors before they crash Express
    const uploadMiddleware = (req, res, next) => {
        const singleUpload = upload.single('file');
        singleUpload(req, res, (err) => {
            if (err instanceof multer.MulterError) {
                if (err.code === 'LIMIT_FILE_SIZE') {
                    // Send a clean 400 response back to the client immediately
                    return res.status(400).json({ error: 'File exceeds the maximum limit of 70KB.' });
                }
                return res.status(400).json({ error: `Upload error: ${err.message}` });
            } else if (err) {
                return res.status(500).json({ error: `Unknown upload error: ${err.message}` });
            }
            next(); // Proceed to the route handler if no error
        });
    };

    // Use the uploadMiddleware instead of calling upload.single('file') directly
    app.post('/odata/uploadDoc', uploadMiddleware, async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

            let extractedText = '';

            if (req.file.mimetype === 'application/pdf') {
                const pdfData = await pdfParse(req.file.buffer);
                extractedText = pdfData.text;
            } else if (req.file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
                const docxData = await mammoth.extractRawText({ buffer: req.file.buffer });
                extractedText = docxData.value;
            } else {
                return res.status(400).json({ error: 'Unsupported file format. Only PDF and DOCX are supported.' });
            }
            
            extractedText = extractedText.replace(/[\x00-\x09\x0B-\x0C\x0E-\x1F\x7F]/g, '');
            
            const piiList = extractPII(extractedText);

            res.json({ text: extractedText, piiList });
        } catch (error) {
            console.error('uploadDoc error:', error?.message || error);
            res.status(500).json({ error: 'Document extraction failed', details: error.message });
        }
    });

    app.use('/odata/streamChatMessage', setStreamTimeout);
    app.use('/odata/streamComparison',  setStreamTimeout);

    app.post('/odata/streamChatMessage', async (req, res) => {
        res.setHeader('Content-Type',     'text/event-stream');
        res.setHeader('Cache-Control',    'no-cache, no-transform');
        res.setHeader('Connection',       'keep-alive');
        res.setHeader('X-Accel-Buffering','no');
        res.flushHeaders();

        const { sessionId, modelId, prompt, category } = req.body;
        res.write(`data: ${JSON.stringify({ status: 'thinking' })}\n\n`);

        const heartbeat = setInterval(() => res.write(`: heartbeat\n\n`), 15000);

        try {
            const srv = await cds.connect.to('AIService');
            await srv.generateStream(sessionId, modelId, prompt, category, (chunkText) => {
                if (chunkText) res.write(`data: ${JSON.stringify({ status: 'chunk', content: chunkText })}\n\n`);
            });
            clearInterval(heartbeat);
            res.write(`data: ${JSON.stringify({ status: 'done' })}\n\n`);
            res.end();
        } catch (err) {
            clearInterval(heartbeat);
            res.write(`data: ${JSON.stringify({ status: 'error', message: err.message })}\n\n`);
            res.end();
        }
    });

    app.post('/odata/streamComparison', async (req, res) => {
        res.setHeader('Content-Type',     'text/event-stream');
        res.setHeader('Cache-Control',    'no-cache, no-transform');
        res.setHeader('Connection',       'keep-alive');
        res.setHeader('X-Accel-Buffering','no');
        res.flushHeaders();

        const { modelId, prompt, category, extractedText } = req.body;
        res.write(`data: ${JSON.stringify({ status: 'thinking' })}\n\n`);

        const heartbeat = setInterval(() => res.write(`: heartbeat\n\n`), 15000);

        try {
            const srv = await cds.connect.to('AIService');
            await srv.generateStreamNoSession(modelId, prompt, category, extractedText, (chunkText) => {
                if (chunkText) res.write(`data: ${JSON.stringify({ status: 'chunk', content: chunkText })}\n\n`);
            });
            clearInterval(heartbeat);
            res.write(`data: ${JSON.stringify({ status: 'done' })}\n\n`);
            res.end();
        } catch (err) {
            clearInterval(heartbeat);
            res.write(`data: ${JSON.stringify({ status: 'error', message: err.message })}\n\n`);
            res.end();
        }
    });
});

module.exports = cds.server;