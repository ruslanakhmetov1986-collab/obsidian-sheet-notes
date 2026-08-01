/**
 * File version history: a git-like log of a spreadsheet's past, without git.
 *
 * Every time a spreadsheet is really written to disk, the bytes that were
 * written are also gzipped into
 *
 *     .obsidian/plugins/leovale-sheets/backups/<hash of the path>/<timestamp>.json.gz
 *
 * next to an `index.json` that lists what is there (when, how big, and a cheap
 * summary of what changed, e.g. "B4, C2 changed"). The modal in versionmodal.ts
 * reads exactly that.
 *
 * WHY NOT LEAVE IT TO OBSIDIAN. Obsidian ships a core plugin called File
 * Recovery which does the same thing for notes. Measured in the sandbox (see
 * the "File Recovery" section of the README): it snapshots MARKDOWN only - a
 * `.sheet` file is written through the same vault API and never appears in its
 * database. A spreadsheet is exactly the kind of file where a bad sort noticed
 * two days later is unrecoverable, so the plugin keeps its own log.
 *
 * DESIGN NOTES
 *
 * - The store is a plain folder tree, not a database: a user can open, copy or
 *   delete a version with the file manager, and nothing here is required to
 *   read them back (a `.json.gz` is a gzip of the file as it was).
 * - The path is HASHED rather than mirrored, because a vault path can contain
 *   characters a folder name cannot, and because a deep tree of nested folders
 *   for one nested file is a lot of syscalls for nothing. The index keeps the
 *   original path so a folder can always be traced back.
 * - Rotation is enforced twice: per file (the newest {@link MAX_VERSIONS} are
 *   kept) and globally ({@link MAX_TOTAL_BYTES} across every file, oldest
 *   first). Without the second one, a hundred spreadsheets would quietly grow
 *   a hundred separate caps.
 * - `CompressionStream` is feature-detected. Where it is missing the snapshot
 *   is written as plain `.json`, the index says so per version, and reading is
 *   unaffected. Measured on real documents: 34 KB -> 3.1 KB, ~11x.
 *
 * Nothing here imports Obsidian: the file system arrives as {@link BackupAdapter},
 * which the vault adapter satisfies and the unit tests fake in memory.
 */

import { type SheetCell, type SheetDoc, parseRef, parseSheet } from "./format";

/** Versions kept per file. */
export const MAX_VERSIONS = 50;

/** Bytes the whole backup tree may occupy, counted as stored (gzipped) size. */
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/** How many cell addresses a change summary spells out before it counts them. */
export const SUMMARY_MAX_REFS = 6;

export const INDEX_NAME = "index.json";

/** What a version changed, in a form that survives a language change. */
export interface VersionSummary {
	/**
	 * `created` - the first version we ever kept for this file;
	 * `cells`   - cell contents/styles differ, listed in {@link cells};
	 * `layout`  - no cell differs, but the page does (rows, widths, merges,
	 *             sort, filters, frozen panes, worksheets);
	 * `none`    - nothing we can name differs.
	 */
	kind: "created" | "cells" | "layout" | "none";
	/** Addresses that changed, at most {@link SUMMARY_MAX_REFS} of them. */
	cells: string[];
	/** How many changed cells are NOT listed in {@link cells}. */
	more: number;
}

export interface VersionMeta {
	/** Creation time in ms, and the file name stem. Unique within the folder. */
	id: number;
	/** Size of the document itself, in bytes of UTF-8. */
	size: number;
	/** Size actually taken on disk (gzipped, when compression is available). */
	stored: number;
	/** Whether the payload is gzipped, i.e. `<id>.json.gz` rather than `<id>.json`. */
	gz: boolean;
	summary: VersionSummary;
}

export interface VersionIndex {
	/** The vault path this folder belongs to, so a hash can be traced back. */
	path: string;
	/** Oldest first. */
	versions: VersionMeta[];
}

