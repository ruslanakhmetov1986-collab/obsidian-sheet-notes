/**
 * Thin wrapper around jspreadsheet-ce@5 (MIT, vanilla, DOM <table>).
 *
 * Responsibilities:
 *   - map SheetDoc  -> worksheet options (dense data array the engine wants)
 *   - map worksheet -> SheetDoc (sparse, formulas kept as source)
 *   - map our normalized CellStyle <-> a canonical inline CSS string, both ways,
 *     explicitly (we never dump the engine's raw CSS into the file)
 *   - forward every mutation to a single `onChange` callback (autosave hook)
 *   - keep the grid sized to its container via a ResizeObserver
 */

import jspreadsheet from "jspreadsheet-ce";
import "jsuites/dist/jsuites.css";
import "jspreadsheet-ce/dist/jspreadsheet.css";
import type { CellValue as JssCellValue, WorksheetInstance } from "jspreadsheet-ce";
import { cssToStyle, styleToCss } from "./cellcss";
import {
	CURRENT_VERSION,
	FORMAT_ID,
	type CellStyle,
	type CellValue,
	type SheetCell,
	type SheetDoc,
	type SheetPage,
	cellRef,
	isEmptyStyle,
	newSheetPage,
	normalizeStyle,
	parseRef,
} from "./format";

export { cssToStyle, styleToCss };

export const ROOT_CLASS = "leovale-sheet-root";
export const DEFAULT_COL_WIDTH = 100;

/* ------------------------------------------------------------- mapping */

/** Numeric strings are stored as numbers, but only when they round-trip exactly. */
function coerce(value: unknown): CellValue | undefined {
	if (value === null || value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value !== "string") return undefined;
	const s = value;
	if (s === "") return undefined;
	if (/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(s)) {
		const n = Number(s);
		if (Number.isFinite(n) && String(n) === s) return n;
	}
	return s;
}

function docToWorksheets(doc: SheetDoc, readOnly: boolean): Record<string, unknown>[] {
	const pages = doc.sheets.length > 0 ? doc.sheets : [newSheetPage()];
	return pages.map((page) => {
		const rows = Math.max(1, page.rows);
		const cols = Math.max(1, page.cols);
		const data: JssCellValue[][] = [];
		for (let r = 0; r < rows; r++) {
			data.push(new Array(cols).fill("") as JssCellValue[]);
		}

		const style: Record<string, string> = {};
		for (const [ref, cell] of Object.entries(page.cells)) {
			let coords;
			try {
				coords = parseRef(ref);
			} catch {
				continue;
			}
			const { row, col } = coords;
			if (row < 0 || row >= rows || col < 0 || col >= cols) continue;
			const target = data[row];
			if (!target) continue;
			// A formula wins over a cached literal: results are always recomputed.
			target[col] = cell.f !== undefined ? cell.f : ((cell.v as JssCellValue) ?? "");
			if (!isEmptyStyle(cell.s)) style[ref] = styleToCss(cell.s);
		}

		const columns: Record<string, unknown>[] = [];
		for (let c = 0; c < cols; c++) {
			const w = page.colWidths[String(c)];
			columns.push({
				width: typeof w === "number" && w > 0 ? w : DEFAULT_COL_WIDTH,
				align: "left",
				readOnly,
			});
		}

		const rowsOpt: Record<string, { height: number }> = {};
		for (const [k, h] of Object.entries(page.rowHeights)) {
			if (typeof h === "number" && h > 0) rowsOpt[k] = { height: h };
		}

		return {
			worksheetName: page.name,
			minDimensions: [cols, rows],
			data,
			columns,
			rows: rowsOpt,
			style,
			mergeCells: { ...page.merges },
			tableOverflow: false,
			allowManualInsertRow: !readOnly,
			allowManualInsertColumn: !readOnly,
			// Reordering would make the saved column order a lie (we persist by
			// index, not identity), so it stays off. See README "Ограничения".
			columnDrag: false,
			rowDrag: false,
			search: false,
			about: false,
		};
	});
}

