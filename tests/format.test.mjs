import test from "node:test";
import assert from "node:assert/strict";

import {
	CURRENT_VERSION,
	FORMAT_ID,
	MIN_VALID,
	SheetFormatError,
	cellRef,
	colToName,
	isSupportedVersion,
	nameToCol,
	newSheetDoc,
	newSheetPage,
	normalizeColor,
	normalizeSides,
	normalizeStyle,
	parseRef,
	parseSheet,
	serializeSheet,
} from "./.build/format.mjs";
import { BORDER_ON, contrastColor, cssToStyle, styleToCss } from "./.build/cellcss.mjs";

/* ------------------------------------------------------------------ refs */

test("colToName / nameToCol round-trip", () => {
	const cases = [
		[0, "A"],
		[1, "B"],
		[25, "Z"],
		[26, "AA"],
		[27, "AB"],
		[51, "AZ"],
		[52, "BA"],
		[701, "ZZ"],
	];
	for (const [i, name] of cases) {
		assert.equal(colToName(i), name, `col ${i}`);
		assert.equal(nameToCol(name), i, `name ${name}`);
	}
});

test("cellRef / parseRef round-trip", () => {
	for (const [row, col] of [
		[0, 0],
		[9, 2],
		[99, 25],
		[0, 26],
	]) {
		const ref = cellRef(row, col);
		assert.deepEqual(parseRef(ref), { row, col });
	}
	assert.equal(cellRef(0, 0), "A1");
	assert.equal(cellRef(2, 1), "B3");
});

test("parseRef rejects garbage", () => {
	for (const bad of ["", "1A", "A0", "a1", "A", "1", "A1B", "A 1"]) {
		assert.throws(() => parseRef(bad), SheetFormatError, `should reject ${JSON.stringify(bad)}`);
	}
});

/* ------------------------------------------------------------ documents */

test("newSheetDoc is a valid, serializable, re-parseable document", () => {
	const doc = newSheetDoc();
	assert.equal(doc.format, FORMAT_ID);
	assert.equal(doc.version, CURRENT_VERSION);
	assert.equal(doc.sheets.length, 1);
	const text = serializeSheet(doc);
	assert.ok(text.length >= MIN_VALID, `empty doc must be >= MIN_VALID, got ${text.length}`);
	assert.deepEqual(parseSheet(text), doc);
});

/* ---------------------------------------------------------- round-trips */

function sampleDoc() {
	const page = newSheetPage("Sheet1");
	page.cells = {
		A1: { v: "Item" },
		B1: { v: "Qty" },
		C1: { v: "Double" },
		A2: { v: "Widget" },
		B2: { v: 3 },
		C2: { f: "=B2*2" },
		A3: { v: "Gadget" },
		B3: { v: 4.5 },
		B4: { v: true },
		D7: { v: "far", s: { b: true, fs: 14, bg: "#fff2cc", bd: "trbl" } },
	};
	page.colWidths = { 0: 140, 3: 90 };
	page.rowHeights = { 2: 40 };
	page.merges = { A10: [2, 2] };
	return { format: FORMAT_ID, version: CURRENT_VERSION, sheets: [page] };
}

test("parse/serialize round-trip preserves the document", () => {
	const doc = sampleDoc();
	const text = serializeSheet(doc);
	const back = parseSheet(text);
	assert.deepEqual(back, doc);
});

test("serialization is byte-for-byte deterministic regardless of key insertion order", () => {
	const a = sampleDoc();

	// Same content, cells inserted in a shuffled order.
	const b = sampleDoc();
	const shuffled = {};
	for (const key of ["D7", "B4", "C2", "A1", "B3", "A3", "B2", "C1", "A2", "B1"]) {
		shuffled[key] = b.sheets[0].cells[key];
	}
	b.sheets[0].cells = shuffled;
	b.sheets[0].colWidths = { 3: 90, 0: 140 };

	const sa = serializeSheet(a);
	const sb = serializeSheet(b);
	assert.equal(sa, sb);

	// And stable across re-serialization of a parsed copy.
	assert.equal(serializeSheet(parseSheet(sa)), sa);
	assert.equal(serializeSheet(parseSheet(serializeSheet(parseSheet(sa)))), sa);
});

