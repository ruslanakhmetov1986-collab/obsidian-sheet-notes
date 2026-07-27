/**
 * The grid's context menu: right click on a desktop, long press on a tablet.
 *
 * WHY IT IS REBUILT RATHER THAN RESTYLED. The bundled engine ships its own menu
 * (jsuites), and on the tablet it was three things at once: English in a
 * Russian interface, decorated with `Ctrl+C` / `Ctrl+V` / `Ctrl+S` hints that a
 * device with no keyboard cannot act on, and 37 px rows where the whole rest of
 * the plugin is 44. Patching that after it opens means re-translating text
 * nodes and re-measuring rows on every open, against a menu the vendor rebuilds
 * from scratch each time and can change in any release - a race we would lose
 * quietly. The engine offers a documented way out instead: its `contextMenu`
 * hook may answer `false`, and then it opens nothing at all (see engine.ts).
 * So the menu here is an ordinary Obsidian `Menu`: the app's own theming, the
 * app's own light and dark, our twelve locales, no invented keyboard hints, and
 * 44 px rows on touch from one CSS rule.
 *
 * What it deliberately keeps from the engine's menu: inserting and deleting
 * rows and columns (which is the only place in the plugin those exist), copy
 * and paste, and merging. What it drops: "Download as CSV" (a spreadsheet in a
 * vault is a file already), "About", and every shortcut hint.
 */

import { Menu, Notice, Platform } from "obsidian";
import type { GridMenuContext, SheetEngine } from "./engine";
import { isTouchUi } from "./platform";
import { t } from "./i18n";

/** What the menu cannot do on its own; the view owns these. */
export interface GridMenuActions {
	/** Merge or split the selection, with the confirm the view puts up. */
	merge: () => void;
}

/** Rows and columns the selection spans, as the delete items report them. */
function span(engine: SheetEngine): { rows: number; cols: number } {
	const rect = engine.selectionRect();
	if (!rect) return { rows: 1, cols: 1 };
	return { rows: rect.r2 - rect.r1 + 1, cols: rect.c2 - rect.c1 + 1 };
}

async function copySelection(engine: SheetEngine): Promise<void> {
	const text = engine.selectionTsv();
	if (text === "") return;
	const { rows, cols } = span(engine);
	try {
		await navigator.clipboard.writeText(text);
	} catch (e) {
		new Notice(t("clipboardFailed", { message: (e as Error).message }));
		return;
	}
	new Notice(t("cmCopied", { rows, cols }));
}

async function pasteInto(engine: SheetEngine): Promise<void> {
	let text = "";
	try {
		text = await navigator.clipboard.readText();
	} catch (e) {
		new Notice(t("clipboardFailed", { message: (e as Error).message }));
		return;
	}
	if (text.trim() === "") {
		new Notice(t("cmPasteEmpty"));
		return;
	}
	const written = engine.pasteTsv(text);
	if (written.rows > 0) new Notice(t("mdPasted", { rows: written.rows, cols: written.cols }));
}

/**
 * Build and show the menu for one press.
 *
 * `ctx.touch` is the long press: a menu a finger asked for gets no keyboard
 * hints (there are none to give) and, through {@link MENU_CLASS}, rows a finger
 * can hit. The row and column the press landed on come from the engine, and the
 * selection is already where the press put it - the engine moves it before
 * asking for a menu, exactly as a right click does everywhere else.
 */
export const MENU_CLASS = "leovale-sheet-menu";

export function openGridMenu(
	engine: SheetEngine,
	ctx: GridMenuContext,
	actions: GridMenuActions,
): void {
	const menu = new Menu();
	// Force the DOM menu: a native (OS) menu on the desktop cannot carry our
	// class, and the mobile sizing and the e2e both read the DOM.
	menu.setUseNativeMenu?.(false);

	const cursor = engine.activeCell();
	const row = ctx.row ?? cursor?.row ?? 0;
	const col = ctx.col ?? cursor?.col ?? 0;
	const { rows, cols } = span(engine);
	const editable = !engine.isReadOnly;

	if (editable && ctx.role === "cell") {
		menu.addItem((item) =>
			item
				.setTitle(t("cmEdit"))
				.setIcon("pencil")
				.onClick(() => engine.openEditorAt(row, col)),
		);
		menu.addSeparator();
	}

	menu.addItem((item) =>
		item
			.setTitle(t("cmCopy"))
			.setIcon("copy")
			.onClick(() => void copySelection(engine)),
	);
	if (editable) {
		menu.addItem((item) =>
			item
				.setTitle(t("cmPaste"))
				.setIcon("clipboard-paste")
				.onClick(() => void pasteInto(engine)),
		);
	}

	if (editable) {
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(t("cmInsertRowAbove"))
				.setIcon("panel-top")
				.onClick(() => engine.insertRows(row, 1, true)),
		);
		menu.addItem((item) =>
			item
				.setTitle(t("cmInsertRowBelow"))
				.setIcon("panel-bottom")
				.onClick(() => engine.insertRows(row, 1, false)),
		);
		menu.addItem((item) =>
			item
				.setTitle(t("cmInsertColLeft"))
				.setIcon("panel-left")
				.onClick(() => engine.insertColumns(col, 1, true)),
		);
		menu.addItem((item) =>
			item
				.setTitle(t("cmInsertColRight"))
				.setIcon("panel-right")
				.onClick(() => engine.insertColumns(col, 1, false)),
		);

		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(rows > 1 ? t("cmDeleteRows") : t("cmDeleteRow"))
				.setIcon("trash-2")
				.onClick(() => engine.deleteRows(row, rows)),
		);
		menu.addItem((item) =>
			item
				.setTitle(cols > 1 ? t("cmDeleteCols") : t("cmDeleteCol"))
				.setIcon("trash-2")
				.onClick(() => engine.deleteColumns(col, cols)),
		);

		menu.addSeparator();
		const merged = !!engine.mergeAt(row, col);
		menu.addItem((item) =>
			item
				.setTitle(merged ? t("tbUnmerge") : t("tbMerge"))
				.setIcon("combine")
				.onClick(() => actions.merge()),
		);
	}

	// `dom` is not in the public typings, but it is the element the menu is
	// rendered into and the only way to mark it as ours. Guarded: a build without
	// it simply gets the default sizing.
	const dom = (menu as unknown as { dom?: HTMLElement }).dom;
	dom?.addClass(MENU_CLASS);
	if (ctx.touch || isTouchUi() || Platform.isMobile) dom?.addClass("is-touch");

	// `ctx.doc` and not the global one: `ctx.x`/`ctx.y` were measured in the
	// window the grid is in, and a sheet can be in an Obsidian pop-out.
	menu.showAtPosition({ x: ctx.x, y: ctx.y }, ctx.doc);
}
