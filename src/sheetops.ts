/**
 * Document-level operations on a {@link SheetPage}: sorting, filtering,
 * searching, Markdown-table interop and the keyboard navigation targets.
 *
 * Everything here is a PURE function over the parsed document. Nothing imports
 * the grid engine, which is what makes all of it unit-testable - and, in the
 * case of sorting, what makes it correct in the first place.
 *
 * WHY SORTING IS NOT THE ENGINE'S. `worksheet.orderBy()` permutes
 * `options.data` and the `<tr>` elements, but the styles it does not touch:
 * they live in `options.style` keyed by A1 address, and a number/date mask
 * lives in a `data-nf` attribute on the cell element. After an engine sort the
 * values have moved and the style map has not, so a bold red row would end up
 * lending its formatting to whatever row landed on its address - and that is
 * what would be written to disk. Here a row is moved as a WHOLE: value,
 * formula, style and mask travel together, because in our document they are one
 * object.
 */

import {
	type CellValue,
	type PageFreeze,
	type SheetCell,
	type SheetPage,
	type SortDir,
	cellRef,
	parseRef,
} from "./format";

/* -------------------------------------------------------------- reading */

/** Reads a cell's sort/filter/search key. The engine passes the RENDERED one. */
export type ValueReader = (row: number, col: number) => CellValue | undefined;

/** Fallback reader: the document's own raw content, formula source included. */
export function rawReader(page: SheetPage): ValueReader {
	return (row, col) => {
		const cell = page.cells[cellRef(row, col)];
		if (!cell) return undefined;
		if (cell.v !== undefined && cell.v !== "") return cell.v;
		return cell.f;
	};
}

/** The comparable text of a value; "" for anything empty. */
export function keyText(value: CellValue | undefined): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	return String(value);
}

function asNumber(value: CellValue | undefined): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value !== "string") return undefined;
	const s = value.trim();
	if (s === "") return undefined;
	// Accept the shapes a grid actually produces, not everything Number() eats
	// ("0x10", " 12 " and "" all become numbers there).
	if (!/^-?[0-9]+(\.[0-9]+)?$/.test(s)) return undefined;
	const n = Number(s);
	return Number.isFinite(n) ? n : undefined;
}

/**
 * Spreadsheet ordering: empties always last (in BOTH directions, like Google
 * Sheets), then numbers before text, text compared case-insensitively with a
 * case-sensitive tie-break so the result is total and reproducible.
 */
export function compareValues(a: CellValue | undefined, b: CellValue | undefined): number {
	const ta = keyText(a);
	const tb = keyText(b);
	if (ta === "" || tb === "") return ta === tb ? 0 : ta === "" ? 1 : -1;
	const na = asNumber(a);
	const nb = asNumber(b);
	if (na !== undefined && nb !== undefined) return na === nb ? 0 : na < nb ? -1 : 1;
	if (na !== undefined) return -1;
	if (nb !== undefined) return 1;
	const la = ta.toLowerCase();
	const lb = tb.toLowerCase();
	if (la !== lb) return la < lb ? -1 : 1;
	return ta === tb ? 0 : ta < tb ? -1 : 1;
}

/* ----------------------------------------------------------------- sort */

export interface SortResult {
	/** A new page; the input is not modified. */
	page: SheetPage;
	/** `order[i]` is the source row of the i-th row of the sorted region. */
	order: number[];
	/** True when a row holding a formula actually changed position. */
	movedFormula: boolean;
}

/** Deep-enough copy of a cell: the style is the only nested object. */
function copyCell(cell: SheetCell): SheetCell {
	const out: SheetCell = {};
	if (cell.v !== undefined) out.v = cell.v;
	if (cell.f !== undefined) out.f = cell.f;
	if (cell.s) out.s = { ...cell.s };
	return out;
}

