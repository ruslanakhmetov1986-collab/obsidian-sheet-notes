import test from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	CURRENT_VERSION,
	FORMAT_ID,
	MAX_NF_LENGTH,
	MIN_VALID,
	SheetFormatError,
	cellRef,
	colToName,
	isCheckedValue,
	isEmptyCell,
	isEmptyStyle,
	normalizeCellType,
	isSupportedVersion,
	nameToCol,
	newSheetDoc,
	newSheetPage,
	normalizeColor,
	normalizeHAlign,
	normalizeNf,
	normalizeSides,
	normalizeStyle,
	normalizeVAlign,
	parseRef,
	parseSheet,
	serializeSheet,
} from "./.build/format.mjs";
import {
	BORDER_ON,
	CELL_BG_NONE,
	DARK_FILL_DIM,
	FILL_COLORS,
	H_ALIGN_CSS,
	V_ALIGN_CSS,
	WRAP_CLASS,
	WRAP_ON,
	contrastColor,
	contrastRatio,
	cssToStyle,
	dimmedFill,
	looksNumeric,
	styleToCss,
} from "./.build/cellcss.mjs";

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
	// "no fill" is a variable, not the literal `transparent`: an inline
	// declaration cannot be overridden by a rule, but the variable it reads can,
	// which is what makes a frozen row opaque. See CELL_BG_NONE in cellcss.ts.
	assert.ok(css.includes(`background-color: ${CELL_BG_NONE}`), css);
	assert.equal(cssToStyle(css)?.bg, undefined, "and it must not read back as a fill");
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
	// `color` is derived from the fill at render time and never read back;
	// `text-align` became managed in 1.2.0, hence the ha key.
	assert.deepEqual(cssToStyle("color: red; text-align: center;"), { ha: "c" });
	assert.equal(cssToStyle("color: red; letter-spacing: 2px;"), undefined);
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
	const text = serializeSheet(newSheetDoc()).replace(
		`"version": ${CURRENT_VERSION}`,
		'"version": 99',
	);
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

/* ================================================================= 1.2.0 ==
 * Number formats, alignment and wrapping: the four style keys added in this
 * release. Everything below is about the two invariants that make this file
 * format worth trusting - the byte order is fixed and a round trip changes
 * nothing - plus the compatibility promise for files written by 1.1.x.
 */

test("fixed style sub-key order b, fs, bg, bd, nf, ha, va, wrap", () => {
	const doc = newSheetDoc();
	// deliberately inserted in the worst possible order
	doc.sheets[0].cells = {
		A1: {
			v: "x",
			s: {
				wrap: true,
				va: "t",
				ha: "c",
				nf: "#,##0.00",
				bd: "trbl",
				bg: "#fff2cc",
				fs: 18,
				b: true,
			},
		},
	};
	const line = serializeSheet(doc)
		.split("\n")
		.find((l) => l.includes('"A1"'));
	assert.equal(
		line.trim(),
		'"A1": { "v": "x", "s": { "b": true, "fs": 18, "bg": "#fff2cc", "bd": "trbl", ' +
			'"nf": "#,##0.00", "ha": "c", "va": "t", "wrap": true } }',
	);
});

test("the 1.2.0 keys come after bd, so a 1.1.x style only grows a tail", () => {
	const page = (cells) => ({ ...newSheetPage(), cells });
	const old = { v: 1, s: { b: true, fs: 14, bg: "#fff2cc", bd: "tb" } };
	const grown = { v: 1, s: { ...old.s, nf: "0%", ha: "r", va: "b", wrap: true } };
	const before = serializeSheet({ ...newSheetDoc(), sheets: [page({ A1: old })] });
	const after = serializeSheet({ ...newSheetDoc(), sheets: [page({ A1: grown })] });
	const oldLine = before
		.split("\n")
		.find((l) => l.includes('"A1"'))
		.replace(/ \} \}$/, "");
	const newLine = after.split("\n").find((l) => l.includes('"A1"'));
	assert.ok(newLine.startsWith(oldLine), `${newLine}\ndoes not extend\n${oldLine}`);
});

