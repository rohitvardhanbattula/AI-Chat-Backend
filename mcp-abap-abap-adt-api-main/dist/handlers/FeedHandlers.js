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
exports.FeedHandlers = void 0;
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const BaseHandler_js_1 = require("./BaseHandler.js");
class FeedHandlers extends BaseHandler_js_1.BaseHandler {
    getTools() {
        return [
            {
                name: 'feeds',
                description: 'Retrieves a list of feeds.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'dumps',
                description: 'Retrieves a list of dumps.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'An optional query string to filter the dumps.',
                            optional: true
                        }
                    }
                }
            }
        ];
    }
    handle(toolName, args) {
        return __awaiter(this, void 0, void 0, function* () {
            switch (toolName) {
                case 'feeds':
                    return this.handleFeeds(args);
                case 'dumps':
                    return this.handleDumps(args);
                default:
                    throw new types_js_1.McpError(types_js_1.ErrorCode.MethodNotFound, `Unknown feed tool: ${toolName}`);
            }
        });
    }
    handleFeeds(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const feeds = yield this.adtclient.feeds();
                this.trackRequest(startTime, true);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                feeds
                            })
                        }
                    ]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to get feeds: ${error.message || 'Unknown error'}`);
            }
        });
    }
    handleDumps(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const dumps = yield this.adtclient.dumps(args.query);
                this.trackRequest(startTime, true);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                dumps
                            })
                        }
                    ]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to get dumps: ${error.message || 'Unknown error'}`);
            }
        });
    }
}
exports.FeedHandlers = FeedHandlers;
