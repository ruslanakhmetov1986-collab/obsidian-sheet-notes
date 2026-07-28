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
import { WRAP_CLASS, WRAP_ON, cssToStyle, looksNumeric, styleToCss } from "./cellcss";
import {
	type ClipCell,
	type ClipRect,
	type SheetClip,
	cancelCut,
	makeClip,
	pendingCut,
} from "./clipboard";
import { formatValue } from "./numfmt";
import {
	CURRENT_VERSION,
	FORMAT_ID,
	type CellStyle,
	type CellType,
	type CellValue,
	type PageFreeze,
	type PageView,
	type SheetCell,
	type SheetDoc,
	type SheetPage,
	cellRef,
	isCheckedValue,
	isEmptyFreeze,
	isEmptyStyle,
	newSheetPage,
	normalizeCellType,
	normalizeFreeze,
	normalizeNf,
	normalizeStyle,
	normalizeView,
	parseRef,
} from "./format";
import { type FillValue, isFormula, planFill, shiftFormula } from "./fillseries";
import { t } from "./i18n";
import { type CellLink, hasWikiLink, parseCellLinks } from "./links";
import {
	type Cursor,
	type ValueReader,
	dataEdge,
	distinctValues,
	findMatches,
	hiddenRows,
	rowEnd,
	usedEnd,
} from "./sheetops";

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

/**
 * Where a cell's TYPE lives at runtime, for exactly the reasons the mask does:
 * an attribute on the `<td>` rides along when the engine inserts a row, a map
 * keyed by A1 ref would go stale. Only `cb` (checkbox) exists.
 */
export const TYPE_ATTR = "data-ct";
/** The `<input type="checkbox">` a `cb` cell renders. */
export const CHECKBOX_CLASS = "leovale-sheet-cb";
/** An `<a>` rendered for a `[[wiki link]]` inside a cell value. */
export const LINK_CLASS = "leovale-sheet-link";
/** The exact text the links in a cell were built from; see {@link syncLinks}. */
const LINK_SRC_ATTR = "data-link-src";

/** Classes the in-sheet search puts on the cells it found. */
export const FOUND_CLASS = "leovale-sheet-found";
export const FOUND_CURRENT_CLASS = "leovale-sheet-found-current";
/** Marks the column a filter is currently narrowing, in the header. */
export const FILTERED_CLASS = "leovale-sheet-filtered";
/** Marks the column the page is sorted by, in the header. */
export const SORTED_CLASS = "leovale-sheet-sorted";
/** Marks the cells a pending CUT will clear on the next paste. */
export const CUT_CLASS = "leovale-sheet-cut";
/** The overlay that outlines the selected range; see {@link SheetEngine.syncSelectionBox}. */
export const SELBOX_CLASS = "leovale-sheet-selbox";
/** The dashed overlay that previews where a fill-handle drag will land. */
export const FILLBOX_CLASS = "leovale-sheet-fillbox";
/** Marks a cell as holding a NUMBER, so the theme can align digits by column. */
export const NUM_CLASS = "leovale-sheet-num";
/** Marks a cell that carries a user fill, so the dark theme can soften it. */
export const FILLED_CLASS = "leovale-sheet-filled";

/**
 * Sane bounds for a column width, in px, whatever the user or autofit asks.
 *
 * The floor was 24, which is narrower than a single Cyrillic word and is what
 * the design audit's "catastrophic word break" screenshot was really showing: at
 * that width there is no word boundary to break at, so every line breaks inside
 * a word however the wrapping rule is written. 40 still allows a genuinely
 * narrow column (a tick box, an index) and leaves the wrapping something to work
 * with. A width already stored in a file is replayed untouched - only what the
 * user or autofit asks for now is clamped.
 */
export const MIN_COL_WIDTH = 40;
export const MAX_COL_WIDTH = 1200;

/* ------------------------------------------------------------- touch */

/**
 * How far a finger may drift and still count as a TAP rather than a scroll,
 * in CSS pixels. Ten is the number Android's own `ViewConfiguration` uses for
 * its touch slop at this density; below it a fingertip cannot hold still.
 */
export const TAP_SLOP_PX = 10;
/** How long a finger may stay down and still count as a tap. */
export const TAP_MAX_MS = 300;
/** A press this long opens the context menu, exactly like a right click. */
export const LONG_PRESS_MS = 500;
/**
 * How long after the user's own touch scroll a programmatic "scroll the
 * selection into view" stays switched off.
 *
 * Measured on the tablet: a horizontal pan left the sheet at scrollLeft 484 and
 * a deferred scroll-into-view then yanked it back to 0, which reads as the sheet
 * refusing to be scrolled at all. A scroll the user performed with their finger
 * outranks any scroll the plugin would like, and momentum keeps the container
 * moving after the finger is up, hence a grace period rather than a flag.
 */
export const SCROLL_GRACE_MS = 700;

/** Where the grid's context menu was asked for, and by what. */
export interface GridMenuContext {
	/** Row under the pointer, or null (a column header, the corner). */
	row: number | null;
	/** Column under the pointer, or null (a row number). */
	col: number | null;
	/** Which part of the grid was hit: `cell`, `row`, `header`, … */
	role: string;
	/** Viewport coordinates to open the menu at. */
	x: number;
	y: number;
	/** True when a finger asked for it: no keyboard hints, bigger rows. */
	touch: boolean;
	/**
	 * The document {@link x}/{@link y} are viewport coordinates OF.
	 *
	 * A sheet tab can be dragged into an Obsidian pop-out window, and a menu
	 * shown without naming its document is built in whatever window Obsidian
	 * currently calls active - so the menu appeared in the main window, at
	 * coordinates measured in the pop-out. The host passes this straight to
	 * `Menu.showAtPosition`.
	 */
	doc: Document;
}

/** Distinct root class per live grid, so the freeze rules of one cannot hit another. */
let instanceCounter = 0;

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

/**
 * Client coordinates of whatever kind of pointer this event carries.
 *
 * The fill handle is driven by a mouse and by a finger through the SAME code
 * path, because the gesture is the same gesture and two copies of it would drift
 * apart. `touches` is empty on `touchend`, so `changedTouches` is the fallback.
 */
