const cds = require('@sap/cds');
const { getDestination } = require('@sap-cloud-sdk/connectivity');
const { Registry, MemoryFile } = require('@abaplint/core');
const { sendMail } = require('@sap-cloud-sdk/mail-client');

const GLOBAL_SYSTEM_INSTRUCTION = 
    'You are an expert SAP developer specializing in ABAP. ' +
    'CRITICAL RULES: ' +

    '1. You MUST wrap your entire response in a single ```abap code block. ' +
    '2. NO CONVERSATION. Do not apologize, do not explain your fixes, and do not include validation logs. Output ONLY code. ' +
    '3. If you encounter an obsolete, Classic API, or deprecated object in a request, you MUST replace it with its exact ABAP equivalent (e.g., replace ALV with HTTP/Fiori logic). ' +
    '4. NEVER simply delete requested functionality to avoid errors. You must provide the modern equivalent. ' +
    '5. NO PSEUDO-CODE. You must write executable, active ABAP code. Do NOT comment out the main business logic or use placeholder classes/strings. If you do not know the exact Tier 1 API, attempt to write the real code anyway.';

const MAX_RETRIES = 3;
const MAX_CHATS_PER_USER = 10;
const MAX_PROMPTS_PER_SESSION = 20;
const ABAP_IGNORE_PHRASES = [
    'align ', 'change if to case', 'end of line comments', 'name too long',
    'remove double space', 'implicit start-of-selection', 'text element',
    'exit is not allowed', 'specify table key', 'functional writing style',
    'indentation', 'does not match pattern', 'main file must have specific contents',
    'only one statement is allowed', 'hungarian notation', 'is obsolete',
    'statement does not exist', 'reduce procedural code', 'add order by',
    'remove space', 'remove whitespace', 'start statement at tab', 'strict sql',
    'unnecessary chaining', 'must be escaped with @', 'empty event',
    'specify table type', 'not found, findtop'
];

const GITHUB_BASE = 'https://raw.githubusercontent.com/SAP/abap-atc-cr-cv-s4hc/main/src';
const SAP_RELEASE_VERSION = 'PCE2023_0';

let cloudificationCache = [];

async function fetchJSON(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
    return response.json();
}

async function syncCloudificationData() {
    const entries = [];

    const [tier1Data, tier2Data] = await Promise.allSettled([
        fetchJSON(`${GITHUB_BASE}/objectReleaseInfo_${SAP_RELEASE_VERSION}.json`),
        fetchJSON(`${GITHUB_BASE}/objectClassifications.json`)
    ]);

    if (tier1Data.status === 'fulfilled') {
        const items = tier1Data.value?.objectReleaseInfo || tier1Data.value || [];
        for (const item of items) {
            try {
                const name = item.objectKey?.toUpperCase() || item.tadirObjName?.toUpperCase();
                if (!name) continue;
                const successor = item.successors?.[0]?.tadirObjName?.toUpperCase() || null;
                const state = item.state?.toLowerCase();
                entries.push({
                    object: name,
                    successor,
                    type: item.objectType || item.tadirObject,
                    state: state === 'deprecated' ? 'DEPRECATED' : 'RELEASED',
                    tier: 1
                });
            } catch { }
        }
    }

    if (tier2Data.status === 'fulfilled') {
        const items = tier2Data.value?.objectClassifications || tier2Data.value || [];
        for (const item of items) {
            try {
                const name = item.objectKey?.toUpperCase() || item.tadirObjName?.toUpperCase();
                if (!name) continue;
                const alreadyInTier1 = entries.some(e => e.object === name && e.tier === 1);
                if (alreadyInTier1) continue;
                const rawState = (item.state || '').toLowerCase().replace(/[\s_]/g, '');
                let state = 'CLASSIC_API';
                if (rawState === 'released') state = 'RELEASED';
                else if (rawState === 'deprecated') state = 'DEPRECATED';
                else if (rawState === 'nottobereleased') state = 'NOT_TO_BE_RELEASED';
                else if (rawState === 'classicapi') state = 'CLASSIC_API';
                const successor = item.successors?.[0]?.tadirObjName?.toUpperCase() || null;
                entries.push({
                    object: name,
                    successor,
                    type: item.objectType || item.tadirObject,
                    state,
                    tier: 2
                });
            } catch { }
        }
    }

    cloudificationCache = entries;
}

syncCloudificationData();

