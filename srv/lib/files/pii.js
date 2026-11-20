'use strict';
const { MAX_PII_ITEMS } = require('../utils/constants');

// ── Detectors ─────────────────────────────────────────────────────────────────
// Prose documents (PDF/DOCX) keep the original, permissive patterns.
//
// Spreadsheets ("tabular") need stricter ones: they are full of 10-digit PO /
// material / document numbers and 13-16 digit IDs that the permissive phone and
// card patterns would flag — and unchecked PII is redacted by default, which
// would silently destroy the very data the user attached. So for tabular input:
//   - phone numbers must contain a separator, parentheses or a '+' prefix
//   - card numbers must pass the Luhn checksum
const RE_EMAIL        = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const RE_PHONE        = /\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const RE_CARD         = /\b(?:\d[ -]?){13,16}\b/g;
const RE_PHONE_STRICT = /(?<![\w+])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)[\s.-]?|\d{3}[\s.-])\d{3}[\s.-]\d{4}\b|(?<![\w+])\+\d{1,3}[\s.-]?\d{4,5}[\s.-]?\d{4,6}\b/g;

function luhnValid(raw) {
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) return false;
    let sum = 0;
    let dbl = false;
    for (let i = digits.length - 1; i >= 0; i--) {
        let d = digits.charCodeAt(i) - 48;
        if (dbl) { d *= 2; if (d > 9) d -= 9; }
        sum += d;
        dbl = !dbl;
    }
    return sum % 10 === 0;
}

function detectors(tabular) {
    return [
        { type: 'Email', re: RE_EMAIL,                         accept: () => true },
        { type: 'Phone', re: tabular ? RE_PHONE_STRICT : RE_PHONE, accept: () => true },
        { type: 'Card',  re: RE_CARD,                          accept: tabular ? luhnValid : () => true }
    ];
}

/** Unique PII values in `text`, in detection order: [{ type, value }]. */
function extractPII(text, { tabular = false } = {}) {
    const found = new Map();
    for (const { type, re, accept } of detectors(tabular)) {
        for (const m of text.match(re) || []) {
            if (!found.has(m) && accept(m)) found.set(m, type);
        }
    }
    return Array.from(found, ([value, type]) => ({ type, value }));
}

/** Replace every occurrence of the given PII values in a single pass per detector. */
function redactValues(text, values, { tabular = false } = {}) {
    if (values.size === 0) return text;
    let out = text;
    for (const { type, re } of detectors(tabular)) {
        out = out.replace(re, m => (values.has(m) ? `[REDACTED_${type.toUpperCase()}]` : m));
    }
    return out;
}

/**
 * Detect PII and cap how many items are surfaced to the user for review.
 * Items beyond the cap are redacted here, server-side, so a large spreadsheet
 * can never leak the long tail unreviewed.
 *
 * @returns {{ text: string, piiList: Array<{type,value}>, piiOverflow: number }}
 */
function scanPII(text, { tabular = false } = {}) {
    const all = extractPII(text, { tabular });
    if (all.length <= MAX_PII_ITEMS) return { text, piiList: all, piiOverflow: 0 };

    const listed   = all.slice(0, MAX_PII_ITEMS);
    const overflow = new Set(all.slice(MAX_PII_ITEMS).map(p => p.value));
    return {
        text:        redactValues(text, overflow, { tabular }),
        piiList:     listed,
        piiOverflow: overflow.size
    };
}

module.exports = { extractPII, scanPII, luhnValid };
