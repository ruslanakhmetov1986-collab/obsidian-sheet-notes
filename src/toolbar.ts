/**
 * Formatting toolbar above the grid: bold, font size, fill colour, borders.
 *
 * Visual model is the Google Sheets bar: one flat 36px row of borderless 28px
 * icon buttons, thin group separators, dropdowns rendered as native Obsidian
 * menus. Everything it writes goes through {@link SheetEngine.applyStyle},
 * which normalizes to our four persisted properties (b / fs / bg / bd) and
 * triggers autosave. The toolbar never touches CSS or the file format directly.
 */

import { Menu, setIcon } from "obsidian";
import type { SheetEngine } from "./engine";
import {
	type CellStyle,
	type HAlign,
	MAX_FONT_SIZE,
	MIN_FONT_SIZE,
	type SortDir,
	type VAlign,
	colToName,
	parseRef,
} from "./format";
import { freezeFromRef } from "./sheetops";
import { type StringKey, t } from "./i18n";

/**
 * What the toolbar cannot do on its own, because it needs the DOCUMENT rather
 * than the live grid (sorting rewrites the file and re-renders) or a piece of
 * chrome it does not own (the find strip, the column-width modal).
 */
export interface ToolbarActions {
	sort: (dir: SortDir | null) => void;
	toggleFind: () => void;
	columnWidth: () => void;
	/** Merge or split the selection; asks first when a value would be dropped. */
	merge: () => void;
}

/** How many distinct values a filter menu will list before it gives up. */
export const FILTER_MENU_LIMIT = 50;

export const FONT_SIZES = [10, 12, 14, 16, 18, 24];

/**
 * Number-format presets, in menu order. `mask: null` is "Auto", i.e. no format
 * at all: the cell shows its raw value, which is also what an unformatted cell
 * does, so picking Auto removes the key from the file instead of storing a
 * do-nothing mask.
 *
 * The masks are excel-like strings and go into the file verbatim, so a file
 * written on a Russian machine renders the same everywhere. The currency order
 * follows the toolbar author's own habit; all three are always offered.
 */
export const NUMBER_FORMATS: { mask: string | null; label: StringKey }[] = [
	{ mask: null, label: "nfAuto" },
	{ mask: "0.00", label: "nfTwoDecimals" },
	{ mask: "#,##0", label: "nfThousands" },
	{ mask: "#,##0.00", label: "nfThousands2" },
	{ mask: "0%", label: "nfPercent" },
	{ mask: "$#,##0.00", label: "nfUsd" },
	{ mask: "€#,##0.00", label: "nfEur" },
	{ mask: "#,##0.00 ₽", label: "nfRub" },
	{ mask: "yyyy-mm-dd", label: "nfDate" },
	{ mask: "yyyy-mm-dd hh:mm", label: "nfDateTime" },
];

/** Horizontal alignment menu items. `null` clears the key (= left). */
const H_ALIGN_ITEMS: { value: HAlign | null; label: StringKey; icon: string }[] = [
	{ value: null, label: "alignLeft", icon: "align-left" },
	{ value: "c", label: "alignCenter", icon: "align-center" },
	{ value: "r", label: "alignRight", icon: "align-right" },
];

/** Vertical alignment menu items. `null` clears the key (= the cell default). */
const V_ALIGN_ITEMS: { value: VAlign | null; label: StringKey; icon: string }[] = [
	{ value: "t", label: "alignTop", icon: "arrow-up" },
	{ value: null, label: "alignMiddleDefault", icon: "minus" },
	{ value: "b", label: "alignBottom", icon: "arrow-down" },
];

/** Palette laid out as a 6x2 grid, Google-Sheets style. */
export const FILL_COLORS: { value: string | null; label: StringKey }[] = [
	{ value: null, label: "fillNone" },
	{ value: "#ffffff", label: "fillWhite" },
	{ value: "#fff2cc", label: "fillYellow" },
	{ value: "#fce5cd", label: "fillOrange" },
	{ value: "#ffe0e0", label: "fillRed" },
	{ value: "#f4d9e8", label: "fillPink" },
	{ value: "#e2f0d9", label: "fillGreen" },
	{ value: "#d0e8e4", label: "fillTeal" },
	{ value: "#deebf7", label: "fillBlue" },
	{ value: "#e6e0f8", label: "fillPurple" },
	{ value: "#d9d9d9", label: "fillGrey" },
	{ value: "#434343", label: "fillDark" },
];

