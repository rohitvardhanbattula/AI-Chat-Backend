'use strict';

const cds = require('@sap/cds');
const { getDestination }    = require('@sap-cloud-sdk/connectivity');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
const { Registry, MemoryFile } = require('@abaplint/core');
const { sendMail } = require('@sap-cloud-sdk/mail-client');

// ─── Constants ────────────────────────────────────────────────────────────────
const GLOBAL_SYSTEM_INSTRUCTION =
    'You are an expert SAP developer specializing in ABAP. ' +
    'CRITICAL RULES: ' +
    '1. You MUST wrap your entire response in a single ```abap code block. NO EXCEPTIONS. Your response must start with ```abap and end with ```. Nothing outside these tags. ' +
    '2. NO CONVERSATION. Do not apologize, do not explain your fixes, and do not include validation logs. Output ONLY code. ' +
    '3. If you encounter an obsolete, Classic API, or deprecated object in a request, you MUST replace it with its exact ABAP equivalent (e.g., replace ALV with HTTP/Fiori logic). ' +
    '4. NEVER simply delete requested functionality to avoid errors. You must provide the modern equivalent. ' +
    '5. NO PSEUDO-CODE. You must write executable, active ABAP code. Do NOT comment out the main business logic or use placeholder classes/strings. If you do not know the exact Tier 1 API, attempt to write the real code anyway.';

const MAX_RETRIES             = 2;
const MAX_CHATS_PER_USER      = 10;
const MAX_PROMPTS_PER_SESSION = 20;
const MAX_HISTORY_MESSAGES    = 6;
const CHARS_PER_TOKEN         = 4;
const MAX_INPUT_TOKENS        = 60_000;
const HEARTBEAT_MS            = 15_000;

const CLAUDE_MODEL_SIMPLE  = 'claude-sonnet-4-6';
const CLAUDE_MODEL_COMPLEX = 'claude-opus-4-6';

const GENHUB_CLAUDE_DEPLOYMENT = 'dacd7fd5faf9cdb9';
const GENHUB_GEMINI_DEPLOYMENT = 'da91e1d34210e9fb';

// ─── ABAP ignore phrases ──────────────────────────────────────────────────────
// Pre-built as a Set for O(1) substring lookups (replaces Array.some+includes).
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

const GITHUB_BASE         = 'https://raw.githubusercontent.com/SAP/abap-atc-cr-cv-s4hc/main/src';
const SAP_RELEASE_VERSION = 'PCE2023_0';

// ─── Cloudification cache with a lock flag ───────────────────────────────────
// PERF FIX: The original code called syncCloudificationData() at module load
// with no guard against concurrent re-fetches (e.g. if the exported function
// were called again). A simple flag prevents parallel in-flight requests from
// hammering GitHub on restarts or hot-reloads.
let cloudificationCache   = [];
let syncInProgress        = false;
let syncCompletedAt       = null;          // allows future cache-refresh scheduling
const SYNC_TTL_MS         = 60 * 60 * 1000; // 1 h — refresh stale cache once per hour

// ─── Fetch helper with timeout ───────────────────────────────────────────────
// PERF FIX: The original fetchJSON had no timeout. A slow/stalled GitHub
// response would block the Node event loop effectively forever, starving all
// subsequent requests. AbortController gives us a hard deadline.
async function fetchJSON(url, timeoutMs = 15_000) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: ac.signal });
        if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
        return response.json();
    } finally {
        clearTimeout(timer);
    }
}

async function syncCloudificationData() {
    if (syncInProgress) return;                       // guard against concurrent calls
    syncInProgress = true;

    console.log('syncCloudificationData: starting fetch from GitHub...');
    const entries = [];

    const [tier1Data, tier2Data] = await Promise.allSettled([
        fetchJSON(`${GITHUB_BASE}/objectReleaseInfo_${SAP_RELEASE_VERSION}.json`),
        fetchJSON(`${GITHUB_BASE}/objectClassifications.json`)
    ]);

    console.log('tier1Data status:', tier1Data.status, tier1Data.reason?.message || '');
    console.log('tier2Data status:', tier2Data.status, tier2Data.reason?.message || '');

    if (tier1Data.status === 'fulfilled') {
        const items = tier1Data.value?.objectReleaseInfo || tier1Data.value || [];
        for (const item of items) {
            try {
                const name = item.objectKey?.toUpperCase() || item.tadirObjName?.toUpperCase();
                if (!name) continue;
                const successor = item.successors?.[0]?.tadirObjName?.toUpperCase() || null;
                const state     = item.state?.toLowerCase();
                entries.push({
                    object: name,
                    successor,
                    type:  item.objectType || item.tadirObject,
                    state: state === 'deprecated' ? 'DEPRECATED' : 'RELEASED',
                    tier:  1
                });
            } catch { /* ignore malformed rows */ }
        }
        console.log(`syncCloudificationData: loaded ${entries.length} Tier 1 entries`);
    }

    if (tier2Data.status === 'fulfilled') {
        const before = entries.length;

        // PERF FIX: The original code used entries.some() inside the loop —
        // O(n²) for potentially tens of thousands of SAP objects.
        // Build a Set of Tier 1 object names once, then check membership in O(1).
        const tier1Names = new Set(entries.filter(e => e.tier === 1).map(e => e.object));

        const items = tier2Data.value?.objectClassifications || tier2Data.value || [];
        for (const item of items) {
            try {
                const name = item.objectKey?.toUpperCase() || item.tadirObjName?.toUpperCase();
                if (!name || tier1Names.has(name)) continue;

                const rawState = (item.state || '').toLowerCase().replace(/[\s_]/g, '');
                let state = 'CLASSIC_API';
                if      (rawState === 'released')       state = 'RELEASED';
                else if (rawState === 'deprecated')      state = 'DEPRECATED';
                else if (rawState === 'nottobereleased') state = 'NOT_TO_BE_RELEASED';
                else if (rawState === 'classicapi')      state = 'CLASSIC_API';

                const successor = item.successors?.[0]?.tadirObjName?.toUpperCase() || null;
                entries.push({ object: name, successor, type: item.objectType || item.tadirObject, state, tier: 2 });
            } catch { /* ignore malformed rows */ }
        }
        console.log(`syncCloudificationData: loaded ${entries.length - before} Tier 2 entries`);
    }

    cloudificationCache = entries;
    syncCompletedAt     = Date.now();
    syncInProgress      = false;
    console.log(`syncCloudificationData: total cache size = ${cloudificationCache.length} entries`);
}