/**
 * Sort the page by one column, moving whole rows.
 *
 * `headerRows` rows stay where they are - that is how frozen rows earn their
 * keep, exactly like in Google Sheets, where a frozen top row is never part of
 * the sorted range.
 *
 * `merges` are left untouched: a merge spans addresses, and permuting the rows
 * underneath one would either tear it apart or silently swallow cells. The
 * caller refuses to sort a page that has any (see `SheetEngine.sortByColumn`).
 */
export function sortPage(
	page: SheetPage,
	col: number,
	dir: SortDir,
	headerRows = 0,
	read?: ValueReader,
): SortResult {
	const value = read ?? rawReader(page);
	const start = Math.max(0, Math.min(headerRows, page.rows));
	const indices: number[] = [];
	for (let r = start; r < page.rows; r++) indices.push(r);

	const sign = dir === "desc" ? -1 : 1;
	const order = indices
		.map((row, i) => ({ row, i, key: value(row, col) }))
		.sort((a, b) => {
			const ta = keyText(a.key);
			const tb = keyText(b.key);
			// Empty rows sink to the bottom in both directions; everything else is
			// mirrored by `sign`. `i` keeps the sort stable across engines.
			if (ta === "" || tb === "") {
				if (ta === tb) return a.i - b.i;
				return ta === "" ? 1 : -1;
			}
			const c = compareValues(a.key, b.key);
			return c !== 0 ? c * sign : a.i - b.i;
		})
		.map((entry) => entry.row);

	const next: SheetPage = {
		...page,
		colWidths: { ...page.colWidths },
		rowHeights: {},
		merges: { ...page.merges },
		view: { ...page.view, sort: { col, dir } },
		freeze: { ...page.freeze },
		cells: {},
	};
	if (page.view.filters) next.view.filters = { ...page.view.filters };

	// The rows above the sorted region keep everything they had.
	for (let r = 0; r < start; r++) {
		for (let c = 0; c < page.cols; c++) {
			const cell = page.cells[cellRef(r, c)];
			if (cell) next.cells[cellRef(r, c)] = copyCell(cell);
		}
		const h = page.rowHeights[String(r)];
		if (h !== undefined) next.rowHeights[String(r)] = h;
	}

	let movedFormula = false;
	order.forEach((src, i) => {
		const dst = start + i;
		for (let c = 0; c < page.cols; c++) {
			const cell = page.cells[cellRef(src, c)];
			if (!cell) continue;
			if (cell.f !== undefined && src !== dst) movedFormula = true;
			next.cells[cellRef(dst, c)] = copyCell(cell);
		}
		const h = page.rowHeights[String(src)];
		if (h !== undefined) next.rowHeights[String(dst)] = h;
	});

	return { page: next, order, movedFormula };
}

/* -------------------------------------------------------------- filters */

/** Every distinct value of a column, as display strings, in first-seen order. */
export function distinctValues(
	page: SheetPage,
	col: number,
	headerRows = 0,
	read?: ValueReader,
	limit = 200,
): string[] {
	const value = read ?? rawReader(page);
	const out: string[] = [];
	const seen = new Set<string>();
	for (let r = Math.max(0, headerRows); r < page.rows; r++) {
		const text = keyText(value(r, col));
		if (text === "" || seen.has(text)) continue;
		seen.add(text);
		out.push(text);
		if (out.length >= limit) break;
	}
	return out.sort((a, b) => compareValues(a, b));
}

/**
 * Rows the current filters hide. A row is visible when EVERY filtered column of
 * it holds one of that column's allowed values; header rows are never hidden.
 *
 * A BLANK cell is never filtered out. The menu lists the values a column
 * actually holds, and blank is not one of them, so a filter that hid the empty
 * rows would hide the whole tail of a 100-row sheet with no way to bring it
 * back except clearing the filter. Blank means "not part of this data", not "a
 * value you did not tick".
 */
