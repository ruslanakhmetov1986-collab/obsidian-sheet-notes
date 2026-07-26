/**
 * CSV support: parse on load, serialize back as plain CSV.
 *
 * Deliberately NOT the `.sheet` path. A `.csv` file belongs to whatever else
 * reads it (Excel, pandas, another Obsidian plugin), so the rules are:
 *
 *   - the delimiter is detected from the file and preserved on write
 *     (`,` and `;` are the two we recognise; unknown input falls back to `,`)
 *   - quoting follows RFC 4180: `"` doubles inside a quoted field, and a field
 *     is quoted on write only when it has to be (delimiter, quote, CR or LF)
 *   - line endings on write are LF, never CRLF, with a trailing newline
 *   - no styles and no `version` header: CSV has nowhere to put them, so the
 *     formatting toolbar works in memory and is simply not persisted
 *   - a formula typed into the grid is written out as its raw text (`=SUM(A1:A2)`),
 *     because that is the only thing a CSV cell can hold
 *
 * The deterministic-JSON serializer in `format.ts` stays exclusive to
 * `.sheet` / `.lsheet`.
 */

import {
	CURRENT_VERSION,
	DEFAULT_COLS,
	DEFAULT_ROWS,
	FORMAT_ID,
	type SheetDoc,
	cellRef,
	newSheetPage,
	parseRef,
} from "./format";

/** Delimiters we detect. Order matters only for tie-breaking (first wins). */
export const CSV_DELIMITERS = [",", ";"] as const;
export type CsvDelimiter = (typeof CSV_DELIMITERS)[number];
export const DEFAULT_DELIMITER: CsvDelimiter = ",";

/** Rows enough to tell `,` from `;` without scanning a 50 MB export. */
const SNIFF_LINES = 5;

export interface CsvTable {
	delimiter: CsvDelimiter;
	rows: string[][];
}

function isDelimiter(value: unknown): value is CsvDelimiter {
	return value === "," || value === ";";
}

/** Coerce anything into a delimiter we can actually write. */
export function normalizeDelimiter(value: unknown): CsvDelimiter {
	return isDelimiter(value) ? value : DEFAULT_DELIMITER;
}

/**
 * Pick the delimiter by counting candidates OUTSIDE quoted fields over the
 * first few lines. Counting blind would call `a;b,"x;y;z"` a semicolon file.
 */
export function detectDelimiter(text: string): CsvDelimiter {
	const counts: Record<string, number> = { ",": 0, ";": 0 };
	let inQuotes = false;
	let lines = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inQuotes) {
			if (ch === '"') {
				if (text[i + 1] === '"') i++;
				else inQuotes = false;
			}
			continue;
		}
		if (ch === '"') {
			inQuotes = true;
			continue;
		}
		if (ch === "\n") {
			lines++;
			if (lines >= SNIFF_LINES) break;
			continue;
		}
		if (ch !== undefined && ch in counts) counts[ch] = (counts[ch] ?? 0) + 1;
	}
	let best: CsvDelimiter = DEFAULT_DELIMITER;
	let bestCount = -1;
	for (const d of CSV_DELIMITERS) {
		const n = counts[d] ?? 0;
		if (n > bestCount) {
			best = d;
			bestCount = n;
		}
	}
	return bestCount > 0 ? best : DEFAULT_DELIMITER;
}

/** True for a row with nothing in any field. */
function isEmptyRow(row: string[]): boolean {
	return row.every((f) => f === "");
}

/**
 * RFC 4180 parse with the usual real-world tolerances: CRLF or LF or CR,
 * `""` as an escaped quote, a quote that opens only at the start of a field,
 * and trailing blank lines dropped.
 */
export function parseCsvRows(text: string, delimiter: CsvDelimiter): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	let i = 0;

	const endField = () => {
		row.push(field);
		field = "";
	};
	const endRow = () => {
		endField();
		rows.push(row);
		row = [];
	};

	while (i < text.length) {
		const ch = text[i] as string;
		if (inQuotes) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				inQuotes = false;
				i++;
				continue;
			}
			// A newline inside quotes is content, not a row break; CRLF collapses
			// to LF like everywhere else in this plugin.
			if (ch === "\r") {
				field += "\n";
				i += text[i + 1] === "\n" ? 2 : 1;
				continue;
			}
			field += ch;
			i++;
			continue;
		}
		if (ch === '"' && field === "") {
			inQuotes = true;
			i++;
			continue;
		}
		if (ch === delimiter) {
			endField();
			i++;
			continue;
		}
		if (ch === "\r") {
			endRow();
			i += text[i + 1] === "\n" ? 2 : 1;
			continue;
		}
		if (ch === "\n") {
			endRow();
			i++;
			continue;
		}
		field += ch;
		i++;
	}
	if (field !== "" || row.length > 0) endRow();

	// A trailing newline (and any blank tail) must not become phantom rows.
	while (rows.length > 0 && isEmptyRow(rows[rows.length - 1] as string[])) rows.pop();
	return rows;
}

