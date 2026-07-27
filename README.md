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
more than this one: charts, pivot tables, images in cells. If you need those,
use it. The differences below are the reasons this plugin exists.

- **Your data survives.** A file whose `version` is newer than the plugin
  understands opens read-only, serialization is guarded so a failure returns the
  last known-good bytes instead of an empty string, and line endings are LF
  only. The category leader has open data-corruption issues, including one
  caused by CRLF handling.
- **Plain, diffable JSON, one cell per line.** Editing one cell changes one line
  of the file, which is what Git and Obsidian LiveSync need to sync a few
  kilobytes instead of the whole document. Sheet Plus stores its data as a
  single-line JSON blob, so any edit rewrites the entire file as one diff line.
- **1.2 MB instead of 18.5 MB.** Sheet Plus exceeds Obsidian Sync's 5 MB
  per-file limit, so Obsidian Sync cannot carry the plugin itself. (0.7 MB of
  the 1.2 is the `.xlsx` reader and writer, which is loaded lazily and never
  runs unless you import or export something.)
- **Auditable in an afternoon.** MIT, two public dependencies (Jspreadsheet CE
  and SheetJS), and the whole save path is in this repository. Sheet Plus keeps
  its save path in unpublished private modules and talks to a license server.
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

![Checkbox cells and wiki links in cells](tests/shots/19-links-checkboxes-light.png)

![The same sheet in the dark theme](tests/shots/20-links-checkboxes-dark.png)

![The same sheet as it goes to the printer](tests/shots/21-print-light.png)

![Fill colour palette](tests/shots/06-palette-open-light.png)

![Tablet layout: 44 px controls, frozen row numbers](tests/shots/08-mobile-light.png)

![The context menu on a tablet: translated, 44 px rows, no keyboard hints](tests/shots/23-context-menu-mobile.png)

## Requirements

Obsidian 1.7.2 or newer (the plugin relies on deferred views).

Mobile works: the core loop (open, edit, type, format, save, reopen) was tested
by hand on an Android tablet and held up, including formulas and the fill
palette. The row-number gutter stays frozen while you scroll sideways, toolbar
buttons and palette swatches are 44 px on touch devices, the last row is not
covered by the Android navigation bar, and the formula bar makes long formulas
editable. Scrolling with a finger no longer moves the selection, the sheet stays
where you scrolled it, the context menu is translated with 44 px rows, and
Obsidian's drawer still opens from the left edge of the screen - see
"Touch: what a finger does". Phones are untested.

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
  heights, merges, frozen panes, filters or checkbox cells - a checkbox in a CSV
  is the word `true` after a reload. Sorting is the exception: it moves the
  values themselves, so a sorted CSV stays sorted on disk. A `[[wiki link]]` is
  a plain string and survives, links and all.
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

`Enter` also **moves down one cell**, exactly like `Enter` typed into a cell, so
a column of values can be entered from the bar without touching the grid between
them. Who keeps the focus afterwards depends on the device, and deliberately so:

- **Desktop**: the focus goes back to the grid, so the arrow keys work again
  immediately. The bar is a convenience there; the grid is where you type.
- **Touch**: the field keeps the focus and the on-screen keyboard stays up. On a
  tablet this bar IS the editor, and dismissing the keyboard after every value
  would mean tap the next cell, tap the bar, type, for every single number.
  `Escape`, or a tap on the grid, puts the keyboard away.

### Working with the grid

| Action | How |
|---|---|
| Enter a value | Click a cell and start typing, `Enter` to commit |
| Move around | Arrow keys, `Tab`, `Enter` |
| Enter a formula | Start with `=`, e.g. `=SUM(B2:B3)`, `=B2*2`, `=IF(B4>5;"yes";"no")` |
| Resize a column | Drag the right edge of the `A`, `B`, … header |
| Resize a row | Drag the bottom edge of the row number |
| Insert / delete rows and columns | Right-click anywhere in the grid (long press on touch) |
| Context menu | Right click, or a long press on a tablet: edit, copy, paste, insert and delete rows and columns, merge |
| Copy, paste, undo, redo | `Ctrl+C` / `Ctrl+V`, `Ctrl+Z` / `Ctrl+Y` |
| Edit the active cell | `F2` |
| Fill down | `Ctrl+D` (the top row of the selection over the rest, or the cell above into a single cell) |
| Start / end of the row | `Home` / `End` (`End` stops at the last filled cell, not at column Z) |
| A1 / the last used cell | `Ctrl+Home` / `Ctrl+End` |
| Jump to the edge of the data | `Ctrl+←↑→↓` |
| Clear the selection | `Delete` |
| Find in the sheet | `Ctrl+F` |
| Save now | `Ctrl+S` |
| Exact column width | The `↔` toolbar button, or `Sheets: Set column width` |
| Fit a column to its content | Double-click the right edge of its header |
| Merge or split cells | The merge toolbar button, or `Sheets: Merge or split cells` |
| Turn cells into checkboxes | The checkbox toolbar button |
| Open a `[[link]]` in a cell | Click it (`Ctrl`-click for a new tab) |
| Print | `Sheets: Print spreadsheet` |
| Excel | `Sheets: Export as .xlsx` / `Sheets: Import .xlsx as sheet` |