export type BorderMode = "none" | "all" | "outline" | "t" | "r" | "b" | "l";

const BORDER_ITEMS: { value: BorderMode; label: StringKey; icon: string }[] = [
	{ value: "all", label: "borderAll", icon: "table" },
	{ value: "outline", label: "borderOutline", icon: "square" },
	{ value: "none", label: "borderNone", icon: "eraser" },
	{ value: "t", label: "borderTop", icon: "panel-top" },
	{ value: "r", label: "borderRight", icon: "panel-right" },
	{ value: "b", label: "borderBottom", icon: "panel-bottom" },
	{ value: "l", label: "borderLeft", icon: "panel-left" },
];

export class SheetToolbar {
	private el: HTMLElement;
	private getEngine: () => SheetEngine | null;
	private boldButton!: HTMLButtonElement;
	private sizeButton!: HTMLButtonElement;
	private sizeLabel!: HTMLElement;
	private fillButton!: HTMLButtonElement;
	private fillSwatch!: HTMLElement;
	private palette!: HTMLElement;
	private borderButton!: HTMLButtonElement;
	private numberButton!: HTMLButtonElement;
	private numberLabel!: HTMLElement;
	private alignButton!: HTMLButtonElement;
	private alignIcon!: HTMLElement;
	private wrapButton!: HTMLButtonElement;
	private mergeButton!: HTMLButtonElement;
	private checkboxButton!: HTMLButtonElement;
	private sortButton!: HTMLButtonElement;
	private filterButton!: HTMLButtonElement;
	private freezeButton!: HTMLButtonElement;
	private findButton!: HTMLButtonElement;
	private widthButton!: HTMLButtonElement;
	private actions: ToolbarActions;
	private onPointerDown: (e: MouseEvent) => void;
	private onKeyDown: (e: KeyboardEvent) => void;
	/** Selection snapshot taken before a toolbar click can clear the grid's own. */
	private pendingRefs: string[] = [];

