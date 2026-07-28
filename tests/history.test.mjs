/**
 * The document-level undo history.
 *
 * What is worth testing here is not "does a stack pop": it is the four rules
 * that make one Ctrl+Z mean one operation - identical bytes are not a step, an
 * edit after an undo throws the redo away, the cursor travels with the state,
 * and both bounds evict the OLDEST step rather than the newest.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	HISTORY_MAX_BYTES,
	HISTORY_MAX_STEPS,
	SheetHistory,
} from "./.build/history.mjs";

const at = (row, col) => ({ row, col });

test("a fresh history has nothing to undo or redo", () => {
	const h = new SheetHistory();
	assert.equal(h.ready, false);
	assert.equal(h.canUndo(), false);
	assert.equal(h.canRedo(), false);
	assert.equal(h.undo(), null);
	assert.equal(h.redo(), null);
	assert.equal(h.head(), null);
	assert.deepEqual(h.depth(), { undo: 0, redo: 0 });
});

test("the first record only sets the baseline", () => {
	const h = new SheetHistory();
	assert.equal(h.record("a"), false, "no step: there was nothing to step back to");
	assert.equal(h.ready, true);
	assert.equal(h.canUndo(), false);
	assert.equal(h.head().text, "a");
});

test("reset() also sets the baseline, and drops the previous document", () => {
	const h = new SheetHistory();
	h.reset("one");
	h.record("two");
	assert.equal(h.canUndo(), true);
	h.reset("other file");
	assert.equal(h.canUndo(), false, "undo must not reach into the file we closed");
	assert.equal(h.canRedo(), false);
	assert.equal(h.head().text, "other file");
});

test("undo and redo walk the same line of states", () => {
	const h = new SheetHistory();
	h.reset("s0");
	assert.equal(h.record("s1"), true);
	assert.equal(h.record("s2"), true);
	assert.deepEqual(h.depth(), { undo: 2, redo: 0 });

	assert.equal(h.undo().text, "s1");
	assert.equal(h.undo().text, "s0");
	assert.equal(h.canUndo(), false);
	assert.equal(h.undo(), null, "and it stops at the baseline");
	assert.deepEqual(h.depth(), { undo: 0, redo: 2 });

	assert.equal(h.redo().text, "s1");
	assert.equal(h.redo().text, "s2");
	assert.equal(h.redo(), null);
	assert.equal(h.head().text, "s2");
});

test("identical bytes are not a step", () => {
	const h = new SheetHistory();
	h.reset("same");
	assert.equal(h.record("same"), false);
	assert.equal(h.record("same"), false);
	assert.equal(h.canUndo(), false, "an autosave that changed nothing is not history");
});

test("applying an undo does not push the state it restored", () => {
	// The real sequence: undo remounts the grid, the grid schedules a save, the
	// save path records again. That second record MUST be a no-op or the next
	// Ctrl+Z would appear dead.
	const h = new SheetHistory();
	h.reset("s0");
	h.record("s1");
	const back = h.undo();
	assert.equal(back.text, "s0");
	assert.equal(h.record("s0"), false);
	assert.equal(h.canRedo(), true, "the redo survives the echo");
	assert.equal(h.redo().text, "s1");
});

test("an edit after an undo throws the redo branch away", () => {
	const h = new SheetHistory();
	h.reset("s0");
	h.record("s1");
	h.record("s2");
	h.undo();
	assert.equal(h.canRedo(), true);
	assert.equal(h.record("s1b"), true);
	assert.equal(h.canRedo(), false);
	assert.deepEqual(h.depth(), { undo: 2, redo: 0 });
	assert.equal(h.undo().text, "s1");
});

test("the cursor travels with the state, in both directions", () => {
	const h = new SheetHistory();
	h.reset("s0", at(0, 0));
	h.record("s1", at(3, 4));
	// The user has moved on since; that is where a redo should land.
	const back = h.undo(at(9, 9));
	assert.deepEqual(back.cursor, at(0, 0));
	assert.deepEqual(h.redo().cursor, at(9, 9));
});

test("a cursor-only change updates the head without making a step", () => {
	const h = new SheetHistory();
	h.reset("s0", at(0, 0));
	assert.equal(h.record("s0", at(5, 5)), false);
	assert.deepEqual(h.head().cursor, at(5, 5));
});

test("the step bound evicts the oldest step", () => {
	const h = new SheetHistory({ maxSteps: 3 });
	h.reset("s0");
	for (let i = 1; i <= 6; i++) h.record(`s${i}`);
	assert.deepEqual(h.depth(), { undo: 3, redo: 0 });
	// s3..s5 are what is left to walk back to; s0..s2 are gone.
	assert.equal(h.undo().text, "s5");
	assert.equal(h.undo().text, "s4");
	assert.equal(h.undo().text, "s3");
	assert.equal(h.undo(), null);
});

test("the size bound evicts too, and always leaves at least one step", () => {
	const big = "x".repeat(1000);
	const h = new SheetHistory({ maxSteps: 100, maxBytes: 2500 });
	h.reset(`${big}0`);
	h.record(`${big}1`);
	h.record(`${big}2`);
	h.record(`${big}3`);
	assert.ok(h.bytes() <= 2500 + 1001, `bytes: ${h.bytes()}`);
	assert.ok(h.depth().undo >= 1 && h.depth().undo <= 2, JSON.stringify(h.depth()));
	assert.equal(h.head().text, `${big}3`);
});

test("a single snapshot larger than the whole budget still leaves one step", () => {
	const h = new SheetHistory({ maxBytes: 1024 });
	h.reset("a".repeat(5000));
	h.record("b".repeat(5000));
	assert.equal(h.canUndo(), true, "one step back is the minimum this feature is for");
	assert.equal(h.undo().text.startsWith("a"), true);
});

test("bytes() counts both stacks and the current state", () => {
	const h = new SheetHistory();
	h.reset("12345");
	h.record("1234567890");
	assert.equal(h.bytes(), 15);
	h.undo();
	assert.equal(h.bytes(), 15, "the future is still held");
});

test("clear() forgets even the baseline", () => {
	const h = new SheetHistory();
	h.reset("s0");
	h.record("s1");
	h.clear();
	assert.equal(h.ready, false);
	assert.equal(h.canUndo(), false);
	assert.equal(h.bytes(), 0);
});

test("the shipped bounds are the documented ones", () => {
	assert.equal(HISTORY_MAX_STEPS, 100);
	assert.equal(HISTORY_MAX_BYTES, 8 * 1024 * 1024);
	const h = new SheetHistory();
	h.reset("s0");
	for (let i = 1; i <= 150; i++) h.record(`s${i}`);
	assert.equal(h.depth().undo, HISTORY_MAX_STEPS);
});

test("silly options are clamped rather than obeyed", () => {
	const h = new SheetHistory({ maxSteps: 0, maxBytes: 1 });
	h.reset("a");
	h.record("b");
	assert.equal(h.canUndo(), true);
});
