import test from "node:test";
import assert from "node:assert/strict";

import { newSheetPage, parseSheet, serializeSheet, newSheetDoc } from "./.build/format.mjs";
import {
	compareValues,
	dataEdge,
	distinctValues,
	escapeMarkdownCell,
	findMatches,
	freezeFromRef,
	hiddenRows,
	markdownAligns,
	parseMarkdownTable,
	rowEnd,
	sortPage,
	toMarkdownTable,
	usedEnd,
} from "./.build/sheetops.mjs";

/* ------------------------------------------------------------------ sort */

/** 4 rows: a header plus three data rows, every data row carrying a style. */
function fruitPage() {
	const page = newSheetPage("Sheet1");
	page.rows = 4;
	page.cols = 2;
	page.cells = {
		A1: { v: "Fruit", s: { b: true } },
		B1: { v: "Qty", s: { b: true } },
		A2: { v: "cherry", s: { bg: "#ffe0e0" } },
		B2: { v: 3, s: { nf: "0.00" } },
		A3: { v: "apple", s: { bg: "#e2f0d9" } },
		B3: { v: 10, s: { nf: "#,##0" } },
		A4: { v: "banana", s: { bg: "#fff2cc" } },
		B4: { v: 2, s: { nf: "0%" } },
	};
	page.rowHeights = { 2: 40 };
	return page;
}

test("sorting moves a row's style and mask with its values", () => {
	const page = fruitPage();
	const { page: sorted } = sortPage(page, 0, "asc", 1);
	assert.equal(sorted.cells.A2.v, "apple");
	assert.deepEqual(sorted.cells.A2.s, { bg: "#e2f0d9" }, "apple kept its own fill");
	assert.equal(sorted.cells.B2.v, 10);
	assert.deepEqual(sorted.cells.B2.s, { nf: "#,##0" }, "and its own number mask");
	assert.equal(sorted.cells.A3.v, "banana");
	assert.deepEqual(sorted.cells.A3.s, { bg: "#fff2cc" });
	assert.equal(sorted.cells.A4.v, "cherry");
	assert.deepEqual(sorted.cells.A4.s, { bg: "#ffe0e0" });
	// the header row did not move and kept its bold
	assert.deepEqual(sorted.cells.A1, { v: "Fruit", s: { b: true } });
});

test("sorting is not destructive: the input page is untouched", () => {
	const page = fruitPage();
	const before = JSON.stringify(page);
	sortPage(page, 0, "desc", 1);
	assert.equal(JSON.stringify(page), before);
});

test("descending sort, and row heights follow their rows", () => {
	const page = fruitPage();
	const { page: sorted, order } = sortPage(page, 1, "desc", 1);
	assert.deepEqual(order, [2, 1, 3]); // 10, 3, 2
	assert.equal(sorted.cells.B2.v, 10);
	assert.equal(sorted.cells.B3.v, 3);
	assert.equal(sorted.cells.B4.v, 2);
	// the tall row (index 2, apple/10) sorted to the top of the data region
	assert.deepEqual(sorted.rowHeights, { 1: 40 });
});

test("the sort itself is recorded in the page's view block", () => {
	const { page } = sortPage(fruitPage(), 1, "desc", 1);
	assert.deepEqual(page.view.sort, { col: 1, dir: "desc" });
});

test("empty cells sink to the bottom in both directions", () => {
	const page = newSheetPage();
	page.rows = 5;
	page.cols = 1;
	page.cells = { A1: { v: "b" }, A3: { v: "a" }, A5: { v: "c" } };
	const asc = sortPage(page, 0, "asc").page;
	assert.deepEqual(
		[asc.cells.A1?.v, asc.cells.A2?.v, asc.cells.A3?.v, asc.cells.A4?.v],
		["a", "b", "c", undefined],
	);
	const desc = sortPage(page, 0, "desc").page;
	assert.deepEqual(
		[desc.cells.A1?.v, desc.cells.A2?.v, desc.cells.A3?.v, desc.cells.A4?.v],
		["c", "b", "a", undefined],
	);
});

test("numbers sort numerically and before text", () => {
	assert.equal(compareValues(9, 10) < 0, true, "9 < 10, not '9' > '1'");
	assert.equal(compareValues("9", "10") < 0, true, "numeric strings too");
	assert.equal(compareValues(5, "apple") < 0, true, "numbers before text");
	assert.equal(compareValues("Apple", "apple"), -1, "case is only the tie-break");
	assert.equal(compareValues("apple", "Banana") < 0, true, "compare is case-insensitive");
	assert.equal(compareValues("", "a") > 0, true, "empty is last");
});