	constructor(parent: HTMLElement, getEngine: () => SheetEngine | null, actions: ToolbarActions) {
		this.getEngine = getEngine;
		this.actions = actions;
		this.el = parent.createDiv({ cls: "leovale-sheet-toolbar" });
		this.build();

		this.onPointerDown = (e: MouseEvent) => {
			if (this.el.contains(e.target as Node)) {
				// The grid drops its selection the moment we click outside it.
				const refs = this.getEngine()?.getSelectionRefs() ?? [];
				if (refs.length > 0) this.pendingRefs = refs;
				return;
			}
			this.closePalette();
		};
		document.addEventListener("mousedown", this.onPointerDown, true);

		// Escape closes the palette. It used to only close native menus, so the
		// fill popover stayed open (and its button lit) until the next click.
		this.onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") this.closePalette();
		};
		document.addEventListener("keydown", this.onKeyDown, true);
	}

	/** Cells a toolbar action should act on. */
	private targetRefs(): string[] {
		const live = this.getEngine()?.getSelectionRefs() ?? [];
		if (live.length > 0) return live;
		return this.pendingRefs;
	}

	/* -------------------------------------------------------------- build */

	private iconButton(
		parent: HTMLElement,
		cls: string,
		icon: string,
		label: string,
	): HTMLButtonElement {
		const button = parent.createEl("button", {
			cls: `leovale-sheet-tb-btn ${cls}`,
			attr: { type: "button", title: label, "aria-label": label },
		});
		setIcon(button.createSpan({ cls: "leovale-sheet-tb-icon" }), icon);
		return button;
	}

	private caret(button: HTMLElement): void {
		setIcon(button.createSpan({ cls: "leovale-sheet-tb-caret" }), "chevron-down");
	}

	private build(): void {
		// --- group 1: bold + font size --------------------------------------
		const group1 = this.el.createDiv({ cls: "leovale-sheet-tb-group" });

		this.boldButton = this.iconButton(group1, "leovale-sheet-tb-bold", "bold", t("tbBold"));
		this.boldButton.onclick = () => this.toggleBold();

		this.sizeButton = group1.createEl("button", {
			cls: "leovale-sheet-tb-btn leovale-sheet-tb-size is-wide",
			attr: { type: "button", title: t("tbFontSize"), "aria-label": t("tbFontSize") },
		});
		this.sizeLabel = this.sizeButton.createSpan({ cls: "leovale-sheet-tb-value", text: "—" });
		this.caret(this.sizeButton);
		this.sizeButton.onclick = () => this.openSizeMenu();

		this.el.createDiv({ cls: "leovale-sheet-tb-sep" });

		// --- group 2: fill ---------------------------------------------------
		const group2 = this.el.createDiv({ cls: "leovale-sheet-tb-group leovale-sheet-tb-fill" });
		this.fillButton = this.iconButton(
			group2,
			"leovale-sheet-tb-fillbtn",
			"paint-bucket",
			t("tbFill"),
		);
		// Google Sheets shows the current colour as a bar under the bucket.
		this.fillSwatch = this.fillButton.createSpan({ cls: "leovale-sheet-tb-swatch is-empty" });

		this.palette = group2.createDiv({ cls: "leovale-sheet-palette" });
		for (const { value, label } of FILL_COLORS) {
			const text = t(label);
			const swatch = this.palette.createEl("button", {
				cls: `leovale-sheet-swatch${value ? "" : " is-none"}`,
				attr: {
					type: "button",
					title: text,
					"aria-label": text,
					"data-color": value ?? "none",
				},
			});
			if (value) swatch.style.backgroundColor = value;
			swatch.onclick = () => this.applyFill(value);
		}
		this.fillButton.onclick = () => this.togglePalette();

		this.el.createDiv({ cls: "leovale-sheet-tb-sep" });

		// --- group 3: borders ------------------------------------------------
		const group3 = this.el.createDiv({ cls: "leovale-sheet-tb-group" });
		// NB: `grid-2x2` is NOT in this Obsidian build's lucide set (setIcon then
		// renders nothing at all). Verified-present names only.
		this.borderButton = this.iconButton(
			group3,
			"leovale-sheet-tb-border is-wide",
			"table",
			t("tbBorders"),
		);
		this.caret(this.borderButton);
		this.borderButton.onclick = () => this.openBorderMenu();

		this.el.createDiv({ cls: "leovale-sheet-tb-sep" });

		// --- group 4: number format ------------------------------------------
		const group4 = this.el.createDiv({ cls: "leovale-sheet-tb-group" });
		this.numberButton = group4.createEl("button", {
			cls: "leovale-sheet-tb-btn leovale-sheet-tb-number is-wide",
			attr: { type: "button", title: t("tbNumberFormat"), "aria-label": t("tbNumberFormat") },
		});
		setIcon(this.numberButton.createSpan({ cls: "leovale-sheet-tb-icon" }), "hash");
		this.numberLabel = this.numberButton.createSpan({
			cls: "leovale-sheet-tb-value leovale-sheet-tb-nfvalue",
			text: "—",
		});
		this.caret(this.numberButton);
		this.numberButton.onclick = () => this.openNumberMenu();

		this.el.createDiv({ cls: "leovale-sheet-tb-sep" });

		// --- group 5: alignment + wrap ---------------------------------------
		const group5 = this.el.createDiv({ cls: "leovale-sheet-tb-group" });
		this.alignButton = group5.createEl("button", {
			cls: "leovale-sheet-tb-btn leovale-sheet-tb-align is-wide",
			attr: { type: "button", title: t("tbAlign"), "aria-label": t("tbAlign") },
		});
		this.alignIcon = this.alignButton.createSpan({ cls: "leovale-sheet-tb-icon" });
		setIcon(this.alignIcon, "align-left");
		this.caret(this.alignButton);
		this.alignButton.onclick = () => this.openAlignMenu();

		this.wrapButton = this.iconButton(
			group5,
			"leovale-sheet-tb-wrap",
			"wrap-text",
			t("tbWrap"),
		);
		this.wrapButton.onclick = () => this.toggleWrap();

		this.el.createDiv({ cls: "leovale-sheet-tb-sep" });

		// --- group 6: cell shape (merge, checkbox) ---------------------------
		const group6 = this.el.createDiv({ cls: "leovale-sheet-tb-group" });
		this.mergeButton = this.iconButton(
			group6,
			"leovale-sheet-tb-merge",
			"combine",
			t("tbMerge"),
		);
		this.mergeButton.onclick = () => this.actions.merge();

		this.checkboxButton = this.iconButton(
			group6,
			"leovale-sheet-tb-checkbox",
			"check-square",
			t("tbCheckbox"),
		);
		this.checkboxButton.onclick = () => this.toggleCheckbox();

		this.el.createDiv({ cls: "leovale-sheet-tb-sep" });

		// --- group 7: data (sort, filter, freeze) -----------------------------
		const group7 = this.el.createDiv({ cls: "leovale-sheet-tb-group" });
		this.sortButton = this.iconButton(
			group7,
			"leovale-sheet-tb-sort",
			"arrow-up-down",
			t("tbSort"),
		);
		this.sortButton.onclick = () => this.openSortMenu();

		this.filterButton = this.iconButton(
			group7,
			"leovale-sheet-tb-filter",
			"filter",
			t("tbFilter"),
		);
		this.filterButton.onclick = () => this.openFilterMenu();

		this.freezeButton = this.iconButton(
			group7,
			"leovale-sheet-tb-freeze",
			"pin",
			t("tbFreeze"),
		);
		this.freezeButton.onclick = () => this.openFreezeMenu();

		this.el.createDiv({ cls: "leovale-sheet-tb-sep" });

		// --- group 8: find + column width -------------------------------------
		const group8 = this.el.createDiv({ cls: "leovale-sheet-tb-group" });
		this.findButton = this.iconButton(group8, "leovale-sheet-tb-find", "search", t("tbFind"));
		this.findButton.onclick = () => this.actions.toggleFind();

		this.widthButton = this.iconButton(
			group8,
			"leovale-sheet-tb-width",
			"move-horizontal",
			t("tbColWidth"),
		);
		this.widthButton.onclick = () => this.actions.columnWidth();
	}

	/* ------------------------------------------------- sort, filter, freeze */

	/** The column a data action works on: the one the selection starts in. */
	private targetColumn(): number | null {
		const ref = this.targetRefs()[0];
		if (!ref) return null;
		return parseRef(ref).col;
	}

	private openSortMenu(): void {
		this.closePalette();
		const engine = this.getEngine();
		const col = this.targetColumn();
		const current = engine?.getView().sort;
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(t("sortAsc"))
				.setIcon("arrow-down-a-z")
				.setChecked(current?.col === col && current?.dir === "asc")
				.onClick(() => this.actions.sort("asc")),
		);
		menu.addItem((item) =>
			item
				.setTitle(t("sortDesc"))
				.setIcon("arrow-down-z-a")
				.setChecked(current?.col === col && current?.dir === "desc")
				.onClick(() => this.actions.sort("desc")),
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(t("sortClear"))
				.setIcon("eraser")
				.setDisabled(!current)
				.onClick(() => this.actions.sort(null)),
		);
		this.showMenuUnder(menu, this.sortButton);
	}

	/**
	 * The filter menu is the column's distinct values, each a checkable item.
	 * A column with no filter shows every value checked, which is both true and
	 * the state a first click has to toggle away from.
	 */
	private openFilterMenu(): void {
		this.closePalette();
		const engine = this.getEngine();
		const col = this.targetColumn();
		if (!engine || col === null) return;
		const values = engine.columnValues(col, 0).slice(0, FILTER_MENU_LIMIT + 1);
		const truncated = values.length > FILTER_MENU_LIMIT;
		const listed = truncated ? values.slice(0, FILTER_MENU_LIMIT) : values;
		const allowed = engine.getView().filters?.[String(col)];
		const menu = new Menu();

		menu.addItem((item) =>
			item
				.setTitle(t("filterShowAll"))
				.setIcon("eye")
				.setChecked(!allowed)
				.onClick(() => engine.setFilter(col, null)),
		);
		menu.addItem((item) =>
			item
				.setTitle(t("filterClearAll"))
				.setIcon("filter-x")
				.setDisabled(!engine.getView().filters)
				.onClick(() => engine.clearFilters()),
		);
		menu.addSeparator();

		if (listed.length === 0) {
			menu.addItem((item) => item.setTitle(t("filterNoValues")).setDisabled(true));
		}
		for (const value of listed) {
			const on = !allowed || allowed.includes(value);
			menu.addItem((item) =>
				item
					.setTitle(value)
					.setChecked(on)
					.onClick(() => {
						const base = allowed ?? listed;
						const next = on ? base.filter((v) => v !== value) : [...base, value];
						// Unchecking the last value would hide every row; that is read
						// as "show everything again" instead.
						engine.setFilter(col, next.length > 0 ? next : null);
					}),
			);
		}
		if (truncated) {
			menu.addSeparator();
			menu.addItem((item) =>
				item.setTitle(t("filterTruncated", { count: FILTER_MENU_LIMIT })).setDisabled(true),
			);
		}
		this.showMenuUnder(menu, this.filterButton);
	}

	private openFreezeMenu(): void {
		this.closePalette();
		const engine = this.getEngine();
		if (!engine) return;
		const ref = this.targetRefs()[0] ?? "A1";
		const current = engine.getFreeze();
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(t("freezeRows"))
				.setIcon("panel-top")
				.setChecked(!!current.rows && !current.cols)
				.onClick(() => engine.setFreeze({ ...freezeFromRef(ref, "rows"), cols: current.cols })),
		);
		menu.addItem((item) =>
			item
				.setTitle(t("freezeCols"))
				.setIcon("panel-left")
				.setChecked(!!current.cols && !current.rows)
				.onClick(() => engine.setFreeze({ ...freezeFromRef(ref, "cols"), rows: current.rows })),
		);
		menu.addItem((item) =>
			item
				.setTitle(t("freezeBoth"))
				.setIcon("table")
				.setChecked(!!current.rows && !!current.cols)
				.onClick(() => engine.setFreeze(freezeFromRef(ref, "both"))),
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(t("freezeNone"))
				.setIcon("eraser")
				.setDisabled(!current.rows && !current.cols)
				.onClick(() => engine.setFreeze({})),
		);
		this.showMenuUnder(menu, this.freezeButton);
	}

	/** Which columns a width change applies to: every column in the selection. */
	selectedColumns(): number[] {
		const cols = new Set<number>();
		for (const ref of this.targetRefs()) cols.add(parseRef(ref).col);
		return [...cols].sort((a, b) => a - b);
	}

	/** Human-readable list of those columns, for the dialog's subtitle. */
	selectedColumnNames(): string {
		return this.selectedColumns().map((c) => colToName(c)).join(", ");
	}

	/* ------------------------------------------------------------ actions */

	private toggleBold(): void {
		const engine = this.getEngine();
		if (!engine) return;
		const refs = this.targetRefs();
		if (refs.length === 0) return;
		// Google Sheets semantics: if anything in the selection is not bold, the
		// whole selection becomes bold; otherwise it all turns normal.
		const makeBold = refs.some((r) => !engine.getStyleAt(r).b);
		engine.applyStyle(refs, (cur) => {
			const next: CellStyle = { ...cur };
			if (makeBold) next.b = true;
			else delete next.b;
			return next;
		});
		this.sync();
	}

	private applyFill(value: string | null): void {
		const engine = this.getEngine();
		this.closePalette();
		if (!engine) return;
		const refs = this.targetRefs();
		if (refs.length === 0) return;
		engine.applyStyle(refs, (cur) => {
			const next: CellStyle = { ...cur };
			if (value) next.bg = value;
			else delete next.bg;
			return next;
		});
		this.sync();
	}

	private applySize(size: number | undefined): void {
		const engine = this.getEngine();
		if (!engine) return;
		const refs = this.targetRefs();
		if (refs.length === 0) return;
		const valid =
			size !== undefined && Number.isFinite(size) && size >= MIN_FONT_SIZE && size <= MAX_FONT_SIZE
				? Math.round(size)
				: undefined;
		engine.applyStyle(refs, (cur) => {
			const next: CellStyle = { ...cur };
			if (valid === undefined) delete next.fs;
			else next.fs = valid;
			return next;
		});
		this.sync();
	}

	private applyBorders(mode: string): void {
		const engine = this.getEngine();
		if (!engine) return;
		const refs = this.targetRefs();
		if (refs.length === 0) return;

		let minRow = Infinity;
		let maxRow = -Infinity;
		let minCol = Infinity;
		let maxCol = -Infinity;
		for (const ref of refs) {
			const { row, col } = parseRef(ref);
			minRow = Math.min(minRow, row);
			maxRow = Math.max(maxRow, row);
			minCol = Math.min(minCol, col);
			maxCol = Math.max(maxCol, col);
		}

		engine.applyStyle(refs, (cur, ref) => {
			const next: CellStyle = { ...cur };
			if (mode === "none") {
				delete next.bd;
				return next;
			}
			if (mode === "all") {
				next.bd = "trbl";
				return next;
			}
			if (mode === "outline") {
				const { row, col } = parseRef(ref);
				let sides = "";
				if (row === minRow) sides += "t";
				if (col === maxCol) sides += "r";
				if (row === maxRow) sides += "b";
				if (col === minCol) sides += "l";
				if (sides) next.bd = sides;
				else delete next.bd;
				return next;
			}
			// single side: toggle it on, keeping the others
			const cursides = next.bd ?? "";
			next.bd = cursides.includes(mode) ? cursides : cursides + mode;
			return next;
		});
		this.sync();
	}

	private applyNumberFormat(mask: string | null): void {
		const engine = this.getEngine();
		if (!engine) return;
		const refs = this.targetRefs();
		if (refs.length === 0) return;
		engine.applyStyle(refs, (cur) => {
			const next: CellStyle = { ...cur };
			if (mask) next.nf = mask;
			else delete next.nf;
			return next;
		});
		this.sync();
	}

	private applyHAlign(value: HAlign | null): void {
		const engine = this.getEngine();
		if (!engine) return;
		const refs = this.targetRefs();
		if (refs.length === 0) return;
		engine.applyStyle(refs, (cur) => {
			const next: CellStyle = { ...cur };
			if (value) next.ha = value;
			else delete next.ha;
			return next;
		});
		this.sync();
	}

	private applyVAlign(value: VAlign | null): void {
		const engine = this.getEngine();
		if (!engine) return;
		const refs = this.targetRefs();
		if (refs.length === 0) return;
		engine.applyStyle(refs, (cur) => {
			const next: CellStyle = { ...cur };
			if (value) next.va = value;
			else delete next.va;
			return next;
		});
		this.sync();
	}

	private toggleWrap(): void {
		const engine = this.getEngine();
		if (!engine) return;
		const refs = this.targetRefs();
		if (refs.length === 0) return;
		// Same semantics as Bold: any unwrapped cell in the selection means "wrap
		// them all", otherwise the whole selection is unwrapped.
		const makeWrap = refs.some((r) => !engine.getStyleAt(r).wrap);
		engine.applyStyle(refs, (cur) => {
			const next: CellStyle = { ...cur };
			if (makeWrap) next.wrap = true;
			else delete next.wrap;
			return next;
		});
		this.sync();
	}

	/**
	 * Checkbox cells. Same "any of them is off means turn them all on" rule as
	 * Bold, and the values are left alone: a column of `true`/`false` becomes a
	 * column of ticked boxes, and switching it back gives the words back.
	 */
	private toggleCheckbox(): void {
		const engine = this.getEngine();
		if (!engine) return;
		const refs = this.targetRefs();
		if (refs.length === 0) return;
		const makeCheckbox = refs.some((r) => engine.getCellType(r) !== "cb");
		engine.setCellType(refs, makeCheckbox ? "cb" : null);
		this.sync();
	}

	/* -------------------------------------------------------------- popups */

	private togglePalette(): void {
		const open = !this.palette.hasClass("is-open");
		this.palette.toggleClass("is-open", open);
		this.fillButton.toggleClass("is-active", open);
	}

	private closePalette(): void {
		if (!this.palette.hasClass("is-open")) return;
		this.palette.removeClass("is-open");
		this.fillButton.removeClass("is-active");
	}

	/**
	 * Anchor a native Obsidian menu just under a toolbar button.
	 *
	 * The button is marked while its menu is open and cleaned up in `onHide`,
	 * which fires for every way of dismissing a menu - picking an item, clicking
	 * away, Escape. Without it a tap on a tablet left the button looking pressed
	 * for the rest of the session (`:hover`/`:focus` stick after a touch, so
	 * `blur()` is part of the cleanup).
	 */
	private showMenuUnder(menu: Menu, button: HTMLElement): void {
		const rect = button.getBoundingClientRect();
		button.addClass("is-open");
		menu.onHide(() => {
			button.removeClass("is-open");
			(button as HTMLButtonElement).blur();
			this.sync();
		});
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
	}

	private openSizeMenu(): void {
		this.closePalette();
		const refs = this.targetRefs();
		const current = refs[0] ? this.getEngine()?.getStyleAt(refs[0]).fs : undefined;
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle(t("sizeDefault"))
				.setChecked(current === undefined)
				.onClick(() => this.applySize(undefined)),
		);
		menu.addSeparator();
		for (const size of FONT_SIZES) {
			menu.addItem((item) =>
				item
					.setTitle(String(size))
					.setChecked(current === size)
					.onClick(() => this.applySize(size)),
			);
		}
		this.showMenuUnder(menu, this.sizeButton);
	}

	private openNumberMenu(): void {
		this.closePalette();
		const refs = this.targetRefs();
		const current = refs[0] ? this.getEngine()?.getStyleAt(refs[0]).nf : undefined;
		const menu = new Menu();
		NUMBER_FORMATS.forEach(({ mask, label }, i) => {
			if (i === 1 || i === 5 || i === 8) menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle(t(label))
					.setChecked(mask === null ? current === undefined : current === mask)
					.onClick(() => this.applyNumberFormat(mask)),
			);
		});
		this.showMenuUnder(menu, this.numberButton);
	}

	/**
	 * One menu for both axes: horizontal on top, vertical below the separator.
	 * Two buttons would cost 28 px of a toolbar that has to fit a phone.
	 */
	private openAlignMenu(): void {
		this.closePalette();
		const refs = this.targetRefs();
		const style = refs[0] ? this.getEngine()?.getStyleAt(refs[0]) : undefined;
		const menu = new Menu();
		for (const { value, label, icon } of H_ALIGN_ITEMS) {
			menu.addItem((item) =>
				item
					.setTitle(t(label))
					.setIcon(icon)
					.setChecked(value === null ? style?.ha === undefined : style?.ha === value)
					.onClick(() => this.applyHAlign(value)),
			);
		}
		menu.addSeparator();
		for (const { value, label, icon } of V_ALIGN_ITEMS) {
			menu.addItem((item) =>
				item
					.setTitle(t(label))
					.setIcon(icon)
					.setChecked(value === null ? style?.va === undefined : style?.va === value)
					.onClick(() => this.applyVAlign(value)),
			);
		}
		this.showMenuUnder(menu, this.alignButton);
	}

	private openBorderMenu(): void {
		this.closePalette();
		const menu = new Menu();
		BORDER_ITEMS.forEach(({ value, label, icon }, i) => {
			if (i === 3) menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle(t(label))
					.setIcon(icon)
					.onClick(() => this.applyBorders(value)),
			);
		});
		this.showMenuUnder(menu, this.borderButton);
	}

	/* ---------------------------------------------------------------- sync */

	/** Reflect the selection's current formatting in the controls. */
	sync(): void {
		const engine = this.getEngine();
		const disabled = !engine || engine.isReadOnly;
		for (const el of [
			this.boldButton,
			this.sizeButton,
			this.fillButton,
			this.borderButton,
			this.numberButton,
			this.alignButton,
			this.wrapButton,
			this.mergeButton,
			this.checkboxButton,
			this.sortButton,
			this.filterButton,
			this.freezeButton,
			this.widthButton,
		]) {
			el.toggleAttribute("disabled", disabled);
		}
		// Find works on a read-only sheet: it changes nothing.
		this.findButton.toggleAttribute("disabled", !engine);
		if (!engine) return;

		const view = engine.getView();
		const freeze = engine.getFreeze();
		const col = this.targetColumn();
		this.sortButton.toggleClass("is-active", view.sort?.col === col);
		this.filterButton.toggleClass("is-active", !!view.filters);
		// A filter is the one toolbar state whose EFFECT is invisible (the rows it
		// hides are simply not there), so the button says how many are missing.
		const hidden = view.filters ? engine.filteredOutCount() : 0;
		const filterLabel = hidden > 0
			? `${t("tbFilter")} — ${t("filterHiddenRows", { count: hidden })}`
			: t("tbFilter");
		this.filterButton.setAttribute("title", filterLabel);
		this.filterButton.setAttribute("aria-label", filterLabel);
		this.freezeButton.toggleClass("is-active", !!freeze.rows || !!freeze.cols);

		const refs = this.targetRefs();
		const first = refs[0] ? engine.getStyleAt(refs[0]) : {};
		this.boldButton.toggleClass("is-active", !!first.b);
		this.sizeLabel.setText(first.fs !== undefined ? String(first.fs) : "—");
		this.fillSwatch.style.backgroundColor = first.bg ?? "";
		this.fillSwatch.toggleClass("is-empty", !first.bg);

		// The number button shows the live mask, like the font-size button shows
		// the live size. Long masks would stretch the toolbar, hence the preset
		// label for the ones we know and an ellipsis for anything else.
		const preset = NUMBER_FORMATS.find((p) => p.mask && p.mask === first.nf);
		this.numberLabel.setText(
			first.nf === undefined ? "—" : (preset?.mask ?? first.nf).slice(0, 12),
		);
		this.numberButton.toggleClass("is-active", first.nf !== undefined);

		const alignName =
			first.ha === "c" ? "align-center" : first.ha === "r" ? "align-right" : "align-left";
		this.alignIcon.empty();
		setIcon(this.alignIcon, alignName);
		this.alignButton.toggleClass("is-active", !!first.ha || !!first.va);
		this.wrapButton.toggleClass("is-active", !!first.wrap);

		// The merge button is a toggle in the Google Sheets sense: lit while the
		// selection sits in a merge, in which case pressing it splits it again.
		const anchor = refs[0] ? parseRef(refs[0]) : null;
		const merged = anchor ? !!engine.mergeAt(anchor.row, anchor.col) : false;
		this.mergeButton.toggleClass("is-active", merged);
		const mergeLabel = merged ? t("tbUnmerge") : t("tbMerge");
		this.mergeButton.setAttribute("title", mergeLabel);
		this.mergeButton.setAttribute("aria-label", mergeLabel);
		this.checkboxButton.toggleClass(
			"is-active",
			!!refs[0] && engine.getCellType(refs[0] as string) === "cb",
		);
	}

	destroy(): void {
		document.removeEventListener("mousedown", this.onPointerDown, true);
		document.removeEventListener("keydown", this.onKeyDown, true);
		this.el.detach();
	}
}