const ABAP_OBJECT_TYPE_PATTERNS = [
    { type: 'TYPE', regex: /\bTYPE\s+(?:TABLE OF\s+|STANDARD TABLE OF\s+|SORTED TABLE OF\s+|HASHED TABLE OF\s+)?([\/A-Za-z0-9_]+)/gi },
    { type: 'FROM', regex: /\bFROM\s+([\/A-Za-z0-9_]+)/gi },
    { type: 'JOIN', regex: /\bJOIN\s+([\/A-Za-z0-9_]+)/gi },
    { type: 'INTO TABLE', regex: /\bINTO\s+(?:TABLE\s+)?@?([\/A-Za-z0-9_]+)/gi },
    { type: 'REF TO', regex: /\bREF\s+TO\s+([\/A-Za-z0-9_]+)/gi },
    { type: 'CALL FUNCTION', regex: /\bCALL\s+FUNCTION\s+'([\/A-Za-z0-9_]+)'/gi },
    { type: 'CALL METHOD', regex: /\bCALL\s+METHOD\s+([\/A-Za-z0-9_]+)/gi },
    { type: 'CLASS', regex: /\b((?:CL|IF|CX|BP|BL|CA|CB|CC|CD|CE|CF|CG|CH|CI|CJ|CK|CM|CN|CO|CP|CQ|CR|CS|CT|CU|CV|CW|CX|CY|CZ)_[A-Za-z0-9_\/]+)\b/gi },
    { type: 'STATIC CALL', regex: /([\/A-Za-z0-9_]+)=>/gi },
    { type: 'BAPI', regex: /\b(BAPI_[A-Za-z0-9_\/]+)\b/gi },
    { type: 'INCLUDE', regex: /\bINCLUDE\s+([\/A-Za-z0-9_]+)/gi },
    { type: 'TABLES', regex: /\bTABLES\s*:\s*([\/A-Za-z0-9_,\s]+)/gi },
    { type: 'SELECT-OPTIONS', regex: /\bSELECT-OPTIONS\s+\w+\s+FOR\s+([\/A-Za-z0-9_]+)-/gi },
    { type: 'PARAMETERS TYPE', regex: /\bPARAMETERS\s+\w+\s+TYPE\s+([\/A-Za-z0-9_]+)/gi },
    { type: 'RANGES', regex: /\bRANGES\s+\w+\s+FOR\s+([\/A-Za-z0-9_]+)-/gi },
    { type: 'AUTHORITY-CHECK', regex: /\bAUTHORITY-CHECK\s+OBJECT\s+'([\/A-Za-z0-9_]+)'/gi },
    { type: 'CALL TRANSACTION', regex: /\bCALL\s+TRANSACTION\s+'([\/A-Za-z0-9_]+)'/gi },
    { type: 'MESSAGE', regex: /\bMESSAGE\s+\w+\(\s*([\/A-Za-z0-9_]+)\s*\)/gi },
    { type: 'ENHANCEMENT', regex: /\b((?:ES|BADI|BADI_DEF)_[A-Za-z0-9_\/]+)\b/gi },
    { type: 'FUNCTION GROUP', regex: /\b((?:SAPL|FG_)[A-Za-z0-9_\/]+)\b/gi }
];

const ABAP_PRIMITIVE_TYPES = new Set([
    'STRING', 'XSTRING', 'INT1', 'INT2', 'INT4', 'INT8', 'FLOAT', 'DECFLOAT16', 'DECFLOAT34',
    'NUMC', 'CHAR', 'DATS', 'TIMS', 'PACK', 'HEX', 'CLNT', 'LANG', 'UNIT', 'CUKY', 'CURR',
    'DEC', 'FLTP', 'PREC', 'QUAN', 'SSTRING', 'RAWSTRING',
    'I', 'D', 'T', 'F', 'C', 'N', 'X', 'P',
    'TABLE', 'ANY', 'STANDARD', 'DATA', 'REF', 'TO', 'OF',
    'ABAP_BOOL', 'ABAP_TRUE', 'ABAP_FALSE', 'SPACE', 'SY', 'SYST'
]);

function stripAbapComments(code) {
    return code
        .split('\n')
        .map(line => {
            const trimmed = line.trimStart();
            if (trimmed.startsWith('*')) return '';
            let inString = false;
            for (let i = 0; i < line.length; i++) {
                if (line[i] === "'") {
                    inString = !inString;
                } else if (line[i] === '"' && !inString) {
                    return line.slice(0, i);
                }
            }
            return line;
        })
        .join('\n');
}