test("cells are sorted by (row, col) and emitted one per line", () => {
	const text = serializeSheet(sampleDoc());
	const cellLines = text
		.split("\n")
		.filter((l) => /^\s{8}"[A-Z]+[0-9]+": \{/.test(l))
		.map((l) => l.trim().split('"')[1]);
	assert.deepEqual(cellLines, ["A1", "B1", "C1", "A2", "B2", "C2", "A3", "B3", "B4", "D7"]);
	// exactly one cell per line
	for (const line of text.split("\n")) {
		const hits = line.match(/"[A-Z]+[0-9]+":/g);
		assert.ok(!hits || hits.length === 1, `more than one cell on a line: ${line}`);
	}
});

test("output uses LF, has a trailing newline and no BOM or CR", () => {
	const text = serializeSheet(sampleDoc());
	assert.ok(!text.includes("\r"), "must not contain CR");
	assert.ok(!text.startsWith("﻿"), "must not start with a BOM");
	assert.ok(text.endsWith("}\n"), "must end with a trailing newline");
	assert.equal(text.split("\n").pop(), "");
});

test("fixed sub-key order v, f, s", () => {
	const doc = newSheetDoc();
	// deliberately insert in the wrong order
	doc.sheets[0].cells = { A1: { s: { bg: "#ff0000" }, f: "=1+1", v: 2 } };
	const text = serializeSheet(doc);
	const line = text.split("\n").find((l) => l.includes('"A1"'));
	assert.match(line, /"A1": \{ "v": 2, "f": "=1\+1", "s": \{ "bg": "#ff0000" \} \}/);
});

/* ---------------------------------------------------------------- styles */

test("fixed style sub-key order b, fs, bg, bd", () => {
	const doc = newSheetDoc();
	doc.sheets[0].cells = { A1: { v: "x", s: { bd: "trbl", bg: "#fff2cc", fs: 18, b: true } } };
	const line = serializeSheet(doc)
		.split("\n")
		.find((l) => l.includes('"A1"'));
	assert.match(
		line,
		/"A1": \{ "v": "x", "s": \{ "b": true, "fs": 18, "bg": "#fff2cc", "bd": "trbl" \} \}/,
	);
});

test("styles round-trip and are normalized", () => {
	const doc = newSheetDoc();
	doc.sheets[0].cells = {
		A1: { s: { b: true } },
		A2: { s: { fs: 24 } },
		A3: { s: { bg: "#DEEBF7" } },
		A4: { s: { bd: "lbrt" } },
		A5: { v: "z", s: { b: true, fs: 12, bg: "#fff2cc", bd: "tb" } },
	};
	const back = parseSheet(serializeSheet(doc));
	assert.deepEqual(back.sheets[0].cells, {
		A1: { s: { b: true } },
		A2: { s: { fs: 24 } },
		A3: { s: { bg: "#deebf7" } }, // hex lowercased
		A4: { s: { bd: "trbl" } }, // sides reordered canonically
		A5: { v: "z", s: { b: true, fs: 12, bg: "#fff2cc", bd: "tb" } },
	});
	assert.equal(serializeSheet(back), serializeSheet(doc));
});

test("a style-only cell is not empty and survives", () => {
	const doc = newSheetDoc();
	doc.sheets[0].cells = { C3: { s: { bg: "#e2f0d9" } } };
	const text = serializeSheet(doc);
	assert.ok(text.includes('"C3": { "s": { "bg": "#e2f0d9" } }'), text);
	assert.deepEqual(parseSheet(text).sheets[0].cells, { C3: { s: { bg: "#e2f0d9" } } });
});

test("unknown or out-of-range style properties are dropped, never persisted", () => {
	const doc = newSheetDoc();
	doc.sheets[0].cells = {
		A1: { v: 1, s: { "font-weight": "bold", color: "red", zzz: 1 } },
		A2: { v: 2, s: { fs: 5 } }, // below MIN_FONT_SIZE
		A3: { v: 3, s: { fs: 500 } }, // above MAX_FONT_SIZE
		A4: { v: 4, s: { bg: "chartreuse" } },
		A5: { v: 5, s: { bd: "xyz" } },
		A6: { v: 6, s: {} },
	};
	const text = serializeSheet(doc);
	assert.ok(!text.includes('"s"'), "no style should have survived:\n" + text);
	for (const cell of Object.values(parseSheet(text).sheets[0].cells)) {
		assert.equal(cell.s, undefined);
	}
});

test("normalizeStyle keeps only the four managed properties", () => {
	assert.deepEqual(normalizeStyle({ b: 1, fs: "14", bg: "#FFF", bd: "bt", junk: 9 }), {
		b: true,
		fs: 14,
		bg: "#ffffff",
		bd: "tb",
	});
	assert.equal(normalizeStyle({}), undefined);
	assert.equal(normalizeStyle(null), undefined);
	assert.equal(normalizeStyle("bold"), undefined);
});

test("colour formats are normalized to #rrggbb", () => {
	assert.equal(normalizeColor("#FFF"), "#ffffff");
	assert.equal(normalizeColor("#AaBbCc"), "#aabbcc");
	assert.equal(normalizeColor("rgb(255, 242, 204)"), "#fff2cc");
	assert.equal(normalizeColor("rgba(0, 0, 0, 0.5)"), "#000000");
	assert.equal(normalizeColor("transparent"), undefined);
	assert.equal(normalizeColor(""), undefined);
	assert.equal(normalizeColor(42), undefined);
});

test("border sides are canonicalized to trbl order", () => {
	assert.equal(normalizeSides("lbrt"), "trbl");
	assert.equal(normalizeSides("bt"), "tb");
	assert.equal(normalizeSides("TR"), "tr");
	assert.equal(normalizeSides("ttt"), "t");
	assert.equal(normalizeSides("xyz"), undefined);
	assert.equal(normalizeSides(""), undefined);
});

/* ------------------------------------------------- style <-> engine CSS */

test("styleToCss always writes every managed property", () => {
	const css = styleToCss({});
	for (const prop of [
		"font-weight",
		"font-size",
		"background-color",
		"border-top",
		"border-left",
		"border-right",
		"border-bottom",
	]) {
		assert.ok(css.includes(prop + ":"), `${prop} missing from ${css}`);
	}
	// "off" values must restore the grid's own look, not erase the gridlines
	assert.ok(css.includes("font-weight: normal"));
	assert.ok(css.includes("background-color: transparent"));
	assert.ok(css.includes("color: inherit"), "no fill -> the theme's own text colour");
	assert.ok(!css.includes(BORDER_ON));
	assert.ok(css.includes("border-top: 1px solid var(--background-modifier-border)"));
});

test("styleToCss / cssToStyle round-trip for every combination", () => {
	const cases = [
		{},
		{ b: true },
		{ fs: 24 },
		{ bg: "#fff2cc" },
		{ bd: "t" },
		{ bd: "trbl" },
		{ bd: "rl" },
		{ b: true, fs: 10, bg: "#434343", bd: "tb" },
	];
	for (const style of cases) {
		const css = styleToCss(style);
		const back = cssToStyle(css) ?? {};
		assert.deepEqual(back, style, `round-trip failed for ${JSON.stringify(style)} -> ${css}`);
		// and CSS generation is itself deterministic
		assert.equal(styleToCss(back), css);
	}
});

test("a fill gets a contrasting, non-persisted text colour", () => {
	// light fills -> dark text (the dark theme's near-white --text-normal would
	// otherwise wash out on a pale fill)
	for (const bg of ["#fff2cc", "#e2f0d9", "#d9d9d9", "#ffffff"]) {
		assert.ok(styleToCss({ bg }).includes("color: #1f1f1f"), bg);
	}
	// dark fills -> light text
	for (const bg of ["#434343", "#000000", "#1a3a5c"]) {
		assert.ok(styleToCss({ bg }).includes("color: #f2f2f2"), bg);
	}
	// the derived colour is not part of the persisted style
	assert.deepEqual(cssToStyle(styleToCss({ bg: "#fff2cc" })), { bg: "#fff2cc" });
	assert.equal(contrastColor("#fff2cc"), "#1f1f1f");
	assert.equal(contrastColor("#434343"), "#f2f2f2");
});

test("cssToStyle ignores declarations we do not manage", () => {
	assert.equal(cssToStyle("color: red; text-align: center;"), undefined);
	assert.equal(cssToStyle(""), undefined);
	assert.equal(cssToStyle(null), undefined);
	assert.deepEqual(cssToStyle("color: red; font-weight: bold;"), { b: true });
});

test("cssToStyle only counts a border side when it is OUR border", () => {
	assert.equal(cssToStyle("border-top: 1px solid var(--background-modifier-border);"), undefined);
	assert.deepEqual(cssToStyle(`border-top: ${BORDER_ON};`), { bd: "t" });
});

/* --------------------------------------------------------------- layout */

test("column widths and row heights survive the round-trip, ordered numerically", () => {
	const doc = newSheetDoc();
	doc.sheets[0].colWidths = { 3: 90, 0: 180.4, 12: 60 };
	doc.sheets[0].rowHeights = { 2: 42, 0: 30 };
	const text = serializeSheet(doc);
	assert.match(text, /"colWidths": \{\n\s+"0": 180,\n\s+"3": 90,\n\s+"12": 60\n\s+\}/);
	assert.match(text, /"rowHeights": \{\n\s+"0": 30,\n\s+"2": 42\n\s+\}/);
	const back = parseSheet(text);
	assert.deepEqual(back.sheets[0].colWidths, { 0: 180, 3: 90, 12: 60 });
	assert.deepEqual(back.sheets[0].rowHeights, { 0: 30, 2: 42 });
});

/* --------------------------------------------------------------- sparse */

test("empty cells are never emitted", () => {
	const doc = newSheetDoc();
	doc.sheets[0].cells = {
		A1: { v: "" },
		A2: { v: null },
		A3: { v: undefined },
		A4: {},
		A5: { f: "" },
		A6: { s: {} },
		B1: { v: "kept" },
	};
	const text = serializeSheet(doc);
	assert.ok(text.includes('"B1"'), "non-empty cell must survive");
	for (const ref of ["A1", "A2", "A3", "A4", "A5", "A6"]) {
		assert.ok(!text.includes(`"${ref}"`), `${ref} must not be emitted`);
	}
	assert.deepEqual(Object.keys(parseSheet(text).sheets[0].cells), ["B1"]);
});

test("a 100x26 sheet with 3 filled cells stays tiny", () => {
	const doc = newSheetDoc();
	doc.sheets[0].cells = { A1: { v: 1 }, B1: { v: 2 }, C1: { f: "=A1+B1" } };
	const text = serializeSheet(doc);
	assert.ok(text.length < 400, `sparse file should be small, got ${text.length}`);
	assert.equal(parseSheet(text).sheets[0].rows, 100);
	assert.equal(parseSheet(text).sheets[0].cols, 26);
});

test("zero is a real value and survives", () => {
	const doc = newSheetDoc();
	doc.sheets[0].cells = { A1: { v: 0 }, A2: { v: false } };
	const text = serializeSheet(doc);
	assert.deepEqual(parseSheet(text).sheets[0].cells, { A1: { v: 0 }, A2: { v: false } });
});

/* -------------------------------------------------------------- numbers */

test("NaN and Infinity are rejected at write time", () => {
	const doc = newSheetDoc();
	doc.sheets[0].cells = { A1: { v: NaN }, A2: { v: Infinity }, A3: { v: -Infinity }, A4: { v: 7 } };
	const text = serializeSheet(doc);
	assert.ok(!/NaN|Infinity/.test(text), "must not write NaN/Infinity");
	// still valid JSON
	JSON.parse(text);
	assert.deepEqual(parseSheet(text).sheets[0].cells, { A4: { v: 7 } });
});

/* -------------------------------------------------------- version guard */

test("version guard: current version is supported", () => {
	assert.equal(isSupportedVersion(newSheetDoc()), true);
});

test("version guard: a future version parses but is not supported", () => {
	const text = serializeSheet(newSheetDoc()).replace('"version": 1', '"version": 99');
	const doc = parseSheet(text);
	assert.equal(doc.version, 99);
	assert.equal(isSupportedVersion(doc), false);
});

test("version guard: missing or bogus version is a hard error", () => {
	assert.throws(
		() => parseSheet('{"format":"leovale-sheet","sheets":[]}'),
		SheetFormatError,
	);
	assert.throws(
		() => parseSheet('{"format":"leovale-sheet","version":0,"sheets":[]}'),
		SheetFormatError,
	);
	assert.throws(
		() => parseSheet('{"format":"leovale-sheet","version":"1","sheets":[]}'),
		SheetFormatError,
	);
});

test("foreign or broken documents are rejected, never silently emptied", () => {
	assert.throws(() => parseSheet("not json at all"), SheetFormatError);
	assert.throws(() => parseSheet("[1,2,3]"), SheetFormatError);
	assert.throws(() => parseSheet('{"format":"luckysheet","version":1}'), SheetFormatError);
	assert.throws(
		() => parseSheet('{"format":"leovale-sheet","version":1,"sheets":[{"cells":{"ZZ":{"v":1}}}]}'),
		SheetFormatError,
	);
});

/* -------------------------------------------------- never-empty output */

test("serializeSheet never returns an empty string", () => {
	const inputs = [
		newSheetDoc(),
		{ format: FORMAT_ID, version: CURRENT_VERSION, sheets: [] },
		{ format: FORMAT_ID, version: CURRENT_VERSION, sheets: [newSheetPage("")] },
		{ format: FORMAT_ID, version: NaN, sheets: [newSheetPage()] },
	];
	for (const doc of inputs) {
		const text = serializeSheet(doc);
		assert.ok(text.length >= MIN_VALID, `too short (${text.length}) for ${JSON.stringify(doc)}`);
		const back = parseSheet(text);
		assert.equal(back.format, FORMAT_ID);
		assert.ok(back.sheets.length >= 1);
	}
});

test("empty input yields a fresh document instead of throwing", () => {
	for (const input of ["", "   ", "\n\n", "﻿"]) {
		const doc = parseSheet(input);
		assert.equal(doc.format, FORMAT_ID);
		assert.equal(doc.sheets.length, 1);
	}
});

test("a BOM-prefixed file still parses", () => {
	const text = "﻿" + serializeSheet(sampleDoc());
	assert.deepEqual(parseSheet(text), sampleDoc());
});

/* -------------------------------------------------------- misc parsing */

test("cells outside the declared grid grow the grid instead of vanishing", () => {
	const doc = parseSheet(
		'{"format":"leovale-sheet","version":1,"sheets":[{"rows":2,"cols":2,"cells":{"E9":{"v":"x"}}}]}',
	);
	assert.equal(doc.sheets[0].rows, 9);
	assert.equal(doc.sheets[0].cols, 5);
	assert.deepEqual(doc.sheets[0].cells.E9, { v: "x" });
});

test("multiple sheets keep their array order", () => {
	const doc = newSheetDoc();
	doc.sheets.push(newSheetPage("Second"));
	doc.sheets.push(newSheetPage("Third"));
	doc.sheets[1].cells = { A1: { v: "two" } };
	const back = parseSheet(serializeSheet(doc));
	assert.deepEqual(
		back.sheets.map((s) => s.name),
		["Sheet1", "Second", "Third"],
	);
	assert.deepEqual(back.sheets[1].cells, { A1: { v: "two" } });
});

test("formula source is stored, computed results are not", () => {
	const doc = newSheetDoc();
	doc.sheets[0].cells = { A1: { v: 1 }, A2: { v: 2 }, A3: { f: "=SUM(A1:A2)" } };
	const text = serializeSheet(doc);
	assert.ok(text.includes('"f": "=SUM(A1:A2)"'));
	assert.ok(!/"A3": \{ "v"/.test(text), "must not cache the computed result");
});