Hold `Shift` with any of the movement keys to extend the selection instead of
moving it. These keys are live only while the grid itself has the focus: typing
in the formula bar, in the find box or inside a cell editor leaves them to the
text field, and everywhere else in Obsidian they stay Obsidian's own.

Column widths and row heights are stored in the file, so they survive closing
and reopening the note.

Formulas are evaluated by the bundled Jspreadsheet CE engine: `SUM`, `AVERAGE`,
`IF`, `VLOOKUP`, `SUMIF`, `IFERROR`, `SUMPRODUCT`, `TEXTJOIN` and a few hundred
more. Computed results are never written to the file. Only the formula source
is stored, and everything is recalculated on open.

### Touch: what a finger does

A tablet has no right button, no hover and no keyboard, and the grid engine's
own idea of a touch was "select whatever the finger landed on, immediately".
That is wrong the moment the finger was going to scroll. The rules here:

| Gesture | What happens |
|---|---|
| Tap | Selects the cell. The decision is taken when the finger LIFTS |
| Drag | Scrolls the sheet. The selection and the formula bar do not change |
| Long press (0.5 s) | Opens the context menu on that cell |
| Swipe from the left edge | Opens Obsidian's sidebar, under the conditions below |

**A scroll never takes the selection.** Nothing is selected while the finger is
down. On lift, the touch counts as a tap only if it stayed inside 10 px and
lasted under 300 ms; anything longer or further was a scroll, and a scroll
changes nothing. So the cell you were working on, and the formula it put in the
formula bar, survive a pan across the sheet.

**A scroll stays where you left it.** For 0.7 s after your gesture the plugin
will not scroll the grid on its own. Without that rule a pan to column M ended
with the sheet back at column A, because something asked, a moment later, for
the selected cell to be scrolled into view.

**The sidebar keeps the left edge.** Obsidian mobile reads a horizontal pan as
"open the drawer", and it listens for it above the grid - which is why the grid
stops that gesture from bubbling, or scrolling a sheet sideways would open the
file explorer instead. Since 1.4.x the rule is narrower: a touch that starts
within **24 px of the left screen edge** while the sheet is **scrolled fully
left** is Obsidian's, and the drawer opens as it does everywhere else. Anywhere
else on the grid, or with the sheet panned right (where a leftward swipe is
plainly meant to scroll it back), the gesture is the grid's. The header button
still opens the drawer too.

**The context menu is the plugin's own**, not the engine's: translated into all
twelve languages, 44 px rows on touch, and no `Ctrl+C` hints on a device with
no `Ctrl`. It carries: edit the cell, copy, paste, insert a row above or below,
insert a column left or right, delete the selected rows or columns, and merge or
split. On a desktop it is the same menu, on the right mouse button.

There is deliberately no long-press-to-edit any more (it used to fire in the
middle of a scroll). A press opens the menu, and the menu's first item is
"Edit cell".

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
| Merge (`⧉`) | Merges the selection into its top-left cell, or splits it again when the selection is already merged |
| Checkbox (`☑`) | Turns the selected cells into tick boxes, and back |
| Sort (`⇅`) | Sort A → Z, Z → A, or drop the sort marker. Acts on the column the selection starts in |
| Filter (funnel) | The distinct values of that column as checkable items, plus "Show all" and "Clear all filters" |
| Freeze (pin) | Freeze the rows above the selection, the columns before it, or both. "Unfreeze" undoes it |
| Find (magnifier) | The find strip, same as `Ctrl+F` |
| Column width (`↔`) | Exact width in pixels for every column in the selection, or "Fit to content" |

Formatting applies to the entire selected range, not just the active cell.
Text colour inside a filled cell is picked automatically from the fill's
luminance, so a pale yellow background stays readable in the dark theme too.

### Sorting, filters and frozen panes

All three are saved in the file, so a sheet reopens the way you left it.

**Sorting** moves whole rows. Fills, borders, number formats and everything else
a row carries travel with it, because in this format a row is what carries them:
the sort rewrites the document and rebuilds the grid rather than reordering the
grid's own rows. The column the sheet is sorted by keeps a small arrow in its
header.

- **Frozen rows are never sorted.** They are the headings, exactly like in Google
  Sheets. With nothing frozen, every row takes part.
