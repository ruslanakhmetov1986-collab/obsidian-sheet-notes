/**
 * The column-width dialog: an exact pixel width for the selected columns, or
 * "fit to content" if the number is the wrong question.
 *
 * A native Obsidian {@link Modal} rather than a popup of our own, so it inherits
 * the theme, the focus trap and the Escape handling. Its input stops its own
 * keydown events: the grid engine listens for keydown on `document` and would
 * happily open an in-cell editor while the user types a width.
 */

import { type App, Modal, Setting } from "obsidian";
import { MAX_COL_WIDTH, MIN_COL_WIDTH } from "./engine";
import { colToName } from "./format";
import { t } from "./i18n";

export interface ColumnWidthOptions {
	/** Column indexes the dialog will resize. */
	columns: number[];
	/** Width to start from, i.e. the current width of the first column. */
	current: number;
	onApply: (width: number) => void;
	onAutofit: () => void;
}

export class ColumnWidthModal extends Modal {
	private opts: ColumnWidthOptions;
	private input!: HTMLInputElement;

	constructor(app: App, opts: ColumnWidthOptions) {
		super(app);
		this.opts = opts;
	}

	override onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText(t("colWidthTitle"));
		contentEl.addClass("leovale-sheet-width-modal");

		const names = this.opts.columns.map((c) => colToName(c)).join(", ");
		contentEl.createDiv({
			cls: "leovale-sheet-width-columns",
			text: t("colWidthColumns", { list: names }),
		});

		new Setting(contentEl).setName(t("colWidthLabel")).addText((text) => {
			this.input = text.inputEl;
			text.inputEl.type = "number";
			text.inputEl.min = String(MIN_COL_WIDTH);
			text.inputEl.max = String(MAX_COL_WIDTH);
			text.setValue(String(Math.round(this.opts.current)));
			// The engine's document-level keydown must not see this typing.
			text.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
				e.stopPropagation();
				if (e.key === "Enter") {
					e.preventDefault();
					this.apply();
				}
			});
		});

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText(t("colWidthAutofit")).onClick(() => {
					this.opts.onAutofit();
					this.close();
				}),
			)
			.addButton((b) => b.setButtonText(t("colWidthCancel")).onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText(t("colWidthApply"))
					.setCta()
					.onClick(() => this.apply()),
			);

		window.setTimeout(() => {
			this.input?.focus();
			this.input?.select();
		}, 0);
	}

	private apply(): void {
		const raw = Number.parseInt(this.input?.value ?? "", 10);
		if (Number.isFinite(raw) && raw > 0) this.opts.onApply(raw);
		this.close();
	}

	override onClose(): void {
		this.contentEl.empty();
	}
}
