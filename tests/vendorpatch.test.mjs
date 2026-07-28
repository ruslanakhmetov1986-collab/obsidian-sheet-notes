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
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	FORMULA_SCOPE_GUARD,
	FORMULA_SCOPE_GUARD_FIX,
	bundleIsPatched,
	cellShapedIdentifiers,
	patchFormulaScopeGuard,
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
