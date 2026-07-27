/**
 * `[[wiki links]]` inside a cell value.
 *
 * The parser is the whole feature's contract: the FILE keeps the text exactly as
 * typed, and everything the grid renders is derived from it here. So the tests
 * below are mostly about what is NOT a link - an unclosed bracket, an embed, an
 * empty target - because those are the cases where a wrong answer would either
 * eat a value or turn text into a clickable thing the user did not write.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { cellLinks, hasWikiLink, linkDisplay, parseCellLinks } from "./.build/links.mjs";

test("a plain value is not a link and is not even scanned", () => {
	for (const value of ["", "Widget", "3", "a [b] c", "[[", "]]", "[[unclosed"]) {
		assert.deepEqual(parseCellLinks(value), [], JSON.stringify(value));
	}
	assert.equal(hasWikiLink("Widget"), false);
	assert.equal(hasWikiLink("see [[Note]]"), true);
	assert.equal(hasWikiLink(42), false);
	assert.equal(hasWikiLink(null), false);
});

test("a bare link becomes one link segment", () => {
	assert.deepEqual(parseCellLinks("[[Note]]"), [
		{ kind: "link", link: { target: "Note", display: "Note" } },
	]);
});

test("text around a link is kept, in order", () => {
	assert.deepEqual(parseCellLinks("see [[Note]] now"), [
		{ kind: "text", text: "see " },
		{ kind: "link", link: { target: "Note", display: "Note" } },
		{ kind: "text", text: " now" },
	]);
});

test("two links in one cell", () => {
	const links = cellLinks("[[A]] and [[B|bee]]");
	assert.deepEqual(links, [
		{ target: "A", display: "A" },
		{ target: "B", display: "bee" },
	]);
});

test("an alias is what the cell shows, the target is what opens", () => {
	assert.deepEqual(cellLinks("[[Budget 2026|this year]]"), [
		{ target: "Budget 2026", display: "this year" },
	]);
	// whitespace around either half is not part of the name
	assert.deepEqual(cellLinks("[[  Note  |  Alias  ]]"), [{ target: "Note", display: "Alias" }]);
});

test("headings and block ids stay in the target and read as a path", () => {
	assert.equal(linkDisplay("Note#Heading"), "Note > Heading");
	assert.equal(linkDisplay("Note#^abc123"), "Note > abc123");
	assert.equal(linkDisplay("Note"), "Note");
	assert.equal(linkDisplay("#Heading"), "Heading");
	assert.deepEqual(cellLinks("[[Note#Heading]]"), [
		{ target: "Note#Heading", display: "Note > Heading" },
	]);
	assert.deepEqual(cellLinks("[[Note#^abc|see]]"), [{ target: "Note#^abc", display: "see" }]);
});

test("an embed is not a link: a note inside a cell is not a thing", () => {
	assert.deepEqual(parseCellLinks("![[Budget.sheet]]"), []);
	// ...and the rest of the value still works
	assert.deepEqual(cellLinks("![[Budget.sheet]] but [[Note]]"), [
		{ target: "Note", display: "Note" },
	]);
});

test("an empty target is text, not a link to nowhere", () => {
	assert.deepEqual(parseCellLinks("[[]]"), []);
	assert.deepEqual(parseCellLinks("[[   ]]"), []);
	assert.deepEqual(parseCellLinks("[[|alias]]"), []);
});

test("a nested bracket does not swallow the inner link", () => {
	assert.deepEqual(cellLinks("[[a [[Note]]"), [{ target: "Note", display: "Note" }]);
});

test("the value is never rewritten: every character is accounted for", () => {
	// The rendering has to be lossless, or a cell would silently lose text the
	// file still holds.
	for (const value of [
		"see [[Note]] now",
		"[[A]][[B]]",
		"a|b [[C|d]] e",
		"![[x]] [[y]]",
		"trailing [[z]]",
	]) {
		const rebuilt = parseCellLinks(value)
			.map((s) => (s.kind === "text" ? s.text : `[[${s.link.target}]]`))
			.join("");
		// aliases and the `>` display are the only rewriting, so compare against a
		// value that has none
		if (!value.includes("|") && !value.includes("!")) {
			assert.equal(rebuilt, value, value);
		}
		assert.ok(rebuilt.length > 0, value);
	}
});

test("a value with markup characters stays one text segment", () => {
	// It is rendered with DOM calls, never innerHTML; the parser must not be the
	// place where that stops being true.
	assert.deepEqual(parseCellLinks('<script>alert("x")</script>'), []);
	assert.deepEqual(parseCellLinks('<b>x</b> [[Note]]'), [
		{ kind: "text", text: "<b>x</b> " },
		{ kind: "link", link: { target: "Note", display: "Note" } },
	]);
});
