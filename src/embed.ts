/**
 * Sheets embedded in Markdown notes.
 *
 *     ![[Budget.sheet]]                     first worksheet, its used range
 *     ![[Budget.sheet#Sheet2]]              a named worksheet
 *     ![[Budget.sheet#Sheet2!A1:D20]]       a range of it
 *     ![[Budget.sheet|plain]]               no headers, no chrome, no background
 *
 *     ```sheet
 *     Budget.sheet#Sheet2!A1:D20
 *     ```
 *
 * How it hooks in: Obsidian has no embed renderer for `.sheet`, so it draws its
 * generic "file card" placeholder and leaves the element in the DOM with the
 * link in `src`. A Markdown post-processor finds those, empties them and mounts
 * a READ-ONLY grid instead. The instance is owned by a MarkdownRenderChild, so
 * closing the note, folding the section or re-rendering the note destroys it;
 * without that ownership every scroll would leak a spreadsheet.
 *
 * Read-only is not a policy decision, it is the honest one: an embed has no
 * formula bar, no toolbar and no save path, and a grid that accepts keystrokes
 * it then throws away is worse than one that does not.
 */

import {
	type App,
	MarkdownRenderChild,
	type MarkdownPostProcessorContext,
	Plugin,
	TFile,
	debounce,
	setIcon,
} from "obsidian";
import { SheetEngine } from "./engine";
import { type CsvDelimiter, csvToDoc } from "./csv";
import {
	EMBEDDABLE,
	type EmbedRef,
	embedLabel,
	isPlainOption,
	isSheetLink,
	parseEmbedBlock,
	parseEmbedRef,
} from "./embedsrc";
import { JSON_EXTENSIONS } from "./view";
import { type SheetDoc, type SheetPage, newSheetDoc, parseSheet } from "./format";
import { t } from "./i18n";

export const EMBED_CLASS = "leovale-sheet-embed";
/** Re-render at most this often while the source file is being edited. */
const REFRESH_DEBOUNCE_MS = 400;
/** Grace period for live preview to attach the element and its attributes. */
const PLAIN_RECHECK_MS = 150;

/** Pick the worksheet a reference asks for: by name, else the first one. */
export function pickPage(doc: SheetDoc, name?: string): SheetPage | null {
	if (doc.sheets.length === 0) return null;
	if (!name) return doc.sheets[0] ?? null;
	const wanted = name.trim().toLowerCase();
	return (
		doc.sheets.find((s) => s.name.trim().toLowerCase() === wanted) ?? doc.sheets[0] ?? null
	);
}

/**
 * One embedded grid: reads the file, mounts the engine, re-reads on change.
 *
 * `MarkdownRenderChild.onunload` is the only teardown hook Obsidian gives here,
 * and it is enough: `registerEvent` on the child unsubscribes with it.
 */
export class SheetEmbed extends MarkdownRenderChild {
	private app: App;
	private ref: EmbedRef;
	private engine: SheetEngine | null = null;
	private body: HTMLElement | null = null;
	private delimiter: CsvDelimiter | null = null;
	private plainRechecked = false;

	constructor(container: HTMLElement, app: App, ref: EmbedRef) {
		super(container);
		this.app = app;
		this.ref = ref;
	}