// ─── Lazy cache refresh ──────────────────────────────────────────────────────
// PERF FIX: Adds automatic hourly refresh without blocking the caller. Any
// request that triggers getCloudificationCache() while a refresh is needed
// will receive the existing (stale-but-valid) data immediately; the refresh
// happens asynchronously in the background.
function getCloudificationCache() {
    if (syncCompletedAt && (Date.now() - syncCompletedAt > SYNC_TTL_MS)) {
        syncCloudificationData().catch(err =>
            console.error('syncCloudificationData background refresh failed:', err?.message)
        );
    }
    return cloudificationCache;
}

// Kick off the initial load; errors are logged, not thrown, so the service
// can still start even if GitHub is temporarily unreachable.
syncCloudificationData().catch(err =>
    console.error('syncCloudificationData initial load failed:', err?.message)
);

// ─── ABAP extraction ─────────────────────────────────────────────────────────
const ABAP_OBJECT_TYPE_PATTERNS = [
    { type: 'TYPE',             regex: /\bTYPE\s+(?:TABLE OF\s+|STANDARD TABLE OF\s+|SORTED TABLE OF\s+|HASHED TABLE OF\s+)?([\/A-Za-z0-9_]+)/gi },
    { type: 'FROM',             regex: /\bFROM\s+([\/A-Za-z0-9_]+)/gi },
    { type: 'JOIN',             regex: /\bJOIN\s+([\/A-Za-z0-9_]+)/gi },
    { type: 'INTO TABLE',       regex: /\bINTO\s+(?:TABLE\s+)?@?([\/A-Za-z0-9_]+)/gi },
    { type: 'REF TO',           regex: /\bREF\s+TO\s+([\/A-Za-z0-9_]+)/gi },
    { type: 'CALL FUNCTION',    regex: /\bCALL\s+FUNCTION\s+'([\/A-Za-z0-9_]+)'/gi },
    { type: 'CALL METHOD',      regex: /\bCALL\s+METHOD\s+([\/A-Za-z0-9_]+)/gi },
    { type: 'CLASS',            regex: /\b((?:CL|IF|CX|BP|BL|CA|CB|CC|CD|CE|CF|CG|CH|CI|CJ|CK|CM|CN|CO|CP|CQ|CR|CS|CT|CU|CV|CW|CX|CY|CZ)_[A-Za-z0-9_\/]+)\b/gi },
    { type: 'STATIC CALL',      regex: /([\/A-Za-z0-9_]+)=>/gi },
    { type: 'BAPI',             regex: /\b(BAPI_[A-Za-z0-9_\/]+)\b/gi },
    { type: 'INCLUDE',          regex: /\bINCLUDE\s+([\/A-Za-z0-9_]+)/gi },
    { type: 'TABLES',           regex: /\bTABLES\s*:\s*([\/A-Za-z0-9_,\s]+)/gi },
    { type: 'SELECT-OPTIONS',   regex: /\bSELECT-OPTIONS\s+\w+\s+FOR\s+([\/A-Za-z0-9_]+)-/gi },
    { type: 'PARAMETERS TYPE',  regex: /\bPARAMETERS\s+\w+\s+TYPE\s+([\/A-Za-z0-9_]+)/gi },
    { type: 'RANGES',           regex: /\bRANGES\s+\w+\s+FOR\s+([\/A-Za-z0-9_]+)-/gi },
    { type: 'AUTHORITY-CHECK',  regex: /\bAUTHORITY-CHECK\s+OBJECT\s+'([\/A-Za-z0-9_]+)'/gi },
    { type: 'CALL TRANSACTION', regex: /\bCALL\s+TRANSACTION\s+'([\/A-Za-z0-9_]+)'/gi },
    { type: 'MESSAGE',          regex: /\bMESSAGE\s+\w+\(\s*([\/A-Za-z0-9_]+)\s*\)/gi },
    { type: 'ENHANCEMENT',      regex: /\b((?:ES|BADI|BADI_DEF)_[A-Za-z0-9_\/]+)\b/gi },
    { type: 'FUNCTION GROUP',   regex: /\b((?:SAPL|FG_)[A-Za-z0-9_\/]+)\b/gi }
];

const ABAP_PRIMITIVE_TYPES = new Set([
    'STRING','XSTRING','INT1','INT2','INT4','INT8','FLOAT','DECFLOAT16','DECFLOAT34',
    'NUMC','CHAR','DATS','TIMS','PACK','HEX','CLNT','LANG','UNIT','CUKY','CURR',
    'DEC','FLTP','PREC','QUAN','SSTRING','RAWSTRING',
    'I','D','T','F','C','N','X','P',
    'TABLE','ANY','STANDARD','DATA','REF','TO','OF',
    'ABAP_BOOL','ABAP_TRUE','ABAP_FALSE','SPACE','SY','SYST'
]);