- A sheet with **merged cells cannot be sorted**, and says so instead of trying:
  a merge spans addresses, and permuting the rows underneath one would tear it
  apart.
- **Formula references are not adjusted.** A formula that moves is moved as it
  was written, so `=B2*2` in a row that lands three rows down still says `B2`.
  You get a notice when that actually happened.
- Sorting is not undone by "Clear sort": the new order is the file's order now,
  and there is no previous one to go back to. The item only drops the marker.

**Filters** hide rows, they never touch them. The menu lists the values the
column actually holds; unticking one hides its rows, and the file remembers the
values that are still allowed. Blank cells are never hidden - blank is not one
of the values in the menu, so a filter that hid them would have no way back
except clearing it. A filtered column keeps a dot in its header.

**Frozen rows and columns** stay put while the rest of the grid scrolls. Put the
cursor where the frozen part should end (`B3` freezes two rows and one column)
and pick what to freeze.

![A sorted, filtered sheet with a frozen row](tests/shots/15-data-light.png)

![The frozen row stays while the sheet scrolls under it](tests/shots/18-freeze-scrolled-light.png)

### Merged cells

Select a range and press the merge button: the cells become one, and the value
of the top-left one is what stays. Anything else the range held is emptied, so
you are asked first, with the number of cells that are about to lose their
content. When nothing would be lost, nothing is asked.

The same button splits a merge again — it lights up while the cursor is inside
one — and splitting asks nothing, because a split cannot lose anything. The
cells that come back are empty; the value that survived the merge stays where it
was.

Merges live in the file (`"merges": { "A6": [2, 1] }`, columns first, then rows)
and are restored on open. **A sheet with merged cells cannot be sorted**: a merge
spans addresses, and permuting the rows underneath one would tear it apart. That
was true before the button existed, and the button does not change it — the
notice after a merge says so.

### Checkbox cells

The checkbox button turns the selected cells into tick boxes. A checkbox is a
cell TYPE, not a format: the file grows one key, `"t": "cb"`, and the value
underneath it becomes a real boolean.

```json
"B2": { "v": true, "t": "cb" }
```

- Clicking the box writes `true` or `false` and saves like any other edit.
- The values are left alone when you switch a column over: a column of
  `true`/`false` becomes a column of ticked and unticked boxes, and pressing the
  button again gives the words back.
- A cell that has never been ticked still ends up in the file (as `false`), or
  the box would vanish on the next save.
- A box is drawn in the middle of its cell, so a horizontal alignment set on a
  checkbox cell does not show.
- Fills, borders and the rest still apply, and a checkbox column exports to
  `.xlsx` as Excel's own TRUE/FALSE.

**Dropdown cells were cut.** The grid engine's cell types are a property of a
COLUMN (`columns[].type`), not of a cell: a dropdown would have to own the whole
column, with its option list living somewhere the column has no room for, and a
single-cell dropdown would fight the engine on every row insert. The checkbox
escapes that because it needs no per-cell configuration at all — it is drawn by
this plugin over the engine's own rendering, exactly like a number mask is. A
dropdown would need the engine's cooperation, and the engine offers it only per
column.

### Links to notes in cells

A cell whose text contains `[[Note]]` shows a real link, and clicking it opens
the note (`Ctrl`-click opens it in a new tab). Hovering it asks Obsidian for the
usual page preview, so the popover is the real one, with your own delay and
modifier settings.

- The FILE keeps the text exactly as typed. `[[Note]]` is a string like any
  other; nothing in the format knows about links, and an older build of the
  plugin shows the same cell as plain text.
- Aliases and headings work: `[[Note|shown text]]`, `[[Note#Heading]]`,
  `[[Note#^block]]`. Without an alias, `Note#Heading` reads as `Note > Heading`.
- While you EDIT the cell you see the raw text, brackets included, because that
  is what you are editing. The link comes back when you commit.
- `![[embeds]]` are not links: a note rendered inside a table cell is not a
  thing, so the `!` keeps the text as text.
- Links work in an embedded sheet too, where the click opens the note like a
  link in the surrounding note would.
- `Sheets: Copy selection as Markdown table` copies the SOURCE of a link cell,
  not its label, so the link keeps working in the note you paste it into.

### Printing

`Sheets: Print spreadsheet` opens the system print dialog with the sheet on the
page and nothing else: no toolbar, no formula bar, no ribbon, no tab bar, no
status bar. The grid stops being a scroll box and lays itself out in full, so
what prints is every row the sheet has rather than the part that was on screen,
and the column letters repeat at the top of every page.

Fills, borders and the number formats print as they are; the selection and the
frozen panes do not (a frozen pane is a scrolling idea, and `position: sticky`
on paper parks the pinned row on the first page and leaves a hole on the rest).
A checkbox prints as `☐` or `☑`, as a character rather than as a drawn control,
so it survives a printer with "background graphics" switched off and lands in
the text layer of a PDF.

