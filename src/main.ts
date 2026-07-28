import {
	type App,
	Notice,
	Plugin,
	TFile,
	TFolder,
	normalizePath,
} from "obsidian";
import { SheetView, VIEW_TYPE_SHEET } from "./view";
import { releaseEngineGlobals } from "./engine";
import { VersionHistoryModal } from "./versionmodal";
import { backupStore, releaseBackupStore } from "./versions";
import { registerSheetEmbeds } from "./embed";
import { newSheetDoc, parseSheet, serializeSheet } from "./format";
import {
	XLSX_EXT,
	exportDocAsXlsx,
	importXlsxBytes,
	importXlsxFile,
	pickXlsx,
} from "./xlsxio";
import { t } from "./i18n";

/** Preferred extension. Also used by Sheet Plus, Excel and Spreadsheets. */
export const SHEET_EXT = "sheet";
/** Always-ours fallback, so a `.sheet` collision cannot disable the plugin. */
export const FALLBACK_EXT = "lsheet";
/** Opened in the same grid; other plugins may own it, hence the same guard. */
export const CSV_EXT = "csv";

/**
 * Guess a human name for whoever owns an extension.
 *
 * `viewRegistry.getTypeByExtension()` returns a VIEW TYPE, not a plugin id, and
 * Obsidian keeps no reverse map. Every plugin that grabs `.sheet` names its view
 * after itself though (`sheet-plus-view`, `excel-view`, `spreadsheet-view`), so
 * matching the view type against installed manifests names the culprit in
 * practice; the view type is reported either way.
 */
export function describeExtensionOwner(app: App, ext: string): string {
	const registry = (app as unknown as {
		viewRegistry?: { getTypeByExtension?: (e: string) => string | undefined };
	}).viewRegistry;
	const type = registry?.getTypeByExtension?.(ext);
	if (!type) return t("ownerUnknown");

	const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
	const target = norm(type);
	const plugins = (app as unknown as {
		plugins?: { plugins?: Record<string, { manifest?: { id?: string; name?: string } }> };
	}).plugins?.plugins;

	for (const [id, plugin] of Object.entries(plugins ?? {})) {
		const name = plugin?.manifest?.name ?? id;
		const nId = norm(plugin?.manifest?.id ?? id);
		const nName = norm(name);
		if (
			(nId.length > 2 && (target.includes(nId) || nId.includes(target))) ||
			(nName.length > 2 && target.includes(nName))
		) {
			return t("ownerNamed", { name, type });
		}
	}
	return t("ownerViewOnly", { type });
}

export default class LeovaleSheetsPlugin extends Plugin {
	/** False when another plugin already owns `.sheet`; then we create `.lsheet`. */
	sheetExtOwned = false;

	async onload(): Promise<void> {
		this.registerView(VIEW_TYPE_SHEET, (leaf) => new SheetView(leaf));

		// `.sheet` is the nice name but it is contested. Losing it must not cost
		// anything except the name, so the fallback extension is registered
		// unconditionally and both map to the same view.
		this.sheetExtOwned = this.claimExtension(SHEET_EXT);
		if (!this.sheetExtOwned) {
			new Notice(
				t("extTaken", {
					ext: SHEET_EXT,
					fallback: FALLBACK_EXT,
					owner: describeExtensionOwner(this.app, SHEET_EXT),
				}),
				10_000,
			);
		}
		this.claimExtension(FALLBACK_EXT);
		this.claimExtension(CSV_EXT);

		// `![[file.sheet]]` in a note, plus the ```sheet code block. Read-only,
		// mounted by a post-processor over Obsidian's generic file card.
		registerSheetEmbeds(this);

		this.addCommand({
			id: "create-sheet",
			name: "Create new spreadsheet",
			callback: () => void createSheet(this.app, undefined, this.newSheetExt()),
		});

		this.addCommand({
			id: "save-sheet",
			name: "Save spreadsheet now",
			checkCallback: (checking: boolean) => {
				const view = this.app.workspace.getActiveViewOfType(SheetView);
				if (!view) return false;
				if (!checking) void view.flushSheet();
				return true;
			},
		});

		// Markdown interop. Both are plain commands rather than editor commands:
		// they act on the spreadsheet view, and Obsidian's editor commands are
		// only offered while a Markdown editor has the focus.
		this.addCommand({
			id: "copy-markdown-table",
			name: "Copy selection as Markdown table",
			checkCallback: (checking: boolean) => {
				const view = this.app.workspace.getActiveViewOfType(SheetView);
				if (!view) return false;
				if (!checking) void view.copySelectionAsMarkdown();
				return true;
			},
		});

		this.addCommand({
			id: "paste-markdown-table",
			name: "Paste Markdown table",
			checkCallback: (checking: boolean) => {
				const view = this.app.workspace.getActiveViewOfType(SheetView);
				if (!view) return false;
				if (!checking) void view.pasteMarkdownTable();
				return true;
			},
		});

		// --- 1.7.0: document-level history ------------------------------------
		// Plain commands rather than editor commands, for the same reason the
		// Markdown ones above are: they act on the spreadsheet view. Registering
		// them is also what makes the shortcuts re-bindable in Settings ->
		// Hotkeys; the view's own Scope handles the default Ctrl+Z/Ctrl+Y.
		this.addCommand({
			id: "undo-sheet",
			name: "Undo spreadsheet change",
			checkCallback: (checking: boolean) => {
				const view = this.app.workspace.getActiveViewOfType(SheetView);
				if (!view) return false;
				if (!checking) view.undoStep();
				return true;
			},
		});

		this.addCommand({
			id: "redo-sheet",
			name: "Redo spreadsheet change",
			checkCallback: (checking: boolean) => {
				const view = this.app.workspace.getActiveViewOfType(SheetView);
				if (!view) return false;
				if (!checking) view.redoStep();
				return true;
			},
		});

		this.addCommand({
			id: "version-history",
			name: "Version history",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveViewOfType(SheetView)?.file;
				if (!file) return false;
				if (!checking) void openVersionHistory(this.app, file);
				return true;
			},
		});

