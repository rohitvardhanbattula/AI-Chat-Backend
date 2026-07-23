// [READ-ONLY MODE] This handler file is DISABLED.
// All tools in this file perform write/mutating operations against the SAP system.
// The file is kept for reference but is NOT loaded or instantiated (see index.js).

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
exports.ObjectLockHandlers = void 0;
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const BaseHandler_js_1 = require("./BaseHandler.js");
class ObjectLockHandlers extends BaseHandler_js_1.BaseHandler {
    getTools() {
        return [{
                name: 'lock',
                description: 'Lock an object',
                inputSchema: {
                    type: 'object',
                    properties: {
                        objectUrl: {
                            type: 'string',
                            description: 'URL of the object to lock'
                        },
                        accessMode: {
                            type: 'string',
                            description: 'Access mode for the lock',
                            optional: true
                        }
                    },
                    required: ['objectUrl']
                }
            }, {
                name: 'unLock',
                description: 'Unlock an object',
                inputSchema: {
                    type: 'object',
                    properties: {
                        objectUrl: {
                            type: 'string',
                            description: 'URL of the object to unlock'
                        },
                        lockHandle: {
                            type: 'string',
                            description: 'Lock handle obtained from previous lock operation'
                        }
                    },
                    required: ['objectUrl', 'lockHandle']
                }
            }];
    }
    handle(toolName, args) {
        return __awaiter(this, void 0, void 0, function* () {
            switch (toolName) {
                case 'lock':
                    return this.handleLock(args);
                case 'unLock':
                    return this.handleUnlock(args);
                default:
                    throw new types_js_1.McpError(types_js_1.ErrorCode.MethodNotFound, `Unknown object lock tool: ${toolName}`);
            }
        });
    }
    handleLock(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const lockResult = yield this.adtclient.lock(args.objectUrl, args.accessMode);
                this.trackRequest(startTime, true);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                lockHandle: lockResult.LOCK_HANDLE,
                                message: 'Object locked successfully'
                            })
                        }
                    ]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to lock object: ${error.message || 'Unknown error'}`);
            }
        });
    }
    handleUnlock(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                yield this.adtclient.unLock(args.objectUrl, args.lockHandle);
                this.trackRequest(startTime, true);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                message: 'Object unlocked successfully'
                            })
                        }
                    ]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to unlock object: ${error.message || 'Unknown error'}`);
            }
        });
    }
}
exports.ObjectLockHandlers = ObjectLockHandlers;
