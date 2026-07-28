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
import { applyPendingCut, cancelCut, clipFor, setClip } from "./clipboard";
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

/**
 * Copy (or cut) the selection.
 *
 * TWO destinations, on purpose: the plain tab-separated text goes to the SYSTEM
 * clipboard, so the range still pastes into Excel or into a note, and the
 * structured payload - values, formulas, styles, types - is kept in the
 * plugin's own store keyed on that same text. See clipboard.ts.
 *
 * The store is written only after the system write SUCCEEDED. If it throws, the
 * system clipboard still holds whatever it held before, and so must the store,
 * or the next paste would silently write a range the user never copied.
 */
export async function copySelection(engine: SheetEngine, cut = false): Promise<void> {
	const cutting = cut && !engine.isReadOnly;
	const clip = engine.selectionClip(cutting);
	if (!clip || clip.tsv === "") return;
	const { rows, cols } = span(engine);
	try {
		await navigator.clipboard.writeText(clip.tsv);
	} catch (e) {
		new Notice(t("clipboardFailed", { message: (e as Error).message }));
		return;
	}
	setClip(clip);
	new Notice(cutting ? t("cmCutReady", { rows, cols }) : t("cmCopied", { rows, cols }));
}

/**
 * Paste at the selection: the rich payload when the system clipboard still
 * holds the text it was copied with, the clipboard's own text otherwise.
 *
 * A pending cut is completed BEFORE the write, not after: a range moved one
 * column to the right overlaps itself, and clearing afterwards would erase the
 * half that had just been pasted. The payload is already in memory by then, so
 * there is nothing left to read out of the source. Both halves run in the same
 * task, so the view's autosave sees one state, not two.
 */
export async function pasteInto(engine: SheetEngine): Promise<void> {
	// Before anything else, and it is about the CUT rather than about the paste:
	// completing a move empties the source, so a destination that cannot be
	// written to would take the cells away and put them nowhere. Both callers
	// already refuse (the view checks its own flag, the menu hides the item on a
	// read-only sheet); this is the guard that does not depend on either.
	if (engine.isReadOnly) {
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
	const clip = clipFor(text);
	if (clip) {
		applyPendingCut();
		const written = engine.pasteClip(clip);
		if (written.rows > 0) new Notice(t("cmPasted", { rows: written.rows, cols: written.cols }));
		return;
	}
	if (text.trim() === "") {
		new Notice(t("cmPasteEmpty"));
		return;
	}
	const written = engine.pasteTsv(text);
	if (written.rows > 0) new Notice(t("cmPasted", { rows: written.rows, cols: written.cols }));
}

/** Escape: withdraw a pending cut, leaving its source exactly as it is. */
export function cancelPendingCut(): void {
	cancelCut();
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
				.setTitle(t("cmCut"))
				.setIcon("scissors")
				.onClick(() => void copySelection(engine, true)),
		);
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