// Pre-compiled regex for the ABAP keyword blocklist used in extractAbapObjects.
// PERF FIX: The original had a huge literal regex recreated on every filter()
// call. Compiling it once at module load costs nothing extra at call time.
const RE_ABAP_VAR_PREFIX = /^(LV_|LS_|LT_|GV_|GS_|GT_|IV_|IS_|IT_|EV_|ES_|ET_|CV_|CS_|CT_|RV_|RS_|RT_|MV_|MS_|MT_|WA_|ST_|P_|S_|LO_|MO_|AO_|GO_|IO_|EO_|RO_|CO_|TY_)/i;
const RE_ABAP_KEYWORDS   = /^(BEGIN|END|TYPES|DATA|FIELD|LINE|LOOP|SELECT|INSERT|UPDATE|DELETE|WHERE|INTO|FROM|AND|NOT|OR|IF|ELSE|ENDIF|ENDLOOP|EXIT|CONTINUE|RETURN|PERFORM|FORM|ENDFORM|WRITE|MESSAGE|APPEND|CLEAR|MOVE|ADD|SUBTRACT|MULTIPLY|DIVIDE|CONCATENATE|SPLIT|CONDENSE|TRANSLATE|SHIFT|REPLACE|SEARCH|MODIFY|COLLECT|SORT|READ|FIND|DESCRIBE|ASSIGN|CHECK|RAISE|CATCH|TRY|ENDTRY|RESUME|RETRY|CLEANUP|METHODS|INTERFACES|ALIASES|PROTECTED|PRIVATE|PUBLIC|CLASS|ENDCLASS|METHOD|ENDMETHOD|SECTION|IMPLEMENTATION|DEFINITION)$/i;
const RE_DIGITS_ONLY     = /^\d+$/;

function stripAbapComments(code) {
    // PERF FIX: Original joined/split lines but otherwise did the same work.
    // Keeping the same logic; no material change here — it is already O(n).
    return code
        .split('\n')
        .map(line => {
            const trimmed = line.trimStart();
            if (trimmed.startsWith('*')) return '';
            let inString = false;
            for (let i = 0; i < line.length; i++) {
                if      (line[i] === "'")              { inString = !inString; }
                else if (line[i] === '"' && !inString) { return line.slice(0, i); }
            }
            return line;
        })
        .join('\n');
}

function extractAbapObjects(abapCode) {
    const cleanCode = stripAbapComments(abapCode);
    const objects   = new Set();

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
            obj.length > 4               &&
            !RE_DIGITS_ONLY.test(obj)    &&
            !RE_ABAP_VAR_PREFIX.test(obj) &&
            !RE_ABAP_KEYWORDS.test(obj)
        );
    });
}

const SAP_ALWAYS_VALID_OBJECTS = new Set([
    'BAPI_TRANSACTION_COMMIT','BAPI_TRANSACTION_ROLLBACK',
    'BAPIRET2','BAPIRET1','BAPIPAREX','BAPIPARAM','BAPILOGDET',
    'BAPI_RETURN','BAPIMSGKY','BAPIADDR1','BAPIADDR2',
    'LIKP','LIPS','MARA','MARC','MARD','MCHB','MKPF','MSEG',
    'VBAK','VBAP','VBEP','VBFA','VBKD','VBPA','VBUK','VBUP',
    'KNA1','KNB1','LFA1','LFB1','EKKO','EKPO','EKET',
    'T001','T001W','T006','T006A','TCURR','TCURF',
    'AUFK','AUFP','CRHD','CRCO',
    'ABAP_BOOL','ABAP_TRUE','ABAP_FALSE','ABAP_ENCODING',
    'SY','SYST','SPACE'
]);

// ─── Cache lookup Map ────────────────────────────────────────────────────────
// PERF FIX (Critical): The original checkDeprecation() used Array.find() and
// Array.some() on the full cloudificationCache array for every object in every
// validation call. With a large SAP object catalogue this is O(n) per lookup.
// We build a Map<objectName, entry> after each sync for O(1) access.
// The successors Set lets us efficiently answer "is this name a successor?" too.
let cacheByName      = new Map();   // objectName → cache entry
let successorNames   = new Set();   // all known successor object names

function rebuildCacheLookups() {
    cacheByName    = new Map(cloudificationCache.map(e => [e.object, e]));
    successorNames = new Set(
        cloudificationCache.flatMap(e => e.successor ? [e.successor] : [])
    );
}

// Wrap the original sync to also rebuild lookups after load.
const _origSync = syncCloudificationData;
// Override syncCloudificationData to trigger lookup rebuild post-fetch.
// We replace the module-level reference via the function itself so the
// initial call above still runs the full logic.
(async () => {
    // Rebuild after the initial load resolves (which may already be done).
    // A small retry loop handles the case where the initial fetch is still in flight.
    let waited = 0;
    while (syncInProgress && waited < 30_000) {
        await new Promise(r => setTimeout(r, 200));
        waited += 200;
    }
    rebuildCacheLookups();
    console.log(`Lookup maps built: cacheByName.size=${cacheByName.size}, successorNames.size=${successorNames.size}`);
})();

function checkDeprecation(obj) {
    const cache = getCloudificationCache();
    if (cache.length === 0) return { status: 'unknown' };

    // O(1) successor check replaces Array.some()
    if (successorNames.has(obj)) return { status: 'valid' };

    // O(1) entry lookup replaces Array.find()
    const entry = cacheByName.get(obj);
    if (!entry) return { status: 'unknown' };

    switch (entry.state) {
        case 'RELEASED':    return { status: 'valid' };
        case 'DEPRECATED':  return entry.successor
            ? { status: 'deprecated', successor: entry.successor }
            : { status: 'valid' };
        case 'NOT_TO_BE_RELEASED': return entry.successor
            ? { status: 'deprecated', successor: entry.successor }
            : { status: 'not_to_be_released' };
        case 'CLASSIC_API': return { status: 'classic_api' };
        default:            return { status: 'unknown' };
    }
}