test("a sort reads through a resolver, so formulas sort by their result", () => {
	const page = newSheetPage();
	page.rows = 3;
	page.cols = 1;
	page.cells = { A1: { f: "=1+1" }, A2: { f: "=9+9" }, A3: { f: "=0+1" } };
	const shown = { 0: 2, 1: 18, 2: 1 };
	const { page: sorted, movedFormula } = sortPage(page, 0, "asc", 0, (r) => shown[r]);
	assert.deepEqual(
		[sorted.cells.A1.f, sorted.cells.A2.f, sorted.cells.A3.f],
		["=0+1", "=1+1", "=9+9"],
	);
	assert.equal(movedFormula, true, "the caller has to be able to warn about this");
});

test("movedFormula stays false when nothing with a formula actually moved", () => {
	const page = fruitPage();
	assert.equal(sortPage(page, 0, "asc", 1).movedFormula, false);
});

test("a sorted page still serializes deterministically", () => {
	const doc = newSheetDoc();
	doc.sheets[0] = sortPage(fruitPage(), 0, "asc", 1).page;
	const text = serializeSheet(doc);
	assert.equal(serializeSheet(parseSheet(text)), text);
	// and the styles really did land on disk next to their new values
	assert.ok(text.includes('"A2": { "v": "apple", "s": { "bg": "#e2f0d9" } }'), text);
	assert.ok(text.includes('"B2": { "v": 10, "s": { "nf": "#,##0" } }'), text);
});

/* --------------------------------------------------------------- filters */

test("filters hide the rows whose value is not allowed", () => {
	const page = fruitPage();
	page.view = { filters: { 0: ["apple", "cherry"] } };
	assert.deepEqual(hiddenRows(page, 1), [3]); // banana
	// header rows are never hidden, whatever they hold
	page.view = { filters: { 0: ["nothing"] } };
	assert.deepEqual(hiddenRows(page, 1), [1, 2, 3]);
	assert.deepEqual(hiddenRows(page, 0), [0, 1, 2, 3]);
});

test("a blank cell is never filtered out", () => {
	// The menu only lists values the column HAS, so an empty row could never be
	// ticked back into view; hiding it would be a one-way door.
	const page = fruitPage();
	page.rows = 8; // rows 5..7 are empty
	page.view = { filters: { 0: ["apple"] } };
	assert.deepEqual(hiddenRows(page, 1), [1, 3]);
});

test("two filters are combined with AND, an unfiltered page hides nothing", () => {
	const page = fruitPage();
	page.view = { filters: { 0: ["apple", "cherry"], 1: ["10"] } };
	assert.deepEqual(hiddenRows(page, 1), [1, 3]);
	page.view = {};
	assert.deepEqual(hiddenRows(page, 1), []);
});

test("distinct values are the menu of a filter: unique, sorted, no blanks", () => {
	const page = fruitPage();
	assert.deepEqual(distinctValues(page, 0, 1), ["apple", "banana", "cherry"]);
	assert.deepEqual(distinctValues(page, 1, 1), ["2", "3", "10"]);
	assert.deepEqual(distinctValues(page, 0, 0), ["apple", "banana", "cherry", "Fruit"]);
});

/* ---------------------------------------------------------------- search */

test("search finds cells case-insensitively, in row-major order", () => {
	const page = fruitPage();
	assert.deepEqual(findMatches(page, "an"), ["A4"]); // banana
	assert.deepEqual(findMatches(page, "R"), ["A1", "A2"]); // Fruit, cherry
	assert.deepEqual(findMatches(page, ""), []);
	assert.deepEqual(findMatches(page, "zzz"), []);
});

/* ------------------------------------------------------- markdown tables */

test("a selection becomes a Markdown table with an alignment row", () => {
	const md = toMarkdownTable(
		[
			["Item", "Qty"],
			["Widget", "3"],
		],
		[undefined, "r"],
	);
	assert.equal(md, ["| Item | Qty |", "| --- | ---: |", "| Widget | 3 |"].join("\n"));
});

