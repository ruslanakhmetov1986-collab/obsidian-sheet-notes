/**
 * The Version history dialog.
 *
 *     +-------------------------+---------------------------------+
 *     | 14:02  4 KB             |                                 |
 *     | B4, C2 changed          |   read-only grid of that         |
 *     |-------------------------|   version, cropped to its        |
 *     | 13:57  4 KB             |   used range                     |
 *     | Layout changed          |                                 |
 *     +-------------------------+---------------------------------+
 *                                        [ Delete ]  [ Restore ]
 *
 * The preview is the SAME read-only mount an embedded sheet uses (engine with
 * `readOnly: true`, cropped to the used range): one grid implementation, one
 * set of theme rules, and a preview that cannot possibly write anything.
 *
 * Restoring does not write the file from here. It hands the text to the view,
 * which mounts it exactly as if the user had made those changes by hand - so
 * the restore is itself an undo step, and the state it replaced is itself
 * snapshotted by the next save. Nothing in this feature is a one-way door.
 */

import { type App, Modal, Notice, Setting, setIcon } from "obsidian";
import type { BackupStore, VersionMeta, VersionSummary } from "./backups";
import { ConfirmModal } from "./dialogs";
import { SheetEngine } from "./engine";
import { type SheetDoc, parseSheet } from "./format";
import { t } from "./i18n";

/** One line under the timestamp: what that version changed. */
export function summaryText(summary: VersionSummary | undefined): string {
	if (!summary) return t("vhNoChange");
	switch (summary.kind) {
		case "created":
			return t("vhCreated");
		case "layout":
			return t("vhLayout");
		case "cells": {
			const list = summary.cells.join(", ");
			return summary.more > 0
				? t("vhChangedMore", { list, count: summary.more })
				: t("vhChanged", { list });
		}
		default:
			return t("vhNoChange");
	}
}

/** Kilobytes, rounded up, so a 300-byte version does not read as "0 KB". */
export function sizeText(bytes: number): string {
	return t("vhSizeKb", { count: Math.max(1, Math.round(bytes / 1024)) });
}

