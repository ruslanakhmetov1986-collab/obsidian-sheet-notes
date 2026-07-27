/**
 * Embed reference parsing.
 *
 * The shapes here are exactly what Obsidian hands a Markdown post-processor for
 * `![[Budget.sheet#Sheet2!A1:D20|plain]]`, verified against a live sandbox
 * vault: `src` keeps the subpath, the pipe option lands in `alt`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	EMBEDDABLE,
	embedLabel,
	isSheetLink,
	parseEmbedBlock,
	parseEmbedRef,
	parseRange,
} from "./.build/embedsrc.mjs";

/* ------------------------------------------------------------------- links */

test("only spreadsheet links are taken over", () => {
	for (const src of [
		"Budget.sheet",
		"folder/Budget.lsheet",
		"data.csv",
		"Budget.sheet#Sheet2",
		"Budget.sheet#Sheet2!A1:D20",
		"Budget.SHEET",
	]) {
		assert.equal(isSheetLink(src), true, src);
	}
	for (const src of [
		"note.md",
		"image.png",
		"Budget.sheetx",
		"sheet",
		"",
		null,
		undefined,
		42,
		"Budget.sheet.md",
	]) {
		assert.equal(isSheetLink(src), false, JSON.stringify(src));
	}
	assert.deepEqual(EMBEDDABLE, ["sheet", "lsheet", "csv"]);
});

test("a plain link is just a path", () => {
	assert.deepEqual(parseEmbedRef("Budget.sheet", "Budget.sheet"), {
		path: "Budget.sheet",
		plain: false,
	});
	assert.deepEqual(parseEmbedRef("folder/sub/Budget.lsheet"), {
		path: "folder/sub/Budget.lsheet",
		plain: false,
	});
});

test("the subpath carries the worksheet name and the range", () => {
	assert.deepEqual(parseEmbedRef("Budget.sheet#Sheet2"), {
		path: "Budget.sheet",
		sheet: "Sheet2",
		plain: false,
	});
	assert.deepEqual(parseEmbedRef("Budget.sheet#Sheet2!A1:D20"), {
		path: "Budget.sheet",
		sheet: "Sheet2",
		range: { r1: 0, c1: 0, r2: 19, c2: 3 },
		plain: false,
	});
	// a range with no sheet name
	assert.deepEqual(parseEmbedRef("Budget.sheet#B2:C3"), {
		path: "Budget.sheet",
		range: { r1: 1, c1: 1, r2: 2, c2: 2 },
		plain: false,
	});
	// a sheet whose name itself contains a bang and no valid range after it
	assert.deepEqual(parseEmbedRef("Budget.sheet#Wow!"), {
		path: "Budget.sheet",
		sheet: "Wow!",
		plain: false,
	});
});

test("|plain is read from the alt attribute, which is where Obsidian puts it", () => {
	assert.equal(parseEmbedRef("Budget.sheet", "plain").plain, true);
	assert.equal(parseEmbedRef("Budget.sheet#Sheet1!A1:B3", "plain").plain, true);
	// and still works when the pipe survives inside src (code block form)
	assert.equal(parseEmbedRef("Budget.sheet|plain").plain, true);
	assert.equal(parseEmbedRef("Budget.sheet|plain").path, "Budget.sheet");
	// an ordinary alias is not an option
	assert.equal(parseEmbedRef("Budget.sheet", "my budget").plain, false);
	assert.equal(parseEmbedRef("Budget.sheet|my budget").plain, false);
});

test("garbage in, null out", () => {
	for (const src of ["", "   ", "#Sheet2", null, undefined, 42, {}]) {
		assert.equal(parseEmbedRef(src), null, JSON.stringify(src));
	}
});

/* ------------------------------------------------------------------ ranges */

test("ranges are normalized so r1/c1 is the top-left corner", () => {
	assert.deepEqual(parseRange("A1:D20"), { r1: 0, c1: 0, r2: 19, c2: 3 });
	// written backwards, meaning the same rectangle
	assert.deepEqual(parseRange("D20:A1"), { r1: 0, c1: 0, r2: 19, c2: 3 });
	assert.deepEqual(parseRange("b2"), { r1: 1, c1: 1, r2: 1, c2: 1 });
	assert.deepEqual(parseRange("AA10:AB11"), { r1: 9, c1: 26, r2: 10, c2: 27 });
	for (const bad of ["", "A", "1:2", "A0:B1", "A1:B2:C3", "хА1", null, 7]) {
		assert.equal(parseRange(bad), undefined, JSON.stringify(bad));
	}
});

/* ------------------------------------------------------------- code blocks */

test("a code block accepts the one-line wikilink spelling", () => {
	assert.deepEqual(parseEmbedBlock("Budget.sheet#Sheet2!A1:D20|plain"), {
		path: "Budget.sheet",
		sheet: "Sheet2",
		range: { r1: 0, c1: 0, r2: 19, c2: 3 },
		plain: true,
	});
	assert.deepEqual(parseEmbedBlock("\n\n  Budget.sheet  \n"), {
		path: "Budget.sheet",
		plain: false,
	});
});

test("a code block accepts keys in any order", () => {
	const ref = parseEmbedBlock(
		["range: A1:C5", "plain: true", "sheet: Numbers", "path: folder/Budget.sheet"].join("\n"),
	);
	assert.deepEqual(ref, {
		path: "folder/Budget.sheet",
		sheet: "Numbers",
		range: { r1: 0, c1: 0, r2: 4, c2: 2 },
		plain: true,
	});
});

test("plain: false in a block really means false", () => {
	assert.equal(parseEmbedBlock("path: Budget.sheet\nplain: false").plain, false);
	assert.equal(parseEmbedBlock("path: Budget.sheet\nplain: no").plain, false);
	assert.equal(parseEmbedBlock("path: Budget.sheet\nplain: yes").plain, true);
});

test("a block with nothing usable in it parses to null", () => {
	assert.equal(parseEmbedBlock(""), null);
	assert.equal(parseEmbedBlock("\n# just a comment\n"), null);
	assert.equal(parseEmbedBlock("sheet: Sheet2"), null);
});

test("a keyed block still tolerates a stray path line", () => {
	assert.deepEqual(parseEmbedBlock("Budget.sheet\nrange: A1:B2"), {
		path: "Budget.sheet",
		range: { r1: 0, c1: 0, r2: 1, c2: 1 },
		plain: false,
	});
});

/* ------------------------------------------------------------------- label */

test("the header label names the file, the sheet and the range", () => {
	assert.equal(embedLabel({ path: "Budget.sheet", plain: false }, "Budget"), "Budget");
	assert.equal(
		embedLabel({ path: "Budget.sheet", sheet: "Sheet2", plain: false }, "Budget"),
		"Budget · Sheet2",
	);
	assert.equal(
		embedLabel(
			{ path: "Budget.sheet", sheet: "Sheet2", range: { r1: 0, c1: 0, r2: 19, c2: 3 }, plain: false },
			"Budget",
		),
		"Budget · Sheet2 · A1:D20",
	);
	// a one-cell range is not written as A1:A1
	assert.equal(
		embedLabel({ path: "Budget.sheet", range: { r1: 1, c1: 1, r2: 1, c2: 1 }, plain: false }, "B"),
		"B · B2",
	);
});
