/**
 * Explicit mapping between our normalized {@link CellStyle} and the inline CSS
 * the grid engine stores per cell. Kept engine-free so it is unit-testable.
 *
 * Every managed property is ALWAYS written, using the grid's own default as the
 * "off" value. `setStyle` merges rather than replaces, so an omitted property
 * would leave a stale declaration behind; and turning a border off has to
 * restore the normal gridline instead of erasing it.
 */

import {
	BORDER_SIDES,
	type CellStyle,
	normalizeColor,
	normalizeSides,
	normalizeStyle,
} from "./format";

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

/** Normalized style -> canonical inline CSS. */
export function styleToCss(style: CellStyle | undefined): string {
	const s = normalizeStyle(style) ?? {};
	const sides = s.bd ?? "";
	const decls = [
		`font-weight: ${s.b ? "bold" : "normal"}`,
		`font-size: ${s.fs !== undefined ? `${s.fs}px` : "inherit"}`,
		`background-color: ${s.bg ?? "transparent"}`,
		`color: ${s.bg ? contrastColor(s.bg) : "inherit"}`,
	];
	for (const side of "tlrb") {
		const def = SIDE_CSS[side];
		if (!def) continue;
		decls.push(`${def.prop}: ${sides.includes(side) ? BORDER_ON : def.off}`);
	}
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
		const value = decl.slice(i + 1).trim();
		if (prop === "font-weight") {
			if (/^(bold|bolder|[6-9]00)$/.test(value)) out.b = true;
		} else if (prop === "font-size") {
			const n = Number.parseFloat(value);
			if (Number.isFinite(n)) out.fs = Math.round(n);
		} else if (prop === "background-color" || prop === "background") {
			const c = normalizeColor(value);
			if (c) out.bg = c;
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
