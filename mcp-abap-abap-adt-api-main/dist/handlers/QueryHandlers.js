"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.QueryHandlers = void 0;
const BaseHandler_js_1 = require("./BaseHandler.js");
class QueryHandlers extends BaseHandler_js_1.BaseHandler {
    getTools() {
        return [
            {
                name: 'tableContents',
                description: 'Retrieves the contents of an ABAP table.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        ddicEntityName: {
                            type: 'string',
                            description: 'The name of the DDIC entity (table or view).'
                        },
                        rowNumber: {
                            type: 'number',
                            description: 'The maximum number of rows to retrieve.',
                            optional: true
                        },
                        decode: {
                            type: 'boolean',
                            description: 'Whether to decode the data.',
                            optional: true
                        },
                        sqlQuery: {
                            type: 'string',
                            description: 'An optional SQL query to filter the data.',
                            optional: true
                        }
                    },
                    required: ['ddicEntityName']
                }
            },
            {
                name: 'runQuery',
                description: 'Runs a SQL query on the target system.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        sqlQuery: {
                            type: 'string',
                            description: 'The SQL query to execute.'
                        },
                        rowNumber: {
                            type: 'number',
                            description: 'The maximum number of rows to retrieve.',
                            optional: true
                        },
                        decode: {
                            type: 'boolean',
                            description: 'Whether to decode the data.',
                            optional: true
                        }
                    },
                    required: ['sqlQuery']
                }
            }
        ];
    }
    handle(toolName, arguments_) {
        return __awaiter(this, void 0, void 0, function* () {
            switch (toolName) {
                case 'tableContents':
                    return this.handleTableContents(arguments_);
                case 'runQuery':
                    return this.handleRunQuery(arguments_);
                default:
                    throw new Error(`Tool ${toolName} not implemented in QueryHandlers`);
            }
        });
    }
    // tableContents and runQuery both POST to ADT datapreview endpoints, which
    // require a valid CSRF token bound to an active SAP session. When running
    // through the BTP Connectivity Proxy / Cloud Connector tunnel, the proxy
    // strips Set-Cookie response headers, so the ADTClient's internal cookie
    // jar is always empty and the session cookie is never replayed. SAP then
    // can't match the CSRF token to a session and returns 403.
    //
    // The fix: before each datapreview call, reset the CSRF token to "fetch",
    // which causes AdtHTTP._request to do a fresh GET (login) first. That GET
    // fetches a new CSRF token AND a new session cookie in the same round-trip,
    // and both are used immediately on the follow-up POST — no session
    // continuity across calls is needed. This matches how Claude Desktop works
    // (it has a persistent connection, so its cookies survive — we can't do
    // that through a proxy, so we re-establish per call instead).
    ensureFreshCsrf() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // Accessing the internal http object: ADTClient exposes its
                // AdtHTTP layer as `this.adtclient.http` (a protected property
                // but accessible from JS). Resetting csrfToken to "fetch"
                // triggers a fresh login/CSRF handshake on the next request.
                // ADTClient exposes its AdtHTTP layer as the private `h` property
                const http = this.adtclient.h;
                if (http && typeof http.csrfToken !== 'undefined') {
                    http.csrfToken = 'fetch';
                    process.stderr.write('[QueryHandlers] reset CSRF token to force fresh session handshake\n');
                }
            } catch (e) {
                // If the internal API isn't accessible, proceed anyway —
                // the call may still succeed if the existing token is valid.
                process.stderr.write('[QueryHandlers] could not reset CSRF token: ' + e.message + '\n');
            }
        });
    }
    handleTableContents(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                yield this.ensureFreshCsrf();
                const result = yield this.adtclient.tableContents(args.ddicEntityName, args.rowNumber, args.decode, args.sqlQuery);
                this.trackRequest(startTime, true);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                result
                            })
                        }
                    ]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                throw new Error(`Failed to retrieve table contents: ${error.message || 'Unknown error'}`);
            }
        });
    }
    handleRunQuery(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                yield this.ensureFreshCsrf();
                const result = yield this.adtclient.runQuery(args.sqlQuery, args.rowNumber, args.decode);
                this.trackRequest(startTime, true);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                result
                            })
                        }
                    ]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                throw new Error(`Failed to run query: ${error.message || 'Unknown error'}`);
            }
        });
    }
}
exports.QueryHandlers = QueryHandlers;