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
exports.PrettyPrinterHandlers = void 0;
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const BaseHandler_js_1 = require("./BaseHandler.js");
class PrettyPrinterHandlers extends BaseHandler_js_1.BaseHandler {
    getTools() {
        return [
            {
                name: 'prettyPrinterSetting',
                description: 'Retrieves the pretty printer settings.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            // [READ-ONLY] Write tool disabled:
            // { name: 'setPrettyPrinterSetting', description: 'Sets the pretty printer settings.', ... },
            {
                name: 'prettyPrinter',
                description: 'Formats ABAP code using the pretty printer.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        source: {
                            type: 'string',
                            description: 'The ABAP source code to format.'
                        }
                    },
                    required: ['source']
                }
            }
        ];
    }
    handle(toolName, args) {
        return __awaiter(this, void 0, void 0, function* () {
            switch (toolName) {
                case 'prettyPrinterSetting':
                    return this.handlePrettyPrinterSetting(args);
                // [READ-ONLY] Write tool disabled:
                // case 'setPrettyPrinterSetting':
                //     return this.handleSetPrettyPrinterSetting(args);
                case 'prettyPrinter':
                    return this.handlePrettyPrinter(args);
                default:
                    throw new types_js_1.McpError(types_js_1.ErrorCode.MethodNotFound, `Unknown pretty printer tool: ${toolName}`);
            }
        });
    }
    handlePrettyPrinterSetting(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const settings = yield this.adtclient.prettyPrinterSetting();
                this.trackRequest(startTime, true);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                settings
                            })
                        }
                    ]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to get pretty printer settings: ${error.message || 'Unknown error'}`);
            }
        });
    }
    //     handleSetPrettyPrinterSetting(args) {
    //         return __awaiter(this, void 0, void 0, function* () {
    //             const startTime = performance.now();
    //             try {
    //                 const result = yield this.adtclient.setPrettyPrinterSetting(args.indent, args.style);
    //                 this.trackRequest(startTime, true);
    //                 return {
    //                     content: [
    //                         {
    //                             type: 'text',
    //                             text: JSON.stringify({
    //                                 status: 'success',
    //                                 result
    //                             })
    //                         }
    //                     ]
    //                 };
    //             }
    //             catch (error) {
    //                 this.trackRequest(startTime, false);
    //                 throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to set pretty printer settings: ${error.message || 'Unknown error'}`);
    //             }
    //         });
    //     }
    handlePrettyPrinter(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const source = yield this.adtclient.prettyPrinter(args.source);
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
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to format ABAP code: ${error.message || 'Unknown error'}`);
            }
        });
    }
}
exports.PrettyPrinterHandlers = PrettyPrinterHandlers;
