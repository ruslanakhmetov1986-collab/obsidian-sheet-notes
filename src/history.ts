/**
 * Document-level undo/redo.
 *
 * WHY THE DOCUMENT AND NOT THE GRID. The bundled engine keeps an undo stack of
 * its own, and it only ever saw the operations IT performs: a typed value, a
 * style, a resize. Everything this plugin added on top - sorting (which rewrites
 * the page and remounts the grid), merging, a rich paste, a cut completed by a
 * paste, fill-down, inserting or deleting rows through our own context menu -
 * happens at the level of the DOCUMENT, and was simply irreversible. Worse, the
 * two levels disagreed: after a sort the vendor's stack still held entries that
 * belonged to a grid that no longer existed, so one Ctrl+Z could undo something
 * the user had done three operations ago, or nothing at all.
 *
 * So the history lives one floor up, at the same choke point that feeds
 * autosave: every change that reaches `scheduleSave()` also reaches here. One
 * entry is one SERIALIZED DOCUMENT - the very bytes that would be written to
 * disk - which makes the guarantee the tests check for trivially true: undoing
 * an operation restores the file byte for byte, whatever the operation was and
 * however deep in the grid it reached.
 *
 * WHY SNAPSHOTS AND NOT INVERSE PATCHES. Measured on the shapes this plugin
 * actually opens (see the release report): a 100x26 sheet with 500 filled cells
 * serializes to ~34 KB and takes ~1.5 ms; the 20x8 sheets a note-taker really
 * keeps are 2-4 KB. A hundred steps of the big one is 3.4 MB of strings - less
 * than a single screenshot - and the cap below evicts before that matters. An
 * inverse-patch layer would need one correct inverse per operation (and a new
 * one for every operation added later), which is exactly the class of bug that
 * makes an undo feature worse than none: silently wrong instead of visibly
 * absent. Snapshots have one implementation and one failure mode.
 *
 * gzip was measured too and deliberately NOT used here: `CompressionStream` is
 * asynchronous, so compressing on the way in would make `record()` a promise on
 * the hot path of every keystroke, and the winnings (34 KB -> 3.1 KB) are
 * against a budget that is never reached in memory. The disk snapshots in
 * backups.ts, where a hundred versions per file DO pile up, are gzipped.
 *
 * Nothing in this module knows about Obsidian, the grid or the DOM: it is a
 * stack of strings with two bounds, which is why it is unit-tested directly.
 */

/** Where the cursor was; restored with the state so undo does not lose the place. */
export interface HistoryCursor {
	row: number;
	col: number;
}

/** One point in the document's life: its bytes, and where the user was. */
export interface HistoryState {
	text: string;
	cursor: HistoryCursor | null;
}

/** How many undo steps are kept. Beyond this the oldest is dropped. */
export const HISTORY_MAX_STEPS = 100;

/**
 * Total characters the history may hold across both stacks.
 *
 * 8 MB is ~240 snapshots of the 34 KB sheet measured above, i.e. the step
 * count is what bites first for ordinary documents and this is the backstop for
 * a genuinely large one (a 5000-row export is ~700 KB a snapshot: eleven steps
 * then, and eleven steps of a sheet that size still beats losing the file).
 */
export const HISTORY_MAX_BYTES = 8 * 1024 * 1024;

export interface HistoryOptions {
	maxSteps?: number;
	maxBytes?: number;
}

/**
 * A linear undo history over document snapshots.
 *
 * The model is the usual one: a CURRENT state plus a past and a future stack.
 * `record()` moves the previous current into the past and throws the future
 * away, which is what makes a new edit after an undo branch off rather than
 * leave a stale redo behind.
 */
export class SheetHistory {
	private past: HistoryState[] = [];
	private future: HistoryState[] = [];
	private current: HistoryState | null = null;
	private readonly maxSteps: number;
	private readonly maxBytes: number;

	constructor(opts: HistoryOptions = {}) {
		this.maxSteps = Math.max(1, opts.maxSteps ?? HISTORY_MAX_STEPS);
		this.maxBytes = Math.max(1024, opts.maxBytes ?? HISTORY_MAX_BYTES);
	}

	/**
	 * Start over from a known state. Called when a file is loaded: the history
	 * belongs to the document, and the previous document's steps must not be
	 * reachable from the new one (undoing into another file's bytes would be
	 * data loss dressed up as a feature).
	 */
	reset(text: string, cursor: HistoryCursor | null = null): void {
		this.past = [];
		this.future = [];
		this.current = { text, cursor };
	}

	/** Forget everything, including the baseline. */
	clear(): void {
		this.past = [];
		this.future = [];
		this.current = null;
	}

	/** True once a baseline has been set, i.e. once a document is open. */
	get ready(): boolean {
		return this.current !== null;
	}

	/**
	 * A new state of the document has settled.
	 *
	 * Returns whether it became a step. Identical bytes are NOT a step, and that
	 * is load-bearing rather than an optimisation: applying an undo re-enters
	 * this path (the restored grid schedules its own save), and without the
	 * check every undo would push the state it had just restored, so the next
	 * Ctrl+Z would appear to do nothing.
	 */
	record(text: string, cursor: HistoryCursor | null = null): boolean {
		if (!this.current) {
			this.current = { text, cursor };
			return false;
		}
		if (this.current.text === text) {
			// Same document, possibly a different place in it. Keeping the newer
			// cursor means a redo returns to where the user actually was.
			if (cursor) this.current.cursor = cursor;
			return false;
		}
		this.past.push(this.current);
		this.current = { text, cursor };
		this.future = [];
		this.trim();
		return true;
	}

	canUndo(): boolean {
		return this.past.length > 0;
	}

	canRedo(): boolean {
		return this.future.length > 0;
	}

	/**
	 * Step back. `cursor` is where the user is NOW, remembered on the state being
	 * left so that redoing it comes back to the same cell.
	 */
	undo(cursor: HistoryCursor | null = null): HistoryState | null {
		const previous = this.past.pop();
		if (!previous) return null;
		if (this.current) {
			if (cursor) this.current.cursor = cursor;
			this.future.push(this.current);
		}
		this.current = previous;
		return previous;
	}

	/** Step forward again. */
	redo(cursor: HistoryCursor | null = null): HistoryState | null {
		const next = this.future.pop();
		if (!next) return null;
		if (this.current) {
			if (cursor) this.current.cursor = cursor;
			this.past.push(this.current);
		}
		this.current = next;
		return next;
	}

	/** The state the document is believed to be in right now. */
	head(): HistoryState | null {
		return this.current;
	}

	/** How many steps each direction holds; the toolbar's disabled state. */
	depth(): { undo: number; redo: number } {
		return { undo: this.past.length, redo: this.future.length };
	}

	/** Characters held across both stacks and the current state. */
	bytes(): number {
		let total = this.current?.text.length ?? 0;
		for (const state of this.past) total += state.text.length;
		for (const state of this.future) total += state.text.length;
		return total;
	}

	/**
	 * Enforce both bounds, oldest first.
	 *
	 * The PAST is what gets evicted, never the future: the future only exists
	 * between an undo and the next edit, and dropping it would make a redo the
	 * user is looking at disappear under their hand.
	 *
	 * One step always survives, even when a single snapshot is larger than the
	 * entire budget. A document big enough to blow the cap on its own is exactly
	 * the one where losing the last operation hurts most, and one step of it
	 * still costs a fraction of what the grid itself is holding.
	 */
	private trim(): void {
		while (this.past.length > this.maxSteps) this.past.shift();
		while (this.past.length > 1 && this.bytes() > this.maxBytes) this.past.shift();
	}
}
