/**
 * CSV parse / serialize unit tests, plus the formula bar's pure helpers.
 *
 * Everything here runs without Obsidian and without the grid engine: the
 * modules under test are bundled to tests/.build by tests/build-format.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	DEFAULT_DELIMITER,
	csvToDoc,
	detectDelimiter,
	docToCsv,
	normalizeDelimiter,
	parseCsv,
	parseCsvRows,
	quoteCsvField,
	serializeCsv,
} from "./.build/csv.mjs";
import { barText, barValue, refLabel } from "./.build/formulabar.mjs";

/** parse -> serialize must return the input byte for byte. */
function roundTrip(text) {
	const { delimiter, rows } = parseCsv(text);
	return serializeCsv(rows, delimiter);
}

/* ------------------------------------------------------- delimiter sniffing */

test("delimiter detection: comma, semicolon, and the default", () => {
	assert.equal(detectDelimiter("a,b,c\n1,2,3\n"), ",");
	assert.equal(detectDelimiter("a;b;c\n1;2;3\n"), ";");
	// single column, nothing to go on
	assert.equal(detectDelimiter("a\nb\nc\n"), DEFAULT_DELIMITER);
	assert.equal(detectDelimiter(""), DEFAULT_DELIMITER);
});

test("delimiter detection ignores candidates inside quoted fields", () => {
	// three real semicolons, five commas but all of them quoted
	const text = 'a;b;"x,y,z";d\n1;2;"p,q";4\n';
	assert.equal(detectDelimiter(text), ";");
});

test("delimiter detection only sniffs the head of the file", () => {
	const head = "a;b\n1;2\n3;4\n5;6\n7;8\n";
	const tail = "x,y,z,w,v\n".repeat(200);
	assert.equal(detectDelimiter(head + tail), ";");
});

test("normalizeDelimiter refuses anything unwritable", () => {
	assert.equal(normalizeDelimiter(";"), ";");
	assert.equal(normalizeDelimiter(","), ",");
	for (const bad of ["\t", "|", "", null, undefined, 5, ",,"]) {
		assert.equal(normalizeDelimiter(bad), DEFAULT_DELIMITER, String(bad));
	}
});

/* ----------------------------------------------------------------- parsing */

test("plain rows", () => {
	assert.deepEqual(parseCsvRows("a,b\n1,2\n", ","), [
		["a", "b"],
		["1", "2"],
	]);
});

test("quoted fields: embedded delimiter, quote and newline", () => {
	const rows = parseCsvRows('"a,b",plain,"say ""hi""","two\nlines"\n', ",");
	assert.deepEqual(rows, [["a,b", "plain", 'say "hi"', "two\nlines"]]);
});

test("quotes are only special at the start of a field", () => {
	assert.deepEqual(parseCsvRows('a"b,c\n', ","), [['a"b', "c"]]);
});

test("empty fields survive, ragged rows stay ragged", () => {
	assert.deepEqual(parseCsvRows("a,,c\nd\n,e\n", ","), [
		["a", "", "c"],
		["d"],
		["", "e"],
	]);
});

test("CRLF and lone CR are accepted, trailing blank lines dropped", () => {
	assert.deepEqual(parseCsvRows("a,b\r\n1,2\r\n", ","), [
		["a", "b"],
		["1", "2"],
	]);
	assert.deepEqual(parseCsvRows("a,b\r1,2", ","), [
		["a", "b"],
		["1", "2"],
	]);
	assert.deepEqual(parseCsvRows("a,b\n\n\n", ","), [["a", "b"]]);
});

test("CRLF inside a quoted field collapses to LF", () => {
	assert.deepEqual(parseCsvRows('"two\r\nlines",x\n', ","), [["two\nlines", "x"]]);
});

test("a BOM does not become part of the first cell", () => {
	const { rows } = parseCsv("﻿a,b\n1,2\n");
	assert.deepEqual(rows[0], ["a", "b"]);
});

test("an unterminated quote does not lose the tail", () => {
	assert.deepEqual(parseCsvRows('a,"unterminated\n', ","), [["a", "unterminated\n"]]);
});

/* ------------------------------------------------------------- serializing */

test("quoting is minimal and correct", () => {
	assert.equal(quoteCsvField("plain", ","), "plain");
	assert.equal(quoteCsvField("a,b", ","), '"a,b"');
	// the other delimiter is not special
	assert.equal(quoteCsvField("a;b", ","), "a;b");
	assert.equal(quoteCsvField("a;b", ";"), '"a;b"');
	assert.equal(quoteCsvField('say "hi"', ","), '"say ""hi"""');
	assert.equal(quoteCsvField("two\nlines", ","), '"two\nlines"');
});

test("serialize writes LF only, with a trailing newline", () => {
	const out = serializeCsv(
		[
			["a", "b"],
			["1", "2"],
		],
		",",
	);
	assert.equal(out, "a,b\n1,2\n");
	assert.ok(!out.includes("\r"), "never CRLF");
});

test("serialize pads to a rectangle and drops the empty tail", () => {
	const rows = [["a", "b", "c"], ["1"], [], ["", "", ""], []];
	assert.equal(serializeCsv(rows, ","), "a,b,c\n1,,\n");
});

test("an entirely empty grid serializes to an empty string", () => {
	assert.equal(serializeCsv([], ","), "");
	assert.equal(serializeCsv([[], ["", ""]], ","), "");
});

