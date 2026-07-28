/**
 * The plugin's own clipboard store: the payload a copy keeps beside the plain
 * text on the system clipboard, and the promise a cut leaves behind.
 *
 * Everything here is the PURE half - the module knows nothing about the grid.
 * The owner of a cut is a stub with the two methods clipboard.ts asks for,
 * which is exactly how a sheet in another tab looks to it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	applyPendingCut,
	cancelCut,
	clipFor,
	isEmptyClip,
	makeClip,
	normalizeClipCell,
	peekClip,
	pendingCut,
	resetClipboard,
	setClip,
	tsvFingerprint,
} from "./.build/clipboard.mjs";

/** A stand-in for a SheetEngine: records what a cut did to it. */
function fakeOwner() {
	return {
		marks: [],
		cleared: [],
		markCutRange(rect) {
			this.marks.push(rect);
		},
		clearRect(rect) {
			this.cleared.push(rect);
		},
	};
}

const RECT = { r1: 0, c1: 0, r2: 1, c2: 1 };

/** A formatted 2x2 range: a literal, a formula, a fill, a mask, a checkbox. */
function richCells() {
	return [
		[
			{ v: "Fruit", s: { b: true, bg: "#ffe08a" } },
			{ v: 3, s: { nf: "0.00", ha: "r" } },
		],
		[
			{ f: "=A1", v: "ignored because there is a formula" },
			{ v: true, t: "cb", s: { bd: "trbl" } },
		],
	];
}

test.beforeEach(() => resetClipboard());

/* ------------------------------------------------------------ fingerprint */

test("tsvFingerprint: CRLF, bare CR and trailing newlines all fold together", () => {
	const want = "a\tb\nc\td";
	assert.equal(tsvFingerprint("a\tb\r\nc\td"), want);
	assert.equal(tsvFingerprint("a\tb\rc\td"), want);
	assert.equal(tsvFingerprint("a\tb\nc\td\n"), want);
	assert.equal(tsvFingerprint("a\tb\r\nc\td\r\n\r\n"), want);
});

test("tsvFingerprint: anything that is not a string is the empty fingerprint", () => {
	for (const bad of [undefined, null, 7, {}, []]) assert.equal(tsvFingerprint(bad), "");
});

/* ------------------------------------------------------------- normalizing */

test("normalizeClipCell keeps the file format's own shape", () => {
	assert.deepEqual(normalizeClipCell({ v: "x" }), { v: "x" });
	assert.deepEqual(normalizeClipCell({ v: 0 }), { v: 0 });
	assert.deepEqual(normalizeClipCell({ v: false }), { v: false });
	// An empty string is not a value: it is what an untouched cell reads as.
	assert.deepEqual(normalizeClipCell({ v: "" }), {});
	// A formula wins over the literal the engine cached for it.
	assert.deepEqual(normalizeClipCell({ f: "=A1+1", v: "7" }), { f: "=A1+1" });
	// "=" is what makes a formula; a stray string is a value.
	assert.deepEqual(normalizeClipCell({ f: "A1+1" }), {});
	assert.deepEqual(normalizeClipCell({ t: "checkbox" }), { t: "cb" });
	assert.deepEqual(normalizeClipCell({ t: "radio" }), {});
	assert.deepEqual(normalizeClipCell({ s: {} }), {});
	assert.deepEqual(normalizeClipCell({ s: { b: true } }), { s: { b: true } });
	assert.deepEqual(normalizeClipCell(undefined), {});
	assert.deepEqual(normalizeClipCell("nonsense"), {});
});

test("a copied style is normalized on the way in, like a loaded one", () => {
	// The engine reads a fill back out of the DOM, where it is `rgb(...)`, and a
	// font size as a string with a unit. Both have to arrive as the file format
	// spells them, or the same cell would compare unequal to itself.
	assert.deepEqual(
		normalizeClipCell({ s: { bg: "rgb(255, 224, 138)", fs: "18px", va: "middle", ha: "center" } }),
		{ s: { fs: 18, bg: "#ffe08a", ha: "c", va: "m" } },
	);
	assert.deepEqual(normalizeClipCell({ s: { bg: "#FE0", b: "bold", bd: "LT" } }), {
		s: { b: true, bg: "#ffee00", bd: "tl" },
	});
	// Out-of-range and unparseable pieces are dropped, not carried.
	assert.deepEqual(normalizeClipCell({ s: { fs: 400, bg: "chartreuse", bd: "zz", ha: "x" } }), {});
});

test("makeClip squares the rectangle off and counts it", () => {
	const clip = makeClip([[{ v: "a" }, { v: "b" }], [{ v: "c" }]], "a\tb\nc\t");
	assert.equal(clip.rows, 2);
	assert.equal(clip.cols, 2);
	assert.deepEqual(clip.cells[1][1], {});
	assert.equal(clip.cut, null);
	assert.equal(makeClip([], "").cols, 0);
});

test("isEmptyClip: no cells, no columns, or nothing but empty cells", () => {
	assert.equal(isEmptyClip(null), true);
	assert.equal(isEmptyClip(makeClip([], "")), true);
	assert.equal(isEmptyClip(makeClip([[{}, {}]], "\t")), true);
	assert.equal(isEmptyClip(makeClip([[{}, { v: "x" }]], "\tx")), false);
});

/* ------------------------------------------------------- the round trip */