/** Detect the delimiter and parse in one go. */
export function parseCsv(text: string): CsvTable {
	const clean = text.replace(/^﻿/, "");
	const delimiter = detectDelimiter(clean);
	return { delimiter, rows: parseCsvRows(clean, delimiter) };
}

/** Quote a field only when it would otherwise be ambiguous. */
export function quoteCsvField(value: string, delimiter: CsvDelimiter): string {
	if (
		value.includes(delimiter) ||
		value.includes('"') ||
		value.includes("\n") ||
		value.includes("\r")
	) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}

/**
 * Serialize to plain CSV: LF endings, trailing newline, rectangular (every row
 * padded to the width of the widest used row), trailing empty rows and columns
 * dropped so a 100x26 grid with three filled cells is three short lines.
 */
export function serializeCsv(rows: string[][], delimiter: CsvDelimiter = DEFAULT_DELIMITER): string {
	const d = normalizeDelimiter(delimiter);

	let lastRow = -1;
	let width = 0;
	rows.forEach((row, r) => {
		for (let c = 0; c < row.length; c++) {
			if (row[c] !== "" && row[c] !== undefined) {
				lastRow = r;
				if (c + 1 > width) width = c + 1;
			}
		}
	});
	if (lastRow < 0 || width === 0) return "";

	const lines: string[] = [];
	for (let r = 0; r <= lastRow; r++) {
		const row = rows[r] ?? [];
		const cells: string[] = [];
		for (let c = 0; c < width; c++) cells.push(quoteCsvField(row[c] ?? "", d));
		lines.push(cells.join(d));
	}
	return lines.join("\n") + "\n";
}

/* ------------------------------------------------- CSV <-> SheetDoc bridge */

/** Cell text for the grid: a leading `=` makes it a live formula. */
function docCell(raw: string): { v?: string; f?: string } {
	return raw.startsWith("=") ? { f: raw } : { v: raw };
}

/**
 * Parse a CSV file into the same in-memory document the grid renders for
 * `.sheet` files. Values stay strings here; the engine coerces numeric text on
 * the way back out, which keeps `007` and `3.50` byte-identical after a
 * round-trip.
 */
export function csvToDoc(text: string): { doc: SheetDoc; delimiter: CsvDelimiter } {
	const { delimiter, rows } = parseCsv(text);
	const page = newSheetPage("Sheet1");
	let maxCols = 0;

	rows.forEach((row, r) => {
		row.forEach((raw, c) => {
			if (raw === "") return;
			page.cells[cellRef(r, c)] = docCell(raw);
			if (c + 1 > maxCols) maxCols = c + 1;
		});
	});

	// Always leave room to type past the end of the imported data.
	page.rows = Math.max(DEFAULT_ROWS, rows.length);
	page.cols = Math.max(DEFAULT_COLS, maxCols);

	return { doc: { format: FORMAT_ID, version: CURRENT_VERSION, sheets: [page] }, delimiter };
}

function cellText(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
	return String(value);
}

/**
 * Write the first sheet of a document back as CSV. Styles, column widths, row
 * heights and merges are dropped: a CSV file has nowhere to keep them.
 */
export function docToCsv(doc: SheetDoc, delimiter: CsvDelimiter = DEFAULT_DELIMITER): string {
	const page = doc.sheets[0];
	if (!page) return "";
	const rows: string[][] = [];

	for (const [ref, cell] of Object.entries(page.cells)) {
		let coords;
		try {
			coords = parseRef(ref);
		} catch {
			continue;
		}
		const { row, col } = coords;
		// Formula source wins: a CSV cell can only hold the text.
		const text = cell.f !== undefined && cell.f !== "" ? cell.f : cellText(cell.v);
		if (text === "") continue;
		while (rows.length <= row) rows.push([]);
		const target = rows[row] as string[];
		while (target.length <= col) target.push("");
		target[col] = text;
	}

	return serializeCsv(rows, normalizeDelimiter(delimiter));
}