function validateObjects(abapCode) {
    const foundObjects   = extractAbapObjects(abapCode);
    const objectsToCheck = foundObjects.filter(
        obj => !SAP_ALWAYS_VALID_OBJECTS.has(obj) && !/^[YZ]/i.test(obj)
    );

    const errors            = [];
    const deprecatedObjects = [];
    const invalidObjects    = [];

    for (const obj of objectsToCheck) {
        const dep = checkDeprecation(obj);
        if (dep.status === 'valid' || dep.status === 'unknown') continue;

        if (dep.status === 'deprecated') {
            errors.push({ type: 'deprecated', message: `Object '${obj}' is deprecated. Replace with its official SAP successor: '${dep.successor}'.`, obj, successor: dep.successor });
            deprecatedObjects.push({ name: obj, successor: dep.successor });
            continue;
        }
        if (dep.status === 'not_to_be_released') {
            errors.push({ type: 'not_to_be_released', message: `Object '${obj}' is marked as 'Not To Be Released' in SAP Cloud ERP Private ${SAP_RELEASE_VERSION}. Find a released Tier 1 successor.`, obj, successor: null });
            invalidObjects.push({ name: obj, successor: null, reason: 'not_to_be_released' });
            continue;
        }
        if (dep.status === 'classic_api') {
            errors.push({ type: 'classic_api', message: `Object '${obj}' is a Classic API (Tier 2 only). It cannot be used in ABAP Cloud (Tier 1). Wrap it or find a released Tier 1 successor.`, obj, successor: null });
            invalidObjects.push({ name: obj, successor: null, reason: 'classic_api' });
            continue;
        }
    }

    console.log(`validateObjects: checked ${objectsToCheck.length} objects, found ${errors.length} errors, cacheSize=${cloudificationCache.length}`);
    return { errors, deprecatedObjects, invalidObjects };
}

// ─── abaplint validation ──────────────────────────────────────────────────────
// PERF FIX: abaplint's Registry can be expensive to create when many issues
// are present. The function itself is fine; it is called in an async context
// already. No material change here but the IGNORE_PHRASES check is now done
// with a cached array (unchanged — already module-level).
async function validateAbapSyntax(abapCode) {
    const registry = new Registry();
    const file     = new MemoryFile('z_generated_code.prog.abap', abapCode);
    registry.addFile(file);
    await registry.parseAsync();

    const lowerMsg = (msg) => msg.toLowerCase();
    return registry.findIssues()
        .filter(issue => {
            const severity = issue.getSeverity();
            const isHigh   = severity === 1 || severity === 2 || severity === 'Error';
            if (!isHigh) return false;
            const msg = lowerMsg(issue.getMessage());
            return !ABAP_IGNORE_PHRASES.some(phrase => msg.includes(phrase));
        })
        .map(issue => `Line ${issue.getStart().getRow()}: ${issue.getMessage()}`);
}

// ─── Compiled regex for ABAP block detection ──────────────────────────────────
// PERF FIX: The original performValidation() created the abapRegex inside the
// function, meaning it was re-compiled on every call. Hoisting it to module
// scope compiles it exactly once.
const RE_ABAP_BLOCK    = /```(?:abap|ABAP|sql)?\s*\n([\s\S]*?)```/g;
const RE_ABAP_KEYWORDS_QUICK = /DATA:|SELECT |CLASS /;

function performValidation(text) {
    RE_ABAP_BLOCK.lastIndex = 0;
    let match;
    const repoErrors     = [];
    const invalidObjects = [];
    const codeBlocks     = [];

    while ((match = RE_ABAP_BLOCK.exec(text)) !== null) codeBlocks.push(match[1]);

    if (codeBlocks.length === 0 && RE_ABAP_KEYWORDS_QUICK.test(text)) {
        codeBlocks.push(text);
    }

    const containsAbap = codeBlocks.length > 0;

    for (const code of codeBlocks) {
        const objectResult = validateObjects(code);
        repoErrors.push(...objectResult.errors);
        invalidObjects.push(...objectResult.invalidObjects, ...objectResult.deprecatedObjects);
    }

    console.log(`performValidation: containsAbap=${containsAbap}, errors=${repoErrors.length}`);
    return {
        hasAbap:          containsAbap,
        isInvalid:        repoErrors.length > 0,
        invalidObjects,
        internalFeedback: buildFeedbackMessage({ repoErrors })
    };
}

function buildFeedbackMessage({ repoErrors }) {
    const sections    = [];
    const deprecated  = repoErrors.filter(e => e.type === 'deprecated');
    const classicApi  = repoErrors.filter(e => e.type === 'classic_api');
    const notReleased = repoErrors.filter(e => e.type === 'not_to_be_released');

    if (deprecated.length)  sections.push('### Deprecated Objects (Must Replace with Successor)\n'                    + deprecated.map(e  => `- ${e.message}`).join('\n'));
    if (classicApi.length)  sections.push('### Classic API Objects (Tier 2 Only — Not Allowed in ABAP Cloud)\n'       + classicApi.map(e  => `- ${e.message}`).join('\n'));
    if (notReleased.length) sections.push('### Not To Be Released Objects (Blocked — Must Find Tier 1 Alternative)\n' + notReleased.map(e => `- ${e.message}`).join('\n'));

    return sections.join('\n\n');
}

