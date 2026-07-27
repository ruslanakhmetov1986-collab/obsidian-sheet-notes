/**
 * The `.xlsx` bridge, driven through the REAL library.
 *
 * Not a mock: the whole risk of this feature lives in what SheetJS does and does
 * not do (its community reader drops the per-cell style index and every border
 * side, its community WRITER ignores cell styles altogether, which is why the
 * package here is the style-writing fork). A test against a stub would prove
 * nothing about any of that.
 *
 * The centrepiece is the round trip: a document with everything the format can
 * carry is exported, read back, and compared key by key.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	docToWorkbook,
	formulaFromXlsx,
	formulaToXlsx,
	readXlsx,
	sheetNameForXlsx,
	writeXlsx,
} from "./.build/xlsx.mjs";
import {
	argbToHex,
	hexToArgb,
	parseBorderSides,
	parseCellXfIndexes,
	parseSheetPaths,
	ptToPx,
	pxToPt,
	styleToXlsx,
	xlsxToStyle,
} from "./.build/xlsxstyles.mjs";
import { newSheetDoc, newSheetPage, parseSheet, serializeSheet } from "./.build/format.mjs";

const XLSX = (await import("xlsx-js-style")).default;

/** A document that uses every key the format has. */
function fixture() {
	const doc = newSheetDoc();
	const page = doc.sheets[0];
	page.name = "Budget";
	page.cells = {
		A1: { v: "Item", s: { b: true, fs: 18, bg: "#fff2cc", bd: "trbl" } },
		B1: { v: "Qty", s: { b: true, ha: "r" } },
		A2: { v: "Widget", s: { wrap: true } },
		B2: { v: 3, s: { nf: "$#,##0.00", ha: "r", va: "t" } },
		C2: { f: "=B2*2" },
		A3: { v: "Gadget" },
		B3: { v: 4.5 },
		C3: { f: "=IF(B3>1;1;0)" },
		A4: { v: true },
		B4: { v: false, t: "cb" },
		A5: { v: "[[Note]] link" },
	};
	page.colWidths = { 0: 180, 2: 60 };
	page.rowHeights = { 1: 40 };
	page.merges = { A7: [3, 2] };

	const second = newSheetPage("Second");
	second.cells = { A1: { v: "Other", s: { b: true } }, B1: { v: 7 } };
	doc.sheets.push(second);
	return doc;
}

function roundTrip(doc) {
	const bytes = writeXlsx(XLSX, doc);
	assert.ok(bytes.length > 1000, "an xlsx is a zip and is never tiny");
	// "PK": it really is a zip, not a CSV with the wrong extension.
	assert.equal(bytes[0], 0x50);
	assert.equal(bytes[1], 0x4b);
	return readXlsx(XLSX, bytes);
}

/* --------------------------------------------------------- the round trip */

test("export -> import keeps the values and the formulas", () => {
	const back = roundTrip(fixture());
	const page = back.sheets[0];
	assert.equal(page.cells.A1.v, "Item");
	assert.equal(page.cells.A2.v, "Widget");
	assert.equal(page.cells.B2.v, 3);
	assert.equal(page.cells.B3.v, 4.5);
	assert.equal(page.cells.C2.f, "=B2*2");
	// A wiki link is an ordinary string and travels as one.
	assert.equal(page.cells.A5.v, "[[Note]] link");
});

test("a semicolon formula becomes a comma one and comes back readable", () => {
	const back = roundTrip(fixture());
	// Excel only knows commas, so that is what the FILE gets; reading it back
	// gives a formula the grid's own engine accepts too.
	assert.equal(back.sheets[0].cells.C3.f, "=IF(B3>1,1,0)");
});

test("export -> import keeps bold, size, fill, borders, masks and alignment", () => {
	const page = roundTrip(fixture()).sheets[0];
	assert.equal(page.cells.A1.s.b, true, "bold");
	assert.equal(page.cells.A1.s.fs, 18, "font size in px");
	assert.equal(page.cells.A1.s.bg, "#fff2cc", "fill");
	assert.equal(page.cells.A1.s.bd, "trbl", "all four borders");
	assert.equal(page.cells.B1.s.b, true);
	assert.equal(page.cells.B1.s.ha, "r");
	assert.equal(page.cells.B2.s.nf, "$#,##0.00", "number mask");
	assert.equal(page.cells.B2.s.ha, "r");
	assert.equal(page.cells.B2.s.va, "t");
	assert.equal(page.cells.A2.s.wrap, true, "wrapped text");
});

