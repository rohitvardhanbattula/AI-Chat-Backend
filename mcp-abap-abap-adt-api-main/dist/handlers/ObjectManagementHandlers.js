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
exports.ObjectManagementHandlers = void 0;
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const BaseHandler_1 = require("./BaseHandler");
class ObjectManagementHandlers extends BaseHandler_1.BaseHandler {
    getTools() {
        return [
            {
                name: 'activateObjects',
                description: 'Activate ABAP objects using object references',
                inputSchema: {
                    type: 'object',
                    properties: {
                        objects: {
                            type: 'string',
                            description: 'JSON array of objects to activate. Each object must have adtcore:uri, adtcore:type, adtcore:name, and adtcore:parentUri properties'
                        },
                        preauditRequested: {
                            type: 'boolean',
                            description: 'Whether to perform pre-audit checks',
                            optional: true
                        }
                    },
                    required: ['objects']
                }
            },
            {
                name: 'activateByName',
                description: 'Activate an ABAP object using name and URL',
                inputSchema: {
                    type: 'object',
                    properties: {
                        objectName: {
                            type: 'string',
                            description: 'Name of the object'
                        },
                        objectUrl: {
                            type: 'string',
                            description: 'URL of the object'
                        },
                        mainInclude: {
                            type: 'string',
                            description: 'Main include context',
                            optional: true
                        },
                        preauditRequested: {
                            type: 'boolean',
                            description: 'Whether to perform pre-audit checks',
                            optional: true
                        }
                    },
                    required: ['objectName', 'objectUrl']
                }
            },
            {
                name: 'inactiveObjects',
                description: 'Get list of inactive objects',
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
                case 'activateObjects':
                    return this.handleActivateObjects(args);
                case 'activateByName':
                    return this.handleActivateByName(args);
                case 'inactiveObjects':
                    return this.handleInactiveObjects(args);
                default:
                    throw new types_js_1.McpError(types_js_1.ErrorCode.MethodNotFound, `Unknown object management tool: ${toolName}`);
            }
        });
    }
    handleActivateObjects(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                if (!args.objects || typeof args.objects !== 'string') {
                    throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, "objects parameter must be a JSON string");
                }
                let objects;
                try {
                    objects = JSON.parse(args.objects);
                    if (!Array.isArray(objects)) {
                        throw new Error("Parsed objects must be an array");
                    }
                    // Validate each object has required properties
                    objects.forEach((obj, index) => {
                        if (!obj["adtcore:uri"] || !obj["adtcore:type"] ||
                            !obj["adtcore:name"] || !obj["adtcore:parentUri"]) {
                            throw new Error(`Object at index ${index} is missing required properties`);
                        }
                    });
                }
                catch (parseError) {
                    throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, `Invalid objects JSON: ${parseError.message}`);
                }
                const result = yield this.adtclient.activate(objects, args.preauditRequested);
                this.trackRequest(startTime, true);
                return {
                    content: [{
                            type: 'text',
                            text: JSON.stringify(result)
                        }]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                if (error instanceof types_js_1.McpError) {
                    throw error;
                }
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to activate objects: ${error.message || 'Unknown error'}`);
            }
        });
    }
    handleActivateByName(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                if (!args.objectName || !args.objectUrl) {
                    throw new types_js_1.McpError(types_js_1.ErrorCode.InvalidParams, "objectName and objectUrl parameters are required");
                }
                const result = yield this.adtclient.activate(args.objectName, args.objectUrl, args.mainInclude, args.preauditRequested);
                this.trackRequest(startTime, true);
                return {
                    content: [{
                            type: 'text',
                            text: JSON.stringify(result)
                        }]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                if (error instanceof types_js_1.McpError) {
                    throw error;
                }
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to activate object: ${error.message || 'Unknown error'}`);
            }
        });
    }
    handleInactiveObjects(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const result = yield this.adtclient.inactiveObjects();
                this.trackRequest(startTime, true);
                return {
                    content: [{
                            type: 'text',
                            text: JSON.stringify(result)
                        }]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                if (error instanceof types_js_1.McpError) {
                    throw error;
                }
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to get inactive objects: ${error.message || 'Unknown error'}`);
            }
        });
    }
}
exports.ObjectManagementHandlers = ObjectManagementHandlers;