test("every new key round-trips through the file", () => {
	const doc = newSheetDoc();
	doc.sheets[0].cells = {
		A1: { v: 1234.5, s: { nf: "#,##0.00" } },
		A2: { v: "2026-07-27", s: { nf: "yyyy-mm-dd hh:mm" } },
		A3: { v: 0.5, s: { nf: "0%", ha: "r" } },
		A4: { v: "mid", s: { ha: "c", va: "m" } },
		A5: { v: "top", s: { va: "t" } },
		A6: { v: "bottom", s: { va: "b" } },
		A7: { v: "long text", s: { wrap: true } },
		A8: {
			v: "all",
			s: { b: true, fs: 12, bg: "#deebf7", bd: "tb", nf: "0.00", ha: "c", va: "b", wrap: true },
		},
	};
	const text = serializeSheet(doc);
	const back = parseSheet(text);
	assert.deepEqual(back.sheets[0].cells, doc.sheets[0].cells);
	// and re-serializing is byte-identical: determinism holds with the new keys
	assert.equal(serializeSheet(back), text);
});

test("a mask containing the characters that break CSS survives the file", () => {
	// ":" and ";" are exactly why masks are not smuggled through inline CSS.
	const doc = newSheetDoc();
	doc.sheets[0].cells = { A1: { v: 1, s: { nf: "yyyy-mm-dd hh:mm" } } };
	const text = serializeSheet(doc);
	assert.ok(text.includes('"nf": "yyyy-mm-dd hh:mm"'), text);
	assert.equal(parseSheet(text).sheets[0].cells.A1.s.nf, "yyyy-mm-dd hh:mm");
});

test("nf is validated, not trusted", () => {
	assert.equal(normalizeNf("#,##0.00"), "#,##0.00");
	assert.equal(normalizeNf("  0%  "), "0%");
	assert.equal(normalizeNf(""), undefined);
	assert.equal(normalizeNf("   "), undefined);
	assert.equal(normalizeNf(42), undefined);
	assert.equal(normalizeNf(null), undefined);
	assert.equal(normalizeNf("a".repeat(MAX_NF_LENGTH + 1)), undefined);
	assert.equal(normalizeNf("0.00\n#,##0"), undefined, "no control characters");
	assert.equal(normalizeNf("0.00\tx"), undefined, "no control characters");
});

test("alignment codes are validated, and whole words are accepted", () => {
	assert.equal(normalizeHAlign("l"), "l");
	assert.equal(normalizeHAlign("center"), "c");
	assert.equal(normalizeHAlign("RIGHT"), "r");
	assert.equal(normalizeHAlign("x"), undefined);
	assert.equal(normalizeHAlign(""), undefined);
	assert.equal(normalizeHAlign(3), undefined);
	assert.equal(normalizeVAlign("top"), "t");
	assert.equal(normalizeVAlign("m"), "m");
	assert.equal(normalizeVAlign("bottom"), "b");
	assert.equal(normalizeVAlign("q"), undefined);
});

test("normalizeStyle keeps the eight managed properties and drops the rest", () => {
	assert.deepEqual(
		normalizeStyle({
			b: 1,
			fs: "14",
			bg: "#FFF",
			bd: "bt",
			nf: " 0.00 ",
			ha: "center",
			va: "top",
			wrap: 1,
			junk: 9,
			"text-align": "center",
		}),
		{ b: true, fs: 14, bg: "#ffffff", bd: "tb", nf: "0.00", ha: "c", va: "t", wrap: true },
	);
	// a style that holds nothing but a new key is still a style
	assert.deepEqual(normalizeStyle({ nf: "0%" }), { nf: "0%" });
	assert.deepEqual(normalizeStyle({ wrap: true }), { wrap: true });
	assert.equal(normalizeStyle({ nf: "", wrap: false, ha: "q" }), undefined);
	assert.equal(isEmptyStyle({ nf: undefined }), true);
	assert.equal(isEmptyStyle({ wrap: true }), false);
});