test("export -> import keeps column widths, row heights and merges", () => {
	const page = roundTrip(fixture()).sheets[0];
	assert.equal(page.colWidths["0"], 180);
	assert.equal(page.colWidths["2"], 60);
	assert.ok(Math.abs(page.rowHeights["1"] - 40) <= 1, `row height ${page.rowHeights["1"]}`);
	assert.deepEqual(page.merges.A7, [3, 2]);
});

test("every worksheet becomes a page, in order and by name", () => {
	const back = roundTrip(fixture());
	assert.equal(back.sheets.length, 2);
	assert.equal(back.sheets[0].name, "Budget");
	assert.equal(back.sheets[1].name, "Second");
	assert.equal(back.sheets[1].cells.A1.v, "Other");
	assert.equal(back.sheets[1].cells.A1.s.b, true);
	assert.equal(back.sheets[1].cells.B1.v, 7);
});

test("a checkbox arrives as the boolean it means: xlsx has no such cell", () => {
	const page = roundTrip(fixture()).sheets[0];
	assert.equal(page.cells.B4.v, false);
	assert.equal(page.cells.B4.t, undefined, "the type is ours, the file has no place for it");
	assert.equal(page.cells.A4.v, true, "a plain boolean survives as one");
});

test("the imported document is a valid sheet file and re-serializes", () => {
	const back = roundTrip(fixture());
	const text = serializeSheet(back);
	const reparsed = parseSheet(text);
	assert.equal(reparsed.version, 4);
	assert.equal(reparsed.sheets.length, 2);
	assert.equal(reparsed.sheets[0].cells.A1.s.b, true);
	// deterministic, like every other write path
	assert.equal(serializeSheet(reparsed), text);
});

test("an imported sheet is at least a full grid, never three rows", () => {
	const small = newSheetDoc();
	small.sheets[0].cells = { A1: { v: "x" } };
	const page = roundTrip(small).sheets[0];
	assert.ok(page.rows >= 100, `rows ${page.rows}`);
	assert.ok(page.cols >= 26, `cols ${page.cols}`);
});

test("an empty document survives the trip instead of throwing", () => {
	const back = roundTrip(newSheetDoc());
	assert.equal(back.sheets.length, 1);
	assert.deepEqual(back.sheets[0].cells, {});
});

/* ------------------------------------------------------------- the pieces */

test("formulas: separators are converted outside strings only", () => {
	assert.equal(formulaToXlsx("=SUM(B2:B3)"), "SUM(B2:B3)");
	assert.equal(formulaToXlsx('=IF(A1>5;"yes";"no")'), 'IF(A1>5,"yes","no")');
	// a semicolon INSIDE a string is the user's text, not an argument separator
	assert.equal(formulaToXlsx('=CONCAT("a;b";"c")'), 'CONCAT("a;b","c")');
	assert.equal(formulaFromXlsx("SUM(A1:A2)"), "=SUM(A1:A2)");
	assert.equal(formulaFromXlsx("=SUM(A1:A2)"), "=SUM(A1:A2)");
	assert.equal(formulaFromXlsx(""), undefined);
	assert.equal(formulaFromXlsx(undefined), undefined);
});

test("worksheet names are cut and cleaned the way Excel demands", () => {
	const taken = new Set();
	assert.equal(sheetNameForXlsx("Budget", 0, taken), "Budget");
	assert.equal(sheetNameForXlsx("a/b:c*d?e[f]", 1, taken), "a-b-c-d-e-f-");
	assert.equal(sheetNameForXlsx("x".repeat(40), 2, taken).length, 31);
	assert.equal(sheetNameForXlsx("", 3, taken), "Sheet4");
	// a duplicate is numbered rather than silently dropped by the library
	assert.equal(sheetNameForXlsx("Budget", 4, taken), "Budget (2)");
});

test("colours cross the boundary as ARGB", () => {
	assert.equal(hexToArgb("#fff2cc"), "FFFFF2CC");
	assert.equal(argbToHex("FFFFF2CC"), "#fff2cc");
	assert.equal(argbToHex("FFF2CC"), "#fff2cc");
	assert.equal(argbToHex("nope"), undefined);
	assert.equal(argbToHex(undefined), undefined);
});