/** Date and time of a version, in the interface language Obsidian is using. */
export function versionTime(id: number): string {
	const date = new Date(id);
	try {
		return date.toLocaleString(undefined, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	} catch {
		return date.toISOString().slice(0, 16).replace("T", " ");
	}
}

export interface VersionHistoryOptions {
	/** Vault path of the spreadsheet whose history is shown. */
	path: string;
	store: BackupStore;
	/** Put this document back, through the view's normal save path. */
	restore: (text: string) => void;
}

export class VersionHistoryModal extends Modal {
	private opts: VersionHistoryOptions;
	private versions: VersionMeta[] = [];
	private selected: number | null = null;
	private listEl!: HTMLElement;
	private previewEl!: HTMLElement;
	private engine: SheetEngine | null = null;
	private restoreButton: HTMLButtonElement | null = null;
	private deleteButton: HTMLButtonElement | null = null;

	constructor(app: App, opts: VersionHistoryOptions) {
		super(app);
		this.opts = opts;
	}

	override onOpen(): void {
		const { contentEl, titleEl, modalEl } = this;
		titleEl.setText(t("vhTitle"));
		modalEl.addClass("leovale-sheet-vh-modal");
		contentEl.addClass("leovale-sheet-vh");

		const body = contentEl.createDiv({ cls: "leovale-sheet-vh-body" });
		this.listEl = body.createDiv({ cls: "leovale-sheet-vh-list" });
		this.previewEl = body.createDiv({ cls: "leovale-sheet-vh-preview" });
		this.previewEl.createDiv({ cls: "leovale-sheet-vh-hint", text: t("vhPreviewHint") });

		new Setting(contentEl)
			.setClass("leovale-sheet-vh-actions")
			.addButton((b) => {
				this.deleteButton = b.buttonEl;
				b.setButtonText(t("vhDelete")).onClick(() => this.confirmDelete());
			})
			.addButton((b) => {
				this.restoreButton = b.buttonEl;
				b.setButtonText(t("vhRestore"))
					.setCta()
					.onClick(() => void this.restore());
			});
		this.syncButtons();

		void this.refresh();
	}

	/** Re-read the log and rebuild the list, keeping the selection if it lives. */
	private async refresh(): Promise<void> {
		this.versions = await this.opts.store.list(this.opts.path);
		if (this.selected !== null && !this.versions.some((v) => v.id === this.selected)) {
			this.selected = null;
			this.clearPreview();
		}
		this.buildList();
		this.syncButtons();
	}

	private buildList(): void {
		this.listEl.empty();
		if (this.versions.length === 0) {
			this.listEl.createDiv({ cls: "leovale-sheet-vh-empty", text: t("vhEmpty") });
			return;
		}
		this.listEl.createDiv({
			cls: "leovale-sheet-vh-count",
			text: t("vhCount", { count: this.versions.length }),
		});
		for (const meta of this.versions) {
			const row = this.listEl.createDiv({
				cls: "leovale-sheet-vh-item",
				attr: { role: "button", tabindex: "0", "data-id": String(meta.id) },
			});
			row.toggleClass("is-selected", this.selected === meta.id);
			const head = row.createDiv({ cls: "leovale-sheet-vh-item-head" });
			setIcon(head.createSpan({ cls: "leovale-sheet-vh-item-icon" }), "history");
			head.createSpan({ cls: "leovale-sheet-vh-item-time", text: versionTime(meta.id) });
			head.createSpan({ cls: "leovale-sheet-vh-item-size", text: sizeText(meta.size) });
			row.createDiv({
				cls: "leovale-sheet-vh-item-summary",
				text: summaryText(meta.summary),
			});
			row.addEventListener("click", () => void this.select(meta.id));
			row.addEventListener("keydown", (e: KeyboardEvent) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					void this.select(meta.id);
				}
			});
		}
	}

	private syncButtons(): void {
		const none = this.selected === null;
		this.restoreButton?.toggleAttribute("disabled", none);
		this.deleteButton?.toggleAttribute("disabled", none);
	}

	private async select(id: number): Promise<void> {
		this.selected = id;
		const rows = this.listEl.querySelectorAll<HTMLElement>(".leovale-sheet-vh-item");
		for (const row of Array.from(rows)) {
			row.toggleClass("is-selected", row.getAttribute("data-id") === String(id));
		}
		this.syncButtons();
		await this.showPreview(id);
	}

	private clearPreview(): void {
		if (this.engine) {
			try {
				this.engine.destroy();
			} catch (e) {
				console.error("leovale-sheets: version preview teardown failed", e);
			}
			this.engine = null;
		}
		this.previewEl.empty();
	}

	private async showPreview(id: number): Promise<void> {
		let doc: SheetDoc;
		try {
			doc = parseSheet(await this.opts.store.read(this.opts.path, id));
		} catch (e) {
			this.clearPreview();
			this.previewEl.createDiv({
				cls: "leovale-sheet-vh-error",
				text: t("vhReadFailed", { message: (e as Error).message }),
			});
			return;
		}
		this.clearPreview();
		const page = doc.sheets[0];
		if (!page) return;
		try {
			this.engine = new SheetEngine(
				this.previewEl,
				{ format: doc.format, version: doc.version, sheets: [page] },
				{ onChange: () => undefined, readOnly: true },
			);
			this.engine.cropTo(this.engine.usedRange());
		} catch (e) {
			console.error("leovale-sheets: version preview failed", e);
			this.previewEl.createDiv({
				cls: "leovale-sheet-vh-error",
				text: t("engineFailed", { message: (e as Error).message }),
			});
		}
	}

	private async restore(): Promise<void> {
		const id = this.selected;
		if (id === null) return;
		let text: string;
		try {
			text = await this.opts.store.read(this.opts.path, id);
		} catch (e) {
			new Notice(t("vhReadFailed", { message: (e as Error).message }), 8000);
			return;
		}
		this.close();
		this.opts.restore(text);
		new Notice(t("vhRestored", { time: versionTime(id) }));
	}

	private confirmDelete(): void {
		const id = this.selected;
		if (id === null) return;
		new ConfirmModal(this.app, {
			title: t("vhDeleteTitle"),
			body: t("vhDeleteBody", { time: versionTime(id) }),
			confirmText: t("vhDelete"),
			onConfirm: () => {
				void (async () => {
					await this.opts.store.remove(this.opts.path, id);
					new Notice(t("vhDeleted"));
					await this.refresh();
				})();
			},
		}).open();
	}

	override onClose(): void {
		this.clearPreview();
		this.contentEl.empty();
	}
}
