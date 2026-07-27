/**
 * The vault side of the xlsx bridge: pick a file, read bytes, write bytes, say
 * what happened. Everything that needs Obsidian lives here, so `xlsx.ts` stays a
 * pure mapping module that the unit tests can drive without an app.
 */

import { type App, Notice, TFile, type TFolder, normalizePath } from "obsidian";
import { type SheetDoc, newSheetDoc, serializeSheet } from "./format";
import { loadXlsx, readXlsx, writeXlsx } from "./xlsx";
import { isTouchUi } from "./platform";
import { t } from "./i18n";

export const XLSX_EXT = "xlsx";

/* --------------------------------------------------------- the save dialog */

/** What Electron's `showSaveDialog` answers, narrowed to what we read. */
interface SaveDialogResult {
	canceled: boolean;
	filePath?: string;
}

interface ElectronDialog {
	showSaveDialog: (options: Record<string, unknown>) => Promise<SaveDialogResult>;
}

/**
 * Electron's own save dialog, or `null` where there is no Electron.
 *
 * Resolved at CALL time rather than at import time, for two reasons. On mobile
 * `require` does not exist at all and a module-level lookup would throw while
 * the plugin is loading, taking the whole plugin with it. And on the desktop
 * this is the seam the e2e uses: the suite replaces
 * `require("@electron/remote").dialog.showSaveDialog` with a stub that answers a
 * temp path, which works precisely because nothing is cached here. A native
 * dialog cannot be driven by a test, and a test that opened one would hang the
 * suite until somebody walked over to the machine.
 *
 * `@electron/remote` first, `electron.remote` after it: Obsidian has shipped
 * both over the years and either one is the same dialog.
 */
export function electronSaveDialog(): ElectronDialog | null {
	const load = (name: string): unknown => {
		try {
			const req = (globalThis as unknown as { require?: (id: string) => unknown }).require;
			return typeof req === "function" ? req(name) : null;
		} catch {
			return null;
		}
	};
	const remote = load("@electron/remote") as { dialog?: ElectronDialog } | null;
	if (remote?.dialog?.showSaveDialog) return remote.dialog;
	const electron = load("electron") as { remote?: { dialog?: ElectronDialog } } | null;
	if (electron?.remote?.dialog?.showSaveDialog) return electron.remote.dialog;
	return null;
}

/** Node's `fs`, or null on a platform that has none (mobile). */
function nodeFs(): { promises: { writeFile: (p: string, data: Uint8Array) => Promise<void> } } | null {
	try {
		const req = (globalThis as unknown as { require?: (id: string) => unknown }).require;
		const fs = typeof req === "function" ? req("fs") : null;
		return (fs as { promises?: { writeFile?: unknown } })?.promises?.writeFile
			? (fs as { promises: { writeFile: (p: string, data: Uint8Array) => Promise<void> } })
			: null;
	} catch {
		return null;
	}
}

/** The vault's own folder on disk, or "" when the adapter does not expose one. */
function vaultBasePath(app: App): string {
	const adapter = app.vault.adapter as unknown as {
		basePath?: string;
		getBasePath?: () => string;
	};
	try {
		return adapter.basePath ?? adapter.getBasePath?.() ?? "";
	} catch {
		return "";
	}
}

/** Compare two OS paths: separators and case are not meaningful on Windows. */
function samePathRoot(base: string, candidate: string): boolean {
	if (!base) return false;
	const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	return `${norm(candidate)}/`.startsWith(`${norm(base)}/`);
}

/** An absolute path inside the vault, as a vault-relative one. */
function vaultRelative(base: string, abs: string): string {
	const cut = abs.replace(/\\/g, "/").slice(base.replace(/\\/g, "/").replace(/\/+$/, "").length + 1);
	return normalizePath(cut);
}

/** The folder a path lives in, as a prefix ready to concatenate. */
function dirOf(path: string): string {
	const at = path.lastIndexOf("/");
	return at < 0 ? "" : `${path.slice(0, at + 1)}`;
}

/** `Budget.sheet` -> `Budget.xlsx`, in the same folder. */
export function xlsxPathFor(file: TFile): string {
	return normalizePath(`${dirOf(file.path)}${file.basename}.${XLSX_EXT}`);
}

/** A path nothing occupies yet: `Budget.sheet`, `Budget 1.sheet`, ... */
export function freePath(app: App, dir: string, base: string, ext: string): string {
	let path = normalizePath(`${dir}${base}.${ext}`);
	for (let i = 1; app.vault.getAbstractFileByPath(path); i++) {
		path = normalizePath(`${dir}${base} ${i}.${ext}`);
	}
	return path;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Put the bytes in the vault, at a vault-relative path, replacing what is there. */
async function writeIntoVault(app: App, path: string, bytes: Uint8Array): Promise<void> {
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		await app.vault.modifyBinary(existing, toArrayBuffer(bytes));
	} else {
		await app.vault.createBinary(path, toArrayBuffer(bytes));
	}
}

/**
 * Export a document as a workbook, ASKING where it should go.
 *
 * The export used to write `name.xlsx` silently next to the `.sheet`, which is
 * the one place a user exporting a spreadsheet usually does NOT want it: a
 * workbook is made to be sent somewhere, and the vault is not a Downloads
 * folder. So the desktop gets Electron's own save dialog, with the sheet's name
 * and its folder filled in, and anywhere on disk is a legal answer - that is the
 * point of asking.
 *
 * Two ways of writing, chosen by WHERE the answer lands:
 *
 *   - inside the vault: through the vault API, so Obsidian indexes the file and
 *     shows it in the explorer straight away (a raw `fs.writeFile` there leaves
 *     a file the app does not know about until the next rescan);
 *   - outside it: `fs`, because the vault API cannot address that at all.
 *
 * Cancelling writes nothing and says nothing - a cancelled dialog is not an
 * error, and a Notice about it would be noise.
 *
 * Where there is no dialog (mobile, or an Electron that does not expose one) the
 * old behaviour stands - the file lands next to the sheet - and the Notice says
 * so, because on that platform the user was never asked.
 */
