/**
 * The fill handle's brain: what a drag on a selection produces.
 *
 * Everything the gesture decides is here and is pure, so the cases that matter
 * (a descending drag, a decimal step, the end of a month, a formula that must
 * not be treated as a series) are covered without a browser. The gesture itself
 * - the corner, the preview, the commit, the touch target - is in the e2e
 * suite, because a drag is only real when a real pointer does it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { detectSeries, isFormula, planFill, shiftFormula } from "./.build/fillseries.mjs";

/* ------------------------------------------------------------- detection */

test("one sample is a copy, whatever it holds", () => {
	for (const one of [5, "5", "text", true, "2026-01-01", "Товар 1"]) {
		assert.deepEqual(detectSeries([one]), { kind: "copy", step: 0 }, String(one));
		assert.deepEqual(planFill([one], 3), [one, one, one], String(one));
	}
});

test("numbers continue as an arithmetic progression", () => {
	assert.deepEqual(detectSeries([1, 2, 3]), { kind: "number", step: 1 });
	assert.deepEqual(planFill([1, 2, 3], 3), [4, 5, 6]);
	assert.deepEqual(planFill([2, 4], 3), [6, 8, 10]);
	// Numbers that arrived as text are numbers.
	assert.deepEqual(planFill(["1", "2"], 2), [3, 4]);
});

test("the step may be negative, fractional, or zero", () => {
	assert.deepEqual(planFill([10, 8], 3), [6, 4, 2]);
	assert.deepEqual(planFill([0.5, 1], 3), [1.5, 2, 2.5]);
	assert.deepEqual(planFill([-1, -3], 2), [-5, -7]);
	assert.deepEqual(planFill([7, 7, 7], 2), [7, 7]);
	// The classic float trap: 0.1 + 0.2 must not surface as 0.30000000000000004.
	assert.deepEqual(planFill([0.1, 0.2], 3), [0.3, 0.4, 0.5]);
	assert.deepEqual(planFill([1.05, 1.1], 2), [1.15, 1.2]);
});

test("numbers that do not form a progression are copied, not extrapolated", () => {
	assert.deepEqual(detectSeries([1, 2, 4]), { kind: "copy", step: 0 });
	assert.deepEqual(planFill([1, 2, 4], 4), [1, 2, 4, 1]);
});

test("a drag upwards is the same code, handed its samples the other way round", () => {
	// The caller orders the samples along the direction of travel: bottom-to-top
	// for an upward drag, so `3, 2, 1` continues `0, -1`.
	assert.deepEqual(planFill([3, 2, 1], 2), [0, -1]);
});

/* ----------------------------------------------------------------- dates */

test("dates written as text step by days", () => {
	assert.deepEqual(detectSeries(["2026-01-01", "2026-01-02"]), {
		kind: "date",
		step: 1,
		unit: "day",
	});
	assert.deepEqual(planFill(["2026-01-01", "2026-01-02"], 3), [
		"2026-01-03",
		"2026-01-04",
		"2026-01-05",
	]);
	// A week apart, and across a month boundary.
	assert.deepEqual(planFill(["2026-01-25", "2026-02-01"], 2), ["2026-02-08", "2026-02-15"]);
	// Backwards.
	assert.deepEqual(planFill(["2026-03-02", "2026-03-01"], 2), ["2026-02-28", "2026-02-27"]);
});

test("a whole-month step keeps the day of the month and clamps to the short ones", () => {
	assert.deepEqual(detectSeries(["2026-01-15", "2026-02-15"]), {
		kind: "date",
		step: 1,
		unit: "month",
	});
	assert.deepEqual(planFill(["2026-01-15", "2026-02-15"], 2), ["2026-03-15", "2026-04-15"]);
	// 31 January + 1 month is the end of February, not the 3rd of March, and the
	// series goes back to the 31st afterwards because it counts from the sample.
	assert.deepEqual(planFill(["2025-11-31", "2025-12-31"], 3), [
		"2026-01-31",
		"2026-02-28",
		"2026-03-31",
	]);
});

test("the way a date was written is the way it comes back", () => {
	assert.deepEqual(planFill(["01.02.2026", "02.02.2026"], 2), ["03.02.2026", "04.02.2026"]);
	assert.deepEqual(planFill(["2026-01-01 09:30", "2026-01-02 09:30"], 1), ["2026-01-03 09:30"]);
	assert.deepEqual(planFill(["2026-01-01 09:30:05", "2026-01-02 09:30:05"], 1), [
		"2026-01-03 09:30:05",
	]);
	// Mixed notations carry no step anybody could name, so they repeat.
	assert.deepEqual(detectSeries(["2026-01-01", "02.01.2026"]), { kind: "copy", step: 0 });
});