function extractAbapObjects(abapCode) {
    const cleanCode = stripAbapComments(abapCode);
    const objects = new Set();

    for (const { type, regex } of ABAP_OBJECT_TYPE_PATTERNS) {
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(cleanCode)) !== null) {
            if (type === 'TABLES') {
                match[1].split(',').map(t => t.trim()).filter(Boolean).forEach(t => objects.add(t.toUpperCase()));
            } else {
                objects.add(match[1].toUpperCase());
            }
        }
    }

    return Array.from(objects).filter(obj => {
        const upper = obj.toUpperCase();
        return (
            !ABAP_PRIMITIVE_TYPES.has(upper) &&
            obj.length > 4 &&
            !/^\d+$/.test(obj) &&
            !/^(LV_|LS_|LT_|GV_|GS_|GT_|IV_|IS_|IT_|EV_|ES_|ET_|CV_|CS_|CT_|RV_|RS_|RT_|MV_|MS_|MT_|WA_|ST_|P_|S_|LO_|MO_|AO_|GO_|IO_|EO_|RO_|CO_)/i.test(obj) &&
            !/^TY_/i.test(obj) &&
            !/^(BEGIN|END|TYPES|DATA|FIELD|LINE|LOOP|SELECT|INSERT|UPDATE|DELETE|WHERE|INTO|FROM|AND|NOT|OR|IF|ELSE|ENDIF|ENDLOOP|EXIT|CONTINUE|RETURN|PERFORM|FORM|ENDFORM|WRITE|MESSAGE|APPEND|CLEAR|MOVE|ADD|SUBTRACT|MULTIPLY|DIVIDE|CONCATENATE|SPLIT|CONDENSE|TRANSLATE|SHIFT|REPLACE|SEARCH|MODIFY|COLLECT|SORT|READ|FIND|DESCRIBE|ASSIGN|CHECK|RAISE|CATCH|TRY|ENDTRY|RESUME|RETRY|CLEANUP|METHODS|INTERFACES|ALIASES|PROTECTED|PRIVATE|PUBLIC|CLASS|ENDCLASS|METHOD|ENDMETHOD|SECTION|IMPLEMENTATION|DEFINITION)$/i.test(obj)
        );
    });
}

const SAP_ALWAYS_VALID_OBJECTS = new Set([
    'BAPI_TRANSACTION_COMMIT', 'BAPI_TRANSACTION_ROLLBACK',
    'BAPIRET2', 'BAPIRET1', 'BAPIPAREX', 'BAPIPARAM', 'BAPILOGDET',
    'BAPI_RETURN', 'BAPIMSGKY', 'BAPIADDR1', 'BAPIADDR2',
    'LIKP', 'LIPS', 'MARA', 'MARC', 'MARD', 'MCHB', 'MKPF', 'MSEG',
    'VBAK', 'VBAP', 'VBEP', 'VBFA', 'VBKD', 'VBPA', 'VBUK', 'VBUP',
    'KNA1', 'KNB1', 'LFA1', 'LFB1', 'EKKO', 'EKPO', 'EKET',
    'T001', 'T001W', 'T006', 'T006A', 'TCURR', 'TCURF',
    'AUFK', 'AUFP', 'CRHD', 'CRCO',
    'ABAP_BOOL', 'ABAP_TRUE', 'ABAP_FALSE', 'ABAP_ENCODING',
    'SY', 'SYST', 'SPACE'
]);

function checkDeprecation(obj) {
    if (cloudificationCache.length === 0) return { status: 'unknown' };

    const asSuccessor = cloudificationCache.find(rule => rule.successor === obj);
    if (asSuccessor) return { status: 'valid' };

    const entry = cloudificationCache.find(rule => rule.object === obj);
    if (!entry) return { status: 'unknown' };

    const state = entry.state;

    if (state === 'RELEASED') return { status: 'valid' };

    if (state === 'DEPRECATED') {
        return entry.successor
            ? { status: 'deprecated', successor: entry.successor }
            : { status: 'valid' };
    }

    if (state === 'NOT_TO_BE_RELEASED') {
        return entry.successor
            ? { status: 'deprecated', successor: entry.successor }
            : { status: 'not_to_be_released' };
    }

    if (state === 'CLASSIC_API') {
        return { status: 'classic_api' };
    }

    return { status: 'unknown' };
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const objectExistenceCache = new Map();

function getCachedExistence(key) {
    const entry = objectExistenceCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
        objectExistenceCache.delete(key);
        return null;
    }
    return entry.value;
}

function setCachedExistence(key, value) {
    objectExistenceCache.set(key, { value, timestamp: Date.now() });
}

async function checkObjectExistsInAPIHub(objectName) {
    const cached = getCachedExistence(objectName);
    if (cached !== null) return cached;

    const dest = await getDestination({ destinationName: 'AiChatDestination' });
    const apiKey = dest.originalProperties;
    if (!apiKey) return null;

    const encodedName = encodeURIComponent(objectName);

    const endpoints = [
        `https://sandbox.api.sap.com/s4hanacloud/sap/opu/odata/sap/FUNCTION_MODULE_SRV/FunctionModuleSet?$filter=FunctionModule eq '${encodedName}'&$format=json`,
        `https://sandbox.api.sap.com/s4hanacloud/sap/opu/odata/sap/API_DATADICTIIONARY_SRV/DataDictionaryObjectSet?$filter=ObjectName eq '${encodedName}'&$format=json`,
        `https://sandbox.api.sap.com/s4hanacloud/sap/opu/odata/sap/API_RELEASED_OBJECTS_SRV/ReleasedObjectSet?$filter=ObjectName eq '${encodedName}'&$format=json`
    ];

    for (const url of endpoints) {
        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: { APIKey: apiKey, Accept: 'application/json' }
            });

            if (response.ok) {
                const data = await response.json();
                const results = data?.d?.results || data?.value || [];
                if (results.length > 0) {
                    const result = { exists: true };
                    setCachedExistence(objectName, result);
                    return result;
                }
            }
        } catch { }
    }

    const result = { exists: false };
    setCachedExistence(objectName, result);
    return result;
}

