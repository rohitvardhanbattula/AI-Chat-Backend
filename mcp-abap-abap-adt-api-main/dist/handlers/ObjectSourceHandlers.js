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
exports.ObjectSourceHandlers = void 0;
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const BaseHandler_1 = require("./BaseHandler");
class ObjectSourceHandlers extends BaseHandler_1.BaseHandler {
    getTools() {
        return [
            {
                name: 'getObjectSource',
                description: 'Retrieves source code for ABAP objects',
                inputSchema: {
                    type: 'object',
                    properties: {
                        objectSourceUrl: { type: 'string' },
                        options: { type: 'string' }
                    },
                    required: ['objectSourceUrl']
                }
            },
            {
                name: 'setObjectSource',
                description: 'Sets source code for ABAP objects',
                inputSchema: {
                    type: 'object',
                    properties: {
                        objectSourceUrl: { type: 'string' },
                        source: { type: 'string' },
                        lockHandle: { type: 'string' },
                        transport: { type: 'string' }
                    },
                    required: ['objectSourceUrl', 'source', 'lockHandle']
                }
            }
        ];
    }
    handle(toolName, args) {
        return __awaiter(this, void 0, void 0, function* () {
            switch (toolName) {
                case 'getObjectSource':
                    return this.handleGetObjectSource(args);
                case 'setObjectSource':
                    return this.handleSetObjectSource(args);
                default:
                    throw new types_js_1.McpError(types_js_1.ErrorCode.MethodNotFound, `Unknown object source tool: ${toolName}`);
            }
        });
    }
    handleGetObjectSource(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const source = yield this.adtclient.getObjectSource(args.objectSourceUrl, args.options);
                this.trackRequest(startTime, true);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                source
                            })
                        }
                    ]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to get object source: ${error.message || 'Unknown error'}`);
            }
        });
    }
    handleSetObjectSource(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                yield this.adtclient.setObjectSource(args.objectSourceUrl, args.source, args.lockHandle, args.transport);
                this.trackRequest(startTime, true);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                updated: true
                            })
                        }
                    ]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to set object source: ${error.message || 'Unknown error'}`);
            }
        });
    }
}
exports.ObjectSourceHandlers = ObjectSourceHandlers;
