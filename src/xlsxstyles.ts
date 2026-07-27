/**
 * The half of the xlsx bridge that has nothing to do with SheetJS being loaded:
 * mapping our normalized {@link CellStyle} to the style object the writer wants
 * and back, plus the three things SheetJS's community reader THROWS AWAY and we
 * therefore read out of the raw XML ourselves.
 *
 * What the reader loses, measured against `xlsx-js-style@1.2.0` (SheetJS CE
 * 0.18.5 underneath), with `cellStyles: true`:
 *
 *   - the per-cell style index. `parse_ws_xml_data` looks `styles.CellXf[s]` up
 *     to resolve the number format and the FILL, and then puts the fill on the
 *     cell as `.s` - so the cell keeps its fill and loses the pointer to its
 *     font, its border and its alignment.
 *   - the border SIDES. `parse_borders` walks `<border>` and breaks on every
 *     side tag without reading it: `styles.Borders` is an array of empty
 *     objects, one per border, in the right order and with nothing in them.
 *
 * Both are one regex pass over XML we already have in memory (`bookFiles: true`
 * hands over the unzipped parts), which is why this file exists instead of a
 * second spreadsheet library. Fonts, fills, alignment and number formats ARE
 * parsed by SheetJS and are read from `wb.Styles`.
 *
 * Everything here is pure and engine-free, so the round-trip is unit-tested
 * without an Obsidian window.
 */

import {
	type CellStyle,
	MAX_FONT_SIZE,
	MIN_FONT_SIZE,
	normalizeColor,
	normalizeNf,
	normalizeStyle,
} from "./format";

/** A cell style as `xlsx-js-style` wants it on write. */
export interface XlsxCellStyle {
	font?: { bold?: boolean; sz?: number };
	fill?: { patternType: "solid"; fgColor: { rgb: string } };
	border?: Record<string, { style: string; color: { rgb: string } }>;
	alignment?: { horizontal?: string; vertical?: string; wrapText?: boolean };
	numFmt?: string;
}

/** Our side letters, in the order the OOXML `<border>` element lists them. */
const SIDE_TAGS: [side: string, tag: string][] = [
	["l", "left"],
	["r", "right"],
	["t", "top"],
	["b", "bottom"],
];

const H_ALIGN_OUT: Record<string, string> = { l: "left", c: "center", r: "right" };
const V_ALIGN_OUT: Record<string, string> = { t: "top", m: "center", b: "bottom" };
const H_ALIGN_IN: Record<string, CellStyle["ha"]> = { left: "l", center: "c", right: "r" };
const V_ALIGN_IN: Record<string, CellStyle["va"]> = {
	top: "t",
	center: "m",
	middle: "m",
	bottom: "b",
};

/** Excel measures type in points, the grid and the file in pixels. */
export function pxToPt(px: number): number {
	return Math.round(px * 0.75 * 100) / 100;
}

export function ptToPx(pt: number): number {
	return Math.round(pt / 0.75);
}

/** "#fff2cc" -> "FFFFF2CC" (Excel wants ARGB, alpha first). */
export function hexToArgb(hex: string): string {
	return `FF${hex.slice(1).toUpperCase()}`;
}

/** "FFFFF2CC" or "FFF2CC" -> "#fff2cc"; anything else -> undefined. */
export function argbToHex(argb: unknown): string | undefined {
	if (typeof argb !== "string") return undefined;
	const s = argb.trim();
	if (/^[0-9a-fA-F]{8}$/.test(s)) return normalizeColor(`#${s.slice(2)}`);
	if (/^[0-9a-fA-F]{6}$/.test(s)) return normalizeColor(`#${s}`);
	return undefined;
}

/** Normalized style -> the writer's style object. Empty style -> undefined. */
export function styleToXlsx(style: CellStyle | undefined): XlsxCellStyle | undefined {
	const s = normalizeStyle(style);
	if (!s) return undefined;
	const out: XlsxCellStyle = {};
	if (s.b || s.fs !== undefined) {
		out.font = {};
		if (s.b) out.font.bold = true;
		if (s.fs !== undefined) out.font.sz = pxToPt(s.fs);
	}
	if (s.bg) {
		out.fill = { patternType: "solid", fgColor: { rgb: hexToArgb(s.bg) } };
	}
	if (s.bd) {
		const border: XlsxCellStyle["border"] = {};
		for (const [side, tag] of SIDE_TAGS) {
			if (s.bd.includes(side)) border[tag] = { style: "thin", color: { rgb: "FF000000" } };
		}
		out.border = border;
	}
	if (s.ha || s.va || s.wrap) {
		out.alignment = {};
		if (s.ha) out.alignment.horizontal = H_ALIGN_OUT[s.ha];
		if (s.va) out.alignment.vertical = V_ALIGN_OUT[s.va];
		if (s.wrap) out.alignment.wrapText = true;
	}
	if (s.nf) out.numFmt = s.nf;
	return Object.keys(out).length > 0 ? out : undefined;
}

/** The pieces of an xlsx style, as they come out of `wb.Styles` and the XML. */
export interface XlsxStyleParts {
	bold?: boolean;
	/** Font size in POINTS, as the file stores it. */
	sz?: number;
	/** Fill colour as ARGB or RGB hex, from `Fills[fillId].fgColor.rgb`. */
	fgColor?: unknown;
	/** Border sides in our own `trbl` alphabet, from {@link parseBorderSides}. */
	sides?: string;
	alignment?: { horizontal?: unknown; vertical?: unknown; wrapText?: unknown };
	/** Number format string, i.e. the cell's `z`. */
	numFmt?: unknown;
}

