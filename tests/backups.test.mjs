/**
 * The on-disk version store and its change summarizer.
 *
 * The file system is faked in memory (the same six calls Obsidian's vault
 * adapter offers), so every rule the store has can be checked exactly: what is
 * written, what is rotated away, what the index says afterwards, and that a
 * gzipped snapshot really decompresses back to the bytes that went in.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
	BackupStore,
	INDEX_NAME,
	MAX_TOTAL_BYTES,
	MAX_VERSIONS,
	SUMMARY_MAX_REFS,
	baseName,
	gunzipText,
	gzipText,
	hasCompression,
	pathHash,
	summarize,
	versionIdFromName,
} from "./.build/backups.mjs";
import { newSheetDoc, newSheetPage, serializeSheet } from "./.build/format.mjs";

/* ------------------------------------------------------------ fake vault */

/** An in-memory DataAdapter: folders are implicit, files hold text or bytes. */
function fakeAdapter() {
	const files = new Map(); // path -> { text } | { bytes: Uint8Array }
	const dirs = new Set();
	const calls = { write: 0, writeBinary: 0, remove: 0, mkdir: 0 };
	return {
		files,
		dirs,
		calls,
		async exists(p) {
			return files.has(p) || dirs.has(p);
		},
		async mkdir(p) {
			calls.mkdir++;
			dirs.add(p);
		},
		async read(p) {
			const f = files.get(p);
			if (!f || f.text === undefined) throw new Error(`ENOENT ${p}`);
			return f.text;
		},
		async write(p, data) {
			calls.write++;
			files.set(p, { text: data });
		},
		async readBinary(p) {
			const f = files.get(p);
			if (!f || !f.bytes) throw new Error(`ENOENT ${p}`);
			return f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength);
		},
		async writeBinary(p, data) {
			calls.writeBinary++;
			files.set(p, { bytes: new Uint8Array(data) });
		},
		async remove(p) {
			calls.remove++;
			if (!files.delete(p)) throw new Error(`ENOENT ${p}`);
		},
		async list(p) {
			const prefix = `${p}/`;
			const folders = new Set();
			const out = [];
			for (const key of [...files.keys(), ...dirs]) {
				if (!key.startsWith(prefix)) continue;
				const rest = key.slice(prefix.length);
				if (rest.includes("/")) folders.add(prefix + rest.split("/")[0]);
				else if (files.has(key)) out.push(key);
			}
			return { files: out, folders: [...folders] };
		},
	};
}

const ROOT = ".obsidian/plugins/leovale-sheets/backups";

/** A document with the given cells, serialized exactly as the plugin writes it. */
function docText(cells, tweak) {
	const doc = newSheetDoc();
	const page = newSheetPage("Sheet1");
	page.cells = cells;
	doc.sheets = [page];
	if (tweak) tweak(page);
	return serializeSheet(doc);
}

/* ------------------------------------------------------------------ paths */

test("pathHash is stable, hex, and separates ordinary paths", () => {
	assert.equal(pathHash("Budget.sheet"), pathHash("Budget.sheet"));
	assert.match(pathHash("Budget.sheet"), /^[0-9a-f]{8}$/);
	assert.notEqual(pathHash("Budget.sheet"), pathHash("Budget2.sheet"));
	assert.notEqual(pathHash("a/Budget.sheet"), pathHash("b/Budget.sheet"));
	assert.match(pathHash(""), /^[0-9a-f]{8}$/);
	// Non-ASCII paths are ordinary in a vault.
	assert.match(pathHash("Бюджет 2026.sheet"), /^[0-9a-f]{8}$/);
});

test("baseName survives both separators", () => {
	assert.equal(baseName("a/b/c.json"), "c.json");
	assert.equal(baseName("a\\b\\c.json"), "c.json");
	assert.equal(baseName("c.json"), "c.json");
});

test("a version file name yields its id, and nothing else does", () => {
	assert.equal(versionIdFromName("1738012345678.json.gz"), 1738012345678);
	assert.equal(versionIdFromName("dir/1738012345678.json"), 1738012345678);
	assert.equal(versionIdFromName(INDEX_NAME), null);
	assert.equal(versionIdFromName("12.json"), null);
	assert.equal(versionIdFromName("1738012345678.txt"), null);
	assert.equal(versionIdFromName("99999999999999999999999.json"), null);
});