/** The slice of Obsidian's `DataAdapter` this store needs. */
export interface BackupAdapter {
	exists(path: string): Promise<boolean>;
	mkdir(path: string): Promise<void>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	readBinary(path: string): Promise<ArrayBuffer>;
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
	remove(path: string): Promise<void>;
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
}

/* ------------------------------------------------------------------ paths */

/**
 * FNV-1a over the path, as eight hex digits.
 *
 * Not a cryptographic choice and not meant to be one: the only requirement is
 * that two paths rarely share a folder, and the index inside the folder names
 * the path it belongs to, so a collision is detectable rather than silent.
 */
export function pathHash(path: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < path.length; i++) {
		hash ^= path.charCodeAt(i);
		// Math.imul keeps the multiply in 32 bits; `*` would go through doubles.
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/** The last segment of a path, which is what `list()` results have to become. */
export function baseName(path: string): string {
	const parts = path.split(/[/\\]/);
	return parts[parts.length - 1] ?? path;
}

/** `1738012345678.json.gz` -> 1738012345678; anything else -> null. */
export function versionIdFromName(name: string): number | null {
	const m = /^([0-9]{6,})\.json(\.gz)?$/.exec(baseName(name));
	if (!m) return null;
	const id = Number(m[1]);
	return Number.isSafeInteger(id) ? id : null;
}

/* -------------------------------------------------------------- gzip ---- */

/** Is `CompressionStream` available in this runtime? */
export function hasCompression(): boolean {
	return (
		typeof (globalThis as { CompressionStream?: unknown }).CompressionStream === "function" &&
		typeof (globalThis as { DecompressionStream?: unknown }).DecompressionStream === "function"
	);
}

async function pump(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			chunks.push(value);
			total += value.length;
		}
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}

/** gzip a string. Returns null when the runtime has no `CompressionStream`. */
export async function gzipText(text: string): Promise<Uint8Array | null> {
	if (!hasCompression()) return null;
	const cs = new CompressionStream("gzip");
	const source = new Blob([new TextEncoder().encode(text)]).stream();
	return pump(source.pipeThrough(cs) as ReadableStream<Uint8Array>);
}

/** Inverse of {@link gzipText}. Throws on anything that is not gzip. */
export async function gunzipText(bytes: ArrayBuffer | Uint8Array): Promise<string> {
	// A copy, and deliberately: `Blob` refuses a view whose buffer TypeScript
	// cannot prove is a plain ArrayBuffer (it could be shared), and the caller's
	// buffer may also be a slice of a pooled one.
	const view = bytes instanceof Uint8Array ? new Uint8Array(bytes) : new Uint8Array(bytes);
	const ds = new DecompressionStream("gzip");
	const source = new Blob([view.buffer as ArrayBuffer]).stream();
	const out = await pump(source.pipeThrough(ds) as ReadableStream<Uint8Array>);
	return new TextDecoder().decode(out);
}

/* --------------------------------------------------------- change summary */

/**
 * Everything about a cell that the file remembers, as one comparable string.
 *
 * Built by hand rather than with `JSON.stringify(cell)`: the property ORDER of
 * an object literal is what stringify follows, and two parses of the same cell
 * can produce the same fields in a different order (a style read from an older
 * file, say). A fixed tuple cannot.
 */
function cellKey(cell: SheetCell): string {
	const s = cell.s ?? {};
	return JSON.stringify([
		cell.v ?? null,
		cell.f ?? null,
		cell.t ?? null,
		s.b ?? 0,
		s.fs ?? 0,
		s.bg ?? "",
		s.bd ?? "",
		s.nf ?? "",
		s.ha ?? "",
		s.va ?? "",
		s.wrap ?? 0,
	]);
}

/** Everything about a page EXCEPT its cells, as one comparable string. */
function layoutKey(doc: SheetDoc): string {
	return JSON.stringify(
		doc.sheets.map((page) => [
			page.name,
			page.rows,
			page.cols,
			page.colWidths,
			page.rowHeights,
			page.merges,
			page.view,
			page.freeze,
		]),
	);
}

