import {
	type HoverPopover,
	type Modifier,
	Notice,
	Platform,
	Scope,
	TextFileView,
	type TFile,
	type WorkspaceLeaf,
} from "obsidian";
import { SheetEngine } from "./engine";
import { SheetToolbar } from "./toolbar";
import { SheetFormulaBar } from "./formulabar";
import { SheetFind } from "./find";
import { ColumnWidthModal, ConfirmModal } from "./dialogs";
import { exportDocAsXlsx } from "./xlsxio";
import {
	type CsvDelimiter,
	DEFAULT_DELIMITER,
	csvToDoc,
	docToCsv,
} from "./csv";
import { t } from "./i18n";
import {
	MIN_VALID,
	type SheetDoc,
	type SortDir,
	cellRef,
	isSupportedVersion,
	newSheetDoc,
	parseSheet,
	serializeSheet,
} from "./format";
import {
	type MdAlign,
	markdownAligns,
	parseMarkdownTable,
	sortPage,
	toMarkdownTable,
} from "./sheetops";

export const VIEW_TYPE_SHEET = "leovale-sheet-view";

/** Which on-disk shape the open file has. */
export type SheetMode = "sheet" | "csv";

/** Extensions that carry our deterministic JSON. Everything else is CSV. */
export const JSON_EXTENSIONS = ["sheet", "lsheet"];

/** Quiet time before we ask Obsidian to save (Obsidian then debounces ~2 s more). */
const SAVE_DEBOUNCE_MS = 1500;

/**
 * How long after a load the document refuses to become dirty.
 *
 * Mounting a grid fires a lot of events, and a straggler from the OUTGOING
 * document (a blur from a focused formula bar, an engine editor closing) can
 * still arrive after the new one is on screen. Opening a file must never, ever
 * change it, so anything that asks for a save inside this window is dropped.
 * A human cannot type in the first 250 ms of a view they just opened.
 */
const LOAD_QUIET_MS = 250;

/**
 * Spreadsheet view for `.sheet` files.
 *
 * NOTE ON MEMBER NAMES: every field below is prefixed with `sheet`. `TextFileView`
 * and its bases keep undocumented internal state on the instance — in particular
 * a `dirty` flag that Obsidian resets around its own save bookkeeping. A plain
 * `private dirty` field collides with it and silently swallows every autosave
 * (verified: the flag was reset between our scheduleSave() and getViewData(),
 * so the file kept its creation-time contents). Do not un-prefix these.
 */
