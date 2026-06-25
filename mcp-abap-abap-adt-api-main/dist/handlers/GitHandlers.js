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
exports.GitHandlers = void 0;
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const BaseHandler_js_1 = require("./BaseHandler.js");
class GitHandlers extends BaseHandler_js_1.BaseHandler {
    getTools() {
        return [
            {
                name: 'gitRepos',
                description: 'Retrieves a list of Git repositories.',
                inputSchema: {
                    type: 'object',
                    properties: {}
                }
            },
            {
                name: 'gitExternalRepoInfo',
                description: 'Retrieves information about an external Git repository.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        repourl: {
                            type: 'string',
                            description: 'The URL of the repository.'
                        },
                        user: {
                            type: 'string',
                            description: 'The username.',
                            optional: true
                        },
                        password: {
                            type: 'string',
                            description: 'The password.',
                            optional: true
                        }
                    },
                    required: ['repourl']
                }
            },
            {
                name: 'gitCreateRepo',
                description: 'Creates a new Git repository.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        packageName: {
                            type: 'string',
                            description: 'The name of the package.'
                        },
                        repourl: {
                            type: 'string',
                            description: 'The URL of the repository.'
                        },
                        branch: {
                            type: 'string',
                            description: 'The branch name.',
                            optional: true
                        },
                        transport: {
                            type: 'string',
                            description: 'The transport.',
                            optional: true
                        },
                        user: {
                            type: 'string',
                            description: 'The username.',
                            optional: true
                        },
                        password: {
                            type: 'string',
                            description: 'The password.',
                            optional: true
                        }
                    },
                    required: ['packageName', 'repourl']
                }
            },
            {
                name: 'gitPullRepo',
                description: 'Pulls changes from a Git repository.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        repoId: {
                            type: 'string',
                            description: 'The ID of the repository.'
                        },
                        branch: {
                            type: 'string',
                            description: 'The branch name.',
                            optional: true
                        },
                        transport: {
                            type: 'string',
                            description: 'The transport.',
                            optional: true
                        },
                        user: {
                            type: 'string',
                            description: 'The username.',
                            optional: true
                        },
                        password: {
                            type: 'string',
                            description: 'The password.',
                            optional: true
                        }
                    },
                    required: ['repoId']
                }
            },
            {
                name: 'gitUnlinkRepo',
                description: 'Unlinks a Git repository.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        repoId: {
                            type: 'string',
                            description: 'The ID of the repository.'
                        }
                    },
                    required: ['repoId']
                }
            },
            {
                name: 'stageRepo',
                description: 'Stages changes in a Git repository.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        repo: {
                            type: 'object',
                            description: 'The Git repository object.'
                        },
                        user: {
                            type: 'string',
                            description: 'The username.',
                            optional: true
                        },
                        password: {
                            type: 'string',
                            description: 'The password.',
                            optional: true
                        }
                    },
                    required: ['repo']
                }
            },
            {
                name: 'pushRepo',
                description: 'Pushes changes to a Git repository.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        repo: {
                            type: 'object',
                            description: 'The Git repository object.'
                        },
                        staging: {
                            type: 'object',
                            description: 'The staging information object.'
                        },
                        user: {
                            type: 'string',
                            description: 'The username.',
                            optional: true
                        },
                        password: {
                            type: 'string',
                            description: 'The password.',
                            optional: true
                        }
                    },
                    required: ['repo', 'staging']
                }
            },
            {
                name: 'checkRepo',
                description: 'Checks a Git repository.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        repo: {
                            type: 'string',
                            description: 'The Git repository.'
                        },
                        user: {
                            type: 'string',
                            description: 'The username.',
                            optional: true
                        },
                        password: {
                            type: 'string',
                            description: 'The password.',
                            optional: true
                        }
                    },
                    required: ['repo']
                }
            },
            {
                name: 'remoteRepoInfo',
                description: 'Retrieves information about a remote Git repository.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        repo: {
                            type: 'string',
                            description: 'The Git repository.'
                        },
                        user: {
                            type: 'string',
                            description: 'The username.',
                            optional: true
                        },
                        password: {
                            type: 'string',
                            description: 'The password.',
                            optional: true
                        }
                    },
                    required: ['repo']
                }
            },
            {
                name: 'switchRepoBranch',
                description: 'Switches the branch of a Git repository.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        repo: {
                            type: 'string',
                            description: 'The Git repository.'
                        },
                        branch: {
                            type: 'string',
                            description: 'The branch name.'
                        },
                        create: {
                            type: 'boolean',
                            description: 'Whether to create the branch if it doesn\'t exist.',
                            optional: true
                        },
                        user: {
                            type: 'string',
                            description: 'The username.',
                            optional: true
                        },
                        password: {
                            type: 'string',
                            description: 'The password.',
                            optional: true
                        }
                    },
                    required: ['repo', 'branch']
                }
            }
        ];
    }
    handle(toolName, args) {
        return __awaiter(this, void 0, void 0, function* () {
            switch (toolName) {
                case 'gitRepos':
                    return this.handleGitRepos(args);
                case 'gitExternalRepoInfo':
                    return this.handleGitExternalRepoInfo(args);
                case 'gitCreateRepo':
                    return this.handleGitCreateRepo(args);
                case 'gitPullRepo':
                    return this.handleGitPullRepo(args);
                case 'gitUnlinkRepo':
                    return this.handleGitUnlinkRepo(args);
                case 'stageRepo':
                    return this.handleStageRepo(args);
                case 'pushRepo':
                    return this.handlePushRepo(args);
                case 'checkRepo':
                    return this.handleCheckRepo(args);
                case 'remoteRepoInfo':
                    return this.handleRemoteRepoInfo(args);
                case 'switchRepoBranch':
                    return this.handleSwitchRepoBranch(args);
                default:
                    throw new types_js_1.McpError(types_js_1.ErrorCode.MethodNotFound, `Unknown git tool: ${toolName}`);
            }
        });
    }
    handleGitRepos(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const repos = yield this.adtclient.gitRepos();
                this.trackRequest(startTime, true);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                repos
                            })
                        }
                    ]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to get git repos: ${error.message || 'Unknown error'}`);
            }
        });
    }
    handleGitExternalRepoInfo(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const repoInfo = yield this.adtclient.gitExternalRepoInfo(args.repourl, args.user, args.password);
                this.trackRequest(startTime, true);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                repoInfo
                            })
                        }
                    ]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to get external repo info: ${error.message || 'Unknown error'}`);
            }
        });
    }
    handleGitCreateRepo(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const result = yield this.adtclient.gitCreateRepo(args.packageName, args.repourl, args.branch, args.transport, args.user, args.password);
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
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to create git repo: ${error.message || 'Unknown error'}`);
            }
        });
    }
    handleGitPullRepo(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const result = yield this.adtclient.gitPullRepo(args.repoId, args.branch, args.transport, args.user, args.password);
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
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to pull git repo: ${error.message || 'Unknown error'}`);
            }
        });
    }
    handleGitUnlinkRepo(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const result = yield this.adtclient.gitUnlinkRepo(args.repoId);
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
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to unlink git repo: ${error.message || 'Unknown error'}`);
            }
        });
    }
    handleStageRepo(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const result = yield this.adtclient.stageRepo(args.repo, args.user, args.password);
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
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to stage repo: ${error.message || 'Unknown error'}`);
            }
        });
    }
    handlePushRepo(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const result = yield this.adtclient.pushRepo(args.repo, args.staging, args.user, args.password);
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
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to push repo: ${error.message || 'Unknown error'}`);
            }
        });
    }
    handleCheckRepo(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const result = yield this.adtclient.checkRepo(args.repo, args.user, args.password);
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
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to check repo: ${error.message || 'Unknown error'}`);
            }
        });
    }
    handleRemoteRepoInfo(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const repoInfo = yield this.adtclient.remoteRepoInfo(args.repo, args.user, args.password);
                this.trackRequest(startTime, true);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                status: 'success',
                                repoInfo
                            })
                        }
                    ]
                };
            }
            catch (error) {
                this.trackRequest(startTime, false);
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to get remote repo info: ${error.message || 'Unknown error'}`);
            }
        });
    }
    handleSwitchRepoBranch(args) {
        return __awaiter(this, void 0, void 0, function* () {
            const startTime = performance.now();
            try {
                const result = yield this.adtclient.switchRepoBranch(args.repo, args.branch, args.create, args.user, args.password);
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
                throw new types_js_1.McpError(types_js_1.ErrorCode.InternalError, `Failed to switch repo branch: ${error.message || 'Unknown error'}`);
            }
        });
    }
}
exports.GitHandlers = GitHandlers;