Anything else in the window is left alone: the print rules only apply while a
spreadsheet is the active tab, so printing a note is Obsidian's own business,
exactly as before.

### Excel files

Two commands move a whole document between this plugin and Excel, LibreOffice,
Google Sheets or anything else that speaks `.xlsx`.

**`Sheets: Export as .xlsx`** (also on the right-click menu of a `.sheet` or
`.lsheet` file) writes `name.xlsx` next to the sheet and tells you where it
landed. It carries values, formulas, bold, font size, fills, borders, number
formats, alignment, text wrapping, column widths, row heights, merged cells, and
one worksheet per page. An existing `name.xlsx` is replaced: it is this sheet's
export, and exporting twice should leave one file rather than a numbered pile.
Exporting a file that is open in a tab exports what is IN the tab, including the
last second of typing that has not been saved yet.

**`Sheets: Import .xlsx as sheet`** asks for a file anywhere on disk; the
right-click menu of an `.xlsx` already in the vault does the same for that one.
Everything the export writes comes back, plus whatever Excel put there: a
multi-worksheet workbook becomes a multi-page document. The new file never
overwrites anything — `Budget.sheet`, then `Budget 1.sheet` — and opens in a new
tab.

What does not survive the trip:

- **Checkbox cells** become Excel's TRUE/FALSE, because `.xlsx` has no checkbox
  cell type. Importing them back gives booleans, and the checkbox button turns
  them into boxes again in one click.
- **Formula separators** are translated: `=IF(A1>5;"yes";"no")` is written as
  `IF(A1>5,"yes","no")`, which is the only form a `.xlsx` has. Semicolons inside
  a quoted string are left alone.
- **Formula results** are not written; Excel recalculates on open, which is the
  same rule this format follows.
- **Sort, filters and frozen panes** stay in the `.sheet` file. They are how the
  page is being looked at, and Excel models all three differently enough that a
  faithful translation would be a guess.
- **Everything Excel has and this plugin does not**: charts, images, pivot
  tables, conditional formats, defined names, several fonts, cell colours per
  character. They are dropped on import rather than half-rendered.
- **Worksheet names** are cut to 31 characters and lose `[ ] : * ? / \`, because
  Excel refuses to open a file whose sheet names do not follow its own rules.

### Finding text

`Ctrl+F` inside the grid (or the magnifier in the toolbar) opens a find strip
above the sheet. Matching cells are highlighted as you type, `Enter` and
`Shift+Enter` walk through them, the counter shows where you are, and `Escape`
closes the strip and clears the highlights. It searches what the sheet shows,
formula results included, and it changes nothing.

![Find in sheet](tests/shots/16-find-light.png)

### Markdown tables in and out

Two commands move a rectangle of cells between the grid and any Markdown note:

- `Sheets: Copy selection as Markdown table` puts the selection on the clipboard
  as a GitHub-style table, alignment row included (from the cells' own
  alignment). It copies what the sheet SHOWS, so `=SUM(B2:B3)` arrives as `7`
  and a currency cell as `$7.00` - a Markdown table of formula sources would be
  a table of something nobody asked for. Pipes in a value are escaped, and a
  value with a line break in it becomes one line with `<br>`.
- `Sheets: Paste Markdown table` reads a table from the clipboard into the grid,
  starting at the selected cell. The alignment row is optional, ragged rows are
  padded, outer pipes may be missing, and prose around the table is ignored. A
  value that starts with `=` becomes a formula, exactly as if it had been typed.
  Anything past the last row or column of the sheet is dropped rather than
  silently growing the file.

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
  "version": 4,
  "sheets": [
    {
      "name": "Sheet1",
      "rows": 100,
      "cols": 26,
      "colWidths": { "0": 180 },
      "rowHeights": { "1": 51 },
      "merges": { "A6": [2, 1] },
      "view": {
        "sort": { "col": 0, "dir": "asc" },
        "filters": {
          "1": [
            "Gadget",
            "Widget"
          ]
        }
      },
      "freeze": { "rows": 1 },
      "cells": {
        "A1": { "v": "Item", "s": { "b": true, "fs": 18, "bg": "#fff2cc", "bd": "trbl" } },
        "B2": { "v": 3, "s": { "nf": "$#,##0.00", "ha": "r" } },
        "C2": { "f": "=B2*2" },
        "D2": { "v": "a long sentence", "s": { "wrap": true } },
        "E2": { "v": true, "t": "cb" },
        "F2": { "v": "see [[Budget notes]]" }
      }
    }
  ]
}
```

Page keys are fixed too: `name`, `rows`, `cols`, `colWidths`, `rowHeights`,
`merges`, `view`, `freeze`, `cells`. The last two arrived in 1.3.0:

- `view` is how the page is being LOOKED at, and it never changes a cell:
  `sort` (`col` is a 0-based column index, `dir` is `asc` or `desc`) records the
  sort that was applied, and `filters` maps a column index to the values that
  column is still allowed to show, one per line so that ticking one value off
  changes one line. Both are omitted when unused, and the block is then `{}`.
- `freeze` is `{ "rows": n, "cols": n }`, zeroes omitted, `{}` when nothing is
  frozen.

Cell keys, always in this order:

- `v` is the value (string, number or boolean)
- `f` is the formula source (in which case `v` is omitted)
- `s` is the style, also fixed order: `b` (bold), `fs` (font size in px),
  `bg` (fill, `#rrggbb`), `bd` (borders, a subset of `trbl`:
  top/right/bottom/left, in that order), `nf` (number/date mask),
  `ha` (horizontal alignment, `l` / `c` / `r`), `va` (vertical alignment,
  `t` / `m` / `b`), `wrap` (`true`)
- `t` is the cell TYPE, and there is one: `"cb"`, a checkbox, whose `v` is a
  boolean. Arrived in 1.4.0, and it goes after `s` for the same reason every new
  key is appended rather than sorted in: a re-saved file differs from the older
  one only by the added tail of each cell

A type is deliberately not a style. `s` says how a value LOOKS, `t` changes what
the cell IS — which is also what lets a checkbox keep a fill, a border and an
alignment.

A `[[wiki link]]` needs no key at all: it is an ordinary string in `v`, and only
the rendering knows about it. That is why a build without the feature shows the
same cell as text and loses nothing.

### Format versions

`version` is 4 since release 1.4.0, which is when the cell type `t` was added; 3
was 1.3.0 (the `view` and `freeze` blocks), 2 was 1.2.0 (`nf`, `ha`, `va`,
`wrap`) and 1 was 1.1.x. Two rules follow and both matter:

- **Older files keep opening**, with everything in them. Nothing is migrated or
  rewritten; the version line, and whatever blocks a page did not have yet, are
  the only difference when such a file is saved.
- **Every save writes version 4.** This is deliberate, and it is the same
  argument every time: a build that cannot see a key DROPS it. A 1.3.0 build's
  cell parser copies `v`, `f` and `s` onto a fresh cell and never looks at `t`,
  so opening a 1.4.0 file there and saving it would turn a checkbox column into
  a column of `true`/`false` text. Version 4 is newer than that build
  understands, so it opens the file read-only instead - which is the whole point
  of the version field. Same for 1.2.0 builds and the `view`/`freeze` blocks of
  version 3, and for 1.1.x builds and the style keys of version 2.

Not every feature costs a version. 1.4.0 added three things and only one of them
is in the file: merged cells have been in the format since 1.1.x (`merges`),
1.4.0 only added a button for them, and a `[[wiki link]]` is a plain string that
every build stores and returns unchanged. The bump is for `t` alone, and it was
checked against the 1.3.0 parser rather than assumed.

New keys are appended rather than sorted in - the 1.2.0 style keys after `bd`,
the 1.3.0 blocks after `merges`, `t` after `s` - so a file re-saved by this
release differs from the older one only by the added lines. A v3 file with no
checkboxes in it gains exactly one changed line, the version.

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
npm install          # node_modules ~56 MB
npm run build        # tsc --noEmit + esbuild production -> main.js, styles.css
npm run dev          # esbuild --watch
npm test             # 200 unit tests: format, styles, masks, CSV, embeds, i18n,
                     # sort/filter/markdown, wiki links, the xlsx round trip
