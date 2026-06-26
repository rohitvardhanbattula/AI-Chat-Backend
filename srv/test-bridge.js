// test-bridge.js
const bridge = require('./lib/abap/adt-mcp-bridge');

bridge.connect().then(() => {
    console.log('Connected:', bridge.isConnected);
    console.log('Tools:', JSON.stringify(bridge.getToolsForLLM(), null, 2));
});