function sortRefs(refs: string[]): string[] {
	return refs.sort((a, b) => {
		const pa = parseRef(a.includes("!") ? (a.split("!")[1] as string) : a);
		const pb = parseRef(b.includes("!") ? (b.split("!")[1] as string) : b);
		return pa.row - pb.row || pa.col - pb.col;
	});
}

/**
 * What changed between two serialized documents, cheaply.
 *
 * "Cheaply" is the whole specification: this runs on the save path, so it may
 * cost a parse of each side and a walk of the cells, and nothing more. It is
 * NOT a diff - it does not say what a cell became, only that it is not what it
 * was - because the version list has room for one line and the preview pane
 * shows the rest.
 *
 * Unparseable input is not an error here: a summary is a convenience, and
 * refusing to keep a backup because its summary could not be computed would be
 * exactly the wrong trade.
 */
export function summarize(previous: string | null, next: string): VersionSummary {
	if (previous === null) return { kind: "created", cells: [], more: 0 };
	let before: SheetDoc;
	let after: SheetDoc;
	try {
		before = parseSheet(previous);
		after = parseSheet(next);
	} catch {
		return { kind: "none", cells: [], more: 0 };
	}

	const named = after.sheets.length > 1 || before.sheets.length > 1;
	const changed: string[] = [];
	let count = 0;
	const pages = Math.max(before.sheets.length, after.sheets.length);
	for (let i = 0; i < pages; i++) {
		const a = before.sheets[i];
		const b = after.sheets[i];
		const label = b?.name ?? a?.name ?? `Sheet${i + 1}`;
		const refs = new Set([...Object.keys(a?.cells ?? {}), ...Object.keys(b?.cells ?? {})]);
		for (const ref of refs) {
			const left = a?.cells[ref];
			const right = b?.cells[ref];
			const same =
				left && right ? cellKey(left) === cellKey(right) : left === undefined && right === undefined;
			if (same) continue;
			count++;
			if (changed.length < SUMMARY_MAX_REFS) changed.push(named ? `${label}!${ref}` : ref);
		}
	}

	if (count > 0) {
		const listed = sortRefs(changed);
		return { kind: "cells", cells: listed, more: Math.max(0, count - listed.length) };
	}
	if (layoutKey(before) !== layoutKey(after)) return { kind: "layout", cells: [], more: 0 };
	return { kind: "none", cells: [], more: 0 };
}

/* ----------------------------------------------------------------- store */

export interface BackupStoreOptions {
	maxVersions?: number;
	maxTotalBytes?: number;
	/** Force gzip on or off. Defaults to whatever the runtime supports. */
	compress?: boolean;
}

function utf8Length(text: string): number {
	return new TextEncoder().encode(text).length;
}

function emptyIndex(path: string): VersionIndex {
	return { path, versions: [] };
}

/**
 * The version log of a whole vault.
 *
 * Every method is failure-tolerant on the READ side (a corrupt or missing
 * index is an empty log, not an exception) and strict on the write side: if a
 * snapshot cannot be written the caller is told, because silently keeping no
 * history is the failure this feature exists to prevent.
 */
export class BackupStore {
	private readonly adapter: BackupAdapter;
	private readonly root: string;
	private readonly maxVersions: number;
	private readonly maxTotalBytes: number;
	private readonly compress: boolean;
	/** Stored bytes across the whole tree; computed on first need, then kept. */
	private total: number | null = null;

	/**
	 * The last id handed out, across every file.
	 *
	 * A version id is a millisecond timestamp, and uniqueness used to be checked
	 * against the file's OWN index only. Two files saved inside the same
	 * millisecond therefore got the same id: measured, with the clock held still,
	 * two files came out with identical id sets. That matters because the total
	 * cap evicts the oldest versions across ALL files and tells them apart by id,
	 * so an ambiguous id can drop the wrong file's version.
	 */
	private lastId = 0;