/* ------------------------------------------------------------------- gzip */

test("gzip round-trips the exact document, and compresses it hard", async () => {
	assert.equal(hasCompression(), true, "node 20 has CompressionStream");
	const cells = {};
	for (let r = 1; r <= 200; r++) cells[`A${r}`] = { v: `row ${r}`, s: { b: true, bg: "#ffe08a" } };
	const text = docText(cells);
	const packed = await gzipText(text);
	assert.ok(packed instanceof Uint8Array);
	assert.equal(packed[0], 0x1f, "gzip magic");
	assert.equal(packed[1], 0x8b);
	assert.ok(packed.length < text.length / 4, `${packed.length} vs ${text.length}`);
	assert.equal(await gunzipText(packed), text);
	// ArrayBuffer in, same string out: that is what the store reads back.
	assert.equal(await gunzipText(packed.buffer.slice(0)), text);
});

test("gzip round-trips unicode and an empty string", async () => {
	for (const text of ["", "Бюджет ✓ 東京", "x"]) {
		assert.equal(await gunzipText(await gzipText(text)), text);
	}
});

/* -------------------------------------------------------------- summaries */

test("the first version is summarized as created", () => {
	assert.deepEqual(summarize(null, docText({ A1: { v: "x" } })), {
		kind: "created",
		cells: [],
		more: 0,
	});
});

test("changed cells are named, in reading order", () => {
	const before = docText({ A1: { v: "x" }, B4: { v: 1 }, C2: { v: 2 } });
	const after = docText({ A1: { v: "x" }, B4: { v: 9 }, C2: { v: 3 } });
	const s = summarize(before, after);
	assert.equal(s.kind, "cells");
	assert.deepEqual(s.cells, ["C2", "B4"], "row 2 before row 4");
	assert.equal(s.more, 0);
});

test("a cell that appeared and one that vanished both count", () => {
	const before = docText({ A1: { v: "x" }, B1: { v: "gone" } });
	const after = docText({ A1: { v: "x" }, C1: { v: "new" } });
	const s = summarize(before, after);
	assert.deepEqual(s.cells.sort(), ["B1", "C1"]);
});

test("a style-only change is a cell change", () => {
	const before = docText({ A1: { v: "x" } });
	const after = docText({ A1: { v: "x", s: { b: true } } });
	assert.deepEqual(summarize(before, after).cells, ["A1"]);
	const bolder = docText({ A1: { v: "x", s: { b: true, fs: 18 } } });
	assert.deepEqual(summarize(after, bolder).cells, ["A1"]);
	const tinted = docText({ A1: { v: "x", s: { b: true, fs: 18, bg: "#ffe08a" } } });
	assert.deepEqual(summarize(bolder, tinted).cells, ["A1"]);
});

test("a formula and a checkbox are compared too", () => {
	const before = docText({ A1: { f: "=1+1" } });
	const after = docText({ A1: { f: "=1+2" } });
	assert.deepEqual(summarize(before, after).cells, ["A1"]);
	const box = docText({ A1: { f: "=1+2", t: "cb" } });
	assert.deepEqual(summarize(after, box).cells, ["A1"]);
});

test("long changes are counted rather than listed", () => {
	const before = {};
	const after = {};
	for (let r = 1; r <= 20; r++) {
		before[`A${r}`] = { v: r };
		after[`A${r}`] = { v: r + 1 };
	}
	const s = summarize(docText(before), docText(after));
	assert.equal(s.cells.length, SUMMARY_MAX_REFS);
	assert.equal(s.more, 20 - SUMMARY_MAX_REFS);
	assert.deepEqual(s.cells, ["A1", "A2", "A3", "A4", "A5", "A6"]);
});