test("the chosen delimiter is the one written", () => {
	assert.equal(serializeCsv([["a", "b"]], ";"), "a;b\n");
});

/* ------------------------------------------------------------- round trips */

test("round trip: both delimiters, quotes, embedded commas and newlines", () => {
	const cases = [
		"a,b,c\n1,2,3\n",
		"a;b;c\n1;2;3\n",
		'name,note\nWidget,"red, large"\n',
		'name;note\nWidget;"red; large"\n',
		'a,"say ""hi""",c\n',
		'a,"two\nlines",c\n',
		"a,,c\n,x,\n",
		"only one cell\n",
		"=SUM(A1:A2),plain\n",
	];
	for (const text of cases) {
		assert.equal(roundTrip(text), text, JSON.stringify(text));
	}
});

test("quotes that were not needed are dropped, the value is unchanged", () => {
	// Not a byte-for-byte round trip on purpose: "abc" and abc are the same
	// field, and writing the shorter form keeps diffs small.
	assert.equal(roundTrip('"quoted but plain",x\n'), "quoted but plain,x\n");
	assert.deepEqual(parseCsvRows('"quoted but plain",x\n', ","), [["quoted but plain", "x"]]);
});

test("round trip is stable on a second pass (idempotent)", () => {
	const once = roundTrip('a;"x;y"\n1;2\n');
	assert.equal(roundTrip(once), once);
});

test("CRLF input comes back as LF", () => {
	assert.equal(roundTrip("a,b\r\n1,2\r\n"), "a,b\n1,2\n");
});

/* ------------------------------------------------------- CSV <-> SheetDoc */

test("csvToDoc puts values and formulas in the right cells", () => {
	const { doc, delimiter } = csvToDoc('Item;Qty\nWidget;3\n=SUM(B2:B2);"a;b"\n');
	assert.equal(delimiter, ";");
	const page = doc.sheets[0];
	assert.deepEqual(page.cells.A1, { v: "Item" });
	assert.deepEqual(page.cells.B2, { v: "3" });
	assert.deepEqual(page.cells.A3, { f: "=SUM(B2:B2)" });
	assert.deepEqual(page.cells.B3, { v: "a;b" });
	assert.equal(page.cells.C1, undefined, "empty cells stay absent");
});

test("csvToDoc always leaves room to type past the imported data", () => {
	const page = csvToDoc("a,b\n").doc.sheets[0];
	assert.ok(page.rows >= 100, String(page.rows));
	assert.ok(page.cols >= 26, String(page.cols));
});

test("csvToDoc grows the grid for a file bigger than the default", () => {
	const text = Array.from({ length: 140 }, (_, i) => `r${i},x`).join("\n") + "\n";
	const page = csvToDoc(text).doc.sheets[0];
	assert.equal(page.rows, 140);
});

test("docToCsv -> csvToDoc round trip through the document model", () => {
	const text = 'Item;Qty\nWidget;3\n"a;b";=SUM(B2:B2)\n';
	const { doc, delimiter } = csvToDoc(text);
	assert.equal(docToCsv(doc, delimiter), text);
});

test("docToCsv drops styles, widths and merges", () => {
	const { doc, delimiter } = csvToDoc("a,b\n");
	const page = doc.sheets[0];
	page.cells.A1.s = { b: true, fs: 18, bg: "#fff2cc", bd: "trbl" };
	page.colWidths = { 0: 180 };
	page.rowHeights = { 1: 51 };
	page.merges = { A1: [2, 2] };
	const out = docToCsv(doc, delimiter);
	assert.equal(out, "a,b\n");
	assert.ok(!/fff2cc|180|51/.test(out));
});

test("docToCsv writes numbers and booleans as text, skips non-finite", () => {
	const { doc } = csvToDoc("");
	doc.sheets[0].cells = {
		A1: { v: 3 },
		B1: { v: true },
		C1: { v: Number.POSITIVE_INFINITY },
		D1: { v: "x" },
	};
	assert.equal(docToCsv(doc, ","), "3,TRUE,,x\n");
});

test("docToCsv on an empty document is an empty string, not a wall of commas", () => {
	const { doc } = csvToDoc("");
	assert.equal(docToCsv(doc, ","), "");
});

/* ------------------------------------------------------ formula bar helpers */

test("barText shows the raw cell content", () => {
	assert.equal(barText("=SUM(B2:B3)"), "=SUM(B2:B3)");
	assert.equal(barText("plain"), "plain");
	assert.equal(barText(3), "3");
	assert.equal(barText(0), "0");
	assert.equal(barText(true), "TRUE");
	assert.equal(barText(false), "FALSE");
	assert.equal(barText(null), "");
	assert.equal(barText(undefined), "");
	assert.equal(barText(Number.NaN), "");
	assert.equal(barText(Number.POSITIVE_INFINITY), "");
});

test("barValue keeps the text single-line", () => {
	assert.equal(barValue("=SUM(B2:B3)"), "=SUM(B2:B3)");
	assert.equal(barValue("a\nb"), "a b");
	assert.equal(barValue("a\r\nb"), "a b");
	assert.equal(barValue("  padded  "), "  padded  ", "leading/trailing space is content");
});

test("refLabel names a cell or a range", () => {
	assert.equal(refLabel([]), "");
	assert.equal(refLabel(["A1"]), "A1");
	assert.equal(refLabel(["A1", "B1", "C1"]), "A1:C1");
	assert.equal(refLabel(["B3", "C3", "B4", "C4"]), "B3:C4");
});
