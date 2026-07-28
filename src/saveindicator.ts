/**
 * The save indicator: the little line of text on the right of the formula bar
 * that says whether what is on screen is also on disk.
 *
 * WHY IT EXISTS. This plugin autosaves - there is no Ctrl+S ritual and no
 * "unsaved" dot in the tab, because a spreadsheet in a vault is a file that
 * writes itself 1.5 s after the last keystroke. That is comfortable right up to
 * the moment something goes wrong, and until this release the answer to "did
 * that get saved?" was "look in the developer console": a failed write logged
 * there and NOWHERE else. The states below are the Google Docs ones, for the
 * same reason Google has them.
 *
 *     Unsaved changes...  -> Saving...  -> Saved just now  -> Saved at 14:03
 *                                       \-> Save failed (red, click for details)
 *
 * The failure state is sticky: it stays until the next successful save, and a
 * click on it opens the notice with the actual error. Everything else fades
 * into "Saved at HH:MM" after a minute, which is the honest thing to show for a
 * file nobody has touched in a while.
 *
 * Deliberately NOT in embeds: an embedded grid is read-only, has no save path
 * at all and no formula bar to put this in.
 */

import { t } from "./i18n";

export type SaveStateName = "idle" | "dirty" | "saving" | "saved" | "error";

export interface SaveStatus {
	name: SaveStateName;
	/** When the last successful save landed, for the "Saved at HH:MM" state. */
	at?: number;
	/** The failure, shown in a notice when the red state is clicked. */
	message?: string;
}

/** How long a save counts as "just now" before the clock time is shown. */
export const SAVED_RECENT_MS = 60_000;

/**
 * "HH:MM" in 24-hour form, from the local clock.
 *
 * Hand-rolled rather than `toLocaleTimeString`: that would give "2:03 PM" in an
 * English locale, and this string sits in a 30 px strip next to a formula. The
 * padding is also what makes the e2e able to assert on it.
 */
export function clockTime(at: number): string {
	const date = new Date(at);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** The text for a state, at a given moment. Pure, so the e2e can pin it down. */
export function indicatorText(status: SaveStatus, now: number = Date.now()): string {
	switch (status.name) {
		case "dirty":
			return t("saveDirty");
		case "saving":
			return t("saveSaving");
		case "saved":
			if (status.at === undefined) return t("saveJustNow");
			return now - status.at < SAVED_RECENT_MS
				? t("saveJustNow")
				: t("saveAt", { time: clockTime(status.at) });
		case "error":
			return t("saveFailedShort");
		default:
			return "";
	}
}

export class SheetSaveIndicator {
	private el: HTMLElement;
	private status: SaveStatus = { name: "idle" };
	/** Fires once, when "just now" has to become a clock time. */
	private timer: number | null = null;
	private onErrorClick: (message: string) => void;

	constructor(parent: HTMLElement, onErrorClick: (message: string) => void) {
		this.onErrorClick = onErrorClick;
		this.el = parent.createDiv({ cls: "leovale-sheet-save-state" });
		this.el.addEventListener("click", () => {
			if (this.status.name === "error") this.onErrorClick(this.status.message ?? "");
		});
		this.render();
	}

	/** The current state, so a view can restore it after remounting its chrome. */
	current(): SaveStatus {
		return this.status;
	}

	set(status: SaveStatus): void {
		this.status = status;
		this.render();
	}

	private render(): void {
		this.clearTimer();
		const { name } = this.status;
		this.el.setText(indicatorText(this.status));
		this.el.toggleClass("is-error", name === "error");
		this.el.toggleClass("is-busy", name === "saving" || name === "dirty");
		this.el.toggleClass("is-idle", name === "idle" || name === "saved");
		this.el.toggleClass("is-hidden", name === "idle");
		if (name === "error") {
			this.el.setAttribute("title", this.status.message ?? t("saveFailedShort"));
			this.el.setAttribute("role", "button");
			this.el.setAttribute("tabindex", "0");
		} else {
			this.el.removeAttribute("title");
			this.el.removeAttribute("role");
			this.el.removeAttribute("tabindex");
		}

		// One timer, armed only in the state that ages: "Saved just now" has to
		// become "Saved at HH:MM" on its own, or a sheet left open overnight would
		// still claim it was saved a moment ago.
		if (name === "saved" && this.status.at !== undefined) {
			const left = this.status.at + SAVED_RECENT_MS - Date.now();
			if (left > 0) this.timer = window.setTimeout(() => this.render(), left + 50);
		}
	}

	private clearTimer(): void {
		if (this.timer !== null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
	}

	destroy(): void {
		this.clearTimer();
		this.el.detach();
	}
}
