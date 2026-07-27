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
/**
 * 1 -> 2 (release 1.2.0): cell styles gained `nf`, `ha`, `va` and `wrap`.
 * 2 -> 3 (release 1.3.0): a page gained the `view` (sort + filters) and
 * `freeze` (frozen rows/columns) blocks.
 *
 * The bump is not cosmetic, and the rule behind it is always the same one: a
 * build that cannot see a key DROPS it on save. A 1.1.x build's
 * `normalizeStyle()` drops `nf`/`ha`/`va`/`wrap`; a 1.2.0 build's `parsePage()`
 * drops `view` and `freeze` (it copies known keys onto a fresh page and never
 * looks at the rest). So a 1.2.0 build opening a 1.3.0 file and saving it would
 * silently throw away the sort, the filters and the frozen panes. Version 3
 * makes that build refuse to write the file at all
 * (`isSupportedVersion` -> read-only), which is the entire point of the field.
 *
 * Reading v1 and v2 keeps working forever; writing always emits the current
 * version (see {@link serializeSheet}).
 */
export const CURRENT_VERSION = 3;

/** Shortest plausible serialization; used by the view as an anti-truncation floor. */
export const MIN_VALID = 60;

export const DEFAULT_ROWS = 100;
export const DEFAULT_COLS = 26;

export type CellValue = string | number | boolean;

/** Canonical order of border sides inside the `bd` string. */
export const BORDER_SIDES = "trbl";
export const MIN_FONT_SIZE = 6;
export const MAX_FONT_SIZE = 96;

/** Horizontal alignment codes. Left is the grid's own default. */
export const H_ALIGNS = ["l", "c", "r"] as const;
/** Vertical alignment codes. Middle is the browser's own default for a cell. */
export const V_ALIGNS = ["t", "m", "b"] as const;
export type HAlign = (typeof H_ALIGNS)[number];
export type VAlign = (typeof V_ALIGNS)[number];

/** A number/date mask longer than this is a corrupt file, not a format. */
export const MAX_NF_LENGTH = 64;

/**
 * Normalized cell style. Deliberately NOT raw CSS: only these eight properties
 * are persisted, in this key order, so the file stays byte-stable and readable.
 *
 *   b     bold                    true (absent = normal weight)
 *   fs    font size in px         integer 6..96
 *   bg    background fill         "#rrggbb", lowercase
 *   bd    borders                 subset of "trbl" in that order, e.g. "trbl"
 *   nf    number/date mask        excel-like, e.g. "#,##0.00", "yyyy-mm-dd"
 *   ha    horizontal alignment    "l" | "c" | "r" (absent = left)
 *   va    vertical alignment      "t" | "m" | "b" (absent = the cell default)
 *   wrap  wrap long text          true (absent = one clipped line)
 *
 * `nf` is a DISPLAY mask only: the cell keeps its raw value in `v`, so the file
 * stays locale-independent and a date is a plain value plus a mask, not a type.
 */
