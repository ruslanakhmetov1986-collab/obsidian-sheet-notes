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
import { WRAP_CLASS, WRAP_ON, cssToStyle, styleToCss } from "./cellcss";
import { formatValue } from "./numfmt";
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
	normalizeNf,
	normalizeStyle,
	parseRef,
} from "./format";

export { cssToStyle, styleToCss };

export const ROOT_CLASS = "leovale-sheet-root";
export const DEFAULT_COL_WIDTH = 100;

/**
 * Where a cell's number/date mask lives at runtime.
 *
 * A data attribute on the `<td>`, not the inline style (a mask can contain `:`
 * and `;`, which the engine's own style parser splits on) and not a map keyed by
 * A1 ref (that would go stale the moment a row is inserted). An attribute rides
 * along with the element exactly like the inline style does, so the engine's
 * row/column bookkeeping shifts it for free.
 */
export const NF_ATTR = "data-nf";
/** The engine's own rendering of the cell, kept so formatting is reversible. */
const NF_SRC_ATTR = "data-nf-src";
/** What we last wrote, so a value change can be told apart from our own output. */
const NF_OUT_ATTR = "data-nf-out";

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

/**
 * Take the engine's document-level handlers off `document` for good.
 *
 * Why this exists. The engine installs `keydown` and `mousedown` handlers on
 * `document` when its first instance is created, and only removes them from
 * inside `jspreadsheet.destroy(el, true)`. Each LOAD of the plugin gets its own
 * copy of the bundled engine, with its own handler functions and its own
 * `current` pointer, and every copy's `mousedown` handler happily adopts
 * whatever grid was clicked. So a leftover copy is not idle: it moves the live
 * selection as well. Measured in the sandbox after ten plugin reloads with a
 * sheet tab open: one ArrowRight moved eleven columns.
 *
 * There is no exported `destroyEvents`, so the only way to reach it is to hand
 * `destroy()` a live instance with the flag set. A 1x1 throwaway grid is that
 * instance; it never enters the DOM the user sees.
 */
