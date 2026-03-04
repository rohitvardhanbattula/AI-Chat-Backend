const cds = require('@sap/cds');
const cors = require('cors');
const express = require('express');

cds.on('bootstrap', app => {
    app.use(cors({ origin: '*' })); 
    app.use(express.json());

    app.post('/odata/streamChatMessage', async (req, res) => {
        // 1. Establish SSE headers
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        const { sessionId, modelId, prompt } = req.body;
        
        // Send initial thinking state
        res.write(`data: ${JSON.stringify({ status: "thinking" })}\n\n`);

        try {
            const srv = await cds.connect.to('AIService');
            
            // 2. Call our new streaming function. Every time it yields a chunk, send it!
            await srv.generateStream(sessionId, modelId, prompt, (chunkText) => {
                res.write(`data: ${JSON.stringify({ status: "chunk", content: chunkText })}\n\n`);
            });

            // 3. Close the stream cleanly
            res.write(`data: ${JSON.stringify({ status: "done" })}\n\n`);
            res.end();
        } catch (err) {
            res.write(`data: ${JSON.stringify({ status: "error", message: err.message })}\n\n`);
            res.end();
        }
    });
});

module.exports = cds.server;