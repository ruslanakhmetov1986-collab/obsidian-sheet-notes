/**
 * What the fill handle produces: the SERIES, decided from the cells the user
 * selected, with no DOM and no engine in sight so it can be tested exhaustively.
 *
 * The rules, in the order they are tried, are the ones a spreadsheet user
 * already knows from Excel and Google Sheets:
 *
 *   1. ONE sample cell        -> plain copy. Dragging a single `5` gives fives.
 *      This is deliberate and is the behaviour the plugin already had: one cell
 *      carries no step, and guessing +1 from it is the thing everybody turns off
 *      first.
 *   2. numbers                -> arithmetic progression. `1, 2, 3` continues
 *      `4, 5, 6`; `10, 8` continues `6, 4`; `0.5, 1.0` continues `1.5`.
 *   3. dates written as text  -> the same, in days or in whole months.
 *      `2026-01-31, 2026-02-28` is a MONTH step and lands on 2026-03-31, not on
 *      2026-03-28 - which is why months are a case of their own and not "30.4
 *      days".
 *   4. text with a trailing number -> the number moves, the text does not:
 *      `Товар 1, Товар 2` continues `Товар 3`. Zero padding survives
 *      (`item 007` -> `item 008`).
 *   5. anything else          -> the samples repeat, cyclically, which is what
 *      a copy of a block down a column has always meant.
 *
 * A DATE CELL WITH A NUMBER IN IT needs no case of its own: a spreadsheet date
 * is a serial number, so `45000, 45001` is rule 2 and the mask renders the
 * result. That is why nothing here takes a number format as an argument.
 *
 * FORMULAS are not here at all. A formula does not continue a series, it moves
 * its references, and that is a per-cell rewrite the caller does with
 * {@link shiftFormula}; a lane that contains one falls back to rule 5 for its
 * literal cells. Keeping the two apart is what makes a mixed selection
 * (`=A1+1`, `7`, `text`) behave predictably instead of half-guessing.
 */

import { cellRef, isRef, parseRef } from "./format";

/** Everything a cell can hold, as the file format stores it. */
export type FillValue = string | number | boolean;

export type SeriesKind = "copy" | "number" | "date" | "text";

/** What {@link detectSeries} decided, kept separate from the values for tests. */
export interface Series {
	kind: SeriesKind;
	/** Step per cell. Days for a day-stepped date, months for a month-stepped one. */
	step: number;
	/** Only for dates: which unit `step` counts. */
	unit?: "day" | "month";
}

const EPSILON = 1e-9;

/* --------------------------------------------------------------- numbers */

/** A value that IS a number, not a value that merely contains one. */
function asNumber(value: FillValue): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value !== "string") return null;
	const s = value.trim();
	if (s === "" || !/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
	const n = Number(s);
	return Number.isFinite(n) ? n : null;
}

/** Decimal places written in a sample, so `0.1 + 0.2` cannot come out `0.30000000000000004`. */
function decimals(value: FillValue): number {
	const s = String(value);
	const dot = s.indexOf(".");
	if (dot < 0 || /[eE]/.test(s)) return 0;
	return s.length - dot - 1;
}

function roundTo(n: number, places: number): number {
	if (places <= 0) return Math.round(n * 1e9) / 1e9;
	const f = 10 ** Math.min(places, 12);
	return Math.round(n * f) / f;
}

/** Constant difference across a run, or null when there is none. */
function constantStep(nums: readonly number[]): number | null {
	if (nums.length < 2) return null;
	const first = nums[1] as number;
	const step = first - (nums[0] as number);
	const scale = Math.max(1, ...nums.map((n) => Math.abs(n)));
	for (let i = 2; i < nums.length; i++) {
		const d = (nums[i] as number) - (nums[i - 1] as number);
		if (Math.abs(d - step) > EPSILON * scale) return null;
	}
	return step;
}

/* ----------------------------------------------------------------- dates */

/** How a date was WRITTEN, so the filled cells are written the same way. */
interface DateShape {
	style: "iso" | "dmy";
	/** The sample carried a time part, so the produced cells carry one too. */
	time: boolean;
	seconds: boolean;
}

interface DateSample {
	shape: DateShape;
	y: number;
	mo: number;
	d: number;
	h: number;
	mi: number;
	s: number;
}

const ISO_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const DMY_RE = /^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * A date only when it was WRITTEN as one. A bare number is a number here even
 * if a mask displays it as a date - see the note at the top of the file.
 */