function pointerOf(e: Event): { x: number; y: number } | null {
	const touch = e as TouchEvent;
	if (touch.touches || touch.changedTouches) {
		const p = touch.touches?.[0] ?? touch.changedTouches?.[0];
		return p ? { x: p.clientX, y: p.clientY } : null;
	}
	const mouse = e as MouseEvent;
	return typeof mouse.clientX === "number" ? { x: mouse.clientX, y: mouse.clientY } : null;
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

/**
 * What a `[[wiki link]]` in a cell can do. Supplied by the view and by embeds,
 * because opening a note and asking Obsidian for a hover preview are the host's
 * business, not the grid's - the engine stays free of `obsidian` imports.
 */
export interface LinkHandlers {
	/** A click on the link. `newTab` is the usual Ctrl/Cmd or middle click. */
	open: (target: string, newTab: boolean) => void;
	/** Pointer over the link: the hook for Obsidian's page preview popover. */
	hover?: (el: HTMLElement, target: string, event: MouseEvent) => void;
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
	/** Makes `[[wiki links]]` in cells clickable. Omitted: they stay plain text. */
	links?: LinkHandlers;
	/**
	 * Opens the context menu for a right click or a long press. Supplied by the
	 * host (the view builds an Obsidian menu), because a menu is chrome and the
	 * engine has no `obsidian` import.
	 *
	 * The engine's OWN menu is suppressed either way: without a handler there is
	 * no menu at all, which is what a read-only embed inside a note wants.
	 */
	menu?: (ctx: GridMenuContext) => void;
	/**
	 * Asked on every `touchstart`: does this gesture belong to somebody else?
	 *
	 * The one caller is the view's edge-swipe rule (Obsidian's drawer owns the
	 * left edge strip while the sheet is scrolled fully left). A gesture that
	 * belongs to the host is not touched at all - not stopped, not deferred, not
	 * turned into a selection - because the host's own handler has to see the
	 * whole sequence, `touchstart` included, to recognise it.
	 */
	touchPassThrough?: (e: TouchEvent) => boolean;
	/**
	 * What Ctrl+C / Ctrl+X / Ctrl+V and Escape do on the grid.
	 *
	 * Supplied by the host for the same reason the menu is: the operations end in
	 * `navigator.clipboard` and in Obsidian notices, and the engine has no
	 * `obsidian` import. The engine's part is the keystroke - it is the one thing
	 * here that knows which grid the vendor currently considers current, and it
	 * has to intercept before the vendor's own handler runs (see
	 * {@link SheetEngine.installClipboardKeys}).
	 */
	clipboard?: ClipboardActions;
	/**
	 * What Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z do on this grid.
	 *
	 * Supplied by the host for a harder reason than the clipboard's: the history
	 * this plugin offers is over DOCUMENTS, and the engine has no idea what a
	 * document is. Handing the keystroke over here is also what TAKES it away
	 * from the vendor's own undo stack - see {@link SheetEngine.installHistoryKeys}.
	 */
	history?: HistoryActions;
}

/** The host's undo/redo; see {@link EngineOptions.history}. */
export interface HistoryActions {
	undo: () => void;
	redo: () => void;
}

/** The host's clipboard operations; see {@link EngineOptions.clipboard}. */
export interface ClipboardActions {
	copy: () => void;
	cut: () => void;
	paste: () => void;
	/** Escape while a cut is pending: withdraw it, leave the source alone. */
	cancelCut: () => void;
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
	/** Sort + filters per page, as loaded and as the user changes them. */
	private views: PageView[];
	/** Frozen rows/columns per page. */
	private freezes: PageFreeze[];
	/** Per-instance class, so the generated freeze rules stay inside this grid. */
	private uid: string;
	/** Where those generated rules live; see {@link syncFreeze}. */
	private freezeStyle: HTMLStyleElement | null = null;
	private freezeCss = "";
	/** Deferred re-measure of the frozen offsets; see {@link scheduleFreezeSync}. */
	private freezeTimer: number | null = null;
	/** Kept so keyboard-driven selection changes can refresh the chrome too. */
	private selectionListener?: () => void;
	/** What a `[[link]]` in a cell does; absent means "leave it as text". */
	private links?: LinkHandlers;
	/** Builds the context menu; see {@link EngineOptions.menu}. */
	private menuBuilder?: (ctx: GridMenuContext) => void;
	/** Gesture veto; see {@link EngineOptions.touchPassThrough}. */
	private passTouch?: (e: TouchEvent) => boolean;
	/** When the user's finger last moved the grid; see {@link SCROLL_GRACE_MS}. */
	private touchScrollAt = 0;
	/** When we last opened a context menu, so one press cannot open two. */
	private menuOpenedAt = 0;
	/** The live touch gesture, from `touchstart` to `touchend`. */
	private touch: {
		x: number;
		y: number;
		at: number;
		/** The `<td>` the finger came down on, or null. */
		cell: HTMLElement | null;
		/** Set once the finger has travelled further than the slop radius. */
		moved: boolean;
		timer: number | null;
	} | null = null;
	private touchHandlers: [string, EventListener, boolean][] = [];
	/** The pop-out key bridge, and the document it listens on; see {@link installKeyBridge}. */
	private keyBridge: ((e: KeyboardEvent) => void) | null = null;
	private keyBridgeDoc: Document | null = null;
	/** What the host does on Ctrl+C/X/V; see {@link EngineOptions.clipboard}. */
	private clipboard?: ClipboardActions;
	/** The clipboard key handler and the document it captures on. */
	private clipKeys: ((e: KeyboardEvent) => void) | null = null;
	private clipKeysDoc: Document | null = null;
	/** What the host does on Ctrl+Z/Ctrl+Y; see {@link EngineOptions.history}. */
	private historyActions?: HistoryActions;
	/** The undo/redo key handler and the document it captures on. */
	private histKeys: ((e: KeyboardEvent) => void) | null = null;
	private histKeysDoc: Document | null = null;
	/** Cells currently wearing the cut marker; see {@link markCutRange}. */
	private cutRefs: string[] = [];
	/** The selection outline overlay; see {@link syncSelectionBox}. */
	private selBox: HTMLElement | null = null;
	/** The dashed preview of a fill-handle drag; see {@link drawFillBox}. */
	private fillBox: HTMLElement | null = null;
	/** Listeners the fill handle owns on the root, kept for teardown. */
	private fillHandlers: [string, EventListener][] = [];
	/** The fill drag currently in progress; see {@link installFillHandle}. */
	private fill: {
		src: ClipRect;
		dst: ClipRect | null;
		touch: boolean;
		doc: Document;
		move: EventListener;
		up: EventListener;
		cancel: EventListener;
	} | null = null;

	constructor(parent: HTMLElement, doc: SheetDoc, opts: EngineOptions) {
		this.readOnly = !!opts.readOnly;
		this.pageNames = doc.sheets.map((s) => s.name);
		this.version = doc.version;
		this.views = doc.sheets.map((s) => normalizeView(s.view));
		this.freezes = doc.sheets.map((s) => normalizeFreeze(s.freeze));
		this.uid = `leovale-sheet-g${++instanceCounter}`;

		this.selectionListener = opts.onSelection;
		this.links = opts.links;
		this.menuBuilder = opts.menu;
		this.passTouch = opts.touchPassThrough;
		this.clipboard = opts.clipboard;
		this.historyActions = opts.history;
		this.root = parent.createDiv({ cls: ROOT_CLASS });
		this.root.addClass(this.uid);
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
			// The document the vendor hangs its pointer handlers on. Left out it
			// takes the global `document`, which is the MAIN window's - so a sheet
			// dragged into an Obsidian pop-out could not be selected at all: the
			// clicks happened in a window nothing was listening to, the selection
			// stayed empty, and every toolbar action was a silent no-op on it.
			// In the main window this is the same object it would have picked
			// anyway. (Typed `HTMLElement` by the vendor, used by it as an event
			// target and for `getSelection()`, both of which a Document is.)
			root: this.root.ownerDocument as unknown as HTMLElement,
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
				this.syncSelectionBox();
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
			// The engine's own menu is never shown: `false` is the documented "do
			// not open anything" answer of this hook (the vendor returns before it
			// builds the jsuites menu). Ours is opened from here instead - see
			// {@link openMenu} for why replacing beats restyling.
			contextMenu: (
				_ws: unknown,
				colIndex: unknown,
				rowIndex: unknown,
				event: MouseEvent,
				_items: unknown,
				role: unknown,
			) => {
				const num = (v: unknown) => {
					const n = Number(v);
					return Number.isInteger(n) && n >= 0 ? n : null;
				};
				this.openMenu(
					{
						row: num(rowIndex),
						col: num(colIndex),
						role: typeof role === "string" ? role : "cell",
						x: event?.clientX ?? 0,
						y: event?.clientY ?? 0,
						touch: false,
					},
					event,
				);
				return false;
			},
		} as never);

		this.applyStoredRowHeights(doc);
		this.applyStoredMasks(doc);
		this.applyStoredTypes(doc);
		// The stored view is replayed like the row heights are, with autosave
		// suppressed: merely opening a filtered, frozen sheet must not modify it.
		this.suspend = true;
		try {
			this.applyFilters();
			this.syncFreeze(true);
			this.syncHeaderMarks();
		} finally {
			this.suspend = false;
		}
		this.scheduleFreezeSync();
		this.syncDecor();
		this.observeResize();
		this.installTouchGestures();
		this.installFillHandle();
		this.installKeyBridge();
		this.installClipboardKeys();
		this.installHistoryKeys();
	}

	/**
	 * Is the grid the vendor is currently acting on one of ours?
	 *
	 * `jspreadsheet.current` is global and is set by the vendor's own
	 * document-level `mousedown`, i.e. it is "the grid the user last clicked in",
	 * across every sheet in every window. Every document-level handler here is
	 * gated on it, or a keystroke meant for one sheet would drive another.
	 */
	private ownsCurrent(): boolean {
		const current = (jspreadsheet as unknown as { current?: unknown }).current;
		return !!current && !!this.worksheets?.includes(current as WorksheetInstance);
	}

	/* --------------------------------------------------------- clipboard keys */

	/**
	 * Ctrl+C, Ctrl+X, Ctrl+V and Escape, taken off the vendor.
	 *
	 * WHY THEY ARE INTERCEPTED AT ALL. The vendor implements all three itself, in
	 * its `keydown` handler on the document: Ctrl+C builds tab-separated text,
	 * puts it in a hidden textarea and calls `execCommand("copy")`; Ctrl+X does
	 * that and blanks the VALUES; Ctrl+V is served by a `paste` listener that
	 * writes `clipboardData.getData("text")` into the grid. Text, in all three
	 * directions - which is precisely the limitation this feature exists to lift
	 * (see clipboard.ts). Leaving the vendor's handlers in place next to ours
	 * would mean two writers on one clipboard, racing.
	 *
	 * WHY THE CAPTURE PHASE ON THE DOCUMENT. The vendor listens on the document
	 * in the BUBBLE phase, so a capture listener on the same document is the last
	 * point at which the keystroke can still be taken away from it:
	 * `stopPropagation()` from a capture listener on an ancestor cancels the rest
	 * of the trip, the bubble half included. `preventDefault()` on the keydown is
	 * what stops the browser from also firing its own `copy`/`paste` events, so
	 * the range is written to the clipboard exactly once, by us.
	 *
	 * In a pop-out this listens on the pop-out's document, which is also what
	 * stops {@link installKeyBridge} from carrying these particular keystrokes to
	 * the main window - by the time the bridge's bubble handler would run, the
	 * event is no longer travelling.
	 *
	 * Escape is NOT consumed: it only withdraws a pending cut, and the vendor
	 * still needs it to close an open editor.
	 */
	private installClipboardKeys(): void {
		const doc = this.root.ownerDocument;
		if (!doc || !this.clipboard) return;
		const actions = this.clipboard;

		const handler = (e: KeyboardEvent) => {
			if (!this.ownsCurrent()) return;
			// A text field owns its own clipboard keys: the formula bar, the find
			// box, and the in-cell editor are all inputs, and Ctrl+C in one of them
			// means "copy this text", not "copy this range".
			const target = e.target;
			if (
				target instanceof HTMLInputElement ||
				target instanceof HTMLTextAreaElement ||
				(target instanceof HTMLElement && target.isContentEditable)
			) {
				return;
			}
			if (this.isEditing()) return;
			if (e.key === "Escape") {
				actions.cancelCut();
				return;
			}
			if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
			const key = e.key.toLowerCase();
			if (key !== "c" && key !== "x" && key !== "v") return;
			e.preventDefault();
			e.stopPropagation();
			if (key === "c") actions.copy();
			else if (key === "x") actions.cut();
			else actions.paste();
		};

		doc.addEventListener("keydown", handler, true);
		this.clipKeys = handler;
		this.clipKeysDoc = doc;
	}

	/* ----------------------------------------------------------- undo / redo */

	/**
	 * Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z, taken off the vendor for good.
	 *
	 * THE PROBLEM THIS SOLVES. The bundled engine keeps an undo stack of its own
	 * and drives it from the same document-level `keydown` handler that owns the
	 * clipboard keys. That stack only ever saw the operations the ENGINE
	 * performs, so everything this plugin does at the document level - sorting
	 * (which rewrites the page and remounts the grid), merging, a rich paste, a
	 * cut completed by a paste, fill-down, our own insert/delete row - was
	 * invisible to it and simply could not be undone. Worse than absent: after a
	 * sort the vendor's stack still held entries pointing into a grid that no
	 * longer exists, so one Ctrl+Z would undo an operation from three steps ago,
	 * or throw. Two stacks racing for one keystroke is not a thing that can be
	 * made to behave; one of them has to go, and it is not going to be the one
	 * that knows what a document is.
	 *
	 * So the keystroke is intercepted in the CAPTURE phase on this grid's own
	 * document - the last point at which it can still be taken away from the
	 * vendor's bubble-phase listener - and handed to the host, which owns the
	 * document-level history (see history.ts). `stopPropagation()` ends the
	 * event's journey there, so the vendor's stack is never consulted, whatever
	 * else it may still be recording.
	 *
	 * THE ONE-KEYSTROKE-ONE-STEP RULE. Obsidian's own keymap listens on the
	 * WINDOW in the capture phase, i.e. strictly before this handler, and the
	 * view registers the same shortcuts in its `Scope` (which is the sanctioned
	 * way to get a hotkey inside a view, and the only one that also reaches the
	 * command palette). When the scope has already acted it answers "handled" the
	 * only way a scope can: by preventing the default. That is what
	 * `defaultPrevented` is read for here - the event is still consumed so the
	 * vendor cannot see it, but the history is NOT stepped a second time. In a
	 * pop-out, where Obsidian's keymap may not be listening at all, this handler
	 * is the one that acts. Either way: exactly one step per keystroke.
	 */
	private installHistoryKeys(): void {
		const doc = this.root.ownerDocument;
		if (!doc || !this.historyActions) return;
		const actions = this.historyActions;

		const handler = (e: KeyboardEvent) => {
			if (!this.ownsCurrent()) return;
			if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
			const key = e.key.toLowerCase();
			const undo = key === "z" && !e.shiftKey;
			const redo = key === "y" || (key === "z" && e.shiftKey);
			if (!undo && !redo) return;
			// A text field owns its own undo: an in-cell editor and the formula bar
			// are inputs, and Ctrl+Z in one of them means "undo my typing".
			const target = e.target;
			if (
				target instanceof HTMLInputElement ||
				target instanceof HTMLTextAreaElement ||
				(target instanceof HTMLElement && target.isContentEditable)
			) {
				return;
			}
			if (this.isEditing()) return;

			const already = e.defaultPrevented;
			e.preventDefault();
			e.stopPropagation();
			if (already) return;
			if (undo) actions.undo();
			else actions.redo();
		};

		doc.addEventListener("keydown", handler, true);
		this.histKeys = handler;
		this.histKeysDoc = doc;
	}

	/* ------------------------------------------------------ pop-out keyboard */

	/**
	 * Deliver keystrokes to the grid engine when the grid lives in a POP-OUT
	 * window.
	 *
	 * The vendor's `setEvents` is careful with the pointer - it binds `mouseup`,
	 * `mousedown`, `mousemove` and the touch events to the document it is
	 * configured with, which is why passing `root: ownerDocument` above made a
	 * sheet in a pop-out clickable. The keyboard is not: the same function ends
	 * with a bare
	 *
	 *     document.addEventListener("keydown", keyDownControls)
	 *
	 * and that `document` is the module's own, i.e. the MAIN window's, whatever
	 * the configuration says. A pop-out is a different Document in the same JS
	 * realm, so its `keydown` events never reach the handler at all. Measured:
	 * in a pop-out the arrow keys moved nothing and typing on a selected cell
	 * opened no editor, while the same keys worked in the main window.
	 *
	 * Rather than reimplement navigation, typing entry, Tab, Enter, Escape and
	 * the clipboard shortcuts a second time (two implementations, one of them
	 * only ever exercised in a pop-out), the event is CARRIED to where the
	 * handler is listening: a copy of the keystroke is dispatched on the main
	 * document, and if the handler consumed it, the original is consumed too.
	 * The pop-out then behaves exactly like the main window, by construction,
	 * including anything the vendor adds later.
	 *
	 * The gate is ownership. `jspreadsheet.current` is the grid the engine acts
	 * on, and it is global: without the check, typing in a pop-out would drive
	 * whatever grid was last clicked in ANOTHER window. So the bridge only fires
	 * while the current instance is one of ours - which is exactly when the user
	 * has clicked a cell in this grid, and is the same condition the vendor's own
	 * handler applies before it does anything.
	 *
	 * Bubble phase, on the document, so that everything which deliberately stops
	 * a keystroke on its way up (the find box, the formula bar, our dialogs -
	 * each of which calls `stopPropagation` precisely to hide typing from this
	 * handler) keeps working unchanged.
	 *
	 * The copy travels through the main window, where Obsidian's own keymap is
	 * also listening, so the obvious worry is a keystroke being acted on twice -
	 * once in the pop-out, once here. Measured, with the view's own scope
	 * handlers counted: one Ctrl+D in a pop-out calls `fillDown` exactly once,
	 * one Home calls `moveToRowStart` exactly once, the same as in the main
	 * window. Obsidian does not act on an untrusted event; the vendor, which
	 * reads only the key fields, does.
	 */
	private installKeyBridge(): void {
		const doc = this.root.ownerDocument;
		// The main window: the vendor is already listening on this very document.
		if (!doc || doc === document) return;

		const bridge = (e: KeyboardEvent) => {
			if (!this.ownsCurrent()) return;
			// A synthesized keydown carrying the legacy fields too: the vendor reads
			// `which`/`keyCode` for navigation and `key` for typing entry.
			const copy = new KeyboardEvent("keydown", {
				key: e.key,
				code: e.code,
				location: e.location,
				ctrlKey: e.ctrlKey,
				shiftKey: e.shiftKey,
				altKey: e.altKey,
				metaKey: e.metaKey,
				repeat: e.repeat,
				isComposing: e.isComposing,
				charCode: e.charCode,
				keyCode: e.keyCode,
				which: e.which,
				bubbles: true,
				cancelable: true,
			});
			// Dispatched on the BODY, not on the document itself, and that is not
			// cosmetic: the vendor's handler ends in a branch that reads
			// `e.target.classList` (it is looking for its own search box), and a
			// Document has no `classList`. With the event dispatched on the
			// document the target WAS the document, and every keystroke that
			// arrived while the engine had no current instance threw
			// "Cannot read properties of undefined (reading 'contains')" into the
			// console. A real keystroke's target is an element; so is this one.
			(document.body ?? document.documentElement).dispatchEvent(copy);
			// The handler answers "handled" the only way it can: it prevents the
			// default. Mirroring that back is what stops the pop-out window from
			// also scrolling on an arrow key or moving focus on Tab.
			if (copy.defaultPrevented) e.preventDefault();
		};

		doc.addEventListener("keydown", bridge);
		this.keyBridge = bridge;
		this.keyBridgeDoc = doc;
	}

	/* --------------------------------------------------------- touch gestures */

	/**
	 * Touch handling, taken off the engine and done here.
	 *
	 * The vendor selects the cell from its own `touchstart` listener on
	 * `document`, i.e. the moment a finger lands - and a finger lands on a cell
	 * whenever the user means to SCROLL. The tapped cell became the active one,
	 * the previous selection and the formula bar's context were gone, and the
	 * user had not asked for any of it. So `touchstart` is stopped here (capture
	 * phase, before it reaches `document`) and the decision is deferred:
	 *
	 *   - a tap (within {@link TAP_SLOP_PX}, shorter than {@link TAP_MAX_MS})
	 *     selects the cell, on `touchend`;
	 *   - anything longer or further is a scroll and changes nothing;
	 *   - a stationary press of {@link LONG_PRESS_MS} opens the context menu,
	 *     which is what a long press means on a touch screen.
	 *
	 * Swallowing `touchstart` also disarms the vendor's own 500 ms
	 * long-press-to-edit timer for good, which is the trap documented in
	 * {@link cancelTouchHold}: it opened the in-cell editor in the middle of a
	 * scroll. Editing from a press now goes through the context menu instead.
	 *
	 * Nothing here calls `preventDefault()`: the scroll itself is exactly what we
	 * are protecting, and the browser's own compatibility mouse events (which a
	 * scroll gesture correctly suppresses) still reach the engine on a tap.
	 */
	private installTouchGestures(): void {
		const on = (type: string, fn: EventListener, capture: boolean) => {
			this.root.addEventListener(type, fn, capture ? { capture: true } : { passive: true });
			this.touchHandlers.push([type, fn, capture]);
		};
		on("touchstart", ((e: TouchEvent) => this.onTouchStart(e)) as EventListener, true);
		on("touchmove", ((e: TouchEvent) => this.onTouchMove(e)) as EventListener, false);
		on("touchend", ((e: TouchEvent) => this.onTouchEnd(e)) as EventListener, false);
		on("touchcancel", (() => this.endTouch()) as EventListener, false);
	}

	private onTouchStart(e: TouchEvent): void {
		this.endTouch();
		// A gesture the host claims (the drawer's edge strip) is left completely
		// alone: stopping it here is exactly what took the drawer away in 1.1.0.
		if (this.passTouch?.(e)) return;
		// One finger is a tap or a pan; two are a pinch, which belongs to nobody
		// here. Either way the engine must not see it.
		e.stopPropagation();
		this.cancelTouchHold();
		const point = e.touches[0] ?? e.changedTouches[0];
		if (!point || e.touches.length > 1) return;
		const target = point.target as HTMLElement | null;
		const cell = target?.closest?.("tbody td[data-x][data-y]") as HTMLElement | null;
		const state = {
			x: point.clientX,
			y: point.clientY,
			at: Date.now(),
			cell: cell ?? null,
			moved: false,
			timer: null as number | null,
		};
		this.touch = state;
		if (!cell) return;
		state.timer = window.setTimeout(() => {
			state.timer = null;
			if (this.touch !== state || state.moved) return;
			this.selectFromTouch(cell);
			this.openMenu({
				row: Number(cell.getAttribute("data-y")),
				col: Number(cell.getAttribute("data-x")),
				role: "cell",
				x: state.x,
				y: state.y,
				touch: true,
			});
		}, LONG_PRESS_MS);
	}

	private onTouchMove(e: TouchEvent): void {
		const state = this.touch;
		if (!state) return;
		const point = e.touches[0] ?? e.changedTouches[0];
		if (!point) return;
		if (
			Math.abs(point.clientX - state.x) > TAP_SLOP_PX ||
			Math.abs(point.clientY - state.y) > TAP_SLOP_PX
		) {
			state.moved = true;
			this.clearTouchTimer(state);
			// This is a scroll the USER is performing; nothing may scroll the grid
			// out from under them for the next moment.
			this.noteTouchScroll();
		}
	}

	private onTouchEnd(e: TouchEvent): void {
		const state = this.touch;
		this.touch = null;
		if (!state) return;
		this.clearTouchTimer(state);
		if (state.moved) {
			// Momentum keeps the container moving after the finger is up.
			this.noteTouchScroll();
			return;
		}
		if (e.touches.length > 0) return;
		if (Date.now() - state.at > TAP_MAX_MS) return;
		if (state.cell) this.selectFromTouch(state.cell);
	}

	private clearTouchTimer(state: { timer: number | null }): void {
		if (state.timer !== null) {
			window.clearTimeout(state.timer);
			state.timer = null;
		}
	}

	private endTouch(): void {
		if (this.touch) this.clearTouchTimer(this.touch);
		this.touch = null;
	}

	/** Select the tapped cell WITHOUT scrolling: it is under the finger already. */
	private selectFromTouch(cell: HTMLElement): void {
		const row = Number(cell.getAttribute("data-y"));
		const col = Number(cell.getAttribute("data-x"));
		if (!Number.isInteger(row) || !Number.isInteger(col)) return;
		this.selectCell(row, col, false, false);
	}

	/** The user is scrolling with a finger; hold off any scrolling of our own. */
	noteTouchScroll(): void {
		this.touchScrollAt = Date.now();
	}

	/** True while a user-initiated touch scroll owns the scroll position. */
	isTouchScrolling(): boolean {
		return Date.now() - this.touchScrollAt < SCROLL_GRACE_MS;
	}

	/**
	 * Open the context menu, ours or none.
	 *
	 * Both entry points land here (the vendor's `contextMenu` hook for a right
	 * click and Android's long press, and our own long-press timer for platforms
	 * whose WebView does not fire `contextmenu`), so the same press must not open
	 * two menus: one within a second of another is dropped.
	 */
	private openMenu(ctx: Omit<GridMenuContext, "doc">, event?: MouseEvent): void {
		event?.preventDefault();
		event?.stopPropagation();
		const now = Date.now();
		if (now - this.menuOpenedAt < 1000) return;
		this.menuOpenedAt = now;
		if (!this.menuBuilder) return;
		// A right click on a cell outside the selection has already moved the
		// selection (the vendor does that before asking us), so the menu acts on
		// what the user is looking at.
		try {
			// The window the grid is really in, which is not necessarily the one
			// Obsidian considers active (pop-out sheets).
			this.menuBuilder({ ...ctx, doc: this.root.ownerDocument });
		} catch (e) {
			console.error("leovale-sheets: building the context menu failed", e);
		}
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

	/** Replay the stored cell types (`t`), like the masks and for the same reason. */
	private applyStoredTypes(doc: SheetDoc): void {
		this.suspend = true;
		try {
			doc.sheets.forEach((page, i) => {
				for (const [ref, cell] of Object.entries(page.cells)) {
					const type = normalizeCellType(cell.t);
					if (!type) continue;
					this.cellElement(ref, i)?.setAttribute(TYPE_ATTR, type);
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
		if (!isEmptyFreeze(this.freezes[0] ?? {})) this.syncFreeze();
		this.syncSelectionBox();
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
			this.syncCheckboxes();
			this.syncLinks();
			this.syncCellClasses();
			// The outline is geometry, so it goes stale on anything that moves a
			// cell: a resized column, a row that grew because its text wraps, an
			// inserted row, a filter that hid one.
			this.syncSelectionBox();
		} catch (e) {
			console.error("leovale-sheets: decor sync failed", e);
		}
		// Frozen panes are pixel offsets, so they go stale on any geometry change
		// (a resized column, a row that grew because its text now wraps). Rebuilt
		// here, but only written when the rule text actually differs.
		if (!isEmptyFreeze(this.freezes[0] ?? {})) this.syncFreeze();
	}

	/* ------------------------------------------------------ checkbox cells */

	/** The type of one cell, as stored on its element. */
	getCellType(ref: string): CellType | undefined {
		return normalizeCellType(this.cellElement(ref)?.getAttribute(TYPE_ATTR));
	}

	/**
	 * Turn cells into checkboxes, or back into plain cells.
	 *
	 * The type is an attribute, not a style: it changes what the cell IS, and it
	 * must survive a row insert exactly like a number mask does. Values are left
	 * alone - a column of `true`/`false` becomes a column of ticked boxes, and
	 * removing the type gives the words back.
	 */
	setCellType(refs: string[], type: CellType | null): void {
		if (this.readOnly || refs.length === 0) return;
		const data = this.rawData();
		for (const ref of refs) {
			const el = this.cellElement(ref);
			if (!el) continue;
			if (type) {
				el.setAttribute(TYPE_ATTR, type);
			} else if (el.hasAttribute(TYPE_ATTR)) {
				el.removeAttribute(TYPE_ATTR);
				let coords;
				try {
					coords = parseRef(ref);
				} catch {
					continue;
				}
				this.undecorateCheckbox(el, data[coords.row]?.[coords.col]);
			}
		}
		this.syncDecor();
		this.notify();
	}

	/**
	 * Draw the tick boxes.
	 *
	 * The engine owns the cell's text and rewrites it from the raw value on every
	 * change, so the box is rebuilt whenever it is gone rather than created once:
	 * same contract as the number masks, one pass over the cells that asked for it
	 * (`td[data-ct="cb"]`), nothing at all when there are none.
	 */
	private syncCheckboxes(): void {
		const cells = this.host.querySelectorAll<HTMLElement>(`td[${TYPE_ATTR}="cb"]`);
		if (cells.length === 0) return;
		const data = this.rawData();
		cells.forEach((el) => {
			// An open editor is an <input> of the engine's own; leave it be.
			if (el.classList.contains("editor")) return;
			const row = Number(el.getAttribute("data-y"));
			const col = Number(el.getAttribute("data-x"));
			if (!Number.isInteger(row) || !Number.isInteger(col)) return;
			let box = el.querySelector<HTMLInputElement>(`input.${CHECKBOX_CLASS}`);
			if (box && el.childNodes.length !== 1) {
				// the engine wrote the raw value back next to our box
				el.empty();
				el.appendChild(box);
			}
			if (!box) {
				el.empty();
				box = el.createEl("input", {
					cls: CHECKBOX_CLASS,
					attr: { type: "checkbox", "aria-label": cellRef(row, col) },
				});
				const target = box;
				box.addEventListener("click", (e: MouseEvent) => {
					// The click belongs to the box, not to the grid: without this the
					// engine starts a selection drag from under the pointer.
					e.stopPropagation();
					this.setCheckbox(row, col, target.checked);
				});
			}
			box.checked = isCheckedValue(data[row]?.[col] as CellValue | undefined);
			box.disabled = this.readOnly;
			el.classList.add("leovale-sheet-cb-cell");
		});
	}

	/** Put the raw value back in a cell that is no longer a checkbox. */
	private undecorateCheckbox(el: HTMLElement, value: unknown): void {
		el.classList.remove("leovale-sheet-cb-cell");
		if (!el.querySelector(`input.${CHECKBOX_CLASS}`)) return;
		el.empty();
		el.textContent = value === null || value === undefined ? "" : String(value);
	}

	/** Write a checkbox's state as a real boolean, which is what the file keeps. */
	setCheckbox(row: number, col: number, checked: boolean): void {
		const ws = this.first();
		if (!ws || this.readOnly) return;
		try {
			ws.setValueFromCoords(col, row, checked as unknown as JssCellValue);
		} catch (e) {
			console.error("leovale-sheets: toggling a checkbox failed", e);
			return;
		}
		this.notify();
	}

	/* ----------------------------------------------------- links in cells */

	/**
	 * Render `[[wiki links]]` in every cell that holds one.
	 *
	 * Driven off the DATA rather than the DOM: the values are the truth, the scan
	 * is an array walk, and a cell that never had a link is never touched. A
	 * formula cell is read from its element instead, because its value is the
	 * formula source and what the sheet SHOWS is the result.
	 *
	 * Without link handlers (an embed in a note that has none, a future caller)
	 * nothing happens at all and `[[Note]]` stays exactly the text it is.
	 */
	private syncLinks(): void {
		if (!this.links) return;
		const data = this.rawData();
		const records =
			(this.first() as unknown as { records?: { element?: HTMLElement }[][] })?.records ?? [];
		for (let r = 0; r < data.length; r++) {
			const row = data[r];
			if (!Array.isArray(row)) continue;
			for (let c = 0; c < row.length; c++) {
				const raw = row[c];
				const el = records[r]?.[c]?.element;
				if (!el) continue;
				// A checkbox cell has its own rendering, and a masked cell holds a
				// number: neither can hold a link.
				if (el.hasAttribute(TYPE_ATTR) || el.hasAttribute(NF_ATTR)) continue;
				if (typeof raw === "string" && raw.startsWith("=")) {
					this.decorateLinks(el, this.cellSourceText(el));
					continue;
				}
				if (typeof raw !== "string" || !hasWikiLink(raw)) {
					this.undecorateLinks(el);
					continue;
				}
				this.decorateLinks(el, raw);
			}
		}
	}

	/**
	 * Two facts about a cell that CSS cannot work out on its own, marked as
	 * classes so the theme layer can act on them.
	 *
	 * `leovale-sheet-num` - the cell holds a NUMBER, so its digits align right
	 * and line up down the column, which is what every spreadsheet does and what
	 * the design audit found missing on four screens out of six. Only the RAW
	 * value is consulted, so a masked `1 234,00 ₽` counts and `Товар 1` does not.
	 * A cell whose owner asked for an alignment keeps it: an explicit `ha` is
	 * written into the cell's inline `text-align`, and finding `center` or
	 * `right` there is what "the user decided this" looks like.
	 *
	 * `leovale-sheet-filled` - the cell carries a user fill, which the dark theme
	 * softens (see DARK_FILL_DIM). A class rather than an attribute-substring
	 * selector on the inline style, because the browser rewrites `#fff2cc` into
	 * `rgb(255, 242, 204)` when it serialises the style attribute and a selector
	 * matching on that would be a guess about serialisation.
	 *
	 * The pass is over the engine's own `records`, i.e. exactly the loop
	 * {@link syncLinks} already runs, and it touches classes only - no layout is
	 * read, so it costs nothing that could show up as a reflow.
	 */
	private syncCellClasses(): void {
		const data = this.rawData();
		const records =
			(this.first() as unknown as { records?: { element?: HTMLElement }[][] })?.records ?? [];
		for (let r = 0; r < data.length; r++) {
			const row = data[r];
			if (!Array.isArray(row)) continue;
			for (let c = 0; c < row.length; c++) {
				const el = records[r]?.[c]?.element;
				if (!el) continue;
				const bg = el.style.backgroundColor;
				el.classList.toggle(FILLED_CLASS, bg !== "" && !bg.startsWith("var("));
				el.classList.toggle(NUM_CLASS, this.rendersNumber(el, row[c]));
			}
		}
	}

	/** Is this cell showing a number? See {@link syncCellClasses}. */
	private rendersNumber(el: HTMLElement, raw: unknown): boolean {
		// A tick box is a control and a link is prose; neither is a number.
		if (el.hasAttribute(TYPE_ATTR) || el.hasAttribute(LINK_SRC_ATTR)) return false;
		const align = el.style.textAlign;
		if (align === "center" || align === "right") return false;
		// A formula's VALUE is what the reader sees, and the engine has already
		// written it into the element; the mask, if any, is applied on top of it,
		// so the pre-mask text is the honest source in both cases.
		if (typeof raw === "string" && raw.startsWith("=")) {
			return looksNumeric(el.getAttribute(NF_SRC_ATTR) ?? el.textContent ?? "");
		}
		return looksNumeric(raw);
	}

	private decorateLinks(el: HTMLElement, text: string): void {
		if (el.classList.contains("editor")) return;
		const segments = parseCellLinks(text);
		if (segments.length === 0) {
			this.undecorateLinks(el);
			return;
		}
		// Already ours, and still built from this exact text.
		if (el.getAttribute(LINK_SRC_ATTR) === text && el.querySelector(`a.${LINK_CLASS}`)) return;
		el.empty();
		for (const segment of segments) {
			if (segment.kind === "text") {
				// A text node, never innerHTML: a cell value is user text and may
				// perfectly well contain a `<`.
				el.appendText(segment.text);
				continue;
			}
			this.buildLink(el, segment.link);
		}
		el.setAttribute(LINK_SRC_ATTR, text);
	}

	private buildLink(el: HTMLElement, link: CellLink): void {
		const anchor = el.createEl("a", {
			cls: `internal-link ${LINK_CLASS}`,
			text: link.display,
			attr: { href: link.target, "data-href": link.target, "aria-label": link.target },
		});
		anchor.addEventListener("click", (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			this.links?.open(link.target, e.ctrlKey || e.metaKey || e.button === 1);
		});
		anchor.addEventListener("mouseover", (e: MouseEvent) => {
			this.links?.hover?.(anchor, link.target, e);
		});
	}

	/** Undo our link rendering, but only while it is still the thing on screen. */
	private undecorateLinks(el: HTMLElement): void {
		if (!el.hasAttribute(LINK_SRC_ATTR)) return;
		const source = el.getAttribute(LINK_SRC_ATTR) ?? "";
		el.removeAttribute(LINK_SRC_ATTR);
		// If the engine has already rewritten the cell, its text is the fresh one
		// and putting the old source back would be a lie.
		if (el.querySelector(`a.${LINK_CLASS}`)) el.textContent = source;
	}

	/* --------------------------------------------------------- merged cells */

	/** Every merge of a page, anchor ref -> [colspan, rowspan]. */
	getMerges(sheet = 0): Record<string, [number, number]> {
		const ws = this.worksheet(sheet);
		if (!ws) return {};
		try {
			const all = ws.getMerge();
			if (!all || Array.isArray(all)) return {};
			const out: Record<string, [number, number]> = {};
			for (const [ref, span] of Object.entries(all)) {
				if (Array.isArray(span) && span.length >= 2) {
					out[ref] = [Number(span[0]), Number(span[1])];
				}
			}
			return out;
		} catch {
			return {};
		}
	}

	/** The merge a cell belongs to, anchor included, or null. */
	mergeAt(row: number, col: number, sheet = 0): { ref: string; cols: number; rows: number } | null {
		for (const [ref, span] of Object.entries(this.getMerges(sheet))) {
			let coords;
			try {
				coords = parseRef(ref);
			} catch {
				continue;
			}
			const [cols, rows] = span;
			if (
				row >= coords.row &&
				row < coords.row + rows &&
				col >= coords.col &&
				col < coords.col + cols
			) {
				return { ref, cols, rows };
			}
		}
		return null;
	}

	/**
	 * Cells of the selection that would lose their content to a merge: everything
	 * but the top-left one that actually holds something. The caller asks before
	 * throwing them away.
	 */
	mergeLosses(): string[] {
		const rect = this.selectionRect();
		if (!rect) return [];
		const read = this.reader();
		const out: string[] = [];
		for (let r = rect.r1; r <= rect.r2; r++) {
			for (let c = rect.c1; c <= rect.c2; c++) {
				if (r === rect.r1 && c === rect.c1) continue;
				if (read(r, c) !== undefined) out.push(cellRef(r, c));
			}
		}
		return out;
	}

	/**
	 * Merge the selection into its top-left cell.
	 *
	 * The doomed cells are emptied BEFORE the engine is asked to merge, and that
	 * is not tidiness: the engine's own `setMerge` puts up a native `confirm()`
	 * when it finds data in the cells it is about to swallow, and a native modal
	 * inside Obsidian is both ugly and unanswerable from a test. With the cells
	 * already empty there is nothing for it to ask about, and the question was
	 * asked properly by the caller (see SheetView.mergeSelection).
	 *
	 * Merges already inside the range are dropped first, or the engine would
	 * refuse and leave a half-merged block behind.
	 */
	mergeSelection(): boolean {
		const ws = this.first();
		const rect = this.selectionRect();
		if (!ws || this.readOnly || !rect) return false;
		if (rect.r1 === rect.r2 && rect.c1 === rect.c2) return false;
		try {
			for (const [ref] of Object.entries(this.getMerges())) {
				const { row, col } = parseRef(ref);
				if (row >= rect.r1 && row <= rect.r2 && col >= rect.c1 && col <= rect.c2) {
					ws.removeMerge(ref);
				}
			}
			const doomed = this.mergeLosses();
			if (doomed.length > 0) ws.setValue(doomed, "");
			ws.setMerge(cellRef(rect.r1, rect.c1), rect.c2 - rect.c1 + 1, rect.r2 - rect.r1 + 1);
		} catch (e) {
			console.error("leovale-sheets: merging failed", e);
			return false;
		}
		this.notify();
		return true;
	}

	/** Split every merge the selection touches back into its own cells. */
	unmergeSelection(): boolean {
		const ws = this.first();
		const rect = this.selectionRect();
		if (!ws || this.readOnly || !rect) return false;
		const anchors = new Set<string>();
		for (let r = rect.r1; r <= rect.r2; r++) {
			for (let c = rect.c1; c <= rect.c2; c++) {
				const merge = this.mergeAt(r, c);
				if (merge) anchors.add(merge.ref);
			}
		}
		if (anchors.size === 0) return false;
		try {
			for (const ref of anchors) ws.removeMerge(ref);
		} catch (e) {
			console.error("leovale-sheets: unmerging failed", e);
			return false;
		}
		this.notify();
		return true;
	}

	/* ------------------------------------------------- reading the live grid */

	private worksheet(sheet = 0): WorksheetInstance | null {
		return this.worksheets?.[sheet] ?? null;
	}

	private rawData(sheet = 0): unknown[][] {
		const ws = this.worksheet(sheet);
		return ((ws as unknown as { options?: { data?: unknown[][] } })?.options?.data ??
			[]) as unknown[][];
	}

	/** The text a cell shows, with our own number mask peeled back off. */
	private cellSourceText(el: HTMLElement | null | undefined): string {
		if (!el) return "";
		const shown = el.textContent ?? "";
		const last = el.getAttribute(NF_OUT_ATTR);
		const kept = el.getAttribute(NF_SRC_ATTR);
		return last !== null && shown === last && kept !== null ? kept : shown;
	}

	/**
	 * How sorting, filtering and searching see a cell.
	 *
	 * A literal is read from the data array, but a FORMULA is read from the
	 * element, because the data array holds `=SUM(B2:B3)` and nobody wants to
	 * sort by the letter S. The number mask is peeled off first, so a filter
	 * stores `3` and keeps working when the column's currency format changes.
	 */
	reader(sheet = 0): ValueReader {
		const data = this.rawData(sheet);
		const records =
			(this.worksheet(sheet) as unknown as { records?: { element?: HTMLElement }[][] })?.records ??
			[];
		return (row, col) => {
			const raw = data[row]?.[col];
			if (typeof raw === "string" && raw.startsWith("=")) {
				const text = this.cellSourceText(records[row]?.[col]?.element);
				return text === "" ? undefined : text;
			}
			if (raw === "" || raw === null || raw === undefined) return undefined;
			if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
				return raw;
			}
			return String(raw);
		};
	}

	/** Is there anything in this cell? The keyboard's idea of a data block. */
	private filled(sheet = 0): (row: number, col: number) => boolean {
		const read = this.reader(sheet);
		return (row, col) => read(row, col) !== undefined;
	}

	/**
	 * A page-shaped object for the pure helpers in sheetops: dimensions and the
	 * view, but no cells (everything they need comes through the reader).
	 */
	private shape(sheet = 0): SheetPage {
		const page = newSheetPage(this.pageNames[sheet] ?? "Sheet1");
		const { rows, cols } = this.dimensions();
		page.rows = Math.max(1, rows);
		page.cols = Math.max(1, cols);
		page.view = this.views[sheet] ?? {};
		page.freeze = this.freezes[sheet] ?? {};
		return page;
	}

	/* ---------------------------------------------------------- view state */

	getView(sheet = 0): PageView {
		return this.views[sheet] ?? {};
	}

	getFreeze(sheet = 0): PageFreeze {
		return this.freezes[sheet] ?? {};
	}

	/** Rows a sort or a filter must leave alone: the frozen ones are headers. */
	headerRows(sheet = 0): number {
		return this.freezes[sheet]?.rows ?? 0;
	}

	/** Distinct values of a column, i.e. the menu of its filter. */
	columnValues(col: number, sheet = 0): string[] {
		return distinctValues(this.shape(sheet), col, this.headerRows(sheet), this.reader(sheet));
	}

	/** Allowed values of one column; `null` removes the filter from it. */
	setFilter(col: number, values: string[] | null, sheet = 0): void {
		const view = { ...(this.views[sheet] ?? {}) };
		const filters = { ...(view.filters ?? {}) };
		if (values && values.length > 0) filters[String(col)] = [...values].sort();
		else delete filters[String(col)];
		if (Object.keys(filters).length > 0) view.filters = filters;
		else delete view.filters;
		this.views[sheet] = normalizeView(view);
		this.applyFilters(sheet);
		this.syncHeaderMarks(sheet);
		this.notify();
	}

	clearFilters(sheet = 0): void {
		const view = { ...(this.views[sheet] ?? {}) };
		delete view.filters;
		this.views[sheet] = view;
		this.applyFilters(sheet);
		this.syncHeaderMarks(sheet);
		this.notify();
	}

	/** Rows the filters currently hide, so the caller can report "3 of 40". */
	private hiddenByFilter: number[][] = [];

	private applyFilters(sheet = 0): void {
		const ws = this.worksheet(sheet);
		if (!ws) return;
		const previous = this.hiddenByFilter[sheet] ?? [];
		const next = hiddenRows(this.shape(sheet), this.headerRows(sheet), this.reader(sheet));
		const nextSet = new Set(next);
		const reveal = previous.filter((r) => !nextSet.has(r));
		try {
			if (reveal.length > 0) ws.showRow(reveal);
			if (next.length > 0) ws.hideRow(next);
		} catch (e) {
			console.error("leovale-sheets: applying filters failed", e);
		}
		this.hiddenByFilter[sheet] = next;
	}

	/** How many rows the filters are hiding right now. */
	filteredOutCount(sheet = 0): number {
		return (this.hiddenByFilter[sheet] ?? []).length;
	}

	/* -------------------------------------------------------------- freeze */

	setFreeze(freeze: PageFreeze, sheet = 0): void {
		this.freezes[sheet] = normalizeFreeze(freeze);
		this.syncFreeze(true, sheet);
		this.scheduleFreezeSync();
		this.notify();
	}

	/**
	 * Frozen panes, done with generated `position: sticky` rules.
	 *
	 * NOT with the engine's `freezeColumns`: that one drives off its INTERNAL
	 * scroller (`tableOverflow: true`), and here the whole grid scrolls inside
	 * our own wrapper - which is also why the row-number gutter is sticky in the
	 * theme layer rather than frozen by the engine. Sticky needs pixel offsets,
	 * so the rules are regenerated from the live geometry whenever the grid
	 * changes, and only written when the text actually differs.
	 */
	private syncFreeze(force = false, sheet = 0): void {
		const freeze = this.freezes[sheet] ?? {};
		const css = isEmptyFreeze(freeze) ? "" : this.buildFreezeCss(freeze);
		if (css === this.freezeCss && !force) return;
		this.freezeCss = css;
		this.root.toggleClass("has-freeze", css !== "");
		if (css === "") {
			this.freezeStyle?.remove();
			this.freezeStyle = null;
			return;
		}
		if (!this.freezeStyle) {
			this.freezeStyle = this.root.createEl("style");
		}
		this.freezeStyle.textContent = css;
	}

	/**
	 * Re-measure the frozen offsets once the layout has settled.
	 *
	 * The first pass runs while the grid is still being built, and the numbers it
	 * reads are not the final ones - measured in the sandbox: a `top: 285px` for
	 * a header row that is 26px tall, which parked the "frozen" row below the
	 * fold and made it look like sticky was not working at all. Everything else
	 * about the grid recovers on the next event; a freeze has no events of its
	 * own, so it is re-measured explicitly.
	 */
	private scheduleFreezeSync(): void {
		if (isEmptyFreeze(this.freezes[0] ?? {})) return;
		if (typeof requestAnimationFrame === "function") {
			requestAnimationFrame(() => {
				if (this.worksheets) this.syncFreeze(true);
			});
		}
		if (this.freezeTimer !== null) window.clearTimeout(this.freezeTimer);
		this.freezeTimer = window.setTimeout(() => {
			this.freezeTimer = null;
			if (this.worksheets) this.syncFreeze(true);
		}, 200);
	}

	private buildFreezeCss(freeze: PageFreeze): string {
		const scope = `.${this.uid} .jss_worksheet`;
		const px = (n: number) => `${Math.round(n)}px`;
		const rules: string[] = [];

		const gutter = this.host.querySelector<HTMLElement>("tbody > tr > td:first-child");
		const gutterWidth = gutter?.getBoundingClientRect().width ?? 0;
		const cols = Math.min(freeze.cols ?? 0, this.dimensions().cols);
		let left = gutterWidth;
		for (let c = 0; c < cols; c++) {
			const cell = this.host.querySelector<HTMLElement>(`thead > tr > td[data-x="${c}"]`);
			// A frozen data cell has to be opaque, and a styled-but-unfilled cell
			// carries `background-color: var(--leovale-sheet-cell-bg)` inline, so
			// redefining that variable here is what makes it so (see cellcss.ts).
			rules.push(
				`${scope} > tbody > tr > td[data-x="${c}"] { position: sticky; left: ${px(left)}; z-index: 2; ` +
					`--leovale-sheet-cell-bg: var(--background-primary); background-color: var(--leovale-sheet-cell-bg); }`,
			);
			rules.push(
				`${scope} > thead > tr > td[data-x="${c}"] { position: sticky; left: ${px(left)}; z-index: 4; }`,
			);
			// The seam: the last frozen column carries the edge of the pane, so the
			// frozen part reads as a pane and not as columns that refuse to scroll.
			if (c === cols - 1) {
				rules.push(
					`${scope} > tbody > tr > td[data-x="${c}"], ${scope} > thead > tr > td[data-x="${c}"] ` +
						`{ box-shadow: 1px 0 0 var(--background-modifier-border); }`,
				);
			}
			left += cell?.getBoundingClientRect().width ?? DEFAULT_COL_WIDTH;
		}

		const head = this.host.querySelector<HTMLElement>("thead > tr");
		let top = head?.getBoundingClientRect().height ?? 0;
		const rows = Math.min(freeze.rows ?? 0, this.dimensions().rows);
		for (let r = 0; r < rows; r++) {
			const tr = this.host.querySelector<HTMLElement>(`tbody > tr[data-y="${r}"]`);
			rules.push(
				`${scope} > tbody > tr[data-y="${r}"] > td { position: sticky; top: ${px(top)}; z-index: 2; ` +
					`--leovale-sheet-cell-bg: var(--background-primary); background-color: var(--leovale-sheet-cell-bg); }`,
			);
			// the gutter cell of a frozen row is sticky on both axes
			rules.push(`${scope} > tbody > tr[data-y="${r}"] > td:first-child { z-index: 4; }`);
			if (r === rows - 1) {
				rules.push(
					`${scope} > tbody > tr[data-y="${r}"] > td { box-shadow: 0 1px 0 var(--background-modifier-border); }`,
				);
			}
			for (let c = 0; c < cols; c++) {
				rules.push(
					`${scope} > tbody > tr[data-y="${r}"] > td[data-x="${c}"] { z-index: 3; }`,
				);
			}
			top += tr?.getBoundingClientRect().height ?? 0;
		}
		return rules.join("\n");
	}

	/** Sort and filter markers on the column headers. */
	private syncHeaderMarks(sheet = 0): void {
		const view = this.views[sheet] ?? {};
		const heads = this.host.querySelectorAll<HTMLElement>("thead > tr > td[data-x]");
		heads.forEach((el) => {
			const col = Number(el.getAttribute("data-x"));
			const sorted = view.sort?.col === col;
			el.toggleClass(SORTED_CLASS, sorted);
			if (sorted) el.setAttribute("data-sort-dir", view.sort?.dir ?? "asc");
			else el.removeAttribute("data-sort-dir");
			el.toggleClass(FILTERED_CLASS, !!view.filters?.[String(col)]);
		});
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

	/** The selection as a rectangle of indexes, or null when there is none. */
	selectionRect(): { r1: number; c1: number; r2: number; c2: number } | null {
		const refs = this.getSelectionRefs();
		if (refs.length === 0) return null;
		let r1 = Infinity;
		let c1 = Infinity;
		let r2 = -Infinity;
		let c2 = -Infinity;
		for (const ref of refs) {
			const { row, col } = parseRef(ref);
			r1 = Math.min(r1, row);
			c1 = Math.min(c1, col);
			r2 = Math.max(r2, row);
			c2 = Math.max(c2, col);
		}
		return { r1, c1, r2, c2 };
	}

	/** Anchor cell of the selection: what the formula bar and the toolbar act on. */
	activeCell(): Cursor | null {
		const rect = this.selectionRect();
		return rect ? { row: rect.r1, col: rect.c1 } : null;
	}

	/**
	 * Move (or extend) the selection to one cell and scroll it into view.
	 *
	 * `updateSelectionFromCoords` paints the selection but does not move the
	 * engine's own `selectedCell`, which is what its arrow keys read - so both
	 * are set here, or the next ArrowDown would jump back to where the mouse
	 * last was.
	 *
	 * `scroll` is what a caller says when the cell may be off screen (a keyboard
	 * move, a search hit). A tap passes `false`: the cell is under the finger,
	 * and scrolling to it is how a horizontal pan used to snap back to column A.
	 */
	selectCell(row: number, col: number, extend = false, scroll = true): void {
		const ws = this.first();
		if (!ws) return;
		const anchor = extend ? this.lastSelection : null;
		const x1 = anchor ? (anchor[0] as number) : col;
		const y1 = anchor ? (anchor[1] as number) : row;
		try {
			ws.updateSelectionFromCoords(x1, y1, col, row);
			(ws as unknown as { selectedCell?: number[] }).selectedCell = [x1, y1, col, row];
		} catch (e) {
			console.error("leovale-sheets: selecting a cell failed", e);
			return;
		}
		this.lastSelection = [x1, y1, col, row];
		if (scroll) this.scrollRefIntoView(cellRef(row, col));
		this.notifySelection();
	}

	/**
	 * Bring a cell into view, unless the user is scrolling.
	 *
	 * Every programmatic scroll in the plugin goes through here, and it is the
	 * single place that knows the rule: a scroll the user performed with their
	 * finger wins, for {@link SCROLL_GRACE_MS} after the gesture. Without it a
	 * pan to column M ended with the sheet back at column A, which reads as a
	 * grid that cannot be scrolled sideways at all.
	 */
	scrollRefIntoView(ref: string): void {
		if (this.isTouchScrolling()) return;
		this.cellElement(ref)?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}

	private notifySelection(): void {
		this.syncSelectionBox();
		try {
			this.selectionListener?.();
		} catch (e) {
			console.error("leovale-sheets: selection listener failed", e);
		}
	}

	/* -------------------------------------------------------- keyboard ops */

	/** F2 / double click: open the in-cell editor on the anchor cell. */
	openEditorAt(row: number, col: number): void {
		const ws = this.first();
		if (!ws || this.readOnly) return;
		const el = this.cellElement(cellRef(row, col)) as HTMLTableCellElement | null;
		if (!el) return;
		try {
			(
				ws as unknown as { openEditor?: (cell: HTMLTableCellElement, empty?: boolean) => void }
			).openEditor?.(el, false);
		} catch (e) {
			console.error("leovale-sheets: opening the editor failed", e);
		}
	}

	/** True while the engine has an in-cell editor open. */
	isEditing(): boolean {
		return !!(this.first() as unknown as { edition?: unknown } | null)?.edition;
	}

	/** Delete: empty every cell of the selection, styles and masks untouched. */
	clearSelection(): void {
		const ws = this.first();
		if (!ws || this.readOnly) return;
		const refs = this.getSelectionRefs();
		if (refs.length === 0) return;
		try {
			ws.setValue(refs, "");
		} catch (e) {
			console.error("leovale-sheets: clearing the selection failed", e);
			return;
		}
		this.notify();
	}

	/**
	 * Ctrl+D. With a range selected the top row is copied down over the rest;
	 * with a single cell selected the cell ABOVE is copied into it, which is
	 * what the shortcut means in every spreadsheet.
	 *
	 * The style and the number mask travel with the value: filling down a
	 * formatted row that only looks the part would be a bug report waiting to
	 * happen.
	 */
	fillDown(): void {
		const ws = this.first();
		if (!ws || this.readOnly) return;
		const rect = this.selectionRect();
		if (!rect) return;
		let src = rect.r1;
		let from = rect.r1 + 1;
		let to = rect.r2;
		if (rect.r1 === rect.r2) {
			if (rect.r1 === 0) return;
			src = rect.r1 - 1;
			from = rect.r1;
			to = rect.r1;
		}
		if (from > to) return;

		const data = this.rawData();
		const styleByCol = new Map<number, CellStyle>();
		try {
			for (let c = rect.c1; c <= rect.c2; c++) {
				const value = data[src]?.[c];
				styleByCol.set(c, this.getStyleAt(cellRef(src, c)));
				for (let r = from; r <= to; r++) {
					ws.setValueFromCoords(c, r, (value ?? "") as JssCellValue);
				}
			}
		} catch (e) {
			console.error("leovale-sheets: fill down failed", e);
			return;
		}
		const refs: string[] = [];
		for (let r = from; r <= to; r++) {
			for (let c = rect.c1; c <= rect.c2; c++) refs.push(cellRef(r, c));
		}
		this.applyStyle(refs, (_cur, ref) => styleByCol.get(parseRef(ref).col) ?? {});
	}

	/** Ctrl+Arrow, Home/End and their Ctrl variants, as computed in sheetops. */
	moveToDataEdge(dRow: number, dCol: number, extend = false): void {
		const cur = this.activeCell();
		if (!cur) return;
		const target = dataEdge(cur, dRow, dCol, this.filled(), this.dimensions());
		this.selectCell(target.row, target.col, extend);
	}

	moveToRowStart(extend = false): void {
		const cur = this.activeCell();
		if (!cur) return;
		this.selectCell(cur.row, 0, extend);
	}

	moveToRowEnd(extend = false): void {
		const cur = this.activeCell();
		if (!cur) return;
		this.selectCell(cur.row, rowEnd(cur.row, this.filled(), this.dimensions()), extend);
	}

	moveToGridStart(extend = false): void {
		this.selectCell(0, 0, extend);
	}

	moveToGridEnd(extend = false): void {
		const end = usedEnd(this.filled(), this.dimensions());
		this.selectCell(end.row, end.col, extend);
	}

	/* ------------------------------------------------- rows and columns */

	/**
	 * Insert rows above or below a row. The engine shifts styles, masks and
	 * merges itself, which is exactly why this goes through it rather than
	 * through the document.
	 */
	insertRows(row: number, count = 1, before = true): void {
		const ws = this.first();
		if (!ws || this.readOnly) return;
		try {
			ws.insertRow(count, row, (before ? 1 : 0) as unknown as number);
		} catch (e) {
			console.error("leovale-sheets: inserting a row failed", e);
			return;
		}
		this.notify();
	}

	deleteRows(row: number, count = 1): void {
		const ws = this.first();
		if (!ws || this.readOnly) return;
		try {
			ws.deleteRow(row, count);
		} catch (e) {
			console.error("leovale-sheets: deleting a row failed", e);
			return;
		}
		this.notify();
	}

	insertColumns(col: number, count = 1, before = true): void {
		const ws = this.first();
		if (!ws || this.readOnly) return;
		try {
			ws.insertColumn(count, col, before);
		} catch (e) {
			console.error("leovale-sheets: inserting a column failed", e);
			return;
		}
		this.notify();
	}

	deleteColumns(col: number, count = 1): void {
		const ws = this.first();
		if (!ws || this.readOnly) return;
		try {
			ws.deleteColumn(col, count);
		} catch (e) {
			console.error("leovale-sheets: deleting a column failed", e);
			return;
		}
		this.notify();
	}

	/* -------------------------------------------------------- clipboard */

	/**
	 * The selection as tab-separated text, which is what every spreadsheet reads
	 * from the clipboard. The DISPLAYED text travels, so a formula arrives as its
	 * result and a currency cell as `$7.00` - the same rule the Markdown copy
	 * follows, and the one a paste into another app expects.
	 */
	selectionTsv(): string {
		const rect = this.selectionRect();
		if (!rect) return "";
		const lines: string[] = [];
		for (let r = rect.r1; r <= rect.r2; r++) {
			const row: string[] = [];
			for (let c = rect.c1; c <= rect.c2; c++) row.push(this.displayText(cellRef(r, c)));
			lines.push(row.join("\t"));
		}
		return lines.join("\n");
	}

	/** Write tab-separated text into the grid, anchored at the selection. */
	pasteTsv(text: string): { rows: number; cols: number } {
		const anchor = this.activeCell();
		if (!anchor || text === "") return { rows: 0, cols: 0 };
		const values = text
			.replace(/\r\n?/g, "\n")
			.replace(/\n$/, "")
			.split("\n")
			.map((line) => line.split("\t"));
		return this.writeRange(anchor.row, anchor.col, values);
	}

	/**
	 * The selection as a STRUCTURED payload: raw values, formula sources, styles
	 * (number mask included) and cell types, plus the TSV that goes out with it.
	 * See clipboard.ts for what the two halves are for.
	 *
	 * A formula travels as its SOURCE, verbatim and unrebased - `=B2+1` pasted
	 * three rows down is still `=B2+1`. That is what fill-down does with a
	 * formula, what the file format stores, and what a paste of TEXT has always
	 * done here; a relative rewrite would be a third rule for the same cell.
	 */
	selectionClip(cut = false): SheetClip | null {
		const rect = this.selectionRect();
		if (!rect) return null;
		const cells: ClipCell[][] = [];
		for (let r = rect.r1; r <= rect.r2; r++) {
			const line: ClipCell[] = [];
			for (let c = rect.c1; c <= rect.c2; c++) {
				const ref = cellRef(r, c);
				const raw = this.getRawValue(ref);
				line.push({
					// `makeClip` prefers `f` and drops the other, so both may be given.
					v: raw === null ? undefined : raw,
					f: typeof raw === "string" && raw.startsWith("=") ? raw : undefined,
					s: this.getStyleAt(ref),
					t: this.getCellType(ref),
				});
			}
			cells.push(line);
		}
		return makeClip(cells, this.selectionTsv(), cut ? { owner: this, rect } : null);
	}

	/**
	 * Write a structured payload into the grid, anchored at the selection and
	 * clipped to the grid's own size - the same rule {@link writeRange} follows,
	 * for the same reason.
	 *
	 * The style is REPLACED rather than merged: a copied cell brings its whole
	 * appearance, and a destination that kept its old fill under a pasted one
	 * would be neither.
	 */
	pasteClip(clip: SheetClip): { rows: number; cols: number } {
		const ws = this.first();
		const anchor = this.activeCell();
		if (!ws || this.readOnly || !anchor) return { rows: 0, cols: 0 };
		const size = this.dimensions();
		const rows = Math.max(0, Math.min(clip.rows, size.rows - anchor.row));
		const cols = Math.max(0, Math.min(clip.cols, size.cols - anchor.col));
		if (rows === 0 || cols === 0) return { rows: 0, cols: 0 };

		const refs: string[] = [];
		const styles = new Map<string, CellStyle>();
		const boxes: string[] = [];
		const plain: string[] = [];
		try {
			for (let r = 0; r < rows; r++) {
				for (let c = 0; c < cols; c++) {
					const cell = clip.cells[r]?.[c] ?? {};
					const ref = cellRef(anchor.row + r, anchor.col + c);
					refs.push(ref);
					styles.set(ref, cell.s ?? {});
					(cell.t === "cb" ? boxes : plain).push(ref);
					ws.setValueFromCoords(
						anchor.col + c,
						anchor.row + r,
						(cell.f ?? cell.v ?? "") as JssCellValue,
					);
				}
			}
		} catch (e) {
			console.error("leovale-sheets: pasting a range failed", e);
			return { rows: 0, cols: 0 };
		}
		this.applyStyle(refs, (_cur, ref) => styles.get(ref) ?? {});
		// Types go on in two passes because they are an attribute per cell, and a
		// destination that used to be a checkbox column must stop being one.
		if (boxes.length > 0) this.setCellType(boxes, "cb");
		if (plain.length > 0) this.setCellType(plain, null);
		this.notify();
		return { rows, cols };
	}

	/**
	 * Empty a rectangle completely: values, formulas, styles and types. This is
	 * the "source" half of a cut, and it is deliberately more than
	 * {@link clearSelection} (which is the Delete key, and Delete clears content,
	 * not formatting).
	 */
	clearRect(rect: ClipRect): void {
		const ws = this.first();
		if (!ws || this.readOnly) return;
		const refs: string[] = [];
		for (let r = rect.r1; r <= rect.r2; r++) {
			for (let c = rect.c1; c <= rect.c2; c++) refs.push(cellRef(r, c));
		}
		if (refs.length === 0) return;
		try {
			ws.setValue(refs, "" as JssCellValue);
		} catch (e) {
			console.error("leovale-sheets: clearing a range failed", e);
			return;
		}
		this.setCellType(refs, null);
		// Last, and it is what calls `notify`: the style write is the one that
		// cannot be skipped even when nothing else changed.
		this.applyStyle(refs, () => ({}));
	}

	/**
	 * Draw the outline of the selected range as an OVERLAY, above every cell.
	 *
	 * WHY NOT THE CELLS' OWN BORDERS, which is how the vendor does it (and how
	 * this plugin did it until the outline was reported half-missing). The
	 * vendor puts `highlight-top`/`-left`/`-right`/`-bottom` on the edge cells
	 * and recolours the matching border. A cell border is a shared edge, and it
	 * is shared with a cell that may have a border of its own: ours are 1px
	 * accent, a user's are `1px solid var(--leovale-sheet-border-strong)` written
	 * INLINE - and an inline declaration beats a rule, so the user's border took
	 * the edge every time. Measured on the user's sheet: a cell with borders on
	 * all four sides showed the accent outline on its top and left only, and a
	 * cell whose neighbours were all bordered showed almost none of it. The same
	 * arithmetic makes the outline vanish behind a fill's neighbour, a merged
	 * cell's edge, and anything else that owns a border.
	 *
	 * An overlay has no shared edges. One absolutely positioned box, 2px of
	 * accent, `pointer-events: none` so it cannot swallow a click, sized to the
	 * union of the cells the vendor actually marked - which is what makes it
	 * right for a merged cell (one `<td>`, several addresses) and for a range
	 * crossing hidden rows (a filtered row's cells measure 0 and are skipped).
	 *
	 * It lives in `.jss_content`, the vendor's own positioned container and the
	 * one the fill handle is placed in, so it SCROLLS WITH THE GRID for free:
	 * no scroll listener, nothing to go stale between frames. Its `z-index` sits
	 * above the frozen panes (2-4) and below the fill handle (20), so a
	 * selection inside a frozen row keeps its outline; the cost is that an
	 * outline belonging to rows scrolled underneath a frozen pane draws over it,
	 * which is the lesser of the two and only while it is being scrolled past.
	 */
	syncSelectionBox(): void {
		const content = this.host.querySelector<HTMLElement>(".jss_content");
		if (!content) return;
		let box = this.selBox;
		if (!box || !box.isConnected || box.parentElement !== content) {
			box?.remove();
			box = content.createDiv({ cls: SELBOX_CLASS });
			this.selBox = box;
		}
		let left = Infinity;
		let top = Infinity;
		let right = -Infinity;
		let bottom = -Infinity;
		this.host.querySelectorAll<HTMLElement>("tbody > tr > td.highlight").forEach((cell) => {
			const r = cell.getBoundingClientRect();
			// A row hidden by a filter, or a cell swallowed by a merge, measures 0.
			if (r.width < 1 || r.height < 1) return;
			left = Math.min(left, r.left);
			top = Math.min(top, r.top);
			right = Math.max(right, r.right);
			bottom = Math.max(bottom, r.bottom);
		});
		if (!Number.isFinite(left)) {
			box.style.display = "none";
			return;
		}
		// Absolute children are placed against the containing block's PADDING box;
		// `.jss_content` has padding but no border, so its client rect is that box.
		const base = content.getBoundingClientRect();
		box.style.display = "block";
		box.style.left = `${Math.round(left - base.left)}px`;
		box.style.top = `${Math.round(top - base.top)}px`;
		box.style.width = `${Math.round(right - left)}px`;
		box.style.height = `${Math.round(bottom - top)}px`;
	}

	/** Draw, or with `null` remove, the marker on the cells a cut is holding. */
	markCutRange(rect: ClipRect | null): void {
		for (const ref of this.cutRefs) this.cellElement(ref)?.classList.remove(CUT_CLASS);
		this.cutRefs = [];
		if (!rect) return;
		for (let r = rect.r1; r <= rect.r2; r++) {
			for (let c = rect.c1; c <= rect.c2; c++) {
				const ref = cellRef(r, c);
				this.cutRefs.push(ref);
				this.cellElement(ref)?.classList.add(CUT_CLASS);
			}
		}
	}

	/* ---------------------------------------------------------- fill handle */

	/**
	 * Excel's fill handle: drag the little square at the corner of the selection
	 * and the selection CONTINUES over the cells you drag across.
	 *
	 * WHY THE GESTURE IS TAKEN OFF THE VENDOR RATHER THAN CONFIGURED. jspreadsheet
	 * has a corner drag of its own (`autoIncrement`), and it can do two of the
	 * five things this needs. It steps a number by exactly ±1, never by the step
	 * the samples describe; and it only does even that when the selection is a
	 * SINGLE ROW - so the `1, 2, 3` a user selects, which is three rows, was a
	 * plain copy. It also strips every `$` out of a dragged formula. So the
	 * `mousedown` on `.jss_corner` is swallowed in the capture phase (the vendor
	 * listens on `document`, in the bubble phase, so stopping it there is enough)
	 * and the whole gesture is ours: preview, series, styles and history.
	 *
	 * WHAT IS FILLED. One LANE at a time - a column for a vertical drag, a row
	 * for a horizontal one - because that is what a series is: `1, 2, 3` beside
	 * `10, 20, 30` dragged down continues both, independently, which is what a
	 * spreadsheet does. {@link planFill} decides each lane on its own.
	 *
	 * DIRECTION is single-axis, as everywhere else: the drag that started at the
	 * corner extends either vertically or horizontally, whichever the pointer has
	 * travelled further out of the selection, and never both at once.
	 */
	private installFillHandle(): void {
		const start = (e: Event) => {
			const target = e.target as HTMLElement | null;
			if (!target?.classList?.contains("jss_corner")) return;
			if (this.readOnly) return;
			const point = pointerOf(e);
			if (!point) return;
			// The vendor must not also start its own copy-drag on this press.
			e.stopPropagation();
			if (e.cancelable) e.preventDefault();
			this.beginFill(point, e.type.startsWith("touch"));
		};
		this.root.addEventListener("mousedown", start, { capture: true });
		this.fillHandlers.push(["mousedown", start]);
		this.root.addEventListener("touchstart", start, { capture: true });
		this.fillHandlers.push(["touchstart", start]);
		// The handle is a 7px square with no affordance whatever. A tooltip is
		// the cheapest one there is, and it is what a screen reader reads out.
		const corner = this.host.querySelector<HTMLElement>(".jss_corner");
		if (corner) {
			corner.setAttribute("title", t("fillHandle"));
			corner.setAttribute("aria-label", t("fillHandle"));
		}
	}

	private beginFill(point: { x: number; y: number }, touch: boolean): void {
		const src = this.selectionRect();
		if (!src) return;
		const doc = this.root.ownerDocument;
		const move = (e: Event) => {
			const p = pointerOf(e);
			if (!p) return;
			// A finger dragging the handle is not the page scrolling.
			if (e.cancelable) e.preventDefault();
			this.trackFill(p);
		};
		const up = () => this.endFill(true);
		const cancel = () => this.endFill(false);
		this.fill = { src, dst: null, touch, move, up, cancel, doc };
		doc.addEventListener("mousemove", move, true);
		doc.addEventListener("mouseup", up, true);
		doc.addEventListener("touchmove", move, { capture: true, passive: false });
		doc.addEventListener("touchend", up, true);
		doc.addEventListener("touchcancel", cancel, true);
		this.trackFill(point);
	}

	/** Where the pointer is now -> which cells the drag would fill. */
	private trackFill(point: { x: number; y: number }): void {
		const state = this.fill;
		if (!state) return;
		const el = this.root.ownerDocument.elementFromPoint(point.x, point.y) as HTMLElement | null;
		const cell = el?.closest?.("tbody > tr > td[data-x][data-y]") as HTMLElement | null;
		state.dst = cell ? this.fillTargetRect(state.src, cell) : null;
		this.drawFillBox(state.dst);
	}

	/**
	 * The rectangle a drag to `cell` fills, given the source rectangle.
	 *
	 * Single axis, and the axis is the one the pointer has left the selection on
	 * by the greater number of cells. A pointer still inside the selection fills
	 * nothing, which is how a drag is cancelled by dragging back.
	 */
	private fillTargetRect(src: ClipRect, cell: HTMLElement): ClipRect | null {
		const row = Number(cell.getAttribute("data-y"));
		const col = Number(cell.getAttribute("data-x"));
		if (!Number.isInteger(row) || !Number.isInteger(col)) return null;
		const down = row - src.r2;
		const up = src.r1 - row;
		const right = col - src.c2;
		const left = src.c1 - col;
		const vertical = Math.max(down, up);
		const horizontal = Math.max(right, left);
		if (vertical <= 0 && horizontal <= 0) return null;
		if (vertical >= horizontal) {
			return down > 0
				? { r1: src.r2 + 1, c1: src.c1, r2: row, c2: src.c2 }
				: { r1: row, c1: src.c1, r2: src.r1 - 1, c2: src.c2 };
		}
		return right > 0
			? { r1: src.r1, c1: src.c2 + 1, r2: src.r2, c2: col }
			: { r1: src.r1, c1: col, r2: src.r2, c2: src.c1 - 1 };
	}

	/**
	 * The preview, drawn the same way the selection outline is: one absolutely
	 * positioned box in the vendor's `.jss_content`, measured off the cells the
	 * drag currently covers. A dashed border rather than a solid one, so it can
	 * never be mistaken for the selection it is about to extend.
	 */
	private drawFillBox(rect: ClipRect | null): void {
		const content = this.host.querySelector<HTMLElement>(".jss_content");
		if (!content) return;
		let box = this.fillBox;
		if (!box || !box.isConnected || box.parentElement !== content) {
			box?.remove();
			box = content.createDiv({ cls: FILLBOX_CLASS });
			this.fillBox = box;
		}
		if (!rect) {
			box.style.display = "none";
			return;
		}
		let left = Infinity;
		let top = Infinity;
		let right = -Infinity;
		let bottom = -Infinity;
		for (let r = rect.r1; r <= rect.r2; r++) {
			for (let c = rect.c1; c <= rect.c2; c++) {
				const box2 = this.cellElement(cellRef(r, c))?.getBoundingClientRect();
				if (!box2 || box2.width < 1 || box2.height < 1) continue;
				left = Math.min(left, box2.left);
				top = Math.min(top, box2.top);
				right = Math.max(right, box2.right);
				bottom = Math.max(bottom, box2.bottom);
			}
		}
		if (!Number.isFinite(left)) {
			box.style.display = "none";
			return;
		}
		const base = content.getBoundingClientRect();
		box.style.display = "block";
		box.style.left = `${Math.round(left - base.left)}px`;
		box.style.top = `${Math.round(top - base.top)}px`;
		box.style.width = `${Math.round(right - left)}px`;
		box.style.height = `${Math.round(bottom - top)}px`;
	}

	/** Finish the gesture: `commit` false means it was cancelled. */
	private endFill(commit: boolean): void {
		const state = this.fill;
		this.fill = null;
		if (!state) return;
		const { doc, move, up, cancel } = state;
		doc.removeEventListener("mousemove", move, true);
		doc.removeEventListener("mouseup", up, true);
		doc.removeEventListener("touchmove", move, true);
		doc.removeEventListener("touchend", up, true);
		doc.removeEventListener("touchcancel", cancel, true);
		this.drawFillBox(null);
		if (commit && state.dst) this.fillRange(state.src, state.dst);
	}

	/**
	 * Write the series into `dst`, and extend the selection over it.
	 *
	 * Public because the touch and mouse paths are not the only callers worth
	 * having: it is also the whole feature, testable without a pointer.
	 *
	 * Everything a cell is travels: the value (or the continued series), the
	 * style, the number mask and the checkbox type, repeating the samples in
	 * order. A formula is the exception the series rules already carve out - it
	 * is rewritten by offset instead of continued (see {@link shiftFormula}).
	 */
	fillRange(src: ClipRect, dst: ClipRect): { rows: number; cols: number } {
		const ws = this.first();
		if (!ws || this.readOnly) return { rows: 0, cols: 0 };
		const size = this.dimensions();
		const rect = {
			r1: Math.max(0, dst.r1),
			c1: Math.max(0, dst.c1),
			r2: Math.min(size.rows - 1, dst.r2),
			c2: Math.min(size.cols - 1, dst.c2),
		};
		if (rect.r2 < rect.r1 || rect.c2 < rect.c1) return { rows: 0, cols: 0 };

		const vertical = rect.c1 === src.c1 && rect.c2 === src.c2;
		// Which way the series travels: away from the source rectangle.
		const forward = vertical ? rect.r1 > src.r2 : rect.c1 > src.c2;
		const mark = this.historyMark(ws);
		const refs: string[] = [];
		const styles = new Map<string, CellStyle>();
		const boxes: string[] = [];
		const plain: string[] = [];

		try {
			const lanes = vertical ? src.c2 - src.c1 + 1 : src.r2 - src.r1 + 1;
			for (let lane = 0; lane < lanes; lane++) {
				// The source cells of this lane, in the order the fill travels: a
				// drag upwards reads them bottom-to-top, and the series code needs
				// no idea which way it is going.
				const sources: { row: number; col: number }[] = [];
				const span = vertical ? src.r2 - src.r1 + 1 : src.c2 - src.c1 + 1;
				for (let i = 0; i < span; i++) {
					const step = forward ? i : span - 1 - i;
					sources.push(
						vertical
							? { row: src.r1 + step, col: src.c1 + lane }
							: { row: src.r1 + lane, col: src.c1 + step },
					);
				}
				const targets: { row: number; col: number }[] = [];
				const count = vertical ? rect.r2 - rect.r1 + 1 : rect.c2 - rect.c1 + 1;
				for (let i = 0; i < count; i++) {
					const step = forward ? i : count - 1 - i;
					targets.push(
						vertical
							? { row: rect.r1 + step, col: src.c1 + lane }
							: { row: src.r1 + lane, col: rect.c1 + step },
					);
				}

				const raws = sources.map((p) => this.getRawValue(cellRef(p.row, p.col)));
				// A lane with a hole in it describes no series anybody could name,
				// so it repeats instead - which is what `values: []` selects below.
				const complete = raws.every((v) => v !== null && v !== "");
				const values = complete ? planFill(raws as FillValue[], targets.length) : [];

				targets.forEach((t, i) => {
					const from = sources[i % sources.length] as { row: number; col: number };
					const raw = raws[i % raws.length];
					const ref = cellRef(t.row, t.col);
					let value: FillValue = "";
					if (isFormula(raw)) {
						value = shiftFormula(raw, t.row - from.row, t.col - from.col);
					} else if (values.length > 0) {
						value = values[i] as FillValue;
					} else if (raw !== null && raw !== undefined) {
						value = raw;
					}
					refs.push(ref);
					styles.set(ref, this.getStyleAt(cellRef(from.row, from.col)));
					(this.getCellType(cellRef(from.row, from.col)) === "cb" ? boxes : plain).push(ref);
					ws.setValueFromCoords(t.col, t.row, value as JssCellValue);
				});
			}
		} catch (e) {
			console.error("leovale-sheets: filling a range failed", e);
			return { rows: 0, cols: 0 };
		}

		this.applyStyle(refs, (_cur, ref) => styles.get(ref) ?? {});
		if (boxes.length > 0) this.setCellType(boxes, "cb");
		if (plain.length > 0) this.setCellType(plain, null);
		// One drag is one undo, on BOTH layers.
		//
		// The engine's own stack is folded here (see {@link historyMark}), which
		// is what keeps it coherent for anything that still reads it. What Ctrl+Z
		// actually walks since 1.7.0 is the DOCUMENT history in history.ts, and
		// that one is satisfied by construction rather than by folding: every
		// write a fill performs - a value per cell, then the styles, then the cell
		// types - happens inside this one synchronous call, so the view's coalescing
		// window (300 ms, restarted by each change) closes once, after the last of
		// them, and the whole drag becomes a single snapshot. However long the
		// pointer was held makes no difference: nothing is written until the
		// button comes up. The e2e proves it on the file: drag, one Ctrl+Z, the
		// bytes on disk are what they were.
		this.coalesceHistory(ws, mark);
		// The source AND what it produced end up selected, as in Excel: the next
		// drag continues the longer series.
		this.selectRange(
			Math.min(src.r1, rect.r1),
			Math.min(src.c1, rect.c1),
			Math.max(src.r2, rect.r2),
			Math.max(src.c2, rect.c2),
		);
		this.notify();
		return { rows: rect.r2 - rect.r1 + 1, cols: rect.c2 - rect.c1 + 1 };
	}

	/** Where the engine's undo stack stands right now; see {@link coalesceHistory}. */
	private historyMark(ws: WorksheetInstance): number {
		const idx = (ws as unknown as { historyIndex?: number }).historyIndex;
		return typeof idx === "number" ? idx + 1 : -1;
	}

	/**
	 * Fold everything a fill pushed onto the engine's undo stack into ONE entry.
	 *
	 * A fill writes cell by cell (`setValueFromCoords`) and then styles them in
	 * one go, which is a `setValue` record per cell plus a `setStyle` record -
	 * i.e. one drag would cost twenty presses of Ctrl+Z. The vendor's own paste
	 * has the same shape and solves it the same way: a single
	 * `{action: "setValue", records, oldStyle, newStyle}` entry, which its `undo`
	 * already knows how to replay (it walks `records` for the values and calls
	 * `resetStyle(oldStyle)` for the appearance).
	 *
	 * Defensive by construction: anything unexpected on the stack and the entries
	 * are left exactly as they were, so the worst case is the old behaviour
	 * rather than a broken undo.
	 */
	private coalesceHistory(ws: WorksheetInstance, mark: number): void {
		if (mark < 0) return;
		try {
			const inner = ws as unknown as {
				history?: Record<string, unknown>[];
				historyIndex?: number;
				selectedCell?: number[];
			};
			const history = inner.history;
			const index = inner.historyIndex;
			if (!Array.isArray(history) || typeof index !== "number" || index < mark) return;
			const records: unknown[] = [];
			let oldStyle: unknown;
			let newStyle: unknown;
			for (let i = mark; i <= index; i++) {
				const entry = history[i];
				if (!entry) return;
				if (entry["action"] === "setValue" && Array.isArray(entry["records"])) {
					records.push(...(entry["records"] as unknown[]));
				} else if (entry["action"] === "setStyle") {
					// Only the FIRST style write's "before" is the real before.
					if (oldStyle === undefined) oldStyle = entry["oldValue"];
					newStyle = entry["newValue"];
				} else {
					return;
				}
			}
			if (records.length === 0) return;
			history.length = mark;
			history[mark] = {
				action: "setValue",
				records,
				selection: inner.selectedCell,
				oldStyle,
				newStyle,
			};
			inner.historyIndex = mark;
		} catch (e) {
			console.error("leovale-sheets: folding the fill into one undo failed", e);
		}
	}

	/** Paint the selection over a rectangle, without moving the anchor's scroll. */
	private selectRange(r1: number, c1: number, r2: number, c2: number): void {
		const ws = this.first();
		if (!ws) return;
		try {
			ws.updateSelectionFromCoords(c1, r1, c2, r2);
			(ws as unknown as { selectedCell?: number[] }).selectedCell = [c1, r1, c2, r2];
			this.lastSelection = [c1, r1, c2, r2];
		} catch (e) {
			console.error("leovale-sheets: selecting the filled range failed", e);
		}
		this.notifySelection();
	}

	/* ---------------------------------------------------------- column width */

	columnWidth(col: number): number {
		const ws = this.first();
		if (!ws) return DEFAULT_COL_WIDTH;
		try {
			const w = ws.getWidth(col);
			const n = typeof w === "string" ? parseInt(w, 10) : (w as number);
			if (Number.isFinite(n) && n > 0) return Math.round(n);
		} catch {
			/* fall through to the element */
		}
		const el = this.host.querySelector<HTMLElement>(`thead > tr > td[data-x="${col}"]`);
		return Math.round(el?.getBoundingClientRect().width ?? DEFAULT_COL_WIDTH);
	}

	setColumnWidth(cols: number[], width: number): void {
		const ws = this.first();
		if (!ws || this.readOnly || cols.length === 0) return;
		const px = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.round(width)));
		try {
			for (const col of cols) ws.setWidth(col, px);
		} catch (e) {
			console.error("leovale-sheets: setting the column width failed", e);
			return;
		}
		this.notify();
	}

	/**
	 * Autofit: the width of the widest thing in the column, measured rather than
	 * guessed. `measureText` on a canvas is used instead of the elements' own
	 * widths because a cell is exactly as wide as its column - its content, which
	 * is what we are asking about, is invisible to the layout.
	 */
	autofitColumn(col: number): number {
		const { rows } = this.dimensions();
		const canvas = document.createElement("canvas");
		const ctx = canvas.getContext("2d");
		let max = 0;
		const header = this.host.querySelector<HTMLElement>(`thead > tr > td[data-x="${col}"]`);
		if (ctx && header) {
			const hcs = getComputedStyle(header);
			ctx.font = `${hcs.fontWeight} ${hcs.fontSize} ${hcs.fontFamily}`;
			max = ctx.measureText(header.textContent ?? "").width;
		}
		for (let r = 0; r < rows && ctx; r++) {
			const el = this.cellElement(cellRef(r, col));
			const text = el?.textContent ?? "";
			if (!el || text === "") continue;
			const cs = getComputedStyle(el);
			ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
			max = Math.max(max, ctx.measureText(text).width);
		}
		// cell padding (8px each side in the theme layer) plus the borders
		const width = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.ceil(max) + 20));
		this.setColumnWidth([col], width);
		return width;
	}

	/* --------------------------------------------------------------- search */

	private foundRefs: string[] = [];

	/** Highlight every cell containing `query` and return them in reading order. */
	search(query: string): string[] {
		this.clearSearchHighlight();
		const refs = findMatches(this.shape(), query, this.reader());
		this.foundRefs = refs;
		for (const ref of refs) this.cellElement(ref)?.classList.add(FOUND_CLASS);
		return refs;
	}

	/** Make one of the matches the current one and put the cursor on it. */
	focusMatch(ref: string): void {
		for (const other of this.foundRefs) {
			this.cellElement(other)?.classList.remove(FOUND_CURRENT_CLASS);
		}
		const el = this.cellElement(ref);
		if (!el) return;
		el.classList.add(FOUND_CURRENT_CLASS);
		const { row, col } = parseRef(ref);
		this.selectCell(row, col);
	}

	clearSearchHighlight(): void {
		for (const ref of this.foundRefs) {
			const el = this.cellElement(ref);
			el?.classList.remove(FOUND_CLASS);
			el?.classList.remove(FOUND_CURRENT_CLASS);
		}
		this.foundRefs = [];
	}

	/**
	 * The text a cell shows right now: what "copy as Markdown" copies.
	 *
	 * A cell whose links we rendered gives back the SOURCE (`[[Note]]`), not the
	 * link's label: a wiki link pasted into a note is a working link there, and
	 * the label alone would be a link thrown away.
	 *
	 * A checkbox gives back `true`/`false` for a related reason and one extra:
	 * its text was REPLACED by an `<input>`, so the element has nothing to read
	 * and the cell used to travel as an empty string - into Excel, into a
	 * Markdown table, and into the text a paste is matched against, where a
	 * column of tick boxes made the whole range unrecognisable.
	 */
	displayText(ref: string): string {
		const el = this.cellElement(ref);
		if (!el) return "";
		const link = el.getAttribute(LINK_SRC_ATTR);
		if (link !== null && el.querySelector(`a.${LINK_CLASS}`)) return link;
		if (normalizeCellType(el.getAttribute(TYPE_ATTR)) === "cb") {
			return String(isCheckedValue(this.getRawValue(ref) as CellValue));
		}
		return el.textContent ?? "";
	}

	/* ------------------------------------------------------- writing a block */

	/**
	 * Write a rectangle of text into the grid at (row, col), clipped to the
	 * grid's own size - a pasted table wider than the sheet loses its tail rather
	 * than silently growing a file to 400 columns. Returns what was written.
	 */
	writeRange(row: number, col: number, values: string[][]): { rows: number; cols: number } {
		const ws = this.first();
		if (!ws || this.readOnly) return { rows: 0, cols: 0 };
		const size = this.dimensions();
		const rows = Math.max(0, Math.min(values.length, size.rows - row));
		let cols = 0;
		try {
			for (let r = 0; r < rows; r++) {
				const line = values[r] ?? [];
				const width = Math.max(0, Math.min(line.length, size.cols - col));
				cols = Math.max(cols, width);
				for (let c = 0; c < width; c++) {
					ws.setValueFromCoords(col + c, row + r, (line[c] ?? "") as JssCellValue);
				}
			}
		} catch (e) {
			console.error("leovale-sheets: writing a range failed", e);
		}
		this.notify();
		return { rows, cols };
	}

	/** Apply one horizontal alignment per column over a written block. */
	applyColumnAligns(
		anchor: { row: number; col: number },
		size: { rows: number; cols: number },
		aligns: (CellStyle["ha"] | undefined)[],
	): void {
		if (size.rows === 0 || size.cols === 0) return;
		const byCol = new Map<number, CellStyle["ha"] | undefined>();
		const refs: string[] = [];
		for (let c = 0; c < size.cols; c++) {
			byCol.set(anchor.col + c, aligns[c]);
			for (let r = 0; r < size.rows; r++) refs.push(cellRef(anchor.row + r, anchor.col + c));
		}
		// A table whose separator row says nothing about any column (`---`
		// everywhere) must not clear the alignments the sheet already had.
		if (![...byCol.values()].some(Boolean)) return;
		this.applyStyle(refs, (cur, ref) => {
			const next: CellStyle = { ...cur };
			const ha = byCol.get(parseRef(ref).col);
			if (ha) next.ha = ha;
			else delete next.ha;
			return next;
		});
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
	 *
	 * Since {@link installTouchGestures} the engine no longer sees `touchstart`
	 * inside the grid at all, so the timer is normally never armed. This stays as
	 * the belt to those braces: a touch that begins outside the grid root (the
	 * toolbar, an edge gesture we deliberately let through) still reaches the
	 * engine's own listener.
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

			// Masks and cell types live on the elements for the same reason, one
			// attribute per cell.
			const records = (ws as unknown as { records?: { element?: HTMLElement }[][] }).records ?? [];
			for (let r = 0; r < records.length; r++) {
				const row = records[r] ?? [];
				for (let c = 0; c < row.length; c++) {
					const el = row[c]?.element;
					if (!el || r >= page.rows || c >= page.cols) continue;
					const ref = cellRef(r, c);
					const nf = normalizeNf(el.getAttribute(NF_ATTR));
					if (nf) {
						const cell = page.cells[ref] ?? {};
						cell.s = { ...(cell.s ?? {}), nf };
						page.cells[ref] = cell;
					}
					const type = normalizeCellType(el.getAttribute(TYPE_ATTR));
					if (type) {
						const cell = page.cells[ref] ?? {};
						cell.t = type;
						// A checkbox holds a boolean, whatever the engine kept: it may
						// have arrived as the string "true" from a paste or an editor.
						if (cell.f === undefined) cell.v = isCheckedValue(cell.v);
						page.cells[ref] = cell;
					}
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

			// Sort, filters and frozen panes are OURS: the engine has no idea any of
			// them exist, so they come from the state this wrapper keeps per page
			// (which is also why they survive a round trip through a page the UI
			// never touched).
			page.view = normalizeView(this.views[index] ?? {});
			page.freeze = normalizeFreeze(this.freezes[index] ?? {});

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
		this.endTouch();
		for (const [type, fn, capture] of this.touchHandlers) {
			this.root.removeEventListener(type, fn, capture);
		}
		this.touchHandlers = [];
		// A drag in flight owns listeners on the DOCUMENT; ending it first is what
		// keeps them from outliving the grid.
		this.endFill(false);
		for (const [type, fn] of this.fillHandlers) {
			this.root.removeEventListener(type, fn, true);
		}
		this.fillHandlers = [];
		this.fillBox?.remove();
		this.fillBox = null;
		if (this.keyBridge && this.keyBridgeDoc) {
			this.keyBridgeDoc.removeEventListener("keydown", this.keyBridge);
		}
		this.keyBridge = null;
		this.keyBridgeDoc = null;
		if (this.clipKeys && this.clipKeysDoc) {
			this.clipKeysDoc.removeEventListener("keydown", this.clipKeys, true);
		}
		this.clipKeys = null;
		this.clipKeysDoc = null;
		if (this.histKeys && this.histKeysDoc) {
			this.histKeysDoc.removeEventListener("keydown", this.histKeys, true);
		}
		this.histKeys = null;
		this.histKeysDoc = null;
		// A cut whose source is being torn down cannot be completed: the marker
		// would outlive the grid it points into, and the next paste would call
		// `clearRect` on a destroyed engine.
		if (pendingCut()?.owner === this) cancelCut();
		this.cutRefs = [];
		this.selBox?.remove();
		this.selBox = null;
		if (this.freezeTimer !== null) {
			window.clearTimeout(this.freezeTimer);
			this.freezeTimer = null;
		}
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