		this.addCommand({
			id: "find-in-sheet",
			name: "Find in spreadsheet",
			checkCallback: (checking: boolean) => {
				const view = this.app.workspace.getActiveViewOfType(SheetView);
				if (!view) return false;
				if (!checking) view.toggleFind();
				return true;
			},
		});

		this.addCommand({
			id: "column-width",
			name: "Set column width",
			checkCallback: (checking: boolean) => {
				const view = this.app.workspace.getActiveViewOfType(SheetView);
				if (!view) return false;
				if (!checking) view.openColumnWidthDialog();
				return true;
			},
		});

		this.addCommand({
			id: "merge-cells",
			name: "Merge or split cells",
			checkCallback: (checking: boolean) => {
				const view = this.app.workspace.getActiveViewOfType(SheetView);
				if (!view) return false;
				if (!checking) view.mergeSelection();
				return true;
			},
		});

		// --- exchange and print (1.4.0) ---------------------------------------

		this.addCommand({
			id: "export-xlsx",
			name: "Export as .xlsx",
			checkCallback: (checking: boolean) => {
				const view = this.app.workspace.getActiveViewOfType(SheetView);
				if (!view?.file) return false;
				if (!checking) void view.exportXlsx();
				return true;
			},
		});

		this.addCommand({
			id: "import-xlsx",
			name: "Import .xlsx as sheet",
			callback: () =>
				pickXlsx((data, name) =>
					void importXlsxBytes(this.app, data, name, this.newSheetExt()),
				),
		});

		// Print goes through the browser's own dialog, which is Electron's system
		// print dialog on the desktop. Everything that makes the result readable -
		// no toolbar, no formula bar, the whole grid instead of the visible part,
		// the header row repeated on every page - is the `@media print` block in
		// the theme layer.
		this.addCommand({
			id: "print-sheet",
			name: "Print spreadsheet",
			checkCallback: (checking: boolean) => {
				const view = this.app.workspace.getActiveViewOfType(SheetView);
				if (!view) return false;
				if (!checking) window.print();
				return true;
			},
		});