test("font sizes cross it as points", () => {
	assert.equal(pxToPt(16), 12);
	assert.equal(ptToPx(12), 16);
	assert.equal(ptToPx(pxToPt(18)), 18);
});

test("styleToXlsx writes only what the style actually has", () => {
	assert.equal(styleToXlsx(undefined), undefined);
	assert.equal(styleToXlsx({}), undefined);
	const s = styleToXlsx({ b: true, bg: "#fff2cc", bd: "tb", nf: "0.00", ha: "c", wrap: true });
	assert.equal(s.font.bold, true);
	assert.equal(s.fill.fgColor.rgb, "FFFFF2CC");
	assert.deepEqual(Object.keys(s.border).sort(), ["bottom", "top"]);
	assert.equal(s.alignment.horizontal, "center");
	assert.equal(s.alignment.wrapText, true);
	assert.equal(s.numFmt, "0.00");
});

test("xlsxToStyle drops what is not a style: General, junk, absurd sizes", () => {
	assert.equal(xlsxToStyle({ numFmt: "General" }), undefined);
	assert.equal(xlsxToStyle({ numFmt: "general" }), undefined);
	assert.equal(xlsxToStyle({ sz: 2 }), undefined, "3 px type is a corrupt file");
	assert.equal(xlsxToStyle({ fgColor: "not a colour" }), undefined);
	assert.deepEqual(xlsxToStyle({ bold: true, sides: "tb" }), { b: true, bd: "tb" });
	assert.deepEqual(xlsxToStyle({ alignment: { vertical: "center" } }), { va: "m" });
});

/* ------------------------------- what SheetJS's own reader does not return */

test("the per-cell style index is read out of the sheet XML", () => {
	const xml =
		'<sheetData><row r="1"><c r="A1" s="3" t="str"><v>Head</v></c>' +
		'<c r="B1" t="str"><v>no style</v></c></row>' +
		'<row r="2"><c s="7" r="A2"><v>1</v></c></row></sheetData>';
	assert.deepEqual(parseCellXfIndexes(xml), { A1: 3, A2: 7 });
	assert.deepEqual(parseCellXfIndexes(""), {});
	assert.deepEqual(parseCellXfIndexes(null), {});
});

test("border sides are read out of styles.xml, index by index", () => {
	const xml =
		"<styleSheet><borders count=\"3\">" +
		"<border><left/><right/><top/><bottom/><diagonal/></border>" +
		'<border><left style="thin"><color rgb="FF000000"/></left><right/>' +
		'<top style="thin"><color rgb="FF000000"/></top><bottom/><diagonal/></border>' +
		'<border/>' +
		"</borders></styleSheet>";
	assert.deepEqual(parseBorderSides(xml), ["", "tl", ""]);
	assert.deepEqual(parseBorderSides("<styleSheet/>"), []);
});

test("a border with style=none is not a border", () => {
	const xml =
		'<borders count="1"><border><left style="none"/><right style="medium"/>' +
		"<top/><bottom/></border></borders>";
	assert.deepEqual(parseBorderSides(xml), ["r"]);
});

test("worksheet parts are found through the relationships, not by guessing", () => {
	const workbook =
		'<workbook><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/>' +
		'<sheet name="Se&amp;cond" sheetId="2" r:id="rId7"/></sheets></workbook>';
	const rels =
		'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/>' +
		'<Relationship Id="rId7" Target="/xl/worksheets/sheet9.xml"/>' +
		'<Relationship Id="rId8" Target="styles.xml"/></Relationships>';
	assert.deepEqual(parseSheetPaths(workbook, rels), {
		Budget: "xl/worksheets/sheet1.xml",
		"Se&cond": "xl/worksheets/sheet9.xml",
	});
	assert.deepEqual(parseSheetPaths("", ""), {});
});

test("the workbook we hand the library has one worksheet per page", () => {
	const wb = docToWorkbook(XLSX, fixture());
	assert.deepEqual(wb.SheetNames, ["Budget", "Second"]);
	const ws = wb.Sheets.Budget;
	assert.equal(ws.A1.v, "Item");
	assert.equal(ws.C2.f, "B2*2");
	assert.equal(ws["!merges"].length, 1);
	assert.ok(ws["!ref"].startsWith("A1:"), ws["!ref"]);
});
