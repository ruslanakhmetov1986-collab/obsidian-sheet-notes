# Engineering Brief: Obsidian Spreadsheet Note Type (`.sheet`)

Target: Obsidian desktop 1.7+ on Windows. Verified against Obsidian **1.12.7** (Electron 39.6.0 / Chrome 142), API package `obsidian@1.13.1`. Date: 2026-07-26.

---

## 1. Plugin API for a custom file type

### 1.1 Base class — use `TextFileView`

Hierarchy: `View → ItemView → FileView → EditableFileView → TextFileView`.

Verbatim from `obsidian.d.ts` (`@since 0.10.12`):

```ts
export abstract class TextFileView extends EditableFileView {
    data: string;                       // In memory data
    requestSave: () => void;            // Debounced save in 2 seconds from now
    constructor(leaf: WorkspaceLeaf);
    onUnloadFile(file: TFile): Promise<void>;
    onLoadFile(file: TFile): Promise<void>;
    save(clear?: boolean): Promise<void>;
    abstract getViewData(): string;
    abstract setViewData(data: string, clear: boolean): void;
    abstract clear(): void;
}
export abstract class FileView extends ItemView {
    allowNoFile: boolean;
    file: TFile | null;
    navigation: boolean;                // true by default for FileView
    getDisplayText(): string;
    getState(): Record<string, unknown>;
    setState(state: any, result: ViewStateResult): Promise<void>;
    onLoadFile(file: TFile): Promise<void>;
    onUnloadFile(file: TFile): Promise<void>;
    onRename(file: TFile): Promise<void>;
    canAcceptExtension(extension: string): boolean;
}
```

Class doc comment, verbatim: *"Note that by default, this view only saves when it's closing. To implement auto-save, your editor should call `this.requestSave()` when the content is changed."*

**Use `TextFileView`.** `ItemView` gives you no file binding; `FileView` gives you file binding but no text load/save cycle. Do **not** use `registerView` + `ItemView` and hand-roll `vault.modify` — you lose rename handling, tab title, history, and the save-on-close guarantee.

Lifecycle order: `onload()` → `onOpen()` → `onLoadFile(file)` → `setViewData(data, clear)`. On close/switch: `save(clear)` → `getViewData()` → `vault.modify` → `clear()` → `onUnloadFile()`.

### 1.2 Registration

```ts
registerView(type: string, viewCreator: ViewCreator): void;       // @since 0.9.7
registerExtensions(extensions: string[], viewType: string): void; // @since 0.9.7
```

```ts
export const VIEW_TYPE_SHEET = "leovale-sheet-view";

async onload() {
  this.registerView(VIEW_TYPE_SHEET, (leaf) => new SheetView(leaf, this));
  try {
    this.registerExtensions(["sheet"], VIEW_TYPE_SHEET);
  } catch (e) {
    // THROWS if another plugin already owns the extension.
    const owner = (this.app as any).viewRegistry.getTypeByExtension("sheet");
    new Notice(`.sheet is already registered to ${owner}`);
  }
}
```

Undocumented but stable internals (used in production by `obsidian-custom-file-extensions-plugin`):
- `app.viewRegistry.getTypeByExtension(ext): string` — who owns an extension.
- `app.viewRegistry.unregisterExtensions([ext])` — needed if you ever hand the extension back.
- `app.viewRegistry.typeByExtension` — the raw map.

`registerExtensions` makes the file visible in the file explorer and quick switcher **without** the user turning on Settings → Files & Links → "Detect all file extensions". That is exactly how the Files core plugin decides which view opens an extension: `leaf.openFile(tfile)` → `viewRegistry.getTypeByExtension(tfile.extension)` → `registerView` factory. No extra wiring.

### 1.3 Creating a new sheet — command + ribbon + context menu

