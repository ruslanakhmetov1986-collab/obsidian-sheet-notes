# Third-party notices

The bundled `main.js` and `styles.css` include the following third-party
software. Original license notices are preserved in the bundle
(esbuild `legalComments: "eof"`).

## jspreadsheet-ce 5.0.4

Spreadsheet grid engine. MIT License, Copyright (c) 2024 Jspreadsheet Ltd.
https://github.com/jspreadsheet/ce

## jsuites

UI toolkit used by jspreadsheet-ce. MIT License, Jspreadsheet Ltd / Paul Hodel.
https://github.com/jsuites/jsuites

## @jspreadsheet/formula 2.0.2 (Formula Basic)

Formula engine, required dependency of jspreadsheet-ce. The npm package
declares no `license` field, but the distributed `dist/index.js` carries the
vendor's own banner:

```
/**
 * Jspreadsheet Extensions (https://jspreadsheet.com)
 * Extension: Formula Basic
 * License: This is a free software MIT
 */
```

The vendor's product comparison lists Formula **Basic** as MIT (the paid
"Formula Premium" is a different product and is not used here).

## xlsx-js-style 1.2.0

Reads and writes `.xlsx` (release 1.4.0). Apache License 2.0.
https://github.com/gitbrent/xlsx-js-style

The package is SheetJS Community Edition 0.18.5 with cell-style writing added,
maintained by Brent Ely; the `LICENSE` file it ships is the Apache 2.0 text
with SheetJS's own copyright line, `Copyright (C) 2012-present SheetJS LLC`,
and its `package.json` declares `"license": "Apache-2.0"`. Both were read in
`node_modules`, not taken from the project page.

Why the fork and not `xlsx` itself, which is the same license and the same
version: the community writer ignores `cell.s`. Verified rather than assumed - a
workbook written by `xlsx@0.18.5` with a bold, filled, bordered cell comes back
with none of the three, because `write_ws_xml_cell` never looks at the style.
Exporting formatting is half the feature, so the package that can do it is the
one in the bundle.

The legacy code-page tables (`cpexcel.js`, 472 KB of single-byte encodings for
`.xls`, `.dbf` and friends) are excluded at build time: only `.xlsx` is read or
written here, and that is UTF-8 XML inside a zip. See `stubCodepagePlugin` in
`esbuild.config.mjs`.

A copy of the Apache 2.0 licence text ships in
`node_modules/xlsx-js-style/LICENSE`; the notice above is reproduced in the
footer of the built `main.js`, as the licence's section 4 requires.
