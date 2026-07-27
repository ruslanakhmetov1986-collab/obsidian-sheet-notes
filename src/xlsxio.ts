/**
 * The vault side of the xlsx bridge: pick a file, read bytes, write bytes, say
 * what happened. Everything that needs Obsidian lives here, so `xlsx.ts` stays a
 * pure mapping module that the unit tests can drive without an app.
 */

import { type App, Notice, TFile, type TFolder, normalizePath } from "obsidian";
import { type SheetDoc, newSheetDoc, serializeSheet } from "./format";
import { loadXlsx, readXlsx, writeXlsx } from "./xlsx";
import { t } from "./i18n";

export const XLSX_EXT = "xlsx";

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

/**
 * Write a document next to its own file as `name.xlsx`.
 *
 * An existing `name.xlsx` is REPLACED: it is this sheet's export, exporting
 * twice should give one file rather than a numbered pile, and the source of
 * truth is the `.sheet` that was just exported from.
 */
export async function exportDocAsXlsx(
	app: App,
	file: TFile,
	doc: SheetDoc,
): Promise<string | null> {
	try {
		const XLSX = await loadXlsx();
		const bytes = writeXlsx(XLSX, doc);
		const path = xlsxPathFor(file);
		const existing = app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await app.vault.modifyBinary(existing, toArrayBuffer(bytes));
		} else {
			await app.vault.createBinary(path, toArrayBuffer(bytes));
		}
		new Notice(t("xlsxExported", { path }));
		return path;
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
