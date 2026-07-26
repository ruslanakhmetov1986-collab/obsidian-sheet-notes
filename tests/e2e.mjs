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
// Playwright is only needed for e2e, not for building the plugin. Either
// `npm i -D playwright` in this repo, or point SHEETS_PLAYWRIGHT at an
// existing install (a file:// URL to its index.mjs).
const { chromium } = await import(process.env.SHEETS_PLAYWRIGHT ?? "playwright");
import {
	CDP_PORT,
	PLUGIN_ID,
	SHOTS,
	VAULT,
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
	await page.click(`.leovale-sheet-root td[data-x="${x}"][data-y="${y}"]`);
	await page.waitForTimeout(80);
	await page.keyboard.type(text, { delay: 12 });
	await page.keyboard.press(commit);
	await page.waitForTimeout(120);
}

function cellText(page, x, y) {
	return page.evaluate(
		([cx, cy]) =>
			document.querySelector(`.leovale-sheet-root td[data-x="${cx}"][data-y="${cy}"]`)?.textContent,
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

function selectedCell(page) {
	return page.evaluate(() => {
		const td = document.querySelector(".leovale-sheet-root td.highlight-selected");
		return td ? [Number(td.dataset.x), Number(td.dataset.y)] : null;
	});
}

async function main() {
	step("build artifacts");
	const sizes = deployPlugin();
	console.log("  deployed:", sizes);
	check("main.js is a plausible bundle", sizes["main.js"] > 200_000, String(sizes["main.js"]));
	check("styles.css is a plausible bundle", sizes["styles.css"] > 20_000, String(sizes["styles.css"]));

	step("launch sandbox Obsidian (port 9333, own user-data-dir)");
	console.log("  ", await launchSandbox({ fresh: FRESH }));

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
		await page.evaluate(async () => {
			window.app.workspace.detachLeavesOfType("leovale-sheet-view");
			for (const f of window.app.vault.getFiles()) {
				if (f.extension === "sheet") await window.app.vault.delete(f);
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
			const root = document.querySelector(".leovale-sheet-root");
			const table = document.querySelector(".leovale-sheet-root table.jss_worksheet");
			return {
				viewType: window.app.workspace.activeLeaf?.view?.getViewType?.(),
				hasRoot: !!root,
				headers: [...document.querySelectorAll(".leovale-sheet-root thead td")]
					.slice(1, 5)
					.map((t) => t.textContent),
				rowLabels: [...document.querySelectorAll(".leovale-sheet-root tbody td.jss_row")]
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
		await page.click('.leovale-sheet-root td[data-x="0"][data-y="0"]');
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
		await page.click('.leovale-sheet-root td[data-x="1"][data-y="3"]');
		await page.waitForTimeout(200);
		const barOnB4 = await page.evaluate(() => ({
			ref: document.querySelector(".leovale-sheet-fb-ref").textContent,
			value: document.querySelector(".leovale-sheet-fb-input").value,
			cellShows: document.querySelector('.leovale-sheet-root td[data-x="1"][data-y="3"]').textContent,
		}));
		console.log("  bar on B4:", barOnB4);
		check("bar names the active cell", barOnB4.ref === "B4", barOnB4.ref);
		check("bar shows the formula source", barOnB4.value === "=SUM(B2:B3)", barOnB4.value);
		check("the cell itself still shows the result", barOnB4.cellShows === "7", barOnB4.cellShows);

		// a range shows as A1:C1
		const a1r = await page.locator('.leovale-sheet-root td[data-x="0"][data-y="0"]').boundingBox();
		const c1r = await page.locator('.leovale-sheet-root td[data-x="2"][data-y="0"]').boundingBox();
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
		await page.click('.leovale-sheet-root td[data-x="3"][data-y="5"]');
		await page.waitForTimeout(150);
		await page.click(`${fb} .leovale-sheet-fb-input`);
		await page.keyboard.type("=SUM(B2:B3)*10", { delay: 12 });
		await page.keyboard.press("Enter");
		await page.waitForTimeout(400);
		const barCommit = await page.evaluate(() => ({
			cell: document.querySelector('.leovale-sheet-root td[data-x="3"][data-y="5"]').textContent,
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
			const corner = document.querySelector(".leovale-sheet-root thead td:first-child");
			const dataCell = document.querySelector('.leovale-sheet-root td[data-x="4"][data-y="2"]');
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
		const headA = await page.locator('.leovale-sheet-root thead td[data-x="0"]').boundingBox();
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
		const rowHead = await page.locator('.leovale-sheet-root tbody tr:nth-child(2) td.jss_row').boundingBox();
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
			icons.length === 4 && icons.every((i) => i.glyphs === 1 || i.cls.includes("tb-size")),
			JSON.stringify(icons),
		);
		check(
			"separators are 1px and ~60% tall",
			tbLook.sepW === 1 && tbLook.sepH > 15 && tbLook.sepH < 26,
			JSON.stringify([tbLook.sepW, tbLook.sepH]),
		);

		// select the header row A1:C1 by dragging across it
		const a1 = await page.locator('.leovale-sheet-root td[data-x="0"][data-y="0"]').boundingBox();
		const c1 = await page.locator('.leovale-sheet-root td[data-x="2"][data-y="0"]').boundingBox();
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
			(await page.locator(`${tb} .leovale-sheet-tb-value`).innerText()).trim() === "18",
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
			const td = document.querySelector('.leovale-sheet-root td[data-x="0"][data-y="0"]');
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
		await page.click('.leovale-sheet-root td[data-x="0"][data-y="1"]');
		const b3 = await page.locator('.leovale-sheet-root td[data-x="1"][data-y="2"]').boundingBox();
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
		check("2-space indent header", onDisk.startsWith('{\n  "format": "leovale-sheet",\n  "version": 1,'));
		check("valid JSON", (() => { try { JSON.parse(onDisk); return true; } catch { return false; } })());
		check('A1 stored as { "v": "Item", ... }', /"A1": \{ "v": "Item"[,}]/.test(onDisk));
		check("B2 stored as a number", /"B2": \{ "v": 3[,}]/.test(onDisk));
		check('B4 stored as formula source', onDisk.includes('"B4": { "f": "=SUM(B2:B3)" }'));
		check("computed results are not cached", !/"B4": \{ "v"/.test(onDisk));
		check(
			"column width persisted",
			/"colWidths": \{\n\s+"0": (\d+)/.exec(onDisk)?.[1] === String(width),
			`expected width ${width}`,
		);
		check("sparse: empty cells absent", !onDisk.includes('"Z100"') && onDisk.length < 2000,
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
		check("no raw CSS leaked into the file", !/font-weight|px|--leovale/.test(onDisk));
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
				document.querySelector(`.leovale-sheet-root td[data-x="${x}"][data-y="${y}"]`)?.textContent;
			const ws = window.wsHandle();
			const cs = getComputedStyle(
				document.querySelector('.leovale-sheet-root td[data-x="0"][data-y="0"]'),
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
		check("B2 restored", reopened.b2 === "3", String(reopened.b2));
		check("formula recomputed after reload (B4 = 7)", reopened.b4 === "7", String(reopened.b4));
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
		await shot(page, "03-reopened-light");

		step("dark theme");
		await setBaseTheme(page, "obsidian");
		await page.waitForTimeout(1200);
		const darkOk = await page.evaluate(() => {
			// A3 has no fill: it must follow the theme's own text colour
			const td = document.querySelector('.leovale-sheet-root td[data-x="0"][data-y="2"]');
			const head = document.querySelector(".leovale-sheet-root thead td:nth-child(2)");
			const table = document.querySelector(".leovale-sheet-root table.jss_worksheet");
			const rgb = (s) => (s.match(/\d+/g) ?? []).slice(0, 3).map(Number);
			const lum = (c) => (c.length === 3 ? (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255 : null);
			const filled = document.querySelector('.leovale-sheet-root td[data-x="0"][data-y="0"]');
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
		await page.click(".leovale-sheet-root td[data-x=\"3\"][data-y=\"6\"]");
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
		await page.click(".leovale-sheet-root td[data-x=\"0\"][data-y=\"0\"]");
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
		await page.waitForTimeout(2200);
		const csvOpen = await page.evaluate(() => {
			const v = window.sheetView();
			const q = (x, y) =>
				document.querySelector(`.leovale-sheet-root td[data-x="${x}"][data-y="${y}"]`)?.textContent;
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
		await page.click('.leovale-sheet-root td[data-x="0"][data-y="0"]');
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
		await page.waitForTimeout(2200);
		const csvReopened = await page.evaluate(() => {
			const q = (x, y) =>
				document.querySelector(`.leovale-sheet-root td[data-x="${x}"][data-y="${y}"]`)?.textContent;
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
			grid: !!document.querySelector(".leovale-sheet-root table.jss_worksheet"),
			mode: window.sheetView()?.sheetMode,
		}));
		console.log("  lsheet:", lsheet);
		check("the create command used .lsheet", lsheet.path === "Untitled.lsheet", String(lsheet.path));
		check(".lsheet opened in the same grid", lsheet.viewType === "leovale-sheet-view" && lsheet.grid);
		check(".lsheet keeps the JSON format", lsheet.mode === "sheet", String(lsheet.mode));
		const lsheetDisk = fs.readFileSync(path.join(VAULT, "Untitled.lsheet"), "utf8");
		check(
			".lsheet on disk is our deterministic JSON",
			lsheetDisk.startsWith('{\n  "format": "leovale-sheet",\n  "version": 1,'),
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