function asDate(value: FillValue): DateSample | null {
	if (typeof value !== "string") return null;
	const s = value.trim();
	const iso = ISO_RE.exec(s);
	const dmy = iso ? null : DMY_RE.exec(s);
	const m = iso ?? dmy;
	if (!m) return null;
	const [y, mo, d] = iso
		? [Number(m[1]), Number(m[2]), Number(m[3])]
		: [Number(m[3]), Number(m[2]), Number(m[1])];
	if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
	return {
		shape: { style: iso ? "iso" : "dmy", time: m[4] !== undefined, seconds: m[6] !== undefined },
		y,
		mo,
		d,
		h: Number(m[4] ?? 0),
		mi: Number(m[5] ?? 0),
		s: Number(m[6] ?? 0),
	};
}

const DAY_MS = 86400000;

function toUtc(d: DateSample): number {
	return Date.UTC(d.y, d.mo - 1, d.d, d.h, d.mi, d.s);
}

const pad = (n: number, len = 2) => String(Math.abs(n)).padStart(len, "0");

function renderDate(ms: number, shape: DateShape): string {
	const d = new Date(ms);
	const y = pad(d.getUTCFullYear(), 4);
	const mo = pad(d.getUTCMonth() + 1);
	const day = pad(d.getUTCDate());
	let out = shape.style === "iso" ? `${y}-${mo}-${day}` : `${day}.${mo}.${y}`;
	if (shape.time) {
		out += ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
		if (shape.seconds) out += `:${pad(d.getUTCSeconds())}`;
	}
	return out;
}

/**
 * Add whole months and keep the day of the month, clamped to the length of the
 * target month - the rule every spreadsheet uses, and the reason 31 January
 * plus one month is 28 February and not 3 March.
 */
function addMonths(base: DateSample, months: number): number {
	const total = base.y * 12 + (base.mo - 1) + months;
	const y = Math.floor(total / 12);
	const mo = total - y * 12;
	const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
	return Date.UTC(y, mo, Math.min(base.d, lastDay), base.h, base.mi, base.s);
}

function sameShape(a: DateShape, b: DateShape): boolean {
	return a.style === b.style && a.time === b.time && a.seconds === b.seconds;
}

/* ------------------------------------------------------- text + a number */

interface TextSample {
	prefix: string;
	digits: string;
	n: number;
}

/** `Товар 12` -> prefix `Товар `, 12. A bare number is NOT one of these. */
function asTextNumber(value: FillValue): TextSample | null {
	if (typeof value !== "string") return null;
	const m = /^(.*?)(\d+)$/s.exec(value);
	if (!m || m[1] === "" || m[1] === undefined || m[2] === undefined) return null;
	return { prefix: m[1], digits: m[2], n: Number(m[2]) };
}

/* -------------------------------------------------------------- the plan */

export function isFormula(value: FillValue | null | undefined): value is string {
	return typeof value === "string" && value.startsWith("=");
}

/**
 * What series, if any, the samples describe. Exported for the tests and for the
 * caller that wants to log what it decided; {@link planFill} is the useful one.
 */
export function detectSeries(samples: readonly FillValue[]): Series {
	if (samples.length < 2 || samples.some(isFormula)) return { kind: "copy", step: 0 };

	const nums = samples.map(asNumber);
	if (nums.every((n) => n !== null)) {
		const step = constantStep(nums as number[]);
		if (step !== null) return { kind: "number", step };
		return { kind: "copy", step: 0 };
	}

	const dates = samples.map(asDate);
	if (dates.every((d) => d !== null)) {
		const list = dates as DateSample[];
		const first = list[0] as DateSample;
		if (list.every((d) => sameShape(d.shape, first.shape))) {
			// Months first: a month step is also a (variable) number of days, and
			// reading it as days would drift off the day of the month.
			const months = list.map((d) => d.y * 12 + (d.mo - 1));
			const monthStep = constantStep(months);
			if (
				monthStep !== null &&
				monthStep !== 0 &&
				list.every((d) => d.d === first.d && d.h === first.h && d.mi === first.mi && d.s === first.s)
			) {
				return { kind: "date", step: monthStep, unit: "month" };
			}
			const ms = list.map(toUtc);
			const msStep = constantStep(ms);
			if (msStep !== null && msStep !== 0 && Number.isInteger(msStep / DAY_MS)) {
				return { kind: "date", step: msStep / DAY_MS, unit: "day" };
			}
		}
		return { kind: "copy", step: 0 };
	}

	const texts = samples.map(asTextNumber);
	if (texts.every((t) => t !== null)) {
		const list = texts as TextSample[];
		const first = list[0] as TextSample;
		if (list.every((t) => t.prefix === first.prefix)) {
			const step = constantStep(list.map((t) => t.n));
			if (step !== null && Number.isInteger(step)) return { kind: "text", step };
		}
	}

	return { kind: "copy", step: 0 };
}

