# Spreadsheet Notes

Adds a new kind of note to Obsidian: a spreadsheet. Files with the `.sheet`
extension open in a Google Sheets-style grid instead of the Markdown editor.
You get cells, formulas, resizable columns and rows, and basic formatting.

Your data stays in your vault as plain-text JSON, so Git, Obsidian LiveSync and
any other sync tool can see it and diff it.

The plugin makes zero network requests. Nothing is uploaded, there is no
telemetry, no remote fonts or icons. The grid engine's assets are inlined into
the bundle.

## How this differs from Sheet Plus

Sheet Plus is the established spreadsheet plugin for Obsidian and it does much
more than this one: charts, pivot tables, images in cells, Excel import. If you
need those, use it. The differences below are the reasons this plugin exists.

- **Your data survives.** A file whose `version` is newer than the plugin
  understands opens read-only, serialization is guarded so a failure returns the
  last known-good bytes instead of an empty string, and line endings are LF
  only. The category leader has open data-corruption issues, including one
  caused by CRLF handling.
- **Plain, diffable JSON, one cell per line.** Editing one cell changes one line
  of the file, which is what Git and Obsidian LiveSync need to sync a few
  kilobytes instead of the whole document. Sheet Plus stores its data as a
  single-line JSON blob, so any edit rewrites the entire file as one diff line.
- **0.5 MB instead of 18.5 MB.** Sheet Plus exceeds Obsidian Sync's 5 MB
  per-file limit, so Obsidian Sync cannot carry the plugin itself.
- **Auditable in an afternoon.** MIT, one public dependency (Jspreadsheet CE),
  and the whole save path is in this repository. Sheet Plus keeps its save path
  in unpublished private modules and talks to a license server.
- **Scoped CSS, no global patching.** Every selector is prefixed with
  `.leovale-sheet-root`; nothing is added to `window` or to Obsidian's
  prototypes.
- **Editable on mobile.** Sheet Plus is read-only there. Here you can type,
  enter formulas and format cells on a tablet.

Документация на русском: [README.ru.md](README.ru.md)

![Spreadsheet in the light theme](tests/shots/02-filled-light.png)

![The same sheet in the dark theme](tests/shots/04-dark.png)

![Fill colour palette](tests/shots/06-palette-open-light.png)

![Tablet layout: 44 px controls, frozen row numbers](tests/shots/08-mobile-light.png)

## Requirements

Obsidian 1.7.2 or newer (the plugin relies on deferred views).

Mobile works: the core loop (open, edit, type, format, save, reopen) was tested
by hand on an Android tablet and held up, including formulas and the fill
palette. The row-number gutter stays frozen while you scroll sideways, toolbar
buttons and palette swatches are 44 px on touch devices, the last row is not
covered by the Android navigation bar, and the formula bar makes long formulas
editable. Some touch interactions are still rough, see Limitations. Phones are
untested.

The interface is English by default and switches to Russian when Obsidian's
interface language is Russian (Settings, About, Language). Command names stay
English, which is the Obsidian convention.

## Install