async function checkApiEndpointInAPIHub(apiName) {
    try {
        const dest = await getDestination({ destinationName: 'AiChatDestination' });
        // FIX: was destructuring into unused local; now correctly reads the apiKey property
        const apiKey = dest.originalProperties?.apiKey || dest.originalProperties;
        if (!apiKey) return null;

        const response = await fetch(
            `https://sandbox.api.sap.com/s4hanacloud/odata/v4/${apiName}/$metadata`,
            { method: 'GET', headers: { APIKey: apiKey, Accept: 'application/json' } }
        );

        return response.ok
            ? { isValid: true }
            : { isValid: false, message: `API '${apiName}' not found in SAP API Hub.` };
    } catch {
        return null;
    }
}

async function validateObjects(abapCode) {
    const foundObjects = extractAbapObjects(abapCode);
    const dest = await getDestination({ destinationName: 'AiChatDestination' });
    const apiKey = dest.originalProperties;
    const apiKeyAvailable = !!apiKey;

    const errors = [];
    const deprecatedObjects = [];
    const invalidObjects = [];

    for (const obj of foundObjects) {
        if (SAP_ALWAYS_VALID_OBJECTS.has(obj)) continue;

        const deprecation = checkDeprecation(obj);

        if (deprecation.status === 'valid') continue;

        if (deprecation.status === 'deprecated') {
            errors.push({
                type: 'deprecated',
                message: `Object '${obj}' is deprecated. Replace it with its official SAP successor: '${deprecation.successor}'.`,
                obj,
                successor: deprecation.successor
            });
            deprecatedObjects.push({ name: obj, successor: deprecation.successor });
            continue;
        }

        if (deprecation.status === 'not_to_be_released') {
            errors.push({
                type: 'not_to_be_released',
                message: `Object '${obj}' is marked as 'Not To Be Released' in SAP Cloud ERP Private ${SAP_RELEASE_VERSION}. It must not be used — find a released Tier 1 successor.`,
                obj,
                successor: null
            });
            invalidObjects.push({ name: obj, successor: null, reason: 'not_to_be_released' });
            continue;
        }

        if (deprecation.status === 'classic_api') {
            errors.push({
                type: 'classic_api',
                message: `Object '${obj}' is a Classic API (Tier 2 only). It cannot be used in ABAP Cloud (Tier 1). Wrap it or find a released Tier 1 successor.`,
                obj,
                successor: null
            });
            invalidObjects.push({ name: obj, successor: null, reason: 'classic_api' });
            continue;
        }

        if (deprecation.status === 'unknown') {
            if (apiKeyAvailable) {
                const existence = await checkObjectExistsInAPIHub(obj);
                
                if (!existence || !existence.exists) {
                    const reasonMsg = existence === null 
                        ? `API Hub network error verifying '${obj}'. Object assumed invalid.` 
                        : `Object '${obj}' was not found in SAP Cloud Repository or API Hub. It may not exist or is not released for cloud use.`;
                    
                    errors.push({
                        type: 'invalid',
                        message: reasonMsg,
                        obj,
                        successor: null
                    });
                    invalidObjects.push({ name: obj, successor: null, reason: 'not_found' });
                }
            }
        }
    }

    return { errors, deprecatedObjects, invalidObjects };
}

async function validateAbapSyntax(abapCode) {
    const registry = new Registry();
    const file = new MemoryFile('z_generated_code.prog.abap', abapCode);
    registry.addFile(file);
    await registry.parseAsync();

    const issues = registry.findIssues();

    return issues
        .filter(issue => {
            const severity = issue.getSeverity();
            const message = issue.getMessage().toLowerCase();
            const isHighSeverity = severity === 1 || severity === 2 || severity === 'Error';
            return isHighSeverity && !ABAP_IGNORE_PHRASES.some(phrase => message.includes(phrase));
        })
        .map(issue => `Line ${issue.getStart().getRow()}: ${issue.getMessage()}`);
}