	constructor(adapter: BackupAdapter, root: string, opts: BackupStoreOptions = {}) {
		this.adapter = adapter;
		this.root = root.replace(/\/+$/, "");
		this.maxVersions = Math.max(1, opts.maxVersions ?? MAX_VERSIONS);
		this.maxTotalBytes = Math.max(1024, opts.maxTotalBytes ?? MAX_TOTAL_BYTES);
		this.compress = opts.compress ?? hasCompression();
	}

	/** Folder holding one file's versions. */
	dirFor(path: string): string {
		return `${this.root}/${pathHash(path)}`;
	}

	private fileFor(path: string, meta: VersionMeta): string {
		return `${this.dirFor(path)}/${meta.id}.json${meta.gz ? ".gz" : ""}`;
	}

	private async readIndex(path: string): Promise<VersionIndex> {
		const file = `${this.dirFor(path)}/${INDEX_NAME}`;
		try {
			if (!(await this.adapter.exists(file))) return emptyIndex(path);
			const parsed = JSON.parse(await this.adapter.read(file)) as Partial<VersionIndex>;
			if (!parsed || !Array.isArray(parsed.versions)) return emptyIndex(path);
			const versions = parsed.versions.filter(
				(v): v is VersionMeta => !!v && Number.isFinite(v.id) && typeof v.gz === "boolean",
			);
			versions.sort((a, b) => a.id - b.id);
			return { path: typeof parsed.path === "string" ? parsed.path : path, versions };
		} catch {
			// A truncated index (a crash mid-write) must not take the feature down.
			return emptyIndex(path);
		}
	}

	private async writeIndex(path: string, index: VersionIndex): Promise<void> {
		await this.adapter.write(
			`${this.dirFor(path)}/${INDEX_NAME}`,
			`${JSON.stringify(index, null, "\t")}\n`,
		);
	}