test("pipes and newlines in a value survive the round-trip", () => {
	const rows = [["a|b", "c"], ["two\nlines", "back\\slash"]];
	const md = toMarkdownTable(rows);
	assert.ok(md.includes("a\\|b"), md);
	assert.ok(!md.split("\n")[2].includes("\n"), "a row is one line");
	assert.deepEqual(parseMarkdownTable(md), [
		["a|b", "c"],
		["two\nlines", "back\\slash"],
	]);
});

test("escapeMarkdownCell is the only thing that touches the value", () => {
	assert.equal(escapeMarkdownCell("plain"), "plain");
	assert.equal(escapeMarkdownCell("a|b"), "a\\|b");
});

test("parsing accepts tables without an alignment row, with ragged rows and prose", () => {
	const text = [
		"some prose before",
		"| a | b | c |",
		"| 1 | 2 |",
		"",
		"trailing words",
	].join("\n");
	assert.deepEqual(parseMarkdownTable(text), [
		["a", "b", "c"],
		["1", "2", ""],
	]);
});

test("parsing accepts a table written without the outer pipes", () => {
	assert.deepEqual(parseMarkdownTable("a | b\n--- | ---\n1 | 2"), [
		["a", "b"],
		["1", "2"],
	]);
});

test("a non-table is not a table", () => {
	assert.deepEqual(parseMarkdownTable("just some text\nand more"), []);
	assert.deepEqual(parseMarkdownTable(""), []);
});

test("the alignment row is read back into our own codes", () => {
	assert.deepEqual(markdownAligns("| a | b | c | d |\n| :--- | :---: | ---: | --- |\n| 1 | 2 | 3 | 4 |"), [
		"l",
		"c",
		"r",
		undefined,
	]);
	assert.deepEqual(markdownAligns("| a |\n| 1 |"), []);
});

test("a one-row table is still valid Markdown", () => {
	assert.equal(toMarkdownTable([["only"]]), "| only |\n| --- |");
	assert.equal(toMarkdownTable([]), "");
});

/* --------------------------------------------------- keyboard navigation */

/** filled: A1:B2 block, then D5 on its own. */
const filled = (r, c) => (r <= 1 && c <= 1) || (r === 4 && c === 3);
const bounds = { rows: 10, cols: 6 };

test("Ctrl+Arrow runs to the end of a block", () => {
	assert.deepEqual(dataEdge({ row: 0, col: 0 }, 0, 1, filled, bounds), { row: 0, col: 1 });
	assert.deepEqual(dataEdge({ row: 0, col: 0 }, 1, 0, filled, bounds), { row: 1, col: 0 });
});

test("Ctrl+Arrow from an empty cell jumps to the next filled one", () => {
	assert.deepEqual(dataEdge({ row: 4, col: 0 }, 0, 1, filled, bounds), { row: 4, col: 3 });
	assert.deepEqual(dataEdge({ row: 2, col: 0 }, -1, 0, filled, bounds), { row: 1, col: 0 });
});

test("Ctrl+Arrow with nothing ahead lands on the grid edge", () => {
	assert.deepEqual(dataEdge({ row: 0, col: 1 }, 0, 1, filled, bounds), { row: 0, col: 5 });
	assert.deepEqual(dataEdge({ row: 0, col: 0 }, -1, 0, filled, bounds), { row: 0, col: 0 });
	assert.deepEqual(dataEdge({ row: 9, col: 5 }, 1, 0, filled, bounds), { row: 9, col: 5 });
});

test("End is the last filled column of the row, Ctrl+End the used corner", () => {
	assert.equal(rowEnd(0, filled, bounds), 1);
	assert.equal(rowEnd(4, filled, bounds), 3);
	assert.equal(rowEnd(7, filled, bounds), 0, "an empty row sends you back to its start");
	assert.deepEqual(usedEnd(filled, bounds), { row: 4, col: 3 });
	assert.deepEqual(usedEnd(() => false, bounds), { row: 0, col: 0 });
});

/* ---------------------------------------------------------------- freeze */

test("freezing from a selection freezes everything above and left of it", () => {
	assert.deepEqual(freezeFromRef("B3", "both"), { rows: 2, cols: 1 });
	assert.deepEqual(freezeFromRef("B3", "rows"), { rows: 2 });
	assert.deepEqual(freezeFromRef("B3", "cols"), { cols: 1 });
	assert.deepEqual(freezeFromRef("A1", "both"), {}, "nothing above A1 to freeze");
});
