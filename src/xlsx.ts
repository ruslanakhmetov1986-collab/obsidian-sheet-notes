/**
 * `.xlsx` in and out, on top of SheetJS.
 *
 * The library is `xlsx-js-style` (Apache-2.0): SheetJS Community Edition 0.18.5
 * plus the one thing the community writer does not do, which is writing cell
 * styles. Verified rather than assumed - a workbook written by plain `xlsx@0.18.5`
 * with `cell.s` set comes back with the fill, the bold and the borders gone,
 * because CE's writer never looks at `s`. Both packages are Apache-2.0 and both
 * are SheetJS; the fork is the one that can carry a bold cell into Excel.
 *
 * LOADED LAZILY, and this is the whole reason the module is separate: nothing
 * here is touched until the user actually runs an import or an export, so the
 * 400 KB of spreadsheet library never runs while Obsidian is starting up. It is
 * still IN main.js - a plugin is one file, esbuild cannot split a CJS bundle
 * into chunks Obsidian would know how to load, and a second file would not
 * survive a BRAT install. What the dynamic import buys is that its module body
 * is not executed on load (esbuild wraps it in a lazy CJS initializer), which is
 * the part that costs milliseconds on every start.
 *
 * What crosses the boundary, both ways: values, formulas, bold, font size, fill,
 * borders, number formats, alignment, wrapping, column widths, row heights,
 * merges, and one worksheet per page. What cannot: our checkbox cells (xlsx has
 * no such cell type, they travel as TRUE/FALSE), and anything Excel has that we
 * do not model - charts, images, conditional formats, defined names.
 */

import {
	CURRENT_VERSION,
	DEFAULT_COLS,
	DEFAULT_ROWS,
	FORMAT_ID,
	type CellStyle,
	type SheetCell,
	type SheetDoc,
	type SheetPage,
	cellRef,
	isEmptyCell,
	newSheetPage,
	parseRef,
} from "./format";
import {
	parseBorderSides,
	parseCellXfIndexes,
	parseSheetPaths,
	styleToXlsx,
	xlsxToStyle,
} from "./xlsxstyles";

/* ------------------------------------------------------- the library shape */

/** One cell as SheetJS models it. */
export interface XlsxCell {
	/** Value type: s(tring), n(umber), b(oolean), d(ate), e(rror), z (stub). */
	t?: string;
	v?: string | number | boolean | Date;
	/** Formula source WITHOUT the leading `=`. */
	f?: string;
	/** Number format string. */
	z?: string;
	/** Style object (written by xlsx-js-style, only partly read back). */
	s?: unknown;
}

export interface XlsxSheet {
	[ref: string]: unknown;
	"!ref"?: string;
	"!cols"?: ({ wpx?: number; wch?: number } | undefined)[];
	"!rows"?: ({ hpx?: number; hpt?: number } | undefined)[];
	"!merges"?: { s: { r: number; c: number }; e: { r: number; c: number } }[];
}

export interface XlsxWorkbook {
	SheetNames: string[];
	Sheets: Record<string, XlsxSheet>;
	/** Present with `cellStyles: true`. Borders are parsed as empty objects. */
	Styles?: {
		Fonts?: { bold?: unknown; sz?: unknown }[];
		Fills?: { fgColor?: { rgb?: unknown } }[];
		CellXf?: {
			fontId?: unknown;
			fillId?: unknown;
			borderId?: unknown;
			alignment?: { horizontal?: unknown; vertical?: unknown; wrapText?: unknown };
		}[];
	};
	/** Present with `bookFiles: true`: the unzipped parts, by name. */
	files?: Record<string, { content?: unknown } | undefined>;
}

/** Only the four entry points we use, so the rest of the API cannot creep in. */
export interface XlsxModule {
	version: string;
	read(data: unknown, opts: Record<string, unknown>): XlsxWorkbook;
	write(wb: XlsxWorkbook, opts: Record<string, unknown>): unknown;
	utils: {
		book_new(): XlsxWorkbook;
		book_append_sheet(wb: XlsxWorkbook, ws: XlsxSheet, name: string): void;
		encode_range(range: { s: { r: number; c: number }; e: { r: number; c: number } }): string;
		decode_range(ref: string): { s: { r: number; c: number }; e: { r: number; c: number } };
	};
}

let pending: Promise<XlsxModule> | null = null;

/**
 * Load SheetJS, once. The promise is cached rather than the module, so two
 * commands fired in the same second share one load instead of racing.
 */
export function loadXlsx(): Promise<XlsxModule> {
	if (!pending) {
		pending = import("xlsx-js-style").then((mod) => {
			const m = (mod as unknown as { default?: unknown }).default ?? mod;
			return m as unknown as XlsxModule;
		});
	}
	return pending;
}

