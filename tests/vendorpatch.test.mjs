/**
 * The row-1 `#ERROR` bug, pinned down.
 *
 * Reported as "any formula that names a cell in row 1 returns #ERROR": `=A1`,
 * `=B1*2`, `=SUM(B1:B2)`, while the same formula one row lower was fine. It is
 * neither the parser nor our doc->worksheet mapping. jspreadsheet decides
 * whether to supply a cell's value to the formula evaluator by asking a DIRECT
 * `eval` whether the reference is already a defined NAME, that eval sees the
 * minified module scope of the bundle, and esbuild's generated names are
 * letters followed by digits - `A1`, `C1`, `E1`. Full write-up in
 * scripts/patch-vendor.mjs.
 *
 * These tests are the class-level regression: they hold the vendor line in
 * place, hold the replacement in place, prove the collision is real in the
 * ARTEFACT that ships, and prove the two guards disagree exactly where the bug
 * lived. The functional half (typing `=A1` into a sheet and reading the result
 * off the screen) is in the e2e suite, against a real build.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	CELL_QUOTING,
	CELL_QUOTING_FIX,
	FORMULA_EVAL,
	FORMULA_EVAL_FIX,
	FORMULA_SCOPE_GUARD,
	FORMULA_SCOPE_GUARD_FIX,
	VENDOR_AD,
	VENDOR_AD_FIX,
	bundleHasNoAd,
	bundleIsPatched,
	bundleIsSealed,
	cellShapedIdentifiers,
	formulaIsSafe,
	patchCellQuoting,
	patchFormulaEscape,
	patchFormulaScopeGuard,
	patchVendorAd,
} from "../scripts/patch-vendor.mjs";

// Loading the evaluator is what installs SUM, LOG10 and the rest as GLOBALS -
// which is the scope the replacement guard asks about, so the tests need them
// installed exactly as the plugin has them.
const { default: formula } = await import("@jspreadsheet/formula");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = path.join(ROOT, "node_modules", "jspreadsheet-ce", "dist", "index.js");
const BUNDLE = path.join(ROOT, "main.js");

test("the vendor line the patch replaces is still exactly where it was", () => {
	const source = fs.readFileSync(VENDOR, "utf8");
	const hits = source.split(FORMULA_SCOPE_GUARD).length - 1;
	assert.equal(hits, 1, "jspreadsheet-ce no longer contains the direct-eval scope guard");
	// It is a DIRECT eval, which is the whole problem: an indirect one would see
	// the global scope only and there would be nothing to fix.
	assert.match(source, /,eval\("typeof\("/);
});

test("the vendor still builds its promo badge exactly where the patch expects", () => {
	const source = fs.readFileSync(VENDOR, "utf8");
	assert.equal(source.split(VENDOR_AD).length - 1, 1, "the promo badge block moved in jspreadsheet-ce");
});

test("stripping the badge keeps the element the rest of the vendor appends", () => {
	const { code, count } = patchVendorAd(`x();${VENDOR_AD}y();`);
	assert.equal(count, 1);
	assert.equal(code, `x();${VENDOR_AD_FIX}y();`);
	// The later `e.element.appendChild(e.ads)` still has something to append.
	assert.match(code, /e\.ads=document\.createElement\("div"\)/);
	// And the badge itself is gone.
	assert.ok(!code.includes("jss_about"));
	assert.ok(!code.includes("bossanova.uk/jspreadsheet/"));
});

test("a vendor bump that rewrites the badge breaks the build", () => {
	assert.throws(() => patchVendorAd("nothing like the badge here"), /promo badge block is not where it was/);
});

test("the shipped bundle carries no promo badge", () => {
	if (!fs.existsSync(BUNDLE)) return; // built artefact, not in the repo
	const { classGone, linkGone } = bundleHasNoAd(fs.readFileSync(BUNDLE, "utf8"));
	assert.ok(classGone, "main.js still contains the jss_about badge");
	assert.ok(linkGone, "main.js still contains the vendor promo link");
});

test("patching replaces the guard and leaves one expression behind", () => {
	const { code, count } = patchFormulaScopeGuard(`if(${FORMULA_SCOPE_GUARD}){x()}`);
	assert.equal(count, 1);
	assert.equal(code, `if(${FORMULA_SCOPE_GUARD_FIX}){x()}`);
	// Still a syntactically valid condition, not a string splice that happens to
	// look right.
	assert.doesNotThrow(() => new Function("tokens", "i", `return ${FORMULA_SCOPE_GUARD_FIX}`));
});

test("a vendor bump that moves the line breaks the build instead of the sheets", () => {
	assert.throws(() => patchFormulaScopeGuard("nothing to see here"), /formula scope guard is gone/);
	assert.throws(() => patchFormulaScopeGuard(undefined), TypeError);
});

test("the old guard and the new one disagree exactly on a shadowed cell name", () => {
	// What the minifier leaves in the bundle's module scope, reproduced here:
	// a variable whose name is spelled like a cell reference.
	var A1 = { some: "minified module" }; // eslint-disable-line no-var
	const tokens = ["A1", "LOG10", "SUM"];

	const oldGuard = (tok) => eval(`typeof(${tok}) == "undefined"`);
	const newGuard = (tok) => typeof globalThis[tok] !== "function";

	// The bug: the vendor refuses to supply A1's value because a MINIFIED
	// VARIABLE of that name is in scope. `A1` is read below so the binding is
	// not elided.
	assert.equal(typeof A1, "object");
	assert.equal(oldGuard("A1"), false, "the old guard sees the minified binding");
	assert.equal(newGuard("A1"), true, "the new guard supplies the cell value");

	// ...while both still refuse to shadow a real formula function, which is the
	// only thing the guard was ever for. Loading the evaluator installs them.
	assert.equal(oldGuard("LOG10"), false);
	assert.equal(newGuard("LOG10"), false);
	assert.equal(newGuard("SUM"), false);
	assert.equal(tokens.length, 3);
});

test("the formula evaluator fails and succeeds exactly as the diagnosis says", () => {
	// Value supplied: what a working sheet does.
	assert.equal(formula("A1*2", { A1: 21 }, 0, 0, {}), 42);
	assert.equal(formula("SUM(B1:B2)", { B1: 2, B2: 3 }, 0, 0, {}), 5);
	// Value withheld, which is what the unpatched guard caused: the generated
	// `new Function` body runs in GLOBAL scope, finds no A1 and throws - and the
	// vendor turns that throw into "#ERROR".
	assert.throws(() => formula("A1*2", {}, 0, 0, {}), ReferenceError);
});

test("the shipped bundle carries the fix, and the collision it fixes is real", (t) => {
	if (!fs.existsSync(BUNDLE)) {
		t.skip("main.js is not built; run `npm run build` first (CI always does)");
		return;
	}
	const bundle = fs.readFileSync(BUNDLE, "utf8");
	const { guardGone, fixPresent } = bundleIsPatched(bundle);
	assert.equal(guardGone, true, "main.js still contains the direct-eval guard");
	assert.equal(fixPresent, true, "main.js does not contain the globalThis lookup");

	// The proof that this is not a theoretical fix: the minifier really does
	// name module-scope variables after cells, and row 1 is where they land.
	const shaped = cellShapedIdentifiers(bundle);
	const rowOne = shaped.filter((n) => /^[A-Z]+1$/.test(n));
	assert.ok(
		rowOne.length > 0,
		`expected the bundle to contain cell-shaped identifiers; found ${shaped.join(",") || "none"}`,
	);
});

// ---------------------------------------------------------------------------
// A .sheet file is data, and it must not be able to behave like a program.
// Both holes were REAL on the unpatched vendor and are demonstrated as such
// below: a test that only proves the patched build is safe cannot tell you
// whether it is still fixing anything.

const FORMULA_SRC = path.join(ROOT, "node_modules", "@jspreadsheet", "formula", "dist", "index.js");

/** Load a copy of the evaluator with the escape guard applied. */
async function patchedEvaluator() {
	const patched = patchFormulaEscape(fs.readFileSync(FORMULA_SRC, "utf8")).code;
	const file = path.join(os.tmpdir(), `sheet-formula-patched-${process.pid}.cjs`);
	fs.writeFileSync(file, patched);
	const mod = createRequire(import.meta.url)(file);
	fs.rmSync(file, { force: true });
	const f = mod.default ?? mod;
	return typeof f === "function" ? f : f.formula;
}

