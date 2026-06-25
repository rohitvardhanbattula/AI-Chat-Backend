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
exports.ObjectHandlers = void 0;
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const BaseHandler_js_1 = require("./BaseHandler.js");
class ObjectHandlers extends BaseHandler_js_1.BaseHandler {
    getTools() {
        return [
            {
                name: 'objectStructure',
                description: 'Get object structure details',
                inputSchema: {
                    type: 'object',
                    properties: {
                        objectUrl: {
                            type: 'string',
                            description: 'URL of the object'
                        },
                        version: {
                            type: 'string',
                            description: 'Version of the object',
                            optional: true
                        }
                    },
                    required: ['objectUrl']
                }
            },
            {
                name: 'searchObject',
                description: 'Search for objects',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'Search query string'
                        },
                        objType: {
                            type: 'string',
                            description: 'Object type filter',
                            optional: true
                        },
                        max: {
                            type: 'number',
                            description: 'Maximum number of results',
                            optional: true
                        }
                    },
                    required: ['query']
                }
            },
            {
                name: 'findObjectPath',
                description: 'Find path for an object',
                inputSchema: {
                    type: 'object',
                    properties: {
                        objectUrl: {
                            type: 'string',
                            description: 'URL of the object to find path for'
                        }
                    },
                    required: ['objectUrl']
                }
            },
            {
                name: 'objectTypes',
                description: 'Retrieves object types.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'reentranceTicket',
                description: 'Retrieves a reentrance ticket.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            }
        ];
    }
    handle(toolName, args) {
        return __awaiter(this, void 0, void 0, function* () {
            switch (toolName) {
                case 'objectStructure':
                    return this.handleObjectStructure(args);
                case 'findObjectPath':
                    return this.handleFindObjectPath(args);
                case 'searchObject':
                    return this.handleSearchObject(args);
                case 'objectTypes':
                    return this.handleObjectTypes(args);
                case 'reentranceTicket':
                    return this.handleReentranceTicket(args);
                default:
                    throw new types_js_1.McpError(types_js_1.ErrorCode.MethodNotFound, `Unknown object tool: ${toolName}`);
            }
        });
    }
    handleObjectStructure(args) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const startTime = performance.now();
            try {
                const structure = yield this.adtclient.objectStructure(args.objectUrl, args.version);
                this.trackRequest(startTime, true);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                structure,
                                message: 'Object structure retrieved successfully'
                            }, null, 2)
                        }
                    ]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                const errorMessage = error.message || 'Unknown error';
                const detailedError = ((_b = (_a = error.response) === null || _a === void 0 ? void 0 : _a.data) === null || _b === void 0 ? void 0 : _b.message) || errorMessage;
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to get object structure: ${detailedError}`);
            }
        });
    }
    handleFindObjectPath(args) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const startTime = performance.now();
            try {
                const path = yield this.adtclient.findObjectPath(args.objectUrl);
                this.trackRequest(startTime, true);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                path,
                                message: 'Object path found successfully'
                            }, null, 2)
                        }
                    ]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                const errorMessage = error.message || 'Unknown error';
                const detailedError = ((_b = (_a = error.response) === null || _a === void 0 ? void 0 : _a.data) === null || _b === void 0 ? void 0 : _b.message) || errorMessage;
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to find object path: ${detailedError}`);
            }
        });
    }
    handleSearchObject(args) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const startTime = performance.now();
            try {
                const results = yield this.adtclient.searchObject(args.query, args.objType, args.max);
                this.trackRequest(startTime, true);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                results,
                                message: 'Object search completed successfully'
                            }, null, 2)
                        }
                    ]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                const errorMessage = error.message || 'Unknown error';
                const detailedError = ((_b = (_a = error.response) === null || _a === void 0 ? void 0 : _a.data) === null || _b === void 0 ? void 0 : _b.message) || errorMessage;
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to search objects: ${detailedError}`);
            }
        });
    }
    handleObjectTypes(args) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const startTime = performance.now();
            try {
                const types = yield this.adtclient.objectTypes();
                this.trackRequest(startTime, true);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                types,
                                message: 'Object types retrieved successfully'
                            }, null, 2)
                        }
                    ]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                const errorMessage = error.message || 'Unknown error';
                const detailedError = ((_b = (_a = error.response) === null || _a === void 0 ? void 0 : _a.data) === null || _b === void 0 ? void 0 : _b.message) || errorMessage;
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to get object types: ${detailedError}`);
            }
        });
    }
    handleReentranceTicket(args) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const startTime = performance.now();
            try {
                const ticket = yield this.adtclient.reentranceTicket();
                this.trackRequest(startTime, true);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                ticket,
                                message: 'Reentrance ticket retrieved successfully'
                            }, null, 2)
                        }
                    ]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                const errorMessage = error.message || 'Unknown error';
                const detailedError = ((_b = (_a = error.response) === null || _a === void 0 ? void 0 : _a.data) === null || _b === void 0 ? void 0 : _b.message) || errorMessage;
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to get reentrance ticket: ${detailedError}`);
            }
        });
    }
}
exports.ObjectHandlers = ObjectHandlers;
