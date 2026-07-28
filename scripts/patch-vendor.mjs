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