/** How jspreadsheet-ce hands a text cell value to the evaluator, before/after. */
const quotedTheOldWay = (v) => `"${v}"`;
const quotedTheNewWay = (v) => JSON.stringify(String(v));

test("both vendor lines the security patches replace are still where they were", () => {
	assert.equal(fs.readFileSync(FORMULA_SRC, "utf8").split(FORMULA_EVAL).length - 1, 1);
	assert.equal(fs.readFileSync(VENDOR, "utf8").split(CELL_QUOTING).length - 1, 1);
});

test("a vendor bump that moves either line breaks the build", () => {
	assert.throws(() => patchFormulaEscape("nothing like it"), /transformation chain moved/);
	assert.throws(() => patchCellQuoting("nothing like it"), /cell-value quoting moved/);
});

test("the guard refuses bracket access and backticks, and nothing else", () => {
	assert.ok(!formulaIsSafe('""["constructor"]'));
	assert.ok(!formulaIsSafe("[][`x`]"));
	// Everything a spreadsheet actually writes.
	for (const ok of ["SUM(1,2,3)", "A1+B1*2", 'IF(A1>2,"да","нет")', "SUM(A1:A3)", "A1*0.5", "MAX(A1:A3)-MIN(A1:A3)"]) {
		assert.ok(formulaIsSafe(ok), ok);
	}
});