test("a layout-only change is named as such", () => {
	const before = docText({ A1: { v: "x" } });
	const wide = docText({ A1: { v: "x" } }, (p) => {
		p.colWidths = { 0: 250 };
	});
	assert.deepEqual(summarize(before, wide), { kind: "layout", cells: [], more: 0 });

	const sorted = docText({ A1: { v: "x" } }, (p) => {
		p.view = { sort: { col: 0, dir: "asc" } };
	});
	assert.equal(summarize(before, sorted).kind, "layout");

	const merged = docText({ A1: { v: "x" } }, (p) => {
		p.merges = { A1: [2, 2] };
	});
	assert.equal(summarize(before, merged).kind, "layout");

	const frozen = docText({ A1: { v: "x" } }, (p) => {
		p.rows = 20;
		p.freeze = { rows: 1 };
	});
	assert.equal(summarize(before, frozen).kind, "layout");
});

test("identical documents summarize to nothing, and so does unreadable input", () => {
	const same = docText({ A1: { v: "x" } });
	assert.deepEqual(summarize(same, same), { kind: "none", cells: [], more: 0 });
	assert.deepEqual(summarize("{ not json", same), { kind: "none", cells: [], more: 0 });
	assert.deepEqual(summarize(same, "{ not json"), { kind: "none", cells: [], more: 0 });
});

test("with several worksheets the address carries the sheet name", () => {
	const doc = newSheetDoc();
	const one = newSheetPage("Data");
	one.cells = { A1: { v: 1 } };
	const two = newSheetPage("Notes");
	two.cells = { B2: { v: "a" } };
	doc.sheets = [one, two];
	const before = serializeSheet(doc);
	two.cells = { B2: { v: "b" } };
	const after = serializeSheet(doc);
	assert.deepEqual(summarize(before, after).cells, ["Notes!B2"]);
});

/* ------------------------------------------------------------------ store */

test("a saved version lands as gzip, with an index beside it", async () => {
	const fs = fakeAdapter();
	const store = new BackupStore(fs, ROOT);
	const text = docText({ A1: { v: "one" } });
	const meta = await store.save("Budget.sheet", text, null);

	assert.ok(meta);
	assert.equal(meta.gz, true);
	assert.equal(meta.summary.kind, "created");
	assert.equal(meta.size, Buffer.byteLength(text, "utf8"));
	assert.ok(meta.stored < meta.size);

	const dir = `${ROOT}/${pathHash("Budget.sheet")}`;
	assert.ok(fs.files.has(`${dir}/${meta.id}.json.gz`), [...fs.files.keys()].join(", "));
	const index = JSON.parse(fs.files.get(`${dir}/${INDEX_NAME}`).text);
	assert.equal(index.path, "Budget.sheet");
	assert.equal(index.versions.length, 1);
	assert.equal(index.versions[0].id, meta.id);
	// ...and the payload is really the document.
	assert.equal(await store.read("Budget.sheet", meta.id), text);
});

test("without CompressionStream the snapshot is plain json and still reads back", async () => {
	const fs = fakeAdapter();
	const store = new BackupStore(fs, ROOT, { compress: false });
	const text = docText({ A1: { v: "plain" } });
	const meta = await store.save("Budget.sheet", text, null);
	assert.equal(meta.gz, false);
	assert.equal(meta.stored, meta.size);
	assert.ok(fs.files.has(`${ROOT}/${pathHash("Budget.sheet")}/${meta.id}.json`));
	assert.equal(await store.read("Budget.sheet", meta.id), text);
});

test("saving the same bytes twice keeps one version", async () => {
	const fs = fakeAdapter();
	const store = new BackupStore(fs, ROOT);
	const text = docText({ A1: { v: "one" } });
	const first = await store.save("Budget.sheet", text, null);
	const second = await store.save("Budget.sheet", text, text);
	assert.ok(first);
	assert.equal(second, null, "an autosave that changed nothing is not a version");
	assert.equal((await store.list("Budget.sheet")).length, 1);
});

