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
exports.RenameHandlers = void 0;
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const BaseHandler_js_1 = require("./BaseHandler.js");
class RenameHandlers extends BaseHandler_js_1.BaseHandler {
    getTools() {
        return [
            {
                name: 'renameEvaluate',
                description: 'Evaluates a rename refactoring.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        uri: {
                            type: 'string',
                            description: 'The URI of the object to rename.'
                        },
                        line: {
                            type: 'number',
                            description: 'The line number.'
                        },
                        startColumn: {
                            type: 'number',
                            description: 'The starting column.'
                        },
                        endColumn: {
                            type: 'number',
                            description: 'The ending column.'
                        }
                    },
                    required: ['uri', 'line', 'startColumn', 'endColumn']
                }
            },
            {
                name: 'renamePreview',
                description: 'Previews a rename refactoring.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        renameRefactoring: {
                            type: 'object',
                            description: 'The rename refactoring proposal.'
                        },
                        transport: {
                            type: 'string',
                            description: 'The transport.',
                            optional: true
                        }
                    },
                    required: ['renameRefactoring']
                }
            },
            {
                name: 'renameExecute',
                description: 'Executes a rename refactoring.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        refactoring: {
                            type: 'object',
                            description: 'The rename refactoring.'
                        }
                    },
                    required: ['refactoring']
                }
            }
        ];
    }
    handle(toolName, args) {
        return __awaiter(this, void 0, void 0, function* () {
            switch (toolName) {
                case 'renameEvaluate':
                    return this.handleRenameEvaluate(args);
                case 'renamePreview':
                    return this.handleRenamePreview(args);
                case 'renameExecute':
                    return this.handleRenameExecute(args);
                default:
                    throw new types_js_1.McpError(types_js_1.ErrorCode.MethodNotFound, `Unknown rename tool: ${toolName}`);
            }
        });
    }
    handleRenameEvaluate(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const result = yield this.adtclient.renameEvaluate(args.uri, args.line, args.startColumn, args.endColumn);
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
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to evaluate rename: ${error.message || 'Unknown error'}`);
            }
        });
    }
    handleRenamePreview(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const result = yield this.adtclient.renamePreview(args.renameRefactoring, args.transport);
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
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to preview rename: ${error.message || 'Unknown error'}`);
            }
        });
    }
    handleRenameExecute(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const result = yield this.adtclient.renameExecute(args.refactoring);
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
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to execute rename: ${error.message || 'Unknown error'}`);
            }
        });
    }
}
exports.RenameHandlers = RenameHandlers;