async function performInternalValidation(text) {
    const abapRegex = /```(?:abap|ABAP|sql)?\s*\n([\s\S]*?)```/g;
    let match;
    const repoErrors = [];
    const apiErrors = [];
    const invalidObjects = [];
    
    let extractedCodeBlocks = [];

    while ((match = abapRegex.exec(text)) !== null) {
        extractedCodeBlocks.push(match[1]);
    }

    if (extractedCodeBlocks.length === 0 && (text.includes('DATA:') || text.includes('SELECT ') || text.includes('CLASS '))) {
        extractedCodeBlocks.push(text);
    }

    const containsAbap = extractedCodeBlocks.length > 0;

    for (const code of extractedCodeBlocks) {

        const objectResult = await validateObjects(code);
        repoErrors.push(...objectResult.errors);
        invalidObjects.push(...objectResult.invalidObjects, ...objectResult.deprecatedObjects);

        const foundApis = code.match(/API_[a-zA-Z0-9_]+/gi) || [];
        const uniqueApis = [...new Set(foundApis.map(a => a.toUpperCase()))];

        for (const apiName of uniqueApis) {
            const apiStatus = await checkApiEndpointInAPIHub(apiName);
            if (apiStatus && !apiStatus.isValid) {
                apiErrors.push(apiStatus.message);
            }
        }
    }

    const repoAndApiErrors = [...repoErrors.map(e => e.message), ...apiErrors];

    return {
        hasAbap: containsAbap,
        isInvalid: repoAndApiErrors.length > 0,
        invalidObjects,
        internalFeedback: buildFeedbackMessage({ repoErrors, apiErrors })
    };
}

function buildFeedbackMessage({ repoErrors, apiErrors }) {
    const sections = [];

    const deprecated    = repoErrors.filter(e => e.type === 'deprecated');
    const classicApi    = repoErrors.filter(e => e.type === 'classic_api');
    const notReleased   = repoErrors.filter(e => e.type === 'not_to_be_released');
    const invalid       = repoErrors.filter(e => e.type === 'invalid');

    if (deprecated.length > 0) {
        sections.push('### Deprecated Objects (Must Replace with Successor)\n' + deprecated.map(e => `- ${e.message}`).join('\n'));
    }
    if (classicApi.length > 0) {
        sections.push('### Classic API Objects (Tier 2 Only — Not Allowed in ABAP Cloud)\n' + classicApi.map(e => `- ${e.message}`).join('\n'));
    }
    if (notReleased.length > 0) {
        sections.push('### Not To Be Released Objects (Blocked — Must Find Tier 1 Alternative)\n' + notReleased.map(e => `- ${e.message}`).join('\n'));
    }
    if (invalid.length > 0) {
        sections.push('### Invalid Objects (Not Found in SAP Cloud Repository or API Hub)\n' + invalid.map(e => `- ${e.message}`).join('\n'));
    }
    if (apiErrors.length > 0) {
        sections.push('### API Endpoint Errors\n' + apiErrors.map(e => `- ${e}`).join('\n'));
    }

    return sections.join('\n\n');
}

function buildRetryPrompt(originalPrompt, generatedText, feedback, invalidObjects, attempt) {
    const toReplace      = invalidObjects.filter(obj => obj.successor);
    const classicOrNTBR  = invalidObjects.filter(obj => !obj.successor && (obj.reason === 'classic_api' || obj.reason === 'not_to_be_released'));
    const notFound       = invalidObjects.filter(obj => !obj.successor && obj.reason === 'not_found');

    const replacementLines = toReplace.map(
        obj => `- Replace '${obj.name}' with its official SAP Cloud Tier 1 successor: '${obj.successor}'`
    );
    const classicLines = classicOrNTBR.map(
        obj => `- '${obj.name}' is ${obj.reason === 'not_to_be_released' ? 'Not To Be Released' : 'a Classic API (Tier 2 only)'}. Replace it with an officially released Tier 1 SAP Cloud object.`
    );
    const notFoundLines = notFound.map(
        obj => `- '${obj.name}' does not exist in SAP Cloud. Remove it and use only officially released SAP Cloud objects.`
    );

    return [
        `Your previously generated code failed internal validation (attempt ${attempt} of ${MAX_RETRIES}).`,
        'CRITICAL INSTRUCTION: Do NOT simply delete the code or remove the functionality to fix these errors. You MUST replace invalid objects with their proper ABAP Cloud Tier 1 equivalents (e.g., replacing GUI classes with appropriate HTTP/Fiori logic).',
        'Return ONLY the corrected ABAP code wrapped in ```abap blocks.',
        '',
        '### Errors to Fix',
        feedback,
        replacementLines.length > 0  ? '\n### Required Replacements (Deprecated → Successor)\n' + replacementLines.join('\n') : '',
        classicLines.length > 0      ? '\n### Classic API / Not To Be Released — Must Use Tier 1 Alternatives\n' + classicLines.join('\n') : '',
        notFoundLines.length > 0     ? '\n### Objects Not Found — Remove or Replace\n' + notFoundLines.join('\n') : '',
        '\n### Original Request\n' + originalPrompt
    ].filter(Boolean).join('\n');
}

function buildFinalReport(generatedText, feedback) {
    return [
        generatedText,
        '',
        '---',
        '### ⚠️ Validation Report (All Retry Attempts Exhausted)',
        '',
        feedback
    ].join('\n');
}

