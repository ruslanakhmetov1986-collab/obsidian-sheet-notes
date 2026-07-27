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

![A sheet embedded in a note: caption, formats, a cropped plain range](tests/shots/12-embed-light.png)

![The same note in the dark theme](tests/shots/13-embed-dark.png)

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

The interface follows Obsidian's own interface language (Settings, About,
Language) and ships twelve of them: English, Russian, Simplified Chinese,
Traditional Chinese, German, French, Spanish, Japanese, Korean, Brazilian
Portuguese, Italian and Polish. A region code resolves to its language
(`de-AT` → German), Traditional Chinese is a table of its own (`zh-TW`,
`zh-Hant`, `zh-HK`), European Portuguese uses the Brazilian table, and anything
else falls back to English. Command names stay English, which is the Obsidian
convention.

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
| Number format, `# ⌄` | Menu: Auto, `0.00`, `#,##0`, `#,##0.00`, `0%`, currency in $, € or ₽, `yyyy-mm-dd`, date and time. The live mask is shown on the button |
| Alignment | One menu for both axes: left / center / right, then top / middle / bottom |
| Wrap text | Toggle. Long text wraps inside the cell and the row grows to fit it |

Formatting applies to the entire selected range, not just the active cell.
Text colour inside a filled cell is picked automatically from the fill's
luminance, so a pale yellow background stays readable in the dark theme too.

### Number and date formats

A format is a **display mask**; the cell keeps its raw value. `3` formatted as
currency shows `$3.00`, the formula bar still shows `3`, and the file still
stores `"v": 3`. So the file stays locale-independent, and removing the format
gives the plain number back. A formula cell can be formatted too: `=SUM(B2:B3)`
shows `$7.00` while the file keeps the formula.

The masks are excel-like strings and are written into the file verbatim
(`"nf": "$#,##0.00"`), which means the same file renders the same everywhere.
Typing is unaffected: you always type and edit the raw value.

A date is a value plus a date mask, not a separate cell type. `2026-07-27`,
`27.07.2026` and a spreadsheet serial number are all understood, and rendering
is done in UTC so the day shown is the day written in the file. Masks the
formatter cannot read, and values that are not numbers or dates, are displayed
unchanged - a text cell with a currency format shows its text, never an error.

Custom masks beyond the menu presets work as long as they follow the same shape
(`prefix #,##0.00 suffix`, `0%`, or a date mask); a mask can be edited in the
file directly. Multi-section masks (`positive;negative`) are not interpreted.

### Embedding a sheet in a note

A spreadsheet can be shown inside a Markdown note, read-only:

