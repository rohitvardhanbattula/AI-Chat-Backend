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
exports.ObjectRegistrationHandlers = void 0;
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const BaseHandler_1 = require("./BaseHandler");
class ObjectRegistrationHandlers extends BaseHandler_1.BaseHandler {
    getTools() {
        return [
            {
                name: 'objectRegistrationInfo',
                description: 'Get registration information for an ABAP object',
                inputSchema: {
                    type: 'object',
                    properties: {
                        objectUrl: { type: 'string' }
                    },
                    required: ['objectUrl']
                }
            },
            {
                name: 'validateNewObject',
                description: 'Validate parameters for a new ABAP object',
                inputSchema: {
                    type: 'object',
                    properties: {
                        options: { type: 'string' }
                    },
                    required: ['options']
                }
            },
            {
                name: 'createObject',
                description: 'Create a new ABAP object',
                inputSchema: {
                    type: 'object',
                    properties: {
                        objtype: { type: 'string' },
                        name: { type: 'string' },
                        parentName: { type: 'string' },
                        description: { type: 'string' },
                        parentPath: { type: 'string' },
                        responsible: { type: 'string', optional: true },
                        transport: { type: 'string', optional: true }
                    },
                    required: ['objtype', 'name', 'parentName', 'description', 'parentPath']
                }
            }
        ];
    }
    handle(toolName, args) {
        return __awaiter(this, void 0, void 0, function* () {
            switch (toolName) {
                case 'objectRegistrationInfo':
                    return this.handleObjectRegistrationInfo(args);
                case 'validateNewObject':
                    return this.handleValidateNewObject(args);
                case 'createObject':
                    return this.handleCreateObject(args);
                default:
                    throw new types_js_1.McpError(types_js_1.ErrorCode.MethodNotFound, `Unknown object registration tool: ${toolName}`);
            }
        });
    }
    handleObjectRegistrationInfo(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const info = yield this.adtclient.objectRegistrationInfo(args.objectUrl);
                this.trackRequest(startTime, true);
                return {
                    content: [{
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                info
                            })
                        }]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to get registration info: ${error.message || 'Unknown error'}`);
            }
        });
    }
    handleValidateNewObject(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const result = yield this.adtclient.validateNewObject(args.options);
                this.trackRequest(startTime, true);
                return {
                    content: [{
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                result
                            })
                        }]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to validate new object: ${error.message || 'Unknown error'}`);
            }
        });
    }
    handleCreateObject(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const result = yield this.adtclient.createObject(args.objtype, args.name, args.parentName, args.description, args.parentPath, args.responsible, args.transport);
                this.trackRequest(startTime, true);
                return {
                    content: [{
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                result
                            })
                        }]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to create object: ${error.message || 'Unknown error'}`);
            }
        });
    }
}
exports.ObjectRegistrationHandlers = ObjectRegistrationHandlers;