		this.addRibbonIcon("table", "New spreadsheet", () =>
			void createSheet(this.app, undefined, this.newSheetExt()),
		);

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				// Fires for files too; the reference plugin crashed here.
				if (file instanceof TFolder) {
					menu.addItem((item) =>
						item
							.setTitle("New spreadsheet")
							.setIcon("table")
							.onClick(() => void createSheet(this.app, file, this.newSheetExt())),
					);
					return;
				}
				if (!(file instanceof TFile)) return;
				const ext = file.extension.toLowerCase();
				// The two ways a spreadsheet and a workbook meet, offered exactly
				// where a user looks for them: on the file itself.
				if (ext === SHEET_EXT || ext === FALLBACK_EXT) {
					menu.addItem((item) =>
						item
							.setTitle("Export as .xlsx")
							.setIcon("file-spreadsheet")
							.onClick(() => void exportSheetFile(this.app, file)),
					);
					// The version log is kept for our own format only, so this is
					// exactly where it belongs: on a file that has one.
					menu.addItem((item) =>
						item
							.setTitle(t("vhTitle"))
							.setIcon("history")
							.onClick(() => void openVersionHistory(this.app, file)),
					);
				} else if (ext === XLSX_EXT) {
					menu.addItem((item) =>
						item
							.setTitle("Import as spreadsheet")
							.setIcon("table")
							.onClick(() => void importXlsxFile(this.app, file, this.newSheetExt())),
					);
				}
			}),
		);
	}

	/** Extension for files WE create: the pretty one when it is ours. */
	newSheetExt(): string {
		return this.sheetExtOwned ? SHEET_EXT : FALLBACK_EXT;
	}

	/**
	 * `registerExtensions` THROWS when the extension is taken. Returns whether we
	 * got it; the caller decides how loudly to complain.
	 */
	private claimExtension(ext: string): boolean {
		try {
			this.registerExtensions([ext], VIEW_TYPE_SHEET);
			return true;
		} catch (e) {
			console.warn(`leovale-sheets: .${ext} is already registered`, e);
			return false;
		}
	}

	onunload(): void {
		// Deliberately no detach() of open leaves: that would destroy the
		// user's layout. Open .sheet tabs show "no view of type" until re-enable.
		//
		// The GRIDS inside them do have to go, though: the engine keeps handlers on
		// `document` and releases them only when its last instance is destroyed, so
		// a plugin reload with a sheet tab open would leave a second live set of
		// them behind. See SheetView.releaseEngine().
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SHEET)) {
			const view = leaf.view;
			if (view instanceof SheetView) {
				try {
					view.releaseEngine();
				} catch (e) {
					console.error("leovale-sheets: releasing a grid on unload failed", e);
				}
			}
		}
		// The version store caches a byte total for the whole tree; a reload of the
		// plugin must not carry it into a vault that may have been swapped.
		releaseBackupStore();
		// And the handlers this copy of the engine put on `document`, which no
		// individual grid teardown is allowed to remove any more. Deliberately not
		// awaited (onunload is synchronous): the module's closures outlive the
		// plugin object, so the removal still lands on the right functions.
		void releaseEngineGlobals();
	}
}

/**
 * Open the version history of a spreadsheet.
 *
 * The file is OPENED FIRST if it is not on screen already, and that is not
 * convenience: restoring a version goes through the view's normal save path
 * (which is what makes a restore undoable and snapshotted like any other
 * change), so there has to be a view. It also means the user sees what they are
 * about to replace, next to the version they are replacing it with.
 */
export async function openVersionHistory(app: App, file: TFile): Promise<void> {
	let view = findSheetView(app, file);
	if (!view) {
		await app.workspace.getLeaf(false).openFile(file);
		// The view mounts synchronously enough in practice, but not always: a
		// deferred leaf can still be building when openFile resolves.
		for (let i = 0; i < 20 && !view; i++) {
			await new Promise((r) => setTimeout(r, 50));
			view = findSheetView(app, file);
		}
	}
	if (!view) {
		new Notice(t("vhNoView"), 8000);
		return;
	}
	const target = view;
	new VersionHistoryModal(app, {
		path: file.path,
		store: backupStore(app),
		restore: (text) => target.restoreVersion(text),
	}).open();
}

/** The open spreadsheet view showing this file, if there is one. */
function findSheetView(app: App, file: TFile): SheetView | null {
	for (const leaf of app.workspace.getLeavesOfType(VIEW_TYPE_SHEET)) {
		const view = leaf.view;
		if (view instanceof SheetView && view.file?.path === file.path) return view;
	}
	return null;
}

/**
 * Export a `.sheet` from the file explorer, whether or not it is open.
 *
 * An open tab is asked first, and that is not an optimisation: its grid may hold
 * edits from the last second and a half that the file on disk does not have yet,
 * and exporting the older bytes would be a quietly wrong answer.
 */
export async function exportSheetFile(app: App, file: TFile): Promise<void> {
	for (const leaf of app.workspace.getLeavesOfType(VIEW_TYPE_SHEET)) {
		const view = leaf.view;
		if (view instanceof SheetView && view.file?.path === file.path) {
			await view.exportXlsx();
			return;
		}
	}
	try {
		const text = await app.vault.read(file);
		const doc = text.trim().length > 0 ? parseSheet(text) : newSheetDoc();
		await exportDocAsXlsx(app, file, doc);
	} catch (e) {
		console.error("leovale-sheets: reading the sheet to export failed", e);
		new Notice(t("xlsxExportFailed", { message: (e as Error).message }), 8000);
	}
}

export async function createSheet(
	app: App,
	folder?: TFolder,
	ext: string = SHEET_EXT,
): Promise<TFile> {
	// Note: no `newFilePath` argument. Passing one makes Obsidian look up a
	// "file creator" for the extension and log a bogus error for .sheet.
	const parent = folder ?? app.fileManager.getNewFileParent(app.workspace.getActiveFile()?.path ?? "");
	const dir = !parent || parent.path === "/" ? "" : `${parent.path}/`;

	let path = normalizePath(`${dir}Untitled.${ext}`);
	for (let i = 1; app.vault.getAbstractFileByPath(path); i++) {
		path = normalizePath(`${dir}Untitled ${i}.${ext}`);
	}

	const file = await app.vault.create(path, serializeSheet(newSheetDoc()));
	await app.workspace.getLeaf(true).openFile(file);
	return file;
}