/* ------------------------------------------------------------- formulas */

/**
 * `=IF(A1>5;"yes";"no")` -> `IF(A1>5,"yes","no")`.
 *
 * The grid's formula engine accepts both separators and the README's examples
 * use `;`; a `.xlsx` may only ever use `,`. Semicolons INSIDE a string literal
 * are left alone, which is why this is a scanner and not a `replace()`.
 */
export function formulaToXlsx(source: string): string {
	const body = source.startsWith("=") ? source.slice(1) : source;
	let out = "";
	let quoted = false;
	for (let i = 0; i < body.length; i++) {
		const ch = body[i] as string;
		if (ch === '"') quoted = !quoted;
		out += !quoted && ch === ";" ? "," : ch;
	}
	return out;
}

/** The other direction: a formula from the file, as our `f` wants it. */
export function formulaFromXlsx(source: unknown): string | undefined {
	if (typeof source !== "string") return undefined;
	const s = source.trim();
	if (s.length === 0) return undefined;
	return s.startsWith("=") ? s : `=${s}`;
}

/* -------------------------------------------------------------- export */

/** Excel forbids these in a sheet name, and cuts it at 31 characters. */
export function sheetNameForXlsx(name: string, index: number, taken: Set<string>): string {
	let base = (name || `Sheet${index + 1}`).replace(/[[\]:*?/\\]/g, "-").slice(0, 31).trim();
	if (base.length === 0) base = `Sheet${index + 1}`;
	let out = base;
	for (let n = 2; taken.has(out.toLowerCase()); n++) {
		const suffix = ` (${n})`;
		out = base.slice(0, 31 - suffix.length) + suffix;
	}
	taken.add(out.toLowerCase());
	return out;
}

function cellForXlsx(cell: SheetCell): XlsxCell | null {
	const out: XlsxCell = {};
	if (typeof cell.f === "string" && cell.f.length > 0) {
		out.f = formulaToXlsx(cell.f);
		// A formula cell needs a type and a placeholder value: Excel recalculates
		// on open, and a cached result of ours would be a second source of truth.
		out.t = "n";
		out.v = 0;
	} else if (cell.t === "cb") {
		// xlsx has no checkbox cell. TRUE/FALSE is what a checkbox MEANS, and it
		// is what Excel's own boolean cells look like.
		out.t = "b";
		out.v = cell.v === true || cell.v === 1 || cell.v === "true";
	} else if (typeof cell.v === "number") {
		out.t = "n";
		out.v = cell.v;
	} else if (typeof cell.v === "boolean") {
		out.t = "b";
		out.v = cell.v;
	} else if (typeof cell.v === "string" && cell.v.length > 0) {
		out.t = "s";
		out.v = cell.v;
	}
	const style = styleToXlsx(cell.s);
	if (style) out.s = style;
	if (cell.s?.nf) out.z = cell.s.nf;
	if (out.v === undefined && out.f === undefined && out.s === undefined) return null;
	if (out.t === undefined) {
		// style-only cell: a stub, so the style has something to sit on
		out.t = "z";
	}
	return out;
}

/** One page -> one worksheet. */
export function pageToSheet(XLSX: XlsxModule, page: SheetPage): XlsxSheet {
	const ws: XlsxSheet = {};
	let maxRow = 0;
	let maxCol = 0;

	for (const [ref, cell] of Object.entries(page.cells)) {
		if (!cell || isEmptyCell(cell)) continue;
		let coords;
		try {
			coords = parseRef(ref);
		} catch {
			continue;
		}
		const out = cellForXlsx(cell);
		if (!out) continue;
		ws[ref] = out;
		if (coords.row > maxRow) maxRow = coords.row;
		if (coords.col > maxCol) maxCol = coords.col;
	}

	const cols: { wpx?: number }[] = [];
	for (const [k, w] of Object.entries(page.colWidths)) {
		const c = Number.parseInt(k, 10);
		if (!Number.isFinite(c) || c < 0 || typeof w !== "number" || w <= 0) continue;
		cols[c] = { wpx: Math.round(w) };
		if (c > maxCol) maxCol = c;
	}
	if (cols.length > 0) {
		for (let c = 0; c < cols.length; c++) if (!cols[c]) cols[c] = {};
		ws["!cols"] = cols;
	}

	const rows: { hpx?: number }[] = [];
	for (const [k, h] of Object.entries(page.rowHeights)) {
		const r = Number.parseInt(k, 10);
		if (!Number.isFinite(r) || r < 0 || typeof h !== "number" || h <= 0) continue;
		rows[r] = { hpx: Math.round(h) };
		if (r > maxRow) maxRow = r;
	}
	if (rows.length > 0) {
		for (let r = 0; r < rows.length; r++) if (!rows[r]) rows[r] = {};
		ws["!rows"] = rows;
	}

	const merges: { s: { r: number; c: number }; e: { r: number; c: number } }[] = [];
	for (const [ref, span] of Object.entries(page.merges)) {
		let coords;
		try {
			coords = parseRef(ref);
		} catch {
			continue;
		}
		const [cs, rs] = span;
		if (!(cs >= 1 && rs >= 1) || (cs === 1 && rs === 1)) continue;
		merges.push({
			s: { r: coords.row, c: coords.col },
			e: { r: coords.row + rs - 1, c: coords.col + cs - 1 },
		});
		maxRow = Math.max(maxRow, coords.row + rs - 1);
		maxCol = Math.max(maxCol, coords.col + cs - 1);
	}
	if (merges.length > 0) ws["!merges"] = merges;

	ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxRow, c: maxCol } });
	return ws;
}

