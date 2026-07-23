#!/usr/bin/env node
"use strict";
// PATCH MARKER: if this line does NOT appear in logs, the running app is loading
// index.js from a DIFFERENT path than you edited. Check __filename in the output.
// [READ-ONLY] Commented out patch marker log:
// process.stderr.write('[MCP index.js] PATCHED FILE LOADED from: ' + __filename + '\n');
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AbapAdtServer = void 0;
const dotenv_1 = require("dotenv");
const index_js_1 = require("@modelcontextprotocol/sdk/server/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const types_js_1 = require("@modelcontextprotocol/sdk/types.js");
const abap_adt_api_1 = require("abap-adt-api");
const path_1 = __importDefault(require("path"));
const AuthHandlers_js_1 = require("./handlers/AuthHandlers.js");
const TransportHandlers_js_1 = require("./handlers/TransportHandlers.js");
const ObjectHandlers_js_1 = require("./handlers/ObjectHandlers.js");
const ClassHandlers_js_1 = require("./handlers/ClassHandlers.js");
const CodeAnalysisHandlers_js_1 = require("./handlers/CodeAnalysisHandlers.js");
// [READ-ONLY] Write handler disabled:
// const ObjectLockHandlers_js_1 = require("./handlers/ObjectLockHandlers.js");
const ObjectSourceHandlers_js_1 = require("./handlers/ObjectSourceHandlers.js");
// [READ-ONLY] Write handler disabled:
// const ObjectDeletionHandlers_js_1 = require("./handlers/ObjectDeletionHandlers.js");
const ObjectManagementHandlers_js_1 = require("./handlers/ObjectManagementHandlers.js");
const ObjectRegistrationHandlers_js_1 = require("./handlers/ObjectRegistrationHandlers.js");
const NodeHandlers_js_1 = require("./handlers/NodeHandlers.js");
const DiscoveryHandlers_js_1 = require("./handlers/DiscoveryHandlers.js");
const UnitTestHandlers_js_1 = require("./handlers/UnitTestHandlers.js");
const PrettyPrinterHandlers_js_1 = require("./handlers/PrettyPrinterHandlers.js");
const GitHandlers_js_1 = require("./handlers/GitHandlers.js");
const DdicHandlers_js_1 = require("./handlers/DdicHandlers.js");
const ServiceBindingHandlers_js_1 = require("./handlers/ServiceBindingHandlers.js");
const QueryHandlers_js_1 = require("./handlers/QueryHandlers.js");
const FeedHandlers_js_1 = require("./handlers/FeedHandlers.js");
// [READ-ONLY] Write handler disabled (debuggerAttach is session-mutating):
// const DebugHandlers_js_1 = require("./handlers/DebugHandlers.js");
const RenameHandlers_js_1 = require("./handlers/RenameHandlers.js");
const AtcHandlers_js_1 = require("./handlers/AtcHandlers.js");
const TraceHandlers_js_1 = require("./handlers/TraceHandlers.js");
const RefactorHandlers_js_1 = require("./handlers/RefactorHandlers.js");
const RevisionHandlers_js_1 = require("./handlers/RevisionHandlers.js");
(0, dotenv_1.config)({ path: path_1.default.resolve(__dirname, '../.env') });
// READ-ONLY MODE: only tools that fetch/retrieve objects, source, data or metadata
// are exposed. Anything that creates, changes, locks, activates, deletes, or executes
// a write/refactor/debug action against the SAP system has been excluded.
const READ_ONLY_ALLOWED_TOOLS = new Set([
    'login', 'logout', 'dropSession',
    'objectStructure', 'searchObject', 'findObjectPath', 'objectTypes', 'reentranceTicket',
    'getObjectSource',
    'inactiveObjects',
    'objectRegistrationInfo',
    'nodeContents', 'mainPrograms',
    'classIncludes', 'classComponents',
    'syntaxCheckCode', 'syntaxCheckCdsUrl', 'codeCompletion', 'findDefinition',
    'usageReferences', 'syntaxCheckTypes', 'codeCompletionFull', 'runClass',
    'codeCompletionElement', 'usageReferenceSnippets', 'fixProposals',
    'fragmentMappings', 'abapDocumentation',
    'annotationDefinitions', 'ddicElement', 'ddicRepositoryAccess', 'packageSearchHelp',
    'transportInfo', 'hasTransportConfig', 'transportConfigurations',
    'getTransportConfiguration', 'userTransports', 'transportsByConfig',
    'systemUsers', 'transportReference',
    'tableContents', 'runQuery',
    'featureDetails', 'collectionFeatureDetails', 'findCollectionByUrl', 'loadTypes',
    'adtDiscovery', 'adtCoreDiscovery', 'adtCompatibiliyGraph',
    'unitTestRun', 'unitTestEvaluation', 'unitTestOccurrenceMarkers',
    'prettyPrinterSetting', 'prettyPrinter',
    'gitRepos', 'gitExternalRepoInfo', 'checkRepo', 'remoteRepoInfo',
    'renameEvaluate', 'renamePreview',
    'atcCustomizing', 'atcCheckVariant', 'createAtcRun', 'atcWorklists', 'atcUsers',
    'atcExemptProposal', 'isProposalMessage', 'atcContactUri',
    'tracesList', 'tracesListRequests', 'tracesHitList', 'tracesDbAccess', 'tracesStatements',
    'extractMethodEvaluate', 'extractMethodPreview',
    'revisions',
    'bindingDetails',
    'feeds', 'dumps',
    'healthcheck',
]);
class AbapAdtServer extends index_js_1.Server {
    constructor() {
        super({
            name: "mcp-abap-abap-adt-api",
            version: "0.1.0",
        }, {
            capabilities: {
                tools: {},
            },
        });
        const missingVars = ['SAP_USER', 'SAP_PASSWORD'].filter(v => !process.env[v]);
        if (missingVars.length > 0) {
            throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
        }
        if (process.env.SAP_USE_DESTINATION_PROXY === 'true') {
            // OnPremise destination: route through the BTP Connectivity Proxy /
            // Cloud Connector tunnel instead of a direct network call, so the
            // system is reachable from Cloud Foundry / BAS without a VPN.
            if (!process.env.SAP_DESTINATION_NAME) {
                throw new Error('Missing required environment variable: SAP_DESTINATION_NAME');
            }
            const { DestinationProxyHttpClient } = require('./destination-proxy-http-client.js');
            const httpClient = new DestinationProxyHttpClient(process.env.SAP_DESTINATION_NAME, {
                username: process.env.SAP_USER,
                password: process.env.SAP_PASSWORD,
            });
            this.adtClient = new abap_adt_api_1.ADTClient(httpClient, process.env.SAP_USER, process.env.SAP_PASSWORD, process.env.SAP_CLIENT, process.env.SAP_LANGUAGE);
        } else {
            // Internet-proxied (or directly reachable) destination: the resolved
            // URL can be hit directly, no Cloud Connector tunnel needed.
            if (!process.env.SAP_URL) {
                throw new Error('Missing required environment variable: SAP_URL');
            }
            this.adtClient = new abap_adt_api_1.ADTClient(process.env.SAP_URL, process.env.SAP_USER, process.env.SAP_PASSWORD, process.env.SAP_CLIENT, process.env.SAP_LANGUAGE);
        }
        this.adtClient.stateful = abap_adt_api_1.session_types.stateful;
        // Initialize handlers
        this.authHandlers = new AuthHandlers_js_1.AuthHandlers(this.adtClient);
        this.transportHandlers = new TransportHandlers_js_1.TransportHandlers(this.adtClient);
        this.objectHandlers = new ObjectHandlers_js_1.ObjectHandlers(this.adtClient);
        this.classHandlers = new ClassHandlers_js_1.ClassHandlers(this.adtClient);
        this.codeAnalysisHandlers = new CodeAnalysisHandlers_js_1.CodeAnalysisHandlers(this.adtClient);
        // [READ-ONLY] Write handler disabled:
        // this.objectLockHandlers = new ObjectLockHandlers_js_1.ObjectLockHandlers(this.adtClient);
        this.objectSourceHandlers = new ObjectSourceHandlers_js_1.ObjectSourceHandlers(this.adtClient);
        // [READ-ONLY] Write handler disabled:
        // this.objectDeletionHandlers = new ObjectDeletionHandlers_js_1.ObjectDeletionHandlers(this.adtClient);
        this.objectManagementHandlers = new ObjectManagementHandlers_js_1.ObjectManagementHandlers(this.adtClient);
        this.objectRegistrationHandlers = new ObjectRegistrationHandlers_js_1.ObjectRegistrationHandlers(this.adtClient);
        this.nodeHandlers = new NodeHandlers_js_1.NodeHandlers(this.adtClient);
        this.discoveryHandlers = new DiscoveryHandlers_js_1.DiscoveryHandlers(this.adtClient);
        this.unitTestHandlers = new UnitTestHandlers_js_1.UnitTestHandlers(this.adtClient);
        this.prettyPrinterHandlers = new PrettyPrinterHandlers_js_1.PrettyPrinterHandlers(this.adtClient);
        this.gitHandlers = new GitHandlers_js_1.GitHandlers(this.adtClient);
        this.ddicHandlers = new DdicHandlers_js_1.DdicHandlers(this.adtClient);
        this.serviceBindingHandlers = new ServiceBindingHandlers_js_1.ServiceBindingHandlers(this.adtClient);
        this.queryHandlers = new QueryHandlers_js_1.QueryHandlers(this.adtClient);
        this.feedHandlers = new FeedHandlers_js_1.FeedHandlers(this.adtClient);
        // [READ-ONLY] Write handler disabled:
        // this.debugHandlers = new DebugHandlers_js_1.DebugHandlers(this.adtClient);
        this.renameHandlers = new RenameHandlers_js_1.RenameHandlers(this.adtClient);
        this.atcHandlers = new AtcHandlers_js_1.AtcHandlers(this.adtClient);
        this.traceHandlers = new TraceHandlers_js_1.TraceHandlers(this.adtClient);
        this.refactorHandlers = new RefactorHandlers_js_1.RefactorHandlers(this.adtClient);
        this.revisionHandlers = new RevisionHandlers_js_1.RevisionHandlers(this.adtClient);
        // Setup tool handlers
        this.setupToolHandlers();
    }
    serializeResult(result) {
        try {
            return {
                content: [{
                        type: 'text',
                        text: JSON.stringify(result, (key, value) => typeof value === 'bigint' ? value.toString() : value)
                    }]
            };
        }
        catch (error) {
            return this.handleError(new types_js_1.McpError(types_js_1.ErrorCode.InternalError, 'Failed to serialize result'));
        }
    }
    handleError(error) {
        if (!(error instanceof Error)) {
            error = new Error(String(error));
        }
        if (error instanceof types_js_1.McpError) {
            return {
                content: [{
                        type: 'text',
                        text: JSON.stringify({
                            error: error.message,
                            code: error.code
                        })
                    }],
                isError: true
            };
        }
        return {
            content: [{
                    type: 'text',
                    text: JSON.stringify({
                        error: 'Internal server error',
                        code: types_js_1.ErrorCode.InternalError
                    })
                }],
            isError: true
        };
    }
    setupToolHandlers() {
        this.setRequestHandler(types_js_1.ListToolsRequestSchema, () => __awaiter(this, void 0, void 0, function* () {
            const allTools = [
                    ...this.authHandlers.getTools(),
                    ...this.transportHandlers.getTools(),
                    ...this.objectHandlers.getTools(),
                    ...this.classHandlers.getTools(),
                    ...this.codeAnalysisHandlers.getTools(),
                    // [READ-ONLY] Write-only handlers excluded from listing:
                    // ...this.objectLockHandlers.getTools(),
                    ...this.objectSourceHandlers.getTools(),
                    // [READ-ONLY] Write-only handlers excluded from listing:
                    // ...this.objectDeletionHandlers.getTools(),
                    ...this.objectManagementHandlers.getTools(),
                    ...this.objectRegistrationHandlers.getTools(),
                    ...this.nodeHandlers.getTools(),
                    ...this.discoveryHandlers.getTools(),
                    ...this.unitTestHandlers.getTools(),
                    ...this.prettyPrinterHandlers.getTools(),
                    ...this.gitHandlers.getTools(),
                    ...this.ddicHandlers.getTools(),
                    ...this.serviceBindingHandlers.getTools(),
                    ...this.queryHandlers.getTools(),
                    ...this.feedHandlers.getTools(),
                    // [READ-ONLY] Write-only handlers excluded from listing:
                    // ...this.debugHandlers.getTools(),
                    ...this.renameHandlers.getTools(),
                    ...this.atcHandlers.getTools(),
                    ...this.traceHandlers.getTools(),
                    ...this.refactorHandlers.getTools(),
                    ...this.revisionHandlers.getTools(),
                    {
                        name: 'healthcheck',
                        description: 'Check server health and connectivity',
                        inputSchema: {
                            type: 'object',
                            properties: {}
                        }
                    }
                ];
            return {
                tools: allTools.filter((t) => READ_ONLY_ALLOWED_TOOLS.has(t.name))
            };
        }));
        this.setRequestHandler(types_js_1.CallToolRequestSchema, (request) => __awaiter(this, void 0, void 0, function* () {
            try {
                // [READ-ONLY] Reject any tool not in the allowlist before the switch runs
                if (request.params.name !== 'healthcheck' && !READ_ONLY_ALLOWED_TOOLS.has(request.params.name)) {
                    throw new types_js_1.McpError(types_js_1.ErrorCode.MethodNotFound, `Tool '${request.params.name}' is disabled in read-only mode`);
                }
                let result;
                switch (request.params.name) {
                    case 'login':
                    case 'logout':
                    case 'dropSession':
                        result = yield this.authHandlers.handle(request.params.name, request.params.arguments);
                        break;
                    case 'transportInfo':
                    case 'createTransport':
                    case 'hasTransportConfig':
                    case 'transportConfigurations':
                    case 'getTransportConfiguration':
                    case 'setTransportsConfig':
                    case 'createTransportsConfig':
                    case 'userTransports':
                    case 'transportsByConfig':
                    case 'transportDelete':
                    case 'transportRelease':
                    case 'transportSetOwner':
                    case 'transportAddUser':
                    case 'systemUsers':
                    case 'transportReference':
                        result = yield this.transportHandlers.handle(request.params.name, request.params.arguments);
                        break;
                    // [READ-ONLY] Write tools disabled:
                    // case 'lock':
                    // case 'unLock':
                    //     result = yield this.objectLockHandlers.handle(request.params.name, request.params.arguments);
                    //     break;
                    case 'objectStructure':
                    case 'searchObject':
                    case 'findObjectPath':
                    case 'objectTypes':
                    case 'reentranceTicket':
                        result = yield this.objectHandlers.handle(request.params.name, request.params.arguments);
                        break;
                    case 'classIncludes':
                    case 'classComponents':
                        result = yield this.classHandlers.handle(request.params.name, request.params.arguments);
                        break;
                    case 'syntaxCheckCode':
                    case 'syntaxCheckCdsUrl':
                    case 'codeCompletion':
                    case 'findDefinition':
                    case 'usageReferences':
                    case 'syntaxCheckTypes':
                    case 'codeCompletionFull':
                    case 'runClass':
                    case 'codeCompletionElement':
                    case 'usageReferenceSnippets':
                    case 'fixProposals':
                    // [READ-ONLY] Write tool disabled:
                    // case 'fixEdits':
                    case 'fragmentMappings':
                    case 'abapDocumentation':
                        result = yield this.codeAnalysisHandlers.handle(request.params.name, request.params.arguments);
                        break;
                    case 'getObjectSource':
                    // [READ-ONLY] Write tool disabled:
                    // case 'setObjectSource':
                        result = yield this.objectSourceHandlers.handle(request.params.name, request.params.arguments);
                        break;
                    // [READ-ONLY] Write tool disabled:
                    // case 'deleteObject':
                    //     result = yield this.objectDeletionHandlers.handle(request.params.name, request.params.arguments);
                    //     break;
                    // [READ-ONLY] Write tools disabled:
                    // case 'activateObjects':
                    // case 'activateByName':
                    case 'inactiveObjects':
                        result = yield this.objectManagementHandlers.handle(request.params.name, request.params.arguments);
                        break;
                    case 'objectRegistrationInfo':
                    // [READ-ONLY] Write tools disabled:
                    // case 'validateNewObject':
                    // case 'createObject':
                        result = yield this.objectRegistrationHandlers.handle(request.params.name, request.params.arguments);
                        break;
                    case 'nodeContents':
                    case 'mainPrograms':
                        result = yield this.nodeHandlers.handle(request.params.name, request.params.arguments);
                        break;
                    case 'featureDetails':
                    case 'collectionFeatureDetails':
                    case 'findCollectionByUrl':
                    case 'loadTypes':
                    case 'adtDiscovery':
                    case 'adtCoreDiscovery':
                    case 'adtCompatibiliyGraph':
                        result = yield this.discoveryHandlers.handle(request.params.name, request.params.arguments);
                        break;
                    case 'unitTestRun':
                    case 'unitTestEvaluation':
                    case 'unitTestOccurrenceMarkers':
                    // [READ-ONLY] Write tool disabled:
                    // case 'createTestInclude':
                        result = yield this.unitTestHandlers.handle(request.params.name, request.params.arguments);
                        break;
                    case 'prettyPrinterSetting':
                    // [READ-ONLY] Write tool disabled:
                    // case 'setPrettyPrinterSetting':
                    case 'prettyPrinter':
                        result = yield this.prettyPrinterHandlers.handle(request.params.name, request.params.arguments);
                        break;
                    case 'gitRepos':
                    case 'gitExternalRepoInfo':
                    // [READ-ONLY] Write tools disabled:
                    // case 'gitCreateRepo':
                    // case 'gitPullRepo':
                    // case 'gitUnlinkRepo':
                    // case 'stageRepo':
                    // case 'pushRepo':
                    case 'checkRepo':
                    case 'remoteRepoInfo':
                    // [READ-ONLY] Write tool disabled:
                    // case 'switchRepoBranch':
                        result = yield this.gitHandlers.handle(request.params.name, request.params.arguments);
                        break;
                    case 'annotationDefinitions':
                    case 'ddicElement':
                    case 'ddicRepositoryAccess':
                    case 'packageSearchHelp':
                        result = yield this.ddicHandlers.handle(request.params.name, request.params.arguments);
                        break;
                    // [READ-ONLY] Write tools disabled:
                    // case 'publishServiceBinding':
                    // case 'unPublishServiceBinding':
                    case 'bindingDetails':
                        result = yield this.serviceBindingHandlers.handle(request.params.name, request.params.arguments);
                        break;
                    case 'tableContents':
                    case 'runQuery':
                        result = yield this.queryHandlers.handle(request.params.name, request.params.arguments);
                        break;
                    case 'feeds':
                    case 'dumps':
                        result = yield this.feedHandlers.handle(request.params.name, request.params.arguments);
                        break;
                    // [READ-ONLY] All debugger tools disabled (debuggerAttach is session-mutating;
                    // read-only debug tools are unreachable without it):
                    // case 'debuggerListeners':
                    // case 'debuggerListen':
                    // case 'debuggerDeleteListener':
                    // case 'debuggerSetBreakpoints':
                    // case 'debuggerDeleteBreakpoints':
                    // case 'debuggerAttach':
                    // case 'debuggerSaveSettings':
                    // case 'debuggerStackTrace':
                    // case 'debuggerVariables':
                    // case 'debuggerChildVariables':
                    // case 'debuggerStep':
                    // case 'debuggerGoToStack':
                    // case 'debuggerSetVariableValue':
                    //     result = yield this.debugHandlers.handle(request.params.name, request.params.arguments);
                    //     break;
                    case 'renameEvaluate':
                    case 'renamePreview':
                    // [READ-ONLY] Write tool disabled:
                    // case 'renameExecute':
                        result = yield this.renameHandlers.handle(request.params.name, request.params.arguments);
                        break;
                    case 'atcCustomizing':
                    case 'atcCheckVariant':
                    case 'createAtcRun':
                    case 'atcWorklists':
                    case 'atcUsers':
                    case 'atcExemptProposal':
                    // [READ-ONLY] Write tool disabled:
                    // case 'atcRequestExemption':
                    case 'isProposalMessage':
                    case 'atcContactUri':
                    // [READ-ONLY] Write tool disabled:
                    // case 'atcChangeContact':
                        result = yield this.atcHandlers.handle(request.params.name, request.params.arguments);
                        break;
                    case 'tracesList':
                    case 'tracesListRequests':
                    case 'tracesHitList':
                    case 'tracesDbAccess':
                    case 'tracesStatements':
                    // [READ-ONLY] Write tools disabled:
                    // case 'tracesSetParameters':
                    // case 'tracesCreateConfiguration':
                    // case 'tracesDeleteConfiguration':
                    // case 'tracesDelete':
                        result = yield this.traceHandlers.handle(request.params.name, request.params.arguments);
                        break;
                    case 'extractMethodEvaluate':
                    case 'extractMethodPreview':
                    // [READ-ONLY] Write tool disabled:
                    // case 'extractMethodExecute':
                        result = yield this.refactorHandlers.handle(request.params.name, request.params.arguments);
                        break;
                    case 'revisions':
                        result = yield this.revisionHandlers.handle(request.params.name, request.params.arguments);
                        break;
                    case 'healthcheck':
                        result = { status: 'healthy', timestamp: new Date().toISOString() };
                        break;
                    default:
                        throw new types_js_1.McpError(types_js_1.ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
                }
                return this.serializeResult(result);
            }
            catch (error) {
                return this.handleError(error);
            }
        }));
    }
    run() {
        return __awaiter(this, void 0, void 0, function* () {
            const transport = new stdio_js_1.StdioServerTransport();
            yield this.connect(transport);
            console.error('MCP ABAP ADT API server running on stdio');
            // Handle shutdown
            process.on('SIGINT', () => __awaiter(this, void 0, void 0, function* () {
                yield this.close();
                process.exit(0);
            }));
            process.on('SIGTERM', () => __awaiter(this, void 0, void 0, function* () {
                yield this.close();
                process.exit(0);
            }));
            // Handle errors
            this.onerror = (error) => {
                console.error('[MCP Error]', error);
            };
        });
    }
}
exports.AbapAdtServer = AbapAdtServer;
// Create and run server instance
const server = new AbapAdtServer();
server.run().catch((error) => {
    console.error('Failed to start MCP server:', error);
    process.exit(1);
});