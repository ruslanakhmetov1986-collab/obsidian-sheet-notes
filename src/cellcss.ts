/**
 * Explicit mapping between our normalized {@link CellStyle} and the inline CSS
 * the grid engine stores per cell. Kept engine-free so it is unit-testable.
 *
 * Every managed property is ALWAYS written, using the grid's own default as the
 * "off" value. `setStyle` merges rather than replaces, so an omitted property
 * would leave a stale declaration behind; and turning a border off has to
 * restore the normal gridline instead of erasing it.
 *
 * WHAT IS NOT HERE: `nf`. A mask can contain `:` and `;` (`yyyy-mm-dd hh:mm`),
 * and the engine's `setStyle` parses the string it is given by splitting on
 * exactly those two characters, so a mask smuggled through CSS would arrive
 * truncated. Masks live in a `data-nf` attribute on the cell instead - which is
 * the same storage class as the inline style, i.e. the engine moves it along
 * when rows or columns are inserted. See `SheetEngine`.
 */

import {
	BORDER_SIDES,
	type CellStyle,
	type HAlign,
	type VAlign,
	normalizeColor,
	normalizeSides,
	normalizeStyle,
} from "./format";
import type { StringKey } from "./i18n";

export const BORDER_ON = "1px solid var(--leovale-sheet-border-strong)";
/** vendor default for top/left */
export const BORDER_GRID = "1px solid var(--background-modifier-border)";
/** vendor default for right/bottom */
export const BORDER_OFF = "1px solid transparent";

const SIDE_CSS: Record<string, { prop: string; off: string }> = {
	t: { prop: "border-top", off: BORDER_GRID },
	l: { prop: "border-left", off: BORDER_GRID },
	r: { prop: "border-right", off: BORDER_OFF },
	b: { prop: "border-bottom", off: BORDER_OFF },
};

/**
 * `ha` -> `text-align`. The off value is `left`, which is also what the engine
 * writes on every cell it creates (`columns[].align`), so "align left" and "no
 * alignment set" are the same thing and `ha: "l"` is never persisted.
 */
export const H_ALIGN_CSS: Record<HAlign, string> = { l: "left", c: "center", r: "right" };

/**
 * `va` -> `vertical-align`. The off value is `inherit`, NOT `middle`: a table
 * cell inherits `middle` from the table anyway, so `inherit` reproduces the
 * default look while leaving `middle` free to mean "the user asked for middle".
 */
export const V_ALIGN_CSS: Record<VAlign, string> = { t: "top", m: "middle", b: "bottom" };

/**
 * `wrap` -> `overflow-wrap`, and that property is the STORAGE for the flag.
 *
 * The obvious property, `white-space`, cannot be: the engine assigns
 * `element.style.whiteSpace` directly on every cell update (`""` normally,
 * `pre-wrap` for content over 200 characters), so it both erases ours and
 * fakes it on long text. `overflow-wrap` is never touched by the engine, and
 * the wrapping itself is done by a stylesheet rule keyed on the class the
 * engine wrapper puts on wrapped cells.
 */
/**
 * What an UNFILLED cell's background is, as a variable rather than the literal
 * `transparent`.
 *
 * Every styled cell carries an explicit `background-color`, because `setStyle`
 * merges and a removed fill has to be actively reset. An inline declaration
 * beats any stylesheet rule, so `transparent` there made it impossible for a
 * frozen row or column to be opaque: the rows scrolling underneath showed
 * through every bold-but-unfilled header cell. Referring to a custom property
 * instead moves the decision back to the stylesheet - a rule can redefine the
 * variable ON the frozen cell, and the inline declaration then resolves to the
 * new value. See `--leovale-sheet-cell-bg` in styles/theme.css.
 */
export const CELL_BG_VAR = "--leovale-sheet-cell-bg";
export const CELL_BG_NONE = `var(${CELL_BG_VAR})`;

export const WRAP_ON = "break-word";
export const WRAP_OFF = "normal";
/** Class the engine adds to a wrapped cell; the theme layer does the wrapping. */
export const WRAP_CLASS = "leovale-sheet-wrap";

/**
 * Text colour for a user-set fill, derived from the fill's relative luminance.
 *
 * A fill is a fixed colour but `--text-normal` is not: in the dark theme it is
 * near-white, so a pale yellow fill would render near-invisible text. This is
 * a RENDER-TIME decision only; nothing about it is persisted.
 */
export function contrastColor(hex: string): string {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	if (![r, g, b].every((n) => Number.isFinite(n))) return "inherit";
	const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
	return lum > 0.5 ? "#1f1f1f" : "#f2f2f2";
}

/**
 * The fill palette, laid out as the 6x2 grid the toolbar draws.
 *
 * It lives here rather than in the toolbar because it is not a piece of chrome:
 * it is the set of colours a cell can actually be painted, and the dark theme's
 * guarantee about them ({@link DARK_FILL_DIM}) is only checkable if the list is
 * reachable from a module with no `obsidian` import.
 */
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