/**
 * xlsx style pieces -> our normalized style.
 *
 * Excel's "General" is the absence of a format, not a format, so it never
 * becomes an `nf`; a font size only survives when it lands inside the range the
 * format allows, and a pattern fill without a colour is not a fill.
 */
export function xlsxToStyle(parts: XlsxStyleParts): CellStyle | undefined {
	const out: CellStyle = {};
	if (parts.bold) out.b = true;
	if (typeof parts.sz === "number" && Number.isFinite(parts.sz)) {
		const px = ptToPx(parts.sz);
		if (px >= MIN_FONT_SIZE && px <= MAX_FONT_SIZE) out.fs = px;
	}
	const bg = argbToHex(parts.fgColor);
	if (bg) out.bg = bg;
	if (parts.sides) out.bd = parts.sides;
	const align = parts.alignment ?? {};
	if (typeof align.horizontal === "string") {
		const ha = H_ALIGN_IN[align.horizontal.trim().toLowerCase()];
		if (ha) out.ha = ha;
	}
	if (typeof align.vertical === "string") {
		const va = V_ALIGN_IN[align.vertical.trim().toLowerCase()];
		if (va) out.va = va;
	}
	if (align.wrapText === true || align.wrapText === 1 || align.wrapText === "1") out.wrap = true;
	if (typeof parts.numFmt === "string" && parts.numFmt.trim().toLowerCase() !== "general") {
		const nf = normalizeNf(parts.numFmt);
		if (nf) out.nf = nf;
	}
	return normalizeStyle(out);
}

/* ------------------------------------------------------------- raw XML */

/**
 * `<c r="A1" s="3" .../>` -> `{ A1: 3 }`, i.e. the style index SheetJS drops.
 *
 * A regex rather than a parser on purpose: the shape is fixed by the spec
 * (`r` and `s` are attributes of `c`, in any order, always quoted), the input is
 * a file we just unzipped ourselves, and pulling a real XML parser into the
 * bundle for two attributes would cost more than the feature.
 */
export function parseCellXfIndexes(sheetXml: string): Record<string, number> {
	const out: Record<string, number> = {};
	if (typeof sheetXml !== "string") return out;
	const cells = sheetXml.match(/<c\b[^>]*>/g);
	if (!cells) return out;
	for (const tag of cells) {
		const ref = /\br="([A-Z]+[0-9]+)"/.exec(tag);
		const xf = /\bs="([0-9]+)"/.exec(tag);
		if (!ref || !xf) continue;
		const n = Number.parseInt(xf[1] as string, 10);
		if (Number.isFinite(n)) out[ref[1] as string] = n;
	}
	return out;
}

/**
 * The `<borders>` table as our `trbl` letters, one string per border index.
 *
 * A side counts only when it has a `style` that is not `none`: an empty
 * `<left/>` is Excel's way of saying "no left border", and it is written by
 * every producer for every cell.
 */
export function parseBorderSides(stylesXml: string): string[] {
	if (typeof stylesXml !== "string") return [];
	const block = /<borders\b[^>]*>([\s\S]*?)<\/borders>/.exec(stylesXml);
	if (!block || !block[1]) return [];
	const out: string[] = [];
	// `<border/>` (self-closing, no sides) has to count as an entry too, or every
	// index after it points at the wrong border.
	const entries = block[1].match(/<border\b[^>]*\/>|<border\b[^>]*>[\s\S]*?<\/border>/g) ?? [];
	for (const entry of entries) {
		let sides = "";
		for (const side of "trbl") {
			const tag = SIDE_TAGS.find(([s]) => s === side)?.[1];
			if (!tag) continue;
			const re = new RegExp(`<${tag}\\b([^>]*)(?:/>|>)`);
			const m = re.exec(entry);
			if (!m) continue;
			const style = /\bstyle="([^"]*)"/.exec(m[1] ?? "");
			if (style && style[1] && style[1].toLowerCase() !== "none") sides += side;
		}
		out.push(sides);
	}
	return out;
}

/**
 * Worksheet name -> the part that holds it, e.g. `xl/worksheets/sheet2.xml`.
 *
 * `wb.SheetNames[i]` and the `sheetN.xml` numbering agree in practice and are
 * not required to: the order is `xl/workbook.xml`'s, the file name comes from a
 * relationship id. Both files are in `wb.files`, so the mapping is read rather
 * than guessed, and the caller falls back to the positional guess when a
 * producer surprises us.
 */
export function parseSheetPaths(
	workbookXml: string,
	relsXml: string,
): Record<string, string> {
	const out: Record<string, string> = {};
	if (typeof workbookXml !== "string" || typeof relsXml !== "string") return out;
	const targets: Record<string, string> = {};
	for (const tag of relsXml.match(/<Relationship\b[^>]*>/g) ?? []) {
		const id = /\bId="([^"]+)"/.exec(tag);
		const target = /\bTarget="([^"]+)"/.exec(tag);
		if (!id || !target) continue;
		let path = (target[1] as string).replace(/^\/?xl\//, "").replace(/^\//, "");
		if (!path.startsWith("worksheets/")) continue;
		path = `xl/${path}`;
		targets[id[1] as string] = path;
	}
	for (const tag of workbookXml.match(/<sheet\b[^>]*>/g) ?? []) {
		const name = /\bname="([^"]*)"/.exec(tag);
		const rid = /\br:id="([^"]+)"/.exec(tag) ?? /\bid="([^"]+)"/.exec(tag);
		if (!name || !rid) continue;
		const path = targets[rid[1] as string];
		if (path) out[unescapeXml(name[1] as string)] = path;
	}
	return out;
}

/** The five XML entities a sheet name can carry. */
export function unescapeXml(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&amp;/g, "&");
}