export function hiddenRows(
	page: SheetPage,
	headerRows = 0,
	read?: ValueReader,
): number[] {
	const filters = page.view.filters;
	if (!filters) return [];
	const entries = Object.entries(filters)
		.map(([k, values]) => [parseInt(k, 10), new Set(values)] as const)
		.filter(([col]) => Number.isInteger(col) && col >= 0 && col < page.cols);
	if (entries.length === 0) return [];
	const value = read ?? rawReader(page);
	const out: number[] = [];
	for (let r = Math.max(0, headerRows); r < page.rows; r++) {
		for (const [col, allowed] of entries) {
			const text = keyText(value(r, col));
			if (text !== "" && !allowed.has(text)) {
				out.push(r);
				break;
			}
		}
	}
	return out;
}

/* --------------------------------------------------------------- search */

/** Refs of the cells whose text contains `query`, case-insensitively. */
export function findMatches(page: SheetPage, query: string, read?: ValueReader): string[] {
	const needle = query.trim().toLowerCase();
	if (needle === "") return [];
	const value = read ?? rawReader(page);
	const out: string[] = [];
	for (let r = 0; r < page.rows; r++) {
		for (let c = 0; c < page.cols; c++) {
			const text = keyText(value(r, c));
			if (text !== "" && text.toLowerCase().includes(needle)) out.push(cellRef(r, c));
		}
	}
	return out;
}

/* ------------------------------------------------------ markdown tables */

/** `|` is the column separator, so it has to be escaped inside a value. */
export function escapeMarkdownCell(text: string): string {
	return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

export function unescapeMarkdownCell(text: string): string {
	return text
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/\\([\\|])/g, "$1");
}

/** Per-column alignment of the separator row, from our own `ha` codes. */
export type MdAlign = "l" | "c" | "r" | undefined;

function separatorCell(align: MdAlign): string {
	if (align === "c") return ":---:";
	if (align === "r") return "---:";
	if (align === "l") return ":---";
	return "---";
}

/**
 * A GitHub-style Markdown table. The first row is the header, because that is
 * what a Markdown table is; a one-row selection therefore produces a table with
 * an empty body, which is still valid Markdown.
 */
export function toMarkdownTable(rows: string[][], aligns: MdAlign[] = []): string {
	if (rows.length === 0) return "";
	const width = rows.reduce((n, row) => Math.max(n, row.length), 0);
	const line = (row: string[]) => {
		const cells: string[] = [];
		for (let i = 0; i < width; i++) cells.push(escapeMarkdownCell(row[i] ?? ""));
		return `| ${cells.join(" | ")} |`;
	};
	const out: string[] = [line(rows[0] as string[])];
	const seps: string[] = [];
	for (let i = 0; i < width; i++) seps.push(separatorCell(aligns[i]));
	out.push(`| ${seps.join(" | ")} |`);
	for (let r = 1; r < rows.length; r++) out.push(line(rows[r] as string[]));
	return out.join("\n");
}

const SEPARATOR_CELL_RE = /^:?-{1,}:?$/;

/** Split one table row on the pipes that are not escaped. */
function splitRow(line: string): string[] {
	const cells: string[] = [];
	let cur = "";
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === "\\" && i + 1 < line.length) {
			cur += ch + line[i + 1];
			i++;
			continue;
		}
		if (ch === "|") {
			cells.push(cur);
			cur = "";
			continue;
		}
		cur += ch;
	}
	cells.push(cur);
	// A row written with the usual leading and trailing pipe yields an empty
	// first and last field; those are punctuation, not data.
	if (cells.length > 1 && cells[0]?.trim() === "") cells.shift();
	if (cells.length > 1 && cells[cells.length - 1]?.trim() === "") cells.pop();
	return cells.map((c) => unescapeMarkdownCell(c.trim()));
}

function isSeparatorRow(cells: string[]): boolean {
	return cells.length > 0 && cells.every((c) => SEPARATOR_CELL_RE.test(c.replace(/\s/g, "")));
}

