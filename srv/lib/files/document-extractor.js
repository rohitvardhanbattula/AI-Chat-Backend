'use strict';
const pdfParse = require('pdf-parse');
const mammoth  = require('mammoth');
const { AppError } = require('../utils/errors');
const {
    MAX_EXTRACTED_CHARS, EXTRACT_TIMEOUT_MS, MAX_PDF_PAGES
} = require('../utils/constants');
const { resolveFileKind, unsupportedTypeError, assertContentMatchesKind } = require('./file-types');
const { extractXlsx, extractCsv } = require('./spreadsheet-extractor');
const { scanPII } = require('./pii');

const READ_FAILED_MESSAGE =
    'Could not read this file. It may be corrupted, password-protected or in an unsupported format.';
const EMPTY_MESSAGE =
    'No readable text was found in this file. Scanned or image-only documents are not supported.';

function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new AppError(408, 'Reading the file took too long. Try a smaller file.')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ── Per-format readers: each returns { text, meta } ───────────────────────────
async function readPdf(buffer) {
    const data = await pdfParse(buffer, { max: MAX_PDF_PAGES });
    return { text: data.text, meta: { pages: data.numpages } };
}

async function readDocx(buffer) {
    const { value } = await mammoth.extractRawText({ buffer });
    return { text: value, meta: {} };
}

const READERS = {
    pdf:  (buffer)       => readPdf(buffer),
    docx: (buffer)       => readDocx(buffer),
    xlsx: (buffer, name) => extractXlsx(buffer, name),
    csv:  (buffer, name) => Promise.resolve(extractCsv(buffer, name))
};

function normaliseText(text) {
    return (text || '')
        .replace(/\0/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]+/g, ' ')
        .trim();
}

/** Cut to the character budget on a line boundary so a table row is never split mid-cell. */
function capLength(text) {
    if (text.length <= MAX_EXTRACTED_CHARS) return { text, truncated: false };
    const marker = `\n\n[DOCUMENT TRUNCATED — file is larger than the ${MAX_EXTRACTED_CHARS.toLocaleString('en-US')} character limit]`;
    const budget = MAX_EXTRACTED_CHARS - marker.length;   // keep the marker inside the limit applied downstream
    const cut    = text.lastIndexOf('\n', budget);
    return { text: text.slice(0, cut > 0 ? cut : budget) + marker, truncated: true };
}

/**
 * Turn an uploaded file into model-ready text plus a PII review list.
 *
 * @param {{ buffer: Buffer, originalname: string, mimetype: string }} file  multer memory-storage file
 * @returns {Promise<{ text: string, piiList: Array, piiOverflow: number, meta: object }>}
 * @throws {AppError} with a user-safe message for every expected failure
 */
async function extractDocument(file) {
    const kind = resolveFileKind(file.originalname, file.mimetype);
    if (!kind) throw unsupportedTypeError(file.originalname);
    assertContentMatchesKind(kind, file.buffer);

    const started = Date.now();
    let raw;
    try {
        raw = await withTimeout(READERS[kind](file.buffer, file.originalname), EXTRACT_TIMEOUT_MS);
    } catch (err) {
        if (err instanceof AppError) throw err;
        console.error(`[DocumentExtractor] parse failed | kind=${kind} file="${file.originalname}" error="${err?.message}"`);
        throw new AppError(422, READ_FAILED_MESSAGE);
    }

    const normalised = normaliseText(raw.text);
    if (!normalised) throw new AppError(422, EMPTY_MESSAGE);

    const capped  = capLength(normalised);
    const tabular = kind === 'xlsx' || kind === 'csv';
    const scanned = scanPII(capped.text, { tabular });

    const meta = {
        kind,
        chars: scanned.text.length,
        ...raw.meta,
        truncated: capped.truncated || !!raw.meta?.truncated
    };

    console.log(
        `[DocumentExtractor] ok | kind=${kind} file="${file.originalname}" bytes=${file.buffer.length} ` +
        `chars=${meta.chars} truncated=${meta.truncated} pii=${scanned.piiList.length} ` +
        `piiOverflow=${scanned.piiOverflow} ms=${Date.now() - started}`
    );

    return { text: scanned.text, piiList: scanned.piiList, piiOverflow: scanned.piiOverflow, meta };
}

module.exports = { extractDocument };