test("versions are listed newest first, with their summaries", async () => {
	const fs = fakeAdapter();
	const store = new BackupStore(fs, ROOT);
	const v1 = docText({ A1: { v: "one" } });
	const v2 = docText({ A1: { v: "one" }, B4: { v: 7 } });
	const v3 = docText({ A1: { v: "one" }, B4: { v: 8 }, C2: { v: 1 } });
	await store.save("Budget.sheet", v1, null);
	await store.save("Budget.sheet", v2, v1);
	await store.save("Budget.sheet", v3, v2);

	const list = await store.list("Budget.sheet");
	assert.equal(list.length, 3);
	assert.ok(list[0].id >= list[1].id && list[1].id >= list[2].id, "newest first");
	assert.deepEqual(list[0].summary.cells, ["C2", "B4"]);
	assert.equal(list[2].summary.kind, "created");
	assert.equal(await store.read("Budget.sheet", list[1].id), v2);
});

test("two files keep separate folders and separate logs", async () => {
	const fs = fakeAdapter();
	const store = new BackupStore(fs, ROOT);
	await store.save("a.sheet", docText({ A1: { v: "a" } }), null);
	await store.save("b/deep.sheet", docText({ A1: { v: "b" } }), null);
	assert.equal((await store.list("a.sheet")).length, 1);
	assert.equal((await store.list("b/deep.sheet")).length, 1);
	assert.equal((await store.list("never-saved.sheet")).length, 0);
});

test("rotation keeps the newest N and deletes the payloads of the rest", async () => {
	const fs = fakeAdapter();
	const store = new BackupStore(fs, ROOT, { maxVersions: 3 });
	let previous = null;
	const ids = [];
	for (let i = 0; i < 6; i++) {
		const text = docText({ A1: { v: `v${i}` } });
		const meta = await store.save("Budget.sheet", text, previous);
		ids.push(meta.id);
		previous = text;
	}
	const list = await store.list("Budget.sheet");
	assert.equal(list.length, 3);
	assert.deepEqual(
		list.map((v) => v.id),
		ids.slice(-3).reverse(),
	);
	const dir = `${ROOT}/${pathHash("Budget.sheet")}`;
	for (const id of ids.slice(0, 3)) {
		assert.equal(fs.files.has(`${dir}/${id}.json.gz`), false, `payload ${id} still on disk`);
	}
	// index + three payloads, nothing else
	assert.equal([...fs.files.keys()].filter((k) => k.startsWith(dir)).length, 4);
});

test("a deleted version disappears from both the index and the disk", async () => {
	const fs = fakeAdapter();
	const store = new BackupStore(fs, ROOT);
	const a = docText({ A1: { v: "a" } });
	const b = docText({ A1: { v: "b" } });
	const first = await store.save("Budget.sheet", a, null);
	await store.save("Budget.sheet", b, a);

	assert.equal(await store.remove("Budget.sheet", first.id), true);
	assert.equal(fs.files.has(`${ROOT}/${pathHash("Budget.sheet")}/${first.id}.json.gz`), false);
	const list = await store.list("Budget.sheet");
	assert.equal(list.length, 1);
	assert.equal(await store.remove("Budget.sheet", first.id), false, "gone is gone");
	assert.equal(await store.remove("never-saved.sheet", 1), false);
	await assert.rejects(() => store.read("Budget.sheet", first.id), /no version/);
});

test("a version whose payload was deleted by hand does not break the index", async () => {
	const fs = fakeAdapter();
	const store = new BackupStore(fs, ROOT);
	const a = docText({ A1: { v: "a" } });
	const meta = await store.save("Budget.sheet", a, null);
	fs.files.delete(`${ROOT}/${pathHash("Budget.sheet")}/${meta.id}.json.gz`);
	assert.equal(await store.remove("Budget.sheet", meta.id), true);
	assert.equal((await store.list("Budget.sheet")).length, 0);
});

test("a corrupt index is treated as an empty log rather than an error", async () => {
	const fs = fakeAdapter();
	const store = new BackupStore(fs, ROOT);
	const dir = `${ROOT}/${pathHash("Budget.sheet")}`;
	fs.dirs.add(dir);
	fs.files.set(`${dir}/${INDEX_NAME}`, { text: '{"path": "Budget.sheet", "versi' });
	assert.deepEqual(await store.list("Budget.sheet"), []);
	// ...and the next save rebuilds it.
	const meta = await store.save("Budget.sheet", docText({ A1: { v: "x" } }), null);
	assert.ok(meta);
	assert.equal((await store.list("Budget.sheet")).length, 1);
});

