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
exports.DiscoveryHandlers = void 0;
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const BaseHandler_js_1 = require("./BaseHandler.js");
class DiscoveryHandlers extends BaseHandler_js_1.BaseHandler {
    getTools() {
        return [
            {
                name: 'featureDetails',
                description: 'Retrieves details for a given feature.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        title: {
                            type: 'string',
                            description: 'The title of the feature.'
                        }
                    },
                    required: ['title']
                }
            },
            {
                name: 'collectionFeatureDetails',
                description: 'Retrieves details for a given collection feature.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            description: 'The URL of the collection feature.'
                        }
                    },
                    required: ['url']
                }
            },
            {
                name: 'findCollectionByUrl',
                description: 'Finds a collection by its URL.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            description: 'The URL of the collection.'
                        }
                    },
                    required: ['url']
                }
            },
            {
                name: 'loadTypes',
                description: 'Loads object types.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'adtDiscovery',
                description: 'Performs ADT discovery.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'adtCoreDiscovery',
                description: 'Performs ADT core discovery.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'adtCompatibiliyGraph',
                description: 'Retrieves the ADT compatibility graph.',
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
                case 'featureDetails':
                    return this.handleFeatureDetails(args);
                case 'collectionFeatureDetails':
                    return this.handleCollectionFeatureDetails(args);
                case 'findCollectionByUrl':
                    return this.handleFindCollectionByUrl(args);
                case 'loadTypes':
                    return this.handleLoadTypes(args);
                case 'adtDiscovery':
                    return this.handleAdtDiscovery(args);
                case 'adtCoreDiscovery':
                    return this.handleAdtCoreDiscovery(args);
                case 'adtCompatibiliyGraph':
                    return this.handleAdtCompatibilityGraph(args);
                default:
                    throw new types_js_1.McpError(types_js_1.ErrorCode.MethodNotFound, `Unknown discovery tool: ${toolName}`);
            }
        });
    }
    handleFeatureDetails(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const details = yield this.adtclient.featureDetails(args.title);
                this.trackRequest(startTime, true);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                details
                            })
                        }
                    ]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to get feature details: ${error.message || 'Unknown error'}`);
            }
        });
    }
    handleCollectionFeatureDetails(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const details = yield this.adtclient.collectionFeatureDetails(args.url);
                this.trackRequest(startTime, true);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                details
                            })
                        }
                    ]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to get collection feature details: ${error.message || 'Unknown error'}`);
            }
        });
    }
    handleFindCollectionByUrl(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const collection = yield this.adtclient.findCollectionByUrl(args.url);
                this.trackRequest(startTime, true);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                collection
                            })
                        }
                    ]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to find collection by URL: ${error.message || 'Unknown error'}`);
            }
        });
    }
    handleLoadTypes(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const types = yield this.adtclient.loadTypes();
                this.trackRequest(startTime, true);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                types
                            })
                        }
                    ]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to load types: ${error.message || 'Unknown error'}`);
            }
        });
    }
    handleAdtDiscovery(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const discovery = yield this.adtclient.adtDiscovery();
                this.trackRequest(startTime, true);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                discovery
                            })
                        }
                    ]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to perform ADT discovery: ${error.message || 'Unknown error'}`);
            }
        });
    }
    handleAdtCoreDiscovery(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const discovery = yield this.adtclient.adtCoreDiscovery();
                this.trackRequest(startTime, true);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                discovery
                            })
                        }
                    ]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to perform ADT core discovery: ${error.message || 'Unknown error'}`);
            }
        });
    }
    handleAdtCompatibilityGraph(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const graph = yield this.adtclient.adtCompatibiliyGraph();
                this.trackRequest(startTime, true);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                graph
                            })
                        }
                    ]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to get ADT compatibility graph: ${error.message || 'Unknown error'}`);
            }
        });
    }
}
exports.DiscoveryHandlers = DiscoveryHandlers;