	onload(): void {
		this.containerEl.addClass(EMBED_CLASS);
		this.containerEl.toggleClass("is-plain", this.ref.plain);
		this.containerEl.empty();
		void this.render();

		const refresh = debounce(() => void this.render(), REFRESH_DEBOUNCE_MS, true);
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile && file.path === this.resolvedPath()) refresh();
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (oldPath === this.resolvedPath() || (file instanceof TFile && file.path === this.resolvedPath())) {
					refresh();
				}
			}),
		);
		// No theme hook on purpose. Every colour in the grid comes from an Obsidian
		// CSS variable, so a theme switch needs nothing from us, and that is
		// measured rather than assumed (the e2e reads the computed colours of an
		// embedded cell in the dark theme). A rebuild on `css-change` was tried and
		// removed: it changed nothing observable.
	}

	onunload(): void {
		this.teardown();
		this.containerEl.empty();
	}

	private teardown(): void {
		if (!this.engine) return;
		try {
			this.engine.destroy();
		} catch (e) {
			console.error("leovale-sheets: embed teardown failed", e);
		}
		this.engine = null;
	}

	private file(): TFile | null {
		const dest = this.app.metadataCache.getFirstLinkpathDest(this.ref.path, "");
		return dest instanceof TFile ? dest : null;
	}

	private resolvedPath(): string | null {
		return this.file()?.path ?? null;
	}

	private fail(message: string): void {
		this.teardown();
		this.containerEl.empty();
		this.containerEl.createDiv({ cls: "leovale-sheet-embed-error", text: message });
	}

	/**
	 * Re-read the display option off the element. Returns true if it changed.
	 *
	 * In live preview the embed element is built DETACHED and gets its `src`/`alt`
	 * attributes when CodeMirror inserts it, which is after it has asked us for a
	 * component and after our first render. So `|plain` cannot be read once and
	 * for all: it is re-checked after the file read, and once more on a timer for
	 * the case where even that was too early. Verified failure: the option was
	 * honoured in reading view and silently ignored in live preview.
	 */
	private refreshPlain(): boolean {
		const before = this.ref.plain;
		if (!this.ref.plain && isPlainOption(this.containerEl.getAttribute("alt"))) {
			this.ref.plain = true;
		}
		this.containerEl.toggleClass("is-plain", this.ref.plain);
		return this.ref.plain !== before;
	}

	/** One deferred re-check of the display option, at most once per embed. */
	private schedulePlainRecheck(): void {
		if (this.ref.plain || this.plainRechecked) return;
		this.plainRechecked = true;
		window.setTimeout(() => {
			if (this.refreshPlain()) void this.render();
		}, PLAIN_RECHECK_MS);
	}

	/** (Re)build the whole embed from the file on disk. */
	async render(): Promise<void> {
		this.refreshPlain();
		const file = this.file();
		if (!file) {
			this.fail(t("embedMissing", { path: this.ref.path }));
			return;
		}

		let doc: SheetDoc;
		try {
			const text = await this.app.vault.cachedRead(file);
			if (JSON_EXTENSIONS.includes(file.extension.toLowerCase())) {
				doc = text.trim().length > 0 ? parseSheet(text) : newSheetDoc();
				this.delimiter = null;
			} else {
				const parsed = csvToDoc(text);
				doc = parsed.doc;
				this.delimiter = parsed.delimiter;
			}
		} catch (e) {
			this.fail(t("embedBroken", { message: (e as Error).message }));
			return;
		}

		const page = pickPage(doc, this.ref.sheet);
		if (!page) {
			this.fail(t("embedNoSheet", { name: this.ref.sheet ?? "" }));
			return;
		}

		// The attributes have almost certainly landed by now (there was an await in
		// between); the timer covers the case where they have not.
		this.refreshPlain();
		this.schedulePlainRecheck();

		this.teardown();
		this.containerEl.empty();
		if (!this.ref.plain) this.buildHeader(file, page.name);
		this.body = this.containerEl.createDiv({ cls: "leovale-sheet-embed-body" });

		try {
			this.engine = new SheetEngine(
				this.body,
				{ format: doc.format, version: doc.version, sheets: [page] },
				{ onChange: () => undefined, readOnly: true },
			);
		} catch (e) {
			console.error("leovale-sheets: embed engine failed", e);
			this.fail(t("engineFailed", { message: (e as Error).message }));
			return;
		}

		// No explicit range: show what is filled in, not 100 empty rows.
		this.engine.cropTo(this.ref.range ?? this.engine.usedRange());
	}

	/** Title strip: the file, the sheet, the range; a click opens the file. */
	private buildHeader(file: TFile, sheetName: string): void {
		const header = this.containerEl.createDiv({ cls: "leovale-sheet-embed-header" });
		setIcon(header.createSpan({ cls: "leovale-sheet-embed-icon" }), "table");
		header.createSpan({
			cls: "leovale-sheet-embed-title",
			text: embedLabel({ ...this.ref, sheet: this.ref.sheet ?? sheetName }, file.basename),
		});
		if (this.delimiter) {
			header.createSpan({ cls: "leovale-sheet-embed-badge", text: `CSV ${this.delimiter}` });
		}
		const open = header.createEl("button", {
			cls: "leovale-sheet-embed-open",
			attr: { type: "button", title: t("embedOpen"), "aria-label": t("embedOpen") },
		});
		setIcon(open, "arrow-up-right");
		const openFile = (event: MouseEvent) => {
			event.preventDefault();
			event.stopPropagation();
			void this.app.workspace.getLeaf("tab").openFile(file);
		};
		open.addEventListener("click", openFile);
		header.addEventListener("click", openFile);
	}
}

