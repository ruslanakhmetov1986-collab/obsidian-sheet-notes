/**
 * File format for `.sheet` notes.
 *
 * Own sparse JSON (never the grid engine's internal state). Serialization is
 * fully deterministic so that Obsidian LiveSync ships one changed line per
 * edited cell instead of the whole file:
 *
 *   1. deterministic key order (sheets in array order, cells by (row, col),
 *      sub-keys in fixed order `v, f, s`)
 *   2. pretty printed, 2-space indent, exactly one cell per line
 *   3. LF endings, trailing newline, no BOM
 *   4. NaN / Infinity rejected at write time
 *   5. sparse: empty cells are never emitted
 *   6. `version` field with a migration switch
 */

export const FORMAT_ID = "leovale-sheet";
export const CURRENT_VERSION = 1;

/** Shortest plausible serialization; used by the view as an anti-truncation floor. */
export const MIN_VALID = 60;

export const DEFAULT_ROWS = 100;
export const DEFAULT_COLS = 26;

export type CellValue = string | number | boolean;

/** Canonical order of border sides inside the `bd` string. */
export const BORDER_SIDES = "trbl";
export const MIN_FONT_SIZE = 6;
export const MAX_FONT_SIZE = 96;

/**
 * Normalized cell style. Deliberately NOT raw CSS: only these four properties
 * are persisted, in this key order, so the file stays byte-stable and readable.
 *
 *   b   bold                      true (absent = normal weight)
 *   fs  font size in px           integer 6..96
 *   bg  background fill           "#rrggbb", lowercase
 *   bd  borders                   subset of "trbl" in that order, e.g. "trbl"
 */
export interface CellStyle {
	b?: true;
	fs?: number;
	bg?: string;
	bd?: string;
}

export interface SheetCell {
	/** Literal value. Absent for pure-formula cells. */
	v?: CellValue;
	/** Formula source including the leading `=`. */
	f?: string;
	/** Normalized style. Omitted when empty. */
	s?: CellStyle;
}

const HEX_RE = /^#[0-9a-f]{6}$/;

/** Accepts "#ABC", "#AABBCC" and "rgb(r, g, b)"; returns "#aabbcc" or undefined. */
export function normalizeColor(input: unknown): string | undefined {
	if (typeof input !== "string") return undefined;
	const s = input.trim().toLowerCase();
	if (HEX_RE.test(s)) return s;
	if (/^#[0-9a-f]{3}$/.test(s)) {
		return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
	}
	const m = /^rgba?\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*(?:,[^)]*)?\)$/.exec(s);
	if (m) {
		const hex = [m[1], m[2], m[3]]
			.map((p) => Math.min(255, parseInt(p as string, 10)).toString(16).padStart(2, "0"))
			.join("");
		return `#${hex}`;
	}
	return undefined;
}

/** Keep only known sides, deduplicated, in canonical `trbl` order. */
export function normalizeSides(input: unknown): string | undefined {
	if (typeof input !== "string") return undefined;
	const s = input.toLowerCase();
	let out = "";
	for (const side of BORDER_SIDES) {
		if (s.includes(side)) out += side;
	}
	return out.length > 0 ? out : undefined;
}

/** Coerce anything into a valid {@link CellStyle}, dropping unknown properties. */
export function normalizeStyle(input: unknown): CellStyle | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
	const src = input as Record<string, unknown>;
	const out: CellStyle = {};

	if (src["b"] === true || src["b"] === 1 || src["b"] === "bold") out.b = true;

	const fsRaw = src["fs"];
	const fs = typeof fsRaw === "string" ? Number.parseFloat(fsRaw) : fsRaw;
	if (typeof fs === "number" && Number.isFinite(fs)) {
		const n = Math.round(fs);
		if (n >= MIN_FONT_SIZE && n <= MAX_FONT_SIZE) out.fs = n;
	}

	const bg = normalizeColor(src["bg"]);
	if (bg) out.bg = bg;

	const bd = normalizeSides(src["bd"]);
	if (bd) out.bd = bd;

	return isEmptyStyle(out) ? undefined : out;
}

export function isEmptyStyle(style: CellStyle | undefined): boolean {
	if (!style) return true;
	return !style.b && style.fs === undefined && !style.bg && !style.bd;
}