test("a rich payload survives store -> fingerprint match -> read back", () => {
	const tsv = "Fruit\t3\n=A1\ttrue";
	setClip(makeClip(richCells(), tsv));

	const back = clipFor(tsv);
	assert.ok(back, "the payload for its own text");
	assert.equal(back.rows, 2);
	assert.equal(back.cols, 2);
	assert.deepEqual(back.cells[0][0], { v: "Fruit", s: { b: true, bg: "#ffe08a" } });
	assert.deepEqual(back.cells[0][1], { v: 3, s: { nf: "0.00", ha: "r" } });
	assert.deepEqual(back.cells[1][0], { f: "=A1" });
	assert.deepEqual(back.cells[1][1], { v: true, t: "cb", s: { bd: "trbl" } });
});

test("the match survives the trip through a real clipboard", () => {
	const tsv = "a\tb\nc\td";
	setClip(makeClip([[{ v: "a" }, { v: "b" }], [{ v: "c" }, { v: "d" }]], tsv));
	// Windows hands the text back with CRLF and often a trailing newline.
	assert.ok(clipFor("a\tb\r\nc\td\r\n"));
});

test("copying anything else anywhere in the OS drops the payload's claim", () => {
	setClip(makeClip([[{ v: "a" }]], "a"));
	assert.equal(clipFor("something the user copied in a browser"), null);
	assert.equal(clipFor(""), null);
	assert.equal(clipFor(undefined), null);
	// ... while the store itself is untouched: the next paste of OUR text is rich again.
	assert.ok(peekClip());
	assert.ok(clipFor("a"));
});

test("an empty payload never claims an empty clipboard", () => {
	setClip(makeClip([[{}]], ""));
	assert.equal(clipFor(""), null);
	assert.equal(clipFor("\r\n"), null);
});

test("with nothing copied there is no payload for any text", () => {
	assert.equal(peekClip(), null);
	assert.equal(clipFor("a"), null);
	assert.equal(pendingCut(), null);
	assert.equal(cancelCut(), false);
	assert.equal(applyPendingCut(), false);
});

/* -------------------------------------------------------------- the cut */

test("a cut marks its source and the next paste clears it, once", () => {
	const owner = fakeOwner();
	setClip(makeClip([[{ v: "a" }]], "a", { owner, rect: RECT }));
	assert.deepEqual(owner.marks, [RECT], "the source is marked as it is cut");
	assert.deepEqual(pendingCut(), { owner, rect: RECT });

	assert.equal(applyPendingCut(), true);
	assert.deepEqual(owner.cleared, [RECT]);
	assert.deepEqual(owner.marks, [RECT, null], "and the marker comes off with it");
	assert.equal(pendingCut(), null);

	// A second paste is an ordinary paste: the source is already gone.
	assert.equal(applyPendingCut(), false);
	assert.deepEqual(owner.cleared, [RECT]);
	// The payload stays, so pasting the same range again still pastes it.
	assert.ok(clipFor("a"));
});

test("Escape withdraws the cut and leaves the source alone", () => {
	const owner = fakeOwner();
	setClip(makeClip([[{ v: "a" }]], "a", { owner, rect: RECT }));

	assert.equal(cancelCut(), true);
	assert.deepEqual(owner.marks, [RECT, null]);
	assert.deepEqual(owner.cleared, [], "nothing was cleared");
	assert.equal(pendingCut(), null);
	// Escape twice is not an error, and the payload is still pasteable.
	assert.equal(cancelCut(), false);
	assert.ok(clipFor("a"));
	assert.equal(applyPendingCut(), false);
	assert.deepEqual(owner.cleared, []);
});

test("copying something else releases the range a cut was holding", () => {
	const owner = fakeOwner();
	setClip(makeClip([[{ v: "a" }]], "a", { owner, rect: RECT }));
	setClip(makeClip([[{ v: "b" }]], "b"));

	assert.deepEqual(owner.marks, [RECT, null], "the old source is unmarked");
	assert.deepEqual(owner.cleared, [], "and it is NOT cleared - nothing was pasted");
	assert.equal(pendingCut(), null);
	assert.ok(clipFor("b"));
});

test("setClip(null) forgets the payload and any cut with it", () => {
	const owner = fakeOwner();
	setClip(makeClip([[{ v: "a" }]], "a", { owner, rect: RECT }));
	setClip(null);
	assert.deepEqual(owner.marks, [RECT, null]);
	assert.deepEqual(owner.cleared, []);
	assert.equal(peekClip(), null);
	assert.equal(clipFor("a"), null);
});

test("a cut can be handed over to a second sheet unchanged", () => {
	// The owner is whoever cut, not whoever pastes: cut in one file, paste in
	// another, and the FIRST file is the one that loses the cells.
	const source = fakeOwner();
	const rect = { r1: 2, c1: 1, r2: 4, c2: 3 };
	setClip(makeClip([[{ v: "x" }]], "x", { owner: source, rect }));
	const held = pendingCut();
	assert.equal(held.owner, source);
	applyPendingCut();
	assert.deepEqual(source.cleared, [rect]);
});

test("re-setting the very same payload does not unmark its own cut", () => {
	const owner = fakeOwner();
	const clip = makeClip([[{ v: "a" }]], "a", { owner, rect: RECT });
	setClip(clip);
	setClip(clip);
	assert.deepEqual(owner.marks, [RECT, RECT], "marked again, never unmarked");
	assert.deepEqual(pendingCut(), { owner, rect: RECT });
});