/**
 * The context Obsidian hands an embed creator. Undocumented in the public
 * typings, hence the local shape; every field is read defensively.
 */
interface EmbedContext {
	app: App;
	containerEl: HTMLElement;
	linktext?: string;
	displayText?: string;
	depth?: number;
}

/**
 * Take over `.sheet` embeds in LIVE PREVIEW as well as reading view.
 *
 * A Markdown post-processor is not enough: in live preview an `![[...]]` is a
 * CodeMirror widget rendered by Obsidian's own embed machinery, which never
 * routes through the post-processor pipeline. Measured consequence: the grid
 * appeared in reading view while the editing mode still showed Obsidian's
 * generic "file card" placeholder. The embed registry is what that machinery
 * looks in, for both modes.
 *
 * `app.embedRegistry` is not part of the public API, so absolutely everything
 * here is guarded: if the shape ever changes we lose live-preview embeds and
 * keep the post-processor, rather than failing to load the plugin.
 */
function registerEmbedCreator(plugin: Plugin): boolean {
	const registry = (plugin.app as unknown as {
		embedRegistry?: {
			registerExtensions?: (exts: string[], creator: unknown) => void;
			unregisterExtensions?: (exts: string[]) => void;
		};
	}).embedRegistry;
	if (!registry?.registerExtensions || !registry.unregisterExtensions) return false;

	const creator = (ctx: EmbedContext, file: TFile, subpath?: string) => {
		const container = ctx.containerEl;
		container.addClass(EMBED_CLASS);
		// The widget has already put the link on the element; the alias (`|plain`)
		// only exists there, not in the context.
		const src = `${file.path}${subpath ?? container.getAttribute("src")?.split("#")[1] ?? ""}`;
		const alt = ctx.displayText ?? container.getAttribute("alt") ?? "";
		const ref = parseEmbedRef(src.includes("#") ? src : `${file.path}${subpath ?? ""}`, alt) ?? {
			path: file.path,
			plain: false,
		};
		const child = new SheetEmbed(container, ctx.app ?? plugin.app, ref);
		// EmbedComponent: a Component with loadFile(). MarkdownRenderChild is one,
		// so only loadFile has to be added, and rendering is idempotent.
		return Object.assign(child, { loadFile: async () => child.render() });
	};

	try {
		registry.registerExtensions(EMBEDDABLE, creator);
		plugin.register(() => {
			try {
				registry.unregisterExtensions?.(EMBEDDABLE);
			} catch (e) {
				console.warn("leovale-sheets: could not release the embed extensions", e);
			}
		});
		return true;
	} catch (e) {
		console.warn("leovale-sheets: no live-preview embeds (embed registry rejected us)", e);
		return false;
	}
}

/**
 * Register every entry point on the plugin.
 *
 * Three of them, deliberately: the embed registry covers live preview and
 * reading view; the post-processor is the fallback for anything the registry
 * does not claim (and for older Obsidian builds); the code block processor is
 * the escape hatch for people who want the reference visible in the source, and
 * for embedding a range without an unwieldy wikilink.
 */
export function registerSheetEmbeds(plugin: Plugin): void {
	registerEmbedCreator(plugin);
	plugin.registerMarkdownPostProcessor((el, ctx: MarkdownPostProcessorContext) => {
		const embeds = el.querySelectorAll<HTMLElement>(".internal-embed[src]");
		embeds.forEach((node) => {
			const src = node.getAttribute("src");
			if (!isSheetLink(src)) return;
			// Already ours (post-processors can run twice over the same element).
			if (node.hasClass(EMBED_CLASS)) return;
			const ref = parseEmbedRef(src, node.getAttribute("alt"));
			if (!ref) return;
			// Obsidian's generic file card is in there; it is not what was asked for.
			node.empty();
			node.removeClass("mod-generic");
			node.removeClass("file-embed");
			ctx.addChild(new SheetEmbed(node, plugin.app, ref));
		});
	});

	plugin.registerMarkdownCodeBlockProcessor("sheet", (source, el, ctx) => {
		const ref = parseEmbedBlock(source);
		const host = el.createDiv();
		if (!ref) {
			host.addClass(EMBED_CLASS);
			host.createDiv({ cls: "leovale-sheet-embed-error", text: t("embedBadBlock") });
			return;
		}
		ctx.addChild(new SheetEmbed(host, plugin.app, ref));
	});
}