// ─── MIGRATED: @google-cloud/vertexai → @google/genai ────────────────────────
// The old VertexAI SDK is deprecated as of June 24 2025 and will be removed
// June 24 2026. We now use the unified Google Gen AI SDK instead.
async function getGoogleGenAIModel(systemInstruction) {
    const { GoogleGenAI } = require('@google/genai');
    const dest = await getDestination({ destinationName: 'geminivertex_api' });
    const { project_id, client_email, private_key } = dest.originalProperties;

    // The new SDK accepts a googleAuth credentials object for Vertex AI backend
    const ai = new GoogleGenAI({
        vertexai: true,
        project: project_id,
        location: 'us-central1',
        googleAuthOptions: {
            credentials: {
                client_email,
                private_key: private_key.replace(/\\n/g, '\n')
            }
        }
    });

    return ai.models;   // returns the Models interface; callers use .generateContent / .generateContentStream
}

function formatHistoryForGemini(history) {
    return history.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
    }));
}

async function callGemini(prompt, systemInstruction, history = []) {
    const start = Date.now();
    try {
        const models = await getGoogleGenAIModel(systemInstruction);
        const contents = [
            ...formatHistoryForGemini(history),
            { role: 'user', parts: [{ text: prompt }] }
        ];
        const result = await models.generateContent({
            model: 'gemini-2.5-flash',
            systemInstruction: { parts: [{ text: systemInstruction }] },
            contents
        });
        return {
            modelId: 'gemini',
            content: result.candidates[0].content.parts[0].text,
            latency: Date.now() - start
        };
    } catch (err) {
        console.error('Gemini callGemini error:', err?.message || err);
        return { modelId: 'gemini', content: 'model is not available at the moment', latency: 0, error: true };
    }
}

async function streamGemini(prompt, systemInstruction, history, onChunk) {
    const models = await getGoogleGenAIModel(systemInstruction);
    const contents = [
        ...formatHistoryForGemini(history),
        { role: 'user', parts: [{ text: prompt }] }
    ];

    const stream = await models.generateContentStream({
        model: 'gemini-2.5-flash',
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents
    });

    let fullResponse = '';
    for await (const chunk of stream) {
        const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text || '';
        fullResponse += text;
        onChunk(text);
    }
    return fullResponse;
}
// ─────────────────────────────────────────────────────────────────────────────

async function callGPT4o(prompt, systemInstruction, history = []) {
    const start = Date.now();
    try {
        const openai = await cds.connect.to('openai');
        // FIX: was 'gpt-5.2' which is not a valid model name — corrected to gpt-4o
        const messages = [{ role: 'system', content: systemInstruction }, ...history, { role: 'user', content: prompt }];
        const response = await openai.send({
            query: 'POST /chat/completions?api-version=2024-02-15-preview',
            data: { model: 'gpt-4o', temperature: 0.5, messages },
            headers: { 'AI-Resource-Group': 'default', 'Content-Type': 'application/json' }
        });
        if (!response?.choices) throw new Error();
        return { modelId: 'gpt4o', content: response.choices[0].message.content, latency: Date.now() - start };
    } catch {
        return { modelId: 'gpt4o', content: 'model is not available at the moment', latency: 0, error: true };
    }
}

async function callSAPGenAIHub(prompt, systemInstruction, history = []) {
    const start = Date.now();
    try {
        const openai = await cds.connect.to('perplexity');
        const messages = [{ role: 'system', content: systemInstruction }, ...history, { role: 'user', content: prompt }];
        const response = await openai.send({
            query: 'POST /chat/completions?api-version=2024-02-15-preview',
            data: { model: 'sonar', max_tokens: 2000, temperature: 0.5, messages },
            headers: { 'AI-Resource-Group': 'default', 'Content-Type': 'application/json' }
        });
        if (!response?.choices) throw new Error();
        return { modelId: 'perplexity', content: response.choices[0].message.content, latency: Date.now() - start };
    } catch {
        return { modelId: 'perplexity', content: 'model is not available at the moment', latency: 0, error: true };
    }
}

// FIX: History sanitisation — Anthropic only accepts 'user' | 'assistant' roles.
// Any stray 'system' messages in history would cause a 400 error and a silent
// catch that returned "model is not available", making Claude appear broken.
function sanitiseHistoryForClaude(history) {
    return history
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: m.content }));
}

async function callClaude(prompt, systemInstruction, history = []) {
    const start = Date.now();
    try {
        const dest = await getDestination({ destinationName: 'claude_api' });
        const apikey = dest.originalProperties.apikey;
        const messages = [...sanitiseHistoryForClaude(history), { role: 'user', content: prompt }];
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'x-api-key': apikey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
            // Aligned max_tokens with streamClaude (was 8000 vs 4000 — now both 8000)
            body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 8000, system: systemInstruction, messages })
        });
        console.log('Claude API response status:', response.status);
        if (!response.ok) {
            const errBody = await response.text();
            console.error('Claude API error body:', errBody);
            throw new Error(`Claude API returned ${response.status}`);
        }
        const data = await response.json();
        return { modelId: 'claude', content: data.content[0].text, latency: Date.now() - start };
    } catch (err) {
        console.error('callClaude error:', err?.message || err);
        return { modelId: 'claude', content: 'model is not available at the moment', latency: 0, error: true };
    }
}