export async function exportDocAsXlsx(
	app: App,
	file: TFile,
	doc: SheetDoc,
): Promise<string | null> {
	try {
		const XLSX = await loadXlsx();
		const bytes = writeXlsx(XLSX, doc);
		// A touch interface gets no file dialog even where Electron would offer
		// one: on a phone or a tablet there is no filesystem to browse, Obsidian
		// itself never opens one, and `body.is-mobile` is the signal the whole
		// plugin already uses for "this is a touch UI" (see platform.ts). It is
		// also how the e2e drives this branch on a desktop.
		const dialog = isTouchUi() ? null : electronSaveDialog();
		const fs = nodeFs();
		const base = vaultBasePath(app);

		// No dialog on this platform: next to the sheet, and say as much.
		if (!dialog) {
			const path = xlsxPathFor(file);
			await writeIntoVault(app, path, bytes);
			new Notice(t("xlsxExportedNextTo", { path }));
			return path;
		}

		const suggested = `${file.basename}.${XLSX_EXT}`;
		const folder = base ? `${base}/${dirOf(file.path)}`.replace(/\\/g, "/") : "";
		const result = await dialog.showSaveDialog({
			title: t("xlsxSaveTitle"),
			defaultPath: `${folder}${suggested}`,
			filters: [{ name: t("xlsxSaveFilter"), extensions: [XLSX_EXT] }],
			properties: ["createDirectory", "showOverwriteConfirmation"],
		});
		if (result?.canceled || !result?.filePath) return null;

		const chosen = result.filePath;
		if (samePathRoot(base, chosen)) {
			const path = vaultRelative(base, chosen);
			await writeIntoVault(app, path, bytes);
			new Notice(t("xlsxExported", { path }));
			return path;
		}

		if (!fs) throw new Error("no filesystem access outside the vault");
		await fs.promises.writeFile(chosen, bytes);
		new Notice(t("xlsxExported", { path: chosen }));
		return chosen;
	} catch (e) {
		console.error("leovale-sheets: xlsx export failed", e);
		new Notice(t("xlsxExportFailed", { message: (e as Error).message }), 8000);
		return null;
	}
}

/**
 * Turn xlsx bytes into a spreadsheet note and open it.
 *
 * The new file never overwrites anything, which is the opposite of the export
 * rule and deliberately so: an import is new data arriving from outside, and the
 * one thing it must not do is land on something the vault already had.
 */
export async function importXlsxBytes(
	app: App,
	data: ArrayBuffer,
	baseName: string,
	ext: string,
	folder?: TFolder,
): Promise<TFile | null> {
	let doc: SheetDoc;
	let XLSX;
	try {
		XLSX = await loadXlsx();
		doc = readXlsx(XLSX, data);
	} catch (e) {
		console.error("leovale-sheets: xlsx import failed", e);
		new Notice(t("xlsxImportFailed", { message: (e as Error).message }), 8000);
		return null;
	}
	if (doc.sheets.length === 0) doc = newSheetDoc();

	const parent =
		folder ?? app.fileManager.getNewFileParent(app.workspace.getActiveFile()?.path ?? "");
	const dir = !parent || parent.path === "/" ? "" : `${parent.path}/`;
	const base = (baseName || "Imported").replace(/\.[^.]+$/, "").trim() || "Imported";
	const path = freePath(app, dir, base, ext);

	try {
		const file = await app.vault.create(path, serializeSheet(doc));
		await app.workspace.getLeaf(true).openFile(file);
		const cells = doc.sheets.reduce((n, page) => n + Object.keys(page.cells).length, 0);
		new Notice(t("xlsxImported", { path, sheets: doc.sheets.length, cells }));
		return file;
	} catch (e) {
		console.error("leovale-sheets: writing the imported sheet failed", e);
		new Notice(t("xlsxImportFailed", { message: (e as Error).message }), 8000);
		return null;
	}
}

/** Import an `.xlsx` that is already in the vault. */
export async function importXlsxFile(app: App, file: TFile, ext: string): Promise<TFile | null> {
	let data: ArrayBuffer;
	try {
		data = await app.vault.readBinary(file);
	} catch (e) {
		new Notice(t("xlsxImportFailed", { message: (e as Error).message }), 8000);
		return null;
	}
	return importXlsxBytes(app, data, file.basename, ext, file.parent ?? undefined);
}

/**
 * Ask the operating system for an `.xlsx`, anywhere on disk.
 *
 * A detached `<input type="file">` rather than Electron's dialog module: the
 * plugin must keep working on mobile, where there is no Electron at all, and
 * the input is what the file manager there answers.
 */
export function pickXlsx(onPicked: (data: ArrayBuffer, name: string) => void): void {
	const input = document.createElement("input");
	input.type = "file";
	input.accept = ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
	input.style.display = "none";
	input.addEventListener("change", () => {
		const picked = input.files?.[0];
		input.remove();
		if (!picked) return;
		picked
			.arrayBuffer()
			.then((data) => onPicked(data, picked.name))
			.catch((e: Error) => new Notice(t("xlsxImportFailed", { message: e.message }), 8000));
	});
	document.body.appendChild(input);
	input.click();
}