/**
 * The values for `count` cells that continue `samples`.
 *
 * `samples` are in the order the fill TRAVELS, so a drag upwards hands them in
 * bottom-to-top order and gets a descending series back with no special case
 * anywhere below. The result always has exactly `count` entries; an empty
 * sample list produces empty cells rather than nothing, because the user
 * dragged over those cells and expects them cleared.
 */
export function planFill(samples: readonly FillValue[], count: number): FillValue[] {
	if (count <= 0) return [];
	if (samples.length === 0) return new Array(count).fill("");

	const series = detectSeries(samples);
	const out: FillValue[] = [];
	const last = samples[samples.length - 1] as FillValue;

	if (series.kind === "number") {
		const base = asNumber(last) as number;
		const places = Math.max(...samples.map(decimals), decimals(series.step));
		for (let i = 1; i <= count; i++) out.push(roundTo(base + series.step * i, places));
		return out;
	}

	if (series.kind === "date") {
		const base = asDate(last) as DateSample;
		for (let i = 1; i <= count; i++) {
			const ms =
				series.unit === "month" ? addMonths(base, series.step * i) : toUtc(base) + series.step * i * DAY_MS;
			out.push(renderDate(ms, base.shape));
		}
		return out;
	}

	if (series.kind === "text") {
		const base = asTextNumber(last) as TextSample;
		// Padding is kept only when the sample was padded: `9` -> `10`, but
		// `007` -> `008` and, once it overflows, `010`.
		const width = base.digits.length > 1 && base.digits.startsWith("0") ? base.digits.length : 0;
		for (let i = 1; i <= count; i++) {
			const n = base.n + series.step * i;
			const digits = n < 0 ? `-${pad(n, width)}` : pad(n, width);
			out.push(`${base.prefix}${digits}`);
		}
		return out;
	}

	for (let i = 0; i < count; i++) out.push(samples[i % samples.length] as FillValue);
	return out;
}

/* -------------------------------------------------------------- formulas */

/**
 * Move every relative reference in a formula by `dRow`/`dCol`, the way a copy
 * down a column does.
 *
 * `$` is honoured: `$A$1` never moves, `A$1` moves sideways only, `$A1` moves
 * down only. The vendor's own version strips every `$` before it starts, so a
 * dragged `=$B$2` came out as a moving `=B2`; this one is why the fill handle
 * does the rewrite itself.
 *
 * A token that is FOLLOWED BY `(` is a function, not a cell: `LOG10(A1)` and
 * `ATAN2(B1,C1)` match the same `letters+digits` shape a reference does, and
 * rewriting them would produce `LOG11(A2)`. Text inside quotes is left alone
 * for the same reason.
 */
export function shiftFormula(source: string, dRow: number, dCol: number): string {
	if (!isFormula(source) || (dRow === 0 && dCol === 0)) return source;
	let out = "";
	let i = 0;
	let quote: string | null = null;
	const REF = /^(\$?)([A-Z]+)(\$?)(\d+)/;

	while (i < source.length) {
		const ch = source[i] as string;
		if (quote) {
			out += ch;
			if (ch === quote) quote = null;
			i++;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			out += ch;
			i++;
			continue;
		}
		// A reference can only start where an identifier can start, so a letter
		// preceded by a letter or a digit (the tail of `LOG10`) is never one.
		const prev = i > 0 ? (source[i - 1] as string) : "";
		const m = /[A-Z$]/.test(ch) && !/[A-Za-z0-9_$.]/.test(prev) ? REF.exec(source.slice(i)) : null;
		if (!m) {
			out += ch;
			i++;
			continue;
		}
		const token = m[0];
		const after = source.slice(i + token.length);
		const isCall = /^\s*\(/.test(after);
		const glued = /^[A-Za-z0-9_$]/.test(after);
		if (isCall || glued || !isRef(`${m[2]}${m[4]}`)) {
			out += token;
			i += token.length;
			continue;
		}
		const { row, col } = parseRef(`${m[2]}${m[4]}`);
		const nextRow = m[3] === "$" ? row : Math.max(0, row + dRow);
		const nextCol = m[1] === "$" ? col : Math.max(0, col + dCol);
		const moved = cellRef(nextRow, nextCol);
		const letters = /^[A-Z]+/.exec(moved)?.[0] ?? "";
		out += `${m[1]}${letters}${m[3]}${moved.slice(letters.length)}`;
		i += token.length;
	}
	return out;
}