async function streamClaude(prompt, systemInstruction, history, onChunk) {
    const dest = await getDestination({ destinationName: 'claude_api' });
    const apikey = dest.originalProperties.apikey;
    const messages = [...sanitiseHistoryForClaude(history), { role: 'user', content: prompt }];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apikey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', stream: true, max_tokens: 8000, system: systemInstruction, messages })
    });
    console.log('Claude Stream API response status:', response.status);
    if (!response.ok) {
        const errBody = await response.text();
        console.error('Claude Stream API error body:', errBody);
        throw new Error(`Claude stream request failed with status ${response.status}`);
    }

    let fullResponse = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (let line of lines) {
            line = line.trim();
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                try {
                    const data = JSON.parse(line.slice(6));
                    if (data.type === 'content_block_delta' && data.delta?.text) {
                        fullResponse += data.delta.text;
                        onChunk(data.delta.text);
                    }
                } catch { }
            }
        }
    }

    return fullResponse;
}

async function generateWithValidation(modelId, prompt, history) {
    const normalizedModelId = modelId?.toLowerCase() || '';
    let attempt = 0;
    let currentPrompt = prompt;
    let internalHistory = [...history];

    // FIX (PERFORMANCE — Claude): In the validation loop, streaming to a no-op
    // callback meant we paid all the streaming overhead but threw every chunk away.
    // Claude validation passes now use callClaude (non-streaming). The real
    // streaming onChunk is only used when the caller provides one (generateStream).
    const callModel = async (p, h) => {
        if (normalizedModelId === 'gemini') return streamGemini(p, GLOBAL_SYSTEM_INSTRUCTION, h, () => {});
        if (normalizedModelId === 'claude') {
            const res = await callClaude(p, GLOBAL_SYSTEM_INSTRUCTION, h);
            return (res.error || !res.content) ? 'model is not available at the moment' : res.content;
        }
        const res = normalizedModelId === 'gpt4o'
            ? await callGPT4o(p, GLOBAL_SYSTEM_INSTRUCTION, h)
            : await callSAPGenAIHub(p, GLOBAL_SYSTEM_INSTRUCTION, h);
        return (res.error || !res.content) ? 'model is not available at the moment' : res.content;
    };

    while (attempt < MAX_RETRIES) {
        const generatedText = await callModel(currentPrompt, internalHistory);

        if (generatedText === 'model is not available at the moment') {
            return generatedText;
        }

        const validation = await performInternalValidation(generatedText);

        if (!validation.hasAbap) {
            if (attempt < MAX_RETRIES - 1) {
                internalHistory.push({ role: 'user', content: currentPrompt });
                internalHistory.push({ role: 'assistant', content: generatedText });
                currentPrompt = `You did not wrap your code in \`\`\`abap blocks. Please provide the response again, wrapping the code properly.\n\n### Original Request\n${prompt}`;
                attempt++;
                continue;
            } else {
                return buildFinalReport(generatedText, "Failed to generate properly formatted ABAP code after maximum attempts.");
            }
        }

        if (!validation.isInvalid) {
            return generatedText;
        }

        if (attempt < MAX_RETRIES - 1) {
            internalHistory.push({ role: 'user', content: currentPrompt });
            internalHistory.push({ role: 'assistant', content: generatedText });
            currentPrompt = buildRetryPrompt(prompt, generatedText, validation.internalFeedback, validation.invalidObjects, attempt + 1);
            attempt++;
            continue;
        }

        return buildFinalReport(generatedText, validation.internalFeedback.trim());
    }

    return 'model is not available at the moment';
}

