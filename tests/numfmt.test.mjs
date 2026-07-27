/**
 * Number/date mask tests.
 *
 * These masks are what release 1.2.0 writes into people's files, so the rules
 * they encode are checked here rather than trusted: the separator heuristic
 * (`#,##0` groups, `0,00` does not), the sign in front of a currency prefix, the
 * `mm` = month-or-minutes rule, and above all that a value the mask cannot
 * describe comes back UNCHANGED instead of as an error.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	formatDate,
	formatNumber,
	formatValue,
	isDateMask,
	parseMask,
	parseNumberMask,
	toDateParts,
	toNumber,
} from "./.build/numfmt.mjs";

/* -------------------------------------------------------------- mask parsing */

test("date masks are told apart from number masks", () => {
	for (const mask of ["yyyy-mm-dd", "yyyy-mm-dd hh:mm", "dd.mm.yyyy", "YYYY-MM-DD"]) {
		assert.equal(isDateMask(mask), true, mask);
		assert.equal(parseMask(mask).kind, "date", mask);
	}
	for (const mask of ["0.00", "#,##0", "#,##0.00", "0%", "$#,##0.00", "0"]) {
		assert.equal(isDateMask(mask), false, mask);
		assert.equal(parseMask(mask).kind, "number", mask);
	}
});

test("an empty or meaningless mask parses to nothing", () => {
	for (const mask of ["", "   ", "abc", "$", null, undefined, 42]) {
		assert.equal(parseMask(mask), null, JSON.stringify(mask));
	}
});

test("the separator heuristic reads every shipped preset", () => {
	const cases = [
		["0.00", { group: "", decimal: ".", minDec: 2, maxDec: 2, minInt: 1, percent: false }],
		["#,##0", { group: ",", decimal: ".", minDec: 0, maxDec: 0, minInt: 1, percent: false }],
		["#,##0.00", { group: ",", decimal: ".", minDec: 2, maxDec: 2, minInt: 1, percent: false }],
		["0%", { group: "", decimal: ".", minDec: 0, maxDec: 0, minInt: 1, percent: true }],
		["$#,##0.00", { group: ",", decimal: ".", minDec: 2, maxDec: 2, prefix: "$" }],
		["#,##0.00 ₽", { group: ",", decimal: ".", minDec: 2, suffix: " ₽" }],
		// European spellings: space grouping, comma decimals
		["# ##0,00", { group: " ", decimal: ",", minDec: 2 }],
		["#.##0,00", { group: ".", decimal: ",", minDec: 2 }],
		// two digits after a comma are decimals, three are a thousands group
		["0,00", { group: "", decimal: ",", minDec: 2 }],
		["00.0", { minInt: 2, minDec: 1, decimal: "." }],
	];
	for (const [mask, expected] of cases) {
		const parsed = parseNumberMask(mask);
		assert.ok(parsed, `${mask} did not parse`);
		for (const [key, value] of Object.entries(expected)) {
			assert.equal(parsed[key], value, `${mask}: ${key} was ${JSON.stringify(parsed[key])}`);
		}
	}
});

/* ------------------------------------------------------------------ numbers */

test("numbers render through their mask", () => {
	const f = (v, mask) => formatValue(v, mask);
	assert.equal(f(1234.5, "0.00"), "1234.50");
	assert.equal(f(1234.5, "#,##0"), "1,235");
	assert.equal(f(1234.5, "#,##0.00"), "1,234.50");
	assert.equal(f(1234567, "#,##0"), "1,234,567");
	assert.equal(f(0.075, "0%"), "8%");
	assert.equal(f(0.075, "0.00%"), "7.50%");
	assert.equal(f(1234.5, "$#,##0.00"), "$1,234.50");
	assert.equal(f(1234.5, "€#,##0.00"), "€1,234.50");
	assert.equal(f(1234.5, "#,##0.00 ₽"), "1,234.50 ₽");
	assert.equal(f(1234.5, "# ##0,00"), "1 234,50");
	assert.equal(f(7, "00.0"), "07.0");
});

test("the sign goes in front of the whole thing, currency included", () => {
	assert.equal(formatValue(-1234.5, "$#,##0.00"), "-$1,234.50");
	assert.equal(formatValue(-0.5, "0%"), "-50%");
	assert.equal(formatValue(-1234.5, "#,##0.00 ₽"), "-1,234.50 ₽");
});

test("zero, tiny and huge values stay readable", () => {
	assert.equal(formatValue(0, "#,##0.00"), "0.00");
	assert.equal(formatValue(0.004, "0.00"), "0.00");
	// Beyond 1e21 there are no digits left to group: the raw value is shown
	// rather than a mangled mask (verified: grouping "1e+21" produced "1e,+21").
	assert.equal(formatValue(1e20, "#,##0"), "100,000,000,000,000,000,000");
	assert.equal(formatValue(1e21, "#,##0"), "1e+21");
});