export interface SheetPage {
	name: string;
	rows: number;
	cols: number;
	/** column index (as decimal string) -> pixel width */
	colWidths: Record<string, number>;
	/** row index (as decimal string) -> pixel height */
	rowHeights: Record<string, number>;
	/** "A1" -> [colspan, rowspan] */
	merges: Record<string, [number, number]>;
	/** "A1" -> cell */
	cells: Record<string, SheetCell>;
}

export interface SheetDoc {
	format: typeof FORMAT_ID;
	version: number;
	sheets: SheetPage[];
}

export class SheetFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SheetFormatError";
	}
}

/* ------------------------------------------------------------------ refs */

/** 0 -> "A", 25 -> "Z", 26 -> "AA" */
export function colToName(col: number): string {
	if (!Number.isInteger(col) || col < 0) {
		throw new SheetFormatError(`bad column index: ${col}`);
	}
	let n = col;
	let out = "";
	for (;;) {
		out = String.fromCharCode(65 + (n % 26)) + out;
		n = Math.floor(n / 26) - 1;
		if (n < 0) break;
	}
	return out;
}

/** "A" -> 0, "AA" -> 26 */
export function nameToCol(name: string): number {
	let n = 0;
	for (let i = 0; i < name.length; i++) {
		n = n * 26 + (name.charCodeAt(i) - 64);
	}
	return n - 1;
}

/** (0, 0) -> "A1" */
export function cellRef(row: number, col: number): string {
	return `${colToName(col)}${row + 1}`;
}

const REF_RE = /^([A-Z]+)([1-9][0-9]*)$/;

/** "B3" -> { row: 2, col: 1 } */
export function parseRef(ref: string): { row: number; col: number } {
	const m = REF_RE.exec(ref);
	if (!m || !m[1] || !m[2]) throw new SheetFormatError(`bad cell reference: ${ref}`);
	return { row: parseInt(m[2], 10) - 1, col: nameToCol(m[1]) };
}

/** True for a syntactically valid A1-style reference. */
export function isRef(ref: string): boolean {
	return REF_RE.test(ref);
}

/* ------------------------------------------------------------- documents */

export function newSheetPage(name = "Sheet1"): SheetPage {
	return {
		name,
		rows: DEFAULT_ROWS,
		cols: DEFAULT_COLS,
		colWidths: {},
		rowHeights: {},
		merges: {},
		cells: {},
	};
}

export function newSheetDoc(): SheetDoc {
	return { format: FORMAT_ID, version: CURRENT_VERSION, sheets: [newSheetPage()] };
}

/** A future `version` means we must not write the file back. */
export function isSupportedVersion(doc: SheetDoc): boolean {
	return doc.version <= CURRENT_VERSION;
}

/* ---------------------------------------------------------------- parse */

function asFiniteNumber(x: unknown): number | undefined {
	return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}

function parseCell(raw: unknown, ref: string): SheetCell | null {
	if (raw === null || typeof raw !== "object") {
		throw new SheetFormatError(`cell ${ref} is not an object`);
	}
	const src = raw as Record<string, unknown>;
	const cell: SheetCell = {};

	const v = src["v"];
	if (typeof v === "string" || typeof v === "boolean") {
		cell.v = v;
	} else if (typeof v === "number") {
		const n = asFiniteNumber(v);
		if (n !== undefined) cell.v = n;
	} else if (v !== undefined && v !== null) {
		throw new SheetFormatError(`cell ${ref} has an unsupported value type`);
	}

	const f = src["f"];
	if (typeof f === "string" && f.length > 0) cell.f = f;

	const style = normalizeStyle(src["s"]);
	if (style) cell.s = style;

	return isEmptyCell(cell) ? null : cell;
}

export function isEmptyCell(cell: SheetCell): boolean {
	const hasV = cell.v !== undefined && cell.v !== null && cell.v !== "";
	const hasF = typeof cell.f === "string" && cell.f.length > 0;
	return !hasV && !hasF && isEmptyStyle(cell.s);
}

function parseIndexMap(raw: unknown, limit: number): Record<string, number> {
	const out: Record<string, number> = {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		if (!/^[0-9]+$/.test(k)) continue;
		const n = asFiniteNumber(v);
		if (n === undefined || n <= 0) continue;
		if (parseInt(k, 10) >= limit) continue;
		out[k] = Math.round(n);
	}
	return out;
}