```ts
import { Notice, Plugin, TFolder, TAbstractFile, normalizePath } from "obsidian";

const EMPTY_SHEET = serializeSheet(newSheetDoc());   // see §5

async function createSheet(app: App, folder?: TFolder): Promise<TFile> {
  const parent = folder ?? app.fileManager.getNewFileParent(
      app.workspace.getActiveFile()?.path ?? "", "Untitled.sheet");
  const dir = parent.path === "/" ? "" : parent.path + "/";
  let path = normalizePath(`${dir}Untitled.sheet`);
  for (let i = 1; app.vault.getAbstractFileByPath(path); i++) {
    path = normalizePath(`${dir}Untitled ${i}.sheet`);
  }
  const file = await app.vault.create(path, EMPTY_SHEET);
  await app.workspace.getLeaf(true).openFile(file);   // 'tab' | 'split' | 'window' also valid
  return file;
}
```

`FileManager.getNewFileParent(sourcePath: string, newFilePath?: string): TFolder` (`@since 1.1.13`) respects the user's "Default location for new notes" setting — use it instead of hardcoding the vault root.

```ts
// Command palette
this.addCommand({
  id: "create-sheet",                       // final id becomes "<plugin-id>:create-sheet"
  name: "Create new spreadsheet",
  callback: () => void createSheet(this.app),
});

// Ribbon
this.addRibbonIcon("table", "New spreadsheet", () => void createSheet(this.app));

// File-explorer context menu.
// Signature: (menu: Menu, file: TAbstractFile, source: string, leaf?: WorkspaceLeaf)
this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
  if (!(file instanceof TFolder)) return;   // GOTCHA: fires for files too; divamgupta's
                                            // plugin shipped this bug (issue #24) and
                                            // crashed when a file was right-clicked.
  menu.addItem((item) => item
    .setTitle("New spreadsheet")
    .setIcon("table")
    .onClick(() => void createSheet(this.app, file)));
}));
```

Prefer `leaf.openFile(file)` over `leaf.setViewState({type, state:{file: path}})`. Both work; `openFile` routes through the view registry and sets ephemeral state correctly.

### 1.4 manifest.json

Required: `id`, `name`, `version`, `minAppVersion`, `description`, `author`, `isDesktopOnly`. Optional: `authorUrl`, `fundingUrl`.

```json
{
  "id": "leovale-sheets",
  "name": "Sheets",
  "version": "0.1.0",
  "minAppVersion": "1.7.2",
  "description": "Spreadsheet notes stored as .sheet files in your vault.",
  "author": "Ruslan Akhmetov",
  "isDesktopOnly": false
}
```

`id` must be lowercase letters and hyphens, must not end in `plugin`, must not contain `obsidian`. Set `minAppVersion: "1.7.2"` (the deferred-views baseline). `isDesktopOnly` is only `true` if you use Node/Electron APIs — a bundled JS grid does not, so keep it `false` even if you don't test mobile.