export async function releaseEngineGlobals(): Promise<void> {
	const host = document.createElement("div") as HTMLDivElement & { spreadsheet?: unknown };
	try {
		jspreadsheet(host, {
			worksheets: [{ minDimensions: [1, 1] }],
			toolbar: false,
			about: false,
		} as never);
		// The factory is ASYNC underneath: it returns the worksheet array straight
		// away but assigns `el.spreadsheet` in a promise continuation, and
		// `destroy()` does nothing at all without that property. Destroying too
		// early is worse than not trying: the instance has already installed the
		// handlers, so a no-op teardown ADDS a set instead of removing one. Which
		// is exactly what the first version of this function did.
		for (let i = 0; i < 25 && !host.spreadsheet; i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		if (!host.spreadsheet) {
			console.warn("leovale-sheets: the throwaway grid never came up; handlers left in place");
			return;
		}
		jspreadsheet.destroy(host as never, true as never);
		(jspreadsheet as unknown as { current?: unknown }).current = null;
	} catch (e) {
		console.warn("leovale-sheets: could not release the engine's global handlers", e);
	} finally {
		host.remove();
	}
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

		// Decor (masked text, wrap class) is re-applied on EVERY engine event,
		// read-only documents and load-time replays included: the engine rewrites
		// a cell's text from the raw value whenever it changes, which silently
		// undoes the mask. Autosave stays gated on the flags.
		const notify = () => {
			this.syncDecor();
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
		this.applyStoredMasks(doc);
		this.syncDecor();
		this.observeResize();
	}

	/**
	 * Replay the stored `nf` masks onto the cells. Suppressed like the row
	 * heights: reopening a file must not mark it modified.
	 */
	private applyStoredMasks(doc: SheetDoc): void {
		this.suspend = true;
		try {
			doc.sheets.forEach((page, i) => {
				for (const [ref, cell] of Object.entries(page.cells)) {
					const nf = normalizeNf(cell.s?.nf);
					if (!nf) continue;
					this.cellElement(ref, i)?.setAttribute(NF_ATTR, nf);
				}
			});
		} finally {
			this.suspend = false;
		}
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

	/* --------------------------------------------------- cells and their decor */

	/** The live `<td>` of a cell, or null when the ref is outside the grid. */
	private cellElement(ref: string, sheet = 0): HTMLElement | null {
		const ws = this.worksheets?.[sheet];
		if (!ws) return null;
		let coords;
		try {
			coords = parseRef(ref);
		} catch {
			return null;
		}
		const records = (ws as unknown as { records?: { element?: HTMLElement }[][] }).records;
		return records?.[coords.row]?.[coords.col]?.element ?? null;
	}

	/** Number/date mask of a cell, as stored on its element. */
	getNfAt(ref: string): string | undefined {
		return normalizeNf(this.cellElement(ref)?.getAttribute(NF_ATTR));
	}

	/**
	 * Re-render the text of one masked cell.
	 *
	 * The engine owns the cell's text: on every value change it writes the raw
	 * value (or the computed formula result) into the element. So the mask is
	 * applied on top, and the pre-mask text is remembered in an attribute. Which
	 * of the two is the current truth is decided by comparing the element's text
	 * with our last output: if they differ, the engine has re-rendered and its
	 * text wins.
	 */
	private decorateCell(el: HTMLElement): void {
		// An open editor is an <input> inside the cell; writing text would eat it.
		if (el.classList.contains("editor") || el.childElementCount > 0) return;
		const mask = normalizeNf(el.getAttribute(NF_ATTR));
		if (!mask) {
			this.undecorateCell(el);
			return;
		}
		const shown = el.textContent ?? "";
		const last = el.getAttribute(NF_OUT_ATTR);
		const kept = el.getAttribute(NF_SRC_ATTR);
		const raw = last !== null && shown === last && kept !== null ? kept : shown;
		const out = formatValue(raw, mask);
		if (out !== shown) el.textContent = out;
		el.setAttribute(NF_SRC_ATTR, raw);
		el.setAttribute(NF_OUT_ATTR, out);
	}

	/** Put the engine's own rendering back and forget the mask bookkeeping. */
	private undecorateCell(el: HTMLElement): void {
		const last = el.getAttribute(NF_OUT_ATTR);
		const kept = el.getAttribute(NF_SRC_ATTR);
		if (last !== null && kept !== null && (el.textContent ?? "") === last) {
			el.textContent = kept;
		}
		el.removeAttribute(NF_SRC_ATTR);
		el.removeAttribute(NF_OUT_ATTR);
	}

	/**
	 * Bring every decorated cell back in step with the engine: masked text and
	 * the wrap class (the class does the wrapping, because the engine overwrites
	 * `style.whiteSpace` itself - see cellcss.ts).
	 *
	 * Cheap by construction: it only ever looks at cells that carry a mask, a
	 * wrap marker or a stale wrap class, not at the whole grid.
	 */
	syncDecor(): void {
		const host = this.host;
		if (!host.isConnected && !host.firstChild) return;
		try {
			host.querySelectorAll<HTMLElement>(`td[${NF_ATTR}]`).forEach((el) => this.decorateCell(el));
			host.querySelectorAll<HTMLElement>(`td.${WRAP_CLASS}`).forEach((el) => {
				if (!el.style.overflowWrap.includes(WRAP_ON)) el.classList.remove(WRAP_CLASS);
			});
			host
				.querySelectorAll<HTMLElement>(`td[style*="${WRAP_ON}"]`)
				.forEach((el) => el.classList.add(WRAP_CLASS));
		} catch (e) {
			console.error("leovale-sheets: decor sync failed", e);
		}
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

	/** Current normalized style of a single cell, mask included. */
	getStyleAt(ref: string): CellStyle {
		const ws = this.first();
		if (!ws) return {};
		let style: CellStyle = {};
		try {
			style = cssToStyle(ws.getStyle(ref) as string) ?? {};
		} catch {
			style = {};
		}
		const nf = this.getNfAt(ref);
		if (nf) style.nf = nf;
		return style;
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
		const masks: [string, string | undefined][] = [];
		refs.forEach((ref, i) => {
			const next = normalizeStyle(patch(this.getStyleAt(ref), ref, i)) ?? {};
			update[ref] = styleToCss(next);
			masks.push([ref, next.nf]);
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
		// `nf` is not CSS, so it is written separately (see NF_ATTR).
		for (const [ref, mask] of masks) {
			const el = this.cellElement(ref);
			if (!el) continue;
			if (mask) {
				el.setAttribute(NF_ATTR, mask);
			} else if (el.hasAttribute(NF_ATTR)) {
				el.removeAttribute(NF_ATTR);
				this.undecorateCell(el);
			}
		}
		this.notify();
	}

	focus(): void {
		const first = this.host.querySelector<HTMLElement>("tbody td[data-x]");
		first?.click();
	}

	/* ------------------------------------------------------------- cropping */

	/** Grid size as the engine currently sees it. */
	dimensions(): { rows: number; cols: number } {
		const ws = this.first();
		const data = ((ws as unknown as { options?: { data?: unknown[][] } })?.options?.data ??
			[]) as unknown[][];
		return { rows: data.length, cols: (data[0] as unknown[] | undefined)?.length ?? 0 };
	}

	/**
	 * Bounding box of the cells that actually hold something, as row/column
	 * indexes. An embed shows this instead of 100 empty rows.
	 */
	usedRange(): { r1: number; c1: number; r2: number; c2: number } {
		const ws = this.first();
		const data = ((ws as unknown as { options?: { data?: unknown[][] } })?.options?.data ??
			[]) as unknown[][];
		let r2 = 0;
		let c2 = 0;
		for (let r = 0; r < data.length; r++) {
			const row = data[r];
			if (!Array.isArray(row)) continue;
			for (let c = 0; c < row.length; c++) {
				const v = row[c];
				if (v === null || v === undefined || v === "") continue;
				if (r > r2) r2 = r;
				if (c > c2) c2 = c;
			}
		}
		return { r1: 0, c1: 0, r2, c2 };
	}

	/**
	 * Show only a rectangle of the grid, hiding everything around it.
	 *
	 * Rows and columns outside the range are HIDDEN rather than never created:
	 * a formula in the visible range may well reference a cell outside it, and
	 * a grid built to the size of the range would compute that as zero.
	 */
	cropTo(range: { r1: number; c1: number; r2: number; c2: number }): void {
		const ws = this.first();
		if (!ws) return;
		const { rows, cols } = this.dimensions();
		const hideRows: number[] = [];
		const hideCols: number[] = [];
		for (let r = 0; r < rows; r++) if (r < range.r1 || r > range.r2) hideRows.push(r);
		for (let c = 0; c < cols; c++) if (c < range.c1 || c > range.c2) hideCols.push(c);
		this.suspend = true;
		try {
			if (hideRows.length > 0) ws.hideRow(hideRows);
			if (hideCols.length > 0) ws.hideColumn(hideCols);
		} catch (e) {
			console.error("leovale-sheets: crop failed", e);
		} finally {
			this.suspend = false;
		}
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

			// Masks live on the elements for the same reason, one attribute per cell.
			const records = (ws as unknown as { records?: { element?: HTMLElement }[][] }).records ?? [];
			for (let r = 0; r < records.length; r++) {
				const row = records[r] ?? [];
				for (let c = 0; c < row.length; c++) {
					const nf = normalizeNf(row[c]?.element?.getAttribute(NF_ATTR));
					if (!nf) continue;
					if (r >= page.rows || c >= page.cols) continue;
					const ref = cellRef(r, c);
					const cell = page.cells[ref] ?? {};
					cell.s = { ...(cell.s ?? {}), nf };
					page.cells[ref] = cell;
				}
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

	/**
	 * Abandon an open in-cell editor WITHOUT committing it.
	 *
	 * Called before teardown. The engine's own `closeEditor(cell, true)` runs from
	 * a document-level mousedown, so an editor left open while the view reloads
	 * is a live value waiting to be written into whatever document is mounted
	 * next. Discarding it is the only safe answer: the user's keystrokes are not
	 * lost, they were never committed in the first place.
	 */
	discardOpenEditor(): void {
		const ws = this.first() as unknown as {
			edition?: [HTMLTableCellElement, string, string, string] | null;
			closeEditor?: (cell: HTMLTableCellElement, save: boolean) => void;
		} | null;
		const cell = ws?.edition?.[0];
		if (!ws || !cell) return;
		try {
			ws.closeEditor?.(cell, false);
		} catch (e) {
			console.error("leovale-sheets: closing the editor failed", e);
		}
	}

	destroy(): void {
		this.discardOpenEditor();
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		try {
			// NOTE the `false`: the document-level key/mouse handlers are NOT removed
			// here. They are shared by every instance of the engine, and since 1.2.0
			// an embedded sheet in a note is a second one, so tearing this instance
			// down with `true` would leave the other grid deaf to the mouse. They are
			// released once, for good, when the plugin unloads
			// ({@link releaseEngineGlobals}).
			jspreadsheet.destroy(this.host as never, false as never);
			// What those leftover handlers act on is the engine's `current` pointer.
			// Clearing it is what stops them from eating Obsidian's own hotkeys once
			// the last grid is gone; any click on a live grid sets it again.
			(jspreadsheet as unknown as { current?: unknown }).current = null;
		} catch (e) {
			console.error("leovale-sheets: engine destroy failed", e);
		}
		this.worksheets = null;
		this.root.detach();
	}
}