export interface EngineOptions {
	/** Called after every mutation (cell edit, resize, style, insert, undo). */
	onChange: () => void;
	/**
	 * Called whenever the grid's selection changes, including by touch. The
	 * toolbar and the formula bar hang off this instead of mouse/key events,
	 * which a tablet never sends.
	 */
	onSelection?: () => void;
	/** Future-version documents render read-only so we never write them back. */
	readOnly?: boolean;
}

export class SheetEngine {
	private root: HTMLElement;
	private host: HTMLElement;
	private worksheets: WorksheetInstance[] | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private readOnly: boolean;
	/** Names are not editable from the grid; keep the parsed ones. */
	private pageNames: string[];
	private version: number;
	private notify: () => void;
	/**
	 * Last non-empty grid selection. Clicking a toolbar control makes
	 * jspreadsheet reset its own selection (document-level mousedown handler),
	 * so the toolbar would otherwise always act on nothing.
	 */
	private lastSelection: [number, number, number, number] | null = null;
	/** Suppresses autosave while we replay the stored layout at load time. */
	private suspend = false;

	constructor(parent: HTMLElement, doc: SheetDoc, opts: EngineOptions) {
		this.readOnly = !!opts.readOnly;
		this.pageNames = doc.sheets.map((s) => s.name);
		this.version = doc.version;

		this.root = parent.createDiv({ cls: ROOT_CLASS });
		this.host = this.root.createDiv({ cls: "leovale-sheet-host" });

		const notify = () => {
			if (!this.readOnly && !this.suspend) opts.onChange();
		};
		this.notify = notify;

		this.worksheets = jspreadsheet(this.host as HTMLDivElement, {
			worksheets: docToWorksheets(doc, this.readOnly) as never,
			parseFormulas: true,
			tabs: doc.sheets.length > 1,
			about: false,
			toolbar: false,
			onselection: (_ws: unknown, x1: number, y1: number, x2: number, y2: number) => {
				const rect = [x1, y1, x2, y2];
				if (rect.every((n) => typeof n === "number" && Number.isFinite(n))) {
					this.lastSelection = [x1, y1, x2, y2];
				}
				try {
					opts.onSelection?.();
				} catch (e) {
					console.error("leovale-sheets: selection listener failed", e);
				}
			},
			onafterchanges: notify,
			onchange: notify,
			onchangestyle: notify,
			oninsertrow: notify,
			ondeleterow: notify,
			oninsertcolumn: notify,
			ondeletecolumn: notify,
			onresizecolumn: notify,
			onresizerow: notify,
			onmerge: notify,
			onundo: notify,
			onredo: notify,
			onpaste: notify,
			onsort: notify,
		} as never);

		this.applyStoredRowHeights(doc);
		this.observeResize();
	}

	/**
	 * The `rows` worksheet option is honoured for bookkeeping but not applied to
	 * the rendered <tr> heights on first paint, so replay it explicitly. Wrapped
	 * in `suspend` so re-opening a file never marks it dirty.
	 */
	private applyStoredRowHeights(doc: SheetDoc): void {
		this.suspend = true;
		try {
			doc.sheets.forEach((page, i) => {
				const ws = this.worksheets?.[i];
				if (!ws) return;
				for (const [k, h] of Object.entries(page.rowHeights)) {
					const row = Number(k);
					if (!Number.isInteger(row) || row < 0 || typeof h !== "number" || h <= 0) continue;
					try {
						ws.setHeight(row, h);
					} catch {
						/* row out of range */
					}
				}
			});
		} finally {
			this.suspend = false;
		}
	}

	private observeResize(): void {
		if (typeof ResizeObserver === "undefined") return;
		let last = 0;
		this.resizeObserver = new ResizeObserver(() => {
			const now = Date.now();
			if (now - last < 50) return;
			last = now;
			this.refresh();
		});
		this.resizeObserver.observe(this.root);
	}

	/** Kick the engine after a container resize; harmless if it is already correct. */
	refresh(): void {
		const ws = this.first();
		if (!ws) return;
		try {
			(ws as unknown as { refresh?: () => void }).refresh?.();
		} catch {
			/* engine already torn down */
		}
	}

	private first(): WorksheetInstance | null {
		return this.worksheets?.[0] ?? null;
	}

	get isReadOnly(): boolean {
		return this.readOnly;
	}

