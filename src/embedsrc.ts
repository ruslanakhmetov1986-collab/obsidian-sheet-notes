/**
 * Parsing of embed references. Pure, engine-free and Obsidian-free so it can be
 * unit-tested: `![[Budget.sheet#Sheet2!A1:D20|plain]]` and the `sheet` code
 * block both end up as the same {@link EmbedRef}.
 *
 * What Obsidian hands the post-processor (verified in a sandbox vault, 1.9.x):
 * a `.internal-embed` element whose `src` is the wikilink target INCLUDING the
 * subpath (`Budget.sheet#Sheet2!A1:D20`) and whose `alt` is the display text
 * after the pipe (`plain`), or the path itself when there is no pipe. So the
 * options have to be read from both attributes.
 */

import { colToName, isRef, parseRef } from "./format";

/** Extensions that open in the grid and can therefore be embedded. */
export const EMBEDDABLE = ["sheet", "lsheet", "csv"];

/** Largest addressable cell, mirroring the limits `parseSheet` enforces. */
const MAX_COL = 701;
const MAX_ROW = 99999;

export interface CellRange {
	r1: number;
	c1: number;
	r2: number;
	c2: number;
}

export interface EmbedRef {
	/** Vault path as written in the link, no subpath, no options. */
	path: string;
	/** Worksheet name after `#`, when given. */
	sheet?: string;
	/** Range after `!`, normalized so r1/c1 is the top-left corner. */
	range?: CellRange;
	/** `|plain`: no headers, no chrome, transparent background. */
	plain: boolean;
}

/** True for a link that should render as a grid. */
export function isSheetLink(src: unknown): boolean {
	if (typeof src !== "string") return false;
	const path = src.split("#")[0]?.split("|")[0]?.trim().toLowerCase() ?? "";
	return EMBEDDABLE.some((ext) => path.endsWith(`.${ext}`));
}

/**
 * "A1:D20" or "A1" -> a normalized range; anything else -> undefined.
 *
 * The bounds are what disambiguate `#Sheet2` from a cell reference: "SHEET2" is
 * a syntactically perfect A1 ref for column 8,826,681, so a range has to fit in
 * an addressable grid (the format caps a sheet at 702 columns) to count as one.
 * Without that, embedding a named worksheet cropped the sheet to nothing.
 */
export function parseRange(text: unknown): CellRange | undefined {
	if (typeof text !== "string") return undefined;
	const parts = text.trim().toUpperCase().split(":");
	const a = parts[0]?.trim() ?? "";
	const b = (parts[1] ?? parts[0])?.trim() ?? "";
	if (parts.length > 2 || !isRef(a) || !isRef(b)) return undefined;
	const first = parseRef(a);
	const second = parseRef(b);
	for (const { row, col } of [first, second]) {
		if (col > MAX_COL || row > MAX_ROW) return undefined;
	}
	return {
		r1: Math.min(first.row, second.row),
		c1: Math.min(first.col, second.col),
		r2: Math.max(first.row, second.row),
		c2: Math.max(first.col, second.col),
	};
}

/** Sheet name plus range out of a `#...` subpath: `Sheet2!A1:D20`. */
function parseSubpath(subpath: string): { sheet?: string; range?: CellRange } {
	const raw = subpath.trim();
	if (raw.length === 0) return {};
	const bang = raw.lastIndexOf("!");
	if (bang >= 0) {
		const range = parseRange(raw.slice(bang + 1));
		if (range) {
			const name = raw.slice(0, bang).trim();
			return name.length > 0 ? { sheet: name, range } : { range };
		}
	}
	// No range: either a bare sheet name, or a bare range (`#A1:D20`).
	const range = parseRange(raw);
	if (range) return { range };
	return { sheet: raw };
}

const OPTIONS = new Set(["plain", "bare", "raw"]);

/**
 * True when a display text asks for the chrome-less rendering.
 *
 * Needed on its own because the live-preview widget sets the element's `alt`
 * attribute AFTER asking for an embed component, so the option can only be read
 * once the component renders.
 */
export function isPlainOption(text: unknown): boolean {
	if (typeof text !== "string") return false;
	return text
		.split("|")
		.some((piece) => OPTIONS.has(piece.trim().toLowerCase()));
}

/**
 * Parse a link reference into an {@link EmbedRef}.
 *
 * `src` is the wikilink target with its subpath; `alt` is Obsidian's display
 * text, which is where a `|plain` option ends up. Options are also accepted
 * inside `src` so the code-block form can use one string.
 */
export function parseEmbedRef(src: unknown, alt?: unknown): EmbedRef | null {
	if (typeof src !== "string") return null;
	let text = src.trim();
	if (text.length === 0) return null;

	let plain = false;
	const takeOptions = (s: string): string => {
		const pieces = s.split("|");
		const head = pieces.shift() ?? "";
		for (const piece of pieces) {
			if (OPTIONS.has(piece.trim().toLowerCase())) plain = true;
		}
		return head;
	};

	text = takeOptions(text);
	if (typeof alt === "string" && alt.includes("|")) takeOptions(alt);
	else if (typeof alt === "string" && OPTIONS.has(alt.trim().toLowerCase())) plain = true;

	const hash = text.indexOf("#");
	const path = (hash < 0 ? text : text.slice(0, hash)).trim();
	if (path.length === 0) return null;
	const sub = hash < 0 ? {} : parseSubpath(text.slice(hash + 1));

	return { path, plain, ...sub };
}

/**
 * Parse the body of a ```sheet code block.
 *
 * Two spellings, because both are natural to write:
 *
 *     Notes/Budget.sheet#Sheet2!A1:D20|plain      (one line, like a wikilink)
 *
 *     path: Notes/Budget.sheet                    (keys, any order)
 *     sheet: Sheet2
 *     range: A1:D20
 *     plain: true
 */
export function parseEmbedBlock(source: string): EmbedRef | null {
	const lines = (source ?? "")
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith("#"));
	if (lines.length === 0) return null;

	const keyed: Record<string, string> = {};
	let shorthand = "";
	for (const line of lines) {
		const m = /^(path|file|sheet|range|plain)\s*:\s*(.*)$/i.exec(line);
		if (m) keyed[(m[1] as string).toLowerCase()] = (m[2] as string).trim();
		else if (!shorthand) shorthand = line;
	}

	if (Object.keys(keyed).length === 0) return parseEmbedRef(shorthand);

	const path = keyed["path"] ?? keyed["file"] ?? shorthand;
	if (!path) return null;
	const ref = parseEmbedRef(path);
	if (!ref) return null;
	if (keyed["sheet"]) ref.sheet = keyed["sheet"];
	const range = parseRange(keyed["range"]);
	if (range) ref.range = range;
	// `plain:` with anything but an explicit no means plain.
	if (keyed["plain"] !== undefined) ref.plain = !/^(false|no|0|off)$/i.test(keyed["plain"]);
	return ref;
}

/** Human label for the embed header: `Budget · Sheet2 · A1:D20`. */
export function embedLabel(ref: EmbedRef, basename: string): string {
	const parts = [basename];
	if (ref.sheet) parts.push(ref.sheet);
	if (ref.range) {
		const a = `${colToName(ref.range.c1)}${ref.range.r1 + 1}`;
		const b = `${colToName(ref.range.c2)}${ref.range.r2 + 1}`;
		parts.push(a === b ? a : `${a}:${b}`);
	}
	return parts.join(" · ");
}