/**
 * Parse a Markdown table into a rectangular grid of strings. Tolerant on
 * purpose: the alignment row is optional and may sit anywhere in the first two
 * lines, rows may be ragged, and surrounding prose lines that hold no pipe are
 * ignored. Returns [] when the text is not a table at all.
 */
export function parseMarkdownTable(text: string): string[][] {
	const rows: string[][] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || !line.includes("|")) continue;
		const cells = splitRow(line);
		if (isSeparatorRow(cells)) continue;
		rows.push(cells);
	}
	if (rows.length === 0) return [];
	const width = rows.reduce((n, row) => Math.max(n, row.length), 0);
	return rows.map((row) => {
		const out = row.slice(0, width);
		while (out.length < width) out.push("");
		return out;
	});
}

/** Alignment codes of a Markdown separator row, for the paste direction. */
export function markdownAligns(text: string): MdAlign[] {
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || !line.includes("|")) continue;
		const cells = splitRow(line);
		if (!isSeparatorRow(cells)) continue;
		return cells.map((c) => {
			const s = c.replace(/\s/g, "");
			const left = s.startsWith(":");
			const right = s.endsWith(":");
			if (left && right) return "c";
			if (right) return "r";
			if (left) return "l";
			return undefined;
		});
	}
	return [];
}

/* ------------------------------------------------- keyboard destinations */

export interface Cursor {
	row: number;
	col: number;
}

export type Filled = (row: number, col: number) => boolean;

export interface GridBounds {
	rows: number;
	cols: number;
}

/**
 * Ctrl+Arrow, Google Sheets semantics: from a filled cell, run to the last
 * filled cell of the current block; from an empty one, jump to the next filled
 * cell; when there is nothing left in that direction, land on the grid edge.
 */
export function dataEdge(
	from: Cursor,
	dRow: number,
	dCol: number,
	filled: Filled,
	bounds: GridBounds,
): Cursor {
	const inside = (r: number, c: number) => r >= 0 && c >= 0 && r < bounds.rows && c < bounds.cols;
	let { row, col } = from;
	if (!inside(row, col)) return from;
	const next = (r: number, c: number): Cursor => ({ row: r + dRow, col: c + dCol });

	let step = next(row, col);
	if (!inside(step.row, step.col)) return { row, col };

	if (filled(row, col) && filled(step.row, step.col)) {
		// inside a block: stop on its last filled cell
		while (inside(step.row, step.col) && filled(step.row, step.col)) {
			row = step.row;
			col = step.col;
			step = next(row, col);
		}
		return { row, col };
	}

	// otherwise: the next filled cell, or the far edge if there is none
	while (inside(step.row, step.col)) {
		if (filled(step.row, step.col)) return { row: step.row, col: step.col };
		row = step.row;
		col = step.col;
		step = next(row, col);
	}
	return { row, col };
}

/** End: the last filled column of the row, or the row start when it is empty. */
export function rowEnd(row: number, filled: Filled, bounds: GridBounds): number {
	for (let c = bounds.cols - 1; c >= 0; c--) {
		if (filled(row, c)) return c;
	}
	return 0;
}

/** Ctrl+End: the bottom-right corner of the filled area (A1 for an empty grid). */
export function usedEnd(filled: Filled, bounds: GridBounds): Cursor {
	let row = 0;
	let col = 0;
	for (let r = 0; r < bounds.rows; r++) {
		for (let c = 0; c < bounds.cols; c++) {
			if (!filled(r, c)) continue;
			if (r > row) row = r;
			if (c > col) col = c;
		}
	}
	return { row, col };
}

/* --------------------------------------------------------------- freeze */

/** Freeze from a selection anchor: everything above and left of it is frozen. */
export function freezeFromRef(ref: string, axis: "rows" | "cols" | "both"): PageFreeze {
	const { row, col } = parseRef(ref);
	const out: PageFreeze = {};
	if (axis !== "cols" && row > 0) out.rows = row;
	if (axis !== "rows" && col > 0) out.cols = col;
	return out;
}
