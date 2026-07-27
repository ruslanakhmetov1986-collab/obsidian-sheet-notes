/**
 * Display formatting for the `nf` cell style: excel-like masks rendered by us.
 *
 * WHY OURS AND NOT THE ENGINE'S. jspreadsheet CE does support masks, but only
 * per COLUMN (`columns[x].mask`, applied inside its own `parseValue`), and it
 * rewrites the cell's raw value through `jSuites.mask.extract` when the editor
 * closes. Both are wrong here: a format is a per-CELL property in this file
 * format, and the file must keep the raw, locale-independent value. So the mask
 * never reaches the engine: the engine renders the raw value and we re-render
 * the TEXT of masked cells (see `SheetEngine.syncDecor`).
 *
 * Everything here is pure and unit-tested. Nothing can fail loudly: an
 * unparseable mask, or a value that is not a number, returns the input
 * unchanged. A cell that shows "#ERROR" where it used to show a word is worse
 * than one that shows the word.
 *
 * Not supported on purpose: multi-section masks (`positive;negative;zero`) and
 * quoted literals that contain digit placeholders (`"#"0.00`). Both are
 * unreachable from the toolbar; a mask we cannot read is displayed raw.
 */

const DIGIT = /[#0]/;
/** Separators allowed INSIDE the numeric core: grouping and decimal marks. */
const CORE = /[#0][#0.,'\s]*[#0]|[#0]/;

export interface NumberMask {
	kind: "number";
	prefix: string;
	suffix: string;
	/** Thousands separator, "" when the mask has no grouping. */
	group: string;
	/** Decimal separator, exactly as written in the mask. */
	decimal: string;
	minInt: number;
	minDec: number;
	maxDec: number;
	percent: boolean;
}

export interface DateMask {
	kind: "date";
	mask: string;
}

export type ParsedMask = NumberMask | DateMask;

/** Excel writes literals in quotes; we only ever meet them in prefix/suffix. */
function unquote(text: string): string {
	return text.replace(/"/g, "");
}

/* -------------------------------------------------------------------- parse */

/** A mask is a date mask when it names a year. No number mask ever does. */
export function isDateMask(mask: string): boolean {
	return /yy/i.test(mask);
}

/**
 * Split an excel-like number mask into the parts the renderer needs.
 *
 * The separator rule is a heuristic, deliberately: `#,##0` groups by thousands
 * while `0,00` means two decimals in a Russian mask, and the mask itself is the
 * only evidence. The rule is "the last separator opens the decimals, unless it
 * is a comma, quote or space followed by exactly three placeholders", which
 * reads every preset this plugin offers plus the usual European variants
 * (`# ##0,00`, `#.##0,00`).
 */
export function parseNumberMask(mask: string): NumberMask | null {
	const core = CORE.exec(mask);
	if (!core || core.index === undefined) return null;

	const body = core[0];
	const prefix = unquote(mask.slice(0, core.index));
	const suffix = unquote(mask.slice(core.index + body.length));

	const sepIndexes: number[] = [];
	for (let i = 0; i < body.length; i++) {
		if (!DIGIT.test(body[i] as string)) sepIndexes.push(i);
	}

	let decimal = ".";
	let group = "";
	let intPart = body;
	let decPart = "";

	if (sepIndexes.length > 0) {
		const last = sepIndexes[sepIndexes.length - 1] as number;
		const sep = body[last] as string;
		const tail = body.slice(last + 1);
		const tailIsDigits = tail.length > 0 && [...tail].every((c) => DIGIT.test(c));
		const groupish = /[,'\s]/.test(sep) && tail.length === 3;
		if (tailIsDigits && !groupish) {
			decimal = sep;
			intPart = body.slice(0, last);
			decPart = tail;
		}
		// Any separator that is not the decimal one groups the integer part.
		const others = sepIndexes
			.map((i) => body[i] as string)
			.filter((c) => decPart.length === 0 || c !== decimal);
		if (others.length > 0) group = others[0] as string;
	}

	const count = (s: string, ch: string) => [...s].filter((c) => c === ch).length;

	return {
		kind: "number",
		prefix,
		suffix,
		group,
		decimal,
		minInt: Math.max(count(intPart, "0"), 1),
		minDec: count(decPart, "0"),
		maxDec: decPart.length,
		percent: mask.includes("%"),
	};
}

export function parseMask(mask: unknown): ParsedMask | null {
	const m = typeof mask === "string" ? mask.trim() : "";
	if (m.length === 0) return null;
	if (isDateMask(m)) return { kind: "date", mask: m };
	return parseNumberMask(m);
}

/* ------------------------------------------------------------------ numbers */

function groupInteger(digits: string, sep: string): string {
	if (!sep) return digits;
	let out = "";
	for (let i = 0; i < digits.length; i++) {
		if (i > 0 && (digits.length - i) % 3 === 0) out += sep;
		out += digits[i];
	}
	return out;
}

/** `"3"`, `3`, `" 3.5 "` -> a number; anything else -> undefined. */
export function toNumber(value: unknown): number | undefined {
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value !== "string") return undefined;
	const s = value.trim();
	if (s.length === 0) return undefined;
	const n = Number(s);
	return Number.isFinite(n) ? n : undefined;
}

export function formatNumber(value: number, mask: NumberMask): string {
	const scaled = mask.percent ? value * 100 : value;
	// Past 1e21 `toFixed` switches to exponential notation ("1e+21"), which has
	// no digits to group and no decimals to pad. Such a number is shown as the
	// engine wrote it rather than as a mangled mask.
	if (!Number.isFinite(scaled) || Math.abs(scaled) >= 1e21) return String(value);
	const negative = scaled < 0;
	const fixed = Math.abs(scaled).toFixed(mask.maxDec);

	const dot = fixed.indexOf(".");
	let intPart = dot < 0 ? fixed : fixed.slice(0, dot);
	let decPart = dot < 0 ? "" : fixed.slice(dot + 1);

	if (mask.maxDec > mask.minDec) {
		decPart = decPart.replace(/0+$/, "");
		while (decPart.length < mask.minDec) decPart += "0";
	}
	while (intPart.length < mask.minInt) intPart = "0" + intPart;

	let text = groupInteger(intPart, mask.group);
	if (decPart.length > 0) text += mask.decimal + decPart;
	// Excel puts the sign in front of the whole thing, currency sign included.
	return (negative ? "-" : "") + mask.prefix + text + mask.suffix;
}

/* -------------------------------------------------------------------- dates */

/** Days between the spreadsheet epoch (1899-12-30 = serial 0) and 1970-01-01. */
const EXCEL_EPOCH_OFFSET = 25569;
const DAY_MS = 86400000;

export interface DateParts {
	y: number;
	mo: number;
	d: number;
	h: number;
	mi: number;
	s: number;
}

/**
 * Interpret a cell value as a date, in UTC.
 *
 * Two shapes are accepted, both common in a vault: an ISO-ish string a human
 * typed (`2026-07-27`, `2026-07-27 14:05`), and a spreadsheet serial number
 * (what arithmetic on dates produces). UTC throughout, so the rendered day is
 * the one written in the file and not what the local timezone shifts it to.
 */
export function toDateParts(value: unknown): DateParts | undefined {
	const isSerial =
		typeof value === "number" ||
		(typeof value === "string" && /^-?[0-9]+(\.[0-9]+)?$/.test(value.trim()));
	if (isSerial) {
		const serial = Number(value);
		if (!Number.isFinite(serial)) return undefined;
		const ms = (serial - EXCEL_EPOCH_OFFSET) * DAY_MS;
		if (!Number.isFinite(ms)) return undefined;
		const d = new Date(ms);
		if (Number.isNaN(d.getTime())) return undefined;
		return {
			y: d.getUTCFullYear(),
			mo: d.getUTCMonth() + 1,
			d: d.getUTCDate(),
			h: d.getUTCHours(),
			mi: d.getUTCMinutes(),
			s: d.getUTCSeconds(),
		};
	}
	if (typeof value !== "string") return undefined;
	const s = value.trim();

	const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
	if (iso) {
		return {
			y: Number(iso[1]),
			mo: Number(iso[2]),
			d: Number(iso[3]),
			h: Number(iso[4] ?? 0),
			mi: Number(iso[5] ?? 0),
			s: Number(iso[6] ?? 0),
		};
	}
	const dmy = /^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
	if (dmy) {
		return {
			y: Number(dmy[3]),
			mo: Number(dmy[2]),
			d: Number(dmy[1]),
			h: Number(dmy[4] ?? 0),
			mi: Number(dmy[5] ?? 0),
			s: Number(dmy[6] ?? 0),
		};
	}
	return undefined;
}

const pad = (n: number, len = 2) => String(n).padStart(len, "0");

/**
 * Render date parts through an excel-like date mask.
 *
 * `mm` is the ambiguous token: it is the month before an hour token and the
 * minutes after one, which is Excel's own rule.
 */
export function formatDate(parts: DateParts, mask: string): string {
	let seenHour = false;
	let out = "";
	let i = 0;

	while (i < mask.length) {
		const token = /^(yyyy|yy|mm|m|dd|d|hh|h|ss|s)/i.exec(mask.slice(i));
		if (!token) {
			const ch = mask[i] as string;
			if (ch !== '"') out += ch;
			i += 1;
			continue;
		}
		const tok = (token[0] as string).toLowerCase();
		i += tok.length;
		if (tok === "yyyy") out += pad(parts.y, 4);
		else if (tok === "yy") out += pad(parts.y % 100);
		else if (tok === "mm") out += seenHour ? pad(parts.mi) : pad(parts.mo);
		else if (tok === "m") out += String(seenHour ? parts.mi : parts.mo);
		else if (tok === "dd") out += pad(parts.d);
		else if (tok === "d") out += String(parts.d);
		else if (tok === "hh") {
			seenHour = true;
			out += pad(parts.h);
		} else if (tok === "h") {
			seenHour = true;
			out += String(parts.h);
		} else if (tok === "ss") out += pad(parts.s);
		else if (tok === "s") out += String(parts.s);
	}
	return out;
}

/* --------------------------------------------------------------- entry point */

/**
 * Format one displayed value with one mask.
 *
 * `display` is what the grid put in the cell: the literal for a plain cell, the
 * COMPUTED result for a formula. Returns the input untouched when the mask or
 * the value does not fit, so a text cell carrying a currency format still shows
 * its text.
 */
export function formatValue(display: unknown, mask: string): string {
	const text = display === null || display === undefined ? "" : String(display);
	if (text.trim().length === 0) return text;
	const parsed = parseMask(mask);
	if (!parsed) return text;

	if (parsed.kind === "date") {
		const parts = toDateParts(text);
		return parts ? formatDate(parts, parsed.mask) : text;
	}
	const n = toNumber(text);
	return n === undefined ? text : formatNumber(n, parsed);
}