function parseMerges(raw: unknown): Record<string, [number, number]> {
	const out: Record<string, [number, number]> = {};
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		if (!isRef(k) || !Array.isArray(v)) continue;
		const c = asFiniteNumber(v[0]);
		const r = asFiniteNumber(v[1]);
		if (c === undefined || r === undefined) continue;
		if (c < 1 || r < 1) continue;
		out[k] = [Math.round(c), Math.round(r)];
	}
	return out;
}

function parsePage(raw: unknown, index: number): SheetPage {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new SheetFormatError(`sheets[${index}] is not an object`);
	}
	const src = raw as Record<string, unknown>;
	const page = newSheetPage(
		typeof src["name"] === "string" && (src["name"] as string).length > 0
			? (src["name"] as string)
			: `Sheet${index + 1}`,
	);

	const rows = asFiniteNumber(src["rows"]);
	const cols = asFiniteNumber(src["cols"]);
	if (rows !== undefined && rows > 0) page.rows = Math.min(Math.round(rows), 100000);
	if (cols !== undefined && cols > 0) page.cols = Math.min(Math.round(cols), 702);

	const cellsRaw = src["cells"];
	if (cellsRaw && typeof cellsRaw === "object" && !Array.isArray(cellsRaw)) {
		for (const [ref, rawCell] of Object.entries(cellsRaw as Record<string, unknown>)) {
			if (!isRef(ref)) throw new SheetFormatError(`bad cell reference: ${ref}`);
			const cell = parseCell(rawCell, ref);
			if (!cell) continue;
			const { row, col } = parseRef(ref);
			// Grow the grid so nothing that is stored can be invisible.
			if (row + 1 > page.rows) page.rows = row + 1;
			if (col + 1 > page.cols) page.cols = col + 1;
			page.cells[ref] = cell;
		}
	}

	page.colWidths = parseIndexMap(src["colWidths"], page.cols);
	page.rowHeights = parseIndexMap(src["rowHeights"], page.rows);
	page.merges = parseMerges(src["merges"]);
	return page;
}

/**
 * Parse a `.sheet` file. Throws {@link SheetFormatError} for anything that is
 * not a recognizable sheet document; empty input yields a fresh document.
 */
export function parseSheet(text: string): SheetDoc {
	const trimmed = text.replace(/^﻿/, "").trim();
	if (trimmed.length === 0) return newSheetDoc();

	let raw: unknown;
	try {
		raw = JSON.parse(trimmed);
	} catch (e) {
		throw new SheetFormatError(`not valid JSON: ${(e as Error).message}`);
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new SheetFormatError("root is not an object");
	}
	const src = raw as Record<string, unknown>;
	if (src["format"] !== FORMAT_ID) {
		throw new SheetFormatError(`unknown format: ${String(src["format"])}`);
	}
	const version = asFiniteNumber(src["version"]);
	if (version === undefined || version < 1) {
		throw new SheetFormatError(`unknown version: ${String(src["version"])}`);
	}

	const sheetsRaw = src["sheets"];
	const sheets: SheetPage[] = [];
	if (Array.isArray(sheetsRaw)) {
		sheetsRaw.forEach((s, i) => sheets.push(parsePage(s, i)));
	}
	if (sheets.length === 0) sheets.push(newSheetPage());

	return { format: FORMAT_ID, version: Math.round(version), sheets };
}

/* ------------------------------------------------------------ serialize */

function jstr(s: string): string {
	return JSON.stringify(s);
}

function jnum(n: number): string {
	if (!Number.isFinite(n)) throw new SheetFormatError(`non-finite number: ${n}`);
	return JSON.stringify(n);
}

/** Fixed sub-key order inside `s`: b, fs, bg, bd. */
function serializeStyleBody(style: CellStyle | undefined): string {
	const s = normalizeStyle(style);
	if (!s) return "";
	const parts: string[] = [];
	if (s.b) parts.push('"b": true');
	if (s.fs !== undefined) parts.push(`"fs": ${jnum(s.fs)}`);
	if (s.bg) parts.push(`"bg": ${jstr(s.bg)}`);
	if (s.bd) parts.push(`"bd": ${jstr(s.bd)}`);
	return parts.length > 0 ? `{ ${parts.join(", ")} }` : "";
}

