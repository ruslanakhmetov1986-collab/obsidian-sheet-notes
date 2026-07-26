/**
 * Formula bar: one line above the toolbar showing the RAW content of the active
 * cell (the formula source, not its result) and committing it back on Enter.
 *
 * Why it exists: the engine's in-cell editor is as wide as the cell, so on a
 * tablet `=SUM(B2:B3)` in a 100 px column shows its tail and nothing else. On
 * mobile this bar is the primary way to edit a formula; on desktop it is the
 * usual spreadsheet convenience (see what a cell really holds).
 *
 * Everything it writes goes through the engine, so autosave is the same path as
 * a normal cell edit. The pure helpers at the top are unit-tested.
 */

import type { SheetEngine } from "./engine";
import { t } from "./i18n";

/** Text to show for a raw cell value. */
export function barText(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
	if (typeof value === "string") return value;
	return String(value);
}

/**
 * Value to hand to the engine for text typed into the bar. The bar is
 * single-line, so any newline that arrives by paste becomes a space instead of
 * silently splitting the cell.
 */
export function barValue(text: string): string {
	return text.replace(/\r\n?/g, "\n").replace(/\n/g, " ");
}

/** "A1" for a single cell, "A1:C3" for a range, "" for no selection. */
export function refLabel(refs: string[]): string {
	if (refs.length === 0) return "";
	const first = refs[0] as string;
	if (refs.length === 1) return first;
	const last = refs[refs.length - 1] as string;
	return first === last ? first : `${first}:${last}`;
}

export interface FormulaBarOptions {
	getEngine: () => SheetEngine | null;
	/** Shown on the right in CSV mode, e.g. `CSV ;` — tells which delimiter is live. */
	badge?: string;
}

export class SheetFormulaBar {
	private el: HTMLElement;
	private refEl: HTMLElement;
	private input: HTMLInputElement;
	private getEngine: () => SheetEngine | null;
	/** Anchor cell of the current selection. */
	private activeRef: string | null = null;
	/**
	 * Cell that was active when the field took focus. A commit ALWAYS targets
	 * this one: clicking straight from the bar into another cell fires the
	 * grid's selection change and our blur in an order we do not control, and
	 * writing the typed text into the newly clicked cell would be data loss.
	 */
	private editingRef: string | null = null;

	constructor(parent: HTMLElement, opts: FormulaBarOptions) {
		this.getEngine = opts.getEngine;
		this.el = parent.createDiv({ cls: "leovale-sheet-formulabar" });
		this.refEl = this.el.createDiv({ cls: "leovale-sheet-fb-ref", text: "" });
		this.input = this.el.createEl("input", {
			cls: "leovale-sheet-fb-input",
			attr: {
				type: "text",
				spellcheck: "false",
				autocomplete: "off",
				placeholder: t("fbPlaceholder"),
				"aria-label": t("fbAria"),
			},
		});
		if (opts.badge) {
			this.el.createDiv({ cls: "leovale-sheet-fb-badge", text: opts.badge });
		}

		this.input.addEventListener("focus", () => {
			this.editingRef = this.activeRef;
		});
		this.input.addEventListener("keydown", (e) => this.onKeyDown(e));
		// Losing focus must not silently discard what was typed.
		this.input.addEventListener("blur", () => {
			this.commit(false);
			this.editingRef = null;
			this.sync(true);
		});
	}

	private onKeyDown(e: KeyboardEvent): void {
		if (e.key === "Enter") {
			e.preventDefault();
			e.stopPropagation();
			this.commit(true);
			return;
		}
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			this.sync(true);
			this.input.blur();
			return;
		}
		// Arrows and Tab inside a text field belong to the text field, not to the
		// grid's document-level key handler.
		e.stopPropagation();
	}

	/** Write the field back into the grid. `explicit` = the user pressed Enter. */
	private commit(explicit: boolean): void {
		const engine = this.getEngine();
		const ref = this.editingRef ?? this.activeRef;
		if (!engine || engine.isReadOnly || !ref) return;
		const next = barValue(this.input.value);
		const current = barText(engine.getRawValue(ref));
		if (next === current) return;
		engine.setRawValue(ref, next);
		// The engine may normalise what it stored (numeric text, formula result);
		// show whatever actually landed in the cell.
		this.sync(true);
		if (explicit) this.input.setSelectionRange(this.input.value.length, this.input.value.length);
	}

	/**
	 * Refresh from the current selection. `force` overwrites the field even while
	 * it has focus; the selection-change path must not clobber active typing.
	 */
	sync(force = false): void {
		const engine = this.getEngine();
		const refs = engine?.getSelectionRefs() ?? [];
		this.activeRef = refs[0] ?? null;
		this.refEl.setText(refLabel(refs));

		const disabled = !engine || engine.isReadOnly || !this.activeRef;
		this.input.toggleAttribute("disabled", disabled);
		if (!force && document.activeElement === this.input) return;
		this.input.value =
			engine && this.activeRef ? barText(engine.getRawValue(this.activeRef)) : "";
	}

	focus(): void {
		this.input.focus();
	}

	destroy(): void {
		this.el.detach();
	}
}