test("a cell carrying only a format is not empty and survives", () => {
	const doc = newSheetDoc();
	doc.sheets[0].cells = { C3: { s: { nf: "0%" } }, C4: { s: { wrap: true } } };
	const text = serializeSheet(doc);
	assert.ok(text.includes('"C3": { "s": { "nf": "0%" } }'), text);
	assert.ok(text.includes('"C4": { "s": { "wrap": true } }'), text);
	assert.deepEqual(parseSheet(text).sheets[0].cells, doc.sheets[0].cells);
});

/* -------------------------------------------------- v1 files keep working */

const V1_FILE = [
	"{",
	'  "format": "leovale-sheet",',
	'  "version": 1,',
	'  "sheets": [',
	"    {",
	'      "name": "Sheet1",',
	'      "rows": 100,',
	'      "cols": 26,',
	'      "colWidths": {',
	'        "0": 180',
	"      },",
	'      "rowHeights": {},',
	'      "merges": {},',
	'      "cells": {',
	'        "A1": { "v": "Item", "s": { "b": true, "fs": 18, "bg": "#fff2cc", "bd": "trbl" } },',
	'        "B2": { "v": 3 },',
	'        "C2": { "f": "=B2*2" }',
	"      }",
	"    }",
	"  ]",
	"}",
	"",
].join("\n");

test("a version 1 file loads with everything in it", () => {
	const doc = parseSheet(V1_FILE);
	assert.equal(doc.version, 1);
	assert.equal(isSupportedVersion(doc), true);
	assert.deepEqual(doc.sheets[0].cells, {
		A1: { v: "Item", s: { b: true, fs: 18, bg: "#fff2cc", bd: "trbl" } },
		B2: { v: 3 },
		C2: { f: "=B2*2" },
	});
	assert.deepEqual(doc.sheets[0].colWidths, { 0: 180 });
});

