// test-bridge.js — manual smoke test for the MCP bridge
// Usage: node srv/test-bridge.js
const bridge = require('./lib/abap/adt-mcp-bridge');

const TEST_SESSION = 'test-session-001';

const credentials = {
    url:      process.env.SAP_URL      || 'https://your-sap-system.example.com',
    user:     process.env.SAP_USER     || 'DEVELOPER',
    password: process.env.SAP_PASSWORD || 'password',
    client:   process.env.SAP_CLIENT   || '100',
    language: process.env.SAP_LANGUAGE || 'EN'
};

bridge.connectWithCredentials(TEST_SESSION, credentials)
    .then(result => {
        console.log('Connected:', result);
        const tools = bridge.getToolsForLLM(TEST_SESSION);
        console.log('Tools:', JSON.stringify(tools, null, 2));
    })
    .catch(err => {
        console.error('Connection failed:', err.message);
    });