	/* --------------------------------------------------------- selection */

	private static validRect(rect: unknown): number[] | null {
		if (!Array.isArray(rect) || rect.length < 4) return null;
		const nums = rect.slice(0, 4).map((n) => Number(n));
		return nums.every((n) => Number.isFinite(n) && n >= 0) ? nums : null;
	}

	/**
	 * A1-style refs of the current selection (at least the anchor cell).
	 * Falls back to the last remembered selection, because jspreadsheet drops
	 * its own selection as soon as the user clicks the toolbar.
	 */
	getSelectionRefs(): string[] {
		const ws = this.first();
		if (!ws) return [];
		let sel: number[] | null = null;
		try {
			sel = SheetEngine.validRect(ws.getSelection());
		} catch {
			sel = null;
		}
		if (!sel) {
			sel = SheetEngine.validRect((ws as unknown as { selectedCell?: unknown }).selectedCell);
		}
		if (!sel) sel = SheetEngine.validRect(this.lastSelection);
		if (!sel) return [];
		const x1 = Math.min(sel[0] as number, sel[2] as number);
		const x2 = Math.max(sel[0] as number, sel[2] as number);
		const y1 = Math.min(sel[1] as number, sel[3] as number);
		const y2 = Math.max(sel[1] as number, sel[3] as number);
		const refs: string[] = [];
		for (let y = y1; y <= y2; y++) {
			for (let x = x1; x <= x2; x++) refs.push(cellRef(y, x));
		}
		return refs;
	}

	/* -------------------------------------------------------- raw cell value */

	/**
	 * The cell's RAW content: the formula source for a formula cell, the literal
	 * otherwise. `getValue(ref, false)` reads `options.data`, not the rendered
	 * result, which is exactly what the formula bar has to show.
	 */
	getRawValue(ref: string): CellValue | null {
		const ws = this.first();
		if (!ws) return null;
		try {
			const v = ws.getValue(ref, false);
			if (v === null || v === undefined) return null;
			if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
			return String(v);
		} catch {
			return null;
		}
	}

	/** Write raw text into a cell (formula source included) and mark dirty. */
	setRawValue(ref: string, value: string): void {
		const ws = this.first();
		if (!ws || this.readOnly) return;
		try {
			ws.setValue(ref, value as JssCellValue);
		} catch (e) {
			console.error("leovale-sheets: setValue failed", e);
			return;
		}
		this.notify();
	}

	/** Current normalized style of a single cell. */
	getStyleAt(ref: string): CellStyle {
		const ws = this.first();
		if (!ws) return {};
		try {
			return cssToStyle(ws.getStyle(ref) as string) ?? {};
		} catch {
			return {};
		}
	}

	/**
	 * Apply a style patch to a set of cells. `patch` receives the cell's current
	 * style and its position inside the selection rectangle so callers can build
	 * outlines.
	 */
	applyStyle(
		refs: string[],
		patch: (current: CellStyle, ref: string, index: number) => CellStyle,
	): void {
		const ws = this.first();
		if (!ws || this.readOnly || refs.length === 0) return;
		const update: Record<string, string> = {};
		refs.forEach((ref, i) => {
			const next = normalizeStyle(patch(this.getStyleAt(ref), ref, i)) ?? {};
			update[ref] = styleToCss(next);
		});
		try {
			(ws.setStyle as (o: Record<string, string>, k?: null, v?: null, force?: boolean) => void)(
				update,
				null,
				null,
				true,
			);
		} catch (e) {
			console.error("leovale-sheets: setStyle failed", e);
			return;
		}
		this.notify();
	}

	focus(): void {
		const first = this.host.querySelector<HTMLElement>("tbody td[data-x]");
		first?.click();
	}

	/**
	 * Cancel the engine's pending long-press-to-edit timer.
	 *
	 * `touchstart` on a cell arms a 500 ms timer that opens the in-cell editor;
	 * the engine cancels it from its own `touchmove` listener on `document`. We
	 * stop `touchmove` from bubbling out of the grid (otherwise Obsidian reads a
	 * horizontal pan as "open the left drawer"), which also hides the event from
	 * that listener, so the timer has to be cancelled here instead. Without this
	 * a half-second scroll would pop the cell editor open.
	 */
	cancelTouchHold(): void {
		const base = jspreadsheet as unknown as {
			timeControl?: ReturnType<typeof setTimeout> | null;
			tmpElement?: unknown;
		};
		if (base.timeControl) {
			clearTimeout(base.timeControl);
			base.timeControl = null;
			base.tmpElement = null;
		}
	}