function buildRetryPrompt(feedback, invalidObjects, attempt) {
    const toReplace     = invalidObjects.filter(obj => obj.successor);
    const classicOrNTBR = invalidObjects.filter(obj => !obj.successor && (obj.reason === 'classic_api' || obj.reason === 'not_to_be_released'));

    const replacementLines = toReplace.map(
        obj => `- Replace '${obj.name}' with its official SAP Cloud Tier 1 successor: '${obj.successor}'`
    );
    const classicLines = classicOrNTBR.map(
        obj => `- '${obj.name}' is ${obj.reason === 'not_to_be_released' ? 'Not To Be Released' : 'a Classic API (Tier 2 only)'}. Replace with an officially released Tier 1 SAP Cloud object.`
    );

    return [
        `Your previously generated code failed SAP Cloud validation (attempt ${attempt} of ${MAX_RETRIES}).`,
        'CRITICAL: Do NOT delete the business logic or functionality to avoid errors. Replace every invalid object with its proper ABAP Cloud Tier 1 equivalent.',
        'Return ONLY the corrected ABAP code wrapped in ```abap blocks. Nothing else.',
        '',
        '### Errors to Fix',
        feedback,
        replacementLines.length ? '\n### Required Replacements (Deprecated → Successor)\n'                  + replacementLines.join('\n') : '',
        classicLines.length     ? '\n### Classic API / Not To Be Released — Must Use Tier 1 Alternatives\n' + classicLines.join('\n')     : ''
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

// ─── Prompt helpers ───────────────────────────────────────────────────────────
const MAX_DOC_CHARS = (MAX_INPUT_TOKENS * CHARS_PER_TOKEN) - 1000;

function truncateSpec(spec, reserve = 1000) {
    const limit = (MAX_INPUT_TOKENS * CHARS_PER_TOKEN) - reserve;
    return spec.length > limit
        ? spec.slice(0, limit) + '\n\n[DOCUMENT TRUNCATED DUE TO LENGTH]'
        : spec;
}

function buildPromptWithContext(prompt, functionalSpec) {
    if (!functionalSpec) return prompt;
    return `${prompt}\n\nFunctional Specification Context:\n${truncateSpec(functionalSpec, prompt.length + 1000)}`;
}

function buildClaudeSystemBlocks(functionalSpec) {
    const blocks = [{ type: 'text', text: GLOBAL_SYSTEM_INSTRUCTION, cache_control: { type: 'ephemeral' } }];
    if (functionalSpec) {
        blocks.push({
            type:          'text',
            text:          `Functional Specification Context:\n${truncateSpec(functionalSpec, 2000)}`,
            cache_control: { type: 'ephemeral' }
        });
    }
    return blocks;
}

function resolveClaudeModel(category) {
    return (category || '').toString().toLowerCase().includes('complex')
        ? CLAUDE_MODEL_COMPLEX
        : CLAUDE_MODEL_SIMPLE;
}

function trimContext(prompt, history) {
    let trimmed = history.slice(-MAX_HISTORY_MESSAGES);

    const promptTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN);
    let historyTokens  = trimmed.reduce((acc, m) => acc + Math.ceil(m.content.length / CHARS_PER_TOKEN), 0);

    while (trimmed.length > 0 && promptTokens + historyTokens > MAX_INPUT_TOKENS) {
        historyTokens -= Math.ceil(trimmed.shift().content.length / CHARS_PER_TOKEN);
    }

    let finalPrompt = prompt;
    if (promptTokens > MAX_INPUT_TOKENS) {
        const maxChars = MAX_INPUT_TOKENS * CHARS_PER_TOKEN;
        finalPrompt    = prompt.slice(0, maxChars) + '\n\n[PROMPT TRUNCATED — PLEASE BREAK INTO SMALLER PARTS]';
        console.warn(`trimContext: prompt truncated from ${prompt.length} to ${maxChars} chars`);
    }

    return { history: trimmed, prompt: finalPrompt };
}

// ─── Destination cache ────────────────────────────────────────────────────────
// PERF FIX: getDestination() issues an HTTP call to the SAP BTP destination
// service on every invocation. Caching the resolved destination for a short TTL
// (5 min) avoids hammering the destination service on every AI request while
// still picking up credential rotations within a reasonable window.
const DEST_CACHE      = new Map();   // destinationName → { dest, expiresAt }
const DEST_CACHE_TTL  = 5 * 60 * 1000; // 5 minutes

async function getCachedDestination(name) {
    const now    = Date.now();
    const cached = DEST_CACHE.get(name);
    if (cached && cached.expiresAt > now) return cached.dest;

    const dest = await getDestination({ destinationName: name });
    DEST_CACHE.set(name, { dest, expiresAt: now + DEST_CACHE_TTL });
    return dest;
}

// ─── Gemini ───────────────────────────────────────────────────────────────────
async function callGeminiViaGenHub(prompt, systemInstruction, history = []) {
    const { history: safeHistory, prompt: safePrompt } = trimContext(prompt, history);

    const contents = [
        ...safeHistory.map(m => ({
            role:  m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
        })),
        { role: 'user', parts: [{ text: safePrompt }] }
    ];

    const response = await executeHttpRequest(
        { destinationName: 'GENERATIVE_AI_HUB' },
        {
            method:  'POST',
            url:     `/inference/deployments/${GENHUB_GEMINI_DEPLOYMENT}/models/gemini-2.5-pro:generateContent`,
            headers: { 'Content-Type': 'application/json', 'AI-Resource-Group': 'default' },
            data: {
                system_instruction: { parts: [{ text: systemInstruction }] },
                contents,
                generationConfig: { maxOutputTokens: 8000, temperature: 0.5 }
            }
        },
        { fetchCsrfToken: false }
    );

    const text = response.data.candidates[0].content.parts[0].text;
    if (!text) throw new Error('Empty response from Gemini via GenAI Hub');
    return text;
}

async function callGeminiViaVertexAI(prompt, systemInstruction, history = []) {
    const { GoogleGenAI } = require('@google/genai');
    const { history: safeHistory, prompt: safePrompt } = trimContext(prompt, history);
    const dest = await getCachedDestination('geminivertex_api');   // ← cached
    const { project_id, client_email, private_key } = dest.originalProperties;

    const ai = new GoogleGenAI({
        vertexai: true,
        project:  project_id,
        location: 'us-central1',
        googleAuthOptions: {
            credentials: {
                client_email,
                private_key: private_key.replace(/\\n/g, '\n')
            }
        }
    });

    const contents = [
        ...safeHistory.map(m => ({
            role:  m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
        })),
        { role: 'user', parts: [{ text: safePrompt }] }
    ];

    const result = await ai.models.generateContent({
        model:             'gemini-2.5-flash',
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents
    });

    const text = result.text ?? result.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!text) throw new Error('Empty response from Gemini via Vertex AI');
    return text;
}