export interface CellStyle {
	b?: true;
	fs?: number;
	bg?: string;
	bd?: string;
	nf?: string;
	ha?: HAlign;
	va?: VAlign;
	wrap?: true;
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

/**
 * Keep a number/date mask if it is a plausible one.
 *
 * Masks are stored verbatim (excel-like), so the only rules are: it is a
 * non-empty single-line string of sane length. Whatever the formatter cannot
 * interpret is simply displayed as the raw value, never as an error.
 */
export function normalizeNf(input: unknown): string | undefined {
	if (typeof input !== "string") return undefined;
	const s = input.trim();
	if (s.length === 0 || s.length > MAX_NF_LENGTH) return undefined;
	// A mask is one line of printable characters. A control byte in there means
	// a corrupt file, not a format we should try to honour.
	for (let k = 0; k < s.length; k++) {
		const code = s.charCodeAt(k);
		if (code < 0x20 || code === 0x7f) return undefined;
	}
	return s;
}

/** "l" | "c" | "r" (also accepts full CSS words); anything else -> undefined. */
export function normalizeHAlign(input: unknown): HAlign | undefined {
	if (typeof input !== "string") return undefined;
	const s = input.trim().toLowerCase().charAt(0) as HAlign;
	return (H_ALIGNS as readonly string[]).includes(s) ? s : undefined;
}

/** "t" | "m" | "b" (also accepts "top"/"middle"/"bottom"). */
export function normalizeVAlign(input: unknown): VAlign | undefined {
	if (typeof input !== "string") return undefined;
	const s = input.trim().toLowerCase().charAt(0) as VAlign;
	return (V_ALIGNS as readonly string[]).includes(s) ? s : undefined;
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

	const nf = normalizeNf(src["nf"]);
	if (nf) out.nf = nf;

	const ha = normalizeHAlign(src["ha"]);
	if (ha) out.ha = ha;

	const va = normalizeVAlign(src["va"]);
	if (va) out.va = va;

	if (src["wrap"] === true || src["wrap"] === 1 || src["wrap"] === "wrap") out.wrap = true;

	return isEmptyStyle(out) ? undefined : out;
}

export function isEmptyStyle(style: CellStyle | undefined): boolean {
	if (!style) return true;
	return (
		!style.b &&
		style.fs === undefined &&
		!style.bg &&
		!style.bd &&
		!style.nf &&
		!style.ha &&
		!style.va &&
		!style.wrap
	);
}

/* ------------------------------------------------------- view and freeze */

export const SORT_DIRS = ["asc", "desc"] as const;
export type SortDir = (typeof SORT_DIRS)[number];

/** A column sort, as last applied by the user. `col` is a 0-based index. */
export interface PageSort {
	col: number;
	dir: SortDir;
}

/**
 * How the user is currently LOOKING at the page: which column it is sorted by
 * and which values each filtered column is allowed to show. Neither changes a
 * single cell, which is why both live outside `cells`.
 *
 * `filters` maps a column index (decimal string, like `colWidths`) to the list
 * of ALLOWED display values; a row is visible when every filtered column of it
 * is in its list. A column absent from the map is unfiltered.
 */
export interface PageView {
	sort?: PageSort;
	filters?: Record<string, string[]>;
}

/** Frozen panes: the first `rows` rows and `cols` columns stay put. */
export interface PageFreeze {
	rows?: number;
	cols?: number;
}

/** Refuse absurd freezes: a pane taller than the window is a corrupt file. */
export const MAX_FREEZE = 100;
/** A filter list longer than this is a corrupt file, not a user's choice. */
export const MAX_FILTER_VALUES = 5000;

export function normalizeSort(input: unknown): PageSort | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
	const src = input as Record<string, unknown>;
	const colRaw = src["col"];
	const col = typeof colRaw === "string" ? Number.parseInt(colRaw, 10) : colRaw;
	if (typeof col !== "number" || !Number.isFinite(col) || col < 0) return undefined;
	const dirRaw = typeof src["dir"] === "string" ? (src["dir"] as string).trim().toLowerCase() : "";
	// Anything that is not literally "desc" is ascending: a sort direction we
	// cannot read must still leave a usable sort rather than dropping the block.
	const dir: SortDir = dirRaw === "desc" || dirRaw === "d" || dirRaw === "-1" ? "desc" : "asc";
	return { col: Math.round(col), dir };
}

/**
 * Keep only string lists keyed by a column index. Values are deduplicated and
 * sorted, so toggling the same set of values twice produces the same bytes.
 */
export function normalizeFilters(input: unknown): Record<string, string[]> | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
	const out: Record<string, string[]> = {};
	for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
		if (!/^[0-9]+$/.test(k) || !Array.isArray(v)) continue;
		const seen = new Set<string>();
		for (const raw of v) {
			if (typeof raw === "string") seen.add(raw);
			else if (typeof raw === "number" && Number.isFinite(raw)) seen.add(String(raw));
			else if (typeof raw === "boolean") seen.add(String(raw));
			if (seen.size >= MAX_FILTER_VALUES) break;
		}
		// An empty allow-list would hide every row, which is never what a user
		// means; it is stored as "no filter on this column" instead.
		if (seen.size === 0) continue;
		out[k] = [...seen].sort();
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

export function normalizeView(input: unknown): PageView {
	if (!input || typeof input !== "object" || Array.isArray(input)) return {};
	const src = input as Record<string, unknown>;
	const out: PageView = {};
	const sort = normalizeSort(src["sort"]);
	if (sort) out.sort = sort;
	const filters = normalizeFilters(src["filters"]);
	if (filters) out.filters = filters;
	return out;
}

export function isEmptyView(view: PageView | undefined): boolean {
	return !view || (!view.sort && !view.filters);
}

export function normalizeFreeze(input: unknown): PageFreeze {
	if (!input || typeof input !== "object" || Array.isArray(input)) return {};
	const src = input as Record<string, unknown>;
	const out: PageFreeze = {};
	for (const key of ["rows", "cols"] as const) {
		const raw = src[key];
		const n = typeof raw === "string" ? Number.parseInt(raw, 10) : raw;
		if (typeof n !== "number" || !Number.isFinite(n)) continue;
		const v = Math.round(n);
		if (v > 0) out[key] = Math.min(v, MAX_FREEZE);
	}
	return out;
}

