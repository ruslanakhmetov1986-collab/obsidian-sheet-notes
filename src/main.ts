import {
	type App,
	Notice,
	Plugin,
	type TFile,
	TFolder,
	normalizePath,
} from "obsidian";
import { SheetView, VIEW_TYPE_SHEET } from "./view";
import { newSheetDoc, serializeSheet } from "./format";
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

		this.addRibbonIcon("table", "New spreadsheet", () =>
			void createSheet(this.app, undefined, this.newSheetExt()),
		);

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				// Fires for files too; the reference plugin crashed here.
				if (!(file instanceof TFolder)) return;
				menu.addItem((item) =>
					item
						.setTitle("New spreadsheet")
						.setIcon("table")
						.onClick(() => void createSheet(this.app, file, this.newSheetExt())),
				);
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