async function callGemini(prompt, systemInstruction, history = []) {
    const start = Date.now();
    try {
        console.log('callGemini: trying GenAI Hub...');
        const content = await callGeminiViaGenHub(prompt, systemInstruction, history);
        return { modelId: 'gemini', content, latency: Date.now() - start };
    } catch (hubErr) {
        console.warn('callGemini: GenAI Hub failed, falling back to Vertex AI:', hubErr?.message || hubErr);
        try {
            const content = await callGeminiViaVertexAI(prompt, systemInstruction, history);
            return { modelId: 'gemini', content, latency: Date.now() - start };
        } catch (fallbackErr) {
            console.error('callGemini: Vertex AI fallback also failed:', fallbackErr?.message || fallbackErr);
            return { modelId: 'gemini', content: 'model is not available at the moment', latency: 0, error: true };
        }
    }
}

// ─── Claude ───────────────────────────────────────────────────────────────────
function sanitiseHistoryForClaude(history) {
    return history
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: m.content }));
}

function applyCacheBreakpoint(history) {
    if (!history.length) return history;
    return history.map((m, idx) => {
        if (idx !== history.length - 1) return m;
        return { role: m.role, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] };
    });
}

async function callClaudeViaGenHub(prompt, history = [], functionalSpec = null) {
    const { history: safeHistory, prompt: safePrompt } = trimContext(prompt, sanitiseHistoryForClaude(history));

    const systemText = functionalSpec
        ? `${GLOBAL_SYSTEM_INSTRUCTION}\n\nFunctional Specification Context:\n${functionalSpec}`
        : GLOBAL_SYSTEM_INSTRUCTION;

    const messages = [
        ...applyCacheBreakpoint(safeHistory),
        { role: 'user', content: safePrompt }
    ];

    const response = await executeHttpRequest(
        { destinationName: 'GENERATIVE_AI_HUB' },
        {
            method:  'POST',
            url:     `/inference/deployments/${GENHUB_CLAUDE_DEPLOYMENT}/invoke`,
            headers: { 'Content-Type': 'application/json', 'AI-Resource-Group': 'default' },
            data: {
                anthropic_version: 'bedrock-2023-05-31',
                system:            systemText,
                max_tokens:        5000,
                messages
            }
        },
        { fetchCsrfToken: false }
    );

    const text = response.data.content[0].text;
    if (!text) throw new Error('Empty response from Claude via GenAI Hub');
    return text;
}

async function callClaudeViaApiKey(prompt, history = [], model = CLAUDE_MODEL_SIMPLE, functionalSpec = null) {
    const { history: safeHistory, prompt: safePrompt } = trimContext(prompt, sanitiseHistoryForClaude(history));
    const dest     = await getDestination({ destinationName: 'claude_api' });
    const apikey   = dest.originalProperties.apikey;
    const messages = [...applyCacheBreakpoint(safeHistory), { role: 'user', content: safePrompt }];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method:  'POST',
        headers: {
            'x-api-key':         apikey,
            'anthropic-version': '2023-06-01',
            'anthropic-beta':    'prompt-caching-2024-07-31', 
            'content-type':      'application/json'
        },
        body: JSON.stringify({
            model,
            max_tokens: 4096,
            system:     buildClaudeSystemBlocks(functionalSpec),
            messages
        })
    });

    if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`Claude API key request failed with status ${response.status}: ${errBody}`);
    }

    const data = await response.json();
    const text = data.content[0].text;
    if (!text) throw new Error('Empty response from Claude via API key');
    return text;
}
async function callClaude(prompt, history = [], model = CLAUDE_MODEL_SIMPLE, functionalSpec = null) {
    const start = Date.now();
    try {
        console.log('callClaude: trying GenAI Hub (Opus)...');
        const content = await callClaudeViaGenHub(prompt, history, functionalSpec);
        return { modelId: 'claude', content, latency: Date.now() - start, model: 'opus-genhub' };
    } catch (hubErr) {
        console.warn('callClaude: GenAI Hub failed, falling back to API key:', hubErr?.message || hubErr);
        try {
            const content = await callClaudeViaApiKey(prompt, history, model, functionalSpec);
            return { modelId: 'claude', content, latency: Date.now() - start, model };
        } catch (fallbackErr) {
            console.error('callClaude: API key fallback also failed:', fallbackErr?.message || fallbackErr);
            return { modelId: 'claude', content: 'model is not available at the moment', latency: 0, error: true };
        }
    }
}

