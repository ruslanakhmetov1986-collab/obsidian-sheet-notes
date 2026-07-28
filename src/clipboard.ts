/**
 * The plugin's own clipboard: the part of a copied range that the system
 * clipboard cannot carry.
 *
 * WHY THERE ARE TWO CLIPBOARDS. Copying a range has to keep doing what it has
 * always done - put tab-separated TEXT on the system clipboard, so the range
 * lands in Excel, in Google Sheets, in a chat window, in a Markdown note. Text
 * is all that survives that trip: a fill, a border, a number mask and the fact
 * that a cell is a tick box are not expressible in it, and a paste back into
 * this plugin therefore arrived stripped of everything but the values.
 *
 * So a copy writes TWICE: the TSV goes to the system clipboard as before, and a
 * structured payload - values, formula sources, styles, cell types - is kept
 * here, in a module-level store that is shared by every sheet view in the app
 * (which is what makes copy from one sheet and paste into another work).
 *
 * WHICH ONE A PASTE USES is decided by the system clipboard, never by this
 * store alone. The payload remembers the exact text that went out with it, and
 * a paste only takes the rich route while the clipboard still holds THAT text.
 * Copy something else anywhere in the OS and the fingerprint stops matching, so
 * the paste falls back to the plain TSV - which is the correct answer, because
 * what the user copied last is what they expect to paste. The alternative,
 * trusting the store, would paste a range the user copied ten minutes ago over
 * whatever they actually meant.
 *
 * A CUT is a copy plus a promise: the source range is remembered and cleared by
 * the NEXT paste, in the same operation that fills the destination, so the file
 * on disk never holds a state where the cells exist twice or nowhere. Escape
 * withdraws the promise and leaves the source alone. The owner is held as a
 * small structural interface rather than as the engine class, both to keep this
 * module engine-free and because the source of a cut can be a sheet in another
 * tab or another window.
 */

import {
	type CellStyle,
	type CellType,
	type CellValue,
	normalizeCellType,
	normalizeStyle,
} from "./format";

export interface ClipRect {
	r1: number;
	c1: number;
	r2: number;
	c2: number;
}

/** One cell of a copied range, in the same shape the file format uses. */
export interface ClipCell {
	/** Literal value. Absent for a pure-formula cell and for an empty one. */
	v?: CellValue;
	/** Formula source including the leading `=`. */
	f?: string;
	/** Normalized style, number mask included. */
	s?: CellStyle;
	/** Cell type; only `"cb"` (checkbox) exists. */
	t?: CellType;
}

/**
 * What a cut needs from the sheet it came from. A `SheetEngine` satisfies it;
 * so does a stub, which is how it is tested.
 */
export interface ClipOwner {
	/** Wipe values, formulas, styles and types out of a rectangle. */
	clearRect(rect: ClipRect): void;
	/** Draw (or, with `null`, remove) the "these cells are cut" marker. */
	markCutRange(rect: ClipRect | null): void;
}

export interface CutMark {
	owner: ClipOwner;
	rect: ClipRect;
}

export interface SheetClip {
	/** The text that went to the SYSTEM clipboard with this payload: the fingerprint. */
	tsv: string;
	rows: number;
	cols: number;
	/** Row-major, `rows` × `cols`. An untouched cell is an empty object. */
	cells: ClipCell[][];
	/** Set by a cut, consumed by the next paste, dropped by Escape. */
	cut: CutMark | null;
}

/**
 * The one text form both sides compare.
 *
 * The system clipboard is not a faithful pipe: Windows normalises line endings
 * to CRLF, and some apps append a trailing newline on the way out. Neither
 * changes which cells were copied, so neither may break the match - measured,
 * an unnormalised comparison failed on Windows for every multi-row range.
 */
export function tsvFingerprint(text: unknown): string {
	if (typeof text !== "string") return "";
	return text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
}

/** Drop anything the file format would not keep, so a payload is comparable. */
export function normalizeClipCell(raw: unknown): ClipCell {
	if (!raw || typeof raw !== "object") return {};
	const src = raw as Record<string, unknown>;
	const out: ClipCell = {};
	const f = src["f"];
	if (typeof f === "string" && f.startsWith("=")) out.f = f;
	const v = src["v"];
	if (out.f === undefined && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) {
		if (v !== "") out.v = v;
	}
	const s = normalizeStyle(src["s"] as CellStyle | undefined);
	if (s) out.s = s;
	const t = normalizeCellType(src["t"]);
	if (t) out.t = t;
	return out;
}

/** Build a payload out of a rectangle of cells and the text that goes with it. */
export function makeClip(cells: unknown[][], tsv: string, cut: CutMark | null = null): SheetClip {
	const rows = cells.length;
	const cols = rows === 0 ? 0 : Math.max(...cells.map((row) => (row ?? []).length));
	const grid: ClipCell[][] = [];
	for (let r = 0; r < rows; r++) {
		const line: ClipCell[] = [];
		for (let c = 0; c < cols; c++) line.push(normalizeClipCell((cells[r] ?? [])[c]));
		grid.push(line);
	}
	return { tsv, rows, cols, cells: grid, cut };
}

/** True when nothing in the payload would survive a paste. */
export function isEmptyClip(clip: SheetClip | null): boolean {
	if (!clip || clip.rows === 0 || clip.cols === 0) return true;
	return !clip.cells.some((row) => row.some((cell) => Object.keys(cell).length > 0));
}

let store: SheetClip | null = null;

/** Replace the payload. `null` forgets everything, pending cut included. */
export function setClip(clip: SheetClip | null): void {
	if (store?.cut && store.cut !== clip?.cut) store.cut.owner.markCutRange(null);
	store = clip;
	if (clip?.cut) clip.cut.owner.markCutRange(clip.cut.rect);
}

/** The payload as it stands, whatever the system clipboard says. */
export function peekClip(): SheetClip | null {
	return store;
}

/**
 * The payload for this clipboard text, or `null` to paste the text as text.
 * See the fingerprint rule at the top of the file.
 */
export function clipFor(text: unknown): SheetClip | null {
	if (!store) return null;
	const wanted = tsvFingerprint(store.tsv);
	// An empty range never matches: every unrelated empty clipboard would.
	if (wanted === "") return null;
	return tsvFingerprint(text) === wanted ? store : null;
}

/** The range a cut is waiting to clear, if any. */
export function pendingCut(): CutMark | null {
	return store?.cut ?? null;
}

/** Escape: the cut is off, the source stays where it is. */
export function cancelCut(): boolean {
	const cut = store?.cut;
	if (!cut || !store) return false;
	store.cut = null;
	cut.owner.markCutRange(null);
	return true;
}

/**
 * Carry out the move half of a cut, if one is pending: the source range is
 * cleared and the mark comes off. Called by the paste that completes it, so
 * that one autosave sees both halves.
 */
export function applyPendingCut(): boolean {
	const cut = store?.cut;
	if (!cut || !store) return false;
	store.cut = null;
	cut.owner.markCutRange(null);
	cut.owner.clearRect(cut.rect);
	return true;
}

/** Test seam: forget the payload without touching any owner. */
export function resetClipboard(): void {
	store = null;
}