	/* ------------------------------------------------------------ reading */

	/** Read the live grid back into a sparse document. */
	readDoc(): SheetDoc {
		const list = this.worksheets ?? [];
		const pages: SheetPage[] = list.map((ws, index) => {
			const opts = (ws as unknown as { options: Record<string, unknown> }).options ?? {};
			const raw = (opts["data"] as unknown[][] | undefined) ?? [];
			const page = newSheetPage(this.pageNames[index] ?? `Sheet${index + 1}`);
			page.rows = Math.max(1, raw.length);
			page.cols = Math.max(1, (raw[0] as unknown[] | undefined)?.length ?? 1);

			for (let r = 0; r < raw.length; r++) {
				const row = raw[r];
				if (!Array.isArray(row)) continue;
				for (let c = 0; c < row.length; c++) {
					const value = row[c];
					const cell: SheetCell = {};
					if (typeof value === "string" && value.startsWith("=")) {
						cell.f = value;
					} else {
						const v = coerce(value);
						if (v !== undefined) cell.v = v;
					}
					if (cell.v !== undefined || cell.f !== undefined) page.cells[cellRef(r, c)] = cell;
				}
			}

			// Styles live in the engine (it shifts them on row/column insert), so
			// they are read back from there and mapped explicitly.
			const styles = (opts["style"] as Record<string, unknown> | undefined) ?? {};
			for (const [ref, css] of Object.entries(styles)) {
				const style = cssToStyle(css);
				if (!style) continue;
				let coords;
				try {
					coords = parseRef(ref);
				} catch {
					continue;
				}
				if (coords.row >= page.rows || coords.col >= page.cols) continue;
				const cell = page.cells[ref] ?? {};
				cell.s = style;
				page.cells[ref] = cell;
			}

			const columns = (opts["columns"] as { width?: number | string }[] | undefined) ?? [];
			columns.forEach((col, c) => {
				const w = typeof col?.width === "string" ? parseInt(col.width, 10) : col?.width;
				if (typeof w === "number" && Number.isFinite(w) && w > 0 && w !== DEFAULT_COL_WIDTH) {
					page.colWidths[String(c)] = Math.round(w);
				}
			});

			const rowsOpt = opts["rows"];
			if (rowsOpt && typeof rowsOpt === "object") {
				for (const [k, def] of Object.entries(rowsOpt as Record<string, { height?: unknown }>)) {
					if (!/^[0-9]+$/.test(k)) continue;
					const hRaw = def?.height;
					const h = typeof hRaw === "string" ? parseInt(hRaw, 10) : hRaw;
					if (typeof h === "number" && Number.isFinite(h) && h > 0) {
						page.rowHeights[k] = Math.round(h);
					}
				}
			}

			const merges = opts["mergeCells"];
			if (merges && typeof merges === "object") {
				for (const [k, span] of Object.entries(merges as Record<string, unknown>)) {
					if (Array.isArray(span) && span.length >= 2) {
						const cs = Number(span[0]);
						const rs = Number(span[1]);
						if (Number.isFinite(cs) && Number.isFinite(rs) && cs >= 1 && rs >= 1) {
							page.merges[k] = [Math.round(cs), Math.round(rs)];
						}
					}
				}
			}

			return page;
		});

		return {
			format: FORMAT_ID,
			version: this.version || CURRENT_VERSION,
			sheets: pages.length > 0 ? pages : [newSheetPage()],
		};
	}

	destroy(): void {
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		try {
			// `true` also removes the document-level key/mouse handlers, otherwise
			// the grid keeps eating Obsidian hotkeys after the tab is closed.
			jspreadsheet.destroy(this.host as never, true);
		} catch (e) {
			console.error("leovale-sheets: engine destroy failed", e);
		}
		this.worksheets = null;
		this.root.detach();
	}
}