test("a date that is a serial NUMBER is a number, and that is enough", () => {
	// A masked date cell holds a serial; the arithmetic is the same and the mask
	// renders the result, so no date case is needed for it.
	assert.deepEqual(detectSeries([45000, 45001]), { kind: "number", step: 1 });
	assert.deepEqual(planFill([45000, 45001], 2), [45002, 45003]);
});

/* ------------------------------------------------------- text + a number */

test("text with a trailing number moves the number only", () => {
	assert.deepEqual(detectSeries(["Товар 1", "Товар 2"]), { kind: "text", step: 1 });
	assert.deepEqual(planFill(["Товар 1", "Товар 2"], 3), ["Товар 3", "Товар 4", "Товар 5"]);
	assert.deepEqual(planFill(["Q1", "Q2"], 2), ["Q3", "Q4"]);
	assert.deepEqual(planFill(["row 10", "row 8"], 2), ["row 6", "row 4"]);
});

test("zero padding survives, and grows when it has to", () => {
	assert.deepEqual(planFill(["item 007", "item 008"], 3), ["item 009", "item 010", "item 011"]);
	assert.deepEqual(planFill(["item 98", "item 99"], 2), ["item 100", "item 101"]);
});

test("different prefixes are not a series", () => {
	assert.deepEqual(detectSeries(["Товар 1", "Услуга 2"]), { kind: "copy", step: 0 });
	assert.deepEqual(planFill(["a1", "b2"], 3), ["a1", "b2", "a1"]);
});

/* -------------------------------------------------------------- fallback */

test("anything else repeats the samples, cyclically", () => {
	assert.deepEqual(planFill(["yes", "no"], 5), ["yes", "no", "yes", "no", "yes"]);
	assert.deepEqual(planFill([true, false], 3), [true, false, true]);
	assert.deepEqual(planFill(["text", 5], 3), ["text", 5, "text"]);
});

test("no samples clears the cells the drag covered", () => {
	assert.deepEqual(planFill([], 2), ["", ""]);
	assert.deepEqual(planFill([1, 2], 0), []);
	assert.deepEqual(planFill([1, 2], -1), []);
});

test("a formula among the samples turns the whole lane into a copy", () => {
	assert.deepEqual(detectSeries(["=A1", "=A2"]), { kind: "copy", step: 0 });
	assert.deepEqual(detectSeries([1, "=A2"]), { kind: "copy", step: 0 });
	assert.equal(isFormula("=SUM(A1:A2)"), true);
	assert.equal(isFormula("SUM"), false);
	assert.equal(isFormula(5), false);
	assert.equal(isFormula(null), false);
});

/* -------------------------------------------------------------- formulas */

test("a filled formula moves its relative references", () => {
	assert.equal(shiftFormula("=A1+1", 2, 0), "=A3+1");
	assert.equal(shiftFormula("=A1+B1", 0, 2), "=C1+D1");
	assert.equal(shiftFormula("=SUM(A1:A3)", 1, 0), "=SUM(A2:A4)");
	assert.equal(shiftFormula("=A5", -2, 0), "=A3");
});

test("absolute references stay where they are put", () => {
	assert.equal(shiftFormula("=$A$1", 3, 3), "=$A$1");
	assert.equal(shiftFormula("=$A1", 3, 3), "=$A4");
	assert.equal(shiftFormula("=A$1", 3, 3), "=D$1");
	assert.equal(shiftFormula("=$B$2+C3", 1, 1), "=$B$2+D4");
});

test("a function name is not a cell, however much it looks like one", () => {
	// LOG10 and ATAN2 match the same letters-then-digits shape a reference does.
	assert.equal(shiftFormula("=LOG10(A1)", 1, 0), "=LOG10(A2)");
	assert.equal(shiftFormula("=ATAN2(B1,C1)", 0, 1), "=ATAN2(C1,D1)");
	assert.equal(shiftFormula('=IF(A1>0,"B1 wins","C1 wins")', 1, 0), '=IF(A2>0,"B1 wins","C1 wins")');
});

test("references never move off the sheet", () => {
	assert.equal(shiftFormula("=A1", -5, 0), "=A1");
	assert.equal(shiftFormula("=B2", 0, -9), "=A2");
});

test("a non-formula, and a zero move, come back untouched", () => {
	assert.equal(shiftFormula("A1+1", 2, 0), "A1+1");
	assert.equal(shiftFormula("=A1+1", 0, 0), "=A1+1");
});

test("column letters roll over correctly on a wide move", () => {
	assert.equal(shiftFormula("=Z1", 0, 1), "=AA1");
	assert.equal(shiftFormula("=AA1", 0, -1), "=Z1");
});