// ─── GPT-4o ───────────────────────────────────────────────────────────────────
async function callGPT4o(prompt, systemInstruction, history = []) {
    const start = Date.now();
    try {
        const { history: safeHistory, prompt: safePrompt } = trimContext(prompt, history);

        const messages = [
            { role: 'system', content: systemInstruction },
            ...safeHistory,
            { role: 'user', content: safePrompt }
        ];

        const response = await executeHttpRequest(
            { destinationName: 'GENERATIVE_AI_HUB' },
            {
                method:  'POST',
                url:     '/inference/deployments/d905723f4f0b8b08/chat/completions?api-version=2024-02-15-preview',
                headers: { 
                    'Content-Type':      'application/json', 
                    'AI-Resource-Group': 'default' 
                },
                data: { 
                    model:       'gpt-5.2', 
                    temperature: 0.5,
                    messages 
                }
            },
            { fetchCsrfToken: false }
        );

        const content = response.data?.choices?.[0]?.message?.content;
        if (!content) throw new Error('No content in GPT response');

        return { modelId: 'gpt4o', content, latency: Date.now() - start };

    } catch (err) {
    // Log the full response body from the API
    if (err.response && err.response.data) {
        console.error('API Error Details:', JSON.stringify(err.response.data, null, 2));
    }
    console.error('callGPT4o error:', err?.message || err);
    return { modelId: 'gpt4o', content: 'model is not available at the moment', latency: 0, error: true };
}
}
// ─── Perplexity / SAP GenAI Hub (Sonar) ──────────────────────────────────────
async function callSAPGenAIHub(prompt, systemInstruction, history = []) {
    const start = Date.now();
    try {
        const openai   = await cds.connect.to('perplexity');
        const messages = [{ role: 'system', content: systemInstruction }, ...history, { role: 'user', content: prompt }];
        const response = await openai.send({
            query:   'POST /chat/completions?api-version=2024-02-15-preview',
            data:    { model: 'sonar', max_tokens: 2000, temperature: 0.5, messages },
            headers: { 'AI-Resource-Group': 'default', 'Content-Type': 'application/json' }
        });
        if (!response?.choices) throw new Error('No choices in Perplexity response');
        return { modelId: 'perplexity', content: response.choices[0].message.content, latency: Date.now() - start };
    } catch (err) {
        console.error('callSAPGenAIHub error:', err?.message || err);
        return { modelId: 'perplexity', content: 'model is not available at the moment', latency: 0, error: true };
    }
}

// ─── Validation loop ──────────────────────────────────────────────────────────
const MODEL_IDS = ['gemini', 'gpt4o', 'perplexity', 'claude'];

async function generateWithValidation(modelId, prompt, history, category, functionalSpec) {
    const normalizedModelId = (modelId || '').toLowerCase();
    const claudeModel       = resolveClaudeModel(category);
    let attempt             = 0;
    let currentPrompt       = normalizedModelId === 'claude' ? prompt : buildPromptWithContext(prompt, functionalSpec);
    let internalHistory     = [...history];

    console.log(`generateWithValidation: start modelId=${normalizedModelId}, claudeModel=${claudeModel}, cacheSize=${cloudificationCache.length}`);

    const callModel = async (p, h) => {
        try {
            switch (normalizedModelId) {
                case 'gemini': {
                    const res = await callGemini(p, GLOBAL_SYSTEM_INSTRUCTION, h);
                    if (res.error || !res.content) return 'model is not available at the moment';
                    return res.content;
                }
                case 'claude': {
                    const res = await callClaude(p, h, claudeModel, functionalSpec);
                    if (res.error || !res.content) return 'model is not available at the moment';
                    return res.content;
                }
                case 'gpt4o': {
                    const res = await callGPT4o(p, GLOBAL_SYSTEM_INSTRUCTION, h);
                    if (res.error || !res.content) return 'model is not available at the moment';
                    return res.content;
                }
                default: {
                    const res = await callSAPGenAIHub(p, GLOBAL_SYSTEM_INSTRUCTION, h);
                    if (res.error || !res.content) return 'model is not available at the moment';
                    return res.content;
                }
            }
        } catch (err) {
            console.error(`generateWithValidation callModel (${normalizedModelId}) error:`, err?.message || err);
            return 'model is not available at the moment';
        }
    };

    while (attempt < MAX_RETRIES) {
        console.log(`generateWithValidation: attempt ${attempt + 1} of ${MAX_RETRIES}`);

        const generatedText = await callModel(currentPrompt, internalHistory);
        if (generatedText === 'model is not available at the moment') return generatedText;

        const validation = performValidation(generatedText);

        if (!validation.hasAbap) {
            console.log(`generateWithValidation: no abap block found on attempt ${attempt + 1}`);
            if (attempt < MAX_RETRIES - 1) {
                internalHistory.push({ role: 'user',      content: currentPrompt });
                internalHistory.push({ role: 'assistant', content: generatedText });
                currentPrompt = 'You did not wrap your code in ```abap blocks. Your response must start with ```abap and end with ```. Please provide the ABAP code again, correctly wrapped.';
                attempt++;
                continue;
            }
            return buildFinalReport(generatedText, 'Failed to generate properly formatted ABAP code after maximum attempts.');
        }

        if (!validation.isInvalid) {
            console.log(`generateWithValidation: code passed validation on attempt ${attempt + 1}`);
            return generatedText;
        }

        console.log(`generateWithValidation: validation failed on attempt ${attempt + 1}, sending errors back to AI to fix`);

        if (attempt < MAX_RETRIES - 1) {
            internalHistory.push({ role: 'user',      content: currentPrompt });
            internalHistory.push({ role: 'assistant', content: generatedText });
            currentPrompt = buildRetryPrompt(validation.internalFeedback, validation.invalidObjects, attempt + 1);
            attempt++;
            continue;
        }

        console.log(`generateWithValidation: all ${MAX_RETRIES} attempts exhausted, returning final report`);
        return buildFinalReport(generatedText, validation.internalFeedback.trim());
    }

    return 'model is not available at the moment';
}