module.exports = cds.service.impl(async function () {

    this.before('CREATE', 'ChatSessions', async (req) => {
        const userId = req.data.userId;
        if (!userId) return;
        const sessions = await SELECT.from('sap.aigateway.ChatSessions').where({ userId });
        if (sessions.length >= MAX_CHATS_PER_USER) {
            return req.reject(403, `Maximum of ${MAX_CHATS_PER_USER} chats reached. Please delete an older chat to create a new one.`);
        }
    });

    this.on('register', async (req) => {
        const { username, password } = req.data;

        if (!username.toLowerCase().endsWith('@answerthink.com')) {
            return req.reject(400, 'Registration is restricted to @answerthink.com emails only.');
        }

        const existing = await SELECT.one.from('sap.aigateway.Users').where({ username });
        if (existing?.isVerified) {
            return req.reject(400, 'User already exists and is verified. Please log in.');
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const otpExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();

        if (existing && !existing.isVerified) {
            await UPDATE('sap.aigateway.Users').set({ password, otp, otpExpiry }).where({ username });
        } else {
            await INSERT.into('sap.aigateway.Users').entries({ username, password, otp, otpExpiry, isVerified: false });
        }

        try {
            await sendMail({ destinationName: 'sap_process_automation_mail' }, [{
                to: username,
                subject: 'AnswerThink Enterprise AI Hub - Registration OTP',
                text: `Your one-time password (OTP) is: ${otp}. It is valid for 10 minutes.`
            }]);
            return `An OTP has been sent to ${username}.`;
        } catch {
            return req.error(500, 'Could not send the verification email.');
        }
    });

    this.on('verifyOTP', async (req) => {
        const { username, otp } = req.data;
        const user = await SELECT.one.from('sap.aigateway.Users').where({ username, otp });

        if (!user) return req.reject(400, 'Invalid OTP.');
        if (new Date(user.otpExpiry) < new Date()) return req.reject(400, 'OTP has expired. Please register again.');

        await UPDATE('sap.aigateway.Users')
            .set({ isVerified: true, otp: null, otpExpiry: null })
            .where({ username });

        return user.ID;
    });

    this.on('login', async (req) => {
        const { username, password } = req.data;

        if (!username.toLowerCase().endsWith('@answerthink.com')) {
            return req.reject(400, 'Only @answerthink.com emails are allowed.');
        }

        const user = await SELECT.one.from('sap.aigateway.Users').where({ username, password });
        if (!user) return req.reject(401, 'Invalid credentials or Register your User.');
        if (!user.isVerified) return req.reject(403, 'Email not verified. Please register to generate a new OTP.');

        return user.ID;
    });

    this.on('submitRating', async (req) => {
        const { userId, modelId, category, rating } = req.data;
        await INSERT.into('sap.aigateway.Ratings').entries({ userId, modelId, category, rating });
        return 'Success';
    });

    this.on('validateABAPCode', async (req) => {
        const { code } = req.data;
        const issues = await validateAbapSyntax(code);
        return issues.length > 0 ? issues : ['No high-risk syntax issues found.'];
    });

    this.on('generateMultiModelResponse', async (req) => {
        const { prompt } = req.data;
        const results = await Promise.allSettled([
            callGemini(prompt, GLOBAL_SYSTEM_INSTRUCTION),
            callGPT4o(prompt, GLOBAL_SYSTEM_INSTRUCTION),
            callSAPGenAIHub(prompt, GLOBAL_SYSTEM_INSTRUCTION),
            callClaude(prompt, GLOBAL_SYSTEM_INSTRUCTION)
        ]);

        const modelIds = ['gemini', 'gpt4o', 'perplexity', 'claude'];
        return results.map((result, index) => {
            if (result.status === 'fulfilled' && !result.value.error && result.value.content) {
                return result.value;
            }
            return { modelId: modelIds[index], content: 'model is not available at the moment', latency: 0, error: true };
        });
    });

    this.generateStreamNoSession = async function (modelId, prompt, onChunk) {
        try {
            const finalOutput = await generateWithValidation(modelId, prompt, []);
            onChunk(finalOutput);
        } catch (error) {
            onChunk(`model is not available at the moment. Error: ${error.message || error}`);
        }
    };

    this.generateStream = async function (sessionId, modelId, prompt, onChunk) {
        const userMessages = await SELECT.from('sap.aigateway.ChatMessages').where({ session_ID: sessionId, role: 'user' });
        if (userMessages.length >= MAX_PROMPTS_PER_SESSION) {
            throw new Error(`Maximum prompt limit (${MAX_PROMPTS_PER_SESSION}) reached for this chat. Please start a new chat.`);
        }

        const messagesData = await SELECT.from('sap.aigateway.ChatMessages')
            .where({ session_ID: sessionId })
            .orderBy('createdAt asc');

        const dbHistory = messagesData.map(m => ({ role: m.role, content: m.content }));
        const latencyStart = Date.now();

        try {
            const finalOutput = await generateWithValidation(modelId, prompt, dbHistory);

            await INSERT.into('sap.aigateway.ChatMessages').entries({ session_ID: sessionId, role: 'user', content: prompt, modelId });
            await INSERT.into('sap.aigateway.ChatMessages').entries({
                session_ID: sessionId,
                role: 'assistant',
                content: finalOutput,
                modelId,
                latency: Date.now() - latencyStart
            });

            onChunk(finalOutput);
        } catch {
            const errorMsg = 'model is not available at the moment';
            onChunk(errorMsg);
            await INSERT.into('sap.aigateway.ChatMessages').entries({ session_ID: sessionId, role: 'user', content: prompt, modelId });
            await INSERT.into('sap.aigateway.ChatMessages').entries({
                session_ID: sessionId,
                role: 'assistant',
                content: errorMsg,
                modelId,
                latency: Date.now() - latencyStart
            });
        }
    };
});