/**
 * Build-time repair of ONE line inside jspreadsheet-ce, and the reason it has to
 * exist.
 *
 * THE BUG IT FIXES. Every formula that named a cell in row 1 - `=A1`, `=B1*2`,
 * `=SUM(B1:B2)` - evaluated to `#ERROR`, while the same formula one row down was
 * fine. It was not the parser and not our doc->worksheet mapping: it was the
 * MINIFIER, and it only ever showed up in a production build.
 *
 * The vendor resolves a formula in two steps. First it collects the cell
 * references out of the expression and builds a map of their values; then it
 * hands the expression to `@jspreadsheet/formula`, which turns the map into
 * `var A1 = 5;` declarations and runs `new Function(preamble + "; return " +
 * expression)`. A `new Function` body is evaluated in GLOBAL scope, so the
 * declarations are the only way a reference can resolve at all.
 *
 * The map is filled under this guard (dist/index.js, `executeFormula`):
 *
 *     if (eval("typeof(" + tokens[i] + ') == "undefined"')) { ...collect... }
 *
 * The intent is sound - a token like `LOG10` or `ATAN2` matches the same
 * `[A-Z]+[0-9]+` pattern a cell reference does, and shadowing a formula function
 * with a cell value would break it. The implementation is not: `eval` here is a
 * DIRECT eval, so it sees the whole enclosing lexical scope. In the plugin
 * bundle that scope is esbuild's minified module scope, and esbuild's generated
 * names are letters followed by digits: `A1`, `C1`, `E1`, `F1`, `J1`... Measured
 * on a real build of this plugin: 12 top-level identifiers of exactly that
 * shape. For each of them the guard answered "already defined", the cell's value
 * was never collected, and `new Function("; return A1")` threw a ReferenceError
 * that the vendor swallowed into `#ERROR`.
 *
 * That also explains the shape of the symptom. Row 1 broke because two-character
 * minified names get their digit last and `...1` names appear before `...2`
 * names in esbuild's sequence, so a bundle this size has produced the whole
 * `A1..Z1` band and none of the `...2` band yet. It is not a row-1 bug, it is a
 * "your reference collided with a minified variable" bug, and it would have
 * spread to row 2 as the bundle grew.
 *
 * THE FIX. Ask about the GLOBAL scope, which is where the formula functions
 * actually live (`@jspreadsheet/formula` installs `SUM`, `LOG10`, `ATAN2` and
 * the rest on `globalThis` when it loads, and the `new Function` body finds them
 * there), and ask specifically whether the name is CALLABLE. A cell reference is
 * never a global function; a formula function always is. Nothing else about the
 * vendor's behaviour changes.
 *
 * Patching the dependency at build time rather than forking it keeps the
 * upgrade path: the replacement is asserted, so a vendor bump that moves this
 * line FAILS THE BUILD instead of silently shipping the bug back.
 */

/** The vendor line, verbatim, as it appears in jspreadsheet-ce 5.0.4. */
export const FORMULA_SCOPE_GUARD = 'eval("typeof("+tokens[i]+\') == "undefined"\')';

/**
 * What replaces it. `globalThis` is not shadowed anywhere in the vendor bundle,
 * and a property lookup cannot be captured by the minifier the way a bare
 * identifier can.
 */
export const FORMULA_SCOPE_GUARD_FIX = '"function"!=typeof globalThis[tokens[i]]';

/**
 * Apply the fix to the vendor source.
 *
 * @param {string} source contents of `jspreadsheet-ce/dist/index.js`
 * @returns {{ code: string, count: number }}
 * @throws if the line is not there any more - see the note about vendor bumps.
 */
export function patchFormulaScopeGuard(source) {
	if (typeof source !== "string") throw new TypeError("patchFormulaScopeGuard: source must be a string");
	const count = source.split(FORMULA_SCOPE_GUARD).length - 1;
	if (count === 0) {
		throw new Error(
			"jspreadsheet-ce: the formula scope guard is gone from dist/index.js. " +
				"Re-check whether the row-1 #ERROR bug is still there before removing this patch " +
				"(scripts/patch-vendor.mjs).",
		);
	}
	return { code: source.split(FORMULA_SCOPE_GUARD).join(FORMULA_SCOPE_GUARD_FIX), count };
}

