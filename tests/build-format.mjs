// Compiles the engine-free modules to tests/.build/*.mjs so node --test can import them.
import esbuild from "esbuild";

await esbuild.build({
	entryPoints: ["src/format.ts", "src/cellcss.ts"],
	bundle: true,
	format: "esm",
	target: "es2021",
	platform: "neutral",
	outdir: "tests/.build",
	outExtension: { ".js": ".mjs" },
	logLevel: "warning",
});
