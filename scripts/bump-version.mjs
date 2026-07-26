// Bumps the plugin version across manifest.json, versions.json and package.json.
// Usage: node scripts/bump-version.mjs [patch|minor|major]   (default: patch)
// Prints the new version to stdout. Files are written with LF and a trailing newline.
import fs from "node:fs";

const bump = process.argv[2] ?? "patch";
if (!["patch", "minor", "major"].includes(bump)) {
	console.error(`unknown bump kind: ${bump}`);
	process.exit(1);
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const writeJson = (p, obj) =>
	fs.writeFileSync(p, JSON.stringify(obj, null, 2).replace(/\r\n/g, "\n") + "\n", "utf8");

const manifest = readJson("manifest.json");
const [maj, min, pat] = manifest.version.split(".").map(Number);
const next =
	bump === "major" ? `${maj + 1}.0.0` : bump === "minor" ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;

manifest.version = next;
writeJson("manifest.json", manifest);

const versions = readJson("versions.json");
versions[next] = manifest.minAppVersion;
writeJson("versions.json", versions);

const pkg = readJson("package.json");
pkg.version = next;
writeJson("package.json", pkg);

console.log(next);
