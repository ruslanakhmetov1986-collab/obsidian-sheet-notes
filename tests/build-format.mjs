// Compiles the engine-free modules to tests/.build/*.mjs so node --test can import them.
import esbuild from "esbuild";

await esbuild.build({
	entryPoints: [
		"src/format.ts",
		"src/backups.ts",
		"src/cellcss.ts",
		"src/history.ts",
		"src/clipboard.ts",
		"src/csv.ts",
		"src/formulabar.ts",
		"src/i18n.ts",
		"src/numfmt.ts",
		"src/embedsrc.ts",
		"src/fillseries.ts",
		"src/sheetops.ts",
		"src/links.ts",
		"src/xlsx.ts",
		"src/xlsxstyles.ts",
	],
	bundle: true,
	// The spreadsheet library stays a real runtime import: the unit tests load
	// the same package the plugin does, from node_modules, instead of a 400 KB
	// copy baked into every test build.
	external: ["xlsx-js-style"],
	format: "esm",
	target: "es2021",
	platform: "neutral",
	outdir: "tests/.build",
	outExtension: { ".js": ".mjs" },
	logLevel: "warning",
});