/**
 * Is a bundled build free of the fault? Used by the tests: the bundle is the
 * artefact that ships, and the patch is only worth anything if it survived
 * bundling.
 *
 * @param {string} bundle contents of the built `main.js`
 */
export function bundleIsPatched(bundle) {
	return {
		guardGone: !bundle.includes('eval("typeof('),
		fixPresent: bundle.includes("typeof globalThis["),
	};
}

/**
 * Build-time removal of the vendor's promo badge.
 *
 * jspreadsheet-ce builds a `<div class="jss_about">` holding a link to the
 * vendor's own site and appends it to every grid. CSS used to hide it, which
 * left the link in the DOM and the address in the bundle; this takes it out
 * instead.
 *
 * The div itself STAYS. It is created here and appended later
 * (`e.element.appendChild(e.ads)`), so removing the assignment would leave that
 * line reading an undefined property. What goes is the anchor, the caption and
 * the class - the empty div renders as nothing.
 *
 * MIT asks for the copyright notice to travel with the code, not for a badge in
 * the interface; the notice is in the footer of the built `main.js`.
 */
export const VENDOR_AD = `const i=document.createElement("a");i.setAttribute("href","https://bossanova.uk/jspreadsheet/"),e.ads=document.createElement("div"),e.ads.className="jss_about";const a=document.createElement("span");a.innerHTML="Jspreadsheet CE",i.appendChild(a),e.ads.appendChild(i),`;

/** The bare element the rest of the vendor still expects to find. */
export const VENDOR_AD_FIX = `e.ads=document.createElement("div"),`;

/**
 * Strip the promo badge from the vendor source.
 *
 * Asserted like the formula patch: a vendor bump that rewrites this block fails
 * the build rather than quietly putting the badge back.
 *
 * @param {string} source contents of `jspreadsheet-ce/dist/index.js`
 * @returns {{ code: string, count: number }}
 */
export function patchVendorAd(source) {
	if (typeof source !== "string") throw new TypeError("patchVendorAd: source must be a string");
	const count = source.split(VENDOR_AD).length - 1;
	if (count === 0) {
		throw new Error(
			"jspreadsheet-ce: the promo badge block is not where it was in dist/index.js. " +
				"Re-check how the badge is built before removing this patch (scripts/patch-vendor.mjs).",
		);
	}
	return { code: source.split(VENDOR_AD).join(VENDOR_AD_FIX), count };
}

/**
 * Is a bundled build free of the badge? The bundle is what ships, so that is
 * where it has to be gone.
 *
 * @param {string} bundle contents of the built `main.js`
 */
export function bundleHasNoAd(bundle) {
	return {
		classGone: !bundle.includes("jss_about"),
		linkGone: !bundle.includes("bossanova.uk/jspreadsheet/"),
	};
}

/**
 * Keep a `.sheet` file from running code of its own.
 *
 * A formula is evaluated as JavaScript: `new Function(preamble + "; return " +
 * expression)`. The vendor upper-cases everything outside double quotes before
 * that, which reads like a sandbox and is not one: it stops a couple of global
 * names from resolving and nothing else.
 *
 * Two places let file content reach that evaluation. The expression itself,
 * where quoted text survives the upper-casing and can be used where the parser
 * expects a name; and the cell VALUE, which the vendor wraps for the preamble by
 * gluing quotes around it, so a value carrying a quote of its own ends the
 * literal early and the rest is parsed as code. The second one matters more,
 * because the formula pointing at such a cell can be entirely ordinary.
 *
 * The two fixes below: refuse the syntax the first case depends on (no
 * spreadsheet formula needs it, so nothing legitimate is lost), and build a real
 * escaped string literal instead of gluing quotes on.
 *
 * The details of what exactly gets through are in tests/vendorpatch.test.mjs,
 * which drives the unpatched vendor and then the patched one. Keep them there:
 * a test can prove the hole is shut without this file spelling out a recipe.
 *
 * Both patches are asserted like the others here: a vendor bump that rewrites
 * either line fails the build instead of silently reopening the hole.
 */

/**
 * Syntax refused inside a formula expression: bracket access and backticks.
 * Neither appears in spreadsheet formulas (SUM, IF, CONCATENATE, ranges and
 * arithmetic were all checked); both are needed to reach past the evaluator.
 */