With [BRAT](https://github.com/TfTHacker/obsidian42-brat): install BRAT from
the community catalog, run `BRAT: Add a beta plugin for testing`, paste
`https://github.com/ruslanakhmetov1986-collab/obsidian-sheet-notes`. BRAT
downloads the latest release and keeps it updated.

Manually: grab `main.js`, `manifest.json` and `styles.css` from the
[latest release](https://github.com/ruslanakhmetov1986-collab/obsidian-sheet-notes/releases)
and copy them into `<your-vault>/.obsidian/plugins/leovale-sheets/`. Enable
Spreadsheet Notes in Settings → Community plugins. Restricted Mode has to be
off.

From the community catalog: not published there yet.

## Usage

Create a spreadsheet in any of three ways:

- command palette: `Sheets: Create new spreadsheet`
- the table icon in the left ribbon
- right-click a folder in the file explorer → New spreadsheet

The file lands wherever your "Default location for new notes" setting points
and opens in a new tab.

### Which extensions open in the grid

| Extension | Notes |
|---|---|
| `.sheet` | The preferred one. Registered unless another plugin already owns it |
| `.lsheet` | Always registered. Identical format, used when `.sheet` is taken |
| `.csv` | Opened in the same grid, saved back as CSV. See below |

Sheet Plus, Excel and Spreadsheets all claim `.sheet`, and Obsidian gives an
extension to exactly one view. If one of them got there first, this plugin shows
a notice naming the owner, leaves `.sheet` alone, and creates new spreadsheets as
`.lsheet` instead. Everything else works the same. Files you already have keep
opening in whichever plugin owns their extension; renaming a file to `.lsheet`
moves it here.

### CSV files

A `.csv` opens in the same grid and is written back as plain CSV.

- The delimiter is detected from the file (`,` or `;`) and preserved on save.
  The current one is shown as a badge on the right of the formula bar.
- Quoting follows RFC 4180: `"` doubles inside a quoted field, and a field is
  quoted on write only when it contains the delimiter, a quote or a newline.
- Line endings are LF, never CRLF, with a trailing newline.
- Formatting (bold, fill, font size, borders) applies on screen but is **not
  saved**: a CSV file has nowhere to put it. Neither are column widths, row
  heights or merges.
- Typing a formula works and it recalculates live, but the file stores the
  formula **text** (`=SUM(A1:A2)`), because that is all a CSV cell can hold.
  Open the same file in Excel and you get a real formula; open it in pandas and
  you get the string.
- Emptying every cell of a CSV does not write an empty file. That is the
  anti-truncation guard; delete the file instead.

The deterministic JSON serializer described below applies to `.sheet` and
`.lsheet` only.

### Formula bar

Above the toolbar sits one line: the address of the active cell and its raw
content. A cell holding `=SUM(B2:B3)` shows the formula there while the grid
shows `7`. Type into it and press `Enter` to commit; `Escape` reverts. It is the
primary way to edit formulas on a tablet, where the in-cell editor is only as
wide as the cell.

### Working with the grid

| Action | How |
|---|---|
| Enter a value | Click a cell and start typing, `Enter` to commit |
| Move around | Arrow keys, `Tab`, `Enter` |
| Enter a formula | Start with `=`, e.g. `=SUM(B2:B3)`, `=B2*2`, `=IF(B4>5;"yes";"no")` |
| Resize a column | Drag the right edge of the `A`, `B`, … header |
| Resize a row | Drag the bottom edge of the row number |
| Insert / delete rows and columns | Right-click a header |
| Copy, paste, undo, redo | `Ctrl+C` / `Ctrl+V`, `Ctrl+Z` / `Ctrl+Y` |

Column widths and row heights are stored in the file, so they survive closing
and reopening the note.

Formulas are evaluated by the bundled Jspreadsheet CE engine: `SUM`, `AVERAGE`,
`IF`, `VLOOKUP`, `SUMIF`, `IFERROR`, `SUMPRODUCT`, `TEXTJOIN` and a few hundred
more. Computed results are never written to the file. Only the formula source
is stored, and everything is recalculated on open.

### Formatting

A single flat toolbar sits above the grid: one 36 px row of borderless 28×28
icon buttons with thin separators between groups.

| Button | What it does |
|---|---|
| B | Bold. If any cell in the selection is not bold, all of them become bold; otherwise bold is cleared. The button highlights when the selection is bold |
| Font size, `18 ⌄` | Opens a native Obsidian menu: Default, 10, 12, 14, 16, 18, 24. The current size of the selection is shown on the button |
| Fill (bucket) | A 6×2 popup palette: no fill plus 11 colours. A strip under the bucket shows the current colour, like in Google Sheets |
| Borders (grid) | Menu: all borders, outer borders, no borders, then individual sides |

Formatting applies to the entire selected range, not just the active cell.
Text colour inside a filled cell is picked automatically from the fill's
luminance, so a pale yellow background stays readable in the dark theme too.

### Saving

Saving is automatic: roughly 1.5 s after you stop editing, the plugin asks
Obsidian to save (Obsidian adds ~2 s of its own). Closing a tab flushes any
pending changes. `Sheets: Save spreadsheet now` writes the file immediately.

## The `.sheet` file format

Plain JSON, sparse, with a strictly fixed key order:

```json
{
  "format": "leovale-sheet",
  "version": 1,
  "sheets": [
    {
      "name": "Sheet1",
      "rows": 100,
      "cols": 26,
      "colWidths": { "0": 180 },
      "rowHeights": { "1": 51 },
      "merges": {},
      "cells": {
        "A1": { "v": "Item", "s": { "b": true, "fs": 18, "bg": "#fff2cc", "bd": "trbl" } },
        "B2": { "v": 3 },
        "C2": { "f": "=B2*2" }
      }
    }
  ]
}
```

Cell keys, always in this order:

- `v` is the value (string, number or boolean)
- `f` is the formula source (in which case `v` is omitted)
- `s` is the style, also fixed order: `b` (bold), `fs` (font size in px),
  `bg` (fill, `#rrggbb`), `bd` (borders, a subset of `trbl`:
  top/right/bottom/left, in that order)

The serialisation rules exist for one reason: sync. Obsidian LiveSync resolves
conflicts on non-Markdown files last-write-wins, without merging, so the file
had better produce small, predictable diffs:

1. Key order is deterministic. Sheets by array position, cells by
   `(row, column)`, subkeys fixed. The same document always serialises to
   byte-identical output.
2. Two-space indent, one cell per line. Editing one cell changes exactly one
   line, so LiveSync ships kilobytes instead of the whole file.
3. `LF` line endings only, trailing newline, no BOM.
4. `NaN` and `Infinity` are never written.
5. Empty cells are omitted entirely: a 100×26 sheet with three filled cells is
   about 300 bytes.
6. A `version` field. A file with a version newer than the plugin knows opens
   read-only, so the plugin never overwrites data it does not understand.

Raw CSS never reaches the file. The engine keeps styles as inline CSS, but at
the boundary they are explicitly converted to the four normalised properties
and back (`src/cellcss.ts`).

## Data-loss protection

A known failure mode of spreadsheet plugins for Obsidian
(`obsidian-spreadsheets`, issues #27 and #29): `getViewData()` returns an empty
string and Obsidian truncates the file. People lost real data to that bug.
Three safeguards here:

- `getViewData()` goes through the engine only when the document is actually
  dirty; otherwise it returns the last known-good serialisation.
- If serialisation throws, or the result is suspiciously short, the same
  last known-good version is returned instead of an empty string.
- If a file cannot be parsed (broken JSON, foreign format), it opens read-only,
  and writing to it is impossible by construction.

## Development

```bash
npm install          # node_modules ~40 MB
npm run build        # tsc --noEmit + esbuild production -> main.js, styles.css
npm run dev          # esbuild --watch
npm test             # 74 unit tests: format, styles, CSV, i18n (node --test)
npm run e2e          # e2e in a sandboxed Obsidian, screenshots into tests/shots/
```

Build output: `main.js` ~520 KB, `styles.css` ~99 KB.

Notes on the build configuration:

- Obsidian loads only `styles.css`. esbuild writes imported CSS to `main.css`,
  which Obsidian silently ignores, so the `onEnd` step in `esbuild.config.mjs`
  takes `main.css`, runs it through `postcss-prefix-selector`, appends the
  theming layer and writes `styles.css`.
- The engine's CSS is scoped entirely to `.leovale-sheet-root`. `html`, `body`
  and `:root` selectors are replaced rather than prefixed, otherwise `:root`
  variables and `body { margin: 0 }` would leak into the whole app.
- The engine's hard-coded colours (`#fff`, `#ccc`, `#f3f3f3`) are remapped to
  Obsidian CSS variables. No `filter: invert(1)` anywhere.

The e2e suite (164 assertions) launches a separate Obsidian instance with its
own `--user-data-dir` on CDP port 9333, so your running Obsidian is left alone.
It installs and enables the plugin, creates a sheet, types values and formulas
with real keyboard events, drags column and row edges, formats a selection with
real toolbar clicks, edits a formula through the formula bar, checks that the
row-number gutter stays put during a horizontal scroll, waits for autosave,
reads the file from disk and checks the format, reopens it, switches themes and
locales, emulates the tablet (800x1340, `mobile: true`, `body.is-mobile`) to
measure touch targets, round-trips a semicolon-delimited CSV through the real
view, and finally pretends a foreign plugin owns `.sheet` to check the notice
and the `.lsheet` fallback. Screenshots land in `tests/shots/`. Playwright is
needed for e2e only: either `npm i -D playwright` or point `SHEETS_PLAYWRIGHT`
at an existing install.

## Releases

Every push to master is built, tested and published as a release
automatically, with a patch version bump. Commit message markers: `[minor]`
and `[major]` bump the respective part, `[skip release]` builds and tests
without releasing. See `.github/workflows/release.yml` and
`scripts/bump-version.mjs`.

## Limitations

- Dragging columns and rows is disabled. Order is stored by index, not by id,
  so reordering would make the saved order a lie.
- Formatting covers fill, font size, bold and borders. No italics, font
  family, alignment or number formats. Text is left-aligned, numbers included.
- The format supports multiple sheets per file, but there is no UI yet for
  creating a second sheet.
- Merged cells (`merges`) are saved and restored, but there is no toolbar
  button for them, only the engine's own context menu.
- Styles are bound to cell addresses. Inserting a row or column shifts them via
  the engine; exotic scenarios (sorting with styles) are untested.
- When the plugin is disabled, already-open `.sheet` tabs show "no view of
  type…". That is intentional: closing the user's tabs in `onunload` would
  rearrange their workspace.
- CSV files keep values only. Formatting, column widths, row heights and merges
  are not saved for them, and a formula is stored as its text.
- The formula bar edits the anchor cell of the selection, one cell at a time.
  There is no range editing and no autocomplete for function names.
- On touch devices the remaining rough edges are: no gesture for selecting a
  range (drag scrolls, as it should), and a swipe that starts on Obsidian's own
  edge zone still opens the sidebar. The gutter now stays frozen, the bottom row
  clears the navigation bar, controls are 44 px, and long formulas are edited in
  the formula bar. Fixed on an Android tablet at 800x1340; phones untested.

## Gotchas worth knowing

`dirty` is a taken name. `TextFileView` keeps its own undocumented `dirty`
field on the instance and resets it inside its own save logic. A
`private dirty` field in a subclass collides with it: the flag was being
cleared between our `scheduleSave()` and `getViewData()`, and the file silently
stayed in its just-created state. Full grid on screen, empty file on disk.
Every view field is therefore prefixed with `sheet` (`sheetDirty`,
`sheetEngine`, `sheetLastGood`, …). Do not rename them back.

Clicking the toolbar kills the selection. Jspreadsheet installs a `mousedown`
handler on `document` that clears the selection on any click outside the grid.
The toolbar therefore captures the selection at `mousedown` time, and the
engine also keeps the last selection from its `onselection` event.

Row heights are not applied from options. The `rows: { "1": { height: 51 } }`
option is accepted but has no effect on the first render. Heights are reapplied
with an explicit `setHeight()` after init, with autosave suppressed, otherwise
merely opening a file would mark it modified.

`setIcon()` with an unknown name silently draws nothing. The icons `grid-2x2`,
`borders` and `border-all` are absent from the Lucide set in current Obsidian
builds. `setIcon` neither throws nor logs, it just leaves an empty element,
which is how the Borders button was invisible for a while. Only verified names
are used, and the e2e suite asserts that every button and menu item really
rendered an `<svg>`.

`freezeColumns` does not freeze the row numbers. The engine's own freeze reads
`instance.content.scrollLeft`, i.e. its internal scroller, which only exists with
`tableOverflow: true`; here the whole grid scrolls inside our own wrapper. And it
freezes data columns, not the gutter. The gutter is `position: sticky; left: 0`
in our theme layer instead, with the corner cell sticky on both axes.

Swallowing `touchmove` arms a hidden trap. Obsidian mobile reads a horizontal
pan as "open the left drawer", so the grid stops `touchmove` from bubbling. But
the engine's `touchstart` (registered on `document`) arms a 500 ms timer that
opens the in-cell editor, and it cancels that timer from its own `touchmove`
listener, which is exactly the event we now eat. Without cancelling it
explicitly, a half-second scroll pops the editor open. `touchstart` itself must
keep bubbling, or tapping a cell stops selecting it.

Do not pass a second argument to `getNewFileParent()`. Calling
`getNewFileParent(path, "Untitled.sheet")` makes Obsidian look for a file
creator for that extension and log an error. The first argument is enough.

## License

MIT, see [LICENSE](LICENSE).

The grid engine is [Jspreadsheet CE](https://github.com/jspreadsheet/ce) 5.0.4
(MIT), with `jsuites` (MIT) and the `@jspreadsheet/formula` "Formula Basic"
engine (MIT per the vendor's banner in the distributed files). Full notices are
in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), and the bundle carries
them in a footer comment in `main.js`.