export function isEmptyFreeze(freeze: PageFreeze | undefined): boolean {
	return !freeze || (!freeze.rows && !freeze.cols);
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
	/** Sort and filters, i.e. how the page is being looked at. Since v3. */
	view: PageView;
	/** Frozen rows and columns. Since v3. */
	freeze: PageFreeze;
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
		view: {},
		freeze: {},
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
	page.view = normalizeView(src["view"]);
	page.freeze = normalizeFreeze(src["freeze"]);
	// A sort or a filter naming a column outside the grid is meaningless; drop it
	// rather than carry a reference to a column that does not exist.
	if (page.view.sort && page.view.sort.col >= page.cols) delete page.view.sort;
	if (page.view.filters) {
		for (const k of Object.keys(page.view.filters)) {
			if (parseInt(k, 10) >= page.cols) delete page.view.filters[k];
		}
		if (Object.keys(page.view.filters).length === 0) delete page.view.filters;
	}
	if (page.freeze.rows !== undefined && page.freeze.rows >= page.rows) delete page.freeze.rows;
	if (page.freeze.cols !== undefined && page.freeze.cols >= page.cols) delete page.freeze.cols;
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

/**
 * Fixed sub-key order inside `s`: b, fs, bg, bd, nf, ha, va, wrap.
 *
 * The 1.2.0 keys are appended AFTER `bd` on purpose: a file written by 1.1.x
 * and re-saved by this build then differs only in the added tail of each style,
 * which keeps LiveSync diffs small and makes the change reviewable in git.
 */
function serializeStyleBody(style: CellStyle | undefined): string {
	const s = normalizeStyle(style);
	if (!s) return "";
	const parts: string[] = [];
	if (s.b) parts.push('"b": true');
	if (s.fs !== undefined) parts.push(`"fs": ${jnum(s.fs)}`);
	if (s.bg) parts.push(`"bg": ${jstr(s.bg)}`);
	if (s.bd) parts.push(`"bd": ${jstr(s.bd)}`);
	if (s.nf) parts.push(`"nf": ${jstr(s.nf)}`);
	if (s.ha) parts.push(`"ha": ${jstr(s.ha)}`);
	if (s.va) parts.push(`"va": ${jstr(s.va)}`);
	if (s.wrap) parts.push('"wrap": true');
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

/**
 * The `view` block: `sort` first, then `filters`, both optional.
 *
 * Written as `{}` when there is nothing to say, exactly like `merges`, so the
 * key order of a page is the same in every file and a diff of two versions of
 * the same sheet never has to move lines around. Filter values get one line
 * each: toggling a single value then changes a single line.
 */
function serializeView(view: PageView | undefined, indent: string): string {
	const v = normalizeView(view);
	if (isEmptyView(v)) return "{}";
	const lines: string[] = [];
	if (v.sort) {
		lines.push(`${indent}  "sort": { "col": ${jnum(v.sort.col)}, "dir": ${jstr(v.sort.dir)} }`);
	}
	if (v.filters) {
		const cols = Object.keys(v.filters).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
		const blocks = cols.map((c) => {
			const values = (v.filters as Record<string, string[]>)[c] as string[];
			const items = values.map((s) => `${indent}      ${jstr(s)}`).join(",\n");
			return `${indent}    ${jstr(c)}: [\n${items}\n${indent}    ]`;
		});
		lines.push(`${indent}  "filters": {\n${blocks.join(",\n")}\n${indent}  }`);
	}
	return `{\n${lines.join(",\n")}\n${indent}}`;
}

/** The `freeze` block, one line: `rows` then `cols`, zeroes omitted. */
function serializeFreeze(freeze: PageFreeze | undefined): string {
	const f = normalizeFreeze(freeze);
	if (isEmptyFreeze(f)) return "{}";
	const parts: string[] = [];
	if (f.rows) parts.push(`"rows": ${jnum(f.rows)}`);
	if (f.cols) parts.push(`"cols": ${jnum(f.cols)}`);
	return `{ ${parts.join(", ")} }`;
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
		`${i2}"view": ${serializeView(page.view, i2)},`,
		`${i2}"freeze": ${serializeFreeze(page.freeze)},`,
		`${i2}"cells": ${cells}`,
		`${indent}}`,
	].join("\n");
}

/**
 * Deterministic serialization. Always returns a complete, non-empty document:
 * a doc with no sheets is written as a document with one empty sheet, never
 * as `""` (see the data-loss guard in view.ts).
 *
 * The written `version` is ALWAYS {@link CURRENT_VERSION}, whatever the document
 * says. Writing a v1 file back as v1 was the alternative and it is worse: the
 * file would then claim a version whose readers are entitled to drop the new
 * style keys, so an old build could quietly strip formats it cannot see. A
 * document with a FUTURE version never reaches this function at all - the view
 * opens it read-only.
 */
export function serializeSheet(doc: SheetDoc): string {
	const sheets = doc.sheets && doc.sheets.length > 0 ? doc.sheets : [newSheetPage()];
	const version = CURRENT_VERSION;
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