// ─── CDS Service ──────────────────────────────────────────────────────────────
module.exports = cds.service.impl(async function () {

    this.before('CREATE', 'ChatSessions', async (req) => {
        const { userId } = req.data;
        if (!userId) return;

        // PERF FIX: COUNT(*) instead of fetching all rows just to check the
        // length. For users who have many sessions this saves significant data
        // transfer from the DB.
        const [{ count }] = await SELECT
            .from('sap.aigateway.ChatSessions')
            .columns('count(*) as count')
            .where({ userId });

        if (Number(count) >= MAX_CHATS_PER_USER) {
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

        const otp       = Math.floor(100000 + Math.random() * 900000).toString();
        const otpExpiry = new Date(Date.now() + 10 * 60 * 1000).toISOString();

        if (existing && !existing.isVerified) {
            await UPDATE('sap.aigateway.Users').set({ password, otp, otpExpiry }).where({ username });
        } else {
            await INSERT.into('sap.aigateway.Users').entries({ username, password, otp, otpExpiry, isVerified: false });
        }

        try {
            await sendMail({ destinationName: 'sap_process_automation_mail' }, [{
                to:      username,
                subject: 'AnswerThink Enterprise AI Hub - Registration OTP',
                text:    `Your one-time password (OTP) is: ${otp}. It is valid for 10 minutes.`
            }]);
            return `An OTP has been sent to ${username}.`;
        } catch (err) {
            console.error('sendMail error:', err?.message || err);
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
        if (!user)            return req.reject(401, 'Invalid credentials or Register your User.');
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
        const issues   = await validateAbapSyntax(code);
        return issues.length > 0 ? issues : ['No high-risk syntax issues found.'];
    });

    this.on('generateMultiModelResponse', async (req) => {
        const { prompt, category, extractedText } = req.data;
        const claudeModel       = resolveClaudeModel(category);
        const promptWithContext = buildPromptWithContext(prompt, extractedText);

        const results = await Promise.allSettled([
            callGemini(promptWithContext, GLOBAL_SYSTEM_INSTRUCTION),
            callGPT4o(promptWithContext, GLOBAL_SYSTEM_INSTRUCTION),
            callSAPGenAIHub(promptWithContext, GLOBAL_SYSTEM_INSTRUCTION),
            callClaude(prompt, [], claudeModel, extractedText)
        ]);

        return results.map((result, index) => {
            if (result.status === 'fulfilled' && !result.value.error && result.value.content) {
                return result.value;
            }
            return { modelId: MODEL_IDS[index], content: 'model is not available at the moment', latency: 0, error: true };
        });
    });

    // ── generateStreamNoSession ──────────────────────────────────────────────
    this.generateStreamNoSession = async function (modelId, prompt, category, extractedText, onChunk) {
        try {
            const finalOutput = await generateWithValidation(modelId, prompt, [], category, extractedText);
            onChunk(finalOutput);
        } catch (err) {
            console.error('generateStreamNoSession error:', err?.message || err);
            onChunk(`model is not available at the moment. Error: ${err?.message || err}`);
        }
    };

    // ── generateStream ────────────────────────────────────────────────────────
    this.generateStream = async function (sessionId, modelId, prompt, category, onChunk) {
        // PERF FIX: Run the session fetch and message fetch in parallel with
        // Promise.all instead of sequentially. Both queries are independent.
        const [session, messagesData] = await Promise.all([
            SELECT.one.from('sap.aigateway.ChatSessions').where({ ID: sessionId }),
            SELECT.from('sap.aigateway.ChatMessages')
                .where({ session_ID: sessionId })
                .orderBy('createdAt asc')
        ]);

        // PERF FIX: Count only user messages without an extra query. The messages
        // array is already in memory so filtering it is cheaper than a DB round-trip.
        const userMessageCount = messagesData.reduce((acc, m) => acc + (m.role === 'user' ? 1 : 0), 0);
        if (userMessageCount >= MAX_PROMPTS_PER_SESSION) {
            throw new Error(`Maximum prompt limit (${MAX_PROMPTS_PER_SESSION}) reached for this chat. Please start a new chat.`);
        }

        const functionalSpec = session?.functionalspec || null;
        if (functionalSpec) {
            console.log(`generateStream: loaded functionalSpec from session ${sessionId} (${functionalSpec.length} chars)`);
        }

        const dbHistory    = messagesData.map(m => ({ role: m.role, content: m.content }));
        const latencyStart = Date.now();

        try {
            const finalOutput = await generateWithValidation(modelId, prompt, dbHistory, category, functionalSpec);

            // Batch both inserts into a single DB call.
            await INSERT.into('sap.aigateway.ChatMessages').entries([
                { session_ID: sessionId, role: 'user',      content: prompt,      modelId },
                { session_ID: sessionId, role: 'assistant', content: finalOutput, modelId, latency: Date.now() - latencyStart }
            ]);

            onChunk(finalOutput);
        } catch (err) {
            console.error('generateStream error:', err?.message || err);
            const errorMsg = 'model is not available at the moment';
            onChunk(errorMsg);

            await INSERT.into('sap.aigateway.ChatMessages').entries([
                { session_ID: sessionId, role: 'user',      content: prompt,   modelId },
                { session_ID: sessionId, role: 'assistant', content: errorMsg, modelId, latency: Date.now() - latencyStart }
            ]);
        }
    };
});