/** A whole document -> a workbook, one worksheet per page. */
export function docToWorkbook(XLSX: XlsxModule, doc: SheetDoc): XlsxWorkbook {
	const wb = XLSX.utils.book_new();
	const taken = new Set<string>();
	const pages = doc.sheets.length > 0 ? doc.sheets : [newSheetPage()];
	pages.forEach((page, i) => {
		XLSX.utils.book_append_sheet(wb, pageToSheet(XLSX, page), sheetNameForXlsx(page.name, i, taken));
	});
	return wb;
}

/** The bytes of the `.xlsx` file for a document. */
export function writeXlsx(XLSX: XlsxModule, doc: SheetDoc): Uint8Array {
	const out = XLSX.write(docToWorkbook(XLSX, doc), {
		type: "array",
		bookType: "xlsx",
		// Without this the writer emits a styles table with number formats only.
		cellStyles: true,
		compression: true,
	});
	return out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBuffer);
}

/* -------------------------------------------------------------- import */

/** The read options that decide how much of a file we get to see. */
export const READ_OPTIONS: Record<string, unknown> = {
	type: "array",
	// styles (fills, fonts, alignment, the Styles tables) ...
	cellStyles: true,
	// ... number formats as strings on `z` ...
	cellNF: true,
	// ... formulas ...
	cellFormula: true,
	// ... styled-but-empty cells, which is how an empty formatted row survives ...
	sheetStubs: true,
	// ... and the raw parts, because the reader drops the per-cell style index
	// and every border side (see xlsxstyles.ts).
	bookFiles: true,
	// Dates stay serial numbers plus a mask: that is exactly how this format
	// models a date, and `cellDates` would turn them into Date objects we would
	// only have to convert back.
	cellDates: false,
};

function textOf(entry: { content?: unknown } | undefined): string {
	const content = entry?.content;
	if (typeof content === "string") return content;
	if (content instanceof Uint8Array) return new TextDecoder().decode(content);
	if (Array.isArray(content)) return new TextDecoder().decode(Uint8Array.from(content as number[]));
	return "";
}

/**
 * Rebuild the style of every cell of one worksheet.
 *
 * SheetJS resolved the number format and the fill for us and threw the rest
 * away, so the pointer from a cell to its style (`<c s="3">`) and the border
 * sides are read out of the parts. Everything the reader DID parse - fonts,
 * fills, alignment - is taken from `wb.Styles` rather than re-parsed.
 */
export function sheetStyles(wb: XlsxWorkbook, sheetXml: string): Record<string, CellStyle> {
	const out: Record<string, CellStyle> = {};
	const xf = parseCellXfIndexes(sheetXml);
	const stylesXml = textOf(wb.files?.["xl/styles.xml"]);
	const sides = parseBorderSides(stylesXml);
	const tables = wb.Styles ?? {};
	for (const [ref, index] of Object.entries(xf)) {
		const cellXf = tables.CellXf?.[index];
		if (!cellXf) continue;
		const fontId = Number(cellXf.fontId);
		const fillId = Number(cellXf.fillId);
		const borderId = Number(cellXf.borderId);
		const font = Number.isFinite(fontId) ? tables.Fonts?.[fontId] : undefined;
		const fill = Number.isFinite(fillId) ? tables.Fills?.[fillId] : undefined;
		const style = xlsxToStyle({
			bold: !!font?.bold,
			sz: typeof font?.sz === "number" ? font.sz : Number(font?.sz),
			fgColor: fill?.fgColor?.rgb,
			sides: Number.isFinite(borderId) ? sides[borderId] : undefined,
			alignment: cellXf.alignment,
		});
		if (style) out[ref] = style;
	}
	return out;
}

