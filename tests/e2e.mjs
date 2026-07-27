/**
 * End-to-end test of leovale-sheets against a SANDBOX Obsidian instance.
 *
 * Runs on CDP port 9333 with --user-data-dir=.sandbox/udata. The user's real
 * Obsidian (port 9222, real vault) is never touched.
 *
 *   node tests/e2e.mjs            reuse a running sandbox
 *   node tests/e2e.mjs --fresh    kill the sandbox first, then relaunch
 *   node tests/e2e.mjs --keep     leave the sandbox running afterwards
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
// Playwright is only needed for e2e, not for building the plugin. Either
// `npm i -D playwright` in this repo, or point SHEETS_PLAYWRIGHT at an
// existing install (a file:// URL to its index.mjs).
const { chromium } = await import(process.env.SHEETS_PLAYWRIGHT ?? "playwright");
import {
	CDP_PORT,
	PLUGIN_ID,
	SHOTS,
	VAULT,
	assertSandboxTarget,
	deployPlugin,
	killSandbox,
	launchSandbox,
} from "./sandbox.mjs";

const FRESH = process.argv.includes("--fresh");
const KEEP = process.argv.includes("--keep");
const SHEET_PATH = "Untitled.sheet";

let failures = 0;
let checks = 0;
const shots = [];

function check(name, ok, detail = "") {
	checks++;
	if (ok) {
		console.log(`  ok   ${name}`);
	} else {
		failures++;
		console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`);
	}
	return ok;
}

function step(n) {
	console.log(`\n== ${n}`);
}

async function shot(page, name) {
	fs.mkdirSync(SHOTS, { recursive: true });
	const file = path.join(SHOTS, `${name}.png`);
	await page.screenshot({ path: file });
	shots.push(file);
	console.log(`  shot ${file}`);
	return file;
}

/** Click a cell and type into it with real keyboard events, then commit. */
async function typeInCell(page, x, y, text, commit = "Enter") {
	await page.click(`.leovale-sheet-content .leovale-sheet-root td[data-x="${x}"][data-y="${y}"]`);
	await page.waitForTimeout(80);
	await page.keyboard.type(text, { delay: 12 });
	await page.keyboard.press(commit);
	await page.waitForTimeout(120);
}

function cellText(page, x, y) {
	return page.evaluate(
		([cx, cy]) =>
			document.querySelector(`.leovale-sheet-content .leovale-sheet-root td[data-x="${cx}"][data-y="${cy}"]`)?.textContent,
		[x, y],
	);
}

/** Switch Obsidian's base theme: "moonstone" (light) or "obsidian" (dark). */
async function setBaseTheme(page, theme) {
	return page.evaluate((t) => {
		const app = window.app;
		if (typeof app.changeTheme === "function") {
			app.changeTheme(t);
		} else if (app.customCss && typeof app.customCss.setTheme === "function") {
			app.vault.setConfig("theme", t);
			app.workspace.trigger("css-change");
		} else {
			app.vault.setConfig("theme", t);
			document.body.classList.toggle("theme-dark", t === "obsidian");
			document.body.classList.toggle("theme-light", t !== "obsidian");
		}
		return document.body.className;
	}, theme);
}

/* ------------------------------------------------------------ PDF reading */

/**
 * Enough of a PDF reader to answer one question: is this text on the page?
 *
 * Chromium prints with SUBSET fonts and Identity-H encoding, so a content stream
 * holds glyph ids, not letters - grepping the raw bytes for "Write docs" finds
 * nothing whatever the page says. The glyph ids are translated by the font's own
 * `/ToUnicode` CMap, which is in the file too, so the three steps below are:
 * inflate every stream, collect every CMap into one table, then decode the text
 * that the drawing operators show.
 *
 * The tables are merged rather than kept per font: two subsets can in principle
 * disagree about a code, and a proper reader would follow the page's resource
 * dictionary. For a "does the printed page contain this row" assertion the merged
 * table is enough, and it is checked against a string that has to be ABSENT too,
 * so a decoder that produced mush would fail the suite rather than pass it.
 */
function pdfStreams(buf) {
	const raw = buf.toString("latin1");
	const out = [];
	// The dictionary end is part of the pattern on purpose: an embedded font is
	// binary, and the seven bytes "stream\n" turn up inside one often enough to
	// send a naive scanner off by a whole object (measured: 9 of 10 "streams"
	// came out as garbage that way).
	const re = />>\s*stream\r?\n/g;
	let m;
	while ((m = re.exec(raw))) {
		const start = m.index + m[0].length;
		const end = raw.indexOf("endstream", start);
		if (end < 0) continue;
		const chunk = buf.subarray(start, end);
		let text = null;
		for (const inflate of [zlib.inflateSync, zlib.inflateRawSync]) {
			try {
				text = inflate(chunk).toString("latin1");
				break;
			} catch {
				/* the next one, then the bytes as they are */
			}
		}
		out.push(text ?? chunk.toString("latin1"));
		re.lastIndex = end;
	}
	return out;
}

function hexToText(hex) {
	let out = "";
	for (let i = 0; i + 3 < hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
	return out;
}

function pdfToUnicode(streams) {
	const map = new Map();
	for (const text of streams) {
		if (!text.includes("beginbfchar") && !text.includes("beginbfrange")) continue;
		for (const block of text.match(/beginbfchar[\s\S]*?endbfchar/g) ?? []) {
			for (const m of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
				map.set(parseInt(m[1], 16), hexToText(m[2]));
			}
		}
		for (const block of text.match(/beginbfrange[\s\S]*?endbfrange/g) ?? []) {
			for (const m of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
				const lo = parseInt(m[1], 16);
				const hi = parseInt(m[2], 16);
				const dst = parseInt(m[3], 16);
				for (let c = lo; c <= hi && c - lo < 1024; c++) {
					map.set(c, String.fromCharCode(dst + (c - lo)));
				}
			}
		}
	}
	return map;
}

/** The visible text of a printed page, as best a hundred lines can tell. */
function pdfText(buf) {
	const streams = pdfStreams(buf);
	const cmap = pdfToUnicode(streams);
	const decodeHex = (hex) => {
		const clean = hex.replace(/\s+/g, "");
		let out = "";
		for (let i = 0; i + 3 < clean.length; i += 4) {
			out += cmap.get(parseInt(clean.slice(i, i + 4), 16)) ?? "";
		}
		return out;
	};
	const decodeLiteral = (s) => s.replace(/\\([()\\])/g, "$1");

	const parts = [];
	for (const text of streams) {
		if (!/\bTJ\b|\bTj\b/.test(text)) continue;
		// Three shapes carry text: `[..] TJ` (kerned runs), `(..) Tj` (literal),
		// and `<hex> Tj` - which is what Chromium emits, one glyph at a time,
		// through an Identity-H subset font.
		for (const m of text.matchAll(
			/\[([^\]]*)\]\s*TJ|\(((?:\\.|[^)])*)\)\s*Tj|<([0-9a-fA-F\s]*)>\s*Tj/g,
		)) {
			if (m[3] !== undefined) {
				parts.push(decodeHex(m[3]));
				continue;
			}
			if (m[2] !== undefined) {
				parts.push(decodeLiteral(m[2]));
				continue;
			}
			let piece = "";
			for (const token of (m[1] ?? "").matchAll(/<([0-9a-fA-F\s]+)>|\(((?:\\.|[^)])*)\)/g)) {
				piece += token[1] !== undefined ? decodeHex(token[1]) : decodeLiteral(token[2] ?? "");
			}
			parts.push(piece);
		}
	}
	// Chromium draws a glyph at a time, so the pieces are joined without a
	// separator; word breaks come from the text itself.
	return parts.join("");
}

function selectedCell(page) {
	return page.evaluate(() => {
		const td = document.querySelector(".leovale-sheet-content .leovale-sheet-root td.highlight-selected");
		return td ? [Number(td.dataset.x), Number(td.dataset.y)] : null;
	});
}