Layout: `<vault>/.obsidian/plugins/<id>/{main.js, manifest.json, styles.css}`. Obsidian loads `styles.css` automatically; **any other CSS filename is ignored** (this is why esbuild's default `main.css` output silently does nothing).

Enabling programmatically — see §4.8; `community-plugins.json` is a flat array of ids, but Restricted Mode is the real gate and lives in localStorage, not in any vault file.

### 1.5 Gotchas

**Deferred views (1.7.2+) — the big one.** All views are instantiated as `DeferredView` and only swapped for the real view when their tab becomes visible.

```ts
get isDeferred(): boolean;          // @since 1.7.2
loadIfDeferred(): Promise<void>;    // @since 1.7.2
```

Never do `leaf.view as SheetView`. Always:

```ts
for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SHEET)) {
  await leaf.loadIfDeferred();               // or await workspace.revealLeaf(leaf)
  if (leaf.view instanceof SheetView) leaf.view.doThing();
}
```

`loadIfDeferred` defeats the optimization — use sparingly. Also: **never hold a reference to a view instance in the plugin**; the factory may be called multiple times.

**Data loss — the critical failure mode.** `TextFileView.save()` calls `getViewData()` and writes the result unconditionally. The FortuneSheet-based `obsidian-spreadsheets` plugin ships this:

```ts
getViewData() { if (this.sheet_data_out) { ... } else { return "" } }   // ← truncates the file
```

Result: GitHub issues #27 *"My note data was suddenly lost … ALL Data has lost"* and #29 *"content has been automatically cleared"*. Mandatory defensive pattern:

```ts
private lastGood: string | null = null;   // last known-good serialization
private dirty = false;

setViewData(data: string, clear: boolean) {
  if (clear) this.clear();
  this.lastGood = data;
  this.dirty = false;
  this.model = data.trim() ? parseSheet(data) : newSheetDoc();
  this.render();                     // create container lazily here, NOT only in onOpen()
}

getViewData(): string {
  if (!this.engine || !this.dirty) return this.lastGood ?? this.data;
  let out: string;
  try { out = serializeSheet(this.readEngine()); }
  catch (e) { console.error("sheet serialize failed", e); return this.lastGood ?? this.data; }
  if (!out || out.length < MIN_VALID) return this.lastGood ?? this.data;   // never write ""
  this.lastGood = out;
  return out;
}
```

Also flush on close: `async onClose() { if (this.dirty) await this.save(); this.destroyEngine(); this.contentEl.empty(); }`.

**Other gotchas.**
- `registerExtensions` throws on conflict — always try/catch.
- Grid engines need an explicit pixel height; `contentEl` is flex. Use `height: 100%` on a wrapper plus a `ResizeObserver` that calls the engine's refresh, rather than the `calc(100vh - 130px)` hack in the reference plugin.
- Don't `detach()` leaves in `onunload` — it destroys the user's layout. Open `.sheet` tabs will show "no view of type…" until re-enable; that is expected and accepted.
- Engines that attach `document`-level key handlers will eat Obsidian hotkeys if not torn down. Destroy the engine in `onClose()`.
- `Platform.isMobile` — gate mobile-hostile behaviour rather than setting `isDesktopOnly`.

---

## 2. Spreadsheet engine — measured, not estimated

Bundled with esbuild (`--bundle --minify --format=cjs --target=es2021 --platform=browser`, `NODE_ENV=production`) — i.e. the exact `main.js` scenario.

| Library | npm | Ver / published | Wk DL | License | min JS | gzip | CSS min | Framework | Formulas |
|---|---|---|---|---|---|---|---|---|---|
| **Jspreadsheet CE** | `jspreadsheet-ce` | 5.0.4 / 2025-08-25 | 94.9k | **MIT** | **474 KB** | **128 KB** | 69 KB | vanilla, DOM `<table>` | built-in, incl. VLOOKUP/SUMIF |
| FortuneSheet | `@fortune-sheet/react` | 1.0.4 / 2025-11-06 | 52.8k | MIT | 3726 KB | 641 KB | 49 KB | React ≥18.2 only | formulajs fork, 397 fns |
| Univer | `@univerjs/presets` | 0.25.1 / 2026-07-25 | 320k | Apache-2.0 (+Pro commercial) | **10612 KB** | **2594 KB** | 80 KB | React + rxjs | own engine |
| RevoGrid | `@revolist/revogrid` | 4.23.24 / 2026-07-23 | 28.8k | MIT (+Pro) | 312 KB | 94 KB | injected | Stencil web component | **Pro only** |
| glide-data-grid | `@glideapps/glide-data-grid` | 6.0.3 / **2024-02-03** | 301k | MIT | 448 KB (incl. React) | 148 KB | 12 KB | React only | none |
| Handsontable | `handsontable` | 18.0.0 / 2026-06-30 | 292k | **proprietary dual** | 1247 KB | 297 KB | 178 KB | vanilla | none |
| AG Grid | `ag-grid-community` | 36.0.2 / 2026-07-22 | 3.2M | MIT | 618 KB min | 174 KB | 203 KB | vanilla | none |
| canvas-datagrid | `canvas-datagrid` | 0.4.7 / 2023-12-29 | 7.9k | BSD-3 | 237 KB | 61 KB | none | web component | none |
| x-spreadsheet | `x-data-spreadsheet` | **1.1.9 / 2021-05-20** | 10.3k | MIT | 198 KB (UMD) | 43 KB | 40 KB | vanilla canvas | **11 functions** |
| wolf-table | `@wolf-table/table` | **0.0.3 / 2024-03-06** | 954 | MIT | 88 KB | 25 KB | own | vanilla canvas | **none** |
| *baseline* React 18 + ReactDOM | — | — | — | MIT | 139 KB | 44 KB | — | — | — |

**Formula engines**

| Engine | Ver | Wk DL | License | min / gzip | Notes |
|---|---|---|---|---|---|
| `hyperformula` | 3.3.0 / 2026-05-20 | 387k | **GPL-3.0-only** or paid | 570 / 136 KB | 418 functions. `licenseKey: 'gpl-v3'` mandatory at runtime. Bundling makes the whole plugin GPL-3.0. |
| `@formulajs/formulajs` | 4.6.0 / 2026-04-10 | 296k | **MIT** | 138 / 43 KB | 397 functions. Pure function library: no parser, no cell refs, no dependency graph. |
| `fast-formula-parser` | 1.0.19 / **2020-11-26** | 173k | MIT | 320 / 90 KB | Chevrotain parser with ranges/refs. Frozen 5.5 years. |
| `@jspreadsheet/formula` | 2.0.2 / 2023-05-18 | 104k | **none declared** | ~137 KB | Transitive dep of `jspreadsheet-ce`. |

### What existing Obsidian plugins did

| Plugin | Engine | Outcome |
|---|---|---|
| **Sheet Plus** (`ljcoder2015/obsidian-sheet-plus`) v2.12.11 | **Univer** + React + antd, Vite | The only actively maintained one. Partly commercial. Enormous. |
| **Spreadsheets** (`divamgupta/obsidian-spreadsheets`) v1.0.1, ext `.sheet` | **FortuneSheet** | Effectively abandoned. 27 open issues incl. **data loss** (#27, #29), no dark mode (hacked with `filter: invert(1)`). |
| **Excel** (`ljcoder2015/obsidian-excel`) | x-spreadsheet | Dead, 3 years. |
| **Workbooks** (`Canna71/obsidian-sheets`) | XLSX/CSV | Dead, 3 years. |
| **CalcCraft** | Math.js over markdown tables | Not a real grid. |

Known pain points, all confirmed from source or issue trackers:
- **CSS leaking.** FortuneSheet's stylesheet contains `html::-webkit-scrollbar-button { display: none; }` — hits the whole Obsidian app. x-spreadsheet ships `body { margin: 0 }`. Both need scoping (§3.3).
- **Theme conflicts.** All DOM-based grids hardcode `#fff`/`#ccc`/`#f3f3f3`. Needs an explicit Obsidian-CSS-variable override layer, not `filter: invert()`.
- **Context menus** positioned against `document` break inside Obsidian's transformed panes.
- **Mobile** is universally broken in these plugins.
- **Sizing.** Every engine needs an explicit height and a resize kick.

### RECOMMENDATION: `jspreadsheet-ce@5.0.4`

Rationale:
1. **MIT** (verified LICENSE file); `jsuites` also MIT. Note `package.json` omits the `license` field — the LICENSE file is authoritative.
2. **474 KB min / 128 KB gz** — 7.8× smaller than FortuneSheet, 22× smaller than Univer. Single `main.js`, zero runtime fetches (verified offline from `file://`).
3. **Vanilla** — no React in the bundle.
4. **Formulas built in and real.** `parseFormulas?: boolean`, `executeFormula(expression, x?, y?)`, `onbeforeformula` hook, `formula: Record<string, string[]>` dependency map. `VLOOKUP`, `SUMIF`, `IFERROR`, `SUMPRODUCT`, `TEXTJOIN` present in dist. **No HyperFormula, therefore no GPL.**
5. **Google-Sheets-like UX out of the box:** arrow-key nav, in-cell editing, column resize + `columnDrag`, copy/paste, `mergeCells`, `freezeColumns`, multi-worksheet tabs, `lazyLoading`, context menu, undo/redo.
6. **DOM `<table>` rendering** means Obsidian theming, text selection, accessibility work naturally.
7. **Maintained**: commits through 2026-04-10, 7.2k stars, 95k weekly downloads; vendor's Pro line very active.

Key API:

```ts
import jspreadsheet from "jspreadsheet-ce";
const instance = jspreadsheet(containerEl, {
  worksheets: [{
    minDimensions: [26, 100],
    data: [[...]],
    columns: [{ width: 100 }, ...],
    mergeCells: { "A1": [2, 2] },
    freezeColumns: 1,
  }],
  parseFormulas: true,
  onafterchanges: (ws, changes) => { this.dirty = true; this.scheduleSave(); },
});
const ws = instance[0];
ws.getData(); ws.setData(data); ws.getValue("C1"); ws.setValueFromCoords(x, y, v);
```

`onafterchanges(instance, changes)` fires *after* all changes are applied — the autosave hook.

**Caveat:** `jspreadsheet-ce@5` depends on `@jspreadsheet/formula@2.0.2` which declares **no license**. Distributed as a required dep of an MIT package by the same company; for a personal plugin it is a non-issue.

**Fallback A: FortuneSheet** `@fortune-sheet/react@1.0.4` (MIT, 3.7 MB, React-locked). Only if merged cells + rich styling + Luckysheet import are hard requirements.
**Fallback B: custom grid + `@formulajs/formulajs`** (~138 KB + own grid), possibly with `canvas-datagrid`.

**Explicitly rejected:** Univer (10.6 MB), Handsontable (proprietary), HyperFormula (GPL-3.0 viral), x-spreadsheet (dead since 2021, fails to bundle without `.less`/`.svg` loaders — reproduced), wolf-table (abandoned), RevoGrid (formulas Pro-only + `customElements.define` collision on re-enable), glide-data-grid (React-only, no formulas).

---

## 3. Build toolchain

### 3.1 esbuild

Start from the official `obsidian-sample-plugin` config:

```js
import esbuild from 'esbuild';
import process from 'process';
import { builtinModules } from 'node:module';

const prod = process.argv[2] === 'production';

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: [
    'obsidian', 'electron',
    '@codemirror/autocomplete', '@codemirror/collab', '@codemirror/commands',
    '@codemirror/language', '@codemirror/lint', '@codemirror/search',
    '@codemirror/state', '@codemirror/view',
    '@lezer/common', '@lezer/highlight', '@lezer/lr',
    ...builtinModules,
  ],
  format: 'cjs',
  target: 'es2021',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  minify: prod,
});

if (prod) { await context.rebuild(); process.exit(0); } else { await context.watch(); }
```

`format: 'cjs'` and `external: ['obsidian']` are non-negotiable.

`package.json`: `"type": "module"`, `esbuild 0.25.5`, `typescript ^5.8.3`, `obsidian: latest`, scripts `dev`/`build` (`tsc -noEmit -skipLibCheck && node esbuild.config.mjs production`).

`tsconfig.json`: `target ES2021`, `module ESNext`, `moduleResolution node`, `strict true`, `noUncheckedIndexedAccess true`, `isolatedModules true`, `allowSyntheticDefaultImports true`, `lib ["ES2021","DOM"]`, `include ["src/**/*.ts"]`.

Add for the grid: `loader: { '.svg': 'dataurl', '.png': 'dataurl' }` so any asset referenced from vendor CSS is inlined (mandatory — no CDN, no `app://` chunk fetches).

### 3.2 Getting CSS into `styles.css`

Obsidian only loads `styles.css`. esbuild emits `main.css` for imported CSS, which Obsidian **ignores**. **Recommended:** esbuild `onEnd` plugin that reads the emitted `main.css`, scopes it, concatenates your own theme layer, and writes `styles.css`.

### 3.3 Scoping vendor CSS — verified working

`postcss-prefix-selector`, verified against the real jspreadsheet CSS (70,785 → 79,317 bytes, `:root`/`html`/`body` rewritten rather than prefixed):

```js
import postcss from 'postcss';
import prefixer from 'postcss-prefix-selector';

const scoped = await postcss([prefixer({
  prefix: '.leovale-sheet-root',
  transform(prefix, selector, prefixedSelector) {
    if (/^(html|body|:root)\b/.test(selector)) return selector.replace(/^(html|body|:root)/, prefix);
    return prefixedSelector;
  },
})]).process(vendorCss, { from: undefined });
```

Then append a theme bridge, mapping the grid's hardcoded colours onto Obsidian variables:

```css
.leovale-sheet-root {
  --jss-border-color: var(--background-modifier-border);
  color: var(--text-normal);
}
.leovale-sheet-root .jss_worksheet { background-color: var(--background-primary); }
.leovale-sheet-root .jss_worksheet > thead > tr > td { background-color: var(--background-secondary); color: var(--text-muted); }
.leovale-sheet-root .jss_worksheet > tbody > tr > td { border-color: var(--background-modifier-border); }
.leovale-sheet-root .jss_worksheet td.highlight { background-color: var(--text-selection); }
```

Do **not** use `filter: invert(1)` for dark mode.

### 3.4 Global `document`/`window`

Fine in Obsidian. Two constraints: (a) tear down document-level listeners in `onClose`, or the grid eats Obsidian hotkeys after the tab closes; (b) never `customElements.define` without a `customElements.get()` guard.

### 3.5 React

Not needed for jspreadsheet-ce (vanilla). If ever needed: React 18 + ReactDOM = 139 KB min / 44 KB gz, or alias to Preact via esbuild `alias`.

---

## 4. Testing without a human (CDP)

All verified live on this machine against Obsidian 1.12.7 / Electron 39.6.0.

### 4.1 CDP works

```powershell
& "C:\Program Files\Obsidian\Obsidian.exe" --remote-debugging-port=9222
```

`/json/version` returns Electron/Chrome/obsidian versions. `%APPDATA%\obsidian\DevToolsActivePort` gets the port + GUID.

### 4.2 Playwright attach

```js
import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { noDefaults: true });
const ctx = browser.contexts()[0];                       // always exactly one
const page = ctx.pages().find(p => p.url() === 'app://obsidian.md/index.html');
await page.waitForFunction(() => !!window.app?.workspace?.layoutReady);
// ...
await browser.close();   // detaches only — Obsidian survives (verified)
```

Select the page by **URL, not by type** (DevTools windows also appear as `type:"page"`). The vault picker is `app://obsidian.md/starter.html` and has **no `window.app`**. `noDefaults: true` (Playwright ≥1.60) suppresses focus/media emulation.

Caveats: `browser.newContext()` fails; `page.viewportSize()` is `null`; no video/HAR. **`playwright._electron.launch()` does NOT work with Obsidian** (fuse `node_cli_inspect = DISABLED`). `connectOverCDP` is the only route.

### 4.3 `--remote-allow-origins`

Not needed from Node (no `Origin` header sent). Needed only from a browser tab/extension. Always connect via `127.0.0.1` or `localhost` (Host validation since March 2026).

### 4.4 Driving the app

```js
app.vault.getName();
app.commands.executeCommandById('leovale-sheets:create-sheet');   // returns boolean
const f = await app.vault.create('probe.sheet', '{}');
app.vault.getAbstractFileByPath('probe.sheet');
await app.workspace.getLeaf(true).openFile(f);
app.plugins.plugins['leovale-sheets'];                            // live instance
app.commands.executeCommandById('app:reload');                    // renderer restart
```

`app:reload` drops the connection; the app returns in ~6-9 s and **the CDP target id is unchanged**.

### 4.5 Screenshots

`page.screenshot()` works. `clip.scale:2` or `Emulation.setDeviceMetricsOverride {deviceScaleFactor:2}` for hi-res. Use `page.screenshot({scale:'css'})` for CSS pixels. If black frames: `captureBeyondViewport:true` is the usual culprit; `fromSurface:false` is the escape hatch.

### 4.6 Target list

`/json` → one `type:"page"` at `app://obsidian.md/index.html` plus ~10 workers. `/json/version` carries the browser-level `webSocketDebuggerUrl`.

### 4.7 hot-reload plugin

`https://github.com/pjeby/hot-reload`, id `hot-reload`, v0.3.1. Install = drop `main.js` + `manifest.json` into `<vault>/.obsidian/plugins/hot-reload/`. A plugin is "in development" iff its folder contains **`.git` or `.hotreload`**. Only `main.js` and `styles.css` trigger reloads, 750 ms debounce. Target must already be in `community-plugins.json`. esbuild `--watch` skips writing unchanged output — the #1 "hot reload stopped working" cause.

### 4.8 Enabling a plugin without the UI

`.obsidian/community-plugins.json` is a flat array: `["leovale-sheets", "hot-reload"]`.

| Call | Loads now | Adds to `enabledPlugins` | Writes the JSON |
|---|---|---|---|
| `app.plugins.enablePlugin(id)` | yes | **no** | **no** |
| `app.plugins.enablePluginAndSave(id)` | yes | yes | yes (debounced ~1 s) |

For a freshly written plugin dir:

```js
await app.plugins.loadManifests();                 // else manifests are stale
await app.plugins.enablePluginAndSave('leovale-sheets');
await new Promise(r => setTimeout(r, 1500));       // saveConfig is debounced
```

**The trap:** Restricted Mode. In a fresh vault `app.plugins.isEnabled()` is `false` and `enablePlugin` **silently no-ops**. Fix with `app.plugins.setEnable(true)` over CDP once (persists in renderer localStorage as `enable-plugin-<app.appId>`, NOT in any vault file). Plugin load failures do not reject: check `app.plugins.plugins[id]` and the console.

### 4.9 Isolation — sandbox instance

Single-instance lock is keyed to **user-data-dir**. Different dir → fully independent app with its own debug port.

```powershell
Start-Process "C:\Program Files\Obsidian\Obsidian.exe" -ArgumentList `
  "--user-data-dir=`"$SP\obsidian-udata`"", "--remote-debugging-port=9333"
```

Seed `<user-data-dir>\obsidian.json` **before** first launch to auto-open a vault:

```json
{"vaults":{"8e16a75ae626d1bc":{"path":"C:\\path\\to\\test-vault","open":true,"ts":1785079767623}},"updateDisabled":true}
```

**Write it without a BOM.** PowerShell 5.1 `Set-Content -Encoding utf8` emits BOM → Obsidian lands on `starter.html`. Use `[System.IO.File]::WriteAllText($p, $json, (New-Object System.Text.UTF8Encoding $false))`.

Runtime alternative: `require('electron').ipcRenderer.sendSync('vault-open', 'C:\\path\\to\\vault', false)`. `obsidian://open?vault=…` as a CLI arg does **not** work for driving a sandbox instance. A fresh user-data-dir self-updates its `.asar` on first run even with `updateDisabled:true`.

### 4.10 Console

```js
page.on('console', m => console.log(m.type(), m.text(), m.location()));
page.on('pageerror', e => console.log(e.message, e.stack));
```

Plugin crashes surface as `error  Plugin failure: <id> Error: …`. For startup logs use raw CDP (`ctx.newCDPSession(page)`, subscribe to `Runtime.consoleAPICalled`/`Runtime.exceptionThrown` **before** enabling).

### 4.11 Recommended harness

Second instance, own user-data-dir, throwaway vault. BOM-free seeded `obsidian.json`. `connectOverCDP` with `noDefaults:true`. `setEnable(true)` once. Then `enablePluginAndSave` + disable/enable cycles. **Never attach a destructive test to the user's running Obsidian on port 9222.**

> Playwright 1.61.1 is in `H:\repo\infra` devDependencies; no browser binaries installed and none needed for CDP attach.

---

## 5. File format

Do **not** persist the engine's internal state (`getData()` is dense, no styles, unstable). Own sparse JSON:

```json
{
  "format": "leovale-sheet",
  "version": 1,
  "sheets": [
    {
      "name": "Sheet1",
      "rows": 100,
      "cols": 26,
      "colWidths": { "0": 140, "3": 90 },
      "rowHeights": {},
      "merges": [],
      "cells": {
        "A1": { "v": "Item" },
        "B1": { "v": "Qty" },
        "A2": { "v": "Widget" },
        "B2": { "v": 3 },
        "C2": { "f": "=B2*2" }
      }
    }
  ]
}
```

Cell keys, fixed order: `v` (string | number | boolean), `f` (formula source, only when formula), `s` (style, omitted when empty). Never store computed formula results — recompute on load.

### Serialization rules — all load-bearing for LiveSync

LiveSync syncs every vault file; conflict resolution for non-markdown is **last-modified-wins** (no merge). Content-defined chunking. Therefore:

1. **Deterministic key order.** Sheets in array order; cell keys sorted by `(row, col)`; sub-keys in fixed order `v, f, s`.
2. **Pretty-print, 2-space indent, one cell per line.** One edited cell → one changed line → LiveSync ships a few KB instead of the whole file.
3. **LF endings, trailing newline.** Never `\r\n`.
4. **Numbers:** reject `NaN`/`Infinity` at write time.
5. **Sparse cells.** Never emit empty cells.
6. **`version` field** with a migration switch; unknown future version → render read-only with a notice.

### Autosave policy

```ts
private saveTimer: number | null = null;
private scheduleSave() {
  this.dirty = true;
  if (this.saveTimer) window.clearTimeout(this.saveTimer);
  this.saveTimer = window.setTimeout(() => { this.saveTimer = null; this.requestSave(); }, 1500);
}
```

`requestSave()` is itself debounced 2 s by Obsidian → ~1.5-3.5 s quiet before a write. Clear the timer in `onClose`, and force `await this.save()` in `onClose` when dirty.

---

## Recommended architecture

```
src/
  main.ts          Plugin: registerView, registerExtensions (try/catch),
                   command + ribbon + file-menu (TFolder guard), createSheet()
  view.ts          SheetView extends TextFileView
                     getViewData()  -> serialize, with lastGood fallback (never "")
                     setViewData()  -> parse, build engine, render
                     clear()        -> destroy engine, empty container
                     onClose()      -> flush if dirty, destroy engine, disconnect RO
  engine.ts        jspreadsheet-ce wrapper: doc <-> worksheets mapping,
                   onafterchanges -> scheduleSave(), ResizeObserver -> refresh
  format.ts        newSheetDoc(), parseSheet(text), serializeSheet(doc)
                   deterministic key order, 2-space indent, LF, trailing \n
  styles/
    theme.css      Obsidian CSS-variable bridge, scoped to .leovale-sheet-root
esbuild.config.mjs sample-plugin base + dataurl loaders + onEnd:
                   postcss-prefix-selector(main.css) + theme.css -> styles.css
manifest.json      minAppVersion 1.7.2, isDesktopOnly false
```

Budget: ~500 KB `main.js`, ~75 KB `styles.css`, MIT throughout.

Build order: (1) manifest + esbuild + empty `TextFileView` that round-trips text, proven via CDP; (2) `format.ts` with unit-tested deterministic serialization; (3) engine wiring + autosave with the anti-truncation guard; (4) creation entry points; (5) CSS scoping + theme bridge; (6) CDP screenshot pass in light and dark themes.
