/**
 * In-sheet search: a small find strip between the toolbar and the grid.
 *
 * NOT the engine's own `search: true`. That one renders a vendor input into the
 * grid's chrome, filters the table down to the matching rows (which fights our
 * filters and our row bookkeeping) and drives off `options.pagination`. Here the
 * matching is a pure function over the live values (see `sheetops.findMatches`)
 * and the result is a highlight plus a cursor - the sheet itself is not touched.
 *
 * Every keystroke inside the input is stopped from propagating: the engine's
 * keydown handler lives on `document` and would open an in-cell editor for each
 * letter typed here.
 */

import { setIcon } from "obsidian";
import type { SheetEngine } from "./engine";
import { t } from "./i18n";

export class SheetFind {
	private el: HTMLElement;
	private input: HTMLInputElement;
	private count: HTMLElement;
	private getEngine: () => SheetEngine | null;
	private matches: string[] = [];
	private index = 0;

	constructor(parent: HTMLElement, getEngine: () => SheetEngine | null) {
		this.getEngine = getEngine;
		this.el = parent.createDiv({ cls: "leovale-sheet-find" });

		const icon = this.el.createSpan({ cls: "leovale-sheet-find-icon" });
		setIcon(icon, "search");

		this.input = this.el.createEl("input", {
			cls: "leovale-sheet-find-input",
			attr: {
				type: "text",
				placeholder: t("findPlaceholder"),
				"aria-label": t("findPlaceholder"),
			},
		});
		this.count = this.el.createSpan({ cls: "leovale-sheet-find-count" });

		this.button("chevron-up", t("findPrev"), () => this.step(-1));
		this.button("chevron-down", t("findNext"), () => this.step(1));
		this.button("x", t("findClose"), () => this.close());

		this.input.addEventListener("input", () => this.run());
		this.input.addEventListener("keydown", (e: KeyboardEvent) => {
			// The grid must not see any of this.
			e.stopPropagation();
			if (e.key === "Enter") {
				e.preventDefault();
				this.step(e.shiftKey ? -1 : 1);
			} else if (e.key === "Escape") {
				e.preventDefault();
				this.close();
			}
		});
	}

	private button(icon: string, label: string, onClick: () => void): HTMLButtonElement {
		const button = this.el.createEl("button", {
			cls: "leovale-sheet-find-btn",
			attr: { type: "button", title: label, "aria-label": label },
		});
		setIcon(button, icon);
		button.onclick = onClick;
		return button;
	}

	get isOpen(): boolean {
		return this.el.hasClass("is-open");
	}

	open(): void {
		this.el.addClass("is-open");
		this.input.focus();
		this.input.select();
		if (this.input.value) this.run();
	}

	close(): void {
		this.el.removeClass("is-open");
		this.getEngine()?.clearSearchHighlight();
		this.matches = [];
		this.count.setText("");
	}

	toggle(): void {
		if (this.isOpen) this.close();
		else this.open();
	}

	/** Re-run the search for the current text and jump to the first match. */
	private run(): void {
		const engine = this.getEngine();
		if (!engine) return;
		const query = this.input.value;
		this.matches = query.trim() === "" ? [] : engine.search(query);
		this.index = 0;
		this.render();
		const first = this.matches[0];
		if (first) engine.focusMatch(first);
		else engine.clearSearchHighlight();
	}

	private step(delta: number): void {
		const engine = this.getEngine();
		if (!engine || this.matches.length === 0) return;
		this.index = (this.index + delta + this.matches.length) % this.matches.length;
		this.render();
		const ref = this.matches[this.index];
		if (ref) engine.focusMatch(ref);
	}

	private render(): void {
		if (this.input.value.trim() === "") {
			this.count.setText("");
			return;
		}
		this.count.setText(
			this.matches.length === 0
				? t("findNone")
				: t("findCount", { index: this.index + 1, total: this.matches.length }),
		);
	}

	destroy(): void {
		this.getEngine()?.clearSearchHighlight();
		this.el.detach();
	}
}
