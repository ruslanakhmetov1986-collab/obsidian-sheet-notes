// Compiles the engine-free modules to tests/.build/*.mjs so node --test can import them.
import esbuild from "esbuild";

await esbuild.build({
	entryPoints: [
		"src/format.ts",
		"src/cellcss.ts",
		"src/csv.ts",
		"src/formulabar.ts",
		"src/i18n.ts",
		"src/numfmt.ts",
		"src/embedsrc.ts",
		"src/sheetops.ts",
	],
	bundle: true,
	format: "esm",
	target: "es2021",
	platform: "neutral",
	outdir: "tests/.build",
	outExtension: { ".js": ".mjs" },
	logLevel: "warning",
});