test("index entries that are not versions are ignored", async () => {
	const fs = fakeAdapter();
	const store = new BackupStore(fs, ROOT);
	const dir = `${ROOT}/${pathHash("Budget.sheet")}`;
	fs.dirs.add(dir);
	fs.files.set(`${dir}/${INDEX_NAME}`, {
		text: JSON.stringify({
			path: "Budget.sheet",
			versions: [null, { id: "nope" }, { id: 5, gz: false, size: 1, stored: 1 }],
		}),
	});
	const list = await store.list("Budget.sheet");
	assert.equal(list.length, 1);
	assert.equal(list[0].id, 5);
});

test("an index that is valid json but not an index is empty too", async () => {
	const fs = fakeAdapter();
	const store = new BackupStore(fs, ROOT);
	const dir = `${ROOT}/${pathHash("x.sheet")}`;
	fs.files.set(`${dir}/${INDEX_NAME}`, { text: '{"path":"x.sheet"}' });
	assert.deepEqual(await store.list("x.sheet"), []);
});

test("the global cap evicts the oldest versions across ALL files", async () => {
	const fs = fakeAdapter();
	// Small cap, compression off so the sizes are the document sizes.
	const store = new BackupStore(fs, ROOT, { maxTotalBytes: 4000, compress: false });
	const files = ["a.sheet", "b.sheet"];
	const written = { "a.sheet": [], "b.sheet": [] };
	for (let i = 0; i < 4; i++) {
		for (const file of files) {
			const cells = {};
			for (let r = 1; r <= 12; r++) cells[`A${r}`] = { v: `${file} ${i} ${r}` };
			const text = docText(cells);
			const meta = await store.save(file, text, null);
			written[file].push(meta.id);
		}
	}
	const total = await store.totalBytes();
	assert.ok(total <= 4000, `total ${total}`);
	for (const file of files) {
		const list = await store.list(file);
		assert.ok(list.length >= 1, `${file} kept nothing`);
		assert.equal(list[0].id, written[file][written[file].length - 1], "the newest survives");
	}
	// The oldest of the whole tree is the first one written.
	const kept = new Set([...(await store.list("a.sheet")), ...(await store.list("b.sheet"))].map((v) => v.id));
	assert.equal(kept.has(written["a.sheet"][0]), false);
});

test("totalBytes is computed from the tree when nothing is cached", async () => {
	const fs = fakeAdapter();
	const seed = new BackupStore(fs, ROOT, { compress: false });
	const a = docText({ A1: { v: "a" } });
	const b = docText({ A1: { v: "bb" } });
	await seed.save("a.sheet", a, null);
	await seed.save("b.sheet", b, null);
	// A brand new store knows nothing and has to walk the folders.
	const fresh = new BackupStore(fs, ROOT, { compress: false });
	assert.equal(await fresh.totalBytes(), Buffer.byteLength(a) + Buffer.byteLength(b));
	// An empty tree answers zero rather than throwing.
	assert.equal(await new BackupStore(fakeAdapter(), ROOT).totalBytes(), 0);
});

test("enforceTotal is a no-op while the tree fits", async () => {
	const fs = fakeAdapter();
	const store = new BackupStore(fs, ROOT);
	await store.save("a.sheet", docText({ A1: { v: "a" } }), null);
	const before = [...fs.files.keys()].sort();
	await store.enforceTotal();
	assert.deepEqual([...fs.files.keys()].sort(), before);
});

test("the shipped limits are the documented ones", () => {
	assert.equal(MAX_VERSIONS, 50);
	assert.equal(MAX_TOTAL_BYTES, 20 * 1024 * 1024);
	assert.equal(SUMMARY_MAX_REFS, 6);
});

