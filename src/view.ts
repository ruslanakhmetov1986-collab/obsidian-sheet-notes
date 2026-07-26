import { Notice, TextFileView, type TFile, type WorkspaceLeaf } from "obsidian";
import { SheetEngine } from "./engine";
import { SheetToolbar } from "./toolbar";
import {
	MIN_VALID,
	type SheetDoc,
	isSupportedVersion,
	newSheetDoc,
	parseSheet,
	serializeSheet,
} from "./format";

export const VIEW_TYPE_SHEET = "leovale-sheet-view";

/** Quiet time before we ask Obsidian to save (Obsidian then debounces ~2 s more). */
const SAVE_DEBOUNCE_MS = 1500;

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
	private sheetWrapper: HTMLElement | null = null;
	/** Last serialization we trust; the anti-truncation floor for getViewData(). */
	private sheetLastGood: string | null = null;
	private sheetDirty = false;
	private sheetSaveTimer: number | null = null;
	private sheetReadOnly = false;

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

		this.sheetLastGood = data && data.trim().length > 0 ? data : null;
		this.sheetDirty = false;
		this.sheetReadOnly = false;

		let doc: SheetDoc;
		try {
			doc = data.trim().length > 0 ? parseSheet(data) : newSheetDoc();
		} catch (e) {
			// Unparseable file: show it read-only so getViewData() can never
			// overwrite the user's bytes with an empty grid.
			console.error("leovale-sheets: parse failed", e);
			new Notice(`Sheets: не удалось разобрать файл (${(e as Error).message}). Только чтение.`);
			doc = newSheetDoc();
			this.sheetReadOnly = true;
		}

		if (!isSupportedVersion(doc)) {
			new Notice(
				`Sheets: файл версии ${doc.version} новее, чем понимает плагин. Открыт только для чтения.`,
			);
			this.sheetReadOnly = true;
		}

		this.renderSheet(doc);
	}

	getViewData(): string {
		const fallback = () => this.sheetLastGood ?? this.data ?? "";
		if (!this.sheetEngine || !this.sheetDirty || this.sheetReadOnly) return fallback();

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

	clear(): void {
		this.cancelScheduledSave();
		this.destroyEngine();
		this.sheetDirty = false;
		this.sheetLastGood = null;
	}

	/* ----------------------------------------------------------- rendering */

	private renderSheet(doc: SheetDoc): void {
		this.destroyEngine();
		// Containers are created lazily here, not only in onOpen(): with deferred
		// views setViewData() can land before the first onOpen() paint.
		this.contentEl.empty();
		this.contentEl.addClass("leovale-sheet-content");
		this.sheetToolbar = new SheetToolbar(this.contentEl, () => this.sheetEngine);
		this.sheetWrapper = this.contentEl.createDiv({ cls: "leovale-sheet-wrapper" });
		if (this.sheetReadOnly) this.sheetWrapper.addClass("is-readonly");

		try {
			this.sheetEngine = new SheetEngine(this.sheetWrapper, doc, {
				onChange: () => this.scheduleSave(),
				readOnly: this.sheetReadOnly,
			});
		} catch (e) {
			console.error("leovale-sheets: engine init failed", e);
			this.sheetEngine = null;
			this.sheetReadOnly = true;
			this.sheetWrapper.createDiv({
				cls: "leovale-sheet-error",
				text: `Не удалось построить таблицу: ${(e as Error).message}`,
			});
		}

		// Keep the toolbar in sync with whatever the user selects in the grid.
		this.registerDomEvent(this.sheetWrapper, "mouseup", () => this.sheetToolbar?.sync());
		this.registerDomEvent(this.sheetWrapper, "keyup", () => this.sheetToolbar?.sync());
		this.sheetToolbar.sync();
	}

	private destroyEngine(): void {
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

	private scheduleSave(): void {
		if (this.sheetReadOnly) return;
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
