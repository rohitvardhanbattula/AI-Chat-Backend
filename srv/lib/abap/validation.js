'use strict';
const { Registry, MemoryFile } = require('@abaplint/core');
const { 
    ABAP_OBJECT_TYPE_PATTERNS, ABAP_PRIMITIVE_TYPES, RE_ABAP_KEYWORDS, 
    RE_ABAP_VAR_PREFIX, ABAP_IGNORE_PHRASES, SAP_ALWAYS_VALID_OBJECTS, RE_DIGITS_ONLY 
} = require('../utils/constants');
const { getCloudificationCache } = require('./cloudification-sync');

function stripAbapComments(code) {
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

function checkDeprecation(obj) {
    const { cloudificationCache, cacheByName, successorNames } = getCloudificationCache();
    if (cloudificationCache.length === 0) return { status: 'unknown' };

    if (successorNames.has(obj)) return { status: 'valid' };

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
            errors.push({ type: 'not_to_be_released', message: `Object '${obj}' is marked as 'Not To Be Released'. Find a released Tier 1 successor.`, obj, successor: null });
            invalidObjects.push({ name: obj, successor: null, reason: 'not_to_be_released' });
            continue;
        }
        if (dep.status === 'classic_api') {
            errors.push({ type: 'classic_api', message: `Object '${obj}' is a Classic API (Tier 2 only). Wrap it or find a released Tier 1 successor.`, obj, successor: null });
            invalidObjects.push({ name: obj, successor: null, reason: 'classic_api' });
            continue;
        }
    }
    return { errors, deprecatedObjects, invalidObjects };
}

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

// Safely defined using RegExp constructor to prevent markdown/template literal issues
const RE_ABAP_BLOCK = new RegExp('```abap\\s*([\\s\\S]*?)```', 'gi');

const RE_ABAP_KEYWORDS_QUICK = /DATA:|SELECT |CLASS /;

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

    return {
        hasAbap:          containsAbap,
        isInvalid:        repoErrors.length > 0,
        invalidObjects,
        internalFeedback: buildFeedbackMessage({ repoErrors })
    };
}

module.exports = { validateObjects, validateAbapSyntax, performValidation };