'use strict';
const { Readable } = require('stream');
const ExcelJS = require('exceljs');
const { AppError } = require('../utils/errors');
const { MAX_EXTRACTED_CHARS, SPREADSHEET_LIMITS } = require('../utils/constants');

const NO_DATA_MESSAGE = 'No data found in this spreadsheet. It is empty, or every sheet in it is hidden.';

const { MAX_SHEETS, MAX_ROWS_PER_SHEET, MAX_COLS, MAX_CELL_CHARS } = SPREADSHEET_LIMITS;

// ── Cell formatting ───────────────────────────────────────────────────────────
const pad2 = n => String(n).padStart(2, '0');

function formatDate(d) {
    if (Number.isNaN(d.getTime())) return '';
    const time = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
    // Excel time-only cells are stored against the 1899-12-30 epoch.
    if (d.getUTCFullYear() < 1900) return time;
    const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    return time === '00:00:00' ? date : `${date} ${time}`;
}

/** Turn any ExcelJS cell value (string, number, Date, formula, rich text…) into plain text. */
function cellToString(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return formatDate(v);
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'object') {
        if ('result' in v)                                  return cellToString(v.result); // formula
        if ('formula' in v || 'sharedFormula' in v)         return '';                      // formula, no cached value
        if (Array.isArray(v.richText))                      return v.richText.map(r => r.text).join('');
        if ('text' in v)                                    return cellToString(v.text);    // hyperlink
        if ('error' in v)                                   return String(v.error);
    }
    return '';
}

/** Single-line, pipe-safe, length-capped cell text for a Markdown table. */
function sanitiseCell(v) {
    const s = cellToString(v).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
    return s.length > MAX_CELL_CHARS ? `${s.slice(0, MAX_CELL_CHARS)}…` : s;
}

function columnLetter(index) { // 0 → A, 25 → Z, 26 → AA
    let n = index + 1;
    let s = '';
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
}

function toMarkdownTable(rows) {
    const width = Math.min(MAX_COLS, rows.reduce((w, r) => Math.max(w, r.length), 0));
    // Columns with no value in any row (common in ATC / SAP exports) only cost tokens.
    const body = rows.length > 1 ? rows.slice(1) : rows;
    const keep = Array.from({ length: width }, (_, i) => i).filter(i => body.some(r => r[i]));
    const line = (r, fill) => `|${keep.map(i => r[i] || (fill ? fill(i) : '')).join('|')}|`;   // no padding spaces: ~2 chars saved per cell
    const out  = [
        line(rows[0], columnLetter),
        `|${keep.map(() => '---').join('|')}|`,
        ...rows.slice(1).map(r => line(r))
    ];
    return { markdown: out.join('\n'), columns: keep.length };
}

// ── XLSX ──────────────────────────────────────────────────────────────────────
/**
 * Stream-read an .xlsx workbook into Markdown tables, one section per sheet.
 * Streaming + hard row/sheet/character limits keep memory bounded no matter how
 * large (or how maliciously crafted) the workbook is.
 *
 * @returns {Promise<{ text: string, meta: object }>}
 */
async function extractXlsx(buffer, fileName) {
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from([buffer]), {
        worksheets: 'emit', sharedStrings: 'cache', hyperlinks: 'ignore', styles: 'cache', entries: 'ignore'   // styles are needed to tell dates from plain numbers
    });

    const sections = [`Spreadsheet: ${fileName}`];
    const sheets   = [];
    let used         = sections[0].length;
    let truncated    = false;
    let hiddenSheets = 0;
    let sheetCount   = 0;

    for await (const ws of reader) {
        if (ws.state && ws.state !== 'visible') { hiddenSheets++; continue; }   // hidden sheets are not sent to the model
        if (truncated || sheetCount >= MAX_SHEETS) { truncated = true; continue; } // must keep draining the stream

        sheetCount++;
        const rows = [];
        let sheetTruncated = false;

        for await (const row of ws) {
            if (rows.length > MAX_ROWS_PER_SHEET || used > MAX_EXTRACTED_CHARS) { sheetTruncated = true; break; } // +1: the header row
            const cells = (row.values || []).slice(1, MAX_COLS + 1).map(sanitiseCell); // values[] is 1-indexed
            while (cells.length && !cells[cells.length - 1]) cells.pop();                // trim trailing empties
            if (cells.length === 0) continue;                                            // skip blank rows
            rows.push(cells);
            used += cells.reduce((n, c) => n + c.length + 1, 0);
        }

        if (rows.length === 0) { sheets.push({ name: ws.name, rows: 0, columns: 0, truncated: false }); continue; }

        const { markdown, columns } = toMarkdownTable(rows);
        const suffix = sheetTruncated ? ' — truncated, more rows exist' : '';
        sections.push(`## Sheet: ${ws.name} (${rows.length - 1} data rows${suffix})\n${markdown}`);
        sheets.push({ name: ws.name, rows: rows.length - 1, columns, truncated: sheetTruncated });
        if (sheetTruncated) truncated = true;
    }

    if (!sheets.some(sh => sh.columns > 0)) throw new AppError(422, NO_DATA_MESSAGE);
    return { text: sections.join('\n\n'), meta: { sheets, hiddenSheets, truncated } };
}

// ── CSV ───────────────────────────────────────────────────────────────────────
function decodeCsv(buffer) {
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer.subarray(2));
    if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer.subarray(2));
    const start = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0;
    return new TextDecoder('utf-8').decode(buffer.subarray(start));
}

/**
 * CSV is already text, so it is passed through as-is (delimiter style varies by
 * locale — comma, semicolon, tab — and the model handles all of them) with the
 * same row/character limits as spreadsheets.
 */
function extractCsv(buffer, fileName) {
    const lines = decodeCsv(buffer).replace(/\r\n?/g, '\n').split('\n');
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();

    const kept = [];
    let used = 0;
    let truncated = false;
    for (const line of lines) {
        if (kept.length > MAX_ROWS_PER_SHEET || used > MAX_EXTRACTED_CHARS) { truncated = true; break; } // +1 row for the header
        kept.push(line);
        used += line.length + 1;
    }

    if (kept.length === 0) throw new AppError(422, NO_DATA_MESSAGE);
    const rows = Math.max(0, kept.length - 1);
    const note = truncated ? ' — truncated, more rows exist' : '';
    return {
        text: `Spreadsheet: ${fileName}\n\n## CSV data (${rows} data rows${note})\n${kept.join('\n')}`,
        meta: { sheets: [{ name: 'CSV', rows, columns: 0, truncated }], hiddenSheets: 0, truncated }
    };
}

module.exports = { extractXlsx, extractCsv, cellToString };