	private async ensureDir(dir: string): Promise<void> {
		if (!(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
	}

	/** Newest first, which is the order the modal lists them in. */
	async list(path: string): Promise<VersionMeta[]> {
		const index = await this.readIndex(path);
		return [...index.versions].reverse();
	}

	/** The document as it was. Throws if that version is gone. */
	async read(path: string, id: number): Promise<string> {
		const index = await this.readIndex(path);
		const meta = index.versions.find((v) => v.id === id);
		if (!meta) throw new Error(`no version ${id}`);
		const file = this.fileFor(path, meta);
		if (!meta.gz) return this.adapter.read(file);
		return gunzipText(await this.adapter.readBinary(file));
	}

	/** Drop one version and its payload. */
	async remove(path: string, id: number): Promise<boolean> {
		const index = await this.readIndex(path);
		const meta = index.versions.find((v) => v.id === id);
		if (!meta) return false;
		await this.dropFile(path, meta);
		index.versions = index.versions.filter((v) => v.id !== id);
		await this.writeIndex(path, index);
		return true;
	}

	private async dropFile(path: string, meta: VersionMeta): Promise<void> {
		try {
			await this.adapter.remove(this.fileFor(path, meta));
			if (this.total !== null) this.total = Math.max(0, this.total - meta.stored);
		} catch {
			// Already gone by hand, or locked. The index entry goes either way, so
			// the list never offers a version that cannot be read.
		}
	}

	/**
	 * Keep `text` as a new version of `path`.
	 *
	 * `previous` is the document as it was before this save, used only for the
	 * summary; pass null for the first version. Returns the entry that was
	 * written, or null when this exact content is already the newest version
	 * (Obsidian rewrites a file on events that changed nothing).
	 */
	async save(path: string, text: string, previous: string | null): Promise<VersionMeta | null> {
		const dir = this.dirFor(path);
		const index = await this.readIndex(path);
		const newest = index.versions[index.versions.length - 1];
		const size = utf8Length(text);
		// Same size AND same bytes: the cheap half of the test first.
		if (newest && newest.size === size) {
			try {
				if ((await this.read(path, newest.id)) === text) return null;
			} catch {
				// unreadable payload: fall through and write a fresh version
			}
		}

		await this.ensureDir(this.root);
		await this.ensureDir(dir);

		// Strictly increasing, so ids stay comparable between files however fast
		// the saves come.
		let id = Math.max(Date.now(), this.lastId + 1);
		while (index.versions.some((v) => v.id === id)) id++;
		this.lastId = id;

		const packed = this.compress ? await gzipText(text) : null;
		const meta: VersionMeta = {
			id,
			size,
			stored: packed ? packed.length : size,
			gz: !!packed,
			summary: summarize(previous, text),
		};
		if (packed) {
			// A copy of the exact bytes, not the whole pooled buffer behind them.
			await this.adapter.writeBinary(
				this.fileFor(path, meta),
				packed.buffer.slice(packed.byteOffset, packed.byteOffset + packed.byteLength) as ArrayBuffer,
			);
		} else {
			await this.adapter.write(this.fileFor(path, meta), text);
		}

		index.versions.push(meta);
		index.path = path;
		if (this.total !== null) this.total += meta.stored;

		// Per-file rotation, oldest first.
		while (index.versions.length > this.maxVersions) {
			const victim = index.versions.shift();
			if (victim) await this.dropFile(path, victim);
		}
		await this.writeIndex(path, index);
		await this.enforceTotal();
		return meta;
	}

	/** Stored bytes across every file in the tree. */
	async totalBytes(): Promise<number> {
		if (this.total !== null) return this.total;
		let total = 0;
		for (const dir of await this.folders()) {
			for (const meta of (await this.readIndexAt(dir)).versions) total += meta.stored;
		}
		this.total = total;
		return total;
	}

	private async folders(): Promise<string[]> {
		try {
			if (!(await this.adapter.exists(this.root))) return [];
			const listing = await this.adapter.list(this.root);
			return listing.folders ?? [];
		} catch {
			return [];
		}
	}

	/** Read an index by FOLDER rather than by vault path (the global sweep). */
	private async readIndexAt(dir: string): Promise<VersionIndex> {
		const file = `${dir}/${INDEX_NAME}`;
		try {
			if (!(await this.adapter.exists(file))) return emptyIndex("");
			const parsed = JSON.parse(await this.adapter.read(file)) as Partial<VersionIndex>;
			if (!parsed || !Array.isArray(parsed.versions) || typeof parsed.path !== "string") {
				return emptyIndex("");
			}
			const versions = parsed.versions.filter(
				(v): v is VersionMeta => !!v && Number.isFinite(v.id) && typeof v.gz === "boolean",
			);
			versions.sort((a, b) => a.id - b.id);
			return { path: parsed.path, versions };
		} catch {
			return emptyIndex("");
		}
	}

	/**
	 * The global cap: drop the oldest versions in the WHOLE tree until it fits.
	 *
	 * A file's newest version is never dropped, whatever the cap says. Losing
	 * the only copy of the most recent state of some other spreadsheet because
	 * this one was saved a lot is not a trade any user would agree to.
	 */
	async enforceTotal(): Promise<number> {
		let total = await this.totalBytes();
		if (total <= this.maxTotalBytes) return total;

		const all: { path: string; meta: VersionMeta; newest: boolean }[] = [];
		for (const dir of await this.folders()) {
			const index = await this.readIndexAt(dir);
			if (!index.path) continue;
			index.versions.forEach((meta, i) =>
				all.push({ path: index.path, meta, newest: i === index.versions.length - 1 }),
			);
		}
		all.sort((a, b) => a.meta.id - b.meta.id);

		const doomed = new Map<string, Set<number>>();
		for (const entry of all) {
			if (total <= this.maxTotalBytes) break;
			if (entry.newest) continue;
			const set = doomed.get(entry.path) ?? new Set<number>();
			set.add(entry.meta.id);
			doomed.set(entry.path, set);
			total -= entry.meta.stored;
		}

		for (const [path, ids] of doomed) {
			const index = await this.readIndex(path);
			for (const meta of index.versions) {
				if (ids.has(meta.id)) await this.dropFile(path, meta);
			}
			index.versions = index.versions.filter((v) => !ids.has(v.id));
			await this.writeIndex(path, index);
		}
		this.total = total;
		return total;
	}
}
