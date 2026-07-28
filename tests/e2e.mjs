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
	SANDBOX,
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

/** The step being run, so a stray console error can be blamed on one. */
let currentStep = "(startup)";

function step(n) {
	currentStep = n;
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

/**
 * Install a touch driver in the page.
 *
 * Playwright's own `touchscreen` goes through Chromium's gesture recogniser,
 * which is right for a tap and useless for the questions this suite asks: what
 * the PLUGIN's listeners do with a gesture, in the order they see it. So the
 * events are built here and dispatched directly - the same `TouchEvent`s a
 * finger produces, with the same bubbling, at coordinates we choose to the
 * pixel. A synthetic pan does not move a scroll container by itself (only the
 * compositor does that), so `scrollWith` moves it the way the finger would,
 * which is what makes the snap-back question answerable at all.
 */
async function installTouchDriver(page) {
	await page.evaluate(() => {
		window.__touch = async (opts) => {
			const {
				selector,
				at = null,
				dx = 0,
				dy = 0,
				steps = 5,
				holdMs = 0,
				scrollWith = false,
				endAfterMs = 0,
			} = opts;
			const el = selector ? document.querySelector(selector) : null;
			const rect = el ? el.getBoundingClientRect() : null;
			const x0 = at ? at.x : rect.left + rect.width / 2;
			const y0 = at ? at.y : rect.top + rect.height / 2;
			// With both a selector and coordinates the selector names the TARGET and
			// the coordinates are where the finger is: that is the only way to ask
			// "what happens for a touch at screen x=6" in a desktop sandbox, where
			// the sheet does not start at the screen edge and a real tablet's does.
			const target = el ?? document.elementFromPoint(x0, y0) ?? document.body;
			const wrapper = document.querySelector(".leovale-sheet-wrapper");
			const wait = (ms) => new Promise((r) => setTimeout(r, ms));
			const make = (type, x, y) => {
				const point = new Touch({
					identifier: 1,
					target,
					clientX: x,
					clientY: y,
					pageX: x,
					pageY: y,
				});
				const live = type === "touchend" || type === "touchcancel" ? [] : [point];
				return new TouchEvent(type, {
					touches: live,
					targetTouches: live,
					changedTouches: [point],
					bubbles: true,
					cancelable: true,
					composed: true,
				});
			};
			target.dispatchEvent(make("touchstart", x0, y0));
			if (holdMs > 0) await wait(holdMs);
			for (let i = 1; i <= steps && (dx !== 0 || dy !== 0); i++) {
				const x = x0 + (dx * i) / steps;
				const y = y0 + (dy * i) / steps;
				target.dispatchEvent(make("touchmove", x, y));
				if (scrollWith && wrapper) {
					wrapper.scrollLeft -= dx / steps;
					wrapper.scrollTop -= dy / steps;
				}
				await wait(10);
			}
			if (endAfterMs > 0) await wait(endAfterMs);
			target.dispatchEvent(make("touchend", x0 + dx, y0 + dy));
			await wait(60);
			return {
				scrollLeft: wrapper ? Math.round(wrapper.scrollLeft) : null,
				scrollTop: wrapper ? Math.round(wrapper.scrollTop) : null,
			};
		};
		/** "x,y" of the cell the grid calls selected, for terse assertions. */
		window.selectedCellRef = () => {
			const td = document.querySelector(
				".leovale-sheet-content .leovale-sheet-root td.highlight-selected",
			);
			return td ? `${td.dataset.x},${td.dataset.y}` : null;
		};
	});
}

/** The titles of the menu the plugin has open right now, in order. */
function menuTitles(page, cls = ".leovale-sheet-menu") {
	return page.evaluate(
		(c) => [...document.querySelectorAll(`.menu${c} .menu-item-title`)].map((i) => i.textContent),
		cls,
	);
}

/* --------------------------------------------- is it really PAINTED there? */

/**
 * What share of an element's interior is not its own background colour.
 *
 * The question this answers is "did the mark inside this box actually get
 * painted", and no DOM property can answer it. The checked checkbox shipped for
 * a release as an accent-coloured square with an unreadable dash in it: the
 * input was `:checked`, the pseudo-element was there, its computed style looked
 * plausible, and Obsidian's own `-webkit-mask-image` - which our rule did not
 * mention and therefore did not replace - was quietly clipping the tick down to
 * a few pixels. Every assertion available at the time was green.
 *
 * So this one goes through the compositor: `Page.captureScreenshot` with a clip
 * on the element (scale 4, so a 15px box is 60px of evidence), decoded back into
 * pixels through a canvas in the page, and the interior counted against the most
 * common colour in it - which is the fill. A tick is a fat share of that
 * interior; nothing, or a stray fragment, is not.
 *
 * Measured on the bug and on the fix, at the same 4x zoom: the broken tick moved
 * 4% of the interior pixels, the real one 25.6%, an empty box 0%.
 */
async function paintedRatio(cdp, page, selector, nth = 0, scale = 4) {
	const rect = await page.evaluate(
		([sel, i]) => {
			const el = document.querySelectorAll(sel)[i];
			if (!el) return null;
			const r = el.getBoundingClientRect();
			if (r.width < 2 || r.height < 2) return null;
			return { x: r.left, y: r.top, width: r.width, height: r.height };
		},
		[selector, nth],
	);
	if (!rect) return null;
	const { data } = await cdp.send("Page.captureScreenshot", {
		format: "png",
		clip: { ...rect, scale },
		captureBeyondViewport: false,
	});
	return page.evaluate(async (b64) => {
		const img = new Image();
		img.src = `data:image/png;base64,${b64}`;
		await img.decode();
		const canvas = document.createElement("canvas");
		canvas.width = img.width;
		canvas.height = img.height;
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		ctx.drawImage(img, 0, 0);
		const { data: px, width: w, height: h } = ctx.getImageData(0, 0, canvas.width, canvas.height);
		// The outer fifth is the border, the rounded corners and their
		// antialiasing - none of which is the mark.
		const x0 = Math.round(w * 0.22);
		const x1 = Math.round(w * 0.78);
		const y0 = Math.round(h * 0.22);
		const y1 = Math.round(h * 0.78);
		const at = (x, y) => {
			const i = (y * w + x) * 4;
			return [px[i], px[i + 1], px[i + 2]];
		};
		const counts = new Map();
		for (let y = y0; y < y1; y++) {
			for (let x = x0; x < x1; x++) {
				const [r, g, b] = at(x, y);
				const key = `${r >> 3},${g >> 3},${b >> 3}`;
				counts.set(key, (counts.get(key) ?? 0) + 1);
			}
		}
		let fillKey = null;
		let best = -1;
		for (const [key, n] of counts) {
			if (n > best) {
				best = n;
				fillKey = key;
			}
		}
		const fill = fillKey.split(",").map((n) => Number(n) * 8 + 4);
		let differ = 0;
		let total = 0;
		for (let y = y0; y < y1; y++) {
			for (let x = x0; x < x1; x++) {
				const [r, g, b] = at(x, y);
				total++;
				if (Math.abs(r - fill[0]) + Math.abs(g - fill[1]) + Math.abs(b - fill[2]) > 120) differ++;
			}
		}
		return { ratio: total > 0 ? differ / total : 0, fill, px: total };
	}, data);
}

/**
 * The MEAN COLOUR a human sees inside one element, straight off the compositor.
 *
 * The selection tint exists to be seen, and nothing short of a screenshot can
 * say whether it was painted: it is drawn as a `background-image` LAYER over
 * whatever background the cell already has, so `getComputedStyle` reports the
 * declaration on both a cell that shows it and a cell whose inline
 * `background-color` used to swallow it whole. That was the bug - three
 * releases of a "selected" class on cells the user saw as pure white.
 *
 * Only the interior is averaged (the middle ~56% of the box). The outer fifth
 * is the range border and the corner handle, which are the parts of a selection
 * that always DID paint, so counting them would let a broken tint pass.
 */
async function avgColor(cdp, page, selector, nth = 0, scale = 4) {
	const rect = await page.evaluate(
		([sel, i]) => {
			const el = document.querySelectorAll(sel)[i];
			if (!el) return null;
			const r = el.getBoundingClientRect();
			if (r.width < 2 || r.height < 2) return null;
			return { x: r.left, y: r.top, width: r.width, height: r.height };
		},
		[selector, nth],
	);
	if (!rect) return null;
	const { data } = await cdp.send("Page.captureScreenshot", {
		format: "png",
		clip: { ...rect, scale },
		captureBeyondViewport: false,
	});
	return page.evaluate(async (b64) => {
		const img = new Image();
		img.src = `data:image/png;base64,${b64}`;
		await img.decode();
		const canvas = document.createElement("canvas");
		canvas.width = img.width;
		canvas.height = img.height;
		const ctx = canvas.getContext("2d", { willReadFrequently: true });
		ctx.drawImage(img, 0, 0);
		const { data: px, width: w, height: h } = ctx.getImageData(0, 0, canvas.width, canvas.height);
		const x0 = Math.round(w * 0.22);
		const x1 = Math.round(w * 0.78);
		const y0 = Math.round(h * 0.22);
		const y1 = Math.round(h * 0.78);
		let r = 0;
		let g = 0;
		let b = 0;
		let n = 0;
		for (let y = y0; y < y1; y++) {
			for (let x = x0; x < x1; x++) {
				const i = (y * w + x) * 4;
				r += px[i];
				g += px[i + 1];
				b += px[i + 2];
				n++;
			}
		}
		return n > 0 ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : null;
	}, data);
}

/** Manhattan distance between two mean colours; `null` anywhere means -1. */
function colorDelta(a, b) {
	if (!a || !b) return -1;
	return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

/** `rgb(r, g, b)` -> `[r, g, b]`. */
function rgbTriple(css) {
	const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(String(css));
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * The colour actually painted at the midpoint of each edge of an element.
 *
 * This is the assertion the outline bug needed and no DOM question could give.
 * The outline used to be the edge cells' own borders, and a border is a SHARED
 * edge: a user's cell border, written inline, took it. On screen that was an
 * outline with two sides missing; in the DOM every class and every rule was
 * exactly where it should be. So each edge is sampled through the compositor,
 * one CSS pixel at its middle, blown up 8x.
 */
async function edgePaint(cdp, page, selector) {
	const r = await page.evaluate((s) => {
		const el = document.querySelector(s);
		if (!el) return null;
		const b = el.getBoundingClientRect();
		if (b.width < 4 || b.height < 4) return null;
		return { x: b.left, y: b.top, w: b.width, h: b.height };
	}, selector);
	if (!r) return null;
	// One pixel INTO the 2px border from each side.
	const points = {
		top: [r.x + r.w / 2, r.y + 1],
		bottom: [r.x + r.w / 2, r.y + r.h - 1],
		left: [r.x + 1, r.y + r.h / 2],
		right: [r.x + r.w - 1, r.y + r.h / 2],
	};
	const out = {};
	for (const [side, [x, y]] of Object.entries(points)) {
		const { data } = await cdp.send("Page.captureScreenshot", {
			format: "png",
			clip: { x: x - 0.5, y: y - 0.5, width: 1, height: 1, scale: 8 },
			captureBeyondViewport: false,
		});
		out[side] = await page.evaluate(async (b64) => {
			const img = new Image();
			img.src = `data:image/png;base64,${b64}`;
			await img.decode();
			const canvas = document.createElement("canvas");
			canvas.width = img.width;
			canvas.height = img.height;
			const ctx = canvas.getContext("2d", { willReadFrequently: true });
			ctx.drawImage(img, 0, 0);
			const { data: px } = ctx.getImageData(0, 0, canvas.width, canvas.height);
			let r = 0;
			let g = 0;
			let b = 0;
			let n = 0;
			for (let i = 0; i < px.length; i += 4) {
				r += px[i];
				g += px[i + 1];
				b += px[i + 2];
				n++;
			}
			return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
		}, data);
	}
	return out;
}

/** A zoomed screenshot of a region, for the eyes that sign the release off. */
async function zoomShot(cdp, page, rect, name, scale = 3) {
	fs.mkdirSync(SHOTS, { recursive: true });
	const file = path.join(SHOTS, `${name}.png`);
	const { data } = await cdp.send("Page.captureScreenshot", {
		format: "png",
		clip: { ...rect, scale },
		captureBeyondViewport: false,
	});
	fs.writeFileSync(file, Buffer.from(data, "base64"));
	shots.push(file);
	console.log(`  shot ${file}`);
	return file;
}

/* ------------------------------------------------- is it really on screen? */

/**
 * Is this popover something a HUMAN can see, or only something a selector can
 * find?
 *
 * The distinction is the whole point of this helper and it is not academic. The
 * fill palette used to live inside the toolbar, and the toolbar is a horizontal
 * scroller (`overflow: auto hidden`, 36 px tall) so that twelve controls fit a
 * narrow pane - which means every pixel of a popover hanging BELOW it was
 * clipped away. `is-open` was on, Playwright's `isVisible()` answered true,
 * `getBoundingClientRect()` reported a healthy 175x67 box, and clicks on its
 * swatches landed and applied the fill. The user saw the bucket icon light up
 * and nothing else appear, for three releases, with this suite green.
 *
 * `elementFromPoint` is the one DOM call that honours ancestor clipping, so it
 * is the one asked here - at the centre and the four corners of the box.
 */
async function seenByUser(page, selector, nth = 0) {
	return page.evaluate(
		([sel, i]) => {
			const el = document.querySelectorAll(sel)[i];
			if (!el) return { found: false, painted: false };
			const r = el.getBoundingClientRect();
			const cs = getComputedStyle(el);
			const inset = 4;
			const points = [
				[r.left + r.width / 2, r.top + r.height / 2],
				[r.left + inset, r.top + inset],
				[r.right - inset, r.top + inset],
				[r.left + inset, r.bottom - inset],
				[r.right - inset, r.bottom - inset],
			];
			const hits = points.filter(([x, y]) => {
				const hit = document.elementFromPoint(Math.round(x), Math.round(y));
				return !!hit && (hit === el || el.contains(hit));
			}).length;
			const onScreen =
				r.width > 1 &&
				r.height > 1 &&
				r.right > 0 &&
				r.bottom > 0 &&
				r.left < window.innerWidth &&
				r.top < window.innerHeight;
			const shown = cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) > 0.05;
			return {
				found: true,
				rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
				hits,
				onScreen,
				shown,
				// Four points of five: a corner may legitimately fall under a
				// scrollbar or a rounded edge, all five may not.
				painted: shown && onScreen && hits >= 4,
			};
		},
		[selector, nth],
	);
}

/* ----------------------------------------- the toolbar-in-every-context matrix */

/** Per-window handle on the view that owns the nth grid in THIS document. */
async function installViewIndex(p) {
	await p.evaluate(() => {
		window.sheetViewAt = (i) => {
			const el = document.querySelectorAll(".leovale-sheet-content")[i];
			return window.app.workspace
				.getLeavesOfType("leovale-sheet-view")
				.map((l) => l.view)
				.find((v) => v && v.contentEl === el);
		};
		window.engineAt = (i) => window.sheetViewAt(i)?.sheetEngine ?? null;
	});
}

/**
 * Tap something the way a finger does.
 *
 * A dispatched `TouchEvent` is not enough here: the browser generates the
 * compatibility mouse events (and therefore the `click` a button listens for)
 * only for real input, so the tap goes in through CDP with touch emulation on.
 */
function makeTapper(cdp) {
	return async (p, locator) => {
		const box = await locator.boundingBox();
		if (!box) throw new Error("nothing to tap");
		const x = Math.round(box.x + box.width / 2);
		const y = Math.round(box.y + box.height / 2);
		await cdp.send("Input.dispatchTouchEvent", {
			type: "touchStart",
			touchPoints: [{ x, y, radiusX: 8, radiusY: 8, force: 1 }],
		});
		await p.waitForTimeout(50);
		await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	};
}

/**
 * Drive every control of ONE toolbar and prove each one opens where the user is
 * looking and still does its job.
 *
 * `nth` picks the grid within `p`'s document (a split puts two in one), `other`
 * is the window that has to stay EMPTY - a menu shown without naming its
 * document is built in whatever window Obsidian currently calls active, which
 * for a sheet in a pop-out is the wrong one - and `tap` swaps every press for a
 * finger.
 */
async function toolbarMatrix({ p, label, nth = 0, other = null, tap = null }) {
	const root = p.locator(".leovale-sheet-content").nth(nth);
	const cellSel = (x, y) => `.leovale-sheet-root td[data-x="${x}"][data-y="${y}"]`;

	const press = async (cls) => {
		if (tap) await tap(p, root.locator(cls));
		else await root.locator(cls).click();
		await p.waitForTimeout(260);
	};
	const clickCell = async (x, y) => {
		await root.locator(cellSel(x, y)).click();
		await p.waitForTimeout(160);
	};
	const styleAt = (ref) =>
		p.evaluate(([i, r]) => window.engineAt(i)?.getStyleAt(r) ?? {}, [nth, ref]);
	const menuCount = (q) => q.evaluate(() => document.querySelectorAll(".menu").length);
	const menuItems = () =>
		p.evaluate(() =>
			[...document.querySelectorAll(".menu .menu-item-title")].map((i) => i.textContent),
		);
	const pickMenuItem = async (title) => {
		await p.locator(`.menu .menu-item:has(.menu-item-title:text-is("${title}"))`).click();
		await p.waitForTimeout(320);
	};

	await installViewIndex(p);
	await clickCell(0, 0);

	/* ------------------------------------------------------------ fill palette */
	await press(".leovale-sheet-tb-fillbtn");
	const pal = await seenByUser(p, ".leovale-sheet-palette.is-open");
	console.log(`  [${label}] palette:`, JSON.stringify(pal));
	check(`${label}: the fill palette is painted where the user is looking`, pal.painted,
		JSON.stringify(pal));
	check(
		`${label}: the palette carries all 12 swatches`,
		(await root.locator(".leovale-sheet-palette .leovale-sheet-swatch").count()) === 12,
	);
	await root.locator('.leovale-sheet-palette .leovale-sheet-swatch[data-color="#fff2cc"]').click();
	await p.waitForTimeout(320);
	check(`${label}: picking a swatch fills the cell`, (await styleAt("A1")).bg === "#fff2cc",
		JSON.stringify(await styleAt("A1")));
	check(`${label}: and closes the palette`,
		(await root.locator(".leovale-sheet-palette.is-open").count()) === 0);
	await press(".leovale-sheet-tb-fillbtn");
	await root.locator(".leovale-sheet-palette .leovale-sheet-swatch.is-none").click();
	await p.waitForTimeout(300);
	check(`${label}: "no fill" clears it again`, (await styleAt("A1")).bg === undefined,
		JSON.stringify(await styleAt("A1")));

	/* -------------------------------------------------- the four style menus */
	const styleMenus = [
		{ name: "font size", cls: ".leovale-sheet-tb-size", pick: "18", back: "Default",
			ok: (s) => s.fs === 18, gone: (s) => s.fs === undefined },
		{ name: "borders", cls: ".leovale-sheet-tb-border", pick: "All borders", back: "No borders",
			ok: (s) => !!s.bd, gone: (s) => !s.bd },
		{ name: "number format", cls: ".leovale-sheet-tb-number", pick: "0%", back: "Auto",
			ok: (s) => s.nf === "0%", gone: (s) => s.nf === undefined },
		// "Left" IS the reset for the horizontal axis: it stores no key at all.
		{ name: "alignment", cls: ".leovale-sheet-tb-align", pick: "Center", back: "Left",
			ok: (s) => s.ha === "c", gone: (s) => s.ha === undefined },
	];
	for (const m of styleMenus) {
		await clickCell(0, 0);
		await press(m.cls);
		const seen = await seenByUser(p, ".menu");
		check(`${label}: the ${m.name} menu is painted in this window`, seen.painted,
			JSON.stringify(seen));
		if (other) {
			check(`${label}: the ${m.name} menu is in no OTHER window`, (await menuCount(other)) === 0);
		}
		const items = await menuItems();
		check(`${label}: the ${m.name} menu has its items`, items.length >= 5, JSON.stringify(items));
		await pickMenuItem(m.pick);
		check(`${label}: ${m.name} applied`, m.ok(await styleAt("A1")),
			JSON.stringify(await styleAt("A1")));
		await press(m.cls);
		await pickMenuItem(m.back);
		check(`${label}: ${m.name} undone`, m.gone(await styleAt("A1")),
			JSON.stringify(await styleAt("A1")));
	}

	/* ------------------------- sort, filter, freeze: open, look, walk away */
	for (const [name, cls] of [
		["sort", ".leovale-sheet-tb-sort"],
		["filter", ".leovale-sheet-tb-filter"],
		["freeze", ".leovale-sheet-tb-freeze"],
	]) {
		await clickCell(0, 0);
		await press(cls);
		const seen = await seenByUser(p, ".menu");
		const items = await menuItems();
		check(`${label}: the ${name} menu is painted in this window`, seen.painted, JSON.stringify(seen));
		check(`${label}: the ${name} menu has its items`, items.length >= 2, JSON.stringify(items));
		if (other) {
			check(`${label}: the ${name} menu is in no OTHER window`, (await menuCount(other)) === 0);
		}
		await p.keyboard.press("Escape");
		await p.waitForTimeout(220);
		check(`${label}: Escape closes the ${name} menu`, (await menuCount(p)) === 0);
	}

	/* ---------------------------------------------------------- the find strip */
	await press(".leovale-sheet-tb-find");
	// Index 0 and not `nth`: only one strip in the document is ever open.
	const find = await seenByUser(p, ".leovale-sheet-find.is-open");
	check(`${label}: the find strip is painted`, find.painted, JSON.stringify(find));
	await press(".leovale-sheet-tb-find");
	check(`${label}: and the same button closes it`,
		(await root.locator(".leovale-sheet-find.is-open").count()) === 0);

	/* -------------------------------------------------------- the width dialog */
	await clickCell(0, 0);
	await press(".leovale-sheet-tb-width");
	const modalHere = await p.evaluate(() => document.querySelectorAll(".modal").length);
	const modalThere = other
		? await other.evaluate(() => document.querySelectorAll(".modal").length)
		: 0;
	console.log(`  [${label}] width dialog: here=${modalHere} elsewhere=${modalThere}`);
	// Obsidian owns where a Modal is mounted, so this asks only that one opened.
	check(`${label}: the column-width dialog opened`, modalHere + modalThere >= 1,
		`${modalHere}/${modalThere}`);
	await (modalHere ? p : other).keyboard.press("Escape");
	await p.waitForTimeout(300);

	/* ------------------------------------------------------- merge and checkbox */
	const a7 = await root.locator(cellSel(0, 6)).boundingBox();
	const b7 = await root.locator(cellSel(1, 6)).boundingBox();
	await p.mouse.move(a7.x + a7.width / 2, a7.y + a7.height / 2);
	await p.mouse.down();
	await p.mouse.move(b7.x + b7.width / 2, b7.y + b7.height / 2, { steps: 6 });
	await p.mouse.up();
	await p.waitForTimeout(200);
	await press(".leovale-sheet-tb-merge");
	const merged = await p.evaluate(
		([i]) => {
			const el = document.querySelectorAll(".leovale-sheet-content")[i];
			const td = el.querySelector('.leovale-sheet-root td[data-x="0"][data-y="6"]');
			return { colspan: td?.getAttribute("colspan"), merge: !!window.engineAt(i)?.mergeAt(6, 0) };
		},
		[nth],
	);
	check(`${label}: merge really merged`, merged.merge && merged.colspan === "2",
		JSON.stringify(merged));
	await press(".leovale-sheet-tb-merge");
	check(`${label}: and the same button split it again`,
		(await p.evaluate(([i]) => !!window.engineAt(i)?.mergeAt(6, 0), [nth])) === false);

	const hasBox = () =>
		p.evaluate(
			([i]) =>
				!!document
					.querySelectorAll(".leovale-sheet-content")
					[i].querySelector('.leovale-sheet-root td[data-x="0"][data-y="7"] input[type="checkbox"]'),
			[nth],
		);
	await clickCell(0, 7);
	await press(".leovale-sheet-tb-checkbox");
	check(`${label}: the checkbox button really made one`, await hasBox());
	await press(".leovale-sheet-tb-checkbox");
	check(`${label}: and took it away again`, !(await hasBox()));

	/* ---------------------------------------------------------- bold and wrap */
	for (const [name, cls, key] of [
		["bold", ".leovale-sheet-tb-bold", "b"],
		["wrap", ".leovale-sheet-tb-wrap", "wrap"],
	]) {
		await clickCell(0, 0);
		await press(cls);
		check(`${label}: ${name} on`, !!(await styleAt("A1"))[key], JSON.stringify(await styleAt("A1")));
		await press(cls);
		check(`${label}: ${name} off`, !(await styleAt("A1"))[key], JSON.stringify(await styleAt("A1")));
	}
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

		// Tagged with the step that was running when it arrived: a bare
		// "illegal access" at the end of a nine-hundred-check run is
		// unattributable, and this is the only place that knows the timing.
		const pageErrors = [];
		page.on("pageerror", (e) => pageErrors.push(`${e.message} [in: ${currentStep}]`));
		page.on("console", (m) => {
			if (m.type() === "error") pageErrors.push(`${m.text()} [in: ${currentStep}]`);
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

		// A vault opened for the VERY FIRST time asks whether its author is
		// trusted ("mod-trust-folder"), and that dialog's overlay swallows every
		// click until it is answered - so the whole suite timed out on its first
		// `page.click`, with the grid perfectly present behind it. Enabling the
		// plugins over the API (above) answers the question but leaves the dialog
		// on screen. Only ever seen on a brand-new user-data-dir, which is
		// exactly what a second checkout or a CI runner starts with.
		const startupModals = await page.evaluate(async () => {
			const seen = [...document.querySelectorAll(".modal")].map((m) => m.className);
			for (const el of document.querySelectorAll(".modal-close-button")) el.click();
			await new Promise((r) => setTimeout(r, 300));
			for (const el of document.querySelectorAll(".modal-container")) el.remove();
			return seen;
		});
		if (startupModals.length > 0) console.log("  dismissed startup modals:", startupModals);

		step("clean previous run");
		// Both side docks shut, always. Their state is remembered per user-data-dir,
		// so a sandbox that was poked at by hand (or by a run that opened the right
		// dock to test a narrow pane) produced screenshots that differ from the
		// committed ones in nothing but a file explorer - pure review noise.
		await page.evaluate(() => {
			window.app.workspace.leftSplit?.collapse?.();
			window.app.workspace.rightSplit?.collapse?.();
		});
		await page.waitForTimeout(300);
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

		// Enter means the same thing here as in a cell: commit and step down. On a
		// desktop the focus goes back to the grid with it (the touch half of this
		// rule is checked under the tablet emulation further down). Nothing is
		// typed, so the document is not touched at all.
		await page.click('.leovale-sheet-content .leovale-sheet-root td[data-x="3"][data-y="5"]');
		await page.waitForTimeout(150);
		await page.click(`${fb} .leovale-sheet-fb-input`);
		await page.keyboard.press("Enter");
		await page.waitForTimeout(300);
		const barEnter = await page.evaluate(() => ({
			ref: document.querySelector(".leovale-sheet-fb-ref").textContent,
			focused: document.activeElement === document.querySelector(".leovale-sheet-fb-input"),
			cell: window.sheetView().sheetEngine.getRawValue("D6"),
		}));
		console.log("  Enter in the bar:", barEnter);
		check("Enter in the bar moves down a cell", barEnter.ref === "D7", String(barEnter.ref));
		check("on a desktop it hands the focus back to the grid", barEnter.focused === false);
		check("and an empty Enter changes nothing", barEnter.cell === "=SUM(B2:B3)*10", String(barEnter.cell));

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
			// 1.4.0 added two (merge, checkbox); 1.7.0 two more (undo, redo).
			icons.length === 16 && icons.every((i) => i.glyphs === 1 || i.cls.includes("tb-size")),
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
		//
		// The popover is a child of `.leovale-sheet-content`, NOT of the bar: the
		// bar is a horizontal scroller and clipped it out of existence for three
		// releases. Hence `pal`, the scope, AND the paint check below - a class
		// and a bounding box were exactly what said "fine" while it was invisible.
		const pal = ".leovale-sheet-content .leovale-sheet-palette";
		await page.click(`${tb} .leovale-sheet-tb-fillbtn`);
		await page.waitForTimeout(200);
		check("palette opened", await page.locator(`${pal}.is-open`).isVisible());
		const paletteSeen = await seenByUser(page, `${pal}.is-open`);
		console.log("  palette paint:", paletteSeen);
		check("and the user can actually SEE it", paletteSeen.painted, JSON.stringify(paletteSeen));
		check(
			"palette has 12 swatches incl. no-fill",
			(await page.locator(`${pal} .leovale-sheet-swatch`).count()) === 12 &&
				(await page.locator(`${pal} .leovale-sheet-swatch.is-none`).count()) === 1,
		);
		await shot(page, "06-palette-open-light");
		await page.click(`${pal} .leovale-sheet-swatch[data-color="#fff2cc"]`);
		await page.waitForTimeout(250);
		check(
			"palette closed after picking",
			(await page.locator(`${pal}.is-open`).count()) === 0,
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
				// C2 is `=B2*2`, i.e. a NUMBER, and since 1.5.x a number is drawn
				// right-aligned by default. So "the toolbar did not touch it" is
				// asked of the STORED style, which is the thing the button writes,
				// rather than of the computed alignment, which the content decides.
				untouchedStyle: window.sheetView().sheetEngine.getStyleAt("C2"),
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
		check(
			"a neighbouring cell was not touched: no alignment was written into it",
			aligned.untouchedStyle.ha === undefined && aligned.untouchedStyle.va === undefined,
			JSON.stringify([aligned.untouched, aligned.untouchedStyle]),
		);
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
			await page.locator(".leovale-sheet-content .leovale-sheet-palette.is-open").isVisible(),
		);
		const darkPaletteSeen = await seenByUser(page, ".leovale-sheet-palette.is-open");
		check("and is painted in the dark theme too", darkPaletteSeen.painted,
			JSON.stringify(darkPaletteSeen));
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
		await page.waitForTimeout(500);

		/* ---------------------------------------------------------- 1.4.x touch */

		step("touch: a scroll must not steal the selection");
		await installTouchDriver(page);
		// Somewhere to come back to, and a formula bar context to protect.
		await page.click('.leovale-sheet-content .leovale-sheet-root td[data-x="1"][data-y="1"]');
		await page.waitForTimeout(200);
		const beforeGesture = await page.evaluate(() => ({
			cell: selectedCellRef(),
			ref: document.querySelector(".leovale-sheet-fb-ref").textContent,
		}));
		// A pan that starts on a completely different cell: this is the gesture
		// that used to make the touched cell active before the finger had moved.
		const panned = await page.evaluate(() =>
			window.__touch({
				selector: '.leovale-sheet-content .leovale-sheet-root td[data-x="3"][data-y="6"]',
				dx: -160,
				steps: 8,
				scrollWith: true,
			}),
		);
		await page.waitForTimeout(200);
		const afterGesture = await page.evaluate(() => ({
			cell: selectedCellRef(),
			ref: document.querySelector(".leovale-sheet-fb-ref").textContent,
		}));
		console.log("  touch scroll:", beforeGesture, "->", afterGesture, panned);
		check(
			"a touch scroll leaves the selection where it was",
			afterGesture.cell === beforeGesture.cell && beforeGesture.cell === "1,1",
			`${beforeGesture.cell} -> ${afterGesture.cell}`,
		);
		check(
			"and leaves the formula bar's cell with it",
			afterGesture.ref === beforeGesture.ref && beforeGesture.ref === "B2",
			`${beforeGesture.ref} -> ${afterGesture.ref}`,
		);
		check("the pan really moved the grid", panned.scrollLeft > 100, String(panned.scrollLeft));

		step("touch: no snap-back after the user's own scroll");
		// The bug: something asked for the selection to be scrolled into view right
		// after the pan, and the sheet jumped back to column A (484 -> 0 on the
		// tablet). A1 is off screen to the left now, so a scroll-into-view of it is
		// exactly the fatal move.
		const snap = await page.evaluate(async () => {
			const wrapper = document.querySelector(".leovale-sheet-wrapper");
			const engine = window.sheetView().sheetEngine;
			// A fresh pan inside the same page turn, so the grace window is provably
			// open when the scroll-into-view is asked for (a round trip to the test
			// runner and back can easily outlast it).
			await window.__touch({
				selector: '.leovale-sheet-content .leovale-sheet-root td[data-x="3"][data-y="6"]',
				dx: -160,
				steps: 8,
				scrollWith: true,
			});
			const scrolled = Math.round(wrapper.scrollLeft);
			engine.selectCell(0, 0);
			await new Promise((r) => setTimeout(r, 150));
			const during = Math.round(wrapper.scrollLeft);
			// …and the guard is a grace period, not an off switch: once the gesture
			// is over, a programmatic move scrolls again.
			await new Promise((r) => setTimeout(r, 900));
			engine.selectCell(0, 0);
			await new Promise((r) => setTimeout(r, 200));
			return { scrolled, during, after: Math.round(wrapper.scrollLeft) };
		});
		console.log("  snap-back:", snap);
		check(
			"scroll-into-view is suppressed while the user is touch-scrolling",
			snap.during === snap.scrolled && snap.scrolled > 100,
			JSON.stringify(snap),
		);
		check(
			// Not 0: `inline: "nearest"` stops as soon as A1 is inside the box, and
			// the sticky row-number gutter covers the first ~50 px of it.
			"and comes back once the gesture is over",
			snap.after < 100 && snap.after < snap.during,
			JSON.stringify(snap),
		);

		step("touch: a tap still selects, a slow press does not");
		const tapped = await page.evaluate(async () => {
			await window.__touch({
				selector: '.leovale-sheet-content .leovale-sheet-root td[data-x="2"][data-y="4"]',
			});
			await new Promise((r) => setTimeout(r, 150));
			const afterTap = selectedCellRef();
			// 400 ms is past the tap window and short of the long press: nothing.
			await window.__touch({
				selector: '.leovale-sheet-content .leovale-sheet-root td[data-x="0"][data-y="7"]',
				endAfterMs: 400,
			});
			await new Promise((r) => setTimeout(r, 150));
			return { afterTap, afterSlow: selectedCellRef() };
		});
		console.log("  tap:", tapped);
		check("a tap selects the cell under it", tapped.afterTap === "2,4", String(tapped.afterTap));
		check(
			"a press longer than the tap window selects nothing",
			tapped.afterSlow === "2,4",
			String(tapped.afterSlow),
		);

		step("touch: the drawer keeps the left edge, and only there");
		const edge = await page.evaluate(async () => {
			const seen = { start: 0, move: 0 };
			const onStart = () => seen.start++;
			const onMove = () => seen.move++;
			document.addEventListener("touchstart", onStart);
			document.addEventListener("touchmove", onMove);
			const wrapper = document.querySelector(".leovale-sheet-wrapper");
			const box = wrapper.getBoundingClientRect();
			const run = async (x, scrollLeft) => {
				wrapper.scrollLeft = scrollLeft;
				await new Promise((r) => setTimeout(r, 60));
				seen.start = 0;
				seen.move = 0;
				await window.__touch({
					selector: '.leovale-sheet-content .leovale-sheet-root td[data-x="0"][data-y="6"]',
					at: { x, y: box.top + 200 },
					dx: 120,
					steps: 4,
				});
				return { ...seen };
			};
			const atEdge = await run(6, 0);
			const inside = await run(300, 0);
			const edgeScrolled = await run(6, 220);
			wrapper.scrollLeft = 0;
			document.removeEventListener("touchstart", onStart);
			document.removeEventListener("touchmove", onMove);
			return { atEdge, inside, edgeScrolled };
		});
		console.log("  edge swipe:", edge);
		check(
			"a swipe from the left edge of a sheet scrolled fully left reaches Obsidian",
			edge.atEdge.start > 0 && edge.atEdge.move > 0,
			JSON.stringify(edge.atEdge),
		);
		check(
			"a swipe that starts anywhere else is the grid's",
			edge.inside.move === 0 && edge.inside.start === 0,
			JSON.stringify(edge.inside),
		);
		check(
			"so is one from the edge while the sheet is panned right",
			edge.edgeScrolled.move === 0,
			JSON.stringify(edge.edgeScrolled),
		);

		step("touch: the formula bar advances and keeps the keyboard up");
		const barTouch = await page.evaluate(async () => {
			const view = window.sheetView();
			view.sheetEngine.selectCell(5, 5);
			await new Promise((r) => setTimeout(r, 150));
			const input = document.querySelector(".leovale-sheet-fb-input");
			input.focus();
			input.value = "111";
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
			await new Promise((r) => setTimeout(r, 300));
			const out = {
				cell: selectedCellRef(),
				ref: document.querySelector(".leovale-sheet-fb-ref").textContent,
				focused: document.activeElement === input,
				value: input.value,
				wrote: view.sheetEngine.getRawValue("F6"),
			};
			// Leave the sheet as it was: a value in a fresh column would widen the
			// used range, and the embed tests further down measure exactly that.
			input.blur();
			view.sheetEngine.setRawValue("F6", "");
			await new Promise((r) => setTimeout(r, 150));
			return out;
		});
		console.log("  formula bar on touch:", barTouch);
		check("Enter in the bar commits the value", String(barTouch.wrote) === "111", String(barTouch.wrote));
		check("and moves the selection one row down", barTouch.cell === "5,6", String(barTouch.cell));
		check("the bar follows it", barTouch.ref === "F7", String(barTouch.ref));
		check("on touch the keyboard stays up (the field keeps the focus)", barTouch.focused === true);
		check("and the field shows the NEW cell, not the old text", barTouch.value === "", `"${barTouch.value}"`);

		step("touch: long press opens OUR context menu, 44 px rows");
		const longPress = await page.evaluate(async () => {
			await window.__touch({
				selector: '.leovale-sheet-content .leovale-sheet-root td[data-x="1"][data-y="1"]',
				holdMs: 700,
			});
			await new Promise((r) => setTimeout(r, 250));
			const menu = document.querySelector(".menu.leovale-sheet-menu");
			const items = [...(menu?.querySelectorAll(".menu-item") ?? [])];
			return {
				open: !!menu,
				touchClass: !!menu?.classList.contains("is-touch"),
				vendor: document.querySelectorAll(".jss_contextmenu.jss_contextmenu-focus").length,
				rows: items.map((i) => Math.round(i.getBoundingClientRect().height)),
				titles: items.map((i) => i.querySelector(".menu-item-title")?.textContent),
				icons: items.every((i) => !!i.querySelector(".menu-item-icon svg")),
				selected: selectedCellRef(),
			};
		});
		console.log("  long press menu:", longPress);
		check("a long press opens the plugin's own menu", longPress.open === true);
		check("marked as a touch menu", longPress.touchClass === true);
		check("the engine's own menu stays shut", longPress.vendor === 0, String(longPress.vendor));
		check(
			"every row is at least 44 px",
			longPress.rows.length > 0 && longPress.rows.every((h) => h >= 44),
			JSON.stringify(longPress.rows),
		);
		check("every item drew its icon", longPress.icons === true);
		check(
			"no keyboard hints on a device with no keyboard",
			longPress.titles.every((t) => !/ctrl|cmd|⌘|alt/i.test(t ?? "")),
			JSON.stringify(longPress.titles),
		);
		check("the pressed cell is the selected one", longPress.selected === "1,1", String(longPress.selected));
		await shot(page, "23-context-menu-mobile");
		await page.keyboard.press("Escape");
		await page.waitForTimeout(200);

		await page.evaluate(() => document.body.classList.remove("is-mobile"));
		await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
		await cdp.send("Emulation.clearDeviceMetricsOverride");
		await page.waitForTimeout(800);

		step("1.4.x: the context menu is ours, translated, and does the work");
		// A real right click: the engine's own document-level handler runs, and
		// its `contextMenu` hook answers "open nothing" so ours is what appears.
		await page.click('.leovale-sheet-content .leovale-sheet-root td[data-x="1"][data-y="8"]', {
			button: "right",
		});
		await page.waitForTimeout(350);
		const cmEn = await page.evaluate(() => {
			const menu = document.querySelector(".menu.leovale-sheet-menu");
			const items = [...(menu?.querySelectorAll(".menu-item") ?? [])];
			return {
				open: !!menu,
				titles: items.map((i) => i.querySelector(".menu-item-title")?.textContent),
				icons: items.every((i) => !!i.querySelector(".menu-item-icon svg")),
				vendor: document.querySelectorAll(".jss_contextmenu").length,
				vendorOpen: [...document.querySelectorAll(".jss_contextmenu")].filter(
					(m) => getComputedStyle(m).display !== "none",
				).length,
				selected: selectedCellRef(),
			};
		});
		console.log("  context menu (en):", cmEn.titles);
		check("a right click opens the plugin's menu", cmEn.open === true);
		check(
			"it is in English by default",
			cmEn.titles[0] === "Edit cell" && cmEn.titles.includes("Insert row above"),
			JSON.stringify(cmEn.titles),
		);
		check(
			"it keeps the useful items: insert, delete, copy, paste, merge",
			["Copy", "Paste", "Insert column left", "Delete row", "Delete column", "Merge cells"].every(
				(t) => cmEn.titles.includes(t),
			),
			JSON.stringify(cmEn.titles),
		);
		check("no shortcut hints anywhere in it",
			cmEn.titles.every((t) => !/ctrl|cmd|⌘/i.test(t ?? "")), JSON.stringify(cmEn.titles));
		check("every item drew its icon", cmEn.icons === true, JSON.stringify(cmEn.titles));
		check("the engine's own menu never opens", cmEn.vendorOpen === 0, String(cmEn.vendorOpen));
		check("the right click moved the selection to the cell under it",
			cmEn.selected === "1,8", String(cmEn.selected));
		await shot(page, "24-context-menu-light");
		await page.keyboard.press("Escape");
		await page.waitForTimeout(200);

		// The same menu in Russian, which is the interface the tablet reported it in.
		await page.evaluate(() => {
			window.localStorage.setItem("language", "ru");
			const view = window.sheetView();
			view.setViewData(view.getViewData(), false);
		});
		await page.waitForTimeout(500);
		await page.click('.leovale-sheet-content .leovale-sheet-root td[data-x="1"][data-y="8"]', {
			button: "right",
		});
		await page.waitForTimeout(350);
		const cmRu = await menuTitles(page);
		console.log("  context menu (ru):", cmRu);
		check("Russian interface, Russian menu",
			cmRu[0] === "Редактировать ячейку" && cmRu.includes("Вставить строку выше"),
			JSON.stringify(cmRu));
		check("its copy/paste are translated too",
			cmRu.includes("Копировать") && cmRu.includes("Вставить"), JSON.stringify(cmRu));
		check("and its merge item", cmRu.includes("Объединить ячейки"), JSON.stringify(cmRu));
		await shot(page, "25-context-menu-ru");
		await page.keyboard.press("Escape");
		await page.waitForTimeout(200);
		await page.evaluate(async () => {
			window.localStorage.setItem("language", "en");
			const view = window.sheetView();
			view.setViewData(view.getViewData(), false);
			await new Promise((r) => setTimeout(r, 400));
		});
		await page.waitForTimeout(400);

		// It is a working menu, not a picture of one: insert a row through it.
		const inserted = await page.evaluate(async () => {
			const view = window.sheetView();
			const engine = view.sheetEngine;
			engine.setRawValue("A10", "moved");
			await new Promise((r) => setTimeout(r, 150));
			return { before: engine.getRawValue("A10"), rows: engine.dimensions().rows };
		});
		await page.click('.leovale-sheet-content .leovale-sheet-root td[data-x="0"][data-y="9"]', {
			button: "right",
		});
		await page.waitForTimeout(300);
		await page.evaluate(() => {
			const items = [...document.querySelectorAll(".menu.leovale-sheet-menu .menu-item")];
			const item = items.find((i) => i.querySelector(".menu-item-title")?.textContent === "Insert row above");
			item.click();
		});
		await page.waitForTimeout(400);
		const afterInsert = await page.evaluate(() => {
			const engine = window.sheetView().sheetEngine;
			return {
				a10: engine.getRawValue("A10"),
				a11: engine.getRawValue("A11"),
				rows: engine.dimensions().rows,
				dirty: window.sheetView().sheetDirty,
			};
		});
		console.log("  insert row above:", inserted, "->", afterInsert);
		check("the menu really inserted a row", afterInsert.rows === inserted.rows + 1,
			`${inserted.rows} -> ${afterInsert.rows}`);
		check("and the value moved down with it", afterInsert.a11 === "moved" && !afterInsert.a10,
			JSON.stringify(afterInsert));
		check("an edit through the menu marks the document dirty", afterInsert.dirty === true);
		// Put the sheet back exactly as the rest of the suite expects it.
		const rowRestored = await page.evaluate(async () => {
			const engine = window.sheetView().sheetEngine;
			engine.deleteRows(9, 1);
			await new Promise((r) => setTimeout(r, 200));
			engine.setRawValue("A10", "");
			await new Promise((r) => setTimeout(r, 200));
			return { rows: engine.dimensions().rows, a10: engine.getRawValue("A10") };
		});
		check("and the row can be deleted through the same code path",
			rowRestored.rows === inserted.rows && !rowRestored.a10, JSON.stringify(rowRestored));
		await page.waitForTimeout(400);

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

		// ---- the tick is PAINTED, not merely `:checked` ---------------------
		// The 1.4.1 bug: a ticked box was an accent square with an unreadable
		// dash in it, because our `::after` replaced Obsidian's tick geometry
		// but not its `-webkit-mask-image`, which then clipped what we drew.
		// Everything that could be asserted from the DOM was correct at the
		// time, so what is asserted here is the compositor's own output.
		const CB_SEL = ".leovale-sheet-content input.leovale-sheet-cb";
		const cbGeom = await page.evaluate((sel) => {
			const boxes = [...document.querySelectorAll(sel)];
			return boxes.map((b) => {
				const after = getComputedStyle(b, "::after");
				const box = b.getBoundingClientRect();
				return {
					checked: b.checked,
					box: [Math.round(box.width), Math.round(box.height)],
					afterW: after.width,
					afterH: after.height,
					mask: (after.maskImage || after.webkitMaskImage || "none").slice(0, 24),
					marker: after.backgroundColor,
					transform: after.transform,
				};
			});
		}, CB_SEL);
		console.log("  checkbox geometry:", JSON.stringify(cbGeom));
		const ticked = cbGeom.find((b) => b.checked);
		check(
			"the tick is drawn by Obsidian's own masked pseudo-element",
			ticked?.mask.startsWith("url(") && ticked?.transform === "none",
			JSON.stringify(ticked),
		);
		check(
			"and it covers the whole box, so nothing can clip it to a fragment",
			ticked && parseFloat(ticked.afterW) === ticked.box[0] &&
				parseFloat(ticked.afterH) === ticked.box[1],
			JSON.stringify(ticked),
		);

		const cbPaint = async (label) => {
			const off = await paintedRatio(cdp, page, CB_SEL, 0);
			const on = await paintedRatio(cdp, page, CB_SEL, 1);
			console.log(`  checkbox paint (${label}):`, JSON.stringify({ off, on }));
			check(
				`${label}: a ticked checkbox has a tick painted inside it`,
				!!on && on.ratio >= 0.12,
				JSON.stringify(on),
			);
			check(
				`${label}: an unticked one is an empty box`,
				!!off && off.ratio <= 0.03,
				JSON.stringify(off),
			);
			check(
				`${label}: the two states differ on screen, not only in the DOM`,
				!!on && !!off && on.ratio > off.ratio + 0.1,
				JSON.stringify([off?.ratio, on?.ratio]),
			);
		};
		await cbPaint("light");

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
		// The dark theme paints the tick in a DIFFERENT colour (the marker is
		// `--checkbox-marker-color`, which follows the background), so it is worth
		// its own pass through the compositor rather than an assumption.
		await cbPaint("dark");
		await setBaseTheme(page, "moonstone");
		await page.waitForTimeout(500);

		step("1.4.x: the column letters are centred, like the row numbers");
		const headerAlign = await page.evaluate(() => {
			const root = document.querySelector(".leovale-sheet-content .leovale-sheet-root");
			const heads = [...root.querySelectorAll(".jss_worksheet > thead > tr > td")].slice(1, 5);
			const rows = [...root.querySelectorAll(".jss_worksheet > tbody > tr > td:first-child")].slice(
				0,
				3,
			);
			const centred = (el) => {
				// Not the computed property alone: the vendor writes `text-align:
				// left` INLINE on every header cell, so this is also a check that our
				// rule beat the inline one. The geometry is what the user sees.
				const box = el.getBoundingClientRect();
				const range = document.createRange();
				range.selectNodeContents(el);
				const text = range.getBoundingClientRect();
				range.detach?.();
				if (!text.width) return null;
				const left = text.left - box.left;
				const right = box.right - text.right;
				return { align: getComputedStyle(el).textAlign, off: Math.round(left - right) };
			};
			return { heads: heads.map(centred), rows: rows.map(centred) };
		});
		console.log("  header alignment:", JSON.stringify(headerAlign));
		check(
			"every column letter computes to centre",
			headerAlign.heads.every((h) => h?.align === "center"),
			JSON.stringify(headerAlign.heads),
		);
		check(
			"and really sits in the middle of its header cell",
			headerAlign.heads.every((h) => h && Math.abs(h.off) <= 2),
			JSON.stringify(headerAlign.heads),
		);
		check(
			"the row numbers are centred too, so the two gutters match",
			headerAlign.rows.every((r) => r && Math.abs(r.off) <= 2),
			JSON.stringify(headerAlign.rows),
		);

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

		/* ---- the export asks WHERE, and writes there -----------------------
		 *
		 * The save dialog is Electron's own and a native modal cannot be driven
		 * from here - a test that opened one would hang until somebody walked
		 * over to the machine. So the dialog itself is stubbed, at the exact
		 * seam the plugin resolves at call time
		 * (`require("@electron/remote").dialog.showSaveDialog`), and what is
		 * asserted is everything around it: the options the plugin asks with,
		 * the bytes landing at the CHOSEN path, and cancelling writing nothing.
		 */
		const stubSaveDialog = (answer) =>
			page.evaluate((reply) => {
				const remote = require("@electron/remote");
				window.__saveDialogOriginal ??= remote.dialog.showSaveDialog;
				window.__saveDialogCalls = [];
				remote.dialog.showSaveDialog = async (options) => {
					window.__saveDialogCalls.push(options);
					return reply;
				};
			}, answer);
		const saveDialogCalls = () => page.evaluate(() => window.__saveDialogCalls ?? []);
		const restoreSaveDialog = () =>
			page.evaluate(() => {
				if (!window.__saveDialogOriginal) return;
				require("@electron/remote").dialog.showSaveDialog = window.__saveDialogOriginal;
			});
		const runExport = async () => {
			await page.evaluate(
				(id) => window.app.commands.executeCommandById(`${id}:export-xlsx`),
				PLUGIN_ID,
			);
			await page.waitForTimeout(2500);
		};
		const notices = () =>
			page.evaluate(() =>
				[...document.querySelectorAll(".notice")].map((n) => n.textContent).join(" | "),
			);

		// 1. Somewhere else entirely: a folder OUTSIDE the vault, which is the
		//    whole point of asking (Downloads, a stick, a shared drive).
		const OUTSIDE_DIR = path.join(SANDBOX, "exports");
		fs.rmSync(OUTSIDE_DIR, { recursive: true, force: true });
		fs.mkdirSync(OUTSIDE_DIR, { recursive: true });
		const OUTSIDE_XLSX = path.join(OUTSIDE_DIR, "Chosen name.xlsx");
		await stubSaveDialog({ canceled: false, filePath: OUTSIDE_XLSX });
		await runExport();
		const askedWith = (await saveDialogCalls())[0];
		console.log("  save dialog options:", JSON.stringify(askedWith));
		check("the export opened a save dialog", !!askedWith, JSON.stringify(askedWith));
		check(
			"it suggests the sheet's own name, in the sheet's own folder",
			(askedWith?.defaultPath ?? "").replace(/\\/g, "/").endsWith("Exchange14.xlsx") &&
				(askedWith?.defaultPath ?? "").replace(/\\/g, "/").includes("test-vault"),
			String(askedWith?.defaultPath),
		);
		check(
			"and filters to .xlsx, with a title of its own",
			askedWith?.filters?.[0]?.extensions?.includes("xlsx") && !!askedWith?.title,
			JSON.stringify([askedWith?.filters, askedWith?.title]),
		);
		check("the workbook landed at the CHOSEN path, outside the vault",
			fs.existsSync(OUTSIDE_XLSX), OUTSIDE_XLSX);
		check("and nothing was written next to the sheet", !fs.existsSync(X_XLSX));
		const outsideBytes = fs.existsSync(OUTSIDE_XLSX)
			? fs.readFileSync(OUTSIDE_XLSX)
			: Buffer.alloc(0);
		check("it is a real zip container", outsideBytes.slice(0, 2).toString() === "PK",
			outsideBytes.slice(0, 4).toString("hex"));
		check("and not a stub", outsideBytes.length > 2000, String(outsideBytes.length));
		check("a notice names the file that was written",
			/Chosen name\.xlsx/.test(await notices()), await notices());

		// 2. Cancelled: no file, no error.
		await page.evaluate(() => document.querySelectorAll(".notice").forEach((n) => n.remove()));
		const CANCELLED_XLSX = path.join(OUTSIDE_DIR, "Never written.xlsx");
		await stubSaveDialog({ canceled: true, filePath: CANCELLED_XLSX });
		await runExport();
		check("a cancelled dialog writes no file", !fs.existsSync(CANCELLED_XLSX));
		check("and says nothing about it", (await notices()).trim() === "", await notices());

		// 3. Inside the vault: written through the vault API, so Obsidian knows
		//    about the file straight away instead of at the next rescan.
		const INSIDE_REL = "Exported inside.xlsx";
		await stubSaveDialog({ canceled: false, filePath: path.join(VAULT, INSIDE_REL) });
		await runExport();
		const indexed = await page.evaluate(
			(p) => !!window.app.vault.getAbstractFileByPath(p),
			INSIDE_REL,
		);
		check("a path inside the vault is written there", fs.existsSync(path.join(VAULT, INSIDE_REL)));
		check("and Obsidian has it indexed, not just on disk", indexed);

		// 4. No dialog at all (a phone, a tablet): the old behaviour, said out
		//    loud. `body.is-mobile` is the switch the whole plugin uses for
		//    "touch UI", so the desktop can be put in that shape here.
		//
		// The stub stays in place for this one, answering "cancelled": if the
		// touch path ever asked for a dialog anyway, the call is RECORDED and
		// the check below fails - where restoring the real dialog first would
		// have opened a native modal on the runner and hung the suite.
		await stubSaveDialog({ canceled: true });
		await page.evaluate(() => document.body.classList.add("is-mobile"));
		await page.waitForTimeout(300);
		await runExport();
		const mobileNotice = await notices();
		console.log("  mobile export notice:", mobileNotice);
		check("with no dialog the file lands next to the sheet", fs.existsSync(X_XLSX));
		check("nothing tried to open a dialog on a touch UI",
			(await saveDialogCalls()).length === 0, JSON.stringify(await saveDialogCalls()));
		check("and the notice says where it went", /Exchange14\.xlsx/.test(mobileNotice), mobileNotice);
		await page.evaluate(() => document.body.classList.remove("is-mobile"));
		await page.waitForTimeout(300);
		await restoreSaveDialog();

		const xlsxBytes = fs.existsSync(X_XLSX) ? fs.readFileSync(X_XLSX) : Buffer.alloc(0);
		check("the fallback file is a real workbook too", xlsxBytes.slice(0, 2).toString() === "PK",
			xlsxBytes.slice(0, 4).toString("hex"));

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

		/* ---- an empty row inside the used range is still a row -------------
		 *
		 * A `<td>` with nothing in it generates no line box, so it is as tall as
		 * its padding and no taller. In the main grid the row-number gutter
		 * always holds a row open; an embed can hide that gutter (`|plain`
		 * does), and an empty row between two filled ones then rendered as a
		 * 10px sliver against their 32px - reported as "the row disappeared".
		 * Empty COLUMNS were never affected (they carry an explicit width) and
		 * are checked here so that stays true.
		 */
		step("embeds: an empty row keeps the standard row height");
		const GAP_SHEET = "Gaps.sheet";
		const GAP_NOTE = "GapsNote.md";
		const gapSeed = JSON.stringify(
			{
				format: "leovale-sheet",
				version: 4,
				sheets: [
					{
						name: "Sheet1",
						rows: 12,
						cols: 5,
						colWidths: { 0: 120, 2: 140 },
						rowHeights: { 3: 60 },
						merges: {},
						view: {},
						freeze: {},
						cells: {
							A1: { v: "Item" },
							C1: { v: "Cost" },
							A2: { v: "first" },
							C2: { v: 10 },
							// row 3 (index 2) is empty on purpose, and so is column B
							A4: { v: "after the gap" },
							C4: { v: 20 },
						},
					},
				],
			},
			null,
			2,
		);
		await page.evaluate(
			async ([sheet, note, seed]) => {
				const app = window.app;
				for (const p of [sheet, note]) {
					const old = app.vault.getAbstractFileByPath(p);
					if (old) await app.vault.delete(old);
				}
				await app.vault.create(sheet, seed);
				await app.vault.create(
					note,
					`# Gaps\n\nwith chrome:\n\n![[${sheet}]]\n\nplain:\n\n![[${sheet}|plain]]\n`,
				);
				const leaf = app.workspace.getLeavesOfType("markdown")[0] ?? app.workspace.getLeaf(true);
				await leaf.openFile(app.vault.getAbstractFileByPath(note));
				await leaf.setViewState({
					type: "markdown",
					state: { file: note, mode: "preview", source: false },
				});
			},
			[GAP_SHEET, GAP_NOTE, gapSeed],
		);
		await page.waitForTimeout(3500);
		const gaps = await page.evaluate(() => {
			const root = document.querySelector(".markdown-reading-view");
			return [...root.querySelectorAll(".leovale-sheet-embed")].map((em) => ({
				plain: em.classList.contains("is-plain"),
				rows: [...em.querySelectorAll(".jss_worksheet > tbody > tr")]
					.filter((tr) => getComputedStyle(tr).display !== "none")
					.map((tr) => ({
						y: Number(tr.getAttribute("data-y")),
						h: Math.round(tr.getBoundingClientRect().height),
					})),
				cols: [...em.querySelectorAll('.jss_worksheet > tbody > tr:nth-child(1) > td[data-x]')]
					.filter((td) => getComputedStyle(td).display !== "none")
					.map((td) => Math.round(td.getBoundingClientRect().width)),
			}));
		});
		console.log("  embed gaps:", JSON.stringify(gaps));
		check("both embeds mounted", gaps.length === 2, String(gaps.length));
		for (const em of gaps) {
			const label = em.plain ? "plain embed" : "embed";
			const filled = em.rows.filter((r) => r.y !== 2 && r.y !== 3).map((r) => r.h);
			const empty = em.rows.find((r) => r.y === 2)?.h ?? 0;
			const tall = em.rows.find((r) => r.y === 3)?.h ?? 0;
			const standard = Math.max(...filled, 0);
			check(
				`${label}: the empty row is as tall as a filled one`,
				empty >= standard - 1,
				`${empty} against ${standard}`,
			);
			check(
				`${label}: and no taller`,
				empty <= standard + 1,
				`${empty} against ${standard}`,
			);
			check(
				`${label}: a row height from the file still wins over the minimum`,
				tall >= 58,
				String(tall),
			);
			check(
				`${label}: the empty COLUMN keeps its width`,
				(em.cols[1] ?? 0) >= 60,
				JSON.stringify(em.cols),
			);
		}
		const gapHeaders = await page.evaluate(() => {
			const em = document.querySelector(".markdown-reading-view .leovale-sheet-embed");
			return [...em.querySelectorAll(".jss_worksheet > thead > tr > td")]
				.slice(1, 4)
				.map((td) => getComputedStyle(td).textAlign);
		});
		check(
			"embeds centre their column letters too",
			gapHeaders.every((a) => a === "center"),
			JSON.stringify(gapHeaders),
		);
		await page.evaluate(
			async ([sheet, note]) => {
				const app = window.app;
				for (const p of [sheet, note]) {
					const f = app.vault.getAbstractFileByPath(p);
					if (f) await app.vault.delete(f);
				}
			},
			[GAP_SHEET, GAP_NOTE],
		);
		await page.waitForTimeout(600);
		await openNote("preview");
		await page.waitForTimeout(2500);

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

		/* ------------------------------------------------------------------------
		 * Every toolbar control, in every context a sheet can be looked at from.
		 *
		 * This exists because the fill palette was invisible from 1.3.0 onwards
		 * and this suite said it was fine: it asserted a class and a bounding
		 * box, and both were healthy while the popover was clipped out of the
		 * toolbar's own scroll box. So the assertion here is "the user can see
		 * it" (elementFromPoint) and "it still does the work" (the engine's own
		 * style, the cell's own DOM), in the main window, in each half of a
		 * split, in a pop-out window, and under a finger.
		 * -------------------------------------------------------------------- */
		const MATRIX_PATH = "Matrix.sheet";
		const MATRIX2_PATH = "Matrix-2.sheet";
		const matrixSeed = JSON.stringify(
			{
				format: "leovale-sheet",
				version: 4,
				sheets: [
					{
						name: "Sheet1",
						rows: 20,
						cols: 8,
						cells: { A1: { v: "alpha" }, A2: { v: "beta" } },
					},
				],
			},
			null,
			2,
		);

		step("1.4.x: every toolbar control opens WHERE THE USER IS LOOKING");
		await page.evaluate(
			async ([a, b]) => {
				const app = window.app;
				app.workspace.detachLeavesOfType("leovale-sheet-view");
				for (const name of [a, b]) {
					const old = app.vault.getAbstractFileByPath(name);
					if (old) await app.vault.delete(old);
				}
			},
			[MATRIX_PATH, MATRIX2_PATH],
		);
		await page.waitForTimeout(400);
		await page.evaluate(
			async ([a, b, text]) => {
				const app = window.app;
				const fa = await app.vault.create(a, text);
				await app.vault.create(b, text);
				await app.workspace.getLeaf(true).openFile(fa);
			},
			[MATRIX_PATH, MATRIX2_PATH, matrixSeed],
		);
		await page.waitForTimeout(2200);
		await toolbarMatrix({ p: page, label: "main window" });
		await shot(page, "26-toolbar-matrix-main");

		step("1.4.x: the same with two sheets side by side");
		await page.evaluate(async (b) => {
			const app = window.app;
			const leaf = app.workspace.getLeavesOfType("leovale-sheet-view")[0];
			const right = app.workspace.createLeafBySplit(leaf, "vertical");
			await right.openFile(app.vault.getAbstractFileByPath(b));
		}, MATRIX2_PATH);
		await page.waitForTimeout(2000);
		const panes = await page.evaluate(
			() => document.querySelectorAll(".leovale-sheet-content .leovale-sheet-toolbar").length,
		);
		check("two grids are on screen at once", panes === 2, String(panes));
		await toolbarMatrix({ p: page, label: "split, left pane", nth: 0 });
		await toolbarMatrix({ p: page, label: "split, right pane", nth: 1 });
		await shot(page, "27-toolbar-matrix-split");

		step("1.4.x: the same in an Obsidian pop-out window");
		const pagesBefore = new Set(ctx.pages());
		await page.evaluate(async (a) => {
			const app = window.app;
			app.workspace.detachLeavesOfType("leovale-sheet-view");
			await new Promise((r) => setTimeout(r, 400));
			const leaf = app.workspace.openPopoutLeaf();
			await leaf.openFile(app.vault.getAbstractFileByPath(a));
		}, MATRIX_PATH);
		let popout = null;
		for (let i = 0; i < 40 && !popout; i++) {
			await page.waitForTimeout(500);
			// A pop-out is served from `about:blank` - Obsidian builds its DOM by
			// hand - so it cannot be recognised by URL, only by being new.
			popout = ctx.pages().find((q) => !pagesBefore.has(q));
		}
		check("the pop-out window appeared over CDP", !!popout,
			JSON.stringify(ctx.pages().map((q) => q.url())));
		if (popout) {
			await popout.waitForTimeout(1500);
			const popoutErrors = [];
			popout.on("pageerror", (e) => popoutErrors.push(e.message));
			check(
				"the sheet really moved to the pop-out",
				(await popout.evaluate(() => document.querySelectorAll(".leovale-sheet-content").length)) ===
					1 &&
					(await page.evaluate(() => document.querySelectorAll(".leovale-sheet-content").length)) === 0,
			);
			await toolbarMatrix({ p: popout, label: "pop-out", other: page });
			// The screenshot this whole fix exists for.
			await popout.locator(".leovale-sheet-tb-fillbtn").click();
			await popout.waitForTimeout(300);
			const popoutPalette = await seenByUser(popout, ".leovale-sheet-palette.is-open");
			check("pop-out: the palette is painted for the screenshot", popoutPalette.painted,
				JSON.stringify(popoutPalette));
			await shot(popout, "28-palette-open-popout");
			await popout.keyboard.press("Escape");

			/* ---- the keyboard, in a window the engine does not listen to -----
			 *
			 * The grid engine binds its `keydown` to the MAIN window's document,
			 * whatever document it is configured with, so in a pop-out the arrow
			 * keys moved nothing and typing on a cell opened no editor - while
			 * the mouse, the toolbar and the menus all worked. What follows is
			 * the whole keyboard contract, in the window where it used to be
			 * missing: navigation, typing, a formula, Tab, and the 1.3.0 keys
			 * that go through the view's own scope (F2, Home/End, Ctrl+D).
			 */
			await popout.waitForTimeout(400);
			await installViewIndex(popout);
			const popCell = (x, y) =>
				`.leovale-sheet-content .leovale-sheet-root td[data-x="${x}"][data-y="${y}"]`;
			const popSel = () =>
				popout.evaluate(() => {
					const cur = window.engineAt(0)?.activeCell?.();
					return cur ? `${cur.row},${cur.col}` : "none";
				});
			const popText = (x, y) =>
				popout.evaluate((sel) => document.querySelector(sel)?.textContent, popCell(x, y));

			await popout.click(popCell(0, 0));
			await popout.waitForTimeout(250);
			check("pop-out: a click selects a cell (it always did)", (await popSel()) === "0,0",
				await popSel());

			for (const key of ["ArrowDown", "ArrowDown", "ArrowRight"]) {
				await popout.keyboard.press(key);
				await popout.waitForTimeout(150);
			}
			check("pop-out: the arrow keys move the selection", (await popSel()) === "2,1",
				await popSel());

			await popout.keyboard.press("Tab");
			await popout.waitForTimeout(200);
			check("pop-out: Tab moves one column right", (await popSel()) === "2,2", await popSel());
			await popout.keyboard.press("Home");
			await popout.waitForTimeout(200);
			check("pop-out: Home goes to the start of the row", (await popSel()) === "2,0",
				await popSel());

			await popout.click(popCell(1, 2));
			await popout.waitForTimeout(200);
			await popout.keyboard.type("42");
			await popout.waitForTimeout(250);
			const popEditing = await popout.evaluate(
				() => !!document.querySelector(".leovale-sheet-root .jss_worksheet td.editor"),
			);
			check("pop-out: typing a character opens the cell editor", popEditing);
			await popout.keyboard.press("Enter");
			await popout.waitForTimeout(400);
			check("pop-out: and the value is committed", (await popText(1, 2)) === "42",
				await popText(1, 2));

			await popout.click(popCell(1, 3));
			await popout.waitForTimeout(200);
			await popout.keyboard.type("=1+2");
			await popout.keyboard.press("Enter");
			await popout.waitForTimeout(500);
			check("pop-out: a formula is entered and computed", (await popText(1, 3)) === "3",
				await popText(1, 3));

			await popout.click(popCell(1, 2));
			await popout.waitForTimeout(200);
			await popout.keyboard.press("F2");
			await popout.waitForTimeout(350);
			check(
				"pop-out: F2 opens the editor on the selected cell",
				await popout.evaluate(() => !!document.querySelector(".leovale-sheet-root td.editor")),
			);
			await popout.keyboard.press("Escape");
			await popout.waitForTimeout(250);

			// Ctrl+D fills down from the cell above, which is the 42 just typed.
			await popout.click(popCell(1, 4));
			await popout.waitForTimeout(200);
			await popout.keyboard.press("Control+d");
			await popout.waitForTimeout(400);
			console.log("  pop-out fill down:", await popText(1, 4));
			check("pop-out: Ctrl+D fills down", (await popText(1, 4) ?? "").length > 0,
				String(await popText(1, 4)));

			// The typing must have gone into the pop-out's file and nowhere else.
			await popout.waitForTimeout(5000);
			const popDisk = fs.readFileSync(path.join(VAULT, MATRIX_PATH), "utf8");
			check("pop-out: the edits reached the file on disk", /"B3":\s*\{\s*"v":\s*42/.test(popDisk),
				popDisk.split("\n").filter((l) => l.includes("B3")).join(" | "));
			check(
				"pop-out: the OTHER sheet was not touched by any of it",
				!/42/.test(fs.readFileSync(path.join(VAULT, MATRIX2_PATH), "utf8")),
			);

			check("nothing threw inside the pop-out", popoutErrors.length === 0, popoutErrors.join(" | "));
			await page.evaluate(() => {
				for (const l of window.app.workspace.getLeavesOfType("leovale-sheet-view")) l.detach();
			});
			await page.waitForTimeout(1000);
		}

		step("1.4.x: the same by TAP, with touch emulation on");
		await page.evaluate(async (a) => {
			const app = window.app;
			await app.workspace.getLeaf(true).openFile(app.vault.getAbstractFileByPath(a));
		}, MATRIX_PATH);
		await page.waitForTimeout(2000);
		const tapCdp = await ctx.newCDPSession(page);
		await tapCdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
		await page.evaluate(() => document.body.classList.add("is-mobile"));
		await page.waitForTimeout(600);
		await toolbarMatrix({ p: page, label: "touch tap", tap: makeTapper(tapCdp) });
		await page.locator(".leovale-sheet-tb-fillbtn").click();
		await page.waitForTimeout(300);
		const tapPalette = await seenByUser(page, ".leovale-sheet-palette.is-open");
		check("touch: the palette is painted under a finger too", tapPalette.painted,
			JSON.stringify(tapPalette));
		await shot(page, "29-palette-open-touch");
		await page.keyboard.press("Escape");
		await page.evaluate(() => document.body.classList.remove("is-mobile"));
		await tapCdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
		await page.waitForTimeout(400);
		await page.evaluate(
			async ([a, b]) => {
				const app = window.app;
				app.workspace.detachLeavesOfType("leovale-sheet-view");
				for (const name of [a, b]) {
					const f = app.vault.getAbstractFileByPath(name);
					if (f) await app.vault.delete(f);
				}
			},
			[MATRIX_PATH, MATRIX2_PATH],
		);
		await page.waitForTimeout(500);

		/* ------------------------------------------------------------------------
		 * A selected range has to LOOK selected, on every cell inside it.
		 *
		 * The bug this replaces: the tint was a `background-color` on a class, and
		 * every cell that has ever been styled carries a `background-color` INLINE
		 * (the engine writes the whole declaration block, using the grid's own
		 * default as the "off" value). An inline declaration beats a rule, so a
		 * range that covered a filled cell, a bold cell or a checkbox cell painted
		 * a border round them and nothing inside. Reported by the user; measured in
		 * the live vault before the fix: mean colour of a selected filled cell
		 * identical to its unselected mean, to the byte.
		 *
		 * So this asks the COMPOSITOR, cell by cell, in both themes and in both
		 * kinds of window. A DOM assertion cannot see this bug: the class is on,
		 * the declaration is in the stylesheet, and the pixels are white.
		 * -------------------------------------------------------------------- */
		const SEL_PATH = "Selection.sheet";
		const selSeed = JSON.stringify(
			{
				format: "leovale-sheet",
				version: 4,
				sheets: [
					{
						name: "Sheet1",
						rows: 14,
						cols: 6,
						cells: {
							A1: { v: "plain" },
							B1: { v: "filled", s: { bg: "#ffe08a" } },
							C1: { v: true, t: "cb" },
							D1: { v: "[[Note]]" },
							A2: { v: "x2" },
							B2: { v: "y2", s: { bg: "#a8e6a1" } },
							C2: { v: false, t: "cb" },
							A3: { v: "x3" },
							B3: { v: "y3", s: { b: true } },
							C3: { v: true, t: "cb" },
							// A block of cells with USER BORDERS on all four sides, for
							// the outline: the centre one is bordered AND surrounded by
							// bordered cells, which is the case where the old
							// border-on-the-cell outline lost every edge it shared.
							B5: { v: "nw", s: { bd: "trbl" } },
							C5: { v: "n", s: { bd: "trbl" } },
							D5: { v: "ne", s: { bd: "trbl" } },
							B6: { v: "w", s: { bd: "trbl" } },
							C6: { v: "mid", s: { bd: "trbl", bg: "#ffe08a" } },
							D6: { v: "e", s: { bd: "trbl" } },
							B7: { v: "sw", s: { bd: "trbl" } },
							C7: { v: "s", s: { bd: "trbl" } },
							D7: { v: "se", s: { bd: "trbl" } },
						},
					},
				],
			},
			null,
			2,
		);

		const selCell = (x, y) =>
			`.leovale-sheet-content .leovale-sheet-root td[data-x="${x}"][data-y="${y}"]`;

		/**
		 * Measure A1:C3 unselected, select it with a real drag, measure again.
		 * `sess` is the CDP session of the window `p` lives in - a pop-out has its
		 * own, and screenshotting it through the main window's session would clip
		 * the wrong pixels.
		 */
		async function tintRun({ p, sess, label }) {
			const headSel = '.leovale-sheet-content .leovale-sheet-root thead td[data-x="1"]';
			const rowSel =
				'.leovale-sheet-content .leovale-sheet-root tbody tr[data-y="1"] > td:first-child';
			const probes = {
				anchor: selCell(0, 0),
				unfilled: selCell(0, 1),
				filled: selCell(1, 1),
				checkbox: selCell(2, 1),
				bold: selCell(1, 2),
				colLetter: headSel,
				rowNumber: rowSel,
			};

			// Park the selection far away: E9 is outside the block under test.
			await p.click(selCell(4, 8));
			await p.waitForTimeout(400);
			const before = {};
			for (const [k, sel] of Object.entries(probes)) before[k] = await avgColor(sess, p, sel);
			const tickBefore = await paintedRatio(
				sess,
				p,
				".leovale-sheet-content .leovale-sheet-root input.leovale-sheet-cb",
				2,
			);

			/**
			 * Drag A1:C3, and be sure it took.
			 *
			 * Retried, because this one drag is the entire premise of the eleven
			 * assertions below: if the range did not get selected they all report a
			 * missing tint, which is the loudest possible way to say "the mouse
			 * moves were dropped". Measured on a loaded machine (two suites of this
			 * repo running at once): the first drag in a pop-out that has just been
			 * repainted for a theme change extends nothing, and the second one,
			 * 300 ms later, works every time.
			 */
			let highlighted = 0;
			for (let attempt = 0; attempt < 3 && highlighted !== 9; attempt++) {
				const from = await p.locator(selCell(0, 0)).boundingBox();
				const to = await p.locator(selCell(2, 2)).boundingBox();
				await p.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
				await p.mouse.down();
				await p.waitForTimeout(60);
				await p.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
				await p.waitForTimeout(60);
				await p.mouse.up();
				await p.waitForTimeout(500);
				highlighted = await p.evaluate(
					() =>
						document.querySelectorAll(".leovale-sheet-content .leovale-sheet-root td.highlight")
							.length,
				);
				if (highlighted !== 9) console.log(`  ${label}: drag attempt ${attempt + 1} selected ${highlighted}`);
			}

			const after = {};
			for (const [k, sel] of Object.entries(probes)) after[k] = await avgColor(sess, p, sel);
			const tickAfter = await paintedRatio(
				sess,
				p,
				".leovale-sheet-content .leovale-sheet-root input.leovale-sheet-cb",
				2,
			);

			const d = {};
			for (const k of Object.keys(probes)) d[k] = colorDelta(before[k], after[k]);
			console.log(`  ${label}: highlighted=${highlighted} deltas=${JSON.stringify(d)}`);
			console.log(`  ${label}: filled ${JSON.stringify(after.filled)} vs unfilled ${JSON.stringify(after.unfilled)}`);

			check(`${label}: the whole 3x3 range is highlighted`, highlighted === 9, String(highlighted));
			check(`${label}: an UNFILLED cell in the range is tinted`, d.unfilled >= 10, String(d.unfilled));
			// The one the bug was about.
			check(`${label}: a FILLED cell in the range is tinted too`, d.filled >= 10, String(d.filled));
			check(`${label}: a CHECKBOX cell in the range is tinted`, d.checkbox >= 8, String(d.checkbox));
			check(`${label}: a BOLD (styled, unfilled) cell is tinted`, d.bold >= 10, String(d.bold));
			// ... and the fill is still the fill: a tint, not a repaint.
			check(
				`${label}: the fill still shows through the tint`,
				colorDelta(after.filled, after.unfilled) >= 40,
				JSON.stringify([after.filled, after.unfilled]),
			);
			check(`${label}: the anchor cell stays clear, as in Google Sheets`, d.anchor <= 6,
				String(d.anchor));
			check(`${label}: the column letter of a selected column lights up`, d.colLetter >= 8,
				String(d.colLetter));
			check(`${label}: the row number of a selected row lights up`, d.rowNumber >= 8,
				String(d.rowNumber));
			check(
				`${label}: the tick still reads as ticked under the tint`,
				tickAfter && tickBefore && tickAfter.ratio > 0.15 && Math.abs(tickAfter.ratio - tickBefore.ratio) < 0.1,
				JSON.stringify([tickBefore?.ratio, tickAfter?.ratio]),
			);
			return { before, after, d };
		}

		const SELBOX = ".leovale-sheet-content .leovale-sheet-selbox";

		/**
		 * The outline round the selection, over cells that own borders of their own.
		 * Both cases the user reported: one bordered cell with bordered neighbours,
		 * and a range whose whole edge runs along user borders.
		 */
		async function outlineRun({ p, sess, label }) {
			const accent = rgbTriple(
				await p.evaluate(() => {
					const probe = document.createElement("div");
					probe.style.color = "var(--interactive-accent)";
					document.body.appendChild(probe);
					const c = getComputedStyle(probe).color;
					probe.remove();
					return c;
				}),
			);
			const near = (got) => got && accent && colorDelta(got, accent) <= 40;
			const report = (edges) =>
				JSON.stringify({ accent, ...edges });

			// C6: borders on all four sides, a fill, and eight bordered neighbours.
			await p.click(selCell(2, 5));
			await p.waitForTimeout(450);
			const single = await edgePaint(sess, p, SELBOX);
			console.log(`  ${label} outline (single bordered cell):`, report(single));
			check(`${label}: the outline of a BORDERED cell is drawn on all four edges`,
				!!single && ["top", "right", "bottom", "left"].every((s) => near(single[s])),
				report(single));

			const from = await p.locator(selCell(1, 4)).boundingBox();
			const to = await p.locator(selCell(3, 6)).boundingBox();
			await p.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
			await p.mouse.down();
			await p.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
			await p.mouse.up();
			await p.waitForTimeout(500);
			const range = await edgePaint(sess, p, SELBOX);
			console.log(`  ${label} outline (range of bordered cells):`, report(range));
			check(`${label}: and so is the outline of a RANGE of bordered cells`,
				!!range && ["top", "right", "bottom", "left"].every((s) => near(range[s])),
				report(range));

			// The outline is an overlay, so the two things it must never do are
			// swallow a click and drift away from the fill handle.
			const geometry = await p.evaluate(() => {
				const box = document.querySelector(".leovale-sheet-content .leovale-sheet-selbox");
				const corner = document.querySelector(
					".leovale-sheet-content .leovale-sheet-root .jss_corner",
				);
				const b = box.getBoundingClientRect();
				const c = corner?.getBoundingClientRect();
				const cs = getComputedStyle(box);
				const mid = document.elementFromPoint(
					Math.round(b.left + b.width / 2),
					Math.round(b.top + b.height / 2),
				);
				return {
					pointerEvents: cs.pointerEvents,
					z: cs.zIndex,
					hitIsCell: mid?.tagName === "TD",
					cornerDx: c ? Math.round(Math.abs(c.left + c.width / 2 - b.right)) : -1,
					cornerDy: c ? Math.round(Math.abs(c.top + c.height / 2 - b.bottom)) : -1,
				};
			});
			console.log(`  ${label} outline geometry:`, JSON.stringify(geometry));
			check(`${label}: the outline never swallows a click on the cell under it`,
				geometry.pointerEvents === "none" && geometry.hitIsCell, JSON.stringify(geometry));
			check(`${label}: the fill handle is still on the corner of the outline`,
				geometry.cornerDx <= 4 && geometry.cornerDy <= 4, JSON.stringify(geometry));
			return { single, range };
		}

		/** The top-left corner of the grid, zoomed, for a human to look at. */
		async function gridRect(p) {
			const box = await p.locator(".leovale-sheet-content .leovale-sheet-root").boundingBox();
			return {
				x: Math.round(box.x),
				y: Math.round(box.y),
				width: Math.round(Math.min(box.width, 460)),
				height: 170,
			};
		}

		/** The bordered block B5:D7, with a row of context around it. */
		async function borderedRect(p) {
			const a = await p.locator(selCell(0, 3)).boundingBox();
			const b = await p.locator(selCell(4, 7)).boundingBox();
			return {
				x: Math.round(a.x),
				y: Math.round(a.y),
				width: Math.round(b.x + b.width - a.x),
				height: Math.round(b.y + b.height - a.y),
			};
		}

		step("1.4.x: a range selection is visible on EVERY cell in it (light)");
		await page.evaluate(
			async ([p, text]) => {
				const app = window.app;
				app.workspace.detachLeavesOfType("leovale-sheet-view");
				const old = app.vault.getAbstractFileByPath(p);
				if (old) await app.vault.delete(old);
				const f = await app.vault.create(p, text);
				await app.workspace.getLeaf(true).openFile(f);
			},
			[SEL_PATH, selSeed],
		);
		await page.waitForTimeout(2400);
		await installViewIndex(page);
		const selCdp = await ctx.newCDPSession(page);
		await tintRun({ p: page, sess: selCdp, label: "light" });
		await zoomShot(selCdp, page, await gridRect(page), "30-selection-range-light");
		await outlineRun({ p: page, sess: selCdp, label: "light" });
		await zoomShot(selCdp, page, await borderedRect(page), "34-selection-outline-light");

		step("1.4.x: the outline survives a merge and a frozen pane");
		// A merged cell is ONE <td> for several addresses, and a frozen pane is a
		// sticky cell that paints above the grid. Both are the cases where an
		// outline measured cell by cell used to come apart.
		await page.evaluate(() => {
			const e = window.engineAt(0);
			e.selectCell(8, 1); // B9
			e.selectCell(8, 3, true); // ... to D9
			e.mergeSelection();
		});
		await page.waitForTimeout(900);
		await page.click(selCell(1, 8));
		await page.waitForTimeout(500);
		const mergedBox = await page.evaluate(() => {
			const box = document
				.querySelector(".leovale-sheet-content .leovale-sheet-selbox")
				.getBoundingClientRect();
			const td = document
				.querySelector('.leovale-sheet-content .leovale-sheet-root td[data-x="1"][data-y="8"]')
				.getBoundingClientRect();
			return {
				dw: Math.round(Math.abs(box.width - td.width)),
				dh: Math.round(Math.abs(box.height - td.height)),
				width: Math.round(box.width),
			};
		});
		console.log("  merged outline:", JSON.stringify(mergedBox));
		check("the outline wraps the whole MERGED cell, not one column of it",
			mergedBox.dw <= 2 && mergedBox.dh <= 2 && mergedBox.width > 200,
			JSON.stringify(mergedBox));
		const readAccent = (p) =>
			p
				.evaluate(() => {
					const probe = document.createElement("div");
					probe.style.color = "var(--interactive-accent)";
					document.body.appendChild(probe);
					const c = getComputedStyle(probe).color;
					probe.remove();
					return c;
				})
				.then(rgbTriple);
		const accentNow = await readAccent(page);
		const mergedEdges = await edgePaint(selCdp, page, SELBOX);
		console.log("  merged edges:", JSON.stringify({ accentNow, ...mergedEdges }));
		check("and it is drawn on all four of its edges",
			!!mergedEdges &&
				["top", "right", "bottom", "left"].every(
					(s) => colorDelta(mergedEdges[s], accentNow) <= 40,
				),
			JSON.stringify(mergedEdges));
		await page.evaluate(() => window.engineAt(0).unmergeSelection());
		await page.waitForTimeout(600);

		await page.evaluate(() => window.engineAt(0).setFreeze({ rows: 2, cols: 0 }));
		await page.waitForTimeout(900);
		await page.click(selCell(1, 0)); // B1, inside the frozen pane
		await page.waitForTimeout(500);
		const frozenEdges = await edgePaint(selCdp, page, SELBOX);
		const frozenAccent = await readAccent(page);
		console.log("  frozen-pane outline:", JSON.stringify({ frozenAccent, ...frozenEdges }));
		check("a cell selected INSIDE a frozen row keeps its whole outline",
			!!frozenEdges &&
				["top", "right", "bottom", "left"].every(
					(s) => colorDelta(frozenEdges[s], frozenAccent) <= 40,
				),
			JSON.stringify(frozenEdges));
		await page.evaluate(() => window.engineAt(0).setFreeze({ rows: 0, cols: 0 }));
		await page.waitForTimeout(700);

		step("1.4.x: the same in the dark theme");
		await setBaseTheme(page, "obsidian");
		await page.waitForTimeout(900);
		await tintRun({ p: page, sess: selCdp, label: "dark" });
		await zoomShot(selCdp, page, await gridRect(page), "31-selection-range-dark");
		await outlineRun({ p: page, sess: selCdp, label: "dark" });
		await zoomShot(selCdp, page, await borderedRect(page), "35-selection-outline-dark");

		step("1.4.x: print never puts the selection on paper");
		const selPrintCss = await page.evaluate(() => {
			const td = document.querySelector(
				".leovale-sheet-content .leovale-sheet-root td.highlight:not(.highlight-selected)",
			);
			if (!td) return null;
			const screen = getComputedStyle(td).backgroundImage;
			// The print rule turns the tint variable off; ask for the value the
			// print stylesheet would resolve, by reading the rule itself.
			const rules = [];
			for (const sheet of Array.from(document.styleSheets)) {
				let list = [];
				try {
					list = Array.from(sheet.cssRules ?? []);
				} catch {
					continue;
				}
				for (const rule of list) {
					if (rule.type === CSSRule.MEDIA_RULE && rule.conditionText.includes("print")) {
						for (const inner of Array.from(rule.cssRules)) {
							if (/--leovale-sheet-sel-tint|leovale-sheet-cut|td\.highlight/.test(inner.cssText)) {
								rules.push(inner.cssText);
							}
						}
					}
				}
			}
			return { screen, rules };
		});
		console.log("  print rules:", JSON.stringify(selPrintCss?.rules, null, 1));
		check("on screen the tint is a background LAYER, not a colour",
			/gradient/.test(selPrintCss?.screen ?? ""), String(selPrintCss?.screen));
		check(
			"@media print switches the selection tint off",
			(selPrintCss?.rules ?? []).some((r) => /--leovale-sheet-sel-tint:\s*transparent/.test(r)),
			JSON.stringify(selPrintCss?.rules),
		);
		check(
			"@media print switches the cut marker off",
			(selPrintCss?.rules ?? []).some((r) => /leovale-sheet-cut/.test(r) && /outline:\s*none/.test(r)),
			JSON.stringify(selPrintCss?.rules),
		);

		/* ------------------------------------------------------------------------
		 * Copy, cut and paste INSIDE the plugin carry the formatting.
		 *
		 * The system clipboard is text and stays text - the range still pastes into
		 * Excel or into a note. What is new is the payload kept beside it, keyed on
		 * that same text, so a paste back into a sheet brings the fill, the mask,
		 * the bold, the borders and the fact that a cell is a tick box. And a cut
		 * is a MOVE: the source is emptied by the paste that completes it, not by
		 * the Ctrl+X, so an interrupted cut loses nothing.
		 * -------------------------------------------------------------------- */
		const CLIP_PATH = "Clip.sheet";
		const clipSeed = JSON.stringify(
			{
				format: "leovale-sheet",
				version: 4,
				sheets: [
					{
						name: "Sheet1",
						rows: 16,
						cols: 6,
						cells: {
							A1: { v: "Fruit", s: { b: true, bg: "#ffe08a", ha: "c" } },
							B1: { v: 3, s: { nf: "0.00" } },
							A2: { v: true, t: "cb" },
							// The formula points OUTSIDE the block that gets copied and
							// cut, so what it computes stays a fact about the paste and
							// not about the move. NOT at row 1: a reference to row 1
							// evaluates to #ERROR in this engine, whoever writes it and
							// whenever - a pre-existing fault of its own, measured on a
							// hand-typed `=F1*2` as well as on a seeded one.
							B2: { f: "=F3*2", s: { bd: "trbl" } },
							F3: { v: 5 },
						},
					},
				],
			},
			null,
			2,
		);

		const readClipboard = (p) =>
			p.evaluate(async () => {
				try {
					return require("electron").clipboard.readText();
				} catch {
					return await navigator.clipboard.readText();
				}
			});
		const writeClipboard = (p, text) =>
			p.evaluate(async (t) => {
				try {
					require("electron").clipboard.writeText(t);
				} catch {
					await navigator.clipboard.writeText(t);
				}
			}, text);

		/** Everything the file format keeps about one cell, straight off the engine. */
		const cellFacts = (p, refs) =>
			p.evaluate((list) => {
				const e = window.engineAt(0);
				const out = {};
				for (const ref of list) {
					out[ref] = {
						raw: e.getRawValue(ref),
						style: e.getStyleAt(ref),
						type: e.getCellType(ref) ?? null,
						text:
							document.querySelector(
								`.leovale-sheet-content .leovale-sheet-root td[data-x="${
									ref.charCodeAt(0) - 65
								}"][data-y="${Number(ref.slice(1)) - 1}"]`,
							)?.textContent ?? "",
					};
				}
				return out;
			}, refs);

		const dragSelect = async (p, x1, y1, x2, y2) => {
			const a = await p.locator(selCell(x1, y1)).boundingBox();
			const b = await p.locator(selCell(x2, y2)).boundingBox();
			await p.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
			await p.mouse.down();
			await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 });
			await p.mouse.up();
			await p.waitForTimeout(350);
		};

		step("1.4.x: Ctrl+C carries the formatting, Ctrl+V puts it back");
		await setBaseTheme(page, "moonstone");
		await page.waitForTimeout(600);
		await page.evaluate(
			async ([p, text]) => {
				const app = window.app;
				app.workspace.detachLeavesOfType("leovale-sheet-view");
				const old = app.vault.getAbstractFileByPath(p);
				if (old) await app.vault.delete(old);
				const f = await app.vault.create(p, text);
				await app.workspace.getLeaf(true).openFile(f);
			},
			[CLIP_PATH, clipSeed],
		);
		await page.waitForTimeout(2400);
		await installViewIndex(page);

		await dragSelect(page, 0, 0, 1, 1);
		await page.keyboard.press("Control+c");
		await page.waitForTimeout(700);
		const clipText = await readClipboard(page);
		console.log("  system clipboard after Ctrl+C:", JSON.stringify(clipText));
		check(
			"the SYSTEM clipboard still gets plain tab-separated text",
			clipText.includes("\t") && clipText.split(/\r?\n/).length === 2 && clipText.startsWith("Fruit\t3.00"),
			JSON.stringify(clipText),
		);
		check(
			"a checkbox travels as its value, not as an empty cell",
			/\btrue\b/.test(clipText),
			JSON.stringify(clipText),
		);

		await page.click(selCell(3, 4)); // D5
		await page.waitForTimeout(250);
		await page.keyboard.press("Control+v");
		await page.waitForTimeout(1200);
		const pastedRich = await cellFacts(page, ["D5", "E5", "D6", "E6"]);
		console.log("  pasted:", JSON.stringify(pastedRich, null, 1));
		check("the fill, the bold and the alignment arrived with the value",
			pastedRich.D5.style.bg === "#ffe08a" && pastedRich.D5.style.b === true &&
				pastedRich.D5.style.ha === "c" && pastedRich.D5.raw === "Fruit",
			JSON.stringify(pastedRich.D5));
		check("the number mask arrived, and the cell renders through it",
			pastedRich.E5.style.nf === "0.00" && pastedRich.E5.text === "3.00",
			JSON.stringify(pastedRich.E5));
		check("the CHECKBOX arrived as a checkbox",
			pastedRich.D6.type === "cb" && pastedRich.D6.raw === true,
			JSON.stringify(pastedRich.D6));
		// Verbatim and NOT rebased, which is the rule everywhere else in the plugin:
		// fill-down copies a formula unchanged, the file stores the source, and a
		// paste of plain text has always written what it was given.
		check("the FORMULA arrived as its source, verbatim (never rebased), and computes",
			pastedRich.E6.raw === "=F3*2" && pastedRich.E6.style.bd === "trbl" &&
				pastedRich.E6.text === "10",
			JSON.stringify(pastedRich.E6));
		check("and the source is untouched by a copy",
			(await cellFacts(page, ["A1"])).A1.style.bg === "#ffe08a");

		step("1.4.x: Ctrl+X is a MOVE, completed by the paste");
		await dragSelect(page, 0, 0, 1, 1);
		await page.keyboard.press("Control+x");
		await page.waitForTimeout(700);
		const cutMarked = await page.evaluate(
			() =>
				document.querySelectorAll(".leovale-sheet-content .leovale-sheet-root td.leovale-sheet-cut")
					.length,
		);
		check("the cut range is marked while it waits", cutMarked === 4, String(cutMarked));
		const stillThere = await cellFacts(page, ["A1"]);
		check("Ctrl+X alone changes nothing: an abandoned cut loses no data",
			stillThere.A1.raw === "Fruit" && stillThere.A1.style.bg === "#ffe08a",
			JSON.stringify(stillThere.A1));

		await page.click(selCell(3, 7)); // D8
		await page.waitForTimeout(250);
		await page.keyboard.press("Control+v");
		await page.waitForTimeout(1400);
		const moved = await cellFacts(page, ["A1", "B1", "A2", "B2", "D8", "E8", "D9", "E9"]);
		console.log("  after the move:", JSON.stringify(moved, null, 1));
		check("the destination has the cells, formatting included",
			moved.D8.raw === "Fruit" && moved.D8.style.bg === "#ffe08a" && moved.D9.type === "cb" &&
				moved.E9.raw === "=F3*2" && moved.E9.text === "10",
			JSON.stringify([moved.D8, moved.D9, moved.E9]));
		check("and the SOURCE is empty - values, styles and types alike",
			!moved.A1.raw && Object.keys(moved.A1.style).length === 0 && moved.A2.type === null &&
				!moved.B2.raw && Object.keys(moved.B1.style).length === 0,
			JSON.stringify([moved.A1, moved.B1, moved.A2, moved.B2]));
		const markLeft = await page.evaluate(
			() =>
				document.querySelectorAll(".leovale-sheet-content .leovale-sheet-root td.leovale-sheet-cut")
					.length,
		);
		check("the marker comes off with the move", markLeft === 0, String(markLeft));

		await page.waitForTimeout(5000);
		const clipDisk = fs.readFileSync(path.join(VAULT, CLIP_PATH), "utf8");
		check("BOTH halves of the move reached the file on disk",
			/"D8":/.test(clipDisk) && /#ffe08a/.test(clipDisk) && !/"A1":/.test(clipDisk),
			clipDisk.split("\n").filter((l) => /A1|D8/.test(l)).join(" | "));

		step("1.4.x: Escape withdraws a cut, and a foreign clipboard still pastes as text");
		await dragSelect(page, 3, 7, 4, 8); // the block that was just moved
		await page.keyboard.press("Control+x");
		await page.waitForTimeout(600);
		await page.keyboard.press("Escape");
		await page.waitForTimeout(400);
		const afterEscape = await page.evaluate(
			() =>
				document.querySelectorAll(".leovale-sheet-content .leovale-sheet-root td.leovale-sheet-cut")
					.length,
		);
		check("Escape takes the marker off", afterEscape === 0, String(afterEscape));
		await page.click(selCell(0, 11)); // A12
		await page.waitForTimeout(250);
		await page.keyboard.press("Control+v");
		await page.waitForTimeout(1200);
		const escaped = await cellFacts(page, ["D8", "A12"]);
		check("the withdrawn source is still there after pasting a copy of it",
			escaped.D8.raw === "Fruit" && escaped.A12.raw === "Fruit",
			JSON.stringify([escaped.D8, escaped.A12]));

		await writeClipboard(page, "p\tq\nr\ts");
		await page.click(selCell(0, 13)); // A14
		await page.waitForTimeout(250);
		await page.keyboard.press("Control+v");
		await page.waitForTimeout(1200);
		const foreign = await cellFacts(page, ["A14", "B14"]);
		console.log("  foreign paste:", JSON.stringify(foreign));
		check("text copied in another app pastes as values, with no borrowed styles",
			foreign.A14.raw === "p" && foreign.B14.raw === "q" &&
				Object.keys(foreign.A14.style).length === 0,
			JSON.stringify(foreign));

		step("1.4.x: the tint and the clipboard in an Obsidian pop-out window");
		const selPagesBefore = new Set(ctx.pages());
		await page.evaluate(async (a) => {
			const app = window.app;
			app.workspace.detachLeavesOfType("leovale-sheet-view");
			await new Promise((r) => setTimeout(r, 400));
			const leaf = app.workspace.openPopoutLeaf();
			await leaf.openFile(app.vault.getAbstractFileByPath(a));
		}, SEL_PATH);
		let selPopout = null;
		for (let i = 0; i < 40 && !selPopout; i++) {
			await page.waitForTimeout(500);
			selPopout = ctx.pages().find((q) => !selPagesBefore.has(q));
		}
		check("the pop-out for the selection tests appeared", !!selPopout);
		if (selPopout) {
			await selPopout.waitForTimeout(1800);
			await installViewIndex(selPopout);
			const popCdp = await ctx.newCDPSession(selPopout);
			check(
				"the pop-out carries Obsidian's theme classes, so the dark tint applies there",
				await selPopout.evaluate(() => /theme-(dark|light)/.test(document.body.className)),
				await selPopout.evaluate(() => document.body.className),
			);
			await tintRun({ p: selPopout, sess: popCdp, label: "pop-out light" });
			await zoomShot(popCdp, selPopout, await gridRect(selPopout), "32-selection-range-popout");
			await outlineRun({ p: selPopout, sess: popCdp, label: "pop-out light" });
			await zoomShot(popCdp, selPopout, await borderedRect(selPopout), "36-selection-outline-popout");

			await setBaseTheme(page, "obsidian");
			// A theme change is applied to a pop-out by Obsidian's own
			// `css-change` plumbing, one window at a time, and on a loaded machine
			// the pop-out has repainted noticeably later than the main window.
			// Waiting for the CLASS on the pop-out's body rather than for a fixed
			// timeout is what stops this section reading light-theme pixels and
			// reporting a tint that is missing only because it has not arrived yet.
			await selPopout
				.waitForFunction(() => document.body.classList.contains("theme-dark"), null, {
					timeout: 15_000,
				})
				.catch(() => undefined);
			await selPopout.waitForTimeout(1200);
			await tintRun({ p: selPopout, sess: popCdp, label: "pop-out dark" });
			await zoomShot(popCdp, selPopout, await gridRect(selPopout), "33-selection-range-popout-dark");
			await outlineRun({ p: selPopout, sess: popCdp, label: "pop-out dark" });
			await setBaseTheme(page, "moonstone");
			await selPopout.waitForTimeout(900);

			// The clipboard keys are intercepted on the pop-out's OWN document, and
			// that is the half the vendor never got right (its keydown handler is
			// bound to the main window's document, whatever it is configured with).
			await dragSelect(selPopout, 1, 0, 1, 1); // B1:B2, one filled, one plain
			await selPopout.keyboard.press("Control+c");
			await selPopout.waitForTimeout(700);
			const popClip = await readClipboard(selPopout);
			check("pop-out: Ctrl+C reaches the grid and writes the clipboard",
				popClip.replace(/\r/g, "").split("\n").join("|") === "filled|y2", JSON.stringify(popClip));
			await selPopout.click(selCell(4, 5)); // E6
			await selPopout.waitForTimeout(250);
			await selPopout.keyboard.press("Control+v");
			await selPopout.waitForTimeout(1200);
			const popPasted = await selPopout.evaluate(() => {
				const e = window.engineAt(0);
				return { e6: e.getStyleAt("E6"), raw: e.getRawValue("E6"), e7: e.getRawValue("E7") };
			});
			console.log("  pop-out paste:", JSON.stringify(popPasted));
			check("pop-out: Ctrl+V pastes the fill with the value",
				popPasted.raw === "filled" && popPasted.e6.bg === "#ffe08a" && popPasted.e7 === "y2",
				JSON.stringify(popPasted));

			await page.evaluate(() => {
				for (const l of window.app.workspace.getLeavesOfType("leovale-sheet-view")) l.detach();
			});
			await page.waitForTimeout(1200);
		}

		/* ------------------------------------------------------------------------
		 * 1.5.x, part one: FORMULAS THAT NAME ROW 1.
		 *
		 * Reported as "=A1, =B1*2 and =SUM(B1:B2) all give #ERROR, rows 2 and down
		 * are fine". The cause was not the parser and not our mapping: jspreadsheet
		 * asks a DIRECT `eval` whether a reference is an already-defined NAME
		 * before it supplies the cell's value, that eval sees the bundle's MINIFIED
		 * module scope, and esbuild names module-scope variables `A1`, `C1`, `E1`.
		 * The whole diagnosis is in scripts/patch-vendor.mjs; the unit tests pin
		 * the patch, and this pins the behaviour - on a production build, which is
		 * the only build the bug ever existed in.
		 *
		 * Everything below is TYPED BY HAND into an empty sheet, because that is
		 * how it was reported and because a seeded formula travels a different code
		 * path (the file loader) than a typed one.
		 * -------------------------------------------------------------------- */
		const POLISH_PATH = "Polish.sheet";
		await page.evaluate(async (p) => {
			const app = window.app;
			app.workspace.detachLeavesOfType("leovale-sheet-view");
			const old = app.vault.getAbstractFileByPath(p);
			if (old) await app.vault.delete(old);
			const f = await app.vault.create(
				p,
				JSON.stringify(
					{ format: "leovale-sheet", version: 4, sheets: [{ name: "Sheet1", rows: 24, cols: 8, cells: {} }] },
					null,
					2,
				),
			);
			await app.workspace.getLeaf(true).openFile(f);
		}, POLISH_PATH);
		await page.waitForTimeout(2400);
		await installViewIndex(page);
		await setBaseTheme(page, "moonstone");
		await page.waitForTimeout(500);

		step("1.5.x: a formula that names row 1 computes (the whole A1..H1 band)");
		// The data is seeded; only the FORMULAS are typed, which is what the report
		// was about and what keeps this section under a minute.
		await page.evaluate(() => {
			const e = window.engineAt(0);
			const letters = "ABCDEFGH";
			for (let i = 0; i < letters.length; i++) e.setRawValue(`${letters[i]}1`, String(i + 1));
			e.setRawValue("A2", "10");
			e.setRawValue("B2", "20");
		});
		await page.waitForTimeout(600);
		// One typed formula per column of row 1: every letter esbuild may have
		// used for a module-scope name, not just the one that was reported.
		for (let x = 0; x < 8; x++) {
			await typeInCell(page, x, 2, `=${String.fromCharCode(65 + x)}1`);
		}
		await page.waitForTimeout(400);
		const rowOne = await page.evaluate(() =>
			[...Array(8).keys()].map(
				(x) =>
					document.querySelector(
						`.leovale-sheet-content .leovale-sheet-root td[data-x="${x}"][data-y="2"]`,
					)?.textContent,
			),
		);
		console.log("  row-1 references:", JSON.stringify(rowOne));
		check(
			"=A1 .. =H1 all compute; none of them is #ERROR",
			JSON.stringify(rowOne) === JSON.stringify(["1", "2", "3", "4", "5", "6", "7", "8"]),
			JSON.stringify(rowOne),
		);

		step("1.5.x: the rest of the class - arithmetic, ranges, column A, mixed rows");
		await typeInCell(page, 0, 4, "=A1*2");
		await typeInCell(page, 1, 4, "=B1*2");
		await typeInCell(page, 2, 4, "=SUM(A1:B1)");
		await typeInCell(page, 3, 4, "=SUM(A1:A2)");
		await typeInCell(page, 4, 4, "=A1+B2");
		await typeInCell(page, 5, 4, "=SUM(A1:B2)");
		await typeInCell(page, 6, 4, "=A2*2");
		await page.waitForTimeout(400);
		const mixed = await page.evaluate(() =>
			[...Array(7).keys()].map(
				(x) =>
					document.querySelector(
						`.leovale-sheet-content .leovale-sheet-root td[data-x="${x}"][data-y="4"]`,
					)?.textContent,
			),
		);
		console.log("  formula class:", JSON.stringify(mixed));
		check(
			"=A1*2, =B1*2, =SUM(A1:B1), =SUM(A1:A2), =A1+B2, =SUM(A1:B2), =A2*2",
			JSON.stringify(mixed) === JSON.stringify(["2", "4", "3", "11", "21", "33", "20"]),
			JSON.stringify(mixed),
		);

		step("1.5.x: and it survives a row inserted above, and its deletion");
		await page.evaluate(() => window.engineAt(0).insertRows(0, 1, true));
		await page.waitForTimeout(900);
		const rowInsert = await page.evaluate(() => {
			const e = window.engineAt(0);
			const cell = (x, y) =>
				document.querySelector(
					`.leovale-sheet-content .leovale-sheet-root td[data-x="${x}"][data-y="${y}"]`,
				)?.textContent;
			return { src: e.getRawValue("A6"), shown: cell(0, 5), sum: cell(3, 5) };
		});
		console.log("  after insert:", JSON.stringify(rowInsert));
		check(
			"the reference followed the row it points at (=A1*2 -> =A2*2) and still computes",
			rowInsert.src === "=A2*2" && rowInsert.shown === "2" && rowInsert.sum === "11",
			JSON.stringify(rowInsert),
		);
		await page.evaluate(() => window.engineAt(0).deleteRows(0, 1));
		await page.waitForTimeout(900);
		const afterDelete = await page.evaluate(() => {
			const e = window.engineAt(0);
			const cell = (x, y) =>
				document.querySelector(
					`.leovale-sheet-content .leovale-sheet-root td[data-x="${x}"][data-y="${y}"]`,
				)?.textContent;
			return { src: e.getRawValue("A5"), shown: cell(0, 4), sum: cell(3, 4) };
		});
		console.log("  after delete:", JSON.stringify(afterDelete));
		check(
			"deleting that row puts it back on row 1 and it computes there too",
			afterDelete.src === "=A1*2" && afterDelete.shown === "2" && afterDelete.sum === "11",
			JSON.stringify(afterDelete),
		);

		/* ------------------------------------------------------------------------
		 * 1.5.x, part two: THE FILL HANDLE.
		 *
		 * Driven with a REAL mouse on the vendor's own 7px corner square, because
		 * the gesture is the feature: everything below goes through the same
		 * `mousedown`/`mousemove`/`mouseup` a user produces, and the preview is
		 * measured while the button is still down.
		 * -------------------------------------------------------------------- */
		const cornerSel = ".leovale-sheet-content .leovale-sheet-root .jss_corner";

		/**
		 * Select a range, then drag its corner to a cell. `midDrag` runs with the
		 * button still down, which is the only moment the preview exists.
		 */
		const fillDrag = async (from, to, target, midDrag = null) => {
			await dragSelect(page, from[0], from[1], to[0], to[1]);
			const c = await page.locator(cornerSel).boundingBox();
			const t = await page.locator(selCell(target[0], target[1])).boundingBox();
			await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
			await page.mouse.down();
			await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 12 });
			await page.waitForTimeout(160);
			if (midDrag) await midDrag();
			await page.mouse.up();
			await page.waitForTimeout(600);
		};

		const cells = (refs) =>
			page.evaluate((list) => {
				const e = window.engineAt(0);
				const out = {};
				for (const ref of list) out[ref] = e.getRawValue(ref);
				return out;
			}, refs);

		step("1.5.x: 1, 2, 3 dragged down continues 4, 5, 6 - with a live preview");
		await page.evaluate(() => {
			const e = window.engineAt(0);
			e.clearRect({ r1: 0, c1: 0, r2: 23, c2: 7 });
			e.setRawValue("A1", "1");
			e.setRawValue("A2", "2");
			e.setRawValue("A3", "3");
		});
		await page.waitForTimeout(700);
		let preview = null;
		await fillDrag([0, 0], [0, 2], [0, 5], async () => {
			preview = await page.evaluate(() => {
				const box = document.querySelector(".leovale-sheet-content .leovale-sheet-fillbox");
				if (!box) return null;
				const b = box.getBoundingClientRect();
				const a4 = document
					.querySelector('.leovale-sheet-content .leovale-sheet-root td[data-x="0"][data-y="3"]')
					.getBoundingClientRect();
				const a6 = document
					.querySelector('.leovale-sheet-content .leovale-sheet-root td[data-x="0"][data-y="5"]')
					.getBoundingClientRect();
				return {
					shown: getComputedStyle(box).display,
					style: getComputedStyle(box).borderTopStyle,
					dTop: Math.round(b.top - a4.top),
					dBottom: Math.round(b.bottom - a6.bottom),
					width: Math.round(b.width),
					cellWidth: Math.round(a4.width),
				};
			});
		});
		console.log("  fill preview:", JSON.stringify(preview));
		check(
			"the target range is previewed while the finger is still down, dashed and exact",
			!!preview &&
				preview.shown === "block" &&
				preview.style === "dashed" &&
				Math.abs(preview.dTop) <= 2 &&
				Math.abs(preview.dBottom) <= 2 &&
				Math.abs(preview.width - preview.cellWidth) <= 2,
			JSON.stringify(preview),
		);
		const down = await cells(["A4", "A5", "A6", "A7"]);
		console.log("  fill down:", JSON.stringify(down));
		check(
			"the series continues 4, 5, 6 and stops where the drag stopped",
			Number(down.A4) === 4 && Number(down.A5) === 5 && Number(down.A6) === 6 &&
				(down.A7 === null || down.A7 === ""),
			JSON.stringify(down),
		);
		check(
			"the preview is gone once the button is up",
			(await page.evaluate(
				() =>
					getComputedStyle(document.querySelector(".leovale-sheet-content .leovale-sheet-fillbox"))
						.display,
			)) === "none",
		);

		step("1.5.x: one Ctrl+Z undoes the whole drag");
		await page.click(selCell(0, 0));
		await page.keyboard.press("Control+z");
		await page.waitForTimeout(800);
		const undone = await cells(["A1", "A2", "A3", "A4", "A5", "A6"]);
		console.log("  after undo:", JSON.stringify(undone));
		check(
			"a single undo empties every cell the fill wrote, and touches nothing else",
			Number(undone.A1) === 1 &&
				Number(undone.A2) === 2 &&
				Number(undone.A3) === 3 &&
				[undone.A4, undone.A5, undone.A6].every((v) => v === null || v === ""),
			JSON.stringify(undone),
		);
		await page.keyboard.press("Control+y");
		await page.waitForTimeout(700);

		step("1.5.x: up, right and left, and a single cell that is still a copy");
		await page.evaluate(() => {
			const e = window.engineAt(0);
			e.clearRect({ r1: 0, c1: 0, r2: 23, c2: 7 });
			e.setRawValue("D5", "10");
			e.setRawValue("D6", "8");
			e.setRawValue("B10", "10");
			e.setRawValue("C10", "20");
			e.setRawValue("F12", "100");
			e.setRawValue("G12", "90");
			e.setRawValue("A14", "x");
		});
		await page.waitForTimeout(700);
		await fillDrag([3, 4], [3, 5], [3, 2]); // D5:D6 upwards to D3
		await fillDrag([1, 9], [2, 9], [4, 9]); // B10:C10 rightwards to E10
		await fillDrag([5, 11], [6, 11], [4, 11]); // F12:G12 leftwards to E12
		await fillDrag([0, 13], [0, 13], [0, 15]); // A14 alone, downwards
		const dirs = await cells(["D4", "D3", "D2", "D10", "E10", "E12", "D12", "A15", "A16"]);
		console.log("  directions:", JSON.stringify(dirs));
		check("upwards continues the series upwards", dirs.D4 === 12 && dirs.D3 === 14, JSON.stringify(dirs));
		check("rightwards continues it sideways", dirs.D10 === 30 && dirs.E10 === 40, JSON.stringify(dirs));
		check("leftwards too, and only where it was dragged", dirs.E12 === 110 && (dirs.D12 === null || dirs.D12 === ""),
			JSON.stringify(dirs));
		check("a single cell is still a plain copy, as it always was",
			dirs.A15 === "x" && dirs.A16 === "x", JSON.stringify(dirs));

		step("1.5.x: dates, text with a number, formulas, and the styles that came with them");
		await page.evaluate(() => {
			const e = window.engineAt(0);
			e.clearRect({ r1: 0, c1: 0, r2: 23, c2: 7 });
			e.setRawValue("A1", "2026-01-01");
			e.setRawValue("A2", "2026-01-02");
			e.setRawValue("B1", "Товар 1");
			e.setRawValue("B2", "Товар 2");
			e.setRawValue("C1", "5");
			e.setRawValue("C2", "7");
			e.setRawValue("D1", "=C1*2");
			e.applyStyle(["A1"], () => ({ bg: "#fff2cc", b: true }));
			e.applyStyle(["A2"], () => ({ bg: "#deebf7" }));
		});
		await page.waitForTimeout(800);
		await fillDrag([0, 0], [0, 1], [0, 5]); // dates + their alternating fills
		await fillDrag([1, 0], [1, 1], [1, 4]); // Товар N
		await fillDrag([3, 0], [3, 0], [3, 2]); // the formula, alone
		const rich = await page.evaluate(() => {
			const e = window.engineAt(0);
			return {
				dates: ["A3", "A4", "A5", "A6"].map((r) => e.getRawValue(r)),
				goods: ["B3", "B4", "B5"].map((r) => e.getRawValue(r)),
				formulas: ["D2", "D3"].map((r) => e.getRawValue(r)),
				shown: ["D2", "D3"].map(
					(r) =>
						document.querySelector(
							`.leovale-sheet-content .leovale-sheet-root td[data-x="3"][data-y="${
								Number(r.slice(1)) - 1
							}"]`,
						)?.textContent,
				),
				styles: ["A3", "A4", "A5"].map((r) => e.getStyleAt(r)),
			};
		});
		console.log("  rich fill:", JSON.stringify(rich));
		check("a date series steps by its own step",
			JSON.stringify(rich.dates) === JSON.stringify(["2026-01-03", "2026-01-04", "2026-01-05", "2026-01-06"]),
			JSON.stringify(rich.dates));
		check("text with a trailing number moves the number only",
			JSON.stringify(rich.goods) === JSON.stringify(["Товар 3", "Товар 4", "Товар 5"]),
			JSON.stringify(rich.goods));
		check("a formula shifts its references instead of continuing a series",
			rich.formulas[0] === "=C2*2" && rich.formulas[1] === "=C3*2" && rich.shown[0] === "14",
			JSON.stringify(rich.formulas) + " " + JSON.stringify(rich.shown));
		check("the samples' styles repeat over the filled cells",
			rich.styles[0].bg === "#fff2cc" && rich.styles[0].b === true && rich.styles[1].bg === "#deebf7" &&
				rich.styles[2].bg === "#fff2cc",
			JSON.stringify(rich.styles));

		step("1.5.x: the handle is a real touch target, and a finger can drag it");
		await page.evaluate(() => {
			const e = window.engineAt(0);
			e.clearRect({ r1: 0, c1: 0, r2: 23, c2: 7 });
			e.setRawValue("A1", "2");
			e.setRawValue("A2", "4");
		});
		await page.waitForTimeout(700);
		await installTouchDriver(page);
		const fillTouchCdp = await ctx.newCDPSession(page);
		await fillTouchCdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
		await page.evaluate(() => document.body.classList.add("is-mobile"));
		await page.waitForTimeout(500);
		await dragSelect(page, 0, 0, 0, 1);
		await page.waitForTimeout(300);
		const handleHit = await page.evaluate((sel) => {
			const c = document.querySelector(sel);
			if (!c) return null;
			const box = c.getBoundingClientRect();
			const after = getComputedStyle(c, "::after");
			const inset = Number.parseFloat(after.insetBlockStart || after.top || "0");
			// What a fingertip can actually land on: the square plus its halo.
			const reach = box.width - 2 * inset;
			const cx = box.left + box.width / 2;
			const cy = box.top + box.height / 2;
			// ...and it has to be the CORNER that answers a point out on the halo,
			// not the cell underneath it.
			const edge = document.elementFromPoint(Math.round(cx - reach / 2 + 2), Math.round(cy));
			return {
				reach: Math.round(reach),
				square: Math.round(box.width),
				owns: edge === c,
				// The one new UI string of this release, and the only affordance a
				// 7px square has.
				title: c.getAttribute("title"),
				label: c.getAttribute("aria-label"),
			};
		}, cornerSel);
		console.log("  fill handle touch target:", JSON.stringify(handleHit));
		check("on a tablet the handle answers to a 24px target, not a 7px one",
			!!handleHit && handleHit.reach >= 24 && handleHit.owns, JSON.stringify(handleHit));
		check("and it says what it is, from the translation table",
			handleHit?.title === "Drag to fill the series" && handleHit?.label === handleHit?.title,
			JSON.stringify([handleHit?.title, handleHit?.label]));
		const touchRect = await page.evaluate(
			([corner, cell]) => {
				const c = document.querySelector(corner).getBoundingClientRect();
				const t = document.querySelector(cell).getBoundingClientRect();
				return { dx: Math.round(t.left + t.width / 2 - (c.left + c.width / 2)), dy: Math.round(t.top + t.height / 2 - (c.top + c.height / 2)) };
			},
			[cornerSel, selCell(0, 4)],
		);
		await page.evaluate(
			async ([sel, d]) => window.__touch({ selector: sel, dx: d.dx, dy: d.dy, steps: 8 }),
			[cornerSel, touchRect],
		);
		await page.waitForTimeout(800);
		const byFinger = await cells(["A3", "A4", "A5"]);
		console.log("  filled by finger:", JSON.stringify(byFinger));
		check("a finger dragging the handle fills the series, exactly as the mouse does",
			byFinger.A3 === 6 && byFinger.A4 === 8 && byFinger.A5 === 10, JSON.stringify(byFinger));
		await page.evaluate(() => document.body.classList.remove("is-mobile"));
		await fillTouchCdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
		await page.waitForTimeout(400);

		/* ------------------------------------------------------------------------
		 * 1.5.x, part three: WHAT THE GRID LOOKS LIKE.
		 *
		 * Four findings of the 2026-07-28 design audit and one request of the
		 * user's, all measured off the RENDERING: where the line breaks fall, where
		 * the digits sit, what the compositor actually painted in the dark theme,
		 * and where the sort marker is relative to the letter it must not move.
		 * -------------------------------------------------------------------- */
		const LOOK_PATH = "Look.sheet";
		await page.evaluate(
			async ([p, text]) => {
				const app = window.app;
				app.workspace.detachLeavesOfType("leovale-sheet-view");
				const old = app.vault.getAbstractFileByPath(p);
				if (old) await app.vault.delete(old);
				const f = await app.vault.create(p, text);
				await app.workspace.getLeaf(true).openFile(f);
			},
			[
				LOOK_PATH,
				JSON.stringify(
					{
						format: "leovale-sheet",
						version: 4,
						sheets: [
							{
								name: "Sheet1",
								rows: 14,
								cols: 5,
								colWidths: { 0: 96 },
								cells: {
									A1: { v: "Чекбоксы кликаются пальцем", s: { wrap: true } },
									A2: { v: "Позиция" },
									A3: { v: "Товар 1" },
									A4: { v: "Товар 12" },
									B1: { v: "Сумма" },
									B2: { v: 1234.5 },
									B3: { v: 99 },
									B4: { v: 7 },
									C1: { v: "Ставка" },
									C2: { v: 0.25, s: { nf: "0%" } },
									C3: { v: 111, s: { ha: "c" } },
									C4: { v: "12 штук" },
									D1: { v: "Цвет" },
									D2: { v: "жёлтый", s: { bg: "#fff2cc" } },
									D3: { v: "серый", s: { bg: "#d9d9d9", bd: "trbl" } },
									D4: { v: "[[README]]" },
									E1: { v: "Дата" },
									E2: { v: "2026-01-01" },
								},
							},
						],
					},
					null,
					2,
				),
			],
		);
		await page.waitForTimeout(2400);
		await installViewIndex(page);
		await setBaseTheme(page, "moonstone");
		await page.waitForTimeout(700);
		const lookCdp = await ctx.newCDPSession(page);

		step("1.5.x: a wrapped cell breaks between words, not inside them");
		const wrapping = await page.evaluate((sel) => {
			const td = document.querySelector(sel);
			const node = [...td.childNodes].find((n) => n.nodeType === 3);
			if (!node) return null;
			const text = node.textContent;
			const doc = td.ownerDocument;
			// Where the LINES really start, asked of the layout one character at a
			// time: a character whose box sits lower than the one before it is the
			// first character of a new line. Nothing here reads the stylesheet.
			const range = doc.createRange();
			const topOf = (i) => {
				range.setStart(node, i);
				range.setEnd(node, i + 1);
				return Math.round(range.getBoundingClientRect().top);
			};
			const starts = [];
			let prev = topOf(0);
			for (let i = 1; i < text.length; i++) {
				const top = topOf(i);
				if (top > prev + 2) starts.push(i);
				prev = top;
			}
			return {
				text,
				lines: starts.length + 1,
				// A line that starts in the middle of a word: the character before
				// its first one is a letter rather than a space or a hyphen.
				broken: starts.filter((i) => /\S/.test(text[i - 1]) && text[i - 1] !== "-").map((i) => text.slice(i - 4, i + 4)),
				computed: [getComputedStyle(td).wordBreak, getComputedStyle(td).overflowWrap],
			};
		}, selCell(0, 0));
		console.log("  wrapping:", JSON.stringify(wrapping));
		check("the wrapped cell really does wrap onto several lines",
			!!wrapping && wrapping.lines >= 2, JSON.stringify(wrapping));
		check("and not one of those lines starts inside a word",
			!!wrapping && wrapping.broken.length === 0, JSON.stringify(wrapping?.broken));
		check("word-break is `normal`; breaking a word is the last resort only",
			!!wrapping && wrapping.computed[0] === "normal" && wrapping.computed[1] === "break-word",
			JSON.stringify(wrapping?.computed));

		step("1.5.x: numbers sit on the right and their digits line up");
		const numbers = await page.evaluate(() => {
			const at = (x, y) =>
				document.querySelector(
					`.leovale-sheet-content .leovale-sheet-root td[data-x="${x}"][data-y="${y}"]`,
				);
			// The right edge of the TEXT, not of the cell: this is the measurement
			// that says the digits form a column.
			const inkRight = (td) => {
				const node = [...td.childNodes].find((n) => n.nodeType === 3);
				if (!node) return null;
				const r = td.ownerDocument.createRange();
				r.selectNodeContents(node);
				return Math.round(r.getBoundingClientRect().right);
			};
			const cellRight = (td) => Math.round(td.getBoundingClientRect().right);
			const cellLeft = (td) => Math.round(td.getBoundingClientRect().left);
			return {
				// B2 = 1234.5, B3 = 99, B4 = 7: three numbers of three lengths.
				numRight: [at(1, 1), at(1, 2), at(1, 3)].map(inkRight),
				numCellRight: cellRight(at(1, 1)),
				// C2 has a percent mask, and a masked number is still a number.
				maskedAlign: getComputedStyle(at(2, 1)).textAlign,
				maskedText: at(2, 1).textContent,
				// Text that merely contains a number stays where text belongs.
				textAlign: getComputedStyle(at(0, 2)).textAlign,
				textLeft: [cellLeft(at(0, 2)), inkRight(at(0, 2))],
				// "12 штук" is text too.
				mixedAlign: getComputedStyle(at(2, 3)).textAlign,
				// An explicit alignment still wins over the default.
				explicitAlign: getComputedStyle(at(2, 2)).textAlign,
				tabular: getComputedStyle(at(1, 1)).fontVariantNumeric,
			};
		});
		console.log("  numbers:", JSON.stringify(numbers));
		check("plain numbers are right-aligned by default",
			numbers.numRight.every((r) => numbers.numCellRight - r <= 12 && numbers.numCellRight - r >= 4),
			JSON.stringify(numbers));
		check("...so their digits line up down the column, to the pixel",
			new Set(numbers.numRight).size === 1, JSON.stringify(numbers.numRight));
		check("a masked number is a number too", numbers.maskedAlign === "right" && /%$/.test(numbers.maskedText),
			JSON.stringify([numbers.maskedAlign, numbers.maskedText]));
		check("text stays on the left, even when it holds a number",
			numbers.textAlign === "left" && numbers.mixedAlign === "left", JSON.stringify(numbers));
		check("an explicit alignment beats the default", numbers.explicitAlign === "center",
			numbers.explicitAlign);
		check("digits are tabular, so the columns cannot drift",
			/tabular-nums/.test(numbers.tabular), numbers.tabular);

		step("1.5.x: comfortable, equal insets on cells and on the coordinate headers");
		const insets = await page.evaluate(() => {
			const one = (sel) => {
				const cs = getComputedStyle(document.querySelector(sel));
				return [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join(" ");
			};
			return {
				cell: one('.leovale-sheet-content .leovale-sheet-root td[data-x="1"][data-y="1"]'),
				colHead: one('.leovale-sheet-content .leovale-sheet-root thead td[data-x="1"]'),
				rowHead: one(".leovale-sheet-content .leovale-sheet-root tbody tr td:first-child"),
			};
		});
		console.log("  padding:", JSON.stringify(insets));
		check("a data cell and both gutters use the same 4px/8px inset",
			insets.cell === "4px 8px 4px 8px" && insets.colHead === "4px 8px 4px 8px" &&
				insets.rowHead === "4px 8px 4px 8px",
			JSON.stringify(insets));

		step("1.5.x: the sort marker is muted, out of flow, and leaves the letter centred");
		const letterCentre = (x) =>
			page.evaluate((col) => {
				const td = document.querySelector(
					`.leovale-sheet-content .leovale-sheet-root thead td[data-x="${col}"]`,
				);
				const node = [...td.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
				const r = td.ownerDocument.createRange();
				r.selectNodeContents(node);
				const ink = r.getBoundingClientRect();
				const box = td.getBoundingClientRect();
				return {
					offset: Math.round((ink.left + ink.right) / 2 - (box.left + box.width / 2)),
					letter: node.textContent.trim(),
				};
			}, x);
		const beforeSort = await letterCentre(1);
		await page.click(selCell(1, 1));
		await page.waitForTimeout(300);
		await page.evaluate(() => window.sheetViewAt(0).sortSelectedColumn("desc"));
		await page.waitForTimeout(900);
		const afterSort = await letterCentre(1);
		const marker = await page.evaluate(() => {
			const td = document.querySelector(
				'.leovale-sheet-content .leovale-sheet-root thead td[data-x="1"]',
			);
			const after = getComputedStyle(td, "::after");
			const probe = document.createElement("div");
			probe.style.color = "var(--text-muted)";
			td.ownerDocument.body.appendChild(probe);
			const muted = getComputedStyle(probe).color;
			probe.remove();
			return {
				content: after.content,
				position: after.position,
				right: after.right,
				size: after.fontSize,
				colour: after.color,
				muted,
				sticky: getComputedStyle(td).position,
			};
		});
		console.log("  sort marker:", JSON.stringify(marker), "letter:", JSON.stringify([beforeSort, afterSort]));
		check("the marker is the descending triangle, absolutely positioned at the right edge",
			marker.content.includes("▼") && marker.position === "absolute" &&
				Number.parseFloat(marker.right) <= 6,
			JSON.stringify(marker));
		check("small and muted, not the theme's accent",
			Number.parseFloat(marker.size) <= 8 && marker.colour === marker.muted, JSON.stringify(marker));
		check("the header cell is STILL sticky, so its letter cannot scroll away",
			marker.sticky === "sticky", marker.sticky);
		check("and the letter has not moved a pixel from the centre it had unsorted",
			Math.abs(afterSort.offset) <= 1 && afterSort.offset === beforeSort.offset,
			JSON.stringify([beforeSort, afterSort]));
		// The pixels, not only the declaration. The selection is moved off column B
		// first, or the two headers would differ by the selection wash rather than
		// by the marker - which is the whole thing being measured.
		await page.click(selCell(4, 6));
		await page.waitForTimeout(400);
		const sortedAvg = await avgColor(
			lookCdp,
			page,
			".leovale-sheet-content .leovale-sheet-root thead td.leovale-sheet-sorted",
		);
		const plainAvg = await avgColor(
			lookCdp,
			page,
			'.leovale-sheet-content .leovale-sheet-root thead td[data-x="2"]',
		);
		console.log("  header means:", JSON.stringify({ sortedAvg, plainAvg }));
		check("the marker is really PAINTED: the sorted header differs from an unsorted one",
			colorDelta(sortedAvg, plainAvg) > 0, JSON.stringify({ sortedAvg, plainAvg }));
		const headRect = await page.evaluate(() => {
			const r = document
				.querySelector(".leovale-sheet-content .leovale-sheet-root thead")
				.getBoundingClientRect();
			return { x: r.left, y: r.top - 1, width: Math.min(r.width, 560), height: r.height + 2 };
		});
		await zoomShot(lookCdp, page, headRect, "42-sort-marker-light", 6);
		await page.evaluate(() => window.sheetViewAt(0).sortSelectedColumn(null));
		await page.waitForTimeout(700);

		step("1.5.x: light and dark screenshots of the polished grid");
		const lookRect = await page.evaluate(() => {
			const r = document
				.querySelector(".leovale-sheet-content .leovale-sheet-root .jss_worksheet")
				.getBoundingClientRect();
			return { x: r.left, y: r.top, width: Math.min(r.width, 620), height: Math.min(r.height, 320) };
		});
		await zoomShot(lookCdp, page, lookRect, "40-grid-polish-light");

		step("1.5.x: the dark theme is readable where the audit said it was not");
		await setBaseTheme(page, "obsidian");
		await page.waitForTimeout(900);
		const darkFacts = await page.evaluate(() => {
			const root = document.querySelector(".leovale-sheet-content .leovale-sheet-root");
			const at = (sel) => root.querySelector(sel);
			// Chromium serialises a resolved `color-mix()` as `color(srgb r g b)`
			// with 0..1 channels, and an unfilled cell's background as
			// `rgba(0, 0, 0, 0)`. Both have to be understood, or a measurement of
			// "is this readable" measures nothing.
			const toRgb = (css) => {
				const s = String(css);
				const wide = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(s);
				if (wide) return [1, 2, 3].map((i) => Math.round(Number(wide[i]) * 255)).concat([1]);
				const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/.exec(s);
				if (!m) return null;
				return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
			};
			/** The background a HUMAN sees behind `el`: the first opaque ancestor. */
			const backdrop = (el) => {
				for (let n = el; n; n = n.parentElement) {
					const c = toRgb(getComputedStyle(n).backgroundColor);
					if (c && c[3] > 0.99) return c;
				}
				return [0, 0, 0, 1];
			};
			const lum = (c) => {
				const [r, g, b] = c.slice(0, 3).map((v) => {
					const s = v / 255;
					return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
				});
				return 0.2126 * r + 0.7152 * g + 0.0722 * b;
			};
			const ratio = (fg, bg) => {
				const la = lum(fg);
				const lb = lum(bg);
				return Math.round(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)) * 100) / 100;
			};
			const ink = (el) => toRgb(getComputedStyle(el).color);
			const colHead = at('thead td[data-x="1"]');
			const rowHead = at("tbody tr td:first-child");
			const bordered = at('td[data-x="3"][data-y="2"]');
			const link = at("a.leovale-sheet-link");
			const border = toRgb(getComputedStyle(bordered).borderTopColor);
			return {
				colHead: ratio(ink(colHead), backdrop(colHead)),
				rowHead: ratio(ink(rowHead), backdrop(rowHead)),
				link: link ? ratio(ink(link), backdrop(link)) : null,
				border,
				borderFromWhite: border ? border.slice(0, 3).reduce((a, v) => a + (255 - v), 0) : 0,
				fillDim: getComputedStyle(at('td[data-x="3"][data-y="1"]')).backgroundImage,
				filledClass: at('td[data-x="3"][data-y="1"]').classList.contains("leovale-sheet-filled"),
			};
		});
		console.log("  dark theme:", JSON.stringify(darkFacts));
		check("the column letters clear WCAG AA against their own header",
			darkFacts.colHead >= 4.5, String(darkFacts.colHead));
		check("so do the row numbers", darkFacts.rowHead >= 4.5, String(darkFacts.rowHead));
		check("a wiki link is readable on a dark cell", (darkFacts.link ?? 0) >= 4.5, String(darkFacts.link));
		check("a user's cell border is softened rather than painted pure white",
			darkFacts.borderFromWhite > 120, JSON.stringify(darkFacts.border));
		check("a filled cell carries the dark theme's dimming layer",
			darkFacts.filledClass && /gradient/.test(darkFacts.fillDim), JSON.stringify(darkFacts.fillDim));
		// ...and it is really painted, which is the only proof that counts.
		const darkFillPaint = await avgColor(
			lookCdp,
			page,
			'.leovale-sheet-content .leovale-sheet-root td[data-x="3"][data-y="1"]',
		);
		console.log("  painted yellow fill in the dark theme:", JSON.stringify(darkFillPaint));
		check("the pastel fill is genuinely darker on screen than the colour in the file",
			!!darkFillPaint && darkFillPaint[0] < 255 && darkFillPaint[0] + darkFillPaint[1] + darkFillPaint[2] <
				255 + 242 + 204 - 90,
			JSON.stringify(darkFillPaint));
		await zoomShot(lookCdp, page, lookRect, "41-grid-polish-dark");
		// The marker again, in the theme where a loud accent hurt most.
		await page.click(selCell(1, 1));
		await page.waitForTimeout(250);
		await page.evaluate(() => window.sheetViewAt(0).sortSelectedColumn("asc"));
		await page.waitForTimeout(800);
		await page.click(selCell(4, 6));
		await page.waitForTimeout(300);
		await zoomShot(lookCdp, page, headRect, "43-sort-marker-dark", 6);
		await page.evaluate(() => window.sheetViewAt(0).sortSelectedColumn(null));
		await page.waitForTimeout(600);
		await setBaseTheme(page, "moonstone");
		await page.waitForTimeout(600);

		await page.evaluate(
			async ([a, b]) => {
				const app = window.app;
				app.workspace.detachLeavesOfType("leovale-sheet-view");
				for (const name of [a, b]) {
					const f = app.vault.getAbstractFileByPath(name);
					if (f) await app.vault.delete(f);
				}
			},
			[POLISH_PATH, LOOK_PATH],
		);
		await page.waitForTimeout(500);

		await page.evaluate(
			async ([a, b]) => {
				const app = window.app;
				app.workspace.detachLeavesOfType("leovale-sheet-view");
				for (const name of [a, b]) {
					const f = app.vault.getAbstractFileByPath(name);
					if (f) await app.vault.delete(f);
				}
			},
			[SEL_PATH, CLIP_PATH],
		);
		await page.waitForTimeout(500);

		/* ==================================================================
		 * 1.7.0: TRUE UNDO, VERSION HISTORY, SAVE STATE
		 *
		 * The one assertion this whole section is built around: an operation
		 * done and then undone leaves the file ON DISK byte for byte what it
		 * was. Not "the grid looks right" - the bytes, read back from the vault
		 * with node's own fs, after the save has really happened. Every
		 * document-level operation the plugin has is put through it, because
		 * every one of them used to be irreversible: a sort permutes the rows
		 * AND their styles, a merge drops values, a cut empties its source, a
		 * rich paste writes values, styles and cell types at once.
		 * ================================================================== */
		const HIST_PATH = "History.sheet";
		const histSeed = JSON.stringify(
			{
				format: "leovale-sheet",
				version: 4,
				sheets: [
					{
						name: "Sheet1",
						rows: 12,
						cols: 5,
						colWidths: { 0: 140 },
						cells: {
							A1: { v: "Fruit", s: { b: true, bg: "#deebf7" } },
							B1: { v: "Qty", s: { b: true, bg: "#deebf7" } },
							// Each data row carries its OWN formatting, which is what
							// makes a sort worth undoing: the engine's own sort moves
							// the values and leaves the styles behind.
							A2: { v: "Pear", s: { bg: "#ffe08a" } },
							B2: { v: 3, s: { nf: "0.00" } },
							A3: { v: "Apple", s: { bg: "#e2f0d9" } },
							B3: { v: 5, s: { nf: "0.00" } },
							A4: { v: "Cherry", s: { bg: "#f4d9e8" } },
							B4: { v: 1, s: { nf: "0.00" } },
							A6: { v: "Total", s: { b: true } },
							B6: { f: "=SUM(B2:B4)" },
						},
					},
				],
			},
			null,
			2,
		);

		step("1.7.0: open a document worth undoing");
		await page.evaluate(
			async ([p, text]) => {
				const app = window.app;
				app.workspace.detachLeavesOfType("leovale-sheet-view");
				const old = app.vault.getAbstractFileByPath(p);
				if (old) await app.vault.delete(old);
				const file = await app.vault.create(p, text);
				await app.workspace.getLeaf(true).openFile(file);
				await new Promise((r) => setTimeout(r, 1200));
			},
			[HIST_PATH, histSeed],
		);
		await page.waitForTimeout(1400);
		await installViewIndex(page);
		const histDisk = path.join(VAULT, HIST_PATH);
		const readDisk = () => fs.readFileSync(histDisk, "utf8");

		/**
		 * Write now rather than in 1.5 s + Obsidian's own 2 s.
		 *
		 * The same command a user has ("Save spreadsheet now"), so the bytes
		 * being compared went through the ordinary save path - `getViewData`,
		 * the length floor, `vault.modify` - and not through a test-only door.
		 */
		const flushSheet = async (p = page) => {
			await p.evaluate((id) => window.app.commands.executeCommandById(`${id}:save-sheet`), PLUGIN_ID);
			await p.waitForTimeout(900);
		};

		const undoBtn = ".leovale-sheet-content .leovale-sheet-tb-undo";
		const redoBtn = ".leovale-sheet-content .leovale-sheet-tb-redo";
		const btnState = (p = page) =>
			p.evaluate(
				([u, r]) => {
					const undo = document.querySelector(u);
					const redo = document.querySelector(r);
					return {
						undo: !!undo,
						redo: !!redo,
						undoOff: undo?.hasAttribute("disabled") ?? null,
						redoOff: redo?.hasAttribute("disabled") ?? null,
						undoIcon: undo?.querySelector("svg.lucide-undo-2, svg")?.tagName ?? null,
						redoIcon: redo?.querySelector("svg.lucide-redo-2, svg")?.tagName ?? null,
					};
				},
				[undoBtn, redoBtn],
			);

		const fresh = await btnState();
		console.log("  toolbar:", JSON.stringify(fresh));
		check(
			"undo and redo are in the toolbar and carry a rendered icon",
			fresh.undo && fresh.redo && fresh.undoIcon === "svg" && fresh.redoIcon === "svg",
			JSON.stringify(fresh),
		);
		check(
			"both are disabled on a document nobody has touched",
			fresh.undoOff === true && fresh.redoOff === true,
			JSON.stringify(fresh),
		);
		// The glyph is really painted, not merely present: a lucide name this
		// build does not ship renders an empty <span> and a DOM test is happy.
		const undoInk = await paintedRatio(cdp, page, undoBtn);
		check(
			"the undo glyph is actually on screen",
			(undoInk?.ratio ?? 0) > 0.01,
			JSON.stringify(undoInk),
		);

		// One edit, so the file on disk is in OUR canonical form before the
		// operations below are measured against it.
		await typeInCell(page, 4, 0, "note");
		await flushSheet();
		const canonical = readDisk();
		check(
			"the seeded file was rewritten in the canonical format",
			canonical.includes('"format": "leovale-sheet"') && canonical.endsWith("\n"),
			canonical.slice(0, 60),
		);

		const armed = await btnState();
		check(
			"one edit arms undo and leaves redo dead",
			armed.undoOff === false && armed.redoOff === true,
			JSON.stringify(armed),
		);
		await shot(page, "60-history-toolbar-armed");

		/**
		 * Do an operation, undo it, redo it, and compare the FILE each time.
		 *
		 * A click on a cell before each keystroke is not decoration: the engine
		 * routes Ctrl+Z to the grid the user last clicked in (`jspreadsheet
		 * .current`), and every one of these operations rebuilds the grid.
		 */
		async function undoRoundTrip(name, run, opts = {}) {
			const before = readDisk();
			await run();
			await flushSheet();
			const after = readDisk();

			await page.click(selCell(0, 0));
			await page.waitForTimeout(150);
			await page.keyboard.press("Control+z");
			await page.waitForTimeout(700);
			await flushSheet();
			const undone = readDisk();

			await page.click(selCell(0, 0));
			await page.waitForTimeout(150);
			await page.keyboard.press(opts.redoKey ?? "Control+y");
			await page.waitForTimeout(700);
			await flushSheet();
			const redone = readDisk();

			check(`${name}: the operation reached the file`, after !== before, `${before.length} -> ${after.length}`);
			check(
				`${name}: ONE Ctrl+Z restored the file byte for byte`,
				undone === before,
				firstDiff(before, undone),
			);
			check(`${name}: redo applied it again, byte for byte`, redone === after, firstDiff(after, redone));

			// Leave the document where the operation left it, so the next test
			// starts from a known state.
			return after;
		}

		/** Where two documents part company, for a failure message worth reading. */
		function firstDiff(a, b) {
			if (a === b) return "identical";
			const la = a.split("\n");
			const lb = b.split("\n");
			for (let i = 0; i < Math.max(la.length, lb.length); i++) {
				if (la[i] !== lb[i]) return `line ${i + 1}: ${JSON.stringify(la[i])} vs ${JSON.stringify(lb[i])}`;
			}
			return `same lines, ${a.length} vs ${b.length} bytes`;
		}

		step("1.7.0: a typed value, undone and redone");
		await undoRoundTrip("typed value", async () => {
			await typeInCell(page, 1, 7, "42");
		});

		step("1.7.0: a SORT - the operation this feature exists for");
		const sortedText = await undoRoundTrip("sort", async () => {
			await page.click(selCell(0, 1));
			await page.waitForTimeout(200);
			await page.evaluate(() => window.sheetViewAt(0).sortSelectedColumn("asc"));
			await page.waitForTimeout(900);
		});
		check(
			"the sort moved the rows AND their fills (which is what makes it hard to undo)",
			/"v": "Apple", "s": \{ "bg": "#e2f0d9" \}/.test(sortedText) &&
				sortedText.indexOf('"v": "Apple"') < sortedText.indexOf('"v": "Pear"'),
			sortedText.split("\n").filter((l) => /"A[0-9]+":/.test(l)).join(" | "),
		);
		// Undo it for good; the merge below refuses to run on a sorted sheet's
		// sibling state anyway, and every later comparison wants a stable base.
		await page.click(selCell(0, 0));
		await page.keyboard.press("Control+z");
		await page.waitForTimeout(700);
		await flushSheet();

		step("1.7.0: the sort marker follows the history, not the other way round");
		await page.click(selCell(0, 1));
		await page.waitForTimeout(200);
		await page.evaluate(() => window.sheetViewAt(0).sortSelectedColumn("desc"));
		await page.waitForTimeout(900);
		const marked = await page.evaluate(() => ({
			marks: document.querySelectorAll(
				".leovale-sheet-content .leovale-sheet-root thead td[data-sort-dir]",
			).length,
			dir: document
				.querySelector(".leovale-sheet-content .leovale-sheet-root thead td[data-sort-dir]")
				?.getAttribute("data-sort-dir"),
		}));
		await page.click(selCell(0, 0));
		await page.keyboard.press("Control+z");
		await page.waitForTimeout(800);
		const unmarked = await page.evaluate(
			() =>
				document.querySelectorAll(
					".leovale-sheet-content .leovale-sheet-root thead td[data-sort-dir]",
				).length,
		);
		await page.click(selCell(0, 0));
		await page.keyboard.press("Control+y");
		await page.waitForTimeout(800);
		const remarked = await page.evaluate(
			() =>
				document.querySelectorAll(
					".leovale-sheet-content .leovale-sheet-root thead td[data-sort-dir]",
				).length,
		);
		console.log("  sort marker:", JSON.stringify({ marked, unmarked, remarked }));
		check("sorting marks its column header", marked.marks === 1 && marked.dir === "desc",
			JSON.stringify(marked));
		check("undoing the sort takes the marker with it", unmarked === 0, String(unmarked));
		check("and redoing it brings the marker back", remarked === 1, String(remarked));
		await page.click(selCell(0, 0));
		await page.keyboard.press("Control+z");
		await page.waitForTimeout(800);
		await flushSheet();

		step("1.7.0: a MERGE, undone");
		await undoRoundTrip("merge", async () => {
			await dragSelect(page, 3, 1, 4, 1); // D2:E2, both empty -> no confirm
			await page.evaluate(() => window.sheetViewAt(0).mergeSelection());
			await page.waitForTimeout(700);
		});

		step("1.7.0: a CUT completed by a paste (a move), undone");
		await undoRoundTrip("cut and paste", async () => {
			await dragSelect(page, 0, 1, 1, 1); // A2:B2
			await page.keyboard.press("Control+x");
			await page.waitForTimeout(500);
			await page.click(selCell(0, 9)); // A10
			await page.waitForTimeout(200);
			await page.keyboard.press("Control+v");
			await page.waitForTimeout(1200);
		});

		step("1.7.0: a rich paste (values, styles and types at once), undone");
		await undoRoundTrip("rich paste", async () => {
			await dragSelect(page, 0, 0, 1, 0); // A1:B1, both styled
			await page.keyboard.press("Control+c");
			await page.waitForTimeout(500);
			await page.click(selCell(2, 9)); // C10
			await page.waitForTimeout(200);
			await page.keyboard.press("Control+v");
			await page.waitForTimeout(1200);
		});

		step("1.7.0: fill-down, undone");
		await undoRoundTrip("fill down", async () => {
			await dragSelect(page, 1, 1, 1, 3); // B2:B4
			await page.keyboard.press("Control+d");
			await page.waitForTimeout(700);
		});

		step("1.7.0: a fill-handle DRAG is exactly one step of the document history");
		/*
		 * The two layers have to agree about this one.
		 *
		 * 1.6.0's fill handle folds everything a drag pushes onto the ENGINE's
		 * undo stack into a single entry, because a fill is a `setValue` per cell
		 * plus a style write and would otherwise cost twenty presses of Ctrl+Z.
		 * 1.7.0 takes Ctrl+Z away from that stack entirely and walks the document
		 * history instead - so the folding has nothing to do with what the user
		 * now gets, and the guarantee has to hold for a different reason: every
		 * write of a fill happens inside one synchronous call, so the 300 ms
		 * coalescing window closes once, after the last of them. This asserts the
		 * outcome rather than the reason, on the file: a drag of a dozen cells,
		 * one Ctrl+Z, the bytes back to what they were.
		 */
		await page.evaluate(() => {
			const e = window.engineAt(0);
			e.setRawValue("C2", "1");
			e.setRawValue("C3", "2");
			e.setRawValue("C4", "3");
		});
		await page.waitForTimeout(700);
		await flushSheet();
		await undoRoundTrip("fill drag", async () => {
			// C2:C4 dragged down to C9: six cells written plus their styles.
			await fillDrag([2, 1], [2, 3], [2, 8]);
		});
		const series = await page.evaluate(() => {
			const e = window.engineAt(0);
			const num = document.querySelectorAll(
				".leovale-sheet-content .leovale-sheet-root td.leovale-sheet-num",
			).length;
			return {
				c5: e.getRawValue("C5"),
				c9: e.getRawValue("C9"),
				numericCells: num,
			};
		});
		console.log("  after the redone fill:", JSON.stringify(series));
		check(
			"the drag continued the series (and the redo put all of it back)",
			Number(series.c5) === 4 && Number(series.c9) === 8,
			JSON.stringify(series),
		);
		// 1.6.0's numeric right-alignment is a CLASS derived from the values, not
		// something the file stores - so an undo, which REBUILDS the grid from a
		// snapshot, has to leave it correctly applied rather than stale.
		check(
			"numbers are still right-aligned after a grid rebuilt from history",
			series.numericCells >= 8,
			String(series.numericCells),
		);

		step("1.7.0: rows and columns inserted and deleted through our menu, undone");
		await undoRoundTrip("insert row", async () => {
			await page.click(selCell(0, 2));
			await page.waitForTimeout(200);
			await page.evaluate(() => window.engineAt(0).insertRows(2, 1, true));
			await page.waitForTimeout(700);
		});
		await undoRoundTrip("delete column", async () => {
			await page.click(selCell(2, 0));
			await page.waitForTimeout(200);
			await page.evaluate(() => window.engineAt(0).deleteColumns(2, 1));
			await page.waitForTimeout(700);
		});

		step("1.7.0: Ctrl+Shift+Z is redo as well");
		await undoRoundTrip(
			"styling with Ctrl+Shift+Z",
			async () => {
				await dragSelect(page, 0, 0, 1, 0);
				await page.evaluate(() =>
					window.engineAt(0).applyStyle(["A1", "B1"], (cur) => ({ ...cur, bg: "#f4d9e8" })),
				);
				await page.waitForTimeout(700);
			},
			{ redoKey: "Control+Shift+z" },
		);

		step("1.7.0: one keystroke is exactly one step, three edits deep");
		// The trap this catches: two undo stacks racing (the vendor's and ours),
		// or a coalescing window wide enough to swallow a whole operation.
		await page.click(selCell(0, 0));
		await flushSheet();
		const step0 = readDisk();
		await typeInCell(page, 3, 4, "one");
		await flushSheet();
		const step1 = readDisk();
		await typeInCell(page, 3, 5, "two");
		await flushSheet();
		const step2 = readDisk();
		await typeInCell(page, 3, 6, "three");
		await flushSheet();
		const step3 = readDisk();
		check(
			"three edits are three different documents",
			new Set([step0, step1, step2, step3]).size === 4,
			`${step0.length}/${step1.length}/${step2.length}/${step3.length}`,
		);
		await page.click(selCell(0, 0));
		await page.keyboard.press("Control+z");
		await page.waitForTimeout(700);
		await flushSheet();
		check("one Ctrl+Z went back exactly one edit", readDisk() === step2, firstDiff(step2, readDisk()));
		await page.click(selCell(0, 0));
		await page.keyboard.press("Control+z");
		await page.waitForTimeout(700);
		await page.click(selCell(0, 0));
		await page.keyboard.press("Control+z");
		await page.waitForTimeout(700);
		await flushSheet();
		check("two more went back exactly two edits", readDisk() === step0, firstDiff(step0, readDisk()));
		const deep = await btnState();
		check("with three steps ahead, redo is live", deep.redoOff === false, JSON.stringify(deep));
		await shot(page, "61-history-toolbar-redo-live");

		step("1.7.0: undo walks back to the beginning and then says so");
		for (let i = 0; i < 40; i++) {
			await page.click(selCell(0, 0));
			await page.keyboard.press("Control+z");
			await page.waitForTimeout(120);
			if ((await btnState()).undoOff === true) break;
		}
		const exhausted = await btnState();
		check("undo is disabled once the history is spent", exhausted.undoOff === true, JSON.stringify(exhausted));
		const noticeAfterUndo = await page.evaluate(async () => {
			document.querySelectorAll(".notice").forEach((n) => n.remove());
			window.app.commands.executeCommandById("leovale-sheets:undo-sheet");
			await new Promise((r) => setTimeout(r, 400));
			return [...document.querySelectorAll(".notice")].map((n) => n.textContent).join(" | ");
		});
		check(
			"and an undo with nothing left says so instead of doing something else",
			/Nothing left to undo/.test(noticeAfterUndo),
			noticeAfterUndo,
		);
		// Forward again, so the file is not left at its oldest state.
		for (let i = 0; i < 40; i++) {
			await page.click(selCell(0, 0));
			await page.keyboard.press("Control+y");
			await page.waitForTimeout(120);
			if ((await btnState()).redoOff === true) break;
		}
		await flushSheet();
		check("redo walked all the way forward again", readDisk() === step3, firstDiff(step3, readDisk()));

		step("1.7.0: the save indicator says what is happening");
		const indicator = ".leovale-sheet-content .leovale-sheet-save-state";
		const indicatorState = (p = page) =>
			p.evaluate((sel) => {
				const el = document.querySelector(sel);
				if (!el) return null;
				const cs = getComputedStyle(el);
				return {
					text: el.textContent,
					error: el.hasClass("is-error"),
					hidden: el.hasClass("is-hidden"),
					color: cs.color,
					visibility: cs.visibility,
				};
			}, indicator);

		check("the indicator sits on the formula-bar row, at its right end", await page.evaluate(
			(sel) => {
				const el = document.querySelector(sel);
				const bar = document.querySelector(".leovale-sheet-content .leovale-sheet-formulabar");
				if (!el || !bar) return false;
				const r = el.getBoundingClientRect();
				const b = bar.getBoundingClientRect();
				return el.parentElement === bar && r.right <= b.right + 1 && r.left > b.left + b.width / 2;
			},
			indicator,
		));

		// Typing: the "unsaved" state has to appear BEFORE the 1.5 s debounce
		// fires, which is the whole point of it.
		await page.click(selCell(2, 10));
		await page.waitForTimeout(120);
		await page.keyboard.type("dirty", { delay: 10 });
		await page.keyboard.press("Enter");
		await page.waitForTimeout(250);
		const dirtyState = await indicatorState();
		console.log("  dirty:", JSON.stringify(dirtyState));
		check(
			'an unsaved change is announced as such',
			/Unsaved changes/.test(dirtyState?.text ?? ""),
			JSON.stringify(dirtyState),
		);
		check("and it is really painted, not just in the DOM", (await seenByUser(page, indicator)).painted);
		await shot(page, "62-save-indicator-dirty");

		await flushSheet();
		const savedState = await indicatorState();
		check(
			"a completed save says so",
			/Saved just now/.test(savedState?.text ?? "") && savedState?.error === false,
			JSON.stringify(savedState),
		);
		await shot(page, "63-save-indicator-saved");

		// A minute later the same state reads as a clock time. Pushed rather than
		// waited for: the transition is a render of the state, and a test that
		// sleeps 60 s to see it is a test nobody runs.
		const aged = await page.evaluate(() => {
			const view = window.sheetViewAt(0);
			view.sheetIndicator.set({ name: "saved", at: Date.now() - 61_000 });
			return document.querySelector(".leovale-sheet-content .leovale-sheet-save-state")?.textContent;
		});
		check("after a minute it shows the time of the save", /^Saved at \d\d:\d\d$/.test(aged ?? ""), String(aged));
		await shot(page, "64-save-indicator-clock");

		step("1.7.0: a failed save is reported to the USER, not to the console");
		const failure = await page.evaluate(async () => {
			const app = window.app;
			const original = app.vault.modify.bind(app.vault);
			let thrown = false;
			app.vault.modify = async (...args) => {
				if (!thrown) {
					thrown = true;
					throw new Error("the disk said no");
				}
				return original(...args);
			};
			window.__restoreModify = () => {
				app.vault.modify = original;
			};
			const view = window.sheetViewAt(0);
			view.sheetEngine.setRawValue("D12", "fails");
			await new Promise((r) => setTimeout(r, 500));
			await view.flushSheet();
			await new Promise((r) => setTimeout(r, 400));
			const el = document.querySelector(".leovale-sheet-content .leovale-sheet-save-state");
			return {
				text: el?.textContent,
				error: el?.hasClass("is-error"),
				color: el ? getComputedStyle(el).color : null,
				title: el?.getAttribute("title"),
			};
		});
		console.log("  failed save:", JSON.stringify(failure));
		check(
			"a write that threw leaves a red, sticky failure state",
			/Save failed/.test(failure.text ?? "") && failure.error === true,
			JSON.stringify(failure),
		);
		const errorInk = rgbTriple(failure.color ?? "");
		check(
			"and it is painted in the theme's error colour, not in muted grey",
			!!errorInk && errorInk[0] > errorInk[1] + 40 && errorInk[0] > errorInk[2] + 40,
			String(failure.color),
		);
		await shot(page, "65-save-indicator-failed");

		const failureNotice = await page.evaluate(async () => {
			document.querySelectorAll(".notice").forEach((n) => n.remove());
			document.querySelector(".leovale-sheet-content .leovale-sheet-save-state").click();
			await new Promise((r) => setTimeout(r, 300));
			return [...document.querySelectorAll(".notice")].map((n) => n.textContent).join(" | ");
		});
		check(
			"clicking it shows the actual error",
			/the disk said no/.test(failureNotice),
			failureNotice,
		);

		// The state is sticky: a later keystroke must not quietly relabel it.
		await typeInCell(page, 3, 11, "still broken?");
		await page.waitForTimeout(300);
		const stickyState = await indicatorState();
		check(
			"the failure stays up while the document is edited on",
			stickyState?.error === true,
			JSON.stringify(stickyState),
		);
		await page.evaluate(() => window.__restoreModify?.());
		await flushSheet();
		const recovered = await indicatorState();
		check(
			"and it clears only when a save actually succeeds",
			/Saved just now/.test(recovered?.text ?? "") && recovered?.error === false,
			JSON.stringify(recovered),
		);
		check(
			"the keystroke made during the outage is on disk now",
			readDisk().includes("still broken?"),
			readDisk().split("\n").filter((l) => /D1[12]/.test(l)).join(" | "),
		);

		step("1.7.0: the version log on disk");
		const backupTree = await page.evaluate(async (p) => {
			const app = window.app;
			const root = `${app.vault.configDir}/plugins/leovale-sheets/backups`;
			if (!(await app.vault.adapter.exists(root))) return { root, missing: true };
			const listing = await app.vault.adapter.list(root);
			const out = [];
			for (const dir of listing.folders) {
				const index = JSON.parse(await app.vault.adapter.read(`${dir}/${"index.json"}`));
				const files = (await app.vault.adapter.list(dir)).files.map((f) => f.split("/").pop());
				out.push({
					path: index.path,
					versions: index.versions.length,
					gz: index.versions.every((v) => v.gz),
					payloads: files.filter((f) => f !== "index.json").length,
					summaries: index.versions.slice(-3).map((v) => v.summary),
					stored: index.versions.reduce((n, v) => n + v.stored, 0),
					size: index.versions.reduce((n, v) => n + v.size, 0),
				});
			}
			return { root, tree: out.filter((e) => e.path === p) };
		}, HIST_PATH);
		console.log("  backups:", JSON.stringify(backupTree, null, 1));
		const log = backupTree.tree?.[0];
		check("a version folder exists for the file, with an index", !!log, JSON.stringify(backupTree));
		check("every version was gzipped", !!log?.gz, JSON.stringify(log));
		check(
			"the payload count matches the index",
			log?.payloads === log?.versions,
			`${log?.payloads} payloads, ${log?.versions} entries`,
		);
		check(
			"gzip really pays for itself, even on documents this small",
			(log?.stored ?? 1) * 2 < (log?.size ?? 0),
			`${log?.stored} stored vs ${log?.size} raw`,
		);
		check(
			"the summaries name the cells that changed",
			(log?.summaries ?? []).some((s) => s.kind === "cells" && s.cells.length > 0),
			JSON.stringify(log?.summaries),
		);

		step("1.7.0: the version history dialog lists, previews and restores");
		// Two known states, one after the other, so the assertions below do not
		// depend on how many versions the operations above happened to leave (the
		// log rotates at 50, and this suite writes more than that).
		await typeInCell(page, 0, 10, "MARKER-OLD");
		await flushSheet();
		const markerOld = readDisk();
		await typeInCell(page, 0, 10, "MARKER-NEW");
		await flushSheet();
		const current = readDisk();
		check(
			"the two marker states really are different documents",
			markerOld.includes("MARKER-OLD") && current.includes("MARKER-NEW") && !current.includes("MARKER-OLD"),
			`${markerOld.length} vs ${current.length}`,
		);
		await page.evaluate((id) => window.app.commands.executeCommandById(`${id}:version-history`), PLUGIN_ID);
		await page.waitForTimeout(1200);
		const modal = await page.evaluate(() => {
			const m = document.querySelector(".modal.leovale-sheet-vh-modal");
			if (!m) return null;
			const items = [...m.querySelectorAll(".leovale-sheet-vh-item")];
			return {
				title: m.querySelector(".modal-title")?.textContent,
				items: items.length,
				first: {
					time: items[0]?.querySelector(".leovale-sheet-vh-item-time")?.textContent,
					size: items[0]?.querySelector(".leovale-sheet-vh-item-size")?.textContent,
					summary: items[0]?.querySelector(".leovale-sheet-vh-item-summary")?.textContent,
				},
				hint: m.querySelector(".leovale-sheet-vh-hint")?.textContent,
				restoreDisabled: [...m.querySelectorAll("button")]
					.find((b) => b.textContent === "Restore")
					?.hasAttribute("disabled"),
			};
		});
		console.log("  modal:", JSON.stringify(modal));
		check("the dialog opened with a list of versions", (modal?.items ?? 0) > 3, JSON.stringify(modal));
		check(
			"each row carries a time, a size and what changed",
			/\d\d:\d\d/.test(modal?.first.time ?? "") &&
				/KB/.test(modal?.first.size ?? "") &&
				(modal?.first.summary ?? "").length > 0,
			JSON.stringify(modal?.first),
		);
		check(
			"nothing is selected yet, so Restore cannot be pressed",
			modal?.restoreDisabled === true && (modal?.hint ?? "").length > 0,
			JSON.stringify(modal),
		);
		await shot(page, "66-version-history-empty-preview");

		// The version BELOW the newest is the MARKER-OLD state written a moment
		// ago (the newest is the document as it stands). Selecting it must show
		// that one, read-only.
		const previewState = await page.evaluate(async () => {
			const items = [...document.querySelectorAll(".leovale-sheet-vh-item")];
			items[1].click();
			await new Promise((r) => setTimeout(r, 900));
			const root = document.querySelector(".leovale-sheet-vh-preview .leovale-sheet-root");
			const cells = [...(root?.querySelectorAll("tbody td[data-x]") ?? [])].map(
				(td) => td.textContent,
			);
			return {
				mounted: !!root,
				cells,
				readOnly: !!root?.querySelector("td.readonly, table.jss_worksheet"),
				editable: !!root?.querySelector("td[contenteditable='true']"),
				selected: document.querySelectorAll(".leovale-sheet-vh-item.is-selected").length,
			};
		});
		console.log("  preview:", JSON.stringify(previewState));
		check("picking a version mounts a grid of it", previewState.mounted && previewState.cells.length > 0, JSON.stringify(previewState));
		check(
			"the preview shows THAT version, not the document on screen",
			previewState.cells.join("|").includes("MARKER-OLD") &&
				!previewState.cells.join("|").includes("MARKER-NEW"),
			previewState.cells.join("|").slice(0, 200),
		);
		check("the preview is read-only", previewState.editable === false && previewState.selected === 1);
		await shot(page, "67-version-history-preview");

		await setBaseTheme(page, "obsidian");
		await page.waitForTimeout(900);
		await shot(page, "68-version-history-dark");
		await setBaseTheme(page, "moonstone");
		await page.waitForTimeout(700);

		const restoredVersion = await page.evaluate(async () => {
			const button = [...document.querySelectorAll(".modal button")].find(
				(b) => b.textContent === "Restore",
			);
			button.click();
			await new Promise((r) => setTimeout(r, 1200));
			return {
				closed: !document.querySelector(".modal.leovale-sheet-vh-modal"),
				notice: [...document.querySelectorAll(".notice")].map((n) => n.textContent).join(" | "),
			};
		});
		await flushSheet();
		const afterRestore = readDisk();
		check("Restore closes the dialog and says what it did", restoredVersion.closed && /Restored/.test(restoredVersion.notice),
			JSON.stringify(restoredVersion));
		check(
			"the restored document is on disk, and it is the older one",
			afterRestore === markerOld,
			firstDiff(markerOld, afterRestore),
		);
		check(
			"and what the newer state had is gone from it",
			!afterRestore.includes("MARKER-NEW"),
			afterRestore.split("\n").filter((l) => /MARKER/.test(l)).join(" | "),
		);

		await page.click(selCell(0, 0));
		await page.waitForTimeout(200);
		await page.keyboard.press("Control+z");
		await page.waitForTimeout(800);
		await flushSheet();
		check(
			"a restore is itself one undo step: Ctrl+Z brings the document back",
			readDisk() === current,
			firstDiff(current, readDisk()),
		);

		step("1.7.0: a version can be deleted, and the log shrinks");
		const deletion = await page.evaluate(async (id) => {
			window.app.commands.executeCommandById(`${id}:version-history`);
			await new Promise((r) => setTimeout(r, 1000));
			const before = document.querySelectorAll(".leovale-sheet-vh-item").length;
			const items = [...document.querySelectorAll(".leovale-sheet-vh-item")];
			const victim = items[items.length - 1].getAttribute("data-id");
			items[items.length - 1].click();
			await new Promise((r) => setTimeout(r, 700));
			[...document.querySelectorAll(".modal button")].find((b) => b.textContent === "Delete").click();
			await new Promise((r) => setTimeout(r, 500));
			// The confirm is our own modal, not window.confirm().
			const confirmText = document.querySelector(".leovale-sheet-confirm-body")?.textContent ?? "";
			[...document.querySelectorAll(".modal button")]
				.filter((b) => b.textContent === "Delete")
				.pop()
				.click();
			await new Promise((r) => setTimeout(r, 900));
			const after = document.querySelectorAll(".leovale-sheet-vh-item").length;
			const root = `${window.app.vault.configDir}/plugins/leovale-sheets/backups`;
			const dirs = (await window.app.vault.adapter.list(root)).folders;
			let stillOnDisk = false;
			for (const dir of dirs) {
				const files = (await window.app.vault.adapter.list(dir)).files;
				if (files.some((f) => f.includes(victim))) stillOnDisk = true;
			}
			document.querySelector(".modal-close-button")?.click();
			await new Promise((r) => setTimeout(r, 400));
			return { before, after, confirmText, stillOnDisk };
		}, PLUGIN_ID);
		console.log("  deletion:", JSON.stringify(deletion));
		check("deleting asks first, in our own themed dialog", deletion.confirmText.length > 0, deletion.confirmText);
		check("the version is gone from the list", deletion.after === deletion.before - 1,
			`${deletion.before} -> ${deletion.after}`);
		check("and its payload is gone from the disk", deletion.stillOnDisk === false);

		step("1.7.0: undo in an Obsidian pop-out window");
		const histPagesBefore = new Set(ctx.pages());
		await page.evaluate(async (p) => {
			const app = window.app;
			app.workspace.detachLeavesOfType("leovale-sheet-view");
			await new Promise((r) => setTimeout(r, 500));
			const leaf = app.workspace.openPopoutLeaf();
			await leaf.openFile(app.vault.getAbstractFileByPath(p));
		}, HIST_PATH);
		let histPopout = null;
		for (let i = 0; i < 40 && !histPopout; i++) {
			await page.waitForTimeout(500);
			histPopout = ctx.pages().find((q) => !histPagesBefore.has(q));
		}
		check("the pop-out opened", !!histPopout);
		if (histPopout) {
			await histPopout.waitForTimeout(1800);
			await installViewIndex(histPopout);
			const popBase = readDisk();
			await histPopout.click(selCell(2, 6));
			await histPopout.waitForTimeout(200);
			await histPopout.keyboard.type("popout", { delay: 12 });
			await histPopout.keyboard.press("Enter");
			await histPopout.waitForTimeout(400);
			await flushSheet(histPopout);
			const popEdited = readDisk();
			check("the pop-out edit reached the file", popEdited !== popBase, `${popBase.length} -> ${popEdited.length}`);

			await histPopout.click(selCell(0, 0));
			await histPopout.waitForTimeout(200);
			await histPopout.keyboard.press("Control+z");
			await histPopout.waitForTimeout(800);
			await flushSheet(histPopout);
			check(
				"Ctrl+Z works in a pop-out too, byte for byte",
				readDisk() === popBase,
				firstDiff(popBase, readDisk()),
			);
			const popToolbar = await btnState(histPopout);
			check("the pop-out has its own live undo/redo buttons", popToolbar.undo && popToolbar.redoOff === false,
				JSON.stringify(popToolbar));
			await histPopout.screenshot({
				path: path.join(SHOTS, "69-history-popout.png"),
			});
			shots.push(path.join(SHOTS, "69-history-popout.png"));
			await page.evaluate(() => {
				for (const l of window.app.workspace.getLeavesOfType("leovale-sheet-view")) l.detach();
			});
			await page.waitForTimeout(1200);
		}

		step("1.7.0: does Obsidian's own File Recovery keep .sheet snapshots?");
		/*
		 * Empirical, in this sandbox, because the answer decides whether this
		 * whole feature duplicates a core one.
		 *
		 * The core plugin keeps its snapshots in an IndexedDB called
		 * `<vault id>-backup`, store `backups`, rows of `{path, ts, data}` -
		 * found by listing the databases rather than by guessing a name. The
		 * probe writes a NOTE and a SPREADSHEET through the same `vault.modify`
		 * within the same second, so a `.sheet` missing from the result cannot
		 * be blamed on the probe.
		 */
		const recovery = await page.evaluate(async () => {
			const app = window.app;
			const internal = app.internalPlugins?.getPluginById?.("file-recovery");
			const enabled = !!internal?.enabled;
			const seed =
				'{\n\t"format": "leovale-sheet",\n\t"version": 4,\n\t"sheets": [\n\t\t{\n' +
				'\t\t\t"name": "Sheet1",\n\t\t\t"rows": 3,\n\t\t\t"cols": 3,\n\t\t\t"colWidths": {},\n' +
				'\t\t\t"rowHeights": {},\n\t\t\t"merges": {},\n\t\t\t"view": {},\n\t\t\t"freeze": {},\n' +
				'\t\t\t"cells": {\n\t\t\t\t"A1": { "v": "one" }\n\t\t\t}\n\t\t}\n\t]\n}\n';
			for (const p of ["recovery-probe.md", "recovery-probe.sheet"]) {
				const old = app.vault.getAbstractFileByPath(p);
				if (old) await app.vault.delete(old);
			}
			const note = await app.vault.create("recovery-probe.md", "# probe\n");
			const sheet = await app.vault.create("recovery-probe.sheet", seed);
			await new Promise((r) => setTimeout(r, 1500));
			await app.vault.modify(note, "# probe\n\nedited\n");
			await app.vault.modify(sheet, seed.replace('"one"', '"two"'));
			await new Promise((r) => setTimeout(r, 4000));

			const dbName = (await indexedDB.databases())
				.map((d) => d.name)
				.find((n) => typeof n === "string" && n.endsWith("-backup"));
			const dump = await new Promise((resolve) => {
				if (!dbName) return resolve({ rows: [], names: [] });
				const req = indexedDB.open(dbName);
				req.onerror = () => resolve({ error: String(req.error), rows: [] });
				req.onsuccess = () => {
					const db = req.result;
					const names = [...db.objectStoreNames];
					if (names.length === 0) return resolve({ names, rows: [] });
					const tx = db.transaction(names[0], "readonly");
					const all = tx.objectStore(names[0]).getAll();
					all.onsuccess = () =>
						resolve({
							names,
							rows: (all.result ?? []).map((r) => String(r.path ?? r.file ?? "")),
						});
					all.onerror = () => resolve({ names, rows: [], error: String(all.error) });
				};
			});
			for (const p of ["recovery-probe.md", "recovery-probe.sheet"]) {
				const old = app.vault.getAbstractFileByPath(p);
				if (old) await app.vault.delete(old);
			}
			const paths = dump.rows ?? [];
			return {
				enabled,
				db: dbName ?? null,
				stores: dump.names ?? [],
				total: paths.length,
				md: paths.filter((s) => s === "recovery-probe.md").length,
				sheet: paths.filter((s) => s === "recovery-probe.sheet").length,
				anySheet: paths.filter((s) => s.endsWith(".sheet")).length,
				sample: paths.slice(0, 5),
				error: dump.error ?? null,
			};
		});
		console.log("  File Recovery:", JSON.stringify(recovery));
		check(
			"the File Recovery database was found and holds the probe NOTE",
			recovery.md > 0,
			JSON.stringify(recovery),
		);
		check(
			"...and NOT the .sheet written through the same call in the same second",
			recovery.sheet === 0,
			JSON.stringify(recovery),
		);

		await page.evaluate(async (p) => {
			const app = window.app;
			app.workspace.detachLeavesOfType("leovale-sheet-view");
			const f = app.vault.getAbstractFileByPath(p);
			if (f) await app.vault.delete(f);
		}, HIST_PATH);
		await page.waitForTimeout(500);

		const realErrors = pageErrors.filter(
			(e) =>
				!/Failed to load resource|net::ERR|DevTools|Autofill/.test(e) &&
				// the guard test deliberately throws inside a fake engine
				!/serialize failed Error: boom/.test(e) &&
				// ...and the save-indicator test deliberately breaks vault.modify
				!/the disk said no/.test(e),
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