test("writing always produces the current version, whatever the document claims", () => {
	// The point of the bump: an older build must refuse to WRITE a file that can
	// carry keys it would silently drop, so every save is a current-version save.
	const written = serializeSheet(parseSheet(V1_FILE));
	assert.match(written, /^\{\n  "format": "leovale-sheet",\n  "version": 4,/);
	assert.equal(parseSheet(written).version, CURRENT_VERSION);
	assert.equal(CURRENT_VERSION, 4);

	// Nothing about the CONTENT changed: the version line, plus the two empty
	// 1.3.0 blocks that every page now carries, and not a line more.
	const before = V1_FILE.split("\n");
	const after = written.split("\n");
	const added = after.filter((l) => !before.includes(l));
	assert.deepEqual(added, ['  "version": 4,', '      "view": {},', '      "freeze": {},']);
	const removed = before.filter((l) => !after.includes(l));
	assert.deepEqual(removed, ['  "version": 1,']);
});

test("a v1 file without the new keys does not grow them on save", () => {
	const doc = parseSheet(V1_FILE);
	const out = serializeSheet(doc);
	for (const key of ['"nf"', '"ha"', '"va"', '"wrap"']) {
		assert.ok(!out.includes(key), `${key} appeared out of nowhere:\n${out}`);
	}
});

test("versions 1..4 are supported, a version 5 file is not", () => {
	assert.equal(isSupportedVersion(parseSheet(serializeSheet(newSheetDoc()))), true);
	assert.equal(isSupportedVersion(parseSheet(V1_FILE)), true);
	for (const version of [2, 3]) {
		const older = parseSheet(
			serializeSheet(newSheetDoc()).replace('"version": 4', `"version": ${version}`),
		);
		assert.equal(isSupportedVersion(older), true, `v${version} must stay readable`);
	}
	const future = parseSheet(serializeSheet(newSheetDoc()).replace('"version": 4', '"version": 5'));
	assert.equal(isSupportedVersion(future), false);
});

/* ---------------------------------------- new keys <-> engine inline CSS */

test("styleToCss always writes the alignment and wrap properties too", () => {
	const css = styleToCss({});
	for (const prop of ["text-align", "vertical-align", "overflow-wrap"]) {
		assert.ok(css.includes(prop + ":"), `${prop} missing from ${css}`);
	}
	// the "off" values have to reproduce the grid's own look
	assert.ok(css.includes("text-align: left"), css);
	assert.ok(css.includes("vertical-align: inherit"), css);
	assert.ok(css.includes("overflow-wrap: normal"), css);
});

test("alignment maps to real CSS keywords", () => {
	assert.deepEqual(H_ALIGN_CSS, { l: "left", c: "center", r: "right" });
	assert.deepEqual(V_ALIGN_CSS, { t: "top", m: "middle", b: "bottom" });
	assert.ok(styleToCss({ ha: "c" }).includes("text-align: center"));
	assert.ok(styleToCss({ ha: "r" }).includes("text-align: right"));
	assert.ok(styleToCss({ va: "t" }).includes("vertical-align: top"));
	assert.ok(styleToCss({ va: "m" }).includes("vertical-align: middle"));
	assert.ok(styleToCss({ wrap: true }).includes(`overflow-wrap: ${WRAP_ON}`));
});

test("styleToCss / cssToStyle round-trip for every new combination", () => {
	const cases = [
		{ ha: "c" },
		{ ha: "r" },
		{ va: "t" },
		{ va: "m" },
		{ va: "b" },
		{ wrap: true },
		{ ha: "c", va: "m", wrap: true },
		{ b: true, fs: 10, bg: "#434343", bd: "tb", ha: "r", va: "b", wrap: true },
	];
	for (const style of cases) {
		const css = styleToCss(style);
		const back = cssToStyle(css) ?? {};
		assert.deepEqual(back, style, `round-trip failed for ${JSON.stringify(style)} -> ${css}`);
		assert.equal(styleToCss(back), css, "CSS generation is deterministic");
	}
});

test("text-align: left is the engine's default and never becomes an ha key", () => {
	// The engine writes `text-align: left` onto EVERY cell it creates (that is
	// how the columns are configured), so reading it back as `ha: "l"` would put
	// an alignment key on all 2600 cells of a fresh sheet.
	assert.equal(cssToStyle("text-align: left;"), undefined);
	assert.equal(
		cssToStyle("text-align: left; vertical-align: inherit; overflow-wrap: normal;"),
		undefined,
	);
	// the value itself stays legal, it just renders as the default
	assert.deepEqual(normalizeStyle({ ha: "l" }), { ha: "l" });
	assert.ok(styleToCss({ ha: "l" }).includes("text-align: left"));
});

test("the engine's own white-space is not mistaken for the wrap flag", () => {
	// The engine sets `white-space: pre-wrap` by itself on any cell holding more
	// than 200 characters. That must not become a persisted `wrap`.
	assert.equal(cssToStyle("white-space: pre-wrap;"), undefined);
	assert.deepEqual(cssToStyle(`white-space: pre-wrap; overflow-wrap: ${WRAP_ON};`), { wrap: true });
});

test("nf is deliberately absent from the CSS mapping", () => {
	// It travels in a data attribute instead; see the header of cellcss.ts.
	const css = styleToCss({ nf: "yyyy-mm-dd hh:mm", ha: "c" });
	assert.ok(!css.includes("yyyy"), css);
	assert.deepEqual(cssToStyle(css), { ha: "c" });
	// every declaration is one clean `prop: value` pair, which is all the
	// engine's own style parser can handle (it splits on ";" and ":")
	const decls = css.split(";").filter((d) => d.trim().length > 0);
	assert.equal(decls.length, (css.match(/:/g) ?? []).length);
});

test("the wrap class the engine adds is the one the stylesheet styles", () => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const theme = fs.readFileSync(path.join(here, "..", "src", "styles", "theme.css"), "utf8");
	assert.ok(theme.includes(`td.${WRAP_CLASS}`), `theme.css has no rule for td.${WRAP_CLASS}`);
	assert.match(theme, new RegExp(`td\\.${WRAP_CLASS}[^{]*\\{[^}]*white-space:\\s*pre-wrap`));
	// the mobile safe-area fix has to use Obsidian's own variable, because
	// env(safe-area-inset-bottom) resolves to 0px in its Android WebView
	assert.match(theme, /padding-bottom: calc\(12px \+ var\(--safe-area-inset-bottom/);
});

/* ------------------------------------------------- 1.3.0: view + freeze */

test("fixed page key order: view and freeze sit between merges and cells", () => {
	const text = serializeSheet(newSheetDoc());
	const keys = text
		.split("\n")
		.map((l) => /^\s{6}"([a-zA-Z]+)":/.exec(l))
		.filter(Boolean)
		.map((m) => m[1]);
	assert.deepEqual(keys, [
		"name",
		"rows",
		"cols",
		"colWidths",
		"rowHeights",
		"merges",
		"view",
		"freeze",
		"cells",
	]);
});

test("an untouched page writes both new blocks as empty objects", () => {
	const text = serializeSheet(newSheetDoc());
	assert.ok(text.includes('      "view": {},'), text);
	assert.ok(text.includes('      "freeze": {},'), text);
});

test("sort and freeze round-trip through the file", () => {
	const doc = newSheetDoc();
	doc.sheets[0].view = { sort: { col: 2, dir: "desc" } };
	doc.sheets[0].freeze = { rows: 1, cols: 2 };
	const text = serializeSheet(doc);
	assert.ok(text.includes('"sort": { "col": 2, "dir": "desc" }'), text);
	assert.ok(text.includes('"freeze": { "rows": 1, "cols": 2 }'), text);
	const back = parseSheet(text);
	assert.deepEqual(back.sheets[0].view, { sort: { col: 2, dir: "desc" } });
	assert.deepEqual(back.sheets[0].freeze, { rows: 1, cols: 2 });
	assert.equal(serializeSheet(back), text);
});

test("filters round-trip, one value per line, sorted and deduplicated", () => {
	const doc = newSheetDoc();
	doc.sheets[0].view = { filters: { 1: ["Gadget", "Widget", "Gadget"], 0: ["b"] } };
	const text = serializeSheet(doc);
	const back = parseSheet(text);
	assert.deepEqual(back.sheets[0].view.filters, { 0: ["b"], 1: ["Gadget", "Widget"] });
	// columns in numeric order, values one per line (a LiveSync-sized diff)
	assert.match(text, /"filters": \{\n\s+"0": \[\n\s+"b"\n\s+\],\n\s+"1": \[\n\s+"Gadget",\n\s+"Widget"\n\s+\]/);
	assert.equal(serializeSheet(back), text);
});

test("view and freeze are deterministic whatever order they were built in", () => {
	const a = newSheetDoc();
	a.sheets[0].view = { sort: { col: 1, dir: "asc" }, filters: { 2: ["x", "y"], 0: ["q"] } };
	a.sheets[0].freeze = { rows: 2, cols: 1 };

	const b = newSheetDoc();
	// same content, every key and every value inserted in the opposite order
	b.sheets[0].view = { filters: { 0: ["q"], 2: ["y", "x"] }, sort: { dir: "asc", col: 1 } };
	b.sheets[0].freeze = { cols: 1, rows: 2 };

	assert.equal(serializeSheet(a), serializeSheet(b));
	const once = serializeSheet(a);
	assert.equal(serializeSheet(parseSheet(once)), once);
	assert.equal(serializeSheet(parseSheet(serializeSheet(parseSheet(once)))), once);
});

test("garbage in view/freeze is dropped, never written back", () => {
	const doc = parseSheet(
		serializeSheet(newSheetDoc()).replace(
			'"view": {},',
			'"view": { "sort": { "col": -3, "dir": "sideways" }, "filters": { "x": ["a"], "1": "nope", "2": [] }, "zoom": 3 },',
		).replace('"freeze": {},', '"freeze": { "rows": -1, "cols": 900, "depth": 4 },'),
	);
	// col -3 is not a column; "sideways" degrades to ascending, not to nothing
	assert.deepEqual(doc.sheets[0].view, {});
	// rows: -1 dropped, cols: 900 is beyond the grid, so it goes too
	assert.deepEqual(doc.sheets[0].freeze, {});
	const out = serializeSheet(doc);
	assert.ok(!out.includes("zoom"), out);
	assert.ok(!out.includes("depth"), out);
});

test("a sort or filter naming a column outside the grid is dropped on load", () => {
	const doc = newSheetDoc();
	doc.sheets[0].cols = 3;
	doc.sheets[0].view = { sort: { col: 9, dir: "asc" }, filters: { 9: ["a"], 1: ["b"] } };
	doc.sheets[0].freeze = { rows: 400, cols: 2 };
	const back = parseSheet(serializeSheet(doc));
	assert.deepEqual(back.sheets[0].view, { filters: { 1: ["b"] } });
	assert.deepEqual(back.sheets[0].freeze, { cols: 2 });
});

test("a version 2 file gains only the two empty blocks", () => {
	const v2 = serializeSheet(newSheetDoc())
		.replace('"version": 4', '"version": 2')
		.replace('      "view": {},\n', "")
		.replace('      "freeze": {},\n', "");
	const doc = parseSheet(v2);
	assert.equal(doc.version, 2);
	assert.deepEqual(doc.sheets[0].view, {});
	assert.deepEqual(doc.sheets[0].freeze, {});
	const written = serializeSheet(doc);
	const added = written.split("\n").filter((l) => !v2.split("\n").includes(l));
	assert.deepEqual(added, ['  "version": 4,', '      "view": {},', '      "freeze": {},']);
});

/* ------------------------------------------------ 1.4.0: the cell type `t` */

test("a cell type is normalized and everything else is dropped", () => {
	assert.equal(normalizeCellType("cb"), "cb");
	assert.equal(normalizeCellType("CB"), "cb");
	assert.equal(normalizeCellType("checkbox"), "cb");
	for (const junk of ["", "dd", "dropdown", "x", 1, true, null, undefined, {}]) {
		assert.equal(normalizeCellType(junk), undefined, JSON.stringify(junk));
	}
});

test("a checkbox reads its value the way a checkbox has to", () => {
	for (const on of [true, 1, "true", "TRUE", " yes ", "1"]) {
		assert.equal(isCheckedValue(on), true, JSON.stringify(on));
	}
	for (const off of [false, 0, "", "false", "no", "anything", undefined, null]) {
		assert.equal(isCheckedValue(off), false, JSON.stringify(off));
	}
});

test("`t` is serialized after `s`, one cell per line", () => {
	const doc = newSheetDoc();
	doc.sheets[0].cells = {
		A1: { v: true, s: { b: true }, t: "cb" },
		A2: { v: false, t: "cb" },
	};
	const text = serializeSheet(doc);
	assert.ok(
		text.includes('"A1": { "v": true, "s": { "b": true }, "t": "cb" }'),
		text.split("\n").find((l) => l.includes("A1")),
	);
	assert.ok(text.includes('"A2": { "v": false, "t": "cb" }'));
	const back = parseSheet(text);
	assert.equal(back.sheets[0].cells.A1.t, "cb");
	assert.equal(back.sheets[0].cells.A1.v, true);
	assert.equal(back.sheets[0].cells.A2.v, false);
	// byte-stable, like every other key
	assert.equal(serializeSheet(back), text);
});

test("an unticked checkbox is not an empty cell", () => {
	// Otherwise the box would vanish on the next save: `false` and "no value"
	// look the same to a sparse writer that only knows about values and styles.
	assert.equal(isEmptyCell({ t: "cb" }), false);
	assert.equal(isEmptyCell({ v: false, t: "cb" }), false);
	assert.equal(isEmptyCell({}), true);
	assert.equal(isEmptyCell({ v: "" }), true);
	const doc = newSheetDoc();
	doc.sheets[0].cells = { B2: { t: "cb" } };
	const back = parseSheet(serializeSheet(doc));
	assert.equal(back.sheets[0].cells.B2.t, "cb");
});

test("an unknown cell type is dropped rather than carried around", () => {
	const text = serializeSheet(newSheetDoc()).replace(
		'"cells": {}',
		'"cells": {\n        "A1": { "v": 1, "t": "dropdown" }\n      }',
	);
	const doc = parseSheet(text);
	assert.equal(doc.sheets[0].cells.A1.v, 1);
	assert.equal(doc.sheets[0].cells.A1.t, undefined);
});

test("a v3 file gains nothing at all until a checkbox is put in it", () => {
	// The 3 -> 4 bump changes the version line and nothing else: `t` is written
	// only for the cells that have one.
	const v3 = serializeSheet(newSheetDoc()).replace('"version": 4', '"version": 3');
	const doc = parseSheet(v3);
	const written = serializeSheet(doc);
	const added = written.split("\n").filter((l) => !v3.split("\n").includes(l));
	assert.deepEqual(added, ['  "version": 4,']);
});

/* ------------------------------------------- how a cell is PAINTED, 1.5.x */

test("a number is a number; text that contains one is not", () => {
	for (const yes of [0, -5, 3.14, 1e6, "42", " 42 ", "-0.5", ".5", "1e3"]) {
		assert.equal(looksNumeric(yes), true, JSON.stringify(yes));
	}
	for (const no of ["", "  ", "Товар 1", "1 item", "2026-01-01", "1,5", "=A1", true, null, {}, NaN]) {
		assert.equal(looksNumeric(no), false, JSON.stringify(no));
	}
});

test("every palette fill stays readable after the dark theme dims it", () => {
	// The cell's ink is picked from the UNDIMMED colour (contrastColor is what
	// the file's own style string carries), so the dim can only ever eat into
	// the contrast. This is the guarantee that says how far it may eat.
	for (const { value } of FILL_COLORS) {
		if (!value) continue;
		const ink = contrastColor(value);
		const painted = dimmedFill(value);
		const ratio = contrastRatio(ink, painted);
		assert.ok(
			ratio >= 4.5,
			`${value} dims to ${painted}, ink ${ink}, contrast ${ratio.toFixed(2)} (needs 4.5)`,
		);
	}
});

test("the dim is a dim: darker than the fill, and not by more than it says", () => {
	assert.equal(DARK_FILL_DIM > 0 && DARK_FILL_DIM < 0.5, true);
	// 28% of #1e1e1e over #ffffff.
	assert.equal(dimmedFill("#ffffff", 0.28, "#1e1e1e"), "#c0c0c0");
	assert.equal(dimmedFill("#ffffff", 0, "#1e1e1e"), "#ffffff");
	assert.equal(dimmedFill("#ffffff", 1, "#1e1e1e"), "#1e1e1e");
	// Anything that is not a plain hex is returned untouched rather than mangled.
	assert.equal(dimmedFill("var(--x)"), "var(--x)");
});

test("contrastRatio agrees with the WCAG extremes", () => {
	assert.equal(Math.round(contrastRatio("#000000", "#ffffff")), 21);
	assert.equal(contrastRatio("#777777", "#777777"), 1);
	// Symmetric, whichever way round the pair is given.
	assert.equal(contrastRatio("#123456", "#abcdef"), contrastRatio("#abcdef", "#123456"));
});

test("the palette is the one the toolbar draws: twelve swatches, one of them empty", () => {
	assert.equal(FILL_COLORS.length, 12);
	assert.equal(FILL_COLORS.filter((c) => c.value === null).length, 1);
	for (const { value } of FILL_COLORS) {
		if (value) assert.match(value, /^#[0-9a-f]{6}$/);
	}
});
