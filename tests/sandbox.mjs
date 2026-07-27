/**
 * Sandbox Obsidian instance management.
 *
 * NEVER touches the user's real Obsidian: that one runs on CDP port 9222 with
 * the default user-data-dir. Ours uses its own --user-data-dir (.sandbox/udata)
 * and port 9333, which makes it a fully independent app (the single-instance
 * lock is keyed to the user-data-dir).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";

export const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const SANDBOX = path.join(PROJECT_ROOT, ".sandbox");
export const UDATA = path.join(SANDBOX, "udata");
export const VAULT = path.join(SANDBOX, "test-vault");
export const PLUGIN_DIR = path.join(VAULT, ".obsidian", "plugins", "leovale-sheets");
export const SHOTS = path.join(PROJECT_ROOT, "tests", "shots");
/**
 * CDP port of the SANDBOX instance. 9333 by default; 9222 is the user's real
 * Obsidian and is never touched. `SHEETS_CDP_PORT` overrides it, which is not a
 * luxury: a leftover `adb forward tcp:9333` (Obsidian on a phone/tablet, also
 * debuggable over CDP) squats exactly this port, and attaching to that would
 * write test files into a real vault. See {@link assertSandboxTarget}.
 */
export const CDP_PORT = Number(process.env.SHEETS_CDP_PORT) || 9333;
export const PLUGIN_ID = "leovale-sheets";
export const OBSIDIAN_EXE = "C:\\Program Files\\Obsidian\\Obsidian.exe";

/** Write UTF-8 with LF and no BOM (a BOM sends Obsidian to the vault picker). */
export function writeNoBom(file, text) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text.replace(/\r\n/g, "\n"), { encoding: "utf8" });
}

export function seedSandbox() {
	for (const dir of [UDATA, VAULT, path.join(VAULT, ".obsidian"), PLUGIN_DIR, SHOTS]) {
		fs.mkdirSync(dir, { recursive: true });
	}

	// Auto-open the throwaway vault on first launch.
	writeNoBom(
		path.join(UDATA, "obsidian.json"),
		JSON.stringify({
			vaults: {
				"5eef2b1c9a3d4f60": { path: VAULT, open: true, ts: Date.now() },
			},
			updateDisabled: true,
		}),
	);

	// Skip the "trust author" modal noise; Restricted Mode itself lives in
	// localStorage and is turned off over CDP with app.plugins.setEnable(true).
	writeNoBom(path.join(VAULT, ".obsidian", "app.json"), JSON.stringify({ promptDelete: false }));
	writeNoBom(
		path.join(VAULT, ".obsidian", "community-plugins.json"),
		JSON.stringify([PLUGIN_ID]),
	);
	writeNoBom(path.join(VAULT, "README.md"), "# Sandbox vault\n\nThrowaway vault for e2e tests.\n");
}

/** Copy the freshly built artifacts into the sandbox vault's plugin folder. */
export function deployPlugin() {
	fs.mkdirSync(PLUGIN_DIR, { recursive: true });
	const copied = {};
	for (const name of ["main.js", "manifest.json", "styles.css"]) {
		const src = path.join(PROJECT_ROOT, name);
		if (!fs.existsSync(src)) throw new Error(`missing build artifact: ${src}`);
		const dst = path.join(PLUGIN_DIR, name);
		fs.copyFileSync(src, dst);
		copied[name] = fs.statSync(dst).size;
	}
	return copied;
}

function sandboxPids() {
	try {
		const out = execFileSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"Get-CimInstance Win32_Process -Filter \"Name='Obsidian.exe'\" | " +
					"Where-Object { $_.CommandLine -like '*.sandbox*' } | " +
					"Select-Object -ExpandProperty ProcessId",
			],
			{ encoding: "utf8" },
		);
		return out
			.split(/\r?\n/)
			.map((s) => s.trim())
			.filter((s) => /^[0-9]+$/.test(s))
			.map(Number);
	} catch {
		return [];
	}
}

/** Kill ONLY our sandbox instance, matched by its --user-data-dir on the cmdline. */
export function killSandbox() {
	const pids = sandboxPids();
	for (const pid of pids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			/* already gone */
		}
	}
	return pids;
}

async function portAlive(port) {
	try {
		const r = await fetch(`http://127.0.0.1:${port}/json/version`);
		return r.ok;
	} catch {
		return false;
	}
}

/**
 * Refuse to drive anything that is not a DESKTOP Obsidian we launched.
 *
 * Desktop Obsidian serves its window from `app://obsidian.md/index.html`; the
 * mobile app serves `http://localhost/`. So an `adb forward tcp:9333` to a
 * phone/tablet looks exactly like a live sandbox to `portAlive()`, and the test
 * would happily create `Untitled.sheet` in the user's real vault. Verified
 * failure mode: 9333 was an adb forward to a tablet whose vault is not ours.
 */
export async function assertSandboxTarget(port = CDP_PORT) {
	let targets = [];
	try {
		targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
	} catch (e) {
		throw new Error(`CDP port ${port} did not answer /json/list: ${e.message}`);
	}
	const pages = targets.filter((t) => t.type === "page");
	if (pages.some((t) => t.url === "app://obsidian.md/index.html")) return true;
	throw new Error(
		`CDP port ${port} is not a desktop Obsidian sandbox (pages: ` +
			`${pages.map((t) => `${t.url} "${t.title}"`).join(", ") || "none"}). ` +
			`An "adb forward tcp:${port}" to a phone or tablet looks the same from ` +
			`outside and its vault is REAL. Free the port or set SHEETS_CDP_PORT.`,
	);
}

export async function launchSandbox({ fresh = false } = {}) {
	if (fresh) killSandbox();
	if (await portAlive(CDP_PORT)) {
		await assertSandboxTarget(CDP_PORT);
		return "already-running";
	}

	seedSandbox();
	const child = spawn(
		OBSIDIAN_EXE,
		[
			`--user-data-dir=${UDATA}`,
			`--remote-debugging-port=${CDP_PORT}`,
			// Without these, a sandbox window that ends up BEHIND other windows is
			// reported as `document.visibilityState === "hidden"` by Chromium's
			// native occlusion tracking. Rendering then stops, requestAnimationFrame
			// never fires, and every Playwright click times out on "waiting for
			// element to be stable" - with the grid perfectly present in the DOM.
			// Verified failure mode, and the reason the suite passed only when the
			// window happened to be on top.
			"--disable-features=CalculateNativeWinOcclusion",
			"--disable-backgrounding-occluded-windows",
			"--disable-renderer-backgrounding",
		],
		{ detached: true, stdio: "ignore" },
	);
	child.unref();

	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		if (await portAlive(CDP_PORT)) {
			await assertSandboxTarget(CDP_PORT);
			return "launched";
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(`sandbox Obsidian did not expose CDP on ${CDP_PORT} within 90 s`);
}
