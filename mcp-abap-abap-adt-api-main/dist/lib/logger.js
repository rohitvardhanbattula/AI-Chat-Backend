"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLogger = createLogger;
function createLogger(name) {
    return {
        error: (message, meta) => log('error', name, message, meta),
        warn: (message, meta) => log('warn', name, message, meta),
        info: (message, meta) => log('info', name, message, meta),
        debug: (message, meta) => log('debug', name, message, meta)
    };
}
function log(level, name, message, meta) {
    const timestamp = new Date().toISOString();
    const logEntry = Object.assign({ timestamp,
        level, service: name, message }, meta);
    const logString = JSON.stringify(logEntry, null, 2);
    switch (level) {
        case 'error':
            console.error(logString);
            break;
        case 'warn':
            console.warn(logString);
            break;
        case 'info':
            console.info(logString);
            break;
        case 'debug':
            console.debug(logString);
            break;
    }
}