/** One worksheet -> one page. */
export function sheetToPage(
	XLSX: XlsxModule,
	ws: XlsxSheet,
	name: string,
	styles: Record<string, CellStyle>,
): SheetPage {
	const page = newSheetPage(name);
	let range = { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
	try {
		range = XLSX.utils.decode_range(ws["!ref"] ?? "A1");
	} catch {
		/* a sheet with no !ref is an empty sheet */
	}
	const usedRows = Math.min(Math.max(range.e.r + 1, 1), 100000);
	const usedCols = Math.min(Math.max(range.e.c + 1, 1), 702);
	page.rows = Math.max(usedRows, DEFAULT_ROWS);
	page.cols = Math.max(usedCols, DEFAULT_COLS);

	for (let r = 0; r < usedRows; r++) {
		for (let c = 0; c < usedCols; c++) {
			const ref = cellRef(r, c);
			const raw = ws[ref] as XlsxCell | undefined;
			const style = styles[ref];
			if (!raw && !style) continue;
			const cell: SheetCell = {};
			const formula = formulaFromXlsx(raw?.f);
			if (formula) {
				cell.f = formula;
			} else if (raw) {
				const v = raw.v;
				if (typeof v === "number" && Number.isFinite(v)) cell.v = v;
				else if (typeof v === "boolean") cell.v = v;
				else if (typeof v === "string" && v.length > 0) cell.v = v;
				else if (v instanceof Date) cell.v = v.toISOString().slice(0, 10);
			}
			// The mask is the cell's own `z`, which the reader DOES resolve; the
			// rest of the style came out of the parts.
			const merged: CellStyle = { ...(style ?? {}) };
			const nf = typeof raw?.z === "string" ? raw.z : undefined;
			if (nf && nf.trim().toLowerCase() !== "general") {
				const fromNf = xlsxToStyle({ numFmt: nf });
				if (fromNf?.nf) merged.nf = fromNf.nf;
			}
			if (Object.keys(merged).length > 0) cell.s = merged;
			if (!isEmptyCell(cell)) page.cells[ref] = cell;
		}
	}

	const cols = ws["!cols"] ?? [];
	cols.forEach((col, c) => {
		if (!col || c >= page.cols) return;
		const px = typeof col.wpx === "number" && col.wpx > 0
			? col.wpx
			: typeof col.wch === "number" && col.wch > 0
				? Math.round(col.wch * 7 + 5)
				: 0;
		if (px > 0) page.colWidths[String(c)] = Math.round(px);
	});

	const rows = ws["!rows"] ?? [];
	rows.forEach((row, r) => {
		if (!row || r >= page.rows) return;
		const px = typeof row.hpx === "number" && row.hpx > 0
			? row.hpx
			: typeof row.hpt === "number" && row.hpt > 0
				? Math.round(row.hpt / 0.75)
				: 0;
		if (px > 0) page.rowHeights[String(r)] = Math.round(px);
	});

	for (const merge of ws["!merges"] ?? []) {
		const cs = merge.e.c - merge.s.c + 1;
		const rs = merge.e.r - merge.s.r + 1;
		if (cs < 1 || rs < 1 || (cs === 1 && rs === 1)) continue;
		if (merge.s.r >= page.rows || merge.s.c >= page.cols) continue;
		page.merges[cellRef(merge.s.r, merge.s.c)] = [cs, rs];
	}

	return page;
}

/** A parsed workbook -> our document, one page per worksheet. */
export function workbookToDoc(XLSX: XlsxModule, wb: XlsxWorkbook): SheetDoc {
	const paths = parseSheetPaths(
		textOf(wb.files?.["xl/workbook.xml"]),
		textOf(wb.files?.["xl/_rels/workbook.xml.rels"]),
	);
	const pages: SheetPage[] = [];
	wb.SheetNames.forEach((name, i) => {
		const ws = wb.Sheets[name];
		if (!ws) return;
		// The relationship map is the truthful one; the positional guess is what
		// every producer happens to do, and it is only used when the map failed.
		const path = paths[name] ?? `xl/worksheets/sheet${i + 1}.xml`;
		const styles = sheetStyles(wb, textOf(wb.files?.[path]));
		pages.push(sheetToPage(XLSX, ws, name, styles));
	});
	return {
		format: FORMAT_ID,
		version: CURRENT_VERSION,
		sheets: pages.length > 0 ? pages : [newSheetPage()],
	};
}

/** The bytes of an `.xlsx` file -> our document. */
export function readXlsx(XLSX: XlsxModule, data: ArrayBuffer | Uint8Array): SheetDoc {
	const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
	return workbookToDoc(XLSX, XLSX.read(bytes, READ_OPTIONS));
}