export const FORMULA_DENY = /[[\]`]/;

/**
 * Is this formula expression safe to evaluate?
 *
 * A syntactic check on the raw expression, deliberately, rather than a list of
 * forbidden words: words can be assembled from pieces at runtime, syntax cannot.
 *
 * @param {string} expression
 */
export function formulaIsSafe(expression) {
	return typeof expression === "string" && !FORMULA_DENY.test(expression);
}

/**
 * Where the guard goes: the start of the transformation chain, while `n` is
 * still the expression the FILE contained.
 *
 * Not at the `new Function` call, which is the obvious spot and the wrong one -
 * by then the vendor has expanded `A1:A3` into a bracketed list of its own, so a
 * check there refuses every range. Measured, not guessed: `SUM(A1:A3)` and
 * `AVERAGE(A1:A3)` returned #ERROR until the guard moved here.
 */
export const FORMULA_EVAL = "let h=(n=function(n,t){";

/**
 * What replaces it. `#ERROR` is what every other formula failure produces, so a
 * refused formula behaves like a broken one and the rest of the sheet keeps
 * working.
 */
export const FORMULA_EVAL_FIX = 'if(/[[\\]`]/.test(n))return"#ERROR";let h=(n=function(n,t){';

/**
 * Refuse expressions that reach for bracket access.
 *
 * @param {string} source contents of `@jspreadsheet/formula/dist/index.js`
 * @returns {{ code: string, count: number }}
 */
export function patchFormulaEscape(source) {
	if (typeof source !== "string") throw new TypeError("patchFormulaEscape: source must be a string");
	const count = source.split(FORMULA_EVAL).length - 1;
	if (count === 0) {
		throw new Error(
			"@jspreadsheet/formula: the expression transformation chain moved in dist/index.js. " +
				"Re-check how a formula reaches `new Function` before removing this patch " +
				"(scripts/patch-vendor.mjs).",
		);
	}
	return { code: source.split(FORMULA_EVAL).join(FORMULA_EVAL_FIX), count };
}

/** The vendor line that quotes a cell value for the preamble, verbatim. */
export const CELL_QUOTING = "formulaExpressions[tokens[i]]='\"'+t+'\"'";

/**
 * What replaces it. `JSON.stringify` emits a correctly escaped JavaScript string
 * literal, which is what the concatenation was pretending to do.
 */
export const CELL_QUOTING_FIX = "formulaExpressions[tokens[i]]=JSON.stringify(String(t))";

/**
 * Escape cell values instead of gluing quotes around them.
 *
 * @param {string} source contents of `jspreadsheet-ce/dist/index.js`
 * @returns {{ code: string, count: number }}
 */
export function patchCellQuoting(source) {
	if (typeof source !== "string") throw new TypeError("patchCellQuoting: source must be a string");
	const count = source.split(CELL_QUOTING).length - 1;
	if (count === 0) {
		throw new Error(
			"jspreadsheet-ce: the cell-value quoting moved in dist/index.js. " +
				"Re-check how a value reaches the formula preamble before removing this patch " +
				"(scripts/patch-vendor.mjs).",
		);
	}
	return { code: source.split(CELL_QUOTING).join(CELL_QUOTING_FIX), count };
}

/**
 * Is a bundled build free of both holes? The bundle is what ships.
 *
 * @param {string} bundle contents of the built `main.js`
 */
export function bundleIsSealed(bundle) {
	return {
		expressionGuarded: bundle.includes('return"#ERROR"'),
		valuesEscaped: bundle.includes("JSON.stringify(String("),
		rawQuotingGone: !bundle.includes("='\"'+t+'\"'"),
	};
}

/**
 * Top-level identifiers in a bundle that look like a cell reference (`A1`,
 * `C1`, `AB12`). Nothing to fix about them once the guard is patched - they are
 * reported so the tests can prove the collision the fix is about is REAL on the
 * artefact being tested, rather than assumed.
 *
 * Deliberately a coarse scan: it counts declarations, not scopes, because its
 * only job is "does this bundle contain such a name at all".
 *
 * @param {string} bundle
 * @returns {string[]} sorted, unique
 */
export function cellShapedIdentifiers(bundle) {
	const found = new Set();
	const decl = /\b(?:var|let|const|function|class)\s+([A-Za-z_$][\w$]*)/g;
	for (const m of bundle.matchAll(decl)) {
		if (/^[A-Z]+[0-9]+$/.test(m[1])) found.add(m[1]);
	}
	return [...found].sort();
}