export class SheetView extends TextFileView {
	/**
	 * Where Obsidian's Page Preview parks the popover it opens for a link in a
	 * cell. It is the one field here that is NOT prefixed with `sheet`, and it
	 * cannot be: the core plugin looks for this exact name on the `hoverParent`
	 * it is handed (see {@link linkHandlers}).
	 */
	hoverPopover: HoverPopover | null = null;
	private sheetEngine: SheetEngine | null = null;
	private sheetToolbar: SheetToolbar | null = null;
	private sheetFormulaBar: SheetFormulaBar | null = null;
	private sheetFind: SheetFind | null = null;
	private sheetWrapper: HTMLElement | null = null;
	/** Last serialization we trust; the anti-truncation floor for getViewData(). */
	private sheetLastGood: string | null = null;
	private sheetDirty = false;
	private sheetSaveTimer: number | null = null;
	private sheetReadOnly = false;
	/** True while a document is being mounted; see {@link LOAD_QUIET_MS}. */
	private sheetLoading = false;
	private sheetLoadTimer: number | null = null;
	/** `.sheet`/`.lsheet` keep JSON; `.csv` keeps CSV. Decided per opened file. */
	private sheetMode: SheetMode = "sheet";
	/** Delimiter sniffed from the CSV we loaded; preserved on every write. */
	private sheetDelimiter: CsvDelimiter = DEFAULT_DELIMITER;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_SHEET;
	}

	getIcon(): string {
		return "table";
	}

	getDisplayText(): string {
		return this.file?.basename ?? "Spreadsheet";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("leovale-sheet-content");
		this.installKeys();
	}

	/* ------------------------------------------------------------- keyboard */

	/**
	 * The spreadsheet keys, registered in the VIEW'S OWN SCOPE.
	 *
	 * Not on the wrapper element, and this is the whole lesson of the feature:
	 * Obsidian's keymap listens on `window` in the capture phase and swallows its
	 * global hotkeys before they reach any DOM listener of ours. F2 is "Rename
	 * file", Ctrl+F is "Search current file" - measured in the sandbox, neither
	 * keystroke ever reached the grid. `View.scope` is the sanctioned answer:
	 * Obsidian pushes it while THIS view has the focus and consults it first, so
	 * the keys below work inside the grid and are still Obsidian's everywhere
	 * else. Nothing global is eaten, and there is nothing to tear down by hand -
	 * the scope dies with the view.
	 *
	 * A handler returning `false` means "handled, prevent the default"; returning
	 * `true` lets Obsidian carry on, which is what every guard below does.
	 */
	private installKeys(): void {
		const scope = new Scope(this.app.scope);
		this.scope = scope;

		const on = (
			mods: Modifier[][],
			key: string,
			run: (e: KeyboardEvent) => void,
			needsWrite = false,
		) => {
			for (const modifiers of mods) {
				scope.register(modifiers, key, (e: KeyboardEvent) => {
					const engine = this.sheetEngine;
					if (!engine || !this.typingInGrid()) return true;
					if (needsWrite && (engine.isReadOnly || this.sheetReadOnly)) return true;
					run(e);
					return false;
				});
			}
		};

		const PLAIN: Modifier[][] = [[], ["Shift"]];
		const MOD: Modifier[][] = [["Mod"], ["Mod", "Shift"]];
		const shifted = (e: KeyboardEvent) => e.shiftKey;

		on([[]], "F2", () => {
			const cur = this.sheetEngine?.activeCell();
			if (cur) this.sheetEngine?.openEditorAt(cur.row, cur.col);
		}, true);
		on([["Mod"]], "d", () => this.sheetEngine?.fillDown(), true);
		on([["Mod"]], "f", () => this.sheetFind?.open());
		// The engine binds Ctrl+S to its own CSV DOWNLOAD. In a note-taking app
		// that is the one keystroke that could really surprise somebody.
		on([["Mod"]], "s", () => void this.flushSheet());

		on(PLAIN, "Home", (e) => this.sheetEngine?.moveToRowStart(shifted(e)));
		on(PLAIN, "End", (e) => this.sheetEngine?.moveToRowEnd(shifted(e)));
		on(MOD, "Home", (e) => this.sheetEngine?.moveToGridStart(shifted(e)));
		on(MOD, "End", (e) => this.sheetEngine?.moveToGridEnd(shifted(e)));

		const edges: Record<string, [number, number]> = {
			ArrowUp: [-1, 0],
			ArrowDown: [1, 0],
			ArrowLeft: [0, -1],
			ArrowRight: [0, 1],
		};
		for (const [key, delta] of Object.entries(edges)) {
			on(MOD, key, (e) => this.sheetEngine?.moveToDataEdge(delta[0], delta[1], shifted(e)));
		}

		// The engine's own Delete pops up a confirm() and deletes whole ROWS when
		// a row header is selected. Clearing the cells is what the key means.
		for (const key of ["Delete", "Backspace"]) {
			on([[]], key, () => this.sheetEngine?.clearSelection(), true);
		}
	}

	/**
	 * True when a keystroke belongs to the GRID rather than to something else in
	 * this view: the find box, the formula bar, or an open in-cell editor all own
	 * their own keys (Home inside a text field moves the caret, and must).
	 */
	private typingInGrid(): boolean {
		if (this.sheetEngine?.isEditing()) return false;
		const active = this.contentEl.doc?.activeElement ?? document.activeElement;
		if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return false;
		if (active instanceof HTMLElement && active.isContentEditable) return false;
		return true;
	}

	/* ------------------------------------------------------------ loading */

	setViewData(data: string, clear: boolean): void {
		if (clear) this.clear();
		this.beginLoad();

		const ext = (this.file?.extension ?? "").toLowerCase();
		this.sheetMode = JSON_EXTENSIONS.includes(ext) || ext === "" ? "sheet" : "csv";
		this.sheetDirty = false;
		this.sheetReadOnly = false;

		if (this.sheetMode === "csv") {
			// An empty CSV is a legitimate file, so "" counts as known-good here.
			this.sheetLastGood = data ?? "";
			const parsed = csvToDoc(data ?? "");
			this.sheetDelimiter = parsed.delimiter;
			this.renderSheet(parsed.doc);
			return;
		}

		this.sheetLastGood = data && data.trim().length > 0 ? data : null;

		let doc: SheetDoc;
		try {
			doc = data.trim().length > 0 ? parseSheet(data) : newSheetDoc();
		} catch (e) {
			// Unparseable file: show it read-only so getViewData() can never
			// overwrite the user's bytes with an empty grid.
			console.error("leovale-sheets: parse failed", e);
			new Notice(t("parseFailed", { message: (e as Error).message }));
			doc = newSheetDoc();
			this.sheetReadOnly = true;
		}

		if (!isSupportedVersion(doc)) {
			new Notice(t("futureVersion", { version: doc.version }));
			this.sheetReadOnly = true;
		}

		this.renderSheet(doc);
	}

	getViewData(): string {
		const fallback = () => this.sheetLastGood ?? this.data ?? "";
		if (!this.sheetEngine || !this.sheetDirty || this.sheetReadOnly) return fallback();

		if (this.sheetMode === "csv") return this.getCsvViewData(fallback);

		let out: string;
		try {
			out = serializeSheet(this.sheetEngine.readDoc());
		} catch (e) {
			console.error("leovale-sheets: serialize failed", e);
			return fallback();
		}
		if (!out || out.length < MIN_VALID) {
			console.error("leovale-sheets: refusing to write a suspiciously short document");
			return fallback();
		}
		this.sheetLastGood = out;
		this.sheetDirty = false;
		return out;
	}

	/**
	 * CSV write path. Same guards as the JSON one minus the length floor (a
	 * three-cell CSV is legitimately 12 bytes), plus one rule of its own: a file
	 * that had content is never replaced with an empty one. Clearing every cell
	 * of a CSV is not a supported operation, deleting the file is.
	 */
	private getCsvViewData(fallback: () => string): string {
		let out: string;
		try {
			out = docToCsv((this.sheetEngine as SheetEngine).readDoc(), this.sheetDelimiter);
		} catch (e) {
			console.error("leovale-sheets: csv serialize failed", e);
			return fallback();
		}
		if (out.trim().length === 0 && (this.sheetLastGood ?? "").trim().length > 0) {
			console.error("leovale-sheets: refusing to blank a non-empty csv file");
			return fallback();
		}
		this.sheetLastGood = out;
		this.sheetDirty = false;
		return out;
	}

	clear(): void {
		this.cancelScheduledSave();
		this.destroyEngine();
		this.sheetDirty = false;
		this.sheetLastGood = null;
	}

	/** Discard an editor that is open, so it cannot commit into the next file. */
	private discardPendingEdits(): void {
		this.sheetEngine?.discardOpenEditor();
	}

	/**
	 * Tear the grid down without touching the leaf. Called when the PLUGIN is
	 * unloaded (disabled, or replaced by an update).
	 *
	 * The leaf is deliberately left alone - closing the user's tabs in onunload
	 * would rearrange their workspace - but the engine must go, because the grid
	 * engine keeps key and mouse handlers on `document` and only drops them when
	 * its last instance is destroyed. Leaving them behind means the NEXT load of
	 * the plugin adds a second set, and then a third: every arrow key then moves
	 * the selection by as many cells as there have been reloads. Verified in the
	 * sandbox after ten reloads: one press jumped eleven columns.
	 *
	 * Pending edits are serialized first, so disabling the plugin cannot lose the
	 * last 1.5 seconds of typing: `getViewData()` refreshes the known-good bytes,
	 * which is what Obsidian will ask for afterwards.
	 */
	releaseEngine(): void {
		try {
			if (this.sheetDirty && !this.sheetReadOnly) {
				this.getViewData();
				this.requestSave();
			}
		} catch (e) {
			console.error("leovale-sheets: could not flush before releasing the grid", e);
		}
		this.cancelScheduledSave();
		this.destroyEngine();
	}

	/* ----------------------------------------------------------- rendering */

	private renderSheet(doc: SheetDoc): void {
		this.destroyEngine();
		// Containers are created lazily here, not only in onOpen(): with deferred
		// views setViewData() can land before the first onOpen() paint.
		this.contentEl.empty();
		this.contentEl.addClass("leovale-sheet-content");
		// Obsidian puts `.is-mobile` on <body>; mirroring it on our own root keeps
		// the touch-target rules testable in a desktop sandbox too.
		this.contentEl.toggleClass("is-mobile", Platform.isMobile);
		this.contentEl.toggleClass("is-csv", this.sheetMode === "csv");

		// Formula bar first: on a tablet the in-cell editor is as wide as the
		// cell, so it is the only usable way to read or edit a long formula.
		this.sheetFormulaBar = new SheetFormulaBar(this.contentEl, {
			getEngine: () => this.sheetEngine,
			badge: this.sheetMode === "csv" ? `CSV ${this.sheetDelimiter}` : undefined,
		});
		this.sheetToolbar = new SheetToolbar(this.contentEl, () => this.sheetEngine, {
			sort: (dir) => this.sortSelectedColumn(dir),
			toggleFind: () => this.sheetFind?.toggle(),
			columnWidth: () => this.openColumnWidthDialog(),
			merge: () => this.mergeSelection(),
		});
		this.sheetFind = new SheetFind(this.contentEl, () => this.sheetEngine);
		this.sheetWrapper = this.contentEl.createDiv({ cls: "leovale-sheet-wrapper" });
		if (this.sheetReadOnly) this.sheetWrapper.addClass("is-readonly");

		try {
			this.sheetEngine = new SheetEngine(this.sheetWrapper, doc, {
				onChange: () => this.scheduleSave(),
				onSelection: () => this.syncChrome(),
				readOnly: this.sheetReadOnly,
				links: this.linkHandlers(),
			});
		} catch (e) {
			console.error("leovale-sheets: engine init failed", e);
			this.sheetEngine = null;
			this.sheetReadOnly = true;
			this.sheetWrapper.createDiv({
				cls: "leovale-sheet-error",
				text: t("engineFailed", { message: (e as Error).message }),
			});
		}

		// Keep the toolbar and the formula bar in sync with the grid selection.
		this.registerDomEvent(this.sheetWrapper, "mouseup", () => this.syncChrome());
		this.registerDomEvent(this.sheetWrapper, "keyup", () => this.syncChrome());
		// Obsidian mobile treats a horizontal pan as "open the left drawer" and
		// listens for it on an ancestor. Inside the grid the pan belongs to the
		// grid, so the gesture stops here. Never preventDefault(): the scroll
		// itself is exactly what we want to keep.
		//
		// `touchstart` deliberately still bubbles: the engine selects the tapped
		// cell from a listener on `document`. Its long-press timer normally dies
		// on the engine's own `touchmove`, which we are now swallowing, so cancel
		// it explicitly.
		this.registerDomEvent(this.sheetWrapper, "touchmove", (e: TouchEvent) => {
			this.sheetEngine?.cancelTouchHold();
			e.stopPropagation();
		});

		// Double-click on the right edge of a column header: autofit.
		this.registerDomEvent(this.sheetWrapper, "dblclick", (e: MouseEvent) =>
			this.onGridDoubleClick(e),
		);
		this.syncChrome();
	}


	/** Double-click on a column header's right edge fits it to its content. */
	private onGridDoubleClick(e: MouseEvent): void {
		const engine = this.sheetEngine;
		if (!engine || engine.isReadOnly) return;
		const cell = (e.target as HTMLElement | null)?.closest("thead td[data-x]");
		if (!(cell instanceof HTMLElement)) return;
		const rect = cell.getBoundingClientRect();
		// The vendor's own resize handle is the last few pixels of the header.
		if (rect.right - e.clientX > 8) return;
		const col = Number(cell.getAttribute("data-x"));
		if (!Number.isInteger(col)) return;
		e.preventDefault();
		e.stopPropagation();
		engine.autofitColumn(col);
	}

	/**
	 * What a `[[wiki link]]` inside a cell does.
	 *
	 * Both are Obsidian's own machinery rather than an imitation of it:
	 * `openLinkText` resolves the link the way every other link in the vault is
	 * resolved (including "create the note if it is not there yet"), and the
	 * `hover-link` event is what the core Page Preview plugin listens for, so the
	 * popover is the real one, with the user's own delay and modifier settings.
	 *
	 * `sourcePath` is the spreadsheet itself, which is what makes a relative link
	 * resolve from the sheet's folder.
	 */
	private linkHandlers(): { open: (target: string, newTab: boolean) => void;
		hover: (el: HTMLElement, target: string, event: MouseEvent) => void } {
		const source = () => this.file?.path ?? "";
		return {
			open: (target, newTab) => {
				void this.app.workspace.openLinkText(target, source(), newTab);
			},
			hover: (el, target, event) => {
				this.app.workspace.trigger("hover-link", {
					event,
					source: "leovale-sheets",
					hoverParent: this,
					targetEl: el,
					linktext: target,
					sourcePath: source(),
				});
			},
		};
	}

	/**
	 * Merge the selection, or split it if it is already merged.
	 *
	 * The confirm is not decoration: merging keeps the top-left value and drops
	 * every other one, and "the cells you cannot see any more were emptied" is a
	 * thing a user is entitled to hear BEFORE it happens. Nothing is asked when
	 * there is nothing to lose.
	 *
	 * Sorting refuses to run on a sheet with merges (a merge spans addresses, and
	 * permuting the rows underneath one would tear it apart), so this is also the
	 * button that turns sorting off - which is why the notice says so.
	 */
	mergeSelection(): void {
		const engine = this.sheetEngine;
		if (!engine) return;
		if (this.sheetReadOnly) {
			new Notice(t("sheetReadOnly"));
			return;
		}
		const rect = engine.selectionRect();
		if (!rect) {
			new Notice(t("mergeNeedsRange"));
			return;
		}

		// Anything merged inside the selection means the button splits instead.
		let merged = false;
		for (let r = rect.r1; r <= rect.r2 && !merged; r++) {
			for (let c = rect.c1; c <= rect.c2 && !merged; c++) {
				if (engine.mergeAt(r, c)) merged = true;
			}
		}
		if (merged) {
			if (engine.unmergeSelection()) new Notice(t("unmergeDone"));
			this.syncChrome();
			return;
		}

		if (rect.r1 === rect.r2 && rect.c1 === rect.c2) {
			new Notice(t("mergeNeedsRange"));
			return;
		}

		const losses = engine.mergeLosses();
		const run = () => {
			if (engine.mergeSelection()) new Notice(t("mergeDone"));
			this.syncChrome();
		};
		if (losses.length === 0) {
			run();
			return;
		}
		new ConfirmModal(this.app, {
			title: t("mergeConfirmTitle"),
			body: t("mergeConfirmBody", { count: losses.length }),
			confirmText: t("mergeConfirmOk"),
			onConfirm: run,
		}).open();
	}

	/**
	 * Write the sheet next to itself as `name.xlsx`.
	 *
	 * The document comes from the live grid rather than from disk, so an export
	 * fired 200 ms after a keystroke carries that keystroke.
	 */
	async exportXlsx(): Promise<void> {
		const engine = this.sheetEngine;
		const file = this.file;
		if (!engine || !file) return;
		await exportDocAsXlsx(this.app, file, engine.readDoc());
	}

	/** Refresh both chrome strips from the current grid selection. */
	private syncChrome(): void {
		this.sheetToolbar?.sync();
		this.sheetFormulaBar?.sync();
	}

	/* ------------------------------------------------ document operations */

	/**
	 * Sort the sheet by the selected column.
	 *
	 * This is a DOCUMENT operation, not an engine one, and deliberately so. The
	 * engine's `orderBy()` permutes the values and leaves `options.style` (keyed
	 * by A1 address) and the `data-nf` mask attributes where they were, so the
	 * bold red row would lend its formatting to whoever landed on its address -
	 * and that is what would be saved. Here the document is read out, sorted with
	 * whole rows (see `sortPage`), and the grid is rebuilt from it. Slower, and
	 * correct.
	 *
	 * `dir: null` only drops the sort MARKER: the row order lives in the file
	 * now, so there is no previous order to go back to.
	 */
	sortSelectedColumn(dir: SortDir | null): void {
		const engine = this.sheetEngine;
		if (!engine) return;
		if (this.sheetReadOnly) {
			new Notice(t("sheetReadOnly"));
			return;
		}
		const cursor = engine.activeCell();
		if (!cursor) {
			new Notice(t("sortNeedsCell"));
			return;
		}

		const doc = engine.readDoc();
		const page = doc.sheets[0];
		if (!page) return;

		if (dir === null) {
			const view = { ...page.view };
			delete view.sort;
			page.view = view;
			this.remountDoc(doc, cursor);
			return;
		}

		// A merge spans addresses; permuting the rows underneath one would tear it
		// apart. Refused rather than silently mangled.
		if (Object.keys(page.merges).length > 0) {
			new Notice(t("sortMerged"), 8000);
			return;
		}

		const result = sortPage(page, cursor.col, dir, engine.headerRows(), engine.reader());
		doc.sheets[0] = result.page;
		this.remountDoc(doc, cursor);
		if (result.movedFormula) new Notice(t("sortFormulasMoved"), 8000);
	}

	/** Rebuild the grid from a document we just rewrote, and schedule a save. */
	private remountDoc(doc: SheetDoc, cursor?: { row: number; col: number }): void {
		this.renderSheet(doc);
		this.scheduleSave();
		if (cursor) this.sheetEngine?.selectCell(cursor.row, cursor.col);
		this.syncChrome();
	}

	/** Toolbar button and command: exact width for the selected columns. */
	openColumnWidthDialog(): void {
		const engine = this.sheetEngine;
		const toolbar = this.sheetToolbar;
		if (!engine || !toolbar) return;
		if (this.sheetReadOnly) {
			new Notice(t("sheetReadOnly"));
			return;
		}
		const columns = toolbar.selectedColumns();
		if (columns.length === 0) return;
		new ColumnWidthModal(this.app, {
			columns,
			current: engine.columnWidth(columns[0] as number),
			onApply: (width) => engine.setColumnWidth(columns, width),
			onAutofit: () => {
				for (const col of columns) engine.autofitColumn(col);
			},
		}).open();
	}

	toggleFind(): void {
		this.sheetFind?.toggle();
	}

	/* --------------------------------------------------- markdown interop */

	/**
	 * Copy the selection as a Markdown table.
	 *
	 * The DISPLAYED text is what travels, not the raw content: a Markdown table
	 * holding `=SUM(B2:B3)` where the sheet shows `$7.00` would be a table of
	 * something nobody asked for. The alignment row is built from the first
	 * row's own `ha` styles.
	 */
	async copySelectionAsMarkdown(): Promise<void> {
		const engine = this.sheetEngine;
		if (!engine) return;
		const rect = engine.selectionRect();
		if (!rect) {
			new Notice(t("mdNoSelection"));
			return;
		}
		const rows: string[][] = [];
		for (let r = rect.r1; r <= rect.r2; r++) {
			const row: string[] = [];
			for (let c = rect.c1; c <= rect.c2; c++) row.push(engine.displayText(cellRef(r, c)));
			rows.push(row);
		}
		const aligns: MdAlign[] = [];
		for (let c = rect.c1; c <= rect.c2; c++) {
			aligns.push(engine.getStyleAt(cellRef(rect.r1, c)).ha);
		}
		const text = toMarkdownTable(rows, aligns);
		try {
			await navigator.clipboard.writeText(text);
		} catch (e) {
			new Notice(t("clipboardFailed", { message: (e as Error).message }));
			return;
		}
		new Notice(t("mdCopied", { rows: rows.length, cols: rect.c2 - rect.c1 + 1 }));
	}

	/**
	 * Paste a Markdown table from the clipboard into the grid, anchored at the
	 * selection. Values land as text (a cell starting with `=` becomes a formula,
	 * exactly as if it had been typed) and the alignment row, if the table has
	 * one, is applied to the pasted columns.
	 */
	async pasteMarkdownTable(): Promise<void> {
		const engine = this.sheetEngine;
		if (!engine) return;
		if (this.sheetReadOnly) {
			new Notice(t("sheetReadOnly"));
			return;
		}
		let text = "";
		try {
			text = await navigator.clipboard.readText();
		} catch (e) {
			new Notice(t("clipboardFailed", { message: (e as Error).message }));
			return;
		}
		const rows = parseMarkdownTable(text);
		if (rows.length === 0) {
			new Notice(t("mdNoTable"));
			return;
		}
		const anchor = engine.activeCell() ?? { row: 0, col: 0 };
		const written = engine.writeRange(anchor.row, anchor.col, rows);
		const aligns = markdownAligns(text);
		if (aligns.length > 0) engine.applyColumnAligns(anchor, written, aligns);
		new Notice(t("mdPasted", { rows: written.rows, cols: written.cols }));
	}

	private destroyEngine(): void {
		// Order matters: the formula bar is disarmed and the in-cell editor is
		// dropped BEFORE anything is detached, so no straggling blur or editor
		// close can write into the document that is being mounted next.
		this.discardPendingEdits();
		if (this.sheetFormulaBar) {
			try {
				this.sheetFormulaBar.destroy();
			} catch (e) {
				console.error("leovale-sheets: formula bar teardown failed", e);
			}
			this.sheetFormulaBar = null;
		}
		if (this.sheetFind) {
			try {
				this.sheetFind.destroy();
			} catch (e) {
				console.error("leovale-sheets: find strip teardown failed", e);
			}
			this.sheetFind = null;
		}
		if (this.sheetToolbar) {
			try {
				this.sheetToolbar.destroy();
			} catch (e) {
				console.error("leovale-sheets: toolbar teardown failed", e);
			}
			this.sheetToolbar = null;
		}
		if (this.sheetEngine) {
			try {
				this.sheetEngine.destroy();
			} catch (e) {
				console.error("leovale-sheets: engine teardown failed", e);
			}
			this.sheetEngine = null;
		}
		this.sheetWrapper = null;
	}

	/* ------------------------------------------------------------ autosave */

	/**
	 * Open the quiet window in which the document cannot become dirty. Any
	 * pending save is cancelled too: it can only belong to the document that is
	 * being replaced, whose bytes were already flushed by onUnloadFile.
	 */
	private beginLoad(): void {
		this.sheetLoading = true;
		this.cancelScheduledSave();
		if (this.sheetLoadTimer !== null) window.clearTimeout(this.sheetLoadTimer);
		this.sheetLoadTimer = window.setTimeout(() => {
			this.sheetLoadTimer = null;
			this.sheetLoading = false;
		}, LOAD_QUIET_MS);
	}

	private scheduleSave(): void {
		if (this.sheetReadOnly) return;
		if (this.sheetLoading) {
			// Not ours: an event from the document we just replaced.
			console.debug("leovale-sheets: ignoring a change during load");
			return;
		}
		this.sheetDirty = true;
		this.cancelScheduledSave();
		this.sheetSaveTimer = window.setTimeout(() => {
			this.sheetSaveTimer = null;
			this.requestSave();
		}, SAVE_DEBOUNCE_MS);
	}

	private cancelScheduledSave(): void {
		if (this.sheetSaveTimer !== null) {
			window.clearTimeout(this.sheetSaveTimer);
			this.sheetSaveTimer = null;
		}
	}

	/** Write now, skipping both debounces. Used by the command and by onClose. */
	async flushSheet(): Promise<void> {
		this.cancelScheduledSave();
		if (this.sheetDirty) await this.save(false);
	}

	async onUnloadFile(file: TFile): Promise<void> {
		await this.flushSheet();
		await super.onUnloadFile(file);
	}

	async onClose(): Promise<void> {
		await this.flushSheet();
		this.destroyEngine();
		this.contentEl.empty();
	}
}
