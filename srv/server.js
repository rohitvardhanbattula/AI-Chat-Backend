const cds = require('@sap/cds');
const cors = require('cors');

cds.on('bootstrap', app => {
    app.use(cors({ origin: '*' })); 
});

module.exports = cds.server;