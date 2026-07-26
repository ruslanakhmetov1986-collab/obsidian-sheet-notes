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

const SHEET_EXT = "sheet";

export default class LeovaleSheetsPlugin extends Plugin {
	async onload(): Promise<void> {
		this.registerView(VIEW_TYPE_SHEET, (leaf) => new SheetView(leaf));

		try {
			this.registerExtensions([SHEET_EXT], VIEW_TYPE_SHEET);
		} catch (e) {
			const registry = (this.app as unknown as {
				viewRegistry?: { getTypeByExtension?: (ext: string) => string };
			}).viewRegistry;
			const owner = registry?.getTypeByExtension?.(SHEET_EXT) ?? "another plugin";
			console.error("leovale-sheets: registerExtensions failed", e);
			new Notice(`Sheets: расширение .${SHEET_EXT} уже занято (${owner}).`);
		}

		this.addCommand({
			id: "create-sheet",
			name: "Create new spreadsheet",
			callback: () => void createSheet(this.app),
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

		this.addRibbonIcon("table", "New spreadsheet", () => void createSheet(this.app));

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				// Fires for files too; the reference plugin crashed here.
				if (!(file instanceof TFolder)) return;
				menu.addItem((item) =>
					item
						.setTitle("New spreadsheet")
						.setIcon("table")
						.onClick(() => void createSheet(this.app, file)),
				);
			}),
		);
	}

	onunload(): void {
		// Deliberately no detach() of open leaves: that would destroy the
		// user's layout. Open .sheet tabs show "no view of type" until re-enable.
	}
}

export async function createSheet(app: App, folder?: TFolder): Promise<TFile> {
	// Note: no `newFilePath` argument. Passing one makes Obsidian look up a
	// "file creator" for the extension and log a bogus error for .sheet.
	const parent = folder ?? app.fileManager.getNewFileParent(app.workspace.getActiveFile()?.path ?? "");
	const dir = !parent || parent.path === "/" ? "" : `${parent.path}/`;

	let path = normalizePath(`${dir}Untitled.${SHEET_EXT}`);
	for (let i = 1; app.vault.getAbstractFileByPath(path); i++) {
		path = normalizePath(`${dir}Untitled ${i}.${SHEET_EXT}`);
	}

	const file = await app.vault.create(path, serializeSheet(newSheetDoc()));
	await app.workspace.getLeaf(true).openFile(file);
	return file;
}