npm run e2e          # e2e in a sandboxed Obsidian, screenshots into tests/shots/
```

Build output: `main.js` ~1.07 MB, `styles.css` ~121 KB.

Two thirds of `main.js` is the grid engine and the `.xlsx` library; the plugin's
own code is about 90 KB of it. The xlsx half (~470 KB) arrived in 1.4.0 and is
behind a dynamic `import()`, which does NOT keep it out of the file: an Obsidian
plugin is one `main.js`, esbuild cannot split a CJS bundle into chunks Obsidian
would know how to load, and a second file would not survive a BRAT install. What
the dynamic import buys is that esbuild wraps the module in a lazy initializer,
so none of it is EXECUTED until the first import or export - the cost at startup
is bytes on disk, not milliseconds. Measured, same build, before and after:
623 018 B -> 1 094 019 B.

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

The e2e suite (445 assertions) launches a separate Obsidian instance with its
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
screen, emulates the tablet (800x1340, `mobile: true`, `body.is-mobile`, touch
emulation on) to measure touch targets and then to drive real `TouchEvent`
gestures through it - a pan that must not move the selection, a pan that must
not be undone by a scroll-into-view, a tap that must select, a press too slow to
be a tap, the left-edge swipe rule in all three of its cases, `Enter` in the
formula bar, and a long press that has to open the plugin's own menu with 44 px
rows - right-clicks a cell in English and in Russian to read the context menu
back and insert a row through it, round-trips a semicolon-delimited CSV through
the real view, sorts a styled sheet from the toolbar and reads the file back to prove the
fills landed on the lines of the values they belong to, filters a column and
checks which rows the DOM hides, scrolls a frozen row and measures where it
parked, drives the find strip, F2, Ctrl+D, Home/End and Ctrl+arrows as real
keystrokes, round-trips a Markdown table through the real clipboard, resizes a
column through the dialog and by double-clicking its header edge, ticks a
checkbox cell with a real click and reads the boolean back out of the file,
hovers a `[[link]]` to catch the `hover-link` event and clicks it to see the
note open, merges a range from the toolbar (through the confirm dialog) and
splits it again, exports an `.xlsx` and imports it back through the file menu to
compare the values, the formulas, the bold, the fill and the column widths,
prints the sheet to a real PDF and reads the text back out of it, and finally
pretends a foreign plugin owns `.sheet` to check the notice and the `.lsheet`
fallback. Screenshots land in `tests/shots/`, and the printed PDF next to them
as `22-print.pdf`. Playwright is needed for e2e only: either
`npm i -D playwright` or point `SHEETS_PLAYWRIGHT` at an existing install.

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
  same strings, and since 1.4.0 there is a converter both ways, but a `.sheet`
  file is still not an `.xlsx`: see the list of what the trip drops, above.
- Multi-section masks (`positive;negative;zero`) are stored but only their first
  section is interpreted; there is no calendar picker, a date is a value plus a
  date mask.
- The format supports multiple sheets per file, but there is no UI yet for
  creating a second sheet. Importing a multi-worksheet `.xlsx` does produce one,
  and the engine shows a tab strip for it.
- There are no dropdown cells, and the reason is in "Checkbox cells" above: the
  engine's cell types belong to a column, not to a cell.
- A checkbox cell is always drawn in the middle of its cell, so a horizontal
  alignment on it has no visible effect.
- Printing prints the sheet that is on screen, all of it. There is no page
  setup, no print range, no repeated first COLUMN, and frozen panes are ignored
  on paper.
- The `.xlsx` bridge is a document converter, not a live link: exporting twice
  overwrites `name.xlsx`, and importing always makes a new file rather than
  updating one that came from the same workbook.
- Styles are bound to cell addresses. Inserting a row or column shifts them via
  the engine; sorting sidesteps the problem entirely by rewriting the document
  (see Sorting above), which is why it is the one operation that rebuilds the
  grid instead of asking the engine to reorder it.
- Sorting refuses to run on a sheet with merged cells, does not adjust formula
  references in the rows it moves, and cannot be undone by "Clear sort" - the
  new order is the file's order. `Ctrl+Z` still works while the tab is open.
- Filters hide rows by value only: no ranges, no conditions, no "contains", and
  blank cells are never hidden. Hidden rows are still in the file, and a filtered
  sheet still saves every row it has.
- Frozen panes are a display setting, not a print or export one, and freezing
  more rows than fit on the screen leaves nothing to scroll.
- Pasting a Markdown table clips at the last row and column of the sheet instead
  of growing it.
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
- On touch devices there is no gesture for selecting a RANGE: a drag scrolls, as
  it should, and the range is selected from the toolbar's point of view by what
  the keyboard-less device can do - one cell at a time. Everything else on a
  tablet now behaves: a scroll keeps the selection and the scroll position, a
  tap selects, a long press opens a translated 44 px menu, the gutter stays
  frozen, the bottom row clears the navigation bar, controls are 44 px, and long
  formulas are edited in the formula bar. Obsidian's drawer is reachable by a
  swipe from the left 24 px of the screen while the sheet is scrolled fully left
  (and always from the header button). Verified on an Android tablet at
  800x1340; phones untested.

## Gotchas worth knowing

Obsidian eats F2 and Ctrl+F before the grid ever sees them. Its keymap listens on
`window` in the capture phase, and `F2` is "Rename file" while `Ctrl+F` is
"Search current file". A `keydown` listener on the grid's own wrapper never fired
for either - measured in the sandbox, with the listener provably attached and
plain arrow keys arriving normally. `View.scope` is the sanctioned way round it:
Obsidian pushes the active view's scope and consults it first, so the spreadsheet
keys work inside the grid, stay Obsidian's everywhere else, and die with the view
without a teardown of their own. A handler that returns `false` has handled the
key; anything else lets Obsidian carry on, which is what the guards for the
formula bar, the find box and an open cell editor do.

`position: relative` on a header cell beats `position: sticky` on the same cell.
The filter marker started as an absolutely positioned `::before`, which needs a
positioned parent - and that quietly cancelled the vendor's sticky column
headers. The symptom was very specific: with a filter on column A, scrolling the
grid down made the letter A scroll away while B and C stayed pinned. The dot is a
`radial-gradient` background now, which needs no positioning at all.

A frozen pane cannot be measured while it is being built. Sticky needs pixel
offsets, and the offsets read during the engine's first paint are not the final
ones: a 26 px header row measured 285 px, so the "frozen" row parked below the
fold and looked like sticky was broken. Everything else recovers on the next
engine event; a freeze has no events of its own, so it is re-measured on the next
animation frame and once more on a short timer.

An unfilled cell cannot be `background-color: transparent` if it is ever going to
be frozen. Every styled cell carries its background inline (the engine's
`setStyle` merges, so a removed fill has to be actively reset), and no stylesheet
rule can beat an inline declaration - the rows scrolling underneath showed
straight through every bold-but-unfilled header cell. The inline value is
`var(--leovale-sheet-cell-bg)` instead, and the frozen-pane rules redefine that
variable on the cells they pin.

Sorting through the engine would separate a row from its formatting. `orderBy()`
permutes `options.data` and the `<tr>` elements, but styles live in
`options.style` keyed by A1 address and number masks live in a `data-nf`
attribute; after an engine sort the values have moved and the style map has not,
so the bold red row would lend its formatting to whoever landed on its address -
and that is what would be written to disk. Sorting is therefore a document
operation: read the document out, move whole rows, rebuild the grid.

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
explicitly, a half-second scroll pops the editor open. Since 1.4.x `touchstart`
is stopped as well (see the next paragraph), which disarms that timer for good -
the explicit cancel stays as the belt to its braces, for a touch that starts
outside the grid root.

The engine selects on `touchstart`, and that is the bug. Its document-level
`touchstart` handler calls the selection code with the coordinates of whatever
`<td>` the finger landed on - before anyone can know whether the gesture is a
tap or a scroll. On a tablet a finger lands on a cell every time the user means
to scroll, so the sheet kept losing the active cell (and with it the formula bar's
context) to a gesture nobody meant as a selection. The fix is to take the event
away from the engine: `touchstart` is stopped in the capture phase on the grid
root, and the decision is made on `touchend` from the distance (10 px) and the
duration (300 ms). The compatibility mouse events a browser synthesises for a
tap are NOT prevented, so nothing else about the engine changes; a scroll
suppresses them on its own, which is precisely the case we care about.

A scroll-into-view can undo the user's own scroll. `selectCell()` ends with
`scrollIntoView({ inline: "nearest" })`, which is right for a keyboard move and
fatal a moment after a pan: measured on the tablet, a sheet panned to
`scrollLeft: 484` snapped back to 0 because the selection (column A, off screen
now) was scrolled into view. Every programmatic scroll therefore goes through
one method that refuses to run for 0.7 s after a touch pan, and a tap passes
`scroll: false` outright - the cell it selected is under the finger, so there is
nothing to scroll to.

The engine's context menu can be replaced, not just restyled. `contextMenu` in
the worksheet options is called with the default items and may return them
changed - or `false`, which makes the vendor return BEFORE it opens anything
(it also skips its own `preventDefault()`, so ours has to call it). That is how
the jsuites menu is exchanged for an Obsidian `Menu` with our translations,
44 px rows and no keyboard hints, instead of translating text nodes and
re-measuring rows after every open of a menu the vendor rebuilds from scratch
each time. A read-only embed inside a note passes no menu handler at all and
therefore gets no context menu, which is what read-only should mean.

The drawer needs the whole gesture, `touchstart` included. Obsidian's edge swipe
arms on `touchstart` and completes on `touchmove`, so the edge-swipe compromise
cannot be implemented by letting `touchmove` through alone: for a gesture that
starts in the left 24 px with the sheet scrolled fully left, the grid ignores
the touch completely - no stopping, no deferred selection, nothing. Which is
also why the engine takes a `touchPassThrough` callback rather than the view
simply not calling `stopPropagation()`.

Do not pass a second argument to `getNewFileParent()`. Calling
`getNewFileParent(path, "Untitled.sheet")` makes Obsidian look for a file
creator for that extension and log an error. The first argument is enough.

Obsidian prints by hiding the app. Its own print stylesheet sets
`.app-container { display: none }` and shows a `.print` element that the Markdown
exporter fills in. A spreadsheet is not Markdown and has no such element, so the
first print of a sheet produced a genuinely blank page - 979 bytes of PDF, with
the grid perfectly present in the DOM. The print rules therefore bring the app
container back and flatten every box between it and the grid, because Obsidian's
layout is nested absolutely positioned flex boxes sized to the WINDOW, which is
the one shape a printer cannot page through.

`contain: strict` means "size me as if I were empty". After the boxes were
flattened the page was still blank, and the reason was one property on the
workspace leaf: with `contain: strict` the element sizes itself as if it had no
content at all, so a 1161 px grid lived inside a 0 px page. `contain: none` in
the print block is what let the layout out.

Flattening the workspace un-hides the other tabs. Obsidian keeps an inactive
leaf at `display: none`, and a rule that sets every leaf to `display: block`
brings all of them back - the first real PDF had a Markdown note printed above
the grid. Inactive leaves are hidden again explicitly, and the whole print block
is fenced behind `body:has(.workspace-leaf.mod-active .leovale-sheet-content)`,
so that printing a NOTE while a sheet happens to be open elsewhere is untouched.

SheetJS's community edition ignores `cell.s` when it writes. The reader and the
writer are asymmetric in a way the documentation does not put in one place, and
both halves cost a workaround. A workbook written by `xlsx@0.18.5` with a bold,
filled, bordered cell comes back with none of the three - the writer never looks
at the style - which is why the bundled package is `xlsx-js-style`, the same
version and the same licence with style writing added. And its READER (SheetJS's
own) resolves the number format and the fill onto the cell, then throws away the
pointer to the font and the border: `styles.Borders` is an array of empty
objects, one per border, in the right order and with nothing in them. The style
index of a cell and the border sides are therefore read out of the raw
`xl/styles.xml` and `xl/worksheets/sheetN.xml`, which `bookFiles: true` hands
over already unzipped. Everything SheetJS does parse - fonts, fills, alignment -
comes from `wb.Styles` rather than being parsed twice.

A drawn checkbox does not print. Chromium's print painter ignores what a styled
`appearance: none` checkbox looks like: the accent fill and the `::after` tick
both went missing and every box printed as an empty square, ticked or not, which
is the one thing a checkbox column must never do. On paper the box is a
character instead (`☐` / `☑`), which also puts it in the PDF's text layer - and
the text-presentation selector `U+FE0E` is part of it, because without it the
ticked box comes out of the emoji font as a blue picture that is not text at
all: it was missing from the PDF's text layer while the empty box was in it.

An `<input type="checkbox">` in the grid is invisible unless you draw it
yourself. Obsidian sets `appearance: none` on every checkbox in the app and
paints its own with a rule that the vendor's scoped stylesheet then overrides
(`background: #fff; border: none`), so the box had no edges and no tick: an
empty column in both themes, with the element provably there and `checked` true.
The box is drawn here instead, in Obsidian's variables, with its tick as a
rotated `::after` sized in percentages so it survives the 20 px touch size.

