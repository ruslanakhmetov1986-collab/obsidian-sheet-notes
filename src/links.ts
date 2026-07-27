/**
 * `[[wiki links]]` inside a cell.
 *
 * The FILE never changes: a link is an ordinary string value, exactly as typed,
 * and this module only says where the links are inside it. The rendering (a real
 * `<a>`, built with DOM calls so a value like `<script>` stays a value) and the
 * click and hover behaviour live in the engine, which is also the only place
 * that knows whether the cell is being edited - while it is, the raw text is
 * what has to be on screen.
 *
 * The syntax understood is Obsidian's own, minus the parts a cell cannot use:
 *
 *     [[Note]]              -> target "Note",         shown "Note"
 *     [[Note|Alias]]        -> target "Note",         shown "Alias"
 *     [[Note#Heading]]      -> target "Note#Heading", shown "Note > Heading"
 *     [[Note#^block|x]]     -> target "Note#^block",  shown "x"
 *
 * `![[embed]]` is deliberately NOT a link: an embed inside a spreadsheet cell
 * would mean rendering a note inside a table cell, and the `!` stays part of the
 * text so nothing pretends otherwise.
 */

export interface CellLink {
	/** What `openLinkText` and `hover-link` get: path, heading and block id. */
	target: string;
	/** What the cell shows. */
	display: string;
}

export type CellSegment = { kind: "text"; text: string } | { kind: "link"; link: CellLink };

/** Cheap pre-filter: no `[[` means no work for anybody. */
export function hasWikiLink(text: unknown): boolean {
	return typeof text === "string" && text.includes("[[");
}

/**
 * The display text of a link with no alias: `Note#Heading` reads as
 * `Note > Heading`, which is what Obsidian shows in its own link previews.
 */
export function linkDisplay(target: string): string {
	const hash = target.indexOf("#");
	if (hash < 0) return target;
	const path = target.slice(0, hash);
	const rest = target.slice(hash + 1).replace(/^\^/, "");
	if (rest.length === 0) return path;
	return path.length > 0 ? `${path} > ${rest}` : rest;
}

/**
 * Split a cell value into text and links.
 *
 * Returns an EMPTY array when there is no link at all, so the caller can leave
 * the engine's own rendering alone rather than rebuild an identical cell.
 */
export function parseCellLinks(text: unknown): CellSegment[] {
	if (typeof text !== "string" || !text.includes("[[")) return [];
	const segments: CellSegment[] = [];
	let plain = "";
	let i = 0;
	let found = false;

	while (i < text.length) {
		const open = text.indexOf("[[", i);
		if (open < 0) break;
		const close = text.indexOf("]]", open + 2);
		if (close < 0) break;
		const inner = text.slice(open + 2, close);
		// A nested `[[` means the outer one was never a link: re-scan from the
		// inner one instead of swallowing it.
		if (inner.includes("[[")) {
			plain += text.slice(i, open + 2);
			i = open + 2;
			continue;
		}
		const embed = open > 0 && text[open - 1] === "!";
		const pipe = inner.indexOf("|");
		const target = (pipe < 0 ? inner : inner.slice(0, pipe)).trim();
		const alias = pipe < 0 ? "" : inner.slice(pipe + 1).trim();
		if (embed || target.length === 0) {
			plain += text.slice(i, close + 2);
			i = close + 2;
			continue;
		}
		plain += text.slice(i, open);
		if (plain.length > 0) {
			segments.push({ kind: "text", text: plain });
			plain = "";
		}
		segments.push({
			kind: "link",
			link: { target, display: alias.length > 0 ? alias : linkDisplay(target) },
		});
		found = true;
		i = close + 2;
	}

	if (!found) return [];
	plain += text.slice(i);
	if (plain.length > 0) segments.push({ kind: "text", text: plain });
	return segments;
}

/** Every link a cell value holds, in order. */
export function cellLinks(text: unknown): CellLink[] {
	const out: CellLink[] = [];
	for (const segment of parseCellLinks(text)) {
		if (segment.kind === "link") out.push(segment.link);
	}
	return out;
}