function serializeCellBody(cell: SheetCell): string {
	const parts: string[] = [];
	const style = serializeStyleBody(cell.s);

	if (cell.v !== undefined && cell.v !== null && cell.v !== "") {
		if (typeof cell.v === "number") {
			// Rule 4: reject NaN/Infinity rather than writing invalid JSON.
			if (Number.isFinite(cell.v)) parts.push(`"v": ${jnum(cell.v)}`);
		} else if (typeof cell.v === "boolean") {
			parts.push(`"v": ${cell.v ? "true" : "false"}`);
		} else {
			parts.push(`"v": ${jstr(cell.v)}`);
		}
	}
	if (typeof cell.f === "string" && cell.f.length > 0) {
		parts.push(`"f": ${jstr(cell.f)}`);
	}
	if (style) parts.push(`"s": ${style}`);

	if (parts.length === 0) return "";
	return `{ ${parts.join(", ")} }`;
}

/** Sort key: row first, then column. */
function refOrder(a: string, b: string): number {
	const pa = parseRef(a);
	const pb = parseRef(b);
	return pa.row - pb.row || pa.col - pb.col;
}

function serializeIndexMap(map: Record<string, number>, indent: string): string {
	const keys = Object.keys(map)
		.filter((k) => /^[0-9]+$/.test(k) && Number.isFinite(map[k]) && (map[k] as number) > 0)
		.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
	if (keys.length === 0) return "{}";
	const lines = keys.map((k) => `${indent}  ${jstr(k)}: ${jnum(Math.round(map[k] as number))}`);
	return `{\n${lines.join(",\n")}\n${indent}}`;
}

function serializeMerges(merges: Record<string, [number, number]>, indent: string): string {
	const keys = Object.keys(merges).filter(isRef).sort(refOrder);
	if (keys.length === 0) return "{}";
	const lines = keys.map((k) => {
		const span = merges[k] as [number, number];
		return `${indent}  ${jstr(k)}: [${jnum(span[0])}, ${jnum(span[1])}]`;
	});
	return `{\n${lines.join(",\n")}\n${indent}}`;
}

function serializePage(page: SheetPage, indent: string): string {
	const i2 = indent + "  ";
	const cellKeys = Object.keys(page.cells).filter(isRef).sort(refOrder);
	const cellLines: string[] = [];
	for (const ref of cellKeys) {
		const cell = page.cells[ref];
		if (!cell) continue;
		const body = serializeCellBody(cell);
		if (!body) continue; // rule 5: sparse, never emit empty cells
		cellLines.push(`${i2}  ${jstr(ref)}: ${body}`);
	}
	const cells = cellLines.length === 0 ? "{}" : `{\n${cellLines.join(",\n")}\n${i2}}`;

	const rows = Math.max(1, Math.round(page.rows) || DEFAULT_ROWS);
	const cols = Math.max(1, Math.round(page.cols) || DEFAULT_COLS);

	return [
		`${indent}{`,
		`${i2}"name": ${jstr(page.name || "Sheet1")},`,
		`${i2}"rows": ${jnum(rows)},`,
		`${i2}"cols": ${jnum(cols)},`,
		`${i2}"colWidths": ${serializeIndexMap(page.colWidths ?? {}, i2)},`,
		`${i2}"rowHeights": ${serializeIndexMap(page.rowHeights ?? {}, i2)},`,
		`${i2}"merges": ${serializeMerges(page.merges ?? {}, i2)},`,
		`${i2}"cells": ${cells}`,
		`${indent}}`,
	].join("\n");
}

/**
 * Deterministic serialization. Always returns a complete, non-empty document:
 * a doc with no sheets is written as a document with one empty sheet, never
 * as `""` (see the data-loss guard in view.ts).
 */
export function serializeSheet(doc: SheetDoc): string {
	const sheets = doc.sheets && doc.sheets.length > 0 ? doc.sheets : [newSheetPage()];
	const version = Number.isFinite(doc.version) ? Math.round(doc.version) : CURRENT_VERSION;
	const body = sheets.map((p) => serializePage(p, "    ")).join(",\n");
	return [
		"{",
		`  "format": ${jstr(FORMAT_ID)},`,
		`  "version": ${jnum(version)},`,
		'  "sheets": [',
		body,
		"  ]",
		"}",
		"",
	].join("\n");
}
