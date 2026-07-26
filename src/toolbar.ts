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
import { type CellStyle, MAX_FONT_SIZE, MIN_FONT_SIZE, parseRef } from "./format";
import { type StringKey, t } from "./i18n";

export const FONT_SIZES = [10, 12, 14, 16, 18, 24];

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
	private onPointerDown: (e: MouseEvent) => void;
	/** Selection snapshot taken before a toolbar click can clear the grid's own. */
	private pendingRefs: string[] = [];

	constructor(parent: HTMLElement, getEngine: () => SheetEngine | null) {
		this.getEngine = getEngine;
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

	/** Anchor a native Obsidian menu just under a toolbar button. */
	private showMenuUnder(menu: Menu, button: HTMLElement): void {
		const rect = button.getBoundingClientRect();
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
		for (const el of [this.boldButton, this.sizeButton, this.fillButton, this.borderButton]) {
			el.toggleAttribute("disabled", disabled);
		}
		if (!engine) return;

		const refs = this.targetRefs();
		const first = refs[0] ? engine.getStyleAt(refs[0]) : {};
		this.boldButton.toggleClass("is-active", !!first.b);
		this.sizeLabel.setText(first.fs !== undefined ? String(first.fs) : "—");
		this.fillSwatch.style.backgroundColor = first.bg ?? "";
		this.fillSwatch.toggleClass("is-empty", !first.bg);
	}

	destroy(): void {
		document.removeEventListener("mousedown", this.onPointerDown, true);
		this.el.detach();
	}
}
