'use strict';
const path = require('path');
const { AppError } = require('../utils/errors');
const { MIME_PDF, MIME_DOCX, MIME_XLSX, CSV_MIME_TYPES } = require('../utils/constants');

const SUPPORTED_MESSAGE = 'Only PDF, DOCX, XLSX and CSV files are allowed.';
const LEGACY_XLS_MESSAGE =
    'Legacy .xls files are not supported. Open the file in Excel, choose "Save As" → ".xlsx" and upload that instead.';

const GENERIC_MIMES = new Set(['', 'application/octet-stream']);

/**
 * Decide what kind of file this is from its name and the browser-reported MIME
 * type. Returns 'pdf' | 'docx' | 'xlsx' | 'csv', or null when unsupported.
 */
function resolveFileKind(originalName, mimeType) {
    const ext  = path.extname(originalName || '').toLowerCase();
    const mime = (mimeType || '').toLowerCase();

    if (mime === MIME_PDF)  return 'pdf';
    if (mime === MIME_DOCX) return 'docx';
    if (mime === MIME_XLSX) return 'xlsx';
    if (ext === '.xlsx' && GENERIC_MIMES.has(mime)) return 'xlsx';
    if (ext === '.csv'  && (CSV_MIME_TYPES.has(mime) || GENERIC_MIMES.has(mime))) return 'csv';
    return null;
}

/** Error to raise for a file that resolveFileKind() rejected. */
function unsupportedTypeError(originalName) {
    const ext = path.extname(originalName || '').toLowerCase();
    return new AppError(415, ext === '.xls' ? LEGACY_XLS_MESSAGE : SUPPORTED_MESSAGE);
}

// ── Content sniffing ──────────────────────────────────────────────────────────
// The MIME type comes from the client and can be anything. Verify the bytes
// actually look like the claimed format before handing them to a parser.
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function assertContentMatchesKind(kind, buffer) {
    const mismatch = () => new AppError(415, 'The file content does not match its file type.');

    if (kind === 'pdf') {
        // The spec allows junk before the header, within the first 1 KB.
        if (!buffer.subarray(0, 1024).includes('%PDF-')) throw mismatch();
        return;
    }
    if (kind === 'docx' || kind === 'xlsx') {
        if (buffer.length < 4 || !buffer.subarray(0, 4).equals(ZIP_MAGIC)) throw mismatch();
        return;
    }
    if (kind === 'csv') {
        // A "CSV" containing NUL bytes is a renamed binary file (UTF-16 is handled
        // by the BOM check in the CSV reader before this matters, so allow it).
        const head = buffer.subarray(0, 8192);
        const isUtf16 = head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff));
        if (!isUtf16 && head.includes(0x00)) throw mismatch();
    }
}

module.exports = { resolveFileKind, unsupportedTypeError, assertContentMatchesKind, SUPPORTED_MESSAGE };