test("patching rewrites each line into exactly what it should be", () => {
	assert.equal(patchFormulaEscape(`x;${FORMULA_EVAL}y`).code, `x;${FORMULA_EVAL_FIX}y`);
	assert.equal(patchCellQuoting(`x;${CELL_QUOTING};y`).code, `x;${CELL_QUOTING_FIX};y`);
	// The replacement has to parse on its own, not just look right.
	assert.doesNotThrow(() => new Function("t", `return ${CELL_QUOTING_FIX.split("=").slice(1).join("=")}`));
});

test("a formula can no longer reach the Function constructor", async () => {
	const evaluate = await patchedEvaluator();
	const escapes = [
		'""["constructor"]["constructor"]("globalThis.__ESCAPED__=1; return 1")()',
		'[]["constructor"]["constructor"]("globalThis.__ESCAPED__=1")()',
		// Word-matching would miss this one; refusing brackets does not.
		'""["const"+"ructor"]["const"+"ructor"]("globalThis.__ESCAPED__=1")()',
	];
	for (const attack of escapes) {
		assert.equal(evaluate(attack, {}, 0, 0, {}), "#ERROR", attack);
	}
	assert.notEqual(globalThis.__ESCAPED__, 1, "a formula executed code of its own");
});

test("refusing the escape does not cost a single ordinary formula", async () => {
	const evaluate = await patchedEvaluator();
	const cases = [
		["SUM(1,2,3)", {}, 6],
		["A1+B1*2", { A1: 5, B1: 3 }, 11],
		['CONCATENATE("a","b")', {}, "ab"],
		['IF(A1>2,"да","нет")', { A1: 5 }, "да"],
		// Ranges are why the guard sits before the vendor's own expansion: it
		// rewrites A1:A3 into a bracketed list, so a later check refuses them all.
		["SUM(A1:A3)", { A1: 1, A2: 2, A3: 3 }, 6],
		["AVERAGE(A1:A3)", { A1: 2, A2: 4, A3: 6 }, 4],
		["MAX(A1:A3)-MIN(A1:A3)", { A1: 1, A2: 9, A3: 5 }, 8],
		["A1*0.5", { A1: 10 }, 5],
	];
	for (const [expression, values, expected] of cases) {
		assert.equal(evaluate(expression, values, 0, 0, {}), expected, expression);
	}
});

test("a cell VALUE cannot break out of the preamble", async () => {
	const evaluate = await patchedEvaluator();
	const payload = '"; globalThis.__INJECTED__=1; var q="';

	// The hole, on the vendor's own quoting: the value closes the string literal
	// early and the rest of it becomes statements.
	evaluate("A1", { A1: quotedTheOldWay(payload) }, 0, 0, {});
	assert.equal(globalThis.__INJECTED__, 1, "the unpatched quoting was expected to be injectable");
	delete globalThis.__INJECTED__;

	// Escaped properly, the same value is just text.
	assert.equal(evaluate("A1", { A1: quotedTheNewWay(payload) }, 0, 0, {}), payload);
	assert.notEqual(globalThis.__INJECTED__, 1, "a cell value executed code of its own");
});

test("escaping the value also fixes text that merely contains a quote", async () => {
	const evaluate = await patchedEvaluator();
	// This is an ordinary cell, and the old concatenation broke it outright.
	assert.equal(evaluate("A1", { A1: quotedTheNewWay('он сказал "да"') }, 0, 0, {}), 'он сказал "да"');
	assert.equal(
		evaluate("CONCATENATE(A1,B1)", { A1: quotedTheNewWay("а"), B1: quotedTheNewWay("б") }, 0, 0, {}),
		"аб",
	);
});

test("the shipped bundle carries both fixes", () => {
	if (!fs.existsSync(BUNDLE)) return; // built artefact, not in the repo
	const { expressionGuarded, valuesEscaped, rawQuotingGone } = bundleIsSealed(fs.readFileSync(BUNDLE, "utf8"));
	assert.ok(expressionGuarded, "main.js does not refuse bracket access in formulas");
	assert.ok(valuesEscaped, "main.js does not escape cell values");
	assert.ok(rawQuotingGone, "main.js still glues quotes around cell values");
});