test("optional decimals (#) are trimmed, mandatory ones (0) are not", () => {
	assert.equal(formatValue(1.5, "0.0#"), "1.5");
	assert.equal(formatValue(1.25, "0.0#"), "1.25");
	assert.equal(formatValue(1.5, "0.00"), "1.50");
});

test("a value the mask cannot describe is returned untouched", () => {
	assert.equal(formatValue("Widget", "#,##0.00"), "Widget");
	assert.equal(formatValue("#ERROR", "0.00"), "#ERROR");
	assert.equal(formatValue("", "0.00"), "");
	assert.equal(formatValue("later", "yyyy-mm-dd"), "later");
	// and an unparseable mask leaves the value alone
	assert.equal(formatValue("42", "nonsense"), "42");
});

test("formatting is idempotent on its own output for the plain masks", () => {
	// The engine re-renders a cell from the raw value, but a stray second pass
	// must not mangle what is on screen.
	const once = formatValue(1234.5, "#,##0.00");
	assert.equal(formatValue(once, "#,##0.00"), once);
});

test("toNumber accepts what a cell can hold, rejects the rest", () => {
	assert.equal(toNumber("3"), 3);
	assert.equal(toNumber(" 3.5 "), 3.5);
	assert.equal(toNumber(-2), -2);
	assert.equal(toNumber("1e3"), 1000);
	for (const bad of ["", "  ", "abc", "3 apples", null, undefined, {}, NaN, Infinity]) {
		assert.equal(toNumber(bad), undefined, JSON.stringify(bad));
	}
});

test("formatNumber is pure and does not touch its mask", () => {
	const mask = parseNumberMask("#,##0.00");
	const before = JSON.stringify(mask);
	formatNumber(1234.5, mask);
	assert.equal(JSON.stringify(mask), before);
});

/* -------------------------------------------------------------------- dates */

test("ISO strings, dotted dates and serial numbers all become dates", () => {
	assert.deepEqual(toDateParts("2026-07-27"), { y: 2026, mo: 7, d: 27, h: 0, mi: 0, s: 0 });
	assert.deepEqual(toDateParts("2026-07-27 14:05"), { y: 2026, mo: 7, d: 27, h: 14, mi: 5, s: 0 });
	assert.deepEqual(toDateParts("2026-07-27T14:05:09"), {
		y: 2026,
		mo: 7,
		d: 27,
		h: 14,
		mi: 5,
		s: 9,
	});
	assert.deepEqual(toDateParts("27.07.2026"), { y: 2026, mo: 7, d: 27, h: 0, mi: 0, s: 0 });
	// serial 1 is 1899-12-31, the day after the epoch
	assert.deepEqual(toDateParts(1), { y: 1899, mo: 12, d: 31, h: 0, mi: 0, s: 0 });
	assert.deepEqual(toDateParts(46230), { y: 2026, mo: 7, d: 27, h: 0, mi: 0, s: 0 });
	for (const bad of ["", "yesterday", "2026-13", null, {}]) {
		assert.equal(toDateParts(bad), undefined, JSON.stringify(bad));
	}
});

test("dates render through their mask, timezone-independently", () => {
	assert.equal(formatValue("2026-07-27", "yyyy-mm-dd"), "2026-07-27");
	assert.equal(formatValue("2026-07-27", "dd.mm.yyyy"), "27.07.2026");
	assert.equal(formatValue("2026-07-27 14:05", "yyyy-mm-dd hh:mm"), "2026-07-27 14:05");
	assert.equal(formatValue("2026-07-27 14:05", "d/m/yy"), "27/7/26");
	assert.equal(formatValue(46230, "yyyy-mm-dd"), "2026-07-27");
	// midnight is a real time, not a missing one
	assert.equal(formatValue("2026-01-02", "yyyy-mm-dd hh:mm"), "2026-01-02 00:00");
});

test("mm is the month before an hour token and the minutes after one", () => {
	const parts = { y: 2026, mo: 7, d: 27, h: 14, mi: 5, s: 9 };
	assert.equal(formatDate(parts, "yyyy-mm-dd"), "2026-07-27");
	assert.equal(formatDate(parts, "yyyy-mm-dd hh:mm"), "2026-07-27 14:05");
	assert.equal(formatDate(parts, "hh:mm:ss"), "14:05:09");
	assert.equal(formatDate(parts, "mm/dd hh:mm"), "07/27 14:05");
});

test("literal characters in a date mask survive", () => {
	const parts = { y: 2026, mo: 7, d: 27, h: 14, mi: 5, s: 9 };
	assert.equal(formatDate(parts, "yyyy/mm/dd"), "2026/07/27");
	assert.equal(formatDate(parts, "dd-mm-yyyy hh:mm"), "27-07-2026 14:05");
});