Electron has no `Page.printToPDF`. The CDP method is a browser-process handler
that Chromium wires up for headless printing and Electron's embedder never
registers, so the documented way to check a print stylesheet answers
"'Page.printToPDF' wasn't found". The e2e asks for it first anyway and falls back
to `webContents.printToPDF()` through `@electron/remote`, which is the same
printing pipeline that Ctrl+P uses.

Chromium prints text as glyph ids. The PDF the e2e reads back has no readable
strings in it: the fonts are subsets with Identity-H encoding, so a content
stream holds `<0024> Tj`, not letters. The suite decodes them through the fonts'
own `/ToUnicode` CMaps, which are in the file. Finding those needs one more
piece of care: an embedded font is binary and the seven bytes `stream\n` turn up
inside one, so a scanner that looks for `stream` alone reads nine of ten streams
from the wrong offset. The dictionary end (`>>\s*stream`) is part of the pattern.

## License

MIT, see [LICENSE](LICENSE).

The grid engine is [Jspreadsheet CE](https://github.com/jspreadsheet/ce) 5.0.4
(MIT), with `jsuites` (MIT) and the `@jspreadsheet/formula` "Formula Basic"
engine (MIT per the vendor's banner in the distributed files).

`.xlsx` is read and written by
[xlsx-js-style](https://github.com/gitbrent/xlsx-js-style) 1.2.0, which is
SheetJS Community Edition 0.18.5 with cell-style writing added. **Apache License
2.0** — verified in the package itself: `"license": "Apache-2.0"` in its
`package.json`, and the Apache 2.0 text in its `LICENSE`, carrying SheetJS's own
copyright line (`Copyright (C) 2012-present SheetJS LLC`). The plain `xlsx`
package is the same licence and would have been the obvious choice; it is not
used because its writer drops cell styles, which is half of what an export is
for.

Full notices are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), and the
bundle carries them in a footer comment in `main.js`, as Apache 2.0 section 4
requires.