/**
 * How much of the dark theme's background is laid OVER a user fill, as an alpha.
 *
 * The audit's complaint was that the pastel fills "hit you in the eye" against a
 * dark surface, and it is right: the palette was picked on white paper. Nothing
 * about the stored colour changes - a `.sheet` file opened in the light theme
 * still paints `#fff2cc` exactly - only what is drawn on top of it, as one
 * translucent layer in `styles/theme.css`.
 *
 * The number is not a matter of taste. The cell's TEXT colour is chosen from the
 * undimmed fill ({@link contrastColor}), so dimming can only ever reduce the
 * contrast between the two, and 0.28 is the strongest dim under which every
 * colour in {@link FILL_COLORS} still clears WCAG AA (4.5:1) against the ink it
 * was given. The unit tests measure exactly that, so a "slightly darker" edit
 * that breaks readability fails the suite instead of shipping.
 */
export const DARK_FILL_DIM = 0.28;

function channels(hex: string): [number, number, number] | null {
	const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m || !m[1]) return null;
	const n = parseInt(m[1], 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");

/**
 * A fill as it is really PAINTED in the dark theme: the colour with the theme's
 * background composited over it at {@link DARK_FILL_DIM}. `over` defaults to the
 * near-black Obsidian uses for `--background-primary` in its own dark theme.
 */
export function dimmedFill(hex: string, alpha = DARK_FILL_DIM, over = "#1e1e1e"): string {
	const fill = channels(hex);
	const back = channels(over);
	if (!fill || !back) return hex;
	const mix = fill.map((c, i) => c * (1 - alpha) + (back[i] as number) * alpha);
	return `#${mix.map(hex2).join("")}`;
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
	const rgb = channels(hex);
	if (!rgb) return 0;
	const [r, g, b] = rgb.map((c) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two opaque colours, 1..21. */
export function contrastRatio(a: string, b: string): number {
	const la = luminance(a);
	const lb = luminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Does this cell hold a NUMBER, as opposed to text that contains one?
 *
 * The distinction is the whole of the right-alignment rule: `1234` and `-0.5`
 * are numbers and line up on the right with their digits in a column; `Товар 1`
 * and `2 items` are text and stay on the left, where text belongs. The RAW value
 * is what is asked, never the rendered text, so a currency mask showing
 * `1 234,00 ₽` is still a number.
 */
export function looksNumeric(value: unknown): boolean {
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "string") return false;
	const s = value.trim();
	if (s === "") return false;
	return /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s);
}

/** Normalized style -> canonical inline CSS. */
export function styleToCss(style: CellStyle | undefined): string {
	const s = normalizeStyle(style) ?? {};
	const sides = s.bd ?? "";
	const decls = [
		`font-weight: ${s.b ? "bold" : "normal"}`,
		`font-size: ${s.fs !== undefined ? `${s.fs}px` : "inherit"}`,
		`background-color: ${s.bg ?? CELL_BG_NONE}`,
		`color: ${s.bg ? contrastColor(s.bg) : "inherit"}`,
	];
	for (const side of "tlrb") {
		const def = SIDE_CSS[side];
		if (!def) continue;
		decls.push(`${def.prop}: ${sides.includes(side) ? BORDER_ON : def.off}`);
	}
	decls.push(`text-align: ${s.ha ? H_ALIGN_CSS[s.ha] : H_ALIGN_CSS.l}`);
	decls.push(`vertical-align: ${s.va ? V_ALIGN_CSS[s.va] : "inherit"}`);
	decls.push(`overflow-wrap: ${s.wrap ? WRAP_ON : WRAP_OFF}`);
	return decls.join("; ") + ";";
}

/** Canonical inline CSS -> normalized style. Tolerant of extra declarations. */
export function cssToStyle(css: unknown): CellStyle | undefined {
	if (typeof css !== "string" || css.trim() === "") return undefined;
	const out: CellStyle = {};
	let sides = "";
	for (const decl of css.split(";")) {
		const i = decl.indexOf(":");
		if (i < 0) continue;
		const prop = decl.slice(0, i).trim().toLowerCase();
		const value = decl.slice(i + 1).trim().toLowerCase();
		if (prop === "font-weight") {
			if (/^(bold|bolder|[6-9]00)$/.test(value)) out.b = true;
		} else if (prop === "font-size") {
			const n = Number.parseFloat(value);
			if (Number.isFinite(n)) out.fs = Math.round(n);
		} else if (prop === "background-color" || prop === "background") {
			const c = normalizeColor(value);
			if (c) out.bg = c;
		} else if (prop === "text-align") {
			// `left` is the engine's own default on every cell, so it carries no
			// information and must not turn into a persisted `ha`.
			if (value === "center") out.ha = "c";
			else if (value === "right") out.ha = "r";
		} else if (prop === "vertical-align") {
			if (value === "top") out.va = "t";
			else if (value === "middle") out.va = "m";
			else if (value === "bottom") out.va = "b";
		} else if (prop === "overflow-wrap" || prop === "word-wrap") {
			if (value === WRAP_ON) out.wrap = true;
		} else if (prop.startsWith("border-")) {
			const key = prop.slice(7).charAt(0);
			if (BORDER_SIDES.includes(key) && value.includes("--leovale-sheet-border-strong")) {
				sides += key;
			}
		}
	}
	const bd = normalizeSides(sides);
	if (bd) out.bd = bd;
	return normalizeStyle(out);
}