````markdown
![[Budget.sheet]]                   the first worksheet, cropped to its used range
![[Budget.sheet#Sheet2]]            a named worksheet
![[Budget.sheet#Sheet2!A1:D20]]     a range of it
![[Budget.sheet|plain]]             no headers, no frame, transparent background

```sheet
Budget.sheet#Sheet2!A1:D20
```
````

Both work in reading view and in live preview. `.lsheet` and `.csv` can be
embedded the same way.

- The embed is read-only: no toolbar, no formula bar, no in-cell editor. Values,
  formats and computed formulas are all rendered.
- Without an explicit range it shows the filled part of the sheet rather than
  100 empty rows. Taller embeds scroll inside themselves (capped at 60% of the
  window height).
- The caption above the grid names the file, the worksheet and the range;
  clicking it opens the spreadsheet in a new tab. `|plain` removes it along with
  the row numbers, the column letters and the background.
- Editing the spreadsheet updates every embed of it, in place, while you watch.
- The code block form takes the same reference, or `path:` / `sheet:` /
  `range:` / `plain:` on separate lines.

### Saving

Saving is automatic: roughly 1.5 s after you stop editing, the plugin asks
Obsidian to save (Obsidian adds ~2 s of its own). Closing a tab flushes any
pending changes. `Sheets: Save spreadsheet now` writes the file immediately.

## The `.sheet` file format

Plain JSON, sparse, with a strictly fixed key order:

```json
{
  "format": "leovale-sheet",
  "version": 2,
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
        "B2": { "v": 3, "s": { "nf": "$#,##0.00", "ha": "r" } },
        "C2": { "f": "=B2*2" },
        "D2": { "v": "a long sentence", "s": { "wrap": true } }
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
  top/right/bottom/left, in that order), `nf` (number/date mask),
  `ha` (horizontal alignment, `l` / `c` / `r`), `va` (vertical alignment,
  `t` / `m` / `b`), `wrap` (`true`)

### Format versions

`version` is 2 since release 1.2.0, which is when `nf`, `ha`, `va` and `wrap`
were added. Two rules follow from it and both matter:

- **Files written by 1.1.x (version 1) keep opening**, with everything in them.
  Nothing is migrated or rewritten; the version line is the only thing that
  changes when you save such a file.
- **Every save writes version 2**, even for a document that came in as version 1.
  This is deliberate: a 1.1.x build does not know the new style keys and its
  normalizer DROPS unknown properties, so letting it write the file would
  silently strip every number format and alignment in the document. Version 2 is
  newer than that build understands, so it opens the file read-only instead -
  which is the whole point of the version field.

The new keys are appended AFTER `bd` rather than sorted in, so a file re-saved
by this release differs from the 1.1.x one only by the added tail of each style.

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
- **Opening a file cannot change it.** Mounting a grid fires a lot of events, and
  a straggler from the document being replaced (a blur from a focused formula
  bar, an in-cell editor closing) used to be able to arrive after the next one
  was on screen - which is how an old typed value could reappear in a cell of
  another file. Three things now make that impossible: the formula bar refuses to
  commit into an engine other than the one the edit started in and is disarmed
  before teardown, an open in-cell editor is discarded rather than saved when the
  view reloads, and nothing at all may mark the document dirty in the first
  250 ms after a load. The e2e suite asserts that opening a file leaves it clean
  and its bytes untouched.

## Development

```bash
npm install          # node_modules ~40 MB
npm run build        # tsc --noEmit + esbuild production -> main.js, styles.css
npm run dev          # esbuild --watch
npm test             # 128 unit tests: format, styles, masks, CSV, embeds, i18n
npm run e2e          # e2e in a sandboxed Obsidian, screenshots into tests/shots/
```

Build output: `main.js` ~570 KB, `styles.css` ~107 KB.

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

The e2e suite (243 assertions) launches a separate Obsidian instance with its
own `--user-data-dir` on CDP port 9333, so your running Obsidian is left alone.
It installs and enables the plugin, creates a sheet, types values and formulas
with real keyboard events, drags column and row edges, formats a selection with
real toolbar clicks, edits a formula through the formula bar, checks that the
row-number gutter stays put during a horizontal scroll, waits for autosave,
reads the file from disk and checks the format, reopens it, switches themes and
locales (twelve of them), applies a currency format to a range including a
formula, aligns and wraps cells and checks the bytes that come out, reloads the
plugin twice to prove the engine's global handlers are not doubled, embeds the
sheet in a note in both markdown modes and edits the source while the embed is on
screen, emulates the tablet (800x1340, `mobile: true`, `body.is-mobile`) to
measure touch targets, round-trips a semicolon-delimited CSV through the real
view, and finally pretends a foreign plugin owns `.sheet` to check the notice
and the `.lsheet` fallback. Screenshots land in `tests/shots/`. Playwright is
needed for e2e only: either `npm i -D playwright` or point `SHEETS_PLAYWRIGHT`
at an existing install.

Two things the harness does that are worth knowing before touching it. It
refuses to drive anything that is not a desktop Obsidian it launched: a leftover
`adb forward tcp:9333` to a phone answers CDP exactly like a sandbox does, and
its vault is real, so both the page URL and the vault path are checked first
(`SHEETS_CDP_PORT` moves the port if something else owns 9333). And the sandbox
is launched with `--disable-features=CalculateNativeWinOcclusion`: without it a
window that ends up behind another one is reported as hidden, rendering stops,
and every click times out on "waiting for element to be stable" with the grid
perfectly present in the DOM.

## Releases

Every push to master is built, tested and published as a release
automatically, with a patch version bump. Commit message markers: `[minor]`
and `[major]` bump the respective part, `[skip release]` builds and tests
without releasing. See `.github/workflows/release.yml` and
`scripts/bump-version.mjs`.

## Limitations

- Dragging columns and rows is disabled. Order is stored by index, not by id,
  so reordering would make the saved order a lie.
- Formatting covers fill, font size, bold, borders, number and date formats,
  alignment and text wrapping. No italics, underline or font family.
- Number formats are display masks read by this plugin. Excel understands the
  same strings, but nothing converts them: a `.sheet` file is not an `.xlsx`.
- Multi-section masks (`positive;negative;zero`) are stored but only their first
  section is interpreted; there is no calendar picker, a date is a value plus a
  date mask.
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
  are not saved for them, and a formula is stored as its text. A CSV embedded in
  a note therefore shows values only.
- An embedded sheet is read-only by design: it has no toolbar, no formula bar
  and no save path, and a grid that accepted keystrokes it then threw away would
  be worse than one that does not.
- The formula bar edits the anchor cell of the selection, one cell at a time.
  There is no range editing and no autocomplete for function names.
- On touch devices the remaining rough edges are: no gesture for selecting a
  range (drag scrolls, as it should), and a swipe that starts on Obsidian's own
  edge zone still opens the sidebar. The gutter now stays frozen, the bottom row
  clears the navigation bar, controls are 44 px, and long formulas are edited in
  the formula bar. Fixed on an Android tablet at 800x1340; phones untested.

## Gotchas worth knowing

Reloading the plugin doubled every arrow key. The grid engine installs `keydown`
and `mousedown` handlers on `document` and only drops them from inside
`destroy(el, true)`. Each load of the plugin gets its own copy of the bundled
engine with its own handlers, and a leftover copy is not idle: its `mousedown`
adopts whatever grid was clicked, so its `keydown` moves the same selection
again. Ten reloads with a sheet tab open, and one press of ArrowRight moved
eleven columns. Since 1.2.0 an embedded sheet is a second live instance, so no
individual teardown may remove the shared handlers any more: they are released
once, on plugin unload, by `releaseEngineGlobals()`. Which needs a live instance
to work through, hence the throwaway 1×1 grid in there.

The engine's factory is asynchronous. `jspreadsheet(el, options)` returns the
worksheet array synchronously but assigns `el.spreadsheet` and pushes onto
`jspreadsheet.spreadsheet` in a promise continuation. So `destroy(el, true)`
called right after creation does nothing at all - and "nothing" is worse than it
sounds, because the instance has already installed the document handlers: a
no-op teardown ADDS a set instead of removing one. Anything that counts live
instances or destroys a fresh one has to wait for `el.spreadsheet` to appear.

A number mask cannot travel through the inline style. The engine's `setStyle`
parses the string it is handed by splitting on `;` and then `:`, so
`yyyy-mm-dd hh:mm` would arrive truncated at the colon. Masks therefore live in a
`data-nf` attribute on the cell, which is the same storage class as the inline
style: the engine moves it along when rows or columns are inserted, so nothing
has to be re-keyed by hand. Alignment and wrapping are ordinary CSS and do go
through the style, with one twist - `white-space` is assigned by the engine on
every cell update, so the wrap flag is stored as `overflow-wrap: break-word`
(which the engine never touches) and the wrapping itself is done by a class.

`text-align: left` is not "no alignment". The engine writes it onto every cell it
creates, from `columns[].align`, so reading it back as a real value would put an
alignment key on all 2600 cells of a fresh sheet. Left is the off value; only
center and right are persisted. `vertical-align` needed the opposite treatment:
its off value is `inherit`, because a table cell inherits `middle` anyway and
`middle` had to stay available as something the user chose.

Live preview does not use markdown post-processors for embeds. An `![[...]]`
there is a CodeMirror widget rendered by Obsidian's own embed machinery, so a
post-processor sees it only in reading view - the grid appeared in reading view
while the editing mode still showed Obsidian's generic file card. The embed
registry (`app.embedRegistry`, not public API, hence guarded) is what serves both
modes. That widget also builds its element DETACHED and sets `src`/`alt` on it
only when inserting, so `|plain` is not readable when the component is asked for:
it is re-read on the way to the first render, and once more on a short timer.

Obsidian styles tables inside `.markdown-rendered`, and an embedded grid is one.
Its `margin: 1em 0` showed as a gap above and below the grid inside the embed
frame, and its alternate-column rule would stripe the spreadsheet in the theme's
table colour. Both are neutralised for `.leovale-sheet-embed`; a cell fill is an
inline style and still wins.

`env(safe-area-inset-bottom)` is 0px in Obsidian's Android WebView. Measured on a
tablet whose real inset is 47.32px: the last row sat under the navigation bar and
tapping it opened Recents. Obsidian publishes the true value as its own
`--safe-area-inset-bottom`, so that goes first and `env()` stays as the fallback.

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