test("the summarizer walks every kind of style a cell can carry", () => {
	// One document with every persisted style property, so a change to any of
	// them is proved to be visible to the summary (and the normalizers that
	// parse them are exercised on the way).
	const dressed = {
		A1: { v: "x", s: { bg: "#abc", bd: "trbl", nf: "#,##0.00", ha: "c", va: "b", wrap: true } },
		A2: { v: true },
		A3: { v: 12.5, s: { fs: 14 } },
	};
	const before = docText(dressed, (p) => {
		p.rows = 30;
		p.view = { filters: { 0: ["x"] }, sort: { col: 0, dir: "desc" } };
		p.rowHeights = { 1: 40 };
	});
	assert.equal(summarize(before, before).kind, "none");

	const after = docText(
		{ ...dressed, A1: { v: "x", s: { bg: "#aabbcc", bd: "tb", nf: "0%", ha: "r", va: "t" } } },
		(p) => {
			p.rows = 30;
			p.view = { filters: { 0: ["x"] }, sort: { col: 0, dir: "desc" } };
			p.rowHeights = { 1: 40 };
		},
	);
	assert.deepEqual(summarize(before, after).cells, ["A1"]);
});

test("an empty previous document means everything in the new one changed", () => {
	const s = summarize("", docText({ A1: { v: "x" }, B2: { v: "y" } }));
	assert.equal(s.kind, "cells");
	assert.deepEqual(s.cells, ["A1", "B2"]);
});

test("documents that are not sheets summarize to nothing instead of throwing", () => {
	const good = docText({ A1: { v: "x" } });
	for (const bad of [
		"[1, 2]",
		'{"format": "something-else", "version": 4}',
		'{"format": "leovale-sheet"}',
		'{"format": "leovale-sheet", "version": 4, "sheets": [7]}',
		'{"format": "leovale-sheet", "version": 4, "sheets": [{"cells": {"A1": 5}}]}',
		'{"format": "leovale-sheet", "version": 4, "sheets": [{"cells": {"A1": {"v": []}}}]}',
	]) {
		assert.deepEqual(summarize(bad, good), { kind: "none", cells: [], more: 0 }, bad);
		assert.deepEqual(summarize(good, bad), { kind: "none", cells: [], more: 0 }, bad);
	}
});

test("a file system that refuses to list is an empty tree, not a crash", async () => {
	const fs = fakeAdapter();
	fs.dirs.add(ROOT);
	fs.list = async () => {
		throw new Error("EPERM");
	};
	const store = new BackupStore(fs, ROOT);
	assert.equal(await store.totalBytes(), 0);
	assert.equal(await store.enforceTotal(), 0);
});

test("folders without a readable index are skipped by the global sweep", async () => {
	const fs = fakeAdapter();
	const store = new BackupStore(fs, ROOT, { compress: false });
	const good = docText({ A1: { v: "a" } });
	await store.save("a.sheet", good, null);
	// Three folders the sweep has to survive: no index at all, an index that is
	// not JSON, and an index that parses but is not one of ours.
	fs.dirs.add(`${ROOT}/deadbeef`);
	fs.files.set(`${ROOT}/deadbeef/9.json`, { text: "{}" });
	fs.files.set(`${ROOT}/badf00d/${INDEX_NAME}`, { text: "{ truncated" });
	fs.files.set(`${ROOT}/c0ffee00/${INDEX_NAME}`, { text: '{"versions": []}' });

	const fresh = new BackupStore(fs, ROOT, { compress: false });
	assert.equal(await fresh.totalBytes(), Buffer.byteLength(good));
});

test("a rewritten payload that no longer matches forces a new version", async () => {
	const fs = fakeAdapter();
	const store = new BackupStore(fs, ROOT);
	const text = docText({ A1: { v: "one" } });
	const meta = await store.save("Budget.sheet", text, null);
	// Corrupt the payload: the size check passes, the content check cannot.
	fs.files.set(`${ROOT}/${pathHash("Budget.sheet")}/${meta.id}.json.gz`, {
		bytes: new Uint8Array([1, 2, 3]),
	});
	const again = await store.save("Budget.sheet", text, text);
	assert.ok(again, "an unreadable newest version must not block a new one");
	assert.equal((await store.list("Budget.sheet")).length, 2);
});