async function main() {
	step("build artifacts");
	const sizes = deployPlugin();
	console.log("  deployed:", sizes);
	check("main.js is a plausible bundle", sizes["main.js"] > 200_000, String(sizes["main.js"]));
	check("styles.css is a plausible bundle", sizes["styles.css"] > 20_000, String(sizes["styles.css"]));

	step(`launch sandbox Obsidian (port ${CDP_PORT}, own user-data-dir)`);
	console.log("  ", await launchSandbox({ fresh: FRESH }));
	await assertSandboxTarget(CDP_PORT);

	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`, {
		noDefaults: true,
	});
	try {
		const ctx = browser.contexts()[0];
		const page = ctx.pages().find((p) => p.url() === "app://obsidian.md/index.html");
		if (!page) throw new Error("Obsidian app page not found (vault picker?)");

		const pageErrors = [];
		page.on("pageerror", (e) => pageErrors.push(e.message));
		page.on("console", (m) => {
			if (m.type() === "error") pageErrors.push(m.text());
		});

		await page.waitForFunction(() => !!window.app?.workspace?.layoutReady, null, {
			timeout: 60_000,
		});

		// Second half of the guard in sandbox.mjs: prove the VAULT is the throwaway
		// one before creating or deleting a single file in it. (A leftover
		// `adb forward` on this port serves a real Obsidian from a real device.)
		const vaultPath = await page.evaluate(() => ({
			base: window.app.vault.adapter?.basePath ?? "",
			name: window.app.vault.getName(),
		}));
		const sameVault =
			path.resolve(vaultPath.base || "x").toLowerCase() === path.resolve(VAULT).toLowerCase();
		if (!sameVault) {
			throw new Error(
				`refusing to run: the open vault is "${vaultPath.name}" at ${vaultPath.base}, ` +
					`not the sandbox vault at ${VAULT}`,
			);
		}
		check("the sandbox vault is the one open", sameVault, vaultPath.base);

		step("install + enable the plugin");
		const enabled = await page.evaluate(async (id) => {
			window.app.plugins.setEnable(true); // leave Restricted Mode
			// The plugin follows Obsidian's interface language. Pin it to English so
			// the assertions below do not depend on the machine's locale (this one
			// reports ru, which is exactly what the i18n step re-checks later).
			const langBefore = {
				stored: window.localStorage.getItem("language"),
				moment: window.moment?.locale?.(),
			};
			window.localStorage.setItem("language", "en");
			await window.app.plugins.loadManifests();
			if (window.app.plugins.plugins[id]) await window.app.plugins.disablePlugin(id);
			await window.app.plugins.enablePluginAndSave(id);
			await new Promise((r) => setTimeout(r, 1200));
			return {
				langBefore,
				loaded: !!window.app.plugins.plugins[id],
				extOwner: window.app.viewRegistry.getTypeByExtension("sheet"),
				lsheetOwner: window.app.viewRegistry.getTypeByExtension("lsheet"),
				csvOwner: window.app.viewRegistry.getTypeByExtension("csv"),
				commands: Object.keys(window.app.commands.commands).filter((c) => c.startsWith(id)),
				ribbon: !!document.querySelector('.side-dock-ribbon-action[aria-label*="spreadsheet" i]'),
			};
		}, PLUGIN_ID);
		// Test-side handle to the live worksheet instance (TS `private` is
		// compile-time only and esbuild does not mangle property names).
		await page.evaluate(() => {
			window.sheetView = () =>
				window.app.workspace
					.getLeavesOfType("leovale-sheet-view")
					.map((l) => l.view)
					.find((v) => v && v.sheetEngine);
			window.wsHandle = () => window.sheetView()?.sheetEngine?.worksheets?.[0];
		});

		console.log("  ", enabled);
		check("plugin instance is live", enabled.loaded);
		check(".sheet extension is owned by our view", enabled.extOwner === "leovale-sheet-view");
		check(".lsheet fallback is always registered too", enabled.lsheetOwner === "leovale-sheet-view",
			String(enabled.lsheetOwner));
		check(".csv is registered to the same view", enabled.csvOwner === "leovale-sheet-view",
			String(enabled.csvOwner));
		check("create command registered", enabled.commands.includes(`${PLUGIN_ID}:create-sheet`));
		check("ribbon icon present", enabled.ribbon);

		step("clean previous run");
		// Close notes too, not just sheet tabs: a note left open from a previous
		// run (with --keep the workspace is restored) contains EMBEDDED grids, and
		// `.leovale-sheet-root td[data-x=...]` would then resolve to a cell of an
		// embed instead of the sheet under test. That is a real failure mode of
		// this harness, seen as "arrows moved the selection A1 -> C2 -- [14,7]".
		await page.evaluate(async () => {
			window.app.workspace.detachLeavesOfType("leovale-sheet-view");
			for (const leaf of window.app.workspace.getLeavesOfType("markdown")) {
				if (window.app.workspace.getLeavesOfType("markdown").length > 1) leaf.detach();
				else await leaf.setViewState({ type: "empty" });
			}
			for (const f of window.app.vault.getFiles()) {
				if (f.extension === "sheet") await window.app.vault.delete(f);
				// notes left by an earlier run or by a manual probe
				if (f.name === "Embeds.md" || f.name === "probe-note.md") await window.app.vault.delete(f);
			}
		});
		await page.waitForTimeout(500);

		step("create a sheet via the command palette command");
		const created = await page.evaluate(
			(id) => window.app.commands.executeCommandById(`${id}:create-sheet`),
			PLUGIN_ID,
		);
		check("executeCommandById returned true", created === true);
		await page.waitForTimeout(1500);

		const createdPath = await page.evaluate(() => window.app.workspace.getActiveFile()?.path);
		check("a .sheet file was created and opened", createdPath?.endsWith(".sheet"), String(createdPath));
		check("default name is Untitled.sheet", createdPath === SHEET_PATH, String(createdPath));
		const diskPath = path.join(VAULT, createdPath);

		step("grid renders inside the tab");
		const layout = await page.evaluate(() => {
			const root = document.querySelector(".leovale-sheet-content .leovale-sheet-root");
			const table = document.querySelector(".leovale-sheet-content .leovale-sheet-root table.jss_worksheet");
			return {
				viewType: window.app.workspace.activeLeaf?.view?.getViewType?.(),
				hasRoot: !!root,
				headers: [...document.querySelectorAll(".leovale-sheet-content .leovale-sheet-root thead td")]
					.slice(1, 5)
					.map((t) => t.textContent),
				rowLabels: [...document.querySelectorAll(".leovale-sheet-content .leovale-sheet-root tbody td.jss_row")]
					.slice(0, 3)
					.map((t) => t.textContent),
				rows: table ? table.querySelectorAll("tbody tr").length : 0,
				cols: table ? table.querySelectorAll("thead td").length - 1 : 0,
				width: root ? Math.round(root.getBoundingClientRect().width) : 0,
			};
		});
		console.log("  ", layout);
		check("active view is our sheet view", layout.viewType === "leovale-sheet-view");
		check("column headers A,B,C,D", JSON.stringify(layout.headers) === '["A","B","C","D"]');
		check("row headers 1,2,3", JSON.stringify(layout.rowLabels) === '["1","2","3"]');
		check("100 rows x 26 cols", layout.rows === 100 && layout.cols === 26, JSON.stringify(layout));
		await shot(page, "01-empty-light");

		step("type values with real keyboard events");
		await typeInCell(page, 0, 0, "Item");
		await typeInCell(page, 0, 1, "Widget");
		await typeInCell(page, 0, 2, "Gadget");
		await typeInCell(page, 0, 3, "Total");
		await typeInCell(page, 1, 0, "Qty");
		await typeInCell(page, 1, 1, "3");
		await typeInCell(page, 1, 2, "4");

		check("A1 committed", (await cellText(page, 0, 0)) === "Item");
		check("B2 committed", (await cellText(page, 1, 1)) === "3");

		step("arrow-key navigation");
		// Sanity check for the harness itself: since 1.2.0 a grid can also live
		// inside a note, so a note left open would make every `.leovale-sheet-root`
		// selector ambiguous. Every cell selector below is scoped to the VIEW
		// (`.leovale-sheet-content`), and this asserts the scope is unique.
		const onScreen = await page.evaluate(() => ({
			views: document.querySelectorAll(".leovale-sheet-content").length,
			gridsInViews: document.querySelectorAll(".leovale-sheet-content .leovale-sheet-root").length,
			embeds: document.querySelectorAll(".leovale-sheet-embed").length,
		}));
		check(
			"exactly one grid is on screen, in the sheet view",
			onScreen.views === 1 && onScreen.gridsInViews === 1,
			JSON.stringify(onScreen),
		);
		await page.click('.leovale-sheet-content .leovale-sheet-root td[data-x="0"][data-y="0"]');
		await page.waitForTimeout(100);
		await page.keyboard.press("ArrowRight");
		await page.keyboard.press("ArrowRight");
		await page.keyboard.press("ArrowDown");
		await page.waitForTimeout(150);
		const sel = await selectedCell(page);
		check("arrows moved the selection A1 -> C2", JSON.stringify(sel) === "[2,1]", JSON.stringify(sel));

		step("formulas");
		await typeInCell(page, 1, 3, "=SUM(B2:B3)"); // B4 = 7
		await typeInCell(page, 2, 1, "=B2*2"); // C2 = 6
		await typeInCell(page, 2, 3, "=IF(B4>5,\"big\",\"small\")"); // D... C4
		await page.waitForTimeout(400);

		const b4 = await cellText(page, 1, 3);
		const c2 = await cellText(page, 2, 1);
		const c4 = await cellText(page, 2, 3);
		console.log("  computed:", { b4, c2, c4 });
		check("=SUM(B2:B3) computed to 7", b4 === "7", String(b4));
		check("=B2*2 computed to 6", c2 === "6", String(c2));
		check('=IF(B4>5,...) computed to "big"', c4 === "big", String(c4));

		step("formula bar");
		const fb = ".leovale-sheet-formulabar";
		check("formula bar is present", (await page.locator(fb).count()) === 1);
		const fbLook = await page.evaluate(() => {
			const bar = document.querySelector(".leovale-sheet-formulabar");
			const input = document.querySelector(".leovale-sheet-fb-input");
			const content = document.querySelector(".leovale-sheet-content");
			return {
				// the bar has to sit ABOVE the toolbar
				firstChild: content?.firstElementChild?.className,
				height: Math.round(bar.getBoundingClientRect().height),
				inputs: document.querySelectorAll(".leovale-sheet-fb-input").length,
				mono: getComputedStyle(input).fontFamily.length > 0,
				badge: document.querySelectorAll(".leovale-sheet-fb-badge").length,
			};
		});
		console.log("  formula bar:", fbLook);
		check("formula bar is the first strip in the view", fbLook.firstChild === "leovale-sheet-formulabar", String(fbLook.firstChild));
		check("formula bar is one line", fbLook.height > 20 && fbLook.height < 40, String(fbLook.height));
		check("exactly one input", fbLook.inputs === 1, String(fbLook.inputs));
		check("no CSV badge on a .sheet file", fbLook.badge === 0, String(fbLook.badge));

		// selecting a formula cell must show the SOURCE, not the result
		await page.click('.leovale-sheet-content .leovale-sheet-root td[data-x="1"][data-y="3"]');
		await page.waitForTimeout(200);
		const barOnB4 = await page.evaluate(() => ({
			ref: document.querySelector(".leovale-sheet-fb-ref").textContent,
			value: document.querySelector(".leovale-sheet-fb-input").value,
			cellShows: document.querySelector('.leovale-sheet-content .leovale-sheet-root td[data-x="1"][data-y="3"]').textContent,
		}));
		console.log("  bar on B4:", barOnB4);
		check("bar names the active cell", barOnB4.ref === "B4", barOnB4.ref);
		check("bar shows the formula source", barOnB4.value === "=SUM(B2:B3)", barOnB4.value);
		check("the cell itself still shows the result", barOnB4.cellShows === "7", barOnB4.cellShows);

		// a range shows as A1:C1
		const a1r = await page.locator('.leovale-sheet-content .leovale-sheet-root td[data-x="0"][data-y="0"]').boundingBox();
		const c1r = await page.locator('.leovale-sheet-content .leovale-sheet-root td[data-x="2"][data-y="0"]').boundingBox();
		await page.mouse.move(a1r.x + a1r.width / 2, a1r.y + a1r.height / 2);
		await page.mouse.down();
		await page.mouse.move(c1r.x + c1r.width / 2, c1r.y + c1r.height / 2, { steps: 6 });
		await page.mouse.up();
		await page.waitForTimeout(200);
		check(
			"bar labels a range",
			(await page.locator(`${fb} .leovale-sheet-fb-ref`).innerText()).trim() === "A1:C1",
			await page.locator(`${fb} .leovale-sheet-fb-ref`).innerText(),
		);

		// type a formula THROUGH THE BAR into D6 and commit with Enter
		await page.click('.leovale-sheet-content .leovale-sheet-root td[data-x="3"][data-y="5"]');
		await page.waitForTimeout(150);
		await page.click(`${fb} .leovale-sheet-fb-input`);
		await page.keyboard.type("=SUM(B2:B3)*10", { delay: 12 });
		await page.keyboard.press("Enter");
		await page.waitForTimeout(400);
		const barCommit = await page.evaluate(() => ({
			cell: document.querySelector('.leovale-sheet-content .leovale-sheet-root td[data-x="3"][data-y="5"]').textContent,
			raw: window.sheetView().sheetEngine.getRawValue("D6"),
			dirty: window.sheetView().sheetDirty,
		}));
		console.log("  after bar commit:", barCommit);
		check("grid computed the formula typed in the bar", barCommit.cell === "70", String(barCommit.cell));
		check("cell keeps the formula source", barCommit.raw === "=SUM(B2:B3)*10", String(barCommit.raw));
		check("the bar edit marked the document dirty (autosave path)", barCommit.dirty === true);

		// Escape reverts instead of committing
		await page.click(`${fb} .leovale-sheet-fb-input`);
		await page.keyboard.press("Control+A");
		await page.keyboard.type("=1+1");
		await page.keyboard.press("Escape");
		await page.waitForTimeout(250);
		check(
			"Escape leaves the cell alone",
			(await page.evaluate(() => window.sheetView().sheetEngine.getRawValue("D6"))) ===
				"=SUM(B2:B3)*10",
		);

		step("frozen row-number gutter (sticky during horizontal scroll)");
		const sticky = await page.evaluate(() => {
			const wrapper = document.querySelector(".leovale-sheet-wrapper");
			const rowHead = document.querySelector(
				'.leovale-sheet-root tbody tr:nth-child(3) td.jss_row',
			);
			const corner = document.querySelector(".leovale-sheet-content .leovale-sheet-root thead td:first-child");
			const dataCell = document.querySelector('.leovale-sheet-content .leovale-sheet-root td[data-x="4"][data-y="2"]');
			const rs = getComputedStyle(rowHead);
			const before = { row: rowHead.getBoundingClientRect().left, data: dataCell.getBoundingClientRect().left };
			wrapper.scrollLeft = 260;
			void wrapper.offsetWidth;
			const after = { row: rowHead.getBoundingClientRect().left, data: dataCell.getBoundingClientRect().left };
			const scrolled = wrapper.scrollLeft;
			wrapper.scrollLeft = 0;
			return {
				position: rs.position,
				left: rs.left,
				zIndex: rs.zIndex,
				cornerPos: getComputedStyle(corner).position,
				cornerZ: getComputedStyle(corner).zIndex,
				scrolled,
				rowMoved: Math.abs(after.row - before.row),
				dataMoved: Math.abs(after.data - before.data),
			};
		});
		console.log("  gutter:", sticky);
		check("row headers are position:sticky", sticky.position === "sticky", sticky.position);
		check("pinned to the left edge", sticky.left === "0px", sticky.left);
		check("above the data cells", Number(sticky.zIndex) >= 3, sticky.zIndex);
		check("corner cell is sticky on both axes", sticky.cornerPos === "sticky" && Number(sticky.cornerZ) >= 4,
			`${sticky.cornerPos} z=${sticky.cornerZ}`);
		check("the grid really scrolled horizontally", sticky.scrolled > 200, String(sticky.scrolled));
		check("data cells moved with the scroll", sticky.dataMoved > 200, String(sticky.dataMoved));
		check("row numbers stayed put", sticky.rowMoved < 2, String(sticky.rowMoved));

		step("column resize (real mouse drag on the header border)");
		const headA = await page.locator('.leovale-sheet-content .leovale-sheet-root thead td[data-x="0"]').boundingBox();
		await page.mouse.move(headA.x + headA.width - 2, headA.y + headA.height / 2);
		await page.mouse.down();
		await page.mouse.move(headA.x + headA.width + 78, headA.y + headA.height / 2, { steps: 12 });
		await page.mouse.up();
		await page.waitForTimeout(400);
		let width = await page.evaluate(() => Number(wsHandle().options.columns[0].width));
		console.log("  width after drag:", width);
		if (width === 100) {
			// Drag did not take (headless-ish input); fall back to the public API.
			await page.evaluate(() => wsHandle().setWidth(0, 180));
			await page.waitForTimeout(300);
			width = await page.evaluate(() => Number(wsHandle().options.columns[0].width));
			console.log("  width after setWidth fallback:", width);
		}
		check("column A was resized away from the default 100px", width !== 100, String(width));

		step("row resize (real mouse drag on the row-header border)");
		const rowHead = await page.locator('.leovale-sheet-content .leovale-sheet-root tbody tr:nth-child(2) td.jss_row').boundingBox();
		await page.mouse.move(rowHead.x + rowHead.width / 2, rowHead.y + rowHead.height - 1);
		await page.mouse.down();
		await page.mouse.move(rowHead.x + rowHead.width / 2, rowHead.y + rowHead.height + 22, { steps: 10 });
		await page.mouse.up();
		await page.waitForTimeout(400);
		let rowHeight = await page.evaluate(() => {
			const r = wsHandle().options.rows?.[1];
			return r ? parseInt(r.height, 10) : 0;
		});
		if (!rowHeight) {
			await page.evaluate(() => wsHandle().setHeight(1, 46));
			await page.waitForTimeout(300);
			rowHeight = await page.evaluate(() => {
				const r = wsHandle().options.rows?.[1];
				return r ? parseInt(r.height, 10) : 0;
			});
		}
		console.log("  row 2 height:", rowHeight);
		check("row 2 got an explicit height", rowHeight > 0, String(rowHeight));

		step("cell formatting via the toolbar (real clicks)");
		const tb = ".leovale-sheet-toolbar";
		check("toolbar is present", (await page.locator(tb).count()) === 1);
		const tbLook = await page.evaluate(() => {
			const bar = document.querySelector(".leovale-sheet-toolbar");
			const btn = document.querySelector(".leovale-sheet-toolbar .leovale-sheet-tb-btn");
			const sep = document.querySelector(".leovale-sheet-toolbar .leovale-sheet-tb-sep");
			const bs = getComputedStyle(btn);
			return {
				barHeight: Math.round(bar.getBoundingClientRect().height),
				btnW: Math.round(btn.getBoundingClientRect().width),
				btnH: Math.round(btn.getBoundingClientRect().height),
				border: bs.borderTopWidth,
				shadow: bs.boxShadow,
				radius: bs.borderRadius,
				bg: bs.backgroundColor,
				selects: document.querySelectorAll(".leovale-sheet-toolbar select").length,
				sepW: sep ? Math.round(sep.getBoundingClientRect().width) : null,
				sepH: sep ? Math.round(sep.getBoundingClientRect().height) : null,
			};
		});
		console.log("  toolbar look:", tbLook);
		check("toolbar is a single ~36px row", tbLook.barHeight === 36, String(tbLook.barHeight));
		check("icon buttons are 28x28", tbLook.btnW === 28 && tbLook.btnH === 28, JSON.stringify(tbLook));
		check("buttons have no border", tbLook.border === "0px", tbLook.border);
		check("buttons have no shadow", tbLook.shadow === "none", tbLook.shadow);
		check("buttons are 4px rounded", tbLook.radius === "4px", tbLook.radius);
		check("buttons are transparent at rest", tbLook.bg === "rgba(0, 0, 0, 0)", tbLook.bg);
		check("no native <select> left", tbLook.selects === 0, String(tbLook.selects));
		// setIcon() renders NOTHING for a name this Obsidian build does not know
		// (that is how `grid-2x2` shipped as an invisible button). Assert glyphs.
		const icons = await page.evaluate(() =>
			[...document.querySelectorAll(".leovale-sheet-toolbar .leovale-sheet-tb-btn")].map((b) => ({
				cls: b.className.replace("leovale-sheet-tb-btn ", ""),
				glyphs: b.querySelectorAll(".leovale-sheet-tb-icon svg").length,
			})),
		);
		console.log("  toolbar icons:", icons);
		check(
			"every icon button actually rendered its glyph",
			// 1.4.0 added two: merge and checkbox
			icons.length === 14 && icons.every((i) => i.glyphs === 1 || i.cls.includes("tb-size")),
			JSON.stringify(icons),
		);
		check(
			"separators are 1px and ~60% tall",
			tbLook.sepW === 1 && tbLook.sepH > 15 && tbLook.sepH < 26,
			JSON.stringify([tbLook.sepW, tbLook.sepH]),
		);

		// select the header row A1:C1 by dragging across it
		const a1 = await page.locator('.leovale-sheet-content .leovale-sheet-root td[data-x="0"][data-y="0"]').boundingBox();
		const c1 = await page.locator('.leovale-sheet-content .leovale-sheet-root td[data-x="2"][data-y="0"]').boundingBox();
		await page.mouse.move(a1.x + a1.width / 2, a1.y + a1.height / 2);
		await page.mouse.down();
		await page.mouse.move(c1.x + c1.width / 2, c1.y + c1.height / 2, { steps: 8 });
		await page.mouse.up();
		await page.waitForTimeout(200);
		const selRefs = await page.evaluate(() => window.sheetView().sheetEngine.getSelectionRefs());
		check("A1:C1 selected", JSON.stringify(selRefs) === '["A1","B1","C1"]', JSON.stringify(selRefs));

		await page.click(`${tb} .leovale-sheet-tb-bold`);
		await page.waitForTimeout(200);
		check(
			"bold button shows the toggled state",
			await page.locator(`${tb} .leovale-sheet-tb-bold.is-active`).count() === 1,
		);

		// font size: button -> native Obsidian menu -> item
		await page.click(`${tb} .leovale-sheet-tb-size`);
		await page.waitForTimeout(250);
		check("size menu is an Obsidian menu", (await page.locator(".menu").count()) >= 1);
		await page.click('.menu .menu-item:has(.menu-item-title:text-is("18"))');
		await page.waitForTimeout(300);
		check(
			"size button reflects the chosen size",
			(await page.locator(`${tb} .leovale-sheet-tb-size .leovale-sheet-tb-value`).innerText()).trim() ===
				"18",
		);

		// fill: bucket -> palette popover -> swatch (screenshot with it open)
		await page.click(`${tb} .leovale-sheet-tb-fillbtn`);
		await page.waitForTimeout(200);
		check("palette opened", await page.locator(`${tb} .leovale-sheet-palette.is-open`).isVisible());
		check(
			"palette has 12 swatches incl. no-fill",
			(await page.locator(`${tb} .leovale-sheet-swatch`).count()) === 12 &&
				(await page.locator(`${tb} .leovale-sheet-swatch.is-none`).count()) === 1,
		);
		await shot(page, "06-palette-open-light");
		await page.click(`${tb} .leovale-sheet-swatch[data-color="#fff2cc"]`);
		await page.waitForTimeout(250);
		check(
			"palette closed after picking",
			(await page.locator(`${tb} .leovale-sheet-palette.is-open`).count()) === 0,
		);

		// borders: button -> native Obsidian menu -> item
		await page.click(`${tb} .leovale-sheet-tb-border`);
		await page.waitForTimeout(250);
		const menuIcons = await page.evaluate(() =>
			[...document.querySelectorAll(".menu .menu-item")].map((i) => ({
				t: i.querySelector(".menu-item-title")?.textContent,
				svg: !!i.querySelector(".menu-item-icon svg"),
			})),
		);
		console.log("  border menu:", menuIcons);
		check(
			"every border menu item rendered its icon",
			menuIcons.length === 7 && menuIcons.every((i) => i.svg),
			JSON.stringify(menuIcons),
		);
		await page.click('.menu .menu-item:has(.menu-item-title:text-is("All borders"))');
		await page.waitForTimeout(300);

		const fmt = await page.evaluate(() => {
			const td = document.querySelector('.leovale-sheet-content .leovale-sheet-root td[data-x="0"][data-y="0"]');
			const cs = getComputedStyle(td);
			return {
				weight: cs.fontWeight,
				size: cs.fontSize,
				bg: cs.backgroundColor,
				borderTop: cs.borderTopColor,
				borderRight: cs.borderRightColor,
				style: window.sheetView().sheetEngine.getStyleAt("A1"),
				styleC1: window.sheetView().sheetEngine.getStyleAt("C1"),
			};
		});
		console.log("  A1 formatting:", fmt);
		check("bold applied", fmt.weight === "700" || fmt.weight === "bold", fmt.weight);
		check("font size applied", fmt.size === "18px", fmt.size);
		check("fill applied", fmt.bg === "rgb(255, 242, 204)", fmt.bg);
		check("borders applied on all sides", fmt.borderRight !== "rgba(0, 0, 0, 0)", fmt.borderRight);
		check(
			"normalized style is exactly the 4 managed props",
			JSON.stringify(fmt.style) === '{"b":true,"fs":18,"bg":"#fff2cc","bd":"trbl"}',
			JSON.stringify(fmt.style),
		);
		check(
			"the whole selection got the style, not just the anchor",
			JSON.stringify(fmt.styleC1) === JSON.stringify(fmt.style),
			JSON.stringify(fmt.styleC1),
		);

		// outline borders on a separate block
		await page.click('.leovale-sheet-content .leovale-sheet-root td[data-x="0"][data-y="1"]');
		const b3 = await page.locator('.leovale-sheet-content .leovale-sheet-root td[data-x="1"][data-y="2"]').boundingBox();
		await page.mouse.down();
		await page.mouse.move(b3.x + b3.width / 2, b3.y + b3.height / 2, { steps: 8 });
		await page.mouse.up();
		await page.waitForTimeout(150);
		await page.click(`${tb} .leovale-sheet-tb-border`);
		await page.waitForTimeout(250);
		await page.click('.menu .menu-item:has(.menu-item-title:text-is("Outer borders"))');
		await page.waitForTimeout(300);
		const outline = await page.evaluate(() => {
			const e = window.sheetView().sheetEngine;
			return { A2: e.getStyleAt("A2"), B2: e.getStyleAt("B2"), A3: e.getStyleAt("A3"), B3: e.getStyleAt("B3") };
		});
		console.log("  outline:", outline);
		check("outline: top-left cell has t+l", outline.A2.bd === "tl", String(outline.A2.bd));
		check("outline: top-right cell has t+r", outline.B2.bd === "tr", String(outline.B2.bd));
		check("outline: bottom-left cell has b+l", outline.A3.bd === "bl", String(outline.A3.bd));
		check("outline: bottom-right cell has r+b", outline.B3.bd === "rb", String(outline.B3.bd));

		step("number format via the toolbar: currency on a range incl. a formula");
		// B2 = 3, B3 = 4, B4 = =SUM(B2:B3). Formatting all three proves the mask
		// is applied to a COMPUTED result as well as to literals.
		const b2box = await page.locator('.leovale-sheet-content .leovale-sheet-root td[data-x="1"][data-y="1"]').boundingBox();
		const b4box = await page.locator('.leovale-sheet-content .leovale-sheet-root td[data-x="1"][data-y="3"]').boundingBox();
		await page.mouse.move(b2box.x + b2box.width / 2, b2box.y + b2box.height / 2);
		await page.mouse.down();
		await page.mouse.move(b4box.x + b4box.width / 2, b4box.y + b4box.height / 2, { steps: 8 });
		await page.mouse.up();
		await page.waitForTimeout(200);
		check(
			"B2:B4 selected",
			JSON.stringify(await page.evaluate(() => window.sheetView().sheetEngine.getSelectionRefs())) ===
				'["B2","B3","B4"]',
		);

		await page.click(`${tb} .leovale-sheet-tb-number`);
		await page.waitForTimeout(250);
		const nfMenu = await page.evaluate(() =>
			[...document.querySelectorAll(".menu .menu-item-title")].map((i) => i.textContent),
		);
		console.log("  number menu:", nfMenu);
		check(
			"the number menu offers Auto, the plain masks, currency and dates",
			nfMenu.length === 10 &&
				nfMenu[0] === "Auto" &&
				nfMenu.includes("#,##0.00") &&
				nfMenu.includes("0%") &&
				nfMenu.includes("Currency $") &&
				nfMenu.includes("Date and time"),
			JSON.stringify(nfMenu),
		);
		await page.click('.menu .menu-item:has(.menu-item-title:text-is("Currency $"))');
		await page.waitForTimeout(400);

		const money = await page.evaluate(() => {
			const q = (x, y) =>
				document.querySelector(`.leovale-sheet-content .leovale-sheet-root td[data-x="${x}"][data-y="${y}"]`);
			const e = window.sheetView().sheetEngine;
			return {
				b2: q(1, 1).textContent,
				b3: q(1, 2).textContent,
				b4: q(1, 3).textContent,
				c2: q(2, 1).textContent,
				styleB2: e.getStyleAt("B2"),
				rawB2: e.getRawValue("B2"),
				rawB4: e.getRawValue("B4"),
				attr: q(1, 1).getAttribute("data-nf"),
				label: document.querySelector(".leovale-sheet-tb-nfvalue").textContent,
			};
		});
		console.log("  currency:", money);
		check("a literal renders through the mask", money.b2 === "$3.00", String(money.b2));
		check("so does the second cell of the range", money.b3 === "$4.00", String(money.b3));
		check(
			"a COMPUTED formula result renders through the mask",
			money.b4 === "$7.00",
			String(money.b4),
		);
		check("an unformatted neighbour is untouched", money.c2 === "6", String(money.c2));
		check(
			"the mask joins the keys the cell already had (B2 kept its outline border)",
			money.styleB2.nf === "$#,##0.00" && money.styleB2.bd === "tr",
			JSON.stringify(money.styleB2),
		);
		check("the mask lives on the cell element", money.attr === "$#,##0.00", String(money.attr));
		check(
			"the RAW value is untouched by the mask",
			String(money.rawB2) === "3",
			JSON.stringify(money.rawB2),
		);
		check(
			"a formatted formula cell still holds its formula",
			money.rawB4 === "=SUM(B2:B3)",
			String(money.rawB4),
		);
		check("the toolbar shows the live mask", money.label === "$#,##0.00", money.label);

		// the formula bar must show the raw value, not the formatted text
		await page.click('.leovale-sheet-content .leovale-sheet-root td[data-x="1"][data-y="1"]');
		await page.waitForTimeout(250);
		check(
			"the formula bar shows the raw value of a masked cell",
			(await page.evaluate(() => document.querySelector(".leovale-sheet-fb-input").value)) === "3",
		);

		step("alignment via the toolbar");
		await page.mouse.move(b2box.x + b2box.width / 2, b2box.y + b2box.height / 2);
		await page.mouse.down();
		await page.mouse.move(b4box.x + b4box.width / 2, b4box.y + b4box.height / 2, { steps: 6 });
		await page.mouse.up();
		await page.waitForTimeout(150);
		await page.click(`${tb} .leovale-sheet-tb-align`);
		await page.waitForTimeout(250);
		const alignMenu = await page.evaluate(() =>
			[...document.querySelectorAll(".menu .menu-item")].map((i) => ({
				t: i.querySelector(".menu-item-title")?.textContent,
				svg: !!i.querySelector(".menu-item-icon svg"),
			})),
		);
		console.log("  align menu:", alignMenu);
		check(
			"one menu carries both axes and every item drew its icon",
			alignMenu.length === 6 && alignMenu.every((i) => i.svg),
			JSON.stringify(alignMenu),
		);
		await page.click('.menu .menu-item:has(.menu-item-title:text-is("Right"))');
		await page.waitForTimeout(300);
		await page.click(`${tb} .leovale-sheet-tb-align`);
		await page.waitForTimeout(250);
		await page.click('.menu .menu-item:has(.menu-item-title:text-is("Top"))');
		await page.waitForTimeout(300);
		const aligned = await page.evaluate(() => {
			const td = document.querySelector('.leovale-sheet-content .leovale-sheet-root td[data-x="1"][data-y="1"]');
			const cs = getComputedStyle(td);
			const plain = document.querySelector('.leovale-sheet-content .leovale-sheet-root td[data-x="2"][data-y="1"]');
			return {
				align: cs.textAlign,
				vertical: cs.verticalAlign,
				style: window.sheetView().sheetEngine.getStyleAt("B2"),
				untouched: getComputedStyle(plain).textAlign,
				button: document.querySelector(".leovale-sheet-tb-align").className,
			};
		});
		console.log("  aligned:", aligned);
		check("text-align applied", aligned.align === "right", aligned.align);
		check("vertical-align applied", aligned.vertical === "top", aligned.vertical);
		check(
			"both keys are in the style",
			aligned.style.ha === "r" && aligned.style.va === "t",
			JSON.stringify(aligned.style),
		);
		check("a neighbouring cell keeps the default alignment", aligned.untouched === "left",
			aligned.untouched);
		check("the align button reflects the selection", aligned.button.includes("is-active"),
			aligned.button);
		check(
			"the button is not left looking pressed after the menu closed",
			!aligned.button.includes("is-open"),
			aligned.button,
		);

		step("wrap via the toolbar");
		await typeInCell(page, 3, 1, "A rather long sentence that has to wrap inside its cell");
		await page.click('.leovale-sheet-content .leovale-sheet-root td[data-x="3"][data-y="1"]');
		await page.waitForTimeout(150);
		const beforeWrap = await page.evaluate(() => {
			const td = document.querySelector('.leovale-sheet-content .leovale-sheet-root td[data-x="3"][data-y="1"]');
			return { height: Math.round(td.getBoundingClientRect().height), ws: getComputedStyle(td).whiteSpace };
		});
		await page.click(`${tb} .leovale-sheet-tb-wrap`);
		await page.waitForTimeout(400);
		const wrapped = await page.evaluate(() => {
			const td = document.querySelector('.leovale-sheet-content .leovale-sheet-root td[data-x="3"][data-y="1"]');
			return {
				ws: getComputedStyle(td).whiteSpace,
				cls: td.className,
				overflowWrap: td.style.overflowWrap,
				height: Math.round(td.getBoundingClientRect().height),
				style: window.sheetView().sheetEngine.getStyleAt("D2"),
				button: document.querySelector(".leovale-sheet-tb-wrap").className,
			};
		});
		console.log("  wrap:", { beforeWrap, wrapped });
		check("wrap is stored as the overflow-wrap marker", wrapped.overflowWrap === "break-word",
			wrapped.overflowWrap);
		check("the wrap class was applied", wrapped.cls.includes("leovale-sheet-wrap"), wrapped.cls);
		check("the cell really wraps now", wrapped.ws === "pre-wrap", wrapped.ws);
		check("wrapping made the row taller", wrapped.height > beforeWrap.height,
			`${beforeWrap.height} -> ${wrapped.height}`);
		check("the wrap key is in the style", wrapped.style.wrap === true, JSON.stringify(wrapped.style));
		check("the wrap button shows its state", wrapped.button.includes("is-active"), wrapped.button);

		await shot(page, "11-formats-light");
		await shot(page, "02-filled-light");

		step("autosave -> file on disk");
		// scheduleSave waits 1.5 s, Obsidian's requestSave another ~2 s.
		await page.waitForTimeout(5000);
		console.log(
			"  [debug]",
			await page.evaluate(() => {
				const leaves = window.app.workspace.getLeavesOfType("leovale-sheet-view");
				const v = window.sheetView();
				return {
					leaves: leaves.length,
					deferred: leaves.map((l) => l.isDeferred),
					hasView: !!v,
					readOnly: v?.sheetReadOnly,
					file: v?.file?.path,
					dirty: v?.sheetDirty,
					lastGoodLen: v?.sheetLastGood?.length,
					readDocCells: v?.sheetEngine ? Object.keys(v.sheetEngine.readDoc().sheets[0].cells) : null,
				};
			}),
		);
		const onDisk = fs.readFileSync(diskPath, "utf8");
		console.log("  ---- file on disk ----");
		console.log(
			onDisk
				.split("\n")
				.map((l) => "  | " + l)
				.join("\n"),
		);

		check("no BOM", !onDisk.startsWith("\ufeff"));
		check("LF endings only", !onDisk.includes("\r"));
		check("trailing newline", onDisk.endsWith("}\n"));
		check(
			"2-space indent header, format version 4",
			onDisk.startsWith('{\n  "format": "leovale-sheet",\n  "version": 4,'),
			onDisk.slice(0, 60),
		);
		check("valid JSON", (() => { try { JSON.parse(onDisk); return true; } catch { return false; } })());
		check('A1 stored as { "v": "Item", ... }', /"A1": \{ "v": "Item"[,}]/.test(onDisk));
		check("B2 stored as a number", /"B2": \{ "v": 3[,}]/.test(onDisk));
		check(
			"B4 stored as formula source",
			/"B4": \{ "f": "=SUM\(B2:B3\)"[,}]/.test(onDisk),
			onDisk.split("\n").find((l) => l.includes('"B4"')),
		);
		check("computed results are not cached", !/"B4": \{ "v"/.test(onDisk));
		check(
			"column width persisted",
			/"colWidths": \{\n\s+"0": (\d+)/.exec(onDisk)?.[1] === String(width),
			`expected width ${width}`,
		);
		check("sparse: empty cells absent", !onDisk.includes('"Z100"') && onDisk.length < 3000,
			`len=${onDisk.length}`);
		check(
			"row height persisted",
			/"rowHeights": \{\n\s+"1": (\d+)\n\s+\}/.exec(onDisk)?.[1] === String(rowHeight),
			`expected row height ${rowHeight}`,
		);
		check(
			"cell style persisted in normalized form",
			onDisk.includes('"A1": { "v": "Item", "s": { "b": true, "fs": 18, "bg": "#fff2cc", "bd": "trbl" } }'),
		);
		check(
			"outline borders persisted per side",
			onDisk.includes('"bd": "tl"') && onDisk.includes('"bd": "tr"') &&
				onDisk.includes('"bd": "bl"') && onDisk.includes('"bd": "rb"'),
		);
		// B2 also carries the outline border from the previous step, which makes
		// this the strongest available check of the serialization ORDER: bd first,
		// then the 1.2.0 keys, nf -> ha -> va.
		check(
			"the number format is persisted as a mask, in the fixed order after bd",
			/"B2": \{ "v": 3, "s": \{ "bd": "tr", "nf": "\$#,##0\.00", "ha": "r", "va": "t" \} \}/.test(onDisk),
			onDisk.split("\n").find((l) => l.includes('"B2"')),
		);
		check(
			"a formatted formula cell keeps its formula and gains the mask",
			/"B4": \{ "f": "=SUM\(B2:B3\)", "s": \{ "nf": "\$#,##0\.00", "ha": "r", "va": "t" \} \}/.test(onDisk),
			onDisk.split("\n").find((l) => l.includes('"B4"')),
		);
		check("formatted values are stored raw, never as the formatted text", !onDisk.includes("$3.00"));
		check("wrap is persisted", /"D2": \{ "v": "A rather long[^}]*"wrap": true \}/.test(onDisk),
			onDisk.split("\n").find((l) => l.includes('"D2"')));
		check("no raw CSS leaked into the file", !/font-weight|px|--leovale/.test(onDisk));
		check(
			"no alignment key on cells nobody aligned",
			(onDisk.match(/"ha":/g) ?? []).length === 3,
			String((onDisk.match(/"ha":/g) ?? []).length),
		);
		check("one cell per line", onDisk.split("\n").every((l) => (l.match(/"[A-Z]+[0-9]+": \{/g) ?? []).length <= 1));

		// deterministic: re-save must produce identical bytes
		const before = onDisk;
		await page.evaluate((id) => window.app.commands.executeCommandById(`${id}:save-sheet`), PLUGIN_ID);
		await page.waitForTimeout(1200);
		check("re-save is byte-identical (deterministic)", fs.readFileSync(diskPath, "utf8") === before);

		step("close and reopen the file");
		await page.evaluate(() => window.app.workspace.detachLeavesOfType("leovale-sheet-view"));
		await page.waitForTimeout(800);
		check(
			"no sheet view left open",
			(await page.evaluate(
				() => window.app.workspace.getLeavesOfType("leovale-sheet-view").length,
			)) === 0,
		);
		check("file survived the close", fs.readFileSync(diskPath, "utf8") === before);

		await page.evaluate(async (p) => {
			const f = window.app.vault.getAbstractFileByPath(p);
			await window.app.workspace.getLeaf(true).openFile(f);
		}, SHEET_PATH);
		await page.waitForTimeout(2000);

		const reopened = await page.evaluate(() => {
			const q = (x, y) =>
				document.querySelector(`.leovale-sheet-content .leovale-sheet-root td[data-x="${x}"][data-y="${y}"]`)?.textContent;
			const ws = window.wsHandle();
			const cs = getComputedStyle(
				document.querySelector('.leovale-sheet-content .leovale-sheet-root td[data-x="0"][data-y="0"]'),
			);
			const rowDef = ws?.options?.rows?.[1];
			return {
				a1: q(0, 0),
				b2: q(1, 1),
				b4: q(1, 3),
				c2: q(2, 1),
				c4: q(2, 3),
				widthA: ws ? Number(ws.options.columns[0].width) : null,
				rowHeight: rowDef ? parseInt(rowDef.height, 10) : null,
				weight: cs.fontWeight,
				size: cs.fontSize,
				bg: cs.backgroundColor,
				styleA1: window.sheetView().sheetEngine.getStyleAt("A1"),
				styleA2: window.sheetView().sheetEngine.getStyleAt("A2"),
			};
		});
		console.log("  ", reopened);
		check("A1 restored", reopened.a1 === "Item", String(reopened.a1));
		// B2 and B4 carry a currency mask since 1.2.0, so their DISPLAY is masked;
		// the raw values are checked below and in the file dump above.
		check("B2 restored (and re-masked)", reopened.b2 === "$3.00", String(reopened.b2));
		check(
			"formula recomputed after reload (B4 = 7, shown as $7.00)",
			reopened.b4 === "$7.00",
			String(reopened.b4),
		);
		check("formula recomputed after reload (C2 = 6)", reopened.c2 === "6", String(reopened.c2));
		check("column width restored", reopened.widthA === width, String(reopened.widthA));
		check("row height restored", reopened.rowHeight === rowHeight, String(reopened.rowHeight));
		check("bold restored", reopened.weight === "700" || reopened.weight === "bold", reopened.weight);
		check("font size restored", reopened.size === "18px", reopened.size);
		check("fill restored", reopened.bg === "rgb(255, 242, 204)", reopened.bg);
		check(
			"normalized style restored exactly",
			JSON.stringify(reopened.styleA1) === '{"b":true,"fs":18,"bg":"#fff2cc","bd":"trbl"}',
			JSON.stringify(reopened.styleA1),
		);
		check("outline border restored", reopened.styleA2.bd === "tl", String(reopened.styleA2.bd));

		// 1.2.0: the mask has to be replayed onto the cells at load time, and the
		// wrap class has to come back from the inline marker.
		const reopenedFormats = await page.evaluate(() => {
			const q = (x, y) =>
				document.querySelector(`.leovale-sheet-content .leovale-sheet-root td[data-x="${x}"][data-y="${y}"]`);
			const e = window.sheetView().sheetEngine;
			const d2 = q(3, 1);
			return {
				b2: q(1, 1).textContent,
				b4: q(1, 3).textContent,
				rawB2: e.getRawValue("B2"),
				styleB2: e.getStyleAt("B2"),
				align: getComputedStyle(q(1, 1)).textAlign,
				vertical: getComputedStyle(q(1, 1)).verticalAlign,
				wrapClass: d2.className.includes("leovale-sheet-wrap"),
				whiteSpace: getComputedStyle(d2).whiteSpace,
				styleD2: e.getStyleAt("D2"),
				dirty: window.sheetView().sheetDirty,
			};
		});
		console.log("  reopened formats:", reopenedFormats);
		check("the mask is applied again after reopening", reopenedFormats.b2 === "$3.00",
			String(reopenedFormats.b2));
		check("a formula recomputed AND reformatted", reopenedFormats.b4 === "$7.00",
			String(reopenedFormats.b4));
		check("the raw value survived the round trip", reopenedFormats.rawB2 === 3,
			JSON.stringify(reopenedFormats.rawB2));
		check(
			"the whole 1.2.0 style came back",
			reopenedFormats.styleB2.nf === "$#,##0.00" &&
				reopenedFormats.styleB2.ha === "r" &&
				reopenedFormats.styleB2.va === "t" &&
				reopenedFormats.styleB2.bd === "tr",
			JSON.stringify(reopenedFormats.styleB2),
		);
		check("alignment restored", reopenedFormats.align === "right" && reopenedFormats.vertical === "top",
			JSON.stringify([reopenedFormats.align, reopenedFormats.vertical]));
		check("the wrap class was re-applied from the file", reopenedFormats.wrapClass,
			String(reopenedFormats.wrapClass));
		check("the wrapped cell still wraps", reopenedFormats.whiteSpace === "pre-wrap",
			reopenedFormats.whiteSpace);
		check("wrap survived the round trip", reopenedFormats.styleD2.wrap === true,
			JSON.stringify(reopenedFormats.styleD2));

		// The save-path audit: mounting a document must never make it dirty. A
		// stale editor or formula bar committing during load was the suspected
		// cause of an old value reappearing in a cell.
		check("merely opening a file leaves it clean", reopenedFormats.dirty !== true,
			String(reopenedFormats.dirty));
		await page.waitForTimeout(5000);
		check(
			"and nothing was written to disk by opening it",
			fs.readFileSync(diskPath, "utf8") === before,
		);
		check(
			"still not dirty after the autosave window",
			(await page.evaluate(() => window.sheetView().sheetDirty)) !== true,
		);
		await shot(page, "03-reopened-light");

		step("reloading the plugin with a sheet open does not double its key handlers");
		// The engine registers keydown/mousedown on `document` and only releases
		// them when its LAST instance dies. With the tab left open across a reload
		// (a BRAT update does exactly this), a second set used to survive, and then
		// one ArrowRight moved the selection by two cells, three after the next
		// reload, and so on. Two reloads here, then count the steps.
		const afterReload = await page.evaluate(async (id) => {
			const app = window.app;
			for (let i = 0; i < 2; i++) {
				await app.plugins.disablePlugin(id);
				await new Promise((r) => setTimeout(r, 500));
				await app.plugins.enablePlugin(id);
				await new Promise((r) => setTimeout(r, 1200));
			}
			// The leaf survived the reload, so re-render it by re-opening the file.
			const file = app.vault.getAbstractFileByPath("Untitled.sheet");
			app.workspace.detachLeavesOfType("leovale-sheet-view");
			await new Promise((r) => setTimeout(r, 300));
			await app.workspace.getLeaf(true).openFile(file);
			await new Promise((r) => setTimeout(r, 1500));
			return { leaves: app.workspace.getLeavesOfType("leovale-sheet-view").length };
		}, PLUGIN_ID);
		console.log("  after two reloads:", afterReload);
		await page.click('.leovale-sheet-content .leovale-sheet-root td[data-x="0"][data-y="0"]');
		await page.waitForTimeout(200);
		await page.keyboard.press("ArrowRight");
		await page.waitForTimeout(200);
		const oneStep = await selectedCell(page);
		check(
			"one ArrowRight still moves exactly one cell after two plugin reloads",
			JSON.stringify(oneStep) === "[1,0]",
			JSON.stringify(oneStep),
		);
		check(
			"the file is untouched by the reloads",
			fs.readFileSync(diskPath, "utf8") === before,
		);

		step("dark theme");
		await setBaseTheme(page, "obsidian");
		await page.waitForTimeout(1200);
		const darkOk = await page.evaluate(() => {
			// A3 has no fill: it must follow the theme's own text colour
			const td = document.querySelector('.leovale-sheet-content .leovale-sheet-root td[data-x="0"][data-y="2"]');
			const head = document.querySelector(".leovale-sheet-content .leovale-sheet-root thead td:nth-child(2)");
			const table = document.querySelector(".leovale-sheet-content .leovale-sheet-root table.jss_worksheet");
			const rgb = (s) => (s.match(/\d+/g) ?? []).slice(0, 3).map(Number);
			const lum = (c) => (c.length === 3 ? (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255 : null);
			const filled = document.querySelector('.leovale-sheet-content .leovale-sheet-root td[data-x="0"][data-y="0"]');
			const fs = getComputedStyle(filled);
			const cs = getComputedStyle(td);
			return {
				filledText: fs.color,
				filledBg: fs.backgroundColor,
				filledContrast: Math.abs(lum(rgb(fs.color)) - lum(rgb(fs.backgroundColor))),
				bodyTheme: document.body.className,
				cellColor: cs.color,
				cellBg: getComputedStyle(table).backgroundColor,
				headBg: getComputedStyle(head).backgroundColor,
				headColor: getComputedStyle(head).color,
				textLum: lum(rgb(cs.color)),
				bgLum: lum(rgb(getComputedStyle(table).backgroundColor)),
			};
		});
		console.log("  ", darkOk);
		check("app switched to dark", darkOk.bodyTheme.includes("theme-dark"), darkOk.bodyTheme);
		check(
			"grid background is dark",
			darkOk.bgLum !== null && darkOk.bgLum < 0.35,
			String(darkOk.bgLum),
		);
		check(
			"cell text is light (no white-on-white / black-on-black)",
			darkOk.textLum !== null && Math.abs(darkOk.textLum - darkOk.bgLum) > 0.35,
			`text=${darkOk.textLum} bg=${darkOk.bgLum}`,
		);
		check(
			"filled header cell stays readable in dark theme",
			darkOk.filledContrast > 0.4,
			`text=${darkOk.filledText} on bg=${darkOk.filledBg} contrast=${darkOk.filledContrast}`,
		);
		await shot(page, "04-dark");

		// same palette popover, dark theme
		await page.click(".leovale-sheet-toolbar .leovale-sheet-tb-fillbtn");
		await page.waitForTimeout(250);
		check(
			"palette opens in dark theme too",
			await page.locator(".leovale-sheet-toolbar .leovale-sheet-palette.is-open").isVisible(),
		);
		const paletteDark = await page.evaluate(() => {
			const pal = document.querySelector(".leovale-sheet-palette");
			const ps = getComputedStyle(pal);
			const btn = document.querySelector(".leovale-sheet-tb-fillbtn");
			return {
				bg: ps.backgroundColor,
				border: ps.borderTopColor,
				radius: ps.borderRadius,
				cols: ps.gridTemplateColumns.split(" ").length,
				fillActive: btn.classList.contains("is-active"),
			};
		});
		console.log("  palette (dark):", paletteDark);
		check("palette uses the dark secondary background", paletteDark.bg !== "rgb(255, 255, 255)", paletteDark.bg);
		check("palette is a 6-column grid, 6px rounded", paletteDark.cols === 6 && paletteDark.radius === "6px",
			JSON.stringify(paletteDark));
		check("fill button shows its open state", paletteDark.fillActive);
		await shot(page, "07-palette-open-dark");
		await page.keyboard.press("Escape");
		await page.click(".leovale-sheet-content .leovale-sheet-root td[data-x=\"3\"][data-y=\"6\"]");
		await page.waitForTimeout(250);

		step("CSS containment: nothing leaked into the rest of the app");
		const leak = await page.evaluate(() => {
			const bodyBg = getComputedStyle(document.body).backgroundColor;
			const sheet = [...document.styleSheets].find((s) =>
				[...(s.cssRules ?? [])].some((r) => (r.selectorText ?? "").includes("leovale-sheet-root")),
			);
			let unscoped = [];
			if (sheet) {
				for (const r of sheet.cssRules) {
					const sels = (r.selectorText ?? "").split(",").map((s) => s.trim());
					for (const s of sels) {
						if (!s) continue;
						if (!s.includes(".leovale-sheet")) unscoped.push(s);
					}
				}
			}
			return { bodyBg, unscoped: unscoped.slice(0, 10), count: unscoped.length };
		});
		console.log("  ", leak);
		check("every top-level rule in styles.css is scoped", leak.count === 0, JSON.stringify(leak.unscoped));

		step("back to light + final screenshot");
		await setBaseTheme(page, "moonstone");
		await page.waitForTimeout(1000);
		await shot(page, "05-final-light");

		step("data-loss guard");
		const guard = await page.evaluate(async () => {
			const view = window.sheetView();
			// Simulate a broken engine: getViewData() must fall back, never "".
			const saved = view.sheetEngine;
			view.sheetEngine = { readDoc: () => { throw new Error("boom"); } };
			view.sheetDirty = true;
			const out = view.getViewData();
			view.sheetEngine = saved;
			view.sheetDirty = false;
			return { len: out.length, startsOk: out.startsWith('{\n  "format"') };
		});
		console.log("  ", guard);
		check("getViewData falls back to lastGood when serialization throws", guard.len > 100 && guard.startsOk);
		check("file untouched by the guard test", fs.readFileSync(diskPath, "utf8") === before);

		step("i18n: English by default, Russian when Obsidian is Russian");
		const enMenu = await page.evaluate(async () => {
			document.querySelector(".leovale-sheet-tb-border").click();
			await new Promise((r) => setTimeout(r, 250));
			const items = [...document.querySelectorAll(".menu .menu-item-title")].map((i) => i.textContent);
			document.body.click();
			return {
				items,
				bold: document.querySelector(".leovale-sheet-tb-bold").getAttribute("aria-label"),
				placeholder: document.querySelector(".leovale-sheet-fb-input").placeholder,
			};
		});
		console.log("  en:", enMenu);
		check("border menu is English", enMenu.items[0] === "All borders", JSON.stringify(enMenu.items));
		check("outer/none are English too",
			enMenu.items[1] === "Outer borders" && enMenu.items[2] === "No borders", JSON.stringify(enMenu.items));
		check("button tooltips are English", enMenu.bold === "Bold", String(enMenu.bold));
		check("formula bar placeholder is English", enMenu.placeholder === "Value or formula", enMenu.placeholder);

		const ruMenu = await page.evaluate(async () => {
			window.localStorage.setItem("language", "ru");
			// Strings are read at build time of each control: re-render the view.
			const view = window.sheetView();
			view.setViewData(view.getViewData(), false);
			await new Promise((r) => setTimeout(r, 400));
			document.querySelector(".leovale-sheet-tb-border").click();
			await new Promise((r) => setTimeout(r, 250));
			const items = [...document.querySelectorAll(".menu .menu-item-title")].map((i) => i.textContent);
			document.body.click();
			const out = {
				items,
				bold: document.querySelector(".leovale-sheet-tb-bold").getAttribute("aria-label"),
				placeholder: document.querySelector(".leovale-sheet-fb-input").placeholder,
			};
			window.localStorage.setItem("language", "en");
			view.setViewData(view.getViewData(), false);
			await new Promise((r) => setTimeout(r, 400));
			return out;
		});
		console.log("  ru:", ruMenu);
		check("ru locale switches the menu", ruMenu.items[0] === "Все границы", JSON.stringify(ruMenu.items));
		check("ru locale switches tooltips", ruMenu.bold === "Жирный", String(ruMenu.bold));
		check("ru locale switches the placeholder", ruMenu.placeholder === "Значение или формула", ruMenu.placeholder);
		check(
			"back to English after restoring the locale",
			(await page.locator(".leovale-sheet-tb-bold").getAttribute("aria-label")) === "Bold",
		);

		// 1.2.0 ships twelve languages, so a non-Cyrillic one is exercised too, and
		// the region-code path (`de-AT` -> de) with it.
		const otherLocales = await page.evaluate(async () => {
			const view = window.sheetView();
			const read = async (code) => {
				window.localStorage.setItem("language", code);
				view.setViewData(view.getViewData(), false);
				await new Promise((r) => setTimeout(r, 400));
				document.querySelector(".leovale-sheet-tb-number").click();
				await new Promise((r) => setTimeout(r, 250));
				const items = [...document.querySelectorAll(".menu .menu-item-title")].map(
					(i) => i.textContent,
				);
				document.body.click();
				await new Promise((r) => setTimeout(r, 150));
				return {
					wrap: document.querySelector(".leovale-sheet-tb-wrap").getAttribute("aria-label"),
					align: document.querySelector(".leovale-sheet-tb-align").getAttribute("aria-label"),
					firstFormat: items[0],
					masksKept: items.includes("#,##0.00"),
				};
			};
			const out = { de: await read("de-AT"), zh: await read("zh"), ja: await read("ja") };
			window.localStorage.setItem("language", "en");
			view.setViewData(view.getViewData(), false);
			await new Promise((r) => setTimeout(r, 400));
			return out;
		});
		console.log("  other locales:", otherLocales);
		check("a region code resolves to its language (de-AT -> de)",
			otherLocales.de.wrap === "Textumbruch" && otherLocales.de.align === "Ausrichtung",
			JSON.stringify(otherLocales.de));
		check("Chinese is translated", otherLocales.zh.wrap === "自动换行" && otherLocales.zh.firstFormat === "自动",
			JSON.stringify(otherLocales.zh));
		check("Japanese is translated", otherLocales.ja.wrap === "折り返して全体を表示",
			JSON.stringify(otherLocales.ja));
		check(
			"the mask-shaped menu entries stay identical in every language",
			otherLocales.de.masksKept && otherLocales.zh.masksKept && otherLocales.ja.masksKept,
			JSON.stringify([otherLocales.de.masksKept, otherLocales.zh.masksKept]),
		);

		step("mobile emulation: 800x1340, mobile:true, body.is-mobile");
		// Everything mobile-specific is CSS gated on `body.is-mobile` (Obsidian's
		// own class) so it can be exercised here. What this pass CANNOT prove is
		// the actual touch behaviour: Obsidian's sidebar swipe handler and
		// env(safe-area-inset-bottom) only exist on a real device.
		const cdp = await ctx.newCDPSession(page);
		await cdp.send("Emulation.setDeviceMetricsOverride", {
			width: 800,
			height: 1340,
			deviceScaleFactor: 2,
			mobile: true,
		});
		await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
		await page.evaluate(() => document.body.classList.add("is-mobile"));
		await page.waitForTimeout(700);
		await page.click(".leovale-sheet-content .leovale-sheet-root td[data-x=\"0\"][data-y=\"0\"]");
		await page.waitForTimeout(200);
		await page.click(".leovale-sheet-toolbar .leovale-sheet-tb-fillbtn");
		await page.waitForTimeout(400);
		const mob = await page.evaluate(() => {
			const q = (s) => document.querySelector(s);
			const box = (el) => el.getBoundingClientRect();
			const wrapper = q(".leovale-sheet-wrapper");
			const btn = q(".leovale-sheet-toolbar .leovale-sheet-tb-btn");
			const swatch = q(".leovale-sheet-swatch");
			const bar = q(".leovale-sheet-formulabar");
			const input = q(".leovale-sheet-fb-input");
			const rowHead = q('.leovale-sheet-root tbody tr:nth-child(4) td.jss_row');
			const beforeLeft = box(rowHead).left;
			wrapper.scrollLeft = 320;
			void wrapper.offsetWidth;
			const afterLeft = box(rowHead).left;
			const scrolled = wrapper.scrollLeft;
			wrapper.scrollLeft = 0;
			return {
				viewport: [window.innerWidth, window.innerHeight],
				btn: [Math.round(box(btn).width), Math.round(box(btn).height)],
				swatch: [Math.round(box(swatch).width), Math.round(box(swatch).height)],
				barHeight: Math.round(box(bar).height),
				inputHeight: Math.round(box(input).height),
				toolbarHeight: Math.round(box(q(".leovale-sheet-toolbar")).height),
				padBottom: parseFloat(getComputedStyle(wrapper).paddingBottom),
				touchAction: getComputedStyle(wrapper).touchAction,
				scrolled,
				rowMoved: Math.abs(afterLeft - beforeLeft),
			};
		});
		console.log("  mobile metrics:", mob);
		check("emulated viewport is the tablet's", mob.viewport[0] === 800, JSON.stringify(mob.viewport));
		check("toolbar buttons are >= 44x44", mob.btn[0] >= 44 && mob.btn[1] >= 44, JSON.stringify(mob.btn));
		check("toolbar row grew to fit them", mob.toolbarHeight >= 48, String(mob.toolbarHeight));
		check("palette swatches are >= 44x44", mob.swatch[0] >= 44 && mob.swatch[1] >= 44, JSON.stringify(mob.swatch));
		check("formula bar is >= 44 tall", mob.barHeight >= 44, String(mob.barHeight));
		check("its input is a comfortable target", mob.inputHeight >= 32, String(mob.inputHeight));
		check("bottom safe-area padding is applied", mob.padBottom >= 12, String(mob.padBottom));
		check("grid owns both pan directions", /pan-x/.test(mob.touchAction), mob.touchAction);
		check("row numbers stay frozen on the narrow viewport", mob.scrolled > 200 && mob.rowMoved < 2,
			`scrolled=${mob.scrolled} moved=${mob.rowMoved}`);
		await shot(page, "08-mobile-light");
		await page.click(".leovale-sheet-toolbar .leovale-sheet-tb-fillbtn");
		await setBaseTheme(page, "obsidian");
		await page.waitForTimeout(900);
		await shot(page, "09-mobile-dark");
		await setBaseTheme(page, "moonstone");
		await page.evaluate(() => document.body.classList.remove("is-mobile"));
		await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
		await cdp.send("Emulation.clearDeviceMetricsOverride");
		await page.waitForTimeout(800);

		step("csv: open, edit, autosave, delimiter and quoting preserved");
		const CSV_PATH = "data.csv";
		const csvDisk = path.join(VAULT, CSV_PATH);
		const CSV_SOURCE = 'name;note\nWidget;"red; large"\nGadget;plain\n';
		await page.evaluate(
			async ([p, text]) => {
				const app = window.app;
				app.workspace.detachLeavesOfType("leovale-sheet-view");
				const old = app.vault.getAbstractFileByPath(p);
				if (old) await app.vault.delete(old);
				const f = await app.vault.create(p, text);
				await app.workspace.getLeaf(true).openFile(f);
			},
			[CSV_PATH, CSV_SOURCE],
		);
		// Wait for the CSV to actually be MOUNTED, do not just hope 2 s is enough.
		// On a cold start it is not, and the consequence is nasty: the steps below
		// would type into whatever view is still on screen (seen once: the .sheet
		// under test got a CSV value written into C2).
		await page.waitForFunction(() => window.sheetView()?.sheetMode === "csv", null, {
			timeout: 20_000,
		});
		await page.waitForTimeout(600);
		const csvOpen = await page.evaluate(() => {
			const v = window.sheetView();
			const q = (x, y) =>
				document.querySelector(`.leovale-sheet-content .leovale-sheet-root td[data-x="${x}"][data-y="${y}"]`)?.textContent;
			return {
				viewType: window.app.workspace.activeLeaf?.view?.getViewType?.(),
				mode: v?.sheetMode,
				delimiter: v?.sheetDelimiter,
				badge: document.querySelector(".leovale-sheet-fb-badge")?.textContent,
				a1: q(0, 0),
				b1: q(1, 0),
				a2: q(0, 1),
				b2: q(1, 1),
				a3: q(0, 2),
				b3: q(1, 2),
			};
		});
		console.log("  csv opened:", csvOpen);
		check("a .csv opens in our grid", csvOpen.viewType === "leovale-sheet-view", String(csvOpen.viewType));
		check("the view switched to csv mode", csvOpen.mode === "csv", String(csvOpen.mode));
		check("the semicolon delimiter was detected", csvOpen.delimiter === ";", String(csvOpen.delimiter));
		check("the badge names the delimiter", csvOpen.badge === "CSV ;", String(csvOpen.badge));
		check("header row parsed", csvOpen.a1 === "name" && csvOpen.b1 === "note", JSON.stringify(csvOpen));
		check(
			"a quoted field with the delimiter inside parsed as one cell",
			csvOpen.b2 === "red; large",
			String(csvOpen.b2),
		);
		check("second data row parsed", csvOpen.a3 === "Gadget" && csvOpen.b3 === "plain", JSON.stringify(csvOpen));

		// edit a cell; the comma in it must NOT be quoted in a semicolon file
		await typeInCell(page, 2, 1, "a,b");
		// formatting is allowed in memory but must not reach the file
		await page.click('.leovale-sheet-content .leovale-sheet-root td[data-x="0"][data-y="0"]');
		await page.waitForTimeout(150);
		await page.click(".leovale-sheet-toolbar .leovale-sheet-tb-bold");
		await page.waitForTimeout(200);
		check(
			"formatting still applies in memory for csv",
			(await page.evaluate(() => window.sheetView().sheetEngine.getStyleAt("A1").b)) === true,
		);
		await page.waitForTimeout(5000);
		const csvSaved = fs.readFileSync(csvDisk, "utf8");
		console.log("  ---- csv on disk ----");
		console.log(csvSaved.split("\n").map((l) => "  | " + l).join("\n"));
		check("LF only, never CRLF", !csvSaved.includes("\r"));
		check("trailing newline", csvSaved.endsWith("\n"));
		check("the detected delimiter is what was written", csvSaved.startsWith("name;note"), csvSaved.slice(0, 20));
		check('quoting preserved for "red; large"', csvSaved.includes('"red; large"'), csvSaved);
		check(
			"a comma needs no quoting in a semicolon file",
			/;a,b(\n|$)/.test(csvSaved),
			csvSaved,
		);
		check(
			"rows are padded to a rectangle",
			csvSaved === 'name;note;\nWidget;"red; large";a,b\nGadget;plain;\n',
			JSON.stringify(csvSaved),
		);
		check("no styles leaked into the csv", !/font-weight|"s":|bold|#fff/.test(csvSaved));
		check("no JSON envelope in the csv", !csvSaved.includes('"format"'));

		// reopen: values come back, formatting does not (by design)
		await page.evaluate(async (p) => {
			window.app.workspace.detachLeavesOfType("leovale-sheet-view");
			await new Promise((r) => setTimeout(r, 400));
			const f = window.app.vault.getAbstractFileByPath(p);
			await window.app.workspace.getLeaf(true).openFile(f);
		}, CSV_PATH);
		await page.waitForFunction(() => window.sheetView()?.sheetMode === "csv", null, {
			timeout: 20_000,
		});
		await page.waitForTimeout(600);
		const csvReopened = await page.evaluate(() => {
			const q = (x, y) =>
				document.querySelector(`.leovale-sheet-content .leovale-sheet-root td[data-x="${x}"][data-y="${y}"]`)?.textContent;
			return {
				b2: q(1, 1),
				c2: q(2, 1),
				delimiter: window.sheetView()?.sheetDelimiter,
				boldA1: window.sheetView().sheetEngine.getStyleAt("A1").b,
			};
		});
		console.log("  csv reopened:", csvReopened);
		check("quoted value restored", csvReopened.b2 === "red; large", String(csvReopened.b2));
		check("edited value restored", csvReopened.c2 === "a,b", String(csvReopened.c2));
		check("delimiter still ;", csvReopened.delimiter === ";", String(csvReopened.delimiter));
		check("styles are NOT persisted for csv (documented)", csvReopened.boldA1 === undefined,
			String(csvReopened.boldA1));
		check("the file is unchanged by reopening", fs.readFileSync(csvDisk, "utf8") === csvSaved);
		await shot(page, "10-csv-light");

		/* ================================================================
		 * 1.3.0: sort, filters, frozen panes, find, keyboard, markdown,
		 * column width. All of it on a sheet of its own, so the assertions
		 * above (and the embeds below) keep their own file intact.
		 * ============================================================= */

		step("1.3.0: a data sheet with styled rows");
		const DATA_PATH = "Data.sheet";
		const dataDisk = path.join(VAULT, DATA_PATH);
		const DATA_SOURCE = [
			"{",
			'  "format": "leovale-sheet",',
			'  "version": 3,',
			'  "sheets": [',
			"    {",
			'      "name": "Sheet1",',
			'      "rows": 40,',
			'      "cols": 3,',
			'      "colWidths": {},',
			'      "rowHeights": {},',
			'      "merges": {},',
			'      "view": {},',
			'      "freeze": {},',
			'      "cells": {',
			'        "A1": { "v": "Fruit", "s": { "b": true } },',
			'        "B1": { "v": "Qty", "s": { "b": true } },',
			'        "C1": { "v": "Total", "s": { "b": true } },',
			'        "A2": { "v": "cherry", "s": { "bg": "#ffe0e0" } },',
			'        "B2": { "v": 3 },',
			'        "A3": { "v": "apple", "s": { "bg": "#e2f0d9" } },',
			'        "B3": { "v": 10 },',
			'        "A4": { "v": "banana", "s": { "bg": "#fff2cc" } },',
			'        "B4": { "v": 2 },',
			'        "C6": { "f": "=SUM(B2:B4)" }',
			"      }",
			"    }",
			"  ]",
			"}",
			"",
		].join("\n");

		const openData = async () => {
			await page.evaluate(
				async ([p, text]) => {
					const app = window.app;
					app.workspace.detachLeavesOfType("leovale-sheet-view");
					const old = app.vault.getAbstractFileByPath(p);
					if (old) await app.vault.delete(old);
					const f = await app.vault.create(p, text);
					await app.workspace.getLeaf(true).openFile(f);
				},
				[DATA_PATH, DATA_SOURCE],
			);
			await page.waitForFunction(
				() => window.sheetView()?.file?.path === "Data.sheet" && !!window.wsHandle(),
				null,
				{ timeout: 20_000 },
			);
			await page.waitForTimeout(500);
		};
		await openData();

		const dataCell = (x, y) =>
			page.evaluate(
				([cx, cy]) =>
					document.querySelector(
						`.leovale-sheet-content .leovale-sheet-root td[data-x="${cx}"][data-y="${cy}"]`,
					)?.textContent,
				[x, y],
			);
		const clickCell = async (x, y) => {
			await page.click(
				`.leovale-sheet-content .leovale-sheet-root td[data-x="${x}"][data-y="${y}"]`,
			);
			await page.waitForTimeout(120);
		};

		check("the data sheet mounted", (await dataCell(0, 1)) === "cherry", String(await dataCell(0, 1)));
		check("the formula outside the data block computed", (await dataCell(2, 5)) === "15",
			String(await dataCell(2, 5)));

		step("1.3.0: frozen rows from the toolbar");
		await clickCell(0, 1); // A2 -> everything above it freezes
		await page.click(".leovale-sheet-toolbar .leovale-sheet-tb-freeze");
		await page.waitForTimeout(250);
		const freezeMenu = await page.evaluate(() =>
			[...document.querySelectorAll(".menu .menu-item")].map((i) => ({
				t: i.querySelector(".menu-item-title")?.textContent,
				svg: !!i.querySelector(".menu-item-icon svg"),
			})),
		);
		console.log("  freeze menu:", freezeMenu);
		check(
			"every freeze menu item rendered its icon",
			freezeMenu.length === 4 && freezeMenu.every((i) => i.svg),
			JSON.stringify(freezeMenu),
		);
		await page.click('.menu .menu-item:has(.menu-item-title:text-is("Freeze rows above the selection"))');
		await page.waitForTimeout(400);

		const frozen = await page.evaluate(() => {
			const root = document.querySelector(".leovale-sheet-content .leovale-sheet-root");
			const td = root.querySelector('tbody > tr[data-y="0"] > td[data-x="0"]');
			const cs = getComputedStyle(td);
			const below = root.querySelector('tbody > tr[data-y="2"] > td[data-x="0"]');
			return {
				state: window.sheetView().sheetEngine.getFreeze(),
				styleTags: root.querySelectorAll("style").length,
				css: [...root.querySelectorAll("style")].map((s) => s.textContent).join("\n"),
				position: cs.position,
				top: cs.top,
				bg: cs.backgroundColor,
				belowPosition: getComputedStyle(below).position,
				hasClass: root.classList.contains("has-freeze"),
			};
		});
		console.log("  freeze:", { ...frozen, css: frozen.css.split("\n")[0] });
		check("the engine recorded the freeze", JSON.stringify(frozen.state) === '{"rows":1}',
			JSON.stringify(frozen.state));
		check("a generated stylesheet was written into the grid", frozen.styleTags === 1,
			String(frozen.styleTags));
		check("the frozen row is sticky", frozen.position === "sticky", frozen.position);
		check("it sticks below the column headers, not at 0", frozen.top !== "0px" && frozen.top !== "auto",
			frozen.top);
		check("a frozen cell is opaque", frozen.bg !== "rgba(0, 0, 0, 0)", frozen.bg);
		check("an unfrozen row is not sticky", frozen.belowPosition !== "sticky", frozen.belowPosition);
		check("the root is marked as frozen", frozen.hasClass);

		step("1.3.0: sorting moves styles with their rows");
		await clickCell(0, 1); // a cell in column A
		await page.click(".leovale-sheet-toolbar .leovale-sheet-tb-sort");
		await page.waitForTimeout(250);
		const sortMenu = await page.evaluate(() =>
			[...document.querySelectorAll(".menu .menu-item-title")].map((i) => i.textContent),
		);
		console.log("  sort menu:", sortMenu);
		check("the sort menu offers both directions and a clear",
			sortMenu.includes("Sort A → Z") && sortMenu.includes("Sort Z → A") && sortMenu.includes("Clear sort"),
			JSON.stringify(sortMenu));
		await page.click('.menu .menu-item:has(.menu-item-title:text-is("Sort A → Z"))');
		await page.waitForTimeout(900);

		const sorted = await page.evaluate(() => {
			const e = window.sheetView().sheetEngine;
			const q = (x, y) =>
				document.querySelector(
					`.leovale-sheet-content .leovale-sheet-root td[data-x="${x}"][data-y="${y}"]`,
				)?.textContent;
			return {
				col: [q(0, 0), q(0, 1), q(0, 2), q(0, 3)],
				qty: [q(1, 1), q(1, 2), q(1, 3)],
				styles: { A2: e.getStyleAt("A2"), A3: e.getStyleAt("A3"), A4: e.getStyleAt("A4"), A1: e.getStyleAt("A1") },
				view: e.getView(),
				total: q(2, 5),
				headerMarked: !!document.querySelector(
					'.leovale-sheet-content .leovale-sheet-root thead td[data-x="0"].leovale-sheet-sorted',
				),
			};
		});
		console.log("  sorted:", sorted);
		check("the header row stayed put (it is frozen)", sorted.col[0] === "Fruit", String(sorted.col[0]));
		check("rows are in ascending order", JSON.stringify(sorted.col.slice(1)) === '["apple","banana","cherry"]',
			JSON.stringify(sorted.col));
		check("each row's OWN number came with it", JSON.stringify(sorted.qty) === '["10","2","3"]',
			JSON.stringify(sorted.qty));
		check("apple kept its green fill", sorted.styles.A2.bg === "#e2f0d9", JSON.stringify(sorted.styles.A2));
		check("banana kept its yellow fill", sorted.styles.A3.bg === "#fff2cc", JSON.stringify(sorted.styles.A3));
		check("cherry kept its red fill", sorted.styles.A4.bg === "#ffe0e0", JSON.stringify(sorted.styles.A4));
		check("the frozen header kept its bold", sorted.styles.A1.b === true, JSON.stringify(sorted.styles.A1));
		check("the sort is recorded in the view", JSON.stringify(sorted.view.sort) === '{"col":0,"dir":"asc"}',
			JSON.stringify(sorted.view));
		check("the sorted column is marked in its header", sorted.headerMarked);
		check("a formula outside the sorted block still computes", sorted.total === "15", String(sorted.total));

		step("1.3.0: the sort and the freeze on disk, byte for byte");
		await page.waitForTimeout(5000);
		const dataSaved = fs.readFileSync(dataDisk, "utf8");
		console.log("  ---- Data.sheet on disk ----");
		console.log(dataSaved.split("\n").map((l) => "  | " + l).join("\n"));
		// The fixture on disk was a version 3 file; saving it rewrites the version
		// line, which is the 3 -> 4 rule and nothing else about it changes.
		check("saved as version 4 deterministic JSON",
			dataSaved.startsWith('{\n  "format": "leovale-sheet",\n  "version": 4,'), dataSaved.slice(0, 50));
		check("the view block holds the sort",
			dataSaved.includes('"sort": { "col": 0, "dir": "asc" }'), dataSaved);
		check("the freeze block holds the frozen row",
			dataSaved.includes('"freeze": { "rows": 1 }'), dataSaved);
		check("view and freeze sit between merges and cells",
			/"merges": \{\},\n\s+"view": \{[\s\S]*?\n\s+"freeze": \{ "rows": 1 \},\n\s+"cells":/.test(dataSaved),
			dataSaved);
		// The whole point of the document-level sort: on disk, the style is on the
		// line of the value it belongs to.
		check('A2 on disk is apple WITH the green fill',
			dataSaved.includes('"A2": { "v": "apple", "s": { "bg": "#e2f0d9" } }'), dataSaved);
		check('A3 on disk is banana WITH the yellow fill',
			dataSaved.includes('"A3": { "v": "banana", "s": { "bg": "#fff2cc" } }'), dataSaved);
		check('A4 on disk is cherry WITH the red fill',
			dataSaved.includes('"A4": { "v": "cherry", "s": { "bg": "#ffe0e0" } }'), dataSaved);
		check('B2 on disk is apple\'s own 10', dataSaved.includes('"B2": { "v": 10 }'), dataSaved);
		check("the header is untouched",
			dataSaved.includes('"A1": { "v": "Fruit", "s": { "b": true } }'), dataSaved);
		check("the formula is still stored as source",
			dataSaved.includes('"C6": { "f": "=SUM(B2:B4)" }'), dataSaved);

		step("1.3.0: filters hide rows and are persisted");
		await clickCell(0, 1);
		await page.click(".leovale-sheet-toolbar .leovale-sheet-tb-filter");
		await page.waitForTimeout(300);
		const filterMenu = await page.evaluate(() =>
			[...document.querySelectorAll(".menu .menu-item-title")].map((i) => i.textContent),
		);
		console.log("  filter menu:", filterMenu);
		check("the filter menu lists the column's values",
			["apple", "banana", "cherry"].every((v) => filterMenu.includes(v)), JSON.stringify(filterMenu));
		check("and offers show-all plus clear-all",
			filterMenu.includes("Show all") && filterMenu.includes("Clear all filters"),
			JSON.stringify(filterMenu));
		await page.click('.menu .menu-item:has(.menu-item-title:text-is("banana"))');
		await page.waitForTimeout(500);

		const filtered = await page.evaluate(() => {
			const rows = [...document.querySelectorAll(".leovale-sheet-content .leovale-sheet-root tbody tr")];
			return {
				view: window.sheetView().sheetEngine.getView(),
				hidden: rows.filter((r) => getComputedStyle(r).display === "none").map((r) => r.getAttribute("data-y")),
				marked: !!document.querySelector(
					'.leovale-sheet-content .leovale-sheet-root thead td[data-x="0"].leovale-sheet-filtered',
				),
			};
		});
		console.log("  filtered:", filtered);
		check("unchecking a value filters it out",
			JSON.stringify(filtered.view.filters) === '{"0":["apple","cherry"]}', JSON.stringify(filtered.view));
		// banana sorted to row index 2; the empty rows below the block stay visible
		// on purpose - a blank is never filtered out (see sheetops.hiddenRows).
		check("the banana row is hidden, and only it",
			JSON.stringify(filtered.hidden) === '["2"]', JSON.stringify(filtered.hidden));
		check("the filtered column is marked in its header", filtered.marked);
		const filterTitle = await page.getAttribute(
			".leovale-sheet-toolbar .leovale-sheet-tb-filter",
			"title",
		);
		check(
			"the filter button says how many rows are hidden",
			/1 rows hidden/.test(filterTitle ?? ""),
			String(filterTitle),
		);

		await page.waitForTimeout(5000);
		const dataFiltered = fs.readFileSync(dataDisk, "utf8");
		check("the filter is written into the view block, one value per line",
			/"filters": \{\n\s+"0": \[\n\s+"apple",\n\s+"cherry"\n\s+\]\n\s+\}/.test(dataFiltered),
			dataFiltered);
		check("filtering hides rows, it never deletes them",
			dataFiltered.includes('"A3": { "v": "banana", "s": { "bg": "#fff2cc" } }'), dataFiltered);

		step("1.3.0: freeze, sort and filters survive a reopen");
		await page.evaluate(async () => {
			window.app.workspace.detachLeavesOfType("leovale-sheet-view");
			await new Promise((r) => setTimeout(r, 500));
			const f = window.app.vault.getAbstractFileByPath("Data.sheet");
			await window.app.workspace.getLeaf(true).openFile(f);
		});
		await page.waitForFunction(() => !!window.wsHandle(), null, { timeout: 20_000 });
		await page.waitForTimeout(900);
		const reopenedData = await page.evaluate(() => {
			const root = document.querySelector(".leovale-sheet-content .leovale-sheet-root");
			const e = window.sheetView().sheetEngine;
			const rows = [...root.querySelectorAll("tbody tr")];
			return {
				freeze: e.getFreeze(),
				view: e.getView(),
				sticky: getComputedStyle(root.querySelector('tbody > tr[data-y="0"] > td[data-x="0"]')).position,
				hidden: rows.filter((r) => getComputedStyle(r).display === "none").map((r) => r.getAttribute("data-y")),
				a2: root.querySelector('td[data-x="0"][data-y="1"]')?.textContent,
				fillA2: e.getStyleAt("A2").bg,
				sortedHeader: !!root.querySelector('thead td[data-x="0"].leovale-sheet-sorted'),
			};
		});
		console.log("  reopened:", reopenedData);
		check("the frozen row came back", JSON.stringify(reopenedData.freeze) === '{"rows":1}',
			JSON.stringify(reopenedData.freeze));
		check("and is sticky again without a click", reopenedData.sticky === "sticky", reopenedData.sticky);
		check("the filter came back and still hides its row",
			JSON.stringify(reopenedData.hidden) === '["2"]', JSON.stringify(reopenedData.hidden));
		check("the sort marker came back", reopenedData.sortedHeader);
		check("the sorted values and their styles are still together",
			reopenedData.a2 === "apple" && reopenedData.fillA2 === "#e2f0d9",
			JSON.stringify([reopenedData.a2, reopenedData.fillA2]));
		check("opening the file did not change it", fs.readFileSync(dataDisk, "utf8") === dataFiltered);

		await shot(page, "15-data-light");

		step("1.3.0: the frozen row stays put while the grid scrolls under it");
		await page.evaluate(() => {
			document.querySelector(".leovale-sheet-content .leovale-sheet-wrapper").scrollTop = 260;
		});
		await page.waitForTimeout(500);
		const scrolled = await page.evaluate(() => {
			const root = document.querySelector(".leovale-sheet-content .leovale-sheet-root");
			const wrapper = document.querySelector(".leovale-sheet-content .leovale-sheet-wrapper");
			const box = (sel) => root.querySelector(sel)?.getBoundingClientRect();
			const head = box('thead > tr > td[data-x="0"]');
			const frozen = box('tbody > tr[data-y="0"] > td[data-x="0"]');
			const under = box('tbody > tr[data-y="1"] > td[data-x="0"]');
			const frozenCell = root.querySelector('tbody > tr[data-y="0"] > td[data-x="0"]');
			return {
				scrollTop: Math.round(wrapper.scrollTop),
				text: frozenCell.textContent,
				gap: Math.round(frozen.top - head.bottom),
				underTop: Math.round(under.top),
				frozenTop: Math.round(frozen.top),
				// A styled-but-unfilled header cell used to be `background-color:
				// transparent` inline, which no rule could override - the rows sliding
				// underneath showed straight through it.
				bg: getComputedStyle(frozenCell).backgroundColor,
				stickyTop: getComputedStyle(frozenCell).top,
				headTop: Math.round(head.top),
				headPosition: getComputedStyle(root.querySelector('thead > tr > td[data-x="0"]')).position,
				wrapperTop: Math.round(wrapper.getBoundingClientRect().top),
			};
		});
		console.log("  scrolled:", scrolled);
		check("the grid really scrolled", scrolled.scrollTop > 200, String(scrolled.scrollTop));
		check("the frozen row is still on screen", scrolled.text === "Fruit", String(scrolled.text));
		check(
			"parked right under the column letters",
			Math.abs(scrolled.gap) <= 2,
			String(scrolled.gap),
		);
		check(
			"the row below it slid underneath",
			scrolled.underTop < scrolled.frozenTop,
			JSON.stringify([scrolled.underTop, scrolled.frozenTop]),
		);
		check(
			"a frozen bold-but-unfilled cell is opaque, not see-through",
			scrolled.bg !== "rgba(0, 0, 0, 0)" && scrolled.bg !== "transparent",
			scrolled.bg,
		);
		// The filter marker is a background image rather than a positioned ::before
		// for exactly this reason: `position: relative` on the header cell would
		// beat the vendor's `position: sticky` and the letter would scroll away.
		check(
			"the FILTERED column's letter is still pinned too",
			scrolled.headPosition === "sticky" && Math.abs(scrolled.headTop - scrolled.wrapperTop) <= 2,
			JSON.stringify([scrolled.headPosition, scrolled.headTop, scrolled.wrapperTop]),
		);
		await shot(page, "18-freeze-scrolled-light");
		await page.evaluate(() => {
			document.querySelector(".leovale-sheet-content .leovale-sheet-wrapper").scrollTop = 0;
		});
		await page.waitForTimeout(300);

		step("1.3.0: clearing the filters puts every row back");
		await clickCell(0, 1);
		await page.click(".leovale-sheet-toolbar .leovale-sheet-tb-filter");
		await page.waitForTimeout(300);
		await page.click('.menu .menu-item:has(.menu-item-title:text-is("Clear all filters"))');
		await page.waitForTimeout(500);
		const unfiltered = await page.evaluate(() => {
			const rows = [...document.querySelectorAll(".leovale-sheet-content .leovale-sheet-root tbody tr")];
			return {
				view: window.sheetView().sheetEngine.getView(),
				hidden: rows.filter((r) => getComputedStyle(r).display === "none").length,
			};
		});
		check("no filters left", unfiltered.view.filters === undefined, JSON.stringify(unfiltered.view));
		check("no rows hidden", unfiltered.hidden === 0, String(unfiltered.hidden));

		step("1.3.0: in-sheet search (Ctrl+F on the grid)");
		await clickCell(0, 1);
		await page.keyboard.press("Control+f");
		await page.waitForTimeout(300);
		check("the find strip opened", await page.locator(".leovale-sheet-find.is-open").isVisible());
		await page.keyboard.type("an", { delay: 30 });
		await page.waitForTimeout(400);
		const found = await page.evaluate(() => ({
			count: document.querySelector(".leovale-sheet-find-count")?.textContent,
			hits: [...document.querySelectorAll(".leovale-sheet-content .leovale-sheet-root td.leovale-sheet-found")]
				.map((td) => td.textContent),
			current: document.querySelector(
				".leovale-sheet-content .leovale-sheet-root td.leovale-sheet-found-current",
			)?.textContent,
		}));
		console.log("  found:", found);
		check("banana was found", found.hits.includes("banana"), JSON.stringify(found.hits));
		check("the counter shows the position", /1 of \d+/.test(found.count ?? ""), String(found.count));
		check("the first hit is the current one", found.current === found.hits[0], String(found.current));
		await shot(page, "16-find-light");
		await page.keyboard.press("Escape");
		await page.waitForTimeout(300);
		const findClosed = await page.evaluate(() => ({
			open: !!document.querySelector(".leovale-sheet-find.is-open"),
			hits: document.querySelectorAll(".leovale-sheet-content .leovale-sheet-root td.leovale-sheet-found").length,
		}));
		check("Escape closes the strip", !findClosed.open);
		check("and drops every highlight", findClosed.hits === 0, String(findClosed.hits));

		step("1.3.0: the keyboard fixes");
		await clickCell(0, 1);
		await page.keyboard.press("Control+End");
		await page.waitForTimeout(250);
		check("Ctrl+End goes to the corner of the used range",
			JSON.stringify(await selectedCell(page)) === "[2,5]", JSON.stringify(await selectedCell(page)));
		await page.keyboard.press("Control+Home");
		await page.waitForTimeout(250);
		check("Ctrl+Home goes to A1", JSON.stringify(await selectedCell(page)) === "[0,0]",
			JSON.stringify(await selectedCell(page)));
		await clickCell(0, 1);
		await page.keyboard.press("End");
		await page.waitForTimeout(250);
		check("End goes to the last filled cell of the row, not to column Z",
			JSON.stringify(await selectedCell(page)) === "[1,1]", JSON.stringify(await selectedCell(page)));
		await page.keyboard.press("Home");
		await page.waitForTimeout(250);
		check("Home goes back to the start of the row",
			JSON.stringify(await selectedCell(page)) === "[0,1]", JSON.stringify(await selectedCell(page)));
		await clickCell(0, 0);
		await page.keyboard.press("Control+ArrowDown");
		await page.waitForTimeout(250);
		check("Ctrl+ArrowDown runs to the end of the data block",
			JSON.stringify(await selectedCell(page)) === "[0,3]", JSON.stringify(await selectedCell(page)));

		// F2 opens the editor on the active cell
		await clickCell(1, 1);
		await page.keyboard.press("F2");
		await page.waitForTimeout(300);
		const editing = await page.evaluate(() => ({
			editor: !!document.querySelector(".leovale-sheet-content .leovale-sheet-root td.editor"),
			value: document.querySelector(".leovale-sheet-content .leovale-sheet-root td.editor input")?.value,
		}));
		console.log("  F2:", editing);
		check("F2 opened the in-cell editor", editing.editor, JSON.stringify(editing));
		check("with the cell's own value in it", editing.value === "10", String(editing.value));
		await page.keyboard.press("Escape");
		await page.waitForTimeout(200);

		// Ctrl+D fills the row above down into the selection
		await clickCell(0, 4); // A5, empty, under the fruit block
		await page.keyboard.press("Control+d");
		await page.waitForTimeout(400);
		const filledDown = await page.evaluate(() => ({
			a5: document.querySelector('.leovale-sheet-content .leovale-sheet-root td[data-x="0"][data-y="4"]')?.textContent,
			style: window.sheetView().sheetEngine.getStyleAt("A5"),
		}));
		console.log("  Ctrl+D:", filledDown);
		check("Ctrl+D copied the cell above", filledDown.a5 === "cherry", String(filledDown.a5));
		check("with its formatting", filledDown.style.bg === "#ffe0e0", JSON.stringify(filledDown.style));

		// Delete clears the selection without asking anything
		await page.keyboard.press("Delete");
		await page.waitForTimeout(400);
		check("Delete cleared it again",
			(await dataCell(0, 4)) === "", JSON.stringify(await dataCell(0, 4)));
		check("no dialog was left open", (await page.locator(".modal").count()) === 0);

		step("1.3.0: Markdown table round-trip through the clipboard");
		// select A1:B2 with a drag, then copy through the command palette command
		const mdA1 = await page.locator('.leovale-sheet-content .leovale-sheet-root td[data-x="0"][data-y="0"]').boundingBox();
		const mdB2 = await page.locator('.leovale-sheet-content .leovale-sheet-root td[data-x="1"][data-y="1"]').boundingBox();
		await page.mouse.move(mdA1.x + mdA1.width / 2, mdA1.y + mdA1.height / 2);
		await page.mouse.down();
		await page.mouse.move(mdB2.x + mdB2.width / 2, mdB2.y + mdB2.height / 2, { steps: 8 });
		await page.mouse.up();
		await page.waitForTimeout(250);
		const copied = await page.evaluate(async (id) => {
			window.app.commands.executeCommandById(`${id}:copy-markdown-table`);
			await new Promise((r) => setTimeout(r, 600));
			try {
				return require("electron").clipboard.readText();
			} catch {
				return await navigator.clipboard.readText();
			}
		}, PLUGIN_ID);
		console.log("  copied markdown:\n" + copied.split("\n").map((l) => "  | " + l).join("\n"));
		check("the copy is a Markdown table with a separator row",
			copied.split("\n").length === 3 && /^\|\s*---/.test(copied.split("\n")[1]), JSON.stringify(copied));
		check("it holds the values, not the addresses",
			copied.includes("| Fruit | Qty |") && copied.includes("| apple | 10 |"), JSON.stringify(copied));

		// paste a table of our own into an empty corner of the grid
		const PASTED = ["| a | b |", "| ---: | :---: |", "| 1 | x\\|y |"].join("\n");
		await clickCell(0, 4); // A5
		await page.evaluate(async (text) => {
			try {
				require("electron").clipboard.writeText(text);
			} catch {
				await navigator.clipboard.writeText(text);
			}
		}, PASTED);
		await page.evaluate((id) => window.app.commands.executeCommandById(`${id}:paste-markdown-table`), PLUGIN_ID);
		await page.waitForTimeout(900);
		const pasted = await page.evaluate(() => {
			const e = window.sheetView().sheetEngine;
			const q = (x, y) =>
				document.querySelector(
					`.leovale-sheet-content .leovale-sheet-root td[data-x="${x}"][data-y="${y}"]`,
				)?.textContent;
			return { a5: q(0, 4), b5: q(1, 4), a6: q(0, 5), b6: q(1, 5), haA5: e.getStyleAt("A5").ha, haB5: e.getStyleAt("B5").ha };
		});
		console.log("  pasted:", pasted);
		check("the header row of the pasted table landed on the anchor",
			pasted.a5 === "a" && pasted.b5 === "b", JSON.stringify(pasted));
		check("the body row landed under it", pasted.a6 === "1", JSON.stringify(pasted));
		check("an escaped pipe came back as a pipe", pasted.b6 === "x|y", JSON.stringify(pasted.b6));
		check("the alignment row was applied to the columns",
			pasted.haA5 === "r" && pasted.haB5 === "c", JSON.stringify([pasted.haA5, pasted.haB5]));

		step("1.3.0: column width dialog and double-click autofit");
		await clickCell(0, 1);
		await page.evaluate((id) => window.app.commands.executeCommandById(`${id}:column-width`), PLUGIN_ID);
		await page.waitForTimeout(500);
		check("the width dialog opened", (await page.locator(".modal.mod-dim, .modal").count()) >= 1);
		check("it names the column it will resize",
			(await page.locator(".leovale-sheet-width-columns").innerText()).includes("A"),
			await page.locator(".leovale-sheet-width-columns").innerText());
		const widthInput = page.locator(".modal input[type='number']");
		await widthInput.fill("220");
		await page.click('.modal button:text-is("Apply")');
		await page.waitForTimeout(600);
		const widthApplied = await page.evaluate(() => ({
			modal: document.querySelectorAll(".modal").length,
			width: Math.round(
				document
					.querySelector('.leovale-sheet-content .leovale-sheet-root thead td[data-x="0"]')
					.getBoundingClientRect().width,
			),
		}));
		console.log("  width:", widthApplied);
		check("the dialog closed", widthApplied.modal === 0, String(widthApplied.modal));
		check("the column is exactly as wide as asked", widthApplied.width === 220, String(widthApplied.width));

		// double click on the right edge of the A header: fit to content
		const header = await page.locator('.leovale-sheet-content .leovale-sheet-root thead td[data-x="0"]').boundingBox();
		await page.mouse.dblclick(header.x + header.width - 3, header.y + header.height / 2);
		await page.waitForTimeout(600);
		const autofit = await page.evaluate(() =>
			Math.round(
				document
					.querySelector('.leovale-sheet-content .leovale-sheet-root thead td[data-x="0"]')
					.getBoundingClientRect().width,
			),
		);
		console.log("  autofit width:", autofit);
		check("double-clicking the header edge shrinks the column to its content",
			autofit < 220 && autofit > 30, String(autofit));

		await page.waitForTimeout(5000);
		const dataFinal = fs.readFileSync(dataDisk, "utf8");
		check("the autofitted width was persisted",
			new RegExp(`"colWidths": \\{\\n\\s+"0": ${autofit}`).test(dataFinal),
			dataFinal.split("\n").slice(0, 14).join("\n"));

		step("1.3.0: the data sheet in the dark theme");
		await setBaseTheme(page, "obsidian");
		await page.waitForTimeout(700);
		await shot(page, "17-data-dark");
		await setBaseTheme(page, "moonstone");
		await page.waitForTimeout(500);

		/* ================================================================== *
		 *  1.4.0: exchange and print                                         *
		 * ================================================================== */

		step("1.4.0: a sheet with wiki links and a checkbox column");
		const X_PATH = "Exchange14.sheet";
		const X_DISK = path.join(VAULT, X_PATH);
		const X_XLSX = path.join(VAULT, "Exchange14.xlsx");
		const LINK_NOTE = "Linked note.md";
		const X_SOURCE = [
			"{",
			'  "format": "leovale-sheet",',
			'  "version": 4,',
			'  "sheets": [',
			"    {",
			'      "name": "Sheet1",',
			'      "rows": 40,',
			'      "cols": 6,',
			'      "colWidths": {',
			'        "0": 160,',
			'        "2": 180',
			"      },",
			'      "rowHeights": {},',
			'      "merges": {},',
			'      "view": {},',
			'      "freeze": {},',
			'      "cells": {',
			'        "A1": { "v": "Task", "s": { "b": true, "bg": "#fff2cc", "bd": "trbl" } },',
			'        "B1": { "v": "Done", "s": { "b": true, "bg": "#fff2cc" } },',
			'        "C1": { "v": "Note", "s": { "b": true, "bg": "#fff2cc" } },',
			'        "D1": { "v": "Qty", "s": { "b": true, "bg": "#fff2cc", "ha": "r" } },',
			'        "A2": { "v": "Write docs" },',
			'        "B2": { "v": false, "t": "cb" },',
			'        "C2": { "v": "[[Linked note]]" },',
			'        "D2": { "v": 3, "s": { "nf": "#,##0.00", "ha": "r" } },',
			'        "A3": { "v": "Ship it" },',
			'        "B3": { "v": true, "t": "cb" },',
			'        "C3": { "v": "see [[Linked note|the note]]" },',
			'        "D3": { "v": 4, "s": { "ha": "r" } },',
			'        "A4": { "v": "Total", "s": { "b": true } },',
			'        "D4": { "f": "=SUM(D2:D3)", "s": { "b": true, "ha": "r" } },',
			'        "A6": { "v": "merge me" },',
			'        "B6": { "v": "lost" },',
			'        "A7": { "v": "second row" }',
			"      }",
			"    }",
			"  ]",
			"}",
			"",
		].join("\n");

		const openX = async () => {
			await page.evaluate(
				async ([p, text, note]) => {
					const app = window.app;
					app.workspace.detachLeavesOfType("leovale-sheet-view");
					if (!app.vault.getAbstractFileByPath(note)) {
						await app.vault.create(note, "# Linked note\n\nA note a cell points at.\n");
					}
					const old = app.vault.getAbstractFileByPath(p);
					if (old) await app.vault.delete(old);
					const f = await app.vault.create(p, text);
					await app.workspace.getLeaf(true).openFile(f);
				},
				[X_PATH, X_SOURCE, LINK_NOTE],
			);
			await page.waitForFunction(
				(p) => window.sheetView()?.file?.path === p && !!window.wsHandle(),
				X_PATH,
				{ timeout: 20_000 },
			);
			await page.waitForTimeout(600);
		};
		await openX();

		const xCell = (x, y) =>
			`.leovale-sheet-content .leovale-sheet-root td[data-x="${x}"][data-y="${y}"]`;
		const clickX = async (x, y) => {
			await page.click(xCell(x, y));
			await page.waitForTimeout(140);
		};

		const decor = await page.evaluate((sel) => {
			const q = (s) => document.querySelector(s);
			const boxes = [...document.querySelectorAll(".leovale-sheet-content input.leovale-sheet-cb")];
			const links = [
				...document.querySelectorAll(".leovale-sheet-content a.leovale-sheet-link"),
			];
			return {
				boxes: boxes.length,
				checked: boxes.map((b) => b.checked),
				linkTexts: links.map((a) => a.textContent),
				linkTargets: links.map((a) => a.getAttribute("data-href")),
				linkIsInternal: links.every((a) => a.classList.contains("internal-link")),
				// the raw brackets must NOT be on screen any more
				c2Text: q(sel)?.textContent,
				a2Text: q(sel.replace('data-x="2"', 'data-x="0"'))?.textContent,
			};
		}, xCell(2, 1));
		console.log("  decor:", decor);
		check("both checkbox cells rendered a real <input>", decor.boxes === 2, String(decor.boxes));
		check("their state came from the file", JSON.stringify(decor.checked) === "[false,true]",
			JSON.stringify(decor.checked));
		check("both wiki links rendered an <a>", decor.linkTexts.length === 2,
			JSON.stringify(decor.linkTexts));
		check("a bare link shows the note name", decor.linkTexts[0] === "Linked note",
			String(decor.linkTexts[0]));
		check("an alias shows the alias", decor.linkTexts[1] === "the note", String(decor.linkTexts[1]));
		check("the link target is the note, not the alias",
			decor.linkTargets.every((t) => t === "Linked note"), JSON.stringify(decor.linkTargets));
		check("the anchor is an Obsidian internal link", decor.linkIsInternal === true);
		check("the brackets are gone from the cell's own text", decor.c2Text === "Linked note",
			String(decor.c2Text));

		step("1.4.0: a click on a checkbox writes a boolean and autosaves");
		await page.click(`${xCell(1, 1)} input.leovale-sheet-cb`);
		await page.waitForTimeout(300);
		const afterToggle = await page.evaluate(() =>
			[...document.querySelectorAll(".leovale-sheet-content input.leovale-sheet-cb")].map(
				(b) => b.checked,
			),
		);
		check("the box the user clicked is now ticked",
			JSON.stringify(afterToggle) === "[true,true]", JSON.stringify(afterToggle));
		await page.waitForTimeout(5000);
		const xAfterToggle = fs.readFileSync(X_DISK, "utf8");
		check('the file says "v": true, "t": "cb"',
			xAfterToggle.includes('"B2": { "v": true, "t": "cb" }'),
			xAfterToggle.split("\n").filter((l) => l.includes("B2")).join(" | "));
		check("the other checkbox is untouched",
			xAfterToggle.includes('"B3": { "v": true, "t": "cb" }'),
			xAfterToggle.split("\n").filter((l) => l.includes("B3")).join(" | "));
		check("the file is a version 4 document", xAfterToggle.includes('"version": 4,'),
			xAfterToggle.slice(0, 60));
		// untick it again so the screenshots show one of each
		await page.click(`${xCell(1, 1)} input.leovale-sheet-cb`);
		await page.waitForTimeout(300);

		step("1.4.0: hovering a link asks Obsidian for a preview");
		await page.evaluate(() => {
			window.__hoverLinks = [];
			window.app.workspace.on("hover-link", (e) => {
				window.__hoverLinks.push({
					linktext: e?.linktext,
					source: e?.source,
					sourcePath: e?.sourcePath,
					hasParent: !!e?.hoverParent,
					hasTarget: !!e?.targetEl,
				});
			});
		});
		await page.hover(".leovale-sheet-content a.leovale-sheet-link");
		await page.waitForTimeout(400);
		const hovers = await page.evaluate(() => window.__hoverLinks);
		console.log("  hover-link:", hovers);
		check("a hover-link event was fired", hovers.length >= 1, JSON.stringify(hovers));
		check("it names the note", hovers[0]?.linktext === "Linked note", JSON.stringify(hovers[0]));
		check("it comes from the spreadsheet and knows its path",
			hovers[0]?.sourcePath === X_PATH && !!hovers[0]?.source, JSON.stringify(hovers[0]));
		check("it carries a hover parent and a target element",
			hovers[0]?.hasParent === true && hovers[0]?.hasTarget === true, JSON.stringify(hovers[0]));

		step("1.4.0: light and dark screenshots of links and checkboxes");
		await clickX(0, 1);
		await page.waitForTimeout(200);
		await shot(page, "19-links-checkboxes-light");
		await setBaseTheme(page, "obsidian");
		await page.waitForTimeout(700);
		await shot(page, "20-links-checkboxes-dark");
		await setBaseTheme(page, "moonstone");
		await page.waitForTimeout(500);

		step("1.4.0: clicking a link opens the note");
		await page.click(".leovale-sheet-content a.leovale-sheet-link");
		await page.waitForTimeout(900);
		const opened = await page.evaluate(() => window.app.workspace.getActiveFile()?.path);
		check("the linked note is now the active file", opened === LINK_NOTE, String(opened));
		await openX();

		step("1.4.0: merge cells from the toolbar, with the confirm");
		// A6:B6 -> B6 holds "lost", so the confirm has to appear
		const a6 = await page.locator(xCell(0, 5)).boundingBox();
		const b6 = await page.locator(xCell(1, 5)).boundingBox();
		await page.mouse.move(a6.x + a6.width / 2, a6.y + a6.height / 2);
		await page.mouse.down();
		await page.mouse.move(b6.x + b6.width / 2, b6.y + b6.height / 2, { steps: 6 });
		await page.mouse.up();
		await page.waitForTimeout(250);
		await page.click(".leovale-sheet-toolbar .leovale-sheet-tb-merge");
		await page.waitForTimeout(500);
		const confirm = await page.evaluate(() => ({
			modals: document.querySelectorAll(".modal").length,
			title: document.querySelector(".modal .modal-title")?.textContent,
			body: document.querySelector(".leovale-sheet-confirm-body")?.textContent,
			buttons: [...document.querySelectorAll(".modal button")].map((b) => b.textContent),
		}));
		console.log("  confirm:", confirm);
		check("merging over data asks first", confirm.modals === 1, JSON.stringify(confirm));
		check("the question says how many cells are emptied",
			/\b1\b/.test(confirm.body ?? ""), String(confirm.body));
		check("it offers cancel and merge", confirm.buttons.length === 2, JSON.stringify(confirm.buttons));
		await page.click(`.modal button:text-is("${confirm.buttons[1]}")`);
		await page.waitForTimeout(600);

		// The engine keeps the swallowed <td> in the DOM and hides it, so "gone"
		// has to be asked as "does it take up any space", not "is it in the tree".
		const cellShown = (x, y) =>
			page.evaluate(([cx, cy]) => {
				const el = document.querySelector(
					`.leovale-sheet-content .leovale-sheet-root td[data-x="${cx}"][data-y="${cy}"]`,
				);
				return !!el && el.getClientRects().length > 0;
			}, [x, y]);
		const merged = await page.evaluate((sel) => {
			const cell = document.querySelector(sel);
			return {
				colspan: cell?.getAttribute("colspan"),
				rowspan: cell?.getAttribute("rowspan"),
				text: cell?.textContent,
				modals: document.querySelectorAll(".modal").length,
			};
		}, xCell(0, 5));
		merged.neighbourShown = await cellShown(1, 5);
		console.log("  merged:", merged);
		check("the anchor cell now spans two columns", merged.colspan === "2", String(merged.colspan));
		check("only the top-left value survived", merged.text === "merge me", String(merged.text));
		check("the swallowed cell no longer takes up a place in the grid",
			merged.neighbourShown === false, String(merged.neighbourShown));
		check("the dialog closed", merged.modals === 0, String(merged.modals));

		await page.waitForTimeout(5000);
		const xMerged = fs.readFileSync(X_DISK, "utf8");
		check("the merge is in the file, in the merges block",
			/"merges": \{\n\s+"A6": \[2, 1\]\n\s+\}/.test(xMerged),
			xMerged.split("\n").slice(8, 16).join(" | "));
		check("the emptied cell is no longer in the file", !xMerged.includes('"B6"'),
			xMerged.split("\n").filter((l) => l.includes("B6")).join(" | "));

		step("1.4.0: a merged sheet refuses to sort, as it always has");
		await page.click(".leovale-sheet-toolbar .leovale-sheet-tb-sort");
		await page.waitForTimeout(300);
		await page.click('.menu .menu-item:has-text("A")');
		await page.waitForTimeout(500);
		const sortNotice = await page.evaluate(() =>
			[...document.querySelectorAll(".notice")].map((n) => n.textContent).join(" | "),
		);
		console.log("  notice:", sortNotice);
		check("it says merged cells cannot be sorted", /merge/i.test(sortNotice), sortNotice);

		step("1.4.0: the same button splits the merge again");
		await clickX(0, 5);
		await page.click(".leovale-sheet-toolbar .leovale-sheet-tb-merge");
		await page.waitForTimeout(600);
		const split = await page.evaluate((sel) => ({
			colspan: document.querySelector(sel)?.getAttribute("colspan"),
			modals: document.querySelectorAll(".modal").length,
		}), xCell(0, 5));
		split.neighbourShown = await cellShown(1, 5);
		console.log("  split:", split);
		check("the span is gone", !split.colspan || split.colspan === "1", String(split.colspan));
		check("the cell next to it is on screen again", split.neighbourShown === true);
		check("splitting asks nothing: nothing can be lost", split.modals === 0);
		await page.waitForTimeout(5000);
		check("the file has no merges any more",
			/"merges": \{\},/.test(fs.readFileSync(X_DISK, "utf8")),
			fs.readFileSync(X_DISK, "utf8").split("\n").slice(8, 14).join(" | "));

		step("1.4.0: the checkbox button turns cells into checkboxes and back");
		await clickX(1, 3); // B4, an empty cell
		await page.click(".leovale-sheet-toolbar .leovale-sheet-tb-checkbox");
		await page.waitForTimeout(400);
		const madeBox = await page.evaluate(
			(sel) => ({
				box: !!document.querySelector(`${sel} input.leovale-sheet-cb`),
				active: !!document
					.querySelector(".leovale-sheet-toolbar .leovale-sheet-tb-checkbox")
					?.classList.contains("is-active"),
			}),
			xCell(1, 3),
		);
		check("the cell became a checkbox", madeBox.box === true, JSON.stringify(madeBox));
		check("the toolbar button lights up for it", madeBox.active === true, JSON.stringify(madeBox));
		await page.waitForTimeout(5000);
		check('an untouched checkbox is still written to the file',
			/"B4": \{ "v": false, "t": "cb" \}/.test(fs.readFileSync(X_DISK, "utf8")),
			fs.readFileSync(X_DISK, "utf8").split("\n").filter((l) => l.includes("B4")).join(" | "));

		await page.click(".leovale-sheet-toolbar .leovale-sheet-tb-checkbox");
		await page.waitForTimeout(400);
		const unmadeBox = await page.evaluate(
			(sel) => !!document.querySelector(`${sel} input.leovale-sheet-cb`),
			xCell(1, 3),
		);
		check("pressing it again gives a plain cell back", unmadeBox === false);
		await page.waitForTimeout(5000);
		check("and the file drops the type with it",
			!fs.readFileSync(X_DISK, "utf8").includes('"B4"'),
			fs.readFileSync(X_DISK, "utf8").split("\n").filter((l) => l.includes("B4")).join(" | "));

		step("1.4.0: every 1.4.0 toolbar button really drew its icon");
		const tbIcons = await page.evaluate(() =>
			[...document.querySelectorAll(".leovale-sheet-toolbar .leovale-sheet-tb-btn")].map((b) => ({
				cls: [...b.classList].find((c) => c.startsWith("leovale-sheet-tb-") && c !== "leovale-sheet-tb-btn"),
				svg: !!b.querySelector("svg"),
				label: b.getAttribute("aria-label"),
			})),
		);
		console.log("  toolbar icons:", tbIcons.map((i) => `${i.cls}:${i.svg ? "svg" : "MISSING"}`).join(" "));
		check("no toolbar button is an empty box", tbIcons.every((i) => i.svg), JSON.stringify(tbIcons));
		check("the merge and checkbox buttons are there",
			icons.some((i) => i.cls === "leovale-sheet-tb-merge") &&
				icons.some((i) => i.cls === "leovale-sheet-tb-checkbox"),
			JSON.stringify(tbIcons.map((i) => i.cls)));

		step("1.4.0: export to .xlsx");
		const cmds14 = await page.evaluate(
			(id) => Object.keys(window.app.commands.commands).filter((c) => c.startsWith(id)),
			PLUGIN_ID,
		);
		console.log("  commands:", cmds14.join(", "));
		check(
			"the palette has every 1.4.0 command",
			["export-xlsx", "import-xlsx", "print-sheet", "merge-cells"].every((c) =>
				cmds14.includes(`${PLUGIN_ID}:${c}`),
			),
			cmds14.join(", "),
		);
		if (fs.existsSync(X_XLSX)) fs.rmSync(X_XLSX);
		await page.evaluate(
			(id) => window.app.commands.executeCommandById(`${id}:export-xlsx`),
			PLUGIN_ID,
		);
		await page.waitForTimeout(2500);
		const exportNotice = await page.evaluate(() =>
			[...document.querySelectorAll(".notice")].map((n) => n.textContent).join(" | "),
		);
		console.log("  export notice:", exportNotice);
		check("a notice names the file that was written", /Exchange14\.xlsx/.test(exportNotice),
			exportNotice);
		check("the .xlsx landed next to the sheet", fs.existsSync(X_XLSX));
		const xlsxBytes = fs.existsSync(X_XLSX) ? fs.readFileSync(X_XLSX) : Buffer.alloc(0);
		check("it is a real zip container", xlsxBytes.slice(0, 2).toString() === "PK",
			xlsxBytes.slice(0, 4).toString("hex"));
		check("and not a stub", xlsxBytes.length > 2000, String(xlsxBytes.length));

		step("1.4.0: the file menu of a .sheet and of an .xlsx");
		// The context menu of the file explorer is driven through the workspace
		// event the plugin actually listens to, with a stand-in Menu that records
		// what was added. Right-clicking the sidebar would test Obsidian's tree
		// widget; this tests OUR handler, and it can then fire the item.
		const fileMenuItems = (target) =>
			page.evaluate((path) => {
				const app = window.app;
				const file = app.vault.getAbstractFileByPath(path);
				const items = [];
				// Every listener on "file-menu" gets this object, not just ours -
				// Obsidian's core and any other plugin as well - so it has to answer
				// the whole Menu/MenuItem surface they use, or the console fills up
				// with "setSection is not a function" from THEIR handlers.
				const menu = {
					addItem(build) {
						const item = {
							setTitle(t) {
								item.title = t;
								return item;
							},
							setIcon(i) {
								item.icon = i;
								return item;
							},
							setChecked: () => item,
							setDisabled: () => item,
							setSection: () => item,
							setIsLabel: () => item,
							setWarning: () => item,
							onClick(fn) {
								item.click = fn;
								return item;
							},
						};
						build(item);
						items.push(item);
						// Menu.addItem is chainable and callers rely on it:
						// `menu.addItem(a).addItem(b)` threw "cannot read addItem of
						// undefined" out of somebody else's handler until this returned.
						return menu;
					},
					addSeparator: () => menu,
					addSections: () => menu,
					setSection: () => menu,
					setSectionSubmenu: () => menu,
					setNoIcon: () => menu,
					setUseNativeMenu: () => menu,
					showAtMouseEvent: () => menu,
					showAtPosition: () => menu,
					hide: () => menu,
					close: () => menu,
				};
				app.workspace.trigger("file-menu", menu, file, "file-explorer");
				window.__menuItems = items;
				return items.map((i) => ({
					title: i.title,
					icon: i.icon,
					clickable: typeof i.click === "function",
				}));
			}, target);
		const sheetMenu = await fileMenuItems(X_PATH);
		console.log("  .sheet file menu:", JSON.stringify(sheetMenu));
		check("a .sheet offers the export", sheetMenu.some((i) => i.title === "Export as .xlsx"),
			JSON.stringify(sheetMenu));
		check("the export item has an icon and an action",
			sheetMenu.every((i) => i.icon && i.clickable), JSON.stringify(sheetMenu));

		const xlsxMenu = await fileMenuItems("Exchange14.xlsx");
		console.log("  .xlsx file menu:", JSON.stringify(xlsxMenu));
		check("an .xlsx offers the import",
			xlsxMenu.some((i) => i.title === "Import as spreadsheet"), JSON.stringify(xlsxMenu));

		step("1.4.0: import that .xlsx back, from the file menu item itself");
		// Close the source sheet first: two tabs of the same grid means every
		// `document.querySelector` below could answer from the hidden one, and a
		// hidden tab measures zero. (Which is exactly how this went wrong once.)
		await page.evaluate(() => window.app.workspace.detachLeavesOfType("leovale-sheet-view"));
		await page.waitForTimeout(400);
		await page.evaluate(() => {
			const item = window.__menuItems.find((i) => i.title === "Import as spreadsheet");
			item.click();
		});
		await page.waitForTimeout(2000);
		const importNotice = await page.evaluate(() =>
			[...document.querySelectorAll(".notice")].map((n) => n.textContent).join(" | "),
		);
		await page.waitForTimeout(1500);

		const imported = await page.evaluate(() => ({
			path: window.app.workspace.getActiveFile()?.path,
			viewType: window.app.workspace.activeLeaf?.view?.getViewType?.(),
			sheetTabs: window.app.workspace.getLeavesOfType("leovale-sheet-view").length,
		}));
		imported.notices = importNotice;
		console.log("  imported:", imported);
		check("the import opened a new spreadsheet, without overwriting the old one",
			imported.path === "Exchange14 1.sheet", String(imported.path));
		check("it opened in our grid", imported.viewType === "leovale-sheet-view",
			String(imported.viewType));
		check("the notice names the file it wrote", /Exchange14 1\.sheet/.test(imported.notices),
			imported.notices);
		check("the notice counts the worksheets and the cells that arrived",
			/\b1\b/.test(imported.notices) && /\b1[0-9]\b/.test(imported.notices), imported.notices);
		check("exactly one spreadsheet tab is open", imported.sheetTabs === 1,
			String(imported.sheetTabs));

		const importedCells = await page.evaluate(() => {
			const at = (x, y) =>
				document.querySelector(
					`.leovale-sheet-content .leovale-sheet-root td[data-x="${x}"][data-y="${y}"]`,
				);
			const style = (x, y) => {
				const el = at(x, y);
				if (!el) return null;
				const cs = getComputedStyle(el);
				return { weight: cs.fontWeight, bg: cs.backgroundColor, align: cs.textAlign };
			};
			return {
				a1: at(0, 0)?.textContent,
				a2: at(0, 1)?.textContent,
				c2: at(2, 1)?.textContent,
				d2: at(3, 1)?.textContent,
				d4: at(3, 3)?.textContent,
				b2: at(1, 1)?.textContent,
				a1Style: style(0, 0),
				width: Math.round(
					document
						.querySelector('.leovale-sheet-content .leovale-sheet-root thead td[data-x="0"]')
						.getBoundingClientRect().width,
				),
			};
		});
		console.log("  imported cells:", importedCells);
		check("the values arrived", importedCells.a1 === "Task" && importedCells.a2 === "Write docs",
			JSON.stringify(importedCells));
		check("the number mask came with them", importedCells.d2 === "3.00", String(importedCells.d2));
		check("the formula recomputed after the trip", importedCells.d4 === "7", String(importedCells.d4));
		check("bold survived", Number(importedCells.a1Style?.weight) >= 600,
			String(importedCells.a1Style?.weight));
		check("the fill survived", importedCells.a1Style?.bg === "rgb(255, 242, 204)",
			String(importedCells.a1Style?.bg));
		check("the column width survived", Math.abs(importedCells.width - 160) <= 2,
			String(importedCells.width));
		check("a wiki link is still the text it was", importedCells.c2 === "[[Linked note]]" ||
			importedCells.c2 === "Linked note", String(importedCells.c2));
		check("a checkbox arrives as its boolean", /true|false/i.test(importedCells.b2 ?? ""),
			String(importedCells.b2));

		const importedDisk = fs.readFileSync(path.join(VAULT, "Exchange14 1.sheet"), "utf8");
		check("the imported file is our own deterministic JSON",
			importedDisk.startsWith('{\n  "format": "leovale-sheet",\n  "version": 4,'),
			importedDisk.slice(0, 60));
		check("with the styles mapped back into it",
			importedDisk.includes('"b": true') && importedDisk.includes('"bg": "#fff2cc"') &&
				importedDisk.includes('"bd": "trbl"'),
			importedDisk.split("\n").filter((l) => l.includes("A1")).join(" | "));
		check("and the formula, not its result",
			importedDisk.includes('"f": "=SUM(D2:D3)"'),
			importedDisk.split("\n").filter((l) => l.includes("D4")).join(" | "));

		step("1.4.0: print stylesheet and a real PDF (CDP Page.printToPDF)");
		await page.evaluate(async (p) => {
			const app = window.app;
			app.workspace.leftSplit?.collapse?.();
			const f = app.vault.getAbstractFileByPath(p);
			app.workspace.detachLeavesOfType("leovale-sheet-view");
			await app.workspace.getLeaf(true).openFile(f);
		}, X_PATH);
		await page.waitForFunction((p) => window.sheetView()?.file?.path === p, X_PATH, {
			timeout: 20_000,
		});
		await page.waitForTimeout(800);

		const printCdp = await page.context().newCDPSession(page);
		await printCdp.send("Emulation.setEmulatedMedia", { media: "print" });
		await page.waitForTimeout(400);
		const printLayout = await page.evaluate(() => {
			const shown = (sel) => {
				const el = document.querySelector(sel);
				if (!el) return "absent";
				return getComputedStyle(el).display;
			};
			const wrapper = document.querySelector(".leovale-sheet-wrapper");
			const table = document.querySelector(".leovale-sheet-content .jss_worksheet");
			const firstCell = document.querySelector(
				'.leovale-sheet-content .leovale-sheet-root td[data-x="0"][data-y="0"]',
			);
			return {
				toolbar: shown(".leovale-sheet-toolbar"),
				formulabar: shown(".leovale-sheet-formulabar"),
				ribbon: shown(".workspace-ribbon"),
				statusbar: shown(".status-bar"),
				viewHeader: shown(".view-header"),
				tabHeaders: shown(".workspace-tab-header-container"),
				wrapperOverflow: wrapper ? getComputedStyle(wrapper).overflow : "absent",
				thead: getComputedStyle(document.querySelector(".leovale-sheet-content thead")).display,
				cellPosition: firstCell ? getComputedStyle(firstCell).position : "absent",
				tableHeight: table ? Math.round(table.getBoundingClientRect().height) : 0,
				wrapperHeight: wrapper ? Math.round(wrapper.getBoundingClientRect().height) : 0,
			};
		});
		console.log("  print layout:", printLayout);
		check("the toolbar is hidden on paper", printLayout.toolbar === "none", printLayout.toolbar);
		check("so is the formula bar", printLayout.formulabar === "none", printLayout.formulabar);
		check("Obsidian's ribbon is hidden", printLayout.ribbon === "none", printLayout.ribbon);
		check("so is the status bar", printLayout.statusbar === "none", printLayout.statusbar);
		check("and the tab header", printLayout.tabHeaders === "none", printLayout.tabHeaders);
		check("the header row repeats on every page",
			printLayout.thead === "table-header-group", printLayout.thead);
		check("frozen/sticky cells are static on paper",
			printLayout.cellPosition === "static", printLayout.cellPosition);
		check("the grid is not a scroll box any more",
			printLayout.wrapperOverflow === "visible", printLayout.wrapperOverflow);
		check("the whole grid is laid out, not just the visible part",
			printLayout.wrapperHeight >= printLayout.tableHeight - 2,
			`wrapper ${printLayout.wrapperHeight} vs table ${printLayout.tableHeight}`);

		await shot(page, "21-print-light");

		// The PDF itself: CDP first, because that is the documented way to ask a
		// Chromium for one. Electron does not register `Page.printToPDF` at all
		// (headful Chromium keeps it in the browser process, and Electron's
		// embedder never wires it up) - measured here as
		// "'Page.printToPDF' wasn't found". Its own `webContents.printToPDF` is the
		// same printing pipeline behind Ctrl+P, reached through @electron/remote,
		// which is what the plugin's Print command ends up in as well.
		let pdfSource = "cdp";
		let pdfBase64 = "";
		try {
			pdfBase64 = (
				await printCdp.send("Page.printToPDF", {
					printBackground: true,
					preferCSSPageSize: false,
					landscape: true,
				})
			).data;
		} catch (e) {
			pdfSource = `electron (${String(e.message).split("\n")[0]})`;
			pdfBase64 = await page.evaluate(async () => {
				const remote = window.require("@electron/remote");
				const buffer = await remote
					.getCurrentWebContents()
					.printToPDF({ printBackground: true, landscape: true });
				const bytes = new Uint8Array(buffer);
				let binary = "";
				const step = 0x8000;
				for (let i = 0; i < bytes.length; i += step) {
					binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
				}
				return btoa(binary);
			});
		}
		console.log("  pdf via:", pdfSource);
		await printCdp.send("Emulation.setEmulatedMedia", { media: "" });
		await page.waitForTimeout(300);
		const pdfBuf = Buffer.from(pdfBase64, "base64");
		fs.writeFileSync(path.join(SHOTS, "22-print.pdf"), pdfBuf);
		console.log(`  pdf ${pdfBuf.length} B -> ${path.join(SHOTS, "22-print.pdf")}`);
		check("the PDF is a PDF", pdfBuf.slice(0, 5).toString() === "%PDF-",
			pdfBuf.slice(0, 8).toString());
		const pdfPages = (pdfBuf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
		console.log("  pdf pages:", pdfPages);
		check("it has at least one page", pdfPages >= 1, String(pdfPages));

		const printedText = pdfText(pdfBuf);
		console.log(`  pdf text (${printedText.length} chars):`, JSON.stringify(printedText.slice(0, 300)));
		check("the grid's content is in the PDF", printedText.includes("Write docs"),
			printedText.slice(0, 200));
		check("so are the other rows", printedText.includes("Ship it") && printedText.includes("Total"),
			printedText.slice(0, 200));
		// Chromium draws one glyph per operator, so the header row arrives as a run
		// of letters with nothing between them: "ABCDEF1Task2Write docs...".
		check("and the column letters, and the row numbers with them",
			printedText.includes("ABCDEF") && /1Task/.test(printedText),
			printedText.slice(0, 120));
		check("the app's chrome is NOT in it (no tab title)",
			!printedText.includes("Exchange14"), printedText.slice(0, 200));
		check("neither is the OTHER tab that happens to be open",
			!printedText.includes("A note a cell points at"), printedText.slice(0, 200));
		check("neither is the formula bar's placeholder",
			!printedText.includes("Value or formula"), printedText.slice(0, 200));
		// On paper a checkbox is a character, because Chromium's print painter
		// ignores a styled <input> and printed every box empty, ticked or not.
		check("a ticked and an unticked checkbox print differently",
			printedText.includes("☑") && printedText.includes("☐"),
			printedText.slice(0, 200));


		step("embedded sheets in a markdown note");
		const NOTE_PATH = "Embeds.md";
		const NOTE = [
			"# Embeds",
			"",
			"A whole sheet:",
			"",
			`![[${SHEET_PATH}]]`,
			"",
			"A range, no chrome:",
			"",
			`![[${SHEET_PATH}#Sheet1!A1:B4|plain]]`,
			"",
			"And the code block form:",
			"",
			"```sheet",
			`${SHEET_PATH}#Sheet1!A1:C4`,
			"```",
			"",
		].join("\n");
		// Install the note, then look at it in BOTH markdown modes. Live preview is
		// the default one people edit in, and it renders embeds through Obsidian's
		// own widget machinery rather than the post-processor, so it has to be
		// checked separately (that is what the embed registry is for).
		const openNote = async (mode) =>
			page.evaluate(
				async ([notePath, text, viewMode]) => {
					const app = window.app;
					app.workspace.detachLeavesOfType("leovale-sheet-view");
					let note = app.vault.getAbstractFileByPath(notePath);
					if (!note) note = await app.vault.create(notePath, text);
					// Reuse the markdown leaf across the two modes: detaching every
					// leaf first leaves no tab group for getLeaf() to put one in.
					const leaf = app.workspace.getLeavesOfType("markdown")[0] ?? app.workspace.getLeaf(true);
					await leaf.openFile(note);
					await leaf.setViewState({
						type: "markdown",
						state: { file: note.path, mode: viewMode, source: false },
					});
				},
				[NOTE_PATH, text, mode],
			);

		/** Metrics for the embeds inside one view container. */
		const embedMetrics = (scope) =>
			page.evaluate((sel) => {
				const root = document.querySelector(sel);
				if (!root) return { missing: sel };
				const nodes = [...root.querySelectorAll(".leovale-sheet-embed")];
				const cell = (host, x, y) =>
					host.querySelector(`.leovale-sheet-root td[data-x="${x}"][data-y="${y}"]`)?.textContent;
				const plainNode = root.querySelector(".leovale-sheet-embed.is-plain");
				const thead = plainNode?.querySelector(".leovale-sheet-root thead");
				const gutter = plainNode?.querySelector(".leovale-sheet-root tbody tr td:first-child");
				return {
					count: nodes.length,
					grids: nodes.map((n) => !!n.querySelector(".leovale-sheet-root table.jss_worksheet")),
					leftovers: root.querySelectorAll(".internal-embed .file-embed-title").length,
					toolbars: root.querySelectorAll(".leovale-sheet-embed .leovale-sheet-toolbar").length,
					bars: root.querySelectorAll(".leovale-sheet-embed .leovale-sheet-formulabar").length,
					headers: root.querySelectorAll(".leovale-sheet-embed-header").length,
					plainHeaders: root.querySelectorAll(
						".leovale-sheet-embed.is-plain .leovale-sheet-embed-header",
					).length,
					titles: [...root.querySelectorAll(".leovale-sheet-embed-title")].map((e) => e.textContent),
					headerRow: Math.round(
						nodes[0]
							?.querySelector(".leovale-sheet-root .jss_worksheet > thead")
							?.getBoundingClientRect().height ?? 0,
					),
					first: nodes[0]
						? {
								a1: cell(nodes[0], 0, 0),
								b2: cell(nodes[0], 1, 1),
								b4: cell(nodes[0], 1, 3),
								c2: cell(nodes[0], 2, 1),
								visibleRows: [...nodes[0].querySelectorAll(".leovale-sheet-root tbody tr")].filter(
									(tr) => getComputedStyle(tr).display !== "none",
								).length,
								bodyMax: getComputedStyle(nodes[0].querySelector(".leovale-sheet-embed-body"))
									.maxHeight,
							}
						: null,
					plain: plainNode
						? {
								a1: cell(plainNode, 0, 0),
								b4: cell(plainNode, 1, 3),
								thead: thead ? getComputedStyle(thead).display : null,
								gutter: gutter ? getComputedStyle(gutter).display : null,
								background: getComputedStyle(plainNode).backgroundColor,
								border: getComputedStyle(plainNode).borderTopWidth,
								visibleCols: [
									...plainNode.querySelectorAll(
										".leovale-sheet-root tbody tr:nth-child(1) td[data-x]",
									),
								].filter((td) => getComputedStyle(td).display !== "none").length,
								// Hiding the row numbers must not shift the column widths onto
								// the wrong <col>: A is the wide one (180px in the file, scaled
								// up with the rest to fill the embed), B the narrow one.
								colAWidth: Math.round(
									plainNode
										.querySelector('.leovale-sheet-root td[data-x="0"][data-y="0"]')
										?.getBoundingClientRect().width ?? 0,
								),
								colBWidth: Math.round(
									plainNode
										.querySelector('.leovale-sheet-root td[data-x="1"][data-y="0"]')
										?.getBoundingClientRect().width ?? 0,
								),
								firstText: plainNode.querySelector(
									'.leovale-sheet-root td[data-x="0"][data-y="0"]',
								)?.textContent,
								truncated: (() => {
									const td = plainNode.querySelector(
										'.leovale-sheet-root td[data-x="0"][data-y="0"]',
									);
									return td ? td.scrollWidth > td.clientWidth + 1 : null;
								})(),
							}
						: null,
				};
			}, scope);

		const text = NOTE;
		await openNote("source");
		await page.waitForTimeout(3000);
		const live = await embedMetrics(".markdown-source-view");
		console.log("  live preview:", JSON.stringify(live, null, 1));
		check("live preview mounts a grid for every embed", live.count === 3 && live.grids.every(Boolean),
			JSON.stringify(live));
		check(
			"live preview shows no generic file card",
			live.leftovers === 0,
			String(live.leftovers),
		);
		check("live preview renders the values", live.first?.a1 === "Item", String(live.first?.a1));
		check(
			"the column letters are a full row, not a collapsed sliver",
			live.headerRow >= 16,
			String(live.headerRow),
		);
		check(
			"live preview renders masked formula results",
			live.first?.b4 === "$7.00",
			String(live.first?.b4),
		);
		await shot(page, "14-embed-live-preview-light");

		await openNote("preview");
		await page.waitForTimeout(3000);
		const embeds = await embedMetrics(".markdown-reading-view");
		console.log("  reading view:", JSON.stringify(embeds, null, 1));
		check("all three embeds mounted a grid", embeds.count === 3 && embeds.grids.every(Boolean),
			JSON.stringify(embeds.grids));
		check("Obsidian's generic file card was replaced", embeds.leftovers === 0, String(embeds.leftovers));
		check("an embed has no toolbar and no formula bar", embeds.toolbars === 0 && embeds.bars === 0,
			JSON.stringify([embeds.toolbars, embeds.bars]));
		check("values render inside the note", embeds.first?.a1 === "Item", String(embeds.first?.a1));
		check(
			"a computed formula renders inside the note",
			embeds.first?.c2 === "6",
			String(embeds.first?.c2),
		);
		check(
			"a formatted formula renders through its mask inside the note",
			embeds.first?.b4 === "$7.00",
			String(embeds.first?.b4),
		);
		check(
			"the embed shows the used range, not 100 empty rows",
			embeds.first?.visibleRows > 0 && embeds.first?.visibleRows <= 8,
			String(embeds.first?.visibleRows),
		);
		check("the embed body is capped and scrolls", /vh|px/.test(embeds.first?.bodyMax ?? ""),
			String(embeds.first?.bodyMax));
		check("non-plain embeds get a header naming the file", embeds.headers === 2,
			JSON.stringify(embeds.titles));
		check(
			"the header names the sheet and the range when asked for one",
			embeds.titles.some((t) => t.includes("A1:C4")),
			JSON.stringify(embeds.titles),
		);
		check("|plain has no header", embeds.plainHeaders === 0, String(embeds.plainHeaders));
		check("|plain hides the column letters", embeds.plain?.thead === "none", String(embeds.plain?.thead));
		check("|plain hides the row numbers", embeds.plain?.gutter === "none", String(embeds.plain?.gutter));
		check(
			"|plain is transparent and frameless",
			embeds.plain?.background === "rgba(0, 0, 0, 0)" && embeds.plain?.border === "0px",
			JSON.stringify([embeds.plain?.background, embeds.plain?.border]),
		);
		check("|plain still renders the values", embeds.plain?.a1 === "Item", String(embeds.plain?.a1));
		check(
			"the range in the link crops the grid",
			embeds.plain?.visibleCols === 2,
			String(embeds.plain?.visibleCols),
		);
		check(
			"hiding the row numbers did not shift the column widths",
			embeds.plain?.colAWidth > embeds.plain?.colBWidth && embeds.plain?.truncated === false,
			`A=${embeds.plain?.colAWidth}px B=${embeds.plain?.colBWidth}px, ` +
				`showing "${embeds.plain?.firstText}", truncated=${embeds.plain?.truncated}`,
		);

		// The layout the user asked for: a caption-sized header, no inner gaps, and
		// a table that fills the embed instead of leaving the right half empty.
		const embedLayout = await page.evaluate(() => {
			const node = document.querySelector(".markdown-reading-view .leovale-sheet-embed");
			const body = node.querySelector(".leovale-sheet-embed-body");
			const table = node.querySelector("table.jss_worksheet");
			const box = (el) => el.getBoundingClientRect();
			return {
				headerHeight: Math.round(box(node.querySelector(".leovale-sheet-embed-header")).height),
				fontSize: getComputedStyle(node.querySelector(".leovale-sheet-embed-title")).fontSize,
				color: getComputedStyle(node.querySelector(".leovale-sheet-embed-title")).color,
				muted: getComputedStyle(document.body).getPropertyValue("--text-muted").trim(),
				gapTop: Math.round(box(table).top - box(body).top),
				gapBottom: Math.round(box(body).bottom - box(table).bottom),
				gapLeft: Math.round(box(table).left - box(body).left),
				gapRight: Math.round(box(body).right - box(table).right),
				tableWidth: Math.round(box(table).width),
				bodyWidth: Math.round(box(body).width),
			};
		});
		console.log("  embed layout:", embedLayout);
		check("the header is a slim caption row", embedLayout.headerHeight <= 28,
			String(embedLayout.headerHeight));
		check(
			"the grid sits flush inside the frame",
			embedLayout.gapTop === 0 &&
				embedLayout.gapBottom === 0 &&
				embedLayout.gapLeft === 0 &&
				embedLayout.gapRight === 0,
			JSON.stringify(embedLayout),
		);
		check(
			"the table fills the embed width",
			embedLayout.tableWidth === embedLayout.bodyWidth,
			`${embedLayout.tableWidth} of ${embedLayout.bodyWidth}`,
		);
		await shot(page, "12-embed-light");

		step("an embed follows the source file");
		const embedRefresh = await page.evaluate(async (p) => {
			const app = window.app;
			const file = app.vault.getAbstractFileByPath(p);
			const text = await app.vault.read(file);
			await app.vault.modify(file, text.replace('"v": "Item"', '"v": "Renamed"'));
			await new Promise((r) => setTimeout(r, 1600));
			const root = document.querySelector(".markdown-reading-view");
			const node = root.querySelector(".leovale-sheet-embed");
			return {
				a1: node?.querySelector('.leovale-sheet-root td[data-x="0"][data-y="0"]')?.textContent,
				gridsPerEmbed: [...root.querySelectorAll(".leovale-sheet-embed")].map(
					(n) => n.querySelectorAll(".leovale-sheet-root").length,
				),
			};
		}, SHEET_PATH);
		console.log("  after modify:", embedRefresh);
		check("the embed re-rendered with the new value", embedRefresh.a1 === "Renamed",
			String(embedRefresh.a1));
		check(
			"re-rendering replaced the grid instead of stacking a second one",
			embedRefresh.gridsPerEmbed.every((n) => n === 1),
			JSON.stringify(embedRefresh.gridsPerEmbed),
		);

		step("an embed is read-only and does not steal the note's typing");
		const embedTyping = await page.evaluate(async () => {
			const node = document.querySelector(".markdown-reading-view .leovale-sheet-embed");
			const td = node.querySelector('.leovale-sheet-root td[data-x="0"][data-y="0"]');
			td.click();
			await new Promise((r) => setTimeout(r, 200));
			td.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
			await new Promise((r) => setTimeout(r, 300));
			return {
				editors: node.querySelectorAll("td.editor, td input, td textarea").length,
				text: td.textContent,
			};
		});
		console.log("  embed typing:", embedTyping);
		check("a double click does not open an editor in an embed", embedTyping.editors === 0,
			String(embedTyping.editors));
		check("the cell text is unchanged", embedTyping.text === "Renamed", String(embedTyping.text));

		await setBaseTheme(page, "obsidian");
		await page.waitForTimeout(1200);
		const embedDark = await page.evaluate(() => {
			const root = document.querySelector(".markdown-reading-view");
			const td = root.querySelector('.leovale-sheet-embed .leovale-sheet-root td[data-x="0"][data-y="1"]');
			const table = root.querySelector(".leovale-sheet-embed .leovale-sheet-root table.jss_worksheet");
			const rgb = (s) => (s.match(/\d+/g) ?? []).slice(0, 3).map(Number);
			const lum = (c) => (c.length === 3 ? (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255 : null);
			return {
				text: getComputedStyle(td).color,
				textLum: lum(rgb(getComputedStyle(td).color)),
				tableLum: lum(rgb(getComputedStyle(table).backgroundColor)),
				// a rebuild happened, so the DOM really is the current theme's
				grids: root.querySelectorAll(".leovale-sheet-embed .leovale-sheet-root").length,
			};
		});
		console.log("  embed in dark theme:", embedDark);
		check(
			"an embedded grid follows the theme it is rendered in",
			embedDark.tableLum !== null && embedDark.tableLum < 0.35 && embedDark.textLum > 0.5,
			JSON.stringify(embedDark),
		);
		check("the theme change did not duplicate the grids", embedDark.grids === 3,
			String(embedDark.grids));
		// Scroll the note before the screenshot. Switching the theme changes CSS
		// variables only, and this window's compositor keeps serving the tiles it
		// already has for the embed's scroll container: the CAPTURE (not the page -
		// the computed colours above are the dark ones) would otherwise show the
		// light theme. Scrolling forces fresh tiles.
		await page.evaluate(() => {
			const view = document.querySelector(".markdown-reading-view .markdown-preview-view");
			if (view) view.scrollTop = 40;
		});
		await page.waitForTimeout(700);
		await shot(page, "13-embed-dark");
		await setBaseTheme(page, "moonstone");
		await page.waitForTimeout(900);

		// Put the sheet back the way the rest of the suite expects it.
		await page.evaluate(async (p) => {
			const app = window.app;
			const file = app.vault.getAbstractFileByPath(p);
			const text = await app.vault.read(file);
			await app.vault.modify(file, text.replace('"v": "Renamed"', '"v": "Item"'));
			app.workspace.detachLeavesOfType("markdown");
		}, SHEET_PATH);
		await page.waitForTimeout(800);

		step(".sheet owned by another plugin -> notice + .lsheet fallback");
		const fallback = await page.evaluate(async (id) => {
			const app = window.app;
			app.workspace.detachLeavesOfType("leovale-sheet-view");
			await app.plugins.disablePlugin(id);
			await new Promise((r) => setTimeout(r, 400));
			// Pretend Sheet Plus got there first.
			try {
				app.viewRegistry.unregisterExtensions(["sheet"]);
			} catch {
				/* already free after our plugin was disabled */
			}
			app.viewRegistry.registerExtensions(["sheet"], "foreign-sheet-plus-view");
			document.querySelectorAll(".notice").forEach((n) => n.remove());
			await app.plugins.enablePlugin(id);
			await new Promise((r) => setTimeout(r, 1500));
			const plugin = app.plugins.plugins[id];
			return {
				owned: plugin?.sheetExtOwned,
				sheetOwner: app.viewRegistry.getTypeByExtension("sheet"),
				lsheetOwner: app.viewRegistry.getTypeByExtension("lsheet"),
				csvOwner: app.viewRegistry.getTypeByExtension("csv"),
				notices: [...document.querySelectorAll(".notice")].map((n) => n.textContent),
			};
		}, PLUGIN_ID);
		console.log("  fallback:", fallback);
		check("the plugin still loaded", fallback.lsheetOwner === "leovale-sheet-view");
		check("it knows it does not own .sheet", fallback.owned === false, String(fallback.owned));
		check(".sheet was left to the other plugin", fallback.sheetOwner === "foreign-sheet-plus-view",
			String(fallback.sheetOwner));
		check(".csv is still registered", fallback.csvOwner === "leovale-sheet-view", String(fallback.csvOwner));
		const notice = fallback.notices.join(" | ");
		check("a notice was shown", fallback.notices.length >= 1, notice);
		check("the notice names the extension", notice.includes(".sheet"), notice);
		check("the notice names the owner", notice.includes("foreign-sheet-plus-view"), notice);
		check("the notice names the fallback extension", notice.includes(".lsheet"), notice);

		await page.evaluate((id) => window.app.commands.executeCommandById(`${id}:create-sheet`), PLUGIN_ID);
		await page.waitForTimeout(2000);
		const lsheet = await page.evaluate(() => ({
			path: window.app.workspace.getActiveFile()?.path,
			viewType: window.app.workspace.activeLeaf?.view?.getViewType?.(),
			grid: !!document.querySelector(".leovale-sheet-content .leovale-sheet-root table.jss_worksheet"),
			mode: window.sheetView()?.sheetMode,
		}));
		console.log("  lsheet:", lsheet);
		check("the create command used .lsheet", lsheet.path === "Untitled.lsheet", String(lsheet.path));
		check(".lsheet opened in the same grid", lsheet.viewType === "leovale-sheet-view" && lsheet.grid);
		check(".lsheet keeps the JSON format", lsheet.mode === "sheet", String(lsheet.mode));
		const lsheetDisk = fs.readFileSync(path.join(VAULT, "Untitled.lsheet"), "utf8");
		check(
			".lsheet on disk is our deterministic JSON",
			lsheetDisk.startsWith('{\n  "format": "leovale-sheet",\n  "version": 4,'),
			lsheetDisk.slice(0, 40),
		);

		const restored = await page.evaluate(async (id) => {
			const app = window.app;
			app.workspace.detachLeavesOfType("leovale-sheet-view");
			await new Promise((r) => setTimeout(r, 400));
			for (const f of app.vault.getFiles()) {
				if (f.extension === "lsheet") await app.vault.delete(f);
			}
			await app.plugins.disablePlugin(id);
			await new Promise((r) => setTimeout(r, 400));
			try {
				app.viewRegistry.unregisterExtensions(["sheet"]);
			} catch {
				/* nothing to release */
			}
			await app.plugins.enablePlugin(id);
			await new Promise((r) => setTimeout(r, 1500));
			return {
				sheetOwner: app.viewRegistry.getTypeByExtension("sheet"),
				owned: app.plugins.plugins[id]?.sheetExtOwned,
			};
		}, PLUGIN_ID);
		console.log("  restored:", restored);
		check("with .sheet free again the plugin takes it", restored.sheetOwner === "leovale-sheet-view" &&
			restored.owned === true, JSON.stringify(restored));

		const realErrors = pageErrors.filter(
			(e) =>
				!/Failed to load resource|net::ERR|DevTools|Autofill/.test(e) &&
				// the guard test deliberately throws inside a fake engine
				!/serialize failed Error: boom/.test(e),
		);
		check("no console errors / page errors", realErrors.length === 0, realErrors.slice(0, 5).join(" | "));
	} finally {
		await browser.close();
		if (!KEEP) {
			const pids = killSandbox();
			console.log(`\nkilled sandbox pids: ${pids.join(", ") || "(none)"}`);
		}
	}

	console.log(`\n==== ${checks - failures}/${checks} checks passed ====`);
	console.log("screenshots:\n" + shots.map((s) => "  " + s).join("\n"));
	if (failures > 0) process.exitCode = 1;
}

await main();
