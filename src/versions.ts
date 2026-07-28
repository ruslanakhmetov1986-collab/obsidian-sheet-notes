/**
 * Where the version store lives inside a vault, and who owns the instance.
 *
 * One store per vault, shared by every open spreadsheet: the 20 MB cap in
 * backups.ts is global, and two stores would each believe they were the only
 * one and keep twice as much. The instance is cached here rather than on the
 * plugin object so that the view can reach it without a back-reference to the
 * plugin (a view is created by Obsidian, not by us).
 */

import type { App } from "obsidian";
import { type BackupAdapter, BackupStore } from "./backups";

/** Must match `manifest.json`; it is the folder our data lives in. */
export const PLUGIN_ID = "leovale-sheets";

/**
 * `.obsidian/plugins/leovale-sheets/backups`, except that `.obsidian` is
 * whatever this vault's config folder is called (it is configurable, and a
 * hardcoded name would write into a folder the user does not use).
 */
export function backupRoot(app: App): string {
	return `${app.vault.configDir}/plugins/${PLUGIN_ID}/backups`;
}

let cached: { root: string; store: BackupStore } | null = null;

/** The vault's version store, created on first use. */
export function backupStore(app: App): BackupStore {
	const root = backupRoot(app);
	if (!cached || cached.root !== root) {
		// Obsidian's DataAdapter already has exactly the shape BackupAdapter asks
		// for; the cast is the whole binding.
		cached = {
			root,
			store: new BackupStore(app.vault.adapter as unknown as BackupAdapter, root),
		};
	}
	return cached.store;
}

/** Drop the cached store. Called when the plugin unloads. */
export function releaseBackupStore(): void {
	cached = null;
}
