const cds = require('@sap/cds');
const cors = require('cors');
const express = require('express');

cds.on('bootstrap', app => {
    app.use(cors({ origin: '*' })); 
    app.use(express.json());

    app.post('/odata/streamChatMessage', async (req, res) => {
        
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        const { sessionId, modelId, prompt } = req.body;
        
       
        res.write(`data: ${JSON.stringify({ status: "thinking" })}\n\n`);

        try {
            const srv = await cds.connect.to('AIService');
            
            
            await srv.generateStream(sessionId, modelId, prompt, (chunkText) => {
                res.write(`data: ${JSON.stringify({ status: "chunk", content: chunkText })}\n\n`);
            });

            
            res.write(`data: ${JSON.stringify({ status: "done" })}\n\n`);
            res.end();
        } catch (err) {
            res.write(`data: ${JSON.stringify({ status: "error", message: err.message })}\n\n`);
            res.end();
        }
    });
});

module.exports = cds.server;