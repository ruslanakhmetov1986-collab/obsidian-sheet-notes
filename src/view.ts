import { Notice, Platform, TextFileView, type TFile, type WorkspaceLeaf } from "obsidian";
import { SheetEngine } from "./engine";
import { SheetToolbar } from "./toolbar";
import { SheetFormulaBar } from "./formulabar";
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
	isSupportedVersion,
	newSheetDoc,
	parseSheet,
	serializeSheet,
} from "./format";

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
	private sheetEngine: SheetEngine | null = null;
	private sheetToolbar: SheetToolbar | null = null;
	private sheetFormulaBar: SheetFormulaBar | null = null;
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
		this.sheetToolbar = new SheetToolbar(this.contentEl, () => this.sheetEngine);
		this.sheetWrapper = this.contentEl.createDiv({ cls: "leovale-sheet-wrapper" });
		if (this.sheetReadOnly) this.sheetWrapper.addClass("is-readonly");

		try {
			this.sheetEngine = new SheetEngine(this.sheetWrapper, doc, {
				onChange: () => this.scheduleSave(),
				onSelection: () => this.syncChrome(),
				readOnly: this.sheetReadOnly,
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
		this.syncChrome();
	}

	/** Refresh both chrome strips from the current grid selection. */
	private syncChrome(): void {
		this.sheetToolbar?.sync();
		this.sheetFormulaBar?.sync();
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
